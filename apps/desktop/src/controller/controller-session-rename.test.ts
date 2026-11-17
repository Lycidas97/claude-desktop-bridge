import type { BridgeRequest, BridgeSessionInfo, BridgeTurnState, DesktopControlSnapshot } from "@bridge/protocol";
import { describe, expect, it, vi } from "vitest";
import { createControllerFixture } from "./controller-fixture.js";

function fixture(turnState: BridgeTurnState = "running", archivedAt?: number) {
  const session: BridgeSessionInfo = {
    sessionId: "native-1", title: "原生标题", cwd: "/workspace/project", projectId: "group-1", projectName: "Project",
    source: "desktop", runtimeId: "claude-desktop", transport: "claude-desktop-native",
    ownership: turnState === "idle" ? "DESKTOP_NATIVE_IDLE" : "DESKTOP_NATIVE_RUNNING", turnState,
    lastActivityAt: 123, pendingCount: 2, pendingCommandIds: ["queued-1", "queued-2"],
    parentSessionId: "parent-1", forkLabel: "fork", model: "model-1", effort: "high",
    ...(archivedAt !== undefined ? { archivedAt } : {}),
  };
  const titles = new Map<string, string>();
  const row = () => ({ ...session, title: titles.get(session.sessionId) ?? session.title });
  const setSessionTitle = vi.fn((id: string, title: string) => titles.set(id, title));
  const controller = createControllerFixture({
    broker: {
      listSessions: () => [row()], session: () => row(),
      refreshDesktopConfiguration: vi.fn(async () => undefined), history: vi.fn(async () => ({ items: [] })),
      rename: vi.fn(async (id: string, title: string) => { setSessionTitle(id, title); }),
    },
    conversationState: { setSessionTitle },
    snapshot: async (): Promise<Pick<DesktopControlSnapshot, "sessions" | "permissions">> => ({ sessions: controller.allSessions(), permissions: [] }),
    claudePermissions: () => [],
    eventLog: { latestSeq: () => 7, append: vi.fn() },
    broadcast: vi.fn(async () => undefined),
  });
  const rename = (title: unknown, id = session.sessionId) => controller.handleRequest({
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
    expect(controller.broadcast).toHaveBeenCalledExactlyOnceWith({ kind: "snapshot", snapshot: { sessions: [{ ...session, title: "手机显示名" }], permissions: [] } }, true);
    expect(controller.eventLog.append).not.toHaveBeenCalled();
    expect(await controller.handleRequest({ kind: "request", requestId: "listing", idempotencyKey: "listing", method: "session.list", params: { search: "手机显示名" } }, "mobile")).toEqual({ sessions: [{ ...session, title: "手机显示名" }] });
    expect(await controller.handleRequest({ kind: "request", requestId: "listing", idempotencyKey: "listing", method: "session.list", params: { search: "原生标题" } }, "mobile")).toEqual({ sessions: [] });
    expect(await controller.handleRequest({ kind: "request", requestId: "open", idempotencyKey: "open", method: "session.open", params: { sessionId: session.sessionId } }, "mobile")).toMatchObject({ session: { ...session, title: "手机显示名" } });
  });

  it.each(["codex-desktop:native-1", "hermes-desktop:native-1"])("rejects saved external runtime identity for %s", async id => {
    const { controller, rename } = fixture();
    await expect(rename("外部显示名", id)).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(controller.conversationState.setSessionTitle).not.toHaveBeenCalled();
    expect(controller.broker.rename).not.toHaveBeenCalled();
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

  it("rejects an unknown session ID without writing", async () => {
    const { controller, rename } = fixture();
    await expect(rename("Name", "missing")).rejects.toThrow("Session not found");
    expect(controller.conversationState.setSessionTitle).not.toHaveBeenCalled();
  });

  it("preserves native archive metadata when renaming", async () => {
    const { session, rename } = fixture("idle", 11);
    expect(await rename("归档名称")).toEqual({ session: { ...session, title: "归档名称" } });
  });

  it("reports persistence failure without publishing success", async () => {
    const { controller, rename } = fixture();
    controller.conversationState.setSessionTitle.mockImplementation(() => { throw new Error("database write failed"); });
    await expect(rename("Name")).rejects.toThrow("database write failed");
    expect(controller.broadcast).not.toHaveBeenCalled();
    expect(controller.allSessions()[0]?.title).toBe("原生标题");
  });

  it("does not publish a title when native rename fails", async () => {
    const { controller, rename } = fixture();
    controller.broker.rename.mockRejectedValueOnce(new Error("transcript is unavailable"));
    await expect(rename("Name")).rejects.toThrow("transcript is unavailable");
    expect(controller.conversationState.setSessionTitle).not.toHaveBeenCalled();
    expect(controller.broadcast).not.toHaveBeenCalled();
  });

  it("rejects rename when persistent state is unavailable", async () => {
    const { controller, rename } = fixture();
    Object.assign(controller, { conversationState: undefined });
    await expect(rename("Name")).rejects.toThrow(/unavailable/u);
    expect(controller.broadcast).not.toHaveBeenCalled();
  });

  it.each([false, true])("advertises rename only with persistent state (available=%s)", async available => {
    const controller = createControllerFixture({
      config: { devices: [], relayEndpoints: [], hostDeviceId: "host", desktopName: "test", relayUrl: "ws://localhost:1" },
      app: { getVersion: () => "test" }, conversationState: available ? {} : undefined,
      allProjects: () => [], allSessions: () => [], deviceSnapshots: () => [],
      broker: { runtimeStatus: () => ({}), magpieSettings: async () => ({}), promptsList: () => [] }, desktopRuntimes: () => [], claudePermissions: () => [],
      eventLog: { latestSeq: () => 0 }, claudeDesktop: { status: async () => ({}) }, desktopAppStatuses: async () => [],
    });
    const snapshot = await controller.snapshot();
    expect(snapshot.host.capabilities.includes("session.rename.v1")).toBe(available);
  });
});
