import { describe, expect, it } from "vitest";
import {
  compareVersions,
  normalizeVersionTag,
  parseGitHubReleases,
  parseSemver,
  parseSha256Sums,
  parseSystemUpdateParams,
  selectLatestRelease,
  selectReleaseAsset,
} from "./updater.js";

const SAMPLE_GITHUB_RELEASES = [
  {
    tag_name: "v1.3.3-rc.2",
    name: "Bridge v1.3.3-rc.2",
    draft: false,
    prerelease: true,
    html_url: "https://github.com/Lycidas97/claude-desktop-bridge/releases/tag/v1.3.3-rc.2",
    body: "- RC changelog",
    assets: [
      {
        name: "Bridge-1.3.3-rc.2-android-debug.apk",
        browser_download_url: "https://github.com/Lycidas97/claude-desktop-bridge/releases/download/v1.3.3-rc.2/Bridge-1.3.3-rc.2-android-debug.apk",
        size: 11_500_000,
        digest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
        state: "uploaded",
      },
    ],
  },
  {
    tag_name: "v1.3.2",
    name: "Bridge v1.3.2",
    draft: false,
    prerelease: false,
    html_url: "https://github.com/Lycidas97/claude-desktop-bridge/releases/tag/v1.3.2",
    body: "- Stable release notes",
    assets: [
      {
        name: "Bridge-1.3.2-android-debug.apk",
        browser_download_url: "https://github.com/Lycidas97/claude-desktop-bridge/releases/download/v1.3.2/Bridge-1.3.2-android-debug.apk",
        size: 11_420_480,
        digest: "sha256:dcc4b9729d509f5c5aebd1d377b707b7b80cc893cd5f865c172cae8f2659264b",
        state: "uploaded",
      },
      {
        name: "Bridge-1.3.2-windows-installer-ci.zip",
        browser_download_url: "https://github.com/Lycidas97/claude-desktop-bridge/releases/download/v1.3.2/Bridge-1.3.2-windows-installer-ci.zip",
        size: 202_897_020,
        digest: "sha256:2c8c35f6384097ff40a0623592dcfe48f0526c31c52fb4e172f9fda4f48dea9b",
        state: "uploaded",
      },
      {
        name: "Bridge-1.3.2-macos-adhoc.zip",
        browser_download_url: "https://github.com/Lycidas97/claude-desktop-bridge/releases/download/v1.3.2/Bridge-1.3.2-macos-adhoc.zip",
        size: 233_785_574,
        digest: "sha256:5137144077e3687ac4f44bfb3efddbb9c4b333848488811b02e8373f8b33060f",
        state: "uploaded",
      },
      {
        name: "Bridge-1.3.2-linux-installers-ci.zip",
        browser_download_url: "https://github.com/Lycidas97/claude-desktop-bridge/releases/download/v1.3.2/Bridge-1.3.2-linux-installers-ci.zip",
        size: 344_467_339,
        digest: "sha256:fab834754226906eba8f1758d29786dc13f3654b45cc6df7aa94a5c0a645226f",
        state: "uploaded",
      },
      {
        name: "SHA256SUMS.txt",
        browser_download_url: "https://github.com/Lycidas97/claude-desktop-bridge/releases/download/v1.3.2/SHA256SUMS.txt",
        size: 599,
        state: "uploaded",
      },
    ],
  },
  {
    tag_name: "v1.4.0",
    name: "Draft v1.4.0",
    draft: true,
    prerelease: false,
    html_url: "https://github.com/Lycidas97/claude-desktop-bridge/releases/tag/v1.4.0",
    body: "Unpublished draft",
    assets: [],
  },
  {
    tag_name: "build-v39",
    name: "Legacy non-semver tag",
    draft: false,
    prerelease: false,
    html_url: "https://github.com/Lycidas97/claude-desktop-bridge/releases/tag/build-v39",
    body: "Legacy",
    assets: [],
  },
];

describe("updater protocol helpers", () => {
  it("selects the Linux wrapper for ZIP installs without selecting an iOS archive", () => {
    const [release] = parseGitHubReleases([{
      tag_name: "v1.3.3", assets: [
        "Bridge-1.3.3-ios-device-unsigned.zip", "Bridge-1.3.3-linux-installers-ci.zip",
      ].map(name => ({ name, browser_download_url: `https://github.com/fixture/${name}`, size: 100 })),
    }]);
    expect(selectReleaseAsset(release!, { platform: "linux", arch: "x64", linuxPackageFormat: "zip" })).toMatchObject({
      asset: { name: "Bridge-1.3.3-linux-installers-ci.zip" }, wrapperZip: true, innerExtension: ".zip",
    });
  });
  it("parses and compares semantic versions including prerelease tags", () => {
    expect(parseSemver("v1.3.2")).toEqual({ major: 1, minor: 3, patch: 2, prerelease: [] });
    expect(normalizeVersionTag("v1.3.3-rc.2+sha.abc")).toBe("1.3.3-rc.2");
    expect(parseSemver("build-v39")).toBeUndefined();
    expect(parseSemver("1.02.3")).toBeUndefined();

    expect(compareVersions("1.3.2", "1.3.1")).toBeGreaterThan(0);
    expect(compareVersions("1.3.2", "v1.3.2")).toBe(0);
    expect(compareVersions("1.3.3", "1.3.3-rc.10")).toBeGreaterThan(0);
    expect(compareVersions("1.3.3-rc.10", "1.3.3-rc.2")).toBeGreaterThan(0);
    expect(compareVersions("1.3.2", "1.3.3-rc.1")).toBeLessThan(0);
  });

  it("filters drafts and non-semver tags and respects stable vs prerelease channels", () => {
    const releases = parseGitHubReleases(SAMPLE_GITHUB_RELEASES);
    expect(releases.map((item) => item.version)).toEqual(["1.3.3-rc.2", "1.3.2"]);

    const stableFromOlder = selectLatestRelease(releases, {
      channel: "stable",
      currentVersion: "1.3.1",
    });
    expect(stableFromOlder.updateAvailable).toBe(true);
    expect(stableFromOlder.latest?.version).toBe("1.3.2");

    const stableUpToDate = selectLatestRelease(releases, {
      channel: "stable",
      currentVersion: "1.3.2",
    });
    expect(stableUpToDate.updateAvailable).toBe(false);
    expect(stableUpToDate.latest?.version).toBe("1.3.2");

    const prereleaseChannel = selectLatestRelease(releases, {
      channel: "prerelease",
      currentVersion: "1.3.2",
    });
    expect(prereleaseChannel.updateAvailable).toBe(true);
    expect(prereleaseChannel.latest?.version).toBe("1.3.3-rc.2");
  });

  it.each([
    {
      platform: "win32" as const,
      arch: "x64",
      expectedName: "Bridge-1.3.2-windows-installer-ci.zip",
      wrapperZip: true,
      innerExtension: ".exe",
    },
    {
      platform: "win32" as const,
      arch: "arm64",
      expectedName: undefined,
      wrapperZip: false,
      innerExtension: undefined,
    },
    {
      platform: "darwin" as const,
      arch: "arm64",
      expectedName: "Bridge-1.3.2-macos-adhoc.zip",
      wrapperZip: true,
      innerExtension: ".dmg",
    },
    {
      platform: "darwin" as const,
      arch: "x64",
      expectedName: undefined,
      wrapperZip: false,
      innerExtension: undefined,
    },
    {
      platform: "linux" as const,
      arch: "x64",
      expectedName: "Bridge-1.3.2-linux-installers-ci.zip",
      wrapperZip: true,
      innerExtension: ".deb",
    },
    {
      platform: "android" as const,
      arch: "arm64",
      expectedName: "Bridge-1.3.2-android-debug.apk",
      wrapperZip: false,
      innerExtension: undefined,
    },
  ])("matches release assets explicitly for $platform ($arch)", ({ platform, arch, expectedName, wrapperZip, innerExtension }) => {
    const releases = parseGitHubReleases(SAMPLE_GITHUB_RELEASES);
    const stable = releases.find((item) => item.version === "1.3.2")!;
    const matched = selectReleaseAsset(stable, { platform, arch });
    if (!expectedName) {
      expect(matched).toBeUndefined();
      return;
    }
    expect(matched?.asset.name).toBe(expectedName);
    expect(matched?.wrapperZip).toBe(wrapperZip);
    expect(matched?.innerExtension).toBe(innerExtension);
    expect(matched?.asset.sha256).toHaveLength(64);
  });

  it("prefers direct installers when uploaded alongside wrapper zips", () => {
    const [release] = parseGitHubReleases([
      {
        tag_name: "v1.3.4",
        prerelease: false,
        html_url: "https://github.com/Lycidas97/claude-desktop-bridge/releases/tag/v1.3.4",
        body: "",
        assets: [
          {
            name: "Bridge-1.3.4-Setup.exe",
            browser_download_url: "https://github.com/Lycidas97/claude-desktop-bridge/releases/download/v1.3.4/Bridge-1.3.4-Setup.exe",
            size: 100_000_000,
            digest: `sha256:${"a".repeat(64)}`,
          },
          {
            name: "Bridge-1.3.4-windows-installer-ci.zip",
            browser_download_url: "https://github.com/Lycidas97/claude-desktop-bridge/releases/download/v1.3.4/Bridge-1.3.4-windows-installer-ci.zip",
            size: 100_100_000,
          },
        ],
      },
    ]);
    const matched = selectReleaseAsset(release!, { platform: "win32", arch: "x64" });
    expect(matched).toEqual({
      asset: {
        name: "Bridge-1.3.4-Setup.exe",
        downloadUrl: "https://github.com/Lycidas97/claude-desktop-bridge/releases/download/v1.3.4/Bridge-1.3.4-Setup.exe",
        size: 100_000_000,
        sha256: "a".repeat(64),
      },
      wrapperZip: false,
    });
  });

  it("parses SHA256SUMS.txt and validates system.update RPC inputs", () => {
    const sums = parseSha256Sums(
      `${"b".repeat(64)}  Bridge-1.3.2-android-debug.apk\n${"c".repeat(64)} *./Bridge-1.3.2-windows-installer-ci.zip\n`,
    );
    expect(sums.get("Bridge-1.3.2-android-debug.apk")).toBe("b".repeat(64));
    expect(sums.get("Bridge-1.3.2-windows-installer-ci.zip")).toBe("c".repeat(64));

    expect(
      parseSystemUpdateParams({
        action: "configure",
        channel: "prerelease",
        autoCheck: true,
        applyMode: "silent-idle",
      }),
    ).toEqual({
      action: "configure",
      channel: "prerelease",
      autoCheck: true,
      applyMode: "silent-idle",
    });

    expect(() => parseSystemUpdateParams({ action: "exec" })).toThrow("Invalid system.update action");
    expect(() => parseSystemUpdateParams({ action: "configure", channel: "nightly" })).toThrow("Invalid update channel");
  });
});
