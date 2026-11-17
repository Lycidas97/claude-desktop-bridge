import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  DEFAULT_GITHUB_RELEASES_PAGE_URL,
  DEFAULT_GITHUB_RELEASES_URL,
  parseGitHubReleases,
  selectLatestRelease,
  selectReleaseAsset,
  type BridgeMatchedAsset,
  type BridgeReleaseInfo,
  type BridgeSystemUpdateParams,
  type BridgeUpdateChannel,
  type BridgeUpdaterPhase,
  type BridgeUpdaterSnapshot,
} from "@bridge/protocol";

export type DesktopUpdaterPlatform = "win32" | "darwin" | "linux";

interface StoredUpdaterPreferences {
  version: 1;
  channel?: BridgeUpdateChannel;
  autoCheck: boolean;
  applyMode: "prompt";
  etag?: string;
  cachedReleases?: unknown;
}

export interface DesktopUpdaterOptions {
  platform: DesktopUpdaterPlatform;
  arch: string;
  currentVersion: string;
  userDataPath: string;
  feedUrl?: string | undefined;
  autoCheckAllowed: boolean;
  checkIntervalMs?: number;
  initialDelayMs?: number;
  fetchImpl?: typeof fetch;
  openExternalUrl?: (url: string) => Promise<void>;
  onChanged: () => void;
}

const DEFAULT_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_INITIAL_DELAY_MS = 8_000;

export class DesktopUpdater {
  private readonly prefsPath: string;
  private readonly feedUrl: string;
  private readonly fetchImpl: typeof fetch;
  private channel: BridgeUpdateChannel;
  private hasStoredChannel = false;
  private autoCheck = true;
  private etag: string | undefined;
  private cachedReleases: BridgeReleaseInfo[] = [];

  private phase: BridgeUpdaterPhase = "idle";
  private checkedAt: number | undefined;
  private latestRelease: BridgeReleaseInfo | undefined;
  private matchedAsset: BridgeMatchedAsset | undefined;
  private statusDetail: string | undefined;
  private errorMessage: string | undefined;

  private closed = false;
  private initialTimer: ReturnType<typeof setTimeout> | undefined;
  private intervalTimer: ReturnType<typeof setInterval> | undefined;
  private activeCheck: Promise<void> | undefined;

  constructor(private readonly options: DesktopUpdaterOptions) {
    this.prefsPath = join(options.userDataPath, "updater-v1.json");
    this.feedUrl = options.feedUrl?.trim() || DEFAULT_GITHUB_RELEASES_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.channel = options.currentVersion.includes("-") ? "prerelease" : "stable";
  }

  async initialize(): Promise<void> {
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
      applyMode: "prompt",
      canAutoRestart: false,
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
      ...(this.statusDetail ? { statusDetail: this.statusDetail } : {}),
      ...(this.errorMessage ? { error: this.errorMessage } : {}),
    };
  }

  async waitForPendingTasks(): Promise<void> {
    if (this.activeCheck) await this.activeCheck;
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
      if (input.channel !== undefined) {
        this.channel = input.channel;
        this.hasStoredChannel = true;
      }
      if (input.autoCheck !== undefined) this.autoCheck = input.autoCheck;
      await this.savePreferences();
      this.syncAutoCheckTimers();
      if (channelChanged && this.cachedReleases.length > 0) {
        this.applyReleaseSelection(this.cachedReleases);
      }
      this.options.onChanged();
      return this.snapshot();
    }

    if (input.action === "check") {
      if (input.channel !== undefined) {
        this.channel = input.channel;
        this.hasStoredChannel = true;
        await this.savePreferences();
      }
      await this.checkForUpdates();
      return this.snapshot();
    }

    // Backward-compatible no-download handling for "download" / "apply"
    if (this.phase === "idle" || this.phase === "error") {
      await this.checkForUpdates();
    }
    if (origin === "desktop" && this.options.openExternalUrl) {
      const targetUrl = this.latestRelease?.htmlUrl || DEFAULT_GITHUB_RELEASES_PAGE_URL;
      if (/^https:\/\//iu.test(targetUrl)) {
        await this.options.openExternalUrl(targetUrl);
      }
    }
    return this.snapshot();
  }

  async checkForUpdates(): Promise<void> {
    if (this.closed) return;
    if (this.activeCheck) return this.activeCheck;
    this.activeCheck = this.runCheck().finally(() => {
      this.activeCheck = undefined;
    });
    return this.activeCheck;
  }

  private async runCheck(): Promise<void> {
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
      this.applyReleaseSelection(releases);
      this.options.onChanged();
    } catch (error) {
      this.phase = "error";
      this.errorMessage = error instanceof Error ? error.message : "检查更新失败";
      this.options.onChanged();
    }
  }

  private applyReleaseSelection(releases: readonly BridgeReleaseInfo[]): void {
    const { latest, updateAvailable } = selectLatestRelease(releases, {
      channel: this.channel,
      currentVersion: this.options.currentVersion,
    });
    this.latestRelease = latest;
    if (!latest || !updateAvailable) {
      this.matchedAsset = undefined;
      this.phase = "up-to-date";
      this.statusDetail = "当前已是最新版本";
      return;
    }

    this.matchedAsset = selectReleaseAsset(latest, {
      platform: this.options.platform,
      arch: this.options.arch,
    });
    this.phase = "available";
    this.statusDetail = `发现新版本 v${latest.version}`;
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
      if (raw.channel === "stable" || raw.channel === "prerelease") {
        this.channel = raw.channel;
        this.hasStoredChannel = true;
      }
      if (typeof raw.autoCheck === "boolean") this.autoCheck = raw.autoCheck;
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
      ...(this.hasStoredChannel ? { channel: this.channel } : {}),
      autoCheck: this.autoCheck,
      applyMode: "prompt",
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
