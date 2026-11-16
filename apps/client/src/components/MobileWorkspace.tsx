import type {
  BridgeArtifactManifest,
  BridgeArtifactPreview,
  BridgeAttachment,
  BridgeBackgroundTask,
  BridgeDesktopAppStatus,
  BridgeDesktopRuntimeId,
  BridgeDirectoryListing,
  BridgeEvidenceDetailPage,
  BridgeEvent,
  BridgeHostSnapshot,
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
  BridgeTransportMetrics,
  SocketState,
} from "@bridge/protocol";
import {
  Archive,
  ArchiveRestore,
  Check,
  CornerUpLeft,
  FilePenLine,
  Folder,
  FolderOpen,
  GitFork,
  LoaderCircle,
  Menu,
  MessageSquare,
  PackageCheck,
  RefreshCw,
  Settings2,
  Trash2,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  LocalTurn,
  MobileConnectionIssue,
  PairedHost,
  SessionEvidenceState,
  SessionHistoryState,
} from "../hooks/useMobileBridge.js";
import type { ThemeControl } from "../hooks/useTheme.js";
import {
  aggregateFileChanges,
  canConfigureSession,
  conciseModelName,
  conversationItems,
  restorableSessionId,
} from "../lib/conversation-timeline.js";
import type { UploadFileHandler } from "../lib/file-upload.js";
import { registerMobileBackHandler } from "../lib/mobile-back-navigation.js";
import {
  expandProject,
  getSessionAncestorIds,
  orderProjects,
  sortProjectSessionsByRecent,
  toggleCollapsedProject,
} from "../lib/project-groups.js";
import { desktopRuntimeId, desktopRuntimeName } from "../lib/runtime-labels.js";
import { useAssistantMail } from "./assistant/AssistantMailProvider.js";
import { MailReference } from "./assistant/MailReference.js";
import { ConfirmationDialog } from "./common/ConfirmationDialog.js";
import { IconButton } from "./common/IconButton.js";
import { Sheet, SheetAction } from "./common/Sheet.js";
import { useConversationDrafts } from "./conversation/ConversationDraftsProvider.js";
import { ConversationView } from "./conversation/ConversationView.js";
import { SessionPrActions } from "./conversation/SessionPrBar.js";
import { useMobileNav, type MobileTab } from "./mobile/MobileAppShell.js";
import { MobileSessionCatalog } from "./mobile/MobileSessionCatalog.js";
import { NewChatCanvas, type NewChatDirectoryPickerRequest } from "./session/NewChatCanvas.js";
import "./session/section-create.css";
import { useSectionManage } from "./session/SectionManageDialog.js";
import {
  SessionConfigurationDialog,
  type SessionConfigurationChange,
} from "./session/SessionConfigurationDialog.js";

export function MobileWorkspace({
  activeHostId,
  hosts,
  onSelectHost,
  onAddHost,
  activeTab = "sessions",
  onSelectTab,
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
  onInspectConnection,
  transportMetrics,
  pendingOutbound: _pendingOutbound,
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
  onDesktopAppAction: _onDesktopAppAction,
  onRefresh,
  onBackToHosts,
  onRetry,
}: {
  activeHostId: string;
  hosts?: readonly PairedHost[] | undefined;
  onSelectHost?: ((hostId: string) => Promise<void> | void) | undefined;
  onAddHost?: (() => void) | undefined;
  activeTab?: MobileTab | undefined;
  onSelectTab?: ((tab: MobileTab) => void) | undefined;
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
    trustWorkspace?: boolean,
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
  const mobileNav = useMobileNav();
  const [refreshing, setRefreshing] = useState(false);
  const [syncFlash, setSyncFlash] = useState(false);
  const [selectedSessionId, setSelectedSessionId] = useState<string>();
  const [sessionView, setSessionView] = useState<"conversation" | "evidence">("conversation");
  const [search, setSearch] = useState("");
  const [localDrawerOpen, setLocalDrawerOpen] = useState(false);
  const [hostSwitcherOpen, setHostSwitcherOpen] = useState(false);
  const [archivedExpanded, setArchivedExpanded] = useState(false);
  const [revealedEmptySectionKey, setRevealedEmptySectionKey] = useState<string>();
  const [expandedEmptyProjectIds, setExpandedEmptyProjectIds] = useState<Set<string>>(() => new Set());
  const [newChatMode, setNewChatMode] = useState(false);
  const [createDialogState, setCreateDialogState] = useState<NewChatDirectoryPickerRequest>();
  const conversationDrafts = useConversationDrafts(activeHostId);
  const assistantMail = useAssistantMail();
  const [sectionCreate, setSectionCreate] = useState<{ name: string; busy: boolean; error: string }>();
  const [createOpen, setCreateOpen] = useState(false);
  const [createProjectId, setCreateProjectId] = useState("");
  const [configurationSessionId, setConfigurationSessionId] = useState<string>();
  const [permissionOpen, setPermissionOpen] = useState(false);
  const [menuSessionId, setMenuSessionId] = useState<string>();
  const [moveMenuSessionId, setMoveMenuSessionId] = useState<string>();
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameTitle, setRenameTitle] = useState("");
  const [deleteSessionConfirmOpen, setDeleteSessionConfirmOpen] = useState(false);
  const [sessionActionBusy, setSessionActionBusy] = useState(false);
  const [sessionActionError, setSessionActionError] = useState<string>();
  const [projectOrderOpen, setProjectOrderOpen] = useState(false);
  const projectOrderKey = `bridge-project-order:${activeHostId}`;
  const [placedProjects, setPlacedProjects] = useState<string[]>(() => (
    JSON.parse(localStorage.getItem(projectOrderKey) ?? "[]") as string[]
  ));
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<Set<string>>(() => new Set());
  const [expandedForkParents, setExpandedForkParents] = useState<Set<string>>(() => new Set());
  const [forkChainOpen, setForkChainOpen] = useState(() => {
    const initialId = selectedSessionId
      ?? (focusSessionId && snapshot?.sessions.some((session) => session.sessionId === focusSessionId)
        ? focusSessionId
        : snapshot?.sessions.find((session) => !session.archivedAt)?.sessionId);
    return Boolean(initialId && snapshot?.sessions.find((session) => session.sessionId === initialId)?.parentSessionId);
  });

  const directoryRef = useRef<HTMLElement>(null);
  const directoryScrollPositions = useRef(new Map<string, number>());
  const handledFocusRef = useRef<string | undefined>(undefined);
  const handledFocusRequestRef = useRef<number | undefined>(undefined);
  const handledDirectoryRequestRef = useRef<number | undefined>(directoryRequest);
  const autoOpenedSessionRef = useRef<string | undefined>(undefined);
  const latestHostIdRef = useRef(activeHostId);
  latestHostIdRef.current = activeHostId;

  const drawerOpen = mobileNav?.drawerOpen ?? localDrawerOpen;
  function setDrawerOpen(next: boolean | ((current: boolean) => boolean)): void {
    if (mobileNav?.setDrawerOpen) {
      mobileNav.setDrawerOpen(next);
    } else {
      setLocalDrawerOpen(next);
    }
  }

  useEffect(() => {
    if (!drawerOpen) setHostSwitcherOpen(false);
  }, [drawerOpen]);

  useEffect(() => {
    if (mobileNav || !localDrawerOpen) return;
    return registerMobileBackHandler(() => {
      setLocalDrawerOpen(false);
      return true;
    }, 300);
  }, [localDrawerOpen, mobileNav]);

  const sessions = snapshot?.sessions ?? [];
  const activeSessions = useMemo(
    () => sessions.filter((session) => !session.archivedAt),
    [sessions],
  );
  const sectionManage = useSectionManage({
    activeHostId,
    desktopName,
    snapshot,
    connection,
    desktopOnline,
    onRenameSection,
    onDeleteSection,
  });

  const sectionCanCreate = Boolean(
    onCreateSection
    && snapshot?.host.capabilities.includes("section.create.v1")
    && connection === "connected"
    && desktopOnline
    && sectionCreate?.name.trim()
    && !sectionCreate?.busy,
  );

  function closeSectionCreate(): void {
    if (!sectionCreate?.busy) setSectionCreate(undefined);
  }

  async function createSection(): Promise<void> {
    if (!sectionCanCreate || !sectionCreate || !onCreateSection) return;
    setSectionCreate({ ...sectionCreate, busy: true, error: "" });
    try {
      const project = await onCreateSection(sectionCreate.name.trim());
      if (!project) throw new Error("Section 未创建，请重试。");
      sectionManage.revealEmptySections();
      placeProjects([project.projectId, ...placedProjects.filter((id) => id !== project.projectId)]);
      setCollapsedProjectIds((current) => expandProject(current, project.projectId));
      setRevealedEmptySectionKey(project.projectId);
      setSearch("");
      setSectionCreate(undefined);
    } catch (reason) {
      setSectionCreate({
        ...sectionCreate,
        busy: false,
        error: reason instanceof Error ? reason.message : "Section 创建失败",
      });
    }
  }

  const defaultSessionId = (
    focusSessionId && sessions.some((candidate) => candidate.sessionId === focusSessionId)
      ? focusSessionId
      : undefined
  ) ?? activeSessions[0]?.sessionId;
  const effectiveSelectedId = selectedSessionId && restorableSessionId(selectedSessionId, sessions)
    ? selectedSessionId
    : (newChatMode ? undefined : defaultSessionId);
  const selectedSession = effectiveSelectedId
    ? sessions.find((session) => session.sessionId === effectiveSelectedId)
    : undefined;
  const configurationSession = sessions.find((session) => session.sessionId === configurationSessionId);
  const selectedHistory = effectiveSelectedId ? histories[effectiveSelectedId] : undefined;
  const selectedEvidence = effectiveSelectedId ? evidence[effectiveSelectedId] : undefined;
  const menuFileChangesCount = useMemo(() => {
    if (!effectiveSelectedId || menuSessionId !== effectiveSelectedId) return 0;
    const items = conversationItems(effectiveSelectedId, selectedHistory, events, localTurns, true);
    return aggregateFileChanges(items) ? 1 : 0;
  }, [effectiveSelectedId, events, localTurns, menuSessionId, selectedHistory]);
  const mailCards = useMemo(() => (
    effectiveSelectedId
      ? assistantMail?.cache.cards.filter((card) => (
          (card.nativeDelivery.nativeSessionId ?? snapshot?.assistantMail?.binding?.nativeSessionId) === effectiveSelectedId
        )) ?? []
      : []
  ), [assistantMail?.cache.cards, effectiveSelectedId, snapshot?.assistantMail?.binding?.nativeSessionId]);

  const projectsByActivity = useMemo(() => {
    const latest = new Map<string, number>(
      (snapshot?.projects ?? []).filter((project) => project.kind === "desktop-group").map((project) => [project.projectId, 0]),
    );
    for (const session of sessions) {
      if (!session.archivedAt) latest.set(session.projectId, Math.max(latest.get(session.projectId) ?? 0, session.lastActivityAt));
    }
    return [...latest.keys()].sort((left, right) => latest.get(right)! - latest.get(left)!);
  }, [sessions, snapshot?.projects]);
  const projectOrder = useMemo(() => orderProjects(projectsByActivity, placedProjects), [placedProjects, projectsByActivity]);
  useEffect(() => {
    const unplaced = projectOrder.filter((projectId) => !placedProjects.includes(projectId));
    if (unplaced.length) placeProjects([...unplaced, ...placedProjects]);
  }, [placedProjects, projectOrder]);

  const grouped = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    const matches = sessions.filter((session) => (
      !query || `${session.title}\n${session.currentSummary ?? ""}\n${session.projectName}\n${session.cwd}`.toLocaleLowerCase().includes(query)
    ));
    const matchingActiveParents = new Map(
      matches.filter((session) => !session.archivedAt).map((session) => [session.sessionId, session.projectId]),
    );
    const filtered = matches.filter((session) => (
      !session.archivedAt || Boolean(session.sidechat && session.parentSessionId && matchingActiveParents.get(session.parentSessionId) === session.projectId)
    ));
    const groups = new Map<string, BridgeSessionInfo[]>(
      (snapshot?.projects ?? [])
        .filter((project) => project.kind === "desktop-group" && (!query || `${project.name}\n${project.cwd}`.toLocaleLowerCase().includes(query)))
        .map((project) => [project.projectId, []]),
    );
    for (const session of filtered) {
      const list = groups.get(session.projectId) ?? [];
      list.push(session);
      groups.set(session.projectId, list);
    }
    return projectOrder
      .filter((projectId) => groups.has(projectId))
      .map((projectId) => ({
        project: snapshot?.projects.find((project) => project.projectId === projectId),
        sessions: sortProjectSessionsByRecent(groups.get(projectId)!),
      }));
  }, [projectOrder, search, sessions, snapshot?.projects]);

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

  const hasPortalOverlay = drawerOpen
    || createOpen
    || Boolean(createDialogState)
    || Boolean(menuSession)
    || deleteSessionConfirmOpen
    || Boolean(configurationSessionId)
    || Boolean(sectionCreate)
    || Boolean(sectionManage.state)
    || projectOrderOpen;

  useEffect(() => {
    if (!visible && !hasPortalOverlay) return;
    return registerMobileBackHandler(() => {
      if (configurationSessionId && (!visible || configurationSessionId !== selectedSession?.sessionId)) {
        setConfigurationSessionId(undefined);
        return true;
      }
      if (sectionCreate) {
        closeSectionCreate();
        return true;
      }
      if (createOpen || createDialogState) {
        setCreateOpen(false);
        setCreateDialogState(undefined);
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
      return false;
    }, 110);
  }, [
    configurationSessionId,
    createDialogState,
    createOpen,
    deleteSessionConfirmOpen,
    hasPortalOverlay,
    menuSessionId,
    moveMenuSessionId,
    projectOrderOpen,
    renameOpen,
    sectionCreate,
    selectedSession,
    sessionActionBusy,
    visible,
  ]);

  useLayoutEffect(() => {
    if (drawerOpen && directoryRef.current) {
      directoryRef.current.scrollTop = directoryScrollPositions.current.get("") ?? 0;
    }
  }, [drawerOpen]);

  useEffect(() => {
    if (search.trim()) setCollapsedProjectIds(new Set());
  }, [search]);

  const autoExpandedForkKeysRef = useRef(new Set<string>());
  useEffect(() => {
    const parentsToExpand: string[] = [];
    for (const session of sessions) {
      if (!session.parentSessionId) continue;
      const isSelected = session.sessionId === effectiveSelectedId;
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
  }, [effectiveSelectedId, sessions]);

  useEffect(() => {
    if (!visible || directoryRequest === undefined || handledDirectoryRequestRef.current === directoryRequest) return;
    handledDirectoryRequestRef.current = directoryRequest;
    setNewChatMode(true);
    setSelectedSessionId(undefined);
    setSessionView("conversation");
    setConfigurationSessionId(undefined);
    setMenuSessionId(undefined);
    setPermissionOpen(false);
    setCreateOpen(false);
    setCreateDialogState(undefined);
    setRenameOpen(false);
    setDeleteSessionConfirmOpen(false);
  }, [directoryRequest, visible]);

  useEffect(() => {
    if (
      !visible
      || !focusRequest
      || handledFocusRequestRef.current === focusRequest.key
      || !sessions.some((session) => session.sessionId === focusRequest.sessionId)
    ) return;
    handledFocusRequestRef.current = focusRequest.key;
    if (focusSessionId === focusRequest.sessionId) handledFocusRef.current = focusSessionId;
    void selectSession(focusRequest.sessionId);
    setPermissionOpen(
      permissions.some((permission) => permission.sessionId === focusRequest.sessionId && permission.toolName !== "AskUserQuestion")
      || snapshot?.prompts?.some((prompt) => prompt.sessionId === focusRequest.sessionId) === true,
    );
    onFocusHandled?.();
  }, [focusRequest, focusSessionId, onFocusHandled, permissions, sessions, snapshot?.prompts, visible]);

  useEffect(() => {
    if (
      !visible
      || focusRequest
      || !focusSessionId
      || handledFocusRef.current === focusSessionId
      || !sessions.some((session) => session.sessionId === focusSessionId)
    ) return;
    handledFocusRef.current = focusSessionId;
    void selectSession(focusSessionId);
    setPermissionOpen(
      permissions.some((permission) => permission.sessionId === focusSessionId && permission.toolName !== "AskUserQuestion")
      || snapshot?.prompts?.some((prompt) => prompt.sessionId === focusSessionId) === true,
    );
  }, [focusRequest, focusSessionId, permissions, sessions, snapshot?.prompts, visible]);

  useEffect(() => {
    if (!visible || focusRequest) return;
    if (!selectedSession) {
      autoOpenedSessionRef.current = undefined;
      return;
    }
    if (selectedSessionId !== selectedSession.sessionId) {
      setSelectedSessionId(selectedSession.sessionId);
      setForkChainOpen(Boolean(selectedSession.parentSessionId));
    }
    if (autoOpenedSessionRef.current !== selectedSession.sessionId) {
      autoOpenedSessionRef.current = selectedSession.sessionId;
      void onOpenSession(selectedSession.sessionId);
    }
  }, [focusRequest, selectedSession?.sessionId, selectedSessionId, visible]);

  const handledCommandResets = useRef(new Set<string>());
  useEffect(() => {
    for (const event of events) {
      if (event.type !== "session.reset" || handledCommandResets.current.has(event.eventId)) continue;
      handledCommandResets.current.add(event.eventId);
      if (event.data.previousSessionId === effectiveSelectedId && typeof event.data.sessionId === "string") {
        conversationDrafts.resetSession(activeHostId, event.data.sessionId);
        void selectSession(event.data.sessionId);
      }
    }
  }, [events]);

  async function selectSession(sessionId: string): Promise<void> {
    autoOpenedSessionRef.current = sessionId;
    setNewChatMode(false);
    setConfigurationSessionId(undefined);
    const target = sessions.find((session) => session.sessionId === sessionId);
    if (target?.archivedAt) setArchivedExpanded(true);
    setForkChainOpen(Boolean(target?.parentSessionId));
    setSessionView("conversation");
    setSelectedSessionId(sessionId);
    if ((activeTab ?? mobileNav?.tab) !== "sessions") {
      (onSelectTab ?? mobileNav?.onTabChange)?.("sessions");
    }
    await onOpenSession(sessionId);
  }

  function startNewChat(): void {
    autoOpenedSessionRef.current = undefined;
    setNewChatMode(true);
    setSelectedSessionId(undefined);
    setForkChainOpen(false);
    setSessionView("conversation");
    setDrawerOpen(false);
    if ((activeTab ?? mobileNav?.tab) !== "sessions") {
      (onSelectTab ?? mobileNav?.onTabChange)?.("sessions");
    }
  }

  function deliverInitialPromptToSession(created: BridgeSessionInfo, rawPrompt: string): void {
    const trimmed = rawPrompt.trim();
    if (!trimmed) return;
    const startingHostId = activeHostId;
    const targetDraft = conversationDrafts.session(startingHostId, created.sessionId, onUploadFile);
    targetDraft.updateDraft((current) => ({
      ...current,
      text: "",
      sending: true,
      imageError: undefined,
    }));
    void Promise.resolve(onSendTurn(created.sessionId, trimmed, []))
      .then(async () => {
        if (latestHostIdRef.current !== startingHostId) return;
        targetDraft.updateDraft((current) => ({ ...current, sending: false }));
        await onRefresh(created.sessionId);
      })
      .catch((error: unknown) => {
        if (latestHostIdRef.current !== startingHostId) return;
        const message = error instanceof Error ? error.message : "发送失败";
        targetDraft.updateDraft((current) => ({
          ...current,
          sending: false,
          imageError: message,
          text: [trimmed, current.text].filter(Boolean).join("\n"),
        }));
      });
  }

  async function quickStartSession(cwd: string, prompt: string, projectId?: string): Promise<void> {
    const created = await onCreateSession(cwd, undefined, "claude-desktop", projectId);
    if (!created) throw new Error("会话未创建，请重试。");
    setCollapsedProjectIds((current) => expandProject(current, created.projectId));
    if (search.trim()) setSearch("");
    deliverInitialPromptToSession(created, prompt);
    await Promise.resolve(onRefresh());
    await selectSession(created.sessionId);
  }

  function placeProjects(order: string[]): void {
    localStorage.setItem(projectOrderKey, JSON.stringify(order));
    setPlacedProjects(order);
  }

  function toggleProject(projectId: string, isEmptyManualGroup = false): void {
    if (isEmptyManualGroup) {
      const currentlyExpanded = projectId === revealedEmptySectionKey || expandedEmptyProjectIds.has(projectId);
      if (currentlyExpanded) {
        if (revealedEmptySectionKey === projectId) setRevealedEmptySectionKey(undefined);
        setExpandedEmptyProjectIds((current) => {
          if (!current.has(projectId)) return current;
          const next = new Set(current);
          next.delete(projectId);
          return next;
        });
      } else {
        setExpandedEmptyProjectIds((current) => new Set([...current, projectId]));
      }
      return;
    }
    setCollapsedProjectIds((current) => toggleCollapsedProject(current, projectId));
  }

  function toggleForkGroup(parentSessionId: string): void {
    setExpandedForkParents((current) => toggleCollapsedProject(current, parentSessionId));
  }

  function openCreateDialogForProject(targetProjectId?: string): void {
    const targetProject = targetProjectId
      ? snapshot?.projects.find((project) => project.projectId === targetProjectId)
      : undefined;
    setCreateProjectId(targetProject?.projectId ?? "");
    setCreateDialogState(undefined);
    setCreateOpen(true);
  }

  function openDirectoryPickerFromCanvas(request?: NewChatDirectoryPickerRequest): void {
    setCreateOpen(false);
    setCreateDialogState(request ?? {});
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
      } else {
        await onRenameSession!(menuSession.sessionId, renameTitle.trim());
      }
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
        setDrawerOpen(false);
        await selectSession(created.sessionId);
      }
    } catch (error) {
      setSessionActionError(error instanceof Error ? error.message : "Fork 分支创建失败");
    } finally {
      setSessionActionBusy(false);
    }
  }

  const evidenceCount = (selectedEvidence?.items.length ?? 0) + menuFileChangesCount;
  const parentSession = selectedSession?.parentSessionId
    ? sessions.find((candidate) => candidate.sessionId === selectedSession.parentSessionId)
    : undefined;

  const sessionOverlays = (
    <>
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
                    detail={sessionView === "evidence" ? "回到对话记录" : "查看产出文件与最新快照"}
                    onClick={() => {
                      setSessionView(sessionView === "evidence" ? "conversation" : "evidence");
                      setMenuSessionId(undefined);
                    }}
                  />
                  {parentSession && (
                    <SheetAction
                      icon={selectedSession.sidechat ? <CornerUpLeft size={19} /> : <GitFork size={19} />}
                      label="主会话"
                      disabled={sessionActionBusy}
                      detail={`来自：${parentSession.title}`}
                      onClick={() => {
                        setMenuSessionId(undefined);
                        void selectSession(parentSession.sessionId);
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
                  <SheetAction
                    icon={<GitFork size={19} />}
                    label="Fork 分支"
                    detail="复制完整对话为独立会话，原会话不变"
                    disabled={sessionActionBusy}
                    onClick={() => void forkSessionById(menuSession.sessionId)}
                  />
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
      {configurationSession
        && (!visible || configurationSession.sessionId !== selectedSession?.sessionId)
        && canConfigureSession(configurationSession, snapshot) && (
          <SessionConfigurationDialog
            key={`configuration:${configurationSession.sessionId}`}
            session={configurationSession}
            revision={events.filter((event) => (
              ((event.type === "session.configuration" || event.type === "session.compacted") && event.sessionId === configurationSession.sessionId)
              || (event.type === "permission.policy.changed" && (!event.sessionId || event.sessionId === configurationSession.sessionId))
            )).at(-1)?.seq ?? 0}
            onLoad={() => onLoadSessionConfiguration(configurationSession.sessionId)}
            onSave={(change) => onConfigureSession(configurationSession.sessionId, change)}
            onClose={() => setConfigurationSessionId(undefined)}
          />
        )}
    </>
  );

  const fallbackMenuButton = !mobileNav ? (
    <IconButton
      label="菜单"
      aria-expanded={drawerOpen}
      onClick={() => setDrawerOpen((current) => !current)}
    >
      <Menu size={20} />
    </IconButton>
  ) : undefined;

  const assistantAvailable = Boolean(
    mobileNav?.assistantAvailable
    ?? snapshot?.host.capabilities.includes("plugin.assistant-mail.v1"),
  );
  const assistantUnreadCount = assistantMail?.unreadCount ?? 0;

  const drawerElement = MobileSessionCatalog({
    open: drawerOpen,
    onClose: () => setDrawerOpen(false),
    hosts,
    activeHostId,
    onSelectHost,
    onAddHost,
    hostSwitcherOpen,
    onToggleHostSwitcher: () => setHostSwitcherOpen((current) => !current),
    activeTab,
    onSelectTab: onSelectTab ?? mobileNav?.onTabChange,
    assistantAvailable,
    assistantUnreadCount,
    themeControl,
    onStartNewChat: startNewChat,
    selectedSessionId: selectedSession?.sessionId,
    archivedExpanded,
    onToggleArchived: () => setArchivedExpanded((current) => !current),
    expandedEmptyProjectIds,
    revealedEmptySectionKey,
    createDialogState,
    onCloseCreateDialog: () => {
      setCreateOpen(false);
      setCreateDialogState(undefined);
    },
    onDeliverInitialPrompt: deliverInitialPromptToSession,
    desktopName,
    connection,
    desktopOnline,
    snapshot,
    sessions,
    archivedSessions,
    grouped,
    collapsedProjectIds,
    expandedForkParents,
    projectOrder,
    projectsByActivity,
    permissions,
    connectionIssue,
    onInspectConnection,
    transportMetrics,
    search,
    directoryRef,
    directoryScrollPositions,
    projectOrderOpen,
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
    openCreateDialogForProject,
    placeProjects,
    closeSectionCreate,
    createSection,
  });

  if (!visible) {
    if (hasPortalOverlay && typeof document !== "undefined" && document.body) {
      return createPortal(drawerElement, document.body);
    }
    return null;
  }

  return (
    <>
      <div
        className="mobile-workspace-canvas"
        inert={drawerOpen || undefined}
        aria-hidden={drawerOpen || undefined}
      >
        {selectedSession ? (
          <ConversationView
            variant="mobile"
            hostId={activeHostId}
            session={selectedSession}
            sessions={sessions}
            snapshot={snapshot}
            connection={connection}
            desktopOnline={desktopOnline}
            visible={visible}
            navigation
            {...(fallbackMenuButton ? { headerLeading: fallbackMenuButton } : {})}
            onSelectSession={selectSession}
            conversationDrafts={conversationDrafts}
            sessionView={sessionView}
            onSessionViewChange={setSessionView}
            forkChainOpen={forkChainOpen}
            onForkChainOpenChange={setForkChainOpen}
            permissionOpen={permissionOpen}
            onPermissionOpenChange={setPermissionOpen}
            configurationOpen={configurationSessionId === selectedSession.sessionId}
            onConfigurationOpenChange={(open) => setConfigurationSessionId(open ? selectedSession.sessionId : undefined)}
            onOpenSessionMenu={() => {
              setSessionActionError(undefined);
              setMoveMenuSessionId(undefined);
              setMenuSessionId(selectedSession.sessionId);
            }}
            onRequestRename={(target) => {
              setMenuSessionId(target.sessionId);
              setRenameTitle(target.title);
              setSessionActionError(undefined);
              setRenameOpen(true);
            }}
            refreshing={refreshing}
            onRefresh={runRefresh}
            onRetry={onRetry}
            history={selectedHistory}
            evidence={selectedEvidence}
            artifactPreviews={artifactPreviews}
            artifactTransfers={artifactTransfers}
            permissions={permissions}
            events={events}
            localTurns={localTurns}
            connectionIssue={connectionIssue}
            mailCards={mailCards}
            composerBanner={<MailReference sessionId={selectedSession.sessionId} />}
            resolveMailRefId={() => assistantMail?.referenceFor(selectedSession.sessionId)}
            onOpenSession={onOpenSession}
            onLoadOlderHistory={onLoadOlderHistory}
            onLoadOlderEvidence={onLoadOlderEvidence}
            onLoadEvidenceDetails={onLoadEvidenceDetails}
            onPreviewArtifact={onPreviewArtifact}
            onDownloadArtifact={onDownloadArtifact}
            onDownloadSessionFile={onDownloadSessionFile}
            onUploadFile={onUploadFile}
            onSendTurn={onSendTurn}
            onInterruptTurn={onInterruptTurn}
            onSteerQueuedTurn={onSteerQueuedTurn}
            onCancelQueuedTurn={onCancelQueuedTurn}
            onStopSubagent={onStopSubagent}
            onResolveUncertain={onResolveUncertain}
            onResolvePermission={onResolvePermission}
            onResolvePrompt={onResolvePrompt}
            onReadPrAutoFix={onReadPrAutoFix}
            onSetPrAutoFix={onSetPrAutoFix}
            onLoadBackgroundTasks={onLoadBackgroundTasks}
            onLoadSessionConfiguration={onLoadSessionConfiguration}
            onConfigureSession={onConfigureSession}
            onLoadSessionCommands={onLoadSessionCommands}
            onRunSessionCommand={onRunSessionCommand}
            onLoadSessionPermissions={onLoadSessionPermissions}
            onSaveSessionPermissions={onSaveSessionPermissions}
            onPreviewRewind={onPreviewRewind}
            onRewindSession={onRewindSession}
          />
        ) : (
          <main className="mobile-workspace new-chat-workspace">
            <NewChatCanvas
              mobile
              snapshot={snapshot}
              connected={connection === "connected" && desktopOnline}
              {...(fallbackMenuButton ? { headerLeading: fallbackMenuButton } : {})}
              onOpenDirectoryPicker={openDirectoryPickerFromCanvas}
              onQuickStart={quickStartSession}
            />
          </main>
        )}
      </div>
      {drawerElement}
    </>
  );
}
