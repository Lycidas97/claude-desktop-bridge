import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BridgeEffort } from "@bridge/protocol";

interface DesktopSessionFile {
  sessionId?: unknown;
  cliSessionId?: unknown;
  priorCliSessionIds?: unknown;
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
  priorCliSessionIds?: string[];
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
  sidechat?: boolean;
  groupId?: string;
  groupName?: string;
}

export interface ClaudeDesktopArchivedSession extends ClaudeDesktopSession {
  /** Desktop saves the record when it archives a session, so the file time is the archive time. */
  archivedAt: number;
}

export interface ClaudeDesktopSessionState {
  sessions: ClaudeDesktopSession[];
  archivedSessions: ClaudeDesktopArchivedSession[];
  /** Record files by CLI session id; kept apart so session objects carry no local paths. */
  metadataPaths: Map<string, string>;
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
  if (/(?:^|\/)(?:Claude|Claude-Data)(?:\/|$)/iu.test(normalized)) return "claude";
  return "unknown";
}

function parseUltracode(value: unknown): boolean | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const ultracode = (value as Record<string, unknown>).ultracode;
  return typeof ultracode === "boolean" ? ultracode : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeDesktopAssignmentKey(key: string): string {
  return key.startsWith("code:") ? key.slice("code:".length).trim() : key.trim();
}

async function readDesktopSessionGroups(roots: string[]): Promise<Map<string, { id: string; name: string }>> {
  const configPaths = new Set<string>();
  for (const root of roots) {
    configPaths.add(join(dirname(root), "claude_desktop_config.json"));
    configPaths.add(join(root, "claude_desktop_config.json"));
  }
  const groupNames = new Map<string, string>();
  const rawAssignments = new Map<string, string>();
  await Promise.all([...configPaths].map(async (configPath) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(configPath, "utf8")) as unknown;
    } catch {
      return;
    }
    if (!isRecord(parsed) || !isRecord(parsed.preferences) || !isRecord(parsed.preferences.epitaxyPrefs)) {
      return;
    }
    const epitaxyPrefs = parsed.preferences.epitaxyPrefs;
    if (isRecord(epitaxyPrefs["dframe-group-scopes"])) {
      for (const scope of Object.values(epitaxyPrefs["dframe-group-scopes"])) {
        if (!isRecord(scope)) continue;
        if (Array.isArray(scope.groups)) {
          for (const group of scope.groups) {
            if (
              isRecord(group) &&
              typeof group.id === "string" &&
              typeof group.name === "string" &&
              group.id.trim() &&
              group.name.trim()
            ) {
              groupNames.set(group.id.trim(), group.name.trim());
            }
          }
        }
        if (isRecord(scope.assignments)) {
          for (const [sessionKey, groupId] of Object.entries(scope.assignments)) {
            const normalizedKey = normalizeDesktopAssignmentKey(sessionKey);
            if (normalizedKey && typeof groupId === "string" && groupId.trim()) {
              rawAssignments.set(normalizedKey, groupId.trim());
            }
          }
        }
      }
    }
    if (isRecord(epitaxyPrefs["dframe-code-sections"])) {
      for (const scope of Object.values(epitaxyPrefs["dframe-code-sections"])) {
        if (!isRecord(scope) || !Array.isArray(scope.sections)) continue;
        for (const section of scope.sections) {
          if (
            !isRecord(section) ||
            section.kind !== "manual" ||
            section.shown === false ||
            typeof section.id !== "string" ||
            typeof section.name !== "string" ||
            !section.id.trim() ||
            !section.name.trim()
          ) continue;
          const sectionId = section.id.trim();
          groupNames.set(sectionId, section.name.trim());
          if (Array.isArray(section.members)) {
            for (const member of section.members) {
              if (typeof member !== "string") continue;
              const normalizedKey = normalizeDesktopAssignmentKey(member);
              if (normalizedKey && !rawAssignments.has(normalizedKey)) {
                rawAssignments.set(normalizedKey, sectionId);
              }
            }
          }
        }
      }
    }
  }));
  const resolved = new Map<string, { id: string; name: string }>();
  for (const [desktopSessionId, groupId] of rawAssignments) {
    const name = groupNames.get(groupId);
    if (name) resolved.set(desktopSessionId, { id: groupId, name });
  }
  return resolved;
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
  const [files, desktopGroups] = await Promise.all([
    Promise.all(roots.map(async (root) => (
      (await collectJsonFiles(root)).map((file) => ({ file, root }))
    ))).then((nested) => nested.flat()),
    readDesktopSessionGroups(roots),
  ]);
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

  interface ParsedDesktopSessionRecord {
    sessionId: string;
    cliSessionId: string;
    cwd: string;
    priorCliSessionIds: string[];
    isArchived: boolean;
    isBtwChild: boolean;
    spawnedName?: string;
    spawnedTitle?: string;
    rawTitle: string;
    lastFocusedAt: number;
    createdAt: number;
    lastActivityAt: number;
    model?: string;
    effort?: ClaudeSessionEffort;
    ultracode?: boolean;
    root: string;
    file: string;
  }

  const parsedFiles: ParsedDesktopSessionRecord[] = [];
  const desktopToCli = new Map<string, string>();
  const desktopParents = new Map<string, string>();
  for (const { file, root } of files) {
    let value: DesktopSessionFile;
    try {
      value = JSON.parse(await readFile(file, "utf8")) as DesktopSessionFile;
    } catch {
      continue;
    }
    if (typeof value.sessionId !== "string" || typeof value.cliSessionId !== "string") {
      continue;
    }
    const { sessionId, cliSessionId } = value;
    desktopToCli.set(sessionId, cliSessionId);
    const isArchived = value.isArchived === true;
    if (isArchived) {
      archivedDesktopIds.add(sessionId);
    }
    const spawnedFrom = isRecord(value.spawnedFrom) ? value.spawnedFrom : undefined;
    const isDetached = value.detached === true || value.lineageDetached === true;
    if (!isDetached) {
      const parent = typeof value.forkedFromSessionId === "string" && value.forkedFromSessionId.trim()
        ? value.forkedFromSessionId.trim()
        : typeof spawnedFrom?.sessionId === "string" ? spawnedFrom.sessionId.trim() : "";
      if (parent) desktopParents.set(sessionId, parent);
    }
    if (typeof value.cwd !== "string") continue;
    const priorCliSessionIds = Array.isArray(value.priorCliSessionIds)
      ? value.priorCliSessionIds
          .filter((priorId): priorId is string => typeof priorId === "string" && Boolean(priorId.trim()))
          .map((priorId) => priorId.trim())
          .filter((priorId) => priorId !== cliSessionId)
      : [];
    const createdAt = typeof value.createdAt === "number" ? value.createdAt : 0;
    const effort = parseEffort(value.effort);
    const ultracode = parseUltracode(value.sessionSettings);
    const spawnedName = typeof spawnedFrom?.name === "string" && spawnedFrom.name.trim()
      ? spawnedFrom.name.trim()
      : undefined;
    const spawnedTitle = typeof spawnedFrom?.title === "string" && spawnedFrom.title.trim()
      ? spawnedFrom.title.trim()
      : undefined;
    const model = typeof value.model === "string" && value.model.trim() ? value.model.trim() : undefined;
    parsedFiles.push({
      sessionId,
      cliSessionId,
      cwd: value.cwd,
      priorCliSessionIds,
      isArchived,
      isBtwChild: spawnedFrom?.btw === true && !isDetached,
      ...(spawnedName ? { spawnedName } : {}),
      ...(spawnedTitle ? { spawnedTitle } : {}),
      rawTitle: typeof value.title === "string" ? value.title.trim() : "",
      lastFocusedAt: typeof value.lastFocusedAt === "number" ? value.lastFocusedAt : 0,
      createdAt,
      lastActivityAt: typeof value.lastActivityAt === "number" ? value.lastActivityAt : createdAt,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(ultracode !== undefined ? { ultracode } : {}),
      root,
      file,
    });
  }

  const sessions: ClaudeDesktopSession[] = [];
  const archivedSessions: ClaudeDesktopArchivedSession[] = [];
  const metadataPaths = new Map<string, string>();
  const archivedCliSessionIds = new Set<string>();
  const activeCliSessionIds = new Set<string>();
  for (const record of parsedFiles) {
    const archived = record.isArchived || archivedDesktopIds.has(record.sessionId);
    let rawParentDesktopId = desktopParents.get(record.sessionId);
    // Keep active descendants, attaching them to the nearest visible ancestor.
    if (!archived) {
      for (let hop = 0; rawParentDesktopId && archivedDesktopIds.has(rawParentDesktopId) && hop < desktopParents.size; hop += 1) {
        const ancestor = desktopParents.get(rawParentDesktopId);
        if (!ancestor) break;
        rawParentDesktopId = ancestor;
      }
    }
    for (const priorId of record.priorCliSessionIds) archivedCliSessionIds.add(priorId);
    if (archived) {
      archivedCliSessionIds.add(record.cliSessionId);
    } else {
      activeCliSessionIds.add(record.cliSessionId);
    }
    const parentSessionId = rawParentDesktopId
      ? desktopToCli.get(rawParentDesktopId)
        ?? (rawParentDesktopId.startsWith("local_") ? rawParentDesktopId.slice("local_".length) : rawParentDesktopId)
      : undefined;
    const forkLabel = parentSessionId
      ? record.spawnedName ?? (record.isBtwChild ? "btw" : "fork")
      : undefined;
    const title = record.isBtwChild
      ? (record.rawTitle || (record.spawnedTitle?.replace(/\s*\(fork\)$/iu, "") ?? ""))
      : parentSessionId && record.spawnedTitle && (!record.rawTitle || record.spawnedTitle === `${record.rawTitle} (fork)`)
        ? record.spawnedTitle
        : record.rawTitle;
    let group = desktopGroups.get(record.sessionId);
    for (
      let hop = 0, cursor = desktopParents.get(record.sessionId);
      cursor && !group && hop < desktopParents.size;
      hop += 1, cursor = desktopParents.get(cursor)
    ) {
      group = desktopGroups.get(cursor);
    }
    const session: ClaudeDesktopSession = {
      sessionId: record.sessionId,
      cliSessionId: record.cliSessionId,
      ...(record.priorCliSessionIds.length ? { priorCliSessionIds: record.priorCliSessionIds } : {}),
      cwd: record.cwd,
      lastFocusedAt: record.lastFocusedAt,
      createdAt: record.createdAt,
      lastActivityAt: record.lastActivityAt,
      profile: claudeDesktopProfileForPath(record.root),
      ...(title ? { title } : {}),
      ...(record.model ? { model: record.model } : {}),
      ...(record.effort ? { effort: record.effort } : {}),
      ...(record.ultracode !== undefined ? { ultracode: record.ultracode } : {}),
      ...(parentSessionId && parentSessionId !== record.cliSessionId ? { parentSessionId } : {}),
      ...(forkLabel && parentSessionId !== record.cliSessionId ? { forkLabel } : {}),
      ...(record.isBtwChild && parentSessionId !== record.cliSessionId ? { sidechat: true } : {}),
      ...(group ? { groupId: group.id, groupName: group.name } : {}),
    };
    metadataPaths.set(record.cliSessionId, record.file);
    if (archived) archivedSessions.push({ ...session, archivedAt: (await stat(record.file)).mtimeMs });
    else sessions.push(session);
  }
  for (const activeId of activeCliSessionIds) {
    archivedCliSessionIds.delete(activeId);
  }
  return {
    sessions: sessions.sort((left, right) => (
      Math.max(right.lastFocusedAt, right.lastActivityAt)
      - Math.max(left.lastFocusedAt, left.lastActivityAt)
    )),
    archivedSessions: archivedSessions.filter((session) => !activeCliSessionIds.has(session.cliSessionId)),
    metadataPaths,
    archivedCliSessionIds,
  };
}

export async function listClaudeDesktopSessions(roots: string[]): Promise<ClaudeDesktopSession[]> {
  return (await listClaudeDesktopSessionState(roots)).sessions;
}
