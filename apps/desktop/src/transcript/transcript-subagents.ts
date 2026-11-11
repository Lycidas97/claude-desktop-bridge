import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { BridgeBackgroundTask, BridgeSubagentSummary } from "@bridge/protocol";
import { parseClaudeTranscriptSnapshot } from "./claude-history.js";
import {
  findClaudeTranscriptFile,
  isNonDagTranscriptRecord,
  isRecord,
  textFromContent,
  toolUses,
} from "./transcript-dag.js";

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
