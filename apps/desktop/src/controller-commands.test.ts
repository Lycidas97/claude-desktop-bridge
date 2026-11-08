import { expect, it, vi } from "vitest";
import { DesktopController } from "./controller.js";

it("routes discovery by logical session and ignores caller-supplied directories", async () => {
  const catalog = { sessionId: "fork", commands: [{ name: "review", description: "Review changes" }] };
  const commands = vi.fn(async () => catalog);
  const configuration = vi.fn(() => { throw new Error("Listing must not initialize a query"); });
  const controller = Object.assign(Object.create(DesktopController.prototype), {
    broker: { commands, configuration }, routesToExternalRuntime: () => false,
  });
  await expect(controller.handleRequest({ kind: "request", method: "session.commands", requestId: "commands", idempotencyKey: "commands",
    params: { sessionId: "fork", cwd: "/unapproved", claudeRoot: "/unapproved" } }, "mobile")).resolves.toEqual({ catalog });
  expect(commands).toHaveBeenCalledExactlyOnceWith("fork");
  expect(configuration).not.toHaveBeenCalled();
});

it("never substitutes Claude commands for an external runtime", async () => {
  const commands = vi.fn();
  const controller = Object.assign(Object.create(DesktopController.prototype), {
    broker: { commands }, routesToExternalRuntime: () => true,
  });
  await expect(controller.handleRequest({ kind: "request", method: "session.commands", requestId: "external", idempotencyKey: "external",
    params: { sessionId: "hermes-session" } }, "mobile")).resolves.toEqual({ catalog: { sessionId: "hermes-session", commands: [] } });
  expect(commands).not.toHaveBeenCalled();
});

it("routes explicit command execution with its original request identity", async () => {
  const runCommand = vi.fn(async () => ({ action: "sent" }));
  const controller = Object.assign(Object.create(DesktopController.prototype), { broker: { runCommand }, routesToExternalRuntime: () => false });
  await expect(controller.handleRequest({ kind: "request", method: "session.command", requestId: "request", idempotencyKey: "key", params: { sessionId: "fork", text: "/compact preserve names", cwd: "/unapproved" } }, "mobile", "phone")).resolves.toEqual({ command: { action: "sent" } });
  expect(runCommand).toHaveBeenCalledExactlyOnceWith({ sessionId: "fork", text: "/compact preserve names", requestId: "request", idempotencyKey: "key", origin: "mobile", sourceDeviceId: "phone" });
});

it.each([
  null,
  [],
  { allow: [], ask: [] },
  { allow: "Read", ask: [], deny: [] },
  { allow: [null], ask: [], deny: [] },
  { allow: [], ask: ["  "], deny: [] },
  { allow: [], ask: [], deny: [false] },
])("[edge] rejects malformed permission rule payload %j before SDK mutation", async rules => {
  const configurePermissions = vi.fn();
  const controller = Object.assign(Object.create(DesktopController.prototype), { broker: { configurePermissions }, routesToExternalRuntime: () => false });
  await expect(controller.handleRequest({ kind: "request", method: "session.permissions.configure", requestId: "invalid", idempotencyKey: "invalid", params: { sessionId: "fork", mode: "default", rules } }, "mobile")).rejects.toThrow();
  expect(configurePermissions).not.toHaveBeenCalled();
});

it.each(["session.command", "session.permissions", "session.permissions.configure"])("[edge] rejects %s for external runtimes without calling the Claude broker", async method => {
  const runCommand = vi.fn(), permissions = vi.fn(), configurePermissions = vi.fn();
  const controller = Object.assign(Object.create(DesktopController.prototype), { broker: { runCommand, permissions, configurePermissions }, routesToExternalRuntime: () => true });
  await expect(controller.handleRequest({ kind: "request", method, requestId: "external", idempotencyKey: "external", params: { sessionId: "hermes:session", text: "/clear", mode: "default", rules: { allow: [], ask: [], deny: [] } } }, "mobile")).rejects.toThrow("当前运行时不支持");
  expect(runCommand).not.toHaveBeenCalled();
  expect(permissions).not.toHaveBeenCalled();
  expect(configurePermissions).not.toHaveBeenCalled();
});

it("[edge] accepts explicit empty rule arrays to clear the session override", async () => {
  const configurePermissions = vi.fn(async () => ({ mode: "default", rules: { allow: [], ask: [], deny: [] } }));
  const controller = Object.assign(Object.create(DesktopController.prototype), { broker: { configurePermissions }, routesToExternalRuntime: () => false });
  await controller.handleRequest({ kind: "request", method: "session.permissions.configure", requestId: "empty", idempotencyKey: "empty", params: { sessionId: "fork", mode: "default", rules: { allow: [], ask: [], deny: [] } } }, "mobile");
  expect(configurePermissions).toHaveBeenCalledExactlyOnceWith("fork", "default", { allow: [], ask: [], deny: [] });
});

it.each(["turn.start", "turn.steer"])("forwards the confirmed remote choice through %s with the original identity", async method => {
  const startTurn = vi.fn(async () => ({ commandId: "command", state: "queued" }));
  const steerTurn = vi.fn(async () => ({ commandId: "command", state: "queued" }));
  const controller = Object.assign(Object.create(DesktopController.prototype), { broker: { startTurn, steerTurn }, routesToExternalRuntime: () => false });
  await controller.handleRequest({ kind: "request", method, requestId: "remote", idempotencyKey: "key",
    params: { sessionId: "native", text: "Continue", bridgeExecutionRequested: true } }, "mobile", "phone");
  expect(method === "turn.start" ? startTurn : steerTurn).toHaveBeenCalledExactlyOnceWith({ sessionId: "native", text: "Continue", attachments: [],
    requestId: "remote", idempotencyKey: "key", origin: "mobile", sourceDeviceId: "phone", bridgeExecutionRequested: true });
});

it.each(["true", null, 1])("rejects invalid remote choice %j before creating a turn", async bridgeExecutionRequested => {
  const startTurn = vi.fn();
  const controller = Object.assign(Object.create(DesktopController.prototype), { broker: { startTurn }, routesToExternalRuntime: () => false });
  await expect(controller.handleRequest({ kind: "request", method: "turn.start", requestId: "invalid", idempotencyKey: "key",
    params: { sessionId: "native", text: "Continue", bridgeExecutionRequested } }, "mobile")).rejects.toThrow("Invalid bridgeExecutionRequested");
  expect(startTurn).not.toHaveBeenCalled();
});

it("authorizes the existing queued command without submitting another prompt", async () => {
  const takeoverDesktop = vi.fn(async () => ({ sessionId: "native" }));
  const controller = Object.assign(Object.create(DesktopController.prototype), { broker: { takeoverDesktop }, routesToExternalRuntime: () => false });
  await controller.handleRequest({ kind: "request", method: "session.takeover_desktop", requestId: "takeover", idempotencyKey: "key",
    params: { sessionId: "native", commandId: "original-command" } }, "mobile");
  expect(takeoverDesktop).toHaveBeenCalledExactlyOnceWith("native", "original-command");
});

it("validates SDK permission rules before modifying the runtime", async () => {
  const configurePermissions = vi.fn(async () => ({ mode: "acceptEdits" }));
  const controller = Object.assign(Object.create(DesktopController.prototype), { broker: { configurePermissions }, routesToExternalRuntime: () => false });
  const request = { kind: "request", method: "session.permissions.configure", requestId: "request", idempotencyKey: "key", params: { sessionId: "fork", mode: "acceptEdits", rules: { allow: ["Read"], ask: [], deny: [] } } };
  await expect(controller.handleRequest(request, "mobile")).resolves.toEqual({ permissions: { mode: "acceptEdits" } });
  await expect(controller.handleRequest({ ...request, params: { ...request.params, mode: "full-access" } }, "mobile")).rejects.toThrow("Invalid SDK permission mode");
  await expect(controller.handleRequest({ ...request, params: { ...request.params, rules: { allow: [42], ask: [], deny: [] } } }, "mobile")).rejects.toThrow("Invalid allow");
  expect(configurePermissions).toHaveBeenCalledTimes(1);
});
