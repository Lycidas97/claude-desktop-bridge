import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { chmod, mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, win32 } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import {
  DEFAULT_GITHUB_RELEASES_URL,
  parseGitHubReleases,
  parseSha256Sums,
  selectLatestRelease,
  selectReleaseAsset,
  type BridgeMatchedAsset,
  type BridgeReleaseInfo,
  type BridgeSystemUpdateParams,
  type BridgeUpdateApplyMode,
  type BridgeUpdateChannel,
  type BridgeUpdaterPhase,
  type BridgeUpdaterSnapshot,
} from "@bridge/protocol";
import { extractZipEntryToFile } from "./zip-extract.js";

export type DesktopUpdaterPlatform = "win32" | "darwin" | "linux";

interface StoredUpdaterPreferences {
  version: 1;
  channel: BridgeUpdateChannel;
  autoCheck: boolean;
  applyMode: BridgeUpdateApplyMode;
  etag?: string;
  cachedReleases?: unknown;
}

export interface DesktopUpdaterOptions {
  platform: DesktopUpdaterPlatform;
  arch: string;
  currentVersion: string;
  isPackaged: boolean;
  execPath: string;
  userDataPath: string;
  feedUrl?: string | undefined;
  autoCheckAllowed: boolean;
  linuxPackageFormat?: "deb" | "rpm" | "zip";
  checkIntervalMs?: number;
  initialDelayMs?: number;
  fetchImpl?: typeof fetch;
  isDirectoryWritable?: (directory: string) => boolean | Promise<boolean>;
  isSystemIdle: () => boolean;
  hasConnectedUi: () => boolean;
  requestQuitAll: () => Promise<void> | void;
  openLocalInstaller?: (filePath: string, revealOnly: boolean) => Promise<void>;
  spawnWindowsHelper?: (options: {
    setupPath: string;
    installDir: string;
    exePath: string;
    reopenUi: boolean;
    logPath: string;
  }) => Promise<void> | void;
  onChanged: () => void;
}

const DEFAULT_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_INITIAL_DELAY_MS = 8_000;
const PROGRESS_THROTTLE_MS = 350;

export async function probeInstallDirectory(
  directory: string,
  recyclePath: (path: string) => Promise<void>,
): Promise<boolean> {
  const probePath = join(directory, `.bridge-update-probe-${randomUUID()}`);
  let handle;
  try {
    handle = await open(probePath, "wx", 0o600);
  } catch (error) {
    if (["EACCES", "EPERM", "EROFS"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
  await handle.close();
  await recyclePath(probePath);
  return true;
}

export function detectLinuxPackageFormat(
  probeExists: (filePath: string) => boolean = existsSync,
): "deb" | "rpm" | "zip" {
  if (probeExists("/usr/bin/dpkg")) return "deb";
  if (probeExists("/usr/bin/rpm")) return "rpm";
  return "zip";
}

export function buildWindowsSilentUpdateScript(): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$setup = $env:BRIDGE_UPDATE_SETUP_PATH",
    "$installDir = $env:BRIDGE_UPDATE_INSTALL_DIR",
    "$exePath = $env:BRIDGE_UPDATE_EXE_PATH",
    "$reopenUi = $env:BRIDGE_UPDATE_REOPEN_UI -eq '1'",
    "$logPath = $env:BRIDGE_UPDATE_LOG_PATH",
    "$procName = [IO.Path]::GetFileNameWithoutExtension($exePath)",
    "for ($i = 0; $i -lt 60; $i++) {",
    "  $running = @(Get-Process -Name $procName -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exePath })",
    "  if ($running.Count -eq 0) { break }",
    "  Start-Sleep -Milliseconds 500",
    "}",
    "$proc = Start-Process -FilePath $setup -ArgumentList \"/S /currentuser /D=$installDir\" -Wait -PassThru",
    "if ($proc.ExitCode -ne 0) {",
    "  Set-Content -LiteralPath $logPath -Value \"NSIS installer exited with code $($proc.ExitCode)\" -Encoding UTF8",
    "  exit $proc.ExitCode",
    "}",
    "if (Test-Path -LiteralPath $exePath) {",
    "  Start-Process -FilePath $exePath -ArgumentList '--bridge-service' -WindowStyle Hidden",
    "  if ($reopenUi) { Start-Process -FilePath $exePath }",
    "}",
  ].join("\n");
}

function defaultSpawnWindowsHelper(options: {
  setupPath: string;
  installDir: string;
  exePath: string;
  reopenUi: boolean;
  logPath: string;
}): void {
  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", buildWindowsSilentUpdateScript()],
    {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: {
        ...process.env,
        BRIDGE_UPDATE_SETUP_PATH: options.setupPath,
        BRIDGE_UPDATE_INSTALL_DIR: options.installDir,
        BRIDGE_UPDATE_EXE_PATH: options.exePath,
        BRIDGE_UPDATE_REOPEN_UI: options.reopenUi ? "1" : "0",
        BRIDGE_UPDATE_LOG_PATH: options.logPath,
      },
    },
  );
  child.unref();
}

export class DesktopUpdater {
  private readonly prefsPath: string;
  private readonly updatesDir: string;
  private readonly feedUrl: string;
  private readonly fetchImpl: typeof fetch;
  private canAutoRestart = false;
  private readonly linuxPackageFormat: "deb" | "rpm" | "zip";
  private channel: BridgeUpdateChannel = "stable";
  private autoCheck = true;
  private applyMode: BridgeUpdateApplyMode = "prompt";
  private etag: string | undefined;
  private cachedReleases: BridgeReleaseInfo[] = [];

  private phase: BridgeUpdaterPhase = "idle";
  private checkedAt: number | undefined;
  private latestRelease: BridgeReleaseInfo | undefined;
  private matchedAsset: BridgeMatchedAsset | undefined;
  private downloadedBytes: number | undefined;
  private totalBytes: number | undefined;
  private integrityVerified: "sha256" | "size" | undefined;
  private stagedPath: string | undefined;
  private stagedVersion: string | undefined;
  private waitingForIdle = false;
  private statusDetail: string | undefined;
  private errorMessage: string | undefined;

  private closed = false;
  private initialTimer: ReturnType<typeof setTimeout> | undefined;
  private intervalTimer: ReturnType<typeof setInterval> | undefined;
  private activeCheck: Promise<void> | undefined;
  private activeDownload: Promise<void> | undefined;
  private pendingApplyOrigin: "desktop" | "mobile" | undefined;

  constructor(private readonly options: DesktopUpdaterOptions) {
    this.prefsPath = join(options.userDataPath, "updater-v1.json");
    this.updatesDir = join(options.userDataPath, "updates");
    this.feedUrl = options.feedUrl?.trim() || DEFAULT_GITHUB_RELEASES_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.linuxPackageFormat = options.linuxPackageFormat ?? detectLinuxPackageFormat();
  }

  async initialize(): Promise<void> {
    if (this.options.platform === "win32" && this.options.isPackaged && this.options.isDirectoryWritable) {
      this.canAutoRestart = await this.options.isDirectoryWritable(win32.dirname(this.options.execPath));
    }
    await this.loadPreferences();
    this.syncAutoCheckTimers();
  }

  close(): void {
    this.closed = true;
    this.clearTimers();
  }

  snapshot(): BridgeUpdaterSnapshot {
    return {
      platform: this.options.platform,
      arch: this.options.arch,
      currentVersion: this.options.currentVersion,
      channel: this.channel,
      autoCheck: this.autoCheck,
      applyMode: this.applyMode,
      canAutoRestart: this.canAutoRestart,
      phase: this.phase,
      ...(this.checkedAt !== undefined ? { checkedAt: this.checkedAt } : {}),
      ...(this.latestRelease ? {
        latestVersion: this.latestRelease.version,
        latestTag: this.latestRelease.tagName,
        prerelease: this.latestRelease.prerelease,
        releaseUrl: this.latestRelease.htmlUrl,
        ...(this.latestRelease.body ? { releaseNotes: this.latestRelease.body } : {}),
      } : {}),
      ...(this.matchedAsset ? { assetName: this.matchedAsset.asset.name } : {}),
      ...(this.downloadedBytes !== undefined ? { downloadedBytes: this.downloadedBytes } : {}),
      ...(this.totalBytes !== undefined ? { totalBytes: this.totalBytes } : {}),
      ...(this.integrityVerified ? { integrityVerified: this.integrityVerified } : {}),
      ...(this.stagedPath ? { stagedPath: this.stagedPath } : {}),
      ...(this.waitingForIdle ? { waitingForIdle: true } : {}),
      ...(this.statusDetail ? { statusDetail: this.statusDetail } : {}),
      ...(this.errorMessage ? { error: this.errorMessage } : {}),
    };
  }

  notifyIdleStateChanged(idle: boolean): void {
    if (!idle || this.closed || !this.waitingForIdle) return;
    if (this.phase === "ready" && this.applyMode === "silent-idle" && this.canAutoRestart) {
      this.waitingForIdle = false;
      void this.applyStagedUpdate("desktop");
    }
  }

  async waitForPendingTasks(): Promise<void> {
    if (this.activeCheck) await this.activeCheck;
    if (this.activeDownload) await this.activeDownload;
  }

  async handleRpc(
    input: BridgeSystemUpdateParams,
    origin: "desktop" | "mobile",
  ): Promise<BridgeUpdaterSnapshot> {
    if (input.action === "status") {
      return this.snapshot();
    }

    if (input.action === "configure") {
      const channelChanged = input.channel !== undefined && input.channel !== this.channel;
      if (input.channel !== undefined) this.channel = input.channel;
      if (input.autoCheck !== undefined) this.autoCheck = input.autoCheck;
      if (input.applyMode !== undefined) this.applyMode = input.applyMode;
      await this.savePreferences();
      this.syncAutoCheckTimers();
      if (channelChanged && this.cachedReleases.length > 0 && this.phase !== "downloading" && this.phase !== "applying") {
        this.applyReleaseSelection(this.cachedReleases);
      }
      if (this.applyMode !== "silent-idle") {
        this.waitingForIdle = false;
      } else if (this.phase === "ready" && this.canAutoRestart) {
        if (this.options.isSystemIdle()) {
          await this.applyStagedUpdate(origin);
        } else {
          this.waitingForIdle = true;
          this.statusDetail = "新版本已就绪，将在当前会话空闲后自动重启升级。";
        }
      }
      this.options.onChanged();
      return this.snapshot();
    }

    if (input.action === "check") {
      if (input.channel && input.channel !== this.channel) {
        this.channel = input.channel;
        await this.savePreferences();
      }
      await this.checkForUpdates();
      return this.snapshot();
    }

    if (input.action === "download") {
      if (this.phase === "idle" || this.phase === "up-to-date" || this.phase === "error") {
        await this.checkForUpdates();
      }
      if (this.phase === "available" && this.matchedAsset) {
        this.beginDownloadBackground();
      }
      return this.snapshot();
    }

    // action === "apply"
    if (this.phase === "ready" && this.stagedPath) {
      await this.applyStagedUpdate(origin);
      return this.snapshot();
    }
    if (this.phase === "downloading") {
      this.pendingApplyOrigin = origin;
      this.statusDetail = "下载完成后将自动继续更新流程…";
      this.options.onChanged();
      return this.snapshot();
    }
    this.pendingApplyOrigin = origin;
    if (this.phase === "available" && this.matchedAsset) {
      this.beginDownloadBackground();
      return this.snapshot();
    }
    void (async () => {
      await this.checkForUpdates();
      if (this.closed) return;
      if (this.phase === "available" && this.matchedAsset) {
        this.beginDownloadBackground();
      } else if (this.phase !== "downloading") {
        this.pendingApplyOrigin = undefined;
      }
    })();
    return this.snapshot();
  }

  async checkForUpdates(): Promise<void> {
    if (this.closed) return;
    if (this.phase === "downloading" || this.phase === "applying") return;
    if (this.activeCheck) return this.activeCheck;
    this.activeCheck = this.runCheck().finally(() => {
      this.activeCheck = undefined;
    });
    return this.activeCheck;
  }

  private async runCheck(): Promise<void> {
    const previousPhase = this.phase;
    this.phase = "checking";
    this.errorMessage = undefined;
    this.statusDetail = undefined;
    this.options.onChanged();

    try {
      const headers: Record<string, string> = {
        Accept: "application/vnd.github+json",
        "User-Agent": `claude-desktop-bridge/${this.options.currentVersion}`,
      };
      if (this.etag && this.cachedReleases.length > 0) {
        headers["If-None-Match"] = this.etag;
      }
      const url = this.feedUrl.includes("?") ? this.feedUrl : `${this.feedUrl}?per_page=15`;
      const response = await this.fetchImpl(url, { headers });
      let releases: BridgeReleaseInfo[];
      if (response.status === 304 && this.cachedReleases.length > 0) {
        releases = this.cachedReleases;
      } else {
        if (!response.ok) {
          throw new Error(`检查更新失败（HTTP ${response.status}）`);
        }
        const json: unknown = await response.json();
        releases = parseGitHubReleases(json);
        const nextEtag = response.headers.get("etag") ?? undefined;
        this.etag = nextEtag;
        this.cachedReleases = releases;
        await this.savePreferences();
      }
      this.checkedAt = Date.now();
      const hasAvailableAsset = this.applyReleaseSelection(releases);
      this.options.onChanged();

      if (
        hasAvailableAsset &&
        (this.pendingApplyOrigin !== undefined || (this.autoCheck && this.applyMode === "silent-idle"))
      ) {
        this.beginDownloadBackground();
      }
    } catch (error) {
      this.phase = previousPhase === "ready" ? "ready" : "error";
      this.pendingApplyOrigin = undefined;
      this.errorMessage = error instanceof Error ? error.message : "检查更新失败";
      this.options.onChanged();
    }
  }

  private applyReleaseSelection(releases: readonly BridgeReleaseInfo[]): boolean {
    const { latest, updateAvailable } = selectLatestRelease(releases, {
      channel: this.channel,
      currentVersion: this.options.currentVersion,
    });
    this.latestRelease = latest;
    if (!latest || !updateAvailable) {
      this.matchedAsset = undefined;
      this.downloadedBytes = undefined;
      this.totalBytes = undefined;
      this.integrityVerified = undefined;
      this.stagedPath = undefined;
      this.stagedVersion = undefined;
      this.waitingForIdle = false;
      this.phase = "up-to-date";
      this.statusDetail = "当前已是最新版本";
      return false;
    }

    const matched = selectReleaseAsset(latest, {
      platform: this.options.platform,
      arch: this.options.arch,
      linuxPackageFormat: this.linuxPackageFormat,
    });
    this.matchedAsset = matched;
    if (this.stagedPath && this.stagedVersion === latest.version && existsSync(this.stagedPath)) {
      this.phase = "ready";
      return false;
    }
    this.stagedPath = undefined;
    this.stagedVersion = undefined;
    this.downloadedBytes = undefined;
    this.totalBytes = matched?.asset.size;
    this.integrityVerified = undefined;
    this.waitingForIdle = false;
    this.phase = "available";
    this.statusDetail = matched
      ? `发现新版本 v${latest.version}`
      : `发现新版本 v${latest.version}（当前平台 ${this.options.platform}-${this.options.arch} 暂无直装包，可前往 GitHub 查看）`;
    return Boolean(matched);
  }

  private beginDownloadBackground(): void {
    if (this.activeDownload || !this.latestRelease || !this.matchedAsset) return;
    this.phase = "downloading";
    this.downloadedBytes = 0;
    this.totalBytes = this.matchedAsset.asset.size;
    this.errorMessage = undefined;
    this.statusDetail = `正在下载 ${this.matchedAsset.asset.name}…`;
    this.options.onChanged();

    this.activeDownload = this.runDownload()
      .catch((error: unknown) => {
        this.phase = "error";
        this.pendingApplyOrigin = undefined;
        this.errorMessage = error instanceof Error ? error.message : "更新包下载或校验失败";
        this.options.onChanged();
      })
      .finally(() => {
        this.activeDownload = undefined;
      });
  }

  private async resolveExpectedSha256(release: BridgeReleaseInfo, assetName: string, directSha256?: string): Promise<string | undefined> {
    if (directSha256) return directSha256;
    const sumsAsset = release.assets.find((item) => item.name === "SHA256SUMS.txt");
    if (!sumsAsset) return undefined;
    const response = await this.fetchImpl(sumsAsset.downloadUrl, {
      headers: { "User-Agent": `claude-desktop-bridge/${this.options.currentVersion}` },
    });
    if (!response.ok) return undefined;
    const sums = parseSha256Sums(await response.text());
    return sums.get(assetName);
  }

  private async runDownload(): Promise<void> {
    const release = this.latestRelease!;
    const matched = this.matchedAsset!;
    await mkdir(this.updatesDir, { recursive: true, mode: 0o700 });

    const expectedSha256 = await this.resolveExpectedSha256(
      release,
      matched.asset.name,
      matched.asset.sha256,
    );

    const response = await this.fetchImpl(matched.asset.downloadUrl, {
      headers: { "User-Agent": `claude-desktop-bridge/${this.options.currentVersion}` },
    });
    if (!response.ok || !response.body) {
      throw new Error(`下载更新包失败（HTTP ${response.status}）`);
    }

    const partPath = join(this.updatesDir, "download.part");
    const archivePath = join(this.updatesDir, matched.wrapperZip ? "release-bundle.zip" : `installer${extname(matched.asset.name)}`);
    const hasher = createHash("sha256");
    let bytes = 0;
    let lastProgressEmit = 0;

    await pipeline(
      Readable.fromWeb(response.body as unknown as WebReadableStream),
      new Transform({
        transform: (chunk: Buffer, _encoding, callback) => {
          if (this.closed) {
            callback(new Error("Bridge 更新下载已关闭"));
            return;
          }
          hasher.update(chunk);
          bytes += chunk.length;
          this.downloadedBytes = bytes;
          const now = Date.now();
          if (now - lastProgressEmit >= PROGRESS_THROTTLE_MS) {
            lastProgressEmit = now;
            this.options.onChanged();
          }
          callback(null, chunk);
        },
      }),
      createWriteStream(partPath, { mode: 0o600 }),
    );

    if (matched.asset.size > 0 && bytes !== matched.asset.size) {
      throw new Error(`更新包大小不匹配（预期 ${matched.asset.size} 字节，实际 ${bytes} 字节）`);
    }

    const actualSha256 = hasher.digest("hex");
    if (expectedSha256) {
      if (actualSha256 !== expectedSha256) {
        throw new Error("更新包 SHA-256 完整性校验失败，已拒绝安装");
      }
      this.integrityVerified = "sha256";
    } else {
      this.integrityVerified = "size";
    }

    await rename(partPath, archivePath);

    let finalPath = archivePath;
    if (matched.wrapperZip) {
      const targetExt = matched.innerExtension ?? ".exe";
      const extractedPath = join(this.updatesDir, `Bridge-staged${targetExt}`);
      await extractZipEntryToFile(
        archivePath,
        (entry) => {
          const lower = entry.fileName.toLowerCase();
          if (targetExt === ".exe") return lower.endsWith(".exe") && lower.includes("setup");
          return lower.endsWith(targetExt);
        },
        extractedPath,
      );
      finalPath = extractedPath;
    } else {
      await chmod(finalPath, 0o700);
    }

    const fileStat = await stat(finalPath);
    if (fileStat.size <= 0) throw new Error("提取后的安装包为空");

    this.downloadedBytes = bytes;
    this.stagedPath = finalPath;
    this.stagedVersion = release.version;
    this.phase = "ready";

    const applyOrigin = this.pendingApplyOrigin;
    this.pendingApplyOrigin = undefined;

    if (applyOrigin) {
      await this.applyStagedUpdate(applyOrigin);
      return;
    }

    if (this.applyMode === "silent-idle" && this.canAutoRestart) {
      if (this.options.isSystemIdle()) {
        await this.applyStagedUpdate("desktop");
        return;
      }
      this.waitingForIdle = true;
      this.statusDetail = "更新包校验通过，将在当前会话空闲后自动静默升级重启。";
      this.options.onChanged();
      return;
    }

    this.statusDetail = this.canAutoRestart
      ? `v${release.version} 已就绪（${this.integrityVerified === "sha256" ? "SHA-256 已校验" : "大小已校验"}），点击立即重启完成升级。`
      : `v${release.version} 安装包已下载（${this.integrityVerified === "sha256" ? "SHA-256 已校验" : "大小已校验"}），请在电脑端打开完成安装。`;
    this.options.onChanged();
  }

  private async applyStagedUpdate(origin: "desktop" | "mobile"): Promise<void> {
    if (!this.stagedPath || !existsSync(this.stagedPath)) {
      throw new Error("未找到已就绪的更新安装包，请重新下载");
    }

    if (this.options.platform === "win32" && this.canAutoRestart) {
      this.phase = "applying";
      this.waitingForIdle = false;
      this.statusDetail = "正在退出 Bridge 并静默覆盖安装新版本…";
      this.options.onChanged();

      const spawnHelper = this.options.spawnWindowsHelper ?? defaultSpawnWindowsHelper;
      await spawnHelper({
        setupPath: this.stagedPath,
        installDir: win32.dirname(this.options.execPath),
        exePath: this.options.execPath,
        reopenUi: this.options.hasConnectedUi(),
        logPath: join(this.updatesDir, "apply-last.log"),
      });

      setTimeout(() => {
        void this.options.requestQuitAll();
      }, 150).unref?.();
      return;
    }

    if (origin === "mobile") {
      this.phase = "ready";
      this.statusDetail = this.options.platform === "darwin"
        ? "安装包已在电脑端下载并通过校验；macOS 需在电脑端点击「打开安装包」拖入替换。"
        : this.options.platform === "linux"
          ? "安装包已在电脑端下载并通过校验；Linux 需在电脑端使用系统包管理器完成安装。"
          : "安装包已在电脑端下载并通过校验；当前安装目录受系统保护，需在电脑端确认 UAC 提权安装。";
      this.options.onChanged();
      return;
    }

    if (!this.options.openLocalInstaller) {
      throw new Error("当前环境未配置本地安装器打开能力");
    }
    const revealOnly = this.options.platform !== "darwin";
    await this.options.openLocalInstaller(this.stagedPath, revealOnly);
    this.phase = "ready";
    this.statusDetail = this.options.platform === "darwin"
      ? "已打开 DMG 安装镜像，请将 Bridge 拖入 Applications 覆盖后重新启动。"
      : this.options.platform === "linux"
        ? `已在文件管理器中定位安装包（${this.stagedPath}），请使用系统包管理器安装后重启服务。`
        : "已在文件管理器中定位安装包，请在本机确认权限后安装。";
    this.options.onChanged();
  }

  private syncAutoCheckTimers(): void {
    this.clearTimers();
    if (this.closed || !this.options.autoCheckAllowed || !this.autoCheck) return;
    const initialDelay = this.options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
    const interval = this.options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
    this.initialTimer = setTimeout(() => {
      this.initialTimer = undefined;
      void this.checkForUpdates();
    }, initialDelay);
    this.initialTimer.unref?.();
    this.intervalTimer = setInterval(() => {
      void this.checkForUpdates();
    }, interval);
    this.intervalTimer.unref?.();
  }

  private clearTimers(): void {
    if (this.initialTimer) {
      clearTimeout(this.initialTimer);
      this.initialTimer = undefined;
    }
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = undefined;
    }
  }

  private async loadPreferences(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.prefsPath, "utf8")) as Partial<StoredUpdaterPreferences>;
      if (raw.channel === "stable" || raw.channel === "prerelease") this.channel = raw.channel;
      if (typeof raw.autoCheck === "boolean") this.autoCheck = raw.autoCheck;
      if (raw.applyMode === "prompt" || raw.applyMode === "silent-idle") this.applyMode = raw.applyMode;
      if (typeof raw.etag === "string" && raw.etag) this.etag = raw.etag;
      if (raw.cachedReleases !== undefined) {
        this.cachedReleases = parseGitHubReleases(raw.cachedReleases);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        process.stderr.write(`Bridge updater preferences load failed: ${String(error)}\n`);
      }
    }
  }

  private async savePreferences(): Promise<void> {
    await mkdir(dirname(this.prefsPath), { recursive: true, mode: 0o700 });
    const tempPath = `${this.prefsPath}.${process.pid}.tmp`;
    const data: StoredUpdaterPreferences = {
      version: 1,
      channel: this.channel,
      autoCheck: this.autoCheck,
      applyMode: this.applyMode,
      ...(this.etag ? { etag: this.etag } : {}),
      ...(this.cachedReleases.length > 0 ? {
        cachedReleases: this.cachedReleases.map((item) => ({
          tag_name: item.tagName,
          name: item.name,
          prerelease: item.prerelease,
          published_at: item.publishedAt,
          html_url: item.htmlUrl,
          body: item.body,
          assets: item.assets.map((asset) => ({
            name: asset.name,
            browser_download_url: asset.downloadUrl,
            size: asset.size,
            ...(asset.sha256 ? { digest: `sha256:${asset.sha256}` } : {}),
          })),
        })),
      } : {}),
    };
    await writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await rename(tempPath, this.prefsPath);
  }
}
