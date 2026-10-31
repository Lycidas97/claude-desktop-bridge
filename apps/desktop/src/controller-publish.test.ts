import { EventEmitter } from "node:events";
import type { BridgeSessionInfo, DesktopControlSnapshot } from "@bridge/protocol";
import { describe, expect, it, vi } from "vitest";
import { DesktopController } from "./controller.js";

describe("mobile snapshot publication", () => {
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
