import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  BridgeCrypto,
  PAYLOAD_DEFLATE_CAPABILITY,
  PAYLOAD_DEFLATE_SUPPORTED,
  PROTOCOL_VERSION,
  buildPairingUrl,
  relayPathForUrl,
  summarizeEvidenceEvent,
  type BridgeDesktopAppStatus,
  type BridgeDesktopRuntime,
  type BridgeDesktopRuntimeId,
  type BridgeDeviceInfo,
  type BridgeEvent,
  type BridgeInspectorStatus,
  type BridgePayload,
  type BridgePermissionInfo,
  type BridgeRequest,
  type BridgeResponse,
  type BridgeSessionInfo,
  type BridgeTransport,
  type BridgeTransportMetrics,
  type DecryptedEnvelope,
  type DesktopControlSnapshot,
  type EncryptedEnvelope,
  type LocalBridgeRequest,
  type SocketState,
} from "@bridge/protocol";
import type { App } from "electron";
import { diag, diagnostics } from "../app/diag.js";
import type { MemoryRecorder } from "../app/memory-recorder.js";
import type { AssistantMailService } from "../../../../plugins/assistant-mail/desktop.js";
import { createMagpieQuotaPlugin } from "../../../../plugins/magpie-quota/desktop.js";
import type { ClaudeDesktopLifecycle } from "../app/claude-desktop-lifecycle.js";
import { isLaunchAtLoginEnabled, setLaunchAtLogin } from "../app/platform.js";
import type { ClaudeDesktopBridge } from "../claude/claude-desktop-bridge.js";
import type { EvidenceManager } from "../evidence/evidence-manager.js";
import { FileUploadManager } from "../evidence/file-upload.js";
import type { DesktopConfigRepository, LoadedDesktopConfig } from "../transport/config.js";
import {
  acceptsRelayDevice,
  applyManualRelayUrl,
  applyRememberedDevice,
  buildDeviceSnapshots,
  cacheDeviceResponse,
  connectDesktopTransport,
  createPendingDevicePairing,
  deliverTransportMessage,
  lanRelayUrlFrom,
  pairingForDevice,
  probeRelayReady,
  redactedEndpoint,
  registerPendingRelayDevices,
  sendPayloadToDevice,
  type DesktopMessageDeliveryHost,
  type DesktopTransportHost,
} from "../transport/controller-transport.js";
import type { ConversationStateStore } from "./conversation-state-store.js";
import {
  BridgeRequestError,
  dispatchControllerRequest,
  errorResponse,
  type ControllerRpcHost,
  type ControllerSnapshot,
  type DesktopAppLaunchOutcome,
} from "./controller-rpc.js";
import type { SessionEventLog } from "./session-event-log.js";
import { AssistantMailCoordinator } from "./assistant-mail.js";
import type { DesktopUpdater } from "../updater/desktop-updater.js";

export { acceptsRelayDevice };

export class DesktopController extends EventEmitter {
  private config: LoadedDesktopConfig | undefined;
  private inspectorStatus: BridgeInspectorStatus | undefined;
  private inspectorEnabler: (() => Promise<BridgeInspectorStatus>) | undefined;
  private runtimeAttachSleep: ((ms: number) => Promise<void>) | undefined;
  private launchInFlight: Map<BridgeDesktopRuntimeId, Promise<DesktopAppLaunchOutcome>> | undefined;

  updateInspectorStatus(status: BridgeInspectorStatus): void {
    this.inspectorStatus = status;
    this.queuePublish();
  }

  attachInspectorEnabler(enable: () => Promise<BridgeInspectorStatus>): void {
    this.inspectorEnabler = enable;
  }
  private hostCrypto: BridgeCrypto | undefined;
  private socket: BridgeTransport | undefined;
  private connection: SocketState = "idle";
  private currentPairingDeviceId: string | undefined;
  private readonly deviceCryptos = new Map<string, BridgeCrypto>();
  private readonly onlineDevices = new Set<string>();
  private readonly deflateDevices = new Set<string>();
  private readonly responseCache = new Map<string, BridgeResponse>();
  private readonly uploads = new FileUploadManager();
  private readonly magpieQuota = createMagpieQuotaPlugin({ getGateway: () => this.broker.gatewayConfig() });
  private lastSeenAt = Date.now();
  private transportMetrics: BridgeTransportMetrics | undefined;
  private relayHealthy = false;
  readonly assistantMailCoordinator: AssistantMailCoordinator | undefined;
  private lastPublishedSessionKey = "";
  private lastPublishedSessions = new Map<string, string>();
  private lastPublishedPermissions = new Map<string, BridgePermissionInfo>();
  private publishTimer: ReturnType<typeof setTimeout> | undefined;
  private publishInFlight = false;
  private publishPending = false;
  updater: DesktopUpdater | undefined;

  constructor(
    private readonly app: App,
    private readonly repository: DesktopConfigRepository,
    private readonly pairingBaseUrl: string,
    private readonly relayConnectUrl: string,
    private readonly broker: ClaudeDesktopBridge,
    private readonly eventLog: SessionEventLog,
    private readonly evidence: EvidenceManager,
    private readonly claudeDesktop: ClaudeDesktopLifecycle,
    private readonly RTCPeerConnectionImpl?: typeof RTCPeerConnection,
    private readonly desktopAppControls?: ReadonlyMap<BridgeDesktopRuntimeId, ClaudeDesktopLifecycle>,
    private readonly conversationState?: ConversationStateStore,
    updater?: DesktopUpdater,
    private readonly memoryRecorder?: Pick<MemoryRecorder, "diagnostics">,
    readonly assistantMail?: AssistantMailService,
  ) {
    super();
    this.updater = updater;
    this.assistantMailCoordinator = assistantMail
      ? new AssistantMailCoordinator(assistantMail, {
          allSessions: () => this.allSessions(),
          allProjects: () => this.allProjects(),
          canStartTurn: () => this.broker.capabilities().includes("turn.start"),
          onChanged: (snapshot) => {
            void this.eventLog.append({
              origin: "system",
              type: "plugin.assistant-mail.changed",
              data: { assistantMail: snapshot },
            });
            this.queuePublish();
          },
        })
      : undefined;
  }

  async attachUpdater(updater: DesktopUpdater): Promise<DesktopControlSnapshot> {
    this.updater = updater;
    return this.publish();
  }

  notifyUpdaterChanged(): void {
    this.queuePublish();
  }

  async initialize(): Promise<void> {
    this.config = await this.repository.loadOrCreate();
    this.config.managedDesktopEnabled = false;
    this.config.launchAtLogin = await isLaunchAtLoginEnabled(this.app);
    await this.repository.save(this.config);
    this.hostCrypto = await BridgeCrypto.fromHostSecret({
      hostId: this.config.hostDeviceId,
      pairingEpoch: this.config.pairingEpoch,
      roomId: this.config.roomId,
      relayUrl: this.config.relayUrl,
      desktopName: this.config.desktopName,
      deviceId: this.config.hostDeviceId,
      secret: this.config.hostSecret,
    });
    for (const device of this.config.devices.filter((candidate) => !candidate.revokedAt)) {
      const crypto = await BridgeCrypto.fromPairing(pairingForDevice(this.config, device), {
        deviceId: this.config.hostDeviceId,
        ignoreExpiry: true,
      });
      this.deviceCryptos.set(device.deviceId, crypto);
    }
    this.eventLog.on("event", (record: BridgeEvent) => {
      const event = summarizeEvidenceEvent(record);
      this.emit("event", event);
      if (
        event.type === "session.desktop-registration" ||
        (event.origin === "claude-desktop" && event.type === "evidence.updated")
      ) {
        this.queuePublish();
        return;
      }
      const persistOffline = event.type === "permission.requested" || event.type === "question.requested" ||
        event.type === "turn.completed" || event.type === "turn.failed";
      void this.broadcast({ kind: "event", event }, !persistOffline);
      if (event.type !== "runtime.updated" || event.itemId !== "session:subagent-activity") this.queuePublish();
    });
    this.assistantMailCoordinator?.start();
    this.broker.on("changed", () => {
      this.assistantMailCoordinator?.pauseIfArchived();
      this.queuePublish();
    });
    await this.broker.initialize();
    await this.connect();
    if (!this.config.devices.some((device) => (
      !device.revokedAt && (Boolean(device.pairedAt) || device.expiresAt > Date.now())
    ))) {
      await this.createPairing();
    }
  }

  async snapshot(forceDesktopApps = false): Promise<ControllerSnapshot> {
    if (!this.config) throw new Error("Desktop controller is not initialized");
    const currentPairing = this.currentPairingDeviceId
      ? this.config.devices.find((device) => device.deviceId === this.currentPairingDeviceId && !device.revokedAt)
      : undefined;
    const runtimes = this.desktopRuntimes();
    diag("snapshot.build", { runtimes: runtimes.length });
    return {
      host: {
        hostId: this.config.hostDeviceId,
        pairingEpoch: this.config.pairingEpoch,
        name: this.config.desktopName,
        relayUrl: this.config.relayUrl,
        // 0.9.5: advertise the current LAN relay so paired phones can heal
        // their stored LAN endpoint in place (see vault.updateLanRelay).
        ...lanRelayUrlFrom(this.config),
        online: this.connection === "connected",
        lastSeenAt: this.lastSeenAt,
        version: this.app.getVersion(),
        capabilities: [
          ...(PAYLOAD_DEFLATE_SUPPORTED ? [PAYLOAD_DEFLATE_CAPABILITY] as const : []),
          "evidence.v1",
          "evidence.details.v1",
          "artifact.preview.v1",
          "artifact.transfer.v1",
          "artifact.transfer.stat.v1",
          "artifact.text-preview.v1",
          "workspace.upload.v1",
          "claude.native-relay.v1",
          "directory.browse.v1",
          "directory.mkdir.v1",
          "runtime.adapter.v1",
          "session.visibility.v1",
          "session.commands.v1",
          "session.command.v1",
          ...(runtimes.some(runtime => runtime.id === "claude-desktop" && runtime.capabilities.includes("session.rewind")) ? ["session.rewind.v1" as const] : []),
          ...(this.conversationState ? ["session.rename.v1" as const] : []),
          ...(runtimes.some(runtime => runtime.capabilities.includes("workspace.trust")) ? ["workspace.trust.v1" as const] : []),
          ...(runtimes.some(runtime => runtime.capabilities.includes("prompt.resolve")) ? ["prompt.native.v1" as const] : []),
          ...(runtimes.some(runtime => runtime.capabilities.includes("pr.autofix")) ? ["pr.autofix.v1" as const] : []),
          ...(runtimes.some(runtime => runtime.capabilities.includes("section.create")) ? ["section.create.v1" as const] : []),
          ...(runtimes.some(runtime => runtime.capabilities.includes("section.move")) ? ["section.move.v1" as const] : []),
          ...(runtimes.some(runtime => runtime.capabilities.includes("section.rename")) ? ["section.rename.v1" as const] : []),
          ...(runtimes.some(runtime => runtime.capabilities.includes("section.delete")) ? ["section.delete.v1" as const] : []),
          "subagent.stop.v1",
          "turn.queue.steer.v1",
          "turn.queue.cancel.v1",
          "transcript.toolDetail.v1",
          "plugin.magpie-quota.v1",
          ...(this.assistantMailCoordinator ? AssistantMailCoordinator.CAPABILITIES : []),
          ...(this.updater ? ["system.update.v1" as const] : []),
        ],
      },
      projects: this.allProjects(),
      sessions: this.allSessions(),
      devices: this.deviceSnapshots(),
      runtime: this.broker.runtimeStatus(),
      ...await this.broker.magpieSettings(),
      runtimes,
      transport: {
        path: this.socket?.path ?? relayPathForUrl(this.config.relayUrl),
        state: this.connection,
        pendingCount: 0,
        relayHealthy: this.relayHealthy,
        ...(this.transportMetrics?.rttMs !== undefined ? { rttMs: this.transportMetrics.rttMs } : {}),
        ...(this.transportMetrics?.lastConnectedAt !== undefined
          ? { lastConnectedAt: this.transportMetrics.lastConnectedAt }
          : {}),
      },
      permissions: [...this.claudePermissions()]
        .sort((left, right) => left.createdAt - right.createdAt),
      prompts: this.broker.promptsList(),
      latestSeq: this.eventLog.latestSeq(),
      connection: this.connection,
      launchAtLogin: this.config.launchAtLogin,
      diagnosticsEnabled: diagnostics.enabled,
      managedDesktopEnabled: this.config.managedDesktopEnabled,
      ...await this.desktopAppSnapshot(forceDesktopApps),
      ...(this.assistantMailCoordinator ? { assistantMail: this.assistantMailCoordinator.snapshot() } : {}),
      ...(this.updater ? { updater: this.updater.snapshot() } : {}),
      ...(this.inspectorStatus ? { claudeInspector: this.inspectorStatus } : {}),
      ...(currentPairing ? {
        pairingUrl: buildPairingUrl(this.pairingBaseUrl, pairingForDevice(this.config, currentPairing)),
        pairingExpiresAt: currentPairing.expiresAt,
      } : {}),
    };
  }

  async createPairing(): Promise<DesktopControlSnapshot> {
    if (!this.config) throw new Error("Desktop controller is not initialized");
    const { device, crypto } = await createPendingDevicePairing(this.config);
    this.config.devices = [
      device,
      ...this.config.devices.filter((candidate) => candidate.pairedAt || candidate.expiresAt > Date.now()),
    ];
    this.currentPairingDeviceId = device.deviceId;
    this.deviceCryptos.set(device.deviceId, crypto);
    await this.repository.save(this.config);
    this.registerPendingDevices();
    return this.publish();
  }

  async setRelayUrl(value: string): Promise<DesktopControlSnapshot> {
    if (!this.config || !this.hostCrypto) throw new Error("Desktop controller is not initialized");
    this.hostCrypto = applyManualRelayUrl(this.config, this.hostCrypto, this.deviceCryptos, value);
    await this.repository.save(this.config);
    this.onlineDevices.clear();
    await this.reconnect();
    return this.snapshot();
  }

  async testMagpieConnection(input: unknown) {
    return this.broker.testMagpieConnection(input);
  }

  async saveMagpieConnection(input: unknown): Promise<DesktopControlSnapshot> {
    await this.broker.saveMagpieConnection(input);
    return this.publish();
  }

  async setAnthropicApiKey(_value: string): Promise<DesktopControlSnapshot> {
    throw new BridgeRequestError("UNSUPPORTED", "Claude 执行与认证由 Claude Desktop 管理。");
  }

  async removeAnthropicApiKey(): Promise<DesktopControlSnapshot> {
    throw new BridgeRequestError("UNSUPPORTED", "Claude 执行与认证由 Claude Desktop 管理。");
  }

  async revokeDevice(deviceId: string): Promise<DesktopControlSnapshot> {
    if (!this.config) throw new Error("Desktop controller is not initialized");
    const device = this.config.devices.find((candidate) => candidate.deviceId === deviceId);
    if (!device || device.revokedAt) return this.snapshot();
    device.revokedAt = Date.now();
    this.onlineDevices.delete(deviceId);
    this.deviceCryptos.delete(deviceId);
    if (this.currentPairingDeviceId === deviceId) this.currentPairingDeviceId = undefined;
    await this.repository.save(this.config);
    if (this.connection === "connected") this.socket?.revokeDevice(deviceId);
    await this.eventLog.append({
      itemId: deviceId,
      origin: "desktop",
      type: "device.revoked",
      data: { deviceId },
    });
    return this.publish();
  }

  async setDiagnosticsEnabled(enabled: boolean): Promise<DesktopControlSnapshot> {
    if (!this.config) throw new Error("Desktop controller is not initialized");
    this.config.diagnosticsEnabled = enabled;
    await this.repository.save(this.config);
    diagnostics.setEnabled(enabled);
    return this.publish();
  }

  async setLaunchAtLogin(enabled: boolean): Promise<DesktopControlSnapshot> {
    if (!this.config) throw new Error("Desktop controller is not initialized");
    await setLaunchAtLogin(this.app, enabled);
    this.config.launchAtLogin = enabled;
    await this.repository.save(this.config);
    return this.publish();
  }

  async launchClaudeDesktop(): Promise<DesktopControlSnapshot> {
    return this.launchDesktopApp("claude-desktop");
  }

  async quitClaudeDesktop(): Promise<DesktopControlSnapshot> {
    return this.quitDesktopApp("claude-desktop");
  }

  private projectDesktopAppStatus(
    id: BridgeDesktopRuntimeId,
    status: DesktopControlSnapshot["claudeDesktop"],
  ): DesktopControlSnapshot["claudeDesktop"] {
    if (
      id === "claude-desktop"
      && status.state === "running"
      && Boolean(this.inspectorEnabler)
      && this.inspectorStatus?.state !== "listening"
    ) {
      return { ...status, canLaunch: true };
    }
    return status;
  }

  async claudeDesktopStatus(force = false): Promise<DesktopControlSnapshot["claudeDesktop"]> {
    return this.projectDesktopAppStatus("claude-desktop", await this.claudeDesktop.status(force));
  }

  private async desktopAppSnapshot(force: boolean): Promise<Pick<ControllerSnapshot, "claudeDesktop" | "desktopApps">> {
    if (force) {
      // Action replies have always converted failed probes into unavailable app statuses.
      const desktopApps = await this.desktopAppStatuses(true);
      const { id, name, ...claudeDesktop } = desktopApps.find((app) => app.id === "claude-desktop")!;
      return { claudeDesktop, desktopApps };
    }
    const claudeDesktop = await this.claudeDesktopStatus();
    return { claudeDesktop, desktopApps: await this.desktopAppStatuses(false, claudeDesktop) };
  }

  async desktopAppStatuses(force = false, claudeDesktop?: DesktopControlSnapshot["claudeDesktop"]): Promise<BridgeDesktopAppStatus[]> {
    const entries = [...(this.desktopAppControls?.entries() ?? [])];
    if (!entries.some(([id]) => id === "claude-desktop")) {
      entries.unshift(["claude-desktop", this.claudeDesktop]);
    }
    return Promise.all(entries.map(async ([id, lifecycle]) => {
      try {
        const status = id === "claude-desktop" && claudeDesktop
          ? claudeDesktop
          : this.projectDesktopAppStatus(id, await lifecycle.status(force));
        return { id, name: lifecycle.definition.displayName, ...status };
      } catch (error) {
        return {
          id,
          name: lifecycle.definition.displayName,
          state: "unavailable",
          detail: error instanceof Error ? error.message : "无法读取运行状态。",
          canLaunch: false,
          canQuit: false,
        };
      }
    }));
  }

  async launchDesktopApp(runtimeId: BridgeDesktopRuntimeId): Promise<DesktopControlSnapshot> {
    return (await this.launchDesktopAppWithResult(runtimeId)).snapshot;
  }

  async launchDesktopAppWithResult(runtimeId: BridgeDesktopRuntimeId): Promise<DesktopAppLaunchOutcome> {
    const lifecycle = this.desktopAppControls?.get(runtimeId)
      ?? (runtimeId === "claude-desktop" ? this.claudeDesktop : undefined);
    if (!lifecycle) throw new Error("未知 Desktop 应用");
    const inFlightMap = (this.launchInFlight ??= new Map());
    const existing = inFlightMap.get(runtimeId);
    if (existing) return existing;
    const task = (async (): Promise<DesktopAppLaunchOutcome> => {
      const shouldEnableInspector = runtimeId === "claude-desktop"
        && Boolean(this.inspectorEnabler)
        && this.inspectorStatus?.state !== "listening";
      await (shouldEnableInspector ? lifecycle.launch({ activate: true }) : lifecycle.launch());
      let inspectorStatus = this.inspectorStatus;
      let inspectorDetail: string | undefined;
      if (shouldEnableInspector && this.inspectorEnabler) {
        inspectorStatus = await this.inspectorEnabler();
        inspectorDetail = inspectorStatus.state === "error" ? inspectorStatus.error : inspectorStatus.startup?.detail;
        this.inspectorStatus = inspectorStatus;
        if (this.broker?.refreshRuntime) {
          await this.broker.refreshRuntime();
          if (inspectorStatus.state === "listening") {
            const sleep = this.runtimeAttachSleep
              ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
            for (let attempt = 0; attempt < 3; attempt += 1) {
              const state = this.broker.runtimeStatus?.().state;
              if (state === "ready" || state === "working") break;
              await sleep(500);
              await this.broker.refreshRuntime();
            }
          }
        }
      } else if (
        runtimeId === "claude-desktop"
        && inspectorStatus?.state === "listening"
        && this.broker?.refreshRuntime
      ) {
        const state = this.broker.runtimeStatus?.().state;
        if (state !== "ready" && state !== "working") {
          await this.broker.refreshRuntime();
        }
      }
      const integration = runtimeId === "claude-desktop" ? this.broker.runtimeStatus().desktopIntegration : undefined;
      const snapshot = await this.publish(true);
      await this.broadcast({ kind: "snapshot", snapshot });
      if (!integration) return { snapshot };
      const nativeReady = integration.state === "ready";
      const detail = inspectorStatus?.state === "listening"
        ? (nativeReady ? undefined : integration.detail)
        : inspectorDetail ?? inspectorStatus?.error;
      return {
        snapshot,
        claudeActivation: {
          inspectorState: inspectorStatus?.state ?? "unknown",
          nativeReady,
          ...(detail ? { detail } : {}),
        },
      };
    })();
    inFlightMap.set(runtimeId, task);
    try {
      return await task;
    } finally {
      if (inFlightMap.get(runtimeId) === task) {
        inFlightMap.delete(runtimeId);
      }
    }
  }

  async quitDesktopApp(runtimeId: BridgeDesktopRuntimeId): Promise<ControllerSnapshot> {
    const lifecycle = this.desktopAppControls?.get(runtimeId)
      ?? (runtimeId === "claude-desktop" ? this.claudeDesktop : undefined);
    if (!lifecycle) throw new Error("未知 Desktop 应用");
    await lifecycle.quit();
    const snapshot = await this.publish(true);
    await this.broadcast({ kind: "snapshot", snapshot });
    return snapshot;
  }

  async dispatchLocal(input: LocalBridgeRequest): Promise<BridgeResponse> {
    const request: BridgeRequest = {
      kind: "request",
      requestId: randomUUID(),
      idempotencyKey: input.idempotencyKey ?? randomUUID(),
      method: input.method,
      params: input.params ?? {},
    };
    try {
      const result = await this.handleRequest(request, "desktop");
      return { kind: "response", requestId: request.requestId, ok: true, result };
    } catch (error) {
      return errorResponse(request.requestId, error);
    }
  }

  diagnostics(): Record<string, unknown> {
    if (!this.config) throw new Error("Desktop controller is not initialized");
    const now = Date.now();
    const activeDevices = this.config.devices.filter((device) => !device.revokedAt).length;
    const hasPendingPairing = Boolean(
      (this.currentPairingDeviceId && this.config.devices.some((device) => (
        device.deviceId === this.currentPairingDeviceId && !device.revokedAt && !device.pairedAt && device.expiresAt > now
      )))
      || this.config.devices.some((device) => !device.revokedAt && !device.pairedAt && device.expiresAt > now),
    );
    const mailGauges = this.assistantMail?.diagnosticsGauges?.() ?? {
      configured: Boolean(this.assistantMail?.status?.().account),
      unreadCount: 0,
    };
    return {
      generatedAt: new Date().toISOString(),
      bridgeVersion: this.app.getVersion(),
      protocolVersion: PROTOCOL_VERSION,
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      relay: {
        endpoint: redactedEndpoint(this.config.relayUrl),
        connectionEndpoint: redactedEndpoint(this.relayConnectUrl),
        connection: this.connection,
        path: this.socket?.path,
        rttMs: this.transportMetrics?.rttMs,
        healthy: this.relayHealthy,
      },
      runtime: this.broker.runtimeStatus(),
      runtimes: this.desktopRuntimes(),
      counts: {
        projects: this.allProjects().length,
        sessions: this.allSessions().length,
        devices: activeDevices,
        pendingPermissions: this.claudePermissions().length,
      },
      latestEventSeq: this.eventLog.latestSeq(),
      processMemory: process.memoryUsage(),
      traceRecorder: {
        enabled: diagnostics.enabled,
        ...diagnostics.snapshot(),
      },
      stateGauges: {
        controller: {
          devicesTotal: this.config.devices.length,
          activeDevices,
          onlineDevices: this.onlineDevices?.size ?? 0,
          deviceCryptos: this.deviceCryptos?.size ?? 0,
          deflateDevices: this.deflateDevices?.size ?? 0,
          responseCacheEntries: this.responseCache?.size ?? 0,
          hasPendingPairing,
        },
        uploads: this.uploads?.diagnosticsGauges?.() ?? {
          activeSessions: 0,
          retainedSessions: 0,
          committedReceipts: 0,
          bufferedChunks: 0,
          bufferedBytes: 0,
        },
        broker: this.broker.diagnosticsGauges?.() ?? {
          closed: false,
          inspectorState: "disconnected",
          pendingInspectorCalls: { count: 0, oldestMs: 0 },
          inspectorEventStreamWaiting: false,
          inspectorSupportedMethods: 0,
          pendingEvents: 0,
          nativeSessions: 0,
          projectedSessions: 0,
          activeTurns: 0,
          permissions: 0,
          resolvingPermissions: 0,
          prompts: 0,
          receipts: 0,
          streams: 0,
          inFlightTools: 0,
          compactingSessions: 0,
          cachedCatalogs: {
            projectDirectories: 0,
            sections: 0,
            sectionAssignments: 0,
            models: 0,
            messageProjections: 0,
            contextStates: 0,
            backgroundTaskSessions: 0,
            prPreferences: 0,
          },
        },
        evidence: this.evidence?.diagnosticsGauges?.() ?? {
          inFlightPreviewRenders: 0,
          cachedPreviews: 0,
          storedBundles: 0,
          storedBlobs: 0,
          storedBlobBytes: 0,
          activeCaptures: 0,
          activeToolOutputBytes: 0,
          activeTransfers: 0,
          retainedTransfers: 0,
          retainedTransferBytes: 0,
        },
        assistantMail: {
          available: Boolean(this.assistantMail),
          configured: mailGauges.configured,
          unreadCount: mailGauges.unreadCount,
        },
      },
      ...(this.memoryRecorder ? { memory: this.memoryRecorder.diagnostics() } : {}),
    };
  }

  async close(): Promise<void> {
    this.assistantMailCoordinator?.close();
    this.uploads.close();
    this.socket?.close();
  }

  pauseForSleep(): void {
    this.socket?.close();
    this.socket = undefined;
    this.connection = "closed";
    this.relayHealthy = false;
    void this.publish();
  }

  async reconnect(): Promise<void> {
    this.socket?.close();
    this.socket = undefined;
    this.connection = "reconnecting";
    await this.publish();
    await this.broker.refreshRuntime();
    await this.connect();
  }

  async refreshRuntime(): Promise<void> {
    await this.broker.refreshRuntime();
    await this.publish();
  }

  private desktopRuntimes(): BridgeDesktopRuntime[] {
    const claude = this.broker.runtimeStatus();
    const claudeRuntime: BridgeDesktopRuntime = {
      id: "claude-desktop",
      name: "Claude Desktop",
      state: claude.state === "ready" || claude.state === "working"
        ? "ready"
        : claude.state === "unavailable" || claude.state === "auth-required"
          ? "unavailable"
          : "error",
      detail: claude.detail,
      capabilities: this.broker.capabilities(),
      sessionIsolation: "independent",
      sessionCount: this.broker.listSessions().length,
      updatedAt: Date.now(),
      ...(claude.version ? { appVersion: claude.version } : {}),
    };
    return [claudeRuntime];
  }

  private allProjects() {
    const visibleProjectIds = new Set(this.allSessions().map((session) => session.projectId));
    return this.broker.listProjects()
      .filter((project) => project.kind === "desktop-group" || visibleProjectIds.has(project.projectId))
      .sort((left, right) => right.lastActivityAt - left.lastActivityAt || left.projectId.localeCompare(right.projectId));
  }

  private allSessions(): BridgeSessionInfo[] {
    const priority = (state: BridgeSessionInfo["turnState"]): number => (
      state === "waiting" ? 3 : state === "running" ? 2 : state === "queued" ? 1 : 0
    );
    return this.broker.listSessions()
      .sort((left, right) => (
        priority(right.turnState) - priority(left.turnState)
        || right.lastActivityAt - left.lastActivityAt
        || left.sessionId.localeCompare(right.sessionId)
      ));
  }

  private listedSessions(
    projectId?: string,
    search?: string,
    runtimeId?: BridgeDesktopRuntimeId,
  ): BridgeSessionInfo[] {
    const query = search?.trim().toLocaleLowerCase();
    return this.allSessions().filter((session) => {
      if (runtimeId && session.runtimeId !== runtimeId) return false;
      if (projectId && session.projectId !== projectId) return false;
      return !query || `${session.title}\n${session.projectName}\n${session.cwd}`.toLocaleLowerCase().includes(query);
    });
  }

  private claudePermissions(): BridgePermissionInfo[] {
    return this.broker.permissionsList();
  }

  private async connect(): Promise<void> {
    connectDesktopTransport(this as unknown as DesktopTransportHost);
  }

  private async checkRelayHealth(endpoint: string): Promise<void> {
    const ok = await probeRelayReady(endpoint);
    if (this.socket?.endpoint !== endpoint) return;
    this.relayHealthy = ok;
    await this.publish();
  }

  private async receiveMessage(message: DecryptedEnvelope, encrypted: EncryptedEnvelope): Promise<void> {
    await deliverTransportMessage(
      this as unknown as DesktopMessageDeliveryHost,
      message,
      encrypted,
      errorResponse,
    );
  }

  private async handleRequest(
    request: BridgeRequest,
    origin: "desktop" | "mobile",
    sourceDeviceId?: string,
  ): Promise<unknown> {
    return dispatchControllerRequest(
      this as unknown as ControllerRpcHost,
      request,
      origin,
      sourceDeviceId,
    );
  }

  private async sendToDevice(
    payload: BridgePayload,
    deviceId: string,
    ttlMs?: number,
    temporary = false,
    compress = true,
  ): Promise<string> {
    return sendPayloadToDevice(
      this.socket,
      this.connection,
      this.deviceCryptos,
      this.deflateDevices,
      payload,
      deviceId,
      ttlMs,
      temporary,
      compress,
    );
  }

  private async broadcast(payload: BridgePayload, temporary = false): Promise<void> {
    const devices = this.config?.devices.filter((device) => device.pairedAt && !device.revokedAt) ?? [];
    await Promise.allSettled(devices.map((device) => this.sendToDevice(payload, device.deviceId, undefined, temporary)));
  }

  private registerPendingDevices(): void {
    registerPendingRelayDevices(this.config, this.socket, this.connection, this.deviceCryptos);
  }

  private acceptsDevice(deviceId: string): boolean {
    return acceptsRelayDevice(
      this.config?.devices ?? [],
      deviceId,
      this.deviceCryptos.has(deviceId),
    );
  }

  private isPairedDevice(deviceId: string): boolean {
    return Boolean(this.config?.devices.some((device) => (
      device.deviceId === deviceId && Boolean(device.pairedAt) && !device.revokedAt
    )));
  }

  private rejectUnknownDevice(deviceId: string): void {
    this.onlineDevices.delete(deviceId);
    try {
      this.socket?.revokeDevice(deviceId);
    } catch {
      // A reconnect will repeat the rejection if the stale Relay claim remains.
    }
  }

  private async rememberDevice(deviceId: string, metadata?: Record<string, unknown>): Promise<void> {
    if (!this.config) return;
    if (!applyRememberedDevice(this.config, deviceId, this.socket?.path, this.deflateDevices, metadata)) return;
    if (this.currentPairingDeviceId === deviceId) this.currentPairingDeviceId = undefined;
    await this.repository.save(this.config);
  }

  private deviceSnapshots(): BridgeDeviceInfo[] {
    return buildDeviceSnapshots(this.config?.devices ?? [], this.onlineDevices);
  }

  private cacheResponse(response: BridgeResponse): void {
    cacheDeviceResponse(this.responseCache, response);
  }

  /** Coalesce passive snapshots through completion; permissions still publish immediately. */
  private queuePublish(): void {
    void this.publishPermissions();
    this.publishPending = true;
    if (this.publishTimer || this.publishInFlight) return;
    this.publishTimer = setTimeout(async () => {
      this.publishTimer = undefined;
      this.publishPending = false;
      this.publishInFlight = true;
      try {
        await this.publish();
      } finally {
        this.publishInFlight = false;
        if (this.publishPending) this.queuePublish();
      }
    }, 120);
  }

  private async publishPermissions(): Promise<void> {
    const previous = this.lastPublishedPermissions;
    const permissions = new Map(this.claudePermissions().map(permission => [permission.requestId, permission]));
    // Observe membership before I/O; older snapshots never write this baseline back.
    this.lastPublishedPermissions = permissions;
    await Promise.all([
      ...[...permissions.values()].filter(permission => !previous.has(permission.requestId)).map(permission => this.eventLog.append({
        sessionId: permission.sessionId,
        itemId: permission.toolUseId,
        origin: "claude-desktop",
        type: permission.toolName === "AskUserQuestion" ? "question.requested" : "permission.requested",
        data: { ...permission },
      })),
      ...[...previous.values()].filter(permission => !permissions.has(permission.requestId) && !this.broker.permissionResolutionInFlight(permission.requestId)).map(permission => this.eventLog.append({
        sessionId: permission.sessionId,
        itemId: permission.toolUseId,
        origin: "claude-desktop",
        type: permission.toolName === "AskUserQuestion" ? "question.resolved" : "permission.resolved",
        data: { requestId: permission.requestId, automatic: true },
      })),
    ]);
  }

  private async publish(forceDesktopApps = false): Promise<ControllerSnapshot> {
    const published = diagnostics.begin("publish");
    try {
      const [snapshot] = await Promise.all([this.snapshot(forceDesktopApps), this.publishPermissions()]);
      diag("publish.snapshot", { sessions: snapshot.sessions.length });
      this.emit("snapshot", snapshot);
      // Catalog metadata and global runtime changes need a complete snapshot.
      // Session runtime changes use the existing coalesced event channel.
      const sessionKey = JSON.stringify({
        capabilities: snapshot.host?.capabilities,
        defaultPermissionMode: snapshot.host?.defaultPermissionMode,
        runtimeDefaults: snapshot.runtimes?.map(runtime => [runtime.id, runtime.defaultPermissionMode]),
        detection: snapshot.runtime?.detection,
        runtime: [snapshot.runtime?.state, snapshot.runtime?.activeTurns, snapshot.runtime?.maxParallelTurns],
        providers: snapshot.providers,
        magpie: snapshot.magpie,
        prompts: snapshot.prompts,
        updater: snapshot.updater,
        assistantMail: snapshot.assistantMail,
        ...(snapshot.claudeInspector ? {
          claudeInspector: [
            snapshot.claudeInspector.state,
            snapshot.claudeInspector.startup?.state,
            snapshot.claudeInspector.startup?.detail,
          ],
        } : {}),
        projects: snapshot.projects?.map(project => ({ projectId: project.projectId, name: project.name, kind: project.kind, cwd: project.cwd, runtimeId: project.runtimeId }))
          .sort((a, b) => a.projectId.localeCompare(b.projectId)),
      }) + "\n" + snapshot.sessions
        .map((session) => `${session.sessionId}\t${session.projectId}\t${session.projectName}\t${session.title}\t${session.parentSessionId ?? ""}\t${session.forkLabel ?? ""}\t${session.sidechat ? "1" : ""}\t${session.archivedAt ?? ""}\t${session.desktopArchivePending ? "1" : ""}\t${session.model ?? ""}\t${session.modelDisplayName ?? ""}\t${session.effort ?? ""}\t${JSON.stringify(session.desktopRegistration ?? null)}\t${JSON.stringify(session.desktopHandoff ?? null)}\t${JSON.stringify(session.nativePermissionModeChange ?? null)}`)
        .sort()
        .join("\n");
      const previousKey = this.lastPublishedSessionKey;
      const previousSessions = this.lastPublishedSessions;
      const sessions = new Map(snapshot.sessions.map((session) => [session.sessionId, JSON.stringify(session)]));
      this.lastPublishedSessionKey = sessionKey;
      this.lastPublishedSessions = sessions;
      if (previousKey !== sessionKey) {
        await this.broadcast({ kind: "snapshot", snapshot }, true);
      } else {
        // Start all appends before waiting for disk so later snapshots cover their sequences.
        await Promise.all([
          ...snapshot.sessions.map((session) => {
            if (previousSessions.get(session.sessionId) === sessions.get(session.sessionId)) return;
            return this.eventLog.append({
              sessionId: session.sessionId,
              itemId: "session:subagent-activity",
              origin: "system",
              type: "runtime.updated",
              data: { replaceSession: true, session },
            });
          }),
        ]);
      }
      return snapshot;
    } finally { published(); }
  }
}
