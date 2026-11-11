import { access, readdir } from "node:fs/promises";
import { join } from "node:path";

const SAFE_SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/u;

export interface TranscriptTurnNode {
  index: number;
  uuid: string;
  parentUuid?: string;
  type?: "user" | "assistant";
  stopReason?: string;
  interruptedBoundary?: boolean;
  nonTurnUser?: boolean;
}

export interface ClaudeForkBoundary {
  parentSessionId: string;
  parentNativeSessionId: string;
  parentDesktopSessionId: string;
  baseMessageUuid: string | null;
  reason: "before-active-turn" | "completed-head" | "empty";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function textFromContent(content: unknown): string {
  const blocks = Array.isArray(content) ? content : [content];
  const parts: string[] = [];
  for (const block of blocks) {
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block.type === "image") parts.push("[图片]");
    else if (block.type === "document") parts.push("[附件]");
  }
  return parts.map((part) => part.trim()).filter(Boolean).join("\n\n");
}

export function toolUses(content: unknown): Array<{ id: string; name: string; input: unknown }> {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    if (
      !isRecord(block) ||
      block.type !== "tool_use" ||
      typeof block.id !== "string" ||
      typeof block.name !== "string"
    ) return [];
    return [{ id: block.id, name: block.name, input: block.input }];
  });
}

export function isLocalCommandRecord(text: string): boolean {
  const trimmed = text.trim();
  return /^<(?:local-command-caveat|local-command-stdout|local-command-stderr|command-name|command-message)\b/u.test(trimmed);
}

export function isNonTurnUserRecord(value: Record<string, unknown>, rawText: string): boolean {
  return (
    value.isMeta === true ||
    value.isCompactSummary === true ||
    isLocalCommandRecord(rawText)
  );
}

export function resolveTranscriptParentUuid<T extends { uuid: string; parentUuid?: string }>(
  value: Record<string, unknown>,
  nodes: ReadonlyMap<string, T>,
  lastMainUuid?: string,
): string | undefined {
  if (typeof value.parentUuid === "string" && value.parentUuid && nodes.has(value.parentUuid)) {
    return value.parentUuid;
  }
  if (
    typeof value.logicalParentUuid === "string" &&
    value.logicalParentUuid &&
    nodes.has(value.logicalParentUuid)
  ) {
    return value.logicalParentUuid;
  }
  const compactMetadata = isRecord(value.compactMetadata) ? value.compactMetadata : undefined;
  if (compactMetadata) {
    const preservedSegment = isRecord(compactMetadata.preservedSegment)
      ? compactMetadata.preservedSegment
      : undefined;
    if (
      preservedSegment &&
      typeof preservedSegment.tailUuid === "string" &&
      nodes.has(preservedSegment.tailUuid)
    ) {
      return preservedSegment.tailUuid;
    }
    if (
      preservedSegment &&
      typeof preservedSegment.headUuid === "string" &&
      nodes.has(preservedSegment.headUuid)
    ) {
      return preservedSegment.headUuid;
    }
    const preservedMessages = isRecord(compactMetadata.preservedMessages)
      ? compactMetadata.preservedMessages
      : undefined;
    const allUuids = preservedMessages && Array.isArray(preservedMessages.allUuids)
      ? preservedMessages.allUuids
      : [];
    for (let index = allUuids.length - 1; index >= 0; index -= 1) {
      const candidate = allUuids[index];
      if (typeof candidate === "string" && nodes.has(candidate)) return candidate;
    }
    const uuids = preservedMessages && Array.isArray(preservedMessages.uuids)
      ? preservedMessages.uuids
      : [];
    for (let index = uuids.length - 1; index >= 0; index -= 1) {
      const candidate = uuids[index];
      if (typeof candidate === "string" && nodes.has(candidate)) return candidate;
    }
  }
  if (value.subtype === "compact_boundary" && lastMainUuid && nodes.has(lastMainUuid)) {
    return lastMainUuid;
  }
  if (typeof value.parentUuid === "string" && value.parentUuid) return value.parentUuid;
  if (typeof value.logicalParentUuid === "string" && value.logicalParentUuid) {
    return value.logicalParentUuid;
  }
  // Older transcripts omit parentUuid entirely; explicit null still starts a root.
  return !("parentUuid" in value) && !("logicalParentUuid" in value) ? lastMainUuid : undefined;
}

export function isNonDagTranscriptRecord(value: Record<string, unknown>): boolean {
  return (
    value.type === "custom-title" ||
    value.type === "agent-name" ||
    value.type === "mode" ||
    value.type === "atis-latch" ||
    value.type === "last-prompt" ||
    value.type === "cost-state" ||
    value.type === "queue-operation"
  );
}

export function transcriptTurnBoundary<T extends TranscriptTurnNode>(
  nodes: ReadonlyMap<string, T>,
  terminal: T,
): boolean {
  let current: T | undefined = terminal;
  const seen = new Set<string>();
  while (current && !seen.has(current.uuid)) {
    seen.add(current.uuid);
    if (current.type === "user") {
      if (current.interruptedBoundary === true) return true;
      if (current.nonTurnUser === true) {
        current = current.parentUuid ? nodes.get(current.parentUuid) : undefined;
        continue;
      }
      return false;
    }
    if (current.type === "assistant") {
      return [
        "end_turn",
        "max_tokens",
        "stop_sequence",
        "refusal",
        "model_context_window_exceeded",
      ].includes(current.stopReason ?? "");
    }
    current = current.parentUuid ? nodes.get(current.parentUuid) : undefined;
  }
  return nodes.size > 0;
}

function projectDirectoryName(cwd: string): string {
  return cwd.replace(/[:\\/]/gu, "-");
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

const transcriptFilePathCache = new Map<string, string>();

export async function findClaudeTranscriptFile(
  projectsRoot: string,
  sessionId: string,
  cwd?: string,
): Promise<string | undefined> {
  if (!SAFE_SESSION_ID.test(sessionId)) return undefined;
  const cacheKey = `${projectsRoot}\0${sessionId}`;
  const cachedPath = transcriptFilePathCache.get(cacheKey);
  if (cachedPath && await exists(cachedPath)) return cachedPath;

  const filename = `${sessionId}.jsonl`;
  const directCandidates = [
    join(projectsRoot, filename),
    ...(cwd ? [join(projectsRoot, projectDirectoryName(cwd), filename)] : []),
  ];
  for (const candidate of directCandidates) {
    if (await exists(candidate)) {
      transcriptFilePathCache.set(cacheKey, candidate);
      return candidate;
    }
  }

  let directories;
  try {
    directories = (await readdir(projectsRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  } catch {
    return undefined;
  }
  for (let offset = 0; offset < directories.length; offset += 40) {
    const candidates = directories.slice(offset, offset + 40).map((entry) => join(projectsRoot, entry.name, filename));
    const matches = await Promise.all(candidates.map(async (candidate) => await exists(candidate) ? candidate : undefined));
    const match = matches.find((candidate): candidate is string => candidate !== undefined);
    if (match) {
      transcriptFilePathCache.set(cacheKey, match);
      return match;
    }
  }
  return undefined;
}
