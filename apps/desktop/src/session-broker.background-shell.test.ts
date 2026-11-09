import { randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionBroker, type SessionHostRuntime } from "./session-broker.js";
import type { SessionHostEvent } from "./claude-session-host.js";
import { parseClaudeTranscriptSnapshot } from "./claude-history.js";
import { SessionEventLog } from "./session-event-log.js";
import type { SessionTaskState } from "./session-task-state.js";
import { TranscriptObserver } from "./transcript-observer.js";

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "darwin" });
});
afterEach(() => {
  Object.defineProperty(process, "platform", platformDescriptor);
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bridge-background-shell-handoff-"));
  const sessionId = randomUUID();
  const pid = 2_147_483_646;
  const startedAt = Date.now() - 10_000;
  const paths = { sessions: join(root, "sessions"), tasks: join(root, "tasks"), projects: join(root, "projects"), desktopSessions: [] };
  await Promise.all([mkdir(paths.sessions), mkdir(paths.projects)]);
  const registration = join(paths.sessions, "desktop.json");
  const transcript = join(paths.projects, `${sessionId}.jsonl`);
  const line = (value: Record<string, unknown>) => JSON.stringify({ sessionId, cwd: root, timestamp: new Date().toISOString(), ...value });
  await writeFile(registration, JSON.stringify({ pid, sessionId, cwd: root, startedAt, entrypoint: "claude-desktop-3p" }));
  await writeFile(transcript, [
    line({ type: "user", uuid: "input", parentUuid: null, message: { role: "user", content: "Start the background check" } }),
    line({ type: "assistant", uuid: "bash", parentUuid: "input", message: { role: "assistant", stop_reason: "tool_use", content: [
      { type: "tool_use", id: "bash-call", name: "Bash", input: { command: "true", run_in_background: true } },
    ] } }),
    line({ type: "user", uuid: "bash-result", parentUuid: "bash", toolUseResult: { stdout: "", stderr: "", interrupted: false, backgroundTaskId: "shell-1" }, message: {
      role: "user", content: [{ type: "tool_result", tool_use_id: "bash-call", content: "Command running in background with ID: shell-1" }],
    } }),
    line({ type: "assistant", uuid: "done", parentUuid: "bash-result", message: { role: "assistant", content: "The check continues in the background.", stop_reason: "end_turn" } }),
    "",
  ].join("\n"));
  const eventLog = new SessionEventLog(join(root, "events.jsonl"), 1);
  const observer = new TranscriptObserver({ paths, eventLog, platform: "linux", pollIntervalMs: 60_000, catalogIntervalMs: 0 });
  let alive = true;
  let closed = Promise.resolve();
  const signal = vi.spyOn(process, "kill").mockImplementation((target, name) => {
    if (target !== pid || !alive) throw Object.assign(new Error("Fake process exited"), { code: "ESRCH" });
    if (name === "SIGINT") {
      alive = false;
      closed = writeFile(registration, JSON.stringify({ pid: 999_999_999, sessionId, cwd: root, startedAt, entrypoint: "claude-desktop-3p" }))
        .then(() => observer.start());
    }
    return true;
  });
  let listener: ((event: SessionHostEvent) => void) | undefined;
  const host = {
    start() {}, async setModel() {}, async setEffort() {}, async setAutoCompactWindow() {},
    async supportedModels() { return []; }, async contextUsage(): Promise<never> { throw new Error("unused"); },
    runningBackgroundTasks: [] as NonNullable<SessionHostRuntime["runningBackgroundTasks"]>,
    hasPendingInput: false,
    send: vi.fn((input: Parameters<SessionHostRuntime["send"]>[0]) => {
      const message: { messageId?: string; turnId?: string } = typeof input === "string" ? {} : input;
      const submitted = { messageId: message.messageId ?? randomUUID(), turnId: message.turnId ?? randomUUID() };
      listener?.({ type: "user.submitted", sessionId, ...submitted, at: Date.now() });
      return submitted;
    }),
    interrupt: vi.fn(async () => {}), stopTask: vi.fn(async () => {}), close: vi.fn(async () => {}),
    onEvent(callback: (event: SessionHostEvent) => void) { listener = callback; return () => { listener = undefined; }; },
  };
  const broker = new SessionBroker({
    paths, observer, eventLog, sessionsPath: join(root, "bridge-sessions.json"), queuePath: join(root, "queue.json"),
    hostFactory: () => host,
    scanSessionProcesses: async () => alive ? [{ pid, startedAt, processAlive: true, entrypoint: "claude-desktop-3p", source: "process" }] : [],
    maxParallelTurns: 1, discoverGatewayModels: async () => [],
    prepareRuntime: async () => ({ executablePath: "/fake/claude", credentialPath: "/fake/credentials.json", environment: {} }),
  });
  await observer.start();
  await broker.initialize();
  const requestId = randomUUID();
  await broker.startTurn({ sessionId, requestId, idempotencyKey: requestId, text: "Continue from the phone", origin: "mobile" });
  await (broker as unknown as { pump(): Promise<void> }).pump();
  return {
    broker, host, observer, sessionId, signal,
    emit(event: SessionHostEvent) { listener?.(event); },
    sigints() { return signal.mock.calls.filter(([, name]) => name === "SIGINT"); },
    async completeShell() {
      await appendFile(transcript, line({ type: "user", uuid: "completed", parentUuid: "done", isMeta: true, message: {
        role: "user", content: "<task-notification><task-id>shell-1</task-id><status>completed</status></task-notification>",
      } }) + "\n");
      await observer.start();
    },
    snapshot() { return parseClaudeTranscriptSnapshot(transcript); },
    async close() {
      await closed;
      await broker.close();
      await observer.close();
      await eventLog.close();
      signal.mockRestore();
      await rm(root, { recursive: true, force: true });
    },
  };
}

it("#3 refuses takeover without SIGINT while a background Bash remains pending after end_turn", async () => {
  const f = await fixture();
  try {
    expect(await f.snapshot()).toMatchObject({ atTurnBoundary: true, pendingBackgroundShellTaskIds: ["shell-1"] });
    expect(f.observer.isMainTurnBusy(f.sessionId)).toBe(false);
    const error = await f.broker.takeoverDesktop(f.sessionId).then(() => undefined, (error: unknown) => error);
    expect(f.sigints()).toHaveLength(0);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toMatch(/后台任务/);
    expect(f.host.send).not.toHaveBeenCalled();
    expect(f.broker.session(f.sessionId)?.desktopHandoff?.canTakeover).toBe(false);
  } finally { await f.close(); }
});

it("#3 permits takeover after the background Bash completion notification", async () => {
  const f = await fixture();
  try {
    await f.completeShell();
    expect((await f.snapshot()).pendingBackgroundShellTaskIds).toEqual([]);
    await f.broker.takeoverDesktop(f.sessionId);
    await vi.waitFor(() => expect(f.host.send).toHaveBeenCalledOnce(), { timeout: 3_000 });
    expect(f.sigints()).toHaveLength(1);
  } finally { await f.close(); }
});

it("lists the backgrounded Bash in the session's background tasks until its notification", async () => {
  const f = await fixture();
  try {
    expect(f.broker.session(f.sessionId)?.backgroundTasks).toEqual([expect.objectContaining({
      id: "bash-call", kind: "bash", taskId: "shell-1", description: "true", state: "running",
    })]);
    await f.completeShell();
    expect(f.broker.session(f.sessionId)?.backgroundTasks?.[0]).toMatchObject({ id: "bash-call", state: "completed" });
  } finally { await f.close(); }
});

it("lets live host task state override and extend the transcript's background tasks", async () => {
  const f = await fixture();
  try {
    const taskState = (f.broker as unknown as { taskState: SessionTaskState }).taskState;
    const now = Date.now();
    taskState.beginGeneration(f.sessionId, "generation-1");
    taskState.update(f.sessionId, "generation-1", {
      taskId: "shell-1", toolUseId: "bash-call", taskType: "local_bash", description: "Background check",
      state: "failed", startedAt: now - 5_000, updatedAt: now, completedAt: now,
    });
    taskState.update(f.sessionId, "generation-1", {
      taskId: "wf-task", toolUseId: "workflow-call", taskType: "local_workflow", description: "Review figures",
      state: "running", startedAt: now, updatedAt: now,
    });
    expect(f.broker.session(f.sessionId)?.backgroundTasks?.map((task) => [task.id, task.kind, task.state, task.description])).toEqual([
      ["workflow-call", "workflow", "running", "Review figures"],
      ["bash-call", "bash", "failed", "Background check"],
    ]);
  } finally { await f.close(); }
});
