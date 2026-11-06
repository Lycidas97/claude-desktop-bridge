import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  ])("publishes runtime session changes %j without a metadata change", async (change) => {
    const session: BridgeSessionInfo = {
      sessionId: "session-1", title: "Session", cwd: "/tmp/project",
      projectId: "project", projectName: "Project", source: "bridge",
      transport: "bridge-host", ownership: "BRIDGE_IDLE", turnState: "idle", pendingCount: 0,
      lastActivityAt: 1,
    };
    const controller = Object.assign(Object.create(DesktopController.prototype), new EventEmitter(), {
      lastPublishedSessionKey: "",
      lastPublishedSubagentActivity: new Map<string, number>(),
      snapshot: vi.fn(async () => ({ sessions: [{ ...session }] }) as DesktopControlSnapshot),
      broadcast: vi.fn(async () => undefined),
    });
    await controller.publish();
    controller.broadcast.mockClear();
    Object.assign(session, change);
    await controller.publish();
    expect(controller.broadcast).toHaveBeenCalledWith({
      kind: "snapshot",
      snapshot: expect.objectContaining({ sessions: [expect.objectContaining(change)] }),
    }, true);
    controller.broadcast.mockClear();
    await controller.publish();
    expect(controller.broadcast).not.toHaveBeenCalled();
  });

  it("pushes removal of a stale subagent count while the main turn stays idle", async () => {
    const session: BridgeSessionInfo = {
      sessionId: "session-1", title: "Session", cwd: "/tmp/project", projectId: "project", projectName: "Project",
      source: "desktop", transport: "bridge-host", ownership: "DESKTOP_OBSERVED", turnState: "idle",
      pendingCount: 0, lastActivityAt: 1, runningSubagents: { count: 2, lastUpdatedAt: 10 },
    };
    const controller = Object.assign(Object.create(DesktopController.prototype), new EventEmitter(), {
      lastPublishedSessionKey: "",
      lastPublishedSubagentActivity: new Map<string, number>(),
      snapshot: vi.fn(async () => ({ sessions: [{ ...session }] }) as DesktopControlSnapshot),
      broadcast: vi.fn(async () => undefined),
    });
    await controller.publish();
    controller.broadcast.mockClear();
    delete session.runningSubagents;
    await controller.publish();
    expect(controller.broadcast).toHaveBeenCalledOnce();
    expect(controller.broadcast.mock.calls[0]?.[0].snapshot.sessions[0]).not.toHaveProperty("runningSubagents");
  });

  it("publishes a Desktop-owned turn ending, which has no mobile event delta", async () => {
    const session: BridgeSessionInfo = {
      sessionId: "session-1", title: "Session", cwd: "/tmp/project",
      projectId: "project", projectName: "Project", source: "desktop",
      transport: "bridge-host", ownership: "DESKTOP_OBSERVED", turnState: "running", pendingCount: 0,
      lastActivityAt: 1, mainTurnStopScope: "process",
    };
    const controller = Object.assign(Object.create(DesktopController.prototype), new EventEmitter(), {
      lastPublishedSessionKey: "",
      lastPublishedSubagentActivity: new Map<string, number>(),
      snapshot: vi.fn(async () => ({ sessions: [{ ...session }] }) as DesktopControlSnapshot),
      broadcast: vi.fn(async () => undefined),
    });
    await controller.publish();
    controller.broadcast.mockClear();
    session.turnState = "idle";
    delete session.mainTurnStopScope;
    await controller.publish();
    expect(controller.broadcast).toHaveBeenCalledWith({
      kind: "snapshot",
      snapshot: expect.objectContaining({ sessions: [expect.objectContaining({ turnState: "idle" })] }),
    }, true);
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
      lastPublishedSubagentActivity: new Map<string, number>(),
      snapshot: vi.fn(async () => ({ sessions: [{ ...session }] }) as DesktopControlSnapshot),
      broadcast: vi.fn(async () => undefined),
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
  });
  it("sends a small session patch for subagent timestamp progress instead of the full catalog", async () => {
    const { controller, sessions } = progressFixture();
    await controller.publish();
    expect(controller.eventLog.append).not.toHaveBeenCalled();
    controller.broadcast.mockClear();

    sessions[0]!.runningSubagents!.lastUpdatedAt = 20;
    sessions[0]!.lastActivityAt = 20;
    await controller.publish();
    expect(controller.broadcast).not.toHaveBeenCalled();
    expect(controller.eventLog.append).toHaveBeenCalledExactlyOnceWith({
      sessionId: "session-0", itemId: "session:subagent-activity", origin: "system", type: "runtime.updated",
      data: { session: { sessionId: "session-0", runningSubagents: { count: 2, lastUpdatedAt: 20 }, lastActivityAt: 20 } },
    });
    expect(Buffer.byteLength(JSON.stringify(controller.eventLog.append.mock.calls[0]![0]))).toBeLessThan(512);

    await controller.publish();
    expect(controller.eventLog.append).toHaveBeenCalledOnce();
  });

  it("publishes independent progress patches for each changed session", async () => {
    const { controller, sessions } = progressFixture();
    sessions[1]!.runningSubagents = { count: 1, lastUpdatedAt: 10 };
    await controller.publish();
    controller.broadcast.mockClear();
    sessions[0]!.runningSubagents!.lastUpdatedAt = 20;
    sessions[1]!.runningSubagents!.lastUpdatedAt = 30;
    await controller.publish();
    expect(controller.broadcast).not.toHaveBeenCalled();
    expect(controller.eventLog.append.mock.calls.map(([event]: [{ sessionId: string }]) => event.sessionId)).toEqual(["session-0", "session-1"]);
    expect(controller.eventLog.append.mock.calls[1]![0].data.session.runningSubagents).toEqual({ count: 1, lastUpdatedAt: 30 });
  });

  it("keeps full synchronization for count changes and then resumes small progress updates", async () => {
    const { controller, sessions } = progressFixture();
    await controller.publish();
    controller.broadcast.mockClear();
    sessions[0]!.runningSubagents = { count: 3, lastUpdatedAt: 20 };
    await controller.publish();
    expect(controller.broadcast).toHaveBeenCalledOnce();
    expect(controller.eventLog.append).not.toHaveBeenCalled();
    controller.broadcast.mockClear();
    sessions[0]!.runningSubagents!.lastUpdatedAt = 30;
    await controller.publish();
    expect(controller.broadcast).not.toHaveBeenCalled();
    expect(controller.eventLog.append.mock.calls[0]![0].data.session.runningSubagents).toEqual({ count: 3, lastUpdatedAt: 30 });
  });

  it("includes progress in a simultaneous metadata snapshot without emitting an extra patch", async () => {
    const { controller, sessions } = progressFixture();
    await controller.publish();
    controller.broadcast.mockClear();
    sessions[0]!.title = "Renamed";
    sessions[0]!.runningSubagents!.lastUpdatedAt = 20;
    await controller.publish();
    expect(controller.broadcast).toHaveBeenCalledOnce();
    expect(controller.eventLog.append).not.toHaveBeenCalled();
    controller.broadcast.mockClear();
    await controller.publish();
    expect(controller.broadcast).not.toHaveBeenCalled();
    expect(controller.eventLog.append).not.toHaveBeenCalled();
  });

  it("persists progress with the shared event sequence and replays it after reopening", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-progress-events-"));
    const path = join(directory, "events.jsonl");
    const log = new SessionEventLog(path);
    const { controller, sessions } = progressFixture();
    controller.eventLog = log;
    try {
      await log.append({ sessionId: "session-1", origin: "claude-host", type: "assistant.completed", data: { text: "Done" } });
      await controller.publish();
      const received = vi.fn();
      log.on("event", received);
      sessions[0]!.runningSubagents!.lastUpdatedAt = 20;
      await controller.publish();
      expect(received).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        seq: 2, sessionId: "session-0", type: "runtime.updated",
        data: { session: { sessionId: "session-0", runningSubagents: { count: 2, lastUpdatedAt: 20 }, lastActivityAt: 1 } },
      }));
      expect(log.history("session-0").items).toEqual([]);
      await log.close();
      const reopened = new SessionEventLog(path);
      try {
        await reopened.initialize();
        expect(reopened.replay(1)).toEqual([received.mock.calls[0]![0]]);
        expect(reopened.latestSeq()).toBe(2);
      } finally {
        await reopened.close();
      }
    } finally {
      await log.close();
      await rm(directory, { recursive: true, force: true });
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
    controller.snapshot.mockImplementation(async () => ({ sessions: structuredClone(sessions), latestSeq: log.latestSeq() }));
    controller.eventLog = { append: async (draft: Parameters<SessionEventLog["append"]>[0]) => {
      const event = await log.append(draft);
      if (draft.sessionId === "session-0") { entered(); await blocked; }
      return event;
    } };
    try {
      await log.initialize();
      await controller.publish();
      sessions[0]!.runningSubagents!.lastUpdatedAt = 20;
      sessions[1]!.runningSubagents!.lastUpdatedAt = 20;
      const progress = controller.publish();
      await firstAppend;
      delete sessions[1]!.runningSubagents;
      await controller.publish();
      const completed = controller.broadcast.mock.calls.at(-1)![0].snapshot;
      expect(completed.sessions[1]).not.toHaveProperty("runningSubagents");
      resume();
      await progress;
      // The client must ignore any delayed progress already covered by the completion snapshot.
      expect(log.replay().find(event => event.sessionId === "session-1")!.seq).toBeLessThanOrEqual(completed.latestSeq);
    } finally {
      resume();
      await log.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("resets progress tracking when a session disappears and returns with the same identity", async () => {
    const { controller, sessions } = progressFixture();
    await controller.publish();
    const removed = sessions.shift()!;
    await controller.publish();
    expect(controller.broadcast.mock.calls.at(-1)![0].snapshot.sessions.some((session: BridgeSessionInfo) => session.sessionId === removed.sessionId)).toBe(false);
    sessions.unshift(removed);
    await controller.publish();
    expect(controller.broadcast.mock.calls.at(-1)![0].snapshot.sessions[0].runningSubagents).toEqual({ count: 2, lastUpdatedAt: 10 });
    controller.broadcast.mockClear();
    removed.runningSubagents!.lastUpdatedAt = 20;
    await controller.publish();
    expect(controller.broadcast).not.toHaveBeenCalled();
    expect(controller.eventLog.append).toHaveBeenCalledOnce();
  });

  it("always sends current complete state to a newly connected phone", async () => {
    const { controller, sessions } = progressFixture();
    await controller.publish();
    sessions[0]!.runningSubagents!.lastUpdatedAt = 20;
    await controller.publish();
    controller.sendToDevice = vi.fn(async () => undefined);
    await controller.sendSnapshot("reconnected-phone");
    expect(controller.sendToDevice).toHaveBeenCalledWith({
      kind: "snapshot",
      snapshot: expect.objectContaining({ sessions: expect.arrayContaining([
        expect.objectContaining({ sessionId: "session-0", runningSubagents: { count: 2, lastUpdatedAt: 20 } }),
      ]) }),
    }, "reconnected-phone", undefined, true);
    expect(controller.sendToDevice.mock.calls[0]![0].snapshot.sessions).toHaveLength(140);
  });
});

function progressFixture() {
  const sessions: BridgeSessionInfo[] = Array.from({ length: 140 }, (_, index) => ({
    sessionId: `session-${index}`, title: `Session ${index} ${"x".repeat(256)}`, cwd: "/tmp/project",
    projectId: "project", projectName: "Project", source: "desktop", transport: "bridge-host",
    ownership: "DESKTOP_OBSERVED", turnState: "idle", pendingCount: 0, lastActivityAt: 1,
    ...(index === 0 ? { runningSubagents: { count: 2, lastUpdatedAt: 10 } } : {}),
  }));
  const controller = Object.assign(Object.create(DesktopController.prototype), new EventEmitter(), {
    lastPublishedSessionKey: "",
    lastPublishedSubagentActivity: new Map<string, number>(),
    snapshot: vi.fn(async () => ({ sessions: structuredClone(sessions) }) as DesktopControlSnapshot),
    broadcast: vi.fn(async () => undefined),
    eventLog: { append: vi.fn(async () => undefined) },
  });
  return { controller, sessions };
}
