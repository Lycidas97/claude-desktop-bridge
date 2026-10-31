import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BridgeDesktopRegistrationInfo, BridgeEffort, BridgeModelInfo } from "@bridge/protocol";
import type { ModelInfo, SDKControlGetContextUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeSessionHostOptions, SessionHostEvent } from "./claude-session-host.js";
import type { StoredDesktopRegistration } from "./claude-desktop-session-registrar.js";
import type { ClaudeCatalogSnapshot, ObservedClaudeSession } from "./claude-session-catalog.js";
import {
  SessionBroker,
  type ManagedDesktopRuntime,
  type ManagedDesktopTransportRuntime,
  type SessionHostRuntime,
  type TranscriptObserverRuntime,
} from "./session-broker.js";
import { SessionEventLog } from "./session-event-log.js";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

const directories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
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

class FakeObserver extends EventEmitter implements TranscriptObserverRuntime {
  busy = false;
  bridgeCanStart: boolean | undefined;
  writeVersion = 0;

  constructor(readonly catalog: ClaudeCatalogSnapshot) {
    super();
  }

  isDesktopBusy(): boolean {
    return this.busy;
  }

  externalWriteVersion(): number {
    return this.writeVersion;
  }

  async canStartBridgeHost(_sessionId: string, reusingIdleHost = false): Promise<boolean> {
    return reusingIdleHost || (this.bridgeCanStart ?? !this.busy);
  }

  onCatalog(listener: (catalog: ClaudeCatalogSnapshot) => void): () => void {
    this.on("catalog", listener);
    return () => this.off("catalog", listener);
  }

  publish(): void {
    this.emit("catalog", this.catalog);
  }
}

class FakeHost implements SessionHostRuntime {
  readonly events = new EventEmitter();
  sends = 0;
  current: { turnId: string; messageId: string } | undefined;
  model: string | undefined;
  effort: BridgeEffort | undefined;
  closed = false;
  interrupts = 0;
  contextTotalTokens = 120_000;
  contextMaxTokens: number | undefined;
  autoCompactWindow: number | undefined;

  constructor(readonly options: ClaudeSessionHostOptions) {
    this.model = options.model;
    this.effort = options.effort;
  }

  start(): void {}

  async setModel(model?: string): Promise<void> {
    this.model = model;
  }

  async setEffort(effort?: BridgeEffort): Promise<void> {
    this.effort = effort;
  }

  async setAutoCompactWindow(maxTokens?: number): Promise<void> {
    this.autoCompactWindow = maxTokens;
  }

  async supportedModels(): Promise<Array<ModelInfo & BridgeModelInfo>> {
    return [
      {
        value: "claude-fable-5",
        displayName: "Fable 5",
        description: "Fast model",
        maxInputTokens: 262_144,
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high", "xhigh"],
      },
      {
        value: "claude-fable-5[1m]",
        displayName: "Fable 5 · 1M",
        description: "Long context",
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high", "xhigh"],
      },
    ];
  }

  async contextUsage(): Promise<SDKControlGetContextUsageResponse> {
    const maxTokens = this.contextMaxTokens
      ?? (this.model?.includes("[1m]") ? 1_000_000 : 262_144);
    return {
      categories: [],
      totalTokens: this.contextTotalTokens,
      maxTokens,
      rawMaxTokens: maxTokens,
      percentage: (this.contextTotalTokens / maxTokens) * 100,
      gridRows: [],
      model: this.model ?? "claude-fable-5[1m]",
      memoryFiles: [],
      mcpTools: [],
      agents: [],
      isAutoCompactEnabled: true,
      apiUsage: null,
    };
  }

  send(input: Parameters<SessionHostRuntime["send"]>[0], origin: Parameters<SessionHostRuntime["send"]>[1]) {
    this.sends += 1;
    const turnId = randomUUID();
    const messageId = randomUUID();
    const text = typeof input === "string" ? input : input.text;
    this.current = { turnId, messageId };
    this.emit({ type: "turn.started", sessionId: this.options.sessionId, turnId, at: Date.now() });
    this.emit({
      type: "user.accepted",
      sessionId: this.options.sessionId,
      turnId,
      messageId,
      text,
      attachments: [],
      origin,
      at: Date.now(),
    });
    return { turnId, messageId };
  }

  async interrupt(): Promise<void> {
    this.interrupts += 1;
    if (!this.current) return;
    this.emit({
      type: "turn.interrupted",
      sessionId: this.options.sessionId,
      turnId: this.current.turnId,
      at: Date.now(),
    });
    this.current = undefined;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  onEvent(listener: (event: SessionHostEvent) => void): () => void {
    this.events.on("event", listener);
    return () => this.events.off("event", listener);
  }

  complete(result = "Done"): void {
    if (!this.current) return;
    this.emit({
      type: "assistant.completed",
      sessionId: this.options.sessionId,
      turnId: this.current.turnId,
      itemId: randomUUID(),
      text: result,
      at: Date.now(),
    });
    this.emit({
      type: "turn.completed",
      sessionId: this.options.sessionId,
      turnId: this.current.turnId,
      result,
      at: Date.now(),
    });
    this.current = undefined;
  }

  runTool(itemId: string, output: unknown): void {
    if (!this.current) return;
    this.emit({
      type: "tool.started",
      sessionId: this.options.sessionId,
      turnId: this.current.turnId,
      itemId,
      toolName: "Bash",
      input: { command: "npm test" },
      at: Date.now(),
    });
    this.emit({
      type: "tool.completed",
      sessionId: this.options.sessionId,
      turnId: this.current.turnId,
      itemId,
      output,
      at: Date.now(),
    });
  }

  private emit(event: SessionHostEvent): void {
    this.events.emit("event", event);
  }
}

class FakeManagedDesktop extends EventEmitter implements ManagedDesktopRuntime {
  ready = true;
  enabled = true;
  stopped = false;

  status() {
    return {
      state: this.ready ? "ready" as const : "disconnected" as const,
      detail: this.ready ? "Ready" : "Disconnected",
      enabled: this.enabled,
      canRestart: true,
    };
  }

  applyToRuntimeStatus(status: Parameters<ManagedDesktopRuntime["applyToRuntimeStatus"]>[0]) {
    return { ...status, desktopIntegration: this.status() };
  }

  async stopClaudeForFallback(): Promise<void> {
    this.stopped = true;
    this.ready = false;
  }
}

class FakeManagedTransport extends EventEmitter implements ManagedDesktopTransportRuntime {
  ready = true;
  sends: Array<Parameters<ManagedDesktopTransportRuntime["send"]>[0]> = [];
  interrupts = 0;
  configuration: { model?: string; effort?: BridgeEffort } | undefined;
  models: string[] = [];
  efforts: Array<BridgeEffort | undefined> = [];

  updateCatalog(): void {}

  desktopSessionId(sessionId: string): string {
    return `desktop-${sessionId}`;
  }

  async send(input: Parameters<ManagedDesktopTransportRuntime["send"]>[0]) {
    this.sends.push(input);
    return {
      messageId: input.messageId ?? randomUUID(),
      turnId: input.turnId ?? randomUUID(),
      desktopSessionId: input.session.desktopSessionId ?? `desktop-${input.session.sessionId}`,
    };
  }

  async interrupt(): Promise<void> {
    this.interrupts += 1;
  }
  async setModel(_sessionId: string, model: string): Promise<void> { this.models.push(model); }
  async setEffort(_sessionId: string, effort?: BridgeEffort): Promise<void> { this.efforts.push(effort); }
  async getConfiguration() { return this.configuration; }
  async getContextUsage(): Promise<undefined> { return undefined; }
  clearIntent(): void {}

  onEvent(listener: (event: SessionHostEvent) => void): () => void {
    this.on("host-event", listener);
    return () => this.off("host-event", listener);
  }

  onDeliveryUncertain(listener: Parameters<ManagedDesktopTransportRuntime["onDeliveryUncertain"]>[0]): () => void {
    this.on("uncertain", listener);
    return () => this.off("uncertain", listener);
  }

  close(): void {
    this.removeAllListeners();
  }

  emitHost(event: SessionHostEvent): void {
    this.emit("host-event", event);
  }
}

function observed(
  sessionId: string,
  cwd: string,
  overrides: Partial<ObservedClaudeSession> = {},
): ObservedClaudeSession {
  return {
    sessionId,
    desktopSessionId: `desktop-${sessionId}`,
    projectId: `project-${sessionId}`,
    projectName: "project",
    cwd,
    title: `Session ${sessionId}`,
    source: "desktop",
    transport: "bridge-host",
    ownership: "DESKTOP_OBSERVED",
    turnState: "idle",
    lastActivityAt: Date.now(),
    pendingCount: 0,
    transcriptMtimeMs: Date.now(),
    processAlive: true,
    desktopProcessAlive: false,
    bridgeProcessAlive: false,
    processOverlap: false,
    activeProcesses: [],
    activeTask: false,
    hostModel: "claude-fable-5[1m]",
    hostEffort: "high",
    ...overrides,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 30_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for broker state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function writeContextTranscript(
  projects: string,
  cwd: string,
  sessionId: string,
  totalTokens: number,
): Promise<string> {
  const transcriptDirectory = join(projects, cwd.replace(/[:\\/]/gu, "-"));
  await Promise.all([mkdir(cwd, { recursive: true }), mkdir(transcriptDirectory, { recursive: true })]);
  const transcript = join(transcriptDirectory, `${sessionId}.jsonl`);
  await writeFile(transcript, JSON.stringify({
    type: "assistant",
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    message: {
      role: "assistant",
      model: "claude-opus-5",
      content: "done",
      usage: {
        input_tokens: totalTokens,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  }));
  return transcript;
}

describe("SessionBroker", () => {
  it("pages full transcript messages without letting old clipped events skip an oversized message", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-broker-full-history-"));
    directories.push(root);
    const sessionId = randomUUID();
    const cwd = join(root, "project");
    const projects = join(root, "projects");
    await mkdir(projects, { recursive: true });
    const longText = `开头\n${"完整中段".repeat(30_000)}\n结尾`;
    const rows = [
      { id: "u1", role: "user", text: "较早的问题" },
      { id: "a1", role: "assistant", text: longText },
      { id: "u2", role: "user", text: "新的问题" },
      { id: "a2", role: "assistant", text: "新的回答" },
    ];
    const at = Date.UTC(2026, 9, 29);
    await writeFile(join(projects, `${sessionId}.jsonl`), rows.map((row, index) => JSON.stringify({
      uuid: row.id, parentUuid: rows[index - 1]?.id ?? null, type: row.role, sessionId, cwd,
      timestamp: new Date(at + index * 1_000).toISOString(),
      message: { role: row.role, content: row.text },
    })).join("\n"));
    const eventLog = new SessionEventLog(join(root, "events.jsonl"), 1);
    for (const [index, row] of rows.entries()) {
      await eventLog.append({
        origin: "claude-desktop", type: "session.observed", sessionId, itemId: row.id,
        timestamp: at + index * 1_000,
        data: { role: row.role, text: row.id === "a1" ? "开头\n\n[内容较长，已省略中间部分]\n\n结尾" : row.text },
      });
    }
    const broker = new SessionBroker({
      paths: { sessions: join(root, "sessions"), tasks: join(root, "tasks"), projects, desktopSessions: [] },
      eventLog,
      observer: new FakeObserver({ projects: [], sessions: [observed(sessionId, cwd)], observedAt: Date.now() }),
      sessionsPath: join(root, "sessions.json"), queuePath: join(root, "queue.json"),
      prepareRuntime: async () => ({ executablePath: "/fake/claude", credentialPath: "/fake/creds.json", environment: {} }),
    });
    await broker.initialize();
    try {
      const first = await broker.history(sessionId);
      expect(first.items.map((item) => item.id)).toEqual(["u2", "a2"]);
      expect(first.hasMore).toBe(true);
      const second = await broker.history(sessionId, first.nextCursor);
      expect(second.items.map((item) => item.id)).toEqual(["a1"]);
      expect(second.items[0]?.text).toBe(longText);
      const third = await broker.history(sessionId, second.nextCursor);
      expect(third.items.map((item) => item.id)).toEqual(["u1"]);
      expect(third.hasMore).toBe(false);
    } finally {
      await broker.close();
      await eventLog.close();
    }
  });

  it("creates metadata only for a discovered project without probing its protected path", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-broker-project-"));
    directories.push(root);
    const cwd = join(root, "Documents", "project-not-mounted");
    const sessionId = randomUUID();
    const eventLog = new SessionEventLog(join(root, "events.jsonl"), 1);
    const observer = new FakeObserver({
      projects: [],
      sessions: [observed(sessionId, cwd)],
      observedAt: Date.now(),
    });
    const options = {
      paths: {
        sessions: join(root, "runtime-sessions"),
        tasks: join(root, "tasks"),
        projects: join(root, "projects"),
        desktopSessions: [],
      },
      eventLog,
      observer,
      sessionsPath: join(root, "sessions.json"),
      queuePath: join(root, "queue.json"),
      prepareRuntime: async () => ({
        executablePath: "/fake/claude",
        credentialPath: "/fake/host-creds.json",
        environment: {},
      }),
    };
    const broker = new SessionBroker(options);
    await broker.initialize();

    await expect(access(cwd)).rejects.toThrow();
    const created = await broker.createSession(cwd, "Explicit project");
    expect(created).toMatchObject({
      cwd,
      title: "Explicit project",
      source: "bridge",
      ownership: "BRIDGE_IDLE",
    });
    await expect(broker.createSession(join(root, "Documents", "unknown")))
      .rejects.toThrow(/selected from a discovered Claude project/u);

    await broker.close();
    const restarted = new SessionBroker(options);
    await restarted.initialize();
    expect(restarted.session(created.sessionId)).toMatchObject({
      source: "bridge",
      ownership: "BRIDGE_IDLE",
      turnState: "idle",
    });
    await restarted.close();
    await eventLog.close();
  });

  it("persists and exposes Claude Desktop registration without leaking local metadata paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-broker-registration-"));
    directories.push(root);
    const cwd = join(root, "project");
    const observedId = randomUUID();
    const eventLog = new SessionEventLog(join(root, "events.jsonl"), 1);
    const observer = new FakeObserver({
      projects: [],
      sessions: [observed(observedId, cwd)],
      observedAt: Date.now(),
    });
    let result: StoredDesktopRegistration = {
      state: "waiting-transcript",
      detail: "Waiting",
      updatedAt: 1,
    };
    const desktopRegistrar = {
      async register(): Promise<StoredDesktopRegistration> {
        return result;
      },
      publicInfo(value: StoredDesktopRegistration): BridgeDesktopRegistrationInfo {
        return {
          state: value.state,
          detail: value.detail,
          updatedAt: value.updatedAt,
          ...(value.desktopSessionId ? { desktopSessionId: value.desktopSessionId } : {}),
          ...(value.registeredAt ? { registeredAt: value.registeredAt } : {}),
        };
      },
      changed(
        previous: StoredDesktopRegistration | undefined,
        next: StoredDesktopRegistration,
      ): boolean {
        return JSON.stringify(previous) !== JSON.stringify(next);
      },
    };
    const broker = new SessionBroker({
      paths: {
        sessions: join(root, "runtime-sessions"),
        tasks: join(root, "tasks"),
        projects: join(root, "projects"),
        desktopSessions: [],
      },
      eventLog,
      observer,
      sessionsPath: join(root, "sessions.json"),
      queuePath: join(root, "queue.json"),
      desktopRegistrar,
      prepareRuntime: async () => ({
        executablePath: "/fake/claude",
        credentialPath: "/fake/host-creds.json",
        environment: {},
      }),
    });
    await broker.initialize();
    const created = await broker.createSession(cwd, "Register me");
    expect(created.desktopRegistration).toEqual({
      state: "waiting-transcript",
      detail: "Waiting",
      updatedAt: 1,
    });

    result = {
      state: "registered",
      detail: "Registered",
      updatedAt: 2,
      registeredAt: 2,
      desktopSessionId: `local_${created.sessionId}`,
      metadataPath: join(root, "private", "metadata.json"),
      metadataSha256: "secret-hash",
      profileSessionsRoot: join(root, "private"),
    };
    const registered = await broker.registerDesktopSession(created.sessionId);
    expect(registered).toMatchObject({
      desktopSessionId: `local_${created.sessionId}`,
      desktopRegistration: {
        state: "registered",
        detail: "Registered",
        updatedAt: 2,
      },
    });
    expect(registered.desktopRegistration).not.toHaveProperty("metadataPath");
    expect(eventLog.replay().at(-1)).toMatchObject({
      type: "session.desktop-registration",
      data: {
        state: "registered",
        desktopSessionId: `local_${created.sessionId}`,
      },
    });

    await broker.close();
    await eventLog.close();
  });

  it("detects a Claude Host credential created after Bridge startup", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-broker-"));
    directories.push(root);
    const eventLog = new SessionEventLog(join(root, "events.jsonl"), 1);
    const observer = new FakeObserver({ projects: [], sessions: [], observedAt: Date.now() });
    let credentialAvailable = false;
    const broker = new SessionBroker({
      paths: {
        sessions: join(root, "runtime-sessions"),
        tasks: join(root, "tasks"),
        projects: join(root, "projects"),
        desktopSessions: [],
      },
      eventLog,
      observer,
      sessionsPath: join(root, "sessions.json"),
      queuePath: join(root, "queue.json"),
      runtimeRetryDelayMs: 5,
      prepareRuntime: async () => ({
        executablePath: "/fake/claude",
        ...(credentialAvailable ? { credentialPath: "/fake/host-creds.json" } : {}),
        environment: {},
        version: "test",
      }),
    });

    await broker.initialize();
    expect(broker.runtimeStatus().state).toBe("auth-required");

    credentialAvailable = true;
    await waitFor(() => broker.runtimeStatus().state === "ready");
    expect(broker.runtimeStatus().credentialSource).toBe("third-party-host");

    await broker.close();
    await eventLog.close();
  });

  it("waits for desktop idle, resumes exactly once, and deduplicates delivery", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-broker-"));
    directories.push(root);
    const cwd = join(root, "project");
    const projects = join(root, "projects");
    const sessionId = randomUUID();
    await mkdir(join(projects, cwd.replace(/[:\\/]/gu, "-")), { recursive: true });
    await writeFile(join(projects, cwd.replace(/[:\\/]/gu, "-"), `${sessionId}.jsonl`), "");
    await mkdir(cwd, { recursive: true });
    const observer = new FakeObserver({
      projects: [],
      sessions: [observed(sessionId, cwd)],
      observedAt: Date.now(),
    });
    observer.busy = true;
    const hosts: FakeHost[] = [];
    const eventLog = new SessionEventLog(join(root, "events.jsonl"), 1);
    const sessionsPath = join(root, "sessions.json");
    const queuePath = join(root, "queue.json");
    const managedDesktop = new FakeManagedDesktop();
    managedDesktop.enabled = false;
    managedDesktop.ready = false;
    const runtimePaths = {
      sessions: join(root, "runtime-sessions"),
      tasks: join(root, "tasks"),
      projects,
      desktopSessions: [],
    };
    const broker = new SessionBroker({
      paths: runtimePaths,
      eventLog,
      observer,
      sessionsPath,
      queuePath,
      managedDesktop,
      hostFactory: (options) => {
        const host = new FakeHost(options);
        hosts.push(host);
        return host;
      },
      prepareRuntime: async () => ({
        executablePath: "/fake/claude",
        credentialPath: "/fake/host-creds.json",
        environment: {},
        version: "test",
      }),
    });
    await broker.initialize();
    const first = await broker.startTurn({
      requestId: "request-1",
      idempotencyKey: "same-command",
      sessionId,
      text: "Continue",
      origin: "mobile",
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(hosts).toHaveLength(0);

    observer.busy = false;
    observer.publish();
    await waitFor(() => hosts[0]?.sends === 1);
    expect(managedDesktop.stopped).toBe(false);
    expect(hosts[0]!.options.resume).toBe(true);
    expect(hosts[0]!.options.model).toBe("claude-fable-5[1m]");
    expect(hosts[0]!.options.effort).toBe("high");
    const duplicate = await broker.startTurn({
      requestId: "request-duplicate",
      idempotencyKey: "same-command",
      sessionId,
      text: "Continue",
      origin: "mobile",
    });
    expect(duplicate.commandId).toBe(first.commandId);
    expect(hosts[0]!.sends).toBe(1);
    hosts[0]!.complete();
    await waitFor(() => (
      eventLog.replay().some((event) => event.type === "turn.completed") &&
      broker.session(sessionId)?.turnState === "idle"
    ));
    const completedDuplicate = await broker.startTurn({
      requestId: "request-duplicate-after-completion",
      idempotencyKey: "same-command",
      sessionId,
      text: "Continue",
      origin: "mobile",
    });
    expect(completedDuplicate).toMatchObject({
      commandId: first.commandId,
      requestId: "request-1",
      state: "completed",
    });
    expect(eventLog.replay().find((event) => event.type === "turn.completed")?.data)
      .toMatchObject({ commandId: first.commandId, requestId: "request-1" });
    expect(hosts[0]!.sends).toBe(1);
    expect(broker.session(sessionId)?.turnState).toBe("idle");
    await broker.close();
    await eventLog.close();

    const reopenedHosts: FakeHost[] = [];
    const reopenedLog = new SessionEventLog(join(root, "events.jsonl"));
    const reopened = new SessionBroker({
      paths: runtimePaths,
      eventLog: reopenedLog,
      observer,
      sessionsPath,
      queuePath,
      hostFactory: (options) => {
        const host = new FakeHost(options);
        reopenedHosts.push(host);
        return host;
      },
      prepareRuntime: async () => ({
        executablePath: "/fake/claude",
        credentialPath: "/fake/host-creds.json",
        environment: {},
        version: "test",
      }),
    });
    await reopened.initialize();
    await expect(reopened.startTurn({
      requestId: "request-after-restart",
      idempotencyKey: "same-command",
      sessionId,
      text: "Continue",
      origin: "mobile",
    })).resolves.toMatchObject({ commandId: first.commandId, state: "completed" });
    expect(reopenedHosts).toHaveLength(0);
    await reopened.close();
    await reopenedLog.close();
  });

  it("blocks a cross-profile raw resume before starting a host or writing the transcript", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-broker-cross-profile-"));
    directories.push(root);
    const cwd = join(root, "project");
    const projects = join(root, "projects");
    const sessionId = randomUUID();
    const transcript = await writeContextTranscript(projects, cwd, sessionId, 10_000);
    const before = await readFile(transcript, "utf8");
    const observer = new FakeObserver({
      projects: [],
      sessions: [observed(sessionId, cwd, {
        sourceProfile: "claude",
        hostModel: "claude-opus-5",
        hostUltracode: true,
      })],
      observedAt: Date.now(),
    });
    const hosts: FakeHost[] = [];
    const eventLog = new SessionEventLog(join(root, "events.jsonl"));
    const broker = new SessionBroker({
      paths: {
        sessions: join(root, "runtime-sessions"),
        tasks: join(root, "tasks"),
        projects,
        desktopSessions: [],
      },
      eventLog,
      observer,
      sessionsPath: join(root, "sessions.json"),
      queuePath: join(root, "queue.json"),
      hostFactory: (options) => {
        const host = new FakeHost(options);
        hosts.push(host);
        return host;
      },
      prepareRuntime: async () => ({
        executablePath: "/fake/claude",
        credentialPath: join(root, "Application Support", "Claude-3p", "host-creds-test.json"),
        environment: {},
      }),
    });
    await broker.initialize();
    await broker.startTurn({
      requestId: "cross-profile-request",
      idempotencyKey: "cross-profile-command",
      sessionId,
      text: "继续处理",
      origin: "mobile",
    });

    await waitFor(() => eventLog.replay().some((event) => event.type === "turn.failed"));
    const failures = eventLog.replay().filter((event) => (
      event.type === "turn.failed" || event.type === "runtime.error"
    ));
    expect(failures).toHaveLength(1);
    expect(failures[0]?.data.error).toMatch(/Claude 官方.*Claude-3p.*不允许跨 profile/u);
    expect(eventLog.replay().some((event) => event.type === "user.message.accepted")).toBe(false);
    expect(hosts).toHaveLength(0);
    await expect(readFile(transcript, "utf8")).resolves.toBe(before);
    expect(broker.session(sessionId)).toMatchObject({ turnState: "idle", pendingCount: 0 });
    await broker.close();
    await eventLog.close();
  });

  it("treats ultracode metadata as 1M and resumes the same profile with a 1M model", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-broker-ultracode-"));
    directories.push(root);
    const cwd = join(root, "project");
    const projects = join(root, "projects");
    const sessionId = randomUUID();
    await writeContextTranscript(projects, cwd, sessionId, 300_000);
    const observer = new FakeObserver({
      projects: [],
      sessions: [observed(sessionId, cwd, {
        sourceProfile: "claude-3p",
        hostModel: "claude-opus-5",
        hostUltracode: true,
      })],
      observedAt: Date.now(),
    });
    const hosts: FakeHost[] = [];
    const eventLog = new SessionEventLog(join(root, "events.jsonl"));
    const broker = new SessionBroker({
      paths: {
        sessions: join(root, "runtime-sessions"),
        tasks: join(root, "tasks"),
        projects,
        desktopSessions: [],
      },
      eventLog,
      observer,
      sessionsPath: join(root, "sessions.json"),
      queuePath: join(root, "queue.json"),
      hostFactory: (options) => {
        const host = new FakeHost(options);
        hosts.push(host);
        return host;
      },
      discoverGatewayModels: async () => [
        { value: "claude-opus-5", displayName: "Opus 5", maxInputTokens: 262_144 },
        { value: "claude-opus-5[1m]", displayName: "Opus 5 1M", maxInputTokens: 1_000_000 },
      ],
      prepareRuntime: async () => ({
        executablePath: "/fake/claude",
        credentialPath: join(root, "Application Support", "Claude-3p", "host-creds-test.json"),
        environment: {},
      }),
    });
    await broker.initialize();
    // Resetting to the inherited 1M profile must use the same capacity as sending a turn.
    await expect(broker.configureSession({ sessionId, model: null })).resolves.toMatchObject({
      model: "claude-opus-5[1m]",
      modelSource: "claude-desktop",
    });
    await broker.startTurn({
      requestId: "ultracode-request",
      idempotencyKey: "ultracode-command",
      sessionId,
      text: "继续长上下文",
      origin: "mobile",
    });

    await waitFor(() => hosts[0]?.sends === 1);
    expect(hosts[0]?.options).toMatchObject({
      resume: true,
      model: "claude-opus-5[1m]",
    });
    hosts[0]!.complete();
    await waitFor(() => broker.session(sessionId)?.turnState === "idle");
    await broker.close();
    await eventLog.close();
  });

  it("lets the native runtime auto-compact an over-limit same-profile resume", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-broker-context-preflight-"));
    directories.push(root);
    const cwd = join(root, "project");
    const projects = join(root, "projects");
    const sessionId = randomUUID();
    await writeContextTranscript(projects, cwd, sessionId, 300_000);
    const observer = new FakeObserver({
      projects: [],
      sessions: [observed(sessionId, cwd, {
        sourceProfile: "claude-3p",
        hostModel: "claude-opus-5",
        hostUltracode: false,
      })],
      observedAt: Date.now(),
    });
    const hosts: FakeHost[] = [];
    const eventLog = new SessionEventLog(join(root, "events.jsonl"));
    const broker = new SessionBroker({
      paths: {
        sessions: join(root, "runtime-sessions"),
        tasks: join(root, "tasks"),
        projects,
        desktopSessions: [],
      },
      eventLog,
      observer,
      sessionsPath: join(root, "sessions.json"),
      queuePath: join(root, "queue.json"),
      hostFactory: (options) => {
        const host = new FakeHost(options);
        hosts.push(host);
        return host;
      },
      prepareRuntime: async () => ({
        executablePath: "/fake/claude",
        credentialPath: join(root, "Application Support", "Claude-3p", "host-creds-test.json"),
        environment: {},
      }),
    });
    await broker.initialize();
    await broker.startTurn({
      requestId: "over-limit-request",
      idempotencyKey: "over-limit-command",
      sessionId,
      text: "继续普通上下文",
      origin: "mobile",
    });

    try {
      await waitFor(() => hosts[0]?.sends === 1, 1_000);
      expect(hosts[0]?.options).toMatchObject({ resume: true, model: "claude-opus-5" });
      expect(eventLog.replay().some((event) => event.type === "turn.failed")).toBe(false);
      hosts[0]!.complete();
      await waitFor(() => broker.session(sessionId)?.turnState === "idle");
    } finally {
      await broker.close();
      await eventLog.close();
    }
  });

  it("lets the native runtime compact between sends instead of blocking on old usage", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-broker-context-recheck-"));
    directories.push(root);
    const cwd = join(root, "project");
    const projects = join(root, "projects");
    const sessionId = randomUUID();
    await writeContextTranscript(projects, cwd, sessionId, 100_000);
    const observer = new FakeObserver({
      projects: [],
      sessions: [observed(sessionId, cwd, {
        sourceProfile: "claude-3p",
        hostModel: "claude-opus-5",
        hostUltracode: false,
      })],
      observedAt: Date.now(),
    });
    const hosts: FakeHost[] = [];
    const eventLog = new SessionEventLog(join(root, "events.jsonl"));
    const broker = new SessionBroker({
      paths: {
        sessions: join(root, "runtime-sessions"),
        tasks: join(root, "tasks"),
        projects,
        desktopSessions: [],
      },
      eventLog,
      observer,
      sessionsPath: join(root, "sessions.json"),
      queuePath: join(root, "queue.json"),
      hostFactory: (options) => {
        const host = new FakeHost(options);
        hosts.push(host);
        return host;
      },
      prepareRuntime: async () => ({
        executablePath: "/fake/claude",
        credentialPath: join(root, "Application Support", "Claude-3p", "host-creds-test.json"),
        environment: {},
      }),
    });
    await broker.initialize();
    await broker.startTurn({
      requestId: "short-request",
      idempotencyKey: "short-command",
      sessionId,
      text: "短会话继续",
      origin: "mobile",
    });
    await waitFor(() => hosts[0]?.sends === 1);
    expect(hosts[0]?.options.model).toBe("claude-opus-5");
    hosts[0]!.complete();
    await waitFor(() => broker.session(sessionId)?.turnState === "idle");

    hosts[0]!.contextTotalTokens = 300_000;
    await broker.startTurn({
      requestId: "recheck-request",
      idempotencyKey: "recheck-command",
      sessionId,
      text: "再次继续",
      origin: "mobile",
    });
    try {
      await waitFor(() => hosts[0]?.sends === 2, 1_000);
      expect(eventLog.replay().some((event) => (
        event.type === "turn.failed" && event.data.requestId === "recheck-request"
      ))).toBe(false);
      hosts[0]!.complete();
      await waitFor(() => broker.session(sessionId)?.turnState === "idle");
    } finally {
      await broker.close();
      await eventLog.close();
    }
  });

  it("uses advertised custom-model capacity for configuration and explicit model changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-custom-context-"));
    directories.push(root);
    const sessionId = randomUUID();
    const cwd = join(root, "project");
    const projects = join(root, "projects");
    await writeContextTranscript(projects, cwd, sessionId, 292_121);
    const hosts: FakeHost[] = [];
    const eventLog = new SessionEventLog(join(root, "events.jsonl"));
    const broker = new SessionBroker({
      paths: { sessions: join(root, "runtime"), tasks: join(root, "tasks"), projects, desktopSessions: [] },
      eventLog,
      observer: new FakeObserver({ projects: [], sessions: [observed(sessionId, cwd, { hostModel: "custom-codex" })], observedAt: Date.now() }),
      sessionsPath: join(root, "sessions.json"),
      queuePath: join(root, "queue.json"),
      prepareRuntime: async () => ({ executablePath: "/fake/claude", credentialPath: "/fake/host-creds.json", environment: {} }),
      hostFactory: (options) => {
        const host = new FakeHost(options);
        hosts.push(host);
        return host;
      },
      discoverGatewayModels: async () => [
        { value: "custom-codex", displayName: "GPT · Codex", maxInputTokens: 400_000 },
        { value: "small-model", displayName: "Smaller model", maxInputTokens: 200_000 },
        { value: "unknown-model", displayName: "Unknown model" },
      ],
    });
    try {
      await broker.initialize();
      await expect(broker.configuration(sessionId, false)).resolves.toMatchObject({
        context: { totalTokens: 292_121, maxTokens: 400_000 },
        availableModels: expect.arrayContaining([expect.objectContaining({ value: "custom-codex", maxInputTokens: 400_000 })]),
      });
      await broker.startTurn({ requestId: "custom-cap", idempotencyKey: "custom-cap", sessionId, text: "继续", origin: "mobile" });
      await waitFor(() => hosts[0]?.sends === 1);
      expect(hosts[0]?.autoCompactWindow).toBe(400_000);
      hosts[0]!.complete();
      await waitFor(() => broker.session(sessionId)?.turnState === "idle");
      await expect(broker.configureSession({ sessionId, model: "custom-codex" }))
        .resolves.toMatchObject({ model: "custom-codex" });
      await expect(broker.configureSession({ sessionId, model: "small-model" }))
        .rejects.toThrow(/292,121 tokens.*200,000 tokens/u);
      await expect(broker.configureSession({ sessionId, model: "unknown-model" }))
        .resolves.toMatchObject({ model: "unknown-model" });
      expect(hosts[0]?.autoCompactWindow).toBeUndefined();
    } finally {
      await broker.close();
      await eventLog.close();
    }
  });

  it("rechecks live writers before spawning when the observer cache is stale", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-broker-live-writer-"));
    directories.push(root);
    const cwd = join(root, "project");
    const projects = join(root, "projects");
    const sessionId = randomUUID();
    const transcriptDirectory = join(projects, cwd.replace(/[:\\/]/gu, "-"));
    await Promise.all([
      mkdir(cwd, { recursive: true }),
      mkdir(transcriptDirectory, { recursive: true }),
    ]);
    await writeFile(join(transcriptDirectory, `${sessionId}.jsonl`), "");
    const observer = new FakeObserver({
      projects: [],
      sessions: [observed(sessionId, cwd)],
      observedAt: Date.now() - 10_000,
    });
    const hosts: FakeHost[] = [];
    let scans = 0;
    const eventLog = new SessionEventLog(join(root, "events.jsonl"));
    const broker = new SessionBroker({
      paths: {
        sessions: join(root, "runtime-sessions"),
        tasks: join(root, "tasks"),
        projects,
        desktopSessions: [],
      },
      eventLog,
      observer,
      sessionsPath: join(root, "sessions.json"),
      queuePath: join(root, "queue.json"),
      scanSessionProcesses: async () => {
        scans += 1;
        return [{
          pid: process.pid,
          cwd,
          startedAt: Date.now(),
          processAlive: true,
          entrypoint: "claude-desktop-3p",
          peerProtocol: "stream-json",
          source: "registration",
        }];
      },
      hostFactory: (options) => {
        const host = new FakeHost(options);
        hosts.push(host);
        return host;
      },
      prepareRuntime: async () => ({
        executablePath: "/fake/claude",
        credentialPath: "/fake/host-creds.json",
        environment: {},
      }),
    });
    await broker.initialize();
    await broker.startTurn({
      requestId: "request-live-writer",
      idempotencyKey: "command-live-writer",
      sessionId,
      text: "Continue without racing Claude Desktop",
      origin: "mobile",
    });
    await waitFor(() => scans > 0);

    expect(hosts).toHaveLength(0);
    expect(broker.session(sessionId)).toMatchObject({
      ownership: "DESKTOP_OBSERVED",
      turnState: "queued",
      pendingCount: 1,
    });
    expect(eventLog.replay().some((event) => (
      event.sessionId === sessionId
      && event.type === "session.ownership"
      && event.data.ownership === "DESKTOP_OBSERVED"
    ))).toBe(true);

    await broker.close();
    await eventLog.close();
  });

  it("waits for an active Desktop turn, then starts without closing an idle session viewer", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-broker-writer-"));
    directories.push(root);
    const cwd = join(root, "project");
    const projects = join(root, "projects");
    const sessionId = randomUUID();
    const transcriptDirectory = join(projects, cwd.replace(/[:\\/]/gu, "-"));
    await Promise.all([
      mkdir(cwd, { recursive: true }),
      mkdir(transcriptDirectory, { recursive: true }),
    ]);
    await writeFile(join(transcriptDirectory, `${sessionId}.jsonl`), "");
    const desktopSession = observed(sessionId, cwd);
    desktopSession.desktopProcessAlive = true;
    desktopSession.processAlive = true;
    desktopSession.activeProcesses = [{
      pid: process.pid,
      cwd,
      startedAt: Date.now(),
      processAlive: true,
      entrypoint: "claude-desktop-3p",
      peerProtocol: "stream-json",
      source: "registration",
    }];
    const observer = new FakeObserver({
      projects: [],
      sessions: [desktopSession],
      observedAt: Date.now(),
    });
    observer.busy = false;
    observer.bridgeCanStart = false;
    const hosts: FakeHost[] = [];
    const eventLog = new SessionEventLog(join(root, "events.jsonl"));
    const broker = new SessionBroker({
      paths: {
        sessions: join(root, "runtime-sessions"),
        tasks: join(root, "tasks"),
        projects,
        desktopSessions: [],
      },
      eventLog,
      observer,
      sessionsPath: join(root, "sessions.json"),
      queuePath: join(root, "queue.json"),
      hostFactory: (options) => {
        const host = new FakeHost(options);
        hosts.push(host);
        return host;
      },
      prepareRuntime: async () => ({
        executablePath: "/fake/claude",
        credentialPath: "/fake/host-creds.json",
        environment: {},
      }),
    });
    await broker.initialize();
    await broker.startTurn({
      requestId: "request-writer",
      idempotencyKey: "command-writer",
      sessionId,
      text: "Do not fork this session",
      origin: "mobile",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    observer.publish();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(hosts).toHaveLength(0);
    expect(broker.session(sessionId)).toMatchObject({
      ownership: "DESKTOP_OBSERVED",
      turnState: "queued",
      pendingCount: 1,
    });

    observer.bridgeCanStart = true;
    observer.publish();
    await waitFor(() => hosts[0]?.sends === 1);
    expect(desktopSession.desktopProcessAlive).toBe(true);
    expect(broker.session(sessionId)).toMatchObject({
      ownership: "BRIDGE_RUNNING",
      turnState: "running",
    });
    await broker.close();
    await eventLog.close();
  });

  it("resumes beside a completed persistent Desktop viewer without quitting Claude Desktop", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-broker-takeover-"));
    directories.push(root);
    const cwd = join(root, "project");
    const projects = join(root, "projects");
    const sessionId = randomUUID();
    const transcriptDirectory = join(projects, cwd.replace(/[:\\/]/gu, "-"));
    await Promise.all([
      mkdir(cwd, { recursive: true }),
      mkdir(transcriptDirectory, { recursive: true }),
    ]);
    await writeFile(join(transcriptDirectory, `${sessionId}.jsonl`), "");
    const desktopSession = observed(sessionId, cwd);
    desktopSession.desktopProcessAlive = true;
    desktopSession.processAlive = true;
    const observer = new FakeObserver({
      projects: [],
      sessions: [desktopSession],
      observedAt: Date.now(),
    });
    const hosts: FakeHost[] = [];
    const managedDesktop = new FakeManagedDesktop();
    managedDesktop.enabled = false;
    managedDesktop.ready = false;
    const eventLog = new SessionEventLog(join(root, "events.jsonl"));
    const broker = new SessionBroker({
      paths: {
        sessions: join(root, "runtime-sessions"),
        tasks: join(root, "tasks"),
        projects,
        desktopSessions: [],
      },
      eventLog,
      observer,
      sessionsPath: join(root, "sessions.json"),
      queuePath: join(root, "queue.json"),
      managedDesktop,
      hostFactory: (options) => {
        const host = new FakeHost(options);
        hosts.push(host);
        return host;
      },
      prepareRuntime: async () => ({
        executablePath: "/fake/claude",
        credentialPath: "/fake/host-creds.json",
        environment: {},
      }),
    });
    await broker.initialize();
    await broker.startTurn({
      requestId: "request-takeover",
      idempotencyKey: "command-takeover",
      sessionId,
      text: "Continue in the same transcript",
      origin: "mobile",
    });

    await waitFor(() => hosts[0]?.sends === 1);
    expect(managedDesktop.stopped).toBe(false);
    expect(hosts[0]!.options).toMatchObject({ sessionId, resume: true });
    expect(broker.session(sessionId)).toMatchObject({
      ownership: "BRIDGE_RUNNING",
      transport: "bridge-host",
    });
    expect(desktopSession.desktopProcessAlive).toBe(true);

    await broker.close();
    await eventLog.close();
  });

  it("requeues a Bridge turn without cancelling it when Desktop creates a competing writer", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-broker-conflict-"));
    directories.push(root);
    const cwd = join(root, "project");
    const sessionId = randomUUID();
    await mkdir(cwd, { recursive: true });
    const desktopSession = observed(sessionId, cwd);
    const observer = new FakeObserver({
      projects: [],
      sessions: [desktopSession],
      observedAt: Date.now(),
    });
    const hosts: FakeHost[] = [];
    const eventLog = new SessionEventLog(join(root, "events.jsonl"));
    const broker = new SessionBroker({
      paths: {
        sessions: join(root, "runtime-sessions"),
        tasks: join(root, "tasks"),
        projects: join(root, "projects"),
        desktopSessions: [],
      },
      eventLog,
      observer,
      sessionsPath: join(root, "sessions.json"),
      queuePath: join(root, "queue.json"),
      hostFactory: (options) => {
        const host = new FakeHost(options);
        hosts.push(host);
        return host;
      },
      prepareRuntime: async () => ({
        executablePath: "/fake/claude",
        credentialPath: "/fake/host-creds.json",
        environment: {},
      }),
    });
    await broker.initialize();
    await broker.startTurn({
      requestId: "request-conflict",
      idempotencyKey: "command-conflict",
      sessionId,
      text: "Keep this command queued",
      origin: "mobile",
    });
    await waitFor(() => hosts[0]?.sends === 1);

    desktopSession.desktopProcessAlive = true;
    desktopSession.bridgeProcessAlive = true;
    desktopSession.processAlive = true;
    desktopSession.processOverlap = true;
    desktopSession.activeProcesses = [
      {
        pid: 101,
        startedAt: Date.now(),
        processAlive: true,
        entrypoint: "claude-desktop-3p",
        source: "process",
      },
      {
        pid: 102,
        startedAt: Date.now(),
        processAlive: true,
        entrypoint: "claude-bridge",
        source: "process",
      },
    ];
    observer.publish();

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(hosts[0]?.closed).toBe(false);
    expect(broker.session(sessionId)).toMatchObject({
      ownership: "BRIDGE_RUNNING",
      turnState: "running",
      pendingCount: 0,
    });
    expect(eventLog.replay().filter((event) => (
      event.sessionId === sessionId && event.type === "session.ownership-conflict"
    ))).toHaveLength(0);

    observer.writeVersion += 1;
    observer.publish();
    await waitFor(() => {
      const session = broker.session(sessionId);
      return (
        hosts[0]?.closed === true &&
        hosts.length === 1 &&
        session?.ownership === "OWNERSHIP_CONFLICT" &&
        session.turnState === "queued" &&
        session.pendingCount === 1
      );
    });
    expect(hosts[0]?.interrupts).toBe(0);
    expect(hosts).toHaveLength(1);
    expect(broker.session(sessionId)).toMatchObject({
      ownership: "OWNERSHIP_CONFLICT",
      turnState: "queued",
      pendingCount: 1,
    });
    expect(eventLog.replay().filter((event) => (
      event.sessionId === sessionId && event.type === "turn.interrupted"
    ))).toHaveLength(0);
    expect(eventLog.replay().filter((event) => (
      event.sessionId === sessionId && event.type === "session.ownership-conflict"
    ))).toHaveLength(1);
    expect([...eventLog.replay()].reverse().find((event) => (
      event.sessionId === sessionId && event.type === "turn.queued"
    ))?.data).toMatchObject({
      commandId: expect.any(String),
      retrying: true,
      reason: "ownership-conflict",
    });

    desktopSession.desktopProcessAlive = false;
    desktopSession.bridgeProcessAlive = false;
    desktopSession.processAlive = false;
    desktopSession.processOverlap = false;
    desktopSession.activeProcesses = [];
    observer.publish();
    await waitFor(() => hosts[1]?.sends === 1);
    expect(hosts[1]?.options.sessionId).toBe(sessionId);

    await broker.close();
    await eventLog.close();
  });

  it("uses the managed Desktop transport as the only writer and preserves its event order", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-broker-managed-"));
    directories.push(root);
    const cwd = join(root, "project");
    const sessionId = randomUUID();
    await mkdir(cwd, { recursive: true });
    const desktopSession = observed(sessionId, cwd);
    desktopSession.desktopProcessAlive = true;
    desktopSession.processAlive = true;
    const observer = new FakeObserver({
      projects: [],
      sessions: [desktopSession],
      observedAt: Date.now(),
    });
    const hosts: FakeHost[] = [];
    const managedDesktop = new FakeManagedDesktop();
    const managedTransport = new FakeManagedTransport();
    managedTransport.configuration = { model: "desktop-live", effort: "xhigh" };
    const eventLog = new SessionEventLog(join(root, "events.jsonl"));
    const broker = new SessionBroker({
      paths: {
        sessions: join(root, "runtime-sessions"),
        tasks: join(root, "tasks"),
        projects: join(root, "projects"),
        desktopSessions: [],
      },
      eventLog,
      observer,
      sessionsPath: join(root, "sessions.json"),
      queuePath: join(root, "queue.json"),
      managedDesktop,
      managedTransport,
      hostFactory: (options) => {
        const host = new FakeHost(options);
        hosts.push(host);
        return host;
      },
      prepareRuntime: async () => ({
        executablePath: "/fake/claude",
        credentialPath: "/fake/host-creds.json",
        environment: {},
      }),
    });
    await broker.initialize();
    await expect(broker.configuration(sessionId, false)).resolves.toMatchObject({ model: "desktop-live", effort: "xhigh" });
    managedTransport.configuration = { model: "desktop-latest", effort: "medium" };
    const receipt = await broker.startTurn({
      requestId: "request-managed",
      idempotencyKey: "command-managed",
      sessionId,
      text: "Run in Claude Desktop",
      origin: "mobile",
    });
    await waitFor(() => managedTransport.sends.length === 1);
    expect(hosts).toHaveLength(0);
    expect(managedTransport.sends[0]).toMatchObject({
      session: { sessionId },
      text: "Run in Claude Desktop",
      messageId: receipt.commandId,
      mode: "start",
      model: "desktop-latest",
      effort: "medium",
    });
    expect(managedTransport.models).toEqual(["desktop-latest"]);
    expect(managedTransport.efforts).toEqual(["medium"]);
    const turnId = managedTransport.sends[0]?.turnId;
    if (!turnId) throw new Error("Managed turn did not receive an id");
    managedTransport.emitHost({
      type: "turn.started",
      sessionId,
      turnId,
      at: 10,
    });
    managedTransport.emitHost({
      type: "user.accepted",
      sessionId,
      turnId,
      messageId: receipt.commandId,
      text: "Run in Claude Desktop",
      attachments: [],
      origin: "mobile",
      at: 11,
    });
    desktopSession.bridgeProcessAlive = true;
    desktopSession.processOverlap = true;
    desktopSession.activeProcesses = [
      {
        pid: 201,
        startedAt: Date.now(),
        processAlive: true,
        entrypoint: "claude-desktop-3p",
        source: "process",
      },
      {
        pid: 202,
        startedAt: Date.now(),
        processAlive: true,
        entrypoint: "claude-bridge",
        source: "process",
      },
    ];
    observer.publish();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(eventLog.replay().some((event) => (
      event.sessionId === sessionId && event.type === "session.ownership-conflict"
    ))).toBe(false);
    expect(managedTransport.interrupts).toBe(0);
    desktopSession.bridgeProcessAlive = false;
    desktopSession.processOverlap = false;
    desktopSession.activeProcesses = [];
    observer.publish();
    managedTransport.emitHost({
      type: "assistant.delta",
      sessionId,
      turnId,
      itemId: "provider-stream-1",
      text: "PO",
      at: 11.5,
    });
    managedTransport.emitHost({
      type: "assistant.delta",
      sessionId,
      turnId,
      itemId: "provider-stream-2",
      text: "关键",
      at: 11.6,
    });
    managedTransport.emitHost({
      type: "assistant.completed",
      sessionId,
      turnId,
      itemId: "assistant-1",
      text: "Done",
      at: 12,
    });
    managedTransport.emitHost({
      type: "turn.completed",
      sessionId,
      turnId,
      result: "Done",
      at: 13,
    });
    await waitFor(() => broker.session(sessionId)?.turnState === "idle");
    expect(broker.session(sessionId)).toMatchObject({
      transport: "claude-desktop-managed",
      ownership: "DESKTOP_MANAGED_IDLE",
    });
    expect(eventLog.replay().filter((event) => event.sessionId === sessionId).map((event) => event.type))
      .toEqual(expect.arrayContaining([
        "session.transport",
        "turn.started",
        "user.message.accepted",
        "assistant.completed",
        "turn.completed",
      ]));
    expect(eventLog.replay().filter((event) => (
      event.sessionId === sessionId && event.type === "assistant.delta"
    ))).toEqual([
      expect.objectContaining({
        itemId: `assistant:${turnId}`,
        data: { text: "PO关键" },
      }),
    ]);
    await broker.close();
    await eventLog.close();
  });

  it("lets a force stop remove a Bridge turn restored as queued after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-broker-restart-stop-"));
    directories.push(root);
    const cwd = join(root, "project");
    const sessionId = randomUUID();
    const queuePath = join(root, "queue.json");
    await mkdir(cwd, { recursive: true });
    await writeFile(queuePath, JSON.stringify({
      version: 2,
      pending: [{
        commandId: "restart-command",
        requestId: "restart-request",
        idempotencyKey: "restart-idempotency",
        sessionId,
        text: "stale task",
        attachments: [],
        origin: "desktop",
        requestedAt: 1_000,
        priority: 0,
        attempts: 1,
        state: "running",
        mode: "start",
        transport: "bridge-host",
        turnId: "restart-turn",
        evidenceId: "restart-evidence",
      }],
      completedIdempotencyKeys: [],
      terminalTurns: [],
    }));
    const observer = new FakeObserver({
      projects: [],
      sessions: [observed(sessionId, cwd)],
      observedAt: Date.now(),
    });
    observer.busy = true;
    const eventLog = new SessionEventLog(join(root, "events.jsonl"));
    const broker = new SessionBroker({
      paths: {
        sessions: join(root, "runtime-sessions"),
        tasks: join(root, "tasks"),
        projects: join(root, "projects"),
        desktopSessions: [],
      },
      eventLog,
      observer,
      sessionsPath: join(root, "sessions.json"),
      queuePath,
      prepareRuntime: async () => ({
        executablePath: "/fake/claude",
        credentialPath: "/fake/host-creds.json",
        environment: {},
      }),
    });
    await broker.initialize();
    expect(broker.session(sessionId)).toMatchObject({
      turnState: "queued",
      pendingCount: 1,
    });

    await expect(broker.interruptTurn(sessionId, undefined, true)).resolves.toBe(true);

    expect(broker.session(sessionId)).toMatchObject({
      ownership: "DESKTOP_OBSERVED",
      turnState: "running",
      pendingCount: 0,
    });
    expect(JSON.parse(await readFile(queuePath, "utf8"))).toMatchObject({
      pending: [],
      terminalTurns: [{
        commandId: "restart-command",
        state: "cancelled",
      }],
    });
    expect(eventLog.replay().at(-1)).toMatchObject({
      type: "turn.interrupted",
      itemId: "restart-command",
    });
    await broker.close();
    await eventLog.close();
  });

  it("surfaces a rotated-session queue as a blocked recovery task instead of replaying it", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-broker-orphan-stop-"));
    directories.push(root);
    const cwd = join(root, "project");
    const projectsRoot = join(root, "projects");
    const staleSessionId = randomUUID();
    const currentSessionId = randomUUID();
    const queuePath = join(root, "queue.json");
    await Promise.all([mkdir(cwd, { recursive: true }), mkdir(projectsRoot, { recursive: true })]);
    await writeFile(
      join(projectsRoot, `${staleSessionId}.jsonl`),
      `${JSON.stringify({ type: "attachment", sessionId: staleSessionId, cwd })}\n`,
    );
    await writeFile(queuePath, JSON.stringify({
      version: 2,
      pending: [{
        commandId: "orphan-command",
        requestId: "orphan-request",
        idempotencyKey: "orphan-idempotency",
        sessionId: staleSessionId,
        text: "stale task after install",
        attachments: [],
        origin: "desktop",
        requestedAt: 1_000,
        priority: 0,
        attempts: 0,
        state: "running",
        mode: "start",
        transport: "bridge-host",
      }],
      completedIdempotencyKeys: [],
      terminalTurns: [],
    }));
    const observer = new FakeObserver({
      projects: [],
      sessions: [observed(currentSessionId, cwd)],
      observedAt: Date.now(),
    });
    const hosts: FakeHost[] = [];
    const eventLog = new SessionEventLog(join(root, "events.jsonl"));
    const broker = new SessionBroker({
      paths: {
        sessions: join(root, "runtime-sessions"),
        tasks: join(root, "tasks"),
        projects: projectsRoot,
        desktopSessions: [],
      },
      eventLog,
      observer,
      sessionsPath: join(root, "sessions.json"),
      queuePath,
      hostFactory: (options) => {
        const host = new FakeHost(options);
        hosts.push(host);
        return host;
      },
      prepareRuntime: async () => ({
        executablePath: "/fake/claude",
        credentialPath: "/fake/host-creds.json",
        environment: {},
      }),
    });

    await broker.initialize();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(hosts).toHaveLength(0);
    expect(broker.session(staleSessionId)).toMatchObject({
      cwd,
      title: "未完成任务：stale task after install",
      source: "bridge",
      ownership: "BRIDGE_IDLE",
      turnState: "queued",
      pendingCount: 1,
    });

    await expect(broker.interruptTurn(staleSessionId, undefined, true)).resolves.toBe(true);
    expect(broker.session(staleSessionId)).toBeUndefined();
    expect(JSON.parse(await readFile(queuePath, "utf8"))).toMatchObject({
      pending: [],
      terminalTurns: [{
        commandId: "orphan-command",
        state: "cancelled",
      }],
    });
    await broker.close();
    await eventLog.close();
  });

  it("force-stops an unavailable managed turn so later sessions can run", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-broker-uncertain-stop-"));
    directories.push(root);
    const staleSessionId = randomUUID();
    const nextSessionId = randomUUID();
    const staleCwd = join(root, "stale-project");
    const nextCwd = join(root, "next-project");
    const queuePath = join(root, "queue.json");
    await Promise.all([mkdir(staleCwd, { recursive: true }), mkdir(nextCwd, { recursive: true })]);
    await writeFile(queuePath, JSON.stringify({
      version: 2,
      pending: [{
        commandId: "uncertain-command",
        requestId: "uncertain-request",
        idempotencyKey: "uncertain-idempotency",
        sessionId: staleSessionId,
        text: "stale managed task",
        attachments: [],
        origin: "desktop",
        requestedAt: 1_000,
        priority: 0,
        attempts: 1,
        state: "running",
        mode: "start",
        transport: "claude-desktop-managed",
        turnId: "uncertain-turn",
      }],
      completedIdempotencyKeys: [],
      terminalTurns: [],
    }));
    const observer = new FakeObserver({
      projects: [],
      sessions: [
        observed(staleSessionId, staleCwd),
        observed(nextSessionId, nextCwd),
      ],
      observedAt: Date.now(),
    });
    const managedTransport = new FakeManagedTransport();
    managedTransport.ready = false;
    const hosts: FakeHost[] = [];
    const eventLog = new SessionEventLog(join(root, "events.jsonl"));
    const broker = new SessionBroker({
      paths: {
        sessions: join(root, "runtime-sessions"),
        tasks: join(root, "tasks"),
        projects: join(root, "projects"),
        desktopSessions: [],
      },
      eventLog,
      observer,
      sessionsPath: join(root, "sessions.json"),
      queuePath,
      maxParallelTurns: 1,
      managedTransport,
      hostFactory: (options) => {
        const host = new FakeHost(options);
        hosts.push(host);
        return host;
      },
      prepareRuntime: async () => ({
        executablePath: "/fake/claude",
        credentialPath: "/fake/host-creds.json",
        environment: {},
      }),
    });
    await broker.initialize();
    await broker.startTurn({
      requestId: "next-request",
      idempotencyKey: "next-idempotency",
      sessionId: nextSessionId,
      text: "run after stale task",
      origin: "desktop",
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(hosts).toHaveLength(0);

    await expect(broker.interruptTurn(staleSessionId, undefined, true)).resolves.toBe(true);
    await waitFor(() => hosts[0]?.sends === 1);

    expect(broker.session(staleSessionId)).toMatchObject({
      turnState: "idle",
      pendingCount: 0,
    });
    expect(hosts[0]?.options.sessionId).toBe(nextSessionId);
    await broker.close();
    await eventLog.close();
  });

  it("continues queued turns on its retained host when Desktop's activity gate stays busy", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-broker-queue-resume-"));
    directories.push(root);
    const cwd = join(root, "project");
    await mkdir(cwd, { recursive: true });
    const sessionId = randomUUID();
    const observer = new FakeObserver({
      projects: [],
      sessions: [observed(sessionId, cwd, { desktopProcessAlive: true })],
      observedAt: Date.now(),
    });
    const hosts: FakeHost[] = [];
    const eventLog = new SessionEventLog(join(root, "events.jsonl"), 1);
    const broker = new SessionBroker({
      paths: { sessions: join(root, "runtime-sessions"), tasks: join(root, "tasks"), projects: join(root, "projects"), desktopSessions: [] },
      eventLog,
      observer,
      sessionsPath: join(root, "sessions.json"),
      queuePath: join(root, "queue.json"),
      scanSessionProcesses: async () => [],
      hostFactory: (options) => {
        const host = new FakeHost(options);
        hosts.push(host);
        return host;
      },
      prepareRuntime: async () => ({ executablePath: "/fake/claude", credentialPath: "/fake/host-creds.json", environment: {} }),
    });
    try {
      await broker.initialize();
      await broker.startTurn({ requestId: "first", idempotencyKey: "first", sessionId, text: "First turn", origin: "mobile" });
      await waitFor(() => hosts[0]?.sends === 1);
      observer.bridgeCanStart = false;
      await broker.startTurn({ requestId: "follow-up", idempotencyKey: "follow-up", sessionId, text: "Queued while first runs", origin: "mobile" });
      hosts[0]!.complete();
      await waitFor(() => hosts[0]?.sends === 2, 1_000);
      expect(hosts).toHaveLength(1);
      expect(broker.session(sessionId)?.pendingCount).toBe(0);
      expect(hosts[0]!.closed).toBe(false);
      const duplicate = await broker.startTurn({ requestId: "retry", idempotencyKey: "follow-up", sessionId, text: "Queued while first runs", origin: "mobile" });
      expect(duplicate.state).toBe("running");
      expect(hosts[0]!.sends).toBe(2);
      hosts[0]!.complete();
      await waitFor(() => broker.session(sessionId)?.turnState === "idle");
    } finally {
      await broker.close();
      await eventLog.close();
    }
  });

  it("runs at most two turns and leaves the third durably queued", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-broker-"));
    directories.push(root);
    const projects = join(root, "projects");
    const sessions = [0, 1, 2].map((index) => observed(randomUUID(), join(root, `project-${index}`)));
    await Promise.all(sessions.map((session) => mkdir(session.cwd, { recursive: true })));
    const observer = new FakeObserver({ projects: [], sessions, observedAt: Date.now() });
    const hosts: FakeHost[] = [];
    const eventLog = new SessionEventLog(join(root, "events.jsonl"));
    const broker = new SessionBroker({
      paths: {
        sessions: join(root, "runtime-sessions"),
        tasks: join(root, "tasks"),
        projects,
        desktopSessions: [],
      },
      eventLog,
      observer,
      sessionsPath: join(root, "sessions.json"),
      queuePath: join(root, "queue.json"),
      maxParallelTurns: 2,
      hostFactory: (options) => {
        const host = new FakeHost(options);
        hosts.push(host);
        return host;
      },
      prepareRuntime: async () => ({
        executablePath: "/fake/claude",
        credentialPath: "/fake/host-creds.json",
        environment: {},
      }),
    });
    await broker.initialize();
    await Promise.all(sessions.map((session, index) => broker.startTurn({
      requestId: `request-${index}`,
      idempotencyKey: `command-${index}`,
      sessionId: session.sessionId,
      text: `Turn ${index}`,
      origin: "mobile",
    })));
    await waitFor(() => hosts.reduce((sum, host) => sum + host.sends, 0) === 2);

    expect(broker.runtimeStatus().activeTurns).toBe(2);
    expect(broker.listSessions().reduce((sum, session) => sum + session.pendingCount, 0)).toBe(1);
    await broker.close();
    await eventLog.close();
  });

  it("marks a running session as waiting and records the first permission resolver", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-broker-permission-"));
    directories.push(root);
    const cwd = join(root, "project");
    const sessionId = randomUUID();
    await mkdir(cwd, { recursive: true });
    const observer = new FakeObserver({
      projects: [],
      sessions: [observed(sessionId, cwd)],
      observedAt: Date.now(),
    });
    const hosts: FakeHost[] = [];
    const eventLog = new SessionEventLog(join(root, "events.jsonl"), 1);
    const broker = new SessionBroker({
      paths: {
        sessions: join(root, "runtime-sessions"),
        tasks: join(root, "tasks"),
        projects: join(root, "projects"),
        desktopSessions: [],
      },
      eventLog,
      observer,
      sessionsPath: join(root, "sessions.json"),
      queuePath: join(root, "queue.json"),
      hostFactory: (options) => {
        const host = new FakeHost(options);
        hosts.push(host);
        return host;
      },
      prepareRuntime: async () => ({
        executablePath: "/fake/claude",
        credentialPath: "/fake/host-creds.json",
        environment: {},
      }),
    });
    await broker.initialize();
    await broker.startTurn({
      requestId: "request-permission",
      idempotencyKey: "command-permission",
      sessionId,
      text: "Update the file",
      origin: "mobile",
    });
    await waitFor(() => hosts[0]?.sends === 1);

    const controller = new AbortController();
    const pending = broker.permissionBroker.request(sessionId, "Write", {
      file_path: join(cwd, "demo.ts"),
      content: "export const ready = true;",
    }, {
      signal: controller.signal,
      toolUseId: "tool-write",
      suggestions: [{
        type: "addDirectories",
        directories: [cwd],
        destination: "localSettings",
      }],
    });
    await waitFor(() => broker.session(sessionId)?.turnState === "waiting");
    await waitFor(() => eventLog.replay().some((event) => event.type === "permission.requested"));
    const [request] = broker.permissionBroker.list(sessionId);
    expect(eventLog.replay().find((event) => event.type === "permission.requested")?.data)
      .toMatchObject({
        requestId: request!.requestId,
        toolName: "Write",
        canAllowAlways: true,
      });

    expect(broker.resolvePermission(
      request!.requestId,
      "allow-always",
      undefined,
      undefined,
      { deviceId: "phone-1", name: "Android 手机" },
    )).toBe(true);
    expect(broker.resolvePermission(request!.requestId, "deny")).toBe(false);
    await expect(pending).resolves.toMatchObject({
      behavior: "allow",
      updatedPermissions: [expect.objectContaining({ destination: "localSettings" })],
    });
    await waitFor(() => eventLog.replay().some((event) => event.type === "permission.resolved"));
    expect(eventLog.replay().find((event) => event.type === "permission.resolved")?.data)
      .toMatchObject({
        requestId: request!.requestId,
        decision: "allow-always",
        resolvedByDeviceId: "phone-1",
        resolvedByName: "Android 手机",
      });
    expect(broker.session(sessionId)?.turnState).toBe("running");

    hosts[0]!.complete();
    await waitFor(() => broker.session(sessionId)?.turnState === "idle");
    await broker.close();
    await eventLog.close();
  });

  it("persists model and effort per session and blocks an unsafe context downgrade", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-broker-config-"));
    directories.push(root);
    const cwd = join(root, "project");
    const projects = join(root, "projects");
    const sessionId = randomUUID();
    const projectDirectory = join(projects, cwd.replace(/[:\\/]/gu, "-"));
    await Promise.all([mkdir(cwd, { recursive: true }), mkdir(projectDirectory, { recursive: true })]);
    await writeFile(join(projectDirectory, `${sessionId}.jsonl`), JSON.stringify({
      type: "assistant",
      uuid: randomUUID(),
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        model: "k3",
        content: "done",
        usage: {
          input_tokens: 1_000,
          cache_read_input_tokens: 300_000,
          cache_creation_input_tokens: 0,
        },
      },
    }));
    const observer = new FakeObserver({
      projects: [],
      sessions: [observed(sessionId, cwd)],
      observedAt: Date.now(),
    });
    const hosts: FakeHost[] = [];
    const eventLog = new SessionEventLog(join(root, "events.jsonl"));
    const sessionsPath = join(root, "sessions.json");
    const broker = new SessionBroker({
      paths: {
        sessions: join(root, "runtime-sessions"),
        tasks: join(root, "tasks"),
        projects,
        desktopSessions: [],
      },
      eventLog,
      observer,
      sessionsPath,
      queuePath: join(root, "queue.json"),
      hostFactory: (options) => {
        const host = new FakeHost(options);
        hosts.push(host);
        return host;
      },
      prepareRuntime: async () => ({
        executablePath: "/fake/claude",
        credentialPath: "/fake/host-creds.json",
        environment: {},
      }),
    });
    await broker.initialize();

    await expect(broker.configuration(sessionId)).resolves.toMatchObject({
      model: "claude-fable-5[1m]",
      effort: "high",
      modelsComplete: true,
    });
    await expect(broker.configureSession({
      sessionId,
      effort: "xhigh",
    })).resolves.toMatchObject({
      model: "claude-fable-5[1m]",
      effort: "xhigh",
      effortSource: "bridge",
    });
    expect(hosts[0]?.options.sessionId).not.toBe(sessionId);
    expect(hosts[0]?.closed).toBe(true);
    expect(broker.session(sessionId)).toMatchObject({
      model: "claude-fable-5[1m]",
      effort: "xhigh",
    });
    await expect(broker.configureSession({
      sessionId,
      model: "claude-fable-5",
    })).rejects.toThrow(/301,000 tokens/u);
    const saved = JSON.parse(await readFile(sessionsPath, "utf8")) as {
      configurations: Array<{ sessionId: string; model?: string; effort?: BridgeEffort; updatedAt: number }>;
    };
    expect(saved.configurations).toEqual([
      expect.objectContaining({ sessionId, effort: "xhigh" }),
    ]);

    await broker.close();
    await eventLog.close();
  });

  it("preserves per-session mobile configurations across Desktop registration, default changes, and cliSessionId rotation", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-broker-desktop-config-"));
    directories.push(root);
    const cwd = join(root, "project");
    const sessionA = randomUUID();
    const sessionB = randomUUID();
    const desktopSessions = join(root, "Claude-3p", "claude-code-sessions");
    await mkdir(desktopSessions, { recursive: true });
    const desktopPathA = join(desktopSessions, `local_${sessionA}.json`);
    const desktopPathB = join(desktopSessions, `local_${sessionB}.json`);
    await writeFile(desktopPathA, JSON.stringify({
      sessionId: `local_${sessionA}`, cliSessionId: sessionA, cwd,
      model: "desktop-default", effort: "xhigh",
    }));
    const sessionsPath = join(root, "sessions.json");
    const observer = new FakeObserver({
      projects: [],
      sessions: [
        observed(sessionA, cwd, { desktopSessionId: `local_${sessionA}`, hostModel: "desktop-default", hostEffort: "xhigh" }),
      ],
      observedAt: 1,
    });
    const eventLog = new SessionEventLog(join(root, "events.jsonl"));
    const options = {
      paths: { sessions: join(root, "runtime"), tasks: join(root, "tasks"), projects: join(root, "projects"), desktopSessions: [desktopSessions] },
      eventLog, observer, sessionsPath, queuePath: join(root, "queue.json"),
      discoverGatewayModels: async () => [
        { value: "desktop-default", displayName: "Desktop default" },
        { value: "mobile-model-a", displayName: "Mobile Model A" },
        { value: "mobile-model-b", displayName: "Mobile Model B" },
      ],
      prepareRuntime: async () => ({ executablePath: "/fake/claude", credentialPath: "/fake/creds.json", environment: {} }),
    };
    const broker = new SessionBroker(options);
    try {
      await broker.initialize();
      const createdB = await broker.createSession(cwd, "Session B");
      expect(createdB.sessionId).toBeDefined();

      // Configure Session B before local_<id>.json exists in Claude Desktop, and Session A while local_<id>.json exists.
      await expect(broker.configureSession({
        sessionId: createdB.sessionId,
        model: "mobile-model-b",
        effort: "low",
      })).resolves.toMatchObject({
        model: "mobile-model-b",
        effort: "low",
        modelSource: "bridge",
        effortSource: "bridge",
      });
      await expect(broker.configureSession({
        sessionId: sessionA,
        model: "mobile-model-a",
        effort: "medium",
      })).resolves.toMatchObject({
        model: "mobile-model-a",
        effort: "medium",
        modelSource: "bridge",
        effortSource: "bridge",
      });

      // Claude Desktop later adopts Session B with Desktop's default model and changes Session A's Desktop metadata.
      await writeFile(join(desktopSessions, `local_${createdB.sessionId}.json`), JSON.stringify({
        sessionId: `local_${createdB.sessionId}`,
        cliSessionId: createdB.sessionId,
        cwd,
        model: "desktop-default",
      }));
      await writeFile(desktopPathA, JSON.stringify({
        sessionId: `local_${sessionA}`,
        cliSessionId: sessionA,
        cwd,
        model: "desktop-changed",
        effort: "high",
      }));

      // Reopening both sessions and restarting Bridge must keep each session's independent mobile configuration.
      await expect(broker.configuration(createdB.sessionId)).resolves.toMatchObject({
        model: "mobile-model-b",
        effort: "low",
        inheritedModel: "desktop-default",
        modelSource: "bridge",
        effortSource: "bridge",
      });
      await expect(broker.configuration(sessionA)).resolves.toMatchObject({
        model: "mobile-model-a",
        effort: "medium",
        inheritedModel: "desktop-changed",
        inheritedEffort: "high",
        modelSource: "bridge",
        effortSource: "bridge",
      });

      await broker.close();
      const restarted = new SessionBroker(options);
      try {
        await restarted.initialize();
        await expect(restarted.configuration(createdB.sessionId)).resolves.toMatchObject({
          model: "mobile-model-b",
          effort: "low",
          modelSource: "bridge",
          effortSource: "bridge",
        });
        await expect(restarted.configuration(sessionA)).resolves.toMatchObject({
          model: "mobile-model-a",
          effort: "medium",
          modelSource: "bridge",
          effortSource: "bridge",
        });

        // Rotating cliSessionId in Claude Desktop (with priorCliSessionIds) carries over Session B's configuration.
        const rotatedB = randomUUID();
        await writeFile(desktopPathB, JSON.stringify({
          sessionId: `local_${createdB.sessionId}`,
          cliSessionId: rotatedB,
          priorCliSessionIds: [createdB.sessionId],
          cwd,
          model: "desktop-default",
          effort: "xhigh",
        }));
        observer.catalog.sessions = [
          observed(sessionA, cwd, { desktopSessionId: `local_${sessionA}`, hostModel: "desktop-changed", hostEffort: "high" }),
          observed(rotatedB, cwd, {
            desktopSessionId: `local_${createdB.sessionId}`,
            priorSessionIds: [createdB.sessionId],
            hostModel: "desktop-default",
            hostEffort: "xhigh",
          }),
        ];
        observer.publish();
        await expect(restarted.configuration(rotatedB)).resolves.toMatchObject({
          model: "mobile-model-b",
          effort: "low",
          modelSource: "bridge",
          effortSource: "bridge",
        });
        expect(restarted.listSessions().some((candidate) => candidate.sessionId === createdB.sessionId)).toBe(false);

        // Explicit reset ("跟随 Claude Desktop") clears the mobile override and follows Desktop.
        await expect(restarted.configureSession({
          sessionId: sessionA,
          model: null,
          effort: null,
        })).resolves.toMatchObject({
          model: "desktop-changed",
          effort: "high",
          modelSource: "claude-desktop",
          effortSource: "claude-desktop",
        });
      } finally { await restarted.close(); }
    } finally {
      await broker.close();
      await eventLog.close();
    }
  });

  it("refreshes inherited Desktop settings even when they equal the Bridge override", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-broker-inherited-config-"));
    directories.push(root);
    const cwd = join(root, "project");
    const sessionId = randomUUID();
    const desktopSessions = join(root, "desktop");
    await mkdir(desktopSessions, { recursive: true });
    const metadata = join(desktopSessions, `local_${sessionId}.json`);
    await writeFile(metadata, JSON.stringify({ sessionId: `local_${sessionId}`, cliSessionId: sessionId, cwd, model: "desktop-old", effort: "high" }));
    const eventLog = new SessionEventLog(join(root, "events.jsonl"));
    const broker = new SessionBroker({
      paths: { sessions: join(root, "runtime"), tasks: join(root, "tasks"), projects: join(root, "projects"), desktopSessions: [desktopSessions] },
      observer: new FakeObserver({ projects: [], sessions: [observed(sessionId, cwd, { desktopSessionId: `local_${sessionId}`, hostModel: "desktop-old" })], observedAt: 1 }),
      eventLog, sessionsPath: join(root, "sessions.json"), queuePath: join(root, "queue.json"),
      discoverGatewayModels: async () => [{ value: "mobile-model", displayName: "Mobile model" }],
      prepareRuntime: async () => ({ executablePath: "/fake/claude", credentialPath: "/fake/creds.json", environment: {} }),
    });
    try {
      await broker.initialize();
      await broker.configureSession({ sessionId, model: "mobile-model", effort: "low" });
      await writeFile(metadata, JSON.stringify({ sessionId: `local_${sessionId}`, cliSessionId: sessionId, cwd, model: "mobile-model", effort: "low" }));
      await expect(broker.configuration(sessionId, false)).resolves.toMatchObject({
        model: "mobile-model", inheritedModel: "mobile-model", inheritedEffort: "low", modelSource: "bridge",
      });
      await expect(broker.configureSession({ sessionId, model: null, effort: null })).resolves.toMatchObject({
        model: "mobile-model", effort: "low", modelSource: "claude-desktop", effortSource: "claude-desktop",
      });
    } finally { await broker.close(); await eventLog.close(); }
  });

  it("keeps selected 1M model capabilities when deriving the long-context catalog entry", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-broker-derived-model-"));
    directories.push(root);
    const sessionId = randomUUID();
    const cwd = join(root, "project");
    const eventLog = new SessionEventLog(join(root, "events.jsonl"));
    const broker = new SessionBroker({
      paths: { sessions: join(root, "runtime"), tasks: join(root, "tasks"), projects: join(root, "projects"), desktopSessions: [] },
      observer: new FakeObserver({ projects: [], sessions: [observed(sessionId, cwd, { hostModel: "claude-sonnet-4-6[1m]" })], observedAt: 1 }),
      eventLog, sessionsPath: join(root, "sessions.json"), queuePath: join(root, "queue.json"),
      discoverGatewayModels: async () => [
        { value: "claude-sonnet-4-6", displayName: "Sonnet 4.6", supportsEffort: true, supportedEffortLevels: ["low", "high"], maxInputTokens: 200_000 },
        { value: "claude-fable-5[1m]", displayName: "Fable 5 1M" },
      ],
      prepareRuntime: async () => ({ executablePath: "/fake/claude", credentialPath: "/fake/creds.json", environment: {} }),
    });
    try {
      await broker.initialize();
      await expect(broker.configuration(sessionId, false)).resolves.toMatchObject({
        availableEffortLevels: ["low", "high"],
        availableModels: expect.arrayContaining([expect.objectContaining({
          value: "claude-sonnet-4-6[1m]", maxInputTokens: 1_000_000,
          supportsEffort: true, supportedEffortLevels: ["low", "high"],
        })]),
      });
    } finally { await broker.close(); await eventLog.close(); }
  });

  it("discovers provider models without attaching to the desktop session", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-broker-discovery-"));
    directories.push(root);
    const cwd = join(root, "project");
    const sessionId = randomUUID();
    await mkdir(cwd, { recursive: true });
    const observer = new FakeObserver({
      projects: [],
      sessions: [observed(sessionId, cwd)],
      observedAt: Date.now(),
    });
    observer.busy = true;
    const hosts: FakeHost[] = [];
    const eventLog = new SessionEventLog(join(root, "events.jsonl"));
    const broker = new SessionBroker({
      paths: {
        sessions: join(root, "runtime-sessions"),
        tasks: join(root, "tasks"),
        projects: join(root, "projects"),
        desktopSessions: [],
      },
      eventLog,
      observer,
      sessionsPath: join(root, "sessions.json"),
      queuePath: join(root, "queue.json"),
      hostFactory: (options) => {
        const host = new FakeHost(options);
        hosts.push(host);
        return host;
      },
      prepareRuntime: async () => ({
        executablePath: "/fake/claude",
        credentialPath: "/fake/host-creds.json",
        environment: {},
      }),
    });
    await broker.initialize();

    await expect(broker.configuration(sessionId)).resolves.toMatchObject({
      model: "claude-fable-5[1m]",
      modelsComplete: true,
    });
    expect(hosts).toHaveLength(1);
    expect(hosts[0]?.options.sessionId).not.toBe(sessionId);
    expect(hosts[0]?.options.cwd).toBe(root);
    expect(hosts[0]?.options.settingSources).toEqual([]);
    expect(hosts[0]?.options.persistSession).toBe(false);
    expect(hosts[0]?.closed).toBe(true);
    expect(broker.session(sessionId)?.ownership).toBe("DESKTOP_OBSERVED");

    await broker.close();
    await eventLog.close();
  });

  it("prefers custom gateway /v1/models catalog and preserves gateway display names across turns", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-broker-gateway-models-"));
    directories.push(root);
    const cwd = join(root, "project");
    const sessionId = randomUUID();
    await mkdir(cwd, { recursive: true });
    const observer = new FakeObserver({
      projects: [],
      sessions: [observed(sessionId, cwd, {
        sourceProfile: "claude-3p",
        hostModel: "gateway-model-alpha[1m]",
        hostEffort: "high",
      })],
      observedAt: Date.now(),
    });
    const hosts: FakeHost[] = [];
    const eventLog = new SessionEventLog(join(root, "events.jsonl"));
    const broker = new SessionBroker({
      paths: {
        sessions: join(root, "runtime-sessions"),
        tasks: join(root, "tasks"),
        projects: join(root, "projects"),
        desktopSessions: [],
      },
      eventLog,
      observer,
      sessionsPath: join(root, "sessions.json"),
      queuePath: join(root, "queue.json"),
      hostFactory: (options) => {
        const host = new FakeHost(options);
        hosts.push(host);
        return host;
      },
      prepareRuntime: async () => ({
        executablePath: "/fake/claude",
        credentialPath: "/fake/host-creds.json",
        environment: {},
      }),
      discoverGatewayModels: async () => [
        {
          value: "gateway-model-beta",
          displayName: "Claude Sonnet 4.6 · Gateway",
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
        },
        {
          value: "gateway-model-beta[1m]",
          displayName: "Claude Sonnet 4.6 · Gateway 1M",
          description: "1M context window",
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
        },
        {
          value: "gateway-model-alpha",
          displayName: "Claude Opus 4.6 · Gateway",
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
        },
        {
          value: "gateway-model-alpha[1m]",
          displayName: "Claude Opus 4.6 · Gateway 1M",
          description: "1M context window",
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
        },
      ],
    });
    await broker.initialize();

    expect(broker.session(sessionId)).toMatchObject({
      model: "gateway-model-alpha[1m]",
      modelDisplayName: "Claude Opus 4.6 · Gateway 1M",
      effort: "high",
    });

    const config = await broker.configuration(sessionId);
    expect(hosts).toHaveLength(0);
    expect(config).toMatchObject({
      model: "gateway-model-alpha[1m]",
      modelsComplete: true,
      availableModels: [
        expect.objectContaining({
          value: "gateway-model-alpha[1m]",
          displayName: "Claude Opus 4.6 · Gateway 1M",
        }),
        expect.objectContaining({
          value: "gateway-model-beta",
          displayName: "Claude Sonnet 4.6 · Gateway",
        }),
        expect.objectContaining({
          value: "gateway-model-beta[1m]",
          displayName: "Claude Sonnet 4.6 · Gateway 1M",
        }),
        expect.objectContaining({
          value: "gateway-model-alpha",
          displayName: "Claude Opus 4.6 · Gateway",
        }),
      ],
    });

    await broker.close();
    await eventLog.close();
  });

  it("maps synthetic mythos-magpie and magpie.anthropic model IDs to gateway models without exposing raw hashes", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-broker-magpie-models-"));
    directories.push(root);
    const cwd = join(root, "project");
    const sessionId = randomUUID();
    await mkdir(cwd, { recursive: true });
    const observer = new FakeObserver({
      projects: [],
      sessions: [{
        ...observed(sessionId, cwd),
        hostModel: "mythos-magpie-1052229916",
        hostEffort: "xhigh",
        hostUltracode: true,
      }],
      observedAt: Date.now(),
    });
    const eventLog = new SessionEventLog(join(root, "events.jsonl"));
    const broker = new SessionBroker({
      paths: {
        sessions: join(root, "runtime-sessions"),
        tasks: join(root, "tasks"),
        projects: join(root, "projects"),
        desktopSessions: [],
      },
      eventLog,
      observer,
      sessionsPath: join(root, "sessions.json"),
      queuePath: join(root, "queue.json"),
      hostFactory: (options) => new FakeHost(options),
      prepareRuntime: async () => ({
        executablePath: "/usr/local/bin/claude",
        credentialPath: join(root, "host-creds.json"),
        environment: { ANTHROPIC_BASE_URL: "http://127.0.0.1:3425" },
      }),
      discoverGatewayModels: async () => [
        {
          value: "antigravity/gemini-4-argon",
          displayName: "Gemini 4 Argon",
          description: "Gemini 4 Argon · Antigravity",
          maxInputTokens: 1_000_000,
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
        },
        {
          value: "antigravity/gemini-4-argon[1m]",
          displayName: "Gemini 4 Argon 1M",
          description: "Gemini 4 Argon · Antigravity · 1M context window",
          maxInputTokens: 1_000_000,
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
        },
      ],
    });
    await broker.initialize();

    expect(broker.session(sessionId)).toMatchObject({
      model: "mythos-magpie-1052229916",
      modelDisplayName: "Gemini 4 Argon 1M",
      effort: "xhigh",
    });

    const config = await broker.configuration(sessionId);
    expect(config.model).toBe("antigravity/gemini-4-argon[1m]");
    expect(config.availableModels.map((candidate) => candidate.value)).toEqual([
      "antigravity/gemini-4-argon[1m]",
      "antigravity/gemini-4-argon",
    ]);
    expect(config.availableModels.some((candidate) => /magpie/iu.test(candidate.displayName))).toBe(false);

    await broker.close();
    await eventLog.close();
  });

  it("preserves complete Agent SDK tool results in the turn evidence lifecycle", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-broker-evidence-"));
    directories.push(root);
    const cwd = join(root, "project");
    const sessionId = randomUUID();
    await mkdir(cwd, { recursive: true });
    const observer = new FakeObserver({
      projects: [],
      sessions: [observed(sessionId, cwd)],
      observedAt: Date.now(),
    });
    const hosts: FakeHost[] = [];
    const calls: Array<{ type: string; value?: unknown }> = [];
    const eventLog = new SessionEventLog(join(root, "events.jsonl"));
    const broker = new SessionBroker({
      paths: {
        sessions: join(root, "runtime-sessions"),
        tasks: join(root, "tasks"),
        projects: join(root, "projects"),
        desktopSessions: [],
      },
      eventLog,
      observer,
      sessionsPath: join(root, "sessions.json"),
      queuePath: join(root, "queue.json"),
      hostFactory: (options) => {
        const host = new FakeHost(options);
        hosts.push(host);
        return host;
      },
      prepareRuntime: async () => ({
        executablePath: "/fake/claude",
        credentialPath: "/fake/host-creds.json",
        environment: {},
      }),
      evidence: {
        async startBridgeTurn(input) {
          calls.push({ type: "start", value: input });
          return "evidence-1";
        },
        async attachTurn(_evidenceId, turnId) {
          calls.push({ type: "attach", value: turnId });
        },
        async recordToolStarted(input) {
          calls.push({ type: "tool-start", value: input });
        },
        async recordToolCompleted(input) {
          calls.push({ type: "tool-complete", value: input.output });
        },
        async finalizeBridgeTurn(input) {
          calls.push({ type: "finalize", value: input });
          return undefined;
        },
      },
    });
    await broker.initialize();
    await broker.startTurn({
      requestId: "request-1",
      idempotencyKey: "idempotency-1",
      sessionId,
      text: "Run tests",
      origin: "mobile",
    });
    await waitFor(() => hosts.some((host) => host.current));
    const host = hosts.find((candidate) => candidate.options.sessionId === sessionId)!;
    host.runTool("tool-1", {
      exitCode: 1,
      stdout: "full command output",
      stderr: "failed",
    });
    host.complete();
    await waitFor(() => calls.some((call) => call.type === "finalize"));

    expect(calls.map((call) => call.type)).toEqual(expect.arrayContaining([
      "start",
      "attach",
      "tool-start",
      "tool-complete",
      "finalize",
    ]));
    expect(calls.find((call) => call.type === "tool-complete")?.value).toEqual({
      exitCode: 1,
      stdout: "full command output",
      stderr: "failed",
    });
    expect(calls.findIndex((call) => call.type === "start"))
      .toBeLessThan(calls.findIndex((call) => call.type === "attach"));

    await broker.close();
    await eventLog.close();
  });

  it("marks completed-turn permission cleanup without emitting an interruption", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-broker-permission-cleanup-"));
    directories.push(root);
    const sessionId = randomUUID();
    const cwd = join(root, "project");
    const hosts: FakeHost[] = [];
    const eventLog = new SessionEventLog(join(root, "events.jsonl"), 1);
    const broker = new SessionBroker({
      paths: {
        sessions: join(root, "runtime-sessions"),
        tasks: join(root, "tasks"),
        projects: join(root, "projects"),
        desktopSessions: [],
      },
      eventLog,
      observer: new FakeObserver({
        projects: [],
        sessions: [observed(sessionId, cwd)],
        observedAt: Date.now(),
      }),
      sessionsPath: join(root, "sessions.json"),
      queuePath: join(root, "queue.json"),
      hostFactory: (options) => {
        const host = new FakeHost(options);
        hosts.push(host);
        return host;
      },
      prepareRuntime: async () => ({
        executablePath: "/fake/claude",
        credentialPath: "/fake/host-creds.json",
        environment: {},
      }),
    });
    await broker.initialize();
    await broker.startTurn({
      requestId: "request-cleanup",
      idempotencyKey: "idempotency-cleanup",
      sessionId,
      text: "Complete after requesting tools",
      origin: "mobile",
    });
    await waitFor(() => hosts.some((host) => host.current));
    const pending = broker.permissionBroker.request(sessionId, "Bash", { command: "npm test" }, {
      signal: new AbortController().signal,
      toolUseId: "tool-cleanup",
    });
    hosts.find((host) => host.options.sessionId === sessionId)!.complete();
    await expect(pending).resolves.toMatchObject({ behavior: "deny" });
    await broker.close();

    const events = eventLog.replay(0, 100, sessionId);
    expect(events.some((event) => event.type === "turn.completed")).toBe(true);
    expect(events.some((event) => event.type === "turn.interrupted")).toBe(false);
    expect(events.find((event) => event.type === "permission.resolved")?.data).toMatchObject({
      decision: "deny",
      automatic: true,
      reason: "turn-finished",
    });
    await eventLog.close();
  });

  it("persists a per-session permission override and can restore the computer default", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-broker-permission-policy-"));
    directories.push(root);
    const sessionId = randomUUID();
    const cwd = join(root, "project");
    const sessionsPath = join(root, "sessions.json");
    const observer = new FakeObserver({
      projects: [],
      sessions: [observed(sessionId, cwd)],
      observedAt: Date.now(),
    });
    const options = {
      paths: {
        sessions: join(root, "runtime-sessions"),
        tasks: join(root, "tasks"),
        projects: join(root, "projects"),
        desktopSessions: [],
      },
      observer,
      sessionsPath,
      queuePath: join(root, "queue.json"),
      prepareRuntime: async () => ({
        executablePath: "/fake/claude",
        credentialPath: "/fake/host-creds.json",
        environment: {},
      }),
    };
    const firstLog = new SessionEventLog(join(root, "events-first.jsonl"), 1);
    const broker = new SessionBroker({ ...options, eventLog: firstLog });
    broker.setDefaultPermissionMode("full-access");
    await broker.initialize();

    expect((await broker.configuration(sessionId, false)).permissionPolicy).toMatchObject({
      hostMode: "full-access",
      effectiveMode: "full-access",
      source: "host",
    });
    await expect(broker.permissionBroker.request(
      sessionId,
      "Write",
      { file_path: join(cwd, "full-access.txt") },
      { signal: new AbortController().signal, toolUseId: "policy-tool" },
    )).resolves.toMatchObject({ behavior: "allow" });
    const overridden = await broker.configurePermissionPolicy(sessionId, "standard");
    expect(overridden.configuration.permissionPolicy).toMatchObject({
      hostMode: "full-access",
      sessionMode: "standard",
      effectiveMode: "standard",
      source: "session",
    });
    await broker.close();
    const automaticApproval = firstLog.replay(0, 100, sessionId)
      .find((event) => event.type === "permission.resolved");
    expect(automaticApproval?.data).toMatchObject({
      toolUseId: "policy-tool",
      toolName: "Write",
      input: { file_path: join(cwd, "full-access.txt") },
      automatic: true,
      reason: "policy-full-access",
    });
    expect(firstLog.replay(0, 100, sessionId)
      .some((event) => event.type === "permission.requested")).toBe(false);
    await firstLog.close();

    const secondLog = new SessionEventLog(join(root, "events-second.jsonl"), 1);
    const restarted = new SessionBroker({ ...options, eventLog: secondLog });
    restarted.setDefaultPermissionMode("full-access");
    await restarted.initialize();
    expect((await restarted.configuration(sessionId, false)).permissionPolicy?.sessionMode).toBe("standard");

    const inherited = await restarted.configurePermissionPolicy(sessionId, null);
    expect(inherited.configuration.permissionPolicy).toEqual({
      hostMode: "full-access",
      effectiveMode: "full-access",
      source: "host",
    });
    const saved = JSON.parse(await readFile(sessionsPath, "utf8")) as {
      configurations?: Array<{ sessionId: string; permissionMode?: string }>;
    };
    expect(saved.configurations?.find((configuration) => configuration.sessionId === sessionId))
      .toBeUndefined();

    await restarted.close();
    await secondLog.close();
  });

  it.each(["\n", ""])("forks an existing session with copied transcript history and trailing %j", async (ending) => {
    const root = await mkdtemp(join(tmpdir(), "bridge-broker-fork-"));
    directories.push(root);
    const sessionId = randomUUID();
    const cwd = join(root, "project");
    const projectsRoot = join(root, "projects");
    await mkdir(projectsRoot, { recursive: true });
    await writeFile(join(projectsRoot, `${sessionId}.jsonl`), [
      JSON.stringify({
        uuid: "u-1",
        type: "user",
        sessionId,
        cwd,
        timestamp: "2026-10-25T08:00:00.000Z",
        message: { role: "user", content: "原始问题" },
      }),
      JSON.stringify({
        uuid: "a-1",
        parentUuid: "u-1",
        type: "assistant",
        sessionId,
        cwd,
        timestamp: "2026-10-25T08:00:02.000Z",
        message: {
          role: "assistant",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "原始回答" }],
        },
      }),
    ].join("\n") + ending);

    const registeredInputs: unknown[] = [];
    const eventLog = new SessionEventLog(join(root, "events.jsonl"), 1);
    const parentObs = {
      ...observed(sessionId, cwd),
      title: "第四章叙事与分析设计讨论",
      desktopSessionId: "local_parent_01",
      hostModel: "claude-opus-5-5[1m]",
      hostEffort: "xhigh" as const,
    };
    const broker = new SessionBroker({
      paths: {
        sessions: join(root, "runtime-sessions"),
        tasks: join(root, "tasks"),
        projects: projectsRoot,
        desktopSessions: [],
      },
      eventLog,
      observer: new FakeObserver({
        projects: [],
        sessions: [parentObs],
        observedAt: Date.now(),
      }),
      sessionsPath: join(root, "sessions.json"),
      queuePath: join(root, "queue.json"),
      desktopRegistrar: {
        async register(input) {
          registeredInputs.push(input);
          return {
            state: "registered",
            detail: "registered",
            desktopSessionId: `local_${input.sessionId}`,
            registeredAt: Date.now(),
            updatedAt: Date.now(),
          };
        },
        publicInfo(value) {
          return value;
        },
        changed(left, right) {
          return JSON.stringify(left) !== JSON.stringify(right);
        },
      },
      prepareRuntime: async () => ({
        executablePath: "/fake/claude",
        credentialPath: "/fake/host-creds.json",
        environment: {},
      }),
    });
    await broker.initialize();

    const fullReads = vi.mocked(readFile).mockClear();
    const fork1 = await broker.forkSession(sessionId);
    const fork2 = await broker.forkSession(sessionId);
    expect(fullReads.mock.calls.filter(([path]) => String(path).endsWith(".jsonl"))).toEqual([]);
    expect((await stat(join(projectsRoot, `${fork1.sessionId}.jsonl`))).mode & 0o777).toBe(0o600);

    expect(fork1).toMatchObject({
      parentSessionId: sessionId,
      forkLabel: "fork",
      title: "第四章叙事与分析设计讨论 (fork)",
      model: "claude-opus-5-5[1m]",
      effort: "xhigh",
    });
    expect(fork2).toMatchObject({
      parentSessionId: sessionId,
      forkLabel: "fork-2",
      title: "第四章叙事与分析设计讨论 (fork)",
    });
    expect(registeredInputs[0]).toMatchObject({
      sessionId: fork1.sessionId,
      parentDesktopSessionId: "local_parent_01",
      forkLabel: "fork",
    });

    const nested = await broker.forkSession(fork1.sessionId, "Gemini 绘图");
    expect(nested).toMatchObject({
      parentSessionId: fork1.sessionId,
      title: "Gemini 绘图",
      forkLabel: "fork",
    });
    expect(registeredInputs.at(-1)).toMatchObject({
      sessionId: nested.sessionId,
      parentDesktopSessionId: `local_${fork1.sessionId}`,
    });

    const history = await broker.history(fork1.sessionId);
    expect(history.items.map((item) => ({ role: item.role, text: item.text }))).toEqual([
      { role: "user", text: "原始问题" },
      { role: "assistant", text: "原始回答" },
    ]);

    await broker.close();
    await eventLog.close();
  });
});
