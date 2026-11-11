import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { isClaudeTranscriptControlMessage } from "@bridge/protocol";
import {
  isNonDagTranscriptRecord,
  isRecord,
  resolveTranscriptParentUuid,
  textFromContent,
  toolUses,
} from "./transcript-dag.js";

const MAX_TOOL_RESULT_BYTES = 256 * 1024;

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

export async function parseClaudeTranscriptEvidence(
  path: string,
): Promise<ClaudeTranscriptEvidenceTurn[]> {
  return new ClaudeTranscriptEvidenceCursor().read(path);
}
