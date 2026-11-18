import type { BridgeMethod } from "@bridge/protocol";
import { expect, it, vi } from "vitest";
import { createControllerFixture } from "./controller-fixture.js";

vi.mock("electron", () => ({ shell: {} }));

it("routes discovery by logical session and ignores caller-supplied directories", async () => {
  const catalog = { sessionId: "fork", commands: [{ name: "review", description: "Review changes" }] };
  const commands = vi.fn(async () => catalog);
  const configuration = vi.fn(() => { throw new Error("Listing must not initialize a query"); });
  const controller = createControllerFixture({
    broker: { commands, configuration },
  });
  await expect(controller.handleRequest({ kind: "request", method: "session.commands", requestId: "commands", idempotencyKey: "commands",
    params: { sessionId: "fork", cwd: "/unapproved", claudeRoot: "/unapproved" } }, "mobile")).resolves.toEqual({ catalog });
  expect(commands).toHaveBeenCalledExactlyOnceWith("fork");
  expect(configuration).not.toHaveBeenCalled();
});

it("routes paired mobile rewind preview and execution with exact response contracts", async () => {
  const preview = { sessionId: "native", messageId: "raw-uuid", canRewindConversation: true, canRewindFiles: false, filesChanged: [] };
  const rewind = { sessionId: "native", messageId: "raw-uuid", scope: "conversation", prefill: "Draft" };
  const previewRewind = vi.fn(async () => preview), rewindSession = vi.fn(async () => rewind);
  const session = { sessionId: "native", turnState: "idle" };
  const controller = createControllerFixture({
    broker: { previewRewind, rewindSession, session: () => session },
  });
  const request = { kind: "request" as const, requestId: "rewind", idempotencyKey: "rewind", params: { sessionId: "native", messageId: "raw-uuid", scope: "conversation" } };
  await expect(controller.handleRequest({ ...request, method: "session.rewind.preview" }, "mobile", "phone")).resolves.toEqual({ rewind: preview });
  expect(previewRewind).toHaveBeenCalledExactlyOnceWith("native", "raw-uuid");
  await expect(controller.handleRequest({ ...request, method: "session.rewind" }, "mobile", "phone")).resolves.toEqual({ rewind, session });
  expect(rewindSession).toHaveBeenCalledExactlyOnceWith("native", "raw-uuid", "conversation");
});

it.each(["conversation", "files", "both"])("accepts native rewind scope %s", async scope => {
  const rewindSession = vi.fn(async () => ({ scope }));
  const controller = createControllerFixture({ broker: { rewindSession, session: () => undefined } });
  await controller.handleRequest({ kind: "request", method: "session.rewind", requestId: "rewind", idempotencyKey: "rewind", params: { sessionId: "native", messageId: "raw", scope } }, "mobile");
  expect(rewindSession).toHaveBeenCalledExactlyOnceWith("native", "raw", scope);
});

it.each([
  { sessionId: "", messageId: "raw", scope: "both" },
  { sessionId: 1, messageId: "raw", scope: "both" },
  { sessionId: "native", messageId: " ", scope: "both" },
  { sessionId: "native", messageId: null, scope: "both" },
  { sessionId: "native", messageId: "raw", scope: "all" },
  { sessionId: "native", messageId: "raw", scope: null },
  { sessionId: "native", messageId: "raw" },
])("rejects malformed rewind params %j at the controller boundary", async params => {
  const rewindSession = vi.fn();
  const controller = createControllerFixture({ broker: { rewindSession } });
  await expect(controller.handleRequest({ kind: "request", method: "session.rewind", requestId: "rewind", idempotencyKey: "rewind", params }, "mobile")).rejects.toThrow();
  expect(rewindSession).not.toHaveBeenCalled();
});

it.each([false, true])("advertises native rewind only when the broker supports it (%s)", async available => {
  const controller = createControllerFixture({
    config: { devices: [], relayEndpoints: [], hostDeviceId: "host", desktopName: "test", relayUrl: "ws://localhost:1" },
    app: { getVersion: () => "test" }, allProjects: () => [], allSessions: () => [], deviceSnapshots: () => [],
    broker: { runtimeStatus: () => ({}), magpieSettings: async () => ({}), promptsList: () => [] }, desktopRuntimes: () => [{ id: "claude-desktop", capabilities: available ? ["session.rewind"] : [] }], claudePermissions: () => [],
    eventLog: { latestSeq: () => 0 }, claudeDesktop: { status: async () => ({}) }, desktopAppStatuses: async () => [],
  });
  expect((await controller.snapshot()).host.capabilities.includes("session.rewind.v1")).toBe(available);
});

it("routes explicit command execution with its original request identity", async () => {
  const runCommand = vi.fn(async () => ({ action: "sent" }));
  const controller = createControllerFixture({ broker: { runCommand } });
  await expect(controller.handleRequest({ kind: "request", method: "session.command", requestId: "request", idempotencyKey: "key", params: { sessionId: "fork", text: "/compact preserve names", cwd: "/unapproved" } }, "mobile", "phone")).resolves.toEqual({ command: { action: "sent" } });
  expect(runCommand).toHaveBeenCalledExactlyOnceWith({ sessionId: "fork", text: "/compact preserve names", requestId: "request", idempotencyKey: "key", origin: "mobile", sourceDeviceId: "phone" });
});

it.each([
  "session.permissions", "session.permissions.configure", "session.desktop.register",
  "session.takeover_desktop", "session.return_to_desktop", "session.fallback.confirm",
  "provider.list", "provider.refresh", "conversation.route.get", "conversation.switch.preview",
  "conversation.switch.commit", "conversation.switch.cancel", "handoff.get",
])("rejects unsupported legacy execution entry %s", async method => {
  const controller = createControllerFixture({});
  await expect(controller.handleRequest({ kind: "request", method: method as BridgeMethod, requestId: "legacy", idempotencyKey: "legacy",
    params: { sessionId: "native" } }, "mobile")).rejects.toMatchObject({ code: "UNSUPPORTED" });
});

it.each(["turn.start", "turn.steer"] as const)("relays %s with original identity and preserves the native acknowledgement", async method => {
  const startTurn = vi.fn(async () => ({ commandId: "command", state: "queued" }));
  const steerTurn = vi.fn(async () => ({ commandId: "command", state: "queued" }));
  const controller = createControllerFixture({ broker: { startTurn, steerTurn } });
  await expect(controller.handleRequest({ kind: "request", method, requestId: "remote", idempotencyKey: "key",
    params: { sessionId: "native", text: "Continue" } }, "mobile", "phone")).resolves.toEqual({ commandId: "command", state: "queued" });
  expect(method === "turn.start" ? startTurn : steerTurn).toHaveBeenCalledExactlyOnceWith({ sessionId: "native", text: "Continue", attachments: [],
    requestId: "remote", idempotencyKey: "key", origin: "mobile", sourceDeviceId: "phone" });
});

it.each(["turn.start", "turn.steer"] as const)("rejects legacy Bridge execution through %s", async method => {
  const startTurn = vi.fn(), steerTurn = vi.fn();
  const controller = createControllerFixture({ broker: { startTurn, steerTurn } });
  await expect(controller.handleRequest({ kind: "request", method, requestId: "remote", idempotencyKey: "key",
    params: { sessionId: "native", text: "Continue", bridgeExecutionRequested: true } }, "mobile")).rejects.toMatchObject({ code: "UNSUPPORTED" });
  expect(startTurn).not.toHaveBeenCalled();
  expect(steerTurn).not.toHaveBeenCalled();
});

it.each(["true", null, 1])("rejects invalid remote choice %j before creating a turn", async bridgeExecutionRequested => {
  const startTurn = vi.fn();
  const controller = createControllerFixture({ broker: { startTurn } });
  await expect(controller.handleRequest({ kind: "request", method: "turn.start", requestId: "invalid", idempotencyKey: "key",
    params: { sessionId: "native", text: "Continue", bridgeExecutionRequested } }, "mobile")).rejects.toThrow("Invalid bridgeExecutionRequested");
  expect(startTurn).not.toHaveBeenCalled();
});

it.each(["allow-once", "allow-always", "deny"])("awaits the native permission result for %s", async decision => {
  let finish!: (resolved: boolean) => void;
  const resolvePermission = vi.fn((..._args: unknown[]) => new Promise<boolean>(resolve => { finish = resolve; }));
  const controller = createControllerFixture({ broker: { resolvePermission } });
  let settled = false;
  const result = controller.handleRequest({ kind: "request", method: "permission.resolve", requestId: "phone-request", idempotencyKey: "permission-key",
    params: { requestId: "desktop-native-request-id", decision } }, "mobile", "phone").finally(() => { settled = true; });
  await vi.waitFor(() => expect(resolvePermission).toHaveBeenCalled());
  expect(settled).toBe(false);
  expect(resolvePermission.mock.calls[0]![0]).toBe("desktop-native-request-id");
  finish(false);
  await expect(result).rejects.toMatchObject({ code: "ALREADY_RESOLVED" });
});

it("does not apply the old host full-access default to Claude", async () => {
  const save = vi.fn();
  const controller = createControllerFixture({ repository: { save }, config: { defaultPermissionMode: "standard" } });
  await expect(controller.handleRequest({ kind: "request", method: "permission.policy.configure", requestId: "policy", idempotencyKey: "policy",
    params: { scope: "host", runtimeId: "claude-desktop", mode: "full-access" } }, "mobile")).rejects.toMatchObject({ code: "UNSUPPORTED" });
  expect(controller.config.defaultPermissionMode).toBe("standard");
  expect(save).not.toHaveBeenCalled();
});

it.each(["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"])("routes native session permission mode %s without applying a Bridge policy", async permissionMode => {
  const configuration = { nativePermissionMode: permissionMode };
  const configureSession = vi.fn(async () => configuration);
  const controller = createControllerFixture({
    broker: { configureSession, session: () => ({ sessionId: "native" }) },
  });
  await expect(controller.handleRequest({ kind: "request", method: "session.configure", requestId: "configure", idempotencyKey: "configure",
    params: { sessionId: "native", permissionMode } }, "mobile")).resolves.toEqual({ configuration, session: { sessionId: "native" } });
  expect(configureSession).toHaveBeenCalledExactlyOnceWith({ sessionId: "native", permissionMode });
});

it.each(["ultra", "none"])("explains why effort %s cannot be applied by Desktop", async effort => {
  const configureSession = vi.fn();
  const controller = createControllerFixture({ broker: { configureSession } });
  await expect(controller.handleRequest({ kind: "request", method: "session.configure", requestId: "configure", idempotencyKey: "configure",
    params: { sessionId: "native", effort } }, "mobile")).rejects.toThrow(`Claude Desktop does not support effort ${JSON.stringify(effort)}`);
  expect(configureSession).not.toHaveBeenCalled();
});

it.each(["full-access", "unknown", "", null, 1])("rejects invalid native session permission mode %j", async permissionMode => {
  const configureSession = vi.fn();
  const controller = createControllerFixture({ broker: { configureSession } });
  await expect(controller.handleRequest({ kind: "request", method: "session.configure", requestId: "configure", idempotencyKey: "configure",
    params: { sessionId: "native", permissionMode } }, "mobile")).rejects.toThrow();
  expect(configureSession).not.toHaveBeenCalled();
});
