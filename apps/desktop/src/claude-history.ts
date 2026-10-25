import { createReadStream } from "node:fs";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import {
  isClaudeTranscriptControlMessage,
  type BridgeHistoryPage,
  type BridgeInteractiveAction,
  type BridgeInteractivePrompt,
  type BridgeInteractiveQuestion,
  type BridgeSubagentSummary,
  type ClaudeHistoryMessage,
} from "@bridge/protocol";

const SAFE_SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const MAX_HISTORY_MESSAGES = 50;
const MAX_HISTORY_TEXT_BYTES = 256 * 1024;
const MAX_MESSAGE_TEXT_BYTES = 10 * 1024;
const MAX_TOOL_RESULT_BYTES = 256 * 1024;
const OMITTED_TEXT = "\n\n[内容较长，已省略中间部分]\n\n";

interface TranscriptNode {
  index: number;
  uuid: string;
  parentUuid?: string;
  type?: "user" | "assistant";
  stopReason?: string;
  interruptedBoundary?: boolean;
  nonTurnUser?: boolean;
  role?: ClaudeHistoryMessage["role"];
  text?: string;
  interactivePrompt?: BridgeInteractivePrompt;
  toolResultAnswers?: Record<string, string>;
  createdAt: number;
}

interface TranscriptTurnNode {
  index: number;
  uuid: string;
  parentUuid?: string;
  type?: "user" | "assistant";
  stopReason?: string;
  interruptedBoundary?: boolean;
  nonTurnUser?: boolean;
}

interface TranscriptEvidenceNode {
  index: number;
  uuid: string;
  parentUuid?: string;
  type?: "user" | "assistant";
  createdAt: number;
  userPrompt: boolean;
  completedBoundary: boolean;
  tools: Array<{ id: string; name: string; input: unknown }>;
  results: Array<{ id?: string; output: unknown }>;
}

export interface ClaudeTranscriptToolEvidence {
  id: string;
  toolName: string;
  input: unknown;
  output?: unknown;
  startedAt: number;
  completedAt?: number;
}

export interface ClaudeTranscriptEvidenceTurn {
  id: string;
  startedAt: number;
  completedAt: number;
  tools: ClaudeTranscriptToolEvidence[];
  paths: string[];
}

export interface ClaudeHistoryReadResult {
  available: boolean;
  messages: ClaudeHistoryMessage[];
  truncated: boolean;
}

export interface ClaudeHistoryReadOptions {
  beforeCursor?: string;
  before?: { createdAt: number; id: string };
  limit?: number;
}

export interface ClaudeSessionContextEstimate {
  totalTokens: number;
  model?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textFromContent(content: unknown): string {
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

function evidencePaths(value: unknown): string[] {
  const paths: string[] = [];
  const visit = (candidate: unknown, key = ""): void => {
    if (typeof candidate === "string") {
      if (key === "command") {
        const matches = candidate.match(
          /(?:^|[\s"'=])((?:(?:[A-Za-z]:[\\/])|(?:\\\\)|(?:\.{0,2}[\\/])|\/)[^\s"'<>|;&]+)/gu,
        ) ?? [];
        for (const match of matches) paths.push(match.trim().replace(/^[\s"'=]+/u, ""));
      } else if (/(^|_)(file_?path|path|notebook_?path|output_?path|destination|dest)$/iu.test(key)) {
        paths.push(candidate);
      }
      return;
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item, key);
      return;
    }
    if (!isRecord(candidate)) return;
    for (const [childKey, child] of Object.entries(candidate)) visit(child, childKey);
  };
  visit(value);
  return paths;
}

function toolUses(content: unknown): Array<{ id: string; name: string; input: unknown }> {
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

function toolResultExitCode(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of ["exitCode", "exit_code", "code"]) {
    const candidate = value[key];
    if (typeof candidate === "number" && Number.isInteger(candidate)) return candidate;
  }
  for (const child of Object.values(value)) {
    const nested = toolResultExitCode(child);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function toolResultMetadata(value: unknown, isError = false): Record<string, unknown> {
  let text: string;
  if (typeof value === "string") text = value;
  else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  const bytes = Buffer.byteLength(text, "utf8");
  const lineCount = text
    ? text.split(/\r?\n/u).length - (text.endsWith("\n") ? 1 : 0)
    : 0;
  const exitCode = toolResultExitCode(value);
  return {
    bodyOmitted: true,
    byteLength: bytes,
    lineCount,
    truncated: bytes > MAX_TOOL_RESULT_BYTES,
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(isError ? { isError: true } : {}),
  };
}

function toolResults(value: Record<string, unknown>): Array<{ id?: string; output: unknown }> {
  const message = isRecord(value.message) ? value.message : undefined;
  const blocks = message && Array.isArray(message.content) ? message.content : [];
  const results = blocks.flatMap((block) => (
    isRecord(block) && block.type === "tool_result"
      ? [{
          ...(typeof block.tool_use_id === "string" ? { id: block.tool_use_id } : {}),
          output: toolResultMetadata(block.content, block.is_error === true),
        }]
      : []
  ));
  const direct = value.toolUseResult ?? value.tool_use_result;
  if (results.length === 0 && direct !== undefined) {
    results.push({ output: toolResultMetadata(direct, value.is_error === true) });
  }
  return results;
}

function resolveTranscriptParentUuid<T extends { uuid: string; parentUuid?: string }>(
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
  return undefined;
}

function transcriptEvidenceNode(
  value: Record<string, unknown>,
  index: number,
  nodes: ReadonlyMap<string, TranscriptEvidenceNode>,
  lastMainUuid?: string,
): TranscriptEvidenceNode | undefined {
  if (typeof value.uuid !== "string" || !value.uuid) return undefined;
  const existing = nodes.get(value.uuid);
  const parentUuid = existing?.parentUuid ?? resolveTranscriptParentUuid(value, nodes, lastMainUuid);
  const type = value.type === "user" || value.type === "assistant"
    ? value.type
    : existing?.type;
  const message = isRecord(value.message) ? value.message : undefined;
  const parsedAt = typeof value.timestamp === "string" ? Date.parse(value.timestamp) : Number.NaN;
  const directToolResult = value.toolUseResult ?? value.tool_use_result;
  const text = message ? textFromContent(message.content) : "";
  const userPrompt = Boolean(
    type === "user" &&
    directToolResult === undefined &&
    value.isMeta !== true &&
    value.isCompactSummary !== true &&
    message &&
    !isClaudeTranscriptControlMessage("user", text),
  );
  const stopReason = message && typeof message.stop_reason === "string"
    ? message.stop_reason
    : undefined;
  return {
    index: existing?.index ?? index,
    uuid: value.uuid,
    ...(parentUuid ? { parentUuid } : {}),
    ...(type ? { type } : {}),
    createdAt: existing?.createdAt || (Number.isFinite(parsedAt) ? parsedAt : 0),
    userPrompt: existing?.userPrompt ?? userPrompt,
    completedBoundary: Boolean(
      existing?.completedBoundary ||
      (
        type === "assistant" &&
        stopReason &&
        ["end_turn", "max_tokens", "stop_sequence", "refusal", "model_context_window_exceeded"]
          .includes(stopReason)
      ),
    ),
    tools: type === "assistant" && message ? toolUses(message.content) : (existing?.tools ?? []),
    results: type === "user" ? toolResults(value) : (existing?.results ?? []),
  };
}

function evidenceTurns(
  nodes: Map<string, TranscriptEvidenceNode>,
): ClaudeTranscriptEvidenceTurn[] {
  const referencedParents = new Set(
    [...nodes.values()].flatMap((node) => node.parentUuid ? [node.parentUuid] : []),
  );
  const terminal = [...nodes.values()]
    .filter((node) => !referencedParents.has(node.uuid))
    .sort((left, right) => right.index - left.index)[0];
  if (!terminal) return [];
  const chain: TranscriptEvidenceNode[] = [];
  const seen = new Set<string>();
  let current: TranscriptEvidenceNode | undefined = terminal;
  while (current && !seen.has(current.uuid)) {
    seen.add(current.uuid);
    chain.push(current);
    current = current.parentUuid ? nodes.get(current.parentUuid) : undefined;
  }
  chain.reverse();

  const turns: ClaudeTranscriptEvidenceTurn[] = [];
  let turn: {
    id: string;
    startedAt: number;
    completedAt?: number;
    tools: ClaudeTranscriptToolEvidence[];
    paths: Set<string>;
  } | undefined;
  for (const node of chain) {
    if (node.userPrompt) {
      if (turn?.tools.length) {
        turns.push({
          id: turn.id,
          startedAt: turn.startedAt,
          completedAt: turn.completedAt ?? node.createdAt,
          tools: turn.tools,
          paths: [...turn.paths],
        });
      }
      turn = {
        id: node.uuid,
        startedAt: node.createdAt,
        tools: [],
        paths: new Set(),
      };
      continue;
    }
    if (!turn) continue;
    for (const tool of node.tools) {
      const existing = turn.tools.find((candidate) => candidate.id === tool.id);
      if (!existing) {
        turn.tools.push({
          id: tool.id,
          toolName: tool.name,
          input: tool.input,
          startedAt: node.createdAt,
        });
      }
      for (const candidate of evidencePaths(tool.input)) turn.paths.add(candidate);
    }
    if (node.completedBoundary) turn.completedAt = node.createdAt;
    for (const result of node.results) {
      let tool = result.id
        ? turn.tools.find((candidate) => candidate.id === result.id)
        : undefined;
      if (!tool && !result.id) {
        for (let toolIndex = turn.tools.length - 1; toolIndex >= 0; toolIndex -= 1) {
          if (turn.tools[toolIndex]?.output === undefined) {
            tool = turn.tools[toolIndex];
            break;
          }
        }
      }
      if (!tool) continue;
      tool.output = result.output;
      tool.completedAt = node.createdAt;
    }
  }
  if (turn?.tools.length) {
    turns.push({
      id: turn.id,
      startedAt: turn.startedAt,
      completedAt: turn.completedAt ?? turn.tools.at(-1)?.completedAt ?? turn.startedAt,
      tools: turn.tools,
      paths: [...turn.paths],
    });
  }
  return turns.filter((candidate) => candidate.tools.some((tool) => tool.completedAt));
}

export class ClaudeTranscriptEvidenceCursor {
  private identity = "";
  private offset = 0;
  private pending = Buffer.alloc(0);
  private readonly nodes = new Map<string, TranscriptEvidenceNode>();
  private index = 0;
  private lastMainUuid: string | undefined;

  async read(path: string): Promise<ClaudeTranscriptEvidenceTurn[]> {
    let metadata;
    try {
      metadata = await stat(path);
    } catch {
      return [];
    }
    const identity = `${metadata.dev}:${metadata.ino}`;
    if (this.identity !== identity || metadata.size < this.offset) {
      this.identity = identity;
      this.offset = 0;
      this.pending = Buffer.alloc(0);
      this.nodes.clear();
      this.index = 0;
      this.lastMainUuid = undefined;
    }
    if (metadata.size > this.offset) {
      const chunks: Buffer[] = [];
      for await (const chunk of createReadStream(path, {
        start: this.offset,
        end: metadata.size - 1,
      })) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      this.offset = metadata.size;
      const bytes = Buffer.concat([this.pending, ...chunks]);
      let start = 0;
      for (let cursor = 0; cursor < bytes.byteLength; cursor += 1) {
        if (bytes[cursor] !== 0x0a) continue;
        this.acceptLine(bytes.subarray(start, cursor).toString("utf8"));
        start = cursor + 1;
      }
      this.pending = bytes.subarray(start);
      if (this.pending.byteLength > 0) {
        const tail = this.pending.toString("utf8");
        try {
          const parsed = JSON.parse(tail) as unknown;
          if (isRecord(parsed)) {
            this.acceptValue(parsed);
            this.pending = Buffer.alloc(0);
          }
        } catch {
          // Keep an incomplete final record until the next append.
        }
      }
    }
    return evidenceTurns(this.nodes);
  }

  private acceptLine(line: string): void {
    if (!line.trim()) return;
    try {
      const value = JSON.parse(line) as unknown;
      if (isRecord(value)) this.acceptValue(value);
    } catch {
      // A malformed or interrupted record is isolated to this line.
    }
  }

  private acceptValue(value: Record<string, unknown>): void {
    const node = transcriptEvidenceNode(value, ++this.index, this.nodes, this.lastMainUuid);
    if (node) {
      this.nodes.set(node.uuid, node);
      if (value.isSidechain !== true) this.lastMainUuid = node.uuid;
    }
  }
}

function cleanUserText(value: string): string {
  return value
    .replace(/^\s*\[来自手机 Bridge\]\s*/u, "")
    .replace(/\s*<!--\s*bridge-command:[A-Za-z0-9_-]{1,64}\s*-->\s*/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function isLocalCommandRecord(text: string): boolean {
  const trimmed = text.trim();
  return /^<(?:local-command-caveat|local-command-stdout|local-command-stderr|command-name|command-message)\b/u.test(trimmed);
}

function isNonTurnUserRecord(value: Record<string, unknown>, rawText: string): boolean {
  return (
    value.isMeta === true ||
    value.isCompactSummary === true ||
    isLocalCommandRecord(rawText)
  );
}

function visibleMessage(value: Record<string, unknown>): Pick<TranscriptNode, "role" | "text"> | undefined {
  if (value.type !== "user" && value.type !== "assistant") return undefined;
  if (!isRecord(value.message)) return undefined;
  if (
    value.type === "user" &&
    (
      value.toolUseResult !== undefined ||
      value.tool_use_result !== undefined ||
      value.isMeta === true ||
      value.isCompactSummary === true
    )
  ) return undefined;
  const text = textFromContent(value.message.content);
  if (!text) return undefined;
  const role = value.type;
  const cleaned = role === "user" ? cleanUserText(text) : text.trim();
  const syntheticFailure = role === "assistant" &&
    value.message.model === "<synthetic>" &&
    (
      value.message.stop_reason === "model_context_window_exceeded" ||
      /^(?:Prompt is too long|API Error:|Error:)/iu.test(cleaned)
    );
  if (syntheticFailure) return undefined;
  if (
    role === "user" &&
    (
      isLocalCommandRecord(cleaned) ||
      /^<task-notification>[\s\S]*<\/task-notification>$/u.test(cleaned) ||
      /^Another Claude session sent a message[\s\S]*<agent-message\b/u.test(cleaned)
    )
  ) {
    return undefined;
  }
  if (!cleaned || isClaudeTranscriptControlMessage(role, cleaned)) return undefined;
  return { role, text: cleaned };
}

function defaultWrapUpActionLabel(actionKey: string): string {
  if (actionKey === "commit") return "提交改动";
  if (actionKey === "create_pr") return "创建 PR";
  if (actionKey === "merge") return "合并 PR";
  if (actionKey === "fix_ci") return "修复 CI";
  if (actionKey === "address_comments") return "处理评审意见";
  if (actionKey === "resolve_conflicts") return "解决冲突";
  if (actionKey === "verify") return "运行验证";
  if (actionKey === "archive") return "归档会话";
  if (actionKey === "new_session") return "新建会话";
  return actionKey;
}

function extractInteractivePrompt(value: Record<string, unknown>): BridgeInteractivePrompt | undefined {
  if (value.type !== "assistant" || !isRecord(value.message) || !Array.isArray(value.message.content)) {
    return undefined;
  }
  let found: BridgeInteractivePrompt | undefined;
  for (const block of value.message.content) {
    if (!isRecord(block) || block.type !== "tool_use" || typeof block.name !== "string") continue;
    const input = isRecord(block.input) ? block.input : undefined;
    if (!input) continue;
    if (block.name === "mcp__ccd_turn__wrap_up") {
      const recap = typeof input.recap === "string" && input.recap.trim() ? input.recap.trim() : undefined;
      const ask = typeof input.ask === "string" && input.ask.trim() ? input.ask.trim() : undefined;
      const blocked = input.blocked === true ? true : undefined;
      const rawActions = Array.isArray(input.actions) ? input.actions : [];
      const actions: BridgeInteractiveAction[] = [];
      rawActions.forEach((rawAction, idx) => {
        if (!isRecord(rawAction)) return;
        const actionKey = typeof rawAction.action === "string" ? rawAction.action.trim() : "";
        const label = typeof rawAction.label === "string" && rawAction.label.trim()
          ? rawAction.label.trim()
          : defaultWrapUpActionLabel(actionKey);
        const message = typeof rawAction.message === "string" && rawAction.message.trim()
          ? rawAction.message.trim()
          : label;
        if (!label) return;
        actions.push({
          label,
          message,
          ...(idx === 0 ? { recommended: true } : {}),
        });
      });
      if (ask || actions.length > 0) {
        found = {
          kind: "wrap-up",
          ...(recap ? { recap } : {}),
          ...(ask ? { ask } : {}),
          ...(blocked ? { blocked: true } : {}),
          ...(actions.length > 0 ? { actions } : {}),
        };
      }
    } else if (block.name === "AskUserQuestion") {
      const rawQuestions = Array.isArray(input.questions) ? input.questions : [];
      const questions: BridgeInteractiveQuestion[] = [];
      for (const rawQ of rawQuestions) {
        if (!isRecord(rawQ) || typeof rawQ.question !== "string" || !rawQ.question.trim()) continue;
        const header = typeof rawQ.header === "string" && rawQ.header.trim() ? rawQ.header.trim() : undefined;
        const multiSelect = rawQ.multiSelect === true ? true : undefined;
        const rawOptions = Array.isArray(rawQ.options) ? rawQ.options : [];
        const options = rawOptions.flatMap((opt) => {
          if (!isRecord(opt) || typeof opt.label !== "string" || !opt.label.trim()) return [];
          const description = typeof opt.description === "string" && opt.description.trim()
            ? opt.description.trim()
            : undefined;
          return [{
            label: opt.label.trim(),
            ...(description ? { description } : {}),
          }];
        });
        questions.push({
          question: rawQ.question.trim(),
          ...(header ? { header } : {}),
          ...(multiSelect ? { multiSelect: true } : {}),
          options,
        });
      }
      if (questions.length > 0) {
        found = {
          kind: "question",
          ...(questions[0]?.question ? { ask: questions[0].question } : {}),
          questions,
        };
      }
    }
  }
  return found;
}

function extractToolResultAnswers(value: Record<string, unknown>): Record<string, string> | undefined {
  if (value.type !== "user") return undefined;
  const direct = value.toolUseResult ?? value.tool_use_result;
  if (!isRecord(direct) || !isRecord(direct.answers)) return undefined;
  const answers: Record<string, string> = {};
  for (const [k, v] of Object.entries(direct.answers)) {
    if (typeof v === "string" && v.trim()) answers[k] = v.trim();
  }
  return Object.keys(answers).length > 0 ? answers : undefined;
}

function applyQuestionAnswers(
  prompt: BridgeInteractivePrompt,
  answers: Record<string, string>,
): BridgeInteractivePrompt {
  if (prompt.kind !== "question" || !prompt.questions) return prompt;
  return {
    ...prompt,
    answered: true,
    questions: prompt.questions.map((q) => {
      const answer = answers[q.question];
      if (!answer) return q;
      return {
        ...q,
        answer,
        options: q.options.map((opt) => (
          opt.label === answer ? { ...opt, selected: true } : opt
        )),
      };
    }),
  };
}

function applyWrapUpUserReply(
  prompt: BridgeInteractivePrompt,
  userReplyText: string,
): BridgeInteractivePrompt {
  const normalizedReply = userReplyText.trim();
  if (prompt.kind === "wrap-up") {
    return {
      ...prompt,
      answered: true,
      ...(prompt.actions
        ? {
            actions: prompt.actions.map((action) => (
              action.message.trim() === normalizedReply || action.label.trim() === normalizedReply
                ? { ...action, selected: true }
                : action
            )),
          }
        : {}),
    };
  }
  if (prompt.kind === "question" && !prompt.answered) {
    return {
      ...prompt,
      answered: true,
      ...(prompt.questions
        ? {
            questions: prompt.questions.map((q) => ({
              ...q,
              options: q.options.map((opt) => (
                opt.label.trim() === normalizedReply ? { ...opt, selected: true } : opt
              )),
            })),
          }
        : {}),
    };
  }
  return prompt;
}

function takePrefixByBytes(value: string, maxBytes: number): string {
  let size = 0;
  let result = "";
  for (const character of value) {
    const next = Buffer.byteLength(character);
    if (size + next > maxBytes) break;
    result += character;
    size += next;
  }
  return result;
}

function takeSuffixByBytes(value: string, maxBytes: number): string {
  let size = 0;
  const characters = [...value];
  let result = "";
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const character = characters[index]!;
    const next = Buffer.byteLength(character);
    if (size + next > maxBytes) break;
    result = character + result;
    size += next;
  }
  return result;
}

function clipText(value: string, maxBytes: number): { text: string; clipped: boolean } {
  if (Buffer.byteLength(value) <= maxBytes) return { text: value, clipped: false };
  const markerBytes = Buffer.byteLength(OMITTED_TEXT);
  const available = Math.max(2, maxBytes - markerBytes);
  const prefixBytes = Math.ceil(available * 0.6);
  const suffixBytes = available - prefixBytes;
  return {
    text: `${takePrefixByBytes(value, prefixBytes).trimEnd()}${OMITTED_TEXT}${takeSuffixByBytes(value, suffixBytes).trimStart()}`,
    clipped: true,
  };
}

function trimHistory(
  messages: ClaudeHistoryMessage[],
  options: ClaudeHistoryReadOptions = {},
): { messages: ClaudeHistoryMessage[]; truncated: boolean; nextCursor?: string } {
  let candidateMessages = messages;
  if (options.before) {
    const beforeIndex = messages.findIndex((message) => message.id === options.before!.id);
    candidateMessages = beforeIndex >= 0
      ? messages.slice(0, beforeIndex)
      : messages.filter((message) => (
          message.createdAt < options.before!.createdAt ||
          (message.createdAt === options.before!.createdAt && message.id < options.before!.id)
        ));
  } else if (options.beforeCursor) {
    const beforeIndex = messages.findIndex((message) => message.id === options.beforeCursor);
    candidateMessages = beforeIndex >= 0 ? messages.slice(0, beforeIndex) : [];
  }
  const maxMessages = Math.max(1, Math.min(options.limit ?? MAX_HISTORY_MESSAGES, 10_000));
  const selected: ClaudeHistoryMessage[] = [];
  let bytes = 0;
  let truncated = candidateMessages.length > maxMessages;
  for (let index = candidateMessages.length - 1; index >= 0 && selected.length < maxMessages; index -= 1) {
    const message = candidateMessages[index]!;
    const clipped = clipText(message.text, MAX_MESSAGE_TEXT_BYTES);
    const interactiveBytes = message.interactivePrompt
      ? Buffer.byteLength(JSON.stringify(message.interactivePrompt))
      : 0;
    const cost = Buffer.byteLength(clipped.text) + interactiveBytes + 180;
    if (selected.length > 0 && bytes + cost > MAX_HISTORY_TEXT_BYTES) {
      truncated = true;
      break;
    }
    selected.unshift({ ...message, text: clipped.text });
    bytes += cost;
    truncated ||= clipped.clipped;
  }
  const hasMore = selected.length < candidateMessages.length;
  if (hasMore) truncated = true;
  if (hasMore && selected[0]?.role === "assistant") {
    const firstUser = selected.findIndex((message) => message.role === "user");
    if (firstUser > 0) selected.splice(0, firstUser);
  }
  return {
    messages: selected,
    truncated,
    ...(hasMore && selected[0] ? { nextCursor: selected[0].id } : {}),
  };
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

export interface ClaudeTranscriptSnapshot extends ClaudeHistoryReadResult {
  nextCursor?: string;
  userMessages: ClaudeHistoryMessage[];
  atTurnBoundary?: boolean;
}

function transcriptTurnBoundary<T extends TranscriptTurnNode>(
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

const transcriptSnapshotCache = new Map<string, {
  signature: string;
  allMessages: ClaudeHistoryMessage[];
  userMessages: ClaudeHistoryMessage[];
  atTurnBoundary?: boolean;
}>();

export async function parseClaudeTranscriptSnapshot(
  path: string,
  options: ClaudeHistoryReadOptions = {},
  userLimit = 200,
): Promise<ClaudeTranscriptSnapshot> {
  const fileStat = await stat(path).catch(() => undefined);
  if (!fileStat) {
    return { available: false, messages: [], truncated: false, userMessages: [] };
  }
  const cacheSignature = `${fileStat.mtimeMs}:${fileStat.size}:${userLimit}`;
  const cached = transcriptSnapshotCache.get(path);
  if (cached && cached.signature === cacheSignature) {
    return {
      available: true,
      ...trimHistory(cached.allMessages, options),
      userMessages: cached.userMessages,
      ...(cached.atTurnBoundary !== undefined ? { atTurnBoundary: cached.atTurnBoundary } : {}),
    };
  }

  const nodes = new Map<string, TranscriptNode>();
  const referencedParents = new Set<string>();
  const userMessages: ClaudeHistoryMessage[] = [];
  let index = 0;
  let lastMainUuid: string | undefined;
  try {
    const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of lines) {
      index += 1;
      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch {
        continue;
      }
      if (!isRecord(value) || typeof value.uuid !== "string" || !value.uuid) continue;
      const existing = nodes.get(value.uuid);
      const parentUuid = existing?.parentUuid ?? resolveTranscriptParentUuid(value, nodes, lastMainUuid);
      if (parentUuid) referencedParents.add(parentUuid);
      const visible = visibleMessage(value);
      const message = isRecord(value.message) ? value.message : undefined;
      const rawText = message ? textFromContent(message.content) : "";
      const parsedAt = typeof value.timestamp === "string" ? Date.parse(value.timestamp) : Number.NaN;
      const createdAt = existing?.createdAt || (Number.isFinite(parsedAt) ? parsedAt : 0);
      const type = value.type === "user" || value.type === "assistant"
        ? value.type
        : existing?.type;
      const role = visible?.role ?? existing?.role;
      const text = visible?.text ?? existing?.text;
      const interactivePrompt = extractInteractivePrompt(value) ?? existing?.interactivePrompt;
      const toolResultAnswers = extractToolResultAnswers(value) ?? existing?.toolResultAnswers;
      nodes.set(value.uuid, {
        index: existing?.index ?? index,
        uuid: value.uuid,
        ...(parentUuid ? { parentUuid } : {}),
        ...(type ? { type } : {}),
        ...(existing?.interruptedBoundary || (value.type === "user" && isClaudeTranscriptControlMessage("user", rawText))
          ? { interruptedBoundary: true }
          : {}),
        ...(existing?.nonTurnUser || (value.type === "user" && isNonTurnUserRecord(value, rawText))
          ? { nonTurnUser: true }
          : {}),
        ...(message && typeof message.stop_reason === "string"
          ? { stopReason: message.stop_reason }
          : existing?.stopReason
            ? { stopReason: existing.stopReason }
            : {}),
        ...(role ? { role } : {}),
        ...(text ? { text } : {}),
        ...(interactivePrompt ? { interactivePrompt } : {}),
        ...(toolResultAnswers ? { toolResultAnswers } : {}),
        createdAt,
      });
      if (value.isSidechain !== true) lastMainUuid = value.uuid;
      if (!existing && visible?.role === "user" && visible.text) {
        userMessages.push({
          id: value.uuid,
          role: "user",
          text: clipText(visible.text, MAX_MESSAGE_TEXT_BYTES).text,
          createdAt,
        });
        if (userMessages.length > userLimit) userMessages.shift();
      }
    }
  } catch {
    return { available: false, messages: [], truncated: false, userMessages: [] };
  }

  const terminal = [...nodes.values()]
    .filter((node) => !referencedParents.has(node.uuid))
    .sort((left, right) => right.index - left.index)[0];
  if (!terminal) return { available: true, messages: [], truncated: false, userMessages };
  const atTurnBoundary = transcriptTurnBoundary(nodes, terminal);

  const chain: TranscriptNode[] = [];
  const seen = new Set<string>();
  let current: TranscriptNode | undefined = terminal;
  while (current && !seen.has(current.uuid)) {
    seen.add(current.uuid);
    chain.push(current);
    current = current.parentUuid ? nodes.get(current.parentUuid) : undefined;
  }
  chain.reverse();

  const messages: ClaudeHistoryMessage[] = [];
  let pendingInteractive: { node: TranscriptNode; prompt: BridgeInteractivePrompt } | undefined;
  for (const node of chain) {
    if (node.interactivePrompt) {
      const previous = messages.at(-1);
      if (previous?.role === "assistant") {
        previous.interactivePrompt = node.interactivePrompt;
      } else {
        pendingInteractive = { node, prompt: node.interactivePrompt };
      }
    }
    if (node.toolResultAnswers) {
      if (pendingInteractive) {
        pendingInteractive = {
          node: pendingInteractive.node,
          prompt: applyQuestionAnswers(pendingInteractive.prompt, node.toolResultAnswers),
        };
      } else {
        const previous = messages.at(-1);
        if (previous?.role === "assistant" && previous.interactivePrompt) {
          previous.interactivePrompt = applyQuestionAnswers(previous.interactivePrompt, node.toolResultAnswers);
        }
      }
    }
    if (!node.role || !node.text) continue;
    const previous = messages.at(-1);
    if (node.role === "assistant") {
      if (previous?.role === "assistant") {
        previous.text = `${previous.text}\n\n${node.text}`;
        if (pendingInteractive) {
          previous.interactivePrompt = pendingInteractive.prompt;
          pendingInteractive = undefined;
        }
        continue;
      }
      messages.push({
        id: node.uuid,
        role: "assistant",
        text: node.text,
        createdAt: node.createdAt,
        ...(pendingInteractive ? { interactivePrompt: pendingInteractive.prompt } : {}),
      });
      pendingInteractive = undefined;
      continue;
    }
    if (pendingInteractive) {
      messages.push({
        id: pendingInteractive.node.uuid,
        role: "assistant",
        text: "",
        createdAt: pendingInteractive.node.createdAt,
        interactivePrompt: applyWrapUpUserReply(pendingInteractive.prompt, node.text),
      });
      pendingInteractive = undefined;
    } else if (previous?.role === "assistant" && previous.interactivePrompt) {
      previous.interactivePrompt = applyWrapUpUserReply(previous.interactivePrompt, node.text);
    }
    messages.push({ id: node.uuid, role: node.role, text: node.text, createdAt: node.createdAt });
  }
  if (pendingInteractive) {
    const previous = messages.at(-1);
    if (previous?.role === "assistant") {
      previous.interactivePrompt = pendingInteractive.prompt;
    } else {
      messages.push({
        id: pendingInteractive.node.uuid,
        role: "assistant",
        text: "",
        createdAt: pendingInteractive.node.createdAt,
        interactivePrompt: pendingInteractive.prompt,
      });
    }
  }
  if (transcriptSnapshotCache.size > 128) {
    const oldestKey = transcriptSnapshotCache.keys().next().value;
    if (typeof oldestKey === "string") transcriptSnapshotCache.delete(oldestKey);
  }
  transcriptSnapshotCache.set(path, {
    signature: cacheSignature,
    allMessages: messages,
    userMessages,
    ...(atTurnBoundary !== undefined ? { atTurnBoundary } : {}),
  });
  return {
    available: true,
    ...trimHistory(messages, options),
    userMessages,
    atTurnBoundary,
  };
}

export async function parseClaudeTranscriptEvidence(
  path: string,
): Promise<ClaudeTranscriptEvidenceTurn[]> {
  return new ClaudeTranscriptEvidenceCursor().read(path);
}

export async function parseClaudeTranscript(
  path: string,
  options: ClaudeHistoryReadOptions = {},
): Promise<ClaudeHistoryReadResult & { nextCursor?: string }> {
  const {
    userMessages: _userMessages,
    atTurnBoundary: _atTurnBoundary,
    ...result
  } = await parseClaudeTranscriptSnapshot(path, options);
  return result;
}

export async function readClaudeTranscriptUserMessages(
  path: string,
  limit = 200,
): Promise<ClaudeHistoryMessage[]> {
  return (await parseClaudeTranscriptSnapshot(path, {}, limit)).userMessages;
}

export async function isClaudeTranscriptAtTurnBoundary(path: string): Promise<boolean> {
  const snapshot = await parseClaudeTranscriptSnapshot(path, { limit: 1 });
  return snapshot.available ? Boolean(snapshot.atTurnBoundary) : false;
}

export async function readClaudeSessionHistory(
  projectsRoot: string,
  sessionId: string,
  cwd?: string,
  options: ClaudeHistoryReadOptions = {},
): Promise<ClaudeHistoryReadResult & { nextCursor?: string }> {
  const path = await findClaudeTranscriptFile(projectsRoot, sessionId, cwd);
  if (!path) return { available: false, messages: [], truncated: false };
  return parseClaudeTranscript(path, options);
}

export async function readClaudeSessionContextEstimate(
  projectsRoot: string,
  sessionId: string,
  cwd?: string,
): Promise<ClaudeSessionContextEstimate | undefined> {
  const path = await findClaudeTranscriptFile(projectsRoot, sessionId, cwd);
  if (!path) return undefined;
  let latest: ClaudeSessionContextEstimate | undefined;
  try {
    const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of lines) {
      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch {
        continue;
      }
      if (!isRecord(value) || value.type !== "assistant" || !isRecord(value.message)) continue;
      const usage = value.message.usage;
      if (!isRecord(usage)) continue;
      const inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
      const cacheReadTokens = typeof usage.cache_read_input_tokens === "number"
        ? usage.cache_read_input_tokens
        : 0;
      const cacheCreationTokens = typeof usage.cache_creation_input_tokens === "number"
        ? usage.cache_creation_input_tokens
        : 0;
      const totalTokens = inputTokens + cacheReadTokens + cacheCreationTokens;
      if (!Number.isFinite(totalTokens) || totalTokens <= 0) continue;
      latest = {
        totalTokens,
        ...(typeof value.message.model === "string" && value.message.model
          ? { model: value.message.model }
          : {}),
      };
    }
  } catch {
    return undefined;
  }
  return latest;
}

export async function readClaudeSessionHistoryPage(
  projectsRoot: string,
  sessionId: string,
  cwd?: string,
  options: ClaudeHistoryReadOptions = {},
): Promise<BridgeHistoryPage> {
  const result = await readClaudeSessionHistory(projectsRoot, sessionId, cwd, options);
  return {
    sessionId,
    items: result.messages.map((message) => ({
      id: message.id,
      sessionId,
      role: message.role,
      text: message.text,
      createdAt: message.createdAt,
      origin: "claude-desktop",
      ...(message.interactivePrompt ? { interactivePrompt: message.interactivePrompt } : {}),
    })),
    hasMore: Boolean(result.nextCursor),
    ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
  };
}

function subagentsDirectoryForTranscript(transcriptPath: string): string {
  return join(transcriptPath.replace(/\.jsonl$/u, ""), "subagents");
}

async function collectSubagentJsonlFiles(directory: string, depth = 0): Promise<string[]> {
  if (depth > 3) return [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectSubagentJsonlFiles(fullPath, depth + 1));
    } else if (entry.isFile() && entry.name.startsWith("agent-") && entry.name.endsWith(".jsonl")) {
      files.push(fullPath);
    }
  }
  return files;
}

export async function getClaudeSubagentsMtimeMs(transcriptPath: string): Promise<number> {
  const subagentsDir = subagentsDirectoryForTranscript(transcriptPath);
  const files = await collectSubagentJsonlFiles(subagentsDir);
  if (files.length === 0) return 0;
  let maxMtime = 0;
  for (const file of files) {
    const [jsonlMtime, metaMtime] = await Promise.all([
      stat(file).then((s) => s.mtimeMs, () => 0),
      stat(file.replace(/\.jsonl$/u, ".meta.json")).then((s) => s.mtimeMs, () => 0),
    ]);
    if (jsonlMtime > maxMtime) maxMtime = jsonlMtime;
    if (metaMtime > maxMtime) maxMtime = metaMtime;
  }
  return maxMtime;
}

function formatSubagentToolStep(name: string, input: unknown): string {
  if (!isRecord(input)) return name;
  if ((name === "Read" || name === "Edit" || name === "Write") && typeof input.file_path === "string") {
    const base = input.file_path.split(/[\\/]/u).filter(Boolean).pop();
    if (base) return `${name} ${base}`;
  }
  if (name === "Bash") {
    if (typeof input.description === "string" && input.description.trim()) {
      const desc = input.description.trim();
      return `Bash: ${desc.length > 36 ? `${desc.slice(0, 35)}…` : desc}`;
    }
    if (typeof input.command === "string" && input.command.trim()) {
      const cmd = input.command.trim().split(/\s+/u)[0] ?? "";
      if (cmd) return `Bash ${cmd.slice(0, 24)}`;
    }
  }
  if ((name === "Grep" || name === "Glob") && typeof input.pattern === "string" && input.pattern.trim()) {
    const pat = input.pattern.trim();
    return `${name} ${pat.length > 24 ? `${pat.slice(0, 23)}…` : pat}`;
  }
  return name;
}

const MAX_SUBAGENT_REPORT_BYTES = 3_600;
const MAX_SUBAGENT_LATEST_BYTES = 600;
const subagentSummaryCache = new Map<string, {
  signature: string;
  summary: BridgeSubagentSummary;
}>();

async function parseSingleSubagentFile(
  jsonlPath: string,
  processAlive: boolean,
): Promise<BridgeSubagentSummary | undefined> {
  const metaPath = jsonlPath.replace(/\.jsonl$/u, ".meta.json");
  const [fileStat, metaStat] = await Promise.all([
    stat(jsonlPath).catch(() => undefined),
    stat(metaPath).catch(() => undefined),
  ]);
  if (!fileStat) return undefined;
  const cacheSignature = `${fileStat.mtimeMs}:${fileStat.size}:${metaStat?.mtimeMs ?? 0}:${processAlive ? 1 : 0}`;
  const cached = subagentSummaryCache.get(jsonlPath);
  if (cached && cached.signature === cacheSignature) {
    return cached.summary;
  }
  let meta: Record<string, unknown> = {};
  if (metaStat) {
    try {
      const rawMeta = JSON.parse(await readFile(metaPath, "utf8")) as unknown;
      if (isRecord(rawMeta)) meta = rawMeta;
    } catch {
      // Meta file may still be writing.
    }
  }
  const fileName = jsonlPath.split(/[\\/]/u).pop() ?? "";
  const agentId = fileName.replace(/^agent-/u, "").replace(/\.jsonl$/u, "");
  if (!agentId) return undefined;

  let toolCount = 0;
  const recentTools: string[] = [];
  let latestText = "";
  const handbackReports: string[] = [];
  let startedAt = 0;
  let updatedAt = Math.round(fileStat.mtimeMs);

  try {
    const lines = createInterface({
      input: createReadStream(jsonlPath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    for await (const line of lines) {
      if (!line.trim()) continue;
      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch {
        continue;
      }
      if (!isRecord(value)) continue;
      const parsedAt = typeof value.timestamp === "string" ? Date.parse(value.timestamp) : Number.NaN;
      if (Number.isFinite(parsedAt) && parsedAt > 0) {
        if (!startedAt) startedAt = parsedAt;
        if (parsedAt > updatedAt) updatedAt = parsedAt;
      }
      if (value.type === "assistant" && isRecord(value.message) && Array.isArray(value.message.content)) {
        for (const block of value.message.content) {
          if (!isRecord(block)) continue;
          if (block.type === "tool_use" && typeof block.name === "string") {
            if (block.name === "SubagentHandback") {
              if (
                isRecord(block.input) &&
                typeof block.input.message === "string" &&
                block.input.message.trim()
              ) {
                handbackReports.push(block.input.message.trim());
              }
            } else {
              toolCount += 1;
              recentTools.push(formatSubagentToolStep(block.name, block.input));
              if (recentTools.length > 5) recentTools.shift();
            }
          } else if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
            latestText = block.text.trim();
          }
        }
      }
    }
  } catch {
    return undefined;
  }

  const reportText = handbackReports.join("\n\n---\n\n");
  const explicitlyFinished = meta.finished === true || handbackReports.length > 0;
  const staleIdle = !processAlive && Date.now() - updatedAt > 180_000;
  const state: BridgeSubagentSummary["state"] = explicitlyFinished || staleIdle
    ? "completed"
    : "running";
  const description = typeof meta.description === "string" && meta.description.trim()
    ? meta.description.trim()
    : `子代理 ${agentId.slice(0, 7)}`;
  const toolUseId = typeof meta.toolUseId === "string" && meta.toolUseId
    ? meta.toolUseId
    : undefined;
  const agentType = typeof meta.agentType === "string" && meta.agentType
    ? meta.agentType
    : undefined;
  const effectiveStartedAt = startedAt || updatedAt || Date.now();
  const effectiveUpdatedAt = Math.max(effectiveStartedAt, updatedAt || Date.now());
  const clippedReport = reportText
    ? clipText(reportText, MAX_SUBAGENT_REPORT_BYTES).text
    : (state === "completed" && latestText ? clipText(latestText, MAX_SUBAGENT_REPORT_BYTES).text : undefined);
  const clippedLatest = latestText
    ? clipText(latestText, MAX_SUBAGENT_LATEST_BYTES).text
    : undefined;

  const summary: BridgeSubagentSummary = {
    agentId,
    ...(toolUseId ? { toolUseId } : {}),
    ...(agentType ? { agentType } : {}),
    description,
    state,
    toolCount,
    ...(recentTools.length ? { recentTools } : {}),
    ...(clippedLatest ? { latestText: clippedLatest } : {}),
    ...(clippedReport ? { reportText: clippedReport } : {}),
    startedAt: effectiveStartedAt,
    updatedAt: effectiveUpdatedAt,
    durationMs: Math.max(0, effectiveUpdatedAt - effectiveStartedAt),
  };
  if (subagentSummaryCache.size > 2_000) {
    const oldestKey = subagentSummaryCache.keys().next().value;
    if (typeof oldestKey === "string") subagentSummaryCache.delete(oldestKey);
  }
  subagentSummaryCache.set(jsonlPath, { signature: cacheSignature, summary });
  return summary;
}

const parentSubagentCache = new Map<string, {
  signature: string;
  summaries: BridgeSubagentSummary[];
}>();

async function parseParentTranscriptSubagents(
  transcriptPath: string,
  processAlive: boolean,
): Promise<BridgeSubagentSummary[]> {
  const fileStat = await stat(transcriptPath).catch(() => undefined);
  if (!fileStat) return [];
  const cacheSignature = `${fileStat.mtimeMs}:${fileStat.size}:${processAlive ? 1 : 0}`;
  const cached = parentSubagentCache.get(transcriptPath);
  if (cached && cached.signature === cacheSignature) {
    return cached.summaries;
  }

  const callsByToolId = new Map<string, {
    toolUseId: string;
    agentId?: string;
    agentType?: string;
    description: string;
    startedAt: number;
    updatedAt: number;
    reportText?: string;
  }>();
  const toolIdByAgentId = new Map<string, string>();
  const reportsByAgentId = new Map<string, { text: string; at: number }>();

  try {
    const lines = createInterface({
      input: createReadStream(transcriptPath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    for await (const line of lines) {
      if (!line.trim()) continue;
      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch {
        continue;
      }
      if (!isRecord(value) || !isRecord(value.message)) continue;
      const parsedAt = typeof value.timestamp === "string" ? Date.parse(value.timestamp) : Number.NaN;
      const ts = Number.isFinite(parsedAt) && parsedAt > 0 ? parsedAt : Date.now();
      if (value.type === "assistant" && Array.isArray(value.message.content)) {
        for (const block of value.message.content) {
          if (!isRecord(block) || block.type !== "tool_use" || typeof block.id !== "string") continue;
          if (block.name !== "Agent" && block.name !== "Task") continue;
          if (callsByToolId.has(block.id)) continue;
          const input = isRecord(block.input) ? block.input : {};
          const desc = typeof input.description === "string" && input.description.trim()
            ? input.description.trim()
            : typeof input.prompt === "string" && input.prompt.trim()
              ? input.prompt.trim().slice(0, 80)
              : "Subagent";
          const agentType = typeof input.subagent_type === "string" && input.subagent_type.trim()
            ? input.subagent_type.trim()
            : undefined;
          callsByToolId.set(block.id, {
            toolUseId: block.id,
            ...(agentType ? { agentType } : {}),
            description: desc,
            startedAt: ts,
            updatedAt: ts,
          });
        }
      } else if (value.type === "user") {
        if (Array.isArray(value.message.content)) {
          for (const block of value.message.content) {
            if (!isRecord(block) || block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
            const call = callsByToolId.get(block.tool_use_id);
            if (!call) continue;
            const txt = textFromContent(block.content);
            const match = txt.match(/agentId:\s*([^\s(]+)/u);
            if (match?.[1]) {
              call.agentId = match[1];
              toolIdByAgentId.set(match[1], call.toolUseId);
            } else if (txt && !/Async agent launched/iu.test(txt)) {
              call.reportText = txt;
              call.updatedAt = Math.max(call.updatedAt, ts);
            }
          }
        }
        const rawText = textFromContent(value.message.content);
        const agentMsgMatch = rawText.match(/<agent-message\s+from="([^"]+)"[^>]*>([\s\S]*?)<\/agent-message>/u);
        if (agentMsgMatch?.[1] && agentMsgMatch[2]) {
          let body = agentMsgMatch[2].trim();
          body = body.replace(/^\[Subagent hand-back\][\s\S]*?The report follows:\s*\n?/u, "");
          body = body.split("\n").map((l) => l.replace(/^ {2}/u, "")).join("\n").trim();
          if (body) {
            reportsByAgentId.set(agentMsgMatch[1], { text: body, at: ts });
          }
        }
      }
    }
  } catch {
    return [];
  }

  const results: BridgeSubagentSummary[] = [];
  for (const call of callsByToolId.values()) {
    const agentId = call.agentId ?? call.toolUseId;
    const report = call.agentId ? reportsByAgentId.get(call.agentId) : undefined;
    const reportText = report?.text ?? call.reportText;
    const updatedAt = Math.max(call.updatedAt, report?.at ?? 0);
    const finished = Boolean(reportText) || (!processAlive && Date.now() - updatedAt > 180_000);
    results.push({
      agentId,
      toolUseId: call.toolUseId,
      ...(call.agentType ? { agentType: call.agentType } : {}),
      description: call.description,
      state: finished ? "completed" : "running",
      toolCount: 0,
      ...(reportText ? { reportText: clipText(reportText, MAX_SUBAGENT_REPORT_BYTES).text } : {}),
      startedAt: call.startedAt,
      updatedAt,
      durationMs: Math.max(0, updatedAt - call.startedAt),
    });
  }
  if (parentSubagentCache.size > 128) {
    const oldestKey = parentSubagentCache.keys().next().value;
    if (typeof oldestKey === "string") parentSubagentCache.delete(oldestKey);
  }
  parentSubagentCache.set(transcriptPath, { signature: cacheSignature, summaries: results });
  return results;
}

export async function readClaudeTranscriptSubagents(
  transcriptPath: string,
  processAlive = false,
): Promise<BridgeSubagentSummary[]> {
  const subagentsDir = subagentsDirectoryForTranscript(transcriptPath);
  const [files, parentCalls] = await Promise.all([
    collectSubagentJsonlFiles(subagentsDir),
    parseParentTranscriptSubagents(transcriptPath, processAlive),
  ]);
  const parsedFiles = files.length > 0
    ? (await Promise.all(files.map((file) => parseSingleSubagentFile(file, processAlive))))
        .filter((item): item is BridgeSubagentSummary => item !== undefined)
    : [];
  const byKey = new Map<string, BridgeSubagentSummary>();
  for (const call of parentCalls) {
    byKey.set(call.toolUseId ?? call.agentId, call);
  }
  for (const fileItem of parsedFiles) {
    const key = fileItem.toolUseId
      ?? parentCalls.find((c) => c.agentId === fileItem.agentId)?.toolUseId
      ?? fileItem.agentId;
    const existing = byKey.get(key);
    byKey.set(key, existing
      ? {
          ...existing,
          ...fileItem,
          ...(fileItem.toolUseId ?? existing.toolUseId ? { toolUseId: fileItem.toolUseId ?? existing.toolUseId } : {}),
          ...(fileItem.reportText ? { reportText: fileItem.reportText } : existing.reportText ? { reportText: existing.reportText } : {}),
        }
      : fileItem);
  }
  return [...byKey.values()]
    .sort((left, right) => left.startedAt - right.startedAt || left.agentId.localeCompare(right.agentId));
}

export async function readClaudeSessionSubagents(
  projectsRoot: string,
  sessionId: string,
  cwd?: string,
  processAlive = false,
): Promise<BridgeSubagentSummary[]> {
  const path = await findClaudeTranscriptFile(projectsRoot, sessionId, cwd);
  if (!path) return [];
  return readClaudeTranscriptSubagents(path, processAlive);
}
