import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import test from "node:test";

const qaSource = await readFile(new URL("./packaged-desktop-qa.mjs", import.meta.url), "utf8");
const windowsSource = await readFile(new URL("./windows-packaged-qa.ps1", import.meta.url), "utf8");
const androidE2eSource = await readFile(new URL("./android-installed-e2e.mjs", import.meta.url), "utf8");
const desktopPackage = JSON.parse(await readFile(new URL("../apps/desktop/package.json", import.meta.url), "utf8"));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// Native snapshot from controller.snapshot(): no SDK provider/default-mode fields,
// and no session.rewind capability while the inspector is disconnected.
function nativeSnapshot() {
  return {
    host: {
      version: desktopPackage.version,
      pairingEpoch: 1,
      capabilities: [
        "evidence.v1", "evidence.details.v1", "artifact.preview.v1",
        "artifact.transfer.v1", "artifact.text-preview.v1", "workspace.upload.v1",
        "claude.native-relay.v1",
        "directory.browse.v1", "runtime.adapter.v1", "session.visibility.v1",
        "session.commands.v1", "session.command.v1", "subagent.stop.v1",
        "turn.queue.steer.v1", "turn.queue.cancel.v1", "plugin.magpie-quota.v1",
      ],
    },
    projects: [], sessions: [], devices: [], permissions: [],
    runtime: {
      state: "unavailable", activeTurns: 0, maxParallelTurns: 0,
      desktopIntegration: { state: "disconnected", enabled: true, canRestart: false },
    },
    runtimes: [{ id: "claude-desktop", state: "unavailable", capabilities: ["session.list", "session.history"] }],
    connection: "connected",
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
  const result = await runQa(nativeSnapshot());
  assert.equal(result.report.ok, true);
  for (const method of ["runtime.list", "project.list", "session.list", "provider.list", "conversation.route.get"]) {
    assert.ok(result.requests.includes(method), `${method} was not verified`);
  }
  assert.ok(result.ui.includes(".desktop-sidebar-empty"));
  assert.ok(result.ui.includes("连接与启动"));
  assert.ok(result.ui.includes("诊断与关于"));
  assert.ok(result.ui.includes('dt:text-is("原生中转") + dd'));
  assert.ok(result.ui.includes("已就绪"));
});

test("packaged QA keeps Native configuration/evidence checks with optional runtime capabilities", async () => {
  const snapshot = nativeSnapshot();
  snapshot.host.capabilities.push("session.rewind.v1", "session.rename.v1");
  snapshot.runtime.state = "ready";
  snapshot.runtime.desktopIntegration.state = "ready";
  snapshot.runtimes[0].state = "ready";
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

test("hosted Windows QA retains data while local recycle failures still fail", { skip: process.platform !== "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "bridge-qa-retention-"));
  try {
    for (const name of ["qa", "smoke", "install"]) {
      await mkdir(join(directory, name));
      await writeFile(join(directory, name, "retained.txt"), "retained");
    }
    const fixture = join(directory, "cleanup.ps1");
    await writeFile(fixture, `
      $ErrorActionPreference = "Stop"
      $environmentKeys = @()
      $qaRoot = Join-Path $env:BRIDGE_QA_TEST_ROOT "qa"
      $smokeRoot = Join-Path $env:BRIDGE_QA_TEST_ROOT "smoke"
      $installRoot = Join-Path $env:BRIDGE_QA_TEST_ROOT "install"
      function node.exe { throw "RECYCLE_CALLED" }
      try { if ($env:BRIDGE_QA_TEST_FAILURE) { throw $env:BRIDGE_QA_TEST_FAILURE } } finally {
      ${windowsSource.slice(windowsSource.indexOf("  foreach ($key in $environmentKeys) {", windowsSource.indexOf("} finally {")))}
    `);
    for (const [environment, failure] of [["github-hosted", ""], ["self-hosted", ""], ["github-hosted", "QA_ASSERTION_FAILED"]]) {
      const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", fixture], {
        encoding: "utf8", env: { ...process.env, BRIDGE_QA_TEST_ROOT: directory, RUNNER_ENVIRONMENT: environment, BRIDGE_QA_TEST_FAILURE: failure },
      });
      if (environment === "github-hosted" && !failure) {
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /Packaged QA data retained/u);
      } else {
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, new RegExp(failure || "RECYCLE_CALLED", "u"));
      }
      for (const name of ["qa", "smoke", "install"]) assert.equal(await readFile(join(directory, name, "retained.txt"), "utf8"), "retained");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Windows QA keeps the local public relay and isolates both app launches", () => {
  assert.match(windowsSource, /SetEnvironmentVariable\("BRIDGE_PUBLIC_RELAY_URL", \$relayUrl, "Process"\)/u);
  for (const key of ["USERPROFILE", "HOME", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "CODEX_HOME", "BRIDGE_USER_DATA", "BRIDGE_SERVICE_DATA_PATH", "BRIDGE_CLAUDE_INSPECTOR_URL"]) {
    assert.match(windowsSource, new RegExp(`^  "${key}"[,\\r]?$`, "mu"), `${key} must be saved/restored`);
    assert.match(windowsSource, new RegExp(`SetEnvironmentVariable\\("${key}",`), `${key} must be isolated`);
  }
  assert.match(windowsSource, /SetEnvironmentVariable\("BRIDGE_CLAUDE_INSPECTOR_URL", "http:\/\/127\.0\.0\.1:1", "Process"\)/u);
  assert.match(windowsSource, /Set-QaProfile -Root \$smokeRoot[\s\S]*?Start-Process @smokeStart/u);
  assert.match(windowsSource, /Set-QaProfile -Root \$qaRoot[\s\S]*?Start-Process @desktopStart/u);
  assert.match(windowsSource, /finally\s*\{[\s\S]*?SetEnvironmentVariable\(\$key, \$originalEnvironment\[\$key\], "Process"\)/u);
  assert.match(windowsSource, /Get-ChildItem -LiteralPath \$installRoot -Filter "Uninstall\*\.exe"[\s\S]*?-ArgumentList @\("\/currentuser", "\/S"\)[\s\S]*?-Wait[\s\S]*?recycle-cleanup\.cjs/u);
  assert.match(windowsSource, /Invoke-NpmScript -Name "test:desktop:pairing"/u);
});

test("Android installed pairing smoke waits for delayed WebView pairing input mount before screenshot and fill", async () => {
  let mounted = false;
  let paired = false;
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
        screenshots.push({ path: screenshots.length, mounted });
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
        } else if (expr.includes(".m-host-name")) {
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
  assert.equal(socketClosed, true);
  assert.equal(desktopClosed, true);
});

