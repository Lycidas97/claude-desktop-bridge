// Build this checkout as the macOS dogfood app and install it over /Applications/Bridge.app (docs/dogfood.md).
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") throw new Error("dogfood-install supports macOS only.");
const root = fileURLToPath(new URL("..", import.meta.url));
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const npm = (...args) => execFileSync("npm", args, { cwd: root, stdio: "inherit" });
const installed = "/Applications/Bridge.app";

if (spawnSync("pgrep", ["-f", `${installed}/Contents/MacOS/`]).status === 0) {
  throw new Error("Bridge is running. Quit it from the tray (停止后台服务并退出…) first.");
}

git("fetch", "origin", "--tags", "--quiet");
const tag = git("describe", "--tags", "--match", "v[0-9]*", "--abbrev=0", "HEAD");
const [major, minor, patch] = tag.slice(1).split(".").map(Number);
if (![major, minor, patch].every(Number.isInteger)) throw new Error(`Unexpected release tag ${tag}.`);
const commit = git("rev-parse", "HEAD");
const diag = git("status", "--porcelain") !== "";
const version = `${major}.${minor}.${patch + 1}-dev.${git("rev-list", "--count", `${tag}..HEAD`)}${diag ? ".diag" : ""}`;

const manifestPath = join(root, "apps/desktop/package.json");
const manifest = readFileSync(manifestPath, "utf8");
const signingHome = process.env.BRIDGE_LOCAL_SIGNING_HOME
  ?? join(homedir(), "Library/Application Support/Bridge/build-signing");
const packageScript = existsSync(join(signingHome, "identity-sha1")) ? "package:local-signed" : "package:adhoc";
writeFileSync(manifestPath, manifest.replace(/"version": "[^"]+"/u, `"version": "${version}"`));
try {
  npm("run", "build", "-w", "@bridge/protocol");
  npm("run", packageScript, "-w", "@bridge/desktop");
} finally {
  writeFileSync(manifestPath, manifest);
}

const built = join(root, `apps/desktop/out/Bridge-darwin-${process.arch}/Bridge.app`);
const builtVersion = execFileSync("plutil", ["-extract", "CFBundleShortVersionString", "raw", join(built, "Contents/Info.plist")], { encoding: "utf8" }).trim();
if (builtVersion !== version) throw new Error(`Built app reports ${builtVersion}, expected ${version}.`);

const previousRoot = join(homedir(), "Library/Application Support/Bridge-dogfood/previous");
const previous = join(previousRoot, "Bridge.app");
mkdirSync(previousRoot, { recursive: true });
if (existsSync(previous)) execFileSync("/usr/bin/trash", [previous]);
if (existsSync(installed)) renameSync(installed, previous);
execFileSync("/usr/bin/ditto", [built, installed]);
execFileSync("codesign", ["--verify", "--deep", "--strict", installed]);
execFileSync("open", [installed]);

const asar = createHash("sha256").update(readFileSync(join(installed, "Contents/Resources/app.asar"))).digest("hex");
console.log(JSON.stringify({ version, commit, diag, signing: packageScript, asarSha256: asar, previous }, null, 2));
