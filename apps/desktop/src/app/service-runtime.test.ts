import { EventEmitter } from "node:events";
import { join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import type { BridgeInspectorAlert, BridgeInspectorStatus } from "@bridge/protocol";

const resources = vi.hoisted(() => {
  const resource = () => ({ initialize: vi.fn(async () => {}), close: vi.fn(async () => {}) });
  return {
    eventLog: resource(), state: resource(),
    evidence: resource(),
    broker: resource(), nativeOptions: vi.fn(),
    controller: { ...resource(), attachUpdater: vi.fn(async () => {}), pauseForSleep: vi.fn(), reconnect: vi.fn(async () => {}), updateInspectorStatus: vi.fn() },
    updater: { initialize: vi.fn(async () => {}), close: vi.fn() },
    cleanupRtc: vi.fn(),
    diagnosticsEnabled: false,
    diagnostics: { start: vi.fn(), setEnabled: vi.fn(), close: vi.fn() },
    inspector: { start: vi.fn(async () => {}), close: vi.fn(), notificationFailed: vi.fn() },
    inspectorOptions: undefined as undefined | { onUpdate(status: BridgeInspectorStatus): void; onAlert(alert: BridgeInspectorAlert): string | undefined; startup?: (listening: boolean) => Promise<string | undefined> },
    notificationSupported: vi.fn(() => true), showNotification: vi.fn(),
    notifications: [] as Array<{ options: { title: string; body: string }; emit(event: string, ...args: unknown[]): boolean }>,
  };
});
vi.mock("electron", () => ({
  app: { getVersion: () => "1.3.2", isPackaged: false }, safeStorage: {}, shell: {}, powerMonitor: new EventEmitter(),
  Notification: class extends EventEmitter {
    static isSupported() { return resources.notificationSupported(); }
    show = resources.showNotification;
    constructor(public options: { title: string; body: string }) { super(); resources.notifications.push(this); }
  },
}));
vi.mock("../claude/claude-inspector-monitor.js", () => ({ ClaudeInspectorMonitor: class { constructor(options: NonNullable<typeof resources.inspectorOptions>) { resources.inspectorOptions = options; return resources.inspector; } } }));
vi.mock("../transport/config.js", () => ({
  fileSecretProtector: vi.fn(),
  DesktopConfigRepository: class { async loadOrCreate() { return { evidenceKey: "test-key", diagnosticsEnabled: resources.diagnosticsEnabled }; } },
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
vi.mock("../controller/controller.js", () => ({ DesktopController: class { constructor() { return resources.controller; } } }));
vi.mock("../updater/desktop-updater.js", () => ({ DesktopUpdater: class { constructor() { return resources.updater; } } }));
vi.mock("./diag.js", () => ({ diagnostics: resources.diagnostics }));
vi.mock("./claude-desktop-lifecycle.js", () => ({ ClaudeDesktopLifecycle: class {} }));
vi.mock("../transport/webrtc-runtime.js", () => ({ loadDesktopPeerConnection: vi.fn(), cleanupDesktopPeerConnection: resources.cleanupRtc }));

beforeEach(() => {
  vi.clearAllMocks();
  resources.diagnosticsEnabled = false;
  resources.notifications.length = 0;
  resources.inspectorOptions = undefined;
  resources.notificationSupported.mockReturnValue(true);
  for (const name of ["RELAY", "PUBLIC_RELAY", "PAIRING_BASE", "SERVICE_ORIGIN", "ICE_SERVERS"]) {
    vi.stubGlobal(`__BRIDGE_DEFAULT_${name}__`, "");
  }
});

it.each(["eventLog", "state", "evidence", "controller"] as const)("unwinds acquired resources when %s initialization fails", async (stage) => {
  const failure = new Error(`${stage} unavailable`);
  resources[stage].initialize.mockRejectedValueOnce(failure);
  const { createServiceRuntime } = await import("./service-runtime.js");
  await expect(createServiceRuntime({ userDataPath: "/test/bridge" })).rejects.toThrow(failure.message);
  expect(resources.eventLog.close).toHaveBeenCalledOnce();
  expect(resources.diagnostics.close).toHaveBeenCalledOnce();
  if (stage !== "eventLog") expect(resources.state.close).toHaveBeenCalledOnce();
  if (stage === "evidence" || stage === "controller") expect(resources.evidence.close).toHaveBeenCalledOnce();
  if (stage === "controller") {
    for (const resource of [resources.controller, resources.broker]) {
      expect(resource.close).toHaveBeenCalledOnce();
    }
    expect(resources.cleanupRtc).toHaveBeenCalledOnce();
  }
});

it("restores the saved diagnostic preference and releases the recorder with the service", async () => {
  resources.diagnosticsEnabled = true;
  const { createServiceRuntime } = await import("./service-runtime.js");
  const runtime = await createServiceRuntime({ userDataPath: "/test/bridge" });
  expect(resources.diagnostics.start).toHaveBeenCalledWith(join("/test/bridge", "background-service", "diagnostics", "trace.sqlite"));
  expect(resources.diagnostics.setEnabled).toHaveBeenCalledWith(true);
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
    "打开成果数据库", "初始化运行时与中继连接",
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
  try { expect(resources.inspectorOptions!.startup).toBeUndefined(); }
  finally { await runtime.close(); vi.unstubAllEnvs(); }
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
