import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  BridgeCrypto, PROTOCOL_VERSION,
  type BridgeMailDetail, type BridgeMailPage, type BridgeRequest, type BridgeSessionInfo, type DesktopControlSnapshot,
} from "@bridge/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantMailService } from "../../../../plugins/assistant-mail/desktop.js";
import { AssistantMailStore } from "../../../../plugins/assistant-mail/store.js";
import type { LoadedDesktopConfig } from "../transport/config.js";
import { assistantMailSnapshot } from "./assistant-mail.js";
import { DesktopController } from "./controller.js";

vi.mock("electron", () => ({ shell: {} }));

type ControllerArguments = ConstructorParameters<typeof DesktopController>;
type ControllerInternals = {
  publish(): Promise<DesktopControlSnapshot>;
  handleRequest(request: BridgeRequest, origin: "mobile"): Promise<unknown>;
};

let root: string;
let service: AssistantMailService;
let store: AssistantMailStore;
let run: Awaited<ReturnType<typeof fixture>>;

function nativeSession(sessionId: string, extra: Partial<BridgeSessionInfo> = {}): BridgeSessionInfo {
  return {
    sessionId, desktopSessionId: `local_${sessionId}`, title: sessionId, cwd: "/synthetic/assistant",
    runtimeId: "claude-desktop", projectId: "assistant-section", projectName: "Assistant", source: "desktop",
    transport: "claude-desktop-native", ownership: "DESKTOP_NATIVE_IDLE", turnState: "idle", pendingCount: 0,
    lastActivityAt: 1, ...extra,
  };
}

async function fixture() {
  const sessions = [nativeSession("native-first"), nativeSession("native-second", { projectId: "directory-project" })];
  const projects: DesktopControlSnapshot["projects"] = [
    { projectId: "assistant-section", name: "Assistant", kind: "desktop-group", cwd: "", runtimeId: "claude-desktop", sessionCount: 1, runningCount: 0, pendingCount: 0, lastActivityAt: 1 },
    { projectId: "directory-project", name: "Directory", cwd: "/synthetic/assistant", runtimeId: "claude-desktop", sessionCount: 1, runningCount: 0, pendingCount: 0, lastActivityAt: 1 },
  ];
  const broker = Object.assign(new EventEmitter(), {
    initialize: vi.fn(async () => undefined), listSessions: () => [...sessions], listProjects: () => projects,
    capabilities: vi.fn((): string[] => ["turn.start"]),
    runtimeStatus: vi.fn(() => ({ state: "ready", detail: "Synthetic broker", activeTurns: 0, maxParallelTurns: 1 })),
    permissionsList: () => [], promptsList: () => [], magpieSettings: async () => ({}),
    archive: vi.fn(async (_sessionId: string, _archived: boolean) => undefined),
    deleteSession: vi.fn(async (_sessionId: string) => undefined),
    createSession: vi.fn(), startTurn: vi.fn(),
  });
  const eventLog = Object.assign(new EventEmitter(), { append: vi.fn(async () => undefined), latestSeq: () => 0 });
  const relayUrl = "ws://127.0.0.1:18789/ws";
  const host = await BridgeCrypto.createHost(relayUrl, "Mail fixture");
  const config: LoadedDesktopConfig = {
    configVersion: 4, protocolVersion: PROTOCOL_VERSION, pairingEpoch: 1,
    hostDeviceId: host.crypto.identity.deviceId, roomId: host.crypto.identity.roomId,
    hostSecret: host.secret, evidenceKey: host.secret, desktopName: "Mail fixture",
    serviceOrigin: "http://127.0.0.1:18789", relayUrl,
    relayEndpoints: [{ id: "local", kind: "public-relay", url: relayUrl, priority: 1 }], activeEndpoint: "local",
    iceServers: [], createdAt: 1, launchAtLogin: false, managedDesktopEnabled: false, diagnosticsEnabled: false,
    defaultPermissionMode: "standard", runtimePermissionModes: {},
    devices: [{ deviceId: "synthetic-phone", name: "Phone", platform: "android", secret: host.secret, createdAt: 1, expiresAt: 2, pairedAt: 1 }],
  };
  const controller = new DesktopController(
    { getVersion: () => "synthetic", getLoginItemSettings: () => ({ openAtLogin: false }) } as ControllerArguments[0],
    { loadOrCreate: async () => config, save: vi.fn(async () => undefined) } as unknown as ControllerArguments[1],
    "http://127.0.0.1:18789", relayUrl,
    broker as unknown as ControllerArguments[4], eventLog as unknown as ControllerArguments[5],
    {} as ControllerArguments[6], { status: async () => ({ state: "stopped" }) } as unknown as ControllerArguments[7],
    undefined, undefined, undefined, undefined, undefined, service,
  );
  // Keep initialization subscriptions and snapshot/RPC/publication logic real; stop at external I/O and scheduling.
  const boundaries = {
    connect: vi.fn(async () => undefined), queuePublish: vi.fn(),
    broadcast: vi.fn(async () => undefined), desktopAppStatuses: async () => [],
  };
  Object.assign(controller, boundaries);
  await controller.initialize();
  const internals = controller as unknown as ControllerInternals;
  return {
    controller, broker, eventLog, sessions, projects, broadcast: boundaries.broadcast, queuePublish: boundaries.queuePublish,
    publish: () => internals.publish(),
    request: <T = unknown>(method: BridgeRequest["method"], params: Record<string, unknown> = {}) => internals.handleRequest(
      { kind: "request", requestId: "mail-request", idempotencyKey: "mail-key", method, params }, "mobile",
    ) as Promise<T>,
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(process.env.BRIDGE_TEST_TEMP_ROOT!, "controller-assistant-mail-"));
  store = new AssistantMailStore(root);
  await store.initialize();
  store.openMailbox("synthetic-account", "1", 1);
  service = new AssistantMailService({
    userDataPath: root,
    credentials: { supported: true, get: vi.fn(async () => { throw new Error("Unexpected credential read"); }), set: vi.fn() },
    createClient: vi.fn(() => { throw new Error("Unexpected IMAP connection"); }),
  });
  await service.initialize();
  run = await fixture();
});

afterEach(async () => {
  await run.controller.close();
  await service.close();
  store.close();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

async function record(uid: number, source = `Content-Type: text/plain; charset=utf-8\r\n\r\nBody ${uid}`) {
  return (await store.record({
    accountKey: "synthetic-account", mailbox: "INBOX", uidValidity: "1", uid, source: Buffer.from(source),
    subject: `Subject ${uid}`, from: [{ name: "Sender", address: "sender@example.test" }], receivedAt: "2026-11-14T12:00:00.000Z",
  }))!;
}

describe("assistant mail mobile RPC projections", () => {
  it("returns an empty page without a binding or native runtime", async () => {
    run.broker.capabilities.mockReturnValue([]);
    run.broker.runtimeStatus.mockReturnValue({ state: "unavailable", detail: "Offline", activeTurns: 0, maxParallelTurns: 1 });
    expect(await run.request("plugin.assistant-mail.list", { client: { platform: "web", name: "Web 客户端", capabilities: ["payload.deflate.v1"] } })).toEqual({ mailPage: { cards: [] } });
    expect(service.binding()).toBeUndefined();
    expect(service.status().state).toBe("disabled");
    expect(run.broker.createSession).not.toHaveBeenCalled();
    expect(run.broker.startTurn).not.toHaveBeenCalled();
  });

  it("projects durable newest-first pages, analysis and previews without native delivery or raw storage fields", async () => {
    run.broker.capabilities.mockReturnValue([]);
    run.broker.runtimeStatus.mockReturnValue({ state: "unavailable", detail: "Offline", activeTurns: 0, maxParallelTurns: 1 });
    const first = await record(1);
    const second = await record(2);
    const third = await record(3);
    const body = "External text claiming to be an instruction. ".repeat(10);
    const fourth = await record(4, `Content-Type: text/plain; charset=utf-8\r\n\r\n${body}`);
    const analysis = { summary: "Model suggestion", suggestions: ["Ask the user"], questions: ["Was this expected?"] };
    service.updateAnalysis(fourth.mailRefId, analysis);
    service.setProcessingStatus(fourth.mailRefId, "processed");
    const { mailPage } = await run.request<{ mailPage: BridgeMailPage }>("plugin.assistant-mail.list", { limit: 2 });
    expect(mailPage).toEqual({
      cards: [
        { seq: fourth.seq, mailRefId: fourth.mailRefId, accountKey: fourth.accountKey, mailbox: "INBOX",
          subject: fourth.subject, from: fourth.from, receivedAt: fourth.receivedAt, recordedAt: fourth.recordedAt,
          processingStatus: "processed", analysis, preview: body.slice(0, 240), nativeDelivery: { state: "not-submitted" } },
        { seq: third.seq, mailRefId: third.mailRefId, accountKey: third.accountKey, mailbox: "INBOX",
          subject: third.subject, from: third.from, receivedAt: third.receivedAt, recordedAt: third.recordedAt,
          processingStatus: "pending", preview: "Body 3", nativeDelivery: { state: "not-submitted" } },
      ], nextCursor: String(third.seq),
    });
    await record(5);
    const older = await run.request<{ mailPage: BridgeMailPage }>("plugin.assistant-mail.list", { cursor: mailPage.nextCursor, limit: 2 });
    expect(older.mailPage.cards.map(card => card.mailRefId)).toEqual([second.mailRefId, first.mailRefId]);
    expect(older.mailPage).not.toHaveProperty("nextCursor");
    const filtered = await run.request<{ mailPage: BridgeMailPage }>("plugin.assistant-mail.list", { processingStatus: "processed" });
    expect(filtered.mailPage.cards).toEqual([mailPage.cards[0]]);
    expect(JSON.stringify(mailPage)).not.toContain(root);
    expect(run.broker.createSession).not.toHaveBeenCalled();
    expect(run.broker.startTurn).not.toHaveBeenCalled();
    expect(service.binding()).toBeUndefined();
  });

  it("reads cleaned MIME text without HTML, attachments, raw bytes or a native ACK", async () => {
    run.broker.capabilities.mockReturnValue([]);
    const event = await record(1, [
      "MIME-Version: 1.0", 'Content-Type: multipart/mixed; boundary="mail"', "",
      "--mail", "Content-Type: text/html; charset=utf-8", "",
      '<p>Hello <b>reader</b>\u0000</p><img src="https://example.test/tracker.png">',
      "--mail", "Content-Type: application/octet-stream", 'Content-Disposition: attachment; filename="private.bin"',
      "Content-Transfer-Encoding: base64", "", Buffer.from("ATTACHMENT SECRET").toString("base64"), "--mail--", "",
    ].join("\r\n"));
    const result = await run.request<{ mailDetail: BridgeMailDetail }>("plugin.assistant-mail.read", { mailRefId: event.mailRefId });
    expect(result).toEqual({
      mailDetail: { mailRefId: event.mailRefId, bodyText: expect.stringContaining("Hello reader"), truncated: false },
    });
    expect(result.mailDetail.bodyText).not.toMatch(/<[^>]*>|ATTACHMENT SECRET|\u0000/u);
    expect(run.broker.startTurn).not.toHaveBeenCalled();
    expect(run.broker.createSession).not.toHaveBeenCalled();
    expect(service.binding()).toBeUndefined();
  });

  it.each([256_000, 256_001])("bounds read body text at 256000 characters for length %s", async length => {
    const event = await record(1, `Content-Type: text/plain; charset=utf-8\r\n\r\n${"x".repeat(length)}`);
    const { mailDetail } = await run.request<{ mailDetail: BridgeMailDetail }>("plugin.assistant-mail.read", { mailRefId: event.mailRefId });
    expect(mailDetail).toEqual({ mailRefId: event.mailRefId, bodyText: "x".repeat(256_000), truncated: length > 256_000 });
  });

  it("returns NOT_FOUND for a missing mail reference", async () => {
    await expect(run.request("plugin.assistant-mail.read", { mailRefId: "00000000-0000-4000-8000-000000000000" }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("assistant native session binding", () => {
  it("keeps one assistantId, records distinct previous sessions and derives the Section only from desktop groups", async () => {
    const first = await run.request<{ assistantMail: DesktopControlSnapshot["assistantMail"] }>("plugin.assistant-mail.bind", { sessionId: "native-first" });
    const binding = service.binding()!;
    expect(binding.assistantId).toMatch(/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/u);
    expect(first.assistantMail).toMatchObject({ binding, bindingState: "ready", automaticDelivery: false });
    expect(binding).toEqual({ assistantId: expect.any(String), nativeSessionId: "native-first", sectionId: "assistant-section", previousSessionIds: [] });
    await run.request("plugin.assistant-mail.bind", { sessionId: "native-first" });
    expect(service.binding()).toEqual(binding);
    await run.request("plugin.assistant-mail.bind", { sessionId: "native-second" });
    expect(service.binding()).toEqual({ ...binding, nativeSessionId: "native-second", sectionId: null, previousSessionIds: ["native-first"] });
    await run.request("plugin.assistant-mail.bind", { sessionId: "native-first" });
    await run.request("plugin.assistant-mail.bind", { sessionId: "native-second" });
    expect(store.binding()).toEqual({ ...binding, nativeSessionId: "native-second", sectionId: null, previousSessionIds: ["native-first", "native-second"] });
    expect(run.broker.createSession).not.toHaveBeenCalled();
    expect(run.broker.startTurn).not.toHaveBeenCalled();
  });

  it.each(["archived", "missing", "non-native"])("rejects a %s target without overwriting the stored binding", async target => {
    await run.request("plugin.assistant-mail.bind", { sessionId: "native-first" });
    const binding = service.binding();
    if (target !== "missing") run.sessions.push(nativeSession("invalid-target", target === "archived"
      ? { archivedAt: 123 } : { transport: "bridge-host" }));
    const setBinding = vi.spyOn(service, "setBinding");
    await expect(run.request("plugin.assistant-mail.bind", { sessionId: "invalid-target" }))
      .rejects.toMatchObject({ code: "INVALID_SESSION" });
    expect(service.binding()).toEqual(binding);
    expect(setBinding).not.toHaveBeenCalled();
  });

  it.each(["session.archive", "session.delete"] as const)("pauses binding only after %s succeeds and keeps history for explicit rebind", async method => {
    await run.request("plugin.assistant-mail.bind", { sessionId: "native-first" });
    const binding = service.binding()!;
    const setBinding = vi.spyOn(service, "setBinding");
    let complete!: (value: undefined) => void;
    const operation = method === "session.archive" ? run.broker.archive : run.broker.deleteSession;
    operation.mockReturnValueOnce(new Promise<undefined>(resolve => { complete = resolve; }));
    const requested = run.request(method, { sessionId: "native-first" });
    expect(operation).toHaveBeenCalledOnce();
    expect(service.binding()).toEqual(binding);
    expect(setBinding).not.toHaveBeenCalled();
    complete(undefined);
    await requested;
    expect(service.binding()).toEqual({ ...binding, nativeSessionId: null, previousSessionIds: ["native-first"] });
    expect(setBinding).toHaveBeenCalledOnce();
    expect((await run.controller.snapshot()).assistantMail).toMatchObject({ bindingState: "needs-rebind", automaticDelivery: false });
    await run.request("plugin.assistant-mail.bind", { sessionId: "native-second" });
    expect(store.binding()).toEqual({ ...binding, nativeSessionId: "native-second", sectionId: null, previousSessionIds: ["native-first"] });
  });

  it.each(["session.archive", "session.delete"] as const)("preserves the binding when %s fails in the native broker", async method => {
    await run.request("plugin.assistant-mail.bind", { sessionId: "native-first" });
    const binding = service.binding();
    const setBinding = vi.spyOn(service, "setBinding");
    run.eventLog.append.mockClear();
    const operation = method === "session.archive" ? run.broker.archive : run.broker.deleteSession;
    operation.mockRejectedValueOnce(new Error("Native operation failed"));
    await expect(run.request(method, { sessionId: "native-first" })).rejects.toThrow("Native operation failed");
    expect(store.binding()).toEqual(binding);
    expect(setBinding).not.toHaveBeenCalled();
    expect(run.eventLog.append).not.toHaveBeenCalled();
  });

  it.each(["session.archive", "session.delete"] as const)("leaves an unrelated binding active after %s", async method => {
    await run.request("plugin.assistant-mail.bind", { sessionId: "native-first" });
    const binding = service.binding();
    const setBinding = vi.spyOn(service, "setBinding");
    await run.request(method, { sessionId: "native-second" });
    expect(service.binding()).toEqual(binding);
    expect(setBinding).not.toHaveBeenCalled();
  });

  it("does not pause a binding when restoring its native session", async () => {
    await run.request("plugin.assistant-mail.bind", { sessionId: "native-first" });
    const binding = service.binding();
    const setBinding = vi.spyOn(service, "setBinding");
    await run.request("session.archive", { sessionId: "native-first", archived: false });
    expect(run.broker.archive).toHaveBeenCalledExactlyOnceWith("native-first", false);
    expect(service.binding()).toEqual(binding);
    expect(setBinding).not.toHaveBeenCalled();
  });

  it("does not pause or recreate the assistant when a broker catalog temporarily omits its session", async () => {
    await run.request("plugin.assistant-mail.bind", { sessionId: "native-first" });
    const binding = service.binding();
    const setBinding = vi.spyOn(service, "setBinding");
    const omitted = run.sessions.splice(0);
    run.broker.emit("changed");
    run.broker.emit("changed");
    expect((await run.publish()).assistantMail).toMatchObject({ binding, bindingState: "missing", automaticDelivery: false });
    expect(store.binding()).toEqual(binding);
    expect(setBinding).not.toHaveBeenCalled();
    run.sessions.push(...omitted);
    run.broker.emit("changed");
    expect((await run.controller.snapshot()).assistantMail).toMatchObject({ binding, bindingState: "ready" });
    expect(run.broker.createSession).not.toHaveBeenCalled();
    expect(run.broker.startTurn).not.toHaveBeenCalled();
  });

  it("keeps automatic delivery disabled for every helper binding state", () => {
    expect(assistantMailSnapshot(service, [], true, "unbound")).toEqual({
      bindingState: "unbound", receiverState: "disabled", automaticDelivery: false, changeToken: "unbound",
    });
    service.setBinding({ assistantId: "assistant", nativeSessionId: "native-first", sectionId: null, previousSessionIds: [] });
    for (const [sessions, available, bindingState] of [
      [run.sessions, true, "ready"], [run.sessions, false, "unavailable"], [[], true, "missing"],
      [[nativeSession("native-first", { archivedAt: 123 })], true, "needs-rebind"],
    ] as const) {
      expect(assistantMailSnapshot(service, [...sessions], available, "marker")).toEqual({
        binding: service.binding(), bindingState, receiverState: "disabled", automaticDelivery: false, changeToken: "marker",
      });
    }
    service.setBinding({ assistantId: "assistant", nativeSessionId: null, sectionId: null, previousSessionIds: ["native-first"] });
    expect(assistantMailSnapshot(service, [], true, "paused")).toMatchObject({ bindingState: "needs-rebind", automaticDelivery: false, changeToken: "paused" });
  });
});

describe("assistant mail snapshot publication", () => {
  it("publishes a mail analysis change marker to mobile while sessions, binding and receiver stay unchanged", async () => {
    const event = await record(1);
    const before = await run.publish();
    run.broadcast.mockClear();
    await run.publish();
    expect(run.broadcast).not.toHaveBeenCalled();
    service.updateAnalysis(event.mailRefId, { summary: "Updated suggestion", suggestions: [], questions: [] });
    expect(run.queuePublish).toHaveBeenCalledOnce();
    expect(run.eventLog.append).toHaveBeenCalledExactlyOnceWith({
      origin: "system", type: "plugin.assistant-mail.changed",
      data: { assistantMail: { ...before.assistantMail, changeToken: expect.any(String) } },
    });
    const after = await run.publish();
    expect(after.assistantMail).toEqual({ ...before.assistantMail, changeToken: expect.any(String) });
    expect(after.assistantMail!.changeToken).not.toBe(before.assistantMail!.changeToken);
    expect(after.sessions).toEqual(before.sessions);
    expect(after.projects).toEqual(before.projects);
    expect(run.broadcast).toHaveBeenCalledExactlyOnceWith({ kind: "snapshot", snapshot: after }, true);
    run.broadcast.mockClear();
    await run.publish();
    expect(run.broadcast).not.toHaveBeenCalled();
    expect(run.broker.startTurn).not.toHaveBeenCalled();
  });
});
