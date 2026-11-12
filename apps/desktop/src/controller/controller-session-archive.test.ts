import { EventEmitter } from "node:events";
import { rm, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BridgeSessionInfo } from "@bridge/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listClaudeDesktopSessionState } from "../claude/claude-desktop-sessions.js";
import { DesktopController } from "./controller.js";

vi.mock("electron", () => ({ shell: {} }));

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
});

describe("Bridge archives through Claude Desktop native RPC", () => {
  async function harness(records: Record<string, unknown>[]) {
    const dir = await desktopDir(records);
    const state = await listClaudeDesktopSessionState([join(dir, "..", "..")]);
    const sessions: BridgeSessionInfo[] = [...state.sessions, ...state.archivedSessions].map(session => ({
      sessionId: session.cliSessionId, desktopSessionId: session.sessionId, title: session.title ?? "", cwd: session.cwd,
      runtimeId: "claude-desktop", projectId: "project", projectName: "project", source: "desktop",
      transport: "claude-desktop-native", ownership: "DESKTOP_NATIVE_IDLE", turnState: "idle", pendingCount: 0,
      lastActivityAt: session.lastActivityAt,
      ...(session.parentSessionId ? { parentSessionId: session.parentSessionId } : {}),
      ...("archivedAt" in session && typeof session.archivedAt === "number" ? { archivedAt: session.archivedAt } : {}),
    }));
    const archive = vi.fn(async (sessionId: string, archived: boolean) => {
      const session = sessions.find(candidate => candidate.sessionId === sessionId)!;
      if (archived) session.archivedAt = Date.now();
      else delete session.archivedAt;
      return session;
    });
    const deleteSession = vi.fn(async (sessionId: string) => {
      sessions.splice(sessions.findIndex(session => session.sessionId === sessionId), 1);
    });
    const controller = Object.assign(Object.create(DesktopController.prototype), new EventEmitter(), {
      sessionVisibility: new Map(),
      eventLog: { append: vi.fn(async () => undefined) },
      claudeDesktop: { status: vi.fn(() => { throw new Error("Archive must not require stopping Desktop"); }) },
      conversationState: { setSessionVisibility: vi.fn() },
      broker: { listSessions: () => sessions, archive, deleteSession },
    });
    return {
      dir, archive, deleteSession, controller,
      request: (method: string, params: Record<string, unknown>) => controller.handleRequest(
        { kind: "request", requestId: "request", idempotencyKey: "key", method, params }, "mobile",
      ),
      session: (sessionId: string): BridgeSessionInfo | undefined => controller.allSessions()
        .find((candidate: BridgeSessionInfo) => candidate.sessionId === sessionId),
    };
  }

  it("archives the session and its active children with native calls without writing metadata", async () => {
    const run = await harness([
      record(PARENT), record(CHILD, { forkedFromSessionId: `local_${PARENT}` }),
      record(OLD_CHILD, { isArchived: true, forkedFromSessionId: `local_${PARENT}` }),
    ]);
    const metadata = await readFile(join(run.dir, `local_${PARENT}.json`), "utf8");
    const index = await readFile(join(run.dir, "archived-sessions.idx"), "utf8");
    await run.request("session.archive", { sessionId: PARENT, archived: true });
    expect(run.archive.mock.calls).toEqual([[PARENT, true], [CHILD, true]]);
    expect(run.session(PARENT)).toMatchObject({ archivedAt: expect.any(Number) });
    expect(run.session(CHILD)).toMatchObject({ archivedAt: expect.any(Number) });
    expect(run.session(PARENT)).not.toHaveProperty("desktopArchivePending");
    expect(await readFile(join(run.dir, `local_${PARENT}.json`), "utf8")).toBe(metadata);
    expect(await readFile(join(run.dir, "archived-sessions.idx"), "utf8")).toBe(index);
    expect(run.controller.claudeDesktop.status).not.toHaveBeenCalled();
  });

  it("restores only the chosen native session", async () => {
    const run = await harness([
      record(PARENT, { isArchived: true }),
      record(OLD_CHILD, { isArchived: true, forkedFromSessionId: `local_${PARENT}` }),
    ]);
    run.controller.sessionVisibility.set(PARENT, { visibility: "archived", updatedAt: 10 });
    await run.request("session.archive", { sessionId: PARENT, archived: false });
    expect(run.archive.mock.calls).toEqual([[PARENT, false]]);
    expect(run.session(PARENT)).not.toHaveProperty("archivedAt");
    expect(run.session(OLD_CHILD)).toHaveProperty("archivedAt");
    expect(run.controller.sessionVisibility.get(PARENT)).toEqual({ visibility: "archived", updatedAt: 10 });
    expect(run.controller.conversationState.setSessionVisibility).not.toHaveBeenCalled();
  });

  it("ignores old Bridge visibility without changing native archive state or old records", async () => {
    const run = await harness([record(PARENT), record(CHILD), record(OLD_CHILD, { isArchived: true })]);
    const nativeArchiveTime = run.session(OLD_CHILD)!.archivedAt;
    run.controller.sessionVisibility.set(PARENT, { visibility: "deleted", updatedAt: 10 });
    run.controller.sessionVisibility.set(CHILD, { visibility: "archived", updatedAt: 11 });
    run.controller.sessionVisibility.set(OLD_CHILD, { visibility: "archived", updatedAt: 12 });
    const oldVisibility = new Map(run.controller.sessionVisibility);
    expect(run.session(PARENT)).toBeDefined();
    expect(run.session(CHILD)).not.toHaveProperty("archivedAt");
    expect(run.session(OLD_CHILD)?.archivedAt).toBe(nativeArchiveTime);
    expect(run.controller.sessionVisibility).toEqual(oldVisibility);
    expect(run.controller.conversationState.setSessionVisibility).not.toHaveBeenCalled();
  });

  it("deletes through Desktop without first archiving or writing a local tombstone", async () => {
    const run = await harness([record(PARENT)]);
    await run.request("session.delete", { sessionId: PARENT });
    expect(run.archive).not.toHaveBeenCalled();
    expect(run.deleteSession).toHaveBeenCalledExactlyOnceWith(PARENT);
    expect(run.session(PARENT)).toBeUndefined();
    expect(run.controller.conversationState.setSessionVisibility).not.toHaveBeenCalled();
    expect((await readJson(join(run.dir, `local_${PARENT}.json`))).isArchived).toBe(false);
  });

  it("surfaces native deletion failure without hiding or archiving the session", async () => {
    const run = await harness([record(PARENT)]);
    run.deleteSession.mockRejectedValueOnce(new Error("Native delete unavailable"));
    await expect(run.request("session.delete", { sessionId: PARENT })).rejects.toThrow("Native delete unavailable");
    expect(run.archive).not.toHaveBeenCalled();
    expect(run.controller.eventLog.append).not.toHaveBeenCalled();
    expect(run.controller.conversationState.setSessionVisibility).not.toHaveBeenCalled();
    expect(run.session(PARENT)).not.toHaveProperty("archivedAt");
  });
});
