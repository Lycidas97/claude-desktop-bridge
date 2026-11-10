import type { BridgeCrypto, BridgeEvent, BridgeHostSnapshot, BridgeRequest, BridgeResponse, BridgeSessionInfo, DecryptedEnvelope, EncryptedEnvelope, ServerFrame, SocketState } from "@bridge/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMobileBridge } from "./useMobileBridge.js";
import { bridgeVault } from "../lib/vault.js";
import { PROTOCOL_VERSION } from "@bridge/protocol";

const harness = vi.hoisted(() => ({
  state: undefined as any,
  commitStateImmediately: true,
  refs: [] as Array<{ current: any }>,
  requests: [] as Array<{ host: string; request: BridgeRequest }>,
  respond: undefined as unknown as (request: BridgeRequest) => Promise<Record<string, unknown>>,
  cacheEncrypt: vi.fn(),
  saveMessage: vi.fn(),
  listMessages: vi.fn(),
  addOutbox: vi.fn(),
  changeConnection: undefined as unknown as (connection: SocketState) => void,
  frame: undefined as unknown as (frame: ServerFrame) => void,
  receive: undefined as unknown as (message: DecryptedEnvelope, encrypted: EncryptedEnvelope) => void,
  native: false,
  notify: vi.fn(),
}));

vi.mock("@capacitor/core", async (importOriginal) => {
  const original = await importOriginal<typeof import("@capacitor/core")>();
  return { ...original, Capacitor: { ...original.Capacitor, isNativePlatform: () => harness.native } };
});
vi.mock("../lib/session-notifications.js", () => ({
  ensureSessionNotificationPermission: vi.fn().mockResolvedValue(true),
  showSessionNotification: harness.notify,
}));

vi.mock("@bridge/protocol", async (importOriginal) => ({
  ...await importOriginal<typeof import("@bridge/protocol")>(),
  TransportRouter: class {
    state: SocketState = "connected";
    endpoint = "wss://relay.example/ws";
    path = "public-relay";
    connect() {}
    close() {}
    onState(listener: (connection: SocketState) => void) {
      harness.changeConnection = connection => { this.state = connection; listener(connection); };
    }
    onMetrics() {}
    onFrame(listener: typeof harness.frame) { harness.frame = listener; }
    onMessage(receive: typeof harness.receive) { harness.receive = receive; }
    ack() {}
  },
}));

vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useState(initial: any) {
    harness.state = { ...initial, ...harness.state };
    return [harness.state, (update: any) => {
      harness.state = typeof update === "function" ? update(harness.state) : update;
      if (harness.commitStateImmediately && harness.refs[0]) harness.refs[0].current = harness.state;
    }];
  },
  useRef(initial: unknown) {
    const index = harness.refs.length;
    const ref = { current: initial as any };
    if (index === 1) ref.current = hostCrypto("A");
    if (index === 3) ref.current = socket("A");
    harness.refs.push(ref);
    return ref;
  },
  useCallback: (callback: unknown) => callback,
  useEffect: () => undefined,
}));

vi.mock("../lib/vault.js", () => ({
  bridgeVault: {
    saveMessage: harness.saveMessage, addOutbox: harness.addOutbox, updateLanRelay: vi.fn(), setDesktopRelay: vi.fn().mockResolvedValue(undefined),
    getHost: vi.fn().mockResolvedValue({ relayEndpoints: [] }),
    listMessages: harness.listMessages, listOutbox: vi.fn().mockResolvedValue([]), removeOutbox: vi.fn().mockResolvedValue(undefined),
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function snapshot(host: string): BridgeHostSnapshot {
  return {
    host: { hostId: host, name: host, online: true, capabilities: [] },
    sessions: [], projects: [], permissions: [], latestSeq: 0,
  } as unknown as BridgeHostSnapshot;
}

function hostCrypto(host: string) {
  return {
    identity: { roomId: host, deviceId: `phone-${host}`, hostId: host },
    encrypt: async (request: BridgeRequest) => ({ id: request.requestId, sentAt: 1, request }),
    withSenderDevice: () => ({ encrypt: harness.cacheEncrypt }),
  } as unknown as BridgeCrypto;
}

function socket(host: string) {
  return {
    state: "connected",
    close() {},
    async sendEnvelope({ request }: { request: BridgeRequest }) {
      harness.requests.push({ host, request });
      try {
        const result = await harness.respond(request);
        const pending = harness.refs[6]!.current.get(request.requestId);
        clearTimeout(pending.timer);
        harness.refs[6]!.current.delete(request.requestId);
        pending.resolve({ kind: "response", requestId: request.requestId, ok: true, result } satisfies BridgeResponse);
      } catch (error) {
        const pending = harness.refs[6]!.current.get(request.requestId);
        clearTimeout(pending.timer);
        harness.refs[6]!.current.delete(request.requestId);
        pending.reject(error);
      }
    },
  };
}

function switchHost(host: string, replaceCrypto = true) {
  if (replaceCrypto) harness.refs[1]!.current = hostCrypto(host);
  harness.refs[3]!.current = socket(host);
  harness.state = { ...harness.state, activeHostId: host, desktopName: host, snapshot: snapshot(host), events: [], latestSeq: 0, histories: {}, evidence: {}, error: undefined };
  harness.refs[0]!.current = harness.state;
}

beforeEach(() => {
  harness.refs = [];
  harness.native = false;
  harness.notify.mockReset().mockResolvedValue(undefined);
  harness.commitStateImmediately = true;
  harness.requests = [];
  harness.state = { activeHostId: "A", desktopName: "A", snapshot: snapshot("A") };
  harness.cacheEncrypt.mockReset().mockResolvedValue({ id: "cached-A" });
  harness.saveMessage.mockReset().mockResolvedValue(undefined);
  harness.listMessages.mockReset().mockResolvedValue([]);
  harness.addOutbox.mockReset().mockResolvedValue(undefined);
  vi.mocked(bridgeVault.listOutbox).mockReset().mockResolvedValue([]);
  vi.mocked(bridgeVault.removeOutbox).mockReset().mockResolvedValue(undefined);
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
  });
  harness.respond = async (request) => {
    if (request.method === "events.resume") return { events: [], latestSeq: 0 };
    if (request.method === "snapshot.get") return { snapshot: snapshot("A") };
    return {};
  };
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("session creation project identity", () => {
  it.each([undefined, "project-2"])("preserves RPC compatibility and merges the returned session (projectId=%s)", async projectId => {
    const existing: BridgeSessionInfo = {
      sessionId: "existing", projectId: "project-1", projectName: "First project", cwd: "/tmp/project", title: "Existing",
      source: "bridge", ownership: "BRIDGE_IDLE", transport: "bridge-host", turnState: "idle", lastActivityAt: 1, pendingCount: 0,
    };
    const current = snapshot("A");
    current.sessions = [existing];
    current.projects = [
      { projectId: "project-1", name: "First project", cwd: "/tmp/project", sessionCount: 1, runningCount: 0, pendingCount: 0, lastActivityAt: 1 },
      { projectId: "project-2", name: "Second project", cwd: "/tmp/project", sessionCount: 0, runningCount: 0, pendingCount: 0, lastActivityAt: 1 },
    ];
    harness.state.snapshot = current;
    const created: BridgeSessionInfo = { ...existing, sessionId: "created", title: "Created", lastActivityAt: 2,
      projectId: projectId ?? "project-1", projectName: projectId ? "Second project" : "First project",
    };
    harness.respond = async () => ({ session: created });
    const bridge = useMobileBridge();
    await expect(projectId === undefined
      ? bridge.createSession("/tmp/project", "Created", "claude-desktop")
      : bridge.createSession("/tmp/project", "Created", "claude-desktop", projectId)).resolves.toEqual(created);
    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0]!.request).toMatchObject({ method: "session.create", params: {
      cwd: "/tmp/project", title: "Created", runtimeId: "claude-desktop",
    } });
    if (projectId === undefined) expect(harness.requests[0]!.request.params).not.toHaveProperty("projectId");
    else expect(harness.requests[0]!.request.params).toHaveProperty("projectId", projectId);
    expect(harness.state.snapshot.sessions).toEqual([created, existing]);
    expect(harness.state.snapshot.projects).toEqual(current.projects);
  });
});

describe("session display-name renaming", () => {
  it("sends the complete logical ID and applies the returned title without changing session order or runtime state", async () => {
    const session: BridgeSessionInfo = {
      sessionId: "claude-desktop:logical-target", projectId: "project", projectName: "Project", cwd: "/tmp/project", title: "Old name",
      source: "desktop", ownership: "BRIDGE_RUNNING", transport: "bridge-host", turnState: "running", lastActivityAt: 123,
      activeTurnId: "active", pendingCount: 1, pendingCommandIds: ["queued"],
    };
    const sibling = { ...session, sessionId: "sibling", title: "Sibling", lastActivityAt: 456 };
    harness.state.snapshot.sessions = [sibling, session];
    harness.state.localTurns = [{ sessionId: session.sessionId, commandId: "queued", text: "Keep queued message", delivery: "host-received" }];
    const before = harness.state.snapshot;
    const localTurns = harness.state.localTurns;
    const renamed = { ...session, title: "Server canonical title" };
    harness.respond = async () => ({ session: renamed });
    const bridge = useMobileBridge();
    await expect(bridge.renameSession(session.sessionId, "Requested title")).resolves.toBeUndefined();
    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0]!.request).toMatchObject({ method: "session.rename", params: { sessionId: session.sessionId, title: "Requested title" } });
    expect(harness.requests[0]!.request.params).toEqual({ sessionId: session.sessionId, title: "Requested title", client: { name: "Web 客户端", platform: "web" } });
    expect(harness.state.snapshot.sessions).toEqual([sibling, renamed]);
    expect(harness.state.snapshot.projects).toBe(before.projects);
    expect(harness.state.localTurns).toBe(localTurns);
    expect(harness.addOutbox).not.toHaveBeenCalled();
  });

  it.each(["turn.queued", "session.deleted"] as const)("preserves a newer %s event received before the rename response", async type => {
    vi.useFakeTimers();
    vi.stubGlobal("document", { visibilityState: "visible" });
    const bridge = useMobileBridge();
    await bridge.retryConnection();
    const session: BridgeSessionInfo = {
      sessionId: "target", projectId: "project", projectName: "Project", cwd: "/tmp/project", title: "Old name",
      source: "desktop", ownership: "DESKTOP_OBSERVED", transport: "bridge-host", turnState: "running",
      lastActivityAt: 10, activeTurnId: "active", pendingCount: 0, pendingCommandIds: [],
    };
    harness.state.snapshot = { ...snapshot("A"), sessions: [session], latestSeq: 10 };
    harness.state.latestSeq = 10;
    harness.refs[3]!.current.sendEnvelope = socket("A").sendEnvelope;
    const response = deferred<Record<string, unknown>>();
    harness.respond = async request => request.method === "session.rename" ? response.promise : {};
    const saving = bridge.renameSession(session.sessionId, "New name");
    await vi.waitFor(() => expect(harness.requests.some(({ request }) => request.method === "session.rename")).toBe(true));
    const event: BridgeEvent = { eventId: "newer-event", sessionId: session.sessionId, seq: 11, timestamp: 11, origin: "system", type, data: { commandId: "queue-1" } };
    harness.receive({ payload: { kind: "event", event }, header: { sentAt: Date.now() } } as DecryptedEnvelope, { id: event.eventId } as EncryptedEnvelope);
    const latest = harness.state.snapshot.sessions[0];
    if (type === "turn.queued") expect(latest).toMatchObject({ turnState: "running", pendingCount: 1, pendingCommandIds: ["queue-1"] });
    else expect(harness.state.snapshot.sessions).toEqual([]);
    response.resolve({ session: { ...session, title: "New name" } });
    await saving;
    try {
      expect(harness.state.snapshot.latestSeq).toBe(11);
      expect(harness.state.latestSeq).toBe(11);
      expect(harness.state.snapshot.sessions).toEqual(type === "turn.queued" ? [{ ...latest, title: "New name" }] : []);
    } finally { bridge.backToHosts(); vi.clearAllTimers(); }
  });

  it("rejects an offline rename without queuing it", async () => {
    const bridge = useMobileBridge();
    harness.refs[3]!.current.state = "closed";
    await expect(bridge.renameSession("target", "New name")).rejects.toThrow("电脑当前离线");
    expect(harness.requests).toEqual([]);
    expect(harness.addOutbox).not.toHaveBeenCalled();
  });

  it("surfaces the server error and leaves the snapshot untouched", async () => {
    const before = harness.state.snapshot;
    const bridge = useMobileBridge();
    harness.refs[3]!.current.sendEnvelope = async ({ request }: { request: BridgeRequest }) => {
      harness.requests.push({ host: "A", request });
      const pending = harness.refs[6]!.current.get(request.requestId);
      clearTimeout(pending.timer);
      harness.refs[6]!.current.delete(request.requestId);
      pending.resolve({ kind: "response", requestId: request.requestId, ok: false, error: { code: "INVALID_PARAMS", message: "会话名称过长" } });
    };
    await expect(bridge.renameSession("target", "New name")).rejects.toThrow("会话名称过长");
    expect(harness.state.snapshot).toBe(before);
    expect(harness.addOutbox).not.toHaveBeenCalled();
  });
});

describe("retired Claude Host actions", () => {
  it("keeps legacy callbacks non-executable", async () => {
    const bridge = useMobileBridge();
    await expect(bridge.takeoverDesktop("target")).rejects.toThrow("不再支持 Bridge 接管");
    await expect(bridge.returnToDesktop("target")).rejects.toThrow("无需交还");
    await expect(bridge.previewProviderSwitch("target", "api")).rejects.toThrow("Desktop 管理");
    await expect(bridge.configureHostPermission("claude-desktop", "full-access")).rejects.toThrow("Desktop 管理");
    expect(harness.requests).toEqual([]);
    expect(harness.addOutbox).not.toHaveBeenCalled();
  });
});

function nativeSnapshot(): BridgeHostSnapshot {
  const current = snapshot("A");
  current.host.capabilities = ["claude.native-relay.v1"];
  current.sessions = [{ sessionId: "session-1", runtimeId: "claude-desktop", transport: "claude-desktop-native", ownership: "DESKTOP_NATIVE_IDLE", turnState: "idle",
    allowedActions: { canSend: true, canSteer: true, canInterrupt: true, canConfigure: true, canSwitchProvider: false, canContinueOfficial: false } } as BridgeSessionInfo];
  return current;
}

describe("native snapshot approval notifications", () => {
  it.each(["hidden", "visible"])("notifies new pending requests only once while %s", async visibilityState => {
    vi.useFakeTimers();
    vi.stubGlobal("document", { visibilityState });
    vi.stubGlobal("navigator", { vibrate: vi.fn() });
    harness.native = true;
    vi.mocked(bridgeVault.getHost).mockResolvedValueOnce({
      relayEndpoints: [{ id: "public", kind: "public-relay", url: "wss://relay.example/ws", priority: 1 }],
    } as Awaited<ReturnType<typeof bridgeVault.getHost>>);
    const bridge = useMobileBridge();
    await bridge.retryConnection();
    const current = nativeSnapshot();
    current.sessions[0]!.title = "Native task";
    current.permissions = [{ requestId: "native-request", sessionId: "session-1", toolUseId: "tool", toolName: "Bash", input: {}, createdAt: 1, canAllowAlways: false }];
    const message = { header: { sentAt: Date.now() }, payload: { kind: "snapshot", snapshot: current } } as DecryptedEnvelope;
    harness.receive(message, { id: "first-native-snapshot" } as EncryptedEnvelope);
    harness.receive(message, { id: "repeated-native-snapshot" } as EncryptedEnvelope);
    if (visibilityState === "hidden") {
      expect(harness.notify).toHaveBeenCalledExactlyOnceWith({ hostId: "A", sessionId: "session-1" }, "Native task", "Claude 正在等待你处理");
    } else {
      expect(harness.notify).not.toHaveBeenCalled();
    }
  });
});

describe("durable sends during transport failure", () => {
  beforeEach(() => { harness.state.snapshot = nativeSnapshot(); });

  it("keeps outgoing image bytes only in the existing transport envelope and in-memory preview", async () => {
    const bridge = useMobileBridge();
    const attachments = [{ id: "image", name: "photo.png", mimeType: "image/png" as const, size: 8, data: btoa("picture") }];
    await bridge.sendTurn("session-1", "[图片] 用户手写", attachments);
    expect(harness.state.localTurns[0].attachments).toEqual(attachments);
    expect(harness.saveMessage).toHaveBeenCalledOnce();
    expect(harness.addOutbox).toHaveBeenCalledOnce();
    expect(harness.saveMessage.mock.calls[0]![0]).toBe(harness.addOutbox.mock.calls[0]![0]);
  });
  it.each([false, true])("keeps a persisted message queued without restoring the draft (steer=%s)", async steer => {
    const bridge = useMobileBridge();
    const send = vi.fn().mockRejectedValue(new Error("Socket is not connected"));
    harness.refs[11]!.current = true;
    harness.refs[3]!.current.sendEnvelope = send;
    const receipt = await bridge.sendTurn("session-1", "Continue", [], steer);
    expect(receipt).toEqual({ requestId: expect.any(String) });
    expect(harness.addOutbox).toHaveBeenCalledOnce();
    expect(harness.saveMessage).toHaveBeenCalledOnce();
    expect(harness.state.localTurns).toHaveLength(1);
    expect(harness.state.localTurns[0]).toMatchObject({ text: "Continue", delivery: "local-saved" });
    expect(send).toHaveBeenCalledOnce();
    const envelope = harness.addOutbox.mock.calls[0]![0];
    expect(send).toHaveBeenCalledWith(envelope);
    expect(receipt).toEqual({ requestId: envelope.request.requestId });
    expect(harness.state.localTurns[0].requestId).toBe(envelope.request.requestId);
    expect(envelope.request.method).toBe(steer ? "turn.steer" : "turn.start");
  });

  it("surfaces a persistence failure before attempting network delivery", async () => {
    const bridge = useMobileBridge();
    harness.addOutbox.mockRejectedValueOnce(new Error("Storage quota exceeded"));
    const send = vi.fn();
    harness.refs[3]!.current.sendEnvelope = send;
    await expect(bridge.sendTurn("session-1", "Continue")).rejects.toThrow("Storage quota");
    expect(send).not.toHaveBeenCalled();
    expect(harness.state.localTurns).toEqual([]);
  });

  it("surfaces a transport failure for a non-durable action", async () => {
    const bridge = useMobileBridge();
    harness.refs[3]!.current.sendEnvelope = vi.fn().mockRejectedValue(new Error("Socket is not connected"));
    await expect(bridge.interruptTurn("session-1")).rejects.toThrow("Socket is not connected");
    expect(harness.addOutbox).not.toHaveBeenCalled();
  });
});

describe("native submission responses", () => {
  it.each(["local-saved", "session-received", "queued", "running", "completed"] as const)("records RPC submission without regressing %s", async delivery => {
    vi.useFakeTimers(); vi.stubGlobal("document", { visibilityState: "visible" });
    const bridge = useMobileBridge(); await bridge.retryConnection();
    harness.state.localTurns = [{ requestId: "request", idempotencyKey: "key", sessionId: "session-1", text: "Task", attachments: [], createdAt: 1, delivery }];
    harness.receive({ header: { sentAt: Date.now() }, payload: { kind: "response", requestId: "request", ok: true, result: { commandId: "command", messageId: "uuid", state: "submitted" } } } as DecryptedEnvelope, { id: "response" } as EncryptedEnvelope);
    expect(harness.state.localTurns[0]).toMatchObject({ delivery: delivery === "local-saved" ? "submitted" : delivery, commandId: "command" });
  });

  it("restores submitted from a cached RPC response while stripping outgoing preview bytes", async () => {
    vi.useFakeTimers(); vi.stubGlobal("document", { visibilityState: "visible" });
    const bridge = useMobileBridge();
    const request: BridgeRequest = { kind: "request", method: "turn.start", requestId: "request", idempotencyKey: "key", params: { sessionId: "session-1", text: "Task", attachments: [{ id: "image", name: "photo.png", mimeType: "image/png", size: 8, data: btoa("picture") }] } };
    const cached = [{ id: "request", payload: request }, { id: "response", payload: { kind: "response", requestId: "request", ok: true, result: { state: "submitted", commandId: "command" } } }];
    harness.listMessages.mockResolvedValue(cached);
    harness.refs[1]!.current.decrypt = async (envelope: any) => ({ header: { from: envelope.id === "request" ? "mobile" : "desktop", sentAt: 1 }, payload: envelope.payload });
    await bridge.retryConnection();
    expect(harness.state.localTurns[0]).toMatchObject({ delivery: "submitted", commandId: "command", attachments: [{ id: "image", name: "photo.png", mimeType: "image/png", size: 8 }] });
    expect(harness.state.localTurns[0].attachments[0].data).toBeUndefined();
  });
});

describe("native relay outbox", () => {
  it("holds a new cached native turn until this connection verifies the native capability", async () => {
    harness.state.snapshot = nativeSnapshot();
    const bridge = useMobileBridge();
    const send = vi.fn().mockResolvedValue(undefined);
    harness.refs[3]!.current.sendEnvelope = send;
    await bridge.sendTurn("session-1", "Saved until native handshake");
    expect(harness.addOutbox).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
    expect(harness.state.localTurns[0].delivery).toBe("local-saved");
  });

  it.each(["local-saved", "uncertain"] as const)("skips retired execution requests without changing %s delivery or blocking native input", async delivery => {
    vi.useFakeTimers();
    vi.stubGlobal("document", { visibilityState: "visible" });
    harness.state.snapshot = nativeSnapshot();
    const bridge = useMobileBridge();
    const image = { id: "image", name: "context.png", mimeType: "image/png", size: 7, data: "cGljdHVyZQ==" };
    const request = { kind: "request", method: "turn.start", requestId: "legacy", idempotencyKey: "legacy-key",
      params: { sessionId: "session-1", text: "Original input", attachments: [image], bridgeExecutionRequested: true } };
    const base = { version: PROTOCOL_VERSION, roomId: "A", from: "mobile", fromDeviceId: "phone-A", to: "desktop", sentAt: Date.now(), expiresAt: Date.now() + 60_000 };
    const legacy = { ...base, id: "legacy-envelope", request } as unknown as EncryptedEnvelope;
    const next = { ...base, id: "next-envelope", request: { ...request, requestId: "next", idempotencyKey: "next-key", params: { sessionId: "session-1", text: "Explicit native input", attachments: [] } } } as unknown as EncryptedEnvelope;
    vi.mocked(bridgeVault.listOutbox).mockResolvedValue([legacy, next]);
    harness.listMessages.mockResolvedValue([legacy]);
    harness.refs[1]!.current.decrypt = async (envelope: any) => ({ header: { from: "mobile", sentAt: envelope.sentAt }, payload: envelope.request });
    await bridge.retryConnection();
    harness.state.localTurns[0].delivery = delivery;
    const send = vi.fn().mockResolvedValue(undefined);
    harness.refs[3]!.current.sendEnvelope = send;
    const fresh = () => {
      harness.refs[6]!.current.set("fresh", { resolve: vi.fn(), reject: vi.fn(), timer: setTimeout(() => {}, 10_000) });
      harness.receive({ header: { sentAt: Date.now() }, payload: { kind: "response", requestId: "fresh", ok: true, result: { snapshot: nativeSnapshot() } } } as DecryptedEnvelope, { id: "fresh" } as EncryptedEnvelope);
    };
    fresh();
    await vi.waitFor(() => expect(send).toHaveBeenCalledExactlyOnceWith(next));
    expect(harness.state.localTurns.find((turn: any) => turn.requestId === "legacy")).toMatchObject({
      text: "Original input", delivery, bridgeExecutionRequested: true,
      attachments: [{ id: "image", name: "context.png", mimeType: "image/png", size: 7 }],
    });
    expect(harness.state.localTurns.find((turn: any) => turn.requestId === "legacy").error).toBeUndefined();
    expect(harness.saveMessage).not.toHaveBeenCalledWith(expect.objectContaining({ request: expect.objectContaining({ requestId: "legacy" }) }));
    expect((await bridgeVault.listOutbox("A"))[0]).toBe(legacy);
    await Promise.resolve();
    fresh();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls.every(([envelope]) => envelope === next)).toBe(true);
    bridge.backToHosts();
  });

  it("rejects writable legacy Claude snapshots and allows Codex sends without native Claude capability", async () => {
    const bridge = useMobileBridge();
    harness.refs[3]!.current.sendEnvelope = vi.fn().mockResolvedValue(undefined);
    harness.state.snapshot.sessions = [{ ...nativeSnapshot().sessions[0], transport: "bridge-host", ownership: "BRIDGE_IDLE" }];
    await expect(bridge.sendTurn("session-1", "Keep draft")).rejects.toThrow("原生中转");
    expect(harness.addOutbox).not.toHaveBeenCalled();
    harness.state.snapshot.sessions[0].runtimeId = "codex-desktop";
    await bridge.sendTurn("session-1", "Codex input");
    expect(harness.addOutbox).toHaveBeenCalledOnce();
    expect(harness.addOutbox.mock.calls[0]![0].request.params).not.toHaveProperty("bridgeExecutionRequested");
  });
});

describe("native relay connection boundaries", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("document", { visibilityState: "visible" });
  });

  function queuedTurn(requestId: string, method: "turn.start" | "turn.steer" = "turn.start", legacy = false): EncryptedEnvelope & { request: BridgeRequest } {
    return {
      version: PROTOCOL_VERSION, roomId: "A", from: "mobile", fromDeviceId: "phone-A", to: "desktop",
      id: `envelope-${requestId}`, sentAt: Date.now(), expiresAt: Date.now() + 60_000, nonce: "mock-nonce", ciphertext: "mock-ciphertext",
      request: { kind: "request", requestId, idempotencyKey: `key-${requestId}`, method,
        params: { sessionId: "session-1", text: requestId, attachments: [], ...(legacy ? { bridgeExecutionRequested: true } : {}) } },
    };
  }

  it.each([false, true])("rejects a writable legacy snapshot loaded from storage before persisting new input (steer=%s)", async steer => {
    const cached = nativeSnapshot();
    cached.host.capabilities = [];
    cached.sessions[0] = { ...cached.sessions[0]!, transport: "bridge-host", ownership: "BRIDGE_IDLE" };
    harness.listMessages.mockResolvedValue([{ id: "cached-legacy" }]);
    const bridge = useMobileBridge();
    harness.refs[1]!.current.decrypt = async () => ({ header: { from: "desktop", sentAt: Date.now() }, payload: { kind: "snapshot", snapshot: cached } });
    await bridge.retryConnection();
    const send = vi.fn().mockResolvedValue(undefined);
    harness.refs[3]!.current.sendEnvelope = send;
    try {
      expect(harness.state.snapshot).toEqual(cached);
      await expect(bridge.sendTurn("session-1", "Keep draft", [], steer)).rejects.toThrow("原生中转");
      expect(harness.addOutbox).not.toHaveBeenCalled();
      expect(harness.saveMessage).not.toHaveBeenCalled();
      expect(harness.state.localTurns).toEqual([]);
      expect(send).not.toHaveBeenCalled();
    } finally { bridge.backToHosts(); vi.clearAllTimers(); }
  });

  it("requires a matching live snapshot response after loading a native cache, even when the relay sees Desktop", async () => {
    const cached = { id: "cached-native" } as EncryptedEnvelope;
    const queued = queuedTurn("queued");
    const outbox: EncryptedEnvelope[] = [queued];
    harness.listMessages.mockResolvedValue([cached, queued]);
    vi.mocked(bridgeVault.listOutbox).mockImplementation(async () => [...outbox]);
    harness.addOutbox.mockImplementation(async envelope => { outbox.push(envelope); });
    const bridge = useMobileBridge();
    const decrypt = vi.fn(async (envelope: any) => envelope === cached
      ? { header: { from: "desktop", sentAt: Date.now() }, payload: { kind: "snapshot", snapshot: nativeSnapshot() } }
      : { header: { from: "mobile", sentAt: envelope.sentAt }, payload: envelope.request });
    harness.refs[1]!.current.decrypt = decrypt;
    harness.refs[1]!.current.encrypt = async (request: BridgeRequest) => ({ ...queuedTurn(request.requestId), request });
    await bridge.retryConnection();
    const send = vi.fn(async (envelope: typeof queued) => {
      if (envelope.request.method === "runtime.refresh" || envelope.request.method === "events.resume") {
        await socket("A").sendEnvelope(envelope);
      }
    });
    harness.refs[3]!.current.sendEnvelope = send;
    try {
      const receipt = await bridge.sendTurn("session-1", "Saved from native cache");
      const saved = outbox[1]!;
      harness.frame({ type: "ready", connectionId: "relay-only", queued: 0, online: ["desktop"], onlineDevices: [{ role: "desktop", deviceId: "desktop-A" }] });
      await vi.waitFor(() => expect(decrypt).toHaveBeenCalledWith(saved));
      for (const age of [0, 61_000]) {
        harness.receive({ header: { sentAt: Date.now() - age }, payload: { kind: "response", requestId: "unmatched", ok: true, result: { snapshot: nativeSnapshot() } } } as DecryptedEnvelope, { id: `unmatched-${age}` } as EncryptedEnvelope);
      }
      expect(send).not.toHaveBeenCalled();
      expect(harness.state.localTurns.map((turn: any) => turn.delivery)).toEqual(["local-saved", "local-saved"]);
      const refreshing = bridge.refresh();
      await vi.waitFor(() => expect(send.mock.calls.some(([envelope]) => envelope.request.method === "snapshot.get")).toBe(true));
      const request = send.mock.calls.find(([envelope]) => envelope.request.method === "snapshot.get")![0].request;
      harness.receive({ header: { sentAt: Date.now() }, payload: { kind: "response", requestId: request.requestId, ok: true, result: { snapshot: nativeSnapshot() } } } as DecryptedEnvelope, { id: "verified" } as EncryptedEnvelope);
      await refreshing;
      await vi.waitFor(() => expect(send).toHaveBeenCalledWith(saved));
      expect(send.mock.calls.filter(([envelope]) => envelope.request.method === "turn.start").map(([envelope]) => envelope)).toEqual([queued, saved]);
      expect((saved as typeof queued).request.requestId).toBe(receipt.requestId);
      expect(harness.state.localTurns).toHaveLength(2);
      expect(harness.addOutbox).toHaveBeenCalledOnce();
      expect(bridgeVault.removeOutbox).not.toHaveBeenCalled();
    } finally { bridge.backToHosts(); vi.clearAllTimers(); }
  });

  it.each([true, false])("clears native capability on reconnect and waits for the replacement snapshot (native=%s)", async native => {
    const cached = { id: "cached-native" } as EncryptedEnvelope;
    const queued = queuedTurn("before-disconnect");
    const outbox: EncryptedEnvelope[] = [queued];
    harness.listMessages.mockResolvedValue([cached, queued]);
    vi.mocked(bridgeVault.listOutbox).mockImplementation(async () => [...outbox]);
    harness.addOutbox.mockImplementation(async envelope => { outbox.push(envelope); });
    const bridge = useMobileBridge();
    const decrypt = vi.fn(async (envelope: any) => envelope === cached
      ? { header: { from: "desktop", sentAt: Date.now() }, payload: { kind: "snapshot", snapshot: nativeSnapshot() } }
      : { header: { from: "mobile", sentAt: envelope.sentAt }, payload: envelope.request });
    harness.refs[1]!.current.decrypt = decrypt;
    harness.refs[1]!.current.encrypt = async (request: BridgeRequest) => ({ ...queuedTurn(request.requestId), request });
    await bridge.retryConnection();
    const send = vi.fn().mockResolvedValue(undefined);
    harness.refs[3]!.current.sendEnvelope = send;
    try {
      harness.receive({ header: { sentAt: Date.now() }, payload: { kind: "snapshot", snapshot: nativeSnapshot() } } as DecryptedEnvelope, { id: "first-live" } as EncryptedEnvelope);
      await vi.waitFor(() => expect(send).toHaveBeenCalledExactlyOnceWith(queued));
      harness.changeConnection("reconnecting");
      await bridge.sendTurn("session-1", "Saved while disconnected");
      const saved = outbox[1]!;
      expect(send).toHaveBeenCalledOnce();
      // BridgeSocket emits ready before its connected state transition.
      harness.frame({ type: "ready", connectionId: "replacement", queued: 0, online: ["desktop"], onlineDevices: [{ role: "desktop", deviceId: "desktop-A" }] });
      harness.changeConnection("connected");
      await vi.waitFor(() => expect(decrypt).toHaveBeenCalledWith(saved));
      expect(send.mock.calls.map(([envelope]) => envelope.request.method)).toEqual(["turn.start", "snapshot.get"]);
      const replacement = nativeSnapshot();
      if (!native) {
        replacement.host.capabilities = [];
        replacement.sessions[0] = { ...replacement.sessions[0]!, transport: "bridge-host", ownership: "BRIDGE_IDLE" };
      }
      const request = send.mock.calls[1]![0].request as BridgeRequest;
      harness.receive({ header: { sentAt: Date.now() }, payload: { kind: "response", requestId: request.requestId, ok: true, result: { snapshot: replacement } } } as DecryptedEnvelope, { id: "replacement-response" } as EncryptedEnvelope);
      await vi.waitFor(() => expect(decrypt.mock.calls.filter(([envelope]) => envelope === saved).length).toBeGreaterThanOrEqual(2));
      if (native) await vi.waitFor(() => expect(send).toHaveBeenCalledWith(saved));
      else {
        expect(send).toHaveBeenCalledTimes(2);
        await expect(bridge.sendTurn("session-1", "Keep draft after downgrade")).rejects.toThrow("原生中转");
      }
      expect(harness.state.localTurns).toHaveLength(2);
      expect(harness.state.localTurns.every((turn: any) => turn.delivery === "local-saved")).toBe(true);
      expect(harness.addOutbox).toHaveBeenCalledOnce();
      expect(bridgeVault.removeOutbox).not.toHaveBeenCalled();
    } finally { bridge.backToHosts(); vi.clearAllTimers(); }
  });

  it.each([
    { method: "turn.start", confirmation: "stored" },
    { method: "turn.steer", confirmation: "acknowledged" },
  ] as const)("reuses unconfirmed $method envelopes across flushes, then stops after $confirmation without touching retired input", async ({ method, confirmation }) => {
    const legacy = queuedTurn("legacy", method, true);
    legacy.request.params.attachments = [{ id: "image", name: "context.png", mimeType: "image/png", size: 7, data: "cGljdHVyZQ==" }];
    const next = queuedTurn("native", method);
    const original = structuredClone([legacy, next]);
    let outbox: EncryptedEnvelope[] = [legacy, next];
    harness.listMessages.mockResolvedValue([legacy, next]);
    vi.mocked(bridgeVault.listOutbox).mockImplementation(async () => [...outbox]);
    vi.mocked(bridgeVault.removeOutbox).mockImplementation(async ids => { outbox = outbox.filter(envelope => !(Array.isArray(ids) ? ids : [ids]).includes(envelope.id)); });
    const bridge = useMobileBridge();
    const decrypt = vi.fn(async (envelope: any) => ({ header: { from: "mobile", sentAt: envelope.sentAt }, payload: envelope.request }));
    harness.refs[1]!.current.decrypt = decrypt;
    await bridge.retryConnection();
    harness.state.localTurns[0].delivery = "uncertain";
    const legacyTurn = structuredClone(harness.state.localTurns[0]);
    const sending = deferred<void>();
    const send = vi.fn().mockResolvedValue(undefined).mockImplementationOnce(() => sending.promise);
    harness.refs[3]!.current.sendEnvelope = send;
    const ready: ServerFrame = { type: "ready", connectionId: "live", queued: 0, online: ["desktop"], onlineDevices: [{ role: "desktop", deviceId: "desktop-A" }] };
    try {
      harness.receive({ header: { sentAt: Date.now() }, payload: { kind: "snapshot", snapshot: nativeSnapshot() } } as DecryptedEnvelope, { id: "verified-native" } as EncryptedEnvelope);
      await vi.waitFor(() => expect(send).toHaveBeenCalledExactlyOnceWith(next));
      harness.frame(ready);
      harness.frame(ready);
      expect(send).toHaveBeenCalledOnce();
      sending.resolve();
      await vi.advanceTimersByTimeAsync(0);
      harness.frame(ready);
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
      expect(send.mock.calls.map(([envelope]) => envelope)).toEqual([next, next]);
      expect(harness.state.localTurns).toHaveLength(2);
      expect(harness.state.localTurns[1].delivery).toBe("local-saved");
      expect(harness.addOutbox).not.toHaveBeenCalled();
      expect([legacy, next]).toEqual(original);
      harness.frame(confirmation === "stored" ? { type: "stored", ids: [next.id] } : { type: "acknowledged", ids: [next.id], byDeviceId: "desktop-A" });
      await vi.waitFor(() => expect(outbox).toEqual([legacy]));
      harness.frame(ready);
      await vi.advanceTimersByTimeAsync(0);
      expect(send).toHaveBeenCalledTimes(2);
      expect(bridgeVault.removeOutbox).toHaveBeenCalledExactlyOnceWith([next.id]);
      expect(harness.state.localTurns[0]).toEqual(legacyTurn);
      expect(harness.state.localTurns[1].delivery).toBe(confirmation === "stored" ? "relay-received" : "host-received");
      expect(harness.saveMessage.mock.calls.some(([envelope]) => envelope.id === legacy.id)).toBe(false);
      expect(harness.state.pendingOutbound).toBe(1);
      expect(legacy).toEqual(original[0]);
    } finally { sending.resolve(); bridge.backToHosts(); vi.clearAllTimers(); }
  });
});

describe("queued-message steering requests", () => {
  it("references the existing command without another local message or outbox entry", async () => {
    const bridge = useMobileBridge();
    const original = { requestId: "original", commandId: "queued", sessionId: "session-1", text: "Keep this payload", delivery: "host-received" };
    harness.state.localTurns = [original];
    harness.respond = async request => request.method === "turn.queue.steer"
      ? { commandId: "queued", state: "queued" }
      : { events: [], latestSeq: 0 };
    await bridge.steerQueuedTurn("session-1", "queued");
    expect(harness.requests[0]?.request).toMatchObject({ method: "turn.queue.steer", params: { sessionId: "session-1", commandId: "queued" } });
    expect(harness.requests[0]?.request.params).not.toHaveProperty("text");
    expect(harness.requests[0]?.request.params).not.toHaveProperty("attachments");
    expect(harness.requests.some(({ request }) => request.method === "turn.start" || request.method === "turn.steer")).toBe(false);
    expect(harness.addOutbox).not.toHaveBeenCalled();
    expect(harness.state.localTurns).toEqual([original]);
  });

  it("rejects offline actions without saving something to replay later", async () => {
    const bridge = useMobileBridge();
    harness.refs[3]!.current.state = "closed";
    await expect(bridge.steerQueuedTurn("session-1", "queued")).rejects.toThrow("离线");
    expect(harness.requests).toEqual([]);
    expect(harness.addOutbox).not.toHaveBeenCalled();
  });

  it("surfaces a host failure and leaves the original message unchanged", async () => {
    const bridge = useMobileBridge();
    const original = { commandId: "queued", text: "Keep this payload", delivery: "host-received" };
    harness.state.localTurns = [original];
    harness.respond = async () => { throw new Error("当前会话不支持立即调整"); };
    await expect(bridge.steerQueuedTurn("session-1", "queued")).rejects.toThrow("不支持立即调整");
    expect(harness.state.localTurns).toEqual([original]);
    expect(harness.addOutbox).not.toHaveBeenCalled();
  });
});

describe("queued-message withdrawal requests", () => {
  it("withdraws the original command and consumes confirmed cancellation without resending input", async () => {
    const bridge = useMobileBridge();
    const original = { requestId: "original", commandId: "queued", sessionId: "session-1", text: "Keep this payload", delivery: "queued" };
    harness.state.localTurns = [original];
    harness.respond = async request => request.method === "turn.queue.cancel"
      ? { commandId: "queued", state: "cancelled" }
      : { events: [{ eventId: "withdrawn", seq: 1, timestamp: 1, origin: "claude-desktop", sessionId: "session-1", type: "message.delivery", data: { commandId: "queued", requestId: "original", delivery: "cancelled" } }], latestSeq: 1 };
    await bridge.cancelQueuedTurn("session-1", "queued");
    expect(harness.requests[0]?.request).toMatchObject({ method: "turn.queue.cancel", params: { sessionId: "session-1", commandId: "queued" } });
    expect(harness.requests[0]?.request.params).not.toHaveProperty("text");
    expect(harness.state.localTurns[0]).toMatchObject({ commandId: "queued", text: original.text, delivery: "cancelled" });
    expect(harness.requests.some(({ request }) => ["turn.start", "turn.steer", "turn.interrupt"].includes(request.method))).toBe(false);
    expect(harness.addOutbox).not.toHaveBeenCalled();
  });

  it("rejects offline withdrawal without storing a future action", async () => {
    const bridge = useMobileBridge();
    harness.refs[3]!.current.state = "closed";
    await expect(bridge.cancelQueuedTurn("session-1", "queued")).rejects.toThrow("离线");
    expect(harness.requests).toEqual([]);
    expect(harness.addOutbox).not.toHaveBeenCalled();
  });

  it("surfaces native refusal while retaining the original queued message", async () => {
    const bridge = useMobileBridge();
    const original = { commandId: "queued", text: "Keep this payload", delivery: "queued" };
    harness.state.localTurns = [original];
    harness.respond = async () => { throw new Error("无法撤回：已经被读取"); };
    await expect(bridge.cancelQueuedTurn("session-1", "queued")).rejects.toThrow("无法撤回");
    expect(harness.state.localTurns).toEqual([original]);
    expect(harness.addOutbox).not.toHaveBeenCalled();
  });
});

describe("queued-message RPC boundaries", () => {
  it.each(["steerQueuedTurn", "cancelQueuedTurn"] as const)("does not persist or retry %s when its transport write fails", async method => {
    const bridge = useMobileBridge();
    const original = { commandId: "queued", requestId: "original", sessionId: "session-1", text: "Retained input", delivery: "queued" };
    harness.state.localTurns = [original];
    const send = vi.fn().mockRejectedValue(new Error("Connection closed before write"));
    harness.refs[3]!.current.sendEnvelope = send;
    await expect(bridge[method]("session-1", "queued")).rejects.toThrow("Connection closed before write");
    expect(send).toHaveBeenCalledOnce();
    expect(harness.refs[6]!.current.size).toBe(0);
    expect(harness.state.localTurns).toEqual([original]);
    expect(harness.addOutbox).not.toHaveBeenCalled();
    expect(harness.saveMessage).not.toHaveBeenCalled();
  });

  it.each(["steerQueuedTurn", "cancelQueuedTurn"] as const)("times out a lost %s response and does not replay the action on reconnect", async method => {
    vi.useFakeTimers();
    const bridge = useMobileBridge();
    harness.refs[3]!.current.sendEnvelope = async ({ request }: { request: BridgeRequest }) => { harness.requests.push({ host: "A", request }); };
    const result = bridge[method]("session-1", "queued").then(() => "success", (error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.requests).toHaveLength(1);
    expect(harness.refs[6]!.current.size).toBe(1);
    harness.refs[3]!.current.state = "closed";
    await vi.advanceTimersByTimeAsync(20_001);
    expect(await result).toBe("电脑响应超时");
    expect(harness.refs[6]!.current.size).toBe(0);
    harness.refs[3]!.current.state = "connected";
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.requests).toHaveLength(1);
    expect(harness.addOutbox).not.toHaveBeenCalled();
    expect(harness.saveMessage).not.toHaveBeenCalled();
  });

  it.each(["steerQueuedTurn", "cancelQueuedTurn"] as const)("does not regress terminal evidence when a late %s response says queued", async method => {
    const bridge = useMobileBridge();
    const response = deferred<Record<string, unknown>>();
    harness.respond = request => request.method.startsWith("turn.queue.") ? response.promise : Promise.resolve({ events: [], latestSeq: 8 });
    const pending = bridge[method]("session-1", "queued");
    await vi.waitFor(() => expect(harness.requests).toHaveLength(1));
    const completed = { requestId: "original", commandId: "queued", messageId: "current-uuid", sessionId: "session-1", text: "Retained input", delivery: "completed", lastEventSeq: 8 };
    harness.state.localTurns = [completed]; harness.state.latestSeq = 8;
    response.resolve({ commandId: "queued", state: "queued" }); await pending;
    expect(harness.state.localTurns).toEqual([completed]);
    expect(harness.addOutbox).not.toHaveBeenCalled();
    expect(harness.requests.some(({ request }) => ["turn.start", "turn.steer", "turn.interrupt"].includes(request.method))).toBe(false);
  });

  it.each(["steerQueuedTurn", "cancelQueuedTurn"] as const)("keeps %s scoped to the original host when the user switches during the request", async method => {
    const bridge = useMobileBridge();
    const response = deferred<Record<string, unknown>>();
    harness.respond = request => request.method.startsWith("turn.queue.") ? response.promise : Promise.resolve({ events: [], latestSeq: 0 });
    const pending = bridge[method]("session-1", "queued");
    await vi.waitFor(() => expect(harness.requests).toHaveLength(1));
    switchHost("B");
    const other = { requestId: "other", commandId: "queued", sessionId: "session-1", text: "Other computer's input", delivery: "queued" };
    harness.state.localTurns = [other];
    response.resolve({ commandId: "queued", state: method === "cancelQueuedTurn" ? "cancelled" : "queued" }); await pending;
    expect(harness.requests.filter(({ request }) => request.method.startsWith("turn.queue."))).toEqual([expect.objectContaining({ host: "A", request: expect.objectContaining({ params: expect.objectContaining({ sessionId: "session-1", commandId: "queued" }) }) })]);
    expect(harness.state.snapshot.host.hostId).toBe("B");
    expect(harness.state.localTurns).toEqual([other]);
    expect(harness.addOutbox).not.toHaveBeenCalled();
  });
});

describe("queue event synchronization", () => {
  const oldEvents: BridgeEvent[] = [
    { eventId: "queued-B", sessionId: "session-1", seq: 11, timestamp: 11, origin: "system", type: "turn.queued", data: { requestId: "request-B", commandId: "B" } },
    { eventId: "old-permission", sessionId: "session-1", seq: 12, timestamp: 12, origin: "system", type: "permission.requested", data: { requestId: "permission-B", toolUseId: "tool-B", toolName: "Write", input: {} } },
    { eventId: "failed-B", sessionId: "session-1", seq: 13, timestamp: 13, origin: "system", type: "turn.failed", data: { commandId: "B", error: "preflight", wasQueued: true } },
  ];

  function setAuthoritativeState() {
    const current = {
      ...snapshot("A"), latestSeq: 13,
      sessions: [{ sessionId: "session-1", projectId: "project-1", projectName: "project", cwd: "/tmp/project", title: "Session", source: "bridge", lastActivityAt: 1, transport: "bridge-host", ownership: "BRIDGE_RUNNING", turnState: "running", activeTurnId: "A", pendingCount: 0, pendingCommandIds: [] }],
    } as BridgeHostSnapshot;
    Object.assign(harness.state, {
      snapshot: current, permissions: [], latestSeq: 10, events: [],
      localTurns: [{ requestId: "request-B", idempotencyKey: "key-B", sessionId: "session-1", text: "B", attachments: [], createdAt: 1, delivery: "local-saved" }],
    });
    harness.refs[0]!.current = harness.state;
    return current;
  }

  it("replays more than twenty byte-limited event pages without dropping the final receipt", async () => {
    const bridge = useMobileBridge();
    harness.state.latestSeq = 10;
    harness.state.localTurns = [{ requestId: "request-B", idempotencyKey: "key-B", commandId: "B", sessionId: "session-1", text: "Continue", attachments: [], createdAt: 1, delivery: "submitted" }];
    harness.respond = async request => {
      if (request.method !== "events.resume") return {};
      const seq = Number(request.params.afterSeq) + 1;
      return {
        events: [{ eventId: `page-${seq}`, seq, timestamp: seq, origin: "claude-host", sessionId: "session-1",
          type: seq === 41 ? "turn.completed" : "assistant.delta",
          data: seq === 41 ? { requestId: "request-B", commandId: "B" } : { text: "Page limited by its byte budget" },
        }], nextSeq: seq, latestSeq: 41, hasMore: seq < 41,
      };
    };
    await bridge.resolveUncertainDelivery("B", "confirm");
    expect(harness.state.latestSeq).toBe(41);
    expect(harness.state.localTurns[0].delivery).toBe("completed");
    expect(harness.requests.filter(({ request }) => request.method === "events.resume")).toHaveLength(31);
  });

  it("stops replay when hasMore is set but the page cursor makes no progress", async () => {
    const bridge = useMobileBridge();
    harness.state.latestSeq = 10;
    harness.respond = async request => request.method === "events.resume"
      ? { events: [], nextSeq: 10, latestSeq: 41, hasMore: true } : {};
    await bridge.resolveUncertainDelivery("B", "confirm");
    expect(harness.state.latestSeq).toBe(10);
    expect(harness.requests.filter(({ request }) => request.method === "events.resume")).toHaveLength(1);
  });

  it("keeps snapshot state authoritative during resume while reconciling historical local turns", async () => {
    const bridge = useMobileBridge();
    const current = setAuthoritativeState();
    harness.respond = async (request) => request.method === "events.resume"
      ? { events: oldEvents, nextSeq: 13, latestSeq: 13 }
      : {};
    await bridge.resolveUncertainDelivery("B", "confirm");
    expect(harness.state.snapshot).toEqual(current);
    expect(harness.state.permissions).toEqual([]);
    expect(harness.state.events).toEqual(oldEvents);
    expect(harness.state.localTurns[0]).toMatchObject({ commandId: "B", delivery: "failed", error: "preflight" });
  });

  it("ignores stale live lifecycle and permission state while keeping history and local reconciliation", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("document", { visibilityState: "visible" });
    const bridge = useMobileBridge();
    await bridge.retryConnection();
    const current = setAuthoritativeState();
    for (const event of oldEvents) {
      harness.receive({ payload: { kind: "event", event }, header: { sentAt: Date.now() } } as DecryptedEnvelope, { id: event.eventId } as EncryptedEnvelope);
    }
    expect(harness.state.snapshot).toEqual(current);
    expect(harness.state.permissions).toEqual([]);
    expect(harness.state.events).toEqual(oldEvents);
    expect(harness.state.localTurns[0]).toMatchObject({ commandId: "B", delivery: "failed" });

    const queued: BridgeEvent = { ...oldEvents[0]!, eventId: "queued-C", seq: 14, data: { commandId: "C", pendingCount: 1, pendingCommandIds: ["C"] } };
    for (let repeat = 0; repeat < 2; repeat += 1) {
      harness.receive({ payload: { kind: "event", event: queued }, header: { sentAt: Date.now() } } as DecryptedEnvelope, { id: queued.eventId } as EncryptedEnvelope);
    }
    expect(harness.state.snapshot.sessions[0]).toMatchObject({
      turnState: "running", activeTurnId: "A", pendingCount: 1, pendingCommandIds: ["C"],
    });
    expect(harness.state.snapshot.latestSeq).toBe(14);
    expect(harness.state.events).toHaveLength(4);
    bridge.backToHosts();
    vi.clearAllTimers();
  });
});

describe("subagent progress cache retention", () => {
  it("keeps the offline catalog after 200 progress patches and persists count changes and completion", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.stubGlobal("document", { visibilityState: "visible" });
    const { indexedDB, IDBKeyRange } = await import("fake-indexeddb");
    vi.stubGlobal("indexedDB", indexedDB);
    vi.stubGlobal("IDBKeyRange", IDBKeyRange);
    const { BridgeVault } = await vi.importActual<typeof import("../lib/vault.js")>("../lib/vault.js");
    const vault = new BridgeVault();
    harness.saveMessage.mockImplementation((envelope, cacheKey) => vault.saveMessage(envelope, cacheKey));
    harness.listMessages.mockImplementation((roomId, limit) => vault.listMessages(roomId, limit));
    const bridge = useMobileBridge();
    const messages = new Map<string, DecryptedEnvelope>();
    harness.refs[1]!.current.decrypt = async (envelope: EncryptedEnvelope) => messages.get(envelope.id)!;
    await bridge.retryConnection();
    const initial = snapshot("A");
    initial.sessions = [{
      sessionId: "session-1", projectId: "project", projectName: "Project", cwd: "/tmp/project", title: "Session",
      source: "desktop", transport: "bridge-host", ownership: "DESKTOP_OBSERVED", turnState: "running",
      activeTurnId: "main-turn", pendingCount: 2, lastActivityAt: 1,
      runningSubagents: { count: 2, lastUpdatedAt: 1 }, subagentStopScope: "process",
    }];
    const receive = (payload: DecryptedEnvelope["payload"]) => {
      const id = `cached-progress-${messages.size}`;
      const message = { header: { sentAt: Date.now(), from: "desktop", to: "mobile" }, payload } as DecryptedEnvelope;
      messages.set(id, message);
      harness.receive(message, { id, roomId: "A", sentAt: messages.size } as EncryptedEnvelope);
    };
    receive({ kind: "snapshot", snapshot: initial });
    for (let seq = 1; seq <= 200; seq++) {
      receive({ kind: "event", event: {
        eventId: `tool-progress-${seq}`, seq: seq * 2 - 1, timestamp: seq, sessionId: "session-1", itemId: "agent-1",
        origin: "claude-desktop", type: "tool.progress", data: { toolName: "Agent", summary: `Working ${seq}` },
      } });
      receive({ kind: "event", event: {
        eventId: `progress-${seq}`, seq: seq * 2, timestamp: seq, sessionId: "session-1", itemId: "session:subagent-activity", origin: "system", type: "runtime.updated",
        data: { session: { sessionId: "session-1", runningSubagents: { count: 2, lastUpdatedAt: seq }, lastActivityAt: seq } },

      } });
    }
    await Promise.all(harness.saveMessage.mock.results.map(result => result.value));
    receive({ kind: "event", event: {
      eventId: "delayed-progress", seq: 398, timestamp: 199, sessionId: "session-1", itemId: "session:subagent-activity", origin: "system", type: "runtime.updated",
      data: { session: { sessionId: "session-1", runningSubagents: { count: 2, lastUpdatedAt: 199 }, lastActivityAt: 199 } },
    } });
    await Promise.all(harness.saveMessage.mock.results.map(result => result.value));
    expect(harness.state.snapshot.sessions[0]).toMatchObject({
      activeTurnId: "main-turn", turnState: "running", pendingCount: 2, runningSubagents: { count: 2, lastUpdatedAt: 200 }, lastActivityAt: 200,
    });
    const cached = await vault.listMessages("A", 120);
    expect(cached).toHaveLength(3);
    expect(cached.some(envelope => envelope.id === "cached-progress-0")).toBe(true);
    await bridge.retryConnection();
    expect(harness.state.snapshot.sessions[0]).toMatchObject({ sessionId: "session-1", runningSubagents: { count: 2, lastUpdatedAt: 200 }, lastActivityAt: 200 });

    const countChanged = structuredClone(initial);
    countChanged.latestSeq = 401;
    countChanged.sessions[0]!.runningSubagents = { count: 3, lastUpdatedAt: 201 };
    receive({ kind: "snapshot", snapshot: countChanged });
    await Promise.all(harness.saveMessage.mock.results.map(result => result.value));
    await bridge.retryConnection();
    expect(harness.state.snapshot.sessions[0].runningSubagents).toEqual({ count: 3, lastUpdatedAt: 201 });

    const completed = structuredClone(countChanged);
    completed.latestSeq = 402;
    delete completed.sessions[0]!.runningSubagents;
    delete completed.sessions[0]!.subagentStopScope;
    receive({ kind: "snapshot", snapshot: completed });
    await Promise.all(harness.saveMessage.mock.results.map(result => result.value));
    await bridge.retryConnection();
    expect(harness.state.snapshot.sessions[0]).not.toHaveProperty("runningSubagents");
    expect(harness.state.snapshot.sessions[0].turnState).toBe("running");
    bridge.backToHosts();
    vi.clearAllTimers();
  });
});

// A restarting desktop can build a snapshot before its own relay state reads "connected" and send it
// once it does, so the snapshot says online:false although it just arrived from the desktop.
describe("desktop presence after a desktop restart", () => {
  function staleOfflineSnapshot(): BridgeHostSnapshot {
    const current = snapshot("A");
    current.host.online = false;
    return current;
  }

  it("keeps the desktop online when a live snapshot carries a stale offline flag", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("document", { visibilityState: "visible" });
    const bridge = useMobileBridge();
    await bridge.retryConnection();
    harness.receive(
      { payload: { kind: "snapshot", snapshot: staleOfflineSnapshot() }, header: { sentAt: Date.now() } } as DecryptedEnvelope,
      { id: "snapshot-1" } as EncryptedEnvelope,
    );
    expect(harness.state.desktopOnline).toBe(true);
    bridge.backToHosts();
    vi.clearAllTimers();
  });

  it("keeps the desktop online when the snapshot it just answered with carries a stale offline flag", async () => {
    harness.state.desktopOnline = true;
    harness.respond = async (request) => request.method === "snapshot.get" ? { snapshot: staleOfflineSnapshot() } : {};
    const bridge = useMobileBridge();
    await expect(bridge.refresh()).resolves.toBe(true);
    expect(harness.state.desktopOnline).toBe(true);
  });
});

describe("evidence detail loading", () => {
  it("requests one page without adding its contents to the global cache", async () => {
    harness.state.snapshot.host.capabilities = ["evidence.details.v1"];
    harness.respond = async () => ({ page: { evidenceId: "bundle", kind: "tools", items: [{ id: "tool" }], hasMore: false } });
    const bridge = useMobileBridge();
    await expect(bridge.loadEvidenceDetails("bundle", "tools", "29")).resolves.toMatchObject({ items: [{ id: "tool" }] });
    expect(harness.requests[0]!.request).toMatchObject({ method: "evidence.details", params: { evidenceId: "bundle", kind: "tools", cursor: "29", limit: 30 } });
    expect(harness.state.evidence).toEqual({});
    expect(harness.saveMessage).not.toHaveBeenCalled();
  });

  it("pages a legacy host response without retaining the full bundle", async () => {
    harness.respond = async () => ({ evidence: { tools: Array.from({ length: 65 }, (_, i) => ({ id: `tool-${i}` })), artifacts: [] } });
    const bridge = useMobileBridge();
    const page = await bridge.loadEvidenceDetails("bundle", "tools", "30");
    expect(page.items).toHaveLength(30);
    expect(page.items[0]?.id).toBe("tool-30");
    expect(page.nextCursor).toBe("60");
    expect(harness.requests[0]!.request.method).toBe("evidence.get");
    expect(harness.state.evidence).toEqual({});
  });
});

describe("host-bound synchronization", () => {
  it("still caches and applies the current host snapshot", async () => {
    const bridge = useMobileBridge();
    await expect(bridge.refresh()).resolves.toBe(true);
    expect(harness.saveMessage).toHaveBeenCalledOnce();
    expect(harness.state.snapshot.host.hostId).toBe("A");
  });

  it.each(["another host", "a replacement connection"])("does not apply a snapshot after switching to %s during cache save", async (change) => {
    const saving = deferred<void>();
    const entered = deferred<void>();
    harness.saveMessage.mockImplementation(async () => { entered.resolve(); await saving.promise; });
    const bridge = useMobileBridge();
    const refresh = bridge.refresh();
    await entered.promise;
    switchHost(change === "another host" ? "B" : "A", change === "another host");
    const current = snapshot(harness.state.activeHostId);
    current.latestSeq = 42;
    harness.state.snapshot = current;
    harness.state.latestSeq = 42;
    saving.resolve();
    await expect(refresh).resolves.toBe(false);
    expect(harness.state.snapshot).toBe(current);
    expect(harness.state.latestSeq).toBe(42);
    expect(harness.requests.every(({ host }) => host === "A")).toBe(true);
  });

  it("does not save stale cache after changing hosts during encryption", async () => {
    const encryption = deferred<{ id: string }>();
    const entered = deferred<void>();
    harness.cacheEncrypt.mockImplementation(() => { entered.resolve(); return encryption.promise; });
    const bridge = useMobileBridge();
    const refresh = bridge.refresh();
    await entered.promise;
    switchHost("B");
    encryption.resolve({ id: "cached-A" });
    await expect(refresh).resolves.toBe(false);
    expect(harness.saveMessage).not.toHaveBeenCalled();
    expect(harness.state.desktopName).toBe("B");
  });

  it("does not encrypt an old response using the newly selected host", async () => {
    const response = deferred<Record<string, unknown>>();
    const entered = deferred<void>();
    const respond = harness.respond;
    harness.respond = (request) => {
      if (request.method !== "snapshot.get") return respond(request);
      entered.resolve();
      return response.promise;
    };
    const bridge = useMobileBridge();
    const refresh = bridge.refresh();
    await entered.promise;
    switchHost("B");
    response.resolve({ snapshot: snapshot("A") });
    await expect(refresh).resolves.toBe(false);
    expect(harness.cacheEncrypt).not.toHaveBeenCalled();
    expect(harness.state.snapshot.host.hostId).toBe("B");
  });

  it("stops event replay before it can fetch the next page from another host", async () => {
    const response = deferred<Record<string, unknown>>();
    const entered = deferred<void>();
    const respond = harness.respond;
    harness.respond = (request) => {
      if (request.method !== "events.resume") return respond(request);
      if (request.params.afterSeq !== 0) return Promise.resolve({ events: [], latestSeq: 2 });
      entered.resolve();
      return response.promise;
    };
    const bridge = useMobileBridge();
    const refresh = bridge.refresh();
    await entered.promise;
    switchHost("B");
    response.resolve({ events: [{ eventId: "A-event", seq: 1, timestamp: 1, origin: "system", type: "runtime.error", data: {} } satisfies BridgeEvent], nextSeq: 1, latestSeq: 2, hasMore: true });
    await expect(refresh).resolves.toBe(false);
    expect(harness.requests.every(({ host }) => host === "A")).toBe(true);
    expect(harness.state.events).toEqual([]);
    expect(harness.state.latestSeq).toBe(0);
  });

  it("does not apply the session-list fallback or send follow-up requests to another host", async () => {
    const response = deferred<Record<string, unknown>>();
    const entered = deferred<void>();
    const respond = harness.respond;
    harness.respond = (request) => {
      if (request.method === "snapshot.get") return Promise.reject(new Error("snapshot unavailable"));
      if (request.method !== "session.list") return respond(request);
      entered.resolve();
      return response.promise;
    };
    const bridge = useMobileBridge();
    const refresh = bridge.refresh();
    await entered.promise;
    switchHost("B");
    response.resolve({ sessions: [{ sessionId: "A-session" }] });
    await expect(refresh).resolves.toBe(false);
    expect(harness.state.snapshot.sessions).toEqual([]);
    expect(harness.requests.every(({ host }) => host === "A")).toBe(true);
    expect(harness.state.error).toBeUndefined();
  });

  it("deduplicates session opens only within the same host connection", async () => {
    const first = deferred<Record<string, unknown>>();
    const second = deferred<Record<string, unknown>>();
    let opens = 0;
    harness.respond = (request) => {
      if (request.method !== "session.open") return Promise.resolve({});
      opens += 1;
      return opens === 1 ? first.promise : second.promise;
    };
    const bridge = useMobileBridge();
    const oldOpening = bridge.openSession("shared-session");
    const duplicate = bridge.openSession("shared-session");
    await vi.waitFor(() => expect(opens).toBe(1));
    switchHost("B");
    const newOpening = bridge.openSession("shared-session");
    await vi.waitFor(() => expect(opens).toBe(2));
    first.resolve({ history: { items: [], hasMore: false } });
    await Promise.all([oldOpening, duplicate]);
    expect(harness.state.histories["shared-session"].status).toBe("loading");
    const sameConnectionOpening = bridge.openSession("shared-session");
    second.resolve({ history: { items: [{ id: "B-item" }], hasMore: false } });
    await Promise.all([newOpening, sameConnectionOpening]);
    expect(opens).toBe(2);
    expect(harness.state.histories["shared-session"].items).toEqual([{ id: "B-item" }]);
  });

  it("does not apply the desktop-status fallback after changing hosts", async () => {
    const response = deferred<Record<string, unknown>>();
    const entered = deferred<void>();
    const respond = harness.respond;
    harness.respond = (request) => {
      if (request.method === "snapshot.get") return Promise.reject(new Error("snapshot unavailable"));
      if (request.method === "session.list") return Promise.resolve({ sessions: [] });
      if (request.method !== "claude.desktop.status") return respond(request);
      entered.resolve();
      return response.promise;
    };
    const bridge = useMobileBridge();
    const refresh = bridge.refresh();
    await entered.promise;
    switchHost("B");
    const current = harness.state.snapshot;
    response.resolve({ claudeDesktop: { installed: true, running: true } });
    await expect(refresh).resolves.toBe(false);
    expect(harness.state.snapshot).toBe(current);
  });

  it.each([true, false])("ignores old evidence completion after changing hosts (success=%s)", async (ok) => {
    const response = deferred<Record<string, unknown>>();
    const entered = deferred<void>();
    harness.respond = (request) => {
      if (request.method === "session.open") return Promise.resolve({ history: { items: [], hasMore: false } });
      entered.resolve();
      return response.promise;
    };
    const bridge = useMobileBridge();
    await bridge.openSession("A-session");
    await entered.promise;
    switchHost("B");
    if (ok) response.resolve({ evidence: { items: [], hasMore: false } });
    else response.reject(new Error("old evidence request failed"));
    await vi.waitFor(() => expect(harness.refs[6]!.current.size).toBe(0));
    expect(harness.state.evidence).toEqual({});
    expect(harness.state.error).toBeUndefined();
  });

  it.each([true, false])("ignores an old session-open completion after changing hosts (success=%s)", async (ok) => {
    const response = deferred<Record<string, unknown>>();
    const entered = deferred<void>();
    harness.respond = async () => { entered.resolve(); return response.promise; };
    const bridge = useMobileBridge();
    const opening = bridge.openSession("A-session");
    await entered.promise;
    switchHost("B");
    if (ok) response.resolve({ history: { items: [], hasMore: false } });
    else response.reject(new Error("old connection timed out"));
    await opening;
    expect(harness.state.histories).toEqual({});
    expect(harness.state.evidence).toEqual({});
    expect(harness.state.error).toBeUndefined();
    expect(harness.requests).toHaveLength(1);
  });
});


describe("mobile history pagination", () => {
  const recent = { id: "recent-uuid", sessionId: "shared-session", role: "user", text: "Current history", createdAt: 2, origin: "claude-desktop" };
  const older = { ...recent, id: "older-uuid", text: "Older history", createdAt: 1 };
  beforeEach(() => {
    harness.state.histories = { "shared-session": { status: "ready", items: [recent], hasMore: true, nextCursor: "recent-uuid" } };
  });

  it("requests 50 for both initial and older pages, passes the native cursor unchanged, and prepends by ID", async () => {
    harness.respond = async request => request.method === "session.open"
      ? { history: { items: [recent], hasMore: true, nextCursor: "recent-uuid" } }
      : request.method === "session.history"
        ? { history: { items: [older, recent], hasMore: false } }
        : {};
    const bridge = useMobileBridge();
    await bridge.openSession("shared-session");
    await bridge.loadOlderHistory("shared-session");
    await bridge.loadOlderHistory("shared-session");
    expect(harness.requests.map(({ request }) => [request.method, request.params])).toEqual([
      ["session.open", expect.objectContaining({ sessionId: "shared-session", limit: 50 })],
      ["evidence.list", expect.anything()],
      ["session.history", expect.objectContaining({ sessionId: "shared-session", cursor: "recent-uuid", limit: 50 })],
    ]);
    expect(harness.state.histories["shared-session"]).toEqual({ status: "ready", items: [older, recent], hasMore: false });
    expect(harness.addOutbox).not.toHaveBeenCalled();
    expect(harness.state.localTurns).toEqual([]);
  });

  it("keeps failed paging data and its error row during retry, then clears the error with the successful prepend", async () => {
    harness.respond = async () => { throw new Error("Network unavailable"); };
    const bridge = useMobileBridge();
    await bridge.loadOlderHistory("shared-session");
    expect(harness.state.histories["shared-session"]).toEqual({ status: "ready", items: [recent], hasMore: true, nextCursor: "recent-uuid", error: "Network unavailable" });
    const response = deferred<Record<string, unknown>>();
    harness.respond = () => response.promise;
    const retry = bridge.loadOlderHistory("shared-session");
    const loading = harness.state.histories["shared-session"];
    response.resolve({ history: { items: [older], hasMore: false } });
    await retry;
    expect(loading.status).toBe("loading");
    expect(loading.error).toBe("Network unavailable");
    expect(harness.state.histories["shared-session"]).toEqual({ status: "ready", items: [older, recent], hasMore: false });
    expect(harness.requests.map(({ request }) => request.method)).toEqual(["session.history", "session.history"]);
    expect(harness.addOutbox).not.toHaveBeenCalled();
    expect(harness.state.localTurns).toEqual([]);
  });

  it("deduplicates repeated top-scroll requests before React commits the loading state", async () => {
    const response = deferred<Record<string, unknown>>();
    harness.respond = () => response.promise;
    const bridge = useMobileBridge();
    harness.commitStateImmediately = false;
    const requests = [bridge.loadOlderHistory("shared-session"), bridge.loadOlderHistory("shared-session"), bridge.loadOlderHistory("shared-session")];
    await vi.waitFor(() => expect(harness.requests.length).toBeGreaterThan(0));
    response.resolve({ history: { items: [older], hasMore: false } });
    await Promise.all(requests);
    expect(harness.requests).toHaveLength(1);
    expect(harness.state.histories["shared-session"].items).toEqual([older, recent]);
  });

  it.each([
    { status: "loading", hasMore: true, nextCursor: "older" },
    { status: "ready", hasMore: false, nextCursor: "older" },
    { status: "ready", hasMore: true },
  ])("ignores history that is loading, exhausted, or lacks a cursor (%j)", async page => {
    harness.state.histories["shared-session"] = { items: [recent], ...page };
    await useMobileBridge().loadOlderHistory("shared-session");
    expect(harness.requests).toEqual([]);
  });

  it.each([true, false])("ignores an older-page completion after switching hosts (success=%s)", async ok => {
    const response = deferred<Record<string, unknown>>();
    harness.respond = () => response.promise;
    const bridge = useMobileBridge();
    const loading = bridge.loadOlderHistory("shared-session");
    await vi.waitFor(() => expect(harness.requests).toHaveLength(1));
    switchHost("B");
    harness.state.histories["shared-session"] = { status: "ready", items: [{ ...recent, id: "B-item" }], hasMore: true, nextCursor: "B-cursor" };
    const current = harness.state.histories["shared-session"];
    if (ok) response.resolve({ history: { items: [older], hasMore: false } });
    else response.reject(new Error("Old host disconnected"));
    await loading;
    expect(harness.state.histories["shared-session"]).toBe(current);
  });
});

describe("successful rewind result", () => {
  it("returns the Native prefill without starting a duplicate blocking history refresh", async () => {
    const history = deferred<Record<string, unknown>>();
    const rewind = { sessionId: "rewind-session", messageId: "rewind-user", scope: "conversation", prefill: "Original request" };
    harness.respond = async request => request.method === "session.rewind" ? { rewind }
      : request.method === "session.open" ? history.promise : {};
    const bridge = useMobileBridge();
    let result: unknown;
    const completion = bridge.rewindSession("rewind-session", "rewind-user", "conversation").then(value => { result = value; });
    try {
      await vi.waitFor(() => expect(harness.requests.length).toBeGreaterThan(0));
      for (let i = 0; i < 20; i++) await Promise.resolve();
      expect(result).toEqual(rewind);
      expect(harness.requests.map(entry => entry.request.method)).toEqual(["session.rewind"]);
      expect(harness.addOutbox).not.toHaveBeenCalled();
      expect(harness.state.localTurns).toEqual([]);
    } finally { history.resolve({ history: { sessionId: "rewind-session", items: [], hasMore: false } }); await completion; }
  });
});

describe("session command control RPCs", () => {
  it("waits for session.command and never adds it to the offline outbox or a fake local turn", async () => {
    harness.respond = async () => ({ command: { action: "sent" } });
    const bridge = useMobileBridge();
    await expect(bridge.runSessionCommand("sdk-session", "/compact preserve decisions")).resolves.toEqual({ action: "sent" });
    expect(harness.requests[0]!.request).toMatchObject({ method: "session.command", params: { sessionId: "sdk-session", text: "/compact preserve decisions" } });
    expect(harness.addOutbox).not.toHaveBeenCalled(); expect(harness.state.localTurns).toEqual([]);
  });
  it("rejects offline commands without creating an offline prompt", async () => {
    const bridge = useMobileBridge(); harness.refs[3]!.current.state = "closed";
    await expect(bridge.runSessionCommand("sdk-session", "/clear")).rejects.toThrow("离线");
    expect(harness.requests).toEqual([]); expect(harness.addOutbox).not.toHaveBeenCalled();
  });
  it("loads and saves actual SDK permissions through dedicated RPCs", async () => {
    const permissions = { sessionId: "sdk-session", mode: "plan" as const, canConfigure: true,
      rules: { allow: ["Read"], ask: ["Edit"], deny: [] }, inheritedRules: { allow: [], ask: [], deny: [] } };
    harness.respond = async () => ({ permissions }); const bridge = useMobileBridge();
    await expect(bridge.loadSessionPermissions("sdk-session")).resolves.toEqual(permissions);
    await expect(bridge.saveSessionPermissions("sdk-session", "plan", permissions.rules)).resolves.toEqual(permissions);
    expect(harness.requests.map(entry => entry.request.method)).toEqual(["session.permissions", "session.permissions.configure"]);
    expect(harness.requests[1]!.request.params).toMatchObject({ sessionId: "sdk-session", mode: "plan", rules: permissions.rules });
    expect(harness.addOutbox).not.toHaveBeenCalled();
  });
});


it("keeps a completed command's returned session on its original computer after switching hosts", async () => {
  const result = deferred<Record<string, unknown>>();
  harness.respond = () => result.promise;
  const bridge = useMobileBridge();
  const command = bridge.runSessionCommand("same-session-id", "/fork");
  await vi.waitFor(() => expect(harness.requests).toHaveLength(1));
  switchHost("B");
  result.resolve({ command: { action: "session", session: { sessionId: "A-fork", title: "A fork" } } });
  await command;
  expect(harness.state.snapshot.sessions).toEqual([]);
});
