import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ClaudeSessionHostOptions, SessionHostEvent } from "./claude-session-host.js";
import { ConversationStateStore } from "./conversation-state-store.js";
import { ProviderRuntimePool } from "./provider-runtime-pool.js";
import type { ProviderRegistry } from "./provider-registry.js";
import { SessionBroker, type SessionHostRuntime } from "./session-broker.js";
import { SessionEventLog } from "./session-event-log.js";
import { TranscriptObserver } from "./transcript-observer.js";
import { InboxSendError } from "./claude-desktop-inbox.js";

const directories: string[] = [];
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "darwin" });
});
afterEach(async () => {
  Object.defineProperty(process, "platform", platformDescriptor);
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function fixture({ busy = false, split = true, staleLogical = false, desktopAlive = true, inbox = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "bridge-native-ownership-"));
  directories.push(root);
  const sessionId = randomUUID(), nativeSessionId = split ? randomUUID() : sessionId;
  const paths = { sessions: join(root, "sessions"), tasks: join(root, "tasks"), projects: join(root, "projects"), desktopSessions: [] };
  await Promise.all([mkdir(paths.sessions), mkdir(paths.projects)]);
  const transcript = join(paths.projects, `${nativeSessionId}.jsonl`);
  await writeFile(transcript, [
    JSON.stringify({ type: "user", uuid: "initial-user", parentUuid: null, sessionId: nativeSessionId, cwd: root, message: { role: "user", content: "Desktop work" } }),
    ...(!busy ? [JSON.stringify({ type: "assistant", uuid: "initial-answer", parentUuid: "initial-user", sessionId: nativeSessionId, message: { role: "assistant", content: "Done", stop_reason: "end_turn" } })] : []),
    "",
  ].join("\n"));
  const registerDesktopExecutor = (alive: boolean) => writeFile(join(paths.sessions, "desktop.json"), JSON.stringify({
    pid: alive ? process.pid : 2147483647, sessionId: nativeSessionId, cwd: root, startedAt: Date.now(), entrypoint: "claude-desktop-3p",
    ...(inbox ? { peerProtocol: 1, messagingSocketPath: "/tmp/bridge-fixture.sock" } : {}),
  }));
  await registerDesktopExecutor(desktopAlive);
  const sessionsPath = join(root, "bridge-sessions.json"), queuePath = join(root, "queue.json");
  await writeFile(sessionsPath, JSON.stringify({ version: 2, sessions: [{ sessionId, cwd: root, title: "Conversation", createdAt: 1 }] }));
  const state = new ConversationStateStore({ databasePath: join(root, "state.sqlite"), sessionsPath, queuePath, masterSecret: "native-ownership-test" });
  await state.initialize();
  state.updateLane(state.route(sessionId)!.activeLaneId, { nativeSessionId });
  const eventLog = new SessionEventLog(join(root, "events.jsonl"), 1);
  const observer = new TranscriptObserver({ paths, eventLog, platform: "linux", pollIntervalMs: 60_000, catalogIntervalMs: 0 });
  if (staleLogical && split) {
    const previousTranscript = join(paths.projects, `${sessionId}.jsonl`);
    await writeFile(previousTranscript, `${JSON.stringify({ type: "assistant", uuid: "previous-answer", sessionId, cwd: root, message: { role: "assistant", content: "Done", stop_reason: "end_turn" } })}\n`);
    await writeFile(join(paths.sessions, "logical.json"), JSON.stringify({
      pid: 2147483647, sessionId, cwd: root, startedAt: 1, entrypoint: "claude-desktop-3p",
    }));
  }
  await observer.start();
  const events = new EventEmitter();
  const send = vi.fn((input: Parameters<SessionHostRuntime["send"]>[0], origin: Parameters<SessionHostRuntime["send"]>[1]) => {
    const receipt = { messageId: typeof input === "string" ? randomUUID() : input.messageId ?? randomUUID(), turnId: typeof input === "string" ? randomUUID() : input.turnId ?? randomUUID() };
    events.emit("event", { type: "user.submitted", sessionId, ...receipt, at: Date.now() });
    events.emit("event", { type: "user.accepted", sessionId, ...receipt, text: typeof input === "string" ? input : input.text, attachments: [], origin, at: Date.now() });
    events.emit("event", { type: "turn.started", sessionId, turnId: receipt.turnId, at: Date.now() });
    return receipt;
  });
  const closeHost = vi.fn(async () => {});
  const hostFactory = vi.fn((_options: ClaudeSessionHostOptions): SessionHostRuntime => ({
    start() {}, async setModel() {}, async setEffort() {}, async setAutoCompactWindow() {},
    async supportedModels() { return []; }, async contextUsage() { throw new Error("unused"); },
    send, async interrupt() {}, async stopTask() {}, close: closeHost,
    onEvent(listener: (event: SessionHostEvent) => void) { events.on("event", listener); return () => events.off("event", listener); },
  }));
  const inboxEvents = new EventEmitter();
  const inboxSend = vi.fn(async (_endpoint: { socketPath: string; sessionId: string; pid: number }, _input: { messageId: string; text: string }) => {});
  const desktopInbox = { send: inboxSend, forget: vi.fn(), onReceipt(listener: (receipt: { messageId: string; status: "held" | "refused" }) => void) { inboxEvents.on("receipt", listener); return () => inboxEvents.off("receipt", listener); } };
  const scanSessionProcesses = vi.fn(async (_paths: unknown, _id: string) => inbox && observer.session(nativeSessionId)?.desktopProcessAlive
    ? [{ pid: process.pid, startedAt: 1, processAlive: true, entrypoint: "claude-desktop-3p", source: "process" as const, peerProtocol: 1, messagingSocketPath: "/tmp/bridge-fixture.sock" }]
    : [] as Array<{ pid: number; startedAt: number; processAlive: boolean; entrypoint: string; source: "process"; peerProtocol?: number; messagingSocketPath?: string }>);
  const brokerOptions: ConstructorParameters<typeof SessionBroker>[0] = {
    paths, observer, eventLog, sessionsPath, queuePath, conversationState: state,
    ...(inbox ? { desktopInbox } : {}),
    runtimePool: new ProviderRuntimePool({ anthropicApiKey: async () => "unused-fixture-key" } as ProviderRegistry),
    hostFactory, scanSessionProcesses, discoverGatewayModels: async () => [],
    prepareRuntime: async () => ({ executablePath: "/fake/claude", credentialPath: "/fake/credentials.json", environment: {} }),
  };
  const broker = new SessionBroker(brokerOptions);
  await broker.initialize();
  const internals = broker as unknown as { pump(): Promise<void>; dispatching: Map<string, Promise<void>>; eventQueue: Promise<void>; conflictTasks: Map<string, Promise<void>> };
  const drain = async () => {
    await internals.pump();
    await Promise.all(internals.dispatching.values());
    await internals.eventQueue;
    await Promise.all(internals.conflictTasks.values());
  };
  const poll = () => (observer as unknown as { poll(): Promise<void> }).poll();
  return {
    sessionId, nativeSessionId, paths, transcript, broker, brokerOptions, observer, eventLog, send, closeHost, hostFactory, scanSessionProcesses, drain, poll, inboxSend, inboxEvents,
    async setDesktopExecutorAlive(alive: boolean) { await registerDesktopExecutor(alive); await poll(); },
    async close() { await broker.close(); await observer.close(); await eventLog.close(); state.close(); },
  };
}

it.each([false, true])("waits for native Desktop executor exit after its turn ends (stale logical=%s)", async staleLogical => {
  const f = await fixture({ busy: true, staleLogical });
  try {
    expect(await f.observer.canStartBridgeHost(f.nativeSessionId)).toBe(false);
    if (staleLogical) {
      expect(f.observer.session(f.sessionId)?.sessionId).toBe(f.sessionId);
      expect(await f.observer.canStartBridgeHost(f.sessionId), "the stale logical identity would incorrectly allow acquisition").toBe(true);
    }
    const canStart = vi.spyOn(f.observer, "canStartBridgeHost");
    await f.broker.startTurn({ sessionId: f.sessionId, requestId: "start", idempotencyKey: "command", text: "Continue", origin: "mobile" });
    await f.drain();
    expect(canStart).toHaveBeenCalledWith(f.nativeSessionId, false);
    expect(canStart.mock.calls.every(([id]) => id === f.nativeSessionId)).toBe(true);
    expect(f.send).not.toHaveBeenCalled();
    expect(f.hostFactory).not.toHaveBeenCalled();
    expect(f.broker.session(f.sessionId)?.pendingCount).toBe(1);
    await appendFile(f.transcript, `${JSON.stringify({ type: "assistant", uuid: "desktop-done", parentUuid: "initial-user", sessionId: f.nativeSessionId, message: { role: "assistant", content: "Done", stop_reason: "end_turn" } })}\n`);
    await f.poll();
    expect(f.observer.isMainTurnBusy(f.nativeSessionId)).toBe(false);
    expect(await f.observer.canStartBridgeHost(f.nativeSessionId, true)).toBe(false);
    await f.drain();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.hostFactory).not.toHaveBeenCalled();
    expect(f.broker.session(f.sessionId)?.pendingCount).toBe(1);
    await f.setDesktopExecutorAlive(false);
    expect(await f.observer.canStartBridgeHost(f.nativeSessionId)).toBe(true);
    await f.drain();
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce(), { timeout: 3_000 });
    expect(f.hostFactory.mock.calls[0]![0]).toMatchObject({ sessionId: f.nativeSessionId, eventSessionId: f.sessionId, resume: true });
    expect(f.scanSessionProcesses).toHaveBeenCalledWith(f.paths, f.nativeSessionId);
    expect(canStart.mock.calls.every(([id]) => id === f.nativeSessionId)).toBe(true);
  } finally { await f.close(); }
});

it.each([true, false])("does not let an unfinished task-list item override an ended or exited main turn (alive=%s)", async desktopAlive => {
  const f = await fixture({ desktopAlive, busy: !desktopAlive });
  try {
    await mkdir(join(f.paths.tasks, f.nativeSessionId), { recursive: true });
    await writeFile(join(f.paths.tasks, f.nativeSessionId, "1.json"), JSON.stringify({ status: "in_progress", subject: "Unfinished checklist item" }));
    await f.poll();
    expect(f.observer.session(f.nativeSessionId)?.activeTask).toBe(true);
    expect(f.observer.isMainTurnBusy(f.nativeSessionId)).toBe(false);
    expect(f.broker.session(f.sessionId)?.turnState).toBe("idle");
    expect(await f.observer.canStartBridgeHost(f.nativeSessionId)).toBe(!desktopAlive);
    expect(f.hostFactory).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

it.each(["idle", "background-agent", "background-shell"])("records the current external Desktop input limitation (%s)", async background => {
  const f = await fixture();
  try {
    if (background === "background-agent") {
      const directory = join(f.paths.projects, f.nativeSessionId, "subagents");
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "agent-child.meta.json"), JSON.stringify({ description: "Running child", finished: false }));
      await writeFile(join(directory, "agent-child.jsonl"), JSON.stringify({ type: "assistant", uuid: "child-tool", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "tool_use", id: "child-read", name: "Read", input: {} }] } }) + "\n");
    } else if (background === "background-shell") {
      await appendFile(f.transcript, [
        { type: "user", uuid: "shell-start", parentUuid: "initial-answer", message: { role: "user", content: "Run a background job" } },
        { type: "assistant", uuid: "shell-call", parentUuid: "shell-start", message: { role: "assistant", content: [{ type: "tool_use", id: "bash-call", name: "Bash", input: { command: "fixture-job" } }] } },
        { type: "user", uuid: "shell-result", parentUuid: "shell-call", toolUseResult: { backgroundTaskId: "shell-1" }, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "bash-call", content: "Running in background" }] } },
        { type: "assistant", uuid: "shell-boundary", parentUuid: "shell-result", message: { role: "assistant", stop_reason: "end_turn", content: "Job started." } },
      ].map(record => JSON.stringify(record)).join("\n") + "\n");
    }
    await f.poll();
    expect(f.observer.isMainTurnBusy(f.nativeSessionId)).toBe(false);
    expect(f.observer.session(f.nativeSessionId)?.desktopProcessAlive).toBe(true);
    expect(f.observer.runningSubagents(f.nativeSessionId)?.count ?? 0).toBe(background === "background-agent" ? 1 : 0);
    expect(f.observer.hasPendingBackgroundShellTasks(f.nativeSessionId)).toBe(background === "background-shell");
    await f.broker.startTurn({ sessionId: f.sessionId, requestId: "continue", idempotencyKey: "continue", text: "Continue on the original executor", origin: "mobile" });
    await f.drain();
    expect(f.broker.session(f.sessionId)?.pendingCount).toBe(1);
    expect(f.broker.session(f.sessionId)?.desktopHandoff?.state).toBe("close-desktop");
    expect(f.hostFactory).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.closeHost).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

it.each([false, true])("delivers through the original Desktop inbox and confirms its UUID without a second writer (background=%s)", async background => {
  const f = await fixture({ inbox: true });
  try {
    if (background) {
      const directory = join(f.paths.projects, f.nativeSessionId, "subagents");
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "agent-child.meta.json"), JSON.stringify({ description: "Original Desktop child", finished: false }));
      await writeFile(join(directory, "agent-child.jsonl"), JSON.stringify({ type: "assistant", uuid: "child-read", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "tool_use", id: "child-tool", name: "Read", input: {} }] } }) + "\n");
      await f.poll();
      expect(f.observer.runningSubagents(f.nativeSessionId)?.count).toBe(1);
    }
    const input = { sessionId: f.sessionId, requestId: "inbox", idempotencyKey: "inbox", text: "Continue on Desktop", origin: "mobile" as const };
    await f.broker.startTurn(input); await f.drain();
    expect(f.inboxSend).toHaveBeenCalledOnce();
    const [endpoint, submitted] = f.inboxSend.mock.calls[0]!;
    expect(endpoint).toMatchObject({ sessionId: f.nativeSessionId, pid: process.pid });
    expect(f.hostFactory).not.toHaveBeenCalled();
    expect(f.broker.session(f.sessionId)?.desktopHandoff).toMatchObject({ state: "desktop-inbox", inputStatus: "submitted", canReturn: false });
    await f.broker.startTurn({ ...input, requestId: "retry" }); await f.drain();
    expect(f.inboxSend).toHaveBeenCalledOnce();
    await appendFile(f.transcript, JSON.stringify({ type: "user", uuid: submitted.messageId, parentUuid: "initial-answer", isMeta: true, origin: { kind: "peer", msg_id: submitted.messageId }, message: { role: "user", content: submitted.text } }) + "\n");
    await f.poll(); await f.drain();
    expect(f.eventLog.hasItem(f.sessionId, "user.message.accepted", submitted.messageId)).toBe(true);
    expect(f.broker.session(f.sessionId)?.desktopHandoff).toBeUndefined();
    await appendFile(f.transcript, JSON.stringify({ type: "assistant", uuid: "inbox-answer", parentUuid: submitted.messageId, message: { role: "assistant", content: "Continued", stop_reason: "end_turn" } }) + "\n");
    await f.poll(); await f.drain();
    expect((await f.broker.startTurn(input)).state).toBe("completed");
    expect(f.broker.runtimeStatus().activeTurns).toBe(0);
    expect(f.inboxSend).toHaveBeenCalledOnce();
    expect(f.closeHost).not.toHaveBeenCalled();
    if (background) expect(f.observer.runningSubagents(f.nativeSessionId)?.count).toBe(1);
  } finally { await f.close(); }
});

it.each(["held", "refused", "denied", "dropped"] as const)("preserves the original Desktop inbox decision without replay (%s)", async status => {
  const f = await fixture({ inbox: true });
  try {
    const input = { sessionId: f.sessionId, requestId: "decision", idempotencyKey: "decision", text: "Phone input", origin: "mobile" as const };
    const turn = await f.broker.startTurn(input); await f.drain();
    expect(f.inboxSend).toHaveBeenCalledOnce();
    const messageId = f.inboxSend.mock.calls[0]![1].messageId;
    f.inboxEvents.emit("receipt", { messageId, status }); await f.drain();
    if (status === "held") {
      expect(f.broker.session(f.sessionId)?.desktopHandoff).toMatchObject({ state: "desktop-inbox", inputStatus: "held" });
      await expect(f.broker.interruptTurn(f.sessionId, turn.commandId, true)).rejects.toThrow("Desktop");
      expect(f.eventLog.hasItem(f.sessionId, "user.message.accepted", messageId)).toBe(false);
    } else {
      expect((await f.broker.startTurn(input)).state).toBe("failed");
      expect(f.broker.runtimeStatus().activeTurns).toBe(0);
    }
    await f.drain(); expect(f.inboxSend).toHaveBeenCalledOnce(); expect(f.hostFactory).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

it.each(["delivered", "held"] as const)("does not regress transcript-confirmed acceptance when a %s receipt arrives later", async status => {
  const f = await fixture({ inbox: true });
  try {
    const input = { sessionId: f.sessionId, requestId: "accepted-before-receipt", idempotencyKey: "accepted-before-receipt", text: "Native input", origin: "mobile" as const };
    await f.broker.startTurn(input); await f.drain();
    const messageId = f.inboxSend.mock.calls[0]![1].messageId;
    await appendFile(f.transcript, JSON.stringify({ type: "user", uuid: messageId, parentUuid: "initial-answer", isMeta: true, origin: { kind: "peer", msg_id: messageId }, message: { role: "user", content: input.text } }) + "\n");
    await f.poll(); await f.drain();
    expect(f.eventLog.hasItem(f.sessionId, "user.message.accepted", messageId)).toBe(true);
    const acceptedSeq = f.eventLog.latestSeq();
    f.inboxEvents.emit("receipt", { messageId, status }); await f.drain();
    expect(f.eventLog.replay().some(event => event.seq > acceptedSeq && event.type === "message.delivery" &&
      (event.data.delivery === "submitted" || event.data.delivery === "waiting-confirmation"))).toBe(false);
    expect(f.broker.session(f.sessionId)?.turnState).toBe("running");
  } finally { await f.close(); }
});

it.each([false, true])("retains an expired confirmation in the original queue without retrying the same inbox (restart=%s)", async restart => {
  const f = await fixture({ inbox: true }); let restored: SessionBroker | undefined;
  try {
    const input = { sessionId: f.sessionId, requestId: "expiry", idempotencyKey: "expiry", text: "Keep this exact input", origin: "mobile" as const };
    const turn = await f.broker.startTurn(input); await f.drain();
    const messageId = f.inboxSend.mock.calls[0]![1].messageId;
    f.inboxEvents.emit("receipt", { messageId, status: "held" }); await f.drain();
    f.inboxEvents.emit("receipt", { messageId, status: "expired" }); await f.drain();
    expect((await f.broker.startTurn(input))).toMatchObject({ commandId: turn.commandId, state: "queued" });
    expect(f.broker.session(f.sessionId)).toMatchObject({ pendingCount: 1, desktopHandoff: { state: "close-desktop", reason: "inbox-confirmation-expired", canTakeover: true } });
    expect(f.broker.runtimeStatus().activeTurns).toBe(0);
    expect(f.eventLog.replay().some(event => event.type === "message.delivery" && event.data.delivery === "waiting-confirmation")).toBe(true);
    expect(f.eventLog.replay().some(event => event.type === "turn.failed" && event.data.commandId === turn.commandId)).toBe(false);
    if (restart) {
      await f.broker.close(); restored = new SessionBroker(f.brokerOptions); await restored.initialize();
      await (restored as unknown as { pump(): Promise<void> }).pump();
      expect((await restored.startTurn(input))).toMatchObject({ commandId: turn.commandId, state: "queued" });
      expect(restored.session(f.sessionId)?.desktopHandoff).toMatchObject({ state: "close-desktop", reason: "inbox-confirmation-expired" });
    }
    expect(f.inboxSend).toHaveBeenCalledOnce();
    expect(f.hostFactory).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  } finally { await restored?.close(); await f.close(); }
});

it("continues the retained expired input once after the original Desktop executor exits", async () => {
  const f = await fixture({ inbox: true });
  try {
    const input = { sessionId: f.sessionId, requestId: "recover", idempotencyKey: "recover", text: "Preserve the original instruction", origin: "mobile" as const };
    const turn = await f.broker.startTurn(input); await f.drain();
    const messageId = f.inboxSend.mock.calls[0]![1].messageId;
    f.inboxEvents.emit("receipt", { messageId, status: "expired" }); await f.drain();
    expect(f.hostFactory).not.toHaveBeenCalled();
    await f.setDesktopExecutorAlive(false); await f.drain();
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce(), { timeout: 3_000 });
    expect(f.hostFactory.mock.calls[0]![0]).toMatchObject({ sessionId: f.nativeSessionId, eventSessionId: f.sessionId, resume: true });
    expect(f.send.mock.calls[0]![0]).toMatchObject({ text: input.text });
    expect((await f.broker.startTurn(input)).commandId).toBe(turn.commandId);
    expect(f.inboxSend).toHaveBeenCalledOnce();
    await f.drain(); expect(f.send).toHaveBeenCalledOnce();
  } finally { await f.close(); }
});

it.each([false, true])("does not replay an inbox send error (submitted=%s)", async submitted => {
  const f = await fixture({ inbox: true });
  try {
    f.inboxSend.mockRejectedValue(new InboxSendError("Fixture send error", submitted));
    const input = { sessionId: f.sessionId, requestId: "error", idempotencyKey: "error", text: "Phone input", origin: "mobile" as const };
    const turn = await f.broker.startTurn(input); await f.drain();
    expect((await f.broker.startTurn(input)).state).toBe(submitted ? "uncertain" : "queued");
    expect(f.broker.runtimeStatus().activeTurns).toBe(0);
    if (submitted) {
      expect(f.broker.session(f.sessionId)?.desktopHandoff).toBeUndefined();
      await expect(f.broker.resolveUncertainDelivery(turn.commandId, "retry")).rejects.toThrow("Desktop");
      await f.setDesktopExecutorAlive(false); await f.drain();
      expect((await f.broker.startTurn(input)).state).toBe("uncertain");
    }
    expect(f.inboxSend).toHaveBeenCalledOnce(); expect(f.hostFactory).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

it("recovers an in-flight inbox UUID without sending it again after Broker restart", async () => {
  const f = await fixture({ inbox: true }); let restored: SessionBroker | undefined;
  try {
    const input = { sessionId: f.sessionId, requestId: "restart", idempotencyKey: "restart", text: "Phone input", origin: "mobile" as const };
    await f.broker.startTurn(input); await f.drain();
    const messageId = f.inboxSend.mock.calls[0]![1].messageId;
    await f.broker.close(); restored = new SessionBroker(f.brokerOptions); await restored.initialize();
    expect((await restored.startTurn(input)).state).toBe("uncertain");
    expect(f.inboxSend).toHaveBeenCalledOnce();
    await appendFile(f.transcript, [
      { type: "user", uuid: messageId, parentUuid: "initial-answer", isMeta: true, origin: { kind: "peer", msg_id: messageId }, message: { role: "user", content: input.text } },
      { type: "assistant", uuid: "restart-answer", parentUuid: messageId, message: { role: "assistant", content: "Done", stop_reason: "end_turn" } },
    ].map(record => JSON.stringify(record)).join("\n") + "\n");
    await f.poll(); await (restored as unknown as { eventQueue: Promise<void> }).eventQueue;
    expect((await restored.startTurn(input)).state).toBe("completed");
    expect(f.inboxSend).toHaveBeenCalledOnce(); expect(f.hostFactory).not.toHaveBeenCalled();
  } finally { await restored?.close(); await f.close(); }
});

it("keeps ordinary phone input queued while Desktop awaits an answer to AskUserQuestion", async () => {
  const f = await fixture({ inbox: true });
  try {
    await appendFile(f.transcript, JSON.stringify({ type: "assistant", uuid: "desktop-question", parentUuid: "initial-answer", message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id: "question", name: "AskUserQuestion", input: { questions: [] } }] } }) + "\n");
    await f.poll(); expect(f.observer.isWaitingForUserInput(f.nativeSessionId)).toBe(true);
    await f.broker.startTurn({ sessionId: f.sessionId, requestId: "question", idempotencyKey: "question", text: "New phone input", origin: "mobile" }); await f.drain();
    expect(f.inboxSend).not.toHaveBeenCalled(); expect(f.hostFactory).not.toHaveBeenCalled();
    expect(f.broker.session(f.sessionId)?.pendingCount).toBe(1);
  } finally { await f.close(); }
});

it("does not inject into an executor that still needs to reload Bridge history", async () => {
  const f = await fixture({ inbox: true });
  try {
    const owner = { ...f.observer.session(f.nativeSessionId)!.activeProcesses[0]!, peerProtocol: 1, messagingSocketPath: "/tmp/bridge-fixture.sock", source: "process" as const };
    f.scanSessionProcesses.mockImplementation(async () => [owner as Parameters<typeof f.scanSessionProcesses.mockResolvedValue>[0][number]]);
    await f.eventLog.append({ sessionId: f.sessionId, itemId: f.nativeSessionId, origin: "system", type: "session.desktop-handoff", data: { state: "released", desktopProcesses: [{ pid: owner.pid, startedAt: owner.startedAt }] } });
    await f.broker.startTurn({ sessionId: f.sessionId, requestId: "reload", idempotencyKey: "reload", text: "Phone input", origin: "mobile" }); await f.drain();
    expect(f.inboxSend).not.toHaveBeenCalled(); expect(f.hostFactory).not.toHaveBeenCalled();
    expect(f.broker.session(f.sessionId)?.pendingCount).toBe(1);
  } finally { await f.close(); }
});

it("shows a native queue and sends automatically after the current Desktop turn ends", async () => {
  const f = await fixture({ inbox: true, busy: true });
  try {
    await f.broker.startTurn({ sessionId: f.sessionId, requestId: "wait-main", idempotencyKey: "wait-main", text: "Next phone input", origin: "mobile" }); await f.drain();
    expect(f.inboxSend).not.toHaveBeenCalled();
    expect(f.broker.session(f.sessionId)?.desktopHandoff).toMatchObject({ state: "desktop-inbox", inputStatus: "queued", canReturn: false });
    await appendFile(f.transcript, JSON.stringify({ type: "assistant", uuid: "main-finished", parentUuid: "initial-user", message: { role: "assistant", content: "Done", stop_reason: "end_turn" } }) + "\n");
    await f.poll(); await vi.waitFor(() => expect(f.inboxSend).toHaveBeenCalledOnce(), { timeout: 3_000 });
    expect(f.hostFactory).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

it("checks competing Bridge writers against the active native session", async () => {
  const f = await fixture({ desktopAlive: false });
  try {
    expect(await f.observer.canStartBridgeHost(f.nativeSessionId)).toBe(true);
    f.scanSessionProcesses.mockImplementation(async (_paths, id) => id === f.nativeSessionId
      ? [{ pid: 12345, startedAt: 1, processAlive: true, entrypoint: "claude-bridge", source: "process" }] : []);
    await f.broker.startTurn({ sessionId: f.sessionId, requestId: "start", idempotencyKey: "command", text: "Continue", origin: "mobile" });
    await f.drain();
    expect(f.hostFactory).not.toHaveBeenCalled();
    expect(f.eventLog.replay().filter(event => event.type === "session.ownership-conflict")).toHaveLength(1);
  } finally { await f.close(); }
});

it.each([false, true])("contains distinct Desktop input on the executing native session without replaying it (split=%s)", async split => {
  const f = await fixture({ split, desktopAlive: false });
  try {
    await f.broker.startTurn({ sessionId: f.sessionId, requestId: "start", idempotencyKey: "command", text: "Continue", origin: "mobile" });
    await f.drain();
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.closeHost).not.toHaveBeenCalled();
    expect(f.observer.externalWriteVersion(f.sessionId)).toBe(0);
    await f.setDesktopExecutorAlive(true);
    expect(f.observer.session(f.nativeSessionId)?.desktopProcessAlive).toBe(true);
    expect(f.closeHost).not.toHaveBeenCalled();
    await appendFile(f.transcript, `${JSON.stringify({ type: "user", uuid: "external-user", parentUuid: "initial-answer", sessionId: f.nativeSessionId, message: { role: "user", content: "Fresh Desktop input" } })}\n`);
    await f.poll();
    await f.drain();
    expect(f.observer.externalWriteVersion(f.sessionId)).toBeGreaterThan(0);
    expect(f.closeHost).toHaveBeenCalledOnce();
    expect(f.eventLog.replay().filter(event => event.sessionId === f.sessionId && event.type === "session.ownership-conflict")).toHaveLength(1);
    expect(f.eventLog.replay().filter(event => event.sessionId === f.sessionId && event.type === "turn.interrupted")).toHaveLength(1);
    const retry = await f.broker.startTurn({ sessionId: f.sessionId, requestId: "retry", idempotencyKey: "command", text: "Continue", origin: "mobile" });
    expect(retry.state).toBe("cancelled");
    expect(f.send).toHaveBeenCalledOnce();
  } finally { await f.close(); }
});
