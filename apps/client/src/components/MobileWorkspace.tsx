import { ASSISTANT_AGENDA_CAPABILITY } from "@bridge/protocol";
import type {
  BridgeArtifactManifest,
  BridgeArtifactPreview,
  BridgeAttachment,
  BridgeBackgroundTask,
  BridgeClaudeActivationResult,
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
  CornerUpLeft,
  FileText,
  GitFork,
  MessageSquare,
  SquarePen,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  LocalTurn,
  MobileConnectionIssue,
  PairedHost,
  ManualReconnectState,
  SessionEvidenceState,
  SessionHistoryState,
} from "../hooks/useMobileBridge.js";
import type { ThemeControl } from "../hooks/useTheme.js";
import {
  aggregateFileChanges,
  canConfigureSession,
  conversationItems,
  restorableSessionId,
} from "../lib/conversation-timeline.js";
import type { UploadFileHandler } from "../lib/file-upload.js";
import { registerMobileBackHandler } from "../lib/mobile-back-navigation.js";
import {
  CLAUDE_UNSECTIONED_PROJECT_ID,
  expandProject,
  getSessionAncestorIds,
} from "../lib/project-groups.js";
import { desktopRuntimeId } from "../lib/runtime-labels.js";
import { setActiveViewedSession } from "../lib/session-notifications.js";
import { useAssistantEntry } from "./assistant/AssistantProposalProvider.js";
import { useAssistantMail } from "./assistant/AssistantMailProvider.js";
import { MailReference } from "./assistant/MailReference.js";
import { SheetAction } from "./common/Sheet.js";
import { useConversationDrafts } from "./conversation/ConversationDraftsProvider.js";
import { EvidencePanel } from "./evidence/EvidencePanel.js";
import { ConversationView } from "./conversation/ConversationView.js";
import { SessionPrActions } from "./conversation/SessionPrBar.js";
import { useMobileNav, type MobileTab } from "./mobile/MobileAppShell.js";
import { MobileSessionCatalog } from "./mobile/MobileSessionCatalog.js";
import { NewChatCanvas, type NewChatDirectoryPickerRequest } from "./session/NewChatCanvas.js";
import "./session/section-create.css";
import type { SectionCreateState } from "./session/SectionCreateDialog.js";
import { useSectionManage } from "./session/SectionManageDialog.js";
import { SessionActionSheets } from "./session/SessionActionSheets.js";
import {
  SessionConfigurationDialog,
  type SessionConfigurationChange,
} from "./session/SessionConfigurationDialog.js";
import { SessionCreateDialog } from "./session/SessionCreateDialog.js";
import { useProjectSessionGroups } from "./session/useProjectSessionGroups.js";
import { useSessionMenuAction } from "./session/useSessionMenuAction.js";
import { useSessionSectionDrag } from "./session/useSessionSectionDrag.js";

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
  manualReconnect,
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
  onActivateClaude,
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
  manualReconnect?: ManualReconnectState | undefined;
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
  onDownloadSessionFile?(sessionId: string, filePath: string, resolveRelativeLink?: true): Promise<void>;
  onUploadFile?: (...args: [...Parameters<UploadFileHandler>, expectedHostId?: string]) => ReturnType<UploadFileHandler>;
  onSendTurn(
    sessionId: string, text: string, attachments: BridgeAttachment[], mailRefId?: string,
    firstTurn?: { hostId: string | undefined; session: BridgeSessionInfo },
  ): Promise<{ requestId: string } | void>;
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
  onActivateClaude(): Promise<BridgeClaudeActivationResult | undefined>;
  onRefresh(sessionId?: string): Promise<boolean>;
  onBackToHosts(): void;
  onRetry(): Promise<void>;
}) {
  const mobileNav = useMobileNav();
  const sessions = snapshot?.sessions ?? [];
  const online = connection === "connected" && desktopOnline;
  const [refreshing, setRefreshing] = useState(false);
  const [syncFlash, setSyncFlash] = useState(false);
  const [selectedSessionId, setSelectedSessionId] = useState<string | undefined>(() => {
    const requestedId = focusRequest?.sessionId ?? focusSessionId;
    return requestedId && sessions.some((session) => session.sessionId === requestedId)
      ? requestedId
      : undefined;
  });
  const [sessionView, setSessionView] = useState<"conversation" | "evidence">("conversation");

  const effectiveSelectedId = selectedSessionId && restorableSessionId(selectedSessionId, sessions)
    ? selectedSessionId
    : undefined;

  const {
    search,
    setSearch,
    archivedExpanded,
    setArchivedExpanded,
    revealedEmptySectionKey,
    expandedEmptyProjectIds,
    projectOrderOpen,
    setProjectOrderOpen,
    collapsedProjectIds,
    setCollapsedProjectIds,
    expandedForkParents,
    setExpandedForkParents,
    manualSections,
    projectsByActivity,
    projectOrder,
    managedProjectId,
    grouped,
    archivedSessions,
    archivedFamilies,
    placeProjects,
    toggleProject,
    toggleForkGroup,
    expandedOlderSessions,
    toggleOlderSessions,
    registerCreatedSection,
  } = useProjectSessionGroups({
    hostId: activeHostId,
    projects: snapshot?.projects,
    sessions,
    selectedSessionId: effectiveSelectedId,
  });

  const [hostSwitcherOpen, setHostSwitcherOpen] = useState(false);
  const [newChatMode, setNewChatMode] = useState(false);
  const [newChatTarget, setNewChatTarget] = useState<{
    key: number;
    initialProjectId?: string | undefined;
    initialCwd?: string | undefined;
  }>();
  const [createDialogState, setCreateDialogState] = useState<NewChatDirectoryPickerRequest>();
  const conversationDrafts = useConversationDrafts(activeHostId);
  const assistantMail = useAssistantMail();
  const assistantEntry = useAssistantEntry();
  const [sectionCreate, setSectionCreate] = useState<SectionCreateState>();
  const [configurationSessionId, setConfigurationSessionId] = useState<string>();
  const [permissionOpen, setPermissionOpen] = useState(false);
  const [menuSessionId, setMenuSessionId] = useState<string>();
  const [moveMenuSessionId, setMoveMenuSessionId] = useState<string>();
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameTitle, setRenameTitle] = useState("");
  const [deleteSessionConfirmOpen, setDeleteSessionConfirmOpen] = useState(false);
  const { busy: sessionActionBusy, setBusy: setSessionActionBusy, error: sessionActionError, setError: setSessionActionError, run: runMenuAction } = useSessionMenuAction();
  const [forkChainOpen, setForkChainOpen] = useState(() => (
    Boolean(selectedSessionId && sessions.find((session) => session.sessionId === selectedSessionId)?.parentSessionId)
  ));

  const directoryRef = useRef<HTMLElement>(null);
  const directoryScrollPositions = useRef(new Map<string, number>());
  const handledFocusRef = useRef<string | undefined>(undefined);
  const handledFocusRequestRef = useRef<number | undefined>(undefined);
  const handledDirectoryRequestRef = useRef<number | undefined>(directoryRequest);
  const autoOpenedSessionRef = useRef<string | undefined>(undefined);
  const renameDialogRef = useRef<HTMLElement>(null);
  const latestHostIdRef = useRef(activeHostId);
  latestHostIdRef.current = activeHostId;

  const sectionManage = useSectionManage({
    activeHostId,
    desktopName,
    snapshot,
    connection,
    desktopOnline,
    onRenameSection,
    onDeleteSection,
  });

  const supportsCreateSection = Boolean(
    onCreateSection && snapshot?.host.capabilities.includes("section.create.v1"),
  );
  const sectionCanCreate = Boolean(
    supportsCreateSection
    && online
    && sectionCreate?.name.trim()
    && !sectionCreate.busy,
  );

  function closeSectionCreate(): void {
    if (!sectionCreate?.busy) setSectionCreate(undefined);
  }

  async function createSectionFromName(
    rawName: string,
    options?: { clearSearch?: boolean | undefined },
  ): Promise<BridgeProjectInfo> {
    const project = await onCreateSection!(rawName.trim());
    if (!project) throw new Error("分组未创建，请重试。");
    sectionManage.revealEmptySections();
    registerCreatedSection(project.projectId, options);
    return project;
  }

  async function createSection(): Promise<void> {
    if (!sectionCanCreate || !sectionCreate || !onCreateSection) return;
    setSectionCreate({ ...sectionCreate, busy: true, error: "" });
    try {
      await createSectionFromName(sectionCreate.name, { clearSearch: true });
      setSectionCreate(undefined);
    } catch (reason) {
      setSectionCreate({
        ...sectionCreate,
        busy: false,
        error: reason instanceof Error ? reason.message : "分组创建失败",
      });
    }
  }

  const selectedSession = effectiveSelectedId
    ? sessions.find((session) => session.sessionId === effectiveSelectedId)
    : undefined;
  const showingHomeCatalog = !selectedSession && !newChatMode;
  // New chat opened from a conversation's ⋯ keeps that conversation mounted underneath to return to.
  const newChatReturnSession = newChatMode ? selectedSession : undefined;
  const activeConversationSessionId = visible && !newChatMode && selectedSession && sessionView === "conversation"
    ? selectedSession.sessionId
    : undefined;
  useEffect(() => {
    if (!activeConversationSessionId) return;
    return setActiveViewedSession({ hostId: activeHostId, sessionId: activeConversationSessionId });
  }, [activeConversationSessionId, activeHostId]);

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
      ? assistantMail?.timelineCards.filter((card) => (
          (card.nativeDelivery.nativeSessionId ?? snapshot?.assistantMail?.binding?.nativeSessionId) === effectiveSelectedId
        )) ?? []
      : []
  ), [assistantMail?.timelineCards, effectiveSelectedId, snapshot?.assistantMail?.binding?.nativeSessionId]);

  const menuSession = menuSessionId ? sessions.find((session) => session.sessionId === menuSessionId) : undefined;
  const moveMenuOpen = Boolean(menuSession && moveMenuSessionId === menuSession.sessionId);
  const menuSupportsMoveSection = Boolean(
    onMoveSessionSection
    && snapshot?.host.capabilities.includes("section.move.v1")
    && menuSession?.allowedActions?.canMoveSection,
  );
  const canRename = (session: BridgeSessionInfo) => Boolean(
    (onRenameSession && snapshot?.host.capabilities.includes("session.rename.v1"))
    || (onRunSessionCommand && snapshot?.host.capabilities.includes("session.command.v1") && desktopRuntimeId(session) === "claude-desktop"),
  );
  const menuSupportsRename = Boolean(menuSession && canRename(menuSession));
  const renameCanSave = Boolean(renameTitle.trim() && renameTitle.trim() !== menuSession?.title && !sessionActionBusy);
  const menuSupportsFork = Boolean(menuSession && menuSession.projectId !== managedProjectId && onForkSession && desktopRuntimeId(menuSession) === "claude-desktop");

  useEffect(() => {
    if (!renameOpen || !sessionActionBusy) return;
    renameDialogRef.current?.focus();
  }, [renameOpen, sessionActionBusy]);

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

  const hasPortalOverlay = Boolean(createDialogState)
    || Boolean(menuSession)
    || renameOpen
    || deleteSessionConfirmOpen
    || Boolean(configurationSessionId)
    || Boolean(sectionCreate)
    || Boolean(sectionManage.state)
    || projectOrderOpen;

  useEffect(() => {
    if (!showingHomeCatalog && hostSwitcherOpen) setHostSwitcherOpen(false);
  }, [hostSwitcherOpen, showingHomeCatalog]);

  useEffect(() => {
    if (!visible && !hasPortalOverlay) return;
    const unregisterOverlays = registerMobileBackHandler(() => {
      if (configurationSessionId && (!visible || configurationSessionId !== selectedSession?.sessionId)) {
        setConfigurationSessionId(undefined);
        return true;
      }
      if (sectionCreate) {
        closeSectionCreate();
        return true;
      }
      if (createDialogState) {
        setCreateDialogState(undefined);
        return true;
      }
      if (renameOpen) {
        closeRename();
        return true;
      }
      if (deleteSessionConfirmOpen) {
        if (!sessionActionBusy) setDeleteSessionConfirmOpen(false);
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
      if (hostSwitcherOpen) {
        setHostSwitcherOpen(false);
        return true;
      }
      return false;
    }, 110);
    const unregisterNewChat = registerMobileBackHandler(() => {
      if (visible && newChatMode) {
        leaveNewChat();
        return true;
      }
      return false;
    }, 95);
    return () => {
      unregisterOverlays();
      unregisterNewChat();
    };
  }, [
    configurationSessionId,
    createDialogState,
    deleteSessionConfirmOpen,
    hasPortalOverlay,
    hostSwitcherOpen,
    menuSessionId,
    moveMenuSessionId,
    newChatMode,
    newChatReturnSession,
    projectOrderOpen,
    renameOpen,
    sectionCreate,
    selectedSession,
    sessionActionBusy,
    visible,
  ]);

  useLayoutEffect(() => {
    if (visible && showingHomeCatalog && directoryRef.current) {
      directoryRef.current.scrollTop = directoryScrollPositions.current.get("") ?? 0;
    }
  }, [showingHomeCatalog, visible]);

  function leaveNewChat(): void {
    if (newChatReturnSession) setNewChatMode(false);
    else closeToCatalog();
  }

  function closeToCatalog(): void {
    autoOpenedSessionRef.current = undefined;
    setNewChatMode(false);
    setSelectedSessionId(undefined);
    setForkChainOpen(false);
    setSessionView("conversation");
    setConfigurationSessionId(undefined);
    setMenuSessionId(undefined);
    setPermissionOpen(false);
    setCreateDialogState(undefined);
    setRenameOpen(false);
    setDeleteSessionConfirmOpen(false);
  }

  useEffect(() => {
    if (!visible || directoryRequest === undefined || handledDirectoryRequestRef.current === directoryRequest) return;
    handledDirectoryRequestRef.current = directoryRequest;
    closeToCatalog();
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
    setHostSwitcherOpen(false);
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

  function startNewChat(targetProjectId?: string, targetCwd?: string, keepConversation = false): void {
    setNewChatTarget((previous) => ({
      key: (previous?.key ?? 0) + 1,
      ...(targetProjectId !== undefined ? { initialProjectId: targetProjectId } : {}),
      ...(targetCwd !== undefined ? { initialCwd: targetCwd } : {}),
    }));
    setNewChatMode(true);
    setCreateDialogState(undefined);
    setMenuSessionId(undefined);
    setMoveMenuSessionId(undefined);
    setHostSwitcherOpen(false);
    if (!keepConversation) {
      autoOpenedSessionRef.current = undefined;
      setSelectedSessionId(undefined);
      setForkChainOpen(false);
      setSessionView("conversation");
    }
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

  async function handleNewChatCreated(
    created: BridgeSessionInfo,
    options?: { initialPrompt?: string | undefined; configurationError?: string | undefined },
  ): Promise<void> {
    setCollapsedProjectIds((current) => expandProject(current, created.projectId));
    if (search.trim()) setSearch("");
    if (options?.configurationError) {
      const targetDraft = conversationDrafts.session(activeHostId, created.sessionId, onUploadFile);
      const pendingText = options.initialPrompt?.trim() ?? "";
      targetDraft.updateDraft((current) => ({
        ...current,
        imageError: options.configurationError,
        text: [pendingText, current.text].filter(Boolean).join("\n"),
      }));
    } else if (options?.initialPrompt?.trim()) {
      deliverInitialPromptToSession(created, options.initialPrompt);
    }
    await Promise.resolve(onRefresh());
    await selectSession(created.sessionId);
  }

  function openCreateDialogForProject(targetProjectId?: string): void {
    startNewChat(targetProjectId);
  }

  function openDirectoryPickerFromCanvas(request?: NewChatDirectoryPickerRequest): void {
    setCreateDialogState(request ?? {});
  }

  async function archiveSessionById(sessionId: string, archived: boolean): Promise<void> {
    if (!onArchiveSession) return;
    await runMenuAction("归档设置失败", async () => {
      await onArchiveSession(sessionId, archived);
      setMenuSessionId(undefined);
    });
  }

  async function moveSessionToSection(sessionId: string, sectionId: string | null): Promise<void> {
    if (!onMoveSessionSection || !online) return;
    await runMenuAction("移动分组失败", async () => {
      const updated = await onMoveSessionSection(sessionId, sectionId);
      const targetProjectId = sectionId ?? updated.session?.projectId ?? CLAUDE_UNSECTIONED_PROJECT_ID;
      if (targetProjectId) {
        setCollapsedProjectIds((current) => expandProject(current, targetProjectId));
      }
      setMoveMenuSessionId(undefined);
      setMenuSessionId(undefined);
    });
  }

  const sessionDrag = useSessionSectionDrag({
    hostOnline: online,
    capabilities: snapshot?.host.capabilities,
    manualSections,
    sessions,
    scrollContainerRef: directoryRef,
    onMoveSessionSection: onMoveSessionSection ? moveSessionToSection : undefined,
  });

  function closeRename(): void {
    if (sessionActionBusy) return;
    setRenameOpen(false);
    setMenuSessionId(undefined);
  }

  async function renameSession(): Promise<void> {
    if (!menuSession || (!onRenameSession && !onRunSessionCommand) || !renameCanSave) return;
    await runMenuAction("重命名会话失败", async () => {
      if (onRunSessionCommand && snapshot?.host.capabilities.includes("session.command.v1") && desktopRuntimeId(menuSession) === "claude-desktop") {
        await onRunSessionCommand(menuSession.sessionId, `/rename ${renameTitle.trim()}`);
      } else {
        await onRenameSession!(menuSession.sessionId, renameTitle.trim());
      }
      setRenameOpen(false);
      setMenuSessionId(undefined);
    });
  }

  async function deleteSessionById(sessionId: string): Promise<void> {
    if (!onDeleteSession) return;
    await runMenuAction("删除会话失败", async () => {
      await onDeleteSession(sessionId);
      conversationDrafts.resetSession(activeHostId, sessionId);
      setDeleteSessionConfirmOpen(false);
      setMenuSessionId(undefined);
    });
  }

  async function forkSessionById(sessionId: string): Promise<void> {
    if (!onForkSession) return;
    await runMenuAction("Fork 分支创建失败", async () => {
      const created = await onForkSession(sessionId);
      if (!created) return;
      setExpandedForkParents((current) => new Set([
        ...current,
        ...getSessionAncestorIds(sessions, sessionId),
        sessionId,
      ]));
      setCollapsedProjectIds((current) => expandProject(current, created.projectId));
      setMenuSessionId(undefined);
      await selectSession(created.sessionId);
    });
  }

  const evidenceCount = (selectedEvidence?.items.length ?? 0) + menuFileChangesCount;
  const parentSession = selectedSession?.parentSessionId
    ? sessions.find((candidate) => candidate.sessionId === selectedSession.parentSessionId)
    : undefined;

  const sessionOverlays = (
    <>
      <SessionActionSheets
        menuSession={menuSession}
        renameSession={renameOpen ? menuSession : undefined}
        deleteSession={deleteSessionConfirmOpen ? menuSession : undefined}
        moveMenuOpen={moveMenuOpen}
        manualSections={manualSections}
        online={online}
        busy={sessionActionBusy}
        error={sessionActionError}
        supportsRename={menuSupportsRename}
        supportsMoveSection={menuSupportsMoveSection}
        supportsFork={menuSupportsFork}
        renameTitle={renameTitle}
        renameDialogRef={renameDialogRef}
        leadingGroup={menuSession && menuSession === selectedSession ? (
          <div className="m-group">
            {menuSession.projectId !== managedProjectId && <SheetAction
              icon={<SquarePen size={19} />}
              label="新建会话"
              disabled={sessionActionBusy || !snapshot || !online}
              onClick={() => startNewChat(menuSession.projectId, menuSession.cwd, true)}
            />}
            <SheetAction
              icon={sessionView === "evidence" ? <MessageSquare size={19} /> : <FileText size={19} />}
              label={sessionView === "evidence" ? "返回对话" : `成果${evidenceCount > 0 ? ` ${evidenceCount}` : ""}`}
              disabled={sessionActionBusy}
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
        ) : undefined}
        prActions={menuSession && !menuSession.prs?.length && snapshot?.host.capabilities.includes("pr.autofix.v1") ? (
          <SessionPrActions
            key={`${activeHostId}:${menuSession.sessionId}`}
            session={menuSession}
            events={events}
            onWriteBusyChange={setSessionActionBusy}
            supported
            online={online}
            {...(onReadPrAutoFix ? { onRead: onReadPrAutoFix } : {})}
            {...(onSetPrAutoFix ? { onSet: onSetPrAutoFix } : {})}
          />
        ) : undefined}
        onCloseMenu={() => {
          if (!sessionActionBusy) {
            setMoveMenuSessionId(undefined);
            setMenuSessionId(undefined);
          }
        }}
        onOpenMoveMenu={() => {
          if (!menuSession) return;
          setSessionActionError(undefined);
          setMoveMenuSessionId(menuSession.sessionId);
        }}
        onBackFromMoveMenu={() => {
          setSessionActionError(undefined);
          setMoveMenuSessionId(undefined);
        }}
        onMoveToSection={(sectionId) => menuSession && moveSessionToSection(menuSession.sessionId, sectionId)}
        onStartRename={() => {
          if (!menuSession) return;
          setRenameTitle(menuSession.title);
          setSessionActionError(undefined);
          setRenameOpen(true);
        }}
        onChangeRenameTitle={(title) => {
          setRenameTitle(title);
          if (sessionActionError) setSessionActionError(undefined);
        }}
        onSubmitRename={renameSession}
        onCloseRename={closeRename}
        onOpenConfiguration={menuSession && canConfigureSession(menuSession, snapshot)
          ? () => {
              setConfigurationSessionId(menuSession.sessionId);
              setMenuSessionId(undefined);
            }
          : undefined}
        syncAction={menuSession ? {
          refreshing,
          syncFlash,
          disabled: refreshing,
          onSync: () => runRefresh(menuSession.sessionId),
        } : undefined}
        onFork={menuSession && menuSupportsFork ? () => forkSessionById(menuSession.sessionId) : undefined}
        onArchive={menuSession && onArchiveSession ? (archived) => archiveSessionById(menuSession.sessionId, archived) : undefined}
        onRequestDelete={onDeleteSession ? () => {
          setSessionActionError(undefined);
          setDeleteSessionConfirmOpen(true);
        } : undefined}
        onCancelDelete={() => {
          if (!sessionActionBusy) setDeleteSessionConfirmOpen(false);
        }}
        onConfirmDelete={() => menuSession && deleteSessionById(menuSession.sessionId)}
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
      {createDialogState && snapshot && (
        <SessionCreateDialog
          key={`${snapshot.host.hostId}:${createDialogState.initialProjectId ?? ""}:${createDialogState.initialCwd ?? ""}:${createDialogState.onPickDirectory ? "pick" : "create"}`}
          snapshot={snapshot}
          connected={online}
          {...(createDialogState.initialProjectId ? { initialProjectId: createDialogState.initialProjectId } : {})}
          {...(createDialogState.initialCwd ? { initialCwd: createDialogState.initialCwd } : {})}
          {...(createDialogState.onPickDirectory ? { onPickDirectory: createDialogState.onPickDirectory } : {})}
          {...(onBrowseDirectory ? { onBrowseDirectory } : {})}
          {...(onCreateDirectory ? { onCreateDirectory } : {})}
          onCreate={onCreateSession}
          onCreated={(created) => {
            const pendingPrompt = createDialogState.pendingPrompt;
            setCollapsedProjectIds((current) => expandProject(current, created.projectId));
            setCreateDialogState(undefined);
            if (pendingPrompt?.trim()) {
              deliverInitialPromptToSession(created, pendingPrompt);
            }
            void Promise.resolve(onRefresh()).then(() => selectSession(created.sessionId));
          }}
          onClose={() => setCreateDialogState(undefined)}
        />
      )}
    </>
  );

  const assistantAvailable = Boolean(
    mobileNav?.assistantAvailable
    ?? snapshot?.host.capabilities.some(capability => capability === "plugin.assistant-mail.v1" || capability === ASSISTANT_AGENDA_CAPABILITY),
  );

  if (!visible) {
    if (hasPortalOverlay && typeof document !== "undefined" && document.body) {
      return createPortal(sessionOverlays, document.body);
    }
    return null;
  }

  if (showingHomeCatalog) {
    return (
      <MobileSessionCatalog
        open
        hosts={hosts}
        activeHostId={activeHostId}
        onSelectHost={onSelectHost}
        onAddHost={onAddHost}
        hostSwitcherOpen={hostSwitcherOpen}
        onToggleHostSwitcher={() => setHostSwitcherOpen((current) => !current)}
        activeTab={activeTab}
        onSelectTab={onSelectTab ?? mobileNav?.onTabChange}
        assistantAvailable={assistantAvailable}
        assistantEntry={assistantEntry}
        themeControl={themeControl}
        onStartNewChat={startNewChat}
        selectedSessionId={undefined}
        archivedExpanded={archivedExpanded}
        onToggleArchived={() => setArchivedExpanded((current) => !current)}
        expandedEmptyProjectIds={expandedEmptyProjectIds}
        revealedEmptySectionKey={revealedEmptySectionKey}
        desktopName={desktopName}
        connection={connection}
        desktopOnline={desktopOnline}
        snapshot={snapshot}
        sessions={sessions}
        archivedSessions={archivedSessions}
        archivedFamilies={archivedFamilies}
        grouped={grouped}
        collapsedProjectIds={collapsedProjectIds}
        expandedForkParents={expandedForkParents}
        expandedOlderSessions={expandedOlderSessions}
        toggleOlderSessions={toggleOlderSessions}
        projectOrder={projectOrder}
        projectsByActivity={projectsByActivity}
        permissions={permissions}
        connectionIssue={connectionIssue}
        manualReconnect={manualReconnect}
        onInspectConnection={onInspectConnection}
        transportMetrics={transportMetrics}
        search={search}
        directoryRef={directoryRef}
        directoryScrollPositions={directoryScrollPositions}
        projectOrderOpen={projectOrderOpen}
        sectionCreate={sectionCreate}
        sectionCanCreate={sectionCanCreate}
        sectionManage={sectionManage}
        sessionOverlays={sessionOverlays}
        onBackToHosts={onBackToHosts}
        onRetry={onRetry}
        onCreateSection={onCreateSection}
        selectSession={selectSession}
        setSearch={setSearch}
        setProjectOrderOpen={setProjectOrderOpen}
        setSectionCreate={setSectionCreate}
        onOpenSessionActions={(sessionId) => {
          setSessionActionError(undefined);
          setMoveMenuSessionId(undefined);
          setMenuSessionId(sessionId);
        }}
        toggleProject={toggleProject}
        toggleForkGroup={toggleForkGroup}
        openCreateDialogForProject={openCreateDialogForProject}
        placeProjects={placeProjects}
        closeSectionCreate={closeSectionCreate}
        createSection={createSection}
        sessionDrag={sessionDrag}
        manualSections={manualSections}
        sessionActionError={!menuSession && !renameOpen ? sessionActionError : undefined}
        onActivateClaude={visible ? onActivateClaude : undefined}
      />
    );
  }

  return (
    <>
      <div className="mobile-workspace-canvas">
        {selectedSession && (
          <div className="mobile-conversation-slot" hidden={newChatMode}>
          <ConversationView
            variant="mobile"
            hostId={activeHostId}
            session={selectedSession}
            sessions={sessions}
            snapshot={snapshot}
            connection={connection}
            desktopOnline={desktopOnline}
            visible={visible && !newChatMode}
            navigation
            onBackToCatalog={closeToCatalog}
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
            sessionMenu={{
              open() {
                setSessionActionError(undefined);
                setMoveMenuSessionId(undefined);
                setMenuSessionId(selectedSession.sessionId);
              },
              requestRename: canRename(selectedSession) ? (target) => {
                setMenuSessionId(target.sessionId);
                setRenameTitle(target.title);
                setSessionActionError(undefined);
                setRenameOpen(true);
              } : undefined,
            }}
            refreshing={refreshing}
            onRefresh={runRefresh}
            onRetry={onRetry}
            history={selectedHistory}
            evidence={selectedEvidence}
            renderEvidence={(panel) => (
              <EvidencePanel
                {...panel}
                previews={artifactPreviews}
                transfers={artifactTransfers}
                onLoadMore={() => onLoadOlderEvidence(selectedSession.sessionId)}
                onLoadDetails={onLoadEvidenceDetails}
                onPreview={onPreviewArtifact}
                onDownload={onDownloadArtifact}
              />
            )}
            permissions={permissions}
            events={events}
            localTurns={localTurns}
            connectionIssue={connectionIssue}
            mailCards={mailCards}
            composerBanner={<MailReference sessionId={selectedSession.sessionId} />}
            resolveMailRefId={() => assistantMail?.referenceFor(selectedSession.sessionId)}
            onOpenSession={onOpenSession}
            onLoadOlderHistory={onLoadOlderHistory}
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
          </div>
        )}
        {(!selectedSession || newChatMode) && (
          <main className="mobile-workspace new-chat-workspace">
            <NewChatCanvas
              key={`${activeHostId ?? ""}:${newChatTarget?.key ?? 0}`}
              mobile
              hostId={activeHostId}
              snapshot={snapshot}
              connected={online}
              conversationDrafts={conversationDrafts}
              {...(newChatTarget?.initialProjectId !== undefined ? { initialProjectId: newChatTarget.initialProjectId } : {})}
              {...(newChatTarget?.initialCwd !== undefined ? { initialCwd: newChatTarget.initialCwd } : {})}
              onBack={leaveNewChat}
              backLabel={newChatReturnSession ? "返回会话" : "返回会话列表"}
              onOpenDirectoryPicker={openDirectoryPickerFromCanvas}
              {...(supportsCreateSection && onCreateSection
                ? {
                    onCreateSection: (name: string) => createSectionFromName(name, { clearSearch: false }),
                  }
                : {})}
              onLoadSessionConfiguration={onLoadSessionConfiguration}
              onConfigureSession={onConfigureSession}
              onCreateSession={onCreateSession}
              onUploadFile={onUploadFile ? (...args) => onUploadFile(...args, activeHostId) : undefined}
              onSendFirstTurn={(session, text, attachments) => onSendTurn(session.sessionId, text, attachments, undefined, { hostId: activeHostId, session })}
              onSessionCreated={handleNewChatCreated}
              onActivateClaude={visible ? onActivateClaude : undefined}
            />
          </main>
        )}
      </div>
      {sessionOverlays}
    </>
  );
}
