import { isClaudeNativeRelay } from "../hooks/useMobileBridge.js";
import type {
  BridgeAttachment,
  BridgeBackgroundTask,
  BridgeArtifactManifest,
  BridgeArtifactPreview,
  BridgeDesktopRuntimeId,
  BridgeDirectoryListing,
  BridgeEvidenceDetailPage,
  BridgeEvent,
  BridgeHostSnapshot,
  BridgeNativePermissionMode,
  BridgePermissionInfo,
  BridgePrAutoFixState,
  BridgePrAutoFixUpdate,
  BridgePullRequest,
  BridgeProjectInfo,
  BridgeSessionCommandResult,
  BridgeSessionRewindPreview,
  BridgeSessionRewindResult,
  BridgeSessionRewindScope,
  BridgeSessionPermissions,
  BridgeSDKPermissionMode,
  BridgePermissionRules,
  BridgeSessionConfiguration,
  BridgeSessionInfo,
  BridgeSlashCommandCatalog,
  BridgeTransportMetrics,
  BridgeDesktopAppStatus,
  SocketState,
} from "@bridge/protocol";
import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  Check,
  ChevronDown,
  FilePenLine,
  Folder,
  FolderOpen,
  GitFork,
  Layers,
  LoaderCircle,
  MessageSquare,
  MoreHorizontal,
  PackageCheck,
  RefreshCw,
  Send,
  Settings2,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  LocalTurn,
  MobileConnectionIssue,
  SessionEvidenceState,
  SessionHistoryState,
} from "../hooks/useMobileBridge.js";
import type { ThemeControl } from "../hooks/useTheme.js";
import {
  aggregateFileChanges,
  canConfigureSession,
  canSendSession,
  conciseModelName,
  conversationItems,
  conversationTimeline,
  fileToAttachment,
  groupTimelineTools,
  ownershipLabel,
  relativeTime,
  restorableSessionId,
  runtimeSupports,
  stoppableBridgeTask,
  type ConversationItem,
} from "../lib/conversation-timeline.js";
import {
  expandProject,
  getSessionAncestorIds,
  orderProjects,
  sortProjectSessionsByRecent,
  toggleCollapsedProject,
} from "../lib/project-groups.js";
import { registerMobileBackHandler } from "../lib/mobile-back-navigation.js";
import { desktopRuntimeId, desktopRuntimeName } from "../lib/runtime-labels.js";
import { useStreamEntrance } from "../lib/stream-entrance.js";
import { sessionActivity, sessionQueueLabel } from "../lib/session-activity.js";
import { BackgroundTaskMarker, BackgroundTasksSheet, findBackgroundTask } from "./conversation/BackgroundTasks.js";
import { ConversationMessageItem, type QueuedTurnActionState } from "./conversation/ConversationMessageItem.js";
import { ConversationToolGroup } from "./conversation/ConversationToolGroup.js";
import { ForkChainBar } from "./conversation/ForkChainBar.js";
import {
  InteractivePromptCard,
  matchingQuestionPermission,
  NATIVE_MODE_LABELS,
  PermissionPrompt,
} from "./conversation/PermissionPrompts.js";
import { SubagentCard } from "./conversation/SubagentCard.js";
import { NativePromptCard } from "./conversation/NativePromptCard.js";
import { SessionPrActions, SessionPrBar } from "./conversation/SessionPrBar.js";
import { SessionProfileSummary } from "./session/SessionProfileSummary.js";
import { ConfirmationDialog } from "./common/ConfirmationDialog.js";
import { EvidenceInlineSummary, EvidencePanel } from "./evidence/EvidencePanel.js";
import { FileChangesCard } from "./evidence/FileChangesCard.js";
import { useFileAttachments } from "./evidence/FileAttachmentPicker.js";
import { appendUploadedFilePaths, type UploadFileHandler } from "../lib/file-upload.js";
import { MediaGallery } from "./evidence/MediaGallery.js";
import { useMediaPreview } from "./evidence/MediaPreviewProvider.js";
import { mediaArtifacts, mediaKind } from "../lib/media-preview.js";
import { IconButton } from "./common/IconButton.js";
import { MobileComposer } from "./mobile/MobileComposer.js";
import { MobilePageHeader } from "./mobile/MobilePageHeader.js";
import { MobileSessionCatalog } from "./mobile/MobileSessionCatalog.js";
import { useAssistantMail } from "./assistant/AssistantMailProvider.js";
import { MailReference } from "./assistant/MailReference.js";
import { MailCard } from "./assistant/MailCard.js";
import { Sheet, SheetAction } from "./common/Sheet.js";
import {
  SessionConfigurationDialog,
  type SessionConfigurationChange,
} from "./session/SessionConfigurationDialog.js";
import "./session/section-create.css";
import { useSectionManage } from "./session/SectionManageDialog.js";
import { SessionActivityIndicator, SessionContextUsageBar } from "./conversation/SessionActivityIndicator.js";
import { sessionCommandName, useSessionCommands } from "../hooks/useSessionCommands.js";
import { SessionCommandDialogs } from "./conversation/SessionCommandDialogs.js";
import { SessionRewindDialog } from "./conversation/SessionRewindDialog.js";
import { SessionNoticeCard } from "./conversation/SessionNoticeCard.js";

export function MobileWorkspace({
  activeHostId,
  desktopName,
  connection,
  desktopOnline,
  snapshot,
  permissions,
  focusSessionId,
  visible = true,
  fixedSessionId,
  onOpenOtherSession,
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
  onInspectConnection,
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
  onCancelQueuedTurn,
  onStopSubagent,
  onResolveUncertain,
  onResolvePermission,
  onResolvePrompt,
  onReadPrAutoFix,
  onSetPrAutoFix,
  onCreateSession,
  onCreateSection,
  onMoveSessionSection,
  onRenameSection,
  onDeleteSection,
  onBrowseDirectory,
  onCreateDirectory,
  onForkSession,
  onLoadBackgroundTasks,
  onLoadSessionConfiguration,
  onLoadSessionCommands,
  onRunSessionCommand,
  onLoadSessionPermissions,
  onSaveSessionPermissions,
  onConfigureSession,
  onPreviewRewind,
  onRewindSession,
  onArchiveSession,
  onRenameSession,
  onDeleteSession,
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
  fixedSessionId?: string | undefined;
  onOpenOtherSession?(sessionId: string): void;
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
  onInspectConnection?: (() => void) | undefined;
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
  onSendTurn(sessionId: string, text: string, attachments: BridgeAttachment[], mailRefId?: string): Promise<{ requestId: string } | void>;
  onInterruptTurn(sessionId: string, commandId?: string): Promise<void>;
  onSteerQueuedTurn?(sessionId: string, commandId: string): Promise<void>;
  onCancelQueuedTurn?(sessionId: string, commandId: string): Promise<void>;
  onStopSubagent?(sessionId: string, agentId: string): Promise<void>;
  onResolveUncertain(commandId: string, action: "confirm" | "retry"): Promise<void>;
  onResolvePermission(
    requestId: string,
    decision: "allow-once" | "allow-always" | "deny",
    message?: string,
    updatedInput?: Record<string, unknown>,
    mode?: BridgeNativePermissionMode,
  ): Promise<void>;
  onResolvePrompt?(sessionId: string, promptId: string, choice: string): Promise<void>;
  onReadPrAutoFix?(sessionId: string, pr?: BridgePullRequest, includeChecks?: boolean): Promise<BridgePrAutoFixState>;
  onSetPrAutoFix?(update: BridgePrAutoFixUpdate): Promise<BridgePrAutoFixState>;
  onBrowseDirectory?(path?: string): Promise<BridgeDirectoryListing>;
  onCreateDirectory?(parentPath: string, name: string): Promise<string>;
  onCreateSection?: (name: string) => Promise<BridgeProjectInfo | undefined>;
  onMoveSessionSection?: (sessionId: string, sectionId: string | null) => Promise<{ session?: BridgeSessionInfo; projects?: BridgeProjectInfo[] }>;
  onRenameSection?: (sectionId: string, name: string) => Promise<{ project?: BridgeProjectInfo; projects?: BridgeProjectInfo[]; sessions?: BridgeSessionInfo[] }>;
  onDeleteSection?: (sectionId: string) => Promise<{ projects?: BridgeProjectInfo[]; sessions?: BridgeSessionInfo[] }>;
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
  onPreviewRewind?(sessionId: string, messageId: string): Promise<BridgeSessionRewindPreview>;
  onRewindSession?(sessionId: string, messageId: string, scope: BridgeSessionRewindScope): Promise<BridgeSessionRewindResult>;
  onLoadBackgroundTasks?(sessionId: string): Promise<BridgeBackgroundTask[]>;
  onLoadSessionConfiguration(sessionId: string): Promise<BridgeSessionConfiguration>;
  onLoadSessionCommands?(sessionId: string): Promise<BridgeSlashCommandCatalog>;
  onRunSessionCommand?(sessionId: string, text: string): Promise<BridgeSessionCommandResult>;
  onLoadSessionPermissions?(sessionId: string): Promise<BridgeSessionPermissions>;
  onSaveSessionPermissions?(sessionId: string, mode: BridgeSDKPermissionMode, rules: BridgePermissionRules): Promise<BridgeSessionPermissions>;
  onConfigureSession(
    sessionId: string,
    change: SessionConfigurationChange,
  ): Promise<BridgeSessionConfiguration>;
  onArchiveSession?(sessionId: string, archived: boolean): Promise<void>;
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
  const [queuedSteers, setQueuedSteers] = useState<Record<string, QueuedTurnActionState>>({});
  const [promptErrors, setPromptErrors] = useState<Record<string, string>>({});
  const [pickedSessionId, setPickedSessionId] = useState<string>();
  const selectedSessionId = fixedSessionId ?? pickedSessionId;
  function setSelectedSessionId(sessionId: string | undefined): void {
    if (fixedSessionId) {
      if (sessionId && sessionId !== fixedSessionId) onOpenOtherSession?.(sessionId);
    } else setPickedSessionId(sessionId);
  }
  const [sessionView, setSessionView] = useState<"conversation" | "evidence">("conversation");
  const [search, setSearch] = useState("");
  const [drafts, setDrafts] = useState<Record<string, {
    text: string;
    attachments: BridgeAttachment[];
    sending: boolean;
    imageError?: string | undefined;
  }>>({});
  const [promptReplies, setPromptReplies] = useState<Record<string, Record<string, string | null>>>({});
  const draftKey = JSON.stringify([activeHostId, selectedSessionId]);
  const draft = drafts[draftKey] ?? { text: "", attachments: [], sending: false };
  const { text, attachments, sending, imageError } = draft;
  function updateDraft(change: (current: typeof draft) => typeof draft): void {
    setDrafts((current) => ({ ...current, [draftKey]: change(current[draftKey] ?? draft) }));
  }
  const [sectionCreate, setSectionCreate] = useState<{ name: string; busy: boolean; error: string }>();
  const sectionCanCreate = Boolean(onCreateSection && snapshot?.host.capabilities.includes("section.create.v1") && connection === "connected" && desktopOnline && sectionCreate?.name.trim() && !sectionCreate?.busy);
  function closeSectionCreate(): void { if (!sectionCreate?.busy) setSectionCreate(undefined); }
  async function createSection(): Promise<void> {
    if (!sectionCanCreate || !sectionCreate || !onCreateSection) return;
    setSectionCreate({ ...sectionCreate, busy: true, error: "" });
    try {
      const project = await onCreateSection(sectionCreate.name.trim());
      if (!project) throw new Error("Section 未创建，请重试。");
      sectionManage.revealEmptySections();
      setCollapsedProjectIds(current => expandProject(current, project.projectId));
      setActiveProjectId(undefined);
      setSearch("");
      setSectionCreate(undefined);
    } catch (reason) {
      setSectionCreate({ ...sectionCreate, busy: false, error: reason instanceof Error ? reason.message : "Section 创建失败" });
    }
  }
  const [createOpen, setCreateOpen] = useState(false);
  const [createProjectId, setCreateProjectId] = useState("");
  const [configurationSessionId, setConfigurationSessionId] = useState<string>();
  const [rewindTarget, setRewindTarget] = useState<{ sessionId: string; messageId?: string }>();
  const [stoppingSessionId, setStoppingSessionId] = useState<string>();
  const [stopError, setStopError] = useState<string>();
  const [stopSubagentTarget, setStopSubagentTarget] = useState<{
    sessionId: string;
    agentId: string;
    description: string;
    scope: "task" | "process";
  }>();
  const [subagentStopBusy, setSubagentStopBusy] = useState(false);
  /** Open background task sheet, with the stream item it was opened from. */
  const [backgroundTasksOpen, setBackgroundTasksOpen] = useState<{ focus?: ConversationItem }>();
  const [permissionOpen, setPermissionOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [syncFlash, setSyncFlash] = useState(false);
  const [menuSessionId, setMenuSessionId] = useState<string>();
  const [moveMenuSessionId, setMoveMenuSessionId] = useState<string>();
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
  const activeDraftKey = useRef(draftKey);
  activeDraftKey.current = draftKey;
  const [activeProjectId, setActiveProjectId] = useState<string>();
  const [projectSearch, setProjectSearch] = useState("");
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
    scrollTop?: number | undefined;
    pinnedToBottom: boolean;
  }>({ anchorOffset: 0, pinnedToBottom: true });
  const fileRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const handledFocusRef = useRef<string | undefined>(undefined);
  const handledFocusRequestRef = useRef<number | undefined>(undefined);
  const handledDirectoryRequestRef = useRef<number | undefined>(undefined);
  const announcedPermissionsRef = useRef(new Set<string>());

  const sessions = snapshot?.sessions ?? [];
  const sectionManage = useSectionManage({
    activeHostId,
    desktopName,
    snapshot,
    connection,
    desktopOnline,
    onRenameSection,
    onDeleteSection,
  });
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
    onRewind: () => setRewindTarget({ sessionId: selectedSession!.sessionId }),
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
  const rewindAvailable = Boolean(selectedSession?.transport === "claude-desktop-native" && snapshot?.host.capabilities.includes("session.rewind.v1") && onPreviewRewind && onRewindSession);
  const rewindDisabled = connection !== "connected" || !desktopOnline;
  const selectedHistory = selectedSessionId ? histories[selectedSessionId] : undefined;
  const taskHistoryReady = selectedHistory?.status === "ready" || Boolean(selectedHistory?.items.length);
  const [backgroundTaskDetails, setBackgroundTaskDetails] = useState<{ key: string; tasks: BridgeBackgroundTask[] | undefined; error?: string }>();
  useEffect(() => {
    if (!onLoadBackgroundTasks || !visible || sessionView !== "conversation" || connection !== "connected" || !desktopOnline || !selectedSession || desktopRuntimeId(selectedSession) !== "claude-desktop" || !taskHistoryReady) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const tasks = await onLoadBackgroundTasks(selectedSession.sessionId);
        if (active) setBackgroundTaskDetails({ key: draftKey, tasks });
      } catch (error) {
        if (active) setBackgroundTaskDetails(current => ({
          key: draftKey, tasks: current?.key === draftKey ? current.tasks : undefined,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
      if (active) timer = setTimeout(() => void refresh(), 2_000);
    };
    void refresh();
    return () => { active = false; clearTimeout(timer); };
  }, [draftKey, selectedSession?.sessionId, selectedSession?.runtimeId, visible, sessionView, connection, desktopOnline, taskHistoryReady, onLoadBackgroundTasks]);
  const assistantMail = useAssistantMail();
  const selectedEvidence = selectedSessionId ? evidence[selectedSessionId] : undefined;
  const items = useMemo(
    () => selectedSessionId
      ? conversationItems(selectedSessionId, selectedHistory, events, localTurns, true, promptReplies[draftKey])
      : [],
    [draftKey, events, localTurns, promptReplies, selectedHistory, selectedSessionId],
  );
  const fileChangesSummary = useMemo(() => aggregateFileChanges(items), [items]);
  const timeline = useMemo(
    () => conversationTimeline(items, selectedEvidence?.items ?? [], selectedSessionId ? assistantMail?.cache.cards.filter(card => (card.nativeDelivery.nativeSessionId ?? snapshot?.assistantMail?.binding?.nativeSessionId) === selectedSessionId) ?? [] : []),
    [items, selectedEvidence?.items, assistantMail?.cache.cards, snapshot?.assistantMail?.binding?.nativeSessionId, selectedSessionId],
  );
  const streamKeys = useMemo(() => timeline.map((entry) => (
    entry.kind === "evidence" ? `evidence:${entry.evidence.id}` : entry.kind === "mail" ? `mail:${entry.card.mailRefId}` : entry.item.id
  )), [timeline]);
  const streamEntering = useStreamEntrance(selectedSessionId, streamKeys);
  const selectedTaskDetails = backgroundTaskDetails?.key === draftKey ? backgroundTaskDetails : undefined;
  const activityTasks = selectedTaskDetails?.tasks ?? selectedSession?.backgroundTasks;
  const activity = useMemo(() => sessionActivity(
    selectedSession,
    selectedTaskDetails?.error ? items.map(item => {
      const subagent = item.subagent;
      if (subagent?.state !== "running") return item;
      const task = findBackgroundTask(activityTasks, subagent);
      // A resumed workflow can add members absent from the cached launch.
      return task && task.state !== "running"
        && (!subagent.workflowRunId || task.workflow?.agents.some(agent => agent.agentId === subagent.agentId))
        ? { ...item, subagent: { ...subagent, state: task.state } }
        : item;
    }) : items,
    selectedTaskDetails?.error ? undefined : activityTasks,
  ), [selectedSession, items, activityTasks, selectedTaskDetails?.error]);
  const projectsByActivity = useMemo(() => {
    const latest = new Map<string, number>((snapshot?.projects ?? []).filter(project => project.kind === "desktop-group").map(project => [project.projectId, 0]));
    for (const session of sessions) {
      if (!session.archivedAt) latest.set(session.projectId, Math.max(latest.get(session.projectId) ?? 0, session.lastActivityAt));
    }
    return [...latest.keys()].sort((left, right) => latest.get(right)! - latest.get(left)!);
  }, [sessions, snapshot?.projects]);
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
    const matches = sessions.filter((session) => (
      !query || `${session.title}\n${session.projectName}\n${session.cwd}`.toLocaleLowerCase().includes(query)
    ));
    const matchingActiveParents = new Map(matches.filter((session) => !session.archivedAt).map((session) => [session.sessionId, session.projectId]));
    const filtered = matches.filter((session) => (
      !session.archivedAt || Boolean(session.sidechat && session.parentSessionId && matchingActiveParents.get(session.parentSessionId) === session.projectId)
    ));
    const groups = new Map<string, BridgeSessionInfo[]>((snapshot?.projects ?? [])
      .filter(project => project.kind === "desktop-group" && (!query || `${project.name}\n${project.cwd}`.toLocaleLowerCase().includes(query)))
      .map(project => [project.projectId, []]));
    for (const session of filtered) {
      const list = groups.get(session.projectId) ?? [];
      list.push(session);
      groups.set(session.projectId, list);
    }
    return projectOrder
      .filter((projectId) => {
        const groupSessions = groups.get(projectId);
        if (!groupSessions) return false;
        const project = snapshot?.projects.find((candidate) => candidate.projectId === projectId);
        return !sectionManage.shouldHideEmpty(project, groupSessions.length, query);
      })
      .map((projectId) => ({
        project: snapshot?.projects.find((project) => project.projectId === projectId),
        sessions: sortProjectSessionsByRecent(groups.get(projectId)!),
      }));
  }, [projectOrder, search, sectionManage.hideEmptySections, sessions, snapshot?.projects]);
  const archivedSessions = useMemo(() => sortProjectSessionsByRecent(sessions.filter((session) => (
    Boolean(session.archivedAt)
  ))), [sessions]);
  const menuSession = menuSessionId ? sessions.find((session) => session.sessionId === menuSessionId) : undefined;
  const moveMenuOpen = Boolean(menuSession && moveMenuSessionId === menuSession.sessionId);
  const manualSections = useMemo(
    () => (snapshot?.projects ?? []).filter((project) => project.kind === "desktop-group"),
    [snapshot?.projects],
  );
  const currentMenuSection = menuSession ? manualSections.find((project) => project.projectId === menuSession.projectId) : undefined;
  const menuSupportsMoveSection = Boolean(
    onMoveSessionSection
    && snapshot?.host.capabilities.includes("section.move.v1")
    && menuSession?.allowedActions?.canMoveSection,
  );
  const menuSupportsRename = Boolean(onRenameSession && snapshot?.host.capabilities.includes("session.rename.v1"));
  const renameCanSave = Boolean(renameTitle.trim() && renameTitle.trim() !== menuSession?.title && !sessionActionBusy);
  const menuSupportsFork = Boolean(menuSession && onForkSession && desktopRuntimeId(menuSession) === "claude-desktop");
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
    if (!snapshot || !activeProjectId || activeProjectId === "__archived__") return;
    if (!snapshot.projects.some((project) => project.projectId === activeProjectId)) {
      setProjectSearch("");
      setActiveProjectId(undefined);
    }
  }, [activeProjectId, snapshot]);

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
      if (permissionOpen) {
        setPermissionOpen(false);
        return true;
      }
      if (configurationSessionId) {
        setConfigurationSessionId(undefined);
        return true;
      }
      if (sectionCreate) {
        closeSectionCreate();
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
      if (backgroundTasksOpen) {
        setBackgroundTasksOpen(undefined);
        return true;
      }
      if (menuSessionId) {
        if (!sessionActionBusy) {
          if (moveMenuSessionId === menuSessionId) setMoveMenuSessionId(undefined);
          else setMenuSessionId(undefined);
        }
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
        if (fixedSessionId) return false;
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
    sectionCreate,
    createOpen,
    deleteSessionConfirmOpen,
    renameOpen,
    sessionActionBusy,
    directoryMenuOpen,
    projectOrderOpen,
    fileDownloadBusy,
    menuSessionId,
    moveMenuSessionId,
    pendingFileDownload,
    stopSubagentTarget,
    subagentStopBusy,
    backgroundTasksOpen,
    permissionOpen,
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
    if (!stream || !selectedSessionId) {
      streamScrollState.current = { anchorOffset: 0, pinnedToBottom: true };
      return;
    }
    const previous = streamScrollState.current;
    const firstKey = streamKeys[0];
    const lastKey = streamKeys.at(-1);
    const entering = previous.sessionId !== selectedSessionId || !previous.lastKey;
    if (entering) {
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
    streamScrollState.current = { ...previous, sessionId: selectedSessionId, firstKey, lastKey, pinnedToBottom: entering || previous.pinnedToBottom };
    rememberStreamPosition();
  }, [streamKeys, selectedSessionId, sessionView]);

  // Near the top, or when a page leaves the stream too short to scroll, fetch the next older page.
  function loadOlderNearTop(): void {
    const stream = streamRef.current;
    if (!stream || !selectedSessionId || !selectedHistory?.hasMore || !selectedHistory.nextCursor || selectedHistory.status !== "ready" || selectedHistory.error) return;
    if (stream.scrollTop < 200) void onLoadOlderHistory(selectedSessionId);
  }

  // A successful page can advance the cursor without adding a visible item; failed pages keep both unchanged.
  useEffect(() => {
    if (sessionView === "conversation") loadOlderNearTop();
  }, [streamKeys[0], selectedHistory?.nextCursor, selectedSessionId, sessionView]);

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
    setPermissionOpen(permissions.some((permission) => permission.sessionId === focusRequest.sessionId && permission.toolName !== "AskUserQuestion") || snapshot?.prompts?.some(prompt => prompt.sessionId === focusRequest.sessionId) === true);
    onFocusHandled?.();
  }, [focusRequest, focusSessionId, onFocusHandled, permissions, snapshot?.prompts, sessions, visible]);

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
    setPermissionOpen(permissions.some((permission) => permission.sessionId === focusSessionId && permission.toolName !== "AskUserQuestion") || snapshot?.prompts?.some(prompt => prompt.sessionId === focusSessionId) === true);
  }, [focusRequest, focusSessionId, permissions, snapshot?.prompts, sessions, visible]);

  useEffect(() => {
    if (!visible || !selectedSessionId) return;
    const next = permissions.find((permission) => (
      permission.sessionId === selectedSessionId &&
      permission.toolName !== "AskUserQuestion" &&
      !announcedPermissionsRef.current.has(permission.requestId)
    ));
    if (!next) return;
    announcedPermissionsRef.current.add(next.requestId);
    setPermissionOpen(true);
  }, [permissions, selectedSessionId, visible]);

  useEffect(() => {
    if (!visible || !selectedSessionId) return;
    const next = snapshot?.prompts?.find(prompt => prompt.sessionId === selectedSessionId && !announcedPermissionsRef.current.has(`prompt:${prompt.promptId}`));
    if (!next) return;
    announcedPermissionsRef.current.add(`prompt:${next.promptId}`);
    setPermissionOpen(true);
  }, [snapshot?.prompts, selectedSessionId, visible]);

  useEffect(() => {
    if (
      visible &&
      permissionOpen &&
      selectedSessionId &&
      !snapshot?.prompts?.some(prompt => prompt.sessionId === selectedSessionId) &&
      !permissions.some((permission) => permission.sessionId === selectedSessionId && permission.toolName !== "AskUserQuestion")
    ) {
      setPermissionOpen(false);
    }
  }, [permissionOpen, permissions, snapshot?.prompts, selectedSessionId, visible]);

  const handledCommandResets = useRef(new Set<string>());
  useEffect(() => {
    for (const event of events) {
      if (event.type !== "session.reset" || handledCommandResets.current.has(event.eventId)) continue;
      handledCommandResets.current.add(event.eventId);
      if (!fixedSessionId && event.data.previousSessionId === selectedSessionId && typeof event.data.sessionId === "string") {
        void selectSession(event.data.sessionId);
      }
    }
  }, [events]);

  const [selectedNativePromptId, setSelectedNativePromptId] = useState<string>();

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
    setCreateProjectId(
      targetProject?.projectId ?? "",
    );
    setCreateOpen(true);
  }

  async function sendMessage(): Promise<void> {
    if (
      !selectedSession ||
      !canSendSession(selectedSession, snapshot) ||
      sending || fileUploads.uploading ||
      (!text.trim() && (!runtimeSupports(snapshot, selectedSession, "attachment.image") || attachments.length === 0) && fileUploads.files.length === 0)
    ) return;
    const nextText = text.trim();
    const nextAttachments = runtimeSupports(snapshot, selectedSession, "attachment.image") ? attachments : [];
    const nextFiles = fileUploads.files;
    updateDraft((current) => ({ ...current, text: "", attachments: [], sending: true, imageError: undefined }));
    try {
      const mailRefId = assistantMail?.referenceFor(selectedSession.sessionId);
      if (mailRefId && sessionCommandName(nextText)) throw new Error("请先清除邮件引用，再执行会话命令。");
      if (await commands.execute(nextText, attachments.length > 0 || nextFiles.length > 0)) return;
      await onSendTurn(selectedSession.sessionId, appendUploadedFilePaths(nextText, nextFiles), nextAttachments, ...(mailRefId ? [mailRefId] as const : []));
      fileUploads.clear(nextFiles);
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

  async function sendQuickReply(promptId: string, promptText: string): Promise<void> {
    if (
      !selectedSession ||
      !canSendSession(selectedSession, snapshot) ||
      sending ||
      !promptText.trim()
    ) return;
    updateDraft((current) => ({ ...current, sending: true }));
    try {
      const mailRefId = assistantMail?.referenceFor(selectedSession.sessionId);
      if (mailRefId && sessionCommandName(promptText.trim())) throw new Error("请先清除邮件引用，再执行会话命令。");
      const receipt = await onSendTurn(selectedSession.sessionId, promptText.trim(), [], ...(mailRefId ? [mailRefId] as const : []));
      setPromptReplies((current) => ({ ...current, [draftKey]: { ...current[draftKey], [promptId]: receipt?.requestId ?? null } }));
    } catch (error) {
      updateDraft(current => ({ ...current, imageError: error instanceof Error ? error.message : "发送失败" }));
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

  async function moveSessionToSection(sessionId: string, sectionId: string | null): Promise<void> {
    if (!onMoveSessionSection || sessionActionBusy || connection !== "connected" || !desktopOnline) return;
    setSessionActionBusy(true);
    setSessionActionError(undefined);
    try {
      const updated = await onMoveSessionSection(sessionId, sectionId);
      const targetProjectId = sectionId ?? updated.session?.projectId;
      if (targetProjectId) {
        setCollapsedProjectIds((current) => expandProject(current, targetProjectId));
      }
      setMoveMenuSessionId(undefined);
      setMenuSessionId(undefined);
    } catch (error) {
      setSessionActionError(error instanceof Error ? error.message : "移动分组失败");
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
      updateDraft((current) => ({ ...current, attachments: [...current.attachments, ...next] }));
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
    candidate.parentSessionId === selectedSession.sessionId && (!candidate.archivedAt || Boolean(selectedSession.archivedAt))
  )) : [];
  const relatedForkCount = (parentSession ? 1 : 0) + childForks.length;

  const sessionOverlays = (
    <>
      {rewindAvailable && selectedSession && rewindTarget?.sessionId === selectedSession.sessionId && <SessionRewindDialog
        key={`${draftKey}:${rewindTarget.messageId ?? "latest"}`}
        messages={items}
        {...(rewindTarget.messageId ? { initialMessageId: rewindTarget.messageId } : {})}
        disabled={rewindDisabled}
        onPreview={messageId => onPreviewRewind!(selectedSession.sessionId, messageId)}
        onRewind={(messageId, scope) => onRewindSession!(selectedSession.sessionId, messageId, scope)}
        onComplete={result => {
          if (result.scope !== "files") {
            updateDraft(current => ({ ...current, text: result.prefill ?? "", attachments: [] }));
            fileUploads.clear(fileUploads.files);
          }
          setRewindTarget(undefined);
        }}
        onClose={() => setRewindTarget(undefined)}
      />}
      {selectedSession && <SessionCommandDialogs
        key={`commands:${selectedSession.sessionId}`}
        session={selectedSession}
        result={commands.dialog}
        onClose={commands.close}
        onOpenSession={selectSession}
        onLoadPermissions={() => onLoadSessionPermissions!(selectedSession.sessionId)}
        onSavePermissions={(mode, rules) => onSaveSessionPermissions!(selectedSession.sessionId, mode, rules)}
      />}
      {menuSession && !renameOpen && (
        <Sheet
          manageFocus
          eyebrow={moveMenuOpen ? menuSession.title : `${menuSession.projectName} · ${desktopRuntimeName(desktopRuntimeId(menuSession))}`}
          title={moveMenuOpen ? "移动到分组" : menuSession.title}
          busy={sessionActionBusy}
          onClose={() => {
            setMoveMenuSessionId(undefined);
            setMenuSessionId(undefined);
          }}
          {...(moveMenuOpen ? {
            footer: (
              <button
                type="button"
                className="secondary-button"
                disabled={sessionActionBusy}
                onClick={() => {
                  setSessionActionError(undefined);
                  setMoveMenuSessionId(undefined);
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
                        disabled={sessionActionBusy || connection !== "connected" || !desktopOnline || isCurrent}
                        onClick={() => void moveSessionToSection(menuSession.sessionId, section.projectId)}
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
                    disabled={sessionActionBusy || connection !== "connected" || !desktopOnline}
                    onClick={() => void moveSessionToSection(menuSession.sessionId, null)}
                  />
                </div>
              )}
            </>
          ) : (
            <>
          {menuSession === selectedSession && (
            <div className="m-group">
              <SheetAction
                icon={sessionView === "evidence" ? <MessageSquare size={19} /> : <PackageCheck size={19} />}
                label={sessionView === "evidence" ? "返回对话" : `成果${evidenceCount > 0 ? ` ${evidenceCount}` : ""}`}
                disabled={sessionActionBusy}
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
                  disabled={sessionActionBusy}
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
            {menuSupportsMoveSection && (
              <SheetAction
                icon={<Folder size={19} />}
                label="移动到分组"
                detail={currentMenuSection ? currentMenuSection.name : manualSections.length > 0 ? "未分组" : "暂无可用分组"}
                disabled={sessionActionBusy || connection !== "connected" || !desktopOnline || (!currentMenuSection && manualSections.length === 0)}
                onClick={() => {
                  setSessionActionError(undefined);
                  setMoveMenuSessionId(menuSession.sessionId);
                }}
              />
            )}
            {canConfigureSession(menuSession, snapshot) && (
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
          {!menuSession.prs?.length && snapshot?.host.capabilities.includes("pr.autofix.v1") && (
            <div className="m-group">
              <SessionPrActions
                key={`${activeHostId}:${menuSession.sessionId}`}
                session={menuSession}
                events={events}
                onWriteBusyChange={setSessionActionBusy}
                supported
                online={connection === "connected" && desktopOnline}
                {...(onReadPrAutoFix ? { onRead: onReadPrAutoFix } : {})}
                {...(onSetPrAutoFix ? { onSet: onSetPrAutoFix } : {})}
              />
            </div>
          )}
          {menuSupportsFork && (
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
                  detail={menuSessionBusy
                    ? "任务进行中，先停止再删除"
                    : menuSession.transport === "claude-desktop-native" ? "删除 Claude Desktop 中的会话" : "仅从 Bridge 移除，Desktop 原会话保留"}
                  danger
                  disabled={sessionActionBusy || menuSessionBusy}
                  onClick={() => setDeleteSessionConfirmOpen(true)}
                />
              )}
            </div>
          )}
            </>
          )}
          {sessionActionBusy && <p className="m-sheet-note" role="status"><LoaderCircle className="is-spinning" size={15} />正在处理…</p>}
          {sessionActionError && <p className="m-sheet-note is-error" role="alert">{sessionActionError}</p>}
        </Sheet>
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
        description={menuSession?.transport === "claude-desktop-native"
          ? `从 Claude Desktop 中删除「${menuSession.title}」会话及其对话记录？此操作不可恢复。`
          : `从 Bridge 列表中删除「${menuSession?.title ?? ""}」？对应 Desktop 应用中的原生会话与文件不受影响；Bridge 中的会话配置、排队与授权记录会被清除，此操作不可恢复。`}
        confirmLabel="删除会话"
        danger
        busy={sessionActionBusy}
        onCancel={() => setDeleteSessionConfirmOpen(false)}
        onConfirm={() => menuSession && void deleteSessionById(menuSession.sessionId)}
      />
      {configurationSession && canConfigureSession(configurationSession, snapshot) && (
        <SessionConfigurationDialog
          key={`configuration:${configurationSession.sessionId}`}
          session={configurationSession}
          revision={events.filter((event) => ((event.type === "session.configuration" || event.type === "session.compacted") && event.sessionId === configurationSession.sessionId) || (event.type === "permission.policy.changed" && (!event.sessionId || event.sessionId === configurationSession.sessionId))).at(-1)?.seq ?? 0}
          onLoad={() => onLoadSessionConfiguration(configurationSession.sessionId)}
          onSave={(change) => onConfigureSession(configurationSession.sessionId, change)}
          onClose={() => setConfigurationSessionId(undefined)}
        />
      )}

    </>
  );

  if (!visible) return null;

  if (fixedSessionId && !selectedSession) return <main className="mobile-workspace"><p role="status">绑定会话暂不可用，请在助理设置中核对绑定。</p></main>;

  if (selectedSession) {
    const runtimeName = desktopRuntimeName(desktopRuntimeId(selectedSession));
    const canAttachImages = runtimeSupports(snapshot, selectedSession, "attachment.image");
    const canConfigure = canConfigureSession(selectedSession, snapshot);
    const selectedBusy = selectedSession.pendingCount > 0
      || selectedSession.turnState === "running"
      || selectedSession.turnState === "queued"
      || selectedSession.turnState === "waiting";
    const stopTarget = selectedBusy ? stoppableBridgeTask(sessions, selectedSession.sessionId) : undefined;
    const stopping = stoppingSessionId === stopTarget?.sessionId;
    const hasDraft = Boolean(text.trim()) || (canAttachImages && attachments.length > 0) || fileUploads.files.length > 0;
    const sessionPermissions = isClaudeNativeRelay(snapshot) && selectedSession.transport === "claude-desktop-native"
      ? permissions.filter(permission => permission.sessionId === selectedSession.sessionId) : [];
    const sessionQuestions = sessionPermissions.filter(permission => permission.toolName === "AskUserQuestion");
    const toolPermissions = sessionPermissions.filter(permission => permission.toolName !== "AskUserQuestion");
    const activePermission = toolPermissions[0];
    const sessionNativePrompts = snapshot?.prompts?.filter(prompt => prompt.sessionId === selectedSession.sessionId) ?? [];
    const activeNativePrompt = sessionNativePrompts.find(prompt => prompt.promptId === selectedNativePromptId) ?? sessionNativePrompts[0];
    const otherNativePrompt = snapshot?.prompts?.find(prompt => prompt.sessionId !== selectedSession.sessionId && sessions.some(session => session.sessionId === prompt.sessionId));
    const otherNativePromptSession = otherNativePrompt ? sessions.find(session => session.sessionId === otherNativePrompt.sessionId) : undefined;
    const otherPermission = permissions.find(permission => {
      if (permission.sessionId === selectedSession.sessionId) return false;
      const session = sessions.find(candidate => candidate.sessionId === permission.sessionId);
      return session && (isClaudeNativeRelay(snapshot) && session.transport === "claude-desktop-native");
    });
    const otherPermissionSession = otherPermission
      ? sessions.find((session) => session.sessionId === otherPermission.sessionId)
      : undefined;
    const displayNodes = groupTimelineTools(timeline);
    const backgroundTasks = activityTasks ?? [];
    const runningBackgroundTasks = backgroundTasks.filter((task) => task.state === "running").length;
    const renderSubagent = (item: ConversationItem) => (
      <SubagentCard
        item={item}
        key={item.id}
        entering={streamEntering(item.id)}
        collapsible={false}
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
          navigation={!fixedSessionId}
          title={selectedSession.title}
          subtitle={canConfigure ? (
            <button
              type="button"
              className="m-host-chip"
              aria-label="会话设置"
              aria-describedby="mobile-session-profile-summary"
              onClick={() => setConfigurationSessionId(selectedSession.sessionId)}
            >
              <i className={`m-status-dot ${selectedSession.turnState}`} />
              <SessionProfileSummary session={selectedSession} showActivity id="mobile-session-profile-summary" />
              <ChevronDown size={14} />
            </button>
          ) : (
            <span className="m-presence">
              <i className={`m-status-dot ${selectedSession.turnState}`} />
              <SessionProfileSummary session={selectedSession} showActivity />
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
            <>
              {backgroundTasks.length > 0 && (
                <IconButton
                  label={runningBackgroundTasks > 0 ? `后台任务，${runningBackgroundTasks} 个运行中` : "后台任务"}
                  className="background-tasks-button"
                  onClick={() => setBackgroundTasksOpen({})}
                >
                  <Layers size={20} />
                  {runningBackgroundTasks > 0 && <span className="background-tasks-count">{runningBackgroundTasks}</span>}
                </IconButton>
              )}
              <IconButton label="会话操作" onClick={() => {
                setSessionActionError(undefined);
                setMoveMenuSessionId(undefined);
                setMenuSessionId(selectedSession.sessionId);
              }}><MoreHorizontal size={22} /></IconButton>
            </>
          )}
        />
        {selectedSession.prs?.length ? (
          <SessionPrBar
            key={`${activeHostId}:${selectedSession.sessionId}`}
            session={selectedSession}
            events={events}
            supported={Boolean(snapshot?.host.capabilities.includes("pr.autofix.v1"))}
            online={connection === "connected" && desktopOnline}
            {...(onReadPrAutoFix ? { onRead: onReadPrAutoFix } : {})}
            {...(onSetPrAutoFix ? { onSet: onSetPrAutoFix } : {})}
          />
        ) : null}
        {selectedTaskDetails?.error && (
          <p className="session-channel-warning" role="alert">后台任务：{selectedTaskDetails.error}</p>
        )}
        {selectedSession.nativePermissionModeChange && selectedSession.nativePermissionModeChange.state !== "confirmed" && (
          <div className="session-channel-warning message-queue-status" role="status" aria-label="Desktop 会话授权变更">
            <ShieldCheck size={17} />
            <span>{selectedSession.nativePermissionModeChange.state === "requested"
              ? `已请求切换为「${NATIVE_MODE_LABELS[selectedSession.nativePermissionModeChange.mode ?? "bypassPermissions"]}」，等待 Desktop 确认`
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



        {forkChainOpen && relatedForkCount > 0 && (
          <ForkChainBar
            parentSession={parentSession}
            childForks={childForks}
            onSelectSession={(sessionId) => {
              setForkChainOpen(false);
              void selectSession(sessionId);
            }}
            onClose={() => setForkChainOpen(false)}
          />
        )}
        <ConfirmationDialog
          open={stopConfirmOpen && Boolean(stopTarget)}
          title={stopTarget && stopTarget.sessionId !== selectedSession.sessionId ? "停止阻塞任务？" : "停止当前任务？"}
          description={`${stopTarget && stopTarget.sessionId !== selectedSession.sessionId ? `这个会话正在等待「${stopTarget.title}」。` : ""}${
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
        {backgroundTasksOpen && (
          <BackgroundTasksSheet
            supportsToolDetail={Boolean(snapshot?.host.capabilities.includes("transcript.toolDetail.v1"))}
            sessionId={selectedSession.sessionId}
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
        {sessionView === "conversation" ? (
        <section
          className="conversation-stream"
          aria-live="polite"
          ref={streamRef}
          onScroll={() => {
            rememberStreamPosition(true);
            loadOlderNearTop();
          }}
        >
          {selectedHistory?.hasMore && (
            <button
              type="button"
              className="load-older-button"
              disabled={selectedHistory.status === "loading"}
              onClick={() => void onLoadOlderHistory(selectedSession.sessionId)}
            >
              {selectedHistory.status === "loading" && <LoaderCircle className="is-spinning" size={15} />}
              {selectedHistory.status === "loading" ? "正在分段加载更早消息…" : selectedHistory.error ? "重试加载更早消息" : "加载更早消息"}
            </button>
          )}
          {selectedHistory?.hasMore && selectedHistory.error && (
            <div className="conversation-error-detail" role="alert">{selectedHistory.error}</div>
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
          {displayNodes.length === 0 && selectedHistory?.status === "ready" && (
            <div className="conversation-empty">
              <strong>这是一个空会话</strong>
              <span>从下方发出第一条指令。</span>
            </div>
          )}
          {displayNodes.map((node) => {
            if (node.kind === "mail") return <MailCard key={`mail:${node.card.mailRefId}`} card={node.card} {...(node.nativeMessage ? { nativeMessage: node.nativeMessage } : {})} />;
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
                  key={node.id}
                  {...(activeHostId ? { hostId: activeHostId } : {})}
                  sessionId={selectedSession.sessionId}
                  tools={node.tools}
                  supportsToolDetail={Boolean(snapshot?.host.capabilities.includes("transcript.toolDetail.v1"))}
                />
              );
            }
            if (node.kind === "background-task") {
              const task = findBackgroundTask(backgroundTasks, node.item.subagent!);
              return (
                <BackgroundTaskMarker
                  key={`${selectedSession.sessionId}:${node.id}`}
                  item={node.item}
                  {...(task ? { task } : {})}
                  entering={streamEntering(node.item.id)}
                  onOpen={() => setBackgroundTasksOpen({ focus: node.item })}
                />
              );
            }
            const item = node.item;
            if (item.sessionNotice) return (
              <SessionNoticeCard key={item.id} itemId={item.id} notice={item.sessionNotice} source={item.text} entering={streamEntering(item.id)}
                {...(onDownloadSessionFile ? { onFileClick: openSessionFile } : {})} />
            );
            const queueActionKey = JSON.stringify([activeHostId, selectedSession.sessionId, item.commandId]);
            const peerMessages = selectedSession.transport === "claude-desktop-native" || selectedSession.transport === "claude-desktop-managed" || selectedSession.desktopHandoff?.state === "desktop-inbox";
            const pendingQuestion = item.interactivePrompt ? matchingQuestionPermission(
              item.interactivePrompt, sessionPermissions, item.interactivePrompt.toolUseId ?? (peerMessages ? "" : undefined),
            ) : undefined;
            const unavailableReason = peerMessages && item.interactivePrompt
              ? item.interactivePrompt.kind === "question" && !pendingQuestion ? "提问已不在待回答列表"
                : item.interactivePrompt.kind === "wrap-up" && item.interactivePrompt.blocked ? "需在电脑端确认" : undefined
              : undefined;
            const promptKey = `${draftKey}:${item.id}`;
            const interactivePrompt = item.interactivePrompt && (!pendingQuestion || item.interactivePrompt.answered) ? (
              <InteractivePromptCard
                prompt={item.interactivePrompt}
                {...(item.replyDelivery ? { replyDelivery: item.replyDelivery } : {})}
                {...(item.replyPending ? { replyPending: true } : {})}
                canSend={canSendSession(selectedSession, snapshot)}
                busy={sending}
                {...(unavailableReason ? { unavailableReason } : {})}
                {...(promptErrors[promptKey] ? { error: promptErrors[promptKey] } : {})}
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
                session={selectedSession}
                entering={streamEntering(item.id)}
                online={connection === "connected" && desktopOnline}
                canSend={canSendSession(selectedSession, snapshot)}
                queueAction={queuedSteers[queueActionKey]}
                onSteerQueuedTurn={onSteerQueuedTurn}
                onCancelQueuedTurn={onCancelQueuedTurn}
                onQueueActionChange={(next) => setQueuedSteers((current) => ({ ...current, [queueActionKey]: next }))}
                rewindAvailable={rewindAvailable}
                rewindDisabled={rewindDisabled}
                onRewind={(messageId) => setRewindTarget({ sessionId: selectedSession.sessionId, messageId })}
                onResolveUncertain={onResolveUncertain}
                {...(onDownloadSessionFile ? { onFileClick: openSessionFile } : {})}
                interactivePrompt={interactivePrompt}
              />
            );
          })}
          {sessionQuestions.map(permission => (
            <article className="conversation-item assistant pending-question" key={`${draftKey}:${permission.requestId}`} data-stream-key={`question:${permission.requestId}`} aria-label="待回答">
              <PermissionPrompt key={permission.requestId} permission={permission} onResolve={onResolvePermission} />
            </article>
          ))}
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

        <div className={`permission-dock-slot ${activePermission || activeNativePrompt || otherPermission || otherNativePrompt || (sessionView === "evidence" && sessionQuestions.length) ? "has-attention" : ""}`}>
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
          ) : sessionView === "evidence" && sessionQuestions[0] ? (
            <button type="button" className="permission-dock" onClick={() => setSessionView("conversation")}>
              <span className="permission-dock-icon"><AlertTriangle size={18} /></span>
              <span><strong>{runtimeName} 正在等待回答</strong><small>{sessionQuestions[0].title || "提问与选择"}</small></span>
              <b>回答</b>
            </button>
          ) : otherPermission && otherPermissionSession ? (
            <button type="button" className="permission-dock" onClick={() => void selectSession(otherPermission.sessionId)}>
              <span className="permission-dock-icon"><AlertTriangle size={18} /></span>
              <span><strong>另一会话{otherPermission.toolName === "AskUserQuestion" ? "待回答" : "待授权"}</strong><small>{otherPermissionSession.title}</small></span>
              <b>前往</b>
            </button>
          ) : otherNativePrompt && otherNativePromptSession ? (
            <button type="button" className="permission-dock" onClick={() => void selectSession(otherNativePrompt.sessionId)}>
              <span className="permission-dock-icon"><AlertTriangle size={18} /></span>
              <span><strong>另一会话待确认</strong><small>{otherNativePromptSession.title}</small></span>
              <b>前往</b>
            </button>
          ) : null}
        </div>

        {sessionView === "conversation" && (
        <>
        <SessionActivityIndicator activity={activity} />
        <SessionContextUsageBar usage={selectedSession.contextUsage} />
        <MailReference sessionId={selectedSession.sessionId} />
        {MobileComposer({
          selectedSession,
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
          onRetry,
        })}
        </>
        )}
        {permissionOpen && (activePermission || activeNativePrompt) && (
          <Sheet
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
                  <select className="native-prompt-selector" aria-label="待处理提示" value={activeNativePrompt.promptId}
                    onChange={event => setSelectedNativePromptId(event.target.value)}>
                    {sessionNativePrompts.map(prompt => <option key={prompt.promptId} value={prompt.promptId}>{prompt.title}</option>)}
                  </select>
                )}
                <NativePromptCard
                  key={activeNativePrompt.promptId}
                  prompt={activeNativePrompt}
                  online={connection === "connected" && desktopOnline}
                  {...(onResolvePrompt && snapshot?.host.capabilities.includes("prompt.native.v1") ? { onResolve: onResolvePrompt } : {})}
                />
              </>
            )}
          </Sheet>
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

  return MobileSessionCatalog({
    desktopName,
    connection,
    desktopOnline,
    snapshot,
    sessions,
    archivedSessions,
    activeParentProjects,
    grouped,
    groupedProjectIds,
    allProjectsCollapsed,
    collapsedProjectIds,
    expandedForkParents,
    projectOrder,
    projectsByActivity,
    permissions,
    connectionIssue,
    onInspectConnection,
    transportMetrics,
    pendingOutbound,
    activeProjectId,
    search,
    projectSearch,
    directoryRef,
    directoryScrollPositions,
    directoryMenuOpen,
    projectOrderOpen,
    refreshing,
    syncFlash,
    sectionCreate,
    sectionCanCreate,
    sectionManage,
    createOpen,
    createProjectId,
    sessionOverlays,
    onBackToHosts,
    onRetry,
    onRefresh,
    onCreateSection,
    onBrowseDirectory,
    onCreateDirectory,
    onCreateSession,
    selectSession,
    setSearch,
    setProjectSearch,
    setDirectoryMenuOpen,
    setProjectOrderOpen,
    setCollapsedProjectIds,
    setSectionCreate,
    setCreateOpen,
    onOpenSessionActions: (sessionId) => {
      setSessionActionError(undefined);
      setMoveMenuSessionId(undefined);
      setMenuSessionId(sessionId);
    },
    toggleProject,
    toggleForkGroup,
    openProjectGroup,
    closeProjectGroup,
    openCreateDialogForProject,
    placeProjects,
    runRefresh,
    closeSectionCreate,
    createSection,
  });
}
