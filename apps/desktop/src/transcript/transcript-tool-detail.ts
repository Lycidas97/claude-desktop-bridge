import { createReadStream } from "node:fs";
import { diagnostics } from "../app/diag.js";
import { createInterface } from "node:readline";
import {
  TOOL_DETAIL_MAX_BYTES,
  type BridgeToolCallDetail,
  type BridgeToolResultOmittedBlock,
} from "@bridge/protocol";
import { redactEvidenceText } from "../evidence/evidence-manager.js";
import { isRecord } from "./transcript-dag.js";
import { collectSubagentJsonlFiles, subagentsDirectoryForTranscript } from "./transcript-subagents.js";

const HIDDEN_NATIVE_TOOLS = new Set(["mcp__ccd_turn__update_plan", "mcp__ccd_turn__wrap_up"]);

function singleLine(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 1)}…`;
}

export function summarizeNativeToolInput(toolName: string, input: unknown): string {
  if (!isRecord(input)) return "";
  if (toolName === "Bash") {
    const desc = typeof input.description === "string" ? singleLine(input.description, 80) : "";
    const cmd = typeof input.command === "string" ? singleLine(redactEvidenceText(input.command), 100) : "";
    if (desc && cmd) return `${desc} · ${cmd}`;
    return desc || cmd;
  }
  if (typeof input.file_path === "string" && input.file_path.trim()) {
    return singleLine(input.file_path, 160);
  }
  if (typeof input.pattern === "string" && input.pattern.trim()) {
    const pattern = singleLine(input.pattern, 80);
    if (typeof input.path === "string" && input.path.trim()) {
      return `${pattern} · ${singleLine(input.path, 80)}`;
    }
    return pattern;
  }
  if (typeof input.path === "string" && input.path.trim()) {
    return singleLine(input.path, 160);
  }
  if (typeof input.url === "string" && input.url.trim()) {
    return singleLine(redactEvidenceText(input.url), 140);
  }
  if (typeof input.query === "string" && input.query.trim()) {
    return singleLine(input.query, 120);
  }
  if (Object.keys(input).length === 0) return "";
  return singleLine(redactEvidenceText(JSON.stringify(input)), 160);
}

export function truncateUtf8(
  value: string,
  maxBytes: number,
): { text: string; totalBytes: number; truncated: boolean } {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) {
    return { text: value, totalBytes: bytes.byteLength, truncated: false };
  }
  if (maxBytes <= 0) {
    return { text: "", totalBytes: bytes.byteLength, truncated: true };
  }
  let cut = maxBytes;
  let lead = cut - 1;
  while (lead >= 0 && cut - lead <= 3 && (bytes[lead]! & 0b1100_0000) === 0b1000_0000) {
    lead -= 1;
  }
  if (lead >= 0) {
    const first = bytes[lead]!;
    const sequenceLength = first >= 0xf0 ? 4 : first >= 0xe0 ? 3 : first >= 0xc0 ? 2 : 1;
    if (lead + sequenceLength > cut) {
      cut = lead;
    }
  }
  return {
    text: bytes.subarray(0, cut).toString("utf8"),
    totalBytes: bytes.byteLength,
    truncated: true,
  };
}

function redactInputValue(value: unknown): unknown {
  if (typeof value === "string") return redactEvidenceText(value);
  if (Array.isArray(value)) return value.map(redactInputValue);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      // Check field names against the shared policy without exposing part of a credential value.
      const field = `${key}: value`;
      out[key] = redactEvidenceText(field) === field ? redactInputValue(entry) : "[已隐藏]";
    }
    return out;
  }
  return value;
}

function formatBoundedInput(
  rawInput: Record<string, unknown>,
  maxBytes: number,
): Pick<BridgeToolCallDetail, "input" | "inputText" | "inputTruncated"> {
  const redacted = redactInputValue(rawInput) as Record<string, unknown>;
  const serialized = JSON.stringify(redacted, null, 2);
  const check = truncateUtf8(serialized, maxBytes);
  if (!check.truncated) {
    return { input: redacted };
  }
  return {
    input: {},
    inputText: check.text,
    inputTruncated: true,
  };
}

function parseToolResultContent(content: unknown): {
  text: string;
  omittedBlocks: BridgeToolResultOmittedBlock[];
} {
  if (typeof content === "string") {
    return { text: content, omittedBlocks: [] };
  }
  if (Array.isArray(content)) {
    const textParts: string[] = [];
    const omitted = new Map<string, BridgeToolResultOmittedBlock>();
    for (const item of content) {
      if (typeof item === "string") {
        textParts.push(item);
        continue;
      }
      if (!isRecord(item)) continue;
      const blockType = typeof item.type === "string" && item.type ? item.type : "unknown";
      if (blockType === "thinking") continue;
      if (blockType === "text" && typeof item.text === "string") {
        textParts.push(item.text);
        continue;
      }
      const source = isRecord(item.source) ? item.source : undefined;
      const mimeType = typeof source?.media_type === "string"
        ? source.media_type
        : typeof item.media_type === "string"
          ? item.media_type
          : undefined;
      const key = `${blockType}\0${mimeType ?? ""}`;
      const existing = omitted.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        omitted.set(key, { type: blockType, ...(mimeType ? { mimeType } : {}), count: 1 });
      }
    }
    return { text: textParts.join("\n"), omittedBlocks: [...omitted.values()] };
  }
  if (isRecord(content)) {
    return { text: JSON.stringify(content, null, 2), omittedBlocks: [] };
  }
  return { text: "", omittedBlocks: [] };
}

export function extractToolCallDetailFromMessages(params: {
  sessionId: string;
  toolUseId: string;
  agentId?: string;
  messages: unknown[];
  maxBytes?: number;
}): BridgeToolCallDetail | undefined {
  const { sessionId, toolUseId, agentId, messages, maxBytes = TOOL_DETAIL_MAX_BYTES } = params;
  let toolName: string | undefined;
  let rawInput: Record<string, unknown> = {};
  let resultBlock: Record<string, unknown> | undefined;
  let backgroundTaskId: string | undefined;
  const notifications: unknown[] = [];
  const systemNotifications: Record<string, unknown>[] = [];

  for (const raw of messages) {
    if (!isRecord(raw)) continue;
    if (!agentId) {
      if (raw.isSidechain === true) continue;
      if (raw.parent_tool_use_id && (raw.type === "assistant" || raw.type === "user")) continue;
    }
    if (raw.type === "system" && raw.subtype === "task_notification") systemNotifications.push(raw);
    const body = isRecord(raw.message) ? raw.message : undefined;
    if (raw.type === "user") notifications.push(body?.content);
    else if (raw.type === "attachment" && isRecord(raw.attachment) && raw.attachment.type === "queued_command") {
      notifications.push(raw.attachment.prompt);
    }
    if (!body || !Array.isArray(body.content)) continue;
    for (const rawBlock of body.content) {
      if (!isRecord(rawBlock)) continue;
      if (
        rawBlock.type === "tool_use" &&
        rawBlock.id === toolUseId &&
        typeof rawBlock.name === "string" &&
        !HIDDEN_NATIVE_TOOLS.has(rawBlock.name)
      ) {
        toolName = rawBlock.name;
        rawInput = isRecord(rawBlock.input) ? rawBlock.input : {};
      } else if (rawBlock.type === "tool_result" && rawBlock.tool_use_id === toolUseId) {
        resultBlock = rawBlock;
        backgroundTaskId = isRecord(raw.toolUseResult) && typeof raw.toolUseResult.backgroundTaskId === "string"
          ? raw.toolUseResult.backgroundTaskId : undefined;
      }
    }
  }

  if (!toolName) return undefined;
  const formattedInput = formatBoundedInput(rawInput, maxBytes);

  if (!resultBlock) {
    return {
      sessionId,
      toolUseId,
      ...(agentId ? { agentId } : {}),
      toolName,
      ...formattedInput,
      status: "running",
      truncated: false,
      totalBytes: 0,
    };
  }

  const isError = resultBlock.is_error === true;
  const parsed = parseToolResultContent(resultBlock.content);
  const outputParts = [parsed.text];
  if (toolName === "Bash" && backgroundTaskId) {
    for (const content of notifications) {
      const text = parseToolResultContent(content).text.trim();
      if (!text.startsWith("<task-notification>")
        || ![...text.matchAll(/<task-id>([^<]+)<\/task-id>/gu)].some(match => match[1] === backgroundTaskId)) continue;
      for (const match of text.matchAll(/<(status|summary|output)>([\s\S]*?)<\/\1>/gu)) {
        const value = match[2]!.trim();
        if (value) outputParts.push(value);
      }
    }
    for (const notification of systemNotifications) {
      if (notification.task_id !== backgroundTaskId) continue;
      for (const value of [notification.status, notification.summary]) {
        if (typeof value === "string" && value.trim()) outputParts.push(value.trim());
      }
    }
  }
  const redactedOutput = redactEvidenceText(outputParts.filter(Boolean).join("\n\n"));
  const boundedOutput = truncateUtf8(redactedOutput, maxBytes);

  return {
    sessionId,
    toolUseId,
    ...(agentId ? { agentId } : {}),
    toolName,
    ...formattedInput,
    status: isError ? "error" : "completed",
    ...(boundedOutput.text.length > 0 || parsed.omittedBlocks.length === 0 ? { outputText: boundedOutput.text } : {}),
    ...(isError ? { isError: true } : {}),
    ...(parsed.omittedBlocks.length > 0 ? { omittedBlocks: parsed.omittedBlocks } : {}),
    truncated: boundedOutput.truncated,
    totalBytes: boundedOutput.totalBytes,
  };
}

export async function readSubagentToolCallDetail(params: {
  sessionId: string;
  transcriptPath: string;
  agentId: string;
  toolUseId: string;
  maxBytes?: number;
}): Promise<BridgeToolCallDetail | undefined> {
  const targetFileName = `agent-${params.agentId}.jsonl`;
  const files = await collectSubagentJsonlFiles(subagentsDirectoryForTranscript(params.transcriptPath));
  const targetPath = files.find((filePath) => (filePath.split(/[\\/]/u).pop() ?? "") === targetFileName);
  if (!targetPath) return undefined;

  const messages: unknown[] = [];
  const stream = createReadStream(targetPath, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const read = diagnostics.begin("file.toolDetail");
  try {
    for await (const line of lines) {
      diagnostics.observe("file.toolDetail", line.length);
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        messages.push(JSON.parse(trimmed));
      } catch {
        // Ignore partial trailing JSONL line while subagent is actively writing.
      }
    }
  } finally {
    lines.close();
    stream.destroy();
    read();
  }

  return extractToolCallDetailFromMessages({
    sessionId: params.sessionId,
    toolUseId: params.toolUseId,
    agentId: params.agentId,
    messages,
    ...(params.maxBytes !== undefined ? { maxBytes: params.maxBytes } : {}),
  });
}
