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
    assets: [],
  },
  {
    tag_name: "v1.3.5",
    name: "Bridge v1.3.5",
    draft: false,
    prerelease: false,
    html_url: "https://github.com/Lycidas97/claude-desktop-bridge/releases/tag/v1.3.5",
    body: "- Direct GitHub Releases jump",
    assets: [],
  },
]);

describe("ClientUpdaterController", () => {
  it("runs lightweight startup check on Android and opens the GitHub Release page in the system browser without in-app APK downloads", async () => {
    const openedUrls: string[] = [];
    const plugin: BridgeUpdaterNativePlugin = {
      getAppInfo: vi.fn(async () => ({
        versionName: "1.3.4",
        versionCode: 122,
        packageName: "com.localbridge.mobile",
        canInstallPackages: false,
        arch: "arm64",
      })),
      fetchReleasesJson: vi.fn(async () => ({
        status: 200,
        etag: '"etag-135"',
        body: SAMPLE_RELEASES_JSON,
      })),
      openExternalUrl: vi.fn(async ({ url }) => {
        openedUrls.push(url);
      }),
    };

    const storage = createMemoryStorage();
    const updater = new ClientUpdaterController({
      platform: "android",
      initialVersion: "1.3.4",
      plugin,
      storage,
    });

    await updater.initializeStartup();
    expect(updater.getSnapshot().phase).toBe("available");
    expect(updater.getSnapshot().latestVersion).toBe("1.3.5");
    expect(updater.getSnapshot().releaseNotes).toBe("- Direct GitHub Releases jump");
    expect(updater.getSnapshot().promptOpen).toBe(true);
    expect(plugin.fetchReleasesJson).toHaveBeenCalledOnce();

    await updater.openReleasesPage();
    expect(openedUrls).toEqual(["https://github.com/Lycidas97/claude-desktop-bridge/releases/tag/v1.3.5"]);

    // Non-https URLs safely fall back to GITHUB_RELEASES_PAGE_URL
    await updater.openReleasesPage("javascript:alert(1)");
    expect(openedUrls[1]).toBe(GITHUB_RELEASES_PAGE_URL);
  });

  it("supports switching between stable and prerelease channels with ETag caching and persists dismissed version", async () => {
    const storage = createMemoryStorage();
    const plugin: BridgeUpdaterNativePlugin = {
      getAppInfo: vi.fn(async () => ({
        versionName: "1.3.4",
        versionCode: 122,
        packageName: "com.localbridge.mobile",
        canInstallPackages: true,
        arch: "arm64",
      })),
      fetchReleasesJson: vi.fn(async ({ etag }) => {
        if (etag === '"etag-v1"') return { status: 304, etag };
        return { status: 200, etag: '"etag-v1"', body: SAMPLE_RELEASES_JSON };
      }),
      openExternalUrl: vi.fn(async () => {}),
    };

    const updater = new ClientUpdaterController({
      platform: "android",
      initialVersion: "1.3.4",
      plugin,
      storage,
    });

    await updater.check({ manual: false });
    expect(updater.getSnapshot().latestVersion).toBe("1.3.5");
    expect(updater.getSnapshot().promptOpen).toBe(true);

    updater.dismissPrompt();
    expect(updater.getSnapshot().promptOpen).toBe(false);

    // Second automatic check for same version stays dismissed
    await updater.check({ manual: false });
    expect(updater.getSnapshot().promptOpen).toBe(false);

    // Manual check re-opens prompt
    await updater.check({ manual: true });
    expect(updater.getSnapshot().promptOpen).toBe(true);
    updater.dismissPrompt();

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
        initialVersion: "1.3.5",
      });
      expect(updater.getSnapshot().nativeSupported).toBe(false);
      expect(updater.getSnapshot().currentVersion).toBe("1.3.5");

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

  it("defaults prerelease builds (-dev/-rc) to prerelease channel while respecting explicit user channel choices", async () => {
    const devUpdater = new ClientUpdaterController({
      platform: "web",
      initialVersion: "1.3.5-dev.27",
    });
    expect(devUpdater.getSnapshot().channel).toBe("prerelease");

    const stableUpdater = new ClientUpdaterController({
      platform: "web",
      initialVersion: "1.3.5",
    });
    expect(stableUpdater.getSnapshot().channel).toBe("stable");

    const storage = createMemoryStorage();
    const plugin: BridgeUpdaterNativePlugin = {
      getAppInfo: vi.fn(async () => ({
        versionName: "1.3.5-dev.27",
        versionCode: 123,
        packageName: "com.localbridge.mobile",
        canInstallPackages: true,
        arch: "arm64",
      })),
      fetchReleasesJson: vi.fn(async () => ({
        status: 200,
        etag: '"etag-dev"',
        body: SAMPLE_RELEASES_JSON,
      })),
      openExternalUrl: vi.fn(async () => {}),
    };
    const fallbackUpdater = new ClientUpdaterController({
      platform: "android",
      initialVersion: "0.0.0",
      plugin,
      storage,
    });
    expect(fallbackUpdater.getSnapshot().channel).toBe("stable");
    fallbackUpdater.setAutoCheck(true);
    expect(JSON.parse(storage.getItem("bridge.client.updater.v1")!)).not.toHaveProperty("channel");

    await fallbackUpdater.initializeStartup();
    expect(fallbackUpdater.getSnapshot().currentVersion).toBe("1.3.5-dev.27");
    expect(fallbackUpdater.getSnapshot().channel).toBe("prerelease");
    expect(fallbackUpdater.getSnapshot().latestVersion).toBe("1.4.0-rc.1");
    expect(JSON.parse(storage.getItem("bridge.client.updater.v1")!)).not.toHaveProperty("channel");

    fallbackUpdater.setChannel("prerelease");
    expect(JSON.parse(storage.getItem("bridge.client.updater.v1")!).channel).toBe("prerelease");

    fallbackUpdater.setChannel("stable");
    expect(fallbackUpdater.getSnapshot().channel).toBe("stable");
    expect(JSON.parse(storage.getItem("bridge.client.updater.v1")!).channel).toBe("stable");

    const reloadedDevUpdater = new ClientUpdaterController({
      platform: "android",
      initialVersion: "1.3.5-dev.27",
      plugin,
      storage,
    });
    expect(reloadedDevUpdater.getSnapshot().channel).toBe("stable");
    await reloadedDevUpdater.initializeStartup();
    expect(reloadedDevUpdater.getSnapshot().channel).toBe("stable");
    expect(reloadedDevUpdater.getSnapshot().latestVersion).toBe("1.3.5");
  });
});
