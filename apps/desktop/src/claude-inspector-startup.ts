import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { CLAUDE_DESKTOP_APP, desktopAppPathCandidates } from "./desktop-app-definitions.js";

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
  const { stdout } = await run("/usr/bin/osascript", ["-e", `
on run argv
  tell application "System Events"
    if not UI elements enabled then error "请在系统设置中授予 Bridge 辅助功能权限"
    set targetProcess to first application process whose unix id is (item 1 of argv as integer)
    tell targetProcess
      if not (exists menu bar 1) then return "waiting"
      repeat with heading in menu bar items of menu bar 1
        if exists menu 1 of heading then
          if exists menu item "Enable Main Process Debugger" of menu 1 of heading then
            set debugItem to menu item "Enable Main Process Debugger" of menu 1 of heading
            if exists attribute "AXMenuItemMarkChar" of debugItem then
              set mark to value of attribute "AXMenuItemMarkChar" of debugItem
              if mark is not missing value and mark is not "" then return "enabled"
            end if
            if not enabled of debugItem then error "Native 的主进程调试菜单不可用；请检查账号与工作区开发者策略"
            if item 2 of argv is "press" then
              click debugItem
              return "clicked"
            end if
            return "ready"
          end if
        end if
      end repeat
    end tell
    return "waiting"
  end tell
end run`, String(pid), press ? "press" : "probe"], { timeout: 5_000, maxBuffer: 64 * 1024 }).catch((error: Error & { stderr?: string }) => {
    if (error.stderr?.trim()) throw new Error(error.stderr.trim());
    throw error;
  });
  const result = stdout.trim();
  if (result !== "waiting" && result !== "ready" && result !== "enabled" && result !== "clicked") throw new Error(`原生调试菜单返回未知状态：${result}`);
  return result;
}

export class ClaudeInspectorStartup {
  private records: Record<string, string> | undefined;

  constructor(private readonly options: {
    recordPath: string;
    processes?: () => Promise<InspectorDesktopProcess[]>;
    menu?: (pid: number, press: boolean) => Promise<MenuResult>;
  }) {}

  async check(listening: boolean): Promise<string | undefined> {
    const processes = await (this.options.processes ?? (async () =>
      parseInspectorDesktopProcesses((await run("/bin/ps", ["-axo", "pid=,lstart=,comm="], {
        env: { ...process.env, LC_ALL: "en_US.UTF-8" },
      })).stdout)
    ))();
    if (!this.records) {
      try {
        const value: unknown = JSON.parse(await readFile(this.options.recordPath, "utf8"));
        if (!value || typeof value !== "object" || Array.isArray(value) || !Object.values(value).every(item => typeof item === "string")) throw new Error("Inspector 启动记录格式无效");
        this.records = value as Record<string, string>;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        this.records = {};
      }
    }
    // Only current process identities are needed; a PID alone is not a launch identity.
    this.records = Object.fromEntries(processes.filter(process => Object.hasOwn(this.records!, process.identity)).map(process => [process.identity, this.records![process.identity]!]));
    for (const process of processes) {
      if (!Object.hasOwn(this.records, process.identity)) {
        if (listening) {
          this.records[process.identity] = "本进程首次发现时调试端口已开放；关闭后不再自动开启。";
          await writeFile(this.options.recordPath, `${JSON.stringify(this.records)}\n`, "utf8");
          continue;
        }
        try {
          const result = await (this.options.menu ?? claudeInspectorMenu)(process.pid, false);
          if (result === "waiting") return "等待 Claude Desktop 的原生调试菜单就绪；请检查开发者模式与工作区策略。";
          // Persist before the checkbox action so a Bridge restart cannot toggle it twice.
          this.records[process.identity] = "已尝试原生菜单开启；调试端口尚未开放，本进程不再重复操作。";
          await writeFile(this.options.recordPath, `${JSON.stringify(this.records)}\n`, "utf8");
          if (result === "ready") await (this.options.menu ?? claudeInspectorMenu)(process.pid, true);
        } catch (error) {
          this.records[process.identity] = `本进程自动开启失败：${error instanceof Error ? error.message : String(error)}。请检查 Bridge 的辅助功能和自动化权限；本次启动不再重试，可手动使用原生菜单。`;
          await writeFile(this.options.recordPath, `${JSON.stringify(this.records)}\n`, "utf8");
        }
      }
      if (!listening) return this.records[process.identity];
    }
  }
}
