import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { AsyncInputQueue } from "./async-input-queue.js";
import { ClaudeSessionHost } from "./claude-session-host.js";
import { SessionBroker, type TranscriptObserverRuntime } from "./session-broker.js";
import { SessionEventLog } from "./session-event-log.js";
import { EvidenceManager } from "./evidence-manager.js";
import { EvidenceStore } from "./evidence-store.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(maxParallelTurns = 8) {
  const root = await mkdtemp(join(tmpdir(), "bridge-final-review-")); roots.push(root);
  const eventLog = new SessionEventLog(join(root, "events.jsonl"), 1);
  const store = new EvidenceStore({ databasePath: join(root, "evidence.sqlite"), blobsPath: join(root, "blobs"), masterSecret: "test-only" });
  const evidence = new EvidenceManager({ store, eventLog });
  await eventLog.initialize();
  await evidence.initialize();
  const queries: Array<{ output: AsyncInputQueue<SDKMessage>; disposal?: Promise<void> }> = [];
  const hosts: ClaudeSessionHost[] = [];
  const observer: TranscriptObserverRuntime = {
    catalog: { sessions: [{ sessionId: "seed", cwd: root, projectId: "p", projectName: "p", title: "seed", source: "desktop", ownership: "DESKTOP_OBSERVED", transport: "bridge-host", turnState: "idle", pendingCount: 0, lastActivityAt: Date.now(), transcriptMtimeMs: 0, processAlive: false, desktopProcessAlive: false, bridgeProcessAlive: false, processOverlap: false, activeProcesses: [], activeTask: false }], projects: [], observedAt: Date.now() },
    isDesktopBusy: () => false, isMainTurnBusy: () => false, runningSubagents: () => undefined,
    externalWriteVersion: () => 0, async canStartBridgeHost() { return true; }, onCatalog: () => () => {},
  };
  const broker = new SessionBroker({
    paths: { sessions: join(root, "sessions"), projects: join(root, "projects"), tasks: join(root, "tasks"), desktopSessions: [] },
    sessionsPath: join(root, "sessions.json"), queuePath: join(root, "queue.json"), eventLog, observer, evidence, maxParallelTurns,
    prepareRuntime: async () => ({ executablePath: "/fake/claude", credentialPath: "/fake/creds", environment: {} }),
    discoverGatewayModels: async () => [], scanSessionProcesses: async () => [],
    hostFactory: options => {
      const host = new ClaudeSessionHost({ ...options, queryFactory: (() => {
        const query: typeof queries[number] = { output: new AsyncInputQueue<SDKMessage>() };
        queries.push(query);
        return {
          [Symbol.asyncIterator]: () => query.output[Symbol.asyncIterator](),
          async initializationResult() { return {}; }, async [Symbol.asyncDispose]() { await query.disposal; },
          async setModel() {}, async applyFlagSettings() {}, async supportedModels() { return []; },
          async stopTask() {}, async interrupt() { return { still_queued: [] }; }, close() { query.output.close(); },
        } as unknown as Query;
      }) });
      hosts.push(host); return host;
    },
  });
  await broker.initialize();
  const session = await broker.createSession(root, "Review");
  const internals = broker as unknown as { eventQueue: Promise<void>; pump(): Promise<void>; saveQueue(): Promise<void> };
  const submit = (key: string) => broker.startTurn({ sessionId: session.sessionId, requestId: key, idempotencyKey: key, text: key, origin: "mobile" });
  return { broker, internals, session, queries, hosts, eventLog, store, evidence, submit, async close() { await broker.close(); await evidence.close(); await eventLog.close(); } };
}

it("does not finalize the running command's evidence when a later queued command is cancelled", async () => {
  const f = await fixture();
  const finalized: Promise<unknown>[] = [];
  const original = f.evidence.finalizeBridgeTurn.bind(f.evidence);
  vi.spyOn(f.evidence, "finalizeBridgeTurn").mockImplementation(input => {
    const result = original(input); finalized.push(result); return result;
  });
  try {
    const active = await f.submit("running");
    await f.internals.pump();
    const evidenceId = (active as { evidenceId: string }).evidenceId;
    expect(f.store.get(evidenceId)?.state).toBe("collecting");
    const queued = await f.submit("queued");
    await f.broker.interruptTurn(f.session.sessionId, queued.commandId);
    await Promise.all(finalized);
    expect(f.broker.runtimeStatus().activeTurns).toBe(1);
    expect(f.store.get(evidenceId)?.state).toBe("collecting");
  } finally { await f.broker.close(); await Promise.all(finalized); await f.close(); }
});

it.each(["same-session", "global-capacity"] as const)("reserves a forced-stop writer until disposal finishes (%s)", async (scope) => {
  const f = await fixture(scope === "global-capacity" ? 1 : 8);
  let release!: () => void;
  let stopping: Promise<boolean> | undefined;
  const finalized: Promise<unknown>[] = [];
  const original = f.evidence.finalizeBridgeTurn.bind(f.evidence);
  vi.spyOn(f.evidence, "finalizeBridgeTurn").mockImplementation(input => {
    const result = original(input); finalized.push(result); return result;
  });
  try {
    const active = await f.submit("running");
    await f.internals.pump();
    await f.internals.eventQueue;
    f.queries[0]!.disposal = new Promise<void>(resolve => { release = resolve; });
    stopping = f.broker.interruptTurn(f.session.sessionId, active.commandId, true);
    const target = scope === "same-session" ? f.session : await f.broker.createSession(f.session.cwd, "Second");
    const next = await f.broker.startTurn({ sessionId: target.sessionId, requestId: "next", idempotencyKey: "next", text: "next", origin: "mobile" });
    await f.internals.pump();
    expect(f.queries).toHaveLength(1);
    expect(next.state).toBe("queued");
    expect(f.broker.runtimeStatus().activeTurns).toBe(1);
    expect(f.broker.session(f.session.sessionId)?.ownership).toBe("RELEASING");
    release();
    await stopping;
    await f.internals.pump();
    expect(f.queries).toHaveLength(2);
    expect(next.state).toBe("running");
    expect(f.broker.runtimeStatus().activeTurns).toBe(1);
  } finally { release?.(); await stopping; await f.broker.close(); await Promise.all(finalized); await f.close(); }
});

it("waits for an in-flight forced stop before shutdown releases persistence", async () => {
  const f = await fixture();
  let release!: () => void;
  let stopping: Promise<boolean> | undefined;
  let closing: Promise<void> | undefined;
  const finalized: Promise<unknown>[] = [];
  const original = f.evidence.finalizeBridgeTurn.bind(f.evidence);
  vi.spyOn(f.evidence, "finalizeBridgeTurn").mockImplementation(input => {
    const result = original(input); finalized.push(result); return result;
  });
  try {
    const active = await f.submit("running");
    await f.internals.pump();
    await f.internals.eventQueue;
    f.queries[0]!.disposal = new Promise<void>(resolve => { release = resolve; });
    stopping = f.broker.interruptTurn(f.session.sessionId, active.commandId, true);
    const save = vi.spyOn(f.internals, "saveQueue").mockResolvedValue(undefined);
    let closed = false;
    closing = f.broker.close().then(() => { closed = true; });
    await new Promise(resolve => setImmediate(resolve));
    save.mockRestore();
    expect(closed).toBe(false);
    release();
    await closing;
    expect(f.hosts[0]!.running).toBe(false);
    expect(f.store.get((active as { evidenceId: string }).evidenceId)?.state).toBe("failed");
    expect(f.eventLog.replay().some(event => event.type === "turn.interrupted" && event.data.forced === true)).toBe(true);
    const append = vi.spyOn(f.eventLog, "append");
    await stopping;
    await f.internals.eventQueue;
    expect(append).not.toHaveBeenCalled();
  } finally { release?.(); await stopping; await closing; await Promise.all(finalized); await f.close(); }
});
