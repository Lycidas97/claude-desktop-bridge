import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { transpileModule } from "typescript";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm as recycle, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_GITHUB_RELEASES_PAGE_URL } from "@bridge/protocol";
import { DesktopController } from "../controller/controller.js";
import {
  DesktopUpdater,
  type DesktopUpdaterPlatform,
} from "./desktop-updater.js";

createRequire(import.meta.url)("../../../../scripts/recycle-cleanup.cjs");

describe("DesktopUpdater lightweight version checker & browser jump", () => {
  const tempDirs: string[] = [];
  const servers: Server[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    for (const directory of tempDirs.splice(0)) {
      await recycle(directory, { recursive: true, force: true });
    }
  });

  async function makeTempDir(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "bridge-updater-test-"));
    tempDirs.push(directory);
    return directory;
  }

  it.each([
    {
      platform: "win32" as DesktopUpdaterPlatform,
      arch: "x64",
      assetName: "Bridge-1.3.5-windows-installer-ci.zip",
    },
    {
      platform: "darwin" as DesktopUpdaterPlatform,
      arch: "arm64",
      assetName: "Bridge-1.3.5-macos-adhoc.zip",
    },
    {
      platform: "linux" as DesktopUpdaterPlatform,
      arch: "x64",
      assetName: "Bridge-1.3.5-linux-installers-ci.zip",
    },
  ])(
    "checks GitHub Releases with ETag 304 caching and opens release URL only for desktop origin on $platform ($arch)",
    async ({ platform, arch, assetName }) => {
      const dir = await makeTempDir();
      const releaseUrl = "https://github.com/Lycidas97/claude-desktop-bridge/releases/tag/v1.3.5";

      let etagChecks = 0;
      let assetDownloadRequests = 0;
      const server = createServer((req, res) => {
        if (req.url?.startsWith("/releases")) {
          if (req.headers["if-none-match"] === '"v135-etag"') {
            etagChecks += 1;
            res.writeHead(304);
            res.end();
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json", ETag: '"v135-etag"' });
          res.end(
            JSON.stringify([
              {
                tag_name: "v1.3.5",
                name: "Bridge v1.3.5",
                draft: false,
                prerelease: false,
                html_url: releaseUrl,
                body: "- Lightweight browser-jump updater",
                assets: [
                  {
                    name: assetName,
                    browser_download_url: `https://updates.example.test/download/${assetName}`,
                    size: 4096,
                    state: "uploaded",
                  },
                ],
              },
            ]),
          );
          return;
        }
        assetDownloadRequests += 1;
        res.writeHead(404);
        res.end();
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      servers.push(server);
      const port = (server.address() as { port: number }).port;

      const openedUrls: string[] = [];
      const updater = new DesktopUpdater({
        platform,
        arch,
        currentVersion: "1.3.4",
        userDataPath: dir,
        feedUrl: `http://127.0.0.1:${port}/releases`,
        autoCheckAllowed: false,
        openExternalUrl: async (url) => {
          openedUrls.push(url);
        },
        onChanged: () => {},
      });

      await updater.initialize();
      expect(updater.snapshot().canAutoRestart).toBe(false);
      expect(updater.snapshot().applyMode).toBe("prompt");

      const checked = await updater.handleRpc({ action: "check" }, "desktop");
      expect(checked.phase).toBe("available");
      expect(checked.latestVersion).toBe("1.3.5");
      expect(checked.releaseUrl).toBe(releaseUrl);
      expect(checked.releaseNotes).toBe("- Lightweight browser-jump updater");
      expect(checked.assetName).toBe(assetName);
      expect(checked.stagedPath).toBeUndefined();
      expect(checked.downloadedBytes).toBeUndefined();

      // Verify ETag 304 caching on repeat check and zero in-app binary downloads
      await updater.handleRpc({ action: "check" }, "desktop");
      expect(etagChecks).toBe(1);
      expect(assetDownloadRequests).toBe(0);

      // Mobile origin download/apply never opens browser on desktop or downloads installers
      await updater.handleRpc({ action: "download" }, "mobile");
      await updater.handleRpc({ action: "apply" }, "mobile");
      expect(openedUrls).toEqual([]);
      expect(assetDownloadRequests).toBe(0);

      // Desktop origin backward-compatible download/apply opens release page in system browser
      await updater.handleRpc({ action: "download" }, "desktop");
      await updater.handleRpc({ action: "apply" }, "desktop");
      expect(openedUrls).toEqual([releaseUrl, releaseUrl]);

      updater.close();
    },
  );

  it("re-evaluates cachedReleases on configure channel change and falls back to default GitHub Releases URL when idle check fails", async () => {
    const dir = await makeTempDir();
    const openedUrls: string[] = [];
    let online = true;
    const updater = new DesktopUpdater({
      platform: "darwin",
      arch: "arm64",
      currentVersion: "1.3.5",
      userDataPath: dir,
      autoCheckAllowed: false,
      openExternalUrl: async (url) => {
        openedUrls.push(url);
      },
      onChanged: () => {},
      fetchImpl: vi.fn(async () => {
        if (!online) throw new Error("network down");
        return Response.json([
          {
            tag_name: "v1.3.6-rc.1",
            prerelease: true,
            html_url: "https://github.com/Lycidas97/claude-desktop-bridge/releases/tag/v1.3.6-rc.1",
            body: "RC notes",
            assets: [],
          },
          {
            tag_name: "v1.3.5",
            prerelease: false,
            html_url: "https://github.com/Lycidas97/claude-desktop-bridge/releases/tag/v1.3.5",
            body: "Stable notes",
            assets: [],
          },
        ]);
      }),
    });

    await updater.initialize();
    const stableSnap = await updater.handleRpc({ action: "check" }, "desktop");
    expect(stableSnap.phase).toBe("up-to-date");

    // Re-evaluates cachedReleases immediately without another fetch when switching channel via configure
    const preSnap = await updater.handleRpc({ action: "configure", channel: "prerelease", autoCheck: false }, "desktop");
    expect(preSnap.phase).toBe("available");
    expect(preSnap.latestVersion).toBe("1.3.6-rc.1");
    expect(preSnap.autoCheck).toBe(false);

    // Offline error state still opens DEFAULT_GITHUB_RELEASES_PAGE_URL on desktop apply when no release was cached
    const offlineDir = await makeTempDir();
    online = false;
    const offlineUpdater = new DesktopUpdater({
      platform: "darwin",
      arch: "arm64",
      currentVersion: "1.3.5",
      userDataPath: offlineDir,
      autoCheckAllowed: false,
      openExternalUrl: async (url) => {
        openedUrls.push(url);
      },
      onChanged: () => {},
      fetchImpl: vi.fn(async () => {
        throw new Error("offline");
      }),
    });
    await offlineUpdater.initialize();
    const errSnap = await offlineUpdater.handleRpc({ action: "apply" }, "desktop");
    expect(errSnap.phase).toBe("error");
    expect(errSnap.error).toContain("offline");
    expect(openedUrls).toEqual([DEFAULT_GITHUB_RELEASES_PAGE_URL]);

    updater.close();
    offlineUpdater.close();
  });

  it("passes real dispatcher responses to the App updater callback and packaged QA", async () => {
    const updater = new DesktopUpdater({
      platform: "win32",
      arch: "x64",
      currentVersion: "1.3.5",
      userDataPath: await makeTempDir(),
      autoCheckAllowed: false,
      onChanged: () => {},
    });
    await updater.initialize();
    const controller: DesktopController = Object.assign(Object.create(DesktopController.prototype), {
      updater,
      publish: async () => {},
    });
    const appSource = await readFile(new URL("../../../client/src/App.tsx", import.meta.url), "utf8");
    const callback = appSource.match(/const invokeRemoteUpdate = useCallback\((async [\s\S]*?), \[request\]\);/u);
    expect(callback).not.toBeNull();
    const invoke = new Function("request", `${transpileModule(`const invoke = ${callback![1]};`, {}).outputText}\nreturn invoke;`)(
      (_method: string, params: Record<string, unknown>) => controller.dispatchLocal({ method: "system.update", params }),
    );
    const remoteStatus = await invoke({ action: "status" });
    expect(remoteStatus.phase).toBe("idle");
    expect(remoteStatus.currentVersion).toBe("1.3.5");
    expect(remoteStatus.canAutoRestart).toBe(false);

    const qaSource = await readFile(new URL("../../../../scripts/packaged-desktop-qa.mjs", import.meta.url), "utf8");
    const qaBlock = qaSource.slice(qaSource.indexOf("  const updaterStatus ="), qaSource.indexOf('  for (const method of ["provider.list"'));
    expect(qaBlock).toContain("updaterStatus.result.currentVersion");
    const ipcProof: Record<string, unknown> = {};
    await new (Object.getPrototypeOf(async function () {}).constructor)("page", "assert", "desktopPackage", "ipcProof", qaBlock)(
      {
        evaluate: (body: () => unknown) => runInNewContext(`(${body.toString()})()`, {
          window: { bridgeDesktop: { request: (input: Parameters<DesktopController["dispatchLocal"]>[0]) => controller.dispatchLocal(input) } },
        }),
      },
      assert,
      { version: "1.3.5" },
      ipcProof,
    );
    expect(ipcProof["system.update"]).toBe("idle");
    updater.close();
  });

  it("preserves Object.create(DesktopController.prototype) safety when updater is absent", async () => {
    const bareController = Object.create(DesktopController.prototype) as DesktopController;
    const response = await bareController.dispatchLocal({
      method: "system.update",
      params: { action: "status" },
    });
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe("UNSUPPORTED");
  });

  it("defaults unconfigured prerelease builds to prerelease channel while respecting release defaults and explicit saved stable channel", async () => {
    const baseOptions = (userDataPath: string, currentVersion: string) => ({
      platform: "darwin" as const,
      arch: "arm64",
      currentVersion,
      userDataPath,
      autoCheckAllowed: false,
      onChanged: () => {},
      fetchImpl: vi.fn(async () => Response.json([
        {
          tag_name: "1.3.5-dev.27",
          prerelease: true,
          html_url: "https://github.com/Lycidas97/claude-desktop-bridge/releases/tag/1.3.5-dev.27",
          assets: [{ name: "Bridge-1.3.5-dev.27-arm64.dmg", size: 128, browser_download_url: "https://github.com/fixture/dev27.dmg" }],
        },
        {
          tag_name: "v1.3.4",
          prerelease: false,
          html_url: "https://github.com/Lycidas97/claude-desktop-bridge/releases/tag/v1.3.4",
          assets: [{ name: "Bridge-1.3.4-arm64.dmg", size: 128, browser_download_url: "https://github.com/fixture/134.dmg" }],
        },
      ])),
    });

    // (a) Unconfigured prerelease build defaults to "prerelease" (including when updater-v1.json lacks channel)
    const prereleaseDir = await makeTempDir();
    const prereleaseUpdater = new DesktopUpdater(baseOptions(prereleaseDir, "1.3.5-dev.23"));
    expect(prereleaseUpdater.snapshot().channel).toBe("prerelease");
    await prereleaseUpdater.initialize();
    expect(prereleaseUpdater.snapshot().channel).toBe("prerelease");
    const checkedPrerelease = await prereleaseUpdater.handleRpc({ action: "check" }, "desktop");
    expect(checkedPrerelease.channel).toBe("prerelease");
    expect(checkedPrerelease.phase).toBe("available");
    expect(checkedPrerelease.latestVersion).toBe("1.3.5-dev.27");
    prereleaseUpdater.close();

    // Upgrading that same userDataPath from 1.3.5-dev.23 to 1.3.5 without an explicit channel choice switches cleanly to "stable"
    const upgradedRelease = new DesktopUpdater(baseOptions(prereleaseDir, "1.3.5"));
    await upgradedRelease.initialize();
    expect(upgradedRelease.snapshot().channel).toBe("stable");
    upgradedRelease.close();

    const partialPrefsDir = await makeTempDir();
    await writeFile(join(partialPrefsDir, "updater-v1.json"), JSON.stringify({ version: 1, autoCheck: false }));
    const partialPrerelease = new DesktopUpdater(baseOptions(partialPrefsDir, "1.3.5-dev.23"));
    await partialPrerelease.initialize();
    expect(partialPrerelease.snapshot().channel).toBe("prerelease");
    partialPrerelease.close();

    // (b) Unconfigured release build defaults to "stable"
    const releaseDir = await makeTempDir();
    const releaseUpdater = new DesktopUpdater(baseOptions(releaseDir, "1.3.5"));
    expect(releaseUpdater.snapshot().channel).toBe("stable");
    await releaseUpdater.initialize();
    expect(releaseUpdater.snapshot().channel).toBe("stable");
    const checkedRelease = await releaseUpdater.handleRpc({ action: "check" }, "desktop");
    expect(checkedRelease.channel).toBe("stable");
    expect(checkedRelease.phase).toBe("up-to-date");
    releaseUpdater.close();

    // (c) Explicit saved "stable" on a prerelease build is respected
    const explicitStableDir = await makeTempDir();
    await writeFile(
      join(explicitStableDir, "updater-v1.json"),
      JSON.stringify({ version: 1, channel: "stable", autoCheck: true, applyMode: "prompt" }),
    );
    const explicitStableUpdater = new DesktopUpdater(baseOptions(explicitStableDir, "1.3.5-dev.23"));
    await explicitStableUpdater.initialize();
    expect(explicitStableUpdater.snapshot().channel).toBe("stable");
    const checkedExplicitStable = await explicitStableUpdater.handleRpc({ action: "check" }, "desktop");
    expect(checkedExplicitStable.channel).toBe("stable");
    expect(checkedExplicitStable.phase).toBe("up-to-date");
    explicitStableUpdater.close();
  });
});
