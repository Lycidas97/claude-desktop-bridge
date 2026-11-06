import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CLAUDE_INTERRUPTED_USER_MESSAGE } from "@bridge/protocol";
import { parseClaudeTranscriptSnapshot } from "./claude-history.js";
import { SessionBroker, type SessionHostRuntime } from "./session-broker.js";
import { SessionEventLog } from "./session-event-log.js";
import { TranscriptObserver } from "./transcript-observer.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

it.each(["prompt", "tool-call", "tool-result"])("dispatches a fork copied during %s only after its Desktop executor exits", async (tail) => {
  const root = await mkdtemp(join(tmpdir(), "bridge-running-fork-"));
  directories.push(root);
  const sessionId = randomUUID();
  const paths = { sessions: join(root, "sessions"), tasks: join(root, "tasks"), projects: join(root, "projects"), desktopSessions: [] };
  await Promise.all([mkdir(paths.sessions), mkdir(paths.projects)]);
  await writeFile(join(paths.sessions, "parent.json"), JSON.stringify({
    pid: process.pid, sessionId, cwd: root, startedAt: Date.now(), entrypoint: "claude-desktop-3p",
  }));
  const transcript = join(paths.projects, `${sessionId}.jsonl`);
  const original = [
    JSON.stringify({ type: "user", uuid: "parent-user", parentUuid: null, sessionId, message: { role: "user", content: "Work" } }),
    ...(tail !== "prompt" ? [JSON.stringify({ type: "assistant", uuid: "parent-tool", parentUuid: "parent-user", sessionId, message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: {} }] } })] : []),
    ...(tail === "tool-result" ? [JSON.stringify({ type: "user", uuid: "parent-result", parentUuid: "parent-tool", sessionId, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "data" }] } })] : []),
    "",
  ].join("\n");
  await writeFile(transcript, original);
  const eventLog = new SessionEventLog(join(root, "events.jsonl"), 1);
  const observer = new TranscriptObserver({ paths, eventLog, platform: "linux", pollIntervalMs: 60_000, catalogIntervalMs: 0 });
  let sends = 0;
  const broker = new SessionBroker({
    paths, observer, eventLog, sessionsPath: join(root, "bridge-sessions.json"), queuePath: join(root, "queue.json"),
    scanSessionProcesses: async () => [], discoverGatewayModels: async () => [],
    prepareRuntime: async () => ({ executablePath: "/fake/claude", credentialPath: "/fake/credentials.json", environment: {} }),
    desktopRegistrar: {
      async register(input) {
        // Automatic Desktop adoption creates an idle CLI for the copied transcript.
        await writeFile(join(paths.sessions, `${input.sessionId}.json`), JSON.stringify({
          pid: process.pid, sessionId: input.sessionId, cwd: root, startedAt: Date.now(), entrypoint: "claude-desktop-3p",
        }));
        return { state: "registered", detail: "registered", updatedAt: Date.now(), desktopSessionId: `local_${input.sessionId}` };
      },
      changed(left, right) { return JSON.stringify(left) !== JSON.stringify(right); },
      publicInfo(value) { return value; },
    },
    hostFactory: () => ({
      start() {}, async setModel() {}, async setEffort() {}, async setAutoCompactWindow() {},
      async supportedModels() { return []; }, async contextUsage() { throw new Error("unused"); },
      send() { sends += 1; return { messageId: randomUUID(), turnId: randomUUID() }; },
      async interrupt() {}, async stopTask() {}, async close() {}, onEvent() { return () => {}; },
    }),
  });
  try {
    await observer.start();
    await broker.initialize();
    const fork = await broker.forkSession(sessionId);
    const forkPath = join(paths.projects, `${fork.sessionId}.jsonl`);
    expect(await readFile(transcript, "utf8")).toBe(original);
    const forkRecords = (await readFile(forkPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(forkRecords.at(-2)).toMatchObject({
      sessionId: fork.sessionId,
      parentUuid: tail === "prompt" ? "parent-user" : tail === "tool-call" ? "parent-tool" : "parent-result",
      message: { content: CLAUDE_INTERRUPTED_USER_MESSAGE },
    });
    // Cache reads must retain the terminal UUID as well as completion status.
    const firstSnapshot = await parseClaudeTranscriptSnapshot(forkPath, { limit: 1 });
    expect(await parseClaudeTranscriptSnapshot(forkPath, { limit: 1 })).toMatchObject({ atTurnBoundary: true, terminalUuid: firstSnapshot.terminalUuid });
    await (observer as unknown as { poll(): Promise<void> }).poll();
    expect(await observer.canStartBridgeHost(sessionId)).toBe(false);
    expect(observer.isMainTurnBusy(fork.sessionId)).toBe(false);
    expect(await observer.canStartBridgeHost(fork.sessionId)).toBe(false);
    const command = await broker.startTurn({ sessionId: fork.sessionId, requestId: "fork-request", idempotencyKey: "fork-key", text: "Continue in fork", origin: "mobile" });
    await (broker as unknown as { pump(): Promise<void> }).pump();
    expect({ sends, pendingCount: broker.session(fork.sessionId)?.pendingCount }).toEqual({ sends: 0, pendingCount: 1 });
    expect(broker.session(fork.sessionId)?.pendingCommandIds).toEqual([command.commandId]);
    expect(broker.session(fork.sessionId)?.desktopHandoff).toEqual({ state: "close-desktop", canReturn: false, canTakeover: process.platform === "darwin" });

    // Model the user closing only the fork's Desktop executor; keep its catalog identity.
    const forkRegistration = join(paths.sessions, `${fork.sessionId}.json`);
    await writeFile(forkRegistration, JSON.stringify({
      pid: 999_999_999, sessionId: fork.sessionId, cwd: root, startedAt: Date.now(), entrypoint: "claude-desktop-3p",
    }));
    await (observer as unknown as { poll(): Promise<void> }).poll();
    expect(await observer.canStartBridgeHost(sessionId)).toBe(false);
    expect(await observer.canStartBridgeHost(fork.sessionId)).toBe(true);
    await vi.waitFor(() => {
      expect({ sends, pendingCount: broker.session(fork.sessionId)?.pendingCount }).toEqual({ sends: 1, pendingCount: 0 });
    }, { timeout: 3_000 });
    expect(broker.session(fork.sessionId)?.pendingCommandIds).toEqual([]);
    expect(eventLog.latestItem(fork.sessionId, "session.desktop-handoff", fork.sessionId)?.data.state).toBe("bridge");

    await writeFile(forkRegistration, JSON.stringify({
      pid: process.pid, sessionId: fork.sessionId, cwd: root, startedAt: Date.now(), entrypoint: "claude-desktop-3p",
    }));
    await appendFile(forkPath, `${JSON.stringify({ type: "user", uuid: "fresh-desktop", parentUuid: firstSnapshot.terminalUuid, sessionId: fork.sessionId, message: { role: "user", content: "Fresh Desktop work" } })}\n`);
    await (observer as unknown as { poll(): Promise<void> }).poll();
    expect(observer.externalWriteVersion(fork.sessionId)).toBe(1);
    expect(await observer.canStartBridgeHost(fork.sessionId, true)).toBe(false);
    // This assertion concerns the sent command, not an inherited parent task.
    expect(command.commandId).toBeTruthy();
  } finally {
    await broker.close(); await observer.close(); await eventLog.close();
  }
});

it("retries startup failures and publishes exact queued command identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-send-error-"));
  directories.push(root);
  const sessionId = randomUUID();
  const paths = { sessions: join(root, "sessions"), tasks: join(root, "tasks"), projects: join(root, "projects"), desktopSessions: [] };
  const eventLog = new SessionEventLog(join(root, "events.jsonl"), 1);
  const observer = new TranscriptObserver({ paths, eventLog, platform: "linux", pollIntervalMs: 60_000, catalogIntervalMs: 60_000 });
  let sends = 0;
  const events = new EventEmitter();
  const broker = new SessionBroker({
    paths, observer, eventLog, sessionsPath: join(root, "bridge-sessions.json"), queuePath: join(root, "queue.json"),
    scanSessionProcesses: async () => [], discoverGatewayModels: async () => [],
    prepareRuntime: async () => ({ executablePath: "/fake/claude", credentialPath: "/fake/credentials.json", environment: {} }),
    hostFactory: () => ({
      start() {}, async setModel() {}, async setEffort() {}, async setAutoCompactWindow() {},
      async supportedModels() { return []; }, async contextUsage() { throw new Error("unused"); },
      send(input, origin) {
        if (++sends === 1) throw new Error("query startup failed");
        const receipt = { messageId: typeof input === "string" ? randomUUID() : input.messageId ?? randomUUID(), turnId: typeof input === "string" ? randomUUID() : input.turnId ?? randomUUID() };
        events.emit("event", {type:"user.accepted",sessionId,...receipt,text:typeof input === "string" ? input : input.text,origin,attachments:[],at:Date.now()});
        events.emit("event", {type:"turn.started",sessionId,turnId:receipt.turnId,at:Date.now()});
        return receipt;
      },
      async interrupt() {}, async stopTask() {}, async close() {}, onEvent(listener) { events.on("event", listener); return () => events.off("event", listener); },
    } satisfies SessionHostRuntime),
  });
  try {
    await observer.start();
    observer.catalog.sessions.push({ sessionId, cwd: root, projectId: "p", projectName: "p", title: "p", source: "desktop", ownership: "DESKTOP_OBSERVED", transport: "bridge-host", turnState: "idle", pendingCount: 0, lastActivityAt: Date.now(), transcriptMtimeMs: 0, processAlive: false, desktopProcessAlive: false, bridgeProcessAlive: false, processOverlap: false, activeProcesses: [], activeTask: false });
    await broker.initialize();
    await broker.startTurn({ sessionId, requestId: "send-request", idempotencyKey: "send-key", text: "Retry me", origin: "mobile" });
    await (broker as unknown as { pump(): Promise<void> }).pump();
    await (broker as unknown as { pump(): Promise<void> }).pump();
    expect({ sends, activeTurns: broker.runtimeStatus().activeTurns }).toEqual({ sends: 2, activeTurns: 1 });
    const waiting = await broker.startTurn({ sessionId, requestId: "waiting", idempotencyKey: "waiting-key", text: "Wait", origin: "mobile" });
    expect(broker.session(sessionId)).toMatchObject({ turnState: "running", pendingCount: 1, pendingCommandIds: [waiting.commandId] });
    const queued = eventLog.replay().find((event) => event.type === "turn.queued" && event.data.commandId === waiting.commandId);
    expect(queued?.data).toMatchObject({ pendingCount: 1, pendingCommandIds: [waiting.commandId] });
    await broker.interruptTurn(sessionId, waiting.commandId);
    const cancelled = eventLog.replay().find((event) => event.type === "turn.interrupted" && event.data.commandId === waiting.commandId);
    expect(cancelled?.data).toMatchObject({ wasQueued: true, pendingCount: 0, pendingCommandIds: [] });
    expect(broker.runtimeStatus().activeTurns).toBe(1);
  } finally {
    await broker.close(); await observer.close(); await eventLog.close();
  }
});
