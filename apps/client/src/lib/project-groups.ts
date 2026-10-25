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

