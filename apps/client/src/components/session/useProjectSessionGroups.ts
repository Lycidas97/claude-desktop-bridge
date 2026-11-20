import type { BridgeProjectInfo, BridgeSessionInfo } from "@bridge/protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  expandProject,
  getSessionAncestorIds,
  groupProjectSessionFamilies,
  orderProjects,
  readStoredProjectOrder,
  sortProjectSessionsByRecent,
  toggleCollapsedProject,
  writeStoredProjectOrder,
} from "../../lib/project-groups.js";

export interface ProjectSessionGroup {
  projectId: string;
  project: BridgeProjectInfo | undefined;
  sessions: BridgeSessionInfo[];
}

export function useProjectSessionGroups({
  hostId,
  projects,
  sessions,
  selectedSessionId,
}: {
  hostId: string;
  projects: readonly BridgeProjectInfo[] | undefined;
  sessions: readonly BridgeSessionInfo[];
  selectedSessionId: string | undefined;
}) {
  // Keep `search` as the first useState in this hook so MobileWorkspace's state order stays deterministic.
  const [search, setSearch] = useState("");
  const [archivedExpanded, setArchivedExpanded] = useState(false);
  const [revealedEmptySectionKey, setRevealedEmptySectionKey] = useState<string>();
  const [expandedEmptyProjectIds, setExpandedEmptyProjectIds] = useState<Set<string>>(() => new Set());
  const [projectOrderOpen, setProjectOrderOpen] = useState(false);
  const projectOrderKey = `bridge-project-order:${hostId}`;
  const [placedProjectsState, setPlacedProjectsState] = useState<{ key: string; order: string[] }>(() => ({
    key: projectOrderKey,
    order: readStoredProjectOrder(projectOrderKey),
  }));
  const placedProjects = placedProjectsState.key === projectOrderKey
    ? placedProjectsState.order
    : readStoredProjectOrder(projectOrderKey);
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<Set<string>>(() => new Set());
  const [expandedForkParents, setExpandedForkParents] = useState<Set<string>>(() => new Set());
  const [expandedOlderSessions, setExpandedOlderSessions] = useState<Set<string>>(() => new Set());
  const autoExpandedForkKeysRef = useRef(new Set<string>());

  const manualSections = useMemo(
    () => (projects ?? []).filter((project) => project.kind === "desktop-group"),
    [projects],
  );
  const activeSessions = useMemo(
    () => sessions.filter((session) => !session.archivedAt),
    [sessions],
  );

  const managedProjectId = projects?.find(project => project.managedAssistant)?.projectId;
  const projectsByActivity = useMemo(() => {
    const latest = new Map<string, number>(
      manualSections.map((project) => [project.projectId, 0]),
    );
    if (managedProjectId) latest.set(managedProjectId, 0);
    for (const session of sessions) {
      if (!session.archivedAt) {
        latest.set(session.projectId, Math.max(latest.get(session.projectId) ?? 0, session.lastActivityAt));
      }
    }
    return [...latest.keys()].sort((left, right) => (
      Number(left === managedProjectId) - Number(right === managedProjectId) || latest.get(right)! - latest.get(left)!
    ));
  }, [managedProjectId, manualSections, sessions]);

  const projectOrder = useMemo(
    () => orderProjects(projectsByActivity, placedProjects, managedProjectId),
    [managedProjectId, placedProjects, projectsByActivity],
  );

  function placeProjects(order: string[]): void {
    order = order.filter(projectId => projectId !== managedProjectId);
    writeStoredProjectOrder(projectOrderKey, order);
    setPlacedProjectsState({ key: projectOrderKey, order });
  }

  useEffect(() => {
    const unplaced = projectOrder.filter((projectId) => projectId !== managedProjectId && !placedProjects.includes(projectId));
    if (unplaced.length || (managedProjectId && placedProjects.includes(managedProjectId))) {
      placeProjects([...unplaced, ...placedProjects]);
    }
  }, [managedProjectId, placedProjects, projectOrder]);

  useEffect(() => {
    if (search.trim()) setCollapsedProjectIds(new Set());
  }, [search]);

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

  const searchQuery = search.trim().toLocaleLowerCase();

  const grouped = useMemo<ProjectSessionGroup[]>(() => {
    const matches = sessions.filter((session) => (
      !searchQuery
      || `${session.title}\n${session.currentSummary ?? ""}\n${session.projectName}\n${session.cwd}`
        .toLocaleLowerCase()
        .includes(searchQuery)
    ));
    const matchingActiveParents = new Map(
      matches.filter((session) => !session.archivedAt).map((session) => [session.sessionId, session.projectId]),
    );
    const filtered = matches.filter((session) => (
      !session.archivedAt
      || Boolean(
        session.sidechat
        && session.parentSessionId
        && matchingActiveParents.get(session.parentSessionId) === session.projectId,
      )
    ));
    const groups = new Map<string, BridgeSessionInfo[]>(
      (projects ?? [])
        .filter((project) => project.kind === "desktop-group" || project.managedAssistant)
        .filter((project) => !searchQuery || `${project.name}\n${project.cwd}`.toLocaleLowerCase().includes(searchQuery))
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
        projectId,
        project: projects?.find((candidate) => candidate.projectId === projectId),
        sessions: sortProjectSessionsByRecent(groups.get(projectId)!),
      }));
  }, [projectOrder, projects, searchQuery, sessions]);

  const archivedSessions = useMemo(
    () => sortProjectSessionsByRecent(sessions.filter((session) => Boolean(session.archivedAt))),
    [sessions],
  );
  const archivedFamilies = useMemo(
    () => groupProjectSessionFamilies(archivedSessions),
    [archivedSessions],
  );

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

  function registerCreatedSection(projectId: string, options?: { clearSearch?: boolean | undefined }): void {
    placeProjects([projectId, ...placedProjects.filter((id) => id !== projectId)]);
    setCollapsedProjectIds((current) => expandProject(current, projectId));
    setRevealedEmptySectionKey(projectId);
    if (options?.clearSearch !== false && search.trim()) {
      setSearch("");
    }
  }

  return {
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
    expandedOlderSessions,
    toggleOlderSessions: (projectId: string) => setExpandedOlderSessions(current => toggleCollapsedProject(current, projectId)),
    registerCreatedSection,
  };
}
