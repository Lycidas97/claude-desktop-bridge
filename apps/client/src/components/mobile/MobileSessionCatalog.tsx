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
  ChevronDown,
  LoaderCircle,
  Mail,
  MoreHorizontal,
  Plus,
  Search,
  SquarePen,
} from "lucide-react";
import type { ReactNode, RefObject } from "react";
import type { MobileConnectionIssue, PairedHost } from "../../hooks/useMobileBridge.js";
import type { ThemeControl } from "../../hooks/useTheme.js";
import {
  expandProject,
  groupProjectSessionFamilies,
} from "../../lib/project-groups.js";
import { EmptyState } from "../common/EmptyState.js";
import { IconButton } from "../common/IconButton.js";
import { ThemeMenu } from "../common/ThemeMenu.js";
import type { NewChatDirectoryPickerRequest } from "../session/NewChatCanvas.js";
import { ProjectGroupHeader } from "../session/ProjectGroupHeader.js";
import { SectionManageDialog, type SectionManageController } from "../session/SectionManageDialog.js";
import { SessionCreateDialog } from "../session/SessionCreateDialog.js";
import { SessionFamilyList } from "../session/SessionFamilyList.js";
import type { MobileTab } from "./MobileAppShell.js";
import { ProjectOrderSheet } from "./ProjectOrderSheet.js";

function hostQuickMeta(
  host: PairedHost,
  isCurrent: boolean,
  desktopOnline: boolean,
  transportMetrics: BridgeTransportMetrics | undefined,
): string {
  if (host.needsRepair) return "需重配";
  if (isCurrent) {
    if (!desktopOnline) return "离线";
    if (transportMetrics?.path === "direct") return "直连";
    if (transportMetrics?.path === "lan-relay") return "局域网";
    if (transportMetrics?.path === "public-relay") return "安全中继";
    return "在线";
  }
  if (host.status === "offline") return "离线";
  if (host.status === "running") return `${host.activeTurns} 运行中`;
  if (host.status === "attention") return "待处理";
  return "在线";
}

export interface MobileSessionCatalogProps {
  open?: boolean | undefined;
  onClose?: (() => void) | undefined;
  hosts?: readonly PairedHost[] | undefined;
  activeHostId?: string | undefined;
  onSelectHost?: ((hostId: string) => Promise<void> | void) | undefined;
  onAddHost?: (() => void) | undefined;
  hostSwitcherOpen?: boolean | undefined;
  onToggleHostSwitcher?: (() => void) | undefined;
  activeTab?: MobileTab | undefined;
  onSelectTab?: ((tab: MobileTab) => void) | undefined;
  assistantAvailable?: boolean | undefined;
  assistantUnreadCount?: number | undefined;
  themeControl?: ThemeControl | undefined;
  onStartNewChat?: (() => void) | undefined;
  selectedSessionId?: string | undefined;
  archivedExpanded?: boolean | undefined;
  onToggleArchived?: (() => void) | undefined;
  expandedEmptyProjectIds?: ReadonlySet<string> | undefined;
  revealedEmptySectionKey?: string | undefined;
  createDialogState?: NewChatDirectoryPickerRequest | undefined;
  onCloseCreateDialog?: (() => void) | undefined;
  onDeliverInitialPrompt?: ((created: BridgeSessionInfo, prompt: string) => void) | undefined;
  desktopName: string;
  connection: SocketState;
  desktopOnline: boolean;
  snapshot: BridgeHostSnapshot | undefined;
  sessions: BridgeSessionInfo[];
  archivedSessions: BridgeSessionInfo[];
  grouped: Array<{ project: BridgeProjectInfo | undefined; sessions: BridgeSessionInfo[] }>;
  collapsedProjectIds: Set<string>;
  expandedForkParents: Set<string>;
  projectOrder: string[];
  projectsByActivity: string[];
  permissions: BridgePermissionInfo[];
  connectionIssue: MobileConnectionIssue | undefined;
  onInspectConnection?: (() => void) | undefined;
  transportMetrics: BridgeTransportMetrics | undefined;
  search: string;
  directoryRef: RefObject<HTMLElement | null>;
  directoryScrollPositions: RefObject<Map<string, number>>;
  projectOrderOpen: boolean;
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
    trustWorkspace?: boolean,
  ): Promise<BridgeSessionInfo | undefined>;
  selectSession(sessionId: string): Promise<void>;
  setSearch(value: string): void;
  setProjectOrderOpen(open: boolean): void;
  setCollapsedProjectIds(value: Set<string> | ((current: Set<string>) => Set<string>)): void;
  setSectionCreate(value: { name: string; busy: boolean; error: string } | undefined): void;
  setCreateOpen(open: boolean): void;
  onOpenSessionActions(sessionId: string): void;
  toggleProject(projectId: string, isEmptyManualGroup?: boolean): void;
  toggleForkGroup(parentSessionId: string): void;
  openCreateDialogForProject(targetProjectId?: string): void;
  placeProjects(order: string[]): void;
  closeSectionCreate(): void;
  createSection(): Promise<void>;
}

export function MobileSessionCatalog({
  open = false,
  onClose,
  hosts,
  activeHostId,
  onSelectHost,
  onAddHost,
  hostSwitcherOpen = false,
  onToggleHostSwitcher,
  activeTab = "sessions",
  onSelectTab,
  assistantAvailable = false,
  assistantUnreadCount = 0,
  themeControl,
  onStartNewChat,
  selectedSessionId,
  archivedExpanded = false,
  onToggleArchived,
  expandedEmptyProjectIds,
  revealedEmptySectionKey,
  createDialogState,
  onCloseCreateDialog,
  onDeliverInitialPrompt,
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
  onOpenSessionActions,
  toggleProject,
  toggleForkGroup,
  openCreateDialogForProject,
  placeProjects,
  closeSectionCreate,
  createSection,
}: MobileSessionCatalogProps) {
  const searchQuery = search.trim().toLocaleLowerCase();
  const supportsCreateSection = Boolean(onCreateSection && snapshot?.host.capabilities.includes("section.create.v1"));
  const hasActiveSessions = sessions.some((candidate) => !candidate.archivedAt);
  const filteredArchivedSessions = searchQuery
    ? archivedSessions.filter((candidate) => (
        `${candidate.title}\n${candidate.currentSummary ?? ""}\n${candidate.projectName}\n${candidate.cwd}`
          .toLocaleLowerCase()
          .includes(searchQuery)
      ))
    : archivedSessions;
  const archivedFamilies = groupProjectSessionFamilies(filteredArchivedSessions);
  const effectiveCreateDialog = createDialogState ?? (createOpen ? { initialProjectId: createProjectId || undefined } : undefined);

  return (
    <>
      <div
        className="mobile-home-catalog is-flat-tree"
        aria-label="会话列表"
      >
        <div className="mobile-drawer-topbar">
          <button
            type="button"
            className="m-host-chip drawer-host-switcher"
            aria-expanded={hosts ? hostSwitcherOpen : undefined}
            aria-label={`当前电脑：${desktopName}，切换电脑`}
            onClick={() => {
              if (hosts && onToggleHostSwitcher) onToggleHostSwitcher();
              else {
                onClose?.();
                onBackToHosts();
              }
            }}
          >
            <i className={`m-status-dot${desktopOnline ? " is-online" : ""}`} aria-hidden="true" />
            <span className="m-host-name">{desktopName}</span>
            <ChevronDown size={14} aria-hidden="true" />
          </button>
          <IconButton
            label="新建会话"
            className="drawer-compose-button"
            disabled={!snapshot || connection !== "connected" || !desktopOnline}
            onClick={() => {
              if (onStartNewChat) {
                onStartNewChat();
              } else {
                openCreateDialogForProject();
              }
            }}
          >
            <SquarePen size={17} />
          </IconButton>
        </div>

        {hosts && hostSwitcherOpen && (
          <div className="drawer-host-menu" role="region" aria-label="快捷切换电脑">
            <div className="drawer-host-options">
              {hosts.map((host) => {
                const isCurrent = host.roomId === activeHostId;
                const isOnline = isCurrent ? desktopOnline : host.status !== "offline" && !host.needsRepair;
                return (
                  <button
                    type="button"
                    key={host.roomId}
                    className={`drawer-host-option${isCurrent ? " active" : ""}`}
                    aria-current={isCurrent ? "true" : undefined}
                    onClick={() => {
                      onToggleHostSwitcher?.();
                      onClose?.();
                      void onSelectHost?.(host.roomId);
                    }}
                  >
                    <i className={`m-status-dot${isOnline ? " is-online" : ""}`} aria-hidden="true" />
                    <span className="drawer-host-option-name">{host.desktopName}</span>
                    <span className="drawer-host-option-meta">
                      {hostQuickMeta(host, isCurrent, desktopOnline, transportMetrics)}
                    </span>
                  </button>
                );
              })}
            </div>
            {onAddHost && (
              <button
                type="button"
                className="drawer-host-add"
                onClick={() => {
                  onToggleHostSwitcher?.();
                  onClose?.();
                  onAddHost();
                }}
              >
                <Plus size={14} aria-hidden="true" />
                <span>扫码添加新电脑</span>
              </button>
            )}
          </div>
        )}

        <div className="drawer-top-stack">
          {assistantAvailable && onSelectTab && (
            <button
              type="button"
              className={`sidebar-assistant-row${activeTab === "assistant" ? " active" : ""}`}
              aria-current={activeTab === "assistant" ? "page" : undefined}
              onClick={() => {
                onSelectTab("assistant");
                onClose?.();
              }}
            >
              <span className="sidebar-assistant-main">
                <Mail size={15} className="sidebar-assistant-icon" aria-hidden="true" />
                <span className="sidebar-assistant-label">助理</span>
              </span>
              {assistantUnreadCount > 0 && (
                <span className="sidebar-assistant-unread" aria-hidden="true">
                  <i className="sidebar-unread-dot" />
                  <b className="desktop-nav-badge">{assistantUnreadCount > 99 ? "99+" : assistantUnreadCount}</b>
                </span>
              )}
            </button>
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

        <section
          className="drawer-project-list host-detail"
          ref={directoryRef}
          onScroll={(event) => directoryScrollPositions.current.set("", event.currentTarget.scrollTop)}
        >
          {!searchQuery && (supportsCreateSection || projectOrder.length > 1 || hasActiveSessions) && (
            <div className="project-order-bar sidebar-section-bar">
              <span className="sidebar-section-label">项目</span>
              <div className="sidebar-section-actions">
                {supportsCreateSection && (
                  <button
                    type="button"
                    className="sidebar-micro-action"
                    disabled={connection !== "connected" || !desktopOnline}
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

          {permissions[0] && (
            <button
              type="button"
              className="host-permission-alert"
              onClick={() => {
                onClose?.();
                void selectSession(permissions[0]!.sessionId);
              }}
            >
              <span className="permission-dock-icon"><AlertTriangle size={16} /></span>
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

          {!snapshot && connection === "connected" && desktopOnline && (
            <EmptyState
              icon={<LoaderCircle className="is-spinning" size={20} />}
              title="正在同步主机状态"
              description="已保存的会话会在连接恢复后自动出现。"
            />
          )}

          {(snapshot ? (!hasActiveSessions && grouped.length === 0) || (Boolean(searchQuery) && grouped.length === 0) : connection !== "connected" || !desktopOnline) && (() => {
            const claudeRuntime = snapshot?.runtimes?.find((candidate) => candidate.id === "claude-desktop");
            const claudeDesktopReady = claudeRuntime
              ? claudeRuntime.state === "ready"
              : snapshot?.runtime.state === "ready" || snapshot?.runtime.state === "working";
            if (searchQuery) {
              return (
                <EmptyState title="没有匹配的会话" description="换一个关键词试试。" />
              );
            }
            if (connection === "connected" && desktopOnline && claudeDesktopReady) {
              const canCreate = snapshot?.runtimes
                ? claudeRuntime?.state === "ready" && claudeRuntime.capabilities.includes("session.create")
                : claudeDesktopReady;
              return (
                <EmptyState
                  title={archivedSessions.length > 0 ? "暂无活跃会话" : "暂无会话"}
                  description={archivedSessions.length > 0
                    ? canCreate ? "当前会话均已归档，可开始新对话或查看下方已归档会话。" : "当前会话均已归档，可查看下方已归档会话。"
                    : canCreate ? "当前电脑上尚未创建会话，可随时开始新的对话。" : "当前电脑上尚未创建会话，请在 Claude Desktop 中创建会话。"}
                  action={canCreate && (
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
              );
            }
            if (connection === "connected" && desktopOnline) {
              return (
                <EmptyState
                  title="未检测到 Claude Desktop"
                  description="请在电脑端打开 Claude Desktop。启动后 Bridge 将自动建立连接。"
                  action={(
                    <button
                      type="button"
                      className="secondary-button session-catalog-empty-action"
                      onClick={() => {
                        onClose?.();
                        (onInspectConnection ?? onBackToHosts)();
                      }}
                    >
                      检查连接
                    </button>
                  )}
                />
              );
            }
            const connecting = connection === "connecting" || connection === "reconnecting";
            return (
              <EmptyState
                icon={connecting && <LoaderCircle className="is-spinning" size={20} />}
                title={connecting ? "正在连接电脑" : connection === "connected" ? "电脑端 Bridge 离线" : "当前未连接电脑"}
                description={connecting ? "连接恢复后将自动同步会话列表。" : connection === "connected" ? "请确认电脑端 Bridge 正在运行并已连接网络。" : "请检查网络或连接设置，连接恢复后将自动同步。"}
                action={(
                  <button
                    type="button"
                    className="secondary-button session-catalog-empty-action"
                    onClick={() => {
                      onClose?.();
                      (onInspectConnection ?? onBackToHosts)();
                    }}
                  >
                    检查连接
                  </button>
                )}
              />
            );
          })()}

          {(grouped.length > 0 || archivedSessions.length > 0) && (
            <div className="project-groups">
              {grouped.map((group) => {
                const projectId = group.project?.projectId ?? group.sessions[0]!.projectId;
                const projectName = group.project?.name ?? group.sessions[0]!.projectName;
                const families = groupProjectSessionFamilies(group.sessions);
                const totalCount = families.length;
                const isEmptyManualGroup = group.project?.kind === "desktop-group" && totalCount === 0;
                const expanded = searchQuery
                  ? true
                  : isEmptyManualGroup
                    ? (projectId === revealedEmptySectionKey || Boolean(expandedEmptyProjectIds?.has(projectId)))
                    : !collapsedProjectIds.has(projectId);
                const sessionsId = `mobile-project-${encodeURIComponent(projectId)}`;
                return (
                  <section
                    className={`project-group ${expanded ? "expanded" : "collapsed"}${isEmptyManualGroup ? " is-empty-group" : ""}`}
                    key={projectId}
                  >
                    <ProjectGroupHeader
                      title={projectName}
                      count={totalCount}
                      expanded={expanded}
                      controlsId={sessionsId}
                      onToggle={() => toggleProject(projectId, isEmptyManualGroup)}
                      actions={(
                        <>
                          <IconButton
                            label={`新建会话：${projectName}`}
                            className="session-row-action"
                            disabled={!snapshot || connection !== "connected" || !desktopOnline}
                            onClick={() => openCreateDialogForProject(projectId)}
                          >
                            <Plus size={16} />
                          </IconButton>
                          {sectionManage.canManage(group.project) && (
                            <IconButton
                              label={`管理分组：${projectName}`}
                              className="session-row-action section-manage-trigger"
                              onClick={() => sectionManage.openMenu(group.project!.projectId)}
                            >
                              <MoreHorizontal size={16} />
                            </IconButton>
                          )}
                        </>
                      )}
                    />
                    {expanded && (
                      <div className="session-rows" id={sessionsId}>
                        {families.length === 0 ? (
                          <p className="empty-section-hint">暂无会话</p>
                        ) : (
                          <SessionFamilyList
                            families={families}
                            projects={snapshot?.projects}
                            permissions={permissions}
                            expandedForkParents={expandedForkParents}
                            flat
                            selectedId={selectedSessionId}
                            onSelectSession={(targetSessionId) => {
                              onClose?.();
                              return selectSession(targetSessionId);
                            }}
                            onOpenSessionActions={onOpenSessionActions}
                            onToggleForkGroup={toggleForkGroup}
                          />
                        )}
                      </div>
                    )}
                  </section>
                );
              })}

              {archivedSessions.length > 0 && (
                <section className={`project-group archived-group ${archivedExpanded ? "expanded" : "collapsed"}`}>
                  <ProjectGroupHeader
                    title="已归档"
                    count={archivedSessions.length}
                    expanded={archivedExpanded}
                    controlsId="mobile-archived-sessions"
                    onToggle={() => onToggleArchived?.()}
                  />
                  {archivedExpanded && (
                    <div id="mobile-archived-sessions" className="session-rows">
                      {archivedFamilies.length === 0 ? (
                        <p className="empty-section-hint">没有匹配的已归档会话</p>
                      ) : (
                        <SessionFamilyList
                          families={archivedFamilies}
                          projects={snapshot?.projects}
                          permissions={permissions}
                          expandedForkParents={expandedForkParents}
                          archivedList
                          flat
                          selectedId={selectedSessionId}
                          onSelectSession={(targetSessionId) => {
                            onClose?.();
                            return selectSession(targetSessionId);
                          }}
                          onOpenSessionActions={onOpenSessionActions}
                          onToggleForkGroup={toggleForkGroup}
                        />
                      )}
                    </div>
                  )}
                </section>
              )}
            </div>
          )}
        </section>

        <footer className="mobile-drawer-dock">
          <nav className="mobile-drawer-dock-nav" aria-label="主要导航">
            <button
              type="button"
              className={`mobile-dock-link${activeTab === "computers" ? " active" : ""}`}
              aria-current={activeTab === "computers" ? "page" : undefined}
              onClick={() => {
                if (onSelectTab) onSelectTab("computers");
                else onBackToHosts();
                onClose?.();
              }}
            >
              电脑
            </button>
            {onSelectTab && (
              <button
                type="button"
                className={`mobile-dock-link${activeTab === "settings" ? " active" : ""}`}
                aria-current={activeTab === "settings" ? "page" : undefined}
                onClick={() => {
                  onSelectTab("settings");
                  onClose?.();
                }}
              >
                设置
              </button>
            )}
          </nav>
          {themeControl && <ThemeMenu control={themeControl} side="right" iconSize={16} />}
        </footer>
      </div>

      {sessionOverlays}
      {projectOrderOpen && (
        <ProjectOrderSheet
          manageFocus
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
      {effectiveCreateDialog && snapshot && (
        <SessionCreateDialog
          key={`${snapshot.host.hostId}:${effectiveCreateDialog.initialProjectId ?? ""}:${effectiveCreateDialog.initialCwd ?? ""}:${effectiveCreateDialog.onPickDirectory ? "pick" : "create"}`}
          snapshot={snapshot}
          connected={connection === "connected" && desktopOnline}
          {...(effectiveCreateDialog.initialProjectId ? { initialProjectId: effectiveCreateDialog.initialProjectId } : {})}
          {...(effectiveCreateDialog.initialCwd ? { initialCwd: effectiveCreateDialog.initialCwd } : {})}
          {...(effectiveCreateDialog.onPickDirectory ? { onPickDirectory: effectiveCreateDialog.onPickDirectory } : {})}
          {...(onBrowseDirectory ? { onBrowseDirectory } : {})}
          {...(onCreateDirectory ? { onCreateDirectory } : {})}
          onCreate={onCreateSession}
          onCreated={(created) => {
            const pendingPrompt = effectiveCreateDialog.pendingPrompt;
            setCollapsedProjectIds((current) => expandProject(current, created.projectId));
            onClose?.();
            if (pendingPrompt?.trim()) {
              onDeliverInitialPrompt?.(created, pendingPrompt);
            }
            void Promise.resolve(onRefresh()).then(() => selectSession(created.sessionId));
          }}
          onClose={() => {
            if (onCloseCreateDialog) onCloseCreateDialog();
            else setCreateOpen(false);
          }}
        />
      )}
    </>
  );
}

export { MobileSessionCatalog as MobileSessionDrawer };
