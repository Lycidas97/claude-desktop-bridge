import { diag, diagnostics } from "../app/diag.js";
import { createHash } from "node:crypto";
import {
  ARTIFACT_TRANSFER_TTL_MS,
  BridgeCrypto,
  PAIRING_SCHEMA_VERSION,
  PAYLOAD_DEFLATE_CAPABILITY,
  PROTOCOL_VERSION,
  RelayTransport,
  TransportRouter,
  WebRtcTransport,
  bridgeEndpoint,
  bridgeIceServers,
  cryptoWithRelayEndpoint,
  normalizeRelayUrl,
  relayPathForUrl,
  relayReadyUrl,
  relayServiceOrigin,
  type BridgeDeviceInfo,
  type BridgeEndpoint,
  type BridgePayload,
  type BridgeRequest,
  type BridgeResponse,
  type BridgeTransport,
  type BridgeTransportCandidate,
  type BridgeTransportMetrics,
  type DecryptedEnvelope,
  type EncryptedEnvelope,
  type PairingBundle,
  type SocketState,
} from "@bridge/protocol";
import type {
  DesktopConfigRepository,
  LoadedDesktopConfig,
  LoadedDeviceConfig,
} from "./config.js";

export interface DesktopTransportHost {
  config: LoadedDesktopConfig | undefined;
  hostCrypto: BridgeCrypto | undefined;
  readonly relayConnectUrl: string;
  readonly RTCPeerConnectionImpl?: typeof RTCPeerConnection;
  readonly repository: DesktopConfigRepository;
  readonly deviceCryptos: Map<string, BridgeCrypto>;
  readonly onlineDevices: Set<string>;
  readonly deflateDevices: Set<string>;
  socket: BridgeTransport | undefined;
  connection: SocketState;
  lastSeenAt: number;
  relayHealthy: boolean;
  transportMetrics: BridgeTransportMetrics | undefined;
  registerPendingDevices(): void;
  checkRelayHealth(endpoint: string): Promise<void>;
  acceptsDevice(deviceId: string): boolean;
  isPairedDevice(deviceId: string): boolean;
  rememberDevice(deviceId: string, metadata?: Record<string, unknown>): Promise<void>;
  rejectUnknownDevice(deviceId: string): void;
  receiveMessage(message: DecryptedEnvelope, encrypted: EncryptedEnvelope): Promise<void>;
  queuePublish(): void;
}

export interface DesktopMessageDeliveryHost {
  socket: BridgeTransport | undefined;
  readonly responseCache: Map<string, BridgeResponse>;
  rememberDevice(deviceId: string, metadata?: Record<string, unknown>): Promise<void>;
  sendToDevice(
    payload: BridgePayload,
    deviceId: string,
    ttlMs?: number,
    temporary?: boolean,
    compress?: boolean,
  ): Promise<string>;
  handleRequest(
    request: BridgeRequest,
    origin: "desktop" | "mobile",
    sourceDeviceId?: string,
  ): Promise<unknown>;
  cacheResponse(response: BridgeResponse): void;
  revokeDevice(deviceId: string): Promise<unknown>;
}

export { relayReadyUrl };

export function redactedEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  const fingerprint = createHash("sha256").update(url.host).digest("hex").slice(0, 10);
  return `${url.protocol}//relay-${fingerprint}${url.pathname}`;
}

export function pairingForDevice(config: LoadedDesktopConfig, device: LoadedDeviceConfig): PairingBundle {
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

export function acceptsRelayDevice(
  devices: readonly LoadedDeviceConfig[],
  deviceId: string,
  hasCrypto: boolean,
): boolean {
  return hasCrypto && devices.some((device) => device.deviceId === deviceId && !device.revokedAt);
}

export function lanRelayUrlFrom(config: LoadedDesktopConfig): { lanRelayUrl?: string } {
  const endpoint = config.relayEndpoints.find((candidate) => candidate.kind === "lan-relay");
  return endpoint ? { lanRelayUrl: endpoint.url } : {};
}

export async function createPendingDevicePairing(
  config: LoadedDesktopConfig,
): Promise<{ device: LoadedDeviceConfig; crypto: BridgeCrypto }> {
  const created = await BridgeCrypto.createDevicePairing({
    hostId: config.hostDeviceId,
    pairingEpoch: config.pairingEpoch,
    roomId: config.roomId,
    relayUrl: config.relayUrl,
    desktopName: config.desktopName,
    serviceOrigin: config.serviceOrigin,
    relayEndpoints: config.relayEndpoints,
    activeEndpoint: config.activeEndpoint,
    iceServers: config.iceServers,
  });
  const device: LoadedDeviceConfig = {
    deviceId: created.pairing.deviceId,
    name: "手机 Bridge",
    platform: "unknown",
    secret: created.pairing.secret,
    createdAt: created.pairing.createdAt,
    expiresAt: created.pairing.expiresAt,
  };
  return {
    device,
    crypto: created.desktopCrypto.withSenderDevice(config.hostDeviceId),
  };
}

export function applyManualRelayUrl(
  config: LoadedDesktopConfig,
  hostCrypto: BridgeCrypto,
  deviceCryptos: Map<string, BridgeCrypto>,
  value: string,
): BridgeCrypto {
  const url = normalizeRelayUrl(value);
  config.relayUrlOverride = url;
  config.relayUrl = url;
  config.serviceOrigin = relayServiceOrigin(url);
  config.relayEndpoints = [bridgeEndpoint(url, 0, "manual")];
  config.activeEndpoint = "manual";
  const nextHostCrypto = cryptoWithRelayEndpoint(hostCrypto, url);
  for (const [deviceId, crypto] of deviceCryptos) {
    deviceCryptos.set(deviceId, cryptoWithRelayEndpoint(crypto, url));
  }
  return nextHostCrypto;
}

export function connectDesktopTransport(host: DesktopTransportHost): void {
  if (!host.config || !host.hostCrypto) return;
  const localConnectUrl = !host.config.relayUrlOverride && relayPathForUrl(host.relayConnectUrl) === "lan-relay"
    ? host.relayConnectUrl
    : undefined;
  const candidateEndpoints = host.config.relayEndpoints
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
      crypto: cryptoWithRelayEndpoint(host.hostCrypto!, connectUrl),
      role: "desktop",
      createRoom: true,
      reconnect: false,
      path: endpoint.kind,
      resolveCrypto: (envelope) => host.deviceCryptos.get(envelope.fromDeviceId),
    }),
  }));
  const relay = new TransportRouter(candidates);
  const socket: BridgeTransport = host.RTCPeerConnectionImpl
    ? new WebRtcTransport({
        relay,
        crypto: host.hostCrypto,
        role: "desktop",
        RTCPeerConnectionImpl: host.RTCPeerConnectionImpl,
        iceServers: bridgeIceServers(host.config.iceServers),
        resolveCrypto: (envelope) => host.deviceCryptos.get(envelope.fromDeviceId),
        resolvePeerCrypto: (deviceId) => host.deviceCryptos.get(deviceId),
      })
    : relay;
  host.socket = socket;
  socket.onState((connection) => {
    host.connection = connection;
    if (connection === "connected") {
      host.lastSeenAt = Date.now();
      const active = candidateEndpoints.find((candidate) => candidate.connectUrl === socket.endpoint);
      if (active && host.config && host.config.activeEndpoint !== active.endpoint.id) {
        host.config.activeEndpoint = active.endpoint.id;
        host.config.relayUrl = active.endpoint.url;
        host.config.migratedAt = Date.now();
        void host.repository.save(host.config);
      }
      host.registerPendingDevices();
      void host.checkRelayHealth(socket.endpoint);
    } else if (connection === "closed" || connection === "reconnecting") {
      host.relayHealthy = false;
    }
    host.queuePublish();
  });
  socket.onMetrics((metrics) => {
    host.transportMetrics = metrics;
    host.queuePublish();
  });
  socket.onFrame((frame) => {
    diag("transport.frame");
    if (frame.type !== "ready" && (frame.type !== "presence" || frame.role !== "mobile")) return;
    if (frame.type === "ready") {
      host.deflateDevices.clear();
      host.onlineDevices.clear();
      for (const device of frame.onlineDevices) {
        if (device.role !== "mobile") continue;
        if (host.acceptsDevice(device.deviceId)) {
          host.onlineDevices.add(device.deviceId);
          if (host.isPairedDevice(device.deviceId)) void host.rememberDevice(device.deviceId);
        } else {
          host.rejectUnknownDevice(device.deviceId);
        }
      }
      host.registerPendingDevices();
    }
    if (frame.type === "presence" && frame.role === "mobile") {
      host.deflateDevices.delete(frame.deviceId);
      if (frame.online) {
        if (!host.acceptsDevice(frame.deviceId)) {
          host.rejectUnknownDevice(frame.deviceId);
          host.queuePublish();
          return;
        }
        host.onlineDevices.add(frame.deviceId);
        if (host.isPairedDevice(frame.deviceId)) void host.rememberDevice(frame.deviceId);
      } else {
        host.onlineDevices.delete(frame.deviceId);
        if (host.isPairedDevice(frame.deviceId)) void host.rememberDevice(frame.deviceId);
      }
    }
    host.queuePublish();
  });
  socket.onMessage((message, encrypted) => {
    diag("transport.message");
    void host.receiveMessage(message, encrypted);
  });
  socket.connect();
}

export async function probeRelayReady(endpoint: string): Promise<boolean> {
  try {
    const response = await fetch(relayReadyUrl(endpoint), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(4_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function deliverTransportMessage(
  host: DesktopMessageDeliveryHost,
  message: DecryptedEnvelope,
  encrypted: EncryptedEnvelope,
  formatError: (requestId: string, error: unknown) => BridgeResponse,
): Promise<void> {
  if (message.header.from !== "mobile" || message.payload.kind !== "request") {
    host.socket?.ack([encrypted.id]);
    return;
  }
  const method = diagnostics.method(message.payload.method);
  const delivered = diagnostics.begin(`rpc.${method}`);
  try {
    await host.rememberDevice(message.header.fromDeviceId, message.payload.params);
    const cached = host.responseCache.get(message.payload.requestId);
    if (cached) {
      diagnostics.cacheHit();
      const sent = diagnostics.begin(`send.${method}`);
      try { await host.sendToDevice(cached, message.header.fromDeviceId, undefined, false, message.payload.method !== "snapshot.get"); }
      finally { sent(); }
      host.socket?.ack([encrypted.id]);
      return;
    }
    let response: BridgeResponse;
    try {
      const result = await host.handleRequest(message.payload, "mobile", message.header.fromDeviceId);
      response = { kind: "response", requestId: message.payload.requestId, ok: true, result };
    } catch (error) {
      response = formatError(message.payload.requestId, error);
    }
    diagnostics.response(response, method);
    if (
      message.payload.method !== "artifact.preview" &&
      message.payload.method !== "artifact.transfer.read" &&
      message.payload.method !== "session.tool.detail"
    ) host.cacheResponse(response);
    const temporaryResponse = message.payload.method !== "turn.start" && message.payload.method !== "turn.steer";
    const sent = diagnostics.begin(`send.${method}`);
    try {
      await host.sendToDevice(
        response,
        message.header.fromDeviceId,
        message.payload.method.startsWith("artifact.") || message.payload.method === "session.tool.detail"
          ? ARTIFACT_TRANSFER_TTL_MS
          : undefined,
        temporaryResponse,
        message.payload.method !== "snapshot.get",
      ).catch(() => undefined);
    } finally { sent(); }
    host.socket?.ack([encrypted.id]);
    if (
      message.payload.method === "device.revoke" &&
      response.ok &&
      typeof message.payload.params.deviceId === "string" &&
      message.payload.params.deviceId.trim() &&
      message.payload.params.deviceId === message.header.fromDeviceId
    ) {
      setTimeout(() => void host.revokeDevice(message.header.fromDeviceId), 250);
    }
  } finally { delivered(); }
}

export async function sendPayloadToDevice(
  socket: BridgeTransport | undefined,
  connection: SocketState,
  deviceCryptos: ReadonlyMap<string, BridgeCrypto>,
  deflateDevices: ReadonlySet<string>,
  payload: BridgePayload,
  deviceId: string,
  ttlMs?: number,
  temporary = false,
  compress = true,
): Promise<string> {
  if (!socket || connection !== "connected") throw new Error("Bridge is not connected");
  const crypto = deviceCryptos.get(deviceId);
  if (!crypto) throw new Error("Device key is unavailable");
  return socket.send(payload, "mobile", {
    toDeviceId: deviceId,
    crypto,
    ...(ttlMs !== undefined ? { ttlMs } : {}),
    ...(temporary ? { temporary: true } : {}),
    compress: compress && deflateDevices.has(deviceId),
  });
}

export function registerPendingRelayDevices(
  config: LoadedDesktopConfig | undefined,
  socket: BridgeTransport | undefined,
  connection: SocketState,
  deviceCryptos: ReadonlyMap<string, BridgeCrypto>,
): void {
  if (!config || !socket || connection !== "connected") return;
  const now = Date.now();
  for (const device of config.devices) {
    if (device.revokedAt) {
      try {
        socket.revokeDevice(device.deviceId);
      } catch {
        // Revocation is replayed whenever another endpoint becomes active.
      }
      continue;
    }
    const crypto = deviceCryptos.get(device.deviceId);
    if (!crypto) continue;
    try {
      if (device.pairedAt && socket.path === "public-relay") {
        socket.registerDevice(
          device.deviceId,
          crypto.identity.authToken,
          now + 7 * 24 * 60 * 60 * 1_000,
          { migrate: true, pairedAt: device.pairedAt },
        );
      } else if (!device.pairedAt && device.expiresAt > now) {
        socket.registerDevice(device.deviceId, crypto.identity.authToken, device.expiresAt);
      }
    } catch {
      // Registration will be retried on the next reconnect.
    }
  }
}

export function applyRememberedDevice(
  config: LoadedDesktopConfig,
  deviceId: string,
  socketPath: BridgeTransport["path"] | undefined,
  deflateDevices: Set<string>,
  metadata?: Record<string, unknown>,
): boolean {
  const device = config.devices.find((candidate) => candidate.deviceId === deviceId && !candidate.revokedAt);
  if (!device) return false;
  const now = Date.now();
  device.pairedAt ??= now;
  device.lastSeenAt = now;
  if (socketPath === "public-relay") device.publicRelayClaimedAt ??= now;
  if (metadata) deflateDevices.delete(deviceId);
  const client = metadata?.client;
  if (client && typeof client === "object") {
    const value = client as Record<string, unknown>;
    if (Array.isArray(value.capabilities) && value.capabilities.includes(PAYLOAD_DEFLATE_CAPABILITY)) {
      deflateDevices.add(deviceId);
    }
    if (typeof value.name === "string" && value.name.trim()) device.name = value.name.trim().slice(0, 80);
    if (value.platform === "android" || value.platform === "web") {
      device.platform = value.platform;
    }
  }
  return true;
}

export function buildDeviceSnapshots(
  devices: readonly LoadedDeviceConfig[],
  onlineDevices: ReadonlySet<string>,
): BridgeDeviceInfo[] {
  return devices
    .filter((device) => device.pairedAt || device.expiresAt > Date.now())
    .map((device) => ({
      deviceId: device.deviceId,
      name: device.name,
      platform: device.platform,
      online: onlineDevices.has(device.deviceId),
      createdAt: device.pairedAt ?? device.createdAt,
      ...(device.lastSeenAt !== undefined ? { lastSeenAt: device.lastSeenAt } : {}),
      ...(device.revokedAt !== undefined ? { revokedAt: device.revokedAt } : {}),
    }))
    .sort((left, right) => Number(right.online) - Number(left.online) || right.createdAt - left.createdAt);
}

export function cacheDeviceResponse(
  responseCache: Map<string, BridgeResponse>,
  response: BridgeResponse,
): void {
  const previous = responseCache.get(response.requestId);
  if (previous) diagnostics.cacheEvict(previous);
  responseCache.set(response.requestId, response);
  diagnostics.cacheInsert(response);
  while (responseCache.size > 500) {
    const oldest = responseCache.keys().next().value as string | undefined;
    if (oldest) {
      diagnostics.cacheEvict(responseCache.get(oldest)!);
      responseCache.delete(oldest);
    }
  }
}
