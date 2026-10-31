import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PermissionBroker } from "./permission-broker.js";
import { ClaudePermissionHook } from "./claude-permission-hook.js";
import { SessionBroker } from "./session-broker.js";
import { SessionEventLog } from "./session-event-log.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

const directories: string[] = [];
const servers: ClaudePermissionHook[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  vi.clearAllMocks();
  if (directories.length) execFileSync(process.platform === "darwin" ? "/usr/bin/trash" : "trash-put", directories.splice(0));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "bridge-permission-hook-"));
  directories.push(directory);
  const settingsPath = join(directory, "settings.json");
  await writeFile(settingsPath, JSON.stringify({
    env: { EXISTING_SETTING: "kept" },
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "existing-hook" }] }] },
  }));
  const broker = new PermissionBroker();
  const server = new ClaudePermissionHook({ settingsPath, broker, sessionId: (id) => id === "native-session" ? "logical-session" : undefined });
  servers.push(server);
  await server.start();
  const settings = JSON.parse(await readFile(settingsPath, "utf8"));
  const hook = settings.hooks.PermissionRequest[0].hooks[0];
  const post = (body: unknown, headers = hook.headers, signal?: AbortSignal) => fetch(hook.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  return { server, broker, settingsPath, settings, hook, post };
}

const input = { session_id: "native-session", hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "printf permission-fixture" } };

describe("native Claude permission hook", () => {
  it.each(["allow-once", "deny"] as const)("forwards a native approval and returns the phone's %s decision", async (decision) => {
    const { broker, post } = await fixture();
    const response = post(input);
    await vi.waitFor(() => expect(broker.list()).toHaveLength(1));
    const request = broker.list()[0]!;
    expect(request).toMatchObject({ sessionId: "logical-session", toolName: "Bash", input: input.tool_input });
    broker.resolveRequest(request.requestId, decision, undefined, undefined, { deviceId: "phone", name: "Test phone" });
    const body = await (await response).json();
    expect(body).toMatchObject({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: decision === "deny" ? "deny" : "allow" } } });
    expect(body.hookSpecificOutput.decision.updatedInput).toBeUndefined();
    expect(broker.list()).toEqual([]);
  });

  it("includes updatedInput when the phone modifies the tool input", async () => {
    const { broker, post } = await fixture();
    const response = post({ ...input, tool_name: "AskUserQuestion", tool_input: { questions: [] } });
    await vi.waitFor(() => expect(broker.list()).toHaveLength(1));
    broker.resolveRequest(broker.list()[0]!.requestId, "allow-once", undefined, { questions: [], answers: { Q: "A" } });
    expect(await (await response).json()).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow", updatedInput: { questions: [], answers: { Q: "A" } } },
      },
    });
  });

  it("preserves existing settings and installs one authenticated loopback hook per lifecycle event", async () => {
    const { settings, hook, settingsPath, server } = await fixture();
    expect(new URL(hook.url).hostname).toBe("127.0.0.1");
    expect(hook.headers.Authorization).toMatch(/^Bearer .{32,}$/u);
    expect(settings.env).toEqual({ EXISTING_SETTING: "kept" });
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe("existing-hook");
    for (const event of ["PermissionRequest", "PostToolUse", "PostToolUseFailure", "Stop", "SessionEnd"]) expect(settings.hooks[event]).toHaveLength(1);
    await server.close();
    const after = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(after).toEqual({ env: { EXISTING_SETTING: "kept" }, hooks: { PreToolUse: settings.hooks.PreToolUse } });
  });

  it("rejects unauthenticated and malformed requests, and skips unobserved or Bridge SDK sessions", async () => {
    const { post, broker, hook } = await fixture();
    expect((await post(input, {})).status).toBe(401);
    expect((await post({ hook_event_name: "PermissionRequest" })).status).toBe(400);
    expect(await (await post({ ...input, session_id: "other-session" })).json()).toEqual({});
    expect(await (await post(input, { ...hook.headers, "X-Bridge-Permission-Host": "sdk" })).json()).toEqual({});
    expect(broker.list()).toEqual([]);
  });

  it.each(["PostToolUse", "PostToolUseFailure"])("removes the card after Desktop answers and %s arrives", async (event) => {
    const { broker, post } = await fixture();
    const response = post(input);
    await vi.waitFor(() => expect(broker.list()).toHaveLength(1));
    await post({ ...input, hook_event_name: event, tool_use_id: "native-tool" });
    expect(await (await response).json()).toEqual({});
    expect(broker.list()).toEqual([]);
  });

  it("removes a pending AskUserQuestion card when Desktop answers and PostToolUse arrives with answers in tool_input", async () => {
    const { broker, post } = await fixture();
    const questions = [{
      question: "需要同时把 B 端的 IPv6 转发和 nftables 转发规则一起开启吗？",
      header: "IPv6 转发",
      multiSelect: false,
      options: [
        { label: "一并开启 IPv6 转发与规则(Recommended)", description: "开启转发" },
        { label: "暂不开启", description: "跳过" },
      ],
    }];
    const response = post({
      session_id: "native-session",
      hook_event_name: "PermissionRequest",
      tool_name: "AskUserQuestion",
      tool_input: { questions },
    });
    await vi.waitFor(() => expect(broker.list()).toHaveLength(1));
    await post({
      session_id: "native-session",
      hook_event_name: "PostToolUse",
      tool_name: "AskUserQuestion",
      tool_use_id: "call_q_1",
      tool_input: {
        questions,
        answers: {
          "需要同时把 B 端的 IPv6 转发和 nftables 转发规则一起开启吗？": "一并开启 IPv6 转发与规则(Recommended)",
        },
      },
    });
    expect(await (await response).json()).toEqual({});
    expect(broker.list()).toEqual([]);
  });

  it("removes a pending card when Desktop denies or cancels a tool and writes tool_result to transcript_path without PostToolUse", async () => {
    const { broker, post, settingsPath } = await fixture();
    const transcriptPath = join(settingsPath, "..", "native-session.jsonl");
    await writeFile(transcriptPath, `${JSON.stringify({
      type: "assistant",
      uuid: "a-tool-1",
      message: {
        role: "assistant",
        content: [{
          type: "tool_use",
          id: "call_denied_1",
          name: "Bash",
          input: input.tool_input,
        }],
      },
    })}\n`, "utf8");
    const response = post({
      ...input,
      transcript_path: transcriptPath,
    });
    await vi.waitFor(() => expect(broker.list()).toHaveLength(1));
    await writeFile(transcriptPath, `${await readFile(transcriptPath, "utf8")}${JSON.stringify({
      type: "user",
      uuid: "u-denied-1",
      parentUuid: "a-tool-1",
      toolUseResult: "User rejected tool use",
      message: {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "call_denied_1",
          is_error: true,
          content: "The user doesn't want to proceed with this tool use.",
        }],
      },
    })}\n`, "utf8");
    await vi.waitFor(() => expect(broker.list()).toEqual([]));
    expect(await (await response).json()).toEqual({});
  });

  it.each(["initial", "delta"])("keeps a half-written JSON record at %s EOF until its append completes", async (phase) => {
    const { broker, post, settingsPath } = await fixture();
    const transcriptPath = join(settingsPath, "..", "native-session.jsonl");
    const tool = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "partial-tool", name: "Bash", input: input.tool_input }] },
    });
    const result = JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "partial-tool", content: "Denied" }] },
    });
    const split = Math.floor((phase === "initial" ? tool : result).length / 2);
    await writeFile(transcriptPath, phase === "initial" ? tool.slice(0, split) : `${tool}\n`);
    const response = post({ ...input, transcript_path: transcriptPath });
    await vi.waitFor(() => expect(broker.list()).toHaveLength(1));
    await vi.waitFor(async () => {
      expect(vi.mocked(fs.open).mock.results.length).toBeGreaterThan(0);
      expect((await vi.mocked(fs.open).mock.results.at(-1)!.value).fd).toBe(-1);
    });
    if (phase === "delta") {
      const scans = vi.mocked(fs.open).mock.calls.length;
      await appendFile(transcriptPath, result.slice(0, split));
      await vi.waitFor(async () => {
        expect(vi.mocked(fs.open).mock.calls.length).toBeGreaterThan(scans);
        expect((await vi.mocked(fs.open).mock.results.at(-1)!.value).fd).toBe(-1);
      });
    }
    expect(broker.list()).toHaveLength(1);
    await appendFile(transcriptPath, phase === "initial" ? `${tool.slice(split)}\n${result}\n` : `${result.slice(split)}\n`);
    await vi.waitFor(() => expect(broker.list()).toEqual([]));
    expect(await (await response).json()).toEqual({});
  });

  it.each(["\n", ""])("resolves a tool result larger than the delta window with trailing %j", async (ending) => {
    const { broker, post, settingsPath } = await fixture();
    const transcriptPath = join(settingsPath, "..", "native-session.jsonl");
    await writeFile(transcriptPath, `${JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "large-tool", name: "Bash", input: input.tool_input }] },
    })}\n`);
    const response = post({ ...input, transcript_path: transcriptPath });
    await vi.waitFor(() => expect(broker.list()).toHaveLength(1));
    await vi.waitFor(async () => {
      expect(vi.mocked(fs.open).mock.results.length).toBeGreaterThan(0);
      expect((await vi.mocked(fs.open).mock.results.at(-1)!.value).fd).toBe(-1);
    });
    await appendFile(transcriptPath, `${JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "large-tool", content: "x".repeat(2 * 1024 * 1024 + 128) }] },
    })}${ending}`);
    await vi.waitFor(() => expect(broker.list()).toEqual([]));
    expect(await (await response).json()).toEqual({});
  });

  it("accepts a complete initial tool result without a final newline", async () => {
    const { broker, post, settingsPath } = await fixture();
    const transcriptPath = join(settingsPath, "..", "native-session.jsonl");
    await writeFile(transcriptPath, [
      { type: "assistant", message: { content: [{ type: "tool_use", id: "final-tool", name: "Bash", input: input.tool_input }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "final-tool", content: "Denied" }] } },
    ].map((record) => JSON.stringify(record)).join("\n"));
    expect(await (await post({ ...input, transcript_path: transcriptPath })).json()).toEqual({});
    expect(broker.list()).toEqual([]);
  });

  it("does not cancel a different tool request or another session", async () => {
    const { broker, post } = await fixture();
    const response = post(input);
    await vi.waitFor(() => expect(broker.list()).toHaveLength(1));
    await post({ ...input, hook_event_name: "PostToolUse", tool_input: { command: "different" } });
    await post({ session_id: "other-session", hook_event_name: "Stop" });
    expect(broker.list()).toHaveLength(1);
    await post({ session_id: "native-session", hook_event_name: "Stop" });
    expect(await (await response).json()).toEqual({});
    expect(broker.list()).toEqual([]);
  });

  it("cleans pending cards when the native hook is cancelled or Bridge shuts down", async () => {
    const { broker, post, server } = await fixture();
    const controller = new AbortController();
    const response = post(input, undefined, controller.signal).catch(() => undefined);
    await vi.waitFor(() => expect(broker.list()).toHaveLength(1));
    controller.abort();
    await response;
    await vi.waitFor(() => expect(broker.list()).toEqual([]));
    const next = post(input);
    await vi.waitFor(() => expect(broker.list()).toHaveLength(1));
    await server.close();
    expect(await (await next).json()).toEqual({});
    expect(broker.list()).toEqual([]);
  });

  it("publishes permission.requested and waiting turnState for an observed Desktop session in SessionBroker", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-permission-broker-"));
    directories.push(directory);
    const settingsPath = join(directory, "settings.json");
    const eventLog = new SessionEventLog(join(directory, "events.jsonl"));
    const sessionBroker = new SessionBroker({
      paths: {
        sessions: join(directory, "sessions"),
        tasks: join(directory, "tasks"),
        projects: join(directory, "projects"),
        desktopSessions: [],
      },
      eventLog,
      observer: {
        catalog: {
          projects: [],
          sessions: [{
            sessionId: "native-session",
            desktopSessionId: "local_native-session",
            projectId: "proj-1",
            projectName: "杂活",
            cwd: directory,
            title: "244配置",
            source: "desktop",
            transport: "bridge-host",
            ownership: "DESKTOP_OBSERVED",
            turnState: "running",
            lastActivityAt: Date.now(),
            pendingCount: 0,
            transcriptMtimeMs: Date.now(),
            processAlive: true,
            desktopProcessAlive: true,
            bridgeProcessAlive: false,
            processOverlap: false,
            activeProcesses: [],
            activeTask: true,
          }],
          observedAt: Date.now(),
        },
        isDesktopBusy: () => true,
        externalWriteVersion: () => 0,
        canStartBridgeHost: async () => false,
        onCatalog: () => () => undefined,
      },
      sessionsPath: join(directory, "sessions.json"),
      queuePath: join(directory, "queue.json"),
      prepareRuntime: async () => ({
        executablePath: "/fake/claude",
        credentialPath: "/fake/creds.json",
        environment: {},
      }),
    });
    await sessionBroker.initialize();
    sessionBroker.setDefaultPermissionMode("full-access");
    const server = new ClaudePermissionHook({
      settingsPath,
      broker: sessionBroker.permissionBroker,
      sessionId: (id) => sessionBroker.resolveNativePermissionSessionId(id),
    });
    servers.push(server);
    await server.start();
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    const hook = settings.hooks.PermissionRequest[0].hooks[0];

    const pendingResponse = fetch(hook.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...hook.headers },
      body: JSON.stringify(input),
    });
    await vi.waitFor(() => expect(sessionBroker.permissionBroker.list("native-session")).toHaveLength(1));
    expect(sessionBroker.session("native-session")?.turnState).toBe("waiting");
    await vi.waitFor(() => expect(
      eventLog.replay(0).some((event) => event.sessionId === "native-session" && event.type === "permission.requested"),
    ).toBe(true));

    const requestId = sessionBroker.permissionBroker.list("native-session")[0]!.requestId;
    expect(sessionBroker.resolvePermission(requestId, "allow-once", undefined, undefined, {
      deviceId: "phone-1",
      name: "Android Bridge",
    })).toBe(true);
    expect(await (await pendingResponse).json()).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow" },
      },
    });
    expect(sessionBroker.session("native-session")?.turnState).toBe("running");
    await sessionBroker.close();
  });
});
