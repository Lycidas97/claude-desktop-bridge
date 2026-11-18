import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runtime: vi.fn(), server: vi.fn(), connect: vi.fn(),
  runtimeClose: vi.fn(async () => {}), serverClose: vi.fn(async () => {}),
  spawn: vi.fn(), logOpen: vi.fn(), logClose: vi.fn(async () => {}),
  developerSettings: vi.fn(), memoryInitialize: vi.fn(), memoryClose: vi.fn(),
  shouldUseDarkColors: true,
  windows: [] as Array<{
    options?: Record<string, unknown> | undefined;
    loadURL: ReturnType<typeof vi.fn>;
    show: ReturnType<typeof vi.fn>;
    setBackgroundColor: ReturnType<typeof vi.fn>;
    webContents: {
      emit(event: string, ...args: unknown[]): boolean;
      executeJavaScript: ReturnType<typeof vi.fn>;
      setWindowOpenHandler: ReturnType<typeof vi.fn>;
    };
  }>,
}));
vi.mock("./app/claude-desktop-developer-settings.js", () => ({ claudeDesktopDeveloperSettings: mocks.developerSettings }));
vi.mock("./app/service-runtime.js", () => ({ createServiceRuntime: mocks.runtime }));
vi.mock("./app/memory-recorder.js", () => ({ MemoryRecorder: class {
  initialize = mocks.memoryInitialize; close = mocks.memoryClose; diagnostics() { return {}; }
} }));
vi.mock("./app/service-connection.js", () => ({ serveDesktopService: mocks.server, connectDesktopService: mocks.connect }));
vi.mock("node:fs", () => ({ mkdirSync: vi.fn() }));
vi.mock("node:fs/promises", () => ({ mkdir: vi.fn(async () => {}), writeFile: vi.fn(), open: mocks.logOpen }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  const app = Object.assign(new EventEmitter(), {
    getPath: () => "/test/bridge", getAppPath: () => "/test/app", getVersion: () => "1.3.3", setPath: vi.fn(), requestSingleInstanceLock: () => true,
    enableSandbox: vi.fn(), whenReady: async () => {}, dock: { hide: vi.fn() }, get isPackaged() { return false; },
    quit: vi.fn(), exit: vi.fn(), getLoginItemSettings: () => ({}),
  });
  class BrowserWindow extends EventEmitter {
    webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler: vi.fn(), executeJavaScript: vi.fn(async () => {}), isDestroyed: () => false });
    loadURL = vi.fn(async () => {});
    loadFile = vi.fn(async () => {});
    show = vi.fn();
    focus = vi.fn();
    hide = vi.fn();
    removeMenu = vi.fn();
    setBackgroundColor = vi.fn();
    isDestroyed() { return false; }
    destroy = vi.fn();
    constructor(readonly options?: Record<string, unknown>) { super(); mocks.windows.push(this); }
  }
  class Tray extends EventEmitter {
    setToolTip = vi.fn();
    setContextMenu = vi.fn();
  }
  return {
    app, BrowserWindow, Tray,
    dialog: { showErrorBox: vi.fn(), showOpenDialog: vi.fn(), showMessageBox: vi.fn(), showSaveDialog: vi.fn() },
    protocol: { registerSchemesAsPrivileged: vi.fn() }, ipcMain: { handle: vi.fn() },
    Menu: { buildFromTemplate: vi.fn(() => ({ getMenuItemById: vi.fn(() => ({ checked: false })) })) },
    nativeImage: { createFromPath: vi.fn(() => ({ resize: vi.fn(), setTemplateImage: vi.fn() })) },
    nativeTheme: { get shouldUseDarkColors() { return mocks.shouldUseDarkColors; }, themeSource: "system" as "system" | "light" | "dark" },
    shell: { openExternal: vi.fn(async () => {}) },
    systemPreferences: { isTrustedAccessibilityClient: vi.fn(() => false) },
  };
});

let originalArgv: string[];
const originalPlatform = process.platform;
let originalSignals: Map<NodeJS.Signals, NodeJS.SignalsListener[]>;
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.runtimeClose.mockReset().mockResolvedValue(undefined);
  mocks.serverClose.mockReset().mockResolvedValue(undefined);
  mocks.windows.length = 0;
  mocks.logOpen.mockResolvedValue({ fd: 123, close: mocks.logClose });
  mocks.runtime.mockResolvedValue({ controller: {}, close: mocks.runtimeClose });
  mocks.server.mockResolvedValue({ close: mocks.serverClose });
  originalArgv = process.argv;
  process.argv = [...originalArgv, "--bridge-service"];
  originalSignals = new Map((["SIGTERM", "SIGINT"] as const).map((signal) => [signal, process.listeners(signal)]));
  const { app } = await import("electron");
  app.removeAllListeners();
  vi.spyOn(process as unknown as { send(message: unknown, callback?: (error: Error | null) => void): boolean }, "send").mockImplementation((_message, callback) => {
    callback?.(null);
    return true;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  process.argv = originalArgv;
  Object.defineProperty(process, "platform", { value: originalPlatform });
  for (const [signal, listeners] of originalSignals) {
    for (const listener of process.listeners(signal)) if (!listeners.includes(listener)) process.removeListener(signal, listener);
  }
});

it("opens only the fixed Accessibility pane through trusted local IPC", async () => {
  process.argv = originalArgv;
  Object.defineProperty(process, "platform", { value: "darwin" });
  const { EventEmitter } = await import("node:events");
  const { ipcMain, shell, systemPreferences } = await import("electron");
  mocks.connect.mockResolvedValueOnce(Object.assign(new EventEmitter(), { call: vi.fn(async () => ({ launchAtLogin: false, sessions: [] })), close: vi.fn() }));
  await import("./main.js");
  await vi.waitFor(() => expect(ipcMain.handle).toHaveBeenCalledWith("bridge:open-accessibility-settings", expect.any(Function)));
  const open = vi.mocked(ipcMain.handle).mock.calls.find(([channel]) => channel === "bridge:open-accessibility-settings")![1];
  const event = { senderFrame: { url: process.env.BRIDGE_DEV_SERVER_URL || "file:///bridge/index.html" } } as Electron.IpcMainInvokeEvent;
  await open(event);
  expect(systemPreferences.isTrustedAccessibilityClient).toHaveBeenCalledExactlyOnceWith(true);
  expect(shell.openExternal).toHaveBeenCalledExactlyOnceWith("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility");
  expect(() => open({ senderFrame: { url: "https://untrusted.invalid" } } as Electron.IpcMainInvokeEvent)).toThrow("Untrusted renderer");
});

it("exposes the native directory picker only through trusted local renderer IPC", async () => {
  process.argv = originalArgv;
  const { EventEmitter } = await import("node:events");
  const { dialog, ipcMain } = await import("electron");
  const controller = Object.assign(new EventEmitter(), {
    call: vi.fn(async () => ({ launchAtLogin: false, sessions: [] })), close: vi.fn(),
  });
  mocks.connect.mockResolvedValueOnce(controller);
  await import("./main.js");
  await vi.waitFor(() => expect(ipcMain.handle).toHaveBeenCalledWith("bridge:choose-directory", expect.any(Function)));
  const choose = vi.mocked(ipcMain.handle).mock.calls.find(([channel]) => channel === "bridge:choose-directory")![1];
  const event = { senderFrame: { url: process.env.BRIDGE_DEV_SERVER_URL || "file:///bridge/index.html" } } as Electron.IpcMainInvokeEvent;
  vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: false, filePaths: ["/chosen"] });
  await expect(choose(event, "/initial")).resolves.toBe("/chosen");
  expect(dialog.showOpenDialog).toHaveBeenCalledWith(expect.anything(), { properties: ["openDirectory"], defaultPath: "/initial" });
  vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: true, filePaths: [] });
  await expect(choose(event)).resolves.toBeUndefined();
  expect(dialog.showOpenDialog).toHaveBeenLastCalledWith(expect.anything(), { properties: ["openDirectory"] });
  expect(() => choose({ senderFrame: { url: "https://untrusted.invalid" } } as Electron.IpcMainInvokeEvent, "/initial")).toThrow("Untrusted renderer");
  await expect(choose(event, 42)).rejects.toThrow("initialPath must be a string");
  expect(dialog.showOpenDialog).toHaveBeenCalledTimes(2);
});

it("checks and enables developer settings through trusted local IPC without calling the background service", async () => {
  process.argv = originalArgv;
  const { EventEmitter } = await import("node:events");
  const { ipcMain } = await import("electron");
  const call = vi.fn(async () => ({ launchAtLogin: false, sessions: [] }));
  mocks.connect.mockResolvedValueOnce(Object.assign(new EventEmitter(), { call, close: vi.fn() }));
  mocks.developerSettings.mockResolvedValue({ supported: true, profiles: [], enabled: true });
  await import("./main.js");
  await vi.waitFor(() => expect(ipcMain.handle).toHaveBeenCalledWith("bridge:enable-claude-developer-settings", expect.any(Function)));
  const check = vi.mocked(ipcMain.handle).mock.calls.find(([channel]) => channel === "bridge:check-claude-developer-settings")![1];
  const enable = vi.mocked(ipcMain.handle).mock.calls.find(([channel]) => channel === "bridge:enable-claude-developer-settings")![1];
  const event = { senderFrame: { url: process.env.BRIDGE_DEV_SERVER_URL || "file:///bridge/index.html" } } as Electron.IpcMainInvokeEvent;
  const serviceCalls = call.mock.calls.length;
  await check(event);
  expect(mocks.developerSettings).toHaveBeenLastCalledWith({ profile: undefined });
  await expect(enable(event, "Claude-3p")).resolves.toMatchObject({ enabled: true });
  expect(mocks.developerSettings).toHaveBeenLastCalledWith({ profile: "Claude-3p", enable: true, requestAccess: expect.any(Function) });
  expect(call).toHaveBeenCalledTimes(serviceCalls);
  for (const handler of [check, enable]) {
    expect(() => handler({ senderFrame: { url: "https://untrusted.invalid" } } as Electron.IpcMainInvokeEvent, "Claude-3p")).toThrow("Untrusted renderer");
  }
  expect(mocks.developerSettings).toHaveBeenCalledTimes(2);
});

it.each(["confirm", "cancel", "wrong directory"])("uses a local directory access dialog for developer settings: %s", async (choice) => {
  process.argv = originalArgv;
  const { EventEmitter } = await import("node:events");
  const { dialog, ipcMain } = await import("electron");
  mocks.connect.mockResolvedValueOnce(Object.assign(new EventEmitter(), { call: vi.fn(async () => ({ launchAtLogin: false, sessions: [] })), close: vi.fn() }));
  const write = vi.fn();
  mocks.developerSettings.mockImplementationOnce(async (options) => {
    await options.requestAccess("/fixture/Claude");
    write();
    return { supported: true, profiles: [], enabled: true };
  });
  vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: choice === "cancel", filePaths: choice === "cancel" ? [] : [choice === "confirm" ? "/fixture/Claude" : "/fixture/other"] });
  await import("./main.js");
  await vi.waitFor(() => expect(ipcMain.handle).toHaveBeenCalledWith("bridge:enable-claude-developer-settings", expect.any(Function)));
  const enable = vi.mocked(ipcMain.handle).mock.calls.find(([channel]) => channel === "bridge:enable-claude-developer-settings")![1];
  const event = { senderFrame: { url: process.env.BRIDGE_DEV_SERVER_URL || "file:///bridge/index.html" } } as Electron.IpcMainInvokeEvent;
  if (choice === "confirm") {
    await expect(enable(event, "Claude")).resolves.toMatchObject({ enabled: true });
    expect(write).toHaveBeenCalledOnce();
  } else {
    await expect(enable(event, "Claude")).rejects.toThrow(choice === "cancel" ? "已取消授权" : "请选择");
    expect(write).not.toHaveBeenCalled();
  }
  expect(dialog.showOpenDialog).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.objectContaining({ defaultPath: "/fixture/Claude", properties: ["openDirectory", "showHiddenFiles"] }));
});

it.each([
  { case: "running native turn", ownership: "DESKTOP_NATIVE_RUNNING", turnState: "running", confirms: true },
  { case: "native turn waiting for permission", ownership: "DESKTOP_NATIVE_RUNNING", turnState: "waiting", confirms: true },
  { case: "idle native session", ownership: "DESKTOP_NATIVE_IDLE", turnState: "idle", confirms: false },
])("confirms before quitting Claude Desktop only with an active native turn: $case", async ({ ownership, turnState, confirms }) => {
  process.argv = originalArgv;
  const { EventEmitter } = await import("node:events");
  const { dialog, ipcMain } = await import("electron");
  const snapshot = { launchAtLogin: false, sessions: [{ sessionId: "native", transport: "claude-desktop-native", ownership, turnState }] };
  const call = vi.fn(async (method: string) => method === "quitDesktopApp" ? { quit: true } : snapshot);
  mocks.connect.mockResolvedValueOnce(Object.assign(new EventEmitter(), { call, close: vi.fn() }));
  vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 1, checkboxChecked: false });
  await import("./main.js");
  await vi.waitFor(() => expect(ipcMain.handle).toHaveBeenCalledWith("bridge:quit-claude-desktop", expect.any(Function)));
  const quit = vi.mocked(ipcMain.handle).mock.calls.find(([channel]) => channel === "bridge:quit-claude-desktop")![1];
  const event = { senderFrame: { url: process.env.BRIDGE_DEV_SERVER_URL || "file:///bridge/index.html" } } as Electron.IpcMainInvokeEvent;
  if (confirms) {
    await expect(quit(event)).resolves.toBe(snapshot);
    expect(dialog.showMessageBox).toHaveBeenCalledOnce();
    expect(vi.mocked(dialog.showMessageBox).mock.calls[0]!.at(-1)).toMatchObject({ message: "Claude Desktop 仍有会话正在运行" });
    expect(JSON.stringify(vi.mocked(dialog.showMessageBox).mock.calls[0])).not.toContain("接管");
    expect(call).not.toHaveBeenCalledWith("quitDesktopApp", "claude-desktop");
  } else {
    await expect(quit(event)).resolves.toEqual({ quit: true });
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
    expect(call).toHaveBeenCalledWith("quitDesktopApp", "claude-desktop");
  }
});

it.each([true, false])("hides the service Dock icon on every macOS reactivation before opening the UI (packaged: %s)", async (packaged) => {
  Object.defineProperty(process, "platform", { value: "darwin" });
  const { app } = await import("electron");
  vi.spyOn(app, "isPackaged", "get").mockReturnValue(packaged);
  const windowProcess = { on: vi.fn(), unref: vi.fn() };
  mocks.spawn.mockReturnValue(windowProcess);
  await import("./main.js");
  await vi.waitFor(() => expect(mocks.server).toHaveBeenCalledOnce());
  expect(app.dock!.hide).toHaveBeenCalledOnce();

  for (let activation = 1; activation <= 2; activation++) {
    app.emit("activate");
    expect(app.dock!.hide).toHaveBeenCalledTimes(activation + 1);
    expect(mocks.spawn).toHaveBeenCalledTimes(activation);
    expect(vi.mocked(app.dock!.hide).mock.invocationCallOrder[activation]).toBeLessThan(mocks.spawn.mock.invocationCallOrder[activation - 1]!);
  }
  expect(mocks.spawn).toHaveBeenLastCalledWith(process.execPath, packaged ? [] : ["/test/app"], expect.objectContaining({ detached: true, stdio: "ignore" }));
  expect(windowProcess.unref).toHaveBeenCalledTimes(2);
});

it("closes the runtime if starting the local listener fails", async () => {
  const { app } = await import("electron");
  mocks.server.mockRejectedValueOnce(new Error("connection address is unwritable"));
  await import("./main.js");
  await vi.waitFor(() => expect(app.exit).toHaveBeenCalledWith(1));
  expect(mocks.runtimeClose).toHaveBeenCalledOnce();
  expect(mocks.memoryClose).toHaveBeenCalledOnce();
  expect(mocks.memoryInitialize.mock.invocationCallOrder[0]).toBeLessThan(mocks.runtime.mock.invocationCallOrder[0]!);
  expect(mocks.runtimeClose.mock.invocationCallOrder[0]).toBeLessThan(mocks.memoryClose.mock.invocationCallOrder[0]!);
});

it("releases the registered memory recorder if its initialization throws", async () => {
  const { app } = await import("electron");
  mocks.memoryInitialize.mockImplementationOnce(() => { throw new TypeError("invalid recorder schema"); });
  await import("./main.js");
  await vi.waitFor(() => expect(app.exit).toHaveBeenCalledWith(1));
  expect(mocks.memoryClose).toHaveBeenCalledOnce();
  expect(mocks.runtime).not.toHaveBeenCalled();
});

it("does not open the recorder when another service owns the instance lock", async () => {
  const { app } = await import("electron");
  vi.spyOn(app, "requestSingleInstanceLock").mockReturnValueOnce(false);
  await import("./main.js");
  await vi.waitFor(() => expect(app.quit).toHaveBeenCalledOnce());
  expect(mocks.memoryInitialize).not.toHaveBeenCalled();
  expect(mocks.runtime).not.toHaveBeenCalled();
});

it("defers every quit until pending startup and cleanup finish", async () => {
  const { app } = await import("electron");
  let finishStartup!: (runtime: unknown) => void;
  mocks.runtime.mockImplementationOnce(() => new Promise((resolve) => { finishStartup = resolve; }));
  let finishCleanup!: () => void;
  mocks.runtimeClose.mockImplementationOnce(() => new Promise<void>((resolve) => { finishCleanup = resolve; }));
  await import("./main.js");
  await vi.waitFor(() => expect(mocks.runtime).toHaveBeenCalledOnce());
  const first = { preventDefault: vi.fn() };
  const second = { preventDefault: vi.fn() };
  app.emit("before-quit", first);
  finishStartup({ controller: {}, close: mocks.runtimeClose });
  await vi.waitFor(() => expect(mocks.runtimeClose).toHaveBeenCalledOnce());
  app.emit("before-quit", second);
  try {
    expect(first.preventDefault).toHaveBeenCalledOnce();
    expect(second.preventDefault).toHaveBeenCalledOnce();
    expect(app.quit).not.toHaveBeenCalled();
    expect(mocks.server).not.toHaveBeenCalled();
  } finally { finishCleanup?.(); }
  await vi.waitFor(() => expect(app.quit).toHaveBeenCalledOnce());
});

it("continues runtime cleanup when closing the listener fails", async () => {
  const { app } = await import("electron");
  mocks.serverClose.mockRejectedValueOnce(new Error("listener close failed"));
  await import("./main.js");
  await vi.waitFor(() => expect(mocks.server).toHaveBeenCalledOnce());
  app.emit("before-quit", { preventDefault: vi.fn() });
  await vi.waitFor(() => expect(app.exit).toHaveBeenCalledWith(1));
  expect(mocks.runtimeClose).toHaveBeenCalledOnce();
});

it("reports child stages and startup failures, then releases its IPC and log handle", async () => {
  process.argv = originalArgv;
  const { EventEmitter } = await import("node:events");
  const { dialog } = await import("electron");
  const child = Object.assign(new EventEmitter(), { connected: true, unref: vi.fn(), disconnect: vi.fn() });
  mocks.spawn.mockImplementationOnce(() => {
    queueMicrotask(() => child.emit("spawn"));
    return child;
  });
  mocks.connect.mockImplementationOnce(async (_path, launch, options) => {
    await launch();
    child.emit("message", { kind: "bridge-startup", stage: "打开会话数据库" });
    expect(mocks.windows[0]!.webContents.executeJavaScript).toHaveBeenLastCalledWith(expect.stringContaining("打开会话数据库"));
    child.emit("message", { kind: "bridge-startup", stage: "打开会话数据库", error: "SQLITE_CANTOPEN: database is readonly" });
    throw options.signal.reason;
  });
  await import("./main.js");
  await vi.waitFor(() => expect(dialog.showErrorBox).toHaveBeenCalled());
  expect(vi.mocked(dialog.showErrorBox).mock.calls[0]?.[1]).toContain("SQLITE_CANTOPEN: database is readonly");
  expect(mocks.logClose).toHaveBeenCalledOnce();
  expect(child.disconnect).toHaveBeenCalledOnce();
  expect(mocks.spawn).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining(["--bridge-service"]), expect.objectContaining({ detached: true, stdio: ["ignore", "ignore", 123, "ipc"] }));
});

it("does not launch a service after the desktop quits while opening its log", async () => {
  process.argv = originalArgv;
  const { app } = await import("electron");
  let opened!: (log: unknown) => void;
  mocks.logOpen.mockImplementationOnce(() => new Promise((resolve) => { opened = resolve; }));
  mocks.connect.mockImplementationOnce(async (_path, launch) => { await launch(); throw new Error("cancelled"); });
  await import("./main.js");
  await vi.waitFor(() => expect(mocks.logOpen).toHaveBeenCalledOnce());
  app.emit("before-quit");
  opened({ fd: 123, close: mocks.logClose });
  await vi.waitFor(() => expect(mocks.logClose).toHaveBeenCalledOnce());
  expect(mocks.spawn.mock.calls.length).toBe(0);
});

it("closes the UI connection if its initial snapshot fails", async () => {
  process.argv = originalArgv;
  const { dialog } = await import("electron");
  const close = vi.fn();
  mocks.connect.mockResolvedValueOnce({ close, call: vi.fn().mockRejectedValue(new Error("snapshot unavailable")) });
  await import("./main.js");
  await vi.waitFor(() => expect(dialog.showErrorBox).toHaveBeenCalled());
  expect(close).toHaveBeenCalledOnce();
});

it("shows startup before connecting and reports connection errors to the UI", async () => {
  process.argv = originalArgv;
  const { dialog } = await import("electron");
  mocks.connect.mockImplementationOnce(async () => {
    expect(mocks.windows.length).toBeGreaterThan(0);
    throw new Error("service authentication failed: 401");
  });
  await import("./main.js");
  await vi.waitFor(() => expect(dialog.showErrorBox).toHaveBeenCalled());
  expect(vi.mocked(dialog.showErrorBox).mock.calls[0]?.[1]).toContain("service authentication failed: 401");
});

it("validates rendererDiagnostics at the IPC boundary, merges service + renderer snapshots, and enforces mode 0600 even when overwriting a 0644 file", async () => {
  process.argv = originalArgv;
  const { EventEmitter } = await import("node:events");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const realFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const { dialog, ipcMain } = await import("electron");
  const call = vi.fn(async (method: string) => {
    if (method === "snapshot") return { launchAtLogin: false, sessions: [] };
    if (method === "diagnostics") {
      return {
        bridgeVersion: "1.3.4",
        stateGauges: { controller: { activeDevices: 1 } },
      };
    }
    throw new Error(`Unexpected method: ${method}`);
  });
  mocks.connect.mockResolvedValueOnce(Object.assign(new EventEmitter(), { call, close: vi.fn() }));
  await import("./main.js");
  await vi.waitFor(() => expect(ipcMain.handle).toHaveBeenCalledWith("bridge:export-diagnostics", expect.any(Function)));
  const exportDiag = vi.mocked(ipcMain.handle).mock.calls.find(([channel]) => channel === "bridge:export-diagnostics")![1];
  const event = { senderFrame: { url: process.env.BRIDGE_DEV_SERVER_URL || "file:///bridge/index.html" } } as Electron.IpcMainInvokeEvent;

  expect(() => exportDiag({ senderFrame: { url: "https://untrusted.invalid" } } as Electron.IpcMainInvokeEvent)).toThrow("Untrusted renderer");
  for (const invalid of ["string", 42, null, ["array"], new Date()]) {
    await expect(exportDiag(event, invalid)).rejects.toThrow("rendererDiagnostics must be a plain object");
  }
  expect(dialog.showSaveDialog).not.toHaveBeenCalled();

  const openCallsBeforeExport = mocks.logOpen.mock.calls.length;
  vi.mocked(dialog.showSaveDialog).mockResolvedValueOnce({ canceled: true, filePath: "" });
  await expect(exportDiag(event, { schemaVersion: 1 })).resolves.toEqual({ saved: false });
  expect(mocks.logOpen).toHaveBeenCalledTimes(openCallsBeforeExport);

  const tempDir = await realFs.mkdtemp(join(tmpdir(), "bridge-export-diag-"));
  const targetPath = join(tempDir, "existing-0644-diag.json");
  await realFs.writeFile(targetPath, '{"stale":true}\n', { encoding: "utf8", mode: 0o644 });
  if (process.platform !== "win32") {
    await realFs.chmod(targetPath, 0o644);
    expect((await realFs.stat(targetPath)).mode & 0o777).toBe(0o644);
  }

  mocks.logOpen.mockImplementationOnce((path: string, flags: string, mode: number) => realFs.open(path, flags, mode));
  vi.mocked(dialog.showSaveDialog).mockResolvedValueOnce({ canceled: false, filePath: targetPath });
  const rendererPayload = {
    schemaVersion: 1,
    rendererMemory: { usedJSHeapSize: 1234, totalJSHeapSize: 5678, jsHeapSizeLimit: 9999 },
    stateGauges: { desktopConversations: { trackedHosts: 1 } },
  };
  await expect(exportDiag(event, rendererPayload)).resolves.toEqual({
    saved: true,
    path: targetPath,
  });
  expect(mocks.logOpen).toHaveBeenLastCalledWith(targetPath, "w", 0o600);
  if (process.platform !== "win32") {
    expect((await realFs.stat(targetPath)).mode & 0o777).toBe(0o600);
  }
  const written = JSON.parse(await realFs.readFile(targetPath, "utf8"));
  expect(written).toEqual({
    bridgeVersion: "1.3.4",
    stateGauges: { controller: { activeDevices: 1 } },
    renderer: rendererPayload,
  });
});

it("keeps the main renderer hidden when the app starts with --hidden", async () => {
  process.argv = [...originalArgv, "--hidden"];
  const { EventEmitter } = await import("node:events");
  mocks.connect.mockResolvedValueOnce(Object.assign(new EventEmitter(), {
    call: vi.fn(async () => ({ launchAtLogin: false, sessions: [] })),
    close: vi.fn(),
  }));
  await import("./main.js");
  await vi.waitFor(() => expect(mocks.windows[1]).toBeDefined());
  expect(mocks.windows[1]!.options).toMatchObject({ show: false, paintWhenInitiallyHidden: false });
});

it("configures macOS hiddenInset titlebar and syncs nativeTheme + backgroundColor with renderer theme-color", async () => {
  process.argv = originalArgv;
  Object.defineProperty(process, "platform", { value: "darwin" });
  const { EventEmitter } = await import("node:events");
  const { nativeTheme } = await import("electron");
  mocks.shouldUseDarkColors = true;
  nativeTheme.themeSource = "system";
  mocks.connect.mockResolvedValueOnce(Object.assign(new EventEmitter(), {
    call: vi.fn(async () => ({ launchAtLogin: false, sessions: [] })),
    close: vi.fn(),
  }));
  await import("./main.js");
  await vi.waitFor(() => expect(mocks.windows.length).toBeGreaterThanOrEqual(2));
  const mainWin = mocks.windows[1]!;
  expect(mainWin.options).toMatchObject({
    backgroundColor: "#191816",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 16 },
  });
  mainWin.webContents.emit("did-change-theme-color", {}, "#faf9f5");
  expect(nativeTheme.themeSource).toBe("light");
  expect(mainWin.setBackgroundColor).toHaveBeenCalledWith("#faf9f5");
  mainWin.webContents.executeJavaScript.mockResolvedValueOnce("#1c1c1e");
  mainWin.webContents.emit("did-finish-load");
  await vi.waitFor(() => expect(nativeTheme.themeSource).toBe("dark"));
  expect(mainWin.setBackgroundColor).toHaveBeenLastCalledWith("#1c1c1e");

  const { shell } = await import("electron");
  const openHandler = mainWin.webContents.setWindowOpenHandler.mock.calls[0]?.[0] as
    | ((details: { url: string }) => { action: string })
    | undefined;
  expect(openHandler).toBeTypeOf("function");
  expect(openHandler!({ url: "https://github.com/Lycidas97/claude-desktop-bridge/releases/tag/v1.3.5" })).toEqual({ action: "deny" });
  expect(openHandler!({ url: "HTTPS://github.com/Lycidas97/claude-desktop-bridge/releases" })).toEqual({ action: "deny" });
  expect(openHandler!({ url: "http://insecure.invalid" })).toEqual({ action: "deny" });
  expect(openHandler!({ url: "file:///etc/passwd" })).toEqual({ action: "deny" });
  expect(shell.openExternal).toHaveBeenCalledTimes(2);
  expect(shell.openExternal).toHaveBeenNthCalledWith(1, "https://github.com/Lycidas97/claude-desktop-bridge/releases/tag/v1.3.5");
  expect(shell.openExternal).toHaveBeenNthCalledWith(2, "HTTPS://github.com/Lycidas97/claude-desktop-bridge/releases");
});
