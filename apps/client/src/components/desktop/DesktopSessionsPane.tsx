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
  Archive,
  ArchiveRestore,
  FolderPlus,
  GitFork,
  Mail,
  MoreHorizontal,
  PanelLeft,
  Plus,
  Search,
  Settings2,
  SquarePen,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ThemeControl } from "../../hooks/useTheme.js";
import {
  expandProject,
  getSessionAncestorIds,
  groupProjectSessionFamilies,
  orderProjects,
  sortProjectSessionsByRecent,
  toggleCollapsedProject,
} from "../../lib/project-groups.js";
import { desktopRuntimeId, desktopRuntimeName } from "../../lib/runtime-labels.js";
import { useAssistantMail } from "../assistant/AssistantMailProvider.js";
import { ConfirmationDialog } from "../common/ConfirmationDialog.js";
import { EmptyState } from "../common/EmptyState.js";
import { IconButton } from "../common/IconButton.js";
import { Sheet, SheetAction } from "../common/Sheet.js";
import { ThemeMenu } from "../common/ThemeMenu.js";
import { useConversationDrafts } from "../conversation/ConversationDraftsProvider.js";
import { ProjectOrderSheet } from "../mobile/ProjectOrderSheet.js";
import { NewChatCanvas, type NewChatDirectoryPickerRequest } from "../session/NewChatCanvas.js";
import { ProjectGroupHeader } from "../session/ProjectGroupHeader.js";
import { SectionManageDialog, useSectionManage } from "../session/SectionManageDialog.js";
import { SessionCreateDialog } from "../session/SessionCreateDialog.js";
import { SessionFamilyList } from "../session/SessionFamilyList.js";
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
  const controller = useDesktopConversation({
    snapshot,
    events,
    apiRequest,
    onRefreshSnapshot,
  });
  const conversationDrafts = useConversationDrafts(snapshot.host.hostId);

  const hostId = snapshot.host.hostId;
  const hostOnline = snapshot.connection === "connected" && !snapshot.host.version.startsWith("0.2.");
  const hostEvents = controller.filterEvents(events, hostId);

  const activeSessions = useMemo(
    () => snapshot.sessions.filter((session) => !session.archivedAt),
    [snapshot.sessions],
  );
  const storedSelectedId = controller.selectedSessionFor(hostId);
  const selectedId = storedSelectedId !== undefined
    ? storedSelectedId
    : (initialSessionId ?? activeSessions[0]?.sessionId);

  function setSelectedId(sessionId: string | undefined): void {
    setResetError(undefined);
    controller.selectSession(hostId, sessionId);
  }

  function selectSessionFromSidebar(sessionId: string): void {
    setNewChatTarget(undefined);
    setSelectedId(sessionId);
    if (activeTab !== "sessions") {
      onSelectTab?.("sessions");
    }
  }

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [search, setSearch] = useState("");
  const [newChatTarget, setNewChatTarget] = useState<{
    key: number;
    initialProjectId?: string | undefined;
    initialCwd?: string | undefined;
  }>();
  const [createDialogState, setCreateDialogState] = useState<NewChatDirectoryPickerRequest>();
  const [sectionCreate, setSectionCreate] = useState<{ name: string; busy: boolean; error: string }>();
  const [revealedEmptySectionKey, setRevealedEmptySectionKey] = useState<string>();
  const [expandedEmptyProjectIds, setExpandedEmptyProjectIds] = useState<Set<string>>(() => new Set());
  const [archivedExpanded, setArchivedExpanded] = useState(false);
  const [projectOrderOpen, setProjectOrderOpen] = useState(false);
  const [resetError, setResetError] = useState<string>();
  const [rowMenuSessionId, setRowMenuSessionId] = useState<string>();
  const [rowDeleteSessionId, setRowDeleteSessionId] = useState<string>();
  const [rowActionBusy, setRowActionBusy] = useState(false);
  const [rowActionError, setRowActionError] = useState<string>();

  const projectOrderKey = `bridge-project-order:${hostId}`;
  const [placedProjects, setPlacedProjects] = useState<string[]>(() => (
    JSON.parse(localStorage.getItem(projectOrderKey) ?? "[]") as string[]
  ));
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<Set<string>>(() => new Set());
  const [expandedForkParents, setExpandedForkParents] = useState<Set<string>>(() => new Set());
  const handledResetEventsRef = useRef(new Set<string>());
  const handledFocusKeyRef = useRef<number | undefined>(undefined);

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
    && !sectionCreate?.busy,
  );

  function closeSectionCreate(): void {
    if (!sectionCreate?.busy) setSectionCreate(undefined);
  }

  async function createSection(): Promise<void> {
    if (!sectionCanCreate || !sectionCreate) return;
    setSectionCreate({ ...sectionCreate, busy: true, error: "" });
    try {
      const { project } = unwrap<{ project?: BridgeProjectInfo }>(await apiRequest({
        method: "section.create",
        params: { name: sectionCreate.name.trim() },
      }));
      if (!project) throw new Error("Section 未创建，请重试。");
      sectionManage.revealEmptySections();
      placeProjects([project.projectId, ...placedProjects.filter((id) => id !== project.projectId)]);
      setCollapsedProjectIds((current) => expandProject(current, project.projectId));
      setRevealedEmptySectionKey(project.projectId);
      setSearch("");
      setSectionCreate(undefined);
      await onRefreshSnapshot();
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
        setSelectedId(nextSessionId);
        void onRefreshSnapshot()
          .then(() => controller.openSession(nextSessionId, hostId))
          .catch((reason) => setResetError(reason instanceof Error ? reason.message : "新会话打开失败"));
      }
    }
  }, [events, hostId, selectedId]);

  const selected = snapshot.sessions.find((session) => session.sessionId === selectedId);

  const projectsByActivity = useMemo(() => {
    const latest = new Map<string, number>(
      snapshot.projects
        .filter((project) => project.kind === "desktop-group")
        .map((project) => [project.projectId, 0]),
    );
    for (const session of snapshot.sessions) {
      if (!session.archivedAt) {
        latest.set(session.projectId, Math.max(latest.get(session.projectId) ?? 0, session.lastActivityAt));
      }
    }
    return [...latest.keys()].sort((left, right) => latest.get(right)! - latest.get(left)!);
  }, [snapshot.projects, snapshot.sessions]);

  const projectOrder = useMemo(
    () => orderProjects(projectsByActivity, placedProjects),
    [placedProjects, projectsByActivity],
  );

  function placeProjects(order: string[]): void {
    localStorage.setItem(projectOrderKey, JSON.stringify(order));
    setPlacedProjects(order);
  }

  useEffect(() => {
    const unplaced = projectOrder.filter((projectId) => !placedProjects.includes(projectId));
    if (unplaced.length) placeProjects([...unplaced, ...placedProjects]);
  }, [placedProjects, projectOrder]);

  const searchQuery = search.trim().toLocaleLowerCase();

  const grouped = useMemo(() => {
    const matches = snapshot.sessions.filter((session) => (
      !searchQuery
      || `${session.title}\n${session.currentSummary ?? ""}\n${session.projectName}\n${session.cwd}\n${desktopRuntimeName(desktopRuntimeId(session))}`
        .toLocaleLowerCase()
        .includes(searchQuery)
    ));
    const matchingActiveParents = new Map(
      matches
        .filter((candidate) => !candidate.archivedAt)
        .map((candidate) => [candidate.sessionId, candidate.projectId]),
    );
    const filtered = matches.filter((candidate) => (
      !candidate.archivedAt
      || Boolean(
        candidate.sidechat
        && candidate.parentSessionId
        && matchingActiveParents.get(candidate.parentSessionId) === candidate.projectId,
      )
    ));
    const map = new Map<string, BridgeSessionInfo[]>(
      snapshot.projects
        .filter((project) => (
          project.kind === "desktop-group"
          && (!searchQuery || `${project.name}\n${project.cwd}`.toLocaleLowerCase().includes(searchQuery))
        ))
        .map((project) => [project.projectId, []]),
    );
    for (const session of filtered) {
      const list = map.get(session.projectId) ?? [];
      list.push(session);
      map.set(session.projectId, list);
    }
    return projectOrder
      .filter((projectId) => map.has(projectId))
      .map((projectId) => ({
        projectId,
        project: snapshot.projects.find((candidate) => candidate.projectId === projectId),
        sessions: sortProjectSessionsByRecent(map.get(projectId)!),
      }));
  }, [projectOrder, searchQuery, snapshot.projects, snapshot.sessions]);

  const visibilityAvailable = snapshot.host.capabilities.includes("session.visibility.v1");
  const archivedSessions = useMemo(
    () => sortProjectSessionsByRecent(snapshot.sessions.filter((candidate) => Boolean(candidate.archivedAt))),
    [snapshot.sessions],
  );
  const hasActiveSessions = activeSessions.length > 0;

  useEffect(() => {
    if (selectedId && snapshot.sessions.some((session) => session.sessionId === selectedId)) return;
    setSelectedId(activeSessions[0]?.sessionId);
  }, [activeSessions, selectedId, snapshot.sessions]);

  const autoExpandedForkKeysRef = useRef(new Set<string>());
  useEffect(() => {
    const parentsToExpand: string[] = [];
    for (const session of snapshot.sessions) {
      if (!session.parentSessionId) continue;
      const isSelected = session.sessionId === selectedId;
      const isActive = session.turnState === "running" || session.turnState === "waiting" || session.turnState === "queued";
      const selectedKey = `selected:${session.sessionId}`;
      if (isSelected) {
        if (!autoExpandedForkKeysRef.current.has(selectedKey)) {
          autoExpandedForkKeysRef.current.add(selectedKey);
          parentsToExpand.push(...getSessionAncestorIds(snapshot.sessions, session.sessionId));
        }
      } else {
        autoExpandedForkKeysRef.current.delete(selectedKey);
      }
      const activeKey = `active:${session.sessionId}`;
      if (isActive) {
        if (!autoExpandedForkKeysRef.current.has(activeKey)) {
          autoExpandedForkKeysRef.current.add(activeKey);
          parentsToExpand.push(...getSessionAncestorIds(snapshot.sessions, session.sessionId));
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
  }, [selectedId, snapshot.sessions]);

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

  async function quickStartSession(cwd: string, prompt: string, projectId?: string): Promise<void> {
    const created = await createSession(cwd, undefined, "claude-desktop", projectId);
    await handleNewChatCreated(created, { initialPrompt: prompt });
  }

  function toggleProject(projectId: string, isEmptyGroup: boolean): void {
    if (isEmptyGroup) {
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
  const rowDeleteSession = rowDeleteSessionId
    ? snapshot.sessions.find((candidate) => candidate.sessionId === rowDeleteSessionId)
    : undefined;
  const rowMenuBusy = Boolean(
    rowMenuSession
    && (rowMenuSession.turnState === "running" || rowMenuSession.turnState === "queued" || rowMenuSession.turnState === "waiting"),
  );

  const showProjectTree = hasActiveSessions || Boolean(searchQuery);

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

          <div className="desktop-project-list">
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
                  return (
                    <section className={`project-group ${expanded ? "expanded" : "collapsed"}${isEmptyGroup ? " is-empty-group" : ""}`} key={groupProjectId}>
                      <ProjectGroupHeader
                        title={projectName}
                        count={families.length}
                        expanded={expanded}
                        controlsId={sessionsId}
                        onToggle={() => toggleProject(groupProjectId, isEmptyGroup)}
                        actions={(
                          <>
                            <IconButton
                              label={`新建会话：${projectName}`}
                              className="session-row-action"
                              onClick={() => openCreateDialogForProject(groupProjectId)}
                            >
                              <Plus size={16} />
                            </IconButton>
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
                              flat
                              actionLabel={(session) => `会话操作：${session.title}`}
                              onSelectSession={selectSessionFromSidebar}
                              onOpenSessionActions={(targetSessionId) => {
                                setRowActionError(undefined);
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
                {!searchQuery && visibilityAvailable && archivedSessions.length > 0 && (() => {
                  const archivedFamilies = groupProjectSessionFamilies(archivedSessions);
                  return (
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
                              setRowMenuSessionId(targetSessionId);
                            }}
                            onToggleForkGroup={toggleForkGroup}
                          />
                        </div>
                      )}
                    </section>
                  );
                })()}
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
              apiRequest={apiRequest}
              onRefreshSnapshot={onRefreshSnapshot}
              headerLeading={sidebarToggleButton}
              controller={controller}
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
              onLoadSessionConfiguration={controller.loadSessionConfiguration}
              onConfigureSession={controller.configureSession}
              onCreateSession={createSession}
              onSessionCreated={handleNewChatCreated}
              onQuickStart={quickStartSession}
            />
          )}
        </section>
      )}

      {rowMenuSession && (
        <Sheet
          manageFocus
          focusPaused={Boolean(rowDeleteSession)}
          eyebrow={`${rowMenuSession.projectName} · ${desktopRuntimeName(desktopRuntimeId(rowMenuSession))}`}
          title={rowMenuSession.title}
          busy={rowActionBusy}
          onClose={() => {
            if (!rowActionBusy) setRowMenuSessionId(undefined);
          }}
        >
          <div className="m-group">
            {desktopRuntimeId(rowMenuSession) === "claude-desktop" && (
              <SheetAction
                icon={<GitFork size={19} />}
                label="Fork 分支"
                disabled={rowActionBusy}
                onClick={() => {
                  if (rowActionBusy) return;
                  const sourceId = rowMenuSession.sessionId;
                  setRowActionBusy(true);
                  setRowActionError(undefined);
                  void controller.forkSession(sourceId)
                    .then(async (created) => {
                      setExpandedForkParents((current) => new Set([
                        ...current,
                        ...getSessionAncestorIds(snapshot.sessions, sourceId),
                        sourceId,
                      ]));
                      await onRefreshSnapshot();
                      setRowMenuSessionId(undefined);
                      selectSessionFromSidebar(created.sessionId);
                    })
                    .catch((error: unknown) => {
                      setRowActionError(error instanceof Error ? error.message : "Fork 分支创建失败");
                    })
                    .finally(() => setRowActionBusy(false));
                }}
              />
            )}
            {visibilityAvailable && (
              <>
                <SheetAction
                  icon={rowMenuSession.archivedAt ? <ArchiveRestore size={19} /> : <Archive size={19} />}
                  label={rowMenuSession.archivedAt ? "恢复会话" : "归档会话"}
                  disabled={rowActionBusy}
                  onClick={() => {
                    if (rowActionBusy) return;
                    setRowActionBusy(true);
                    setRowActionError(undefined);
                    void controller.archiveSession(rowMenuSession.sessionId, !rowMenuSession.archivedAt)
                      .then(() => setRowMenuSessionId(undefined))
                      .catch((error: unknown) => {
                        setRowActionError(error instanceof Error ? error.message : "归档设置失败");
                      })
                      .finally(() => setRowActionBusy(false));
                  }}
                />
                <SheetAction
                  icon={<Trash2 size={19} />}
                  label="删除会话"
                  danger
                  disabled={rowActionBusy || rowMenuBusy}
                  detail={rowMenuBusy ? "任务进行中，先停止再删除" : undefined}
                  onClick={() => setRowDeleteSessionId(rowMenuSession.sessionId)}
                />
              </>
            )}
            {!visibilityAvailable && desktopRuntimeId(rowMenuSession) !== "claude-desktop" && (
              <SheetAction
                icon={<FolderPlus size={19} />}
                label="打开此会话"
                onClick={() => {
                  const targetId = rowMenuSession.sessionId;
                  setRowMenuSessionId(undefined);
                  selectSessionFromSidebar(targetId);
                }}
              />
            )}
          </div>
          {rowActionError && <p className="m-sheet-note is-error" role="alert">{rowActionError}</p>}
        </Sheet>
      )}

      <ConfirmationDialog
        open={Boolean(rowDeleteSession)}
        title="删除会话"
        description={rowDeleteSession
          ? (rowDeleteSession.transport === "claude-desktop-native"
              ? `从 Claude Desktop 中删除「${rowDeleteSession.title}」会话？此操作不可恢复。`
              : `从 Bridge 列表中删除「${rowDeleteSession.title}」？对应 Desktop 应用中的原生会话与文件不受影响；Bridge 中的会话配置、排队与授权记录会被清除，此操作不可恢复。`)
          : ""}
        confirmLabel="删除会话"
        danger
        busy={rowActionBusy}
        onCancel={() => {
          if (!rowActionBusy) setRowDeleteSessionId(undefined);
        }}
        onConfirm={() => {
          if (!rowDeleteSession || rowActionBusy) return;
          const targetId = rowDeleteSession.sessionId;
          setRowActionBusy(true);
          setRowActionError(undefined);
          void controller.deleteSession(targetId)
            .then(() => {
              setRowDeleteSessionId(undefined);
              setRowMenuSessionId(undefined);
            })
            .catch((error: unknown) => {
              setRowDeleteSessionId(undefined);
              setRowActionError(error instanceof Error ? error.message : "删除会话失败");
            })
            .finally(() => setRowActionBusy(false));
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
      {sectionCreate && (
        <div
          className="modal-backdrop session-create-backdrop"
          role="presentation"
          onMouseDown={(event) => { if (event.target === event.currentTarget) closeSectionCreate(); }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              closeSectionCreate();
            }
          }}
        >
          <section className="create-session-dialog session-create-dialog section-create-dialog" role="dialog" aria-modal="true" aria-label="新建 Section">
            <header className="session-create-header"><h2>新建 Section</h2></header>
            <form onSubmit={(event) => { event.preventDefault(); void createSection(); }}>
              <div className="session-create-body">
                <label>
                  <span>Section 名称</span>
                  <input
                    aria-label="Section 名称"
                    value={sectionCreate.name}
                    autoFocus
                    required
                    maxLength={200}
                    disabled={sectionCreate.busy}
                    onChange={(event) => setSectionCreate({ ...sectionCreate, name: event.target.value, error: "" })}
                  />
                </label>
                {sectionCreate.error && <p className="session-create-error" role="alert">{sectionCreate.error}</p>}
              </div>
              <footer className="dialog-actions session-create-actions">
                <button type="button" className="secondary-button" disabled={sectionCreate.busy} onClick={closeSectionCreate}>取消</button>
                <button type="submit" className="primary-button" disabled={!sectionCanCreate}>{sectionCreate.busy ? "正在创建…" : "创建 Section"}</button>
              </footer>
            </form>
          </section>
        </div>
      )}
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
