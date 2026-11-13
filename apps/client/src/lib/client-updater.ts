import { App as CapacitorApp } from "@capacitor/app";
import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import {
  parseGitHubReleases,
  parseSha256Sums,
  selectLatestRelease,
  selectReleaseAsset,
  type BridgeMatchedAsset,
  type BridgeUpdateChannel,
} from "@bridge/protocol";
import { useEffect, useState } from "react";

declare const __BRIDGE_APP_VERSION__: string | undefined;

export const GITHUB_RELEASES_PAGE_URL = "https://github.com/Lycidas97/claude-desktop-bridge/releases";
const STORAGE_KEY = "bridge.client.updater.v1";

export type ClientUpdaterPhase =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "awaiting-permission"
  | "ready"
  | "error";

export interface BridgeUpdaterNativePlugin {
  getAppInfo(): Promise<{
    versionName: string;
    versionCode: number;
    packageName: string;
    canInstallPackages: boolean;
    arch: string;
  }>;
  fetchReleasesJson(options: { url?: string; etag?: string }): Promise<{
    status: number;
    etag?: string;
    body?: string;
  }>;
  downloadAndVerifyApk(options: {
    url: string;
    version: string;
    expectedSha256?: string;
    expectedSize?: number;
  }): Promise<{
    staged: boolean;
    reusedCache?: boolean;
    sha256: string;
    bytes: number;
    canInstallPackages: boolean;
  }>;
  installStagedApk(): Promise<{
    launchedInstaller: boolean;
    needsPermission: boolean;
  }>;
  openExternalUrl(options: { url: string }): Promise<void>;
  addListener(
    eventName: "downloadProgress",
    listenerFunc: (event: { downloadedBytes: number; totalBytes?: number }) => void,
  ): Promise<PluginListenerHandle>;
}

const NativeBridgeUpdater = registerPlugin<BridgeUpdaterNativePlugin>("BridgeUpdater");

export interface ClientUpdaterSnapshot {
  platform: string;
  nativeSupported: boolean;
  currentVersion: string;
  arch: string;
  channel: BridgeUpdateChannel;
  autoCheck: boolean;
  phase: ClientUpdaterPhase;
  checkedAt?: number;
  latestVersion?: string;
  releaseUrl: string;
  releaseNotes?: string;
  assetName?: string;
  downloadedBytes?: number;
  totalBytes?: number;
  statusDetail?: string;
  error?: string;
  promptOpen: boolean;
}

interface StoredPrefs {
  channel?: BridgeUpdateChannel;
  autoCheck?: boolean;
  dismissedVersion?: string;
  etag?: string;
  cachedBody?: string;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultVersion(): string {
  return typeof __BRIDGE_APP_VERSION__ !== "undefined" ? __BRIDGE_APP_VERSION__ : "0.0.0";
}

export class ClientUpdaterController {
  private readonly listeners = new Set<() => void>();
  private readonly platform: string;
  private readonly plugin: BridgeUpdaterNativePlugin;
  private readonly storage: StorageLike | undefined;

  private currentVersion: string;
  private arch = "arm64";
  private channel: BridgeUpdateChannel = "stable";
  private autoCheck = true;
  private dismissedVersion: string | undefined;
  private etag: string | undefined;
  private cachedBody: string | undefined;

  private phase: ClientUpdaterPhase = "idle";
  private checkedAt: number | undefined;
  private latestVersion: string | undefined;
  private releaseUrl = GITHUB_RELEASES_PAGE_URL;
  private releaseNotes: string | undefined;
  private matchedAsset: BridgeMatchedAsset | undefined;
  private resolvedSha256: string | undefined;
  private downloadedBytes: number | undefined;
  private totalBytes: number | undefined;
  private statusDetail: string | undefined;
  private error: string | undefined;
  private promptOpen = false;
  private startupDone = false;
  private activeCheck: Promise<ClientUpdaterSnapshot> | undefined;
  private cachedSnapshot: ClientUpdaterSnapshot;

  constructor(options: {
    platform: string;
    initialVersion?: string;
    plugin?: BridgeUpdaterNativePlugin;
    storage?: StorageLike;
  }) {
    this.platform = options.platform;
    this.currentVersion = options.initialVersion ?? defaultVersion();
    this.plugin = options.plugin ?? NativeBridgeUpdater;
    this.storage = options.storage;
    this.loadStorage();
    this.cachedSnapshot = this.buildSnapshot();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): ClientUpdaterSnapshot => this.cachedSnapshot;

  async initializeStartup(): Promise<void> {
    if (this.startupDone) return;
    this.startupDone = true;
    if (this.platform !== "android") return;
    try {
      const info = await this.plugin.getAppInfo();
      if (info.versionName) this.currentVersion = info.versionName;
      if (info.arch) this.arch = info.arch;
      this.emit();
    } catch {
      // Keep build-time version if native info lookup fails
    }
    if (this.autoCheck) {
      await this.check({ manual: false });
    }
  }

  setChannel(channel: BridgeUpdateChannel): void {
    if (this.channel === channel) return;
    this.channel = channel;
    this.saveStorage();
    if (this.cachedBody) {
      this.evaluateBody(this.cachedBody, false);
    }
    this.emit();
    if (this.platform === "android") {
      void this.check({ manual: false });
    }
  }

  setAutoCheck(enabled: boolean): void {
    this.autoCheck = enabled;
    this.saveStorage();
    this.emit();
  }

  dismissPrompt(): void {
    this.promptOpen = false;
    if (this.latestVersion) {
      this.dismissedVersion = this.latestVersion;
      this.saveStorage();
    }
    this.emit();
  }

  openPrompt(): void {
    if (this.latestVersion) {
      this.promptOpen = true;
      this.emit();
    }
  }

  async openReleasesPage(url = this.releaseUrl): Promise<void> {
    if (this.platform === "android") {
      await this.plugin.openExternalUrl({ url });
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  }

  async check(options?: { manual?: boolean }): Promise<ClientUpdaterSnapshot> {
    if (this.platform !== "android") {
      return this.cachedSnapshot;
    }
    if (this.activeCheck) return this.activeCheck;
    const manual = options?.manual ?? true;
    this.activeCheck = this.runCheck(manual).finally(() => {
      this.activeCheck = undefined;
    });
    return this.activeCheck;
  }

  async downloadAndInstall(): Promise<ClientUpdaterSnapshot> {
    if (this.platform !== "android") return this.cachedSnapshot;
    if (this.activeCheck) await this.activeCheck;
    if (this.phase === "ready" || this.phase === "awaiting-permission") {
      return this.installStaged();
    }
    if (!this.matchedAsset || !this.latestVersion) {
      await this.openReleasesPage();
      return this.cachedSnapshot;
    }

    this.phase = "downloading";
    this.error = undefined;
    this.downloadedBytes = 0;
    this.totalBytes = this.matchedAsset.asset.size > 0 ? this.matchedAsset.asset.size : undefined;
    this.statusDetail = `正在下载 ${this.matchedAsset.asset.name}…`;
    this.emit();

    let progressHandle: PluginListenerHandle | undefined;
    try {
      progressHandle = await this.plugin.addListener("downloadProgress", (progress) => {
        this.downloadedBytes = progress.downloadedBytes;
        if (progress.totalBytes && progress.totalBytes > 0) {
          this.totalBytes = progress.totalBytes;
        }
        this.emit();
      });

      const expectedSha256 = this.resolvedSha256 ?? this.matchedAsset.asset.sha256;
      const result = await this.plugin.downloadAndVerifyApk({
        url: this.matchedAsset.asset.downloadUrl,
        version: this.latestVersion,
        ...(expectedSha256 ? { expectedSha256 } : {}),
        ...(this.matchedAsset.asset.size > 0 ? { expectedSize: this.matchedAsset.asset.size } : {}),
      });
      this.downloadedBytes = result.bytes;
      this.totalBytes = result.bytes;
      this.phase = "ready";
      this.statusDetail = "安装包校验通过，正在准备安装…";
      this.emit();
      return await this.installStaged();
    } catch (err) {
      this.phase = "error";
      this.error = err instanceof Error ? err.message : String(err);
      this.statusDetail = this.error;
      this.emit();
      return this.cachedSnapshot;
    } finally {
      await progressHandle?.remove().catch(() => undefined);
    }
  }

  async installStaged(): Promise<ClientUpdaterSnapshot> {
    if (this.platform !== "android") return this.cachedSnapshot;
    try {
      const res = await this.plugin.installStagedApk();
      if (res.needsPermission) {
        this.phase = "awaiting-permission";
        this.error = undefined;
        this.statusDetail = "请在系统设置中开启“允许安装未知应用”，返回后将自动继续安装";
      } else if (res.launchedInstaller) {
        this.phase = "ready";
        this.error = undefined;
        this.statusDetail = "已拉起系统安装器";
        this.promptOpen = false;
      }
    } catch (err) {
      this.phase = "error";
      this.error = err instanceof Error ? err.message : String(err);
      this.statusDetail = this.error;
    }
    this.emit();
    return this.cachedSnapshot;
  }

  async handleAppResume(): Promise<void> {
    if (this.platform !== "android" || this.phase !== "awaiting-permission") return;
    try {
      const info = await this.plugin.getAppInfo();
      if (info.canInstallPackages) {
        await this.installStaged();
      }
    } catch {
      // Ignore transient resume errors
    }
  }

  private async runCheck(manual: boolean): Promise<ClientUpdaterSnapshot> {
    const prevPhase = this.phase;
    if (prevPhase !== "downloading" && prevPhase !== "awaiting-permission") {
      this.phase = "checking";
      this.error = undefined;
      this.statusDetail = "正在检查更新…";
      this.emit();
    }

    try {
      const res = await this.plugin.fetchReleasesJson({
        ...(this.etag && this.cachedBody ? { etag: this.etag } : {}),
      });
      let body = this.cachedBody;
      if (res.status !== 304 && res.body) {
        body = res.body;
        this.cachedBody = body;
        if (res.etag) this.etag = res.etag;
        this.saveStorage();
      }
      this.checkedAt = Date.now();
      if (body) {
        const matched = this.evaluateBody(body, manual);
        if (matched && !matched.asset.sha256) {
          await this.tryResolveSha256Sums(body, matched.asset.name);
        }
      } else {
        this.phase = "up-to-date";
        this.statusDetail = "当前已是最新版本";
      }
    } catch (err) {
      if (manual || prevPhase === "idle") {
        this.phase = "error";
        this.error = err instanceof Error ? err.message : String(err);
        this.statusDetail = this.error;
      } else {
        this.phase = prevPhase;
      }
    }
    this.emit();
    return this.cachedSnapshot;
  }

  private evaluateBody(rawBody: string, manual: boolean): BridgeMatchedAsset | undefined {
    const releases = parseGitHubReleases(JSON.parse(rawBody));
    const { latest, updateAvailable } = selectLatestRelease(releases, {
      channel: this.channel,
      currentVersion: this.currentVersion,
    });
    if (!latest || !updateAvailable) {
      this.latestVersion = latest?.version;
      this.releaseUrl = latest?.htmlUrl ?? GITHUB_RELEASES_PAGE_URL;
      this.releaseNotes = undefined;
      this.matchedAsset = undefined;
      this.resolvedSha256 = undefined;
      this.phase = "up-to-date";
      this.statusDetail = "当前已是最新版本";
      this.promptOpen = false;
      return undefined;
    }

    const matched = selectReleaseAsset(latest, {
      platform: "android",
      arch: this.arch,
    });
    if (this.latestVersion !== latest.version || (this.phase !== "ready" && this.phase !== "awaiting-permission")) {
      this.phase = "available";
      this.downloadedBytes = undefined;
    }
    this.latestVersion = latest.version;
    this.releaseUrl = latest.htmlUrl;
    this.releaseNotes = latest.body || undefined;
    this.matchedAsset = matched;
    this.resolvedSha256 = matched?.asset.sha256;
    this.totalBytes = matched?.asset.size;
    this.statusDetail = matched
      ? `发现新版本 v${latest.version}`
      : `发现新版本 v${latest.version}（请前往 GitHub 下载安装包）`;
    if (manual || this.dismissedVersion !== latest.version) {
      this.promptOpen = true;
    }
    return matched;
  }

  private async tryResolveSha256Sums(rawBody: string, assetName: string): Promise<void> {
    try {
      const releases = parseGitHubReleases(JSON.parse(rawBody));
      const release = releases.find((item) => item.version === this.latestVersion);
      const sumsAsset = release?.assets.find((item) => item.name === "SHA256SUMS.txt");
      if (!sumsAsset) return;
      const sumsRes = await this.plugin.fetchReleasesJson({ url: sumsAsset.downloadUrl });
      if (sumsRes.body) {
        this.resolvedSha256 = parseSha256Sums(sumsRes.body).get(assetName);
      }
    } catch {
      // Optional fallback when GitHub asset.digest is unavailable
    }
  }

  private loadStorage(): void {
    if (!this.storage) return;
    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as StoredPrefs;
      if (parsed.channel === "stable" || parsed.channel === "prerelease") {
        this.channel = parsed.channel;
      }
      if (typeof parsed.autoCheck === "boolean") {
        this.autoCheck = parsed.autoCheck;
      }
      if (typeof parsed.dismissedVersion === "string") {
        this.dismissedVersion = parsed.dismissedVersion;
      }
      if (typeof parsed.etag === "string") {
        this.etag = parsed.etag;
      }
      if (typeof parsed.cachedBody === "string") {
        this.cachedBody = parsed.cachedBody;
      }
    } catch {
      // Ignore corrupt storage
    }
  }

  private saveStorage(): void {
    if (!this.storage) return;
    try {
      const payload: StoredPrefs = {
        channel: this.channel,
        autoCheck: this.autoCheck,
        ...(this.dismissedVersion ? { dismissedVersion: this.dismissedVersion } : {}),
        ...(this.etag ? { etag: this.etag } : {}),
        ...(this.cachedBody ? { cachedBody: this.cachedBody } : {}),
      };
      this.storage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // Ignore quota errors
    }
  }

  private buildSnapshot(): ClientUpdaterSnapshot {
    return {
      platform: this.platform,
      nativeSupported: this.platform === "android",
      currentVersion: this.currentVersion,
      arch: this.arch,
      channel: this.channel,
      autoCheck: this.autoCheck,
      phase: this.phase,
      ...(this.checkedAt !== undefined ? { checkedAt: this.checkedAt } : {}),
      ...(this.latestVersion ? { latestVersion: this.latestVersion } : {}),
      releaseUrl: this.releaseUrl,
      ...(this.releaseNotes ? { releaseNotes: this.releaseNotes } : {}),
      ...(this.matchedAsset ? { assetName: this.matchedAsset.asset.name } : {}),
      ...(this.downloadedBytes !== undefined ? { downloadedBytes: this.downloadedBytes } : {}),
      ...(this.totalBytes !== undefined ? { totalBytes: this.totalBytes } : {}),
      ...(this.statusDetail ? { statusDetail: this.statusDetail } : {}),
      ...(this.error ? { error: this.error } : {}),
      promptOpen: this.promptOpen,
    };
  }

  private emit(): void {
    this.cachedSnapshot = this.buildSnapshot();
    for (const listener of this.listeners) {
      listener();
    }
  }
}

let sharedController: ClientUpdaterController | undefined;

export function getSharedClientUpdater(): ClientUpdaterController {
  if (!sharedController) {
    const runtimePlatform = Capacitor.isNativePlatform() ? Capacitor.getPlatform() : "web";
    const storage = typeof window !== "undefined" ? window.localStorage : undefined;
    sharedController = new ClientUpdaterController({
      platform: runtimePlatform,
      ...(storage ? { storage } : {}),
    });
  }
  return sharedController;
}

export function useClientUpdater(enabled = true) {
  const controller = getSharedClientUpdater();
  const [, setTick] = useState(0);
  const snapshot = controller.getSnapshot();

  useEffect(() => controller.subscribe(() => setTick((t) => t + 1)), [controller]);

  useEffect(() => {
    if (!enabled) return;
    void controller.initializeStartup();
    if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== "android") return;
    let handle: PluginListenerHandle | undefined;
    void CapacitorApp.addListener("appStateChange", ({ isActive }) => {
      if (isActive) void controller.handleAppResume();
    }).then((listener) => {
      handle = listener;
    });
    return () => {
      void handle?.remove();
    };
  }, [controller, enabled]);

  return {
    state: snapshot,
    check: (manual = true) => controller.check({ manual }),
    downloadAndInstall: () => controller.downloadAndInstall(),
    installStaged: () => controller.installStaged(),
    setChannel: (channel: BridgeUpdateChannel) => controller.setChannel(channel),
    setAutoCheck: (autoCheck: boolean) => controller.setAutoCheck(autoCheck),
    dismissPrompt: () => controller.dismissPrompt(),
    openPrompt: () => controller.openPrompt(),
    openReleasesPage: (url?: string) => controller.openReleasesPage(url),
  };
}
