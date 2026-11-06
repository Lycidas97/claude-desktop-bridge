import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ClaudeDesktopSessionRegistrar, type StoredDesktopRegistration } from "./claude-desktop-session-registrar.js";
import { findClaudeTranscriptFile } from "./claude-history.js";
import { projectIdForCwd, type ClaudeCatalogSnapshot, type ObservedClaudeSession } from "./claude-session-catalog.js";
import { SessionBroker, type TranscriptObserverRuntime } from "./session-broker.js";
import { SessionEventLog } from "./session-event-log.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bridge-merged-contracts-")));
  roots.push(root);
  const cwd = join(root, "全新 working directory");
  const groupRoot = join(root, "Claude-3p", "claude-code-sessions");
  const otherRoot = join(root, "Claude", "claude-code-sessions");
  const accountDir = join(groupRoot, "device", "account");
  const sourceId = randomUUID();
  const metadataPath = join(accountDir, `local_${sourceId}.json`);
  const configPath = join(dirname(groupRoot), "claude_desktop_config.json");
  const config = { preferences: { epitaxyPrefs: { "dframe-group-scopes": { account: {
    groups: [{ id: "cg-merged", name: "Merged group" }], assignments: { [`code:local_${sourceId}`]: "cg-merged" },
  } } } } };
  await mkdir(cwd);
  await mkdir(accountDir, { recursive: true });
  await mkdir(join(otherRoot, "device", "account"), { recursive: true });
  await mkdir(join(root, "projects"));
  await writeFile(configPath, JSON.stringify(config));
  await writeFile(metadataPath, JSON.stringify({ sessionId: `local_${sourceId}`, cliSessionId: sourceId,
    cwd: join(root, "old-work"), title: "Existing group member", titleSource: "custom", createdAt: 1, lastActivityAt: 2 }));
  const source: ObservedClaudeSession = {
    sessionId: sourceId, desktopSessionId: `local_${sourceId}`, projectId: "cg-merged", projectName: "Merged group",
    cwd: join(root, "old-work"), sourceProfile: "claude-3p", title: "Existing group member", source: "desktop", transport: "bridge-host",
    ownership: "DESKTOP_OBSERVED", turnState: "idle", lastActivityAt: 1, pendingCount: 0,
    transcriptMtimeMs: 1, processAlive: false, desktopProcessAlive: false, bridgeProcessAlive: false,
    processOverlap: false, activeProcesses: [], activeTask: false,
  };
  const catalog: ClaudeCatalogSnapshot = { projects: [], sessions: [source], observedAt: 1,
    desktopMetadataPaths: new Map([[sourceId, metadataPath]]) };
  const observer = Object.assign(new EventEmitter(), {
    catalog, isDesktopBusy: () => false, isMainTurnBusy: () => false,
    runningSubagents: () => undefined, externalWriteVersion: () => 0, canStartBridgeHost: async () => true,
    onCatalog(listener: (next: ClaudeCatalogSnapshot) => void) {
      observer.on("catalog", listener);
      return () => observer.off("catalog", listener);
    },
  }) as TranscriptObserverRuntime & EventEmitter;
  const paths = { sessions: join(root, "runtime"), tasks: join(root, "tasks"), projects: join(root, "projects"),
    desktopSessions: [groupRoot, otherRoot] };
  const listProfiles = vi.fn(async () => [
    { pid: 100, userDataDir: dirname(groupRoot) }, { pid: 200, userDataDir: dirname(otherRoot) },
  ]);
  const findTranscript = vi.fn(findClaudeTranscriptFile);
  const registrar = new ClaudeDesktopSessionRegistrar({ paths, platform: "darwin", listProfiles, findTranscript });
  const register = vi.spyOn(registrar, "register");
  const eventLog = new SessionEventLog(join(root, "events.jsonl"), 1);
  const sessionsPath = join(root, "sessions.json");
  const hostFactory = vi.fn(() => { throw new Error("Must not create a model executor"); });
  const broker = new SessionBroker({
    paths, observer, eventLog, sessionsPath, queuePath: join(root, "queue.json"), desktopRegistrar: registrar,
    prepareRuntime: async () => ({ executablePath: "/fake/claude", credentialPath: join(dirname(groupRoot), "host-creds-test.json"), environment: {} }),
    discoverGatewayModels: async () => [], scanSessionProcesses: async () => [], hostFactory,
  });
  await broker.initialize();
  return { root, cwd, groupRoot, accountDir, configPath, config, catalog, observer, paths, sessionsPath,
    listProfiles, findTranscript, registrar, register, broker, eventLog, hostFactory,
    async close() { await broker.close(); await eventLog.close(); },
  };
}

async function firstTurn(f: Awaited<ReturnType<typeof fixture>>, sessionId: string) {
  await writeFile(join(f.paths.projects, `${sessionId}.jsonl`), [
    JSON.stringify({ type: "user", uuid: "first-user", sessionId, cwd: f.cwd, message: { role: "user", content: "First question" } }),
    JSON.stringify({ type: "assistant", uuid: "first-answer", parentUuid: "first-user", sessionId,
      message: { role: "assistant", content: "Done", stop_reason: "end_turn" } }), "",
  ].join("\n"));
  // Before Desktop has loaded the new native record, a process/transcript observation has only cwd identity.
  f.catalog.sessions.push({
    sessionId, cwd: f.cwd, projectId: projectIdForCwd(f.cwd), projectName: "全新 working directory", title: "First turn",
    source: "desktop", sourceProfile: "claude-3p", transport: "bridge-host", ownership: "DESKTOP_OBSERVED", turnState: "idle",
    pendingCount: 0, lastActivityAt: 2, transcriptMtimeMs: 2, processAlive: false, desktopProcessAlive: false,
    bridgeProcessAlive: false, processOverlap: false, activeProcesses: [], activeTask: false,
  });
  f.observer.emit("catalog", f.catalog);
}

it("retains a new directory parent's native group and registration target through its first fork with two Desktop profiles", async () => {
  const f = await fixture();
  try {
    const parent = await f.broker.createSession(f.cwd, "New grouped parent", "cg-merged");
    expect(parent).toMatchObject({ cwd: f.cwd, projectId: "cg-merged", projectName: "Merged group",
      desktopRegistration: { state: "waiting-transcript" } });
    await firstTurn(f, parent.sessionId);
    const registeredParent = await f.broker.registerDesktopSession(parent.sessionId);
    expect(registeredParent).toMatchObject({ projectId: "cg-merged", desktopRegistration: { state: "restart-required" } });

    const fork = await f.broker.forkSession(parent.sessionId);
    expect(fork.desktopRegistration?.state, fork.desktopRegistration?.detail).toBe("restart-required");
    expect(fork).toMatchObject({ cwd: f.cwd, projectId: "cg-merged", projectName: "Merged group",
      parentSessionId: parent.sessionId, desktopRegistration: { state: "restart-required" } });
    expect(f.register.mock.calls.filter(([input]) => input.sessionId === fork.sessionId).at(-1)?.[0]).toMatchObject({
      groupId: "cg-merged", groupSessionsRoot: f.groupRoot, groupScope: "account",
      parentDesktopSessionId: registeredParent.desktopSessionId,
    });
    const saved = JSON.parse(await readFile(f.sessionsPath, "utf8"));
    expect(saved.sessions.find((session: { sessionId: string }) => session.sessionId === fork.sessionId)).toMatchObject({
      projectId: "cg-merged", projectName: "Merged group", groupSessionsRoot: f.groupRoot, groupScope: "account",
    });
    const native = JSON.parse(await readFile(join(f.accountDir, `${fork.desktopSessionId}.json`), "utf8"));
    expect(native).toMatchObject({ cwd: f.cwd, forkedFromSessionId: registeredParent.desktopSessionId,
      spawnedFrom: { sessionId: registeredParent.desktopSessionId, userFork: true } });
    expect(JSON.parse(await readFile(f.configPath, "utf8")).preferences.epitaxyPrefs["dframe-group-scopes"].account.assignments)
      .toMatchObject({ [`code:${fork.desktopSessionId}`]: "cg-merged" });
    expect(f.hostFactory).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

it("persists a new directory's native identity after group assignment failure and retries that record without an active Desktop", async () => {
  const f = await fixture();
  try {
    const created = await f.broker.createSession(f.cwd, "Partial registration", "cg-merged");
    await firstTurn(f, created.sessionId);
    f.config.preferences.epitaxyPrefs["dframe-group-scopes"].account.groups = [];
    await writeFile(f.configPath, JSON.stringify(f.config));
    const failed = await f.broker.registerDesktopSession(created.sessionId);
    expect(failed).toMatchObject({ cwd: f.cwd, projectId: "cg-merged", projectName: "Merged group",
      desktopSessionId: `local_${created.sessionId}`, desktopRegistration: { state: "failed" } });
    const saved = JSON.parse(await readFile(f.sessionsPath, "utf8"));
    const partial: StoredDesktopRegistration = saved.sessions.find((session: { sessionId: string }) => session.sessionId === created.sessionId).desktopRegistration;
    expect(partial).toMatchObject({ state: "failed", desktopSessionId: failed.desktopSessionId,
      profileSessionsRoot: f.groupRoot, nativeRegistrationState: "restart-required", metadataPath: expect.any(String) });
    expect(failed.desktopRegistration).not.toHaveProperty("nativeRegistrationState");
    const metadataBeforeRetry = await readFile(partial.metadataPath!, "utf8");
    const filesBeforeRetry = await readdir(f.accountDir);

    f.register.mockRejectedValueOnce(new Error("Registration retry temporarily unavailable"));
    await f.broker.registerDesktopSession(created.sessionId);
    const afterException = JSON.parse(await readFile(f.sessionsPath, "utf8"));
    expect(afterException.sessions.find((session: { sessionId: string }) => session.sessionId === created.sessionId).desktopRegistration)
      .toMatchObject({ ...partial, detail: "Claude Desktop 会话登记失败，Bridge 会话仍可正常使用。", updatedAt: expect.any(Number) });

    f.config.preferences.epitaxyPrefs["dframe-group-scopes"].account.groups.push({ id: "cg-merged", name: "Merged group" });
    await writeFile(f.configPath, JSON.stringify(f.config));
    f.listProfiles.mockResolvedValue([]);
    f.findTranscript.mockResolvedValue(undefined);
    f.findTranscript.mockClear();
    expect(await f.broker.registerDesktopSession(created.sessionId)).toMatchObject({ cwd: f.cwd, projectId: "cg-merged",
      desktopSessionId: failed.desktopSessionId, desktopRegistration: { state: "restart-required" } });
    const recovered = JSON.parse(await readFile(f.sessionsPath, "utf8")).sessions
      .find((session: { sessionId: string }) => session.sessionId === created.sessionId).desktopRegistration;
    expect(recovered).toMatchObject({ metadataPath: partial.metadataPath, desktopSessionId: failed.desktopSessionId,
      profileSessionsRoot: f.groupRoot, groupAssignment: "saved" });
    expect(recovered).not.toHaveProperty("nativeRegistrationState");
    expect(f.findTranscript).not.toHaveBeenCalled();
    expect(await readFile(partial.metadataPath!, "utf8")).toBe(metadataBeforeRetry);
    expect(await readdir(f.accountDir)).toEqual(filesBeforeRetry);
    expect(JSON.parse(await readFile(f.configPath, "utf8")).preferences.epitaxyPrefs["dframe-group-scopes"].account.assignments)
      .toMatchObject({ [`code:${failed.desktopSessionId}`]: "cg-merged" });
    expect(f.hostFactory).not.toHaveBeenCalled();
  } finally { await f.close(); }
});
