import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClaudeCatalogSnapshot, ObservedClaudeSession } from "./claude-session-catalog.js";
import { SessionBroker, type TranscriptObserverRuntime } from "./session-broker.js";
import { SessionEventLog } from "./session-event-log.js";

const directories: string[] = [];
const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  const fixtures = directories.splice(0);
  if (fixtures.length === 0) return;
  const recycle = process.platform === "darwin" ? "/usr/bin/trash" : process.platform === "linux" ? "trash-put" : undefined;
  if (recycle) execFileSync(recycle, fixtures);
});

const AGENT_STARTED_AT = Date.now() - 60_000;
const CLAUDE_FLAGS = ["--output-format", "stream-json", "--input-format", "stream-json"];

class FakeObserver extends EventEmitter implements TranscriptObserverRuntime {
  mainBusy = false;
  stopped: string[] = [];
  constructor(readonly catalog: ClaudeCatalogSnapshot) { super(); }
  isDesktopBusy() { return true; }
  isMainTurnBusy() { return this.mainBusy; }
  runningSubagents() { return { count: 1, lastUpdatedAt: AGENT_STARTED_AT }; }
  markSubagentStopped(agentId: string) { this.stopped.push(agentId); }
  applySubagentStops<T>(subagents: T): T { return subagents; }
  externalWriteVersion() { return 0; }
  async canStartBridgeHost() { return false; }
  onCatalog() { return () => undefined; }
}

function sessionProcess(flags: string[]): { child: ChildProcess; exited: Promise<NodeJS.Signals | null> } {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)", "--", ...flags], { stdio: "ignore" });
  children.push(child);
  return { child, exited: new Promise((resolve) => child.once("exit", (_code, signal) => resolve(signal))) };
}

async function harness() {
  const root = await mkdtemp(join(tmpdir(), "bridge-subagent-stop-"));
  directories.push(root);
  const sessionId = randomUUID();
  const cwd = join(root, "project");
  const paths = { sessions: join(root, "runtime-sessions"), tasks: join(root, "tasks"), projects: join(root, "projects"), desktopSessions: [] };
  const projectDir = join(paths.projects, cwd.replace(/[:\\/]/gu, "-"));
  const subagents = join(projectDir, sessionId, "subagents");
  await Promise.all([mkdir(cwd, { recursive: true }), mkdir(paths.sessions, { recursive: true }), mkdir(subagents, { recursive: true })]);
  await writeFile(join(projectDir, `${sessionId}.jsonl`), "");
  await writeFile(join(subagents, "agent-hung.meta.json"), JSON.stringify({ description: "Hung child" }));
  await writeFile(join(subagents, "agent-hung.jsonl"), `${JSON.stringify({
    type: "assistant", uuid: "child-tool", timestamp: new Date(AGENT_STARTED_AT).toISOString(),
    message: { role: "assistant", content: [{ type: "tool_use", id: "child-read", name: "Read", input: {} }] },
  })}\n`);
  const session = {
    sessionId, cwd, title: "Task", projectId: "project", projectName: "project", source: "desktop",
    ownership: "DESKTOP_OBSERVED", transport: "bridge-host", turnState: "idle", lastActivityAt: AGENT_STARTED_AT,
    pendingCount: 0, transcriptMtimeMs: 0, processAlive: true, desktopProcessAlive: true, bridgeProcessAlive: false,
    processOverlap: false, activeProcesses: [], activeTask: false,
  } as ObservedClaudeSession;
  const observer = new FakeObserver({ projects: [], sessions: [session], observedAt: Date.now() });
  const eventLog = new SessionEventLog(join(root, "events.jsonl"), 1);
  const broker = new SessionBroker({
    paths, eventLog, observer,
    sessionsPath: join(root, "sessions.json"), queuePath: join(root, "queue.json"),
    prepareRuntime: async () => ({ executablePath: "/fake/claude", credentialPath: "/fake/creds.json", environment: {}, version: "test" }),
  });
  await broker.initialize();
  const register = (pid: number, startedAt: number) => writeFile(join(paths.sessions, `${pid}.json`), JSON.stringify({
    pid, sessionId, cwd, startedAt, entrypoint: "claude-desktop-3p",
  }));
  return { broker, observer, eventLog, sessionId, register };
}

describe("SessionBroker.stopSubagent", () => {
  it("stops one task through a host Bridge holds, without touching any process", async () => {
    const { broker, observer, eventLog, sessionId } = await harness();
    const stopTask = vi.fn(async () => undefined);
    (broker as unknown as { runtimeStates: Map<string, unknown> }).runtimeStates.set(sessionId, {
      ownership: "BRIDGE_IDLE", turnState: "idle", host: { stopTask, close: async () => undefined },
    });
    const tasks = (broker as unknown as {taskState: import("./session-task-state.js").SessionTaskState}).taskState;
    tasks.beginGeneration(sessionId,"test-host");
    tasks.update(sessionId,"test-host",{taskId:"hung",description:"Hung child",state:"running",startedAt:AGENT_STARTED_AT,updatedAt:AGENT_STARTED_AT});
    await broker.stopSubagent(sessionId, "hung");
    expect(stopTask).toHaveBeenCalledWith("hung");
    expect(observer.stopped).toEqual([]);
    (broker as unknown as { runtimeStates: Map<string, unknown> }).runtimeStates.delete(sessionId);
    await broker.close();
    await eventLog.close();
  });

  it("ends only the process that launched the subagent", async () => {
    const { broker, observer, eventLog, sessionId, register } = await harness();
    const owner = sessionProcess(CLAUDE_FLAGS);
    const newer = sessionProcess(CLAUDE_FLAGS);
    await register(owner.child.pid!, AGENT_STARTED_AT - 1_000);
    await register(newer.child.pid!, AGENT_STARTED_AT + 1_000);
    await new Promise((resolve) => setTimeout(resolve, 100));

    await broker.stopSubagent(sessionId, "hung");

    expect(await owner.exited).toBe("SIGTERM");
    expect(newer.child.exitCode).toBeNull();
    expect(newer.child.signalCode).toBeNull();
    expect(observer.stopped).toEqual([]);
    await broker.close();
    await eventLog.close();
  });

  it("refuses to end the process while the main conversation is running", async () => {
    const { broker, observer, eventLog, sessionId, register } = await harness();
    const owner = sessionProcess(CLAUDE_FLAGS);
    await register(owner.child.pid!, AGENT_STARTED_AT - 1_000);
    observer.mainBusy = true;

    await expect(broker.stopSubagent(sessionId, "hung")).rejects.toThrow("主对话还在运行");

    expect(owner.child.signalCode).toBeNull();
    expect(observer.stopped).toEqual([]);
    await broker.close();
    await eventLog.close();
  });

  it("never signals a registered pid that is not a Claude process", async () => {
    const { broker, observer, eventLog, sessionId, register } = await harness();
    // Alive, but not a Claude process for this session: what a reused pid looks like.
    const unrelated = sessionProcess([]);
    await register(unrelated.child.pid!, AGENT_STARTED_AT - 1_000);

    await expect(broker.stopSubagent(sessionId, "hung")).rejects.toThrow("找不到运行这个子代理的 Claude 进程");

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(unrelated.child.signalCode).toBeNull();
    expect(observer.stopped).toEqual([]);
    await broker.close();
    await eventLog.close();
  });

  it("reports a subagent that has already ended", async () => {
    const { broker, eventLog, sessionId } = await harness();
    await expect(broker.stopSubagent(sessionId, "hung")).rejects.toThrow("这个子代理已经结束");
    await broker.close();
    await eventLog.close();
  });
});

describe("SessionBroker.interruptTurn for a Desktop-owned main turn", () => {
  it("asks only the newest Desktop process to stop, with the signal that records the interruption", async () => {
    const { broker, observer, eventLog, sessionId, register } = await harness();
    const older = sessionProcess(CLAUDE_FLAGS);
    const newest = sessionProcess(CLAUDE_FLAGS);
    await register(older.child.pid!, AGENT_STARTED_AT - 1_000);
    await register(newest.child.pid!, AGENT_STARTED_AT);
    await new Promise((resolve) => setTimeout(resolve, 100));
    observer.mainBusy = true;
    expect(broker.session(sessionId)?.mainTurnStopScope).toBe("process");

    await expect(broker.interruptTurn(sessionId, undefined, true)).resolves.toBe(true);

    expect(await newest.exited).toBe("SIGINT");
    expect(older.child.signalCode).toBeNull();
    await broker.close();
    await eventLog.close();
  });

  it("leaves the process alone once the main turn has ended", async () => {
    const { broker, eventLog, sessionId, register } = await harness();
    const owner = sessionProcess(CLAUDE_FLAGS);
    await register(owner.child.pid!, AGENT_STARTED_AT);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(broker.session(sessionId)?.mainTurnStopScope).toBeUndefined();

    await expect(broker.interruptTurn(sessionId, undefined, true)).resolves.toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(owner.child.signalCode).toBeNull();
    await broker.close();
    await eventLog.close();
  });

  it("never signals a reused pid or a process Bridge itself hosts", async () => {
    const { broker, observer, eventLog, sessionId, register } = await harness();
    const unrelated = sessionProcess([]);
    await register(unrelated.child.pid!, AGENT_STARTED_AT);
    observer.mainBusy = true;

    await expect(broker.interruptTurn(sessionId, undefined, true)).resolves.toBe(false);

    (broker as unknown as { runtimeStates: Map<string, unknown> }).runtimeStates.set(sessionId, {
      ownership: "BRIDGE_IDLE", turnState: "running", host: { close: async () => undefined },
    });
    const owner = sessionProcess(CLAUDE_FLAGS);
    await register(owner.child.pid!, AGENT_STARTED_AT + 1_000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(broker.session(sessionId)?.mainTurnStopScope).toBeUndefined();
    await expect(broker.interruptTurn(sessionId, undefined, true)).resolves.toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(unrelated.child.signalCode).toBeNull();
    expect(owner.child.signalCode).toBeNull();
    (broker as unknown as { runtimeStates: Map<string, unknown> }).runtimeStates.delete(sessionId);
    await broker.close();
    await eventLog.close();
  });

  it("does not stop the process for a specific command that is no longer queued", async () => {
    const { broker, observer, eventLog, sessionId, register } = await harness();
    const owner = sessionProcess(CLAUDE_FLAGS);
    await register(owner.child.pid!, AGENT_STARTED_AT);
    await new Promise((resolve) => setTimeout(resolve, 100));
    observer.mainBusy = true;

    await expect(broker.interruptTurn(sessionId, "finished-command", true)).resolves.toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(owner.child.signalCode).toBeNull();
    await broker.close();
    await eventLog.close();
  });
});
