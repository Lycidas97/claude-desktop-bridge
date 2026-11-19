import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { buildPairingUrl } from "../packages/protocol/dist/index.js";
import { startRelayServer } from "../apps/relay/dist/server.js";
import {
  root, serve, remotePreview, projectGroupingPreview, sectionCreatePreview, nativePromptsPreview, assistantMailPreview, nativePreview, sessionId,
} from "./browser-e2e/config.mjs";
import { eventually, syncNativeSections } from "./browser-e2e/helpers.mjs";
import { createMockHost } from "./browser-e2e/mock-host.mjs";
import { verifyRename, verifyDelivery } from "./browser-e2e/scenarios/rename-delivery.mjs";
import { verifyNativeApprovals, verifyNativePromptsPr } from "./browser-e2e/scenarios/native-approvals.mjs";
import { verifyNativeMessages, verifyHistoryPagination, verifyNativeCompaction, verifyNativeBoundaries, verifyNativeSessionNotices } from "./browser-e2e/scenarios/native-conversation.mjs";
import { verifyNativeQueueActions } from "./browser-e2e/scenarios/native-queue.mjs";
import { verifySessionCatalog, addScrollProjects, verifyProjectGrouping, verifySectionManage } from "./browser-e2e/scenarios/workspace.mjs";
import { verifyRound4Boundaries, verifyRound5Ux } from "./browser-e2e/scenarios/cross-surface.mjs";
import { verifyDesktopDiagnostics, verifyDesktopQuota, verifyDesktopConversation } from "./browser-e2e/scenarios/desktop.mjs";
import { verifyMobileSafeArea } from "./browser-e2e/scenarios/mobile-safe-area.mjs";
import { verifyAssistantMail, verifyAssistantMailHistory, verifyAssistantMailUnread } from "./browser-e2e/scenarios/assistant-mail.mjs";
import { scanDesktopPairingQr } from "./browser-e2e/scenarios/pairing-qr.mjs";
import { createPreviousPairedHost, verifyPairedHostStatus } from "./browser-e2e/scenarios/paired-host-status.mjs";
import { incomingFileFixture, installIncomingFileFixture, verifyIncomingFile } from "./browser-e2e/scenarios/incoming-file.mjs";

// This is an isolated host fixture, not a Desktop or model integration test.
// Run via npm run test:browser after protocol/relay have been built. CHROME_PATH
// optionally selects a local Chrome; otherwise playwright-core's installed
// Chromium is used. All contexts are new, headless, and use the actual App.
let previewHost;
let previewApproval;
const port = serve ? Number(process.env.BRIDGE_E2E_PORT ?? 0) : 0;
assert.ok(Number.isInteger(port) && port >= 0 && port <= 65535, "BRIDGE_E2E_PORT must be a valid loopback port");
const artifactRoot = resolve(root, "artifacts/browser-e2e");
const runDir = resolve(artifactRoot, `${new Date().toISOString().replaceAll(":", "-")}-${process.pid}`);
const inheritedVite = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("VITE_")));
const results = [];
const infrastructureErrors = [];
const hosts = new Set();
const relayPeers = new Map();
let relay;
let vite;
let browser;
let baseUrl;
const nativeHosts = [];
const allScenarios = ["rename-list", "rename-chat", "delivery-approval-reconnect", "native-approvals", "native-prompts-pr", "native-messages", "history-pagination", "native-boundaries", "native-compaction", "native-queue-actions", "native-session-notices", "project-grouping", "session-catalog", "section-manage", "round4-boundaries", "round5-ux", "desktop-diagnostics", "desktop-quota", "desktop-conversation", "mobile-safe-area", "assistant-mail", "assistant-mail-history", "assistant-mail-unread", "incoming-file", "paired-host-status", "pairing-qr"];
const scenarios = process.env.BRIDGE_E2E_SCENARIOS ? process.env.BRIDGE_E2E_SCENARIOS.split(",") : allScenarios;
assert.ok(scenarios.every(scenario => allScenarios.includes(scenario)), "BRIDGE_E2E_SCENARIOS must name existing scenarios");
const themes = process.env.BRIDGE_QA_THEME ? [process.env.BRIDGE_QA_THEME] : ["light", "dark"];
assert.ok(themes.every(theme => ["light", "dark"].includes(theme)), "BRIDGE_QA_THEME must be light or dark");
const themeFamily = process.env.BRIDGE_QA_THEME_FAMILY ?? "sunstone";
assert.ok(["sunstone", "apple"].includes(themeFamily), "BRIDGE_QA_THEME_FAMILY must be sunstone or apple");
const enableTrace = process.env.BRIDGE_E2E_TRACE === "1";

async function runScenario(theme, scenario, mockHostRuntime) {
  const name = `${themeFamily === "sunstone" ? "" : `${themeFamily}-`}${theme}-${scenario}`;
  const directory = resolve(runDir, name);
  await mkdir(directory, { recursive: true });
  const errors = [];
  const browserLog = [];
  const steps = [];
  const viewports = [];
  const startedAt = Date.now();
  const serverRoutes = [];
  const assistantMail = ["assistant-mail", "assistant-mail-history", "assistant-mail-unread", "round5-ux"].includes(scenario);
  let context;
  let page;
  let host;
  let firstHost;
  let failure;
  try {
    host = await createMockHost(mockHostRuntime, !assistantMail && !["delivery-approval-reconnect", "native-approvals", "native-prompts-pr", "native-messages", "history-pagination", "native-boundaries", "native-compaction", "native-queue-actions", "native-session-notices", "project-grouping", "session-catalog", "section-manage", "round4-boundaries", "desktop-conversation", "incoming-file"].includes(scenario), scenario !== "delivery-approval-reconnect", errors, assistantMail || ["native-approvals", "native-prompts-pr", "native-messages", "native-boundaries", "native-compaction", "native-queue-actions", "native-session-notices", "project-grouping", "session-catalog", "section-manage", "round4-boundaries", "desktop-conversation", "incoming-file"].includes(scenario), ["native-queue-actions", "desktop-conversation"].includes(scenario), ["section-manage", "round4-boundaries", "round5-ux"].includes(scenario), assistantMail, scenario === "round5-ux" ? { desktopName: "LycidasdeMac-mini", initialMailCount: 0 } : scenario === "assistant-mail-unread" ? { initialMailCount: 0 } : scenario === "assistant-mail-history" ? { initialMailCount: 0, initialMailHistory: 25 } : {});
    if (["native-queue-actions", "native-compaction"].includes(scenario)) host.queueSeed = await host.syncNativeQueue(await host.nativeApproval.enqueue("历史中的原生排队消息"), { pushEvents: false });
    if (["project-grouping", "session-catalog"].includes(scenario)) Object.assign(host.snapshot, await host.nativeApproval.projectCatalog());
    if (["section-manage", "round4-boundaries", "round5-ux"].includes(scenario)) await syncNativeSections(host);
    const touch = ["mobile-safe-area", "native-queue-actions"].includes(scenario);
    context = await browser.newContext({
      viewport: { width: 375, height: 812 }, colorScheme: theme,
      ...(scenario === "assistant-mail" ? { timezoneId: "America/Los_Angeles" } : {}),
      isMobile: touch, hasTouch: touch,
      serviceWorkers: "block",
    });
    await context.addInitScript(({ mode, family }) => {
      localStorage.setItem("bridge-theme", mode);
      localStorage.setItem("bridge-theme-family", family);
    }, { mode: theme, family: themeFamily });
    if (scenario === "project-grouping") {
      await context.addInitScript(({ hostId, projectIds }) => {
        const key = `bridge-project-order:${hostId}`;
        if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(projectIds));
      }, { hostId: host.pairing.roomId, projectIds: [...host.snapshot.projects].reverse().map(project => project.projectId) });
    }
    if (scenario === "incoming-file") await context.addInitScript(installIncomingFileFixture, incomingFileFixture);
    const allowedOrigins = new Set([new URL(baseUrl).origin, new URL(relay.url.replace("ws:", "http:")).origin]);
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.protocol === "data:" || url.protocol === "blob:" || allowedOrigins.has(url.origin)) {
        await route.continue();
      } else {
        errors.push(`Blocked non-fixture HTTP request: ${url.href}`);
        await route.abort("blockedbyclient");
      }
    });
    await context.routeWebSocket("**/*", (socket) => {
      const url = new URL(socket.url());
      if (url.hostname === "127.0.0.1" && [new URL(baseUrl).port, new URL(relay.url).port].includes(url.port)) {
        socket.connectToServer();
        if (url.pathname === "/ws") serverRoutes.push(socket);
      } else {
        errors.push(`Blocked non-fixture WebSocket: ${url.href}`);
        socket.close({ code: 1008, reason: "Isolated E2E only permits its loopback servers" });
      }
    });
    page = await context.newPage();
    page.setDefaultTimeout(15_000);
    page.on("console", (message) => {
      browserLog.push({ type: message.type(), text: message.text(), location: message.location() });
      if (message.type() === "error") errors.push(`browser console: ${message.text()}`);
    });
    page.on("pageerror", (error) => {
      browserLog.push({ type: "pageerror", text: error.stack });
      errors.push(`browser runtime: ${error.stack}`);
    });
    if (enableTrace) await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    if (scenario === "incoming-file") {
      firstHost = await createMockHost(mockHostRuntime, false, false, errors, true, false, false, false, { desktopName: "文件接收电脑" });
    } else if (scenario === "paired-host-status") {
      firstHost = await createPreviousPairedHost(mockHostRuntime, errors);
    }
    if (firstHost) {
      await page.goto(buildPairingUrl(baseUrl, firstHost.pairing), { waitUntil: "domcontentloaded" });
      const firstSwitcher = page.getByRole("button", { name: `当前电脑：${firstHost.pairing.desktopName}，切换电脑` });
      if (scenario === "paired-host-status") await page.getByText(firstHost.session.title, { exact: true }).waitFor();
      await firstSwitcher.click();
      await page.getByRole("button", { name: "扫码添加新电脑" }).click();
      await page.getByRole("textbox", { name: "配对链接" }).fill(buildPairingUrl(baseUrl, host.pairing));
      await page.getByRole("button", { name: "连接电脑", exact: true }).click();
      if (scenario === "incoming-file") {
        await page.getByRole("button", { name: /当前电脑：Browser E2E 隔离电脑/ }).waitFor();
        await page.goto(`${baseUrl}/?file-import`, { waitUntil: "domcontentloaded" });
      } else {
        await page.getByText(host.session.title, { exact: true }).waitFor();
        firstHost.socket.close();
        await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      }
    } else if (scenario === "pairing-qr") await scanDesktopPairingQr(context, page, host, steps, baseUrl);
    else await page.goto(buildPairingUrl(baseUrl, host.pairing), { waitUntil: "domcontentloaded" });
    await page.locator(".mobile-home-catalog").waitFor();
    await page.locator(`.mobile-home-catalog [data-session-id="${sessionId}"]`).waitFor({ state: "attached" });
    await eventually(() => host.requests.some((request) => request.method === "snapshot.get"), true, "Pairing requires an encrypted snapshot handshake");
    assert.equal(await page.locator("html").getAttribute("data-theme"), process.env.BRIDGE_QA_THEME ?? theme);
    assert.equal(await page.locator("html").getAttribute("data-theme-family"), process.env.BRIDGE_QA_THEME_FAMILY ?? "sunstone");
    assert.equal(await page.locator(".mobile-home-catalog [data-session-id]").count(), ["project-grouping", "session-catalog", "section-manage", "round4-boundaries", "round5-ux"].includes(scenario) ? 3 : 2, "Pairing must synchronize the home catalog session rows");
    assert.equal(await page.evaluate(() => Boolean(window.bridgeDesktop)), false, "Test must load the mobile App path");
    assert.equal(await page.evaluate(() => innerWidth), 375);
    steps.push("real App pairing and encrypted snapshot synchronize the session list at 375x812");
    if (scenario === "assistant-mail") await verifyAssistantMail(page, host, steps, directory, viewports, baseUrl);
    else if (scenario === "assistant-mail-history") await verifyAssistantMailHistory(page, host, steps, directory, viewports);
    else if (scenario === "assistant-mail-unread") await verifyAssistantMailUnread(page, host, steps, directory, viewports, baseUrl);
    else if (scenario === "incoming-file") await verifyIncomingFile(page, host, firstHost, steps, directory);
    else if (scenario === "paired-host-status") await verifyPairedHostStatus(page, firstHost, host, steps, directory);
    else if (scenario === "mobile-safe-area") await verifyMobileSafeArea(page, steps, directory, viewports);
    else if (scenario === "session-catalog") await verifySessionCatalog(page, host, steps, directory, viewports, baseUrl);
    else if (scenario === "desktop-diagnostics") await verifyDesktopDiagnostics(page, host, steps, baseUrl);
    else if (scenario === "desktop-quota") await verifyDesktopQuota(page, host, steps, directory, viewports, baseUrl);
    else if (scenario === "desktop-conversation") await verifyDesktopConversation(page, host, steps, directory, viewports, baseUrl);
    else if (scenario === "native-approvals") await verifyNativeApprovals(page, host, steps, directory, baseUrl, serverRoutes);
    else if (scenario === "native-prompts-pr") await verifyNativePromptsPr(page, host, steps, directory, baseUrl);
    else if (scenario === "native-messages") await verifyNativeMessages(page, host, steps, directory);
    else if (scenario === "history-pagination") await verifyHistoryPagination(page, host, steps, directory);
    else if (scenario === "native-boundaries") await verifyNativeBoundaries(page, host, steps, directory);
    else if (scenario === "native-compaction") await verifyNativeCompaction(page, host, steps, directory);
    else if (scenario === "native-queue-actions") await verifyNativeQueueActions(page, host, steps, directory, relayPeers);
    else if (scenario === "native-session-notices") await verifyNativeSessionNotices(page, host, steps, directory);
    else if (scenario === "project-grouping") await verifyProjectGrouping(page, host, steps, directory);
    else if (scenario === "section-manage") await verifySectionManage(page, host, steps, directory);
    else if (scenario === "round4-boundaries") await verifyRound4Boundaries(page, host, steps, directory, viewports, theme, baseUrl);
    else if (scenario === "round5-ux") await verifyRound5Ux(page, host, steps, directory, viewports, theme);
    else if (scenario === "delivery-approval-reconnect") await verifyDelivery(page, host, steps, relayPeers);
    else if (scenario !== "pairing-qr") await verifyRename(page, host, scenario === "rename-list" ? "list" : "chat", steps);
    if (!assistantMail) assert.equal(host.requests.some(request => request.method.startsWith("plugin.assistant-mail.")), false, "Hosts without the capability receive no assistant mail RPC");
    assert.deepEqual(errors, [], "Browser runtime, console, network isolation, or host errors");
  } catch (error) {
    failure = error;
  } finally {
    if (failure && page) {
      try {
        await page.screenshot({ path: resolve(directory, "failure.png"), fullPage: true, timeout: 5_000 });
        await writeFile(resolve(directory, "failure.html"), await page.content());
      } catch (error) { errors.push(`failure capture: ${error.stack}`); }
    }
    if (context) {
      if (enableTrace) {
        try {
          await context.tracing.stop(failure ? { path: resolve(directory, "trace.zip") } : {});
        } catch (error) { errors.push(`trace cleanup: ${error.stack}`); }
      }
      // Complete owned relay handshakes before Chromium tears down their sockets.
      for (const route of serverRoutes) await route.close({ code: 1000, reason: "Scenario complete" });
      await eventually(() => [...relayPeers.values()].filter(hello => hello.roomId === host.pairing.roomId && hello.role === "mobile").length, 0, "Scenario sockets close before disposing their browser context");
      try { await context.close(); } catch (error) { errors.push(`context cleanup: ${error.stack}`); }
    }
    host?.close();
    firstHost?.close();
    await writeFile(resolve(directory, "browser-errors.json"), JSON.stringify({ errors, console: browserLog }, null, 2));
    // No pairing secrets, tokens, or encrypted envelopes are written to reports.
    await writeFile(resolve(directory, "host-rpc.json"), JSON.stringify({
      requests: host?.requests.map(({ method, requestId, idempotencyKey, params }) => ({
        method, requestId, idempotencyKey,
        params: params?.credential === undefined ? params : { ...params, credential: "[redacted]" },
      })),
      resumeBatches: host?.resumeBatches,
      nativeTrace: host?.nativeTrace,
      ...(host?.nativeQueue ? { nativeCalls: host.nativeApproval.calls, receipts: host.nativeApproval.receipts(), queueEvents: host.events } : {}),
    }, null, 2));
    for (const fixture of [host?.nativeApproval, firstHost?.nativeApproval]) {
      if (!fixture) continue;
      const idx = nativeHosts.indexOf(fixture);
      if (idx !== -1) nativeHosts.splice(idx, 1);
      await fixture.close();
    }
  }
  const result = {
    name, theme, themeFamily, viewport: viewports.length ? viewports : "375x812", status: failure || errors.length ? "failed" : "passed",
    durationMs: Date.now() - startedAt, steps, errors,
    ...(failure ? { failure: failure.stack } : {}),
    artifacts: directory,
  };
  await writeFile(resolve(directory, "result.json"), JSON.stringify(result, null, 2));
  console.log(`${result.status.toUpperCase()} ${name} (${result.durationMs}ms)${failure ? `: ${failure.message}` : ""}`);
  return result;
}

await mkdir(runDir, { recursive: true });
try {
  const { build } = await import("esbuild");
  const nativeModule = resolve(runDir, "native-approval-host.mjs");
  await build({
    entryPoints: [resolve(root, "scripts/fixtures/native-approval-host.ts")], outfile: nativeModule,
    bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent",
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
    plugins: [{ name: "synthetic-electron", setup(builder) {
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "synthetic-electron" }));
      builder.onLoad({ filter: /.*/, namespace: "synthetic-electron" }, () => ({
        contents: 'module.exports = { shell: { openPath() { throw new Error("Native shell unavailable in approval fixture"); }, openExternal() { throw new Error("Native shell unavailable in approval fixture"); } } };', loader: "js",
      }));
    } }],
  });
  const { startNativeApprovalHost } = await import(pathToFileURL(nativeModule).href);
  // Vite must not read a developer's .env or inherit production VITE_* values.
  for (const key of Object.keys(inheritedVite)) delete process.env[key];
  relay = await startRelayServer({
    host: "127.0.0.1", port: 0, roomCreationsPerIpPerHour: 1000,
    pushDispatcher: { wake: async () => false },
    logger: { info() {}, warn() {}, error: (...args) => infrastructureErrors.push(args.join(" ")) },
  });
  relay.wsServer.on("connection", (socket) => {
    socket.once("message", (data) => {
      const frame = JSON.parse(String(data));
      if (frame.type === "hello") relayPeers.set(socket, frame);
    });
    socket.on("close", () => relayPeers.delete(socket));
  });
  Object.assign(process.env, {
    VITE_BRIDGE_PUBLIC_RELAY_URL: relay.url,
    VITE_BRIDGE_SERVICE_ORIGIN: relay.url.replace("ws:", "http:").replace(/\/ws$/u, ""),
    VITE_BRIDGE_ICE_SERVERS: "[]",
  });
  const { createServer, createLogger } = await import("vite");
  const { default: react } = await import("@vitejs/plugin-react");
  const logger = createLogger("warn");
  const logError = logger.error.bind(logger);
  logger.error = (message, options) => {
    // Reload/reconnect scenarios close sockets; retain their reset logs while
    // keeping proxy connection failures, HTTP errors and app assertions fatal.
    if (!["ECONNRESET", "EPIPE"].includes(options?.error?.code) || !/ws proxy(?: socket)? error:/u.test(message)) infrastructureErrors.push(message);
    logError(message, options);
  };
  vite = await createServer({
    configFile: false, envDir: false,
    root: resolve(root, "apps/client"),
    cacheDir: resolve(runDir, "vite-cache"),
    plugins: [react(), {
      name: "synthetic-native-preview",
      configureServer(server) {
        if (!nativePreview && !remotePreview) return;
        server.middlewares.use("/__bridge_test", (request, response) => {
          void (async () => {
            const url = new URL(request.url, "http://127.0.0.1");
            let result;
            if (request.method === "GET" && url.pathname === "/pairing") {
              result = { url: buildPairingUrl(baseUrl, previewHost.pairing) };
            } else if (assistantMailPreview && url.pathname === "/mail") {
              if (request.method === "POST") await previewHost.nativeApproval.assistantMail.deliver(1);
              result = { assistantMail: previewHost.snapshot.assistantMail, count: previewHost.nativeApproval.assistantMail.service.page({ limit: 100 }).events.length };
            } else if (sectionCreatePreview && url.pathname === "/sections") {
              const fixture = previewHost.nativeApproval.sections;
              if (request.method === "POST") {
                if (url.searchParams.has("failure")) fixture.failure = url.searchParams.get("failure") === "true" ? "Native section limit reached" : "";
                if (url.searchParams.has("supported")) fixture.supported = url.searchParams.get("supported") !== "false";
                if (url.searchParams.has("manageSupported")) fixture.manageSupported = url.searchParams.get("manageSupported") !== "false";
                if (url.searchParams.has("scope")) fixture.scope = url.searchParams.get("scope");
                if (url.searchParams.get("connection") === "offline") previewHost.socket.close();
                if (url.searchParams.get("connection") === "connected") previewHost.socket.connect();
                await fixture.reread();
                await syncNativeSections(previewHost);
                if (!["offline", "connected"].includes(url.searchParams.get("connection"))) await previewHost.send({ kind: "snapshot", snapshot: previewHost.snapshot });
              }
              result = { projects: previewHost.snapshot.projects, sessions: previewHost.snapshot.sessions,
                miscRoot: previewHost.nativeApproval.miscRoot, calls: fixture.calls, scope: fixture.scope,
                persisted: JSON.parse(await readFile(fixture.profile, "utf8")),
                sectionRequests: previewHost.requests.filter(request => ["section.create", "section.move", "section.rename", "section.delete", "directory.mkdir", "session.create"].includes(request.method)).map(({ method, params }) => ({ method, params })),
                errors: infrastructureErrors };
            } else if (remotePreview && request.method === "GET" && url.pathname === "/remote/state") {
              result = previewHost.remoteState();
            } else if (remotePreview && request.method === "POST" && url.pathname === "/remote/finish") {
              await previewHost.finishRemoteWork();
              result = previewHost.remoteState();
            } else if (remotePreview && request.method === "POST" && url.pathname === "/remote/disconnect") {
              const peers = [...relayPeers].filter(([, hello]) => hello.roomId === previewHost.pairing.roomId &&
                hello.role === "mobile" && hello.deviceId === previewHost.pairing.deviceId);
              const snapshotGetCountBefore = previewHost.requests.filter(request => request.method === "snapshot.get").length;
              for (const [socket] of peers) socket.close(1012, "synthetic remote reconnect");
              result = { disconnected: peers.length, snapshotGetCountBefore };
            } else if (nativePromptsPreview && url.pathname === "/prompts" && ["GET", "POST"].includes(request.method)) {
              if (request.method === "POST") {
                const chunks = [];
                for await (const chunk of request) chunks.push(chunk);
                const input = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
                if (["applyPrWrites", "choicesAvailable", "supported"].some(key => input[key] !== undefined)) {
                  await previewHost.syncNativeDialogs({ ...await previewHost.nativeApproval.setPromptsPrPolicy({
                    ...(input.applyPrWrites !== undefined ? { applyPrWrites: input.applyPrWrites } : {}),
                    ...(input.choicesAvailable !== undefined ? { choicesAvailable: input.choicesAvailable } : {}),
                    ...(input.supported !== undefined ? { supported: input.supported } : {}),
                  }), events: [] });
                }
                if (input.action === "answer-local") {
                  await previewHost.syncNativeDialogs(await previewHost.nativeApproval.answerPromptLocally(input.promptId));
                } else if (input.kind) {
                  assert.ok(["refusal-fallback", "auto-mode-server-fallback", "lanyard-consent", "violin-bow", "cwd-trust"].includes(input.kind), "Unknown synthetic Native prompt kind");
                  await previewHost.syncNativeDialogs(await previewHost.nativeApproval.openPrompt(input.kind));
                }
              }
              result = { ...previewHost.nativeApproval.dialogs(), calls: previewHost.nativeApproval.calls,
                requests: previewHost.requests.filter(request => ["prompt.list", "prompt.resolve", "pr.autoFix.read", "pr.autoFix.set"].includes(request.method)).map(({ method, params }) => ({ method, params })),
                errors: infrastructureErrors };
            } else if (nativePreview && request.method === "POST" && url.pathname === "/queue") {
              const chunks = [];
              for await (const chunk of request) chunks.push(chunk);
              const input = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
              const seeded = await previewHost.syncNativeQueue(await previewHost.nativeApproval.enqueue(input.text ?? "原生排队预览消息", input.mode === "steered" ? "steered" : "deferred"));
              result = { receipt: seeded.receipt, pendingCommandIds: seeded.session.pendingCommandIds };
            } else if (nativePreview && request.method === "POST" && url.pathname === "/queue-reply") {
              const queued = url.searchParams.get("queued") !== "false";
              previewHost.nativeApproval.queuedReply(queued);
              result = { queued };
            } else if (nativePreview && request.method === "POST" && url.pathname === "/rewind-readback") {
              previewHost.nativeApproval.failRewindReadback(url.searchParams.get("method") === "getTranscriptPage" ? "getTranscriptPage" : "getSession");
              result = { armed: true };
            } else if (nativePreview && request.method === "POST" && url.pathname === "/message") {
              const chunks = [];
              for await (const chunk of request) chunks.push(chunk);
              const events = await previewHost.nativeApproval.message(JSON.parse(Buffer.concat(chunks).toString("utf8")));
              await previewHost.syncNativeQueue({ events, history: await previewHost.nativeApproval.history(), session: previewHost.nativeApproval.session() });
              result = { events: events.length };
            } else if (nativePreview && request.method === "POST" && url.pathname === "/request") {
              previewApproval = url.searchParams.get("kind") === "question"
                ? await previewHost.nativeApproval.open("AskUserQuestion", { questions: [{ question: "接下来要做什么？", options: [{ label: "复核全文" }, { label: "修订摘要" }], multiSelect: url.searchParams.get("multi") === "true" }] })
                : await previewHost.nativeApproval.open("Bash", { command: "synthetic-native-mode --never-executed" });
              previewHost.nativeResponse = undefined;
              void previewApproval.response.then(reply => { previewHost.nativeResponse = reply; })
                .catch(error => infrastructureErrors.push(error.stack));
              result = { requestId: previewApproval.request.requestId };
            } else if (nativePreview && request.method === "POST" && url.pathname === "/observe") {
              await previewHost.nativeApproval.observe(url.searchParams.get("mode") ?? "bypassPermissions");
              result = { observed: true };
            } else if (nativePreview && request.method === "POST" && url.pathname === "/hold") {
              previewHost.session.turnState = "waiting";
              previewHost.session.desktopHandoff = { state: "desktop-inbox", inputStatus: "held", canReturn: false };
              await previewHost.send({ kind: "snapshot", snapshot: previewHost.snapshot });
              result = { held: true };
            } else if (nativePreview && request.method === "GET" && url.pathname === "/state") {
              result = { nativePermissionMode: previewHost.nativeApproval.permissionMode(), nativeResponse: previewHost.nativeResponse,
                queueReceipts: previewHost.nativeApproval.receipts(), nativeCalls: previewHost.nativeApproval.calls, failedRewindReadbacks: previewHost.nativeApproval.failedRewindReadbacks,
                requests: previewHost.requests.map(({ method, params }) => ({ method, nativeMode: params.nativeMode,
                  requestId: params.requestId, attachments: params.attachments?.length ?? 0 })), errors: infrastructureErrors };
            } else {
              response.statusCode = 404;
              response.end();
              return;
            }
            response.setHeader("Content-Type", "application/json");
            if (remotePreview || nativePromptsPreview) response.setHeader("Cache-Control", "no-store");
            response.end(JSON.stringify(result));
          })().catch(error => { response.statusCode = 500; response.end(error.message); });
        });
      },
    }], customLogger: logger,
    resolve: { alias: { "@bridge/protocol": resolve(root, "packages/protocol/src/index.ts") } },
    server: {
      host: "127.0.0.1", port, strictPort: true, open: false,
      // The App's CSP permits same-origin HTTP health checks. Proxying keeps
      // that policy intact while using the real isolated relay underneath.
      proxy: {
        "/ws": { target: relay.url.replace(/\/ws$/u, ""), ws: true },
        "/health": { target: relay.url.replace("ws:", "http:").replace(/\/ws$/u, "") },
      },
    },
  });
  // Vite's vite.listen() converts port 0 into 5173 (!configPort fallback).
  // Calling Vite's wrapped httpServer.listen directly runs initServer(true) and
  // proxy upgrades while letting the OS kernel assign a true ephemeral port for 0.
  await new Promise((onListen, onError) => {
    vite.httpServer.once("error", onError);
    vite.httpServer.listen(port, "127.0.0.1", () => {
      vite.httpServer.off("error", onError);
      onListen();
    });
  });
  baseUrl = `http://${nativePreview || remotePreview ? "localhost" : "127.0.0.1"}:${vite.httpServer.address().port}`;
  // Port 0 is allocated at listen time. Set Vite's public environment before
  // the first module is transformed, so probes and pairing use this origin.
  Object.assign(vite.config.env, {
    VITE_BRIDGE_PUBLIC_RELAY_URL: `${baseUrl.replace("http:", "ws:")}/ws`,
    VITE_BRIDGE_SERVICE_ORIGIN: baseUrl,
    VITE_BRIDGE_ICE_SERVERS: "[]",
  });
  const mockHostRuntime = { baseUrl, runDir, startNativeApprovalHost, hosts, nativeHosts };
  if (serve) {
    const stopped = new Promise((finish) => {
      process.once("SIGINT", finish);
      process.once("SIGTERM", finish);
    });
    const host = await createMockHost(mockHostRuntime, !nativePreview && !remotePreview, false, infrastructureErrors, nativePreview, nativePreview,
      undefined, assistantMailPreview, assistantMailPreview && process.env.BRIDGE_E2E_SCENARIOS === "assistant-mail-history"
        ? { initialMailCount: 0, initialMailHistory: 25 } : {});
    previewHost = host;
    if (projectGroupingPreview) Object.assign(host.snapshot, await host.nativeApproval.projectCatalog());
    if (projectGroupingPreview && process.argv.includes("--project-order-scroll-preview")) addScrollProjects(host, 30);
    if (sectionCreatePreview) await syncNativeSections(host);
    if (nativePromptsPreview) await host.syncNativeDialogs(await host.nativeApproval.seedPullRequest());
    if (nativePreview && !assistantMailPreview && !projectGroupingPreview && !sectionCreatePreview && !nativePromptsPreview) {
      for (const [index, message] of [
        { type: "user", uuid: "preview-first", message: { content: "检查模型和额度" } },
        { type: "assistant", uuid: "preview-checkpoint", message: { content: [{ type: "text", text: "已建立回退检查点。" }] } },
        { type: "user", uuid: "preview-target", message: { content: "调整这条请求" } },
        { type: "assistant", uuid: "preview-answer", message: { content: [{ type: "text", text: "可从消息旁的回退入口预览对话和文件恢复。" }] } },
      ].entries()) await host.nativeApproval.message({ ...message, timestamp: Date.now() + index });
      host.history.push(...(await host.nativeApproval.history()).items);
    }
    console.log(remotePreview ? `Synthetic remote execution preview ready at ${baseUrl}`
      : nativePreview ? `Synthetic native preview ready at ${baseUrl}` : buildPairingUrl(baseUrl, host.pairing));
    await stopped;
  } else {
    browser = await chromium.launch({
      ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
      headless: true,
      args: ["--disable-background-networking", "--disable-component-update", "--no-first-run"],
    });
    const pairs = themes.flatMap((theme) => scenarios.map((scenario) => [theme, scenario]));
    const concurrency = Math.max(1, Number(process.env.BRIDGE_E2E_CONCURRENCY ?? 4));
    const ordered = new Array(pairs.length);
    let nextPair = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, pairs.length) }, async () => {
      while (nextPair < pairs.length) {
        const index = nextPair++;
        const [theme, scenario] = pairs[index];
        ordered[index] = await runScenario(theme, scenario, mockHostRuntime);
      }
    }));
    results.push(...ordered.filter(Boolean));
  }
} catch (error) {
  infrastructureErrors.push(error.stack);
} finally {
  if (browser) {
    try { await browser.close(); } catch (error) { infrastructureErrors.push(`browser cleanup: ${error.stack}`); }
  }
  for (const native of nativeHosts) await native.close();
  for (const host of hosts) host.close();
  // Finish the relay's WebSocket close handshakes while its proxy is still alive.
  if (relay) {
    try { await relay.close(); } catch (error) { infrastructureErrors.push(`relay cleanup: ${error.stack}`); }
  }
  if (vite) {
    try { await vite.close(); } catch (error) { infrastructureErrors.push(`Vite cleanup: ${error.stack}`); }
  }
  for (const key of Object.keys(process.env)) if (key.startsWith("VITE_")) delete process.env[key];
  Object.assign(process.env, inheritedVite);
  if (!serve) {
    const failed = infrastructureErrors.length > 0 || results.length !== scenarios.length * themes.length || results.some((result) => result.status === "failed");
    const report = {
      status: failed ? "failed" : "passed", browser: browser?.version(), node: process.version,
      client: resolve(root, "apps/client"), runDir,
      passed: results.filter((result) => result.status === "passed").length,
      failed: results.filter((result) => result.status === "failed").length,
      infrastructureErrors, results,
    };
    await writeFile(resolve(runDir, "report.json"), JSON.stringify(report, null, 2));
    await writeFile(resolve(artifactRoot, "report.json"), JSON.stringify(report, null, 2));
    console.log(`Browser E2E ${report.status}: ${report.passed}/${scenarios.length * themes.length} passed. Report: ${resolve(runDir, "report.json")}`);
    if (failed) process.exitCode = 1;
  }
  if (infrastructureErrors.length) {
    console.error(infrastructureErrors.join("\n"));
    process.exitCode = 1;
  }
}
