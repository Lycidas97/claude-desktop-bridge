import type {
  BridgeConversationRoute,
  BridgeHistoryItem,
  BridgeHistoryPage,
  BridgeSessionInfo,
} from "@bridge/protocol";
import { readClaudeSessionHistory, readClaudeSessionSubagents } from "./claude-history.js";
import { oldestLiveProcessStart, type ObservedClaudeSession } from "./claude-session-catalog.js";
import type { ClaudeRuntimePaths } from "./platform.js";
import type { SessionEventLog } from "./session-event-log.js";
import type { SessionTaskState } from "./session-task-state.js";

export interface SessionHistoryOptions {
  paths: Pick<ClaudeRuntimePaths, "projects">;
  eventLog: Pick<SessionEventLog, "history" | "latestTaskEvents">;
  taskState: Pick<SessionTaskState, "restore" | "historyItems" | "isInline">;
  session: Pick<BridgeSessionInfo, "sessionId" | "cwd">;
  route?: Pick<BridgeConversationRoute, "lanes"> | undefined;
  activeTurn: boolean;
  observedSessions: readonly Pick<ObservedClaudeSession, "sessionId" | "activeProcesses">[];
}

function historyOrder(left: BridgeHistoryItem, right: BridgeHistoryItem): number {
  return left.createdAt - right.createdAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

/** Compose native transcripts, durable events and authoritative SDK task history. */
export async function readSessionHistory(
  options: SessionHistoryOptions,
  cursor?: string,
  limit = 50,
): Promise<BridgeHistoryPage> {
  const { paths, eventLog, taskState, session, route, activeTurn, observedSessions } = options;
  const { sessionId } = session;
  let before: { at: number; id: string } | undefined;
  if (cursor) {
    try {
      const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { at?: unknown; id?: unknown };
      if (typeof parsed.at === "number" && typeof parsed.id === "string") before = { at: parsed.at, id: parsed.id };
    } catch {
      // Invalid cursors retain the existing first-page behavior.
    }
  }
  const pageSize = Math.max(1, Math.min(limit, 100));
  const transcriptSources = route
    ? route.lanes.flatMap((lane) => lane.nativeSessionId ? [lane] : [])
    : [{ nativeSessionId: sessionId, providerKind: "claude-3p" as const }];
  const transcripts = await Promise.all(transcriptSources.map(async (lane) => {
    const observed = observedSessions.find((candidate) => candidate.sessionId === lane.nativeSessionId);
    const [transcript, subagents] = await Promise.all([
      readClaudeSessionHistory(paths.projects, lane.nativeSessionId!, session.cwd, {
        includeBranch: true,
        limit: Math.min(10_000, pageSize * 3),
        chronological: true,
        ...(before ? { before: { createdAt: before.at, id: before.id } } : {}),
      }),
      readClaudeSessionSubagents(
        paths.projects,
        lane.nativeSessionId!,
        session.cwd,
        activeTurn ? 0 : oldestLiveProcessStart(observed?.activeProcesses ?? []),
      ),
    ]);
    return { lane, transcript, subagents };
  }));
  const transcriptItems: BridgeHistoryItem[] = transcripts.flatMap(({ lane, transcript }) => (
    transcript.messages.map((message) => ({
      id: message.id,
      sessionId,
      role: message.role,
      text: message.text,
      createdAt: message.createdAt,
      origin: lane.providerKind === "claude-official" ? "claude-desktop" as const : "claude-host" as const,
      ...(message.interactivePrompt ? { interactivePrompt: message.interactivePrompt } : {}),
      ...(message.taskPlan ? { taskPlan: message.taskPlan } : {}),
    }))
  ));
  taskState.restore(sessionId, eventLog.latestTaskEvents(sessionId));
  const subagentItems = taskState.historyItems(sessionId, transcripts.flatMap(({ subagents }) => subagents));
  const eventSessionIds = new Set([sessionId, ...transcriptSources.map((lane) => lane.nativeSessionId!).filter(Boolean)]);
  const eventItems = [...eventSessionIds].flatMap((eventSessionId) => {
    const pages: BridgeHistoryItem[][] = [];
    let eventCursor: string | undefined;
    do {
      const page = eventLog.history(eventSessionId, eventCursor, 10_000);
      pages.push(page.items);
      eventCursor = page.hasMore ? page.nextCursor : undefined;
    } while (eventCursor);
    return pages.reverse().flat().map((item) => ({ ...item, sessionId }));
  });
  const merged = new Map<string, BridgeHistoryItem>();
  for (const item of transcriptItems) merged.set(item.id, item);
  for (const item of eventItems) {
    if (!taskState.isInline(sessionId, item.subagent?.toolUseId ?? item.subagent?.agentId ?? item.id)) continue;
    const existing = merged.get(item.id);
    if (!existing || item.origin !== "claude-desktop") {
      merged.set(item.id, {
        ...item,
        createdAt: existing?.createdAt ?? item.createdAt,
        ...(existing?.interactivePrompt ?? item.interactivePrompt
          ? { interactivePrompt: existing?.interactivePrompt ?? item.interactivePrompt }
          : {}),
        ...(existing?.taskPlan && (!item.taskPlan || existing.taskPlan.updatedAt > item.taskPlan.updatedAt)
          ? { taskPlan: existing.taskPlan }
          : {}),
      });
    }
  }
  for (const subItem of subagentItems) {
    let existing = merged.get(subItem.id);
    if (subItem.subagent) {
      for (const [id, item] of merged) {
        if (id === subItem.id || !item.subagent) continue;
        if (item.subagent.toolUseId && subItem.subagent.toolUseId
          ? item.subagent.toolUseId === subItem.subagent.toolUseId
          : item.subagent.agentId === subItem.subagent.agentId) {
          existing ??= item;
          merged.delete(id);
        }
      }
    }
    if (before && !(subItem.createdAt < before.at || (subItem.createdAt === before.at && subItem.id < before.id))) continue;
    if (!existing) {
      merged.set(subItem.id, subItem);
    } else if (subItem.subagent) {
      const { state: _state, ...existingDetails } = existing;
      merged.set(subItem.id, {
        ...existingDetails,
        id: subItem.id,
        toolName: existing.toolName || "Agent",
        text: subItem.text,
        ...(subItem.state ? { state: subItem.state } : {}),
        subagent: subItem.subagent,
      });
    }
  }
  // Older event copies must not skip transcript messages left by its byte budget.
  const transcriptBoundary = transcriptItems
    .filter((item) => transcripts.some(({ transcript }) => transcript.nextCursor === item.id))
    .sort(historyOrder).at(-1);
  const excludedMessages = new Set(transcripts.flatMap(({ transcript }) => transcript.branch?.excludedMessageUuids ?? []));
  const excludedTools = new Set(transcripts.flatMap(({ transcript }) => transcript.branch?.excludedToolUseIds ?? []));
  const all = [...merged.values()].sort(historyOrder).filter((item) => (
    !excludedMessages.has(item.id) && !excludedTools.has(item.subagent?.toolUseId ?? item.id.replace(/:completed$/u, "")) &&
    (!before || item.createdAt < before.at || (item.createdAt === before.at && item.id < before.id)) &&
    (!transcriptBoundary || historyOrder(item, transcriptBoundary) >= 0)
  ));
  let startIndex = all.length;
  let messageCount = 0;
  let totalBytes = 0;
  const maxPageBytes = before ? 96_000 : 56_000;
  while (startIndex > 0 && messageCount < pageSize) {
    const candidate = all[startIndex - 1]!;
    const itemBytes = Buffer.byteLength(JSON.stringify(candidate), "utf8");
    if (totalBytes + itemBytes > maxPageBytes && startIndex < all.length) break;
    startIndex -= 1;
    totalBytes += itemBytes;
    if (candidate.role !== "tool") messageCount += 1;
  }
  const items = all.slice(startIndex);
  const hasMore = transcripts.some(({ transcript }) => Boolean(transcript.nextCursor)) || startIndex > 0;
  return {
    sessionId,
    items,
    hasMore,
    ...(hasMore && items[0] ? {
      nextCursor: Buffer.from(JSON.stringify({ at: items[0].createdAt, id: items[0].id }), "utf8").toString("base64url"),
    } : {}),
  };
}
