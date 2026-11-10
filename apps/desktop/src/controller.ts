import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  BridgeCrypto,
  ARTIFACT_TRANSFER_TTL_MS,
  PAIRING_SCHEMA_VERSION,
  PROTOCOL_VERSION,
  RelayTransport,
  TransportRouter,
  WebRtcTransport,
  bridgeIceServers,
  buildPairingUrl,
  bridgeEndpoint,
  normalizeRelayUrl,
  relayServiceOrigin,
  cryptoWithRelayEndpoint,
  relayPathForUrl,
  evidenceSummary,
  isBridgeNativeImageRef,
  summarizeEvidenceEvent,
  type BridgeAttachment,
  type BridgeDesktopAppStatus,
  type BridgeDesktopRuntime,
  type BridgeDesktopRuntimeId,
  type BridgeDeviceInfo,
  type BridgeDirectoryListing,
  type BridgeEndpoint,
  type BridgeEffort,
  type BridgeEvent,
  type BridgeNativePermissionMode,
  type BridgeInspectorStatus,
  type BridgePermissionInfo,
  type BridgePermissionMode,
  type BridgePayload,
  type BridgeRequest,
  type BridgeResponse,
  type BridgeSessionInfo,
  type BridgeSDKPermissionMode,
  type BridgeTransport,
  type BridgeTransportCandidate,
  type BridgeTransportMetrics,
  type DesktopControlSnapshot,
  type DecryptedEnvelope,
  type EncryptedEnvelope,
  type PairingBundle,
  type SocketState,
} from "@bridge/protocol";
import { shell } from "electron";
import { readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { accessibleDirectory } from "./working-directory.js";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { App } from "electron";
import {
  DesktopConfigRepository,
  type LoadedDesktopConfig,
  type LoadedDeviceConfig,
} from "./config.js";
import type { ClaudeDesktopBridge } from "./claude-desktop-bridge.js";
import type { EvidenceManager } from "./evidence-manager.js";
import type { SessionEventLog } from "./session-event-log.js";
import type { ClaudeDesktopLifecycle } from "./claude-desktop-lifecycle.js";
import { isLaunchAtLoginEnabled, setLaunchAtLogin } from "./platform.js";
import { parseRuntimeSessionId, type RuntimeSessionBroker } from "./runtime-session-broker.js";
import type { RuntimeHandoffService } from "./runtime-handoff-service.js";
import type { ConversationStateStore, SessionVisibility } from "./conversation-state-store.js";
import { FileUploadManager } from "./file-upload.js";
import { MAGPIE_QUOTA_METHOD } from "../../../plugins/magpie-quota/contract.js";
import { createMagpieQuotaPlugin } from "../../../plugins/magpie-quota/desktop.js";

export interface LocalBridgeRequest {
  method: BridgeRequest["method"];
  params?: Record<string, unknown>;
  idempotencyKey?: string;
}

class BridgeRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "BridgeRequestError";
  }
}

const DISCOVERY_REFRESH_MIN_INTERVAL_MS = 2_000;

function stringParam(params: Record<string, unknown>, key: string, required = true): string | undefined {
  const value = params[key];
  if (typeof value === "string" && value.trim()) return value;
  if (required) throw new Error(`${key} is required`);
  return undefined;
}

function runtimeIdParam(
  params: Record<string, unknown>,
  key: string,
  required = false,
): BridgeDesktopRuntimeId | undefined {
  if (params[key] !== undefined && (typeof params[key] !== "string" || !params[key].trim())) throw new Error("Unknown Desktop runtime");
  const value = stringParam(params, key, required);
  if (!value) return undefined;
  if (
    value === "claude-desktop" ||
    value === "codex-desktop" ||
    value === "hermes-desktop" ||
    value === "dsh-desktop"
  ) return value;
  throw new Error("Unknown Desktop runtime");
}

function numberParam(params: Record<string, unknown>, key: string, fallback: number): number {
  const value = params[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function integerParam(params: Record<string, unknown>, key: string): number {
  const value = params[key];
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`${key} must be an integer`);
  return value;
}

function nullableStringParam(params: Record<string, unknown>, key: string): string | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(params, key)) return undefined;
  const value = params[key];
  if (value === null) return null;
  if (typeof value === "string" && value.trim()) return value.trim();
  throw new Error(`${key} must be a non-empty string or null`);
}

function nullableBooleanParam(params: Record<string, unknown>, key: string): boolean | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(params, key)) return undefined;
  const value = params[key];
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  throw new Error(`${key} must be a boolean or null`);
}

function effortParam(params: Record<string, unknown>, key: string): BridgeEffort | null | undefined {
  const value = nullableStringParam(params, key);
  if (value === undefined || value === null) return value;
  if (["low", "medium", "high", "xhigh", "max"].includes(value)) return value as BridgeEffort;
  throw new Error("Invalid effort");
}

function permissionModeParam(
  params: Record<string, unknown>,
  key: string,
): BridgePermissionMode | null | undefined {
  const value = nullableStringParam(params, key);
  if (value === undefined || value === null) return value;
  if (value === "standard" || value === "full-access") return value;
  throw new Error("Invalid permission mode");
}

function attachmentsParam(params: Record<string, unknown>): BridgeAttachment[] {
  if (params.attachments === undefined) return [];
  if (!Array.isArray(params.attachments)) throw new Error("attachments must be an array");
  let total = 0;
  return params.attachments.map((value) => {
    if (!value || typeof value !== "object") throw new Error("Invalid attachment");
    const attachment = value as Partial<BridgeAttachment>;
    if (
      typeof attachment.id !== "string" ||
      typeof attachment.name !== "string" ||
      typeof attachment.mimeType !== "string" ||
      !["image/jpeg", "image/png", "image/gif", "image/webp"].includes(attachment.mimeType) ||
      typeof attachment.size !== "number" ||
      typeof attachment.data !== "string"
    ) throw new Error("Invalid image attachment");
    total += attachment.size;
    if (attachment.size > 4 * 1024 * 1024 || total > 6 * 1024 * 1024) {
      throw new Error("Image attachments exceed the 6 MB limit");
    }
    return attachment as BridgeAttachment;
  });
}

function relayReadyUrl(endpoint: string): string {
  const url = new URL(endpoint);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/ready";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function redactedEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  const fingerprint = createHash("sha256").update(url.host).digest("hex").slice(0, 10);
  return `${url.protocol}//relay-${fingerprint}${url.pathname}`;
}

function pairingForDevice(config: LoadedDesktopConfig, device: LoadedDeviceConfig): PairingBundle {
  return {
    version: PAIRING_SCHEMA_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    hostId: config.hostDeviceId,
    pairingEpoch: config.pairingEpoch,
    roomId: config.roomId,
    deviceId: device.deviceId,
    secret: device.secret,
    relayUrl: config.relayUrl,
    serviceOrigin: config.serviceOrigin,
    relayEndpoints: config.relayEndpoints,
    activeEndpoint: config.activeEndpoint,
    iceServers: config.iceServers,
    desktopName: config.desktopName,
    createdAt: device.createdAt,
    expiresAt: device.expiresAt,
    singleUse: true,
  };
}

function errorResponse(requestId: string, error: unknown): BridgeResponse {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof BridgeRequestError) {
    return {
      kind: "response",
      requestId,
      ok: false,
      error: {
        code: error.code,
        message,
        retryable: error.retryable,
      },
    };
  }
  const retryable = /unavailable|busy|offline|connect|runtime/iu.test(message);
  return {
    kind: "response",
    requestId,
    ok: false,
    error: {
      code: message.toLocaleUpperCase().replace(/[^A-Z0-9]+/gu, "_").slice(0, 80) || "REQUEST_FAILED",
      message,
      retryable,
    },
  };
}

export function acceptsRelayDevice(
  devices: readonly LoadedDeviceConfig[],
  deviceId: string,
  hasCrypto: boolean,
): boolean {
  return hasCrypto && devices.some((device) => device.deviceId === deviceId && !device.revokedAt);
}

function lanRelayUrlFrom(config: LoadedDesktopConfig): { lanRelayUrl?: string } {
  const endpoint = config.relayEndpoints.find((candidate) => candidate.kind === "lan-relay");
  return endpoint ? { lanRelayUrl: endpoint.url } : {};
}

export class DesktopController extends EventEmitter {
  private config: LoadedDesktopConfig | undefined;
  private inspectorStatus: BridgeInspectorStatus | undefined;

  updateInspectorStatus(status: BridgeInspectorStatus): void {
    this.inspectorStatus = status;
    this.queuePublish();
  }
  private hostCrypto: BridgeCrypto | undefined;
  private socket: BridgeTransport | undefined;
  private connection: SocketState = "idle";
  private currentPairingDeviceId: string | undefined;
  private readonly deviceCryptos = new Map<string, BridgeCrypto>();
  private readonly onlineDevices = new Set<string>();
  private readonly responseCache = new Map<string, BridgeResponse>();
  private readonly uploads = new FileUploadManager();
  private readonly magpieQuota = createMagpieQuotaPlugin({ getGateway: () => this.broker.gatewayConfig() });
  private lastSeenAt = Date.now();
  private transportMetrics: BridgeTransportMetrics | undefined;
  private relayHealthy = false;
  private lastPublishedSessionKey = "";
  private lastPublishedSessions = new Map<string, string>();
  private lastDiscoveryRefreshAt = 0;
  private readonly sessionVisibility = new Map<string, { visibility: SessionVisibility; updatedAt: number }>();
  private publishTimer: ReturnType<typeof setTimeout> | undefined;

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
    private readonly runtimeSessions?: RuntimeSessionBroker,
    private readonly desktopAppControls?: ReadonlyMap<BridgeDesktopRuntimeId, ClaudeDesktopLifecycle>,
    private readonly runtimeHandoffs?: RuntimeHandoffService,
    private readonly conversationState?: ConversationStateStore,
  ) {
    super();
  }

  async initialize(): Promise<void> {
    this.config = await this.repository.loadOrCreate();
    if (this.conversationState) {
      for (const row of this.conversationState.listSessionVisibility()) {
        this.sessionVisibility.set(row.sessionId, { visibility: row.visibility, updatedAt: row.updatedAt });
      }
    }
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
      const persistOffline = event.type === "permission.requested" || event.type === "question.requested";
      void this.broadcast({ kind: "event", event }, !persistOffline);
      if (event.type !== "runtime.updated" || event.itemId !== "session:subagent-activity") this.queuePublish();
    });
    this.broker.on("changed", () => {
      void this.publish();
    });
    await this.broker.initialize();
    if (this.runtimeSessions) {
      this.runtimeSessions.on("changed", () => void this.publish());
      await this.runtimeSessions.initialize();
      this.runtimeSessions.setHostPermissionModes(this.config.runtimePermissionModes);
    }
    await this.runtimeHandoffs?.initialize();
    await this.connect();
    if (!this.config.devices.some((device) => (
      !device.revokedAt && (Boolean(device.pairedAt) || device.expiresAt > Date.now())
    ))) {
      await this.createPairing();
    }
  }

  async snapshot(): Promise<DesktopControlSnapshot> {
    if (!this.config) throw new Error("Desktop controller is not initialized");
    const currentPairing = this.currentPairingDeviceId
      ? this.config.devices.find((device) => device.deviceId === this.currentPairingDeviceId && !device.revokedAt)
      : undefined;
    const runtimes = this.desktopRuntimes();
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
          "evidence.v1",
          "evidence.details.v1",
          "artifact.preview.v1",
          "artifact.transfer.v1",
          "artifact.text-preview.v1",
          "workspace.upload.v1",
          "claude.native-relay.v1",
          "permission.policy.v1",
          "permission.runtime-defaults.v1",
          "directory.browse.v1",
          "runtime.adapter.v1",
          "session.visibility.v1",
          "session.commands.v1",
          "session.command.v1",
          ...(runtimes.some(runtime => runtime.id === "claude-desktop" && runtime.capabilities.includes("session.rewind")) ? ["session.rewind.v1" as const] : []),
          ...(this.conversationState ? ["session.rename.v1" as const] : []),
          "subagent.stop.v1",
          "turn.queue.steer.v1",
          "turn.queue.cancel.v1",
          "plugin.magpie-quota.v1",
          ...(this.runtimeHandoffs ? ["runtime.handoff.v1" as const] : []),
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
      permissions: [...this.claudePermissions(), ...(this.runtimeSessions?.listPermissions() ?? [])]
        .sort((left, right) => left.createdAt - right.createdAt),
      latestSeq: this.eventLog.latestSeq(),
      connection: this.connection,
      launchAtLogin: this.config.launchAtLogin,
      managedDesktopEnabled: this.config.managedDesktopEnabled,
      claudeDesktop: await this.claudeDesktop.status(),
      desktopApps: await this.desktopAppStatuses(),
      ...(this.inspectorStatus ? { claudeInspector: this.inspectorStatus } : {}),
      ...(currentPairing ? {
        pairingUrl: buildPairingUrl(this.pairingBaseUrl, pairingForDevice(this.config, currentPairing)),
        pairingExpiresAt: currentPairing.expiresAt,
      } : {}),
    };
  }

  async createPairing(): Promise<DesktopControlSnapshot> {
    if (!this.config) throw new Error("Desktop controller is not initialized");
    const created = await BridgeCrypto.createDevicePairing({
      hostId: this.config.hostDeviceId,
      pairingEpoch: this.config.pairingEpoch,
      roomId: this.config.roomId,
      relayUrl: this.config.relayUrl,
      desktopName: this.config.desktopName,
      serviceOrigin: this.config.serviceOrigin,
      relayEndpoints: this.config.relayEndpoints,
      activeEndpoint: this.config.activeEndpoint,
      iceServers: this.config.iceServers,
    });
    const device: LoadedDeviceConfig = {
      deviceId: created.pairing.deviceId,
      name: "手机 Bridge",
      platform: "unknown",
      secret: created.pairing.secret,
      createdAt: created.pairing.createdAt,
      expiresAt: created.pairing.expiresAt,
    };
    this.config.devices = [
      device,
      ...this.config.devices.filter((candidate) => candidate.pairedAt || candidate.expiresAt > Date.now()),
    ];
    this.currentPairingDeviceId = device.deviceId;
    this.deviceCryptos.set(device.deviceId, created.desktopCrypto.withSenderDevice(this.config.hostDeviceId));
    await this.repository.save(this.config);
    this.registerPendingDevices();
    return this.publish();
  }

  async setRelayUrl(value: string): Promise<DesktopControlSnapshot> {
    if (!this.config || !this.hostCrypto) throw new Error("Desktop controller is not initialized");
    const url = normalizeRelayUrl(value);
    this.config.relayUrlOverride = url;
    this.config.relayUrl = url;
    this.config.serviceOrigin = relayServiceOrigin(url);
    this.config.relayEndpoints = [bridgeEndpoint(url, 0, "manual")];
    this.config.activeEndpoint = "manual";
    this.hostCrypto = cryptoWithRelayEndpoint(this.hostCrypto, url);
    for (const [deviceId, crypto] of this.deviceCryptos) {
      this.deviceCryptos.set(deviceId, cryptoWithRelayEndpoint(crypto, url));
    }
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

  async desktopAppStatuses(force = false): Promise<BridgeDesktopAppStatus[]> {
    const entries = [...(this.desktopAppControls?.entries() ?? [])];
    if (!entries.some(([id]) => id === "claude-desktop")) {
      entries.unshift(["claude-desktop", this.claudeDesktop]);
    }
    return Promise.all(entries.map(async ([id, lifecycle]) => {
      try {
        const status = await lifecycle.status(force);
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
    const lifecycle = this.desktopAppControls?.get(runtimeId)
      ?? (runtimeId === "claude-desktop" ? this.claudeDesktop : undefined);
    if (!lifecycle) throw new Error("未知 Desktop 应用");
    await lifecycle.launch();
    const snapshot = await this.publish();
    await this.broadcast({ kind: "snapshot", snapshot });
    return snapshot;
  }

  async quitDesktopApp(runtimeId: BridgeDesktopRuntimeId): Promise<DesktopControlSnapshot> {
    const lifecycle = this.desktopAppControls?.get(runtimeId)
      ?? (runtimeId === "claude-desktop" ? this.claudeDesktop : undefined);
    if (!lifecycle) throw new Error("未知 Desktop 应用");
    await lifecycle.quit();
    const snapshot = await this.publish();
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
        devices: this.config.devices.filter((device) => !device.revokedAt).length,
        pendingPermissions: this.claudePermissions().length + (this.runtimeSessions?.listPermissions().length ?? 0),
      },
      latestEventSeq: this.eventLog.latestSeq(),
    };
  }

  async close(): Promise<void> {
    this.uploads.close();
    this.socket?.close();
    await this.runtimeHandoffs?.close();
    await this.runtimeSessions?.close();
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
    await this.runtimeSessions?.refresh();
    await this.connect();
  }

  async refreshRuntime(): Promise<void> {
    await this.broker.refreshRuntime();
    await this.runtimeSessions?.refresh();
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
    return [claudeRuntime, ...(this.runtimeSessions?.runtimes() ?? [])];
  }

  private allProjects() {
    const visibleProjectIds = new Set(this.allSessions().map((session) => session.projectId));
    return [...this.broker.listProjects(), ...(this.runtimeSessions?.listProjects() ?? [])]
      .filter((project) => visibleProjectIds.has(project.projectId))
      .sort((left, right) => right.lastActivityAt - left.lastActivityAt || left.projectId.localeCompare(right.projectId));
  }

  private applySessionVisibility(sessions: BridgeSessionInfo[]): BridgeSessionInfo[] {
    return sessions
      .filter((session) => session.transport === "claude-desktop-native" || this.sessionVisibility.get(session.sessionId)?.visibility !== "deleted")
      .map((session) => {
        if (session.transport === "claude-desktop-native") return session;
        const entry = this.sessionVisibility.get(session.sessionId);
        return entry?.visibility === "archived" ? { ...session, archivedAt: entry.updatedAt } : session;
      });
  }

  private allSessions(): BridgeSessionInfo[] {
    const priority = (state: BridgeSessionInfo["turnState"]): number => (
      state === "waiting" ? 3 : state === "running" ? 2 : state === "queued" ? 1 : 0
    );
    const sessions = [...this.broker.listSessions(), ...(this.runtimeSessions?.listSessions() ?? [])];
    const enriched = (this.runtimeHandoffs?.enrichSessions(sessions) ?? sessions)
      .sort((left, right) => (
        priority(right.turnState) - priority(left.turnState)
        || right.lastActivityAt - left.lastActivityAt
        || left.sessionId.localeCompare(right.sessionId)
      ));
    return this.applySessionVisibility(enriched);
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

  /**
  * Routing must follow the session id's runtime ownership, not cache
   * membership: an external-runtime id that is momentarily unknown to the
   * runtime broker (e.g. a just-created session still invisible to the
   * native runtime) must never fall through to the Claude broker, where it
   * would surface as a misleading cross-runtime "Session not found".
   */
  private routesToExternalRuntime(sessionId: string): boolean {
    return Boolean(this.runtimeSessions) && parseRuntimeSessionId(sessionId) !== undefined;
  }

  private setSessionVisibility(sessionId: string, visibility: SessionVisibility | null): void {
    if (visibility) {
      this.sessionVisibility.set(sessionId, { visibility, updatedAt: Date.now() });
    } else {
      this.sessionVisibility.delete(sessionId);
    }
    this.conversationState?.setSessionVisibility(sessionId, visibility);
  }

  private async connect(): Promise<void> {
    if (!this.config || !this.hostCrypto) return;
    const localConnectUrl = !this.config.relayUrlOverride && relayPathForUrl(this.relayConnectUrl) === "lan-relay"
      ? this.relayConnectUrl
      : undefined;
    const candidateEndpoints = this.config.relayEndpoints
      .filter((endpoint): endpoint is BridgeEndpoint & {
        kind: "public-relay" | "lan-relay";
      } => endpoint.kind !== "direct")
      .map((endpoint) => ({
        endpoint,
        connectUrl: endpoint.kind === "lan-relay" && localConnectUrl
          ? localConnectUrl
          : endpoint.url,
      }));
    const candidates: BridgeTransportCandidate[] = candidateEndpoints.map(({ endpoint, connectUrl }) => ({
      id: endpoint.id,
      path: endpoint.kind,
      endpoint: connectUrl,
      priority: endpoint.priority,
      create: () => new RelayTransport({
        crypto: cryptoWithRelayEndpoint(this.hostCrypto!, connectUrl),
        role: "desktop",
        createRoom: true,
        reconnect: false,
        path: endpoint.kind,
        resolveCrypto: (envelope) => this.deviceCryptos.get(envelope.fromDeviceId),
      }),
    }));
    const relay = new TransportRouter(candidates);
    const socket: BridgeTransport = this.RTCPeerConnectionImpl
      ? new WebRtcTransport({
          relay,
          crypto: this.hostCrypto,
          role: "desktop",
          RTCPeerConnectionImpl: this.RTCPeerConnectionImpl,
          iceServers: bridgeIceServers(this.config.iceServers),
          resolveCrypto: (envelope) => this.deviceCryptos.get(envelope.fromDeviceId),
          resolvePeerCrypto: (deviceId) => this.deviceCryptos.get(deviceId),
        })
      : relay;
    this.socket = socket;
    socket.onState((connection) => {
      this.connection = connection;
      if (connection === "connected") {
        this.lastSeenAt = Date.now();
        const active = candidateEndpoints.find((candidate) => candidate.connectUrl === socket.endpoint);
        if (active && this.config && this.config.activeEndpoint !== active.endpoint.id) {
          this.config.activeEndpoint = active.endpoint.id;
          this.config.relayUrl = active.endpoint.url;
          this.config.migratedAt = Date.now();
          void this.repository.save(this.config);
        }
        this.registerPendingDevices();
        void this.checkRelayHealth(socket.endpoint);
      } else if (connection === "closed" || connection === "reconnecting") {
        this.relayHealthy = false;
      }
      this.queuePublish();
    });
    socket.onMetrics((metrics) => {
      this.transportMetrics = metrics;
      this.queuePublish();
    });
    socket.onFrame((frame) => {
      if (frame.type !== "ready" && (frame.type !== "presence" || frame.role !== "mobile")) return;
      if (frame.type === "ready") {
        this.onlineDevices.clear();
        for (const device of frame.onlineDevices) {
          if (device.role !== "mobile") continue;
          if (this.acceptsDevice(device.deviceId)) {
            this.onlineDevices.add(device.deviceId);
            if (this.isPairedDevice(device.deviceId)) void this.rememberDevice(device.deviceId);
          } else {
            this.rejectUnknownDevice(device.deviceId);
          }
        }
        this.registerPendingDevices();
      }
      if (frame.type === "presence" && frame.role === "mobile") {
        if (frame.online) {
          if (!this.acceptsDevice(frame.deviceId)) {
            this.rejectUnknownDevice(frame.deviceId);
            this.queuePublish();
            return;
          }
          this.onlineDevices.add(frame.deviceId);
          if (this.isPairedDevice(frame.deviceId)) void this.rememberDevice(frame.deviceId);
        } else {
          this.onlineDevices.delete(frame.deviceId);
          if (this.isPairedDevice(frame.deviceId)) void this.rememberDevice(frame.deviceId);
        }
      }
      this.queuePublish();
    });
    socket.onMessage((message, encrypted) => {
      void this.receiveMessage(message, encrypted);
    });
    socket.connect();
  }

  private async checkRelayHealth(endpoint: string): Promise<void> {
    try {
      const response = await fetch(relayReadyUrl(endpoint), {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(4_000),
      });
      if (this.socket?.endpoint !== endpoint) return;
      this.relayHealthy = response.ok;
    } catch {
      if (this.socket?.endpoint !== endpoint) return;
      this.relayHealthy = false;
    }
    await this.publish();
  }

  private async receiveMessage(message: DecryptedEnvelope, encrypted: EncryptedEnvelope): Promise<void> {
    if (message.header.from !== "mobile" || message.payload.kind !== "request") {
      this.socket?.ack([encrypted.id]);
      return;
    }
    await this.rememberDevice(message.header.fromDeviceId, message.payload.params);
    const cached = this.responseCache.get(message.payload.requestId);
    if (cached) {
      await this.sendToDevice(cached, message.header.fromDeviceId);
      this.socket?.ack([encrypted.id]);
      return;
    }
    let response: BridgeResponse;
    try {
      const result = await this.handleRequest(message.payload, "mobile", message.header.fromDeviceId);
      response = { kind: "response", requestId: message.payload.requestId, ok: true, result };
    } catch (error) {
      response = errorResponse(message.payload.requestId, error);
    }
    if (
      message.payload.method !== "artifact.preview" &&
      message.payload.method !== "artifact.transfer.read"
    ) this.cacheResponse(response);
    const temporaryResponse = message.payload.method !== "turn.start" && message.payload.method !== "turn.steer";
    await this.sendToDevice(
      response,
      message.header.fromDeviceId,
      message.payload.method.startsWith("artifact.") ? ARTIFACT_TRANSFER_TTL_MS : undefined,
      temporaryResponse,
    ).catch(() => undefined);
    this.socket?.ack([encrypted.id]);
    if (
      message.payload.method === "device.revoke" &&
      response.ok &&
      stringParam(message.payload.params, "deviceId") === message.header.fromDeviceId
    ) {
      setTimeout(() => void this.revokeDevice(message.header.fromDeviceId), 250);
    }
  }

  private async handleRequest(
    request: BridgeRequest,
    origin: "desktop" | "mobile",
    sourceDeviceId?: string,
  ): Promise<unknown> {
    const params = request.params;
    if (request.method === "claude.desktop.status") {
      return { claudeDesktop: await this.claudeDesktop.status(true) };
    }
    if (request.method === "claude.desktop.launch") {
      return { claudeDesktop: (await this.launchClaudeDesktop()).claudeDesktop };
    }
    if (request.method === "claude.desktop.quit") {
      return { claudeDesktop: (await this.quitClaudeDesktop()).claudeDesktop };
    }
    if (request.method === "desktop.app.status") {
      return { desktopApps: await this.desktopAppStatuses(true) };
    }
    if (request.method === "desktop.app.launch") {
      const runtimeId = runtimeIdParam(params, "runtimeId");
      if (!runtimeId) throw new Error("desktop.app.launch 缺少 runtimeId");
      await this.launchDesktopApp(runtimeId);
      return { desktopApps: await this.desktopAppStatuses(true) };
    }
    if (request.method === "desktop.app.quit") {
      const runtimeId = runtimeIdParam(params, "runtimeId");
      if (!runtimeId) throw new Error("desktop.app.quit 缺少 runtimeId");
      await this.quitDesktopApp(runtimeId);
      return { desktopApps: await this.desktopAppStatuses(true) };
    }
    if (request.method === "snapshot.get") {
      // Trigger native session discovery asynchronously so snapshot.get returns
      // immediately over the relay (<50ms) instead of blocking for 2-3s.
      const now = Date.now();
      if (now - this.lastDiscoveryRefreshAt >= DISCOVERY_REFRESH_MIN_INTERVAL_MS) {
        this.lastDiscoveryRefreshAt = now;
        void this.runtimeSessions?.refreshDiscoveredSessions().catch(() => undefined);
      }
      return { snapshot: await this.snapshot() };
    }
    if (request.method === "runtime.list") return { runtimes: this.desktopRuntimes() };
    if (request.method === "runtime.refresh") {
      const runtimeId = runtimeIdParam(params, "runtimeId");
      if (!runtimeId || runtimeId === "claude-desktop") await this.broker.refreshRuntime();
      if (!runtimeId || runtimeId !== "claude-desktop") await this.runtimeSessions?.refresh(runtimeId);
      await this.publish();
      return { runtime: this.broker.runtimeStatus(), runtimes: this.desktopRuntimes() };
    }
    if (request.method === "project.list") return { projects: this.allProjects() };
    if (request.method === "directory.list") {
      if (params.path !== undefined && (typeof params.path !== "string" || !params.path.trim())) throw new Error("path must be a non-empty string");
      const path = await accessibleDirectory(typeof params.path === "string" ? params.path : homedir());
      const listing: BridgeDirectoryListing = {
        path,
        ...(dirname(path) !== path ? { parentPath: dirname(path) } : {}),
        directories: (await readdir(path, { withFileTypes: true }))
          .filter(entry => entry.isDirectory())
          .map(entry => ({ name: entry.name, path: join(path, entry.name) }))
          .sort((left, right) => left.name.localeCompare(right.name)),
        recentPaths: [...new Set([...this.allSessions(), ...this.allProjects()].map(item => item.cwd).filter(isAbsolute))],
      };
      return { listing };
    }
    if (
      request.method === "provider.list" || request.method === "provider.refresh" ||
      request.method === "conversation.route.get" || request.method === "conversation.switch.preview" ||
      request.method === "conversation.switch.commit" || request.method === "conversation.switch.cancel" ||
      request.method === "handoff.get"
    ) {
      throw new BridgeRequestError("UNSUPPORTED", "Claude Desktop 原生会话不支持 Bridge 独立提供方或执行通道接力。");
    }
    if (request.method === "runtime.handoff.commit" || request.method === "runtime.handoff.confirm") {
      if (!this.runtimeHandoffs) throw new Error("Runtime handoff is unavailable");
      const handoff = this.runtimeHandoffs.get(stringParam(params, "handoffId")!);
      if (handoff.sourceRuntimeId === "claude-desktop" || handoff.targetRuntimeId === "claude-desktop") {
        throw new BridgeRequestError("UNSUPPORTED", "Claude Desktop 原生会话不支持 Bridge 跨运行时接力。");
      }
    }
    if (request.method === "runtime.goal.pause" || request.method === "runtime.goal.resume") {
      if (!parseRuntimeSessionId(stringParam(params, "sessionId")!)) {
        throw new BridgeRequestError("UNSUPPORTED", "Claude Desktop 原生会话不支持 Bridge 目标续跑。");
      }
    }
    if (request.method === "runtime.handoff.preview") {
      if (!parseRuntimeSessionId(stringParam(params, "sessionId")!) || runtimeIdParam(params, "targetRuntimeId") === "claude-desktop") {
        throw new BridgeRequestError("UNSUPPORTED", "Claude Desktop 原生会话不支持 Bridge 跨运行时接力。");
      }
      if (!this.runtimeHandoffs) throw new Error("Runtime handoff is unavailable");
      const targetRuntimeId = runtimeIdParam(params, "targetRuntimeId");
      if (!targetRuntimeId) throw new Error("targetRuntimeId is required");
      return {
        preview: await this.runtimeHandoffs.preview({
          sessionId: stringParam(params, "sessionId")!,
          targetRuntimeId,
        }),
      };
    }
    if (request.method === "runtime.handoff.commit") {
      if (!this.runtimeHandoffs) throw new Error("Runtime handoff is unavailable");
      return this.runtimeHandoffs.commit({ handoffId: stringParam(params, "handoffId")! });
    }
    if (request.method === "runtime.handoff.cancel") {
      if (!this.runtimeHandoffs) throw new Error("Runtime handoff is unavailable");
      return this.runtimeHandoffs.cancel(stringParam(params, "handoffId")!);
    }
    if (request.method === "runtime.handoff.get") {
      if (!this.runtimeHandoffs) throw new Error("Runtime handoff is unavailable");
      return { handoff: this.runtimeHandoffs.get(stringParam(params, "handoffId")!) };
    }
    if (request.method === "runtime.handoff.list") {
      if (!this.runtimeHandoffs) throw new Error("Runtime handoff is unavailable");
      return this.runtimeHandoffs.list(stringParam(params, "sessionId")!);
    }
    if (request.method === "runtime.handoff.confirm") {
      if (!this.runtimeHandoffs) throw new Error("Runtime handoff is unavailable");
      return this.runtimeHandoffs.confirm({
        handoffId: stringParam(params, "handoffId")!,
        ...(typeof params.objective === "string" ? { objective: params.objective } : {}),
      });
    }
    if (request.method === "runtime.goal.pause") {
      if (!this.runtimeHandoffs) throw new Error("Runtime handoff is unavailable");
      return this.runtimeHandoffs.pauseGoal(stringParam(params, "sessionId")!);
    }
    if (request.method === "runtime.goal.resume") {
      if (!this.runtimeHandoffs) throw new Error("Runtime handoff is unavailable");
      return this.runtimeHandoffs.resumeGoal(stringParam(params, "sessionId")!);
    }
    if (request.method === "session.list") {
      return {
        sessions: this.listedSessions(
          stringParam(params, "projectId", false),
          stringParam(params, "search", false),
          runtimeIdParam(params, "runtimeId"),
        ),
      };
    }
    if (request.method === "session.open") {
      const sessionId = stringParam(params, "sessionId")!;
      if (this.routesToExternalRuntime(sessionId)) {
        const history = await this.runtimeSessions!.history(sessionId);
        const external = this.runtimeSessions!.session(sessionId);
        if (!external) throw new Error("Session not found");
        return {
          session: external,
          history,
          latestSeq: this.eventLog.latestSeq(),
        };
      }
      await this.broker.refreshDesktopConfiguration(sessionId);
      const session = this.broker.session(sessionId);
      if (!session) throw new Error("Session not found");
      return {
        session,
        history: await this.broker.history(sessionId, undefined, numberParam(params, "limit", 18)),
        latestSeq: this.eventLog.latestSeq(),
      };
    }
    if (request.method === "session.rename") {
      const sessionId = stringParam(params, "sessionId")!;
      const title = stringParam(params, "title")!.trim();
      if (!this.conversationState) throw new Error("Session rename is unavailable");
      const session = this.allSessions().find((candidate) => candidate.sessionId === sessionId);
      if (!session) throw new Error("Session not found");
      if (session.title === title) return { session };
      if (this.routesToExternalRuntime(sessionId)) this.conversationState.setSessionTitle(sessionId, title);
      else await this.broker.rename(sessionId, title);
      const snapshot = await this.publish();
      return { session: snapshot.sessions.find((candidate) => candidate.sessionId === sessionId) };
    }
    if (request.method === "session.create") {
      const runtimeId = runtimeIdParam(params, "runtimeId") ?? "claude-desktop";
      const projectId = params.projectId;
      if (projectId !== undefined && (typeof projectId !== "string" || !projectId.trim())) {
        throw new Error("projectId must be a non-empty string");
      }
      if (runtimeId !== "claude-desktop") {
        if (!this.runtimeSessions) throw new Error("External Desktop runtimes are unavailable");
        return {
          session: await this.runtimeSessions.createSession(
            runtimeId,
            stringParam(params, "cwd")!,
            stringParam(params, "title", false),
            typeof projectId === "string" ? projectId.trim() : undefined,
          ),
        };
      }
      return {
        session: await this.broker.createSession(
          stringParam(params, "cwd")!,
          stringParam(params, "title", false),
          typeof projectId === "string" ? projectId.trim() : undefined,
        ),
      };
    }
    if (request.method === "session.fork") {
      const sessionId = stringParam(params, "sessionId")!;
      if (this.routesToExternalRuntime(sessionId)) {
        throw new Error("当前仅 Claude 会话支持 Fork 分支。");
      }
      return {
        session: await this.broker.forkSession(
          sessionId,
          stringParam(params, "title", false),
        ),
      };
    }
    if (request.method === "session.history") {
      const sessionId = stringParam(params, "sessionId")!;
      if (this.routesToExternalRuntime(sessionId)) {
        return { history: await this.runtimeSessions!.history(sessionId) };
      }
      return {
        history: await this.broker.history(
          sessionId,
          stringParam(params, "cursor", false),
          numberParam(params, "limit", 50),
        ),
      };
    }
    if (request.method === "session.rewind.preview" || request.method === "session.rewind") {
      const sessionId = stringParam(params, "sessionId")!;
      const messageId = stringParam(params, "messageId")!;
      if (this.routesToExternalRuntime(sessionId)) throw new BridgeRequestError("UNSUPPORTED", "当前运行时不支持 Claude 原生回退");
      if (request.method === "session.rewind.preview") return { rewind: await this.broker.previewRewind(sessionId, messageId) };
      const scope = stringParam(params, "scope")!;
      if (scope !== "conversation" && scope !== "files" && scope !== "both") throw new Error("Invalid rewind scope");
      return { rewind: await this.broker.rewindSession(sessionId, messageId, scope), session: this.broker.session(sessionId) };
    }
    if (request.method === "session.commands") {
      const sessionId = stringParam(params, "sessionId")!;
      if (this.routesToExternalRuntime(sessionId)) return { catalog: { sessionId, commands: [] } };
      return { catalog: await this.broker.commands(sessionId) };
    }
    if (request.method === "session.command") {
      const sessionId = stringParam(params, "sessionId")!;
      if (this.routesToExternalRuntime(sessionId)) throw new Error("当前运行时不支持 Claude 命令");
      return { command: await this.broker.runCommand({
        sessionId, text: stringParam(params, "text")!, requestId: request.requestId,
        idempotencyKey: request.idempotencyKey, origin,
        ...(sourceDeviceId ? { sourceDeviceId } : {}),
      }) };
    }
    if (request.method === "session.permissions" || request.method === "session.permissions.configure") {
      throw new BridgeRequestError("UNSUPPORTED", "SDK 权限策略由 Claude Desktop 原生会话管理。");
    }
    if (request.method === "session.configuration") {
      const sessionId = stringParam(params, "sessionId")!;
      if (this.routesToExternalRuntime(sessionId)) {
        return { configuration: await this.runtimeSessions!.configuration(sessionId) };
      }
      const configuration = await this.broker.configuration(sessionId);
      const backgroundTasks = nullableBooleanParam(params, "includeBackgroundTasks") === true
        ? await this.broker.backgroundTaskDetails(sessionId) : undefined;
      return {
        configuration,
        session: backgroundTasks !== undefined
          ? { ...this.broker.session(sessionId)!, backgroundTasks } : this.broker.session(sessionId),
      };
    }
    if (request.method === "session.configure") {
      const sessionId = stringParam(params, "sessionId")!;
      if (this.routesToExternalRuntime(sessionId)) {
        if (!this.runtimeSessions) throw new Error("External Desktop runtimes are unavailable");
        const input: Parameters<RuntimeSessionBroker["configureSession"]>[1] = {};
        if (Object.prototype.hasOwnProperty.call(params, "model")) {
          const model = nullableStringParam(params, "model");
          if (model !== undefined) input.model = model;
        }
        if (Object.prototype.hasOwnProperty.call(params, "provider")) {
          const provider = nullableStringParam(params, "provider");
          if (provider !== undefined) input.provider = provider;
        }
        if (Object.prototype.hasOwnProperty.call(params, "reasoningEffort")) {
          const reasoningEffort = nullableStringParam(params, "reasoningEffort");
          if (reasoningEffort !== undefined) input.reasoningEffort = reasoningEffort;
        } else if (Object.prototype.hasOwnProperty.call(params, "effort")) {
          // Keep older clients usable for native runtimes while Claude keeps its
          // stricter BridgeEffort validation below.
          const reasoningEffort = nullableStringParam(params, "effort");
          if (reasoningEffort !== undefined) input.reasoningEffort = reasoningEffort;
        }
        if (Object.prototype.hasOwnProperty.call(params, "fast")) {
          const fast = nullableBooleanParam(params, "fast");
          if (fast !== undefined) input.fast = fast;
        }
        return {
          configuration: await this.runtimeSessions.configureSession(sessionId, input),
          session: this.runtimeSessions.session(sessionId),
        };
      }
      const input: Parameters<ClaudeDesktopBridge["configureSession"]>[0] = { sessionId };
      if (Object.prototype.hasOwnProperty.call(params, "model")) {
        const model = nullableStringParam(params, "model");
        if (model !== undefined) input.model = model;
      }
      if (Object.prototype.hasOwnProperty.call(params, "effort")) {
        const effort = effortParam(params, "effort");
        if (effort !== undefined) input.effort = effort;
      }
      if (Object.prototype.hasOwnProperty.call(params, "permissionMode")) {
        const mode = stringParam(params, "permissionMode")!;
        if (!["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"].includes(mode)) {
          throw new Error("Invalid native permission mode");
        }
        input.permissionMode = mode as BridgeSDKPermissionMode;
      }
      const configuration = await this.broker.configureSession(input);
      return { configuration, session: this.broker.session(sessionId) };
    }
    if (request.method === "session.desktop.register") {
      throw new BridgeRequestError("UNSUPPORTED", "Claude 会话直接由 Claude Desktop 创建，无需 Bridge 登记。");
    }
    if (request.method === "session.archive") {
      const sessionId = stringParam(params, "sessionId")!;
      const archived = params.archived !== false;
      const all = this.allSessions();
      const session = all.find((candidate) => candidate.sessionId === sessionId);
      if (!session) throw new Error("Session not found");
      const changedAt = Date.now();
      const archivedAt = archived ? changedAt : undefined;
      // Restoring stays on the chosen session so children archived on their own stay archived.
      const targetIds = [
        sessionId,
        ...(archived ? all : [])
          .filter((candidate) => candidate.parentSessionId === sessionId && !candidate.archivedAt)
          .map((candidate) => candidate.sessionId),
      ];
      for (const targetId of targetIds) {
        if (this.routesToExternalRuntime(targetId)) {
          this.setSessionVisibility(targetId, archived ? "archived" : null);
        } else {
          await this.broker.archive(targetId, archived);
        }
        await this.eventLog.append({
          sessionId: targetId,
          origin,
          type: "session.archived",
          data: { sessionId: targetId, archived: archivedAt !== undefined, ...(archivedAt ? { archivedAt } : {}) },
        });
      }
      return {
        session: this.allSessions().find((candidate) => candidate.sessionId === sessionId),
      };
    }
    if (request.method === "session.delete") {
      const sessionId = stringParam(params, "sessionId")!;
      const session = this.allSessions().find((candidate) => candidate.sessionId === sessionId);
      if (!session) throw new Error("Session not found");
      if (session.turnState === "running" || session.turnState === "queued" || session.turnState === "waiting") {
        throw new Error("任务仍在进行中，请先停止再删除会话");
      }
      const pendingHandoff = session.pendingRuntimeHandoff;
      if (pendingHandoff && !["applied", "cancelled", "failed"].includes(pendingHandoff.state)) {
        throw new Error("跨 Desktop 接力尚未完成，请先取消接力再删除会话");
      }
      if (this.routesToExternalRuntime(sessionId)) {
        this.runtimeSessions?.removeSessionRecords(sessionId);
        // External runtimes retain their native records and use a Bridge visibility marker.
        this.setSessionVisibility(sessionId, "deleted");
      } else {
        await this.broker.deleteSession(sessionId);
      }
      await this.eventLog.append({
        sessionId,
        origin,
        type: "session.deleted",
        data: { sessionId },
      });
      return { deleted: true, sessionId };
    }
    if (
      request.method === "session.takeover_desktop" || request.method === "session.return_to_desktop" ||
      request.method === "session.fallback.confirm"
    ) {
      throw new BridgeRequestError("UNSUPPORTED", "Claude 执行始终由 Claude Desktop 原生会话管理，不支持 Bridge 接管或回退执行。");
    }
    if (request.method === "runtime.file.open") {
      const sessionId = stringParam(params, "sessionId")!;
      const filePath = stringParam(params, "path")!;
      if (!this.routesToExternalRuntime(sessionId) || !this.runtimeSessions) {
        throw new Error("该会话不支持打开工作区文件");
      }
      const session = this.runtimeSessions.session(sessionId);
      if (!session) throw new Error("Session not found");
      const root = await realpath(session.cwd);
      const candidate = isAbsolute(filePath) ? filePath : resolve(session.cwd, filePath);
      const target = await realpath(candidate).catch(() => undefined);
      if (!target || (target !== root && !target.startsWith(`${root}${sep}`))) {
        throw new Error("只能打开当前工作区内的文件");
      }
      const error = await shell.openPath(target);
      if (error) throw new Error(error);
      return { opened: true, path: target };
    }
    if (request.method === "message.delivery.resolve") {
      const action = stringParam(params, "action")!;
      if (action !== "confirm" && action !== "retry") throw new Error("Invalid uncertain delivery action");
      const turn = await this.broker.resolveUncertainDelivery(
        stringParam(params, "commandId")!,
        action,
      );
      return { commandId: turn.commandId, state: turn.state };
    }
    if (request.method === "turn.queue.steer" || request.method === "turn.queue.cancel") {
      const sessionId = stringParam(params, "sessionId")!;
      if (this.routesToExternalRuntime(sessionId)) throw new Error("这个会话不支持调整已排队消息");
      const turn = request.method === "turn.queue.cancel"
        ? await this.broker.cancelQueuedTurn(sessionId, stringParam(params, "commandId")!)
        : await this.broker.steerQueuedTurn(sessionId, stringParam(params, "commandId")!);
      return { commandId: turn.commandId, state: turn.state };
    }
    if (request.method === "turn.start" || request.method === "turn.steer") {
      const sessionId = stringParam(params, "sessionId")!;
      const text = stringParam(params, "text", false) ?? "";
      const attachments = attachmentsParam(params);
      if (params.bridgeExecutionRequested !== undefined && typeof params.bridgeExecutionRequested !== "boolean") {
        throw new Error("Invalid bridgeExecutionRequested");
      }
      if (params.bridgeExecutionRequested) {
        throw new BridgeRequestError("UNSUPPORTED", "Claude 执行始终由 Claude Desktop 原生会话管理。");
      }
      if (this.routesToExternalRuntime(sessionId)) {
        if (!text.trim() && attachments.length === 0) throw new Error("Message cannot be empty");
        const turn = await this.runtimeSessions!.startTurn({
          sessionId,
          text,
          commandId: request.idempotencyKey,
          requestId: request.requestId,
          ...(attachments.length ? { attachments } : {}),
          ...(sourceDeviceId ? { sourceDeviceId } : {}),
          ...(request.method === "turn.steer" ? { steer: true } : {}),
        });
        return { commandId: turn.commandId, state: turn.state };
      }
      const input = {
        requestId: request.requestId,
        idempotencyKey: request.idempotencyKey,
        sessionId,
        text,
        attachments,
        origin,
        ...(sourceDeviceId ? { sourceDeviceId } : {}),
      };
      const turn = request.method === "turn.steer"
        ? await this.broker.steerTurn(input)
        : await this.broker.startTurn(input);
      return { commandId: turn.commandId, state: turn.state };
    }
    if (request.method === "turn.interrupt") {
      const sessionId = stringParam(params, "sessionId")!;
      // Stopping a goal-mode session must also pause its goal so the
      // supervisor never fights a user-initiated stop.
      if (this.routesToExternalRuntime(sessionId)) {
        await this.runtimeHandoffs?.pauseGoal(sessionId);
        return { interrupted: await this.runtimeSessions!.interruptTurn(sessionId) };
      }
      return {
        interrupted: await this.broker.interruptTurn(
          sessionId,
          stringParam(params, "commandId", false),
          params.force === true,
        ),
      };
    }
    if (request.method === "subagent.stop") {
      const sessionId = stringParam(params, "sessionId")!;
      if (this.routesToExternalRuntime(sessionId)) throw new Error("这个会话不支持单独停止子代理");
      await this.broker.stopSubagent(sessionId, stringParam(params, "agentId")!);
      return { stopped: true };
    }
    if (request.method === "permission.resolve") {
      const decision = stringParam(params, "decision")!;
      if (!["allow-once", "allow-always", "deny"].includes(decision)) throw new Error("Invalid permission decision");
      const requestId = stringParam(params, "requestId")!;
      // `nativeMode: "full-access"` is the pre-`mode` spelling of bypassPermissions, still sent by older phones.
      const mode = params.nativeMode === "full-access" ? "bypassPermissions" : stringParam(params, "mode", false);
      if (
        (params.nativeMode !== undefined && params.nativeMode !== "full-access") ||
        (mode !== undefined && !["default", "acceptEdits", "bypassPermissions"].includes(mode))
      ) throw new Error("Invalid native permission mode");
      const updatedInput = params.updatedInput && typeof params.updatedInput === "object" && !Array.isArray(params.updatedInput)
        ? params.updatedInput as Record<string, unknown>
        : undefined;
      const externalResolved = !mode && await this.runtimeSessions?.resolvePermission(
        requestId,
        decision as "allow-once" | "allow-always" | "deny",
        updatedInput,
      );
      if (externalResolved) return { resolved: true };
      const resolver = origin === "mobile"
        ? {
            deviceId: sourceDeviceId ?? "mobile",
            name: this.config?.devices.find((device) => device.deviceId === sourceDeviceId)?.name ?? "手机 Bridge",
          }
        : {
            deviceId: this.config?.hostDeviceId ?? "desktop",
            name: this.config?.desktopName ?? "电脑端 Bridge",
          };
      const resolved = await this.broker.resolvePermission(
        requestId,
        decision as "allow-once" | "allow-always" | "deny",
        stringParam(params, "message", false),
        updatedInput,
        resolver,
        mode as BridgeNativePermissionMode | undefined,
      );
      if (!resolved) {
        throw new BridgeRequestError(
          "ALREADY_RESOLVED",
          "这项授权已由其他设备处理。",
        );
      }
      return {
        resolved: true,
      };
    }
    if (request.method === "permission.policy.configure") {
      const scope = stringParam(params, "scope")!;
      if (scope !== "host" && scope !== "session") throw new Error("Invalid permission policy scope");
      const mode = permissionModeParam(params, "mode");
      const sessionId = stringParam(params, "sessionId", false);
      const explicitRuntimeId = runtimeIdParam(params, "runtimeId");
      const sessionRuntimeId = sessionId ? parseRuntimeSessionId(sessionId)?.runtimeId ?? "claude-desktop" : undefined;
      if (explicitRuntimeId && sessionRuntimeId && explicitRuntimeId !== sessionRuntimeId) {
        throw new Error("Permission runtimeId does not match the session runtime");
      }
      const runtimeId = explicitRuntimeId ?? sessionRuntimeId ?? "claude-desktop";
      if (runtimeId === "claude-desktop") {
        throw new BridgeRequestError("UNSUPPORTED", "Claude 权限由 Claude Desktop 原生会话管理。");
      }
      const actor = origin === "mobile"
        ? {
            deviceId: sourceDeviceId ?? "mobile",
            name: this.config?.devices.find((device) => device.deviceId === sourceDeviceId)?.name ?? "手机 Bridge",
          }
        : {
            deviceId: this.config?.hostDeviceId ?? "desktop",
            name: this.config?.desktopName ?? "电脑端 Bridge",
          };
      if (scope === "host") {
        if (!mode) throw new Error("Host permission mode is required");
        if (!this.config) throw new Error("Desktop controller is not initialized");
        // Per-runtime host default: a Codex full-access toggle must not
        // auto-approve Hermes or Claude sessions on this machine.
        if (!this.runtimeSessions) throw new Error("External Desktop runtimes are unavailable");
        this.config.runtimePermissionModes = {
          ...this.config.runtimePermissionModes,
          [runtimeId]: mode,
        };
        await this.repository.save(this.config);
        await this.eventLog.append({
          ...(sessionId ? { sessionId } : {}),
          origin,
          type: "permission.policy.changed",
          data: {
            scope,
            mode,
            effectiveMode: mode,
            source: "host",
            runtimeId,
            changedByDeviceId: actor.deviceId,
            changedByName: actor.name,
          },
        });
        const resolvedPending = await this.runtimeSessions.setHostPermissionMode(runtimeId, mode);
        const configuration = sessionId && this.runtimeSessions.session(sessionId)
          ? await this.runtimeSessions.configuration(sessionId)
          : undefined;
        await this.publish();
        return {
          resolvedPending,
          runtimeId,
          defaultPermissionMode: mode,
          runtimePermissionMode: mode,
          ...(configuration ? { configuration } : {}),
        };
      }
      if (!sessionId) throw new Error("sessionId is required");
      if (mode === undefined) throw new Error("mode is required");
      if (this.routesToExternalRuntime(sessionId)) {
        if (!this.runtimeSessions) throw new Error("External Desktop runtimes are unavailable");
        const configured = await this.runtimeSessions.configurePermissionPolicy(sessionId, mode);
        await this.eventLog.append({
          sessionId,
          origin,
          type: "permission.policy.changed",
          data: {
            scope,
            mode: mode ?? "inherit",
            effectiveMode: configured.configuration.permissionPolicy?.effectiveMode ?? "standard",
            source: configured.configuration.permissionPolicy?.source ?? "host",
            runtimeId,
            changedByDeviceId: actor.deviceId,
            changedByName: actor.name,
          },
        });
        return configured;
      }
      throw new BridgeRequestError("UNSUPPORTED", "当前会话不支持 Bridge 权限策略。");
    }
    if (request.method === "events.resume") {
      const afterSeq = numberParam(params, "afterSeq", 0);
      const bootstrap = params.bootstrap === true && afterSeq === 0;
      if (bootstrap) {
        const latestSeq = this.eventLog.latestSeq();
        return {
          events: [],
          latestSeq,
          nextSeq: latestSeq,
          hasMore: false,
        };
      }
      const limit = numberParam(params, "limit", 250);
      const rawEvents = this.eventLog.replay(
        afterSeq,
        limit,
        stringParam(params, "sessionId", false),
      );
      const latestSeq = this.eventLog.latestSeq();
      const events: BridgeEvent[] = [];
      let scannedSeq = afterSeq;
      let bytes = 0;
      let truncatedByBytes = false;
      const maxPageBytes = 40 * 1024;
      for (const record of rawEvents) {
        const event = summarizeEvidenceEvent(record);
        if (
          event.type === "session.desktop-registration" ||
          event.type === "evidence.started" ||
          event.type === "evidence.updated"
        ) {
          scannedSeq = event.seq;
          continue;
        }
        const serializedLength = Buffer.byteLength(JSON.stringify(event), "utf8");
        if (events.length > 0 && bytes + serializedLength > maxPageBytes) {
          truncatedByBytes = true;
          break;
        }
        events.push(event);
        bytes += serializedLength;
        scannedSeq = event.seq;
      }
      const reachedEnd = !truncatedByBytes && rawEvents.length < Math.max(1, Math.min(limit, 1_000));
      const nextSeq = reachedEnd ? Math.max(scannedSeq, latestSeq) : scannedSeq;
      return {
        events,
        latestSeq,
        nextSeq,
        hasMore: nextSeq < latestSeq,
      };
    }
    if (request.method === "evidence.list") {
      const sessionId = stringParam(params, "sessionId")!;
      if (this.routesToExternalRuntime(sessionId)) {
        return {
          evidence: {
            sessionId,
            items: [],
            hasMore: false,
          },
        };
      }
      if (!this.broker.session(sessionId)) throw new Error("Session not found");
      return {
        evidence: this.evidence.list(
          sessionId,
          stringParam(params, "cursor", false),
          numberParam(params, "limit", 30),
        ),
      };
    }
    if (request.method === "evidence.get") {
      const evidence = this.evidence.get(stringParam(params, "evidenceId")!);
      if (!evidence) throw new Error("Evidence not found");
      return { evidence: evidenceSummary(evidence) };
    }
    if (request.method === "evidence.details") {
      const kind = stringParam(params, "kind");
      if (kind !== "tools" && kind !== "artifacts") throw new Error("Unknown evidence detail kind");
      const page = this.evidence.details(
        stringParam(params, "evidenceId")!, kind,
        stringParam(params, "cursor", false), numberParam(params, "limit", 30),
      );
      if (!page) throw new Error("Evidence not found");
      return { page };
    }
    if (request.method.startsWith("file.upload.")) {
      const owner = sourceDeviceId ?? "desktop";
      if (request.method === "file.upload.open") {
        const sessionId = stringParam(params, "sessionId")!;
        const session = this.allSessions().find((candidate) => candidate.sessionId === sessionId);
        if (!session) throw new Error("Session not found");
        if (session.allowedActions?.canSend === false) throw new Error("当前会话不允许上传文件");
        return { upload: await this.uploads.open({
          owner,
          sessionId,
          cwd: session.cwd,
          name: stringParam(params, "name")!,
          size: integerParam(params, "size"),
          sha256: stringParam(params, "sha256")!,
        }) };
      }
      const uploadId = stringParam(params, "uploadId")!;
      if (request.method === "file.upload.write") {
        return { received: this.uploads.write(uploadId, integerParam(params, "index"), stringParam(params, "data", false) ?? "", owner) };
      }
      if (request.method === "file.upload.commit") return { file: await this.uploads.commit(uploadId, owner) };
      return { cancelled: this.uploads.cancel(uploadId, owner) };
    }
    if (request.method === "artifact.preview") {
      return {
        preview: await this.evidence.preview(stringParam(params, "artifactId")!),
      };
    }
    if (request.method === "artifact.transfer.open") {
      const textPreview = params.purpose === "text-preview";
      if (params.nativeImage !== undefined) {
        if (!isBridgeNativeImageRef(params.nativeImage)) throw new Error("Invalid native image reference");
        const image = await this.broker.readNativeImage(stringParam(params, "sessionId")!, params.nativeImage);
        return { transfer: this.evidence.openBytesTransfer(image, sourceDeviceId ?? "desktop") };
      }
      const artifactId = stringParam(params, "artifactId", false);
      if (artifactId) {
        return {
          transfer: await this.evidence.openTransfer(
            artifactId,
            sourceDeviceId ?? "desktop",
            textPreview,
          ),
        };
      }
      const sessionId = stringParam(params, "sessionId")!;
      const filePath = stringParam(params, "path")!;
      const session = this.allSessions().find((candidate) => candidate.sessionId === sessionId);
      if (!session) throw new Error("Session not found");
      return {
        transfer: await this.evidence.openFileTransfer(
          session.cwd,
          filePath,
          sourceDeviceId ?? "desktop",
          textPreview,
          this.broker.executionCwd(sessionId),
        ),
      };
    }
    if (request.method === "artifact.transfer.read") {
      return {
        chunk: this.evidence.readTransfer(
          stringParam(params, "transferId")!,
          integerParam(params, "index"),
          sourceDeviceId ?? "desktop",
        ),
      };
    }
    if (request.method === "artifact.transfer.close") {
      return {
        closed: this.evidence.closeTransfer(
          stringParam(params, "transferId")!,
          sourceDeviceId ?? "desktop",
        ),
      };
    }
    if (request.method === "device.revoke") {
      const deviceId = stringParam(params, "deviceId")!;
      if (origin === "mobile" && sourceDeviceId !== deviceId) throw new Error("A phone can only revoke itself");
      return { scheduled: true, deviceId };
    }
    if (request.method === MAGPIE_QUOTA_METHOD) return this.magpieQuota.handle(request);
    throw new Error("Unsupported request method");
  }

  private async sendToDevice(
    payload: BridgePayload,
    deviceId: string,
    ttlMs?: number,
    temporary = false,
  ): Promise<string> {
    if (!this.socket || this.connection !== "connected") throw new Error("Bridge is not connected");
    const crypto = this.deviceCryptos.get(deviceId);
    if (!crypto) throw new Error("Device key is unavailable");
    return this.socket.send(payload, "mobile", {
      toDeviceId: deviceId,
      crypto,
      ...(ttlMs !== undefined ? { ttlMs } : {}),
      ...(temporary ? { temporary: true } : {}),
    });
  }

  private async broadcast(payload: BridgePayload, temporary = false): Promise<void> {
    const devices = this.config?.devices.filter((device) => device.pairedAt && !device.revokedAt) ?? [];
    await Promise.allSettled(devices.map((device) => this.sendToDevice(payload, device.deviceId, undefined, temporary)));
  }

  private registerPendingDevices(): void {
    if (!this.config || !this.socket || this.connection !== "connected") return;
    const now = Date.now();
    for (const device of this.config.devices) {
      if (device.revokedAt) {
        try {
          this.socket.revokeDevice(device.deviceId);
        } catch {
          // Revocation is replayed whenever another endpoint becomes active.
        }
        continue;
      }
      const crypto = this.deviceCryptos.get(device.deviceId);
      if (!crypto) continue;
      try {
        if (device.pairedAt && this.socket.path === "public-relay") {
          this.socket.registerDevice(
            device.deviceId,
            crypto.identity.authToken,
            now + 7 * 24 * 60 * 60 * 1_000,
            { migrate: true, pairedAt: device.pairedAt },
          );
        } else if (!device.pairedAt && device.expiresAt > now) {
          this.socket.registerDevice(device.deviceId, crypto.identity.authToken, device.expiresAt);
        }
      } catch {
        // Registration will be retried on the next reconnect.
      }
    }
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
    const device = this.config.devices.find((candidate) => candidate.deviceId === deviceId && !candidate.revokedAt);
    if (!device) return;
    const now = Date.now();
    device.pairedAt ??= now;
    device.lastSeenAt = now;
    if (this.socket?.path === "public-relay") device.publicRelayClaimedAt ??= now;
    const client = metadata?.client;
    if (client && typeof client === "object") {
      const value = client as Record<string, unknown>;
      if (typeof value.name === "string" && value.name.trim()) device.name = value.name.trim().slice(0, 80);
      if (value.platform === "android" || value.platform === "ios" || value.platform === "web") {
        device.platform = value.platform;
      }
    }
    if (this.currentPairingDeviceId === deviceId) this.currentPairingDeviceId = undefined;
    await this.repository.save(this.config);
  }

  private deviceSnapshots(): BridgeDeviceInfo[] {
    return (this.config?.devices ?? [])
      .filter((device) => device.pairedAt || device.expiresAt > Date.now())
      .map((device) => ({
        deviceId: device.deviceId,
        name: device.name,
        platform: device.platform,
        online: this.onlineDevices.has(device.deviceId),
        createdAt: device.pairedAt ?? device.createdAt,
        ...(device.lastSeenAt !== undefined ? { lastSeenAt: device.lastSeenAt } : {}),
        ...(device.revokedAt !== undefined ? { revokedAt: device.revokedAt } : {}),
      }))
      .sort((left, right) => Number(right.online) - Number(left.online) || right.createdAt - left.createdAt);
  }

  private cacheResponse(response: BridgeResponse): void {
    this.responseCache.set(response.requestId, response);
    while (this.responseCache.size > 500) {
      const oldest = this.responseCache.keys().next().value as string | undefined;
      if (oldest) this.responseCache.delete(oldest);
    }
  }

  /**
   * Event-driven republish, trailing-debounced: busy streams and startup
   * storms append dozens of events per second, and rebuilding the full
   * snapshot per event used to stall the main process. Live updates still
   * travel per-event over the broadcast channel; this only rebuilds the
   * snapshot, and 120ms is invisible next to relay latency.
   */
  private queuePublish(): void {
    if (this.publishTimer) return;
    this.publishTimer = setTimeout(() => {
      this.publishTimer = undefined;
      void this.publish();
    }, 120);
  }

  private async publish(): Promise<DesktopControlSnapshot> {
    const snapshot = await this.snapshot();
    this.emit("snapshot", snapshot);
    // Catalog metadata and global runtime changes need a complete snapshot.
    // Session runtime changes use the existing coalesced event channel.
    const sessionKey = JSON.stringify({
      defaultPermissionMode: snapshot.host?.defaultPermissionMode,
      runtimeDefaults: snapshot.runtimes?.map(runtime => [runtime.id, runtime.defaultPermissionMode]),
      detection: snapshot.runtime?.detection,
      runtime: [snapshot.runtime?.state, snapshot.runtime?.activeTurns, snapshot.runtime?.maxParallelTurns],
      providers: snapshot.providers,
      magpie: snapshot.magpie,
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
      await Promise.all(snapshot.sessions.map((session) => {
        if (previousSessions.get(session.sessionId) === sessions.get(session.sessionId)) return;
        return this.eventLog.append({
          sessionId: session.sessionId,
          itemId: "session:subagent-activity",
          origin: "system",
          type: "runtime.updated",
          data: { replaceSession: true, session },
        });
      }));
    }
    return snapshot;
  }
}
