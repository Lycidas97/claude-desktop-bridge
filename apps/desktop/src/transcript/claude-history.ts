import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import {
  isClaudeTranscriptControlMessage,
  type BridgeHistoryPage,
  type BridgeInteractiveAction,
  type BridgeInteractivePrompt,
  type BridgeInteractiveQuestion,
  type BridgeTaskPlan,
  type ClaudeHistoryMessage,
} from "@bridge/protocol";
import {
  findClaudeTranscriptFile,
  isLocalCommandRecord,
  isNonDagTranscriptRecord,
  isNonTurnUserRecord,
  isRecord,
  resolveTranscriptParentUuid,
  textFromContent,
  toolUses,
  transcriptTurnBoundary,
  type ClaudeForkBoundary,
} from "./transcript-dag.js";

export {
  findClaudeTranscriptFile,
  isNonDagTranscriptRecord,
  isNonTurnUserRecord,
  resolveTranscriptParentUuid,
  type ClaudeForkBoundary,
};
export {
  ClaudeTranscriptEvidenceCursor,
  parseClaudeTranscriptEvidence,
  type ClaudeTranscriptEvidenceTurn,
  type ClaudeTranscriptToolEvidence,
} from "./transcript-evidence.js";
export {
  estimateClaudeContextFromMessages,
  readClaudeSessionContextEstimate,
  scanClaudeContextFromMessages,
  type ClaudeContextEstimateScan,
  type ClaudeSessionContextEstimate,
} from "./transcript-context.js";
export {
  compactTraySubagent,
  getClaudeSubagentsMtimeMs,
  readClaudeSessionSubagents,
  readClaudeTranscriptBackgroundTasks,
  readClaudeTranscriptSubagents,
} from "./transcript-subagents.js";

const MAX_HISTORY_MESSAGES = 50;
const MAX_HISTORY_TEXT_BYTES = 256 * 1024;

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

function cleanUserText(value: string): string {
  return value
    .replace(/^\s*\[来自手机 Bridge\]\s*/u, "")
    .replace(/\s*<!--\s*bridge-command:[A-Za-z0-9_-]{1,64}\s*-->\s*/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
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
