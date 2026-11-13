import { createRequire } from "node:module";
import { mkdtemp, rm as recycle, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BridgeProjectInfo, BridgeRequest, BridgeSessionInfo } from "@bridge/protocol";
import { describe, expect, it, vi } from "vitest";
import { DesktopController } from "./controller.js";
import { WorkspaceTrustRequiredError } from "../claude/claude-desktop-bridge.js";

// Reuse the repository's Trash-only cleanup on all CI platforms.
createRequire(import.meta.url)("../../../../scripts/recycle-cleanup.cjs");

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

  it.each(["D:\\PARA", "/work/untrusted"])("maps WorkspaceTrustRequiredError to structured codes and forwards trustWorkspace (%s)", async cwd => {
    const createSession = vi.fn()
      .mockRejectedValueOnce(new WorkspaceTrustRequiredError(false))
      .mockRejectedValueOnce(new WorkspaceTrustRequiredError(true))
      .mockResolvedValueOnce({ sessionId: "trusted-session", cwd });
    const controller = Object.assign(Object.create(DesktopController.prototype), { broker: { createSession } }) as {
      handleRequest(request: BridgeRequest, origin: "mobile"): Promise<unknown>;
    };
    const req = (trustWorkspace?: unknown): BridgeRequest => ({
      kind: "request", method: "session.create", requestId: "trust-req", idempotencyKey: "trust-req",
      params: { cwd, title: "Demo", ...(trustWorkspace !== undefined ? { trustWorkspace } : {}) },
    });

    await expect(controller.handleRequest(req(), "mobile")).rejects.toMatchObject({
      code: "WORKSPACE_TRUST_REQUIRED",
      message: expect.not.stringContaining("$eipc_message$"),
    });
    expect(createSession).toHaveBeenNthCalledWith(1, cwd, "Demo", undefined);

    await expect(controller.handleRequest(req(true), "mobile")).rejects.toMatchObject({
      code: "WORKSPACE_TRUST_MANUAL_REQUIRED",
      message: expect.stringContaining("电脑端 Claude 窗口"),
    });
    expect(createSession).toHaveBeenNthCalledWith(2, cwd, "Demo", undefined, true);

    await expect(controller.handleRequest(req(true), "mobile")).resolves.toEqual({
      session: { sessionId: "trusted-session", cwd },
    });

    await expect(controller.handleRequest(req("yes"), "mobile")).rejects.toThrow(/trustWorkspace/u);
  });
});

describe("section.move", () => {
  const section: BridgeProjectInfo = { projectId: "section-zahuo", name: "杂活", kind: "desktop-group", cwd: "", sessionCount: 1, runningCount: 0, pendingCount: 0, lastActivityAt: 1 };
  const moved: BridgeSessionInfo = {
    sessionId: "local-1", title: "Subproject", cwd: "/work/杂活/colab-connect",
    projectId: section.projectId, projectName: section.name, source: "desktop",
    transport: "claude-desktop-native", ownership: "DESKTOP_NATIVE_IDLE", turnState: "idle",
    pendingCount: 0, lastActivityAt: 1,
  };
  const request = (params: Record<string, unknown>): BridgeRequest => ({
    kind: "request", method: "section.move", requestId: "move-section", idempotencyKey: "move-section", params,
  });

  it.each(["section-zahuo", null])("moves a session to %s, publishes and returns authoritative projects", async sectionId => {
    const moveSessionSection = vi.fn().mockResolvedValue(moved);
    const publish = vi.fn().mockResolvedValue({});
    const controller = Object.assign(Object.create(DesktopController.prototype), {
      broker: { capabilities: () => ["section.move"], moveSessionSection, listProjects: () => [section] },
      allSessions: () => [moved],
      publish,
    });
    await expect(controller.handleRequest(request({ sessionId: "local-1", sectionId }), "mobile")).resolves.toEqual({
      session: moved,
      projects: [section],
    });
    expect(moveSessionSection).toHaveBeenCalledExactlyOnceWith("local-1", sectionId);
    expect(publish).toHaveBeenCalledOnce();
  });

  it.each([
    {},
    { sessionId: "local-1" },
    { sessionId: "local-1", sectionId: "" },
    { sessionId: "local-1", sectionId: "   " },
    { sessionId: "local-1", sectionId: 42 },
  ])("rejects invalid move parameters before touching broker (%j)", async params => {
    const moveSessionSection = vi.fn();
    const controller = Object.assign(Object.create(DesktopController.prototype), {
      broker: { capabilities: () => ["section.move"], moveSessionSection },
    });
    await expect(controller.handleRequest(request(params), "mobile")).rejects.toThrow();
    expect(moveSessionSection).not.toHaveBeenCalled();
  });

  it("rejects section.move when the desktop lacks section.move capability", async () => {
    const moveSessionSection = vi.fn();
    const controller = Object.assign(Object.create(DesktopController.prototype), {
      broker: { capabilities: () => [], moveSessionSection },
    });
    await expect(controller.handleRequest(request({ sessionId: "local-1", sectionId: null }), "mobile")).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(moveSessionSection).not.toHaveBeenCalled();
  });
});

describe("section.rename and section.delete", () => {
  const renamedProject: BridgeProjectInfo = { projectId: "section-zahuo", name: "Bridge 维护", kind: "desktop-group", cwd: "", sessionCount: 1, runningCount: 0, pendingCount: 0, lastActivityAt: 1 };
  const session: BridgeSessionInfo = {
    sessionId: "local-1", title: "Subproject", cwd: "/work/杂活/colab-connect",
    projectId: renamedProject.projectId, projectName: renamedProject.name, source: "desktop",
    transport: "claude-desktop-native", ownership: "DESKTOP_NATIVE_IDLE", turnState: "idle",
    pendingCount: 0, lastActivityAt: 1,
  };

  it("renames a section, publishes and returns updated project, projects and sessions", async () => {
    const renameSection = vi.fn().mockResolvedValue(renamedProject);
    const publish = vi.fn().mockResolvedValue({});
    const controller = Object.assign(Object.create(DesktopController.prototype), {
      broker: { capabilities: () => ["section.rename"], renameSection, listProjects: () => [renamedProject] },
      allSessions: () => [session],
      publish,
    });
    await expect(controller.handleRequest({
      kind: "request", method: "section.rename", requestId: "rename-sec", idempotencyKey: "rename-sec",
      params: { sectionId: "  section-zahuo  ", name: "  Bridge 维护  " },
    }, "mobile")).resolves.toEqual({
      project: renamedProject,
      projects: [renamedProject],
      sessions: [session],
    });
    expect(renameSection).toHaveBeenCalledExactlyOnceWith("section-zahuo", "Bridge 维护");
    expect(publish).toHaveBeenCalledOnce();
  });

  it("deletes a section, publishes and returns updated projects and ungrouped sessions", async () => {
    const deleteSection = vi.fn().mockResolvedValue(undefined);
    const publish = vi.fn().mockResolvedValue({});
    const fallbackProject: BridgeProjectInfo = { projectId: "proj-colab", name: "colab-connect", cwd: "/work/杂活/colab-connect", sessionCount: 1, runningCount: 0, pendingCount: 0, lastActivityAt: 1 };
    const ungroupedSession = { ...session, projectId: fallbackProject.projectId, projectName: fallbackProject.name };
    const controller = Object.assign(Object.create(DesktopController.prototype), {
      broker: { capabilities: () => ["section.delete"], deleteSection, listProjects: () => [fallbackProject] },
      allSessions: () => [ungroupedSession],
      publish,
    });
    await expect(controller.handleRequest({
      kind: "request", method: "section.delete", requestId: "delete-sec", idempotencyKey: "delete-sec",
      params: { sectionId: "  section-zahuo  " },
    }, "mobile")).resolves.toEqual({
      projects: [fallbackProject],
      sessions: [ungroupedSession],
    });
    expect(deleteSection).toHaveBeenCalledExactlyOnceWith("section-zahuo");
    expect(publish).toHaveBeenCalledOnce();
  });

  it("rejects unsupported or malformed section.rename and section.delete requests", async () => {
    const renameSection = vi.fn();
    const deleteSection = vi.fn();
    const unsupported = Object.assign(Object.create(DesktopController.prototype), {
      broker: { capabilities: () => [], renameSection, deleteSection },
    });
    await expect(unsupported.handleRequest({
      kind: "request", method: "section.rename", requestId: "r1", idempotencyKey: "r1", params: { sectionId: "s1", name: "Next" },
    }, "mobile")).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(unsupported.handleRequest({
      kind: "request", method: "section.delete", requestId: "d1", idempotencyKey: "d1", params: { sectionId: "s1" },
    }, "mobile")).rejects.toMatchObject({ code: "UNSUPPORTED" });

    const capable = Object.assign(Object.create(DesktopController.prototype), {
      broker: { capabilities: () => ["section.rename", "section.delete"], renameSection, deleteSection },
    });
    for (const badRename of [{ sectionId: "", name: "Next" }, { sectionId: "s1", name: "   " }, { sectionId: "s1", name: "x".repeat(201) }]) {
      await expect(capable.handleRequest({
        kind: "request", method: "section.rename", requestId: "r2", idempotencyKey: "r2", params: badRename,
      }, "mobile")).rejects.toThrow();
    }
    await expect(capable.handleRequest({
      kind: "request", method: "section.delete", requestId: "d2", idempotencyKey: "d2", params: { sectionId: "   " },
    }, "mobile")).rejects.toThrow();
    expect(renameSection).not.toHaveBeenCalled();
    expect(deleteSection).not.toHaveBeenCalled();
  });
});

describe("directory.mkdir", () => {
  const request = (parentPath: unknown, name: unknown): BridgeRequest => ({
    kind: "request", method: "directory.mkdir", requestId: "mkdir", idempotencyKey: "mkdir", params: { parentPath, name },
  });

  it("creates a single-level subdirectory inside an accessible parent and enters an existing real directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-mkdir-"));
    try {
      const controller = Object.create(DesktopController.prototype) as { handleRequest(request: BridgeRequest, origin: "mobile"): Promise<{ path: string }> };
      const created = await controller.handleRequest(request(root, "  colab-connect  "), "mobile");
      expect(created.path).toBe(join(root, "colab-connect"));
      expect((await stat(created.path)).isDirectory()).toBe(true);

      const idempotent = await controller.handleRequest(request(root, "colab-connect"), "mobile");
      expect(idempotent.path).toBe(created.path);
    } finally {
      await recycle(root, { recursive: true, force: true });
    }
  });

  it.each(["", "   ", ".", "..", "a/b", "a\\b", "bad\0name", "x".repeat(256)])("rejects illegal single-level folder name (%j)", async name => {
    const root = await mkdtemp(join(tmpdir(), "bridge-mkdir-invalid-"));
    try {
      const controller = Object.create(DesktopController.prototype) as { handleRequest(request: BridgeRequest, origin: "mobile"): Promise<unknown> };
      await expect(controller.handleRequest(request(root, name), "mobile")).rejects.toThrow();
    } finally {
      await recycle(root, { recursive: true, force: true });
    }
  });

  it("rejects inaccessible or relative parents and existing non-directory entries (files and symlinks)", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-mkdir-conflict-"));
    try {
      const controller = Object.create(DesktopController.prototype) as { handleRequest(request: BridgeRequest, origin: "mobile"): Promise<unknown> };
      await expect(controller.handleRequest(request("relative/parent", "demo"), "mobile")).rejects.toThrow("absolute");
      await expect(controller.handleRequest(request(join(root, "missing"), "demo"), "mobile")).rejects.toThrow();

      await writeFile(join(root, "README.md"), "file");
      await expect(controller.handleRequest(request(root, "README.md"), "mobile")).rejects.toThrow("非目录项");

      const realSub = await controller.handleRequest(request(root, "real-dir"), "mobile") as { path: string };
      await symlink(realSub.path, join(root, "linked-dir"));
      await expect(controller.handleRequest(request(root, "linked-dir"), "mobile")).rejects.toThrow("非目录项");
    } finally {
      await recycle(root, { recursive: true, force: true });
    }
  });
});
