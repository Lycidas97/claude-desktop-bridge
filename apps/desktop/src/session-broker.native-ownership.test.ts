import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
import { ClaudePermissionHook } from "./claude-permission-hook.js";

const inboxImageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7X0AAAAASUVORK5CYII=", "base64");
const inboxImage = { id: "inbox-image", name: "inbox-image.png", mimeType: "image/png" as const, size: inboxImageBytes.length, data: inboxImageBytes.toString("base64") };
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
    rebindSession: vi.fn(),
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
    root, sessionId, nativeSessionId, paths, transcript, broker, brokerOptions, observer, eventLog, send, closeHost, hostFactory, scanSessionProcesses, drain, poll, inboxSend, inboxEvents, events, state,
    async setDesktopExecutorAlive(alive: boolean) { await registerDesktopExecutor(alive); await poll(); },
    async close() { await broker.close(); await observer.close(); await eventLog.close(); state.close(); },
  };
}

it("discovers commands for the logical native fork without starting or messaging an executor", async () => {
  const f = await fixture({ inbox: true, busy: true });
  try {
    await mkdir(join(f.root, ".claude/commands"), { recursive: true });
    await writeFile(join(f.root, ".claude/commands/project.md"), "---\ndescription: Fork project command\n---\nBody");
    await mkdir(join(f.root, "commands"));
    await writeFile(join(f.root, "commands/personal.md"), "---\ndescription: Personal command\n---\nBody");
    const configuration = vi.spyOn(f.broker, "configuration").mockImplementation(async () => { throw new Error("Discovery must not start model discovery"); });
    const catalog = await f.broker.commands(f.sessionId);
    expect(catalog.sessionId).toBe(f.sessionId);
    expect(catalog.commands.filter(command => !command.action)).toEqual([
      { name: "personal", description: "Personal command" }, { name: "project", description: "Fork project command" },
    ]);
    expect(catalog.commands.find(command => command.name === "compact")?.unavailableReason).toBeTruthy();
    expect(catalog.commands.find(command => command.name === "help")?.unavailableReason).toBeUndefined();
    await expect(f.broker.commands("missing-session")).rejects.toThrow();
    expect(configuration).not.toHaveBeenCalled();
    expect(f.hostFactory).not.toHaveBeenCalled();
    expect(f.inboxSend).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.broker.session(f.sessionId)?.pendingCount).toBe(0);
  } finally { await f.close(); }
});

it("does not route an SDK command through an independently owned Native inbox", async () => {
  const f = await fixture({ inbox: true, busy: true });
  try {
    await f.broker.startTurn({ sessionId: f.sessionId, requestId: "context", idempotencyKey: "context", text: "/context", slashCommand: true, origin: "mobile" });
    await f.drain();
    expect(f.inboxSend).not.toHaveBeenCalled();
    expect(f.hostFactory).not.toHaveBeenCalled();
    expect(f.broker.session(f.sessionId)?.pendingCount).toBe(0);
    expect(f.eventLog.replay(0).some(event => event.type === "turn.failed")).toBe(true);
  } finally { await f.close(); }
});

it("keeps the old history and queue identity while resetting the host into a new conversation", async () => {
  const f = await fixture({ desktopAlive: false });
  try {
    await f.broker.startTurn({ sessionId: f.sessionId, requestId: "clear", idempotencyKey: "clear", text: "/clear", origin: "mobile" });
    await f.drain();
    const receipt = f.send.mock.results[0]!.value;
    await f.broker.startTurn({ sessionId: f.sessionId, requestId: "old-queue", idempotencyKey: "old-queue", text: "Remain in the original context", origin: "mobile" });
    await f.drain();
    const nextNativeId = randomUUID();
    f.events.emit("event", { type: "session.reset", sessionId: f.sessionId, previousNativeSessionId: f.nativeSessionId, nativeSessionId: nextNativeId, at: Date.now() });
    await f.drain();
    expect(f.broker.session(nextNativeId)).toBeUndefined();
    f.events.emit("event", { type: "command.output", sessionId: f.sessionId, turnId: receipt.turnId, itemId: "clear-output", text: "Conversation cleared", at: Date.now() });
    f.events.emit("event", { type: "turn.completed", sessionId: f.sessionId, turnId: receipt.turnId, result: "Conversation cleared", at: Date.now() });
    await f.drain();
    expect(f.state.activeLane(f.sessionId)?.nativeSessionId).toBe(f.nativeSessionId);
    expect(f.state.activeLane(nextNativeId)?.nativeSessionId).toBe(nextNativeId);
    expect(f.broker.session(nextNativeId)?.turnState).toBe("idle");
    expect(f.hostFactory.mock.results[0]!.value.rebindSession).toHaveBeenCalledWith(nextNativeId);
    expect(f.closeHost).not.toHaveBeenCalled();
    expect(f.hostFactory.mock.calls[1]![0]).toMatchObject({ sessionId: f.nativeSessionId, eventSessionId: f.sessionId, resume: true });
    expect(f.state.loadBrokerState().pending).toEqual([expect.objectContaining({ sessionId: f.sessionId, text: "Remain in the original context", idempotencyKey: "old-queue" })]);
    expect((await f.broker.history(f.sessionId)).items.filter(item => item.text === "Conversation cleared")).toHaveLength(1);
    expect((await f.broker.history(nextNativeId)).items).toEqual([]);
    expect((await readFile(f.transcript, "utf8"))).toContain("Desktop work");
    expect(f.eventLog.replay(0).find(event => event.type === "session.reset")?.data).toMatchObject({ previousSessionId: f.sessionId, sessionId: nextNativeId, nativeSessionId: nextNativeId });
  } finally { await f.close(); }
});

it("[edge] detects the first external write after reset even when the old conversation had a higher counter", async () => {
  const f = await fixture({ desktopAlive: false });
  try {
    let newExternalWrites = 0;
    vi.spyOn(f.observer, "externalWriteVersion").mockImplementation(id => id === f.sessionId ? 5 : newExternalWrites);
    await f.broker.startTurn({ sessionId: f.sessionId, requestId: "clear", idempotencyKey: "clear", text: "/clear", origin: "mobile" });
    await f.drain();
    const receipt = f.send.mock.results[0]!.value;
    const nextId = randomUUID();
    f.events.emit("event", { type: "session.reset", sessionId: f.sessionId, previousNativeSessionId: f.nativeSessionId, nativeSessionId: nextId, at: Date.now() });
    f.events.emit("event", { type: "turn.completed", sessionId: f.sessionId, turnId: receipt.turnId, result: "", at: Date.now() });
    await f.drain();
    expect(f.broker.session(nextId)?.ownership).toBe("BRIDGE_IDLE");
    newExternalWrites = 1;
    expect(f.broker.session(nextId)?.ownership).toBe("OWNERSHIP_CONFLICT");
    expect(f.hostFactory).toHaveBeenCalledTimes(1);
  } finally { await f.close(); }
});

it.each(["turn.failed", "turn.interrupted"] as const)("[edge] retains an already-reset identity when the original command ends as %s", async type => {
  const f = await fixture({ desktopAlive: false });
  try {
    await f.broker.startTurn({ sessionId: f.sessionId, requestId: "clear", idempotencyKey: "clear", text: "/clear", origin: "mobile" });
    await f.drain();
    const receipt = f.send.mock.results[0]!.value;
    const nextId = randomUUID();
    f.events.emit("event", { type: "session.reset", sessionId: f.sessionId, previousNativeSessionId: f.nativeSessionId, nativeSessionId: nextId, at: Date.now() });
    f.events.emit("event", { type, sessionId: f.sessionId, turnId: receipt.turnId, error: "Command ended after reset", at: Date.now() });
    await f.drain();
    expect(f.state.activeLane(f.sessionId)?.nativeSessionId).toBe(f.nativeSessionId);
    expect(f.state.activeLane(nextId)?.nativeSessionId).toBe(nextId);
    expect((await f.broker.history(nextId)).items).toEqual([]);
    expect(f.state.loadBrokerState().pending).toEqual([]);
    expect(f.closeHost).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

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

it.each([{ busy: false, held: false }, { busy: true, held: false }, { busy: false, held: true }])("delivers readable image references through the living Desktop and preserves them after restart (busy=$busy, held=$held)", async ({ busy, held }) => {
  const f = await fixture({ inbox: true, busy });
  let restored: SessionBroker | undefined;
  try {
    const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7X0AAAAASUVORK5CYII=";
    const image = { id: "photo-1", name: "phone image.png", mimeType: "image/png" as const, size: Buffer.from(data, "base64").length, data };
    const input = { sessionId: f.sessionId, requestId: "image", idempotencyKey: "image", text: "Inspect this photo", attachments: [image], origin: "mobile" as const };
    const turn = await f.broker.startTurn(input); await f.drain();
    if (busy) {
      expect(f.inboxSend).not.toHaveBeenCalled();
      expect(f.broker.session(f.sessionId)?.desktopHandoff).toMatchObject({ state: "desktop-inbox", inputStatus: "queued" });
      await appendFile(f.transcript, JSON.stringify({ type: "assistant", uuid: "photo-main-finished", parentUuid: "initial-user", message: { role: "assistant", content: "Done", stop_reason: "end_turn" } }) + "\n");
      await f.poll();
    }
    await vi.waitFor(() => expect(f.inboxSend).toHaveBeenCalledOnce(), { timeout: 3_000 });
    const submitted = f.inboxSend.mock.calls[0]![1];
    const pending = (f.broker as unknown as { pending: Array<{ commandId: string; text: string; attachments: unknown[]; desktopInboxImages: Array<{ attachmentId: string; path: string }> }> }).pending[0]!;
    expect(pending).toMatchObject({ commandId: turn.commandId, text: input.text, attachments: [image] });
    expect(pending.desktopInboxImages).toHaveLength(1);
    expect(pending.desktopInboxImages[0]).toMatchObject({ attachmentId: image.id });
    const imagePath = join(f.root, pending.desktopInboxImages[0]!.path);
    expect(await readFile(imagePath)).toEqual(Buffer.from(data, "base64"));
    expect(submitted.text).toContain(input.text);
    expect(submitted.text).toContain(imagePath);
    expect(submitted.text).not.toContain(data);
    if (held) {
      f.inboxEvents.emit("receipt", { messageId: submitted.messageId, status: "held" }); await f.drain();
      expect(f.broker.session(f.sessionId)?.desktopHandoff).toMatchObject({ state: "desktop-inbox", inputStatus: "held" });
      expect(f.eventLog.hasItem(f.sessionId, "user.message.accepted", submitted.messageId)).toBe(false);
    }
    expect(f.hostFactory).not.toHaveBeenCalled();
    expect(f.closeHost).not.toHaveBeenCalled();
    await f.broker.close();
    restored = new SessionBroker(f.brokerOptions); await restored.initialize();
    expect((await restored.startTurn(input)).state).toBe("uncertain");
    expect((restored as unknown as { pending: unknown[] }).pending[0]).toMatchObject({
      commandId: turn.commandId, attachments: [image], desktopInboxImages: pending.desktopInboxImages,
    });
    expect(await readFile(imagePath)).toEqual(Buffer.from(data, "base64"));
    expect(f.inboxSend).toHaveBeenCalledOnce();
    await appendFile(f.transcript, [
      { type: "user", uuid: submitted.messageId, parentUuid: "initial-answer", isMeta: true, origin: { kind: "peer", msg_id: submitted.messageId }, message: { role: "user", content: submitted.text } },
      { type: "assistant", uuid: "image-answer", parentUuid: submitted.messageId, message: { role: "assistant", content: "Read the image", stop_reason: "end_turn" } },
    ].map(record => JSON.stringify(record)).join("\n") + "\n");
    await f.poll(); await (restored as unknown as { eventQueue: Promise<void> }).eventQueue;
    expect((await restored.startTurn(input)).state).toBe("completed");
    expect(f.eventLog.replay(0)).toContainEqual(expect.objectContaining({
      itemId: submitted.messageId, type: "user.message.accepted", data: expect.objectContaining({ text: input.text, attachments: [image], commandId: turn.commandId }),
    }));
    expect(f.inboxSend).toHaveBeenCalledOnce();
  } finally { await restored?.close(); await f.close(); }
});

it.each(["allow-once", "deny"] as const)("keeps inbox admission and the image Read permission independent (%s)", async decision => {
  const f = await fixture({ inbox: true });
  const settingsPath = join(f.root, "permission-settings.json");
  const hook = new ClaudePermissionHook({ settingsPath, broker: f.broker.permissionBroker,
    sessionId: nativeId => f.broker.resolveNativePermissionSessionId(nativeId) });
  try {
    await hook.start();
    const installed = JSON.parse(await readFile(settingsPath, "utf8")).hooks.PermissionRequest[0].hooks[0];
    await f.broker.startTurn({ sessionId: f.sessionId, requestId: "image-permission", idempotencyKey: "image-permission",
      text: "Read this image", attachments: [inboxImage], origin: "mobile" });
    await f.drain();
    const submitted = f.inboxSend.mock.calls[0]![1];
    const pending = (f.broker as unknown as { pending: Array<{ desktopInboxImages: Array<{ path: string }> }> }).pending[0]!;
    const imagePath = join(f.root, pending.desktopInboxImages[0]!.path);
    if (platformDescriptor.value !== "win32") {
      expect((await stat(imagePath)).mode & 0o777).toBe(0o600);
      expect((await stat(join(imagePath, ".."))).mode & 0o777).toBe(0o700);
    }
    f.inboxEvents.emit("receipt", { messageId: submitted.messageId, status: "held" }); await f.drain();
    f.broker.setDefaultPermissionMode("full-access");
    expect(f.broker.permissionBroker.applyPolicy()).toBe(0);
    await f.drain();
    expect(f.broker.session(f.sessionId)?.desktopHandoff).toMatchObject({ state: "desktop-inbox", inputStatus: "held" });
    expect(f.eventLog.hasItem(f.sessionId, "user.message.accepted", submitted.messageId)).toBe(false);
    expect(f.inboxSend).toHaveBeenCalledOnce();
    f.inboxEvents.emit("receipt", { messageId: submitted.messageId, status: "delivered" }); await f.drain();
    expect(f.eventLog.hasItem(f.sessionId, "user.message.accepted", submitted.messageId)).toBe(false);
    await appendFile(f.transcript, JSON.stringify({ type: "user", uuid: submitted.messageId, parentUuid: "initial-answer", isMeta: true,
      origin: { kind: "peer", msg_id: submitted.messageId }, message: { role: "user", content: submitted.text } }) + "\n");
    await f.poll(); await f.drain();
    const settled = vi.fn();
    const response = fetch(installed.url, { method: "POST", headers: { "Content-Type": "application/json", ...installed.headers },
      body: JSON.stringify({ session_id: f.nativeSessionId, hook_event_name: "PermissionRequest", tool_name: "Read",
        tool_input: { file_path: imagePath }, tool_use_id: "read-inbox-image" }) }).then(reply => reply.json()).then(body => { settled(); return body; });
    await vi.waitFor(() => expect(f.broker.permissionBroker.list()).toHaveLength(1));
    const request = f.broker.permissionBroker.list()[0]!;
    expect(request).toMatchObject({ sessionId: f.sessionId, toolName: "Read", input: { file_path: imagePath }, manualOnly: true });
    expect(f.broker.permissionBroker.applyPolicy()).toBe(0);
    expect(settled).not.toHaveBeenCalled();
    expect(f.broker.resolvePermission(request.requestId, decision, undefined, undefined, { deviceId: "paired-phone", name: "Paired phone" })).toBe(true);
    const toolDecision = (await response).hookSpecificOutput.decision;
    expect(toolDecision).toMatchObject({ behavior: decision === "deny" ? "deny" : "allow" });
    expect(toolDecision).not.toHaveProperty("updatedPermissions");
    expect(f.broker.session(f.sessionId)?.nativePermissionModeChange).toBeUndefined();
    expect(await readFile(imagePath)).toEqual(inboxImageBytes);
    expect(f.inboxSend).toHaveBeenCalledOnce();
    expect(f.hostFactory).not.toHaveBeenCalled();
  } finally { await hook.close(); await f.close(); }
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

it.each((["held", "refused", "denied", "dropped"] as const).flatMap(status => [false, true].map(image => ({ status, image }))))("preserves the original Desktop inbox decision without replay ($status, image=$image)", async ({ status, image }) => {
  const f = await fixture({ inbox: true });
  try {
    const input = { sessionId: f.sessionId, requestId: "decision", idempotencyKey: "decision", text: "Phone input", origin: "mobile" as const,
      ...(image ? { attachments: [inboxImage] } : {}) };
    f.broker.setDefaultPermissionMode("full-access");
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
