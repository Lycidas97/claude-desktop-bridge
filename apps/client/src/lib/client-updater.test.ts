import { describe, expect, it, vi } from "vitest";
import {
  ClientUpdaterController,
  GITHUB_RELEASES_PAGE_URL,
  type BridgeUpdaterNativePlugin,
  type StorageLike,
} from "./client-updater.js";

function createMemoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}

const SAMPLE_RELEASES_JSON = JSON.stringify([
  {
    tag_name: "v1.4.0-rc.1",
    name: "Bridge v1.4.0-rc.1",
    draft: false,
    prerelease: true,
    html_url: "https://github.com/Lycidas97/claude-desktop-bridge/releases/tag/v1.4.0-rc.1",
    body: "- Prerelease build",
    assets: [
      {
        name: "Bridge-1.4.0-rc.1-android-debug.apk",
        browser_download_url: "https://github.com/Lycidas97/claude-desktop-bridge/releases/download/v1.4.0-rc.1/Bridge-1.4.0-rc.1-android-debug.apk",
        size: 10_000_000,
        digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        state: "uploaded",
      },
    ],
  },
  {
    tag_name: "v1.3.3",
    name: "Bridge v1.3.3",
    draft: false,
    prerelease: false,
    html_url: "https://github.com/Lycidas97/claude-desktop-bridge/releases/tag/v1.3.3",
    body: "- Android & Desktop updater",
    assets: [
      {
        name: "Bridge-1.3.3-android-debug.apk",
        browser_download_url: "https://github.com/Lycidas97/claude-desktop-bridge/releases/download/v1.3.3/Bridge-1.3.3-android-debug.apk",
        size: 9_500_000,
        state: "uploaded",
      },
      {
        name: "SHA256SUMS.txt",
        browser_download_url: "https://github.com/Lycidas97/claude-desktop-bridge/releases/download/v1.3.3/SHA256SUMS.txt",
        size: 128,
        state: "uploaded",
      },
    ],
  },
]);

describe("ClientUpdaterController", () => {
  it("runs startup check on Android, resolves SHA256SUMS.txt, handles REQUEST_INSTALL_PACKAGES resume, and reuses cached APK", async () => {
    let canInstall = false;
    let progressCb: ((ev: { downloadedBytes: number; totalBytes?: number }) => void) | undefined;
    const downloadCalls: Array<{ url: string; version: string; expectedSha256?: string }> = [];
    let installCalls = 0;

    const plugin: BridgeUpdaterNativePlugin = {
      getAppInfo: vi.fn(async () => ({
        versionName: "1.3.2",
        versionCode: 2,
        packageName: "com.localbridge.mobile",
        canInstallPackages: canInstall,
        arch: "arm64",
      })),
      fetchReleasesJson: vi.fn(async ({ url }) => {
        if (url?.endsWith("SHA256SUMS.txt")) {
          return {
            status: 200,
            body: `${"b".repeat(64)}  Bridge-1.3.3-android-debug.apk\n`,
          };
        }
        return {
          status: 200,
          etag: '"etag-133"',
          body: SAMPLE_RELEASES_JSON,
        };
      }),
      downloadAndVerifyApk: vi.fn(async (opts) => {
        downloadCalls.push(opts);
        progressCb?.({ downloadedBytes: 4_750_000, totalBytes: 9_500_000 });
        return {
          staged: true,
          sha256: "b".repeat(64),
          bytes: 9_500_000,
          canInstallPackages: canInstall,
        };
      }),
      installStagedApk: vi.fn(async () => {
        installCalls += 1;
        if (!canInstall) {
          return { launchedInstaller: false, needsPermission: true };
        }
        return { launchedInstaller: true, needsPermission: false };
      }),
      openExternalUrl: vi.fn(async () => {}),
      addListener: vi.fn(async (_event, cb) => {
        progressCb = cb;
        return { remove: vi.fn(async () => {}) };
      }),
    };

    const storage = createMemoryStorage();
    const updater = new ClientUpdaterController({
      platform: "android",
      initialVersion: "1.3.2",
      plugin,
      storage,
    });

    await updater.initializeStartup();
    expect(updater.getSnapshot().phase).toBe("available");
    expect(updater.getSnapshot().latestVersion).toBe("1.3.3");
    expect(updater.getSnapshot().promptOpen).toBe(true);

    // Download & install when REQUEST_INSTALL_PACKAGES is not yet granted
    await updater.downloadAndInstall();
    expect(downloadCalls).toHaveLength(1);
    expect(downloadCalls[0]?.expectedSha256).toBe("b".repeat(64));
    expect(updater.getSnapshot().phase).toBe("awaiting-permission");
    expect(installCalls).toBe(1);

    // User grants unknown sources permission in system Settings and resumes app -> installs without re-downloading!
    canInstall = true;
    await updater.handleAppResume();
    expect(downloadCalls).toHaveLength(1);
    expect(installCalls).toBe(2);
    expect(updater.getSnapshot().phase).toBe("ready");
    expect(updater.getSnapshot().promptOpen).toBe(false);
  });

  it("finishes a channel check before starting the selected APK download", async () => {
    let finishCheck!: (value: { status: number; body: string }) => void;
    let finishDownload!: (value: { staged: boolean; sha256: string; bytes: number; canInstallPackages: boolean }) => void;
    const downloaded: string[] = [];
    const plugin: BridgeUpdaterNativePlugin = {
      getAppInfo: vi.fn(async () => ({ versionName: "1.3.2", versionCode: 2, packageName: "fixture", canInstallPackages: true, arch: "arm64" })),
      fetchReleasesJson: vi.fn(async ({ url }) => url ? { status: 200, body: "" } : { status: 200, body: SAMPLE_RELEASES_JSON }),
      downloadAndVerifyApk: vi.fn(({ version }) => {
        downloaded.push(version);
        return new Promise<Awaited<ReturnType<BridgeUpdaterNativePlugin["downloadAndVerifyApk"]>>>(resolve => { finishDownload = resolve; });
      }),
      installStagedApk: vi.fn(async () => ({ launchedInstaller: true, needsPermission: false })),
      openExternalUrl: vi.fn(), addListener: vi.fn(async () => ({ remove: vi.fn(async () => {}) })),
    };
    const updater = new ClientUpdaterController({ platform: "android", plugin });
    await updater.initializeStartup();
    vi.mocked(plugin.fetchReleasesJson).mockImplementationOnce(() => new Promise(resolve => { finishCheck = resolve; }));
    updater.setChannel("prerelease");
    expect(updater.getSnapshot().phase).toBe("checking");
    const installing = updater.downloadAndInstall();
    await new Promise<void>(resolve => queueMicrotask(resolve));
    expect.soft(downloaded).toEqual([]);
    finishCheck({ status: 200, body: SAMPLE_RELEASES_JSON.replaceAll("1.4.0-rc.1", "1.4.0-rc.2") });
    await updater.check({ manual: false });
    await vi.waitFor(() => expect(downloaded).toHaveLength(1));
    expect.soft(downloaded).toEqual(["1.4.0-rc.2"]);
    expect.soft(updater.getSnapshot().phase).toBe("downloading");
    finishDownload({ staged: true, sha256: "a".repeat(64), bytes: 100, canInstallPackages: true });
    await installing;
    expect(plugin.installStagedApk).toHaveBeenCalledOnce();
  });

  it("invalidates the staged APK when the selected update changes while awaiting permission", async () => {
    let canInstall = false;
    let stagedVersion: string | undefined;
    const downloadedVersions: string[] = [];
    const installedVersions: Array<string | undefined> = [];
    const plugin: BridgeUpdaterNativePlugin = {
      getAppInfo: vi.fn(async () => ({
        versionName: "1.3.2", versionCode: 2, packageName: "com.localbridge.mobile",
        canInstallPackages: canInstall, arch: "arm64",
      })),
      fetchReleasesJson: vi.fn(async ({ url }) => ({
        status: 200, body: url ? "" : SAMPLE_RELEASES_JSON,
      })),
      downloadAndVerifyApk: vi.fn(async ({ version }) => {
        stagedVersion = version;
        downloadedVersions.push(version);
        return { staged: true, sha256: "a".repeat(64), bytes: 100, canInstallPackages: canInstall };
      }),
      installStagedApk: vi.fn(async () => {
        if (canInstall) installedVersions.push(stagedVersion);
        return { launchedInstaller: canInstall, needsPermission: !canInstall };
      }),
      openExternalUrl: vi.fn(),
      addListener: vi.fn(async () => ({ remove: vi.fn(async () => {}) })),
    };
    const updater = new ClientUpdaterController({ platform: "android", initialVersion: "1.3.2", plugin });
    await updater.initializeStartup();
    await updater.downloadAndInstall();
    expect(downloadedVersions).toEqual(["1.3.3"]);
    expect(updater.getSnapshot().phase).toBe("awaiting-permission");

    // Return without granting permission, dismiss, then select another release.
    await updater.handleAppResume();
    updater.dismissPrompt();
    updater.setChannel("prerelease");
    await updater.check({ manual: false });
    expect(updater.getSnapshot().latestVersion).toBe("1.4.0-rc.1");
    expect.soft(updater.getSnapshot().phase).toBe("available");
    expect(updater.getSnapshot().downloadedBytes).toBeUndefined();

    canInstall = true;
    await updater.handleAppResume();
    expect.soft(installedVersions).toEqual([]);
    await updater.downloadAndInstall();
    expect.soft(downloadedVersions).toEqual(["1.3.3", "1.4.0-rc.1"]);
    expect.soft(installedVersions).toEqual(["1.4.0-rc.1"]);
  });

  it("supports switching between stable and prerelease channels and persists dismissed version", async () => {
    const storage = createMemoryStorage();
    const plugin: BridgeUpdaterNativePlugin = {
      getAppInfo: vi.fn(async () => ({
        versionName: "1.3.2",
        versionCode: 2,
        packageName: "com.localbridge.mobile",
        canInstallPackages: true,
        arch: "arm64",
      })),
      fetchReleasesJson: vi.fn(async ({ etag }) => {
        if (etag === '"etag-v1"') return { status: 304, etag };
        return { status: 200, etag: '"etag-v1"', body: SAMPLE_RELEASES_JSON };
      }),
      downloadAndVerifyApk: vi.fn(),
      installStagedApk: vi.fn(),
      openExternalUrl: vi.fn(),
      addListener: vi.fn(),
    };

    const updater = new ClientUpdaterController({
      platform: "android",
      initialVersion: "1.3.2",
      plugin,
      storage,
    });

    await updater.check({ manual: false });
    expect(updater.getSnapshot().latestVersion).toBe("1.3.3");
    expect(updater.getSnapshot().promptOpen).toBe(true);

    updater.dismissPrompt();
    expect(updater.getSnapshot().promptOpen).toBe(false);

    // Second automatic check for same version stays dismissed
    await updater.check({ manual: false });
    expect(updater.getSnapshot().promptOpen).toBe(false);

    // Switching to prerelease selects 1.4.0-rc.1 and opens prompt
    updater.setChannel("prerelease");
    expect(updater.getSnapshot().latestVersion).toBe("1.4.0-rc.1");
    expect(updater.getSnapshot().promptOpen).toBe(true);
  });

  it("gracefully degrades on pure Web without network calls or errors", async () => {
    const openSpy = vi.fn();
    vi.stubGlobal("window", { open: openSpy });
    try {
      const updater = new ClientUpdaterController({
        platform: "web",
        initialVersion: "1.3.2",
      });
      expect(updater.getSnapshot().nativeSupported).toBe(false);
      expect(updater.getSnapshot().currentVersion).toBe("1.3.2");

      await updater.initializeStartup();
      await updater.check({ manual: true });
      expect(updater.getSnapshot().phase).toBe("idle");
      expect(updater.getSnapshot().error).toBeUndefined();

      await updater.openReleasesPage();
      expect(openSpy).toHaveBeenCalledWith(GITHUB_RELEASES_PAGE_URL, "_blank", "noopener,noreferrer");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
