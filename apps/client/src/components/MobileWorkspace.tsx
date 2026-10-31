import type {
  BridgeAttachment,
  BridgeArtifactManifest,
  BridgeArtifactPreview,
  BridgeDeliveryState,
  BridgeDesktopRuntimeId,
  BridgeEvidenceBundle,
  BridgeEvent,
  BridgeFileChangeSummary,
  BridgeHistoryItem,
  BridgeHostSnapshot,
  BridgeInteractivePrompt,
  BridgePermissionInfo,
  BridgePermissionMode,
  BridgeRuntimeGoalStatus,
  BridgeRuntimeHandoff,
  BridgeRuntimeHandoffPreview,
  BridgeSessionConfiguration,
  BridgeSessionInfo,
  BridgeSubagentSummary,
  BridgeTransportMetrics,
  BridgeDesktopAppStatus,
  SocketState,
} from "@bridge/protocol";
import { isClaudeTranscriptControlMessage } from "@bridge/protocol";
import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  ArrowLeft,
  ArrowRightLeft,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsDown,
  ChevronsUp,
  CircleStop,
  FilePenLine,
  Forward,
  GitFork,
  Goal,
  ImagePlus,
  LoaderCircle,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Terminal,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  LocalTurn,
  MobileConnectionIssue,
  SessionEvidenceState,
  SessionHistoryState,
} from "../hooks/useMobileBridge.js";
import type { ThemeControl } from "../hooks/useTheme.js";
import {
  PROJECT_PREVIEW_SESSION_LIMIT,
  collapseProjects,
  expandAllProjects,
  expandProject,
  getSessionAncestorIds,
  groupProjectSessionFamilies,
  previewProjectSessionFamilies,
  sortProjectSessionsByRecent,
  toggleCollapsedProject,
  type SessionFamily,
} from "../lib/project-groups.js";
import { registerMobileBackHandler } from "../lib/mobile-back-navigation.js";
import { desktopRuntimeId, desktopRuntimeName, isNativeRuntimeId, runtimeProviderLabel } from "../lib/runtime-labels.js";
import { useStreamEntrance } from "../lib/stream-entrance.js";
import { sessionActivity } from "../lib/session-activity.js";
import { ConfirmationDialog } from "./ConfirmationDialog.js";
import { EvidenceInlineSummary, EvidencePanel } from "./EvidencePanel.js";
import { FileChangesCard } from "./FileChangesCard.js";
import { FileAttachmentPicker, useFileAttachments } from "./FileAttachmentPicker.js";
import { appendUploadedFilePaths, type UploadFileHandler } from "../lib/file-upload.js";
import { MediaGallery } from "./MediaGallery.js";
import { useMediaPreview } from "./MediaPreviewProvider.js";
import { mediaArtifacts, mediaKind } from "../lib/media-preview.js";
import { IconButton } from "./IconButton.js";
import { MarkdownText } from "./MarkdownText.js";
import { MessageCopyButton } from "./MessageCopyButton.js";
import {
  SessionConfigurationDialog,
  type SessionConfigurationChange,
} from "./SessionConfigurationDialog.js";
import {
  ProviderSwitchDialog,
  providerName,
  type ProviderSwitchPreview,
  type ProviderSwitchResult,
} from "./ProviderSwitchDialog.js";
import { RuntimeHandoffDialog } from "./RuntimeHandoffDialog.js";
import { SessionActivityIndicator } from "./SessionActivityIndicator.js";

interface ConversationItem extends BridgeHistoryItem {
  delivery?: BridgeDeliveryState;
  requestId?: string;
  commandId?: string;
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

function formatTime(value: number): string {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(value);
}

function relativeTime(value: number): string {
  const elapsed = Math.max(0, Date.now() - value);
  if (elapsed < 60_000) return "刚刚";
  if (elapsed < 60 * 60_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
  if (elapsed < 24 * 60 * 60_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`;
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(value);
}

function mobileConnectionLabel(
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

export function sessionProfile(session: BridgeSessionInfo): string {
  const model = session.modelDisplayName
    ?? session.model
      ?.replace(/^claude-/iu, "")
      .replace(/\[1m\]/giu, " 1M")
      .replaceAll("-", " ");
  const native = isNativeRuntimeId(session.runtimeId);
  return [
    native && session.provider ? session.provider : undefined,
    model || "默认模型",
    (native ? session.reasoningEffort : session.effort)?.toLocaleUpperCase(),
    native && session.fast !== undefined ? (session.fast ? "快速" : "标准") : undefined,
  ].filter(Boolean).join(" · ");
}

export function ownershipLabel(session: BridgeSessionInfo): string {
  const bridgeCreated = session.source === "bridge";
  if (session.ownership === "OWNERSHIP_CONFLICT") return "写入冲突";
  if (session.ownership === "FALLBACK_CONFIRMATION_REQUIRED") return "等待接管";
  if (session.ownership === "DESKTOP_OBSERVED" && session.turnState === "running") {
    return "桌面运行中";
  }
  if (session.turnState === "running") return bridgeCreated ? "Bridge 运行中" : "运行中";
  if (session.turnState === "queued") {
    return bridgeCreated
      ? `Bridge · ${session.pendingCount} 条排队`
      : `${session.pendingCount} 条排队`;
  }
  if (session.turnState === "waiting") return "需处理";
  if (bridgeCreated) return "Bridge 待机";
  if (session.transport === "claude-desktop-managed") return "Claude Desktop 同步";
  if (session.runtimeId && session.runtimeId !== "claude-desktop") return `${desktopRuntimeName(session.runtimeId)} 待机`;
  if (session.ownership === "DESKTOP_OBSERVED") return "桌面待机";
  return "待机";
}

function activeSessionBadgeLabel(session: BridgeSessionInfo): string | undefined {
  if (session.ownership === "OWNERSHIP_CONFLICT") return "冲突";
  if (session.ownership === "FALLBACK_CONFIRMATION_REQUIRED") return "待接管";
  if (session.turnState === "running") return "运行中";
  if (session.turnState === "queued") return `${Math.max(1, session.pendingCount)} 排队`;
  if (session.turnState === "waiting") return "待处理";
  return undefined;
}

function conciseModelName(session: BridgeSessionInfo): string {
  const raw = session.modelDisplayName
    ?? session.model
      ?.replace(/^claude-/iu, "")
      .replace(/\[1m\]/giu, " 1M")
      .replaceAll("-", " ");
  return raw || "默认模型";
}

function conciseSessionSubtitle(session: BridgeSessionInfo): string {
  const active = activeSessionBadgeLabel(session);
  const model = conciseModelName(session);
  const effort = (isNativeRuntimeId(session.runtimeId) ? session.reasoningEffort : session.effort)?.toLocaleUpperCase();
  const modelPart = effort ? `${model} · ${effort}` : model;
  return active ? `${active} · ${modelPart}` : modelPart;
}

type DisplayTimelineNode =
  | ConversationTimelineEntry
  | { kind: "tool-group"; id: string; tools: ConversationItem[] };

function groupTimelineTools(timeline: ConversationTimelineEntry[]): DisplayTimelineNode[] {
  const result: DisplayTimelineNode[] = [];
  for (const entry of timeline) {
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

export function SubagentCard({
  item,
  entering = false,
  onFileClick,
}: {
  item: ConversationItem;
  entering?: boolean;
  onFileClick?: (filePath: string) => void;
}) {
  const subagent = item.subagent;
  if (!subagent) return null;
  const isRunning = subagent.state === "running";
  const agentBadge = subagent.agentType && subagent.agentType !== "general-purpose"
    ? `Subagent · ${subagent.agentType}`
    : "Subagent";
  const durationLabel = subagent.durationMs && subagent.durationMs >= 1_000
    ? `${Math.round(subagent.durationMs / 1_000)}s`
    : undefined;
  const recentTools = subagent.recentTools ?? [];
  const hasDetails = Boolean(subagent.reportText || subagent.latestText || recentTools.length > 0);
  return (
    <article
      className={`conversation-subagent-card ${isRunning ? "is-running" : "is-completed"}${entering ? " is-entering" : ""}`}
      data-stream-key={item.id}
    >
      <div className="subagent-card-header">
        <div className="subagent-card-title-row">
          <span className={`subagent-status-badge ${isRunning ? "running" : "completed"}`}>
            {isRunning ? <LoaderCircle className="is-spinning" size={13} /> : <Check size={13} />}
            <span>{agentBadge}</span>
          </span>
          <strong className="subagent-description">{subagent.description}</strong>
        </div>
        <div className="subagent-card-meta">
          {subagent.toolCount > 0 && <span>{subagent.toolCount} 步</span>}
          {durationLabel && <span>{durationLabel}</span>}
          <span className={`subagent-state-label ${isRunning ? "running" : "completed"}`}>
            {isRunning ? "运行中" : "已完成"}
          </span>
        </div>
      </div>

      {isRunning && (subagent.latestText || recentTools.length > 0) && (
        <div className="subagent-live-progress">
          {subagent.latestText && (
            <div className="subagent-live-note">{subagent.latestText}</div>
          )}
          {recentTools.length > 0 && (
            <div className="subagent-recent-tools">
              {recentTools.slice(-3).map((toolLine, idx) => (
                <span className="subagent-tool-pill" key={`${idx}:${toolLine}`}>
                  {toolLine}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {hasDetails && (
        <details className="subagent-details">
          <summary>
            <span>
              {subagent.reportText
                ? "查看子代理结论与执行记录"
                : recentTools.length > 0
                  ? `查看已执行的 ${recentTools.length} 个步骤`
                  : "查看子代理进度"}
            </span>
            <ChevronDown size={14} className="subagent-details-chevron" aria-hidden="true" />
          </summary>
          <div className="subagent-details-body">
            {recentTools.length > 0 && (
              <div className="subagent-steps-section">
                <div className="subagent-section-label">最近执行步骤</div>
                <div className="subagent-recent-tools">
                  {recentTools.map((toolLine, idx) => (
                    <span className="subagent-tool-pill" key={`${idx}:${toolLine}`}>
                      {toolLine}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {(subagent.reportText || subagent.latestText) && (
              <div className="subagent-report-section">
                <div className="subagent-section-label">
                  {subagent.reportText ? "子代理回报" : "当前输出"}
                </div>
                <MarkdownText
                  text={subagent.reportText ?? subagent.latestText ?? ""}
                  {...(onFileClick ? { onFileClick } : {})}
                />
              </div>
            )}
          </div>
        </details>
      )}
    </article>
  );
}

export function InteractivePromptCard({
  prompt,
  canSend = true,
  busy = false,
  onSelectOption,
}: {
  prompt: BridgeInteractivePrompt;
  canSend?: boolean;
  busy?: boolean;
  onSelectOption?: (message: string) => void;
}) {
  const isWrapUp = prompt.kind === "wrap-up";
  const actions = prompt.actions ?? [];
  const questions = prompt.questions ?? [];
  const answered = Boolean(prompt.answered);
  const selectedAction = actions.find((action) => action.selected);
  const interactive = !answered && canSend && !busy && Boolean(onSelectOption);

  const badgeLabel = isWrapUp
    ? actions.length === 1
      ? "待确认操作"
      : actions.length > 1
        ? "下一步选项"
        : "待回答问题"
    : "提问与选择";

  return (
    <section
      className={`interactive-prompt-card ${answered ? "is-answered" : "is-pending"}`}
      aria-label={badgeLabel}
    >
      <div className="interactive-prompt-header">
        <span className={`interactive-prompt-badge ${answered ? "answered" : "pending"}`}>
          {answered ? <Check size={12} /> : null}
          <span>{badgeLabel}</span>
        </span>
        <span className="interactive-prompt-status">
          {answered
            ? selectedAction
              ? `已选：${selectedAction.label}`
              : "已回复"
            : prompt.blocked
              ? "等待确认后继续"
              : "点击选项直接发送"}
        </span>
      </div>

      {prompt.recap && (
        <div className="interactive-prompt-recap">{prompt.recap}</div>
      )}

      {isWrapUp && prompt.ask && (
        <div className="interactive-prompt-ask">{prompt.ask}</div>
      )}

      {isWrapUp && actions.length > 0 && (
        <div className="interactive-prompt-options">
          {actions.map((action, idx) => {
            const isPrimary = idx === 0 && !answered;
            const showDetail = Boolean(action.message && action.message !== action.label);
            return (
              <button
                type="button"
                key={`${idx}:${action.label}`}
                className={`interactive-option-button ${isPrimary ? "is-primary" : ""}${action.selected ? " is-selected" : ""}`}
                disabled={!interactive}
                onClick={() => {
                  if (interactive && onSelectOption) {
                    onSelectOption(action.message || action.label);
                  }
                }}
              >
                <div className="interactive-option-top">
                  <strong className="interactive-option-label">{action.label}</strong>
                  {action.selected ? (
                    <span className="interactive-option-tag is-selected">
                      <Check size={11} /> 已选
                    </span>
                  ) : !answered && idx === 0 ? (
                    <span className="interactive-option-tag is-recommended">
                      {actions.length === 1 ? "确认" : "推荐"}
                    </span>
                  ) : null}
                </div>
                {showDetail && (
                  <small className="interactive-option-detail">{action.message}</small>
                )}
              </button>
            );
          })}
        </div>
      )}

      {!isWrapUp && questions.map((question, qIdx) => (
        <div className="interactive-question-block" key={`${qIdx}:${question.question}`}>
          <div className="interactive-prompt-ask">
            {question.header && (
              <span className="interactive-question-chip">{question.header}</span>
            )}
            <span>{question.question}</span>
          </div>
          <div className="interactive-prompt-options">
            {question.options.map((opt, optIdx) => (
              <button
                type="button"
                key={`${optIdx}:${opt.label}`}
                className={`interactive-option-button ${optIdx === 0 && !answered ? "is-primary" : ""}${opt.selected ? " is-selected" : ""}`}
                disabled={!interactive}
                onClick={() => {
                  if (interactive && onSelectOption) {
                    onSelectOption(opt.label);
                  }
                }}
              >
                <div className="interactive-option-top">
                  <strong className="interactive-option-label">{opt.label}</strong>
                  {opt.selected && (
                    <span className="interactive-option-tag is-selected">
                      <Check size={11} /> 已选
                    </span>
                  )}
                </div>
                {opt.description && (
                  <small className="interactive-option-detail">{opt.description}</small>
                )}
              </button>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

// Runtime label helpers live in lib/runtime-labels.ts (shared with the
// evidence panel); re-exported here so existing component imports stay put.
export {
  desktopRuntimeId,
  desktopRuntimeName,
  isNativeRuntimeId,
  runtimeProviderLabel,
} from "../lib/runtime-labels.js";

function runtimeSupports(
  snapshot: BridgeHostSnapshot | undefined,
  session: BridgeSessionInfo,
  capability: "attachment.image",
): boolean {
  const runtime = snapshot?.runtimes?.find((candidate) => candidate.id === desktopRuntimeId(session));
  return runtime?.capabilities.includes(capability) ?? desktopRuntimeId(session) === "claude-desktop";
}

export function canConfigureSession(session: BridgeSessionInfo): boolean {
  return session.allowedActions?.canConfigure === true
    || (desktopRuntimeId(session) === "claude-desktop"
      && session.allowedActions?.canConfigure !== false);
}

export function canStopBridgeTask(session: BridgeSessionInfo): boolean {
  if (session.pendingCount > 0 || session.turnState === "queued") return true;
  if (session.turnState !== "running" && session.turnState !== "waiting") return false;
  return session.ownership === "BRIDGE_RUNNING"
    || session.ownership === "DESKTOP_MANAGED_RUNNING";
}

export function supportsProviderSwitching(
  snapshot: BridgeHostSnapshot | undefined,
): boolean {
  return Boolean(
    snapshot?.host.capabilities.includes("provider.profile.v1") &&
    snapshot.host.capabilities.includes("conversation.handoff.v1"),
  );
}

export function supportsRuntimeHandoff(
  snapshot: BridgeHostSnapshot | undefined,
): boolean {
  return Boolean(snapshot?.host.capabilities.includes("runtime.handoff.v1"));
}

export function goalStatusLabel(status: BridgeRuntimeGoalStatus): string {
  if (status === "active") return "goal 执行中";
  if (status === "paused") return "goal 已暂停";
  if (status === "blocked") return "goal 受阻";
  return "goal 已完成";
}

export function usesOfficialComposer(
  session: BridgeSessionInfo,
  providers: NonNullable<BridgeHostSnapshot["providers"]>,
): boolean {
  return providers.find((profile) => profile.id === session.activeProviderProfileId)?.kind
    === "claude-official";
}

export function stoppableBridgeTask(
  sessions: BridgeSessionInfo[],
  selectedSessionId?: string,
): BridgeSessionInfo | undefined {
  const selected = sessions.find((session) => session.sessionId === selectedSessionId);
  if (selected && canStopBridgeTask(selected)) return selected;
  return sessions.find(canStopBridgeTask);
}

function deliveryLabel(state: BridgeDeliveryState): string {
  if (state === "local-saved") return "已保存到手机";
  if (state === "relay-received") return "Relay 已接收";
  if (state === "host-received") return "主机已接收";
  if (state === "session-received") return "会话已接收";
  if (state === "running") return "正在处理中";
  if (state === "completed") return "已完成";
  if (state === "failed") return "发送失败";
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
): ConversationItem[] {
  const items = new Map<string, ConversationItem>();
  for (const item of history?.items ?? []) {
    if (
      (item.role === "user" || item.role === "assistant") &&
      isClaudeTranscriptControlMessage(item.role, item.text)
    ) continue;
    const normalizedId = item.role === "tool" && !item.id.startsWith("tool:")
      ? `tool:${item.id.replace(/:completed$/u, "")}`
      : item.id;
    items.set(normalizedId, normalizedId === item.id ? item : { ...item, id: normalizedId });
  }
  const sessionEvents = events.filter((event) => event.sessionId === sessionId);
  const acceptedRequests = new Set(
    sessionEvents
      .filter((event) => event.type === "user.message.accepted" && typeof event.data.requestId === "string")
      .map((event) => event.data.requestId as string),
  );
  for (const turn of localTurns.filter((candidate) => candidate.sessionId === sessionId)) {
    if (acceptedRequests.has(turn.requestId)) continue;
    items.set(`local:${turn.requestId}`, {
      id: `local:${turn.requestId}`,
      sessionId,
      role: "user",
      text: turn.text,
      createdAt: turn.createdAt,
      origin: "mobile",
      attachments: turn.attachments,
      delivery: turn.delivery,
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
          (event.type === "session.observed" && event.data.role === "assistant")
        )
      ))
      .map((event) => event.turnId!),
  );
  const deltaByStream = new Map<string, ConversationItem>();
  const toolByItem = new Map<string, ConversationItem>();
  for (const event of sessionEvents) {
    if (event.type === "session.observed") {
      const role = event.data.role;
      const text = eventText(event);
      const interactivePrompt = event.data.interactivePrompt && typeof event.data.interactivePrompt === "object"
        ? event.data.interactivePrompt as BridgeInteractivePrompt
        : undefined;
      if (
        (role === "user" || role === "assistant") &&
        (text || interactivePrompt) &&
        (!text || !isClaudeTranscriptControlMessage(role, text))
      ) {
        const itemId = event.itemId ?? event.eventId;
        const prev = items.get(itemId);
        const mergedPrompt = interactivePrompt
          ? (prev?.interactivePrompt?.answered && !interactivePrompt.answered ? prev.interactivePrompt : interactivePrompt)
          : prev?.interactivePrompt;
        items.set(itemId, {
          id: itemId,
          sessionId,
          ...(event.turnId ? { turnId: event.turnId } : {}),
          role,
          text: preserveFullText(text, prev?.text),
          createdAt: event.timestamp,
          origin: event.origin,
          ...(mergedPrompt ? { interactivePrompt: mergedPrompt } : {}),
        });
      }
    }
    if (event.type === "user.message.accepted") {
      const text = eventText(event);
      const attachments = Array.isArray(event.data.attachments)
        ? event.data.attachments as ConversationItem["attachments"]
        : undefined;
      items.set(event.itemId ?? event.eventId, {
        id: event.itemId ?? event.eventId,
        sessionId,
        ...(event.turnId ? { turnId: event.turnId } : {}),
        role: "user",
        text,
        createdAt: event.timestamp,
        origin: event.origin,
        delivery: "session-received",
        ...(attachments?.length ? { attachments } : {}),
        ...(typeof event.data.requestId === "string" ? { requestId: event.data.requestId } : {}),
      });
    }
    if (event.type === "assistant.delta" && !(event.turnId && finalizedAssistantTurns.has(event.turnId))) {
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
      if (!text && !interactivePrompt) continue;
      const itemId = event.itemId ?? event.eventId;
      const prev = items.get(itemId);
      items.set(itemId, {
        id: itemId,
        sessionId,
        ...(event.turnId ? { turnId: event.turnId } : {}),
        role: "assistant",
        text,
        createdAt: event.timestamp,
        origin: "claude-host",
        ...(interactivePrompt
          ? { interactivePrompt }
          : prev?.interactivePrompt
            ? { interactivePrompt: prev.interactivePrompt }
            : {}),
      });
    }
    if (event.type === "tool.started" || event.type === "tool.progress" || event.type === "tool.completed") {
      const id = event.itemId ?? event.eventId;
      const existing = toolByItem.get(id) ?? items.get(`tool:${id}`);
      const toolName = typeof event.data.toolName === "string" && event.data.toolName
        ? event.data.toolName
        : existing?.toolName ?? "工具";
      const text = eventText(event) || existing?.text || toolName;
      const fileChanges = Array.isArray(event.data.fileChanges)
        ? event.data.fileChanges as BridgeFileChangeSummary[]
        : existing?.fileChanges;
      const incomingSubagent = event.data.subagent && typeof event.data.subagent === "object"
        ? event.data.subagent as BridgeSubagentSummary
        : undefined;
      const prevSubagent = existing?.subagent;
      const subagent = incomingSubagent && prevSubagent
        ? (
            incomingSubagent.state === "completed" ||
            (prevSubagent.state !== "completed" && incomingSubagent.updatedAt >= prevSubagent.updatedAt)
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
      toolByItem.set(id, {
        id: `tool:${id}`,
        sessionId,
        ...(event.turnId ? { turnId: event.turnId } : existing?.turnId ? { turnId: existing.turnId } : {}),
        role: "tool",
        toolName,
        text,
        createdAt: existing?.createdAt ?? event.timestamp,
        origin: "claude-host",
        state: subagent?.state ?? (event.type === "tool.completed" ? "completed" : "running"),
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
  const sorted = [...items.values()].flatMap((item) => {
    if (item.role !== "user") return [item];
    const text = item.text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gu, "");
    if (text === item.text) return [item];
    return text.trim() || item.attachments?.length ? [{ ...item, text: text.trim() }] : [];
  }).sort(
    (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id),
  );
  const questionResolvedAt = sessionEvents
    .filter((event) => event.type === "question.resolved")
    .map((event) => event.timestamp);
  for (let i = 0; i < sorted.length; i += 1) {
    const current = sorted[i]!;
    if (!current.interactivePrompt || current.interactivePrompt.answered) continue;
    const nextUser = sorted.slice(i + 1).find((candidate) => candidate.role === "user" && candidate.text.trim());
    if (nextUser) {
      const reply = nextUser.text.trim();
      sorted[i] = {
        ...current,
        interactivePrompt: {
          ...current.interactivePrompt,
          answered: true,
          ...(current.interactivePrompt.actions
            ? {
                actions: current.interactivePrompt.actions.map((action) => (
                  action.message.trim() === reply || action.label.trim() === reply
                    ? { ...action, selected: true }
                    : action
                )),
              }
            : {}),
        },
      };
      continue;
    }
    if (
      current.interactivePrompt.kind === "question" && (
        questionResolvedAt.some((resolvedAt) => resolvedAt >= current.createdAt) ||
        sorted.slice(i + 1).some((candidate) => candidate.role === "assistant")
      )
    ) {
      sorted[i] = {
        ...current,
        interactivePrompt: {
          ...current.interactivePrompt,
          answered: true,
        },
      };
    }
  }
  if (paged) {
    if (!history || (history.status === "loading" && history.items.length === 0)) return [];
    const first = history.items[0];
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
        item.role === "user" && item.id === evidence.turnId
      ));
      if (userIndex < 0) continue;
      const nextUserOffset = items
        .slice(userIndex + 1)
        .findIndex((item) => item.role === "user");
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

interface PermissionFact {
  label: string;
  value: string;
  code?: boolean;
}

export interface PermissionPresentation {
  summary: string;
  facts: PermissionFact[];
  preview?: {
    label: string;
    value: string;
  };
  raw: string;
  mutating: boolean;
}

function inputText(input: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n… 已省略 ${value.length - max} 个字符`;
}

export function permissionPresentation(permission: BridgePermissionInfo): PermissionPresentation {
  const tool = permission.toolName.toLocaleLowerCase();
  const mutating = /(write|edit|bash|delete|remove|move|notebook)/u.test(tool);
  const facts: PermissionFact[] = [];
  const path = inputText(permission.input, "file_path", "path", "notebook_path");
  const command = inputText(permission.input, "command");
  const cwd = inputText(permission.input, "cwd", "working_directory");
  const url = inputText(permission.input, "url");
  const query = inputText(permission.input, "query", "pattern");
  if (path) facts.push({ label: "目标", value: path, code: true });
  if (command) facts.push({ label: "命令", value: truncate(command, 600), code: true });
  if (cwd) facts.push({ label: "目录", value: cwd, code: true });
  if (url) facts.push({ label: "地址", value: url, code: true });
  if (query) facts.push({ label: "查询", value: truncate(query, 300) });

  const ignored = new Set([
    "file_path",
    "path",
    "notebook_path",
    "command",
    "cwd",
    "working_directory",
    "url",
    "query",
    "pattern",
    "content",
    "old_string",
    "new_string",
  ]);
  for (const [key, value] of Object.entries(permission.input)) {
    if (facts.length >= 5 || ignored.has(key)) continue;
    if (typeof value === "string" && value.trim()) {
      facts.push({ label: key, value: truncate(value.trim(), 240) });
    } else if (typeof value === "number" || typeof value === "boolean") {
      facts.push({ label: key, value: String(value) });
    }
  }

  const content = inputText(permission.input, "content", "new_string");
  const oldContent = inputText(permission.input, "old_string");
  const preview = content
    ? { label: oldContent ? "变更后预览" : "内容预览", value: truncate(content, 1_200) }
    : oldContent
      ? { label: "待替换内容", value: truncate(oldContent, 1_200) }
      : undefined;
  const serialized = JSON.stringify(permission.input, null, 2);
  return {
    summary: permission.description
      || permission.displayName
      || (mutating ? "这项操作会修改电脑上的项目内容" : "当前任务需要确认后才能继续"),
    facts,
    ...(preview ? { preview } : {}),
    raw: serialized,
    mutating,
  };
}

function QuestionPrompt({
  permission,
  onResolve,
}: {
  permission: BridgePermissionInfo;
  onResolve(
    requestId: string,
    decision: "allow-once" | "allow-always" | "deny",
    message?: string,
    updatedInput?: Record<string, unknown>,
  ): Promise<void>;
}) {
  const questions = Array.isArray(permission.input.questions)
    ? permission.input.questions.filter((question): question is Record<string, unknown> => (
        Boolean(question) && typeof question === "object"
      ))
    : [];
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const complete = questions.every((question) => (
    typeof question.question === "string" && Boolean(answers[question.question])
  ));
  async function resolveQuestion(
    decision: "allow-once" | "deny",
    updatedInput?: Record<string, unknown>,
  ): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await onResolve(permission.requestId, decision, undefined, updatedInput);
    } catch (resolveError) {
      setError(resolveError instanceof Error ? resolveError.message : "回答提交失败");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="permission-prompt question-prompt">
      <div className="permission-title">
        <strong>{permission.title || "当前任务需要你的选择"}</strong>
        <span>任一已授权设备的首次回答生效</span>
      </div>
      {error && <div className="permission-error" role="alert">{error}</div>}
      {questions.map((question, index) => {
        const prompt = typeof question.question === "string" ? question.question : `问题 ${index + 1}`;
        const options = Array.isArray(question.options)
          ? question.options.filter((option): option is Record<string, unknown> => Boolean(option) && typeof option === "object")
          : [];
        return (
          <fieldset key={prompt}>
            <legend>{prompt}</legend>
            {options.map((option) => {
              const label = typeof option.label === "string" ? option.label : "";
              return (
                <label key={label} className="question-option">
                  <input
                    type="radio"
                    name={`${permission.requestId}:${index}`}
                    checked={answers[prompt] === label}
                    onChange={() => setAnswers((current) => ({ ...current, [prompt]: label }))}
                  />
                  <span><strong>{label}</strong>{typeof option.description === "string" && <small>{option.description}</small>}</span>
                </label>
              );
            })}
          </fieldset>
        );
      })}
      <div className="permission-actions">
        <button type="button" className="secondary-button" disabled={busy} onClick={() => void resolveQuestion("deny")}>取消</button>
        <button
          type="button"
          className="primary-button"
          disabled={!complete || busy}
          onClick={() => void resolveQuestion(
            "allow-once",
            { ...permission.input, answers },
          )}
        >
          {busy && <LoaderCircle className="is-spinning" size={15} />}提交回答
        </button>
      </div>
    </section>
  );
}

function ToolPermissionPrompt({
  permission,
  onResolve,
  onEnableFullAccess,
}: {
  permission: BridgePermissionInfo;
  onResolve(
    requestId: string,
    decision: "allow-once" | "allow-always" | "deny",
    message?: string,
    updatedInput?: Record<string, unknown>,
  ): Promise<void>;
  onEnableFullAccess?(sessionId: string): Promise<void>;
}) {
  const presentation = permissionPresentation(permission);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [confirmFullAccess, setConfirmFullAccess] = useState(false);

  useEffect(() => {
    if (!confirmFullAccess) return;
    return registerMobileBackHandler(() => {
      if (!busy) setConfirmFullAccess(false);
      return true;
    }, 150);
  }, [confirmFullAccess, busy]);

  async function decide(decision: "allow-once" | "allow-always" | "deny"): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await onResolve(permission.requestId, decision);
    } catch (resolveError) {
      setError(resolveError instanceof Error ? resolveError.message : "授权处理失败");
    } finally {
      setBusy(false);
    }
  }

  async function enableFullAccess(): Promise<void> {
    if (!onEnableFullAccess || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await onEnableFullAccess(permission.sessionId);
    } catch (resolveError) {
      setError(resolveError instanceof Error ? resolveError.message : "完全授权设置失败");
    } finally {
      setBusy(false);
      setConfirmFullAccess(false);
    }
  }

  return (
    <>
    <section className="permission-prompt">
      <div className="permission-title">
        <strong>{permission.title || `${permission.toolName} 请求权限`}</strong>
        <span>{presentation.summary}</span>
      </div>
      <div className={`permission-risk ${presentation.mutating ? "mutating" : ""}`}>
        {presentation.mutating ? <AlertTriangle size={16} /> : <Wrench size={16} />}
        <span>{presentation.mutating ? "操作前请核对目标与内容" : "当前任务正在等待你的确认"}</span>
      </div>
      {presentation.facts.length > 0 && (
        <dl className="permission-facts">
          {presentation.facts.map((fact) => (
            <div key={`${fact.label}:${fact.value}`}>
              <dt>{fact.label}</dt>
              <dd className={fact.code ? "is-code" : ""}>{fact.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {presentation.preview && (
        <details className="permission-details">
          <summary><FilePenLine size={15} />{presentation.preview.label}</summary>
          <pre>{presentation.preview.value}</pre>
        </details>
      )}
      <details className="permission-details raw-details">
        <summary><Terminal size={15} />查看完整参数</summary>
        <pre>{presentation.raw}</pre>
      </details>
      {error && <div className="permission-error" role="alert">{error}</div>}
      <div className="permission-actions">
        <button type="button" className="secondary-button danger-text" disabled={busy} onClick={() => void decide("deny")}>拒绝</button>
        <button type="button" className="primary-button" disabled={busy} onClick={() => void decide("allow-once")}>
          {busy && <LoaderCircle className="is-spinning" size={15} />}允许一次
        </button>
        {permission.canAllowAlways && (
          <button type="button" className="secondary-button" disabled={busy} onClick={() => void decide("allow-always")}>始终允许</button>
        )}
        {onEnableFullAccess && (
          <button type="button" className="secondary-button" disabled={busy} onClick={() => setConfirmFullAccess(true)}>
            <ShieldCheck size={15} />电脑默认完全授权
          </button>
        )}
      </div>
    </section>
    <ConfirmationDialog
      open={confirmFullAccess}
      title="更改当前电脑的默认授权模式"
      description={`这会将当前电脑上 ${desktopRuntimeName(permission.sessionId.includes(":") ? permission.sessionId.split(":")[0] as BridgeDesktopRuntimeId : "claude-desktop")} 的默认授权设为完全授权，自动批准使用此默认值的会话命令和文件修改，并处理积压授权；模型的提问仍需回答。`}
      confirmLabel="启用完全授权"
      busy={busy}
      onCancel={() => setConfirmFullAccess(false)}
      onConfirm={() => void enableFullAccess()}
    />
    </>
  );
}

export function PermissionPrompt({
  permission,
  onResolve,
  onEnableFullAccess,
}: {
  permission: BridgePermissionInfo;
  onResolve(
    requestId: string,
    decision: "allow-once" | "allow-always" | "deny",
    message?: string,
    updatedInput?: Record<string, unknown>,
  ): Promise<void>;
  onEnableFullAccess?(sessionId: string): Promise<void>;
}) {
  return permission.toolName === "AskUserQuestion"
    ? <QuestionPrompt permission={permission} onResolve={onResolve} />
    : (
      <ToolPermissionPrompt
        permission={permission}
        onResolve={onResolve}
        {...(onEnableFullAccess ? { onEnableFullAccess } : {})}
      />
    );
}

export function MobileWorkspace({
  activeHostId,
  desktopName,
  connection,
  desktopOnline,
  snapshot,
  permissions,
  focusSessionId,
  visible = true,
  onConversationChange,
  focusRequest,
  onFocusHandled,
  directoryRequest,
  histories,
  evidence,
  artifactPreviews,
  artifactTransfers,
  events,
  localTurns,
  connectionIssue,
  transportMetrics,
  pendingOutbound,
  themeControl,
  onOpenSession,
  onLoadOlderHistory,
  onLoadOlderEvidence,
  onPreviewArtifact,
  onDownloadArtifact,
  onDownloadSessionFile,
  onUploadFile,
  onSendTurn,
  onInterruptTurn,
  onResolveUncertain,
  onResolvePermission,
  onCreateSession,
  onForkSession,
  onLoadSessionConfiguration,
  onConfigureSession,
  onConfigurePermissionPolicy,
  onPreviewProviderSwitch,
  onCommitProviderSwitch,
  onCancelProviderSwitch,
  onPreviewRuntimeHandoff,
  onCommitRuntimeHandoff,
  onConfirmRuntimeHandoff,
  onCancelRuntimeHandoff,
  onGetRuntimeHandoff,
  onPauseRuntimeGoal,
  onResumeRuntimeGoal,
  onArchiveSession,
  onDeleteSession,
  onOpenRuntimeFile,
  onRefreshProviders,
  onDesktopAppAction,
  onRefresh,
  onBackToHosts,
  onRetry,
}: {
  activeHostId: string;
  desktopName: string;
  connection: SocketState;
  desktopOnline: boolean;
  snapshot: BridgeHostSnapshot | undefined;
  permissions: BridgePermissionInfo[];
  focusSessionId?: string | undefined;
  visible?: boolean;
  onConversationChange?(open: boolean): void;
  focusRequest?: { sessionId: string; key: number };
  onFocusHandled?(): void;
  directoryRequest?: number;
  histories: Record<string, SessionHistoryState>;
  evidence: Record<string, SessionEvidenceState>;
  artifactPreviews: Record<string, BridgeArtifactPreview>;
  artifactTransfers: Record<string, number>;
  events: BridgeEvent[];
  localTurns: LocalTurn[];
  connectionIssue?: MobileConnectionIssue | undefined;
  transportMetrics?: BridgeTransportMetrics | undefined;
  pendingOutbound: number;
  themeControl: ThemeControl;
  onOpenSession(sessionId: string): Promise<void>;
  onLoadOlderHistory(sessionId: string): Promise<void>;
  onLoadOlderEvidence(sessionId: string): Promise<void>;
  onPreviewArtifact(artifactId: string): Promise<BridgeArtifactPreview>;
  onDownloadArtifact(artifact: BridgeArtifactManifest): Promise<void>;
  onDownloadSessionFile?(sessionId: string, filePath: string): Promise<void>;
  onUploadFile?: UploadFileHandler;
  onSendTurn(sessionId: string, text: string, attachments: BridgeAttachment[], steer: boolean): Promise<void>;
  onInterruptTurn(sessionId: string, commandId?: string): Promise<void>;
  onResolveUncertain(commandId: string, action: "confirm" | "retry"): Promise<void>;
  onResolvePermission(
    requestId: string,
    decision: "allow-once" | "allow-always" | "deny",
    message?: string,
    updatedInput?: Record<string, unknown>,
  ): Promise<void>;
  onCreateSession(
    cwd: string,
    title?: string,
    runtimeId?: BridgeDesktopRuntimeId,
  ): Promise<BridgeSessionInfo | undefined>;
  onForkSession?(
    sessionId: string,
    title?: string,
  ): Promise<BridgeSessionInfo | undefined>;
  onLoadSessionConfiguration(sessionId: string): Promise<BridgeSessionConfiguration>;
  onConfigureSession(
    sessionId: string,
    change: SessionConfigurationChange,
  ): Promise<BridgeSessionConfiguration>;
  onConfigurePermissionPolicy?(
    sessionId: string,
    scope: "host" | "session",
    mode: BridgePermissionMode | null,
  ): Promise<BridgeSessionConfiguration>;
  onPreviewProviderSwitch(
    sessionId: string,
    targetProviderProfileId: string,
    model?: string,
  ): Promise<ProviderSwitchPreview>;
  onCommitProviderSwitch(
    handoffId: string,
    targetNativeSessionId?: string,
    model?: string,
  ): Promise<ProviderSwitchResult>;
  onCancelProviderSwitch(handoffId: string): Promise<void>;
  onRefreshProviders(): Promise<void>;
  onPreviewRuntimeHandoff(
    sessionId: string,
    targetRuntimeId: BridgeDesktopRuntimeId,
  ): Promise<BridgeRuntimeHandoffPreview>;
  onCommitRuntimeHandoff(handoffId: string): Promise<BridgeRuntimeHandoff>;
  onConfirmRuntimeHandoff(
    handoffId: string,
    objective?: string,
  ): Promise<{ handoff: BridgeRuntimeHandoff }>;
  onCancelRuntimeHandoff(handoffId: string): Promise<BridgeRuntimeHandoff | undefined>;
  onGetRuntimeHandoff(handoffId: string): Promise<BridgeRuntimeHandoff>;
  onPauseRuntimeGoal(sessionId: string): Promise<void>;
  onResumeRuntimeGoal(sessionId: string): Promise<void>;
  onArchiveSession?(sessionId: string, archived: boolean): Promise<void>;
  onOpenRuntimeFile?(sessionId: string, filePath: string): Promise<void>;
  onDeleteSession?(sessionId: string): Promise<void>;
  onDesktopAppAction(
    runtimeId: BridgeDesktopRuntimeId,
    action: "launch" | "quit",
  ): Promise<BridgeDesktopAppStatus[]>;
  onRefresh(sessionId?: string): Promise<boolean>;
  onBackToHosts(): void;
  onRetry(): Promise<void>;
}) {
  const [selectedSessionId, setSelectedSessionId] = useState<string>();
  const [sessionView, setSessionView] = useState<"conversation" | "evidence">("conversation");
  const [search, setSearch] = useState("");
  const [drafts, setDrafts] = useState<Record<string, {
    text: string;
    attachments: BridgeAttachment[];
    sending: boolean;
    steer: boolean;
    imageError?: string | undefined;
  }>>({});
  const draftKey = JSON.stringify([activeHostId, selectedSessionId]);
  const draft = drafts[draftKey] ?? { text: "", attachments: [], sending: false, steer: false };
  const { text, attachments, sending, steer, imageError } = draft;
  function updateDraft(change: (current: typeof draft) => typeof draft): void {
    setDrafts((current) => ({ ...current, [draftKey]: change(current[draftKey] ?? draft) }));
  }
  const [createOpen, setCreateOpen] = useState(false);
  const [createProjectId, setCreateProjectId] = useState("");
  const [createRuntimeId, setCreateRuntimeId] = useState<BridgeDesktopRuntimeId>("claude-desktop");
  const [createTitle, setCreateTitle] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const [configurationSessionId, setConfigurationSessionId] = useState<string>();
  const [actionSessionId, setActionSessionId] = useState<string>();
  const [providerOpen, setProviderOpen] = useState(false);
  const [relayOpen, setRelayOpen] = useState(false);
  const [stoppingSessionId, setStoppingSessionId] = useState<string>();
  const [stopError, setStopError] = useState<string>();
  const [permissionOpen, setPermissionOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [syncFlash, setSyncFlash] = useState(false);
  const [menuSessionId, setMenuSessionId] = useState<string>();
  const [deleteSessionConfirmOpen, setDeleteSessionConfirmOpen] = useState(false);
  const [sessionActionBusy, setSessionActionBusy] = useState(false);
  const [sessionActionError, setSessionActionError] = useState<string>();
  const [directoryMenuOpen, setDirectoryMenuOpen] = useState(false);
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<Set<string>>(() => new Set());
  const [expandedForkParents, setExpandedForkParents] = useState<Set<string>>(() => new Set());
  const [forkChainOpen, setForkChainOpen] = useState(false);
  const [activeProjectId, setActiveProjectId] = useState<string>();
  const [projectSearch, setProjectSearch] = useState("");
  const [runtimeFilter, setRuntimeFilter] = useState<BridgeDesktopRuntimeId | "all">("all");
  useEffect(() => {
    if (runtimeFilter !== "all" && !snapshot?.runtimes?.some((runtime) => runtime.id === runtimeFilter)) setRuntimeFilter("all");
  }, [runtimeFilter, snapshot?.runtimes]);
  const openMedia = useMediaPreview();
  const [pendingFileDownload, setPendingFileDownload] = useState<string>();
  const [fileDownloadBusy, setFileDownloadBusy] = useState(false);
  const [fileDownloadError, setFileDownloadError] = useState<string>();
  const directoryRef = useRef<HTMLElement>(null);
  const directoryScrollPositions = useRef(new Map<string, number>());
  const streamRef = useRef<HTMLElement>(null);
  const streamScrollState = useRef<{
    sessionId?: string | undefined;
    firstKey?: string | undefined;
    lastKey?: string | undefined;
    anchorKey?: string | undefined;
    anchorOffset: number;
    pinnedToBottom: boolean;
  }>({ anchorOffset: 0, pinnedToBottom: true });
  const fileRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const handledFocusRef = useRef<string | undefined>(undefined);
  const handledFocusRequestRef = useRef<number | undefined>(undefined);
  const handledDirectoryRequestRef = useRef<number | undefined>(undefined);
  const announcedPermissionsRef = useRef(new Set<string>());

  const sessions = snapshot?.sessions ?? [];
  const selectedSession = sessions.find((session) => session.sessionId === selectedSessionId);
  const fileUploads = useFileAttachments(selectedSession?.sessionId, onUploadFile);
  const configurationSession = sessions.find((session) => session.sessionId === configurationSessionId);
  const actionSession = sessions.find((session) => session.sessionId === actionSessionId);
  const providers = snapshot?.providers ?? [];
  const providerSwitchingAvailable = Boolean(
    selectedSession && desktopRuntimeId(selectedSession) === "claude-desktop" && supportsProviderSwitching(snapshot),
  );
  const runtimeHandoffAvailable = supportsRuntimeHandoff(snapshot);
  const selectedHistory = selectedSessionId ? histories[selectedSessionId] : undefined;
  const selectedEvidence = selectedSessionId ? evidence[selectedSessionId] : undefined;
  const items = useMemo(
    () => selectedSessionId
      ? conversationItems(selectedSessionId, selectedHistory, events, localTurns, true)
      : [],
    [events, localTurns, selectedHistory, selectedSessionId],
  );
  const fileChangesSummary = useMemo(() => aggregateFileChanges(items), [items]);
  const timeline = useMemo(
    () => conversationTimeline(items, selectedEvidence?.items ?? []),
    [items, selectedEvidence?.items],
  );
  const streamKeys = useMemo(() => timeline.map((entry) => (
    entry.kind === "evidence" ? `evidence:${entry.evidence.id}` : entry.item.id
  )), [timeline]);
  const streamEntering = useStreamEntrance(selectedSessionId, streamKeys);
  const activity = useMemo(() => sessionActivity(selectedSession, items), [selectedSession, items]);
  const grouped = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    const filtered = sessions.filter((session) => (
      !session.archivedAt
      && (runtimeFilter === "all" || desktopRuntimeId(session) === runtimeFilter)
      && (!query || `${session.title}\n${session.projectName}\n${session.cwd}`.toLocaleLowerCase().includes(query))
    ));
    const groups = new Map<string, BridgeSessionInfo[]>();
    for (const session of filtered) {
      const list = groups.get(session.projectId) ?? [];
      list.push(session);
      groups.set(session.projectId, list);
    }
    return [...groups.entries()].map(([projectId, projectSessions]) => ({
      project: snapshot?.projects.find((project) => project.projectId === projectId),
      sessions: sortProjectSessionsByRecent(projectSessions),
    }));
  }, [runtimeFilter, search, sessions, snapshot?.projects]);
  const archivedSessions = useMemo(() => sortProjectSessionsByRecent(sessions.filter((session) => (
    Boolean(session.archivedAt) && (runtimeFilter === "all" || desktopRuntimeId(session) === runtimeFilter)
  ))), [runtimeFilter, sessions]);
  const menuSession = menuSessionId ? sessions.find((session) => session.sessionId === menuSessionId) : undefined;
  const menuSupportsFork = Boolean(menuSession && onForkSession && desktopRuntimeId(menuSession) === "claude-desktop");
  const menuSupportsProviderSwitch = Boolean(menuSession && desktopRuntimeId(menuSession) === "claude-desktop" && supportsProviderSwitching(snapshot));
  const menuSupportsRuntimeHandoff = Boolean(menuSession && runtimeHandoffAvailable && menuSession.allowedActions?.canRelay !== false);
  const menuSessionBusy = Boolean(menuSession && (
    menuSession.turnState === "running"
    || menuSession.turnState === "queued"
    || menuSession.turnState === "waiting"
  ));
  const groupedProjectIds = useMemo(
    () => grouped.map((group) => group.project?.projectId ?? group.sessions[0]!.projectId),
    [grouped],
  );
  const allProjectsCollapsed = groupedProjectIds.length > 0
    && groupedProjectIds.every((projectId) => collapsedProjectIds.has(projectId));
  const allProjectsExpanded = groupedProjectIds.length > 0
    && groupedProjectIds.every((projectId) => !collapsedProjectIds.has(projectId));

  function openSessionFile(filePath: string): void {
    const kind = mediaKind(filePath);
    if (kind && selectedSessionId) {
      openMedia({ name: filePath.split(/[\\/]/u).at(-1) || filePath, kind, sessionId: selectedSessionId, path: filePath });
      return;
    }
    setFileDownloadError(undefined);
    setPendingFileDownload(filePath);
  }

  async function runRefresh(sessionId?: string): Promise<void> {
    if (refreshing) return;
    setRefreshing(true);
    try {
      if (await onRefresh(sessionId)) setSyncFlash(true);
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    if (!syncFlash) return;
    const timer = setTimeout(() => setSyncFlash(false), 2_400);
    return () => clearTimeout(timer);
  }, [syncFlash]);

  useEffect(() => {
    if (!snapshot || !selectedSessionId) return;
    if (restorableSessionId(selectedSessionId, sessions)) return;
    setSelectedSessionId(undefined);
  }, [activeHostId, selectedSessionId, sessions, snapshot]);

  useEffect(() => {
    onConversationChange?.(Boolean(selectedSession));
  }, [onConversationChange, Boolean(selectedSession)]);

  const autoRetriedSessionRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!visible) return;
    if (connection !== "connected" || !selectedSessionId) {
      autoRetriedSessionRef.current = undefined;
      return;
    }
    if (
      !selectedHistory ||
      (selectedHistory.status === "error" && selectedHistory.items.length === 0)
    ) {
      const retryKey = `${selectedSessionId}:${connection}`;
      if (autoRetriedSessionRef.current === retryKey) return;
      autoRetriedSessionRef.current = retryKey;
      void onOpenSession(selectedSessionId);
    }
  }, [connection, onOpenSession, selectedHistory, selectedSessionId, visible]);

  useEffect(() => {
    if (!visible) return;
    return registerMobileBackHandler(() => {
      if (providerOpen) {
        setProviderOpen(false);
        return true;
      }
      if (relayOpen) {
        setRelayOpen(false);
        return true;
      }
      if (permissionOpen) {
        setPermissionOpen(false);
        return true;
      }
      if (configurationSessionId) {
        setConfigurationSessionId(undefined);
        return true;
      }
      if (createOpen) {
        setCreateOpen(false);
        return true;
      }
      if (deleteSessionConfirmOpen) {
        setDeleteSessionConfirmOpen(false);
        return true;
      }
      if (pendingFileDownload) {
        if (!fileDownloadBusy) setPendingFileDownload(undefined);
        return true;
      }
      if (menuSessionId) {
        setMenuSessionId(undefined);
        return true;
      }
      if (directoryMenuOpen) {
        setDirectoryMenuOpen(false);
        return true;
      }
      if (selectedSessionId && sessionView === "evidence") {
        setSessionView("conversation");
        return true;
      }
      if (selectedSessionId) {
        setSelectedSessionId(undefined);
        return true;
      }
      if (activeProjectId) {
        setActiveProjectId(undefined);
        setProjectSearch("");
        return true;
      }
      return false;
    }, 100);
  }, [
    activeProjectId,
    configurationSessionId,
    createOpen,
    deleteSessionConfirmOpen,
    directoryMenuOpen,
    fileDownloadBusy,
    menuSessionId,
    pendingFileDownload,
    permissionOpen,
    providerOpen,
    relayOpen,
    selectedSessionId,
    sessionView,
    visible,
  ]);

  useLayoutEffect(() => {
    if (visible && !selectedSession && directoryRef.current) {
      directoryRef.current.scrollTop = directoryScrollPositions.current.get(activeProjectId ?? "") ?? 0;
    }
  }, [activeProjectId, Boolean(selectedSession), visible]);

  useLayoutEffect(() => {
    const textarea = composerRef.current;
    if (!textarea) return;
    const resize = () => {
      textarea.style.height = "auto";
      textarea.style.height = `${textarea.scrollHeight}px`;
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [draftKey, text, sessionView, visible]);

  function rememberStreamPosition(): void {
    const stream = streamRef.current;
    if (!stream) return;
    const top = stream.getBoundingClientRect().top;
    const anchor = [...stream.querySelectorAll<HTMLElement>(":scope > [data-stream-key]")]
      .find((element) => element.getBoundingClientRect().bottom > top);
    streamScrollState.current = {
      ...streamScrollState.current,
      anchorKey: anchor?.dataset.streamKey,
      anchorOffset: anchor ? anchor.getBoundingClientRect().top - top : 0,
      pinnedToBottom: stream.scrollHeight - stream.scrollTop - stream.clientHeight < 120,
    };
  }

  useLayoutEffect(() => {
    const stream = streamRef.current;
    if (!stream || !selectedSessionId) {
      streamScrollState.current = { anchorOffset: 0, pinnedToBottom: true };
      return;
    }
    const previous = streamScrollState.current;
    const firstKey = streamKeys[0];
    const lastKey = streamKeys.at(-1);
    if (previous.sessionId !== selectedSessionId || !previous.lastKey) {
      stream.scrollTop = stream.scrollHeight;
    } else if (firstKey !== previous.firstKey && previous.anchorKey) {
      // Preserve a visible message's position when an older page is prepended.
      const anchor = [...stream.querySelectorAll<HTMLElement>(":scope > [data-stream-key]")]
        .find((element) => element.dataset.streamKey === previous.anchorKey);
      if (anchor) {
        stream.scrollTop += anchor.getBoundingClientRect().top - stream.getBoundingClientRect().top - previous.anchorOffset;
      }
    } else if (previous.pinnedToBottom) {
      stream.scrollTop = stream.scrollHeight;
    }
    streamScrollState.current = { ...previous, sessionId: selectedSessionId, firstKey, lastKey };
    rememberStreamPosition();
  }, [streamKeys, selectedSessionId, sessionView]);

  useEffect(() => {
    if (search.trim()) setCollapsedProjectIds(new Set());
  }, [search]);

  const autoExpandedForkKeysRef = useRef(new Set<string>());
  useEffect(() => {
    const parentsToExpand: string[] = [];
    for (const session of sessions) {
      if (!session.parentSessionId) continue;
      const isSelected = session.sessionId === selectedSessionId;
      const selectedKey = `selected:${session.sessionId}`;
      if (isSelected) {
        if (!autoExpandedForkKeysRef.current.has(selectedKey)) {
          autoExpandedForkKeysRef.current.add(selectedKey);
          parentsToExpand.push(...getSessionAncestorIds(sessions, session.sessionId));
        }
      } else {
        autoExpandedForkKeysRef.current.delete(selectedKey);
      }
      const isActive = session.turnState === "running" || session.turnState === "waiting" || session.turnState === "queued";
      const activeKey = `active:${session.sessionId}`;
      if (isActive) {
        if (!autoExpandedForkKeysRef.current.has(activeKey)) {
          autoExpandedForkKeysRef.current.add(activeKey);
          parentsToExpand.push(...getSessionAncestorIds(sessions, session.sessionId));
        }
      } else {
        autoExpandedForkKeysRef.current.delete(activeKey);
      }
    }
    if (parentsToExpand.length > 0) {
      setExpandedForkParents((current) => {
        const next = new Set(current);
        for (const parentId of parentsToExpand) next.add(parentId);
        return next.size === current.size ? current : next;
      });
    }
  }, [selectedSessionId, sessions]);

  useEffect(() => {
    if (!visible || directoryRequest === undefined || handledDirectoryRequestRef.current === directoryRequest) return;
    handledDirectoryRequestRef.current = directoryRequest;
    setSelectedSessionId(undefined);
    setActiveProjectId(undefined);
    setProjectSearch("");
    setSessionView("conversation");
    setConfigurationSessionId(undefined);
    setMenuSessionId(undefined);
    setDirectoryMenuOpen(false);
    setProviderOpen(false);
    setRelayOpen(false);
    setPermissionOpen(false);
    setCreateOpen(false);
    setDeleteSessionConfirmOpen(false);
    setPendingFileDownload(undefined);
  }, [directoryRequest, visible]);

  useEffect(() => {
    if (
      !visible ||
      !focusRequest ||
      handledFocusRequestRef.current === focusRequest.key ||
      !sessions.some((session) => session.sessionId === focusRequest.sessionId)
    ) return;
    handledFocusRequestRef.current = focusRequest.key;
    if (focusSessionId === focusRequest.sessionId) handledFocusRef.current = focusSessionId;
    void selectSession(focusRequest.sessionId);
    setPermissionOpen(permissions.some((permission) => permission.sessionId === focusRequest.sessionId));
    onFocusHandled?.();
  }, [focusRequest, focusSessionId, onFocusHandled, permissions, sessions, visible]);

  useEffect(() => {
    if (
      !visible ||
      focusRequest ||
      !focusSessionId ||
      handledFocusRef.current === focusSessionId ||
      !sessions.some((session) => session.sessionId === focusSessionId)
    ) return;
    handledFocusRef.current = focusSessionId;
    void selectSession(focusSessionId);
    setPermissionOpen(permissions.some((permission) => permission.sessionId === focusSessionId));
  }, [focusRequest, focusSessionId, permissions, sessions, visible]);

  useEffect(() => {
    if (!visible || !selectedSessionId) return;
    const next = permissions.find((permission) => (
      permission.sessionId === selectedSessionId &&
      !announcedPermissionsRef.current.has(permission.requestId)
    ));
    if (!next) return;
    announcedPermissionsRef.current.add(next.requestId);
    setPermissionOpen(true);
  }, [permissions, selectedSessionId, visible]);

  useEffect(() => {
    if (
      visible &&
      permissionOpen &&
      selectedSessionId &&
      !permissions.some((permission) => permission.sessionId === selectedSessionId)
    ) {
      setPermissionOpen(false);
    }
  }, [permissionOpen, permissions, selectedSessionId, visible]);

  async function selectSession(sessionId: string): Promise<void> {
    setConfigurationSessionId(undefined);
    setForkChainOpen(false);
    setSessionView("conversation");
    setStopError(undefined);
    setSelectedSessionId(sessionId);
    await onOpenSession(sessionId);
  }

  function toggleProject(projectId: string): void {
    setCollapsedProjectIds((current) => toggleCollapsedProject(current, projectId));
  }

  function toggleForkGroup(parentSessionId: string): void {
    setExpandedForkParents((current) => toggleCollapsedProject(current, parentSessionId));
  }

  function openProjectGroup(projectId: string): void {
    setProjectSearch("");
    setActiveProjectId(projectId);
  }

  function closeProjectGroup(): void {
    setProjectSearch("");
    setActiveProjectId(undefined);
  }

  function openCreateDialogForProject(targetProjectId?: string): void {
    const targetProject = targetProjectId
      ? snapshot?.projects.find((project) => project.projectId === targetProjectId)
      : undefined;
    const runtimeId = targetProject?.runtimeId
      ?? (runtimeFilter === "all"
        ? snapshot?.runtimes?.find((runtime) => (
            runtime.state === "ready" && runtime.capabilities.includes("session.create")
          ))?.id ?? "claude-desktop"
        : runtimeFilter);
    setCreateRuntimeId(runtimeId);
    setCreateProjectId(
      targetProject?.projectId
      ?? snapshot?.projects.find((project) => project.runtimeId === runtimeId)?.projectId
      ?? snapshot?.projects[0]?.projectId
      ?? "",
    );
    setCreateOpen(true);
  }

  async function sendMessage(): Promise<void> {
    if (
      !selectedSession ||
      selectedSession.allowedActions?.canSend === false ||
      sending || fileUploads.uploading ||
      (!text.trim() && (!runtimeSupports(snapshot, selectedSession, "attachment.image") || attachments.length === 0) && fileUploads.files.length === 0)
    ) return;
    const nextText = text.trim();
    const nextAttachments = runtimeSupports(snapshot, selectedSession, "attachment.image") ? attachments : [];
    const nextFiles = fileUploads.files;
    updateDraft((current) => ({ ...current, text: "", attachments: [], sending: true }));
    try {
      await onSendTurn(selectedSession.sessionId, appendUploadedFilePaths(nextText, nextFiles), nextAttachments, steer);
      fileUploads.clear(nextFiles);
      updateDraft((current) => ({ ...current, steer: false }));
    } catch {
      updateDraft((current) => ({
        ...current,
        text: [nextText, current.text].filter(Boolean).join("\n"),
        attachments: [...nextAttachments, ...current.attachments],
      }));
    } finally {
      updateDraft((current) => ({ ...current, sending: false }));
    }
  }

  async function sendQuickReply(promptText: string): Promise<void> {
    if (
      !selectedSession ||
      selectedSession.allowedActions?.canSend === false ||
      sending ||
      !promptText.trim()
    ) return;
    updateDraft((current) => ({ ...current, sending: true }));
    try {
      await onSendTurn(selectedSession.sessionId, promptText.trim(), [], steer);
      updateDraft((current) => ({ ...current, steer: false }));
    } finally {
      updateDraft((current) => ({ ...current, sending: false }));
    }
  }

  async function stopTask(sessionId: string): Promise<void> {
    if (stoppingSessionId) return;
    setStoppingSessionId(sessionId);
    setStopError(undefined);
    try {
      await onInterruptTurn(sessionId);
    } catch (error) {
      setStopError(error instanceof Error ? error.message : "任务停止失败");
    } finally {
      setStoppingSessionId(undefined);
    }
  }

  async function archiveSessionById(sessionId: string, archived: boolean): Promise<void> {
    if (!onArchiveSession || sessionActionBusy) return;
    setSessionActionBusy(true);
    setSessionActionError(undefined);
    try {
      await onArchiveSession(sessionId, archived);
      setMenuSessionId(undefined);
    } catch (error) {
      setSessionActionError(error instanceof Error ? error.message : "归档设置失败");
    } finally {
      setSessionActionBusy(false);
    }
  }

  async function deleteSessionById(sessionId: string): Promise<void> {
    if (!onDeleteSession || sessionActionBusy) return;
    setSessionActionBusy(true);
    setSessionActionError(undefined);
    try {
      await onDeleteSession(sessionId);
      setDeleteSessionConfirmOpen(false);
      setMenuSessionId(undefined);
    } catch (error) {
      setSessionActionError(error instanceof Error ? error.message : "删除会话失败");
    } finally {
      setSessionActionBusy(false);
    }
  }

  async function forkSessionById(sessionId: string): Promise<void> {
    if (!onForkSession || sessionActionBusy) return;
    setSessionActionBusy(true);
    setSessionActionError(undefined);
    try {
      const created = await onForkSession(sessionId);
      if (created) {
        setExpandedForkParents((current) => new Set([
          ...current,
          ...getSessionAncestorIds(sessions, sessionId),
          sessionId,
        ]));
        setCollapsedProjectIds((current) => expandProject(current, created.projectId));
        setMenuSessionId(undefined);
        await selectSession(created.sessionId);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Fork 分支创建失败";
      if (menuSessionId) setSessionActionError(message);
      else setStopError(message);
    } finally {
      setSessionActionBusy(false);
    }
  }

  async function addImages(files: FileList | null): Promise<void> {
    if (!files?.length) return;
    updateDraft((current) => ({ ...current, imageError: undefined }));
    try {
      const candidates = [...files];
      if (candidates.some((file) => file.size > 4 * 1024 * 1024)) throw new Error("单张图片不能超过 4 MB");
      const total = candidates.reduce((sum, file) => sum + file.size, attachments.reduce((sum, item) => sum + item.size, 0));
      if (total > 6 * 1024 * 1024) throw new Error("图片总大小不能超过 6 MB");
      const next = await Promise.all(candidates.map(fileToAttachment));
      updateDraft((current) => ({ ...current, attachments: [...current.attachments, ...next].slice(0, 4) }));
    } catch (error) {
      updateDraft((current) => ({ ...current, imageError: error instanceof Error ? error.message : "图片读取失败" }));
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function createSession(): Promise<void> {
    const project = snapshot?.projects.find((candidate) => candidate.projectId === createProjectId);
    if (!project || createBusy) return;
    setCreateBusy(true);
    try {
      const created = await onCreateSession(
        project.cwd,
        createTitle.trim() || undefined,
        createRuntimeId,
      );
      if (created) {
        setCreateOpen(false);
        setCreateTitle("");
        setCollapsedProjectIds((current) => expandProject(current, created.projectId));
        await onRefresh();
        await selectSession(created.sessionId);
      }
    } finally {
      setCreateBusy(false);
    }
  }

  const sessionOverlays = (
    <>
      {menuSession && (
        <div className="permission-sheet-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !sessionActionBusy) setMenuSessionId(undefined);
        }}>
          <section className="permission-sheet session-menu-sheet" role="dialog" aria-modal="true" aria-labelledby="session-menu-title">
            <header>
              <div>
                <span>会话操作</span>
                <h2 id="session-menu-title">{menuSession.title}</h2>
              </div>
              <IconButton label="关闭" disabled={sessionActionBusy} onClick={() => setMenuSessionId(undefined)}><X size={19} /></IconButton>
            </header>
            <div className="session-menu-actions">
              {canConfigureSession(menuSession) && <p className="mobile-menu-group-title">会话设置</p>}
              {canConfigureSession(menuSession) && (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={sessionActionBusy}
                  onClick={() => {
                    setConfigurationSessionId(menuSession.sessionId);
                    setMenuSessionId(undefined);
                  }}
                >
                  <Settings2 size={17} />模型与会话设置
                </button>
              )}
              {(menuSupportsFork || menuSupportsProviderSwitch || menuSupportsRuntimeHandoff) && <p className="mobile-menu-group-title">分支与接力</p>}
              {menuSupportsFork && (
                <button type="button" className="secondary-button" disabled={sessionActionBusy} onClick={() => void forkSessionById(menuSession.sessionId)}>
                  <GitFork size={17} />Fork 分支会话
                </button>
              )}
              {menuSupportsProviderSwitch && (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={sessionActionBusy}
                  onClick={() => {
                    setActionSessionId(menuSession.sessionId);
                    setProviderOpen(true);
                    setMenuSessionId(undefined);
                  }}
                >
                  <ArrowRightLeft size={17} />切换执行来源 · {providerName(menuSession.activeProviderProfileId, providers)}
                </button>
              )}
              {menuSupportsRuntimeHandoff && (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={sessionActionBusy}
                  onClick={() => {
                    setActionSessionId(menuSession.sessionId);
                    setRelayOpen(true);
                    setMenuSessionId(undefined);
                  }}
                >
                  <Forward size={17} />交给其他桌面应用
                </button>
              )}
              <p className="mobile-menu-group-title">管理</p>
              <button type="button" className="secondary-button" disabled={sessionActionBusy || refreshing} onClick={() => void runRefresh(menuSession.sessionId)}>
                {refreshing ? <LoaderCircle className="is-spinning" size={17} /> : syncFlash ? <Check size={17} /> : <RefreshCw size={17} />}
                {refreshing ? "正在同步" : syncFlash ? "已同步" : "同步会话"}
              </button>
              {onArchiveSession && (
                <button type="button" className="secondary-button" disabled={sessionActionBusy} onClick={() => void archiveSessionById(menuSession.sessionId, !menuSession.archivedAt)}>
                  {menuSession.archivedAt ? <ArchiveRestore size={17} /> : <Archive size={17} />}
                  {menuSession.archivedAt ? "恢复会话" : "归档会话"}
                </button>
              )}
              {onDeleteSession && (
                <>
                  <p className="mobile-menu-group-title">危险操作</p>
                  <button type="button" className="secondary-button danger-text" disabled={sessionActionBusy || menuSessionBusy || Boolean(menuSession.pendingRuntimeHandoff)} onClick={() => setDeleteSessionConfirmOpen(true)}>
                    <Trash2 size={17} />删除会话
                  </button>
                </>
              )}
            </div>
            {(menuSessionBusy || menuSession.pendingRuntimeHandoff) && onDeleteSession && (
              <p className="session-menu-hint">任务或接力进行中，先停止再删除。</p>
            )}
            {sessionActionBusy && <p className="session-menu-hint" role="status"><LoaderCircle className="is-spinning" size={15} />正在处理…</p>}
            {sessionActionError && <p className="session-menu-hint danger-text" role="alert">{sessionActionError}</p>}
          </section>
        </div>
      )}
      <ConfirmationDialog
        open={deleteSessionConfirmOpen && Boolean(menuSession)}
        title="删除会话"
        description={`从 Bridge 列表中删除「${menuSession?.title ?? ""}」？对应 Desktop 应用中的原生会话与文件不受影响；Bridge 中的会话配置、排队与授权记录会被清除，此操作不可恢复。`}
        confirmLabel="删除会话"
        danger
        busy={sessionActionBusy}
        onCancel={() => setDeleteSessionConfirmOpen(false)}
        onConfirm={() => menuSession && void deleteSessionById(menuSession.sessionId)}
      />
      {configurationSession && canConfigureSession(configurationSession) && (
        <SessionConfigurationDialog
          key={configurationSession.sessionId}
          session={configurationSession}
          permissionScope="session"
          onLoad={() => onLoadSessionConfiguration(configurationSession.sessionId)}
          onSave={(change) => onConfigureSession(configurationSession.sessionId, change)}
          {...(onConfigurePermissionPolicy ? {
            onConfigurePermission: (scope: "host" | "session", mode: BridgePermissionMode | null) => (
              onConfigurePermissionPolicy(configurationSession.sessionId, scope, mode)
            ),
          } : {})}
          onClose={() => setConfigurationSessionId(undefined)}
        />
      )}
      {providerOpen && actionSession && desktopRuntimeId(actionSession) === "claude-desktop" && supportsProviderSwitching(snapshot) && (
        <ProviderSwitchDialog
          key={actionSession.sessionId}
          session={actionSession}
          profiles={providers}
          onPreview={(targetProviderProfileId, model) => onPreviewProviderSwitch(actionSession.sessionId, targetProviderProfileId, model)}
          onCommit={onCommitProviderSwitch}
          onCancel={onCancelProviderSwitch}
          onRefresh={async () => {
            await onRefreshProviders();
            await onRefresh();
          }}
          onChanged={() => void onRefresh()}
          onClose={() => setProviderOpen(false)}
        />
      )}
      {relayOpen && actionSession && runtimeHandoffAvailable && (
        <RuntimeHandoffDialog
          key={actionSession.sessionId}
          session={actionSession}
          runtimes={snapshot?.runtimes ?? []}
          onPreview={(targetRuntimeId) => onPreviewRuntimeHandoff(actionSession.sessionId, targetRuntimeId)}
          onCommit={onCommitRuntimeHandoff}
          onConfirm={onConfirmRuntimeHandoff}
          onCancel={onCancelRuntimeHandoff}
          onGet={onGetRuntimeHandoff}
          onOpenSession={(sessionId) => {
            setRelayOpen(false);
            void selectSession(sessionId);
          }}
          onClose={() => setRelayOpen(false)}
        />
      )}
    </>
  );

  if (!visible) return null;

  if (selectedSession) {
    const runtimeName = desktopRuntimeName(desktopRuntimeId(selectedSession));
    const canAttachImages = runtimeSupports(snapshot, selectedSession, "attachment.image");
    const canConfigure = canConfigureSession(selectedSession);
    const officialActive = usesOfficialComposer(selectedSession, providers);
    const bridgeRunning = selectedSession.turnState === "running"
      && (
        selectedSession.ownership === "BRIDGE_RUNNING" ||
        selectedSession.ownership === "DESKTOP_MANAGED_RUNNING"
      );
    const stopTarget = stoppableBridgeTask(sessions, selectedSession.sessionId);
    const canStop = Boolean(stopTarget);
    const stopping = stoppingSessionId === stopTarget?.sessionId;
    const stoppingBlocker = Boolean(stopTarget && stopTarget.sessionId !== selectedSession.sessionId);
    const sessionPermissions = permissions.filter((permission) => permission.sessionId === selectedSession.sessionId);
    const activePermission = sessionPermissions[0];
    const otherPermission = permissions.find((permission) => permission.sessionId !== selectedSession.sessionId);
    const otherPermissionSession = otherPermission
      ? sessions.find((session) => session.sessionId === otherPermission.sessionId)
      : undefined;
    const evidenceCount = (selectedEvidence?.items.length ?? 0) + (fileChangesSummary ? 1 : 0);
    const displayNodes = groupTimelineTools(timeline);
    const parentSession = selectedSession.parentSessionId
      ? sessions.find((candidate) => candidate.sessionId === selectedSession.parentSessionId)
      : undefined;
    const childForks = sessions.filter((candidate) => (
      candidate.parentSessionId === selectedSession.sessionId && !candidate.archivedAt
    ));
    const relatedForkCount = (parentSession ? 1 : 0) + childForks.length;
    return (
      <main className="mobile-workspace conversation-workspace">
        <header className="mobile-topbar conversation-topbar">
          <IconButton label={sessionView === "evidence" ? "返回对话" : "返回会话列表"} onClick={() => {
            if (sessionView === "evidence") setSessionView("conversation");
            else {
              setForkChainOpen(false);
              setSelectedSessionId(undefined);
            }
          }}><ArrowLeft size={21} /></IconButton>
          <div className="mobile-device">
            <strong>{selectedSession.title}</strong>
            <span className={`session-presence ${selectedSession.turnState}`}>
              <i />{conciseSessionSubtitle(selectedSession)}
            </span>
          </div>
          <IconButton label="会话操作" onClick={() => {
            setSessionActionError(undefined);
            setMenuSessionId(selectedSession.sessionId);
          }}><MoreHorizontal size={20} /></IconButton>
        </header>
        <nav className="mobile-conversation-tabs" aria-label="会话视图">
          <button type="button" className={sessionView === "conversation" ? "active" : ""} aria-pressed={sessionView === "conversation"} onClick={() => setSessionView("conversation")}>对话</button>
          <button type="button" className={sessionView === "evidence" ? "active" : ""} aria-pressed={sessionView === "evidence"} onClick={() => setSessionView("evidence")}>成果{evidenceCount > 0 ? ` ${evidenceCount}` : ""}</button>
          {relatedForkCount > 0 && (
            <button
              type="button"
              className={`mobile-fork-chain-trigger${forkChainOpen ? " is-open" : ""}`}
              aria-expanded={forkChainOpen}
              onClick={() => setForkChainOpen((current) => !current)}
            >
              <GitFork size={13} />
              <span>{childForks.length > 0 ? `分支 ${childForks.length}` : "主会话"}</span>
              <ChevronDown size={13} className="mobile-fork-chain-chevron" />
            </button>
          )}
        </nav>

        {selectedSession.ownership === "FALLBACK_CONFIRMATION_REQUIRED" && (
          <div className="session-channel-warning">
            <AlertTriangle size={17} />
            <span><strong>正在等待同会话接管</strong>电脑端当前任务结束后会自动发送，无需额外操作。</span>
          </div>
        )}
        {selectedSession.ownership === "OWNERSHIP_CONFLICT" && (
          <div className="session-channel-warning danger">
            <AlertTriangle size={17} />
            <span><strong>检测到重复写入</strong>Bridge 已停止重叠写入并会自动复查；当前指令保留排队，无需重复发送。</span>
          </div>
        )}
        {selectedSession.goal && (
          <div className={`session-channel-warning goal-status ${selectedSession.goal.status}`}>
            <Goal size={17} />
            <span>
              <strong>{goalStatusLabel(selectedSession.goal.status)}</strong>
              {selectedSession.goal.objective}
              {selectedSession.goal.detail ? ` · ${selectedSession.goal.detail}` : ""}
              {selectedSession.goal.continuations > 0 ? ` · 已续跑 ${selectedSession.goal.continuations} 轮` : ""}
            </span>
            {selectedSession.goal.status === "active" ? (
              <button
                type="button"
                className="secondary-button goal-action"
                onClick={() => void onPauseRuntimeGoal(selectedSession.sessionId).catch(() => undefined)}
              >
                暂停目标
              </button>
            ) : selectedSession.goal.status !== "complete" ? (
              <button
                type="button"
                className="secondary-button goal-action"
                onClick={() => void onResumeRuntimeGoal(selectedSession.sessionId).catch(() => undefined)}
              >
                继续目标
              </button>
            ) : null}
          </div>
        )}
        {(selectedSession.relay?.inbound || selectedSession.relay?.outbound?.length) && (
          <div className="relay-chain-bar">
            {selectedSession.relay.inbound && (
              <button
                type="button"
                className="relay-chain-link"
                onClick={() => void selectSession(selectedSession.relay!.inbound!.sessionId)}
              >
                <Forward size={14} />
                {`接力自 ${selectedSession.relay.inbound.title}`}
              </button>
            )}
            {selectedSession.relay.outbound?.map((link) => (
              <button
                type="button"
                className="relay-chain-link outbound"
                key={link.handoffId}
                onClick={() => void selectSession(link.sessionId)}
              >
                <Forward size={14} />
                {`接力至 ${link.title}`}
              </button>
            ))}
          </div>
        )}
        {forkChainOpen && relatedForkCount > 0 && (
          <div className="relay-chain-bar fork-chain-bar">
            {parentSession && (
              <button
                type="button"
                className="relay-chain-link"
                onClick={() => {
                  setForkChainOpen(false);
                  void selectSession(parentSession.sessionId);
                }}
              >
                <GitFork size={14} />
                {`主会话：${parentSession.title}`}
              </button>
            )}
            {childForks.map((fork) => (
              <button
                type="button"
                className="relay-chain-link outbound"
                key={fork.sessionId}
                onClick={() => {
                  setForkChainOpen(false);
                  void selectSession(fork.sessionId);
                }}
              >
                <GitFork size={14} />
                {`${fork.forkLabel || "fork"} · ${fork.title}`}
              </button>
            ))}
          </div>
        )}
        {stopError && (
          <div className="session-channel-warning danger">
            <AlertTriangle size={17} />
            <span><strong>任务停止失败</strong>{stopError}</span>
          </div>
        )}
        {fileDownloadError && (
          <div className="session-channel-warning danger">
            <AlertTriangle size={17} />
            <span><strong>文件下载失败</strong>{fileDownloadError}</span>
            <button type="button" className="secondary-button goal-action" onClick={() => setFileDownloadError(undefined)}>关闭</button>
          </div>
        )}
        {providerSwitchingAvailable && selectedSession.routeState && selectedSession.routeState !== "ready" && (
          <button
            type="button"
            className="session-channel-warning provider-route-banner"
            onClick={() => {
              setActionSessionId(selectedSession.sessionId);
              setProviderOpen(true);
            }}
          >
            <ArrowRightLeft size={17} />
            <span>
              <strong>{selectedSession.routeState === "awaiting-user-confirmation"
                ? "等待本机确认"
                : selectedSession.routeState === "awaiting-target-selection"
                  ? "选择 Claude 官方会话"
                  : selectedSession.routeState === "failed"
                    ? "提供方切换未完成"
                    : "正在切换执行通道"}</strong>
              {selectedSession.pendingHandoff?.summary ?? "原执行通道保持活动。"}
            </span>
          </button>
        )}

        <div className={`permission-dock-slot ${activePermission || otherPermission ? "has-attention" : ""}`}>
          {activePermission ? (
            <button type="button" className="permission-dock" onClick={() => setPermissionOpen(true)}>
              <span className="permission-dock-icon"><AlertTriangle size={18} /></span>
              <span><strong>{runtimeName} 正在等待授权</strong><small>{activePermission.title || activePermission.displayName || activePermission.toolName}</small></span>
              <b>{sessionPermissions.length > 1 ? `${sessionPermissions.length} 项` : "处理"}</b>
            </button>
          ) : otherPermission && otherPermissionSession ? (
            <button type="button" className="permission-dock" onClick={() => void selectSession(otherPermission.sessionId)}>
              <span className="permission-dock-icon"><AlertTriangle size={18} /></span>
              <span><strong>另一会话需要处理</strong><small>{otherPermissionSession.title}</small></span>
              <b>前往</b>
            </button>
          ) : null}
        </div>

        {sessionView === "conversation" ? (
        <section
          className="conversation-stream"
          aria-live="polite"
          ref={streamRef}
          onScroll={rememberStreamPosition}
        >
          {selectedHistory?.hasMore && (
            <button
              type="button"
              className="load-older-button"
              disabled={selectedHistory.status === "loading"}
              onClick={() => void onLoadOlderHistory(selectedSession.sessionId)}
            >
              {selectedHistory.status === "loading" && <LoaderCircle className="is-spinning" size={15} />}
              {selectedHistory.status === "loading" ? "正在分段加载更早消息…" : "加载更早消息"}
            </button>
          )}
          {selectedHistory?.status === "loading" && selectedHistory.items.length === 0 && (
            <div className="conversation-loading"><LoaderCircle className="is-spinning" size={20} />正在加载最新对话…</div>
          )}
          {selectedHistory?.status === "error" && selectedHistory.items.length === 0 && (
            <div className="conversation-empty">
              <strong>会话暂时无法读取</strong>
              {selectedHistory.error && <span className="conversation-error-detail">{selectedHistory.error}</span>}
              <button type="button" className="secondary-button" onClick={() => void onOpenSession(selectedSession.sessionId)}>重试</button>
            </div>
          )}
          {items.length === 0 && selectedHistory?.status === "ready" && (
            <div className="conversation-empty">
              <strong>这是一个空会话</strong>
              <span>从下方发出第一条指令。</span>
            </div>
          )}
          {displayNodes.map((node) => {
            if (node.kind === "evidence") {
              return (
                <EvidenceInlineSummary
                  evidence={node.evidence}
                  key={`evidence:${node.evidence.id}`}
                  entering={streamEntering(`evidence:${node.evidence.id}`)}
                  onOpen={() => setSessionView("evidence")}
                />
              );
            }
            if (node.kind === "tool-group") {
              const uniqueNames = [...new Set(node.tools.map((t) => t.toolName || "工具"))].slice(0, 3);
              const anyRunning = node.tools.some((t) => t.state === "running");
              const singleTool = node.tools.length === 1 ? node.tools[0] : undefined;
              const summaryText = singleTool
                ? `${singleTool.toolName || "工具"}${singleTool.text && singleTool.text !== singleTool.toolName ? ` · ${singleTool.text}` : ""}`
                : `${anyRunning ? "正在执行" : "已调用"} ${node.tools.length} 个工具 (${uniqueNames.join("、")})`;
              return (
                <details className={`conversation-tool-group ${anyRunning ? "is-running" : ""}`} data-stream-key={`tool-group:${node.tools.at(-1)!.id}`} key={node.id}>
                  <summary>
                    <Wrench size={13} aria-hidden="true" />
                    <span>{summaryText}</span>
                    <ChevronDown size={13} className="tool-group-chevron" aria-hidden="true" />
                  </summary>
                  <div className="conversation-tool-group-list">
                    {node.tools.map((tool) => (
                      <div className="conversation-tool-row" key={tool.id}>
                        <strong>{tool.toolName || "工具"}</strong>
                        {tool.text && tool.text !== tool.toolName && <span>{tool.text}</span>}
                      </div>
                    ))}
                  </div>
                </details>
              );
            }
            const item = node.item;
            if (item.subagent) {
              return (
                <SubagentCard
                  item={item}
                  key={item.id}
                  entering={streamEntering(item.id)}
                  {...(onDownloadSessionFile ? {
                    onFileClick: openSessionFile,
                  } : {})}
                />
              );
            }
            const showDelivery = Boolean(
              item.delivery
              && item.delivery !== "session-received"
              && item.delivery !== "completed",
            );
            return (
              <article
                className={`conversation-item ${item.role} ${item.live ? "live" : ""}${streamEntering(item.id) ? " is-entering" : ""}`}
                data-stream-key={item.id}
                key={item.id}
              >
                {item.role === "system" && (
                  <div className="conversation-item-meta">
                    <strong>Bridge</strong>
                    <time>{formatTime(item.createdAt)}</time>
                  </div>
                )}
                {item.text && (
                  item.role === "assistant" || item.role === "user" ? (
                    <MarkdownText
                      text={item.text}
                      collapsible={!item.live}
                      {...(onDownloadSessionFile ? {
                        onFileClick: openSessionFile,
                      } : {})}
                    />
                  ) : (
                    <div className="conversation-text">{item.text}</div>
                  )
                )}
                {item.interactivePrompt && (
                  <InteractivePromptCard
                    prompt={item.interactivePrompt}
                    canSend={selectedSession.allowedActions?.canSend !== false && !officialActive}
                    busy={sending}
                    onSelectOption={(replyText) => {
                      if (item.interactivePrompt?.kind === "question") {
                        const pendingQuestion = sessionPermissions.find((permission) => permission.toolName === "AskUserQuestion");
                        if (pendingQuestion) {
                          const questions = item.interactivePrompt.questions ?? [];
                          if (questions.length === 1 && !questions[0]?.multiSelect) {
                            void onResolvePermission(
                              pendingQuestion.requestId,
                              "allow-once",
                              undefined,
                              { ...pendingQuestion.input, answers: { [questions[0]!.question]: replyText } },
                            );
                            return;
                          }
                          setPermissionOpen(true);
                          return;
                        }
                      }
                      void sendQuickReply(replyText);
                    }}
                  />
                )}
                {item.attachments?.length ? (
                  <div className="conversation-attachments">
                    {item.attachments.map((attachment) => attachment.data ? (
                      <button type="button" className="conversation-image-preview" key={attachment.id} aria-label={`查看 ${attachment.name}`} onClick={() => openMedia({ name: attachment.name, kind: "image", dataUrl: `data:${attachment.mimeType};base64,${attachment.data}` })}><img src={`data:${attachment.mimeType};base64,${attachment.data}`} alt={attachment.name} loading="lazy" /></button>
                    ) : (
                      <span className="attachment-chip" key={attachment.id}>{attachment.name}</span>
                    ))}
                  </div>
                ) : null}
                {(item.role === "assistant" || item.role === "user") && item.text.trim() && (
                  <div className="conversation-message-actions">
                    <MessageCopyButton text={item.text} label={item.role === "assistant" ? "复制这条回复" : "复制这条消息"} />
                  </div>
                )}
                {showDelivery && <div className={`delivery-state ${item.delivery}`}>{deliveryLabel(item.delivery!)}</div>}
                {item.delivery === "failed" && item.error && (
                  <div className="delivery-error-detail">{item.error}</div>
                )}
                {item.delivery === "uncertain" && item.commandId && (
                  <div className="uncertain-delivery-actions">
                    <button type="button" className="secondary-button" onClick={() => void onResolveUncertain(item.commandId!, "confirm")}>确认已发送</button>
                    <button type="button" className="secondary-button" onClick={() => void onResolveUncertain(item.commandId!, "retry")}>检查后重发</button>
                  </div>
                )}
                {item.live && <span className="stream-caret" aria-label="正在生成" />}
              </article>
            );
          })}
        </section>
        ) : (
          <section className="mobile-evidence-view">
            <MediaGallery artifacts={mediaArtifacts(selectedEvidence?.items ?? [])} online={connection === "connected" && desktopOnline} />
            {fileChangesSummary && (
              <FileChangesCard
                summary={fileChangesSummary}
                onPreviewFile={openSessionFile}
                transfers={artifactTransfers}
                online={connection === "connected" && desktopOnline}
                {...(onOpenRuntimeFile && isNativeRuntimeId(selectedSession.runtimeId) ? {
                  onOpenFile: (filePath) => void onOpenRuntimeFile(selectedSession.sessionId, filePath),
                } : {})}
                {...(onDownloadSessionFile ? {
                  onDownloadFile: (filePath) => {
                    setFileDownloadError(undefined);
                    setPendingFileDownload(filePath);
                  },
                } : {})}
              />
            )}
            <EvidencePanel
              state={selectedEvidence}
              previews={artifactPreviews}
              transfers={artifactTransfers}
              online={connection === "connected" && desktopOnline}
              suppressEmpty={Boolean(fileChangesSummary)}
              onLoadMore={() => onLoadOlderEvidence(selectedSession.sessionId)}
              onPreview={onPreviewArtifact}
              onDownload={onDownloadArtifact}
            />
          </section>
        )}

        {sessionView === "conversation" && (
        <>
        <SessionActivityIndicator activity={activity} />
        <section className="mobile-composer">
          <div className="mobile-directory-tools">
            {canConfigure && (
              <button type="button" className="mobile-session-settings-trigger" onClick={() => setConfigurationSessionId(selectedSession.sessionId)}>
                <Settings2 size={14} /><span>{conciseModelName(selectedSession)} · 会话设置</span>
              </button>
            )}
            {canStop && (
              <button type="button" className="session-provider-trigger is-stop" disabled={stopping} onClick={() => stopTarget && void stopTask(stopTarget.sessionId)}>
                {stopping ? <LoaderCircle className="is-spinning" size={14} /> : <CircleStop size={14} />}
                <span>{stopping ? "停止中" : stoppingBlocker ? "停止阻塞任务" : "停止任务"}</span>
              </button>
            )}
          </div>
          {officialActive ? (
            <button
              type="button"
              className="official-continue-button"
              onClick={() => void onDesktopAppAction("claude-desktop", "launch")}
            >
              <ArrowRightLeft size={18} />
              在 Claude 官方继续
            </button>
          ) : (
          <>
          {connectionIssue && (
            <button type="button" className="composer-connection" onClick={() => void onRetry()}>
              {connectionIssue.message} 点击重试
            </button>
          )}
          {onUploadFile && <FileAttachmentPicker state={fileUploads} disabled={selectedSession.allowedActions?.canSend === false || sending || connection !== "connected" || !desktopOnline} />}
          {attachments.length > 0 && (
            <div className="composer-attachments">
              {attachments.map((attachment) => (
                <span key={attachment.id}>
                  {attachment.name}
                  <button type="button" aria-label={`移除 ${attachment.name}`} onClick={() => updateDraft((current) => ({ ...current, attachments: current.attachments.filter((item) => item.id !== attachment.id) }))}>
                    <X size={13} />
                  </button>
                </span>
              ))}
            </div>
          )}
          {imageError && <div className="composer-error">{imageError}</div>}
          {bridgeRunning && selectedSession.allowedActions?.canSteer !== false && (
            <div className="composer-mode" role="group" aria-label="发送方式">
              <button type="button" className={!steer ? "active" : ""} onClick={() => updateDraft((current) => ({ ...current, steer: false }))}>排到下一轮</button>
              <button type="button" className={steer ? "active" : ""} onClick={() => updateDraft((current) => ({ ...current, steer: true }))}>立即调整</button>
            </div>
          )}
          <form
            className={canAttachImages ? "composer-form composer-form--with-attachment" : "composer-form"}
            onSubmit={(event) => { event.preventDefault(); void sendMessage(); }}
          >
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/gif,image/webp"
              multiple
              hidden
              onChange={(event) => void addImages(event.target.files)}
            />
            {canAttachImages && (
              <IconButton
                label="添加图片"
                disabled={selectedSession.allowedActions?.canSend === false}
                onClick={() => fileRef.current?.click()}
              >
                <ImagePlus size={20} />
              </IconButton>
            )}
            <textarea
              ref={composerRef}
              value={text}
              onChange={({ target: { value } }) => updateDraft((current) => ({ ...current, text: value }))}
              disabled={selectedSession.allowedActions?.canSend === false}
              placeholder={desktopOnline
                ? selectedSession.allowedActions?.reason ?? (
                    selectedSession.source === "bridge"
                      ? "给这个 Bridge 会话发指令"
                      : `给这个 ${runtimeName} 会话发指令`
                  )
                : "电脑离线，消息会保存在手机并自动送达"}
              rows={1}
              aria-label={`给 ${runtimeName} 发指令`}
            />
            <button
              type="submit"
              className="send-button"
              aria-label="发送"
              disabled={selectedSession.allowedActions?.canSend === false || sending || fileUploads.uploading || (!text.trim() && (!canAttachImages || attachments.length === 0) && fileUploads.files.length === 0)}
            >
              {sending ? <LoaderCircle className="is-spinning" size={19} /> : <Send size={19} />}
            </button>
          </form>
          </>
          )}
        </section>
        </>
        )}
        {permissionOpen && activePermission && (
          <div className="permission-sheet-backdrop" role="presentation" onMouseDown={(event) => {
            if (event.target === event.currentTarget) setPermissionOpen(false);
          }}>
            <section className="permission-sheet" role="dialog" aria-modal="true" aria-labelledby="permission-sheet-title">
              <header>
                <div>
                  <span>需要处理</span>
                  <h2 id="permission-sheet-title">{runtimeName} 等待授权</h2>
                </div>
                <IconButton label="暂时关闭" onClick={() => setPermissionOpen(false)}><X size={19} /></IconButton>
              </header>
              {sessionPermissions.length > 1 && <div className="permission-queue-count">还有 {sessionPermissions.length} 项待处理，提交后自动显示下一项。</div>}
              <PermissionPrompt
                permission={activePermission}
                onResolve={onResolvePermission}
                {...(onConfigurePermissionPolicy ? {
                  onEnableFullAccess: (sessionId: string) => (
                    onConfigurePermissionPolicy(sessionId, "host", "full-access").then(() => undefined)
                  ),
                } : {})}
              />
            </section>
          </div>
        )}
        <ConfirmationDialog
          open={Boolean(pendingFileDownload)}
          title="确认下载远程文件到手机？"
          description={pendingFileDownload
            ? `即将从电脑工作区下载「${pendingFileDownload.split(/[\\/]/u).at(-1) || pendingFileDownload}」（${pendingFileDownload}）到手机端，是否继续？`
            : ""}
          confirmLabel="确认下载"
          busy={fileDownloadBusy}
          onCancel={() => {
            if (!fileDownloadBusy) setPendingFileDownload(undefined);
          }}
          onConfirm={() => {
            if (!pendingFileDownload || !onDownloadSessionFile || fileDownloadBusy) return;
            const targetPath = pendingFileDownload;
            setFileDownloadBusy(true);
            setFileDownloadError(undefined);
            void onDownloadSessionFile(selectedSession.sessionId, targetPath)
              .then(() => {
                setPendingFileDownload(undefined);
              })
              .catch((downloadError) => {
                setPendingFileDownload(undefined);
                setFileDownloadError(
                  downloadError instanceof Error ? downloadError.message : "远程文件下载失败",
                );
              })
              .finally(() => {
                setFileDownloadBusy(false);
              });
          }}
        />
        {sessionOverlays}
      </main>
    );
  }

  const populatedRuntimeCount = new Set(sessions.map((session) => desktopRuntimeId(session))).size;
  const showRuntimeFilter = populatedRuntimeCount > 1 && (snapshot?.runtimes?.length ?? 0) > 1;
  const isArchivedGroupPage = activeProjectId === "__archived__";
  const activeGroupProject = activeProjectId && !isArchivedGroupPage
    ? snapshot?.projects.find((project) => project.projectId === activeProjectId)
    : undefined;
  const activeGroupSessionsAll = activeProjectId
    ? isArchivedGroupPage
      ? archivedSessions
      : sortProjectSessionsByRecent(sessions.filter((session) => (
          !session.archivedAt
          && session.projectId === activeProjectId
          && (runtimeFilter === "all" || desktopRuntimeId(session) === runtimeFilter)
        )))
    : [];
  const activeGroupQuery = projectSearch.trim().toLocaleLowerCase();
  const activeGroupSessions = activeGroupQuery
    ? activeGroupSessionsAll.filter((session) => (
        `${session.title}\n${session.currentSummary ?? ""}\n${desktopRuntimeName(desktopRuntimeId(session))}`
          .toLocaleLowerCase()
          .includes(activeGroupQuery)
      ))
    : activeGroupSessionsAll;
  const activeGroupName = isArchivedGroupPage
    ? "已归档会话"
    : activeGroupProject?.name
      ?? activeGroupSessionsAll[0]?.projectName
      ?? sessions.find((session) => session.projectId === activeProjectId)?.projectName
      ?? "项目分组";
  const activeGroupCwd = isArchivedGroupPage
    ? "归档会话保留历史，可随时恢复"
    : activeGroupProject?.cwd
      ?? activeGroupSessionsAll[0]?.cwd
      ?? sessions.find((session) => session.projectId === activeProjectId)?.cwd
      ?? "";

  const activeGroupFamilies = groupProjectSessionFamilies(activeGroupSessions);
  const hostStatusText = desktopOnline
    ? (pendingOutbound > 0 ? `在线 · ${pendingOutbound} 条待发` : mobileConnectionLabel(connection, desktopOnline, transportMetrics, snapshot?.host.version))
    : connection === "connecting" || connection === "reconnecting"
      ? "正在连接"
      : (pendingOutbound > 0 ? `离线 · ${pendingOutbound} 条待发` : "离线");

  function renderMobileSessionFamily(
    family: SessionFamily<BridgeSessionInfo>,
    isArchivedList = false,
    isForkChild = false,
  ): ReactNode {
    const { primary: session, forks } = family;
    const badge = isArchivedList ? "已归档" : activeSessionBadgeLabel(session);
    const forksExpanded = expandedForkParents.has(session.sessionId);
    return (
      <div className="mobile-session-family" key={session.sessionId}>
        <div className={`session-row-v2 ${isForkChild ? "is-fork-child" : ""}`} data-session-id={session.sessionId}>
          <button
            type="button"
            className="session-row-hit"
            onClick={() => void selectSession(session.sessionId)}
          >
            <span className={`session-state-dot ${session.turnState}`} />
            <span className="session-row-copy">
              <strong>
                {isForkChild && <em className="session-fork-badge">{session.forkLabel || "fork"}</em>}
                {session.title}
                {!isForkChild && session.parentSessionId && (
                  <em className="session-fork-badge">{session.forkLabel || "fork"}</em>
                )}
              </strong>
              <small>
                {!isForkChild && populatedRuntimeCount > 1 ? `${desktopRuntimeName(desktopRuntimeId(session))} · ` : ""}
                {relativeTime(session.lastActivityAt)}
                {!isArchivedList && session.currentSummary ? ` · ${session.currentSummary}` : ""}
              </small>
            </span>
            {badge && <span className={`session-row-status ${session.turnState}`}>{badge}</span>}
          </button>
          <IconButton
              label="会话操作"
              className="session-row-action"
              onClick={() => {
                setSessionActionError(undefined);
                setMenuSessionId(session.sessionId);
              }}
            >
              <MoreHorizontal size={18} />
          </IconButton>
        </div>
        {forks.length > 0 && (
          <div className={`mobile-fork-group ${forksExpanded ? "expanded" : "collapsed"}`}>
            <button
              type="button"
              className="mobile-fork-toggle"
              aria-expanded={forksExpanded}
              onClick={() => toggleForkGroup(session.sessionId)}
            >
              <GitFork size={12} />
              <span>{forks.length} 个 Fork 分支</span>
              {forksExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            </button>
            {forksExpanded && (
              <div className="mobile-fork-children">
                {forks.map((fork) => renderMobileSessionFamily(fork, isArchivedList, true))}
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <main className="mobile-workspace host-detail-workspace">
      <header className={`mobile-topbar mobile-directory-topbar${activeProjectId ? " has-back" : ""}`}>
        {activeProjectId && <IconButton label="返回会话目录" onClick={closeProjectGroup}><ArrowLeft size={21} /></IconButton>}
        <div className="mobile-directory-title">
          <h1>{activeProjectId ? activeGroupName : "会话"}</h1>
          <button type="button" className="mobile-device" onClick={onBackToHosts} aria-label={`当前电脑：${desktopName}，查看电脑`}>
            <span className={desktopOnline ? "online" : ""}><i />{desktopName} · {hostStatusText}<ChevronDown size={12} /></span>
          </button>
        </div>
        <div className="mobile-directory-tools">
          <IconButton label="目录更多" onClick={() => setDirectoryMenuOpen(true)}><MoreHorizontal size={20} /></IconButton>
        </div>
      </header>

      {activeProjectId ? (
        <section className="host-detail project-detail-view" ref={directoryRef} onScroll={(event) => directoryScrollPositions.current.set(activeProjectId, event.currentTarget.scrollTop)}>
          <div className="catalog-toolbar">
            <label className="session-search">
              <Search size={16} />
              <input
                value={projectSearch}
                onChange={(event) => setProjectSearch(event.target.value)}
                placeholder={`搜索「${activeGroupName}」`}
              />
            </label>
            {!isArchivedGroupPage && (
              <button
                type="button"
                className="primary-button catalog-create-btn"
                disabled={!snapshot?.projects.length}
                onClick={() => openCreateDialogForProject(activeProjectId)}
              >
                <Plus size={16} />新建
              </button>
            )}
          </div>
          {activeGroupCwd && <div className="project-detail-cwd">{activeGroupCwd}</div>}
          {showRuntimeFilter && (
            <nav className="runtime-filter" aria-label="Desktop 运行时筛选">
              <button type="button" className={runtimeFilter === "all" ? "active" : ""} onClick={() => setRuntimeFilter("all")}>全部</button>
              {snapshot!.runtimes!.map((runtime) => (
                <button
                  type="button"
                  key={runtime.id}
                  className={runtimeFilter === runtime.id ? "active" : ""}
                  disabled={runtime.state !== "ready" && runtime.sessionCount === 0}
                  onClick={() => setRuntimeFilter(runtime.id)}
                >
                  {desktopRuntimeName(runtime.id)}
                </button>
              ))}
            </nav>
          )}
          {activeGroupFamilies.length === 0 ? (
            <div className="session-catalog-loading">
              <strong>{projectSearch ? "没有匹配的会话" : "此分组暂无会话"}</strong>
              <span>{projectSearch ? "换一个关键词试试。" : "可点击右上角新建会话，或返回查看其它项目。"}</span>
            </div>
          ) : (
            <div className="session-rows project-detail-rows">
              {activeGroupFamilies.map((family) => renderMobileSessionFamily(family, isArchivedGroupPage))}
            </div>
          )}
        </section>
      ) : (
      <section className="host-detail" ref={directoryRef} onScroll={(event) => directoryScrollPositions.current.set("", event.currentTarget.scrollTop)}>
        <div className="catalog-toolbar">
          <label className="session-search">
            <Search size={16} />
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索项目或会话" />
          </label>
          {groupedProjectIds.length > 1 && (
            <IconButton
              label={allProjectsCollapsed ? "全部展开" : "全部折叠"}
              onClick={() => setCollapsedProjectIds(
                allProjectsCollapsed ? expandAllProjects() : collapseProjects(groupedProjectIds),
              )}
            >
              {allProjectsCollapsed ? <ChevronsDown size={17} /> : <ChevronsUp size={17} />}
            </IconButton>
          )}
          <button
            type="button"
            className="primary-button catalog-create-btn"
            disabled={!snapshot?.projects.length}
            onClick={() => openCreateDialogForProject()}
          >
            <Plus size={16} />新建
          </button>
        </div>
        {showRuntimeFilter && (
          <nav className="runtime-filter" aria-label="Desktop 运行时筛选">
            <button type="button" className={runtimeFilter === "all" ? "active" : ""} onClick={() => setRuntimeFilter("all")}>全部</button>
            {snapshot!.runtimes!.map((runtime) => (
              <button
                type="button"
                key={runtime.id}
                className={runtimeFilter === runtime.id ? "active" : ""}
                disabled={runtime.state !== "ready" && runtime.sessionCount === 0}
                onClick={() => setRuntimeFilter(runtime.id)}
              >
                {desktopRuntimeName(runtime.id)}
              </button>
            ))}
          </nav>
        )}
        {permissions[0] && (
          <button type="button" className="host-permission-alert" onClick={() => void selectSession(permissions[0]!.sessionId)}>
            <span className="permission-dock-icon"><AlertTriangle size={18} /></span>
            <span>
              <strong>Desktop 任务正在等待处理</strong>
              <small>{sessions.find((session) => session.sessionId === permissions[0]!.sessionId)?.title ?? permissions[0]!.toolName}</small>
            </span>
            <b>{permissions.length > 1 ? `${permissions.length} 项` : "查看"}</b>
          </button>
        )}
        {connectionIssue && (
          <button type="button" className="host-connection-issue" onClick={() => void onRetry()}>
            {connectionIssue.message}
          </button>
        )}
        {!snapshot && (
          <div className="session-catalog-loading">
            <LoaderCircle className="is-spinning" size={20} />
            <strong>正在同步主机状态</strong>
            <span>已保存的会话会在连接恢复后自动出现。</span>
          </div>
        )}
        {snapshot && grouped.length === 0 && (
          <div className="session-catalog-loading">
            <strong>{search ? "没有匹配的会话" : "暂未发现 Desktop 会话"}</strong>
            <span>{search ? "换一个关键词试试。" : "启动目标 Desktop 后，Bridge 会自动读取其独立会话。"}</span>
          </div>
        )}
        <div className="project-groups">
          {grouped.map((group) => {
            const projectId = group.project?.projectId ?? group.sessions[0]!.projectId;
            const projectName = group.project?.name ?? group.sessions[0]!.projectName;
            const expanded = !collapsedProjectIds.has(projectId);
            const sessionsId = `mobile-project-${encodeURIComponent(projectId)}`;
            const { preview, totalCount, hiddenCount } = previewProjectSessionFamilies(
              group.sessions,
              PROJECT_PREVIEW_SESSION_LIMIT,
            );
            return (
              <section className={`project-group ${expanded ? "expanded" : "collapsed"}`} key={projectId}>
                <div className="project-group-header">
                  <button
                    type="button"
                    className="project-group-open"
                    aria-expanded={expanded}
                    aria-controls={sessionsId}
                    onClick={() => toggleProject(projectId)}
                  >
                    <span className="project-group-toggle-copy">
                      <span>
                        <strong>{projectName}</strong>
                        <b className="project-count-pill">{totalCount}</b>
                      </span>
                    </span>
                    <span className="project-group-chevron">
                      {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                    </span>
                  </button>
                  {totalCount > PROJECT_PREVIEW_SESSION_LIMIT && (
                    <button
                      type="button"
                      className="project-group-collapse-btn project-group-all-btn"
                      aria-label={`查看 ${projectName} 全部 ${totalCount} 个会话`}
                      onClick={() => openProjectGroup(projectId)}
                    >
                      全部
                    </button>
                  )}
                </div>
                {expanded && (
                  <div className="session-rows" id={sessionsId}>
                    {preview.map((family) => renderMobileSessionFamily(family, false))}
                    {hiddenCount > 0 && (
                      <button
                        type="button"
                        className="project-group-more-button"
                        onClick={() => openProjectGroup(projectId)}
                      >
                        <span>查看全部 {totalCount} 个会话</span>
                        <ChevronRight size={15} />
                      </button>
                    )}
                  </div>
                )}
              </section>
            );
          })}
          {archivedSessions.length > 0 && (
            <section className="project-group archived-group">
              <button type="button" className="project-group-open" onClick={() => openProjectGroup("__archived__")}>
                <span className="project-group-toggle-copy"><span><Archive size={16} /><strong>已归档会话</strong><b className="project-count-pill">{archivedSessions.length}</b></span></span>
                <ChevronRight size={16} />
              </button>
            </section>
          )}
        </div>

      </section>
      )}

      {sessionOverlays}
      {directoryMenuOpen && (
        <div className="permission-sheet-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setDirectoryMenuOpen(false);
        }}>
          <section className="permission-sheet session-menu-sheet" role="dialog" aria-modal="true" aria-labelledby="directory-menu-title">
            <header>
              <div><span>{desktopName}</span><h2 id="directory-menu-title">会话目录</h2></div>
              <IconButton label="关闭" onClick={() => setDirectoryMenuOpen(false)}><X size={19} /></IconButton>
            </header>
            <div className="session-menu-actions">
              <p className="mobile-menu-group-title">同步</p>
              <button type="button" className="secondary-button" disabled={refreshing} onClick={() => void runRefresh()}>
                {refreshing ? <LoaderCircle className="is-spinning" size={17} /> : syncFlash ? <Check size={17} /> : <RefreshCw size={17} />}
                {refreshing ? "正在同步" : syncFlash ? "已同步" : "同步当前电脑"}
              </button>
              <button type="button" className="secondary-button" onClick={() => {
                setDirectoryMenuOpen(false);
                openProjectGroup("__archived__");
              }}><Archive size={17} />已归档会话 · {archivedSessions.length}</button>
            </div>
          </section>
        </div>
      )}
      {createOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setCreateOpen(false);
        }}>
          <section className="create-session-dialog" role="dialog" aria-modal="true" aria-labelledby="create-session-title">
            <header>
              <h2 id="create-session-title">新建会话</h2>
              <IconButton label="关闭" onClick={() => setCreateOpen(false)}><X size={19} /></IconButton>
            </header>
            <label>
              <span>Desktop 运行时</span>
              <select
                value={createRuntimeId}
                onChange={(event) => {
                  const runtimeId = event.target.value as BridgeDesktopRuntimeId;
                  setCreateRuntimeId(runtimeId);
                  setCreateProjectId(
                    snapshot?.projects.find((project) => project.runtimeId === runtimeId)?.projectId
                    ?? snapshot?.projects[0]?.projectId
                    ?? "",
                  );
                }}
              >
                {snapshot?.runtimes?.map((runtime) => (
                  <option
                    value={runtime.id}
                    key={runtime.id}
                    disabled={runtime.state !== "ready" || !runtime.capabilities.includes("session.create")}
                  >
                    {desktopRuntimeName(runtime.id)}{runtime.state === "ready" ? "" : "（不可用）"}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>项目</span>
              <select value={createProjectId} onChange={(event) => setCreateProjectId(event.target.value)}>
                {snapshot?.projects.map((project) => <option value={project.projectId} key={project.projectId}>{project.name}</option>)}
              </select>
            </label>
            <label>
              <span>会话名称</span>
              <input value={createTitle} onChange={(event) => setCreateTitle(event.target.value)} placeholder="可留空" />
            </label>
            <div className="dialog-actions">
              <button type="button" className="secondary-button" onClick={() => setCreateOpen(false)}>取消</button>
              <button type="button" className="primary-button" disabled={!createProjectId || createBusy} onClick={() => void createSession()}>
                {createBusy && <LoaderCircle className="is-spinning" size={16} />}创建会话
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
