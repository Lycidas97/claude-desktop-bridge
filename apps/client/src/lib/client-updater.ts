import { Capacitor, registerPlugin } from "@capacitor/core";
import {
  parseGitHubReleases,
  selectLatestRelease,
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
  openExternalUrl(options: { url: string }): Promise<void>;
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
  private hasStoredChannel = false;
  private autoCheck = true;
  private dismissedVersion: string | undefined;
  private etag: string | undefined;
  private cachedBody: string | undefined;

  private phase: ClientUpdaterPhase = "idle";
  private checkedAt: number | undefined;
  private latestVersion: string | undefined;
  private releaseUrl = GITHUB_RELEASES_PAGE_URL;
  private releaseNotes: string | undefined;
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
    this.channel = this.currentVersion.includes("-") ? "prerelease" : "stable";
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
      if (info.versionName) {
        this.currentVersion = info.versionName;
        if (!this.hasStoredChannel) {
          this.channel = info.versionName.includes("-") ? "prerelease" : "stable";
        }
      }
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
    const changed = this.channel !== channel;
    this.channel = channel;
    if (!changed && this.hasStoredChannel) return;
    this.hasStoredChannel = true;
    this.saveStorage();
    if (!changed) return;
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
    const targetUrl = /^https:\/\//iu.test(url) ? url : GITHUB_RELEASES_PAGE_URL;
    if (this.platform === "android") {
      await this.plugin.openExternalUrl({ url: targetUrl });
      return;
    }
    window.open(targetUrl, "_blank", "noopener,noreferrer");
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

  private async runCheck(manual: boolean): Promise<ClientUpdaterSnapshot> {
    const prevPhase = this.phase;
    this.phase = "checking";
    this.error = undefined;
    this.statusDetail = "正在检查更新…";
    this.emit();

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
        this.evaluateBody(body, manual);
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

  private evaluateBody(rawBody: string, manual: boolean): void {
    const releases = parseGitHubReleases(JSON.parse(rawBody));
    const { latest, updateAvailable } = selectLatestRelease(releases, {
      channel: this.channel,
      currentVersion: this.currentVersion,
    });
    if (!latest || !updateAvailable) {
      this.latestVersion = latest?.version;
      this.releaseUrl = latest?.htmlUrl ?? GITHUB_RELEASES_PAGE_URL;
      this.releaseNotes = undefined;
      this.phase = "up-to-date";
      this.statusDetail = "当前已是最新版本";
      this.promptOpen = false;
      return;
    }

    this.phase = "available";
    this.latestVersion = latest.version;
    this.releaseUrl = latest.htmlUrl;
    this.releaseNotes = latest.body || undefined;
    this.statusDetail = `发现新版本 v${latest.version}`;
    if (manual || this.dismissedVersion !== latest.version) {
      this.promptOpen = true;
    }
  }

  private loadStorage(): void {
    if (!this.storage) return;
    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      const prefs = parsed as StoredPrefs;
      if (prefs.channel === "stable" || prefs.channel === "prerelease") {
        this.channel = prefs.channel;
        this.hasStoredChannel = true;
      }
      if (typeof prefs.autoCheck === "boolean") {
        this.autoCheck = prefs.autoCheck;
      }
      if (typeof prefs.dismissedVersion === "string") {
        this.dismissedVersion = prefs.dismissedVersion;
      }
      if (typeof prefs.etag === "string") {
        this.etag = prefs.etag;
      }
      if (typeof prefs.cachedBody === "string") {
        this.cachedBody = prefs.cachedBody;
      }
    } catch {
      // Ignore corrupt storage
    }
  }

  private saveStorage(): void {
    if (!this.storage) return;
    try {
      const payload: StoredPrefs = {
        ...(this.hasStoredChannel ? { channel: this.channel } : {}),
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
    let storage: Storage | undefined;
    try {
      storage = typeof window !== "undefined" ? window.localStorage : undefined;
    } catch {
      storage = undefined;
    }
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
  }, [controller, enabled]);

  return {
    state: snapshot,
    check: (manual = true) => controller.check({ manual }),
    setChannel: (channel: BridgeUpdateChannel) => controller.setChannel(channel),
    setAutoCheck: (autoCheck: boolean) => controller.setAutoCheck(autoCheck),
    dismissPrompt: () => controller.dismissPrompt(),
    openPrompt: () => controller.openPrompt(),
    openReleasesPage: (url?: string) => controller.openReleasesPage(url),
  };
}
