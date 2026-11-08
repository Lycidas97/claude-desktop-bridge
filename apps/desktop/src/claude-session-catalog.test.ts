import { execFile, spawn, type ChildProcess } from "node:child_process";
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseWindowsClaudeProcessSessions, projectIdForCwd, scanClaudeCatalog, scanClaudeProcesses, scanClaudeSessionProcesses } from "./claude-session-catalog.js";
import { SessionBroker } from "./session-broker.js";
import { SessionEventLog } from "./session-event-log.js";
import { TranscriptObserver } from "./transcript-observer.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const inspect = vi.fn<typeof actual.execFile>().mockImplementation(actual.execFile);
  Object.defineProperty(inspect, (await import("node:util")).promisify.custom, {
    value: (...args: unknown[]) => new Promise((resolve, reject) => {
      (inspect as (...values: unknown[]) => ChildProcess)(...args, (error: Error | null, stdout: string, stderr: string) => {
        if (error) reject(error);
        else resolve({ stdout, stderr });
      });
    }),
  });
  return { ...actual, execFile: inspect };
});

const directories: string[] = [];
const children: ChildProcess[] = [];

function mockProcessTable(stdout: string): void {
  vi.mocked(execFile).mockImplementationOnce(((...args: unknown[]) => {
    (args.at(-1) as (error: null, stdout: string, stderr: string) => void)(null, stdout, "");
    return {} as ChildProcess;
  }) as typeof execFile);
}

function mockProcessRows(platform: "darwin" | "win32", rows: Array<{ pid: number; ppid: number; command: string; start?: string }>): void {
  mockProcessTable(platform === "win32" ? JSON.stringify(rows.map((row) => ({
    ProcessId: row.pid, ParentProcessId: row.ppid, Name: "claude.exe", CommandLine: row.command,
    CreationDate: new Date(Date.parse(`Thu Jan 1 ${row.start ?? "10:00:00"} 2026`)).toISOString(),
  }))) : rows.map((row) => `${row.pid} ${row.ppid} Thu Jan 1 ${row.start ?? "10:00:00"} 2026 ${row.command}`).join("\n"));
}

afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGTERM");
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  delete process.env.BRIDGE_DISABLE_PROCESS_SCAN;
});

describe("Claude session process catalog", () => {
  it.each(["darwin", "win32"] as const)("binds a registered initialize-time session without ID flags on %s", async (platform) => {
    const root = await mkdtemp(join(tmpdir(), "bridge-process-initialize-"));
    directories.push(root);
    const paths = { sessions: join(root, "sessions"), tasks: join(root, "tasks"), projects: join(root, "projects"), desktopSessions: [] };
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const startedAt = Date.parse("Thu Jan 1 10:00:00 2026");
    await mkdir(paths.sessions);
    await writeFile(join(paths.sessions, "700.json"), JSON.stringify({ pid: 700, sessionId, cwd: root, startedAt: startedAt + 456, entrypoint: "claude-desktop-3p", peerProtocol: 1 }));
    mockProcessRows(platform, [{ pid: 700, ppid: 1, command: "claude --input-format stream-json --output-format stream-json --await-initialize" }]);
    expect((await scanClaudeProcesses(paths, platform)).get(sessionId)).toEqual([
      expect.objectContaining({ pid: 700, processAlive: true, source: "process", entrypoint: "claude-desktop-3p", startedAt, registeredAt: startedAt + 456, peerProtocol: 1 }),
    ]);
  });

  it.each(["darwin", "win32"] as const)("does not invent an initialize-time session without a registration on %s", async (platform) => {
    const root = await mkdtemp(join(tmpdir(), "bridge-process-unregistered-initialize-"));
    directories.push(root);
    mockProcessRows(platform, [{ pid: 700, ppid: 1, command: "claude --input-format stream-json --output-format stream-json --await-initialize" }]);
    expect((await scanClaudeProcesses({ sessions: join(root, "sessions"), tasks: join(root, "tasks"), projects: join(root, "projects"), desktopSessions: [] }, platform)).size).toBe(0);
  });

  it.each([
    { platform: "darwin" as const, scenario: "reused PID" }, { platform: "win32" as const, scenario: "reused PID" },
    { platform: "darwin" as const, scenario: "unrelated process" }, { platform: "win32" as const, scenario: "unrelated process" },
    { platform: "darwin" as const, scenario: "another session" }, { platform: "win32" as const, scenario: "another session" },
  ])("rejects an initialize-time registration for $scenario on $platform", async ({ platform, scenario }) => {
    const root = await mkdtemp(join(tmpdir(), "bridge-process-initialize-identity-"));
    directories.push(root);
    const paths = { sessions: join(root, "sessions"), tasks: join(root, "tasks"), projects: join(root, "projects"), desktopSessions: [] };
    const sessionId = "11111111-1111-4111-8111-111111111111";
    await mkdir(paths.sessions);
    await writeFile(join(paths.sessions, "700.json"), JSON.stringify({ pid: 700, sessionId, cwd: root, startedAt: Date.parse("Thu Jan 1 10:00:00 2026") + 456, entrypoint: "claude-desktop-3p", peerProtocol: 1, messagingSocketPath: join(root, "stale.sock") }));
    mockProcessRows(platform, [{ pid: 700, ppid: 1, start: scenario === "reused PID" ? "10:01:00" : "10:00:00", command: scenario === "unrelated process" ? "node unrelated-worker.js" : `claude --input-format stream-json --output-format stream-json ${scenario === "another session" ? "--session-id 22222222-2222-4222-8222-222222222222" : "--await-initialize"}` }]);
    const sessions = await scanClaudeProcesses(paths, platform);
    expect(sessions.get(sessionId)?.filter(process => process.processAlive)).toEqual([]);
    for (const process of [...sessions.values()].flat().filter(process => process.processAlive)) {
      expect(process).not.toHaveProperty("messagingSocketPath");
      expect(process).not.toHaveProperty("peerProtocol");
    }
  });

  it("keeps background agents visible after an initialize-time native main turn ends", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-initialize-subagents-"));
    directories.push(root);
    const paths = { sessions: join(root, "sessions"), tasks: join(root, "tasks"), projects: join(root, "projects"), desktopSessions: [] };
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const processTable = [{ pid: 700, ppid: 1, command: "claude --input-format stream-json --output-format stream-json --await-initialize" }];
    await Promise.all([mkdir(paths.sessions), mkdir(paths.projects)]);
    await writeFile(join(paths.sessions, "700.json"), JSON.stringify({ pid: 700, sessionId, cwd: root, startedAt: Date.parse("Thu Jan 1 10:00:00 2026") + 456, entrypoint: "claude-desktop-3p" }));
    const transcript = join(paths.projects, sessionId + ".jsonl");
    const timestamp = new Date().toISOString();
    await writeFile(transcript, [
      { type: "assistant", uuid: "launch", sessionId, cwd: root, timestamp, message: { role: "assistant", content: [{ type: "tool_use", id: "child-tool", name: "Agent", input: { description: "Background review" } }] } },
      { type: "user", uuid: "launched", parentUuid: "launch", sessionId, timestamp, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "child-tool", content: "Async agent launched successfully.\nagentId: child" }] } },
      { type: "assistant", uuid: "waiting", parentUuid: "launched", sessionId, timestamp, message: { role: "assistant", content: "Waiting for background review", stop_reason: "end_turn" } },
    ].map(value => JSON.stringify(value)).join("\n") + "\n");
    const childDirectory = join(paths.projects, sessionId, "subagents");
    await mkdir(childDirectory, { recursive: true });
    await writeFile(join(childDirectory, "agent-child.meta.json"), JSON.stringify({ description: "Background review", toolUseId: "child-tool" }));
    await writeFile(join(childDirectory, "agent-child.jsonl"), JSON.stringify({ type: "assistant", timestamp, message: { role: "assistant", content: [{ type: "tool_use", id: "read", name: "Read", input: {} }], stop_reason: "tool_use" } }) + "\n");
    const log = new SessionEventLog(join(root, "events.jsonl"));
    const observer = new TranscriptObserver({ paths, eventLog: log, platform: "darwin", pollIntervalMs: 60_000, catalogIntervalMs: 0 });
    const hostFactory = vi.fn(() => { throw new Error("Native observation must not launch a model host"); });
    const broker = new SessionBroker({ paths, observer, eventLog: log, sessionsPath: join(root, "sessions.json"), queuePath: join(root, "queue.json"), hostFactory, discoverGatewayModels: async () => [], prepareRuntime: async () => ({ executablePath: "/fake/claude", credentialPath: "/fake/credentials.json", environment: {} }) });
    try {
      mockProcessRows("darwin", processTable);
      await observer.start(); await broker.initialize();
      expect(observer.isMainTurnBusy(sessionId)).toBe(false);
      expect(observer.runningSubagents(sessionId)).toEqual({ count: 1, lastUpdatedAt: Date.parse(timestamp) });
      expect(broker.session(sessionId)).toMatchObject({ turnState: "idle", runningSubagents: { count: 1 }, subagentStopScope: "process" });
      await appendFile(join(childDirectory, "agent-child.jsonl"), JSON.stringify({ type: "assistant", timestamp: new Date(Date.parse(timestamp) + 1000).toISOString(), message: { role: "assistant", content: [{ type: "text", text: "Completed review" }], stop_reason: "end_turn" } }) + "\n");
      await utimes(join(childDirectory, "agent-child.jsonl"), new Date(), new Date(Date.parse(timestamp) + 2000));
      mockProcessRows("darwin", processTable);
      await (observer as unknown as { poll(): Promise<void> }).poll();
      expect(observer.runningSubagents(sessionId)).toBeUndefined();
      expect(broker.session(sessionId)?.turnState).toBe("idle");
      expect(broker.session(sessionId)?.runningSubagents).toBeUndefined();
      expect(hostFactory).not.toHaveBeenCalled();
    } finally { await broker.close(); await observer.close(); await log.close(); }
  });

  it.each(["darwin", "win32"] as const)("binds a verified fork executor to its registered child on %s", async (platform) => {
    const root = await mkdtemp(join(tmpdir(), "bridge-process-fork-"));
    directories.push(root);
    const paths = { sessions: join(root, "sessions"), tasks: join(root, "tasks"), projects: join(root, "projects"), desktopSessions: [] };
    const parent = "11111111-1111-4111-8111-111111111111", child = "22222222-2222-4222-8222-222222222222";
    const startedAt = Date.parse("Thu Jan 1 10:00:00 2026"), messagingSocketPath = join(root, "child.sock");
    await mkdir(paths.sessions);
    await writeFile(join(paths.sessions, "700.json"), JSON.stringify({ pid: 700, sessionId: child, cwd: root, startedAt: startedAt + 456, entrypoint: "claude-desktop-3p", peerProtocol: 1, messagingSocketPath }));
    mockProcessRows(platform, [{ pid: 700, ppid: 1, command: `claude --input-format stream-json --output-format stream-json --resume ${parent} --fork-session` }]);

    const sessions = await scanClaudeProcesses(paths, platform);
    expect(sessions.get(child)).toEqual([expect.objectContaining({ pid: 700, processAlive: true, source: "process", entrypoint: "claude-desktop-3p", cwd: root, startedAt, registeredAt: startedAt + 456, peerProtocol: 1, messagingSocketPath })]);
    expect(sessions.get(parent)).toBeUndefined();
  });

  it.each(["darwin", "win32"] as const)("does not attribute an unregistered fork to its resumed parent on %s", async (platform) => {
    const root = await mkdtemp(join(tmpdir(), "bridge-process-unregistered-fork-"));
    directories.push(root);
    const parent = "11111111-1111-4111-8111-111111111111";
    mockProcessRows(platform, [{ pid: 700, ppid: 1, command: `claude --input-format stream-json --output-format stream-json --resume=${parent} --fork-session` }]);
    expect((await scanClaudeProcesses({ sessions: join(root, "sessions"), tasks: join(root, "tasks"), projects: join(root, "projects"), desktopSessions: [] }, platform)).get(parent)).toBeUndefined();
  });

  it.each([
    { platform: "darwin" as const, explicitFirst: false }, { platform: "darwin" as const, explicitFirst: true },
    { platform: "win32" as const, explicitFirst: false }, { platform: "win32" as const, explicitFirst: true },
  ])("prefers an explicit fork session ID on $platform with explicitFirst=$explicitFirst", async ({ platform, explicitFirst }) => {
    const root = await mkdtemp(join(tmpdir(), "bridge-process-explicit-fork-"));
    directories.push(root);
    const parent = "11111111-1111-4111-8111-111111111111", child = "22222222-2222-4222-8222-222222222222";
    const flags = explicitFirst ? `--session-id ${child} --resume ${parent} --fork-session` : `--resume ${parent} --fork-session --session-id ${child}`;
    mockProcessRows(platform, [{ pid: 700, ppid: 1, command: `claude --input-format stream-json --output-format stream-json ${flags}` }]);
    const sessions = await scanClaudeProcesses({ sessions: join(root, "sessions"), tasks: join(root, "tasks"), projects: join(root, "projects"), desktopSessions: [] }, platform);
    expect(sessions.get(child)).toEqual([expect.objectContaining({ pid: 700, processAlive: true })]);
    expect(sessions.get(parent)).toBeUndefined();
  });

  it.each([
    { platform: "darwin" as const, scenario: "reused PID" }, { platform: "win32" as const, scenario: "reused PID" },
    { platform: "darwin" as const, scenario: "stale parent registration" }, { platform: "win32" as const, scenario: "stale parent registration" },
    { platform: "darwin" as const, scenario: "different non-fork session" }, { platform: "win32" as const, scenario: "different non-fork session" },
  ])("rejects fork identity transfer for $scenario on $platform", async ({ platform, scenario }) => {
    const root = await mkdtemp(join(tmpdir(), "bridge-process-fork-identity-"));
    directories.push(root);
    const paths = { sessions: join(root, "sessions"), tasks: join(root, "tasks"), projects: join(root, "projects"), desktopSessions: [] };
    const parent = "11111111-1111-4111-8111-111111111111", child = "22222222-2222-4222-8222-222222222222";
    const sessionId = scenario === "stale parent registration" ? parent : child;
    const messagingSocketPath = join(root, "stale.sock");
    await mkdir(paths.sessions);
    await writeFile(join(paths.sessions, "700.json"), JSON.stringify({ pid: 700, sessionId, cwd: root, startedAt: Date.parse("Thu Jan 1 10:00:00 2026") + 456, entrypoint: "claude-desktop-3p", peerProtocol: 1, messagingSocketPath }));
    mockProcessRows(platform, [{ pid: 700, ppid: 1, start: scenario === "reused PID" ? "10:01:00" : "10:00:00", command: `claude --input-format stream-json --output-format stream-json --resume ${parent}${scenario === "different non-fork session" ? "" : " --fork-session"}` }]);
    const sessions = await scanClaudeProcesses(paths, platform);
    expect(sessions.get(sessionId)?.filter((process) => process.processAlive)).toEqual([]);
    for (const process of [...sessions.values()].flat().filter((process) => process.processAlive)) expect(process).not.toHaveProperty("messagingSocketPath");
    if (scenario !== "different non-fork session") expect(sessions.get(parent)?.filter((process) => process.processAlive) ?? []).toEqual([]);
  });

  it.each(["darwin", "win32"] as const)("keeps the real parent and two verified fork executors separate on %s", async (platform) => {
    const root = await mkdtemp(join(tmpdir(), "bridge-process-fork-siblings-"));
    directories.push(root);
    const paths = { sessions: join(root, "sessions"), tasks: join(root, "tasks"), projects: join(root, "projects"), desktopSessions: [] };
    const parent = "11111111-1111-4111-8111-111111111111", children = ["22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"];
    await mkdir(paths.sessions);
    for (const [index, sessionId] of children.entries()) await writeFile(join(paths.sessions, `${700 + index}.json`), JSON.stringify({ pid: 700 + index, sessionId, cwd: root, startedAt: Date.parse("Thu Jan 1 10:00:00 2026") + 456, entrypoint: "claude-desktop-3p", peerProtocol: 1, messagingSocketPath: join(root, `${index}.sock`) }));
    mockProcessRows(platform, [{ pid: 600, ppid: 1, command: `claude --input-format stream-json --output-format stream-json --session-id ${parent}` }, ...children.map((_, index) => ({ pid: 700 + index, ppid: 1, command: `claude --input-format stream-json --output-format stream-json --resume ${parent} --fork-session` }))]);
    const sessions = await scanClaudeProcesses(paths, platform);
    expect(sessions.get(parent)?.map((process) => process.pid)).toEqual([600]);
    for (const [index, child] of children.entries()) expect(sessions.get(child)).toEqual([expect.objectContaining({ pid: 700 + index, processAlive: true, entrypoint: "claude-desktop-3p" })]);
  });

  it("publishes fork main-turn status through the observer and Broker while keeping the original owner", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-fork-status-"));
    directories.push(root);
    const paths = { sessions: join(root, "sessions"), tasks: join(root, "tasks"), projects: join(root, "projects"), desktopSessions: [] };
    const parent = "11111111-1111-4111-8111-111111111111", child = "22222222-2222-4222-8222-222222222222";
    const processTable = [{ pid: 700, ppid: 1, command: `claude --input-format stream-json --output-format stream-json --resume ${parent} --fork-session` }];
    await Promise.all([mkdir(paths.sessions), mkdir(paths.projects)]);
    await writeFile(join(paths.sessions, "700.json"), JSON.stringify({ pid: 700, sessionId: child, cwd: root, startedAt: Date.parse("Thu Jan 1 10:00:00 2026") + 456, entrypoint: "claude-desktop-3p", peerProtocol: 1, messagingSocketPath: join(root, "child.sock") }));
    const transcript = join(paths.projects, child + ".jsonl");
    const transcriptTime = Date.now();
    await writeFile(transcript, JSON.stringify({ type: "user", uuid: "fork-user", sessionId: child, cwd: root, message: { role: "user", content: "Continue the fork" } }) + "\n");
    const log = new SessionEventLog(join(root, "events.jsonl"), 1);
    const observer = new TranscriptObserver({ paths, eventLog: log, platform: "darwin", pollIntervalMs: 60_000, catalogIntervalMs: 0 });
    const hostFactory = vi.fn(() => { throw new Error("The original fork executor must remain the sole owner"); });
    const broker = new SessionBroker({ paths, observer, eventLog: log, sessionsPath: join(root, "sessions.json"), queuePath: join(root, "queue.json"), hostFactory, discoverGatewayModels: async () => [], prepareRuntime: async () => ({ executablePath: "/fake/claude", credentialPath: "/fake/credentials.json", environment: {} }) });
    try {
      mockProcessRows("darwin", processTable);
      await observer.start(); await broker.initialize();
      expect(observer.isMainTurnBusy(child)).toBe(true);
      expect(broker.session(child)?.turnState).toBe("running");
      expect(broker.session(parent)?.turnState ?? "idle").toBe("idle");
      expect(await observer.canStartBridgeHost(child)).toBe(false);
      await appendFile(transcript, JSON.stringify({ type: "assistant", uuid: "fork-done", parentUuid: "fork-user", sessionId: child, message: { role: "assistant", content: "Done", stop_reason: "end_turn" } }) + "\n");
      await utimes(transcript, new Date(), new Date(transcriptTime + 1_000));
      mockProcessRows("darwin", processTable); await (observer as unknown as { poll(): Promise<void> }).poll();
      expect(broker.session(child)?.turnState).toBe("idle");
      expect(await observer.canStartBridgeHost(child)).toBe(false);
      await appendFile(transcript, JSON.stringify({ type: "user", uuid: "fork-next", parentUuid: "fork-done", sessionId: child, message: { role: "user", content: "Next main turn" } }) + "\n");
      await utimes(transcript, new Date(), new Date(transcriptTime + 2_000));
      mockProcessRows("darwin", processTable); await (observer as unknown as { poll(): Promise<void> }).poll();
      expect(broker.session(child)?.turnState).toBe("running");
      expect(observer.session(child)?.activeProcesses.filter((process) => process.processAlive)).toEqual([expect.objectContaining({ pid: 700, peerProtocol: 1 })]);
      expect(hostFactory).not.toHaveBeenCalled();
    } finally { await broker.close(); await observer.close(); await log.close(); }
  });

  it.each(["claude-bridge", "claude-desktop-3p"])("restores verified %s registration after its executor is reparented", async (entrypoint) => {
    const root = await mkdtemp(join(tmpdir(), "bridge-process-orphan-"));
    directories.push(root);
    const paths = { sessions: join(root, "sessions"), tasks: join(root, "tasks"), projects: join(root, "projects"), desktopSessions: [] };
    const sessionId = "66666666-6666-4666-8666-666666666666";
    const startedAt = Date.parse("Thu Jan 1 10:00:00 2026");
    await mkdir(paths.sessions);
    await writeFile(join(paths.sessions, "orphan.json"), JSON.stringify({
      pid: process.pid, sessionId, cwd: root, startedAt: startedAt + 456, entrypoint, peerProtocol: "agent-sdk",
    }));
    mockProcessTable(`${process.pid} 1 Thu Jan 1 10:00:00 2026 claude --input-format stream-json --output-format stream-json --session-id ${sessionId}\n`);

    const catalog = await scanClaudeCatalog(paths, "darwin");
    expect(catalog.sessions[0]).toMatchObject({
      sessionId,
      desktopProcessAlive: entrypoint === "claude-desktop-3p",
      bridgeProcessAlive: entrypoint === "claude-bridge",
      activeProcesses: [{ pid: process.pid, entrypoint, cwd: root, peerProtocol: "agent-sdk", source: "process", processAlive: true }],
    });
  });

  it.each([1, "agent-sdk"])("inherits protocol %s and the inbox socket only after matching registration identity", async (peerProtocol) => {
    const root = await mkdtemp(join(tmpdir(), "bridge-process-inbox-"));
    directories.push(root);
    const paths = { sessions: join(root, "sessions"), tasks: join(root, "tasks"), projects: join(root, "projects"), desktopSessions: [] };
    const sessionId = "66666666-6666-4666-8666-666666666666";
    const messagingSocketPath = join(root, "executor.sock");
    await mkdir(paths.sessions);
    await writeFile(join(paths.sessions, "executor.json"), JSON.stringify({
      pid: process.pid, sessionId, cwd: root, startedAt: Date.parse("Thu Jan 1 10:00:00 2026") + 456,
      entrypoint: "claude-desktop-3p", peerProtocol, messagingSocketPath,
    }));
    mockProcessTable(`${process.pid} 1 Thu Jan 1 10:00:00 2026 claude --input-format stream-json --output-format stream-json --session-id ${sessionId}\n`);

    const catalog = await scanClaudeCatalog(paths, "darwin");
    expect(catalog.sessions[0]?.activeProcesses).toEqual([
      expect.objectContaining({ pid: process.pid, source: "process", processAlive: true, peerProtocol, messagingSocketPath }),
    ]);
    expect(catalog.sessions[0]).not.toHaveProperty("messagingSocketPath");
    expect(catalog.sessions[0]).not.toHaveProperty("peerProtocol");
  });

  it.each([
    { name: "unrelated command", command: "node unrelated-worker.js", processStart: "10:01:00", live: false },
    { name: "different native session", command: "claude --input-format stream-json --output-format stream-json --session-id 88888888-8888-4888-8888-888888888888", processStart: "10:01:00", live: false },
    { name: "new executor for the same native session", command: "claude --input-format stream-json --output-format stream-json --session-id 77777777-7777-4777-8777-777777777777", processStart: "10:01:00", live: true },
  ])("rejects a stale Desktop registration when its PID belongs to $name", async ({ command, processStart, live }) => {
    const root = await mkdtemp(join(tmpdir(), "bridge-process-reused-pid-"));
    directories.push(root);
    const paths = { sessions: join(root, "sessions"), tasks: join(root, "tasks"), projects: join(root, "projects"), desktopSessions: [] };
    const sessionId = "77777777-7777-4777-8777-777777777777";
    await mkdir(paths.sessions);
    await writeFile(join(paths.sessions, "stale-desktop.json"), JSON.stringify({
      pid: process.pid, sessionId, cwd: root, startedAt: Date.parse("Thu Jan 1 10:00:00 2026") + 456, entrypoint: "claude-desktop-3p",
      peerProtocol: 1, messagingSocketPath: join(root, "stale.sock"),
    }));
    mockProcessTable(`${process.pid} 1 Thu Jan 1 ${processStart} 2026 ${command}\n`);

    const catalog = await scanClaudeCatalog(paths, "darwin");
    expect(catalog.sessions[0]).toMatchObject({ sessionId, processAlive: live, desktopProcessAlive: false });
    expect(catalog.sessions[0]?.activeProcesses.filter((candidate) => candidate.processAlive && candidate.entrypoint.startsWith("claude-desktop"))).toEqual([]);
    for (const candidate of catalog.sessions.flatMap((session) => session.activeProcesses).filter((candidate) => candidate.processAlive)) {
      expect(candidate).not.toHaveProperty("messagingSocketPath");
      expect(candidate).not.toHaveProperty("peerProtocol");
    }
  });

  it("keeps macOS start precision and a verified registration timestamp separately", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-process-precision-"));
    directories.push(root);
    const paths = { sessions: join(root, "sessions"), tasks: join(root, "tasks"), projects: join(root, "projects"), desktopSessions: [] };
    const sessionId = "99999999-9999-4999-8999-999999999999";
    const startedAt = Date.parse("Thu Jan 1 10:00:00 2026");
    await mkdir(paths.sessions);
    await writeFile(join(paths.sessions, "executor.json"), JSON.stringify({
      pid: process.pid, sessionId, cwd: root, startedAt: startedAt + 456, entrypoint: "claude-desktop-3p",
    }));
    mockProcessTable(`${process.pid} 1 Thu Jan 1 10:00:00 2026 claude --input-format stream-json --output-format stream-json --session-id ${sessionId}\n`);

    expect(await scanClaudeSessionProcesses(paths, sessionId, "darwin")).toEqual([
      expect.objectContaining({ startedAt, startedAtResolutionMs: 1_000, registeredAt: startedAt + 456 }),
    ]);
  });

  it("reads Windows CreationDate and retains unknown start times explicitly", () => {
    const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const command = `claude.exe --input-format stream-json --output-format stream-json --session-id ${sessionId}`;
    expect(parseWindowsClaudeProcessSessions(JSON.stringify([
      { ProcessId: 500, ParentProcessId: 1, Name: "claude.exe", CommandLine: command, CreationDate: "2026-01-01T10:00:00.123Z" },
      { ProcessId: 501, ParentProcessId: 1, Name: "claude.exe", CommandLine: command },
    ])).get(sessionId)).toEqual([
      expect.objectContaining({ pid: 500, startedAt: Date.parse("2026-01-01T10:00:00.123Z"), startedAtResolutionMs: 1 }),
      expect.objectContaining({ pid: 501, startedAt: 0 }),
    ]);
  });

  it("scans all Windows session identities once and binds a verified orphan registration", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-process-batch-"));
    directories.push(root);
    const paths = { sessions: join(root, "sessions"), tasks: join(root, "tasks"), projects: join(root, "projects"), desktopSessions: [] };
    const sessionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const otherSessionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const startedAt = Date.parse("2026-01-01T10:00:00.123Z");
    await mkdir(paths.sessions);
    await writeFile(join(paths.sessions, "windows-orphan.json"), JSON.stringify({
      pid: 500, sessionId, cwd: root, startedAt: startedAt + 50, entrypoint: "claude-bridge", peerProtocol: "agent-sdk",
    }));
    mockProcessTable(JSON.stringify([
      { ProcessId: 500, ParentProcessId: 1, Name: "claude.exe", CommandLine: `claude.exe --input-format stream-json --output-format stream-json --session-id ${sessionId}`, CreationDate: "2026-01-01T10:00:00.123Z" },
      { ProcessId: 501, ParentProcessId: 1, Name: "claude.exe", CommandLine: `claude.exe --input-format stream-json --output-format stream-json --session-id ${otherSessionId}`, CreationDate: "2026-01-01T10:00:01.456Z" },
    ]));
    const callsBefore = vi.mocked(execFile).mock.calls.length;

    const sessions = await scanClaudeProcesses(paths, "win32");
    expect(sessions.size).toBe(2);
    expect(sessions.get(sessionId)).toEqual([expect.objectContaining({ pid: 500, startedAt, startedAtResolutionMs: 1, registeredAt: startedAt + 50, entrypoint: "claude-bridge", cwd: root })]);
    expect(sessions.get(otherSessionId)).toEqual([expect.objectContaining({ pid: 501, startedAt: startedAt + 1_333, startedAtResolutionMs: 1, entrypoint: "unknown" })]);
    expect(vi.mocked(execFile).mock.calls).toHaveLength(callsBefore + 1);
    expect(vi.mocked(execFile).mock.lastCall?.[1]).toEqual(expect.arrayContaining([expect.stringContaining("CreationDate")]));
  });

  it.skipIf(process.platform !== "darwin").each([false, true])("reads the actual macOS executor start time with registration present=%s", async (registered) => {
    const root = await mkdtemp(join(tmpdir(), "bridge-process-start-"));
    directories.push(root);
    const sessionId = "55555555-5555-4555-8555-555555555555";
    const before = Date.now() - 1_000;
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", "--input-format", "stream-json", "--output-format", "stream-json", "--session-id", sessionId]);
    children.push(child);
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    const sessions = join(root, "sessions");
    await mkdir(sessions);
    if (registered) await writeFile(join(sessions, "executor.json"), JSON.stringify({ pid: child.pid, sessionId, cwd: root, startedAt: 1, entrypoint: "claude-desktop-3p" }));
    const processes = await scanClaudeSessionProcesses({ sessions, tasks: join(root, "tasks"), projects: join(root, "projects"), desktopSessions: [] }, sessionId, "darwin");
    const live = processes.filter((candidate) => candidate.processAlive);
    expect(live).toHaveLength(1);
    expect(live[0]?.startedAt).toBeGreaterThanOrEqual(before);
    expect(live[0]?.startedAt).toBeLessThanOrEqual(Date.now());
    expect(live[0]?.startedAtResolutionMs).toBe(1_000);
    if (registered) expect(processes.find((candidate) => candidate.source === "registration")?.processAlive).toBe(false);
  });

  it("treats Windows path casing as the same project", () => {
    expect(projectIdForCwd("C:\\Work\\Bridge", "win32"))
      .toBe(projectIdForCwd("c:\\work\\bridge", "win32"));
  });

  it("discovers Windows Claude Code writers and preserves their Desktop ancestry", () => {
    const sessionId = "33333333-3333-4333-8333-333333333333";
    const output = JSON.stringify([
      {
        ProcessId: 500,
        ParentProcessId: 400,
        Name: "claude.exe",
        CommandLine: `claude.exe --output-format stream-json --input-format stream-json --session-id ${sessionId}`,
      },
      {
        ProcessId: 400,
        ParentProcessId: 1,
        Name: "Claude.exe",
        CommandLine: "C:\\Users\\me\\AppData\\Local\\Programs\\Claude\\Claude.exe",
      },
    ]);

    expect(parseWindowsClaudeProcessSessions(output).get(sessionId)).toEqual([
      expect.objectContaining({
        pid: 500,
        entrypoint: "claude-desktop-3p",
        processAlive: true,
      }),
    ]);
  });

  it("accepts quoted Windows session arguments emitted by process inspection", () => {
    const sessionId = "44444444-4444-4444-8444-444444444444";
    const output = JSON.stringify([{
      ProcessId: 501,
      ParentProcessId: 1,
      Name: "claude.exe",
      CommandLine: `claude.exe --output-format=\"stream-json\" --input-format=\"stream-json\" --resume=\"${sessionId}\"`,
    }]);

    expect(parseWindowsClaudeProcessSessions(output).get(sessionId)).toEqual([
      expect.objectContaining({ pid: 501, entrypoint: "unknown" }),
    ]);
  });

  it("retains every live process registered for the same session without calling overlap a write conflict", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-session-catalog-"));
    directories.push(root);
    const sessions = join(root, "sessions");
    const desktopSessions = join(root, "desktop-sessions");
    const project = join(root, "project");
    const sessionId = "11111111-1111-4111-8111-111111111111";
    await Promise.all([mkdir(sessions), mkdir(desktopSessions), mkdir(project)]);
    const desktopProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
    const bridgeProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
    children.push(desktopProcess, bridgeProcess);
    if (!desktopProcess.pid || !bridgeProcess.pid) throw new Error("Test process failed to start");
    await Promise.all([
      writeFile(join(sessions, "desktop.json"), JSON.stringify({
        pid: desktopProcess.pid,
        sessionId,
        cwd: project,
        startedAt: 1,
        entrypoint: "claude-desktop-3p",
        peerProtocol: "stream-json",
      })),
      writeFile(join(sessions, "bridge.json"), JSON.stringify({
        pid: bridgeProcess.pid,
        sessionId,
        cwd: project,
        startedAt: 2,
        entrypoint: "claude-bridge",
        peerProtocol: "agent-sdk",
      })),
      writeFile(join(desktopSessions, "desktop-session.json"), JSON.stringify({
        sessionId: "local-1",
        cliSessionId: sessionId,
        cwd: project,
        lastFocusedAt: 1,
      })),
    ]);
    process.env.BRIDGE_DISABLE_PROCESS_SCAN = "1";

    const catalog = await scanClaudeCatalog({
      sessions,
      tasks: join(root, "tasks"),
      projects: join(root, "projects"),
      desktopSessions: [desktopSessions],
    });
    expect(catalog.sessions[0]).toMatchObject({
      sessionId,
      processAlive: true,
      desktopProcessAlive: true,
      bridgeProcessAlive: true,
      processOverlap: true,
    });
    expect(catalog.sessions[0]?.activeProcesses).toEqual(expect.arrayContaining([
      expect.objectContaining({ pid: desktopProcess.pid, entrypoint: "claude-desktop-3p" }),
      expect.objectContaining({ pid: bridgeProcess.pid, entrypoint: "claude-bridge" }),
    ]));
    expect(catalog.sessions[0]?.activeProcesses).toHaveLength(2);
  });

  it("carries only sanitized Desktop profile provenance and ultracode into the internal catalog", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-session-profile-catalog-"));
    directories.push(root);
    const desktopSessions = join(root, "Application Support", "Claude", "claude-code-sessions");
    const project = join(root, "project");
    const sessionId = "22222222-2222-4222-8222-222222222222";
    await Promise.all([mkdir(desktopSessions, { recursive: true }), mkdir(project)]);
    await writeFile(join(desktopSessions, "local_profile.json"), JSON.stringify({
      sessionId: "local-profile",
      cliSessionId: sessionId,
      cwd: project,
      lastFocusedAt: 10,
      model: "claude-opus-5",
      sessionSettings: { ultracode: true },
    }));
    process.env.BRIDGE_DISABLE_PROCESS_SCAN = "1";

    const catalog = await scanClaudeCatalog({
      sessions: join(root, "sessions"),
      tasks: join(root, "tasks"),
      projects: join(root, "projects"),
      desktopSessions: [desktopSessions],
    });
    expect(catalog.sessions[0]).toMatchObject({
      sessionId,
      sourceProfile: "claude",
      hostUltracode: true,
      hostModel: "claude-opus-5",
    });
    expect(JSON.stringify(catalog.sessions[0])).not.toContain(desktopSessions);
  });

  it("excludes archived Desktop sessions and archived-sessions.idx entries while exposing /btw side chats", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-session-archived-catalog-"));
    directories.push(root);
    const sessions = join(root, "sessions");
    const desktopSessions = join(root, "desktop-sessions");
    const project = join(root, "project");
    const activeParentId = "10000000-0000-4000-8000-000000000001";
    const archivedFlagId = "10000000-0000-4000-8000-000000000002";
    const archivedIdxId = "10000000-0000-4000-8000-000000000003";
    const childOfArchivedId = "10000000-0000-4000-8000-000000000004";
    const btwChildId = "10000000-0000-4000-8000-000000000005";
    const archivedBtwChildId = "10000000-0000-4000-8000-000000000006";
    await Promise.all([mkdir(sessions, { recursive: true }), mkdir(desktopSessions, { recursive: true }), mkdir(project, { recursive: true })]);
    await Promise.all([
      writeFile(join(desktopSessions, "archived-sessions.idx"), JSON.stringify({
        v: 1,
        archived: [`local_${archivedIdxId}`],
      })),
      writeFile(join(desktopSessions, `local_${activeParentId}.json`), JSON.stringify({
        sessionId: `local_${activeParentId}`,
        cliSessionId: activeParentId,
        cwd: project,
        title: "Active Parent",
        lastFocusedAt: 100,
        isArchived: false,
      })),
      writeFile(join(desktopSessions, `local_${archivedFlagId}.json`), JSON.stringify({
        sessionId: `local_${archivedFlagId}`,
        cliSessionId: archivedFlagId,
        cwd: project,
        title: "Archived By Flag",
        lastFocusedAt: 90,
        isArchived: true,
      })),
      writeFile(join(desktopSessions, `local_${archivedIdxId}.json`), JSON.stringify({
        sessionId: `local_${archivedIdxId}`,
        cliSessionId: archivedIdxId,
        cwd: project,
        title: "Archived By Index",
        lastFocusedAt: 80,
        isArchived: false,
      })),
      writeFile(join(desktopSessions, `local_${childOfArchivedId}.json`), JSON.stringify({
        sessionId: `local_${childOfArchivedId}`,
        cliSessionId: childOfArchivedId,
        cwd: project,
        title: "Child Of Archived",
        lastFocusedAt: 70,
        isArchived: false,
        forkedFromSessionId: `local_${archivedFlagId}`,
      })),
      writeFile(join(desktopSessions, `local_${btwChildId}.json`), JSON.stringify({
        sessionId: `local_${btwChildId}`,
        cliSessionId: btwChildId,
        cwd: project,
        title: "Side Question",
        lastFocusedAt: 60,
        isArchived: false,
        spawnedFrom: {
          sessionId: `local_${activeParentId}`,
          btw: true,
          sideSession: true,
          name: "fork-4",
        },
      })),
      writeFile(join(desktopSessions, `local_${archivedBtwChildId}.json`), JSON.stringify({
        sessionId: `local_${archivedBtwChildId}`,
        cliSessionId: archivedBtwChildId,
        cwd: project,
        title: "Archived Side Question",
        lastFocusedAt: 50,
        isArchived: true,
        spawnedFrom: {
          sessionId: `local_${activeParentId}`,
          btw: true,
          sideSession: true,
        },
      })),
      writeFile(join(sessions, "archived-process.json"), JSON.stringify({
        pid: 999999,
        sessionId: archivedFlagId,
        cwd: project,
        startedAt: 95,
        entrypoint: "claude-desktop-3p",
      })),
    ]);
    process.env.BRIDGE_DISABLE_PROCESS_SCAN = "1";

    const catalog = await scanClaudeCatalog({
      sessions,
      tasks: join(root, "tasks"),
      projects: join(root, "projects"),
      desktopSessions: [desktopSessions],
    });
    expect(catalog.sessions.map((session) => session.sessionId)).toEqual([activeParentId, childOfArchivedId, btwChildId]);
    expect(catalog.sessions.find((session) => session.sessionId === btwChildId)).toMatchObject({
      parentSessionId: activeParentId,
      forkLabel: "fork-4",
      sidechat: true,
      title: "Side Question",
    });
    expect(catalog.archivedSessions?.find((session) => session.sessionId === archivedBtwChildId)).toMatchObject({
      parentSessionId: activeParentId,
      forkLabel: "btw",
      sidechat: true,
      title: "Archived Side Question",
    });
    expect(catalog.archivedSessionIds?.has(childOfArchivedId)).toBe(false);
    expect(catalog.archivedSessionIds?.has(btwChildId)).toBe(false);
    expect([...(catalog.archivedSessionIds ?? [])]).toEqual(expect.arrayContaining([
      archivedFlagId,
      archivedIdxId,
      archivedBtwChildId,
    ]));
  });
});
