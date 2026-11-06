import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeSessionHostOptions, SessionHostEvent } from "./claude-session-host.js";
import type { ClaudeCatalogSnapshot, ObservedClaudeSession } from "./claude-session-catalog.js";
import { parseClaudeTranscriptSnapshot } from "./claude-history.js";
import * as history from "./claude-history.js";
import { SessionBroker, type SessionBrokerOptions, type SessionHostRuntime, type TranscriptObserverRuntime } from "./session-broker.js";
import { SessionEventLog } from "./session-event-log.js";
import { ANTHROPIC_API_PROFILE_ID, CLAUDE_3P_PROFILE_ID, ConversationStateStore } from "./conversation-state-store.js";
import type { ProviderRuntimePool } from "./provider-runtime-pool.js";

const roots: string[] = [];
beforeEach(() => {
  // Every process probe and signal in this suite is fake, including unexpected PIDs.
  vi.spyOn(process, "kill").mockImplementation(() => true);
});
afterEach(() => {
  vi.restoreAllMocks();
  if (roots.length) execFileSync("/usr/bin/trash", roots.splice(0));
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

class Observer extends EventEmitter implements TranscriptObserverRuntime {
  busy = false;
  allowed = true;
  writeVersion = 0;
  constructor(readonly catalog: ClaudeCatalogSnapshot) { super(); }
  isDesktopBusy() { return this.busy; }
  isMainTurnBusy() { return this.busy; }
  runningSubagents(): undefined { return undefined; }
  externalWriteVersion() { return this.writeVersion; }
  async canStartBridgeHost(_id: string, _reuse = false) { return this.allowed; }
  onCatalog(listener: (catalog: ClaudeCatalogSnapshot) => void) {
    this.on("catalog", listener);
    return () => this.off("catalog", listener);
  }
  publish() { this.emit("catalog", this.catalog); }
}

class Host implements SessionHostRuntime {
  readonly events = new EventEmitter();
  readonly send = vi.fn((input: Parameters<SessionHostRuntime["send"]>[0]) => {
    const ids: { turnId?: string; messageId?: string } = typeof input === "string" ? {} : input;
    return { turnId: ids.turnId ?? randomUUID(), messageId: ids.messageId ?? randomUUID() };
  });
  readonly close = vi.fn(async () => {});
  constructor(readonly options: ClaudeSessionHostOptions) {}
  start() {}
  async setModel() {}
  async setEffort() {}
  async setAutoCompactWindow() {}
  async supportedModels() { return []; }
  async contextUsage(): Promise<never> { throw new Error("Unused in race reproduction"); }
  async interrupt() {}
  async stopTask() {}
  onEvent(listener: (event: SessionHostEvent) => void) {
    this.events.on("event", listener);
    return () => this.events.off("event", listener);
  }
}

async function fixture(desktopOpen = false, setup?: (options: SessionBrokerOptions, sessionId: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "broker-review-races-"));
  roots.push(root);
  const sessionId = randomUUID();
  const paths = { sessions: join(root, "sessions"), tasks: join(root, "tasks"), projects: join(root, "projects"), desktopSessions: [] };
  await mkdir(paths.projects);
  const transcriptPath = join(paths.projects, `${sessionId}.jsonl`);
  await writeFile(transcriptPath, [
    JSON.stringify({ type: "user", uuid: "desktop-input", sessionId, cwd: root, message: { role: "user", content: "Original Desktop task" } }),
    JSON.stringify({ type: "assistant", uuid: "desktop-finished", parentUuid: "desktop-input", sessionId, message: { role: "assistant", content: "Done", stop_reason: "end_turn" } }), "",
  ].join("\n"));
  const observed: ObservedClaudeSession = {
    sessionId, desktopSessionId: `desktop-${sessionId}`, cwd: root, projectId: "p", projectName: "p", title: "Review races",
    source: "desktop", ownership: "DESKTOP_OBSERVED", transport: "bridge-host", turnState: "idle", pendingCount: 0,
    lastActivityAt: Date.now(), transcriptMtimeMs: 0, transcriptPath, processAlive: desktopOpen,
    desktopProcessAlive: desktopOpen, bridgeProcessAlive: false, processOverlap: false, activeProcesses: [], activeTask: false,
  };
  const observer = new Observer({ sessions: [observed], projects: [], observedAt: Date.now() });
  observer.allowed = !desktopOpen;
  const eventLog = new SessionEventLog(join(root, "events.jsonl"), 1);
  const hosts: Host[] = [];
  const scan = vi.fn(async () => [] as ObservedClaudeSession["activeProcesses"]);
  const options: SessionBrokerOptions = {
    paths, eventLog, observer, sessionsPath: join(root, "sessions.json"), queuePath: join(root, "queue.json"),
    scanSessionProcesses: scan, discoverGatewayModels: async () => [],
    prepareRuntime: async () => ({ executablePath: "/fake/claude", credentialPath: "/fake/credentials", environment: {} }),
    hostFactory: input => { const host = new Host(input); hosts.push(host); return host; },
  };
  await setup?.(options, sessionId);
  const broker = new SessionBroker(options);
  await broker.initialize();
  const internals = broker as unknown as { pump(): Promise<void>; conflictTasks: Map<string, Promise<void>> };
  return {
    root, sessionId, transcriptPath, observed, observer, eventLog, hosts, scan, options, broker, internals,
    submit: (key: string) => broker.startTurn({ sessionId, requestId: key, idempotencyKey: key, text: `Phone message ${key}`, origin: "mobile" }),
    owner: (pid = 2_147_483_646): ObservedClaudeSession["activeProcesses"][number] => ({
      pid, startedAt: Date.now() - 10_000, processAlive: true, entrypoint: "claude-desktop-3p", source: "process",
    }),
    async close() { await broker.close(); await eventLog.close(); },
  };
}

describe("broker review race regressions", () => {
  it("#2 P1 refuses takeover if Desktop starts a main turn while the owner scan is awaiting", async () => {
    const f = await fixture(true);
    const scanEntered = deferred<void>();
    const scanRelease = deferred<void>();
    let alive = true;
    const signal = vi.mocked(process.kill).mockImplementation((_pid, name) => {
      if (name === "SIGINT") { alive = false; return true; }
      if (!alive) throw Object.assign(new Error("Fake Desktop exited"), { code: "ESRCH" });
      return true;
    });
    let takeover: Promise<unknown> | undefined;
    try {
      await f.submit("new-desktop-turn");
      await f.internals.pump();
      expect((await parseClaudeTranscriptSnapshot(f.transcriptPath)).atTurnBoundary).toBe(true);
      f.scan.mockImplementation(async () => { scanEntered.resolve(); await scanRelease.promise; return [f.owner()]; });
      takeover = f.broker.takeoverDesktop(f.sessionId).then(value => ({ value }), error => ({ error }));
      await scanEntered.promise;
      await appendFile(f.transcriptPath, JSON.stringify({ type: "user", uuid: "desktop-new-task", parentUuid: "desktop-finished", sessionId: f.sessionId, message: { role: "user", content: "A new active Desktop task" } }) + "\n");
      f.observer.busy = true;
      expect((await parseClaudeTranscriptSnapshot(f.transcriptPath)).atTurnBoundary).toBe(false);
      scanRelease.resolve();
      const result = await takeover;
      expect.soft(signal.mock.calls.filter(([, name]) => name === "SIGINT"), "the new active Desktop task must not receive SIGINT").toHaveLength(0);
      expect(result).toHaveProperty("error");
    } finally { scanRelease.resolve(); await takeover; await f.close(); }
  });

  it("takeover revision does not signal after the only queued message is cancelled during the final transcript recheck", async () => {
    const f = await fixture(true);
    const finalReadEntered = deferred<void>();
    const finalReadRelease = deferred<void>();
    let reads = 0;
    const parse = history.parseClaudeTranscriptSnapshot;
    vi.spyOn(history, "parseClaudeTranscriptSnapshot").mockImplementation(async (...args) => {
      if (++reads === 2) { finalReadEntered.resolve(); await finalReadRelease.promise; }
      return parse(...args);
    });
    let alive = true;
    const signal = vi.mocked(process.kill).mockImplementation((_pid, name) => {
      if (name === "SIGINT") { alive = false; return true; }
      if (!alive) throw Object.assign(new Error("Fake Desktop exited"), { code: "ESRCH" });
      return true;
    });
    let takeover: Promise<unknown> | undefined;
    f.scan.mockImplementation(async () => [f.owner()]);
    try {
      const receipt = await f.submit("cancel-final-recheck");
      await f.internals.pump();
      takeover = f.broker.takeoverDesktop(f.sessionId).then(value => ({ value }), error => ({ error }));
      await finalReadEntered.promise;
      expect(await f.broker.interruptTurn(f.sessionId, receipt.commandId)).toBe(true);
      expect((await f.submit("cancel-final-recheck")).state).toBe("cancelled");
      finalReadRelease.resolve();
      const result = await takeover;
      expect.soft(signal.mock.calls.filter(([, name]) => name === "SIGINT"), "cancelling the sole message before SIGINT must preserve the Desktop executor").toHaveLength(0);
      expect(result).toHaveProperty("error");
    } finally { finalReadRelease.resolve(); await takeover; await f.close(); }
  });

  it("#5 P1 keeps an unsent phone message queued when an external write arrives during the pre-send gate", async () => {
    const f = await fixture();
    const gateEntered = deferred<void>();
    const gateRelease = deferred<boolean>();
    let checks = 0;
    vi.spyOn(f.observer, "canStartBridgeHost").mockImplementation(async () => {
      checks += 1;
      if (checks === 2) { gateEntered.resolve(); return gateRelease.promise; }
      return checks === 1;
    });
    try {
      const receipt = await f.submit("external-before-send");
      await gateEntered.promise;
      expect(f.hosts[0]!.send).not.toHaveBeenCalled();
      f.observer.writeVersion += 1;
      f.observer.publish();
      await Promise.all(f.internals.conflictTasks.values());
      gateRelease.resolve(true);
      await f.internals.pump();
      expect(f.hosts[0]!.send).not.toHaveBeenCalled();
      const duplicate = await f.submit("external-before-send");
      expect.soft(duplicate.state, "no host.send occurred, so the original phone message must remain deliverable").toBe("queued");
      expect.soft(JSON.parse(await readFile(f.options.queuePath, "utf8")).pending).toEqual(expect.arrayContaining([expect.objectContaining({ commandId: receipt.commandId, state: "queued" })]));
      expect(f.eventLog.replay().filter(event => event.data.commandId === receipt.commandId && event.data.delivery === "cancelled")).toHaveLength(0);
    } finally { gateRelease.resolve(true); await f.close(); }
  });

  it("#8 P2 durably requeues a rejected unsent message before awaiting host disposal", async () => {
    const closeEntered = deferred<void>();
    const closeRelease = deferred<void>();
    const f = await fixture(false, async options => {
      const factory = options.hostFactory!;
      options.hostFactory = input => {
        const host = factory(input) as Host;
        host.close.mockImplementation(async () => { closeEntered.resolve(); await closeRelease.promise; });
        return host;
      };
    });
    let checks = 0;
    vi.spyOn(f.observer, "canStartBridgeHost").mockImplementation(async () => ++checks === 1);
    const recoveredLog = new SessionEventLog(join(f.root, "recovered-events.jsonl"), 1);
    let recovered: SessionBroker | undefined;
    try {
      const receipt = await f.submit("desktop-returned-before-send");
      await closeEntered.promise;
      expect(f.hosts[0]!.send).not.toHaveBeenCalled();
      const durable = await readFile(f.options.queuePath, "utf8");
      expect.soft(JSON.parse(durable).pending, "crash during host.close must leave the unsent command durably queued").toEqual(expect.arrayContaining([
        expect.objectContaining({ commandId: receipt.commandId, state: "queued" }),
      ]));
      expect.soft(JSON.parse(durable).pending[0]?.submissionStartedAt, "an unsent command must not carry submission evidence in durable storage").toBeUndefined();
      // Recover an isolated copy of the exact crash-time queue, without closing the old broker first.
      const recoveryQueue = join(f.root, "recovered-queue.json");
      await writeFile(recoveryQueue, durable);
      recovered = new SessionBroker({
        ...f.options, queuePath: recoveryQueue, eventLog: recoveredLog,
        prepareRuntime: async () => ({ environment: {} }),
      });
      await recovered.initialize();
      const restored = await recovered.startTurn({ sessionId: f.sessionId, requestId: "desktop-returned-before-send", idempotencyKey: "desktop-returned-before-send", text: "Phone message desktop-returned-before-send", origin: "mobile" });
      expect(restored.state, "recovery must preserve delivery of a message never given to host.send").toBe("queued");
      expect(f.hosts[0]!.send).not.toHaveBeenCalled();
    } finally {
      closeRelease.resolve();
      await recovered?.close();
      await recoveredLog.close();
      await f.close();
    }
  });

  it("#9 P2 permits another takeover after the only pending message is cancelled while Desktop exits", async () => {
    const f = await fixture(true);
    let alive = true;
    const signal = vi.mocked(process.kill).mockImplementation((_pid, name) => {
      if (name === "SIGINT") return true;
      if (!alive) throw Object.assign(new Error("Fake Desktop exited"), { code: "ESRCH" });
      return true;
    });
    let takeover: Promise<unknown> | undefined;
    f.scan.mockImplementation(async () => [f.owner()]);
    try {
      const first = await f.submit("cancel-during-exit");
      await f.internals.pump();
      takeover = f.broker.takeoverDesktop(f.sessionId);
      await vi.waitFor(() => expect(signal.mock.calls.filter(([, name]) => name === "SIGINT")).toHaveLength(1));
      expect(await f.broker.interruptTurn(f.sessionId, first.commandId)).toBe(true);
      f.observed.desktopProcessAlive = false;
      f.observed.processAlive = false;
      alive = false;
      await takeover;
      await f.internals.pump();
      f.observer.publish();
      // Desktop is reopened after the completed takeover, before the next message.
      f.observed.desktopProcessAlive = true;
      f.observed.processAlive = true;
      alive = true;
      f.scan.mockImplementation(async () => [f.owner(2_147_483_645)]);
      f.observer.publish();
      await f.submit("after-desktop-reopen");
      await f.internals.pump();
      expect.soft(f.broker.session(f.sessionId)?.desktopHandoff, "the new queued message must offer takeover again").toMatchObject({ state: "close-desktop", canTakeover: true });
      signal.mockImplementation((_pid, name) => {
        if (name === "SIGINT") { alive = false; return true; }
        if (!alive) throw Object.assign(new Error("Fake reopened Desktop exited"), { code: "ESRCH" });
        return true;
      });
      await f.broker.takeoverDesktop(f.sessionId);
      expect(signal.mock.calls.filter(([, name]) => name === "SIGINT")).toHaveLength(2);
      expect(f.hosts).toHaveLength(0);
    } finally { alive = false; await takeover; await f.close(); }
  });

  it("release identity revision preserves a fresh Desktop executor across receipt compaction and restart", async () => {
    const f = await fixture();
    const releasedDesktop = { pid: 111111, startedAt: 0 };
    let reopened: SessionBroker | undefined;
    const reopenedLog = new SessionEventLog(f.eventLog.path, 1, { bytesThreshold: 1, retainEvents: 0 });
    try {
      await f.eventLog.append({ sessionId: f.sessionId, itemId: f.sessionId, origin: "system", type: "session.desktop-handoff", data: {
        state: "released", desktopProcesses: [releasedDesktop],
      } });
      f.observed.desktopProcessAlive = true;
      f.observed.processAlive = true;
      f.observed.activeProcesses = [{ pid: 222222, startedAt: 0, processAlive: true, entrypoint: "claude-desktop-3p", source: "process" }];
      expect(f.broker.session(f.sessionId)?.desktopHandoff, "a different Desktop PID is fresh even when OS start time is unknown").toBeUndefined();
      await f.broker.close();
      await f.eventLog.close();
      reopened = new SessionBroker({ ...f.options, eventLog: reopenedLog, prepareRuntime: async () => ({ environment: {} }) });
      await reopened.initialize();
      expect.soft(reopenedLog.latestItem(f.sessionId, "session.desktop-handoff", f.sessionId)?.data.desktopProcesses, "receipt compaction must retain release identity").toEqual([releasedDesktop]);
      expect(reopened.session(f.sessionId)?.desktopHandoff, "restarting Bridge must not tell a fresh Desktop executor to reopen again").toBeUndefined();
    } finally { await reopened?.close(); await reopenedLog.close(); await f.close(); }
  });

  it("#12 P2 offers and executes takeover for the queued Claude-3p handoff target while the source API lane stays active", async () => {
    let store!: ConversationStateStore;
    let targetLaneId!: string;
    const f = await fixture(true, async (options, sessionId) => {
      store = new ConversationStateStore({ databasePath: join(options.paths.projects, "state.sqlite"), sessionsPath: options.sessionsPath, queuePath: options.queuePath, masterSecret: "review-races-fixture-only" });
      await store.initialize();
      store.ensureConversation({ conversationId: sessionId, cwd: join(options.paths.projects, ".."), title: "API source", source: "bridge", providerProfileId: ANTHROPIC_API_PROFILE_ID, providerKind: "anthropic-api", nativeSessionId: randomUUID() });
      targetLaneId = store.createLane({ conversationId: sessionId, providerProfileId: CLAUDE_3P_PROFILE_ID, providerKind: "claude-3p", nativeSessionId: sessionId, access: "read-write", status: "preparing" }).laneId;
      store.setRouteState(sessionId, "switching");
      options.conversationState = store;
      options.runtimePool = {
        hostPlan: async (logicalSessionId, lane, runtime) => ({ logicalSessionId, nativeSessionId: lane.nativeSessionId!, providerKind: lane.providerKind, executablePath: runtime.executablePath!, environment: runtime.environment }),
      } as ProviderRuntimePool;
    });
    const canStart = vi.spyOn(f.observer, "canStartBridgeHost");
    let alive = true;
    f.scan.mockImplementation(async () => alive ? [f.owner()] : []);
    const signal = vi.mocked(process.kill).mockImplementation((_pid, name) => {
      if (name === "SIGINT") {
        alive = false;
        f.observed.desktopProcessAlive = false;
        f.observed.processAlive = false;
        f.observer.allowed = true;
        return true;
      }
      if (!alive) throw Object.assign(new Error("Fake target Desktop exited"), { code: "ESRCH" });
      return true;
    });
    try {
      const receipt = await f.broker.startHandoffTurn({ handoffId: "api-to-3p", sessionId: f.sessionId, laneId: targetLaneId, text: "Continue the API conversation in Claude-3p" });
      await f.internals.pump();
      expect(store.activeLane(f.sessionId)?.providerKind).toBe("anthropic-api");
      expect(receipt).toMatchObject({ state: "queued", laneId: targetLaneId });
      expect(canStart).toHaveBeenCalledWith(f.sessionId, false);
      expect(f.hosts).toHaveLength(0);
      expect.soft(f.broker.session(f.sessionId)?.desktopHandoff, "the notice must describe the queued target Desktop executor").toMatchObject({ state: "close-desktop", canTakeover: true });
      const result = await f.broker.takeoverDesktop(f.sessionId).then(value => ({ value }), error => ({ error }));
      expect.soft(result, "the RPC must act on the queued Claude-3p target instead of rejecting the source API provider").not.toHaveProperty("error");
      expect(signal.mock.calls.filter(([, name]) => name === "SIGINT")).toHaveLength(1);
    } finally { await f.close(); store.close(); }
  });
});
