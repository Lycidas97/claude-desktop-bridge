import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import type { BridgeInspectorStartupStatus } from "@bridge/protocol";
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
    .map(bundle => `${bundle}/Contents/MacOS/Claude`),
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

  constructor(private readonly options: {
    recordPath: string;
    processes?: () => Promise<InspectorDesktopProcess[]>;
    menu?: (pid: number, press: boolean) => Promise<MenuResult>;
    accessibility?: () => { trusted: boolean; applicationPath: string };
  }) {}

  async check(listening: boolean): Promise<BridgeInspectorStartupStatus | undefined> {
    const processes = await (this.options.processes ?? (async () => process.platform === "win32"
      ? windowsInspectorProcesses()
      : parseInspectorDesktopProcesses((await run("/bin/ps", ["-axo", "pid=,lstart=,comm="], {
          env: { ...process.env, LC_ALL: "en_US.UTF-8" },
        })).stdout)
    ))();
    if (!this.records) {
      try {
        const value: unknown = JSON.parse(await readFile(this.options.recordPath, "utf8"));
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Inspector 启动记录格式无效");
        this.records = Object.fromEntries(Object.entries(value).map(([identity, item]) => {
          // Old records still consume the automatic attempt; their time is unknown.
          if (typeof item === "string") return [identity, { state: "legacy", detail: item }];
          if (!item || typeof item !== "object" || Array.isArray(item)
            || !["attempted", "enabled", "already-open", "failed", "legacy"].includes(item.state)
            || typeof item.detail !== "string"
            || (item.recordedAt === undefined ? item.state !== "legacy" : typeof item.recordedAt !== "number" || !Number.isFinite(item.recordedAt))) throw new Error("Inspector 启动记录格式无效");
          return [identity, item as BridgeInspectorStartupStatus];
        }));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        this.records = {};
      }
    }
    // Only current process identities are needed; a PID alone is not a launch identity.
    this.records = Object.fromEntries(processes.filter(process => Object.hasOwn(this.records!, process.identity)).map(process => [process.identity, this.records![process.identity]!]));
    for (const process of processes) {
      if (!Object.hasOwn(this.records, process.identity)) {
        const recordedAt = Date.now();
        if (listening) {
          this.records[process.identity] = { state: "already-open", recordedAt, detail: "首次发现时调试端口已开放，未执行自动开启。" };
          await writeFile(this.options.recordPath, `${JSON.stringify(this.records)}\n`, "utf8");
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
          await writeFile(this.options.recordPath, `${JSON.stringify(this.records)}\n`, "utf8");
          if (result === "ready" && await (this.options.menu ?? claudeInspectorMenu)(process.pid, true) === "enabled") {
            this.records[process.identity] = { state: "enabled", recordedAt, detail: "原生调试菜单已勾选，未重复操作。" };
            await writeFile(this.options.recordPath, `${JSON.stringify(this.records)}\n`, "utf8");
          }
        } catch (error) {
          this.records[process.identity] = { state: "failed", recordedAt, detail: `自动开启失败：${error instanceof Error ? error.message : String(error)}` };
          await writeFile(this.options.recordPath, `${JSON.stringify(this.records)}\n`, "utf8");
        }
      }
      if (!listening) return this.records[process.identity];
    }
    return processes.length ? this.records[processes[0]!.identity] : undefined;
  }
}
