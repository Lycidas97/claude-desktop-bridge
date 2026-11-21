import { describe, expect, it, vi } from "vitest";
import { ClaudeDesktopBridge } from "./claude-desktop-bridge.js";
import { fixture, NativeDesktop, withDatabase, turnInput as input } from "./claude-desktop-bridge-fixture.js";

describe("native runtime sync and event publication", () => {
  it("observes the main Native system/init tool directory with the Desktop session ID", async () => {
    const f = await fixture();
    try {
      const observed = vi.fn();
      f.bridge.on("system.init", observed);
      await f.message({ type: "system", subtype: "init", session_id: "cli-id", parent_tool_use_id: "agent", tools: ["Bash"] });
      await f.message({ type: "system", subtype: "init", session_id: "cli-id", tools: ["Read", null, "mcp__other__read"] });
      expect(observed).toHaveBeenCalledExactlyOnceWith("local-native", ["Read", "mcp__other__read"]);
    } finally { await f.close(); }
  });

  it.each(["assistant", "system"])("coalesces same-turn %s event projections without dropping messages", async (type) => {
    const f = await fixture();
    try {
      for (let index = 1; index < 348; index++) f.native.sessions.push({ ...f.native.sessions[0], sessionId: `other-${index}` });
      await f.bridge.refreshRuntime();
      const project = vi.spyOn(f.bridge as unknown as { projectSessions(): void }, "projectSessions");
      for (let index = 0; index < 32; index++) {
        f.native.emit("event", {
          type: "message", sessionId: "local-native",
          session: { ...f.native.sessions[0], title: `burst-${index}` },
          message: type === "assistant"
            ? { type, uuid: `message-${index}`, message: { content: [{ type: "text", text: `Message ${index}` }] } }
            : { type, uuid: `message-${index}`, subtype: "compact_boundary" },
        });
      }
      await vi.waitFor(() => {
        expect(f.bridge.session("local-native")?.title).toBe("burst-31");
        expect(f.eventLog.replay(0, 100).filter(event => event.type === (type === "assistant" ? "assistant.completed" : "session.compacted"))).toHaveLength(32);
      });
      expect(f.bridge.listSessions()).toHaveLength(348);
      expect(project).toHaveBeenCalledTimes(1);
    } finally { await f.close(); }
  });

  it.each([[4, 32], [16, 32], [16, 128]])("projects %i sessions with at most one pass over %i receipts", async (sessionCount, receiptCount) => {
    const f = await fixture();
    const native = new NativeDesktop();
    const bridge = new ClaudeDesktopBridge({ ...f.options, inspector: native });
    try {
      native.sessions = Array.from({ length: sessionCount }, (_, index) => ({ ...native.sessions[0], sessionId: `local-${index}` }));
      for (let index = 0; index < receiptCount; index++) {
        f.state.saveNativeDesktopReceipt({
          idempotencyKey: `key-${index}`, commandId: `command-${index}`, requestId: `request-${index}`, messageId: `message-${index}`,
          sessionId: index === 3 ? "local-hidden" : `local-${index % 2}`,
          state: index < 4 ? "queued" : index === 4 ? "dispatching" : "completed",
        });
      }
      let reads = 0;
      const receipts = f.state.listNativeDesktopReceipts().map(receipt => new Proxy(receipt, {
        get(target, key, receiver) {
          if (key === "sessionId" || key === "state") reads++;
          return Reflect.get(target, key, receiver);
        },
      }));
      vi.spyOn(f.state, "listNativeDesktopReceipts").mockReturnValue(receipts);
      await bridge.initialize();
      expect(f.state.nativeDesktopReceipt("key-4")?.state).toBe("uncertain");
      reads = 0;
      expect(await bridge.refreshRuntime()).toBe(true);
      expect(bridge.listSessions()).toHaveLength(sessionCount);
      expect(bridge.session("local-0")).toMatchObject({ pendingCount: 2, pendingCommandIds: ["command-0", "command-2"] });
      expect(bridge.session("local-1")).toMatchObject({ pendingCount: 1, pendingCommandIds: ["command-1"] });
      expect(bridge.session("local-2")).toMatchObject({ pendingCount: 0, pendingCommandIds: [] });
      // Each receipt needs at most its state and session ID, independent of session count.
      expect(reads).toBeLessThanOrEqual(2 * receiptCount);
    } finally { await bridge.close(); await f.close(); }
  });

  it("announces only user replies and explicit deliveries from background turns", async () => {
    const f = await fixture();
    const received = vi.fn();
    f.bridge.on("assistant.user-reply", received);
    try {
      for (const [index, text] of ["筛选完毕", "【给用户】请查看预算"].entries()) {
        const receipt = await f.bridge.startTurn({ ...input, requestId: `background-${index}`, idempotencyKey: `background-${index}`, origin: "system", source: "assistant-trigger" });
        await f.message({ type: "user", uuid: receipt.messageId, message: { content: input.text } });
        await f.message({ type: "assistant", uuid: `background-reply-${index}`, message: { content: [{ type: "text", text }] } });
        await f.message({ type: "result", uuid: `background-result-${index}`, user_message_uuid: receipt.messageId, is_error: false });
      }
      await f.message({ type: "user", uuid: "user-root", message: { content: "请给我结果" } });
      await f.message({ type: "assistant", uuid: "native-reply", message: { id: "visible-reply", content: [{ type: "text", text: "用户请求的结果" }] } });
      await f.message({ type: "result", uuid: "result", is_error: false });
      expect(received.mock.calls).toEqual([
        [input.sessionId, "background-reply-1", "请查看预算"],
        [input.sessionId, "visible-reply", "用户请求的结果"],
      ]);
    } finally { await f.close(); }
  });

  it("does not mark failed, synthetic, or child results as completed", async () => {
    const f = await fixture();
    try {
      for (const outcome of [{ is_error: true }, { is_error: false, isSyntheticResult: true }, { is_error: false, parent_tool_use_id: "child" }]) {
        await f.message({ type: "result", uuid: "excluded-result", ...outcome });
        expect(f.bridge.session("local-native")?.lastCompletedTurnId).toBeUndefined();
      }
    } finally { await f.close(); }
  });

  it("reads only native Desktop records and leaves old queues untouched", async () => {
    const f = await fixture(true);
    try {
      expect(f.bridge.session("local-native")?.transport).toBe("claude-desktop-native");
      expect(f.bridge.session("legacy-unlinked")).toBeUndefined();
      const queued = withDatabase(f.databasePath, (db) => db.prepare("SELECT command_id FROM turn_queue").all() as Array<{ command_id: string }>);
      expect(queued[0]?.command_id).toBe("old-command");
      expect(f.native.calls.some(call => call.method === "sendMessage")).toBe(false);
      expect(f.bridge.session("local-native")?.turnState).toBe("idle"); // A warm CLI is not an active turn.
    } finally { await f.close(); }
  });

  it("keeps directory refresh independent of transcript catalog scans", async () => {
    const f = await fixture();
    try {
      f.options.scanCatalog.mockClear();
      await f.bridge.refreshRuntime();
      expect(f.bridge.listSessions()).toHaveLength(1);
      expect(f.options.scanCatalog).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it("refreshes one session without refreshing the entire directory", async () => {
    const f = await fixture();
    try {
      f.options.scanCatalog.mockClear();
      f.native.calls = [];
      await f.bridge.refreshDesktopSession("local-native");
      expect(f.native.calls).toContainEqual({ method: "getSession", args: ["local-native"] });
      expect(f.native.calls.some(call => call.method === "getAll")).toBe(false);
      expect(f.options.scanCatalog).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it("projects native compaction status until the native status clears", async () => {
    const f = await fixture();
    try {
      f.native.sessions[0]!.turnRunning = true;
      await f.bridge.refreshRuntime();
      await f.message({ type: "system", subtype: "status", status: "compacting" });
      expect(f.bridge.session("local-native")).toMatchObject({ turnState: "running", isCompacting: true });
      await f.bridge.refreshRuntime();
      expect(f.bridge.session("local-native")).toMatchObject({ isCompacting: true });
      await f.message({ type: "system", subtype: "status", status: null, compact_result: "success" });
      expect(f.bridge.session("local-native")).not.toHaveProperty("isCompacting");
    } finally { await f.close(); }
  });

  it("preserves main compaction after a local synthetic result", async () => {
    const f = await fixture();
    try {
      f.native.sessions[0]!.turnRunning = true;
      await f.bridge.refreshRuntime();
      await f.message({ type: "system", subtype: "status", status: "compacting" });
      await f.message({ type: "result", subtype: "success", uuid: "color-command-result", parent_tool_use_id: null, isSyntheticResult: true, result: "Session color set to red" });
      await f.bridge.refreshRuntime();
      expect(f.bridge.session("local-native")).toMatchObject({ turnState: "running", isCompacting: true });
    } finally { await f.close(); }
  });

  it("preserves newer compaction status while an older idle snapshot is in flight", async () => {
    const f = await fixture();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    try {
      let markSnapshotCaptured!: () => void;
      const snapshotCaptured = new Promise<void>(resolve => { markSnapshotCaptured = resolve; });
      Object.assign(f.native, { async sections() { markSnapshotCaptured(); await gate; } });
      const staleRefresh = f.bridge.refreshRuntime();
      await snapshotCaptured;
      f.native.sessions[0]!.turnRunning = true;
      f.native.emit("event", { type: "session_updated", sessionId: "local-native", session: structuredClone(f.native.sessions[0]) });
      const compacting = f.message({ type: "system", subtype: "status", status: "compacting" });
      release();
      await staleRefresh;
      await compacting;
      await vi.waitFor(() => expect(f.bridge.session("local-native")?.turnState).toBe("running"));
      expect(f.bridge.session("local-native")).toMatchObject({ isCompacting: true });
    } finally { release(); await f.close(); }
  });

  it("discards unconfirmed compaction after an inspector reconnect", async () => {
    const f = await fixture();
    try {
      f.native.sessions[0]!.turnRunning = true;
      await f.bridge.refreshRuntime();
      await f.message({ type: "system", subtype: "status", status: "compacting" });
      f.native.ready = false;
      f.native.emit("disconnected");
      // Native finishes compaction while disconnected, then continues generating.
      await f.bridge.refreshRuntime();
      expect(f.bridge.session("local-native")?.turnState).toBe("running");
      expect(f.bridge.session("local-native")).not.toHaveProperty("isCompacting");
      await f.message({ type: "system", subtype: "status", status: "compacting" });
      expect(f.bridge.session("local-native")).toMatchObject({ isCompacting: true });
    } finally { await f.close(); }
  });

  it.each([
    { parent_tool_use_id: "child-tool" },
    { isSidechain: true },
  ])("ignores subagent compaction status (%j)", async attribution => {
    const f = await fixture();
    try {
      f.native.sessions[0]!.turnRunning = true;
      await f.bridge.refreshRuntime();
      await f.message({ type: "system", subtype: "status", status: "compacting", ...attribution });
      expect(f.bridge.session("local-native")).not.toHaveProperty("isCompacting");
      await f.message({ type: "system", subtype: "status", status: "compacting" });
      await f.message({ type: "system", subtype: "status", status: null, ...attribution });
      expect(f.bridge.session("local-native")).toMatchObject({ isCompacting: true });
      await f.message({ type: "result", uuid: "child-result", ...attribution });
      expect(f.bridge.session("local-native")).toMatchObject({ isCompacting: true });
    } finally { await f.close(); }
  });

  it.each([
    { type: "system", subtype: "compact_boundary", uuid: "compact-done" },
    { type: "result", uuid: "compact-result", is_error: true },
  ])("clears compaction on native completion (%j)", async message => {
    const f = await fixture();
    try {
      f.native.sessions[0]!.turnRunning = true;
      await f.bridge.refreshRuntime();
      await f.message({ type: "system", subtype: "status", status: "compacting" });
      expect(f.bridge.session("local-native")).toMatchObject({ isCompacting: true });
      await f.message(message);
      expect(f.bridge.session("local-native")).not.toHaveProperty("isCompacting");
    } finally { await f.close(); }
  });

  it("clears compaction when Native reports the main turn idle", async () => {
    const f = await fixture();
    try {
      f.native.sessions[0]!.turnRunning = true;
      await f.bridge.refreshRuntime();
      await f.message({ type: "system", subtype: "status", status: "compacting" });
      expect(f.bridge.session("local-native")).toMatchObject({ isCompacting: true });
      f.native.sessions[0]!.turnRunning = false;
      await f.bridge.refreshRuntime();
      f.native.sessions[0]!.turnRunning = true;
      await f.bridge.refreshRuntime();
      expect(f.bridge.session("local-native")).not.toHaveProperty("isCompacting");
    } finally { await f.close(); }
  });
});
