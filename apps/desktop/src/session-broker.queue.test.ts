import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { AsyncInputQueue } from "./async-input-queue.js";
import { ClaudeSessionHost, type ClaudeSessionHostOptions, type SessionHostEvent } from "./claude-session-host.js";
import { SessionBroker, type SessionHostRuntime } from "./session-broker.js";
import { SessionEventLog } from "./session-event-log.js";
import { TranscriptObserver } from "./transcript-observer.js";

const directories: string[] = [];
afterEach(() => {
  const fixtures = directories.splice(0);
  if (fixtures.length === 0) return;
  const recycle = process.platform === "darwin" ? "/usr/bin/trash" : process.platform === "linux" ? "trash-put" : undefined;
  if (!recycle) {
    console.warn("No recycle command configured; keeping test fixtures:", fixtures);
    return;
  }
  try {
    execFileSync(recycle, fixtures);
  } catch (error) {
    console.warn("Could not recycle test fixtures; keeping remaining files:", fixtures, error);
  }
});

it.each([false, true].flatMap((force) => ["prompt", "tool-call", "tool-result"].map((tail) => ({ force, tail }))))(
  "dispatches an immediate resend after manual stop (force=$force, transcript=$tail)",
  async ({ force, tail }) => {
  const root = await mkdtemp(join(tmpdir(), "bridge-queue-stop-resend-"));
  directories.push(root);
  const sessionId = randomUUID();
  const paths = { sessions: join(root, "sessions"), tasks: join(root, "tasks"), projects: join(root, "projects"), desktopSessions: [] };
  await Promise.all([mkdir(paths.sessions), mkdir(paths.projects)]);
  await writeFile(join(paths.sessions, `${process.pid}.json`), JSON.stringify({
    pid: process.pid, sessionId, cwd: root, startedAt: Date.now(), entrypoint: "claude-desktop-3p",
  }));
  const transcript = join(paths.projects, `${sessionId}.jsonl`);
  await writeFile(transcript, [
    JSON.stringify({ type: "user", uuid: "previous-user", parentUuid: null, message: { role: "user", content: "Previous" } }),
    JSON.stringify({ type: "assistant", uuid: "previous-answer", parentUuid: "previous-user", message: { role: "assistant", content: "Done", stop_reason: "end_turn" } }),
    "",
  ].join("\n"));
  const queries: Array<{ output: AsyncInputQueue<SDKMessage>; prompt: AsyncIterator<SDKUserMessage>; closed: boolean }> = [];
  const eventLog = new SessionEventLog(join(root, "events.jsonl"), 1);
  const observer = new TranscriptObserver({ paths, eventLog, platform: "linux", pollIntervalMs: 60_000, catalogIntervalMs: 60_000 });
  const broker = new SessionBroker({
    paths, observer, eventLog, sessionsPath: join(root, "bridge-sessions.json"), queuePath: join(root, "queue.json"),
    scanSessionProcesses: async () => [], discoverGatewayModels: async () => [],
    prepareRuntime: async () => ({ executablePath: "/fake/claude", credentialPath: "/fake/host-creds.json", environment: {} }),
    hostFactory: (options) => new ClaudeSessionHost({
      ...options,
      queryFactory: ((params) => {
        const query = { output: new AsyncInputQueue<SDKMessage>(), prompt: (params.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator](), closed: false };
        queries.push(query);
        return {
          [Symbol.asyncIterator]: () => query.output[Symbol.asyncIterator](),
          async interrupt() { return { still_queued: [] }; },
          close() { query.closed = true; query.output.close(); },
        } as unknown as Query;
      }) as typeof import("@anthropic-ai/claude-agent-sdk").query,
    }),
  });
  try {
    await observer.start();
    await broker.initialize();
    const first = await broker.startTurn({ sessionId, requestId: "first", idempotencyKey: "first", text: "First", origin: "mobile" });
    await vi.waitFor(() => expect(queries).toHaveLength(1));
    const accepted = await queries[0]!.prompt.next();
    expect(accepted.done).toBe(false);
    const messageId = accepted.value!.uuid!;
    await vi.waitFor(() => expect(eventLog.hasItem(sessionId, "user.message.accepted", messageId)).toBe(true));
    await appendFile(transcript, [
      JSON.stringify({ type: "user", uuid: messageId, parentUuid: "previous-answer", message: { role: "user", content: "First" } }),
      ...(tail !== "prompt" ? [JSON.stringify({ type: "assistant", uuid: "tool-call", parentUuid: messageId, message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id: "read-1", name: "Read", input: {} }] } })] : []),
      ...(tail === "tool-result" ? [JSON.stringify({ type: "user", uuid: "tool-result", parentUuid: "tool-call", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "read-1", content: "data" }] } })] : []),
      "",
    ].join("\n"));
    await expect(observer.canStartBridgeHost(sessionId, true)).resolves.toBe(false);
    await expect(broker.interruptTurn(sessionId, first.commandId, force)).resolves.toBe(true);
    const retry = await broker.startTurn({ sessionId, requestId: "retry", idempotencyKey: "retry", text: "Retry", origin: "mobile" });
    await vi.waitFor(() => expect(eventLog.replay(0, 100, sessionId).some((event) => event.type === "turn.started" && event.data.commandId === retry.commandId)).toBe(true));
    expect(broker.session(sessionId)?.pendingCount).toBe(0);
    expect(broker.runtimeStatus().activeTurns).toBe(1);
    expect(queries[0]!.closed).toBe(force);
    if (!force) {
      queries[0]!.output.push({
        type: "result", subtype: "error_during_execution", is_error: true, errors: ["Interrupted"],
        uuid: randomUUID(), session_id: sessionId, stop_reason: null,
      } as SDKMessage);
    }
    const retryQuery = queries.at(-1)!;
    const retryMessage = await retryQuery.prompt.next();
    expect(retryMessage.done).toBe(false);
    expect(retryMessage.value!.message.content).toEqual([{ type: "text", text: "Retry" }]);
    retryQuery.output.push({
      type: "result", subtype: "success", is_error: false, result: "Retried", stop_reason: "end_turn",
      uuid: randomUUID(), session_id: sessionId,
    } as SDKMessage);
    await vi.waitFor(() => expect(broker.runtimeStatus().activeTurns).toBe(0));
    expect(eventLog.replay(0, 100, sessionId).filter((event) => event.type === "turn.completed").map((event) => event.data.commandId)).toEqual([retry.commandId]);
  } finally {
    await broker.close();
    await observer.close();
    await eventLog.close();
  }
});

it("dispatches queued turns after an empty result and after the settled host has been released", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-queue-empty-result-"));
  directories.push(root);
  const sessionId = randomUUID();
  const paths = { sessions: join(root, "sessions"), tasks: join(root, "tasks"), projects: join(root, "projects"), desktopSessions: [] };
  await Promise.all([mkdir(paths.sessions), mkdir(paths.projects)]);
  await writeFile(join(paths.sessions, `${process.pid}.json`), JSON.stringify({
    pid: process.pid, sessionId, cwd: root, startedAt: Date.now(), entrypoint: "claude-desktop-3p",
  }));
  const transcript = join(paths.projects, `${sessionId}.jsonl`);
  await writeFile(transcript, [
    JSON.stringify({ type: "user", uuid: "previous-user", parentUuid: null, message: { role: "user", content: "Previous" } }),
    JSON.stringify({ type: "assistant", uuid: "previous-answer", parentUuid: "previous-user", message: { role: "assistant", content: "Done", stop_reason: "end_turn" } }),
    "",
  ].join("\n"));
  const eventLog = new SessionEventLog(join(root, "events.jsonl"), 1);
  const observer = new TranscriptObserver({ paths, eventLog, platform: "linux", pollIntervalMs: 60_000, catalogIntervalMs: 60_000 });
  const hosts: Array<{
    events: EventEmitter;
    sends: number;
    closed: boolean;
    current?: { turnId: string; messageId: string; text: string };
  }> = [];
  const broker = new SessionBroker({
    paths, observer, eventLog,
    sessionsPath: join(root, "bridge-sessions.json"), queuePath: join(root, "queue.json"),
    scanSessionProcesses: async () => [],
    discoverGatewayModels: async () => [],
    prepareRuntime: async () => ({ executablePath: "/fake/claude", credentialPath: "/fake/host-creds.json", environment: {} }),
    hostFactory: (_options: ClaudeSessionHostOptions) => {
      const host: typeof hosts[number] = { events: new EventEmitter(), sends: 0, closed: false };
      hosts.push(host);
      return {
        start() {},
        async setModel() {},
        async setEffort() {},
        async setAutoCompactWindow() {},
        async supportedModels() { return []; },
        async contextUsage() { throw new Error("Context lookup not expected"); },
        send(input, origin) {
          const text = typeof input === "string" ? input : input.text;
          host.sends += 1;
          host.current = { turnId: randomUUID(), messageId: randomUUID(), text };
          host.events.emit("event", { type: "turn.started", sessionId, turnId: host.current.turnId, at: Date.now() } satisfies SessionHostEvent);
          host.events.emit("event", { type: "user.accepted", sessionId, ...host.current, origin, attachments: [], at: Date.now() } satisfies SessionHostEvent);
          return host.current;
        },
        async interrupt() {},
        async close() { host.closed = true; },
        onEvent(listener) { host.events.on("event", listener); return () => host.events.off("event", listener); },
      } satisfies SessionHostRuntime;
    },
  });
  try {
    await observer.start();
    await broker.initialize();
    await broker.startTurn({ sessionId, requestId: "first", idempotencyKey: "first", text: "First", origin: "mobile" });
    await vi.waitFor(() => expect(hosts[0]?.sends).toBe(1));
    const first = hosts[0]!.current!;
    await appendFile(transcript, `${JSON.stringify({ type: "user", uuid: first.messageId, parentUuid: "previous-answer", message: { role: "user", content: first.text } })}\n`);
    await broker.startTurn({ sessionId, requestId: "second", idempotencyKey: "second", text: "Second", origin: "mobile" });
    expect(broker.session(sessionId)?.pendingCount).toBe(1);
    hosts[0]!.events.emit("event", { type: "turn.completed", sessionId, turnId: first.turnId, result: "", at: Date.now() } satisfies SessionHostEvent);
    await vi.waitFor(() => expect(hosts[0]?.sends).toBe(2));
    expect(broker.runtimeStatus().activeTurns).toBe(1);

    const second = hosts[0]!.current!;
    await appendFile(transcript, `${JSON.stringify({ type: "user", uuid: second.messageId, parentUuid: first.messageId, message: { role: "user", content: second.text } })}\n`);
    hosts[0]!.events.emit("event", { type: "turn.completed", sessionId, turnId: second.turnId, result: "", at: Date.now() } satisfies SessionHostEvent);
    await vi.waitFor(() => expect(broker.runtimeStatus().activeTurns).toBe(0));
    await vi.waitFor(() => expect(broker.session(sessionId)?.turnState).toBe("idle"));
    // Exercise the existing release path immediately instead of waiting 15 seconds.
    await (broker as unknown as { releaseSession(id: string): Promise<void> }).releaseSession(sessionId);
    expect(hosts[0]!.closed).toBe(true);
    await broker.startTurn({ sessionId, requestId: "third", idempotencyKey: "third", text: "Third", origin: "mobile" });
    await vi.waitFor(() => expect(hosts[1]?.sends).toBe(1));
    expect(broker.session(sessionId)?.pendingCount).toBe(0);
    expect(broker.runtimeStatus().activeTurns).toBe(1);
  } finally {
    await broker.close();
    await observer.close();
    await eventLog.close();
  }
});

it("settles an already-delivered Bridge turn instead of re-queueing it on ownership conflict", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-queue-conflict-delivered-"));
  directories.push(root);
  const sessionId = randomUUID();
  const paths = { sessions: join(root, "sessions"), tasks: join(root, "tasks"), projects: join(root, "projects"), desktopSessions: [] };
  await Promise.all([mkdir(paths.sessions), mkdir(paths.projects)]);
  await writeFile(join(paths.sessions, `${process.pid}.json`), JSON.stringify({
    pid: process.pid, sessionId, cwd: root, startedAt: Date.now(), entrypoint: "claude-desktop-3p",
  }));
  const transcript = join(paths.projects, `${sessionId}.jsonl`);
  await writeFile(transcript, [
    JSON.stringify({ type: "user", uuid: "previous-user", parentUuid: null, message: { role: "user", content: "Previous" } }),
    JSON.stringify({ type: "assistant", uuid: "previous-answer", parentUuid: "previous-user", message: { role: "assistant", content: "Done", stop_reason: "end_turn" } }),
    "",
  ].join("\n"));
  const eventLog = new SessionEventLog(join(root, "events.jsonl"), 1);
  const observer = new TranscriptObserver({ paths, eventLog, platform: "linux", pollIntervalMs: 60_000, catalogIntervalMs: 60_000 });
  const hosts: Array<{
    events: EventEmitter;
    sends: number;
    closed: boolean;
    current?: { turnId: string; messageId: string; text: string };
  }> = [];
  const broker = new SessionBroker({
    paths, observer, eventLog,
    sessionsPath: join(root, "bridge-sessions.json"), queuePath: join(root, "queue.json"),
    scanSessionProcesses: async () => [],
    discoverGatewayModels: async () => [],
    prepareRuntime: async () => ({ executablePath: "/fake/claude", credentialPath: "/fake/host-creds.json", environment: {} }),
    hostFactory: (_options: ClaudeSessionHostOptions) => {
      const host: typeof hosts[number] = { events: new EventEmitter(), sends: 0, closed: false };
      hosts.push(host);
      return {
        start() {},
        async setModel() {},
        async setEffort() {},
        async setAutoCompactWindow() {},
        async supportedModels() { return []; },
        async contextUsage() { throw new Error("Context lookup not expected"); },
        send(input, origin) {
          const text = typeof input === "string" ? input : input.text;
          host.sends += 1;
          host.current = { turnId: randomUUID(), messageId: randomUUID(), text };
          host.events.emit("event", { type: "turn.started", sessionId, turnId: host.current.turnId, at: Date.now() } satisfies SessionHostEvent);
          host.events.emit("event", { type: "user.accepted", sessionId, ...host.current, origin, attachments: [], at: Date.now() } satisfies SessionHostEvent);
          return host.current;
        },
        async interrupt() {},
        async close() { host.closed = true; },
        onEvent(listener) { host.events.on("event", listener); return () => host.events.off("event", listener); },
      } satisfies SessionHostRuntime;
    },
  });
  try {
    await observer.start();
    await broker.initialize();
    const first = await broker.startTurn({
      sessionId,
      requestId: "delivered-conflict-req",
      idempotencyKey: "delivered-conflict-key",
      text: "授权三个目录",
      origin: "mobile",
    });
    await vi.waitFor(() => expect(hosts[0]?.sends).toBe(1));
    const current = hosts[0]!.current!;
    await vi.waitFor(() => expect(eventLog.hasItem(sessionId, "user.message.accepted", current.messageId)).toBe(true));

    await appendFile(transcript, [
      JSON.stringify({ type: "user", uuid: current.messageId, parentUuid: "previous-answer", message: { role: "user", content: current.text } }),
      JSON.stringify({ type: "user", uuid: "desktop-competing-user", parentUuid: current.messageId, message: { role: "user", content: "继续" } }),
      JSON.stringify({ type: "assistant", uuid: "desktop-competing-answer", parentUuid: "desktop-competing-user", message: { role: "assistant", content: "已确认三个目录", stop_reason: "end_turn" } }),
      "",
    ].join("\n"));
    await (observer as unknown as { poll(): Promise<void> }).poll();

    await vi.waitFor(() => expect(hosts[0]?.closed).toBe(true));
    expect(broker.session(sessionId)?.pendingCount).toBe(0);
    expect(eventLog.replay(0, 100, sessionId).some((event) => (
      event.type === "turn.queued" && event.data.commandId === first.commandId && event.data.reason === "ownership-conflict"
    ))).toBe(false);
    expect(eventLog.replay(0, 100, sessionId).some((event) => (
      event.type === "turn.completed" && event.data.commandId === first.commandId
    ))).toBe(true);

    const duplicate = await broker.startTurn({
      sessionId,
      requestId: "delivered-conflict-req-dup",
      idempotencyKey: "delivered-conflict-key",
      text: "授权三个目录",
      origin: "mobile",
    });
    expect(duplicate.state).toBe("completed");
    expect(hosts).toHaveLength(1);
  } finally {
    await broker.close();
    await observer.close();
    await eventLog.close();
  }
});

it("does not replay an already-accepted Bridge turn after restart recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-queue-restart-accepted-"));
  directories.push(root);
  const sessionId = randomUUID();
  const paths = { sessions: join(root, "sessions"), tasks: join(root, "tasks"), projects: join(root, "projects"), desktopSessions: [] };
  await Promise.all([mkdir(paths.sessions), mkdir(paths.projects)]);
  await writeFile(join(paths.sessions, `${process.pid}.json`), JSON.stringify({
    pid: process.pid, sessionId, cwd: root, startedAt: Date.now(), entrypoint: "claude-desktop-3p",
  }));
  const transcript = join(paths.projects, `${sessionId}.jsonl`);
  await writeFile(transcript, [
    JSON.stringify({ type: "user", uuid: "previous-user", parentUuid: null, message: { role: "user", content: "Previous" } }),
    JSON.stringify({ type: "assistant", uuid: "previous-answer", parentUuid: "previous-user", message: { role: "assistant", content: "Done", stop_reason: "end_turn" } }),
    "",
  ].join("\n"));
  const queuePath = join(root, "queue.json");
  const sessionsPath = join(root, "bridge-sessions.json");
  const eventLogPath = join(root, "events.jsonl");

  const firstEventLog = new SessionEventLog(eventLogPath, 1);
  const firstObserver = new TranscriptObserver({ paths, eventLog: firstEventLog, platform: "linux", pollIntervalMs: 60_000, catalogIntervalMs: 60_000 });
  let firstMessageId = "";
  let firstCommandId = "";
  const firstBroker = new SessionBroker({
    paths, observer: firstObserver, eventLog: firstEventLog, sessionsPath, queuePath,
    scanSessionProcesses: async () => [],
    discoverGatewayModels: async () => [],
    prepareRuntime: async () => ({ executablePath: "/fake/claude", credentialPath: "/fake/host-creds.json", environment: {} }),
    hostFactory: (_options: ClaudeSessionHostOptions) => {
      const events = new EventEmitter();
      return {
        start() {},
        async setModel() {},
        async setEffort() {},
        async setAutoCompactWindow() {},
        async supportedModels() { return []; },
        async contextUsage() { throw new Error("Context lookup not expected"); },
        send(input, origin) {
          const text = typeof input === "string" ? input : input.text;
          const turnId = randomUUID();
          const messageId = randomUUID();
          firstMessageId = messageId;
          events.emit("event", { type: "turn.started", sessionId, turnId, at: Date.now() } satisfies SessionHostEvent);
          events.emit("event", { type: "user.accepted", sessionId, turnId, messageId, text, origin, attachments: [], at: Date.now() } satisfies SessionHostEvent);
          return { turnId, messageId };
        },
        async interrupt() {},
        async close() {},
        onEvent(listener) { events.on("event", listener); return () => events.off("event", listener); },
      } satisfies SessionHostRuntime;
    },
  });

  await firstObserver.start();
  await firstBroker.initialize();
  const started = await firstBroker.startTurn({
    sessionId,
    requestId: "restart-accepted-req",
    idempotencyKey: "restart-accepted-key",
    text: "继续",
    origin: "mobile",
  });
  firstCommandId = started.commandId;
  await vi.waitFor(() => expect(firstMessageId).not.toBe(""));
  await vi.waitFor(() => expect(firstEventLog.hasItem(sessionId, "user.message.accepted", firstMessageId)).toBe(true));
  await appendFile(transcript, [
    JSON.stringify({ type: "user", uuid: firstMessageId, parentUuid: "previous-answer", message: { role: "user", content: "继续" } }),
    JSON.stringify({ type: "assistant", uuid: "restarted-answer", parentUuid: firstMessageId, message: { role: "assistant", content: "已完成", stop_reason: "end_turn" } }),
    "",
  ].join("\n"));
  await firstBroker.close();
  await firstObserver.close();
  await firstEventLog.close();

  const secondEventLog = new SessionEventLog(eventLogPath, 1);
  const secondObserver = new TranscriptObserver({ paths, eventLog: secondEventLog, platform: "linux", pollIntervalMs: 60_000, catalogIntervalMs: 60_000 });
  let secondSends = 0;
  const secondBroker = new SessionBroker({
    paths, observer: secondObserver, eventLog: secondEventLog, sessionsPath, queuePath,
    scanSessionProcesses: async () => [],
    discoverGatewayModels: async () => [],
    prepareRuntime: async () => ({ executablePath: "/fake/claude", credentialPath: "/fake/host-creds.json", environment: {} }),
    hostFactory: (_options: ClaudeSessionHostOptions) => {
      const events = new EventEmitter();
      return {
        start() {},
        async setModel() {},
        async setEffort() {},
        async setAutoCompactWindow() {},
        async supportedModels() { return []; },
        async contextUsage() { throw new Error("Context lookup not expected"); },
        send() {
          secondSends += 1;
          return { turnId: randomUUID(), messageId: randomUUID() };
        },
        async interrupt() {},
        async close() {},
        onEvent(listener) { events.on("event", listener); return () => events.off("event", listener); },
      } satisfies SessionHostRuntime;
    },
  });
  try {
    await secondObserver.start();
    await secondBroker.initialize();
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(secondSends).toBe(0);
    expect(secondBroker.session(sessionId)?.pendingCount).toBe(0);
    expect(secondEventLog.replay(0, 100, sessionId).some((event) => (
      event.type === "turn.completed" && event.data.commandId === firstCommandId
    ))).toBe(true);

    const duplicate = await secondBroker.startTurn({
      sessionId,
      requestId: "restart-accepted-req-dup",
      idempotencyKey: "restart-accepted-key",
      text: "继续",
      origin: "mobile",
    });
    expect(duplicate.state).toBe("completed");
    expect(secondSends).toBe(0);
  } finally {
    await secondBroker.close();
    await secondObserver.close();
    await secondEventLog.close();
  }
});

