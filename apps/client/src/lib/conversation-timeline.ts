import { isClaudeTranscriptControlMessage } from "@bridge/protocol";
import type {
  BridgeAttachment,
  BridgeDeliveryState,
  BridgeEvidenceBundle,
  BridgeEvent,
  BridgeFileChangeSummary,
  BridgeHistoryItem,
  BridgeHostSnapshot,
  BridgeInteractivePrompt,
  BridgeSessionInfo,
  BridgeSubagentSummary,
  BridgeTaskPlan,
  BridgeTransportMetrics,
  SocketState,
} from "@bridge/protocol";
import { parseSessionNotice, type SessionNotice } from "../components/conversation/SessionNoticeCard.js";
import {
  isClaudeNativeRelay,
  mergeAcceptedDelivery,
  type LocalTurn,
  type SessionHistoryState,
} from "../hooks/useMobileBridge.js";
import { desktopRuntimeId, desktopRuntimeName } from "./runtime-labels.js";
import type { SessionFamily } from "./project-groups.js";
import { sessionQueueLabel } from "./session-activity.js";

export interface ConversationItem extends BridgeHistoryItem {
  sessionNotice?: SessionNotice;
  delivery?: BridgeDeliveryState;
  replyDelivery?: BridgeDeliveryState;
  replyPending?: boolean;
  requestId?: string;
  commandId?: string;
  toolUseId?: string;
  isError?: boolean;
  error?: string;
  live?: boolean;
}

export function restorableSessionId(
  candidate: string | undefined,
  sessions: BridgeSessionInfo[],
): string | undefined {
  return candidate && sessions.some((session) => session.sessionId === candidate)
    ? candidate
    : undefined;
}

export type ConversationTimelineEntry =
  | { kind: "message"; item: ConversationItem }
  | { kind: "evidence"; evidence: BridgeEvidenceBundle };

export function formatTime(value: number): string {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(value);
}

export function relativeTime(value: number): string {
  const elapsed = Math.max(0, Date.now() - value);
  if (elapsed < 60_000) return "刚刚";
  if (elapsed < 60 * 60_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
  if (elapsed < 24 * 60 * 60_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`;
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(value);
}

export function mobileConnectionLabel(
  connection: SocketState,
  desktopOnline: boolean,
  metrics: BridgeTransportMetrics | undefined,
  version: string | undefined,
): string {
  if (version?.startsWith("0.2.")) return "需要升级";
  if (connection === "connecting" || connection === "reconnecting") return "正在重连";
  if (connection !== "connected" || !desktopOnline) return "主机离线";
  if (metrics?.path === "direct") return "直连";
  if (metrics?.path === "public-relay") return "安全中继";
  return "局域网连接";
}

export function formatSessionModelLabel(session: BridgeSessionInfo): string {
  if (session.modelDisplayName) return session.modelDisplayName;
  const raw = session.model?.trim();
  if (!raw) return "默认模型";
  const magpieAnthropic = /^magpie-\d+\.anthropic\.(.+)$/iu.exec(raw);
  const candidate = magpieAnthropic ? magpieAnthropic[1]! : raw;
  if (/^(?:(?:mythos|claude)-magpie-|anthropic\/magpie-|magpie-)\d+(?:\[1m\])?$/iu.test(candidate)) {
    return /\[1m\]/iu.test(candidate) ? "默认模型 1M" : "默认模型";
  }
  return candidate
    .replace(/^claude-/iu, "")
    .replace(/\[1m\]/giu, " 1M")
    .replaceAll("-", " ")
    .trim() || "默认模型";
}

export function sessionProfile(session: BridgeSessionInfo): string {
  const model = formatSessionModelLabel(session);
  return [
    model || "默认模型",
    session.effort?.toLocaleUpperCase(),
  ].filter(Boolean).join(" · ");
}

export function ownershipLabel(session: BridgeSessionInfo): string {
  if (session.transport === "claude-desktop-native") return session.turnState === "waiting" ? "需处理" : session.turnState === "queued" ? sessionQueueLabel(session) : session.ownership === "DESKTOP_NATIVE_RUNNING" ? "桌面运行中" : "桌面待机";
  const bridgeCreated = session.source === "bridge";
  if (session.desktopHandoff?.reason === "bridge-execution-requested") return "等待当前工作结束后交接";
  if (session.desktopHandoff?.reason === "inbox-confirmation-expired") return "等待确认交接";
  if (session.desktopHandoff?.state === "close-desktop") return "等待关闭此 Desktop 会话";
  if (session.desktopHandoff?.state === "reopen-desktop") return "请重新打开 Desktop 会话";
  if (session.ownership === "OWNERSHIP_CONFLICT") return "写入冲突";
  if (session.ownership === "FALLBACK_CONFIRMATION_REQUIRED") return "等待接管";
  if (session.turnState === "running" && session.executionStage === "starting") return "正在启动";
  if (session.turnState === "running" && session.executionStage === "submitted") return "已提交，等待执行";
  if (session.ownership === "DESKTOP_OBSERVED" && session.turnState === "running") {
    return "桌面运行中";
  }
  if (session.turnState === "running") return bridgeCreated ? "Bridge 运行中" : "运行中";
  if (session.turnState === "queued") return `${sessionQueueLabel(session)} · ${session.pendingCount} 条`;
  if (session.turnState === "waiting") return "需处理";
  if (bridgeCreated || session.desktopHandoff?.state === "bridge") return "Bridge 待机";
  if (session.transport === "claude-desktop-managed") return "Claude Desktop 同步";
  if (session.ownership === "DESKTOP_OBSERVED") return "桌面待机";
  return "待机";
}

export function activeSessionBadgeLabel(session: BridgeSessionInfo): string | undefined {
  if (session.transport === "claude-desktop-native") return session.turnState === "idle" ? undefined : ownershipLabel(session);
  if (session.desktopHandoff?.reason === "bridge-execution-requested") return "等待交接";
  if (session.desktopHandoff?.reason === "inbox-confirmation-expired") return "等待确认交接";
  if (session.desktopHandoff?.state === "close-desktop") return "等待关闭 Desktop";
  if (session.desktopHandoff?.state === "reopen-desktop") return "请重新打开 Desktop";
  if (session.ownership === "OWNERSHIP_CONFLICT") return "冲突";
  if (session.ownership === "FALLBACK_CONFIRMATION_REQUIRED") return "待接管";
  if (session.turnState === "running") {
    if (session.executionStage === "starting") return "正在启动";
    if (session.executionStage === "submitted") return "已提交，等待执行";
    return "运行中";
  }
  if (session.turnState === "queued") return sessionQueueLabel(session);
  if (session.turnState === "waiting") return "待处理";
  return undefined;
}

export function conciseModelName(session: BridgeSessionInfo): string {
  return formatSessionModelLabel(session);
}

export function conciseSessionSubtitle(session: BridgeSessionInfo): string {
  const active = activeSessionBadgeLabel(session);
  const model = conciseModelName(session);
  const effort = session.effort?.toLocaleUpperCase();
  const modelPart = effort ? `${model} · ${effort}` : model;
  return active ? `${active} · ${modelPart}` : modelPart;
}

export type DisplayTimelineNode =
  | ConversationTimelineEntry
  | { kind: "tool-group"; id: string; tools: ConversationItem[] }
  | { kind: "background-task"; id: string; item: ConversationItem };

export function groupTimelineTools(timeline: ConversationTimelineEntry[]): DisplayTimelineNode[] {
  const result: DisplayTimelineNode[] = [];
  const workflowRuns = new Set<string>();
  for (const entry of timeline) {
    if (entry.kind === "message" && entry.item.subagent) {
      // Details live in the background task sheet; a workflow run gets one line for all its agents.
      const runId = entry.item.subagent.workflowRunId;
      if (runId && workflowRuns.has(runId)) continue;
      if (runId) workflowRuns.add(runId);
      result.push({ kind: "background-task", id: runId ? `workflow:${runId}` : entry.item.id, item: entry.item });
      continue;
    }
    if (entry.kind === "message" && entry.item.role === "tool" && !entry.item.subagent) {
      const prev = result.at(-1);
      if (prev && prev.kind === "tool-group") {
        prev.tools.push(entry.item);
      } else {
        result.push({
          kind: "tool-group",
          id: `tool-group:${entry.item.id}`,
          tools: [entry.item],
        });
      }
      continue;
    }
    result.push(entry);
  }
  return result;
}

export function runtimeSupports(
  snapshot: BridgeHostSnapshot | undefined,
  session: BridgeSessionInfo,
  capability: "attachment.image",
): boolean {
  const runtime = snapshot?.runtimes?.find((candidate) => candidate.id === desktopRuntimeId(session));
  return runtime?.capabilities.includes(capability) ?? desktopRuntimeId(session) === "claude-desktop";
}

export function canSendSession(session: BridgeSessionInfo, snapshot: BridgeHostSnapshot | undefined): boolean {
  if (desktopRuntimeId(session) !== "claude-desktop") return false;
  return isClaudeNativeRelay(snapshot) && session.transport === "claude-desktop-native" && session.allowedActions?.canSend === true;
}

export function canConfigureSession(session: BridgeSessionInfo, snapshot?: BridgeHostSnapshot): boolean {
  if (desktopRuntimeId(session) === "claude-desktop") {
    return isClaudeNativeRelay(snapshot) && session.transport === "claude-desktop-native" && session.allowedActions?.canConfigure === true;
  }
  return false;
}

export function canStopBridgeTask(session: BridgeSessionInfo): boolean {
  if (desktopRuntimeId(session) === "claude-desktop") {
    return session.transport === "claude-desktop-native" && session.allowedActions?.canInterrupt === true
      && (session.ownership === "DESKTOP_NATIVE_RUNNING" || session.pendingCount > 0 || session.turnState === "running" || session.turnState === "waiting");
  }
  return false;
}

export function supportsProviderSwitching(
  _snapshot: BridgeHostSnapshot | undefined,
): boolean {
  return false;
}

export function stoppableBridgeTask(
  sessions: BridgeSessionInfo[],
  selectedSessionId?: string,
): BridgeSessionInfo | undefined {
  const selected = sessions.find((session) => session.sessionId === selectedSessionId);
  if (selected && canStopBridgeTask(selected)) return selected;
  return sessions.find(canStopBridgeTask);
}

export function deliveryLabel(state: BridgeDeliveryState): string {
  if (state === "local-saved") return "已保存到手机";
  if (state === "relay-received") return "已送达中继，等待电脑接收";
  if (state === "host-received") return "主机已接收";
  if (state === "submitted") return "已提交，等待执行";
  if (state === "waiting-confirmation") return "等待电脑允许接收";
  if (state === "session-received") return "已接收";
  if (state === "queued") return "排队中";
  if (state === "running") return "正在处理中";
  if (state === "completed") return "已完成";
  if (state === "failed") return "处理失败";
  if (state === "uncertain") return "发送结果待确认";
  return "已取消";
}

function eventText(event: BridgeEvent): string {
  if (typeof event.data.text === "string") return event.data.text;
  if (typeof event.data.summary === "string") return event.data.summary;
  if (typeof event.data.error === "string") return event.data.error;
  return "";
}

function preserveFullText(text: string, previous?: string): string {
  const marker = "\n\n[内容较长，已省略中间部分]\n\n";
  return previous && text.includes(marker) && !previous.includes(marker) ? previous : text;
}

export function conversationItems(
  sessionId: string,
  history: SessionHistoryState | undefined,
  events: BridgeEvent[],
  localTurns: LocalTurn[],
  paged = false,
  promptReplies: Readonly<Record<string, string | null>> = {},
): ConversationItem[] {
  const items = new Map<string, ConversationItem>();
  const sessionHistory = history?.items.filter((item) => item.sessionId === sessionId) ?? [];
  const allSessionEvents = events.filter((event) => event.sessionId === sessionId);
  const rewoundAt = allSessionEvents.reduce((seq, event) => event.type === "session.rewound" ? Math.max(seq, event.seq) : seq, -1);
  const sessionEvents = allSessionEvents.filter(event => event.seq > rewoundAt).sort((left, right) => left.seq - right.seq);
  const messageRekeys = new Map<string, string>();
  for (const event of sessionEvents) {
    if (event.type === "message.delivery" && typeof event.data.previousMessageId === "string" && typeof event.data.messageId === "string") {
      messageRekeys.set(event.data.previousMessageId, event.data.messageId);
    }
  }
  const historyIdsByCommand = new Map(sessionHistory.flatMap(item => item.role === "user" && item.commandId ? [[item.commandId, item.id] as const] : []));
  const historyIdsByRequest = new Map(sessionHistory.flatMap(item => item.role === "user" && item.requestId ? [[item.requestId, item.id] as const] : []));
  function canonicalMessageId(id: string, commandId?: string, requestId?: string): string {
    while (messageRekeys.has(id)) id = messageRekeys.get(id)!;
    let historyId = (commandId ? historyIdsByCommand.get(commandId) : undefined)
      ?? (requestId ? historyIdsByRequest.get(requestId) : undefined);
    if (!historyId) return id;
    while (messageRekeys.has(historyId)) historyId = messageRekeys.get(historyId)!;
    if (id !== historyId) messageRekeys.set(id, historyId);
    return historyId;
  }
  const subagentItemIds = new Map<string, string>();
  const subagentInvocations = new Map<string, Map<number, string>>();
  for (const subagent of [
    ...(sessionHistory).flatMap((item) => item.subagent ? [item.subagent] : []),
    ...sessionEvents.flatMap((event) => event.data.subagent ? [event.data.subagent as BridgeSubagentSummary] : []),
  ]) {
    if (!subagent.toolUseId) continue;
    const invocations = subagentInvocations.get(subagent.agentId) ?? new Map<number, string>();
    invocations.set(subagent.startedAt, subagent.toolUseId);
    subagentInvocations.set(subagent.agentId, invocations);
  }
  for (const item of sessionHistory) {
    if (item.subagent) subagentItemIds.set(item.subagent.agentId, item.subagent.toolUseId
      ?? subagentItemIds.get(item.subagent.agentId) ?? item.id.replace(/^tool:/u, "").replace(/:completed$/u, ""));
  }
  for (const event of sessionEvents) {
    const subagent = event.data.subagent as BridgeSubagentSummary | undefined;
    if (subagent) subagentItemIds.set(subagent.agentId, subagent.toolUseId
      ?? subagentItemIds.get(subagent.agentId) ?? event.itemId ?? `subagent:${subagent.agentId}`);
  }
  const hiddenTaskItems = new Set(sessionEvents.flatMap((event) => {
    const task = event.data.task as { skipTranscript?: boolean; taskId?: string; toolUseId?: string } | undefined;
    if (!task?.skipTranscript) return [];
    const subagent = event.data.subagent as BridgeSubagentSummary | undefined;
    return [task.toolUseId ?? (task.taskId ? subagentItemIds.get(task.taskId) : undefined)
      ?? (subagent ? subagentItemIds.get(subagent.agentId) : undefined) ?? event.itemId ?? event.eventId];
  }));
  for (const item of sessionHistory) {
    if (
      (item.role === "user" || item.role === "assistant") &&
      isClaudeTranscriptControlMessage(item.role, item.text)
    ) continue;
    const normalizedId = item.subagent
      ? `tool:${item.subagent.toolUseId ?? subagentInvocations.get(item.subagent.agentId)?.get(item.subagent.startedAt) ?? subagentItemIds.get(item.subagent.agentId)}`
      : item.role === "tool" && !item.id.startsWith("tool:")
        ? `tool:${item.id.replace(/:completed$/u, "")}`
        : item.role === "user" ? canonicalMessageId(item.id, item.commandId, item.requestId) : item.id;
    if (item.role === "tool" && hiddenTaskItems.has(normalizedId.replace(/^tool:/u, ""))) continue;
    const previous = items.get(normalizedId);
    const taskPlan = previous?.taskPlan && (!item.taskPlan || previous.taskPlan.updatedAt >= item.taskPlan.updatedAt)
      ? previous.taskPlan
      : item.taskPlan;
    if (previous?.subagent && item.subagent && previous.subagent.updatedAt > item.subagent.updatedAt) continue;
    const rawToolUseId = item.role === "tool" && !item.subagent
      ? item.id.replace(/^tool:/u, "").replace(/:completed$/u, "")
      : undefined;
    items.set(normalizedId, {
      ...previous,
      ...item,
      id: normalizedId,
      ...(rawToolUseId ? { toolUseId: rawToolUseId } : {}),
      ...(item.role === "user" && (previous?.delivery || item.delivery)
        ? { delivery: mergeAcceptedDelivery(previous?.delivery, item.delivery) } : {}),
      ...(taskPlan ? { taskPlan } : {}),
    });
  }
  const acceptedRequests = new Set(
    sessionEvents
      .filter((event) => event.type === "user.message.accepted" && typeof event.data.requestId === "string")
      .map((event) => event.data.requestId as string),
  );
  const messageIdsByRequest = new Map(sessionEvents.flatMap((event) => {
    if (event.type !== "message.delivery" || typeof event.data.requestId !== "string") return [];
    const messageId = typeof event.data.messageId === "string" ? event.data.messageId
      : event.data.delivery === "submitted" ? event.itemId : undefined;
    return messageId ? [[event.data.requestId, canonicalMessageId(messageId)] as const] : [];
  }));
  for (const turn of localTurns.filter((candidate) => candidate.sessionId === sessionId)) {
    if (acceptedRequests.has(turn.requestId)) continue;
    // Submission links the transcript UUID before SDK acceptance arrives.
    const id = canonicalMessageId(turn.messageId ?? messageIdsByRequest.get(turn.requestId) ?? `local:${turn.requestId}`, turn.commandId, turn.requestId);
    items.set(id, {
      id,
      sessionId,
      role: "user",
      text: turn.text,
      createdAt: turn.createdAt,
      origin: "mobile",
      attachments: turn.attachments,
      ...items.get(id),
      delivery: mergeAcceptedDelivery(turn.delivery, items.get(id)?.delivery ?? turn.delivery),
      requestId: turn.requestId,
      ...(turn.error ? { error: turn.error } : {}),
      ...(turn.commandId ? { commandId: turn.commandId } : {}),
    });
  }
  // Some native Desktop APIs only expose the final history record instead of
  // an explicit assistant.completed event. Treat that record as the terminal
  // stream state too, otherwise a prior assistant.delta remains beside the
  // imported final answer.
  const finalizedAssistantTurns = new Set(
    sessionEvents
      .filter((event) => (
        event.turnId && (
          event.type === "assistant.completed" ||
          (event.type === "session.observed" && event.data.role === "assistant" && !event.data.taskPlan)
        )
      ))
      .map((event) => event.turnId!),
  );
  const finalizedAssistantItems = new Set([
    ...sessionHistory.filter(item => item.role === "assistant" && !item.taskPlan).map(item => item.id),
    ...sessionEvents.filter(event => event.type === "assistant.completed"
      || (event.type === "session.observed" && event.data.role === "assistant" && !event.data.taskPlan))
      .flatMap(event => event.itemId ? [event.itemId] : []),
  ]);
  const deltaByStream = new Map<string, ConversationItem>();
  const toolByItem = new Map<string, ConversationItem>();
  for (const event of sessionEvents) {
    if (event.type === "session.observed") {
      if (event.data.taskPlanInvalidated === true) {
        items.delete(event.itemId ?? event.eventId);
        continue;
      }
      const role = event.data.role;
      const text = eventText(event);
      const interactivePrompt = event.data.interactivePrompt && typeof event.data.interactivePrompt === "object"
        ? event.data.interactivePrompt as BridgeInteractivePrompt
        : undefined;
      const taskPlan = event.data.taskPlan as BridgeTaskPlan | undefined;
      if (
        (role === "user" || role === "assistant") &&
        (text || interactivePrompt || taskPlan) &&
        (!text || !isClaudeTranscriptControlMessage(role, text))
      ) {
        const itemId = role === "user" ? canonicalMessageId(event.itemId ?? event.eventId,
          typeof event.data.commandId === "string" ? event.data.commandId : undefined,
          typeof event.data.requestId === "string" ? event.data.requestId : undefined) : event.itemId ?? event.eventId;
        const prev = items.get(itemId);
        const mergedPrompt = interactivePrompt
          ? (prev?.interactivePrompt?.answered && !interactivePrompt.answered ? prev.interactivePrompt : interactivePrompt)
          : prev?.interactivePrompt;
        const mergedTaskPlan = prev?.taskPlan && (!taskPlan || prev.taskPlan.updatedAt >= taskPlan.updatedAt)
          ? prev.taskPlan
          : taskPlan;
        items.set(itemId, {
          ...prev,
          id: itemId,
          sessionId,
          ...(event.turnId ? { turnId: event.turnId } : {}),
          role,
          text: preserveFullText(text, prev?.text),
          createdAt: mergedTaskPlan ? prev?.createdAt ?? event.timestamp : event.timestamp,
          origin: event.origin,
          ...(mergedPrompt ? { interactivePrompt: mergedPrompt } : {}),
          ...(mergedTaskPlan ? { taskPlan: mergedTaskPlan } : {}),
        });
      }
    }
    if (event.type === "user.message.accepted") {
      const text = eventText(event);
      const attachments = Array.isArray(event.data.attachments)
        ? event.data.attachments as ConversationItem["attachments"]
        : undefined;
      const itemId = canonicalMessageId(event.itemId ?? event.eventId,
        typeof event.data.commandId === "string" ? event.data.commandId : undefined,
        typeof event.data.requestId === "string" ? event.data.requestId : undefined);
      items.set(itemId, {
        ...items.get(itemId),
        id: itemId,
        sessionId,
        ...(event.turnId ? { turnId: canonicalMessageId(event.turnId) } : {}),
        role: "user",
        text,
        createdAt: event.timestamp,
        origin: event.origin,
        delivery: mergeAcceptedDelivery(items.get(itemId)?.delivery, event.data.delivery as BridgeDeliveryState | undefined),
        ...(attachments?.length ? { attachments } : {}),
        ...(typeof event.data.requestId === "string" ? { requestId: event.data.requestId } : {}),
        ...(typeof event.data.commandId === "string" ? { commandId: event.data.commandId } : {}),
      });
    }
    if (event.type === "command.output" || event.type === "command.status") {
      const text = eventText(event);
      if (text) {
        const id = event.itemId ?? event.eventId;
        items.set(id, {
          ...items.get(id), id, sessionId,
          ...(event.turnId ? { turnId: event.turnId } : {}),
          role: "system", text, createdAt: items.get(id)?.createdAt ?? event.timestamp, origin: event.origin,
        });
      }
    }
    if (event.type === "assistant.delta"
      && !(event.turnId && finalizedAssistantTurns.has(event.turnId))
      && !(event.itemId && finalizedAssistantItems.has(event.itemId))) {
      // Provider stream events can use a new item id for every chunk. The turn is the stable stream identity.
      const id = event.turnId ? `assistant:${event.turnId}` : event.itemId ?? event.eventId;
      const existing = deltaByStream.get(id);
      const text = `${existing?.text ?? ""}${eventText(event)}`;
      deltaByStream.set(id, {
        id,
        sessionId,
        ...(event.turnId ? { turnId: event.turnId } : {}),
        role: "assistant",
        text,
        createdAt: existing?.createdAt ?? event.timestamp,
        origin: "claude-host",
        live: true,
      });
    }
    if (event.type === "assistant.completed") {
      const text = eventText(event);
      const interactivePrompt = event.data.interactivePrompt && typeof event.data.interactivePrompt === "object"
        ? event.data.interactivePrompt as BridgeInteractivePrompt
        : undefined;
      const taskPlan = event.origin !== "claude-desktop" || event.data.taskPlanSource === "native-main"
        ? event.data.taskPlan as BridgeTaskPlan | undefined
        : undefined;
      if (!text && !interactivePrompt && !taskPlan) continue;
      const itemId = event.itemId ?? event.eventId;
      const prev = items.get(itemId);
      const mergedTaskPlan = prev?.taskPlan && (!taskPlan || prev.taskPlan.updatedAt >= taskPlan.updatedAt)
        ? prev.taskPlan
        : taskPlan;
      items.set(itemId, {
        id: itemId,
        sessionId,
        ...(event.turnId ? { turnId: event.turnId } : {}),
        role: "assistant",
        text,
        createdAt: mergedTaskPlan ? prev?.createdAt ?? event.timestamp : event.timestamp,
        origin: "claude-host",
        ...(interactivePrompt
          ? { interactivePrompt }
          : prev?.interactivePrompt
            ? { interactivePrompt: prev.interactivePrompt }
            : {}),
        ...(mergedTaskPlan ? { taskPlan: mergedTaskPlan } : {}),
      });
    }
    if (event.type === "tool.started" || event.type === "tool.progress" || event.type === "tool.completed") {
      const incomingSubagent = event.data.subagent && typeof event.data.subagent === "object"
        ? event.data.subagent as BridgeSubagentSummary
        : undefined;
      const id = incomingSubagent
        ? incomingSubagent.toolUseId ?? subagentInvocations.get(incomingSubagent.agentId)?.get(incomingSubagent.startedAt) ?? subagentItemIds.get(incomingSubagent.agentId)!
        : event.itemId ?? event.eventId;
      if (hiddenTaskItems.has(id)) continue;
      const existing = toolByItem.get(id) ?? items.get(`tool:${id}`);
      if (event.origin === "claude-desktop" && event.type === "tool.completed" && !existing && !incomingSubagent && !event.data.toolName) continue;
      const toolName = typeof event.data.toolName === "string" && event.data.toolName
        ? event.data.toolName
        : existing?.toolName ?? "工具";
      const text = eventText(event) || existing?.text || toolName;
      const fileChanges = Array.isArray(event.data.fileChanges)
        ? event.data.fileChanges as BridgeFileChangeSummary[]
        : existing?.fileChanges;
      const prevSubagent = existing?.subagent;
      const subagent = incomingSubagent && prevSubagent
        ? incomingSubagent.updatedAt > prevSubagent.updatedAt || (
            incomingSubagent.updatedAt === prevSubagent.updatedAt
            && !(prevSubagent.state === "unknown" && incomingSubagent.state === "running")
          )
          ? {
              ...prevSubagent,
              ...incomingSubagent,
              toolCount: Math.max(prevSubagent.toolCount, incomingSubagent.toolCount),
              ...(incomingSubagent.recentTools?.length
                ? { recentTools: incomingSubagent.recentTools }
                : prevSubagent.recentTools?.length
                  ? { recentTools: prevSubagent.recentTools }
                  : {}),
              ...(incomingSubagent.latestText
                ? { latestText: preserveFullText(incomingSubagent.latestText, prevSubagent.latestText) }
                : prevSubagent.latestText
                  ? { latestText: prevSubagent.latestText }
                  : {}),
              ...(incomingSubagent.reportText
                ? { reportText: preserveFullText(incomingSubagent.reportText, prevSubagent.reportText) }
                : prevSubagent.reportText
                  ? { reportText: prevSubagent.reportText }
                  : {}),
            }
          : prevSubagent
        : incomingSubagent ?? prevSubagent;
      const toolUseId = !incomingSubagent
        ? (typeof event.itemId === "string" && event.itemId.trim() ? event.itemId.trim() : existing?.toolUseId)
        : undefined;
      const isError = event.type === "tool.completed" && event.data.isError === true ? true : existing?.isError;
      toolByItem.set(id, {
        id: `tool:${id}`,
        sessionId,
        ...(event.turnId ? { turnId: event.turnId } : existing?.turnId ? { turnId: existing.turnId } : {}),
        role: "tool",
        toolName,
        text,
        createdAt: existing?.createdAt ?? event.timestamp,
        origin: "claude-host",
        ...(toolUseId ? { toolUseId } : {}),
        ...(isError ? { isError: true } : {}),
        ...(subagent?.state === "unknown" ? {} : {
          state: subagent?.state === "stopped"
            ? "interrupted" as const
            : subagent?.state ?? (event.type === "tool.completed" ? "completed" as const : "running" as const),
        }),
        ...(fileChanges?.length ? { fileChanges } : {}),
        ...(subagent ? { subagent } : {}),
      });
    }
    if (event.type === "turn.failed" || event.type === "turn.interrupted") {
      items.set(event.eventId, {
        id: event.eventId,
        sessionId,
        ...(event.turnId ? { turnId: event.turnId } : {}),
        role: "system",
        text: event.type === "turn.failed" ? eventText(event) || "Claude 处理失败" : "任务已停止",
        createdAt: event.timestamp,
        origin: "system",
        state: event.type === "turn.failed" ? "failed" : "interrupted",
      });
    }
    if (event.type === "permission.resolved" || event.type === "question.resolved") {
      if (event.data.automatic === true) continue;
      const resolver = typeof event.data.resolvedByName === "string"
        ? event.data.resolvedByName
        : "另一台设备";
      const decision = event.data.decision;
      const outcome = event.type === "question.resolved"
        ? decision === "deny" ? "取消了回答" : "提交了回答"
        : decision === "deny"
          ? "拒绝了授权"
          : decision === "allow-always"
            ? "设为始终允许"
            : "允许了这一次操作";
      items.set(event.eventId, {
        id: event.eventId,
        sessionId,
        role: "system",
        text: `${resolver}${outcome}`,
        createdAt: event.timestamp,
        origin: "system",
      });
    }
  }
  for (const item of deltaByStream.values()) items.set(item.id, item);
  for (const item of toolByItem.values()) items.set(item.id, item);
  // Acceptance replaces the local bubble; carry its subsequent receipt onto the canonical message.
  const localByRequest = new Map(localTurns.filter((turn) => turn.sessionId === sessionId).map((turn) => [turn.requestId, turn]));
  const terminalByCommand = new Map<string, BridgeEvent>();
  const terminalByTurn = new Map<string, BridgeEvent>();
  for (const event of sessionEvents) {
    if (event.type !== "turn.completed" && event.type !== "turn.failed" && event.type !== "turn.interrupted") continue;
    if (typeof event.data.commandId === "string") terminalByCommand.set(event.data.commandId, event);
    if (event.turnId) terminalByTurn.set(event.turnId, event);
  }
  const localByMessage = new Map(localTurns.filter(turn => turn.sessionId === sessionId && turn.messageId)
    .map(turn => [canonicalMessageId(turn.messageId!), turn]));
  const stages = sessionEvents.filter(event => event.type === "message.delivery"
    || (event.type === "turn.queued" && event.origin === "claude-desktop") || event.type === "turn.started"
    || event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.interrupted");
  for (const item of items.values()) {
    if (item.role !== "user") continue;
    const local = (item.requestId ? localByRequest.get(item.requestId) : undefined) ?? localByMessage.get(item.id);
    let commandId = item.commandId ?? local?.commandId;
    let requestId = item.requestId ?? local?.requestId;
    let delivery = local ? mergeAcceptedDelivery(local.delivery, item.delivery ?? local.delivery) : item.delivery;
    let error = local?.error;
    for (const event of stages) {
      if (!((commandId && event.data.commandId === commandId)
        || (requestId && event.data.requestId === requestId)
        || (item.turnId && event.turnId && canonicalMessageId(event.turnId) === canonicalMessageId(item.turnId))
        || (typeof event.data.messageId === "string" && canonicalMessageId(event.data.messageId) === item.id)
        || (event.origin === "claude-desktop" && ((event.turnId && canonicalMessageId(event.turnId) === item.id)
          || (event.itemId && canonicalMessageId(event.itemId) === item.id))))) continue;
      if (typeof event.data.commandId === "string") commandId = event.data.commandId;
      if (typeof event.data.requestId === "string") requestId = event.data.requestId;
      const incoming = event.type === "message.delivery" ? event.data.delivery as BridgeDeliveryState | undefined
        : event.type === "turn.completed" ? "completed" : event.type === "turn.failed" ? "failed"
        : event.type === "turn.interrupted" ? "cancelled" : event.type === "turn.started" ? "running" : "queued";
      if (incoming) delivery = incoming === "completed" || incoming === "failed" || incoming === "cancelled"
        ? incoming : mergeAcceptedDelivery(delivery, incoming);
      if (typeof event.data.error === "string") error = event.data.error;
    }
    const attachments = item.attachments?.length ? item.attachments : local?.attachments;
    items.set(item.id, {
      ...item,
      ...(delivery ? { delivery } : {}),
      ...(commandId ? { commandId } : {}),
      ...(requestId ? { requestId } : {}),
      ...(error ? { error } : {}),
      ...(attachments?.length ? { attachments: attachments.map((attachment, index) => ({
        ...attachment,
        ...(attachment.nativeImage ? { nativeImage: { ...attachment.nativeImage, messageUuid: canonicalMessageId(attachment.nativeImage.messageUuid) } } : {}),
        ...(local?.attachments[index]?.data ? { data: local.attachments[index]!.data } : {}),
      })) } : {}),
    });
  }
  const sorted = [...items.values()].flatMap((item) => {
    if (item.role !== "user") return [item];
    const sessionNotice = !item.attachments?.length ? parseSessionNotice(item.text) : undefined;
    if (sessionNotice) return [{ ...item, sessionNotice }];
    const text = item.text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gu, "");
    if (text === item.text) return [item];
    return text.trim() || item.attachments?.length ? [{ ...item, text: text.trim() }] : [];
  }).sort(
    (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id),
  );
  const replyDeliveries = new Map<string, BridgeDeliveryState>();
  for (const event of sessionEvents) {
    if (typeof event.data.requestId !== "string" || (event.type !== "message.delivery" && event.type !== "user.message.accepted")) continue;
    const terminal = (typeof event.data.commandId === "string" ? terminalByCommand.get(event.data.commandId) : undefined)
      ?? (event.turnId ? terminalByTurn.get(event.turnId) : undefined);
    const delivery = terminal ? terminal.type === "turn.completed" ? "completed"
      : terminal.type === "turn.failed" ? "failed" : "cancelled"
      : event.type === "user.message.accepted" ? mergeAcceptedDelivery(replyDeliveries.get(event.data.requestId), event.data.delivery as BridgeDeliveryState | undefined)
      : event.data.delivery as BridgeDeliveryState | undefined;
    if (delivery) replyDeliveries.set(event.data.requestId, delivery);
  }
  for (const item of items.values()) {
    if (item.role === "user" && item.requestId && item.delivery) replyDeliveries.set(item.requestId, item.delivery);
  }
  const latestQuestionResolvedAt = sessionEvents.reduce((latest, event) => (
    event.type === "question.resolved" ? Math.max(latest, event.timestamp) : latest
  ), -Infinity);
  const resolvedQuestionTools = new Set(sessionEvents.filter((event) => event.type === "question.resolved")
    .map((event) => event.data.toolUseId));
  let nextUserReply: string | undefined;
  let hasLaterAssistant = false;
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const current = sorted[i]!;
    if (current.sessionNotice) continue;
    const questionResolved = current.interactivePrompt?.kind === "question" && (current.interactivePrompt.toolUseId
      ? resolvedQuestionTools.has(current.interactivePrompt.toolUseId) : latestQuestionResolvedAt >= current.createdAt);
    if (current.interactivePrompt && !current.interactivePrompt.answered) {
      // Known tool invocations are completed only by their own response, not adjacent messages.
      if (nextUserReply && !current.interactivePrompt.toolUseId) {
        sorted[i] = {
          ...current,
          ...(!hasLaterAssistant && !questionResolved
            ? { replyPending: true } : {}),
          interactivePrompt: {
            ...current.interactivePrompt,
            answered: true,
            ...(current.interactivePrompt.actions
              ? {
                  actions: current.interactivePrompt.actions.map((action) => (
                    action.message.trim() === nextUserReply || action.label.trim() === nextUserReply
                      ? { ...action, selected: true }
                      : action
                  )),
                }
              : {}),
          },
        };
      } else if (current.interactivePrompt.kind === "question" && (
        questionResolved || (!current.interactivePrompt.toolUseId && hasLaterAssistant)
      )) {
        sorted[i] = {
          ...current,
          interactivePrompt: { ...current.interactivePrompt, answered: true },
        };
      }
    }
    if (current.interactivePrompt && promptReplies[current.id] !== undefined) {
      const requestId = promptReplies[current.id];
      const replyDelivery = requestId ? replyDeliveries.get(requestId) : undefined;
      sorted[i] = {
        ...sorted[i]!,
        ...(replyDelivery ? { replyDelivery } : {}),
        replyPending: !replyDelivery && !current.interactivePrompt.answered && !hasLaterAssistant && !questionResolved,
        interactivePrompt: { ...sorted[i]!.interactivePrompt!, answered: true },
      };
    }
    if (current.role === "user") nextUserReply = current.text.trim() || nextUserReply;
    if (current.role === "assistant") hasLaterAssistant = true;
  }
  if (paged) {
    if (!history || (history.status === "loading" && history.items.length === 0)) return [];
    const first = sessionHistory[0];
    if (history.hasMore && first) {
      return sorted.filter((item) => (
        item.createdAt > first.createdAt ||
        (item.createdAt === first.createdAt && item.id.localeCompare(first.id) >= 0)
      ));
    }
  }
  return sorted;
}

export function conversationTimeline(
  items: ConversationItem[],
  evidenceItems: BridgeEvidenceBundle[],
): ConversationTimelineEntry[] {
  const latestByTurn = new Map<string, BridgeEvidenceBundle>();
  for (const evidence of evidenceItems) {
    if (!evidence.turnId || evidence.state === "collecting") continue;
    const previous = latestByTurn.get(evidence.turnId);
    const completedAt = evidence.completedAt ?? evidence.startedAt;
    const previousCompletedAt = previous?.completedAt ?? previous?.startedAt ?? 0;
    if (!previous || completedAt > previousCompletedAt) latestByTurn.set(evidence.turnId, evidence);
  }

  const evidenceAfter = new Map<number, BridgeEvidenceBundle[]>();
  for (const evidence of latestByTurn.values()) {
    const matchingTurnIndexes = items.flatMap((item, index) => (
      item.turnId === evidence.turnId ? [index] : []
    ));
    let anchorIndex = matchingTurnIndexes.at(-1);
    if (anchorIndex === undefined) {
      const userIndex = items.findIndex((item) => (
        item.role === "user" && !item.sessionNotice && item.id === evidence.turnId
      ));
      if (userIndex < 0) continue;
      const nextUserOffset = items
        .slice(userIndex + 1)
        .findIndex((item) => item.role === "user" && !item.sessionNotice);
      anchorIndex = nextUserOffset < 0
        ? items.length - 1
        : userIndex + nextUserOffset;
    }
    const anchored = evidenceAfter.get(anchorIndex) ?? [];
    anchored.push(evidence);
    evidenceAfter.set(anchorIndex, anchored);
  }

  const timeline: ConversationTimelineEntry[] = [];
  items.forEach((item, index) => {
    // File-change tool cards are aggregated Codex-style into the 成果 tab;
    // one card per edit would flood the conversation.
    if (!(item.role === "tool" && item.toolName === "File change")) {
      timeline.push({ kind: "message", item });
    }
    for (const evidence of (evidenceAfter.get(index) ?? [])
      .sort((left, right) => left.startedAt - right.startedAt)) {
      timeline.push({ kind: "evidence", evidence });
    }
  });
  return timeline;
}

export interface FileChangeAggregate {
  path: string;
  kind: BridgeFileChangeSummary["kind"];
  additions: number;
  deletions: number;
}

export interface FileChangesSummary {
  files: FileChangeAggregate[];
  totalAdditions: number;
  totalDeletions: number;
}

export function aggregateFileChanges(items: ConversationItem[]): FileChangesSummary | undefined {
  const byPath = new Map<string, FileChangeAggregate>();
  for (const item of items) {
    if (item.role !== "tool" || !item.fileChanges?.length) continue;
    for (const change of item.fileChanges) {
      const existing = byPath.get(change.path);
      if (existing) {
        existing.kind = change.kind;
        existing.additions += change.additions;
        existing.deletions += change.deletions;
      } else {
        byPath.set(change.path, {
          path: change.path,
          kind: change.kind,
          additions: change.additions,
          deletions: change.deletions,
        });
      }
    }
  }
  if (!byPath.size) return undefined;
  const files = [...byPath.values()].sort(
    (left, right) => (right.additions + right.deletions) - (left.additions + left.deletions),
  );
  return {
    files,
    totalAdditions: files.reduce((sum, file) => sum + file.additions, 0),
    totalDeletions: files.reduce((sum, file) => sum + file.deletions, 0),
  };
}

export async function fileToAttachment(file: File): Promise<BridgeAttachment> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result)));
    reader.addEventListener("error", () => reject(reader.error ?? new Error("图片读取失败")));
    reader.readAsDataURL(file);
  });
  const data = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return {
    id: crypto.randomUUID(),
    name: file.name,
    mimeType: file.type as BridgeAttachment["mimeType"],
    size: file.size,
    data,
  };
}

export function archivedForkGroupKey(parentSessionId: string): string {
  return `archived:${parentSessionId}`;
}

export function forkGroupToggleLabel<T extends { sidechat?: boolean }>(
  forks: readonly SessionFamily<T>[],
): string {
  if (forks.every((fork) => fork.primary.sidechat)) return `${forks.length} 个 /btw 侧聊`;
  if (forks.some((fork) => fork.primary.sidechat)) return `${forks.length} 个分支与侧聊`;
  return `${forks.length} 个 Fork 分支`;
}

export function archivedForkGroupLabel<T extends { sidechat?: boolean }>(
  archivedForks: readonly SessionFamily<T>[],
): string {
  if (archivedForks.every((fork) => fork.primary.sidechat)) return `${archivedForks.length} 个已结束侧聊`;
  if (archivedForks.some((fork) => fork.primary.sidechat)) return `${archivedForks.length} 个已归档分支与侧聊`;
  return `${archivedForks.length} 个已归档分支`;
}

export function partitionSessionForks(
  parent: BridgeSessionInfo,
  forks: readonly SessionFamily<BridgeSessionInfo>[],
  allSessions: readonly BridgeSessionInfo[],
  includeArchivedInline: boolean,
  query = "",
): {
  activeForks: SessionFamily<BridgeSessionInfo>[];
  archivedForks: SessionFamily<BridgeSessionInfo>[];
} {
  if (includeArchivedInline) {
    return { activeForks: [...forks], archivedForks: [] };
  }
  const activeForks: SessionFamily<BridgeSessionInfo>[] = [];
  // Archived ancestors stay in history; their live descendants remain reachable
  // from the active list without requiring the history fold to be opened.
  function separateArchivedFork(fork: SessionFamily<BridgeSessionInfo>): SessionFamily<BridgeSessionInfo>[] {
    if (!fork.primary.archivedAt) {
      activeForks.push(fork);
      return [];
    }
    return [{ ...fork, forks: fork.forks.flatMap(separateArchivedFork) }];
  }
  const archivedForks = forks.flatMap(separateArchivedFork);
  const seenIds = new Set(forks.map((fork) => fork.primary.sessionId));
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const supplementalArchived: SessionFamily<BridgeSessionInfo>[] = [];
  for (const candidate of allSessions) {
    if (
      !candidate.archivedAt
      || candidate.parentSessionId !== parent.sessionId
      || candidate.projectId !== parent.projectId
      || seenIds.has(candidate.sessionId)
    ) {
      continue;
    }
    if (
      normalizedQuery
      && !`${candidate.title}\n${candidate.currentSummary ?? ""}\n${candidate.projectName}\n${candidate.cwd}\n${desktopRuntimeName(desktopRuntimeId(candidate))}`
        .toLocaleLowerCase()
        .includes(normalizedQuery)
    ) {
      continue;
    }
    supplementalArchived.push({
      primary: candidate,
      forks: [],
      lastActivityAt: candidate.lastActivityAt,
    });
  }
  activeForks.sort((left, right) => right.lastActivityAt - left.lastActivityAt);
  archivedForks.push(...supplementalArchived);
  archivedForks.sort((left, right) => right.lastActivityAt - left.lastActivityAt);
  return { activeForks, archivedForks };
}
