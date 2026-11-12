import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm as recycle } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

createRequire(import.meta.url)("./recycle-cleanup.cjs");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const skipMac = args.has("--skip-mac");
const skipWin = args.has("--skip-win");
const skipWslLinux = args.has("--skip-linux");
const allowDirty = args.has("--allow-dirty");
const winHost = process.env.BRIDGE_WIN_SSH_HOST ?? "win";

const macChromeDefault = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const hasXcodeApp = existsSync("/Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild");

function git(gitArgs) {
  const result = spawnSync("git", gitArgs, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${gitArgs.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

const activeChildren = new Set();

function runPrefixed(prefix, command, commandArgs, extraEnv = {}) {
  return new Promise((resolveStep, rejectStep) => {
    const startedAt = Date.now();
    const child = spawn(command, commandArgs, {
      cwd: root,
      env: { ...process.env, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    activeChildren.add(child);
    const forward = (stream, target) => {
      let rest = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        const lines = (rest + chunk).split(/\r?\n/u);
        rest = lines.pop() ?? "";
        for (const line of lines) target.write(`[${prefix}] ${line}\n`);
      });
      stream.on("end", () => {
        if (rest) target.write(`[${prefix}] ${rest}\n`);
      });
    };
    forward(child.stdout, process.stdout);
    forward(child.stderr, process.stderr);
    child.on("error", (err) => {
      activeChildren.delete(child);
      rejectStep(err);
    });
    child.on("close", (code) => {
      activeChildren.delete(child);
      const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
      if (code === 0) resolveStep(Number(elapsedSec));
      else rejectStep(new Error(`[${prefix}] ${command} ${commandArgs.join(" ")} exited with code ${code} after ${elapsedSec}s`));
    });
  });
}

const status = git(["status", "--porcelain"]);
if (status && !allowDirty) {
  console.error("Working tree has uncommitted changes. Commit first so the verified 40-char SHA matches your PR head:\n" + status);
  process.exit(1);
}

const revision = git(["rev-parse", "HEAD"]);
console.log(`=== Local Distributed CI @ ${revision} ===`);

const tempRoot = await mkdtemp(join(tmpdir(), "bridge-local-ci-"));
const results = [];

try {
  const tasks = [];

  if (!skipMac) {
    tasks.push((async () => {
      const browserEnv = !process.env.CHROME_PATH && existsSync(macChromeDefault)
        ? { CHROME_PATH: macChromeDefault }
        : {};
      const tInfra = await runPrefixed("MAC", "npm", ["run", "test:infra"]);
      results.push(`macOS test:infra (${tInfra}s)`);

      const tAudit = await runPrefixed("MAC", "npm", ["run", "audit:runtime"]);
      results.push(`macOS audit:runtime (${tAudit}s)`);

      const tVerify = await runPrefixed("MAC", "npm", ["run", "verify"]);
      results.push(`macOS verify: typecheck + 5 Vitest suites + full build (${tVerify}s)`);

      const tBrowser = await runPrefixed("MAC", "npm", ["run", "test:browser"], browserEnv);
      results.push(`macOS test:browser: 20 isolated Chrome mobile E2E scenarios (${tBrowser}s)`);

      const tService = await runPrefixed("MAC", "npm", ["run", "ci:run", "--", "run", "test:desktop:service"]);
      results.push(`macOS test:desktop:service: Electron UI + service + native TCP helper (${tService}s)`);

      if (hasXcodeApp) {
        const tIosSim = await runPrefixed("MAC", "npm", ["run", "ci:run", "--", "run", "build:ios:simulator", "-w", "@bridge/mobile"]);
        const tIosDev = await runPrefixed("MAC", "npm", ["run", "ci:run", "--", "run", "build:ios:device", "-w", "@bridge/mobile"]);
        results.push(`macOS iOS simulator + unsigned device builds (${(tIosSim + tIosDev).toFixed(1)}s)`);
      }
    })());
  }

  if (!skipWin) {
    tasks.push((async () => {
      const bundleLocal = join(tempRoot, `ci-${revision.slice(0, 12)}.bundle`);
      const scriptLocal = resolve(root, "scripts/win-local-ci.ps1");
      const remoteBundle = `D:/work/cache/temp/ci-${revision.slice(0, 12)}.bundle`;
      const remoteScript = `D:/work/cache/temp/win-local-ci-${revision.slice(0, 12)}.ps1`;

      const sshAlive = ["-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3"];

      await runPrefixed("WIN-SYNC", "git", ["bundle", "create", bundleLocal, "HEAD"]);
      await runPrefixed("WIN-SYNC", "ssh", [...sshAlive, winHost, 'New-Item -ItemType Directory -Force -Path "D:\\work\\cache\\temp" | Out-Null']);
      await runPrefixed("WIN-SYNC", "scp", ["-q", ...sshAlive, bundleLocal, `${winHost}:${remoteBundle}`]);
      await runPrefixed("WIN-SYNC", "scp", ["-q", ...sshAlive, scriptLocal, `${winHost}:${remoteScript}`]);

      const psArgs = [
        ...sshAlive,
        winHost,
        `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${remoteScript.replaceAll("/", "\\")}" -Revision "${revision}" -BundlePath "${remoteBundle.replaceAll("/", "\\")}"${skipWslLinux ? " -SkipWslLinux" : ""}; $ec = $LASTEXITCODE; if (Test-Path "D:\\work\\cache\\bridge-recycle.exe") { $env:BRIDGE_WIN_RECYCLE_EXE = "D:\\work\\cache\\bridge-recycle.exe" }; if (Test-Path "D:\\work\\ci-worktree\\scripts\\recycle-cleanup.cjs") { D:\\work\\tools\\node-26\\node.exe --require D:\\work\\ci-worktree\\scripts\\recycle-cleanup.cjs D:\\work\\ci-worktree\\scripts\\clean.mjs "${remoteScript.replaceAll("/", "\\")}"; if ($LASTEXITCODE -ne 0 -and $ec -eq 0) { $ec = $LASTEXITCODE } }; exit $ec`,
      ];
      const tWin = await runPrefixed("WIN", "ssh", psArgs);
      results.push(
        `Windows 11 + Android API 36 WHPX Emulator${skipWslLinux ? "" : " + WSL2 Ubuntu-24.04 .deb/.rpm"} (${tWin}s)`,
      );
    })());
  }

  await Promise.all(tasks);

  console.log("\n=== LOCAL DISTRIBUTED CI SUCCEEDED ===");
  console.log(`Verified Commit SHA: ${revision}`);
  for (const line of results) console.log(`  - ${line}`);
  if (!hasXcodeApp && !skipMac) {
    console.log("  - Not Run: iOS Xcode simulator/device builds (Xcode.app not installed on this Mac)");
  }
} finally {
  for (const child of activeChildren) {
    child.kill("SIGTERM");
  }
  await recycle(tempRoot, { recursive: true, force: true });
}
