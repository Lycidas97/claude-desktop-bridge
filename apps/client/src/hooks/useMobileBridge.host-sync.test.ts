import type { BridgeCrypto, BridgeEvent, BridgeHostSnapshot, BridgeRequest, BridgeResponse, BridgeSessionInfo, DecryptedEnvelope, EncryptedEnvelope } from "@bridge/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMobileBridge } from "./useMobileBridge.js";
import { bridgeVault } from "../lib/vault.js";
import { PROTOCOL_VERSION } from "@bridge/protocol";

const harness = vi.hoisted(() => ({
  state: undefined as any,
  refs: [] as Array<{ current: any }>,
  requests: [] as Array<{ host: string; request: BridgeRequest }>,
  respond: undefined as unknown as (request: BridgeRequest) => Promise<Record<string, unknown>>,
  cacheEncrypt: vi.fn(),
  saveMessage: vi.fn(),
  listMessages: vi.fn(),
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
    listMessages: harness.listMessages, listOutbox: vi.fn().mockResolvedValue([]),
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
  harness.requests = [];
  harness.state = { activeHostId: "A", desktopName: "A", snapshot: snapshot("A") };
  harness.cacheEncrypt.mockReset().mockResolvedValue({ id: "cached-A" });
  harness.saveMessage.mockReset().mockResolvedValue(undefined);
  harness.listMessages.mockReset().mockResolvedValue([]);
  harness.addOutbox.mockReset().mockResolvedValue(undefined);
  vi.mocked(bridgeVault.listOutbox).mockReset().mockResolvedValue([]);
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

describe("returning a session to Desktop", () => {
  it("sends only the explicit RPC and merges its returned session", async () => {
    const session: BridgeSessionInfo = {
      sessionId: "target", projectId: "project", projectName: "Project", cwd: "/tmp/project", title: "Target",
      source: "desktop", ownership: "BRIDGE_IDLE", transport: "bridge-host", turnState: "idle", lastActivityAt: 1, pendingCount: 0,
      desktopHandoff: { state: "bridge", canReturn: true },
    };
    const sibling = { ...session, sessionId: "sibling" };
    harness.state.snapshot.sessions = [session, sibling];
    const returned: BridgeSessionInfo = { ...session, desktopHandoff: { state: "reopen-desktop", canReturn: false } };
    harness.respond = async () => ({ session: returned });
    const bridge = useMobileBridge();
    await expect(bridge.returnToDesktop("target")).resolves.toBeUndefined();
    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0]!.request).toMatchObject({ method: "session.return_to_desktop", params: { sessionId: "target" } });
    expect(harness.state.snapshot.sessions).toEqual([returned, sibling]);
    expect(harness.addOutbox).not.toHaveBeenCalled();
  });

  it("rejects an offline return without queuing a later handoff", async () => {
    const bridge = useMobileBridge();
    harness.refs[3]!.current.state = "closed";
    await expect(bridge.returnToDesktop("target")).rejects.toThrow("电脑当前离线");
    expect(harness.requests).toEqual([]);
    expect(harness.addOutbox).not.toHaveBeenCalled();
  });
});

describe("explicit single-session Desktop takeover", () => {
  it("sends only the takeover RPC and merges the returned session while preserving queued answers", async () => {
    const session: BridgeSessionInfo = {
      sessionId: "target", projectId: "project", projectName: "Project", cwd: "/tmp/project", title: "Target",
      source: "desktop", ownership: "DESKTOP_OBSERVED", transport: "bridge-host", turnState: "queued", lastActivityAt: 1, pendingCount: 1,
      desktopHandoff: { state: "close-desktop", canReturn: false, canTakeover: true },
    };
    const sibling = { ...session, sessionId: "sibling" };
    harness.state.snapshot.sessions = [session, sibling];
    const answer = { requestId: "answer", sessionId: "target", text: "Main", delivery: "host-received" };
    harness.state.localTurns = [answer];
    const returned: BridgeSessionInfo = { ...session, desktopHandoff: { state: "bridge", canReturn: false, canTakeover: false } };
    harness.respond = async () => ({ session: returned });
    const bridge = useMobileBridge();
    await expect(bridge.takeoverDesktop("target")).resolves.toBeUndefined();
    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0]!.request).toMatchObject({ method: "session.takeover_desktop", params: { sessionId: "target" } });
    expect(harness.requests[0]!.request.params).toEqual({ sessionId: "target", client: { name: "Web 客户端", platform: "web" } });
    expect(harness.state.snapshot.sessions).toEqual([returned, sibling]);
    expect(harness.state.localTurns).toEqual([answer]);
    expect(harness.addOutbox).not.toHaveBeenCalled();
  });

  it("rejects offline takeover without queuing a later process termination", async () => {
    const bridge = useMobileBridge();
    harness.refs[3]!.current.state = "closed";
    await expect(bridge.takeoverDesktop("target")).rejects.toThrow("电脑当前离线");
    expect(harness.requests).toEqual([]);
    expect(harness.addOutbox).not.toHaveBeenCalled();
  });

  it("surfaces a backend refusal and leaves session state unchanged", async () => {
    const before = harness.state.snapshot;
    const bridge = useMobileBridge();
    harness.refs[3]!.current.sendEnvelope = async ({ request }: { request: BridgeRequest }) => {
      harness.requests.push({ host: "A", request });
      const pending = harness.refs[6]!.current.get(request.requestId);
      clearTimeout(pending.timer);
      harness.refs[6]!.current.delete(request.requestId);
      pending.resolve({ kind: "response", requestId: request.requestId, ok: false, error: { code: "BUSY", message: "主任务或子代理仍在运行" } });
    };
    await expect(bridge.takeoverDesktop("target")).rejects.toThrow("主任务或子代理仍在运行");
    expect(harness.state.snapshot).toBe(before);
    expect(harness.addOutbox).not.toHaveBeenCalled();
  });
});

describe("durable sends during transport failure", () => {
  it.each([false, true])("keeps a persisted message queued without restoring the draft (steer=%s)", async steer => {
    const bridge = useMobileBridge();
    const send = vi.fn().mockRejectedValue(new Error("Socket is not connected"));
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

describe("remote execution requests", () => {
  it("persists the confirmed choice without native steering before fresh capability verification", async () => {
    harness.state.snapshot.host.capabilities = ["session.remote-execution.v1"];
    const bridge = useMobileBridge();
    const send = vi.fn(); harness.refs[3]!.current.sendEnvelope = send;
    const receipt = await bridge.sendTurn("session-1", "Continue remotely", [], true, true);
    expect(harness.addOutbox).toHaveBeenCalledOnce();
    const envelope = harness.addOutbox.mock.calls[0]![0];
    expect(envelope.request).toMatchObject({ method: "turn.start", requestId: receipt.requestId,
      params: { sessionId: "session-1", text: "Continue remotely", bridgeExecutionRequested: true } });
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects unsupported hosts before creating an outbox message", async () => {
    harness.state.snapshot.host.capabilities = [];
    const bridge = useMobileBridge();
    await expect(bridge.sendTurn("session-1", "Keep draft", [], false, true)).rejects.toThrow("更新电脑端 Bridge");
    expect(harness.addOutbox).not.toHaveBeenCalled();
  });
});

describe("remote execution outbox capability", () => {
  it("keeps an authorized envelope on an older host and flushes only after a fresh supported response", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("document", { visibilityState: "visible" });
    harness.state.snapshot.host.capabilities = ["session.remote-execution.v1"];
    const bridge = useMobileBridge();
    await bridge.sendTurn("session-1", "Continue remotely", [], false, true);
    const envelope = { ...harness.addOutbox.mock.calls[0]![0], version: PROTOCOL_VERSION, roomId: "A", from: "mobile", fromDeviceId: "phone-A", to: "desktop",
      sentAt: Date.now(), expiresAt: Date.now() + 60_000 };
    vi.mocked(bridgeVault.listOutbox).mockResolvedValue([envelope]);
    harness.listMessages.mockResolvedValue([envelope]);
    harness.refs[1]!.current.decrypt = async () => ({ header: { from: "mobile", sentAt: envelope.sentAt }, payload: envelope.request });
    await bridge.retryConnection();
    const send = vi.fn().mockResolvedValue(undefined);
    harness.refs[3]!.current.sendEnvelope = send;
    const fresh = (requestId: string, supported: boolean) => {
      harness.refs[6]!.current.set(requestId, { resolve: vi.fn(), reject: vi.fn(), timer: setTimeout(() => {}, 10_000) });
      const current = snapshot("A"); current.host.capabilities = supported ? ["session.remote-execution.v1"] : [];
      harness.receive({ header: { sentAt: Date.now() }, payload: { kind: "response", requestId, ok: true, result: { snapshot: current } } } as DecryptedEnvelope,
        { id: requestId } as EncryptedEnvelope);
    };
    fresh("old-capabilities", false);
    await vi.waitFor(() => expect(harness.state.error).toContain("更新电脑端 Bridge"));
    expect(send).not.toHaveBeenCalled();
    expect(harness.state.localTurns[0]).toMatchObject({ text: "Continue remotely", delivery: "local-saved", bridgeExecutionRequested: true });
    await Promise.resolve();
    fresh("new-capabilities", true);
    await vi.waitFor(() => expect(send).toHaveBeenCalledExactlyOnceWith(envelope));
    bridge.backToHosts();
  });

  it("does not create a new remote request ahead of an older ordinary outbox entry", async () => {
    harness.state.snapshot.host.capabilities = ["session.remote-execution.v1"];
    const bridge = useMobileBridge();
    const old = { id: "older" } as EncryptedEnvelope;
    vi.mocked(bridgeVault.listOutbox).mockResolvedValue([old]);
    harness.refs[1]!.current.decrypt = async () => ({ payload: { kind: "request", method: "turn.start", params: { sessionId: "session-1", text: "Older input" } } });
    await expect(bridge.sendTurn("session-1", "New draft", [], false, true)).rejects.toThrow("先同步此会话的旧待发消息");
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
