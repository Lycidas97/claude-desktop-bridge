import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { AsyncInputQueue } from "./async-input-queue.js";
import { ClaudeSessionHost } from "./claude-session-host.js";
import { SessionBroker, type TranscriptObserverRuntime } from "./session-broker.js";
import { SessionEventLog } from "./session-event-log.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(credentialsAvailable = true) {
  const root = await mkdtemp(join(tmpdir(), "bridge-boundaries-"));
  roots.push(root);
  const eventLog = new SessionEventLog(join(root, "events.jsonl"), 1);
  const queries: Array<{ output: AsyncInputQueue<SDKMessage>; close(): void }> = [];
  const hosts: ClaudeSessionHost[] = [];
  const inputs: AsyncIterator<SDKUserMessage>[] = [];
  const interrupt = vi.fn(async () => ({ still_queued: [] as string[] }));
  const observer: TranscriptObserverRuntime = {
    catalog: { sessions: [{ sessionId: "seed", cwd: root, projectId: "p", projectName: "p", title: "seed", source: "desktop", ownership: "DESKTOP_OBSERVED", transport: "bridge-host", turnState: "idle", pendingCount: 0, lastActivityAt: Date.now(), transcriptMtimeMs: 0, processAlive: false, desktopProcessAlive: false, bridgeProcessAlive: false, processOverlap: false, activeProcesses: [], activeTask: false }], projects: [], observedAt: Date.now() },
    isDesktopBusy: () => false, isMainTurnBusy: () => false,
    runningSubagents: () => undefined,
    externalWriteVersion: () => 0, async canStartBridgeHost() { return true; }, onCatalog: () => () => {},
  };
  const broker = new SessionBroker({
    paths: { sessions: join(root, "sessions"), projects: join(root, "projects"), tasks: join(root, "tasks"), desktopSessions: [] },
    sessionsPath: join(root, "sessions.json"), queuePath: join(root, "queue.json"), eventLog, observer,
    prepareRuntime: async () => ({ executablePath: "/fake/claude", ...(credentialsAvailable ? { credentialPath: "/fake/creds" } : {}), environment: {} }),
    discoverGatewayModels: async () => [], scanSessionProcesses: async () => [],
    hostFactory: options => {
      const host = new ClaudeSessionHost({ ...options, queryFactory: ((params) => {
        inputs.push((params.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]());
        const output = new AsyncInputQueue<SDKMessage>();
        const fake = {
          output, [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](),
          async initializationResult() { return {}; },
          async [Symbol.asyncDispose]() { output.close(); },
          async setModel() {}, async applyFlagSettings() {},
          async supportedModels() { return []; }, async stopTask() {},
          interrupt, async backgroundTasks() { return true; }, close() { output.close(); },
        };
        queries.push(fake);
        return fake as unknown as Query;
      }) });
      hosts.push(host);
      return host;
    },
  });
  await broker.initialize();
  const session = await broker.createSession(root, "Review");
  const internals = broker as unknown as { eventQueue: Promise<void>; pump(): Promise<void>; releaseSession(id: string): Promise<void>; recordOwnership(id: string, state: string): Promise<void> };
  const submit = (key: string, mode: "start" | "steer" = "start") => broker.startTurn({ sessionId: session.sessionId, requestId: key, idempotencyKey: key, text: key, origin: "mobile", mode });
  const result = (query: number, messageId: string) => queries[query]!.output.push({
    type: "result", subtype: "success", is_error: false, result: "Done", user_message_uuid: messageId,
    origin: { kind: "human" }, session_id: session.sessionId, uuid: `result-${query}`,
  } as SDKMessage);
  return { broker, internals, session, queries, hosts, inputs, interrupt, eventLog, submit, result, setCredentialsAvailable(value: boolean) { credentialsAvailable = value; }, async close() { await broker.close(); await eventLog.close(); } };
}

it.each(["completed", "failed", "preempted"])("keeps the new native command active when the old turn finishes as %s", async outcome => {
  const f = await fixture();
  try {
    const first = await f.submit("original");
    await f.internals.pump();
    const firstInput = (await f.inputs[0]!.next()).value!;
    const ordinary = await f.submit("ordinary");
    const queued = await f.submit("adjust");
    await f.broker.steerQueuedTurn(f.session.sessionId, queued.commandId);
    const input = (await f.inputs[0]!.next()).value!;
    expect(input.priority).toBe("now");
    expect(f.queries).toHaveLength(1);
    expect(f.interrupt).not.toHaveBeenCalled();
    f.queries[0]!.output.push(input);
    await vi.waitFor(() => expect(f.eventLog.replay(0).some(event => event.type === "turn.started" && event.data.commandId === queued.commandId)).toBe(true));
    const nativeTurnId = f.broker.session(f.session.sessionId)?.activeTurnId;
    f.queries[0]!.output.push({ type: "result", subtype: outcome === "failed" ? "error_during_execution" : "success", is_error: outcome === "failed",
      result: "Old response", errors: ["Old turn failed"], user_message_uuid: firstInput.uuid,
      ...(outcome === "preempted" ? { terminal_reason: "aborted_streaming" } : {}),
      origin: { kind: "human" }, session_id: f.session.sessionId, uuid: randomUUID(),
    } as unknown as SDKMessage);
    const type = outcome === "failed" ? "turn.failed" : outcome === "preempted" ? "turn.interrupted" : "turn.completed";
    await vi.waitFor(() => expect(f.eventLog.replay(0).some(event => event.type === type && event.data.commandId === first.commandId)).toBe(true));
    await f.internals.eventQueue;
    expect(f.broker.session(f.session.sessionId)?.activeTurnId).toBe(nativeTurnId);
    expect(f.broker.runtimeStatus().activeTurns).toBe(1);
    expect(f.broker.session(f.session.sessionId)?.pendingCommandIds).toEqual([ordinary.commandId]);
    expect((await f.submit("adjust")).state).toBe("running");
    f.result(0, input.uuid!);
    await vi.waitFor(() => expect(f.eventLog.replay(0).some(event => event.type === "turn.completed" && event.data.commandId === queued.commandId)).toBe(true));
    await f.internals.eventQueue;
    expect(f.broker.session(f.session.sessionId)?.pendingCount).toBe(0);
    expect((await f.inputs[0]!.next()).value?.priority).toBeUndefined();
  } finally { await f.close(); }
});

it("settles a coalesced group of native commands and releases exactly one host slot", async () => {
  const f = await fixture();
  try {
    const first = await f.submit("first");
    await f.internals.pump();
    const inputs = [(await f.inputs[0]!.next()).value!];
    const second = await f.submit("second");
    await f.broker.steerQueuedTurn(f.session.sessionId, second.commandId);
    inputs.push((await f.inputs[0]!.next()).value!);
    const third = await f.submit("third");
    await f.broker.steerQueuedTurn(f.session.sessionId, third.commandId);
    inputs.push((await f.inputs[0]!.next()).value!);
    expect(f.broker.runtimeStatus().activeTurns).toBe(1);
    f.queries[0]!.output.push({ type: "result", subtype: "success", is_error: false, result: "All requests answered",
      user_message_uuid: inputs[2]!.uuid, user_message_uuids: inputs.map(input => input.uuid),
      origin: { kind: "human" }, session_id: f.session.sessionId, uuid: randomUUID(),
    } as unknown as SDKMessage);
    await vi.waitFor(() => expect(f.eventLog.replay(0).filter(event => event.type === "turn.completed")).toHaveLength(3));
    await f.internals.eventQueue;
    expect(f.broker.runtimeStatus().activeTurns).toBe(0);
    expect(f.broker.session(f.session.sessionId)?.pendingCount).toBe(0);
    for (const key of ["first", "second", "third"]) expect((await f.submit(key)).state).toBe("completed");
    expect(f.eventLog.replay(0).filter(event => event.type === "turn.completed").map(event => event.data.commandId)).toEqual([first.commandId, second.commandId, third.commandId]);
    expect(f.interrupt).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

it("stopping a host with in-flight native steers does not release another session's slot", async () => {
  const f = await fixture();
  try {
    await f.submit("first");
    await f.internals.pump();
    const queued = await f.submit("steered");
    await f.broker.steerQueuedTurn(f.session.sessionId, queued.commandId);
    const other = await f.broker.createSession(f.session.cwd, "Other");
    await f.broker.startTurn({ sessionId: other.sessionId, requestId: "other", idempotencyKey: "other", text: "Other work", origin: "mobile" });
    await f.internals.pump();
    expect(f.broker.runtimeStatus().activeTurns).toBe(2);
    await f.broker.interruptTurn(f.session.sessionId, undefined, true);
    await f.internals.eventQueue;
    expect(f.broker.runtimeStatus().activeTurns).toBe(1);
    expect(f.broker.session(other.sessionId)?.ownership).toBe("BRIDGE_RUNNING");
    expect((await f.submit("steered")).state).toBe("cancelled");
  } finally { await f.close(); }
});

it("drains blocked conflict settlement before shutdown releases persistence", async () => {
  const f = await fixture();
  const internal = f.broker as unknown as {
    commandEvidence(turn: unknown): Promise<{ submitted?: true }>;
    containOwnershipConflict(sessionId: string, processes: []): Promise<void>;
    saveQueue(): Promise<void>;
  };
  let releaseEvidence!: () => void;
  let conflict: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let closed = false;
  try {
    await f.submit("first");
    await f.internals.pump();
    await f.internals.eventQueue;
    const evidence = new Promise<void>(resolve => { releaseEvidence = resolve; });
    vi.spyOn(internal, "commandEvidence").mockImplementation(async () => { await evidence; return { submitted: true }; });
    conflict = internal.containOwnershipConflict(f.session.sessionId, []);
    // Remove disk timing from the close probe: every unrelated drain is settled.
    // The actual conflict writes are restored before releasing its evidence read.
    const saveQueue = vi.spyOn(internal, "saveQueue").mockResolvedValue(undefined);
    closing = f.broker.close().then(() => { closed = true; });
    await new Promise(resolve => setImmediate(resolve));
    saveQueue.mockRestore();
    expect(closed).toBe(false);
    releaseEvidence();
    await closing;
    expect(f.hosts[0]!.running).toBe(false);
    expect(f.eventLog.replay().some(event => event.type === "session.ownership-conflict")).toBe(true);
    const append = vi.spyOn(f.eventLog, "append");
    await conflict;
    await f.internals.eventQueue;
    expect(append).not.toHaveBeenCalled();
  } finally {
    releaseEvidence?.();
    await conflict;
    await closing;
    await f.close();
  }
});

it("waits for runtime retry instead of redispatching two sessions without credentials", async () => {
  const f = await fixture(false);
  const internal = f.broker as unknown as {
    pending: Array<Record<string, unknown>>;
    dispatchTurn(turn: unknown): Promise<void>;
    scheduleRuntimeRetry(): void;
    runtimeRetryTimer?: NodeJS.Timeout;
    closed: boolean;
  };
  let attempts = 0;
  const original = internal.dispatchTurn.bind(internal);
  const dispatch = vi.spyOn(internal, "dispatchTurn").mockImplementation(async turn => {
    // Yield at each dispatch so the broken microtask loop cannot starve the test runner.
    await new Promise(resolve => setImmediate(resolve));
    if (++attempts >= 8) { internal.closed = true; return; }
    await original(turn);
  });
  const retry = vi.spyOn(internal, "scheduleRuntimeRetry");
  try {
    await f.submit("first");
    const secondSession = await f.broker.createSession(f.session.cwd, "Second");
    await f.broker.startTurn({ sessionId: secondSession.sessionId, requestId: "second", idempotencyKey: "second", text: "second", origin: "mobile" });
    for (let tick = 0; tick < 15; tick++) await new Promise(resolve => setImmediate(resolve));
    expect(attempts).toBe(0);
    expect(retry).toHaveBeenCalled();
    expect(internal.runtimeRetryTimer).toBeDefined();
    expect(internal.pending).toHaveLength(2);
    f.setCredentialsAvailable(true);
    dispatch.mockRestore();
    await f.broker.refreshRuntime();
    await f.internals.pump();
    expect(f.hosts).toHaveLength(2);
  } finally {
    internal.closed = false;
    dispatch.mockRestore();
    await f.close();
  }
});

it("keeps background task authority after restarting a query on the same host", async () => {
  const f = await fixture();
  try {
    const first = await f.submit("first");
    await f.internals.pump();
    f.result(0, (first as { messageId: string }).messageId);
    await vi.waitFor(() => expect(f.broker.runtimeStatus().activeTurns).toBe(0));
    f.queries[0]!.close();
    await vi.waitFor(() => expect(f.hosts[0]!.running).toBe(false));
    await f.internals.eventQueue;
    await f.submit("second");
    await f.internals.pump();
    expect(f.hosts.length).toBe(1);
    expect(f.queries.length).toBe(2);
    f.queries[1]!.output.push({ type: "system", subtype: "task_started", task_id: "new-child", tool_use_id: "new-tool", description: "Working", session_id: f.session.sessionId, uuid: randomUUID() } as SDKMessage);
    await vi.waitFor(() => expect(f.hosts[0]!.runningBackgroundTasks.length).toBe(1));
    await f.internals.eventQueue;
    expect(f.broker.session(f.session.sessionId)?.runningSubagents?.count).toBe(1);
    const stopTask = vi.spyOn(f.hosts[0]!, "stopTask");
    await f.broker.stopSubagent(f.session.sessionId, "new-child");
    expect(stopTask).toHaveBeenCalledWith("new-child");
  } finally { await f.close(); }
});

it("does not attribute a failed query's trailing runtime error to the next queued command", async () => {
  const f = await fixture();
  try {
    await f.submit("first");
    await f.internals.pump();
    const second = await f.submit("second");
    f.queries[0]!.close();
    await vi.waitFor(() => expect(f.queries.length).toBe(2));
    await f.internals.eventQueue;
    const secondReceipt = await f.submit("second");
    expect(secondReceipt.state).toBe("running");
    expect(f.eventLog.replay().filter(event => event.type === "runtime.error" && event.data.commandId === second.commandId)).toEqual([]);
    expect(f.eventLog.replay().some(event => event.type === "runtime.error" && event.data.error === "Claude session ended before returning a turn result")).toBe(true);
    f.result(1, (second as { messageId: string }).messageId);
    await vi.waitFor(() => expect(f.broker.runtimeStatus().activeTurns).toBe(0));
    expect((await f.submit("second")).state).toBe("completed");
  } finally { await f.close(); }
});

it("queues a new command until idle release has closed its old host", async () => {
  const f = await fixture();
  let finishRelease!: () => void;
  let releasing: Promise<void> | undefined;
  try {
    const first = await f.submit("first");
    await f.internals.pump();
    f.result(0, (first as { messageId: string }).messageId);
    await vi.waitFor(() => expect(f.broker.runtimeStatus().activeTurns).toBe(0));
    await f.internals.eventQueue;
    const original = f.internals.recordOwnership.bind(f.internals);
    const held = new Promise<void>(resolve => { finishRelease = resolve; });
    vi.spyOn(f.internals, "recordOwnership").mockImplementation(async (id, state) => {
      await original(id, state);
      if (state === "RELEASING") await held;
    });
    releasing = f.internals.releaseSession(f.session.sessionId);
    await vi.waitFor(() => expect(f.broker.session(f.session.sessionId)?.ownership).toBe("RELEASING"));
    const second = await f.submit("second");
    await f.internals.pump();
    expect(second.state).toBe("queued");
    finishRelease();
    await releasing;
    await vi.waitFor(() => expect(f.hosts.length).toBe(2));
    await f.internals.pump();
    await f.internals.eventQueue;
    expect((await f.submit("second")).state).toBe("running");
  } finally { finishRelease?.(); await releasing; await f.close(); }
});

it("reserves capacity without showing execution before SDK acceptance", async () => {
  const f = await fixture();
  try {
    const turn = await f.submit("first");
    await f.internals.pump();
    expect(f.broker.runtimeStatus().activeTurns).toBe(1);
    expect(f.broker.session(f.session.sessionId)?.turnState).toBe("queued");
    f.queries[0]!.output.push({
      type: "user", uuid: (turn as { messageId: string }).messageId, session_id: f.session.sessionId,
      parent_tool_use_id: null, origin: { kind: "human" }, message: { role: "user", content: "first" },
    } as SDKMessage);
    await vi.waitFor(() => expect(f.broker.session(f.session.sessionId)?.turnState).toBe("running"));
  } finally { await f.close(); }
});

it("keeps an accepted steer command pending until its actual result", async () => {
  const f = await fixture();
  try {
    const turn = await f.submit("steer", "steer");
    await f.internals.pump();
    const messageId = (turn as { messageId: string }).messageId;
    f.queries[0]!.output.push({
      type: "user", uuid: messageId, session_id: f.session.sessionId, parent_tool_use_id: null,
      origin: { kind: "human" }, message: { role: "user", content: "steer" },
    } as SDKMessage);
    await vi.waitFor(() => expect(f.eventLog.replay().some(event => event.type === "user.message.accepted")).toBe(true));
    await f.internals.eventQueue;
    expect((await f.submit("steer", "steer")).state).toBe("running");
    expect(f.broker.runtimeStatus().activeTurns).toBe(1);
    f.result(0, messageId);
    await vi.waitFor(() => expect(f.broker.runtimeStatus().activeTurns).toBe(0));
    expect((await f.submit("steer", "steer")).state).toBe("completed");
  } finally { await f.close(); }
});

it("persists an absent task's unknown status as progress rather than completion", async () => {
  const f = await fixture();
  try {
    await f.submit("first");
    await f.internals.pump();
    f.queries[0]!.output.push({ type: "system", subtype: "task_started", task_id: "child", tool_use_id: "child-tool", description: "Working", session_id: f.session.sessionId, uuid: randomUUID() } as SDKMessage);
    await vi.waitFor(() => expect(f.hosts[0]!.runningBackgroundTasks.length).toBe(1));
    await f.internals.eventQueue;
    f.queries[0]!.output.push({ type: "system", subtype: "background_tasks_changed", tasks: [], session_id: f.session.sessionId, uuid: randomUUID() } as SDKMessage);
    await vi.waitFor(() => expect(f.hosts[0]!.runningBackgroundTasks.length).toBe(0));
    await f.internals.eventQueue;
    expect(f.eventLog.latestTaskEvents(f.session.sessionId).at(-1)).toMatchObject({ type: "tool.progress", data: { subagent: { state: "unknown" } } });
  } finally { await f.close(); }
});
