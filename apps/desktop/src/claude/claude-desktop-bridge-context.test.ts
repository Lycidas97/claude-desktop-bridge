import { writeFile } from "node:fs/promises";
import { createControllerFixture } from "../controller/controller-fixture.js";
import { describe, expect, it, vi } from "vitest";
import { InspectorDisconnectedError } from "./claude-desktop-inspector.js";
import { magpieModelIdHash } from "./claude-runtime-discovery.js";
import { fixture, planMessage } from "./claude-desktop-bridge-fixture.js";

describe("native context usage", () => {
  it.each([
    ["claude-sonnet-4-5", true],
    ["default", true],
    ["mythos-magpie-5277472942", true],
    ["default", false],
  ] as const)("reads the requested history page before the only live usage query (native model: %s, usage available: %s)", async (model, usageAvailable) => {
    const f = await fixture();
    try {
      f.native.sessions[0]!.model = model;
      f.native.sessions[0]!.turnRunning = true;
      f.native.contextUsage = usageAvailable ? { totalTokens: 98_000, rawMaxTokens: 196_000 } : null;
      f.native.page = { hasMore: false, messages: [{
        type: "assistant", uuid: "latest", message: { model: "claude-sonnet-4-5", content: "Latest response" },
      }] };
      const controller = createControllerFixture({ broker: f.bridge, eventLog: f.eventLog });
      f.native.calls.length = 0;

      const opened = await controller.handleRequest({
        kind: "request", requestId: "open", idempotencyKey: "open", method: "session.open", params: { sessionId: "local-native", limit: 7 },
      }, "mobile", "phone");

      expect(opened).toMatchObject({
        history: { items: [{ id: "latest", text: "Latest response" }], hasMore: false },
        session: {
          model: model === "default" ? "claude-sonnet-4-5" : model,
          modelDisplayName: "Claude Sonnet 4.5",
          ...(usageAvailable ? { contextUsage: { totalTokens: 98_000, maxTokens: 196_000, percentage: 50, estimated: false } } : {}),
        },
      });
      if (!usageAvailable) expect(opened).not.toHaveProperty("session.contextUsage");
      expect(f.native.calls.filter(call => ["getTranscriptPage", "getContextUsage"].includes(call.method))).toEqual([
        { method: "getTranscriptPage", args: ["local-native", "", 7, { window: "accept" }] },
        { method: "getContextUsage", args: ["local-native"] },
      ]);
    } finally { await f.close(); }
  });

  it("opens a running session with an estimate when Native lacks realtime usage", async () => {
    const f = await fixture();
    try {
      const model = "claude-sonnet-4-5";
      f.native.sessions[0]!.model = model;
      f.native.sessions[0]!.turnRunning = true;
      f.native.unsupported.add("getContextUsage");
      f.native.page = { hasMore: false, messages: [{
        type: "assistant", uuid: "only-reply", message: { model, content: "Only reply", usage: { input_tokens: 12_000, output_tokens: 400 } },
      }] };
      const controller = createControllerFixture({ broker: f.bridge, eventLog: f.eventLog });
      f.native.calls.length = 0;

      expect(await controller.dispatchLocal({ method: "session.open", params: { sessionId: "local-native" } })).toMatchObject({
        ok: true, result: {
          history: { hasMore: false, items: [{ id: "only-reply", text: "Only reply" }] },
          session: { contextUsage: { model, totalTokens: 12_400, estimated: true } },
        },
      });
      expect(f.native.calls.filter(call => ["getTranscriptPage", "getContextUsage"].includes(call.method))).toEqual([
        { method: "getTranscriptPage", args: ["local-native", "", 18, { window: "accept" }] },
      ]);
    } finally { await f.close(); }
  });

  it.each([
    { hold: "older page", compact: false },
    { hold: "empty live usage", compact: false },
    { hold: "older page", compact: true },
  ])("keeps a newer live usage sample with a delayed $hold (compacted: $compact)", async ({ hold, compact }) => {
    const f = await fixture();
    try {
      const model = "claude-sonnet-4-5";
      f.native.sessions[0]!.model = "default";
      f.native.sessions[0]!.turnRunning = true;
      await f.bridge.refreshRuntime();
      await f.message(planMessage("live-wrap", { recap: "Done" }, 20, "mcp__ccd_turn__wrap_up"));
      f.native.page = { hasMore: true, messages: [{ type: "user", uuid: "latest", message: { content: "Latest request" } }] };
      f.native.calls.length = 0;
      const older = {
        type: "assistant", uuid: "older", message: { model, content: "Earlier reply", usage: { input_tokens: 12_000, output_tokens: 400 } },
      };
      f.native.pages.set("latest", { hasMore: false, messages: [older, ...(compact ? [{
        type: "system", subtype: "compact_boundary", uuid: "compact",
        compactMetadata: { postTokens: 9_200, preservedSegment: { tailUuid: older.uuid } },
      }] : [])] });
      let markFirstReadPending!: () => void;
      const firstReadPending = new Promise<void>(resolve => { markFirstReadPending = resolve; });
      let releaseFirstRead!: () => void;
      const firstReadReleased = new Promise<void>(resolve => { releaseFirstRead = resolve; });
      const call = f.native.call.bind(f.native);
      vi.spyOn(f.native, "call").mockImplementation(async (method, args = []) => {
        const pause = hold === "older page"
          ? method === "getTranscriptPage" && args[1] === "latest"
          : method === "getContextUsage" && f.native.contextUsage === null;
        const result = call(method, args);
        if (pause) {
          markFirstReadPending();
          await firstReadReleased;
        }
        return result;
      });
      const controller = createControllerFixture({ broker: f.bridge, eventLog: f.eventLog });
      const first = controller.dispatchLocal({ method: "session.open", params: { sessionId: "local-native" } });
      await firstReadPending;
      f.native.contextUsage = { totalTokens: 64_200, rawMaxTokens: 1_000_000 };
      const second = await controller.dispatchLocal({ method: "session.open", params: { sessionId: "local-native" } });
      releaseFirstRead();
      const firstResult = await first;

      const live = { totalTokens: 64_200, maxTokens: 1_000_000, estimated: false };
      expect(second).toMatchObject({ ok: true, result: { session: { contextUsage: live } } });
      expect(firstResult).toMatchObject({
        ok: true,
        result: { history: { items: [{ id: "latest" }], hasMore: true, nextCursor: "latest" } },
      });
      expect({ firstResult, projected: f.bridge.session("local-native")?.contextUsage }).toMatchObject({
        firstResult: { ok: true, result: { session: { model, contextUsage: live } } }, projected: live,
      });
      expect(f.native.calls.filter(call => call.method === "getTranscriptPage").map(call => call.args.slice(1, 3))).toEqual(
        hold === "older page" ? [["", 18], ["latest", 100], ["", 18], ["", 20]] : [["", 18], ["", 18], ["", 20], ["latest", 100]],
      );
      if (compact) {
        await f.message(older);
        expect(f.bridge.session("local-native")?.contextUsage).toMatchObject(live);
      }
    } finally { await f.close(); }
  });

  it("keeps the live usage from the second concurrent open when both native replies arrive together", async () => {
    const f = await fixture();
    try {
      f.native.sessions[0]!.model = "claude-sonnet-4-5";
      f.native.page = { hasMore: false, messages: [{
        type: "assistant", uuid: "latest", message: { model: "claude-sonnet-4-5", content: "Latest response", usage: { input_tokens: 12_000, output_tokens: 400 } },
      }] };
      const usageReplies: Array<(value: unknown) => void> = [];
      let bothUsageCallsPending!: () => void;
      const usageCallsPending = new Promise<void>(resolve => { bothUsageCallsPending = resolve; });
      const call = f.native.call.bind(f.native);
      vi.spyOn(f.native, "call").mockImplementation((method, args = []) => {
        if (method !== "getContextUsage") return call(method, args);
        f.native.calls.push({ method, args });
        return new Promise(resolve => {
          usageReplies.push(resolve);
          if (usageReplies.length === 2) bothUsageCallsPending();
        });
      });
      const controller = createControllerFixture({ broker: f.bridge, eventLog: f.eventLog });
      const opens = ["phone-a", "phone-b"].map(phone => controller.handleRequest({
        kind: "request", requestId: phone, idempotencyKey: phone, method: "session.open", params: { sessionId: "local-native" },
      }, "mobile", phone));

      await usageCallsPending;
      usageReplies[0]!(null);
      usageReplies[1]!({ totalTokens: 64_200, rawMaxTokens: 1_000_000 });
      await Promise.all(opens);

      expect(f.bridge.session("local-native")?.contextUsage).toMatchObject({ totalTokens: 64_200, maxTokens: 1_000_000, estimated: false });
      expect(f.native.calls.filter(call => call.method === "getTranscriptPage").map(call => call.args[1])).toEqual(["", ""]);
    } finally { await f.close(); }
  });

  it("reads live context usage for standalone session settings", async () => {
    const f = await fixture();
    try {
      f.native.sessions[0]!.model = "claude-opus-5-5";
      f.native.sessions[0]!.turnRunning = true;
      f.native.contextUsage = { totalTokens: 64_200, rawMaxTokens: 1_000_000 };
      const controller = createControllerFixture({ broker: f.bridge, eventLog: f.eventLog });
      f.native.calls.length = 0;

      const settings = await controller.handleRequest({
        kind: "request", requestId: "configuration", idempotencyKey: "configuration", method: "session.configuration", params: { sessionId: "local-native" },
      }, "mobile", "phone");

      const context = { totalTokens: 64_200, maxTokens: 1_000_000, percentage: 6.4, model: "claude-opus-5-5", estimated: false };
      expect(settings).toMatchObject({ configuration: { context }, session: { contextUsage: context } });
      expect(f.native.calls.filter(call => ["getTranscriptPage", "getContextUsage"].includes(call.method))).toEqual([
        { method: "getContextUsage", args: ["local-native"] },
      ]);
    } finally { await f.close(); }
  });

  it.each([
    { source: "the plan page", usagePage: 0, reads: 0 },
    { source: "a malformed estimate page", usagePage: null, reads: 1 },
    { source: "the eighth estimate page", usagePage: 8, reads: 8 },
    { source: "the unread ninth estimate page", usagePage: 9, reads: 8 },
  ])("preserves the history cursor and bounds context lookback with $source", async ({ usagePage, reads }) => {
    const f = await fixture();
    try {
      const model = "claude-sonnet-4-5";
      f.native.sessions[0]!.model = model;
      const usage = { id: "main-turn", model, usage: { input_tokens: 12_000, output_tokens: 400 } };
      const plan = planMessage("plan", { scope: "first_task", items: [{ content: "Read", status: "in_progress" }] }, 10);
      f.native.pages.set("", { hasMore: true, messages: [
        ...Array.from({ length: 19 }, (_, index) => ({ type: "user", uuid: `hidden-${index}`, isMeta: true })),
        planMessage("advance", { advance: true }, 20),
      ] });
      f.native.pages.set("hidden-0", { hasMore: true, messages: [
        { type: "assistant", uuid: "older-0", message: { ...(usagePage === 0 ? usage : {}), content: "Older plan page text" } },
        plan,
      ] });
      for (let index = 0; index < 9; index += 1) {
        f.native.pages.set(`older-${index}`, usagePage === null && index === 0 ? { hasMore: true } : {
          hasMore: true,
          messages: [{
            type: "assistant", uuid: `older-${index + 1}`,
            message: { ...(usagePage === index + 1 ? usage : {}), content: `Older estimate page ${index + 1} text` },
          }],
        });
      }

      const controller = createControllerFixture({ broker: f.bridge, eventLog: f.eventLog });
      const response = await controller.handleRequest({
        kind: "request", requestId: "open", idempotencyKey: "open", method: "session.open", params: { sessionId: "local-native", limit: 20 },
      }, "mobile", "phone");
      expect(response).toMatchObject({ history: { hasMore: true, nextCursor: "hidden-0", items: [
        { id: "plan:plan", taskPlan: { items: [{ content: "Read", status: "completed" }] } },
      ] } });
      if (usagePage === 0 || usagePage === 8) {
        expect(response).toMatchObject({ session: { contextUsage: { totalTokens: 12_400, model, estimated: true } } });
      } else {
        expect(response).not.toHaveProperty("session.contextUsage");
      }
      expect(f.native.calls.filter(call => ["getTranscriptPage", "getContextUsage"].includes(call.method))).toEqual([
        { method: "getTranscriptPage", args: ["local-native", "", 20, { window: "accept" }] },
        { method: "getTranscriptPage", args: ["local-native", "hidden-0", 20, { window: "accept" }] },
        { method: "getContextUsage", args: ["local-native"] },
        ...Array.from({ length: reads }, (_, index) => ({ method: "getTranscriptPage", args: ["local-native", `older-${index}`, 100, { window: "accept" }] })),
      ]);
    } finally { await f.close(); }
  });

  it("prioritizes live getContextUsage and falls back to single-turn main-chain transcript usage across known, [1m], and unknown models", async () => {
    const f = await fixture();
    try {
      expect(f.bridge.session("local-native")?.contextUsage).toBeUndefined();

      f.native.sessions[0]!.model = "claude-opus-5-5";
      f.native.contextUsage = { totalTokens: 64_200, rawMaxTokens: 1_000_000, model: "claude-opus-5-5" };
      f.native.page = {
        messages: [{
          type: "assistant",
          uuid: "older-turn",
          message: { id: "msg_1", model: "claude-opus-5-5", content: "hi", usage: { input_tokens: 12_000, output_tokens: 400 } },
        }],
        hasMore: false,
      };
      const controller = createControllerFixture({ broker: f.bridge, eventLog: f.eventLog });
      const openedLive = await controller.handleRequest({
        kind: "request", requestId: "open-live", idempotencyKey: "open-live", method: "session.open", params: { sessionId: "local-native" },
      }, "mobile", "phone");
      expect(openedLive).toHaveProperty("session.contextUsage", {
        totalTokens: 64_200,
        maxTokens: 1_000_000,
        percentage: 6.4,
        model: "claude-opus-5-5",
        estimated: false,
      });

      // With the live plan settled and no live usage, find main-chain usage behind a full sidechain page.
      f.native.contextUsage = null;
      f.native.sessions[0]!.model = "claude-sonnet-4-5";
      f.native.sessions[0]!.turnRunning = true;
      await f.bridge.refreshRuntime();
      await f.message(planMessage("live-wrap", { recap: "Done" }, 20, "mcp__ccd_turn__wrap_up"));
      f.native.calls.length = 0;
      const trailingSidechains = Array.from({ length: 18 }, (_, index) => ({
        type: "assistant",
        uuid: `side-${index}`,
        isSidechain: true,
        message: { id: `sub_${index}`, model: "claude-haiku-4-5", content: "sub", usage: { input_tokens: 150_000, output_tokens: 1_000 } },
      }));
      f.native.pages.set("", { messages: trailingSidechains, hasMore: true });
      f.native.pages.set("side-0", {
        messages: [
          { type: "assistant", uuid: "main-1", message: { id: "m1", model: "claude-sonnet-4-5", content: "first", usage: { input_tokens: 18_000, output_tokens: 500 } } },
          { type: "assistant", uuid: "main-2", message: { id: "m2", model: "claude-sonnet-4-5", content: "second", usage: { input_tokens: 10_000, cache_read_input_tokens: 30_000, output_tokens: 800 } } },
        ],
        hasMore: false,
      });
      const openedEstimated = await controller.handleRequest({
        kind: "request", requestId: "open-estimated", idempotencyKey: "open-estimated", method: "session.open", params: { sessionId: "local-native" },
      }, "mobile", "phone");
      expect(f.native.calls.filter(call => ["getTranscriptPage", "getContextUsage"].includes(call.method))).toEqual([
        { method: "getTranscriptPage", args: ["local-native", "", 18, { window: "accept" }] },
        { method: "getContextUsage", args: ["local-native"] },
        { method: "getTranscriptPage", args: ["local-native", "side-0", 100, { window: "accept" }] },
      ]);
      expect(openedEstimated).toHaveProperty("session.contextUsage", {
        totalTokens: 40_800,
        maxTokens: 200_000,
        percentage: 20.4,
        model: "claude-sonnet-4-5",
        estimated: true,
      });

      // Explicit [1m] suffix upgrades capacity to 1,000,000; custom third-party model omits unknown capacity.
      f.native.codeModels = ["claude-sonnet-4-5[1m]", "antigravity/gemini-3-pro"];
      await f.bridge.configureSession({ sessionId: "local-native", model: "claude-sonnet-4-5[1m]" });
      expect(f.bridge.session("local-native")?.contextUsage).toMatchObject({
        totalTokens: 40_800,
        maxTokens: 1_000_000,
        percentage: 4.1,
      });

      await f.bridge.configureSession({ sessionId: "local-native", model: "antigravity/gemini-3-pro" });
      expect(f.bridge.session("local-native")?.contextUsage).toEqual({
        totalTokens: 40_800,
        model: "antigravity/gemini-3-pro",
        estimated: true,
      });
    } finally { await f.close(); }
  });

  it("retains a gateway window across assistant usage and history reloads, but changes it with the selected model", async () => {
    const f = await fixture();
    try {
      const model = "deepseek/deepseek[1m]";
      const alias = `mythos-magpie-${magpieModelIdHash("deepseek/deepseek")}[1m]`;
      const settings = { modelPicker: { options: [{ model, label: "DeepSeek" }] } };
      await writeFile(f.options.settingsPath, JSON.stringify(settings));
      f.native.sessions[0]!.model = alias;
      f.native.contextUsage = { totalTokens: 158_000, rawMaxTokens: 272_000, model: "deepseek" };
      await f.bridge.configuration("local-native");
      await f.bridge.history("local-native");
      expect(f.bridge.session("local-native")?.contextUsage?.maxTokens).toBe(272_000);

      const assistant = { type: "assistant", uuid: "next-context", message: { id: "next-context", model: "deepseek", content: "Next turn", usage: { input_tokens: 160_000, output_tokens: 100 } } };
      await f.message(assistant);
      expect(f.bridge.session("local-native")?.contextUsage).toMatchObject({ totalTokens: 160_100, maxTokens: 272_000, estimated: true });
      await f.message({ type: "result", modelUsage: { deepseek: { contextWindow: 272_000 } } });
      f.native.contextUsage = null;
      f.native.page = { messages: [assistant], hasMore: false };
      await f.bridge.history("local-native");
      expect(f.bridge.session("local-native")?.contextUsage).toMatchObject({ totalTokens: 160_100, maxTokens: 272_000 });
      await writeFile(f.options.settingsPath, JSON.stringify({ modelPicker: { options: [] } }));
      await f.bridge.refreshRuntime();
      expect(f.bridge.session("local-native")?.contextUsage?.maxTokens).toBe(272_000);
      await writeFile(f.options.settingsPath, JSON.stringify(settings));
      await f.bridge.refreshRuntime();
      expect(f.bridge.session("local-native")?.contextUsage?.maxTokens).toBe(272_000);

      f.native.sessions[0]!.model = "claude-sonnet-4-5";
      await f.bridge.refreshRuntime();
      expect(f.bridge.session("local-native")?.contextUsage?.maxTokens).toBe(200_000);
      f.native.contextUsage = { totalTokens: 160_100, rawMaxTokens: 196_000, model: "claude-sonnet-4-5" };
      await f.bridge.history("local-native");
      expect(f.bridge.session("local-native")?.contextUsage?.maxTokens).toBe(196_000);
      f.native.contextUsage = null;
      await f.bridge.configureSession({ sessionId: "local-native", model });
      expect(f.bridge.session("local-native")?.contextUsage?.maxTokens).toBe(272_000);
      f.native.sessions[0]!.model = "claude-sonnet-4-5";
      await f.bridge.refreshRuntime();
      expect(f.bridge.session("local-native")?.contextUsage?.maxTokens).toBe(196_000);
    } finally { await f.close(); }
  });

  it.each(["claude-sonnet-4-5", "deepseek/deepseek[1m]"])("does not attribute the running turn window to a model selected for the next turn (%s)", async nextModel => {
    const f = await fixture();
    try {
      const deepseek = "deepseek/deepseek[1m]";
      const sonnet = "claude-sonnet-4-5";
      const previousModel = nextModel === sonnet ? deepseek : sonnet;
      const previousUsageModel = previousModel === deepseek ? "deepseek" : sonnet;
      const previousWindow = previousModel === deepseek ? 272_000 : 200_000;
      await writeFile(f.options.settingsPath, JSON.stringify({ modelPicker: { options: [{ model: deepseek, label: "DeepSeek" }, { model: sonnet, label: "Sonnet" }] } }));
      f.native.sessions[0]!.model = `mythos-magpie-${magpieModelIdHash("deepseek/deepseek")}[1m]`;
      f.native.sessions[0]!.turnRunning = true;
      f.native.contextUsage = { totalTokens: 120_000, rawMaxTokens: 272_000, model: "deepseek" };
      await f.bridge.configuration("local-native");
      if (previousModel === sonnet) {
        await f.message({ type: "result", modelUsage: { deepseek: { contextWindow: 272_000 } } });
        f.native.sessions[0]!.turnRunning = false;
        f.native.contextUsage = null;
        await f.bridge.configureSession({ sessionId: "local-native", model: sonnet });
        f.native.sessions[0]!.turnRunning = true;
        f.native.contextUsage = { totalTokens: 120_000, rawMaxTokens: previousWindow, model: previousUsageModel };
        await f.bridge.configuration("local-native");
      }

      await f.bridge.configureSession({ sessionId: "local-native", model: nextModel });
      await f.bridge.configureSession({ sessionId: "local-native", model: previousModel });
      await f.bridge.configureSession({ sessionId: "local-native", model: nextModel });
      await f.message({ type: "stream_event", event: { type: "message_start", message: { id: "old-stream", model: previousUsageModel, usage: { input_tokens: 130_000 } } } });
      const oldAssistant = { type: "assistant", uuid: "old-turn", message: { id: "old-turn", model: previousUsageModel, usage: { input_tokens: 130_000, output_tokens: 100 } } };
      await f.message(oldAssistant);
      f.native.contextUsage = null;
      f.native.page = { messages: [oldAssistant], hasMore: false };
      await f.bridge.history("local-native");
      await f.message({ type: "stream_event", event: { type: "message_start", message: { id: "old-stream-tool-loop", model: previousUsageModel, usage: { input_tokens: 131_000 } } } });
      f.native.sessions[0]!.turnRunning = false;
      await f.bridge.refreshRuntime();
      await f.message({ type: "result", modelUsage: { [previousUsageModel]: { contextWindow: previousWindow } } });
      const usageModel = nextModel === deepseek ? "deepseek" : sonnet;
      const maxTokens = nextModel === deepseek ? 272_000 : 200_000;
      await f.message({ type: "assistant", uuid: "new-turn", message: { id: "new-turn", model: usageModel, usage: { input_tokens: 170_000 } } });
      expect(f.bridge.session("local-native")?.contextUsage).toMatchObject({ totalTokens: 170_000, maxTokens });
      await f.message({ type: "stream_event", event: { type: "message_start", message: { id: "new-stream", model: usageModel, usage: { input_tokens: 180_000 } } } });
      expect(f.bridge.session("local-native")?.contextUsage).toMatchObject({ totalTokens: 180_000, maxTokens });
    } finally { await f.close(); }
  });

  it("keeps a running turn's model when selection changes before its first usage sample", async () => {
    const f = await fixture();
    try {
      f.native.sessions[0]!.model = "claude-sonnet-4-5";
      f.native.sessions[0]!.turnRunning = true;
      await f.bridge.refreshRuntime();
      await f.bridge.configureSession({ sessionId: "local-native", model: "deepseek[1m]" });
      await f.message({ type: "assistant", uuid: "old-first-usage", message: { id: "old-first-usage", model: "claude-sonnet-4-5", usage: { input_tokens: 130_000 } } });
      await f.message({ type: "result", modelUsage: { "claude-sonnet-4-5": { contextWindow: 200_000 } } });
      await f.message({ type: "assistant", uuid: "new-first-usage", message: { id: "new-first-usage", model: "deepseek", usage: { input_tokens: 230_000 } } });
      expect(f.bridge.session("local-native")?.contextUsage).toMatchObject({ totalTokens: 230_000, maxTokens: 1_000_000, percentage: 23 });
    } finally { await f.close(); }
  });

  it("retains the model window when conversation rewind resets token usage", async () => {
    const f = await fixture();
    try {
      f.native.sessions[0]!.model = "deepseek[1m]";
      f.native.sessions[0]!.turnRunning = true;
      f.native.contextUsage = { totalTokens: 160_000, rawMaxTokens: 272_000, model: "deepseek" };
      await f.bridge.configuration("local-native");
      f.native.sessions[0]!.turnRunning = false;
      f.native.contextUsage = null;
      f.native.page = { messages: [{ type: "user", uuid: "rewind-user", message: { content: "Original prompt" } }], hasMore: false };
      await f.bridge.rewindSession("local-native", "rewind-user", "conversation");
      expect(f.bridge.session("local-native")?.contextUsage).toBeUndefined();
      await f.message({ type: "assistant", uuid: "after-rewind", message: { id: "after-rewind", model: "deepseek", usage: { input_tokens: 120_000 } } });
      expect(f.bridge.session("local-native")?.contextUsage).toMatchObject({ totalTokens: 120_000, maxTokens: 272_000 });
    } finally { await f.close(); }
  });

  it("tracks streaming growth, ignores sidechains, and updates or clears context usage across /compact and rewind", async () => {
    const f = await fixture();
    try {
      f.native.sessions[0]!.model = "claude-opus-5-5";
      await f.bridge.refreshRuntime();

      await f.message({
        type: "stream_event",
        event: {
          type: "message_start",
          message: { id: "msg_live", model: "claude-opus-5-5", usage: { input_tokens: 5_000, cache_read_input_tokens: 45_000, output_tokens: 20 } },
        },
      });
      expect(f.bridge.session("local-native")?.contextUsage).toMatchObject({ totalTokens: 50_020, maxTokens: 1_000_000, percentage: 5 });

      await f.message({
        type: "stream_event",
        event: { type: "message_delta", usage: { output_tokens: 480 } },
      });
      expect(f.bridge.session("local-native")?.contextUsage?.totalTokens).toBe(50_480);

      // Subagent sidechain stream_event and assistant messages must not overwrite main-chain context usage.
      await f.message({
        type: "assistant",
        uuid: "sub-msg",
        parent_tool_use_id: "toolu_sub",
        message: { id: "msg_sub", model: "claude-haiku-4-5", content: "subagent", usage: { input_tokens: 190_000, output_tokens: 2_000 } },
      });
      expect(f.bridge.session("local-native")?.contextUsage?.totalTokens).toBe(50_480);

      await f.message({
        type: "assistant",
        uuid: "main-msg",
        message: { id: "msg_live", model: "claude-opus-5-5", content: "done", usage: { input_tokens: 5_000, cache_read_input_tokens: 45_000, output_tokens: 500 } },
      });
      await f.message({
        type: "result",
        uuid: "res-1",
        modelUsage: {
          "claude-haiku-4-5": { contextWindow: 200_000 },
          "claude-opus-5-5": { contextWindow: 1_000_000 },
        },
      });
      expect(f.bridge.session("local-native")?.contextUsage).toEqual({
        totalTokens: 50_500,
        maxTokens: 1_000_000,
        percentage: 5.1,
        model: "claude-opus-5-5",
        estimated: false,
      });

      // /compact with postTokens adopts compacted token count and ignores preserved pre-compact assistant replay.
      await f.message({
        type: "system",
        subtype: "compact_boundary",
        uuid: "compact-1",
        compactMetadata: { preTokens: 50_500, postTokens: 9_200, preservedSegment: { headUuid: "u1", tailUuid: "main-msg" } },
      });
      expect(f.bridge.session("local-native")?.contextUsage).toMatchObject({ totalTokens: 9_200, maxTokens: 1_000_000, percentage: 0.9, estimated: true });

      await f.message({
        type: "assistant",
        uuid: "main-msg",
        message: { id: "msg_live", model: "claude-opus-5-5", content: "replayed", usage: { input_tokens: 50_000, output_tokens: 500 } },
      });
      expect(f.bridge.session("local-native")?.contextUsage?.totalTokens).toBe(9_200);

      // Rewind clears stale context even if post-rewind readback disconnects.
      f.native.page = {
        messages: [
          { type: "user", uuid: "rewind-user", message: { role: "user", content: "Initial prompt" } },
          { type: "assistant", uuid: "post-compact-reply", message: { id: "msg_after", model: "claude-opus-5-5", content: "Reply", usage: { input_tokens: 14_000, output_tokens: 300 } } },
        ],
        hasMore: false,
      };
      const originalCall = f.native.call.bind(f.native);
      vi.spyOn(f.native, "call").mockImplementation((method, args) => {
        if (method === "getSession" && f.native.calls.some(call => call.method === "rewindV2")) {
          return Promise.reject(new InspectorDisconnectedError("Disconnected after rewindV2"));
        }
        return originalCall(method, args);
      });
      await f.bridge.rewindSession("local-native", "rewind-user", "conversation");
      expect(f.bridge.session("local-native")?.contextUsage).toBeUndefined();
    } finally { await f.close(); }
  });
});
