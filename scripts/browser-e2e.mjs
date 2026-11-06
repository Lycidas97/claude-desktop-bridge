import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";
import { BridgeCrypto, BridgeSocket, buildPairingUrl } from "../packages/protocol/dist/index.js";
import { startRelayServer } from "../apps/relay/dist/server.js";

// This is an isolated host fixture, not a Desktop or model integration test.
// Run via npm run test:browser after protocol/relay have been built. CHROME_PATH
// optionally selects a local Chrome; otherwise playwright-core's installed
// Chromium is used. All contexts are new, headless, and use the actual App.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Preview tools may run --serve without launching a browser. Only this debug
// mode accepts a fixed port; the automated suite always binds random ports.
const serve = process.argv.includes("--serve");
const port = serve ? Number(process.env.BRIDGE_E2E_PORT ?? 0) : 0;
assert.ok(Number.isInteger(port) && port >= 0 && port <= 65535, "BRIDGE_E2E_PORT must be a valid loopback port");
const artifactRoot = resolve(root, "artifacts/browser-e2e");
const runDir = resolve(artifactRoot, new Date().toISOString().replaceAll(":", "-"));
const sessionId = "browser-e2e-session";
const originalTitle = "隔离回归会话";
const renamedTitle = "隔离回归新名称";
const userText = "只发送一次的隔离测试消息";
const recoveredText = "断线期间积累的固定回复";
const replyText = "审批后完成的固定回复";
const inheritedVite = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("VITE_")));
const results = [];
const infrastructureErrors = [];
const hosts = new Set();
const relayPeers = new Map();
let relay;
let vite;
let browser;
let baseUrl;

// Bounded polling is only for observable browser/protocol state, never a fixed
// sleep intended to hide a race. Unexpected selector or transport errors surface.
async function eventually(read, expected, message, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  let actual;
  do {
    actual = await read();
    if (isDeepStrictEqual(actual, expected)) return;
    await delay(50);
  } while (Date.now() < deadline);
  assert.deepEqual(actual, expected, message);
}

async function createMockHost(queued, failFirstRename, errors) {
  const now = Date.now();
  const clientRelayUrl = `${baseUrl.replace("http:", "ws:")}/ws`;
  const { crypto, pairing } = await BridgeCrypto.createDesktop(clientRelayUrl, "Browser E2E 隔离电脑");
  pairing.iceServers = [];
  pairing.serviceOrigin = baseUrl;
  const session = {
    sessionId,
    projectId: "browser-e2e-project",
    projectName: "Browser E2E",
    cwd: "/browser-e2e/fixture",
    runtimeId: "claude-desktop",
    title: originalTitle,
    source: "desktop",
    ownership: "BRIDGE_IDLE",
    turnState: queued ? "queued" : "idle",
    lastActivityAt: now - 7_200_000,
    pendingCount: queued ? 1 : 0,
    pendingCommandIds: queued ? ["pre-existing-command"] : [],
    activeLaneId: `lane:${sessionId}`,
    activeProviderProfileId: "provider:e2e",
    routeState: "ready",
    allowedActions: {
      canSend: true, canSteer: true, canInterrupt: true,
      canConfigure: false, canSwitchProvider: false, canContinueOfficial: false,
    },
  };
  const snapshot = {
    host: {
      hostId: crypto.identity.hostId ?? crypto.identity.deviceId,
      pairingEpoch: pairing.pairingEpoch,
      name: pairing.desktopName,
      relayUrl: clientRelayUrl,
      online: true,
      lastSeenAt: now,
      version: "1.1.1",
      capabilities: ["session.rename.v1", "runtime.adapter.v1"],
      defaultPermissionMode: "standard",
    },
    projects: [{
      projectId: session.projectId, name: session.projectName, cwd: session.cwd,
      runtimeId: "claude-desktop", sessionCount: 2, runningCount: 0,
      pendingCount: session.pendingCount, lastActivityAt: now - 3_600_000,
    }],
    // A newer neighbour makes accidental activity/order changes observable.
    sessions: [{
      ...session, sessionId: "browser-e2e-neighbour", title: "较新的相邻会话",
      lastActivityAt: now - 3_600_000, turnState: "idle", pendingCount: 0, pendingCommandIds: [],
    }, session],
    devices: [{
      deviceId: pairing.deviceId, name: "隔离浏览器", platform: "web",
      online: true, createdAt: now, lastSeenAt: now,
    }],
    runtime: { state: "ready", detail: "固定响应宿主", activeTurns: 0, maxParallelTurns: 1 },
    runtimes: [{
      id: "claude-desktop", name: "Claude Desktop", state: "ready", detail: "隔离宿主",
      capabilities: ["session.list", "session.history", "turn.start", "permission.resolve"],
      sessionIsolation: "independent", sessionCount: 2, updatedAt: now,
    }],
    providers: [{
      id: "provider:e2e", kind: "claude-3p", name: "固定响应", status: "ready",
      configured: true, localOnlyConfiguration: false, readOnly: false, models: [], refreshedAt: now,
    }],
    permissions: [],
    latestSeq: 1,
  };
  const events = [];
  const history = [];
  const requests = [];
  const resumeBatches = [];
  let renameAttempts = 0;
  let turnRequest;
  const socket = new BridgeSocket({ crypto, role: "desktop", createRoom: true, reconnect: false });
  const host = {
    socket, crypto, pairing, session, snapshot, events, requests, resumeBatches,
    send: (payload) => socket.send(payload, "mobile", { crypto, toDeviceId: pairing.deviceId }),
    async emit(type, data, options = {}) {
      const event = {
        eventId: `browser-e2e-event-${++snapshot.latestSeq}`,
        sessionId, seq: snapshot.latestSeq, timestamp: Date.now(), origin: "claude-host",
        type, data,
        ...(options.turnId ? { turnId: options.turnId } : {}),
        ...(options.itemId ? { itemId: options.itemId } : {}),
      };
      events.push(event);
      if (!options.replayOnly) await host.send({ kind: "event", event });
      return event;
    },
    async accept() {
      assert.ok(turnRequest, "The host must receive turn.start before acceptance");
      history.push({
        id: "browser-e2e-user", sessionId, turnId: "browser-e2e-turn", role: "user",
        text: userText, createdAt: Date.now(), origin: "mobile",
      });
      await host.emit("user.message.accepted", {
        commandId: "browser-e2e-command", requestId: turnRequest.requestId,
        text: userText, delivery: "session-received",
      }, { turnId: "browser-e2e-turn", itemId: "browser-e2e-user" });
    },
    async requestApproval() {
      Object.assign(session, {
        turnState: "running", ownership: "BRIDGE_RUNNING", pendingCount: 0,
        pendingCommandIds: [], activeTurnId: "browser-e2e-turn",
      });
      await host.emit("turn.started", {
        commandId: "browser-e2e-command", requestId: turnRequest.requestId,
        delivery: "running", pendingCount: 0, pendingCommandIds: [],
      }, { turnId: "browser-e2e-turn" });
      const permission = {
        requestId: "browser-e2e-permission", sessionId, toolUseId: "browser-e2e-tool",
        toolName: "Bash", title: "隔离审批请求", description: "核对固定测试命令",
        input: { command: "fixture-command --no-execution" }, createdAt: Date.now(), canAllowAlways: false,
      };
      snapshot.permissions = [permission];
      session.turnState = "waiting";
      await host.emit("permission.requested", permission, { turnId: "browser-e2e-turn" });
    },
    async complete() {
      assert.equal(snapshot.permissions.length, 0, "Permission must be resolved before completion");
      const item = {
        id: "browser-e2e-assistant", sessionId, turnId: "browser-e2e-turn", role: "assistant",
        text: replyText, createdAt: Date.now(), origin: "claude-host",
      };
      history.push(item);
      await host.emit("assistant.completed", { text: item.text }, {
        turnId: item.turnId, itemId: item.id,
      });
      Object.assign(session, { turnState: "idle", ownership: "BRIDGE_IDLE" });
      delete session.activeTurnId;
      await host.emit("turn.completed", {
        commandId: "browser-e2e-command", requestId: turnRequest.requestId,
        delivery: "completed", pendingCount: 0, pendingCommandIds: [],
      }, { turnId: "browser-e2e-turn" });
    },
    close() {
      socket.close();
      hosts.delete(host);
    },
  };
  hosts.add(host);
  socket.onFrame((frame) => {
    if (frame.type === "presence" && frame.role === "mobile" && frame.online) {
      void host.send({ kind: "snapshot", snapshot }).catch((error) => errors.push(`mock host: ${error.stack}`));
    }
    if (frame.type === "error") errors.push(`mock relay: ${frame.code}: ${frame.message}`);
  });
  socket.onMessage((message, encrypted) => {
    void (async () => {
      if (message.payload.kind !== "request") {
        socket.ack([encrypted.id]);
        return;
      }
      const request = message.payload;
      requests.push(structuredClone(request));
      let result;
      let error;
      switch (request.method) {
        case "snapshot.get": result = { snapshot }; break;
        case "events.resume": {
          const resumed = events.filter((event) => event.seq > request.params.afterSeq);
          resumeBatches.push(resumed.map((event) => event.eventId));
          result = { events: resumed, latestSeq: snapshot.latestSeq, hasMore: false };
          break;
        }
        case "session.list": result = { sessions: snapshot.sessions }; break;
        case "project.list": result = { projects: snapshot.projects }; break;
        case "session.open":
          result = {
            session: snapshot.sessions.find((candidate) => candidate.sessionId === request.params.sessionId),
            history: { sessionId: request.params.sessionId, items: request.params.sessionId === sessionId ? history : [], hasMore: false },
            latestSeq: snapshot.latestSeq,
          };
          break;
        case "evidence.list":
          result = { evidence: { sessionId: request.params.sessionId, items: [], hasMore: false } };
          break;
        case "session.rename":
          assert.equal(request.params.sessionId, sessionId);
          renameAttempts += 1;
          if (failFirstRename && renameAttempts === 1) {
            error = { code: "E2E_RENAME_FAILED", message: "隔离宿主首次重命名失败，请重试" };
          } else {
            session.title = request.params.title;
            result = { session: { ...session } };
          }
          break;
        case "turn.start":
          assert.equal(request.params.sessionId, sessionId);
          assert.equal(request.params.text, userText);
          assert.ok(request.idempotencyKey, "turn.start requires an idempotency key");
          turnRequest = request;
          Object.assign(session, {
            turnState: "queued", pendingCount: 1, pendingCommandIds: ["browser-e2e-command"],
          });
          result = { commandId: "browser-e2e-command", state: "queued" };
          break;
        case "permission.resolve":
          assert.equal(request.params.requestId, "browser-e2e-permission");
          assert.equal(request.params.decision, "allow-once");
          snapshot.permissions = [];
          session.turnState = "running";
          result = { resolved: true };
          break;
        default:
          throw new Error(`Unimplemented host RPC: ${request.method}`);
      }
      await host.send({
        kind: "response", requestId: request.requestId, ok: !error,
        ...(error ? { error } : { result }),
      });
      socket.ack([encrypted.id]);
      if (request.method === "turn.start") {
        await host.emit("turn.queued", {
          commandId: "browser-e2e-command", requestId: request.requestId,
          delivery: "host-received", text: userText, pendingCount: 1,
          pendingCommandIds: ["browser-e2e-command"],
        }, { itemId: "browser-e2e-command" });
      }
      if (request.method === "permission.resolve") {
        await host.emit("permission.resolved", {
          requestId: "browser-e2e-permission", decision: "allow-once",
        }, { turnId: "browser-e2e-turn" });
      }
    })().catch((error) => errors.push(`mock host: ${error.stack}`));
  });
  await new Promise((ready, reject) => {
    const timer = setTimeout(() => reject(new Error("Isolated mock host failed to connect")), 10_000);
    const off = socket.onState((state) => {
      if (state !== "connected") return;
      socket.registerDevice(pairing.deviceId, crypto.identity.authToken, pairing.expiresAt);
      clearTimeout(timer);
      off();
      ready();
    });
    socket.connect();
  });
  return host;
}

async function openRename(page, entry) {
  await (entry === "list"
    ? page.locator(`[data-session-id="${sessionId}"]`).getByRole("button", { name: "会话操作", exact: true })
    : page.getByRole("button", { name: "会话操作", exact: true })).click();
  await page.getByRole("button", { name: "重命名", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "重命名会话", exact: true });
  await dialog.waitFor();
  return dialog;
}

async function verifyRename(page, host, entry, steps) {
  const row = page.locator(`[data-session-id="${sessionId}"]`);
  const beforeTime = await row.locator("small").innerText();
  const beforeBadge = await row.locator(".session-row-status").innerText();
  const beforeOrder = await page.locator("[data-session-id]").evaluateAll((rows) => rows.map((item) => item.dataset.sessionId));
  const beforeSession = structuredClone(host.session);
  if (entry === "chat") {
    await row.getByRole("button").first().click();
    await page.getByRole("heading", { name: originalTitle, exact: true }).waitFor();
    await page.getByRole("status", { name: "消息排队状态" }).waitFor();
  }
  let dialog = await openRename(page, entry);
  const input = dialog.getByRole("textbox", { name: "会话名称", exact: true });
  const save = dialog.getByRole("button", { name: "保存", exact: true });
  assert.equal(await input.inputValue(), originalTitle, "Rename must prefill the current title");
  assert.equal(await save.isDisabled(), true, "Unchanged title must disable Save");
  await input.fill("   ");
  assert.equal(await save.isDisabled(), true, "Whitespace title must disable Save");
  await input.fill(`  ${originalTitle}  `);
  assert.equal(await save.isDisabled(), true, "Trimmed unchanged title must disable Save");
  await input.fill("取消的名称");
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(host.requests.filter((request) => request.method === "session.rename").length, 0, "Cancel must not send an RPC");
  assert.equal(host.session.title, originalTitle);
  steps.push("prefill, blank/unchanged disabled, cancellation without RPC");

  dialog = await openRename(page, entry);
  assert.equal(await dialog.getByRole("textbox", { name: "会话名称", exact: true }).inputValue(), originalTitle);
  await dialog.getByRole("textbox", { name: "会话名称", exact: true }).fill(`  ${renamedTitle}  `);
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await dialog.getByRole("alert").getByText("隔离宿主首次重命名失败，请重试", { exact: true }).waitFor();
  assert.equal(await dialog.getByRole("textbox", { name: "会话名称", exact: true }).inputValue(), `  ${renamedTitle}  `, "Failed RPC must preserve the input");
  await eventually(() => dialog.getByRole("button", { name: "保存", exact: true }).isEnabled(), true, "Failed RPC must allow retry");
  assert.equal(host.session.title, originalTitle, "Failed rename must not change the title");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.deepEqual(host.requests.filter((request) => request.method === "session.rename").map((request) => request.params.title), [renamedTitle, renamedTitle]);
  steps.push("failed RPC retains input; retry succeeds with a trimmed title");

  if (entry === "list") {
    await eventually(() => row.locator("strong").innerText(), renamedTitle, "List title must update");
    await row.getByRole("button").first().click();
  }
  await page.getByRole("heading", { name: renamedTitle, exact: true }).waitFor();
  assert.match(await page.getByRole("status", { name: "消息排队状态" }).innerText(), /1 条消息已到电脑/u);
  await page.getByRole("button", { name: "返回会话列表", exact: true }).click();
  await eventually(() => row.locator("strong").innerText(), renamedTitle, "Renamed chat must update its list row");
  assert.equal(await row.locator("small").innerText(), beforeTime, "Rename must not change displayed activity time");
  assert.equal(await row.locator(".session-row-status").innerText(), beforeBadge, "Rename must preserve queue state");
  assert.deepEqual(await page.locator("[data-session-id]").evaluateAll((rows) => rows.map((item) => item.dataset.sessionId)), beforeOrder, "Rename must not reorder sessions");
  assert.deepEqual(host.session, { ...beforeSession, title: renamedTitle }, "Host rename changes only the title");
  assert.equal(host.requests.filter((request) => request.method.startsWith("turn.")).length, 0, "Rename must not alter queued turns");
  steps.push("list/header title updates; activity, order, and existing queue unchanged");
}

async function verifyDelivery(page, host, steps) {
  const row = page.locator(`[data-session-id="${sessionId}"]`);
  const dialog = await openRename(page, "list");
  await dialog.getByRole("textbox", { name: "会话名称", exact: true }).fill(renamedTitle);
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await eventually(() => row.locator("strong").innerText(), renamedTitle, "Display name must update before sending");
  await row.getByRole("button").first().click();
  await page.getByRole("heading", { name: renamedTitle, exact: true }).waitFor();
  await page.getByRole("textbox", { name: /^给 .+ 发指令$/u }).fill(userText);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const userMessage = page.locator("article.conversation-item.user").filter({ hasText: userText });
  await eventually(() => host.requests.filter((request) => request.method === "turn.start").length, 1, "One click must send one turn.start");
  await userMessage.getByRole("status").filter({ hasText: /^已排队/u }).waitFor();
  await page.getByRole("status", { name: "消息排队状态" }).waitFor();
  assert.equal(await userMessage.count(), 1, "Queued user message must appear exactly once");
  assert.match(await page.getByRole("status", { name: "消息排队状态" }).innerText(), /1 条消息已到电脑/u);
  steps.push("one send produces one RPC and one queued user message");

  // The event is deliberately not pushed. It must arrive through events.resume
  // after the real mobile WebSocket closes and the hook reconnects itself.
  const snapshotCount = host.requests.filter((request) => request.method === "snapshot.get").length;
  const missed = await host.emit("assistant.completed", { text: recoveredText }, {
    turnId: "browser-e2e-recovery", itemId: "browser-e2e-recovered", replayOnly: true,
  });
  const mobilePeers = [...relayPeers].filter(([, hello]) => hello.roomId === host.pairing.roomId && hello.role === "mobile");
  assert.equal(mobilePeers.length, 1, "Exactly one mobile relay connection should be owned by this context");
  mobilePeers[0][0].close(1012, "browser-e2e reconnect");
  await eventually(() => host.requests.filter((request) => request.method === "snapshot.get").length > snapshotCount, true, "Reconnect must fetch a new snapshot");
  await eventually(() => host.resumeBatches.some((batch) => batch.includes(missed.eventId)), true, "Reconnect must resume the missed event");
  await page.getByText(recoveredText, { exact: true }).waitFor();
  await page.getByRole("heading", { name: renamedTitle, exact: true }).waitFor();
  assert.match(await page.getByRole("status", { name: "消息排队状态" }).innerText(), /1 条消息已到电脑/u);
  assert.equal(await userMessage.count(), 1, "Reconnect must not duplicate the queued user message");
  assert.equal(host.requests.filter((request) => request.method === "turn.start").length, 1, "Reconnect must not resend an acknowledged turn");
  steps.push("real socket reconnect restores snapshot/event, display name, and queue without duplicate send");

  await host.accept();
  await userMessage.getByRole("status").getByText("会话已接收", { exact: true }).waitFor();
  assert.equal(await userMessage.count(), 1, "Acceptance must reconcile the local and host user message");
  await host.requestApproval();
  const approval = page.getByRole("dialog", { name: "Claude 等待授权", exact: true });
  await approval.waitFor();
  await approval.getByText("隔离审批请求", { exact: true }).waitFor();
  await approval.getByText("fixture-command --no-execution", { exact: true }).waitFor();
  await approval.getByRole("button", { name: "允许一次", exact: true }).click();
  await eventually(() => host.requests.filter((request) => request.method === "permission.resolve").length, 1, "Approval must send one permission.resolve");
  await page.getByRole("button", { name: "允许一次", exact: true }).waitFor({ state: "hidden" });
  assert.equal(host.snapshot.permissions.length, 0);
  steps.push("accepted user message remains unique; approval resolves through the host RPC");

  await host.complete();
  await page.getByText(replyText, { exact: true }).waitFor();
  await userMessage.getByRole("status").getByText("已完成", { exact: true }).waitFor();
  await page.getByRole("status", { name: "消息排队状态" }).waitFor({ state: "hidden" });
  assert.equal(await userMessage.count(), 1, "Completion must keep a single user message");
  const turns = host.requests.filter((request) => request.method === "turn.start");
  assert.equal(turns.length, 1, "The full lifecycle must keep one turn request");
  assert.equal(new Set(turns.map((request) => request.requestId)).size, 1);
  assert.equal(new Set(turns.map((request) => request.idempotencyKey)).size, 1);
  steps.push("completed response clears the queue; request and user message stay unique");
}

async function runScenario(theme, scenario) {
  const name = `${theme}-${scenario}`;
  const directory = resolve(runDir, name);
  await mkdir(directory, { recursive: true });
  const errors = [];
  const browserLog = [];
  const steps = [];
  const startedAt = Date.now();
  let context;
  let page;
  let host;
  let failure;
  try {
    host = await createMockHost(scenario !== "delivery-approval-reconnect", scenario !== "delivery-approval-reconnect", errors);
    context = await browser.newContext({
      viewport: { width: 375, height: 812 }, colorScheme: theme,
      serviceWorkers: "block",
    });
    await context.addInitScript((mode) => {
      localStorage.setItem("bridge-theme", mode);
      localStorage.setItem("bridge-theme-family", "sunstone");
    }, theme);
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
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    // Visiting the real pairing URL imports identity via the production hook and
    // stores it in this context's own IndexedDB; no vault or hook is replaced.
    await page.goto(buildPairingUrl(baseUrl, host.pairing), { waitUntil: "domcontentloaded" });
    await page.locator(`[data-session-id="${sessionId}"]`).waitFor();
    await eventually(() => host.requests.some((request) => request.method === "snapshot.get"), true, "Pairing requires an encrypted snapshot handshake");
    assert.equal(await page.locator("html").getAttribute("data-theme"), theme);
    assert.equal(await page.locator("[data-session-id]").count(), 2, "Pairing must synchronize both sessions");
    assert.equal(await page.evaluate(() => Boolean(window.bridgeDesktop)), false, "Test must load the mobile App path");
    assert.equal(await page.evaluate(() => innerWidth), 375);
    steps.push("real App pairing and encrypted snapshot synchronize the session list at 375x812");
    if (scenario === "delivery-approval-reconnect") await verifyDelivery(page, host, steps);
    else await verifyRename(page, host, scenario === "rename-list" ? "list" : "chat", steps);
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
      try {
        await context.tracing.stop(failure ? { path: resolve(directory, "trace.zip") } : {});
      } catch (error) { errors.push(`trace cleanup: ${error.stack}`); }
      try { await context.close(); } catch (error) { errors.push(`context cleanup: ${error.stack}`); }
    }
    host?.close();
    await writeFile(resolve(directory, "browser-errors.json"), JSON.stringify({ errors, console: browserLog }, null, 2));
    // No pairing secrets, tokens, or encrypted envelopes are written to reports.
    await writeFile(resolve(directory, "host-rpc.json"), JSON.stringify({
      requests: host?.requests.map(({ method, requestId, idempotencyKey, params }) => ({ method, requestId, idempotencyKey, params })),
      resumeBatches: host?.resumeBatches,
    }, null, 2));
  }
  const result = {
    name, theme, viewport: "375x812", status: failure || errors.length ? "failed" : "passed",
    durationMs: Date.now() - startedAt, steps, errors,
    ...(failure ? { failure: failure.stack } : {}),
    artifacts: directory,
  };
  results.push(result);
  await writeFile(resolve(directory, "result.json"), JSON.stringify(result, null, 2));
  console.log(`${result.status.toUpperCase()} ${name} (${result.durationMs}ms)${failure ? `: ${failure.message}` : ""}`);
}

await mkdir(runDir, { recursive: true });
try {
  // Vite must not read a developer's .env or inherit production VITE_* values.
  for (const key of Object.keys(inheritedVite)) delete process.env[key];
  relay = await startRelayServer({
    host: "127.0.0.1", port: 0,
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
    infrastructureErrors.push(message);
    logError(message, options);
  };
  vite = await createServer({
    configFile: false, envDir: false,
    root: resolve(root, "apps/client"),
    cacheDir: resolve(runDir, "vite-cache"),
    plugins: [react()], customLogger: logger,
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
  await vite.listen();
  baseUrl = `http://127.0.0.1:${vite.httpServer.address().port}`;
  // Port 0 is allocated at listen time. Set Vite's public environment before
  // the first module is transformed, so probes and pairing use this origin.
  Object.assign(vite.config.env, {
    VITE_BRIDGE_PUBLIC_RELAY_URL: `${baseUrl.replace("http:", "ws:")}/ws`,
    VITE_BRIDGE_SERVICE_ORIGIN: baseUrl,
    VITE_BRIDGE_ICE_SERVERS: "[]",
  });
  if (serve) {
    const stopped = new Promise((finish) => {
      process.once("SIGINT", finish);
      process.once("SIGTERM", finish);
    });
    const host = await createMockHost(true, false, infrastructureErrors);
    console.log(buildPairingUrl(baseUrl, host.pairing));
    await stopped;
  } else {
    browser = await chromium.launch({
      ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
      headless: true,
      args: ["--disable-background-networking", "--disable-component-update", "--no-first-run"],
    });
    for (const theme of ["light", "dark"]) {
      for (const scenario of ["rename-list", "rename-chat", "delivery-approval-reconnect"]) {
        await runScenario(theme, scenario);
      }
    }
  }
} catch (error) {
  infrastructureErrors.push(error.stack);
} finally {
  if (browser) {
    try { await browser.close(); } catch (error) { infrastructureErrors.push(`browser cleanup: ${error.stack}`); }
  }
  for (const host of hosts) host.close();
  if (vite) {
    try { await vite.close(); } catch (error) { infrastructureErrors.push(`Vite cleanup: ${error.stack}`); }
  }
  if (relay) {
    // Only sockets owned by this in-memory fixture are terminated here.
    for (const socket of relay.wsServer.clients) socket.terminate();
    try { await relay.close(); } catch (error) { infrastructureErrors.push(`relay cleanup: ${error.stack}`); }
  }
  for (const key of Object.keys(process.env)) if (key.startsWith("VITE_")) delete process.env[key];
  Object.assign(process.env, inheritedVite);
  if (!serve) {
    const failed = infrastructureErrors.length > 0 || results.length !== 6 || results.some((result) => result.status === "failed");
    const report = {
      status: failed ? "failed" : "passed", browser: browser?.version(), node: process.version,
      client: resolve(root, "apps/client"), runDir,
      passed: results.filter((result) => result.status === "passed").length,
      failed: results.filter((result) => result.status === "failed").length,
      infrastructureErrors, results,
    };
    await writeFile(resolve(runDir, "report.json"), JSON.stringify(report, null, 2));
    await writeFile(resolve(artifactRoot, "report.json"), JSON.stringify(report, null, 2));
    console.log(`Browser E2E ${report.status}: ${report.passed}/6 passed. Report: ${resolve(runDir, "report.json")}`);
    if (failed) process.exitCode = 1;
  }
  if (infrastructureErrors.length) {
    console.error(infrastructureErrors.join("\n"));
    process.exitCode = 1;
  }
}
