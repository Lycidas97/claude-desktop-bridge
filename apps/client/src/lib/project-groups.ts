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

export function sortProjectSessionsByRecent<T extends { lastActivityAt: number }>(
  sessions: readonly T[],
): T[] {
  return [...sessions].sort((left, right) => right.lastActivityAt - left.lastActivityAt);
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
}>(sessions: readonly T[]): SessionFamily<T>[] {
  const byId = new Map<string, SessionFamily<T>>(sessions.map((primary) => [
    primary.sessionId,
    { primary, forks: [], lastActivityAt: primary.lastActivityAt },
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
        family.primary.lastActivityAt,
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
): {
  preview: SessionFamily<T>[];
  totalCount: number;
  hiddenCount: number;
} {
  const families = groupProjectSessionFamilies(sessions);
  const safeLimit = Math.max(0, limit);
  const preview = families.slice(0, safeLimit);
  return {
    preview,
    totalCount: families.length,
    hiddenCount: Math.max(0, families.length - preview.length),
  };
}
