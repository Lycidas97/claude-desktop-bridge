import type { BridgeRequest } from "@bridge/protocol";
import { expect, it, vi } from "vitest";
import { DesktopController } from "./controller.js";

it.each([false, true])("routes queued steering by identity and rejects external runtime queues (external=%s)", async external => {
  const steerQueuedTurn = vi.fn(async () => ({ commandId: "queued-command", state: "queued" }));
  const startTurn = vi.fn();
  const controller = Object.assign(Object.create(DesktopController.prototype), {
    broker: { steerQueuedTurn, startTurn },
    routesToExternalRuntime: () => external,
  }) as { handleRequest(request: BridgeRequest, origin: "mobile"): Promise<unknown> };
  const request: BridgeRequest = { kind: "request", method: "turn.queue.steer", requestId: "promote", idempotencyKey: "promote", params: { sessionId: "session", commandId: "queued-command" } };
  if (external) {
    await expect(controller.handleRequest(request, "mobile")).rejects.toThrow("不支持调整已排队消息");
    expect(steerQueuedTurn).not.toHaveBeenCalled();
  } else {
    await expect(controller.handleRequest(request, "mobile")).resolves.toEqual({ commandId: "queued-command", state: "queued" });
    expect(steerQueuedTurn).toHaveBeenCalledWith("session", "queued-command");
  }
  expect(startTurn).not.toHaveBeenCalled();
});
