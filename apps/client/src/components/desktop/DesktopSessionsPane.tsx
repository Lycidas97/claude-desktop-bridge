import type {
  BridgeDesktopRuntimeId,
  BridgeEvent,
  BridgeResponse,
  BridgeSessionInfo,
  DesktopControlSnapshot,
  LocalBridgeRequest,
} from "@bridge/protocol";
import {
  ArrowDownUp,
  ChevronsDown,
  ChevronsUp,
  MessageSquare,
  Plus,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  collapseProjects,
  expandAllProjects,
  expandProject,
  getSessionAncestorIds,
  groupProjectSessionFamilies,
  orderProjects,
  toggleCollapsedProject,
} from "../../lib/project-groups.js";
import { EmptyState } from "../common/EmptyState.js";
import { IconButton } from "../common/IconButton.js";
import { useConversationDrafts } from "../conversation/ConversationDraftsProvider.js";
import { ProjectOrderSheet } from "../mobile/ProjectOrderSheet.js";
import { ProjectGroupHeader } from "../session/ProjectGroupHeader.js";
import { SessionCreateDialog } from "../session/SessionCreateDialog.js";
import { SessionFamilyList } from "../session/SessionFamilyList.js";
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

  const [createOpen, setCreateOpen] = useState(false);
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

  useEffect(() => {
    if (!focusRequest || handledFocusKeyRef.current === focusRequest.key) return;
    handledFocusKeyRef.current = focusRequest.key;
    const target = snapshot.sessions.find((candidate) => candidate.sessionId === focusRequest.sessionId);
    if (target) {
      setCollapsedProjectIds((current) => expandProject(current, target.projectId));
      if (target.archivedAt) setArchivedExpanded(true);
      const ancestors = getSessionAncestorIds(snapshot.sessions, target.sessionId);
      if (ancestors.length > 0) {
        setExpandedForkParents((current) => new Set([...current, ...ancestors]));
      }
    }
    setSelectedId(focusRequest.sessionId);
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
    const latest = new Map<string, number>();
    for (const session of snapshot.sessions) {
      if (!session.archivedAt) {
        latest.set(session.projectId, Math.max(latest.get(session.projectId) ?? 0, session.lastActivityAt));
      }
    }
    return [...latest.keys()].sort((left, right) => latest.get(right)! - latest.get(left)!);
  }, [snapshot.sessions]);

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

  const grouped = useMemo(() => {
    const activeParentProjects = new Map(
      snapshot.sessions
        .filter((candidate) => !candidate.archivedAt)
        .map((candidate) => [candidate.sessionId, candidate.projectId]),
    );
    const map = new Map<string, BridgeSessionInfo[]>();
    for (const session of snapshot.sessions.filter((candidate) => (
      !candidate.archivedAt
      || Boolean(
        candidate.sidechat
        && candidate.parentSessionId
        && activeParentProjects.get(candidate.parentSessionId) === candidate.projectId,
      )
    ))) {
      const list = map.get(session.projectId) ?? [];
      list.push(session);
      map.set(session.projectId, list);
    }
    return projectOrder
      .filter((projectId) => map.has(projectId))
      .map((projectId) => [projectId, map.get(projectId)!] as const);
  }, [projectOrder, snapshot.sessions]);

  const visibilityAvailable = snapshot.host.capabilities.includes("session.visibility.v1");
  const archivedSessions = useMemo(
    () => snapshot.sessions.filter((candidate) => Boolean(candidate.archivedAt)),
    [snapshot.sessions],
  );

  const groupedProjectIds = useMemo(
    () => grouped.map(([groupProjectId]) => groupProjectId),
    [grouped],
  );
  const allProjectsCollapsed = groupedProjectIds.length > 0
    && groupedProjectIds.every((groupProjectId) => collapsedProjectIds.has(groupProjectId));
  const allProjectsExpanded = groupedProjectIds.length > 0
    && groupedProjectIds.every((groupProjectId) => !collapsedProjectIds.has(groupProjectId));

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
          <div><span>Bridge 1.0</span><h1>会话</h1></div>
          <div className="desktop-sidebar-actions">
            {projectOrder.length > 1 && (
              <IconButton label="调整项目顺序" onClick={() => setProjectOrderOpen(true)}>
                <ArrowDownUp size={17} />
              </IconButton>
            )}
            <IconButton
              label="全部折叠"
              disabled={groupedProjectIds.length === 0 || allProjectsCollapsed}
              onClick={() => setCollapsedProjectIds(collapseProjects(groupedProjectIds))}
            >
              <ChevronsUp size={17} />
            </IconButton>
            <IconButton
              label="全部展开"
              disabled={groupedProjectIds.length === 0 || allProjectsExpanded}
              onClick={() => setCollapsedProjectIds(expandAllProjects())}
            >
              <ChevronsDown size={17} />
            </IconButton>
            <IconButton
              label="新建会话"
              onClick={() => {
                setCreateOpen(true);
              }}
            >
              <Plus size={18} />
            </IconButton>
          </div>
        </div>

        <div className="desktop-project-list">
          {grouped.map(([groupProjectId, sessions]) => {
            const expanded = !collapsedProjectIds.has(groupProjectId);
            const sessionsId = `desktop-project-${encodeURIComponent(groupProjectId)}`;
            const families = groupProjectSessionFamilies(sessions);
            return (
              <section className={expanded ? "expanded" : "collapsed"} key={groupProjectId}>
                <ProjectGroupHeader
                  title={snapshot.projects.find((project) => project.projectId === groupProjectId)?.name ?? sessions[0]!.projectName}
                  count={families.length}
                  expanded={expanded}
                  controlsId={sessionsId}
                  onToggle={() => toggleProject(groupProjectId)}
                />
                {expanded && (
                  <div id={sessionsId}>
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
                  </div>
                )}
              </section>
            );
          })}
          {grouped.length === 0 && (
            <EmptyState
              title={snapshot.runtime.desktopIntegration.state === "ready" ? "暂无活跃会话" : "未检测到 Claude Desktop"}
              action={(
                <button type="button" className="primary-button session-catalog-empty-action" onClick={() => setCreateOpen(true)}>
                  <Plus size={16} />
                  新建会话
                </button>
              )}
            />
          )}
          {visibilityAvailable && archivedSessions.length > 0 && (() => {
            const archivedFamilies = groupProjectSessionFamilies(archivedSessions);
            return (
              <section className={archivedExpanded ? "expanded" : "collapsed"}>
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
      {createOpen && (
        <SessionCreateDialog
          key={hostId}
          snapshot={snapshot}
          connected
          {...(window.bridgeDesktop?.chooseDirectory ? { onChooseDirectory: (path?: string) => window.bridgeDesktop!.chooseDirectory!(path) } : {})}
          onCreate={createSession}
          onCreated={(created) => {
            setCollapsedProjectIds((current) => expandProject(current, created.projectId));
            setSelectedId(created.sessionId);
          }}
          onClose={() => setCreateOpen(false)}
        />
      )}
    </section>
  );
}

export { DesktopSessions as DesktopSessionsPane };
