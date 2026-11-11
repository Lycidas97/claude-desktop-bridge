import { expect, it, vi } from "vitest";
import { DesktopController } from "./controller.js";

vi.mock("electron", () => ({ shell: {} }));

it("routes discovery by logical session and ignores caller-supplied directories", async () => {
  const catalog = { sessionId: "fork", commands: [{ name: "review", description: "Review changes" }] };
  const commands = vi.fn(async () => catalog);
  const configuration = vi.fn(() => { throw new Error("Listing must not initialize a query"); });
  const controller = Object.assign(Object.create(DesktopController.prototype), {
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
  const controller = Object.assign(Object.create(DesktopController.prototype), {
    broker: { previewRewind, rewindSession, session: () => session },
  });
  const request = { kind: "request", requestId: "rewind", idempotencyKey: "rewind", params: { sessionId: "native", messageId: "raw-uuid", scope: "conversation" } };
  await expect(controller.handleRequest({ ...request, method: "session.rewind.preview" }, "mobile", "phone")).resolves.toEqual({ rewind: preview });
  expect(previewRewind).toHaveBeenCalledExactlyOnceWith("native", "raw-uuid");
  await expect(controller.handleRequest({ ...request, method: "session.rewind" }, "mobile", "phone")).resolves.toEqual({ rewind, session });
  expect(rewindSession).toHaveBeenCalledExactlyOnceWith("native", "raw-uuid", "conversation");
});

it.each(["conversation", "files", "both"])("accepts native rewind scope %s", async scope => {
  const rewindSession = vi.fn(async () => ({ scope }));
  const controller = Object.assign(Object.create(DesktopController.prototype), { broker: { rewindSession, session: () => undefined } });
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
  const controller = Object.assign(Object.create(DesktopController.prototype), { broker: { rewindSession } });
  await expect(controller.handleRequest({ kind: "request", method: "session.rewind", requestId: "rewind", idempotencyKey: "rewind", params }, "mobile")).rejects.toThrow();
  expect(rewindSession).not.toHaveBeenCalled();
});

it.each(["session.rewind.preview", "session.rewind"])("rejects external runtime rewind through %s", async method => {
  const previewRewind = vi.fn(), rewindSession = vi.fn();
  const controller = Object.assign(Object.create(DesktopController.prototype), { broker: { previewRewind, rewindSession } });
  await expect(controller.handleRequest({ kind: "request", method, requestId: "rewind", idempotencyKey: "rewind", params: { sessionId: "codex-desktop:saved", messageId: "raw", scope: "both" } }, "mobile")).rejects.toMatchObject({ code: "UNSUPPORTED" });
  expect(previewRewind).not.toHaveBeenCalled();
  expect(rewindSession).not.toHaveBeenCalled();
});

it.each([false, true])("advertises native rewind only when the broker supports it (%s)", async available => {
  const controller = Object.assign(Object.create(DesktopController.prototype), {
    config: { devices: [], relayEndpoints: [], hostDeviceId: "host", desktopName: "test", relayUrl: "ws://localhost:1" },
    app: { getVersion: () => "test" }, allProjects: () => [], allSessions: () => [], deviceSnapshots: () => [],
    broker: { runtimeStatus: () => ({}), magpieSettings: async () => ({}) }, desktopRuntimes: () => [{ id: "claude-desktop", capabilities: available ? ["session.rewind"] : [] }], claudePermissions: () => [],
    eventLog: { latestSeq: () => 0 }, claudeDesktop: { status: async () => ({}) }, desktopAppStatuses: async () => [],
  });
  expect((await controller.snapshot()).host.capabilities.includes("session.rewind.v1")).toBe(available);
});

it("never substitutes Claude commands for an external runtime", async () => {
  const commands = vi.fn();
  const controller = Object.assign(Object.create(DesktopController.prototype), {
    broker: { commands },
  });
  await expect(controller.handleRequest({ kind: "request", method: "session.commands", requestId: "external", idempotencyKey: "external",
    params: { sessionId: "hermes-desktop:saved" } }, "mobile")).rejects.toMatchObject({ code: "UNSUPPORTED" });
  expect(commands).not.toHaveBeenCalled();
});

it("routes explicit command execution with its original request identity", async () => {
  const runCommand = vi.fn(async () => ({ action: "sent" }));
  const controller = Object.assign(Object.create(DesktopController.prototype), { broker: { runCommand } });
  await expect(controller.handleRequest({ kind: "request", method: "session.command", requestId: "request", idempotencyKey: "key", params: { sessionId: "fork", text: "/compact preserve names", cwd: "/unapproved" } }, "mobile", "phone")).resolves.toEqual({ command: { action: "sent" } });
  expect(runCommand).toHaveBeenCalledExactlyOnceWith({ sessionId: "fork", text: "/compact preserve names", requestId: "request", idempotencyKey: "key", origin: "mobile", sourceDeviceId: "phone" });
});

it.each([
  "session.permissions", "session.permissions.configure", "session.desktop.register",
  "session.takeover_desktop", "session.return_to_desktop", "session.fallback.confirm",
  "provider.list", "provider.refresh", "conversation.route.get", "conversation.switch.preview",
  "conversation.switch.commit", "conversation.switch.cancel", "handoff.get",
])("rejects unsupported legacy execution entry %s", async method => {
  const controller = Object.create(DesktopController.prototype);
  await expect(controller.handleRequest({ kind: "request", method, requestId: "legacy", idempotencyKey: "legacy",
    params: { sessionId: "native" } }, "mobile")).rejects.toMatchObject({ code: "UNSUPPORTED" });
});

it.each(["turn.start", "turn.steer"])("relays %s with original identity and preserves the native acknowledgement", async method => {
  const startTurn = vi.fn(async () => ({ commandId: "command", state: "queued" }));
  const steerTurn = vi.fn(async () => ({ commandId: "command", state: "queued" }));
  const controller = Object.assign(Object.create(DesktopController.prototype), { broker: { startTurn, steerTurn } });
  await expect(controller.handleRequest({ kind: "request", method, requestId: "remote", idempotencyKey: "key",
    params: { sessionId: "native", text: "Continue" } }, "mobile", "phone")).resolves.toEqual({ commandId: "command", state: "queued" });
  expect(method === "turn.start" ? startTurn : steerTurn).toHaveBeenCalledExactlyOnceWith({ sessionId: "native", text: "Continue", attachments: [],
    requestId: "remote", idempotencyKey: "key", origin: "mobile", sourceDeviceId: "phone" });
});

it.each(["turn.start", "turn.steer"])("rejects legacy Bridge execution through %s", async method => {
  const startTurn = vi.fn(), steerTurn = vi.fn();
  const controller = Object.assign(Object.create(DesktopController.prototype), { broker: { startTurn, steerTurn } });
  await expect(controller.handleRequest({ kind: "request", method, requestId: "remote", idempotencyKey: "key",
    params: { sessionId: "native", text: "Continue", bridgeExecutionRequested: true } }, "mobile")).rejects.toMatchObject({ code: "UNSUPPORTED" });
  expect(startTurn).not.toHaveBeenCalled();
  expect(steerTurn).not.toHaveBeenCalled();
});

it.each(["true", null, 1])("rejects invalid remote choice %j before creating a turn", async bridgeExecutionRequested => {
  const startTurn = vi.fn();
  const controller = Object.assign(Object.create(DesktopController.prototype), { broker: { startTurn } });
  await expect(controller.handleRequest({ kind: "request", method: "turn.start", requestId: "invalid", idempotencyKey: "key",
    params: { sessionId: "native", text: "Continue", bridgeExecutionRequested } }, "mobile")).rejects.toThrow("Invalid bridgeExecutionRequested");
  expect(startTurn).not.toHaveBeenCalled();
});

it.each(["allow-once", "allow-always", "deny"])("awaits the native permission result for %s", async decision => {
  let finish!: (resolved: boolean) => void;
  const resolvePermission = vi.fn((..._args: unknown[]) => new Promise<boolean>(resolve => { finish = resolve; }));
  const controller = Object.assign(Object.create(DesktopController.prototype), { broker: { resolvePermission } });
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
  const controller = Object.assign(Object.create(DesktopController.prototype), { repository: { save }, config: { defaultPermissionMode: "standard" } });
  await expect(controller.handleRequest({ kind: "request", method: "permission.policy.configure", requestId: "policy", idempotencyKey: "policy",
    params: { scope: "host", runtimeId: "claude-desktop", mode: "full-access" } }, "mobile")).rejects.toMatchObject({ code: "UNSUPPORTED" });
  expect(controller.config.defaultPermissionMode).toBe("standard");
  expect(save).not.toHaveBeenCalled();
});

it.each([
  ["runtime.handoff.preview", { sessionId: "native-claude", targetRuntimeId: "codex-desktop" }],
  ["runtime.handoff.preview", { sessionId: "runtime:codex-desktop:session", targetRuntimeId: "claude-desktop" }],
  ["runtime.goal.pause", { sessionId: "native-claude" }],
  ["runtime.goal.resume", { sessionId: "native-claude" }],
])("rejects Claude auto-execution through %s", async (method, params) => {
  const controller = Object.create(DesktopController.prototype);
  await expect(controller.handleRequest({ kind: "request", method, requestId: "legacy", idempotencyKey: "legacy", params }, "mobile"))
    .rejects.toMatchObject({ code: "UNSUPPORTED" });
});

it.each(["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"])("routes native session permission mode %s without applying a Bridge policy", async permissionMode => {
  const configuration = { nativePermissionMode: permissionMode };
  const configureSession = vi.fn(async () => configuration);
  const controller = Object.assign(Object.create(DesktopController.prototype), {
    broker: { configureSession, session: () => ({ sessionId: "native" }) },
  });
  await expect(controller.handleRequest({ kind: "request", method: "session.configure", requestId: "configure", idempotencyKey: "configure",
    params: { sessionId: "native", permissionMode } }, "mobile")).resolves.toEqual({ configuration, session: { sessionId: "native" } });
  expect(configureSession).toHaveBeenCalledExactlyOnceWith({ sessionId: "native", permissionMode });
});

it.each(["full-access", "unknown", "", null, 1])("rejects invalid native session permission mode %j", async permissionMode => {
  const configureSession = vi.fn();
  const controller = Object.assign(Object.create(DesktopController.prototype), { broker: { configureSession } });
  await expect(controller.handleRequest({ kind: "request", method: "session.configure", requestId: "configure", idempotencyKey: "configure",
    params: { sessionId: "native", permissionMode } }, "mobile")).rejects.toThrow();
  expect(configureSession).not.toHaveBeenCalled();
});

it("rejects retired host permission defaults without changing saved values", async () => {
  const setHostPermissionMode = vi.fn(async () => 2), publish = vi.fn(async () => undefined);
  const config = { runtimePermissionModes: {}, devices: [], defaultPermissionMode: "standard" };
  const controller = Object.assign(Object.create(DesktopController.prototype), {
    config, repository: { save: vi.fn(async () => undefined) }, eventLog: { append: vi.fn(async () => undefined) },
    runtimeSessions: { setHostPermissionMode }, publish,
  });
  await expect(controller.handleRequest({ kind: "request", method: "permission.policy.configure", requestId: "policy", idempotencyKey: "policy",
    params: { scope: "host", runtimeId: "codex-desktop", mode: "full-access" } }, "mobile")).rejects.toMatchObject({ code: "UNSUPPORTED" });
  expect(setHostPermissionMode).not.toHaveBeenCalled();
  expect(config.runtimePermissionModes).toEqual({});
  expect(config.defaultPermissionMode).toBe("standard");
});
