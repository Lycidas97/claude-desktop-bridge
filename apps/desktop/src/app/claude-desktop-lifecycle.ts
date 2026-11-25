import { execFile as execFileCallback, spawn, spawnSync } from "node:child_process";
import { accessSync } from "node:fs";
import { access } from "node:fs/promises";
import { win32 as windowsPath } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import type { ClaudeDesktopAppStatus } from "@bridge/protocol";
import {
  CLAUDE_DESKTOP_APP,
  desktopAppPathCandidates,
  type DesktopAppDefinition,
} from "./desktop-app-definitions.js";

const execFile = promisify(execFileCallback);

export interface ClaudeDesktopLifecycleOptions {
  definition?: DesktopAppDefinition;
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  executablePath?: string;
  applicationInstalled?(): Promise<boolean>;
  listMainProcessIds?(): Promise<number[]>;
  listRunningExecutablePaths?(): Promise<string[]>;
  openTarget?(target: string): Promise<void>;
  launchApplication?(): Promise<void>;
  /** Cold-start only, after the bundle is resolved; never runs while Claude is running. Must resolve with an optional note and never reject. */
  prepareLaunch?(target: string): Promise<string | undefined>;
  signalProcess?(pid: number): void;
  sleep?(durationMs: number): Promise<void>;
  launchPollAttempts?: number;
  quitPollAttempts?: number;
  cacheTtlMs?: number;
}

interface CachedStatus {
  value: ClaudeDesktopAppStatus;
  observedAt: number;
}

function darwinExecutables(definition: DesktopAppDefinition, bundlePath = definition.darwinBundle): string[] {
  const defaultName = definition.win32ExecutableName.replace(/\.exe$/iu, "");
  const names = [
    definition.darwinExecutableName ?? defaultName,
    ...(definition.darwinExecutableCandidates ?? []),
  ];
  return [...new Set(names)].map((name) => `${bundlePath}/Contents/MacOS/${name}`);
}

/** Resolve the ordinary Claude Desktop executable without touching private app state. */
export function findClaudeDesktopExecutable(
  environment: NodeJS.ProcessEnv = process.env,
  home = homedir(),
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  for (const candidate of desktopAppPathCandidates(CLAUDE_DESKTOP_APP, environment, home, platform)) {
    try {
      accessSync(candidate);
      return candidate;
    } catch {
      // Continue through supported install locations.
    }
  }
  return undefined;
}

async function resolveInstalledTarget(
  definition: DesktopAppDefinition,
  platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  executablePath?: string,
): Promise<string | undefined> {
  const candidates = executablePath
    ? [executablePath]
    : desktopAppPathCandidates(definition, environment, homedir(), platform);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue through supported install locations.
    }
  }
  return undefined;
}

async function applicationInstalled(
  definition: DesktopAppDefinition,
  platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  executablePath?: string,
): Promise<boolean> {
  return (await resolveInstalledTarget(definition, platform, environment, executablePath)) !== undefined;
}

function parseWindowsTasklist(
  stdout: string,
  executableNames: string | readonly string[] = ["Claude.exe", "Claude-3p.exe"],
): number[] {
  const names = typeof executableNames === "string" ? [executableNames] : executableNames;
  const expected = new Set(names.map((name) => name.toLowerCase()));
  return stdout.split(/\r?\n/u).flatMap((line) => {
    const match = /^"([^"]+)","(\d+)"/u.exec(line.trim());
    if (!match || !expected.has(match[1]!.toLowerCase())) return [];
    return [Number(match[2])];
  });
}

export function parseClaudeDesktopTasklist(stdout: string): number[] {
  return parseWindowsTasklist(stdout);
}

function win32ExecutableNames(definition: DesktopAppDefinition, executablePath?: string): string[] {
  if (executablePath) return [windowsPath.basename(executablePath)];
  return [...new Set([
    definition.win32ExecutableName,
    ...(definition.id === "claude-desktop" ? ["Claude-3p.exe"] : []),
  ])];
}

async function listMainProcessIds(
  definition: DesktopAppDefinition,
  platform = process.platform,
  executablePath?: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<number[]> {
  if (platform === "win32") {
    const names = win32ExecutableNames(definition, executablePath);
    const outputs = await Promise.all(names.map((executableName) => (
      execFile(
        "tasklist",
        ["/FI", `IMAGENAME eq ${executableName}`, "/FO", "CSV", "/NH"],
        { encoding: "utf8", windowsHide: true },
      ).then(({ stdout }) => parseWindowsTasklist(stdout, executableName))
    )));
    return [...new Set(outputs.flat())];
  }
  const executables = desktopAppPathCandidates(definition, environment, homedir(), platform)
    .flatMap((bundle) => darwinExecutables(definition, bundle));
  const { stdout } = await execFile("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  return stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(.+)$/u.exec(line);
    if (!match) return [];
    const command = match[2]!.trim();
    return executables.some((executable) => command === executable || command.startsWith(`${executable} `))
      ? [Number(match[1])]
      : [];
  });
}

async function queryWindowsRunningExecutablePaths(): Promise<string[]> {
  const script = `
    $ErrorActionPreference = 'Stop';
    [Console]::OutputEncoding = [Text.Encoding]::UTF8;
    ConvertTo-Json -Compress -InputObject @(
      Get-CimInstance Win32_Process -Filter "Name = 'claude.exe' OR Name = 'claude-3p.exe'" |
        Where-Object { $_.ExecutablePath -and $_.CommandLine -notmatch '(?:^|\\s)--type=' } |
        ForEach-Object { $_.ExecutablePath }
    )
  `;
  const { stdout } = await execFile(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { encoding: "utf8", timeout: 5_000, maxBuffer: 1024 * 1024, windowsHide: true },
  );
  const parsed: unknown = JSON.parse(stdout.trim() || "[]");
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

async function resolveRunningTarget(
  definition: DesktopAppDefinition,
  platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  executablePath?: string,
  listRunningExecutablePaths?: () => Promise<string[]>,
): Promise<string | undefined> {
  if (executablePath) return executablePath;
  if (platform === "win32") {
    const candidates = desktopAppPathCandidates(definition, environment, homedir(), platform);
    const runningPaths = await (listRunningExecutablePaths ?? queryWindowsRunningExecutablePaths)().catch(() => []);
    if (runningPaths.length > 0) {
      const normalizedRunning = new Set(runningPaths.map((item) => windowsPath.normalize(item).toLowerCase()));
      for (const candidate of candidates) {
        if (!normalizedRunning.has(windowsPath.normalize(candidate).toLowerCase())) continue;
        try {
          await access(candidate);
          return candidate;
        } catch {
          // Continue through matching candidate paths.
        }
      }
      for (const runningPath of runningPaths) {
        try {
          await access(runningPath);
          return runningPath;
        } catch {
          // MSIX package paths may require launching via candidate alias instead.
        }
      }
    }
    const names = win32ExecutableNames(definition);
    for (const executableName of names) {
      const { stdout } = await execFile(
        "tasklist",
        ["/FI", `IMAGENAME eq ${executableName}`, "/FO", "CSV", "/NH"],
        { encoding: "utf8", windowsHide: true },
      );
      if (parseWindowsTasklist(stdout, executableName).length === 0) continue;
      for (const candidate of candidates) {
        if (windowsPath.basename(candidate).toLowerCase() !== executableName.toLowerCase()) continue;
        try {
          await access(candidate);
          return candidate;
        } catch {
          // Continue through matching candidate paths.
        }
      }
    }
    return undefined;
  }
  const bundles = desktopAppPathCandidates(definition, environment, homedir(), platform);
  const { stdout } = await execFile("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  const commands = stdout.split("\n")
    .map((line) => /^\s*\d+\s+(.+)$/u.exec(line)?.[1]?.trim())
    .filter((cmd): cmd is string => Boolean(cmd));
  return bundles.find((bundle) => (
    darwinExecutables(definition, bundle).some((executable) => (
      commands.some((command) => command === executable || command.startsWith(`${executable} `))
    ))
  ));
}

async function launchApplication(
  definition: DesktopAppDefinition,
  platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  executablePath?: string,
  preferRunning = false,
  listRunningExecutablePaths?: () => Promise<string[]>,
  openTarget?: (target: string) => Promise<void>,
  prepareLaunch?: (target: string) => Promise<unknown>,
): Promise<void> {
  const target = (preferRunning
    ? await resolveRunningTarget(definition, platform, environment, executablePath, listRunningExecutablePaths).catch(() => undefined)
    : undefined)
    ?? await resolveInstalledTarget(definition, platform, environment, executablePath);
  if (!target) {
    throw new Error(platform === "win32"
      ? `未找到 ${definition.displayName} 可执行文件。`
      : `未找到 ${definition.displayName} 应用。`);
  }
  if (!preferRunning) await prepareLaunch?.(target);
  if (openTarget) {
    await openTarget(target);
    return;
  }
  if (platform === "win32") {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(target, [], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: environment,
      });
      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    });
    return;
  }
  await execFile("/usr/bin/open", [target], { encoding: "utf8" });
}

export function signalProcess(
  pid: number,
  platform = process.platform,
  _environment: NodeJS.ProcessEnv = process.env,
): void {
  if (platform === "win32") {
    const result = spawnSync("taskkill", ["/PID", String(pid), "/T"], {
      stdio: "ignore",
      windowsHide: true,
    });
    if (result.error) throw result.error;
    return;
  }
  process.kill(pid, "SIGTERM");
}

export class ClaudeDesktopLifecycle {
  private cached: CachedStatus | undefined;
  private statusInFlight: Promise<ClaudeDesktopAppStatus> | undefined;
  private launchNote: string | undefined;
  readonly definition: DesktopAppDefinition;

  constructor(private readonly options: ClaudeDesktopLifecycleOptions = {}) {
    this.definition = options.definition ?? CLAUDE_DESKTOP_APP;
  }

  async status(force = false): Promise<ClaudeDesktopAppStatus> {
    const cacheTtlMs = this.options.cacheTtlMs ?? 1_000;
    if (!force && this.cached && Date.now() - this.cached.observedAt < cacheTtlMs) {
      return this.cached.value;
    }
    if (!force) {
      return this.statusInFlight ??= this.status(true).finally(() => {
        this.statusInFlight = undefined;
      });
    }
    const value = await this.readStatus();
    this.cached = { value, observedAt: Date.now() };
    return value;
  }

  async launch(options?: { activate?: boolean }): Promise<ClaudeDesktopAppStatus> {
    const current = await this.status(true);
    if (current.state === "unavailable") throw new Error(current.detail);
    if (current.state === "running" && !options?.activate) return current;

    const platform = this.options.platform ?? process.platform;
    const environment = this.options.environment ?? process.env;
    const prepareLaunch = this.options.prepareLaunch;
    await (this.options.launchApplication ?? (() => launchApplication(
      this.definition,
      platform,
      environment,
      this.options.executablePath,
      current.state === "running",
      this.options.listRunningExecutablePaths,
      this.options.openTarget,
      prepareLaunch && (async (target) => {
        this.launchNote = await prepareLaunch(target);
      }),
    )))();
    return current.state === "running"
      ? current
      : this.waitForState("running", this.options.launchPollAttempts ?? 40);
  }

  /** Completion note from the last cold launch's preparation step; cleared on read. */
  takeLaunchNote(): string | undefined {
    const note = this.launchNote;
    this.launchNote = undefined;
    return note;
  }

  async quit(): Promise<ClaudeDesktopAppStatus> {
    const current = await this.status(true);
    if (current.state === "unavailable") throw new Error(current.detail);
    if (current.state === "stopped") return current;

    const platform = this.options.platform ?? process.platform;
    const pids = await (this.options.listMainProcessIds ?? (() => listMainProcessIds(
      this.definition,
      platform,
      this.options.executablePath,
      this.options.environment ?? process.env,
    )))();
    for (const pid of pids) {
      try {
        (this.options.signalProcess ?? ((target) => signalProcess(
          target,
          platform,
          this.options.environment ?? process.env,
        )))(pid);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    return this.waitForState("stopped", this.options.quitPollAttempts ?? 60);
  }

  private async readStatus(): Promise<ClaudeDesktopAppStatus> {
    const name = this.definition.displayName;
    const platform = this.options.platform ?? process.platform;
    if (platform !== "darwin" && platform !== "win32") {
      return {
        state: "unavailable",
        detail: `当前平台暂不支持控制 ${name}。`,
        canLaunch: false,
        canQuit: false,
      };
    }
    const environment = this.options.environment ?? process.env;
    if (!await (this.options.applicationInstalled ?? (() => applicationInstalled(
      this.definition,
      platform,
      environment,
      this.options.executablePath,
    )))()) {
      return {
        state: "unavailable",
        detail: platform === "win32"
          ? `未找到 ${name} 可执行文件。`
          : `未在“应用程序”文件夹中找到 ${name}。`,
        canLaunch: false,
        canQuit: false,
      };
    }
    let running: boolean;
    try {
      running = (await (this.options.listMainProcessIds ?? (() => listMainProcessIds(
        this.definition,
        platform,
        this.options.executablePath,
        environment,
      )))()).length > 0;
    } catch {
      return {
        state: "unavailable",
        detail: `无法检查 ${name} 的运行状态。`,
        canLaunch: false,
        canQuit: false,
      };
    }
    return running
      ? {
          state: "running",
          detail: `${name} 正在运行。`,
          canLaunch: false,
          canQuit: true,
        }
      : {
          state: "stopped",
          detail: `${name} 已退出，Bridge 仍可继续处理远程会话。`,
          canLaunch: true,
          canQuit: false,
        };
  }

  private async waitForState(
    expected: "running" | "stopped",
    attempts: number,
  ): Promise<ClaudeDesktopAppStatus> {
    const name = this.definition.displayName;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const status = await this.status(true);
      if (status.state === expected) return status;
      await (this.options.sleep ?? ((durationMs) => (
        new Promise((resolve) => setTimeout(resolve, durationMs))
      )))(250);
    }
    throw new Error(expected === "running"
      ? `${name} 启动超时，请检查应用是否可以正常打开。`
      : `${name} 未能正常退出，请在应用中手动退出。`);
  }
}
