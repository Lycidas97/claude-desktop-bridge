import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm as recycle, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

createRequire(import.meta.url)("./recycle-cleanup.cjs");

export const LOCAL_CI_STATUS_CONTEXT = "ci/local-distributed";
const DEFAULT_STATUS_REPO = "Lycidas97/claude-desktop-bridge";

const scriptPath = fileURLToPath(import.meta.url);
const root = resolve(dirname(scriptPath), "..");
const macChromeDefault = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

function git(gitArgs, cwd = root) {
  const result = spawnSync("git", gitArgs, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${gitArgs.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

export function validateStatusRepo(repo) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repo)) {
    throw new Error(`Invalid GitHub repository slug: ${repo}`);
  }
  if (repo.toLowerCase().startsWith("czhmartinez/")) {
    throw new Error(`Refusing to publish commit status to upstream repository: ${repo}`);
  }
  return repo;
}

function receiptDirFor(cwd) {
  return join(git(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd), "local-ci");
}

function postCommitStatus({ repo, revision, description, cwd, env = process.env, allowUnpushed = false }) {
  const validRepo = validateStatusRepo(repo);
  if (!/^[0-9a-f]{40}$/u.test(revision)) {
    throw new Error(`Expected 40-char commit SHA, got: ${revision}`);
  }
  const summary = description.slice(0, 140);
  const ghExec = env.BRIDGE_GH_EXEC;
  const [ghCmd, ghPrefix] = ghExec && /\.[cm]?js$/iu.test(ghExec)
    ? [process.execPath, [ghExec]]
    : [ghExec || "gh", []];
  const result = spawnSync(
    ghCmd,
    [
      ...ghPrefix,
      "api",
      `repos/${validRepo}/statuses/${revision}`,
      "-f",
      "state=success",
      "-f",
      `context=${LOCAL_CI_STATUS_CONTEXT}`,
      "-f",
      `description=${summary}`,
    ],
    { cwd, env, encoding: "utf8" },
  );
  if (result.status === 0) {
    console.log(`Published GitHub commit status: ${LOCAL_CI_STATUS_CONTEXT} = success (${validRepo}@${revision.slice(0, 12)})`);
    return { published: true, deferred: false };
  }
  const detail = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.trim() || (result.error ? String(result.error) : "unknown gh error");
  if (allowUnpushed && /No commit found for SHA/iu.test(detail)) {
    console.log(
      `Commit ${revision.slice(0, 12)} is not on ${validRepo} yet; receipt saved. After git push, run: npm run ci:local -- --publish`,
    );
    return { published: false, deferred: true };
  }
  throw new Error(`Failed to publish ${LOCAL_CI_STATUS_CONTEXT} to ${validRepo}@${revision}: ${detail}`);
}

export async function recordAndPublishLocalCi({
  cwd = root,
  revision,
  tree,
  allowDirty = false,
  skipMac = false,
  skipWin = false,
  skipWslLinux = false,
  noPublish = false,
  repo = process.env.BRIDGE_GITHUB_STATUS_REPO ?? DEFAULT_STATUS_REPO,
  env = process.env,
}) {
  validateStatusRepo(repo);
  if (allowDirty || skipMac || skipWin || skipWslLinux || !/^[0-9a-f]{40}$/u.test(revision)) {
    return { qualified: false, published: false, deferred: false };
  }
  const receipts = receiptDirFor(cwd);
  await mkdir(receipts, { recursive: true });
  const payload = JSON.stringify(
    {
      revision,
      tree,
      context: LOCAL_CI_STATUS_CONTEXT,
      verifiedAt: new Date().toISOString(),
    },
    null,
    2,
  );
  await writeFile(join(receipts, `${revision}.json`), `${payload}\n`, "utf8");
  if (/^[0-9a-f]{40}$/u.test(tree)) {
    await writeFile(join(receipts, `tree-${tree}.json`), `${payload}\n`, "utf8");
  }
  if (noPublish) {
    return { qualified: true, published: false, deferred: false };
  }
  const description = `Mac + Win11 + Android16 + WSL2 Ubuntu24 verified (${revision.slice(0, 12)})`;
  const outcome = postCommitStatus({ repo, revision, description, cwd, env, allowUnpushed: true });
  return { qualified: true, ...outcome };
}

export async function publishVerifiedHead({
  cwd = process.cwd(),
  repo = process.env.BRIDGE_GITHUB_STATUS_REPO ?? DEFAULT_STATUS_REPO,
  env = process.env,
} = {}) {
  validateStatusRepo(repo);
  const topLevel = git(["rev-parse", "--show-toplevel"], cwd);
  const dirty = git(["status", "--porcelain"], topLevel);
  if (dirty) {
    throw new Error(`Working tree has uncommitted changes; refusing to publish ${LOCAL_CI_STATUS_CONTEXT}:\n${dirty}`);
  }
  const revision = git(["rev-parse", "HEAD"], topLevel);
  const tree = git(["rev-parse", "HEAD^{tree}"], topLevel);
  const receipts = receiptDirFor(topLevel);
  const commitReceiptPath = join(receipts, `${revision}.json`);
  const treeReceiptPath = join(receipts, `tree-${tree}.json`);

  let receipt = null;
  let viaTree = false;
  if (existsSync(commitReceiptPath)) {
    receipt = JSON.parse(await readFile(commitReceiptPath, "utf8"));
  } else if (existsSync(treeReceiptPath)) {
    const candidate = JSON.parse(await readFile(treeReceiptPath, "utf8"));
    if (candidate.tree === tree && /^[0-9a-f]{40}$/u.test(candidate.revision ?? "")) {
      receipt = candidate;
      viaTree = true;
    }
  }
  if (!receipt) {
    throw new Error(`No verified local CI receipt found for commit ${revision} (or tree ${tree}). Run npm run ci:local first.`);
  }
  const description = viaTree
    ? `Mac + Win11 + Android16 + WSL2 verified (tree ${tree.slice(0, 10)} from ${receipt.revision.slice(0, 10)})`
    : `Mac + Win11 + Android16 + WSL2 Ubuntu24 verified (${revision.slice(0, 12)})`;
  postCommitStatus({ repo, revision, description, cwd: topLevel, env, allowUnpushed: false });
  return { revision, tree, viaTree, sourceRevision: receipt.revision };
}

async function runCli() {
  const args = new Set(process.argv.slice(2));
  const publishOnly = args.has("--publish");
  const noPublish = args.has("--no-publish");
  const skipMac = args.has("--skip-mac");
  const skipWin = args.has("--skip-win");
  const skipWslLinux = args.has("--skip-linux");
  const allowDirty = args.has("--allow-dirty");
  const winHost = process.env.BRIDGE_WIN_SSH_HOST ?? "win";
  const statusRepo = validateStatusRepo(process.env.BRIDGE_GITHUB_STATUS_REPO ?? DEFAULT_STATUS_REPO);

  if (publishOnly) {
    await publishVerifiedHead({ cwd: process.cwd(), repo: statusRepo });
    return;
  }

  const status = git(["status", "--porcelain"]);
  if (status && !allowDirty) {
    console.error("Working tree has uncommitted changes. Commit first so the verified 40-char SHA matches your PR head:\n" + status);
    process.exit(1);
  }

  const revision = git(["rev-parse", "HEAD"]);
  const tree = git(["rev-parse", "HEAD^{tree}"]);
  // Keep every run's full output beside the receipts, independent of where the caller redirects it.
  const logDir = join(receiptDirFor(root), "logs");
  await mkdir(logDir, { recursive: true });
  const logPath = join(logDir, `${revision.slice(0, 12)}-${new Date().toISOString().replaceAll(":", "")}.log`);
  const log = createWriteStream(logPath);
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream);
    stream.write = (chunk, ...rest) => {
      log.write(chunk);
      return write(chunk, ...rest);
    };
  }
  console.log(`=== Local Distributed CI @ ${revision} ===\nLog: ${logPath}`);

  const activeChildren = new Set();
  function runPrefixed(prefix, command, commandArgs, extraEnv = {}) {
    return new Promise((resolveStep, rejectStep) => {
      const startedAt = Date.now();
      const child = spawn(command, commandArgs, {
        cwd: root,
        env: { ...process.env, ...(prefix === "MAC" ? { BRIDGE_RECYCLE_STAGING: join(tempRoot, "mac-recycle") } : {}), ...extraEnv },
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

  const tempRoot = await mkdtemp(join(tmpdir(), "bridge-local-ci-"));
  if (!skipMac) await mkdir(join(tempRoot, "mac-recycle"));
  const results = [];
  const sshAlive = ["-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3"];
  let unfinishedWinRunId = null;

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

        const [tBrowser, tService] = await Promise.all([
          runPrefixed("MAC", "npm", ["run", "test:browser:nobuild"], browserEnv),
          runPrefixed("MAC", "npm", ["run", "ci:run", "--", "run", "test:desktop:service"]),
        ]);
        results.push(`macOS test:browser: 10 Chrome mobile E2E scenarios x 2 themes (${tBrowser}s)`);
        results.push(`macOS test:desktop:service: Electron UI + service + native TCP helper (${tService}s)`);
      })());
    }

    if (!skipWin) {
      tasks.push((async () => {
        const runId = `${revision.slice(0, 12)}-${process.pid}-${Date.now()}`;
        const bundleLocal = join(tempRoot, `ci-${runId}.bundle`);
        const scriptLocal = resolve(root, "scripts/win-local-ci.ps1");
        const remoteBundle = `D:/work/cache/temp/ci-${runId}.bundle`;
        const remoteScript = `D:/work/cache/temp/win-local-ci-${runId}.ps1`;
        const remoteBundleWin = remoteBundle.replaceAll("/", "\\");
        const remoteScriptWin = remoteScript.replaceAll("/", "\\");

        await runPrefixed("WIN-SYNC", "git", ["bundle", "create", bundleLocal, "HEAD"]);
        await runPrefixed("WIN-SYNC", "ssh", [...sshAlive, winHost, 'New-Item -ItemType Directory -Force -Path "D:\\work\\cache\\temp" | Out-Null']);
        await runPrefixed("WIN-SYNC", "scp", ["-q", ...sshAlive, bundleLocal, `${winHost}:${remoteBundle}`]);
        await runPrefixed("WIN-SYNC", "scp", ["-q", ...sshAlive, scriptLocal, `${winHost}:${remoteScript}`]);

        const psArgs = [
          ...sshAlive,
          winHost,
          `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${remoteScriptWin}" -Revision "${revision}" -BundlePath "${remoteBundleWin}"${skipWslLinux ? " -SkipWslLinux" : ""}; $ec = $LASTEXITCODE; if (Test-Path -LiteralPath "${remoteScriptWin}") { if (Test-Path "D:\\work\\cache\\bridge-recycle.exe") { & "D:\\work\\cache\\bridge-recycle.exe" "${remoteScriptWin}" } elseif (Test-Path "D:\\work\\claude-desktop-bridge\\scripts\\recycle-cleanup.cjs") { D:\\work\\tools\\node-26\\node.exe --require D:\\work\\claude-desktop-bridge\\scripts\\recycle-cleanup.cjs D:\\work\\claude-desktop-bridge\\scripts\\clean.mjs "${remoteScriptWin}" }; if ($LASTEXITCODE -ne 0 -and $ec -eq 0) { $ec = $LASTEXITCODE } }; exit $ec`,
        ];
        unfinishedWinRunId = runId;
        const tWin = await runPrefixed("WIN", "ssh", psArgs);
        unfinishedWinRunId = null;
        results.push(
          `Windows 11 + Android API 36 WHPX Emulator${skipWslLinux ? "" : " + WSL2 Ubuntu-24.04 Linux tests & .deb/.rpm/.zip"} (${tWin}s)`,
        );
      })());
    }

    await Promise.all(tasks);
  } finally {
    for (const child of activeChildren) {
      child.kill("SIGTERM");
    }
    if (unfinishedWinRunId) {
      // Windows OpenSSH keeps the remote powershell.exe running after the local ssh client dies, so it would hold
      // its win-local-ci slot mutex and emulator until it finished on its own. Kill that process tree and recycle
      // the uploaded bundle/script its own finally would have removed.
      const stop = spawnSync("ssh", [
        ...sshAlive,
        winHost,
        `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*win-local-ci-${unfinishedWinRunId}.ps1*' } | ForEach-Object { cmd.exe /c "taskkill.exe /PID $($_.ProcessId) /T /F >nul 2>nul" }; foreach ($leftover in @("D:\\work\\cache\\temp\\ci-${unfinishedWinRunId}.bundle", "D:\\work\\cache\\temp\\win-local-ci-${unfinishedWinRunId}.ps1")) { if (Test-Path -LiteralPath $leftover) { & "D:\\work\\cache\\bridge-recycle.exe" $leftover; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } } }; exit 0`,
      ], { encoding: "utf8" });
      if (stop.status !== 0) {
        console.error(`[WIN] Failed to stop remote win-local-ci-${unfinishedWinRunId}.ps1; its slot stays held until it exits: ${stop.stderr || stop.error}`);
      }
    }
    await recycle(tempRoot, { recursive: true, force: true });
  }

  await recordAndPublishLocalCi({
    cwd: root,
    revision,
    tree,
    allowDirty,
    skipMac,
    skipWin,
    skipWslLinux,
    noPublish,
    repo: statusRepo,
  });

  console.log("\n=== LOCAL DISTRIBUTED CI SUCCEEDED ===");
  console.log(`Verified Commit SHA: ${revision}`);
  for (const line of results) console.log(`  - ${line}`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === scriptPath) {
  await runCli().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
