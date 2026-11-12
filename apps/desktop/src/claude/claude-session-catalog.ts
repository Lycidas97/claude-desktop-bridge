import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, win32 as windowsPath } from "node:path";
import { promisify } from "node:util";
import type { BridgeProjectInfo, BridgeSessionInfo } from "@bridge/protocol";
import {
  listClaudeDesktopSessionState,
  type ClaudeDesktopProfile,
  type ClaudeSessionEffort,
} from "./claude-desktop-sessions.js";
import { findClaudeTranscriptFile } from "../transcript/claude-history.js";
import type { ClaudeRuntimePaths } from "../app/platform.js";

interface ActiveSessionFile {
  pid?: unknown;
  sessionId?: unknown;
  cwd?: unknown;
  startedAt?: unknown;
  entrypoint?: unknown;
  peerProtocol?: unknown;
  messagingSocketPath?: string;
}

export interface ActiveClaudeProcess {
  pid?: number;
  cwd?: string;
  startedAt: number;
  /** Start timestamp resolution; absent when the start time is unknown. */
  startedAtResolutionMs?: number;
  /** Registration timestamp matched to this PID, native session and OS lifetime. */
  registeredAt?: number;
  processAlive: boolean;
  entrypoint: string;
  peerProtocol?: string | number;
  messagingSocketPath?: string;
  source: "registration" | "process";
}

export interface ObservedClaudeSession extends BridgeSessionInfo {
  desktopTitle?: string;
  priorSessionIds?: string[];
  transcriptPath?: string;
  transcriptMtimeMs: number;
  processAlive: boolean;
  desktopProcessAlive: boolean;
  bridgeProcessAlive: boolean;
  processOverlap: boolean;
  activeProcesses: ActiveClaudeProcess[];
  activeTask: boolean;
  hostModel?: string;
  hostEffort?: ClaudeSessionEffort;
  sourceProfile?: ClaudeDesktopProfile;
  hostUltracode?: boolean;
}

export interface ClaudeCatalogSnapshot {
  projects: BridgeProjectInfo[];
  sessions: ObservedClaudeSession[];
  /** Listed for the archive view only; never observed, tailed or owned. */
  archivedSessions?: ObservedClaudeSession[];
  /** Desktop record files by CLI session id, kept out of the public session objects. */
  desktopMetadataPaths?: ReadonlyMap<string, string>;
  archivedSessionIds?: ReadonlySet<string>;
  observedAt: number;
}

export function projectIdForCwd(cwd: string, platform = process.platform): string {
  const key = platform === "win32" ? windowsPath.normalize(cwd).toLowerCase() : cwd;
  return createHash("sha256").update(key).digest("base64url").slice(0, 18);
}

const execFile = promisify(execFileCallback);
const WINDOWS_PROCESS_QUERY = [
  "Get-CimInstance Win32_Process |",
  "Select-Object ProcessId,ParentProcessId,Name,CommandLine,@{Name='CreationDate';Expression={if ($_.CreationDate) {$_.CreationDate.ToUniversalTime().ToString('o')}}} |",
  "ConvertTo-Json -Compress",
].join(" ");

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function entrypointFromAncestors(
  pid: number,
  processes: Map<number, { ppid: number; command: string }>,
  platform = process.platform,
): string {
  let current = processes.get(pid);
  const visited = new Set<number>();
  while (current && !visited.has(current.ppid)) {
    visited.add(current.ppid);
    const command = current.command;
    if (platform === "win32"
      ? /(?:\\|\/)(?:Programs[\\/])?(?:Claude|AnthropicClaude)[\\/]Claude\.exe(?:\s|$)/iu.test(command)
      : /\/Applications\/Claude\.app\/Contents\/MacOS\/Claude(?:\s|$)/u.test(command)) {
      return "claude-desktop-3p";
    }
    if (platform === "win32"
      ? /(?:Bridge|claude-bridge)(?:\.exe)?/iu.test(command)
      : /Claude Bridge|\/Bridge\.app\/|claude-bridge/iu.test(command)) {
      return "claude-bridge";
    }
    current = processes.get(current.ppid);
  }
  return "unknown";
}

interface ProcessRow {
  pid: number;
  ppid: number;
  command: string;
  startedAt: number;
}

function isStreamJsonProcess(command: string): boolean {
  return /--output-format(?:=|\s+)"?stream-json"?/iu.test(command) &&
    /--input-format(?:=|\s+)"?stream-json"?/iu.test(command) &&
    !/[\\/]Contents[\\/]Helpers[\\/]disclaimer(?:\s|$)/iu.test(command) &&
    !/magpie-claude-|claude-mcp-helper/iu.test(command);
}

function parseWindowsProcessRows(stdout: string): ProcessRow[] {
  let values: unknown;
  try {
    values = JSON.parse(stdout.replace(/^\uFEFF/u, ""));
  } catch {
    return [];
  }
  const rows = Array.isArray(values) ? values : values ? [values] : [];
  return rows.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const record = value as Record<string, unknown>;
    const pid = Number(record.ProcessId);
    const ppid = Number(record.ParentProcessId);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || pid <= 0 || ppid < 0) return [];
    const name = typeof record.Name === "string" ? record.Name : "";
    const commandLine = typeof record.CommandLine === "string" ? record.CommandLine : "";
    const startedAt = typeof record.CreationDate === "string" ? Date.parse(record.CreationDate) : NaN;
    return [{ pid, ppid, command: `${name}${commandLine ? ` ${commandLine}` : ""}`, startedAt: Number.isFinite(startedAt) ? startedAt : 0 }];
  });
}

interface ProcessScan {
  sessions: Map<string, ActiveClaudeProcess[]>;
  forks: Map<number, { parentSessionId: string; process: ActiveClaudeProcess }>;
  unassigned: Map<number, ActiveClaudeProcess>;
}

function indexClaudeProcesses(processes: Map<number, ProcessRow>, platform: NodeJS.Platform): ProcessScan {
  const sessions = new Map<string, ActiveClaudeProcess[]>();
  const forks = new Map<number, { parentSessionId: string; process: ActiveClaudeProcess }>();
  const unassigned = new Map<number, ActiveClaudeProcess>();
  for (const [pid, processInfo] of processes) {
    const command = processInfo.command;
    if (!isStreamJsonProcess(command)) continue;
    const explicit = /--session-id(?:=|\s+)"?([0-9a-f-]{36})"?(?:\s|$)/iu.exec(command);
    const resumed = /--resume(?:=|\s+)"?([0-9a-f-]{36})"?(?:\s|$)/iu.exec(command);
    const sessionId = (explicit ?? resumed)?.[1];
    const process: ActiveClaudeProcess = {
      pid,
      startedAt: processInfo.startedAt,
      ...(processInfo.startedAt ? { startedAtResolutionMs: platform === "win32" ? 1 : 1_000 } : {}),
      processAlive: true,
      entrypoint: entrypointFromAncestors(pid, processes, platform),
      source: "process",
    };
    if (!sessionId) {
      // Initialize-time session IDs are supplied by verified process registrations.
      unassigned.set(pid, process);
      continue;
    }
    if (!explicit && /(?:^|\s)--fork-session(?:\s|$)/u.test(command)) {
      // --resume names the history source; the new writer ID comes from its registration.
      forks.set(pid, { parentSessionId: sessionId, process });
      continue;
    }
    const values = sessions.get(sessionId) ?? [];
    values.push(process);
    sessions.set(sessionId, values);
  }
  return { sessions, forks, unassigned };
}

export function parseWindowsClaudeProcessSessions(stdout: string): Map<string, ActiveClaudeProcess[]> {
  return indexClaudeProcesses(new Map(parseWindowsProcessRows(stdout).map((row) => [row.pid, row])), "win32").sessions;
}

async function listProcessSessions(platform = process.platform): Promise<ProcessScan | undefined> {
  if ((platform !== "darwin" && platform !== "win32") || process.env.BRIDGE_DISABLE_PROCESS_SCAN === "1") {
    return undefined;
  }
  let stdout: string;
  try {
    if (platform === "win32") {
      ({ stdout } = await execFile("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        WINDOWS_PROCESS_QUERY,
      ], {
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      }));
    } else {
      ({ stdout } = await execFile("/bin/ps", ["-axo", "pid=,ppid=,lstart=,command="], {
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "C" },
        maxBuffer: 8 * 1024 * 1024,
      }));
    }
  } catch {
    return undefined;
  }
  if (platform === "win32") return indexClaudeProcesses(new Map(parseWindowsProcessRows(stdout).map((row) => [row.pid, row])), platform);
  const processes = new Map<number, ProcessRow>();
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/u.exec(line);
    if (!match) continue;
    const startedAt = Date.parse(match[3]!);
    processes.set(Number(match[1]), { pid: Number(match[1]), ppid: Number(match[2]), command: match[4]!, startedAt: Number.isFinite(startedAt) ? startedAt : 0 });
  }
  return indexClaudeProcesses(processes, platform);
}

async function listActiveSessions(
  path: string,
  platform = process.platform,
): Promise<Map<string, ActiveClaudeProcess[]>> {
  let names: string[];
  try {
    names = await readdir(path);
  } catch {
    names = [];
  }
  const scan = await listProcessSessions(platform);
  const scannedAt = Date.now();
  const result = scan?.sessions ?? new Map<string, ActiveClaudeProcess[]>();
  await Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) => {
    try {
      const value = JSON.parse(await readFile(join(path, name), "utf8")) as ActiveSessionFile;
      if (
        typeof value.sessionId !== "string" ||
        typeof value.cwd !== "string" ||
        typeof value.startedAt !== "number" ||
        value.entrypoint === "sdk-cli" ||
        /(?:^|[\\/])magpie-claude-work-\d+(?:[\\/]|$)/iu.test(value.cwd)
      ) return;
      const pid = typeof value.pid === "number" && Number.isInteger(value.pid) ? value.pid : undefined;
      const active: ActiveClaudeProcess = {
        ...(pid !== undefined ? { pid } : {}),
        cwd: value.cwd,
        startedAt: value.startedAt,
        ...(value.startedAt > 0 ? { startedAtResolutionMs: 1 } : {}),
        processAlive: !scan && pid !== undefined && processExists(pid),
        entrypoint: typeof value.entrypoint === "string" ? value.entrypoint : "unknown",
        ...(typeof value.peerProtocol === "string" || typeof value.peerProtocol === "number" ? { peerProtocol: value.peerProtocol } : {}),
        ...(typeof value.messagingSocketPath === "string" ? { messagingSocketPath: value.messagingSocketPath } : {}),
        source: "registration",
      };
      const existing = result.get(value.sessionId) ?? [];
      const fork = pid !== undefined ? scan?.forks.get(pid) : undefined;
      const scanned = existing.find((candidate) => candidate.pid !== undefined && candidate.pid === active.pid)
        ?? (fork && fork.parentSessionId !== value.sessionId ? fork.process : undefined)
        ?? (pid !== undefined ? scan?.unassigned.get(pid) : undefined);
      // Fork and initialize-time IDs come from registrations after verifying the OS PID and lifetime.
      if (scanned && scanned.startedAt > 0 && active.startedAt >= scanned.startedAt && active.startedAt <= scannedAt) {
        if (!existing.includes(scanned)) existing.push(scanned);
        scanned.cwd = value.cwd;
        scanned.registeredAt = active.startedAt;
        if (scanned.entrypoint === "unknown") scanned.entrypoint = active.entrypoint;
        if (active.peerProtocol !== undefined) scanned.peerProtocol = active.peerProtocol;
        if (active.messagingSocketPath !== undefined) scanned.messagingSocketPath = active.messagingSocketPath;
      } else existing.push(active);
      result.set(value.sessionId, existing);
    } catch {
      // Session discovery is best effort; malformed files are ignored.
    }
  }));
  return result;
}

export async function scanClaudeProcesses(
  paths: ClaudeRuntimePaths,
  platform = process.platform,
): Promise<Map<string, ActiveClaudeProcess[]>> {
  return listActiveSessions(paths.sessions, platform);
}

export async function scanClaudeSessionProcesses(
  paths: ClaudeRuntimePaths,
  sessionId: string,
  platform = process.platform,
): Promise<ActiveClaudeProcess[]> {
  return (await scanClaudeProcesses(paths, platform)).get(sessionId) ?? [];
}

/** Start of the oldest live process (0 when unknown); undefined when none is alive. */
export function oldestLiveProcessStart(processes: ActiveClaudeProcess[]): number | undefined {
  const live = processes.filter((candidate) => candidate.processAlive);
  return live.length ? Math.min(...live.map((candidate) => candidate.startedAt)) : undefined;
}

function processSummary(processes: ActiveClaudeProcess[]): {
  processAlive: boolean;
  desktopProcessAlive: boolean;
  bridgeProcessAlive: boolean;
  processOverlap: boolean;
} {
  const live = processes.filter((candidate) => candidate.processAlive);
  const desktopProcessAlive = live.some((candidate) => candidate.entrypoint.startsWith("claude-desktop"));
  const bridgeProcessAlive = live.some((candidate) => candidate.entrypoint === "claude-bridge");
  return {
    processAlive: live.length > 0,
    desktopProcessAlive,
    bridgeProcessAlive,
    processOverlap: desktopProcessAlive && bridgeProcessAlive,
  };
}

async function hasActiveTask(tasksRoot: string, sessionId: string): Promise<boolean> {
  let names: string[];
  try {
    names = await readdir(join(tasksRoot, sessionId));
  } catch {
    return false;
  }
  for (const name of names.filter((candidate) => candidate.endsWith(".json"))) {
    try {
      const value = JSON.parse(await readFile(join(tasksRoot, sessionId, name), "utf8")) as { status?: unknown };
      if (value.status === "in_progress") return true;
    } catch {
      // Ignore incomplete task state writes.
    }
  }
  return false;
}

export async function scanClaudeCatalog(
  paths: ClaudeRuntimePaths,
  platform = process.platform,
): Promise<ClaudeCatalogSnapshot> {
  const [desktopState, activeSessions] = await Promise.all([
    listClaudeDesktopSessionState(paths.desktopSessions),
    listActiveSessions(paths.sessions, platform),
  ]);
  const { sessions: desktopSessions, archivedSessions: archivedDesktopSessions, metadataPaths, archivedCliSessionIds } = desktopState;
  const observedAt = Date.now();
  const seen = new Set<string>();
  const sessions: ObservedClaudeSession[] = [];
  for (const desktopSession of desktopSessions) {
    if (seen.has(desktopSession.cliSessionId)) continue;
    seen.add(desktopSession.cliSessionId);
    const activeProcesses = activeSessions.get(desktopSession.cliSessionId) ?? [];
    const active = activeProcesses.find((candidate) => candidate.cwd);
    const processState = processSummary(activeProcesses);
    const cwd = active?.cwd ?? desktopSession.cwd;
    const defaultProjectName = basename(cwd) || cwd;
    const projectId = desktopSession.groupId ?? projectIdForCwd(cwd, platform);
    const projectName = desktopSession.groupName ?? defaultProjectName;
    const transcriptPath = await findClaudeTranscriptFile(paths.projects, desktopSession.cliSessionId, cwd);
    const transcriptMtimeMs = transcriptPath
      ? await stat(transcriptPath).then((metadata) => metadata.mtimeMs, () => 0)
      : 0;
    const activeTask = processState.processAlive
      ? await hasActiveTask(paths.tasks, desktopSession.cliSessionId)
      : false;
    sessions.push({
      sessionId: desktopSession.cliSessionId,
      desktopSessionId: desktopSession.sessionId,
      ...(desktopSession.priorCliSessionIds?.length ? { priorSessionIds: desktopSession.priorCliSessionIds } : {}),
      ...(desktopSession.parentSessionId ? { parentSessionId: desktopSession.parentSessionId } : {}),
      ...(desktopSession.forkLabel ? { forkLabel: desktopSession.forkLabel } : {}),
      ...(desktopSession.sidechat ? { sidechat: true } : {}),
      projectId,
      projectName,
      cwd,
      title: desktopSession.title || defaultProjectName,
      ...(desktopSession.title ? { desktopTitle: desktopSession.title } : {}),
      source: "desktop",
      ownership: "DESKTOP_OBSERVED",
      transport: "bridge-host",
      turnState: activeTask ? "running" : "idle",
      lastActivityAt: Math.max(
        desktopSession.lastActivityAt,
        desktopSession.createdAt,
        transcriptMtimeMs,
      ),
      pendingCount: 0,
      transcriptMtimeMs,
      ...processState,
      activeProcesses,
      activeTask,
      ...(desktopSession.model ? { hostModel: desktopSession.model } : {}),
      ...(desktopSession.effort ? { hostEffort: desktopSession.effort } : {}),
      ...(desktopSession.profile !== "unknown" ? { sourceProfile: desktopSession.profile } : {}),
      ...(desktopSession.ultracode !== undefined ? { hostUltracode: desktopSession.ultracode } : {}),
      ...(transcriptPath ? { transcriptPath } : {}),
    });
  }
  const archivedSessions = archivedDesktopSessions.map((desktopSession): ObservedClaudeSession => ({
    sessionId: desktopSession.cliSessionId,
    desktopSessionId: desktopSession.sessionId,
    ...(desktopSession.parentSessionId ? { parentSessionId: desktopSession.parentSessionId } : {}),
    ...(desktopSession.forkLabel ? { forkLabel: desktopSession.forkLabel } : {}),
    ...(desktopSession.sidechat ? { sidechat: true } : {}),
    projectId: desktopSession.groupId ?? projectIdForCwd(desktopSession.cwd, platform),
    projectName: desktopSession.groupName ?? (basename(desktopSession.cwd) || desktopSession.cwd),
    cwd: desktopSession.cwd,
    title: desktopSession.title || basename(desktopSession.cwd) || desktopSession.cwd,
    ...(desktopSession.title ? { desktopTitle: desktopSession.title } : {}),
    source: "desktop",
    ownership: "DESKTOP_OBSERVED",
    transport: "bridge-host",
    turnState: "idle",
    lastActivityAt: Math.max(desktopSession.lastActivityAt, desktopSession.createdAt),
    pendingCount: 0,
    archivedAt: desktopSession.archivedAt,
    transcriptMtimeMs: 0,
    processAlive: false,
    desktopProcessAlive: false,
    bridgeProcessAlive: false,
    processOverlap: false,
    activeProcesses: [],
    activeTask: false,
    ...(desktopSession.model ? { hostModel: desktopSession.model } : {}),
    ...(desktopSession.effort ? { hostEffort: desktopSession.effort } : {}),
    ...(desktopSession.profile !== "unknown" ? { sourceProfile: desktopSession.profile } : {}),
  }));
  for (const [sessionId, activeProcesses] of activeSessions) {
    if (seen.has(sessionId) || archivedCliSessionIds.has(sessionId)) continue;
    const active = activeProcesses.find((candidate) => (
      candidate.cwd
      && candidate.entrypoint !== "sdk-cli"
      && !/(?:^|[\\/])magpie-claude-work-\d+(?:[\\/]|$)/iu.test(candidate.cwd)
    ));
    if (!active?.cwd) continue;
    const processState = processSummary(activeProcesses);
    const projectName = basename(active.cwd) || active.cwd;
    const transcriptPath = await findClaudeTranscriptFile(paths.projects, sessionId, active.cwd);
    const transcriptMtimeMs = transcriptPath
      ? await stat(transcriptPath).then((metadata) => metadata.mtimeMs, () => 0)
      : 0;
    const activeTask = await hasActiveTask(paths.tasks, sessionId);
    sessions.push({
      sessionId,
      projectId: projectIdForCwd(active.cwd, platform),
      projectName,
      cwd: active.cwd,
      title: projectName,
      source: "desktop",
      ownership: "DESKTOP_OBSERVED",
      transport: "bridge-host",
      turnState: activeTask ? "running" : "idle",
      lastActivityAt: Math.max(active.startedAt, transcriptMtimeMs),
      pendingCount: 0,
      transcriptMtimeMs,
      ...processState,
      activeProcesses,
      activeTask,
      ...(transcriptPath ? { transcriptPath } : {}),
    });
  }
  sessions.sort((left, right) => right.lastActivityAt - left.lastActivityAt);
  const grouped = new Map<string, BridgeProjectInfo>();
  for (const session of sessions) {
    const current = grouped.get(session.projectId);
    if (current) {
      current.sessionCount += 1;
      current.runningCount += Number(session.turnState === "running");
      current.lastActivityAt = Math.max(current.lastActivityAt, session.lastActivityAt);
    } else {
      grouped.set(session.projectId, {
        projectId: session.projectId,
        name: session.projectName,
        cwd: session.cwd,
        sessionCount: 1,
        runningCount: Number(session.turnState === "running"),
        pendingCount: 0,
        lastActivityAt: session.lastActivityAt,
      });
    }
  }
  return {
    projects: [...grouped.values()].sort((left, right) => right.lastActivityAt - left.lastActivityAt),
    sessions,
    archivedSessions,
    desktopMetadataPaths: metadataPaths,
    archivedSessionIds: archivedCliSessionIds,
    observedAt,
  };
}
