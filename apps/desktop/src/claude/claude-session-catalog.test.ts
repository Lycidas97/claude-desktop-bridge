import { execFile, spawn, type ChildProcess } from "node:child_process";
import { rm, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findClaudeSessionTranscript, projectIdForCwd, scanClaudeCatalog } from "./claude-session-catalog.js";

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

afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGTERM");
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  delete process.env.BRIDGE_DISABLE_PROCESS_SCAN;
});

describe("Claude session process catalog", () => {
  it("resolves the selected fork transcript using its own process registration", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-fork-transcript-"));
    directories.push(root);
    const desktop = join(root, "desktop");
    const profile = join(desktop, "profile", "account");
    const paths = { sessions: join(root, "sessions"), tasks: join(root, "tasks"), projects: join(root, "projects"), desktopSessions: [desktop] };
    const parent = "11111111-1111-4111-8111-111111111111";
    const child = "22222222-2222-4222-8222-222222222222";
    const parentId = `local_${parent}`;
    const childId = `local_${child}`;
    const parentTranscript = join(paths.projects, `${parent}.jsonl`);
    const childTranscript = join(paths.projects, `${child}.jsonl`);
    const startedAt = Date.parse("Thu Jan 1 10:00:00 2026");
    await Promise.all([mkdir(profile, { recursive: true }), mkdir(paths.projects), mkdir(paths.sessions)]);
    await Promise.all([
      writeFile(join(profile, `${parentId}.json`), JSON.stringify({ sessionId: parentId, cliSessionId: parent, cwd: root })),
      writeFile(join(profile, "fork-record.json"), JSON.stringify({ sessionId: childId, cliSessionId: child, cwd: root, forkedFromSessionId: parentId })),
      writeFile(join(paths.sessions, "fork-writer.json"), JSON.stringify({ pid: 500, sessionId: child, cwd: root, startedAt: startedAt + 100 })),
      writeFile(parentTranscript, ""),
      writeFile(childTranscript, ""),
    ]);
    const processRow = `500 1 Thu Jan 1 10:00:00 2026 claude --input-format stream-json --output-format stream-json --resume ${parent} --fork-session\n`;
    mockProcessTable(processRow);
    expect(await findClaudeSessionTranscript(paths, parentId, "darwin")).toEqual({ transcriptPath: parentTranscript, liveSince: undefined });
    mockProcessTable(processRow);
    expect(await findClaudeSessionTranscript(paths, childId, "darwin")).toEqual({ transcriptPath: childTranscript, liveSince: startedAt });
    mockProcessTable("");
    expect(await findClaudeSessionTranscript(paths, childId, "darwin")).toEqual({ transcriptPath: childTranscript, liveSince: undefined });

    await writeFile(join(profile, "archived-sessions.idx"), JSON.stringify({ archived: [childId] }));
    expect(await findClaudeSessionTranscript(paths, childId, "darwin")).toBeUndefined();
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

  it("scans Windows session identities once and preserves Desktop ancestry", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-process-batch-"));
    directories.push(root);
    const paths = { sessions: join(root, "sessions"), tasks: join(root, "tasks"), projects: join(root, "projects"), desktopSessions: [] };
    const sessionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const startedAt = Date.parse("2026-01-01T10:00:00.123Z");
    await mkdir(paths.sessions);
    await writeFile(join(paths.sessions, "windows-orphan.json"), JSON.stringify({
      pid: 500, sessionId, cwd: root, startedAt: startedAt + 50, entrypoint: "claude-desktop-3p", peerProtocol: "agent-sdk",
    }));
    mockProcessTable(JSON.stringify([
      { ProcessId: 500, ParentProcessId: 400, Name: "claude.exe", CommandLine: `claude.exe --input-format stream-json --output-format stream-json --session-id ${sessionId}`, CreationDate: "2026-01-01T10:00:00.123Z" },
      { ProcessId: 400, ParentProcessId: 1, Name: "Claude.exe", CommandLine: "C:\\Users\\me\\AppData\\Local\\Programs\\Claude\\Claude.exe" },
    ]));

    const catalog = await scanClaudeCatalog(paths, "win32");
    expect(catalog.sessions[0]).toMatchObject({
      sessionId,
      desktopProcessAlive: true,
      activeProcesses: [expect.objectContaining({ pid: 500, startedAt, startedAtResolutionMs: 1, registeredAt: startedAt + 50, entrypoint: "claude-desktop-3p" })],
    });
  });

  it("treats Windows path casing as the same project", () => {
    expect(projectIdForCwd("C:\\Work\\Bridge", "win32"))
      .toBe(projectIdForCwd("c:\\work\\bridge", "win32"));
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

  it("coalesces concurrent catalog scans for the same runtime paths while keeping sequential scans fresh", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-catalog-coalesce-"));
    directories.push(root);
    const paths = {
      sessions: join(root, "sessions"),
      tasks: join(root, "tasks"),
      projects: join(root, "projects"),
      desktopSessions: [join(root, "desktop")],
    };
    const sessionId = "99999999-9999-4999-8999-999999999999";
    const startedAt = Date.parse("Thu Jan 1 10:00:00 2026");
    await Promise.all([mkdir(paths.sessions), mkdir(paths.desktopSessions[0]!)]);
    await Promise.all([
      writeFile(join(paths.sessions, "live.json"), JSON.stringify({
        pid: process.pid,
        sessionId,
        cwd: root,
        startedAt: startedAt + 100,
        entrypoint: "claude-desktop-3p",
      })),
      writeFile(join(paths.desktopSessions[0]!, "local_live.json"), JSON.stringify({
        sessionId: "local_live",
        cliSessionId: sessionId,
        cwd: root,
        lastFocusedAt: 10,
      })),
    ]);

    const psLine = `${process.pid} 1 Thu Jan 1 10:00:00 2026 claude --input-format stream-json --output-format stream-json --session-id ${sessionId}\n`;
    const pendingPs: Array<() => void> = [];
    let psCalls = 0;
    let currentPsOutput = psLine;
    const actualChildProcess = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
      psCalls += 1;
      const output = currentPsOutput;
      const done = args.at(-1) as (error: null, stdout: string, stderr: string) => void;
      pendingPs.push(() => done(null, output, ""));
      return {} as ChildProcess;
    }) as typeof execFile);
    try {
      const concurrent = [
        scanClaudeCatalog(paths, "darwin"),
        scanClaudeCatalog({ ...paths, desktopSessions: [...paths.desktopSessions] }, "darwin"),
        scanClaudeCatalog(paths, "darwin"),
      ];
      await vi.waitFor(() => expect(pendingPs.length).toBeGreaterThan(0));
      expect(psCalls).toBe(1);
      while (pendingPs.length > 0) pendingPs.shift()!();
      const results = await Promise.all(concurrent);
      expect(psCalls).toBe(1);
      for (const catalog of results) {
        expect(catalog.sessions).toHaveLength(1);
        expect(catalog.sessions[0]?.desktopProcessAlive).toBe(true);
      }

      currentPsOutput = "";
      const sequentialPromise = scanClaudeCatalog(paths, "darwin");
      await vi.waitFor(() => expect(pendingPs.length).toBeGreaterThan(0));
      while (pendingPs.length > 0) pendingPs.shift()!();
      const sequential = await sequentialPromise;
      expect(psCalls).toBe(2);
      expect(sequential.sessions[0]?.desktopProcessAlive).toBe(false);
    } finally {
      vi.mocked(execFile).mockImplementation(actualChildProcess.execFile);
    }
  });
});
