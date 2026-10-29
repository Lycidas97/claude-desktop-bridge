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
  forks: T[];
  lastActivityAt: number;
}

export function groupProjectSessionFamilies<T extends {
  sessionId: string;
  parentSessionId?: string;
  lastActivityAt: number;
}>(sessions: readonly T[]): SessionFamily<T>[] {
  const byId = new Map(sessions.map((session) => [session.sessionId, session]));
  const findRootId = (sessionId: string): string => {
    let current = sessionId;
    const seen = new Set<string>([current]);
    while (true) {
      const parentId = byId.get(current)?.parentSessionId;
      if (!parentId || !byId.has(parentId) || seen.has(parentId)) return current;
      seen.add(parentId);
      current = parentId;
    }
  };
  const forksByRoot = new Map<string, T[]>();
  const primaries: T[] = [];
  for (const session of sessions) {
    const rootId = findRootId(session.sessionId);
    if (rootId === session.sessionId) {
      primaries.push(session);
    } else {
      const list = forksByRoot.get(rootId) ?? [];
      list.push(session);
      forksByRoot.set(rootId, list);
    }
  }
  return primaries
    .map((primary) => {
      const forks = sortProjectSessionsByRecent(forksByRoot.get(primary.sessionId) ?? []);
      const lastActivityAt = Math.max(
        primary.lastActivityAt,
        ...forks.map((fork) => fork.lastActivityAt),
      );
      return { primary, forks, lastActivityAt };
    })
    .sort((left, right) => right.lastActivityAt - left.lastActivityAt);
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
