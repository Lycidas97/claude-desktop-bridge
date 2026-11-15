import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { win32 } from "node:path";
import type { BridgeInspectorClient } from "@bridge/protocol";
import type { InspectorDesktopProcess } from "./claude-inspector-startup.js";

const run = promisify(execFile);
const WINDOW_INPUT = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class InspectorWindow {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
  public static void Key(byte key, byte scan) { keybd_event(key, scan, 0, UIntPtr.Zero); keybd_event(key, scan, 2, UIntPtr.Zero); }
}
'@
`;

/** Only the action phase activates a window; its caller persists the attempt first. */
export async function windowsInspectorMenu(pid: number, press: boolean): Promise<"waiting" | "ready" | "enabled" | "clicked"> {
  const window: unknown = JSON.parse(await windowsInspectorCommand(`${WINDOW_INPUT}
    @{ target = (Get-Process -Id ${pid}).MainWindowHandle.ToInt64(); previous = [InspectorWindow]::GetForegroundWindow().ToInt64() } | ConvertTo-Json -Compress
  `));
  if (!window || typeof window !== "object" || !("target" in window) || !("previous" in window)
    || typeof window.target !== "number" || typeof window.previous !== "number") throw new Error("Windows 窗口句柄格式无效");
  const { target, previous } = window;
  if (!target) {
    if (press) throw new Error("Claude 窗口不可用，请按 Alt 后手动开启 Developer › Enable Main Process Debugger");
    return "waiting";
  }
  if (!press) return "ready";
  if (!previous) throw new Error("无法记录原前台窗口，未操作 Claude 菜单");
  try {
    const result = await windowsInspectorCommand(`${WINDOW_INPUT}
      Add-Type -AssemblyName UIAutomationClient
      Add-Type -AssemblyName UIAutomationTypes
      Add-Type -AssemblyName WindowsBase
      if ([InspectorWindow]::GetForegroundWindow() -ne [IntPtr]${target}) {
        if (![InspectorWindow]::SetForegroundWindow([IntPtr]${target})) { throw '无法激活 Claude 窗口，请按 Alt 后手动开启主进程调试' }
      }
      if ([InspectorWindow]::GetForegroundWindow() -ne [IntPtr]${target}) { throw 'Claude 未处于前台，未发送菜单按键' }
      $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]${target})
      $headingCondition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, 'Developer')
      $developer = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $headingCondition)
      if (!$developer) {
        [InspectorWindow]::Key(0x12, 0x38)
        Start-Sleep -Milliseconds 150
        $developer = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $headingCondition)
      }
      if (!$developer) { throw '未找到 Developer 菜单，请按 Alt 后手动开启主进程调试' }
      $developer.SetFocus()
      [InspectorWindow]::Key(0x0D, 0x1C)
      Start-Sleep -Milliseconds 150
      $processCondition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, ${pid})
      $itemCondition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, 'Enable Main Process Debugger')
      $roots = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $processCondition)
      $item = $null
      foreach ($candidate in $roots) {
        $item = $candidate.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $itemCondition)
        if ($item) { break }
      }
      if (!$item) { throw '未找到 Enable Main Process Debugger 菜单项，请检查开发者模式与工作区策略' }
      if (!$item.Current.IsEnabled) { throw '主进程调试菜单不可用，请检查账号与工作区开发者策略' }
      $toggle = $item.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
      if ($toggle.Current.ToggleState -eq [System.Windows.Automation.ToggleState]::On) { 'enabled' }
      elseif ($toggle.Current.ToggleState -eq [System.Windows.Automation.ToggleState]::Off) { $toggle.Toggle(); 'clicked' }
      else { throw '无法确认主进程调试菜单勾选状态，未操作' }
    `);
    if (result !== "enabled" && result !== "clicked") throw new Error(`Windows 原生调试菜单返回未知状态：${result}`);
    return result;
  } finally {
    // A killed/timed-out menu worker still returns here; restoration runs separately.
    await windowsInspectorCommand(`${WINDOW_INPUT}
      [uint32]$foregroundPid = 0
      [InspectorWindow]::GetWindowThreadProcessId([InspectorWindow]::GetForegroundWindow(), [ref]$foregroundPid) | Out-Null
      if ($foregroundPid -eq ${pid}) {
        [InspectorWindow]::Key(0x1B, 0x01)
        Start-Sleep -Milliseconds 150
      }
      if ([InspectorWindow]::GetForegroundWindow() -ne [IntPtr]${previous}) {
        if (![InspectorWindow]::SetForegroundWindow([IntPtr]${previous})) { throw '无法恢复原前台窗口，请手动切回' }
      }
    `);
  }
}

/** EncodedCommand avoids cmd.exe/PowerShell quoting differences for local static scripts. */
export async function windowsInspectorCommand(script: string): Promise<string> {
  const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(`$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [Text.Encoding]::UTF8; ${script}`, "utf16le").toString("base64")],
  { timeout: 8_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  return stdout.trim();
}

export async function windowsInspectorProcesses(): Promise<InspectorDesktopProcess[]> {
  const rows: unknown = JSON.parse(await windowsInspectorCommand(`
    ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -Filter "Name = 'claude.exe'" |
      Where-Object { $_.ExecutablePath -and $_.CommandLine -notmatch '(?:^|\\s)--type=' } |
      ForEach-Object { @{ pid = $_.ProcessId; launched = $_.CreationDate.ToUniversalTime().ToString('o'); path = $_.ExecutablePath } })
  `));
  if (!Array.isArray(rows)) throw new Error("Windows Claude 进程列表格式无效");
  return rows.map(row => {
    if (!row || !Number.isInteger(row.pid) || row.pid <= 0 || typeof row.launched !== "string" || typeof row.path !== "string") throw new Error("Windows Claude 进程身份无效");
    return { pid: row.pid, identity: `${row.pid}:${row.launched}:${row.path}` };
  });
}

export function parseWindowsInspectorSockets(output: string, port = 9229): { listening: boolean; pids: number[] } {
  let listening = false;
  const clients = new Set<number>();
  const loopback = [`127.0.0.1:${port}`, `[::1]:${port}`];
  for (const line of output.split("\n")) {
    const [protocol, local, remote, state, pid] = line.trim().split(/\s+/u);
    if (protocol !== "TCP") continue;
    if (state === "LISTENING" && [...loopback, `0.0.0.0:${port}`, `[::]:${port}`].includes(local ?? "")) listening = true;
    if (state === "ESTABLISHED" && loopback.includes(remote ?? "")) clients.add(Number(pid));
  }
  return { listening, pids: [...clients] };
}

export async function readWindowsInspectorConnections(port = 9229): Promise<{ listening: boolean; clients: BridgeInspectorClient[] }> {
  const sockets = parseWindowsInspectorSockets((await run("netstat.exe", ["-ano"], { timeout: 2_500, maxBuffer: 4 * 1024 * 1024, windowsHide: true })).stdout, port);
  if (!sockets.pids.length) return { listening: sockets.listening, clients: [] };
  const rows: unknown = JSON.parse(await windowsInspectorCommand(`
    ConvertTo-Json -Compress -InputObject @(Get-Process -Id ${sockets.pids.join(",")} -ErrorAction SilentlyContinue |
      ForEach-Object { @{ pid = $_.Id; name = $_.ProcessName; path = $_.Path } })
  `));
  if (!Array.isArray(rows)) throw new Error("Windows 调试连接进程列表格式无效");
  const paths = new Map<number, { name: string; path?: string }>(rows.map(row => {
    if (!row || !Number.isInteger(row.pid) || typeof row.name !== "string" || (row.path !== null && typeof row.path !== "string")) throw new Error("Windows 调试连接进程信息无效");
    return [row.pid, { name: row.name, path: row.path ?? undefined }];
  }));
  const approvedRoots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA]
    .filter((root): root is string => Boolean(root)).map(root => win32.join(root, "Google", "Chrome", "Application"));
  return {
    listening: sockets.listening,
    clients: sockets.pids.map(pid => {
      const client = paths.get(pid);
      return { pid, name: client?.name ?? "未知进程",
        ...(client?.path ? { executablePath: client.path } : { pathError: "进程已退出或无权读取可执行文件路径" }),
        approved: Boolean(client?.path && (client.path.toLowerCase() === process.execPath.toLowerCase()
          || approvedRoots.some(root => client.path!.toLowerCase().startsWith(`${root.toLowerCase()}\\`)))),
      };
    }),
  };
}
