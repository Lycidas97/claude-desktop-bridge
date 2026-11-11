import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { findClaudeTranscriptFile, isRecord } from "./transcript-dag.js";

export interface ClaudeSessionContextEstimate {
  totalTokens: number;
  model?: string;
}

export interface ClaudeContextEstimateScan {
  estimate?: ClaudeSessionContextEstimate;
  anchored: boolean;
}

function nonNegativeTokens(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export function scanClaudeContextFromMessages(messages: Iterable<unknown>): ClaudeContextEstimateScan {
  let latest: ClaudeSessionContextEstimate | undefined;
  let anchored = false;
  let generation = 0;
  const assistantGenerations = new Map<string, number>();
  const preservedUuids = new Set<string>();
  let currentMessageId: string | undefined;
  let currentUsage = { input: 0, cacheRead: 0, cacheCreation: 0, output: 0 };

  for (const value of messages) {
    if (!isRecord(value)) continue;
    if (value.isSidechain === true || (typeof value.parent_tool_use_id === "string" && value.parent_tool_use_id.length > 0)) {
      continue;
    }
    if (value.type === "system" && value.subtype === "compact_boundary") {
      const metadata = isRecord(value.compactMetadata) ? value.compactMetadata : value.compact_metadata;
      if (isRecord(metadata)) {
        const preserved = isRecord(metadata.preservedSegment) ? metadata.preservedSegment : metadata.preserved_segment;
        if (isRecord(preserved)) {
          for (const key of ["headUuid", "tailUuid", "head_uuid", "tail_uuid"] as const) {
            if (typeof preserved[key] === "string" && preserved[key]) preservedUuids.add(preserved[key]);
          }
        }
      }
      const postTokens = isRecord(metadata) ? metadata.postTokens ?? metadata.post_tokens : undefined;
      latest = typeof postTokens === "number" && Number.isFinite(postTokens) && postTokens > 0
        ? { totalTokens: Math.round(postTokens), ...(latest?.model ? { model: latest.model } : {}) }
        : undefined;
      anchored = true;
      generation += 1;
      currentMessageId = undefined;
      continue;
    }
    if (value.type !== "assistant" || value.isSynthetic === true || !isRecord(value.message)) continue;
    if (value.message.model === "<synthetic>") continue;
    // Resume can re-emit preserved messages with their pre-compact usage.
    if (typeof value.uuid === "string" && value.uuid) {
      if (preservedUuids.has(value.uuid) || (assistantGenerations.get(value.uuid) ?? generation) < generation) continue;
      assistantGenerations.set(value.uuid, generation);
    }
    const usage = value.message.usage;
    if (!isRecord(usage)) continue;
    const input = nonNegativeTokens(usage.input_tokens);
    const cacheRead = nonNegativeTokens(usage.cache_read_input_tokens);
    const cacheCreation = nonNegativeTokens(usage.cache_creation_input_tokens);
    const output = nonNegativeTokens(usage.output_tokens);
    const messageId = typeof value.message.id === "string" && value.message.id ? value.message.id : undefined;
    if (messageId && messageId === currentMessageId) {
      currentUsage = {
        input: Math.max(currentUsage.input, input),
        cacheRead: Math.max(currentUsage.cacheRead, cacheRead),
        cacheCreation: Math.max(currentUsage.cacheCreation, cacheCreation),
        output: Math.max(currentUsage.output, output),
      };
    } else {
      if (input + cacheRead + cacheCreation <= 0) continue;
      currentMessageId = messageId;
      currentUsage = { input, cacheRead, cacheCreation, output };
    }
    const promptTokens = currentUsage.input + currentUsage.cacheRead + currentUsage.cacheCreation;
    if (promptTokens <= 0) continue;
    const totalTokens = Math.round(promptTokens + currentUsage.output);
    const model = typeof value.message.model === "string" && value.message.model.trim()
      ? value.message.model.trim()
      : latest?.model;
    latest = {
      totalTokens,
      ...(model ? { model } : {}),
    };
    anchored = true;
  }
  return { ...(latest ? { estimate: latest } : {}), anchored };
}

export function estimateClaudeContextFromMessages(messages: Iterable<unknown>): ClaudeSessionContextEstimate | undefined {
  return scanClaudeContextFromMessages(messages).estimate;
}

export async function readClaudeSessionContextEstimate(
  projectsRoot: string,
  sessionId: string,
  cwd?: string,
): Promise<ClaudeSessionContextEstimate | undefined> {
  const path = await findClaudeTranscriptFile(projectsRoot, sessionId, cwd);
  if (!path) return undefined;
  const entries: unknown[] = [];
  try {
    const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of lines) {
      try {
        entries.push(JSON.parse(line) as unknown);
      } catch {
        continue;
      }
    }
  } catch {
    return undefined;
  }
  return estimateClaudeContextFromMessages(entries);
}
