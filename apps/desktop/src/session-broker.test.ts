import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { access, appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BridgeDesktopRegistrationInfo, BridgeEffort, BridgeModelInfo, DesktopControlSnapshot } from "@bridge/protocol";
import type { ModelInfo, SDKControlGetContextUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeSessionHostOptions, SessionHostEvent } from "./claude-session-host.js";
import type { DesktopSessionRegistrationInput, StoredDesktopRegistration } from "./claude-desktop-session-registrar.js";
import { projectIdForCwd, type ClaudeCatalogSnapshot, type ObservedClaudeSession } from "./claude-session-catalog.js";
import { ConversationStateStore } from "./conversation-state-store.js";
import {
  SessionBroker,
  type SessionHostRuntime,
  type TranscriptObserverRuntime,
} from "./session-broker.js";
import { DesktopController } from "./controller.js";
import { SessionEventLog } from "./session-event-log.js";
import { TranscriptObserver } from "./transcript-observer.js";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
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

  isMainTurnBusy(): boolean {
    return this.busy;
  }

  runningSubagents(): undefined {
    return undefined;
  }

  markSubagentStopped(): void {}

  applySubagentStops<T>(subagents: T): T {
    return subagents;
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

  async stopTask(): Promise<void> {}

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
  it("projects persistent titles ahead of Desktop titles without modifying source history, activity or ownership", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-broker-titles-"));
    directories.push(root);
    const cwd = join(root, "project"), projects = join(root, "projects"), sessionId = randomUUID();
    await mkdir(cwd);
    await mkdir(projects);
    const transcript = join(projects, `${sessionId}.jsonl`);
    await writeFile(transcript, JSON.stringify({ type: "assistant", uuid: randomUUID(), parentUuid: null, sessionId, cwd, timestamp: "2026-11-01T00:00:00Z", message: { role: "assistant", stop_reason: "end_turn", content: "Fixture answer" } }) + "\n");
    const beforeFile = await readFile(transcript), beforeStat = await stat(transcript);
    const state = new ConversationStateStore({ databasePath: join(root, "state.sqlite"), sessionsPath: join(root, "sessions.json"), queuePath: join(root, "queue.json"), masterSecret: "title-test" });
    const observer = new FakeObserver({ projects: [], observedAt: 1, sessions: [
      observed(sessionId, cwd, { desktopTitle: "Desktop 标题", title: "日志标题", lastActivityAt: 100, parentSessionId: "ancestor", forkLabel: "fork" }),
      observed(randomUUID(), cwd, { lastActivityAt: 200 }),
    ] });
    observer.busy = true;
    const hostFactory = vi.fn(() => { throw new Error("Rename must not start a host"); });
    const register = vi.fn(async () => ({ state: "registered" as const, detail: "Fixture", updatedAt: 1 }));
    const eventLog = new SessionEventLog(join(root, "events.jsonl"));
    const options = {
      paths: { sessions: join(root, "runtime"), tasks: join(root, "tasks"), projects, desktopSessions: [] },
      eventLog, observer, conversationState: state, sessionsPath: join(root, "sessions.json"), queuePath: join(root, "queue.json"),
      hostFactory, prepareRuntime: async () => ({ environment: {} }),
      desktopRegistrar: { register, publicInfo: (value: StoredDesktopRegistration) => value, changed: () => false },
    };
    let broker = new SessionBroker(options);
    try {
      await broker.initialize();
      const before = broker.listSessions();
      const rename = "手机项目名称";
      state.setSessionTitle(sessionId, rename);
      observer.catalog.sessions[0]!.desktopTitle = "Desktop 后续标题";
      observer.publish();
      expect(broker.listSessions()).toEqual(before.map(session => session.sessionId === sessionId ? { ...session, title: rename } : session));
      expect(broker.session(sessionId)?.title).toBe(rename);
      expect(broker.listSessions(undefined, rename).map(session => session.sessionId)).toEqual([sessionId]);
      expect(broker.listSessions(undefined, "Desktop 后续标题")).toEqual([]);
      expect(state.loadBrokerState().sessions).toEqual([]);
      expect(register).not.toHaveBeenCalled();
      expect(hostFactory).not.toHaveBeenCalled();
      expect(await readFile(transcript)).toEqual(beforeFile);
      expect((await stat(transcript)).mtimeMs).toBe(beforeStat.mtimeMs);
      await broker.close();
      state.close();
      broker = new SessionBroker(options);
      await broker.initialize();
      expect(broker.session(sessionId)).toEqual({ ...before.find(session => session.sessionId === sessionId), title: rename });
      const fork = await broker.forkSession(sessionId);
      expect(fork.title).toBe(`${rename} (fork)`);
      expect(fork.parentSessionId).toBe(sessionId);
      expect(state.sessionTitle(fork.sessionId)).toBeUndefined();
      expect(await readFile(transcript)).toEqual(beforeFile);
      expect((await stat(transcript)).mtimeMs).toBe(beforeStat.mtimeMs);
      expect(hostFactory).not.toHaveBeenCalled();
    } finally { await broker.close(); await eventLog.close(); state.close(); }
  });

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

  it.each([false, true])("preserves an explicitly selected group sharing a directory across restart (sqlite=%s)", async (sqlite) => {
    const root = await mkdtemp(join(tmpdir(), "bridge-broker-group-"));
    directories.push(root);
    const cwd = join(root, "shared");
    const sessionsRoot = join(root, "Claude-3p", "claude-code-sessions");
    await mkdir(cwd);
    await mkdir(sessionsRoot, { recursive: true });
    await writeFile(join(root, "Claude-3p", "claude_desktop_config.json"), JSON.stringify({ preferences: { epitaxyPrefs: {
      "dframe-group-scopes": { account: { groups: [{ id: "cg-server", name: "服务器管理" }], assignments: {} } },
    } } }));
    const observer = new FakeObserver({
      projects: [], observedAt: 1,
      sessions: [
        observed(randomUUID(), cwd, { projectId: projectIdForCwd(cwd), projectName: "shared" }),
        observed(randomUUID(), join(root, "another-directory"), { projectId: "cg-server", projectName: "服务器管理" }),
        observed(randomUUID(), cwd, { projectId: "cg-server", projectName: "服务器管理" }),
      ],
    });
    observer.catalog.desktopMetadataPaths = new Map(observer.catalog.sessions.map(session => [
      session.sessionId, join(sessionsRoot, "device", "account", `local_${session.sessionId}.json`),
    ]));
    const eventLog = new SessionEventLog(join(root, "events.jsonl"), 1);
    const stateOptions = {
      databasePath: join(root, "state.sqlite"), sessionsPath: join(root, "sessions.json"),
      queuePath: join(root, "queue.json"), masterSecret: "group-creation-test",
    };
    let state = sqlite ? new ConversationStateStore(stateOptions) : undefined;
    const options = {
      paths: { sessions: join(root, "runtime"), tasks: join(root, "tasks"), projects: join(root, "projects"), desktopSessions: [sessionsRoot] },
      eventLog, observer, sessionsPath: stateOptions.sessionsPath, queuePath: stateOptions.queuePath,
      prepareRuntime: async () => ({ environment: {} }),
      hostFactory: () => { throw new Error("Group creation must not start a model host"); },
      desktopRegistrar: {
        register: vi.fn(async (_input: unknown, previous?: StoredDesktopRegistration): Promise<StoredDesktopRegistration> => ({
          state: "registered", detail: "Registered", updatedAt: 1,
          groupAssignment: previous?.groupAssignment ?? "saved",
        })),
        publicInfo: (value: StoredDesktopRegistration): BridgeDesktopRegistrationInfo => ({
          state: value.state, detail: value.detail, updatedAt: value.updatedAt,
        }),
        changed: (left: StoredDesktopRegistration | undefined, right: StoredDesktopRegistration) => JSON.stringify(left) !== JSON.stringify(right),
      },
    };
    let broker = new SessionBroker({ ...options, ...(state ? { conversationState: state } : {}) });
    try {
      await broker.initialize();
      const created = await broker.createSession(cwd, "Grouped", "cg-server");
      expect(created).toMatchObject({ cwd, projectId: "cg-server", projectName: "服务器管理" });
      expect(broker.listSessions("cg-server").map(session => session.sessionId)).toContain(created.sessionId);
      expect(broker.listProjects().find(project => project.projectId === "cg-server")?.sessionCount).toBe(3);

      // A process-only observation and a not-yet-grouped Desktop record must not erase creation intent.
      const processOnly = observed(created.sessionId, cwd, { projectId: projectIdForCwd(cwd), projectName: "shared" });
      delete processOnly.desktopSessionId;
      observer.catalog.sessions.push(processOnly);
      observer.publish();
      expect(broker.session(created.sessionId)).toMatchObject({ projectId: "cg-server", projectName: "服务器管理" });
      processOnly.desktopSessionId = `local_${created.sessionId}`;
      observer.publish();
      expect(broker.session(created.sessionId)).toMatchObject({ projectId: "cg-server", projectName: "服务器管理" });

      await broker.close();
      state?.close();
      observer.catalog.sessions = [];
      state = sqlite ? new ConversationStateStore(stateOptions) : undefined;
      broker = new SessionBroker({ ...options, ...(state ? { conversationState: state } : {}) });
      await broker.initialize();
      expect(broker.session(created.sessionId)).toMatchObject({ cwd, projectId: "cg-server", projectName: "服务器管理" });
      await broker.registerDesktopSession(created.sessionId);
      expect(options.desktopRegistrar.register).toHaveBeenLastCalledWith(expect.objectContaining({
        groupId: "cg-server", groupSessionsRoot: sessionsRoot, groupScope: "account",
      }), expect.anything());
      const count = broker.listSessions().length;
      await expect(broker.createSession(cwd, "Unknown", "cg-missing")).rejects.toThrow(/project/iu);
      await expect(broker.createSession(join(root, "wrong"), "Missing directory", "cg-server")).rejects.toThrow(/ENOENT/u);
      expect(broker.listSessions()).toHaveLength(count);
      expect(await broker.createSession(cwd, "Legacy request")).toMatchObject({
        projectId: projectIdForCwd(cwd), projectName: "shared",
      });
      expect(options.desktopRegistrar.register).toHaveBeenCalledWith(expect.objectContaining({ groupId: "cg-server" }), expect.anything());
      options.desktopRegistrar.register.mockRejectedValueOnce(new Error("Group registration unavailable"));
      await broker.registerDesktopSession(created.sessionId);
      expect(broker.session(created.sessionId)).toMatchObject({ projectId: "cg-server", desktopRegistration: { state: "failed" } });
      observer.catalog.sessions.push(processOnly);
      observer.publish();
      await broker.registerDesktopSession(created.sessionId);
      expect(broker.session(created.sessionId)?.projectId).toBe("cg-server");

      processOnly.projectId = "cg-server";
      processOnly.projectName = "Renamed server group";
      observer.publish();
      await broker.registerDesktopSession(created.sessionId);
      expect(broker.session(created.sessionId)?.projectName).toBe("Renamed server group");
      processOnly.projectId = "cg-other";
      processOnly.projectName = "Moved in Desktop";
      observer.publish();
      expect(broker.session(created.sessionId)).toMatchObject({ projectId: "cg-other", projectName: "Moved in Desktop" });
      processOnly.projectId = projectIdForCwd(cwd);
      processOnly.projectName = "shared";
      observer.publish();
      expect(broker.session(created.sessionId)).toMatchObject({ projectId: projectIdForCwd(cwd), projectName: "shared" });
      await broker.close();
      state?.close();
      observer.catalog.sessions = [];
      state = sqlite ? new ConversationStateStore(stateOptions) : undefined;
      broker = new SessionBroker({ ...options, ...(state ? { conversationState: state } : {}) });
      await broker.initialize();
      expect(broker.session(created.sessionId)).toMatchObject({ projectId: projectIdForCwd(cwd), projectName: "shared" });
    } finally {
      await broker.close();
      state?.close();
      await eventLog.close();
    }
  });

  it("requires a real accessible directory even when a project was previously discovered", async () => {
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
    await expect(broker.createSession(cwd, "Missing project")).rejects.toThrow(/ENOENT/u);
    await mkdir(cwd, { recursive: true });
    const created = await broker.createSession(cwd, "Explicit project");
    expect(created).toMatchObject({
      cwd,
      title: "Explicit project",
      source: "bridge",
      ownership: "BRIDGE_IDLE",
    });
    await expect(broker.createSession(join(root, "Documents", "unknown")))
      .rejects.toThrow(/ENOENT/u);

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
    await mkdir(cwd);
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

  it("updates native registration when phone session settings or host permissions change", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-broker-native-settings-"));
    directories.push(root);
    const cwd = join(root, "project");
    const eventLog = new SessionEventLog(join(root, "events.jsonl"), 1);
    const register = vi.fn(async (_input: DesktopSessionRegistrationInput): Promise<StoredDesktopRegistration> => ({ state: "registered", detail: "Registered", updatedAt: Date.now() }));
    const broker = new SessionBroker({
      paths: { sessions: join(root, "runtime-sessions"), tasks: join(root, "tasks"), projects: join(root, "projects"), desktopSessions: [] },
      eventLog, observer: new FakeObserver({ projects: [], sessions: [observed(randomUUID(), cwd)], observedAt: Date.now() }),
      sessionsPath: join(root, "sessions.json"), queuePath: join(root, "queue.json"),
      desktopRegistrar: { register, changed: () => true, publicInfo: value => value },
      discoverGatewayModels: async () => [{ value: "codex/gpt-6.1-sol", displayName: "Selected model" }],
      prepareRuntime: async () => ({ executablePath: "/fake/claude", credentialPath: "/fake/creds.json", environment: {} }),
    });
    await broker.initialize();
    try {
      broker.setDefaultPermissionMode("full-access");
      await mkdir(cwd);
      const session = await broker.createSession(cwd, "Created on phone");
      expect(register).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: session.sessionId, permissionMode: "full-access" }), undefined);
      await broker.configureSession({ sessionId: session.sessionId, model: "codex/gpt-6.1-sol", effort: "high" });
      await broker.registerDesktopSession(session.sessionId);
      expect(register).toHaveBeenLastCalledWith(expect.objectContaining({ overrideModel: "codex/gpt-6.1-sol", overrideEffort: "high", permissionMode: "full-access" }), expect.any(Object));
      register.mockClear();
      await broker.configurePermissionPolicy(session.sessionId, "standard");
      expect(register).toHaveBeenLastCalledWith(expect.objectContaining({ permissionMode: "standard" }), expect.any(Object));
      await broker.configurePermissionPolicy(session.sessionId, null);
      expect(register).toHaveBeenLastCalledWith(expect.objectContaining({ permissionMode: "full-access" }), expect.any(Object));
      register.mockClear();
      broker.setDefaultPermissionMode("standard");
      await waitFor(() => register.mock.calls.some(([input]) => input.permissionMode === "standard"));
    } finally {
      await broker.close();
      await eventLog.close();
    }
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

  it("waits for the Desktop executor to exit even after its main turn becomes idle", async () => {
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
    const acquiringStages: Array<string | undefined> = [];
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
        acquiringStages.push(broker.session(sessionId)?.executionStage);
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
    const waitingStages: Array<string | undefined> = [];
    broker.on("changed", () => {
      const session = broker.session(sessionId);
      if (session?.ownership === "DESKTOP_OBSERVED" && session.turnState === "queued") waitingStages.push(session.executionStage);
    });
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
    expect(waitingStages.length).toBeGreaterThan(0);
    expect(waitingStages).not.toContain("starting");

    observer.bridgeCanStart = true;
    observer.publish();
    expect(broker.session(sessionId)?.desktopHandoff?.state).toBe("close-desktop");
    expect(hosts).toHaveLength(0);
    desktopSession.desktopProcessAlive = false;
    desktopSession.processAlive = false;
    desktopSession.activeProcesses = [];
    observer.publish();
    await waitFor(() => {
      const session = broker.session(sessionId);
      return hosts[0]?.sends === 1 && session?.ownership === "BRIDGE_RUNNING" && session.turnState === "running" && session.executionStage === "running";
    });
    expect(desktopSession.desktopProcessAlive).toBe(false);
    expect(acquiringStages).toEqual(["starting"]);
    expect(broker.session(sessionId)).toMatchObject({
      ownership: "BRIDGE_RUNNING",
      turnState: "running",
      executionStage: "running",
    });
    await broker.close();
    await eventLog.close();
  });

  it("does not rebroadcast a 144-session catalog on repeated Desktop takeover attempts", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-broker-busy-catalog-"));
    directories.push(root);
    const sessions = Array.from({ length: 144 }, (_, index) => observed(randomUUID(), join(root, `project-${index}`)));
    const sessionId = sessions[0]!.sessionId;
    sessions[0]!.desktopProcessAlive = true;
    const observer = new FakeObserver({ projects: [], sessions, observedAt: Date.now() });
    observer.bridgeCanStart = false;
    const canStart = vi.spyOn(observer, "canStartBridgeHost");
    const hosts: FakeHost[] = [];
    const eventLog = new SessionEventLog(join(root, "events.jsonl"));
    const broker = new SessionBroker({
      paths: { sessions: join(root, "runtime-sessions"), tasks: join(root, "tasks"), projects: join(root, "projects"), desktopSessions: [] },
      eventLog, observer, sessionsPath: join(root, "sessions.json"), queuePath: join(root, "queue.json"),
      scanSessionProcesses: async () => [],
      hostFactory: (options) => {
        const host = new FakeHost(options);
        hosts.push(host);
        return host;
      },
      prepareRuntime: async () => ({ executablePath: "/fake/claude", credentialPath: "/fake/creds.json", environment: {} }),
    });
    const controller = Object.assign(Object.create(DesktopController.prototype), new EventEmitter(), {
      lastPublishedSessionKey: "", lastPublishedSubagentActivity: new Map<string, number>(),
      snapshot: async () => ({ sessions: broker.listSessions(), latestSeq: eventLog.latestSeq() }) as DesktopControlSnapshot,
      broadcast: vi.fn(async () => undefined),
    });
    const publications: Array<Promise<unknown>> = [];
    broker.on("changed", () => { publications.push(controller.publish()); });
    await broker.initialize();
    try {
      await broker.startTurn({ requestId: "busy", idempotencyKey: "busy", sessionId, text: "Wait for Desktop", origin: "mobile" });
      await waitFor(() => canStart.mock.calls.length > 0);
      await new Promise((resolve) => setTimeout(resolve, 50));
      await Promise.all(publications.splice(0));
      controller.broadcast.mockClear();
      await waitFor(() => canStart.mock.calls.length >= 4, 8_000);
      await new Promise((resolve) => setTimeout(resolve, 50));
      await Promise.all(publications.splice(0));
      expect(controller.broadcast).not.toHaveBeenCalled();
      expect(broker.listSessions()).toHaveLength(144);
      expect(broker.session(sessionId)).toMatchObject({ turnState: "queued", pendingCount: 1 });
      expect(hosts).toHaveLength(0);
      sessions[0]!.desktopProcessAlive = false;
      observer.bridgeCanStart = true;
      observer.publish();
      await waitFor(() => hosts[0]?.sends === 1);
      await (broker as unknown as { eventQueue: Promise<void> }).eventQueue;
      await Promise.all(publications.splice(0));
      expect(controller.broadcast).toHaveBeenCalledWith({
        kind: "snapshot", snapshot: expect.objectContaining({ sessions: expect.arrayContaining([
          expect.objectContaining({ sessionId, executionStage: "running" }),
        ]) }),
      }, true);
      expect(hosts).toHaveLength(1);
      expect(broker.session(sessionId)?.pendingCount).toBe(0);
    } finally {
      await broker.close();
      await Promise.all(publications);
      await eventLog.close();
    }
  }, 15_000);

  it.each([false, true])("keeps the host initialization stage until the session accepts the turn (initialized=%s)", async (initialized) => {
    const root = await mkdtemp(join(tmpdir(), "bridge-broker-stage-"));
    directories.push(root);
    const sessionId = randomUUID();
    const cwd = join(root, "project");
    const eventLog = new SessionEventLog(join(root, "events.jsonl"));
    let host: (FakeHost & { initialized: boolean }) | undefined;
    const broker = new SessionBroker({
      paths: { sessions: join(root, "runtime-sessions"), tasks: join(root, "tasks"), projects: join(root, "projects"), desktopSessions: [] },
      eventLog,
      observer: new FakeObserver({ projects: [], sessions: [observed(sessionId, cwd)], observedAt: Date.now() }),
      sessionsPath: join(root, "sessions.json"), queuePath: join(root, "queue.json"),
      scanSessionProcesses: async () => [],
      hostFactory: (options) => {
        host = Object.assign(new FakeHost(options), { initialized });
        vi.spyOn(host, "send").mockImplementation(() => {
          host!.sends += 1;
          const receipt = { turnId: randomUUID(), messageId: randomUUID() };
          host!.current = receipt;
          return receipt;
        });
        return host;
      },
      prepareRuntime: async () => ({ executablePath: "/fake/claude", credentialPath: "/fake/creds.json", environment: {} }),
    });
    await broker.initialize();
    try {
      await broker.startTurn({ requestId: "stage", idempotencyKey: "stage", sessionId, text: "Continue", origin: "mobile" });
      await waitFor(() => host?.sends === 1);
      expect(broker.session(sessionId)?.executionStage).toBe(initialized ? "submitted" : "starting");
      host!.initialized = true;
      expect(broker.session(sessionId)?.executionStage).toBe("submitted");
      host!.events.emit("event", {
        type: "turn.started", sessionId, turnId: host!.current!.turnId, at: Date.now(),
      } satisfies SessionHostEvent);
      host!.events.emit("event", {
        type: "user.accepted", sessionId, ...host!.current!, text: "Continue", attachments: [], origin: "mobile", at: Date.now(),
      } satisfies SessionHostEvent);
      await waitFor(() => broker.session(sessionId)?.executionStage === "running");
      expect(host!.sends).toBe(1);
    } finally {
      await broker.close();
      await eventLog.close();
    }
  });

  it("resumes the existing transcript only after the completed Desktop executor exits", async () => {
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
      requestId: "request-takeover",
      idempotencyKey: "command-takeover",
      sessionId,
      text: "Continue in the same transcript",
      origin: "mobile",
    });

    await (broker as unknown as { pump(): Promise<void> }).pump();
    expect(hosts).toHaveLength(0);
    expect(broker.session(sessionId)?.desktopHandoff?.state).toBe("close-desktop");
    desktopSession.desktopProcessAlive = false;
    desktopSession.processAlive = false;
    observer.publish();
    await waitFor(() => hosts[0]?.sends === 1);
    expect(hosts[0]!.options).toMatchObject({ sessionId, resume: true });
    expect(broker.session(sessionId)).toMatchObject({
      ownership: "BRIDGE_RUNNING",
      transport: "bridge-host",
    });
    expect(desktopSession.desktopProcessAlive).toBe(false);

    await broker.close();
    await eventLog.close();
  });

  it("keeps a submitted host alive when its transcript precedes SDK acceptance, but stops for a distinct external input", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-broker-self-input-"));
    directories.push(root);
    const paths = { sessions: join(root, "runtime-sessions"), tasks: join(root, "tasks"), projects: join(root, "projects"), desktopSessions: [] };
    await mkdir(paths.projects, { recursive: true });
    const sessionId = randomUUID();
    const transcriptPath = join(paths.projects, `${sessionId}.jsonl`);
    await writeFile(transcriptPath, `${JSON.stringify({ type: "assistant", uuid: "initial-answer", message: { role: "assistant", content: "Done", stop_reason: "end_turn" } })}\n`);
    const desktopSession = observed(sessionId, root, { transcriptPath });
    const observer = new FakeObserver({ sessions: [desktopSession], projects: [], observedAt: Date.now() });
    const eventLog = new SessionEventLog(join(root, "events.jsonl"));
    const transcriptObserver = new TranscriptObserver({ paths, eventLog });
    vi.spyOn(observer, "externalWriteVersion").mockImplementation(() => transcriptObserver.externalWriteVersion(sessionId));
    const observe = async () => {
      await (transcriptObserver as unknown as { observeTranscript(session: ObservedClaudeSession): Promise<void> }).observeTranscript(desktopSession);
      observer.publish();
    };
    const hosts: FakeHost[] = [];
    const broker = new SessionBroker({
      paths, eventLog, observer, sessionsPath: join(root, "sessions.json"), queuePath: join(root, "queue.json"),
      prepareRuntime: async () => ({ executablePath: "/fake/claude", credentialPath: "/fake/creds.json", environment: {} }),
      hostFactory: (options) => {
        const host = new FakeHost(options);
        vi.spyOn(host, "send").mockImplementation(() => {
          host.sends += 1;
          const current = { turnId: randomUUID(), messageId: randomUUID() };
          host.current = current;
          host.events.emit("event", { type: "user.submitted", sessionId, ...current, at: Date.now() });
          return current;
        });
        hosts.push(host);
        return host;
      },
    });
    try {
      await broker.initialize();
      await observe();
      await broker.startTurn({ sessionId, requestId: "request", idempotencyKey: "command", text: "Continue", origin: "mobile" });
      await waitFor(() => Boolean(eventLog.latestItem(sessionId, "message.delivery", hosts[0]?.current?.messageId ?? "")));
      const messageId = hosts[0]!.current!.messageId;
      await appendFile(transcriptPath, `${JSON.stringify({ type: "user", uuid: messageId, parentUuid: "initial-answer", message: { role: "user", content: "Continue" } })}\n`);
      await observe();
      const conflictTasks = (broker as unknown as { conflictTasks: Map<string, Promise<void>> }).conflictTasks;
      await Promise.all(conflictTasks.values());
      expect(eventLog.hasItem(sessionId, "user.message.accepted", messageId)).toBe(false);
      expect(hosts[0]!.closed).toBe(false);
      expect(hosts[0]!.sends).toBe(1);
      expect(eventLog.replay().some(event => event.type === "session.ownership-conflict")).toBe(false);
      expect(eventLog.replay().some(event => event.type === "turn.interrupted")).toBe(false);

      await appendFile(transcriptPath, `${JSON.stringify({ type: "user", uuid: "external-user", parentUuid: messageId, message: { role: "user", content: "Continue" } })}\n`);
      await observe();
      await Promise.all(conflictTasks.values());
      expect(hosts[0]!.closed).toBe(true);
      expect(eventLog.replay().filter(event => event.type === "session.ownership-conflict")).toHaveLength(1);
      expect(eventLog.replay().filter(event => event.type === "turn.interrupted")).toHaveLength(1);
      const replayed = await broker.startTurn({ sessionId, requestId: "retry", idempotencyKey: "command", text: "Continue", origin: "mobile" });
      expect(replayed.state).toBe("cancelled");
      expect(hosts).toHaveLength(1);
      expect(hosts[0]!.sends).toBe(1);
    } finally {
      await broker.close();
      await transcriptObserver.close();
      await eventLog.close();
    }
  });

  it("contains a competing writer without resending an already submitted command", async () => {
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
        session.turnState === "waiting" &&
        session.pendingCount === 0
      );
    });
    await Promise.all((broker as unknown as { conflictTasks: Map<string, Promise<void>> }).conflictTasks.values());
    expect(hosts[0]?.interrupts).toBe(0);
    expect(hosts).toHaveLength(1);
    expect(broker.session(sessionId)).toMatchObject({
      ownership: "OWNERSHIP_CONFLICT",
      turnState: "waiting",
      pendingCount: 0,
    });
    expect(eventLog.replay().filter((event) => (
      event.sessionId === sessionId && event.type === "turn.interrupted"
    ))).toHaveLength(1);
    expect(eventLog.replay().filter((event) => (
      event.sessionId === sessionId && event.type === "session.ownership-conflict"
    ))).toHaveLength(1);
    expect(eventLog.replay().some((event) => event.type === "turn.queued" && event.data.retrying)).toBe(false);

    desktopSession.desktopProcessAlive = false;
    desktopSession.bridgeProcessAlive = false;
    desktopSession.processAlive = false;
    desktopSession.processOverlap = false;
    desktopSession.activeProcesses = [];
    observer.publish();
    await (broker as unknown as {pump():Promise<void>}).pump();
    expect(hosts).toHaveLength(1);
    const duplicate = await broker.startTurn({sessionId,requestId:"duplicate",idempotencyKey:"command-conflict",text:"Keep this command queued",origin:"mobile"});
    expect(duplicate.state).toBe("cancelled");

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

  it("keeps legacy managed receipts uncertain without holding execution slots", async () => {
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
    await waitFor(() => hosts[0]?.sends === 1);
    expect(broker.session(staleSessionId)?.pendingCount).toBe(1);

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

  it("continues queued turns on its retained host despite stale activity without a live Desktop executor", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-broker-queue-resume-"));
    directories.push(root);
    const cwd = join(root, "project");
    await mkdir(cwd, { recursive: true });
    const sessionId = randomUUID();
    const observer = new FakeObserver({
      projects: [],
      sessions: [observed(sessionId, cwd, { desktopProcessAlive: false })],
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
      await mkdir(cwd, { recursive: true });
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

  it("repairs a saved fork parent identity from the parent's actual native record", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-fork-parent-repair-"));
    directories.push(root);
    const parentId = randomUUID(), childId = randomUUID();
    const parentDesktopSessionId = `local_${randomUUID()}`;
    const cwd = join(root, "project");
    const sessionsPath = join(root, "sessions.json");
    await writeFile(sessionsPath, JSON.stringify({ version: 2, sessions: [
      { sessionId: parentId, cwd, title: "Parent", createdAt: 1,
        desktopRegistration: { state: "restart-required", detail: "Pending reload", desktopSessionId: parentDesktopSessionId, updatedAt: 2 } },
      { sessionId: childId, cwd, title: "Child", createdAt: 2, parentSessionId: parentId, parentDesktopSessionId: `local_${parentId}`, forkLabel: "fork" },
    ] }));
    const inputs: DesktopSessionRegistrationInput[] = [];
    const eventLog = new SessionEventLog(join(root, "events.jsonl"), 1);
    const broker = new SessionBroker({
      paths: { sessions: join(root, "runtime-sessions"), tasks: join(root, "tasks"), projects: join(root, "projects"), desktopSessions: [] },
      eventLog, observer: new FakeObserver({ projects: [], sessions: [], observedAt: Date.now() }),
      sessionsPath, queuePath: join(root, "queue.json"),
      desktopRegistrar: {
        async register(input) {
          inputs.push(input);
          return { state: "restart-required", detail: "Pending reload", desktopSessionId: input.sessionId === parentId ? parentDesktopSessionId : `local_${input.sessionId}`, updatedAt: 2 };
        },
        changed: (left, right) => JSON.stringify(left) !== JSON.stringify(right),
        publicInfo: value => value,
      },
      prepareRuntime: async () => ({ executablePath: "/fake/claude", credentialPath: "/fake/creds.json", environment: {} }),
    });
    await broker.initialize();
    try {
      await broker.registerDesktopSession(childId);
      expect(inputs.filter(input => input.sessionId === childId).at(-1)?.parentDesktopSessionId).toBe(parentDesktopSessionId);
      const saved = JSON.parse(await readFile(sessionsPath, "utf8"));
      expect(saved.sessions.find((session: { sessionId: string }) => session.sessionId === childId)?.parentDesktopSessionId).toBe(parentDesktopSessionId);
    } finally {
      await broker.close();
      await eventLog.close();
    }
  });

  it.each([false, true])("uses a saved pending native identity before Desktop observes the parent (stale=%s)", async stale => {
    const root = await mkdtemp(join(tmpdir(), "bridge-fork-saved-native-"));
    directories.push(root);
    const sourceId = randomUUID();
    const desktopSessionId = `local_${randomUUID()}`;
    const cwd = join(root, "project");
    const projects = join(root, "projects");
    await writeContextTranscript(projects, cwd, sourceId, 10);
    const sessionsPath = join(root, "sessions.json");
    await writeFile(sessionsPath, JSON.stringify({ version: 2, sessions: [{
      sessionId: sourceId, cwd, title: "Staged fork", createdAt: 1,
      projectId: "cg-staged-group", projectName: "Staged group",
      ...(stale ? { desktopSessionId: `local_${sourceId}` } : {}),
      desktopRegistration: { state: "restart-required", detail: "Pending reload", desktopSessionId, updatedAt: 2 },
    }] }));
    const eventLog = new SessionEventLog(join(root, "events.jsonl"), 1);
    const broker = new SessionBroker({
      paths: { sessions: join(root, "runtime-sessions"), tasks: join(root, "tasks"), projects, desktopSessions: [] },
      eventLog,
      observer: new FakeObserver({ projects: [], sessions: [], observedAt: Date.now() }),
      sessionsPath, queuePath: join(root, "queue.json"),
      prepareRuntime: async () => ({ executablePath: "/fake/claude", credentialPath: "/fake/creds.json", environment: {} }),
    });
    await broker.initialize();
    try {
      const fork = await broker.forkSession(sourceId);
      const saved = JSON.parse(await readFile(sessionsPath, "utf8"));
      expect(saved.sessions.find((session: { sessionId: string }) => session.sessionId === fork.sessionId))
        .toMatchObject({ parentSessionId: sourceId, parentDesktopSessionId: desktopSessionId, projectId: "cg-staged-group", projectName: "Staged group" });
      expect(fork).toMatchObject({ projectId: "cg-staged-group", projectName: "Staged group" });
      expect(broker.session(sourceId)?.desktopSessionId).toBe(desktopSessionId);
    } finally {
      await broker.close();
      await eventLog.close();
    }
  });

  it.each(["\n", ""].flatMap(ending => [
    { ending, pendingNativeId: false },
    { ending, pendingNativeId: true },
  ]))("forks copied history with trailing $ending and pending native identity $pendingNativeId", async ({ ending, pendingNativeId }) => {
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
    const nativeIds = new Map<string, string>();
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
          const desktopSessionId = nativeIds.get(input.sessionId) ?? `local_${pendingNativeId ? randomUUID() : input.sessionId}`;
          nativeIds.set(input.sessionId, desktopSessionId);
          return {
            state: pendingNativeId ? "restart-required" : "registered",
            detail: "Native record exists",
            desktopSessionId,
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
    if (process.platform !== "win32") expect((await stat(join(projectsRoot, `${fork1.sessionId}.jsonl`))).mode & 0o777).toBe(0o600);

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
      parentDesktopSessionId: nativeIds.get(fork1.sessionId),
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
