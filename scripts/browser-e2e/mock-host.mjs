import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { BridgeCrypto, BridgeSocket } from "../../packages/protocol/dist/index.js";
import { remotePreview, sectionCreatePreview, assistantMailPreview, nativePreview, sessionId, originalTitle, userText, replyText } from "./config.mjs";
import { syncNativeSections } from "./helpers.mjs";

let nativeFixtureSequence = 0;

export async function createMockHost({ baseUrl, runDir, startNativeApprovalHost, hosts, nativeHosts }, queued, failFirstRename, errors, native = false, nativeQueue = false, sections = sectionCreatePreview, assistantMail = assistantMailPreview, options = {}) {
  const now = Date.now();
  const clientRelayUrl = `${baseUrl.replace("http:", "ws:")}/ws`;
  const { crypto, pairing } = await BridgeCrypto.createDesktop(clientRelayUrl, options.desktopName ?? "Browser E2E 隔离电脑");
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
    runtime: { state: "ready", detail: "固定响应宿主", activeTurns: remotePreview ? 1 : 0, maxParallelTurns: 1,
      desktopIntegration: { state: "ready", detail: "隔离 Native 宿主", enabled: true, canRestart: false } },
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
    nativeImages: new Map(), imageTransfers: new Map(), systemUpdateError: "",
    send: async (payload) => {
      const sent = await socket.send(payload, "mobile", { crypto, toDeviceId: pairing.deviceId });
      await host.onDesktopPayload?.(payload);
      return sent;
    },
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
      for (const key of ["turnState", "ownership", "pendingCount", "pendingCommandIds", "allowedActions", "isCompacting", "lastCompletedTurnAt"]) session[key] = update.session[key];
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
      const target = snapshot.sessions.find(candidate => candidate.sessionId === sessionId);
      for (const key of ["turnState", "ownership", "prs", "prAutoFix", "autoArchiveOnPrClose", "allowedActions"]) {
        session[key] = update.session[key];
        target[key] = update.session[key];
      }
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
      directory, sessionId, title: originalTitle, deviceId: pairing.deviceId, sections, assistantMail,
      onMailChanged(assistantMail) {
        snapshot.assistantMail = assistantMail;
        const event = { eventId: randomUUID(), seq: ++snapshot.latestSeq, timestamp: Date.now(), origin: "system",
          type: "plugin.assistant-mail.changed", data: { assistantMail } };
        events.push(event);
        if (host.mailOffline || !host.nativeApproval) return;
        void host.send({ kind: "event", event }).catch(error => errors.push(`mail event: ${error.stack}`));
      },
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
    if (assistantMail) {
      snapshot.host.capabilities.push("plugin.assistant-mail.v1", "plugin.assistant-mail.manual-reference.v1");
      snapshot.assistantMail = host.nativeApproval.mailSnapshot();
      const initialMailCount = options.initialMailCount ?? 60;
      if (initialMailCount > 0) {
        host.mailOffline = true;
        await host.nativeApproval.assistantMail.deliver(initialMailCount);
        host.mailOffline = false;
      }
    }
  }
  hosts.add(host);
  socket.onFrame((frame) => {
    if (frame.type === "presence" && frame.role === "mobile" && frame.online) {
      void host.send({ kind: "snapshot", snapshot }).catch((error) => errors.push(`mock host: ${error.stack}`));
    }
    if (frame.type === "error") errors.push(`mock relay: ${frame.code}: ${frame.message}`);
  });
  host.handleRequest = async (rawRequest) => {
    const request = { kind: "request", requestId: rawRequest.requestId ?? randomUUID(), ...rawRequest };
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
            if (request.method === "pr.autoFix.set" && host.prWriteGate) await host.prWriteGate;
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
        case "plugin.assistant-mail.list":
        case "plugin.assistant-mail.read":
        case "plugin.assistant-mail.bind":
          try {
            if (request.method === "plugin.assistant-mail.list" && host.mailPageFailure) throw new Error("隔离邮件列表读取失败");
            result = await host.nativeApproval.controllerRequest(request);
          } catch (failure) { error = { code: failure.code ?? "MAIL_REJECTED", message: failure.message }; }
          break;
        case "plugin.magpie-quota.list":
          result = { status: "available", fetchedAt: Date.now(), accounts: [{ provider: "claude", name: "隔离 Magpie 账号", windows: [{ name: "5 hours", remaining: 73 }, { name: "7 days", remaining: 81 }] }] };
          break;
        case "system.update": {
          if (host.systemUpdateError) {
            error = { code: "UPDATE_REJECTED", message: host.systemUpdateError };
            break;
          }
          const action = request.params?.action ?? "status";
          if (request.params?.channel === "stable" || request.params?.channel === "prerelease") {
            snapshot.updater = { ...snapshot.updater, channel: request.params.channel };
          }
          if (typeof request.params?.autoCheck === "boolean") {
            snapshot.updater = { ...snapshot.updater, autoCheck: request.params.autoCheck };
          }
          if (action === "check") {
            const latestVersion = snapshot.updater?.channel === "prerelease"
              ? (host.prereleaseLatestVersion ?? "1.3.5-dev.27")
              : "1.3.5";
            snapshot.updater = {
              ...snapshot.updater,
              phase: "available",
              latestVersion,
              releaseUrl: `https://github.com/Lycidas97/claude-desktop-bridge/releases/tag/v${latestVersion}`,
              statusDetail: `发现新版本 v${latestVersion}`,
            };
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
        case "session.command":
          try {
            result = await host.nativeApproval.controllerRequest(request);
            if (host.sectionsEnabled) await syncNativeSections(host);
            await host.send({ kind: "snapshot", snapshot });
          } catch (failure) { error = { code: failure.code ?? "COMMAND_REJECTED", message: failure.message }; }
          break;
        case "desktop.app.launch":
        case "claude.desktop.launch":
          if (request.method === "desktop.app.launch" && host.claudeActivationResult) {
            result = { desktopApps: snapshot.desktopApps, claudeActivation: host.claudeActivationResult };
            break;
          }
          snapshot.claudeDesktop = { state: "running", detail: "Claude Desktop 正在运行。", canLaunch: false, canQuit: true };
          snapshot.desktopApps = [{ id: "claude-desktop", name: "Claude Desktop", state: "running", detail: "Claude Desktop 正在运行。", canLaunch: false, canQuit: true }];
          snapshot.claudeInspector = {
            ...(snapshot.claudeInspector ?? { platform: "darwin", port: 9229, pollIntervalMs: 3_000, clients: [], alerts: [] }),
            state: "listening",
            startup: { state: "attempted", recordedAt: Date.now(), detail: "已通过原生菜单请求开启主进程调试。" },
          };
          snapshot.runtime = {
            ...snapshot.runtime,
            state: "ready",
            detail: "隔离 Native 宿主",
            desktopIntegration: { state: "ready", detail: "隔离 Native 宿主", enabled: true, canRestart: false },
          };
          result = request.method === "desktop.app.launch"
            ? { desktopApps: snapshot.desktopApps, claudeActivation: { inspectorState: "listening", nativeReady: true } }
            : { claudeDesktop: snapshot.claudeDesktop };
          await host.send({ kind: "snapshot", snapshot });
          break;
        case "session.configuration": {
          if (host.taskDetailsError && request.params.includeBackgroundTasks === true) {
            error = { code: "TASK_DETAILS_UNAVAILABLE", message: host.taskDetailsError };
            break;
          }
          if ((!host.nativeApproval || request.params.sessionId !== sessionId) && request.params.includeBackgroundTasks === true) {
            result = { session: snapshot.sessions.find(candidate => candidate.sessionId === request.params.sessionId) };
            break;
          }
          if (!host.nativeApproval) {
            error = { code: "UNSUPPORTED", message: "Configuration unavailable on non-native fixture" };
            break;
          }
          let readResult;
          try {
            readResult = await host.nativeApproval.configuration(request);
          } catch (failure) {
            error = { code: "NOT_FOUND", message: failure.message };
            break;
          }
          result = readResult?.session && request.params.sessionId === sessionId
            ? {
                ...readResult,
                session: {
                  ...readResult.session,
                  allowedActions: session.allowedActions,
                  ...host.nativeApproval.profile(),
                  ...(readResult.session.backgroundTasks ? { backgroundTasks: readResult.session.backgroundTasks } : {}),
                },
              }
            : readResult;
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
          if (host.sectionsEnabled && host.nativeApproval) {
            try {
              result = await host.nativeApproval.controllerRequest(request);
              await syncNativeSections(host);
              await host.send({ kind: "snapshot", snapshot });
            } catch (failure) { error = { code: failure.code ?? "E2E_RENAME_FAILED", message: failure.message }; }
            break;
          }
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
          if (host.nativeQueue || assistantMail) {
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
    const response = {
      kind: "response", requestId: request.requestId, ok: !error,
      ...(error ? { error } : { result }),
    };
    const afterAck = async () => {
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
      } else if (request.method === "turn.start" && !remotePreview && !host.nativeQueue && !assistantMail) {
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
    };
    return { response, afterAck };
  };
  host.desktopRequest = async (input) => {
    const { response, afterAck } = await host.handleRequest(input);
    await afterAck();
    return response;
  };
  socket.onMessage((message, encrypted) => {
    void (async () => {
      if (message.payload.kind !== "request") {
        socket.ack([encrypted.id]);
        return;
      }
      const { response, afterAck } = await host.handleRequest(message.payload);
      await host.send(response);
      socket.ack([encrypted.id]);
      await afterAck();
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
