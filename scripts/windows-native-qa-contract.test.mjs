import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { recycleWindowsRunCommand } from "./local-ci.mjs";

const qaSource = await readFile(new URL("./packaged-desktop-qa.mjs", import.meta.url), "utf8");
const windowsSource = await readFile(new URL("./windows-packaged-qa.ps1", import.meta.url), "utf8");
const androidE2eSource = await readFile(new URL("./android-installed-e2e.mjs", import.meta.url), "utf8");
const desktopPackage = JSON.parse(await readFile(new URL("../apps/desktop/package.json", import.meta.url), "utf8"));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// Native snapshot from controller.snapshot(): no SDK provider/default-mode fields,
// and no rewind, Native-prompt or PR-write capabilities while the inspector is disconnected.
function nativeSnapshot() {
  return {
    host: {
      version: desktopPackage.version,
      pairingEpoch: 1,
      capabilities: [
        "evidence.v1", "evidence.details.v1", "artifact.preview.v1",
        "artifact.transfer.v1", "artifact.transfer.relative-link.v1", "artifact.text-preview.v1", "workspace.upload.v1",
        "claude.native-relay.v1",
        "directory.browse.v1", "runtime.adapter.v1", "session.visibility.v1",
        "session.commands.v1", "session.command.v1", "subagent.stop.v1",
        "system.update.v1", "transcript.toolDetail.v1",
        "turn.queue.steer.v1", "turn.queue.cancel.v1", "plugin.magpie-quota.v1",
      ],
    },
    updater: {
      platform: "win32",
      arch: "x64",
      currentVersion: desktopPackage.version,
      channel: "stable",
      autoCheck: true,
      applyMode: "prompt",
      canAutoRestart: true,
      phase: "idle",
    },
    projects: [], sessions: [], devices: [], permissions: [], prompts: [],
    runtime: {
      state: "unavailable", activeTurns: 0, maxParallelTurns: 0,
      desktopIntegration: { state: "disconnected", enabled: true, canRestart: false },
    },
    runtimes: [{ id: "claude-desktop", state: "unavailable", capabilities: ["session.list", "session.history"] }],
    connection: "connected", diagnosticsEnabled: false,
  };
}

async function runQa(snapshot, overrides = {}) {
  const requests = [];
  const ui = [];
  let closed = false;
  let report;
  const locator = {
    async waitFor() {},
    async click() {},
    async isVisible() { return true; },
    async isChecked() { return snapshot.diagnosticsEnabled; },
    getByRole(role, options) { ui.push(options?.name); return locator; },
    getByText(text) { ui.push(text); return locator; },
  };
  const page = {
    url: () => "file:///isolated-bridge/renderer/index.html",
    on() {},
    async waitForLoadState() {},
    async reload() {},
    async waitForFunction(callback) { assert.ok(await callback()); },
    async evaluate(callback, argument) { return callback(argument); },
    getByRole: locator.getByRole,
    getByText: locator.getByText,
    locator(selector) { ui.push(selector); return locator; },
    async screenshot() {},
  };
  const window = { bridgeDesktop: {
    async getSnapshot() { return snapshot; },
    async request(request) {
      requests.push(request.method);
      if (overrides[request.method]) return overrides[request.method];
      if (["provider.list", "conversation.route.get"].includes(request.method)) {
        return { ok: false, error: { code: "UNSUPPORTED", message: "Claude Desktop 原生会话不支持 Bridge 独立提供方或执行通道接力。" } };
      }
      if (request.method === "system.update") {
        return { ok: true, result: snapshot.updater };
      }
      const field = { "runtime.list": "runtimes", "project.list": "projects", "session.list": "sessions" }[request.method];
      assert.ok(field, `Unexpected QA request: ${request.method}`);
      return { ok: true, result: { [field]: snapshot[field] } };
    },
  } };
  // Execute the real QA body with only browser and filesystem I/O replaced.
  // No Electron, real inspector, user profile, relay or model is contacted.
  try {
    await new AsyncFunction("assert", "mkdir", "readFile", "resolve", "chromium", "process", "window",
      qaSource.replace(/^import .*;\r?\n/gmu, ""),
    )(assert, async () => {}, async () => JSON.stringify(desktopPackage), resolve, {
      async connectOverCDP() { return {
        contexts: () => [{ pages: () => [page] }],
        async close() { closed = true; },
      }; },
    }, { env: {}, stdout: { write(value) { report = JSON.parse(value); } } }, window);
    return { requests, ui, report };
  } finally {
    assert.equal(closed, true, "QA must close CDP even when a contract assertion fails");
  }
}

test("packaged QA accepts a disconnected Native snapshot and checks live IPC contracts", async () => {
  const snapshot = nativeSnapshot();
  const result = await runQa(snapshot);
  assert.equal(result.report.ok, true);
  for (const method of ["runtime.list", "project.list", "session.list", "system.update", "provider.list", "conversation.route.get"]) {
    assert.ok(result.requests.includes(method), `${method} was not verified`);
  }
  assert.ok(result.ui.includes(".desktop-session-sidebar"));
  assert.equal(result.ui.includes("设备"), false);
  assert.ok(result.ui.includes("设置"));
  assert.ok(result.ui.includes("手机配对与设备"));
  assert.ok(result.ui.includes("添加手机"));
  assert.ok(result.ui.includes("未检测到 Claude Desktop"));
  assert.ok(result.ui.includes(".session-catalog-empty-action"));
  assert.ok(result.ui.includes("新建会话"));
  assert.ok(result.ui.includes("Magpie 额度"));
  assert.ok(result.ui.includes(".magpie-quota-board"));
  assert.ok(result.ui.includes("Claude 接入"));
  assert.ok(result.ui.includes("调试连接监测"));
  assert.ok(result.ui.includes("连接与启动"));
  assert.ok(result.ui.includes("诊断与支持"));
  assert.ok(result.ui.some(label => String(label).includes("后台诊断记录")));
  assert.ok(result.ui.includes('dt:text-is("原生中转") + dd'));
  assert.ok(result.ui.includes("已就绪"));
  assert.ok(result.ui.includes("版本与更新"));
});

test("packaged QA checks Windows Alt guidance and historical startup record independently", async () => {
  const snapshot = nativeSnapshot();
  snapshot.claudeInspector = { platform: "win32", state: "closed", port: 9229, pollIntervalMs: 3000, clients: [], alerts: [],
    startup: { state: "failed", recordedAt: 1794697200000, detail: "自动开启失败：历史权限错误" } };
  const result = await runQa(snapshot);
  assert.ok(result.ui.some(label => String(label).includes("按 Alt 显示菜单")));
  assert.ok(result.ui.some(label => String(label).includes("Developer › Enable Main Process Debugger")));
  assert.ok(result.ui.some(label => String(label).includes("历史启动记录")));
});

test("packaged QA reads mail only when declared and keeps automatic delivery closed", async () => {
  const withoutMail = await runQa(nativeSnapshot());
  assert.equal(withoutMail.requests.includes("plugin.assistant-mail.list"), false);
  const snapshot = nativeSnapshot();
  snapshot.host.capabilities.push("plugin.assistant-agenda.v1", "plugin.assistant-agenda.day.v1", "plugin.assistant-mail.v1", "plugin.assistant-mail.account.v1", "plugin.assistant-mail.shared-auth.v1", "plugin.assistant-mail.keep-credential.v1", "plugin.assistant-mail.polling.v1", "plugin.assistant-mail.workspace.v1", "plugin.assistant-mail.read-directories.v1", "plugin.assistant-mail.attachments.v1", "plugin.assistant-mail.history.v1", "plugin.assistant-mail.received-order.v1", "plugin.assistant-mail.junk.v1", "plugin.assistant-mail.filing.v1", "plugin.assistant-mail.categories.v1", "plugin.assistant-mail.triggers.v1", "plugin.assistant-mail.batches.v1", "plugin.assistant-mail.attention.v1");
  snapshot.assistantAgenda = { changeToken: "fixture", credentialsSupported: true, sources: [{ id: "local", label: "本地", writable: true, enabled: true, configurable: false, status: "ready" }] };
  snapshot.assistantMail = { bindingState: "unbound", receiverState: "disabled", accounts: [], credentialsSupported: false, changeToken: "fixture", automaticDelivery: false };
  const result = await runQa(snapshot, { "plugin.assistant-mail.list": { ok: true, result: { mailPage: { cards: [] } } } });
  assert.ok(result.requests.includes("plugin.assistant-mail.list"));
  assert.equal(result.requests.some(method => method.startsWith("plugin.assistant-mail.account.") ||
    ["plugin.assistant-mail.bind", "plugin.assistant-mail.workspace.initialize", "plugin.assistant-mail.automatic-delivery.set", "turn.start"].includes(method)), false);
  snapshot.assistantMail.automaticDelivery = true;
  await assert.rejects(runQa(snapshot), /true !== false/u);
});

test("packaged QA reads a bounded proposal page through IPC when supported", async () => {
  const snapshot = nativeSnapshot();
  snapshot.host.capabilities.push("assistant.proposal.v1", "assistant.proposal.session.v1");
  snapshot.assistantProposals = { changeToken: "fixture", pendingCount: 0, sources: [] };
  const result = await runQa(snapshot, { "assistant.proposal.list": { ok: true, result: { proposals: [] } } });
  assert.deepEqual(result.requests.filter(method => method.startsWith("assistant.proposal.")), ["assistant.proposal.list"]);
});

test("packaged QA distinguishes a ready Native host with no active sessions", async () => {
  const snapshot = nativeSnapshot();
  snapshot.runtime.desktopIntegration.state = "ready";
  const result = await runQa(snapshot);
  assert.ok(result.ui.includes("暂无活跃会话"));
  assert.equal(result.ui.includes("未检测到 Claude Desktop"), false);
  assert.ok(result.ui.includes("新建会话"));
});

test("packaged QA keeps Native configuration/evidence checks with optional runtime capabilities", async () => {
  const snapshot = nativeSnapshot();
  snapshot.host.capabilities.push("session.rewind.v1", "session.rename.v1", "session.output-style.v1", "workspace.trust.v1", "prompt.native.v1", "pr.autofix.v1");
  snapshot.runtime.state = "ready";
  snapshot.runtime.desktopIntegration.state = "ready";
  snapshot.runtimes[0].state = "ready";
  snapshot.runtimes[0].capabilities.push("session.create", "workspace.trust", "prompt.resolve", "pr.autofix");
  snapshot.prompts.push({ promptId: "qa-cwd-trust", sessionId: "qa-native", kind: "cwd-trust", title: "信任工作目录", directory: "D:\\isolated-qa", sources: [], choices: [{ value: "trust", label: "信任目录" }, { value: "cancel", label: "取消" }], canRespond: true });
  snapshot.sessions.push({
    sessionId: "qa-native", runtimeId: "claude-desktop", transport: "claude-desktop-native",
    source: "desktop", allowedActions: { canConfigure: true },
  });
  const result = await runQa(snapshot, {
    "session.configuration": { ok: true, result: { configuration: {
      sessionId: "qa-native", modelSource: "claude-desktop", effortSource: "claude-desktop",
      availableModels: [], availableEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    } } },
    "evidence.list": { ok: true, result: { evidence: { sessionId: "qa-native", items: [] } } },
  });
  assert.equal(result.report.configuration.sessionId, "qa-native");
  assert.equal(result.report.evidence.items, 0);
  assert.equal(result.requests.some(method => ["prompt.resolve", "pr.autoFix.read", "pr.autoFix.set"].includes(method)), false, "Packaged QA must not answer Native prompts or query/change PR state without a user action");
  assert.ok(result.ui.includes("会话设置"));
  assert.ok(result.ui.includes(".evidence-panel, .evidence-empty"));
});

test("packaged QA rejects missing Native capability and an accidentally restored provider API", async () => {
  const snapshot = nativeSnapshot();
  snapshot.host.capabilities = snapshot.host.capabilities.filter(value => value !== "claude.native-relay.v1");
  await assert.rejects(runQa(snapshot), /claude\.native-relay\.v1/u);
  await assert.rejects(runQa(nativeSnapshot(), {
    "provider.list": { ok: true, result: { providers: [] } },
  }), /provider\.list/u);
});

test("Windows QA retains caller-owned staging and directly cleans standalone scratch with failures surfaced", { skip: process.platform !== "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "bridge-qa-retention-"));
  try {
    const staging = join(directory, "staging");
    await mkdir(staging);
    const fixture = join(directory, "cleanup.ps1");
    await writeFile(fixture, `
      $ErrorActionPreference = "Stop"
      $environmentKeys = @()
      $tokens = $null; $parseErrors = $null
      $ast = [Management.Automation.Language.Parser]::ParseInput((Get-Content -LiteralPath ${JSON.stringify(fileURLToPath(new URL("./windows-packaged-qa.ps1", import.meta.url)))} -Raw), [ref]$tokens, [ref]$parseErrors)
      if ($parseErrors.Count) { throw "QA_SOURCE_PARSE_FAILED" }
      $allocation = $ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.AssignmentStatementAst] -and $_.Left.Extent.Text -in @('$qaParent', '$qaRoot', '$smokeRoot', '$installRoot') }
      . ([ScriptBlock]::Create(($allocation.Extent.Text -join "\`n")))
      $roots = @($qaRoot, $smokeRoot, $installRoot)
      foreach ($root in $roots) {
        New-Item -ItemType Directory -Path $root | Out-Null
        Set-Content -LiteralPath (Join-Path $root "retained.txt") -Value "retained" -NoNewline
      }
      Write-Output ("ROOTS=" + (ConvertTo-Json -InputObject $roots -Compress))
      function node.exe { throw "RECYCLE_CALLED" }
      function Remove-Item {
        param([string]$LiteralPath, [switch]$Recurse, [switch]$Force)
        if ($env:BRIDGE_QA_CLEANUP_FAILURE) { throw "TEMP_CLEANUP_FAILED" }
        Microsoft.PowerShell.Management\\Remove-Item @PSBoundParameters
      }
      try { if ($env:BRIDGE_QA_TEST_FAILURE) { throw $env:BRIDGE_QA_TEST_FAILURE } } finally {
      ${windowsSource.slice(windowsSource.indexOf("  foreach ($key in $environmentKeys) {", windowsSource.search(/^\} finally \{\r?$/mu)))}
    `);
    for (const [environment, staged, failure, cleanupFailure = false] of [
      ["github-hosted", false, ""], ["github-hosted", true, ""],
      ["self-hosted", false, ""], ["self-hosted", true, ""],
      ["github-hosted", true, "QA_ASSERTION_FAILED"], ["self-hosted", false, "QA_ASSERTION_FAILED"],
      ["self-hosted", false, "", true],
    ]) {
      const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", fixture], {
        encoding: "utf8", env: { ...process.env, TEMP: directory, TMP: directory, BRIDGE_RECYCLE_STAGING: staged ? staging : "", RUNNER_ENVIRONMENT: environment, BRIDGE_QA_TEST_FAILURE: failure, BRIDGE_QA_CLEANUP_FAILURE: cleanupFailure ? "1" : "" },
      });
      if (!failure && !cleanupFailure) assert.equal(result.status, 0, result.stderr);
      else {
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, new RegExp(failure || "TEMP_CLEANUP_FAILED", "u"));
      }
      assert.doesNotMatch(result.stderr, /RECYCLE_CALLED/u);
      const roots = JSON.parse(/ROOTS=(.+)/u.exec(result.stdout)[1]);
      for (const root of roots) {
        assert.equal(dirname(root), staged ? staging : directory);
        if (staged || cleanupFailure) assert.equal(await readFile(join(root, "retained.txt"), "utf8"), "retained");
        else assert.equal(existsSync(root), false, 'Standalone QA deletes only its own scratch');
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("local Windows QA stages win-unpacked without running NSIS Setup/Uninstall and stops only installRoot processes", { skip: process.platform !== "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "bridge-qa-local-isolation-"));
  let hostSimPid = null;
  try {
    const makeDir = join(directory, "make");
    const unpackedDir = join(makeDir, "win-unpacked");
    const hostDir = join(directory, "host-bridge");
    await mkdir(unpackedDir, { recursive: true });
    await mkdir(hostDir, { recursive: true });

    const pingExe = join(process.env.SystemRoot || "C:\\Windows", "System32", "ping.exe");
    const unpackedBridge = join(unpackedDir, "bridge.exe");
    const hostBridge = join(hostDir, "bridge.exe");
    const setupTrap = join(makeDir, "Bridge-1.3.2-Setup.exe");
    await writeFile(setupTrap, "TRAP_DO_NOT_EXECUTE_NSIS_INSTALLER");
    await writeFile(unpackedBridge, await readFile(pingExe));
    await writeFile(hostBridge, await readFile(pingExe));

    const tryStart = windowsSource.search(/^try \{\r?$/mu);
    const resolvedStageEnd = windowsSource.search(/^  foreach \(\$key in \$environmentKeys\) \{\r?\n    \[Environment\]::SetEnvironmentVariable\(\$key, \$null/mu);
    assert.notEqual(tryStart, -1, "Missing top-level try block in windows-packaged-qa.ps1");
    assert.notEqual(resolvedStageEnd, -1, "Missing post-install env reset in windows-packaged-qa.ps1");
    const stageSlice = windowsSource.slice(windowsSource.indexOf("\n", tryStart) + 1, resolvedStageEnd);
    const finallySlice = windowsSource.slice(
      windowsSource.indexOf("  foreach ($key in $environmentKeys) {", windowsSource.search(/^\} finally \{\r?$/mu)),
    );

    const fixture = join(directory, "local-isolation.ps1");
    await writeFile(fixture, `
      $ErrorActionPreference = "Stop"
      $PSScriptRoot = ${JSON.stringify(fileURLToPath(new URL(".", import.meta.url)))}
      $environmentKeys = @()
      $originalEnvironment = @{}
      $installer = Get-Item -LiteralPath ${JSON.stringify(setupTrap)}
      $qaRoot = Join-Path $env:BRIDGE_QA_TEST_ROOT "qa"
      $smokeRoot = Join-Path $env:BRIDGE_QA_TEST_ROOT "smoke"
      $installRoot = Join-Path $env:BRIDGE_QA_TEST_ROOT "install"
      New-Item -ItemType Directory -Path $qaRoot, $smokeRoot | Out-Null
      $hostProc = Start-Process -FilePath ${JSON.stringify(hostBridge)} -ArgumentList @("-n", "60", "127.0.0.1") -WindowStyle Hidden -PassThru
      Write-Output "HOST_PID=$($hostProc.Id)"
      try {
${stageSlice}
        Set-Content -LiteralPath (Join-Path $installRoot "Uninstall Bridge.exe") -Value "TRAP_DO_NOT_EXECUTE_NSIS_UNINSTALLER"
        $detachedService = Start-Process -FilePath $desktopExecutable.FullName -ArgumentList @("-n", "60", "127.0.0.1") -WindowStyle Hidden -PassThru
        Write-Output "DETACHED_PID=$($detachedService.Id)"
      } finally {
      ${finallySlice}
    `);

    const env = { ...process.env, BRIDGE_QA_TEST_ROOT: directory };
    delete env.RUNNER_ENVIRONMENT;
    delete env.BRIDGE_RECYCLE_STAGING;
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", fixture], {
      encoding: "utf8",
      env,
    });
    const hostMatch = /HOST_PID=(\d+)/u.exec(result.stdout || "");
    if (hostMatch) hostSimPid = Number(hostMatch[1]);

    assert.equal(result.status, 0, `Local isolation fixture failed:\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
    const detachedMatch = /DETACHED_PID=(\d+)/u.exec(result.stdout || "");
    assert.ok(detachedMatch, "Detached service simulation PID was not recorded");
    assert.ok(hostSimPid, "Host Bridge simulation PID was not recorded");

    const aliveCheck = spawnSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      `Write-Output ("HOST=" + [bool](Get-Process -Id ${hostSimPid} -ErrorAction SilentlyContinue)); Write-Output ("DETACHED=" + [bool](Get-Process -Id ${Number(detachedMatch[1])} -ErrorAction SilentlyContinue)); Write-Output ("INSTALL_EXISTS=" + (Test-Path -LiteralPath ${JSON.stringify(join(directory, "install"))}))`,
    ], { encoding: "utf8" });
    assert.match(aliveCheck.stdout, /HOST=True/u, "Host Bridge.exe simulation must remain untouched");
    assert.match(aliveCheck.stdout, /DETACHED=False/u, "Detached --bridge-service inside installRoot must be terminated");
    assert.match(aliveCheck.stdout, /INSTALL_EXISTS=False/u, "installRoot must be recycled cleanly after stopping detached service");
  } finally {
    if (hostSimPid) {
      spawnSync("cmd.exe", ["/c", `taskkill.exe /PID ${hostSimPid} /T /F >nul 2>nul`]);
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("Windows CI recycles its QA staging after exit and preserves locked staging on failure", { skip: process.platform !== "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "bridge-ci-recycle-"));
  try {
    const runRoot = join(directory, "run");
    const installRoot = join(runRoot, "qa-staging", "install");
    const modulePath = join(installRoot, "node_datachannel.node");
    await mkdir(installRoot, { recursive: true });
    await writeFile(modulePath, "QA lock fixture");

    const lockSource = join(directory, "hold-lock.cs");
    const lockExe = join(installRoot, "hold-lock.exe");
    await writeFile(lockSource, `
      class LockHolder {
        static void Main() {
          using (System.IO.File.Open("node_datachannel.node", System.IO.FileMode.Open,
                   System.IO.FileAccess.ReadWrite, System.IO.FileShare.None)) {
            System.Console.WriteLine("LOCKED");
            System.Threading.Thread.Sleep(30000);
          }
        }
      }
    `);
    const compiler = join(process.env.SystemRoot, "Microsoft.NET/Framework64/v4.0.30319/csc.exe");
    const compilation = spawnSync(compiler, ["/nologo", `/out:${lockExe}`, lockSource], { encoding: "utf8" });
    assert.equal(compilation.status, 0, compilation.stdout + compilation.stderr);

    const recycleSource = await readFile(new URL("./win-ci-recycle.cs", import.meta.url));
    const recycleRun = recycleWindowsRunCommand(runRoot, recycleSource);
    const teardown = windowsSource.slice(windowsSource.search(/^\} catch \{\r?\n  \$qaFailure = \$_/mu));
    const fixture = join(directory, "recycle.ps1");
    await writeFile(fixture, `
      param([switch]$Locked, [switch]$WaitFailure)
      $ErrorActionPreference = 'Stop'
      $env:BRIDGE_RECYCLE_STAGING = '${dirname(installRoot)}'
      $installRoot = '${installRoot}'
      $environmentKeys = @()
      $start = [Diagnostics.ProcessStartInfo]::new('${lockExe}')
      $start.WorkingDirectory = $installRoot
      $start.UseShellExecute = $false
      $start.RedirectStandardOutput = $true
      $child = [Diagnostics.Process]::Start($start)
      try {
        if ($child.StandardOutput.ReadLine() -ne 'LOCKED') { throw 'Fixture did not acquire the file lock' }
        if ($Locked) { ${recycleRun} }
        if ($WaitFailure) {
          function Wait-Process { throw 'QA_WAIT_FAILED' }
        }
        try { if ($WaitFailure) { throw 'QA_ASSERTION_FAILED' }
        ${teardown}
        if (-not $child.HasExited) { throw 'QA did not stop the lock holder' }
        ${recycleRun}
      } finally {
        if (-not $child.HasExited) { $child.Kill(); $child.WaitForExit() }
        $child.Dispose()
      }
    `);
    const run = (...args) => spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", fixture, ...args], { encoding: "utf8", timeout: 20_000 });
    const locked = run("-Locked");
    assert.equal(locked.status, 1, locked.stdout + locked.stderr);
    assert.match(locked.stderr, /Windows Recycle Bin cleanup failed for/u);
    assert.ok(locked.stderr.includes(runRoot));
    assert.equal(await readFile(modulePath, "utf8"), "QA lock fixture");

    const waitFailure = run("-WaitFailure");
    assert.equal(waitFailure.status, 1, waitFailure.stdout + waitFailure.stderr);
    assert.match(waitFailure.stderr, /QA_ASSERTION_FAILED/u);
    assert.match(waitFailure.stderr, /QA_WAIT_FAILED/u);
    assert.ok(existsSync(runRoot));

    const released = run();
    assert.equal(released.status, 0, released.stdout + released.stderr);
    assert.equal(existsSync(runRoot), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Windows QA keeps the local public relay, allocates dynamic ports, and isolates both app launches", () => {
  assert.doesNotMatch(windowsSource, /\b(?:8788|9223|9224)\b/u, "Windows QA must not hardcode relay or CDP ports");
  assert.match(windowsSource, /SetEnvironmentVariable\("BRIDGE_RELAY_PORT", "\$relayPort", "Process"\)/u);
  assert.match(windowsSource, /SetEnvironmentVariable\("BRIDGE_PUBLIC_RELAY_URL", \$relayUrl, "Process"\)/u);
  assert.match(windowsSource, /SetEnvironmentVariable\("BRIDGE_ANDROID_RELAY", "ws:\/\/10\.0\.2\.2:\$relayPort\/ws", "Process"\)/u);
  assert.match(windowsSource, /& \$adb forward tcp:0 "localabstract:\$webviewSocket"/u);
  assert.doesNotMatch(windowsSource, /webview_devtools_remote_\\d\+/u, "Windows QA must scope WebView DevTools socket discovery to Bridge PID");
  assert.match(windowsSource, /pidof com\.localbridge\.mobile[\s\S]*?webview_devtools_remote_\(\?:/u);
  assert.match(windowsSource, /forward --remove tcp:\$androidPort/u);
  for (const key of [
    "BRIDGE_RELAY_PORT", "BRIDGE_ANDROID_CDP", "BRIDGE_ANDROID_RELAY",
    "USERPROFILE", "HOME", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA",
    "CODEX_HOME", "BRIDGE_USER_DATA", "BRIDGE_SERVICE_DATA_PATH", "BRIDGE_CLAUDE_INSPECTOR_URL",
  ]) {
    assert.match(windowsSource, new RegExp(`^  "${key}"[,\\r]?$`, "mu"), `${key} must be saved/restored`);
  }
  for (const key of ["USERPROFILE", "HOME", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "CODEX_HOME", "BRIDGE_USER_DATA", "BRIDGE_SERVICE_DATA_PATH", "BRIDGE_CLAUDE_INSPECTOR_URL"]) {
    assert.match(windowsSource, new RegExp(`SetEnvironmentVariable\\("${key}",`), `${key} must be isolated`);
  }
  assert.match(windowsSource, /SetEnvironmentVariable\("BRIDGE_CLAUDE_INSPECTOR_URL", "http:\/\/127\.0\.0\.1:1", "Process"\)/u);
  assert.match(windowsSource, /Set-QaProfile -Root \$smokeRoot[\s\S]*?Start-Process @smokeStart/u);
  assert.match(windowsSource, /Set-QaProfile -Root \$qaRoot[\s\S]*?Start-Process @desktopStart/u);
  assert.match(windowsSource, /if \(\$env:RUNNER_ENVIRONMENT -eq "github-hosted"\)\s*\{\s*\$installResult = Start-Process -FilePath \$installer\.FullName[\s\S]*?\} else \{[\s\S]*?Join-Path \$installer\.DirectoryName "win-unpacked"[\s\S]*?Copy-Item -LiteralPath \$unpackedDir -Destination \$installRoot -Recurse/u);
  assert.match(windowsSource, /finally\s*\{[\s\S]*?SetEnvironmentVariable\(\$key, \$originalEnvironment\[\$key\], "Process"\)/u);
  assert.match(windowsSource, /\$installPrefix = \[IO\.Path\]::GetFullPath\(\$installRoot\)\.TrimEnd\('\\'\)\s*\+\s*'\\'[\s\S]*?StartsWith\(\$installPrefix,\s*\[StringComparison\]::OrdinalIgnoreCase\)/u);
  assert.match(windowsSource, /if \(\$env:RUNNER_ENVIRONMENT -eq "github-hosted"\)\s*\{\s*\$uninstaller =[\s\S]*?-ArgumentList @\("\/currentuser", "\/S"\)[\s\S]*?if \(-not \$env:BRIDGE_RECYCLE_STAGING\) \{[\s\S]*?Remove-Item -LiteralPath \$scratch -Recurse -Force/u);
  assert.match(windowsSource, /Invoke-NpmScript -Name "test:desktop:pairing"/u);
});

test("Android installed pairing smoke waits for delayed WebView pairing input mount before screenshot and fill", async () => {
  let mounted = false;
  let paired = false;
  let catalogMounted = false;
  let evaluateCalls = 0;
  let filledValue = null;
  let socketClosed = false;
  let desktopClosed = false;
  let report = null;
  const screenshots = [];

  class FakeWebSocket {
    constructor() {
      this.listeners = new Map();
      queueMicrotask(() => this.emit("open", {}));
    }
    addEventListener(type, listener) {
      const list = this.listeners.get(type) ?? [];
      list.push(listener);
      this.listeners.set(type, list);
    }
    emit(type, event) {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
    send(raw) {
      const { id, method, params } = JSON.parse(raw);
      let result = {};
      if (method === "Page.captureScreenshot") {
        screenshots.push({ path: screenshots.length, mounted, catalogMounted });
        result = { data: Buffer.from("png").toString("base64") };
      } else if (method === "Runtime.evaluate") {
        evaluateCalls += 1;
        const expr = params.expression;
        if (expr.includes("Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')")) {
          if (!mounted) {
            result = { exceptionDetails: { exception: { description: "Error: Pairing input missing" } } };
          } else {
            const match = expr.match(/set\.call\(input,\s*("[^"]+")\)/u);
            filledValue = match ? JSON.parse(match[1]) : "";
            result = { result: { value: undefined } };
          }
        } else if (expr.includes('Boolean(document.querySelector(\'input[aria-label="配对链接"]\'))')) {
          if (evaluateCalls >= 2) mounted = true;
          result = { result: { value: mounted } };
        } else if (expr.includes("连接电脑")) {
          assert.ok(filledValue, "Pairing input must be filled before clicking connect");
          paired = true;
          result = { result: { value: undefined } };
        } else if (expr.includes(".m-host-chip .m-status-dot.is-online")) {
          result = { result: { value: paired } };
        } else if (expr.includes("Boolean(document.querySelector('.mobile-home-catalog'))")) {
          assert.equal(paired, true, "Home session catalog must mount after pairing succeeds");
          catalogMounted = true;
          result = { result: { value: true } };
        } else if (expr.includes(".m-host-name")) {
          assert.equal(catalogMounted, true, "Host name must be read from the mobile home catalog");
          result = { result: { value: "DESKTOP-CI" } };
        } else {
          throw new Error(`Unexpected Android WebView expression: ${expr}`);
        }
      }
      queueMicrotask(() => this.emit("message", { data: JSON.stringify({ id, result }) }));
    }
    close() {
      socketClosed = true;
    }
  }

  const desktopSnapshot = {
    pairingUrl: "bridge://pair/fixture",
    host: { name: "DESKTOP-CI", version: desktopPackage.version },
    devices: [{ deviceId: "dev-android-1", online: true }],
    sessions: [],
  };
  const desktopWindow = {
    bridgeDesktop: {
      async createPairing() { return desktopSnapshot; },
      async getSnapshot() { return desktopSnapshot; },
    },
  };
  const desktopPage = {
    url: () => "file:///D:/work/bridge/renderer/index.html",
    evaluate: async (fn, arg) => new Function("window", `return (${fn.toString()})(arguments[1]);`)(desktopWindow, arg),
  };

  await new AsyncFunction(
    "assert", "mkdir", "writeFile", "resolve",
    "bridgeEndpoint", "encodePairingBundle", "pairingBundleFromUrl",
    "chromium", "process", "fetch", "WebSocket", "setTimeout",
    androidE2eSource.replace(/^import .*;\r?\n/gmu, ""),
  )(
    assert,
    async () => {},
    async () => {},
    resolve,
    (url, priority, label) => ({ url, priority, label }),
    (bundle) => `encoded:${bundle.deviceId}:${bundle.relayUrl}`,
    () => ({ deviceId: "dev-android-1", relayUrl: "ws://127.0.0.1:8788/ws" }),
    {
      async connectOverCDP() {
        return {
          contexts: () => [{ pages: () => [desktopPage] }],
          async close() { desktopClosed = true; },
        };
      },
    },
    {
      env: { BRIDGE_ANDROID_SMOKE_PAIRING_ONLY: "1" },
      stdout: { write(value) { report = JSON.parse(value); } },
    },
    async () => ({
      async json() {
        return [{ type: "page", url: "https://localhost/", webSocketDebuggerUrl: "ws://127.0.0.1:9224/devtools/page/1" }];
      },
    }),
    FakeWebSocket,
    (callback) => queueMicrotask(callback),
  );

  assert.equal(report?.ok, true);
  assert.equal(report?.mode, "pairing-only");
  assert.equal(filledValue, "encoded:dev-android-1:ws://10.0.2.2:8788/ws");
  assert.equal(screenshots[0]?.mounted, true, "01-pairing.png must be captured after the pairing input mounts");
  assert.equal(screenshots[1]?.catalogMounted, true, "02-paired-smoke.png must be captured with the mobile home catalog mounted");
  assert.equal(socketClosed, true);
  assert.equal(desktopClosed, true);
});

test("Android installed pairing smoke polls DevTools /json when initial 200 responses have not registered https://localhost/ yet", async () => {
  let jsonCalls = 0;
  let report = null;

  class FakeWebSocket {
    constructor() {
      this.listeners = new Map();
      queueMicrotask(() => this.emit("open", {}));
    }
    addEventListener(type, listener) {
      const list = this.listeners.get(type) ?? [];
      list.push(listener);
      this.listeners.set(type, list);
    }
    emit(type, event) {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
    send(raw) {
      const { id, method, params } = JSON.parse(raw);
      let result = {};
      if (method === "Page.captureScreenshot") {
        result = { data: Buffer.from("png").toString("base64") };
      } else if (method === "Runtime.evaluate") {
        const expr = params.expression;
        if (
          expr.includes('Boolean(document.querySelector(\'input[aria-label="配对链接"]\'))')
          || expr.includes(".m-host-chip .m-status-dot.is-online")
          || expr.includes("Boolean(document.querySelector('.mobile-home-catalog'))")
        ) {
          result = { result: { value: true } };
        } else if (expr.includes(".m-host-name")) {
          result = { result: { value: "DESKTOP-CI" } };
        } else {
          result = { result: { value: undefined } };
        }
      }
      queueMicrotask(() => this.emit("message", { data: JSON.stringify({ id, result }) }));
    }
    close() {}
  }

  const desktopSnapshot = {
    pairingUrl: "bridge://pair/fixture",
    host: { name: "DESKTOP-CI", version: desktopPackage.version },
    devices: [{ deviceId: "dev-android-1", online: true }],
    sessions: [],
  };
  const desktopWindow = {
    bridgeDesktop: {
      async createPairing() { return desktopSnapshot; },
      async getSnapshot() { return desktopSnapshot; },
    },
  };
  const desktopPage = {
    url: () => "file:///D:/work/bridge/renderer/index.html",
    evaluate: async (fn, arg) => new Function("window", `return (${fn.toString()})(arguments[1]);`)(desktopWindow, arg),
  };

  await new AsyncFunction(
    "assert", "mkdir", "writeFile", "resolve",
    "bridgeEndpoint", "encodePairingBundle", "pairingBundleFromUrl",
    "chromium", "process", "fetch", "WebSocket", "setTimeout",
    androidE2eSource.replace(/^import .*;\r?\n/gmu, ""),
  )(
    assert,
    async () => {},
    async () => {},
    resolve,
    (url, priority, label) => ({ url, priority, label }),
    (bundle) => `encoded:${bundle.deviceId}:${bundle.relayUrl}`,
    () => ({ deviceId: "dev-android-1", relayUrl: "ws://127.0.0.1:8788/ws" }),
    {
      async connectOverCDP() {
        return {
          contexts: () => [{ pages: () => [desktopPage] }],
          async close() {},
        };
      },
    },
    {
      env: { BRIDGE_ANDROID_SMOKE_PAIRING_ONLY: "1" },
      stdout: { write(value) { report = JSON.parse(value); } },
    },
    async () => {
      jsonCalls += 1;
      return {
        async json() {
          if (jsonCalls === 1) return [];
          if (jsonCalls === 2) return [{ type: "page", url: "about:blank", webSocketDebuggerUrl: "ws://127.0.0.1:9224/devtools/page/0" }];
          return [{ type: "page", url: "https://localhost/", webSocketDebuggerUrl: "ws://127.0.0.1:9224/devtools/page/1" }];
        },
      };
    },
    FakeWebSocket,
    (callback) => queueMicrotask(callback),
  );

  assert.equal(report?.ok, true);
  assert.ok(jsonCalls >= 3, `Expected connectWebView to poll /json until https://localhost/ registered; got ${jsonCalls} call(s)`);
});

test("Android emulator readiness gate waits past boot_completed=1 until guest eth0 route and Active default network are up", { skip: process.platform !== "win32" }, async () => {
  const winCiSource = await readFile(new URL("../scripts/win-local-ci.ps1", import.meta.url), "utf8");
  const step8Start = winCiSource.indexOf("# 8. Wait for Android Emulator");
  const step8End = winCiSource.indexOf('Invoke-Checked "Packaged Windows QA');
  assert.notEqual(step8Start, -1, "Missing step 8 Android Emulator readiness boundary in win-local-ci.ps1");
  assert.notEqual(step8End, -1, "Missing Packaged Windows QA boundary in win-local-ci.ps1");
  const readinessSlice = winCiSource.slice(step8Start, step8End).replaceAll("Start-Sleep -Seconds 2", "Start-Sleep -Milliseconds 20");

  const directory = await mkdtemp(join(tmpdir(), "bridge-android-ready-"));
  try {
    const stateFile = join(directory, "adb-state.json");
    const fakeAdbJs = join(directory, "fake-adb.mjs");
    const fakeAdbCmd = join(directory, "adb.cmd");
    const gateScript = join(directory, "gate.ps1");
    await writeFile(stateFile, JSON.stringify({ polls: 0, lastRoute: "", lastNet: "none", calls: [] }));
    await writeFile(fakeAdbJs, `
      import { readFileSync, writeFileSync } from "node:fs";
      const statePath = ${JSON.stringify(stateFile)};
      const args = process.argv.slice(2).join(" ");
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      state.calls.push(args);
      if (args.includes("getprop sys.boot_completed")) {
        state.polls += 1;
        state.lastRoute = state.polls >= 2 ? "10.0.2.0/24 dev eth0 proto kernel scope link src 10.0.2.15" : "";
        state.lastNet = state.polls >= 3 ? "100" : "none";
        writeFileSync(statePath, JSON.stringify(state));
        process.stdout.write("1\\n");
      } else if (args.includes("ip route")) {
        writeFileSync(statePath, JSON.stringify(state));
        if (state.lastRoute) process.stdout.write(state.lastRoute + "\\n");
      } else if (args.includes("dumpsys connectivity")) {
        writeFileSync(statePath, JSON.stringify(state));
        process.stdout.write("  Active default network: " + state.lastNet + "\\n");
      }
    `);
    await writeFile(fakeAdbCmd, `@"${process.execPath}" "${fakeAdbJs}" %*\r\n`);
    await writeFile(gateScript, `
      $ErrorActionPreference = "Stop"
      $adb = ${JSON.stringify(fakeAdbCmd)}
      $avdName = "bridge-ci-api36-0"
      $env:ANDROID_SERIAL = "emulator-5560"
      ${readinessSlice}
    `);
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", gateScript], { encoding: "utf8" });
    assert.equal(result.status, 0, `Step 8 gate script threw unexpectedly:\n${result.stdout}\n${result.stderr}`);
    const finalState = JSON.parse(await readFile(stateFile, "utf8"));
    assert.match(finalState.lastRoute, /10\.0\.2\.0\/24/u, `Step 8 readiness gate released with boot_completed=1 while guest eth0 route was still empty (calls=${JSON.stringify(finalState.calls)})`);
    assert.equal(
      finalState.lastNet,
      "100",
      `Step 8 readiness gate released with boot_completed=1 while guest Active default network=${finalState.lastNet} (calls=${JSON.stringify(finalState.calls)})`,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Wait-HttpEndpoint fails immediately when the monitored process exits early", { skip: process.platform !== "win32" }, () => {
  const waitFnEnd = windowsSource.search(/^function Invoke-NpmScript \{/mu);
  assert.notEqual(waitFnEnd, -1, "Missing Invoke-NpmScript boundary in windows-packaged-qa.ps1");
  const waitFnSlice = windowsSource.slice(windowsSource.indexOf("function Wait-HttpEndpoint {"), waitFnEnd);
  const result = spawnSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command",
    `${waitFnSlice}\n$proc = Start-Process -FilePath "cmd.exe" -ArgumentList @("/c", "exit 7") -WindowStyle Hidden -Wait -PassThru\nWait-HttpEndpoint -Url "http://127.0.0.1:1/health" -TimeoutSeconds 30 -Process $proc`,
  ], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exited with code 7 while waiting for http:\/\/127\.0\.0\.1:1\/health/u);
});

test("reusing a Windows CI slot preserves the previous run's retained staging", { skip: process.platform !== "win32" }, async () => {
  const source = await readFile(new URL("./win-local-ci.ps1", import.meta.url), "utf8");
  const allocation = source.match(/^\$tempDir = .+$/mu)[0] + '\n' + source.match(/^\$recycleStaging = .+$/mu)[0];
  const directory = await mkdtemp(join(tmpdir(), "bridge-ci-retained-staging-"));
  try {
    const fixture = join(directory, "staging.ps1");
    await writeFile(fixture, `
      $ErrorActionPreference = "Stop"
      $cacheRoot = $env:BRIDGE_QA_TEST_ROOT
      $ownsTempRoot = $true
      $slot = 0
      ${allocation}
      $retained = $recycleStaging
      New-Item -ItemType Directory -Path $retained | Out-Null
      Set-Content -LiteralPath (Join-Path $retained "evidence.txt") -Value "retained" -NoNewline
      ${allocation}
      if ($retained -eq $recycleStaging) { throw "STAGING_REUSED" }
      Write-Output $retained
    `);
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", fixture], {
      encoding: "utf8", env: { ...process.env, BRIDGE_QA_TEST_ROOT: directory },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(join(result.stdout.trim(), "evidence.txt"), "utf8"), "retained");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Windows CI restores temporary environment before the caller starts another Node process", { skip: process.platform !== "win32" }, async () => {
  const source = await readFile(new URL('./win-local-ci.ps1', import.meta.url), 'utf8');
  const directory = await mkdtemp(join(tmpdir(), 'bridge-ci-temp-env-'));
  try {
    const fixture = join(directory, 'environment.ps1');
    const probe = join(directory, 'next-node.cjs');
    await writeFile(probe, `process.stdout.write('NEXT_NODE_OK');`);
    await writeFile(fixture, `
      $ErrorActionPreference = 'Stop'
      $keys = @('BRIDGE_TEST_TEMP_ROOT', 'TEMP', 'TMP', 'TMPDIR', 'BRIDGE_RECYCLE_STAGING')
      $callerRoot = $env:BRIDGE_QA_TEST_ROOT
      $cacheRoot = $callerRoot
      $env:TEMP = $env:TMP = $env:TMPDIR = $callerRoot
      $env:BRIDGE_RECYCLE_STAGING = Join-Path $callerRoot 'caller-staging'
      if ($env:BRIDGE_ENV_CASE -eq 'inherited') {
        $env:BRIDGE_TEST_TEMP_ROOT = Join-Path $callerRoot 'inherited'
        New-Item -ItemType Directory -Path $env:BRIDGE_TEST_TEMP_ROOT | Out-Null
      } else { [Environment]::SetEnvironmentVariable('BRIDGE_TEST_TEMP_ROOT', $null, 'Process') }
      $expected = @{}
      foreach ($key in $keys) { $expected[$key] = [Environment]::GetEnvironmentVariable($key, 'Process') }
      function Invoke-Checked { param($Label, $Command); & $Command }
      function Invoke-CiTemp {
        ${source.match(/^\$temporaryEnvironment =[^]*?(?=^try \{)/mu)?.[0] ?? ''}
        ${source.match(/^\$ownsTempRoot = .+\r?\n\$tempDir = .+$/mu)[0]}
        if ($ownsTempRoot) { New-Item -ItemType Directory -Path $tempDir | Out-Null }
        ${source.match(/^\$recycleStaging = .+$/mu)[0]}
        ${source.match(/^\$env:(?:BRIDGE_TEST_TEMP_ROOT|TEMP|TMP|TMPDIR|BRIDGE_RECYCLE_STAGING) = .+$/gmu).join('\n')}
        try {} finally {
          ${source.match(/^    if \(\$ownsTempRoot\) \{[^]*?^    \}/mu)[0]}
          ${source.match(/^  foreach \(\$key in \$temporaryEnvironment.Keys\) \{[^]*?^  \}/mu)?.[0] ?? ''}
        }
        if (($env:BRIDGE_ENV_CASE -eq 'inherited') -ne (Test-Path -LiteralPath $tempDir)) { throw 'ROOT_OWNERSHIP_CHANGED' }
      }
      Invoke-CiTemp
      & node.exe --require ${JSON.stringify(fileURLToPath(new URL('./recycle-cleanup.cjs', import.meta.url)))} ${JSON.stringify(probe)}
      if ($LASTEXITCODE -ne 0) { throw 'NEXT_NODE_FAILED' }
      $actual = @{}
      foreach ($key in $keys) { $actual[$key] = [Environment]::GetEnvironmentVariable($key, 'Process') }
      Write-Output ('ENV=' + (ConvertTo-Json -InputObject @{ expected = $expected; actual = $actual } -Compress))
    `);
    for (const mode of ['standalone', 'inherited']) {
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', fixture], {
        env: { ...process.env, BRIDGE_QA_TEST_ROOT: directory, BRIDGE_ENV_CASE: mode }, encoding: 'utf8',
      });
      assert.equal(result.status, 0, `${mode}: ${result.stderr}`);
      assert.match(result.stdout, /NEXT_NODE_OK/u);
      const { expected, actual } = JSON.parse(/ENV=(.+)/u.exec(result.stdout)[1]);
      assert.deepEqual(actual, expected, `${mode} must restore the caller's temporary environment`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent Windows CI callers each take a free slot and a fifth caller waits for one to release", { skip: process.platform !== "win32" }, async () => {
  const { spawn } = await import("node:child_process");
  const { once } = await import("node:events");
  const source = await readFile(new URL("../scripts/win-local-ci.ps1", import.meta.url), "utf8");
  const acquisition = source.slice(source.indexOf("$slotCount ="), source.indexOf("$ciWorktree =")).replaceAll("ClaudeDesktopBridgeWinCi", `ClaudeDesktopBridgeWinCi-Test-${process.pid}`);
  assert.match(acquisition, /Acquired win-local-ci slot/u, "Missing Windows CI slot acquisition boundary");
  const directory = await mkdtemp(join(tmpdir(), "bridge-ci-mutex-"));
  const children = [];
  try {
    const fixture = join(directory, "mutex.ps1");
    await writeFile(fixture, `
param([string]$Root)
$ErrorActionPreference = "Stop"
${acquisition}
  while (-not (Test-Path (Join-Path $Root "release-$slot"))) { Start-Sleep -Milliseconds 50 }
} finally {
  if ($slot -ge 0) { $slotMutexes[$slot].ReleaseMutex() }
  foreach ($slotMutex in $slotMutexes) { $slotMutex.Dispose() }
}
`);
    const launch = () => {
      const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", fixture, "-Root", directory]);
      children.push(child);
      let output = "";
      child.stdout.on("data", chunk => { output += chunk; });
      return { child, output: () => output, done: once(child, "exit") };
    };
    const waitForOutput = async (run, pattern) => {
      const deadline = Date.now() + 15_000;
      let match;
      while (!(match = run.output().match(pattern))) {
        assert.equal(run.child.exitCode, null, run.output());
        assert.ok(Date.now() < deadline, `Timed out waiting for ${pattern}: ${run.output()}`);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      return match;
    };
    const holders = [];
    for (let index = 0; index < 4; index += 1) {
      const holder = launch();
      holder.slot = Number((await waitForOutput(holder, /Acquired win-local-ci slot (\d)/u))[1]);
      holders.push(holder);
    }
    assert.deepEqual(holders.map(holder => holder.slot).sort(), [0, 1, 2, 3]);
    const waiter = launch();
    await waitForOutput(waiter, /All 4 win-local-ci slots busy/u);
    assert.doesNotMatch(waiter.output(), /Acquired win-local-ci slot/u);
    await writeFile(join(directory, "release-2"), "release");
    assert.equal((await holders.find(holder => holder.slot === 2).done)[0], 0);
    assert.equal((await waitForOutput(waiter, /Acquired win-local-ci slot (\d)/u))[1], "2");
    for (const slot of [0, 1, 3]) await writeFile(join(directory, `release-${slot}`), "release");
    for (const run of [...holders, waiter]) assert.equal((await run.done)[0], 0, run.output());
  } finally {
    for (const child of children) {
      if (child.exitCode === null) child.kill();
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("Windows QA WebView socket discovery ignores unrelated PIDs and waits for Bridge PID socket", { skip: process.platform !== "win32" }, async () => {
  const socketStart = windowsSource.indexOf("    $webviewSocket = $null");
  const socketEnd = windowsSource.indexOf("    $androidPort =");
  assert.notEqual(socketStart, -1, "Missing $webviewSocket loop start in windows-packaged-qa.ps1");
  assert.notEqual(socketEnd, -1, "Missing $androidPort boundary in windows-packaged-qa.ps1");
  const discoverySlice = windowsSource.slice(socketStart, socketEnd).replaceAll("Start-Sleep -Milliseconds 300", "Start-Sleep -Milliseconds 20");

  const directory = await mkdtemp(join(tmpdir(), "bridge-webview-socket-"));
  try {
    const stateFile = join(directory, "adb-state.json");
    const fakeAdbJs = join(directory, "fake-adb.mjs");
    const fakeAdbCmd = join(directory, "adb.cmd");
    const probeScript = join(directory, "probe.ps1");
    await writeFile(stateFile, JSON.stringify({ unixPolls: 0 }));
    await writeFile(fakeAdbJs, `
      import { readFileSync, writeFileSync } from "node:fs";
      const statePath = ${JSON.stringify(stateFile)};
      const args = process.argv.slice(2).join(" ");
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      if (args.includes("pidof com.localbridge.mobile")) {
        process.stdout.write("3106\\r\\n");
      } else if (args.includes("cat /proc/net/unix")) {
        state.unixPolls += 1;
        writeFileSync(statePath, JSON.stringify(state));
        const lines = ["00000000: 00000002 00000000 00010000 0001 01 12345 @webview_devtools_remote_1790"];
        if (state.unixPolls >= 2) {
          lines.push("00000000: 00000002 00000000 00010000 0001 01 12346 @webview_devtools_remote_31060");
          lines.push("00000000: 00000002 00000000 00010000 0001 01 12347 @webview_devtools_remote_3106");
        }
        process.stdout.write(lines.join("\\r\\n") + "\\r\\n");
      }
    `);
    await writeFile(fakeAdbCmd, `@"${process.execPath}" "${fakeAdbJs}" %*\r\n`);
    await writeFile(probeScript, `
      $ErrorActionPreference = "Stop"
      $adb = ${JSON.stringify(fakeAdbCmd)}
      ${discoverySlice}
    `);
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", probeScript], { encoding: "utf8" });
    assert.equal(result.status, 0, `WebView socket discovery script failed:\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Android WebView DevTools socket: webview_devtools_remote_3106/u);
    assert.match(result.stdout, /Android Bridge PID: 3106/u);
    const finalState = JSON.parse(await readFile(stateFile, "utf8"));
    assert.equal(finalState.unixPolls, 2, "Must ignore PID 1790 on poll 1 and select PID 3106 (not 31060) on poll 2");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
