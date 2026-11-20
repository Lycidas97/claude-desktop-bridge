import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const endpoint = process.env.BRIDGE_DESKTOP_CDP ?? "http://127.0.0.1:9223";
const artifacts = resolve("artifacts", "packaged-desktop");
const desktopPackage = JSON.parse(await readFile(resolve("apps", "desktop", "package.json"), "utf8"));
await mkdir(artifacts, { recursive: true });

const browser = await chromium.connectOverCDP(endpoint);
try {
  let page;
  const startedAt = Date.now();
  while (!page && Date.now() - startedAt < 5_000) {
    page = browser.contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => candidate.url().startsWith("file:"));
    if (!page) await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  assert.ok(page, "Packaged Bridge renderer was not found");
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => Boolean(window.bridgeDesktop));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(window.bridgeDesktop));
  await page.waitForFunction(async () => (
    (await window.bridgeDesktop.getSnapshot()).connection === "connected"
  ));
  await page.locator(".desktop-session-sidebar").waitFor();
  const snapshot = await page.evaluate(() => window.bridgeDesktop.getSnapshot());
  assert.equal(snapshot.host.version, desktopPackage.version);
  assert.ok(Number.isInteger(snapshot.host.pairingEpoch) && snapshot.host.pairingEpoch >= 1);
  // Require the stable Native contract; rewind and rename depend on availability.
  for (const capability of [
    "artifact.preview.v1",
    "artifact.text-preview.v1",
    "artifact.transfer.v1",
    "claude.native-relay.v1",
    "directory.browse.v1",
    "evidence.details.v1",
    "evidence.v1",
    "plugin.magpie-quota.v1",
    "runtime.adapter.v1",
    "session.command.v1",
    "session.commands.v1",
    "session.visibility.v1",
    "subagent.stop.v1",
    "system.update.v1",
    "turn.queue.cancel.v1",
    "turn.queue.steer.v1",
    "workspace.upload.v1",
  ]) {
    assert.ok(snapshot.host.capabilities.includes(capability), `Missing Native capability: ${capability}`);
  }
  for (const capability of ["provider.profile.v1", "conversation.lanes.v1", "conversation.handoff.v1", "permission.policy.v1", "permission.runtime-defaults.v1", "runtime.handoff.v1"]) {
    assert.equal(snapshot.host.capabilities.includes(capability), false, `Retired capability: ${capability}`);
  }
  assert.equal(snapshot.host.defaultPermissionMode, undefined);
  assert.equal(snapshot.providers, undefined);
  assert.ok(Array.isArray(snapshot.projects));
  assert.ok(Array.isArray(snapshot.sessions));
  assert.ok(Array.isArray(snapshot.devices));
  assert.ok(Array.isArray(snapshot.permissions));
  assert.ok(Array.isArray(snapshot.runtimes));
  assert.deepEqual(snapshot.runtimes.map(runtime => runtime.id), ["claude-desktop"]);
  assert.ok(["ready", "working", "auth-required", "unavailable"].includes(snapshot.runtime.state));
  assert.equal(snapshot.runtime.maxParallelTurns, 0);
  assert.equal(snapshot.runtime.desktopIntegration.enabled, true);
  assert.equal(snapshot.runtime.desktopIntegration.canRestart, false);
  const nativeRuntime = snapshot.runtimes.find((runtime) => runtime.id === "claude-desktop");
  assert.ok(nativeRuntime, "Native Claude Desktop runtime was not reported");
  assert.ok(nativeRuntime.capabilities.includes("session.list"));
  assert.ok(nativeRuntime.capabilities.includes("session.history"));
  for (const session of snapshot.sessions.filter((session) => !session.runtimeId || session.runtimeId === "claude-desktop")) {
    assert.equal(session.transport, "claude-desktop-native");
    assert.equal(session.source, "desktop");
  }

  const ipcProof = {};
  for (const [method, field] of [["runtime.list", "runtimes"], ["project.list", "projects"], ["session.list", "sessions"]]) {
    const response = await page.evaluate((method) => window.bridgeDesktop.request({ method, params: {} }), method);
    assert.equal(response.ok, true, `${method}: ${response.error?.message}`);
    assert.ok(Array.isArray(response.result[field]), `${method} did not return ${field}`);
    if (method === "runtime.list") {
      assert.ok(response.result.runtimes.some((runtime) => runtime.id === "claude-desktop"));
    }
    ipcProof[method] = response.result[field].length;
  }
  if (snapshot.host.capabilities.includes("plugin.assistant-mail.v1")) {
    assert.equal(snapshot.assistantMail.automaticDelivery, false);
    assert.equal(typeof snapshot.assistantMail.changeToken, "string");
    assert.equal(snapshot.assistantMail.cards, undefined, "Mail bodies and pages stay outside the bounded snapshot");
    const mail = await page.evaluate(() => window.bridgeDesktop.request({ method: "plugin.assistant-mail.list", params: { limit: 1 } }));
    assert.equal(mail.ok, true, mail.error?.message);
    assert.ok(Array.isArray(mail.result.mailPage.cards));
    assert.ok(mail.result.mailPage.cards.length <= 1);
    ipcProof["plugin.assistant-mail.list"] = mail.result.mailPage.cards.length;
  }
  if (snapshot.host.capabilities.includes("assistant.proposal.v1")) {
    assert.equal(typeof snapshot.assistantProposals.changeToken, "string");
    assert.ok(Number.isInteger(snapshot.assistantProposals.pendingCount));
    assert.equal(snapshot.assistantProposals.proposals, undefined);
    const pending = await page.evaluate(() => window.bridgeDesktop.request({ method: "assistant.proposal.list", params: { limit: 1 } }));
    assert.equal(pending.ok, true, pending.error?.message);
    assert.ok(Array.isArray(pending.result.proposals) && pending.result.proposals.length <= 1);
    ipcProof["assistant.proposal.list"] = pending.result.proposals.length;
  }
  const updaterStatus = await page.evaluate(() => window.bridgeDesktop.request({ method: "system.update", params: { action: "status" } }));
  assert.equal(updaterStatus.ok, true, `system.update: ${updaterStatus.error?.message}`);
  assert.equal(updaterStatus.result.currentVersion, desktopPackage.version);
  ipcProof["system.update"] = updaterStatus.result.phase;
  for (const method of ["provider.list", "conversation.route.get"]) {
    const response = await page.evaluate((method) => window.bridgeDesktop.request({ method, params: {} }), method);
    assert.equal(response.ok, false, `${method} must be unsupported for Native relay`);
    assert.equal(response.error?.code, "UNSUPPORTED", `${method} must return UNSUPPORTED`);
    ipcProof[method] = response.error.code;
  }

  let configurationProof;
  let evidenceProof;
  const selectedSession = snapshot.sessions.find((session) => session.transport === "claude-desktop-native");
  if (selectedSession) {
    const configurationResponse = await page.evaluate((sessionId) => window.bridgeDesktop.request({
      method: "session.configuration", params: { sessionId },
    }), selectedSession.sessionId);
    assert.equal(configurationResponse.ok, true, configurationResponse.error?.message);
    const configuration = configurationResponse.result.configuration;
    assert.equal(configuration.sessionId, selectedSession.sessionId);
    assert.equal(configuration.modelSource, "claude-desktop");
    assert.equal(configuration.effortSource, "claude-desktop");
    assert.equal(configuration.permissionPolicy, undefined);
    assert.ok(Array.isArray(configuration.availableModels));
    assert.ok(configuration.availableEffortLevels.includes("high"));
    configurationProof = { sessionId: configuration.sessionId, models: configuration.availableModels.length };

    const evidenceResponse = await page.evaluate((sessionId) => window.bridgeDesktop.request({
      method: "evidence.list", params: { sessionId, limit: 30 },
    }), selectedSession.sessionId);
    assert.equal(evidenceResponse.ok, true, evidenceResponse.error?.message);
    assert.equal(evidenceResponse.result.evidence.sessionId, selectedSession.sessionId);
    assert.ok(Array.isArray(evidenceResponse.result.evidence.items));
    evidenceProof = { sessionId: selectedSession.sessionId, items: evidenceResponse.result.evidence.items.length };
    if (snapshot.sessions[0] === selectedSession) {
      if (selectedSession.allowedActions?.canConfigure) {
        await page.getByRole("button", { name: "会话设置", exact: true }).click();
        const dialog = page.getByRole("dialog");
        await dialog.waitFor();
        await dialog.getByRole("button", { name: "关闭", exact: true }).click();
      }
      await page.locator(".session-view-switch").getByRole("button", { name: /^成果/ }).click();
      await page.locator(".evidence-panel, .evidence-empty").waitFor();
    }
  }
  if (snapshot.sessions.length === 0) {
    await page.getByText(snapshot.runtime.desktopIntegration.state === "ready" ? "暂无活跃会话" : "未检测到 Claude Desktop", { exact: true }).waitFor();
    await page.locator(".session-catalog-empty-action").getByText("新建会话", { exact: true }).waitFor();
  }
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("heading", { name: "设置", exact: true }).waitFor();
  await page.getByRole("button", { name: "手机配对与设备", exact: true }).click();
  await page.getByRole("button", { name: "添加手机", exact: true }).waitFor();
  await page.getByRole("button", { name: "Claude 接入", exact: true }).click();
  const inspector = page.getByRole("region", { name: "调试连接监测", exact: true });
  await inspector.waitFor();
  if (snapshot.claudeInspector?.state === "closed") await inspector.getByText(`如需连接，请在 Claude Desktop 中${snapshot.claudeInspector.platform === "win32" ? "按 Alt 显示菜单，再" : "手动"}勾选 Developer › Enable Main Process Debugger，Bridge 会自动连接。`, { exact: true }).waitFor();
  if (snapshot.claudeInspector?.startup?.state === "accessibility-required" && snapshot.claudeInspector.state === "closed") await inspector.getByRole("button", { name: "打开辅助功能设置", exact: true }).waitFor();
  if (snapshot.claudeInspector?.startup && !["waiting", "accessibility-required"].includes(snapshot.claudeInspector.startup.state)) await inspector.getByText(/历史启动记录/u).waitFor();
  await page.getByRole("button", { name: "Magpie 额度", exact: true }).click();
  await page.locator(".magpie-quota-board").waitFor();
  await page.getByRole("button", { name: "连接与启动", exact: true }).click();
  await page.getByRole("heading", { name: "连接", exact: true }).waitFor();
  await page.getByRole("button", { name: "诊断与支持", exact: true }).click();
  await page.locator('dt:text-is("原生中转") + dd').getByText("已就绪", { exact: true }).waitFor();
  await page.getByRole("checkbox", { name: /后台诊断记录/u }).waitFor();
  assert.equal(await page.getByRole("checkbox", { name: /后台诊断记录/u }).isChecked(), snapshot.diagnosticsEnabled);
  await page.getByRole("heading", { name: "版本与更新", exact: true }).waitFor();
  assert.deepEqual(errors, []);
  await page.screenshot({ path: resolve(artifacts, "desktop-evidence.png"), fullPage: true });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    url: page.url(),
    version: snapshot.host.version,
    projects: snapshot.projects.length,
    sessions: snapshot.sessions.length,
    devices: snapshot.devices.length,
    runtime: snapshot.runtime.state,
    nativeRuntime: { state: nativeRuntime.state, capabilities: nativeRuntime.capabilities },
    ipc: ipcProof,
    configuration: configurationProof,
    evidence: evidenceProof,
    screenshot: resolve(artifacts, "desktop-evidence.png"),
  }, null, 2)}\n`);
} finally {
  await browser.close();
}
