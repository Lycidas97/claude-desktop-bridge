import type {
  BridgeDesktopRuntimeId,
  BridgeDirectoryListing,
  BridgeEvent,
  BridgeProjectInfo,
  BridgeResponse,
  BridgeSessionInfo,
  DesktopControlSnapshot,
  LocalBridgeRequest,
} from "@bridge/protocol";
import {
  AlertTriangle,
  Mail,
  MoreHorizontal,
  PanelLeft,
  Plus,
  Search,
  Settings2,
  SquarePen,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ThemeControl } from "../../hooks/useTheme.js";
import {
  CLAUDE_UNSECTIONED_PROJECT_ID,
  expandProject,
  getSessionAncestorIds,
  groupProjectSessionFamilies,
} from "../../lib/project-groups.js";
import { desktopRuntimeId } from "../../lib/runtime-labels.js";
import { useAssistantMail } from "../assistant/AssistantMailProvider.js";
import { EmptyState } from "../common/EmptyState.js";
import { IconButton } from "../common/IconButton.js";
import { ThemeMenu } from "../common/ThemeMenu.js";
import { useConversationDrafts } from "../conversation/ConversationDraftsProvider.js";
import { ProjectOrderSheet } from "../mobile/ProjectOrderSheet.js";
import { NewChatCanvas, type NewChatDirectoryPickerRequest } from "../session/NewChatCanvas.js";
import { ProjectGroupHeader } from "../session/ProjectGroupHeader.js";
import { SectionCreateDialog, type SectionCreateState } from "../session/SectionCreateDialog.js";
import { SectionManageDialog, useSectionManage } from "../session/SectionManageDialog.js";
import { SessionActionSheets } from "../session/SessionActionSheets.js";
import { SessionCreateDialog } from "../session/SessionCreateDialog.js";
import { SessionFamilyList } from "../session/SessionFamilyList.js";
import { useProjectSessionGroups } from "../session/useProjectSessionGroups.js";
import { useSeenSessionCompletions } from "../session/useSeenSessionCompletions.js";
import { useSessionMenuAction } from "../session/useSessionMenuAction.js";
import {
  SessionSectionDragGhost,
  UNSECTIONED_DROP_ID,
  useSessionSectionDrag,
} from "../session/useSessionSectionDrag.js";
import "../session/section-create.css";
import {
  DesktopSessionConversation,
  unwrap,
  useDesktopConversation,
} from "./DesktopSessionConversation.js";

export { unwrap };

export type DesktopWorkspaceTab = "sessions" | "assistant" | "settings";

export function connectionLabel(snapshot: DesktopControlSnapshot): string {
  if (snapshot.host.version.startsWith("0.2.")) return "需要升级";
  if (snapshot.connection === "connecting" || snapshot.connection === "reconnecting") return "正在重连";
  if (snapshot.connection !== "connected") return "主机离线";
  if (snapshot.transport?.path === "direct") return "直连";
  if (snapshot.transport?.path === "public-relay") return "安全中继";
  return "局域网连接";
}

export function DesktopAssistantNavButton({
  active,
  onSelect,
}: {
  active: boolean;
  onSelect(): void;
}) {
  const assistantMail = useAssistantMail();
  const unreadCount = assistantMail?.unreadCount ?? 0;
  return (
    <button
      className={`sidebar-assistant-row${active ? " active" : ""}`}
      type="button"
      aria-current={active ? "page" : undefined}
      onClick={onSelect}
    >
      <span className="sidebar-assistant-main">
        <Mail size={15} aria-hidden="true" />
        <span>助理</span>
      </span>
      {unreadCount > 0 && (
        <span className="sidebar-assistant-unread" aria-hidden="true">
          <i className="sidebar-unread-dot" />
          <b className="desktop-nav-badge" aria-hidden="true">
            {unreadCount > 99 ? "99+" : unreadCount}
          </b>
        </span>
      )}
    </button>
  );
}

export function DesktopSessions({
  snapshot,
  events,
  apiRequest,
  onRefreshSnapshot,
  initialSessionId,
  focusRequest,
  activeTab = "sessions",
  onSelectTab,
  themeControl,
  renderRightCanvas,
}: {
  initialSessionId?: string | undefined;
  focusRequest?: { sessionId: string; key: number } | undefined;
  snapshot: DesktopControlSnapshot;
  events: BridgeEvent[];
  apiRequest(request: LocalBridgeRequest): Promise<BridgeResponse>;
  onRefreshSnapshot(): Promise<void>;
  activeTab?: DesktopWorkspaceTab | undefined;
  onSelectTab?: ((tab: DesktopWorkspaceTab) => void) | undefined;
  themeControl?: ThemeControl | undefined;
  renderRightCanvas?: ((headerLeading: ReactNode) => ReactNode) | undefined;
}) {
  const controller = useDesktopConversation();
  const conversationDrafts = useConversationDrafts(snapshot.host.hostId);

  const hostId = snapshot.host.hostId;
  const hostOnline = snapshot.connection === "connected" && !snapshot.host.version.startsWith("0.2.");
  const hostEvents = controller.filterEvents(events, hostId);

  const firstActiveId = snapshot.sessions.find((session) => !session.archivedAt)?.sessionId;
  const storedSelectedId = controller.selectedSessionFor(hostId);
  const selectedId = storedSelectedId !== undefined
    ? storedSelectedId
    : (initialSessionId ?? firstActiveId);

  const {
    search,
    setSearch,
    searchQuery,
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
    activeSessions,
    projectsByActivity,
    projectOrder,
    managedProjectId,
    grouped,
    archivedSessions,
    archivedFamilies,
    placeProjects,
    toggleProject,
    toggleForkGroup,
    registerCreatedSection,
  } = useProjectSessionGroups({
    hostId,
    projects: snapshot.projects,
    sessions: snapshot.sessions,
    selectedSessionId: selectedId,
  });

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [newChatTarget, setNewChatTarget] = useState<{
    key: number;
    initialProjectId?: string | undefined;
    initialCwd?: string | undefined;
  }>();
  const [createDialogState, setCreateDialogState] = useState<NewChatDirectoryPickerRequest>();
  const [sectionCreate, setSectionCreate] = useState<SectionCreateState>();
  const [resetError, setResetError] = useState<string>();
  const [rowMenuSessionId, setRowMenuSessionId] = useState<string>();
  const [rowMoveMenuSessionId, setRowMoveMenuSessionId] = useState<string>();
  const [rowRenameSessionId, setRowRenameSessionId] = useState<string>();
  const [rowRenameTitle, setRowRenameTitle] = useState("");
  const [rowDeleteSessionId, setRowDeleteSessionId] = useState<string>();
  const { busy: rowActionBusy, error: rowActionError, setError: setRowActionError, run: runRowAction } = useSessionMenuAction();
  const desktopProjectListRef = useRef<HTMLDivElement>(null);
  const rowRenameDialogRef = useRef<HTMLElement>(null);
  const handledResetEventsRef = useRef(new Set<string>());
  const pendingResetRef = useRef<{ hostId: string; sessionId: string } | undefined>(undefined);
  const handledFocusKeyRef = useRef<number | undefined>(undefined);

  function setSelectedId(sessionId: string | undefined): void {
    setResetError(undefined);
    controller.selectSession(hostId, sessionId);
  }

  function selectSessionFromSidebar(sessionId: string): void {
    pendingResetRef.current = undefined;
    setNewChatTarget(undefined);
    setSelectedId(sessionId);
    if (activeTab !== "sessions") {
      onSelectTab?.("sessions");
    }
  }

  const handleRenameSection = useMemo(
    () => (snapshot.host.capabilities.includes("section.rename.v1")
      ? async (sectionId: string, name: string) => {
          const result = unwrap<{ project?: BridgeProjectInfo; projects?: BridgeProjectInfo[]; sessions?: BridgeSessionInfo[] }>(
            await apiRequest({ method: "section.rename", params: { sectionId, name } }),
          );
          await onRefreshSnapshot();
          return result;
        }
      : undefined),
    [apiRequest, onRefreshSnapshot, snapshot.host.capabilities],
  );

  const handleDeleteSection = useMemo(
    () => (snapshot.host.capabilities.includes("section.delete.v1")
      ? async (sectionId: string) => {
          const result = unwrap<{ projects?: BridgeProjectInfo[]; sessions?: BridgeSessionInfo[] }>(
            await apiRequest({ method: "section.delete", params: { sectionId } }),
          );
          await onRefreshSnapshot();
          return result;
        }
      : undefined),
    [apiRequest, onRefreshSnapshot, snapshot.host.capabilities],
  );

  const handleBrowseDirectory = useMemo(
    () => (snapshot.host.capabilities.includes("directory.browse.v1")
      ? async (path?: string) => (
          unwrap<{ listing: BridgeDirectoryListing }>(
            await apiRequest({ method: "directory.list", params: path ? { path } : {} }),
          ).listing
        )
      : undefined),
    [apiRequest, snapshot.host.capabilities],
  );

  const handleCreateDirectory = useMemo(
    () => (snapshot.host.capabilities.includes("directory.mkdir.v1")
      ? async (parentPath: string, name: string) => (
          unwrap<{ path: string }>(
            await apiRequest({ method: "directory.mkdir", params: { parentPath, name } }),
          ).path
        )
      : undefined),
    [apiRequest, snapshot.host.capabilities],
  );

  const sectionManage = useSectionManage({
    activeHostId: hostId,
    desktopName: snapshot.host.name,
    snapshot,
    connection: "connected",
    desktopOnline: true,
    onRenameSection: handleRenameSection,
    onDeleteSection: handleDeleteSection,
  });

  function startNewChat(targetProjectId?: string, targetCwd?: string): void {
    setCreateDialogState(undefined);
    setRowMoveMenuSessionId(undefined);
    setRowRenameSessionId(undefined);
    setRowMenuSessionId(undefined);
    setNewChatTarget((previous) => ({
      key: (previous?.key ?? 0) + 1,
      ...(targetProjectId !== undefined ? { initialProjectId: targetProjectId } : {}),
      ...(targetCwd !== undefined ? { initialCwd: targetCwd } : {}),
    }));
    if (activeTab !== "sessions") {
      onSelectTab?.("sessions");
    }
  }

  function openCreateDialogForProject(targetProjectId?: string): void {
    startNewChat(targetProjectId);
  }

  function openDirectoryPickerFromCanvas(request?: NewChatDirectoryPickerRequest): void {
    setCreateDialogState(request ?? {});
  }

  function jumpToSession(sessionId: string): void {
    const target = snapshot.sessions.find((candidate) => candidate.sessionId === sessionId);
    if (target) {
      setCollapsedProjectIds((current) => expandProject(current, target.projectId));
      if (target.archivedAt) setArchivedExpanded(true);
      const ancestors = getSessionAncestorIds(snapshot.sessions, target.sessionId);
      if (ancestors.length > 0) {
        setExpandedForkParents((current) => new Set([...current, ...ancestors]));
      }
    }
    if (search.trim()) setSearch("");
    selectSessionFromSidebar(sessionId);
  }

  const supportsCreateSection = snapshot.host.capabilities.includes("section.create.v1");
  const sectionCanCreate = Boolean(
    supportsCreateSection
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
    const { project } = unwrap<{ project?: BridgeProjectInfo }>(await apiRequest({
      method: "section.create",
      params: { name: rawName.trim() },
    }));
    if (!project) throw new Error("Section 未创建，请重试。");
    sectionManage.revealEmptySections();
    registerCreatedSection(project.projectId, options);
    await onRefreshSnapshot();
    return project;
  }

  async function createSection(): Promise<void> {
    if (!sectionCanCreate || !sectionCreate) return;
    setSectionCreate({ ...sectionCreate, busy: true, error: "" });
    try {
      await createSectionFromName(sectionCreate.name, { clearSearch: true });
      setSectionCreate(undefined);
    } catch (reason) {
      setSectionCreate({
        ...sectionCreate,
        busy: false,
        error: reason instanceof Error ? reason.message : "Section 创建失败",
      });
    }
  }

  useEffect(() => {
    if (!focusRequest || handledFocusKeyRef.current === focusRequest.key) return;
    handledFocusKeyRef.current = focusRequest.key;
    jumpToSession(focusRequest.sessionId);
  }, [focusRequest, hostId, snapshot.sessions]);

  const selected = snapshot.sessions.find((session) => session.sessionId === selectedId);
  const seenCompletions = useSeenSessionCompletions(hostId);
  const visibilityAvailable = snapshot.host.capabilities.includes("session.visibility.v1");
  const hasActiveSessions = activeSessions.length > 0;

  useEffect(() => {
    for (const event of hostEvents) {
      if (event.type !== "session.reset") continue;
      const eventKey = `${hostId}:${event.eventId}`;
      if (handledResetEventsRef.current.has(eventKey)) continue;
      handledResetEventsRef.current.add(eventKey);
      if (event.data.previousSessionId === selectedId && typeof event.data.sessionId === "string") {
        const nextSessionId = event.data.sessionId;
        setResetError(undefined);
        controller.resetSessionHistory(nextSessionId, hostId);
        conversationDrafts.resetSession(hostId, nextSessionId);
        pendingResetRef.current = { hostId, sessionId: nextSessionId };
        void onRefreshSnapshot()
          .catch((reason) => setResetError(reason instanceof Error ? reason.message : "新会话打开失败"));
      }
    }

    const pendingReset = pendingResetRef.current;
    if (pendingReset?.hostId === hostId && snapshot.sessions.some((session) => session.sessionId === pendingReset.sessionId)) {
      pendingResetRef.current = undefined;
      setSelectedId(pendingReset.sessionId);
    } else if (!selected) {
      setSelectedId(activeSessions[0]?.sessionId);
    }
  }, [events, hostId, selectedId, activeSessions, snapshot.sessions]);

  useEffect(() => {
    if (!rowRenameSessionId || !rowActionBusy) return;
    rowRenameDialogRef.current?.focus();
  }, [rowActionBusy, rowRenameSessionId]);

  async function createSession(
    cwd: string,
    title?: string,
    runtimeId?: BridgeDesktopRuntimeId,
    projectId?: string,
    trustWorkspace?: boolean,
  ): Promise<BridgeSessionInfo> {
    const canTrust = trustWorkspace === true && snapshot.host.capabilities.includes("workspace.trust.v1");
    const result = unwrap<{ session: BridgeSessionInfo }>(await apiRequest({
      method: "session.create",
      params: {
        cwd,
        ...(title ? { title } : {}),
        ...(runtimeId ? { runtimeId } : {}),
        ...(projectId ? { projectId } : {}),
        ...(canTrust ? { trustWorkspace: true } : {}),
      },
    }));
    await onRefreshSnapshot();
    return result.session;
  }

  function deliverInitialPromptToSession(created: BridgeSessionInfo, rawPrompt: string): void {
    const trimmed = rawPrompt.trim();
    if (!trimmed) return;
    const targetDraft = conversationDrafts.session(hostId, created.sessionId, controller.uploadFile);
    targetDraft.updateDraft((current) => ({
      ...current,
      text: "",
      sending: true,
      imageError: undefined,
    }));
    void controller.sendTurn(created.sessionId, trimmed, [])
      .then(async () => {
        targetDraft.updateDraft((current) => ({ ...current, sending: false }));
        await onRefreshSnapshot();
      })
      .catch((error: unknown) => {
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
    setNewChatTarget(undefined);
    setCollapsedProjectIds((current) => expandProject(current, created.projectId));
    if (search.trim()) setSearch("");
    if (options?.configurationError) {
      const targetDraft = conversationDrafts.session(hostId, created.sessionId, controller.uploadFile);
      const pendingText = options.initialPrompt?.trim() ?? "";
      targetDraft.updateDraft((current) => ({
        ...current,
        imageError: options.configurationError,
        text: [pendingText, current.text].filter(Boolean).join("\n"),
      }));
    } else if (options?.initialPrompt?.trim()) {
      deliverInitialPromptToSession(created, options.initialPrompt);
    }
    selectSessionFromSidebar(created.sessionId);
  }

  async function moveSessionToSection(sessionId: string, sectionId: string | null): Promise<void> {
    if (!hostOnline) return;
    await runRowAction("移动分组失败", async () => {
      const moved = await controller.moveSessionSection(sessionId, sectionId);
      const targetProjectId = sectionId ?? moved.session?.projectId ?? CLAUDE_UNSECTIONED_PROJECT_ID;
      setCollapsedProjectIds((current) => expandProject(current, targetProjectId));
      setRowMoveMenuSessionId(undefined);
      setRowMenuSessionId(undefined);
    });
  }

  const sessionDrag = useSessionSectionDrag({
    hostOnline,
    capabilities: snapshot.host.capabilities,
    manualSections,
    sessions: snapshot.sessions,
    scrollContainerRef: desktopProjectListRef,
    onMoveSessionSection: moveSessionToSection,
  });

  function closeRowRename(): void {
    if (rowActionBusy) return;
    setRowRenameSessionId(undefined);
    setRowMenuSessionId(undefined);
  }

  async function submitRowRename(): Promise<void> {
    const target = rowRenameSessionId
      ? snapshot.sessions.find((candidate) => candidate.sessionId === rowRenameSessionId)
      : undefined;
    const trimmed = rowRenameTitle.trim();
    if (!target || !trimmed || trimmed === target.title) return;
    await runRowAction("重命名会话失败", async () => {
      await controller.renameSession(target.sessionId, trimmed);
      setRowRenameSessionId(undefined);
      setRowMenuSessionId(undefined);
    });
  }

  const sidebarToggleButton = (
    <IconButton
      label={sidebarCollapsed ? "展开侧栏" : "收起侧栏"}
      className="desktop-sidebar-toggle"
      onClick={() => setSidebarCollapsed((current) => !current)}
    >
      <PanelLeft size={17} />
    </IconButton>
  );

  const rowMenuSession = rowMenuSessionId
    ? snapshot.sessions.find((candidate) => candidate.sessionId === rowMenuSessionId)
    : undefined;
  const rowRenameSession = rowRenameSessionId
    ? snapshot.sessions.find((candidate) => candidate.sessionId === rowRenameSessionId)
    : undefined;
  const rowDeleteSession = rowDeleteSessionId
    ? snapshot.sessions.find((candidate) => candidate.sessionId === rowDeleteSessionId)
    : undefined;
  const rowMoveMenuOpen = Boolean(rowMenuSession && rowMoveMenuSessionId === rowMenuSession.sessionId);
  const rowMenuSupportsRename = Boolean(
    rowMenuSession && (
      (snapshot.host.capabilities.includes("session.command.v1") && desktopRuntimeId(rowMenuSession) === "claude-desktop")
      || snapshot.host.capabilities.includes("session.rename.v1")
    ),
  );
  const rowMenuSupportsMoveSection = Boolean(
    rowMenuSession
    && snapshot.host.capabilities.includes("section.move.v1")
    && rowMenuSession.allowedActions?.canMoveSection,
  );
  const rowMenuSupportsFork = Boolean(
    rowMenuSession && rowMenuSession.projectId !== managedProjectId && desktopRuntimeId(rowMenuSession) === "claude-desktop",
  );

  const showProjectTree = hasActiveSessions || Boolean(searchQuery || managedProjectId);
  const hasRenderedUnsectionedGroup = grouped.some((group) => group.projectId === CLAUDE_UNSECTIONED_PROJECT_ID);
  const showUnsectionedDropZone = Boolean(
    sessionDrag.dragState
    && sessionDrag.dragState.originSectionId !== UNSECTIONED_DROP_ID
    && !hasRenderedUnsectionedGroup,
  );

  return (
    <section className={`desktop-session-layout${sidebarCollapsed ? " is-sidebar-collapsed" : ""}`}>
      {!sidebarCollapsed && (
        <aside className="desktop-session-sidebar is-flat-tree">
          <div className="desktop-sidebar-heading">
            <div
              className="desktop-sidebar-host"
              title={`${snapshot.host.name} · ${connectionLabel(snapshot)}`}
            >
              <i className={`m-status-dot ${hostOnline ? "is-online" : ""}`} aria-hidden="true" />
              <strong>{snapshot.host.name}</strong>
            </div>
            <div className="desktop-sidebar-actions">
              <IconButton
                label="新建会话"
                onClick={() => openCreateDialogForProject()}
              >
                <SquarePen size={16} />
              </IconButton>
            </div>
          </div>

          <div className="desktop-sidebar-top-stack">
            {snapshot.host.capabilities.includes("plugin.assistant-mail.v1") && onSelectTab && (
              <DesktopAssistantNavButton
                active={activeTab === "assistant"}
                onSelect={() => onSelectTab("assistant")}
              />
            )}
            <label className="session-search">
              <Search size={15} />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="搜索项目或会话"
              />
            </label>
          </div>

          <div className="desktop-project-list" ref={desktopProjectListRef}>
            {!searchQuery && (supportsCreateSection || projectOrder.length > 1 || hasActiveSessions) && (
              <div className="project-order-bar sidebar-section-bar">
                <span className="sidebar-section-label">项目</span>
                <div className="sidebar-section-actions">
                  {supportsCreateSection && (
                    <button
                      type="button"
                      className="sidebar-micro-action"
                      onClick={() => setSectionCreate({ name: "", busy: false, error: "" })}
                    >
                      + 分组
                    </button>
                  )}
                  {projectOrder.length > 1 && (
                    <button
                      type="button"
                      className="sidebar-micro-action project-order-trigger"
                      aria-label="调整顺序"
                      onClick={() => setProjectOrderOpen(true)}
                    >
                      排序
                    </button>
                  )}
                </div>
              </div>
            )}

            {snapshot.permissions[0] && (
              <button
                type="button"
                className="host-permission-alert"
                onClick={() => jumpToSession(snapshot.permissions[0]!.sessionId)}
              >
                <span className="permission-dock-icon"><AlertTriangle size={16} /></span>
                <span>
                  <strong>{snapshot.permissions[0].toolName === "AskUserQuestion" ? "有提问待你回答" : "有操作待你授权"}</strong>
                  <small>{snapshot.sessions.find((session) => session.sessionId === snapshot.permissions[0]!.sessionId)?.title ?? snapshot.permissions[0]!.toolName}</small>
                </span>
                <b>{snapshot.permissions.length > 1 ? `${snapshot.permissions.length} 项` : "查看"}</b>
              </button>
            )}

            {!rowMenuSession && !rowRenameSession && rowActionError && (
              <p className="m-sheet-note is-error sidebar-action-error" role="alert">{rowActionError}</p>
            )}

            {searchQuery ? (
              grouped.length === 0 && (
                <EmptyState title="没有匹配的会话" description="换一个关键词试试。" />
              )
            ) : (
              !hasActiveSessions && (
                <EmptyState
                  title={snapshot.runtime.desktopIntegration.state === "ready" ? "暂无活跃会话" : "未检测到 Claude Desktop"}
                  {...(snapshot.projects.length > 0
                    ? { description: `已配置 ${snapshot.projects.length} 个项目分组，开始提问后自动归入对应目录` }
                    : {})}
                  action={(
                    <button
                      type="button"
                      className="primary-button session-catalog-empty-action"
                      onClick={() => openCreateDialogForProject()}
                    >
                      <Plus size={15} />
                      新建会话
                    </button>
                  )}
                />
              )
            )}

            {(showProjectTree || (!searchQuery && visibilityAvailable && archivedSessions.length > 0)) && (
              <div className="project-groups">
                {showProjectTree && grouped.map((group) => {
                  const { projectId: groupProjectId, project, sessions } = group;
                  const projectName = project?.name ?? sessions[0]?.projectName ?? groupProjectId;
                  const families = groupProjectSessionFamilies(sessions);
                  const isEmptyGroup = families.length === 0;
                  const expanded = Boolean(searchQuery) || (
                    isEmptyGroup
                      ? (groupProjectId === revealedEmptySectionKey || expandedEmptyProjectIds.has(groupProjectId))
                      : !collapsedProjectIds.has(groupProjectId)
                  );
                  const sessionsId = `desktop-project-${encodeURIComponent(groupProjectId)}`;
                  const dropSectionId = project?.kind === "desktop-group"
                    ? groupProjectId
                    : groupProjectId === CLAUDE_UNSECTIONED_PROJECT_ID
                      ? UNSECTIONED_DROP_ID
                      : undefined;
                  const dropState = sessionDrag.dropZoneState(dropSectionId);
                  return (
                    <section
                      className={`project-group ${expanded ? "expanded" : "collapsed"}${isEmptyGroup ? " is-empty-group" : ""}${dropState === "target" ? " is-drop-target" : ""}${dropState === "origin" ? " is-drop-origin" : ""}`}
                      key={groupProjectId}
                      {...(dropSectionId ? { "data-drop-section-id": dropSectionId } : {})}
                    >
                      <ProjectGroupHeader
                        title={projectName}
                        count={families.length}
                        expanded={expanded}
                        controlsId={sessionsId}
                        onToggle={() => toggleProject(groupProjectId, isEmptyGroup)}
                        actions={(
                          <>
                            {!project?.managedAssistant && <IconButton
                              label={`新建会话：${projectName}`}
                              className="session-row-action"
                              onClick={() => openCreateDialogForProject(groupProjectId)}
                            >
                              <Plus size={16} />
                            </IconButton>}
                            {sectionManage.canManage(project) && (
                              <IconButton
                                label={`管理分组：${projectName}`}
                                className="session-row-action section-manage-trigger"
                                onClick={() => sectionManage.openMenu(groupProjectId)}
                              >
                                <MoreHorizontal size={16} />
                              </IconButton>
                            )}
                          </>
                        )}
                      />
                      {expanded && (
                        <div className="session-rows" id={sessionsId}>
                          {families.length > 0 ? (
                            <SessionFamilyList
                              families={families}
                              projects={snapshot.projects}
                              permissions={snapshot.permissions}
                              expandedForkParents={expandedForkParents}
                              selectedId={activeTab === "sessions" ? selectedId : undefined}
                              seenCompletions={seenCompletions}
                              flat
                              sessionDrag={sessionDrag}
                              actionLabel={(session) => `会话操作：${session.title}`}
                              onSelectSession={selectSessionFromSidebar}
                              onOpenSessionActions={(targetSessionId) => {
                                setRowActionError(undefined);
                                setRowMoveMenuSessionId(undefined);
                                setRowMenuSessionId(targetSessionId);
                              }}
                              onToggleForkGroup={toggleForkGroup}
                            />
                          ) : (
                            <div className="project-group-empty">此分组暂无会话</div>
                          )}
                        </div>
                      )}
                    </section>
                  );
                })}
                {showUnsectionedDropZone && (
                  <div
                    className={`project-group-unsectioned-dropzone${sessionDrag.dropZoneState(UNSECTIONED_DROP_ID) === "target" ? " is-drop-target" : ""}`}
                    data-drop-section-id={UNSECTIONED_DROP_ID}
                  >
                    拖到这里移出分组（未分组）
                  </div>
                )}
                {!searchQuery && visibilityAvailable && archivedSessions.length > 0 && (
                  <section className={`project-group archived-group ${archivedExpanded ? "expanded" : "collapsed"}`}>
                    <ProjectGroupHeader
                      title="已归档"
                      count={archivedFamilies.length}
                      expanded={archivedExpanded}
                      controlsId="desktop-archived-sessions"
                      onToggle={() => setArchivedExpanded((current) => !current)}
                    />
                    {archivedExpanded && (
                      <div id="desktop-archived-sessions">
                        <SessionFamilyList
                          families={archivedFamilies}
                          projects={snapshot.projects}
                          permissions={snapshot.permissions}
                          expandedForkParents={expandedForkParents}
                          selectedId={activeTab === "sessions" ? selectedId : undefined}
                          archivedList
                          flat
                          actionLabel={(session) => `会话操作：${session.title}`}
                          onSelectSession={selectSessionFromSidebar}
                          onOpenSessionActions={(targetSessionId) => {
                            setRowActionError(undefined);
                            setRowMoveMenuSessionId(undefined);
                            setRowMenuSessionId(targetSessionId);
                          }}
                          onToggleForkGroup={toggleForkGroup}
                        />
                      </div>
                    )}
                  </section>
                )}
              </div>
            )}
          </div>

          {(onSelectTab || themeControl) && (
            <footer className="desktop-sidebar-dock">
              {onSelectTab && (
                <button
                  type="button"
                  className={`desktop-dock-settings${activeTab === "settings" ? " active" : ""}`}
                  aria-current={activeTab === "settings" ? "page" : undefined}
                  onClick={() => onSelectTab("settings")}
                >
                  <Settings2 size={15} aria-hidden="true" />
                  <span>设置</span>
                </button>
              )}
              {themeControl && <ThemeMenu control={themeControl} side="right" iconSize={16} />}
            </footer>
          )}
        </aside>
      )}

      {activeTab !== "sessions" && renderRightCanvas ? (
        <div className="desktop-workspace-canvas">
          {renderRightCanvas(sidebarToggleButton)}
        </div>
      ) : (
        <section className="desktop-conversation">
          {selected && !newChatTarget ? (
            <DesktopSessionConversation
              session={selected}
              snapshot={snapshot}
              events={hostEvents}
              headerLeading={sidebarToggleButton}
              conversationDrafts={conversationDrafts}
              onSelectSession={selectSessionFromSidebar}
              onForkCreated={(parentSessionId) => {
                setExpandedForkParents((current) => new Set([
                  ...current,
                  ...getSessionAncestorIds(snapshot.sessions, parentSessionId),
                  parentSessionId,
                ]));
              }}
              {...(resetError ? { externalActionError: resetError } : {})}
            />
          ) : (
            <NewChatCanvas
              key={`${hostId}:${newChatTarget?.key ?? 0}`}
              hostId={hostId}
              snapshot={snapshot}
              connected={hostOnline}
              headerLeading={sidebarToggleButton}
              conversationDrafts={conversationDrafts}
              {...(selected && newChatTarget ? { onCancel: () => setNewChatTarget(undefined) } : {})}
              {...(newChatTarget?.initialProjectId !== undefined ? { initialProjectId: newChatTarget.initialProjectId } : {})}
              {...(newChatTarget?.initialCwd !== undefined ? { initialCwd: newChatTarget.initialCwd } : {})}
              {...(window.bridgeDesktop?.chooseDirectory
                ? { onChooseDirectory: (path?: string) => window.bridgeDesktop!.chooseDirectory!(path) }
                : {})}
              onOpenDirectoryPicker={openDirectoryPickerFromCanvas}
              {...(supportsCreateSection
                ? {
                    onCreateSection: (name: string) => createSectionFromName(name, { clearSearch: false }),
                  }
                : {})}
              onLoadSessionConfiguration={controller.loadSessionConfiguration}
              onConfigureSession={controller.configureSession}
              onCreateSession={createSession}
              onSessionCreated={handleNewChatCreated}
            />
          )}
        </section>
      )}

      <SessionSectionDragGhost dragState={sessionDrag.dragState} manualSections={manualSections} />

      <SessionActionSheets
        menuSession={rowMenuSession}
        renameSession={rowRenameSession}
        deleteSession={rowDeleteSession}
        moveMenuOpen={rowMoveMenuOpen}
        manualSections={manualSections}
        online={hostOnline}
        busy={rowActionBusy}
        error={rowActionError}
        supportsRename={rowMenuSupportsRename}
        renameDisabled={!hostOnline}
        supportsMoveSection={rowMenuSupportsMoveSection}
        supportsFork={rowMenuSupportsFork}
        renameTitle={rowRenameTitle}
        renameDialogRef={rowRenameDialogRef}
        onCloseMenu={() => {
          if (!rowActionBusy) {
            setRowMoveMenuSessionId(undefined);
            setRowMenuSessionId(undefined);
          }
        }}
        onOpenMoveMenu={() => {
          if (!rowMenuSession) return;
          setRowActionError(undefined);
          setRowMoveMenuSessionId(rowMenuSession.sessionId);
        }}
        onBackFromMoveMenu={() => {
          setRowActionError(undefined);
          setRowMoveMenuSessionId(undefined);
        }}
        onMoveToSection={(sectionId) => rowMenuSession && moveSessionToSection(rowMenuSession.sessionId, sectionId)}
        onStartRename={() => {
          if (!rowMenuSession) return;
          setRowRenameTitle(rowMenuSession.title);
          setRowActionError(undefined);
          setRowRenameSessionId(rowMenuSession.sessionId);
        }}
        onChangeRenameTitle={(title) => {
          setRowRenameTitle(title);
          if (rowActionError) setRowActionError(undefined);
        }}
        onSubmitRename={submitRowRename}
        onCloseRename={closeRowRename}
        onFork={rowMenuSession && rowMenuSupportsFork
          ? () => runRowAction("Fork 分支创建失败", async () => {
              const sourceId = rowMenuSession.sessionId;
              const created = await controller.forkSession(sourceId);
              setExpandedForkParents((current) => new Set([
                ...current,
                ...getSessionAncestorIds(snapshot.sessions, sourceId),
                sourceId,
              ]));
              await onRefreshSnapshot();
              setRowMenuSessionId(undefined);
              selectSessionFromSidebar(created.sessionId);
            })
          : undefined}
        onArchive={rowMenuSession && visibilityAvailable
          ? (archived) => runRowAction("归档设置失败", async () => {
              await controller.archiveSession(rowMenuSession.sessionId, archived);
              setRowMenuSessionId(undefined);
            })
          : undefined}
        onRequestDelete={rowMenuSession && visibilityAvailable
          ? () => {
              setRowActionError(undefined);
              setRowDeleteSessionId(rowMenuSession.sessionId);
            }
          : undefined}
        onCancelDelete={() => {
          if (!rowActionBusy) setRowDeleteSessionId(undefined);
        }}
        onConfirmDelete={() => {
          if (!rowDeleteSession) return;
          return runRowAction("删除会话失败", async () => {
            await controller.deleteSession(rowDeleteSession.sessionId);
            conversationDrafts.resetSession(hostId, rowDeleteSession.sessionId);
            setRowDeleteSessionId(undefined);
            setRowMenuSessionId(undefined);
          });
        }}
      />

      {projectOrderOpen && (
        <ProjectOrderSheet
          manageFocus
          desktopName={snapshot.host.name}
          projectOrder={projectOrder}
          projectsByActivity={projectsByActivity}
          projects={snapshot.projects}
          sessions={snapshot.sessions}
          onPlaceProjects={placeProjects}
          onClose={() => setProjectOrderOpen(false)}
        />
      )}
      <SectionCreateDialog
        state={sectionCreate}
        online={hostOnline}
        canSubmit={sectionCanCreate}
        onChangeName={(name) => sectionCreate && setSectionCreate({ ...sectionCreate, name, error: "" })}
        onSubmit={createSection}
        onClose={closeSectionCreate}
      />
      <SectionManageDialog controller={sectionManage} manageFocus />
      {createDialogState && (
        <SessionCreateDialog
          key={`${hostId}:${createDialogState.initialProjectId ?? ""}:${createDialogState.initialCwd ?? ""}:${createDialogState.onPickDirectory ? "pick" : "create"}`}
          snapshot={snapshot}
          connected={hostOnline}
          {...(createDialogState.initialProjectId ? { initialProjectId: createDialogState.initialProjectId } : {})}
          {...(createDialogState.initialCwd ? { initialCwd: createDialogState.initialCwd } : {})}
          {...(createDialogState.onPickDirectory ? { onPickDirectory: createDialogState.onPickDirectory } : {})}
          {...(handleBrowseDirectory ? { onBrowseDirectory: handleBrowseDirectory } : {})}
          {...(handleCreateDirectory ? { onCreateDirectory: handleCreateDirectory } : {})}
          {...(window.bridgeDesktop?.chooseDirectory ? { onChooseDirectory: (path?: string) => window.bridgeDesktop!.chooseDirectory!(path) } : {})}
          onCreate={createSession}
          onCreated={(created) => {
            const pendingPrompt = createDialogState.pendingPrompt;
            setCollapsedProjectIds((current) => expandProject(current, created.projectId));
            if (search.trim()) setSearch("");
            if (pendingPrompt?.trim()) {
              deliverInitialPromptToSession(created, pendingPrompt);
            }
            selectSessionFromSidebar(created.sessionId);
          }}
          onClose={() => setCreateDialogState(undefined)}
        />
      )}
    </section>
  );
}

export { DesktopSessions as DesktopSessionsPane };
