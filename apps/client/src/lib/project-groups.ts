export const PROJECT_PREVIEW_SESSION_LIMIT = 3;

export function toggleCollapsedProject(
  current: Set<string>,
  projectId: string,
): Set<string> {
  const next = new Set(current);
  if (next.has(projectId)) next.delete(projectId);
  else next.add(projectId);
  return next;
}

export function expandProject(
  current: Set<string>,
  projectId: string,
): Set<string> {
  if (!current.has(projectId)) return current;
  const next = new Set(current);
  next.delete(projectId);
  return next;
}

export function collapseProjects(projectIds: Iterable<string>): Set<string> {
  return new Set(projectIds);
}

export function expandAllProjects(): Set<string> {
  return new Set();
}

/** Activity timestamp used to order sessions and their fork families. */
export type SessionRecency<T> = (session: T) => number;

const lastActivity = (session: { lastActivityAt: number }) => session.lastActivityAt;

export function sortProjectSessionsByRecent<T extends { lastActivityAt: number }>(
  sessions: readonly T[],
  recency: SessionRecency<T> = lastActivity,
): T[] {
  return [...sessions].sort((left, right) => recency(right) - recency(left));
}

/**
 * The user's project order: projects they placed keep their places, and projects they
 * have not placed yet (new ones) lead in their given order so they are not missed.
 */
export function orderProjects(projectIds: readonly string[], placed: readonly string[]): string[] {
  return [
    ...projectIds.filter((projectId) => !placed.includes(projectId)),
    ...placed.filter((projectId) => projectIds.includes(projectId)),
  ];
}

export function moveProject(order: readonly string[], projectId: string, index: number): string[] {
  const next = order.filter((candidate) => candidate !== projectId);
  next.splice(index, 0, projectId);
  return next;
}

export function previewProjectSessions<T extends { lastActivityAt: number }>(
  sessions: readonly T[],
  limit = PROJECT_PREVIEW_SESSION_LIMIT,
): {
  preview: T[];
  totalCount: number;
  hiddenCount: number;
} {
  const sorted = sortProjectSessionsByRecent(sessions);
  const safeLimit = Math.max(0, limit);
  const preview = sorted.slice(0, safeLimit);
  return {
    preview,
    totalCount: sorted.length,
    hiddenCount: Math.max(0, sorted.length - preview.length),
  };
}

export interface SessionFamily<T> {
  primary: T;
  forks: SessionFamily<T>[];
  lastActivityAt: number;
}

export function getSessionAncestorIds<T extends {
  sessionId: string;
  parentSessionId?: string;
}>(sessions: readonly T[], sessionId: string): string[] {
  const byId = new Map(sessions.map((session) => [session.sessionId, session]));
  const ancestors = new Set<string>();
  let parentId = byId.get(sessionId)?.parentSessionId;
  while (parentId && byId.has(parentId) && parentId !== sessionId && !ancestors.has(parentId)) {
    ancestors.add(parentId);
    parentId = byId.get(parentId)?.parentSessionId;
  }
  return [...ancestors];
}

export function groupProjectSessionFamilies<T extends {
  sessionId: string;
  parentSessionId?: string;
  lastActivityAt: number;
}>(sessions: readonly T[], recency: SessionRecency<T> = lastActivity): SessionFamily<T>[] {
  const byId = new Map<string, SessionFamily<T>>(sessions.map((primary) => [
    primary.sessionId,
    { primary, forks: [], lastActivityAt: recency(primary) },
  ]));
  const roots: SessionFamily<T>[] = [];
  for (const family of byId.values()) {
    const parent = family.primary.parentSessionId
      ? byId.get(family.primary.parentSessionId)
      : undefined;
    if (parent) parent.forks.push(family);
    else roots.push(family);
  }
  function sortFamilies(families: SessionFamily<T>[]): SessionFamily<T>[] {
    for (const family of families) {
      sortFamilies(family.forks);
      family.lastActivityAt = Math.max(
        recency(family.primary),
        ...family.forks.map((fork) => fork.lastActivityAt),
      );
    }
    return families.sort((left, right) => right.lastActivityAt - left.lastActivityAt);
  }
  return sortFamilies(roots);
}

export function previewProjectSessionFamilies<T extends {
  sessionId: string;
  parentSessionId?: string;
  lastActivityAt: number;
}>(
  sessions: readonly T[],
  limit = PROJECT_PREVIEW_SESSION_LIMIT,
  recency: SessionRecency<T> = lastActivity,
): {
  preview: SessionFamily<T>[];
  totalCount: number;
  hiddenCount: number;
} {
  const families = groupProjectSessionFamilies(sessions, recency);
  const safeLimit = Math.max(0, limit);
  const preview = families.slice(0, safeLimit);
  return {
    preview,
    totalCount: families.length,
    hiddenCount: Math.max(0, families.length - preview.length),
  };
}
