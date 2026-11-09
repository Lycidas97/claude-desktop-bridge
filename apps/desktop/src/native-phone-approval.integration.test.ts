import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BridgePermissionDecision, BridgeRequest } from "@bridge/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudePermissionHook } from "./claude-permission-hook.js";
import { DesktopController } from "./controller.js";
import { SessionBroker } from "./session-broker.js";
import { SessionEventLog } from "./session-event-log.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

// Synthetic Desktop hook events, using only temporary settings and session files.
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "bridge-native-phone-approval-"));
  const eventLog = new SessionEventLog(join(directory, "events.jsonl"));
  const inboxSend = vi.fn(async () => {});
  const hostFactory = vi.fn(() => { throw new Error("Approval must not start a model host"); });
  const broker = new SessionBroker({
    paths: {
      sessions: join(directory, "sessions"), tasks: join(directory, "tasks"),
      projects: join(directory, "projects"), desktopSessions: [],
    },
    eventLog,
    observer: {
      catalog: {
        projects: [],
        sessions: [{
          sessionId: "logical-session", desktopSessionId: "local_native-session",
          projectId: "project", projectName: "Project", cwd: directory, title: "Native session",
          source: "desktop", transport: "bridge-host", ownership: "DESKTOP_OBSERVED",
          turnState: "running", lastActivityAt: 1, pendingCount: 0, transcriptMtimeMs: 1,
          processAlive: true, desktopProcessAlive: true, bridgeProcessAlive: false,
          processOverlap: false, activeProcesses: [], activeTask: true,
        }],
        observedAt: 1,
      },
      isDesktopBusy: () => true, isMainTurnBusy: () => true,
      runningSubagents: () => undefined, externalWriteVersion: () => 0,
      canStartBridgeHost: async () => false, onCatalog: () => () => {},
    },
    sessionsPath: join(directory, "sessions.json"), queuePath: join(directory, "queue.json"),
    prepareRuntime: async () => ({ executablePath: "/fake/claude", credentialPath: "/fake/credentials", environment: {} }),
    hostFactory,
    desktopInbox: { send: inboxSend, onReceipt: () => () => {}, forget: vi.fn() },
  });
  const settingsPath = join(directory, "settings.json");
  const nativeSessions = new Map([["native-session", "logical-session"]]);
  const hook = new ClaudePermissionHook({
    settingsPath, broker: broker.permissionBroker,
    sessionId: (nativeId) => broker.resolveNativePermissionSessionId(nativeSessions.get(nativeId) ?? nativeId),
  });
  const startTurn = vi.spyOn(broker, "startTurn");
  const steerTurn = vi.spyOn(broker, "steerTurn");
  cleanups.push(async () => {
    await hook.close();
    await broker.close();
    await rm(directory, { recursive: true, force: true });
    expect(startTurn).not.toHaveBeenCalled();
    expect(steerTurn).not.toHaveBeenCalled();
    expect(inboxSend).not.toHaveBeenCalled();
    expect(hostFactory).not.toHaveBeenCalled();
    expect(eventLog.replay(0).filter((event) => event.type === "user.message.accepted" || event.type === "turn.started")).toEqual([]);
  });
  await broker.initialize();
  await hook.start();
  const installed = JSON.parse(await readFile(settingsPath, "utf8")).hooks.PermissionRequest[0].hooks[0];
  const post = (body: Record<string, unknown>, signal?: AbortSignal) => fetch(installed.url, {
    method: "POST", headers: { "Content-Type": "application/json", ...installed.headers },
    body: JSON.stringify({ session_id: "native-session", ...body }),
    ...(signal ? { signal } : {}),
  });
  const controller = Object.assign(Object.create(DesktopController.prototype), {
    broker,
    config: {
      hostDeviceId: "desktop-fixture", desktopName: "Fixture desktop",
      devices: [{ deviceId: "paired-phone", name: "Paired Android", platform: "android", pairedAt: 1 }],
    },
  }) as { handleRequest(request: BridgeRequest, origin: "mobile", sourceDeviceId: string): Promise<unknown> };
  const resolve = (
    requestId: string,
    decision: BridgePermissionDecision,
    updatedInput?: Record<string, unknown>,
    nativeMode?: string,
    extra: Record<string, unknown> = {},
  ) => {
    const rpcId = randomUUID();
    return controller.handleRequest({
      kind: "request", method: "permission.resolve", requestId: rpcId, idempotencyKey: rpcId,
      params: { requestId, decision, ...(updatedInput ? { updatedInput } : {}), ...(nativeMode ? { nativeMode } : {}), ...extra },
    }, "mobile", "paired-phone");
  };
  const resolutions = () => eventLog.replay(0).filter((event) => event.type === "permission.resolved" || event.type === "question.resolved");
  const open = async (toolName = "Bash", input: Record<string, unknown> = { command: "printf synthetic-hook" }) => {
    const settled = vi.fn();
    const response = post({ hook_event_name: "PermissionRequest", tool_name: toolName, tool_input: input, tool_use_id: "native-tool" })
      .then(async (reply) => {
        expect(reply.status).toBe(200);
        const body = await reply.json();
        settled();
        return body;
      });
    await vi.waitFor(() => expect(broker.permissionBroker.list()).toHaveLength(1));
    const request = broker.permissionBroker.list()[0]!;
    await vi.waitFor(() => expect(eventLog.replay(0)).toContainEqual(expect.objectContaining({
      sessionId: "logical-session", itemId: request.requestId,
      type: toolName === "AskUserQuestion" ? "question.requested" : "permission.requested",
      data: expect.objectContaining({ requestId: request.requestId, toolUseId: "native-tool", toolName, input }),
    })));
    expect(broker.session("logical-session")?.turnState).toBe("waiting");
    expect(settled).not.toHaveBeenCalled();
    return { request, response, settled };
  };
  return { broker, post, resolve, resolutions, open };
}

describe("native hook phone approval through the controller", () => {
  it.each(["bypassPermissions", "auto"] as const)("requests native session full access and confirms only the related observed mode (%s)", async mode => {
    const { broker, post, resolve, open } = await fixture();
    const { request, response } = await open();
    await resolve(request.requestId, "allow-once", undefined, "full-access");
    await expect(response).resolves.toMatchObject({
      hookSpecificOutput: { decision: { behavior: "allow", updatedPermissions: [
        { type: "setMode", mode: "bypassPermissions", destination: "session" },
      ] } },
    });
    expect(broker.session("logical-session")?.nativePermissionModeChange).toMatchObject({ requestId: request.requestId, state: "requested" });
    await post({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "different tool" }, tool_use_id: "other-tool", permission_mode: "bypassPermissions" });
    expect(broker.session("logical-session")?.nativePermissionModeChange?.state).toBe("requested");
    await post({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: request.input, tool_use_id: "native-tool", permission_mode: "bypassPermissions", agent_id: "child-agent" });
    expect(broker.session("logical-session")?.nativePermissionModeChange?.state).toBe("requested");
    await post({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: request.input, tool_use_id: "native-tool", permission_mode: mode });
    expect(broker.session("logical-session")?.nativePermissionModeChange).toMatchObject({
      requestId: request.requestId, state: mode === "bypassPermissions" ? "confirmed" : "not-applied", observedMode: mode,
    });
    expect(broker.permissionPolicy("logical-session").hostMode).toBe("standard");
  });

  it("approves ExitPlanMode into a chosen session mode and confirms that mode", async () => {
    const { broker, post, resolve, open } = await fixture();
    const input = { plan: "# 计划\n\n- 第一步" };
    const { request, response, settled } = await open("ExitPlanMode", input);
    await expect(resolve(request.requestId, "allow-once", undefined, undefined, { mode: "plan" })).rejects.toThrow();
    expect(settled).not.toHaveBeenCalled();
    await resolve(request.requestId, "allow-once", undefined, undefined, { mode: "acceptEdits" });
    await expect(response).resolves.toMatchObject({
      hookSpecificOutput: { decision: { behavior: "allow", updatedPermissions: [
        { type: "setMode", mode: "acceptEdits", destination: "session" },
      ] } },
    });
    expect(broker.session("logical-session")?.nativePermissionModeChange).toMatchObject({
      requestId: request.requestId, state: "requested", mode: "acceptEdits",
    });
    await post({ hook_event_name: "PostToolUse", tool_name: "ExitPlanMode", tool_input: input, tool_use_id: "native-tool", permission_mode: "acceptEdits" });
    expect(broker.session("logical-session")?.nativePermissionModeChange?.state).toBe("confirmed");
  });

  it("returns the phone's feedback when ExitPlanMode is rejected to keep planning", async () => {
    const { resolve, open } = await fixture();
    const { request, response } = await open("ExitPlanMode", { plan: "# 计划" });
    await resolve(request.requestId, "deny", undefined, undefined, { message: "先补充回滚方案" });
    await expect(response).resolves.toEqual({
      hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "先补充回滚方案" } },
    });
  });

  it.each([
    ["Bash", "deny", "full-access"],
    ["Bash", "allow-always", "full-access"],
    ["AskUserQuestion", "allow-once", "full-access"],
    ["Bash", "allow-once", "global"],
  ] as const)("rejects an invalid native upgrade without resolving the request (%s/%s/%s)", async (tool, decision, mode) => {
    const { broker, resolve, open } = await fixture();
    const { request, response, settled } = await open(tool);
    await expect(resolve(request.requestId, decision, undefined, mode)).rejects.toThrow();
    expect(broker.permissionBroker.list()).toEqual([request]);
    expect(broker.session("logical-session")?.nativePermissionModeChange).toBeUndefined();
    expect(settled).not.toHaveBeenCalled();
    await resolve(request.requestId, "deny");
    await expect(response).resolves.toMatchObject({ hookSpecificOutput: { decision: { behavior: "deny" } } });
    await expect(resolve(request.requestId, "allow-once", undefined, "full-access")).rejects.toMatchObject({ code: "ALREADY_RESOLVED" });
    expect(broker.session("logical-session")?.nativePermissionModeChange).toBeUndefined();
  });

  it.each(["allow-once", "deny"] as const)("returns %s on the original hook HTTP request with phone attribution", async (decision) => {
    const { broker, resolve, resolutions, open } = await fixture();
    const { request, response, settled } = await open();
    broker.setDefaultPermissionMode("full-access");
    expect(broker.permissionBroker.list()).toEqual([request]);
    expect(settled).not.toHaveBeenCalled();
    expect(resolutions()).toEqual([]);

    await expect(resolve(request.requestId, decision)).resolves.toEqual({ resolved: true });
    await expect(response).resolves.toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: decision === "deny" ? { behavior: "deny", message: "User denied this action." } : { behavior: "allow" },
      },
    });
    await vi.waitFor(() => expect(resolutions()).toEqual([expect.objectContaining({
      sessionId: "logical-session", itemId: request.requestId, type: "permission.resolved",
      data: expect.objectContaining({
        requestId: request.requestId, toolUseId: "native-tool", decision,
        resolvedByDeviceId: "paired-phone", resolvedByName: "Paired Android",
        behavior: decision === "deny" ? "deny" : "allow",
      }),
    })]));
    expect(resolutions()[0]!.data.automatic).toBeUndefined();
    expect(broker.permissionBroker.list()).toEqual([]);
    expect(broker.session("logical-session")?.turnState).toBe("running");
    expect(settled).toHaveBeenCalledOnce();
  });

  it("returns AskUserQuestion answers on the open hook request in full access", async () => {
    const { broker, resolve, resolutions, open } = await fixture();
    broker.setDefaultPermissionMode("full-access");
    const input = { questions: [{ question: "Which scope?", header: "Scope", multiSelect: false, options: [{ label: "Local", description: "Local only" }] }] };
    const { request, response } = await open("AskUserQuestion", input);
    const updatedInput = { ...input, answers: { "Which scope?": "Local" } };
    await expect(resolve(request.requestId, "allow-once", updatedInput)).resolves.toEqual({ resolved: true });
    await expect(response).resolves.toEqual({
      hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow", updatedInput } },
    });
    await vi.waitFor(() => expect(resolutions()).toEqual([expect.objectContaining({
      itemId: request.requestId, type: "question.resolved",
      data: expect.objectContaining({ requestId: request.requestId, decision: "allow-once", resolvedByDeviceId: "paired-phone", resolvedByName: "Paired Android" }),
    })]));
    expect(broker.permissionBroker.list()).toEqual([]);
  });

  it("rejects an unknown ID without answering another open request", async () => {
    const { broker, resolve, resolutions, open } = await fixture();
    const { request, response, settled } = await open();
    await expect(resolve("unknown-request", "allow-once")).rejects.toMatchObject({ code: "ALREADY_RESOLVED" });
    expect(broker.permissionBroker.list()).toEqual([request]);
    expect(resolutions()).toEqual([]);
    expect(settled).not.toHaveBeenCalled();
    await resolve(request.requestId, "deny");
    await expect(response).resolves.toMatchObject({ hookSpecificOutput: { decision: { behavior: "deny" } } });
  });

  it("applies only the first duplicate resolve and rejects the stale ID", async () => {
    const { resolve, resolutions, open } = await fixture();
    const { request, response, settled } = await open();
    const results = await Promise.allSettled([
      resolve(request.requestId, "allow-once"), resolve(request.requestId, "deny"),
    ]);
    expect(results).toEqual([
      { status: "fulfilled", value: { resolved: true } },
      { status: "rejected", reason: expect.objectContaining({ code: "ALREADY_RESOLVED" }) },
    ]);
    await expect(response).resolves.toEqual({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
    await vi.waitFor(() => expect(resolutions()).toHaveLength(1));
    await expect(resolve(request.requestId, "deny")).rejects.toMatchObject({ code: "ALREADY_RESOLVED" });
    expect(resolutions()[0]!.data).toMatchObject({ requestId: request.requestId, decision: "allow-once", resolvedByDeviceId: "paired-phone" });
    expect(resolutions()).toHaveLength(1);
    expect(settled).toHaveBeenCalledOnce();
  });

  it.each(["PostToolUse", "PostToolUseFailure", "Stop", "SessionEnd"])("clears the open request after native %s and rejects a late phone answer", async (event) => {
    const { broker, post, resolve, resolutions, open } = await fixture();
    const toolName = event === "PostToolUse" ? "AskUserQuestion" : "Bash";
    const input = toolName === "AskUserQuestion" ? { questions: [] } : { command: "printf synthetic-hook" };
    const { request, response } = await open(toolName, input);
    const localInput = toolName === "AskUserQuestion" ? { ...input, answers: { Q: "Answered locally" } } : input;
    expect((await post({ hook_event_name: event, tool_name: toolName, tool_input: localInput, tool_use_id: "native-tool" })).status).toBe(200);
    await expect(response).resolves.toEqual({});
    expect(broker.permissionBroker.list()).toEqual([]);
    await vi.waitFor(() => expect(resolutions()).toEqual([expect.objectContaining({
      itemId: request.requestId,
      data: expect.objectContaining({ requestId: request.requestId, automatic: true, resolvedByDeviceId: "system", reason: "session-ended" }),
    })]));
    await expect(resolve(request.requestId, "allow-once")).rejects.toMatchObject({ code: "ALREADY_RESOLVED" });
    expect(resolutions()).toHaveLength(1);
  });

  it("cancels a disconnected native HTTP request before a late phone answer", async () => {
    const { broker, post, resolve, resolutions } = await fixture();
    const abort = new AbortController();
    const response = post({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: {} }, abort.signal);
    const rejected = expect(response).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(broker.permissionBroker.list()).toHaveLength(1));
    const requestId = broker.permissionBroker.list()[0]!.requestId;
    abort.abort();
    await rejected;
    await vi.waitFor(() => expect(broker.permissionBroker.list()).toEqual([]));
    await expect(resolve(requestId, "allow-once")).rejects.toMatchObject({ code: "ALREADY_RESOLVED" });
    await vi.waitFor(() => expect(resolutions()).toHaveLength(1));
    expect(resolutions()[0]!.data).toMatchObject({ requestId, automatic: true, resolvedByDeviceId: "system" });
  });
});
