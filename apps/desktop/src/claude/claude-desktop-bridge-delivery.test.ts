import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { ClaudeDesktopBridge } from "./claude-desktop-bridge.js";
import { InspectorDisconnectedError } from "./claude-desktop-inspector.js";
import { fixture, NativeDesktop, withDatabase, turnInput as input } from "./claude-desktop-bridge-fixture.js";

describe("native message delivery", () => {
  describe("v116 late receipts and UUID boundaries", () => {
    it.each([
      { received: false, action: "send-now" }, { received: true, action: "send-now" },
      { received: false, action: "cancel" }, { received: true, action: "cancel" },
    ] as const)("keeps completion across received=$received, queued, and a late $action acknowledgment", async ({ received, action }) => {
      const f = await fixture();
      let release!: (accepted: boolean) => void;
      let pending: ReturnType<ClaudeDesktopBridge["steerQueuedTurn"]> | undefined;
      try {
        const receipt = await f.bridge.startTurn(input);
        if (received) await f.message({ type: "user", uuid: receipt.messageId, message: { content: input.text } });
        expect(receipt.state).toBe(received ? "session-received" : "submitted");
        const method = action === "cancel" ? "cancelQueuedMessage" : "promoteQueuedMessage";
        const original = f.native.call.bind(f.native);
        vi.spyOn(f.native, "call").mockImplementation((called, args = []) => {
          if (called !== method) return original(called, args);
          f.native.calls.push({ method: called, args });
          return new Promise(resolve => { release = resolve; });
        });
        f.native.calls = [];
        pending = action === "cancel" ? f.bridge.cancelQueuedTurn(input.sessionId, receipt.commandId) : f.bridge.steerQueuedTurn(input.sessionId, receipt.commandId);
        expect(f.native.calls).toEqual([{ method, args: [input.sessionId, receipt.messageId] }]);
        await f.message({ type: "command_lifecycle", command_uuid: receipt.messageId, state: "queued" });
        expect(f.bridge.session(input.sessionId)?.pendingCommandIds).toEqual([receipt.commandId]);
        await f.message({ type: "command_lifecycle", command_uuid: receipt.messageId, state: "started" });
        await f.message({ type: "result", user_message_uuid: receipt.messageId, is_error: false });
        const before = f.eventLog.replay(0);
        release(true);
        expect(await pending).toMatchObject({ commandId: receipt.commandId, messageId: receipt.messageId, queueMode: "steered", state: "completed" });
        expect(f.state.nativeDesktopReceipt(input.idempotencyKey)?.state).toBe("completed");
        expect(f.bridge.session(input.sessionId)?.pendingCommandIds).toEqual([]);
        expect(f.eventLog.replay(0)).toEqual(before);
        expect(f.native.calls).toEqual([{ method, args: [input.sessionId, receipt.messageId] }]);
      } finally {
        release?.(false);
        await pending?.catch(() => undefined);
        await f.close();
      }
    });

    it("keeps a rekeyed completion when cancellation of the old UUID acknowledges late", async () => {
      const f = await fixture();
      let release!: (accepted: boolean) => void;
      let pending: ReturnType<ClaudeDesktopBridge["cancelQueuedTurn"]> | undefined;
      try {
        f.native.sendResult = { delivered: true, queued: true };
        const receipt = await f.bridge.startTurn(input);
        const oldUuid = receipt.messageId;
        const original = f.native.call.bind(f.native);
        vi.spyOn(f.native, "call").mockImplementation((method, args = []) => {
          if (method !== "cancelQueuedMessage") return original(method, args);
          f.native.calls.push({ method, args });
          return new Promise(resolve => { release = resolve; });
        });
        f.native.calls = [];
        pending = f.bridge.cancelQueuedTurn(input.sessionId, receipt.commandId);
        const changed = once(f.bridge, "changed");
        f.native.emit("event", { type: "steers_rekeyed", sessionId: input.sessionId, rekeyedSteers: [{ from: oldUuid, to: "v116-rekeyed" }] });
        await changed;
        await f.message({ type: "result", user_message_uuid: "v116-rekeyed", is_error: false });
        const before = f.eventLog.replay(0);
        release(true);
        expect(await pending).toMatchObject({ messageId: "v116-rekeyed", state: "completed" });
        expect(f.state.nativeDesktopReceipt(input.idempotencyKey)).toMatchObject({ messageId: "v116-rekeyed", state: "completed" });
        expect(f.eventLog.replay(0)).toEqual(before);
        expect(f.native.calls).toEqual([{ method: "cancelQueuedMessage", args: [input.sessionId, oldUuid] }]);
      } finally {
        release?.(false);
        await pending?.catch(() => undefined);
        await f.close();
      }
    });

    it.each(["started", "completed", "failed", "close"] as const)("isolates foreign %s evidence when both sessions own the same UUID", async state => {
      const f = await fixture();
      try {
        f.native.sessions.push({ ...f.native.sessions[0], sessionId: "other-native" });
        await f.bridge.refreshRuntime();
        f.native.sendResult = { delivered: true, queued: true };
        const local = await f.bridge.startTurn(input);
        const foreign = await f.bridge.startTurn({ ...input, sessionId: "other-native", requestId: "v116-foreign", idempotencyKey: "v116-foreign" });
        let changed = once(f.bridge, "changed");
        f.native.emit("event", { type: "steers_rekeyed", sessionId: "other-native", rekeyedSteers: [{ from: foreign.messageId, to: local.messageId }] });
        await changed;
        changed = once(f.bridge, "changed");
        f.native.emit("event", state === "close"
          ? { type: "close", sessionId: "other-native", withdrawnUuids: [local.messageId], lostUuids: [] }
          : { type: "message", sessionId: "other-native", message: state === "started"
            ? { type: "command_lifecycle", command_uuid: local.messageId, state }
            : { type: "result", user_message_uuid: local.messageId, is_error: state === "failed" } });
        await changed;
        expect(f.state.nativeDesktopReceipt(input.idempotencyKey)).toMatchObject({ messageId: local.messageId, state: "queued" });
        expect(f.state.nativeDesktopReceipt("v116-foreign")).toMatchObject({ messageId: local.messageId, state: state === "close" ? "cancelled" : state === "started" ? "running" : state });
        expect(f.bridge.session(input.sessionId)?.pendingCommandIds).toEqual([local.commandId]);
        expect(f.bridge.session("other-native")?.pendingCommandIds).toEqual([]);
      } finally { await f.close(); }
    });

    it.each(["close", "held_input_withdrawn"] as const)("keeps %s withdrawal terminal through late echo, lifecycle, and restart", async type => {
      const f = await fixture();
      let restarted: ClaudeDesktopBridge | undefined;
      try {
        f.native.sendResult = { delivered: true, queued: true };
        const receipt = await f.bridge.startTurn(input);
        const changed = once(f.bridge, "changed");
        f.native.emit("event", { type, sessionId: input.sessionId, withdrawnUuids: [receipt.messageId] });
        await changed;
        for (const state of ["queued", "started", "completed", "failed", "cancelled", "interrupted"]) {
          await f.message({ type: "command_lifecycle", command_uuid: receipt.messageId, state });
          expect(f.state.nativeDesktopReceipt(input.idempotencyKey)?.state).toBe("cancelled");
        }
        await f.message({ type: "user", uuid: receipt.messageId, message: { content: input.text } });
        expect(f.state.nativeDesktopReceipt(input.idempotencyKey)?.state).toBe("cancelled");
        await f.bridge.close();
        const restoredNative = new NativeDesktop();
        restarted = new ClaudeDesktopBridge({ ...f.options, inspector: restoredNative });
        await restarted.initialize();
        restoredNative.calls = [];
        await expect(restarted.steerQueuedTurn(input.sessionId, receipt.commandId)).rejects.toThrow("当前不可调整");
        await expect(restarted.cancelQueuedTurn(input.sessionId, receipt.commandId)).rejects.toThrow("当前不可调整");
        expect(restarted.session(input.sessionId)?.pendingCommandIds).toEqual([]);
        expect(f.state.nativeDesktopReceipt(input.idempotencyKey)?.state).toBe("cancelled");
        expect(restoredNative.calls).toEqual([]);
      } finally { await restarted?.close(); await f.close(); }
    });
  });

  it("persists queued, started and correlated results on exact UUID history snapshots across restarts", async () => {
    const f = await fixture();
    let restarted: ClaudeDesktopBridge | undefined;
    try {
      const first = await f.bridge.startTurn(input);
      const second = await f.bridge.startTurn({ ...input, idempotencyKey: "second", requestId: "second" });
      f.native.page.messages = [first, second].map(receipt => ({ type: "user", uuid: receipt.messageId, message: { content: "hello" } }));
      await f.message({ type: "command_lifecycle", command_uuid: first.commandId, state: "queued" });
      expect(f.state.nativeDesktopReceipt("key")?.state).toBe("submitted");
      await f.message({ type: "command_lifecycle", command_uuid: first.messageId, state: "queued" });
      expect(f.state.nativeDesktopReceipt("key")?.state).toBe("queued");
      expect(f.bridge.session("local-native")).toMatchObject({ pendingCount: 1, pendingCommandIds: [first.commandId] });
      expect((await f.bridge.history("local-native")).items[0]).toMatchObject({ delivery: "queued", commandId: first.commandId, requestId: first.requestId });
      await f.message({ type: "command_lifecycle", command_uuid: first.messageId, state: "started" });
      expect(f.bridge.session("local-native")).toMatchObject({ pendingCount: 0, pendingCommandIds: [] });
      await f.message({ type: "user", uuid: first.messageId, message: { content: "hello" } });
      expect(f.eventLog.latestItem("local-native", "user.message.accepted", first.messageId)?.data.delivery).toBe("running");
      expect((await f.bridge.history("local-native")).items[0]?.delivery).toBe("running");
      await f.message({ type: "result", uuid: "uncorrelated", is_error: false });
      expect(f.state.nativeDesktopReceipt("key")?.state).toBe("running");
      expect(f.state.nativeDesktopReceipt("second")?.state).toBe("submitted");
      await f.message({ type: "result", uuid: "correlated", user_message_uuids: [first.messageId], is_error: false });
      await f.message({ type: "command_lifecycle", command_uuid: first.messageId, state: "queued" });
      await f.bridge.close();
      restarted = new ClaudeDesktopBridge(f.options);
      await restarted.initialize();
      expect((await restarted.history("local-native")).items.map(item => item.delivery)).toEqual(["completed", "submitted"]);
    } finally { await restarted?.close(); await f.close(); }
  });

  it.each(["idle upgrade", "restart during next turn", "rewind"])("keeps an answered input out of the actionable queue after %s", async transition => {
    const f = await fixture();
    let restarted: ClaudeDesktopBridge | undefined;
    try {
      const receipt = await f.bridge.startTurn(input);
      const user = { type: "user", uuid: receipt.messageId, message: { content: input.text } };
      const reply = { type: "assistant", uuid: "finished-reply", message: { content: [{ type: "text", text: "Done" }] } };
      const result = { type: "result", uuid: "unattributed-result", is_error: false };
      f.native.page.messages = [user, reply, result, { ...user, uuid: "later-input" }];
      for (const message of [user, reply, result]) await f.message(message);
      // This is also the on-disk shape from before queue settlement existed.
      expect(f.state.nativeDesktopReceipt(input.idempotencyKey)?.queueSettled).toBeUndefined();
      f.native.inputQueueDrained.mockResolvedValue(true);
      let bridge = f.bridge;
      if (transition !== "rewind") {
        if (transition === "restart during next turn") {
          await bridge.refreshRuntime();
          expect(f.state.nativeDesktopReceipt(input.idempotencyKey)?.queueSettled).toBe(true);
          f.native.sessions[0]!.turnRunning = true;
        }
        await bridge.close();
        restarted = new ClaudeDesktopBridge(f.options);
        await restarted.initialize();
        bridge = restarted;
      } else {
        await bridge.rewindSession(input.sessionId, "later-input", "conversation");
      }
      f.native.sessions[0]!.turnRunning = true;
      f.native.queueResult = false;
      await bridge.refreshRuntime();
      expect((await bridge.history(input.sessionId)).items.find(item => item.id === receipt.messageId)).toMatchObject({ text: input.text, delivery: "session-received", queueSettled: true });
      expect(f.state.nativeDesktopReceipt(input.idempotencyKey)?.state).toBe("session-received");
      await expect(bridge.cancelQueuedTurn(input.sessionId, receipt.commandId)).rejects.toThrow("当前不可调整");
      expect(f.native.calls.some(call => call.method === "cancelQueuedMessage")).toBe(false);
    } finally { await restarted?.close(); await f.close(); }
  });

  it("publishes an unmatched success when the queue observation disconnects", async () => {
    const f = await fixture();
    try {
      const receipt = await f.bridge.startTurn(input);
      await f.message({ type: "user", uuid: receipt.messageId, message: { content: input.text } });
      f.native.inputQueueDrained.mockRejectedValueOnce(new InspectorDisconnectedError("Disconnected during queue observation"));
      await f.message({ type: "result", uuid: "unmatched-success", is_error: false });
      expect(f.eventLog.latestItem(input.sessionId, "turn.completed", "unmatched-success")).toBeDefined();
      expect(f.bridge.session(input.sessionId)?.lastCompletedTurnId).toBe("unmatched-success");
      expect(f.state.nativeDesktopReceipt(input.idempotencyKey)?.queueSettled).toBeUndefined();
      f.native.inputQueueDrained.mockResolvedValue(true);
      await f.bridge.refreshRuntime();
      expect(f.state.nativeDesktopReceipt(input.idempotencyKey)).toMatchObject({ state: "session-received", queueSettled: true });
    } finally { await f.close(); }
  });

  it("broadcasts unmatched native results without inventing Bridge command identities or receipts", async () => {
    const f = await fixture();
    try {
      const user = { type: "user", uuid: "desktop-input", message: { content: "desktop text" } };
      f.native.page.messages = [user, { ...user, uuid: "unobserved" }];
      await f.message(user);
      await f.message({ type: "command_lifecycle", command_uuid: "desktop-input", state: "queued" });
      await f.message({ type: "command_lifecycle", command_uuid: "desktop-input", state: "started" });
      await f.message({ type: "result", uuid: "desktop-result", user_message_uuid: "desktop-input", is_error: false });
      expect((await f.bridge.history("local-native")).items.map(item => item.delivery)).toEqual([undefined, undefined]);
      expect(f.state.listNativeDesktopReceipts()).toEqual([]);
      const terminal = f.eventLog.replay(0).filter(event => event.type === "turn.completed");
      expect(terminal).toHaveLength(1);
      expect(terminal[0]).toMatchObject({ sessionId: "local-native", itemId: "desktop-result", data: {} });
      expect(terminal[0]?.turnId).toBeUndefined();
      expect(f.bridge.session("local-native")).toMatchObject({ lastCompletedTurnId: "desktop-result", turnState: "idle" });
      await f.bridge.refreshRuntime();
      expect(f.bridge.session("local-native")?.lastCompletedTurnId).toBe("desktop-result");
    } finally { await f.close(); }
  });

  it("accepts a true failure result after the matching lifecycle reported completion", async () => {
    const f = await fixture();
    try {
      const receipt = await f.bridge.startTurn(input);
      await f.message({ type: "command_lifecycle", command_uuid: receipt.messageId, state: "completed" });
      expect(f.state.nativeDesktopReceipt("key")?.state).toBe("completed");
      await f.message({ type: "result", uuid: "failed-result", user_message_uuid: receipt.messageId, is_error: true, result: "native execution failed" });
      expect(f.state.nativeDesktopReceipt("key")?.state).toBe("failed");
      await f.message({ type: "command_lifecycle", command_uuid: receipt.messageId, state: "completed" });
      expect(f.state.nativeDesktopReceipt("key")?.state).toBe("failed");
    } finally { await f.close(); }
  });

  it("persists idempotent receipts without inventing execution acknowledgments", async () => {
    const f = await fixture();
    let restarted: ClaudeDesktopBridge | undefined;
    try {
      const first = await f.bridge.startTurn(input);
      expect(first.state).toBe("submitted");
      expect(f.native.calls.filter(call => call.method === "sendMessage")).toHaveLength(1);
      const send = f.native.calls.find(call => call.method === "sendMessage")!;
      expect(send.args[7]).toBe(first.messageId);
      expect(send.args[14]).toEqual({ personSent: true, rejectUndelivered: true });
      await f.bridge.close();
      restarted = new ClaudeDesktopBridge(f.options);
      await restarted.initialize();
      expect((await restarted.startTurn(input)).commandId).toBe(first.commandId);
      expect(f.native.calls.filter(call => call.method === "sendMessage")).toHaveLength(1);
      expect(f.eventLog.replay(0).some(event => event.type === "turn.started")).toBe(false);
    } finally { await restarted?.close(); await f.close(); }
  });

  it("accepts only the exact native UUID and keeps later commands after a result", async () => {
    const f = await fixture();
    try {
      const receipt = await f.bridge.startTurn(input);
      await f.message({ type: "user", uuid: "other-input", message: { content: "hello" } });
      expect(f.state.nativeDesktopReceipt("key")?.state).toBe("submitted");
      await f.message({ type: "user", uuid: receipt.messageId, message: { content: "hello" } });
      expect(f.state.nativeDesktopReceipt("key")?.state).toBe("session-received");
      const later = await f.bridge.startTurn({ ...input, idempotencyKey: "later", requestId: "later" });
      await f.message({ type: "result", uuid: "result", subtype: "success", is_error: false });
      expect(f.state.nativeDesktopReceipt("later")?.messageId).toBe(later.messageId);
      expect(f.state.nativeDesktopReceipt("later")?.state).toBe("submitted");
    } finally { await f.close(); }
  });

  it("settles only UUIDs explicitly named by native lifecycle and result messages", async () => {
    const f = await fixture();
    try {
      const receipt = await f.bridge.startTurn(input);
      await f.message({ type: "user", uuid: receipt.messageId, message: { content: "hello" } });
      await f.message({ type: "command_lifecycle", command_uuid: receipt.messageId, state: "started", uuid: "start-event" });
      expect(f.state.nativeDesktopReceipt("key")?.state).toBe("running");
      await f.message({ type: "user", uuid: receipt.messageId, message: { content: "hello" } });
      expect(f.state.nativeDesktopReceipt("key")?.state).toBe("running");
      const later = await f.bridge.startTurn({ ...input, idempotencyKey: "next", requestId: "next" });
      await f.message({ type: "result", uuid: "native-result", is_error: false, user_message_uuid: receipt.messageId, user_message_uuids: [receipt.messageId] });
      expect(f.state.nativeDesktopReceipt("key")?.state).toBe("completed");
      expect(f.state.nativeDesktopReceipt("next")?.messageId).toBe(later.messageId);
      expect(f.state.nativeDesktopReceipt("next")?.state).toBe("submitted");
    } finally { await f.close(); }
  });

  it("retains uncertain delivery and never automatically retries it", async () => {
    const f = await fixture();
    try {
      f.native.sendError = new InspectorDisconnectedError("connection lost after submission");
      expect((await f.bridge.startTurn(input)).state).toBe("uncertain");
      f.native.sendError = undefined;
      await f.bridge.refreshRuntime();
      expect((await f.bridge.startTurn(input)).state).toBe("uncertain");
      expect(f.native.calls.filter(call => call.method === "sendMessage")).toHaveLength(1);
    } finally { await f.close(); }
  });

  it("reconciles a lost proposal send response from the matching Native history message", async () => {
    const f = await fixture();
    try {
      const error = "connection lost after submission";
      f.native.sendError = new InspectorDisconnectedError(error);
      const receipt = await f.bridge.startTurn({ ...input, origin: "system", source: "assistant-proposal" });
      expect(receipt).toMatchObject({ state: "uncertain", error });
      f.native.sendError = undefined;
      const userMessage = { type: "user", uuid: "unrelated", message: { content: input.text } };
      f.native.page.messages = [userMessage];
      await f.bridge.history(input.sessionId);
      expect(f.state.nativeDesktopReceipt(input.idempotencyKey)?.state).toBe("uncertain");

      f.native.page.messages = [{ ...userMessage, uuid: receipt.messageId }];
      expect((await f.bridge.history(input.sessionId)).items[0]).toMatchObject({ id: receipt.messageId, delivery: "session-received" });
      const persisted = f.state.nativeDesktopReceipt(input.idempotencyKey);
      expect(persisted?.state).toBe("session-received");
      expect(persisted?.error).toBeUndefined();
      expect(f.eventLog.latestItem(input.sessionId, "message.delivery", receipt.messageId)?.data).toMatchObject({
        source: "assistant-proposal", delivery: "session-received", messageId: receipt.messageId,
      });
      expect(f.native.calls.filter(call => call.method === "sendMessage")).toHaveLength(1);
    } finally { await f.close(); }
  });

  it.each([false, true])("projects native queued acceptance after an early echo (%s)", async echo => {
    const f = await fixture();
    let resolveSend!: (result: unknown) => void;
    f.native.sendReply = new Promise(resolve => { resolveSend = resolve; });
    const sending = f.bridge.startTurn(input);
    try {
      await vi.waitFor(() => expect(f.native.calls.some(call => call.method === "sendMessage")).toBe(true));
      const messageId = f.state.nativeDesktopReceipt(input.idempotencyKey)!.messageId;
      if (echo) await f.message({ type: "user", uuid: messageId, message: { content: "hello" } });
      resolveSend({ delivered: true, queued: true });
      const receipt = await sending;
      expect(receipt).toMatchObject({ state: "queued", queueMode: "deferred" });
      expect(f.state.nativeDesktopReceipt(input.idempotencyKey)).toMatchObject(receipt);
      expect(f.bridge.session(input.sessionId)).toMatchObject({ pendingCount: 1, pendingCommandIds: [receipt.commandId] });
      expect(f.eventLog.replay(0).at(-1)).toMatchObject({ type: "message.delivery", data: { delivery: "queued", commandId: receipt.commandId, messageId } });
    } finally { resolveSend({ delivered: true }); await sending; await f.close(); }
  });

  it.each(["queued", "started", "cancelled"])("preserves early native %s when queued acceptance arrives last", async state => {
    const f = await fixture();
    let resolveSend!: (result: unknown) => void;
    f.native.sendReply = new Promise(resolve => { resolveSend = resolve; });
    const sending = f.bridge.startTurn(input);
    try {
      await vi.waitFor(() => expect(f.native.calls.some(call => call.method === "sendMessage")).toBe(true));
      const messageId = f.state.nativeDesktopReceipt(input.idempotencyKey)!.messageId;
      await f.message({ type: "command_lifecycle", command_uuid: messageId, state });
      resolveSend({ delivered: true, queued: true });
      const receipt = await sending;
      expect(receipt.state).toBe(state === "started" ? "running" : state);
      if (state === "queued") expect(receipt).toMatchObject({ queueMode: "steered" });
      expect(f.bridge.session(input.sessionId)?.pendingCommandIds).toEqual(state === "queued" ? [receipt.commandId] : []);
    } finally { resolveSend({ delivered: true }); await sending; await f.close(); }
  });

  it("does not infer queued from a successful immediate steer", async () => {
    const f = await fixture();
    try {
      f.native.sessions[0]!.turnRunning = true;
      await f.bridge.refreshRuntime();
      expect((await f.bridge.steerTurn(input)).state).toBe("submitted");
      expect(f.bridge.session(input.sessionId)?.pendingCount).toBe(0);
    } finally { await f.close(); }
  });

  it("surfaces explicit native refusal instead of reporting a successful send", async () => {
    const f = await fixture();
    try {
      f.native.sendResult = { delivered: false, reason: "Target session was archived" };
      await expect(f.bridge.startTurn(input)).rejects.toThrow("Target session was archived");
      expect(f.state.nativeDesktopReceipt(input.idempotencyKey)).toMatchObject({ state: "failed", error: "Target session was archived" });
    } finally { await f.close(); }
  });

  it.each(["normal", "immediate"])("persists the %s send route before Native replies", async send => {
    const f = await fixture();
    let resolveSend!: (value: unknown) => void;
    f.native.sendReply = new Promise(resolve => { resolveSend = resolve; });
    const sending = send === "immediate" ? f.bridge.steerTurn(input) : f.bridge.startTurn(input);
    try {
      await vi.waitFor(() => expect(f.native.calls.some(call => call.method === "sendMessage")).toBe(true));
      expect(f.state.nativeDesktopReceipt(input.idempotencyKey)).toMatchObject({ state: "dispatching", queueMode: send === "immediate" ? "steered" : "deferred" });
    } finally { resolveSend({ delivered: true }); await sending; await f.close(); }
  });

  it.each([
    { send: "normal", action: "send-now" }, { send: "immediate", action: "send-now" }, { send: "legacy", action: "send-now" },
    { send: "normal", action: "cancel" }, { send: "immediate", action: "cancel" }, { send: "legacy", action: "cancel" },
  ])("allows $action for a $send received message without a native queued flag", async ({ send, action }) => {
    const f = await fixture();
    try {
      f.native.sessions[0]!.turnRunning = true;
      f.native.sendResult = { delivered: true };
      await f.bridge.refreshRuntime();
      const receipt = send === "immediate" ? await f.bridge.steerTurn(input) : await f.bridge.startTurn(input);
      await f.message({ type: "user", uuid: receipt.messageId, message: { content: input.text } });
      expect(receipt.state).toBe("session-received");
      expect(f.bridge.session(input.sessionId)?.pendingCount).toBe(0);
      if (send === "legacy") { delete receipt.queueMode; f.state.saveNativeDesktopReceipt(receipt); }
      const method = action === "send-now" ? send === "immediate" ? "sendSteeredNow" : "promoteQueuedMessage" : "cancelQueuedMessage";
      const operate = () => action === "send-now" ? f.bridge.steerQueuedTurn(input.sessionId, receipt.commandId) : f.bridge.cancelQueuedTurn(input.sessionId, receipt.commandId);
      f.native.calls = [];
      if (send === "legacy" && action === "send-now") {
        await expect(operate()).rejects.toThrow("发送通道");
        expect(f.native.calls).toEqual([]);
        return;
      }
      f.native.queueResult = false;
      await expect(operate()).rejects.toThrow(action === "send-now" ? "无法立即发送" : "无法撤回");
      expect(receipt.state).toBe("session-received");
      expect(f.native.calls).toEqual([{ method, args: [input.sessionId, receipt.messageId] }]);
      f.native.queueResult = true;
      expect(await operate()).toMatchObject({ commandId: receipt.commandId, state: action === "send-now" ? "session-received" : "cancelled" });
      expect(f.native.calls).toEqual([{ method, args: [input.sessionId, receipt.messageId] }, { method, args: [input.sessionId, receipt.messageId] }]);
      expect(f.native.calls.some(call => ["sendMessage", "interrupt"].includes(call.method))).toBe(false);
    } finally { await f.close(); }
  });

  it.each(["deferred", "steered"] as const)("uses the native %s Send now operation and checks its result", async mode => {
    const f = await fixture();
    try {
      f.native.sendResult = { delivered: true, queued: true };
      const receipt = await f.bridge.startTurn(input);
      if (mode === "steered") await f.message({ type: "command_lifecycle", command_uuid: receipt.messageId, state: "queued" });
      f.native.calls = [];
      await f.bridge.steerQueuedTurn(input.sessionId, receipt.commandId);
      const method = mode === "deferred" ? "promoteQueuedMessage" : "sendSteeredNow";
      expect(f.native.calls).toEqual([{ method, args: [input.sessionId, receipt.messageId] }]);
      f.native.queueResult = false;
      await expect(f.bridge.steerQueuedTurn(input.sessionId, receipt.commandId)).rejects.toThrow("无法立即发送");
      expect(f.native.calls.map(call => call.method)).toEqual([method, method]);
      expect(f.state.nativeDesktopReceipt(input.idempotencyKey)?.state).toBe("queued");
    } finally { await f.close(); }
  });

  it.each([false, true])("withdraws only the selected native UUID when cancellation succeeds (%s)", async accepted => {
    const f = await fixture();
    try {
      f.native.sendResult = { delivered: true, queued: true };
      const receipt = await f.bridge.startTurn(input);
      f.native.calls = [];
      f.native.queueResult = accepted;
      if (accepted) {
        expect(await f.bridge.cancelQueuedTurn(input.sessionId, receipt.commandId)).toMatchObject({ commandId: receipt.commandId, state: "cancelled" });
        expect(f.bridge.session(input.sessionId)).toMatchObject({ pendingCount: 0, pendingCommandIds: [] });
        expect(f.eventLog.replay(0).at(-1)).toMatchObject({ type: "message.delivery", data: { delivery: "cancelled", commandId: receipt.commandId } });
      } else {
        await expect(f.bridge.cancelQueuedTurn(input.sessionId, receipt.commandId)).rejects.toThrow("无法撤回");
        expect(f.state.nativeDesktopReceipt(input.idempotencyKey)?.state).toBe("queued");
      }
      expect(f.native.calls).toEqual([{ method: "cancelQueuedMessage", args: [input.sessionId, receipt.messageId] }]);
    } finally { await f.close(); }
  });

  it("rejects actions for a foreign session or an already consumed command before native calls", async () => {
    const f = await fixture();
    try {
      f.native.sendResult = { delivered: true, queued: true };
      const receipt = await f.bridge.startTurn(input);
      f.native.calls = [];
      await expect(f.bridge.steerQueuedTurn("other-session", receipt.commandId)).rejects.toThrow();
      await expect(f.bridge.cancelQueuedTurn("other-session", receipt.commandId)).rejects.toThrow();
      await f.message({ type: "command_lifecycle", command_uuid: receipt.messageId, state: "started" });
      await expect(f.bridge.steerQueuedTurn(input.sessionId, receipt.commandId)).rejects.toThrow();
      await expect(f.bridge.cancelQueuedTurn(input.sessionId, receipt.commandId)).rejects.toThrow();
      expect(f.native.calls).toEqual([]);
    } finally { await f.close(); }
  });

  it("persists rekeyed native identity and follows the new UUID through withdrawal and completion", async () => {
    const f = await fixture();
    try {
      f.native.sendResult = { delivered: true, queued: true };
      const receipt = await f.bridge.startTurn(input);
      const previousMessageId = receipt.messageId;
      const changed = once(f.bridge, "changed");
      f.native.emit("event", { type: "steers_rekeyed", sessionId: input.sessionId, rekeyedSteers: [{ from: previousMessageId, to: "native-rekeyed" }] });
      await changed;
      expect(f.state.nativeDesktopReceipt(input.idempotencyKey)).toMatchObject({ commandId: receipt.commandId, requestId: input.requestId, messageId: "native-rekeyed" });
      expect(f.eventLog.replay(0).at(-1)).toMatchObject({ type: "message.delivery", itemId: "native-rekeyed", data: { previousMessageId, messageId: "native-rekeyed", commandId: receipt.commandId } });
      f.native.calls = [];
      f.native.queueResult = false;
      await expect(f.bridge.cancelQueuedTurn(input.sessionId, receipt.commandId)).rejects.toThrow();
      expect(f.native.calls).toEqual([{ method: "cancelQueuedMessage", args: [input.sessionId, "native-rekeyed"] }]);
      await f.message({ type: "command_lifecycle", command_uuid: "native-rekeyed", state: "started" });
      await f.message({ type: "result", user_message_uuid: "native-rekeyed", is_error: false });
      expect(f.state.nativeDesktopReceipt(input.idempotencyKey)).toMatchObject({ state: "completed", messageId: "native-rekeyed" });
    } finally { await f.close(); }
  });

  it.each([
    { withdrawn: true, lost: false, state: "cancelled" },
    { withdrawn: false, lost: true, state: "queued" },
    { withdrawn: true, lost: true, state: "queued" },
  ])("handles Native close withdrawal without confusing lost inputs ($withdrawn/$lost)", async ({ withdrawn, lost, state }) => {
    const f = await fixture();
    try {
      f.native.sendResult = { delivered: true, queued: true };
      const receipt = await f.bridge.startTurn(input);
      const changed = once(f.bridge, "changed");
      f.native.emit("event", { type: "close", sessionId: input.sessionId, code: 0, ...(withdrawn ? { withdrawnUuids: [receipt.messageId] } : {}), ...(lost ? { lostUuids: [receipt.messageId] } : {}) });
      await changed;
      expect(f.state.nativeDesktopReceipt(input.idempotencyKey)?.state).toBe(state);
      expect(f.bridge.session(input.sessionId)?.pendingCount).toBe(state === "queued" ? 1 : 0);
    } finally { await f.close(); }
  });

  it("retains Desktop withdrawal that arrives before queued send acceptance", async () => {
    const f = await fixture();
    let resolveSend!: (result: unknown) => void;
    f.native.sendReply = new Promise(resolve => { resolveSend = resolve; });
    const sending = f.bridge.startTurn(input);
    try {
      await vi.waitFor(() => expect(f.native.calls.some(call => call.method === "sendMessage")).toBe(true));
      const messageId = f.state.nativeDesktopReceipt(input.idempotencyKey)!.messageId;
      const changed = once(f.bridge, "changed");
      f.native.emit("event", { type: "held_input_withdrawn", sessionId: input.sessionId, withdrawnUuids: [messageId] });
      await changed;
      resolveSend({ delivered: true, queued: true });
      expect((await sending).state).toBe("cancelled");
      expect(f.bridge.session(input.sessionId)?.pendingCount).toBe(0);
    } finally { resolveSend({ delivered: true }); await sending; await f.close(); }
  });

  it("observes Desktop withdrawal only for explicit withdrawn UUIDs", async () => {
    const f = await fixture();
    try {
      f.native.sendResult = { delivered: true, queued: true };
      const first = await f.bridge.startTurn(input);
      const second = await f.bridge.startTurn({ ...input, requestId: "second", idempotencyKey: "second" });
      const changed = once(f.bridge, "changed");
      f.native.emit("event", { type: "held_input_withdrawn", sessionId: input.sessionId, withdrawnUuids: [first.messageId], lostUuids: [second.messageId] });
      await changed;
      expect(f.state.nativeDesktopReceipt(input.idempotencyKey)?.state).toBe("cancelled");
      expect(f.state.nativeDesktopReceipt("second")?.state).toBe("queued");
      expect(f.bridge.session(input.sessionId)?.pendingCommandIds).toEqual([second.commandId]);
    } finally { await f.close(); }
  });

  it("restores queued identity and mode without sending its contents again", async () => {
    const f = await fixture();
    let restarted: ClaudeDesktopBridge | undefined;
    try {
      f.native.sendResult = { delivered: true, queued: true };
      const receipt = await f.bridge.startTurn(input);
      await f.message({ type: "command_lifecycle", command_uuid: receipt.messageId, state: "queued" });
      await f.bridge.close();
      restarted = new ClaudeDesktopBridge(f.options);
      await restarted.initialize();
      f.native.calls = [];
      await restarted.steerQueuedTurn(input.sessionId, receipt.commandId);
      expect(f.native.calls).toEqual([{ method: "sendSteeredNow", args: [input.sessionId, receipt.messageId] }]);
      expect(restarted.session(input.sessionId)?.pendingCommandIds).toEqual([receipt.commandId]);
    } finally { await restarted?.close(); await f.close(); }
  });

  describe("v113 queue action boundaries", () => {
    it.each([
      { action: "send-now", method: "promoteQueuedMessage", failure: new Error("Native promotion response rejected"), state: "completed" },
      { action: "cancel", method: "cancelQueuedMessage", failure: new InspectorDisconnectedError("Native cancellation response lost"), state: "cancelled" },
    ] as const)("preserves committed Native evidence when $action subsequently rejects", async ({ action, method, failure, state }) => {
      const f = await fixture();
      let rejectCall!: (error: Error) => void;
      let pending: ReturnType<ClaudeDesktopBridge["steerQueuedTurn"]> | undefined;
      try {
        f.native.sendResult = { delivered: true, queued: true };
        const receipt = await f.bridge.startTurn(input);
        const identity = { commandId: receipt.commandId, requestId: receipt.requestId, messageId: receipt.messageId };
        const original = f.native.call.bind(f.native);
        vi.spyOn(f.native, "call").mockImplementation((called, args = []) => {
          if (called !== method) return original(called, args);
          f.native.calls.push({ method: called, args });
          return new Promise((_resolve, reject) => { rejectCall = reject; });
        });
        f.native.calls = [];
        pending = action === "send-now" ? f.bridge.steerQueuedTurn(input.sessionId, receipt.commandId) : f.bridge.cancelQueuedTurn(input.sessionId, receipt.commandId);
        await vi.waitFor(() => expect(f.native.calls).toEqual([{ method, args: [input.sessionId, identity.messageId] }]));
        if (action === "send-now") {
          await f.message({ type: "command_lifecycle", command_uuid: identity.messageId, state: "started" });
          await f.message({ type: "result", user_message_uuid: identity.messageId, is_error: false });
        } else {
          const changed = once(f.bridge, "changed");
          f.native.emit("event", { type: "held_input_withdrawn", sessionId: input.sessionId, withdrawnUuids: [identity.messageId] });
          await changed;
          f.native.ready = false;
          f.native.emit("disconnected");
        }
        expect(f.state.nativeDesktopReceipt(input.idempotencyKey)).toMatchObject({ ...identity, state });
        const eventCount = f.eventLog.replay(0).length;
        const rejected = expect(pending).rejects.toBe(failure);
        rejectCall(failure);
        await rejected;
        expect(f.state.nativeDesktopReceipt(input.idempotencyKey)).toMatchObject({ ...identity, state });
        expect(f.bridge.session(input.sessionId)?.pendingCommandIds).toEqual([]);
        expect(f.eventLog.replay(0)).toHaveLength(eventCount);
        expect(f.native.calls).toEqual([{ method, args: [input.sessionId, identity.messageId] }]);
      } finally {
        rejectCall?.(failure);
        await pending?.catch(() => undefined);
        await f.close();
      }
    });

    it.each([
      { action: "send-now", mode: "deferred", nativeState: "started", accepted: false },
      { action: "send-now", mode: "steered", nativeState: "completed", accepted: false },
      { action: "cancel", mode: "deferred", nativeState: "completed", accepted: false },
      { action: "cancel", mode: "steered", nativeState: "completed", accepted: true },
      { action: "cancel", mode: "steered", nativeState: "failed", accepted: true },
      { action: "cancel", mode: "steered", nativeState: "cancelled", accepted: true },
    ] as const)("retains $nativeState during pending $mode $action (Native=$accepted)", async ({ action, mode, nativeState, accepted }) => {
      const f = await fixture();
      let resolveCall!: (result: boolean) => void;
      let pending: ReturnType<ClaudeDesktopBridge["steerQueuedTurn"]> | undefined;
      try {
        f.native.sendResult = { delivered: true, queued: true };
        const receipt = await f.bridge.startTurn(input);
        const identity = { commandId: receipt.commandId, requestId: receipt.requestId, messageId: receipt.messageId };
        if (mode === "steered") await f.message({ type: "command_lifecycle", command_uuid: identity.messageId, state: "queued" });
        const method = action === "cancel" ? "cancelQueuedMessage" : mode === "steered" ? "sendSteeredNow" : "promoteQueuedMessage";
        const original = f.native.call.bind(f.native);
        vi.spyOn(f.native, "call").mockImplementation((called, args = []) => {
          if (called !== method) return original(called, args);
          f.native.calls.push({ method: called, args });
          return new Promise(resolve => { resolveCall = resolve; });
        });
        f.native.calls = [];
        pending = action === "send-now" ? f.bridge.steerQueuedTurn(input.sessionId, receipt.commandId) : f.bridge.cancelQueuedTurn(input.sessionId, receipt.commandId);
        await vi.waitFor(() => expect(f.native.calls).toEqual([{ method, args: [input.sessionId, identity.messageId] }]));
        await f.message({ type: "command_lifecycle", command_uuid: identity.messageId, state: "started" });
        if (nativeState === "completed" || nativeState === "failed") await f.message({ type: "result", user_message_uuid: identity.messageId, is_error: nativeState === "failed" });
        if (nativeState === "cancelled") await f.message({ type: "command_lifecycle", command_uuid: identity.messageId, state: "cancelled" });
        const state = nativeState === "started" ? "running" : nativeState;
        expect(f.state.nativeDesktopReceipt(input.idempotencyKey)).toMatchObject({ ...identity, state });
        if (accepted) {
          resolveCall(true);
          expect.soft(await pending).toMatchObject({ ...identity, state });
        } else {
          const rejected = expect(pending).rejects.toThrow(action === "cancel" ? "无法撤回" : "无法立即发送");
          resolveCall(false);
          await rejected;
        }
        expect.soft(f.state.nativeDesktopReceipt(input.idempotencyKey)).toMatchObject({ ...identity, state });
        expect(f.bridge.session(input.sessionId)?.pendingCommandIds).toEqual([]);
        expect(f.native.calls).toEqual([{ method, args: [input.sessionId, identity.messageId] }]);
        expect(f.eventLog.replay(0).filter(event => event.type === "message.delivery" && event.data.delivery === "cancelled")).toEqual([]);
      } finally {
        resolveCall?.(false);
        await pending?.catch(() => undefined);
        await f.close();
      }
    });

    it("keeps identical text and attachments independently actionable by Native UUID", async () => {
      const f = await fixture();
      try {
        f.native.sendResult = { delivered: true, queued: true };
        const attachments = [{ id: "same-image", name: "same.png", mimeType: "image/png" as const, size: 2, data: "aGk=" }];
        const first = await f.bridge.startTurn({ ...input, attachments });
        const second = await f.bridge.startTurn({ ...input, attachments, requestId: "second-identical", idempotencyKey: "second-identical" });
        expect(first.commandId).not.toBe(second.commandId);
        expect(first.messageId).not.toBe(second.messageId);
        const sends = f.native.calls.filter(call => call.method === "sendMessage");
        expect(sends).toHaveLength(2);
        expect(sends.map(call => [call.args[1], call.args[2], call.args[7]])).toEqual([
          [input.text, [{ base64: "aGk=", mimeType: "image/png", filename: "same.png" }], first.messageId],
          [input.text, [{ base64: "aGk=", mimeType: "image/png", filename: "same.png" }], second.messageId],
        ]);
        await f.message({ type: "command_lifecycle", command_uuid: second.messageId, state: "queued" });
        f.native.calls = [];
        f.native.queueResult = false;
        await expect(f.bridge.cancelQueuedTurn(input.sessionId, first.commandId)).rejects.toThrow("无法撤回");
        expect(f.bridge.session(input.sessionId)?.pendingCommandIds).toEqual([first.commandId, second.commandId]);
        f.native.queueResult = true;
        await f.bridge.steerQueuedTurn(input.sessionId, second.commandId);
        await f.message({ type: "command_lifecycle", command_uuid: second.messageId, state: "started" });
        await f.message({ type: "result", user_message_uuid: second.messageId, is_error: false });
        expect(f.state.nativeDesktopReceipt(input.idempotencyKey)).toMatchObject({ commandId: first.commandId, messageId: first.messageId, state: "queued" });
        expect(f.state.nativeDesktopReceipt("second-identical")).toMatchObject({ commandId: second.commandId, messageId: second.messageId, state: "completed" });
        await f.bridge.cancelQueuedTurn(input.sessionId, first.commandId);
        expect(f.state.nativeDesktopReceipt(input.idempotencyKey)?.state).toBe("cancelled");
        expect(f.bridge.session(input.sessionId)?.pendingCommandIds).toEqual([]);
        expect(f.native.calls).toEqual([
          { method: "cancelQueuedMessage", args: [input.sessionId, first.messageId] },
          { method: "sendSteeredNow", args: [input.sessionId, second.messageId] },
          { method: "cancelQueuedMessage", args: [input.sessionId, first.messageId] },
        ]);
      } finally { await f.close(); }
    });

    it("follows repeated and multi-hop rekeys through new UUID actions and restart", async () => {
      const f = await fixture();
      let restarted: ClaudeDesktopBridge | undefined;
      try {
        f.native.sendResult = { delivered: true, queued: true };
        const receipt = await f.bridge.startTurn(input);
        const originalMessageId = receipt.messageId;
        const identity = { commandId: receipt.commandId, requestId: receipt.requestId, messageId: "native-hop-final", state: "queued", queueMode: "steered" };
        await f.message({ type: "command_lifecycle", command_uuid: originalMessageId, state: "queued" });
        for (const rekeyedSteers of [
          [{ from: originalMessageId, to: "native-hop-middle" }, { from: originalMessageId, to: "native-hop-middle" }, { from: "native-hop-middle", to: "native-hop-final" }],
          [{ from: originalMessageId, to: "native-stale-hop" }, { from: "native-hop-middle", to: "native-stale-hop" }],
        ]) {
          const changed = once(f.bridge, "changed");
          f.native.emit("event", { type: "steers_rekeyed", sessionId: input.sessionId, rekeyedSteers });
          await changed;
          expect(f.state.nativeDesktopReceipt(input.idempotencyKey)).toMatchObject(identity);
        }
        expect(f.eventLog.replay(0).filter(event => event.data.previousMessageId).map(event => [event.data.previousMessageId, event.data.messageId, event.data.commandId])).toEqual([
          [originalMessageId, "native-hop-middle", receipt.commandId],
          ["native-hop-middle", "native-hop-final", receipt.commandId],
        ]);
        f.native.calls = [];
        expect(await f.bridge.steerQueuedTurn(input.sessionId, receipt.commandId)).toMatchObject(identity);
        expect(f.native.calls).toEqual([{ method: "sendSteeredNow", args: [input.sessionId, "native-hop-final"] }]);
        await f.bridge.close();
        const restoredNative = new NativeDesktop();
        restarted = new ClaudeDesktopBridge({ ...f.options, inspector: restoredNative });
        await restarted.initialize();
        expect(restoredNative.calls.some(call => ["sendMessage", "interrupt"].includes(call.method))).toBe(false);
        restoredNative.calls = [];
        restoredNative.queueResult = false;
        await expect(restarted.cancelQueuedTurn(input.sessionId, receipt.commandId)).rejects.toThrow("无法撤回");
        expect(restoredNative.calls).toEqual([{ method: "cancelQueuedMessage", args: [input.sessionId, "native-hop-final"] }]);
        expect(f.state.nativeDesktopReceipt(input.idempotencyKey)).toMatchObject(identity);
        for (const message of [
          { type: "command_lifecycle", command_uuid: originalMessageId, state: "started" },
          { type: "command_lifecycle", command_uuid: "native-hop-middle", state: "started" },
          { type: "command_lifecycle", command_uuid: "native-hop-final", state: "started" },
          { type: "result", user_message_uuid: "native-hop-final", is_error: false },
        ]) {
          const changed = once(restarted, "changed");
          restoredNative.emit("event", { type: "message", sessionId: input.sessionId, message });
          await changed;
          if (message.command_uuid !== "native-hop-final" && message.type !== "result") expect(f.state.nativeDesktopReceipt(input.idempotencyKey)?.state).toBe("queued");
        }
        expect(f.state.nativeDesktopReceipt(input.idempotencyKey)).toMatchObject({ ...identity, state: "completed" });
        expect(restarted.session(input.sessionId)?.pendingCommandIds).toEqual([]);
        restoredNative.calls = [];
        await expect(restarted.steerQueuedTurn(input.sessionId, receipt.commandId)).rejects.toThrow("当前不可调整");
        await expect(restarted.cancelQueuedTurn(input.sessionId, receipt.commandId)).rejects.toThrow("当前不可调整");
        expect(restoredNative.calls).toEqual([]);
      } finally { await restarted?.close(); await f.close(); }
    });

    it("isolates rekeys, public withdrawal and actions when sessions reuse a Native UUID", async () => {
      const f = await fixture();
      try {
        f.native.sessions.push({ ...f.native.sessions[0], sessionId: "other-native" });
        await f.bridge.refreshRuntime();
        f.native.sendResult = { delivered: true, queued: true };
        const local = await f.bridge.startTurn(input);
        const foreign = await f.bridge.startTurn({ ...input, sessionId: "other-native", requestId: "foreign", idempotencyKey: "foreign" });
        const sharedMessageId = local.messageId;
        const oldForeignMessageId = foreign.messageId;
        for (const rekeyedSteers of [
          [{ from: sharedMessageId, to: "foreign-only-rekey" }],
          [{ from: oldForeignMessageId, to: sharedMessageId }],
        ]) {
          const changed = once(f.bridge, "changed");
          f.native.emit("event", { type: "steers_rekeyed", sessionId: "other-native", rekeyedSteers });
          await changed;
          expect(f.state.nativeDesktopReceipt(input.idempotencyKey)).toMatchObject({ messageId: sharedMessageId, state: "queued" });
        }
        expect(f.state.nativeDesktopReceipt("foreign")).toMatchObject({ commandId: foreign.commandId, messageId: sharedMessageId, state: "queued" });
        f.native.calls = [];
        await expect(f.bridge.steerQueuedTurn("other-native", local.commandId)).rejects.toThrow("当前不可调整");
        await expect(f.bridge.cancelQueuedTurn(input.sessionId, foreign.commandId)).rejects.toThrow("当前不可调整");
        for (const uuid of [oldForeignMessageId, sharedMessageId]) {
          const changed = once(f.bridge, "changed");
          f.native.emit("event", { type: "held_input_withdrawn", sessionId: "other-native", withdrawnUuids: [uuid], lostUuids: [sharedMessageId] });
          await changed;
          expect(f.state.nativeDesktopReceipt(input.idempotencyKey)).toMatchObject({ commandId: local.commandId, messageId: sharedMessageId, state: "queued" });
          expect(f.state.nativeDesktopReceipt("foreign")?.state).toBe(uuid === sharedMessageId ? "cancelled" : "queued");
        }
        expect(f.native.calls).toEqual([]);
        expect(f.bridge.session(input.sessionId)?.pendingCommandIds).toEqual([local.commandId]);
        expect(f.bridge.session("other-native")?.pendingCommandIds).toEqual([]);
        await f.bridge.cancelQueuedTurn(input.sessionId, local.commandId);
        expect(f.native.calls).toEqual([{ method: "cancelQueuedMessage", args: [input.sessionId, sharedMessageId] }]);
        expect(f.state.nativeDesktopReceipt(input.idempotencyKey)?.state).toBe("cancelled");
        expect(f.eventLog.replay(0).filter(event => event.data.delivery === "cancelled").map(event => [event.sessionId, event.data.commandId])).toEqual([
          ["other-native", foreign.commandId], [input.sessionId, local.commandId],
        ]);
      } finally { await f.close(); }
    });

    it("surfaces unsupported queue methods and rejects stale or unknown commands without fallback", async () => {
      const f = await fixture();
      try {
        f.native.sendResult = { delivered: true, queued: true };
        const receipt = await f.bridge.startTurn(input);
        f.native.calls = [];
        for (const method of ["promoteQueuedMessage", "sendSteeredNow", "cancelQueuedMessage"]) f.native.unsupported.add(method);
        await expect(f.bridge.steerQueuedTurn(input.sessionId, receipt.commandId)).rejects.toThrow("Unsupported Claude Desktop method: promoteQueuedMessage");
        await f.message({ type: "command_lifecycle", command_uuid: receipt.messageId, state: "queued" });
        await expect(f.bridge.steerQueuedTurn(input.sessionId, receipt.commandId)).rejects.toThrow("Unsupported Claude Desktop method: sendSteeredNow");
        await expect(f.bridge.cancelQueuedTurn(input.sessionId, receipt.commandId)).rejects.toThrow("Unsupported Claude Desktop method: cancelQueuedMessage");
        expect(f.state.nativeDesktopReceipt(input.idempotencyKey)).toMatchObject({ commandId: receipt.commandId, messageId: receipt.messageId, state: "queued", queueMode: "steered" });
        expect(f.native.calls).toEqual(["promoteQueuedMessage", "sendSteeredNow", "cancelQueuedMessage"].map(method => ({ method, args: [input.sessionId, receipt.messageId] })));
        f.native.unsupported.clear();
        await f.message({ type: "result", user_message_uuid: receipt.messageId, is_error: false });
        f.native.calls = [];
        for (const commandId of [receipt.commandId, receipt.messageId, "missing-command"]) {
          await expect(f.bridge.steerQueuedTurn(input.sessionId, commandId)).rejects.toThrow("当前不可调整");
          await expect(f.bridge.cancelQueuedTurn(input.sessionId, commandId)).rejects.toThrow("当前不可调整");
        }
        expect(f.state.nativeDesktopReceipt(input.idempotencyKey)?.state).toBe("completed");
        expect(f.native.calls).toEqual([]);
      } finally { await f.close(); }
    });

    it("surfaces delivered false after an early user echo without replaying the send", async () => {
      const f = await fixture();
      let resolveSend!: (result: unknown) => void;
      f.native.sendReply = new Promise(resolve => { resolveSend = resolve; });
      const sending = f.bridge.startTurn(input);
      try {
        await vi.waitFor(() => expect(f.native.calls.some(call => call.method === "sendMessage")).toBe(true));
        const identity = f.state.nativeDesktopReceipt(input.idempotencyKey)!;
        await f.message({ type: "user", uuid: identity.messageId, message: { content: input.text } });
        expect(f.state.nativeDesktopReceipt(input.idempotencyKey)?.state).toBe("session-received");
        const rejected = expect(sending).rejects.toThrow("Native refused after echo");
        resolveSend({ delivered: false, queued: true, reason: "Native refused after echo" });
        await rejected;
        expect(f.state.nativeDesktopReceipt(input.idempotencyKey)).toMatchObject({ commandId: identity.commandId, requestId: identity.requestId, messageId: identity.messageId, state: "failed", error: "Native refused after echo" });
        expect(f.eventLog.replay(0).filter(event => event.type === "user.message.accepted")).toMatchObject([{ itemId: identity.messageId, data: { commandId: identity.commandId } }]);
        expect(f.eventLog.replay(0).at(-1)).toMatchObject({ type: "message.delivery", data: { messageId: identity.messageId, delivery: "failed" } });
        expect(f.bridge.session(input.sessionId)?.pendingCommandIds).toEqual([]);
        expect((await f.bridge.startTurn(input)).state).toBe("failed");
        expect(f.native.calls.filter(call => call.method === "sendMessage")).toHaveLength(1);
        expect(f.native.calls.some(call => ["interrupt", "promoteQueuedMessage", "sendSteeredNow", "cancelQueuedMessage"].includes(call.method))).toBe(false);
      } finally {
        resolveSend({ delivered: true });
        await sending.catch(() => undefined);
        await f.close();
      }
    });

    it("forwards concurrent duplicate queue actions and reports each Native outcome", async () => {
      const f = await fixture();
      const releases: Array<(result: boolean) => void> = [];
      let pending: Array<ReturnType<ClaudeDesktopBridge["steerQueuedTurn"]>> = [];
      try {
        f.native.sendResult = { delivered: true, queued: true };
        const first = await f.bridge.startTurn(input);
        const second = await f.bridge.startTurn({ ...input, requestId: "duplicate-cancel", idempotencyKey: "duplicate-cancel" });
        const original = f.native.call.bind(f.native);
        vi.spyOn(f.native, "call").mockImplementation((method, args = []) => {
          if (!["promoteQueuedMessage", "cancelQueuedMessage"].includes(method)) return original(method, args);
          f.native.calls.push({ method, args });
          return new Promise(resolve => { releases.push(resolve); });
        });
        f.native.calls = [];
        pending = [
          f.bridge.steerQueuedTurn(input.sessionId, first.commandId), f.bridge.steerQueuedTurn(input.sessionId, first.commandId),
          f.bridge.cancelQueuedTurn(input.sessionId, second.commandId), f.bridge.cancelQueuedTurn(input.sessionId, second.commandId),
        ];
        const outcomes = Promise.allSettled(pending);
        await vi.waitFor(() => expect(releases).toHaveLength(4));
        releases.forEach((release, index) => release(index % 2 === 0));
        const results = await outcomes;
        expect(results.map(result => result.status)).toEqual(["fulfilled", "rejected", "fulfilled", "rejected"]);
        expect(results[0]).toMatchObject({ value: { commandId: first.commandId, messageId: first.messageId, state: "queued" } });
        expect(results[2]).toMatchObject({ value: { commandId: second.commandId, messageId: second.messageId, state: "cancelled" } });
        expect(results[1]).toMatchObject({ reason: { message: expect.stringContaining("无法立即发送") } });
        expect(results[3]).toMatchObject({ reason: { message: expect.stringContaining("无法撤回") } });
        expect(f.state.nativeDesktopReceipt(input.idempotencyKey)?.state).toBe("queued");
        expect(f.state.nativeDesktopReceipt("duplicate-cancel")?.state).toBe("cancelled");
        expect(f.bridge.session(input.sessionId)?.pendingCommandIds).toEqual([first.commandId]);
        expect(f.native.calls).toEqual([
          { method: "promoteQueuedMessage", args: [input.sessionId, first.messageId] },
          { method: "promoteQueuedMessage", args: [input.sessionId, first.messageId] },
          { method: "cancelQueuedMessage", args: [input.sessionId, second.messageId] },
          { method: "cancelQueuedMessage", args: [input.sessionId, second.messageId] },
        ]);
      } finally {
        releases.forEach(release => release(false));
        await Promise.allSettled(pending);
        await f.close();
      }
    });
  });

  it("sends only once when twenty identical requests arrive concurrently", async () => {
    const f = await fixture();
    try {
      const receipts = await Promise.all(Array.from({ length: 20 }, () => f.bridge.startTurn(input)));
      expect(new Set(receipts.map(receipt => receipt.commandId)).size).toBe(1);
      expect(new Set(receipts.map(receipt => receipt.messageId)).size).toBe(1);
      expect(f.native.calls.filter(call => call.method === "sendMessage")).toHaveLength(1);
      expect(f.eventLog.replay(0).some(event => event.type === "turn.started")).toBe(false);
    } finally { await f.close(); }
  });

  it.each([
    ["session-received", "user", undefined],
    ["running", "command_lifecycle", "started"],
    ["completed", "result", false],
    ["failed", "result", true],
    ["cancelled", "command_lifecycle", "interrupted"],
  ] as const)("retains native %s evidence when the send RPC subsequently disconnects", async (state, type, status) => {
    const f = await fixture();
    let rejectSend!: (error: Error) => void;
    f.native.sendReply = new Promise<void>((_resolve, reject) => { rejectSend = reject; });
    const sending = f.bridge.startTurn(input);
    try {
      await vi.waitFor(() => expect(f.native.calls.some(call => call.method === "sendMessage")).toBe(true));
      const messageId = f.state.nativeDesktopReceipt(input.idempotencyKey)!.messageId;
      await f.message({ type, uuid: type === "user" ? messageId : "native-proof", command_uuid: messageId,
        user_message_uuid: messageId, state: status, is_error: status === true, message: { content: "hello" } });
      expect(f.state.nativeDesktopReceipt(input.idempotencyKey)?.state).toBe(state);
      rejectSend(new InspectorDisconnectedError("RPC response lost after native evidence"));
      expect((await sending).state).toBe(state);
      expect(f.state.nativeDesktopReceipt(input.idempotencyKey)?.state).toBe(state);
      expect(f.native.calls.filter(call => call.method === "sendMessage")).toHaveLength(1);
    } finally {
      rejectSend(new InspectorDisconnectedError("test cleanup"));
      await sending.catch(() => undefined);
      await f.close();
    }
  });

  it.each([false, true])("does not let late lifecycle frames replace a native result (error=%s)", async isError => {
    const f = await fixture();
    try {
      const receipt = await f.bridge.startTurn(input);
      await f.message({ type: "result", uuid: "result", user_message_uuid: receipt.messageId, is_error: isError });
      for (const state of ["queued", "started", "completed"]) {
        await f.message({ type: "command_lifecycle", command_uuid: receipt.messageId, state, uuid: `late-${state}` });
        expect(f.state.nativeDesktopReceipt(input.idempotencyKey)?.state).toBe(isError ? "failed" : "completed");
      }
      expect(f.eventLog.replay(0).filter(event => event.type === "turn.started")).toEqual([]);
    } finally { await f.close(); }
  });

  it("does not downgrade completed evidence when a stale confirmation action arrives", async () => {
    const f = await fixture();
    try {
      f.native.sendError = new InspectorDisconnectedError("response lost");
      const receipt = await f.bridge.startTurn(input);
      expect(receipt.state).toBe("uncertain");
      f.native.sendError = undefined;
      await f.message({ type: "result", uuid: "result", user_message_uuid: receipt.messageId, is_error: false });
      f.native.page.messages = [{ type: "user", uuid: receipt.messageId, message: { content: "hello" } }];
      expect((await f.bridge.resolveUncertainDelivery(receipt.commandId, "confirm")).state).toBe("completed");
      expect(f.state.nativeDesktopReceipt(input.idempotencyKey)?.state).toBe("completed");
      expect(f.state.nativeDesktopReceipt(input.idempotencyKey)?.error).toBeUndefined();
    } finally { await f.close(); }
  });

  it("retains a result that arrives while native delivery confirmation is awaiting history", async () => {
    const f = await fixture();
    let releaseHistory!: (messages: unknown[]) => void;
    let confirming: ReturnType<ClaudeDesktopBridge["resolveUncertainDelivery"]> | undefined;
    try {
      f.native.sendError = new InspectorDisconnectedError("response lost");
      const receipt = await f.bridge.startTurn(input);
      f.native.sendError = undefined;
      const original = f.native.call.bind(f.native);
      vi.spyOn(f.native, "call").mockImplementation((method, args) => method === "getTranscript" ? new Promise(resolve => { releaseHistory = resolve; }) : original(method, args));
      confirming = f.bridge.resolveUncertainDelivery(receipt.commandId, "confirm");
      await f.message({ type: "result", uuid: "completed-during-confirm", user_message_uuid: receipt.messageId, is_error: false });
      releaseHistory([]);
      expect((await confirming).state).toBe("completed");
      expect(f.state.nativeDesktopReceipt(input.idempotencyKey)?.state).toBe("completed");
    } finally {
      releaseHistory?.([]);
      await confirming?.catch(() => undefined);
      await f.close();
    }
  });

  it("keeps a running receipt when an older queued lifecycle frame arrives", async () => {
    const f = await fixture();
    try {
      const receipt = await f.bridge.startTurn(input);
      await f.message({ type: "command_lifecycle", command_uuid: receipt.messageId, state: "started" });
      await f.message({ type: "command_lifecycle", command_uuid: receipt.messageId, state: "queued" });
      expect(f.state.nativeDesktopReceipt(input.idempotencyKey)?.state).toBe("running");
      expect(f.eventLog.replay(0).some(event => event.type === "turn.queued")).toBe(false);
    } finally { await f.close(); }
  });

  it("restores a crash-time dispatch receipt as uncertain without replaying old or native input", async () => {
    const f = await fixture(true);
    let restarted: ClaudeDesktopBridge | undefined;
    try {
      await f.bridge.close();
      f.state.saveNativeDesktopReceipt({ idempotencyKey: "crash", commandId: "crash-command", requestId: "crash-request", sessionId: "local-native", messageId: "crash-message", state: "dispatching" });
      restarted = new ClaudeDesktopBridge(f.options);
      await restarted.initialize();
      expect(f.state.nativeDesktopReceipt("crash")?.state).toBe("uncertain");
      expect((await restarted.startTurn({ ...input, idempotencyKey: "crash" })).commandId).toBe("crash-command");
      expect(f.native.calls.filter(call => call.method === "sendMessage")).toEqual([]);
      const queued = withDatabase(f.databasePath, (db) => db.prepare("SELECT command_id FROM turn_queue").all() as Array<{ command_id: string }>);
      expect(queued[0]?.command_id).toBe("old-command");
    } finally { await restarted?.close(); await f.close(); }
  });

  it("does not attribute a result from another native session to the same message UUID", async () => {
    const f = await fixture();
    try {
      f.native.sessions.push({ ...f.native.sessions[0], sessionId: "other-native" });
      await f.bridge.refreshRuntime();
      const receipt = await f.bridge.startTurn(input);
      const changed = once(f.bridge, "changed");
      f.native.emit("event", { sessionId: "other-native", message: { type: "result", uuid: "foreign-result", user_message_uuid: receipt.messageId, is_error: false } });
      await changed;
      expect(f.state.nativeDesktopReceipt(input.idempotencyKey)?.state).toBe("submitted");
    } finally { await f.close(); }
  });
});
