import { createReadStream } from "node:fs";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import {
  isClaudeTranscriptControlMessage,
  type BridgeBackgroundTask,
  type BridgeHistoryPage,
  type BridgeInteractiveAction,
  type BridgeInteractivePrompt,
  type BridgeInteractiveQuestion,
  type BridgeSubagentSummary,
  type BridgeTaskPlan,
  type ClaudeHistoryMessage,
} from "@bridge/protocol";

const SAFE_SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const MAX_HISTORY_MESSAGES = 50;
const MAX_HISTORY_TEXT_BYTES = 256 * 1024;
const MAX_TOOL_RESULT_BYTES = 256 * 1024;

interface TranscriptNode {
  index: number;
  uuid: string;
  parentUuid?: string;
  type?: "user" | "assistant";
  stopReason?: string;
  interruptedBoundary?: boolean;
  nonTurnUser?: boolean;
  peerInput?: boolean;
  toolResult?: boolean;
  role?: ClaudeHistoryMessage["role"];
  text?: string;
  interactivePrompt?: BridgeInteractivePrompt;
  tools?: Array<{ id: string; name: string; stopTaskId?: string }>;
  results?: Array<{ id: string; failed?: boolean; backgroundTaskId?: string; stoppedTaskId?: string }>;
  backgroundShellUpdates?: Array<{ taskId: string; pending: boolean }>;
  planUpdates?: Array<{ id: string; input: Record<string, unknown>; wrapUp: boolean }>;
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
  /** Selected DAG ancestry, independent of the visible-message page budget. */
  branch?: {
    uuids: string[];
    inheritedUuids: string[];
    excludedMessageUuids: string[];
    excludedToolUseIds: string[];
    /** Explicitly failed plan operations on this branch, including already imported cards. */
    failedPlanToolUseIds?: string[];
    /** Undefined when missing ancestry prevents establishing a safe boundary. */
    forkBaseMessageUuid?: string | null;
  };
  available: boolean;
  messages: ClaudeHistoryMessage[];
  truncated: boolean;
}

export interface ClaudeHistoryReadOptions {
  includeBranch?: boolean;
  beforeCursor?: string;
  before?: { createdAt: number; id: string };
  chronological?: boolean;
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
      } else if (/(^|_)(files|paths|file_?path|path|notebook_?path|output_?path|destination|dest)$/iu.test(key)) {
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

function transcriptEvidenceNode(
  value: Record<string, unknown>,
  index: number,
  nodes: ReadonlyMap<string, TranscriptEvidenceNode>,
  lastMainUuid?: string,
): TranscriptEvidenceNode | undefined {
  if (typeof value.uuid !== "string" || !value.uuid || isNonDagTranscriptRecord(value)) return undefined;
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
      const fragments: Buffer[] = this.pending.byteLength ? [this.pending] : [];
      for await (const chunk of createReadStream(path, {
        start: this.offset,
        end: metadata.size - 1,
      })) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        let start = 0;
        for (let newline = bytes.indexOf(0x0a); newline >= 0; newline = bytes.indexOf(0x0a, start)) {
          const line = bytes.subarray(start, newline);
          if (fragments.length) {
            fragments.push(line);
            this.acceptLine(Buffer.concat(fragments).toString("utf8"));
            fragments.length = 0;
          } else {
            this.acceptLine(line.toString("utf8"));
          }
          start = newline + 1;
        }
        if (start < bytes.byteLength) fragments.push(bytes.subarray(start));
      }
      this.offset = metadata.size;
      this.pending = Buffer.concat(fragments);
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

export function isNonTurnUserRecord(value: Record<string, unknown>, rawText: string): boolean {
  return (
    value.isMeta === true ||
    value.isCompactSummary === true ||
    isLocalCommandRecord(rawText)
  );
}

export function visibleMessage(value: Record<string, unknown>): Pick<TranscriptNode, "role" | "text"> | undefined {
  if (value.type !== "user" && value.type !== "assistant") return undefined;
  if (!isRecord(value.message)) return undefined;
  if (
    value.type === "user" &&
    (
      value.toolUseResult !== undefined ||
      value.tool_use_result !== undefined ||
      value.isMeta === true ||
      value.isCompactSummary === true ||
      value.isSynthetic === true ||
      value.isVisibleInTranscriptOnly === true
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

export function extractInteractivePrompt(value: Record<string, unknown>): BridgeInteractivePrompt | undefined {
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
          ...(typeof block.id === "string" ? { toolUseId: block.id } : {}),
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
    if (typeof v === "string" && v.trim()) {
      answers[k] = v.trim();
    } else if (Array.isArray(v)) {
      const joined = v.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()).join(", ");
      if (joined) answers[k] = joined;
    }
  }
  return Object.keys(answers).length > 0 ? answers : undefined;
}

function applyQuestionAnswers(
  prompt: BridgeInteractivePrompt,
  answers?: Record<string, string>,
): BridgeInteractivePrompt {
  if (prompt.kind !== "question" || !prompt.questions) return prompt;
  return {
    ...prompt,
    answered: true,
    questions: prompt.questions.map((q) => {
      const answer = answers?.[q.question];
      if (!answer) return q;
      const selectedSet = new Set(answer.split(", ").map((part) => part.trim()).filter(Boolean));
      return {
        ...q,
        answer,
        options: q.options.map((opt) => (
          opt.label === answer || selectedSet.has(opt.label) ? { ...opt, selected: true } : opt
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

function trimHistory(
  messages: ClaudeHistoryMessage[],
  options: ClaudeHistoryReadOptions = {},
): { messages: ClaudeHistoryMessage[]; truncated: boolean; nextCursor?: string } {
  // Composed history uses timestamp + code-unit ID cursors across sources.
  // Apply that order before slicing so equal timestamps cannot strand a message.
  if (options.chronological) {
    messages = [...messages].sort((left, right) => left.createdAt - right.createdAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  }
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
    const interactiveBytes = message.interactivePrompt
      ? Buffer.byteLength(JSON.stringify(message.interactivePrompt))
      : 0;
    const planBytes = message.taskPlan ? Buffer.byteLength(JSON.stringify(message.taskPlan)) : 0;
    const cost = Buffer.byteLength(message.text) + interactiveBytes + planBytes + 180;
    if (selected.length > 0 && bytes + cost > MAX_HISTORY_TEXT_BYTES) {
      truncated = true;
      break;
    }
    selected.unshift(message);
    bytes += cost;
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

export interface ClaudeForkBoundary {
  parentSessionId: string;
  parentNativeSessionId: string;
  parentDesktopSessionId: string;
  baseMessageUuid: string | null;
  reason: "before-active-turn" | "completed-head" | "empty";
}

export interface ClaudeTranscriptSnapshot extends ClaudeHistoryReadResult {
  nextCursor?: string;
  userMessages: ClaudeHistoryMessage[];
  atTurnBoundary?: boolean;
  waitingForUserInput?: boolean;
  /** Background Bash tasks on the selected branch with no recorded terminal signal; not proof of process liveness. */
  pendingBackgroundShellTaskIds?: string[];
  pendingUserMessageId?: string;
  /** Peer text inputs on the selected parent chain, with explicit terminal evidence only. */
  peerInputs?: Array<{ messageId: string; completed: boolean; interrupted?: boolean }>;
  terminalUuid?: string;
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
  waitingForUserInput?: boolean;
  pendingBackgroundShellTaskIds: string[];
  pendingUserMessageId?: string;
  peerInputs: NonNullable<ClaudeTranscriptSnapshot["peerInputs"]>;
  terminalUuid?: string;
  branch: NonNullable<ClaudeTranscriptSnapshot["branch"]>;
}>();

export function updateClaudeTaskPlan(previous: BridgeTaskPlan | undefined, id: string, input: Record<string, unknown>, wrapUp: boolean, at: number): BridgeTaskPlan | undefined {
  if (wrapUp) return previous ? { ...previous, items: previous.items.map(item => ({ ...item, status: "completed" })), updatedAt: Math.max(at, previous.updatedAt + 1) } : undefined;
  if ("items" in input) {
    if (!Array.isArray(input.items) || input.items.length === 0 || !input.items.every(item => isRecord(item) && typeof item.content === "string" && item.content.trim() && typeof item.status === "string" && ["pending", "in_progress", "completed"].includes(item.status))) return previous;
    const items = input.items.map(item => ({ content: String(item.content).trim(), status: item.status as BridgeTaskPlan["items"][number]["status"] }));
    const fresh = !previous || input.scope === "new_task" || input.scope === "first_task";
    return { id: fresh ? id : previous.id, items, updatedAt: fresh ? at : Math.max(at, previous.updatedAt + 1) };
  }
  if (!previous) return undefined;
  const items = previous.items.map(item => ({ ...item }));
  if (input.advance === true) {
    const current = items.find(item => item.status === "in_progress");
    if (current) current.status = "completed";
    const next = items.find(item => item.status === "pending");
    if (next) next.status = "in_progress";
  }
  for (const index of Array.isArray(input.done) ? input.done : []) if (typeof index === "number" && Number.isInteger(index) && items[index - 1]) items[index - 1]!.status = "completed";
  if (typeof input.start === "number" && Number.isInteger(input.start) && items[input.start - 1]) {
    for (const item of items) if (item.status === "in_progress") item.status = "pending";
    items[input.start - 1]!.status = "in_progress";
  }
  return items.some((item, index) => item.status !== previous.items[index]!.status)
    ? { ...previous, items, updatedAt: Math.max(at, previous.updatedAt + 1) } : previous;
}

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
      branch: cached.branch,
      ...(cached.terminalUuid ? { terminalUuid: cached.terminalUuid } : {}),
      ...(cached.atTurnBoundary !== undefined ? { atTurnBoundary: cached.atTurnBoundary } : {}),
      ...(cached.waitingForUserInput ? { waitingForUserInput: true } : {}),
      pendingBackgroundShellTaskIds: cached.pendingBackgroundShellTaskIds,
      peerInputs: cached.peerInputs,
      ...(cached.pendingUserMessageId ? { pendingUserMessageId: cached.pendingUserMessageId } : {}),
    };
  }

  const nodes = new Map<string, TranscriptNode>();
  const referencedParents = new Set<string>();
  const userMessages: ClaudeHistoryMessage[] = [];
  let index = 0;
  let lastMainUuid: string | undefined;
  let inheritedHead: string | null | undefined;
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
      if (!isRecord(value) || value.isSidechain === true) continue;
      if (value.type === "custom-title" && isRecord(value.bridgeFork) &&
        (typeof value.bridgeFork.baseMessageUuid === "string" || value.bridgeFork.baseMessageUuid === null)) {
        inheritedHead = value.bridgeFork.baseMessageUuid;
      }
      if (isNonDagTranscriptRecord(value)) continue;
      const message = isRecord(value.message) ? value.message : undefined;
      const rawText = message ? textFromContent(message.content)
        : value.type === "attachment" && isRecord(value.attachment) && value.attachment.type === "queued_command"
          ? textFromContent(value.attachment.prompt) : "";
      const backgroundShellUpdates: NonNullable<TranscriptNode["backgroundShellUpdates"]> = [];
      if ((value.type === "user" || value.type === "attachment") && rawText.trimStart().startsWith("<task-notification>")) {
        const status = /<status>(\w+)<\/status>/u.exec(rawText)?.[1];
        if (status && ["completed", "failed", "stopped", "killed"].includes(status)) {
          for (const match of rawText.matchAll(/<task-id>([^<]+)<\/task-id>/gu)) {
            backgroundShellUpdates.push({ taskId: match[1]!, pending: false });
          }
        }
      }
      if (value.isSidechain !== true && value.type === "attachment" && isRecord(value.attachment)) {
        const task = value.attachment;
        if (task.type === "task_status" && task.taskType === "local_bash" && typeof task.taskId === "string" && typeof task.status === "string") {
          if (["running", "pending", "paused"].includes(task.status)) {
            backgroundShellUpdates.push({ taskId: task.taskId, pending: true });
          } else if (["completed", "failed", "stopped", "killed"].includes(task.status)) {
            backgroundShellUpdates.push({ taskId: task.taskId, pending: false });
          }
        }
      }
      if (typeof value.uuid !== "string" || !value.uuid) {
        // Compacted task attachments may lack a UUID; keep them with their DAG anchor.
        const anchor = lastMainUuid ? nodes.get(lastMainUuid) : undefined;
        if (anchor && backgroundShellUpdates.length) (anchor.backgroundShellUpdates ??= []).push(...backgroundShellUpdates);
        continue;
      }
      const existing = nodes.get(value.uuid);
      const parentUuid = existing?.parentUuid ?? resolveTranscriptParentUuid(value, nodes, lastMainUuid);
      if (parentUuid) referencedParents.add(parentUuid);
      const visible = visibleMessage(value);
      const parsedAt = typeof value.timestamp === "string" ? Date.parse(value.timestamp) : Number.NaN;
      const createdAt = existing?.createdAt || (Number.isFinite(parsedAt) ? parsedAt : 0);
      const type = value.type === "user" || value.type === "assistant"
        ? value.type
        : existing?.type;
      const role = visible?.role ?? existing?.role;
      const text = visible?.text ?? existing?.text;
      const interactivePrompt = extractInteractivePrompt(value) ?? existing?.interactivePrompt;
      const tools = value.type === "assistant" ? toolUses(message?.content).map((tool) => ({
        id: tool.id,
        name: tool.name,
        ...(tool.name === "TaskStop" && isRecord(tool.input) && typeof tool.input.task_id === "string"
          ? { stopTaskId: tool.input.task_id } : {}),
      })) : [];
      const directResult = isRecord(value.toolUseResult) ? value.toolUseResult
        : isRecord(value.tool_use_result) ? value.tool_use_result : undefined;
      const results = value.type === "user" && Array.isArray(message?.content)
        ? message.content.flatMap((block) => {
            if (!isRecord(block) || block.type !== "tool_result" || typeof block.tool_use_id !== "string") return [];
            return [{
              id: block.tool_use_id,
              ...(block.is_error === true ? { failed: true } : {}),
              ...(typeof directResult?.backgroundTaskId === "string" && block.is_error !== true
                ? { backgroundTaskId: directResult.backgroundTaskId } : {}),
              ...(typeof directResult?.task_id === "string" && block.is_error !== true &&
                typeof directResult.message === "string" && directResult.message.startsWith("Successfully stopped task:")
                ? { stoppedTaskId: directResult.task_id } : {}),
            }];
          })
        : [];
      const planUpdates = value.type === "assistant" && Array.isArray(message?.content)
        ? message.content.flatMap((block) => {
            if (!isRecord(block) || block.type !== "tool_use" || typeof block.id !== "string" || !isRecord(block.input) ||
              (block.name !== "mcp__ccd_turn__update_plan" && block.name !== "mcp__ccd_turn__wrap_up")) return [];
            return [{ id: block.id, input: block.input, wrapUp: block.name === "mcp__ccd_turn__wrap_up" }];
          })
        : [];
      const toolResultAnswers = extractToolResultAnswers(value) ?? existing?.toolResultAnswers;
      const toolResult = existing?.toolResult || (value.type === "user" && (
        value.toolUseResult !== undefined || value.tool_use_result !== undefined ||
        (Array.isArray(message?.content) && message.content.some((block) => isRecord(block) && block.type === "tool_result"))
      ));
      const peerInput = existing?.peerInput || (value.type === "user" && message?.role === "user" &&
        isRecord(value.origin) && value.origin.kind === "peer" && !toolResult &&
        value.isCompactSummary !== true && !isLocalCommandRecord(rawText) &&
        !isClaudeTranscriptControlMessage("user", rawText) &&
        (typeof message.content === "string" ? Boolean(message.content.trim()) :
          Array.isArray(message.content) && message.content.some((block) =>
            isRecord(block) && block.type === "text" && typeof block.text === "string" && block.text.trim())));
      nodes.set(value.uuid, {
        index: existing?.index ?? index,
        uuid: value.uuid,
        ...(parentUuid ? { parentUuid } : {}),
        ...(type ? { type } : {}),
        ...(existing?.interruptedBoundary || (value.type === "user" && isClaudeTranscriptControlMessage("user", rawText))
          ? { interruptedBoundary: true }
          : {}),
        ...(!peerInput && (existing?.nonTurnUser || (value.type === "user" && isNonTurnUserRecord(value, rawText)))
          ? { nonTurnUser: true }
          : {}),
        ...(peerInput ? { peerInput: true } : {}),
        ...(toolResult ? { toolResult: true } : {}),
        ...(message && typeof message.stop_reason === "string"
          ? { stopReason: message.stop_reason }
          : existing?.stopReason
            ? { stopReason: existing.stopReason }
            : {}),
        ...(role ? { role } : {}),
        ...(text ? { text } : {}),
        ...(interactivePrompt ? { interactivePrompt } : {}),
        ...(tools.length ? { tools } : existing?.tools ? { tools: existing.tools } : {}),
        ...(results.length ? { results } : existing?.results ? { results: existing.results } : {}),
        ...(backgroundShellUpdates.length ? { backgroundShellUpdates }
          : existing?.backgroundShellUpdates ? { backgroundShellUpdates: existing.backgroundShellUpdates } : {}),
        ...(planUpdates.length ? { planUpdates } : existing?.planUpdates ? { planUpdates: existing.planUpdates } : {}),
        ...(toolResultAnswers ? { toolResultAnswers } : {}),
        createdAt,
      });
      if (value.isSidechain !== true) lastMainUuid = value.uuid;
      if (!existing && visible?.role === "user" && visible.text) {
        userMessages.push({
          id: value.uuid,
          role: "user",
          text: visible.text,
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
  if (!terminal) return {
    available: true, messages: [], truncated: false, userMessages, atTurnBoundary: true,
    pendingBackgroundShellTaskIds: [], branch: { uuids: [], inheritedUuids: [], excludedMessageUuids: [], excludedToolUseIds: [], forkBaseMessageUuid: null },
  };
  const atTurnBoundary = transcriptTurnBoundary(nodes, terminal);
  let pendingUserMessageId: string | undefined;
  if (!atTurnBoundary) {
    let boundaryNode: TranscriptNode | undefined = terminal;
    const boundarySeen = new Set<string>();
    // Tool results are user records too; match an interrupted tool chain to
    // the actual input that started it, never to a later input or notification.
    while (boundaryNode && !boundarySeen.has(boundaryNode.uuid)) {
      boundarySeen.add(boundaryNode.uuid);
      if (boundaryNode.interruptedBoundary) break;
      if (boundaryNode.type === "user" && !boundaryNode.nonTurnUser && !boundaryNode.toolResult) {
        pendingUserMessageId = boundaryNode.uuid;
        break;
      }
      boundaryNode = boundaryNode.parentUuid ? nodes.get(boundaryNode.parentUuid) : undefined;
    }
  }

  const chain: TranscriptNode[] = [];
  const seen = new Set<string>();
  let current: TranscriptNode | undefined = terminal;
  while (current && !seen.has(current.uuid)) {
    seen.add(current.uuid);
    chain.push(current);
    current = current.parentUuid ? nodes.get(current.parentUuid) : undefined;
  }
  chain.reverse();

  const inheritedIndex = inheritedHead ? nodes.get(inheritedHead)?.index ?? -1 : -1;
  const inheritedUuids = new Set(chain.filter((node) => node.index <= inheritedIndex).map((node) => node.uuid));
  // Steering inputs and tool results remain part of the unfinished round. Only
  // explicit completion/interruption evidence establishes its preceding boundary.
  const completedHead = [...chain].reverse().find((node) => node.interruptedBoundary ||
    (node.type === "assistant" && ["end_turn", "max_tokens", "stop_sequence", "refusal", "model_context_window_exceeded"].includes(node.stopReason ?? "")));
  const branch: NonNullable<ClaudeTranscriptSnapshot["branch"]> = {
    uuids: chain.map((node) => node.uuid), inheritedUuids: [...inheritedUuids],
    excludedMessageUuids: [...nodes.keys()].filter((uuid) => !seen.has(uuid)),
    excludedToolUseIds: [...nodes.values()].filter((node) => !seen.has(node.uuid)).flatMap((node) => (node.tools ?? []).map((tool) => tool.id)),
    ...(atTurnBoundary ? { forkBaseMessageUuid: terminal.uuid }
      : completedHead ? { forkBaseMessageUuid: completedHead.uuid }
      : !chain[0]?.parentUuid && chain[0]?.type === "user" && !chain[0].nonTurnUser && !chain[0].toolResult
        ? { forkBaseMessageUuid: null } : {}),
  };

  const pendingTools = new Map<string, NonNullable<TranscriptNode["tools"]>[number]>();
  const failedTools = new Map<string, number>();
  const backgroundShellTasks = new Set<string>();
  const peerInputs: NonNullable<ClaudeTranscriptSnapshot["peerInputs"]> = [];
  let currentPeerInput: typeof peerInputs[number] | undefined;
  let lastAssistantStopReason: string | undefined;
  for (const node of chain) {
    for (const result of node.results ?? []) {
      if (result.failed) failedTools.set(result.id, node.createdAt);
    }
    if (inheritedUuids.has(node.uuid)) continue;
    if (node.type === "user" && (node.interruptedBoundary || (!node.nonTurnUser && !node.toolResult))) {
      pendingTools.clear();
      lastAssistantStopReason = undefined;
      if (node.interruptedBoundary && currentPeerInput) currentPeerInput.interrupted = true;
      currentPeerInput = node.peerInput ? { messageId: node.uuid, completed: false } : undefined;
      if (currentPeerInput) peerInputs.push(currentPeerInput);
    }
    if (node.type === "assistant") {
      lastAssistantStopReason = node.stopReason;
      if (currentPeerInput && ["end_turn", "max_tokens", "stop_sequence", "refusal", "model_context_window_exceeded"].includes(node.stopReason ?? "")) {
        currentPeerInput.completed = true;
        currentPeerInput = undefined;
      }
      for (const tool of node.tools ?? []) pendingTools.set(tool.id, tool);
    }
    for (const result of node.results ?? []) {
      const tool = pendingTools.get(result.id);
      if (tool?.name === "Bash" && result.backgroundTaskId) backgroundShellTasks.add(result.backgroundTaskId);
      if (tool?.name === "TaskStop" && result.stoppedTaskId && result.stoppedTaskId === tool.stopTaskId) {
        backgroundShellTasks.delete(result.stoppedTaskId);
      }
      pendingTools.delete(result.id);
    }
    for (const update of node.backgroundShellUpdates ?? []) {
      if (update.pending) backgroundShellTasks.add(update.taskId);
      else backgroundShellTasks.delete(update.taskId);
    }
  }
  const waitingForUserInput = lastAssistantStopReason === "tool_use" && pendingTools.size > 0
    && [...pendingTools.values()].every((tool) => tool.name === "AskUserQuestion");
  const pendingBackgroundShellTaskIds = [...backgroundShellTasks];

  const messages: ClaudeHistoryMessage[] = [];
  let pendingInteractive: { node: TranscriptNode; prompt: BridgeInteractivePrompt } | undefined;
  let planMessage: ClaudeHistoryMessage | undefined;
  for (const node of chain) {
    for (const update of node.planUpdates ?? []) {
      const failedAt = failedTools.get(update.id);
      if (failedAt !== undefined) {
        (branch.failedPlanToolUseIds ??= []).push(update.id);
        if (planMessage?.taskPlan) {
          // A correction must supersede a provisional update, even with equal timestamps.
          planMessage.taskPlan.updatedAt = Math.max(failedAt, node.createdAt + 1, planMessage.taskPlan.updatedAt + 2);
        }
        continue;
      }
      const plan = updateClaudeTaskPlan(planMessage?.taskPlan, update.id, update.input, update.wrapUp, node.createdAt);
      if (plan) {
        if (!planMessage || plan.id !== planMessage.taskPlan?.id) {
          planMessage = { id: `plan:${plan.id}`, role: "assistant", text: "", createdAt: node.createdAt, taskPlan: plan };
          messages.push(planMessage);
        } else planMessage.taskPlan = plan;
      }
      if (update.wrapUp) planMessage = undefined;
    }
    if (node.interactivePrompt) {
      const previous = messages.at(-1);
      if (node.interactivePrompt.kind === "question") {
        if (node.text) {
          pendingInteractive = { node, prompt: node.interactivePrompt };
        } else if (previous?.role === "assistant" && !previous.interactivePrompt) {
          previous.interactivePrompt = node.interactivePrompt;
        } else {
          messages.push({
            id: node.uuid,
            role: "assistant",
            text: "",
            createdAt: node.createdAt,
            interactivePrompt: node.interactivePrompt,
          });
        }
      } else if (previous?.role === "assistant") {
        previous.interactivePrompt = node.interactivePrompt;
      } else {
        pendingInteractive = { node, prompt: node.interactivePrompt };
      }
    }
    if (node.toolResult || node.toolResultAnswers) {
      if (pendingInteractive && (node.toolResultAnswers || pendingInteractive.prompt.kind === "question")) {
        pendingInteractive = {
          node: pendingInteractive.node,
          prompt: applyQuestionAnswers(pendingInteractive.prompt, node.toolResultAnswers),
        };
      } else {
        const previous = messages.at(-1);
        if (
          previous?.role === "assistant" &&
          previous.interactivePrompt &&
          (node.toolResultAnswers || previous.interactivePrompt.kind === "question")
        ) {
          previous.interactivePrompt = applyQuestionAnswers(previous.interactivePrompt, node.toolResultAnswers);
        }
      }
    }
    if (!node.role || !node.text) continue;
    const previous = messages.at(-1);
    if (node.role === "assistant") {
      if (previous?.role === "assistant" && !previous.taskPlan && previous.interactivePrompt?.kind !== "question") {
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
    branch,
    terminalUuid: terminal.uuid,
    ...(waitingForUserInput ? { waitingForUserInput: true } : {}),
    pendingBackgroundShellTaskIds,
    peerInputs,
    ...(atTurnBoundary !== undefined ? { atTurnBoundary } : {}),
    ...(pendingUserMessageId ? { pendingUserMessageId } : {}),
  });
  return {
    available: true,
    ...trimHistory(messages, options),
    userMessages,
    branch,
    atTurnBoundary,
    ...(waitingForUserInput ? { waitingForUserInput: true } : {}),
    pendingBackgroundShellTaskIds,
    peerInputs,
    terminalUuid: terminal.uuid,
    ...(pendingUserMessageId ? { pendingUserMessageId } : {}),
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
    branch: _branch,
    atTurnBoundary: _atTurnBoundary,
    pendingBackgroundShellTaskIds: _pendingBackgroundShellTaskIds,
    pendingUserMessageId: _pendingUserMessageId,
    peerInputs: _peerInputs,
    terminalUuid: _terminalUuid,
    ...result
  } = await parseClaudeTranscriptSnapshot(path, options);
  return { ...result, ...(options.includeBranch && _branch ? { branch: _branch } : {}) };
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
  const assistantGenerations = new Map<string, number>();
  let generation = 0;
  try {
    const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of lines) {
      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch {
        continue;
      }
      if (!isRecord(value)) continue;
      if (value.type === "system" && value.subtype === "compact_boundary") {
        const metadata = isRecord(value.compactMetadata) ? value.compactMetadata : value.compact_metadata;
        const postTokens = isRecord(metadata) ? metadata.postTokens ?? metadata.post_tokens : undefined;
        latest = typeof postTokens === "number" && Number.isFinite(postTokens) && postTokens >= 0
          ? { totalTokens: postTokens, ...(latest?.model ? { model: latest.model } : {}) }
          : undefined;
        generation += 1;
        continue;
      }
      if (value.type !== "assistant" || !isRecord(value.message)) continue;
      // Resume can re-emit preserved messages with their pre-compact usage.
      if (typeof value.uuid === "string") {
        if ((assistantGenerations.get(value.uuid) ?? generation) < generation) continue;
        assistantGenerations.set(value.uuid, generation);
      }
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
      ...(message.taskPlan ? { taskPlan: message.taskPlan } : {}),
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
  // A workflow journal records phase results after its agent's transcript stops changing.
  const journals = [...new Set(files.filter((file) => /[\\/]workflows[\\/]wf_[^\\/]+[\\/]agent-[^\\/]+$/u.test(file))
    .map((file) => join(dirname(file), "journal.jsonl")))];
  let maxMtime = Math.max(0, ...await Promise.all(journals.map((file) => stat(file).then((s) => s.mtimeMs, () => 0))));
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

// Subagents live inside the process that launched them, so one begun before
// every live process started (or with none alive) can no longer be running.
function subagentProcessLive(startedAt: number, liveSince: number | undefined): boolean {
  return liveSince !== undefined && startedAt >= liveSince;
}

const subagentSummaryCache = new Map<string, {
  signature: string;
  summary: BridgeSubagentSummary;
}>();

async function parseSingleSubagentFile(
  jsonlPath: string,
  liveSince: number | undefined,
): Promise<BridgeSubagentSummary | undefined> {
  const metaPath = jsonlPath.replace(/\.jsonl$/u, ".meta.json");
  const [fileStat, metaStat] = await Promise.all([
    stat(jsonlPath).catch(() => undefined),
    stat(metaPath).catch(() => undefined),
  ]);
  if (!fileStat) return undefined;
  const cacheSignature = `${fileStat.mtimeMs}:${fileStat.size}:${metaStat?.mtimeMs ?? 0}:${liveSince ?? "none"}`;
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
  let updatedAt = 0;
  let lastStopReason: string | undefined;
  let model: string | undefined;
  const structuredOutputIds = new Set<string>();

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
      if (value.type === "assistant" && value.isSynthetic !== true && isRecord(value.message)
        && typeof value.message.model === "string" && value.message.model.trim() && value.message.model !== "<synthetic>") {
        model = value.message.model;
      }
      if (value.type === "assistant" && isRecord(value.message) && Array.isArray(value.message.content)) {
        lastStopReason = typeof value.message.stop_reason === "string" ? value.message.stop_reason : undefined;
        for (const block of value.message.content) {
          if (!isRecord(block)) continue;
          if (block.type === "tool_use" && typeof block.name === "string") {
            if (block.name === "StructuredOutput" && typeof block.id === "string") structuredOutputIds.add(block.id);
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
      } else if (value.type === "user") {
        // Workflow agents end by returning accepted structured output, with no finished flag or notification.
        const content = isRecord(value.message) && Array.isArray(value.message.content) ? value.message.content : undefined;
        const output = content?.find((block) => isRecord(block) && block.type === "tool_result"
          && typeof block.tool_use_id === "string" && structuredOutputIds.has(block.tool_use_id));
        if (isRecord(output)) lastStopReason = output.is_error === true ? undefined : "structured_output";
        // Other results from the same tool batch do not start a new turn.
        else if (!content?.length || content.some((block) => !isRecord(block) || block.type !== "tool_result")) {
          lastStopReason = undefined;
        }
      }
    }
  } catch {
    return undefined;
  }

  const reportText = handbackReports.join("\n\n---\n\n");
  const explicitlyFinished = meta.finished === true || handbackReports.length > 0
    || lastStopReason === "end_turn" || lastStopReason === "structured_output";
  const description = typeof meta.description === "string" && meta.description.trim()
    ? meta.description.trim()
    : `子代理 ${agentId.slice(0, 7)}`;
  const toolUseId = typeof meta.toolUseId === "string" && meta.toolUseId
    ? meta.toolUseId
    : undefined;
  const agentType = typeof meta.agentType === "string" && meta.agentType
    ? meta.agentType
    : undefined;
  const workflowRunId = /[\\/]workflows[\\/](wf_[^\\/]+)[\\/]agent-[^\\/]+$/u.exec(jsonlPath)?.[1];
  const workflowPhase = typeof meta.workflowPhase === "string" && meta.workflowPhase ? meta.workflowPhase : undefined;
  const effectiveStartedAt = startedAt || updatedAt || Date.now();
  const effectiveUpdatedAt = Math.max(effectiveStartedAt, updatedAt || Math.round(fileStat.mtimeMs));
  const state: BridgeSubagentSummary["state"] = explicitlyFinished
    ? "completed"
    : subagentProcessLive(effectiveStartedAt, liveSince)
      ? "running"
      : "stopped";
  const completedReport = reportText || (state === "completed" ? latestText : undefined);

  const summary: BridgeSubagentSummary = {
    agentId,
    ...(toolUseId ? { toolUseId } : {}),
    ...(agentType ? { agentType } : {}),
    ...(model ? { model } : {}),
    description,
    state,
    toolCount,
    ...(recentTools.length ? { recentTools } : {}),
    ...(latestText ? { latestText } : {}),
    ...(completedReport ? { reportText: completedReport } : {}),
    startedAt: effectiveStartedAt,
    updatedAt: effectiveUpdatedAt,
    durationMs: Math.max(0, effectiveUpdatedAt - effectiveStartedAt),
    ...(workflowRunId ? { workflowRunId } : {}),
    ...(workflowPhase ? { workflowPhase } : {}),
  };
  if (subagentSummaryCache.size > 2_000) {
    const oldestKey = subagentSummaryCache.keys().next().value;
    if (typeof oldestKey === "string") subagentSummaryCache.delete(oldestKey);
  }
  subagentSummaryCache.set(jsonlPath, { signature: cacheSignature, summary });
  return summary;
}

interface ParentBackgroundLaunch {
  kind: "bash" | "workflow";
  taskId: string;
  toolUseId: string;
  runId?: string;
  name?: string;
  description: string;
  state: BridgeSubagentSummary["state"];
  startedAt: number;
  updatedAt: number;
}

interface ParentTranscriptTasks {
  summaries: BridgeSubagentSummary[];
  launches: ParentBackgroundLaunch[];
  compactedAt: number;
  taskStates: Map<string, { state: BridgeSubagentSummary["state"]; at: number }>;
  excludedTasks: Set<string>;
}

const parentSubagentCache = new Map<string, ParentTranscriptTasks & { signature: string }>();

async function parseParentTranscriptSubagents(transcriptPath: string): Promise<ParentTranscriptTasks> {
  const fileStat = await stat(transcriptPath).catch(() => undefined);
  if (!fileStat) return { summaries: [], launches: [], compactedAt: 0, taskStates: new Map(), excludedTasks: new Set() };
  const cacheSignature = `${fileStat.mtimeMs}:${fileStat.size}`;
  const cached = parentSubagentCache.get(transcriptPath);
  if (cached && cached.signature === cacheSignature) return cached;
  let compactedAt = 0;
  const taskStates = new Map<string, { state: BridgeSubagentSummary["state"]; at: number }>();

  const snapshot = await parseClaudeTranscriptSnapshot(transcriptPath, { limit: 1 });
  const selected = new Set(snapshot.branch?.uuids);
  const inherited = new Set(snapshot.branch?.inheritedUuids);
  const excludedTasks = new Set<string>();
  let anchorUuid: string | undefined;
  const callsByToolId = new Map<string, {
    inherited: boolean;
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
  const endedByAgentId = new Map<string, BridgeSubagentSummary["state"]>();
  const endedAt = new Map<string, number>();
  const stopRequests = new Map<string, string>();
  const backgroundCalls = new Map<string, { name: "Bash" | "Workflow"; description: string; inherited: boolean }>();
  const launches: Array<Omit<ParentBackgroundLaunch, "state" | "updatedAt"> & { inherited: boolean }> = [];

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
      if (!isRecord(value) || isNonDagTranscriptRecord(value)) continue;
      if (typeof value.uuid === "string") anchorUuid = value.uuid;
      if (value.isSidechain === true || (anchorUuid && !selected.has(anchorUuid))) {
        const message = isRecord(value.message) ? value.message : undefined;
        for (const tool of toolUses(message?.content)) {
          if (tool.name === "Agent" || tool.name === "Task") excludedTasks.add(tool.id);
        }
        if (Array.isArray(message?.content)) {
          for (const block of message.content) {
            if (!isRecord(block) || block.type !== "tool_result" || !excludedTasks.has(String(block.tool_use_id))) continue;
            const agentId = /agentId:\s*([^\s(]+)/u.exec(textFromContent(block.content))?.[1];
            if (agentId) excludedTasks.add(agentId);
          }
        }
        continue;
      }
      const parsedAt = typeof value.timestamp === "string" ? Date.parse(value.timestamp) : Number.NaN;
      const ts = Number.isFinite(parsedAt) && parsedAt > 0 ? parsedAt : Date.now();
      if (value.type === "system" && value.subtype === "compact_boundary") {
        compactedAt = Math.max(compactedAt, ts);
        taskStates.clear();
      }
      if (value.type === "attachment" && isRecord(value.attachment)) {
        const task = value.attachment;
        if (task.type === "task_status" && typeof task.taskId === "string"
          && (task.taskType === "local_agent" || task.taskType === "local_bash" || task.taskType === "local_workflow")
          && (task.status === "running" || task.status === "pending" || task.status === "paused"
            || task.status === "completed" || task.status === "failed" || task.status === "stopped")) {
          taskStates.set(task.taskId, {
            state: task.status === "pending" || task.status === "paused" ? "running" : task.status,
            at: ts,
          });
        }
      }
      const message = isRecord(value.message) ? value.message
        : value.type === "attachment" && isRecord(value.attachment) && value.attachment.type === "queued_command"
          ? { content: value.attachment.prompt } : undefined;
      if (!message) continue;
      if (value.type === "assistant" && Array.isArray(message.content)) {
        for (const block of message.content) {
          if (!isRecord(block) || block.type !== "tool_use" || typeof block.id !== "string") continue;
          if (block.name === "TaskStop" && isRecord(block.input) && typeof block.input.task_id === "string") {
            stopRequests.set(block.id, block.input.task_id);
            continue;
          }
          if (block.name === "Bash" || block.name === "Workflow") {
            const input = isRecord(block.input) ? block.input : {};
            const label = [input.description, input.command, input.name]
              .find((value): value is string => typeof value === "string" && Boolean(value.trim()));
            backgroundCalls.set(block.id, {
              name: block.name,
              description: label?.trim().slice(0, 120) ?? block.name,
              inherited: Boolean(anchorUuid && inherited.has(anchorUuid)),
            });
            continue;
          }
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
            inherited: Boolean(anchorUuid && inherited.has(anchorUuid)),
            toolUseId: block.id,
            ...(agentType ? { agentType } : {}),
            description: desc,
            startedAt: ts,
            updatedAt: ts,
          });
        }
      } else if (value.type === "user" || value.type === "attachment") {
        if (Array.isArray(message.content)) {
          for (const block of message.content) {
            if (!isRecord(block) || block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
            const stoppedId = stopRequests.get(block.tool_use_id);
            const result = value.toolUseResult;
            if (stoppedId && block.is_error !== true && isRecord(result) && result.task_id === stoppedId
              && typeof result.message === "string" && result.message.startsWith("Successfully stopped task:")) {
              taskStates.set(stoppedId, { state: "stopped", at: ts });
            }
            const background = backgroundCalls.get(block.tool_use_id);
            if (background && block.is_error !== true && isRecord(result)) {
              const taskId = background.name === "Bash" ? result.backgroundTaskId : result.taskId;
              if (typeof taskId === "string" && taskId) {
                const name = typeof result.workflowName === "string" && result.workflowName ? result.workflowName : undefined;
                const summary = typeof result.summary === "string" && result.summary.trim() ? result.summary.trim() : undefined;
                launches.push({
                  kind: background.name === "Bash" ? "bash" : "workflow",
                  taskId,
                  toolUseId: block.tool_use_id,
                  ...(typeof result.runId === "string" && result.runId ? { runId: result.runId } : {}),
                  ...(name ? { name } : {}),
                  description: summary ?? name ?? background.description,
                  startedAt: ts,
                  inherited: background.inherited,
                });
              }
            }
            const call = callsByToolId.get(block.tool_use_id);
            if (!call) continue;
            const txt = textFromContent(block.content);
            const match = txt.match(/agentId:\s*([^\s(]+)/u);
            if (match?.[1]) {
              call.agentId = match[1];
              toolIdByAgentId.set(match[1], call.toolUseId);
              // A resumed agent is live again until its next notification.
              endedByAgentId.delete(match[1]);
            } else if (txt && !/Async agent launched/iu.test(txt)) {
              call.reportText = txt;
              call.updatedAt = Math.max(call.updatedAt, ts);
            }
          }
        }
        const rawText = textFromContent(message.content);
        if (rawText.trimStart().startsWith("<task-notification>")) {
          const status = /<status>(\w+)<\/status>/u.exec(rawText)?.[1];
          if (status) {
            // One notification can end several tasks.
            for (const match of rawText.matchAll(/<task-id>([^<]+)<\/task-id>/gu)) {
              endedByAgentId.set(match[1]!, status === "completed" ? "completed" : status === "failed" ? "failed" : "stopped");
              endedAt.set(match[1]!, ts);
            }
          }
        }
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
    return { summaries: [], launches: [], compactedAt: 0, taskStates: new Map(), excludedTasks };
  }

  const results: BridgeSubagentSummary[] = [];
  for (const call of callsByToolId.values()) {
    const agentId = call.agentId ?? call.toolUseId;
    const report = call.agentId ? reportsByAgentId.get(call.agentId) : undefined;
    const reportText = report?.text ?? call.reportText;
    const updatedAt = Math.max(call.updatedAt, report?.at ?? 0);
    results.push({
      agentId,
      toolUseId: call.toolUseId,
      ...(call.agentType ? { agentType: call.agentType } : {}),
      description: call.description,
      state: endedByAgentId.get(agentId) ?? (reportText ? "completed" : call.inherited ? "unknown" : "running"),
      toolCount: 0,
      ...(reportText ? { reportText } : {}),
      startedAt: call.startedAt,
      updatedAt,
      durationMs: Math.max(0, updatedAt - call.startedAt),
    });
  }
  if (parentSubagentCache.size > 128) {
    const oldestKey = parentSubagentCache.keys().next().value;
    if (typeof oldestKey === "string") parentSubagentCache.delete(oldestKey);
  }
  const result: ParentTranscriptTasks = {
    summaries: results,
    launches: launches.map(({ inherited: inheritedLaunch, ...launch }) => {
      const task = taskStates.get(launch.taskId);
      const ended = endedByAgentId.get(launch.taskId) ?? (task && task.state !== "running" ? task.state : undefined);
      return {
        ...launch,
        state: ended ?? (inheritedLaunch ? "unknown" : "running"),
        updatedAt: Math.max(launch.startedAt, endedAt.get(launch.taskId) ?? task?.at ?? 0),
      };
    }),
    compactedAt, taskStates, excludedTasks,
  };
  parentSubagentCache.set(transcriptPath, { signature: cacheSignature, ...result });
  return result;
}

/**
 * @param liveSince Start of the oldest live process for this session; undefined when none is alive.
 */
export async function readClaudeTranscriptSubagents(
  transcriptPath: string,
  liveSince?: number,
): Promise<BridgeSubagentSummary[]> {
  const subagentsDir = subagentsDirectoryForTranscript(transcriptPath);
  const [files, parent] = await Promise.all([
    collectSubagentJsonlFiles(subagentsDir),
    parseParentTranscriptSubagents(transcriptPath),
  ]);
  const parentCalls = parent.summaries;
  const parsedFiles = files.length > 0
    ? (await Promise.all(files.map((file) => parseSingleSubagentFile(file, liveSince))))
        .filter((item): item is BridgeSubagentSummary => item !== undefined)
    : [];
  const byKey = new Map<string, BridgeSubagentSummary>();
  const withChildFile = new Set<string>();
  for (const call of parentCalls) {
    byKey.set(call.toolUseId ?? call.agentId, call);
  }
  for (const fileItem of parsedFiles) {
    if (parent.excludedTasks.has(fileItem.agentId) || (fileItem.toolUseId && parent.excludedTasks.has(fileItem.toolUseId))) continue;
    const key = fileItem.toolUseId
      ?? parentCalls.find((c) => c.agentId === fileItem.agentId)?.toolUseId
      ?? fileItem.agentId;
    const existing = byKey.get(key);
    withChildFile.add(key);
    byKey.set(key, existing
      ? {
          ...existing,
          ...fileItem,
          state: fileItem.state === "completed" || existing.state === "running" ? fileItem.state : existing.state,
          ...(fileItem.toolUseId ?? existing.toolUseId ? { toolUseId: fileItem.toolUseId ?? existing.toolUseId } : {}),
          ...(fileItem.reportText ? { reportText: fileItem.reportText } : existing.reportText ? { reportText: existing.reportText } : {}),
        }
      : fileItem);
  }
  return [...byKey.entries()]
    .map(([key, subagent]) => {
      const task = parent.taskStates.get(subagent.agentId);
      if (task && subagent.state === "running" && task.at >= subagent.startedAt) {
        if (task.state !== "running") return { ...subagent, state: task.state, updatedAt: Math.max(subagent.updatedAt, task.at) };
        if (subagentProcessLive(subagent.startedAt, liveSince)) return subagent;
      }
      if (subagent.state === "running" && !withChildFile.has(key) && !subagentProcessLive(subagent.startedAt, liveSince)) {
        return { ...subagent, state: "stopped" as const };
      }
      // Compaction carries the current task list. Missing historical tasks have no confirmed live owner.
      if (subagent.state === "running" && subagent.startedAt < parent.compactedAt && subagent.updatedAt < parent.compactedAt) {
        return { ...subagent, state: "unknown" as const, updatedAt: Math.max(subagent.updatedAt, parent.compactedAt) };
      }
      return subagent;
    })
    .sort((left, right) => left.startedAt - right.startedAt || left.agentId.localeCompare(right.agentId));
}

const workflowFileCache = new Map<string, { signature: string; value: unknown }>();

/** Reads a small file once per mtime/size; parse failures surface as undefined (files may be mid-write). */
async function readCachedWorkflowFile<T>(path: string, parse: (text: string) => T): Promise<T | undefined> {
  const fileStat = await stat(path).catch(() => undefined);
  if (!fileStat) return undefined;
  const signature = `${fileStat.mtimeMs}:${fileStat.size}`;
  const cached = workflowFileCache.get(path);
  if (cached?.signature === signature) return cached.value as T;
  let value: T | undefined;
  try {
    value = parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
  workflowFileCache.set(path, { signature, value });
  return value;
}

/** Tray entries ride along in every session snapshot; the full report stays in history items. */
export function compactTraySubagent(subagent: BridgeSubagentSummary): BridgeSubagentSummary {
  const { reportText: _reportText, latestText, ...rest } = subagent;
  return { ...rest, ...(latestText ? { latestText: latestText.length > 280 ? `${latestText.slice(0, 279)}…` : latestText } : {}) };
}

/**
 * Live phases come from the run's journal (`started` / `result` events). The run summary is
 * only written when a run ends (and may be stale while a resumed run is live), so it only
 * contributes the phase plan and run name.
 */
async function readClaudeWorkflowRun(
  transcriptPath: string,
  runId: string,
  runState: BridgeSubagentSummary["state"],
  subagents: readonly BridgeSubagentSummary[],
): Promise<NonNullable<BridgeBackgroundTask["workflow"]>> {
  const sessionDir = transcriptPath.replace(/\.jsonl$/u, "");
  const [journal, summary] = await Promise.all([
    readCachedWorkflowFile(join(sessionDir, "subagents", "workflows", runId, "journal.jsonl"), (text) => text.split("\n").flatMap((line) => {
      try {
        const value = JSON.parse(line) as unknown;
        return isRecord(value) && typeof value.agentId === "string" ? [value] : [];
      } catch {
        return [];
      }
    })),
    readCachedWorkflowFile(join(sessionDir, "workflows", `${runId}.json`), (text) => JSON.parse(text) as unknown),
  ]);
  const phases = isRecord(summary) && Array.isArray(summary.phases)
    ? summary.phases.flatMap((phase) => isRecord(phase) && typeof phase.title === "string" ? [phase.title] : [])
    : [];
  const files = new Map(subagents.filter((agent) => agent.workflowRunId === runId).map((agent) => [agent.agentId, agent]));
  const agents = new Map<string, BridgeSubagentSummary>();
  const finished = new Set((journal ?? []).filter((event) => event.type === "result").map((event) => event.agentId as string));
  for (const event of journal ?? []) {
    if (event.type !== "started") continue;
    const agentId = event.agentId as string;
    const file = files.get(agentId);
    const phase = typeof event.phase === "string" && event.phase ? event.phase : file?.workflowPhase;
    const label = typeof event.label === "string" && event.label ? event.label : undefined;
    const state = file?.state === "failed" ? "failed"
      : finished.has(agentId) ? "completed"
        : file?.state ?? (runState === "running" ? "running" : runState);
    agents.set(agentId, {
      agentId,
      description: label ?? file?.description ?? agentId,
      state,
      toolCount: file?.toolCount ?? 0,
      startedAt: file?.startedAt ?? 0,
      updatedAt: file?.updatedAt ?? 0,
      workflowRunId: runId,
      ...(file?.model ? { model: file.model } : {}),
      ...(phase ? { workflowPhase: phase } : {}),
    });
  }
  // Workflows can run dozens of agents; members carry only what the phase timeline shows.
  for (const file of files.values()) {
    if (agents.has(file.agentId)) continue;
    const { agentId, description, state, toolCount, startedAt, updatedAt, workflowPhase } = file;
    agents.set(agentId, { agentId, description, state, toolCount, startedAt, updatedAt, workflowRunId: runId, ...(file.model ? { model: file.model } : {}), ...(workflowPhase ? { workflowPhase } : {}) });
  }
  for (const agent of agents.values()) {
    if (agent.workflowPhase && !phases.includes(agent.workflowPhase)) phases.push(agent.workflowPhase);
  }
  const name = isRecord(summary) && typeof summary.workflowName === "string" && summary.workflowName
    ? summary.workflowName : undefined;
  return { runId, ...(name ? { name } : {}), phases, agents: [...agents.values()] };
}

/**
 * Every background task the parent transcript and its `subagents/` tree know about:
 * agents (outside workflows), Workflow runs with their phase timeline, and backgrounded Bash.
 * @param subagents Result of readClaudeTranscriptSubagents for the same transcript.
 */
export async function readClaudeTranscriptBackgroundTasks(
  transcriptPath: string,
  subagents: readonly BridgeSubagentSummary[],
  liveSince?: number,
): Promise<BridgeBackgroundTask[]> {
  const parent = await parseParentTranscriptSubagents(transcriptPath);
  const tasks: BridgeBackgroundTask[] = subagents.filter((agent) => !agent.workflowRunId).map((agent) => ({
    id: agent.toolUseId ?? `task:${agent.agentId}`,
    kind: "subagent",
    taskId: agent.agentId,
    ...(agent.toolUseId ? { toolUseId: agent.toolUseId } : {}),
    description: agent.description,
    state: agent.state,
    startedAt: agent.startedAt,
    updatedAt: agent.updatedAt,
    subagent: compactTraySubagent(agent),
  }));
  // A resumed workflow relaunches the same run directory; the latest launch describes it.
  const latestRun = new Map(parent.launches.filter((launch) => launch.runId).map((launch) => [launch.runId, launch]));
  for (const launch of parent.launches) {
    if (launch.runId && latestRun.get(launch.runId) !== launch) continue;
    let state = launch.state;
    let updatedAt = launch.updatedAt;
    // Background shells and workflow runs live inside the process that launched them.
    if (state === "running" && !subagentProcessLive(launch.startedAt, liveSince)) state = "stopped";
    else if (state === "running" && launch.startedAt < parent.compactedAt && updatedAt < parent.compactedAt) {
      state = "unknown";
      updatedAt = Math.max(updatedAt, parent.compactedAt);
    }
    const workflow = launch.kind === "workflow" && launch.runId
      ? await readClaudeWorkflowRun(transcriptPath, launch.runId, state, subagents)
      : undefined;
    if (workflow) {
      updatedAt = Math.max(updatedAt, ...workflow.agents.map((agent) => agent.updatedAt));
      if (!workflow.name && launch.name) workflow.name = launch.name;
    }
    tasks.push({
      id: launch.toolUseId,
      kind: launch.kind,
      taskId: launch.taskId,
      toolUseId: launch.toolUseId,
      description: launch.description,
      state,
      startedAt: launch.startedAt,
      updatedAt,
      ...(workflow ? { workflow } : {}),
    });
  }
  return tasks.sort((left, right) => right.startedAt - left.startedAt);
}

export async function readClaudeSessionSubagents(
  projectsRoot: string,
  sessionId: string,
  cwd?: string,
  liveSince?: number,
): Promise<BridgeSubagentSummary[]> {
  const path = await findClaudeTranscriptFile(projectsRoot, sessionId, cwd);
  if (!path) return [];
  return readClaudeTranscriptSubagents(path, liveSince);
}
