import type { BridgeModelInfo, BridgeSessionContextUsage } from "@bridge/protocol";
import { scanClaudeContextFromMessages } from "../transcript/claude-history.js";
import { parseMagpieSyntheticModelId } from "./claude-runtime-discovery.js";
import { modelOptionHash, savedModelOption } from "./native-model-catalog.js";

export interface NativeContextState {
  totalTokens: number;
  maxTokensByModel: Map<string, number>;
  turnModel?: string;
  model?: string;
  liveUsageSample?: symbol;
  estimated: boolean;
  hydrated: boolean;
  seenAssistantUuids: Set<string>;
  preCompactUuids: Set<string>;
  lastMessageId?: string;
  lastMessageUsage?: { input: number; cacheRead: number; cacheCreation: number; output: number };
  stream?: { messageId?: string; input: number; cacheRead: number; cacheCreation: number; output: number; model?: string };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function nonNegativeTokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export function realUsageModel(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() && value.trim() !== "<synthetic>" ? value.trim() : undefined;
}

export function knownClaudeModelWindow(rawModel: string): number | undefined {
  const trimmed = rawModel.trim();
  if (!trimmed) return undefined;
  if (/\[1m\]$/iu.test(trimmed)) return 1_000_000;
  const slashIndex = trimmed.indexOf("/");
  let id = trimmed;
  if (slashIndex >= 0) {
    const provider = trimmed.slice(0, slashIndex).toLowerCase();
    if (provider !== "claude" && provider !== "anthropic") return undefined;
    id = trimmed.slice(slashIndex + 1);
  }
  id = id.toLowerCase()
    .replace(/^(?:us|eu|apac|au|global)\.anthropic\./u, "")
    .replace(/-v\d+:\d+$/u, "")
    .replace(/-(?:20\d{6}|latest)$/u, "");
  if (/^claude-(?:opus-(?:4-[678]|5(?:-5)?)|sonnet-(?:4-6|5(?:-5)?)|fable-5(?:-[12])?|haiku-5-5)$/u.test(id)) {
    return 1_000_000;
  }
  if (/^claude-(?:haiku-4-5|opus-4(?:-[015])?|sonnet-4(?:-[05])?|3-[57]-(?:sonnet|haiku)|3-(?:opus|sonnet|haiku))$/u.test(id)) {
    return 200_000;
  }
  return undefined;
}

// Rebuild nested records: old pages must not keep content or extra Native fields alive.
export function projectContextMessages(messages: readonly unknown[]): unknown[] {
  const fields = (value: unknown, names: string[]): Record<string, unknown> | undefined => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    return Object.fromEntries(names.flatMap(name => {
      const field = (value as Record<string, unknown>)[name];
      return ["string", "number", "boolean"].includes(typeof field) ? [[name, field]] : [];
    }));
  };
  const metadata = (value: unknown): Record<string, unknown> | undefined => {
    const projected = fields(value, ["postTokens", "post_tokens"]);
    if (!projected) return undefined;
    for (const name of ["preservedSegment", "preserved_segment"]) {
      const segment = fields(record(value)[name], ["headUuid", "tailUuid", "head_uuid", "tail_uuid"]);
      if (segment) projected[name] = segment;
    }
    return projected;
  };
  return messages.map(raw => {
    const entry = record(raw);
    const projected = fields(entry, ["type", "subtype", "uuid", "isSidechain", "parent_tool_use_id", "isSynthetic"])!;
    const message = fields(entry.message, ["id", "model"]);
    if (message) {
      const usage = fields(record(entry.message).usage, ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "output_tokens"]);
      if (usage) message.usage = usage;
      projected.message = message;
    }
    for (const name of ["compactMetadata", "compact_metadata"]) {
      const compact = metadata(entry[name]);
      if (compact) projected[name] = compact;
    }
    return projected;
  });
}

export function createNativeContextState(maxTokensByModel = new Map<string, number>()): NativeContextState {
  return {
    totalTokens: 0,
    maxTokensByModel,
    estimated: true,
    hydrated: false,
    seenAssistantUuids: new Set<string>(),
    preCompactUuids: new Set<string>(),
  };
}

export function resolveContextMaxTokens(
  models: BridgeModelInfo[] | undefined,
  sessionModel?: string,
  usageModel?: string,
): number | undefined {
  const fromCandidate = (candidate: string | undefined): number | undefined => {
    if (!candidate) return undefined;
    const saved = savedModelOption(models, candidate);
    if (saved?.maxInputTokens && saved.maxInputTokens > 0) return saved.maxInputTokens;
    return (saved ? knownClaudeModelWindow(saved.value) : undefined) ?? knownClaudeModelWindow(candidate);
  };
  const trimmed = sessionModel?.trim();
  if (!trimmed || trimmed.toLowerCase() === "default") return fromCandidate(usageModel);
  if (["opus", "sonnet", "haiku", "fable"].includes(trimmed.toLowerCase())) {
    return fromCandidate(usageModel) ?? 1_000_000;
  }
  const saved = savedModelOption(models, trimmed);
  if (saved) {
    if (saved.maxInputTokens && saved.maxInputTokens > 0) return saved.maxInputTokens;
    return knownClaudeModelWindow(saved.value) ?? knownClaudeModelWindow(trimmed);
  }
  if (parseMagpieSyntheticModelId(trimmed)) {
    return knownClaudeModelWindow(trimmed) ?? fromCandidate(usageModel);
  }
  return knownClaudeModelWindow(trimmed);
}

function contextWindowModel(sessionModel?: string, usageModel?: string): string {
  const selected = sessionModel?.trim();
  const model = selected && selected.toLowerCase() !== "default" ? selected : usageModel;
  return model ? `${modelOptionHash(model)}${/\[1m\]$/iu.test(model) ? "[1m]" : ""}` : "";
}

function updateContextModel(state: NativeContextState, model: string | undefined): void {
  if (!model) return;
  const maxTokens = !state.model ? state.maxTokensByModel.get("") : undefined;
  if (maxTokens !== undefined) {
    state.maxTokensByModel.set(contextWindowModel(undefined, model), maxTokens);
    state.maxTokensByModel.delete("");
  }
  state.model = model;
}

export function hydrateObservedContextModel(state: NativeContextState, model: string | undefined): void {
  if (!state.model) updateContextModel(state, realUsageModel(model));
}

export function extractLatestTranscriptModel(messages: readonly unknown[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const entry = record(messages[index]);
    if (entry.type !== "assistant" || entry.isSidechain === true || entry.parent_tool_use_id || entry.isSynthetic === true) {
      continue;
    }
    const model = realUsageModel(record(entry.message).model);
    if (model && model.toLowerCase() !== "default") return model;
  }
  return undefined;
}

export function projectedContextUsage(
  state: NativeContextState | undefined,
  models: BridgeModelInfo[] | undefined,
  sessionModel?: string,
): BridgeSessionContextUsage | undefined {
  if (!state || state.totalTokens <= 0) return undefined;
  const observedMaxTokens = state.maxTokensByModel.get(contextWindowModel(sessionModel, state.model));
  let maxTokens = observedMaxTokens ?? resolveContextMaxTokens(models, sessionModel, state.model);
  if (observedMaxTokens === undefined && state.estimated && maxTokens !== undefined && maxTokens < state.totalTokens) maxTokens = undefined;
  const percentage = maxTokens && maxTokens > 0
    ? Math.min(100, Math.max(0, Math.round((state.totalTokens / maxTokens) * 1000) / 10))
    : undefined;
  const model = (sessionModel ? savedModelOption(models, sessionModel)?.value ?? sessionModel : undefined) ?? state.model;
  return {
    totalTokens: state.totalTokens,
    ...(maxTokens !== undefined ? { maxTokens, percentage: percentage! } : {}),
    ...(model ? { model } : {}),
    estimated: state.estimated,
  };
}

export function parseLiveContextUsage(rawValue: unknown): { totalTokens: number; rawMaxTokens?: number; model?: string } | undefined {
  const raw = record(rawValue);
  const totalTokens = nonNegativeTokenCount(raw.totalTokens);
  if (totalTokens <= 0) return undefined;
  const rawMax = [raw.rawMaxTokens, raw.maxTokens]
    .find((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
  const model = realUsageModel(raw.model);
  return {
    totalTokens: Math.round(totalTokens),
    ...(rawMax ? { rawMaxTokens: Math.round(rawMax) } : {}),
    ...(model ? { model } : {}),
  };
}

export function applyLiveContextUsageState(
  state: NativeContextState,
  live: { totalTokens: number; rawMaxTokens?: number; model?: string },
  sessionModel?: string,
): void {
  state.totalTokens = live.totalTokens;
  updateContextModel(state, live.model);
  if (live.rawMaxTokens) state.maxTokensByModel.set(contextWindowModel(sessionModel, state.model), live.rawMaxTokens);
  state.liveUsageSample = Symbol();
  state.estimated = false;
  state.hydrated = true;
  delete state.stream;
}

export function buildTranscriptContextState(messages: readonly unknown[], previous?: NativeContextState): NativeContextState {
  const scan = scanClaudeContextFromMessages(messages);
  const seenAssistantUuids = new Set<string>();
  const preCompactUuids = new Set<string>();
  for (const raw of messages) {
    const entry = record(raw);
    if (entry.isSidechain === true || entry.parent_tool_use_id) continue;
    if (entry.type === "assistant" && typeof entry.uuid === "string" && entry.uuid) seenAssistantUuids.add(entry.uuid);
    if (entry.type === "system" && entry.subtype === "compact_boundary") {
      for (const id of seenAssistantUuids) preCompactUuids.add(id);
      const meta = record(entry.compactMetadata ?? entry.compact_metadata);
      const preserved = record(meta.preservedSegment ?? meta.preserved_segment);
      for (const key of ["headUuid", "tailUuid", "head_uuid", "tail_uuid"] as const) {
        if (typeof preserved[key] === "string" && preserved[key]) preCompactUuids.add(preserved[key]);
      }
    }
  }
  const state: NativeContextState = {
    totalTokens: scan.estimate?.totalTokens ?? 0,
    maxTokensByModel: previous?.maxTokensByModel ?? new Map(),
    ...(previous?.turnModel !== undefined ? { turnModel: previous.turnModel } : {}),
    ...(previous?.liveUsageSample !== undefined ? { liveUsageSample: previous.liveUsageSample } : {}),
    estimated: true,
    hydrated: true,
    seenAssistantUuids,
    preCompactUuids,
  };
  updateContextModel(state, scan.estimate?.model);
  return state;
}

export function applyStreamStartContext(
  state: NativeContextState,
  message: Record<string, unknown>,
  streamMessage: Record<string, unknown>,
  id: unknown,
): void {
  if (message.isSynthetic === true || streamMessage.model === "<synthetic>" || typeof streamMessage.usage !== "object" || streamMessage.usage === null || Array.isArray(streamMessage.usage)) {
    return;
  }
  const usage = record(streamMessage.usage);
  const input = nonNegativeTokenCount(usage.input_tokens);
  const cacheRead = nonNegativeTokenCount(usage.cache_read_input_tokens);
  const cacheCreation = nonNegativeTokenCount(usage.cache_creation_input_tokens);
  const output = nonNegativeTokenCount(usage.output_tokens);
  const model = realUsageModel(streamMessage.model);
  state.stream = { ...(typeof id === "string" ? { messageId: id } : {}), input, cacheRead, cacheCreation, output, ...(model ? { model } : {}) };
  if (input + cacheRead + cacheCreation > 0) {
    state.totalTokens = Math.round(input + cacheRead + cacheCreation + output);
    state.estimated = true;
    state.hydrated = true;
    updateContextModel(state, model);
  }
}

export function applyStreamDeltaContext(
  state: NativeContextState,
  streamUsage: Record<string, unknown>,
): void {
  const prev = state.stream ?? { input: 0, cacheRead: 0, cacheCreation: 0, output: 0 };
  const next = {
    ...prev,
    input: Math.max(prev.input, nonNegativeTokenCount(streamUsage.input_tokens)),
    cacheRead: Math.max(prev.cacheRead, nonNegativeTokenCount(streamUsage.cache_read_input_tokens)),
    cacheCreation: Math.max(prev.cacheCreation, nonNegativeTokenCount(streamUsage.cache_creation_input_tokens)),
    output: Math.max(prev.output, nonNegativeTokenCount(streamUsage.output_tokens)),
  };
  state.stream = next;
  const promptTokens = next.input + next.cacheRead + next.cacheCreation;
  if (promptTokens > 0) {
    state.totalTokens = Math.round(promptTokens + next.output);
    state.estimated = true;
    state.hydrated = true;
  }
}

export function applyCompactBoundaryContext(
  state: NativeContextState,
  message: Record<string, unknown>,
): void {
  for (const id of state.seenAssistantUuids) state.preCompactUuids.add(id);
  const meta = record(message.compactMetadata ?? message.compact_metadata);
  const preserved = record(meta.preservedSegment ?? meta.preserved_segment);
  for (const key of ["headUuid", "tailUuid", "head_uuid", "tail_uuid"] as const) {
    if (typeof preserved[key] === "string" && preserved[key]) state.preCompactUuids.add(preserved[key]);
  }
  const postTokens = nonNegativeTokenCount(meta.postTokens ?? meta.post_tokens);
  state.totalTokens = postTokens > 0 ? Math.round(postTokens) : 0;
  state.estimated = true;
  state.hydrated = true;
  delete state.stream;
  delete state.lastMessageId;
  delete state.lastMessageUsage;
}

export function applyAssistantMessageContext(
  state: NativeContextState,
  message: Record<string, unknown>,
  body: Record<string, unknown>,
): void {
  const uuid = typeof message.uuid === "string" && message.uuid ? message.uuid : undefined;
  if (uuid && state.preCompactUuids.has(uuid)) return;
  if (uuid) state.seenAssistantUuids.add(uuid);
  if (typeof body.usage !== "object" || body.usage === null || Array.isArray(body.usage)) return;
  const usage = record(body.usage);
  const input = nonNegativeTokenCount(usage.input_tokens);
  const cacheRead = nonNegativeTokenCount(usage.cache_read_input_tokens);
  const cacheCreation = nonNegativeTokenCount(usage.cache_creation_input_tokens);
  const output = nonNegativeTokenCount(usage.output_tokens);
  const messageId = typeof body.id === "string" && body.id ? body.id : undefined;
  const merged = messageId && messageId === state.lastMessageId && state.lastMessageUsage
    ? {
        input: Math.max(state.lastMessageUsage.input, input),
        cacheRead: Math.max(state.lastMessageUsage.cacheRead, cacheRead),
        cacheCreation: Math.max(state.lastMessageUsage.cacheCreation, cacheCreation),
        output: Math.max(state.lastMessageUsage.output, output),
      }
    : input + cacheRead + cacheCreation > 0
      ? { input, cacheRead, cacheCreation, output }
      : undefined;
  if (!merged) return;
  if (messageId) state.lastMessageId = messageId;
  else delete state.lastMessageId;
  state.lastMessageUsage = merged;
  state.totalTokens = Math.round(merged.input + merged.cacheRead + merged.cacheCreation + merged.output);
  state.estimated = true;
  state.hydrated = true;
  delete state.stream;
  const model = realUsageModel(body.model);
  updateContextModel(state, model);
}

export function applyResultModelUsageContext(
  state: NativeContextState | undefined,
  message: Record<string, unknown>,
  sessionModel?: string,
): void {
  if (!state || state.totalTokens <= 0) return;
  const modelUsage = record(message.modelUsage ?? message.model_usage);
  const entry = state.model ? record(modelUsage[state.model]) : undefined;
  const contextWindow = nonNegativeTokenCount(entry?.contextWindow ?? entry?.context_window);
  if (contextWindow > 0) {
    state.maxTokensByModel.set(contextWindowModel(sessionModel, state.model), Math.round(contextWindow));
    state.estimated = false;
  }
}
