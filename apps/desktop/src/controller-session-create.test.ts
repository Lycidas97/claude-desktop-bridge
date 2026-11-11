import type { BridgeProjectInfo, BridgeRequest } from "@bridge/protocol";
import { describe, expect, it, vi } from "vitest";
import { DesktopController } from "./controller.js";

describe("section.create", () => {
  const project: BridgeProjectInfo = { projectId: "native-group", name: "Research", kind: "desktop-group", cwd: "", sessionCount: 0, runningCount: 0, pendingCount: 0, lastActivityAt: 0 };
  const request = (name: unknown): BridgeRequest => ({ kind: "request", method: "section.create", requestId: "create-section", idempotencyKey: "create-section", params: { name } });

  it("creates through the native broker and publishes the empty section", async () => {
    const createSection = vi.fn().mockResolvedValue(project);
    const publish = vi.fn().mockResolvedValue({ projects: [project] });
    const controller = Object.assign(Object.create(DesktopController.prototype), { broker: { capabilities: () => ["section.create"], createSection }, publish });
    await expect(controller.handleRequest(request("  Research  "), "mobile")).resolves.toEqual({ project });
    expect(createSection).toHaveBeenCalledExactlyOnceWith("Research");
    expect(publish).toHaveBeenCalledOnce();
  });

  it.each(["", "   ", "x".repeat(201), 42, null])("rejects an invalid name before native creation (%s)", async name => {
    const createSection = vi.fn();
    const controller = Object.assign(Object.create(DesktopController.prototype), { broker: { capabilities: () => ["section.create"], createSection } });
    await expect(controller.handleRequest(request(name), "mobile")).rejects.toThrow(/name/u);
    expect(createSection).not.toHaveBeenCalled();
  });

  it("rejects a forced request when the desktop has no section capability", async () => {
    const createSection = vi.fn();
    const controller = Object.assign(Object.create(DesktopController.prototype), { broker: { capabilities: () => [], createSection } });
    await expect(controller.handleRequest(request("Research"), "mobile")).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(createSection).not.toHaveBeenCalled();
  });

  it("propagates the native failure without publishing success", async () => {
    const publish = vi.fn();
    const controller = Object.assign(Object.create(DesktopController.prototype), { broker: { capabilities: () => ["section.create"], createSection: vi.fn().mockRejectedValue(new Error("Native section limit reached")) }, publish });
    await expect(controller.handleRequest(request("Research"), "mobile")).rejects.toThrow("Native section limit reached");
    expect(publish).not.toHaveBeenCalled();
  });

  it("keeps empty native sections while filtering empty directory shortcuts", () => {
    const controller = Object.assign(Object.create(DesktopController.prototype), {
      broker: { listProjects: () => [project, { ...project, projectId: "directory", kind: "directory" }] }, allSessions: () => [],
    });
    expect(controller.allProjects()).toEqual([project]);
  });
});

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
});
