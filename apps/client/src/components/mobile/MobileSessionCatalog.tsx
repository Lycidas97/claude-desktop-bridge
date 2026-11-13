import type {
  BridgeDesktopRuntimeId,
  BridgeDirectoryListing,
  BridgeHostSnapshot,
  BridgePermissionInfo,
  BridgeProjectInfo,
  BridgeSessionInfo,
  BridgeTransportMetrics,
  SocketState,
} from "@bridge/protocol";
import {
  AlertTriangle,
  Archive,
  ArrowUpDown,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsDown,
  ChevronsUp,
  FolderPlus,
  GitFork,
  LoaderCircle,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
} from "lucide-react";
import type { ReactNode, RefObject } from "react";
import type { MobileConnectionIssue } from "../../hooks/useMobileBridge.js";
import {
  activeSessionBadgeLabel,
  mobileConnectionLabel,
  relativeTime,
} from "../../lib/conversation-timeline.js";
import {
  PROJECT_PREVIEW_SESSION_LIMIT,
  collapseProjects,
  expandAllProjects,
  expandProject,
  groupProjectSessionFamilies,
  previewProjectSessionFamilies,
  sortProjectSessionsByRecent,
  type SessionFamily,
} from "../../lib/project-groups.js";
import { desktopRuntimeId, desktopRuntimeName } from "../../lib/runtime-labels.js";
import { backgroundSubagentBadge } from "../../lib/session-activity.js";
import { IconButton } from "../common/IconButton.js";
import { SectionManageDialog, type SectionManageController } from "../session/SectionManageDialog.js";
import { SessionCreateDialog } from "../session/SessionCreateDialog.js";
import { MobilePageHeader } from "./MobilePageHeader.js";
import { MobileSheet, SheetAction } from "./MobileSheet.js";
import { ProjectOrderSheet } from "./ProjectOrderSheet.js";

export interface MobileSessionCatalogProps {
  desktopName: string;
  connection: SocketState;
  desktopOnline: boolean;
  snapshot: BridgeHostSnapshot | undefined;
  sessions: BridgeSessionInfo[];
  archivedSessions: BridgeSessionInfo[];
  activeParentProjects: Map<string, string>;
  grouped: Array<{ project: BridgeProjectInfo | undefined; sessions: BridgeSessionInfo[] }>;
  groupedProjectIds: string[];
  allProjectsCollapsed: boolean;
  collapsedProjectIds: Set<string>;
  expandedForkParents: Set<string>;
  projectOrder: string[];
  projectsByActivity: string[];
  permissions: BridgePermissionInfo[];
  connectionIssue: MobileConnectionIssue | undefined;
  transportMetrics: BridgeTransportMetrics | undefined;
  pendingOutbound: number;
  activeProjectId: string | undefined;
  search: string;
  projectSearch: string;
  directoryRef: RefObject<HTMLElement | null>;
  directoryScrollPositions: RefObject<Map<string, number>>;
  directoryMenuOpen: boolean;
  projectOrderOpen: boolean;
  refreshing: boolean;
  syncFlash: boolean;
  sectionCreate: { name: string; busy: boolean; error: string } | undefined;
  sectionCanCreate: boolean;
  sectionManage: SectionManageController;
  createOpen: boolean;
  createProjectId: string;
  sessionOverlays: ReactNode;
  onBackToHosts(): void;
  onRetry(): Promise<void>;
  onRefresh(sessionId?: string): Promise<boolean>;
  onCreateSection: ((name: string) => Promise<BridgeProjectInfo | undefined>) | undefined;
  onBrowseDirectory: ((path?: string) => Promise<BridgeDirectoryListing>) | undefined;
  onCreateDirectory: ((parentPath: string, name: string) => Promise<string>) | undefined;
  onCreateSession(
    cwd: string,
    title?: string,
    runtimeId?: BridgeDesktopRuntimeId,
    projectId?: string,
  ): Promise<BridgeSessionInfo | undefined>;
  selectSession(sessionId: string): Promise<void>;
  setSearch(value: string): void;
  setProjectSearch(value: string): void;
  setDirectoryMenuOpen(open: boolean): void;
  setProjectOrderOpen(open: boolean): void;
  setCollapsedProjectIds(value: Set<string> | ((current: Set<string>) => Set<string>)): void;
  setSectionCreate(value: { name: string; busy: boolean; error: string } | undefined): void;
  setCreateOpen(open: boolean): void;
  onOpenSessionActions(sessionId: string): void;
  toggleProject(projectId: string): void;
  toggleForkGroup(parentSessionId: string): void;
  openProjectGroup(projectId: string): void;
  closeProjectGroup(): void;
  openCreateDialogForProject(targetProjectId?: string): void;
  placeProjects(order: string[]): void;
  runRefresh(sessionId?: string): Promise<void>;
  closeSectionCreate(): void;
  createSection(): Promise<void>;
}

export function MobileSessionCatalog({
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
  onOpenSessionActions,
  toggleProject,
  toggleForkGroup,
  openProjectGroup,
  closeProjectGroup,
  openCreateDialogForProject,
  placeProjects,
  runRefresh,
  closeSectionCreate,
  createSection,
}: MobileSessionCatalogProps) {
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
        )))
    : [];
  const activeGroupQuery = projectSearch.trim().toLocaleLowerCase();
  const activeGroupSessions = activeGroupQuery
    ? activeGroupSessionsAll.filter((session) => (
        `${session.title}\n${session.currentSummary ?? ""}\n${session.cwd}\n${desktopRuntimeName(desktopRuntimeId(session))}`
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
    const pendingPermission = isArchivedRow ? undefined : permissions.find(permission => permission.sessionId === session.sessionId);
    const turnBadge = isArchivedRow ? "已归档" : pendingPermission ? pendingPermission.toolName === "AskUserQuestion" ? "待回答" : "待授权" : activeSessionBadgeLabel(session);
    const subagentBadge = isArchivedRow || turnBadge ? undefined : backgroundSubagentBadge(session);
    const badge = turnBadge ?? subagentBadge?.label;
    const statusTone = pendingPermission ? "waiting" : subagentBadge ? (subagentBadge.stalled ? "queued" : "running") : session.turnState;
    const forksExpanded = expandedForkParents.has(session.sessionId);
    const badgeLabel = session.sidechat ? "/btw" : (session.forkLabel || "fork");
    const badgeClassName = `session-fork-badge${session.sidechat ? " is-sidechat" : ""}`;
    const sessionProject = !isArchivedRow
      ? snapshot?.projects.find((candidate) => candidate.projectId === session.projectId)
      : undefined;
    const sessionFolder = session.cwd.replace(/[\\/]+$/u, "").split(/[\\/]/u).at(-1) || "";
    const subfolderLabel = sessionProject?.kind === "desktop-group" && sessionFolder && sessionFolder !== sessionProject.name
      ? sessionFolder
      : "";
    return (
      <div className="mobile-session-family" key={session.sessionId}>
        <div className={`session-row-v2 ${isForkChild ? "is-fork-child" : ""}`} data-session-id={session.sessionId}>
          <button
            type="button"
            className="session-row-hit"
            onClick={() => void selectSession(session.sessionId)}
          >
            <span className={`session-state-dot ${statusTone}`} />
            <span className="session-row-copy">
              <strong>
                {isForkChild && <em className={badgeClassName}>{badgeLabel}</em>}
                {session.title}
                {!isForkChild && session.parentSessionId && (
                  <em className={badgeClassName}>{badgeLabel}</em>
                )}
              </strong>
              <small>
                {subfolderLabel ? `${subfolderLabel} · ` : ""}
                {relativeTime(session.lastActivityAt)}
                {!isArchivedRow && session.currentSummary ? ` · ${session.currentSummary}` : ""}
              </small>
            </span>
            {badge && (
              <span className={`session-row-status ${statusTone}`}>
                {badge}
              </span>
            )}
          </button>
          <IconButton
              label="会话操作"
              className="session-row-action"
              onClick={() => onOpenSessionActions(session.sessionId)}
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

  return (
    <main className="mobile-workspace host-detail-workspace">
      <MobilePageHeader
        title={activeProjectId ? activeGroupName : "会话"}
        titleHidden={!activeProjectId}
        subtitle={activeProjectId ? activeGroupCwd : (
          <button type="button" className="m-host-chip" onClick={onBackToHosts} aria-label={`当前电脑：${desktopName}，查看电脑`}>
            <i className={`m-status-dot${desktopOnline ? " is-online" : ""}`} />
            <span className="m-host-name">{desktopName}</span>
            <span className="m-host-status">· {hostStatusText}</span>
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
              <strong>{permissions[0].toolName === "AskUserQuestion" ? "有提问待你回答" : "有操作待你授权"}</strong>
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
                  {sectionManage.canManage(group.project) && (
                    <IconButton
                      label={`管理分组：${projectName}`}
                      className="session-row-action section-manage-trigger"
                      onClick={() => sectionManage.openMenu(group.project!.projectId)}
                    >
                      <MoreHorizontal size={18} />
                    </IconButton>
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
        <MobileSheet eyebrow={desktopName} title={activeProjectId ? activeGroupName : "会话目录"} onClose={() => setDirectoryMenuOpen(false)}>
          <div className="m-group">
            {onCreateSection && snapshot?.host.capabilities.includes("section.create.v1") && (
              <SheetAction icon={<FolderPlus size={19} />} label="新建 Section" disabled={connection !== "connected" || !desktopOnline} onClick={() => {
                setDirectoryMenuOpen(false);
                setSectionCreate({ name: "", busy: false, error: "" });
              }} />
            )}
            {sectionManage.renderDirectoryActions({
              activeGroupProject,
              closeDirectoryMenu: () => setDirectoryMenuOpen(false),
            })}
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
                detail="项目顺序固定，可长按或拖动调整"
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
        <ProjectOrderSheet
          desktopName={desktopName}
          projectOrder={projectOrder}
          projectsByActivity={projectsByActivity}
          projects={snapshot?.projects}
          sessions={sessions}
          onPlaceProjects={placeProjects}
          onClose={() => setProjectOrderOpen(false)}
        />
      )}
      {sectionCreate && (
        <div className="modal-backdrop session-create-backdrop" role="presentation"
          onMouseDown={event => { if (event.target === event.currentTarget) closeSectionCreate(); }}
          onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); closeSectionCreate(); } }}>
          <section className="create-session-dialog session-create-dialog section-create-dialog" role="dialog" aria-modal="true" aria-label="新建 Section">
            <header className="session-create-header"><h2>新建 Section</h2></header>
            <form onSubmit={event => { event.preventDefault(); void createSection(); }}>
              <div className="session-create-body">
                <label><span>Section 名称</span><input aria-label="Section 名称" value={sectionCreate.name} autoFocus required maxLength={200} disabled={sectionCreate.busy}
                  onChange={event => setSectionCreate({ ...sectionCreate, name: event.target.value, error: "" })} /></label>
                {sectionCreate.error && <p className="session-create-error" role="alert">{sectionCreate.error}</p>}
                {(connection !== "connected" || !desktopOnline) && <p className="session-create-status" role="status">电脑已离线，连接后可创建 Section。</p>}
              </div>
              <footer className="dialog-actions session-create-actions">
                <button type="button" className="secondary-button" disabled={sectionCreate.busy} onClick={closeSectionCreate}>取消</button>
                <button type="submit" className="primary-button" disabled={!sectionCanCreate}>{sectionCreate.busy ? "正在创建…" : "创建 Section"}</button>
              </footer>
            </form>
          </section>
        </div>
      )}
      <SectionManageDialog controller={sectionManage} />
      {createOpen && snapshot && (
        <SessionCreateDialog
          key={snapshot.host.hostId}
          snapshot={snapshot}
          connected={connection === "connected" && desktopOnline}
          initialProjectId={createProjectId}
          {...(onBrowseDirectory ? { onBrowseDirectory } : {})}
          {...(onCreateDirectory ? { onCreateDirectory } : {})}
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
