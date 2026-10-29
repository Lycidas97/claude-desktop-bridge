import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import {
  appendFile,
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  isAbsolute,
  join,
  normalize,
  posix as posixPath,
  relative,
  resolve,
  sep,
  win32 as windowsPath,
} from "node:path";
import { promisify } from "node:util";
import type {
  BridgeDesktopRegistrationInfo,
  BridgeEffort,
} from "@bridge/protocol";
import { findClaudeTranscriptFile } from "./claude-history.js";
import type { ClaudeRuntimePaths } from "./platform.js";

const execFile = promisify(execFileCallback);
const CLAUDE_MAIN = "/Applications/Claude.app/Contents/MacOS/Claude";
const CLAUDE_HELPER = "/Applications/Claude.app/Contents/Frameworks/Claude Helper";
const WINDOWS_PROCESS_QUERY = [
  "Get-CimInstance Win32_Process |",
  "Where-Object { $_.Name -match '^(Claude|Claude Helper).*\\.exe$' } |",
  "Select-Object ProcessId,ParentProcessId,Name,CommandLine |",
  "ConvertTo-Json -Compress",
].join(" ");
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TRANSCRIPT_PROBE_BYTES = 1024 * 1024;

interface ProcessRow {
  pid: number;
  ppid: number;
  command: string;
}

export interface ClaudeDesktopProfileProcess {
  pid: number;
  userDataDir: string;
}

export interface StoredDesktopRegistration extends BridgeDesktopRegistrationInfo {
  metadataPath?: string;
  metadataSha256?: string;
  profileSessionsRoot?: string;
  claudePidAtRegistration?: number;
}

export interface DesktopSessionRegistrationInput {
  sessionId: string;
  cwd: string;
  title: string;
  createdAt: number;
  lastActivityAt: number;
  model?: string;
  effort?: BridgeEffort;
  parentDesktopSessionId?: string;
  forkLabel?: string;
}

export interface DesktopSessionRegistrationResult extends StoredDesktopRegistration {}

export interface ClaudeDesktopSessionRegistrarOptions {
  paths: ClaudeRuntimePaths;
  platform?: NodeJS.Platform;
  now?(): number;
  listProfiles?(): Promise<ClaudeDesktopProfileProcess[]>;
  findTranscript?(
    projectsRoot: string,
    sessionId: string,
    cwd?: string,
  ): Promise<string | undefined>;
}

class RegistrationUnavailableError extends Error {}

function parseRows(stdout: string): ProcessRow[] {
  return stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
    if (!match) return [];
    return [{
      pid: Number(match[1]),
      ppid: Number(match[2]),
      command: match[3]!,
    }];
  });
}

function userDataDirFromCommand(command: string): string | undefined {
  const match = /--user-data-dir(?:=|\s+)(.+?)(?=\s--|$)/u.exec(command);
  const value = match?.[1]?.trim();
  if (!value) return undefined;
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) return value.slice(1, -1);
  return value;
}

function parseProfileRows(
  rows: ProcessRow[],
  platform: NodeJS.Platform,
): ClaudeDesktopProfileProcess[] {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const platformIsWindows = platform === "win32";
  const pathApi = platformIsWindows ? windowsPath : posixPath;
  const mainPids = new Set(rows
    .filter((row) => platformIsWindows
      ? /(?:^|[\\/"'])Claude\.exe(?:["']|\s|$)/iu.test(row.command)
      : row.command === CLAUDE_MAIN || row.command.startsWith(`${CLAUDE_MAIN} `))
    .map((row) => row.pid));
  const profiles = new Map<string, ClaudeDesktopProfileProcess>();
  for (const row of rows) {
    if (platformIsWindows
      ? !/Claude Helper(?:\.exe)?/iu.test(row.command)
      : !row.command.includes(CLAUDE_HELPER)) continue;
    const userDataDir = userDataDirFromCommand(row.command);
    const absolute = pathApi.isAbsolute(userDataDir ?? "");
    if (!userDataDir || !absolute) continue;
    let ancestor = row.ppid;
    const visited = new Set<number>();
    while (ancestor > 0 && !visited.has(ancestor) && !mainPids.has(ancestor)) {
      visited.add(ancestor);
      ancestor = byPid.get(ancestor)?.ppid ?? 0;
    }
    if (!mainPids.has(ancestor)) continue;
    const normalized = pathApi.normalize(userDataDir);
    profiles.set(`${ancestor}\0${normalized}`, {
      pid: ancestor,
      userDataDir: normalized,
    });
  }
  return [...profiles.values()];
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
    return [{ pid, ppid, command: `${name}${commandLine ? ` ${commandLine}` : ""}` }];
  });
}

export function parseWindowsClaudeDesktopProfiles(stdout: string): ClaudeDesktopProfileProcess[] {
  return parseProfileRows(parseWindowsProcessRows(stdout), "win32");
}

export function parseClaudeDesktopProfiles(
  stdout: string,
  platform: NodeJS.Platform = "darwin",
): ClaudeDesktopProfileProcess[] {
  return platform === "win32"
    ? parseWindowsClaudeDesktopProfiles(stdout)
    : parseProfileRows(parseRows(stdout), platform);
}

async function listRunningProfiles(platform = process.platform): Promise<ClaudeDesktopProfileProcess[]> {
  if (platform === "darwin") {
    const { stdout } = await execFile("/bin/ps", ["-axo", "pid=,ppid=,command="], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    return parseClaudeDesktopProfiles(stdout, platform);
  }
  if (platform !== "win32") return [];
  const { stdout } = await execFile("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    WINDOWS_PROCESS_QUERY,
  ], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  return parseWindowsClaudeDesktopProfiles(stdout);
}

function isWithin(path: string, root: string): boolean {
  const value = relative(root, path);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function sha256(contents: string | Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

function publicRegistration(
  value: StoredDesktopRegistration,
): BridgeDesktopRegistrationInfo {
  return {
    state: value.state,
    detail: value.detail,
    updatedAt: value.updatedAt,
    ...(value.desktopSessionId ? { desktopSessionId: value.desktopSessionId } : {}),
    ...(value.registeredAt ? { registeredAt: value.registeredAt } : {}),
  };
}

function registrationChanged(
  left: StoredDesktopRegistration | undefined,
  right: StoredDesktopRegistration,
): boolean {
  return JSON.stringify(left) !== JSON.stringify(right);
}

export class ClaudeDesktopSessionRegistrar {
  private readonly now: () => number;
  private readonly profiles: () => Promise<ClaudeDesktopProfileProcess[]>;
  private readonly transcriptFinder: NonNullable<ClaudeDesktopSessionRegistrarOptions["findTranscript"]>;

  constructor(private readonly options: ClaudeDesktopSessionRegistrarOptions) {
    this.now = options.now ?? Date.now;
    this.profiles = options.listProfiles ?? (() => listRunningProfiles(options.platform ?? process.platform));
    this.transcriptFinder = options.findTranscript ?? findClaudeTranscriptFile;
  }

  async register(
    input: DesktopSessionRegistrationInput,
    previous?: StoredDesktopRegistration,
  ): Promise<DesktopSessionRegistrationResult> {
    this.assertInput(input);
    const now = this.now();
    const platform = this.options.platform ?? process.platform;
    if (platform !== "darwin" && platform !== "win32") {
      return this.stableStatus(previous, {
        state: "unavailable",
        detail: "当前平台暂不支持登记 Claude Desktop 会话清单。",
        updatedAt: now,
      });
    }

    if (previous?.metadataPath && previous.desktopSessionId) {
      const restored = await this.restoreExisting(input, previous);
      if (restored) return restored;
    }

    const transcriptPath = await this.transcriptFinder(
      this.options.paths.projects,
      input.sessionId,
      input.cwd,
    );
    if (!transcriptPath) {
      return this.stableStatus(previous, {
        state: "waiting-transcript",
        detail: "首轮消息写入后会自动登记到 Claude Desktop。",
        updatedAt: now,
      });
    }
    await this.validateTranscript(transcriptPath, input);

    let target: Awaited<ReturnType<ClaudeDesktopSessionRegistrar["activeTarget"]>>;
    try {
      target = await this.activeTarget();
    } catch (error) {
      if (error instanceof RegistrationUnavailableError) {
        return this.stableStatus(previous, {
          state: "unavailable",
          detail: error.message,
          updatedAt: now,
        });
      }
      throw error;
    }

    const desktopSessionId = `local_${input.sessionId}`;
    const existing = await this.findByCliSessionId(target.accountDir, input.sessionId);
    if (existing) {
      const hash = await this.ensureMetadataFields(existing.path, input, existing.hash);
      return {
        state: "registered",
        detail: "Claude Desktop 已登记这条 Bridge 会话。",
        desktopSessionId: existing.sessionId,
        registeredAt: previous?.registeredAt ?? now,
        updatedAt: now,
        metadataPath: existing.path,
        metadataSha256: hash,
        profileSessionsRoot: target.sessionsRoot,
      };
    }

    const metadataPath = join(target.accountDir, `${desktopSessionId}.json`);
    const conflict = await this.readMetadata(metadataPath);
    if (conflict && (
      conflict.sessionId !== desktopSessionId ||
      conflict.cliSessionId !== input.sessionId
    )) {
      throw new Error("Claude Desktop 已存在同名但指向其他 transcript 的会话元数据");
    }
    if (conflict) {
      const hash = await this.ensureMetadataFields(metadataPath, input, conflict.hash);
      return {
        state: "registered",
        detail: "Claude Desktop 已登记这条 Bridge 会话。",
        desktopSessionId,
        registeredAt: previous?.registeredAt ?? now,
        updatedAt: now,
        metadataPath,
        metadataSha256: hash,
        profileSessionsRoot: target.sessionsRoot,
      };
    }

    const transcriptMetadata = await stat(transcriptPath);
    await this.ensureTranscriptCustomTitle(transcriptPath, input.sessionId, input.title);
    if (platform === "darwin" && !this.options.listProfiles) {
      const liveAdopted = await this.tryLiveAdoptViaDeepLink(
        input.sessionId,
        desktopSessionId,
        metadataPath,
        target.sessionsRoot,
        now,
        input,
      );
      if (liveAdopted) return liveAdopted;
    }

    const lastActivityAt = Math.round(Math.max(input.lastActivityAt, transcriptMetadata.mtimeMs));
    const metadata = {
      sessionId: desktopSessionId,
      cliSessionId: input.sessionId,
      cwd: input.cwd,
      originCwd: input.cwd,
      title: input.title,
      titleSource: "custom",
      createdAt: input.createdAt,
      lastActivityAt,
      lastFocusedAt: lastActivityAt,
      isArchived: false,
      ...(input.model ? { model: input.model } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
      ...(input.parentDesktopSessionId ? {
        forkedFromSessionId: input.parentDesktopSessionId,
        spawnedFrom: {
          sessionId: input.parentDesktopSessionId,
          taskId: `task_${input.sessionId.replace(/-/gu, "").slice(0, 8)}`,
          title: input.title,
          sideSession: true,
          sharedFolder: true,
          userFork: true,
          name: input.forkLabel || "fork",
        },
      } : {}),
      remoteMcpServersConfig: [],
    };
    const contents = `${JSON.stringify(metadata, null, 2)}\n`;
    await this.writeNewMetadata(target.accountDir, metadataPath, contents);
    return {
      state: "restart-required",
      detail: "已写入 Claude Desktop 会话清单，重启后可见。",
      desktopSessionId,
      registeredAt: now,
      updatedAt: now,
      metadataPath,
      metadataSha256: sha256(contents),
      profileSessionsRoot: target.sessionsRoot,
      claudePidAtRegistration: target.pid,
    };
  }

  private async ensureTranscriptCustomTitle(
    transcriptPath: string,
    sessionId: string,
    title: string,
  ): Promise<void> {
    const trimmed = title.trim();
    if (!trimmed) return;
    try {
      const raw = await readFile(transcriptPath, "utf8");
      if (raw.includes('"type":"custom-title"') && raw.includes(`"sessionId":"${sessionId}"`)) return;
      const record = JSON.stringify({
        type: "custom-title",
        customTitle: trimmed,
        sessionId,
        uuid: randomUUID(),
        timestamp: new Date(this.now()).toISOString(),
      });
      await appendFile(transcriptPath, `${raw.endsWith("\n") ? "" : "\n"}${record}\n`, "utf8");
    } catch {
      // Best-effort title stamp; adoption still works without it.
    }
  }

  private async ensureMetadataFields(
    metadataPath: string,
    input: DesktopSessionRegistrationInput,
    fallbackHash: string,
  ): Promise<string> {
    try {
      const raw = JSON.parse(await readFile(metadataPath, "utf8")) as Record<string, unknown>;
      let mutated = false;
      const trimmedTitle = input.title.trim();
      if (trimmedTitle && (typeof raw.title !== "string" || !raw.title.trim())) {
        raw.title = trimmedTitle;
        raw.titleSource = "custom";
        mutated = true;
      }
      if (input.parentDesktopSessionId && !raw.forkedFromSessionId) {
        raw.forkedFromSessionId = input.parentDesktopSessionId;
        raw.spawnedFrom = {
          sessionId: input.parentDesktopSessionId,
          taskId: `task_${input.sessionId.replace(/-/gu, "").slice(0, 8)}`,
          title: trimmedTitle || input.title,
          sideSession: true,
          sharedFolder: true,
          userFork: true,
          name: input.forkLabel || "fork",
        };
        if (trimmedTitle) {
          raw.title = trimmedTitle;
          raw.titleSource = "custom";
        }
        mutated = true;
      }
      if (!mutated) return fallbackHash;
      const updatedContents = `${JSON.stringify(raw, null, 2)}\n`;
      await writeFile(metadataPath, updatedContents, { encoding: "utf8", mode: 0o600 });
      return sha256(updatedContents);
    } catch {
      return fallbackHash;
    }
  }

  private async tryLiveAdoptViaDeepLink(
    sessionId: string,
    desktopSessionId: string,
    metadataPath: string,
    sessionsRoot: string,
    now: number,
    input: DesktopSessionRegistrationInput,
  ): Promise<DesktopSessionRegistrationResult | undefined> {
    try {
      await execFile("/usr/bin/open", ["-g", `claude://resume?session=${sessionId}`], {
        encoding: "utf8",
      });
    } catch {
      return undefined;
    }
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      const adopted = await this.readMetadata(metadataPath);
      if (
        adopted &&
        adopted.sessionId === desktopSessionId &&
        adopted.cliSessionId === sessionId
      ) {
        const hash = await this.ensureMetadataFields(metadataPath, input, adopted.hash);
        return {
          state: "registered",
          detail: "Claude Desktop 已实时同步这条 Bridge 会话。",
          desktopSessionId,
          registeredAt: now,
          updatedAt: now,
          metadataPath,
          metadataSha256: hash,
          profileSessionsRoot: sessionsRoot,
        };
      }
    }
    return undefined;
  }

  async removeOwned(
    sessionId: string,
    registration: StoredDesktopRegistration,
  ): Promise<boolean> {
    if (
      !isUuid(sessionId) ||
      !registration.metadataPath ||
      registration.desktopSessionId !== `local_${sessionId}`
    ) return false;
    if (!await this.isTrustedMetadataPath(sessionId, registration.metadataPath)) return false;
    const current = await this.readMetadata(registration.metadataPath);
    if (
      !current ||
      current.sessionId !== registration.desktopSessionId ||
      current.cliSessionId !== sessionId
    ) return false;
    await unlink(registration.metadataPath);
    return true;
  }

  publicInfo(value: StoredDesktopRegistration): BridgeDesktopRegistrationInfo {
    return publicRegistration(value);
  }

  changed(
    left: StoredDesktopRegistration | undefined,
    right: StoredDesktopRegistration,
  ): boolean {
    return registrationChanged(left, right);
  }

  private assertInput(input: DesktopSessionRegistrationInput): void {
    if (!isUuid(input.sessionId)) throw new Error("Bridge session ID must be a UUID");
    if (!isAbsolute(input.cwd)) throw new Error("Bridge session cwd must be absolute");
    if (!input.title.trim()) throw new Error("Bridge session title is required");
    if (!Number.isFinite(input.createdAt) || !Number.isFinite(input.lastActivityAt)) {
      throw new Error("Bridge session timestamps are invalid");
    }
  }

  private async restoreExisting(
    input: DesktopSessionRegistrationInput,
    previous: StoredDesktopRegistration,
  ): Promise<DesktopSessionRegistrationResult | undefined> {
    if (!await this.isTrustedMetadataPath(input.sessionId, previous.metadataPath!)) {
      return undefined;
    }
    const current = await this.readMetadata(previous.metadataPath!);
    if (
      !current ||
      current.sessionId !== previous.desktopSessionId ||
      current.cliSessionId !== input.sessionId
    ) return undefined;
    const hash = await this.ensureMetadataFields(previous.metadataPath!, input, current.hash);
    const profiles = await this.profiles().catch(() => []);
    const active = profiles.find((profile) => (
      previous.profileSessionsRoot === join(profile.userDataDir, "claude-code-sessions")
    ));
    const stillNeedsRestart = !current.adoptedFromOtherSurface && previous.state === "restart-required" && (
      !active ||
      active.pid === previous.claudePidAtRegistration
    );
    const now = this.now();
    if (
      stillNeedsRestart &&
      previous.metadataSha256 === hash
    ) return previous;
    const restored: DesktopSessionRegistrationResult = {
      ...previous,
      state: stillNeedsRestart ? "restart-required" : "registered",
      detail: stillNeedsRestart
        ? "已写入 Claude Desktop 会话清单，重启后可见。"
        : "Claude Desktop 已登记这条 Bridge 会话。",
      updatedAt: now,
      metadataSha256: hash,
    };
    if (!stillNeedsRestart) delete restored.claudePidAtRegistration;
    // Nothing meaningful changed: keep the previous record. Minting a fresh
    // updatedAt here on every reconcile used to make registrationChanged()
    // permanently true, flooding the event log with no-op
    // session.desktop-registration events after every single turn.
    if (
      previous.state === restored.state &&
      previous.detail === restored.detail &&
      previous.desktopSessionId === restored.desktopSessionId &&
      previous.metadataPath === restored.metadataPath &&
      previous.metadataSha256 === restored.metadataSha256 &&
      previous.profileSessionsRoot === restored.profileSessionsRoot &&
      previous.claudePidAtRegistration === restored.claudePidAtRegistration
    ) return previous;
    return restored;
  }

  private stableStatus(
    previous: StoredDesktopRegistration | undefined,
    next: StoredDesktopRegistration,
  ): StoredDesktopRegistration {
    if (
      previous &&
      previous.state === next.state &&
      previous.detail === next.detail &&
      !previous.metadataPath
    ) return previous;
    return next;
  }

  private async activeTarget(): Promise<{
    pid: number;
    sessionsRoot: string;
    accountDir: string;
  }> {
    const profiles = await this.profiles().catch(() => []);
    const configuredRoots = new Map(this.options.paths.desktopSessions.map((root) => [
      resolve(root),
      root,
    ]));
    const candidates = profiles.flatMap((profile) => {
      const sessionsRoot = join(profile.userDataDir, "claude-code-sessions");
      return configuredRoots.has(resolve(sessionsRoot))
        ? [{ ...profile, sessionsRoot }]
        : [];
    });
    if (candidates.length === 0) {
      throw new RegistrationUnavailableError("启动 Claude Desktop 后将自动登记这条会话。");
    }
    const uniqueRoots = new Set(candidates.map((candidate) => resolve(candidate.sessionsRoot)));
    if (uniqueRoots.size !== 1) {
      throw new RegistrationUnavailableError("检测到多个 Claude Desktop 登录态，暂不自动写入。");
    }
    if (candidates.length !== 1) {
      throw new RegistrationUnavailableError("检测到多个 Claude Desktop 实例，暂不自动写入。");
    }
    const selected = candidates[0]!;
    const accountDir = await this.activeAccountDir(selected.sessionsRoot);
    return {
      pid: selected.pid,
      sessionsRoot: selected.sessionsRoot,
      accountDir,
    };
  }

  private async activeAccountDir(sessionsRoot: string): Promise<string> {
    const sessionRootReal = await realpath(sessionsRoot).catch(() => undefined);
    if (!sessionRootReal) {
      throw new RegistrationUnavailableError("Claude Desktop 尚未初始化本地会话目录。");
    }
    const candidates: Array<{ path: string; metadataFiles: string[] }> = [];
    for (const device of await readdir(sessionRootReal, { withFileTypes: true })) {
      if (!device.isDirectory() || device.isSymbolicLink()) continue;
      const devicePath = join(sessionRootReal, device.name);
      for (const account of await readdir(devicePath, { withFileTypes: true }).catch(() => [])) {
        if (!account.isDirectory() || account.isSymbolicLink()) continue;
        const path = join(devicePath, account.name);
        const metadataFiles = (await readdir(path).catch(() => []))
          .filter((name) => name.startsWith("local_") && name.endsWith(".json"));
        candidates.push({ path, metadataFiles });
      }
    }
    const withSessions = candidates.filter((candidate) => candidate.metadataFiles.length > 0);
    const eligible = withSessions.length > 0 ? withSessions : candidates;
    if (eligible.length !== 1) {
      throw new RegistrationUnavailableError(
        eligible.length === 0
          ? "Claude Desktop 尚未创建可识别的本地账号会话目录。"
          : "Claude Desktop 存在多个账号会话目录，暂不自动写入。",
      );
    }
    const selected = eligible[0]!;
    await this.assertMetadataSchema(selected.path, selected.metadataFiles);
    return selected.path;
  }

  private async assertMetadataSchema(accountDir: string, files: string[]): Promise<void> {
    if (files.length === 0) {
      throw new RegistrationUnavailableError("请先在 Claude Desktop 中创建一个本地会话以初始化元数据格式。");
    }
    let valid = false;
    for (const name of files.slice(-16)) {
      const metadata = await this.readMetadata(join(accountDir, name));
      if (
        metadata &&
        metadata.sessionId.startsWith("local_") &&
        isAbsolute(metadata.cwd) &&
        Boolean(metadata.cliSessionId && isUuid(metadata.cliSessionId)) &&
        typeof metadata.title === "string" &&
        typeof metadata.titleSource === "string" &&
        typeof metadata.createdAt === "number" &&
        typeof metadata.lastActivityAt === "number"
      ) {
        valid = true;
        break;
      }
    }
    if (!valid) {
      throw new RegistrationUnavailableError("当前 Claude Desktop 元数据格式无法安全识别。");
    }
  }

  private async validateTranscript(
    transcriptPath: string,
    input: DesktopSessionRegistrationInput,
  ): Promise<void> {
    const projectsRoot = await realpath(this.options.paths.projects).catch(() => undefined);
    const transcriptReal = await realpath(transcriptPath).catch(() => undefined);
    if (!projectsRoot || !transcriptReal || !isWithin(transcriptReal, projectsRoot)) {
      throw new Error("Claude transcript 不在受信任的 projects 目录内");
    }
    const metadata = await lstat(transcriptReal);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("Claude transcript 不是普通文件");
    }
    const handle = await open(transcriptReal, "r");
    const probe = Buffer.alloc(TRANSCRIPT_PROBE_BYTES);
    let bytesRead = 0;
    let tailText = "";
    try {
      ({ bytesRead } = await handle.read(probe, 0, probe.byteLength, 0));
      if (metadata.size > TRANSCRIPT_PROBE_BYTES) {
        const tailBuffer = Buffer.alloc(Math.min(TRANSCRIPT_PROBE_BYTES, metadata.size));
        const tailOffset = Math.max(0, metadata.size - tailBuffer.byteLength);
        const tailRead = await handle.read(tailBuffer, 0, tailBuffer.byteLength, tailOffset);
        tailText = tailBuffer.subarray(0, tailRead.bytesRead).toString("utf8");
      }
    } finally {
      await handle.close();
    }
    const text = `${probe.subarray(0, bytesRead).toString("utf8")}\n${tailText}`;
    let hasSessionId = false;
    let hasCwd = false;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line) as {
          sessionId?: unknown;
          session_id?: unknown;
          cwd?: unknown;
        };
        if (value.sessionId === input.sessionId || value.session_id === input.sessionId) {
          hasSessionId = true;
        }
        if (typeof value.cwd === "string" && this.samePath(value.cwd, input.cwd)) {
          hasCwd = true;
        }
      } catch {
        // Ignore a bounded final record that may end mid-line.
      }
      if (hasSessionId && hasCwd) break;
    }
    if (!hasSessionId || !hasCwd) {
      throw new Error("Claude transcript 与 Bridge 会话标识或项目目录不一致");
    }
  }

  private samePath(left: string, right: string): boolean {
    if ((this.options.platform ?? process.platform) === "win32") {
      return windowsPath.normalize(left).toLowerCase() === windowsPath.normalize(right).toLowerCase();
    }
    return normalize(left) === normalize(right);
  }

  private async findByCliSessionId(
    accountDir: string,
    cliSessionId: string,
  ): Promise<{
    path: string;
    sessionId: string;
    hash: string;
  } | undefined> {
    const names = await readdir(accountDir);
    for (const name of names) {
      if (!name.startsWith("local_") || !name.endsWith(".json")) continue;
      const path = join(accountDir, name);
      const metadata = await this.readMetadata(path);
      if (metadata?.cliSessionId === cliSessionId) {
        return { path, sessionId: metadata.sessionId, hash: metadata.hash };
      }
    }
    return undefined;
  }

  private async readMetadata(path: string): Promise<{
    sessionId: string;
    cliSessionId?: string;
    cwd: string;
    title?: string;
    titleSource?: string;
    createdAt?: number;
    lastActivityAt?: number;
    adoptedFromOtherSurface?: boolean;
    hash: string;
  } | undefined> {
    try {
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 2 * 1024 * 1024) {
        return undefined;
      }
      const contents = await readFile(path, "utf8");
      const value = JSON.parse(contents) as {
        sessionId?: unknown;
        cliSessionId?: unknown;
        cwd?: unknown;
        title?: unknown;
        titleSource?: unknown;
        createdAt?: unknown;
        lastActivityAt?: unknown;
        adoptedFromOtherSurface?: unknown;
      };
      if (
        typeof value.sessionId !== "string" ||
        typeof value.cwd !== "string" ||
        (value.cliSessionId !== undefined && typeof value.cliSessionId !== "string")
      ) return undefined;
      return {
        sessionId: value.sessionId,
        ...(value.cliSessionId ? { cliSessionId: value.cliSessionId } : {}),
        cwd: value.cwd,
        ...(typeof value.title === "string" ? { title: value.title } : {}),
        ...(typeof value.titleSource === "string"
          ? { titleSource: value.titleSource }
          : {}),
        ...(typeof value.createdAt === "number" ? { createdAt: value.createdAt } : {}),
        ...(typeof value.lastActivityAt === "number"
          ? { lastActivityAt: value.lastActivityAt }
          : {}),
        ...(value.adoptedFromOtherSurface === true ? { adoptedFromOtherSurface: true } : {}),
        hash: sha256(contents),
      };
    } catch {
      return undefined;
    }
  }

  private async isTrustedMetadataPath(
    sessionId: string,
    metadataPath: string,
  ): Promise<boolean> {
    if (
      !isAbsolute(metadataPath) ||
      basename(metadataPath) !== `local_${sessionId}.json`
    ) return false;
    const parent = await realpath(join(metadataPath, "..")).catch(() => undefined);
    if (!parent) return false;
    const allowedRoots = await Promise.all(
      this.options.paths.desktopSessions.map(async (root) => (
        realpath(root).catch(() => resolve(root))
      )),
    );
    return allowedRoots.some((root) => isWithin(parent, root));
  }

  private async writeNewMetadata(
    accountDir: string,
    metadataPath: string,
    contents: string,
  ): Promise<void> {
    const rootReal = await realpath(accountDir);
    const parentReal = await realpath(join(metadataPath, ".."));
    if (rootReal !== parentReal) throw new Error("Claude Desktop 元数据目标目录校验失败");
    await mkdir(accountDir, { recursive: true, mode: 0o700 });
    const temporary = join(accountDir, `.bridge-${randomUUID()}.tmp`);
    await writeFile(temporary, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
    try {
      await link(temporary, metadataPath);
      await chmod(metadataPath, 0o600);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
}
