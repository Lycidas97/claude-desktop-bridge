import { once } from "node:events";
import { rm, mkdtemp, writeFile } from "node:fs/promises";
import { createControllerFixture } from "../controller/controller-fixture.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ClaudeDesktopBridge } from "./claude-desktop-bridge.js";
import { InspectorDisconnectedError, NativeCallError } from "./claude-desktop-inspector.js";
import { ConversationStateStore } from "../controller/conversation-state-store.js";
import { SessionEventLog } from "../controller/session-event-log.js";
import { fixture, NativeDesktop, turnInput as input, planMessage } from "./claude-desktop-bridge-fixture.js";

describe("native history and live projection", () => {
  it("projects the user's replan feedback without the internal Native prompt in event and history", async () => {
    const f = await fixture();
    try {
      const text = "Internal proposal instructions\n\nMove the review to Friday";
      const displayText = "Move the review to Friday";
      const receipt = await f.bridge.startTurn({ ...input, text, displayText });
      expect(f.native.calls.find(call => call.method === "sendMessage")?.args[1]).toBe(text);
      const message = { type: "user", uuid: receipt.messageId, message: { content: text } };
      f.native.page.messages = [message];
      await f.message(message);
      expect((await f.bridge.history(input.sessionId)).items).toEqual([expect.objectContaining({ id: receipt.messageId, text: displayText })]);
      const replay = f.eventLog.replay(0);
      expect(replay).toContainEqual(expect.objectContaining({ type: "user.message.accepted", data: expect.objectContaining({ text: displayText }) }));
      expect(JSON.stringify(replay)).not.toContain("Internal proposal instructions");
      expect(f.state.nativeDesktopReceipt(input.idempotencyKey)?.displayText).toBe(displayText);
    } finally { await f.close(); }
  });

  it("uses the same assistant item ID for delta and completion without requiring a turn ID", async () => {
    const f = await fixture();
    try {
      await f.message({ type: "stream_event", event: { type: "message_start", message: { id: "assistant-api-id" } } });
      await f.message({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "partial" } } });
      await f.message({ type: "assistant", uuid: "transcript-row", message: { id: "assistant-api-id", content: [{ type: "text", text: "final" }] } });
      await f.eventLog.flushDeltas("local-native");
      const events = f.eventLog.replay(0).filter(event => event.type.startsWith("assistant."));
      expect(events.map(event => [event.type, event.itemId, event.turnId])).toEqual([["assistant.delta", "assistant-api-id", undefined], ["assistant.completed", "assistant-api-id", undefined]]);
    } finally { await f.close(); }
  });

  it("keeps sidechain streams and tool results out of the parent event log", async () => {
    const f = await fixture();
    try {
      await f.message({ type: "stream_event", event: { type: "message_start", message: { id: "parent-assistant" } } });
      await f.message({ type: "stream_event", isSidechain: true, parent_tool_use_id: null, event: { type: "message_start", message: { id: "child-assistant" } } });
      await f.message({ type: "stream_event", isSidechain: true, parent_tool_use_id: null, event: { type: "content_block_delta", delta: { type: "text_delta", text: "Child progress" } } });
      await f.message({ type: "user", isSidechain: true, parent_tool_use_id: null, uuid: "child-result", message: { content: [{ type: "tool_result", tool_use_id: "child-wrap", content: "Child finished" }] } });
      await f.message({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Parent progress" } } });
      await f.eventLog.flushDeltas("local-native");
      expect(f.eventLog.replay(0).map(event => ({ type: event.type, itemId: event.itemId, data: event.data }))).toEqual([
        { type: "assistant.delta", itemId: "parent-assistant", data: { text: "Parent progress" } },
      ]);
    } finally { await f.close(); }
  });

  it.each([
    { isCompactSummary: true },
    { isMeta: true },
    { isSynthetic: true },
    { isVisibleInTranscriptOnly: true },
  ])("hides internal native summary history marked %j while retaining identical user input", async flags => {
    const f = await fixture();
    try {
      const content = "This session is being continued from a previous conversation that ran out of context.\n\nSummary:\nFixture context.";
      f.native.page = { messages: [
        { type: "user", uuid: "compact-command", message: { role: "user", content: "/compact" } },
        { type: "system", uuid: "compact-boundary", subtype: "compact_boundary" },
        { type: "user", uuid: "compact-summary", ...flags, message: { role: "user", content } },
        { type: "user", uuid: "typed-message", message: { role: "user", content } },
      ], hasMore: false };
      expect((await f.bridge.history("local-native")).items).toEqual([
        expect.objectContaining({ id: "compact-command", role: "user", text: "/compact" }),
        expect.objectContaining({ id: "typed-message", role: "user", text: content }),
      ]);
    } finally { await f.close(); }
  });

  it.each([
    { isCompactSummary: true },
    { isMeta: true },
    { isSynthetic: true },
    { isVisibleInTranscriptOnly: true },
  ])("does not accept internal native summary events marked %j as user messages", async flags => {
    const f = await fixture();
    try {
      const content = [{ type: "text", text: "This session is being continued from a previous conversation that ran out of context.\n\nSummary:\nFixture context." }];
      await f.message({ type: "user", uuid: "compact-command", message: { role: "user", content: "/compact" } });
      await f.message({ type: "system", uuid: "compact-boundary", subtype: "compact_boundary" });
      await f.message({ type: "user", uuid: "compact-summary", ...flags, message: { role: "user", content } });
      await f.message({ type: "user", uuid: "typed-message", isCompactSummary: false, isMeta: false, isSynthetic: false, isVisibleInTranscriptOnly: false, message: { role: "user", content } });
      expect(f.eventLog.replay(0).filter(event => event.type === "user.message.accepted")).toEqual([
        expect.objectContaining({ itemId: "compact-command", data: expect.objectContaining({ text: "/compact" }) }),
        expect.objectContaining({ itemId: "typed-message", data: expect.objectContaining({ text: content[0]!.text }) }),
      ]);
    } finally { await f.close(); }
  });

  it.each([false, true])("derives cursors from the oldest raw UUID and ends pagination (empty terminal page: %s)", async empty => {
    const f = await fixture();
    try {
      f.native.page = { messages: [{ type: "system", uuid: "oldest-control" }, { type: "assistant", uuid: "row", message: { id: "api-message", content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "Visible" }] } }], hasMore: true };
      f.native.pages.set("oldest-control", { hasMore: false, messages: empty ? [] : [
        { type: "user", uuid: "first-request", message: { content: "First request" } },
        { type: "assistant", uuid: "first-reply", message: { content: "First reply" } },
      ] });
      const page = await f.bridge.history("local-native", undefined, 2);
      expect(page).toMatchObject({ hasMore: true, nextCursor: "oldest-control", items: [{ id: "api-message", text: "Visible" }] });
      f.native.calls.length = 0;
      const last = await f.bridge.history("local-native", page.nextCursor, 2);
      expect(last).toMatchObject({ hasMore: false, items: empty ? [] : [
        { id: "first-request", text: "First request" }, { id: "first-reply", text: "First reply" },
      ] });
      expect(last).not.toHaveProperty("nextCursor");
      expect(f.native.calls).toEqual([{ method: "getTranscriptPage", args: ["local-native", "oldest-control", 2, { window: "accept" }] }]);
    } finally { await f.close(); }
  });

  it("opens the latest native history while the model catalog request is pending", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-open-catalog-"));
    const state = new ConversationStateStore({ databasePath: join(root, "state.sqlite") });
    const eventLog = new SessionEventLog(join(root, "events.jsonl"));
    await state.initialize();
    await eventLog.initialize();
    const native = new NativeDesktop();
    native.pages.set("", { hasMore: true, messages: [
      { type: "user", uuid: "newest", message: { content: "Latest native message" } },
    ] });
    native.pages.set("newest", { hasMore: false, messages: [] });
    let releaseCatalog!: () => void;
    const catalog = new Promise<Response>(resolve => {
      releaseCatalog = () => resolve(new Response(null, { status: 503 }));
    });
    const fetchImpl = vi.fn<typeof fetch>(() => catalog);
    const settingsPath = join(root, "settings.json");
    const bridge = new ClaudeDesktopBridge({
      settingsPath, eventLog, conversationState: state, inspector: native,
      home: root, environment: {}, fetchImpl, refreshIntervalMs: 60_000,
    });
    const controller = createControllerFixture({ broker: bridge, eventLog });
    const configurationRequest = {
      kind: "request" as const, method: "session.configuration" as const,
      requestId: "configuration", idempotencyKey: "configuration", params: { sessionId: "local-native" },
    };
    const pending: Promise<unknown>[] = [];
    try {
      await bridge.initialize();
      await writeFile(settingsPath, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://catalog.example.test" } }));
      const firstConfiguration = controller.handleRequest(configurationRequest, "mobile", "phone");
      pending.push(firstConfiguration);
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));

      native.sessions[0]!.title = "Fresh native title";
      const opened = vi.fn();
      pending.push(controller.handleRequest({
        ...configurationRequest, method: "session.open", requestId: "open", idempotencyKey: "open",
      }, "mobile", "phone").then(opened));
      await vi.waitFor(() => expect(opened).toHaveBeenCalledWith(expect.objectContaining({
        session: expect.objectContaining({ sessionId: "local-native", title: "Fresh native title" }),
        history: expect.objectContaining({
          items: [expect.objectContaining({ id: "newest", text: "Latest native message" })],
          hasMore: true, nextCursor: "newest",
        }),
      })));
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      releaseCatalog();
      expect(await firstConfiguration).toMatchObject({ session: { title: "Fresh native title" } });
      fetchImpl.mockResolvedValueOnce(Response.json({ data: [{ id: "fixture-model", display_name: "Fixture model" }] }));
      await expect(controller.handleRequest({ ...configurationRequest, requestId: "retry", idempotencyKey: "retry" }, "mobile", "phone")).resolves.toMatchObject({
        configuration: { modelsComplete: true, availableModels: [{ value: "fixture-model", displayName: "Fixture model" }] },
      });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      releaseCatalog();
      await Promise.allSettled(pending);
      await bridge.close();
      await eventLog.close();
      state.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["Read", "Bash", "Edit", "mcp__reports__export"])("keeps %s identity and input summary on completion without its start event", async name => {
    const f = await fixture();
    try {
      await f.message({ type: "assistant", uuid: "named-call", message: { content: [{ type: "tool_use", id: "named-tool", name, input: { file_path: "/project/named.ts" } }] } });
      const started = f.eventLog.latestItem("local-native", "tool.started", "named-tool");
      expect(started?.data.toolName).toBe(name);
      await f.message({ type: "user", uuid: "named-result", message: { content: [{ type: "tool_result", tool_use_id: "named-tool", content: "Finished" }] } });
      expect(f.eventLog.latestItem("local-native", "tool.completed", "named-tool")?.data).toMatchObject({ toolName: name, text: started!.data.text });
    } finally { await f.close(); }
  });

  it.each([false, true])("keeps a persisted tool identity and dedup after Bridge restarts (compacted=%s)", async compacted => {
    const f = await fixture();
    let restarted: ClaudeDesktopBridge | undefined;
    let reloadedLog: SessionEventLog | undefined;
    try {
      const call = { type: "assistant", uuid: "restart-call", message: { content: [{ type: "tool_use", id: "restart-tool", name: "Read", input: { file_path: "/project/restart.ts" } }] } };
      await f.message(call);
      await f.bridge.close();
      await f.eventLog.close();
      reloadedLog = new SessionEventLog(f.eventLog.path, 80, compacted ? { bytesThreshold: 1, retainEvents: 0 } : undefined);
      await reloadedLog.initialize();
      restarted = new ClaudeDesktopBridge({ ...f.options, eventLog: reloadedLog });
      await restarted.initialize();
      const beforeDuplicate = reloadedLog.latestSeq();
      let changed = once(restarted, "changed");
      f.native.emit("event", { type: "message", sessionId: "local-native", message: call });
      await changed;
      expect(reloadedLog.latestSeq()).toBe(beforeDuplicate);
      // Discard the rehydrated in-memory tool so completion resolves its identity from the event log.
      await restarted.close();
      restarted = new ClaudeDesktopBridge({ ...f.options, eventLog: reloadedLog });
      await restarted.initialize();
      changed = once(restarted, "changed");
      f.native.emit("event", { type: "message", sessionId: "local-native", message: { type: "user", uuid: "restart-result", message: { content: [{ type: "tool_result", tool_use_id: "restart-tool", content: "Finished" }] } } });
      await changed;
      expect(reloadedLog.latestItem("local-native", "tool.completed", "restart-tool")?.data).toMatchObject({ toolName: "Read", text: compacted ? "" : expect.stringContaining("/project/restart.ts") });
    } finally { await restarted?.close(); await reloadedLog?.close(); await f.close(); }
  });

  it.each([
    { name: "mcp__ccd_turn__update_plan", attribution: {} },
    { name: "mcp__ccd_turn__wrap_up", attribution: {} },
    { name: "Read", attribution: { isSidechain: true } },
    { name: "Read", attribution: { parent_tool_use_id: "parent-agent" } },
  ])("does not create an anonymous completion for hidden $name ($attribution)", async ({ name, attribution }) => {
    const f = await fixture();
    try {
      await f.message({ type: "assistant", uuid: "hidden-call", ...attribution, message: { content: [{ type: "tool_use", id: "hidden-tool", name, input: { items: [{ content: "Inspect", status: "in_progress" }] } }] } });
      await f.message({ type: "user", uuid: "hidden-result", ...attribution, message: { content: [{ type: "tool_result", tool_use_id: "hidden-tool", content: "Done" }] } });
      expect(f.eventLog.latestItem("local-native", "tool.completed", "hidden-tool")).toBeUndefined();
    } finally { await f.close(); }
  });

  it("releases completed tool input and keeps raw tool output out of the event log", async () => {
    const f = await fixture();
    try {
      await f.message({ type: "assistant", uuid: "payload-call", message: { content: [{ type: "tool_use", id: "payload-tool", name: "Read", input: { file_path: "/project/payload.ts" } }] } });
      await f.message({ type: "user", uuid: "payload-result", message: { content: [{ type: "tool_result", tool_use_id: "payload-tool", content: "x".repeat(1_024) }] } });
      const completed = f.eventLog.latestItem("local-native", "tool.completed", "payload-tool");
      expect(completed?.data).toMatchObject({ toolName: "Read", text: expect.stringContaining("/project/payload.ts") });
      expect(completed?.data).not.toHaveProperty("output");
      expect((f.bridge as unknown as { tools: Map<string, unknown> }).tools.size).toBe(0);
    } finally { await f.close(); }
  });

  it.each([
    ["history", { isSidechain: true, parent_tool_use_id: null }],
    ["live", { isSidechain: true, parent_tool_use_id: null }],
    ["history", { parent_tool_use_id: "agent-call" }],
    ["live", { parent_tool_use_id: "agent-call" }],
  ] as const)("isolates child plans and wrap-up from the parent in %s (%j)", async (source, attribution) => {
    const f = await fixture();
    try {
      const tool = (id: string, name: string, input: unknown) => ({ type: "assistant", uuid: id, isSidechain: false, timestamp: 1, message: { content: [{ type: "tool_use", id, name, input }] } });
      const planItems = [{ content: "Read", status: "in_progress" }, { content: "Verify", status: "pending" }];
      const messages = [
        tool("parent-plan", "mcp__ccd_turn__update_plan", { scope: "first_task", items: planItems }),
        { type: "system", subtype: "task_started", task_id: "child-task", tool_use_id: "agent-call", description: "Inspect sources", timestamp: 2 },
        { ...tool("child-plan", "mcp__ccd_turn__update_plan", { scope: "first_task", items: [{ content: "Inspect", status: "in_progress" }] }), ...attribution },
        { ...tool("child-advance", "mcp__ccd_turn__update_plan", { advance: true }), ...attribution },
        { ...tool("child-wrap", "mcp__ccd_turn__wrap_up", { recap: "Child finished" }), ...attribution },
        tool("parent-advance", "mcp__ccd_turn__update_plan", { advance: true }),
        tool("next-plan", "mcp__ccd_turn__update_plan", { scope: "new_task", items: planItems }),
      ];
      let plans;
      if (source === "history") {
        f.native.page.messages = messages;
        const history = await f.bridge.history("local-native");
        plans = new Map(history.items.filter(item => item.taskPlan).map(item => [item.id, item.taskPlan!]));
        expect(history.items.find(item => item.id === "agent-call")?.subagent).toMatchObject({ agentId: "child-task", state: "running" });
      } else {
        for (const message of messages) await f.message(message);
        plans = new Map(f.eventLog.replay(0).filter(event => event.data.taskPlan).map(event => [event.itemId, event.data.taskPlan]));
        expect(f.eventLog.latestItem("local-native", "tool.progress", "agent-call")?.data.subagent).toMatchObject({ agentId: "child-task", state: "running" });
      }
      expect([...plans.keys()]).toEqual(["plan:parent-plan", "plan:next-plan"]);
      expect(plans.get("plan:parent-plan")).toMatchObject({ id: "parent-plan", items: [{ content: "Read", status: "completed" }, { content: "Verify", status: "in_progress" }] });
      expect(plans.get("plan:next-plan")).toMatchObject({ id: "next-plan", items: planItems });
    } finally { await f.close(); }
  });

  it.each([undefined, "newer-page"])("reads only the requested ordinary history page (cursor=%s)", async cursor => {
    const f = await fixture();
    try {
      if (!cursor) {
        await f.message(planMessage("live-plan", { scope: "first_task", items: [{ content: "Read", status: "in_progress" }] }));
        f.native.contextUsage = { totalTokens: 64_200, rawMaxTokens: 1_000_000 };
      }
      for (let index = 0; index < 18; index += 1) {
        f.native.pages.set(index === 0 ? cursor ?? "" : `ordinary-${index - 1}`, {
          messages: [{ type: "assistant", uuid: `ordinary-${index}`, message: { content: [{ type: "text", text: `Page ${index}` }] } }],
          hasMore: index < 17,
        });
      }

      const controller = createControllerFixture({ broker: f.bridge, eventLog: f.eventLog });
      const page = await controller.handleRequest({
        kind: "request", requestId: "history", idempotencyKey: "history", method: "session.history", params: { sessionId: "local-native", cursor, limit: 1 },
      }, "mobile", "phone");
      expect(page).toMatchObject({ history: { hasMore: true, nextCursor: "ordinary-0", items: [{ id: "ordinary-0", text: "Page 0" }] } });
      if (!cursor) expect(f.bridge.session("local-native")?.contextUsage).toMatchObject({ totalTokens: 64_200, maxTokens: 1_000_000, estimated: false });
      expect(f.native.calls.filter(call => ["getTranscriptPage", "getContextUsage"].includes(call.method))).toEqual([
        { method: "getTranscriptPage", args: ["local-native", cursor ?? "", 1, { window: "accept" }] },
        ...(cursor ? [] : [{ method: "getContextUsage", args: ["local-native"] }]),
      ]);
    } finally { await f.close(); }
  });

  it("keeps session proposal results out of legacy-readable history rows on the same or a newer page", async () => {
    const f = await fixture();
    try {
      const title = "检查日历告警";
      const call = planMessage("calendar-call", { title, initiation: "own_initiative", context: "fork", prompt: "验证旧告警" }, 10, "mcp__ccd_session__start_session");
      const result = { type: "user", uuid: "calendar-result", timestamp: 20, message: { content: [{
        type: "tool_result", tool_use_id: call.uuid, content: `Proposed "${title}" (task_id: task_d6c18845). The user sees a card and nothing runs.`,
      }] } };
      f.native.pages.set("", { messages: [result], hasMore: true });
      f.native.pages.set(result.uuid, { messages: [call], hasMore: false });
      const latest = await f.bridge.history("local-native", undefined, 1);
      expect(latest).toMatchObject({ items: [], sessionProposalResults: [call.uuid], nextCursor: result.uuid, hasMore: true });
      const older = await f.bridge.history("local-native", latest.nextCursor, 1);
      expect(older.items).toMatchObject([{ id: call.uuid, createdAt: 10, text: expect.stringContaining(title), sessionProposal: { title } }]);
      f.native.pages.set("", { messages: [call, result], hasMore: false });
      expect(await f.bridge.history("local-native")).toMatchObject({ items: older.items, sessionProposalResults: [call.uuid] });
    } finally { await f.close(); }
  });

  it("keeps one plan identity when initialization and continuation occupy adjacent native history pages", async () => {
    const f = await fixture();
    try {
      const items = [{ content: "Read", status: "in_progress" }, { content: "Verify", status: "pending" }];
      const initial = planMessage("initial", { scope: "first_task", items }, 10);
      const continuation = planMessage("continuation", { scope: "continuation", items }, 20);
      f.native.page.messages = [initial, continuation];
      f.native.pages.set("", { messages: [continuation], hasMore: true });
      f.native.pages.set("continuation", { messages: [initial], hasMore: false });
      const latest = await f.bridge.history("local-native", undefined, 1);
      expect(latest.nextCursor).toBe("continuation");
      const older = await f.bridge.history("local-native", latest.nextCursor, 1);
      const reloaded = await f.bridge.history("local-native", undefined, 1);
      expect([latest, older, reloaded].map(page => page.items.filter(item => item.taskPlan).map(item => item.id))).toEqual([
        ["plan:initial"], ["plan:initial"], ["plan:initial"],
      ]);
      expect(latest.items.find(item => item.taskPlan)?.taskPlan).toMatchObject({ id: "initial", items });
    } finally { await f.close(); }
  });

  it("keeps identical top-level new_task plans distinct across adjacent native history pages", async () => {
    const f = await fixture();
    try {
      const items = [{ content: "Read", status: "in_progress" }, { content: "Verify", status: "pending" }];
      const initial = planMessage("initial", { scope: "first_task", items }, 10);
      const next = planMessage("next-task", { scope: "new_task", items }, 20);
      f.native.page.messages = [initial, next];
      f.native.pages.set("", { messages: [next], hasMore: true });
      f.native.pages.set("next-task", { messages: [initial], hasMore: false });
      const latest = await f.bridge.history("local-native", undefined, 1);
      const older = await f.bridge.history("local-native", latest.nextCursor, 1);
      expect([older, latest].map(page => page.items.filter(item => item.taskPlan).map(item => ({ id: item.id, planId: item.taskPlan!.id, items: item.taskPlan!.items }))))
        .toEqual([[{ id: "plan:initial", planId: "initial", items }], [{ id: "plan:next-task", planId: "next-task", items }]]);
    } finally { await f.close(); }
  });

  it("continues the loaded history plan with a live replacement list under its original identity", async () => {
    const f = await fixture();
    try {
      const initial = planMessage("history-plan", { scope: "first_task", items: [{ content: "Read", status: "in_progress" }, { content: "Verify", status: "pending" }] }, 10);
      f.native.page.messages = [initial];
      const history = await f.bridge.history("local-native");
      expect(history.items.find(item => item.taskPlan)?.id).toBe("plan:history-plan");
      const items = [{ content: "Read", status: "completed" }, { content: "Verify", status: "in_progress" }];
      await f.message(planMessage("live-continuation", { scope: "continuation", items }, 20));
      expect(f.eventLog.replay(0).filter(event => event.data.taskPlan)).toMatchObject([
        { itemId: "plan:history-plan", data: { taskPlanSource: "native-main", taskPlan: { id: "history-plan", items } } },
      ]);
    } finally { await f.close(); }
  });

  it.each(["advance", "wrap-up"])("applies a live %s to the loaded history plan without another initialization", async action => {
    const f = await fixture();
    try {
      f.native.page.messages = [planMessage("history-plan", { scope: "first_task", items: [{ content: "Read", status: "in_progress" }, { content: "Verify", status: "pending" }] }, 10)];
      const history = await f.bridge.history("local-native");
      expect(history.items.find(item => item.taskPlan)?.id).toBe("plan:history-plan");
      await f.message(action === "advance"
        ? planMessage("live-advance", { advance: true }, 20)
        : planMessage("live-wrap", { recap: "Done" }, 20, "mcp__ccd_turn__wrap_up"));
      expect(f.eventLog.replay(0).filter(event => event.data.taskPlan)).toMatchObject([
        { itemId: "plan:history-plan", data: { taskPlan: { id: "history-plan", items: [
          { content: "Read", status: "completed" },
          { content: "Verify", status: action === "advance" ? "in_progress" : "completed" },
        ] } } },
      ]);
    } finally { await f.close(); }
  });

  it("does not reset a progressed live plan when an older initialization page is loaded", async () => {
    const f = await fixture();
    try {
      const initial = planMessage("live-plan", { scope: "first_task", items: [{ content: "Read", status: "in_progress" }, { content: "Verify", status: "pending" }] }, 10);
      await f.message(initial);
      await f.message(planMessage("first-advance", { advance: true }, 20));
      f.native.pages.set("first-advance", { messages: [initial], hasMore: false });
      await f.bridge.history("local-native", "first-advance", 1);
      await f.message(planMessage("second-advance", { advance: true }, 30));
      expect(f.eventLog.latestItem("local-native", "assistant.completed", "plan:live-plan")?.data.taskPlan).toMatchObject({
        id: "live-plan", items: [{ content: "Read", status: "completed" }, { content: "Verify", status: "completed" }],
      });
    } finally { await f.close(); }
  });

  it("recovers an older history plan on a plain latest page before any live plan is observed", async () => {
    const f = await fixture();
    try {
      const ordinary = { type: "assistant", uuid: "ordinary", timestamp: 20, message: { content: [{ type: "text", text: "Continuing work" }] } };
      await f.message(ordinary);
      f.native.pages.set("", { messages: [ordinary], hasMore: true });
      f.native.pages.set("ordinary", { messages: [planMessage("history-plan", { scope: "first_task", items: [{ content: "Read", status: "in_progress" }, { content: "Verify", status: "pending" }] }, 10)], hasMore: false });
      const history = await f.bridge.history("local-native");
      expect(history.items.map(item => item.id)).toEqual(["ordinary"]);
      expect(f.native.calls.filter(call => call.method === "getTranscriptPage").map(call => call.args[1])).toEqual(["", "ordinary"]);
      await f.message(planMessage("live-advance", { advance: true }, 30));
      expect(f.eventLog.latestItem("local-native", "assistant.completed", "plan:history-plan")?.data.taskPlan).toMatchObject({
        id: "history-plan", items: [{ content: "Read", status: "completed" }, { content: "Verify", status: "in_progress" }],
      });
    } finally { await f.close(); }
  });

  it("does not reset a live plan from an older latest history snapshot", async () => {
    const f = await fixture();
    try {
      const initial = planMessage("live-plan", { scope: "first_task", items: [{ content: "Read", status: "in_progress" }, { content: "Verify", status: "pending" }] }, 10);
      await f.message(initial);
      await f.message(planMessage("first-advance", { advance: true }, 20));
      f.native.page.messages = [initial];
      await f.bridge.history("local-native");
      await f.message(planMessage("second-advance", { advance: true }, 30));
      expect(f.eventLog.latestItem("local-native", "assistant.completed", "plan:live-plan")?.data.taskPlan).toMatchObject({
        id: "live-plan", items: [{ content: "Read", status: "completed" }, { content: "Verify", status: "completed" }],
      });
    } finally { await f.close(); }
  });

  it.each([true, false])("does not resurrect a plan after an observed live wrap-up and a stale history snapshot (live initialization: %s)", async hadInitialization => {
    const f = await fixture();
    try {
      const initial = planMessage("finished-plan", { scope: "first_task", items: [{ content: "Read", status: "in_progress" }, { content: "Verify", status: "pending" }] }, 10);
      if (hadInitialization) await f.message(initial);
      await f.message(planMessage("live-wrap", { recap: "Done" }, 20, "mcp__ccd_turn__wrap_up"));
      const completed = f.eventLog.latestItem("local-native", "assistant.completed", "plan:finished-plan");
      f.native.page.messages = [initial];
      await f.bridge.history("local-native");
      await f.message(planMessage("orphan-advance", { advance: true }, 30));
      expect(f.eventLog.latestItem("local-native", "assistant.completed", "plan:finished-plan")).toEqual(completed);
      expect(f.eventLog.replay(0).filter(event => event.data.taskPlan)).toHaveLength(hadInitialization ? 2 : 0);
    } finally { await f.close(); }
  });

  it.each([undefined, "newer-page"])("restores plan context up to the nearest top-level new_task (cursor=%s)", async cursor => {
    const f = await fixture();
    try {
      const old = planMessage("older-plan", { scope: "first_task", items: [{ content: "Old work", status: "in_progress" }] }, 1);
      const initial = planMessage("current-plan", { scope: "new_task", items: [{ content: "Read", status: "in_progress" }, { content: "Verify", status: "pending" }] }, 10);
      const child = { ...planMessage("child-initial", { scope: "first_task", items: [{ content: "Child", status: "in_progress" }] }, 15), isSidechain: true };
      const continuation = planMessage("continued", { scope: "continuation", items: [{ content: "Read", status: "in_progress" }, { content: "Verify", status: "pending" }] }, 20);
      const text = { type: "assistant", uuid: "latest-text", timestamp: 25, message: { content: [{ type: "text", text: "Visible latest text" }] } };
      const advance = planMessage("latest-advance", { advance: true }, 30);
      f.native.pages.set(cursor ?? "", { messages: [text, advance], hasMore: true });
      f.native.pages.set("latest-text", { messages: [child, continuation], hasMore: true });
      f.native.pages.set("child-initial", { messages: [old, initial], hasMore: true });
      f.native.contextUsage = { totalTokens: 64_200, rawMaxTokens: 1_000_000 };
      const controller = createControllerFixture({ broker: f.bridge, eventLog: f.eventLog });
      const response = await controller.handleRequest({
        kind: "request", requestId: "history", idempotencyKey: "history", method: "session.history", params: { sessionId: "local-native", cursor, limit: 2 },
      }, "mobile", "phone");
      expect(response).toMatchObject({ history: { hasMore: true, nextCursor: "latest-text", items: [
        { id: "latest-text", text: "Visible latest text" },
        { id: "plan:current-plan", taskPlan: { id: "current-plan", items: [{ content: "Read", status: "completed" }, { content: "Verify", status: "in_progress" }] } },
      ] } });
      expect(f.native.calls.filter(call => ["getTranscriptPage", "getContextUsage"].includes(call.method))).toEqual([
        { method: "getTranscriptPage", args: ["local-native", cursor ?? "", 2, { window: "accept" }] },
        { method: "getTranscriptPage", args: ["local-native", "latest-text", 2, { window: "accept" }] },
        { method: "getTranscriptPage", args: ["local-native", "child-initial", 2, { window: "accept" }] },
        ...(cursor ? [] : [{ method: "getContextUsage", args: ["local-native"] }]),
      ]);
      expect(f.native.calls.some(call => call.method === "getTranscript")).toBe(false);
    } finally { await f.close(); }
  });

  it("stops history plan recovery at a preceding wrap-up without reviving its old plan", async () => {
    const f = await fixture();
    try {
      const initial = planMessage("finished-plan", { scope: "first_task", items: [{ content: "Read", status: "in_progress" }] }, 10);
      const wrap = planMessage("historical-wrap", { recap: "Done" }, 20, "mcp__ccd_turn__wrap_up");
      const advance = planMessage("orphan-advance", { advance: true }, 30);
      f.native.pages.set("", { messages: [advance], hasMore: true });
      f.native.pages.set("orphan-advance", { messages: [initial, wrap], hasMore: true });
      const controller = createControllerFixture({ broker: f.bridge, eventLog: f.eventLog });
      const response = await controller.handleRequest({
        kind: "request", requestId: "history", idempotencyKey: "history", method: "session.history", params: { sessionId: "local-native", limit: 1 },
      }, "mobile", "phone");
      expect(response).toMatchObject({ history: { hasMore: true, nextCursor: "orphan-advance", items: [] } });
      expect(f.native.calls.filter(call => call.method === "getTranscriptPage").map(call => call.args[1])).toEqual(["", "orphan-advance"]);
      await f.message(planMessage("later-orphan", { advance: true }, 40));
      expect(f.eventLog.replay(0).filter(event => event.data.taskPlan)).toEqual([]);
    } finally { await f.close(); }
  });

  it("rejects a malformed plan lookback page before querying live context usage", async () => {
    const f = await fixture();
    try {
      f.native.pages.set("", { messages: [planMessage("advance", { advance: true })], hasMore: true });
      f.native.pages.set("advance", { hasMore: true });
      const controller = createControllerFixture({ broker: f.bridge, eventLog: f.eventLog });
      await expect(controller.handleRequest({
        kind: "request", requestId: "history", idempotencyKey: "history", method: "session.history", params: { sessionId: "local-native", limit: 1 },
      }, "mobile", "phone")).rejects.toThrow(new NativeCallError("Desktop returned an invalid transcript page"));
      expect(f.native.calls.filter(call => ["getTranscriptPage", "getContextUsage"].includes(call.method))).toEqual([
        { method: "getTranscriptPage", args: ["local-native", "", 1, { window: "accept" }] },
        { method: "getTranscriptPage", args: ["local-native", "advance", 1, { window: "accept" }] },
      ]);
    } finally { await f.close(); }
  });

  it.each([
    { isSidechain: true, parent_tool_use_id: null },
    { parent_tool_use_id: "agent-call" },
  ])("inherits the main plan across pages containing child plan updates (%j)", async attribution => {
    const f = await fixture();
    try {
      const initial = planMessage("main-plan", { scope: "first_task", items: [{ content: "Read", status: "in_progress" }, { content: "Verify", status: "pending" }] }, 10);
      const recent = [
        { ...planMessage("child-plan", { scope: "new_task", items: [{ content: "Child inspect", status: "in_progress" }] }, 20), ...attribution },
        { ...planMessage("child-continuation", { scope: "continuation", items: [{ content: "Child inspect", status: "completed" }] }, 21), ...attribution },
        planMessage("main-advance", { advance: true }, 30),
      ];
      f.native.page.messages = [initial, ...recent];
      f.native.pages.set("", { messages: recent, hasMore: true });
      f.native.pages.set("child-plan", { messages: [initial], hasMore: false });
      const latest = await f.bridge.history("local-native", undefined, 3);
      expect(latest.nextCursor).toBe("child-plan");
      const older = await f.bridge.history("local-native", latest.nextCursor, 3);
      expect(older.items.filter(item => item.taskPlan).map(item => item.id)).toEqual(["plan:main-plan"]);
      expect(latest.items.filter(item => item.taskPlan)).toMatchObject([
        { id: "plan:main-plan", taskPlan: { id: "main-plan", items: [{ content: "Read", status: "completed" }, { content: "Verify", status: "in_progress" }] } },
      ]);
    } finally { await f.close(); }
  });

  it.each([
    { isCompactSummary: true },
    { isMeta: true },
    { isSynthetic: true },
    { isVisibleInTranscriptOnly: true },
  ])("can page past a wholly internal compact page without dropping identical older user input (%j)", async flags => {
    const f = await fixture();
    try {
      const text = "This session is being continued from a previous conversation that ran out of context.\n\nSummary:\nFixture context.";
      const typed = { type: "user", uuid: "typed-before-compact", message: { role: "user", content: text } };
      const hidden = { type: "user", uuid: "hidden-summary", ...flags, message: { role: "user", content: text } };
      const boundary = { type: "system", uuid: "compact-boundary", subtype: "compact_boundary" };
      f.native.page.messages = [typed, hidden, boundary];
      f.native.pages.set("", { messages: [hidden, boundary], hasMore: true });
      f.native.pages.set("hidden-summary", { messages: [typed], hasMore: false });
      const latest = await f.bridge.history("local-native", undefined, 2);
      expect(latest).toMatchObject({ items: [], hasMore: true, nextCursor: "hidden-summary" });
      const older = await f.bridge.history("local-native", latest.nextCursor, 2);
      expect(older).toMatchObject({ hasMore: false, items: [{ id: "typed-before-compact", role: "user", text }] });
      expect(older.nextCursor).toBeUndefined();
    } finally { await f.close(); }
  });

  it("does not use event replay as native history after disconnection", async () => {
    const f = await fixture();
    try {
      await f.message({ type: "assistant", uuid: "local-event", message: { content: "Only in the event log" } });
      f.native.ready = false;
      await expect(f.bridge.history("local-native")).rejects.toBeInstanceOf(InspectorDisconnectedError);
      expect(f.native.calls.some(call => call.method === "getTranscriptPage")).toBe(false);
    } finally { await f.close(); }
  });

  it.each([undefined, "older-page"])("updates a history-loaded native question when its live tool result arrives (cursor=%s)", async cursor => {
    const f = await fixture();
    try {
      f.native.page = { hasMore: false, messages: [{ type: "assistant", uuid: "question", timestamp: 10, message: { id: "question-body", content: [
        { type: "text", text: "选择接下来的检查" },
        { type: "tool_use", id: "ask", name: "AskUserQuestion", input: { questions: [{ question: "检查哪些？", multiSelect: true, options: [{ label: "稍后处理" }, { label: "类型检查" }, { label: "回归测试" }] }] } },
      ] } }] };
      await f.bridge.history("local-native", cursor);
      await f.message({ type: "user", uuid: "answer", timestamp: 20, toolUseResult: { answers: { "检查哪些？": "类型检查, 回归测试" } }, message: { content: [
        { type: "tool_result", tool_use_id: "ask", content: "User has answered your questions." },
      ] } });
      expect(f.eventLog.replay().find(event => event.type === "assistant.completed" && event.itemId === "question-body")?.data).toMatchObject({
        text: "选择接下来的检查", interactivePrompt: { kind: "question", answered: true, toolUseId: "ask", questions: [{
          answer: "类型检查, 回归测试", options: [{ label: "稍后处理" }, { label: "类型检查", selected: true }, { label: "回归测试", selected: true }],
        }] },
      });
    } finally { await f.close(); }
  });

  it.each([1, 2])("restores split-page answers on repeated cursor reads (%i clients)", async clients => {
    const f = await fixture();
    try {
      f.native.page = { hasMore: true, messages: [{ type: "user", uuid: "answer", timestamp: 20,
        toolUseResult: { answers: { "检查哪些？": "类型检查, 回归测试" } },
        message: { content: [{ type: "tool_result", tool_use_id: "ask", content: "User has answered your questions." }] },
      }] };
      f.native.pages.set("answer", { hasMore: false, messages: [{ type: "assistant", uuid: "question", timestamp: 10, message: { content: [
        { type: "tool_use", id: "ask", name: "AskUserQuestion", input: { questions: [{ question: "检查哪些？", multiSelect: true, options: [{ label: "稍后处理" }, { label: "类型检查" }, { label: "回归测试" }] }] } },
      ] } }] });
      const latest = await f.bridge.history("local-native");
      const second = clients === 2 ? await f.bridge.history("local-native") : latest;
      for (const cursor of [latest.nextCursor, second.nextCursor]) {
        const older = await f.bridge.history("local-native", cursor);
        expect(older.items.find(item => item.id === "question")?.interactivePrompt).toMatchObject({ answered: true, questions: [{
          answer: "类型检查, 回归测试", options: [{ label: "稍后处理" }, { label: "类型检查", selected: true }, { label: "回归测试", selected: true }],
        }] });
      }
    } finally { await f.close(); }
  });

  it.each([
    { hasMore: false, count: 1, limit: 50 },
    { hasMore: true, count: 20, limit: 30 },
  ])("skips a model tail already covered by the requested page ($count messages, hasMore=$hasMore)", async ({ hasMore, count, limit }) => {
    const f = await fixture();
    try {
      f.native.sessions[0]!.model = "default";
      f.native.sessions[0]!.turnRunning = true;
      f.native.contextUsage = { totalTokens: 98_000, rawMaxTokens: 196_000 };
      await f.bridge.refreshRuntime();
      await f.message(planMessage("live-wrap", { recap: "Done" }, 20, "mcp__ccd_turn__wrap_up"));
      f.native.page = { hasMore, messages: Array.from({ length: count }, (_, index) => ({
        type: "user", uuid: `request-${index}`, message: { content: `Request ${index}` },
      })) };
      const controller = createControllerFixture({ broker: f.bridge, eventLog: f.eventLog });
      f.native.calls.length = 0;

      const opened = await controller.handleRequest({
        kind: "request", requestId: "open", idempotencyKey: "open", method: "session.open", params: { sessionId: "local-native", limit },
      }, "mobile", "phone");

      expect(opened).toMatchObject({
        history: { hasMore, ...(hasMore ? { nextCursor: "request-0" } : {}) },
        session: { contextUsage: { totalTokens: 98_000, maxTokens: 196_000, percentage: 50, estimated: false } },
      });
      expect(opened).toHaveProperty("history.items.length", count);
      expect(f.native.calls.filter(call => ["getTranscriptPage", "getContextUsage"].includes(call.method))).toEqual([
        { method: "getTranscriptPage", args: ["local-native", "", limit, { window: "accept" }] },
        { method: "getContextUsage", args: ["local-native"] },
      ]);
    } finally { await f.close(); }
  });

  it.each(["available", "unavailable"])("only checks the model tail after opening a page without model hints (%s tail)", async tail => {
    const f = await fixture();
    try {
      f.native.sessions[0]!.model = "default";
      f.native.sessions[0]!.turnRunning = true;
      f.native.contextUsage = { totalTokens: 98_000, rawMaxTokens: 196_000 };
      await f.bridge.refreshRuntime();
      await f.message(planMessage("live-wrap", { recap: "Done" }, 20, "mcp__ccd_turn__wrap_up"));
      const newest = { type: "user", uuid: "latest", message: { content: "Latest request" } };
      f.native.page = { messages: [newest], hasMore: true };
      const call = f.native.call.bind(f.native);
      vi.spyOn(f.native, "call").mockImplementation(async (method, args) => {
        const result = await call(method, args);
        if (method !== "getTranscriptPage" || args?.[2] !== 20) return result;
        if (tail === "unavailable") throw new NativeCallError("Model tail unavailable");
        return { messages: [
          { type: "assistant", uuid: "older", message: { model: "claude-sonnet-4-5", content: "Earlier response" } }, newest,
        ], hasMore: false };
      });
      const controller = createControllerFixture({ broker: f.bridge, eventLog: f.eventLog });
      f.native.calls.length = 0;

      const opened = await controller.handleRequest({
        kind: "request", requestId: "open", idempotencyKey: "open", method: "session.open", params: { sessionId: "local-native", limit: 1 },
      }, "mobile", "phone");

      expect(opened).toMatchObject({
        history: { items: [{ id: "latest", text: "Latest request" }], hasMore: true, nextCursor: "latest" },
        session: { contextUsage: { totalTokens: 98_000, maxTokens: 196_000, percentage: 50, estimated: false } },
      });
      if (tail === "available") expect(opened).toHaveProperty("session.model", "claude-sonnet-4-5");
      expect(f.native.calls.filter(call => ["getTranscriptPage", "getContextUsage"].includes(call.method))).toEqual([
        { method: "getTranscriptPage", args: ["local-native", "", 1, { window: "accept" }] },
        { method: "getContextUsage", args: ["local-native"] },
        { method: "getTranscriptPage", args: ["local-native", "", 20, { window: "accept" }] },
      ]);
    } finally { await f.close(); }
  });
});
