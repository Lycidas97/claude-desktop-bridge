import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { BridgeDesktopRuntime, BridgeRequest } from "@bridge/protocol";
import { DesktopController } from "./controller.js";
import { SessionBroker, type TranscriptObserverRuntime } from "./session-broker.js";
import { projectIdForCwd, type ClaudeCatalogSnapshot, type ObservedClaudeSession } from "./claude-session-catalog.js";
import { SessionEventLog } from "./session-event-log.js";
import { discoverClaudeGatewayModels } from "./claude-runtime-discovery.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(group = false) {
  const root = await mkdtemp(join(tmpdir(), "bridge-ui-sync-"));
  roots.push(root);
  const cwd = join(root, "new-work");
  const profile = join(root, "Claude-3p");
  const sessionsRoot = join(profile, "claude-code-sessions");
  const metadataPath = join(sessionsRoot, "device", "account", "local_old.json");
  await mkdir(cwd);
  await mkdir(dirname(metadataPath), { recursive: true });
  await writeFile(join(profile, "claude_desktop_config.json"), JSON.stringify({ preferences: { epitaxyPrefs: {
    "dframe-group-scopes": { account: { groups: [{ id: "cg-test", name: "Test group" }], assignments: { "code:local_old": "cg-test" } } },
  } } }));
  const source = {
    sessionId: "old", desktopSessionId: "local_old", projectId: "cg-test", projectName: "Test group",
    cwd: join(root, "old-work"), sourceProfile: "claude-3p", title: "Old", source: "desktop", transport: "bridge-host",
    ownership: "DESKTOP_OBSERVED", turnState: "idle", lastActivityAt: 1, pendingCount: 0,
    transcriptMtimeMs: 1, processAlive: false, desktopProcessAlive: false, bridgeProcessAlive: false,
    processOverlap: false, activeProcesses: [], activeTask: false,
  } satisfies ObservedClaudeSession;
  const catalog: ClaudeCatalogSnapshot = {
    projects: [], sessions: group ? [source] : [], observedAt: 1,
    desktopMetadataPaths: new Map([["old", metadataPath]]),
  };
  const observer = Object.assign(new EventEmitter(), {
    catalog, isDesktopBusy: () => false, isMainTurnBusy: () => false,
    runningSubagents: () => undefined, markSubagentStopped: () => {}, applySubagentStops: <T>(value: T) => value,
    externalWriteVersion: () => 0, canStartBridgeHost: async () => true,
    onCatalog: () => () => {},
  }) as TranscriptObserverRuntime;
  const eventLog = new SessionEventLog(join(root, "events.jsonl"), 1);
  const discoverGatewayModels = vi.fn(async () => [{ value: "model-a", displayName: "Model A" }]);
  const desktopRegistrar = {
    register: vi.fn(async () => ({ state: "waiting-transcript" as const, detail: "Waiting", updatedAt: 1 })),
    publicInfo: (value: { state: "waiting-transcript"; detail: string; updatedAt: number }) => value,
    changed: () => true,
  };
  const environment = { ANTHROPIC_BASE_URL: "https://gateway.invalid" };
  const broker = new SessionBroker({
    paths: { sessions: join(root, "runtime"), tasks: join(root, "tasks"), projects: join(root, "projects"), desktopSessions: [sessionsRoot] },
    observer, eventLog, sessionsPath: join(root, "sessions.json"), queuePath: join(root, "queue.json"),
    prepareRuntime: async () => ({ executablePath: "/fake/claude", credentialPath: join(profile, "host-creds-test.json"), environment }),
    discoverGatewayModels, desktopRegistrar,
    hostFactory: () => { throw new Error("Must not create a model executor"); },
  });
  await broker.initialize();
  return { root, cwd, catalog, broker, eventLog, discoverGatewayModels, desktopRegistrar, environment };
}

it("creates in a readable directory with no historical sessions", async () => {
  const f = await fixture();
  try {
    expect(await f.broker.createSession(f.cwd)).toMatchObject({ cwd: f.cwd, projectId: projectIdForCwd(f.cwd) });
    expect(f.broker.listProjects()[0]).toMatchObject({ kind: "directory" });
    expect(f.desktopRegistrar.register).toHaveBeenCalledWith(expect.not.objectContaining({ groupId: expect.anything() }), undefined);
  } finally { await f.broker.close(); await f.eventLog.close(); }
});

it("retains a native group independently of the new cwd while waiting for transcript", async () => {
  const f = await fixture(true);
  try {
    const created = await f.broker.createSession(f.cwd, "New directory", "cg-test");
    expect(created).toMatchObject({ cwd: f.cwd, projectId: "cg-test", desktopRegistration: { state: "waiting-transcript" } });
    expect(f.desktopRegistrar.register).toHaveBeenCalledWith(expect.objectContaining({ groupId: "cg-test" }), undefined);
    expect(f.broker.listProjects()[0]).toMatchObject({ kind: "desktop-group" });
  } finally { await f.broker.close(); await f.eventLog.close(); }
});

it("rejects relative, missing, file and unreadable paths before saving a session", async () => {
  const f = await fixture();
  const file = join(f.root, "file");
  await writeFile(file, "fixture");
  try {
    for (const path of ["relative", join(f.root, "missing"), file]) await expect(f.broker.createSession(path)).rejects.toThrow();
    await chmod(f.cwd, 0);
    await expect(f.broker.createSession(f.cwd)).rejects.toThrow();
    expect(f.broker.listSessions()).toHaveLength(0);
  } finally { await chmod(f.cwd, 0o700); await f.broker.close(); await f.eventLog.close(); }
});

it("rejects a chosen group from a different profile before saving", async () => {
  const f = await fixture(true);
  f.catalog.sessions[0]!.sourceProfile = "claude";
  try { await expect(f.broker.createSession(f.cwd, "Wrong profile", "cg-test")).rejects.toThrow(/profile|分组/u); }
  finally { await f.broker.close(); await f.eventLog.close(); }
});

it("rejects an ambiguous Desktop group scope before saving", async () => {
  const f = await fixture(true);
  await writeFile(join(f.root, "Claude-3p", "claude_desktop_config.json"), JSON.stringify({ preferences: { epitaxyPrefs: {
    "dframe-group-scopes": {
      first: { groups: [{ id: "cg-test", name: "First" }] },
      second: { groups: [{ id: "cg-test", name: "Second" }] },
    },
  } } }));
  try {
    await expect(f.broker.createSession(f.cwd, "Ambiguous", "cg-test")).rejects.toThrow(/分组/u);
    expect(f.broker.listSessions()).toHaveLength(1);
  } finally { await f.broker.close(); await f.eventLog.close(); }
});

it("re-probes on explicit runtime refresh at the same path and clears the old gateway catalog on failure", async () => {
  const f = await fixture();
  try {
    f.discoverGatewayModels.mockResolvedValueOnce([{ value: "model-b", displayName: "Model B" }]);
    await f.broker.refreshRuntime();
    expect(f.discoverGatewayModels).toHaveBeenCalledTimes(2);
    expect(f.broker.runtimeStatus()).toMatchObject({ detection: { modelDiscovery: { state: "ready", count: 1 } } });
    f.environment.ANTHROPIC_BASE_URL = "https://changed-gateway.invalid";
    f.discoverGatewayModels.mockRejectedValueOnce(new Error("https://private.invalid?key=do-not-publish"));
    await f.broker.refreshRuntime();
    expect(f.broker.runtimeStatus()).toMatchObject({ state: "ready", detection: { modelDiscovery: { state: "error", count: 0 } } });
    expect(JSON.stringify(f.broker.runtimeStatus())).not.toContain("do-not-publish");
    expect(f.broker.availableModels()).toEqual([]);
  } finally { await f.broker.close(); await f.eventLog.close(); }
});

it("reports gateway discovery HTTP failure separately from an empty successful catalog", async () => {
  await expect(discoverClaudeGatewayModels({ environment: { ANTHROPIC_BASE_URL: "https://gateway.invalid" } },
    vi.fn(async () => new Response("private error", { status: 503 })) as typeof fetch)).rejects.toThrow(/503/u);
});

function controller(fields: Record<string, unknown>) {
  return Object.assign(Object.create(DesktopController.prototype), fields) as {
    handleRequest(request: BridgeRequest, origin: "desktop" | "mobile"): Promise<unknown>;
    desktopRuntimes(): BridgeDesktopRuntime[];
  };
}
function request(method: BridgeRequest["method"], params: Record<string, unknown> = {}): BridgeRequest {
  return { kind: "request", requestId: "test", idempotencyKey: "test", method, params };
}

it("lists one directory level and recents for local and paired requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-ui-directory-")); roots.push(root);
  await mkdir(join(root, "child")); await mkdir(join(root, "child", "grandchild")); await writeFile(join(root, "file"), "not read");
  const c = controller({ allSessions: () => [{ cwd: root }, { cwd: root }], allProjects: () => [{ cwd: join(root, "child") }] });
  for (const origin of ["desktop", "mobile"] as const) {
    expect(await c.handleRequest(request("directory.list", { path: root }), origin)).toEqual({ listing: {
      path: root, parentPath: dirname(root), directories: [{ name: "child", path: join(root, "child") }], recentPaths: [root, join(root, "child")],
    } });
  }
  await expect(c.handleRequest(request("directory.list", { path: "relative" }), "mobile")).rejects.toThrow(/absolute/u);
});

it("writes runtime defaults without a session and broadcasts through publish", async () => {
  const setHostPermissionMode = vi.fn(async () => 0), publish = vi.fn(async () => {});
  const config = { runtimePermissionModes: {}, defaultPermissionMode: "standard", devices: [] };
  const c = controller({ config, repository: { save: vi.fn(async () => {}) }, eventLog: { append: vi.fn(async () => {}) },
    runtimeSessions: { setHostPermissionMode }, publish });
  expect(await c.handleRequest(request("permission.policy.configure", { scope: "host", runtimeId: "codex-desktop", mode: "full-access" }), "mobile"))
    .toMatchObject({ runtimeId: "codex-desktop", defaultPermissionMode: "full-access" });
  expect(config.runtimePermissionModes).toEqual({ "codex-desktop": "full-access" });
  expect(setHostPermissionMode).toHaveBeenCalledWith("codex-desktop", "full-access"); expect(publish).toHaveBeenCalled();
});

it("broadcasts changed runtime defaults even when the session set is unchanged", async () => {
  const snapshot = { sessions: [], host: { defaultPermissionMode: "standard" }, runtimes: [{ id: "codex-desktop", defaultPermissionMode: "standard" }] };
  const broadcast = vi.fn(async () => {});
  const c = Object.assign(Object.create(DesktopController.prototype), new EventEmitter(), {
    snapshot: async () => snapshot, broadcast, eventLog: { append: vi.fn() },
    lastPublishedSessionKey: "", lastPublishedSubagentActivity: new Map(),
  });
  await c.publish();
  broadcast.mockClear();
  snapshot.runtimes[0]!.defaultPermissionMode = "full-access";
  await c.publish();
  expect(broadcast).toHaveBeenCalledWith({ kind: "snapshot", snapshot }, true);
});

it("rejects permission runtime and session mismatch", async () => {
  const c = controller({ config: { devices: [] } });
  await expect(c.handleRequest(request("permission.policy.configure", {
    scope: "host", runtimeId: "hermes-desktop", sessionId: "codex-desktop:task", mode: "full-access",
  }), "desktop")).rejects.toThrow(/does not match the session runtime/u);
});
