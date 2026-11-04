import { join } from "node:path";
import { rename } from "node:fs/promises";
import {
  DEFAULT_BRIDGE_ICE_SERVERS_JSON,
  parseBridgeIceServers,
  relayPathForUrl,
} from "@bridge/protocol";
import { app, powerMonitor, safeStorage, shell } from "electron";
import {
  DesktopConfigRepository,
  fileSecretProtector,
} from "./config.js";
import { removeLegacyConnector } from "./connector.js";
import { ClaudePermissionHook } from "./claude-permission-hook.js";
import { DesktopController } from "./controller.js";
import {
  claudeRuntimePaths,
  connectorPaths,
  defaultDesktopName,
  firstNonEmpty,
  networkReachableUrl,
} from "./platform.js";
import { SessionBroker } from "./session-broker.js";
import { SessionEventLog } from "./session-event-log.js";
import { TranscriptObserver } from "./transcript-observer.js";
import { ClaudeDesktopLifecycle } from "./claude-desktop-lifecycle.js";
import { DESKTOP_APP_DEFINITIONS } from "./desktop-app-definitions.js";
import { ClaudeDesktopSessionRegistrar } from "./claude-desktop-session-registrar.js";
import { ElectronEvidencePreviewRenderer } from "./artifact-preview.js";
import { EvidenceManager } from "./evidence-manager.js";
import { EvidenceStore } from "./evidence-store.js";
import {
  cleanupDesktopPeerConnection,
  loadDesktopPeerConnection,
} from "./webrtc-runtime.js";
import { ConversationStateStore } from "./conversation-state-store.js";
import { ProviderRegistry } from "./provider-registry.js";
import { ProviderRuntimePool } from "./provider-runtime-pool.js";
import { HandoffService } from "./handoff-service.js";
import { CodexAppServerAdapter } from "./codex-app-server-adapter.js";
import { HermesGatewayAdapter } from "./hermes-gateway-adapter.js";
import { DshDesktopAdapter } from "./dsh-desktop-adapter.js";
import { RuntimeAdapterRegistry } from "./runtime-adapter.js";
import { RuntimeSessionBroker } from "./runtime-session-broker.js";
import { RuntimeHandoffService } from "./runtime-handoff-service.js";
import { ServiceResources } from "./service-resources.js";

declare const __BRIDGE_DEFAULT_RELAY__: string;
declare const __BRIDGE_DEFAULT_PUBLIC_RELAY__: string;
declare const __BRIDGE_DEFAULT_PAIRING_BASE__: string;
declare const __BRIDGE_DEFAULT_SERVICE_ORIGIN__: string;
declare const __BRIDGE_DEFAULT_ICE_SERVERS__: string;

const CONFIGURED_RELAY = firstNonEmpty([
  process.env.BRIDGE_RELAY_URL,
  __BRIDGE_DEFAULT_RELAY__,
  "wss://relay.alioxis.com/ws",
])!;
const DEFAULT_RELAY = networkReachableUrl(CONFIGURED_RELAY);
const DEFAULT_PAIRING_BASE = firstNonEmpty([process.env.BRIDGE_PAIRING_BASE_URL])
  ?? networkReachableUrl(firstNonEmpty([
    __BRIDGE_DEFAULT_PAIRING_BASE__,
    "https://relay.alioxis.com",
  ])!);
const CONFIGURED_PUBLIC_RELAY = (
  process.env.BRIDGE_PUBLIC_RELAY_URL === undefined
    ? firstNonEmpty([__BRIDGE_DEFAULT_PUBLIC_RELAY__])
    : firstNonEmpty([process.env.BRIDGE_PUBLIC_RELAY_URL])
) ?? (relayPathForUrl(CONFIGURED_RELAY) === "public-relay" ? CONFIGURED_RELAY : undefined);
const DEFAULT_SERVICE_ORIGIN = firstNonEmpty([
  process.env.BRIDGE_SERVICE_ORIGIN,
  __BRIDGE_DEFAULT_SERVICE_ORIGIN__,
  DEFAULT_PAIRING_BASE,
])!;
const DEFAULT_ICE_SERVERS = parseBridgeIceServers(
  firstNonEmpty([
    process.env.BRIDGE_ICE_SERVERS,
    __BRIDGE_DEFAULT_ICE_SERVERS__,
    DEFAULT_BRIDGE_ICE_SERVERS_JSON,
  ])!,
);

function configPath(userDataPath: string): string {
  const base = process.env.BRIDGE_USER_DATA ?? userDataPath;
  return join(base, "bridge-config.json");
}

async function archiveLegacyQueue(userDataPath: string): Promise<void> {
  const path = join(userDataPath, "bridge-claude-sessions.json");
  await rename(path, `${path}.v1-archive-${Date.now()}`).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

export async function createServiceRuntime(options: { userDataPath: string; onStage?(stage: string): void }): Promise<{
  controller: DesktopController;
  close(): Promise<void>;
}> {
  const resources = new ServiceResources();
  // Native WebRTC must outlive controllers, brokers, and their peer connections.
  resources.defer("WebRTC", cleanupDesktopPeerConnection);
  try {
    const userDataPath = options.userDataPath;
    options.onStage?.("迁移旧版任务记录");
    await archiveLegacyQueue(userDataPath);
    const connectors = connectorPaths();
    await removeLegacyConnector(connectors).catch((error: unknown) => {
      process.stderr.write(`Bridge legacy connector cleanup failed: ${String(error)}\n`);
    });
    options.onStage?.("读取本机配置与配对信息");

    const identityProtector = fileSecretProtector();
    const evidenceProtector = fileSecretProtector();
    const repository = new DesktopConfigRepository(
      configPath(userDataPath),
      identityProtector,
      {
        relayUrl: DEFAULT_RELAY,
        ...(CONFIGURED_PUBLIC_RELAY ? { publicRelayUrl: CONFIGURED_PUBLIC_RELAY } : {}),
        serviceOrigin: DEFAULT_SERVICE_ORIGIN,
        iceServers: DEFAULT_ICE_SERVERS,
        desktopName: defaultDesktopName(),
      },
      evidenceProtector,
    );
    const pairingConfig = await repository.loadOrCreate();
    const eventLog = new SessionEventLog(join(userDataPath, "events-v2.jsonl"));
    resources.defer("Session event log", () => eventLog.close());
    options.onStage?.("打开事件日志");
    await eventLog.initialize();
    const conversationState = new ConversationStateStore({
      databasePath: join(userDataPath, "conversation-state-v1.sqlite"),
      sessionsPath: join(userDataPath, "sessions-v2.json"),
      queuePath: join(userDataPath, "turn-queue-v2.json"),
      masterSecret: pairingConfig.evidenceKey,
    });
    resources.defer("Conversation state", () => conversationState.close());
    options.onStage?.("打开会话数据库");
    await conversationState.initialize();
    const evidenceStore = new EvidenceStore({
      databasePath: join(userDataPath, "evidence-v1.sqlite"),
      blobsPath: join(userDataPath, "evidence-blobs-v1"),
      masterSecret: pairingConfig.evidenceKey,
    });
    const evidence = new EvidenceManager({
      store: evidenceStore,
      eventLog,
      previewRenderer: new ElectronEvidencePreviewRenderer(),
    });
    resources.defer("Evidence store", () => evidence.close());
    options.onStage?.("打开成果数据库");
    await evidence.initialize();
    const runtimePaths = claudeRuntimePaths();
    const observer = new TranscriptObserver({
      paths: runtimePaths,
      eventLog,
      evidence,
      // Keep direct Claude Desktop transcript changes on the same cadence as
      // Codex/Hermes native runtime events.
      pollIntervalMs: 900,
      catalogIntervalMs: 2_000,
    });
    resources.defer("Transcript observer", () => observer.close());
    options.onStage?.("扫描桌面会话");
    await observer.start();
    const desktopRegistrar = new ClaudeDesktopSessionRegistrar({ paths: runtimePaths });
    let runtimeStatus = (): ReturnType<SessionBroker["runtimeStatus"]> => ({
      state: "unavailable",
      detail: "Claude-3p 运行时尚未初始化。",
      activeTurns: 0,
      maxParallelTurns: 2,
      desktopIntegration: {
        state: "not-managed",
        detail: "尚未初始化。",
        enabled: false,
        canRestart: process.platform === "darwin" || process.platform === "win32",
      },
    });
    const providers = new ProviderRegistry({
      state: conversationState,
      apiKeyPath: join(userDataPath, "anthropic-api-key-v1.json"),
      safeStorage,
      claude3pStatus: () => runtimeStatus(),
    });
    const runtimePool = new ProviderRuntimePool(providers);
    const broker = new SessionBroker({
      paths: runtimePaths,
      eventLog,
      observer,
      sessionsPath: join(userDataPath, "sessions-v2.json"),
      queuePath: join(userDataPath, "turn-queue-v2.json"),
      conversationState,
      runtimePool,
      evidence,
      desktopRegistrar,
    });
    resources.defer("Session broker", () => broker.close());
    const permissionHook = new ClaudePermissionHook({
      settingsPath: connectors.claudeSettings,
      broker: broker.permissionBroker,
      sessionId: (nativeSessionId) => broker.resolveNativePermissionSessionId(nativeSessionId),
    });
    runtimeStatus = () => broker.runtimeStatus();
    const runtimeRegistry = new RuntimeAdapterRegistry([
      new CodexAppServerAdapter(),
      new HermesGatewayAdapter(),
      new DshDesktopAdapter(),
    ]);
    const runtimeSessions = new RuntimeSessionBroker(runtimeRegistry, eventLog, conversationState, { evidence });
    const handoffs = new HandoffService({
      state: conversationState,
      broker,
      eventLog,
      evidence,
      providers,
      runtimePool,
      observer,
      paths: runtimePaths,
      openExternal: (url) => shell.openExternal(url),
    });
    const runtimeHandoffs = new RuntimeHandoffService({
      state: conversationState,
      broker,
      eventLog,
      evidence,
      runtimeRegistry,
      runtimeSessions,
    });
    const claudeDesktop = new ClaudeDesktopLifecycle();
    const desktopAppControls = new Map(
      DESKTOP_APP_DEFINITIONS.map((definition) => [
        definition.id,
        definition.id === "claude-desktop" ? claudeDesktop : new ClaudeDesktopLifecycle({ definition }),
      ]),
    );
    let RTCPeerConnectionImpl: typeof RTCPeerConnection | undefined;
    try {
      RTCPeerConnectionImpl = loadDesktopPeerConnection();
    } catch (error) {
      process.stderr.write(
        `Bridge WebRTC unavailable; Relay fallback remains active: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }
    const controller = new DesktopController(
      app,
      repository,
      DEFAULT_PAIRING_BASE,
      CONFIGURED_RELAY,
      broker,
      eventLog,
      evidence,
      claudeDesktop,
      RTCPeerConnectionImpl,
      providers,
      handoffs,
      runtimeSessions,
      desktopAppControls,
      runtimeHandoffs,
      conversationState,
    );

    // Controller owns runtime sessions and handoffs; the service owns the broker.
    resources.defer("Desktop controller", () => controller.close());
    resources.defer("Permission hook", () => permissionHook.close());
    options.onStage?.("安装本机权限回调");
    await permissionHook.start().catch((error: unknown) => {
      process.stderr.write(
        `Bridge Claude permission hook failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    });
    options.onStage?.("初始化运行时与中继连接");
    await controller.initialize();
    options.onStage?.("记录服务启动完成");
    await conversationState.recordSuccessfulStartup();
    const onSuspend = () => controller.pauseForSleep();
    const onResume = () => void controller.reconnect().catch((error: unknown) => {
      process.stderr.write(`Bridge resume failed: ${String(error)}\n`);
    });
    resources.defer("Power monitor", () => {
      powerMonitor.removeListener("suspend", onSuspend);
      powerMonitor.removeListener("resume", onResume);
    });
    powerMonitor.on("suspend", onSuspend);
    powerMonitor.on("resume", onResume);

    return { controller, close: () => resources.close() };
  } catch (error) {
    return resources.fail(error);
  }
}
