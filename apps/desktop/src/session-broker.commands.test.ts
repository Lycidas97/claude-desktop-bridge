import { beforeEach, expect, it, vi } from "vitest";
import type { BridgeSlashCommand } from "@bridge/protocol";
import { SessionBroker } from "./session-broker.js";

const { renameSDK, resolveSettings } = vi.hoisted(() => ({ renameSDK: vi.fn(async () => {}), resolveSettings: vi.fn(async () => ({ effective: { permissions: { allow: ["Read"], deny: ["Bash(rm *)"] } } })) }));
vi.mock("@anthropic-ai/claude-agent-sdk", async (original) => ({ ...await original<object>(), renameSession: renameSDK, resolveSettings }));
vi.mock("./slash-command-catalog.js", () => ({ discoverSlashCommands: vi.fn(async () => ({ commands: [{ name: "disk-only", description: "From disk" }] })) }));
beforeEach(() => vi.clearAllMocks());

function fixture() {
  const session = { sessionId: "logical", cwd: "/fixture", title: "Original", runtimeId: "claude-desktop" };
  const host = {
    slashCommands: [{ name: "context", description: "Real context" }, { name: "compact", description: "Compact", aliases: ["summarize"] }] as BridgeSlashCommand[],
    getPermissions: vi.fn(() => ({ mode: "default", rules: { allow: [], ask: [], deny: [] } })),
    setPermissions: vi.fn(async () => {}),
  };
  const state = { ownership: "BRIDGE_IDLE", turnState: "idle", host };
  const broker = Object.assign(Object.create(SessionBroker.prototype), {
    options: { paths: { projects: "/fixture/projects" }, conversationState: { activeLane: () => ({ nativeSessionId: "native" }), setSessionTitle: vi.fn() } },
    runtimeStates: new Map([[session.sessionId, state]]),
    session: vi.fn((id: string) => id === session.sessionId ? session : undefined),
    listSessions: vi.fn(() => [session]),
    startTurn: vi.fn(async () => ({ state: "queued" })),
    configureSession: vi.fn(async () => ({ appliesAfterTurn: true })),
    forkSession: vi.fn(async () => ({ ...session, sessionId: "fork" })),
    bridgeSessions: new Map([[session.sessionId, { ...session }]]),
    saveSessions: vi.fn(async () => {}), emit: vi.fn(), scheduleRelease: vi.fn(),
  });
  const input = (text: string) => ({ sessionId: session.sessionId, text, requestId: "request", idempotencyKey: "key", origin: "mobile" as const });
  return { broker, session, state, host, input };
}

it("uses the live SDK catalog, replaces removed disk entries, and does not start a host", async () => {
  const f = fixture();
  const catalog = await f.broker.commands("logical");
  expect(catalog.commands).toContainEqual(expect.objectContaining({ name: "context", description: "Real context" }));
  expect(catalog.commands.some((command: { name: string }) => command.name === "disk-only")).toBe(false);
  f.host.slashCommands = [];
  expect((await f.broker.commands("logical")).commands.find((command: { name: string }) => command.name === "context")?.unavailableReason).toBeTruthy();
});

it("queues SDK commands with their arguments and original idempotency identity", async () => {
  const f = fixture();
  await expect(f.broker.runCommand(f.input("/compact keep the API details"))).resolves.toEqual({ action: "sent" });
  expect(f.broker.startTurn).toHaveBeenCalledWith(expect.objectContaining({ text: "/compact keep the API details", requestId: "request", idempotencyKey: "key", mode: "start" }));
  await f.broker.runCommand(f.input("/summarize keep context"));
  expect(f.broker.startTurn).toHaveBeenLastCalledWith(expect.objectContaining({ text: "/compact keep context" }));
});

it("rejects unsupported and Native-only builtins instead of sending them as model prompts", async () => {
  const f = fixture();
  await expect(f.broker.runCommand(f.input("/usage"))).rejects.toThrow();
  await expect(f.broker.runCommand(f.input("/unknown-command"))).rejects.toThrow();
  delete (f.state as { host?: unknown }).host;
  await expect(f.broker.runCommand(f.input("/compact"))).rejects.toThrow();
  expect(f.broker.startTurn).not.toHaveBeenCalled();
});

it("returns real UI actions and validates models through the current catalog", async () => {
  const f = fixture();
  await expect(f.broker.runCommand(f.input("/model"))).resolves.toEqual({ action: "model" });
  await expect(f.broker.runCommand(f.input("/permissions"))).resolves.toEqual({ action: "permissions" });
  await expect(f.broker.runCommand(f.input("/resume"))).resolves.toEqual({ action: "resume", sessions: [f.session] });
  await expect(f.broker.runCommand(f.input("/resume logical"))).resolves.toEqual({ action: "session", session: f.session });
  await expect(f.broker.runCommand(f.input("/fork branch"))).resolves.toMatchObject({ action: "session", session: { sessionId: "fork" } });
  expect(f.broker.forkSession).toHaveBeenCalledWith("logical", "branch");
  expect(f.broker.startTurn).not.toHaveBeenCalled();
});

it("reconnects an idle SDK host only for an explicitly submitted command", async () => {
  const f = fixture();
  delete (f.state as { host?: unknown }).host;
  f.broker.initialize = vi.fn(async () => {});
  f.broker.activeLane = vi.fn(() => ({ laneId: "lane", nativeSessionId: "native" }));
  f.broker.options.observer = { canStartBridgeHost: vi.fn(async () => true) };
  f.broker.assertBridgeHostCompatible = vi.fn(async () => {});
  f.broker.ensureHost = vi.fn(async () => {
    (f.state as { host?: unknown }).host = f.host;
    return f.host;
  });
  const catalog = await f.broker.commands("logical");
  expect(catalog.commands.find((command: { name: string }) => command.name === "context")?.unavailableReason).toBeUndefined();
  expect(f.broker.ensureHost).not.toHaveBeenCalled();
  await expect(f.broker.runCommand(f.input("/context"))).resolves.toEqual({ action: "sent" });
  expect(f.broker.options.observer.canStartBridgeHost).toHaveBeenCalledWith("native", false);
  expect(f.broker.ensureHost).toHaveBeenCalledWith("logical", "lane");
  expect(f.broker.startTurn).toHaveBeenCalledWith(expect.objectContaining({ text: "/context", slashCommand: true }));
});

it("persists rename to the active native session before updating the Bridge title", async () => {
  const f = fixture();
  await expect(f.broker.runCommand(f.input("/rename New title"))).resolves.toMatchObject({ action: "message" });
  expect(renameSDK).toHaveBeenCalledWith("native", "New title", { dir: "/fixture" });
  expect(f.broker.options.conversationState.setSessionTitle).toHaveBeenCalledWith("logical", "New title");
});

it.each(["", "/", "//context", "/tmp/file", "/context\\path", "text /context", "/context\u0000"])("[edge] rejects invalid command text %j without SDK execution", async text => {
  const f = fixture();
  await expect(f.broker.runCommand(f.input(text))).rejects.toThrow();
  expect(f.broker.startTurn).not.toHaveBeenCalled();
  expect(f.broker.configureSession).not.toHaveBeenCalled();
});

it.each(["/CONTEXT", "/Context", "/SUMMARIZE 保留参数"])("[edge] uses the same case-insensitive lookup as the client for %s", async text => {
  const f = fixture();
  await expect(f.broker.runCommand(f.input(text))).resolves.toEqual({ action: "sent" });
  expect(f.broker.startTurn).toHaveBeenCalledWith(expect.objectContaining({ text: text.includes("SUMMARIZE") ? "/compact 保留参数" : "/context", slashCommand: true }));
});

it("[edge] preserves multiline arguments when executing an alias", async () => {
  const f = fixture();
  await f.broker.runCommand(f.input("/summarize\t保留 API\n  第二行  保留缩进"));
  expect(f.broker.startTurn).toHaveBeenCalledWith(expect.objectContaining({ text: "/compact 保留 API\n  第二行  保留缩进" }));
});

it("[edge] does not expose cached SDK-only commands as executable after Native takes ownership", async () => {
  const f = fixture();
  f.host.slashCommands.push({ name: "custom-sdk", description: "SDK skill" });
  await f.broker.commands("logical");
  delete (f.state as { host?: unknown }).host;
  f.state.ownership = "DESKTOP_OBSERVED";
  const catalog = await f.broker.commands("logical");
  expect(catalog.commands.find((command: BridgeSlashCommand) => command.name === "custom-sdk")?.unavailableReason).toBeTruthy();
  await expect(f.broker.runCommand(f.input("/custom-sdk"))).rejects.toThrow();
  expect(f.broker.startTurn).not.toHaveBeenCalled();
});

it.each(["OWNERSHIP_CONFLICT", "RELEASING", "ACQUIRING"])("[edge] blocks SDK controls while the existing host is %s", async ownership => {
  const f = fixture();
  f.state.ownership = ownership;
  await expect(f.broker.runCommand(f.input("/context"))).rejects.toThrow();
  await expect(f.broker.configurePermissions("logical", "plan", { allow: [], ask: [], deny: [] })).rejects.toThrow();
  expect(f.host.setPermissions).not.toHaveBeenCalled();
  expect(f.broker.startTurn).not.toHaveBeenCalled();
  await expect(f.broker.runCommand(f.input("/help"))).resolves.toMatchObject({ action: "help" });
});

it.each(["/new", "/NEW"])("[edge] executes clear alias %s with the actual SDK command", async text => {
  const f = fixture();
  f.host.slashCommands.push({ name: "clear", description: "New context" });
  await f.broker.runCommand(f.input(text));
  expect(f.broker.startTurn).toHaveBeenCalledWith(expect.objectContaining({ text: "/clear", slashCommand: true }));
});

it("[edge] rejects a command removed by SDK initialization without queueing model text", async () => {
  const f = fixture();
  f.broker.commandHost = vi.fn(async () => { f.host.slashCommands = []; return f.host; });
  await expect(f.broker.runCommand(f.input("/context"))).rejects.toThrow("当前 SDK 未提供此命令");
  expect(f.broker.startTurn).not.toHaveBeenCalled();
});

it("[edge] gives an exact resume ID priority over another session's matching title", async () => {
  const f = fixture();
  f.broker.listSessions.mockReturnValue([f.session, { ...f.session, sessionId: "other", title: f.session.sessionId }]);
  await expect(f.broker.runCommand(f.input("/resume logical"))).resolves.toEqual({ action: "session", session: f.session });
});

it("[edge] rejects ambiguous resume names and excludes other working directories", async () => {
  const f = fixture();
  f.broker.listSessions.mockReturnValue([f.session, { ...f.session, sessionId: "other" }, { ...f.session, sessionId: "outside", title: "Outside", cwd: "/outside" }]);
  await expect(f.broker.runCommand(f.input("/resume Original"))).rejects.toThrow("无法唯一匹配");
  await expect(f.broker.runCommand(f.input("/resume outside"))).rejects.toThrow("无法唯一匹配");
  expect(f.broker.startTurn).not.toHaveBeenCalled();
});

it("[edge] validates model arguments and returns pending versus applied feedback", async () => {
  const f = fixture();
  f.broker.configuration = vi.fn(async () => ({ availableModels: [{ value: "supported-model" }] }));
  await expect(f.broker.runCommand(f.input("/model nonexistent"))).rejects.toThrow("支持的模型");
  expect(f.broker.configureSession).not.toHaveBeenCalled();
  await expect(f.broker.runCommand(f.input("/model supported-model"))).resolves.toMatchObject({ action: "message", message: expect.stringContaining("下一轮") });
  f.broker.configureSession.mockResolvedValueOnce({ appliesAfterTurn: false });
  await expect(f.broker.runCommand(f.input("/model supported-model"))).resolves.toEqual({ action: "message", message: "模型已切换" });
});

it("[edge] keeps the Bridge title when SDK rename fails", async () => {
  const f = fixture();
  renameSDK.mockRejectedValueOnce(new Error("transcript is not writable"));
  await expect(f.broker.runCommand(f.input("/rename New title"))).rejects.toThrow("not writable");
  expect(f.broker.options.conversationState.setSessionTitle).not.toHaveBeenCalled();
  expect(f.broker.saveSessions).not.toHaveBeenCalled();
  expect(f.broker.bridgeSessions.get("logical").title).toBe("Original");
});

it.each(["/context", "/compact", "/clear", "/permissions"])("keeps a visible Native /btw sidechat from executing %s through its parent's host", async text => {
  const f = fixture();
  Object.assign(f.session, { sidechat: true, parentSessionId: "parent", archivedAt: 100 });
  const parentHost = { ...f.host, setPermissions: vi.fn() };
  delete (f.state as { host?: unknown }).host;
  f.state.ownership = "DESKTOP_OBSERVED";
  f.broker.runtimeStates.set("parent", { ownership: "BRIDGE_IDLE", turnState: "idle", host: parentHost });
  await expect(f.broker.runCommand(f.input(text))).rejects.toThrow("当前会话由 Desktop 执行");
  await expect(f.broker.configurePermissions("logical", "bypassPermissions", { allow: [], ask: [], deny: [] })).rejects.toThrow();
  expect(parentHost.setPermissions).not.toHaveBeenCalled();
  expect(f.broker.startTurn).not.toHaveBeenCalled();
  expect(f.state.ownership).toBe("DESKTOP_OBSERVED");
  await expect(f.broker.runCommand(f.input("/help"))).resolves.toMatchObject({ action: "help" });
});

it("retains the archived sidechat identity and lineage in /resume results", async () => {
  const f = fixture();
  const sidechat = { ...f.session, sessionId: "sidechat", title: "btw: Archived", parentSessionId: "logical", sidechat: true, archivedAt: 100 };
  f.broker.listSessions.mockReturnValue([f.session, sidechat]);
  await expect(f.broker.runCommand(f.input("/resume"))).resolves.toEqual({ action: "resume", sessions: [f.session, sidechat] });
  await expect(f.broker.runCommand(f.input("/resume sidechat"))).resolves.toEqual({ action: "session", session: sidechat });
  expect(f.broker.startTurn).not.toHaveBeenCalled();
});

it("forks the selected sidechat rather than redirecting to its ancestor", async () => {
  const f = fixture();
  Object.assign(f.session, { sidechat: true, parentSessionId: "parent" });
  await f.broker.runCommand(f.input("/fork sidechat branch"));
  expect(f.broker.forkSession).toHaveBeenCalledExactlyOnceWith("logical", "sidechat branch");
  expect(f.broker.startTurn).not.toHaveBeenCalled();
});

it("reads only permission fields and awaits SDK permission changes", async () => {
  const f = fixture();
  await expect(f.broker.permissions("logical")).resolves.toEqual({ sessionId: "logical", mode: "default", rules: { allow: [], ask: [], deny: [] }, inheritedRules: { allow: ["Read"], deny: ["Bash(rm *)"], ask: [] }, canConfigure: true });
  const rules = { allow: ["Read"], ask: ["Bash"], deny: [] };
  await f.broker.configurePermissions("logical", "acceptEdits", rules);
  expect(f.host.setPermissions).toHaveBeenCalledWith("acceptEdits", rules);
  f.host.setPermissions.mockRejectedValueOnce(new Error("Policy refused"));
  await expect(f.broker.configurePermissions("logical", "bypassPermissions", rules)).rejects.toThrow("Policy refused");
});
