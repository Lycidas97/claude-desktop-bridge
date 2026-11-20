import { randomUUID } from "node:crypto";
import { EventEmitter, on } from "node:events";
import { realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import {
  BRIDGE_EFFORT_LEVELS,
  CLAUDE_UNSECTIONED_PROJECT_ID,
  CLAUDE_UNSECTIONED_PROJECT_NAME,
  DEFAULT_CONFIGURATION_SESSION_ID,
  isBridgeEffort,
  type BridgeAttachment, type BridgeBackgroundTask, type BridgeEffort, type BridgeHistoryItem, type BridgeHistoryPage, type BridgeModelInfo, type BridgeNativeImageRef, type BridgeNativePermissionMode, type BridgeNativePermissionModeChange, type BridgeOrigin,
  type BridgePendingPrompt, type BridgePermissionDecision, type BridgePermissionInfo, type BridgePrAutoFixState, type BridgePrAutoFixUpdate, type BridgeProjectInfo, type BridgePullRequest, type BridgeRuntimeCapability,
  type BridgeRuntimeStatus, type BridgeSDKPermissionMode, type BridgeSessionCommandResult,
  type BridgeSessionConfiguration, type BridgeSessionContextUsage, type BridgeSessionInfo, type BridgeSessionRewindPreview, type BridgeSessionRewindResult, type BridgeSessionRewindScope, type BridgeSlashCommandCatalog, type BridgeSubagentSummary, type BridgeToolCallDetail,
} from "@bridge/protocol";
import { diag, diagnostics } from "../app/diag.js";
import { ClaudeDesktopInspector, InspectorDisconnectedError, InspectorNotDispatchedError, NativeCallError, type NativeSectionCatalog } from "./claude-desktop-inspector.js";
import type { ConversationStateStore, NativeDesktopReceipt } from "../controller/conversation-state-store.js";
import { readClaudeTranscriptBackgroundTasks, readClaudeTranscriptSubagents, visibleMessage } from "../transcript/claude-history.js";
import { extractToolCallDetailFromMessages, readSubagentToolCallDetail, summarizeNativeToolInput } from "../transcript/transcript-tool-detail.js";
import { claudeRuntimePaths } from "../app/platform.js";
import type { SessionEventLog, BridgeEventDraft } from "../controller/session-event-log.js";
import type { EvidenceManager, ObservedDesktopTool } from "../evidence/evidence-manager.js";
import { findClaudeSessionTranscript, oldestLiveProcessStart, projectIdForCwd, type ClaudeCatalogSnapshot } from "./claude-session-catalog.js";
import {
  discoverClaudeGateway,
  discoverClaudeGatewayConfig,
  discoverClaudeProjectDirectory,
  fetchClaudeGatewayModels,
  normalizeAnthropicModelSlug,
  parseMagpieSyntheticModelId,
  resolveClaudeGatewayConfig,
  type ClaudeGatewayConfig,
  type ClaudeGatewayDiscovery,
  type ClaudeProjectDirectory,
} from "./claude-runtime-discovery.js";
import { MagpieConnectionRepository, testMagpieGateway } from "./magpie-connection.js";
import { claudeModelSettings, readClaudeConfig } from "./connector.js";
import {
  applyAssistantMessageContext,
  applyCompactBoundaryContext,
  applyLiveContextUsageState,
  applyResultModelUsageContext,
  applyStreamDeltaContext,
  applyStreamStartContext,
  buildTranscriptContextState,
  createNativeContextState,
  extractLatestTranscriptModel,
  hydrateObservedContextModel,
  parseLiveContextUsage,
  projectedContextUsage,
  type NativeContextState,
} from "./native-context-usage.js";
import { readNativeHistoryPage, readNativeTranscriptPage } from "./native-history-pagination.js";
import { directModelDisplayName, mergeModelCatalog, modelOptionHash, resolveSessionModel, savedModelOption } from "./native-model-catalog.js";
import {
  enrichNativeSubagentItems,
  extractNativeImageAttachment,
  nativeHistoryItems,
  nativeItemEventDraft,
  nativeSentFileReceipt,
  type NativeMessageProjection,
} from "./native-history-projection.js";

import { NATIVE_PROMPTS, nativePendingPrompts, nativePullRequests, type NativePromptSession } from "./native-prompts.js";
import { generateSessionTitle, resolveActiveClaudeGateway } from "./session-title-generator.js";

export {
  CLAUDE_UNSECTIONED_PROJECT_ID,
  CLAUDE_UNSECTIONED_PROJECT_NAME,
  DEFAULT_CONFIGURATION_SESSION_ID,
  nativeHistoryItems,
};

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

interface NativeSession extends NativePromptSession {
  sessionId: string;
  cwd: string;
  harnessCwd?: string;
  title?: string;
  model?: string;
  effort?: BridgeEffort;
  permissionMode?: BridgeSDKPermissionMode;
  outputStyle?: string;
  availableOutputStyles?: string[];
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
  prs?: BridgePullRequest[];
  autoArchiveOnPrClose?: boolean;
  hasBackgroundWork?: boolean;
}

interface InspectorTransport {
  readonly ready: boolean;
  supports(method: string): boolean;
  connect(): Promise<void>;
  close(): Promise<void>;
  call(method: string, args?: unknown[]): Promise<unknown>;
  availableCodeModels(): Promise<string[]>;
  diagnosticsGauges?(): {
    state: "connected" | "connecting" | "disconnected";
    pendingCalls: { count: number; oldestMs: number };
    eventStreamWaiting: boolean;
    supportedMethods: number;
  };
  inputQueueDrained?(sessionId: string): Promise<boolean>;
  sections?(sessionIds: string[]): Promise<NativeSectionCatalog | undefined>;
  prPreferences?(sessionId: string): Promise<{ onlyOwnPrs: boolean; nextOwnPrArmed: boolean } | undefined>;
  promptChoices?(sessionId: string, promptId: string): Promise<string[] | undefined>;
  startAutoFixOnNextPr?(sessionId: string, branch: string): Promise<void>;
  createSection?(name: string): Promise<string>;
  assignSection?(sessionId: string, sectionId: string): Promise<void>;
  renameSection?(sectionId: string, name: string): Promise<void>;
  deleteSection?(sectionId: string): Promise<void>;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

interface NativeInput {
  requestId: string;
  idempotencyKey: string;
  sessionId: string;
  text: string;
  displayText?: string;
  attachments?: BridgeAttachment[];
  origin: BridgeOrigin;
  sourceDeviceId?: string;
  source?: "assistant-trigger";
  nativeTurnRunning?: boolean;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function nativeSession(value: unknown): NativeSession {
  const session = record(value);
  if (typeof session.sessionId !== "string" || typeof session.cwd !== "string") throw new NativeCallError("Desktop returned an invalid session");
  return {
    ...session,
    effort: isBridgeEffort(session.effort) ? session.effort : undefined,
    outputStyle: typeof session.outputStyle === "string" ? session.outputStyle : undefined,
    availableOutputStyles: Array.isArray(session.availableOutputStyles) ? outputStyleNames(session.availableOutputStyles) : undefined,
    prs: nativePullRequests(session.prs),
  } as unknown as NativeSession;
}

function outputStyleNames(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((name): name is string => typeof name === "string" && name !== "") : [];
}

type QueryGatewayDiscovery = ClaudeGatewayDiscovery & { mode: "auto" | "manual" };

/** Protocol translation and transport receipts only. Desktop owns every Claude execution. */
export class ClaudeDesktopBridge extends EventEmitter {
  private readonly inspector: InspectorTransport;
  private readonly native = new Map<string, NativeSession>();
  private sectionCatalog: NativeSectionCatalog | undefined;
  private readonly projectDirectories = new Map<string, ClaudeProjectDirectory>();
  private readonly sessions = new Map<string, BridgeSessionInfo>();
  private readonly lastCompletedTurns = new Map<string, string>();
  private readonly replyTurns = new Map<string, { rootId?: string; reply?: { id: string; text: string } }>();
  private readonly permissions = new Map<string, BridgePermissionInfo>();
  private readonly prompts = new Map<string, BridgePendingPrompt>();
  private readonly prPreferences = new Map<string, { onlyOwnPrs: boolean; nextOwnPrArmed: boolean }>();
  private readonly receivedInputs = new Map<string, Set<NativeDesktopReceipt>>();
  private readonly receipts = new Map<string, NativeDesktopReceipt>();
  private readonly messageProjection = new Map<string, NativeMessageProjection>();
  private readonly contextStates = new Map<string, NativeContextState>();
  private readonly backgroundTasks = new Map<string, BridgeBackgroundTask[]>();
  private readonly transcriptSubagentsInFlight = new Map<string, Promise<{
    transcriptPath: string;
    liveSince: number | undefined;
    subagents: BridgeSubagentSummary[];
  } | undefined>>();
  private readonly backgroundTasksInFlight = new Map<string, Promise<BridgeBackgroundTask[]>>();
  private readonly permissionModeChanges = new Map<string, BridgeNativePermissionModeChange>();
  private readonly resolvingPermissions = new Set<string>();
  private readonly streams = new Map<string, string>();
  private readonly compactingSessions = new Set<string>();
  private readonly tools = new Map<string, ObservedDesktopTool>();
  private readonly autoTitledSessions = new Set<string>();
  private readonly explicitlyTitledSessions = new Set<string>();
  private readonly deletingSessions = new Set<string>();
  private readonly closeAbort = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private eventProjection: ReturnType<typeof setImmediate> | undefined;
  private pendingEvents = 0;
  private closed = false;
  private lastError = "Claude Desktop inspector 尚未连接";
  private gateway: ClaudeGatewayConfig | undefined;
  private readonly gatewayModelsCache: Partial<Record<QueryGatewayDiscovery["mode"], {
    gatewayKey: string;
    fetchedAt: number;
    ok: boolean;
    source: "gateway" | "profile";
    models: BridgeModelInfo[];
  }>> = {};
  private models: BridgeModelInfo[] | undefined;
  private desktopPickerModels: BridgeModelInfo[] | undefined;
  private defaultModel: string | undefined;
  private snapshotQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: {
    settingsPath: string;
    eventLog: SessionEventLog;
    conversationState: ConversationStateStore;
    evidence?: Pick<EvidenceManager, "upsertDesktopEvidence">;
    magpieConnection?: MagpieConnectionRepository;
    environment?: NodeJS.ProcessEnv;
    home?: string;
    platform?: NodeJS.Platform;
    fetchImpl?: typeof fetch;
    now?: () => number;
    gatewayModelsCacheMs?: number;
    inspector?: InspectorTransport;
    scanCatalog?: () => Promise<ClaudeCatalogSnapshot>;
    refreshIntervalMs?: number;
    autoTitleGraceMs?: number;
    assistantWorkspacePath?: string;
  }) {
    super();
    this.inspector = options.inspector ?? new ClaudeDesktopInspector(process.env.BRIDGE_CLAUDE_INSPECTOR_URL ? { origin: process.env.BRIDGE_CLAUDE_INSPECTOR_URL } : {});
    this.inspector.on("event", value => {
      const settled = diagnostics.begin("native.event");
      this.pendingEvents++;
      void this.handleEvent(value).catch(error => this.report(error)).finally(() => {
        settled();
        this.pendingEvents--;
        this.scheduleEventProjection();
      });
    });
    this.inspector.on("permission", value => { this.observePermission(value); this.projectSessions(); this.emit("changed"); });
    this.inspector.on("disconnected", () => {
      this.lastError = "Claude Desktop inspector 已断开；请在 Desktop 开发者菜单开启 Node inspector";
      void this.serialized(async () => {
        this.compactingSessions.clear();
        this.projectSessions();
        this.emit("changed");
      }).catch(error => this.report(error));
    });
    this.inspector.on("stream-error", error => this.report(error));
  }

  async initialize(): Promise<void> {
    for (const receipt of this.options.conversationState.listNativeDesktopReceipts()) {
      if (receipt.state === "dispatching" && !receipt.notDispatched) {
        receipt.state = "uncertain";
        this.options.conversationState.saveNativeDesktopReceipt(receipt);
      }
      this.receipts.set(receipt.commandId, receipt);
      if (receipt.state === "session-received" && !receipt.queueSettled) this.trackReceivedInput(receipt);
    }
    await this.options.magpieConnection?.initialize();
    await this.refreshRuntime();
    this.scheduleRefresh();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.closeAbort.abort();
    clearTimeout(this.timer);
    clearImmediate(this.eventProjection);
    await this.inspector.close();
  }

  private scheduleRefresh(): void {
    if (this.closed) return;
    this.timer = setTimeout(() => { void this.refreshRuntime().finally(() => this.scheduleRefresh()); }, this.options.refreshIntervalMs ?? 2_000);
    this.timer.unref?.();
  }

  /** Snapshot reads and their application run one at a time, so an older getAll can never overwrite a newer event's state. */
  private serialized<T>(task: () => Promise<T>): Promise<T> {
    const run = this.snapshotQueue.then(task);
    this.snapshotQueue = run.catch(() => undefined);
    return run;
  }

  refreshRuntime(): Promise<boolean> {
    return this.serialized(() => this.applyRuntimeSnapshot());
  }

  private async applyRuntimeSnapshot(): Promise<boolean> {
    diag("refresh.start", { ready: this.inspector.ready });
    let settings: ReturnType<typeof readClaudeConfig> | undefined;
    const readSettings = () => settings ??= readClaudeConfig(this.options.settingsPath);
    try {
      let sessions: NativeSession[];
      let discovery: QueryGatewayDiscovery | undefined;
      try {
        if (!this.inspector.ready) await this.inspector.connect();
        diag("refresh.connected");
        const result = await this.inspector.call("getAll");
        if (!Array.isArray(result)) throw new NativeCallError("Desktop getAll did not return a session list");
        diag("refresh.getAll", { count: result.length });
        sessions = result.map(nativeSession);
        this.sectionCatalog = await this.inspector.sections?.(sessions.map(session => session.sessionId));
        diag("refresh.sections");
      } finally {
        // Use the gateway saved during inspector reads and publish settings even if those reads fail.
        if (this.options.magpieConnection) discovery = await this.discoverGateway(readSettings);
      }
      await this.refreshModelCatalog("cached", readSettings, discovery);
      diag("refresh.models");
      this.native.clear();
      for (const session of sessions) await this.observeNativeSession(session);
      diag("refresh.observed", { count: sessions.length });
      for (const [promptId, prompt] of this.prompts) if (!this.native.has(prompt.sessionId)) {
        this.prompts.delete(promptId);
        await this.record({ sessionId: prompt.sessionId, itemId: promptId, origin: "claude-desktop", type: "prompt.resolved", data: { promptId, automatic: true } });
      }
      this.permissions.clear();
      for (const session of sessions) for (const permission of session.pendingToolPermissions ?? []) this.observePermission(permission, session.sessionId);
      this.projectSessions();
      this.lastError = "";
      this.emit("changed");
      diag("refresh.done", { ok: true });
      return true;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.projectSessions();
      this.emit("changed");
      diag("refresh.done", { ok: false });
      return false;
    }
  }

  canProvisionAssistantWorkspace(): boolean {
    return this.inspector.ready && ["start", "saveTrust", "setPermissionMode", "getSession"].every(method => this.inspector.supports(method));
  }

  private isAssistantWorkspace(cwd: string): boolean {
    return Boolean(this.options.assistantWorkspacePath && relative(this.options.assistantWorkspacePath, cwd) === "");
  }

  capabilities(): BridgeRuntimeCapability[] {
    const capabilities: BridgeRuntimeCapability[] = ["session.list", "session.history"];
    if (!this.inspector.ready) return capabilities;
    const methods: Array<[string, BridgeRuntimeCapability]> = [
      ["start", "session.create"], ["saveTrust", "workspace.trust"], ["forkSession", "session.fork"], ["sendMessage", "turn.start"],
      ["sendMessage", "turn.steer"], ["interrupt", "turn.interrupt"], ["setModel", "session.configure"],
      ["applyFlagSettings", "session.output-style"],
      ["respondToToolPermission", "permission.resolve"], ["sendMessage", "attachment.image"],
    ];
    for (const [method, capability] of methods) if (this.inspector.supports(method)) capabilities.push(capability);
    if (["canRewindTo", "rewindV2", "rewindFiles"].every(method => this.inspector.supports(method))) capabilities.push("session.rewind");
    if (this.sectionCatalog && this.inspector.createSection && this.inspector.assignSection) capabilities.push("section.create");
    if (this.sectionCatalog && this.inspector.assignSection) capabilities.push("section.move");
    if (this.sectionCatalog?.canRename && this.inspector.renameSection) capabilities.push("section.rename");
    if (this.sectionCatalog?.canDelete && this.inspector.deleteSection) capabilities.push("section.delete");
    if (NATIVE_PROMPTS.some(spec => this.inspector.supports(spec.method))) capabilities.push("prompt.resolve");
    if (["setBoundPrAutoFix", "setAutoFixOwnPrsWanted", "armAutoFixOnNextPr", "getPrOverview", "getPrChecks"].some(method => this.inspector.supports(method))) capabilities.push("pr.autofix");
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

  private resolveSessionModel(sessionId: string | undefined, nativeModel: string | undefined, models = this.models) {
    return resolveSessionModel({
      nativeModel,
      contextModel: sessionId ? this.contextStates.get(sessionId)?.model : undefined,
      models,
      defaultModel: this.defaultModel,
    });
  }

  private async hydrateContextModel(
    sessionId: string,
    nativeModel: string | undefined,
    page?: { messages: readonly unknown[]; hasMore: boolean },
  ): Promise<void> {
    if (directModelDisplayName(nativeModel, this.models) || this.contextStates.get(sessionId)?.model) return;
    const tailLimit = 20;
    if (page) {
      const pageModel = extractLatestTranscriptModel(page.messages);
      if (pageModel) {
        hydrateObservedContextModel(this.ensureContextState(sessionId), pageModel);
        return;
      }
      if (!page.hasMore || page.messages.length >= tailLimit) return;
    }
    if (!this.inspector.ready || !this.inspector.supports("getTranscriptPage")) return;
    try {
      const tail = await readNativeTranscriptPage(this.inspector, sessionId, "", tailLimit);
      if (!tail) return;
      const tailModel = extractLatestTranscriptModel(tail.messages);
      if (tailModel) {
        hydrateObservedContextModel(this.ensureContextState(sessionId), tailModel);
      }
    } catch (error) {
      if (error instanceof InspectorDisconnectedError || error instanceof NativeCallError) return;
      throw error;
    }
  }

  private async refreshModelCatalog(
    mode: "cached" | "retry-failed" | "force",
    readSettings = () => readClaudeConfig(this.options.settingsPath),
    discovery?: QueryGatewayDiscovery,
  ): Promise<void> {
    const settings = readSettings();
    const { models: saved, defaultModel } = claudeModelSettings(await settings);
    this.desktopPickerModels = saved;
    this.defaultModel = defaultModel;
    if (!this.options.magpieConnection && !this.options.fetchImpl) {
      this.models = saved;
      return;
    }
    const { gateway, offlineModels, mode: queryMode } = discovery ?? await this.discoverGateway(() => settings);
    if (!gateway) {
      delete this.gatewayModelsCache[queryMode];
      this.models = saved;
      return;
    }
    const now = (this.options.now ?? Date.now)();
    const ttl = this.options.gatewayModelsCacheMs ?? 60_000;
    const gatewayKey = JSON.stringify(gateway);
    const entry = this.gatewayModelsCache[queryMode];
    const cached = entry?.gatewayKey === gatewayKey ? entry : undefined;
    const canReuse = Boolean(cached && now - cached.fetchedAt < ttl && (
      mode === "cached" || (mode === "retry-failed" && cached.ok)
    ));
    let discovered = canReuse ? cached!.models : undefined;
    if (!canReuse) {
      try {
        const fetched = await fetchClaudeGatewayModels(gateway, this.options.fetchImpl);
        discovered = fetched;
        this.gatewayModelsCache[queryMode] = { gatewayKey, fetchedAt: now, ok: true, source: "gateway", models: fetched };
      } catch {
        if (cached && cached.models.length > 0) {
          discovered = cached.models;
          this.gatewayModelsCache[queryMode] = { ...cached, fetchedAt: now, ok: false };
        } else {
          const offline = await offlineModels?.() ?? [];
          discovered = offline;
          this.gatewayModelsCache[queryMode] = { gatewayKey, fetchedAt: now, ok: false, source: "profile", models: offline };
        }
      }
    }
    this.models = mergeModelCatalog(saved, discovered);
  }

  private trackReceivedInput(receipt: NativeDesktopReceipt): void {
    const inputs = this.receivedInputs.get(receipt.sessionId);
    if (inputs) inputs.add(receipt);
    else this.receivedInputs.set(receipt.sessionId, new Set([receipt]));
  }

  private async settleReceivedInputs(session: NativeSession): Promise<void> {
    const inputs = this.receivedInputs.get(session.sessionId);
    if (!inputs || session.turnRunning !== false) return;
    // Only settle acknowledgements that predate the Native read. New input can arrive during IPC.
    for (const receipt of inputs) if (receipt.state !== "session-received") inputs.delete(receipt);
    const received = [...inputs];
    const drained = received.length > 0 && await this.inspector.inputQueueDrained?.(session.sessionId).catch(error => {
      if (error instanceof InspectorDisconnectedError) return false;
      throw error;
    });
    if (drained) {
      for (const receipt of received) {
        if (!inputs.delete(receipt) || receipt.state !== "session-received") continue;
        receipt.queueSettled = true;
        this.options.conversationState.saveNativeDesktopReceipt(receipt);
        await this.record({ sessionId: receipt.sessionId, itemId: receipt.messageId, origin: "claude-desktop", type: "message.delivery", data: { commandId: receipt.commandId, messageId: receipt.messageId, delivery: receipt.state, queueSettled: true } });
      }
    }
    if (!inputs.size) this.receivedInputs.delete(session.sessionId);
  }

  private async observeNativeSession(session: NativeSession): Promise<void> {
    if (!this.projectDirectories.has(session.cwd)) this.projectDirectories.set(session.cwd, await discoverClaudeProjectDirectory(session.cwd));
    this.native.set(session.sessionId, session);
    if (session.turnRunning) this.ensureContextState(session.sessionId, session.model ?? "default");
    else {
      this.compactingSessions.delete(session.sessionId);
      await this.settleReceivedInputs(session);
    }
    const previous = this.promptsList(session.sessionId);
    const current = await nativePendingPrompts(session, this.inspector);
    for (const prompt of previous) this.prompts.delete(prompt.promptId);
    for (const prompt of current) {
      this.prompts.set(prompt.promptId, prompt);
      if (!previous.some(old => old.promptId === prompt.promptId)) await this.record({ sessionId: session.sessionId, itemId: prompt.promptId, origin: "claude-desktop", type: "prompt.requested", data: { ...prompt } });
    }
    for (const prompt of previous) if (!this.prompts.has(prompt.promptId)) await this.record({ sessionId: session.sessionId, itemId: prompt.promptId, origin: "claude-desktop", type: "prompt.resolved", data: { promptId: prompt.promptId, automatic: true } });
  }

  private projectCwd(cwd: string): string {
    const project = this.projectDirectories.get(cwd)!;
    if (project.cwd === cwd) return cwd;
    // Keep the original main-project spelling (and its saved ordering ID).
    return [...this.projectDirectories].find(([original, candidate]) => original === candidate.cwd && candidate.realCwd === project.realCwd)?.[0] ?? project.cwd;
  }

  private ensureContextState(sessionId: string, turnModel?: string): NativeContextState {
    let state = this.contextStates.get(sessionId);
    if (!state) {
      state = createNativeContextState();
      this.contextStates.set(sessionId, state);
    }
    // Native setModel selects the next turn while the current turn keeps its model.
    if (turnModel !== undefined) state.turnModel ??= turnModel;
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
    const native = this.native.get(sessionId);
    const state = this.ensureContextState(sessionId, native?.turnRunning ? native.model ?? "default" : undefined);
    applyLiveContextUsageState(state, live, state.turnModel ?? native?.model);
  }

  private applyTranscriptContextMessages(sessionId: string, messages: readonly unknown[], priorLiveSample: symbol | undefined): void {
    const current = this.contextStates.get(sessionId);
    const preserveLiveUsage = current?.liveUsageSample !== undefined && current.liveUsageSample !== priorLiveSample;
    this.contextStates.set(sessionId, buildTranscriptContextState(messages, current, preserveLiveUsage));
  }

  private projectSessions(): void {
    diag("project.start", { count: this.native.size });
    this.sessions.clear();
    const ready = this.inspector.ready;
    const queuedBySession = new Map<string, string[]>();
    for (const receipt of this.native.size ? this.receipts.values() : []) {
      if (receipt.state !== "queued") continue;
      const { sessionId, commandId } = receipt;
      const ids = queuedBySession.get(sessionId);
      if (ids) ids.push(commandId);
      else queuedBySession.set(sessionId, [commandId]);
    }
    for (const native of this.native.values()) {
      const sessionId = native.sessionId;
      const tasks = [...this.messageProjection.get(sessionId)?.tasks?.values() ?? []].filter(task => task.state === "running");
      const runningSubagents = tasks.length
        ? { count: tasks.length, lastUpdatedAt: Math.max(...tasks.map(task => task.updatedAt)) }
        : native.hasBackgroundWork === true
          ? { count: 1, lastUpdatedAt: native.lastActivityAt ?? native.createdAt ?? 0 }
          : undefined;
      const waiting = [...this.permissions.values()].some(permission => permission.sessionId === sessionId) || [...this.prompts.values()].some(prompt => prompt.sessionId === sessionId);
      const running = native.turnRunning === true;
      const pendingCommandIds = queuedBySession.get(sessionId) ?? [];
      const modeChange = this.permissionModeChanges.get(sessionId);
      const contextUsage = this.projectedContextUsage(sessionId, native.model);
      const lastCompletedTurnId = this.lastCompletedTurns.get(sessionId);
      const parentSessionId = native.forkedFromSessionId ?? native.spawnedFrom?.sessionId;
      const projectCwd = this.projectCwd(native.cwd);
      const section = this.sectionCatalog?.sections.find(section => section.id === this.sectionCatalog?.assignments[sessionId]);
      const managedAssistant = this.isAssistantWorkspace(native.cwd);
      const projectId = managedAssistant ? projectIdForCwd(this.options.assistantWorkspacePath!) : this.sectionCatalog
        ? section?.id ?? CLAUDE_UNSECTIONED_PROJECT_ID
        : projectIdForCwd(projectCwd);
      const projectName = managedAssistant ? "助理" : this.sectionCatalog
        ? section?.name ?? CLAUDE_UNSECTIONED_PROJECT_NAME
        : (basename(projectCwd) || projectCwd);
      const resolvedModel = this.resolveSessionModel(sessionId, native.model);
      this.sessions.set(sessionId, {
        sessionId, nativeSessionId: native.sessionId, desktopSessionId: native.sessionId, runtimeId: "claude-desktop",
        projectId, projectName, cwd: native.cwd,
        title: native.title || "Claude 会话", source: "desktop", transport: "claude-desktop-native",
        ownership: running ? "DESKTOP_NATIVE_RUNNING" : "DESKTOP_NATIVE_IDLE",
        turnState: waiting ? "waiting" : running ? "running" : "idle",
        lastActivityAt: native.lastActivityAt ?? native.createdAt ?? 0, pendingCount: pendingCommandIds.length, pendingCommandIds,
        ...(lastCompletedTurnId ? { lastCompletedTurnId } : {}),
        ...(resolvedModel.sessionModel ? { model: resolvedModel.sessionModel, ...(resolvedModel.modelDisplayName ? { modelDisplayName: resolvedModel.modelDisplayName } : {}) } : {}), ...(native.effort ? { effort: native.effort } : {}),
        ...(native.permissionMode ? { nativePermissionMode: native.permissionMode } : {}),
        ...(native.outputStyle ? { outputStyle: native.outputStyle } : {}),
        ...(this.inspector.supports("applyFlagSettings") && native.availableOutputStyles?.length
          ? { outputStyleCatalogReady: true } : {}),
        ...(contextUsage ? { contextUsage } : {}),
        ...(running && this.compactingSessions.has(sessionId) ? { isCompacting: true } : {}),
        prs: native.prs ?? [],
        ...(this.prPreferences.has(sessionId) ? { prAutoFix: this.prPreferences.get(sessionId)! } : {}),
        ...(typeof native.autoArchiveOnPrClose === "boolean" ? { autoArchiveOnPrClose: native.autoArchiveOnPrClose } : {}),
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
          ...(ready && this.sectionCatalog && this.inspector.assignSection && !native.isArchived && !native.scheduledTaskId && !managedAssistant ? { canMoveSection: true } : {}),
          ...(!ready ? { reason: "Claude Desktop inspector 已断开" } : {}),
        },
      });
    }
    diag("project.done", { count: this.sessions.size });
  }

  listSessions(): BridgeSessionInfo[] { return [...this.sessions.values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt); }
  session(sessionId: string): BridgeSessionInfo | undefined { return this.sessions.get(sessionId); }
  async readNativeSessionIdentity(sessionId: string) {
    if (!this.inspector.ready || !this.inspector.supports("getSession")) return undefined;
    const native = record(await this.inspector.call("getSession", [sessionId]));
    if (native.sessionId !== sessionId || typeof native.cwd !== "string") return undefined;
    return { cwd: native.cwd, archived: native.isArchived === true, turnRunning: native.turnRunning === true,
      permissionMode: typeof native.permissionMode === "string" ? native.permissionMode : undefined,
      cliSessionId: typeof native.cliSessionId === "string" ? native.cliSessionId : undefined,
    };
  }
  executionCwd(sessionId: string): string | undefined {
    const session = this.native.get(sessionId);
    return session?.harnessCwd ?? session?.cwd;
  }
  async resolveSessionFile(sessionId: string, path: string): Promise<string | undefined> {
    if (!this.inspector.ready || !this.inspector.supports("resolveSessionFileQuietly")) return undefined;
    const resolved = await this.inspector.call("resolveSessionFileQuietly", [sessionId, path]);
    return typeof resolved === "string" && isAbsolute(resolved) ? resolved : undefined;
  }
  listProjects(): BridgeProjectInfo[] {
    const projects = new Map<string, BridgeProjectInfo>((this.sectionCatalog?.sections ?? []).map(section => [section.id, {
      projectId: section.id, name: section.name, kind: "desktop-group", cwd: "", runtimeId: "claude-desktop", sessionCount: 0, runningCount: 0, pendingCount: 0, lastActivityAt: 0,
    }]));
    const cwdPriority = new Map<string, { active: boolean; lastActivityAt: number }>();
    for (const session of this.sessions.values()) {
      const projectCwd = this.projectCwd(session.cwd);
      const project = projects.get(session.projectId) ?? { projectId: session.projectId, name: session.projectName, cwd: projectCwd, runtimeId: "claude-desktop", sessionCount: 0, runningCount: 0, pendingCount: 0, lastActivityAt: 0 };
      const active = session.archivedAt === undefined;
      if (this.isAssistantWorkspace(session.cwd)) {
        project.kind = "directory";
        project.managedAssistant = true;
        project.cwd = "";
      }
      const previous = cwdPriority.get(session.projectId);
      if (!project.managedAssistant && (!previous || (active && !previous.active) || (active === previous.active && session.lastActivityAt > previous.lastActivityAt))) {
        project.cwd = projectCwd;
        cwdPriority.set(session.projectId, { active, lastActivityAt: session.lastActivityAt });
      }
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
    if (!await this.refreshRuntime()) throw new NativeCallError(this.lastError);
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

  async renameSection(sectionId: string, name: string): Promise<BridgeProjectInfo> {
    if (!this.capabilities().includes("section.rename")) throw new NativeCallError("This Claude Desktop version does not support Sections");
    if (!this.sectionCatalog?.sections.some(section => section.id === sectionId)) {
      throw new NativeCallError("Selected Desktop Section is no longer available");
    }
    await this.inspector.renameSection!(sectionId, name);
    if (!await this.refreshRuntime()) throw new NativeCallError(this.lastError);
    const project = this.listProjects().find(project => project.kind === "desktop-group" && project.projectId === sectionId);
    if (!project) throw new NativeCallError("Selected Desktop Section is no longer available");
    return project;
  }

  async deleteSection(sectionId: string): Promise<void> {
    if (!this.capabilities().includes("section.delete")) throw new NativeCallError("This Claude Desktop version does not support Sections");
    if (!this.sectionCatalog?.sections.some(section => section.id === sectionId)) {
      throw new NativeCallError("Selected Desktop Section is no longer available");
    }
    await this.inspector.deleteSection!(sectionId);
    if (!await this.refreshRuntime()) throw new NativeCallError(this.lastError);
  }

  async createSession(cwd: string, title?: string, projectId?: string, trustWorkspace?: boolean): Promise<BridgeSessionInfo> {
    const explicitTitle = title?.trim() || undefined;
    const targetProjectId = projectId === CLAUDE_UNSECTIONED_PROJECT_ID ? undefined : projectId;
    if (targetProjectId && !await this.refreshRuntime()) throw new NativeCallError(this.lastError);
    const project = targetProjectId ? this.listProjects().find(project => project.projectId === targetProjectId) : undefined;
    if (targetProjectId && !project) throw new NativeCallError("Selected Desktop project is no longer available");
    if (trustWorkspace) {
      if (!this.inspector.supports("saveTrust")) throw new WorkspaceTrustRequiredError(true);
      await this.inspector.call("saveTrust", [cwd]);
    }
    let raw: unknown;
    try {
      raw = await this.inspector.call("start", [{
        cwd,
        ...(explicitTitle ? { title: explicitTitle } : {}),
        sessionId: `local_${randomUUID()}`,
        withoutFirstMessage: true,
        message: "",
      }]);
    } catch (error) {
      if (isWorkspaceTrustError(error)) {
        throw new WorkspaceTrustRequiredError(Boolean(trustWorkspace) || !this.inspector.supports("saveTrust"));
      }
      throw error;
    }
    const result = record(raw);
    if (typeof result.sessionId !== "string") throw new NativeCallError("Desktop did not return a session ID");
    if (explicitTitle) {
      this.autoTitledSessions.add(result.sessionId);
      this.explicitlyTitledSessions.add(result.sessionId);
      if (this.inspector.supports("updateSession")) {
        let currentTitle = typeof result.title === "string" ? result.title.trim() : "";
        if (!currentTitle && this.inspector.supports("getSession")) {
          const created = record(await this.inspector.call("getSession", [result.sessionId]));
          currentTitle = typeof created.title === "string" ? created.title.trim() : "";
        }
        if (currentTitle !== explicitTitle) {
          await this.inspector.call("updateSession", [result.sessionId, { title: explicitTitle }]);
        }
      }
    }
    if (project?.kind === "desktop-group") await this.inspector.assignSection!(result.sessionId, project.projectId);
    await this.refreshRuntime();
    const session = this.session(result.sessionId);
    if (!session) throw new NativeCallError("Created Desktop session is not yet available");
    return session;
  }

  async forkSession(sessionId: string, title?: string): Promise<BridgeSessionInfo> {
    const explicitTitle = title?.trim() || undefined;
    const result = record(await this.inspector.call("forkSession", [this.desktopId(sessionId)]));
    if (typeof result.sessionId !== "string") throw new NativeCallError("Desktop did not return a fork ID");
    if (explicitTitle) {
      this.autoTitledSessions.add(result.sessionId);
      this.explicitlyTitledSessions.add(result.sessionId);
      if (this.inspector.supports("updateSession")) {
        await this.inspector.call("updateSession", [result.sessionId, { title: explicitTitle }]);
      }
    }
    await this.refreshRuntime();
    const session = this.session(result.sessionId);
    if (!session) throw new NativeCallError("Forked Desktop session is not yet available");
    return session;
  }

  async rename(sessionId: string, title: string): Promise<void> {
    const id = this.desktopId(sessionId);
    this.autoTitledSessions.add(id);
    this.explicitlyTitledSessions.add(id);
    await this.serialized(async () => {
      await this.inspector.call("updateSession", [id, { title }]);
    });
    await this.refreshRuntime();
  }

  async archive(sessionId: string, archived: boolean): Promise<void> {
    await this.inspector.call(archived ? "archive" : "unarchive", [this.desktopId(sessionId)]);
    await this.refreshRuntime();
  }

  async deleteSession(sessionId: string): Promise<void> {
    const id = this.desktopId(sessionId);
    this.deletingSessions.add(id);
    try {
      await this.inspector.call("delete", [id]);
      this.native.delete(id);
      this.sessions.delete(sessionId);
      this.lastCompletedTurns.delete(sessionId);
      this.contextStates.delete(sessionId);
      this.prPreferences.delete(sessionId);
      this.autoTitledSessions.delete(sessionId);
      this.explicitlyTitledSessions.delete(sessionId);
      await this.refreshRuntime();
    } finally {
      this.deletingSessions.delete(id);
    }
  }

  async refreshDesktopSession(sessionId: string): Promise<void> {
    await this.refreshSessionMetadata(this.desktopId(sessionId), { includeContext: false });
  }

  private async readSessionTranscript(id: string) {
    if (!this.options.scanCatalog) return findClaudeSessionTranscript(claudeRuntimePaths(), id);
    const observed = (await this.options.scanCatalog()).sessions.find(session => session.desktopSessionId === id);
    return observed?.transcriptPath
      ? { transcriptPath: observed.transcriptPath, liveSince: oldestLiveProcessStart(observed.activeProcesses) }
      : undefined;
  }

  private transcriptSubagents(sessionId: string) {
    const id = this.desktopId(sessionId);
    const existing = this.transcriptSubagentsInFlight.get(id);
    if (existing) return existing;
    const run = (async () => {
      const local = await this.readSessionTranscript(id);
      if (!local) return undefined;
      return { ...local, subagents: await readClaudeTranscriptSubagents(local.transcriptPath, local.liveSince) };
    })().finally(() => {
      if (this.transcriptSubagentsInFlight.get(id) === run) this.transcriptSubagentsInFlight.delete(id);
    });
    this.transcriptSubagentsInFlight.set(id, run);
    return run;
  }

  private async enrichSubagentItems(sessionId: string, items: BridgeHistoryItem[]): Promise<BridgeSubagentSummary[] | undefined> {
    if (!items.some(item => item.subagent || item.toolName === "Agent" || item.toolName === "Task")) return undefined;
    const local = await this.transcriptSubagents(sessionId);
    enrichNativeSubagentItems(items, local?.subagents);
    return local?.subagents;
  }

  backgroundTaskDetails(sessionId: string): Promise<BridgeBackgroundTask[]> {
    const id = this.desktopId(sessionId);
    const existing = this.backgroundTasksInFlight.get(id);
    if (existing) return existing;
    const run = (async () => {
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
    })().finally(() => {
      if (this.backgroundTasksInFlight.get(id) === run) this.backgroundTasksInFlight.delete(id);
    });
    this.backgroundTasksInFlight.set(id, run);
    return run;
  }

  private async rewindTarget(sessionId: string, messageId: string) {
    const id = this.desktopId(sessionId);
    if (!this.inspector.ready) throw new InspectorDisconnectedError("Claude Desktop rewind is unavailable while inspector is disconnected");
    if (!this.capabilities().includes("session.rewind")) throw new NativeCallError("Unsupported Claude Desktop rewind methods");
    const native = nativeSession(await this.inspector.call("getSession", [id]));
    await this.observeNativeSession(native);
    this.projectSessions();
    const result = await this.inspector.call("getTranscript", [id]);
    const messages = Array.isArray(result) ? result : record(result).messages;
    if (!Array.isArray(messages)) throw new NativeCallError("Desktop returned an invalid transcript");
    const target = messages.findIndex(raw => {
      const message = record(raw);
      return message.uuid === messageId && message.type === "user" && message.isSidechain !== true && !message.parent_tool_use_id && visibleMessage(message)?.role === "user";
    });
    if (target === -1) throw new NativeCallError("Rewind target must be a user message in this native session");
    return { id, messages, target };
  }

  async previewRewind(sessionId: string, messageId: string): Promise<BridgeSessionRewindPreview> {
    const { id } = await this.rewindTarget(sessionId, messageId);
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
    const { id, messages, target } = await this.rewindTarget(sessionId, messageId);
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
      this.lastCompletedTurns.delete(sessionId);
      this.messageProjection.delete(sessionId);
      this.replyTurns.delete(sessionId);
      if (this.listenerCount("assistant.replies-rewound")) {
        const removed = messages.slice(target + 1).flatMap(raw => {
          const message = record(raw);
          if (message.type !== "assistant") return [];
          const body = record(message.message);
          const itemId = typeof body.id === "string" ? body.id : message.uuid;
          return typeof itemId === "string" ? [itemId] : [];
        });
        if (removed.length) this.emit("assistant.replies-rewound", sessionId, removed);
      }
      this.contextStates.set(sessionId, createNativeContextState(this.contextStates.get(sessionId)?.maxTokensByModel));
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

  private historyReceipt(sessionId: string, itemId: string): NativeDesktopReceipt | undefined {
    return [...this.receipts.values()].find(receipt => receipt.sessionId === sessionId &&
      (receipt.messageId === itemId || receipt.previousMessageIds?.includes(itemId)));
  }

  private async nativeSentFiles(sessionId: string, messages: unknown[], live = false) {
    const receipts = messages.flatMap(message => nativeSentFileReceipt(message) ?? []);
    if (!receipts.length) return;
    const cwd = this.executionCwd(sessionId)!;
    const names = new Map(receipts.map(({ toolUseId }) => [toolUseId,
      live ? this.options.eventLog.latestItem(sessionId, "tool.started", toolUseId)?.data.toolName : undefined]));
    const findCalls = (source: unknown[]) => {
      for (const raw of source) {
        const message = record(raw);
        if (message.type !== "assistant" || message.isSidechain === true || message.parent_tool_use_id) continue;
        const { content } = record(message.message);
        if (!Array.isArray(content)) continue;
        for (const rawBlock of content) {
          const block = record(rawBlock);
          if (block.type === "tool_use" && typeof block.id === "string" && names.has(block.id)) names.set(block.id, block.name);
        }
      }
    };
    findCalls(messages);
    if ([...names.values()].some(name => name === undefined)) {
      const result = await this.inspector.call("getTranscript", [this.desktopId(sessionId)]);
      const transcript = Array.isArray(result) ? result : record(result).messages;
      if (!Array.isArray(transcript)) throw new NativeCallError("Desktop returned an invalid transcript");
      findCalls(transcript);
    }
    const sends = receipts.filter(({ toolUseId }) => names.get(toolUseId) === "SendUserFile");
    if (!sends.length) return;
    const canonical = (path: string) => realpath(path).catch((error: NodeJS.ErrnoException) => {
      if (["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes(error.code ?? "")) return undefined;
      throw error;
    });
    const root = await canonical(cwd);
    const inside = (directory: string, path: string) => {
      const within = relative(directory, path);
      return within && within !== ".." && !within.startsWith(`..${sep}`) && !isAbsolute(within);
    };
    return new Map(await Promise.all(sends.map(async ({ toolUseId, paths }) => [toolUseId, await Promise.all(paths.map(async path => {
      const candidate = resolve(cwd, path);
      const source = root && (inside(cwd, candidate) || inside(root, candidate)) ? await canonical(candidate) : undefined;
      // Do not send a path that the Markdown link transport would reinterpret.
      const available = source && root && inside(root, source) && source === source.trim() && !/:\d+(?::\d+)?$/u.test(source);
      return { name: basename(path) || path, ...(available ? { path: source } : {}) };
    }))] as const)));
  }

  async history(sessionId: string, cursor?: string, limit = 50, { hydrateModel = false } = {}): Promise<BridgeHistoryPage> {
    const id = this.desktopId(sessionId);
    const read = diagnostics.begin(cursor ? "history.cursor" : "history.initial", { cursor: Boolean(cursor), limit });
    try {
      if (!this.inspector.ready) throw new InspectorDisconnectedError("Claude Desktop history is unavailable while inspector is disconnected");
      const previousSession = !cursor ? JSON.stringify(this.session(sessionId)) : undefined;
      const { page, earlierPlanMessages, readContextMessages } = await readNativeHistoryPage(
        this.inspector, id, cursor, limit, () => this.messageProjection.get(sessionId)?.planObserved,
      );
      const { hasMore, nextCursor } = page;
      const liveProjection = this.messageProjection.get(sessionId) ?? {};
      const projection: NativeMessageProjection = { ...(liveProjection.questionAnswers ? { questionAnswers: liveProjection.questionAnswers } : {}) };
      nativeHistoryItems(sessionId, earlierPlanMessages, projection);
      const sessionProposalResults: string[] = [];
      const items = nativeHistoryItems(sessionId, page.messages, projection, sessionProposalResults, await this.nativeSentFiles(sessionId, page.messages));
      const localSubagents = await this.enrichSubagentItems(sessionId, items);
      if (projection.questions?.size || projection.questionAnswers?.size) {
        for (const [toolUseId, question] of projection.questions ?? []) (liveProjection.questions ??= new Map()).set(toolUseId, question);
        if (projection.questionAnswers) liveProjection.questionAnswers = projection.questionAnswers;
        this.messageProjection.set(sessionId, liveProjection);
      }
      if (!cursor) {
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
        const priorLiveSample = this.contextStates.get(sessionId)?.liveUsageSample;
        const live = await this.readLiveContextUsage(id);
        if (live) {
          this.applyLiveContextUsage(sessionId, live);
        } else {
          const pending = readContextMessages(messages => this.applyTranscriptContextMessages(sessionId, messages, priorLiveSample));
          if (pending) await pending;
        }
        if (hydrateModel) await this.hydrateContextModel(id, this.native.get(id)?.model, page);
        this.projectSessions();
        if (JSON.stringify(this.session(sessionId)) !== previousSession) this.emit("changed");
      }
      let observed = false;
      for (const item of items) {
        const receipt = item.role === "user" ? this.historyReceipt(sessionId, item.id) : undefined;
        if (receipt) {
          item.text = receipt.displayText ?? item.text;
          if (receipt.source === "assistant-trigger" && receipt.messageId === item.id &&
            (receipt.state === "submitted" || receipt.state === "queued")) {
            receipt.state = "session-received";
            this.trackReceivedInput(receipt);
            this.options.conversationState.saveNativeDesktopReceipt(receipt);
            await this.record({ sessionId, itemId: item.id, turnId: item.id, origin: "claude-desktop", type: "message.delivery",
              data: { commandId: receipt.commandId, requestId: receipt.requestId, messageId: receipt.messageId, delivery: receipt.state } });
            observed = true;
          }
          item.delivery = receipt.state === "dispatching" ? "host-received" : receipt.state;
          item.commandId = receipt.commandId;
          item.requestId = receipt.requestId;
          if (receipt.source) {
            item.source = receipt.source;
            item.turnId = receipt.messageId;
          }
          if (receipt.queueSettled) item.queueSettled = true;
        }
      }
      if (observed) {
        this.projectSessions();
        this.emit("changed");
      }
      diag("history.messages", { messages: items.length });
      return { sessionId, items, hasMore, ...(nextCursor ? { nextCursor } : {}),
        ...(sessionProposalResults.length ? { sessionProposalResults } : {}) };
    } finally { read(); }
  }

  async readNativeImage(sessionId: string, ref: BridgeNativeImageRef): Promise<{ artifactId: string; name: string; mimeType: string; bytes: Buffer }> {
    const result = await this.inspector.call("getTranscript", [this.desktopId(sessionId)]);
    const messages = Array.isArray(result) ? result : record(result).messages;
    if (!Array.isArray(messages)) throw new NativeCallError("Desktop returned an invalid transcript");
    return extractNativeImageAttachment(sessionId, messages, ref);
  }

  async readToolDetail(sessionId: string, toolUseId: string, agentId?: string): Promise<BridgeToolCallDetail> {
    const id = this.desktopId(sessionId);
    if (agentId !== undefined) {
      const local = await this.readSessionTranscript(id);
      if (!local) throw new NativeCallError("Subagent transcript not found");
      const detail = await readSubagentToolCallDetail({
        sessionId,
        transcriptPath: local.transcriptPath,
        agentId,
        toolUseId,
      });
      if (!detail) throw new NativeCallError("Tool call not found");
      return detail;
    }
    if (!this.inspector.ready) throw new InspectorDisconnectedError("Claude Desktop transcript is unavailable while inspector is disconnected");
    const result = await this.inspector.call("getTranscript", [id]);
    const messages = Array.isArray(result) ? result : record(result).messages;
    if (!Array.isArray(messages)) throw new NativeCallError("Desktop returned an invalid transcript");
    const detail = extractToolCallDetailFromMessages({ sessionId, toolUseId, messages });
    if (!detail) throw new NativeCallError("Tool call not found");
    return detail;
  }

  async commands(sessionId: string): Promise<BridgeSlashCommandCatalog> {
    const result = await this.inspector.call("getSupportedCommands", [{ sessionId: this.desktopId(sessionId), cwd: this.session(sessionId)?.cwd }]);
    const commands = Array.isArray(result) ? result : record(result).commands;
    if (!Array.isArray(commands)) throw new NativeCallError("Desktop returned an invalid command catalog");
    const catalog: BridgeSlashCommandCatalog = { sessionId, commands: commands.map(command => {
      const value = record(command);
      return { name: String(value.name ?? value.command ?? ""), description: String(value.description ?? ""), ...(typeof value.argumentHint === "string" ? { argumentHint: value.argumentHint } : {}) };
    }).filter(command => command.name) };
    if (this.isAssistantWorkspace(this.session(sessionId)!.cwd)) {
      catalog.commands = catalog.commands.filter(command => command.name !== "btw");
    } else if (!catalog.commands.some(command => command.name === "btw")) {
      catalog.commands.push({ name: "btw", description: "Ask a question in a side chat", argumentHint: "<question>" });
    }
    catalog.commands = catalog.commands.filter(command => command.name !== "rewind");
    if (this.capabilities().includes("session.rewind")) catalog.commands.push({ name: "rewind", description: "Rewind conversation or file changes", action: "rewind" });
    return catalog;
  }

  async runCommand(input: NativeInput): Promise<BridgeSessionCommandResult> {
    const session = this.session(input.sessionId);
    if (session && this.isAssistantWorkspace(session.cwd) && /^\/btw(?:\s|$)/u.test(input.text.trim())) {
      throw new NativeCallError("托管助理工作区不支持派生会话。");
    }
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
    const renamedSession = /^\/rename\s+\S/iu.test(input.text.trim()) ? this.session(input.sessionId) : undefined;
    return { action: "sent", ...(renamedSession ? { session: renamedSession } : {}) };
  }

  async defaultConfiguration(): Promise<BridgeSessionConfiguration> {
    await this.refreshModelCatalog("retry-failed");
    const reference = [...this.native.values()].sort((left, right) => (
      Number(Boolean(left.isArchived)) - Number(Boolean(right.isArchived))
      || (right.lastActivityAt ?? right.createdAt ?? 0) - (left.lastActivityAt ?? left.createdAt ?? 0)
    ))[0];
    const fromReference = reference ? this.resolveSessionModel(reference.sessionId, reference.model) : undefined;
    const resolved = fromReference && !(
      !fromReference.modelDisplayName
      && fromReference.configModel
      && parseMagpieSyntheticModelId(fromReference.configModel)
      && this.models?.length
    )
      ? fromReference
      : this.resolveSessionModel(undefined, undefined);
    const fallbackLabel = resolved.modelDisplayName
      ?? (resolved.configModel && /\[1m\]$/iu.test(resolved.configModel) ? "默认模型 · 1M" : "默认模型");
    const availableModels = this.models
      ? [
          ...this.models,
          ...(resolved.extraOption && !this.models.some(option => option.value === resolved.extraOption!.value) ? [resolved.extraOption] : []),
        ]
      : resolved.configModel ? [{ value: resolved.configModel, displayName: fallbackLabel }] : [];
    const defaultModel = resolved.configModel ?? availableModels[0]?.value;
    const defaultDisplayName = resolved.modelDisplayName ?? (resolved.configModel ? undefined : availableModels[0]?.displayName);
    const styleCatalog = this.inspector.supports("applyFlagSettings") && this.inspector.supports("listGlobalOutputStyles")
      ? record(await this.inspector.call("listGlobalOutputStyles")) : {};
    const styles = [...new Set([...outputStyleNames(styleCatalog.builtIns), ...outputStyleNames(styleCatalog.customs)])];
    return {
      sessionId: DEFAULT_CONFIGURATION_SESSION_ID,
      ...(defaultModel ? { model: defaultModel, ...(defaultDisplayName ? { modelDisplayName: defaultDisplayName } : {}) } : {}),
      effort: reference?.effort ?? "high",
      nativePermissionMode: reference?.permissionMode ?? "default",
      ...(styles.length ? { availableOutputStyles: styles } : {}),
      modelSource: "claude-desktop", effortSource: "claude-desktop",
      availableModels,
      availableEffortLevels: [...BRIDGE_EFFORT_LEVELS],
      modelsComplete: this.models !== undefined, appliesAfterTurn: false,
    };
  }

  private async refreshSessionMetadata(sessionId: string, { includeContext }: { includeContext: boolean }): Promise<NativeSession> {
    const previousSnapshot = JSON.stringify(this.session(sessionId));
    const native = nativeSession(await this.inspector.call("getSession", [sessionId]));
    await this.observeNativeSession(native);
    if (includeContext) {
      if (native.turnRunning === true) {
        const live = await this.readLiveContextUsage(sessionId);
        if (live) this.applyLiveContextUsage(sessionId, live);
      }
      await this.hydrateContextModel(sessionId, native.model);
    }
    this.projectSessions();
    if (JSON.stringify(this.session(sessionId)) !== previousSnapshot) this.emit("changed");
    return native;
  }

  async configuration(sessionId: string): Promise<BridgeSessionConfiguration> {
    const id = this.desktopId(sessionId);
    await this.refreshModelCatalog("retry-failed");
    const native = await this.refreshSessionMetadata(id, { includeContext: true });
    const context = this.session(sessionId)?.contextUsage;
    const resolved = this.resolveSessionModel(sessionId, native.model);
    const fallbackLabel = resolved.modelDisplayName
      ?? (resolved.configModel && /\[1m\]$/iu.test(resolved.configModel) ? "默认模型 · 1M" : "默认模型");
    return {
      sessionId,
      ...(resolved.configModel ? { model: resolved.configModel, ...(resolved.modelDisplayName ? { modelDisplayName: resolved.modelDisplayName } : {}) } : {}),
      ...(native.effort ? { effort: native.effort } : {}),
      ...(native.permissionMode ? { nativePermissionMode: native.permissionMode } : {}),
      ...(native.outputStyle ? { outputStyle: native.outputStyle } : {}),
      ...(this.inspector.supports("applyFlagSettings") && native.availableOutputStyles?.length
        ? { availableOutputStyles: native.availableOutputStyles } : {}),
      modelSource: "claude-desktop", effortSource: "claude-desktop",
      availableModels: this.models
        ? [
            ...this.models,
            ...(resolved.extraOption && !this.models.some(option => option.value === resolved.extraOption!.value) ? [resolved.extraOption] : []),
          ]
        : resolved.configModel ? [{ value: resolved.configModel, displayName: fallbackLabel }] : [],
      availableEffortLevels: [...BRIDGE_EFFORT_LEVELS],
      modelsComplete: this.models !== undefined, appliesAfterTurn: native.turnRunning === true,
      ...(context ? { context } : {}),
    };
  }

  private async applyOutputStyle(id: string, requested: string): Promise<void> {
    const deadline = AbortSignal.timeout(10_000);
    // An empty Native start returns before Claude Code reports its style catalog.
    const changes = on(this, "changed", { signal: deadline });
    let styles: string[] | undefined;
    try {
      const observed = nativeSession(await this.inspector.call("getSession", [id]));
      styles = observed.availableOutputStyles ?? this.native.get(id)?.availableOutputStyles;
      if (!styles) {
        for await (const _ of changes) {
          styles = this.native.get(id)?.availableOutputStyles;
          if (styles) break;
        }
      }
    } catch (error) {
      if (!(error instanceof Error && error.name === "AbortError" && error.cause === deadline.reason)) throw error;
    } finally {
      await changes.return?.();
    }
    if (!styles) throw new NativeCallError("Claude Desktop 尚未加载此会话的输出风格。");
    const style = styles.find(name => name === requested) ?? styles.find(name => name.toLowerCase() === requested.toLowerCase());
    if (!style) throw new NativeCallError(`此会话不提供输出风格「${requested}」。`);
    await this.inspector.call("applyFlagSettings", [id, { outputStyle: style }]);
    if (nativeSession(await this.inspector.call("getSession", [id])).outputStyle !== style) {
      throw new NativeCallError(`Claude Desktop 未应用输出风格「${style}」。`);
    }
  }

  async configureSession(input: {
    sessionId: string;
    model?: string | null;
    effort?: BridgeEffort | null;
    permissionMode?: BridgeSDKPermissionMode;
    outputStyle?: string;
  }): Promise<BridgeSessionConfiguration> {
    const id = this.desktopId(input.sessionId);
    let nativeModel = input.model;
    if (typeof input.model === "string") {
      const directory = await this.inspector.availableCodeModels();
      if (directory.length && !directory.includes(input.model)) {
        const base = input.model.replace(/\[1m\]$/iu, "");
        const longContext = /\[1m\]$/iu.test(input.model);
        const hash = modelOptionHash(base);
        const slug = normalizeAnthropicModelSlug(base);
        const findByPredicate = (match: (alias: NonNullable<ReturnType<typeof parseMagpieSyntheticModelId>>) => boolean) => (
          directory.find(candidate => {
            const alias = parseMagpieSyntheticModelId(candidate);
            return Boolean(alias && match(alias) && alias.longContext === longContext);
          }) ?? (longContext ? directory.find(candidate => {
            const alias = parseMagpieSyntheticModelId(candidate);
            return Boolean(alias && match(alias) && !alias.longContext);
          }) : directory.find(candidate => {
            const alias = parseMagpieSyntheticModelId(candidate);
            return Boolean(alias && match(alias) && alias.longContext);
          }))
        );
        const found = directory.find(candidate => candidate === base)
          ?? (!longContext ? directory.find(candidate => candidate === `${base}[1m]`) : undefined)
          ?? findByPredicate(alias => alias.hash === hash)
          ?? (slug ? findByPredicate(alias => Boolean(alias.anthropicModel && normalizeAnthropicModelSlug(alias.anthropicModel) === slug)) : undefined);
        if (!found) throw new NativeCallError("Selected model is unavailable in Claude Desktop's native model directory");
        nativeModel = longContext && !/\[1m\]$/iu.test(found) ? `${found}[1m]` : found;
      }
    }
    if (input.outputStyle !== undefined) await this.applyOutputStyle(id, input.outputStyle);
    if (nativeModel !== undefined) {
      await this.inspector.call("setModel", [id, nativeModel]);
      const existing = this.contextStates.get(input.sessionId);
      if (existing) existing.estimated = true;
    }
    if (input.effort !== undefined) await this.inspector.call("setEffort", [id, input.effort]);
    if (input.permissionMode !== undefined) await this.inspector.call("setPermissionMode", [id, input.permissionMode]);
    await this.refreshRuntime();
    const configuration = await this.configuration(input.sessionId);
    const observedNativeModel = this.native.get(input.sessionId)?.model?.trim();
    const observedResolvedModel = observedNativeModel && observedNativeModel.toLowerCase() !== "default"
      ? (savedModelOption(this.models, observedNativeModel)?.value ?? observedNativeModel)
      : undefined;
    // Validate against raw native readback (never transcript/default fallbacks), accepting
    // only Desktop's known base -> preferred-1M normalization when 1M was not a separate option.
    if (
      typeof input.model === "string"
      && (
        !observedResolvedModel
        || (observedResolvedModel !== input.model && !(
          !/\[1m\]$/iu.test(input.model) && observedResolvedModel === `${input.model}[1m]`
          && !this.models?.some(option => option.value === observedResolvedModel)
        ))
      )
    ) throw new NativeCallError(`Desktop did not apply the selected model: ${input.model}; observed ${observedNativeModel ?? "default"}`);
    return configuration;
  }

  startTurn(input: NativeInput): Promise<NativeDesktopReceipt> { return this.send(input, "later"); }
  steerTurn(input: NativeInput): Promise<NativeDesktopReceipt> { return this.send(input, "now"); }

  private async send(input: NativeInput, priority: "later" | "now"): Promise<NativeDesktopReceipt> {
    const existing = this.options.conversationState.nativeDesktopReceipt(input.idempotencyKey);
    if (existing && !(existing.notDispatched && input.source === "assistant-trigger")) return existing;
    const id = this.desktopId(input.sessionId);
    const receipt: NativeDesktopReceipt = existing ?? { idempotencyKey: input.idempotencyKey, commandId: randomUUID(), requestId: input.requestId, sessionId: input.sessionId, messageId: randomUUID(),
      queueMode: priority === "now" ? "steered" : "deferred", state: "dispatching",
      ...(input.source ? { source: input.source } : {}), ...(input.displayText !== undefined ? { displayText: input.displayText } : {}) };
    delete receipt.notDispatched;
    this.options.conversationState.saveNativeDesktopReceipt(receipt);
    this.receipts.set(receipt.commandId, receipt);
    await this.record({ sessionId: input.sessionId, turnId: receipt.messageId, origin: input.origin, type: "message.delivery", data: { ...receipt, delivery: "host-received", text: input.displayText ?? input.text } });
    let result: Record<string, unknown>;
    try {
      result = record(await this.inspector.call("sendMessage", [id, input.text, input.attachments?.length ? input.attachments.map(image => ({ base64: image.data, mimeType: image.mimeType, filename: image.name })) : undefined,
        undefined, undefined, (input.nativeTurnRunning ?? this.native.get(id)?.turnRunning) ? priority : undefined, priority === "now" ? { ccdSteering: true, queuedMessageBar: true } : undefined,
        receipt.messageId, undefined, input.text, undefined, undefined, undefined, undefined, { personSent: true, rejectUndelivered: true }]));
    } catch (error) {
      if (receipt.state !== "dispatching") return receipt;
      if (receipt.source === "assistant-trigger" && error instanceof InspectorNotDispatchedError) {
        receipt.notDispatched = true;
        this.options.conversationState.saveNativeDesktopReceipt(receipt);
        return receipt;
      }
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
    const trimmedInputText = input.text.trim();
    const renameMatch = /^\/rename\s+([\s\S]+)$/iu.exec(trimmedInputText);
    const renameTitle = renameMatch?.[1]?.trim();
    if (renameTitle) {
      this.autoTitledSessions.add(id);
      this.explicitlyTitledSessions.add(id);
      if (this.inspector.supports("updateSession") && !this.deletingSessions.has(id)) {
        await this.serialized(async () => {
          if (this.deletingSessions.has(id)) return;
          let currentTitle = "";
          if (this.inspector.supports("getSession")) {
            const latest = record(await this.inspector.call("getSession", [id]));
            currentTitle = typeof latest.title === "string" ? latest.title.trim() : "";
          }
          if (currentTitle !== renameTitle) {
            await this.inspector.call("updateSession", [id, { title: renameTitle }]);
          }
        });
      }
      await this.refreshRuntime();
    }
    const isControlSlashCommand = /^\/(?:compact|clear|cost|context|doctor|help|login|logout|memory|model|permissions|rename|rewind|status|vim|btw)(?:\s|$)/iu.test(trimmedInputText);
    const nativeTarget = this.native.get(id);
    if (
      !this.closed
      && !isControlSlashCommand
      && !this.deletingSessions.has(id)
      && this.inspector.supports("updateSession")
      && !nativeTarget?.title?.trim()
      && nativeTarget?.spawnedFrom?.btw !== true
      && !this.autoTitledSessions.has(id)
    ) {
      this.autoTitledSessions.add(id);
      void this.autoTitleSession(id, input.text, Boolean(input.attachments?.length));
    }
    return receipt;
  }

  private sleepAbortable(ms: number): Promise<boolean> {
    if (this.closed || this.closeAbort.signal.aborted) return Promise.resolve(false);
    if (ms <= 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const onAbort = () => {
        clearTimeout(handle);
        resolve(false);
      };
      const handle = setTimeout(() => {
        this.closeAbort.signal.removeEventListener("abort", onAbort);
        resolve(!this.closed);
      }, ms);
      handle.unref?.();
      this.closeAbort.signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private isSessionUnavailableForAutoTitle(id: string): boolean {
    return (
      this.closed
      || !this.inspector.ready
      || !this.inspector.supports("updateSession")
      || !this.native.has(id)
      || this.deletingSessions.has(id)
      || this.explicitlyTitledSessions.has(id)
    );
  }

  private async autoTitleSession(id: string, text: string, hasAttachments: boolean): Promise<void> {
    try {
      if (!await this.sleepAbortable(this.options.autoTitleGraceMs ?? 400)) return;
      if (this.isSessionUnavailableForAutoTitle(id)) return;
      if (this.inspector.supports("getSession")) {
        const precheck = nativeSession(await this.inspector.call("getSession", [id]));
        if (precheck.title?.trim() || precheck.spawnedFrom?.btw === true) return;
      }
      if (this.isSessionUnavailableForAutoTitle(id)) return;

      const allowAmbientDiscovery = Boolean(
        this.options.magpieConnection || this.options.fetchImpl || this.options.environment || this.options.home,
      );
      const titleGateway = await resolveActiveClaudeGateway({
        ...(this.options.environment ? { environment: this.options.environment } : {}),
        ...(this.options.home ? { home: this.options.home } : {}),
        ...(this.options.platform ? { platform: this.options.platform } : {}),
        settingsPath: this.options.settingsPath,
        allowAmbientDiscovery,
      });
      if (!titleGateway || this.isSessionUnavailableForAutoTitle(id)) return;

      const { gateway, profileModels } = titleGateway;
      const desktopCatalog = this.gatewayModelsCache.auto;
      const catalogModels = mergeModelCatalog(this.desktopPickerModels,
        desktopCatalog?.source === "gateway" && desktopCatalog.gatewayKey === JSON.stringify(gateway)
          ? desktopCatalog.models
          : profileModels,
      );
      const nativeModel = this.native.get(id)?.model;
      const preferredModel = this.resolveSessionModel(id, nativeModel, catalogModels ?? []).configModel ?? nativeModel;
      const generatedTitle = await generateSessionTitle({
        text,
        hasAttachments,
        gateway,
        ...(preferredModel ? { preferredModel } : {}),
        ...(catalogModels ? { catalogModels } : {}),
        ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
        signal: this.closeAbort.signal,
      });
      if (!generatedTitle || this.isSessionUnavailableForAutoTitle(id)) return;

      await this.serialized(async () => {
        if (this.isSessionUnavailableForAutoTitle(id)) return;
        const latest = nativeSession(await this.inspector.call("getSession", [id]));
        if (this.isSessionUnavailableForAutoTitle(id)) return;
        if (latest.title?.trim() || latest.spawnedFrom?.btw === true) {
          const before = JSON.stringify(this.session(id));
          await this.observeNativeSession(latest);
          this.projectSessions();
          if (JSON.stringify(this.session(id)) !== before) this.emit("changed");
          return;
        }
        await this.inspector.call("updateSession", [id, { title: generatedTitle }]);
        const updated = nativeSession(await this.inspector.call("getSession", [id]));
        if (this.isSessionUnavailableForAutoTitle(id)) return;
        await this.observeNativeSession(updated);
        this.projectSessions();
        this.emit("changed");
      });
    } catch {
      // Best-effort background auto-titling must never fail turns or leave unhandled rejections.
    }
  }

  async steerQueuedTurn(sessionId: string, commandId: string): Promise<NativeDesktopReceipt> {
    const receipt = this.receipts.get(commandId);
    if (!receipt || receipt.sessionId !== sessionId || (receipt.state === "session-received" && receipt.queueSettled) || !["submitted", "session-received", "queued"].includes(receipt.state)) throw new NativeCallError("这条消息当前不可调整，或已经开始处理");
    if (!receipt.queueMode) throw new NativeCallError("这条旧消息缺少原生发送通道，请在桌面端使用 Send now");
    const accepted = await this.inspector.call(receipt.queueMode === "steered" ? "sendSteeredNow" : "promoteQueuedMessage", [this.desktopId(sessionId), receipt.messageId]);
    if (accepted !== true) throw new NativeCallError("无法立即发送：消息已被处理，或当前不可操作");
    return receipt;
  }

  async cancelQueuedTurn(sessionId: string, commandId: string): Promise<NativeDesktopReceipt> {
    const receipt = this.receipts.get(commandId);
    if (!receipt || receipt.sessionId !== sessionId || (receipt.state === "session-received" && receipt.queueSettled) || !["submitted", "session-received", "queued"].includes(receipt.state)) throw new NativeCallError("这条消息当前不可调整，或已经开始处理");
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
    this.trackReceivedInput(receipt);
    delete receipt.error;
    this.options.conversationState.saveNativeDesktopReceipt(receipt);
    return receipt;
  }

  promptsList(sessionId?: string): BridgePendingPrompt[] {
    return [...this.prompts.values()].filter(prompt => sessionId === undefined || prompt.sessionId === sessionId)
      .map(prompt => ({ ...prompt, canRespond: this.inspector.ready && prompt.canRespond }));
  }

  async resolvePrompt(sessionId: string, promptId: string, choice: string, resolver: { deviceId: string; name: string }): Promise<boolean> {
    const id = this.desktopId(sessionId);
    // Re-read the Native pending list before forwarding a response from another device.
    await this.observeNativeSession(nativeSession(await this.inspector.call("getSession", [id])));
    const prompt = this.prompts.get(promptId);
    if (!prompt || prompt.sessionId !== sessionId) { this.projectSessions(); this.emit("changed"); return false; }
    if (!prompt.canRespond) throw new NativeCallError("当前 Claude Desktop 版本不支持远程处理此提示，请在电脑端处理。");
    if (!prompt.choices.some(option => option.value === choice)) throw new NativeCallError("Invalid native prompt choice");
    const spec = NATIVE_PROMPTS.find(spec => spec.kind === prompt.kind)!;
    const resolved = await this.inspector.call(spec.method, [id, promptId, prompt.kind === "cwd-trust" ? choice === "trust" : choice]);
    await this.refreshRuntime();
    if (resolved !== true) return false;
    await this.record({ sessionId, origin: "claude-desktop", type: "prompt.resolved", data: {
      promptId, kind: prompt.kind, choice, resolvedByDeviceId: resolver.deviceId, resolvedByName: resolver.name, resolvedAt: Date.now(),
    } });
    return true;
  }

  async readPrAutoFix(sessionId: string, target?: { repo: string; prNumber: number; host?: string; includeChecks?: boolean }): Promise<BridgePrAutoFixState> {
    const id = this.desktopId(sessionId);
    await this.observeNativeSession(nativeSession(await this.inspector.call("getSession", [id])));
    const preferences = await this.inspector.prPreferences?.(id);
    if (preferences) this.prPreferences.set(sessionId, preferences);
    else this.prPreferences.delete(sessionId);
    const state: BridgePrAutoFixState = {
      sessionId, prs: this.native.get(id)!.prs ?? [], ...preferences,
      capabilities: {
        bound: this.inspector.supports("setBoundPrAutoFix"),
        onlyOwnPrs: preferences !== undefined && this.inspector.supports("setAutoFixOwnPrsWanted"),
        nextPr: preferences !== undefined && this.inspector.supports("getGitInfo") && this.inspector.supports("armAutoFixOnNextPr") && this.inspector.startAutoFixOnNextPr !== undefined,
        checks: this.inspector.supports("getPrChecks"),
      },
    };
    if (target?.includeChecks) {
      const binding = state.prs.find(pr => pr.repo === target.repo && pr.prNumber === target.prNumber && (target.host === undefined || pr.host === target.host));
      if (!binding) throw new NativeCallError("PR is not bound to this Desktop session");
      if (!state.capabilities.checks) throw new NativeCallError("当前 Claude Desktop 版本不支持读取 PR 检查。");
      const cwd = this.executionCwd(sessionId)!;
      // The public overview API has no host argument; explicit repos resolve to github.com.
      const overviewSupported = (!binding.host || binding.host.toLowerCase() === "github.com") && this.inspector.supports("getPrOverview");
      const [overview, checks] = await Promise.all([
        overviewSupported ? this.inspector.call("getPrOverview", [cwd, binding.prNumber, binding.repo, id, true]).then(record) : undefined,
        this.inspector.call("getPrChecks", [cwd, binding.prNumber, binding.repo, binding.host]).then(record),
      ]);
      if (checks.success !== true) throw new NativeCallError(typeof checks.error === "string" ? checks.error : "Desktop 无法读取 PR 检查。");
      if (overview?.success === true) {
        const detail = record(overview.overview);
        state.overview = {
          ...(typeof detail.title === "string" ? { title: detail.title } : {}),
          ...(typeof detail.state === "string" ? { state: detail.state } : {}),
          ...(typeof detail.url === "string" ? { url: detail.url } : {}),
        };
      } else {
        state.overviewUnavailable = overview ? typeof overview.error === "string" ? overview.error : "Desktop 无法读取 PR 状态。"
          : binding.host && binding.host.toLowerCase() !== "github.com" ? "当前 Desktop 不支持此 GitHub 主机的 PR 概览。" : "当前 Desktop 不支持 PR 概览。";
      }
      if (!Array.isArray(checks.checks)) throw new NativeCallError("Desktop returned invalid PR checks");
      state.checks = checks.checks.map(raw => {
        const check = record(raw);
        if (typeof check.name !== "string") throw new NativeCallError("Desktop returned an invalid PR check");
        return { name: check.name, state: String(check.bucket ?? "unknown"), ...(typeof check.url === "string" ? { url: check.url } : {}) };
      });
    }
    this.projectSessions(); this.emit("changed");
    return state;
  }

  async setPrAutoFix(update: BridgePrAutoFixUpdate, resolver: { deviceId: string; name: string }): Promise<BridgePrAutoFixState> {
    const before = await this.readPrAutoFix(update.sessionId);
    const id = this.desktopId(update.sessionId);
    if (update.target === "bound") {
      if (!before.capabilities.bound) throw new NativeCallError("Unsupported Claude Desktop method: setBoundPrAutoFix");
      const binding = before.prs.find(pr => pr.repo === update.repo && pr.prNumber === update.prNumber && (update.host === undefined || pr.host === update.host));
      if (!binding) throw new NativeCallError("PR is not bound to this Desktop session");
      // LocalSessions fixes actor="person" internally; its fifth public argument is host.
      await this.inspector.call("setBoundPrAutoFix", [id, binding.repo, binding.prNumber, update.enabled, binding.host]);
    } else if (update.target === "own-prs") {
      if (!before.capabilities.onlyOwnPrs) throw new NativeCallError("当前 Claude Desktop 版本不支持读取或设置我的 PR 偏好。");
      await this.inspector.call("setAutoFixOwnPrsWanted", [id, update.enabled]);
    } else {
      if (!before.capabilities.nextPr) throw new NativeCallError("当前 Claude Desktop 版本不支持下一个 PR 布防。");
      if (!update.enabled) throw new NativeCallError("当前 Desktop 不支持远程取消布防。");
      const git = record(await this.inspector.call("getGitInfo", [this.executionCwd(update.sessionId)!]));
      if (typeof git.branch !== "string" || !git.branch) throw new NativeCallError("Desktop 当前工作目录没有可布防的 Git 分支。");
      await this.inspector.startAutoFixOnNextPr!(id, git.branch);
    }
    const state = await this.readPrAutoFix(update.sessionId);
    const applied = update.target === "bound" ? state.prs.find(pr => pr.repo === update.repo && pr.prNumber === update.prNumber && (update.host === undefined || pr.host === update.host))?.autoFix === true
      : update.target === "own-prs" ? state.onlyOwnPrs : state.nextOwnPrArmed;
    if (applied !== update.enabled) throw new NativeCallError("Desktop 未应用 Auto-fix 设置，请刷新状态。");
    await this.record({ sessionId: update.sessionId, origin: "claude-desktop", type: "pr.autoFix.updated", data: {
      ...update, state, resolvedByDeviceId: resolver.deviceId, resolvedByName: resolver.name, resolvedAt: Date.now(),
    } });
    return state;
  }

  permissionsList(): BridgePermissionInfo[] { return [...this.permissions.values()]; }

  /** True while a manual decision is being applied; the passive diff must not preempt it. */
  permissionResolutionInFlight(requestId: string): boolean {
    return this.resolvingPermissions.has(requestId);
  }

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
    this.resolvingPermissions.add(requestId);
    try {
      await this.inspector.call("respondToToolPermission", [requestId, decision === "allow-once" ? "once" : decision === "allow-always" ? "always" : "deny", response]);
      if (modeChange) modeChange.state = "not-applied";
      await this.refreshRuntime();
      if (this.permissions.has(requestId)) return false;
      await this.record({ sessionId: request.sessionId, origin: "claude-desktop", type: "permission.resolved", data: { requestId, decision, resolvedByDeviceId: resolver?.deviceId ?? "desktop", resolvedByName: resolver?.name ?? "Desktop", resolvedAt: Date.now() } });
      return true;
    } finally {
      this.resolvingPermissions.delete(requestId);
    }
  }

  private scheduleEventProjection(): void {
    if (this.closed || this.pendingEvents || this.eventProjection) return;
    // Keep one final projection after the burst's message/evidence writes settle.
    this.eventProjection = setImmediate(() => {
      this.eventProjection = undefined;
      this.projectSessions();
      this.emit("changed");
    });
  }

  private observeReply(sessionId: string, message: Record<string, unknown>, error: boolean): void {
    if (error) { this.replyTurns.delete(sessionId); return; }
    const visible = visibleMessage(message);
    if (visible?.role === "user" && typeof message.uuid === "string") {
      this.replyTurns.set(sessionId, { rootId: message.uuid });
    } else if (visible?.role === "assistant" && message.isSynthetic !== true) {
      const body = record(message.message);
      if (body.model === "<synthetic>" || (Array.isArray(body.content) && body.content.some(block => record(block).type === "tool_use"))) return;
      const id = typeof body.id === "string" ? body.id : message.uuid;
      if (typeof id === "string") this.replyTurns.set(sessionId, { ...this.replyTurns.get(sessionId), reply: { id, text: visible.text! } });
    } else if (message.type === "result" && !message.parent_tool_use_id && message.isSyntheticResult !== true) {
      const turn = this.replyTurns.get(sessionId);
      this.replyTurns.delete(sessionId);
      if (message.is_error !== false || !turn?.reply) return;
      const roots = [...(Array.isArray(message.user_message_uuids) ? message.user_message_uuids : []), message.user_message_uuid]
        .filter((value): value is string => typeof value === "string");
      if (!roots.length && turn.rootId) roots.push(turn.rootId);
      const text = turn.reply.text.replace(/^【给用户】\s*/u, "");
      if (text && (roots.some(id => this.historyReceipt(sessionId, id)?.source !== "assistant-trigger") ||
        (roots.length > 0 && text !== turn.reply.text))) {
        this.emit("assistant.user-reply", sessionId, turn.reply.id, text);
      }
    }
  }

  private async handleEvent(raw: unknown): Promise<void> {
    const event = record(raw);
    if (typeof event.sessionId !== "string") return;
    if (NATIVE_PROMPTS.some(spec => "event" in spec && (event.type === spec.event || event.type === `${spec.event}_resolved`))) {
      await this.refreshRuntime();
      return;
    }
    if (event.type === "bridge_pr_auto_fix_settled") {
      const state = await this.readPrAutoFix(event.sessionId);
      await this.record({ sessionId: event.sessionId, origin: "claude-desktop", type: "pr.autoFix.updated", data: {
        target: "next-pr", phase: "settled", enabled: event.enabled, state, result: event.result, ...(typeof event.error === "string" ? { error: event.error } : {}),
      } });
      return;
    }
    const sessionId = event.sessionId;
    const message = record(event.message);
    const sidechain = message.isSidechain === true || (message.parent_tool_use_id && (message.type === "assistant" || message.type === "user" || message.type === "system" || message.type === "stream_event"));
    let compacting: boolean | undefined;
    if (!sidechain) {
      if (this.listenerCount("assistant.user-reply")) this.observeReply(sessionId, message, event.type === "error" || event.type === "close");
      if (message.type === "system" && message.subtype === "status") {
        if (message.status === "compacting") compacting = true;
        else if (message.status === null) compacting = false;
      } else if ((message.type === "system" && message.subtype === "compact_boundary") || (message.type === "result" && !message.parent_tool_use_id && message.isSyntheticResult !== true) || event.type === "error") compacting = false;
    }
    if (event.session || compacting !== undefined) {
      const session = event.session ? nativeSession(event.session) : undefined;
      await this.serialized(async () => {
        if (session) await this.observeNativeSession(session);
        if (compacting === true) this.compactingSessions.add(sessionId);
        else if (compacting === false) this.compactingSessions.delete(sessionId);
      });
    }
    if (!this.native.has(sessionId)) return;
    const deliveries: BridgeEventDraft[] = [];
    if (event.type === "steers_rekeyed" && Array.isArray(event.rekeyedSteers)) {
      for (const rawRekey of event.rekeyedSteers) {
        const rekey = record(rawRekey);
        if (typeof rekey.from !== "string" || typeof rekey.to !== "string") continue;
        const receipt = [...this.receipts.values()].find(candidate => candidate.sessionId === sessionId && candidate.messageId === rekey.from);
        if (!receipt) continue;
        if (receipt.source === "assistant-trigger" && rekey.from !== rekey.to) {
          receipt.previousMessageIds = [...new Set([...(receipt.previousMessageIds ?? []), rekey.from])];
        }
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
    if (sidechain) return;
    if (message.type === "system" && message.subtype === "init" && Array.isArray(message.tools)) {
      this.emit("system.init", sessionId, message.tools.filter((tool): tool is string => typeof tool === "string"));
    }
    const stream = record(message.event);
    if (message.type === "stream_event" && !message.parent_tool_use_id) {
      if (stream.type === "message_start") {
        const streamMessage = record(stream.message);
        const id = streamMessage.id;
        if (typeof id === "string") this.streams.set(sessionId, id);
        applyStreamStartContext(this.ensureContextState(sessionId, this.native.get(sessionId)?.model ?? "default"), message, streamMessage, id);
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
        this.trackReceivedInput(receipt);
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
        applyAssistantMessageContext(this.ensureContextState(sessionId, this.native.get(sessionId)?.model ?? "default"), message, body);
      }
      if (Array.isArray(body.content)) for (const rawBlock of body.content) {
        const block = record(rawBlock);
        if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") this.tools.set(block.id, { id: block.id, toolName: block.name, input: block.input, startedAt: Date.now() });
      }
      const projection = this.messageProjection.get(sessionId) ?? {};
      this.messageProjection.set(sessionId, projection);
      const proposalResults: string[] = [];
      const items = nativeHistoryItems(sessionId, [event.message], projection, proposalResults);
      await this.enrichSubagentItems(sessionId, items);
      for (const item of items) {
        const receipt = item.role === "user" ? this.historyReceipt(sessionId, item.id) : undefined;
        if (item.role === "assistant") await this.options.eventLog.flushDeltas(sessionId);
        await this.record(nativeItemEventDraft(sessionId, item, receipt));
      }
      const sentFilesByTool = await this.nativeSentFiles(sessionId, [event.message], true);
      if (Array.isArray(body.content)) for (const rawBlock of body.content) {
        const block = record(rawBlock);
        if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
          const sentFiles = sentFilesByTool?.get(block.tool_use_id);
          const tool = this.tools.get(block.tool_use_id);
          this.tools.delete(block.tool_use_id);
          const started = this.options.eventLog.latestItem(sessionId, "tool.started", block.tool_use_id);
          const rawToolName = sentFiles ? "SendUserFile" : tool?.toolName ?? started?.data.toolName;
          const toolName = typeof rawToolName === "string" && rawToolName ? rawToolName : undefined;
          const proposalResult = (!toolName || toolName === "mcp__ccd_session__start_session") && proposalResults.includes(block.tool_use_id);
          if ((toolName || proposalResult) && toolName !== "mcp__ccd_turn__update_plan" && toolName !== "mcp__ccd_turn__wrap_up") {
            await this.record({
              sessionId,
              itemId: block.tool_use_id,
              origin: "claude-desktop",
              type: "tool.completed",
              data: {
                ...(toolName ? { toolName } : {}),
                text: tool && toolName ? summarizeNativeToolInput(toolName, tool.input) : started?.data.text ?? "",
                ...(proposalResult ? { sessionProposalResult: true } : {}),
                ...(sentFiles ? { sentFiles } : {}),
                ...(block.is_error === true ? { isError: true } : {}),
              },
            });
          }
          if (tool && this.options.evidence) {
            tool.output = block.content; tool.completedAt = Date.now();
            const input = record(tool.input);
            const paths = [input.file_path, input.path].filter((path): path is string => typeof path === "string");
            await this.options.evidence.upsertDesktopEvidence({ id: `native:${sessionId}:${tool.id}`, sessionId, cwd: this.native.get(sessionId)!.cwd, readCwd: this.executionCwd(sessionId)!, startedAt: tool.startedAt, completedAt: tool.completedAt, tools: [tool], paths });
          }
        }
      }
      if (message.type === "result") {
        if (!message.parent_tool_use_id && message.isSyntheticResult !== true && message.is_error === false) {
          await this.settleReceivedInputs(this.native.get(sessionId)!);
          this.lastCompletedTurns.set(sessionId, typeof message.uuid === "string" ? message.uuid : commandUuids.at(-1) ?? randomUUID());
        }
        const context = this.contextStates.get(sessionId);
        applyResultModelUsageContext(context, message, context?.turnModel ?? this.native.get(sessionId)?.model);
        if (context) delete context.turnModel;
        if (!indexedResult) await this.record({ sessionId, ...(typeof message.uuid === "string" ? { itemId: message.uuid } : {}), origin: "claude-desktop", type: message.is_error === true ? "turn.failed" : "turn.completed", data: { ...(message.is_error === true ? { error: message.result ?? message.errors } : {}) } });
      }
    }
    if (event.type === "error") await this.record({ sessionId, origin: "claude-desktop", type: "turn.failed", data: { error: event.error } });
  }

  private async record(draft: BridgeEventDraft): Promise<void> {
    if (draft.sessionId && draft.itemId && this.options.eventLog.itemMatches(draft.sessionId, draft.type, draft.itemId, draft.data ?? {})) return;
    await this.options.eventLog.append(draft);
  }

  private report(error: unknown): void { this.lastError = error instanceof Error ? error.message : String(error); this.emit("changed"); }

  private async discoverGateway(readSettings: () => Promise<unknown>): Promise<QueryGatewayDiscovery> {
    // Manual gateway credentials are for quota and model queries only.
    const { magpieConnection, environment, home, platform } = this.options;
    const discovery: QueryGatewayDiscovery = magpieConnection?.isManual()
      ? { mode: "manual", gateway: await resolveClaudeGatewayConfig(magpieConnection.apply({ environment: {} })) }
      : { mode: "auto", ...await discoverClaudeGateway({
          ...(environment ? { environment } : {}),
          ...(home ? { home } : {}),
          ...(platform ? { platform } : {}),
        }, readSettings) };
    this.gateway = discovery.gateway;
    return discovery;
  }

  async gatewayConfig(): Promise<ClaudeGatewayConfig | undefined> {
    return (await this.discoverGateway(() => readClaudeConfig(this.options.settingsPath))).gateway;
  }
  magpieSettings() { return this.options.magpieConnection ? { magpie: this.options.magpieConnection.settings(this.gateway) } : {}; }
  async testMagpieConnection(input: unknown) {
    const repository = this.options.magpieConnection;
    if (!repository) throw new Error("Magpie connection settings are unavailable");
    const resolved = repository.resolve(input);
    if (resolved.mode === "auto") {
      const gateway = await discoverClaudeGatewayConfig({
        ...(this.options.environment ? { environment: this.options.environment } : {}),
        ...(this.options.home ? { home: this.options.home } : {}),
        ...(this.options.platform ? { platform: this.options.platform } : {}),
        settingsPath: this.options.settingsPath,
      });
      return testMagpieGateway({ environment: {} }, gateway, this.options.fetchImpl);
    }
    const candidate = repository.apply({ environment: {} }, resolved);
    return testMagpieGateway(candidate, await resolveClaudeGatewayConfig(candidate), this.options.fetchImpl);
  }
  async saveMagpieConnection(input: unknown): Promise<void> {
    const repository = this.options.magpieConnection;
    if (!repository) throw new Error("Magpie connection settings are unavailable");
    const connection = repository.resolve(input);
    await repository.save(connection);
    delete this.gatewayModelsCache[connection.mode];
    await this.refreshModelCatalog("force");
    this.projectSessions();
    this.emit("changed");
  }

  diagnosticsGauges() {
    const inspectorGauges = this.inspector.diagnosticsGauges?.() ?? {
      state: this.inspector.ready ? "connected" as const : "disconnected" as const,
      pendingCalls: { count: 0, oldestMs: 0 },
      eventStreamWaiting: false,
      supportedMethods: 0,
    };
    let activeTurns = 0;
    for (const session of this.sessions.values()) {
      if (session.turnState === "running" || session.turnState === "waiting") activeTurns += 1;
    }
    return {
      closed: this.closed,
      inspectorState: inspectorGauges.state,
      pendingInspectorCalls: inspectorGauges.pendingCalls,
      inspectorEventStreamWaiting: inspectorGauges.eventStreamWaiting,
      inspectorSupportedMethods: inspectorGauges.supportedMethods,
      pendingEvents: this.pendingEvents,
      nativeSessions: this.native.size,
      projectedSessions: this.sessions.size,
      activeTurns,
      permissions: this.permissions.size,
      resolvingPermissions: this.resolvingPermissions.size,
      prompts: this.prompts.size,
      receipts: this.receipts.size,
      streams: this.streams.size,
      inFlightTools: this.tools.size,
      compactingSessions: this.compactingSessions.size,
      cachedCatalogs: {
        projectDirectories: this.projectDirectories.size,
        sections: this.sectionCatalog?.sections.length ?? 0,
        sectionAssignments: Object.keys(this.sectionCatalog?.assignments ?? {}).length,
        models: this.models?.length ?? 0,
        messageProjections: this.messageProjection.size,
        contextStates: this.contextStates.size,
        backgroundTaskSessions: this.backgroundTasks.size,
        prPreferences: this.prPreferences.size,
      },
    };
  }
}
