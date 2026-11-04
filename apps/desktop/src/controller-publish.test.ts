import { EventEmitter } from "node:events";
import type { BridgeSessionInfo, DesktopControlSnapshot } from "@bridge/protocol";
import { describe, expect, it, vi } from "vitest";
import { DesktopController } from "./controller.js";

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
});
