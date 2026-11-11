import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runtime: vi.fn(), server: vi.fn(), connect: vi.fn(),
  runtimeClose: vi.fn(async () => {}), serverClose: vi.fn(async () => {}),
  spawn: vi.fn(), logOpen: vi.fn(), logClose: vi.fn(async () => {}),
  developerSettings: vi.fn(),
  windows: [] as Array<{ loadURL: ReturnType<typeof vi.fn>; show: ReturnType<typeof vi.fn>; webContents: { executeJavaScript: ReturnType<typeof vi.fn> } }>,
}));
vi.mock("./app/claude-desktop-developer-settings.js", () => ({ claudeDesktopDeveloperSettings: mocks.developerSettings }));
vi.mock("./app/service-runtime.js", () => ({ createServiceRuntime: mocks.runtime }));
vi.mock("./app/service-connection.js", () => ({ serveDesktopService: mocks.server, connectDesktopService: mocks.connect }));
vi.mock("node:fs", () => ({ mkdirSync: vi.fn() }));
vi.mock("node:fs/promises", () => ({ mkdir: vi.fn(async () => {}), writeFile: vi.fn(), open: mocks.logOpen }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  const app = Object.assign(new EventEmitter(), {
    getPath: () => "/test/bridge", getAppPath: () => "/test/app", setPath: vi.fn(), requestSingleInstanceLock: () => true,
    enableSandbox: vi.fn(), whenReady: async () => {}, dock: { hide: vi.fn() },
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
    isDestroyed() { return false; }
    destroy = vi.fn();
    constructor() { super(); mocks.windows.push(this); }
  }
  class Tray extends EventEmitter {
    setToolTip = vi.fn();
    setContextMenu = vi.fn();
  }
  return {
    app, BrowserWindow, Tray,
    dialog: { showErrorBox: vi.fn(), showOpenDialog: vi.fn() },
    protocol: { registerSchemesAsPrivileged: vi.fn() }, ipcMain: { handle: vi.fn() },
    Menu: { buildFromTemplate: vi.fn(() => ({ getMenuItemById: vi.fn(() => ({ checked: false })) })) },
    nativeImage: { createFromPath: vi.fn(() => ({ resize: vi.fn(), setTemplateImage: vi.fn() })) }, shell: {},
  };
});

let originalArgv: string[];
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
  for (const [signal, listeners] of originalSignals) {
    for (const listener of process.listeners(signal)) if (!listeners.includes(listener)) process.removeListener(signal, listener);
  }
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

it("closes the runtime if starting the local listener fails", async () => {
  const { app } = await import("electron");
  mocks.server.mockRejectedValueOnce(new Error("connection address is unwritable"));
  await import("./main.js");
  await vi.waitFor(() => expect(app.exit).toHaveBeenCalledWith(1));
  expect(mocks.runtimeClose).toHaveBeenCalledOnce();
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
