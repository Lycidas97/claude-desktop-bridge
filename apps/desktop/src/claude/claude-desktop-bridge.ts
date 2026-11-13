import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { basename } from "node:path";
import type {
  BridgeAttachment, BridgeBackgroundTask, BridgeEffort, BridgeHistoryItem, BridgeHistoryPage, BridgeModelInfo, BridgeNativeImageRef, BridgeNativePermissionMode, BridgeNativePermissionModeChange, BridgeOrigin,
  BridgePermissionDecision, BridgePermissionInfo, BridgeProjectInfo, BridgeRuntimeCapability,
  BridgeRuntimeStatus, BridgeSDKPermissionMode, BridgeSessionCommandResult,
  BridgeSessionConfiguration, BridgeSessionContextUsage, BridgeSessionInfo, BridgeSessionRewindPreview, BridgeSessionRewindResult, BridgeSessionRewindScope, BridgeSlashCommandCatalog, BridgeSubagentSummary,
} from "@bridge/protocol";
import { ClaudeDesktopInspector, InspectorDisconnectedError, NativeCallError, type NativeSectionCatalog } from "./claude-desktop-inspector.js";
import type { ConversationStateStore, NativeDesktopReceipt } from "../controller/conversation-state-store.js";
import { readClaudeTranscriptBackgroundTasks, readClaudeTranscriptSubagents, scanClaudeContextFromMessages, visibleMessage } from "../transcript/claude-history.js";
import { claudeRuntimePaths } from "../app/platform.js";
import type { SessionEventLog, BridgeEventDraft } from "../controller/session-event-log.js";
import type { EvidenceManager, ObservedDesktopTool } from "../evidence/evidence-manager.js";
import { oldestLiveProcessStart, projectIdForCwd, scanClaudeCatalog, type ClaudeCatalogSnapshot } from "./claude-session-catalog.js";
import { discoverClaudeProjectDirectory, findClaudeHostCredentials, magpieModelIdHash, parseMagpieSyntheticModelId, resolveClaudeGatewayConfig, type ClaudeGatewayConfig, type ClaudeProjectDirectory, type ClaudeRuntime } from "./claude-runtime-discovery.js";
import { MagpieConnectionRepository, testMagpieGateway } from "./magpie-connection.js";
import { readClaudeModelOptions } from "./connector.js";
import {
  applyAssistantMessageContext,
  applyCompactBoundaryContext,
  applyLiveContextUsageState,
  applyResultModelUsageContext,
  applyStreamDeltaContext,
  applyStreamStartContext,
  buildTranscriptContextState,
  createNativeContextState,
  parseLiveContextUsage,
  projectedContextUsage,
  savedModelOption,
  type NativeContextState,
} from "./native-context-usage.js";
import {
  enrichNativeSubagentItems,
  extractNativeImageAttachment,
  nativeHistoryItems,
  nativeItemEventDraft,
  nativePlanMessages,
  type NativeMessageProjection,
} from "./native-history-projection.js";

export { nativeHistoryItems };

export class WorkspaceTrustRequiredError extends NativeCallError {
  constructor(readonly manual: boolean) {
    super(
      manual
        ? "请在电脑端 Claude 窗口打开并信任此文件夹后重试。"
        : "此文件夹首次在 Claude Desktop 中使用，需要确认信任后才能创建会话。",
    );
    this.name = "WorkspaceTrustRequiredError";
  }
}

function isWorkspaceTrustError(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return /\bWorkspaceTrustError\b|\[ccdErrorCategory:trust_required\]/u.test(text);
}

interface NativeSession {
  sessionId: string;
  cwd: string;
  harnessCwd?: string;
  title?: string;
  model?: string;
  effort?: BridgeEffort;
  permissionMode?: BridgeSDKPermissionMode;
  isRunning?: boolean;
  turnRunning?: boolean;
  isArchived?: boolean;
  scheduledTaskId?: string | null;
  lastActivityAt?: number;
  createdAt?: number;
  forkedFromSessionId?: string;
  spawnedFrom?: { sessionId: string; btw?: boolean };
  lineageDetached?: boolean;
  bridgeSessionId?: string;
  bridgeSessionIds?: string[];
  pendingToolPermissions?: unknown[];
  hasBackgroundWork?: boolean;
}

interface InspectorTransport {
  readonly ready: boolean;
  supports(method: string): boolean;
  connect(): Promise<void>;
  close(): Promise<void>;
  call(method: string, args?: unknown[]): Promise<unknown>;
  availableCodeModels(): Promise<string[]>;
  sections?(sessionIds: string[]): Promise<NativeSectionCatalog | undefined>;
  createSection?(name: string): Promise<string>;
  assignSection?(sessionId: string, sectionId: string): Promise<void>;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

interface NativeInput {
  requestId: string;
  idempotencyKey: string;
  sessionId: string;
  text: string;
  attachments?: BridgeAttachment[];
  origin: BridgeOrigin;
  sourceDeviceId?: string;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function nativeSession(value: unknown): NativeSession {
  const session = record(value);
  if (typeof session.sessionId !== "string" || typeof session.cwd !== "string") throw new NativeCallError("Desktop returned an invalid session");
  return session as unknown as NativeSession;
}

/** Protocol translation and transport receipts only. Desktop owns every Claude execution. */
export class ClaudeDesktopBridge extends EventEmitter {
  private readonly inspector: InspectorTransport;
  private readonly native = new Map<string, NativeSession>();
  private sectionCatalog: NativeSectionCatalog | undefined;
  private readonly projectDirectories = new Map<string, ClaudeProjectDirectory>();
  private readonly sessions = new Map<string, BridgeSessionInfo>();
  private readonly permissions = new Map<string, BridgePermissionInfo>();
  private readonly receipts = new Map<string, NativeDesktopReceipt>();
  private readonly messageProjection = new Map<string, NativeMessageProjection>();
  private readonly contextStates = new Map<string, NativeContextState>();
  private readonly backgroundTasks = new Map<string, BridgeBackgroundTask[]>();
  private readonly permissionModeChanges = new Map<string, BridgeNativePermissionModeChange>();
  private readonly streams = new Map<string, string>();
  private readonly tools = new Map<string, ObservedDesktopTool>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private lastError = "Claude Desktop inspector 尚未连接";
  private gateway: ClaudeGatewayConfig | undefined;
  private models: BridgeModelInfo[] | undefined;

  constructor(private readonly options: {
    settingsPath: string;
    eventLog: SessionEventLog;
    conversationState: ConversationStateStore;
    evidence?: Pick<EvidenceManager, "upsertDesktopEvidence">;
    magpieConnection?: MagpieConnectionRepository;
    inspector?: InspectorTransport;
    scanCatalog?: () => Promise<ClaudeCatalogSnapshot>;
    refreshIntervalMs?: number;
  }) {
    super();
    this.inspector = options.inspector ?? new ClaudeDesktopInspector(process.env.BRIDGE_CLAUDE_INSPECTOR_URL ? { origin: process.env.BRIDGE_CLAUDE_INSPECTOR_URL } : {});
    this.inspector.on("event", value => { void this.handleEvent(value).catch(error => this.report(error)); });
    this.inspector.on("permission", value => { this.observePermission(value); this.projectSessions(); this.emit("changed"); });
    this.inspector.on("disconnected", () => { this.lastError = "Claude Desktop inspector 已断开；请在 Desktop 开发者菜单开启 Node inspector"; this.projectSessions(); this.emit("changed"); });
    this.inspector.on("stream-error", error => this.report(error));
  }

  async initialize(): Promise<void> {
    for (const receipt of this.options.conversationState.listNativeDesktopReceipts()) {
      if (receipt.state === "dispatching") {
        receipt.state = "uncertain";
        this.options.conversationState.saveNativeDesktopReceipt(receipt);
      }
      this.receipts.set(receipt.commandId, receipt);
    }
    await this.options.magpieConnection?.initialize();
    await this.refreshRuntime();
    this.scheduleRefresh();
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.timer);
    await this.inspector.close();
  }

  private scheduleRefresh(): void {
    if (this.closed) return;
    this.timer = setTimeout(() => { void this.refreshRuntime().finally(() => this.scheduleRefresh()); }, this.options.refreshIntervalMs ?? 2_000);
    this.timer.unref?.();
  }

  async refreshRuntime(): Promise<boolean> {
    try {
      if (!this.inspector.ready) await this.inspector.connect();
      const result = await this.inspector.call("getAll");
      if (!Array.isArray(result)) throw new NativeCallError("Desktop getAll did not return a session list");
      const sessions = result.map(nativeSession);
      this.sectionCatalog = await this.inspector.sections?.(sessions.map(session => session.sessionId));
      this.models = await readClaudeModelOptions(this.options.settingsPath);
      this.native.clear();
      for (const session of sessions) await this.observeNativeSession(session);
      this.permissions.clear();
      for (const session of sessions) for (const permission of session.pendingToolPermissions ?? []) this.observePermission(permission, session.sessionId);
      this.projectSessions();
      this.lastError = "";
      this.emit("changed");
      return true;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.projectSessions();
      this.emit("changed");
      return false;
    }
  }

  capabilities(): BridgeRuntimeCapability[] {
    const capabilities: BridgeRuntimeCapability[] = ["session.list", "session.history"];
    if (!this.inspector.ready) return capabilities;
    const methods: Array<[string, BridgeRuntimeCapability]> = [
      ["start", "session.create"], ["saveTrust", "workspace.trust"], ["forkSession", "session.fork"], ["sendMessage", "turn.start"],
      ["sendMessage", "turn.steer"], ["interrupt", "turn.interrupt"], ["setModel", "session.configure"],
      ["respondToToolPermission", "permission.resolve"], ["sendMessage", "attachment.image"],
    ];
    for (const [method, capability] of methods) if (this.inspector.supports(method)) capabilities.push(capability);
    if (["canRewindTo", "rewindV2", "rewindFiles"].every(method => this.inspector.supports(method))) capabilities.push("session.rewind");
    if (this.sectionCatalog && this.inspector.createSection && this.inspector.assignSection) capabilities.push("section.create");
    if (this.sectionCatalog && this.inspector.assignSection) capabilities.push("section.move");
    capabilities.push("tool.events");
    return capabilities;
  }

  runtimeStatus(): BridgeRuntimeStatus {
    const activeTurns = [...this.native.values()].filter(session => session.turnRunning).length;
    const ready = this.inspector.ready;
    const detail = ready ? "连接 Claude Desktop；会话和执行由 Desktop 管理" : this.lastError;
    return {
      state: ready ? activeTurns ? "working" : "ready" : "unavailable", detail,
      activeTurns, maxParallelTurns: 0,
      desktopIntegration: { state: ready ? "ready" : "disconnected", detail, enabled: true, canRestart: false },
    };
  }

  private savedModel(model: string): BridgeModelInfo | undefined {
    return savedModelOption(this.models, model);
  }

  private async observeNativeSession(session: NativeSession): Promise<void> {
    if (!this.projectDirectories.has(session.cwd)) this.projectDirectories.set(session.cwd, await discoverClaudeProjectDirectory(session.cwd));
    this.native.set(session.sessionId, session);
  }

  private projectCwd(cwd: string): string {
    const project = this.projectDirectories.get(cwd)!;
    if (project.cwd === cwd) return cwd;
    // Keep the original main-project spelling (and its saved ordering ID).
    return [...this.projectDirectories].find(([original, candidate]) => original === candidate.cwd && candidate.realCwd === project.realCwd)?.[0] ?? project.cwd;
  }

  private ensureContextState(sessionId: string): NativeContextState {
    let state = this.contextStates.get(sessionId);
    if (!state) {
      state = createNativeContextState();
      this.contextStates.set(sessionId, state);
    }
    return state;
  }

  private projectedContextUsage(sessionId: string, sessionModel?: string): BridgeSessionContextUsage | undefined {
    return projectedContextUsage(this.contextStates.get(sessionId), this.models, sessionModel);
  }

  private async readLiveContextUsage(id: string): Promise<{ totalTokens: number; rawMaxTokens?: number; model?: string } | undefined> {
    if (!this.inspector.ready || !this.inspector.supports("getContextUsage")) return undefined;
    const native = this.native.get(id);
    if (native && !native.isRunning && !native.turnRunning) return undefined;
    try {
      return parseLiveContextUsage(await this.inspector.call("getContextUsage", [id]));
    } catch (error) {
      if (error instanceof InspectorDisconnectedError) return undefined;
      throw error;
    }
  }

  private applyLiveContextUsage(sessionId: string, live: { totalTokens: number; rawMaxTokens?: number; model?: string }): void {
    applyLiveContextUsageState(this.ensureContextState(sessionId), live);
  }

  private applyTranscriptContextMessages(sessionId: string, messages: readonly unknown[]): void {
    this.contextStates.set(sessionId, buildTranscriptContextState(messages));
  }

  private projectSessions(): void {
    this.sessions.clear();
    const ready = this.inspector.ready;
    for (const native of this.native.values()) {
      const sessionId = native.sessionId;
      const tasks = [...this.messageProjection.get(sessionId)?.tasks?.values() ?? []].filter(task => task.state === "running");
      const runningSubagents = tasks.length
        ? { count: tasks.length, lastUpdatedAt: Math.max(...tasks.map(task => task.updatedAt)) }
        : native.hasBackgroundWork === true
          ? { count: 1, lastUpdatedAt: native.lastActivityAt ?? native.createdAt ?? 0 }
          : undefined;
      const waiting = [...this.permissions.values()].some(permission => permission.sessionId === sessionId);
      const running = native.turnRunning === true;
      const pendingCommandIds = [...this.receipts.values()].filter(receipt => receipt.sessionId === sessionId && receipt.state === "queued").map(receipt => receipt.commandId);
      const modeChange = this.permissionModeChanges.get(sessionId);
      const contextUsage = this.projectedContextUsage(sessionId, native.model);
      const parentSessionId = native.forkedFromSessionId ?? native.spawnedFrom?.sessionId;
      const projectCwd = this.projectCwd(native.cwd);
      const section = this.sectionCatalog?.sections.find(section => section.id === this.sectionCatalog?.assignments[sessionId]);
      this.sessions.set(sessionId, {
        sessionId, nativeSessionId: native.sessionId, desktopSessionId: native.sessionId, runtimeId: "claude-desktop",
        projectId: section?.id ?? projectIdForCwd(projectCwd), projectName: section?.name ?? (basename(projectCwd) || projectCwd), cwd: native.cwd,
        title: native.title || "Claude 会话", source: "desktop", transport: "claude-desktop-native",
        ownership: running ? "DESKTOP_NATIVE_RUNNING" : "DESKTOP_NATIVE_IDLE",
        turnState: waiting ? "waiting" : running ? "running" : "idle",
        lastActivityAt: native.lastActivityAt ?? native.createdAt ?? 0, pendingCount: pendingCommandIds.length, pendingCommandIds,
        ...(native.model ? { model: native.model, modelDisplayName: this.savedModel(native.model)?.displayName ?? native.model } : {}), ...(native.effort ? { effort: native.effort } : {}),
        ...(contextUsage ? { contextUsage } : {}),
        ...(parentSessionId ? { parentSessionId } : {}),
        ...(native.spawnedFrom?.btw === true && native.lineageDetached !== true ? { sidechat: true } : {}),
        ...(native.isArchived ? { archivedAt: native.lastActivityAt ?? native.createdAt ?? 1 } : {}),
        subagentStopScope: "task", ...(runningSubagents ? { runningSubagents } : {}),
        ...(modeChange ? { nativePermissionModeChange: {
          ...modeChange,
          ...(modeChange.state !== "requested" ? { state: native.permissionMode === modeChange.mode ? "confirmed" as const : "not-applied" as const, ...(native.permissionMode ? { observedMode: native.permissionMode } : {}) } : {}),
        } } : {}),
        allowedActions: {
          canSend: ready && this.inspector.supports("sendMessage"), canSteer: ready && this.inspector.supports("sendMessage"),
          canInterrupt: ready && this.inspector.supports("interrupt") && (running || native.hasBackgroundWork === true),
          canSwitchProvider: false, canContinueOfficial: false, canRelay: false,
          canConfigure: ready && this.inspector.supports("setModel"),
          ...(ready && this.sectionCatalog && this.inspector.assignSection && !native.isArchived && !native.scheduledTaskId ? { canMoveSection: true } : {}),
          ...(!ready ? { reason: "Claude Desktop inspector 已断开" } : {}),
        },
      });
    }
  }

  listSessions(): BridgeSessionInfo[] { return [...this.sessions.values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt); }
  session(sessionId: string): BridgeSessionInfo | undefined { return this.sessions.get(sessionId); }
  executionCwd(sessionId: string): string | undefined {
    const session = this.native.get(sessionId);
    return session?.harnessCwd ?? session?.cwd;
  }
  listProjects(): BridgeProjectInfo[] {
    const projects = new Map<string, BridgeProjectInfo>((this.sectionCatalog?.sections ?? []).map(section => [section.id, {
      projectId: section.id, name: section.name, kind: "desktop-group", cwd: "", runtimeId: "claude-desktop", sessionCount: 0, runningCount: 0, pendingCount: 0, lastActivityAt: 0,
    }]));
    for (const session of this.sessions.values()) {
      const project = projects.get(session.projectId) ?? { projectId: session.projectId, name: session.projectName, cwd: this.projectCwd(session.cwd), runtimeId: "claude-desktop", sessionCount: 0, runningCount: 0, pendingCount: 0, lastActivityAt: 0 };
      if (!project.cwd) project.cwd = this.projectCwd(session.cwd);
      project.sessionCount++;
      project.runningCount += session.turnState === "running" ? 1 : 0;
      project.pendingCount += session.pendingCount;
      project.lastActivityAt = Math.max(project.lastActivityAt, session.lastActivityAt);
      projects.set(project.projectId, project);
    }
    return [...projects.values()];
  }

  private desktopId(sessionId: string): string {
    if (!this.native.has(sessionId)) throw new NativeCallError("Native Desktop session not found");
    return sessionId;
  }

  async createSection(name: string): Promise<BridgeProjectInfo> {
    if (!this.capabilities().includes("section.create")) throw new NativeCallError("This Claude Desktop version does not support Sections");
    const id = await this.inspector.createSection!(name);
    if (!await this.refreshRuntime()) throw new NativeCallError(this.lastError);
    const project = this.listProjects().find(project => project.kind === "desktop-group" && project.projectId === id);
    if (!project) throw new NativeCallError("Desktop has not published the created Section; refresh the directory before retrying");
    return project;
  }

  async moveSessionSection(sessionId: string, sectionId: string | null): Promise<BridgeSessionInfo> {
    if (!this.capabilities().includes("section.move")) throw new NativeCallError("This Claude Desktop version does not support Sections");
    const native = this.native.get(this.desktopId(sessionId))!;
    if (native.isArchived || native.scheduledTaskId) throw new NativeCallError("This session cannot be moved between Sections");
    if (sectionId !== null && !this.sectionCatalog?.sections.some(section => section.id === sectionId)) {
      throw new NativeCallError("Selected Desktop Section is no longer available");
    }
    await this.inspector.assignSection!(sessionId, sectionId ?? "sessions");
    if (!await this.refreshRuntime()) throw new NativeCallError(this.lastError);
    const session = this.session(sessionId);
    if (!session) throw new NativeCallError("Moved Desktop session is no longer available");
    return session;
  }

  async createSession(cwd: string, title?: string, projectId?: string, trustWorkspace?: boolean): Promise<BridgeSessionInfo> {
    if (projectId && !await this.refreshRuntime()) throw new NativeCallError(this.lastError);
    const project = projectId ? this.listProjects().find(project => project.projectId === projectId) : undefined;
    if (projectId && !project) throw new NativeCallError("Selected Desktop project is no longer available");
    if (trustWorkspace) {
      if (!this.inspector.supports("saveTrust")) throw new WorkspaceTrustRequiredError(true);
      await this.inspector.call("saveTrust", [cwd]);
    }
    let raw: unknown;
    try {
      raw = await this.inspector.call("start", [{ cwd, title, sessionId: `local_${randomUUID()}`, withoutFirstMessage: true, message: "" }]);
    } catch (error) {
      if (isWorkspaceTrustError(error)) {
        throw new WorkspaceTrustRequiredError(Boolean(trustWorkspace) || !this.inspector.supports("saveTrust"));
      }
      throw error;
    }
    const result = record(raw);
    if (typeof result.sessionId !== "string") throw new NativeCallError("Desktop did not return a session ID");
    if (project?.kind === "desktop-group") await this.inspector.assignSection!(result.sessionId, project.projectId);
    await this.refreshRuntime();
    const session = this.session(result.sessionId);
    if (!session) throw new NativeCallError("Created Desktop session is not yet available");
    return session;
  }

  async forkSession(sessionId: string, title?: string): Promise<BridgeSessionInfo> {
    const result = record(await this.inspector.call("forkSession", [this.desktopId(sessionId)]));
    if (typeof result.sessionId !== "string") throw new NativeCallError("Desktop did not return a fork ID");
    if (title) await this.inspector.call("updateSession", [result.sessionId, { title }]);
    await this.refreshRuntime();
    const session = this.session(result.sessionId);
    if (!session) throw new NativeCallError("Forked Desktop session is not yet available");
    return session;
  }

  async rename(sessionId: string, title: string): Promise<void> {
    await this.inspector.call("updateSession", [this.desktopId(sessionId), { title }]);
    await this.refreshRuntime();
  }

  async archive(sessionId: string, archived: boolean): Promise<void> {
    await this.inspector.call(archived ? "archive" : "unarchive", [this.desktopId(sessionId)]);
    await this.refreshRuntime();
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.inspector.call("delete", [this.desktopId(sessionId)]);
    this.contextStates.delete(sessionId);
    await this.refreshRuntime();
  }

  async refreshDesktopConfiguration(sessionId: string): Promise<void> { await this.configuration(sessionId); }

  private async transcriptSubagents(sessionId: string) {
    const id = this.desktopId(sessionId);
    const observed = (await (this.options.scanCatalog?.() ?? scanClaudeCatalog(claudeRuntimePaths())))
      .sessions.find(session => session.desktopSessionId === id);
    if (!observed?.transcriptPath) return undefined;
    const liveSince = oldestLiveProcessStart(observed.activeProcesses);
    return { transcriptPath: observed.transcriptPath, liveSince, subagents: await readClaudeTranscriptSubagents(observed.transcriptPath, liveSince) };
  }

  private async enrichSubagentItems(sessionId: string, items: BridgeHistoryItem[]): Promise<BridgeSubagentSummary[] | undefined> {
    if (!items.some(item => item.subagent || item.toolName === "Agent" || item.toolName === "Task")) return undefined;
    const local = await this.transcriptSubagents(sessionId);
    enrichNativeSubagentItems(items, local?.subagents);
    return local?.subagents;
  }

  async backgroundTaskDetails(sessionId: string): Promise<BridgeBackgroundTask[]> {
    const id = this.desktopId(sessionId);
    const previousSession = JSON.stringify(this.session(id));
    const local = await this.transcriptSubagents(sessionId);
    let tasks: BridgeBackgroundTask[] = [];
    if (local) {
      tasks = await readClaudeTranscriptBackgroundTasks(local.transcriptPath, local.subagents, local.liveSince);
      const projection = this.messageProjection.get(id) ?? {};
      projection.tasks = new Map(local.subagents.map(task => [task.agentId, task]));
      this.messageProjection.set(id, projection);
    }
    this.backgroundTasks.set(id, tasks);
    this.projectSessions();
    if (JSON.stringify(this.session(id)) !== previousSession) this.emit("changed");
    return tasks;
  }

  private async rewindTarget(sessionId: string, messageId: string): Promise<string> {
    const id = this.desktopId(sessionId);
    if (!this.inspector.ready) throw new InspectorDisconnectedError("Claude Desktop rewind is unavailable while inspector is disconnected");
    if (!this.capabilities().includes("session.rewind")) throw new NativeCallError("Unsupported Claude Desktop rewind methods");
    const native = nativeSession(await this.inspector.call("getSession", [id]));
    await this.observeNativeSession(native);
    this.projectSessions();
    const result = await this.inspector.call("getTranscript", [id]);
    const messages = Array.isArray(result) ? result : record(result).messages;
    if (!Array.isArray(messages)) throw new NativeCallError("Desktop returned an invalid transcript");
    if (!messages.some(raw => {
      const message = record(raw);
      return message.uuid === messageId && message.type === "user" && message.isSidechain !== true && !message.parent_tool_use_id && visibleMessage(message)?.role === "user";
    })) throw new NativeCallError("Rewind target must be a user message in this native session");
    return id;
  }

  async previewRewind(sessionId: string, messageId: string): Promise<BridgeSessionRewindPreview> {
    const id = await this.rewindTarget(sessionId, messageId);
    const canRewindConversation = await this.inspector.call("canRewindTo", [id, messageId]) === true;
    let files: Record<string, unknown>;
    try {
      files = record(await this.inspector.call("rewindFiles", [id, messageId, true]));
    } catch (error) {
      if (!(error instanceof NativeCallError)) throw error;
      files = { canRewind: false, error: error.message };
    }
    return {
      sessionId, messageId, canRewindConversation,
      canRewindFiles: files.canRewind === true && !files.error && files.inFlight !== true,
      filesChanged: Array.isArray(files.filesChanged) ? files.filesChanged.filter((path): path is string => typeof path === "string") : [],
      ...(typeof files.error === "string" ? { fileError: files.error } : {}),
      ...(typeof files.inFlight === "boolean" ? { filesInFlight: files.inFlight } : {}),
      ...(typeof files.insertions === "number" ? { insertions: files.insertions } : {}),
      ...(typeof files.deletions === "number" ? { deletions: files.deletions } : {}),
    };
  }

  async rewindSession(sessionId: string, messageId: string, scope: BridgeSessionRewindScope): Promise<BridgeSessionRewindResult> {
    const id = await this.rewindTarget(sessionId, messageId);
    if (scope !== "files" && await this.inspector.call("canRewindTo", [id, messageId]) !== true) throw new NativeCallError("Desktop cannot rewind the conversation to this user message");
    if (scope !== "conversation") {
      const preview = record(await this.inspector.call("rewindFiles", [id, messageId, true]));
      if (preview.canRewind !== true || preview.error || preview.inFlight === true) throw new NativeCallError(`Desktop cannot rewind files: ${preview.error ?? (preview.inFlight ? "file changes are in flight" : "checkpoint unavailable")}`);
      const restored = record(await this.inspector.call("rewindFiles", [id, messageId, false, true]));
      if (restored.canRewind !== true || restored.error || restored.inFlight === true) throw new NativeCallError(`Desktop did not restore files: ${restored.error ?? (restored.inFlight ? "file changes are in flight" : "restore unavailable")}`);
    }
    let prefill: string | undefined;
    if (scope !== "files") {
      try {
        const result = record(await this.inspector.call("rewindV2", [id, messageId]));
        if (typeof result.prefill !== "string") throw new NativeCallError("Desktop did not rewind the conversation");
        prefill = result.prefill;
      } catch (error) {
        if (scope === "both") throw new NativeCallError(`Files were restored, but conversation rewind failed: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      }
      await this.options.eventLog.flushDeltas(sessionId);
      await this.record({ sessionId, origin: "claude-desktop", type: "session.rewound", data: { messageId, scope } });
      this.messageProjection.delete(sessionId);
      this.contextStates.delete(sessionId);
      this.backgroundTasks.delete(sessionId);
      this.streams.delete(sessionId);
    }
    try {
      await this.observeNativeSession(nativeSession(await this.inspector.call("getSession", [id])));
      if (scope !== "files") await this.history(sessionId);
    } catch (error) {
      if (!(error instanceof InspectorDisconnectedError)) throw error;
      this.report(error);
    }
    this.projectSessions();
    this.emit("changed");
    return { sessionId, messageId, scope, ...(prefill !== undefined ? { prefill } : {}) };
  }

  async history(sessionId: string, cursor?: string, limit = 50): Promise<BridgeHistoryPage> {
    const id = this.desktopId(sessionId);
    if (!this.inspector.ready) throw new InspectorDisconnectedError("Claude Desktop history is unavailable while inspector is disconnected");
    const previousSession = !cursor ? JSON.stringify(this.session(sessionId)) : undefined;
    const page = record(await this.inspector.call("getTranscriptPage", [id, cursor ?? "", limit, { window: "accept" }]));
    if (!Array.isArray(page.messages)) throw new NativeCallError("Desktop returned an invalid transcript page");
    const nextCursor = page.hasMore === true && typeof record(page.messages[0]).uuid === "string" ? String(record(page.messages[0]).uuid) : undefined;
    const firstPlan = nativePlanMessages(page.messages)[0]?.message.content[0];
    let boundaryFound = firstPlan?.name === "mcp__ccd_turn__update_plan" && ["first_task", "new_task"].includes(String(record(firstPlan.input).scope));
    const context: unknown[] = [];
    const olderPages: unknown[][] = [];
    let before = nextCursor;
    while (!boundaryFound && before) {
      const older = record(await this.inspector.call("getTranscriptPage", [id, before, limit, { window: "accept" }]));
      if (!Array.isArray(older.messages)) throw new NativeCallError("Desktop returned an invalid transcript page");
      olderPages.unshift(older.messages);
      for (const message of nativePlanMessages(older.messages).reverse()) {
        const block = message.message.content[0]!;
        context.unshift(message);
        if (block.name === "mcp__ccd_turn__wrap_up" || ["first_task", "new_task"].includes(String(record(block.input).scope))) {
          boundaryFound = true;
          break;
        }
      }
      before = older.hasMore === true && typeof record(older.messages[0]).uuid === "string" ? String(record(older.messages[0]).uuid) : undefined;
    }
    const projection: NativeMessageProjection = {};
    nativeHistoryItems(sessionId, context, projection);
    const items = nativeHistoryItems(sessionId, page.messages, projection);
    const localSubagents = await this.enrichSubagentItems(sessionId, items);
    if (!cursor) {
      const liveProjection = this.messageProjection.get(sessionId) ?? {};
      if (!liveProjection.planObserved && projection.planObserved) {
        if (projection.plan) liveProjection.plan = projection.plan;
        else delete liveProjection.plan;
        liveProjection.planObserved = true;
        this.messageProjection.set(sessionId, liveProjection);
      }
      if (localSubagents?.length || projection.tasks?.size) {
        const native = this.native.get(sessionId);
        const allowRunning = native?.isRunning === true || native?.turnRunning === true || native?.hasBackgroundWork === true;
        const tasks = liveProjection.tasks ??= new Map();
        for (const task of localSubagents ?? []) tasks.set(task.agentId, task);
        for (const [taskId, task] of projection.tasks ?? []) {
          if (localSubagents?.some(local => local.agentId === taskId || (task.toolUseId && local.toolUseId === task.toolUseId))) continue;
          if (task.state === "running" && !allowRunning) continue;
          const current = tasks.get(taskId);
          if (!current || task.updatedAt >= current.updatedAt || (current.state === "running" && task.state !== "running")) {
            tasks.set(taskId, { ...(current?.model ? { model: current.model } : {}), ...task });
          }
        }
        this.messageProjection.set(sessionId, liveProjection);
      }
      const live = await this.readLiveContextUsage(id);
      if (live) {
        this.applyLiveContextUsage(sessionId, live);
      } else {
        let combined: unknown[] = [...olderPages.flat(), ...page.messages];
        let scan = scanClaudeContextFromMessages(combined);
        for (let hop = 0; !scan.anchored && before && page.messages.length >= limit && limit >= 20 && hop < 8; hop += 1) {
          const older = record(await this.inspector.call("getTranscriptPage", [id, before, Math.max(limit, 100), { window: "accept" }]));
          if (!Array.isArray(older.messages)) break;
          combined = [...older.messages, ...combined];
          scan = scanClaudeContextFromMessages(combined);
          before = older.hasMore === true && typeof record(older.messages[0]).uuid === "string"
            ? String(record(older.messages[0]).uuid)
            : undefined;
        }
        this.applyTranscriptContextMessages(sessionId, combined);
      }
      this.projectSessions();
      if (JSON.stringify(this.session(sessionId)) !== previousSession) this.emit("changed");
    }
    for (const item of items) {
      const receipt = item.role === "user" ? [...this.receipts.values()].find(receipt => receipt.sessionId === sessionId && receipt.messageId === item.id) : undefined;
      if (receipt) {
        item.delivery = receipt.state === "dispatching" ? "host-received" : receipt.state;
        item.commandId = receipt.commandId;
        item.requestId = receipt.requestId;
      }
    }
    return { sessionId, items, hasMore: page.hasMore === true, ...(nextCursor ? { nextCursor } : {}) };
  }

  async readNativeImage(sessionId: string, ref: BridgeNativeImageRef): Promise<{ artifactId: string; name: string; mimeType: string; bytes: Buffer }> {
    const result = await this.inspector.call("getTranscript", [this.desktopId(sessionId)]);
    const messages = Array.isArray(result) ? result : record(result).messages;
    if (!Array.isArray(messages)) throw new NativeCallError("Desktop returned an invalid transcript");
    return extractNativeImageAttachment(sessionId, messages, ref);
  }

  async commands(sessionId: string): Promise<BridgeSlashCommandCatalog> {
    const result = await this.inspector.call("getSupportedCommands", [{ sessionId: this.desktopId(sessionId), cwd: this.session(sessionId)?.cwd }]);
    const commands = Array.isArray(result) ? result : record(result).commands;
    if (!Array.isArray(commands)) throw new NativeCallError("Desktop returned an invalid command catalog");
    const catalog: BridgeSlashCommandCatalog = { sessionId, commands: commands.map(command => {
      const value = record(command);
      return { name: String(value.name ?? value.command ?? ""), description: String(value.description ?? ""), ...(typeof value.argumentHint === "string" ? { argumentHint: value.argumentHint } : {}) };
    }).filter(command => command.name) };
    if (!catalog.commands.some(command => command.name === "btw")) catalog.commands.push({ name: "btw", description: "Ask a question in a side chat", argumentHint: "<question>" });
    catalog.commands = catalog.commands.filter(command => command.name !== "rewind");
    if (this.capabilities().includes("session.rewind")) catalog.commands.push({ name: "rewind", description: "Rewind conversation or file changes", action: "rewind" });
    return catalog;
  }

  async runCommand(input: NativeInput): Promise<BridgeSessionCommandResult> {
    if (input.text.trim() === "/rewind") {
      this.desktopId(input.sessionId);
      if (!this.capabilities().includes("session.rewind")) throw new NativeCallError("Unsupported Claude Desktop rewind methods");
      return { action: "rewind" };
    }
    const btw = /^\/btw(?:\s+([\s\S]*))?$/u.exec(input.text.trim());
    if (btw) {
      if (!btw[1]?.trim()) throw new NativeCallError("Use /btw <question> to ask a side question");
      const receipt = this.options.conversationState.nativeDesktopReceipt(input.idempotencyKey);
      let childId = receipt?.sessionId;
      if (!childId) {
        const result = record(await this.inspector.call("startBtwChild", [this.desktopId(input.sessionId)]));
        if (result.status !== "started" || typeof result.sessionId !== "string") throw new NativeCallError(`Desktop side chat ${String(result.status ?? "returned an invalid response")}${typeof result.refusalReason === "string" ? `: ${result.refusalReason}` : ""}`);
        const child = nativeSession(await this.inspector.call("getSession", [result.sessionId]));
        childId = child.sessionId;
        await this.observeNativeSession(child);
        this.projectSessions();
        this.emit("changed");
      }
      await this.startTurn({ ...input, sessionId: childId, text: btw[1].trim() });
      return { action: "session", session: this.session(childId)! };
    }
    await this.startTurn(input);
    return { action: "sent" };
  }

  async configuration(sessionId: string): Promise<BridgeSessionConfiguration> {
    const id = this.desktopId(sessionId);
    const previousUsage = JSON.stringify(this.session(sessionId)?.contextUsage);
    const native = nativeSession(await this.inspector.call("getSession", [id]));
    this.models = await readClaudeModelOptions(this.options.settingsPath);
    await this.observeNativeSession(native);
    if (native.turnRunning === true) {
      const live = await this.readLiveContextUsage(id);
      if (live) this.applyLiveContextUsage(sessionId, live);
    }
    this.projectSessions();
    const context = this.session(sessionId)?.contextUsage;
    if (JSON.stringify(context) !== previousUsage) this.emit("changed");
    const model = native.model ? this.savedModel(native.model) : undefined;
    return {
      sessionId, ...(native.model ? { model: model?.value ?? native.model, modelDisplayName: model?.displayName ?? native.model } : {}), ...(native.effort ? { effort: native.effort } : {}),
      ...(native.permissionMode ? { nativePermissionMode: native.permissionMode } : {}),
      modelSource: "claude-desktop", effortSource: "claude-desktop",
      availableModels: this.models ? [...this.models, ...(model && !this.models.some(option => option.value === model.value) ? [model] : [])]
        : native.model ? [{ value: native.model, displayName: native.model }] : [],
      availableEffortLevels: ["low", "medium", "high", "xhigh", "max"],
      modelsComplete: this.models !== undefined, appliesAfterTurn: native.turnRunning === true,
      ...(context ? { context } : {}),
    };
  }

  async configureSession(input: { sessionId: string; model?: string | null; effort?: BridgeEffort | null; permissionMode?: BridgeSDKPermissionMode }): Promise<BridgeSessionConfiguration> {
    const id = this.desktopId(input.sessionId);
    if (input.model !== undefined) {
      let nativeModel = input.model;
      if (typeof input.model === "string") {
        const directory = await this.inspector.availableCodeModels();
        if (directory.length && !directory.includes(input.model)) {
          const base = input.model.replace(/\[1m\]$/iu, "");
          const longContext = /\[1m\]$/iu.test(input.model);
          const hash = magpieModelIdHash(base);
          const found = directory.find(candidate => candidate === base) ?? directory.find(candidate => {
            const alias = parseMagpieSyntheticModelId(candidate);
            return alias?.hash === hash && alias.longContext === longContext;
          }) ?? (longContext ? directory.find(candidate => {
            const alias = parseMagpieSyntheticModelId(candidate);
            return alias?.hash === hash && !alias.longContext;
          }) : directory.find(candidate => {
            const alias = parseMagpieSyntheticModelId(candidate);
            return candidate === `${base}[1m]` || (alias?.hash === hash && alias.longContext);
          }));
          if (!found) throw new NativeCallError("Selected model is unavailable in Claude Desktop's native model directory");
          nativeModel = longContext && !/\[1m\]$/iu.test(found) ? `${found}[1m]` : found;
        }
      }
      await this.inspector.call("setModel", [id, nativeModel]);
      const existing = this.contextStates.get(input.sessionId);
      if (existing) {
        delete existing.rawMaxTokens;
        existing.estimated = true;
      }
    }
    if (input.effort !== undefined) await this.inspector.call("setEffort", [id, input.effort]);
    if (input.permissionMode !== undefined) await this.inspector.call("setPermissionMode", [id, input.permissionMode]);
    await this.refreshRuntime();
    const configuration = await this.configuration(input.sessionId);
    // Accept only Desktop's known base -> preferred-1M normalization when the
    // picker did not offer that context as an independent saved choice.
    if (typeof input.model === "string" && configuration.model !== input.model && !(
      !/\[1m\]$/iu.test(input.model) && configuration.model === `${input.model}[1m]`
      && !this.models?.some(option => option.value === configuration.model)
    )) throw new NativeCallError(`Desktop did not apply the selected model: ${input.model}; observed ${configuration.model ?? "default"}`);
    return configuration;
  }

  startTurn(input: NativeInput): Promise<NativeDesktopReceipt> { return this.send(input, "later"); }
  steerTurn(input: NativeInput): Promise<NativeDesktopReceipt> { return this.send(input, "now"); }

  private async send(input: NativeInput, priority: "later" | "now"): Promise<NativeDesktopReceipt> {
    const existing = this.options.conversationState.nativeDesktopReceipt(input.idempotencyKey);
    if (existing) return existing;
    const id = this.desktopId(input.sessionId);
    const receipt: NativeDesktopReceipt = { idempotencyKey: input.idempotencyKey, commandId: randomUUID(), requestId: input.requestId, sessionId: input.sessionId, messageId: randomUUID(), queueMode: priority === "now" ? "steered" : "deferred", state: "dispatching" };
    this.options.conversationState.saveNativeDesktopReceipt(receipt);
    this.receipts.set(receipt.commandId, receipt);
    await this.record({ sessionId: input.sessionId, turnId: receipt.messageId, origin: input.origin, type: "message.delivery", data: { ...receipt, delivery: "host-received", text: input.text } });
    let result: Record<string, unknown>;
    try {
      result = record(await this.inspector.call("sendMessage", [id, input.text, input.attachments?.length ? input.attachments.map(image => ({ base64: image.data, mimeType: image.mimeType, filename: image.name })) : undefined,
        undefined, undefined, this.native.get(id)?.turnRunning ? priority : undefined, priority === "now" ? { ccdSteering: true, queuedMessageBar: true } : undefined,
        receipt.messageId, undefined, input.text, undefined, undefined, undefined, undefined, { personSent: true, rejectUndelivered: true }]));
    } catch (error) {
      if (receipt.state !== "dispatching") return receipt;
      receipt.state = error instanceof InspectorDisconnectedError ? "uncertain" : "failed";
      receipt.error = error instanceof Error ? error.message : String(error);
      this.options.conversationState.saveNativeDesktopReceipt(receipt);
      await this.record({ sessionId: input.sessionId, turnId: receipt.messageId, origin: "claude-desktop", type: "message.delivery", data: { ...receipt, delivery: receipt.state, error: receipt.error } });
      if (receipt.state === "failed") throw error;
      return receipt;
    }
    if (result.delivered === false) {
      receipt.state = "failed";
      receipt.error = typeof result.reason === "string" ? result.reason : "Claude Desktop 未接收这条消息";
      this.options.conversationState.saveNativeDesktopReceipt(receipt);
      this.projectSessions();
      await this.record({ sessionId: input.sessionId, turnId: receipt.messageId, origin: "claude-desktop", type: "message.delivery", data: { ...receipt, delivery: receipt.state } });
      throw new NativeCallError(receipt.error);
    }
    if (result.queued === true && ["dispatching", "submitted", "session-received"].includes(receipt.state)) {
      receipt.state = "queued";
      receipt.queueMode = "deferred";
    } else if (receipt.state === "dispatching") receipt.state = "submitted";
    this.options.conversationState.saveNativeDesktopReceipt(receipt);
    this.projectSessions();
    await this.record({ sessionId: input.sessionId, turnId: receipt.messageId, origin: "claude-desktop", type: "message.delivery", data: { ...receipt, delivery: receipt.state } });
    return receipt;
  }

  async steerQueuedTurn(sessionId: string, commandId: string): Promise<NativeDesktopReceipt> {
    const receipt = this.receipts.get(commandId);
    if (!receipt || receipt.sessionId !== sessionId || !["submitted", "session-received", "queued"].includes(receipt.state)) throw new NativeCallError("这条消息当前不可调整，或已经开始处理");
    if (!receipt.queueMode) throw new NativeCallError("这条旧消息缺少原生发送通道，请在桌面端使用 Send now");
    const accepted = await this.inspector.call(receipt.queueMode === "steered" ? "sendSteeredNow" : "promoteQueuedMessage", [this.desktopId(sessionId), receipt.messageId]);
    if (accepted !== true) throw new NativeCallError("无法立即发送：消息已被处理，或当前不可操作");
    return receipt;
  }

  async cancelQueuedTurn(sessionId: string, commandId: string): Promise<NativeDesktopReceipt> {
    const receipt = this.receipts.get(commandId);
    if (!receipt || receipt.sessionId !== sessionId || !["submitted", "session-received", "queued"].includes(receipt.state)) throw new NativeCallError("这条消息当前不可调整，或已经开始处理");
    if (await this.inspector.call("cancelQueuedMessage", [this.desktopId(sessionId), receipt.messageId]) !== true) throw new NativeCallError("无法撤回：消息已被处理，或当前不可操作");
    if (["completed", "failed", "cancelled"].includes(receipt.state)) return receipt;
    receipt.state = "cancelled";
    delete receipt.error;
    this.options.conversationState.saveNativeDesktopReceipt(receipt);
    this.projectSessions();
    await this.record({ sessionId, itemId: receipt.messageId, turnId: receipt.messageId, origin: "claude-desktop", type: "message.delivery", data: { ...receipt, delivery: "cancelled" } });
    this.emit("changed");
    return receipt;
  }

  async interruptTurn(sessionId: string, _commandId?: string, _force?: boolean): Promise<boolean> {
    await this.inspector.call("interrupt", [this.desktopId(sessionId)]);
    return true;
  }

  async stopSubagent(sessionId: string, taskId: string): Promise<void> {
    await this.inspector.call("stopTask", [this.desktopId(sessionId), taskId]);
  }

  async resolveUncertainDelivery(commandId: string, action: "confirm" | "retry"): Promise<NativeDesktopReceipt> {
    const receipt = this.receipts.get(commandId);
    if (!receipt) throw new NativeCallError("Delivery receipt not found");
    if (action === "retry") throw new NativeCallError("Restore the original draft and explicitly send a new request; an unconfirmed native call cannot be replayed");
    if (receipt.state !== "uncertain") return receipt;
    const result = await this.inspector.call("getTranscript", [this.desktopId(receipt.sessionId)]);
    if (receipt.state !== "uncertain") return receipt;
    const messages = Array.isArray(result) ? result : record(result).messages;
    if (!Array.isArray(messages) || !messages.some(message => record(message).uuid === receipt.messageId)) throw new NativeCallError("Desktop has not confirmed this message UUID");
    receipt.state = "session-received";
    delete receipt.error;
    this.options.conversationState.saveNativeDesktopReceipt(receipt);
    return receipt;
  }

  permissionsList(): BridgePermissionInfo[] { return [...this.permissions.values()]; }

  private observePermission(raw: unknown, nativeId?: string): void {
    const value = record(raw);
    if (typeof value.requestId !== "string" || typeof value.toolName !== "string") return;
    const desktopId = typeof value.sessionId === "string" ? value.sessionId : nativeId;
    const sessionId = desktopId;
    if (!sessionId || !this.native.has(sessionId)) return;
    const permission: BridgePermissionInfo = {
      requestId: value.requestId, sessionId, toolUseId: typeof value.cliToolUseId === "string" ? value.cliToolUseId : value.requestId,
      toolName: value.toolName, input: record(value.input), createdAt: typeof value.requestedAt === "number" ? value.requestedAt : Date.now(),
      canAllowAlways: Array.isArray(value.suggestions) && value.suggestions.length > 0 && value.suppressAlwaysAllowRule !== true && value.alwaysAllowWithheldBy === undefined,
      canSetNativeFullAccess: this.inspector.ready && this.inspector.supports("setPermissionMode"),
    };
    this.permissions.set(permission.requestId, permission);
  }

  async resolvePermission(requestId: string, decision: BridgePermissionDecision, message?: string, updatedInput?: Record<string, unknown>, resolver?: { deviceId: string; name: string }, mode?: BridgeNativePermissionMode): Promise<boolean> {
    const request = this.permissions.get(requestId);
    if (!request) return false;
    const modeChange: BridgeNativePermissionModeChange | undefined = mode && decision !== "deny" ? { requestId, mode, state: "requested" } : undefined;
    if (modeChange) {
      if (!this.inspector.supports("setPermissionMode")) throw new NativeCallError("Unsupported Claude Desktop method: setPermissionMode");
      this.permissionModeChanges.set(request.sessionId, modeChange);
      this.projectSessions();
      this.emit("changed");
      if (await this.inspector.call("setPermissionMode", [this.desktopId(request.sessionId), mode]) === false) {
        modeChange.state = "not-applied";
        await this.refreshRuntime();
        throw new NativeCallError("Desktop did not apply the requested permission mode");
      }
    }
    const response = { ...request.input, ...updatedInput, ...(message ? { _feedbackMessage: message } : {}) };
    await this.inspector.call("respondToToolPermission", [requestId, decision === "allow-once" ? "once" : decision === "allow-always" ? "always" : "deny", response]);
    if (modeChange) modeChange.state = "not-applied";
    await this.refreshRuntime();
    if (this.permissions.has(requestId)) return false;
    await this.record({ sessionId: request.sessionId, origin: "claude-desktop", type: "permission.resolved", data: { requestId, decision, resolvedByDeviceId: resolver?.deviceId ?? "desktop", resolvedByName: resolver?.name ?? "Desktop", resolvedAt: Date.now() } });
    return true;
  }

  private async handleEvent(raw: unknown): Promise<void> {
    const event = record(raw);
    if (typeof event.sessionId !== "string") return;
    if (event.session) {
      const session = nativeSession(event.session);
      await this.observeNativeSession(session);
      this.projectSessions();
    }
    const sessionId = event.sessionId;
    if (!this.native.has(sessionId)) return;
    const deliveries: BridgeEventDraft[] = [];
    if (event.type === "steers_rekeyed" && Array.isArray(event.rekeyedSteers)) {
      for (const rawRekey of event.rekeyedSteers) {
        const rekey = record(rawRekey);
        if (typeof rekey.from !== "string" || typeof rekey.to !== "string") continue;
        const receipt = [...this.receipts.values()].find(candidate => candidate.sessionId === sessionId && candidate.messageId === rekey.from);
        if (!receipt) continue;
        receipt.messageId = rekey.to;
        this.options.conversationState.saveNativeDesktopReceipt(receipt);
        deliveries.push({ sessionId, itemId: receipt.messageId, turnId: receipt.messageId, origin: "claude-desktop", type: "message.delivery", data: { ...receipt, previousMessageId: rekey.from, delivery: receipt.state } });
      }
    }
    if ((event.type === "held_input_withdrawn" || event.type === "close") && Array.isArray(event.withdrawnUuids)) {
      for (const uuid of event.withdrawnUuids) {
        if (event.type === "close" && Array.isArray(event.lostUuids) && event.lostUuids.includes(uuid)) continue;
        const receipt = [...this.receipts.values()].find(candidate => candidate.sessionId === sessionId && candidate.messageId === uuid);
        if (!receipt || !["dispatching", "submitted", "session-received", "queued", "uncertain"].includes(receipt.state)) continue;
        receipt.state = "cancelled";
        delete receipt.error;
        this.options.conversationState.saveNativeDesktopReceipt(receipt);
        deliveries.push({ sessionId, itemId: receipt.messageId, turnId: receipt.messageId, origin: "claude-desktop", type: "message.delivery", data: { ...receipt, delivery: "cancelled" } });
      }
    }
    for (const delivery of deliveries) await this.record(delivery);
    const message = record(event.message);
    if (message.isSidechain === true || (message.parent_tool_use_id && (message.type === "assistant" || message.type === "user" || message.type === "system" || message.type === "stream_event"))) {
      this.emit("changed");
      return;
    }
    const stream = record(message.event);
    if (message.type === "stream_event" && !message.parent_tool_use_id) {
      if (stream.type === "message_start") {
        const streamMessage = record(stream.message);
        const id = streamMessage.id;
        if (typeof id === "string") this.streams.set(sessionId, id);
        applyStreamStartContext(this.ensureContextState(sessionId), message, streamMessage, id);
      } else if (stream.type === "message_delta" && typeof stream.usage === "object" && stream.usage !== null && !Array.isArray(stream.usage)) {
        applyStreamDeltaContext(this.ensureContextState(sessionId), record(stream.usage));
      }
      const delta = record(stream.delta);
      if (delta.type === "text_delta" && typeof delta.text === "string") this.options.eventLog.appendCoalescedDelta({ sessionId, origin: "claude-desktop", type: "assistant.delta", ...(this.streams.has(sessionId) ? { itemId: this.streams.get(sessionId)! } : {}) }, delta.text);
    }
    if (message.type === "user" && typeof message.uuid === "string" && visibleMessage(message)?.role === "user") {
      const receipt = [...this.receipts.values()].find(candidate => candidate.sessionId === sessionId && candidate.messageId === message.uuid);
      if (receipt && ["dispatching", "submitted", "uncertain"].includes(receipt.state)) {
        receipt.state = "session-received";
        delete receipt.error;
        this.options.conversationState.saveNativeDesktopReceipt(receipt);
      }
    }
    let indexedResult = false;
    const commandUuids = message.type === "command_lifecycle" && typeof message.command_uuid === "string" ? [message.command_uuid]
      : message.type === "result" ? [...new Set([...(Array.isArray(message.user_message_uuids) ? message.user_message_uuids : []), message.user_message_uuid].filter((id): id is string => typeof id === "string"))] : [];
    for (const uuid of commandUuids) {
      const state = message.type === "result" ? message.is_error === true ? "failed" : "completed" : message.state;
      if (!["queued", "started", "completed", "failed", "cancelled", "interrupted"].includes(String(state))) continue;
      const receipt = [...this.receipts.values()].find(receipt => receipt.sessionId === sessionId && receipt.messageId === uuid);
      if (!receipt) continue;
      if (message.type === "result") indexedResult = true;
      if (message.type === "command_lifecycle" && (["completed", "failed", "cancelled"].includes(receipt.state) || (receipt.state === "running" && state === "queued"))) continue;
      receipt.state = state === "queued" ? "queued" : state === "started" ? "running" : state === "interrupted" || state === "cancelled" ? "cancelled" : state === "failed" ? "failed" : "completed";
      if (state === "queued") receipt.queueMode = "steered";
      delete receipt.error;
      this.options.conversationState.saveNativeDesktopReceipt(receipt);
      const type = state === "queued" ? "turn.queued" : state === "started" ? "turn.started" : state === "failed" ? "turn.failed" : state === "interrupted" || state === "cancelled" ? "turn.interrupted" : "turn.completed";
      await this.record({ sessionId, itemId: uuid, turnId: uuid, origin: "claude-desktop", type, data: { commandId: receipt.commandId, requestId: receipt.requestId, messageId: uuid, delivery: receipt.state, ...(state === "failed" ? { error: message.result ?? message.error ?? message.errors } : {}) } });
    }
    if (event.message) {
      const body = record(message.message);
      if (message.type === "system" && message.subtype === "compact_boundary") {
        const state = this.ensureContextState(sessionId);
        applyCompactBoundaryContext(state, message);
        await this.record({
          sessionId,
          ...(typeof message.uuid === "string" ? { itemId: message.uuid } : {}),
          origin: "claude-desktop",
          type: "session.compacted",
          data: { ...(state.totalTokens > 0 ? { postTokens: state.totalTokens } : {}) },
        });
      }
      if (message.type === "assistant" && message.isSynthetic !== true && body.model !== "<synthetic>") {
        applyAssistantMessageContext(this.ensureContextState(sessionId), message, body);
      }
      if (Array.isArray(body.content)) for (const rawBlock of body.content) {
        const block = record(rawBlock);
        if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") this.tools.set(block.id, { id: block.id, toolName: block.name, input: block.input, startedAt: Date.now() });
      }
      const projection = this.messageProjection.get(sessionId) ?? {};
      this.messageProjection.set(sessionId, projection);
      const items = nativeHistoryItems(sessionId, [event.message], projection);
      await this.enrichSubagentItems(sessionId, items);
      if (message.type === "system") this.projectSessions();
      for (const item of items) {
        const receipt = item.role === "user" ? [...this.receipts.values()].find(receipt => receipt.sessionId === sessionId && receipt.messageId === message.uuid) : undefined;
        if (item.role === "assistant") await this.options.eventLog.flushDeltas(sessionId);
        await this.record(nativeItemEventDraft(sessionId, item, receipt));
      }
      if (Array.isArray(body.content)) for (const rawBlock of body.content) {
        const block = record(rawBlock);
        if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
          const tool = this.tools.get(block.tool_use_id);
          this.tools.delete(block.tool_use_id);
          const started = this.options.eventLog.latestItem(sessionId, "tool.started", block.tool_use_id);
          const toolName = tool?.toolName ?? started?.data.toolName;
          if (toolName && toolName !== "mcp__ccd_turn__update_plan" && toolName !== "mcp__ccd_turn__wrap_up") {
            await this.record({ sessionId, itemId: block.tool_use_id, origin: "claude-desktop", type: "tool.completed", data: { toolName, text: tool ? JSON.stringify(tool.input ?? {}) : started?.data.text ?? "" } });
          }
          if (tool && this.options.evidence) {
            tool.output = block.content; tool.completedAt = Date.now();
            const input = record(tool.input);
            const paths = [input.file_path, input.path].filter((path): path is string => typeof path === "string");
            await this.options.evidence.upsertDesktopEvidence({ id: `native:${sessionId}:${tool.id}`, sessionId, cwd: this.session(sessionId)!.cwd, readCwd: this.executionCwd(sessionId)!, startedAt: tool.startedAt, completedAt: tool.completedAt, tools: [tool], paths });
          }
        }
      }
      if (message.type === "result") {
        applyResultModelUsageContext(this.contextStates.get(sessionId), message);
        if (!indexedResult) await this.record({ sessionId, ...(typeof message.uuid === "string" ? { itemId: message.uuid } : {}), origin: "claude-desktop", type: message.is_error === true ? "turn.failed" : "turn.completed", data: { ...(message.is_error === true ? { error: message.result ?? message.errors } : {}) } });
      }
    }
    if (event.type === "error") await this.record({ sessionId, origin: "claude-desktop", type: "turn.failed", data: { error: event.error } });
    this.projectSessions();
    this.emit("changed");
  }

  private async record(draft: BridgeEventDraft): Promise<void> {
    if (draft.sessionId && draft.itemId && this.options.eventLog.itemMatches(draft.sessionId, draft.type, draft.itemId, draft.data ?? {})) return;
    await this.options.eventLog.append(draft);
  }

  private report(error: unknown): void { this.lastError = error instanceof Error ? error.message : String(error); this.emit("changed"); }

  async gatewayConfig(): Promise<ClaudeGatewayConfig | undefined> {
    // Gateway credentials are used only by the optional quota/model query plugin, never to execute Claude.
    const credentialPath = await findClaudeHostCredentials();
    const base: ClaudeRuntime = { environment: { ...process.env }, ...(credentialPath ? { credentialPath } : {}) };
    this.gateway = await resolveClaudeGatewayConfig(this.options.magpieConnection?.apply(base) ?? base);
    return this.gateway;
  }
  magpieSettings() { return this.options.magpieConnection ? { magpie: this.options.magpieConnection.settings(this.gateway) } : {}; }
  async testMagpieConnection(input: unknown) {
    const repository = this.options.magpieConnection;
    if (!repository) throw new Error("Magpie connection settings are unavailable");
    const candidate = repository.apply({ environment: {} }, repository.resolve(input));
    return testMagpieGateway(candidate, await resolveClaudeGatewayConfig(candidate));
  }
  async saveMagpieConnection(input: unknown): Promise<void> {
    const repository = this.options.magpieConnection;
    if (!repository) throw new Error("Magpie connection settings are unavailable");
    await repository.save(repository.resolve(input));
    await this.gatewayConfig();
  }
}
