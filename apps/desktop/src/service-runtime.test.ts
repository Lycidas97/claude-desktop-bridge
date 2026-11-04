import { EventEmitter } from "node:events";
import { beforeEach, expect, it, vi } from "vitest";

const resources = vi.hoisted(() => {
  const resource = () => ({ initialize: vi.fn(async () => {}), close: vi.fn(async () => {}) });
  return {
    eventLog: resource(), state: { ...resource(), recordSuccessfulStartup: vi.fn(async () => {}) },
    evidence: resource(), observer: { start: vi.fn(async () => {}), close: vi.fn(async () => {}) },
    broker: { ...resource(), permissionBroker: {}, runtimeStatus: vi.fn() },
    hook: { start: vi.fn(async () => {}), close: vi.fn(async () => {}) },
    controller: { ...resource(), pauseForSleep: vi.fn(), reconnect: vi.fn(async () => {}) },
    cleanupRtc: vi.fn(),
  };
});
vi.mock("electron", () => ({ app: {}, safeStorage: {}, shell: {}, powerMonitor: new EventEmitter() }));
vi.mock("node:fs/promises", () => ({ rename: vi.fn(async () => {}) }));
vi.mock("./config.js", () => ({
  fileSecretProtector: vi.fn(),
  DesktopConfigRepository: class { async loadOrCreate() { return { evidenceKey: "test-key" }; } },
}));
vi.mock("./connector.js", () => ({ removeLegacyConnector: vi.fn(async () => {}) }));
vi.mock("./platform.js", () => ({
  connectorPaths: () => ({ claudeSettings: "/test/settings.json" }), claudeRuntimePaths: () => ({}),
  defaultDesktopName: () => "Test", firstNonEmpty: (values: unknown[]) => values.find(Boolean),
  networkReachableUrl: (url: string) => url,
}));
vi.mock("./session-event-log.js", () => ({ SessionEventLog: class { constructor() { return resources.eventLog; } } }));
vi.mock("./conversation-state-store.js", () => ({ ConversationStateStore: class { constructor() { return resources.state; } } }));
vi.mock("./evidence-store.js", () => ({ EvidenceStore: class {} }));
vi.mock("./evidence-manager.js", () => ({ EvidenceManager: class { constructor() { return resources.evidence; } } }));
vi.mock("./artifact-preview.js", () => ({ ElectronEvidencePreviewRenderer: class {} }));
vi.mock("./transcript-observer.js", () => ({ TranscriptObserver: class { constructor() { return resources.observer; } } }));
vi.mock("./session-broker.js", () => ({ SessionBroker: class { constructor() { return resources.broker; } } }));
vi.mock("./claude-permission-hook.js", () => ({ ClaudePermissionHook: class { constructor() { return resources.hook; } } }));
vi.mock("./controller.js", () => ({ DesktopController: class { constructor() { return resources.controller; } } }));
vi.mock("./claude-desktop-session-registrar.js", () => ({ ClaudeDesktopSessionRegistrar: class {} }));
vi.mock("./provider-registry.js", () => ({ ProviderRegistry: class {} }));
vi.mock("./provider-runtime-pool.js", () => ({ ProviderRuntimePool: class {} }));
vi.mock("./runtime-adapter.js", () => ({ RuntimeAdapterRegistry: class {} }));
vi.mock("./runtime-session-broker.js", () => ({ RuntimeSessionBroker: class {} }));
vi.mock("./handoff-service.js", () => ({ HandoffService: class {} }));
vi.mock("./runtime-handoff-service.js", () => ({ RuntimeHandoffService: class {} }));
vi.mock("./claude-desktop-lifecycle.js", () => ({ ClaudeDesktopLifecycle: class {} }));
vi.mock("./codex-app-server-adapter.js", () => ({ CodexAppServerAdapter: class {} }));
vi.mock("./hermes-gateway-adapter.js", () => ({ HermesGatewayAdapter: class {} }));
vi.mock("./dsh-desktop-adapter.js", () => ({ DshDesktopAdapter: class {} }));
vi.mock("./webrtc-runtime.js", () => ({ loadDesktopPeerConnection: vi.fn(), cleanupDesktopPeerConnection: resources.cleanupRtc }));

beforeEach(() => {
  vi.clearAllMocks();
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
  if (stage !== "eventLog") expect(resources.state.close).toHaveBeenCalledOnce();
  if (stage === "evidence" || stage === "controller") expect(resources.evidence.close).toHaveBeenCalledOnce();
  if (stage === "controller") {
    for (const resource of [resources.hook, resources.controller, resources.broker, resources.observer]) {
      expect(resource.close).toHaveBeenCalledOnce();
    }
    expect(resources.cleanupRtc).toHaveBeenCalledOnce();
  }
});

it("shares shutdown completion and closes each resource once", async () => {
  const { createServiceRuntime } = await import("./service-runtime.js");
  const runtime = await createServiceRuntime({ userDataPath: "/test/bridge" });
  let finish!: () => void;
  resources.hook.close.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
  const first = runtime.close();
  const second = runtime.close();
  await vi.waitFor(() => expect(resources.hook.close).toHaveBeenCalledOnce());
  try { expect(first).toBe(second); } finally { finish(); await Promise.all([first, second]); }
  expect(resources.controller.close).toHaveBeenCalledOnce();
});

it("removes power subscriptions and finishes cleanup after a close failure", async () => {
  const { createServiceRuntime } = await import("./service-runtime.js");
  const { powerMonitor } = await import("electron");
  const onStage = vi.fn();
  const runtime = await createServiceRuntime({ userDataPath: "/test/bridge", onStage });
  expect(onStage.mock.calls.map(([stage]) => stage)).toEqual([
    "迁移旧版任务记录", "读取本机配置与配对信息", "打开事件日志", "打开会话数据库",
    "打开成果数据库", "扫描桌面会话", "安装本机权限回调", "初始化运行时与中继连接", "记录服务启动完成",
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

it("attempts all cleanup and preserves startup and cleanup failures", async () => {
  const { createServiceRuntime } = await import("./service-runtime.js");
  resources.controller.initialize.mockRejectedValueOnce(new Error("controller initialization failed"));
  resources.hook.close.mockRejectedValueOnce(new Error("hook removal failed"));
  const error = await createServiceRuntime({ userDataPath: "/test/bridge" }).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(AggregateError);
  expect(String(error)).toContain("controller initialization failed");
  expect(String(error)).toContain("hook removal failed");
  expect(resources.broker.close).toHaveBeenCalledOnce();
  expect(resources.state.close).toHaveBeenCalledOnce();
  expect(resources.cleanupRtc).toHaveBeenCalledOnce();
});
