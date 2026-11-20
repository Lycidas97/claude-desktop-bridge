export {
  CLAUDE_UNSECTIONED_PROJECT_ID,
  CLAUDE_UNSECTIONED_PROJECT_NAME,
  DEFAULT_CONFIGURATION_SESSION_ID,
} from "@bridge/protocol";

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
export function orderProjects(projectIds: readonly string[], placed: readonly string[], managedProjectId?: string): string[] {
  return [
    ...projectIds.filter((projectId) => projectId !== managedProjectId && !placed.includes(projectId)),
    ...placed.filter((projectId) => projectId !== managedProjectId && projectIds.includes(projectId)),
    ...(managedProjectId && projectIds.includes(managedProjectId) ? [managedProjectId] : []),
  ];
}

export function readStoredProjectOrder(storageKey: string): string[] {
  try {
    if (typeof localStorage === "undefined" || typeof localStorage.getItem !== "function") {
      return [];
    }
    const raw = localStorage.getItem(storageKey);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const valid: string[] = [];
    for (const item of parsed) {
      if (typeof item === "string" && item.length > 0 && !seen.has(item)) {
        seen.add(item);
        valid.push(item);
      }
    }
    return valid;
  } catch {
    return [];
  }
}

export function writeStoredProjectOrder(storageKey: string, order: readonly string[]): void {
  try {
    if (typeof localStorage === "undefined" || typeof localStorage.setItem !== "function") {
      return;
    }
    localStorage.setItem(storageKey, JSON.stringify(order));
  } catch {
    // Ignore storage quota or private-mode restrictions so ordering never crashes rendering.
  }
}

export function moveProject(order: readonly string[], projectId: string, index: number): string[] {
  const next = order.filter((candidate) => candidate !== projectId);
  next.splice(index, 0, projectId);
  return next;
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
  archivedAt?: number;
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
        ...family.forks
          .filter((fork) => Boolean(family.primary.archivedAt) || !fork.primary.archivedAt)
          .map((fork) => fork.lastActivityAt),
      );
    }
    return families.sort((left, right) => right.lastActivityAt - left.lastActivityAt);
  }
  return sortFamilies(roots);
}

export function splitRecentSessionFamilies<T extends { parentSessionId?: string }>(families: readonly SessionFamily<T>[]) {
  const recent: SessionFamily<T>[] = [];
  const older: SessionFamily<T>[] = [];
  for (const family of families) {
    if (!family.primary.parentSessionId && recent.length < 3) recent.push(family);
    else older.push(family);
  }
  return { recent, older };
}
