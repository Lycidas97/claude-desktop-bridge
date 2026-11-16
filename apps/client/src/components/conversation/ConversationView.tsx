import type {
  BridgeArtifactManifest,
  BridgeArtifactPreview,
  BridgeAttachment,
  BridgeBackgroundTask,
  BridgeEvidenceDetailPage,
  BridgeEvent,
  BridgeHostSnapshot,
  BridgeMailCard,
  BridgeNativePermissionMode,
  BridgePermissionInfo,
  BridgePermissionRules,
  BridgePrAutoFixState,
  BridgePrAutoFixUpdate,
  BridgeProjectInfo,
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
  ArchiveRestore,
  Check,
  ChevronDown,
  CornerUpLeft,
  FilePenLine,
  FileText,
  Folder,
  FolderOpen,
  GitFork,
  Layers,
  LoaderCircle,
  MessageSquare,
  MoreHorizontal,
  PackageCheck,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  isClaudeNativeRelay,
  type LocalTurn,
  type MobileConnectionIssue,
  type SessionEvidenceState,
  type SessionHistoryState,
} from "../../hooks/useMobileBridge.js";
import { useSessionCommands } from "../../hooks/useSessionCommands.js";
import {
  aggregateFileChanges,
  canConfigureSession,
  canSendSession,
  conciseModelName,
  conversationItems,
  conversationTimeline,
  groupTimelineTools,
  runtimeSupports,
  stoppableBridgeTask,
  type ConversationItem,
} from "../../lib/conversation-timeline.js";
import type { UploadFileHandler } from "../../lib/file-upload.js";
import { mediaKind } from "../../lib/media-preview.js";
import { registerMobileBackHandler } from "../../lib/mobile-back-navigation.js";
import { desktopRuntimeId, desktopRuntimeName } from "../../lib/runtime-labels.js";
import { sessionActivity, sessionQueueLabel } from "../../lib/session-activity.js";
import { useStreamEntrance } from "../../lib/stream-entrance.js";
import { MailCard } from "../assistant/MailCard.js";
import { ConfirmationDialog } from "../common/ConfirmationDialog.js";
import { IconButton } from "../common/IconButton.js";
import { Sheet, SheetAction } from "../common/Sheet.js";
import { EvidenceInlineSummary, EvidencePanel } from "../evidence/EvidencePanel.js";
import { countSessionOutputFiles } from "../evidence/FileChangesCard.js";
import { useMediaPreview } from "../evidence/MediaPreviewProvider.js";
import { MobileComposer } from "../mobile/MobileComposer.js";
import { MobilePageHeader } from "../mobile/MobilePageHeader.js";
import {
  SessionConfigurationDialog,
  type SessionConfigurationChange,
} from "../session/SessionConfigurationDialog.js";
import { SessionProfileSummary } from "../session/SessionProfileSummary.js";
import { BackgroundTaskMarker, BackgroundTasksSheet, findBackgroundTask } from "./BackgroundTasks.js";
import { useConversationDrafts } from "./ConversationDraftsProvider.js";

type ConversationDraftsValue = ReturnType<typeof useConversationDrafts>;
import { ConversationMessageItem } from "./ConversationMessageItem.js";
import { ConversationToolGroup } from "./ConversationToolGroup.js";
import { ForkChainBar } from "./ForkChainBar.js";
import { NativePromptCard } from "./NativePromptCard.js";
import {
  InteractivePromptCard,
  matchingQuestionPermission,
  NATIVE_MODE_LABELS,
  PermissionPrompt,
} from "./PermissionPrompts.js";
import { SessionCommandDialogs } from "./SessionCommandDialogs.js";
import { SessionNoticeCard } from "./SessionNoticeCard.js";
import { SessionPrActions, SessionPrBar } from "./SessionPrBar.js";
import { SessionRewindDialog } from "./SessionRewindDialog.js";
import { SubagentCard } from "./SubagentCard.js";

export interface ConversationViewProps {
  variant?: "mobile" | "desktop" | undefined;
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
  onOpenSessionMenu?: (() => void) | undefined;
  onRequestRename?: ((session: BridgeSessionInfo) => void) | undefined;
  onRenameSession?: ((sessionId: string, title: string) => Promise<void>) | undefined;
  refreshing?: boolean | undefined;
  onRefresh?: ((sessionId?: string) => Promise<unknown>) | undefined;
  onRetry?: (() => Promise<void>) | undefined;
  history: SessionHistoryState | undefined;
  evidence: SessionEvidenceState | undefined;
  artifactPreviews: Record<string, BridgeArtifactPreview>;
  artifactTransfers: Record<string, number>;
  permissions: BridgePermissionInfo[];
  events: BridgeEvent[];
  localTurns?: LocalTurn[] | undefined;
  connectionIssue?: MobileConnectionIssue | undefined;
  mailCards?: BridgeMailCard[] | undefined;
  composerBanner?: ReactNode;
  resolveMailRefId?: (() => string | undefined) | undefined;
  onOpenSession(sessionId: string): Promise<void>;
  onLoadOlderHistory(sessionId: string): Promise<void>;
  onLoadOlderEvidence(sessionId: string): Promise<void>;
  onLoadEvidenceDetails?: ((evidenceId: string, kind: "tools" | "artifacts", cursor?: string) => Promise<BridgeEvidenceDetailPage>) | undefined;
  onPreviewArtifact(artifactId: string): Promise<BridgeArtifactPreview>;
  onDownloadArtifact(artifact: BridgeArtifactManifest): Promise<void>;
  onDownloadSessionFile?: ((sessionId: string, filePath: string) => Promise<void>) | undefined;
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
  onForkSession?: ((sessionId: string) => Promise<BridgeSessionInfo | void | undefined>) | undefined;
  onMoveSessionSection?: ((
    sessionId: string,
    sectionId: string | null,
  ) => Promise<{ session?: BridgeSessionInfo; projects?: BridgeProjectInfo[] } | void>) | undefined;
  onArchiveSession?: ((sessionId: string, archived: boolean) => Promise<void>) | undefined;
  onDeleteSession?: ((sessionId: string) => Promise<void>) | undefined;
  sessionActionBusy?: boolean | undefined;
  sessionActionError?: string | undefined;
  onSessionActionBusyChange?: ((busy: boolean) => void) | undefined;
}

export function ConversationView({
  variant = "mobile",
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
  onOpenSessionMenu,
  onRequestRename,
  onRenameSession,
  refreshing = false,
  onRefresh,
  onRetry,
  history,
  evidence,
  artifactPreviews,
  artifactTransfers,
  permissions,
  events,
  localTurns = [],
  connectionIssue,
  mailCards = [],
  composerBanner,
  resolveMailRefId,
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
  onForkSession,
  onMoveSessionSection,
  onArchiveSession,
  onDeleteSession,
  sessionActionBusy: controlledActionBusy,
  sessionActionError,
  onSessionActionBusyChange,
}: ConversationViewProps) {
  const isMobile = variant === "mobile";
  const openMedia = useMediaPreview();
  const fallbackDrafts = useConversationDrafts(hostId);
  const conversationDrafts = externalDrafts ?? fallbackDrafts;
  const sessionDraft = conversationDrafts.session(hostId, session.sessionId, onUploadFile);
  const { draftKey, draft, promptReplies: sessionPromptReplies, queuedActions, fileUploads, updateDraft } = sessionDraft;
  const { text, attachments, sending, imageError } = draft;

  const [internalSessionView, setInternalSessionView] = useState<"conversation" | "evidence">("conversation");
  const [internalForkChainOpen, setInternalForkChainOpen] = useState(
    () => Boolean(session.parentSessionId),
  );
  const [internalPermissionOpen, setInternalPermissionOpen] = useState(false);
  const [internalConfigurationOpen, setInternalConfigurationOpen] = useState(false);
  const [internalActionBusy, setInternalActionBusy] = useState(false);
  const [internalActionError, setInternalActionError] = useState<string>();
  const [internalMenuOpen, setInternalMenuOpen] = useState(false);
  const [moveMenuOpen, setMoveMenuOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameTitle, setRenameTitle] = useState("");
  const [internalRefreshing, setInternalRefreshing] = useState(false);
  const [syncCheckTick, setSyncCheckTick] = useState(0);
  const [syncFlash, setSyncFlash] = useState(false);
  const [rewindTarget, setRewindTarget] = useState<{ sessionId: string; messageId?: string }>();
  const [stoppingSessionId, setStoppingSessionId] = useState<string>();
  const [stopError, setStopError] = useState<string>();
  const [stopConfirmOpen, setStopConfirmOpen] = useState(false);
  const [stopSubagentTarget, setStopSubagentTarget] = useState<{
    sessionId: string;
    agentId: string;
    description: string;
    scope: "task" | "process";
  }>();
  const [subagentStopBusy, setSubagentStopBusy] = useState(false);
  const [backgroundTasksOpen, setBackgroundTasksOpen] = useState<{ focus?: ConversationItem }>();
  const [backgroundTaskDetails, setBackgroundTaskDetails] = useState<{
    key: string;
    tasks: BridgeBackgroundTask[] | undefined;
    error?: string;
  }>();
  const [selectedNativePromptId, setSelectedNativePromptId] = useState<string>();
  const [pendingFileDownload, setPendingFileDownload] = useState<string>();
  const [fileDownloadBusy, setFileDownloadBusy] = useState(false);
  const [fileDownloadError, setFileDownloadError] = useState<string>();
  const [deleteSessionOpen, setDeleteSessionOpen] = useState(false);
  const [contextPopoverOpen, setContextPopoverOpen] = useState(false);
  const [compactBusy, setCompactBusy] = useState(false);
  const [resolvedEvidenceFileCount, setResolvedEvidenceFileCount] = useState<{
    sourceKey: string;
    count: number;
  }>();

  const streamRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const contextTriggerRef = useRef<HTMLButtonElement>(null);
  const contextPopoverRef = useRef<HTMLDivElement>(null);
  const contextContainerRef = useRef<HTMLDivElement>(null);
  const announcedPermissionsRef = useRef(new Set<string>());
  const autoRetriedSessionRef = useRef<string | undefined>(undefined);
  const syncPendingKeyRef = useRef<string | undefined>(undefined);
  const previousDraftKeyRef = useRef(draftKey);

  const effectiveSessionView = controlledSessionView ?? internalSessionView;
  function setSessionView(next: "conversation" | "evidence"): void {
    if (onSessionViewChange) onSessionViewChange(next);
    else setInternalSessionView(next);
  }
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
  const effectiveConfigurationOpen = controlledConfigurationOpen ?? internalConfigurationOpen;
  function setConfigurationOpen(next: boolean): void {
    if (onConfigurationOpenChange) onConfigurationOpenChange(next);
    else setInternalConfigurationOpen(next);
  }
  const effectiveActionBusy = controlledActionBusy ?? internalActionBusy;
  function setActionBusy(next: boolean): void {
    if (onSessionActionBusyChange) onSessionActionBusyChange(next);
    else setInternalActionBusy(next);
  }

  useEffect(() => {
    if (previousDraftKeyRef.current === draftKey) return;
    previousDraftKeyRef.current = draftKey;
    setInternalSessionView("conversation");
    setInternalPermissionOpen(false);
    setInternalConfigurationOpen(false);
    setInternalForkChainOpen(Boolean(session.parentSessionId));
    setBackgroundTasksOpen(undefined);
    setStopSubagentTarget(undefined);
    setPendingFileDownload(undefined);
    setFileDownloadError(undefined);
    setStopError(undefined);
    setStopConfirmOpen(false);
    setDeleteSessionOpen(false);
    setContextPopoverOpen(false);
    setCompactBusy(false);
    setResolvedEvidenceFileCount(undefined);
    setInternalMenuOpen(false);
    setMoveMenuOpen(false);
    setRenameOpen(false);
    setInternalActionError(undefined);
    syncPendingKeyRef.current = undefined;
    setInternalRefreshing(false);
    setSyncFlash(false);
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

  useEffect(() => {
    if (internalRefreshing || syncPendingKeyRef.current !== draftKey) return;
    if (history?.status === "loading") return;
    syncPendingKeyRef.current = undefined;
    if (history?.status === "error") {
      setInternalActionError(history.error ?? "同步会话失败");
    } else {
      setSyncFlash(true);
    }
  }, [draftKey, history?.error, history?.status, internalRefreshing, syncCheckTick]);

  useEffect(() => {
    if (!syncFlash) return;
    const timer = setTimeout(() => setSyncFlash(false), 2_400);
    return () => clearTimeout(timer);
  }, [syncFlash]);

  const runtimeId = desktopRuntimeId(session);
  const runtimeName = desktopRuntimeName(runtimeId);
  const isOnline = isMobile ? connection === "connected" && desktopOnline : desktopOnline;
  const isNativeReady = nativeReady ?? (connection === "connected" && desktopOnline);
  const effectiveActionError = sessionActionError ?? internalActionError;

  const commands = useSessionCommands({
    sessionId: session.sessionId,
    sessionKey: draftKey,
    enabled: runtimeId === "claude-desktop",
    supported: Boolean(snapshot?.host.capabilities.includes("session.command.v1")),
    onLoad: onLoadSessionCommands && runtimeId === "claude-desktop" && snapshot?.host.capabilities.includes("session.commands.v1")
      ? () => onLoadSessionCommands(session.sessionId)
      : undefined,
    onRun: onRunSessionCommand ? (value) => onRunSessionCommand(session.sessionId, value) : undefined,
    onModel: () => setConfigurationOpen(true),
    onRewind: () => setRewindTarget({ sessionId: session.sessionId }),
    ...(onRequestRename
      ? { onRename: () => onRequestRename(session) }
      : (onRenameSession || onRunSessionCommand)
        ? {
            onRename: () => {
              setRenameTitle(session.title);
              setInternalActionError(undefined);
              setRenameOpen(true);
            },
          }
        : {}),
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
    session.transport === "claude-desktop-native"
    && snapshot?.host.capabilities.includes("session.rewind.v1")
    && onPreviewRewind
    && onRewindSession,
  );
  const rewindDisabled = isMobile
    ? connection !== "connected" || !desktopOnline
    : session.turnState === "running" || session.turnState === "waiting" || Boolean(session.pendingCount);

  const taskHistoryReady = history?.status === "ready" || Boolean(history?.items.length);
  useEffect(() => {
    if (
      !onLoadBackgroundTasks
      || !visible
      || effectiveSessionView !== "conversation"
      || !isNativeReady
      || runtimeId !== "claude-desktop"
      || !taskHistoryReady
    ) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const tasks = await onLoadBackgroundTasks(session.sessionId);
        if (active) setBackgroundTaskDetails({ key: draftKey, tasks });
      } catch (error) {
        if (active) {
          setBackgroundTaskDetails((current) => ({
            key: draftKey,
            tasks: current && current.key === draftKey ? current.tasks : undefined,
            error: error instanceof Error ? error.message : String(error),
          }));
        }
      }
      if (active) timer = setTimeout(() => void refresh(), 2_000);
    };
    void refresh();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [
    draftKey,
    effectiveSessionView,
    isNativeReady,
    onLoadBackgroundTasks,
    runtimeId,
    session.sessionId,
    taskHistoryReady,
    visible,
  ]);

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
  const timeline = useMemo(
    () => conversationTimeline(items, evidence?.items ?? [], mailCards),
    [evidence?.items, items, mailCards],
  );
  const displayNodes = useMemo(() => groupTimelineTools(timeline), [timeline]);

  const toolGroupKeysRef = useRef<{ sessionId?: string | undefined; byToolId: Map<string, string> }>({ byToolId: new Map() });
  const toolGroupKeys = useMemo(() => {
    if (toolGroupKeysRef.current.sessionId !== session.sessionId || displayNodes.length === 0) {
      toolGroupKeysRef.current = { sessionId: session.sessionId, byToolId: new Map() };
    }
    const { byToolId } = toolGroupKeysRef.current;
    const keys = new Map<string, string>();
    for (const node of displayNodes) {
      if (node.kind !== "tool-group") continue;
      const stableKey = node.tools.map((tool) => byToolId.get(tool.id)).find(Boolean) ?? node.id;
      for (const tool of node.tools) byToolId.set(tool.id, stableKey);
      keys.set(node.id, stableKey);
    }
    return keys;
  }, [displayNodes, session.sessionId]);

  const timelineStreamKeys = useMemo(() => timeline.map((entry) => (
    entry.kind === "evidence"
      ? `evidence:${entry.evidence.id}`
      : entry.kind === "mail"
        ? `mail:${entry.card.mailRefId}`
        : entry.item.id
  )), [timeline]);
  const streamEntering = useStreamEntrance(session.sessionId, timelineStreamKeys);

  const selectedTaskDetails = backgroundTaskDetails?.key === draftKey ? backgroundTaskDetails : undefined;
  const activityTasks = selectedTaskDetails?.tasks ?? session.backgroundTasks;
  const activity = useMemo(() => sessionActivity(
    session,
    selectedTaskDetails?.error ? items.map((item) => {
      const subagent = item.subagent;
      if (subagent?.state !== "running") return item;
      const task = findBackgroundTask(activityTasks, subagent);
      return task && task.state !== "running"
        && (!subagent.workflowRunId || task.workflow?.agents.some((agent) => agent.agentId === subagent.agentId))
        ? { ...item, subagent: { ...subagent, state: task.state } }
        : item;
    }) : items,
    selectedTaskDetails?.error ? undefined : activityTasks,
  ), [activityTasks, items, selectedTaskDetails?.error, session]);

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
      && !snapshot?.prompts?.some((prompt) => prompt.sessionId === session.sessionId)
      && !permissions.some((permission) => permission.sessionId === session.sessionId && permission.toolName !== "AskUserQuestion")
    ) {
      setPermissionOpen(false);
    }
  }, [effectivePermissionOpen, permissions, session.sessionId, snapshot?.prompts, visible]);

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
      if (!onOpenSessionMenu && renameOpen) {
        if (!effectiveActionBusy) {
          setRenameOpen(false);
          setInternalMenuOpen(false);
        }
        return true;
      }
      if (!onOpenSessionMenu && deleteSessionOpen) {
        if (!effectiveActionBusy) setDeleteSessionOpen(false);
        return true;
      }
      if (!onOpenSessionMenu && internalMenuOpen) {
        if (!effectiveActionBusy) {
          if (moveMenuOpen) setMoveMenuOpen(false);
          else setInternalMenuOpen(false);
        }
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
      if (backgroundTasksOpen) {
        setBackgroundTasksOpen(undefined);
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
    backgroundTasksOpen,
    contextPopoverOpen,
    deleteSessionOpen,
    effectiveActionBusy,
    effectiveConfigurationOpen,
    effectivePermissionOpen,
    effectiveSessionView,
    fileDownloadBusy,
    internalMenuOpen,
    isMobile,
    moveMenuOpen,
    onBackToCatalog,
    onOpenSessionMenu,
    pendingFileDownload,
    renameOpen,
    stopSubagentTarget,
    subagentStopBusy,
    visible,
  ]);

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
  }, [draftKey, effectiveSessionView, text, visible]);

  const firstHistoryKey = history?.items[0]?.id;
  const historyCount = history?.items.length ?? 0;
  const streamScrollState = useRef<{
    sessionId?: string | undefined;
    firstKey?: string | undefined;
    firstHistoryKey?: string | undefined;
    historyCount: number;
    lastKey?: string | undefined;
    anchorKey?: string | undefined;
    anchorOffset: number;
    scrollTop?: number | undefined;
    pinnedToBottom: boolean;
  }>({ historyCount: 0, anchorOffset: 0, pinnedToBottom: true });

  function rememberStreamPosition(updateFollow = false): void {
    const stream = streamRef.current;
    if (!stream) return;
    const top = stream.getBoundingClientRect().top;
    const anchor = [...stream.querySelectorAll<HTMLElement>(":scope > [data-stream-key]")]
      .find((element) => element.getBoundingClientRect().bottom > top);
    streamScrollState.current = {
      ...streamScrollState.current,
      anchorKey: anchor?.dataset.streamKey,
      anchorOffset: anchor ? anchor.getBoundingClientRect().top - top : 0,
      scrollTop: stream.scrollTop,
      pinnedToBottom: updateFollow
        ? stream.scrollHeight - stream.scrollTop - stream.clientHeight <= 4
        : streamScrollState.current.pinnedToBottom,
    };
  }

  useLayoutEffect(() => {
    const stream = streamRef.current;
    if (!stream) {
      streamScrollState.current = { historyCount: 0, anchorOffset: 0, pinnedToBottom: true };
      return;
    }
    const previous = streamScrollState.current;
    const firstKey = timelineStreamKeys[0];
    const lastKey = streamKeys.at(-1);
    const entering = previous.sessionId !== session.sessionId || !previous.lastKey;
    const scrolledUpSynchronously = (
      previous.scrollTop !== undefined
      && stream.scrollTop < previous.scrollTop - 4
      && stream.scrollHeight - stream.scrollTop - stream.clientHeight > 4
    );
    const shouldFollowBottom = scrolledUpSynchronously ? false : previous.pinnedToBottom;
    const historyPrepended = (
      firstHistoryKey !== undefined
      && previous.firstHistoryKey !== undefined
      && firstHistoryKey !== previous.firstHistoryKey
      && historyCount > previous.historyCount
    );
    if (entering) {
      stream.scrollTop = stream.scrollHeight;
    } else if ((firstKey !== previous.firstKey || historyPrepended) && previous.anchorKey) {
      const anchor = [...stream.querySelectorAll<HTMLElement>(":scope > [data-stream-key]")]
        .find((element) => element.dataset.streamKey === previous.anchorKey);
      if (anchor) {
        stream.scrollTop += anchor.getBoundingClientRect().top - stream.getBoundingClientRect().top - previous.anchorOffset;
      } else if (shouldFollowBottom) {
        stream.scrollTop = stream.scrollHeight;
      }
    } else if (shouldFollowBottom) {
      stream.scrollTop = stream.scrollHeight;
    }
    streamScrollState.current = {
      ...previous,
      sessionId: session.sessionId,
      firstKey,
      firstHistoryKey,
      historyCount,
      lastKey,
      pinnedToBottom: entering || shouldFollowBottom,
    };
    rememberStreamPosition();
  }, [effectiveSessionView, firstHistoryKey, historyCount, session.sessionId, streamKeys, timelineStreamKeys]);

  function loadOlderNearTop(): void {
    const stream = streamRef.current;
    if (!stream || !history?.hasMore || !history.nextCursor || history.status !== "ready" || history.error) return;
    if (stream.scrollTop < 200) void onLoadOlderHistory(session.sessionId);
  }

  useEffect(() => {
    if (effectiveSessionView === "conversation") loadOlderNearTop();
  }, [effectiveSessionView, firstHistoryKey, history?.nextCursor, session.sessionId, timelineStreamKeys[0]]);

  function openSessionFile(filePath: string): void {
    const kind = mediaKind(filePath);
    if (kind) {
      openMedia({
        name: filePath.split(/[\\/]/u).at(-1) || filePath,
        kind,
        sessionId: session.sessionId,
        path: filePath,
      });
      return;
    }
    setFileDownloadError(undefined);
    setPendingFileDownload(filePath);
  }

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

  async function stopTask(targetSessionId: string): Promise<void> {
    if (stoppingSessionId) return;
    setStoppingSessionId(targetSessionId);
    setStopError(undefined);
    try {
      await onInterruptTurn(targetSessionId);
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

  async function addImages(files: FileList | null): Promise<void> {
    await sessionDraft.addImages(files, fileRef.current);
  }

  const selectedBusy = session.pendingCount > 0
    || session.turnState === "running"
    || session.turnState === "queued"
    || session.turnState === "waiting";
  const stopTarget = selectedBusy ? stoppableBridgeTask(sessions, session.sessionId) : undefined;
  const stopping = Boolean(stopTarget && stoppingSessionId === stopTarget.sessionId);
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
    setInternalActionError(undefined);
    try {
      await commands.execute("/compact", false);
    } catch (error) {
      if (previousDraftKeyRef.current === targetKey) {
        setInternalActionError(error instanceof Error ? error.message : "压缩上下文失败");
      }
    } finally {
      if (previousDraftKeyRef.current === targetKey) {
        setCompactBusy(false);
      }
    }
  }
  const parentSession = session.parentSessionId
    ? sessions.find((candidate) => candidate.sessionId === session.parentSessionId)
    : undefined;
  const backgroundTasks = activityTasks ?? [];
  const runningBackgroundTasks = backgroundTasks.filter((task) => task.state === "running").length;
  const prSupported = Boolean(snapshot?.host.capabilities.includes("pr.autofix.v1"));
  const visibilityAvailable = Boolean(snapshot?.host.capabilities.includes("session.visibility.v1"));

  const renderSubagent = (item: ConversationItem) => (
    <SubagentCard
      item={item}
      key={item.id}
      entering={streamEntering(item.id)}
      collapsible={false}
      stopping={subagentStopBusy && stopSubagentTarget?.agentId === item.subagent!.agentId}
      {...(session.subagentStopScope === "process" && session.turnState === "running"
        ? { stopBlockedReason: "主对话运行中，需要先停止主对话" }
        : {})}
      {...(onStopSubagent && session.subagentStopScope ? {
        onStop: () => setStopSubagentTarget({
          sessionId: session.sessionId,
          agentId: item.subagent!.agentId,
          description: item.subagent!.description,
          scope: session.subagentStopScope!,
        }),
      } : {})}
      {...(onDownloadSessionFile ? { onFileClick: openSessionFile } : {})}
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
        && history?.status === "ready" && (
          <div className="conversation-empty">
            <strong>这是一个空会话</strong>
            <span>从下方发出第一条指令。</span>
          </div>
        )}
      {displayNodes.map((node) => {
        if (node.kind === "mail") {
          return (
            <MailCard
              key={`mail:${node.card.mailRefId}`}
              card={node.card}
              {...(node.nativeMessage ? { nativeMessage: node.nativeMessage } : {})}
            />
          );
        }
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
          const task = findBackgroundTask(backgroundTasks, node.item.subagent!);
          return (
            <BackgroundTaskMarker
              key={`${session.sessionId}:${node.id}`}
              item={node.item}
              {...(task ? { task } : {})}
              entering={streamEntering(node.item.id)}
              onOpen={() => setBackgroundTasksOpen({ focus: node.item })}
            />
          );
        }
        const item = node.item;
        if (item.sessionNotice) {
          return (
            <SessionNoticeCard
              key={item.id}
              itemId={item.id}
              notice={item.sessionNotice}
              source={item.text}
              entering={streamEntering(item.id)}
              {...(onDownloadSessionFile ? { onFileClick: openSessionFile } : {})}
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
            {...(onDownloadSessionFile ? { onFileClick: openSessionFile } : {})}
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

  const evidenceBody = (
    <EvidencePanel
      variant={variant}
      sessionId={session.sessionId}
      cwd={session.cwd}
      state={evidence}
      conversationItems={items}
      fileChanges={fileChangesSummary}
      previews={artifactPreviews}
      transfers={artifactTransfers}
      online={isOnline}
      onLoadMore={() => onLoadOlderEvidence(session.sessionId)}
      {...(onLoadEvidenceDetails ? { onLoadDetails: onLoadEvidenceDetails } : {})}
      onPreview={onPreviewArtifact}
      onDownload={onDownloadArtifact}
      {...(onDownloadSessionFile
        ? {
            onRequestSessionFileDownload: (filePath) => {
              setFileDownloadError(undefined);
              setPendingFileDownload(filePath);
            },
          }
        : {})}
      onResolvedFileCountChange={(count) => {
        setResolvedEvidenceFileCount((previous) => (
          previous?.sourceKey === evidenceSourceKey && previous.count === count
            ? previous
            : { sourceKey: evidenceSourceKey, count }
        ));
      }}
    />
  );

  const sharedDialogs = (
    <>
      {backgroundTasksOpen && (
        <BackgroundTasksSheet
          supportsToolDetail={Boolean(snapshot?.host.capabilities.includes("transcript.toolDetail.v1"))}
          sessionId={session.sessionId}
          tasks={backgroundTasks}
          items={items}
          {...(backgroundTasksOpen.focus ? { focus: backgroundTasksOpen.focus } : {})}
          renderSubagent={renderSubagent}
          onClose={() => setBackgroundTasksOpen(undefined)}
        />
      )}
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
      <ConfirmationDialog
        open={Boolean(pendingFileDownload)}
        title={isMobile ? "确认下载远程文件到手机？" : "确认下载工作区文件？"}
        description={pendingFileDownload
          ? (isMobile
              ? `即将从电脑工作区下载「${pendingFileDownload.split(/[\\/]/u).at(-1) || pendingFileDownload}」（${pendingFileDownload}）到手机端，是否继续？`
              : `即将从工作区下载「${pendingFileDownload.split(/[\\/]/u).at(-1) || pendingFileDownload}」（${pendingFileDownload}），是否继续？`)
          : ""}
        confirmLabel="确认下载"
        busy={fileDownloadBusy}
        onCancel={() => {
          if (!fileDownloadBusy) setPendingFileDownload(undefined);
        }}
        onConfirm={() => {
          if (!pendingFileDownload || !onDownloadSessionFile || fileDownloadBusy) return;
          const targetSessionId = session.sessionId;
          const targetPath = pendingFileDownload;
          setFileDownloadBusy(true);
          setFileDownloadError(undefined);
          void onDownloadSessionFile(targetSessionId, targetPath)
            .then(() => {
              setPendingFileDownload(undefined);
            })
            .catch((downloadError) => {
              setPendingFileDownload(undefined);
              setFileDownloadError(
                downloadError instanceof Error
                  ? downloadError.message
                  : isMobile ? "远程文件下载失败" : "文件下载失败",
              );
            })
            .finally(() => {
              setFileDownloadBusy(false);
            });
        }}
      />
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
        session={session}
        result={commands.dialog}
        onClose={commands.close}
        onOpenSession={async (nextSessionId) => {
          await onSelectSession(nextSessionId);
        }}
        {...(!onRequestRename && onRenameSession ? {
          onRename: (title) => onRenameSession(session.sessionId, title),
        } : {})}
        onLoadPermissions={() => onLoadSessionPermissions!(session.sessionId)}
        onSavePermissions={(mode, rules) => onSaveSessionPermissions!(session.sessionId, mode, rules)}
      />
      {effectiveConfigurationOpen && canConfigure && (
        <SessionConfigurationDialog
          key={`configuration:${session.sessionId}`}
          session={session}
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

  const effectiveNavigation = isMobile ? navigation : false;
  const MobileRoot = effectiveNavigation ? "main" : "section";
  const profileSummaryId = `${variant}-session-profile-summary`;
  const manualSections = (snapshot?.projects ?? []).filter((project) => project.kind === "desktop-group");
  const currentMenuSection = manualSections.find((project) => project.projectId === session.projectId);
  const menuSupportsMoveSection = Boolean(
    onMoveSessionSection
    && snapshot?.host.capabilities.includes("section.move.v1")
    && session.allowedActions?.canMoveSection,
  );
  const menuSupportsRename = Boolean(
    onRenameSession
      ? (
          !snapshot
          || snapshot.host.capabilities.includes("session.rename.v1")
          || (snapshot.host.capabilities.includes("session.command.v1") && runtimeId === "claude-desktop")
        )
      : (
          onRunSessionCommand
          && snapshot?.host.capabilities.includes("session.command.v1")
          && runtimeId === "claude-desktop"
        ),
  );
  const renameCanSave = Boolean(renameTitle.trim() && renameTitle.trim() !== session.title && !effectiveActionBusy);
  const menuSupportsFork = Boolean(onForkSession && runtimeId === "claude-desktop");
  const menuSupportsVisibility = isMobile || visibilityAvailable;
  const menuSessionBusy = session.turnState === "running" || session.turnState === "queued" || session.turnState === "waiting";
  const canSyncSession = Boolean(onRefresh || !isMobile);
  const effectiveRefreshing = refreshing || internalRefreshing;
  const renameDialogRef = useRef<HTMLElement>(null);
  const menuOpenerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!renameOpen || typeof document === "undefined") return;
    const dialog = renameDialogRef.current;
    return () => {
      const opener = menuOpenerRef.current;
      const active = document.activeElement;
      const focusReleased = !active || active === document.body || active === document.documentElement || Boolean(dialog?.contains(active));
      if (opener && opener.isConnected && focusReleased) {
        opener.focus();
      }
    };
  }, [renameOpen]);

  useEffect(() => {
    if (!renameOpen || !effectiveActionBusy) return;
    renameDialogRef.current?.focus();
  }, [renameOpen, effectiveActionBusy]);

  function closeInternalRename(): void {
    if (effectiveActionBusy) return;
    setRenameOpen(false);
    setInternalMenuOpen(false);
  }

  async function runInternalRename(): Promise<void> {
    if (!renameCanSave || (!onRenameSession && !onRunSessionCommand)) return;
    setActionBusy(true);
    setInternalActionError(undefined);
    try {
      if (onRenameSession) {
        await onRenameSession(session.sessionId, renameTitle.trim());
      } else {
        await onRunSessionCommand!(session.sessionId, `/rename ${renameTitle.trim()}`);
      }
      setRenameOpen(false);
      setInternalMenuOpen(false);
    } catch (error) {
      setInternalActionError(error instanceof Error ? error.message : "重命名会话失败");
    } finally {
      setActionBusy(false);
    }
  }

  async function runInternalMoveSection(sectionId: string | null): Promise<void> {
    if (!onMoveSessionSection || effectiveActionBusy || !isOnline) return;
    setActionBusy(true);
    setInternalActionError(undefined);
    try {
      await onMoveSessionSection(session.sessionId, sectionId);
      setMoveMenuOpen(false);
      setInternalMenuOpen(false);
    } catch (error) {
      setInternalActionError(error instanceof Error ? error.message : "移动分组失败");
    } finally {
      setActionBusy(false);
    }
  }

  async function runInternalRefresh(): Promise<void> {
    if (!canSyncSession || effectiveRefreshing || effectiveActionBusy) return;
    const targetKey = draftKey;
    setInternalRefreshing(true);
    setInternalActionError(undefined);
    setSyncFlash(false);
    if (!onRefresh) syncPendingKeyRef.current = targetKey;
    try {
      if (onRefresh) {
        if (await onRefresh(session.sessionId)) {
          if (previousDraftKeyRef.current === targetKey) setSyncFlash(true);
        }
      } else {
        await onOpenSession(session.sessionId);
      }
    } catch (error) {
      if (syncPendingKeyRef.current === targetKey) syncPendingKeyRef.current = undefined;
      if (previousDraftKeyRef.current === targetKey) {
        setInternalActionError(error instanceof Error ? error.message : "同步会话失败");
      }
    } finally {
      if (previousDraftKeyRef.current === targetKey) {
        setInternalRefreshing(false);
        setSyncCheckTick((value) => value + 1);
      }
    }
  }

  async function runInternalFork(): Promise<void> {
    if (!onForkSession || effectiveActionBusy) return;
    setActionBusy(true);
    setInternalActionError(undefined);
    try {
      const created = await onForkSession(session.sessionId);
      setInternalMenuOpen(false);
      if (created && typeof created === "object" && "sessionId" in created) {
        await onSelectSession(created.sessionId);
      }
    } catch (error) {
      setInternalActionError(error instanceof Error ? error.message : "Fork 分支创建失败");
    } finally {
      setActionBusy(false);
    }
  }

  async function runInternalArchive(archived: boolean): Promise<void> {
    if (!onArchiveSession || effectiveActionBusy) return;
    setActionBusy(true);
    setInternalActionError(undefined);
    try {
      await onArchiveSession(session.sessionId, archived);
      setInternalMenuOpen(false);
    } catch (error) {
      setInternalActionError(error instanceof Error ? error.message : "归档设置失败");
    } finally {
      setActionBusy(false);
    }
  }

  async function runInternalDelete(): Promise<void> {
    if (!onDeleteSession || effectiveActionBusy) return;
    setActionBusy(true);
    setInternalActionError(undefined);
    try {
      await onDeleteSession(session.sessionId);
      setDeleteSessionOpen(false);
      setInternalMenuOpen(false);
    } catch (error) {
      setInternalActionError(error instanceof Error ? error.message : "删除会话失败");
    } finally {
      setActionBusy(false);
    }
  }

  return (
    <MobileRoot className="mobile-workspace conversation-workspace">
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
                aria-pressed={effectiveSessionView === "evidence"}
                onClick={() => setSessionView(effectiveSessionView === "evidence" ? "conversation" : "evidence")}
              >
                <FileText size={13} aria-hidden="true" />
                <span>成果{evidenceCount > 0 ? ` ${evidenceCount}` : ""}</span>
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
            {backgroundTasks.length > 0 && (
              <IconButton
                label={runningBackgroundTasks > 0 ? `后台任务，${runningBackgroundTasks} 个运行中` : "后台任务"}
                className="background-tasks-button"
                onClick={() => setBackgroundTasksOpen({})}
              >
                <Layers size={18} />
                {runningBackgroundTasks > 0 && <span className="background-tasks-count">{runningBackgroundTasks}</span>}
              </IconButton>
            )}
            <IconButton
              label="会话操作"
              onClick={() => {
                if (onOpenSessionMenu) {
                  onOpenSessionMenu();
                } else {
                  if (typeof document !== "undefined" && document.activeElement instanceof HTMLElement) {
                    menuOpenerRef.current = document.activeElement;
                  }
                  setInternalActionError(undefined);
                  setMoveMenuOpen(false);
                  setInternalMenuOpen(true);
                }
              }}
            >
              <MoreHorizontal size={isMobile ? 22 : 18} />
            </IconButton>
          </>
        )}
      />
      {session.prs?.length ? (
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
      {selectedTaskDetails?.error && (
        <p className="session-channel-warning" role="alert">后台任务：{selectedTaskDetails.error}</p>
      )}
      {session.archivedAt && (
        <div className="session-channel-warning">
          <Archive size={17} />
          <span><strong>此会话已归档</strong>会话保留全部历史，取消归档后回到会话列表。</span>
        </div>
      )}
      {effectiveActionError && !internalMenuOpen && !renameOpen && (
        <div className="session-channel-warning danger">
          <AlertTriangle size={17} />
          <span><strong>会话操作失败</strong>{effectiveActionError}</span>
        </div>
      )}
      {session.nativePermissionModeChange && session.nativePermissionModeChange.state !== "confirmed" && (
        <div className="session-channel-warning message-queue-status" role="status" aria-label="Desktop 会话授权变更">
          <ShieldCheck size={17} />
          <span>{session.nativePermissionModeChange.state === "requested"
            ? `已请求切换为「${NATIVE_MODE_LABELS[session.nativePermissionModeChange.mode ?? "bypassPermissions"]}」，等待 Desktop 确认`
            : `Desktop 未切换为「${NATIVE_MODE_LABELS[session.nativePermissionModeChange.mode ?? "bypassPermissions"]}」，后续请求仍需确认`}</span>
        </div>
      )}
      {session.pendingCount > 0 && session.desktopHandoff?.state !== "close-desktop" && session.desktopHandoff?.state !== "desktop-inbox" && (
        <div className="session-channel-warning message-queue-status" role="status" aria-label="消息排队状态">
          <LoaderCircle size={17} />
          <span>
            <strong>{isOnline ? sessionQueueLabel(session) : "连接已断开，等待同步状态"}</strong>
            {isOnline
              ? `${session.pendingCount} 条消息已到电脑，轮到后会自动执行，无需重复发送。`
              : `上次同步时有 ${session.pendingCount} 条消息排队，当前进度尚未确认。`}
          </span>
          {canSyncSession && (
            <button
              type="button"
              className="secondary-button"
              disabled={effectiveRefreshing || !isOnline}
              onClick={() => void runInternalRefresh()}
            >
              {effectiveRefreshing ? "同步中" : "同步状态"}
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
        open={stopConfirmOpen && Boolean(stopTarget)}
        title={stopTarget && stopTarget.sessionId !== session.sessionId ? "停止阻塞任务？" : "停止当前任务？"}
        description={`${stopTarget && stopTarget.sessionId !== session.sessionId ? `这个会话正在等待「${stopTarget.title}」。` : ""}${
          stopTarget?.turnState === "running" || stopTarget?.turnState === "waiting"
            ? "正在生成的回复会中断，已产生的对话记录会保留。"
            : "排在最前面的一条指令会被取消。"
        }`}
        confirmLabel="停止"
        danger
        busy={stopping}
        onCancel={() => setStopConfirmOpen(false)}
        onConfirm={() => {
          setStopConfirmOpen(false);
          if (stopTarget) void stopTask(stopTarget.sessionId);
        }}
      />
      {stopError && (
        <div className="session-channel-warning danger">
          <AlertTriangle size={17} />
          <span><strong>任务停止失败</strong>{stopError}</span>
        </div>
      )}
      {fileDownloadError && (
        <div className="session-channel-warning danger" role="alert">
          <AlertTriangle size={17} />
          <span><strong>文件下载失败</strong>{fileDownloadError}</span>
          <button type="button" className="secondary-button goal-action" onClick={() => setFileDownloadError(undefined)}>关闭</button>
        </div>
      )}
      {effectiveSessionView === "conversation" ? (
        <section
          className={isMobile ? "conversation-stream" : "conversation-stream desktop-conversation-stream"}
          aria-live="polite"
          ref={streamRef}
          onScroll={() => {
            rememberStreamPosition(true);
            loadOlderNearTop();
          }}
        >
          {streamBody}
        </section>
      ) : (
        <section className={isMobile ? "mobile-evidence-view" : "mobile-evidence-view desktop-evidence-view"}>{evidenceBody}</section>
      )}
      <div className={`permission-dock-slot ${activePermission || activeNativePrompt || otherPermission || otherNativePrompt || (effectiveSessionView === "evidence" && sessionQuestions.length) ? "has-attention" : ""}`}>
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
        ) : effectiveSessionView === "evidence" && sessionQuestions[0] ? (
          <button type="button" className="permission-dock" onClick={() => setSessionView("conversation")}>
            <span className="permission-dock-icon"><AlertTriangle size={18} /></span>
            <span><strong>{runtimeName} 正在等待回答</strong><small>{sessionQuestions[0].title || "提问与选择"}</small></span>
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
      {composerBanner}
      {MobileComposer({
        variant,
        sessionView: effectiveSessionView,
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
        stopTarget,
        stopping,
        activity,
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
        onOpenStopConfirm: () => setStopConfirmOpen(true),
        onRetry: onRetry ?? (async () => {}),
      })}
      {effectivePermissionOpen && (activePermission || activeNativePrompt) && (
        <Sheet
          manageFocus={!isMobile}
          eyebrow="需要处理"
          title={`${runtimeName} ${activePermission ? "等待授权" : "等待确认"}`}
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
          ) : activeNativePrompt && (
            <>
              {sessionNativePrompts.length > 1 && (
                <select
                  className="native-prompt-selector"
                  aria-label="待处理提示"
                  value={activeNativePrompt.promptId}
                  onChange={(event) => setSelectedNativePromptId(event.target.value)}
                >
                  {sessionNativePrompts.map((prompt) => (
                    <option key={prompt.promptId} value={prompt.promptId}>{prompt.title}</option>
                  ))}
                </select>
              )}
              <NativePromptCard
                key={activeNativePrompt.promptId}
                prompt={activeNativePrompt}
                online={isNativeReady}
                {...(onResolvePrompt && snapshot?.host.capabilities.includes("prompt.native.v1") ? { onResolve: onResolvePrompt } : {})}
              />
            </>
          )}
        </Sheet>
      )}
      {!onOpenSessionMenu && internalMenuOpen && !renameOpen && (
        <Sheet
          manageFocus
          focusPaused={deleteSessionOpen || renameOpen}
          eyebrow={moveMenuOpen ? session.title : `${session.projectName} · ${runtimeName}`}
          title={moveMenuOpen ? "移动到分组" : session.title}
          busy={effectiveActionBusy}
          onClose={() => {
            setMoveMenuOpen(false);
            setInternalMenuOpen(false);
          }}
          {...(moveMenuOpen ? {
            footer: (
              <button
                type="button"
                className="secondary-button"
                disabled={effectiveActionBusy}
                onClick={() => {
                  setInternalActionError(undefined);
                  setMoveMenuOpen(false);
                }}
              >
                返回
              </button>
            ),
          } : {})}
        >
          {moveMenuOpen ? (
            <>
              {manualSections.length > 0 && (
                <div className="m-group">
                  {manualSections.map((section) => {
                    const isCurrent = currentMenuSection?.projectId === section.projectId;
                    return (
                      <SheetAction
                        key={section.projectId}
                        icon={isCurrent ? <Check size={19} /> : <Folder size={19} />}
                        label={section.name}
                        detail={isCurrent ? "当前所在分组" : undefined}
                        disabled={effectiveActionBusy || !isOnline || isCurrent}
                        onClick={() => void runInternalMoveSection(section.projectId)}
                      />
                    );
                  })}
                </div>
              )}
              {currentMenuSection && (
                <div className="m-group">
                  <SheetAction
                    icon={<FolderOpen size={19} />}
                    label="移出分组"
                    disabled={effectiveActionBusy || !isOnline}
                    onClick={() => void runInternalMoveSection(null)}
                  />
                </div>
              )}
            </>
          ) : (
            <>
              <div className="m-group">
                <SheetAction
                  icon={effectiveSessionView === "evidence" ? <MessageSquare size={19} /> : <PackageCheck size={19} />}
                  label={effectiveSessionView === "evidence" ? "返回对话" : `成果${evidenceCount > 0 ? ` ${evidenceCount}` : ""}`}
                  disabled={effectiveActionBusy}
                  detail={effectiveSessionView === "evidence" ? "回到对话记录" : "文件变更、产物与图片"}
                  onClick={() => {
                    setSessionView(effectiveSessionView === "evidence" ? "conversation" : "evidence");
                    setInternalMenuOpen(false);
                  }}
                />
                {parentSession && (
                  <SheetAction
                    icon={session.sidechat ? <CornerUpLeft size={19} /> : <GitFork size={19} />}
                    label="主会话"
                    disabled={effectiveActionBusy}
                    detail={`来自：${parentSession.title}`}
                    onClick={() => {
                      setInternalMenuOpen(false);
                      void onSelectSession(parentSession.sessionId);
                    }}
                  />
                )}
              </div>
              <div className="m-group">
                {menuSupportsRename && (
                  <SheetAction
                    icon={<FilePenLine size={19} />}
                    label="重命名"
                    disabled={effectiveActionBusy}
                    onClick={() => {
                      setRenameTitle(session.title);
                      setInternalActionError(undefined);
                      setRenameOpen(true);
                    }}
                  />
                )}
                {menuSupportsMoveSection && (
                  <SheetAction
                    icon={<Folder size={19} />}
                    label="移动到分组"
                    detail={currentMenuSection ? currentMenuSection.name : manualSections.length > 0 ? "未分组" : "暂无可用分组"}
                    disabled={effectiveActionBusy || !isOnline || (!currentMenuSection && manualSections.length === 0)}
                    onClick={() => {
                      setInternalActionError(undefined);
                      setMoveMenuOpen(true);
                    }}
                  />
                )}
                {canConfigure && (
                  <SheetAction
                    icon={<Settings2 size={19} />}
                    label="会话设置"
                    detail={conciseModelName(session)}
                    disabled={effectiveActionBusy}
                    onClick={() => {
                      setConfigurationOpen(true);
                      setInternalMenuOpen(false);
                    }}
                  />
                )}
                {canSyncSession && (
                  <SheetAction
                    icon={effectiveRefreshing ? <LoaderCircle className="is-spinning" size={19} /> : syncFlash ? <Check size={19} /> : <RefreshCw size={19} />}
                    label={effectiveRefreshing ? "正在同步" : syncFlash ? "已同步" : "同步此会话"}
                    detail="重新读取电脑端的最新记录"
                    disabled={effectiveActionBusy || effectiveRefreshing || (!onRefresh && !isOnline)}
                    onClick={() => void runInternalRefresh()}
                  />
                )}
              </div>
              {!session.prs?.length && prSupported && (
                <div className="m-group">
                  <SessionPrActions
                    key={`${hostId}:${session.sessionId}`}
                    session={session}
                    events={events}
                    onWriteBusyChange={setActionBusy}
                    supported
                    online={isNativeReady}
                    {...(onReadPrAutoFix ? { onRead: onReadPrAutoFix } : {})}
                    {...(onSetPrAutoFix ? { onSet: onSetPrAutoFix } : {})}
                  />
                </div>
              )}
              {menuSupportsFork && (
                <div className="m-group">
                  <SheetAction
                    icon={<GitFork size={19} />}
                    label="Fork 分支"
                    detail="复制完整对话为独立会话，原会话不变"
                    disabled={effectiveActionBusy}
                    onClick={() => void runInternalFork()}
                  />
                </div>
              )}
              {menuSupportsVisibility && (onArchiveSession || onDeleteSession) && (
                <div className="m-group">
                  {onArchiveSession && (
                    <SheetAction
                      icon={session.archivedAt ? <ArchiveRestore size={19} /> : <Archive size={19} />}
                      label={session.archivedAt ? "恢复会话" : "归档会话"}
                      detail={session.archivedAt ? "放回所属项目" : "从列表收起，历史保留"}
                      disabled={effectiveActionBusy}
                      onClick={() => void runInternalArchive(!session.archivedAt)}
                    />
                  )}
                  {onDeleteSession && (
                    <SheetAction
                      icon={<Trash2 size={19} />}
                      label="删除会话"
                      detail={menuSessionBusy
                        ? "任务进行中，先停止再删除"
                        : session.transport === "claude-desktop-native" ? "删除 Claude Desktop 中的会话" : "仅从 Bridge 移除，Desktop 原会话保留"}
                      danger
                      disabled={effectiveActionBusy || menuSessionBusy}
                      onClick={() => setDeleteSessionOpen(true)}
                    />
                  )}
                </div>
              )}
            </>
          )}
          {effectiveActionBusy && <p className="m-sheet-note" role="status"><LoaderCircle className="is-spinning" size={15} />正在处理…</p>}
          {effectiveActionError && <p className="m-sheet-note is-error" role="alert">{effectiveActionError}</p>}
        </Sheet>
      )}
      {!onOpenSessionMenu && renameOpen && (
        <div
          className="modal-backdrop session-create-backdrop"
          role="presentation"
          onMouseDown={(event) => { if (event.target === event.currentTarget) closeInternalRename(); }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              closeInternalRename();
              return;
            }
            if (event.key === "Tab" && renameDialogRef.current) {
              const focusables = [...renameDialogRef.current.querySelectorAll<HTMLElement>(
                'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
              )];
              if (focusables.length === 0) {
                event.preventDefault();
                renameDialogRef.current.focus();
                return;
              }
              const first = focusables[0]!;
              const last = focusables[focusables.length - 1]!;
              const active = typeof document !== "undefined" ? document.activeElement : null;
              if (event.shiftKey && (active === first || !renameDialogRef.current.contains(active))) {
                event.preventDefault();
                last.focus();
              } else if (!event.shiftKey && (active === last || !renameDialogRef.current.contains(active))) {
                event.preventDefault();
                first.focus();
              }
            }
          }}
        >
          <section
            ref={renameDialogRef}
            className="create-session-dialog session-create-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="重命名会话"
            tabIndex={-1}
          >
            <header className="session-create-header"><h2>重命名会话</h2></header>
            <form onSubmit={(event) => { event.preventDefault(); void runInternalRename(); }}>
              <div className="session-create-body">
                <label>
                  <span>会话名称</span>
                  <input
                    value={renameTitle}
                    autoFocus
                    required
                    disabled={effectiveActionBusy}
                    onFocus={(event) => event.target.select()}
                    onChange={(event) => setRenameTitle(event.target.value)}
                  />
                </label>
                {effectiveActionError && <p className="session-create-error" role="alert">{effectiveActionError}</p>}
              </div>
              <footer className="dialog-actions session-create-actions">
                <button type="button" className="secondary-button" disabled={effectiveActionBusy} onClick={closeInternalRename}>取消</button>
                <button type="submit" className="primary-button" disabled={!renameCanSave}>{effectiveActionBusy ? "正在保存…" : "保存"}</button>
              </footer>
            </form>
          </section>
        </div>
      )}
      {!onOpenSessionMenu && menuSupportsVisibility && onDeleteSession && (
        <ConfirmationDialog
          open={deleteSessionOpen}
          title="删除会话"
          description={session.transport === "claude-desktop-native"
            ? `从 Claude Desktop 中删除「${session.title}」会话及其对话记录？此操作不可恢复。`
            : `从 Bridge 列表中删除「${session.title}」？对应 Desktop 应用中的原生会话与文件不受影响；Bridge 中的会话配置、排队与授权记录会被清除，此操作不可恢复。`}
          confirmLabel="删除会话"
          danger
          busy={effectiveActionBusy}
          onCancel={() => setDeleteSessionOpen(false)}
          onConfirm={() => void runInternalDelete()}
        />
      )}
      {sharedDialogs}
    </MobileRoot>
  );
}
