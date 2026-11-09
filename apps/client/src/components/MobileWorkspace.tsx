import type {
  BridgeAttachment,
  BridgeArtifactManifest,
  BridgeArtifactPreview,
  BridgeDeliveryState,
  BridgeDesktopRuntimeId,
  BridgeDirectoryListing,
  BridgeEvidenceBundle,
  BridgeEvidenceDetailPage,
  BridgeEvent,
  BridgeFileChangeSummary,
  BridgeHistoryItem,
  BridgeHostSnapshot,
  BridgeInteractivePrompt,
  BridgeNativePermissionMode,
  BridgePermissionInfo,
  BridgePermissionMode,
  BridgeRuntimeGoalStatus,
  BridgeRuntimeHandoff,
  BridgeRuntimeHandoffPreview,
  BridgeSessionCommandResult,
  BridgeSessionPermissions,
  BridgeSDKPermissionMode,
  BridgePermissionRules,
  BridgeSessionConfiguration,
  BridgeSessionInfo,
  BridgeSlashCommandCatalog,
  BridgeSubagentSummary,
  BridgeTaskPlan,
  BridgeTransportMetrics,
  BridgeDesktopAppStatus,
  SocketState,
} from "@bridge/protocol";
import { isClaudeTranscriptControlMessage } from "@bridge/protocol";
import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowRightLeft,
  ArrowUp,
  ArrowUpDown,
  ArrowUpToLine,
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
  LoaderCircle,
  MessageSquare,
  MoreHorizontal,
  PackageCheck,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Square,
  Terminal,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { Fragment, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
  moveProject,
  orderProjects,
  previewProjectSessionFamilies,
  sortProjectSessionsByRecent,
  toggleCollapsedProject,
  type SessionFamily,
} from "../lib/project-groups.js";
import { registerMobileBackHandler } from "../lib/mobile-back-navigation.js";
import { desktopRuntimeId, desktopRuntimeName, isNativeRuntimeId, runtimeProviderLabel } from "../lib/runtime-labels.js";
import { useStreamEntrance } from "../lib/stream-entrance.js";
import { backgroundSubagentBadge, formatElapsed, sessionActivity, sessionQueueLabel, subagentStalledSeconds } from "../lib/session-activity.js";
import { ConfirmationDialog } from "./ConfirmationDialog.js";
import { DesktopHandoffNotice } from "./DesktopHandoffNotice.js";
import { EvidenceInlineSummary, EvidencePanel } from "./EvidencePanel.js";
import { FileChangesCard } from "./FileChangesCard.js";
import { ComposerAttachmentMenu, FileAttachmentPicker, useFileAttachments } from "./FileAttachmentPicker.js";
import { appendUploadedFilePaths, type UploadFileHandler } from "../lib/file-upload.js";
import { MediaGallery } from "./MediaGallery.js";
import { useMediaPreview } from "./MediaPreviewProvider.js";
import { mediaArtifacts, mediaKind } from "../lib/media-preview.js";
import { IconButton } from "./IconButton.js";
import { MarkdownText } from "./MarkdownText.js";
import { MessageCopyButton } from "./MessageCopyButton.js";
import { MobilePageHeader } from "./MobilePageHeader.js";
import { MobileSheet, SheetAction } from "./MobileSheet.js";
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
import { SessionCreateDialog } from "./SessionCreateDialog.js";
import { SessionActivityIndicator } from "./SessionActivityIndicator.js";
import { TaskPlanCard } from "./TaskPlanCard.js";
import { SlashCommandInput } from "./SlashCommandInput.js";
import { useSessionCommands } from "../hooks/useSessionCommands.js";
import { SessionCommandDialogs } from "./SessionCommandDialogs.js";

interface ConversationItem extends BridgeHistoryItem {
  delivery?: BridgeDeliveryState;
  replyDelivery?: BridgeDeliveryState;
  replyPending?: boolean;
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

function formatSessionModelLabel(session: BridgeSessionInfo): string {
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
  if (session.runtimeId && session.runtimeId !== "claude-desktop") return `${desktopRuntimeName(session.runtimeId)} 待机`;
  if (session.ownership === "DESKTOP_OBSERVED") return "桌面待机";
  return "待机";
}

function activeSessionBadgeLabel(session: BridgeSessionInfo): string | undefined {
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

function conciseModelName(session: BridgeSessionInfo): string {
  return formatSessionModelLabel(session);
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
  | { kind: "tool-group"; id: string; tools: ConversationItem[] }
  | { kind: "subagent-group"; id: string; agents: ConversationItem[] };

function groupTimelineTools(timeline: ConversationTimelineEntry[]): DisplayTimelineNode[] {
  const result: DisplayTimelineNode[] = [];
  for (const entry of timeline) {
    if (entry.kind === "message" && entry.item.subagent) {
      const previous = result.at(-1);
      if (previous?.kind === "subagent-group") previous.agents.push(entry.item);
      else result.push({ kind: "subagent-group", id: `subagent-group:${entry.item.id}`, agents: [entry.item] });
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

const SUBAGENT_STATE_LABELS: Record<BridgeSubagentSummary["state"], string> = {
  running: "运行中",
  completed: "已完成",
  failed: "失败",
  stopped: "已停止",
  unknown: "状态未知",
};

export function SubagentCard({
  item,
  entering = false,
  stopping = false,
  stopBlockedReason,
  onStop,
  onFileClick,
}: {
  item: ConversationItem;
  entering?: boolean;
  stopping?: boolean;
  /** Shown instead of the stop button when only ending the whole process could stop it. */
  stopBlockedReason?: string;
  onStop?: () => void;
  onFileClick?: (filePath: string) => void;
}) {
  const subagent = item.subagent;
  if (!subagent) return null;
  const isRunning = subagent.state === "running";
  const isUnknown = subagent.state === "unknown";
  const stalledSeconds = isRunning ? subagentStalledSeconds(subagent.updatedAt) : undefined;
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
      className={`conversation-subagent-card ${isRunning ? "is-running" : isUnknown ? "is-unknown" : `is-completed is-${subagent.state}`}${entering ? " is-entering" : ""}`}
      data-stream-key={item.id}
    >
      <div className="subagent-card-header">
        <div className="subagent-card-title-row">
          <span className={`subagent-status-badge ${isRunning ? "running" : isUnknown ? "unknown" : "completed"}`}>
            {isRunning
              ? <LoaderCircle className="is-spinning" size={13} />
              : isUnknown ? <MoreHorizontal size={13} /> : subagent.state === "completed" ? <Check size={13} /> : <X size={13} />}
            <span>{agentBadge}</span>
          </span>
          <strong className="subagent-description">{subagent.description}</strong>
        </div>
        <div className="subagent-card-meta">
          {subagent.toolCount > 0 && <span>{subagent.toolCount} 步</span>}
          {durationLabel && <span>{durationLabel}</span>}
          <span className={`subagent-state-label ${isRunning ? "running" : isUnknown ? "unknown" : "completed"}`}>
            {SUBAGENT_STATE_LABELS[subagent.state]}
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

      {isRunning && (stalledSeconds !== undefined || onStop || stopBlockedReason) && (
        <div className="subagent-card-controls">
          <span className="subagent-control-note">
            {stopBlockedReason
              ?? (stalledSeconds !== undefined ? `已有 ${formatElapsed(stalledSeconds)}没有新进展，可能已卡住` : "")}
          </span>
          {onStop && !stopBlockedReason && (
            <button type="button" className="secondary-button subagent-stop-button" disabled={stopping} onClick={onStop}>
              {stopping ? <LoaderCircle className="is-spinning" size={14} /> : <CircleStop size={14} />}
              {stopping ? "停止中" : "停止"}
            </button>
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

export function matchingQuestionPermission(
  prompt: BridgeInteractivePrompt,
  permissions: BridgePermissionInfo[],
  toolUseId?: string,
): BridgePermissionInfo | undefined {
  const questions = prompt.questions;
  if (prompt.kind !== "question" || !questions?.length) return undefined;
  return permissions.find((permission) => permission.toolName === "AskUserQuestion"
    && (toolUseId === undefined || permission.toolUseId === toolUseId)
    && Array.isArray(permission.input.questions)
    && permission.input.questions.length === questions.length
    && permission.input.questions.every((question, index) => question.question === questions[index]!.question));
}

export function InteractivePromptCard({
  prompt,
  replyDelivery,
  replyPending = false,
  canSend = true,
  busy = false,
  unavailableReason,
  error,
  onSelectOption,
}: {
  prompt: BridgeInteractivePrompt;
  replyDelivery?: BridgeDeliveryState;
  replyPending?: boolean;
  canSend?: boolean;
  busy?: boolean;
  unavailableReason?: string;
  error?: string;
  onSelectOption?: (message: string) => void;
}) {
  const isWrapUp = prompt.kind === "wrap-up";
  const actions = prompt.actions ?? [];
  const questions = prompt.questions ?? [];
  const answered = Boolean(prompt.answered);
  const selectedAction = actions.find((action) => action.selected);
  const interactive = !answered && !unavailableReason && canSend && !busy && Boolean(onSelectOption);

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
            ? replyPending
              ? "已提交，等待处理"
              : replyDelivery && !["session-received", "running", "completed"].includes(replyDelivery)
                ? replyDelivery === "host-received" || replyDelivery === "submitted" ? "回复已排队" : `回复${deliveryLabel(replyDelivery)}`
                : selectedAction ? `已选：${selectedAction.label}` : "已回复"
            : unavailableReason ?? (prompt.blocked
              ? "等待确认后继续"
              : "点击选项直接发送")}
        </span>
      </div>

      {error && <div className="permission-error" role="alert">{error}</div>}
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
  if (state === "relay-received") return "已送达中继，等待电脑接收";
  if (state === "host-received") return "主机已接收";
  if (state === "submitted") return "已提交，等待执行";
  if (state === "waiting-confirmation") return "等待电脑允许接收";
  if (state === "session-received") return "会话已接收";
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
  const sessionEvents = events.filter((event) => event.sessionId === sessionId);
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
        : item.id;
    if (item.role === "tool" && hiddenTaskItems.has(normalizedId.replace(/^tool:/u, ""))) continue;
    const previous = items.get(normalizedId);
    const taskPlan = previous?.taskPlan && (!item.taskPlan || previous.taskPlan.updatedAt >= item.taskPlan.updatedAt)
      ? previous.taskPlan
      : item.taskPlan;
    if (previous?.subagent && item.subagent && previous.subagent.updatedAt > item.subagent.updatedAt) continue;
    items.set(normalizedId, {
      ...item,
      id: normalizedId,
      ...(taskPlan ? { taskPlan } : {}),
    });
  }
  const acceptedRequests = new Set(
    sessionEvents
      .filter((event) => event.type === "user.message.accepted" && typeof event.data.requestId === "string")
      .map((event) => event.data.requestId as string),
  );
  const messageIdsByRequest = new Map(sessionEvents.flatMap((event) => {
    if (event.type !== "message.delivery" || event.data.delivery !== "submitted" || typeof event.data.requestId !== "string") return [];
    const messageId = typeof event.data.messageId === "string" ? event.data.messageId : event.itemId;
    return messageId ? [[event.data.requestId, messageId] as const] : [];
  }));
  for (const turn of localTurns.filter((candidate) => candidate.sessionId === sessionId)) {
    if (acceptedRequests.has(turn.requestId)) continue;
    // Submission links the transcript UUID before SDK acceptance arrives.
    const id = turn.messageId ?? messageIdsByRequest.get(turn.requestId) ?? `local:${turn.requestId}`;
    items.set(id, {
      id,
      sessionId,
      role: "user",
      text: turn.text,
      createdAt: turn.createdAt,
      origin: "mobile",
      attachments: turn.attachments,
      ...items.get(id),
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
          (event.type === "session.observed" && event.data.role === "assistant" && !event.data.taskPlan)
        )
      ))
      .map((event) => event.turnId!),
  );
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
        const itemId = event.itemId ?? event.eventId;
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
      const itemId = event.itemId ?? event.eventId;
      items.set(itemId, {
        ...items.get(itemId),
        id: itemId,
        sessionId,
        ...(event.turnId ? { turnId: event.turnId } : {}),
        role: "user",
        text,
        createdAt: event.timestamp,
        origin: event.origin,
        delivery: "session-received",
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
      const incomingSubagent = event.data.subagent && typeof event.data.subagent === "object"
        ? event.data.subagent as BridgeSubagentSummary
        : undefined;
      const id = incomingSubagent
        ? incomingSubagent.toolUseId ?? subagentInvocations.get(incomingSubagent.agentId)?.get(incomingSubagent.startedAt) ?? subagentItemIds.get(incomingSubagent.agentId)!
        : event.itemId ?? event.eventId;
      if (hiddenTaskItems.has(id)) continue;
      const existing = toolByItem.get(id) ?? items.get(`tool:${id}`);
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
      toolByItem.set(id, {
        id: `tool:${id}`,
        sessionId,
        ...(event.turnId ? { turnId: event.turnId } : existing?.turnId ? { turnId: existing.turnId } : {}),
        role: "tool",
        toolName,
        text,
        createdAt: existing?.createdAt ?? event.timestamp,
        origin: "claude-host",
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
  for (const item of items.values()) {
    if (item.role !== "user") continue;
    const local = item.requestId ? localByRequest.get(item.requestId) : undefined;
    const commandId = item.commandId ?? local?.commandId;
    const terminal = (commandId ? terminalByCommand.get(commandId) : undefined)
      ?? (item.turnId ? terminalByTurn.get(item.turnId) : undefined);
    if (!local && !terminal) continue;
    const delivery = terminal ? terminal.type === "turn.completed" ? "completed"
      : terminal.type === "turn.failed" ? "failed" : "cancelled" : local!.delivery;
    items.set(item.id, {
      ...item, delivery,
      ...(commandId ? { commandId } : {}),
      ...(typeof terminal?.data.error === "string" ? { error: terminal.data.error } : local?.error ? { error: local.error } : {}),
    });
  }
  const sorted = [...items.values()].flatMap((item) => {
    if (item.role !== "user") return [item];
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
      : event.type === "user.message.accepted" ? "session-received"
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
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const complete = questions.every((question) => (
    typeof question.question === "string" && Boolean(answers[question.question]?.length)
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
                    type={question.multiSelect === true ? "checkbox" : "radio"}
                    name={`${permission.requestId}:${index}`}
                    checked={question.multiSelect === true ? answers[prompt]?.includes(label) ?? false : answers[prompt] === label}
                    onChange={() => setAnswers((current) => {
                      if (question.multiSelect !== true) return { ...current, [prompt]: label };
                      const selected = Array.isArray(current[prompt]) ? current[prompt] : [];
                      return { ...current, [prompt]: selected.includes(label) ? selected.filter((value) => value !== label) : [...selected, label] };
                    })}
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
            { ...permission.input, answers: Object.fromEntries(Object.entries(answers).map(([question, answer]) => [question, Array.isArray(answer) ? answer.join(", ") : answer])) },
          )}
        >
          {busy && <LoaderCircle className="is-spinning" size={15} />}提交回答
        </button>
      </div>
    </section>
  );
}

const NATIVE_MODE_LABELS: Record<BridgeNativePermissionMode, string> = {
  default: "逐个确认",
  acceptEdits: "自动接受编辑",
  bypassPermissions: "完全授权",
};

function ToolPermissionPrompt({
  permission,
  onResolve,
  onEnableFullAccess,
  onEnableNativeFullAccess,
}: {
  permission: BridgePermissionInfo;
  onResolve(
    requestId: string,
    decision: "allow-once" | "allow-always" | "deny",
    message?: string,
    updatedInput?: Record<string, unknown>,
    mode?: BridgeNativePermissionMode,
  ): Promise<void>;
  onEnableFullAccess?(sessionId: string): Promise<void>;
  onEnableNativeFullAccess?(requestId: string): Promise<void>;
}) {
  const presentation = permissionPresentation(permission);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [confirmFullAccess, setConfirmFullAccess] = useState<"host" | "native">();
  // Defined while the deny-with-feedback composer is open.
  const [feedback, setFeedback] = useState<string>();
  const composing = feedback !== undefined;
  const plan = permission.toolName === "ExitPlanMode" ? inputText(permission.input, "plan") ?? "" : undefined;

  useEffect(() => {
    if (!confirmFullAccess && !composing) return;
    return registerMobileBackHandler(() => {
      if (busy) return true;
      if (confirmFullAccess) setConfirmFullAccess(undefined);
      else setFeedback(undefined);
      return true;
    }, 150);
  }, [confirmFullAccess, composing, busy]);

  async function decide(
    decision: "allow-once" | "allow-always" | "deny",
    mode?: BridgeNativePermissionMode,
    message?: string,
  ): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await onResolve(permission.requestId, decision, message, undefined, mode);
    } catch (resolveError) {
      setError(resolveError instanceof Error ? resolveError.message : "授权处理失败");
    } finally {
      setBusy(false);
    }
  }

  async function enableFullAccess(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      if (confirmFullAccess === "native") await onEnableNativeFullAccess?.(permission.requestId);
      else await onEnableFullAccess?.(permission.sessionId);
    } catch (resolveError) {
      setError(resolveError instanceof Error ? resolveError.message : "完全授权设置失败");
    } finally {
      setBusy(false);
      setConfirmFullAccess(undefined);
    }
  }

  const spinner = busy && <LoaderCircle className="is-spinning" size={15} />;
  return (
    <>
    <section className="permission-prompt">
      <div className="permission-title">
        <strong>{permission.title || (plan !== undefined ? "计划待确认" : `${permission.toolName} 请求权限`)}</strong>
        {plan === undefined && <span>{presentation.summary}</span>}
      </div>
      {plan !== undefined ? (
        <div className="permission-plan">
          <MarkdownText text={plan} collapsible={false} />
        </div>
      ) : (
        <>
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
        </>
      )}
      {error && <div className="permission-error" role="alert">{error}</div>}
      {composing ? (
        <div className="permission-feedback">
          <textarea
            aria-label={plan !== undefined ? "计划修改意见" : "拒绝原因"}
            placeholder={plan !== undefined ? "需要调整的地方（可选）" : "告诉 Claude 应该怎么做（可选）"}
            rows={3}
            value={feedback}
            disabled={busy}
            onChange={(event) => setFeedback(event.target.value)}
          />
          <div className="permission-actions">
            <button type="button" className="secondary-button" disabled={busy} onClick={() => setFeedback(undefined)}>返回</button>
            <button type="button" className="primary-button" disabled={busy} onClick={() => void decide("deny", undefined, feedback.trim() || undefined)}>
              {spinner}{plan !== undefined ? "继续规划" : "拒绝"}
            </button>
          </div>
        </div>
      ) : plan !== undefined ? (
        <div className="permission-actions">
          {permission.canSetNativeFullAccess ? (
            <>
              <button type="button" className="primary-button" disabled={busy} onClick={() => void decide("allow-once", "acceptEdits")}>
                {spinner}是，自动接受编辑
              </button>
              <button type="button" className="secondary-button" disabled={busy} onClick={() => void decide("allow-once", "default")}>是，逐个确认</button>
            </>
          ) : (
            <button type="button" className="primary-button" disabled={busy} onClick={() => void decide("allow-once")}>
              {spinner}批准计划
            </button>
          )}
          {permission.canSetNativeFullAccess && onEnableNativeFullAccess && (
            <button type="button" className="secondary-button" disabled={busy} onClick={() => setConfirmFullAccess("native")}>
              <ShieldCheck size={15} />是，完全授权
            </button>
          )}
          <button type="button" className="secondary-button" disabled={busy} onClick={() => setFeedback("")}>否，继续规划</button>
        </div>
      ) : (
        <div className="permission-actions">
          <button type="button" className="secondary-button danger-text" disabled={busy} onClick={() => setFeedback("")}>拒绝</button>
          <button type="button" className="primary-button" disabled={busy} onClick={() => void decide("allow-once")}>
            {spinner}允许一次
          </button>
          {permission.canAllowAlways && (
            <button type="button" className="secondary-button" disabled={busy} onClick={() => void decide("allow-always")}>始终允许</button>
          )}
          {permission.canSetNativeFullAccess && onEnableNativeFullAccess && (
            <button type="button" className="secondary-button" disabled={busy} onClick={() => setConfirmFullAccess("native")}>
              <ShieldCheck size={15} />此 Desktop 会话完全授权
            </button>
          )}
          {onEnableFullAccess && (
            <button type="button" className="secondary-button" disabled={busy} onClick={() => setConfirmFullAccess("host")}>
              <ShieldCheck size={15} />Bridge 默认完全授权
            </button>
          )}
        </div>
      )}
    </section>
    <ConfirmationDialog
      open={Boolean(confirmFullAccess)}
      title={confirmFullAccess === "native" ? "此 Desktop 会话完全授权" : "更改 Bridge 默认授权模式"}
      description={confirmFullAccess === "native"
        ? "这会允许当前工具，并请求将当前 Desktop 会话切换为完全授权，需等待 Desktop 确认；提问和强制确认仍需响应。收件箱接收许可仍需在电脑端确认。"
        : `这会将当前电脑上 ${desktopRuntimeName(permission.sessionId.includes(":") ? permission.sessionId.split(":")[0] as BridgeDesktopRuntimeId : "claude-desktop")} 的 Bridge 默认授权设为完全授权，自动批准使用此默认值的工具请求，并处理积压授权；提问和强制确认仍需响应。`}
      confirmLabel={confirmFullAccess === "native" ? "确认完全授权" : "启用 Bridge 默认完全授权"}
      busy={busy}
      onCancel={() => setConfirmFullAccess(undefined)}
      onConfirm={() => void enableFullAccess()}
    />
    </>
  );
}

export function PermissionPrompt({
  permission,
  onResolve,
  onEnableFullAccess,
  onEnableNativeFullAccess,
}: {
  permission: BridgePermissionInfo;
  onResolve(
    requestId: string,
    decision: "allow-once" | "allow-always" | "deny",
    message?: string,
    updatedInput?: Record<string, unknown>,
    mode?: BridgeNativePermissionMode,
  ): Promise<void>;
  onEnableFullAccess?(sessionId: string): Promise<void>;
  onEnableNativeFullAccess?(requestId: string): Promise<void>;
}) {
  return permission.toolName === "AskUserQuestion"
    ? <QuestionPrompt permission={permission} onResolve={onResolve} />
    : (
      <ToolPermissionPrompt
        permission={permission}
        onResolve={onResolve}
        {...(onEnableFullAccess ? { onEnableFullAccess } : {})}
        {...(onEnableNativeFullAccess ? { onEnableNativeFullAccess } : {})}
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
  onLoadEvidenceDetails,
  onPreviewArtifact,
  onDownloadArtifact,
  onDownloadSessionFile,
  onUploadFile,
  onSendTurn,
  onInterruptTurn,
  onSteerQueuedTurn,
  onStopSubagent,
  onResolveUncertain,
  onResolvePermission,
  onCreateSession,
  onBrowseDirectory,
  onForkSession,
  onReturnToDesktop,
  onTakeoverDesktop,
  onLoadSessionConfiguration,
  onLoadSessionCommands,
  onRunSessionCommand,
  onLoadSessionPermissions,
  onSaveSessionPermissions,
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
  onRenameSession,
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
  onLoadEvidenceDetails?(evidenceId: string, kind: "tools" | "artifacts", cursor?: string): Promise<BridgeEvidenceDetailPage>;
  onPreviewArtifact(artifactId: string): Promise<BridgeArtifactPreview>;
  onDownloadArtifact(artifact: BridgeArtifactManifest): Promise<void>;
  onDownloadSessionFile?(sessionId: string, filePath: string): Promise<void>;
  onUploadFile?: UploadFileHandler;
  onSendTurn(sessionId: string, text: string, attachments: BridgeAttachment[], steer: boolean, bridgeExecutionRequested?: boolean): Promise<{ requestId: string } | void>;
  onInterruptTurn(sessionId: string, commandId?: string): Promise<void>;
  onSteerQueuedTurn?(sessionId: string, commandId: string): Promise<void>;
  onStopSubagent?(sessionId: string, agentId: string): Promise<void>;
  onResolveUncertain(commandId: string, action: "confirm" | "retry"): Promise<void>;
  onResolvePermission(
    requestId: string,
    decision: "allow-once" | "allow-always" | "deny",
    message?: string,
    updatedInput?: Record<string, unknown>,
    mode?: BridgeNativePermissionMode,
  ): Promise<void>;
  onBrowseDirectory?(path?: string): Promise<BridgeDirectoryListing>;
  onCreateSession(
    cwd: string,
    title?: string,
    runtimeId?: BridgeDesktopRuntimeId,
    projectId?: string,
  ): Promise<BridgeSessionInfo | undefined>;
  onForkSession?(
    sessionId: string,
    title?: string,
  ): Promise<BridgeSessionInfo | undefined>;
  onReturnToDesktop?(sessionId: string): Promise<void>;
  onTakeoverDesktop?(sessionId: string, commandId?: string): Promise<void>;
  onLoadSessionConfiguration(sessionId: string): Promise<BridgeSessionConfiguration>;
  onLoadSessionCommands?(sessionId: string): Promise<BridgeSlashCommandCatalog>;
  onRunSessionCommand?(sessionId: string, text: string): Promise<BridgeSessionCommandResult>;
  onLoadSessionPermissions?(sessionId: string): Promise<BridgeSessionPermissions>;
  onSaveSessionPermissions?(sessionId: string, mode: BridgeSDKPermissionMode, rules: BridgePermissionRules): Promise<BridgeSessionPermissions>;
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
  onRenameSession?(sessionId: string, title: string): Promise<void>;
  onDeleteSession?(sessionId: string): Promise<void>;
  onDesktopAppAction(
    runtimeId: BridgeDesktopRuntimeId,
    action: "launch" | "quit",
  ): Promise<BridgeDesktopAppStatus[]>;
  onRefresh(sessionId?: string): Promise<boolean>;
  onBackToHosts(): void;
  onRetry(): Promise<void>;
}) {
  const [queuedSteers, setQueuedSteers] = useState<Record<string, { state: "pending" | "requested" | "error"; error?: string }>>({});
  const [promptErrors, setPromptErrors] = useState<Record<string, string>>({});
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
  const [promptReplies, setPromptReplies] = useState<Record<string, Record<string, string | null>>>({});
  const draftKey = JSON.stringify([activeHostId, selectedSessionId]);
  const draft = drafts[draftKey] ?? { text: "", attachments: [], sending: false, steer: false };
  const { text, attachments, sending, steer, imageError } = draft;
  function updateDraft(change: (current: typeof draft) => typeof draft): void {
    setDrafts((current) => ({ ...current, [draftKey]: change(current[draftKey] ?? draft) }));
  }
  const [createOpen, setCreateOpen] = useState(false);
  const [createProjectId, setCreateProjectId] = useState("");
  const [createRuntimeId, setCreateRuntimeId] = useState<BridgeDesktopRuntimeId>("claude-desktop");
  const [configurationSessionId, setConfigurationSessionId] = useState<string>();
  const [actionSessionId, setActionSessionId] = useState<string>();
  const [providerOpen, setProviderOpen] = useState(false);
  const [relayOpen, setRelayOpen] = useState(false);
  const [stoppingSessionId, setStoppingSessionId] = useState<string>();
  const [stopError, setStopError] = useState<string>();
  const [stopSubagentTarget, setStopSubagentTarget] = useState<{
    sessionId: string;
    agentId: string;
    description: string;
    scope: "task" | "process";
  }>();
  const [subagentStopBusy, setSubagentStopBusy] = useState(false);
  const [permissionOpen, setPermissionOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [syncFlash, setSyncFlash] = useState(false);
  const [menuSessionId, setMenuSessionId] = useState<string>();
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameTitle, setRenameTitle] = useState("");
  const [deleteSessionConfirmOpen, setDeleteSessionConfirmOpen] = useState(false);
  const [sessionActionBusy, setSessionActionBusy] = useState(false);
  const [sessionActionError, setSessionActionError] = useState<string>();
  const [directoryMenuOpen, setDirectoryMenuOpen] = useState(false);
  const [projectOrderOpen, setProjectOrderOpen] = useState(false);
  // Keep the user's project order on this phone per computer.
  const projectOrderKey = `bridge-project-order:${activeHostId}`;
  const [placedProjects, setPlacedProjects] = useState<string[]>(() => (
    JSON.parse(localStorage.getItem(projectOrderKey) ?? "[]") as string[]
  ));
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<Set<string>>(() => new Set());
  const [expandedForkParents, setExpandedForkParents] = useState<Set<string>>(() => new Set());
  const [forkChainOpen, setForkChainOpen] = useState(() => (
    Boolean(selectedSessionId && snapshot?.sessions.find((session) => session.sessionId === selectedSessionId)?.sidechat)
  ));
  const [stopConfirmOpen, setStopConfirmOpen] = useState(false);
  const [remoteExecutionConfirm, setRemoteExecutionConfirm] = useState<{ key: string; reply?: { id: string; text: string } }>();
  const activeDraftKey = useRef(draftKey);
  activeDraftKey.current = draftKey;
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
  const commands = useSessionCommands({
    sessionId: selectedSession?.sessionId,
    sessionKey: draftKey,
    enabled: Boolean(selectedSession && desktopRuntimeId(selectedSession) === "claude-desktop"),
    supported: Boolean(snapshot?.host.capabilities.includes("session.command.v1")),
    onLoad: onLoadSessionCommands && snapshot?.host.capabilities.includes("session.commands.v1")
      ? () => onLoadSessionCommands(selectedSession!.sessionId) : undefined,
    onRun: onRunSessionCommand ? value => onRunSessionCommand(selectedSession!.sessionId, value) : undefined,
    onModel: () => setConfigurationSessionId(selectedSession!.sessionId),
    onRename: () => {
      setMenuSessionId(selectedSession!.sessionId);
      setRenameTitle(selectedSession!.title);
      setSessionActionError(undefined);
      setRenameOpen(true);
    },
    onSession: selectSession,
  });
  const commandDraft = commands.recognizes(text.trim());
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
      ? conversationItems(selectedSessionId, selectedHistory, events, localTurns, true, promptReplies[draftKey])
      : [],
    [draftKey, events, localTurns, promptReplies, selectedHistory, selectedSessionId],
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
  const projectsByActivity = useMemo(() => {
    const latest = new Map<string, number>();
    for (const session of sessions) {
      if (!session.archivedAt) latest.set(session.projectId, Math.max(latest.get(session.projectId) ?? 0, session.lastActivityAt));
    }
    return [...latest.keys()].sort((left, right) => latest.get(right)! - latest.get(left)!);
  }, [sessions]);
  // Projects keep a fixed order: the user's, with projects not seen before leading.
  const projectOrder = useMemo(() => orderProjects(projectsByActivity, placedProjects), [placedProjects, projectsByActivity]);
  // Pin projects the moment they are first seen, so activity never moves them afterwards.
  useEffect(() => {
    const unplaced = projectOrder.filter((projectId) => !placedProjects.includes(projectId));
    if (unplaced.length) placeProjects([...unplaced, ...placedProjects]);
  }, [placedProjects, projectOrder]);
  const activeParentProjects = useMemo(
    () => new Map(sessions.filter((session) => !session.archivedAt).map((session) => [session.sessionId, session.projectId])),
    [sessions],
  );
  const grouped = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    const filtered = sessions.filter((session) => (
      (!session.archivedAt || Boolean(session.sidechat && session.parentSessionId && activeParentProjects.get(session.parentSessionId) === session.projectId))
      && (runtimeFilter === "all" || desktopRuntimeId(session) === runtimeFilter)
      && (!query || `${session.title}\n${session.projectName}\n${session.cwd}`.toLocaleLowerCase().includes(query))
    ));
    const groups = new Map<string, BridgeSessionInfo[]>();
    for (const session of filtered) {
      const list = groups.get(session.projectId) ?? [];
      list.push(session);
      groups.set(session.projectId, list);
    }
    return projectOrder.filter((projectId) => groups.has(projectId)).map((projectId) => ({
      project: snapshot?.projects.find((project) => project.projectId === projectId),
      sessions: sortProjectSessionsByRecent(groups.get(projectId)!),
    }));
  }, [activeParentProjects, projectOrder, runtimeFilter, search, sessions, snapshot?.projects]);
  const archivedSessions = useMemo(() => sortProjectSessionsByRecent(sessions.filter((session) => (
    Boolean(session.archivedAt) && (runtimeFilter === "all" || desktopRuntimeId(session) === runtimeFilter)
  ))), [runtimeFilter, sessions]);
  const menuSession = menuSessionId ? sessions.find((session) => session.sessionId === menuSessionId) : undefined;
  const menuSupportsRename = Boolean(onRenameSession && snapshot?.host.capabilities.includes("session.rename.v1"));
  const renameCanSave = Boolean(renameTitle.trim() && renameTitle.trim() !== menuSession?.title && !sessionActionBusy);
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
      if (renameOpen) {
        closeRename();
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
      if (stopSubagentTarget) {
        if (!subagentStopBusy) setStopSubagentTarget(undefined);
        return true;
      }
      if (menuSessionId) {
        setMenuSessionId(undefined);
        return true;
      }
      if (projectOrderOpen) {
        setProjectOrderOpen(false);
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
    renameOpen,
    sessionActionBusy,
    directoryMenuOpen,
    projectOrderOpen,
    fileDownloadBusy,
    menuSessionId,
    pendingFileDownload,
    stopSubagentTarget,
    subagentStopBusy,
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
    setRenameOpen(false);
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

  const handledCommandResets = useRef(new Set<string>());
  useEffect(() => {
    for (const event of events) {
      if (event.type !== "session.reset" || handledCommandResets.current.has(event.eventId)) continue;
      handledCommandResets.current.add(event.eventId);
      if (event.data.previousSessionId === selectedSessionId && typeof event.data.sessionId === "string") {
        void selectSession(event.data.sessionId);
      }
    }
  }, [events]);

  async function selectSession(sessionId: string): Promise<void> {
    setConfigurationSessionId(undefined);
    setForkChainOpen(Boolean(sessions.find((session) => session.sessionId === sessionId)?.sidechat));
    setSessionView("conversation");
    setStopError(undefined);
    setSelectedSessionId(sessionId);
    await onOpenSession(sessionId);
  }

  function placeProjects(order: string[]): void {
    localStorage.setItem(projectOrderKey, JSON.stringify(order));
    setPlacedProjects(order);
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
      targetProject?.projectId ?? "",
    );
    setCreateOpen(true);
  }

  function remoteExecutionChoice(session: BridgeSessionInfo, confirmed: boolean, reply?: { id: string; text: string }): boolean | undefined {
    const handoff = session.desktopHandoff;
    if ((handoff?.state === "desktop-inbox" && handoff.inputStatus !== "queued") || localTurns.some(turn =>
      turn.sessionId === session.sessionId && turn.delivery === "uncertain")) {
      updateDraft(current => ({ ...current, imageError: "已有消息正在等待 Desktop 接收结果，请先同步状态；新草稿已保留。" }));
      return;
    }
    const supported = snapshot?.host.capabilities.includes("session.remote-execution.v1");
    const requested = handoff?.reason === "bridge-execution-requested" || localTurns.some(turn =>
      turn.sessionId === session.sessionId && turn.bridgeExecutionRequested &&
      (turn.delivery === "local-saved" || turn.delivery === "relay-received"));
    if (!supported && (session.allowedActions?.canRequestBridgeExecution ||
      (session.ownership === "DESKTOP_OBSERVED" && session.transport === "bridge-host" && (!session.runtimeId || session.runtimeId === "claude-desktop")))) {
      updateDraft(current => ({ ...current, imageError: "请更新电脑端 Bridge 后使用手机远程执行。" }));
      return;
    }
    if (!requested && !session.allowedActions?.canRequestBridgeExecution) return false;
    if (!requested && session.pendingCount > 0) {
      updateDraft(current => ({ ...current, imageError: "请先确认由 Bridge 继续执行现有排队消息；新草稿已保留。" }));
      return;
    }
    if (!requested && !confirmed) {
      setRemoteExecutionConfirm({ key: draftKey, ...(reply ? { reply } : {}) });
      return;
    }
    return true;
  }

  async function sendMessage(bridgeExecutionConfirmed = false): Promise<void> {
    if (
      !selectedSession ||
      selectedSession.allowedActions?.canSend === false ||
      sending || fileUploads.uploading ||
      (!text.trim() && (!runtimeSupports(snapshot, selectedSession, "attachment.image") || attachments.length === 0) && fileUploads.files.length === 0)
    ) return;
    const nextText = text.trim();
    const nextAttachments = runtimeSupports(snapshot, selectedSession, "attachment.image") ? attachments : [];
    const nextFiles = fileUploads.files;
    const remoteExecution = commands.recognizes(nextText) ? false : remoteExecutionChoice(selectedSession, bridgeExecutionConfirmed === true);
    if (remoteExecution === undefined) return;
    updateDraft((current) => ({ ...current, text: "", attachments: [], sending: true, imageError: undefined }));
    try {
      if (await commands.execute(nextText, attachments.length > 0 || nextFiles.length > 0)) {
        updateDraft(current => ({ ...current, steer: false }));
        return;
      }
      if (remoteExecution) {
        await onSendTurn(selectedSession.sessionId, appendUploadedFilePaths(nextText, nextFiles), nextAttachments, false, true);
      } else {
        await onSendTurn(selectedSession.sessionId, appendUploadedFilePaths(nextText, nextFiles), nextAttachments, steer);
      }
      fileUploads.clear(nextFiles);
      updateDraft((current) => ({ ...current, steer: false }));
    } catch (error) {
      updateDraft((current) => ({
        ...current,
        imageError: error instanceof Error ? error.message : "发送失败",
        text: [nextText, current.text].filter(Boolean).join("\n"),
        attachments: [...nextAttachments, ...current.attachments],
      }));
    } finally {
      updateDraft((current) => ({ ...current, sending: false }));
    }
  }

  async function sendQuickReply(promptId: string, promptText: string, bridgeExecutionConfirmed = false): Promise<void> {
    if (
      !selectedSession ||
      selectedSession.allowedActions?.canSend === false ||
      sending ||
      !promptText.trim()
    ) return;
    const remoteExecution = remoteExecutionChoice(selectedSession, bridgeExecutionConfirmed === true, { id: promptId, text: promptText });
    if (remoteExecution === undefined) return;
    updateDraft((current) => ({ ...current, sending: true }));
    try {
      const receipt = remoteExecution
        ? await onSendTurn(selectedSession.sessionId, promptText.trim(), [], false, true)
        : await onSendTurn(selectedSession.sessionId, promptText.trim(), [], steer);
      setPromptReplies((current) => ({ ...current, [draftKey]: { ...current[draftKey], [promptId]: receipt?.requestId ?? null } }));
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

  async function stopSubagent(): Promise<void> {
    if (!stopSubagentTarget || subagentStopBusy) return;
    setSubagentStopBusy(true);
    setStopError(undefined);
    try {
      await onStopSubagent?.(stopSubagentTarget.sessionId, stopSubagentTarget.agentId);
    } catch (error) {
      setStopError(error instanceof Error ? error.message : "子代理停止失败");
    } finally {
      setSubagentStopBusy(false);
      setStopSubagentTarget(undefined);
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

  function closeRename(): void {
    if (sessionActionBusy) return;
    setRenameOpen(false);
    setMenuSessionId(undefined);
  }

  async function renameSession(): Promise<void> {
    if (!menuSession || (!onRenameSession && !onRunSessionCommand) || !renameCanSave) return;
    setSessionActionBusy(true);
    setSessionActionError(undefined);
    try {
      if (onRunSessionCommand && snapshot?.host.capabilities.includes("session.command.v1") && desktopRuntimeId(menuSession) === "claude-desktop") {
        await onRunSessionCommand(menuSession.sessionId, `/rename ${renameTitle.trim()}`);
      } else await onRenameSession!(menuSession.sessionId, renameTitle.trim());
      setRenameOpen(false);
      setMenuSessionId(undefined);
    } catch (error) {
      setSessionActionError(error instanceof Error ? error.message : "重命名会话失败");
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

  const evidenceCount = (selectedEvidence?.items.length ?? 0) + (fileChangesSummary ? 1 : 0);
  const parentSession = selectedSession?.parentSessionId
    ? sessions.find((candidate) => candidate.sessionId === selectedSession.parentSessionId)
    : undefined;
  const childForks = selectedSession ? sessions.filter((candidate) => (
    candidate.parentSessionId === selectedSession.sessionId && (!candidate.archivedAt || Boolean(candidate.sidechat))
  )) : [];
  const relatedForkCount = (parentSession ? 1 : 0) + childForks.length;

  const sessionOverlays = (
    <>
      {selectedSession && <SessionCommandDialogs
        key={selectedSession.sessionId}
        session={selectedSession}
        result={commands.dialog}
        onClose={commands.close}
        onOpenSession={selectSession}
        onLoadPermissions={() => onLoadSessionPermissions!(selectedSession.sessionId)}
        onSavePermissions={(mode, rules) => onSaveSessionPermissions!(selectedSession.sessionId, mode, rules)}
      />}
      {menuSession && !renameOpen && (
        <MobileSheet
          eyebrow={`${menuSession.projectName} · ${desktopRuntimeName(desktopRuntimeId(menuSession))}`}
          title={menuSession.title}
          busy={sessionActionBusy}
          onClose={() => setMenuSessionId(undefined)}
        >
          {menuSession === selectedSession && (
            <div className="m-group">
              <SheetAction
                icon={sessionView === "evidence" ? <MessageSquare size={19} /> : <PackageCheck size={19} />}
                label={sessionView === "evidence" ? "返回对话" : `成果${evidenceCount > 0 ? ` ${evidenceCount}` : ""}`}
                detail={sessionView === "evidence" ? "回到对话记录" : "文件变更、产物与图片"}
                onClick={() => {
                  setSessionView(sessionView === "evidence" ? "conversation" : "evidence");
                  setMenuSessionId(undefined);
                }}
              />
              {relatedForkCount > 0 && (
                <SheetAction
                  icon={<GitFork size={19} />}
                  label={childForks.length > 0
                    ? (childForks.every((fork) => fork.sidechat)
                        ? `侧聊 ${childForks.length}`
                        : childForks.some((fork) => fork.sidechat)
                          ? `分支与侧聊 ${childForks.length}`
                          : `分支 ${childForks.length}`)
                    : "主会话"}
                  detail={childForks.length > 0
                    ? (childForks.every((fork) => fork.sidechat)
                        ? "查看此会话的 /btw 侧聊"
                        : childForks.some((fork) => fork.sidechat)
                          ? "查看由此会话派生的分支与 /btw 侧聊"
                          : "查看由此会话 fork 出的分支")
                    : `来自：${parentSession?.title ?? ""}`}
                  onClick={() => {
                    setForkChainOpen(true);
                    setMenuSessionId(undefined);
                  }}
                />
              )}
            </div>
          )}
          <div className="m-group">
            {menuSupportsRename && (
              <SheetAction
                icon={<FilePenLine size={19} />}
                label="重命名"
                disabled={sessionActionBusy}
                onClick={() => {
                  setRenameTitle(menuSession.title);
                  setSessionActionError(undefined);
                  setRenameOpen(true);
                }}
              />
            )}
            {canConfigureSession(menuSession) && (
              <SheetAction
                icon={<Settings2 size={19} />}
                label="会话设置"
                detail={conciseModelName(menuSession)}
                disabled={sessionActionBusy}
                onClick={() => {
                  setConfigurationSessionId(menuSession.sessionId);
                  setMenuSessionId(undefined);
                }}
              />
            )}
            <SheetAction
              icon={refreshing ? <LoaderCircle className="is-spinning" size={19} /> : syncFlash ? <Check size={19} /> : <RefreshCw size={19} />}
              label={refreshing ? "正在同步" : syncFlash ? "已同步" : "同步此会话"}
              detail="重新读取电脑端的最新记录"
              disabled={sessionActionBusy || refreshing}
              onClick={() => void runRefresh(menuSession.sessionId)}
            />
          </div>
          {(menuSupportsFork || menuSupportsProviderSwitch || menuSupportsRuntimeHandoff) && (
            <div className="m-group">
              {menuSupportsFork && (
                <SheetAction
                  icon={<GitFork size={19} />}
                  label="Fork 分支"
                  detail="复制完整对话为独立会话，原会话不变"
                  disabled={sessionActionBusy}
                  onClick={() => void forkSessionById(menuSession.sessionId)}
                />
              )}
              {menuSupportsProviderSwitch && (
                <SheetAction
                  icon={<ArrowRightLeft size={19} />}
                  label="切换执行来源"
                  detail={`当前：${providerName(menuSession.activeProviderProfileId, providers)}`}
                  disabled={sessionActionBusy}
                  onClick={() => {
                    setActionSessionId(menuSession.sessionId);
                    setProviderOpen(true);
                    setMenuSessionId(undefined);
                  }}
                />
              )}
              {menuSupportsRuntimeHandoff && (
                <SheetAction
                  icon={<Forward size={19} />}
                  label="交给其他桌面应用"
                  detail="由另一个 Desktop 接着完成"
                  disabled={sessionActionBusy}
                  onClick={() => {
                    setActionSessionId(menuSession.sessionId);
                    setRelayOpen(true);
                    setMenuSessionId(undefined);
                  }}
                />
              )}
            </div>
          )}
          {(onArchiveSession || onDeleteSession) && (
            <div className="m-group">
              {onArchiveSession && (
                <SheetAction
                  icon={menuSession.archivedAt ? <ArchiveRestore size={19} /> : <Archive size={19} />}
                  label={menuSession.archivedAt ? "恢复会话" : "归档会话"}
                  detail={menuSession.archivedAt ? "放回所属项目" : "从列表收起，历史保留"}
                  disabled={sessionActionBusy}
                  onClick={() => void archiveSessionById(menuSession.sessionId, !menuSession.archivedAt)}
                />
              )}
              {onDeleteSession && (
                <SheetAction
                  icon={<Trash2 size={19} />}
                  label="删除会话"
                  detail={menuSessionBusy || menuSession.pendingRuntimeHandoff
                    ? "任务或接力进行中，先停止再删除"
                    : "仅从 Bridge 移除，Desktop 原会话保留"}
                  danger
                  disabled={sessionActionBusy || menuSessionBusy || Boolean(menuSession.pendingRuntimeHandoff)}
                  onClick={() => setDeleteSessionConfirmOpen(true)}
                />
              )}
            </div>
          )}
          {sessionActionBusy && <p className="m-sheet-note" role="status"><LoaderCircle className="is-spinning" size={15} />正在处理…</p>}
          {sessionActionError && <p className="m-sheet-note is-error" role="alert">{sessionActionError}</p>}
        </MobileSheet>
      )}
      {renameOpen && menuSession && (
        <div
          className="modal-backdrop session-create-backdrop"
          role="presentation"
          onMouseDown={(event) => { if (event.target === event.currentTarget) closeRename(); }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              closeRename();
            }
          }}
        >
          <section className="create-session-dialog session-create-dialog" role="dialog" aria-modal="true" aria-label="重命名会话">
            <header className="session-create-header"><h2>重命名会话</h2></header>
            <form onSubmit={(event) => { event.preventDefault(); void renameSession(); }}>
              <div className="session-create-body">
                <label>
                  <span>会话名称</span>
                  <input
                    value={renameTitle}
                    autoFocus
                    required
                    disabled={sessionActionBusy}
                    onFocus={(event) => event.target.select()}
                    onChange={(event) => setRenameTitle(event.target.value)}
                  />
                </label>
                {sessionActionError && <p className="session-create-error" role="alert">{sessionActionError}</p>}
              </div>
              <footer className="dialog-actions session-create-actions">
                <button type="button" className="secondary-button" disabled={sessionActionBusy} onClick={closeRename}>取消</button>
                <button type="submit" className="primary-button" disabled={!renameCanSave}>{sessionActionBusy ? "正在保存…" : "保存"}</button>
              </footer>
            </form>
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
          revision={events.filter((event) => ((event.type === "session.configuration" || event.type === "session.compacted") && event.sessionId === configurationSession.sessionId) || (event.type === "permission.policy.changed" && (!event.sessionId || event.sessionId === configurationSession.sessionId))).at(-1)?.seq ?? 0}
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
    const selectedBusy = selectedSession.pendingCount > 0
      || selectedSession.turnState === "running"
      || selectedSession.turnState === "queued"
      || selectedSession.turnState === "waiting";
    const processStop = selectedBusy && selectedSession.mainTurnStopScope === "process";
    const stopTarget = processStop
      ? selectedSession
      : selectedBusy ? stoppableBridgeTask(sessions, selectedSession.sessionId) : undefined;
    const stopping = stoppingSessionId === stopTarget?.sessionId;
    const hasDraft = Boolean(text.trim()) || (canAttachImages && attachments.length > 0) || fileUploads.files.length > 0;
    const sessionPermissions = permissions.filter((permission) => permission.sessionId === selectedSession.sessionId);
    const activePermission = sessionPermissions[0];
    const otherPermission = permissions.find((permission) => permission.sessionId !== selectedSession.sessionId);
    const otherPermissionSession = otherPermission
      ? sessions.find((session) => session.sessionId === otherPermission.sessionId)
      : undefined;
    const displayNodes = groupTimelineTools(timeline);
    const renderSubagent = (item: ConversationItem) => (
      <SubagentCard
        item={item}
        key={item.id}
        entering={streamEntering(item.id)}
        stopping={subagentStopBusy && stopSubagentTarget?.agentId === item.subagent!.agentId}
        {...(selectedSession.subagentStopScope === "process" && selectedSession.turnState === "running"
          ? { stopBlockedReason: "主对话运行中，需要先停止主对话" }
          : {})}
        {...(onStopSubagent && selectedSession.subagentStopScope ? {
          onStop: () => setStopSubagentTarget({
            sessionId: selectedSession.sessionId,
            agentId: item.subagent!.agentId,
            description: item.subagent!.description,
            scope: selectedSession.subagentStopScope!,
          }),
        } : {})}
        {...(onDownloadSessionFile ? { onFileClick: openSessionFile } : {})}
      />
    );
    return (
      <main className="mobile-workspace conversation-workspace">
        <MobilePageHeader
          title={selectedSession.title}
          subtitle={canConfigure ? (
            <button
              type="button"
              className="m-host-chip"
              aria-label="会话设置"
              onClick={() => setConfigurationSessionId(selectedSession.sessionId)}
            >
              <i className={`m-status-dot ${selectedSession.turnState}`} />
              <span>{conciseSessionSubtitle(selectedSession)}</span>
              <ChevronDown size={14} />
            </button>
          ) : (
            <span className="m-presence">
              <i className={`m-status-dot ${selectedSession.turnState}`} />
              <span>{conciseSessionSubtitle(selectedSession)}</span>
            </span>
          )}
          backLabel={sessionView === "evidence" ? "返回对话" : "返回会话列表"}
          onBack={() => {
            if (sessionView === "evidence") setSessionView("conversation");
            else {
              setForkChainOpen(false);
              setSelectedSessionId(undefined);
            }
          }}
          actions={(
            <IconButton label="会话操作" onClick={() => {
              setSessionActionError(undefined);
              setMenuSessionId(selectedSession.sessionId);
            }}><MoreHorizontal size={22} /></IconButton>
          )}
        />
        <DesktopHandoffNotice
          key={selectedSession.sessionId}
          session={selectedSession}
          online={connection === "connected" && desktopOnline}
          className="session-channel-warning message-queue-status"
          {...(onReturnToDesktop ? { onReturn: onReturnToDesktop } : {})}
          {...(onTakeoverDesktop ? { onTakeover: onTakeoverDesktop } : {})}
          refreshing={refreshing}
          onRefresh={() => runRefresh(selectedSession.sessionId)}
        />
        {selectedSession.nativePermissionModeChange && (
          <div className="session-channel-warning message-queue-status" role="status" aria-label="Desktop 会话授权变更">
            <ShieldCheck size={17} />
            <span>{selectedSession.nativePermissionModeChange.state === "requested"
              ? `已请求切换为「${NATIVE_MODE_LABELS[selectedSession.nativePermissionModeChange.mode ?? "bypassPermissions"]}」，等待 Desktop 确认`
              : selectedSession.nativePermissionModeChange.state === "confirmed"
                ? "Desktop 已确认本次授权变更"
                : `Desktop 未切换为「${NATIVE_MODE_LABELS[selectedSession.nativePermissionModeChange.mode ?? "bypassPermissions"]}」，后续请求仍需确认`}</span>
          </div>
        )}
        {selectedSession.pendingCount > 0 && selectedSession.desktopHandoff?.state !== "close-desktop" && selectedSession.desktopHandoff?.state !== "desktop-inbox" && (
          <div className="session-channel-warning message-queue-status" role="status" aria-label="消息排队状态">
            <LoaderCircle size={17} />
            <span>
              <strong>{connection === "connected" && desktopOnline ? sessionQueueLabel(selectedSession) : "连接已断开，等待同步状态"}</strong>
              {connection === "connected" && desktopOnline
                ? `${selectedSession.pendingCount} 条消息已到电脑，轮到后会自动执行，无需重复发送。`
                : `上次同步时有 ${selectedSession.pendingCount} 条消息排队，当前进度尚未确认。`}
            </span>
            <button type="button" className="secondary-button" disabled={refreshing || connection !== "connected" || !desktopOnline}
              onClick={() => runRefresh(selectedSession.sessionId)}>{refreshing ? "同步中" : "同步状态"}</button>
          </div>
        )}
        {!selectedSession.desktopHandoff && selectedSession.ownership === "FALLBACK_CONFIRMATION_REQUIRED" && selectedSession.pendingCount === 0 && (
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
                {`${fork.sidechat ? "/btw" : (fork.forkLabel || "fork")} · ${fork.title}`}
              </button>
            ))}
            <button type="button" className="relay-chain-link" aria-label="收起分支" onClick={() => setForkChainOpen(false)}>
              <X size={14} />
            </button>
          </div>
        )}
        <ConfirmationDialog
          open={remoteExecutionConfirm?.key === draftKey}
          title="由 Bridge 继续执行？"
          description="等待此会话的当前任务和后台任务结束后，结束它的闲置 Desktop 执行进程并保留历史。之后可直接在手机继续，无需到电脑允许接收。工具审批仍按当前授权设置。"
          confirmLabel="确认并发送"
          busy={sending}
          onCancel={() => setRemoteExecutionConfirm(undefined)}
          onConfirm={() => {
            const confirmation = remoteExecutionConfirm;
            setRemoteExecutionConfirm(undefined);
            if (!confirmation || confirmation.key !== activeDraftKey.current) return;
            return confirmation.reply
              ? sendQuickReply(confirmation.reply.id, confirmation.reply.text, true)
              : sendMessage(true);
          }}
        />
        <ConfirmationDialog
          open={stopConfirmOpen && Boolean(stopTarget)}
          title={processStop
            ? "结束这个会话的 Claude 进程？"
            : stopTarget && stopTarget.sessionId !== selectedSession.sessionId ? "停止阻塞任务？" : "停止当前任务？"}
          description={processStop
            ? "这个会话由 Claude Desktop 运行，Bridge 无法只中断当前回复。确认后会结束它在电脑上的 Claude 进程，运行中的子代理和后台任务都会停止。已产生的对话记录会保留。"
            : `${stopTarget && stopTarget.sessionId !== selectedSession.sessionId ? `这个会话正在等待「${stopTarget.title}」。` : ""}${
                stopTarget?.turnState === "running" || stopTarget?.turnState === "waiting"
                  ? "正在生成的回复会中断，已产生的对话记录会保留。"
                  : "排在最前面的一条指令会被取消。"
              }`}
          confirmLabel={processStop ? "结束进程" : "停止"}
          danger
          busy={stopping}
          onCancel={() => setStopConfirmOpen(false)}
          onConfirm={() => {
            setStopConfirmOpen(false);
            if (stopTarget) void stopTask(stopTarget.sessionId);
          }}
        />
        <ConfirmationDialog
          open={Boolean(stopSubagentTarget)}
          title={stopSubagentTarget?.scope === "process" ? "结束这个会话的 Claude 进程？" : "停止这个子代理？"}
          description={stopSubagentTarget?.scope === "process"
            ? `这台电脑没有开启 Claude Desktop 托管，无法单独停止「${stopSubagentTarget.description}」。确认后会结束这个会话在电脑上的 Claude 进程，这个会话的所有后台任务都会停止。对话记录会保留。`
            : `「${stopSubagentTarget?.description ?? ""}」会被停止，还没交回的结果不会再有。主对话不受影响。`}
          confirmLabel={stopSubagentTarget?.scope === "process" ? "结束进程" : "停止子代理"}
          danger
          busy={subagentStopBusy}
          onCancel={() => {
            if (!subagentStopBusy) setStopSubagentTarget(undefined);
          }}
          onConfirm={() => void stopSubagent()}
        />
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
            if (node.kind === "subagent-group") {
              const hiddenAgents = node.agents.slice(3);
              const running = hiddenAgents.filter(item => item.subagent!.state === "running").length;
              return (
                <Fragment key={`${selectedSession.sessionId}:${node.id}`}>
                  {node.agents.slice(0, 3).map(renderSubagent)}
                  {hiddenAgents.length > 0 && (
                    <details className="subagent-overflow" data-stream-key={`${node.id}:overflow`} key={`${node.id}:overflow`}>
                      <summary>
                        <span className="subagent-overflow-expand">展开其余 {hiddenAgents.length} 个子代理</span>
                        <span className="subagent-overflow-collapse">收起其余 {hiddenAgents.length} 个子代理</span>
                        {running > 0 && <small>{running} 个运行中</small>}
                        <ChevronDown size={16} className="subagent-overflow-chevron" aria-hidden="true" />
                      </summary>
                      <div className="subagent-overflow-body">{hiddenAgents.map(renderSubagent)}</div>
                    </details>
                  )}
                </Fragment>
              );
            }
            const item = node.item;
            const showDelivery = Boolean(item.delivery);
            const messageQueued = item.delivery === "host-received"
              && item.commandId && selectedSession.pendingCommandIds?.includes(item.commandId);
            const queueActionKey = JSON.stringify([activeHostId, selectedSession.sessionId, item.commandId]);
            const queueAction = queuedSteers[queueActionKey];
            const canSteerQueued = item.role === "user" && messageQueued && onSteerQueuedTurn
              && bridgeRunning && !officialActive && desktopRuntimeId(selectedSession) === "claude-desktop"
              && selectedSession.allowedActions?.canSteer !== false;
            const copyable = (item.role === "assistant" || item.role === "user") && Boolean(item.text.trim());
            const peerMessages = selectedSession.transport === "claude-desktop-managed" || selectedSession.desktopHandoff?.state === "desktop-inbox";
            const pendingQuestion = item.interactivePrompt ? matchingQuestionPermission(
              item.interactivePrompt, sessionPermissions, item.interactivePrompt.toolUseId ?? (peerMessages ? "" : undefined),
            ) : undefined;
            const unavailableReason = peerMessages && item.interactivePrompt
              ? item.interactivePrompt.kind === "question" && !pendingQuestion ? "需在电脑端回答"
                : item.interactivePrompt.kind === "wrap-up" && item.interactivePrompt.blocked ? "需在电脑端确认" : undefined
              : undefined;
            const promptKey = `${draftKey}:${item.id}`;
            const content = (
              <>
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
                {item.taskPlan && <TaskPlanCard key={`${item.sessionId}:${item.taskPlan.id}`} plan={item.taskPlan} />}
                {item.interactivePrompt && (
                  <InteractivePromptCard
                    prompt={item.interactivePrompt}
                    {...(item.replyDelivery ? { replyDelivery: item.replyDelivery } : {})}
                    {...(item.replyPending ? { replyPending: true } : {})}
                    canSend={selectedSession.allowedActions?.canSend !== false && !officialActive}
                    busy={sending}
                    {...(unavailableReason ? { unavailableReason } : {})}
                    {...(promptErrors[promptKey] ? { error: promptErrors[promptKey] } : {})}
                    onSelectOption={async (replyText) => {
                      if (unavailableReason || sending) return;
                      if (pendingQuestion && item.interactivePrompt?.kind === "question") {
                        const questions = item.interactivePrompt.questions ?? [];
                        if (questions.length !== 1 || questions[0]?.multiSelect) {
                          setPermissionOpen(true);
                          return;
                        }
                        updateDraft((current) => ({ ...current, sending: true }));
                        setPromptErrors((current) => ({ ...current, [promptKey]: "" }));
                        try {
                          await onResolvePermission(
                            pendingQuestion.requestId,
                            "allow-once",
                            undefined,
                            { ...pendingQuestion.input, answers: { [questions[0]!.question]: replyText } },
                          );
                        } catch (error) {
                          setPromptErrors((current) => ({ ...current, [promptKey]: error instanceof Error ? error.message : "回答提交失败" }));
                        } finally {
                          updateDraft((current) => ({ ...current, sending: false }));
                        }
                        return;
                      }
                      await sendQuickReply(item.id, replyText);
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
              </>
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
                {/* A sent message's bubble holds only what was sent; status and copy sit under it. */}
                {item.role === "user" ? <div className="conversation-bubble">{content}</div> : content}
                {(copyable || showDelivery) && (
                  <div className="conversation-message-actions">
                    {showDelivery && <span className={`delivery-state ${item.delivery}`} role="status">{messageQueued ? `已排队 · ${sessionQueueLabel(selectedSession)}` : deliveryLabel(item.delivery!)}</span>}
                    {canSteerQueued && (
                      <button type="button" className="message-copy-button queued-steer-button"
                        disabled={connection !== "connected" || !desktopOnline || queueAction?.state === "pending" || queueAction?.state === "requested"}
                        title={connection !== "connected" || !desktopOnline ? "电脑离线，连接后再调整" : "让当前任务优先处理这条消息"}
                        onClick={async () => {
                          setQueuedSteers((current) => ({ ...current, [queueActionKey]: { state: "pending" } }));
                          try {
                            await onSteerQueuedTurn!(selectedSession.sessionId, item.commandId!);
                            setQueuedSteers((current) => ({ ...current, [queueActionKey]: { state: "requested" } }));
                          } catch (error) {
                            setQueuedSteers((current) => ({ ...current, [queueActionKey]: { state: "error", error: error instanceof Error ? error.message : "立即调整失败" } }));
                          }
                        }}>
                        {queueAction?.state === "pending" ? "调整中…" : queueAction?.state === "requested" ? "已调整" : "立即调整"}
                      </button>
                    )}
                    {copyable && <MessageCopyButton text={item.text} label={item.role === "assistant" ? "复制这条回复" : "复制这条消息"} />}
                  </div>
                )}
                {queueAction?.error && <div className="delivery-error-detail" role="alert">{queueAction.error}</div>}
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
              {...(onLoadEvidenceDetails ? { onLoadDetails: onLoadEvidenceDetails } : {})}
              onPreview={onPreviewArtifact}
              onDownload={onDownloadArtifact}
            />
          </section>
        )}

        {sessionView === "conversation" && (
        <>
        <SessionActivityIndicator activity={activity} />
        <section className="mobile-composer">
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
          {onUploadFile && <FileAttachmentPicker state={fileUploads} />}
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
          {imageError && <div className="composer-error" role="alert">{imageError}</div>}
          {bridgeRunning && !commandDraft && selectedSession.allowedActions?.canSteer !== false && (
            <div className="composer-mode" role="group" aria-label="发送方式">
              <button type="button" className={!steer ? "active" : ""} onClick={() => updateDraft((current) => ({ ...current, steer: false }))}>排到下一轮</button>
              <button type="button" className={steer ? "active" : ""} onClick={() => updateDraft((current) => ({ ...current, steer: true }))}>立即调整</button>
            </div>
          )}
          <form
            className={(canAttachImages || Boolean(onUploadFile)) ? "composer-form composer-form--with-attachment" : "composer-form"}
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
            {(canAttachImages || Boolean(onUploadFile)) && (
              <ComposerAttachmentMenu
                canAttachImages={canAttachImages}
                imageDisabled={commandDraft || selectedSession.allowedActions?.canSend === false}
                onPickImages={() => fileRef.current?.click()}
                {...(onUploadFile ? {
                  fileUploads,
                  fileDisabled: commandDraft || selectedSession.allowedActions?.canSend === false || sending || connection !== "connected" || !desktopOnline,
                } : {})}
              />
            )}
            <SlashCommandInput
              key={draftKey}
              textareaRef={composerRef}
              {...(onLoadSessionCommands && snapshot?.host.capabilities.includes("session.commands.v1") && desktopRuntimeId(selectedSession) === "claude-desktop" ? {
                onLoad: commands.load!,
              } : {})}
              value={text}
              onChange={(value) => updateDraft((current) => ({ ...current, text: value }))}
              disabled={selectedSession.allowedActions?.canSend === false}
              placeholder={desktopOnline
                ? selectedSession.allowedActions?.reason ?? (
                    selectedSession.source === "bridge"
                      ? "给这个 Bridge 会话发指令"
                      : `给这个 ${runtimeName} 会话发指令`
                  )
                : "电脑离线，消息会保存在手机并自动送达"}
              aria-label={`给 ${runtimeName} 发指令`}
            />
            {stopTarget && !hasDraft && !sending ? (
              <button
                type="button"
                className="send-button is-stop"
                aria-label={stopTarget.sessionId === selectedSession.sessionId ? "停止任务" : "停止阻塞任务"}
                disabled={stopping}
                onClick={() => setStopConfirmOpen(true)}
              >
                {stopping ? <LoaderCircle className="is-spinning" size={19} /> : <Square size={15} fill="currentColor" />}
              </button>
            ) : (
              <button
                type="submit"
                className="send-button"
                aria-label="发送"
                disabled={selectedSession.allowedActions?.canSend === false || sending || fileUploads.uploading || !hasDraft}
              >
                {sending ? <LoaderCircle className="is-spinning" size={19} /> : <Send size={19} />}
              </button>
            )}
          </form>
          </>
          )}
        </section>
        </>
        )}
        {permissionOpen && activePermission && (
          <MobileSheet
            eyebrow="需要处理"
            title={`${runtimeName} 等待授权`}
            closeLabel="暂时关闭"
            onClose={() => setPermissionOpen(false)}
          >
            {sessionPermissions.length > 1 && <div className="permission-queue-count">还有 {sessionPermissions.length} 项待处理，提交后自动显示下一项。</div>}
            <PermissionPrompt
              key={activePermission.requestId}
              permission={activePermission}
              onResolve={onResolvePermission}
              onEnableNativeFullAccess={(requestId) => onResolvePermission(requestId, "allow-once", undefined, undefined, "bypassPermissions")}
              {...(onConfigurePermissionPolicy ? {
                onEnableFullAccess: (sessionId: string) => (
                  onConfigurePermissionPolicy(sessionId, "host", "full-access").then(() => undefined)
                ),
              } : {})}
            />
          </MobileSheet>
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
          (!session.archivedAt || Boolean(session.sidechat && session.parentSessionId && activeParentProjects.get(session.parentSessionId) === session.projectId))
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
    const isArchivedRow = isArchivedList || Boolean(session.archivedAt);
    const turnBadge = isArchivedRow ? "已归档" : activeSessionBadgeLabel(session);
    const subagentBadge = isArchivedRow || turnBadge ? undefined : backgroundSubagentBadge(session);
    const badge = turnBadge ?? subagentBadge?.label;
    const forksExpanded = expandedForkParents.has(session.sessionId);
    const badgeLabel = session.sidechat ? "/btw" : (session.forkLabel || "fork");
    const badgeClassName = `session-fork-badge${session.sidechat ? " is-sidechat" : ""}`;
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
                {isForkChild && <em className={badgeClassName}>{badgeLabel}</em>}
                {session.title}
                {!isForkChild && session.parentSessionId && (
                  <em className={badgeClassName}>{badgeLabel}</em>
                )}
              </strong>
              <small>
                {!isForkChild && populatedRuntimeCount > 1 ? `${desktopRuntimeName(desktopRuntimeId(session))} · ` : ""}
                {relativeTime(session.lastActivityAt)}
                {!isArchivedRow && session.currentSummary ? ` · ${session.currentSummary}` : ""}
              </small>
            </span>
            {badge && (
              <span className={`session-row-status ${subagentBadge ? (subagentBadge.stalled ? "queued" : "running") : session.turnState}`}>
                {badge}
              </span>
            )}
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
              <span>
                {forks.every((fork) => fork.primary.sidechat)
                  ? `${forks.length} 个 /btw 侧聊`
                  : forks.some((fork) => fork.primary.sidechat)
                    ? `${forks.length} 个分支与侧聊`
                    : `${forks.length} 个 Fork 分支`}
              </span>
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

  const runtimeFilterNav = showRuntimeFilter && (
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
  );

  return (
    <main className="mobile-workspace host-detail-workspace">
      <MobilePageHeader
        title={activeProjectId ? activeGroupName : "会话"}
        titleHidden={!activeProjectId}
        subtitle={activeProjectId ? activeGroupCwd : (
          <button type="button" className="m-host-chip" onClick={onBackToHosts} aria-label={`当前电脑：${desktopName}，查看电脑`}>
            <i className={`m-status-dot${desktopOnline ? " is-online" : ""}`} />
            <span>{desktopName} · {hostStatusText}</span>
            <ChevronRight size={14} />
          </button>
        )}
        {...(activeProjectId ? { onBack: closeProjectGroup, backLabel: "返回会话目录" } : {})}
        actions={(
          <>
            {!isArchivedGroupPage && (
              <IconButton
                label="新建会话"
                disabled={!snapshot || connection !== "connected" || !desktopOnline}
                onClick={() => openCreateDialogForProject(activeProjectId)}
              >
                <Plus size={22} />
              </IconButton>
            )}
            <IconButton label="目录选项" onClick={() => setDirectoryMenuOpen(true)}><MoreHorizontal size={22} /></IconButton>
          </>
        )}
      />

      {activeProjectId ? (
        <section className="host-detail project-detail-view" ref={directoryRef} onScroll={(event) => directoryScrollPositions.current.set(activeProjectId, event.currentTarget.scrollTop)}>
          <label className="session-search">
            <Search size={17} />
            <input
              value={projectSearch}
              onChange={(event) => setProjectSearch(event.target.value)}
              placeholder={`搜索「${activeGroupName}」`}
            />
          </label>
          {runtimeFilterNav}
          {activeGroupFamilies.length === 0 ? (
            <div className="session-catalog-loading">
              <strong>{projectSearch ? "没有匹配的会话" : isArchivedGroupPage ? "暂无已归档会话" : "此分组暂无会话"}</strong>
              <span>{projectSearch ? "换一个关键词试试。" : isArchivedGroupPage ? "归档后的会话会显示在这里，可返回会话目录继续查看。" : "可点击右上角新建会话，或返回查看其它项目。"}</span>
            </div>
          ) : (
            <div className="session-rows project-detail-rows">
              {activeGroupFamilies.map((family) => renderMobileSessionFamily(family, isArchivedGroupPage))}
            </div>
          )}
        </section>
      ) : (
      <section className="host-detail" ref={directoryRef} onScroll={(event) => directoryScrollPositions.current.set("", event.currentTarget.scrollTop)}>
        <label className="session-search">
          <Search size={17} />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索项目或会话" />
        </label>
        {runtimeFilterNav}
        {!search && projectOrder.length > 1 && (
          <div className="project-order-bar">
            <span>项目顺序已固定</span>
            <button type="button" onClick={() => setProjectOrderOpen(true)}><ArrowUpDown size={15} />调整顺序</button>
          </div>
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
        <MobileSheet eyebrow={desktopName} title={activeProjectId ? activeGroupName : "会话目录"} onClose={() => setDirectoryMenuOpen(false)}>
          <div className="m-group">
            <SheetAction
              icon={refreshing ? <LoaderCircle className="is-spinning" size={19} /> : syncFlash ? <Check size={19} /> : <RefreshCw size={19} />}
              label={refreshing ? "正在同步" : syncFlash ? "已同步" : "同步当前电脑"}
              detail="重新读取项目、会话与运行状态"
              disabled={refreshing}
              onClick={() => void runRefresh()}
            />
            {!activeProjectId && projectOrder.length > 1 && (
              <SheetAction
                icon={<ArrowUpDown size={19} />}
                label="调整项目顺序"
                detail="项目顺序固定，可置顶或上下移动"
                onClick={() => {
                  setDirectoryMenuOpen(false);
                  setProjectOrderOpen(true);
                }}
              />
            )}
            {!activeProjectId && groupedProjectIds.length > 1 && (
              <SheetAction
                icon={allProjectsCollapsed ? <ChevronsDown size={19} /> : <ChevronsUp size={19} />}
                label={allProjectsCollapsed ? "展开全部项目" : "折叠全部项目"}
                onClick={() => {
                  setCollapsedProjectIds(allProjectsCollapsed ? expandAllProjects() : collapseProjects(groupedProjectIds));
                  setDirectoryMenuOpen(false);
                }}
              />
            )}
          </div>
        </MobileSheet>
      )}
      {projectOrderOpen && (
        <MobileSheet
          eyebrow={desktopName}
          title="项目顺序"
          onClose={() => setProjectOrderOpen(false)}
          footer={(
            <>
              <button type="button" className="secondary-button" disabled={projectOrder.join() === projectsByActivity.join()} onClick={() => placeProjects(projectsByActivity)}>按最近活动重排</button>
              <button type="button" className="primary-button" onClick={() => setProjectOrderOpen(false)}>完成</button>
            </>
          )}
        >
          <p className="m-sheet-note">项目按这里的顺序固定显示，点开或收到回复都不会移动项目；新出现的项目排在最前。项目内的会话按最近回复或打开的先后排列。</p>
          <div className="m-group project-order-list">
            {projectOrder.map((projectId, index) => {
              const projectSessions = sessions.filter((session) => session.projectId === projectId && !session.archivedAt);
              const name = snapshot?.projects.find((project) => project.projectId === projectId)?.name ?? projectSessions[0]!.projectName;
              const last = index === projectOrder.length - 1;
              return (
                <div className="project-order-row" key={projectId}>
                  <span><strong>{name}</strong><small>{projectSessions.length} 个会话</small></span>
                  <IconButton label={`置顶「${name}」`} disabled={index === 0} onClick={() => placeProjects(moveProject(projectOrder, projectId, 0))}><ArrowUpToLine size={18} /></IconButton>
                  <IconButton label={`上移「${name}」`} disabled={index === 0} onClick={() => placeProjects(moveProject(projectOrder, projectId, index - 1))}><ArrowUp size={18} /></IconButton>
                  <IconButton label={`下移「${name}」`} disabled={last} onClick={() => placeProjects(moveProject(projectOrder, projectId, index + 1))}><ArrowDown size={18} /></IconButton>
                </div>
              );
            })}
          </div>
        </MobileSheet>
      )}
      {createOpen && snapshot && (
        <SessionCreateDialog
          key={snapshot.host.hostId}
          snapshot={snapshot}
          connected={connection === "connected" && desktopOnline}
          initialProjectId={createProjectId}
          initialRuntimeId={createRuntimeId}
          {...(onBrowseDirectory ? { onBrowseDirectory } : {})}
          onCreate={onCreateSession}
          onCreated={(created) => {
            setCollapsedProjectIds((current) => expandProject(current, created.projectId));
            void onRefresh().then(() => selectSession(created.sessionId));
          }}
          onClose={() => setCreateOpen(false)}
        />
      )}
    </main>
  );
}
