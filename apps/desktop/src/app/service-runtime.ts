import { join } from "node:path";
import {
  DEFAULT_BRIDGE_ICE_SERVERS_JSON,
  DEFAULT_BRIDGE_SERVICE_ORIGIN,
  DEFAULT_PUBLIC_RELAY_URL,
  parseBridgeIceServers,
  relayPathForUrl,
} from "@bridge/protocol";
import { app, Notification, powerMonitor, safeStorage, shell } from "electron";
import { ClaudeInspectorMonitor } from "../claude/claude-inspector-monitor.js";
import { ClaudeInspectorStartup } from "../claude/claude-inspector-startup.js";
import {
  DesktopConfigRepository,
  fileSecretProtector,
} from "../transport/config.js";
import { removeLegacyConnector } from "../claude/connector.js";
import { DesktopController } from "../controller/controller.js";
import {
  connectorPaths,
  defaultDesktopName,
  firstNonEmpty,
  networkReachableUrl,
} from "./platform.js";
import { ClaudeDesktopBridge } from "../claude/claude-desktop-bridge.js";
import { SessionEventLog } from "../controller/session-event-log.js";
import { ClaudeDesktopLifecycle } from "./claude-desktop-lifecycle.js";
import { DESKTOP_APP_DEFINITIONS } from "./desktop-app-definitions.js";
import { ElectronEvidencePreviewRenderer } from "../evidence/artifact-preview.js";
import { EvidenceManager } from "../evidence/evidence-manager.js";
import { EvidenceStore } from "../evidence/evidence-store.js";
import {
  cleanupDesktopPeerConnection,
  loadDesktopPeerConnection,
} from "../transport/webrtc-runtime.js";
import { ConversationStateStore } from "../controller/conversation-state-store.js";
import { MagpieConnectionRepository } from "../claude/magpie-connection.js";
import { ServiceResources } from "./service-resources.js";

declare const __BRIDGE_DEFAULT_RELAY__: string;
declare const __BRIDGE_DEFAULT_PUBLIC_RELAY__: string;
declare const __BRIDGE_DEFAULT_PAIRING_BASE__: string;
declare const __BRIDGE_DEFAULT_SERVICE_ORIGIN__: string;
declare const __BRIDGE_DEFAULT_ICE_SERVERS__: string;

const CONFIGURED_RELAY = firstNonEmpty([
  process.env.BRIDGE_RELAY_URL,
  __BRIDGE_DEFAULT_RELAY__,
  DEFAULT_PUBLIC_RELAY_URL,
])!;
const DEFAULT_RELAY = networkReachableUrl(CONFIGURED_RELAY);
const DEFAULT_PAIRING_BASE = firstNonEmpty([process.env.BRIDGE_PAIRING_BASE_URL])
  ?? networkReachableUrl(firstNonEmpty([
    __BRIDGE_DEFAULT_PAIRING_BASE__,
    DEFAULT_BRIDGE_SERVICE_ORIGIN,
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

export async function createServiceRuntime(options: { userDataPath: string; onStage?(stage: string): void }): Promise<{
  controller: DesktopController;
  close(): Promise<void>;
}> {
  const resources = new ServiceResources();
  // Native WebRTC must outlive controllers, brokers, and their peer connections.
  resources.defer("WebRTC", cleanupDesktopPeerConnection);
  try {
    const userDataPath = options.userDataPath;
    await removeLegacyConnector(connectorPaths()).catch((error: unknown) => {
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
    const broker = new ClaudeDesktopBridge({
      settingsPath: connectorPaths().claudeSettings,
      eventLog,
      conversationState,
      magpieConnection: new MagpieConnectionRepository(join(userDataPath, "magpie-connection-v1.json"), safeStorage),
      evidence,
    });
    resources.defer("Claude Desktop bridge", () => broker.close());
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
      desktopAppControls,
      conversationState,
    );

    // The service owns the Claude broker and controller.
    resources.defer("Desktop controller", () => controller.close());
    options.onStage?.("初始化运行时与中继连接");
    await controller.initialize();
    const inspectorStartup = new ClaudeInspectorStartup({ recordPath: join(userDataPath, "claude-inspector-startup-v1.json") });
    const inspector = new ClaudeInspectorMonitor({
      ...(!process.env.BRIDGE_CLAUDE_INSPECTOR_URL ? { startup: (listening: boolean) => inspectorStartup.check(listening) } : {}),
      onUpdate: (status) => controller.updateInspectorStatus(status),
      onAlert: (alert) => {
        if (!Notification.isSupported()) return "系统通知不可用，请查看 Bridge 内的调试连接告警。";
        const notification = new Notification({
          title: "Claude 调试接口出现未认可的连接",
          body: `PID ${alert.pid} · ${alert.name}\n${alert.executablePath ?? alert.pathError ?? "路径未知"}`,
        });
        notification.on("failed", (_event, error) => inspector.notificationFailed(error));
        notification.show();
        return undefined;
      },
    });
    resources.defer("Inspector monitor", () => inspector.close());
    await inspector.start();
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
