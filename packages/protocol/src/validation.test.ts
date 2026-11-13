import { describe, expect, it } from "vitest";
import { isBridgeNativeImageRef, isBridgePayload } from "./validation.js";

describe("native image refs", () => {
  it("accepts exact UUID and zero-based image identities without accepting paths or bytes", () => {
    expect(isBridgeNativeImageRef({ messageUuid: "native-uuid", imageIndex: 4 })).toBe(true);
    for (const value of [null, {}, { messageUuid: "", imageIndex: 0 }, { messageUuid: "uuid", imageIndex: -1 }, { messageUuid: "uuid", imageIndex: 0.1 }, { messageUuid: "uuid", imageIndex: "0" }, { path: "/project/image.jpg" }]) expect(isBridgeNativeImageRef(value)).toBe(false);
  });
});

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

  it.each(["session.rewind.preview", "session.rewind"])("accepts native %s on the paired channel", method => {
    expect(isBridgePayload({ kind: "request", requestId: method, idempotencyKey: method, method, params: { sessionId: "native", messageId: "raw-uuid", scope: "both" } })).toBe(true);
  });

  it("accepts directory listing requests on the paired channel", () => {
    expect(isBridgePayload({ kind: "request", requestId: "browse", idempotencyKey: "browse", method: "directory.list", params: {} })).toBe(true);
  });

  it.each(["turn.queue.steer", "turn.queue.cancel"])("accepts %s without another message payload", method => {
    expect(isBridgePayload({ kind: "request", requestId: "queue-action", idempotencyKey: "queue-action", method, params: { sessionId: "session", commandId: "queued" } })).toBe(true);
  });

  it("accepts an explicit return to Desktop without a new message payload", () => {
    expect(isBridgePayload({ kind: "request", requestId: "return", idempotencyKey: "return", method: "session.return_to_desktop", params: { sessionId: "session" } })).toBe(true);
  });

  it("accepts native section creation, movement, rename, and deletion on the paired channel", () => {
    expect(isBridgePayload({ kind: "request", requestId: "section", idempotencyKey: "section", method: "section.create", params: { name: "Research" } })).toBe(true);
    expect(isBridgePayload({ kind: "request", requestId: "move", idempotencyKey: "move", method: "section.move", params: { sessionId: "local_1", sectionId: null } })).toBe(true);
    expect(isBridgePayload({ kind: "request", requestId: "rename", idempotencyKey: "rename", method: "section.rename", params: { sectionId: "group_1", name: "Research v2" } })).toBe(true);
    expect(isBridgePayload({ kind: "request", requestId: "delete", idempotencyKey: "delete", method: "section.delete", params: { sectionId: "group_1" } })).toBe(true);
  });

  it("accepts controlled directory creation on the paired channel", () => {
    expect(isBridgePayload({ kind: "request", requestId: "mkdir", idempotencyKey: "mkdir", method: "directory.mkdir", params: { parentPath: "/tmp", name: "demo" } })).toBe(true);
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
