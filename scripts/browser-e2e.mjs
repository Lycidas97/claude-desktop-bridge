import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
const remotePreview = serve && process.argv.includes("--remote-execution-preview");
const projectGroupingPreview = serve && !remotePreview && process.argv.includes("--project-grouping-preview");
const sectionCreatePreview = serve && !remotePreview && process.argv.includes("--section-create-preview");
const nativePromptsPreview = serve && !remotePreview && process.argv.includes("--native-prompts-preview");
const nativePreview = serve && !remotePreview && (sectionCreatePreview || projectGroupingPreview || nativePromptsPreview || process.argv.includes("--native-permissions-preview"));
let previewHost;
let previewApproval;
const port = serve ? Number(process.env.BRIDGE_E2E_PORT ?? 0) : 0;
assert.ok(Number.isInteger(port) && port >= 0 && port <= 65535, "BRIDGE_E2E_PORT must be a valid loopback port");
const artifactRoot = resolve(root, "artifacts/browser-e2e");
const runDir = resolve(artifactRoot, `${new Date().toISOString().replaceAll(":", "-")}-${process.pid}`);
const sessionId = "browser-e2e-session";
const originalTitle = remotePreview ? "远程执行交接预览" : "隔离回归会话";
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
let startNativeApprovalHost;
let nativeFixtureSequence = 0;
const nativeHosts = [];
const allScenarios = ["rename-list", "rename-chat", "delivery-approval-reconnect", "native-approvals", "native-prompts-pr", "native-messages", "history-pagination", "native-boundaries", "native-queue-actions", "native-session-notices", "project-grouping", "section-manage"];
const scenarios = process.env.BRIDGE_E2E_SCENARIOS ? process.env.BRIDGE_E2E_SCENARIOS.split(",") : allScenarios;
assert.ok(scenarios.every(scenario => allScenarios.includes(scenario)), "BRIDGE_E2E_SCENARIOS must name existing scenarios");
const enableTrace = process.env.BRIDGE_E2E_TRACE === "1";

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

async function syncNativeSections(host) {
  const { capable, moveCapable, renameCapable, deleteCapable, trustCapable, runtimeCapabilities, projects, sessions } = await host.nativeApproval.sectionCatalog();
  host.snapshot.projects = projects;
  host.snapshot.sessions = sessions;
  host.snapshot.host.capabilities = host.snapshot.host.capabilities.filter(
    value => !["section.create.v1", "section.move.v1", "section.rename.v1", "section.delete.v1", "workspace.trust.v1", "directory.browse.v1", "directory.mkdir.v1"].includes(value),
  );
  host.snapshot.host.capabilities.push("directory.browse.v1", "directory.mkdir.v1");
  if (capable) host.snapshot.host.capabilities.push("section.create.v1");
  if (moveCapable) host.snapshot.host.capabilities.push("section.move.v1");
  if (renameCapable) host.snapshot.host.capabilities.push("section.rename.v1");
  if (deleteCapable) host.snapshot.host.capabilities.push("section.delete.v1");
  if (trustCapable) host.snapshot.host.capabilities.push("workspace.trust.v1");
  if (host.snapshot.runtimes?.[0]) host.snapshot.runtimes[0].capabilities = runtimeCapabilities;
}

async function createMockHost(queued, failFirstRename, errors, native = false, nativeQueue = false, sections = sectionCreatePreview) {
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
    transport: "claude-desktop-native",
    ownership: remotePreview ? "DESKTOP_NATIVE_RUNNING" : "DESKTOP_NATIVE_IDLE",
    turnState: remotePreview ? "running" : queued ? "queued" : "idle",
    ...(remotePreview ? { activeTurnId: "browser-e2e-native-active", currentSummary: "合成 Desktop 原工作尚未结束" } : {}),
    lastActivityAt: now - 7_200_000,
    pendingCount: queued ? 1 : 0,
    pendingCommandIds: queued ? ["pre-existing-command"] : [],
    allowedActions: {
      canSend: true, canSteer: true, canInterrupt: true,
      canConfigure: native, canSwitchProvider: false, canContinueOfficial: false,
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
      capabilities: ["claude.native-relay.v1", "session.rename.v1", "runtime.adapter.v1", ...(native ? ["directory.browse.v1", "workspace.trust.v1", "session.commands.v1", "session.command.v1", "session.rewind.v1", "plugin.magpie-quota.v1", "turn.queue.steer.v1", "turn.queue.cancel.v1", "artifact.transfer.stat.v1", "section.rename.v1", "section.delete.v1", "transcript.toolDetail.v1", "system.update.v1", "prompt.native.v1", "pr.autofix.v1"] : [])],
    },
    ...(native ? {
      updater: {
        platform: "win32",
        arch: "x64",
        currentVersion: "1.1.1",
        channel: "stable",
        autoCheck: true,
        applyMode: "prompt",
        canAutoRestart: true,
        phase: "idle",
      },
    } : {}),
    projects: [{
      projectId: session.projectId, name: session.projectName, cwd: session.cwd,
      runtimeId: "claude-desktop", sessionCount: remotePreview ? 1 : 2, runningCount: remotePreview ? 1 : 0,
      pendingCount: session.pendingCount, lastActivityAt: now - 3_600_000,
    }],
    // A newer neighbour makes accidental activity/order changes observable.
    sessions: [
      ...(remotePreview ? [] : [{
        ...session, sessionId: "browser-e2e-neighbour", title: "较新的相邻会话",
        lastActivityAt: now - 3_600_000, turnState: "idle", pendingCount: 0, pendingCommandIds: [],
      }]),
      session,
      ...(nativePreview ? [
        {
          ...session,
          sessionId: "browser-e2e-btw-active",
          title: "btw: 能不能把 ipv6 的转发也搞回来",
          parentSessionId: sessionId,
          forkLabel: "fork-4",
          sidechat: true,
          lastActivityAt: now - 5_400_000,
          turnState: "idle",
          pendingCount: 0,
          pendingCommandIds: [],
        },
        {
          ...session,
          sessionId: "browser-e2e-btw-archived",
          title: "btw: 收集需要稳定 ip 的白名单域名",
          parentSessionId: sessionId,
          forkLabel: "btw",
          sidechat: true,
          archivedAt: now - 6_000_000,
          lastActivityAt: now - 6_000_000,
          turnState: "idle",
          pendingCount: 0,
          pendingCommandIds: [],
        },
      ] : []),
    ],
    devices: [{
      deviceId: pairing.deviceId, name: "隔离浏览器", platform: "web",
      online: true, createdAt: now, lastSeenAt: now,
    }],
    runtime: { state: "ready", detail: "固定响应宿主", activeTurns: remotePreview ? 1 : 0, maxParallelTurns: 1 },
    runtimes: [{
      id: "claude-desktop", name: "Claude Desktop", state: "ready", detail: "隔离宿主",
      capabilities: ["session.list", "session.history", "turn.start", "permission.resolve", ...(native || remotePreview ? ["attachment.image"] : []), ...(native ? ["session.create", "workspace.trust", "session.configure", "prompt.resolve", "pr.autofix"] : [])],
      sessionIsolation: "independent", sessionCount: remotePreview ? 1 : 2, updatedAt: now,
    }],
    permissions: [],
    prompts: [],
    latestSeq: 1,
  };
  const events = [];
  const history = [];
  const requests = [];
  const resumeBatches = [];
  // This producer models protocol transitions only; it never owns a native task.
  const remote = remotePreview ? {
    phase: "native-running", nativeWorkActive: true, nativeWorkFinishes: 0, finishCalls: 0,
    commands: new Map(),
  } : undefined;
  let renameAttempts = 0;
  let turnRequest;
  const socket = new BridgeSocket({ crypto, role: "desktop", createRoom: true, reconnect: false });
  const host = {
    socket, crypto, pairing, session, snapshot, events, history, requests, resumeBatches, nativeQueue, nativeTrace: [],
    nativeImages: new Map(), imageTransfers: new Map(),
    send: (payload) => socket.send(payload, "mobile", { crypto, toDeviceId: pairing.deviceId }),
    historyPage(cursor, limit = 50) {
      const end = cursor ? history.findIndex(item => item.id === cursor) : history.length;
      assert.ok(end >= 0, "History cursors must refer to the oldest item in the preceding page");
      const start = Math.max(0, end - limit);
      return { sessionId, items: history.slice(start, end), hasMore: start > 0,
        ...(start > 0 ? { nextCursor: history[start].id } : {}) };
    },
    async emit(type, data, options = {}) {
      const event = {
        eventId: `browser-e2e-event-${++snapshot.latestSeq}`,
        sessionId: options.sessionId ?? sessionId, seq: snapshot.latestSeq, timestamp: Date.now(), origin: "claude-desktop",
        type, data,
        ...(options.turnId ? { turnId: options.turnId } : {}),
        ...(options.itemId ? { itemId: options.itemId } : {}),
      };
      events.push(event);
      if (!options.replayOnly) await host.send({ kind: "event", event });
      return event;
    },
    async syncNativeQueue(update, { pushEvents = true } = {}) {
      history.splice(0, history.length, ...update.history.items);
      for (const key of ["turnState", "ownership", "pendingCount", "pendingCommandIds", "allowedActions"]) session[key] = update.session[key];
      snapshot.projects[0].pendingCount = session.pendingCount;
      snapshot.projects[0].runningCount = session.turnState === "running" ? 1 : 0;
      if (pushEvents) for (const event of update.events) await host.emit(event.type, event.data, {
        ...(event.turnId ? { turnId: event.turnId } : {}), ...(event.itemId ? { itemId: event.itemId } : {}),
      });
      await host.send({ kind: "snapshot", snapshot });
      return update;
    },
    async syncNativeDialogs(update) {
      snapshot.prompts = update.prompts;
      snapshot.host.capabilities = snapshot.host.capabilities.filter(value => !["prompt.native.v1", "pr.autofix.v1"].includes(value));
      if (update.runtimeCapabilities.includes("prompt.resolve")) snapshot.host.capabilities.push("prompt.native.v1");
      if (update.runtimeCapabilities.includes("pr.autofix")) snapshot.host.capabilities.push("pr.autofix.v1");
      snapshot.runtimes[0].capabilities = update.runtimeCapabilities;
      for (const key of ["turnState", "ownership", "prs", "autoArchiveOnPrClose", "allowedActions"]) session[key] = update.session[key];
      const target = snapshot.sessions.find(candidate => candidate.sessionId === sessionId);
      if (target !== session) Object.assign(target, session);
      for (const event of update.events) await host.emit(event.type, event.data, {
        ...(event.itemId ? { itemId: event.itemId } : {}), ...(event.turnId ? { turnId: event.turnId } : {}),
      });
      await host.send({ kind: "snapshot", snapshot });
      return update;
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
        turnState: "running", ownership: "DESKTOP_NATIVE_RUNNING", pendingCount: 0,
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
      Object.assign(session, { turnState: "idle", ownership: "DESKTOP_NATIVE_IDLE" });
      delete session.activeTurnId;
      await host.emit("turn.completed", {
        commandId: "browser-e2e-command", requestId: turnRequest.requestId,
        delivery: "completed", pendingCount: 0, pendingCommandIds: [],
      }, { turnId: "browser-e2e-turn" });
    },
    remoteState() {
      const commands = [...remote.commands.values()];
      return {
        mode: "synthetic-remote-execution", sessionId, title: session.title,
        phase: remote.phase, nativeWorkActive: remote.nativeWorkActive,
        nativeWorkFinishes: remote.nativeWorkFinishes, finishCalls: remote.finishCalls,
        // Remote requests have no Desktop inbox branch in this fixture.
        nativeInboxSubmissions: 0,
        turnStartCount: requests.filter(request => request.method === "turn.start").length,
        snapshotGetCount: requests.filter(request => request.method === "snapshot.get").length,
        uniqueCommandCount: commands.length,
        duplicateRequestCount: commands.reduce((sum, command) => sum + command.requestCount - 1, 0),
        processedCount: commands.reduce((sum, command) => sum + command.processingCount, 0),
        completedCount: commands.reduce((sum, command) => sum + command.completionCount, 0),
        commands: commands.map(({ commandId, state, requestCount, processingCount, completionCount, request }) => ({
          commandId, state, requestCount, processingCount, completionCount,
          requestId: request.requestId, idempotencyKey: request.idempotencyKey,
          text: request.params.text, bridgeExecutionRequested: request.params.bridgeExecutionRequested,
          attachmentCount: request.params.attachments?.length ?? 0,
        })),
        requests: requests.map(({ method, requestId, idempotencyKey, params }) => ({
          method, requestId, idempotencyKey,
          params: {
            sessionId: params.sessionId, text: params.text,
            bridgeExecutionRequested: params.bridgeExecutionRequested,
            attachmentCount: params.attachments?.length ?? 0,
          },
        })),
        session: structuredClone(session), defaultPermissionMode: snapshot.host.defaultPermissionMode,
        history: history.map(({ id, role, text, turnId, attachments }) => ({ id, role, text, turnId, attachmentCount: attachments?.length ?? 0 })),
        events: events.map(({ eventId, type, data }) => ({ eventId, type, commandId: data.commandId, requestId: data.requestId })),
        errors: [...errors],
      };
    },
    async finishRemoteWork() {
      remote.finishCalls += 1;
      if (remote.nativeWorkActive) {
        remote.nativeWorkActive = false;
        remote.nativeWorkFinishes += 1;
        remote.phase = "bridge-idle";
        Object.assign(session, {
          transport: "claude-desktop-native", ownership: "DESKTOP_NATIVE_IDLE",
          turnState: session.pendingCount > 0 ? "queued" : "idle",
          desktopHandoff: { state: "bridge", canReturn: false },
        });
        session.allowedActions.canRequestBridgeExecution = false;
        delete session.activeTurnId;
        delete session.currentSummary;
        snapshot.runtime.activeTurns = 0;
        snapshot.projects[0].runningCount = 0;
        await host.send({ kind: "snapshot", snapshot });
      }
      for (const command of remote.commands.values()) await host.completeRemoteCommand(command);
    },
    async completeRemoteCommand(command) {
      if (command.state !== "queued") return;
      command.state = "running";
      command.processingCount += 1;
      remote.phase = "bridge-running";
      const { request, commandId } = command;
      const turnId = `${commandId}-turn`;
      Object.assign(session, {
        turnState: "running", ownership: "DESKTOP_NATIVE_RUNNING", activeTurnId: turnId,
        pendingCommandIds: session.pendingCommandIds.filter(id => id !== commandId),
      });
      session.pendingCount = session.pendingCommandIds.length;
      snapshot.projects[0].pendingCount = session.pendingCount;
      snapshot.projects[0].runningCount = 1;
      snapshot.runtime.activeTurns = 1;
      const userItem = {
        id: `${commandId}-user`, sessionId, turnId, role: "user", text: request.params.text,
        attachments: request.params.attachments ?? [], createdAt: Date.now(), origin: "mobile",
      };
      history.push(userItem);
      await host.emit("user.message.accepted", {
        commandId, requestId: request.requestId, text: userItem.text,
        attachments: userItem.attachments, delivery: "session-received",
      }, { turnId, itemId: userItem.id });
      await host.emit("turn.started", {
        commandId, requestId: request.requestId, delivery: "running",
        pendingCount: session.pendingCount, pendingCommandIds: session.pendingCommandIds,
      }, { turnId });
      await host.send({ kind: "snapshot", snapshot });
      const assistantItem = {
        id: `${commandId}-assistant`, sessionId, turnId, role: "assistant",
        text: `合成 Bridge 已完成：${userItem.text}`, createdAt: Date.now(), origin: "claude-host",
      };
      history.push(assistantItem);
      await host.emit("assistant.completed", { text: assistantItem.text }, { turnId, itemId: assistantItem.id });
      command.state = "completed";
      command.completionCount += 1;
      remote.phase = "bridge-idle";
      Object.assign(session, { turnState: session.pendingCount > 0 ? "queued" : "idle", ownership: "DESKTOP_NATIVE_IDLE" });
      delete session.activeTurnId;
      snapshot.projects[0].runningCount = 0;
      snapshot.runtime.activeTurns = 0;
      await host.emit("turn.completed", {
        commandId, requestId: request.requestId, delivery: "completed",
        pendingCount: session.pendingCount, pendingCommandIds: session.pendingCommandIds,
      }, { turnId });
      await host.send({ kind: "snapshot", snapshot });
    },
    close() {
      socket.close();
      hosts.delete(host);
    },
  };
  if (native) {
    const directory = resolve(runDir, "native-fixtures", String(++nativeFixtureSequence));
    await mkdir(directory, { recursive: true });
    host.sectionsEnabled = sections;
    host.nativeApproval = await startNativeApprovalHost({
      directory, sessionId, title: originalTitle, deviceId: pairing.deviceId, sections,
      onRequested(request) {
        snapshot.permissions.push(request);
        session.turnState = "waiting";
        host.nativeTrace.push({ type: "requested", requestId: request.requestId, toolUseId: request.toolUseId, toolName: request.toolName });
        void host.emit(request.toolName === "AskUserQuestion" ? "question.requested" : "permission.requested", request)
          .catch((error) => errors.push(`native request: ${error.stack}`));
      },
      onResolved(request, result, resolution) {
        snapshot.permissions = snapshot.permissions.filter((pending) => pending.requestId !== request.requestId);
        session.turnState = "idle";
        host.nativeTrace.push({ type: "resolved", requestId: request.requestId, decision: resolution.decision, resolvedByDeviceId: resolution.resolvedByDeviceId });
        void host.emit(request.toolName === "AskUserQuestion" ? "question.resolved" : "permission.resolved", {
          ...request, ...resolution, behavior: result.decision === "deny" ? "deny" : "allow",
        }).then(() => host.send({ kind: "snapshot", snapshot }))
          .catch((error) => errors.push(`native resolution: ${error.stack}`));
      },
      onModeChanged(mode) {
        host.nativeTrace.push({ type: "mode", mode });
        void host.send({ kind: "snapshot", snapshot }).catch((error) => errors.push(`native mode: ${error.stack}`));
      },
      onModelChanged(model) {
        session.model = model;
        session.modelDisplayName = model === "synthetic-model" ? "隔离模型 · 标准" : "隔离模型 · 长上下文";
        void host.send({ kind: "snapshot", snapshot }).catch((error) => errors.push(`native model: ${error.stack}`));
      },
    });
    Object.assign(session, host.nativeApproval.profile());
    nativeHosts.push(host.nativeApproval);
  }
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
      let remoteCommand;
      let remoteCommandCreated = false;
      switch (request.method) {
        case "runtime.refresh":
          if (host.nativeApproval) await syncNativeSections(host);
          result = { runtime: snapshot.runtime }; break;
        case "snapshot.get":
          if (host.sectionsEnabled) await syncNativeSections(host);
          result = { snapshot }; break;
        case "section.create":
        case "section.move":
        case "section.rename":
        case "section.delete":
        case "session.create":
          try {
            result = await host.nativeApproval.controllerRequest(request);
            await syncNativeSections(host);
            await host.send({ kind: "snapshot", snapshot });
          } catch (failure) { error = { code: failure.code ?? "NATIVE_SECTION_REJECTED", message: failure.message }; }
          break;
        case "directory.list":
        case "directory.mkdir":
          try {
            result = await host.nativeApproval.controllerRequest(request);
          } catch (failure) { error = { code: "DIRECTORY_REJECTED", message: failure.message }; }
          break;
        case "prompt.list":
        case "prompt.resolve":
        case "pr.autoFix.read":
        case "pr.autoFix.set":
          try {
            const update = await host.nativeApproval.request(request);
            result = update.result;
            await host.syncNativeDialogs(update);
          } catch (failure) {
            error = { code: failure.code ?? "NATIVE_PROMPT_PR_REJECTED", message: failure.message };
            await host.syncNativeDialogs({ ...host.nativeApproval.dialogs(), events: [] });
          }
          break;
        case "events.resume": {
          const resumed = events.filter((event) => event.seq > request.params.afterSeq);
          resumeBatches.push(resumed.map((event) => event.eventId));
          result = { events: resumed, latestSeq: snapshot.latestSeq, hasMore: false };
          break;
        }
        case "plugin.magpie-quota.list":
          result = { status: "available", fetchedAt: Date.now(), accounts: [{ provider: "claude", name: "隔离 Magpie 账号", windows: [{ name: "5 hours", remaining: 73 }, { name: "7 days", remaining: 81 }] }] };
          break;
        case "system.update": {
          const action = request.params?.action ?? "status";
          if (action === "check") {
            snapshot.updater = { ...snapshot.updater, phase: "available", latestVersion: "1.3.3", assetName: "Bridge-1.3.3-windows-installer-ci.zip", statusDetail: "发现新版本 v1.3.3" };
          } else if (action === "apply") {
            snapshot.updater = { ...snapshot.updater, phase: "applying", latestVersion: "1.3.3", statusDetail: "正在后台静默升级并重启 Bridge 服务…" };
          }
          result = snapshot.updater;
          await host.send({ kind: "snapshot", snapshot });
          break;
        }
        case "session.rewind.preview":
        case "session.rewind": {
          try {
            const rewound = await host.nativeApproval.rewind(request);
            result = rewound.result;
            if (request.method === "session.rewind" && request.params.scope !== "files") await host.syncNativeQueue(rewound);
          } catch (failure) {
            error = { code: "NATIVE_REWIND_REJECTED", message: failure.message };
          }
          break;
        }
        case "session.commands": result = await host.nativeApproval.commands(request); break;
        case "session.configuration":
          if (!host.nativeApproval && request.params.includeBackgroundTasks === true) {
            result = { session: snapshot.sessions.find(candidate => candidate.sessionId === request.params.sessionId) };
            break;
          }
        case "session.configure":
          result = await host.nativeApproval.configuration(request);
          Object.assign(session, host.nativeApproval.profile());
          await host.send({ kind: "snapshot", snapshot });
          break;
        case "session.list": result = { sessions: snapshot.sessions }; break;
        case "project.list": result = { projects: snapshot.projects }; break;
        case "session.open": {
          const sidechatItems = nativePreview && String(request.params.sessionId).startsWith("browser-e2e-btw-")
            ? [
                {
                  id: `${request.params.sessionId}-u1`,
                  sessionId: request.params.sessionId,
                  turnId: `${request.params.sessionId}-t1`,
                  role: "user",
                  text: request.params.sessionId === "browser-e2e-btw-active"
                    ? "btw: 能不能把 ipv6 的转发也搞回来？"
                    : "btw: 收集需要稳定 ip 的白名单域名",
                  createdAt: now - 6_000_000,
                  origin: "claude-desktop",
                },
                {
                  id: `${request.params.sessionId}-a1`,
                  sessionId: request.params.sessionId,
                  turnId: `${request.params.sessionId}-t1`,
                  role: "assistant",
                  text: "已在 /btw 侧聊中记录该问题并给出独立分析。",
                  createdAt: now - 5_900_000,
                  origin: "claude-desktop",
                },
              ]
            : [];
          result = {
            session: snapshot.sessions.find((candidate) => candidate.sessionId === request.params.sessionId),
            history: request.params.sessionId === sessionId ? host.historyPage(undefined, request.params.limit) : {
              sessionId: request.params.sessionId, items: sidechatItems, hasMore: false,
            },
            latestSeq: snapshot.latestSeq,
          };
          break;
        }
        case "session.history":
          assert.equal(request.params.sessionId, sessionId);
          if (host.historyGate) await host.historyGate;
          if (host.failHistoryOnce) {
            host.failHistoryOnce = false;
            error = { code: "E2E_HISTORY_FAILED", message: "隔离历史请求失败" };
          } else result = { history: host.historyPage(request.params.cursor, request.params.limit) };
          break;
        case "evidence.list":
          result = { evidence: { sessionId: request.params.sessionId, items: [], hasMore: false } };
          break;
        case "session.tool.detail":
          try {
            result = await host.nativeApproval.controllerRequest(request);
          } catch (failure) {
            error = { code: "TOOL_DETAIL_FAILED", message: failure.message };
          }
          break;
        case "artifact.transfer.open": {
          assert.equal(request.params.sessionId, sessionId);
          const image = request.params.nativeImage;
          if (!image) { result = await host.nativeApproval.files(request); break; }
          const bytes = host.nativeImages.get(`${image?.messageUuid}:${image?.imageIndex}`);
          assert.ok(bytes, "Native preview must request an existing image reference");
          if (host.imageTransfers.size >= 4) {
            error = { code: "TRANSFER_LIMIT", message: "当前同时传输的文件过多，请稍后重试" };
            break;
          }
          const transferId = randomUUID();
          host.imageTransfers.set(transferId, bytes);
          result = { transfer: {
            transferId, artifactId: `native-image:${image.messageUuid}:${image.imageIndex}`,
            name: `image-${image.imageIndex + 1}.png`, mimeType: "image/png", size: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"), chunkBytes: 256 * 1024,
            totalChunks: Math.max(1, Math.ceil(bytes.length / (256 * 1024))), expiresAt: Date.now() + 60_000,
          } };
          break;
        }
        case "artifact.transfer.read": {
          const bytes = host.imageTransfers.get(request.params.transferId);
          if (!bytes) { result = await host.nativeApproval.files(request); break; }
          assert.ok(bytes, "Image transfer must be open before reading");
          const index = request.params.index;
          assert.ok(Number.isInteger(index) && index >= 0 && index < Math.max(1, Math.ceil(bytes.length / (256 * 1024))));
          result = { chunk: { transferId: request.params.transferId, index, data: bytes.subarray(index * 256 * 1024, (index + 1) * 256 * 1024).toString("base64") } };
          break;
        }
        case "artifact.transfer.close":
          result = host.imageTransfers.has(request.params.transferId)
            ? { closed: host.imageTransfers.delete(request.params.transferId) }
            : await host.nativeApproval.files(request);
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
        case "turn.queue.steer":
        case "turn.queue.cancel": {
          try {
            const update = await host.nativeApproval.request(request);
            result = update.result;
            await host.syncNativeQueue(update);
          } catch (failure) {
            error = { code: "NATIVE_QUEUE_REJECTED", message: failure.message };
          }
          break;
        }
        case "turn.steer":
        case "turn.start":
          if (host.nativeQueue) {
            const update = await host.nativeApproval.request(request);
            result = update.result;
            await host.syncNativeQueue(update);
            break;
          }
          if (request.method === "turn.steer") { error = { code: "UNSUPPORTED_METHOD", message: "Immediate sends require the native queue fixture" }; break; }
          assert.equal(request.params.sessionId, sessionId);
          assert.ok(request.idempotencyKey, "turn.start requires an idempotency key");
          if (remotePreview) {
            remoteCommand = remote.commands.get(request.idempotencyKey);
            if (!remoteCommand) {
              remoteCommand = {
                commandId: `browser-e2e-remote-command-${remote.commands.size + 1}`,
                request: structuredClone(request), state: "queued", requestCount: 0, processingCount: 0, completionCount: 0,
              };
              remote.commands.set(request.idempotencyKey, remoteCommand);
              remoteCommandCreated = true;
              session.pendingCommandIds.push(remoteCommand.commandId);
              session.pendingCount = session.pendingCommandIds.length;
              session.turnState = "queued";
              snapshot.projects[0].pendingCount = session.pendingCount;
              if (remote.nativeWorkActive) {
                remote.phase = "native-queued";
              }
            }
            remoteCommand.requestCount += 1;
            result = { commandId: remoteCommand.commandId, state: remoteCommand.state };
            break;
          }
          assert.equal(request.params.text, userText);
          turnRequest = request;
          Object.assign(session, {
            turnState: "queued", pendingCount: 1, pendingCommandIds: ["browser-e2e-command"],
          });
          result = { commandId: "browser-e2e-command", state: "queued" };
          break;
        case "permission.resolve":
          if (native) { result = await host.nativeApproval.resolve(request); break; }
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
      if (request.method === "turn.start" && remotePreview && !error) {
        if (remoteCommandCreated) {
          await host.emit("turn.queued", {
            commandId: remoteCommand.commandId, requestId: request.requestId,
            delivery: "host-received", text: request.params.text, attachments: request.params.attachments ?? [],
            pendingCount: session.pendingCount, pendingCommandIds: session.pendingCommandIds,
          }, { itemId: remoteCommand.commandId });
        }
        await host.send({ kind: "snapshot", snapshot });
        if (!remote.nativeWorkActive) await host.completeRemoteCommand(remoteCommand);
      } else if (request.method === "turn.start" && !remotePreview && !host.nativeQueue) {
        await host.emit("turn.queued", {
          commandId: "browser-e2e-command", requestId: request.requestId,
          delivery: "host-received", text: userText, pendingCount: 1,
          pendingCommandIds: ["browser-e2e-command"],
        }, { itemId: "browser-e2e-command" });
        if (native) await host.send({ kind: "snapshot", snapshot });
      }
      if (request.method === "permission.resolve" && !native) {
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

  if (entry === "list") {
    const search = page.getByPlaceholder("搜索项目或会话", { exact: true });
    await search.fill("不存在的会话关键词");
    await page.locator(".session-catalog-loading strong", { hasText: "没有匹配的会话" }).waitFor();
    await search.fill("");

    await host.send({
      kind: "snapshot",
      snapshot: {
        ...host.snapshot,
        projects: [],
        sessions: [],
        runtime: { ...host.snapshot.runtime, state: "ready" },
        runtimes: [{ ...host.snapshot.runtimes[0], state: "ready", capabilities: [...host.snapshot.runtimes[0].capabilities, "session.create"], sessionCount: 0 }],
      },
    });
    await page.locator(".session-catalog-loading strong", { hasText: "暂无会话" }).waitFor();
    await page.locator(".session-catalog-loading span", { hasText: "当前电脑上尚未创建会话，可随时开始新的对话。" }).waitFor();
    await page.locator(".session-catalog-loading").getByRole("button", { name: "新建会话", exact: true }).click();
    const createDialog = page.getByRole("dialog", { name: "新建会话" });
    await createDialog.waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await createDialog.getByRole("button", { name: "关闭", exact: true }).click();
    await createDialog.waitFor({ state: "hidden" });

    await host.send({
      kind: "snapshot",
      snapshot: {
        ...host.snapshot,
        projects: [],
        sessions: [],
        runtime: { ...host.snapshot.runtime, state: "unavailable" },
        runtimes: [{ ...host.snapshot.runtimes[0], state: "unavailable", sessionCount: 0 }],
      },
    });
    await page.locator(".session-catalog-loading strong", { hasText: "未检测到 Claude Desktop" }).waitFor();
    await page.locator(".session-catalog-loading span", { hasText: "请在电脑端打开 Claude Desktop。启动后 Bridge 将自动建立连接。" }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.locator(".session-catalog-loading").getByRole("button", { name: "检查连接", exact: true }).click();
    await page.getByRole("heading", { name: "连接与同步", exact: true }).waitFor();
    steps.push("empty catalog distinguishes unmatched search, online empty Desktop with create action, and missing Claude Desktop with connection inspection");
  }
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
  await userMessage.getByRole("status").filter({ hasText: /已排队|排队中/u }).waitFor();
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
  await userMessage.getByRole("status").filter({ hasText: /已排队|排队中/u }).waitFor();
  assert.equal(await userMessage.count(), 1, "Acceptance must reconcile the user message without regressing a confirmed queue state");
  await host.requestApproval();
  await userMessage.getByRole("status").filter({ hasText: /处理中/u }).waitFor();
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

async function verifyNativeApprovals(page, host, steps, directory) {
  await page.locator(`[data-session-id="${sessionId}"]`).getByRole("button").first().click();
  await page.getByRole("heading", { name: originalTitle, exact: true }).waitFor();
  const slashInput = page.getByRole("combobox", { name: "给 Claude 发指令" });
  await slashInput.fill("/r");
  await page.getByRole("option", { name: /^\/review\b/u }).waitFor();
  assert.equal(await page.getByRole("option").count(), 3);
  await page.getByRole("option", { name: /^\/rewind\b/u }).waitFor();
  const menuAlpha = await page.locator(".slash-command-menu").evaluate(menu => {
    const context = document.createElement("canvas").getContext("2d");
    context.fillStyle = getComputedStyle(menu).backgroundColor;
    context.fillRect(0, 0, 1, 1);
    return context.getImageData(0, 0, 1, 1).data[3];
  });
  assert.equal(menuAlpha, 255, "The command menu has an opaque base in both themes");
  await page.screenshot({ path: resolve(directory, "native-slash-menu.png"), fullPage: true });
  await slashInput.press("ArrowDown");
  await slashInput.press("Enter");
  assert.equal(await slashInput.inputValue(), "/review ");
  assert.equal(host.requests.filter(request => request.method === "session.commands").length, 1);
  assert.equal(host.requests.filter(request => request.method === "turn.start").length, 0);
  await slashInput.fill("");
  steps.push("custom slash commands come from synthetic-directory metadata through session.commands; selection inserts without sending");
  await host.emit("session.observed", { role: "assistant", text: "", interactivePrompt: {
    kind: "wrap-up", blocked: true, ask: "批准这项原生操作？", actions: [{ label: "批准实施", message: "批准实施" }],
  } }, { itemId: "native-unavailable-confirmation" });
  const unavailable = page.locator(".interactive-prompt-card").filter({ hasText: "批准这项原生操作？" });
  await unavailable.getByText("需在电脑端确认", { exact: true }).waitFor();
  assert.equal(await unavailable.getByRole("button", { name: /批准实施/u }).isDisabled(), true);
  await host.emit("session.observed", { role: "assistant", text: "", interactivePrompt: {
    kind: "question", toolUseId: "unmatched-native-question", questions: [{ question: "未接通的历史问题", options: [{ label: "确认" }] }],
  } }, { itemId: "native-unmatched-question" });
  const unmatched = page.locator(".interactive-prompt-card").filter({ hasText: "未接通的历史问题" });
  await unmatched.getByText("提问已不在待回答列表", { exact: true }).waitFor();
  assert.equal(await unmatched.getByRole("button", { name: "确认", exact: true }).isDisabled(), true);
  assert.equal(host.requests.filter((request) => request.method === "turn.start").length, 0);
  await page.screenshot({ path: resolve(directory, "native-unavailable.png"), fullPage: true });
  steps.push("native transcript-only confirmation and unmatched question are non-actionable; no peer chat sent");

  for (const decision of ["allow-once", "deny"]) {
    const open = await host.nativeApproval.open("Bash", { command: "synthetic-native-tool --never-executed", description: "仅验证原生审批响应" });
    const dialog = page.getByRole("dialog", { name: "Claude 等待授权", exact: true });
    await dialog.waitFor();
    await dialog.getByRole("button", { name: "暂时关闭", exact: true }).click();
    const dock = await page.locator(".permission-dock-slot").boundingBox();
    const stream = await page.locator(".conversation-stream").boundingBox();
    const composer = await page.locator(".mobile-composer").boundingBox();
    assert.ok(stream.height > 0 && dock.y >= stream.y + stream.height - 1 && dock.y + dock.height <= composer.y + 1, "Authorization entry follows the scrollable output and precedes the composer");
    await page.locator(".permission-dock").click();
    await dialog.getByRole("button", { name: decision === "deny" ? "拒绝" : "允许一次", exact: true }).click();
    if (decision === "deny") {
      await dialog.getByRole("textbox", { name: "拒绝原因", exact: true }).fill("改用只读检查");
      await dialog.getByRole("button", { name: "拒绝", exact: true }).click();
    }
    const response = await open.response;
    assert.equal(response.decision, decision === "deny" ? "deny" : "once");
    assert.equal(response.requestId, open.request.requestId);
    await eventually(() => host.nativeApproval.list().length, 0, "Native permission must resolve");
    await eventually(() => host.nativeTrace.some(event => event.type === "resolved" && event.requestId === open.request.requestId), true, "Native resolution has reached the controller callback");
    const trace = host.nativeTrace.find((event) => event.type === "resolved" && event.requestId === open.request.requestId);
    assert.equal(trace.resolvedByDeviceId, host.pairing.deviceId);
    await dialog.waitFor({ state: "hidden" });
  }
  steps.push("allow and deny travel through encrypted permission.resolve and reach the same native requestID with phone attribution");

  const input = { questions: [
    { question: "选择执行范围", multiSelect: false, options: [{ label: "仅本机", description: "使用隔离测试目录" }, { label: "稍后处理" }] },
    { question: "选择检查项目", multiSelect: true, options: [{ label: "类型检查" }, { label: "回归测试" }] },
  ] };
  await page.getByRole("button", { name: "返回会话列表", exact: true }).click();
  const question = await host.nativeApproval.open("AskUserQuestion", input);
  const sessionRow = page.locator(`[data-session-id="${sessionId}"]`);
  await sessionRow.getByText("待回答", { exact: true }).waitFor();
  await page.getByText("有提问待你回答", { exact: true }).waitFor();
  await sessionRow.getByRole("button").first().click();
  const questionCard = page.locator(".conversation-stream .pending-question");
  await questionCard.waitFor();
  assert.equal(await page.getByRole("dialog", { name: "Claude 等待授权", exact: true }).count(), 0, "Questions are answered inline without another approval sheet");
  await host.emit("assistant.delta", { text: "提问后到达的最新总结内容" }, { itemId: "question-later-summary" });
  await host.emit("assistant.completed", { text: "提问后到达的最新总结内容" }, { itemId: "question-later-summary" });
  const latestOutput = page.locator(".conversation-item").filter({ hasText: "提问后到达的最新总结内容" });
  await latestOutput.waitFor();
  assert.equal(await latestOutput.evaluate(output => Boolean(output.compareDocumentPosition(document.querySelector(".pending-question")) & Node.DOCUMENT_POSITION_FOLLOWING)), true, "The live question stays after subsequent assistant output");
  const snapshotCount = host.requests.filter((request) => request.method === "snapshot.get").length;
  const peer = [...relayPeers].find(([, hello]) => hello.roomId === host.pairing.roomId && hello.role === "mobile");
  assert.ok(peer, "Native approval scenario must own a connected phone");
  peer[0].close(1012, "native approval reconnect fixture");
  await eventually(() => host.requests.filter((request) => request.method === "snapshot.get").length > snapshotCount, true, "Reconnect must fetch pending native approval");
  assert.equal(host.nativeApproval.list()[0].requestId, question.request.requestId);
  await questionCard.getByRole("radio", { name: /仅本机/u }).check();
  await questionCard.getByRole("checkbox", { name: "类型检查", exact: true }).check();
  await questionCard.getByRole("checkbox", { name: "回归测试", exact: true }).check();
  await page.screenshot({ path: resolve(directory, "native-question.png"), fullPage: true });
  await questionCard.getByRole("button", { name: "提交回答", exact: true }).click();
  const questionReply = await question.response;
  assert.equal(questionReply.decision, "once");
  assert.equal(questionReply.requestId, question.request.requestId);
  assert.deepEqual(questionReply.response, { ...input, answers: { "选择执行范围": "仅本机", "选择检查项目": "类型检查, 回归测试" } });
  await questionCard.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "返回会话列表", exact: true }).click();
  await sessionRow.getByText("待回答", { exact: true }).waitFor({ state: "hidden" });
  await sessionRow.getByRole("button").first().click();
  const resolutions = host.requests.filter((request) => request.method === "permission.resolve");
  assert.equal(resolutions.length, 3);
  assert.equal(new Set(resolutions.map((request) => request.params.requestId)).size, 3);
  assert.equal(resolutions.filter((request) => request.params.requestId === question.request.requestId).length, 1);
  assert.equal(host.requests.filter((request) => request.method === "turn.start").length, 0);
  steps.push("live native questions survive reconnect; single-choice and multi-select answers reach the same native requestID exactly once without chat");
  for (const mode of ["bypassPermissions", "auto"]) {
    await page.getByRole("button", { name: "会话设置", exact: true }).click();
    const configuration = page.getByRole("dialog", { name: originalTitle, exact: true });
    await configuration.getByLabel("Desktop 授权模式").selectOption(mode);
    await configuration.getByRole("button", { name: "保存配置", exact: true }).click();
    if (mode === "bypassPermissions") {
      await page.getByRole("alertdialog", { name: "启用完全授权", exact: true }).getByRole("button", { name: "启用完全授权", exact: true }).click();
    }
    await configuration.waitFor({ state: "hidden" });
    assert.equal(host.nativeApproval.permissionMode(), mode);
    assert.deepEqual(host.nativeApproval.calls.filter(call => call.method === "setPermissionMode").at(-1).args, [sessionId, mode]);
    await page.getByRole("button", { name: "会话设置", exact: true }).click();
    await eventually(() => configuration.getByLabel("Desktop 授权模式").inputValue(), mode, "Configuration reflects the native Desktop mode");
    await page.screenshot({ path: resolve(directory, `native-mode-${mode}.png`), fullPage: true });
    await configuration.getByRole("button", { name: "关闭", exact: true }).click();
    assert.equal(host.snapshot.host.defaultPermissionMode, undefined);
  }
  assert.equal(host.requests.filter((request) => request.method === "permission.policy.configure" || request.method === "turn.start").length, 0);
  assert.equal(host.requests.filter((request) => request.method === "permission.resolve" && request.params.nativeMode !== undefined).length, 0);
  steps.push("native session permission modes relay through session.configure and setPermissionMode without applying a Bridge host policy");
  const planApproval = await host.nativeApproval.open("ExitPlanMode", { plan: "# 迁移计划\n\n1. 保留原生通道\n2. 核对文件进度" });
  const planDialog = page.getByRole("dialog", { name: "Claude 等待授权", exact: true });
  await planDialog.getByRole("heading", { name: "迁移计划" }).waitFor();
  await page.screenshot({ path: resolve(directory, "native-exit-plan.png"), fullPage: true });
  await planDialog.getByRole("button", { name: "是，自动接受编辑", exact: true }).click();
  const planResponse = await planApproval.response;
  assert.equal(planResponse.decision, "once");
  assert.equal(host.nativeApproval.permissionMode(), "acceptEdits");
  const nativeCalls = host.nativeApproval.calls;
  const modeIndex = nativeCalls.findLastIndex(call => call.method === "setPermissionMode");
  const responseIndex = nativeCalls.findLastIndex(call => call.method === "respondToToolPermission");
  assert.ok(modeIndex < responseIndex, "Native mode changes before approving the plan");
  await planDialog.waitFor({ state: "hidden" });
  steps.push("ExitPlanMode renders the plan and configures native acceptEdits before responding to the same request");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "Native approval must fit the phone viewport");
}

async function verifyNativePromptsPr(page, host, steps, directory) {
  await page.locator(`[data-session-id="${sessionId}"]`).getByRole("button").first().click();
  await page.getByRole("heading", { name: originalTitle, exact: true }).waitFor();
  const kinds = ["refusal-fallback", "auto-mode-server-fallback", "lanyard-consent", "violin-bow", "cwd-trust"];
  const opened = [];
  for (const kind of kinds) {
    const update = await host.syncNativeDialogs(await host.nativeApproval.openPrompt(kind));
    opened.push(update.prompt);
  }
  await eventually(() => page.locator(".native-prompt").count(), 1, "The phone sheet renders the first pending Native application prompt");
  await page.locator(".permission-dock").getByText("5 项", { exact: true }).waitFor();
  assert.equal(host.snapshot.permissions.length, 0);
  const listed = await host.nativeApproval.controllerRequest({ kind: "request", requestId: randomUUID(), idempotencyKey: randomUUID(), method: "prompt.list", params: { sessionId } });
  assert.deepEqual(listed.prompts.map(prompt => prompt.kind).sort(), [...kinds].sort());
  await page.screenshot({ path: resolve(directory, "native-prompts.png"), fullPage: true });
  const selected = ["edit_prompt", "interrupt", "consent_workspace", "cancel_native_operation", "trust"];
  const methods = ["respondToRefusalFallbackPrompt", "respondToAutoModeServerFallbackPrompt", "respondToLanyardConsent", "respondToViolinBowPrompt", "answerPendingCwdTrust"];
  for (const [index, prompt] of opened.entries()) {
    const choice = prompt.choices.find(choice => choice.value === selected[index]);
    assert.ok(choice, "The synthetic Native broker must publish its actual choice value");
    const card = page.getByRole("region", { name: prompt.title, exact: true });
    if (prompt.kind === "lanyard-consent") {
      const disclosure = await card.innerText();
      for (const value of ["此连接会替换原有频道连接。", "原频道：隔离旧频道", "原线程开始于 2026-11-12", "https://example.invalid/owned-old-channel"]) assert.ok(disclosure.includes(value), "Native replacement authorization must be visible before responding");
    }
    await card.getByRole("button", { name: choice.label, exact: true }).click();
    await card.waitFor({ state: "hidden" });
    await eventually(() => host.nativeApproval.dialogs().events.some(event => event.type === "prompt.resolved" && event.data.promptId === prompt.promptId && event.data.resolvedByDeviceId === host.pairing.deviceId), true, "Remote Native prompt resolution records its phone device");
    const audit = host.nativeApproval.dialogs().events.findLast(event => event.type === "prompt.resolved" && event.data.promptId === prompt.promptId && event.data.resolvedByDeviceId);
    assert.equal(audit.data.choice, selected[index]);
    assert.equal(audit.data.resolvedByName, "隔离手机");
    assert.deepEqual(host.nativeApproval.calls.filter(call => call.method === methods[index]).at(-1).args, [sessionId, prompt.promptId, prompt.kind === "cwd-trust" ? true : selected[index]]);
  }
  assert.equal(host.requests.filter(request => request.method === "prompt.resolve").length, 5);
  assert.equal(host.requests.filter(request => request.method === "permission.resolve" || request.method === "turn.start").length, 0);
  steps.push("five Native prompts use independent encrypted prompt.resolve calls with their actual string choices, cwd boolean translation, and phone attribution");

  const responsesBeforeLocal = host.nativeApproval.calls.filter(call => methods.includes(call.method)).length;
  for (const kind of kinds) {
    const update = await host.syncNativeDialogs(await host.nativeApproval.openPrompt(kind));
    const card = page.getByRole("region", { name: update.prompt.title, exact: true });
    await card.waitFor();
    await host.syncNativeDialogs(await host.nativeApproval.answerPromptLocally(update.prompt.promptId));
    await card.waitFor({ state: "hidden" });
    assert.equal(host.nativeApproval.dialogs().events.some(event => event.type === "prompt.resolved" && event.data.promptId === update.prompt.promptId && event.data.automatic === true), true);
  }
  assert.equal(host.nativeApproval.calls.filter(call => methods.includes(call.method)).length, responsesBeforeLocal);
  const rawDialogs = host.nativeApproval.dialogs().nativeEvents.filter(event => /^(refusal_fallback_prompt|auto_mode_server_fallback_prompt|lanyard_consent|violin_bow_prompt)(?:_resolved)?$/u.test(event.type));
  assert.equal(rawDialogs.length, 16);
  assert.equal(rawDialogs.every(event => !Object.hasOwn(event, "session")), true, "Native opened/resolved dialog events intentionally carry no event.session");
  await host.nativeApproval.setPromptsPrPolicy({ choicesAvailable: false });
  const unavailable = await host.syncNativeDialogs(await host.nativeApproval.openPrompt("lanyard-consent"));
  const unavailableCard = page.getByRole("region", { name: unavailable.prompt.title, exact: true });
  await unavailableCard.getByText("请在电脑端处理", { exact: true }).waitFor();
  assert.equal(await unavailableCard.getByRole("button").count(), 0);
  const reachable = await host.syncNativeDialogs(await host.nativeApproval.openPrompt("cwd-trust"));
  await page.getByRole("combobox", { name: "待处理提示", exact: true }).selectOption(reachable.prompt.promptId);
  const reachableCard = page.getByRole("region", { name: reachable.prompt.title, exact: true });
  await reachableCard.getByRole("button", { name: "信任目录", exact: true }).click();
  await reachableCard.waitFor({ state: "hidden" });
  await unavailableCard.waitFor();
  await host.syncNativeDialogs(await host.nativeApproval.answerPromptLocally(unavailable.prompt.promptId));
  await host.nativeApproval.setPromptsPrPolicy({ choicesAvailable: true });
  steps.push("a read-only first prompt remains visible while the selector reaches and answers a later Native prompt");
  steps.push("Native opened/resolved events without event.session refresh all five pending lists; Desktop-local answers clear phone cards without a remote response, and unavailable Native choices stay non-actionable");

  assert.equal(host.nativeApproval.calls.filter(call => ["getPrOverview", "getPrChecks"].includes(call.method)).length, 0, "Snapshot refresh never fetches GitHub PR checks");
  assert.equal(host.requests.filter(request => request.method === "pr.autoFix.read").length, 0, "Collapsed PR controls do not query PR state");
  const bar = page.locator(".session-pr-bar");
  await bar.locator(":scope > summary").click();
  const own = bar.getByRole("checkbox", { name: "仅我的 PR", exact: true });
  const next = bar.getByRole("button", { name: "布防下一个 PR", exact: true });
  await eventually(() => own.isEnabled(), true, "Native preference reads enable the supported controls");
  assert.equal(host.nativeApproval.calls.filter(call => call.method === "getPrChecks").length, 0);
  await own.click();
  await eventually(() => own.isChecked(), true, "Only-own-PR preference reflects Native readback");
  await eventually(() => next.isEnabled(), true, "PR preference update completes before the next action");
  await next.click();
  await eventually(() => bar.getByRole("button", { name: "已布防下一个 PR", exact: true }).isDisabled(), true, "Next-PR branch latch reflects Native readback without offering an unsupported cancel action");
  assert.deepEqual(host.nativeApproval.dialogs().prefs, { onlyOwnPrs: true, nextOwnPrArmed: true });
  assert.deepEqual(host.nativeApproval.calls.findLast(call => call.method === "armAutoFixOnNextPr").args, [sessionId, "feature/owned"]);

  const entry = bar.locator(".session-pr-entry");
  await eventually(() => own.isEnabled(), true, "Next-PR dispatch is acknowledged before opening checks");
  await entry.locator(":scope > summary").click();
  await entry.getByRole("link", { name: "native-ci-failure", exact: true }).waitFor();
  assert.deepEqual(host.nativeApproval.calls.filter(call => call.method === "getPrChecks").map(call => call.args), [[host.nativeApproval.harnessCwd, 42, "fixture/native", "github.com"]]);
  const bound = entry.getByRole("checkbox", { name: "fixture/native#42 Auto-fix", exact: true });
  await eventually(() => bound.isEnabled(), true, "Bound PR becomes actionable after its on-demand read");
  await bound.click();
  await eventually(() => bound.isChecked(), true, "Bound PR Auto-fix reflects Native readback");
  assert.deepEqual(host.nativeApproval.calls.findLast(call => call.method === "setBoundPrAutoFix").args, [sessionId, "fixture/native", 42, true, "github.com"]);
  for (const target of ["own-prs", "next-pr", "bound"]) {
    const audit = host.nativeApproval.dialogs().events.findLast(event => event.type === "pr.autoFix.updated" && event.data.target === target && event.data.resolvedByDeviceId);
    assert.equal(audit.data.resolvedByDeviceId, host.pairing.deviceId);
    assert.equal(audit.data.resolvedByName, "隔离手机");
  }
  await eventually(() => bar.getByRole("button", { name: "刷新 PR 状态", exact: true }).isEnabled(), true, "PR write finishes before manual refresh");
  const reads = host.requests.filter(request => request.method === "pr.autoFix.read").length;
  await bar.getByRole("button", { name: "刷新 PR 状态", exact: true }).click();
  await eventually(() => host.requests.filter(request => request.method === "pr.autoFix.read").length, reads + 1, "Explicit PR state refresh reaches the Native controller");
  assert.equal(host.nativeApproval.calls.filter(call => call.method === "getPrChecks").length, 1, "Refreshing preferences does not poll PR checks");
  const refreshChecks = entry.getByRole("button", { name: "刷新检查", exact: true });
  await eventually(() => refreshChecks.isEnabled(), true, "PR state refresh finishes before refreshing checks");
  await refreshChecks.click();
  await eventually(() => host.nativeApproval.calls.filter(call => call.method === "getPrChecks").length, 2, "Only explicit check refresh fetches the checks again");
  await page.screenshot({ path: resolve(directory, "native-pr-autofix.png"), fullPage: true });
  steps.push("PR preferences, next-PR dispatch, and bound Auto-fix use Native readback and phone audit; failed checks load only on entry expansion or explicit check refresh with the public four/five-argument APIs");

  await host.nativeApproval.setPromptsPrPolicy({ applyPrWrites: false });
  const audits = host.nativeApproval.dialogs().events.filter(event => event.type === "pr.autoFix.updated").length;
  for (const checkbox of [bound, own]) {
    await eventually(() => checkbox.isEnabled(), true, "Native action is available before testing an unapplied write");
    await checkbox.click();
    await bar.getByRole("alert").filter({ hasText: "Desktop 未应用 Auto-fix 设置，请刷新状态。" }).waitFor();
    assert.equal(await checkbox.isChecked(), true, "An unapplied Native write never appears successful");
  }
  assert.deepEqual(host.nativeApproval.dialogs().prefs, { onlyOwnPrs: true, nextOwnPrArmed: true });
  assert.equal(host.nativeApproval.dialogs().prs[0].autoFix, true);
  assert.equal(host.nativeApproval.dialogs().events.filter(event => event.type === "pr.autoFix.updated").length, audits, "Failed Native writes do not record a successful device audit");
  assert.equal(host.requests.filter(request => request.method === "pr.autoFix.set").length, 5);
  await page.screenshot({ path: resolve(directory, "native-pr-not-applied.png"), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "Native prompts and PR controls fit the mobile viewport");
  steps.push("ignored bound and own-PR Native writes return an error, retain Native state, and create no successful audit event; an armed next-PR latch offers no unsupported cancel action");
}

async function verifyNativeMessages(page, host, steps, directory) {
  const fiveId = "browser-e2e-five-images";
  const singleId = "browser-e2e-single-image";
  const correctedId = "browser-e2e-corrected-result";
  const photos = await page.evaluate(() => ["#a84d2e", "#2c6873", "#596d42", "#6c527e", "#a17328"].map((color, index) => {
    const canvas = document.createElement("canvas");
    canvas.width = 420;
    canvas.height = 280;
    const context = canvas.getContext("2d");
    context.fillStyle = color;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#ffffff";
    context.font = "bold 96px sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(String(index + 1), 210, 140);
    return canvas.toDataURL("image/png").split(",")[1];
  }));
  const attachments = photos.map((data, imageIndex) => {
    const bytes = Buffer.from(data, "base64");
    host.nativeImages.set(`${fiveId}:${imageIndex}`, bytes);
    return { id: `native-image:${fiveId}:${imageIndex}`, name: `image-${imageIndex + 1}.png`, mimeType: "image/png", size: bytes.length, nativeImage: { messageUuid: fiveId, imageIndex } };
  });
  host.nativeImages.set(`${singleId}:0`, Buffer.from(photos[0], "base64"));
  host.history.push(
    { id: singleId, sessionId, role: "user", text: "单图隔离消息", createdAt: Date.now() - 1000, origin: "claude-desktop", delivery: "completed", attachments: [{ ...attachments[0], id: `native-image:${singleId}:0`, nativeImage: { messageUuid: singleId, imageIndex: 0 } }] },
    { id: fiveId, sessionId, role: "user", text: "五图隔离消息", createdAt: Date.now(), origin: "claude-desktop", delivery: "queued", attachments },
    { id: correctedId, sessionId, role: "user", text: "终态纠正消息", createdAt: Date.now() + 1, origin: "claude-desktop", delivery: "queued" },
  );
  await page.locator(`[data-session-id="${sessionId}"]`).getByRole("button").first().click();
  await page.getByRole("heading", { name: originalTitle, exact: true }).waitFor();
  const five = page.locator("article.conversation-item.user").filter({ hasText: "五图隔离消息" });
  async function loadFiveThumbnails() {
    await eventually(() => five.locator(".conversation-image-preview").count(), 5, "Native history preserves all five image slots");
    for (const slot of await five.locator(".conversation-image-preview").all()) {
      await slot.scrollIntoViewIfNeeded();
      await eventually(() => slot.locator("img").count(), 1, "A visible native thumbnail loads through its image reference");
      await eventually(() => slot.locator("img").evaluate(node => node.complete && node.naturalWidth > 0), true, "Each native thumbnail decodes successfully");
    }
  }
  await loadFiveThumbnails();
  assert.match(await five.innerText(), /排队/u);
  await page.screenshot({ path: resolve(directory, "native-five-images.png"), fullPage: true });
  await five.locator("img").first().click();
  const viewer = page.getByRole("dialog").last();
  await viewer.waitFor();
  await eventually(() => viewer.locator("img").evaluate(node => node.complete && node.naturalWidth > 0), true, "Original native image opens in the media viewer");
  await page.screenshot({ path: resolve(directory, "native-image-viewer.png"), fullPage: true });
  await viewer.getByRole("button", { name: /关闭/u }).first().click();
  assert.ok(host.requests.some(request => request.method === "artifact.transfer.open" && request.params.nativeImage?.messageUuid === fiveId));
  assert.equal(JSON.stringify(host.history).includes(photos[0]), false, "History carries references without original image data");
  steps.push("single/five-image history uses reference-based lazy thumbnails and the existing full-image viewer");

  await host.emit("turn.started", { messageId: fiveId, delivery: "running" }, { itemId: fiveId, turnId: fiveId });
  await eventually(async () => /处理中|开始处理/u.test(await five.innerText()), true, "The exact queued message visibly starts processing");
  await host.emit("user.message.accepted", { text: "五图隔离消息", attachments, delivery: "session-received", messageId: fiveId }, { itemId: fiveId });
  await eventually(async () => /处理中|开始处理/u.test(await five.innerText()), true, "A late accepted event does not regress running delivery");
  await loadFiveThumbnails();
  await host.emit("turn.completed", {});
  assert.match(await five.innerText(), /处理中|开始处理/u, "Unrelated native completion does not complete this message");
  await host.emit("turn.completed", { messageId: fiveId, delivery: "completed" }, { itemId: fiveId, turnId: fiveId });
  await eventually(async () => /已完成/u.test(await five.innerText()), true, "Only the matching native UUID completes the message");
  host.history.find(item => item.id === fiveId).delivery = "completed";
  steps.push("native queued → processing → completed follows message UUIDs and ignores unrelated results");
  const corrected = page.locator("article.conversation-item.user").filter({ hasText: "终态纠正消息" });
  await host.emit("turn.completed", { messageId: correctedId, delivery: "completed" }, { itemId: correctedId, turnId: correctedId });
  await host.emit("turn.failed", { messageId: correctedId, delivery: "failed", error: "隔离结果确认失败" }, { itemId: correctedId, turnId: correctedId });
  await eventually(async () => /失败/u.test(await corrected.innerText()), true, "A real matching failure corrects an earlier generic completion without a local turn");
  host.history.find(item => item.id === correctedId).delivery = "failed";
  steps.push("an authoritative matching result can correct the earlier terminal status");

  const assistantId = "browser-e2e-stream-final";
  await host.emit("assistant.delta", { text: "旧的流式片段" }, { itemId: assistantId });
  await host.emit("assistant.completed", { text: "流式完成内容" }, { itemId: assistantId });
  await host.emit("assistant.delta", { text: "旧的流式片段" }, { itemId: assistantId });
  await page.getByText("流式完成内容", { exact: true }).waitFor();
  assert.equal(await page.getByText("旧的流式片段", { exact: true }).count(), 0);
  assert.equal(await page.locator(".stream-caret").count(), 0);
  host.history.push({ id: assistantId, sessionId, role: "assistant", text: "流式完成内容", createdAt: Date.now(), origin: "claude-desktop" });
  steps.push("completion without a turnId retains final content and shows no per-message blinking caret");

  assert.match(host.session.model, /^mythos-magpie-/u, "The header test must receive a native internal model alias");
  await eventually(async () => (await page.getByRole("button", { name: "会话设置", exact: true }).innerText()).includes("隔离模型 · 标准"), true, "Initial native alias snapshot uses its saved header label before opening configuration");
  await page.getByRole("button", { name: "会话设置", exact: true }).click();
  const configuration = page.getByRole("dialog", { name: originalTitle, exact: true });
  const modelSelect = configuration.locator("select").first();
  await eventually(() => modelSelect.inputValue(), "synthetic-model", "Native alias selects the matching original model ID in the picker");
  await eventually(() => modelSelect.locator("option").evaluateAll(options => options.filter(option => option.value.startsWith("synthetic-model")).map(option => ({ value: option.value, text: option.textContent }))), [
    { value: "synthetic-model", text: "隔离模型 · 标准" },
    { value: "synthetic-model-large[1m]", text: "隔离模型 · 长上下文" },
  ], "Saved model labels and original IDs are shown in saved order");
  await modelSelect.selectOption("synthetic-model-large[1m]");
  await configuration.getByRole("button", { name: "保存配置", exact: true }).click();
  await configuration.waitFor({ state: "hidden" });
  assert.deepEqual(host.nativeApproval.calls.filter(call => call.method === "setModel").at(-1).args, [sessionId, "mythos-magpie-1826500494[1m]"]);
  await eventually(async () => (await page.getByRole("button", { name: "会话设置", exact: true }).innerText()).includes("隔离模型 · 长上下文"), true, "Session header uses the saved display label");
  assert.match(host.session.model, /^mythos-magpie-.*\[1m\]$/u);
  await page.screenshot({ path: resolve(directory, "native-model-labels.png"), fullPage: true });
  steps.push("native internal aliases resolve to saved header labels before configuration, picker selection uses the canonical ID, and long-context selection keeps its full ID");

  await page.reload({ waitUntil: "domcontentloaded" });
  const row = page.locator(`[data-session-id="${sessionId}"]`).getByRole("button").first();
  await page.getByRole("heading", { name: originalTitle, exact: true }).or(row).first().waitFor();
  if (await row.isVisible()) await row.click();
  await loadFiveThumbnails();
  await eventually(async () => (await page.getByRole("button", { name: "会话设置", exact: true }).innerText()).includes("隔离模型 · 长上下文"), true, "Reloaded native alias snapshot retains the saved header label");
  assert.match(await five.innerText(), /已完成/u);
  assert.equal(await page.locator(".stream-caret").count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  steps.push("reloading restores completed delivery and five-image metadata without original bytes in cached history");

  const geminiModel = ["antigravity", "gemini-4-argon"].join("/");
  await page.getByRole("button", { name: "会话设置", exact: true }).click();
  await modelSelect.selectOption(geminiModel);
  await configuration.getByRole("button", { name: "保存配置", exact: true }).click();
  await configuration.waitFor({ state: "hidden" });
  assert.deepEqual(host.nativeApproval.calls.filter(call => call.method === "setModel").at(-1).args, [sessionId, ["mythos", "magpie", "1052229916"].join("-")]);
  await eventually(async () => (await page.getByRole("button", { name: "会话设置", exact: true }).innerText()).includes("Gemini 4 Argon · Antigravity · 1M"), true, "Native preferred 1M normalization succeeds and the header shows the actual context");
  await page.getByRole("button", { name: "会话设置", exact: true }).click();
  await eventually(() => modelSelect.inputValue(), `${geminiModel}[1m]`, "Reopening configuration selects the observed Gemini 1M variant");
  assert.ok((await modelSelect.locator("option:checked").innerText()).includes("1M"));
  assert.equal((await configuration.innerText()).includes("Desktop did not apply"), false);
  await page.screenshot({ path: resolve(directory, "native-gemini-preferred-context.png"), fullPage: true });
  steps.push("Gemini saves through the real Native facade when Desktop prefers 1M, and reopening configuration shows its observed model and context without a false failure");
}

async function verifyHistoryPagination(page, host, steps, directory) {
  const now = Date.now();
  for (let index = 0; index < 120; index += 1) host.history.push({
    id: `browser-e2e-history-${String(index).padStart(3, "0")}`, sessionId,
    role: index % 2 ? "assistant" : "user",
    text: `历史条目 ${String(index + 1).padStart(3, "0")}。${"这段内容仅用于隔离分页与滚动位置验收。".repeat(3)}`,
    createdAt: now - (120 - index) * 1000, origin: "claude-desktop",
  });
  await page.locator(`[data-session-id="${sessionId}"]`).getByRole("button").first().click();
  await page.getByRole("heading", { name: originalTitle, exact: true }).waitFor();
  const stream = page.locator(".conversation-stream");
  await eventually(() => stream.locator("article.conversation-item").count(), 50, "Opening a session renders the larger first page");
  assert.equal(host.requests.filter(request => request.method === "session.open").at(-1).params.limit, 50);
  await page.evaluate(() => document.fonts.ready.then(() => true));
  await eventually(() => stream.evaluate(root => root.scrollHeight - root.clientHeight - root.scrollTop < 4), true, "Initial session entry keeps the latest messages visible");
  await stream.evaluate(root => {
    root.scrollTop = root.scrollHeight;
    root.dispatchEvent(new Event("scroll"));
  });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(host.requests.filter(request => request.method === "session.history").length, 0, "Opening and ordinary bottom scrolling do not drain older pages");
  steps.push("first page requests and renders 50 records while retaining initial bottom positioning");

  const captureTop = () => stream.evaluate(root => {
    root.scrollTop = 0;
    const rect = root.getBoundingClientRect();
    const node = [...root.querySelectorAll("[data-stream-key]")].find(candidate => {
      const bounds = candidate.getBoundingClientRect();
      return bounds.bottom > rect.top + 1 && bounds.top < rect.bottom;
    });
    if (!node) throw new Error("A visible history anchor is required");
    const anchor = { key: node.getAttribute("data-stream-key"), offset: node.getBoundingClientRect().top - rect.top, height: root.scrollHeight };
    for (let index = 0; index < 5; index += 1) root.dispatchEvent(new Event("scroll"));
    return anchor;
  });
  let anchorSequence = 0;
  const assertAnchor = async anchor => {
    let actual;
    try {
      await eventually(async () => {
        actual = await stream.evaluate((root, expected) => {
          const node = [...root.querySelectorAll("[data-stream-key]")].find(candidate => candidate.getAttribute("data-stream-key") === expected.key);
          return { offset: node ? node.getBoundingClientRect().top - root.getBoundingClientRect().top : null,
            scrollTop: root.scrollTop, scrollHeight: root.scrollHeight, clientHeight: root.clientHeight };
        }, anchor);
        return actual.offset !== null && Math.abs(actual.offset - anchor.offset) <= 4;
      }, true, "Prepending history preserves the previous visible message offset");
    } finally {
      await writeFile(resolve(directory, `history-anchor-${++anchorSequence}.json`), JSON.stringify({ expected: anchor, actual }, null, 2));
    }
  };
  let release;
  host.historyGate = new Promise(resolve => { release = resolve; });
  const anchor = await captureTop();
  try {
    await eventually(() => host.requests.filter(request => request.method === "session.history").length, 1, "Reaching the top automatically requests the next page once");
    await stream.evaluate(root => { for (let index = 0; index < 5; index += 1) root.dispatchEvent(new Event("scroll")); });
    assert.equal(host.requests.filter(request => request.method === "session.history").length, 1, "Repeated top scrolls cannot duplicate an in-flight cursor");
  } finally {
    host.historyGate = undefined;
    release();
  }
  await eventually(() => stream.evaluate((root, height) => root.scrollHeight > height + 100, anchor.height), true, "The preceding page is prepended into the real scroll container");
  await assertAnchor(anchor);
  assert.ok(await stream.evaluate(root => root.scrollTop > 32), "Prepend compensation leaves the top trigger area");
  const firstPage = host.requests.filter(request => request.method === "session.history")[0];
  assert.equal(firstPage.params.limit, 50);
  assert.equal(firstPage.params.cursor, "browser-e2e-history-070");
  await page.screenshot({ path: resolve(directory, "history-prepend-anchor.png"), fullPage: true });
  steps.push("top scrolling loads 50 older records once and preserves the same visible message position");

  host.failHistoryOnce = true;
  await captureTop();
  await page.getByText(/隔离历史请求失败/u).first().waitFor();
  await stream.evaluate(root => { for (let index = 0; index < 5; index += 1) root.dispatchEvent(new Event("scroll")); });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(host.requests.filter(request => request.method === "session.history").length, 2, "A failed automatic request does not retry on every scroll event");
  const beforeRetry = await stream.evaluate(root => {
    const rect = root.getBoundingClientRect();
    const node = [...root.querySelectorAll("[data-stream-key]")].find(candidate => candidate.getBoundingClientRect().bottom > rect.top + 1);
    return { key: node.getAttribute("data-stream-key"), offset: node.getBoundingClientRect().top - rect.top };
  });
  await page.getByRole("button", { name: "重试加载更早消息", exact: true }).click();
  await eventually(() => host.requests.filter(request => request.method === "session.history").length, 3, "The retry button explicitly retries the retained cursor");
  await stream.locator(".load-older-button").waitFor({ state: "hidden" });
  await assertAnchor(beforeRetry);
  const older = host.requests.filter(request => request.method === "session.history");
  assert.equal(older[1].params.cursor, "browser-e2e-history-020");
  assert.equal(older[2].params.cursor, older[1].params.cursor);
  await captureTop();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(host.requests.filter(request => request.method === "session.history").length, 3, "The terminal page stops further automatic requests");
  const keys = await stream.locator("[data-stream-key]").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-stream-key")));
  assert.equal(new Set(keys).size, keys.length, "History pages do not duplicate visible message identities");
  assert.equal(host.requests.filter(request => request.method === "turn.start" || request.method === "turn.steer").length, 0);
  await page.screenshot({ path: resolve(directory, "history-pagination-complete.png"), fullPage: true });
  steps.push("failed paging preserves data/cursor for manual retry; retry preserves the anchor, and the last page stops loading");

  await stream.evaluate(root => { root.scrollTop = root.scrollHeight; root.dispatchEvent(new Event("scroll")); });
  const streaming = stream.locator("article.conversation-item.assistant").filter({ hasText: "流式滚动起始片段" });
  await host.emit("assistant.delta", { text: `流式滚动起始片段。\n\n${"持续输出用于滚动位置验收。\n\n".repeat(8)}` }, { turnId: "scroll-follow-turn", itemId: "scroll-follow-message" });
  await streaming.waitFor();
  await eventually(() => stream.evaluate(root => root.scrollHeight - root.clientHeight - root.scrollTop < 4), true, "Streaming follows when the reader stays at the bottom");
  for (const distance of [80, 40, 640]) {
    const before = await stream.evaluate((root, distance) => {
      root.scrollTop = root.scrollHeight - root.clientHeight - distance;
      root.dispatchEvent(new Event("scroll"));
      return root.scrollTop;
    }, distance);
    const marker = `上翻 ${distance}px 后的流式片段`;
    await host.emit("assistant.delta", { text: `\n\n${marker}。${"新输出不应打断历史阅读。".repeat(6)}` }, { turnId: "scroll-follow-turn", itemId: "scroll-follow-message" });
    await streaming.filter({ hasText: marker }).waitFor();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const after = await stream.evaluate(root => root.scrollTop);
    await writeFile(resolve(directory, `stream-scroll-${distance}.json`), JSON.stringify({ distance, before, after }, null, 2));
    await page.screenshot({ path: resolve(directory, `stream-scroll-${distance}.png`), fullPage: true });
    assert.ok(Math.abs(after - before) <= 4, `Streaming must preserve the reader's position after scrolling up ${distance}px: ${before} -> ${after}`);
    await stream.evaluate(root => { root.scrollTop = root.scrollHeight; root.dispatchEvent(new Event("scroll")); });
    await host.emit("assistant.delta", { text: `\n\n回到底部后恢复跟随 ${distance}。${"继续输出。".repeat(12)}` }, { turnId: "scroll-follow-turn", itemId: "scroll-follow-message" });
    await streaming.filter({ hasText: `回到底部后恢复跟随 ${distance}` }).waitFor();
    await eventually(() => stream.evaluate(root => root.scrollHeight - root.clientHeight - root.scrollTop < 4), true, "Returning to the bottom resumes streaming follow");
  }
  steps.push("streaming follows at the bottom, preserves the reader's position after 40/80/640px upward scrolling, and follows again only after returning to the bottom");
}

async function verifyNativeBoundaries(page, host, steps, directory) {
  const tool = (id, input, name = "mcp__ccd_turn__update_plan") => ({ type: "assistant", uuid: id, timestamp: Date.now(), message: { content: [{ type: "tool_use", id, name, input }] } });
  const planItems = [{ content: "读取报告", status: "in_progress" }, { content: "验证文件", status: "pending" }];
  const initial = [
    tool("boundary-plan", { scope: "first_task", items: planItems }),
    { ...tool("child-plan", { scope: "first_task", items: [{ content: "子代理内部计划", status: "in_progress" }] }), isSidechain: true },
    { ...tool("child-wrap", { recap: "Child done" }, "mcp__ccd_turn__wrap_up"), isSidechain: true },
    ...["isCompactSummary", "isMeta", "isSynthetic", "isVisibleInTranscriptOnly"].map(flag => ({ type: "user", uuid: `hidden-${flag}`, [flag]: true, message: { content: "INTERNAL_COMPACT_SUMMARY_MUST_STAY_HIDDEN" } })),
    { type: "assistant", uuid: "boundary-files", timestamp: Date.now(), message: { id: "boundary-files", content: [{ type: "text", text: `[相对报告](report.json) · [绝对报告](<${host.nativeApproval.harnessCwd}/report.json:12:3>) · [说明预览](<说明 notes.md>)` }] } },
  ];
  for (const message of initial) await host.nativeApproval.message(message);
  const subagentStartAt = Date.now() - 30_000;
  await host.nativeApproval.message({
    type: "system",
    subtype: "task_started",
    task_id: "boundary-bg-subagent",
    tool_use_id: "boundary-bg-call",
    description: "Run full local distributed CI",
    timestamp: subagentStartAt,
  });
  host.session.runningSubagents = host.nativeApproval.session().runningSubagents;
  assert.deepEqual(host.session.runningSubagents, { count: 1, lastUpdatedAt: subagentStartAt });
  await host.emit("runtime.updated", { replaceSession: true, session: structuredClone(host.session) }, { itemId: "session:subagent-activity" });
  const catalogRow = page.locator(`[data-session-id="${sessionId}"]`);
  await eventually(() => catalogRow.locator(".session-state-dot.running").count(), 1, "Catalog row dot reflects running background subagent when main turn is idle");
  await eventually(() => catalogRow.locator(".session-row-status.running").innerText(), "后台子代理", "Catalog row badge displays running background subagent");
  host.history.push(...(await host.nativeApproval.history()).items);
  await catalogRow.getByRole("button").first().click();
  await eventually(async () => (await page.locator(".session-activity-label").innerText()).includes("子代理运行中 · Run full local distributed CI"), true, "Session detail shows running subagent activity");
  await page.getByRole("button", { name: "返回会话列表", exact: true }).click();
  await eventually(() => catalogRow.locator(".session-state-dot.running").count(), 1, "Returning from detail keeps catalog row dot running");
  await eventually(() => catalogRow.locator(".session-row-status.running").innerText(), "后台子代理", "Returning from detail keeps catalog row badge synchronized");
  host.session.runningSubagents = { count: 1, lastUpdatedAt: Date.now() - 11 * 60_000 };
  await host.emit("runtime.updated", { replaceSession: true, session: structuredClone(host.session) }, { itemId: "session:subagent-activity" });
  await eventually(() => catalogRow.locator(".session-state-dot.queued").count(), 1, "Stalled background subagent switches catalog dot to warning tone");
  await eventually(() => catalogRow.locator(".session-row-status.queued").innerText(), "子代理无进展", "Stalled background subagent switches catalog badge label");
  for (const event of await host.nativeApproval.message({
    type: "system",
    subtype: "task_notification",
    task_id: "boundary-bg-subagent",
    tool_use_id: "boundary-bg-call",
    status: "completed",
    summary: "CI green",
    timestamp: Date.now(),
  })) await host.emit(event.type, event.data, { itemId: event.itemId });
  assert.equal(host.nativeApproval.session().runningSubagents, undefined);
  delete host.session.runningSubagents;
  await host.emit("runtime.updated", { replaceSession: true, session: structuredClone(host.session) }, { itemId: "session:subagent-activity" });
  await eventually(() => catalogRow.locator(".session-state-dot.idle").count(), 1, "Completed background subagent restores idle catalog dot");
  await eventually(() => catalogRow.locator(".session-row-status").count(), 0, "Completed background subagent clears catalog badge");
  host.history.splice(0, host.history.length, ...(await host.nativeApproval.history()).items);
  steps.push("session catalog state dot and status badge stay synchronized with active, stalled, and completed background subagents before opening and after returning from detail");
  await catalogRow.getByRole("button").first().click();
  const stream = page.locator(".conversation-stream");
  await eventually(() => stream.locator(".task-plan-card").count(), 1, "Only the parent native task plan is projected");
  assert.equal((await stream.innerText()).includes("INTERNAL_COMPACT_SUMMARY_MUST_STAY_HIDDEN"), false);
  assert.equal((await stream.innerText()).includes("子代理内部计划"), false);
  for (const label of ["相对报告", "绝对报告"]) {
    const requestStart = host.requests.length;
    await stream.getByRole("button", { name: label, exact: true }).click();
    const content = page.locator("#text-preview-content");
    await content.waitFor();
    const opens = host.requests.slice(requestStart).filter(request => request.method === "artifact.transfer.open");
    assert.equal(opens[0]?.params.purpose, "stat", "File links check metadata before opening the text transfer");
    assert.ok(opens.length >= 2 && opens.slice(1).every(request => request.params.purpose === "text-preview"), "Content transfers follow the file size check");
    assert.ok((await content.innerText()).includes("worktree"), "The original project-root namesake must not be read");
    assert.equal((await content.innerText()).includes("wrong project root"), false);
    assert.equal(await page.locator(".media-viewer [role=alert]").count(), 0);
    if (label === "相对报告") await page.screenshot({ path: resolve(directory, "native-worktree-report.png"), fullPage: true });
    await page.getByRole("button", { name: "关闭查看器", exact: true }).click();
  }
  await stream.getByRole("button", { name: "说明预览", exact: true }).click();
  await page.locator(".media-viewer").getByRole("heading", { name: "Worktree preview", exact: true }).waitFor();
  await page.getByRole("tab", { name: "源码", exact: true }).click();
  assert.ok((await page.locator("#text-preview-content").innerText()).includes("# Worktree preview"));
  await page.getByRole("button", { name: "关闭查看器", exact: true }).click();
  steps.push("real Native facade + Controller resolve relative/absolute report links and Chinese spaced Markdown paths in the worktree");
  for (const event of await host.nativeApproval.message(tool("boundary-advance", { advance: true }))) await host.emit(event.type, event.data, { itemId: event.itemId });
  await eventually(() => stream.locator(".task-plan-progress").first().innerText(), "1/2 已完成", "Native empty-text live plan updates the history card");
  assert.equal(await stream.locator(".task-plan-card").count(), 1);
  for (const event of await host.nativeApproval.message(tool("boundary-new", { scope: "new_task", items: planItems }))) await host.emit(event.type, event.data, { itemId: event.itemId });
  await eventually(() => stream.locator(".task-plan-card").count(), 2, "A genuine new task remains distinct even with identical text");
  await page.screenshot({ path: resolve(directory, "native-plan-boundaries.png"), fullPage: true });
  assert.equal(host.requests.filter(request => request.method === "turn.start" || request.method === "turn.steer").length, 0);
  steps.push("compact summaries/sidechain plans stay hidden, live parent status updates one card, and genuine new tasks remain distinct");

  await page.getByRole("button", { name: "会话设置", exact: true }).click();
  const configuration = page.getByRole("dialog", { name: originalTitle, exact: true });
  await configuration.locator("select").first().selectOption("claude/claude-opus-5-5");
  await eventually(() => configuration.locator(".magpie-quota-model summary").innerText(), "单账号最高可用 73%", "Native Claude model picker shows the Magpie response");
  await configuration.locator(".magpie-quota-model summary").click();
  assert.ok((await configuration.innerText()).includes("隔离 Magpie 账号"));
  assert.ok(host.requests.some(request => request.method === "plugin.magpie-quota.list"));
  await page.screenshot({ path: resolve(directory, "native-magpie-quota.png"), fullPage: true });
  await configuration.getByRole("button", { name: "保存配置", exact: true }).click();
  await configuration.waitFor({ state: "hidden" });
  assert.deepEqual(host.nativeApproval.calls.filter(call => call.method === "setModel").at(-1).args, [sessionId, "mythos-magpie-2213244526"]);
  steps.push("the native picker queries Magpie account quota, shows the returned 73% with account details, and sends the exact native model alias");

  const checkpointTime = Date.now();
  for (const [index, message] of [
    { type: "user", uuid: "rewind-first", message: { content: "准备一个检查点" } },
    { type: "assistant", uuid: "rewind-kept", message: { content: [{ type: "text", text: "保留的检查点回复" }] } },
    { type: "user", uuid: "rewind-target", message: { content: "重写这条请求" } },
    { type: "assistant", uuid: "rewind-discarded", message: { content: [{ type: "text", text: "回退后应消失的回复" }] } },
  ].entries()) {
    for (const event of await host.nativeApproval.message({ ...message, timestamp: checkpointTime + index })) await host.emit(event.type, event.data, { itemId: event.itemId });
  }
  host.history.splice(0, host.history.length, ...(await host.nativeApproval.history()).items);
  const target = stream.locator("article.conversation-item").filter({ hasText: "重写这条请求" });
  await target.getByRole("button", { name: "回退到这条消息之前", exact: true }).click();
  const rewind = page.getByRole("dialog", { name: "回退会话", exact: true });
  await rewind.getByRole("combobox", { name: "回退范围", exact: true }).selectOption("both");
  assert.ok((await rewind.innerText()).includes("report.json"));
  assert.equal(JSON.parse(await readFile(resolve(host.nativeApproval.harnessCwd, "report.json"), "utf8")).source, "worktree", "Dry-run leaves the actual fixture file intact");
  assert.equal(host.nativeApproval.calls.filter(call => call.method === "rewindV2").length, 0);
  await page.screenshot({ path: resolve(directory, "native-rewind-preview.png"), fullPage: true });
  await rewind.getByRole("button", { name: "确认回退", exact: true }).click();
  await rewind.waitFor({ state: "hidden" });
  await eventually(() => page.locator(".composer-form textarea").inputValue(), "重写这条请求", "Native rewind returns the original text to the draft");
  await eventually(() => stream.getByText("回退后应消失的回复", { exact: true }).count(), 0, "Discarded reply is removed from history and old live events");
  assert.equal(JSON.parse(await readFile(resolve(host.nativeApproval.harnessCwd, "report.json"), "utf8")).source, "rewound");
  const changes = host.nativeApproval.calls.filter(call => call.method === "rewindV2" || (call.method === "rewindFiles" && call.args[2] === false));
  assert.deepEqual(changes.map(call => [call.method, call.args]), [
    ["rewindFiles", [sessionId, "rewind-target", false, true]], ["rewindV2", [sessionId, "rewind-target"]],
  ]);
  await page.reload({ waitUntil: "domcontentloaded" });
  const row = page.locator(`[data-session-id="${sessionId}"]`).getByRole("button").first();
  await row.or(page.getByRole("heading", { name: originalTitle, exact: true })).first().waitFor();
  if (await row.isVisible()) await row.click();
  await page.getByText("保留的检查点回复", { exact: true }).waitFor();
  assert.equal(await page.getByText("回退后应消失的回复", { exact: true }).count(), 0);
  assert.equal(await page.getByText("重写这条请求", { exact: true }).count(), 0);
  await page.screenshot({ path: resolve(directory, "native-rewind-reconnected.png"), fullPage: true });
  steps.push("confirmed rewind restores files before the conversation, prefill returns to the draft, and discarded messages stay absent after reconnect/replay");

  for (const name of ["Read", "Bash", "Edit", "Write"]) {
    const id = `completion-only-${name}`;
    await host.nativeApproval.message(tool(id, name === "Bash" ? { command: "pwd" } : { file_path: `/fixture/${name}.ts` }, name));
    for (const event of await host.nativeApproval.message({ type: "user", uuid: `${id}-result`, message: { content: [{ type: "tool_result", tool_use_id: id, content: "Completed" }] } })) {
      await host.emit(event.type, event.data, { itemId: event.itemId });
    }
  }
  const toolRows = stream.locator(".conversation-tool-row");
  await eventually(async () => (await toolRows.locator("strong").allTextContents()).sort(), ["Bash", "Edit", "Read", "Write"], "Completion-only browser events retain native tool names after earlier start events are unavailable");
  await stream.locator(".conversation-tool-group").last().locator("summary").click();
  assert.equal(await toolRows.filter({ hasText: "/fixture/Read.ts" }).locator("strong").innerText(), "Read");
  await page.screenshot({ path: resolve(directory, "native-tool-names-completion-only.png"), fullPage: true });
  host.history.splice(0, host.history.length, ...(await host.nativeApproval.history()).items);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(`[data-session-id="${sessionId}"]`).getByRole("button").first().click();
  await eventually(async () => (await toolRows.locator("strong").allTextContents()).sort(), ["Bash", "Edit", "Read", "Write"], "Native history and replay keep one named row per original call after reload");
  assert.equal(host.requests.filter(request => request.method === "session.tool.detail").length, 0, "Timeline rendering never eagerly fetches full tool outputs");
  await stream.locator(".conversation-tool-group").last().locator("summary").click();
  await toolRows.filter({ hasText: "pwd" }).click();
  const toolDetailDialog = page.getByRole("dialog", { name: "Bash", exact: true });
  await toolDetailDialog.waitFor();
  await eventually(async () => {
    const text = await toolDetailDialog.innerText();
    return text.includes("已完成") && text.includes("pwd") && text.includes("Completed");
  }, true, "Clicking a tool row lazily fetches full input and execution output");
  assert.deepEqual(
    host.requests.filter(request => request.method === "session.tool.detail").map(request => ({
      sessionId: request.params.sessionId,
      toolUseId: request.params.toolUseId,
    })),
    [{ sessionId, toolUseId: "completion-only-Bash" }],
  );
  await page.screenshot({ path: resolve(directory, "native-tool-detail-sheet.png"), fullPage: true });
  await toolDetailDialog.getByRole("button", { name: "关闭工具详情", exact: true }).click();
  await toolDetailDialog.waitFor({ state: "hidden" });
  await toolRows.filter({ hasText: "pwd" }).click();
  await toolDetailDialog.waitFor();
  assert.equal(host.requests.filter(request => request.method === "session.tool.detail").length, 1, "Completed tool detail reuses the in-memory session cache");
  await toolDetailDialog.getByRole("button", { name: "关闭工具详情", exact: true }).click();
  await toolDetailDialog.waitFor({ state: "hidden" });
  steps.push("Read/Bash/Edit/Write keep names and input summaries when only completion events reach the phone, reload merges native history without anonymous or duplicate rows, and clicking a tool row lazily loads and caches full tool input/output via session.tool.detail");

  for (const method of ["getSession", "getTranscriptPage"]) {
    const text = `回退成功后 ${method} 断连`;
    for (const message of [
      { type: "assistant", uuid: `readback-${method}-anchor`, message: { content: [{ type: "text", text: `${method} 保留的检查点` }] } },
      { type: "user", uuid: `readback-${method}-target`, message: { content: text } },
      { type: "assistant", uuid: `readback-${method}-discarded`, message: { content: [{ type: "text", text: `${method} 应移除的回复` }] } },
    ]) for (const event of await host.nativeApproval.message({ ...message, timestamp: Date.now() })) await host.emit(event.type, event.data, { itemId: event.itemId, turnId: event.turnId });
    host.history.splice(0, host.history.length, ...(await host.nativeApproval.history()).items);
    const target = page.locator("article.conversation-item.user").filter({ hasText: text });
    await target.getByRole("button", { name: "回退到这条消息之前", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "回退会话", exact: true });
    await eventually(() => dialog.getByRole("button", { name: "确认回退", exact: true }).isEnabled(), true, "Native preview must finish before injecting the post-success readback disconnect");
    host.nativeApproval.failRewindReadback(method);
    const before = host.nativeApproval.calls.filter(call => call.method === "rewindV2").length;
    await dialog.getByRole("button", { name: "确认回退", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await eventually(() => page.locator(".composer-form textarea").inputValue(), text, "A post-success Native readback disconnect must retain the original prefill");
    assert.equal(await target.count(), 0);
    assert.equal(host.nativeApproval.calls.filter(call => call.method === "rewindV2").length, before + 1);
    assert.equal(host.nativeApproval.failedRewindReadbacks.filter(failed => failed === method).length, 1, "The intended post-success Native readback actually failed");
    await page.screenshot({ path: resolve(directory, `native-rewind-${method}-disconnected.png`), fullPage: true });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator(`[data-session-id="${sessionId}"]`).getByRole("button").first().click();
    await page.getByText(`${method} 保留的检查点`, { exact: true }).waitFor();
    assert.equal(await target.count(), 0, "Refreshed history and replay must not revive the successfully rewound target");
  }
  steps.push("successful Native rewind preserves prefill and closes confirmation when subsequent getSession or getTranscriptPage disconnects; each mutation executes once and discarded history stays absent after reload");

  await page.getByRole("button", { name: "返回会话列表", exact: true }).click();
  await page.getByRole("button", { name: "菜单", exact: true }).click();
  await page.getByRole("navigation", { name: "主要导航", exact: true }).getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("heading", { name: "远端桌面状态", exact: true }).waitFor();
  await page.getByRole("heading", { name: "版本与更新", exact: true }).waitFor();
  assert.ok((await page.locator(".mobile-settings-page").innerText()).includes("v1.1.1"));
  await page.getByRole("button", { name: "检查并升级桌面端", exact: true }).click();
  await eventually(() => host.requests.some(request => request.method === "system.update" && request.params.action === "apply"), true, "Mobile triggers encrypted system.update apply RPC");
  await eventually(() => page.locator(".mobile-settings-page").innerText().then(t => t.includes("正在重启升级")), true, "Remote desktop status reflects applying phase over E2EE");
  steps.push("mobile Settings displays remote desktop version, graceful Web release fallback, and triggers E2EE system.update upgrade");
}

async function verifyNativeQueueActions(page, host, steps, directory) {
  await page.locator(`[data-session-id="${sessionId}"]`).getByRole("button").first().click();
  await page.getByRole("heading", { name: originalTitle, exact: true }).waitFor();
  const composer = page.getByRole("combobox", { name: "给 Claude 发指令" });
  const draft = "保留草稿：queue actions must never submit this";
  const historyMessage = page.locator("article.conversation-item.user").filter({ hasText: "历史中的原生排队消息" });
  await historyMessage.getByRole("status").filter({ hasText: /已排队|排队中/u }).waitFor();
  assert.equal(await historyMessage.count(), 1);
  assert.equal(host.events.length, 0, "Seeded queue must be restored from real native history without delivery events");
  assert.equal(host.queueSeed.receipt.queueMode, "deferred");
  assert.deepEqual(host.session.pendingCommandIds, [host.queueSeed.receipt.commandId]);
  await composer.fill(draft);
  await historyMessage.getByRole("button", { name: "回退到这条消息之前", exact: true }).click();
  const unavailableRewind = page.getByRole("dialog", { name: "回退会话", exact: true });
  await unavailableRewind.getByText("Desktop 无法回退到这条消息之前的对话。", { exact: true }).waitFor();
  assert.equal(await unavailableRewind.getByRole("button", { name: "确认回退", exact: true }).isDisabled(), true, "A queued message without an assistant anchor cannot rewind while Native files are busy");
  assert.ok((await unavailableRewind.innerText()).includes("Session is busy"));
  assert.equal(host.nativeApproval.calls.filter(call => call.method === "rewindV2" || (call.method === "rewindFiles" && call.args[2] === false)).length, 0, "An unavailable preview performs no restore mutation");
  await page.screenshot({ path: resolve(directory, "queue-rewind-unavailable.png"), fullPage: true });
  await unavailableRewind.getByRole("button", { name: "取消", exact: true }).click();
  assert.equal(await composer.inputValue(), draft);
  assert.equal(host.nativeApproval.receipts()[0].state, "queued");
  steps.push("queued rewind without a native assistant anchor reports unavailable; busy files cannot enable confirmation, cancellation preserves the original receipt and draft, and preview performs no restore");
  await page.screenshot({ path: resolve(directory, "queue-history.png"), fullPage: true });
  const release = host.nativeApproval.holdQueueAction();
  try {
    await historyMessage.getByRole("button", { name: "Send now", exact: true }).dblclick();
    await eventually(() => host.nativeApproval.calls.filter(call => call.method === "promoteQueuedMessage").length, 1, "Rapid double-click reaches native promoteQueuedMessage once");
    const beforeReconnect = host.requests.filter(request => request.method === "snapshot.get").length;
    const peers = [...relayPeers].filter(([, hello]) => hello.roomId === host.pairing.roomId && hello.role === "mobile");
    assert.equal(peers.length, 1);
    peers[0][0].close(1012, "disconnect while Send now is pending");
    await eventually(() => host.requests.filter(request => request.method === "snapshot.get").length > beforeReconnect, true, "Pending queue operation reconnects through the real socket");
    assert.equal(host.requests.filter(request => request.method === "turn.queue.steer").length, 1, "Reconnect must not replay the transient queue mutation");
    assert.deepEqual(host.nativeApproval.calls.find(call => call.method === "promoteQueuedMessage").args, [sessionId, host.queueSeed.receipt.messageId]);
    assert.equal(await historyMessage.getByRole("button", { name: "Send now", exact: true }).getAttribute("aria-busy"), "true");
    assert.equal(await historyMessage.getByRole("button", { name: "撤回", exact: true }).isDisabled(), true, "Queue actions share pending state");
    assert.equal(await composer.inputValue(), draft);
    await page.screenshot({ path: resolve(directory, "queue-pending.png"), fullPage: true });
  } finally { release(); }
  await eventually(() => historyMessage.getByRole("button", { name: "撤回", exact: true }).isEnabled(), true, "Requested Send now must leave cancel enabled");
  assert.equal(await historyMessage.getByRole("button", { name: "Send now", exact: true }).isDisabled(), true);
  host.nativeApproval.queueResult("cancelQueuedMessage", false);
  const releaseCancel = host.nativeApproval.holdQueueAction();
  try {
    await historyMessage.getByRole("button", { name: "撤回", exact: true }).dblclick();
    await eventually(() => host.nativeApproval.calls.filter(call => call.method === "cancelQueuedMessage").length, 1, "Rapid double-click withdraws at most once while pending");
    assert.equal(await historyMessage.getByRole("button", { name: "撤回", exact: true }).isDisabled(), true);
  } finally { releaseCancel(); }
  await historyMessage.getByRole("alert").filter({ hasText: "无法撤回" }).waitFor();
  await historyMessage.getByRole("status").filter({ hasText: /已排队|排队中/u }).waitFor();
  assert.equal(host.nativeApproval.receipts()[0].state, "queued", "Native false cannot cancel the receipt");
  assert.equal(await composer.inputValue(), draft);
  await page.screenshot({ path: resolve(directory, "queue-cancel-refused.png"), fullPage: true });
  host.nativeApproval.queueResult("cancelQueuedMessage", true);
  await historyMessage.getByRole("button", { name: "撤回", exact: true }).click();
  await historyMessage.getByRole("status").filter({ hasText: "已取消" }).waitFor();
  assert.equal(await historyMessage.getByRole("button", { name: "撤回", exact: true }).count(), 0);
  assert.equal(await historyMessage.getByRole("alert").count(), 0);
  assert.deepEqual(host.nativeApproval.calls.filter(call => call.method === "cancelQueuedMessage").map(call => call.args), [[sessionId, host.queueSeed.receipt.messageId], [sessionId, host.queueSeed.receipt.messageId]]);
  assert.equal(await composer.inputValue(), draft);
  assert.equal(host.requests.filter(request => ["turn.start", "turn.steer", "turn.interrupt"].includes(request.method)).length, 0, "History queue actions must never submit or interrupt a turn");
  steps.push("history-only queued receipt restores actions; deferred Send now uses original native UUID, shares pending state, permits later cancel, and native false is visible/retryable without changing draft");

  const text = "浏览器发出的原生排队消息";
  await composer.fill(text);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const localMessage = page.locator("article.conversation-item.user").filter({ hasText: text });
  await localMessage.getByRole("status").filter({ hasText: /已排队|排队中/u }).waitFor();
  const localReceipt = host.nativeApproval.receipts().find(receipt => receipt.commandId !== host.queueSeed.receipt.commandId);
  assert.equal(localReceipt.state, "queued");
  assert.equal(localReceipt.queueMode, "deferred");
  assert.equal(await localMessage.count(), 1, "Local send reconciles with native receipt into one bubble");
  const localRequest = host.requests.find(request => request.method === "turn.start");
  assert.equal(localReceipt.requestId, localRequest.requestId);
  assert.equal(localReceipt.idempotencyKey, localRequest.idempotencyKey);
  await composer.fill(draft);
  host.nativeApproval.queueResult("promoteQueuedMessage", false);
  await localMessage.getByRole("button", { name: "Send now", exact: true }).click();
  await localMessage.getByRole("alert").filter({ hasText: "无法立即发送" }).waitFor();
  await localMessage.getByRole("status").filter({ hasText: /已排队|排队中/u }).waitFor();
  assert.equal(await composer.inputValue(), draft);
  await page.screenshot({ path: resolve(directory, "queue-send-refused.png"), fullPage: true });
  host.nativeApproval.queueResult("promoteQueuedMessage", true);
  await localMessage.getByRole("button", { name: "Send now", exact: true }).click();
  await eventually(() => localMessage.getByRole("button", { name: "撤回", exact: true }).isEnabled(), true, "Retry success preserves cancel action");
  assert.equal(await localMessage.getByRole("alert").count(), 0);
  assert.deepEqual(host.nativeApproval.calls.filter(call => call.method === "promoteQueuedMessage").slice(1).map(call => call.args), [[sessionId, localReceipt.messageId], [sessionId, localReceipt.messageId]]);
  steps.push("one browser turn.start traverses the real controller/facade; native queued result reconciles once, Send now false remains visible and retry uses the same native UUID");

  const rekeyedId = randomUUID();
  await host.syncNativeQueue(await host.nativeApproval.event({ type: "steers_rekeyed", rekeyedSteers: [{ from: localReceipt.messageId, to: rekeyedId }] }));
  assert.deepEqual(host.events.filter(event => event.type === "message.delivery").at(-1).data.previousMessageId, localReceipt.messageId);
  await eventually(() => localMessage.getAttribute("data-stream-key"), rekeyedId, "Top-level native rekey moves the displayed bubble to the new UUID");
  assert.equal(await localMessage.count(), 1, "Rekey must not duplicate the local/history bubble");
  assert.equal(host.nativeApproval.receipts().find(receipt => receipt.commandId === localReceipt.commandId).messageId, rekeyedId, "Rekey persists the real receipt");
  const snapshotCount = host.requests.filter(request => request.method === "snapshot.get").length;
  const mobilePeers = [...relayPeers].filter(([, hello]) => hello.roomId === host.pairing.roomId && hello.role === "mobile");
  assert.equal(mobilePeers.length, 1);
  mobilePeers[0][0].close(1012, "queue scenario reconnect");
  await eventually(() => host.requests.filter(request => request.method === "snapshot.get").length > snapshotCount, true, "Real encrypted socket reconnect fetches queue snapshot");
  await localMessage.getByRole("status").filter({ hasText: /已排队|排队中/u }).waitFor();
  await eventually(() => localMessage.getByRole("button", { name: "撤回", exact: true }).isEnabled(), true, "Reconnect restores queued cancel action");
  assert.equal(await localMessage.count(), 1);
  assert.equal(await composer.inputValue(), draft);
  await page.screenshot({ path: resolve(directory, "queue-rekey-reconnected.png"), fullPage: true });
  const missedRekeyId = randomUUID();
  await host.syncNativeQueue(await host.nativeApproval.event({ type: "steers_rekeyed", rekeyedSteers: [{ from: rekeyedId, to: missedRekeyId }] }), { pushEvents: false });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(`[data-session-id="${sessionId}"]`).getByRole("button").first().click();
  await eventually(() => localMessage.getAttribute("data-stream-key"), missedRekeyId, "Fresh history reconciles the cached UUID without its missing rekey event");
  assert.equal(await localMessage.count(), 1, "Stable receipt identity must collapse the old cached bubble and current native history");
  await composer.fill(draft);
  await page.screenshot({ path: resolve(directory, "queue-missing-rekey-recovered.png"), fullPage: true });
  await localMessage.getByRole("button", { name: "撤回", exact: true }).click();
  await localMessage.getByRole("status").filter({ hasText: "已取消" }).waitFor();
  assert.deepEqual(host.nativeApproval.calls.filter(call => call.method === "cancelQueuedMessage").at(-1).args, [sessionId, missedRekeyId]);
  assert.equal(await composer.inputValue(), draft);
  steps.push("top-level steers_rekeyed persists the new UUID and keeps one bubble; real socket reconnect restores queue/draft, and subsequent cancel uses the new UUID and shows 已取消");

  const steered = await host.syncNativeQueue(await host.nativeApproval.enqueue("历史中的 steered 排队消息", "steered"), { pushEvents: false });
  assert.equal(steered.receipt.queueMode, "steered");
  // A fresh page must recover native history/receipt controls without local turns or delivery events for this seed.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(`[data-session-id="${sessionId}"]`).getByRole("button").first().click();
  await page.getByRole("heading", { name: originalTitle, exact: true }).waitFor();
  const steeredMessage = page.locator("article.conversation-item.user").filter({ hasText: "历史中的 steered 排队消息" });
  await steeredMessage.getByRole("status").filter({ hasText: /已排队|排队中/u }).waitFor();
  await composer.fill(draft);
  await steeredMessage.getByRole("button", { name: "Send now", exact: true }).click();
  await eventually(() => host.nativeApproval.calls.filter(call => call.method === "sendSteeredNow").length, 1, "Steered queue uses native sendSteeredNow");
  assert.deepEqual(host.nativeApproval.calls.find(call => call.method === "sendSteeredNow").args, [sessionId, steered.receipt.messageId]);
  await eventually(() => steeredMessage.getByRole("button", { name: "撤回", exact: true }).isEnabled(), true, "Steered Send now still permits cancel");
  const resumesBeforeLateCancel = host.requests.filter(request => request.method === "events.resume").length;
  const releaseLateCancel = host.nativeApproval.holdQueueAction();
  try {
    await steeredMessage.getByRole("button", { name: "撤回", exact: true }).click();
    await eventually(() => host.nativeApproval.calls.filter(call => call.method === "cancelQueuedMessage" && call.args[1] === steered.receipt.messageId).length, 1, "Cancel remains pending at the native boundary");
    await host.syncNativeQueue(await host.nativeApproval.event({ type: "message", message: { type: "command_lifecycle", command_uuid: steered.receipt.messageId, state: "started" } }));
    await host.syncNativeQueue(await host.nativeApproval.event({ type: "message", message: { type: "result", user_message_uuid: steered.receipt.messageId, is_error: false } }));
    await steeredMessage.getByRole("status").filter({ hasText: "已完成" }).waitFor();
  } finally { releaseLateCancel(); }
  await eventually(() => host.requests.filter(request => request.method === "events.resume").length > resumesBeforeLateCancel, true, "Late cancel response reaches the browser and resumes events");
  assert.equal(host.nativeApproval.receipts().find(receipt => receipt.commandId === steered.receipt.commandId).state, "completed", "Late native cancel true cannot overwrite an observed completion");
  await steeredMessage.getByRole("status").filter({ hasText: "已完成" }).waitFor();
  assert.equal(host.events.some(event => event.type === "message.delivery" && event.data.commandId === steered.receipt.commandId && event.data.delivery === "cancelled"), false);
  assert.equal(await composer.inputValue(), draft);
  assert.equal(host.requests.filter(request => request.method === "turn.start").length, 1, "All queue actions/reconnects preserve exactly one deliberate composer submission");
  assert.equal(host.requests.filter(request => ["turn.steer", "turn.interrupt"].includes(request.method)).length, 0);
  assert.equal(host.nativeApproval.calls.filter(call => call.method === "sendMessage").length, 3, "Only two fixture seeds and one deliberate browser submit reach native sendMessage");
  assert.equal(host.nativeApproval.calls.filter(call => call.method === "interrupt").length, 0);
  for (const request of host.requests.filter(request => ["turn.queue.steer", "turn.queue.cancel"].includes(request.method))) {
    assert.equal("text" in request.params || "attachments" in request.params, false, "Queue actions carry command identity without resubmitting content");
  }
  assert.deepEqual(host.nativeApproval.receipts().map(receipt => ({ commandId: receipt.commandId, state: receipt.state })), [
    { commandId: host.queueSeed.receipt.commandId, state: "cancelled" },
    { commandId: localReceipt.commandId, state: "cancelled" },
    { commandId: steered.receipt.commandId, state: "completed" },
  ]);
  assert.equal(host.session.pendingCount, 0);
  assert.deepEqual(host.session.pendingCommandIds, []);
  assert.equal(await page.getByRole("button", { name: "Send now", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "撤回", exact: true }).count(), 0);
  assert.equal(await page.getByRole("status", { name: "消息排队状态" }).count(), 0);
  await page.screenshot({ path: resolve(directory, "queue-terminal-states.png"), fullPage: true });
  steps.push("fresh history reconciles a missed rekey into one cached bubble; steered Send now uses its native UUID; completed events preceding a delayed cancel true remain completed; successful cancels persist and queue actions never resubmit or interrupt");

  for (const event of await host.nativeApproval.message({ type: "assistant", uuid: "received-rewind-anchor", timestamp: Date.now(), message: { content: [{ type: "text", text: "保留的原生回退锚点" }] } })) await host.emit(event.type, event.data, { itemId: event.itemId });
  host.nativeApproval.queuedReply(false);
  const receivedText = "只有 delivered 确认、仍在等待读取的指令";
  await page.getByRole("button", { name: "立即调整", exact: true }).click();
  await composer.fill(receivedText);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await eventually(() => host.nativeApproval.receipts().length, 4, "A real browser immediate send reaches the native receipt without a queued flag");
  await eventually(() => host.nativeApproval.receipts().at(-1)?.state, "submitted", "The delivered-only Native reply must arrive before checking the submitted receipt");
  const received = host.nativeApproval.receipts().at(-1);
  assert.equal(received.queueMode, "steered");
  assert.equal(received.state, "submitted");
  await host.syncNativeQueue(await host.nativeApproval.event({ type: "message", message: { type: "user", uuid: received.messageId, message: { content: receivedText } } }));
  const receivedMessage = page.locator("article.conversation-item.user").filter({ hasText: receivedText });
  await receivedMessage.getByRole("status").filter({ hasText: "已接收" }).waitFor();
  assert.equal(host.nativeApproval.receipts().at(-1).state, "session-received");
  assert.equal(host.session.pendingCount, 0, "The adapter does not invent queued status to expose actions");
  await composer.fill(draft);
  await receivedMessage.getByRole("button", { name: "Send now", exact: true }).click();
  await eventually(() => host.nativeApproval.calls.filter(call => call.method === "sendSteeredNow" && call.args[1] === received.messageId).length, 1, "Received-only Send now calls the known native steering route exactly once");
  await eventually(() => receivedMessage.getByRole("button", { name: "撤回", exact: true }).isEnabled(), true, "Received-only Send now preserves draft and later cancellation");
  assert.equal(await composer.inputValue(), draft);
  assert.equal(await receivedMessage.getByRole("button", { name: "回退到这条消息之前", exact: true }).isEnabled(), true);
  await page.screenshot({ path: resolve(directory, "queue-received-actions.png"), fullPage: true });
  await receivedMessage.getByRole("button", { name: "回退到这条消息之前", exact: true }).click();
  const rewind = page.getByRole("dialog", { name: "回退会话", exact: true });
  await eventually(() => rewind.getByRole("button", { name: "确认回退", exact: true }).isEnabled(), true, "Native conversation rewind remains available while its file preview reports busy");
  assert.equal(await rewind.getByRole("combobox", { name: "回退范围", exact: true }).inputValue(), "conversation");
  assert.ok((await rewind.innerText()).includes("停止当前任务"));
  await page.screenshot({ path: resolve(directory, "queue-running-rewind-preview.png"), fullPage: true });
  await rewind.getByRole("button", { name: "确认回退", exact: true }).click();
  await rewind.waitFor({ state: "hidden" });
  await eventually(() => receivedMessage.count(), 0, "Confirmed native rewind removes the selected received message");
  await eventually(() => composer.inputValue(), receivedText, "Native prefill restores the received message as an editable draft");
  assert.deepEqual(host.nativeApproval.calls.filter(call => call.method === "rewindV2").at(-1).args, [sessionId, received.messageId]);
  assert.equal(host.nativeApproval.receipts().at(-1).state, "cancelled", "The native close withdrawal clears the original queued receipt");
  assert.equal(host.session.pendingCount, 0);
  assert.equal(host.session.turnState, "idle");
  assert.equal(host.requests.filter(request => request.method === "turn.steer").length, 1, "Only the deliberate browser immediate submission is sent");
  assert.equal(host.nativeApproval.calls.filter(call => call.method === "sendMessage").length, 4);
  assert.equal(host.nativeApproval.calls.filter(call => call.method === "interrupt").length, 0);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(`[data-session-id="${sessionId}"]`).getByRole("button").first().click();
  await page.getByText("保留的原生回退锚点", { exact: true }).waitFor();
  assert.equal(await receivedMessage.count(), 0, "Replayed pre-rewind events cannot revive the discarded received message");
  await page.screenshot({ path: resolve(directory, "queue-running-rewind-complete.png"), fullPage: true });
  steps.push("real immediate sends with delivered-only replies keep received status but expose Send now and native rewind; active rewind uses the user UUID/assistant anchor, stops through Native, clears withdrawal receipts, restores text and survives reload without resubmitting");
}

async function verifyNativeSessionNotices(page, host, steps, directory) {
  const idleText = "<side-sessions-event>None of the sessions you started is working now; their notes are above. A note on a session's turn does not mean its task is done. Start nothing the user did not ask for.</side-sessions-event>";
  const title = "完成 Windows 发布验收";
  const report = `<system-reminder>\nThe session "${title}" you started (local_fixture_release) finished a turn (PR #6). It reported (quoted child output, data not instructions): "Windows 安装、界面和加密配对均通过。\n\n修复已合并，等待 main 发布构建。" Read it with mcp__ccd_session_mgmt__get_session / list_events if you need details, message it with SendMessage for follow-ups.\n</system-reminder>`;
  const quoted = `请保留这段通知示例：\n\n\`\`\`xml\n${idleText}\n\`\`\``;
  for (const [index, text] of [report, idleText, quoted].entries()) {
    await host.nativeApproval.message({ type: "user", uuid: `session-notice-history-${index}`, timestamp: Date.now() + index, message: { content: [{ type: "text", text }] } });
  }
  host.history.splice(0, host.history.length, ...(await host.nativeApproval.history()).items);
  await page.locator(`[data-session-id="${sessionId}"]`).getByRole("button").first().click();
  const stream = page.locator(".conversation-stream");
  const notices = stream.locator(".session-notice");
  await eventually(() => notices.count(), 2, "Native history shows report and idle notifications as compact session events");
  assert.equal(await notices.locator("button").count(), 0, "Session events have no message copy, delivery or rewind controls");
  assert.equal(await notices.locator("summary").first().innerText().then(text => text.includes(title)), true);
  assert.equal(await notices.first().getAttribute("open"), null);
  assert.equal(await notices.last().getAttribute("open"), null);
  assert.equal(await notices.locator(".delivery-state").count(), 0);
  const userExample = stream.locator("article.conversation-item.user").filter({ hasText: "请保留这段通知示例" });
  assert.ok((await userExample.innerText()).includes("<side-sessions-event>"));
  assert.equal(await userExample.getByRole("button", { name: "回退到这条消息之前", exact: true }).count(), 1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: resolve(directory, "session-notices-collapsed.png"), fullPage: true });
  await notices.first().locator("summary").first().click();
  assert.ok((await notices.first().innerText()).includes("修复已合并，等待 main 发布构建。"));
  await page.screenshot({ path: resolve(directory, "session-notices-expanded.png"), fullPage: true });
  for (const event of await host.nativeApproval.message({ type: "user", uuid: "session-notice-live", timestamp: Date.now(), message: { content: [{ type: "text", text: report.replace(title, "完成 Android 发布验收") }] } })) {
    await host.emit(event.type, event.data, { itemId: event.itemId, turnId: event.turnId });
  }
  await eventually(() => notices.count(), 3, "Live Native reports use the same compact presentation as history");
  host.history.splice(0, host.history.length, ...(await host.nativeApproval.history()).items);
  await page.reload({ waitUntil: "domcontentloaded" });
  const row = page.locator(`[data-session-id="${sessionId}"]`).getByRole("button").first();
  await row.or(page.getByRole("heading", { name: originalTitle, exact: true })).first().waitFor();
  if (await row.isVisible()) await row.click();
  await eventually(() => notices.count(), 3, "Reload merges Native history and live notices without duplicate cards");
  assert.equal(host.requests.filter(request => ["turn.start", "turn.steer", "session.rewind", "permission.resolve"].includes(request.method)).length, 0);
  steps.push("Native report and idle notices stay compact in history, live updates and replay; original text remains readable, quoted examples keep user controls, and no Native mutation is sent");

  await page.getByRole("button", { name: "返回会话列表", exact: true }).click();
  const { untrustedDir, manualTrustDir } = host.nativeApproval;
  const createDialog = page.locator(".session-create-dialog");
  const chooseFolderByPath = async (targetDir) => {
    await createDialog.getByRole("button", { name: "选择文件夹" }).click();
    await createDialog.getByRole("button", { name: "浏览电脑文件夹", exact: true }).click();
    await createDialog.getByRole("button", { name: "输入路径", exact: true }).click();
    await createDialog.getByLabel("当前路径", { exact: true }).fill(targetDir);
    await createDialog.getByLabel("当前路径", { exact: true }).press("Enter");
    await createDialog.getByRole("button", { name: "使用此文件夹", exact: true }).click();
  };

  await page.getByRole("button", { name: "新建会话", exact: true }).click();
  await chooseFolderByPath(untrustedDir);
  await createDialog.getByLabel("会话名称（可选）", { exact: true }).fill("受信任目录会话");
  await createDialog.getByRole("button", { name: "创建会话", exact: true }).click();

  const trustAlert = createDialog.getByRole("alert");
  await eventually(() => trustAlert.innerText(), `该文件夹首次使用，是否信任并允许 Claude 访问「${untrustedDir}」？`, "Untrusted folder prompts for explicit confirmation without exposing EIPC text");
  assert.equal((await createDialog.innerText()).includes("$eipc_message$"), false);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: resolve(directory, "workspace-trust-confirm.png"), fullPage: true });

  await createDialog.getByRole("button", { name: "信任并创建", exact: true }).click();
  await createDialog.waitFor({ state: "hidden" });
  await page.getByRole("heading", { name: "受信任目录会话", exact: true }).waitFor();
  assert.deepEqual(
    host.nativeApproval.calls.filter(call => call.method === "saveTrust").map(call => call.args),
    [[untrustedDir]],
  );

  await page.getByRole("button", { name: "返回会话列表", exact: true }).click();
  host.nativeApproval.setTrustPolicy({ keepUntrustedAfterSave: true });
  await page.getByRole("button", { name: "新建会话", exact: true }).click();
  await chooseFolderByPath(manualTrustDir);
  await createDialog.getByLabel("会话名称（可选）", { exact: true }).fill("手动信任兜底会话");
  await createDialog.getByRole("button", { name: "创建会话", exact: true }).click();
  await createDialog.getByRole("button", { name: "信任并创建", exact: true }).click();
  await eventually(() => trustAlert.innerText(), `请在电脑端 Claude 窗口打开并信任「${manualTrustDir}」后重试。`, "Manual fallback guides desktop GUI approval when saveTrust cannot satisfy trust");
  await page.screenshot({ path: resolve(directory, "workspace-trust-manual.png"), fullPage: true });

  host.nativeApproval.trustWorkspace(manualTrustDir);
  await createDialog.getByRole("button", { name: "重试创建", exact: true }).click();
  await createDialog.waitFor({ state: "hidden" });
  await page.getByRole("heading", { name: "手动信任兜底会话", exact: true }).waitFor();
  assert.equal(host.requests.filter(request => request.method === "session.create").at(-1)?.params.trustWorkspace, undefined);
  assert.equal(host.requests.filter(request => ["turn.start", "turn.steer", "session.rewind", "permission.resolve"].includes(request.method)).length, 0);
  steps.push("untrusted folders sanitize WorkspaceTrustError into confirmation + saveTrust auto-retry, and degrade to manual desktop guidance + one-click retry when saveTrust is insufficient");
}

async function verifyProjectGrouping(page, host, steps, directory) {
  const groups = page.locator(".project-groups > .project-group:not(.archived-group)");
  const headers = groups.locator(".project-group-open strong");
  const mainGroup = groups.filter({ has: page.locator(`[data-session-id="${sessionId}"]`) });
  const parent = host.snapshot.sessions.find(session => session.sessionId === "browser-e2e-parent");
  const worktree = host.snapshot.sessions.find(session => session.sessionId === sessionId);
  const orderKey = `bridge-project-order:${host.pairing.roomId}`;
  const savedOrder = JSON.stringify([...host.snapshot.projects].reverse().map(project => project.projectId));
  assert.equal(host.snapshot.projects.length, 2);
  assert.equal(worktree.projectId, parent.projectId);
  assert.equal(worktree.parentSessionId, undefined, "Sharing a repository cannot invent a fork relationship");
  assert.notEqual(worktree.cwd, parent.cwd, "The worktree keeps its actual Native cwd");
  assert.equal(host.snapshot.projects.find(project => project.projectId === parent.projectId).cwd, parent.cwd);
  assert.deepEqual(await headers.allTextContents(), ["other-project", "claude-desktop-bridge"]);
  assert.equal(await mainGroup.locator('[data-session-id="browser-e2e-parent"]').count(), 1);
  assert.equal(await mainGroup.locator(".project-count-pill").innerText(), "2");
  const primaryForkToggle = mainGroup.locator(".mobile-fork-toggle:not(.is-archived-fold)");
  const archivedFoldToggle = mainGroup.locator(".mobile-fork-toggle.is-archived-fold");
  assert.equal(await primaryForkToggle.count(), 1);
  assert.equal((await primaryForkToggle.innerText()).trim(), "1 个 Fork 分支");
  assert.equal(await page.locator('[data-session-id="browser-e2e-fork"]').count(), 0);
  assert.equal(await page.locator('[data-session-id="browser-e2e-btw-archived"]').count(), 0);
  await primaryForkToggle.click();
  await mainGroup.locator('[data-session-id="browser-e2e-fork"]').waitFor();
  assert.equal(await primaryForkToggle.getAttribute("aria-expanded"), "true");
  assert.equal(await page.locator('[data-session-id="browser-e2e-btw-archived"]').count(), 0);
  assert.equal(await archivedFoldToggle.count(), 1);
  assert.equal(await archivedFoldToggle.getAttribute("aria-expanded"), "false");
  assert.equal((await archivedFoldToggle.innerText()).trim(), "1 个已结束侧聊");
  await archivedFoldToggle.click();
  await mainGroup.locator('[data-session-id="browser-e2e-btw-archived"]').waitFor();
  assert.equal(await archivedFoldToggle.getAttribute("aria-expanded"), "true");
  await page.screenshot({ path: resolve(directory, "project-fork-expanded.png"), fullPage: true });
  steps.push("real Native projection groups linked worktrees under the repository; active fork count excludes archived /btw sidechats while preserving a secondary fold");

  const search = page.getByPlaceholder("搜索项目或会话", { exact: true });
  await search.fill(worktree.title);
  await eventually(() => headers.allTextContents(), ["claude-desktop-bridge"], "Searching the worktree title keeps its repository project");
  assert.equal(await page.locator(`[data-session-id="${sessionId}"]`).count(), 1);
  await search.fill("");
  await eventually(() => headers.allTextContents(), ["other-project", "claude-desktop-bridge"], "Clearing search restores saved project order");
  assert.equal(await page.evaluate(key => localStorage.getItem(key), orderKey), savedOrder);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(`[data-session-id="${sessionId}"]`).waitFor();
  assert.deepEqual(await headers.allTextContents(), ["other-project", "claude-desktop-bridge"]);
  assert.equal(await page.evaluate(key => localStorage.getItem(key), orderKey), savedOrder);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "Project list fits the phone viewport");

  await primaryForkToggle.click();
  await archivedFoldToggle.click();
  await mainGroup.locator('[data-session-id="browser-e2e-btw-archived"]').getByRole("button").first().click();
  const parentChainButton = page.locator(".fork-chain-bar").getByRole("button", { name: "主会话：主会话", exact: true });
  await parentChainButton.waitFor();
  await parentChainButton.click();
  await page.getByRole("heading", { name: "主会话", exact: true }).waitFor();
  await page.getByRole("button", { name: "会话操作", exact: true }).click();
  await page.getByRole("button", { name: /分支 1/u }).waitFor();
  await page.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "返回会话列表", exact: true }).click();
  await page.locator(`[data-session-id="${sessionId}"]`).waitFor();

  const forkSnapshot = host.snapshot.sessions.find(session => session.sessionId === "browser-e2e-fork");
  forkSnapshot.archivedAt = Date.now();
  await host.emit("session.archived", { archived: true, archivedAt: forkSnapshot.archivedAt }, { sessionId: "browser-e2e-fork" });
  await eventually(() => primaryForkToggle.count(), 0, "Archiving the last active fork moves the parent to archived-only fold");
  assert.equal(await mainGroup.locator(".mobile-fork-group.is-archived-only").count(), 1);
  assert.equal((await archivedFoldToggle.innerText()).trim(), "2 个已归档分支与侧聊");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "Archived-only fold fits the phone viewport");

  assert.equal(host.requests.filter(request => request.method.startsWith("turn.")).length, 0);
  await writeFile(resolve(directory, "project-catalog.json"), JSON.stringify({ projects: host.snapshot.projects, sessions: host.snapshot.sessions }, null, 2));
  await page.screenshot({ path: resolve(directory, "project-list.png"), fullPage: true });

  await page.locator(".project-order-bar button").click();
  const orderSheet = page.getByRole("dialog", { name: "项目顺序" });
  await orderSheet.waitFor();
  await orderSheet.evaluate((el) => Promise.all(el.getAnimations().map((animation) => animation.finished)));
  const orderRowTitles = orderSheet.locator(".project-order-row strong");
  assert.deepEqual(await orderRowTitles.allTextContents(), ["other-project", "claude-desktop-bridge"]);
  assert.equal(await orderSheet.locator(".project-order-handle").count(), 2);

  const firstHandle = orderSheet.getByRole("button", { name: "拖动「other-project」调整顺序" });
  const secondRow = orderSheet.locator(".project-order-row").nth(1);
  const handleBox = await firstHandle.boundingBox();
  const secondBox = await secondRow.boundingBox();
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + handleBox.width / 2, secondBox.y + secondBox.height * 0.75, { steps: 6 });
  await orderSheet.locator(".project-order-row.is-dragging").waitFor();
  assert.deepEqual(await orderRowTitles.allTextContents(), ["claude-desktop-bridge", "other-project"]);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "Dragging project order row stays within 375px viewport");
  await page.screenshot({ path: resolve(directory, "project-order-dragging.png"), fullPage: true });
  await page.mouse.up();
  await orderSheet.getByRole("button", { name: "完成", exact: true }).click();
  await eventually(() => headers.allTextContents(), ["claude-desktop-bridge", "other-project"], "Handle drag persists reordered projects");

  await page.locator(".project-order-bar button").click();
  await orderSheet.waitFor();
  await orderSheet.evaluate((el) => Promise.all(el.getAnimations().map((animation) => animation.finished)));
  const targetRowText = orderSheet.locator(".project-order-row").nth(1).locator("strong");
  const firstRow = orderSheet.locator(".project-order-row").nth(0);
  const textBox = await targetRowText.boundingBox();
  const firstBox = await firstRow.boundingBox();
  await page.mouse.move(textBox.x + 24, textBox.y + textBox.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(260);
  await orderSheet.locator(".project-order-row.is-dragging").waitFor();
  await page.mouse.move(textBox.x + 24, firstBox.y + firstBox.height * 0.25, { steps: 6 });
  assert.deepEqual(await orderRowTitles.allTextContents(), ["other-project", "claude-desktop-bridge"]);
  await page.mouse.up();
  await orderSheet.getByRole("button", { name: "完成", exact: true }).click();
  await eventually(() => headers.allTextContents(), ["other-project", "claude-desktop-bridge"], "Row long-press drag restores saved project order");
  assert.equal(await page.evaluate(key => localStorage.getItem(key), orderKey), savedOrder);

  steps.push("saved main-project ordering survives search and reload, handle and long-press drag reorder projects cleanly, unrelated projects remain separate, and the 375px layout has no horizontal overflow");
}

async function verifySectionManage(page, host, steps, directory) {
  const groups = page.locator(".project-groups > .project-group:not(.archived-group)");
  const headers = groups.locator(".project-group-open strong");
  const search = page.getByPlaceholder("搜索项目或会话", { exact: true });

  async function createSectionFromDirectory(name) {
    await page.getByRole("button", { name: "目录选项", exact: true }).click();
    await page.getByRole("button", { name: "新建 Section", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "新建 Section" });
    await dialog.getByLabel("Section 名称").fill(name);
    await dialog.getByRole("button", { name: "创建 Section", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
  }

  await createSectionFromDirectory("待办分组");
  await createSectionFromDirectory("临时空组");
  await eventually(
    async () => {
      const names = await headers.allTextContents();
      return names.includes("待办分组") && names.includes("临时空组");
    },
    true,
    "Newly created empty sections appear in catalog",
  );

  // Folder groups do not render custom section management actions; custom sections do.
  assert.equal(await page.getByRole("button", { name: "管理分组：待办分组", exact: true }).count(), 1);
  assert.equal(await page.getByRole("button", { name: "管理分组：claude-desktop-bridge", exact: true }).count(), 0);

  // Toggle "隐藏空分组（2）" and verify persistence + search + auto-reveal on new section creation.
  await page.getByRole("button", { name: "目录选项", exact: true }).click();
  await page.getByRole("button", { name: "隐藏空分组（2）", exact: true }).click();
  await eventually(
    async () => {
      const names = await headers.allTextContents();
      return !names.includes("待办分组") && !names.includes("临时空组") && names.includes("claude-desktop-bridge");
    },
    true,
    "Hiding empty sections removes empty desktop-group headers while preserving folder groups",
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(`[data-session-id="${sessionId}"]`).waitFor();
  assert.equal((await headers.allTextContents()).includes("临时空组"), false, "Hidden empty sections persist across reload");

  await search.fill("临时空组");
  await eventually(() => headers.allTextContents(), ["临时空组"], "Search still surfaces matching empty custom sections");
  await search.fill("");
  await eventually(() => (headers.allTextContents()).then(names => names.includes("临时空组")), false, "Clearing search hides empty sections again");

  await createSectionFromDirectory("新建即现");
  await eventually(
    async () => {
      const names = await headers.allTextContents();
      return names.includes("新建即现") && names.includes("待办分组") && names.includes("临时空组");
    },
    true,
    "Creating a new section reveals empty sections automatically",
  );
  steps.push("empty custom sections can be hidden per host, remain searchable, persist across reloads, and reveal automatically when creating a new section");

  // 1-tap delete on empty section ("删除空分组") without ConfirmationDialog.
  await page.getByRole("button", { name: "管理分组：临时空组", exact: true }).click();
  await page.getByRole("button", { name: "删除空分组", exact: true }).click();
  assert.equal(await page.getByRole("alertdialog").count(), 0, "Empty section deletion skips confirmation dialog");
  await eventually(
    async () => (await headers.allTextContents()).includes("临时空组"),
    false,
    "Deleted empty section disappears immediately",
  );

  // Rename custom section ("待办分组" -> "重点推进").
  await page.getByRole("button", { name: "管理分组：待办分组", exact: true }).click();
  await page.getByRole("button", { name: "重命名分组", exact: true }).click();
  const renameDialog = page.getByRole("dialog", { name: "重命名分组" });
  await renameDialog.getByLabel("分组名称").fill("重点推进");
  await renameDialog.getByRole("button", { name: "保存", exact: true }).click();
  await renameDialog.waitFor({ state: "detached" });
  await eventually(
    async () => {
      const names = await headers.allTextContents();
      return names.includes("重点推进") && !names.includes("待办分组");
    },
    true,
    "Renamed custom section updates in catalog",
  );
  steps.push("empty sections delete in one tap and custom sections rename via native section.rename");

  // Move a session into "重点推进", then verify non-empty delete requires confirmation and returns session to folder.
  await page.locator('[data-session-id="browser-e2e-misc-sub"]').locator("..").getByRole("button", { name: "会话操作", exact: true }).click();
  await page.getByRole("button", { name: /移动到分组/u }).click();
  await page.locator(".m-sheet").getByRole("button", { name: /重点推进/u }).click();
  await eventually(
    () => host.snapshot.sessions.find(item => item.sessionId === "browser-e2e-misc-sub")?.projectName,
    "重点推进",
    "Session moved into renamed section",
  );

  await page.getByRole("button", { name: "管理分组：重点推进", exact: true }).click();
  await page.getByRole("button", { name: "删除分组", exact: true }).click();
  const confirmDialog = page.getByRole("alertdialog");
  await confirmDialog.waitFor();
  assert.match(await confirmDialog.innerText(), /组内 1 个会话不会删除，将移回各自的项目目录/u);
  await page.screenshot({ path: resolve(directory, "section-delete-confirm.png"), fullPage: true });
  await confirmDialog.getByRole("button", { name: "删除分组", exact: true }).click();
  await confirmDialog.waitFor({ state: "detached" });

  await eventually(
    async () => (await headers.allTextContents()).includes("重点推进"),
    false,
    "Confirmed non-empty section deletion removes custom section",
  );
  await eventually(
    () => page.locator('[data-session-id="browser-e2e-misc-sub"]').count(),
    1,
    "Session inside deleted section remains intact and returns to its folder group",
  );
  assert.equal(host.snapshot.sessions.find(item => item.sessionId === "browser-e2e-misc-sub")?.projectName, "claude-desktop-bridge");
  assert.equal(host.requests.some(request => request.method === "section.rename"), true);
  assert.equal(host.requests.filter(request => request.method === "section.delete").length, 2);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "Section manage UI fits 375px viewport");
  steps.push("deleting a non-empty section requires confirmation, calls native delete_section, and safely returns sessions to their folder project");
}

async function runScenario(theme, scenario) {
  const name = `${theme}-${scenario}`;
  const directory = resolve(runDir, name);
  await mkdir(directory, { recursive: true });
  const errors = [];
  const browserLog = [];
  const steps = [];
  const startedAt = Date.now();
  const serverRoutes = [];
  let context;
  let page;
  let host;
  let failure;
  try {
    host = await createMockHost(!["delivery-approval-reconnect", "native-approvals", "native-prompts-pr", "native-messages", "history-pagination", "native-boundaries", "native-queue-actions", "native-session-notices", "project-grouping", "section-manage"].includes(scenario), scenario !== "delivery-approval-reconnect", errors, ["native-approvals", "native-prompts-pr", "native-messages", "native-boundaries", "native-queue-actions", "native-session-notices", "project-grouping", "section-manage"].includes(scenario), scenario === "native-queue-actions", scenario === "section-manage");
    if (scenario === "native-prompts-pr") await host.syncNativeDialogs(await host.nativeApproval.seedPullRequest());
    if (scenario === "native-queue-actions") host.queueSeed = await host.syncNativeQueue(await host.nativeApproval.enqueue("历史中的原生排队消息"), { pushEvents: false });
    if (scenario === "project-grouping") Object.assign(host.snapshot, await host.nativeApproval.projectCatalog());
    if (scenario === "section-manage") await syncNativeSections(host);
    context = await browser.newContext({
      viewport: { width: 375, height: 812 }, colorScheme: theme,
      serviceWorkers: "block",
    });
    await context.addInitScript((mode) => {
      localStorage.setItem("bridge-theme", mode);
      localStorage.setItem("bridge-theme-family", "sunstone");
    }, theme);
    if (scenario === "project-grouping") {
      await context.addInitScript(({ hostId, projectIds }) => {
        const key = `bridge-project-order:${hostId}`;
        if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(projectIds));
      }, { hostId: host.pairing.roomId, projectIds: [...host.snapshot.projects].reverse().map(project => project.projectId) });
    }
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
    // Visiting the real pairing URL imports identity via the production hook and
    // stores it in this context's own IndexedDB; no vault or hook is replaced.
    await page.goto(buildPairingUrl(baseUrl, host.pairing), { waitUntil: "domcontentloaded" });
    await page.locator(`[data-session-id="${sessionId}"]`).waitFor();
    await eventually(() => host.requests.some((request) => request.method === "snapshot.get"), true, "Pairing requires an encrypted snapshot handshake");
    assert.equal(await page.locator("html").getAttribute("data-theme"), theme);
    assert.equal(await page.locator("[data-session-id]").count(), ["project-grouping", "section-manage"].includes(scenario) ? 3 : 2, "Pairing must synchronize the visible session rows");
    assert.equal(await page.evaluate(() => Boolean(window.bridgeDesktop)), false, "Test must load the mobile App path");
    assert.equal(await page.evaluate(() => innerWidth), 375);
    steps.push("real App pairing and encrypted snapshot synchronize the session list at 375x812");
    if (scenario === "native-approvals") await verifyNativeApprovals(page, host, steps, directory);
    else if (scenario === "native-prompts-pr") await verifyNativePromptsPr(page, host, steps, directory);
    else if (scenario === "native-messages") await verifyNativeMessages(page, host, steps, directory);
    else if (scenario === "history-pagination") await verifyHistoryPagination(page, host, steps, directory);
    else if (scenario === "native-boundaries") await verifyNativeBoundaries(page, host, steps, directory);
    else if (scenario === "native-queue-actions") await verifyNativeQueueActions(page, host, steps, directory);
    else if (scenario === "native-session-notices") await verifyNativeSessionNotices(page, host, steps, directory);
    else if (scenario === "project-grouping") await verifyProjectGrouping(page, host, steps, directory);
    else if (scenario === "section-manage") await verifySectionManage(page, host, steps, directory);
    else if (scenario === "delivery-approval-reconnect") await verifyDelivery(page, host, steps);
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
    await writeFile(resolve(directory, "browser-errors.json"), JSON.stringify({ errors, console: browserLog }, null, 2));
    // No pairing secrets, tokens, or encrypted envelopes are written to reports.
    await writeFile(resolve(directory, "host-rpc.json"), JSON.stringify({
      requests: host?.requests.map(({ method, requestId, idempotencyKey, params }) => ({ method, requestId, idempotencyKey, params })),
      resumeBatches: host?.resumeBatches,
      nativeTrace: host?.nativeTrace,
      ...(host?.nativeQueue ? { nativeCalls: host.nativeApproval.calls, receipts: host.nativeApproval.receipts(), queueEvents: host.events } : {}),
    }, null, 2));
    if (host?.nativeApproval) {
      const idx = nativeHosts.indexOf(host.nativeApproval);
      if (idx !== -1) nativeHosts.splice(idx, 1);
      await host.nativeApproval.close();
    }
  }
  const result = {
    name, theme, viewport: "375x812", status: failure || errors.length ? "failed" : "passed",
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
  ({ startNativeApprovalHost } = await import(pathToFileURL(nativeModule).href));
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
              for (const event of events) await previewHost.emit(event.type, event.data, { itemId: event.itemId, turnId: event.turnId });
              previewHost.history.splice(0, previewHost.history.length, ...(await previewHost.nativeApproval.history()).items);
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
  if (serve) {
    const stopped = new Promise((finish) => {
      process.once("SIGINT", finish);
      process.once("SIGTERM", finish);
    });
    const host = await createMockHost(!nativePreview && !remotePreview, false, infrastructureErrors, nativePreview, nativePreview);
    previewHost = host;
    if (projectGroupingPreview) Object.assign(host.snapshot, await host.nativeApproval.projectCatalog());
    if (sectionCreatePreview) await syncNativeSections(host);
    if (nativePromptsPreview) await host.syncNativeDialogs(await host.nativeApproval.seedPullRequest());
    if (nativePreview && !projectGroupingPreview && !sectionCreatePreview && !nativePromptsPreview) {
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
    const pairs = ["light", "dark"].flatMap((theme) => scenarios.map((scenario) => [theme, scenario]));
    const concurrency = Math.max(1, Number(process.env.BRIDGE_E2E_CONCURRENCY ?? 4));
    const ordered = new Array(pairs.length);
    let nextPair = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, pairs.length) }, async () => {
      while (nextPair < pairs.length) {
        const index = nextPair++;
        const [theme, scenario] = pairs[index];
        ordered[index] = await runScenario(theme, scenario);
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
    const failed = infrastructureErrors.length > 0 || results.length !== scenarios.length * 2 || results.some((result) => result.status === "failed");
    const report = {
      status: failed ? "failed" : "passed", browser: browser?.version(), node: process.version,
      client: resolve(root, "apps/client"), runDir,
      passed: results.filter((result) => result.status === "passed").length,
      failed: results.filter((result) => result.status === "failed").length,
      infrastructureErrors, results,
    };
    await writeFile(resolve(runDir, "report.json"), JSON.stringify(report, null, 2));
    await writeFile(resolve(artifactRoot, "report.json"), JSON.stringify(report, null, 2));
    console.log(`Browser E2E ${report.status}: ${report.passed}/${scenarios.length * 2} passed. Report: ${resolve(runDir, "report.json")}`);
    if (failed) process.exitCode = 1;
  }
  if (infrastructureErrors.length) {
    console.error(infrastructureErrors.join("\n"));
    process.exitCode = 1;
  }
}
