import { EventEmitter } from "node:events";
import { join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import type { BridgeInspectorAlert, BridgeInspectorStatus } from "@bridge/protocol";
import { WorkspaceProvisioner } from "../controller/assistant-workspace.js";

const resources = await vi.hoisted(async () => {
  const { EventEmitter } = await import("node:events");
  const resource = () => ({ initialize: vi.fn(async () => {}), close: vi.fn(async () => {}) });
  return {
    eventLog: resource(), state: resource(),
    evidence: resource(),
    assistantMail: Object.assign(new EventEmitter(), resource(), {
      binding: vi.fn<() => { nativeSessionId: string; managed?: { path: string; token: string } } | undefined>(),
      status: vi.fn<() => { accounts: { enabled: boolean }[] }>(), resume: vi.fn(),
    }),
    powerSaveBlocker: { start: vi.fn(() => 4), stop: vi.fn() }, mailOptions: vi.fn(), controllerOptions: vi.fn(),
    mailTools: { close: vi.fn(async () => {}) }, serveMailTools: vi.fn(),
    broker: resource(), nativeOptions: vi.fn(),
    controller: { ...resource(), attachUpdater: vi.fn(async () => {}), attachInspectorEnabler: vi.fn(), pauseForSleep: vi.fn(), reconnect: vi.fn(async () => {}), updateInspectorStatus: vi.fn() },
    updater: { initialize: vi.fn(async () => {}), close: vi.fn() },
    cleanupRtc: vi.fn(),
    version: "1.3.4",
    repositoryDefaults: vi.fn(),
    diagnosticsEnabled: false,
    diagnostics: { start: vi.fn(), setEnabled: vi.fn(), close: vi.fn() },
    inspector: { start: vi.fn(async () => {}), enableNow: vi.fn(async () => ({ state: "listening", port: 9229, pollIntervalMs: 3_000, clients: [], alerts: [] })), close: vi.fn(), notificationFailed: vi.fn() },
    inspectorOptions: undefined as undefined | { onUpdate(status: BridgeInspectorStatus): void; onAlert(alert: BridgeInspectorAlert): string | undefined; startup?: (listening: boolean) => Promise<BridgeInspectorStatus["startup"]>; enableStartup?: (isListening: () => Promise<boolean>) => Promise<BridgeInspectorStatus["startup"]> },
    notificationSupported: vi.fn(() => true), showNotification: vi.fn(),
    notifications: [] as Array<{ options: { title: string; body: string }; emit(event: string, ...args: unknown[]): boolean }>,
  };
});
vi.mock("electron", () => ({
  app: { getVersion: () => resources.version, isPackaged: false, getAppPath: () => "/test/app" }, safeStorage: {}, shell: {}, powerMonitor: new EventEmitter(),
  powerSaveBlocker: resources.powerSaveBlocker,
  systemPreferences: { isTrustedAccessibilityClient: vi.fn(() => true) },
  Notification: class extends EventEmitter {
    static isSupported() { return resources.notificationSupported(); }
    show = resources.showNotification;
    constructor(public options: { title: string; body: string }) { super(); resources.notifications.push(this); }
  },
}));
vi.mock("../claude/claude-inspector-monitor.js", () => ({ ClaudeInspectorMonitor: class { constructor(options: NonNullable<typeof resources.inspectorOptions>) { resources.inspectorOptions = options; return resources.inspector; } } }));
vi.mock("../transport/config.js", () => ({
  fileSecretProtector: vi.fn(),
  DesktopConfigRepository: class {
    constructor(_path: string, _protector: unknown, defaults: unknown) { resources.repositoryDefaults(defaults); }
    async loadOrCreate() { return { evidenceKey: "test-key", diagnosticsEnabled: resources.diagnosticsEnabled }; }
  },
}));
vi.mock("../claude/connector.js", () => ({ removeLegacyConnector: vi.fn(async () => {}) }));
vi.mock("./platform.js", () => ({
  connectorPaths: () => ({ claudeSettings: "/test/settings.json" }), claudeRuntimePaths: () => ({}),
  defaultDesktopName: () => "Test", firstNonEmpty: (values: unknown[]) => values.find(Boolean),
  networkReachableUrl: (url: string) => url,
}));
vi.mock("../controller/session-event-log.js", () => ({ SessionEventLog: class { constructor() { return resources.eventLog; } } }));
vi.mock("../controller/conversation-state-store.js", () => ({ ConversationStateStore: class { constructor() { return resources.state; } } }));
vi.mock("../evidence/evidence-store.js", () => ({ EvidenceStore: class {} }));
vi.mock("../evidence/evidence-manager.js", () => ({ EvidenceManager: class { constructor() { return resources.evidence; } } }));
vi.mock("../evidence/artifact-preview.js", () => ({ ElectronEvidencePreviewRenderer: class {} }));
vi.mock("../claude/claude-desktop-bridge.js", () => ({ ClaudeDesktopBridge: class { constructor(options: unknown) { resources.nativeOptions(options); return resources.broker; } } }));
vi.mock("../../../../plugins/assistant-mail/desktop.js", () => ({ AssistantMailService: class { constructor(options: unknown) { resources.mailOptions(options); return resources.assistantMail; } } }));
vi.mock("../../../../plugins/assistant-mail/local-channel.js", () => ({ serveAssistantMailTools: resources.serveMailTools }));
vi.mock("../controller/controller.js", () => ({ DesktopController: class { constructor(...args: unknown[]) { resources.controllerOptions(...args); return resources.controller; } } }));
vi.mock("../updater/desktop-updater.js", () => ({ DesktopUpdater: class { constructor() { return resources.updater; } } }));
vi.mock("./diag.js", () => ({ diagnostics: resources.diagnostics }));
vi.mock("./claude-desktop-lifecycle.js", () => ({ ClaudeDesktopLifecycle: class {} }));
vi.mock("../transport/webrtc-runtime.js", () => ({ loadDesktopPeerConnection: vi.fn(), cleanupDesktopPeerConnection: resources.cleanupRtc }));

beforeEach(() => {
  vi.clearAllMocks();
  resources.serveMailTools.mockResolvedValue(resources.mailTools);
  resources.assistantMail.binding.mockReturnValue(undefined);
  resources.assistantMail.status.mockReturnValue({ accounts: [] });
  resources.version = "1.3.4";
  resources.diagnosticsEnabled = false;
  resources.notifications.length = 0;
  resources.inspectorOptions = undefined;
  resources.notificationSupported.mockReturnValue(true);
  for (const name of ["RELAY", "PUBLIC_RELAY", "PAIRING_BASE", "SERVICE_ORIGIN", "ICE_SERVERS"]) {
    vi.stubGlobal(`__BRIDGE_DEFAULT_${name}__`, "");
  }
});

it.each(["eventLog", "state", "evidence", "assistantMail", "controller"] as const)("unwinds acquired resources when %s initialization fails", async (stage) => {
  const failure = new Error(`${stage} unavailable`);
  resources[stage].initialize.mockRejectedValueOnce(failure);
  const { createServiceRuntime } = await import("./service-runtime.js");
  await expect(createServiceRuntime({ userDataPath: "/test/bridge" })).rejects.toThrow(failure.message);
  expect(resources.eventLog.close).toHaveBeenCalledOnce();
  expect(resources.diagnostics.close).toHaveBeenCalledOnce();
  if (stage !== "eventLog") expect(resources.state.close).toHaveBeenCalledOnce();
  if (stage === "evidence" || stage === "assistantMail" || stage === "controller") expect(resources.evidence.close).toHaveBeenCalledOnce();
  if (stage === "assistantMail" || stage === "controller") expect(resources.assistantMail.close).toHaveBeenCalledOnce();
  if (stage === "controller") {
    for (const resource of [resources.controller, resources.broker]) {
      expect(resource.close).toHaveBeenCalledOnce();
    }
    expect(resources.cleanupRtc).toHaveBeenCalledOnce();
  }
});

it.each([
  ["1.3.4", false],
  ["1.3.4-dev.22", true],
  ["1.3.4-dev.22.diag", true],
] as const)("uses the diagnostics default for build %s", async (version, diagnosticsEnabled) => {
  resources.version = version;
  const { createServiceRuntime } = await import("./service-runtime.js");
  const runtime = await createServiceRuntime({ userDataPath: "/test/bridge" });
  try {
    expect(resources.repositoryDefaults).toHaveBeenCalledWith(expect.objectContaining({ diagnosticsEnabled }));
  } finally { await runtime.close(); }
});

it.each([false, true])("restores saved diagnostic preference %s and releases the recorder with the service", async (diagnosticsEnabled) => {
  resources.diagnosticsEnabled = diagnosticsEnabled;
  const { createServiceRuntime } = await import("./service-runtime.js");
  const runtime = await createServiceRuntime({ userDataPath: "/test/bridge" });
  expect(resources.diagnostics.start).toHaveBeenCalledWith(join("/test/bridge", "background-service", "diagnostics", "trace.sqlite"));
  expect(resources.diagnostics.setEnabled).toHaveBeenCalledWith(diagnosticsEnabled);
  expect(resources.diagnostics.setEnabled.mock.invocationCallOrder[0]).toBeLessThan(resources.eventLog.initialize.mock.invocationCallOrder[0]!);
  await runtime.close();
  expect(resources.diagnostics.close).toHaveBeenCalledOnce();
});

it("shares shutdown completion and closes each resource once", async () => {
  const { createServiceRuntime } = await import("./service-runtime.js");
  const runtime = await createServiceRuntime({ userDataPath: "/test/bridge" });
  let finish!: () => void;
  resources.broker.close.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
  const first = runtime.close();
  const second = runtime.close();
  await vi.waitFor(() => expect(resources.broker.close).toHaveBeenCalledOnce());
  try { expect(first).toBe(second); } finally { finish(); await Promise.all([first, second]); }
  expect(resources.controller.close).toHaveBeenCalledOnce();
  expect(resources.controller.attachUpdater).toHaveBeenCalledOnce();
  expect(resources.updater.close).toHaveBeenCalledOnce();
  expect(resources.inspector.start).toHaveBeenCalledOnce();
  expect(resources.inspector.close).toHaveBeenCalledOnce();
});

it("removes power subscriptions and finishes cleanup after a close failure", async () => {
  const { createServiceRuntime } = await import("./service-runtime.js");
  const { powerMonitor } = await import("electron");
  const onStage = vi.fn();
  const runtime = await createServiceRuntime({ userDataPath: "/test/bridge", onStage });
  expect(onStage.mock.calls.map(([stage]) => stage)).toEqual([
    "读取本机配置与配对信息", "打开事件日志", "打开会话数据库",
    "打开成果数据库", "打开邮件数据库", "初始化运行时与中继连接",
  ]);
  resources.controller.close.mockRejectedValueOnce(new Error("relay close failed"));
  const closed = runtime.close();
  await expect(closed).rejects.toThrow("Desktop controller: Error: relay close failed");
  expect(runtime.close()).toBe(closed);
  expect(resources.broker.close).toHaveBeenCalledOnce();
  expect(resources.state.close).toHaveBeenCalledOnce();
  expect(resources.cleanupRtc).toHaveBeenCalledOnce();
  expect(powerMonitor.listenerCount("suspend")).toBe(0);
  expect(powerMonitor.listenerCount("resume")).toBe(0);
});

it("delivers unknown inspector clients as system notifications and exposes notification failures", async () => {
  const { createServiceRuntime } = await import("./service-runtime.js");
  const runtime = await createServiceRuntime({ userDataPath: "/test/bridge" });
  try {
    const alert = { pid: 42, name: "node", executablePath: "/other/node", approved: false, detectedAt: 100 };
    resources.inspectorOptions!.onAlert(alert);
    expect(resources.showNotification).toHaveBeenCalledOnce();
    expect(resources.notifications[0]?.options).toMatchObject({ title: "Claude 调试接口出现未认可的连接", body: expect.stringContaining("/other/node") });
    resources.notifications[0]!.emit("failed", {}, "notification denied");
    expect(resources.inspector.notificationFailed).toHaveBeenCalledWith("notification denied");
    resources.notificationSupported.mockReturnValueOnce(false);
    expect(resources.inspectorOptions!.onAlert(alert)).toContain("系统通知不可用");
    expect(resources.showNotification).toHaveBeenCalledOnce();
    const status: BridgeInspectorStatus = { state: "listening", port: 9229, pollIntervalMs: 3_000, clients: [alert], alerts: [alert] };
    resources.inspectorOptions!.onUpdate(status);
    expect(resources.controller.updateInspectorStatus).toHaveBeenCalledWith(status);
  } finally { await runtime.close(); }
});

it("attempts all cleanup and preserves startup and cleanup failures", async () => {
  const { createServiceRuntime } = await import("./service-runtime.js");
  resources.controller.initialize.mockRejectedValueOnce(new Error("controller initialization failed"));
  resources.broker.close.mockRejectedValueOnce(new Error("native bridge close failed"));
  const error = await createServiceRuntime({ userDataPath: "/test/bridge" }).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(AggregateError);
  expect(String(error)).toContain("controller initialization failed");
  expect(String(error)).toContain("native bridge close failed");
  expect(resources.broker.close).toHaveBeenCalledOnce();
  expect(resources.state.close).toHaveBeenCalledOnce();
  expect(resources.cleanupRtc).toHaveBeenCalledOnce();
});

it("disables real Native menu automation for a custom inspector origin", async () => {
  vi.stubEnv("BRIDGE_CLAUDE_INSPECTOR_URL", "http://127.0.0.1:19321");
  const { createServiceRuntime } = await import("./service-runtime.js");
  const runtime = await createServiceRuntime({ userDataPath: "/test/bridge" });
  try {
    expect(resources.inspectorOptions!.startup).toBeUndefined();
    expect(resources.inspectorOptions!.enableStartup).toBeUndefined();
    expect(resources.controller.attachInspectorEnabler).not.toHaveBeenCalled();
  }
  finally { await runtime.close(); vi.unstubAllEnvs(); }
});

it("owns one mail service and gives the Controller that exact instance", async () => {
  const { createServiceRuntime } = await import("./service-runtime.js");
  const runtime = await createServiceRuntime({ userDataPath: "/test/bridge" });
  expect(resources.mailOptions).toHaveBeenCalledExactlyOnceWith({ userDataPath: "/test/bridge" });
  expect(resources.assistantMail.initialize).toHaveBeenCalledOnce();
  expect(resources.controllerOptions.mock.calls[0]?.at(-2)).toBe(resources.assistantMail);
  expect(resources.serveMailTools).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ userDataPath: "/test/bridge", service: resources.assistantMail }));
  expect(resources.assistantMail.initialize.mock.invocationCallOrder[0]).toBeLessThan(resources.controller.initialize.mock.invocationCallOrder[0]!);
  await runtime.close();
  expect(resources.assistantMail.close).toHaveBeenCalledOnce();
  expect(resources.controller.close.mock.invocationCallOrder[0]).toBeLessThan(resources.assistantMail.close.mock.invocationCallOrder[0]!);
  expect(resources.mailTools.close).toHaveBeenCalledOnce();
  expect(resources.mailTools.close.mock.invocationCallOrder[0]).toBeLessThan(resources.assistantMail.close.mock.invocationCallOrder[0]!);
});

it("closes mail if native Desktop startup fails after mail initialization", async () => {
  resources.controller.initialize.mockRejectedValueOnce(new Error("Desktop unavailable"));
  const { createServiceRuntime } = await import("./service-runtime.js");
  await expect(createServiceRuntime({ userDataPath: "/test/bridge" })).rejects.toThrow("Desktop unavailable");
  expect(resources.assistantMail.initialize).toHaveBeenCalledOnce();
  expect(resources.assistantMail.close).toHaveBeenCalledOnce();
});

it("closes the initialized mail owner when the narrow listener cannot start", async () => {
  resources.serveMailTools.mockRejectedValueOnce(new Error("mail listener unavailable"));
  const { createServiceRuntime } = await import("./service-runtime.js");
  await expect(createServiceRuntime({ userDataPath: "/test/bridge" })).rejects.toThrow("mail listener unavailable");
  expect(resources.assistantMail.close).toHaveBeenCalledOnce();
  expect(resources.mailTools.close).not.toHaveBeenCalled();
});

it("assembles the native facade", async () => {
  const { createServiceRuntime } = await import("./service-runtime.js");
  const runtime = await createServiceRuntime({ userDataPath: "/test/bridge" });
  expect(resources.nativeOptions).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    settingsPath: "/test/settings.json",
    eventLog: resources.eventLog, conversationState: resources.state, evidence: resources.evidence,
  }));
  await runtime.close();
});

it.each(["invalid JSON", "directory in place of the account file"])("starts the controller with %s in mail configuration", async damage => {
  const fs = await import("node:fs/promises");
  const root = await fs.mkdtemp(join(process.env.BRIDGE_TEST_TEMP_ROOT!, "assistant-damaged-config-"));
  const { AssistantMailService } = await vi.importActual<typeof import("../../../../plugins/assistant-mail/desktop.js")>("../../../../plugins/assistant-mail/desktop.js");
  const credentials = { supported: true, get: vi.fn(), set: vi.fn(), delete: vi.fn() };
  const mail = new AssistantMailService({ userDataPath: root, credentials });
  try {
    const dir = join(root, "private", "assistant");
    const path = join(dir, "accounts.json");
    await fs.mkdir(dir, { recursive: true });
    const invalid = '[{"fixture":"not public"}';
    if (damage === "invalid JSON") await fs.writeFile(path, invalid);
    else await fs.mkdir(path);
    resources.assistantMail.initialize.mockImplementationOnce(() => mail.initialize());
    const { createServiceRuntime } = await import("./service-runtime.js");
    const runtime = await createServiceRuntime({ userDataPath: root });
    try {
      expect(resources.controller.initialize).toHaveBeenCalledOnce();
      expect(mail.status()).toMatchObject({ state: "error", accountConfigError: "mail_account_config_unavailable", accounts: [] });
      expect(JSON.stringify(mail.status())).not.toContain("not public");
      await expect(mail.enable({ host: "imap.example.test", user: "test@example.test", password: "fixture code" })).rejects.toThrow(/^mail_account_config_unavailable$/);
      expect(credentials.set).not.toHaveBeenCalled();
      if (damage === "invalid JSON") expect(await fs.readFile(path, "utf8")).toBe(invalid);
      else expect((await fs.stat(path)).isDirectory()).toBe(true);
      expect(mail.page().events).toEqual([]);
    } finally {
      await runtime.close();
    }
  } finally {
    await mail.close();
  }
});

it("starts ordinary sessions and mail when a saved managed workspace cannot be repaired", async () => {
  resources.assistantMail.binding.mockReturnValue({ nativeSessionId: "local-mail", managed: { path: "/test/bridge/private/assistant/workspace", token: "fixture-managed-token" } });
  resources.assistantMail.status.mockReturnValue({ accounts: [{ enabled: true }] });
  const prepare = vi.spyOn(WorkspaceProvisioner.prototype, "prepare").mockRejectedValueOnce(Object.assign(new Error("Fixture workspace is unwritable"), { code: "EACCES" }));
  try {
    const { createServiceRuntime } = await import("./service-runtime.js");
    const runtime = await createServiceRuntime({ userDataPath: "/test/bridge" });
    try {
      expect(resources.controller.initialize).toHaveBeenCalledOnce();
      expect(resources.assistantMail.initialize).toHaveBeenCalledOnce();
      expect(resources.assistantMail.close).not.toHaveBeenCalled();
      expect(resources.powerSaveBlocker.start).toHaveBeenCalledWith("prevent-app-suspension");
      const { authorizeManagedToken } = resources.serveMailTools.mock.calls[0]![0];
      expect(authorizeManagedToken("fixture-managed-token")).toBeUndefined();
    } finally {
      await runtime.close();
    }
  } finally {
    prepare.mockRestore();
  }
});

it("holds one suspension blocker while receiving or bound, wakes on resume, and releases on close", async () => {
  const { createServiceRuntime } = await import("./service-runtime.js");
  const { powerMonitor } = await import("electron");
  const runtime = await createServiceRuntime({ userDataPath: "/test/bridge" });
  const { assistantMail, powerSaveBlocker } = resources;
  try {
    expect(powerSaveBlocker.start).not.toHaveBeenCalled();
    assistantMail.status.mockReturnValue({ accounts: [{ enabled: true }] });
    assistantMail.emit("changed");
    assistantMail.binding.mockReturnValue({ nativeSessionId: "local-mail" });
    assistantMail.emit("changed");
    expect(powerSaveBlocker.start).toHaveBeenCalledExactlyOnceWith("prevent-app-suspension");
    powerMonitor.emit("resume");
    expect(assistantMail.resume).toHaveBeenCalledOnce();
    expect(resources.controller.reconnect).toHaveBeenCalledOnce();
    assistantMail.status.mockReturnValue({ accounts: [{ enabled: false }] });
    assistantMail.emit("changed");
    expect(powerSaveBlocker.stop).not.toHaveBeenCalled();
    assistantMail.binding.mockReturnValue(undefined);
    assistantMail.emit("changed");
    expect(powerSaveBlocker.stop).toHaveBeenCalledExactlyOnceWith(4);
    assistantMail.binding.mockReturnValue({ nativeSessionId: "local-another" });
    assistantMail.emit("changed");
  } finally { await runtime.close(); }
  expect(powerSaveBlocker.start).toHaveBeenCalledTimes(2);
  expect(powerSaveBlocker.stop.mock.calls).toEqual([[4], [4]]);
});
