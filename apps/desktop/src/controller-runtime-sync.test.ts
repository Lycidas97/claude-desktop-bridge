import { EventEmitter } from "node:events";
import type { BridgeSessionInfo, DesktopControlSnapshot } from "@bridge/protocol";
import { expect, it, vi } from "vitest";
import { DesktopController } from "./controller.js";

function fixture() {
  const sessions: BridgeSessionInfo[] = Array.from({ length: 226 }, (_, index) => ({
    sessionId: `synthetic-${index}`, title: `Session ${index} ${"s".repeat(500)}`, cwd: "/synthetic",
    projectId: "synthetic", projectName: "Synthetic", source: "desktop", transport: "claude-desktop-managed",
    ownership: "DESKTOP_OBSERVED", turnState: "idle", pendingCount: 0, lastActivityAt: 1,
  }));
  const runtime = { state: "ready", detail: "Ready", activeTurns: 0, maxParallelTurns: 2 };
  const controller = Object.assign(Object.create(DesktopController.prototype), new EventEmitter(), {
    lastPublishedSessionKey: "", lastPublishedSessions: new Map<string, string>(),
    snapshot: vi.fn(async () => ({ sessions: structuredClone(sessions), runtime }) as DesktopControlSnapshot),
    broadcast: vi.fn(async () => undefined), eventLog: { append: vi.fn(async () => undefined) },
  });
  return { controller, sessions, runtime };
}

it("sends six small session replacements instead of six catalogs for native runtime transitions", async () => {
  const { controller, sessions } = fixture();
  await controller.publish();
  controller.broadcast.mockClear();
  for (let index = 0; index < 6; index += 1) {
    sessions[0]!.turnState = index % 2 === 0 ? "running" : "idle";
    if (index % 2 === 0) sessions[0]!.mainTurnStopScope = "process";
    else delete sessions[0]!.mainTurnStopScope;
    await controller.publish();
  }
  expect(controller.broadcast).not.toHaveBeenCalled();
  expect(controller.eventLog.append).toHaveBeenCalledTimes(6);
  const events = controller.eventLog.append.mock.calls.map(([event]: [unknown]) => JSON.parse(JSON.stringify(event)));
  expect(events[0].data).toMatchObject({ replaceSession: true, session: { sessionId: "synthetic-0", turnState: "running", mainTurnStopScope: "process" } });
  expect(events[5].data.session).toMatchObject({ turnState: "idle" });
  expect(events[5].data.session).not.toHaveProperty("mainTurnStopScope");
  expect(Buffer.byteLength(JSON.stringify(events))).toBeLessThan(10_000);
  await controller.publish();
  expect(controller.eventLog.append).toHaveBeenCalledTimes(6);
});

it("preserves full snapshots for global runtime capacity changes", async () => {
  const { controller, runtime } = fixture();
  await controller.publish();
  controller.broadcast.mockClear();
  runtime.activeTurns = 1;
  runtime.state = "working";
  await controller.publish();
  expect(controller.broadcast).toHaveBeenCalledOnce();
  expect(controller.eventLog.append).not.toHaveBeenCalled();
});

it.each(["title", "parent", "sidechat", "archive"])("preserves full synchronization for %s metadata changes", async kind => {
  const { controller, sessions } = fixture();
  await controller.publish();
  controller.broadcast.mockClear();
  if (kind === "title") sessions[0]!.title = "Renamed";
  if (kind === "parent") sessions[0]!.parentSessionId = sessions[1]!.sessionId;
  if (kind === "sidechat") sessions[0]!.sidechat = true;
  if (kind === "archive") sessions[0]!.archivedAt = 2;
  await controller.publish();
  expect(controller.broadcast).toHaveBeenCalledOnce();
  expect(controller.eventLog.append).not.toHaveBeenCalled();
});
