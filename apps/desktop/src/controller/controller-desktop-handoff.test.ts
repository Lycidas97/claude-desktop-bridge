import { EventEmitter } from "node:events";
import type { BridgeSessionInfo } from "@bridge/protocol";
import { expect, it, vi } from "vitest";
import { DesktopController } from "./controller.js";

vi.mock("electron", () => ({ shell: {} }));

it("publishes handoff control changes without rebroadcasting an unchanged catalog", async () => {
  const session: BridgeSessionInfo = {
    sessionId: "handoff", projectId: "project", projectName: "Project", cwd: "/test/project", title: "Session",
    source: "bridge", transport: "bridge-host", ownership: "BRIDGE_IDLE", turnState: "idle", lastActivityAt: 1, pendingCount: 0,
    desktopHandoff: { state: "bridge", canReturn: false },
  };
  const snapshot = { sessions: [session], permissions: [], latestSeq: 0 };
  const controller = Object.assign(Object.create(DesktopController.prototype), new EventEmitter(), {
    lastPublishedSessionKey: "", lastPublishedSessions: new Map<string, string>(),
    lastPublishedPermissions: new Map(), claudePermissions: () => [],
    snapshot: async () => snapshot, broadcast: vi.fn(async () => {}),
    eventLog: { append: vi.fn(async () => undefined) },
  });
  await controller.publish();
  controller.broadcast.mockClear();
  session.desktopHandoff = { state: "bridge", canReturn: true };
  await controller.publish();
  expect(controller.broadcast).toHaveBeenCalledOnce();
  session.desktopHandoff = { state: "reopen-desktop", canReturn: false };
  await controller.publish();
  expect(controller.broadcast).toHaveBeenCalledTimes(2);
  delete session.desktopHandoff;
  await controller.publish();
  expect(controller.broadcast).toHaveBeenCalledTimes(3);
  await controller.publish();
  expect(controller.broadcast).toHaveBeenCalledTimes(3);
  expect(controller.eventLog.append).not.toHaveBeenCalled();
});
