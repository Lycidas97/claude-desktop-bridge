import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BridgeEffort } from "@bridge/protocol";

interface DesktopSessionFile {
  sessionId?: unknown;
  cliSessionId?: unknown;
  cwd?: unknown;
  lastFocusedAt?: unknown;
  createdAt?: unknown;
  lastActivityAt?: unknown;
  isArchived?: unknown;
  title?: unknown;
  model?: unknown;
  effort?: unknown;
  sessionSettings?: unknown;
  forkedFromSessionId?: unknown;
  spawnedFrom?: unknown;
  detached?: unknown;
  lineageDetached?: unknown;
}

interface ArchivedSessionsIndexFile {
  archived?: unknown;
}

export type ClaudeSessionEffort = BridgeEffort;
export type ClaudeDesktopProfile = "claude" | "claude-3p" | "unknown";

export interface ClaudeDesktopSession {
  sessionId: string;
  cliSessionId: string;
  cwd: string;
  lastFocusedAt: number;
  createdAt: number;
  lastActivityAt: number;
  title?: string;
  model?: string;
  effort?: ClaudeSessionEffort;
  profile: ClaudeDesktopProfile;
  ultracode?: boolean;
  parentSessionId?: string;
  forkLabel?: string;
}

export interface ClaudeDesktopSessionState {
  sessions: ClaudeDesktopSession[];
  archivedCliSessionIds: Set<string>;
}

function parseEffort(value: unknown): ClaudeSessionEffort | undefined {
  return value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
    ? value
    : undefined;
}

export function claudeDesktopProfileForPath(path: string): ClaudeDesktopProfile {
  const normalized = path.replaceAll("\\", "/");
  if (/(?:^|\/)Claude-3p(?:\/|$)/iu.test(normalized)) return "claude-3p";
  if (/(?:^|\/)Claude(?:\/|$)/iu.test(normalized)) return "claude";
  return "unknown";
}

function parseUltracode(value: unknown): boolean | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const ultracode = (value as Record<string, unknown>).ultracode;
  return typeof ultracode === "boolean" ? ultracode : undefined;
}

async function collectJsonFiles(root: string, depth = 3): Promise<string[]> {
  if (depth < 0) return [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(path);
    } else if (entry.isDirectory() && depth > 0) {
      files.push(...await collectJsonFiles(path, depth - 1));
    }
  }
  return files;
}

export async function listClaudeDesktopSessionState(roots: string[]): Promise<ClaudeDesktopSessionState> {
  const files = (await Promise.all(roots.map(async (root) => (
    (await collectJsonFiles(root)).map((file) => ({ file, root }))
  )))).flat();
  const dirs = new Set(files.map(({ file }) => dirname(file)));
  const archivedDesktopIds = new Set<string>();
  await Promise.all([...dirs].map(async (dir) => {
    try {
      const raw = JSON.parse(await readFile(join(dir, "archived-sessions.idx"), "utf8")) as ArchivedSessionsIndexFile;
      if (Array.isArray(raw.archived)) {
        for (const id of raw.archived) {
          if (typeof id === "string" && id.trim()) archivedDesktopIds.add(id.trim());
        }
      }
    } catch {
      // Optional index file; individual session records remain authoritative.
    }
  }));

  const parsedFiles: Array<{ value: DesktopSessionFile; root: string }> = [];
  const desktopToCli = new Map<string, string>();
  for (const { file, root } of files) {
    let value: DesktopSessionFile;
    try {
      value = JSON.parse(await readFile(file, "utf8")) as DesktopSessionFile;
    } catch {
      continue;
    }
    if (typeof value.sessionId === "string" && typeof value.cliSessionId === "string") {
      desktopToCli.set(value.sessionId, value.cliSessionId);
      if (value.isArchived === true) {
        archivedDesktopIds.add(value.sessionId);
      }
    }
    parsedFiles.push({ value, root });
  }

  const sessions: ClaudeDesktopSession[] = [];
  const archivedCliSessionIds = new Set<string>();
  const activeCliSessionIds = new Set<string>();
  for (const { value, root } of parsedFiles) {
    if (
      typeof value.sessionId !== "string" ||
      typeof value.cliSessionId !== "string" ||
      typeof value.cwd !== "string"
    ) continue;
    const spawnedFrom = typeof value.spawnedFrom === "object" && value.spawnedFrom !== null && !Array.isArray(value.spawnedFrom)
      ? value.spawnedFrom as Record<string, unknown>
      : undefined;
    const isDetached = value.detached === true || value.lineageDetached === true;
    const isBtwChild = spawnedFrom?.btw === true && !isDetached;
    const rawParentDesktopId = isDetached
      ? undefined
      : typeof value.forkedFromSessionId === "string" && value.forkedFromSessionId.trim()
        ? value.forkedFromSessionId.trim()
        : typeof spawnedFrom?.sessionId === "string" && spawnedFrom.sessionId.trim()
          ? spawnedFrom.sessionId.trim()
          : undefined;
    const isParentArchived = Boolean(rawParentDesktopId && archivedDesktopIds.has(rawParentDesktopId));
    if (
      value.isArchived === true ||
      archivedDesktopIds.has(value.sessionId) ||
      isBtwChild ||
      isParentArchived
    ) {
      archivedCliSessionIds.add(value.cliSessionId);
      continue;
    }
    activeCliSessionIds.add(value.cliSessionId);
    const lastFocusedAt = typeof value.lastFocusedAt === "number" ? value.lastFocusedAt : 0;
    const createdAt = typeof value.createdAt === "number" ? value.createdAt : lastFocusedAt;
    const lastActivityAt = typeof value.lastActivityAt === "number" ? value.lastActivityAt : lastFocusedAt;
    const effort = parseEffort(value.effort);
    const ultracode = parseUltracode(value.sessionSettings);
    const parentSessionId = rawParentDesktopId
      ? desktopToCli.get(rawParentDesktopId)
        ?? (rawParentDesktopId.startsWith("local_") ? rawParentDesktopId.slice("local_".length) : rawParentDesktopId)
      : undefined;
    const forkLabel = parentSessionId
      ? typeof spawnedFrom?.name === "string" && spawnedFrom.name.trim()
        ? spawnedFrom.name.trim()
        : "fork"
      : undefined;
    const rawTitle = typeof value.title === "string" ? value.title.trim() : "";
    const spawnedTitle = typeof spawnedFrom?.title === "string" ? spawnedFrom.title.trim() : "";
    const title = parentSessionId && spawnedTitle && (!rawTitle || spawnedTitle === `${rawTitle} (fork)`)
      ? spawnedTitle
      : rawTitle;
    sessions.push({
      sessionId: value.sessionId,
      cliSessionId: value.cliSessionId,
      cwd: value.cwd,
      lastFocusedAt,
      createdAt,
      lastActivityAt,
      profile: claudeDesktopProfileForPath(root),
      ...(title ? { title } : {}),
      ...(typeof value.model === "string" && value.model.trim() ? { model: value.model.trim() } : {}),
      ...(effort ? { effort } : {}),
      ...(ultracode !== undefined ? { ultracode } : {}),
      ...(parentSessionId && parentSessionId !== value.cliSessionId ? { parentSessionId } : {}),
      ...(forkLabel && parentSessionId !== value.cliSessionId ? { forkLabel } : {}),
    });
  }
  for (const activeId of activeCliSessionIds) {
    archivedCliSessionIds.delete(activeId);
  }
  return {
    sessions: sessions.sort((left, right) => (
      Math.max(right.lastFocusedAt, right.lastActivityAt)
      - Math.max(left.lastFocusedAt, left.lastActivityAt)
    )),
    archivedCliSessionIds,
  };
}

export async function listClaudeDesktopSessions(roots: string[]): Promise<ClaudeDesktopSession[]> {
  return (await listClaudeDesktopSessionState(roots)).sessions;
}

export async function findClaudeDesktopSessionId(
  roots: string[],
  cliSessionId: string,
): Promise<string | undefined> {
  const sessions = await listClaudeDesktopSessions(roots);
  return sessions.find((session) => session.cliSessionId === cliSessionId)?.sessionId;
}
