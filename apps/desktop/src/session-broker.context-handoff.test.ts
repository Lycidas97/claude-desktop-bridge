import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { SessionBroker, type SessionHostRuntime, type SessionBrokerOptions, type QueuedTurn } from "./session-broker.js";
import type { SessionHostEvent } from "./claude-session-host.js";
import { SessionEventLog } from "./session-event-log.js";
import { TranscriptObserver } from "./transcript-observer.js";

async function fixture(desktopOpen = true) {
  const root = await mkdtemp(join(tmpdir(), "bridge-context-handoff-"));
  const sessionId = randomUUID();
  const paths = { sessions: join(root, "sessions"), tasks: join(root, "tasks"), projects: join(root, "projects"), desktopSessions: [] };
  await Promise.all([mkdir(paths.sessions), mkdir(paths.projects)]);
  const desktopRegistration = join(paths.sessions, "desktop.json");
  const desktopStartedAt = Date.now() - 10_000;
  const openDesktop = (startedAt = desktopStartedAt) => writeFile(desktopRegistration, JSON.stringify({
    pid: process.pid, sessionId, cwd: root, startedAt, entrypoint: "claude-desktop-3p",
  }));
  if (desktopOpen) await openDesktop();
  else await writeFile(desktopRegistration, JSON.stringify({ pid: 999_999_999, sessionId, cwd: root, startedAt: desktopStartedAt, entrypoint: "claude-desktop-3p" }));
  await writeFile(join(paths.projects, `${sessionId}.jsonl`), [
    JSON.stringify({ type: "user", uuid: "desktop-input", parentUuid: null, sessionId, cwd: root, message: { role: "user", content: "Desktop task" } }),
    JSON.stringify({ type: "assistant", uuid: "desktop-loaded-head", parentUuid: "desktop-input", sessionId, message: { role: "assistant", content: "Finished", stop_reason: "end_turn" } }),
    "",
  ].join("\n"));
  const eventLog = new SessionEventLog(join(root, "events.jsonl"), 1);
  const observer = new TranscriptObserver({ paths, eventLog, platform: "linux", pollIntervalMs: 60_000, catalogIntervalMs: 0 });
  let listener: ((event: SessionHostEvent) => void) | undefined;
  let current: { turnId: string; messageId: string } | undefined;
  const host = {
    start() {}, async setModel() {}, async setEffort() {}, async setAutoCompactWindow() {},
    async supportedModels() { return []; }, async contextUsage(): Promise<never> { throw new Error("unused"); },
    runningBackgroundTasks: [] as NonNullable<SessionHostRuntime["runningBackgroundTasks"]>,
    hasPendingInput: false,
    send: vi.fn((input: Parameters<SessionHostRuntime["send"]>[0]) => {
      const message: { messageId?: string; turnId?: string } = typeof input === "string" ? {} : input;
      current = { messageId: message.messageId ?? randomUUID(), turnId: message.turnId ?? randomUUID() };
      listener?.({ type: "user.submitted", sessionId, ...current, at: Date.now() });
      return current;
    }),
    interrupt: vi.fn(async () => {}), stopTask: vi.fn(async () => {}), close: vi.fn(async () => {}),
    onEvent(callback: (event: SessionHostEvent) => void) { listener = callback; return () => { listener = undefined; }; },
  };
  const hostFactory = vi.fn((): SessionHostRuntime => host);
  const scanSessionProcesses = vi.fn(async () => [] as typeof observer.catalog.sessions[number]["activeProcesses"]);
  const options: SessionBrokerOptions = {
    paths, observer, eventLog, sessionsPath: join(root, "bridge-sessions.json"), queuePath: join(root, "queue.json"),
    hostFactory, scanSessionProcesses, maxParallelTurns: 1, discoverGatewayModels: async () => [],
    prepareRuntime: async () => ({ executablePath: "/fake/claude", credentialPath: "/fake/credentials.json", environment: {} }),
  };
  const broker = new SessionBroker(options);
  const internal = broker as unknown as { pump(): Promise<void>; eventQueue: Promise<void> };
  await observer.start();
  await broker.initialize();
  return {
    broker, host, hostFactory, observer, eventLog, openDesktop, root, sessionId, scanSessionProcesses, options,
    get queue() { return (broker as unknown as { pending: QueuedTurn[] }).pending; },
    async closeDesktop() {
      await writeFile(desktopRegistration, JSON.stringify({ pid: 999_999_999, sessionId, cwd: root, startedAt: desktopStartedAt, entrypoint: "claude-desktop-3p" }));
      await observer.start();
    },
    async send(target: string = sessionId, key: string = randomUUID()) {
      const receipt = await broker.startTurn({ sessionId: target, requestId: key, idempotencyKey: key, text: "Continue from the phone", origin: "mobile" });
      await internal.pump();
      return receipt;
    },
    async complete() {
      listener?.({ type: "turn.completed", sessionId, turnId: current!.turnId, result: "Finished", at: Date.now() });
      await internal.eventQueue;
    },
    async close() {
      await broker.close();
      await observer.close();
      await eventLog.close();
      execFileSync(process.platform === "darwin" ? "/usr/bin/trash" : "trash-put", [root]);
    },
  };
}

function armDesktopExit(f: Awaited<ReturnType<typeof fixture>>) {
  const pid = 2_147_483_646;
  let alive = true;
  let closed = Promise.resolve();
  f.scanSessionProcesses.mockImplementation(async () => alive ? [{
    pid, startedAt: Date.now() - 10_000, processAlive: true, entrypoint: "claude-desktop-3p", source: "process",
  }] : []);
  const kill = process.kill.bind(process);
  const signal = vi.spyOn(process, "kill").mockImplementation((target, name) => {
    if (target !== pid) return kill(target, name);
    if (name === "SIGINT") { alive = false; closed = f.closeDesktop(); return true; }
    if (!alive) throw Object.assign(new Error("Process exited"), { code: "ESRCH" });
    return true;
  });
  return { pid, signal, kill, async close() { await closed; signal.mockRestore(); } };
}

it("explicitly releases only the target idle Desktop executor and sends the original queued command once", async () => {
  const f = await fixture();
  const exit = armDesktopExit(f);
  try {
    await f.send(f.sessionId, "explicit-takeover");
    expect(f.host.send).not.toHaveBeenCalled();
    expect(f.broker.session(f.sessionId)?.desktopHandoff?.canTakeover).toBe(true);
    await f.broker.takeoverDesktop(f.sessionId);
    await vi.waitFor(() => expect(f.host.send).toHaveBeenCalledOnce(), { timeout: 3_000 });
    expect(exit.signal).toHaveBeenCalledWith(exit.pid, "SIGINT");
    expect(exit.signal.mock.calls.filter(([, signal]) => signal === "SIGINT")).toHaveLength(1);
    await f.send(f.sessionId, "explicit-takeover");
    expect(f.host.send).toHaveBeenCalledOnce();
  } finally { await exit.close(); await f.close(); }
});

it("allows an explicit takeover while Desktop is awaiting an AskUserQuestion answer", async () => {
  const f = await fixture();
  const exit = armDesktopExit(f);
  try {
    await writeFile(join(f.root, "projects", `${f.sessionId}.jsonl`), [
      JSON.stringify({ type: "user", uuid: "input", parentUuid: null, sessionId: f.sessionId, cwd: f.root, message: { role: "user", content: "Do the task" } }),
      JSON.stringify({ type: "assistant", uuid: "question", parentUuid: "input", sessionId: f.sessionId, message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id: "ask", name: "AskUserQuestion", input: { questions: [{ question: "Continue?", header: "Continue", options: [{ label: "Yes", description: "Continue" }, { label: "No", description: "Stop" }], multiSelect: false }] } }] } }), "",
    ].join("\n"));
    await f.observer.start();
    expect(f.observer.isMainTurnBusy(f.sessionId)).toBe(true);
    await f.send();
    expect(f.broker.session(f.sessionId)?.desktopHandoff?.canTakeover).toBe(true);
    await f.broker.takeoverDesktop(f.sessionId);
    await vi.waitFor(() => expect(f.host.send).toHaveBeenCalledOnce(), { timeout: 3_000 });
    expect(exit.signal).toHaveBeenCalledWith(exit.pid, "SIGINT");
  } finally { await exit.close(); await f.close(); }
});

it("refuses takeover of a running main turn without signalling it", async () => {
  const f = await fixture();
  const exit = armDesktopExit(f);
  try {
    await writeFile(join(f.root, "projects", `${f.sessionId}.jsonl`), JSON.stringify({ type: "user", uuid: "working", parentUuid: null, sessionId: f.sessionId, cwd: f.root, message: { role: "user", content: "Still running" } }) + "\n");
    await f.observer.start();
    await f.send();
    await expect(f.broker.takeoverDesktop(f.sessionId)).rejects.toThrow(/运行|等待回答/);
    expect(exit.signal.mock.calls.filter(([, signal]) => signal === "SIGINT")).toHaveLength(0);
    expect(f.host.send).not.toHaveBeenCalled();
  } finally { await exit.close(); await f.close(); }
});

it("does not terminate Desktop when the queued message was cancelled", async () => {
  const f = await fixture();
  const exit = armDesktopExit(f);
  try {
    const receipt = await f.send();
    await f.broker.interruptTurn(f.sessionId, receipt.commandId);
    await expect(f.broker.takeoverDesktop(f.sessionId)).rejects.toThrow(/排队/);
    expect(exit.signal.mock.calls.filter(([, signal]) => signal === "SIGINT")).toHaveLength(0);
  } finally { await exit.close(); await f.close(); }
});

it("refuses takeover while a Desktop subagent is still running", async () => {
  const f = await fixture();
  const exit = armDesktopExit(f);
  const running = vi.spyOn(f.observer, "runningSubagents").mockReturnValue({ count: 1, lastUpdatedAt: Date.now() });
  try {
    await f.send();
    expect(f.broker.session(f.sessionId)?.desktopHandoff?.canTakeover).toBe(false);
    await expect(f.broker.takeoverDesktop(f.sessionId)).rejects.toThrow(/后台任务/);
    expect(exit.signal.mock.calls.filter(([, signal]) => signal === "SIGINT")).toHaveLength(0);
  } finally { running.mockRestore(); await exit.close(); await f.close(); }
});

it("sends only one exit request for concurrent confirmed takeovers", async () => {
  const f = await fixture();
  const exit = armDesktopExit(f);
  try {
    await f.send();
    let ready!: () => void;
    const scanning = new Promise<void>(resolve => { ready = resolve; });
    f.scanSessionProcesses.mockImplementation(async () => {
      await scanning;
      return [{ pid: exit.pid, startedAt: Date.now() - 10_000, processAlive: true, entrypoint: "claude-desktop-3p", source: "process" }];
    });
    const first = f.broker.takeoverDesktop(f.sessionId);
    await vi.waitFor(() => expect(f.scanSessionProcesses).toHaveBeenCalledOnce());
    const second = f.broker.takeoverDesktop(f.sessionId);
    ready();
    await Promise.all([first, second]);
    expect(exit.signal.mock.calls.filter(([, signal]) => signal === "SIGINT")).toHaveLength(1);
  } finally { await exit.close(); await f.close(); }
});

it("does not treat an AskUserQuestion alongside another running tool as idle", async () => {
  const f = await fixture();
  const exit = armDesktopExit(f);
  try {
    await writeFile(join(f.root, "projects", `${f.sessionId}.jsonl`), [
      JSON.stringify({ type: "user", uuid: "input", parentUuid: null, sessionId: f.sessionId, cwd: f.root, message: { role: "user", content: "Task" } }),
      JSON.stringify({ type: "assistant", uuid: "mixed", parentUuid: "input", sessionId: f.sessionId, message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id: "ask", name: "AskUserQuestion", input: { questions: [{ question: "Continue?", options: [] }] } }, { type: "tool_use", id: "work", name: "Bash", input: { command: "long task" } }] } }), "",
    ].join("\n"));
    await f.observer.start();
    await f.send();
    await expect(f.broker.takeoverDesktop(f.sessionId)).rejects.toThrow(/仍在运行/);
    expect(exit.signal.mock.calls.filter(([, signal]) => signal === "SIGINT")).toHaveLength(0);
  } finally { await exit.close(); await f.close(); }
});

it("refuses a registration-only PID rather than signalling an unverified process", async () => {
  const f = await fixture();
  const exit = armDesktopExit(f);
  try {
    await f.send();
    f.scanSessionProcesses.mockResolvedValue([{ pid: exit.pid, startedAt: 1, processAlive: true, entrypoint: "claude-desktop-3p", source: "registration" }]);
    await expect(f.broker.takeoverDesktop(f.sessionId)).rejects.toThrow(/无法确认/);
    expect(exit.signal.mock.calls.filter(([, signal]) => signal === "SIGINT")).toHaveLength(0);
  } finally { await exit.close(); await f.close(); }
});

it("keeps the queue and blocks a second executor if Desktop does not exit", async () => {
  const f = await fixture();
  const exit = armDesktopExit(f);
  exit.signal.mockImplementation((pid, signal) => pid === exit.pid ? true : exit.kill(pid, signal));
  try {
    await f.send();
    await expect(f.broker.takeoverDesktop(f.sessionId)).rejects.toThrow(/尚未退出/);
    expect(f.hostFactory).not.toHaveBeenCalled();
    expect(f.broker.session(f.sessionId)).toMatchObject({ pendingCount: 1, desktopHandoff: { state: "close-desktop", canTakeover: true } });
  } finally { await exit.close(); await f.close(); }
}, 10_000);

it("does not create a second same-session executor while Desktop retains its loaded context", async () => {
  const f = await fixture();
  try {
    expect(f.observer.catalog.sessions.find(session => session.sessionId === f.sessionId)?.desktopProcessAlive).toBe(true);
    expect(f.observer.isMainTurnBusy(f.sessionId)).toBe(false);
    await f.send();
    // A transcript boundary does not replace the live Desktop executor's in-memory context.
    expect(f.hostFactory).not.toHaveBeenCalled();
    expect(f.broker.session(f.sessionId)).toMatchObject({
      turnState: "queued", pendingCount: 1, desktopHandoff: { state: "close-desktop", canReturn: false },
    });
  } finally { await f.close(); }
});

it("submits the original queued command exactly once after the Desktop executor exits", async () => {
  const f = await fixture();
  try {
    const receipt = await f.send(f.sessionId, "one-command");
    await f.closeDesktop();
    await vi.waitFor(() => expect(f.host.send).toHaveBeenCalledOnce(), { timeout: 3_000 });
    await f.send(f.sessionId, "one-command");
    expect(f.host.send).toHaveBeenCalledOnce();
    expect(f.queue.find(turn => turn.commandId === receipt.commandId)?.state).toBe("running");
    await expect(f.broker.returnToDesktop(f.sessionId)).rejects.toThrow(/任务|运行/);
    expect(f.host.close).not.toHaveBeenCalled();
    await f.complete();
    expect(f.broker.session(f.sessionId)?.desktopHandoff).toEqual({ state: "bridge", canReturn: true });
    await f.broker.returnToDesktop(f.sessionId);
    expect(f.host.close).toHaveBeenCalledOnce();
    expect(f.broker.session(f.sessionId)?.ownership).toBe("BRIDGE_IDLE");
    expect(f.broker.session(f.sessionId)?.desktopHandoff).toBeUndefined();
    await f.broker.returnToDesktop(f.sessionId);
    expect(f.host.close).toHaveBeenCalledOnce();
    expect(f.host.interrupt).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

it("does not replay a cancelled handoff command when Desktop exits", async () => {
  const f = await fixture();
  try {
    const receipt = await f.send();
    await f.broker.interruptTurn(f.sessionId, receipt.commandId);
    await f.closeDesktop();
    await f.send(f.sessionId, receipt.idempotencyKey);
    expect(f.hostFactory).not.toHaveBeenCalled();
    expect(f.queue).toEqual([]);
  } finally { await f.close(); }
});

it("does not consume another session's execution slot while waiting for Desktop exit", async () => {
  const f = await fixture();
  try {
    await f.send();
    const other = await f.broker.createSession(f.root, "Independent work");
    await f.send(other.sessionId);
    await vi.waitFor(() => expect(f.host.send).toHaveBeenCalledOnce(), { timeout: 3_000 });
    expect(f.hostFactory.mock.calls[0]).toBeDefined();
    expect(f.broker.session(f.sessionId)).toMatchObject({ pendingCount: 1, desktopHandoff: { state: "close-desktop" } });
  } finally { await f.close(); }
});

it("keeps the host alive until pending background input is handled", async () => {
  const f = await fixture(false);
  try {
    await f.send();
    f.host.hasPendingInput = true;
    await f.complete();
    expect(f.broker.session(f.sessionId)?.desktopHandoff).toEqual({ state: "bridge", canReturn: false });
    await expect(f.broker.returnToDesktop(f.sessionId)).rejects.toThrow(/任务|运行|后台/);
    expect(f.host.close).not.toHaveBeenCalled();
    f.host.hasPendingInput = false;
    await f.broker.returnToDesktop(f.sessionId);
    expect(f.host.close).toHaveBeenCalledOnce();
  } finally { await f.close(); }
});

it("does not close a running background task when returning the conversation", async () => {
  const f = await fixture(false);
  try {
    await f.send();
    await f.complete();
    f.host.runningBackgroundTasks = [{ taskId: "child", description: "Background work", state: "running", startedAt: Date.now(), updatedAt: Date.now() }];
    await expect(f.broker.returnToDesktop(f.sessionId)).rejects.toThrow(/后台/);
    expect(f.host.close).not.toHaveBeenCalled();
    f.host.runningBackgroundTasks = [];
    await f.broker.returnToDesktop(f.sessionId);
    expect(f.host.close).toHaveBeenCalledOnce();
  } finally { await f.close(); }
});

it("preserves a handoff queue across restart and does not replay a submitted command after executor shutdown", async () => {
  const f = await fixture();
  let restored: SessionBroker | undefined;
  let recovered: SessionBroker | undefined;
  try {
    await f.send(f.sessionId, "persisted-command");
    await f.broker.close();
    restored = new SessionBroker(f.options);
    await restored.initialize();
    expect(f.host.send).not.toHaveBeenCalled();
    expect(restored.session(f.sessionId)).toMatchObject({ pendingCount: 1, desktopHandoff: { state: "close-desktop" } });
    await f.closeDesktop();
    await vi.waitFor(() => expect(f.host.send).toHaveBeenCalledOnce(), { timeout: 3_000 });
    await restored.close();
    recovered = new SessionBroker(f.options);
    await recovered.initialize();
    expect((recovered as unknown as { pending: QueuedTurn[] }).pending).toEqual([]);
    const repeated = await recovered.startTurn({ sessionId: f.sessionId, requestId: "repeat", idempotencyKey: "persisted-command", text: "Continue from the phone", origin: "mobile" });
    expect(repeated.state).toBe("cancelled");
    expect(f.host.send).toHaveBeenCalledOnce();
    expect(recovered.session(f.sessionId)?.desktopHandoff).toBeUndefined();
  } finally { await restored?.close(); await recovered?.close(); await f.close(); }
});

it("clears the reopen warning once the old Desktop executor is gone without requiring another launch", async () => {
  const f = await fixture(false);
  try {
    await f.send();
    await f.openDesktop();
    await f.observer.start();
    await f.complete();
    await f.broker.returnToDesktop(f.sessionId);
    expect(f.broker.session(f.sessionId)?.desktopHandoff?.state).toBe("reopen-desktop");
    await f.closeDesktop();
    expect(f.broker.session(f.sessionId)?.desktopHandoff).toBeUndefined();
    expect(f.eventLog.latestItem(f.sessionId, "session.desktop-handoff", f.sessionId)?.data.state).toBe("released");
  } finally { await f.close(); }
});

it("requires Desktop opened during Bridge work to close and start a fresh executor after release", async () => {
  const f = await fixture(false);
  try {
    await f.send();
    await f.openDesktop();
    await f.observer.start();
    await f.complete();
    await f.broker.returnToDesktop(f.sessionId);
    expect(f.broker.session(f.sessionId)).toMatchObject({ desktopHandoff: { state: "reopen-desktop" } });
    await f.observer.start();
    expect(f.broker.session(f.sessionId)).toMatchObject({ ownership: "BRIDGE_IDLE", desktopHandoff: { state: "reopen-desktop" } });
    await f.closeDesktop();
    await f.openDesktop(Date.now() + 1_000);
    await f.observer.start();
    expect(f.broker.session(f.sessionId)).toMatchObject({ ownership: "DESKTOP_OBSERVED" });
    expect(f.broker.session(f.sessionId)?.desktopHandoff).toBeUndefined();
  } finally { await f.close(); }
});

it("rechecks Desktop opened while the idle host is being configured, before submitting the command", async () => {
  const f = await fixture(false);
  try {
    f.host.setModel = async () => { await f.openDesktop(); await f.observer.start(); };
    await f.send();
    expect(f.host.send).not.toHaveBeenCalled();
    expect(f.queue).toMatchObject([{ state: "queued", attempts: 0 }]);
    expect(f.broker.session(f.sessionId)).toMatchObject({ desktopHandoff: { state: "close-desktop" } });
  } finally { await f.close(); }
});

it("keeps cancellation final when Desktop reopens and the idle Bridge host is still closing", async () => {
  const f = await fixture(false);
  let finishClose!: () => void;
  const closing = new Promise<void>(resolve => { finishClose = resolve; });
  let sending: Promise<unknown> | undefined;
  try {
    f.host.setModel = async () => { await f.openDesktop(); await f.observer.start(); };
    f.host.close.mockImplementation(async () => { await closing; });
    sending = f.send();
    await vi.waitFor(() => expect(f.host.close).toHaveBeenCalledOnce());
    const cancelling = f.broker.interruptTurn(f.sessionId, f.queue[0]!.commandId);
    await vi.waitFor(() => expect(f.queue).toEqual([]));
    finishClose();
    await Promise.all([sending, cancelling]);
    expect(f.queue).toEqual([]);
    expect(f.host.send).not.toHaveBeenCalled();
    expect(f.broker.session(f.sessionId)).toMatchObject({ pendingCount: 0, turnState: "idle" });
  } finally { finishClose(); await sending; await f.close(); }
});

it("finishes the handoff marker when force-cancelling a running Host", async () => {
  const f = await fixture(false);
  try {
    const receipt = await f.send();
    expect(f.eventLog.latestItem(f.sessionId, "session.desktop-handoff", f.sessionId)?.data.state).toBe("bridge");
    await f.broker.interruptTurn(f.sessionId, receipt.commandId, true);
    expect(f.host.close).toHaveBeenCalledOnce();
    expect(f.eventLog.latestItem(f.sessionId, "session.desktop-handoff", f.sessionId)?.data.state).toBe("released");
    expect(f.broker.session(f.sessionId)?.desktopHandoff).toBeUndefined();
  } finally { await f.close(); }
});

it("finishes startup recovery when a previously live orphan exits after initialization", async () => {
  const f = await fixture(false);
  let restored: SessionBroker | undefined;
  try {
    await f.broker.close();
    await f.eventLog.append({ sessionId: f.sessionId, itemId: f.sessionId, origin: "system", type: "session.desktop-handoff", data: { state: "bridge" } });
    f.scanSessionProcesses.mockResolvedValue([{ pid: 12345, startedAt: 1, processAlive: true, entrypoint: "claude-bridge", source: "process" }]);
    restored = new SessionBroker(f.options);
    await restored.initialize();
    expect(f.eventLog.latestItem(f.sessionId, "session.desktop-handoff", f.sessionId)?.data.state).toBe("bridge");
    f.scanSessionProcesses.mockResolvedValue([]);
    await f.observer.start();
    await vi.waitFor(() => expect(f.eventLog.latestItem(f.sessionId, "session.desktop-handoff", f.sessionId)?.data.state).toBe("released"));
    expect(restored.session(f.sessionId)?.desktopHandoff).toBeUndefined();
  } finally { await restored?.close(); await f.close(); }
});

it.each([0, Math.floor(Date.now() / 1000) * 1000])("recognizes a new PID after release without relying on start-time precision (%s)", async startedAt => {
  const f = await fixture(false);
  try {
    await f.eventLog.append({ sessionId: f.sessionId, itemId: f.sessionId, origin: "system", type: "session.desktop-handoff", data: {
      state: "released", desktopProcesses: [{ pid: 111111, startedAt }],
    } });
    const observed = f.observer.catalog.sessions.find(candidate => candidate.sessionId === f.sessionId)!;
    observed.desktopProcessAlive = true;
    observed.activeProcesses = [{ pid: 222222, startedAt, processAlive: true, entrypoint: "claude-desktop-3p", source: "process" }];
    expect(f.broker.session(f.sessionId)?.desktopHandoff).toBeUndefined();
    observed.activeProcesses[0]!.pid = 111111;
    expect(f.broker.session(f.sessionId)?.desktopHandoff?.state).toBe("reopen-desktop");
  } finally { await f.close(); }
});

it("blocks an unclassified live writer rather than starting a second executor", async () => {
  const f = await fixture(false);
  try {
    f.scanSessionProcesses.mockResolvedValue([{ pid: 12345, startedAt: 1, processAlive: true, entrypoint: "unknown", source: "process" }]);
    await f.send();
    expect(f.hostFactory).not.toHaveBeenCalled();
    expect(f.broker.session(f.sessionId)?.pendingCount).toBe(1);
  } finally { await f.close(); }
});

it("also blocks a Desktop executor found by the fresh scan before the catalog catches up", async () => {
  const f = await fixture(false);
  try {
    f.scanSessionProcesses.mockResolvedValue([{ pid: process.pid, startedAt: Date.now(), processAlive: true, entrypoint: "claude-desktop-3p", source: "process" }]);
    await f.send();
    expect(f.hostFactory).not.toHaveBeenCalled();
    expect(f.broker.session(f.sessionId)).toMatchObject({ desktopHandoff: { state: "close-desktop", canReturn: false } });
  } finally { await f.close(); }
});
