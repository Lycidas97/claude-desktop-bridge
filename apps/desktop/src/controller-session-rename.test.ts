import { EventEmitter } from "node:events";
import type { BridgeRequest, BridgeSessionInfo, BridgeTurnState } from "@bridge/protocol";
import { describe, expect, it, vi } from "vitest";
import { DesktopController } from "./controller.js";

function fixture(turnState: BridgeTurnState = "running", sessionId = "native-1") {
  const session: BridgeSessionInfo = {
    sessionId, title: "原生标题", cwd: "/workspace/project", projectId: "group-1", projectName: "Project",
    source: "desktop", transport: "bridge-host", ownership: "DESKTOP_OBSERVED", turnState,
    lastActivityAt: 123, pendingCount: 2, pendingCommandIds: ["queued-1", "queued-2"],
    parentSessionId: "parent-1", forkLabel: "fork", model: "model-1", effort: "high",
  };
  const titles = new Map<string, string>();
  const row = () => ({ ...session, title: titles.get(sessionId) ?? session.title });
  const external = sessionId.includes(":");
  const controller = Object.assign(Object.create(DesktopController.prototype), new EventEmitter(), {
    broker: {
      listSessions: () => external ? [] : [row()], session: () => row(),
      refreshDesktopConfiguration: vi.fn(async () => undefined), history: vi.fn(async () => ({ items: [] })),
      rename: vi.fn(async (id: string, title: string) => { controller.conversationState.setSessionTitle(id, title); }),
    },
    runtimeSessions: external ? { listSessions: () => [row()], session: () => row(), history: vi.fn(async () => ({ items: [] })) } : undefined,
    conversationState: { setSessionTitle: vi.fn((id: string, title: string) => titles.set(id, title)) },
    sessionVisibility: new Map(), desktopArchiveRequests: new Map(),
    lastPublishedSessionKey: "", lastPublishedSubagentActivity: new Map(),
    eventLog: { latestSeq: () => 7, append: vi.fn() },
    broadcast: vi.fn(async () => undefined),
  });
  controller.snapshot = async () => ({ sessions: controller.allSessions() });
  const rename = (title: unknown, id = sessionId) => controller.handleRequest({
    kind: "request", method: "session.rename", requestId: "rename-1", idempotencyKey: "rename-1", params: { sessionId: id, title },
  } as BridgeRequest, "mobile");
  return { controller, session, rename };
}

describe("session.rename", () => {
  it.each(["running", "waiting", "queued", "idle"] as const)("trims and publishes the canonical title while preserving %s state", async state => {
    const { controller, session, rename } = fixture(state);
    await controller.publish();
    controller.broadcast.mockClear();
    expect(await rename("  手机显示名  ")).toEqual({ session: { ...session, title: "手机显示名" } });
    expect(controller.broker.rename).toHaveBeenCalledExactlyOnceWith(session.sessionId, "手机显示名");
    expect(controller.conversationState.setSessionTitle).toHaveBeenCalledExactlyOnceWith(session.sessionId, "手机显示名");
    expect(controller.broadcast).toHaveBeenCalledExactlyOnceWith({ kind: "snapshot", snapshot: { sessions: [{ ...session, title: "手机显示名" }] } }, true);
    expect(await controller.handleRequest({ method: "session.list", params: { search: "手机显示名" } }, "mobile")).toEqual({ sessions: [{ ...session, title: "手机显示名" }] });
    expect(await controller.handleRequest({ method: "session.list", params: { search: "原生标题" } }, "mobile")).toEqual({ sessions: [] });
    expect(await controller.handleRequest({ method: "session.open", params: { sessionId: session.sessionId } }, "mobile")).toMatchObject({ session: { ...session, title: "手机显示名" } });
  });

  it.each(["codex-desktop:native-1", "hermes-desktop:native-1"])("uses full external runtime identity for %s", async id => {
    const { controller, session, rename } = fixture("running", id);
    expect(await rename("外部显示名")).toEqual({ session: { ...session, title: "外部显示名" } });
    expect(controller.conversationState.setSessionTitle).toHaveBeenCalledWith(id, "外部显示名");
    expect(await controller.handleRequest({ method: "session.open", params: { sessionId: id } }, "mobile")).toMatchObject({ session: { title: "外部显示名" } });
  });

  it.each(["", " \n\t ", null, 42, undefined])("rejects invalid title %j before writing", async title => {
    const { controller, rename } = fixture();
    await expect(rename(title)).rejects.toThrow(/title/u);
    expect(controller.conversationState.setSessionTitle).not.toHaveBeenCalled();
    expect(controller.broadcast).not.toHaveBeenCalled();
  });

  it("does not write or broadcast an unchanged normalized title", async () => {
    const { controller, session, rename } = fixture();
    expect(await rename(`  ${session.title}  `)).toEqual({ session });
    expect(controller.conversationState.setSessionTitle).not.toHaveBeenCalled();
    expect(controller.broadcast).not.toHaveBeenCalled();
  });

  it("rejects unknown and deleted IDs while preserving archived metadata", async () => {
    const { controller, session, rename } = fixture();
    await expect(rename("Name", "missing")).rejects.toThrow("Session not found");
    controller.sessionVisibility.set(session.sessionId, { visibility: "deleted", updatedAt: 10 });
    await expect(rename("Name")).rejects.toThrow("Session not found");
    expect(controller.conversationState.setSessionTitle).not.toHaveBeenCalled();
    controller.sessionVisibility.set(session.sessionId, { visibility: "archived", updatedAt: 11 });
    expect(await rename("归档名称")).toEqual({ session: { ...session, title: "归档名称", archivedAt: 11 } });
  });

  it("reports persistence failure without publishing success", async () => {
    const { controller, rename } = fixture();
    controller.conversationState.setSessionTitle.mockImplementation(() => { throw new Error("database write failed"); });
    await expect(rename("Name")).rejects.toThrow("database write failed");
    expect(controller.broadcast).not.toHaveBeenCalled();
    expect(controller.allSessions()[0].title).toBe("原生标题");
  });

  it("does not publish a title when SDK persistence fails", async () => {
    const { controller, rename } = fixture();
    controller.broker.rename.mockRejectedValueOnce(new Error("transcript is unavailable"));
    await expect(rename("Name")).rejects.toThrow("transcript is unavailable");
    expect(controller.conversationState.setSessionTitle).not.toHaveBeenCalled();
    expect(controller.broadcast).not.toHaveBeenCalled();
  });

  it("rejects rename when persistent state is unavailable", async () => {
    const { controller, rename } = fixture();
    controller.conversationState = undefined;
    await expect(rename("Name")).rejects.toThrow(/unavailable/u);
    expect(controller.broadcast).not.toHaveBeenCalled();
  });

  it.each([false, true])("advertises rename only with persistent state (available=%s)", async available => {
    const controller = Object.assign(Object.create(DesktopController.prototype), {
      config: { devices: [], relayEndpoints: [], hostDeviceId: "host", desktopName: "test", relayUrl: "ws://localhost:1" },
      app: { getVersion: () => "test" }, conversationState: available ? {} : undefined,
      allProjects: () => [], allSessions: () => [], deviceSnapshots: () => [],
      broker: { runtimeStatus: () => ({}), magpieSettings: async () => ({}) }, desktopRuntimes: () => [], claudePermissions: () => [],
      eventLog: { latestSeq: () => 0 }, claudeDesktop: { status: async () => ({}) }, desktopAppStatuses: async () => [],
    });
    const snapshot = await controller.snapshot();
    expect(snapshot.host.capabilities.includes("session.rename.v1")).toBe(available);
  });
});
