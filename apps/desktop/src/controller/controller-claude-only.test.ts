import type { BridgeRequest } from "@bridge/protocol";
import { describe, expect, it, vi } from "vitest";
import { DesktopController } from "./controller.js";

const retiredRuntimeIds = ["codex-desktop", "hermes-desktop", "dsh-desktop"] as const;

function fixture() {
  const accessClaude = vi.fn(() => { throw new Error("Claude broker reached by a retired request"); });
  const controller = Object.assign(Object.create(DesktopController.prototype), {
    broker: new Proxy({}, { get: accessClaude }),
  }) as { handleRequest(request: BridgeRequest, origin: "desktop" | "mobile"): Promise<unknown> };
  return { controller, accessClaude };
}

function request(method: BridgeRequest["method"], params: Record<string, unknown>): BridgeRequest {
  return { kind: "request", requestId: "retired-request", idempotencyKey: "retired-request", method, params };
}

describe("Claude-only request boundary", () => {
  it.each(retiredRuntimeIds)("rejects %s runtime requests before reaching Claude", async runtimeId => {
    const { controller, accessClaude } = fixture();
    for (const method of ["session.create", "runtime.refresh", "desktop.app.launch", "desktop.app.quit"] as const) {
      await expect(controller.handleRequest(request(method, { runtimeId, cwd: "/synthetic" }), "mobile"))
        .rejects.toMatchObject({ code: "UNSUPPORTED" });
    }
    expect(accessClaude).not.toHaveBeenCalled();
  });

  it.each(retiredRuntimeIds)("rejects saved %s session requests before reaching Claude", async runtimeId => {
    const { controller, accessClaude } = fixture();
    for (const method of [
      "session.open", "session.history", "session.configuration", "session.configure", "session.rename",
      "session.archive", "session.delete", "session.fork", "session.commands", "session.command",
      "session.rewind.preview", "turn.start", "turn.steer", "turn.interrupt", "turn.queue.cancel", "subagent.stop",
    ] as const) {
      await expect(controller.handleRequest(request(method, { sessionId: `${runtimeId}:saved`, text: "synthetic" }), "desktop"))
        .rejects.toMatchObject({ code: "UNSUPPORTED" });
    }
    expect(accessClaude).not.toHaveBeenCalled();
  });

  it.each([
    "runtime.handoff.preview", "runtime.handoff.commit", "runtime.handoff.confirm", "runtime.handoff.cancel",
    "runtime.handoff.get", "runtime.handoff.list", "runtime.goal.pause", "runtime.goal.resume",
    "runtime.file.open", "permission.policy.configure",
  ] as const)("explicitly retires %s for previously saved callers", async method => {
    const { controller, accessClaude } = fixture();
    await expect(controller.handleRequest(request(method, { handoffId: "saved-handoff" }), "mobile"))
      .rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(accessClaude).not.toHaveBeenCalled();
  });
});
