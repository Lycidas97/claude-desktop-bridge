import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { findClaudeTranscriptFile, isNonDagTranscriptRecord, isNonTurnUserRecord, resolveTranscriptParentUuid } from "./claude-history.js";
import type { ClaudeRuntimePaths } from "./platform.js";
import type { CommandEvidence, CommandEvidenceQuery, SessionEventLog } from "./session-event-log.js";

export type { CommandEvidence } from "./session-event-log.js";

/** Read durable receipts, then follow only this input's native transcript branch. */
export async function readCommandEvidence(
  eventLog: SessionEventLog,
  paths: Pick<ClaudeRuntimePaths, "projects">,
  turn: CommandEvidenceQuery & { sessionCwd?: string },
  nativeSessionId?: string,
): Promise<CommandEvidence> {
  await eventLog.initialize();
  const evidence = eventLog.turnEvidence(turn);
  if (evidence.terminal || !evidence.messageId) return evidence;
  const path = await findClaudeTranscriptFile(paths.projects, nativeSessionId ?? turn.sessionId, turn.sessionCwd);
  if (!path) return evidence;

  const descendants = new Set<string>();
  const nodes = new Map<string, { uuid: string; parentUuid?: string }>();
  let lastMainUuid: string | undefined;
  const lines = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  for await (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // The host may still be writing the final JSONL record.
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const node = parsed as Record<string, unknown>;
    if (typeof node.uuid !== "string" || node.isSidechain || isNonDagTranscriptRecord(node)) continue;
    const parentUuid = nodes.get(node.uuid)?.parentUuid ?? resolveTranscriptParentUuid(node, nodes, lastMainUuid);
    nodes.set(node.uuid, { uuid: node.uuid, ...(parentUuid ? { parentUuid } : {}) });
    lastMainUuid = node.uuid;
    const message = node.message && typeof node.message === "object"
      ? node.message as { stop_reason?: unknown; content?: unknown }
      : undefined;
    const rawText = typeof message?.content === "string" ? message.content
      : Array.isArray(message?.content) ? message.content.flatMap((block) => (
          block?.type === "text" && typeof block.text === "string" ? [block.text] : []
        )).join("\n") : "";
    if (node.uuid === evidence.messageId && node.type === "user") {
      evidence.submitted = true;
      evidence.accepted = true;
      descendants.add(node.uuid);
      continue;
    }
    if (!parentUuid || !descendants.has(parentUuid)) continue;
    if (node.type === "user" && !isNonTurnUserRecord(node, rawText) && node.toolUseResult === undefined && node.tool_use_result === undefined && !(
      Array.isArray(message?.content) && message.content.some((block) => (
        block && typeof block === "object" && block.type === "tool_result"
      ))
    )) continue;
    descendants.add(node.uuid);
    if (node.type === "assistant" && (
      message?.stop_reason === "end_turn" || message?.stop_reason === "stop_sequence"
    )) {
      evidence.terminal = "completed";
      break;
    }
  }
  return evidence;
}
