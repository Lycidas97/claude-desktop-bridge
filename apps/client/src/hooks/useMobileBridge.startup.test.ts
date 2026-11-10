import { BridgeCrypto, PROTOCOL_VERSION, type BridgeHostSnapshot, type BridgeRequest, type ClientFrame, type EncryptedEnvelope, type PairingBundle, type ServerFrame } from "@bridge/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bridgeVault } from "../lib/vault.js";
import { useMobileBridge } from "./useMobileBridge.js";

const harness = vi.hoisted(() => ({
  state: undefined as any,
  refs: [] as Array<{ current: any }>,
  effects: [] as Array<() => void | (() => void)>,
  cleanups: [] as Array<() => void>,
  hosts: [] as any[],
  messages: [] as EncryptedEnvelope[],
  outbox: [] as EncryptedEnvelope[],
  requests: [] as BridgeRequest[],
  native: false,
}));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useState(initial: any) {
    harness.state = initial;
    return [initial, (update: any) => {
      harness.state = typeof update === "function" ? update(harness.state) : update;
      if (harness.refs[0]) harness.refs[0].current = harness.state;
    }];
  },
  useRef(initial: any) { const ref = { current: initial }; harness.refs.push(ref); return ref; },
  useCallback: (callback: unknown) => callback,
  useEffect(effect: () => void | (() => void)) { harness.effects.push(effect); },
}));
vi.mock("@capacitor/core", async original => {
  const value = await original<typeof import("@capacitor/core")>();
  return { ...value, Capacitor: { ...value.Capacitor, isNativePlatform: () => harness.native } };
});
vi.mock("../lib/session-notifications.js", () => ({
  ensureSessionNotificationPermission: vi.fn().mockResolvedValue(true), showSessionNotification: vi.fn(),
}));
vi.mock("../lib/vault.js", () => ({ bridgeVault: {
  listHosts: vi.fn(async () => harness.hosts),
  getHost: vi.fn(async () => harness.hosts[0]),
  listMessages: vi.fn(async () => [...harness.messages]),
  saveMessage: vi.fn(async (envelope: EncryptedEnvelope) => { harness.messages.push(envelope); }),
  listOutbox: vi.fn(async () => [...harness.outbox]),
  addOutbox: vi.fn(async (envelope: EncryptedEnvelope) => { harness.outbox.push(envelope); }),
  removeOutbox: vi.fn(async (ids: string[]) => { harness.outbox = harness.outbox.filter(envelope => !ids.includes(envelope.id)); }),
  importPairing: vi.fn(async () => undefined), setActiveEndpoint: vi.fn(async () => undefined), setDesktopRelay: vi.fn(async () => undefined), updateLanRelay: vi.fn(async () => undefined),
} }));

let pairing: PairingBundle;
let phone: BridgeCrypto;
let desktop: BridgeCrypto;
let snapshot: BridgeHostSnapshot;
let network: EventTarget & { type: string };
let page: EventTarget & { visibilityState: string };
let windowEvents: EventTarget;

// The hook, crypto, socket parsing and transport router are real. Only the WS
// boundary is synthetic; blackhole keeps an old socket OPEN without deliveries.
class LocalWebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances: LocalWebSocket[] = [];
  readyState = LocalWebSocket.CONNECTING;
  blackhole = false;
  constructor(readonly url: string) {
    super(); LocalWebSocket.instances.push(this);
    queueMicrotask(() => {
      if (this.readyState !== LocalWebSocket.CONNECTING) return;
      this.readyState = LocalWebSocket.OPEN;
      this.dispatchEvent(new Event("open"));
    });
  }
  send(raw: string) {
    if (this.blackhole) return;
    const frame = JSON.parse(raw) as ClientFrame;
    if (frame.type === "hello") {
      this.receive({ type: "ready", connectionId: "synthetic", queued: 0, online: ["desktop", "mobile"], onlineDevices: [{ role: "desktop", deviceId: pairing.hostId }] });
    } else if (frame.type === "ping") {
      this.receive({ type: "pong", at: frame.at });
    } else if (frame.type === "envelope") {
      void this.answer(frame.envelope);
    }
  }
  async answer(envelope: EncryptedEnvelope) {
    const decrypted = await desktop.decrypt(envelope);
    if (decrypted.payload.kind !== "request") return;
    const request = decrypted.payload;
    harness.requests.push(request);
    this.receive({ type: "stored", ids: [envelope.id] });
    const result = request.method === "snapshot.get" ? { snapshot }
      : request.method === "events.resume" ? { events: [], latestSeq: snapshot.latestSeq }
        : request.method === "turn.start" ? { state: "submitted", commandId: "synthetic-command" } : {};
    const reply = await desktop.encrypt({ kind: "response", requestId: request.requestId, ok: true, result }, "desktop", "mobile", Date.now(), undefined, pairing.deviceId, true);
    this.receive({ type: "envelope", envelope: reply });
  }
  receive(frame: ServerFrame) {
    if (this.readyState === LocalWebSocket.OPEN) this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
  }
  close() {
    if (this.readyState === LocalWebSocket.CLOSED) return;
    this.readyState = LocalWebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }
}

function mount() {
  const bridge = useMobileBridge();
  for (const effect of harness.effects) {
    const cleanup = effect();
    if (cleanup) harness.cleanups.push(cleanup);
  }
  return bridge;
}

beforeEach(async () => {
  vi.useFakeTimers();
  harness.state = undefined; harness.refs = []; harness.effects = []; harness.cleanups = [];
  harness.hosts = []; harness.messages = []; harness.outbox = []; harness.requests = []; harness.native = false;
  vi.clearAllMocks(); LocalWebSocket.instances = [];
  const host = await BridgeCrypto.createHost("wss://synthetic.example/ws", "Synthetic desktop");
  const device = await BridgeCrypto.createDevicePairing({ hostId: host.crypto.identity.deviceId, roomId: host.crypto.identity.roomId, relayUrl: host.crypto.identity.relayUrl, desktopName: "Synthetic desktop" });
  pairing = device.pairing; phone = await BridgeCrypto.fromPairing(pairing);
  desktop = device.desktopCrypto.withSenderDevice(pairing.hostId);
  snapshot = {
    host: { hostId: pairing.hostId, pairingEpoch: 1, name: "Synthetic desktop", online: true, capabilities: ["claude.native-relay.v1"] },
    runtime: { activeTurns: 0 }, sessions: [{ sessionId: "native", runtimeId: "claude-desktop", transport: "claude-desktop-native", ownership: "DESKTOP_NATIVE_IDLE", turnState: "idle", allowedActions: { canSend: true } }],
    projects: [], permissions: [], latestSeq: 0,
  } as unknown as BridgeHostSnapshot;
  network = Object.assign(new EventTarget(), { type: "wifi" });
  page = Object.assign(new EventTarget(), { visibilityState: "visible" });
  windowEvents = new EventTarget();
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  vi.stubGlobal("window", windowEvents); vi.stubGlobal("document", page);
  vi.stubGlobal("navigator", { connection: network, onLine: true, userAgent: "Synthetic browser", vibrate: vi.fn() });
  vi.stubGlobal("WebSocket", LocalWebSocket); vi.stubGlobal("RTCPeerConnection", undefined);
  harness.hosts = [{ ...pairing, crypto: phone, roomId: pairing.roomId, desktopName: pairing.desktopName, relayUrl: pairing.relayUrl, updatedAt: 1, needsRepair: false }];
});
afterEach(() => {
  for (const cleanup of harness.cleanups.reverse()) cleanup();
  for (const socket of LocalWebSocket.instances) socket.close();
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe("startup and network recovery", () => {
  it("decrypts the startup cache once and requests one snapshot across ready/connected/presence", async () => {
    const cached = await Promise.all(Array.from({ length: 106 }, () => desktop.encrypt({ kind: "snapshot", snapshot }, "desktop", "mobile", Date.now(), undefined, pairing.deviceId)));
    harness.messages = [...cached];
    const decrypt = vi.spyOn(phone, "decrypt");
    mount();
    await vi.waitFor(() => expect(bridgeVault.saveMessage).toHaveBeenCalled());
    const socket = LocalWebSocket.instances[0]!;
    socket.receive({ type: "presence", role: "desktop", deviceId: pairing.hostId, online: true });
    await vi.advanceTimersByTimeAsync(150);
    expect(bridgeVault.listMessages).toHaveBeenCalledTimes(1);
    expect(decrypt.mock.calls.filter(([envelope]) => cached.includes(envelope))).toHaveLength(106);
    expect(harness.requests.filter(request => request.method === "snapshot.get")).toHaveLength(1);
  });

  it("waits for an offline desktop to appear, then synchronizes once", async () => {
    const original = LocalWebSocket.prototype.receive;
    vi.spyOn(LocalWebSocket.prototype, "receive").mockImplementation(function (this: LocalWebSocket, frame) {
      original.call(this, frame.type === "ready" ? { ...frame, online: ["mobile"], onlineDevices: [] } : frame);
    });
    mount();
    await vi.waitFor(() => expect(harness.state.connection).toBe("connected"));
    expect(harness.requests).toHaveLength(0);
    LocalWebSocket.instances[0]!.receive({ type: "presence", role: "desktop", deviceId: pairing.hostId, online: true });
    await vi.waitFor(() => expect(bridgeVault.saveMessage).toHaveBeenCalledOnce());
    expect(harness.requests.filter(request => request.method === "snapshot.get")).toHaveLength(1);
  });

  it("caches the validated pairing snapshot without pulling a second complete copy", async () => {
    harness.hosts = [];
    const bridge = mount();
    let paired: boolean | undefined;
    void bridge.pair(pairing).then(result => { paired = result; });
    await vi.waitFor(() => expect(paired).toBe(true));
    expect(bridgeVault.importPairing).toHaveBeenCalledOnce();
    expect(harness.requests.filter(request => request.method === "snapshot.get")).toHaveLength(1);
    const saved = await Promise.all(harness.messages.map(envelope => phone.decrypt(envelope)));
    expect(saved.some(message => message.payload.kind === "snapshot" && message.payload.snapshot.host.hostId === pairing.hostId)).toBe(true);
  });

  it("reconnects once when Android reports online before publishing the new interface type", async () => {
    mount();
    await vi.waitFor(() => expect(bridgeVault.saveMessage).toHaveBeenCalled());
    LocalWebSocket.instances[0]!.blackhole = true;
    Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
    network.type = "none";
    network.dispatchEvent(new Event("change"));
    Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
    windowEvents.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(9);
    network.type = "cellular";
    network.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(LocalWebSocket.instances.at(-1)!.readyState).toBe(LocalWebSocket.OPEN));
    expect(LocalWebSocket.instances).toHaveLength(2);
  });

  it.each(["online", "hidden-online", "network-type"])("rebuilds a blackholed OPEN connection on %s without reloading cache or changing queued input identity", async signal => {
    const bridge = mount();
    await vi.waitFor(() => expect(bridgeVault.saveMessage).toHaveBeenCalled());
    const old = LocalWebSocket.instances[0]!;
    old.blackhole = true;
    const receipt = await bridge.sendTurn("native", "Synthetic queued input");
    expect(harness.outbox).toHaveLength(1);
    const reads = vi.mocked(bridgeVault.listMessages).mock.calls.length;
    if (signal === "network-type") {
      network.type = "cellular"; network.dispatchEvent(new Event("change"));
    } else {
      if (signal === "hidden-online") page.visibilityState = "hidden";
      windowEvents.dispatchEvent(new Event("online"));
      page.visibilityState = "visible"; page.dispatchEvent(new Event("visibilitychange"));
    }
    await vi.waitFor(() => expect(LocalWebSocket.instances).toHaveLength(2));
    expect(old.readyState).toBe(LocalWebSocket.CLOSED);
    await vi.waitFor(() => expect(harness.requests.some(request => request.method === "turn.start")).toBe(true));
    await vi.waitFor(() => expect(harness.outbox).toHaveLength(0));
    // Unconfirmed envelopes may be replayed; the host must receive the same
    // request/idempotency identity rather than a newly-created command.
    expect(new Set(harness.requests.filter(request => request.method === "turn.start").map(request => request.requestId))).toEqual(new Set([receipt.requestId]));
    expect(new Set(harness.requests.filter(request => request.method === "turn.start").map(request => request.idempotencyKey)).size).toBe(1);
    expect(bridgeVault.listMessages).toHaveBeenCalledTimes(reads);
    expect(harness.requests.filter(request => request.method === "snapshot.get")).toHaveLength(2);
    network.dispatchEvent(new Event("change"));
    expect(LocalWebSocket.instances).toHaveLength(2);
  });
});
