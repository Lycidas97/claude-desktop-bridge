import { spawn } from "node:child_process";
import { mkdir, open, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { BridgeDesktopRuntimeId, BridgeEvent, DesktopControlSnapshot, LocalBridgeRequest } from "@bridge/protocol";
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, protocol, shell, Tray } from "electron";
import { connectDesktopService, serveDesktopService } from "./app/service-connection.js";
import { createServiceRuntime } from "./app/service-runtime.js";
import { ServiceResources } from "./app/service-resources.js";
import { claudeDesktopDeveloperSettings } from "./app/claude-desktop-developer-settings.js";

protocol.registerSchemesAsPrivileged([{
  scheme: "bridge-artifact",
  privileges: { standard: true, secure: true },
}]);

const serviceMode = process.argv.includes("--bridge-service");
const userDataPath = process.env.BRIDGE_SERVICE_DATA_PATH ?? app.getPath("userData");
const serviceDirectory = join(userDataPath, "background-service");
const addressPath = join(serviceDirectory, "connection.json");
let startupStage = "准备启动 Bridge";
let startupWindow: BrowserWindow | undefined;

function reportStartup(stage: string): void {
  startupStage = stage;
  if (serviceMode && process.connected) {
    process.send?.({ kind: "bridge-startup", stage }, (error: Error | null) => {
      if (error) process.stderr.write(`Bridge startup reporting failed: ${String(error)}\n`);
    });
  }
  if (startupWindow && !startupWindow.isDestroyed()) {
    void startupWindow.webContents.executeJavaScript(`document.getElementById('stage').textContent = ${JSON.stringify(stage)}`).catch((error: unknown) => {
      process.stderr.write(`Bridge startup display failed: ${String(error)}\n`);
    });
  }
}

async function serviceMain(): Promise<void> {
  // Separate Chromium profile/instance lock; business files retain their original paths.
  // Keep app.name unchanged so safeStorage retains the application's keychain identity.
  mkdirSync(join(serviceDirectory, "profile"), { recursive: true, mode: 0o700 });
  app.setPath("userData", join(serviceDirectory, "profile"));
  app.setPath("sessionData", join(serviceDirectory, "profile"));
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  const resources = new ServiceResources();
  let stopping = false;
  let stopped = false;
  let shutdown: Promise<void> | undefined;
  let startup: Promise<void>;
  app.on("before-quit", (event) => {
    if (stopped) return;
    event.preventDefault();
    stopping = true;
    shutdown ??= (async () => {
      await startup;
      await resources.close();
      stopped = true;
      app.quit();
    })().catch((error: unknown) => {
      process.stderr.write(`Bridge service shutdown failed: ${String(error)}\n`);
      app.exit(1);
    });
  });
  process.once("SIGTERM", () => app.quit());
  process.once("SIGINT", () => app.quit());
  app.on("window-all-closed", () => { /* Hidden previews must not end the service. */ });
  app.enableSandbox();
  startup = (async () => {
    try {
      reportStartup("等待后台应用就绪");
      await app.whenReady();
      app.dock?.hide();
      if (process.platform === "darwin") app.on("activate", () => {
        const environment = { ...process.env };
        delete environment.ELECTRON_RUN_AS_NODE;
        const windowProcess = spawn(process.execPath, [
          ...(!app.isPackaged ? [app.getAppPath()] : []),
        ], { detached: true, stdio: "ignore", env: environment });
        windowProcess.on("error", (error) => process.stderr.write(`Bridge window launch failed: ${error.message}\n`));
        windowProcess.unref();
      });
      if (stopping) return;
      const runtime = await createServiceRuntime({ userDataPath, onStage: reportStartup });
      resources.defer("Service runtime", () => runtime.close());
      if (stopping) return;
      reportStartup("发布本机服务地址");
      const server = await serveDesktopService({ addressPath, controller: runtime.controller, shutdown: () => app.quit() });
      resources.defer("Service listener", () => server.close());
      reportStartup("后台服务已就绪");
    } catch (error) {
      return resources.fail(error);
    }
  })();
  await startup;
}

async function desktopMain(): Promise<void> {
  app.enableSandbox();
  const isolatedPackagedQa = process.argv.includes("--bridge-packaged-qa");
  if (!isolatedPackagedQa && !app.requestSingleInstanceLock()) { app.quit(); return; }
  await app.whenReady();
  const startupAbort = new AbortController();
  let quitting = false;
  let startupClient: Awaited<ReturnType<typeof connectDesktopService>> | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  app.on("before-quit", () => {
    quitting = true;
    startupAbort.abort(new Error("Bridge 窗口已退出"));
    startupClient?.close();
    if (child?.connected) child.disconnect();
  });
  process.once("SIGTERM", () => app.quit());
  process.once("SIGINT", () => app.quit());
  startupWindow = new BrowserWindow({
    width: 520, height: 240, title: "Bridge · 启动中", resizable: false,
    show: !process.argv.includes("--hidden") && !(process.platform === "darwin" && app.getLoginItemSettings().wasOpenedAtLogin),
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
  });
  startupWindow.removeMenu();
  startupWindow.on("close", () => { if (!quitting) app.quit(); });
  await startupWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent('<!doctype html><html lang="zh"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><title>Bridge 启动</title><style>body{font:15px system-ui;padding:28px;color:#20242a;background:#f5f6f7}h1{font-size:22px}p{white-space:pre-wrap;overflow-wrap:anywhere}</style><h1>正在启动 Bridge</h1><p id="stage">准备连接后台服务</p></html>')}`);
  try {
    reportStartup("准备本机服务目录");
    await mkdir(serviceDirectory, { recursive: true, mode: 0o700 });
    const controller = startupClient = await connectDesktopService(addressPath, async () => {
      const environment: NodeJS.ProcessEnv = { ...process.env, BRIDGE_SERVICE_DATA_PATH: userDataPath };
      delete environment.ELECTRON_RUN_AS_NODE;
      const log = await open(join(serviceDirectory, "service.log"), "a", 0o600);
      try {
        startupAbort.signal.throwIfAborted();
        child = spawn(process.execPath, [
          ...(!app.isPackaged ? [app.getAppPath()] : []),
          "--bridge-service",
        ], { detached: true, stdio: ["ignore", "ignore", log.fd, "ipc"], env: environment });
        child.on("message", (message: unknown) => {
          if (!message || typeof message !== "object") return;
          const status = message as { kind?: unknown; stage?: unknown; error?: unknown };
          if (status.kind !== "bridge-startup" || typeof status.stage !== "string") return;
          reportStartup(status.stage);
          if (typeof status.error === "string") startupAbort.abort(new Error(status.error));
        });
        child.once("exit", (code, signal) => {
          if (!startupClient) startupAbort.abort(new Error(`后台服务退出（${signal ?? code}）\n详细日志：${join(serviceDirectory, "service.log")}`));
        });
        await new Promise<void>((resolve, reject) => {
          child!.once("spawn", resolve);
          child!.once("error", reject);
        });
        child.unref();
      } finally { await log.close(); }
    }, { signal: startupAbort.signal, onStage: reportStartup });
    if (quitting) { controller.close(); return; }
    reportStartup("读取后台服务状态");
    const initialSnapshot = await controller.call("snapshot");
    if (quitting) return;
    if (child?.connected) child.disconnect();
    let mainWindow: BrowserWindow | undefined;

    function showWindow(): void {
      mainWindow?.show();
      mainWindow?.focus();
    }

    function validSender(frame: Electron.WebFrameMain | null): boolean {
      if (!frame) return false;
      const url = new URL(frame.url);
      if (process.env.BRIDGE_DEV_SERVER_URL) return url.origin === new URL(process.env.BRIDGE_DEV_SERVER_URL).origin;
      return url.protocol === "file:";
    }
    const handle = <T extends unknown[]>(channel: string, action: (...args: T) => unknown) => {
      ipcMain.handle(channel, (event, ...args: T) => {
        if (!validSender(event.senderFrame)) throw new Error("Untrusted renderer");
        return action(...args);
      });
    };
    function isDesktopRuntimeId(value: string): value is BridgeDesktopRuntimeId {
      return value === "claude-desktop";
    }
    async function quitDesktopAppWithConfirmation(runtimeId: BridgeDesktopRuntimeId) {
      const displayName = "Claude Desktop";
      const snapshot = await controller.call("snapshot");
      const desktopTurnRunning = snapshot.sessions.some((session) => session.turnState === "running" || session.ownership === "DESKTOP_NATIVE_RUNNING");
      if (desktopTurnRunning) {
        const options: Electron.MessageBoxOptions = {
          type: "warning", title: `退出 ${displayName}`, message: `${displayName} 仍有会话正在运行`,
          detail: "现在退出会中断 Claude Desktop 正在执行的内容，包括从手机端发起的任务。",
          buttons: ["仍然退出", "取消"], defaultId: 1, cancelId: 1, noLink: true,
        };
        const result = mainWindow ? await dialog.showMessageBox(mainWindow, options) : await dialog.showMessageBox(options);
        if (result.response !== 0) return snapshot;
      }
      return controller.call("quitDesktopApp", runtimeId);
    }

    handle("bridge:get-snapshot", () => controller.call("snapshot"));
    handle("bridge:check-claude-developer-settings", (profile?: unknown) => claudeDesktopDeveloperSettings({ profile }));
    handle("bridge:enable-claude-developer-settings", (profile: unknown) => claudeDesktopDeveloperSettings({
      profile, enable: true,
      requestAccess: async (directory) => {
        const options: Electron.OpenDialogOptions = {
          title: "允许 Bridge 访问 Claude 配置", message: "请选择此配置目录，Bridge 将保留原配置并开启开发者工具。",
          defaultPath: directory, buttonLabel: "允许访问并开启", properties: ["openDirectory", "showHiddenFiles"],
        };
        const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
        if (result.canceled || !result.filePaths[0]) throw new Error("已取消授权，原配置未修改。可再次点击开启。");
        if (resolve(result.filePaths[0]) !== resolve(directory)) throw new Error(`请选择 ${directory}，原配置未修改。`);
      },
    }));
    handle("bridge:create-pairing", () => controller.call("createPairing"));
    handle("bridge:choose-directory", async (initialPath?: string) => {
      if (initialPath !== undefined && typeof initialPath !== "string") throw new Error("initialPath must be a string");
      const options: Electron.OpenDialogOptions = {
        properties: ["openDirectory"],
        ...(initialPath ? { defaultPath: initialPath } : {}),
      };
      const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
      return result.canceled ? undefined : result.filePaths[0];
    });
    handle("bridge:revoke-device", (deviceId: string) => controller.call("revokeDevice", deviceId));
    handle("bridge:set-launch-at-login", (enabled: boolean) => controller.call("setLaunchAtLogin", Boolean(enabled)));
    handle("bridge:set-relay-url", (url: string) => controller.call("setRelayUrl", url));
    handle("bridge:test-magpie-connection", (input: unknown) => controller.call("testMagpieConnection", input));
    handle("bridge:save-magpie-connection", (input: unknown) => controller.call("saveMagpieConnection", input));
    handle("bridge:set-anthropic-api-key", (value: string) => controller.call("setAnthropicApiKey", value));
    handle("bridge:remove-anthropic-api-key", () => controller.call("removeAnthropicApiKey"));
    handle("bridge:launch-claude-desktop", () => controller.call("launchClaudeDesktop"));
    handle("bridge:quit-claude-desktop", () => quitDesktopAppWithConfirmation("claude-desktop"));
    handle("bridge:launch-desktop-app", (runtimeId: string) => {
      if (!isDesktopRuntimeId(runtimeId)) throw new Error("Unknown Desktop runtime");
      return controller.call("launchDesktopApp", runtimeId);
    });
    handle("bridge:quit-desktop-app", (runtimeId: string) => {
      if (!isDesktopRuntimeId(runtimeId)) throw new Error("Unknown Desktop runtime");
      return quitDesktopAppWithConfirmation(runtimeId);
    });
    handle("bridge:request", (request: LocalBridgeRequest) => controller.call("dispatchLocal", request));
    handle("bridge:export-diagnostics", async () => {
      const result = await dialog.showSaveDialog({
        title: "导出 Bridge 诊断", defaultPath: `bridge-diagnostics-${new Date().toISOString().slice(0, 10)}.json`,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (result.canceled || !result.filePath) return { saved: false };
      await writeFile(result.filePath, `${JSON.stringify(await controller.call("diagnostics"), null, 2)}\n`, "utf8");
      return { saved: true, path: result.filePath };
    });

    mainWindow = new BrowserWindow({
      width: 1180, height: 780, minWidth: 860, minHeight: 620,
      show: !process.argv.includes("--hidden") && !(process.platform === "darwin" && app.getLoginItemSettings().wasOpenedAtLogin),
      backgroundColor: "#f5f6f7", title: "Bridge",
      webPreferences: { preload: join(__dirname, "preload.cjs"), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
    });
    mainWindow.removeMenu();
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith("https://")) void shell.openExternal(url);
      return { action: "deny" };
    });
    mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
    mainWindow.on("close", (event) => { if (!quitting) { event.preventDefault(); mainWindow?.hide(); } });
    reportStartup("加载 Bridge 界面");
    if (process.env.BRIDGE_DEV_SERVER_URL) await mainWindow.loadURL(process.env.BRIDGE_DEV_SERVER_URL);
    else await mainWindow.loadFile(join(__dirname, "renderer", "index.html"));
    startupWindow?.destroy();
    startupWindow = undefined;

    const trayIcon = process.platform === "darwin"
      ? nativeImage.createFromPath(join(__dirname, "assets", "trayTemplate.png"))
      : nativeImage.createFromPath(join(__dirname, "renderer", "icon-192.png")).resize({ width: 18, height: 18 });
    if (process.platform === "darwin") trayIcon.setTemplateImage(true);
    const tray = new Tray(trayIcon);
    tray.setToolTip("Bridge");
    const trayMenu = Menu.buildFromTemplate([
      { label: "打开 Bridge", click: showWindow },
      {
        id: "launch-at-login", label: "开机自动运行", type: "checkbox", checked: initialSnapshot.launchAtLogin,
        click: (item) => {
          void controller.call("setLaunchAtLogin", item.checked).catch((error: unknown) => {
            item.checked = !item.checked;
            dialog.showErrorBox("开机自动运行设置失败", error instanceof Error ? error.message : String(error));
          });
        },
      },
      { type: "separator" },
      { label: "退出窗口（任务继续）", click: () => { quitting = true; app.quit(); } },
      { label: "停止后台服务并退出…", click: () => {
        void (async () => {
          const snapshot = await controller.call("snapshot");
          const result = await dialog.showMessageBox({
            type: "warning", title: "停止 Bridge 后台服务", message: "停止后台服务并退出？",
            detail: `当前有 ${snapshot.runtime.activeTurns} 个主任务，${snapshot.permissions.length} 项待处理授权。停止服务会断开手机并中断 Bridge 托管的任务及后台子代理。`,
            buttons: ["停止并退出", "取消"], defaultId: 1, cancelId: 1, noLink: true,
          });
          if (result.response !== 0) return;
          await controller.shutdown();
          quitting = true;
          app.quit();
        })().catch((error: unknown) => dialog.showErrorBox("停止后台服务失败", error instanceof Error ? error.message : String(error)));
      } },
    ]);
    tray.setContextMenu(trayMenu);
    tray.on("click", showWindow);
    controller.on("snapshot", (snapshot: DesktopControlSnapshot) => {
      trayMenu.getMenuItemById("launch-at-login")!.checked = snapshot.launchAtLogin;
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send("bridge:snapshot", snapshot);
    });
    controller.on("event", (event: BridgeEvent) => {
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send("bridge:event", event);
    });
    controller.on("disconnected", () => tray.setToolTip("Bridge · 正在重新连接后台服务"));
    controller.on("snapshot", () => tray.setToolTip("Bridge"));
    const refresh = () => { showWindow(); void controller.call("refreshRuntime").catch((error: unknown) => process.stderr.write(`${String(error)}\n`)); };
    app.on("second-instance", refresh);
    app.on("activate", refresh);
    app.on("window-all-closed", () => { if (process.platform !== "darwin") mainWindow?.hide(); });
  } catch (error) {
    startupClient?.close();
    if (child?.connected) child.disconnect();
    if (quitting) return;
    throw error;
  }
}

(serviceMode ? serviceMain() : desktopMain()).catch((error: unknown) => {
  const detail = `${startupStage}\n${error instanceof Error ? error.stack ?? error.message : String(error)}`;
  process.stderr.write(`Bridge failed: ${detail}\n`);
  if (serviceMode && process.connected) {
    process.send?.({ kind: "bridge-startup", stage: startupStage, error: detail }, () => app.exit(1));
    return;
  }
  if (!serviceMode) dialog.showErrorBox("Bridge 启动失败", detail);
  app.exit(1);
});
