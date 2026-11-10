import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { BridgeSessionInfo, DesktopControlSnapshot } from "@bridge/protocol";
import { describe, expect, it, vi } from "vitest";
import { DesktopController } from "./controller.js";
import { SessionEventLog } from "./session-event-log.js";

describe("mobile snapshot publication", () => {
  it.each([
    { runningSubagents: { count: 2, lastUpdatedAt: 10 } },
    { subagentStopScope: "task" as const },
    { executionStage: "submitted" as const },
    { ownership: "DESKTOP_OBSERVED" as const, turnState: "running" as const, mainTurnStopScope: "process" as const },
  ])("publishes runtime session changes %j as a replacement without a metadata change", async (change) => {
    const session: BridgeSessionInfo = {
      sessionId: "session-1", title: "Session", cwd: "/tmp/project",
      projectId: "project", projectName: "Project", source: "bridge",
      transport: "bridge-host", ownership: "BRIDGE_IDLE", turnState: "idle", pendingCount: 0,
      lastActivityAt: 1,
    };
    const controller = Object.assign(Object.create(DesktopController.prototype), new EventEmitter(), {
      lastPublishedSessionKey: "",
      lastPublishedSessions: new Map<string, string>(),
      lastPublishedPermissions: new Map(), claudePermissions: () => [],
      snapshot: vi.fn(async () => ({ sessions: [{ ...session }], permissions: [] }) satisfies Pick<DesktopControlSnapshot, "sessions" | "permissions">),
      broadcast: vi.fn(async () => undefined),
      eventLog: { append: vi.fn(async () => undefined) },
    });
    const localSnapshot = vi.fn();
    controller.on("snapshot", localSnapshot);
    await controller.publish();
    expect(controller.broadcast).toHaveBeenCalledOnce();
    expect(controller.eventLog.append).not.toHaveBeenCalled();
    controller.broadcast.mockClear();
    Object.assign(session, change);
    await controller.publish();
    expect(controller.broadcast).not.toHaveBeenCalled();
    expect(controller.eventLog.append).toHaveBeenCalledExactlyOnceWith({
      sessionId: session.sessionId, itemId: "session:subagent-activity", origin: "system", type: "runtime.updated",
      data: { replaceSession: true, session },
    });
    await controller.publish();
    expect(controller.broadcast).not.toHaveBeenCalled();
    expect(controller.eventLog.append).toHaveBeenCalledOnce();
    expect(localSnapshot).toHaveBeenCalledTimes(3);
    expect(localSnapshot.mock.calls[2]![0].sessions).toEqual([session]);
  });

  it("pushes removal of a stale subagent count while the main turn stays idle", async () => {
    const session: BridgeSessionInfo = {
      sessionId: "session-1", title: "Session", cwd: "/tmp/project", projectId: "project", projectName: "Project",
      source: "desktop", transport: "bridge-host", ownership: "DESKTOP_OBSERVED", turnState: "idle",
      pendingCount: 0, lastActivityAt: 1, runningSubagents: { count: 2, lastUpdatedAt: 10 }, subagentStopScope: "task",
    };
    const controller = Object.assign(Object.create(DesktopController.prototype), new EventEmitter(), {
      lastPublishedSessionKey: "",
      lastPublishedSessions: new Map<string, string>(),
      lastPublishedPermissions: new Map(), claudePermissions: () => [],
      snapshot: vi.fn(async () => ({ sessions: [{ ...session }], permissions: [] }) satisfies Pick<DesktopControlSnapshot, "sessions" | "permissions">),
      broadcast: vi.fn(async () => undefined),
      eventLog: { append: vi.fn(async () => undefined) },
    });
    await controller.publish();
    controller.broadcast.mockClear();
    delete session.runningSubagents;
    delete session.subagentStopScope;
    await controller.publish();
    expect(controller.broadcast).not.toHaveBeenCalled();
    expect(controller.eventLog.append).toHaveBeenCalledExactlyOnceWith({
      sessionId: session.sessionId, itemId: "session:subagent-activity", origin: "system", type: "runtime.updated",
      data: { replaceSession: true, session },
    });
    expect(controller.eventLog.append.mock.calls[0]![0].data.session).not.toHaveProperty("runningSubagents");
    expect(controller.eventLog.append.mock.calls[0]![0].data.session).not.toHaveProperty("subagentStopScope");
  });

  it("publishes a Desktop-owned turn ending as a replacement that clears its stop scope", async () => {
    const session: BridgeSessionInfo = {
      sessionId: "session-1", title: "Session", cwd: "/tmp/project",
      projectId: "project", projectName: "Project", source: "desktop",
      transport: "bridge-host", ownership: "DESKTOP_OBSERVED", turnState: "running", pendingCount: 0,
      lastActivityAt: 1, mainTurnStopScope: "process",
    };
    const controller = Object.assign(Object.create(DesktopController.prototype), new EventEmitter(), {
      lastPublishedSessionKey: "",
      lastPublishedSessions: new Map<string, string>(),
      lastPublishedPermissions: new Map(), claudePermissions: () => [],
      snapshot: vi.fn(async () => ({ sessions: [{ ...session }], permissions: [] }) satisfies Pick<DesktopControlSnapshot, "sessions" | "permissions">),
      broadcast: vi.fn(async () => undefined),
      eventLog: { append: vi.fn(async () => undefined) },
    });
    await controller.publish();
    controller.broadcast.mockClear();
    session.turnState = "idle";
    delete session.mainTurnStopScope;
    await controller.publish();
    expect(controller.broadcast).not.toHaveBeenCalled();
    expect(controller.eventLog.append).toHaveBeenCalledExactlyOnceWith({
      sessionId: session.sessionId, itemId: "session:subagent-activity", origin: "system", type: "runtime.updated",
      data: { replaceSession: true, session },
    });
    expect(controller.eventLog.append.mock.calls[0]![0].data.session).not.toHaveProperty("mainTurnStopScope");
  });

  it("publishes Desktop registration changes without requiring another session change", async () => {
    const session: BridgeSessionInfo = {
      sessionId: "session-1", title: "Session", cwd: "/tmp/project",
      projectId: "project", projectName: "Project", source: "bridge",
      transport: "bridge-host", ownership: "BRIDGE_IDLE", turnState: "idle", pendingCount: 0,
      lastActivityAt: 1,
      desktopRegistration: { state: "waiting-transcript", detail: "Pending", updatedAt: 1 },
    };
    // Exercise publish in isolation; transport and native Desktop are unrelated to its change key.
    const controller = Object.assign(Object.create(DesktopController.prototype), new EventEmitter(), {
      lastPublishedSessionKey: "",
      lastPublishedSessions: new Map<string, string>(),
      lastPublishedPermissions: new Map(), claudePermissions: () => [],
      snapshot: vi.fn(async () => ({ sessions: [{ ...session }], permissions: [] }) satisfies Pick<DesktopControlSnapshot, "sessions" | "permissions">),
      broadcast: vi.fn(async () => undefined),
      eventLog: { append: vi.fn(async () => undefined) },
    });
    await controller.publish();
    controller.broadcast.mockClear();
    await controller.publish();
    expect(controller.broadcast).not.toHaveBeenCalled();

    session.desktopRegistration = { state: "registered", detail: "Registered", updatedAt: 2 };
    await controller.publish();
    expect(controller.broadcast).toHaveBeenCalledWith({
      kind: "snapshot",
      snapshot: expect.objectContaining({ sessions: [expect.objectContaining({
        desktopRegistration: expect.objectContaining({ state: "registered" }),
      })] }),
    }, true);
    expect(controller.eventLog.append).not.toHaveBeenCalled();
  });

  it("sends a small complete session replacement for subagent progress instead of the full catalog", async () => {
    const { controller, sessions } = progressFixture();
    await controller.publish();
    expect(controller.eventLog.append).not.toHaveBeenCalled();
    const catalogBytes = Buffer.byteLength(JSON.stringify(controller.broadcast.mock.calls[0]![0]));
    controller.broadcast.mockClear();

    sessions[0]!.runningSubagents!.lastUpdatedAt = 20;
    sessions[0]!.lastActivityAt = 20;
    await controller.publish();
    expect(controller.broadcast).not.toHaveBeenCalled();
    expect(controller.eventLog.append).toHaveBeenCalledExactlyOnceWith({
      sessionId: "session-0", itemId: "session:subagent-activity", origin: "system", type: "runtime.updated",
      data: { replaceSession: true, session: sessions[0] },
    });
    expect(Buffer.byteLength(JSON.stringify(controller.eventLog.append.mock.calls[0]![0]))).toBeLessThan(catalogBytes / 100);

    await controller.publish();
    expect(controller.eventLog.append).toHaveBeenCalledOnce();
  });

  it("publishes independent session replacements for each changed session", async () => {
    const { controller, sessions } = progressFixture();
    sessions[1]!.runningSubagents = { count: 1, lastUpdatedAt: 10 };
    await controller.publish();
    controller.broadcast.mockClear();
    sessions[0]!.runningSubagents!.lastUpdatedAt = 20;
    sessions[1]!.runningSubagents!.lastUpdatedAt = 30;
    await controller.publish();
    expect(controller.broadcast).not.toHaveBeenCalled();
    expect(controller.eventLog.append.mock.calls.map(([event]: [{ sessionId: string }]) => event.sessionId)).toEqual(["session-0", "session-1"]);
    expect(controller.eventLog.append.mock.calls.map(([event]: [{ data: unknown }]) => event.data)).toEqual([
      { replaceSession: true, session: sessions[0] },
      { replaceSession: true, session: sessions[1] },
    ]);
  });

  it("uses session replacements for both count changes and subsequent progress", async () => {
    const { controller, sessions } = progressFixture();
    await controller.publish();
    controller.broadcast.mockClear();
    sessions[0]!.runningSubagents = { count: 3, lastUpdatedAt: 20 };
    await controller.publish();
    expect(controller.broadcast).not.toHaveBeenCalled();
    expect(controller.eventLog.append).toHaveBeenCalledExactlyOnceWith({
      sessionId: "session-0", itemId: "session:subagent-activity", origin: "system", type: "runtime.updated",
      data: { replaceSession: true, session: sessions[0] },
    });
    sessions[0]!.runningSubagents!.lastUpdatedAt = 30;
    await controller.publish();
    expect(controller.broadcast).not.toHaveBeenCalled();
    expect(controller.eventLog.append).toHaveBeenCalledTimes(2);
    expect(controller.eventLog.append.mock.calls[1]![0].data).toEqual({ replaceSession: true, session: sessions[0] });
  });

  it("includes progress in a simultaneous metadata snapshot without emitting an extra replacement", async () => {
    const { controller, sessions } = progressFixture();
    await controller.publish();
    controller.broadcast.mockClear();
    sessions[0]!.title = "Renamed";
    sessions[0]!.runningSubagents!.lastUpdatedAt = 20;
    await controller.publish();
    expect(controller.broadcast).toHaveBeenCalledExactlyOnceWith({
      kind: "snapshot", snapshot: expect.objectContaining({ sessions }),
    }, true);
    expect(controller.eventLog.append).not.toHaveBeenCalled();
    controller.broadcast.mockClear();
    await controller.publish();
    expect(controller.broadcast).not.toHaveBeenCalled();
    expect(controller.eventLog.append).not.toHaveBeenCalled();
  });

  it("persists progress and completion replacements with the shared sequence across a restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-progress-events-"));
    const path = join(directory, "events.jsonl");
    const log = new SessionEventLog(path);
    const { controller, sessions } = progressFixture();
    controller.eventLog = log;
    try {
      await log.append({ sessionId: "session-1", origin: "claude-host", type: "assistant.completed", data: { text: "Done" } });
      await controller.publish();
      controller.broadcast.mockClear();
      const received = vi.fn();
      log.on("event", received);
      sessions[0]!.runningSubagents!.lastUpdatedAt = 20;
      await controller.publish();
      expect(received).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        seq: 2, sessionId: "session-0", type: "runtime.updated",
        data: { replaceSession: true, session: sessions[0] },
      }));
      delete sessions[0]!.runningSubagents;
      await controller.publish();
      expect(received).toHaveBeenCalledTimes(2);
      expect(received.mock.calls[1]![0]).toMatchObject({
        seq: 3, sessionId: "session-0", type: "runtime.updated", data: { replaceSession: true, session: sessions[0] },
      });
      expect(received.mock.calls[1]![0].data.session).not.toHaveProperty("runningSubagents");
      expect(controller.broadcast).not.toHaveBeenCalled();
      expect(log.history("session-0").items).toEqual([]);
      await log.close();
      const reopened = new SessionEventLog(path);
      try {
        await reopened.initialize();
        expect(reopened.replay(1)).toEqual(received.mock.calls.map(([event]) => event));
        expect(reopened.latestSeq()).toBe(3);
        expect(reopened.latestItem("session-0", "runtime.updated", "session:subagent-activity")).toEqual(received.mock.calls[1]![0]);
        expect(await reopened.append({ sessionId: "session-1", origin: "claude-host", type: "assistant.completed", data: { text: "After restart" } }))
          .toMatchObject({ seq: 4 });
      } finally {
        await reopened.close();
      }
    } finally {
      await log.close();
      await trashTestDirectory(directory);
    }
  });

  it("does not revive a completed subagent while another session's progress append is pending", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-progress-order-"));
    const log = new SessionEventLog(join(directory, "events.jsonl"));
    let resume!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>(resolve => { resume = resolve; });
    const firstAppend = new Promise<void>(resolve => { entered = resolve; });
    const { controller, sessions } = progressFixture();
    sessions[1]!.runningSubagents = { count: 1, lastUpdatedAt: 10 };
    sessions[1]!.subagentStopScope = "task";
    controller.snapshot.mockImplementation(async () => ({ sessions: structuredClone(sessions), permissions: [], latestSeq: log.latestSeq() }));
    controller.eventLog = { append: async (draft: Parameters<SessionEventLog["append"]>[0]) => {
      const event = await log.append(draft);
      if (draft.sessionId === "session-0") { entered(); await blocked; }
      return event;
    } };
    const received = vi.fn();
    log.on("event", received);
    try {
      await log.initialize();
      await controller.publish();
      controller.broadcast.mockClear();
      sessions[0]!.runningSubagents!.lastUpdatedAt = 20;
      sessions[1]!.runningSubagents!.lastUpdatedAt = 20;
      const progress = controller.publish();
      await firstAppend;
      delete sessions[1]!.runningSubagents;
      delete sessions[1]!.subagentStopScope;
      await controller.publish();
      expect(controller.broadcast).not.toHaveBeenCalled();
      const updates = received.mock.calls.map(([event]) => event).filter(event => event.sessionId === "session-1");
      expect(updates).toHaveLength(2);
      expect(updates[0].data.session.runningSubagents).toEqual({ count: 1, lastUpdatedAt: 20 });
      const completed = updates[1];
      expect(completed.seq).toBeGreaterThan(updates[0].seq);
      expect(completed.data).toEqual({ replaceSession: true, session: sessions[1] });
      expect(completed.data.session).not.toHaveProperty("runningSubagents");
      expect(completed.data.session).not.toHaveProperty("subagentStopScope");
      resume();
      await progress;
      // The completion replacement remains authoritative after the earlier publish finishes.
      expect(log.replay(0, 500, "session-1")).toEqual([completed]);
      expect(log.latestItem("session-1", "runtime.updated", "session:subagent-activity")).toEqual(completed);
      expect(received.mock.calls.map(([event]) => event).filter(event => event.sessionId === "session-1")).toEqual(updates);
    } finally {
      resume();
      await log.close();
      await trashTestDirectory(directory);
    }
  });

  it("resets replacement tracking when a session disappears and returns with the same identity", async () => {
    const { controller, sessions } = progressFixture();
    await controller.publish();
    const removed = sessions.shift()!;
    await controller.publish();
    expect(controller.broadcast.mock.calls.at(-1)![0].snapshot.sessions.some((session: BridgeSessionInfo) => session.sessionId === removed.sessionId)).toBe(false);
    expect(controller.lastPublishedSessions.has(removed.sessionId)).toBe(false);
    sessions.unshift(removed);
    await controller.publish();
    expect(controller.broadcast.mock.calls.at(-1)![0].snapshot.sessions[0].runningSubagents).toEqual({ count: 2, lastUpdatedAt: 10 });
    expect(controller.eventLog.append).not.toHaveBeenCalled();
    controller.broadcast.mockClear();
    await controller.publish();
    expect(controller.broadcast).not.toHaveBeenCalled();
    expect(controller.eventLog.append).not.toHaveBeenCalled();
    removed.runningSubagents!.lastUpdatedAt = 20;
    await controller.publish();
    expect(controller.broadcast).not.toHaveBeenCalled();
    expect(controller.eventLog.append).toHaveBeenCalledExactlyOnceWith({
      sessionId: removed.sessionId, itemId: "session:subagent-activity", origin: "system", type: "runtime.updated",
      data: { replaceSession: true, session: removed },
    });
  });

});

async function trashTestDirectory(directory: string) {
  if (process.platform === "win32") {
    await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName Microsoft.VisualBasic; " +
      "[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($env:BRIDGE_RECYCLE_PATH, 'OnlyErrorDialogs', 'SendToRecycleBin', 'ThrowException')",
    ], { env: { ...process.env, BRIDGE_RECYCLE_PATH: directory } });
  } else {
    await promisify(execFile)(process.platform === "darwin" ? "/usr/bin/trash" : "trash-put", [directory]);
  }
}

function progressFixture() {
  const sessions: BridgeSessionInfo[] = Array.from({ length: 140 }, (_, index) => ({
    sessionId: `session-${index}`, title: `Session ${index} ${"x".repeat(256)}`, cwd: "/tmp/project",
    projectId: "project", projectName: "Project", source: "desktop", transport: "bridge-host",
    ownership: "DESKTOP_OBSERVED", turnState: "idle", pendingCount: 0, lastActivityAt: 1,
    ...(index === 0 ? { runningSubagents: { count: 2, lastUpdatedAt: 10 } } : {}),
  }));
  const controller = Object.assign(Object.create(DesktopController.prototype), new EventEmitter(), {
    lastPublishedSessionKey: "",
    lastPublishedSessions: new Map<string, string>(),
    lastPublishedPermissions: new Map(), claudePermissions: () => [],
    snapshot: vi.fn(async () => ({ sessions: structuredClone(sessions), permissions: [] }) satisfies Pick<DesktopControlSnapshot, "sessions" | "permissions">),
    broadcast: vi.fn(async () => undefined),
    eventLog: { append: vi.fn(async () => undefined) },
  });
  return { controller, sessions };
}
