import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BridgeSessionInfo } from "@bridge/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeDesktopArchiveState } from "./claude-desktop-archive.js";
import { listClaudeDesktopSessionState } from "./claude-desktop-sessions.js";
import type { DesktopArchiveRequest } from "./conversation-state-store.js";
import { DesktopController } from "./controller.js";

const PARENT = "10000000-0000-4000-8000-000000000001";
const CHILD = "10000000-0000-4000-8000-000000000002";
const OLD_CHILD = "10000000-0000-4000-8000-000000000003";
const SIDE_CHAT = "10000000-0000-4000-8000-000000000004";
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function record(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: `local_${id}`, cliSessionId: id, cwd: "/tmp/project", title: `Title ${id.slice(-1)}`,
    createdAt: 1, lastActivityAt: 2, lastFocusedAt: 3, isArchived: false, customDesktopField: { kept: true }, ...extra,
  };
}

async function desktopDir(records: Record<string, unknown>[], archived: string[] = []): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bridge-desktop-archive-"));
  roots.push(root);
  const dir = join(root, "claude-code-sessions", "account", "org");
  await mkdir(dir, { recursive: true });
  await Promise.all(records.map((value) => writeFile(join(dir, `${value.sessionId}.json`), JSON.stringify(value), { mode: 0o600 })));
  await writeFile(join(dir, "archived-sessions.idx"), JSON.stringify({ v: 1, archived }), { mode: 0o600 });
  return dir;
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

describe("Claude Desktop archive records", () => {
  it("lists archived Desktop sessions with their archive time and preserves /btw sidechat metadata", async () => {
    const dir = await desktopDir([
      record(PARENT),
      record(CHILD, { isArchived: true, forkedFromSessionId: `local_${PARENT}` }),
      record(OLD_CHILD),
      record(SIDE_CHAT, { isArchived: true, spawnedFrom: { sessionId: `local_${PARENT}`, btw: true } }),
    ], [`local_${OLD_CHILD}`]);
    const state = await listClaudeDesktopSessionState([join(dir, "..", "..")]);
    expect(state.sessions.map((session) => session.cliSessionId)).toEqual([PARENT]);
    expect(state.archivedSessions.map((session) => session.cliSessionId).sort()).toEqual([CHILD, OLD_CHILD, SIDE_CHAT]);
    const child = state.archivedSessions.find((session) => session.cliSessionId === CHILD)!;
    const sideChat = state.archivedSessions.find((session) => session.cliSessionId === SIDE_CHAT)!;
    expect(child).toMatchObject({ parentSessionId: PARENT });
    expect(sideChat).toMatchObject({ parentSessionId: PARENT, forkLabel: "btw", sidechat: true });
    expect(state.metadataPaths.get(CHILD)).toBe(join(dir, `local_${CHILD}.json`));
    expect(JSON.stringify([...state.sessions, ...state.archivedSessions])).not.toContain(dir);
    expect(child.archivedAt).toBe((await stat(join(dir, `local_${CHILD}.json`))).mtimeMs);
    expect(state.archivedCliSessionIds.has(SIDE_CHAT)).toBe(true);
  });

  it("archives and restores a record in Desktop's own format and leaves other fields intact", async () => {
    const dir = await desktopDir([record(PARENT), record(CHILD)], [`local_${OLD_CHILD}`]);
    const request: DesktopArchiveRequest = {
      sessionId: PARENT, desktopSessionId: `local_${PARENT}`, metadataPath: join(dir, `local_${PARENT}.json`),
      archived: true, requestedAt: 10,
    };
    await expect(writeDesktopArchiveState(request)).resolves.toBe(true);
    expect(await readJson(request.metadataPath)).toEqual(record(PARENT, { isArchived: true }));
    expect(await readFile(join(dir, "archived-sessions.idx"), "utf8"))
      .toBe(JSON.stringify({ v: 1, archived: [`local_${OLD_CHILD}`, `local_${PARENT}`].sort() }));
    if (process.platform !== "win32") expect((await stat(request.metadataPath)).mode & 0o777).toBe(0o600);

    await writeDesktopArchiveState({ ...request, archived: false });
    expect(await readJson(request.metadataPath)).toEqual(record(PARENT));
    expect(await readJson(join(dir, "archived-sessions.idx"))).toEqual({ v: 1, archived: [`local_${OLD_CHILD}`] });
  });

  it("drops a request whose record is gone and refuses a record that now names another session", async () => {
    const dir = await desktopDir([record(PARENT)]);
    const request: DesktopArchiveRequest = {
      sessionId: CHILD, desktopSessionId: `local_${CHILD}`, metadataPath: join(dir, `local_${CHILD}.json`),
      archived: true, requestedAt: 10,
    };
    await expect(writeDesktopArchiveState(request)).resolves.toBe(false);
    await expect(writeDesktopArchiveState({ ...request, metadataPath: join(dir, `local_${PARENT}.json`) }))
      .rejects.toThrow("其他会话");
    expect(await readJson(join(dir, `local_${PARENT}.json`))).toEqual(record(PARENT));
  });
});

describe("Bridge archive changes reach Claude Desktop", () => {
  async function harness(records: Record<string, unknown>[], archived: string[] = [], visibility: [string, "archived" | "deleted"][] = []) {
    const dir = await desktopDir(records, archived);
    let state = await listClaudeDesktopSessionState([join(dir, "..", "..")]);
    const desktop = { state: "running" as "running" | "stopped" };
    const stored = new Map<string, DesktopArchiveRequest>();
    const toSession = (session: (typeof state.sessions)[number], archivedAt?: number): BridgeSessionInfo => ({
      sessionId: session.cliSessionId, desktopSessionId: session.sessionId, title: session.title ?? "", cwd: session.cwd,
      projectId: "project", projectName: "project", source: "desktop", transport: "bridge-host", ownership: "DESKTOP_OBSERVED",
      turnState: "idle", pendingCount: 0, lastActivityAt: session.lastActivityAt,
      ...(session.parentSessionId ? { parentSessionId: session.parentSessionId } : {}),
      ...(archivedAt ? { archivedAt } : {}),
    });
    const controller = Object.assign(Object.create(DesktopController.prototype), new EventEmitter(), {
      sessionVisibility: new Map(visibility.map(([sessionId, value]) => [sessionId, { visibility: value, updatedAt: 5 }])),
      desktopArchiveRequests: new Map<string, DesktopArchiveRequest>(),
      desktopArchiveSync: undefined,
      eventLog: { append: vi.fn(async () => undefined) },
      claudeDesktop: { status: vi.fn(async () => ({ state: desktop.state })) },
      conversationState: {
        setSessionVisibility: vi.fn(),
        setDesktopArchiveRequest: (request: DesktopArchiveRequest) => stored.set(request.sessionId, request),
        deleteDesktopArchiveRequest: (sessionId: string) => stored.delete(sessionId),
      },
      broker: {
        listSessions: () => [
          ...state.sessions.map((session) => toSession(session)),
          ...state.archivedSessions.map((session) => toSession(session, session.archivedAt)),
        ],
        removeSessionRecords: vi.fn(async () => undefined),
        desktopArchiveRecord: (sessionId: string) => {
          const active = state.sessions.find((session) => session.cliSessionId === sessionId);
          const found = active ?? state.archivedSessions.find((session) => session.cliSessionId === sessionId);
          return found && { desktopSessionId: found.sessionId, metadataPath: state.metadataPaths.get(sessionId)!, archived: !active };
        },
      },
    });
    return {
      dir, desktop, stored, controller,
      request: (method: string, params: Record<string, unknown>) => controller.handleRequest(
        { kind: "request", requestId: "request", idempotencyKey: "key", method, params }, "mobile",
      ),
      /** One catalog refresh: Bridge rescans Desktop's records, then reconciles. */
      refresh: async () => {
        await controller.desktopArchiveSync;
        state = await listClaudeDesktopSessionState([join(dir, "..", "..")]);
        controller.syncDesktopArchives();
        await controller.desktopArchiveSync;
      },
      session: (sessionId: string): BridgeSessionInfo | undefined => controller.allSessions()
        .find((candidate: BridgeSessionInfo) => candidate.sessionId === sessionId),
    };
  }

  it("waits for Desktop to stop, writes the archive, then follows Desktop's own record", async () => {
    const run = await harness([record(PARENT), record(CHILD, { forkedFromSessionId: `local_${PARENT}` })]);
    await run.request("session.archive", { sessionId: PARENT, archived: true });
    await run.refresh();
    // Desktop is running: nothing is written, and Bridge shows the archive as pending.
    expect((await readJson(join(run.dir, `local_${PARENT}.json`))).isArchived).toBe(false);
    expect(run.session(PARENT)).toMatchObject({ archivedAt: expect.any(Number), desktopArchivePending: true });
    expect(run.session(CHILD)).toMatchObject({ archivedAt: expect.any(Number), desktopArchivePending: true });
    expect([...run.stored.keys()].sort()).toEqual([PARENT, CHILD].sort());

    run.desktop.state = "stopped";
    await run.refresh();
    await run.refresh();
    for (const id of [PARENT, CHILD]) {
      expect((await readJson(join(run.dir, `local_${id}.json`))).isArchived).toBe(true);
      expect(run.session(id)).toMatchObject({ archivedAt: expect.any(Number) });
      expect(run.session(id)).not.toHaveProperty("desktopArchivePending");
    }
    expect(run.stored.size).toBe(0);
  });

  it("restores only the chosen session, leaving separately archived children archived", async () => {
    const run = await harness([
      record(PARENT, { isArchived: true }),
      record(OLD_CHILD, { isArchived: true, forkedFromSessionId: `local_${PARENT}` }),
    ], [`local_${PARENT}`, `local_${OLD_CHILD}`]);
    run.desktop.state = "stopped";
    await run.request("session.archive", { sessionId: PARENT, archived: false });
    await run.refresh();
    await run.refresh();
    expect((await readJson(join(run.dir, `local_${PARENT}.json`))).isArchived).toBe(false);
    expect(await readJson(join(run.dir, "archived-sessions.idx"))).toEqual({ v: 1, archived: [`local_${OLD_CHILD}`] });
    expect(run.session(PARENT)).not.toHaveProperty("archivedAt");
    expect(run.session(OLD_CHILD)).toMatchObject({ archivedAt: expect.any(Number) });
  });

  it("drops a pending change that the person also made in Desktop", async () => {
    const run = await harness([record(PARENT)]);
    await run.request("session.archive", { sessionId: PARENT, archived: true });
    await writeFile(join(run.dir, `local_${PARENT}.json`), JSON.stringify(record(PARENT, { isArchived: true })));
    await run.refresh();
    expect(run.stored.size).toBe(0);
    expect(run.desktop.state).toBe("running");
  });

  it("hands sessions archived or deleted in earlier Bridge releases to Desktop", async () => {
    const run = await harness([record(PARENT), record(CHILD)], [], [[PARENT, "archived"], [CHILD, "deleted"]]);
    await run.refresh();
    expect(run.session(PARENT)).toMatchObject({ archivedAt: 5, desktopArchivePending: true });
    expect(run.session(CHILD)).toBeUndefined();
    run.desktop.state = "stopped";
    await run.refresh();
    await run.refresh();
    expect((await readJson(join(run.dir, `local_${PARENT}.json`))).isArchived).toBe(true);
    expect((await readJson(join(run.dir, `local_${CHILD}.json`))).isArchived).toBe(true);
    expect(run.stored.size).toBe(0);
    expect(run.controller.sessionVisibility.has(PARENT)).toBe(false);
    expect(run.controller.sessionVisibility.get(CHILD)?.visibility).toBe("deleted");
  });

  it("archives a session in Desktop when it is deleted in Bridge", async () => {
    const run = await harness([record(PARENT)]);
    run.desktop.state = "stopped";
    await run.request("session.delete", { sessionId: PARENT });
    await run.refresh();
    expect((await readJson(join(run.dir, `local_${PARENT}.json`))).isArchived).toBe(true);
    expect(run.session(PARENT)).toBeUndefined();
  });
});
