import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("node:util", async original => ({ ...await original<typeof import("node:util")>(), promisify: () => mocks.run }));
import { parseWindowsInspectorSockets, readWindowsInspectorConnections, windowsInspectorMenu, windowsInspectorProcesses } from "./windows-inspector.js";

beforeEach(() => mocks.run.mockReset());
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const script = (call: number) => Buffer.from(mocks.run.mock.calls[call]![1].at(-1), "base64").toString("utf16le");

it("reads TCP listeners and only established client ends, including IPv6 and duplicate sockets", () => {
  expect(parseWindowsInspectorSockets(`
  TCP 127.0.0.1:9229 0.0.0.0:0 LISTENING 10
  TCP 127.0.0.1:9229 127.0.0.1:50001 ESTABLISHED 10
  TCP 127.0.0.1:50001 127.0.0.1:9229 ESTABLISHED 42
  TCP [::1]:50002 [::1]:9229 ESTABLISHED 42
  TCP 127.0.0.1:50003 127.0.0.1:9229 SYN_SENT 99
  TCP 127.0.0.1:50004 127.0.0.1:19229 ESTABLISHED 77
  `)).toEqual({ listening: true, pids: [42] });
});

it("classifies real Windows executable paths, rejecting lookalike roots and unavailable paths", async () => {
  vi.stubGlobal("process", { ...process, execPath: "D:\\Tools\\Bridge\\Bridge.exe" });
  vi.stubEnv("ProgramFiles", "C:\\Program Files");
  mocks.run.mockResolvedValueOnce({ stdout: [42,43,44,45].map((pid,i) => `TCP 127.0.0.1:${50001+i} 127.0.0.1:9229 ESTABLISHED ${pid}`).join("\n") });
  mocks.run.mockResolvedValueOnce({ stdout: JSON.stringify([
    { pid: 42, name: "Bridge", path: "d:\\tools\\bridge\\Bridge.exe" },
    { pid: 43, name: "chrome", path: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" },
    { pid: 44, name: "Bridge", path: "D:\\Tools\\Bridge.backup\\Bridge.exe" },
    { pid: 45, name: "unknown", path: null },
  ]) });
  const result = await readWindowsInspectorConnections();
  expect(result.clients.map(client => client.approved)).toEqual([true,true,false,false]);
  expect(result.clients[3]?.pathError).toContain("无权");
  expect(mocks.run.mock.calls[0]?.[0]).toBe("netstat.exe");
});

it("uses PID, creation time and MSIX executable path as the persistent process identity", async () => {
  const path = "C:\\Program Files\\WindowsApps\\Claude_5.11492.5.0_x64__publisher\\app\\claude.exe";
  mocks.run.mockResolvedValueOnce({ stdout: JSON.stringify([{ pid: 42, launched: "2026-11-15T00:00:00.000Z", path }]) });
  expect(await windowsInspectorProcesses()).toEqual([{ pid: 42, identity: `42:2026-11-15T00:00:00.000Z:${path}` }]);
  expect(script(0)).toContain("--type=");
});

it("only probes for a window before the action, without activating or consuming a menu action", async () => {
  mocks.run.mockResolvedValueOnce({ stdout: '{"target":0,"previous":99}' });
  expect(await windowsInspectorMenu(42, false)).toBe("waiting");
  expect(mocks.run).toHaveBeenCalledOnce();
  expect(script(0)).not.toContain("::SetForegroundWindow(");
});

it.each(["clicked", "enabled"])("restores the captured HWND after the menu returns %s", async result => {
  mocks.run.mockResolvedValueOnce({ stdout: '{"target":123,"previous":99}' });
  mocks.run.mockResolvedValueOnce({ stdout: result });
  mocks.run.mockResolvedValueOnce({ stdout: "" });
  expect(await windowsInspectorMenu(42, true)).toBe(result);
  expect(mocks.run).toHaveBeenCalledTimes(3);
  expect(script(1)).toContain("Enable Main Process Debugger");
  expect(script(1)).toContain("ToggleState]::On");
  expect(script(2)).toContain("SetForegroundWindow([IntPtr]99)");
});

it("restores the original window once even when the menu subprocess times out", async () => {
  mocks.run.mockResolvedValueOnce({ stdout: '{"target":123,"previous":99}' });
  mocks.run.mockRejectedValueOnce(Object.assign(new Error("menu timeout"), { killed: true }));
  mocks.run.mockResolvedValueOnce({ stdout: "" });
  await expect(windowsInspectorMenu(42, true)).rejects.toThrow("menu timeout");
  expect(mocks.run).toHaveBeenCalledTimes(3);
  expect(script(2)).toContain("SetForegroundWindow([IntPtr]99)");
});
