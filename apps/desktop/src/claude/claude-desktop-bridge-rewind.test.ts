import { describe, expect, it, vi } from "vitest";
import { InspectorDisconnectedError, NativeCallError } from "./claude-desktop-inspector.js";
import { fixture, turnInput as input } from "./claude-desktop-bridge-fixture.js";

describe("native session rewind", () => {
  const rewindUser = { type: "user", uuid: "raw-user-uuid", message: { id: "body-id-is-not-the-target", content: "Original draft" } };

  it("previews native rewind without executing either restore and preserves raw UUID arguments", async () => {
    const f = await fixture();
    try {
      f.native.page.messages = [rewindUser];
      expect(await f.bridge.previewRewind("local-native", rewindUser.uuid)).toEqual({ sessionId: "local-native", messageId: rewindUser.uuid, canRewindConversation: true, canRewindFiles: true, filesChanged: ["src/native.ts"], insertions: 4, deletions: 2 });
      expect(f.native.calls.filter(call => ["canRewindTo", "rewindFiles", "rewindV2"].includes(call.method))).toEqual([
        { method: "canRewindTo", args: ["local-native", rewindUser.uuid] },
        { method: "rewindFiles", args: ["local-native", rewindUser.uuid, true] },
      ]);
      expect(f.eventLog.replay(0)).toEqual([]);
    } finally { await f.close(); }
  });

  it.each([null, { canRewind: false, error: "No checkpoint" }, { canRewind: true, inFlight: true, filesChanged: ["pending.ts"] }])("reports unavailable file rewind preview %j", async filesPreview => {
    const f = await fixture();
    try {
      f.native.page.messages = [rewindUser];
      f.native.canRewind = false;
      f.native.filesPreview = filesPreview;
      const preview = await f.bridge.previewRewind("local-native", rewindUser.uuid);
      expect(preview).toMatchObject({ canRewindConversation: false, canRewindFiles: false, filesChanged: filesPreview?.filesChanged ?? [] });
      if (filesPreview?.error) expect(preview.fileError).toBe(filesPreview.error);
      if (filesPreview?.inFlight) expect(preview.filesInFlight).toBe(true);
    } finally { await f.close(); }
  });

  it.each(["first-user", "image-only"])("allows files-only rewind when native conversation rewind rejects %s", async kind => {
    const f = await fixture();
    try {
      f.native.page.messages = [{ ...rewindUser, ...(kind === "image-only" ? { message: { content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "aGk=" } }] } } : {}) }];
      f.native.canRewind = false;
      expect(await f.bridge.previewRewind("local-native", rewindUser.uuid)).toMatchObject({ canRewindConversation: false, canRewindFiles: true });
      f.native.calls = [];
      expect(await f.bridge.rewindSession("local-native", rewindUser.uuid, "files")).toEqual({ sessionId: "local-native", messageId: rewindUser.uuid, scope: "files" });
      expect(f.native.calls.filter(call => call.method === "rewindFiles").map(call => call.args)).toEqual([["local-native", rewindUser.uuid, true], ["local-native", rewindUser.uuid, false, true]]);
      expect(f.native.calls.some(call => ["canRewindTo", "rewindV2"].includes(call.method))).toBe(false);
      expect(f.native.page.messages).toHaveLength(1);
      expect(f.eventLog.replay(0).some(event => event.type === "session.rewound")).toBe(false);
    } finally { await f.close(); }
  });

  it.each([
    { type: "assistant", uuid: "raw-user-uuid", message: { content: "Assistant" } },
    { ...rewindUser, uuid: "other-uuid" },
    { ...rewindUser, isSidechain: true },
    { ...rewindUser, parent_tool_use_id: "child-tool" },
    { ...rewindUser, isSynthetic: true },
    { ...rewindUser, message: { content: [{ type: "tool_result", tool_use_id: "tool", content: "Result" }] } },
  ])("rejects a non-user or foreign target %j before native rewind", async target => {
    const f = await fixture();
    try {
      f.native.page.messages = [target];
      await expect(f.bridge.previewRewind("local-native", rewindUser.uuid)).rejects.toThrow(/user message/iu);
      await expect(f.bridge.rewindSession("local-native", rewindUser.uuid, "both")).rejects.toThrow(/user message/iu);
      await expect(f.bridge.previewRewind("missing-session", rewindUser.uuid)).rejects.toThrow(/session not found/iu);
      expect(f.native.calls.some(call => ["canRewindTo", "rewindFiles", "rewindV2"].includes(call.method))).toBe(false);
    } finally { await f.close(); }
  });

  it.each([{ turnRunning: true }, { hasBackgroundWork: true }, { queued: true }, { pendingToolPermissions: [{ requestId: "ask" }] }])("delegates rewind eligibility to Native while the session has activity %j", async activity => {
    const f = await fixture();
    try {
      f.native.page.messages = [{ type: "assistant", uuid: "native-anchor", message: { content: "Previous turn" } }, rewindUser];
      Object.assign(f.native.sessions[0]!, activity);
      if ("queued" in activity) {
        f.native.sendResult = { delivered: true, queued: true };
        await f.bridge.startTurn(input);
      }
      expect(await f.bridge.previewRewind("local-native", rewindUser.uuid)).toMatchObject({ canRewindConversation: true });
      expect(await f.bridge.rewindSession("local-native", rewindUser.uuid, "conversation")).toMatchObject({ messageId: rewindUser.uuid, prefill: "Original draft" });
      expect(f.native.calls.find(call => call.method === "rewindV2")?.args).toEqual(["local-native", rewindUser.uuid]);
      expect(f.native.calls.some(call => ["interrupt", "stopTask"].includes(call.method))).toBe(false);
    } finally { await f.close(); }
  });

  it("retains conversation rewind when the Native file preview is unavailable", async () => {
    const f = await fixture();
    try {
      f.native.page.messages = [rewindUser];
      f.native.filesPreviewError = new NativeCallError("File rewind unavailable");
      expect(await f.bridge.previewRewind("local-native", rewindUser.uuid)).toMatchObject({ canRewindConversation: true, canRewindFiles: false, fileError: "File rewind unavailable" });
      expect(await f.bridge.rewindSession("local-native", rewindUser.uuid, "conversation")).toMatchObject({ prefill: "Original draft" });
    } finally { await f.close(); }
  });

  it("does not hide an unexpected programming error behind a file preview status", async () => {
    const f = await fixture();
    try {
      f.native.page.messages = [rewindUser];
      f.native.filesPreviewError = new TypeError("Unexpected implementation bug");
      await expect(f.bridge.previewRewind("local-native", rewindUser.uuid)).rejects.toThrow("Unexpected implementation bug");
    } finally { await f.close(); }
  });

  it("keeps conversation projection and history intact after a files-only rewind", async () => {
    const f = await fixture();
    try {
      f.native.page.messages = [rewindUser];
      await f.message({ type: "assistant", uuid: "plan", message: { content: [{ type: "tool_use", id: "retained-plan", name: "mcp__ccd_turn__update_plan", input: { scope: "first_task", items: [{ content: "Retained work", status: "in_progress" }] } }] } });
      await f.message({ type: "result", uuid: "retained-result", is_error: false });
      expect(await f.bridge.rewindSession("local-native", rewindUser.uuid, "files")).not.toHaveProperty("prefill");
      expect(f.bridge.session("local-native")?.lastCompletedTurnId).toBe("retained-result");
      await f.message({ type: "assistant", uuid: "advance", message: { content: [{ type: "tool_use", id: "advance", name: "mcp__ccd_turn__update_plan", input: { advance: true } }] } });
      expect(f.eventLog.latestItem("local-native", "assistant.completed", "plan:retained-plan")?.data.taskPlan).toMatchObject({ id: "retained-plan", items: [{ content: "Retained work", status: "completed" }] });
      expect(f.native.page.messages).toEqual([rewindUser]);
      expect(f.eventLog.replay(0).some(event => event.type === "session.rewound")).toBe(false);
    } finally { await f.close(); }
  });

  it("rechecks selected scopes, restores files before conversation, and persists a rewind boundary", async () => {
    const f = await fixture();
    try {
      f.native.page.messages = [rewindUser];
      await f.bridge.previewRewind("local-native", rewindUser.uuid);
      await f.message({ type: "result", uuid: "discarded-result", is_error: false });
      await f.bridge.refreshRuntime();
      expect(f.bridge.session("local-native")?.lastCompletedTurnId).toBe("discarded-result");
      f.native.calls = [];
      expect(await f.bridge.rewindSession("local-native", rewindUser.uuid, "both")).toEqual({ sessionId: "local-native", messageId: rewindUser.uuid, scope: "both", prefill: "Original draft" });
      expect(f.bridge.session("local-native")?.lastCompletedTurnId).toBeUndefined();
      expect(f.native.calls.filter(call => ["canRewindTo", "rewindFiles", "rewindV2"].includes(call.method))).toEqual([
        { method: "canRewindTo", args: ["local-native", rewindUser.uuid] },
        { method: "rewindFiles", args: ["local-native", rewindUser.uuid, true] },
        { method: "rewindFiles", args: ["local-native", rewindUser.uuid, false, true] },
        { method: "rewindV2", args: ["local-native", rewindUser.uuid] },
      ]);
      expect(f.eventLog.replay(0)).toMatchObject([
        { type: "turn.completed", itemId: "discarded-result", sessionId: "local-native" },
        { type: "session.rewound", sessionId: "local-native", data: { messageId: rewindUser.uuid, scope: "both" } },
      ]);
      const after = f.native.calls.slice(f.native.calls.findIndex(call => call.method === "rewindV2") + 1).map(call => call.method);
      expect(after).toContain("getSession");
      expect(after).toContain("getTranscriptPage");
    } finally { await f.close(); }
  });

  it("does not execute a stale conversation preview when native eligibility changes", async () => {
    const f = await fixture();
    try {
      f.native.page.messages = [rewindUser];
      await f.bridge.previewRewind("local-native", rewindUser.uuid);
      f.native.canRewind = false;
      await expect(f.bridge.rewindSession("local-native", rewindUser.uuid, "both")).rejects.toThrow(/conversation/iu);
      expect(f.native.calls.some(call => call.method === "rewindV2" || (call.method === "rewindFiles" && call.args[2] === false))).toBe(false);
    } finally { await f.close(); }
  });

  it.each([null, { canRewind: false }, { canRewind: true, error: "Restore failed" }, { canRewind: true, inFlight: true }])("blocks conversation when native file restore fails with %j", async filesRestore => {
    const f = await fixture();
    try {
      f.native.page.messages = [rewindUser];
      f.native.filesRestore = filesRestore;
      await expect(f.bridge.rewindSession("local-native", rewindUser.uuid, "both")).rejects.toThrow(/files|Restore failed/iu);
      expect(f.native.calls.some(call => call.method === "rewindV2")).toBe(false);
      expect(f.eventLog.replay(0)).toEqual([]);
    } finally { await f.close(); }
  });

  it.each([null, { canRewind: false }, { canRewind: true, error: "Checkpoint failed" }, { canRewind: true, inFlight: true }])("rechecks file eligibility before executing %j", async filesPreview => {
    const f = await fixture();
    try {
      f.native.page.messages = [rewindUser];
      f.native.filesPreview = filesPreview;
      await expect(f.bridge.rewindSession("local-native", rewindUser.uuid, "files")).rejects.toThrow();
      expect(f.native.calls.some(call => call.method === "rewindFiles" && call.args[2] === false)).toBe(false);
    } finally { await f.close(); }
  });

  it.each(["conversation", "both"] as const)("does not claim conversation success on native null (%s)", async scope => {
    const f = await fixture();
    try {
      f.native.page.messages = [rewindUser];
      f.native.conversationRewind = null;
      await expect(f.bridge.rewindSession("local-native", rewindUser.uuid, scope)).rejects.toThrow(scope === "both" ? /files.*restored.*conversation/iu : /conversation/iu);
      expect(f.eventLog.replay(0).some(event => event.type === "session.rewound")).toBe(false);
      expect(f.native.page.messages).toEqual([rewindUser]);
    } finally { await f.close(); }
  });

  it("reports partial completion if conversation throws after restoring files", async () => {
    const f = await fixture();
    try {
      f.native.page.messages = [rewindUser];
      f.native.conversationRewindError = new Error("Native conversation failed");
      await expect(f.bridge.rewindSession("local-native", rewindUser.uuid, "both")).rejects.toThrow(/files.*restored.*Native conversation failed/iu);
      expect(f.eventLog.replay(0)).toEqual([]);
    } finally { await f.close(); }
  });

  it("resets eliminated live plans and tasks after conversation rewind without reappending history", async () => {
    const f = await fixture();
    try {
      const plan = { type: "assistant", uuid: "plan-row", message: { content: [{ type: "tool_use", id: "old-plan", name: "mcp__ccd_turn__update_plan", input: { scope: "first_task", items: [{ content: "Eliminated work", status: "in_progress" }] } }] } };
      await f.message(plan);
      await f.message({ type: "system", subtype: "task_started", task_id: "removed-task", tool_use_id: "removed-tool", description: "Removed task" });
      await f.message({ type: "system", subtype: "task_notification", task_id: "removed-task", status: "completed" });
      f.native.page.messages = [rewindUser, plan];
      expect(await f.bridge.rewindSession("local-native", rewindUser.uuid, "conversation")).toMatchObject({ prefill: "Original draft" });
      expect((await f.bridge.history("local-native")).items).toEqual([]);
      expect(f.bridge.session("local-native")?.runningSubagents).toBeUndefined();
      const boundary = f.eventLog.replay(0).find(event => event.type === "session.rewound")!;
      await f.message({ type: "assistant", uuid: "orphan", message: { content: [{ type: "tool_use", id: "advance", name: "mcp__ccd_turn__update_plan", input: { advance: true } }] } });
      expect(f.eventLog.replay(boundary.seq).filter(event => event.data.taskPlan || event.type === "user.message.accepted")).toEqual([]);
    } finally { await f.close(); }
  });

  it.each(["canRewindTo", "rewindFiles", "rewindV2"])("advertises rewind and adds its UI command only when all native methods exist (missing %s)", async missing => {
    const f = await fixture();
    try {
      expect(f.bridge.capabilities()).toContain("session.rewind");
      expect((await f.bridge.commands("local-native")).commands.filter(command => command.name === "rewind")).toEqual([{ name: "rewind", description: expect.any(String), action: "rewind" }]);
      expect(await f.bridge.runCommand({ ...input, text: "/rewind" })).toEqual({ action: "rewind" });
      expect(f.native.calls.some(call => call.method === "sendMessage")).toBe(false);
      f.native.unsupported.add(missing);
      expect(f.bridge.capabilities()).not.toContain("session.rewind");
      expect((await f.bridge.commands("local-native")).commands.some(command => command.name === "rewind")).toBe(false);
      await expect(f.bridge.runCommand({ ...input, text: "/rewind" })).rejects.toThrow(/unsupported/iu);
    } finally { await f.close(); }
  });

  describe("v116 native rewind boundaries", () => {
    it.each(["disconnected", "missing-method", "removed-target"] as const)("rejects an approved preview after %s before either restore", async change => {
      const f = await fixture();
      try {
        f.native.page.messages = [rewindUser];
        expect(await f.bridge.previewRewind(input.sessionId, rewindUser.uuid)).toMatchObject({ canRewindConversation: true, canRewindFiles: true });
        f.native.calls = [];
        if (change === "disconnected") f.native.ready = false;
        if (change === "missing-method") f.native.unsupported.add("rewindV2");
        if (change === "removed-target") f.native.page.messages = [];
        await expect(f.bridge.rewindSession(input.sessionId, rewindUser.uuid, "both")).rejects.toThrow(
          change === "disconnected" ? /disconnected/iu : change === "missing-method" ? /unsupported/iu : /user message/iu,
        );
        expect(f.native.calls.filter(call => ["canRewindTo", "rewindFiles", "rewindV2", "interrupt", "sendMessage"].includes(call.method))).toEqual([]);
        expect(f.eventLog.replay(0)).toEqual([]);
      } finally { await f.close(); }
    });

    it("rejects files that become in flight after an approved combined preview", async () => {
      const f = await fixture();
      try {
        f.native.page.messages = [rewindUser];
        await f.bridge.previewRewind(input.sessionId, rewindUser.uuid);
        f.native.filesPreview = { canRewind: true, inFlight: true };
        f.native.calls = [];
        await expect(f.bridge.rewindSession(input.sessionId, rewindUser.uuid, "both")).rejects.toThrow("file changes are in flight");
        expect(f.native.calls.filter(call => ["canRewindTo", "rewindFiles", "rewindV2"].includes(call.method))).toEqual([
          { method: "canRewindTo", args: [input.sessionId, rewindUser.uuid] },
          { method: "rewindFiles", args: [input.sessionId, rewindUser.uuid, true] },
        ]);
        expect(f.native.page.messages).toEqual([rewindUser]);
        expect(f.eventLog.replay(0)).toEqual([]);
      } finally { await f.close(); }
    });

    it("reports files already restored when Native rejects conversation eligibility during restoration", async () => {
      const f = await fixture();
      try {
        f.native.page.messages = [rewindUser];
        await f.bridge.previewRewind(input.sessionId, rewindUser.uuid);
        const original = f.native.call.bind(f.native);
        vi.spyOn(f.native, "call").mockImplementation(async (method, args = []) => {
          if (method === "rewindV2" && !f.native.canRewind) {
            f.native.calls.push({ method, args });
            throw new NativeCallError("Native checkpoint expired during file restore");
          }
          const result = await original(method, args);
          if (method === "rewindFiles" && args[2] === false) f.native.canRewind = false;
          return result;
        });
        f.native.calls = [];
        await expect(f.bridge.rewindSession(input.sessionId, rewindUser.uuid, "both")).rejects.toThrow("Files were restored, but conversation rewind failed: Native checkpoint expired during file restore");
        expect(f.native.calls.filter(call => ["canRewindTo", "rewindFiles", "rewindV2"].includes(call.method))).toEqual([
          { method: "canRewindTo", args: [input.sessionId, rewindUser.uuid] },
          { method: "rewindFiles", args: [input.sessionId, rewindUser.uuid, true] },
          { method: "rewindFiles", args: [input.sessionId, rewindUser.uuid, false, true] },
          { method: "rewindV2", args: [input.sessionId, rewindUser.uuid] },
        ]);
        expect(f.native.page.messages).toEqual([rewindUser]);
        expect(f.eventLog.replay(0)).toEqual([]);
      } finally { await f.close(); }
    });

    it("accepts an empty Native prefill as a successful conversation rewind", async () => {
      const f = await fixture();
      try {
        f.native.page.messages = [rewindUser];
        f.native.conversationRewind = { prefill: "" };
        expect(await f.bridge.rewindSession(input.sessionId, rewindUser.uuid, "conversation")).toEqual({ sessionId: input.sessionId, messageId: rewindUser.uuid, scope: "conversation", prefill: "" });
        expect(f.native.page.messages).toEqual([]);
        expect(f.eventLog.replay(0)).toMatchObject([{ type: "session.rewound", data: { messageId: rewindUser.uuid, scope: "conversation" } }]);
      } finally { await f.close(); }
    });

    it("preserves the live plan and queued receipt when rewindV2 rejects", async () => {
      const f = await fixture();
      try {
        f.native.page.messages = [rewindUser];
        f.native.sendResult = { delivered: true, queued: true };
        const receipt = await f.bridge.startTurn(input);
        await f.message({ type: "assistant", uuid: "preserved-plan", message: { content: [{ type: "tool_use", id: "preserved-plan", name: "mcp__ccd_turn__update_plan", input: { scope: "first_task", items: [{ content: "Keep work", status: "in_progress" }] } }] } });
        const before = f.eventLog.replay(0);
        f.native.conversationRewindError = new NativeCallError("Native rejected rewindV2");
        await expect(f.bridge.rewindSession(input.sessionId, rewindUser.uuid, "conversation")).rejects.toBe(f.native.conversationRewindError);
        expect(f.eventLog.replay(0)).toEqual(before);
        expect(f.state.nativeDesktopReceipt(input.idempotencyKey)).toMatchObject({ commandId: receipt.commandId, messageId: receipt.messageId, state: "queued" });
        expect(f.bridge.session(input.sessionId)?.pendingCommandIds).toEqual([receipt.commandId]);
        await f.message({ type: "assistant", uuid: "advance-preserved-plan", message: { content: [{ type: "tool_use", id: "advance-preserved-plan", name: "mcp__ccd_turn__update_plan", input: { advance: true } }] } });
        expect(f.eventLog.latestItem(input.sessionId, "assistant.completed", "plan:preserved-plan")?.data.taskPlan).toMatchObject({ id: "preserved-plan", items: [{ content: "Keep work", status: "completed" }] });
      } finally { await f.close(); }
    });

    it("validates the rewind UUID against the selected session transcript", async () => {
      const f = await fixture();
      try {
        f.native.sessions.push({ ...f.native.sessions[0], sessionId: "other-native" });
        await f.bridge.refreshRuntime();
        const original = f.native.call.bind(f.native);
        vi.spyOn(f.native, "call").mockImplementation((method, args = []) => {
          if (method !== "getTranscript") return original(method, args);
          f.native.calls.push({ method, args });
          return Promise.resolve(args[0] === "other-native" ? [rewindUser] : []);
        });
        await expect(f.bridge.previewRewind(input.sessionId, rewindUser.uuid)).rejects.toThrow("Rewind target must be a user message in this native session");
        expect(await f.bridge.previewRewind("other-native", rewindUser.uuid)).toMatchObject({ sessionId: "other-native", canRewindConversation: true, canRewindFiles: true });
        expect(f.native.calls.filter(call => ["canRewindTo", "rewindFiles", "rewindV2"].includes(call.method))).toEqual([
          { method: "canRewindTo", args: ["other-native", rewindUser.uuid] },
          { method: "rewindFiles", args: ["other-native", rewindUser.uuid, true] },
        ]);
      } finally { await f.close(); }
    });

    it("returns the successful combined rewind result if metadata readback disconnects", async () => {
      const f = await fixture();
      try {
        f.native.page.messages = [rewindUser];
        const original = f.native.call.bind(f.native);
        vi.spyOn(f.native, "call").mockImplementation((method, args = []) => {
          if (method === "getSession" && f.native.calls.some(call => call.method === "rewindV2")) {
            f.native.calls.push({ method, args });
            return Promise.reject(new InspectorDisconnectedError("Native readback disconnected after rewind"));
          }
          return original(method, args);
        });
        await expect(f.bridge.rewindSession(input.sessionId, rewindUser.uuid, "both")).resolves.toEqual({ sessionId: input.sessionId, messageId: rewindUser.uuid, scope: "both", prefill: "Original draft" });
        expect(f.native.page.messages).toEqual([]);
        expect(f.eventLog.replay(0)).toMatchObject([{ type: "session.rewound", sessionId: input.sessionId, data: { messageId: rewindUser.uuid, scope: "both" } }]);
        expect(f.native.calls.filter(call => call.method === "rewindV2")).toHaveLength(1);
        expect(f.native.calls.some(call => ["sendMessage", "interrupt"].includes(call.method))).toBe(false);
      } finally { await f.close(); }
    });

    it.each(["getSession", "getTranscriptPage"])("returns Native success and prefill when %s disconnects after rewind", async method => {
      const f = await fixture();
      try {
        f.native.page.messages = [rewindUser];
        const original = f.native.call.bind(f.native);
        vi.spyOn(f.native, "call").mockImplementation((called, args = []) => {
          if (called === method && f.native.calls.some(call => call.method === "rewindV2")) {
            f.native.calls.push({ method: called, args });
            return Promise.reject(new InspectorDisconnectedError("Readback disconnected after successful rewind"));
          }
          return original(called, args);
        });
        const outcome = await f.bridge.rewindSession(input.sessionId, rewindUser.uuid, "conversation")
          .then(result => ({ result }), error => ({ error }));
        expect(f.native.page.messages).toEqual([]);
        expect(f.native.calls.filter(call => call.method === "rewindV2")).toHaveLength(1);
        expect(f.eventLog.replay(0)).toMatchObject([{ type: "session.rewound" }]);
        expect(outcome).toMatchObject({ result: { sessionId: input.sessionId, messageId: rewindUser.uuid, scope: "conversation", prefill: "Original draft" } });
      } finally { await f.close(); }
    });

    it("returns files-only success if its metadata refresh disconnects", async () => {
      const f = await fixture();
      try {
        f.native.page.messages = [rewindUser];
        const original = f.native.call.bind(f.native);
        vi.spyOn(f.native, "call").mockImplementation((method, args = []) => {
          if (method === "getSession" && f.native.calls.some(call => call.method === "rewindFiles" && call.args[2] === false)) return Promise.reject(new InspectorDisconnectedError("File restore readback disconnected"));
          return original(method, args);
        });
        await expect(f.bridge.rewindSession(input.sessionId, rewindUser.uuid, "files")).resolves.toEqual({ sessionId: input.sessionId, messageId: rewindUser.uuid, scope: "files" });
        expect(f.native.page.messages).toEqual([rewindUser]);
        expect(f.eventLog.replay(0)).toEqual([]);
        expect(f.native.calls.some(call => call.method === "rewindV2")).toBe(false);
      } finally { await f.close(); }
    });

    it.each([new TypeError("Invalid refresh implementation"), new NativeCallError("Renderer context failed")])("does not swallow a non-disconnection refresh error: %s", async error => {
      const f = await fixture();
      try {
        f.native.page.messages = [rewindUser];
        const original = f.native.call.bind(f.native);
        vi.spyOn(f.native, "call").mockImplementation((method, args = []) => {
          if (method === "getSession" && f.native.calls.some(call => call.method === "rewindV2")) return Promise.reject(error);
          return original(method, args);
        });
        await expect(f.bridge.rewindSession(input.sessionId, rewindUser.uuid, "conversation")).rejects.toBe(error);
      } finally { await f.close(); }
    });

    it("does not report success when persisting the rewind boundary fails", async () => {
      const f = await fixture();
      try {
        f.native.page.messages = [rewindUser];
        const error = new Error("Event log write failed");
        vi.spyOn(f.eventLog, "append").mockRejectedValueOnce(error);
        await expect(f.bridge.rewindSession(input.sessionId, rewindUser.uuid, "conversation")).rejects.toBe(error);
        expect(f.native.calls.filter(call => call.method === "rewindV2")).toHaveLength(1);
        expect(f.eventLog.replay(0)).toEqual([]);
      } finally { await f.close(); }
    });
  });
});
