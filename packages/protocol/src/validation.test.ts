import { describe, expect, it } from "vitest";
import { isBridgePayload } from "./validation.js";

describe("isBridgePayload", () => {
  it("accepts 0.7 runtime handoff and goal methods", () => {
    for (const method of [
      "runtime.handoff.preview",
      "runtime.handoff.commit",
      "runtime.handoff.cancel",
      "runtime.handoff.get",
      "runtime.handoff.list",
      "runtime.handoff.confirm",
      "runtime.goal.pause",
      "runtime.goal.resume",
    ]) {
      expect(isBridgePayload({
        kind: "request",
        requestId: `request-${method}`,
        idempotencyKey: `key-${method}`,
        method,
        params: {},
      }), method).toBe(true);
    }
  });

  it("accepts display title rename requests on the paired channel", () => {
    expect(isBridgePayload({ kind: "request", requestId: "rename", idempotencyKey: "rename", method: "session.rename", params: { sessionId: "session", title: "手机名称" } })).toBe(true);
  });

  it("accepts read-only session command discovery on the paired channel", () => {
    expect(isBridgePayload({ kind: "request", requestId: "commands", idempotencyKey: "commands", method: "session.commands", params: { sessionId: "fork" } })).toBe(true);
  });

  it.each(["session.command", "session.permissions", "session.permissions.configure", "session.fork"])("accepts %s on the paired channel", method => {
    expect(isBridgePayload({ kind: "request", requestId: method, idempotencyKey: method, method, params: { sessionId: "fork" } })).toBe(true);
  });

  it("accepts directory listing requests on the paired channel", () => {
    expect(isBridgePayload({ kind: "request", requestId: "browse", idempotencyKey: "browse", method: "directory.list", params: {} })).toBe(true);
  });

  it("accepts a queued-command steering request without another message payload", () => {
    expect(isBridgePayload({ kind: "request", requestId: "promote", idempotencyKey: "promote", method: "turn.queue.steer", params: { sessionId: "session", commandId: "queued" } })).toBe(true);
  });

  it("accepts an explicit return to Desktop without a new message payload", () => {
    expect(isBridgePayload({ kind: "request", requestId: "return", idempotencyKey: "return", method: "session.return_to_desktop", params: { sessionId: "session" } })).toBe(true);
  });

  it("still rejects unknown methods", () => {
    expect(isBridgePayload({
      kind: "request",
      requestId: "request-1",
      idempotencyKey: "key-1",
      method: "runtime.handoff.destroy",
      params: {},
    })).toBe(false);
  });
});
