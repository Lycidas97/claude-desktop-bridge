import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const qaSource = await readFile(new URL("./packaged-desktop-qa.mjs", import.meta.url), "utf8");
const windowsSource = await readFile(new URL("./windows-packaged-qa.ps1", import.meta.url), "utf8");
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
        "claude.native-relay.v1", "permission.policy.v1", "permission.runtime-defaults.v1",
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
  assert.ok(result.ui.includes("原生中转已就绪"));
});

test("packaged QA keeps Native configuration/evidence checks with optional runtime capabilities", async () => {
  const snapshot = nativeSnapshot();
  snapshot.host.capabilities.push("session.rewind.v1", "session.rename.v1", "runtime.handoff.v1");
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
  assert.match(windowsSource, /Invoke-NpmScript -Name "test:desktop:pairing"/u);
});
