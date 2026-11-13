export const DEFAULT_GITHUB_RELEASES_URL =
  "https://api.github.com/repos/Lycidas97/claude-desktop-bridge/releases";
export const DEFAULT_GITHUB_RELEASES_PAGE_URL =
  "https://github.com/Lycidas97/claude-desktop-bridge/releases";

export type BridgeUpdateChannel = "stable" | "prerelease";
export type BridgeUpdateApplyMode = "prompt" | "silent-idle";
export type BridgeUpdaterPhase =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "ready"
  | "applying"
  | "error";
export type BridgeUpdaterPlatform = "win32" | "darwin" | "linux" | "android" | "web";

export interface BridgeReleaseAsset {
  name: string;
  downloadUrl: string;
  size: number;
  sha256?: string;
}

export interface BridgeReleaseInfo {
  tagName: string;
  version: string;
  name: string;
  prerelease: boolean;
  publishedAt?: string;
  htmlUrl: string;
  body: string;
  assets: BridgeReleaseAsset[];
}

export interface BridgeMatchedAsset {
  asset: BridgeReleaseAsset;
  /** True when the outer asset is a CI wrapper ZIP containing the inner installer. */
  wrapperZip: boolean;
  /** Expected inner file extension when `wrapperZip` is true (e.g. `.exe`, `.dmg`, `.deb`). */
  innerExtension?: ".exe" | ".dmg" | ".deb" | ".rpm" | ".zip";
}

export interface BridgeUpdaterSnapshot {
  platform: BridgeUpdaterPlatform;
  arch: string;
  currentVersion: string;
  channel: BridgeUpdateChannel;
  autoCheck: boolean;
  applyMode: BridgeUpdateApplyMode;
  canAutoRestart: boolean;
  phase: BridgeUpdaterPhase;
  checkedAt?: number;
  latestVersion?: string;
  latestTag?: string;
  prerelease?: boolean;
  releaseUrl?: string;
  releaseNotes?: string;
  assetName?: string;
  downloadedBytes?: number;
  totalBytes?: number;
  integrityVerified?: "sha256" | "size";
  stagedPath?: string;
  waitingForIdle?: boolean;
  statusDetail?: string;
  error?: string;
}

export type BridgeSystemUpdateAction = "status" | "check" | "download" | "apply" | "configure";

export interface BridgeSystemUpdateParams {
  action: BridgeSystemUpdateAction;
  channel?: BridgeUpdateChannel;
  autoCheck?: boolean;
  applyMode?: BridgeUpdateApplyMode;
}

export interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: Array<number | string>;
}

const SEMVER_PATTERN = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u;

export function parseSemver(input: string): ParsedSemver | undefined {
  const match = SEMVER_PATTERN.exec(input.trim());
  if (!match) return undefined;
  const prereleaseRaw = match[4];
  const prerelease: Array<number | string> = [];
  if (prereleaseRaw !== undefined) {
    for (const part of prereleaseRaw.split(".")) {
      if (!part) return undefined;
      if (/^\d+$/u.test(part)) {
        if (part.length > 1 && part.startsWith("0")) return undefined;
        prerelease.push(Number(part));
      } else {
        prerelease.push(part);
      }
    }
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
  };
}

export function normalizeVersionTag(tagOrVersion: string): string | undefined {
  const parsed = parseSemver(tagOrVersion);
  if (!parsed) return undefined;
  const base = `${parsed.major}.${parsed.minor}.${parsed.patch}`;
  return parsed.prerelease.length > 0 ? `${base}-${parsed.prerelease.join(".")}` : base;
}

export function compareVersions(left: string, right: string): number {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) throw new Error(`Invalid semantic version comparison: ${left} vs ${right}`);
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const limit = Math.min(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < limit; index += 1) {
    const leftId = a.prerelease[index]!;
    const rightId = b.prerelease[index]!;
    if (leftId === rightId) continue;
    if (typeof leftId === "number" && typeof rightId === "number") return leftId - rightId;
    if (typeof leftId === "number") return -1;
    if (typeof rightId === "number") return 1;
    return leftId < rightId ? -1 : 1;
  }
  return a.prerelease.length - b.prerelease.length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAssetSha256(digest: unknown): string | undefined {
  if (typeof digest !== "string") return undefined;
  const match = /^sha256:([0-9a-f]{64})$/iu.exec(digest.trim());
  return match ? match[1]!.toLowerCase() : undefined;
}

export function parseSha256Sums(content: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/iu.exec(line);
    if (!match) continue;
    const fileName = match[2]!.trim().replace(/^\.\//u, "");
    if (fileName) map.set(fileName, match[1]!.toLowerCase());
  }
  return map;
}

export function parseGitHubReleases(payload: unknown): BridgeReleaseInfo[] {
  const entries = Array.isArray(payload) ? payload : isRecord(payload) ? [payload] : [];
  const releases: BridgeReleaseInfo[] = [];
  for (const entry of entries) {
    if (!isRecord(entry) || entry.draft === true) continue;
    if (typeof entry.tag_name !== "string") continue;
    const version = normalizeVersionTag(entry.tag_name);
    const parsed = version ? parseSemver(version) : undefined;
    if (!version || !parsed) continue;
    const htmlUrl = typeof entry.html_url === "string" && entry.html_url.startsWith("https://")
      ? entry.html_url
      : DEFAULT_GITHUB_RELEASES_PAGE_URL;
    const assetsRaw = Array.isArray(entry.assets) ? entry.assets : [];
    const assets: BridgeReleaseAsset[] = [];
    for (const candidate of assetsRaw) {
      if (!isRecord(candidate)) continue;
      const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
      const downloadUrl = typeof candidate.browser_download_url === "string"
        ? candidate.browser_download_url.trim()
        : typeof candidate.url === "string"
          ? candidate.url.trim()
          : "";
      const size = typeof candidate.size === "number" && Number.isFinite(candidate.size) && candidate.size >= 0
        ? candidate.size
        : -1;
      if (!name || !downloadUrl.startsWith("https://") || size < 0) continue;
      if (candidate.state !== undefined && candidate.state !== "uploaded") continue;
      const sha256 = parseAssetSha256(candidate.digest);
      assets.push({
        name,
        downloadUrl,
        size,
        ...(sha256 ? { sha256 } : {}),
      });
    }
    releases.push({
      tagName: entry.tag_name.trim(),
      version,
      name: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : entry.tag_name.trim(),
      prerelease: entry.prerelease === true || parsed.prerelease.length > 0,
      ...(typeof entry.published_at === "string" ? { publishedAt: entry.published_at } : {}),
      htmlUrl,
      body: typeof entry.body === "string" ? entry.body.trim() : "",
      assets,
    });
  }
  return releases.sort((left, right) => compareVersions(right.version, left.version));
}

export function selectLatestRelease(
  releases: readonly BridgeReleaseInfo[],
  options: { channel: BridgeUpdateChannel; currentVersion: string },
): { latest?: BridgeReleaseInfo; updateAvailable: boolean } {
  const candidates = options.channel === "stable"
    ? releases.filter((release) => !release.prerelease)
    : [...releases];
  if (candidates.length === 0) return { updateAvailable: false };
  const sorted = [...candidates].sort((left, right) => compareVersions(right.version, left.version));
  const latest = sorted[0]!;
  if (!parseSemver(options.currentVersion)) {
    return { latest, updateAvailable: false };
  }
  return {
    latest,
    updateAvailable: compareVersions(latest.version, options.currentVersion) > 0,
  };
}

function matchesArchToken(fileName: string, arch: string): boolean {
  const lower = fileName.toLowerCase();
  const hasX64 = /(?:^|[-_.])(x64|amd64|x86_64)(?:[-_.]|$)/u.test(lower);
  const hasArm64 = /(?:^|[-_.])(arm64|aarch64)(?:[-_.]|$)/u.test(lower);
  if (arch === "x64") return hasX64 || !hasArm64;
  if (arch === "arm64") return hasArm64 || !hasX64;
  return false;
}

export function selectReleaseAsset(
  release: BridgeReleaseInfo,
  target: {
    platform: BridgeUpdaterPlatform;
    arch: string;
    linuxPackageFormat?: "deb" | "rpm" | "zip";
  },
): BridgeMatchedAsset | undefined {
  const { platform, arch } = target;
  if (platform === "android") {
    const apk = release.assets.find((asset) => /android.*\.apk$/iu.test(asset.name))
      ?? release.assets.find((asset) => /\.apk$/iu.test(asset.name));
    return apk ? { asset: apk, wrapperZip: false } : undefined;
  }

  if (platform === "win32") {
    const directExe = release.assets.find(
      (asset) => /\.exe$/iu.test(asset.name) && /setup/iu.test(asset.name) && matchesArchToken(asset.name, arch),
    );
    if (directExe) return { asset: directExe, wrapperZip: false };
    if (arch === "x64") {
      const wrapper = release.assets.find(
        (asset) => /windows-installer.*\.zip$/iu.test(asset.name) && matchesArchToken(asset.name, arch),
      );
      if (wrapper) return { asset: wrapper, wrapperZip: true, innerExtension: ".exe" };
    }
    return undefined;
  }

  if (platform === "darwin") {
    const directDmg = release.assets.find(
      (asset) => /\.dmg$/iu.test(asset.name) && matchesArchToken(asset.name, arch),
    );
    if (directDmg) return { asset: directDmg, wrapperZip: false };
    const explicitArchWrapper = release.assets.find(
      (asset) => /macos.*\.zip$/iu.test(asset.name)
        && /(?:^|[-_.])(x64|amd64|x86_64|arm64|aarch64)(?:[-_.]|$)/iu.test(asset.name)
        && matchesArchToken(asset.name, arch),
    );
    if (explicitArchWrapper) return { asset: explicitArchWrapper, wrapperZip: true, innerExtension: ".dmg" };
    // `release-assets.yml` builds `Bridge-<ver>-macos-adhoc.zip` on `macos-15` (Apple Silicon arm64).
    if (arch === "arm64") {
      const adhocWrapper = release.assets.find((asset) => /macos-adhoc\.zip$/iu.test(asset.name));
      if (adhocWrapper) return { asset: adhocWrapper, wrapperZip: true, innerExtension: ".dmg" };
    }
    return undefined;
  }

  if (platform === "linux") {
    const preferredExt = target.linuxPackageFormat ? `.${target.linuxPackageFormat}` as const : ".deb" as const;
    const directPkg = release.assets.find(
      (asset) => asset.name.toLowerCase().endsWith(preferredExt)
        && matchesArchToken(asset.name, arch)
        && (preferredExt !== ".zip" || (/linux/iu.test(asset.name) && !/linux-installers/iu.test(asset.name))),
    ) ?? release.assets.find(
      (asset) => /\.(?:deb|rpm)$/iu.test(asset.name) && matchesArchToken(asset.name, arch),
    );
    if (directPkg) return { asset: directPkg, wrapperZip: false };
    if (arch === "x64") {
      const wrapper = release.assets.find(
        (asset) => /linux-installers.*\.zip$/iu.test(asset.name) && matchesArchToken(asset.name, arch),
      );
      if (wrapper) return { asset: wrapper, wrapperZip: true, innerExtension: preferredExt };
    }
    return undefined;
  }

  return undefined;
}

export function parseSystemUpdateParams(params: Record<string, unknown>): BridgeSystemUpdateParams {
  const action = params.action;
  if (
    action !== "status" &&
    action !== "check" &&
    action !== "download" &&
    action !== "apply" &&
    action !== "configure"
  ) {
    throw new Error("Invalid system.update action");
  }
  const result: BridgeSystemUpdateParams = { action };
  if (params.channel !== undefined) {
    if (params.channel !== "stable" && params.channel !== "prerelease") {
      throw new Error("Invalid update channel");
    }
    result.channel = params.channel;
  }
  if (params.autoCheck !== undefined) {
    if (typeof params.autoCheck !== "boolean") throw new Error("autoCheck must be a boolean");
    result.autoCheck = params.autoCheck;
  }
  if (params.applyMode !== undefined) {
    if (params.applyMode !== "prompt" && params.applyMode !== "silent-idle") {
      throw new Error("Invalid update applyMode");
    }
    result.applyMode = params.applyMode;
  }
  return result;
}
