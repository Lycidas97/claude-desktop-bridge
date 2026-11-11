import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  BridgeCrypto,
  PROTOCOL_VERSION,
  WebRtcTransport,
  fromBase64Url,
  serializeHeader,
  type EncryptedEnvelope,
  type BridgePermissionInfo,
  toBase64Url,
  utf8,
  type BridgeSessionInfo,
  type ClientFrame,
  type DesktopControlSnapshot,
  type ServerFrame,
} from "@bridge/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoadedDesktopConfig } from "./config.js";
import { DesktopController } from "./controller.js";

vi.mock("electron", () => ({ shell: {} }));
import { SessionEventLog } from "./session-event-log.js";

// Only the WebSocket I/O boundary is replaced. connect(), the transport router,
// relay/socket parsing, controller subscriptions and publication remain real.
class LocalWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: LocalWebSocket[] = [];
  readyState = LocalWebSocket.CONNECTING;
  readonly sent: ClientFrame[] = [];

  constructor(readonly url: string) {
    super();
    LocalWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as ClientFrame);
  }

  open(): void {
    this.readyState = LocalWebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  receive(frame: ServerFrame): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
  }

  close(): void {
    this.readyState = LocalWebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }
}

const controllers: Array<{
  socket: { close(): void };
  publishTimer?: ReturnType<typeof setTimeout>;
  eventLog: SessionEventLog;
  root: string;
}> = [];

beforeEach(() => {
  vi.useFakeTimers();
  LocalWebSocket.instances = [];
  vi.stubGlobal("WebSocket", LocalWebSocket);
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true })));
});

afterEach(async () => {
  for (const controller of controllers.splice(0)) {
    controller.socket.close();
    if (controller.publishTimer) clearTimeout(controller.publishTimer);
    await controller.eventLog.close();
    if (process.platform === "win32") {
      await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        "$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName Microsoft.VisualBasic; " +
        "[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($env:BRIDGE_RECYCLE_PATH, 'OnlyErrorDialogs', 'SendToRecycleBin', 'ThrowException')",
      ], { env: { ...process.env, BRIDGE_RECYCLE_PATH: controller.root } });
    } else {
      await promisify(execFile)(process.platform === "darwin" ? "/usr/bin/trash" : "trash-put", [controller.root]);
    }
  }
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function fixture(withWebRtc = false, claudeUnavailable = false) {
  const relayUrl = "ws://127.0.0.1:18789/ws";
  const host = await BridgeCrypto.createHost(relayUrl, "Synthetic desktop");
  const paired = await BridgeCrypto.createDevicePairing({
    hostId: host.crypto.identity.deviceId,
    roomId: host.crypto.identity.roomId,
    relayUrl,
    desktopName: "Synthetic desktop",
    deviceId: "synthetic-phone",
  });
  const config: LoadedDesktopConfig = {
    configVersion: 4, protocolVersion: PROTOCOL_VERSION, pairingEpoch: 1,
    roomId: host.crypto.identity.roomId, serviceOrigin: "http://127.0.0.1:18789",
    relayEndpoints: [{ id: "local", kind: "public-relay", url: relayUrl, priority: 1 }],
    activeEndpoint: "local", relayUrl, desktopName: "Synthetic desktop",
    hostDeviceId: host.crypto.identity.deviceId, hostSecret: host.secret, evidenceKey: host.secret,
    iceServers: [], createdAt: 1, launchAtLogin: false, managedDesktopEnabled: false,
    defaultPermissionMode: "standard", runtimePermissionModes: {},
    devices: [{
      deviceId: paired.pairing.deviceId, name: "Synthetic phone", platform: "android",
      secret: paired.pairing.secret, createdAt: 1, expiresAt: paired.pairing.expiresAt, pairedAt: 1,
    }],
  };
  const sessions: BridgeSessionInfo[] = Array.from({ length: 144 }, (_, index) => ({
    sessionId: `synthetic-${index}`, title: `Synthetic session ${index}`, cwd: "/synthetic",
    projectId: "synthetic", projectName: "Synthetic", source: "desktop", transport: "bridge-host",
    ownership: "DESKTOP_OBSERVED", turnState: "idle", pendingCount: 0, lastActivityAt: 1,
  }));
  const root = await mkdtemp(join(tmpdir(), "bridge-transport-publication-"));
  const eventLog = new SessionEventLog(join(root, "events.jsonl"));
  // Synthetic business dependencies; initialization, snapshots, event logging and message delivery remain real.
  const runtimeSessions = Object.assign(new EventEmitter(), {
    initialize: vi.fn(async () => undefined), setHostPermissionModes: vi.fn(),
    listSessions: () => [], listProjects: () => [], listPermissions: () => [],
    runtimes: () => [{ id: "codex-desktop", name: "Codex Desktop", state: "ready", detail: "Connected",
      capabilities: ["turn.start"], sessionIsolation: "independent", sessionCount: 0, updatedAt: 1 }],
  });
  const controller = Object.assign(Object.create(DesktopController.prototype), new EventEmitter(), {
    root, config, hostCrypto: host.crypto, relayConnectUrl: relayUrl,
    ...(withWebRtc ? { RTCPeerConnectionImpl: vi.fn() } : {}),
    connection: "idle", relayHealthy: false, lastSeenAt: 1,
    deviceCryptos: new Map([[paired.pairing.deviceId, paired.desktopCrypto.withSenderDevice(config.hostDeviceId)]]),
    onlineDevices: new Set<string>(), deflateDevices: new Set<string>(), responseCache: new Map(),
    lastPublishedSessionKey: "", lastPublishedSessions: new Map<string, string>(), lastPublishedPermissions: new Map(),
    sessionVisibility: new Map(),
    app: { getVersion: () => "synthetic", getLoginItemSettings: () => ({ openAtLogin: false }) },
    repository: { loadOrCreate: async () => config, save: vi.fn(async () => undefined) },
    broker: Object.assign(new EventEmitter(), {
      initialize: async () => undefined, refreshRuntime: vi.fn(async () => true), setDefaultPermissionMode: vi.fn(),
      listSessions: () => sessions, listProjects: () => [], runtimeStatus: () => ({ state: claudeUnavailable ? "unavailable" : "ready" }),
      permissionsList: () => [], capabilities: () => ["session.list", "session.history"], magpieSettings: async () => ({}),
    }),
    eventLog,
    ...(claudeUnavailable ? { runtimeSessions } : {}),
    claudeDesktop: { status: async () => ({ state: "stopped" }) },
    desktopAppStatuses: async () => [],
  });
  const published = vi.fn<(snapshot: DesktopControlSnapshot) => void>();
  controller.on("snapshot", published);
  await controller.initialize();
  controllers.push(controller);
  const ws = LocalWebSocket.instances[0]!;
  ws.open();
  ws.receive({ type: "ready", connectionId: "initial", queued: 0, online: ["desktop"], onlineDevices: [] });
  await vi.advanceTimersByTimeAsync(150);
  await vi.waitFor(() => expect(ws.sent.filter(frame => frame.type === "envelope")).toHaveLength(1));
  published.mockClear();
  ws.sent.length = 0;
  return { controller, ws, paired, config, published, sessions, runtimeSessions, eventLog };
}

async function requestSnapshot(ws: LocalWebSocket, paired: Awaited<ReturnType<typeof BridgeCrypto.createDevicePairing>>, hostDeviceId: string): Promise<DesktopControlSnapshot> {
  const phone = await BridgeCrypto.fromPairing(paired.pairing);
  const requestId = `snapshot-${Date.now()}`;
  const envelope = await phone.encrypt({ kind: "request", requestId, idempotencyKey: requestId, method: "snapshot.get", params: {} }, "mobile", "desktop", Date.now(), undefined, hostDeviceId, true);
  ws.receive({ type: "envelope", envelope });
  let snapshot: DesktopControlSnapshot | undefined;
  await vi.waitFor(async () => {
    for (const frame of ws.sent) {
      if (frame.type !== "envelope") continue;
      const { payload } = await phone.decrypt(frame.envelope);
      if (payload.kind === "response" && payload.requestId === requestId) {
        expect(payload.ok).toBe(true);
        snapshot = (payload.result as { snapshot: DesktopControlSnapshot }).snapshot;
      }
    }
    expect(snapshot).toBeDefined();
  });
  return snapshot!;
}

describe("controller transport publication", () => {
  it("keeps the 1.3 catalog bootstrap and cached replies JSON, then compresses only for declared devices", async () => {
    const { controller, ws, paired, config } = await fixture();
    const phone = await BridgeCrypto.fromPairing(paired.pairing);
    const plaintext = async (envelope: EncryptedEnvelope) => {
      const { nonce, ciphertext, ...header } = envelope;
      return new Uint8Array(await crypto.subtle.decrypt({
        name: "AES-GCM", iv: fromBase64Url(nonce), additionalData: serializeHeader(header), tagLength: 128,
      }, phone.encryptionKey, fromBase64Url(ciphertext)));
    };
    await controller.broadcast({ kind: "snapshot", snapshot: await controller.snapshot() }, true);
    const request = { kind: "request" as const, requestId: "compression-bootstrap", idempotencyKey: "bootstrap", method: "snapshot.get" as const,
      params: { client: { capabilities: ["payload.deflate.v1"] } } };
    for (let attempt = 0; attempt < 2; attempt++) {
      const encrypted = await phone.encrypt(request, "mobile", "desktop", Date.now(), undefined, config.hostDeviceId, true);
      await controller.receiveMessage(await controller.deviceCryptos.get(paired.pairing.deviceId).decrypt(encrypted), encrypted);
    }
    const bootstrap = ws.sent.filter(frame => frame.type === "envelope");
    expect(bootstrap).toHaveLength(3);
    for (const frame of bootstrap) {
      if (frame.type !== "envelope") throw new Error("Expected envelope");
      expect(JSON.parse(new TextDecoder().decode(await plaintext(frame.envelope)))).toHaveProperty("kind");
    }
    expect((await controller.snapshot()).host.capabilities).toContain("payload.deflate.v1");
    expect((await controller.snapshot()).host.capabilities).toContain("claude.native-relay.v1");

    ws.sent.length = 0;
    const response = { kind: "response" as const, requestId: "history", ok: true, result: { text: "中文 😀 history\n".repeat(300) } };
    await controller.sendToDevice(response, paired.pairing.deviceId);
    const compressed = ws.sent.find(frame => frame.type === "envelope")!;
    if (compressed.type !== "envelope") throw new Error("Expected envelope");
    expect((await plaintext(compressed.envelope))[0]).toBe(1);
    expect((await phone.decrypt(compressed.envelope)).payload).toEqual(response);

    const legacy = await BridgeCrypto.createDevicePairing({ roomId: config.roomId, relayUrl: paired.pairing.relayUrl, desktopName: "Legacy", deviceId: "legacy-phone" });
    config.devices.push({ ...config.devices[0]!, deviceId: legacy.pairing.deviceId, secret: legacy.pairing.secret });
    controller.deviceCryptos.set(legacy.pairing.deviceId, legacy.desktopCrypto.withSenderDevice(config.hostDeviceId));
    await controller.rememberDevice(legacy.pairing.deviceId, { client: { name: "Old phone", platform: "web" } });
    ws.sent.length = 0;
    await controller.sendToDevice(response, legacy.pairing.deviceId);
    const legacyFrame = ws.sent.find(frame => frame.type === "envelope")!;
    if (legacyFrame.type !== "envelope") throw new Error("Expected envelope");
    const { nonce, ciphertext, ...header } = legacyFrame.envelope;
    const legacyBody = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64Url(nonce), additionalData: serializeHeader(header), tagLength: 128 }, legacy.desktopCrypto.encryptionKey, fromBase64Url(ciphertext));
    expect(JSON.parse(new TextDecoder().decode(legacyBody))).toEqual(response);

    ws.receive({ type: "presence", role: "mobile", deviceId: paired.pairing.deviceId, online: false });
    expect(controller.deflateDevices.has(paired.pairing.deviceId)).toBe(false);
  });

  it.each(["ready", "presence"] as const)("sends one complete snapshot for a phone joining via %s and requesting its catalog", async signal => {
    const { ws, controller, paired, config } = await fixture();
    ws.receive(signal === "ready"
      ? { type: "ready", connectionId: "phone-joining", queued: 0, online: ["desktop", "mobile"], onlineDevices: [{ role: "mobile", deviceId: paired.pairing.deviceId }] }
      : { type: "presence", role: "mobile", deviceId: paired.pairing.deviceId, online: true });
    const phone = await BridgeCrypto.fromPairing(paired.pairing);
    const envelope = await phone.encrypt({ kind: "request", requestId: "join-snapshot", idempotencyKey: "join-snapshot", method: "snapshot.get", params: {} }, "mobile", "desktop", Date.now(), undefined, config.hostDeviceId, true);
    ws.receive({ type: "envelope", envelope });
    await vi.waitFor(async () => {
      const replies = await Promise.all(ws.sent.flatMap(frame => frame.type === "envelope" ? [phone.decrypt(frame.envelope)] : []));
      expect(replies.some(reply => reply.payload.kind === "response" && reply.payload.requestId === "join-snapshot")).toBe(true);
    });
    await vi.advanceTimersByTimeAsync(150);
    expect(ws.sent.filter(frame => frame.type === "envelope")).toHaveLength(1);
    expect(controller.onlineDevices.has(paired.pairing.deviceId)).toBe(true);
  });

  it.each<ServerFrame>([
    { type: "stored", ids: ["delivery-1"] },
    { type: "acknowledged", ids: ["delivery-1"], byDeviceId: "synthetic-phone" },
    { type: "device-registered", deviceId: "synthetic-phone", expiresAt: 123 },
    { type: "device-revoked", deviceId: "stale-phone" },
    { type: "chunk-missing", transferId: "delivery-1", indexes: [0] },
    { type: "presence", role: "desktop", deviceId: "another-desktop", online: true },
  ])("does not rebuild a local snapshot for $type control traffic", async (frame) => {
    const { ws, published, controller } = await fixture();
    const snapshot = vi.spyOn(controller, "snapshot");
    for (let index = 0; index < 20; index += 1) ws.receive(frame);
    await vi.advanceTimersByTimeAsync(150);
    expect(snapshot).not.toHaveBeenCalled();
    expect(published).not.toHaveBeenCalled();
  });

  it("coalesces a pong's metrics and frame callbacks into one current snapshot", async () => {
    const { ws, controller, published } = await fixture();
    ws.receive({ type: "pong", at: Date.now() - 37 });
    ws.receive({ type: "pong", at: Date.now() - 42 });
    await vi.advanceTimersByTimeAsync(150);
    expect(published).toHaveBeenCalledOnce();
    expect(published.mock.calls[0]![0].transport).toMatchObject({ state: "connected", rttMs: 42 });
    expect(controller.transportMetrics.rttMs).toBe(42);
  });

  it("coalesces reconnect callbacks while preserving health publication and initial device state", async () => {
    const { ws, controller, paired, published } = await fixture();
    ws.close();
    await vi.advanceTimersByTimeAsync(150);
    expect(published).toHaveBeenCalledOnce();
    expect(published.mock.calls[0]![0]).toMatchObject({ connection: "reconnecting", transport: { relayHealthy: false } });
    await vi.advanceTimersByTimeAsync(500);
    const reconnected = LocalWebSocket.instances[1]!;
    published.mockClear();
    const reject = vi.spyOn(controller, "rejectUnknownDevice");
    reconnected.open();
    reconnected.receive({ type: "ready", connectionId: "reconnected", queued: 0, online: ["desktop", "mobile"], onlineDevices: [
      { role: "mobile", deviceId: paired.pairing.deviceId },
      { role: "mobile", deviceId: "stale-phone" },
      { role: "desktop", deviceId: "another-desktop" },
    ] });
    await vi.advanceTimersByTimeAsync(150);
    const snapshot = await requestSnapshot(reconnected, paired, controller.config.hostDeviceId);
    // checkRelayHealth still publishes its result immediately; subscription callbacks share the queued publication.
    expect(published).toHaveBeenCalledTimes(2);
    expect(published.mock.calls[0]![0].devices).toEqual([expect.objectContaining({ deviceId: paired.pairing.deviceId, online: true })]);
    expect(controller.onlineDevices).toEqual(new Set([paired.pairing.deviceId]));
    expect(reconnected.sent).toContainEqual(expect.objectContaining({ type: "device-register", deviceId: paired.pairing.deviceId, migrate: true, pairedAt: 1 }));
    expect(reject).toHaveBeenCalledWith("stale-phone");
    expect(snapshot).toMatchObject({ sessions: expect.any(Array) });
    expect(controller.repository.save).toHaveBeenCalled();
  });

  it("publishes mobile online/offline presence, remembers paired devices and rejects unknown devices", async () => {
    const { ws, controller, paired, published, config } = await fixture();
    ws.receive({ type: "presence", role: "mobile", deviceId: paired.pairing.deviceId, online: true });
    await vi.advanceTimersByTimeAsync(150);
    expect(ws.sent.filter(frame => frame.type === "envelope")).toHaveLength(0);
    expect(published).toHaveBeenCalledOnce();
    expect(published.mock.calls[0]![0].devices[0]).toMatchObject({ online: true, lastSeenAt: expect.any(Number) });
    expect(config.devices[0]!.lastSeenAt).toBeDefined();
    expect(controller.repository.save).toHaveBeenCalled();
    published.mockClear();
    ws.receive({ type: "presence", role: "mobile", deviceId: paired.pairing.deviceId, online: false });
    await vi.advanceTimersByTimeAsync(150);
    expect(published).toHaveBeenCalledOnce();
    expect(published.mock.calls[0]![0].devices[0]!.online).toBe(false);
    published.mockClear();
    ws.receive({ type: "presence", role: "mobile", deviceId: "stale-phone", online: true });
    await vi.advanceTimersByTimeAsync(150);
    expect(ws.sent).toContainEqual({ type: "device-revoke", deviceId: "stale-phone" });
    expect(controller.onlineDevices.has("stale-phone")).toBe(false);
    expect(published).toHaveBeenCalledOnce();
  });

  it("retains transport errors through metrics without a second frame publication", async () => {
    const { ws, controller, published } = await fixture();
    ws.receive({ type: "error", code: "SYNTHETIC_ERROR", message: "Local fixture error" });
    await vi.advanceTimersByTimeAsync(150);
    expect(controller.transportMetrics.lastError).toBe("SYNTHETIC_ERROR: Local fixture error");
    expect(published).toHaveBeenCalledOnce();
    expect(published.mock.calls[0]![0].connection).toBe("connected");
  });

  it.each(["envelope", "envelope-chunk"] as const)("delivers %s requests and ACKs duplicates without control-frame snapshot work", async (type) => {
    const { ws, controller, paired, published, config } = await fixture();
    const phone = await BridgeCrypto.fromPairing(paired.pairing);
    const encrypted = await phone.encrypt({ kind: "request", requestId: "local-request", idempotencyKey: "local-request", method: "project.list", params: {} }, "mobile", "desktop", Date.now(), undefined, config.hostDeviceId);
    const bytes = utf8(JSON.stringify(encrypted));
    const sha256 = toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
    const incomingFrames: ServerFrame[] = type === "envelope" ? [{ type, envelope: encrypted }] : [0, 1].map(index => ({ type, chunk: {
      version: PROTOCOL_VERSION, transferId: encrypted.id, roomId: encrypted.roomId,
      from: encrypted.from, fromDeviceId: encrypted.fromDeviceId, to: encrypted.to,
      toDeviceId: config.hostDeviceId, sentAt: encrypted.sentAt, expiresAt: encrypted.expiresAt,
      index, total: 2, sha256,
      data: toBase64Url(bytes.slice(index * Math.ceil(bytes.length / 2), (index + 1) * Math.ceil(bytes.length / 2))),
    } }));
    const snapshot = vi.spyOn(controller, "snapshot");
    for (const frame of incomingFrames) ws.receive(frame);
    await vi.waitFor(() => expect(ws.sent).toContainEqual({ type: "ack", ids: [encrypted.id] }));
    const response = ws.sent.find(frame => frame.type === "envelope")!;
    if (response.type !== "envelope") throw new Error("Expected request response");
    expect((await phone.decrypt(response.envelope)).payload).toMatchObject({ kind: "response", requestId: "local-request", ok: true, result: { projects: [] } });
    expect(response.envelope.temporary).toBe(true);
    for (const frame of incomingFrames) ws.receive(frame);
    await vi.waitFor(() => expect(ws.sent.filter(frame => frame.type === "ack")).toHaveLength(2));
    await vi.advanceTimersByTimeAsync(150);
    expect(ws.sent.filter(frame => frame.type === "ack")).toHaveLength(2);
    expect(controller.responseCache.has("local-request")).toBe(true);
    expect(snapshot).not.toHaveBeenCalled();
    expect(published).not.toHaveBeenCalled();
  });

  it("sends complete runtime replacements over the live socket and current state after reconnect", async () => {
    const { ws, controller, paired, sessions } = await fixture();
    const append = vi.spyOn(controller.eventLog, "append");
    sessions[0]!.turnState = "running";
    sessions[0]!.mainTurnStopScope = "process";
    sessions[0]!.runningSubagents = { count: 2, lastUpdatedAt: 20 };
    sessions[0]!.subagentStopScope = "task";
    controller.broker.emit("changed");
    await vi.waitFor(() => expect(ws.sent.filter(frame => frame.type === "envelope")).toHaveLength(1));
    const runningFrame = ws.sent.find(frame => frame.type === "envelope")!;
    if (runningFrame.type !== "envelope") throw new Error("Expected runtime replacement");
    const running = (await paired.desktopCrypto.decrypt(runningFrame.envelope)).payload;
    expect(running).toMatchObject({ kind: "event", event: {
      seq: 1, sessionId: sessions[0]!.sessionId, itemId: "session:subagent-activity", type: "runtime.updated",
      data: { replaceSession: true, session: sessions[0] },
    } });
    expect(runningFrame.envelope.temporary).toBe(true);

    sessions[0]!.turnState = "idle";
    delete sessions[0]!.mainTurnStopScope;
    delete sessions[0]!.runningSubagents;
    delete sessions[0]!.subagentStopScope;
    controller.broker.emit("changed");
    await vi.waitFor(() => expect(ws.sent.filter(frame => frame.type === "envelope")).toHaveLength(2));
    const completedFrame = ws.sent.filter(frame => frame.type === "envelope")[1]!;
    if (completedFrame.type !== "envelope") throw new Error("Expected completion replacement");
    const completed = (await paired.desktopCrypto.decrypt(completedFrame.envelope)).payload;
    expect(completed).toMatchObject({ kind: "event", event: {
      seq: 2, sessionId: sessions[0]!.sessionId, type: "runtime.updated", data: { replaceSession: true, session: sessions[0] },
    } });
    if (completed.kind !== "event") throw new Error("Expected runtime event");
    expect(completed.event.data.session).not.toHaveProperty("mainTurnStopScope");
    expect(completed.event.data.session).not.toHaveProperty("runningSubagents");
    expect(completed.event.data.session).not.toHaveProperty("subagentStopScope");
    await vi.advanceTimersByTimeAsync(150);
    expect(append).toHaveBeenCalledTimes(2);
    expect(ws.sent.filter(frame => frame.type === "envelope")).toHaveLength(2);

    ws.close();
    await vi.advanceTimersByTimeAsync(650);
    const reconnected = LocalWebSocket.instances[1]!;
    reconnected.open();
    reconnected.receive({ type: "ready", connectionId: "runtime-reconnected", queued: 0, online: ["desktop", "mobile"], onlineDevices: [
      { role: "mobile", deviceId: paired.pairing.deviceId },
    ] });
    const snapshot = await requestSnapshot(reconnected, paired, controller.config.hostDeviceId);
    expect(snapshot).toMatchObject({ latestSeq: 2, sessions: expect.arrayContaining(sessions) });
    expect(snapshot.sessions).toHaveLength(144);
    expect(snapshot.sessions[0]).not.toHaveProperty("mainTurnStopScope");
    expect(snapshot.sessions[0]).not.toHaveProperty("runningSubagents");
    expect(snapshot.sessions[0]).not.toHaveProperty("subagentStopScope");
  });

  it("leaves external-runtime permission publication with its owning runtime", async () => {
    const { controller, eventLog } = await fixture(false, true);
    const external: BridgePermissionInfo = { requestId: "external-owned", sessionId: "codex-desktop:external-session",
      toolUseId: "external-tool", toolName: "Bash", input: { command: "synthetic --never-executed" }, createdAt: 1, canAllowAlways: false };
    let permissions = [external];
    controller.runtimeSessions.listPermissions = () => permissions;
    expect((await controller.publish()).permissions).toEqual([external]);
    const before = eventLog.latestSeq();
    permissions = [];
    await controller.publish();
    expect(eventLog.replay(before).filter(event => /^(permission|question)\.(requested|resolved)$/u.test(event.type))).toEqual([]);
  });

  it("keeps the Native publication baseline tied to its captured snapshot during overlapping catalog updates", async () => {
    const { ws, controller, paired, sessions, eventLog } = await fixture();
    const permissions: BridgePermissionInfo[] = [];
    controller.broker.permissionsList = () => permissions;
    controller.broker.runtimeStatus = () => ({ state: "working", activeTurns: 1 });
    sessions[0]!.turnState = "running";
    await controller.publish();
    ws.sent.length = 0;
    let capturedFirst!: () => void, capturedSecond!: () => void;
    let releaseFirst!: () => void, releaseSecond!: () => void;
    const firstCaptured = new Promise<void>(resolve => { capturedFirst = resolve; });
    const secondCaptured = new Promise<void>(resolve => { capturedSecond = resolve; });
    const firstStatus = new Promise<void>(resolve => { releaseFirst = resolve; });
    const secondStatus = new Promise<void>(resolve => { releaseSecond = resolve; });
    controller.claudeDesktop.status = vi.fn()
      .mockImplementationOnce(async () => { capturedFirst(); await firstStatus; return { state: "stopped" }; })
      .mockImplementationOnce(async () => { capturedSecond(); await secondStatus; return { state: "stopped" }; })
      .mockResolvedValue({ state: "stopped" });
    sessions[0]!.title = "Changed catalog title";
    const first = controller.publish();
    await firstCaptured;
    const permission: BridgePermissionInfo = { requestId: "native-during-status", sessionId: sessions[0]!.sessionId,
      toolUseId: "native-during-status-tool", toolName: "Bash", input: { command: "synthetic --never-executed" }, createdAt: 1, canAllowAlways: false };
    permissions.push(permission);
    sessions[0]!.turnState = "waiting";
    const second = controller.publish();
    await secondCaptured;
    releaseFirst();
    await first;
    releaseSecond();
    await second;
    await controller.publish();
    expect(eventLog.replay().filter(event => event.type === "permission.requested" && event.data.requestId === permission.requestId)).toHaveLength(1);
    await vi.waitFor(() => expect(ws.sent.filter(frame => frame.type === "envelope")).toHaveLength(2));
    const payloads = await Promise.all(ws.sent.filter(frame => frame.type === "envelope").map(async frame => {
      if (frame.type !== "envelope") throw new Error("Expected publication envelope");
      return (await paired.desktopCrypto.decrypt(frame.envelope)).payload;
    }));
    expect(payloads.filter(payload => payload.kind === "snapshot")).toHaveLength(1);
    expect(payloads).toContainEqual(expect.objectContaining({ kind: "snapshot", snapshot: expect.objectContaining({ permissions: [] }) }));
    expect(payloads).toContainEqual(expect.objectContaining({ kind: "event", event: expect.objectContaining({
      type: "permission.requested", data: permission,
    }) }));
  });

  it.each(["Bash", "AskUserQuestion"])("publishes a new Native %s request without a full snapshot while its turn stays running", async (toolName) => {
    const { ws, controller, paired, sessions, eventLog } = await fixture();
    const permissions: BridgePermissionInfo[] = [];
    controller.broker.permissionsList = () => permissions;
    controller.broker.runtimeStatus = () => ({ state: "working", activeTurns: 1 });
    sessions[0]!.turnState = "running";
    await controller.publish();
    ws.sent.length = 0;
    const permission: BridgePermissionInfo = { requestId: "native-new", sessionId: sessions[0]!.sessionId,
      toolUseId: "native-tool", toolName, input: { command: "synthetic --never-executed" }, createdAt: 1, canAllowAlways: false };
    permissions.push(permission);
    sessions[0]!.turnState = "waiting";
    controller.broker.emit("changed");
    await vi.waitFor(() => expect(eventLog.replay().some(event => event.type === (toolName === "AskUserQuestion" ? "question.requested" : "permission.requested"))).toBe(true));
    await vi.waitFor(() => expect(ws.sent.filter(frame => frame.type === "envelope")).toHaveLength(2));
    const payloads = await Promise.all(ws.sent.filter(frame => frame.type === "envelope").map(async frame => {
      if (frame.type !== "envelope") throw new Error("Expected Native permission envelope");
      return (await paired.desktopCrypto.decrypt(frame.envelope)).payload;
    }));
    expect(payloads.every(payload => payload.kind !== "snapshot")).toBe(true);
    expect(payloads).toContainEqual(expect.objectContaining({ kind: "event", event: expect.objectContaining({
      type: toolName === "AskUserQuestion" ? "question.requested" : "permission.requested", sessionId: permission.sessionId, data: permission,
    }) }));
    controller.broker.emit("changed");
    await vi.advanceTimersByTimeAsync(150);
    expect(eventLog.replay().filter(event => event.data.requestId === permission.requestId)).toHaveLength(1);
  });

  it("publishes Native request membership changes while the session remains waiting", async () => {
    const { ws, controller, paired, sessions, eventLog } = await fixture();
    const first: BridgePermissionInfo = { requestId: "native-first", sessionId: sessions[0]!.sessionId,
      toolUseId: "first-tool", toolName: "Bash", input: { command: "synthetic --never-executed" }, createdAt: 1, canAllowAlways: false };
    const second = { ...first, requestId: "native-second", toolUseId: "second-tool" };
    const replacement = { ...first, requestId: "native-replacement", toolUseId: "replacement-tool" };
    let permissions = [first];
    controller.broker.permissionsList = () => permissions;
    controller.broker.runtimeStatus = () => ({ state: "working", activeTurns: 1 });
    sessions[0]!.turnState = "waiting";
    await controller.publish();
    ws.sent.length = 0;
    const before = controller.eventLog.latestSeq();
    for (const next of [[first, second], [second], [replacement]]) {
      permissions = next;
      await controller.publish();
    }
    await vi.waitFor(() => expect(ws.sent.filter(frame => frame.type === "envelope")).toHaveLength(4));
    const changes = eventLog.replay(before);
    expect(changes.map(event => [event.type, event.data.requestId])).toEqual([
      ["permission.requested", second.requestId], ["permission.resolved", first.requestId],
      ["permission.requested", replacement.requestId], ["permission.resolved", second.requestId],
    ]);
    for (const event of changes.filter(event => event.type === "permission.resolved")) {
      expect(event.data).toEqual({ requestId: event.data.requestId, automatic: true });
    }
    for (const frame of ws.sent) if (frame.type === "envelope") {
      expect((await paired.desktopCrypto.decrypt(frame.envelope)).payload.kind).toBe("event");
    }
  });

  it.each(["Bash", "AskUserQuestion"])("silently clears an externally removed Native %s request without inventing a decision", async (toolName) => {
    const { ws, controller, paired, sessions, eventLog } = await fixture();
    let permissions: BridgePermissionInfo[] = [{ requestId: "native-external", sessionId: sessions[0]!.sessionId,
      toolUseId: "native-tool", toolName, input: {}, createdAt: 1, canAllowAlways: false }];
    controller.broker.permissionsList = () => permissions;
    controller.broker.runtimeStatus = () => ({ state: "working", activeTurns: 1 });
    sessions[0]!.turnState = "waiting";
    await controller.publish();
    ws.sent.length = 0;
    permissions = [];
    sessions[0]!.turnState = "running";
    controller.broker.emit("changed");
    const type = toolName === "AskUserQuestion" ? "question.resolved" : "permission.resolved";
    await vi.waitFor(() => expect(eventLog.replay().some(event => event.type === type)).toBe(true));
    await vi.waitFor(() => expect(ws.sent.filter(frame => frame.type === "envelope")).toHaveLength(2));
    const resolved = eventLog.replay().find(event => event.type === type)!;
    expect(resolved.data).toEqual({ requestId: "native-external", automatic: true });
    for (const frame of ws.sent) if (frame.type === "envelope") {
      expect((await paired.desktopCrypto.decrypt(frame.envelope)).payload.kind).toBe("event");
    }
  });

  it("still sends durable events to paired phones while they are offline", async () => {
    const { ws, controller, paired, published } = await fixture();
    expect(controller.onlineDevices.size).toBe(0);
    const payload = { kind: "event", event: {
      eventId: "offline-permission", seq: 1, timestamp: Date.now(), origin: "system",
      type: "permission.requested", data: { requestId: "synthetic-permission" },
    } };
    await controller.broadcast(payload);
    const frame = ws.sent.find(frame => frame.type === "envelope")!;
    if (frame.type !== "envelope") throw new Error("Expected durable envelope");
    expect(frame.envelope.temporary).toBeUndefined();
    expect((await paired.desktopCrypto.decrypt(frame.envelope)).payload).toEqual(payload);
    ws.receive({ type: "stored", ids: [frame.envelope.id] });
    await vi.advanceTimersByTimeAsync(150);
    expect(published).not.toHaveBeenCalled();
  });

  it("handles WebRTC delivery ACK signals before controller frame filtering", async () => {
    const { ws, controller, paired, config, published } = await fixture(true);
    expect(controller.socket).toBeInstanceOf(WebRtcTransport);
    const phone = await BridgeCrypto.fromPairing(paired.pairing);
    const encrypted = await phone.encrypt({
      kind: "peer-signal", action: "ack", connectionId: "synthetic-direct", ids: ["direct-delivery"],
    }, "mobile", "desktop", Date.now(), undefined, config.hostDeviceId);
    const frames = vi.fn();
    controller.socket.onFrame(frames);
    ws.receive({ type: "envelope", envelope: encrypted });
    await vi.waitFor(() => expect(frames).toHaveBeenCalledWith({
      type: "acknowledged", ids: ["direct-delivery"], byDeviceId: paired.pairing.deviceId,
    }));
    expect(ws.sent).toContainEqual({ type: "ack", ids: [encrypted.id] });
    await vi.advanceTimersByTimeAsync(150);
    expect(published).not.toHaveBeenCalled();
  });
});

it("initializes other runtimes when Claude native is unavailable without applying its old full-access policy", async () => {
  const { controller, runtimeSessions, config } = await fixture(false, true);
  const snapshot = await controller.snapshot();
  expect(runtimeSessions.initialize).toHaveBeenCalledOnce();
  expect(runtimeSessions.setHostPermissionModes).toHaveBeenCalledWith(config.runtimePermissionModes);
  expect(controller.broker.setDefaultPermissionMode).not.toHaveBeenCalled();
  expect(snapshot.host.capabilities).toContain("claude.native-relay.v1");
  expect(snapshot.host.capabilities).not.toContain("conversation.lanes.v1");
  expect(snapshot.host.capabilities).not.toContain("provider.profile.v1");
  expect(snapshot.host).not.toHaveProperty("defaultPermissionMode");
  expect(snapshot.runtimes).toEqual([
    expect.objectContaining({ id: "claude-desktop", state: "unavailable", capabilities: ["session.list", "session.history"] }),
    expect.objectContaining({ id: "codex-desktop", state: "ready" }),
  ]);
  expect(snapshot.runtimes?.[0]).not.toHaveProperty("defaultPermissionMode");
});
