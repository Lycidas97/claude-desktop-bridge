import { EventEmitter } from "node:events";
import type { BridgeSessionInfo } from "@bridge/protocol";
import { expect, it, vi } from "vitest";
import { DesktopController } from "./controller.js";

it("publishes handoff control changes without rebroadcasting an unchanged catalog", async () => {
  const session: BridgeSessionInfo = {
    sessionId: "handoff", projectId: "project", projectName: "Project", cwd: "/test/project", title: "Session",
    source: "bridge", transport: "bridge-host", ownership: "BRIDGE_IDLE", turnState: "idle", lastActivityAt: 1, pendingCount: 0,
    desktopHandoff: { state: "bridge", canReturn: false },
  };
  const snapshot = { sessions: [session], latestSeq: 0 };
  const controller = Object.assign(Object.create(DesktopController.prototype), new EventEmitter(), {
    lastPublishedSessionKey: "", lastPublishedSubagentActivity: new Map(),
    snapshot: async () => snapshot, broadcast: vi.fn(async () => {}),
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
});

it("routes a confirmed single-session takeover to the broker", async () => {
  const session = { sessionId: "handoff" };
  const takeoverDesktop = vi.fn(async () => session);
  const controller = Object.assign(Object.create(DesktopController.prototype), {
    broker: { takeoverDesktop }, routesToExternalRuntime: () => false,
  });
  await expect(controller.handleRequest({
    kind: "request", method: "session.takeover_desktop", requestId: "takeover", idempotencyKey: "takeover", params: { sessionId: "handoff" },
  }, "mobile")).resolves.toEqual({ session });
  expect(takeoverDesktop).toHaveBeenCalledWith("handoff");
});

it("routes an explicit return to the broker without launching or quitting Desktop", async () => {
  const session = { sessionId: "handoff", desktopHandoff: { state: "reopen-desktop", canReturn: false } };
  const returnToDesktop = vi.fn(async () => session);
  const controller = Object.assign(Object.create(DesktopController.prototype), {
    broker: { returnToDesktop }, routesToExternalRuntime: () => false,
  });
  await expect(controller.handleRequest({
    kind: "request", method: "session.return_to_desktop", requestId: "return", idempotencyKey: "return", params: { sessionId: "handoff" },
  }, "mobile")).resolves.toEqual({ session });
  expect(returnToDesktop).toHaveBeenCalledWith("handoff");
});
