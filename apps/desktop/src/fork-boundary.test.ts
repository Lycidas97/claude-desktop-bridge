import { EventEmitter } from "node:events";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ClaudeSessionHostOptions, SessionHostEvent } from "./claude-session-host.js";
import { ConversationStateStore } from "./conversation-state-store.js";
import { parseClaudeTranscriptSnapshot, readClaudeSessionSubagents } from "./claude-history.js";
import { SessionBroker, type TranscriptObserverRuntime } from "./session-broker.js";
import { SessionEventLog } from "./session-event-log.js";
import { readSessionHistory } from "./session-history.js";
import { SessionTaskState } from "./session-task-state.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

class Observer extends EventEmitter implements TranscriptObserverRuntime {
  catalog = { projects: [], sessions: [], observedAt: 1 };
  isDesktopBusy() { return false; }
  isMainTurnBusy() { return false; }
  runningSubagents() { return undefined; }
  externalWriteVersion() { return 0; }
  async canStartBridgeHost() { return true; }
  onCatalog(listener: Parameters<TranscriptObserverRuntime["onCatalog"]>[0]) { this.on("catalog", listener); return () => this.off("catalog", listener); }
}

type Row = Record<string, any>;
function transcript(sessionId: string, kind: string): Row[] {
  const rows: Row[] = [];
  const add = (uuid: string, type: string, content: unknown, extra: Row = {}) => {
    rows.push({ uuid, parentUuid: rows.at(-1)?.uuid ?? null, type, sessionId,
      timestamp: new Date(1_700_000_000_000 + rows.length * 1000).toISOString(),
      message: { role: type, content }, ...extra });
  };
  if (kind !== "first-turn") {
    add("stable-user", "user", "Complete request");
    add("stable-answer", "assistant", "Complete answer");
    rows.at(-1)!.message.stop_reason = "end_turn";
  }
  add("active-user", "user", "Triggering input");
  if (!["partial-response", "first-turn", "steering"].includes(kind)) {
    add("agent-call", "assistant", [{ type: "tool_use", id: "agent-tool", name: "Agent", input: { description: "Parent agent", run_in_background: true } }]);
    rows.at(-1)!.message.stop_reason = "tool_use";
    add("agent-result", "user", [{ type: "tool_result", tool_use_id: "agent-tool", content: "Async agent launched successfully. agentId: parent-agent" }], { toolUseResult: { agentId: "parent-agent", status: "async_launched", isAsync: true } });
    add("shell-call", "assistant", [{ type: "tool_use", id: "shell-tool", name: "Bash", input: { run_in_background: true } }]);
    rows.at(-1)!.message.stop_reason = "tool_use";
    add("shell-result", "user", [{ type: "tool_result", tool_use_id: "shell-tool", content: "Background task" }], { toolUseResult: { backgroundTaskId: "parent-shell" } });
  }
  if (kind === "completed-agent-control") add("notification", "user", "<task-notification><task-id>parent-agent</task-id><status>completed</status></task-notification>");
  if (kind === "abandoned-agent-branch") add("sibling-user", "user", "Selected sibling", { parentUuid: "stable-answer" });
  if (kind === "steering") {
    add("progress", "assistant", "Intermediate progress");
    add("steer", "user", "Adjust the same unfinished round");
  }
  add("partial-answer", "assistant", "Intermediate answer");
  if (!["partial-response", "active-agent-and-shell", "first-turn", "steering"].includes(kind)) rows.at(-1)!.message.stop_reason = "end_turn";
  return rows;
}

it.each(["partial-response", "active-agent-and-shell", "first-turn", "steering"])("forks before the entire unfinished round: %s", async (kind) => {
  const root = await mkdtemp(join(tmpdir(), "bridge-fork-boundary-"));
  roots.push(root);
  const projects = join(root, "projects");
  await mkdir(projects);
  const eventLog = new SessionEventLog(join(root, "events.jsonl"), 1);
  const broker = new SessionBroker({ paths: { projects, tasks: join(root, "tasks"), sessions: join(root, "sessions"), desktopSessions: [] },
    observer: new Observer(), eventLog, sessionsPath: join(root, "bridge-sessions.json"), queuePath: join(root, "queue.json"),
    discoverGatewayModels: async () => [], prepareRuntime: async () => ({ environment: {} }),
    hostFactory: () => { throw new Error("No executor may start in this test"); } });
  try {
    const source = await broker.createSession(root, "Parent");
    const path = join(projects, `${source.sessionId}.jsonl`);
    const before = transcript(source.sessionId, kind).map(row => JSON.stringify(row)).join("\n") + "\n";
    await writeFile(path, before);
    const fork = await broker.forkSession(source.sessionId);
    const forkPath = join(projects, `${fork.sessionId}.jsonl`);
    const rows = (await readFile(forkPath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect.soft(rows.some(row => row.uuid === "active-user")).toBe(false);
    expect.soft(rows.some(row => row.uuid === "partial-answer" || row.uuid === "steer")).toBe(false);
    expect.soft(rows.some(row => JSON.stringify(row.message ?? "").includes("interrupted"))).toBe(false);
    expect.soft((await parseClaudeTranscriptSnapshot(forkPath)).pendingBackgroundShellTaskIds ?? []).toEqual([]);
    expect.soft((await parseClaudeTranscriptSnapshot(forkPath)).messages.map(message => message.id))
      .toEqual(kind === "first-turn" ? [] : ["stable-user", "stable-answer"]);
    expect(await readFile(path, "utf8")).toBe(before);
  } finally { await broker.close(); await eventLog.close(); }
});

it.each(["main-finished-agent-running", "completed-agent-control", "abandoned-agent-branch"])("inherits history without parent execution authority: %s", async (kind) => {
  const root = await mkdtemp(join(tmpdir(), "bridge-fork-tasks-"));
  roots.push(root);
  const projects = join(root, "projects");
  await mkdir(projects);
  const eventLog = new SessionEventLog(join(root, "events.jsonl"), 1);
  const options = { paths: { projects, tasks: join(root, "tasks"), sessions: join(root, "sessions"), desktopSessions: [] },
    observer: new Observer(), eventLog, sessionsPath: join(root, "bridge-sessions.json"), queuePath: join(root, "queue.json"),
    discoverGatewayModels: async () => [], prepareRuntime: async () => ({ environment: {} }),
    hostFactory: () => { throw new Error("No executor may start in this test"); } };
  const broker = new SessionBroker(options);
  let reopened: SessionBroker | undefined;
  try {
    const source = await broker.createSession(root, "Parent");
    await writeFile(join(projects, `${source.sessionId}.jsonl`), transcript(source.sessionId, kind).map(row => JSON.stringify(row)).join("\n") + "\n");
    if (kind === "abandoned-agent-branch") {
      const subagents = join(projects, source.sessionId, "subagents");
      await mkdir(subagents, { recursive: true });
      await writeFile(join(subagents, "agent-parent-agent.meta.json"), JSON.stringify({ toolUseId: "agent-tool", description: "Abandoned sibling task" }));
      await writeFile(join(subagents, "agent-parent-agent.jsonl"), JSON.stringify({ type: "assistant", timestamp: new Date(1_700_000_008_000).toISOString(),
        message: { role: "assistant", content: [{ type: "tool_use", id: "read", name: "Read", input: {} }] } }) + "\n");
    }
    const fork = await broker.forkSession(source.sessionId);
    const childPath = join(projects, `${fork.sessionId}.jsonl`);
    const parentTasks = await readClaudeSessionSubagents(projects, source.sessionId, root, 0);
    if (kind === "abandoned-agent-branch") {
      expect.soft(parentTasks).toEqual([]);
      await eventLog.append({ sessionId: source.sessionId, itemId: "active-user", origin: "claude-desktop", type: "session.observed", data: { role: "user", text: "Abandoned branch input" } });
      await eventLog.append({ sessionId: source.sessionId, itemId: "agent-tool", origin: "claude-desktop", type: "tool.progress", data: { toolName: "Agent", subagent: {
        agentId: "parent-agent", toolUseId: "agent-tool", description: "Abandoned task", state: "running", toolCount: 0, startedAt: 1, updatedAt: 2,
      } } });
      const selectedHistory = await broker.history(source.sessionId);
      expect.soft(selectedHistory.items.filter(item => item.subagent || item.id === "active-user")).toEqual([]);
    }
    const inherited = await readClaudeSessionSubagents(projects, fork.sessionId, root, 0);
    expect.soft(inherited.map(task => task.state)).toEqual(kind === "abandoned-agent-branch" ? [] : [kind === "completed-agent-control" ? "completed" : "unknown"]);
    expect.soft((await parseClaudeTranscriptSnapshot(childPath)).pendingBackgroundShellTaskIds).toEqual([]);
    const state = new SessionTaskState();
    state.beginGeneration(fork.sessionId, "child-generation");
    for (const activeTurn of [false, true, false]) {
      const page = await readSessionHistory({ paths: { projects }, eventLog, taskState: state, session: fork, activeTurn, observedSessions: [] });
      expect.soft(page.items.filter(item => item.subagent?.state === "running")).toEqual([]);
    }
    // First child round completes, then the parent appends a late notification.
    await appendFile(childPath, [
      { type: "user", uuid: "child-user", parentUuid: "partial-answer", sessionId: fork.sessionId, message: { role: "user", content: "Child round" } },
      { type: "assistant", uuid: "child-answer", parentUuid: "child-user", sessionId: fork.sessionId, message: { role: "assistant", content: "Child complete", stop_reason: "end_turn" } },
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    await appendFile(join(projects, `${source.sessionId}.jsonl`), JSON.stringify({ type: "user", uuid: "late-parent", parentUuid: "partial-answer", sessionId: source.sessionId,
      message: { role: "user", content: "<task-notification><task-id>parent-agent</task-id><status>completed</status></task-notification>" } }) + "\n");
    await broker.close();
    reopened = new SessionBroker(options);
    await reopened.initialize();
    const page = await reopened.history(fork.sessionId);
    expect.soft(page.items.filter(item => item.subagent?.state === "running")).toEqual([]);
    expect.soft(page.items.some(item => item.id === "child-answer")).toBe(true);
    const stored = JSON.parse(await readFile(options.sessionsPath, "utf8")).sessions.find((item: Row) => item.sessionId === fork.sessionId);
    expect.soft(stored.forkBoundary).toMatchObject({ parentSessionId: source.sessionId, parentNativeSessionId: source.sessionId, parentDesktopSessionId: `local_${source.sessionId}`, baseMessageUuid: "partial-answer", reason: "completed-head" });
  } finally { await broker.close(); await reopened?.close(); await eventLog.close(); }
});

it("current generation host tasks block while inherited transcript tasks have no live membership", () => {
  const state = new SessionTaskState();
  state.beginGeneration("child", "generation-1");
  const inherited = { agentId: "parent-agent", toolUseId: "parent-tool", description: "Parent", state: "running" as const, toolCount: 0, startedAt: 1, updatedAt: 2 };
  expect.soft(state.mergeSubagents("child", [inherited])[0]?.state).toBe("unknown");
  const task = { taskId: "child-agent", toolUseId: "child-tool", description: "Child", state: "running" as const, isBackgrounded: true, startedAt: 3, updatedAt: 4 };
  state.update("child", "generation-1", task);
  expect(state.isRunning("child", "parent-agent")).toBe(false);
  expect(state.isRunning("child", "child-agent")).toBe(true);
  expect(state.runningSubagents("child")?.count).toBe(1);
  state.update("child", "old-parent-generation", { ...task, state: "completed", updatedAt: 100 });
  expect(state.isRunning("child", "child-agent")).toBe(true);
  state.update("child", "generation-1", { ...task, state: "completed", updatedAt: 5 });
  expect(state.runningSubagents("child")).toBeUndefined();
});

it.each(["completed-parent", "empty-parent"])("keeps child task authority and resume semantics through completion, reconnect and restart (%s)", async (kind) => {
  const root = await mkdtemp(join(tmpdir(), "bridge-fork-child-host-"));
  roots.push(root);
  const projects = join(root, "projects");
  await mkdir(projects);
  const eventLog = new SessionEventLog(join(root, "events.jsonl"), 1);
  const storeOptions = { databasePath: join(root, "conversations.sqlite"), sessionsPath: join(root, "sessions.json"), queuePath: join(root, "queue.json"), masterSecret: "test-secret" };
  const store = new ConversationStateStore(storeOptions);
  const events = new EventEmitter();
  const stopTask = vi.fn(async (_taskId: string) => {});
  let hostOptions: ClaudeSessionHostOptions | undefined;
  const options = { paths: { projects, tasks: join(root, "tasks"), sessions: join(root, "runtime-sessions"), desktopSessions: [] },
    observer: new Observer(), eventLog, conversationState: store, sessionsPath: storeOptions.sessionsPath, queuePath: storeOptions.queuePath,
    scanSessionProcesses: async () => [], discoverGatewayModels: async () => [],
    prepareRuntime: async () => ({ executablePath: "/fake/claude", credentialPath: "/fake/credentials.json", environment: {} }),
    hostFactory: (input: ClaudeSessionHostOptions) => {
      hostOptions = input;
      return { start() {}, async setModel() {}, async setEffort() {}, async setAutoCompactWindow() {},
        async supportedModels() { return []; }, async contextUsage(): Promise<never> { throw new Error("unused"); },
        send() { return { messageId: "child-user", turnId: "child-turn" }; },
        async interrupt() {}, stopTask, async close() { events.removeAllListeners("event"); },
        onEvent(listener: (event: SessionHostEvent) => void) { events.on("event", listener); return () => events.off("event", listener); } };
    } };
  const broker = new SessionBroker(options);
  let reopened: SessionBroker | undefined;
  let reopenedStore: ConversationStateStore | undefined;
  try {
    await broker.initialize();
    const source = await broker.createSession(root, "Parent");
    const nativeParentId = "native-parent-lane";
    store.updateLane(store.activeLane(source.sessionId)!.laneId, { nativeSessionId: nativeParentId });
    const parentPath = join(projects, `${nativeParentId}.jsonl`);
    await writeFile(parentPath, transcript(nativeParentId, kind === "empty-parent" ? "first-turn" : "main-finished-agent-running").map(row => JSON.stringify(row)).join("\n") + "\n");
    const child = await broker.forkSession(source.sessionId);
    const childPath = join(projects, `${child.sessionId}.jsonl`);
    const childBytes = await readFile(childPath);
    await broker.startTurn({ sessionId: child.sessionId, requestId: "child-request", idempotencyKey: "child-key", text: "Child request", origin: "mobile" });
    await vi.waitFor(() => expect(hostOptions).toBeDefined());
    expect(hostOptions?.resume).toBe(kind !== "empty-parent");
    const emit = (event: SessionHostEvent) => events.emit("event", event);
    emit({ type: "user.accepted", sessionId: child.sessionId, turnId: "child-turn", messageId: "child-user", text: "Child request", attachments: [], origin: "mobile", at: Date.now() });
    const task = { taskId: "child-agent", toolUseId: "child-tool", description: "Child background", state: "running" as const, isBackgrounded: true, startedAt: Date.now(), updatedAt: Date.now() };
    emit({ type: "task.started", sessionId: child.sessionId, ...task, at: task.updatedAt });
    emit({ type: "turn.completed", sessionId: child.sessionId, turnId: "child-turn", result: "Main complete", at: Date.now() });
    await vi.waitFor(() => {
      expect(broker.session(child.sessionId)?.turnState).toBe("idle");
      expect(broker.session(child.sessionId)?.runningSubagents?.count).toBe(1);
      expect(broker.session(child.sessionId)?.desktopHandoff?.canReturn).toBe(false);
    });
    const connected = await broker.history(child.sessionId);
    const reconnected = await broker.history(child.sessionId);
    expect(connected.items.filter(item => item.subagent?.state === "running").map(item => item.subagent?.agentId)).toEqual(["child-agent"]);
    expect(reconnected.items).toEqual(connected.items);
    await expect(broker.stopSubagent(child.sessionId, "parent-agent")).rejects.toThrow();
    expect(stopTask).not.toHaveBeenCalled();
    await broker.stopSubagent(child.sessionId, "child-agent");
    expect(stopTask).toHaveBeenCalledWith("child-agent");
    // A notification on the parent's session cannot terminate a child's matching task ID.
    emit({ type: "task.notification", sessionId: source.sessionId, ...task, state: "completed", at: Date.now() });
    await appendFile(parentPath, JSON.stringify({ type: "user", uuid: "late-parent", parentUuid: "partial-answer", sessionId: source.sessionId,
      message: { role: "user", content: "<task-notification><task-id>parent-agent</task-id><status>completed</status></task-notification>" } }) + "\n");
    expect(await readFile(childPath)).toEqual(childBytes);
    expect(broker.session(child.sessionId)?.desktopHandoff?.canReturn).toBe(false);
    emit({ type: "task.notification", sessionId: child.sessionId, ...task, state: "completed", updatedAt: Date.now(), at: Date.now() });
    await vi.waitFor(() => expect(broker.session(child.sessionId)?.desktopHandoff?.canReturn).toBe(true));
    await appendFile(childPath, [
      { type: "user", uuid: "child-user", parentUuid: kind === "empty-parent" ? null : "partial-answer", sessionId: child.sessionId, message: { role: "user", content: "Child request" } },
      { type: "assistant", uuid: "child-answer", parentUuid: "child-user", sessionId: child.sessionId, message: { role: "assistant", content: "Main complete", stop_reason: "end_turn" } },
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    await broker.close();
    store.close();
    reopenedStore = new ConversationStateStore(storeOptions);
    reopened = new SessionBroker({ ...options, conversationState: reopenedStore });
    await reopened.initialize();
    const saved = reopenedStore.loadBrokerState().sessions.find(session => session.sessionId === child.sessionId) as Row;
    expect(saved.forkBoundary).toMatchObject({ parentSessionId: source.sessionId, parentNativeSessionId: nativeParentId, parentDesktopSessionId: `local_${nativeParentId}`, baseMessageUuid: kind === "empty-parent" ? null : "partial-answer" });
    const page = await reopened.history(child.sessionId);
    expect(page.items.filter(item => item.subagent?.state === "running")).toEqual([]);
    expect(page.items.find(item => item.subagent?.agentId === "parent-agent")?.subagent?.state).toBe(kind === "empty-parent" ? undefined : "unknown");
    expect(page.items.find(item => item.subagent?.agentId === "child-agent")?.subagent?.state).toBe("completed");
    hostOptions = undefined;
    await reopened.startTurn({ sessionId: child.sessionId, requestId: "second-request", idempotencyKey: "second-key", text: "Continue child", origin: "mobile" });
    await vi.waitFor(() => expect(hostOptions?.resume).toBe(true));
  } finally { await broker.close(); await reopened?.close(); store.close(); reopenedStore?.close(); await eventLog.close(); }
});

it("cuts before a notification follow-up while ignoring sidechain records", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-fork-idle-notification-"));
  roots.push(root);
  const path = join(root, "parent.jsonl");
  const rows = transcript("parent", "main-finished-agent-running");
  rows.push({ type: "user", uuid: "late", parentUuid: "partial-answer", sessionId: "parent",
    message: { role: "user", content: "<task-notification><task-id>parent-agent</task-id><status>completed</status></task-notification>" } });
  rows.push({ type: "assistant", uuid: "sidechain", parentUuid: "stable-answer", isSidechain: true,
    message: { role: "assistant", content: "Sidechain work" } });
  await writeFile(path, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  const snapshot = await parseClaudeTranscriptSnapshot(path);
  expect(snapshot.terminalUuid).toBe("late");
  expect(snapshot.atTurnBoundary).toBe(false);
  expect(snapshot.branch?.forkBaseMessageUuid).toBe("partial-answer");
});

it("retains inherited ownership when a child selects ancestry before its saved base UUID", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-fork-rewound-chain-"));
  roots.push(root);
  const path = join(root, "child.jsonl");
  await writeFile(path, [
    ...transcript("parent", "main-finished-agent-running"),
    { type: "custom-title", bridgeFork: { baseMessageUuid: "partial-answer" } },
    { type: "user", uuid: "child-rewind", parentUuid: "agent-result", sessionId: "child", message: { role: "user", content: "New branch before saved base" } },
    { type: "assistant", uuid: "child-answer", parentUuid: "child-rewind", sessionId: "child", message: { role: "assistant", content: "Done", stop_reason: "end_turn" } },
  ].map(row => JSON.stringify(row)).join("\n") + "\n");
  expect((await parseClaudeTranscriptSnapshot(path)).branch?.inheritedUuids).toContain("agent-call");
  expect((await readClaudeSessionSubagents(root, "child", root, 0)).map(task => task.state)).toEqual(["unknown"]);
});

it("does not invent an empty boundary when a compacted unfinished round has no prior completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-fork-compacted-"));
  roots.push(root);
  const path = join(root, "parent.jsonl");
  await writeFile(path, [
    { type: "system", subtype: "compact_boundary", uuid: "compact", parentUuid: null },
    { type: "user", uuid: "summary", parentUuid: "compact", isCompactSummary: true, message: { role: "user", content: "Prior context" } },
    { type: "user", uuid: "active", parentUuid: "summary", message: { role: "user", content: "Continue" } },
    { type: "assistant", uuid: "partial", parentUuid: "active", message: { role: "assistant", content: "Partial" } },
  ].map(row => JSON.stringify(row)).join("\n") + "\n");
  expect((await parseClaudeTranscriptSnapshot(path)).branch?.forkBaseMessageUuid).toBeUndefined();
});
