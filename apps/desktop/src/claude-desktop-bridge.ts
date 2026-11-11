import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { basename } from "node:path";
import type {
  BridgeAttachment, BridgeBackgroundTask, BridgeEffort, BridgeHistoryAttachment, BridgeHistoryItem, BridgeHistoryPage, BridgeModelInfo, BridgeNativeImageRef, BridgeNativePermissionMode, BridgeNativePermissionModeChange, BridgeOrigin,
  BridgePermissionDecision, BridgePermissionInfo, BridgeProjectInfo, BridgeRuntimeCapability,
  BridgeRuntimeStatus, BridgeSDKPermissionMode, BridgeSessionCommandResult,
  BridgeSessionConfiguration, BridgeSessionInfo, BridgeSessionRewindPreview, BridgeSessionRewindResult, BridgeSessionRewindScope, BridgeSlashCommandCatalog, BridgeTaskPlan, BridgeSubagentSummary,
} from "@bridge/protocol";
import { ClaudeDesktopInspector, InspectorDisconnectedError, NativeCallError, type NativeSectionCatalog } from "./claude-desktop-inspector.js";
import type { ConversationStateStore, NativeDesktopReceipt } from "./conversation-state-store.js";
import { extractInteractivePrompt, readClaudeTranscriptBackgroundTasks, readClaudeTranscriptSubagents, updateClaudeTaskPlan, visibleMessage } from "./claude-history.js";
import { claudeRuntimePaths } from "./platform.js";
import type { SessionEventLog, BridgeEventDraft } from "./session-event-log.js";
import type { EvidenceManager, ObservedDesktopTool } from "./evidence-manager.js";
import { oldestLiveProcessStart, projectIdForCwd, scanClaudeCatalog, type ClaudeCatalogSnapshot } from "./claude-session-catalog.js";
import { discoverClaudeProjectDirectory, findClaudeHostCredentials, magpieModelIdHash, parseMagpieSyntheticModelId, resolveClaudeGatewayConfig, type ClaudeGatewayConfig, type ClaudeProjectDirectory, type ClaudeRuntime } from "./claude-runtime-discovery.js";
import { MagpieConnectionRepository, testMagpieGateway } from "./magpie-connection.js";
import { readClaudeModelOptions } from "./connector.js";

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

interface NativeMessageProjection {
  plan?: BridgeTaskPlan;
  planObserved?: boolean;
  tasks?: Map<string, BridgeSubagentSummary>;
}

function nativePlanMessages(messages: unknown[]) {
  return messages.flatMap(raw => {
    const message = record(raw);
    if (message.isSidechain === true || message.parent_tool_use_id) return [];
    const body = record(message.message);
    return (Array.isArray(body.content) ? body.content : []).flatMap(rawBlock => {
      const block = record(rawBlock);
      if (block.type !== "tool_use" || typeof block.id !== "string" || !["mcp__ccd_turn__update_plan", "mcp__ccd_turn__wrap_up"].includes(String(block.name))) return [];
      return [{ type: message.type, timestamp: message.timestamp, message: { content: [block] } }];
    });
  });
}

/** Shared by history pages and live events; task state is projected from native messages. */
export function nativeHistoryItems(sessionId: string, messages: unknown[], projection: NativeMessageProjection = {}): BridgeHistoryItem[] {
  const items = new Map<string, BridgeHistoryItem>();
  for (const raw of messages) {
    const message = record(raw);
    if (message.isSidechain === true) continue;
    const body = record(message.message);
    const createdAt = typeof message.timestamp === "number" ? message.timestamp
      : typeof message.timestamp === "string" ? Date.parse(message.timestamp) || 0 : 0;
    if (message.type === "system" && typeof message.task_id === "string" && ["task_started", "task_progress", "task_notification"].includes(String(message.subtype))) {
      const tasks = projection.tasks ??= new Map();
      const previous = tasks.get(message.task_id);
      const status = message.subtype === "task_notification" ? message.status : "running";
      const state: BridgeSubagentSummary["state"] = status === "completed" || status === "failed" || status === "stopped" || status === "running" ? status : "unknown";
      const toolUseId = typeof message.tool_use_id === "string" ? message.tool_use_id : previous?.toolUseId;
      const task: BridgeSubagentSummary = {
        agentId: message.task_id, ...(toolUseId ? { toolUseId } : {}), state,
        ...(previous?.model ? { model: previous.model } : {}),
        description: typeof message.description === "string" ? message.description : previous?.description ?? "Agent",
        startedAt: previous?.startedAt ?? createdAt, updatedAt: createdAt,
        toolCount: typeof record(message.usage).tool_uses === "number" ? Number(record(message.usage).tool_uses) : previous?.toolCount ?? 0,
        ...(typeof message.summary === "string" ? { latestText: message.summary, ...(state !== "running" ? { reportText: message.summary } : {}) } : {}),
      };
      tasks.set(task.agentId, task);
      const id = toolUseId ?? task.agentId;
      items.set(id, { id, sessionId, role: "tool", toolName: "Agent", text: task.latestText ?? task.description, createdAt, origin: "claude-desktop", subagent: task });
    }
    if (message.parent_tool_use_id && (message.type === "assistant" || message.type === "user")) continue;
    const visible = visibleMessage(message);
    const interactivePrompt = extractInteractivePrompt(message);
    const id = message.type === "user" && typeof message.uuid === "string" ? message.uuid
      : typeof body.id === "string" ? body.id : typeof message.uuid === "string" ? message.uuid : undefined;
    const attachments: BridgeHistoryAttachment[] = [];
    if (visible?.role === "user" && typeof message.uuid === "string" && Array.isArray(body.content)) {
      let imageIndex = 0;
      for (const rawBlock of body.content) {
        const block = record(rawBlock);
        if (block.type !== "image") continue;
        const index = imageIndex++;
        const source = record(block.source);
        if (source.type !== "base64" || typeof source.data !== "string" || !["image/jpeg", "image/png", "image/gif", "image/webp"].includes(String(source.media_type))) continue;
        const mimeType = source.media_type as BridgeAttachment["mimeType"];
        attachments.push({
          id: `native-image:${message.uuid}:${index}`,
          name: typeof block.name === "string" ? block.name : typeof block.filename === "string" ? block.filename : `image-${index + 1}.${mimeType === "image/jpeg" ? "jpg" : mimeType.slice(6)}`,
          mimeType, size: Math.floor(source.data.length * 3 / 4) - (source.data.endsWith("==") ? 2 : source.data.endsWith("=") ? 1 : 0),
          nativeImage: { messageUuid: message.uuid, imageIndex: index },
        });
      }
    }
    if (id && (visible?.role || interactivePrompt)) items.set(id, {
      id, sessionId, role: visible?.role ?? "assistant",
      text: attachments.length && Array.isArray(body.content)
        ? body.content.flatMap(block => typeof block === "string" ? [block] : record(block).type === "text" && typeof record(block).text === "string" ? [String(record(block).text)] : []).join("\n\n")
        : visible?.text ?? "", createdAt,
      origin: "claude-desktop", ...(attachments.length ? { attachments } : {}), ...(interactivePrompt ? { interactivePrompt } : {}),
    });
    if (Array.isArray(body.content)) for (const rawBlock of body.content) {
      const block = record(rawBlock);
      if (block.type !== "tool_use" || typeof block.id !== "string" || typeof block.name !== "string") continue;
      if (block.name === "mcp__ccd_turn__update_plan" || block.name === "mcp__ccd_turn__wrap_up") {
        const wrapUp = block.name === "mcp__ccd_turn__wrap_up";
        const plan = updateClaudeTaskPlan(projection.plan, block.id, record(block.input), wrapUp, createdAt);
        if (plan || wrapUp) projection.planObserved = true;
        if (plan) {
          const planId = `plan:${plan.id}`;
          items.set(planId, { id: planId, sessionId, role: "assistant", text: "", createdAt: items.get(planId)?.createdAt ?? createdAt, origin: "claude-desktop", taskPlan: plan });
          projection.plan = plan;
        }
        if (wrapUp) delete projection.plan;
      } else items.set(block.id, { id: block.id, sessionId, role: "tool", toolName: block.name, text: JSON.stringify(block.input ?? {}), createdAt, origin: "claude-desktop" });
    }
  }
  return [...items.values()];
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
      ["start", "session.create"], ["forkSession", "session.fork"], ["sendMessage", "turn.start"],
      ["sendMessage", "turn.steer"], ["interrupt", "turn.interrupt"], ["setModel", "session.configure"],
      ["respondToToolPermission", "permission.resolve"], ["sendMessage", "attachment.image"],
    ];
    for (const [method, capability] of methods) if (this.inspector.supports(method)) capabilities.push(capability);
    if (["canRewindTo", "rewindV2", "rewindFiles"].every(method => this.inspector.supports(method))) capabilities.push("session.rewind");
    if (this.sectionCatalog && this.inspector.createSection && this.inspector.assignSection) capabilities.push("section.create");
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
    const exact = this.models?.find(option => option.value === model);
    if (exact) return exact;
    const alias = parseMagpieSyntheticModelId(model);
    const matched = alias ? this.models?.find(option => magpieModelIdHash(option.value) === alias.hash && /\[1m\]$/iu.test(option.value) === alias.longContext) : undefined;
    if (matched) return matched;
    if (!/\[1m\]$/iu.test(model)) return undefined;
    const base = this.models?.find(option => model === `${option.value}[1m]`)
      ?? (alias ? this.models?.find(option => !/\[1m\]$/iu.test(option.value) && magpieModelIdHash(option.value) === alias.hash) : undefined);
    // Desktop's provider can prefer 1M even when the saved picker only lists
    // the base model. Preserve the actual context in the returned value/label.
    return base ? { ...base, value: `${base.value}[1m]`, displayName: `${base.displayName} · 1M` } : undefined;
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

  private projectSessions(): void {
    this.sessions.clear();
    const ready = this.inspector.ready;
    for (const native of this.native.values()) {
      const sessionId = native.sessionId;
      const tasks = [...this.messageProjection.get(sessionId)?.tasks?.values() ?? []].filter(task => task.state === "running");
      const waiting = [...this.permissions.values()].some(permission => permission.sessionId === sessionId);
      const running = native.turnRunning === true;
      const pendingCommandIds = [...this.receipts.values()].filter(receipt => receipt.sessionId === sessionId && receipt.state === "queued").map(receipt => receipt.commandId);
      const modeChange = this.permissionModeChanges.get(sessionId);
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
        ...(parentSessionId ? { parentSessionId } : {}),
        ...(native.spawnedFrom?.btw === true && native.lineageDetached !== true ? { sidechat: true } : {}),
        ...(native.isArchived ? { archivedAt: native.lastActivityAt ?? native.createdAt ?? 1 } : {}),
        subagentStopScope: "task", ...(tasks.length ? { runningSubagents: { count: tasks.length, lastUpdatedAt: Math.max(...tasks.map(task => task.updatedAt)) } } : {}),
        ...(modeChange ? { nativePermissionModeChange: {
          ...modeChange,
          ...(modeChange.state !== "requested" ? { state: native.permissionMode === modeChange.mode ? "confirmed" as const : "not-applied" as const, ...(native.permissionMode ? { observedMode: native.permissionMode } : {}) } : {}),
        } } : {}),
        allowedActions: {
          canSend: ready && this.inspector.supports("sendMessage"), canSteer: ready && this.inspector.supports("sendMessage"),
          canInterrupt: ready && this.inspector.supports("interrupt") && (running || native.hasBackgroundWork === true),
          canSwitchProvider: false, canContinueOfficial: false, canRelay: false,
          canConfigure: ready && this.inspector.supports("setModel"),
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

  async createSession(cwd: string, title?: string, projectId?: string): Promise<BridgeSessionInfo> {
    if (projectId && !await this.refreshRuntime()) throw new NativeCallError(this.lastError);
    const project = projectId ? this.listProjects().find(project => project.projectId === projectId) : undefined;
    if (projectId && !project) throw new NativeCallError("Selected Desktop project is no longer available");
    const result = record(await this.inspector.call("start", [{ cwd, title, sessionId: `local_${randomUUID()}`, withoutFirstMessage: true, message: "" }]));
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

  private async enrichSubagentItems(sessionId: string, items: BridgeHistoryItem[]): Promise<void> {
    const agents = items.filter(item => item.subagent || item.toolName === "Agent" || item.toolName === "Task");
    if (!agents.length) return;
    const local = await this.transcriptSubagents(sessionId);
    for (const item of agents) {
      const child = local?.subagents.find(agent => agent.toolUseId === item.id || agent.agentId === item.subagent?.agentId);
      if (child?.model) {
        if (item.subagent) item.subagent.model = child.model;
        else item.subagent = child;
      }
    }
  }

  async backgroundTaskDetails(sessionId: string): Promise<BridgeBackgroundTask[]> {
    const id = this.desktopId(sessionId);
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
    const page = record(await this.inspector.call("getTranscriptPage", [id, cursor ?? "", limit, { window: "accept" }]));
    if (!Array.isArray(page.messages)) throw new NativeCallError("Desktop returned an invalid transcript page");
    const nextCursor = page.hasMore === true && typeof record(page.messages[0]).uuid === "string" ? String(record(page.messages[0]).uuid) : undefined;
    const firstPlan = nativePlanMessages(page.messages)[0]?.message.content[0];
    let boundaryFound = firstPlan?.name === "mcp__ccd_turn__update_plan" && ["first_task", "new_task"].includes(String(record(firstPlan.input).scope));
    const context: unknown[] = [];
    let before = nextCursor;
    while (!boundaryFound && before) {
      const older = record(await this.inspector.call("getTranscriptPage", [id, before, limit, { window: "accept" }]));
      if (!Array.isArray(older.messages)) throw new NativeCallError("Desktop returned an invalid transcript page");
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
    await this.enrichSubagentItems(sessionId, items);
    if (!cursor) {
      const liveProjection = this.messageProjection.get(sessionId) ?? {};
      if (!liveProjection.planObserved && projection.planObserved) {
        if (projection.plan) liveProjection.plan = projection.plan;
        else delete liveProjection.plan;
        liveProjection.planObserved = true;
        this.messageProjection.set(sessionId, liveProjection);
      }
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
    const message = messages.find(raw => record(raw).type === "user" && record(raw).uuid === ref.messageUuid);
    const attachment = nativeHistoryItems(sessionId, [message])[0]?.attachments?.find(image => image.nativeImage?.imageIndex === ref.imageIndex);
    if (!attachment) throw new NativeCallError("Native image not found");
    const content = record(record(message).message).content as unknown[];
    const block = content.filter(raw => record(raw).type === "image")[ref.imageIndex];
    return { artifactId: attachment.id, name: attachment.name, mimeType: attachment.mimeType, bytes: Buffer.from(String(record(record(block).source).data), "base64") };
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
    const native = nativeSession(await this.inspector.call("getSession", [this.desktopId(sessionId)]));
    this.models = await readClaudeModelOptions(this.options.settingsPath);
    await this.observeNativeSession(native);
    this.projectSessions();
    const model = native.model ? this.savedModel(native.model) : undefined;
    return {
      sessionId, ...(native.model ? { model: model?.value ?? native.model, modelDisplayName: model?.displayName ?? native.model } : {}), ...(native.effort ? { effort: native.effort } : {}),
      ...(native.permissionMode ? { nativePermissionMode: native.permissionMode } : {}),
      modelSource: "claude-desktop", effortSource: "claude-desktop",
      availableModels: this.models ? [...this.models, ...(model && !this.models.some(option => option.value === model.value) ? [model] : [])]
        : native.model ? [{ value: native.model, displayName: native.model }] : [],
      availableEffortLevels: ["low", "medium", "high", "xhigh", "max"],
      modelsComplete: this.models !== undefined, appliesAfterTurn: native.turnRunning === true,
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
    if (message.isSidechain === true || (message.parent_tool_use_id && (message.type === "assistant" || message.type === "user"))) {
      this.emit("changed");
      return;
    }
    const stream = record(message.event);
    if (message.type === "stream_event" && !message.parent_tool_use_id) {
      if (stream.type === "message_start") {
        const id = record(stream.message).id;
        if (typeof id === "string") this.streams.set(sessionId, id);
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
        await this.record({ sessionId, itemId: item.id, ...(receipt ? { turnId: receipt.messageId } : {}), origin: "claude-desktop", type: item.role === "user" ? "user.message.accepted" : item.role === "tool" ? item.subagent ? item.subagent.state === "running" ? "tool.progress" : "tool.completed" : "tool.started" : "assistant.completed", data: { text: item.text, ...(item.attachments ? { attachments: item.attachments } : {}), ...(receipt ? { commandId: receipt.commandId, requestId: receipt.requestId, messageId: receipt.messageId, delivery: receipt.state === "dispatching" ? "host-received" : receipt.state } : {}), ...(item.toolName ? { toolName: item.toolName } : {}), ...(item.interactivePrompt ? { interactivePrompt: item.interactivePrompt } : {}), ...(item.taskPlan ? { taskPlan: item.taskPlan, taskPlanSource: "native-main" } : {}), ...(item.subagent ? { subagent: item.subagent } : {}) } });
      }
      if (Array.isArray(body.content)) for (const rawBlock of body.content) {
        const block = record(rawBlock);
        if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
          const tool = this.tools.get(block.tool_use_id);
          const started = this.options.eventLog.latestItem(sessionId, "tool.started", block.tool_use_id);
          const toolName = tool?.toolName ?? started?.data.toolName;
          if (toolName && toolName !== "mcp__ccd_turn__update_plan" && toolName !== "mcp__ccd_turn__wrap_up") {
            await this.record({ sessionId, itemId: block.tool_use_id, origin: "claude-desktop", type: "tool.completed", data: { toolName, text: tool ? JSON.stringify(tool.input ?? {}) : started?.data.text ?? "", output: block.content } });
          }
          if (tool && this.options.evidence) {
            tool.output = block.content; tool.completedAt = Date.now();
            const input = record(tool.input);
            const paths = [input.file_path, input.path].filter((path): path is string => typeof path === "string");
            await this.options.evidence.upsertDesktopEvidence({ id: `native:${sessionId}:${tool.id}`, sessionId, cwd: this.session(sessionId)!.cwd, readCwd: this.executionCwd(sessionId)!, startedAt: tool.startedAt, completedAt: tool.completedAt, tools: [tool], paths });
          }
        }
      }
      if (message.type === "result" && !indexedResult) await this.record({ sessionId, ...(typeof message.uuid === "string" ? { itemId: message.uuid } : {}), origin: "claude-desktop", type: message.is_error === true ? "turn.failed" : "turn.completed", data: { ...(message.is_error === true ? { error: message.result ?? message.errors } : {}) } });
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
