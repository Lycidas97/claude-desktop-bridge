import type { BridgeRequest } from "@bridge/protocol";
import { expect, it, vi } from "vitest";
import { DesktopController } from "./controller.js";

it.each([
  ["turn.queue.steer", false], ["turn.queue.steer", true],
  ["turn.queue.cancel", false], ["turn.queue.cancel", true],
] as const)("routes %s by original identity (external=%s)", async (method, external) => {
  const state = method === "turn.queue.cancel" ? "cancelled" : "queued";
  const operation = vi.fn(async () => ({ commandId: "queued-command", state }));
  const startTurn = vi.fn();
  const interruptTurn = vi.fn();
  const controller = Object.assign(Object.create(DesktopController.prototype), {
    broker: { steerQueuedTurn: operation, cancelQueuedTurn: operation, startTurn, interruptTurn },
  }) as { handleRequest(request: BridgeRequest, origin: "mobile"): Promise<unknown> };
  const request: BridgeRequest = { kind: "request", method, requestId: "queue-action", idempotencyKey: "queue-action", params: { sessionId: external ? "codex-desktop:saved" : "session", commandId: "queued-command" } };
  if (external) {
    await expect(controller.handleRequest(request, "mobile")).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(operation).not.toHaveBeenCalled();
  } else {
    await expect(controller.handleRequest(request, "mobile")).resolves.toEqual({ commandId: "queued-command", state });
    expect(operation).toHaveBeenCalledWith("session", "queued-command");
  }
  expect(startTurn).not.toHaveBeenCalled();
  expect(interruptTurn).not.toHaveBeenCalled();
});
