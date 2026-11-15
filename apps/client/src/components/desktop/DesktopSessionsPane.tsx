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
  ArrowUpDown,
  Check,
  ChevronsDown,
  ChevronsUp,
  FolderPlus,
  LoaderCircle,
  MessageSquare,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  collapseProjects,
  expandAllProjects,
  expandProject,
  getSessionAncestorIds,
  groupProjectSessionFamilies,
  orderProjects,
  sortProjectSessionsByRecent,
  toggleCollapsedProject,
} from "../../lib/project-groups.js";
import { desktopRuntimeId, desktopRuntimeName } from "../../lib/runtime-labels.js";
import { EmptyState } from "../common/EmptyState.js";
import { IconButton } from "../common/IconButton.js";
import { Sheet, SheetAction } from "../common/Sheet.js";
import { useConversationDrafts } from "../conversation/ConversationDraftsProvider.js";
import { ProjectOrderSheet } from "../mobile/ProjectOrderSheet.js";
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

export function DesktopSessions({
  snapshot,
  events,
  apiRequest,
  onRefreshSnapshot,
  initialSessionId,
  focusRequest,
}: {
  initialSessionId?: string | undefined;
  focusRequest?: { sessionId: string; key: number } | undefined;
  snapshot: DesktopControlSnapshot;
  events: BridgeEvent[];
  apiRequest(request: LocalBridgeRequest): Promise<BridgeResponse>;
  onRefreshSnapshot(): Promise<void>;
}) {
  const controller = useDesktopConversation({
    snapshot,
    events,
    apiRequest,
    onRefreshSnapshot,
  });
  const conversationDrafts = useConversationDrafts(snapshot.host.hostId);

  const hostId = snapshot.host.hostId;
  const hostEvents = controller.filterEvents(events, hostId);
  const storedSelectedId = controller.selectedSessionFor(hostId);
  const selectedId = storedSelectedId !== undefined
    ? storedSelectedId
    : (initialSessionId ?? snapshot.sessions[0]?.sessionId);

  function setSelectedId(sessionId: string | undefined): void {
    setResetError(undefined);
    controller.selectSession(hostId, sessionId);
  }

  const [search, setSearch] = useState("");
  const [directoryMenuOpen, setDirectoryMenuOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [syncFlash, setSyncFlash] = useState(false);
  const syncFlashTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [createOpen, setCreateOpen] = useState(false);
  const [createProjectId, setCreateProjectId] = useState("");
  const [sectionCreate, setSectionCreate] = useState<{ name: string; busy: boolean; error: string }>();
  const [archivedExpanded, setArchivedExpanded] = useState(false);
  const [projectOrderOpen, setProjectOrderOpen] = useState(false);
  const [resetError, setResetError] = useState<string>();

  const projectOrderKey = `bridge-project-order:${hostId}`;
  const [placedProjects, setPlacedProjects] = useState<string[]>(() => (
    JSON.parse(localStorage.getItem(projectOrderKey) ?? "[]") as string[]
  ));
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<Set<string>>(() => new Set());
  const [expandedForkParents, setExpandedForkParents] = useState<Set<string>>(() => new Set());
  const handledResetEventsRef = useRef(new Set<string>());
  const handledFocusKeyRef = useRef<number | undefined>(undefined);

  useEffect(() => () => {
    if (syncFlashTimerRef.current !== undefined) clearTimeout(syncFlashTimerRef.current);
  }, []);

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

  function openCreateDialogForProject(targetProjectId?: string): void {
    setCreateProjectId(targetProjectId ?? "");
    setCreateOpen(true);
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
    setSelectedId(sessionId);
  }

  async function runRefresh(): Promise<void> {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await onRefreshSnapshot();
      setSyncFlash(true);
      if (syncFlashTimerRef.current !== undefined) clearTimeout(syncFlashTimerRef.current);
      syncFlashTimerRef.current = setTimeout(() => {
        syncFlashTimerRef.current = undefined;
        setSyncFlash(false);
      }, 2400);
    } finally {
      setRefreshing(false);
    }
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
      .filter((projectId) => {
        const groupSessions = map.get(projectId);
        if (!groupSessions) return false;
        const project = snapshot.projects.find((candidate) => candidate.projectId === projectId);
        return !sectionManage.shouldHideEmpty(project, groupSessions.length, searchQuery);
      })
      .map((projectId) => ({
        projectId,
        project: snapshot.projects.find((candidate) => candidate.projectId === projectId),
        sessions: sortProjectSessionsByRecent(map.get(projectId)!),
      }));
  }, [projectOrder, searchQuery, sectionManage.hideEmptySections, snapshot.projects, snapshot.sessions]);

  const visibilityAvailable = snapshot.host.capabilities.includes("session.visibility.v1");
  const archivedSessions = useMemo(
    () => sortProjectSessionsByRecent(snapshot.sessions.filter((candidate) => Boolean(candidate.archivedAt))),
    [snapshot.sessions],
  );

  const groupedProjectIds = useMemo(
    () => grouped.map((group) => group.projectId),
    [grouped],
  );
  const hasActiveSessions = useMemo(
    () => grouped.some((group) => group.sessions.length > 0),
    [grouped],
  );
  const allProjectsCollapsed = groupedProjectIds.length > 0
    && groupedProjectIds.every((groupProjectId) => collapsedProjectIds.has(groupProjectId));

  useEffect(() => {
    if (selectedId && snapshot.sessions.some((session) => session.sessionId === selectedId)) return;
    setSelectedId(snapshot.sessions[0]?.sessionId);
  }, [selectedId, snapshot.sessions]);

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

  function toggleProject(projectId: string): void {
    setCollapsedProjectIds((current) => toggleCollapsedProject(current, projectId));
  }

  function toggleForkGroup(parentSessionId: string): void {
    setExpandedForkParents((current) => toggleCollapsedProject(current, parentSessionId));
  }

  return (
    <section className="desktop-session-layout">
      <aside className="desktop-session-sidebar">
        <div className="desktop-sidebar-heading">
          <h1>会话</h1>
          <div className="desktop-sidebar-actions">
            <IconButton
              label="新建会话"
              onClick={() => openCreateDialogForProject()}
            >
              <Plus size={19} />
            </IconButton>
            <IconButton
              label="目录选项"
              onClick={() => setDirectoryMenuOpen(true)}
            >
              <MoreHorizontal size={19} />
            </IconButton>
          </div>
        </div>

        <div className="desktop-project-list">
          <label className="session-search">
            <Search size={16} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索项目或会话"
            />
          </label>
          {!searchQuery && projectOrder.length > 1 && (
            <div className="project-order-bar">
              <span>项目顺序已固定</span>
              <button type="button" onClick={() => setProjectOrderOpen(true)}>
                <ArrowUpDown size={14} />
                调整顺序
              </button>
            </div>
          )}
          {snapshot.permissions[0] && (
            <button
              type="button"
              className="host-permission-alert"
              onClick={() => jumpToSession(snapshot.permissions[0]!.sessionId)}
            >
              <span className="permission-dock-icon"><AlertTriangle size={18} /></span>
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
                action={(
                  <button
                    type="button"
                    className="primary-button session-catalog-empty-action"
                    onClick={() => openCreateDialogForProject()}
                  >
                    <Plus size={16} />
                    新建会话
                  </button>
                )}
              />
            )
          )}
          <div className="project-groups">
            {grouped.map((group) => {
              const { projectId: groupProjectId, project, sessions } = group;
              const projectName = project?.name ?? sessions[0]?.projectName ?? groupProjectId;
              const expanded = Boolean(searchQuery) || !collapsedProjectIds.has(groupProjectId);
              const sessionsId = `desktop-project-${encodeURIComponent(groupProjectId)}`;
              const families = groupProjectSessionFamilies(sessions);
              return (
                <section className={`project-group ${expanded ? "expanded" : "collapsed"}`} key={groupProjectId}>
                  <ProjectGroupHeader
                    title={projectName}
                    count={families.length}
                    expanded={expanded}
                    controlsId={sessionsId}
                    onToggle={() => toggleProject(groupProjectId)}
                    actions={(
                      <>
                        <IconButton
                          label={`新建会话：${projectName}`}
                          className="session-row-action"
                          onClick={() => openCreateDialogForProject(groupProjectId)}
                        >
                          <Plus size={18} />
                        </IconButton>
                        {sectionManage.canManage(project) && (
                          <IconButton
                            label={`管理分组：${projectName}`}
                            className="session-row-action section-manage-trigger"
                            onClick={() => sectionManage.openMenu(groupProjectId)}
                          >
                            <MoreHorizontal size={17} />
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
                          selectedId={selectedId}
                          includeArchivedInline
                          onSelectSession={setSelectedId}
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
                        selectedId={selectedId}
                        archivedList
                        onSelectSession={setSelectedId}
                        onToggleForkGroup={toggleForkGroup}
                      />
                    </div>
                  )}
                </section>
              );
            })()}
          </div>
        </div>
      </aside>

      <section className="desktop-conversation">
        {selected ? (
          <DesktopSessionConversation
            session={selected}
            snapshot={snapshot}
            events={hostEvents}
            apiRequest={apiRequest}
            onRefreshSnapshot={onRefreshSnapshot}
            controller={controller}
            conversationDrafts={conversationDrafts}
            onSelectSession={setSelectedId}
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
          <div className="desktop-conversation-empty">
            <MessageSquare size={24} />
            <span>从左侧选择会话</span>
          </div>
        )}
      </section>

      {directoryMenuOpen && (
        <Sheet
          manageFocus
          eyebrow={snapshot.host.name}
          title="会话目录"
          onClose={() => setDirectoryMenuOpen(false)}
        >
          <div className="m-group">
            {supportsCreateSection && (
              <SheetAction
                icon={<FolderPlus size={19} />}
                label="新建 Section"
                onClick={() => {
                  setDirectoryMenuOpen(false);
                  setSectionCreate({ name: "", busy: false, error: "" });
                }}
              />
            )}
            {sectionManage.renderDirectoryActions({
              activeGroupProject: undefined,
              closeDirectoryMenu: () => setDirectoryMenuOpen(false),
            })}
            <SheetAction
              icon={refreshing ? <LoaderCircle className="is-spinning" size={19} /> : syncFlash ? <Check size={19} /> : <RefreshCw size={19} />}
              label={refreshing ? "正在同步" : syncFlash ? "已同步" : "同步当前电脑"}
              detail="重新读取项目、会话与运行状态"
              disabled={refreshing}
              onClick={() => void runRefresh()}
            />
            {projectOrder.length > 1 && (
              <SheetAction
                icon={<ArrowUpDown size={19} />}
                label="调整项目顺序"
                detail="项目顺序固定，可拖动或按键调整"
                onClick={() => {
                  setDirectoryMenuOpen(false);
                  setProjectOrderOpen(true);
                }}
              />
            )}
            {groupedProjectIds.length > 0 && (
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
        </Sheet>
      )}
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
      {createOpen && (
        <SessionCreateDialog
          key={`${hostId}:${createProjectId}`}
          snapshot={snapshot}
          connected
          initialProjectId={createProjectId}
          {...(handleBrowseDirectory ? { onBrowseDirectory: handleBrowseDirectory } : {})}
          {...(handleCreateDirectory ? { onCreateDirectory: handleCreateDirectory } : {})}
          {...(window.bridgeDesktop?.chooseDirectory ? { onChooseDirectory: (path?: string) => window.bridgeDesktop!.chooseDirectory!(path) } : {})}
          onCreate={createSession}
          onCreated={(created) => {
            setCollapsedProjectIds((current) => expandProject(current, created.projectId));
            if (search.trim()) setSearch("");
            setSelectedId(created.sessionId);
          }}
          onClose={() => setCreateOpen(false)}
        />
      )}
    </section>
  );
}

export { DesktopSessions as DesktopSessionsPane };
