import type {
  BridgeAttachment,
  BridgeBackgroundTask,
  BridgeEvent,
  BridgeHostSnapshot,
  BridgeMailCard,
  BridgeNativePermissionMode,
  BridgePermissionInfo,
  BridgePermissionRules,
  BridgePrAutoFixState,
  BridgePrAutoFixUpdate,
  BridgePullRequest,
  BridgeSDKPermissionMode,
  BridgeSessionCommandResult,
  BridgeSessionConfiguration,
  BridgeSessionInfo,
  BridgeSessionPermissions,
  BridgeSessionRewindPreview,
  BridgeSessionRewindResult,
  BridgeSessionRewindScope,
  BridgeSlashCommandCatalog,
  SocketState,
} from "@bridge/protocol";
import {
  AlertTriangle,
  Archive,
  ChevronDown,
  FileText,
  Layers,
  LoaderCircle,
  MoreHorizontal,
  ShieldCheck,
  X,
} from "lucide-react";
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from "react";
import {
  isClaudeNativeRelay,
  type LocalTurn,
  type MobileConnectionIssue,
  type SessionEvidenceState,
  type SessionHistoryState,
} from "../../hooks/useMobileBridge.js";
import { sessionCommandName, useSessionCommands } from "../../hooks/useSessionCommands.js";
import {
  aggregateFileChanges,
  assistantConversationTimeline,
  canConfigureSession,
  canSendSession,
  conversationItems,
  conversationTimeline,
  groupTimelineTools,
  isQueuedConversationMessage,
  proposalAnchors,
  runtimeSupports,
  type ConversationItem,
} from "../../lib/conversation-timeline.js";
import type { UploadFileHandler } from "../../lib/file-upload.js";
import { registerMobileBackHandler } from "../../lib/mobile-back-navigation.js";
import { desktopRuntimeId, desktopRuntimeName } from "../../lib/runtime-labels.js";
import { sessionQueueLabel } from "../../lib/session-activity.js";
import { useStreamEntrance } from "../../lib/stream-entrance.js";
import { useInlineProposals } from "../assistant/AssistantProposalProvider.js";
import { AssistantProcessing, AssistantProcessingContext } from "../assistant/AssistantProcessing.js";
import { AssistantTriggerBatch } from "../assistant/AssistantTriggerBatch.js";
import { MailCard } from "../assistant/MailCard.js";
import { ProposalCard } from "../assistant/ProposalCard.js";
import { ConfirmationDialog } from "../common/ConfirmationDialog.js";
import { IconButton } from "../common/IconButton.js";
import { SelectMenu } from "../common/SelectMenu.js";
import { Sheet, SheetAction } from "../common/Sheet.js";
import { EvidenceInlineSummary, type EvidencePanel } from "../evidence/EvidencePanel.js";
import { countSessionOutputFiles } from "../evidence/FileChangesCard.js";
import { MobileComposer } from "../mobile/MobileComposer.js";
import { MobilePageHeader } from "../mobile/MobilePageHeader.js";
import {
  SessionConfigurationDialog,
  type SessionConfigurationChange,
} from "../session/SessionConfigurationDialog.js";
import { SessionProfileSummary } from "../session/SessionProfileSummary.js";
import { PERMISSION_MODE_LABELS } from "../session/session-labels.js";
import { BackgroundTaskMarker, BackgroundTasksSheet, findBackgroundTask } from "./BackgroundTasks.js";
import { useConversationDrafts } from "./ConversationDraftsProvider.js";

type ConversationDraftsValue = ReturnType<typeof useConversationDrafts>;
import { ConversationMessageItem } from "./ConversationMessageItem.js";
import { ConversationToolGroup } from "./ConversationToolGroup.js";
import { SessionProposalCard } from "./SessionProposalCard.js";
import { SessionSentFiles } from "./SessionSentFiles.js";
import { ForkChainBar } from "./ForkChainBar.js";
import { NativePromptCard } from "./NativePromptCard.js";
import {
  InteractivePromptCard,
  matchingQuestionPermission,
  PermissionPrompt,
} from "./PermissionPrompts.js";
import { SessionCommandDialogs } from "./SessionCommandDialogs.js";
import { SessionNoticeCard } from "./SessionNoticeCard.js";
import { SessionPrBar } from "./SessionPrBar.js";
import { SessionRewindDialog } from "./SessionRewindDialog.js";
import { SubagentCard } from "./SubagentCard.js";
import { useConversationMenu, type ConversationMenuBindings } from "./useConversationMenu.js";
import { useConversationScroll } from "./useConversationScroll.js";
import { useConversationTasks } from "./useConversationTasks.js";
import { useSessionFileDownload } from "./useSessionFileDownload.js";
import { useAcknowledgeSessionCompletion } from "../session/useSeenSessionCompletions.js";

const ASSISTANT_HIDDEN_COMMANDS = new Set(["fork", "rewind"]);

export interface ConversationViewProps {
  variant?: "mobile" | "desktop" | undefined;
  surface?: "project" | "assistant" | undefined;
  alternateStage?: ((openConfiguration?: () => void) => ReactNode) | undefined;
  hideComposer?: boolean | undefined;
  assistantReplyTarget?: { itemId: string; done(error?: string): void } | undefined;
  hostId: string;
  session: BridgeSessionInfo;
  sessions: BridgeSessionInfo[];
  snapshot: BridgeHostSnapshot | undefined;
  connection: SocketState;
  desktopOnline: boolean;
  nativeReady?: boolean | undefined;
  visible?: boolean | undefined;
  navigation?: boolean | undefined;
  headerLeading?: ReactNode | undefined;
  onBackToCatalog?: (() => void) | undefined;
  onSelectSession(sessionId: string): void | Promise<void>;
  conversationDrafts?: ConversationDraftsValue | undefined;
  sessionView?: "conversation" | "evidence" | undefined;
  onSessionViewChange?: ((view: "conversation" | "evidence") => void) | undefined;
  forkChainOpen?: boolean | undefined;
  onForkChainOpenChange?: ((open: boolean) => void) | undefined;
  permissionOpen?: boolean | undefined;
  onPermissionOpenChange?: ((open: boolean) => void) | undefined;
  configurationOpen?: boolean | undefined;
  onConfigurationOpenChange?: ((open: boolean) => void) | undefined;
  sessionMenu?: ConversationMenuBindings | undefined;
  refreshing?: boolean | undefined;
  onRefresh?: ((sessionId?: string) => Promise<unknown>) | undefined;
  onRetry?: (() => Promise<void>) | undefined;
  history: SessionHistoryState | undefined;
  latestHistorySync?: "loading" | { error: string; retry(): Promise<void>; dismiss(): void } | undefined;
  evidence: SessionEvidenceState | undefined;
  openedEvidenceIds?: ReadonlySet<string> | undefined;
  renderEvidence(props: Pick<ComponentProps<typeof EvidencePanel>,
    "variant" | "sessionId" | "cwd" | "state" | "conversationItems" | "fileChanges"
    | "online" | "onRequestSessionFileDownload" | "onResolvedFileCountChange"
  >): ReactNode;
  permissions: BridgePermissionInfo[];
  events: BridgeEvent[];
  localTurns?: LocalTurn[] | undefined;
  connectionIssue?: MobileConnectionIssue | undefined;
  mailCards?: BridgeMailCard[] | undefined;
  composerBanner?: ReactNode;
  resolveMailRefId?: (() => string | undefined) | undefined;
  onOpenSession(sessionId: string): Promise<void>;
  onLoadOlderHistory(sessionId: string): Promise<void>;
  onDownloadSessionFile?: ((sessionId: string, filePath: string, resolveRelativeLink?: true) => Promise<void>) | undefined;
  onUploadFile?: UploadFileHandler | undefined;
  onSendTurn(
    sessionId: string,
    text: string,
    attachments: BridgeAttachment[],
    mailRefId?: string,
  ): Promise<{ requestId: string } | void>;
  onInterruptTurn(sessionId: string, commandId?: string): Promise<void>;
  onSteerQueuedTurn?: ((sessionId: string, commandId: string) => Promise<void>) | undefined;
  onCancelQueuedTurn?: ((sessionId: string, commandId: string) => Promise<void>) | undefined;
  onStopSubagent?: ((sessionId: string, agentId: string) => Promise<void>) | undefined;
  onResolveUncertain(commandId: string, action: "confirm" | "retry"): Promise<void>;
  onResolvePermission(
    requestId: string,
    decision: "allow-once" | "allow-always" | "deny",
    message?: string,
    updatedInput?: Record<string, unknown>,
    mode?: BridgeNativePermissionMode,
  ): Promise<void>;
  onResolvePrompt?: ((sessionId: string, promptId: string, choice: string) => Promise<void>) | undefined;
  onReadPrAutoFix?: ((sessionId: string, pr?: BridgePullRequest, includeChecks?: boolean) => Promise<BridgePrAutoFixState>) | undefined;
  onSetPrAutoFix?: ((update: BridgePrAutoFixUpdate) => Promise<BridgePrAutoFixState>) | undefined;
  onLoadBackgroundTasks?: ((sessionId: string) => Promise<BridgeBackgroundTask[]>) | undefined;
  onLoadSessionConfiguration(sessionId: string): Promise<BridgeSessionConfiguration>;
  onConfigureSession(sessionId: string, change: SessionConfigurationChange): Promise<BridgeSessionConfiguration>;
  onLoadSessionCommands?: ((sessionId: string) => Promise<BridgeSlashCommandCatalog>) | undefined;
  onRunSessionCommand?: ((sessionId: string, text: string) => Promise<BridgeSessionCommandResult>) | undefined;
  onLoadSessionPermissions?: ((sessionId: string) => Promise<BridgeSessionPermissions>) | undefined;
  onSaveSessionPermissions?: ((
    sessionId: string,
    mode: BridgeSDKPermissionMode,
    rules: BridgePermissionRules,
  ) => Promise<BridgeSessionPermissions>) | undefined;
  onPreviewRewind?: ((sessionId: string, messageId: string) => Promise<BridgeSessionRewindPreview>) | undefined;
  onRewindSession?: ((
    sessionId: string,
    messageId: string,
    scope: BridgeSessionRewindScope,
  ) => Promise<BridgeSessionRewindResult>) | undefined;
}

export function ConversationView({
  variant = "mobile",
  surface = "project",
  alternateStage,
  assistantReplyTarget,
  hideComposer = false,
  hostId,
  session,
  sessions,
  snapshot,
  connection,
  desktopOnline,
  nativeReady,
  visible = true,
  navigation = true,
  headerLeading,
  onBackToCatalog,
  onSelectSession,
  conversationDrafts: externalDrafts,
  sessionView: controlledSessionView,
  onSessionViewChange,
  forkChainOpen: controlledForkChainOpen,
  onForkChainOpenChange,
  permissionOpen: controlledPermissionOpen,
  onPermissionOpenChange,
  configurationOpen: controlledConfigurationOpen,
  onConfigurationOpenChange,
  sessionMenu,
  refreshing = false,
  onRefresh,
  onRetry,
  history,
  latestHistorySync,
  evidence,
  openedEvidenceIds,
  renderEvidence,
  permissions,
  events,
  localTurns = [],
  connectionIssue,
  mailCards = [],
  composerBanner,
  resolveMailRefId,
  onOpenSession,
  onLoadOlderHistory,
  onDownloadSessionFile,
  onUploadFile,
  onSendTurn,
  onInterruptTurn,
  onSteerQueuedTurn,
  onCancelQueuedTurn,
  onStopSubagent,
  onResolveUncertain,
  onResolvePermission,
  onResolvePrompt,
  onReadPrAutoFix,
  onSetPrAutoFix,
  onLoadBackgroundTasks,
  onLoadSessionConfiguration,
  onConfigureSession,
  onLoadSessionCommands,
  onRunSessionCommand,
  onLoadSessionPermissions,
  onSaveSessionPermissions,
  onPreviewRewind,
  onRewindSession,
}: ConversationViewProps) {
  const isMobile = variant === "mobile";
  const isAssistant = surface === "assistant";
  const processing = useContext(AssistantProcessingContext);
  const processingVisible = isAssistant && processing?.visible === true;
  const hasAlternateStage = isAssistant && (alternateStage != null || processingVisible);
  const composerHidden = isAssistant && hideComposer;
  const fallbackDrafts = useConversationDrafts(hostId);
  const conversationDrafts = externalDrafts ?? fallbackDrafts;
  const sessionDraft = conversationDrafts.session(hostId, session.sessionId, onUploadFile);
  const { draftKey, draft, promptReplies: sessionPromptReplies, queuedActions, fileUploads, updateDraft } = sessionDraft;
  const { text, attachments, sending, imageError } = draft;
  const files = useSessionFileDownload(
    session.sessionId, isMobile, onDownloadSessionFile,
    snapshot?.host.capabilities.includes("artifact.transfer.relative-link.v1") ?? false,
  );

  const [internalSessionView, setInternalSessionView] = useState<"conversation" | "evidence">("conversation");
  if (hasAlternateStage && internalSessionView === "evidence") setInternalSessionView("conversation");
  const [internalForkChainOpen, setInternalForkChainOpen] = useState(
    () => Boolean(session.parentSessionId),
  );
  const [internalPermissionOpen, setInternalPermissionOpen] = useState(false);
  const [internalConfiguration, setInternalConfiguration] = useState<"session" | "model-effort">();
  const [rewindTarget, setRewindTarget] = useState<{ sessionId: string; messageId?: string }>();
  const [selectedNativePromptId, setSelectedNativePromptId] = useState<string>();
  const [contextPopoverOpen, setContextPopoverOpen] = useState(false);
  const [compactBusy, setCompactBusy] = useState(false);
  const [resolvedEvidenceFileCount, setResolvedEvidenceFileCount] = useState<{
    sourceKey: string;
    count: number;
  }>();

  const fileRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const contextTriggerRef = useRef<HTMLButtonElement>(null);
  const contextPopoverRef = useRef<HTMLDivElement>(null);
  const contextContainerRef = useRef<HTMLDivElement>(null);
  const announcedPermissionsRef = useRef(new Set<string>());
  const autoRetriedSessionRef = useRef<string | undefined>(undefined);
  const previousDraftKeyRef = useRef(draftKey);

  const effectiveSessionView = controlledSessionView ?? internalSessionView;
  const transcriptHidden = isAssistant && (hasAlternateStage || effectiveSessionView === "evidence");
  useAcknowledgeSessionCompletion(hostId, session,
    visible && !transcriptHidden && effectiveSessionView === "conversation" && (history?.status === "ready" || Boolean(history?.items.length)));
  const setSessionView = onSessionViewChange ?? setInternalSessionView;
  const effectiveForkChainOpen = controlledForkChainOpen ?? internalForkChainOpen;
  function setForkChainOpen(next: boolean): void {
    if (onForkChainOpenChange) onForkChainOpenChange(next);
    else setInternalForkChainOpen(next);
  }
  const effectivePermissionOpen = controlledPermissionOpen ?? internalPermissionOpen;
  function setPermissionOpen(next: boolean): void {
    if (onPermissionOpenChange) onPermissionOpenChange(next);
    else setInternalPermissionOpen(next);
  }
  const effectiveConfigurationOpen = controlledConfigurationOpen ?? (internalConfiguration !== undefined);
  function setConfigurationOpen(next: boolean): void {
    if (onConfigurationOpenChange) onConfigurationOpenChange(next);
    else setInternalConfiguration(next ? "session" : undefined);
  }

  useEffect(() => {
    if (previousDraftKeyRef.current === draftKey) return;
    previousDraftKeyRef.current = draftKey;
    setInternalSessionView("conversation");
    setInternalPermissionOpen(false);
    setInternalConfiguration(undefined);
    setInternalForkChainOpen(Boolean(session.parentSessionId));
    tasks.resetSelection();
    files.resetSelection();
    menu.resetSelection();
    setContextPopoverOpen(false);
    setCompactBusy(false);
    setResolvedEvidenceFileCount(undefined);
  }, [draftKey, isMobile, session.parentSessionId, session.sidechat]);

  useEffect(() => {
    if (!contextPopoverOpen) return;
    if (!session.contextUsage || !(session.contextUsage.totalTokens > 0)) {
      setContextPopoverOpen(false);
    }
  }, [contextPopoverOpen, session.contextUsage]);

  useEffect(() => {
    if (!contextPopoverOpen || typeof document === "undefined") return;
    contextPopoverRef.current?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (
        contextContainerRef.current
        && event.target instanceof Node
        && !contextContainerRef.current.contains(event.target)
      ) {
        setContextPopoverOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setContextPopoverOpen(false);
        contextTriggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [contextPopoverOpen]);

  const runtimeId = desktopRuntimeId(session);
  const runtimeName = desktopRuntimeName(runtimeId);
  const isOnline = isMobile ? connection === "connected" && desktopOnline : desktopOnline;
  const isNativeReady = nativeReady ?? (connection === "connected" && desktopOnline);
  const menu = useConversationMenu({
    hostId,
    draftKey,
    previousDraftKeyRef,
    session,
    snapshot,
    history,
    isMobile,
    isOnline,
    refreshing,
    onRefresh,
    onOpenSession,
    onSelectSession,
    onRunSessionCommand,
    sessionMenu,
    onDeleted: () => conversationDrafts.resetSession(hostId, session.sessionId),
  });

  const commands = useSessionCommands({
    sessionId: session.sessionId,
    sessionKey: draftKey,
    enabled: runtimeId === "claude-desktop",
    supported: Boolean(snapshot?.host.capabilities.includes("session.command.v1")),
    onLoad: onLoadSessionCommands && runtimeId === "claude-desktop" && snapshot?.host.capabilities.includes("session.commands.v1")
      ? async () => {
          const catalog = await onLoadSessionCommands(session.sessionId);
          if (!isAssistant) return catalog;
          return { ...catalog, commands: catalog.commands.filter((command) => !ASSISTANT_HIDDEN_COMMANDS.has(command.name.toLowerCase())) };
        }
      : undefined,
    onRun: onRunSessionCommand ? (value) => {
      if (isAssistant && ASSISTANT_HIDDEN_COMMANDS.has(sessionCommandName(value) ?? "")) {
        throw new Error("助理对话不支持 Fork 或 Rewind。");
      }
      return onRunSessionCommand(session.sessionId, value);
    } : undefined,
    onModel: () => setConfigurationOpen(true),
    onRewind: () => setRewindTarget({ sessionId: session.sessionId }),
    ...(menu.onRename ? { onRename: menu.onRename } : {}),
    onSession: async (nextSessionId) => {
      await onSelectSession(nextSessionId);
    },
  });
  const commandDraft = commands.recognizes(text.trim());

  const canAttachImages = isMobile
    ? runtimeSupports(snapshot, session, "attachment.image")
    : (snapshot?.runtimes?.find((runtime) => runtime.id === runtimeId)?.capabilities.includes("attachment.image")
      ?? runtimeId === "claude-desktop");
  const canConfigure = canConfigureSession(session, snapshot);
  const rewindAvailable = Boolean(
    !isAssistant && session.transport === "claude-desktop-native"
    && snapshot?.host.capabilities.includes("session.rewind.v1")
    && onPreviewRewind
    && onRewindSession,
  );
  const rewindDisabled = isMobile
    ? connection !== "connected" || !desktopOnline
    : session.turnState === "running" || session.turnState === "waiting" || Boolean(session.pendingCount);

  useEffect(() => {
    if (!isMobile || !visible) return;
    if (connection !== "connected") {
      autoRetriedSessionRef.current = undefined;
      return;
    }
    if (!history || (history.status === "error" && history.items.length === 0)) {
      const retryKey = `${session.sessionId}:${connection}`;
      if (autoRetriedSessionRef.current === retryKey) return;
      autoRetriedSessionRef.current = retryKey;
      void onOpenSession(session.sessionId);
    }
  }, [connection, history, isMobile, onOpenSession, session.sessionId, visible]);

  const items = useMemo(
    () => conversationItems(session.sessionId, history, events, localTurns, true, sessionPromptReplies),
    [events, history, localTurns, session.sessionId, sessionPromptReplies],
  );
  const fileChangesSummary = useMemo(() => aggregateFileChanges(items), [items]);
  const anchors = useMemo(() => proposalAnchors(items), [items]);
  const inlineProposals = useInlineProposals(session.sessionId, anchors);
  const fullTimeline = useMemo(
    () => conversationTimeline(items, evidence?.items ?? [], mailCards, inlineProposals),
    [evidence?.items, items, mailCards, inlineProposals],
  );
  const assistantTimeline = useMemo(() => isAssistant ? assistantConversationTimeline(fullTimeline) : undefined, [isAssistant, fullTimeline]);
  const timeline = assistantTimeline?.chat ?? fullTimeline;
  const displayNodes = useMemo(() => groupTimelineTools(timeline), [timeline]);
  const latestMessage = displayNodes.filter((node) => node.kind === "message" && !node.item.sessionNotice
    && (node.item.role === "user" || node.item.role === "assistant")).at(-1);
  const inlineQueuedIds = new Set<string>();
  if (effectiveSessionView === "conversation" && session.pendingCount > 0) {
    for (const node of displayNodes) {
      const item = node.kind === "message" ? node.item : node.kind === "assistant-trigger-batch" ? node.nativeMessage : undefined;
      if (item?.role === "user" && !item.sessionNotice && item.commandId && isQueuedConversationMessage(item, session)) {
        inlineQueuedIds.add(item.commandId);
      } else if (node.kind === "assistant-trigger-batch") {
        const delivery = node.cards[0]?.nativeDelivery;
        if (delivery?.state === "queued" && delivery.commandId) inlineQueuedIds.add(delivery.commandId);
      }
    }
  }
  for (const { nativeMessage, cards } of assistantTimeline?.batches ?? []) {
    const delivery = cards[0]?.nativeDelivery;
    const commandId = nativeMessage?.commandId ?? delivery?.commandId;
    if (commandId && (nativeMessage?.delivery ?? delivery?.state) === "queued") inlineQueuedIds.add(commandId);
  }
  const missingQueuedCount = session.pendingCount - inlineQueuedIds.size;
  const showQueueBanner = missingQueuedCount > 0
    && session.desktopHandoff?.state !== "close-desktop" && session.desktopHandoff?.state !== "desktop-inbox";

  const toolGroupKeysRef = useRef<{ sessionId?: string | undefined; byToolId: Map<string, string> }>({ byToolId: new Map() });
  const toolGroupKeys = useMemo(() => {
    if (toolGroupKeysRef.current.sessionId !== session.sessionId || displayNodes.length === 0) {
      toolGroupKeysRef.current = { sessionId: session.sessionId, byToolId: new Map() };
    }
    const { byToolId } = toolGroupKeysRef.current;
    const groups = displayNodes.filter(node => node.kind === "tool-group");
    // When a proposal splits a group, reserve each new group's own key before reusing cached ones.
    const currentIds = new Set(groups.map(node => node.id));
    const claimed = new Set<string>();
    const keys = new Map<string, string>();
    for (const node of groups) {
      const stableKey = node.tools.map(tool => byToolId.get(tool.id)).find(key => (
        key && !claimed.has(key) && (key === node.id || !currentIds.has(key))
      )) ?? node.id;
      claimed.add(stableKey);
      for (const tool of node.tools) byToolId.set(tool.id, stableKey);
      keys.set(node.id, stableKey);
    }
    return keys;
  }, [displayNodes, session.sessionId]);

  const timelineStreamKeys = useMemo(() => timeline.map((entry) => (
    entry.kind === "evidence"
      ? `evidence:${entry.evidence.id}`
      : entry.kind === "mail" ? `mail:${entry.card.mailRefId}`
        : entry.kind === "proposal" ? `proposal:${entry.proposal.proposalId}`
          : entry.kind === "assistant-trigger-batch" ? `assistant-trigger:${entry.batchId}` : entry.item.id
  )), [timeline]);
  const streamEntering = useStreamEntrance(session.sessionId, timelineStreamKeys);

  const tasks = useConversationTasks({
    draftKey,
    session,
    sessions,
    items,
    showQueueActivity: inlineQueuedIds.size === 0 && !showQueueBanner,
    pollEnabled: visible && effectiveSessionView === "conversation" && isNativeReady
      && runtimeId === "claude-desktop" && (history?.status === "ready" || Boolean(history?.items.length)),
    onLoadBackgroundTasks,
    onInterruptTurn,
    onStopSubagent,
  });

  const sessionPermissions = useMemo(() => (
    isClaudeNativeRelay(snapshot) && session.transport === "claude-desktop-native"
      ? permissions.filter((permission) => permission.sessionId === session.sessionId)
      : []
  ), [permissions, session.sessionId, session.transport, snapshot]);
  const sessionQuestions = useMemo(
    () => sessionPermissions.filter((permission) => permission.toolName === "AskUserQuestion"),
    [sessionPermissions],
  );
  const toolPermissions = useMemo(
    () => sessionPermissions.filter((permission) => permission.toolName !== "AskUserQuestion"),
    [sessionPermissions],
  );
  const activePermission = toolPermissions[0];
  const alternateStageQuestion = hasAlternateStage ? sessionQuestions[0] : undefined;
  const waitingQuestion = alternateStageQuestion ?? (effectiveSessionView === "evidence" ? sessionQuestions[0] : undefined);
  const sessionNativePrompts = useMemo(
    () => snapshot?.prompts?.filter((prompt) => prompt.sessionId === session.sessionId) ?? [],
    [session.sessionId, snapshot?.prompts],
  );
  const activeNativePrompt = sessionNativePrompts.find((prompt) => prompt.promptId === selectedNativePromptId) ?? sessionNativePrompts[0];

  const otherNativePrompt = snapshot?.prompts?.find((prompt) => (
    prompt.sessionId !== session.sessionId && sessions.some((candidate) => candidate.sessionId === prompt.sessionId)
  ));
  const otherNativePromptSession = otherNativePrompt
    ? sessions.find((candidate) => candidate.sessionId === otherNativePrompt.sessionId)
    : undefined;
  const otherPermission = permissions.find((permission) => {
    if (permission.sessionId === session.sessionId) return false;
    const candidate = sessions.find((item) => item.sessionId === permission.sessionId);
    return Boolean(candidate && isClaudeNativeRelay(snapshot) && candidate.transport === "claude-desktop-native");
  });
  const otherPermissionSession = otherPermission
    ? sessions.find((candidate) => candidate.sessionId === otherPermission.sessionId)
    : undefined;

  const orphanUncertainDeliveries = useMemo(() => {
    const latest = new Map<string, BridgeEvent>();
    for (const event of events) {
      if (
        event.sessionId !== session.sessionId
        || event.type !== "message.delivery"
        || event.data.source === "assistant-trigger"
        || typeof event.data.commandId !== "string"
      ) continue;
      const previous = latest.get(event.data.commandId);
      if (!previous || event.seq > previous.seq) latest.set(event.data.commandId, event);
    }
    return [...latest.values()]
      .filter((event) => event.data.delivery === "uncertain")
      .filter((event) => !items.some((item) => (
        item.delivery === "uncertain" && item.commandId && item.commandId === event.data.commandId
      )));
  }, [events, items, session.sessionId]);

  const streamKeys = useMemo(() => [
    ...timelineStreamKeys,
    ...sessionQuestions.map((permission) => `question:${permission.requestId}`),
    ...orphanUncertainDeliveries.map((event) => `uncertain:${event.eventId}`),
  ], [orphanUncertainDeliveries, sessionQuestions, timelineStreamKeys]);

  useEffect(() => {
    if (!isMobile || !visible) return;
    const next = permissions.find((permission) => (
      permission.sessionId === session.sessionId
      && permission.toolName !== "AskUserQuestion"
      && !announcedPermissionsRef.current.has(permission.requestId)
    ));
    if (!next) return;
    announcedPermissionsRef.current.add(next.requestId);
    setPermissionOpen(true);
  }, [isMobile, permissions, session.sessionId, visible]);

  useEffect(() => {
    if (!isMobile || !visible) return;
    const next = snapshot?.prompts?.find((prompt) => (
      prompt.sessionId === session.sessionId && !announcedPermissionsRef.current.has(`prompt:${prompt.promptId}`)
    ));
    if (!next) return;
    announcedPermissionsRef.current.add(`prompt:${next.promptId}`);
    setPermissionOpen(true);
  }, [isMobile, session.sessionId, snapshot?.prompts, visible]);

  useEffect(() => {
    if (
      visible
      && effectivePermissionOpen
      && !alternateStageQuestion
      && !snapshot?.prompts?.some((prompt) => prompt.sessionId === session.sessionId)
      && !permissions.some((permission) => permission.sessionId === session.sessionId && permission.toolName !== "AskUserQuestion")
    ) {
      setPermissionOpen(false);
    }
  }, [alternateStageQuestion, effectivePermissionOpen, permissions, session.sessionId, snapshot?.prompts, visible]);

  useEffect(() => {
    if (!isMobile || !visible) return;
    const unregisterOverlays = registerMobileBackHandler(() => {
      if (contextPopoverOpen) {
        setContextPopoverOpen(false);
        return true;
      }
      if (effectivePermissionOpen) {
        setPermissionOpen(false);
        return true;
      }
      if (effectiveConfigurationOpen) {
        setConfigurationOpen(false);
        return true;
      }
      if (menu.closeOnBack()) return true;
      if (files.pendingPath) {
        files.closeDownload();
        return true;
      }
      if (tasks.stopSubagentTarget) {
        if (!tasks.subagentStopBusy) tasks.setStopSubagentTarget(undefined);
        return true;
      }
      if (tasks.backgroundTasksOpen) {
        tasks.setBackgroundTasksOpen(undefined);
        return true;
      }
      return false;
    }, 120);
    const unregisterView = registerMobileBackHandler(() => {
      if (effectiveSessionView === "evidence") {
        setSessionView("conversation");
        return true;
      }
      if (onBackToCatalog) {
        onBackToCatalog();
        return true;
      }
      return false;
    }, 100);
    return () => {
      unregisterOverlays();
      unregisterView();
    };
  }, [
    tasks.backgroundTasksOpen,
    contextPopoverOpen,
    effectiveConfigurationOpen,
    effectivePermissionOpen,
    effectiveSessionView,
    files.busy,
    isMobile,
    menu.closeOnBack,
    onBackToCatalog,
    files.pendingPath,
    tasks.stopSubagentTarget,
    tasks.subagentStopBusy,
    visible,
  ]);

  useLayoutEffect(() => {
    const textarea = composerRef.current;
    if (composerHidden || !textarea) return;
    const resize = () => {
      textarea.style.height = "auto";
      textarea.style.height = `${textarea.scrollHeight}px`;
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [draftKey, effectiveSessionView, composerHidden, text, visible]);

  const { streamRef, onScroll } = useConversationScroll({
    assistant: isAssistant,
    findingReply: Boolean(assistantReplyTarget),
    sessionId: session.sessionId,
    sessionView: isAssistant ? "conversation" : effectiveSessionView,
    streamVisible: visible && !transcriptHidden,
    history,
    openedEvidenceIds,
    inlineProposalLayout: JSON.stringify([
      [...(inlineProposals ?? [])].map(([itemId, { revision, state }]) => [itemId, revision, state]),
      items.filter(item => item.sessionProposalConfirmed || item.sentFiles?.length).map(item => item.id),
    ]),
    timelineStreamKeys,
    streamKeys,
    onLoadOlderHistory,
  });

  const replyPage = useRef<{ target: typeof assistantReplyTarget; cursor: string }>(undefined);
  useLayoutEffect(() => {
    if (!assistantReplyTarget || !visible || hasAlternateStage) return;
    if (effectiveSessionView === "evidence") { setSessionView("conversation"); return; }
    const { itemId, done } = assistantReplyTarget;
    const element = streamRef.current?.querySelector(`article[data-stream-key="${CSS.escape(itemId)}"]`);
    if (element) { element.scrollIntoView({ block: "center" }); done(); return; }
    if (!isOnline) { done("连接电脑后可查找回复。"); return; }
    if (!history || history.status === "loading") return;
    const cursor = history.nextCursor;
    if (!history.hasMore || !cursor) { done(history.error ?? "未找到这条回复。"); return; }
    if (replyPage.current?.target === assistantReplyTarget && replyPage.current.cursor === cursor) {
      done(history.error ?? "未能加载更早的对话。");
      return;
    }
    replyPage.current = { target: assistantReplyTarget, cursor };
    void onLoadOlderHistory(session.sessionId);
  }, [assistantReplyTarget, effectiveSessionView, hasAlternateStage, history, isOnline, onLoadOlderHistory, session.sessionId, setSessionView, streamKeys, streamRef, visible]);

  async function sendMessage(): Promise<void> {
    await sessionDraft.submitMessage({
      session,
      snapshot,
      canAttachImages,
      resolveMailRefId,
      executeCommand: commands.execute,
      sendTurn: (turnText, nextAttachments, mailRefId) => onSendTurn(
        session.sessionId,
        turnText,
        nextAttachments,
        ...(mailRefId ? [mailRefId] as const : []),
      ),
    });
  }

  async function sendQuickReply(promptId: string, promptText: string): Promise<void> {
    await sessionDraft.submitQuickReply({
      session,
      snapshot,
      promptId,
      promptText,
      resolveMailRefId,
      sendTurn: async (trimmedText, mailRefId) => {
        const receipt = await onSendTurn(
          session.sessionId,
          trimmedText,
          [],
          ...(mailRefId ? [mailRefId] as const : []),
        );
        return receipt?.requestId ?? null;
      },
    });
  }

  async function addImages(files: FileList | null): Promise<void> {
    await sessionDraft.addImages(files, fileRef.current);
  }

  const hasDraft = Boolean(text.trim()) || (canAttachImages && attachments.length > 0) || fileUploads.files.length > 0;

  const evidenceSourceKey = useMemo(() => {
    const bundlePart = (evidence?.items ?? [])
      .map((bundle) => `${bundle.id}:${bundle.state}:${bundle.completedAt ?? 0}:${bundle.artifactCount}:${bundle.artifacts.length}`)
      .join("|");
    const changePart = (fileChangesSummary?.files ?? [])
      .map((file) => `${file.path}:${file.kind}:${file.additions}:${file.deletions}`)
      .join("|");
    return `${draftKey}::${bundlePart}::${changePart}`;
  }, [draftKey, evidence?.items, fileChangesSummary]);
  const baseOutputFileCount = useMemo(
    () => countSessionOutputFiles({
      bundles: evidence?.items,
      conversationItems: items,
      fileChanges: fileChangesSummary,
      cwd: session.cwd,
    }),
    [evidence?.items, fileChangesSummary, items, session.cwd],
  );
  const evidenceCount = resolvedEvidenceFileCount?.sourceKey === evidenceSourceKey
    ? resolvedEvidenceFileCount.count
    : baseOutputFileCount;
  const latestTurnUsage = useMemo(
    () => [...(evidence?.items ?? [])]
      .sort((left, right) => (right.completedAt ?? right.startedAt) - (left.completedAt ?? left.startedAt))
      .find((bundle) => Boolean(bundle.usage))?.usage,
    [evidence?.items],
  );
  const canCompactContext = Boolean(
    onRunSessionCommand
    && runtimeId === "claude-desktop"
    && (!snapshot || snapshot.host.capabilities.includes("session.command.v1")),
  );
  const compactContextDisabled = !isOnline
    || Boolean(session.isCompacting)
    || session.turnState === "running"
    || session.turnState === "waiting";

  async function runCompactContext(): Promise<void> {
    if (!canCompactContext || compactBusy || compactContextDisabled) return;
    const targetKey = draftKey;
    setContextPopoverOpen(false);
    contextTriggerRef.current?.focus();
    setCompactBusy(true);
    menu.setError(undefined);
    try {
      await commands.execute("/compact", false);
    } catch (error) {
      if (previousDraftKeyRef.current === targetKey) {
        menu.setError(error instanceof Error ? error.message : "压缩上下文失败");
      }
    } finally {
      if (previousDraftKeyRef.current === targetKey) {
        setCompactBusy(false);
      }
    }
  }
  const parentSession = !isAssistant && session.parentSessionId
    ? sessions.find((candidate) => candidate.sessionId === session.parentSessionId)
    : undefined;
  const prSupported = !isAssistant && Boolean(snapshot?.host.capabilities.includes("pr.autofix.v1"));

  const renderSubagent = (item: ConversationItem) => (
    <SubagentCard
      item={item}
      key={item.id}
      entering={streamEntering(item.id)}
      collapsible={false}
      stopping={tasks.subagentStopBusy && tasks.stopSubagentTarget?.agentId === item.subagent!.agentId}
      {...(session.subagentStopScope === "process" && session.turnState === "running"
        ? { stopBlockedReason: "主对话运行中，需要先停止主对话" }
        : {})}
      {...(onStopSubagent && session.subagentStopScope ? {
        onStop: () => tasks.setStopSubagentTarget({
          sessionId: session.sessionId,
          agentId: item.subagent!.agentId,
          description: item.subagent!.description,
          scope: session.subagentStopScope!,
        }),
      } : {})}
      {...(onDownloadSessionFile ? { onFileClick: files.openFile } : {})}
    />
  );

  const streamBody = (
    <>
      {history?.hasMore && (
        <button
          type="button"
          className="load-older-button"
          disabled={history.status === "loading"}
          onClick={() => void onLoadOlderHistory(session.sessionId)}
        >
          {history.status === "loading" && <LoaderCircle className="is-spinning" size={15} />}
          {history.status === "loading" ? "正在分段加载更早消息…" : history.error ? "重试加载更早消息" : "加载更早消息"}
        </button>
      )}
      {history?.hasMore && history.error && (
        <div className="conversation-error-detail" role="alert">{history.error}</div>
      )}
      {history?.status === "loading" && history.items.length === 0 && (
        <div className="conversation-loading"><LoaderCircle className="is-spinning" size={20} />正在加载最新对话…</div>
      )}
      {history?.status === "error" && history.items.length === 0 && (
        <div className="conversation-empty">
          <strong>会话暂时无法读取</strong>
          {history.error && <span className="conversation-error-detail">{history.error}</span>}
          <button type="button" className="secondary-button" onClick={() => void onOpenSession(session.sessionId)}>重试</button>
        </div>
      )}
      {displayNodes.length === 0
        && sessionQuestions.length === 0
        && orphanUncertainDeliveries.length === 0
        && history?.status === "ready" && (!isAssistant || !history.hasMore) && (
          <div className="conversation-empty">
            <strong>{isAssistant ? "暂无对话" : "这是一个空会话"}</strong>
          </div>
        )}
      {displayNodes.map((node) => {
        if (node.kind === "proposal") {
          return <ProposalCard key={`proposal:${node.proposal.proposalId}`} proposal={node.proposal} mobile={isMobile} />;
        }
        if (node.kind === "mail") {
          return (
            <MailCard
              key={`mail:${node.card.mailRefId}`}
              card={node.card}
              compact
              {...(node.nativeMessage ? { nativeMessage: node.nativeMessage } : {})}
            />
          );
        }
        if (node.kind === "assistant-trigger-batch") {
          return <AssistantTriggerBatch key={`${hostId}:${session.sessionId}:${node.batchId}`} sessionId={session.sessionId}
            batchId={node.batchId} cards={node.cards} nativeMessage={node.nativeMessage} onCancel={onCancelQueuedTurn} />;
        }
        if (node.kind === "evidence") {
          return (
            <EvidenceInlineSummary
              evidence={node.evidence}
              key={`evidence:${node.evidence.id}`}
              entering={!openedEvidenceIds?.has(node.evidence.id) && streamEntering(`evidence:${node.evidence.id}`)}
              onOpen={() => setSessionView("evidence")}
            />
          );
        }
        if (node.kind === "tool-group") {
          return (
            <ConversationToolGroup
              key={toolGroupKeys.get(node.id) ?? node.id}
              {...(hostId ? { hostId } : {})}
              sessionId={session.sessionId}
              tools={node.tools}
              supportsToolDetail={Boolean(snapshot?.host.capabilities.includes("transcript.toolDetail.v1"))}
            />
          );
        }
        if (node.kind === "background-task") {
          const task = findBackgroundTask(tasks.backgroundTasks, node.item.subagent!);
          return (
            <BackgroundTaskMarker
              key={`${session.sessionId}:${node.id}`}
              item={node.item}
              {...(task ? { task } : {})}
              entering={streamEntering(node.item.id)}
              onOpen={() => tasks.setBackgroundTasksOpen({ focus: node.item })}
            />
          );
        }
        const item = node.item;
        if (item.sessionProposalConfirmed && item.sessionProposal && item.toolUseId) {
          return <SessionProposalCard key={item.id} itemId={item.id} proposal={item.sessionProposal}
            {...(hostId ? { hostId } : {})} sessionId={session.sessionId}
            toolUseId={item.toolUseId} toolName={item.toolName || "工具"} summary={item.text}
            supportsToolDetail={Boolean(snapshot?.host.capabilities.includes("transcript.toolDetail.v1"))} />;
        }
        if (item.sentFiles?.length && item.toolUseId) {
          return <SessionSentFiles key={item.id} item={{ ...item, sentFiles: item.sentFiles }} hostId={hostId} toolUseId={item.toolUseId}
            onOpenFile={onDownloadSessionFile ? files.openFile : undefined}
            supportsToolDetail={Boolean(snapshot?.host.capabilities.includes("transcript.toolDetail.v1"))} />;
        }
        if (item.sessionNotice) {
          return (
            <SessionNoticeCard
              key={item.id}
              itemId={item.id}
              notice={item.sessionNotice}
              source={item.text}
              entering={streamEntering(item.id)}
              {...(onDownloadSessionFile ? { onFileClick: files.openFile } : {})}
            />
          );
        }
        const peerMessages = session.transport === "claude-desktop-native"
          || session.transport === "claude-desktop-managed"
          || session.desktopHandoff?.state === "desktop-inbox";
        const pendingQuestion = item.interactivePrompt ? matchingQuestionPermission(
          item.interactivePrompt,
          sessionPermissions,
          item.interactivePrompt.toolUseId ?? (peerMessages ? "" : undefined),
        ) : undefined;
        const unavailableReason = peerMessages && item.interactivePrompt
          ? item.interactivePrompt.kind === "question" && !pendingQuestion ? "提问已不在待回答列表"
            : item.interactivePrompt.kind === "wrap-up" && item.interactivePrompt.blocked ? "需在电脑端确认" : undefined
          : undefined;
        const promptError = sessionDraft.promptError(item.id);
        const interactivePrompt = item.interactivePrompt && (!pendingQuestion || item.interactivePrompt.answered) ? (
          <InteractivePromptCard
            prompt={item.interactivePrompt}
            {...(item.replyDelivery ? { replyDelivery: item.replyDelivery } : {})}
            {...(item.replyPending ? { replyPending: true } : {})}
            canSend={canSendSession(session, snapshot)}
            busy={sending}
            {...(unavailableReason ? { unavailableReason } : {})}
            {...(promptError ? { error: promptError } : {})}
            onSelectOption={async (replyText) => {
              if (unavailableReason || sending) return;
              await sendQuickReply(item.id, replyText);
            }}
          />
        ) : undefined;
        return (
          <ConversationMessageItem
            key={item.id}
            item={item}
            session={session}
            entering={streamEntering(item.id)}
            latestMessage={node === latestMessage}
            visible={visible && !transcriptHidden && effectiveSessionView === "conversation"}
            revealActionsOnTap={isMobile}
            online={isOnline}
            canSend={canSendSession(session, snapshot)}
            queueAction={item.commandId ? queuedActions?.[item.commandId] : undefined}
            onSteerQueuedTurn={onSteerQueuedTurn}
            onCancelQueuedTurn={onCancelQueuedTurn}
            onQueueActionChange={(next) => {
              if (item.commandId) sessionDraft.setQueuedAction(item.commandId, next);
            }}
            rewindAvailable={rewindAvailable}
            rewindDisabled={rewindDisabled}
            onRewind={(messageId) => setRewindTarget({ sessionId: session.sessionId, messageId })}
            onResolveUncertain={onResolveUncertain}
            {...(onDownloadSessionFile ? { onFileClick: files.openFile } : {})}
            interactivePrompt={interactivePrompt}
          />
        );
      })}
      {sessionQuestions.map((permission) => (
        <article
          className="conversation-item assistant pending-question"
          key={`${draftKey}:${permission.requestId}`}
          data-stream-key={`question:${permission.requestId}`}
          aria-label="待回答"
        >
          <PermissionPrompt key={permission.requestId} permission={permission} onResolve={onResolvePermission} />
        </article>
      ))}
      {orphanUncertainDeliveries.map((event) => (
        <article
          className="conversation-item system uncertain-delivery"
          key={event.eventId}
          data-stream-key={`uncertain:${event.eventId}`}
        >
          <div className="conversation-item-meta"><strong>发送结果待确认</strong></div>
          <div className="conversation-text">{typeof event.data.error === "string" ? event.data.error : "Desktop 在确认消息前断开。"}</div>
          <div className="uncertain-delivery-actions">
            <button type="button" className="secondary-button" onClick={() => void onResolveUncertain(String(event.data.commandId), "confirm")}>确认已发送</button>
            <button type="button" className="secondary-button" onClick={() => void onResolveUncertain(String(event.data.commandId), "retry")}>检查后重发</button>
          </div>
        </article>
      ))}
    </>
  );

  const sharedDialogs = (
    <>
      {tasks.backgroundTasksOpen && (
        <BackgroundTasksSheet
          supportsToolDetail={Boolean(snapshot?.host.capabilities.includes("transcript.toolDetail.v1"))}
          sessionId={session.sessionId}
          tasks={tasks.backgroundTasks}
          items={items}
          {...(tasks.backgroundTasksOpen.focus ? { focus: tasks.backgroundTasksOpen.focus } : {})}
          renderSubagent={renderSubagent}
          onClose={() => tasks.setBackgroundTasksOpen(undefined)}
        />
      )}
      <ConfirmationDialog
        open={Boolean(tasks.stopSubagentTarget)}
        title={tasks.stopSubagentTarget?.scope === "process" ? "结束这个会话的 Claude 进程？" : "停止这个子代理？"}
        description={tasks.stopSubagentTarget?.scope === "process"
          ? `这台电脑没有开启 Claude Desktop 托管，无法单独停止「${tasks.stopSubagentTarget.description}」。确认后会结束这个会话在电脑上的 Claude 进程，这个会话的所有后台任务都会停止。对话记录会保留。`
          : `「${tasks.stopSubagentTarget?.description ?? ""}」会被停止，还没交回的结果不会再有。主对话不受影响。`}
        confirmLabel={tasks.stopSubagentTarget?.scope === "process" ? "结束进程" : "停止子代理"}
        danger
        busy={tasks.subagentStopBusy}
        onCancel={() => {
          if (!tasks.subagentStopBusy) tasks.setStopSubagentTarget(undefined);
        }}
        onConfirm={() => void tasks.stopSubagent()}
      />
      {files.dialog}
      {rewindAvailable && rewindTarget?.sessionId === session.sessionId && (
        <SessionRewindDialog
          key={`${draftKey}:${rewindTarget.messageId ?? "latest"}`}
          messages={items}
          {...(rewindTarget.messageId ? { initialMessageId: rewindTarget.messageId } : {})}
          disabled={rewindDisabled}
          onPreview={(messageId) => onPreviewRewind!(session.sessionId, messageId)}
          onRewind={(messageId, scope) => onRewindSession!(session.sessionId, messageId, scope)}
          onComplete={(result) => {
            sessionDraft.applyRewindPrefill(result);
            setRewindTarget(undefined);
          }}
          onClose={() => setRewindTarget(undefined)}
        />
      )}
      <SessionCommandDialogs
        key={`commands:${session.sessionId}`}
        result={commands.dialog}
        onClose={commands.close}
        onOpenSession={async (nextSessionId) => {
          await onSelectSession(nextSessionId);
        }}
        onLoadPermissions={() => onLoadSessionPermissions!(session.sessionId)}
        onSavePermissions={(mode, rules) => onSaveSessionPermissions!(session.sessionId, mode, rules)}
      />
      {effectiveConfigurationOpen && canConfigure && (
        <SessionConfigurationDialog
          key={`configuration:${session.sessionId}`}
          session={session}
          modelAndEffortOnly={internalConfiguration === "model-effort"}
          revision={events.filter((event) => (
            ((event.type === "session.configuration" || event.type === "session.compacted") && event.sessionId === session.sessionId)
            || (event.type === "permission.policy.changed" && (!event.sessionId || event.sessionId === session.sessionId))
          )).at(-1)?.seq ?? 0}
          onLoad={() => onLoadSessionConfiguration(session.sessionId)}
          onSave={(change) => onConfigureSession(session.sessionId, change)}
          onClose={() => setConfigurationOpen(false)}
        />
      )}
    </>
  );

  const transcript = (
    <section
      className={isMobile ? "conversation-stream" : "conversation-stream desktop-conversation-stream"}
      hidden={transcriptHidden}
      aria-live="polite"
      ref={streamRef}
      onScroll={onScroll}
    >
      {streamBody}
    </section>
  );
  const evidenceView = effectiveSessionView === "evidence" && (
    <section className={isMobile ? "mobile-evidence-view" : "mobile-evidence-view desktop-evidence-view"}>
      {isAssistant && (
        <button type="button" className="secondary-button" onClick={() => setSessionView("conversation")}>
          返回对话
        </button>
      )}
      {renderEvidence({
        variant,
        sessionId: session.sessionId,
        cwd: session.cwd,
        state: evidence,
        conversationItems: items,
        fileChanges: fileChangesSummary,
        online: isOnline,
        ...(onDownloadSessionFile ? { onRequestSessionFileDownload: files.requestDownload } : {}),
        onResolvedFileCountChange: (count) => {
          setResolvedEvidenceFileCount((previous) => (
            previous?.sourceKey === evidenceSourceKey && previous.count === count
              ? previous
              : { sourceKey: evidenceSourceKey, count }
          ));
        },
      })}
    </section>
  );

  const composer = (
    <>
      {composerBanner}
      {MobileComposer({
        variant,
        sessionView: isAssistant ? "conversation" : effectiveSessionView,
        selectedSession: session,
        snapshot,
        connection,
        desktopOnline,
        connectionIssue,
        runtimeName,
        draftKey,
        text,
        attachments,
        sending,
        imageError,
        canAttachImages,
        commandDraft,
        hasDraft,
        stopTarget: tasks.stopTarget,
        stopping: tasks.stopping,
        activity: tasks.activity,
        turnUsage: latestTurnUsage,
        contextPopoverOpen,
        onToggleContextPopover: () => setContextPopoverOpen((current) => !current),
        ...(canCompactContext ? { onCompactContext: () => void runCompactContext() } : {}),
        compactContextDisabled,
        compactContextBusy: compactBusy || Boolean(session.isCompacting),
        contextTriggerRef,
        contextPopoverRef,
        contextContainerRef,
        fileUploads,
        fileRef,
        composerRef,
        onUploadFile,
        onLoadSessionCommands,
        loadCommands: commands.load,
        updateDraft,
        addImages,
        sendMessage,
        onOpenStopConfirm: () => tasks.setStopConfirmOpen(true),
        onRetry: onRetry ?? (async () => {}),
      })}
    </>
  );
  const effectiveNavigation = isMobile && !isAssistant && navigation;
  const MobileRoot = effectiveNavigation ? "main" : "section";
  const profileSummaryId = `${variant}-session-profile-summary`;
  return (
    <MobileRoot className={`mobile-workspace conversation-workspace${isAssistant ? " conversation-workspace--assistant" : ""}`}>
      {!isAssistant && (
        <MobilePageHeader
          navigation={effectiveNavigation}
          {...(headerLeading ? { leading: headerLeading } : {})}
          title={session.title}
          subtitle={canConfigure ? (
            <button
              type="button"
              className="m-host-chip"
              aria-label="会话设置"
              aria-describedby={profileSummaryId}
              onClick={() => setConfigurationOpen(true)}
            >
              <SessionProfileSummary session={session} id={profileSummaryId} />
              <ChevronDown size={13} />
            </button>
          ) : (
            <span className="m-presence">
              <SessionProfileSummary session={session} />
            </span>
          )}
          {...(effectiveNavigation && onBackToCatalog ? {
            backLabel: effectiveSessionView === "evidence" ? "返回对话" : "返回会话列表",
            onBack: () => {
              if (effectiveSessionView === "evidence") setSessionView("conversation");
              else {
                setForkChainOpen(false);
                onBackToCatalog();
              }
            },
          } : {})}
          actions={(
            <>
              {isMobile ? (
                <button
                  type="button"
                  className={`mobile-evidence-toggle${effectiveSessionView === "evidence" ? " is-active" : ""}`}
                  aria-label={`成果${evidenceCount > 0 ? ` ${evidenceCount}` : ""}`}
                  aria-pressed={effectiveSessionView === "evidence"}
                  onClick={() => setSessionView(effectiveSessionView === "evidence" ? "conversation" : "evidence")}
                >
                  <FileText size={13} aria-hidden="true" />
                  <span className="mobile-evidence-word">成果</span>
                  {evidenceCount > 0 && <b className="mobile-evidence-count">{evidenceCount}</b>}
                </button>
              ) : (
                <nav className="session-view-switch desktop-session-view-switch" aria-label="会话视图">
                  <button
                    type="button"
                    className={effectiveSessionView === "conversation" ? "active" : ""}
                    onClick={() => setSessionView("conversation")}
                  >
                    对话
                  </button>
                  <button
                    type="button"
                    className={effectiveSessionView === "evidence" ? "active" : ""}
                    onClick={() => setSessionView("evidence")}
                  >
                    成果
                    {evidenceCount > 0 && <b>{evidenceCount}</b>}
                  </button>
                </nav>
              )}
              {tasks.backgroundTasks.length > 0 && (
                <IconButton
                  label={tasks.runningBackgroundTasks > 0 ? `后台任务，${tasks.runningBackgroundTasks} 个运行中` : "后台任务"}
                  className="background-tasks-button"
                  onClick={() => tasks.setBackgroundTasksOpen({})}
                >
                  <Layers size={18} />
                  {tasks.runningBackgroundTasks > 0 && <span className="background-tasks-count">{tasks.runningBackgroundTasks}</span>}
                </IconButton>
              )}
              <IconButton
                label="会话操作"
                onClick={menu.open}
              >
                <MoreHorizontal size={isMobile ? 22 : 18} />
              </IconButton>
            </>
          )}
        />
      )}
      {!isAssistant && session.prs?.length ? (
        <SessionPrBar
          key={`${hostId}:${session.sessionId}`}
          session={session}
          events={events}
          supported={prSupported}
          online={isNativeReady}
          {...(onReadPrAutoFix ? { onRead: onReadPrAutoFix } : {})}
          {...(onSetPrAutoFix ? { onSet: onSetPrAutoFix } : {})}
        />
      ) : null}
      {tasks.loadError && (
        <p className="session-channel-warning" role="alert">后台任务：{tasks.loadError}</p>
      )}
      {session.archivedAt && (
        <div className="session-channel-warning">
          <Archive size={17} />
          <span><strong>此会话已归档</strong>会话保留全部历史，取消归档后回到会话列表。</span>
        </div>
      )}
      {menu.error && (
        <div className="session-channel-warning danger">
          <AlertTriangle size={17} />
          <span><strong>会话操作失败</strong>{menu.error}</span>
        </div>
      )}
      {session.nativePermissionModeChange && session.nativePermissionModeChange.state !== "confirmed" && (
        <div className="session-channel-warning message-queue-status" role="status" aria-label="Desktop 会话授权变更">
          <ShieldCheck size={17} />
          <span>{session.nativePermissionModeChange.state === "requested"
            ? `已请求切换为「${PERMISSION_MODE_LABELS[session.nativePermissionModeChange.mode ?? "bypassPermissions"]}」，等待 Desktop 确认`
            : `Desktop 未切换为「${PERMISSION_MODE_LABELS[session.nativePermissionModeChange.mode ?? "bypassPermissions"]}」，后续请求仍需确认`}</span>
        </div>
      )}
      {showQueueBanner && (
        <div className="session-channel-warning message-queue-status" role="status" aria-label="消息排队状态">
          <LoaderCircle size={17} aria-hidden="true" />
          <span>{isOnline
            ? `${sessionQueueLabel(session)} · ${inlineQueuedIds.size ? "另有 " : ""}${missingQueuedCount} 条`
            : `上次同步时${inlineQueuedIds.size ? "另" : ""}有 ${missingQueuedCount} 条消息排队`}</span>
          {menu.canSync && (
            <button
              type="button"
              className="secondary-button"
              disabled={menu.refreshing || !isOnline}
              onClick={() => void menu.refresh()}
            >
              {menu.refreshing ? "同步中" : "同步状态"}
            </button>
          )}
        </div>
      )}
      {effectiveForkChainOpen && parentSession && (
        <ForkChainBar
          parentSession={parentSession}
          isSidechat={Boolean(session.sidechat)}
          onSelectSession={(nextSessionId) => {
            setForkChainOpen(false);
            void onSelectSession(nextSessionId);
          }}
          onClose={() => setForkChainOpen(false)}
        />
      )}
      <ConfirmationDialog
        open={tasks.stopConfirmOpen && Boolean(tasks.stopTarget)}
        title={tasks.stopTarget && tasks.stopTarget.sessionId !== session.sessionId ? "停止阻塞任务？" : "停止当前任务？"}
        description={`${tasks.stopTarget && tasks.stopTarget.sessionId !== session.sessionId ? `这个会话正在等待「${tasks.stopTarget.title}」。` : ""}${
          tasks.stopTarget?.turnState === "running" || tasks.stopTarget?.turnState === "waiting"
            ? "正在生成的回复会中断，已产生的对话记录会保留。"
            : "排在最前面的一条指令会被取消。"
        }`}
        confirmLabel="停止"
        danger
        busy={tasks.stopping}
        onCancel={() => tasks.setStopConfirmOpen(false)}
        onConfirm={() => {
          tasks.setStopConfirmOpen(false);
          if (tasks.stopTarget) void tasks.stopTask(tasks.stopTarget.sessionId);
        }}
      />
      {tasks.stopError && (
        <div className="session-channel-warning danger">
          <AlertTriangle size={17} />
          <span><strong>任务停止失败</strong>{tasks.stopError}</span>
        </div>
      )}
      {files.warning}
      {isAssistant ? (
        <div className="conversation-stage" style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
          {transcript}
          {(!transcriptHidden || processingVisible) && latestHistorySync && (latestHistorySync === "loading" ? (
            <div className="latest-history-notice session-channel-warning" role="status">
              <LoaderCircle className="is-spinning" size={15} aria-hidden="true" />正在同步最新对话…
            </div>
          ) : (
            <div className="latest-history-notice session-channel-warning danger">
              <AlertTriangle size={17} aria-hidden="true" />
              <span role="alert"><strong>最新对话同步失败</strong>{latestHistorySync.error}</span>
              <button type="button" className="secondary-button" disabled={!isOnline || history?.status === "loading"} onClick={() => void latestHistorySync.retry()}>重试同步</button>
              <IconButton label="关闭同步提示" onClick={latestHistorySync.dismiss}><X size={16} aria-hidden="true" /></IconButton>
            </div>
          ))}
          {processing && assistantTimeline && <AssistantProcessing batches={assistantTimeline.batches} history={history}
            sessionId={session.sessionId} hostId={hostId} visible={processingVisible} onDiscuss={processing.onDiscuss} onCancel={onCancelQueuedTurn}
            onLoadOlder={onLoadOlderHistory} supportsToolDetail={Boolean(snapshot?.host.capabilities.includes("transcript.toolDetail.v1"))} />}
          {alternateStage ? (
            <div className="conversation-alternate-stage" style={{ flex: 1, overflowY: "auto" }}>
              {alternateStage(canConfigure && isOnline ? () => setInternalConfiguration("model-effort") : undefined)}
            </div>
          ) : !processingVisible && evidenceView}
        </div>
      ) : effectiveSessionView === "conversation" ? transcript : evidenceView}
      <div className={`permission-dock-slot ${activePermission || activeNativePrompt || otherPermission || otherNativePrompt || waitingQuestion ? "has-attention" : ""}`}>
        {activePermission ? (
          <button type="button" className="permission-dock" onClick={() => setPermissionOpen(true)}>
            <span className="permission-dock-icon"><AlertTriangle size={18} /></span>
            <span><strong>{runtimeName} 正在等待授权</strong><small>{activePermission.title || activePermission.displayName || activePermission.toolName}</small></span>
            <b>{toolPermissions.length > 1 ? `${toolPermissions.length} 项` : "处理"}</b>
          </button>
        ) : activeNativePrompt ? (
          <button type="button" className="permission-dock" onClick={() => setPermissionOpen(true)}>
            <span className="permission-dock-icon"><AlertTriangle size={18} /></span>
            <span><strong>{runtimeName} 正在等待确认</strong><small>{activeNativePrompt.title}</small></span>
            <b>{sessionNativePrompts.length > 1 ? `${sessionNativePrompts.length} 项` : "处理"}</b>
          </button>
        ) : waitingQuestion ? (
          <button type="button" className="permission-dock" onClick={() => {
            if (alternateStageQuestion) setPermissionOpen(true);
            else setSessionView("conversation");
          }}>
            <span className="permission-dock-icon"><AlertTriangle size={18} /></span>
            <span><strong>{runtimeName} 正在等待回答</strong><small>{waitingQuestion.title || "提问与选择"}</small></span>
            <b>回答</b>
          </button>
        ) : otherPermission && otherPermissionSession ? (
          <button type="button" className="permission-dock" onClick={() => void onSelectSession(otherPermission.sessionId)}>
            <span className="permission-dock-icon"><AlertTriangle size={18} /></span>
            <span><strong>另一会话{otherPermission.toolName === "AskUserQuestion" ? "待回答" : "待授权"}</strong><small>{otherPermissionSession.title}</small></span>
            <b>前往</b>
          </button>
        ) : otherNativePrompt && otherNativePromptSession ? (
          <button type="button" className="permission-dock" onClick={() => void onSelectSession(otherNativePrompt.sessionId)}>
            <span className="permission-dock-icon"><AlertTriangle size={18} /></span>
            <span><strong>另一会话待确认</strong><small>{otherNativePromptSession.title}</small></span>
            <b>前往</b>
          </button>
        ) : null}
      </div>
      {isAssistant ? (
        <div className="conversation-composer-slot" hidden={composerHidden} style={{ flexShrink: 0 }}>
          {composer}
        </div>
      ) : composer}
      {(!isAssistant || visible) && effectivePermissionOpen && (activePermission || activeNativePrompt || alternateStageQuestion) && (
        <Sheet
          manageFocus={!isMobile}
          eyebrow="需要处理"
          title={`${runtimeName} ${activePermission ? "等待授权" : activeNativePrompt ? "等待确认" : "等待回答"}`}
          closeLabel="暂时关闭"
          onClose={() => setPermissionOpen(false)}
        >
          {toolPermissions.length > 1 && <div className="permission-queue-count">还有 {toolPermissions.length} 项待授权，提交后自动显示下一项。</div>}
          {activePermission ? (
            <PermissionPrompt
              key={activePermission.requestId}
              permission={activePermission}
              onResolve={onResolvePermission}
              onEnableNativeFullAccess={(requestId) => onResolvePermission(requestId, "allow-once", undefined, undefined, "bypassPermissions")}
            />
          ) : activeNativePrompt ? (
            <>
              {sessionNativePrompts.length > 1 && (
                <SelectMenu
                  className="native-prompt-selector"
                  ariaLabel="待处理提示"
                  value={activeNativePrompt.promptId}
                  options={sessionNativePrompts.map((prompt) => ({
                    value: prompt.promptId,
                    label: prompt.title,
                  }))}
                  onChange={setSelectedNativePromptId}
                />
              )}
              <NativePromptCard
                key={activeNativePrompt.promptId}
                prompt={activeNativePrompt}
                online={isNativeReady}
                {...(onResolvePrompt && snapshot?.host.capabilities.includes("prompt.native.v1") ? { onResolve: onResolvePrompt } : {})}
              />
            </>
          ) : alternateStageQuestion && (
            <PermissionPrompt key={alternateStageQuestion.requestId} permission={alternateStageQuestion} onResolve={onResolvePermission} />
          )}
        </Sheet>
      )}
      {/* The assistant surface has no ⋯ menu; it still uses the shared /rename dialog. */}
      {menu.renderSheets({
        sessionView: effectiveSessionView,
        evidenceCount,
        parentSession,
        onToggleView: () => setSessionView(effectiveSessionView === "evidence" ? "conversation" : "evidence"),
        onConfigure: canConfigure ? () => setConfigurationOpen(true) : undefined,
        prSupported,
        events,
        isNativeReady,
        onReadPrAutoFix,
        onSetPrAutoFix,
      })}
      {sharedDialogs}
    </MobileRoot>
  );
}
