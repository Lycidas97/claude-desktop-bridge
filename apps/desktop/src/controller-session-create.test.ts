import type { BridgeRequest } from "@bridge/protocol";
import { describe, expect, it, vi } from "vitest";
import { DesktopController } from "./controller.js";

describe("session.create project identity", () => {
  it.each([undefined, "cg-server"])("forwards the optional selected project (%s)", async projectId => {
    const createSession = vi.fn(async () => ({ sessionId: "created" }));
    const controller = Object.assign(Object.create(DesktopController.prototype), { broker: { createSession } }) as {
      handleRequest(request: BridgeRequest, origin: "mobile"): Promise<unknown>;
    };
    await expect(controller.handleRequest({
      kind: "request", method: "session.create", requestId: "create", idempotencyKey: "create",
      params: { cwd: "/shared", title: "Grouped", ...(projectId ? { projectId } : {}) },
    }, "mobile")).resolves.toEqual({ session: { sessionId: "created" } });
    expect(createSession).toHaveBeenCalledWith("/shared", "Grouped", projectId);
  });

  it.each(["", "   ", 42, null])("rejects an explicitly invalid project before creating (%s)", async projectId => {
    const createSession = vi.fn();
    const controller = Object.assign(Object.create(DesktopController.prototype), { broker: { createSession } }) as {
      handleRequest(request: BridgeRequest, origin: "mobile"): Promise<unknown>;
    };
    await expect(controller.handleRequest({
      kind: "request", method: "session.create", requestId: "create", idempotencyKey: "create",
      params: { cwd: "/shared", projectId },
    }, "mobile")).rejects.toThrow(/projectId/u);
    expect(createSession).not.toHaveBeenCalled();
  });

  it("keeps external runtime creation unchanged", async () => {
    const createSession = vi.fn(async () => ({ sessionId: "external" }));
    const controller = Object.assign(Object.create(DesktopController.prototype), { runtimeSessions: { createSession } }) as {
      handleRequest(request: BridgeRequest, origin: "mobile"): Promise<unknown>;
    };
    await controller.handleRequest({
      kind: "request", method: "session.create", requestId: "create", idempotencyKey: "create",
      params: { cwd: "/shared", title: "External", runtimeId: "codex-desktop" },
    }, "mobile");
    expect(createSession).toHaveBeenCalledWith("codex-desktop", "/shared", "External", undefined);
  });

  it("forwards native directory project identity to its owning boundary", async () => {
    const createSession = vi.fn(async () => ({ sessionId: "external" }));
    const controller = Object.assign(Object.create(DesktopController.prototype), { runtimeSessions: { createSession } }) as {
      handleRequest(request: BridgeRequest, origin: "mobile"): Promise<unknown>;
    };
    await controller.handleRequest({
      kind: "request", method: "session.create", requestId: "create", idempotencyKey: "create",
      params: { cwd: "/shared", title: "External", runtimeId: "codex-desktop", projectId: "codex-desktop:/shared" },
    }, "mobile");
    expect(createSession).toHaveBeenCalledWith("codex-desktop", "/shared", "External", "codex-desktop:/shared");
  });
});
