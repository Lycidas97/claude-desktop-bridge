import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import type { BridgeInspectorStartupStatus } from "@bridge/protocol";
import { claudeDesktopDeveloperSettings } from "../app/claude-desktop-developer-settings.js";
import { CLAUDE_DESKTOP_APP, desktopAppPathCandidates } from "../app/desktop-app-definitions.js";

import { windowsInspectorMenu, windowsInspectorProcesses } from "./windows-inspector.js";

const run = promisify(execFile);
export interface InspectorDesktopProcess {
  pid: number;
  identity: string;
}
type MenuResult = "waiting" | "ready" | "enabled" | "clicked";

export function parseInspectorDesktopProcesses(
  output: string,
  executables = desktopAppPathCandidates(CLAUDE_DESKTOP_APP, undefined, undefined, "darwin")
    .flatMap(bundle => (CLAUDE_DESKTOP_APP.darwinExecutableCandidates ?? ["Claude"])
      .map(name => `${bundle}/Contents/MacOS/${name}`)),
): InspectorDesktopProcess[] {
  return output.split("\n").flatMap(line => {
    const match = /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/u.exec(line);
    return match && executables.includes(match[3]!)
      ? [{
          pid: Number(match[1]),
          identity: `${match[1]}:${match[2]!.replace(/\s+/gu, " ")}:${match[3]}`,
        }]
      : [];
  });
}

export async function ensureClaudeDeveloperSettingsNonInteractive(options: {
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  home?: string;
} = {}): Promise<void> {
  try {
    const discovered = await claudeDesktopDeveloperSettings(options);
    if (!discovered.supported) return;
    for (const candidate of discovered.profiles) {
      if (candidate.accessRequired) continue;
      try {
        await claudeDesktopDeveloperSettings({ ...options, profile: candidate.id, enable: true });
      } catch {
        // Best-effort non-interactive check; TCC or malformed JSON must not block menu inspection.
      }
    }
  } catch {
    // Ignore missing or inaccessible profile directories during non-interactive enablement.
  }
}

/** Only presses the native debugger checkbox; Native still owns its policy checks. */
export async function claudeInspectorMenu(pid: number, press: boolean): Promise<MenuResult> {
  if (process.platform === "win32") return windowsInspectorMenu(pid, press);
  const { stdout } = await run("/usr/bin/osascript", ["-e", `
on run argv
  tell application "System Events"
    if not UI elements enabled then error "请在系统设置中授予 Bridge 辅助功能权限"
    set targetPid to item 1 of argv as integer
    if not (exists menu bar 1 of (first application process whose unix id is targetPid)) then return "waiting"
    repeat with headingIndex from 1 to count of menu bar items of menu bar 1 of (first application process whose unix id is targetPid)
      if exists menu 1 of menu bar item headingIndex of menu bar 1 of (first application process whose unix id is targetPid) then
        if exists menu item "Enable Main Process Debugger" of menu 1 of menu bar item headingIndex of menu bar 1 of (first application process whose unix id is targetPid) then
          set debugItem to a reference to menu item "Enable Main Process Debugger" of menu 1 of menu bar item headingIndex of menu bar 1 of (first application process whose unix id is targetPid)
          -- Cancel the pressed heading; cancelling its submenu can leave tracking active.
          -- Electron refreshes checkbox state after the native menu closes.
          click menu bar item headingIndex of menu bar 1 of (first application process whose unix id is targetPid)
          delay 0.2
          perform action "AXCancel" of menu bar item headingIndex of menu bar 1 of (first application process whose unix id is targetPid)
          delay 0.2
          set marked to false
          if exists attribute "AXMenuItemMarkChar" of debugItem then
            set mark to value of attribute "AXMenuItemMarkChar" of debugItem
            set marked to mark is not missing value and mark is not ""
          end if
          if marked then return "enabled"
          if not enabled of debugItem then error "Native 的主进程调试菜单不可用；请检查账号与工作区开发者策略"
          if item 2 of argv is "press" then
            click debugItem
            return "clicked"
          end if
          return "ready"
        end if
      end if
    end repeat
    return "waiting"
  end tell
end run`, String(pid), press ? "press" : "probe"], { timeout: 5_000, maxBuffer: 64 * 1024 }).catch((error: Error & { stderr?: string }) => {
    if (error.stderr?.includes("(-1743)")) throw new Error("请在系统设置 › 隐私与安全性 › 自动化中允许 Bridge 控制 System Events（系统事件）。");
    if (error.stderr?.trim()) throw new Error(error.stderr.trim());
    throw error;
  });
  const result = stdout.trim();
  if (result !== "waiting" && result !== "ready" && result !== "enabled" && result !== "clicked") throw new Error(`原生调试菜单返回未知状态：${result}`);
  return result;
}

export class ClaudeInspectorStartup {
  private records: Record<string, BridgeInspectorStartupStatus> | undefined;
  private recordsCorrupted = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: {
    recordPath: string;
    processes?: () => Promise<InspectorDesktopProcess[]>;
    menu?: (pid: number, press: boolean) => Promise<MenuResult>;
    accessibility?: () => { trusted: boolean; applicationPath: string };
    ensureDeveloperSettings?: () => Promise<void>;
    sleep?: (ms: number) => Promise<void>;
    explicitMenuAttempts?: number;
    explicitMenuIntervalMs?: number;
    explicitPortAttempts?: number;
    explicitPortIntervalMs?: number;
  }) {}

  private serialized<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private listProcesses(): Promise<InspectorDesktopProcess[]> {
    return (this.options.processes ?? (async () => process.platform === "win32"
      ? windowsInspectorProcesses()
      : parseInspectorDesktopProcesses((await run("/bin/ps", ["-axo", "pid=,lstart=,comm="], {
          env: { ...process.env, LC_ALL: "en_US.UTF-8" },
        })).stdout)
    ))();
  }

  private async ensureRecordsLoaded(allowReadFailure = false): Promise<Record<string, BridgeInspectorStartupStatus>> {
    if (!this.records) {
      let rawText: string | undefined;
      try {
        rawText = await readFile(this.options.recordPath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" || allowReadFailure) {
          this.records = {};
          return this.records;
        }
        throw error;
      }
      try {
        const value: unknown = JSON.parse(rawText);
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new SyntaxError("Inspector 启动记录格式无效");
        this.records = Object.fromEntries(Object.entries(value).flatMap(([identity, item]): Array<[string, BridgeInspectorStartupStatus]> => {
          // Old records still consume the automatic attempt; their time is unknown.
          if (typeof item === "string") return [[identity, { state: "legacy", detail: item }]];
          if (!item || typeof item !== "object" || Array.isArray(item)
            || !["attempted", "enabled", "already-open", "failed", "legacy"].includes(item.state)
            || typeof item.detail !== "string"
            || (item.recordedAt === undefined ? item.state !== "legacy" : typeof item.recordedAt !== "number" || !Number.isFinite(item.recordedAt))) {
            return [];
          }
          return [[identity, item as BridgeInspectorStartupStatus]];
        }));
        this.recordsCorrupted = false;
      } catch {
        // Fail closed for passive check(false) so a corrupted file never re-opens a port the user closed;
        // explicit enablement or an already-open port heals the record cleanly.
        this.records = {};
        this.recordsCorrupted = true;
      }
    }
    return this.records;
  }

  private async persistRecords(): Promise<void> {
    await writeFile(this.options.recordPath, `${JSON.stringify(this.records ?? {})}\n`, "utf8");
  }

  private async persistRecordsBestEffort(): Promise<void> {
    try {
      await this.persistRecords();
    } catch {
      // Keep in-memory state authoritative when userData is temporarily read-only.
    }
  }

  check(listening: boolean): Promise<BridgeInspectorStartupStatus | undefined> {
    return this.serialized(() => this.checkUnlocked(listening));
  }

  private async checkUnlocked(listening: boolean): Promise<BridgeInspectorStartupStatus | undefined> {
    const processes = await this.listProcesses();
    const loaded = await this.ensureRecordsLoaded();
    if (this.recordsCorrupted) {
      if (!listening) {
        return {
          state: "failed",
          recordedAt: Date.now(),
          detail: "调试启动记录损坏，已暂停被动自动开启；可手动点击开启调试端口恢复。",
        };
      }
      this.recordsCorrupted = false;
    }
    // Only current process identities are needed; a PID alone is not a launch identity.
    this.records = Object.fromEntries(processes.filter(process => Object.hasOwn(loaded, process.identity)).map(process => [process.identity, loaded[process.identity]!]));
    for (const process of processes) {
      if (!Object.hasOwn(this.records, process.identity)) {
        const recordedAt = Date.now();
        if (listening) {
          this.records[process.identity] = { state: "already-open", recordedAt, detail: "首次发现时调试端口已开放，未执行自动开启。" };
          await this.persistRecordsBestEffort();
          continue;
        }
        const accessibility = this.options.accessibility?.();
        if (accessibility && !accessibility.trusted) return {
          state: "accessibility-required",
          detail: `请在系统设置 › 隐私与安全性 › 辅助功能中添加并开启 ${accessibility.applicationPath}。授权后 Bridge 会自动继续。`,
        };
        try {
          const result = await (this.options.menu ?? claudeInspectorMenu)(process.pid, false);
          if (result === "waiting") return { state: "waiting", detail: "等待 Claude Desktop 的原生调试菜单就绪；请检查开发者模式与工作区策略。" };
          // Persist before the checkbox action so a Bridge restart cannot toggle it twice.
          this.records[process.identity] = { state: result === "enabled" ? "enabled" : "attempted", recordedAt,
            detail: result === "enabled" ? "原生调试菜单已勾选，未重复操作。" : "已通过原生菜单请求开启主进程调试。" };
          await this.persistRecords();
          if (result === "ready" && await (this.options.menu ?? claudeInspectorMenu)(process.pid, true) === "enabled") {
            this.records[process.identity] = { state: "enabled", recordedAt, detail: "原生调试菜单已勾选，未重复操作。" };
            await this.persistRecordsBestEffort();
          }
        } catch (error) {
          this.records[process.identity] = { state: "failed", recordedAt, detail: `自动开启失败：${error instanceof Error ? error.message : String(error)}` };
          await this.persistRecordsBestEffort();
        }
      }
      if (!listening) return this.records[process.identity];
    }
    return processes.length ? this.records[processes[0]!.identity] : undefined;
  }

  enableExplicit(isListening: () => Promise<boolean>): Promise<BridgeInspectorStartupStatus> {
    return this.serialized(() => this.enableExplicitUnlocked(isListening));
  }

  private async enableExplicitUnlocked(isListening: () => Promise<boolean>): Promise<BridgeInspectorStartupStatus> {
    if (process.env.BRIDGE_CLAUDE_INSPECTOR_URL) {
      return { state: "already-open", recordedAt: Date.now(), detail: "已配置自定义调试地址，未操作原生菜单。" };
    }
    await this.ensureRecordsLoaded(true);
    this.recordsCorrupted = false;
    if (await isListening()) {
      const processes = await this.listProcesses().catch(() => []);
      if (processes.length > 0) {
        this.records = Object.fromEntries(
          processes.filter(proc => Object.hasOwn(this.records!, proc.identity)).map(proc => [proc.identity, this.records![proc.identity]!]),
        );
        const first = processes[0]!;
        if (!Object.hasOwn(this.records, first.identity)) {
          this.records[first.identity] = { state: "already-open", recordedAt: Date.now(), detail: "调试端口已开放。" };
          await this.persistRecordsBestEffort();
        }
        return this.records[first.identity]!;
      }
      return { state: "already-open", recordedAt: Date.now(), detail: "调试端口已开放。" };
    }

    const ensureDevSettings = this.options.ensureDeveloperSettings
      ?? (!this.options.processes && !this.options.menu ? () => ensureClaudeDeveloperSettingsNonInteractive() : undefined);
    await ensureDevSettings?.();

    const accessibility = this.options.accessibility?.();
    if (accessibility && !accessibility.trusted) {
      const processes = await this.listProcesses().catch(() => []);
      if (processes.some(proc => Object.hasOwn(this.records!, proc.identity))) {
        for (const proc of processes) delete this.records![proc.identity];
        await this.persistRecordsBestEffort();
      }
      return {
        state: "accessibility-required",
        detail: `请在系统设置 › 隐私与安全性 › 辅助功能中添加并开启 ${accessibility.applicationPath}。授权后 Bridge 会自动继续。`,
      };
    }

    const sleep = this.options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
    const maxAttempts = Math.max(1, this.options.explicitMenuAttempts ?? 23);
    const menuIntervalMs = this.options.explicitMenuIntervalMs ?? 350;
    const portAttempts = Math.max(1, this.options.explicitPortAttempts ?? 20);
    const portIntervalMs = this.options.explicitPortIntervalMs ?? 250;
    const menu = this.options.menu ?? claudeInspectorMenu;
    let sawProcess = false;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (attempt > 0 && await isListening()) {
        return { state: "enabled", recordedAt: Date.now(), detail: "主进程调试端口已开启。" };
      }
      const processes = await this.listProcesses();
      if (processes.length > 0) {
        sawProcess = true;
        this.records = Object.fromEntries(
          processes.filter(proc => Object.hasOwn(this.records!, proc.identity)).map(proc => [proc.identity, this.records![proc.identity]!]),
        );
      }
      for (const proc of processes) {
        let probe: MenuResult;
        try {
          probe = await menu(proc.pid, false);
        } catch (error) {
          const failure: BridgeInspectorStartupStatus = {
            state: "failed",
            recordedAt: Date.now(),
            detail: `自动开启失败：${error instanceof Error ? error.message : String(error)}`,
          };
          this.records![proc.identity] = failure;
          await this.persistRecordsBestEffort();
          return failure;
        }
        if (probe === "waiting") continue;

        const recordedAt = Date.now();
        let status: BridgeInspectorStartupStatus = {
          state: probe === "enabled" ? "enabled" : "attempted",
          recordedAt,
          detail: probe === "enabled" ? "原生调试菜单已勾选，未重复操作。" : "已通过原生菜单请求开启主进程调试。",
        };
        this.records![proc.identity] = status;
        await this.persistRecordsBestEffort();

        if (probe === "ready") {
          try {
            if (await menu(proc.pid, true) === "enabled") {
              status = { state: "enabled", recordedAt, detail: "原生调试菜单已勾选，未重复操作。" };
              this.records![proc.identity] = status;
              await this.persistRecordsBestEffort();
            }
          } catch (error) {
            const failure: BridgeInspectorStartupStatus = {
              state: "failed",
              recordedAt: Date.now(),
              detail: `自动开启失败：${error instanceof Error ? error.message : String(error)}`,
            };
            this.records![proc.identity] = failure;
            await this.persistRecordsBestEffort();
            return failure;
          }
        }

        for (let checkAttempt = 0; checkAttempt < portAttempts; checkAttempt += 1) {
          if (await isListening()) return status;
          await sleep(portIntervalMs);
        }
        if (await isListening()) return status;

        const portFailure: BridgeInspectorStartupStatus = {
          state: "failed",
          recordedAt: Date.now(),
          detail: "已请求开启原生调试菜单，但 9229 调试端口未开放；请在电脑端确认 Claude Desktop 窗口状态。",
        };
        this.records![proc.identity] = portFailure;
        await this.persistRecordsBestEffort();
        return portFailure;
      }
      if (attempt + 1 < maxAttempts) await sleep(menuIntervalMs);
    }

    return {
      state: "waiting",
      detail: sawProcess
        ? "等待 Claude Desktop 的原生调试菜单就绪；请检查开发者模式与工作区策略。"
        : "未检测到运行中的 Claude Desktop 主进程；请确认应用已正常打开。",
    };
  }
}
