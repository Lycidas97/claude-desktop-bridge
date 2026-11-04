import type { BridgeCrypto, BridgeEvent, BridgeHostSnapshot, BridgeRequest, BridgeResponse, DecryptedEnvelope, EncryptedEnvelope } from "@bridge/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMobileBridge } from "./useMobileBridge.js";

const harness = vi.hoisted(() => ({
  state: undefined as any,
  refs: [] as Array<{ current: any }>,
  requests: [] as Array<{ host: string; request: BridgeRequest }>,
  respond: undefined as unknown as (request: BridgeRequest) => Promise<Record<string, unknown>>,
  cacheEncrypt: vi.fn(),
  saveMessage: vi.fn(),
  addOutbox: vi.fn(),
  receive: undefined as unknown as (message: DecryptedEnvelope, encrypted: EncryptedEnvelope) => void,
}));

vi.mock("@bridge/protocol", async (importOriginal) => ({
  ...await importOriginal<typeof import("@bridge/protocol")>(),
  TransportRouter: class {
    state = "connected";
    endpoint = "wss://relay.example/ws";
    path = "public-relay";
    connect() {}
    close() {}
    onState() {}
    onMetrics() {}
    onFrame() {}
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
      if (harness.refs[0]) harness.refs[0].current = harness.state;
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
    listMessages: vi.fn().mockResolvedValue([]), listOutbox: vi.fn().mockResolvedValue([]),
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
    host: { hostId: host, name: host, online: true },
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
  harness.requests = [];
  harness.state = { activeHostId: "A", desktopName: "A", snapshot: snapshot("A") };
  harness.cacheEncrypt.mockReset().mockResolvedValue({ id: "cached-A" });
  harness.saveMessage.mockReset().mockResolvedValue(undefined);
  harness.addOutbox.mockReset().mockResolvedValue(undefined);
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

describe("durable sends during transport failure", () => {
  it.each([false, true])("keeps a persisted message queued without restoring the draft (steer=%s)", async steer => {
    const bridge = useMobileBridge();
    const send = vi.fn().mockRejectedValue(new Error("Socket is not connected"));
    harness.refs[3]!.current.sendEnvelope = send;
    await expect(bridge.sendTurn("session-1", "Continue", [], steer)).resolves.toBeUndefined();
    expect(harness.addOutbox).toHaveBeenCalledOnce();
    expect(harness.saveMessage).toHaveBeenCalledOnce();
    expect(harness.state.localTurns).toHaveLength(1);
    expect(harness.state.localTurns[0]).toMatchObject({ text: "Continue", delivery: "local-saved" });
    expect(send).toHaveBeenCalledOnce();
    const envelope = harness.addOutbox.mock.calls[0]![0];
    expect(send).toHaveBeenCalledWith(envelope);
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
