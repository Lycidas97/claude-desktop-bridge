import { expect, it } from "vitest";
import {
  applyAssistantMessageContext,
  applyCompactBoundaryContext,
  applyLiveContextUsageState,
  applyResultModelUsageContext,
  applyStreamDeltaContext,
  applyStreamStartContext,
  buildTranscriptContextState,
  createNativeContextState,
  projectedContextUsage,
  type NativeContextState,
} from "./native-context-usage.js";
import { magpieModelIdHash } from "./claude-runtime-discovery.js";

it.each<[string, (state: NativeContextState) => void]>([
  ["assistant usage", state => applyAssistantMessageContext(state, { uuid: "next" }, { id: "next", model: "deepseek", usage: { input_tokens: 160_000, output_tokens: 100 } })],
  ["stream start", state => applyStreamStartContext(state, {}, { model: "deepseek", usage: { input_tokens: 160_000 } }, "next")],
  ["stream delta", state => {
    state.stream = { input: 160_000, cacheRead: 0, cacheCreation: 0, output: 0 };
    applyStreamDeltaContext(state, { output_tokens: 100 });
  }],
  ["compaction", state => applyCompactBoundaryContext(state, { compactMetadata: { postTokens: 20_000 } })],
  ["live usage without capacity", state => applyLiveContextUsageState(state, { totalTokens: 160_100, model: "deepseek" })],
])("keeps the observed context window after %s", (_name, update) => {
  const state = createNativeContextState();
  const models = [{ value: "deepseek", displayName: "DeepSeek", maxInputTokens: 1_000_000 }];
  applyLiveContextUsageState(state, { totalTokens: 158_000, rawMaxTokens: 272_000, model: "deepseek" });
  expect(projectedContextUsage(state, models, "deepseek")?.maxTokens).toBe(272_000);
  update(state);
  expect(projectedContextUsage(state, models, "deepseek")?.maxTokens).toBe(272_000);
});

it("retains a result window independently of estimated totals, including totals above capacity", () => {
  const state = createNativeContextState();
  applyAssistantMessageContext(state, {}, { id: "first", model: "deepseek", usage: { input_tokens: 158_000 } });
  applyResultModelUsageContext(state, { modelUsage: { deepseek: { contextWindow: 272_000 } } });
  expect(projectedContextUsage(state, undefined, "deepseek")?.maxTokens).toBe(272_000);
  applyAssistantMessageContext(state, {}, { id: "next", model: "deepseek", usage: { input_tokens: 280_000, output_tokens: 100 } });
  expect(projectedContextUsage(state, undefined, "deepseek")).toMatchObject({ totalTokens: 280_100, maxTokens: 272_000, percentage: 100, estimated: true });
});

it("accepts a first result window even when the estimated total already exceeds it", () => {
  const state = createNativeContextState();
  applyAssistantMessageContext(state, {}, { model: "deepseek", usage: { input_tokens: 280_000, output_tokens: 100 } });
  applyResultModelUsageContext(state, { modelUsage: { deepseek: { contextWindow: 272_000 } } });
  expect(projectedContextUsage(state, undefined, "deepseek")).toMatchObject({ totalTokens: 280_100, maxTokens: 272_000, percentage: 100 });
});

it("keeps observed windows per usage model in default sessions and separate from other sessions", () => {
  const state = createNativeContextState();
  const models = [{ value: "deepseek", displayName: "DeepSeek", maxInputTokens: 1_000_000 }];
  applyLiveContextUsageState(state, { totalTokens: 158_000, rawMaxTokens: 272_000, model: "deepseek" });
  expect(projectedContextUsage(state, models, "default")?.maxTokens).toBe(272_000);
  applyLiveContextUsageState(state, { totalTokens: 50_000, rawMaxTokens: 196_000, model: "claude-sonnet-4-5" });
  expect(projectedContextUsage(state, models, "default")?.maxTokens).toBe(196_000);
  applyLiveContextUsageState(state, { totalTokens: 160_000, model: "deepseek" });
  expect(projectedContextUsage(state, models, "default")?.maxTokens).toBe(272_000);
  applyLiveContextUsageState(state, { totalTokens: 51_000, model: "claude-sonnet-4-5" });
  expect(projectedContextUsage(state, models, "default")?.maxTokens).toBe(196_000);

  const other = createNativeContextState();
  applyLiveContextUsageState(other, { totalTokens: 160_000, model: "deepseek" });
  expect(projectedContextUsage(other, models, "default")?.maxTokens).toBe(1_000_000);
});

it.each<[string, "live" | "result"]>([["", "live"], ["[1m]", "live"], ["", "result"], ["[1m]", "result"]])("keeps native and canonical window identity when the picker changes (%s, %s)", (suffix, source) => {
  const state = createNativeContextState();
  const model = `deepseek/deepseek${suffix}`;
  const alias = `mythos-magpie-${magpieModelIdHash("deepseek/deepseek")}${suffix}`;
  const models = [{ value: model, displayName: "DeepSeek", maxInputTokens: 1_000_000 }];
  if (source === "live") {
    applyLiveContextUsageState(state, { totalTokens: 158_000, rawMaxTokens: 272_000, model: "deepseek" }, alias);
  } else {
    applyAssistantMessageContext(state, {}, { model: "deepseek", usage: { input_tokens: 158_000 } });
    applyResultModelUsageContext(state, { modelUsage: { deepseek: { contextWindow: 272_000 } } }, alias);
  }
  expect(projectedContextUsage(state, models, alias)?.maxTokens).toBe(272_000);
  expect(projectedContextUsage(state, [], alias)?.maxTokens).toBe(272_000);
  expect(projectedContextUsage(state, undefined, model)?.maxTokens).toBe(272_000);
  expect(projectedContextUsage(state, models, alias)?.maxTokens).toBe(272_000);
  expect(projectedContextUsage(state, [], `deepseek/deepseek${suffix ? "" : "[1m]"}`)?.maxTokens).not.toBe(272_000);
});

it.each<[string, (state: NativeContextState) => NativeContextState]>([
  ["assistant", state => {
    applyAssistantMessageContext(state, {}, { model: "claude-sonnet-4-5", usage: { input_tokens: 51_000 } });
    return state;
  }],
  ["stream start", state => {
    applyStreamStartContext(state, {}, { model: "claude-sonnet-4-5", usage: { input_tokens: 51_000 } }, "first-model");
    return state;
  }],
  ["live usage", state => {
    applyLiveContextUsageState(state, { totalTokens: 51_000, model: "claude-sonnet-4-5" });
    return state;
  }],
  ["history", state => buildTranscriptContextState([{ type: "assistant", uuid: "first-model", message: { model: "claude-sonnet-4-5", usage: { input_tokens: 51_000 } } }], state)],
])("binds a default window with no model to the first model learned from %s", (_source, update) => {
  const state = createNativeContextState();
  applyLiveContextUsageState(state, { totalTokens: 50_000, rawMaxTokens: 196_000 }, "default");
  expect(projectedContextUsage(state, undefined, "default")?.maxTokens).toBe(196_000);
  const updated = update(state);
  expect(projectedContextUsage(updated, undefined, "default")).toMatchObject({ totalTokens: 51_000, maxTokens: 196_000 });
  applyAssistantMessageContext(updated, {}, { model: "claude-haiku-4-5", usage: { input_tokens: 52_000 } });
  expect(projectedContextUsage(updated, undefined, "default")?.maxTokens).toBe(200_000);
  applyAssistantMessageContext(updated, {}, { model: "claude-sonnet-4-5", usage: { input_tokens: 53_000 } });
  expect(projectedContextUsage(updated, undefined, "default")?.maxTokens).toBe(196_000);
});
