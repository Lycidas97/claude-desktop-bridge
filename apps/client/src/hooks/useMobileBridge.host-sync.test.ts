import type { BridgeCrypto, BridgeEvent, BridgeHostSnapshot, BridgeRequest, BridgeResponse } from "@bridge/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMobileBridge } from "./useMobileBridge.js";

const harness = vi.hoisted(() => ({
  state: undefined as any,
  refs: [] as Array<{ current: any }>,
  requests: [] as Array<{ host: string; request: BridgeRequest }>,
  respond: undefined as unknown as (request: BridgeRequest) => Promise<Record<string, unknown>>,
  cacheEncrypt: vi.fn(),
  saveMessage: vi.fn(),
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
  bridgeVault: { saveMessage: harness.saveMessage, updateLanRelay: vi.fn() },
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
  harness.respond = async (request) => {
    if (request.method === "events.resume") return { events: [], latestSeq: 0 };
    if (request.method === "snapshot.get") return { snapshot: snapshot("A") };
    return {};
  };
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
