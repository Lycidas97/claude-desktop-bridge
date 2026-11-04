import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { copyFile, mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import { CLAUDE_INTERRUPTED_USER_MESSAGE } from "@bridge/protocol";
import type {
  BridgeAttachment,
  BridgeConfigurationSource,
  BridgeEffort,
  BridgeHistoryPage,
  BridgeOwnershipState,
  BridgePermissionMode,
  BridgePermissionPolicy,
  BridgeProjectInfo,
  BridgeRuntimeStatus,
  BridgeSessionConfiguration,
  BridgeSessionContextUsage,
  BridgeSessionInfo,
  BridgeSubagentSummary,
  BridgeTurnState,
} from "@bridge/protocol";
import type {
  ClaudeDesktopSessionRegistrar,
  StoredDesktopRegistration,
} from "./claude-desktop-session-registrar.js";
import { ClaudeSessionHost, type ClaudeSessionHostOptions, type SessionHostEvent, type SessionHostBackgroundTask } from "./claude-session-host.js";
import {
  claudeDesktopProfileForPath,
  listClaudeDesktopSessions,
  type ClaudeDesktopProfile,
} from "./claude-desktop-sessions.js";
import { signalProcess } from "./claude-desktop-lifecycle.js";
import {
  findClaudeTranscriptFile,
  parseClaudeTranscriptSnapshot,
  readClaudeSessionContextEstimate,
  readClaudeSessionSubagents,
} from "./claude-history.js";
import {
  isClaudeSessionProcess,
  oldestLiveProcessStart,
  projectIdForCwd,
  scanClaudeSessionProcesses,
  type ClaudeCatalogSnapshot,
} from "./claude-session-catalog.js";
import { PermissionBroker, type PermissionDecision } from "./permission-broker.js";
import type { ClaudeRuntimePaths } from "./platform.js";
import {
  discoverClaudeGatewayModels,
  parseMagpieSyntheticModelId,
  prepareClaudeRuntime,
  resolveClaudeGatewayConfig,
  type ClaudeGatewayConfig,
} from "./claude-runtime-discovery.js";
import type { BridgeEventDraft, SessionEventLog } from "./session-event-log.js";
import { readCommandEvidence, type CommandEvidence } from "./command-evidence.js";
import { SessionTaskState } from "./session-task-state.js";
import { readSessionHistory } from "./session-history.js";
import { SessionDesktopRegistration } from "./session-desktop-registration.js";
import { SessionModelCatalog } from "./session-model-catalog.js";
import {
  ANTHROPIC_API_PROFILE_ID,
  CLAUDE_3P_PROFILE_ID,
  CLAUDE_OFFICIAL_PROFILE_ID,
  ConversationStateStore,
  legacyClaudeLaneId,
} from "./conversation-state-store.js";
import type { BridgeConversationRoute, BridgeExecutionLane } from "@bridge/protocol";
import type { ProviderRuntimePool } from "./provider-runtime-pool.js";

interface StoredBridgeSession {
  sessionId: string;
  cwd: string;
  title: string;
  createdAt: number;
  desktopSessionId?: string;
  parentSessionId?: string;
  parentDesktopSessionId?: string;
  forkLabel?: string;
  hostModel?: string;
  hostEffort?: BridgeEffort;
  desktopRegistration?: StoredDesktopRegistration;
  fallbackConfirmedAt?: number;
}

interface StoredSessionConfiguration {
  sessionId: string;
  model?: string;
  effort?: BridgeEffort;
  permissionMode?: BridgePermissionMode;
  desktopBaseline?: { model?: string; effort?: BridgeEffort };
  updatedAt: number;
}

interface BridgeSessionsFile {
  version: 2;
  sessions: StoredBridgeSession[];
  configurations?: StoredSessionConfiguration[];
}

export interface QueuedTurn {
  commandId: string;
  requestId: string;
  idempotencyKey: string;
  sessionId: string;
  laneId: string;
  text: string;
  attachments: BridgeAttachment[];
  origin: "desktop" | "mobile" | "system";
  sourceDeviceId?: string;
  requestedAt: number;
  priority: number;
  attempts: number;
  state: "queued" | "running" | "uncertain";
  mode?: "start" | "steer" | "handoff";
  transport?: "claude-desktop-managed" | "bridge-host";
  turnId?: string;
  messageId?: string;
  evidenceId?: string;
  submissionStartedAt?: number;
  sessionAcceptedAt?: number;
  uncertainResolved?: "confirmed";
  sessionCwd?: string;
  sessionTitle?: string;
  desktopSessionId?: string;
  recoveryBlocked?: boolean;
}

interface TurnQueueFile {
  version: 2;
  pending: QueuedTurn[];
  completedIdempotencyKeys: string[];
  terminalTurns?: TerminalTurnReceipt[];
}

type TerminalTurnState = "completed" | "failed" | "cancelled";

interface TerminalTurnReceipt {
  idempotencyKey: string;
  commandId: string;
  requestId: string;
  sessionId: string;
  state: TerminalTurnState;
}

export interface TurnReceipt {
  commandId: string;
  requestId: string;
  idempotencyKey: string;
  sessionId: string;
  state: QueuedTurn["state"] | TerminalTurnState;
}

interface SessionRuntimeState {
  ownership: BridgeOwnershipState;
  turnState: BridgeTurnState;
  host?: SessionHostRuntime;
  hostLaneId?: string;
  hostGeneration?: string;
  active?: QueuedTurn;
  externalWriteVersion?: number;
  configurationPending?: boolean;
  releaseTimer?: ReturnType<typeof setTimeout>;
}

export interface SessionHostRuntime {
  readonly runningBackgroundTasks?: readonly SessionHostBackgroundTask[];
  readonly backgroundTasksKnown?: boolean;
  readonly hasPendingInput?: boolean;
  readonly initialized?: boolean;
  start(): void;
  send(
    input: Parameters<ClaudeSessionHost["send"]>[0],
    origin: Parameters<ClaudeSessionHost["send"]>[1],
  ): ReturnType<ClaudeSessionHost["send"]>;
  setModel(model?: string): Promise<void>;
  setEffort(effort?: BridgeEffort): Promise<void>;
  setAutoCompactWindow(maxTokens?: number): Promise<void>;
  supportedModels(): ReturnType<ClaudeSessionHost["supportedModels"]>;
  contextUsage(): ReturnType<ClaudeSessionHost["contextUsage"]>;
  interrupt(): Promise<void>;
  stopTask(taskId: string): Promise<void>;
  close(): Promise<void>;
  onEvent(listener: (event: SessionHostEvent) => void): () => void;
}

export interface TranscriptObserverRuntime {
  readonly catalog: ClaudeCatalogSnapshot;
  isDesktopBusy(sessionId: string, now?: number): boolean;
  isMainTurnBusy(sessionId: string, now?: number): boolean;
  runningSubagents(sessionId: string): { count: number; lastUpdatedAt: number } | undefined;
  externalWriteVersion(sessionId: string): number;
  canStartBridgeHost(sessionId: string, reusingIdleHost?: boolean): Promise<boolean>;
  onCatalog(listener: (catalog: ClaudeCatalogSnapshot) => void): () => void;
  setSessionAlias?(nativeSessionId: string, logicalSessionId: string): void;
  setHostTaskAuthority?(sessionId: string, active: boolean): void;
}

export interface SessionBrokerOptions {
  paths: ClaudeRuntimePaths;
  eventLog: SessionEventLog;
  observer: TranscriptObserverRuntime;
  sessionsPath: string;
  queuePath: string;
  conversationState?: ConversationStateStore;
  runtimePool?: ProviderRuntimePool;
  maxParallelTurns?: number;
  hostFactory?: (options: ClaudeSessionHostOptions) => SessionHostRuntime;
  prepareRuntime?: typeof prepareClaudeRuntime;
  discoverGatewayModels?: typeof discoverClaudeGatewayModels;
  scanSessionProcesses?: typeof scanClaudeSessionProcesses;
  runtimeRetryDelayMs?: number;
  desktopRegistrar?: Pick<
    ClaudeDesktopSessionRegistrar,
    "register" | "publicInfo" | "changed"
  >;
  evidence?: {
    startBridgeTurn(input: {
      sessionId: string;
      cwd: string;
      commandId: string;
      laneId?: string;
      providerProfileId?: string;
      startedAt?: number;
    }): Promise<string>;
    attachTurn(evidenceId: string, turnId: string): Promise<void>;
    recordToolStarted(input: {
      sessionId: string;
      turnId?: string;
      itemId: string;
      toolName: string;
      toolInput: unknown;
      at: number;
    }): Promise<void>;
    recordToolCompleted(input: {
      sessionId: string;
      turnId?: string;
      itemId: string;
      output: unknown;
      at: number;
    }): Promise<void>;
    finalizeBridgeTurn(input: {
      sessionId: string;
      turnId?: string;
      failed?: boolean;
      error?: string;
      completedAt?: number;
    }): Promise<unknown>;
  };
}

export interface StartTurnInput {
  requestId: string;
  idempotencyKey: string;
  sessionId: string;
  text: string;
  attachments?: BridgeAttachment[];
  origin: "desktop" | "mobile";
  sourceDeviceId?: string;
  priority?: number;
  mode?: "start" | "steer";
}

export interface ConfigureSessionInput {
  sessionId: string;
  model?: string | null;
  effort?: BridgeEffort | null;
}

interface EffectiveSessionProfile {
  model?: string;
  effort?: BridgeEffort;
  ultracode?: boolean;
  inheritedModel?: string;
  inheritedEffort?: BridgeEffort;
  modelSource: BridgeConfigurationSource;
  effortSource: BridgeConfigurationSource;
}

const EFFORT_LEVELS: BridgeEffort[] = ["low", "medium", "high", "xhigh", "max"];
const MODEL_DISCOVERY_TIMEOUT_MS = 8_000;
const RUNTIME_RETRY_DELAY_MS = 2_000;
const SESSION_RELEASE_DELAY_MS = 15_000;

function compact(value: string, max = 160): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

async function transcriptCwd(path: string): Promise<string | undefined> {
  const handle = await open(path, "r").catch(() => undefined);
  if (!handle) return undefined;
  try {
    const buffer = Buffer.alloc(512 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    for (const line of buffer.subarray(0, bytesRead).toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line) as { cwd?: unknown };
        if (typeof value.cwd === "string" && isAbsolute(value.cwd)) return value.cwd;
      } catch {
        // A partial final line is expected when the bounded read stops mid-record.
      }
    }
  } finally {
    await handle.close();
  }
  return undefined;
}

export class SessionBroker extends EventEmitter {
  readonly permissionBroker: PermissionBroker;
  private readonly maxParallelTurns: number;
  private readonly hostFactory: NonNullable<SessionBrokerOptions["hostFactory"]>;
  private readonly runtimeFactory: typeof prepareClaudeRuntime;
  private readonly gatewayModelDiscoverer: typeof discoverClaudeGatewayModels;
  private readonly sessionProcessScanner: typeof scanClaudeSessionProcesses;
  private readonly runtimeStates = new Map<string, SessionRuntimeState>();
  private readonly taskState = new SessionTaskState();
  private readonly bridgeSessions = new Map<string, StoredBridgeSession>();
  private readonly sessionConfigurations = new Map<string, StoredSessionConfiguration>();
  private readonly modelCatalog = new SessionModelCatalog();
  private readonly hostStarts = new Map<string, Promise<SessionHostRuntime>>();
  private readonly conflictTasks = new Map<string, Promise<void>>();
  private readonly forcedStops = new Set<Promise<void>>();
  private readonly desktopRegistration: SessionDesktopRegistration;
  private readonly pending: QueuedTurn[] = [];
  private readonly completedKeys = new Set<string>();
  private readonly terminalTurns = new Map<string, TerminalTurnReceipt>();
  private catalog: ClaudeCatalogSnapshot = { projects: [], sessions: [], observedAt: 0 };
  private runtime: Awaited<ReturnType<typeof prepareClaudeRuntime>> | undefined;
  private defaultPermissionMode: BridgePermissionMode = "standard";
  private activeTurns = 0;
  private initialized = false;
  private closed = false;
  private runtimeRetryTimer: NodeJS.Timeout | undefined;
  private readonly takeoverRetryTimers = new Map<string, NodeJS.Timeout>();
  private runtimeRefresh: Promise<boolean> | undefined;
  private writeQueue: Promise<void> = Promise.resolve();
  private eventQueue: Promise<void> = Promise.resolve();
  private pumpQueue: Promise<void> = Promise.resolve();
  private readonly dispatching = new Map<string, Promise<void>>();
  private readonly toolNames = new Map<string, string>();
  private readonly forceStoppedTurnIds = new Set<string>();
  private evidenceFailureReported = false;

  constructor(private readonly options: SessionBrokerOptions) {
    super();
    this.permissionBroker = new PermissionBroker(
      (sessionId) => this.permissionPolicy(sessionId).effectiveMode,
    );
    this.maxParallelTurns = options.maxParallelTurns ?? 8;
    this.hostFactory = options.hostFactory ?? ((hostOptions) => new ClaudeSessionHost(hostOptions));
    this.runtimeFactory = options.prepareRuntime ?? prepareClaudeRuntime;
    this.gatewayModelDiscoverer = options.discoverGatewayModels ?? discoverClaudeGatewayModels;
    this.sessionProcessScanner = options.scanSessionProcesses ?? scanClaudeSessionProcesses;
    this.desktopRegistration = new SessionDesktopRegistration({
      registrar: options.desktopRegistrar,
      context: (sessionId) => {
        const session = this.bridgeSessions.get(sessionId);
        if (!session || this.closed) return undefined;
        const overrides = this.sessionConfigurations.get(sessionId);
        return {
          session, activeTurn: Boolean(this.runtimeStates.get(sessionId)?.active),
          profile: this.effectiveProfile(sessionId, session.cwd, overrides), overrides,
          permissionMode: this.permissionPolicy(sessionId).effectiveMode,
          lastActivityAt: this.catalog.sessions.find((candidate) => candidate.sessionId === sessionId)?.lastActivityAt,
        };
      },
      persist: () => this.saveSessions(), record: (event) => this.record(event),
      changed: () => { this.emit("changed"); },
    });
  }

  private async evidenceCall<T>(action: () => Promise<T>): Promise<T | undefined> {
    try {
      return await action();
    } catch {
      if (!this.evidenceFailureReported) {
        this.evidenceFailureReported = true;
        process.stderr.write("Bridge evidence capture failed; the Claude task will continue.\n");
      }
      return undefined;
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    if (this.options.conversationState) {
      await Promise.all([
        this.options.eventLog.initialize(),
        this.options.conversationState.initialize(),
      ]);
      await this.loadConversationState();
    } else {
      await Promise.all([
        this.options.eventLog.initialize(),
        this.loadSessions(),
        this.loadQueue(),
      ]);
    }
    this.catalog = this.options.observer.catalog;
    this.reconcileRotatedCatalogSessions();
    this.refreshRecoveryBlocks();
    this.modelCatalog.rememberCatalogModels(this.catalog.sessions);
    this.options.observer.onCatalog((catalog) => {
      if (this.closed) return;
      this.catalog = catalog;
      this.reconcileRotatedCatalogSessions();
      this.refreshRecoveryBlocks();
      this.modelCatalog.rememberCatalogModels(this.catalog.sessions);
      this.refreshObservedOwnership();
      this.emit("changed");
      this.reconcileDesktopRegistrations();
      void this.pump();
    });
    this.permissionBroker.on("requested", (request) => {
      const type = request.toolName === "AskUserQuestion" ? "question.requested" : "permission.requested";
      const state = this.runtimeStates.get(request.sessionId);
      if (state?.active) state.turnState = "waiting";
      this.eventQueue = this.eventQueue
        .catch(() => undefined)
        .then(() => this.record({
          sessionId: request.sessionId,
          itemId: request.requestId,
          timestamp: request.createdAt,
          origin: "claude-host",
          type,
          data: {
            requestId: request.requestId,
            toolUseId: request.toolUseId,
            toolName: request.toolName,
            title: request.title ?? "",
            displayName: request.displayName ?? "",
            description: request.description ?? "",
            input: request.input,
            createdAt: request.createdAt,
            canAllowAlways: request.suggestions.some(
              (suggestion: { destination?: string }) => suggestion.destination === "localSettings",
            ),
          },
        }));
      this.emit("changed");
    });
    this.permissionBroker.on("resolved", (request, result, resolution) => {
      const type = request.toolName === "AskUserQuestion" ? "question.resolved" : "permission.resolved";
      const state = this.runtimeStates.get(request.sessionId);
      if (state?.turnState === "waiting" && this.permissionBroker.list(request.sessionId).length === 0) {
        state.turnState = state.active ? "running" : "idle";
      }
      this.eventQueue = this.eventQueue
        .catch(() => undefined)
        .then(() => this.record({
          sessionId: request.sessionId,
          itemId: request.requestId,
          timestamp: resolution.resolvedAt,
          origin: "system",
          type,
          data: {
            requestId: request.requestId,
            toolUseId: request.toolUseId,
            toolName: request.toolName,
            input: request.input,
            decision: resolution.decision,
            resolvedByDeviceId: resolution.resolvedByDeviceId,
            resolvedByName: resolution.resolvedByName,
            resolvedAt: resolution.resolvedAt,
            behavior: result.behavior,
            ...(resolution.automatic ? { automatic: true } : {}),
            ...(resolution.reason ? { reason: resolution.reason } : {}),
          },
        }));
      this.emit("changed");
    });
    await this.refreshRuntime();
    this.reconcileDesktopRegistrations();
    await this.pump();
  }

  async refreshRuntime(): Promise<boolean> {
    if (this.closed) return false;
    if (this.runtimeRefresh) return this.runtimeRefresh;
    const refresh = (async () => {
      const previous = this.runtime;
      const next = await this.runtimeFactory(process.env, previous);
      if (this.closed) return false;
      this.runtime = next;
      const credentialChanged = (
        previous?.credentialPath !== next.credentialPath ||
        previous?.environment?.ANTHROPIC_BASE_URL !== next.environment?.ANTHROPIC_BASE_URL
      );
      const gatewayDiscoveredBefore = this.modelCatalog.gatewayModelsDiscovered;
      if (credentialChanged || !this.modelCatalog.gatewayModelsDiscovered) {
        await this.refreshGatewayModels(next);
      }
      const changed = (
        previous?.executablePath !== next.executablePath ||
        previous?.credentialPath !== next.credentialPath ||
        previous?.version !== next.version ||
        gatewayDiscoveredBefore !== this.modelCatalog.gatewayModelsDiscovered
      );
      if (next.executablePath && next.credentialPath) this.clearRuntimeRetry();
      else this.scheduleRuntimeRetry();
      if (changed) {
        this.emit("changed");
        void this.pump();
      }
      return changed;
    })().finally(() => {
      if (this.runtimeRefresh === refresh) this.runtimeRefresh = undefined;
    });
    this.runtimeRefresh = refresh;
    return refresh;
  }

  /** The gateway Claude-3p sessions run through, as this runtime was prepared. */
  gatewayConfig(): Promise<ClaudeGatewayConfig | undefined> {
    return resolveClaudeGatewayConfig(this.runtime);
  }

  runtimeStatus(): BridgeRuntimeStatus {
    const withDesktop =(status: Omit<BridgeRuntimeStatus, "desktopIntegration">): BridgeRuntimeStatus => (
      {
        ...status,
        desktopIntegration: {
          state: "not-managed",
          detail: "Bridge 后台通过 Agent SDK 执行；Desktop 会话仅同步观察。",
          enabled: false,
          canRestart: process.platform === "darwin" || process.platform === "win32",
        },
      }
    );
    if (!this.runtime?.executablePath) {
      return withDesktop({
        state: "unavailable",
        detail: "未找到 Claude CLI Host 运行时。",
        activeTurns: this.activeTurns,
        maxParallelTurns: this.maxParallelTurns,
      });
    }
    if (!this.runtime.credentialPath) {
      return withDesktop({
        state: "auth-required",
        detail: "未找到 Claude Desktop 第三方 Host 凭据。Bridge 不提供官方账号登录。",
        ...(this.runtime.version ? { version: this.runtime.version } : {}),
        activeTurns: this.activeTurns,
        maxParallelTurns: this.maxParallelTurns,
      });
    }
    return withDesktop({
      state: this.activeTurns > 0 ? "working" : "ready",
      detail: this.activeTurns > 0
        ? `${this.activeTurns} 个会话正在处理。`
        : "Bridge Agent SDK 会话通道已就绪。",
      ...(this.runtime.version ? { version: this.runtime.version } : {}),
      credentialSource: "third-party-host",
      activeTurns: this.activeTurns,
      maxParallelTurns: this.maxParallelTurns,
    });
  }

  listProjects(): BridgeProjectInfo[] {
    const sessions = this.listSessions();
    const grouped = new Map<string, BridgeProjectInfo>();
    for (const session of sessions) {
      const current = grouped.get(session.projectId);
      if (current) {
        current.sessionCount += 1;
        current.runningCount += Number(session.turnState === "running" || session.turnState === "waiting");
        current.pendingCount += session.pendingCount;
        current.lastActivityAt = Math.max(current.lastActivityAt, session.lastActivityAt);
      } else {
        grouped.set(session.projectId, {
          projectId: session.projectId,
          name: session.projectName,
          cwd: session.cwd,
          sessionCount: 1,
          runningCount: Number(session.turnState === "running" || session.turnState === "waiting"),
          pendingCount: session.pendingCount,
          lastActivityAt: session.lastActivityAt,
          runtimeId: "claude-desktop",
        });
      }
    }
    return [...grouped.values()].sort((left, right) => right.lastActivityAt - left.lastActivityAt);
  }

  listSessions(projectId?: string, search?: string): BridgeSessionInfo[] {
    const observed = new Map(this.catalog.sessions.map((session) => [session.sessionId, session]));
    const archived = new Map((this.catalog.archivedSessions ?? []).map((session) => [session.sessionId, session]));
    const archivedSessionIds = this.catalog.archivedSessionIds;
    const queued = new Map<string, QueuedTurn>();
    for (const turn of this.pending) {
      if (!queued.has(turn.sessionId)) queued.set(turn.sessionId, turn);
    }
    const ids = new Set([
      ...observed.keys(),
      ...archived.keys(),
      ...this.bridgeSessions.keys(),
      ...this.runtimeStates.keys(),
      ...queued.keys(),
    ]);
    const sessions: BridgeSessionInfo[] = [];
    for (const sessionId of ids) {
      const archivedSource = observed.has(sessionId) || queued.has(sessionId) ? undefined : archived.get(sessionId);
      const source = observed.get(sessionId) ?? archivedSource;
      const associatedLane = source && this.options.conversationState
        ? this.options.conversationState.findLanesByNativeSessionId(sessionId).find((lane) => (
            (source.sourceProfile === "claude" && lane.providerKind === "claude-official") ||
            (source.sourceProfile === "claude-3p" && lane.providerKind === "claude-3p") ||
            source.sourceProfile === "unknown"
          ))
        : undefined;
      if (associatedLane && associatedLane.conversationId !== sessionId) continue;
      const bridge = this.bridgeSessions.get(sessionId);
      const queuedTurn = queued.get(sessionId);
      if (archivedSessionIds?.has(sessionId) && !archivedSource && !queuedTurn) continue;
      if (!source && !bridge && !queuedTurn) continue;
      const recoveredQueue = !source && !bridge;
      const cwd = source?.cwd
        ?? bridge?.cwd
        ?? queuedTurn?.sessionCwd
        ?? this.options.paths.projects;
      const state = this.runtimeStates.get(sessionId);
      const pendingCommandIds = this.pending.filter((turn) => (
        turn.sessionId === sessionId && (turn.state === "queued" || turn.state === "uncertain")
      )).map((turn) => turn.commandId);
      const pendingCount = pendingCommandIds.length;
      const desktopSessionId = source?.desktopSessionId ?? bridge?.desktopSessionId ?? queuedTurn?.desktopSessionId;
      const ownership = this.hasConfirmedOwnershipConflict(sessionId, state)
        ? "OWNERSHIP_CONFLICT"
        : state?.ownership
          ?? (source ? "DESKTOP_OBSERVED" : "BRIDGE_IDLE");
      const turnState = this.permissionBroker.list(sessionId).length > 0
        ? "waiting"
        : state?.turnState
          ?? (source && this.options.observer.isMainTurnBusy(sessionId) ? "running" : "idle");
      const profile = this.effectiveProfile(sessionId, cwd);
      const hostModel = this.modelForHost(profile);
      const modelDisplayName = this.modelCatalog.gatewayModelsDiscovered || Boolean(parseMagpieSyntheticModelId(hostModel))
        ? this.modelCatalog.resolveModelDisplayName(hostModel)
        : undefined;
      const route = this.options.conversationState?.route(sessionId);
      const parentSessionId = source?.parentSessionId ?? bridge?.parentSessionId;
      const parentObserved = parentSessionId ? observed.get(parentSessionId) : undefined;
      const forkLabel = source?.forkLabel ?? bridge?.forkLabel;
      const runningSubagents = this.taskState.hasAuthority(sessionId)
        ? this.taskState.runningSubagents(sessionId)
        : this.options.observer.runningSubagents(sessionId);
      const item: BridgeSessionInfo = {
        sessionId,
        ...(runningSubagents ? {
          runningSubagents,
          ...(state?.host
            ? { subagentStopScope: "task" as const }
            : source?.processAlive ? { subagentStopScope: "process" as const } : {}),
        } : {}),
        ...(turnState === "running" && !state?.host && source?.desktopProcessAlive
          ? { mainTurnStopScope: "process" as const }
          : {}),
        runtimeId: "claude-desktop",
        nativeSessionId: sessionId,
        ...(desktopSessionId ? { desktopSessionId } : {}),
        ...(parentSessionId ? { parentSessionId } : {}),
        ...(forkLabel ? { forkLabel } : {}),
        projectId: source?.projectId ?? parentObserved?.projectId ?? projectIdForCwd(cwd),
        projectName: source?.projectName ?? parentObserved?.projectName ?? (basename(cwd) || cwd),
        cwd,
        title: source?.desktopTitle
          ?? bridge?.title
          ?? source?.title
          ?? queuedTurn?.sessionTitle
          ?? `未完成任务：${compact(queuedTurn?.text ?? "", 72)}`,
        source: bridge || recoveredQueue ? "bridge" : "desktop",
        transport: "bridge-host",
        ownership,
        turnState: pendingCount > 0 && turnState === "idle" ? "queued" : turnState,
        ...(state?.active ? {
          executionStage: state.active.sessionAcceptedAt !== undefined ? "running" as const
            : state.host?.initialized === false ? "starting" as const : "submitted" as const,
        } : this.dispatching.has(sessionId) && state?.ownership === "ACQUIRING"
          ? { executionStage: "starting" as const } : {}),
        lastActivityAt: Math.max(
          source?.lastActivityAt ?? 0,
          bridge?.createdAt ?? 0,
          queuedTurn?.requestedAt ?? 0,
        ),
        pendingCount,
        pendingCommandIds,
        ...(state?.active?.turnId ? { activeTurnId: state.active.turnId } : {}),
        ...(state?.active?.text
          ? { currentSummary: compact(state.active.text) }
          : recoveredQueue && queuedTurn
            ? { currentSummary: `恢复的未完成任务 · ${compact(queuedTurn.text)}` }
            : {}),
        ...(profile.model ? { model: profile.model } : {}),
        ...(modelDisplayName ? { modelDisplayName } : {}),
        ...(profile.effort ? { effort: profile.effort } : {}),
        ...(state?.configurationPending ? { configurationPending: true } : {}),
        ...(bridge?.fallbackConfirmedAt ? { fallbackConfirmed: true } : {}),
        ...(bridge?.desktopRegistration && this.options.desktopRegistrar
          ? { desktopRegistration: this.options.desktopRegistrar.publicInfo(bridge.desktopRegistration) }
          : {}),
        ...(route ? {
          activeLaneId: route.activeLaneId,
          activeProviderProfileId: route.activeProviderProfileId,
          routeState: route.state,
          allowedActions: route.allowedActions,
          ...(route.pendingHandoff ? { pendingHandoff: route.pendingHandoff } : {}),
        } : {}),
        ...(archivedSource?.archivedAt ? { archivedAt: archivedSource.archivedAt } : {}),
      };
      if (projectId && item.projectId !== projectId) continue;
      if (search) {
        const query = search.toLocaleLowerCase();
        if (!`${item.title}\n${item.projectName}\n${item.cwd}`.toLocaleLowerCase().includes(query)) continue;
      }
      sessions.push(item);
    }
    const priority = (state: BridgeTurnState) => (
      state === "waiting" ? 3 : state === "running" ? 2 : state === "queued" ? 1 : 0
    );
    return sessions.sort((left, right) => (
      priority(right.turnState) - priority(left.turnState)
      || right.lastActivityAt - left.lastActivityAt
    ));
  }

  session(sessionId: string): BridgeSessionInfo | undefined {
    return this.listSessions().find((candidate) => candidate.sessionId === sessionId);
  }

  /** Claude Desktop's own record for a session, when Desktop lists it. */
  desktopArchiveRecord(sessionId: string): { desktopSessionId: string; metadataPath: string; archived: boolean } | undefined {
    const metadataPath = this.catalog.desktopMetadataPaths?.get(sessionId);
    const active = this.catalog.sessions.find((candidate) => candidate.sessionId === sessionId);
    const record = active ?? this.catalog.archivedSessions?.find((candidate) => candidate.sessionId === sessionId);
    if (!metadataPath || !record?.desktopSessionId) return undefined;
    return { desktopSessionId: record.desktopSessionId, metadataPath, archived: !active };
  }

  conversationRoute(sessionId: string): BridgeConversationRoute {
    const store = this.options.conversationState;
    if (!store) throw new Error("Conversation routing is unavailable");
    const existing = store.route(sessionId);
    if (existing) return existing;
    const session = this.session(sessionId);
    if (!session) throw new Error("Session not found");
    const observed = this.catalog.sessions.find((candidate) => candidate.sessionId === sessionId);
    const official = observed?.sourceProfile === "claude";
    return store.ensureConversation({
      conversationId: sessionId,
      cwd: session.cwd,
      title: session.title,
      source: session.source,
      providerProfileId: official ? CLAUDE_OFFICIAL_PROFILE_ID : CLAUDE_3P_PROFILE_ID,
      providerKind: official ? "claude-official" : "claude-3p",
      nativeSessionId: sessionId,
      access: official ? "read-only" : "read-write",
      createdAt: session.lastActivityAt,
    });
  }

  activeLane(sessionId: string): BridgeExecutionLane | undefined {
    return this.options.conversationState?.activeLane(sessionId);
  }

  hasActiveOrPending(sessionId: string): boolean {
    const state = this.runtimeStates.get(sessionId);
    return Boolean(state?.active) || this.pending.some((turn) => (
      turn.sessionId === sessionId &&
      (turn.state === "queued" || turn.state === "running" || turn.state === "uncertain")
    ));
  }

  async refreshDesktopConfiguration(sessionId: string): Promise<{ model?: string; effort?: BridgeEffort } | undefined> {
    await this.initialize();
    const observed = this.catalog.sessions.find((candidate) => candidate.sessionId === sessionId);
    const desktop = (await listClaudeDesktopSessions(this.options.paths.desktopSessions)).find((candidate) => (
          (candidate.cliSessionId === sessionId || candidate.priorCliSessionIds?.includes(sessionId))
          && (!observed?.desktopSessionId || candidate.sessionId === observed.desktopSessionId)
        ));
    if (!desktop) return;
    for (const session of [observed, this.bridgeSessions.get(sessionId)]) {
      if (!session) continue;
      if (desktop.model) session.hostModel = desktop.model;
      else delete session.hostModel;
      if (desktop.effort) session.hostEffort = desktop.effort;
      else delete session.hostEffort;
    }
    return desktop;
  }

  async configuration(sessionId: string, discoverModels = true): Promise<BridgeSessionConfiguration> {
    await this.refreshDesktopConfiguration(sessionId);
    const session = this.session(sessionId);
    if (!session) throw new Error("Session not found");
    const state = this.runtimeStates.get(sessionId);
    let host = state?.host;
    let modelsComplete = this.modelCatalog.modelCatalogComplete;
    let context: BridgeSessionContextUsage | undefined;

    if (discoverModels && !this.modelCatalog.gatewayModelsDiscovered) {
      if (await this.refreshGatewayModels()) {
        modelsComplete = true;
      }
    }
    if (
      discoverModels &&
      !host &&
      !this.modelCatalog.modelCatalogComplete &&
      !this.modelCatalog.modelCatalogDiscoveryAttempted
    ) {
      this.modelCatalog.modelCatalogDiscoveryAttempted = true;
      const models = await this.discoverModelsWithoutAttaching(session).catch(() => undefined);
      if (models?.length) {
        modelsComplete = true;
        this.modelCatalog.modelCatalogComplete = true;
        this.modelCatalog.rememberModels(models);
      }
    }
    if (host && discoverModels) {
      const [modelsResult, contextResult] = await Promise.allSettled([
        this.modelCatalog.gatewayModelsDiscovered ? Promise.resolve([]) : host.supportedModels(),
        host.contextUsage(),
      ]);
      if (
        !this.modelCatalog.gatewayModelsDiscovered &&
        modelsResult.status === "fulfilled" &&
        modelsResult.value.length > 0
      ) {
        modelsComplete = true;
        this.modelCatalog.modelCatalogComplete = true;
        this.modelCatalog.rememberModels(modelsResult.value);
      }
      if (contextResult.status === "fulfilled") {
        const usage = contextResult.value;
        context = {
          totalTokens: usage.totalTokens,
          maxTokens: usage.maxTokens,
          percentage: usage.percentage,
          model: usage.model,
          estimated: false,
        };
      }
      this.scheduleRelease(sessionId);
    }
    context ??= await this.estimatedContext(session);

    const profile = this.effectiveProfile(sessionId, session.cwd);
    const stored = this.sessionConfigurations.get(sessionId);
    const hostModel = this.modelForHost(profile);
    const availableModels = this.modelCatalog.availableModels(hostModel ?? profile.model);
    const selectedModel = this.modelCatalog.findModelInfo(hostModel ?? profile.model, availableModels);
    const effectiveModel = selectedModel?.value ?? profile.model;
    const inheritedModel = this.modelCatalog.findModelInfo(profile.inheritedModel, availableModels)?.value ?? profile.inheritedModel;
    return {
      sessionId,
      ...(effectiveModel ? { model: effectiveModel } : {}),
      ...(profile.effort ? { effort: profile.effort } : {}),
      ...(inheritedModel ? { inheritedModel } : {}),
      ...(profile.inheritedEffort ? { inheritedEffort: profile.inheritedEffort } : {}),
      ...(stored?.model ? { overrideModel: stored.model } : {}),
      ...(stored?.effort ? { overrideEffort: stored.effort } : {}),
      modelSource: profile.modelSource,
      effortSource: profile.effortSource,
      availableModels,
      availableEffortLevels: selectedModel?.supportedEffortLevels?.length
        ? [...selectedModel.supportedEffortLevels]
        : [...EFFORT_LEVELS],
      modelsComplete,
      appliesAfterTurn: Boolean(state?.configurationPending),
      permissionPolicy: this.permissionPolicy(sessionId),
      ...(context ? { context } : {}),
    };
  }

  permissionPolicy(sessionId: string): BridgePermissionPolicy {
    const sessionMode = this.sessionConfigurations.get(sessionId)?.permissionMode;
    return {
      hostMode: this.defaultPermissionMode,
      ...(sessionMode ? { sessionMode } : {}),
      effectiveMode: sessionMode ?? this.defaultPermissionMode,
      source: sessionMode ? "session" : "host",
    };
  }

  setDefaultPermissionMode(mode: BridgePermissionMode): number {
    if (mode !== "standard" && mode !== "full-access") throw new Error("Invalid permission mode");
    this.defaultPermissionMode = mode;
    const resolved = this.permissionBroker.applyPolicy();
    this.reconcileDesktopRegistrations();
    this.emit("changed");
    return resolved;
  }

  async configurePermissionPolicy(
    sessionId: string,
    mode: BridgePermissionMode | null,
  ): Promise<{ configuration: BridgeSessionConfiguration; resolvedPending: number }> {
    await this.initialize();
    if (!this.session(sessionId)) throw new Error("Session not found");
    if (mode !== null && mode !== "standard" && mode !== "full-access") {
      throw new Error("Invalid permission mode");
    }
    const previous = this.sessionConfigurations.get(sessionId);
    const proposed: StoredSessionConfiguration = {
      sessionId,
      ...(previous?.model ? { model: previous.model } : {}),
      ...(previous?.effort ? { effort: previous.effort } : {}),
      ...(previous?.desktopBaseline ? { desktopBaseline: previous.desktopBaseline } : {}),
      ...(mode ? { permissionMode: mode } : {}),
      updatedAt: Date.now(),
    };
    if (proposed.model || proposed.effort || proposed.permissionMode) {
      this.sessionConfigurations.set(sessionId, proposed);
    } else {
      this.sessionConfigurations.delete(sessionId);
    }
    await this.saveSessions();
    const resolvedPending = this.permissionBroker.applyPolicy(sessionId);
    if (this.bridgeSessions.has(sessionId)) await this.reconcileDesktopRegistration(sessionId, true);
    this.emit("changed");
    return {
      configuration: await this.configuration(sessionId, false),
      resolvedPending,
    };
  }

  /**
   * Drop every Bridge-side record for a session deleted from the workspace.
   * Callers must refuse busy sessions; native Claude transcripts stay
   * untouched, and the controller's tombstone keeps re-discovered copies of
   * the native session hidden from Bridge.
   */
  async removeSessionRecords(sessionId: string): Promise<void> {
    this.bridgeSessions.delete(sessionId);
    this.sessionConfigurations.delete(sessionId);
    for (let index = this.pending.length - 1; index >= 0; index -= 1) {
      if (this.pending[index]!.sessionId === sessionId) this.pending.splice(index, 1);
    }
    for (const [key, receipt] of [...this.terminalTurns]) {
      if (receipt.sessionId === sessionId) this.terminalTurns.delete(key);
    }
    this.permissionBroker.cancelSession(sessionId);
    const state = this.runtimeStates.get(sessionId);
    if (state) {
      if (state.releaseTimer) clearTimeout(state.releaseTimer);
      this.runtimeStates.delete(sessionId);
      await state.host?.close().catch(() => undefined);
    }
    await this.saveSessions();
    await this.saveQueue();
    this.emit("changed");
  }

  async configureSession(input: ConfigureSessionInput): Promise<BridgeSessionConfiguration> {
    const desktop = await this.refreshDesktopConfiguration(input.sessionId);
    const session = this.session(input.sessionId);
    if (!session) throw new Error("Session not found");
    const route = this.options.conversationState?.route(input.sessionId);
    if (route && !route.allowedActions.canConfigure) {
      throw new Error(route.allowedActions.reason ?? "当前通道不能修改执行配置");
    }
    const changesModel = Object.prototype.hasOwnProperty.call(input, "model");
    const changesEffort = Object.prototype.hasOwnProperty.call(input, "effort");
    if (!changesModel && !changesEffort) throw new Error("No configuration changes were provided");
    if (typeof input.model === "string") {
      if (
        input.model.length > 160 ||
        !input.model.trim() ||
        /[\u0000-\u001f\u007f]/u.test(input.model)
      ) throw new Error("Invalid model");
    }
    if (input.effort !== undefined && input.effort !== null && !EFFORT_LEVELS.includes(input.effort)) {
      throw new Error("Invalid effort");
    }

    const previous = this.sessionConfigurations.get(input.sessionId);
    const proposed: StoredSessionConfiguration = {
      sessionId: input.sessionId,
      ...(previous?.model ? { model: previous.model } : {}),
      ...(previous?.effort ? { effort: previous.effort } : {}),
      ...(previous?.permissionMode ? { permissionMode: previous.permissionMode } : {}),
      ...(desktop ? { desktopBaseline: {
        ...(desktop.model ? { model: desktop.model } : {}),
        ...(desktop.effort ? { effort: desktop.effort } : {}),
      } } : {}),
      updatedAt: Date.now(),
    };
    if (changesModel) {
      if (typeof input.model === "string") proposed.model = input.model.trim();
      else delete proposed.model;
    }
    if (changesEffort) {
      if (input.effort) proposed.effort = input.effort;
      else delete proposed.effort;
    }
    const profile = this.effectiveProfile(input.sessionId, session.cwd, proposed);
    const modelInfo = this.modelCatalog.findModelInfo(profile.model, this.modelCatalog.availableModels(profile.model));
    if (
      profile.effort &&
      modelInfo?.supportedEffortLevels?.length &&
      !modelInfo.supportedEffortLevels.includes(profile.effort)
    ) {
      throw new Error(`${modelInfo.displayName} 不支持 ${profile.effort} effort`);
    }
    if (profile.effort && modelInfo?.supportsEffort === false) {
      throw new Error(`${modelInfo.displayName} 不支持 effort 调节`);
    }
    if (changesModel && profile.model) await this.assertContextFits(session, profile.model, profile.ultracode);

    const state = this.runtimeStates.get(input.sessionId);
    if (state?.host && !state.active) {
      await this.applyHostConfiguration(state.host, profile);
      delete state.configurationPending;
    } else if (state?.active) {
      state.configurationPending = true;
    }

    if (proposed.model || proposed.effort || proposed.permissionMode) this.sessionConfigurations.set(input.sessionId, proposed);
    else this.sessionConfigurations.delete(input.sessionId);
    await this.saveSessions();
    if (this.bridgeSessions.has(input.sessionId)) {
      void this.reconcileDesktopRegistration(input.sessionId, true);
    }
    const hostModel = this.modelForHost(profile);
    const modelDisplayName = this.modelCatalog.gatewayModelsDiscovered || Boolean(parseMagpieSyntheticModelId(hostModel))
      ? this.modelCatalog.resolveModelDisplayName(hostModel)
      : undefined;
    await this.record({
      sessionId: input.sessionId,
      origin: "system",
      type: "session.configuration",
      data: {
        ...(profile.model ? { model: profile.model } : {}),
        ...(modelDisplayName ? { modelDisplayName } : {}),
        ...(profile.effort ? { effort: profile.effort } : {}),
        appliesAfterTurn: Boolean(state?.active),
      },
    });
    this.emit("changed");
    return this.configuration(input.sessionId, false);
  }

  async createSession(cwd: string, title?: string): Promise<BridgeSessionInfo> {
    if (!isAbsolute(cwd)) throw new Error("Project path must be absolute");
    const normalizedCwd = normalize(cwd);
    const knownProject = this.catalog.sessions.some((session) => normalize(session.cwd) === normalizedCwd)
      || [...this.bridgeSessions.values()].some((session) => normalize(session.cwd) === normalizedCwd);
    if (!knownProject) {
      throw new Error("Project path must be selected from a discovered Claude project");
    }
    const session: StoredBridgeSession = {
      sessionId: randomUUID(),
      cwd: normalizedCwd,
      title: compact(title?.trim() || basename(normalizedCwd) || normalizedCwd, 140),
      createdAt: Date.now(),
    };
    this.bridgeSessions.set(session.sessionId, session);
    this.runtimeStates.set(session.sessionId, {
      ownership: "BRIDGE_IDLE",
      turnState: "idle",
    });
    this.options.conversationState?.ensureConversation({
      conversationId: session.sessionId,
      cwd: session.cwd,
      title: session.title,
      source: "bridge",
      providerProfileId: CLAUDE_3P_PROFILE_ID,
      providerKind: "claude-3p",
      nativeSessionId: session.sessionId,
      access: "read-write",
      createdAt: session.createdAt,
    });
    await this.saveSessions();
    await this.record({
      sessionId: session.sessionId,
      origin: "system",
      type: "session.created",
      data: { cwd: session.cwd, title: session.title },
    });
    await this.reconcileDesktopRegistration(session.sessionId, true);
    this.emit("changed");
    return this.session(session.sessionId)!;
  }

  async forkSession(sourceSessionId: string, title?: string): Promise<BridgeSessionInfo> {
    await this.initialize();
    const source = this.session(sourceSessionId);
    if (!source) throw new Error("Session not found");
    const route = this.options.conversationState?.route(sourceSessionId);
    const activeLane = route?.lanes.find((lane) => lane.laneId === route.activeLaneId) ?? route?.lanes[0];
    const nativeSessionId = activeLane?.nativeSessionId ?? sourceSessionId;
    const sourceTranscript = await findClaudeTranscriptFile(
      this.options.paths.projects,
      nativeSessionId,
      source.cwd,
    );
    if (!sourceTranscript) {
      throw new Error("当前会话还没有可分支的对话记录，请先发送至少一条消息");
    }
    const parentSessionId = source.sessionId;
    const existingForkLabels = new Set(
      this.listSessions()
        .filter((candidate) => candidate.parentSessionId === parentSessionId)
        .map((candidate) => candidate.forkLabel)
        .filter((label): label is string => Boolean(label)),
    );
    let forkIndex = existingForkLabels.size + 1;
    let forkLabel = forkIndex === 1 && !existingForkLabels.has("fork") ? "fork" : `fork-${forkIndex}`;
    while (existingForkLabels.has(forkLabel)) {
      forkIndex += 1;
      forkLabel = `fork-${forkIndex}`;
    }
    const baseTitle = source.title.replace(/\s*\(fork(?:-\d+)?\)\s*$/iu, "").trim() || source.projectName;
    const forkTitle = compact(title?.trim() || `${baseTitle} (fork)`, 140);
    const createdAt = Date.now();
    const newSessionId = randomUUID();
    const targetTranscript = join(dirname(sourceTranscript), `${newSessionId}.jsonl`);
    const customTitleRecord = JSON.stringify({
      type: "custom-title",
      customTitle: forkTitle,
      sessionId: newSessionId,
      uuid: randomUUID(),
      timestamp: new Date(createdAt).toISOString(),
    });
    await copyFile(sourceTranscript, targetTranscript);
    // A copied in-flight turn has no writer that can finish it in the new session.
    const forkSnapshot = await parseClaudeTranscriptSnapshot(targetTranscript, { limit: 1 });
    if (!forkSnapshot.available) throw new Error("无法读取分支对话记录");
    const interruptedRecord = forkSnapshot.atTurnBoundary === false && forkSnapshot.terminalUuid
      ? `${JSON.stringify({
          type: "user",
          uuid: randomUUID(),
          parentUuid: forkSnapshot.terminalUuid,
          sessionId: newSessionId,
          cwd: source.cwd,
          timestamp: new Date(createdAt).toISOString(),
          message: { role: "user", content: CLAUDE_INTERRUPTED_USER_MESSAGE },
        })}\n`
      : "";
    const target = await open(targetTranscript, "a+");
    try {
      await target.chmod(0o600);
      const { size } = await target.stat();
      const lastByte = Buffer.alloc(1);
      if (size > 0) await target.read(lastByte, 0, 1, size - 1);
      await target.appendFile(`${size > 0 && lastByte[0] !== 0x0a ? "\n" : ""}${interruptedRecord}${customTitleRecord}\n`, "utf8");
    } finally {
      await target.close();
    }

    const parentDesktopSessionId = source.desktopSessionId ?? `local_${parentSessionId}`;
    const session: StoredBridgeSession = {
      sessionId: newSessionId,
      cwd: normalize(source.cwd),
      title: forkTitle,
      createdAt,
      parentSessionId,
      parentDesktopSessionId,
      forkLabel,
    };
    this.bridgeSessions.set(session.sessionId, session);
    const sourceProfile = this.effectiveProfile(sourceSessionId, source.cwd);
    if (sourceProfile.model || sourceProfile.effort) {
      this.sessionConfigurations.set(session.sessionId, {
        sessionId: session.sessionId,
        ...(sourceProfile.model ? { model: sourceProfile.model } : {}),
        ...(sourceProfile.effort ? { effort: sourceProfile.effort } : {}),
        updatedAt: createdAt,
      });
    }
    this.runtimeStates.set(session.sessionId, {
      ownership: "BRIDGE_IDLE",
      turnState: "idle",
    });
    this.options.conversationState?.ensureConversation({
      conversationId: session.sessionId,
      cwd: session.cwd,
      title: session.title,
      source: "bridge",
      providerProfileId: CLAUDE_3P_PROFILE_ID,
      providerKind: "claude-3p",
      nativeSessionId: session.sessionId,
      access: "read-write",
      createdAt: session.createdAt,
    });
    await this.saveSessions();
    await this.record({
      sessionId: session.sessionId,
      origin: "system",
      type: "session.created",
      data: {
        cwd: session.cwd,
        title: session.title,
        parentSessionId: session.parentSessionId,
        forkLabel: session.forkLabel,
      },
    });
    await this.reconcileDesktopRegistration(session.sessionId, true);
    this.emit("changed");
    return this.session(session.sessionId)!;
  }

  async registerDesktopSession(sessionId: string): Promise<BridgeSessionInfo> {
    await this.initialize();
    if (!this.bridgeSessions.has(sessionId)) {
      throw new Error("Only Bridge-created sessions can be registered in Claude Desktop");
    }
    await this.reconcileDesktopRegistration(sessionId, true);
    return this.session(sessionId)!;
  }

  async startTurn(input: StartTurnInput): Promise<QueuedTurn | TurnReceipt> {
    await this.initialize();
    const text = input.text.trim();
    const attachments = input.attachments ?? [];
    if (!text && attachments.length === 0) throw new Error("Message cannot be empty");
    const session = this.session(input.sessionId);
    if (!session) throw new Error("Session not found");
    const route = this.options.conversationState
      ? this.conversationRoute(input.sessionId)
      : undefined;
    if (route && !route.allowedActions.canSend) {
      throw new Error(
        route.allowedActions.reason
        ?? "当前提供方通道不能接收消息，请升级 Bridge 并切换到可执行通道。",
      );
    }
    const existing = this.pending.find((turn) => turn.idempotencyKey === input.idempotencyKey);
    if (existing) return existing;
    if (this.completedKeys.has(input.idempotencyKey)) {
      return this.terminalTurns.get(input.idempotencyKey) ?? {
        commandId: `completed:${input.idempotencyKey}`,
        requestId: input.requestId,
        idempotencyKey: input.idempotencyKey,
        sessionId: input.sessionId,
        state: "completed",
      };
    }
    const queued: QueuedTurn = {
      commandId: randomUUID(),
      requestId: input.requestId,
      idempotencyKey: input.idempotencyKey,
      sessionId: input.sessionId,
      laneId: route?.activeLaneId ?? legacyClaudeLaneId(input.sessionId),
      text,
      attachments,
      origin: input.origin,
      ...(input.sourceDeviceId ? { sourceDeviceId: input.sourceDeviceId } : {}),
      requestedAt: Date.now(),
      priority: input.priority ?? 0,
      attempts: 0,
      state: "queued",
      mode: input.mode ?? "start",
      sessionCwd: session.cwd,
      sessionTitle: session.title,
      ...(session.desktopSessionId ? { desktopSessionId: session.desktopSessionId } : {}),
    };
    this.pending.push(queued);
    this.sortPending();
    await this.saveQueue();
    await this.record({
      sessionId: queued.sessionId,
      itemId: queued.commandId,
      origin: queued.origin,
      type: "turn.queued",
      data: {
        commandId: queued.commandId,
        requestId: queued.requestId,
        delivery: "host-received",
        text: queued.text,
      },
    });
    this.emit("changed");
    void this.pump();
    return queued;
  }

  async startHandoffTurn(input: {
    handoffId: string;
    sessionId: string;
    laneId: string;
    text: string;
  }): Promise<QueuedTurn | TurnReceipt> {
    await this.initialize();
    if (this.hasActiveOrPending(input.sessionId)) {
      throw new Error("当前对话仍有运行中或待发送任务，请先完成或停止");
    }
    const session = this.session(input.sessionId);
    if (!session) throw new Error("Session not found");
    const lane = this.options.conversationState?.lane(input.laneId);
    if (!lane || lane.conversationId !== input.sessionId || lane.access !== "read-write") {
      throw new Error("Handoff target lane is invalid");
    }
    const idempotencyKey = `handoff:${input.handoffId}`;
    const existing = this.pending.find((turn) => turn.idempotencyKey === idempotencyKey);
    if (existing) return existing;
    if (this.completedKeys.has(idempotencyKey)) {
      return this.terminalTurns.get(idempotencyKey) ?? {
        commandId: `completed:${idempotencyKey}`,
        requestId: input.handoffId,
        idempotencyKey,
        sessionId: input.sessionId,
        state: "completed",
      };
    }
    const queued: QueuedTurn = {
      commandId: randomUUID(),
      requestId: input.handoffId,
      idempotencyKey,
      sessionId: input.sessionId,
      laneId: input.laneId,
      text: input.text.trim(),
      attachments: [],
      origin: "system",
      requestedAt: Date.now(),
      priority: 200,
      attempts: 0,
      state: "queued",
      mode: "handoff",
      sessionCwd: session.cwd,
      sessionTitle: session.title,
    };
    this.pending.push(queued);
    this.sortPending();
    await this.saveQueue();
    await this.record({
      sessionId: queued.sessionId,
      itemId: queued.commandId,
      origin: "system",
      type: "turn.queued",
      data: {
        commandId: queued.commandId,
        requestId: queued.requestId,
        delivery: "host-received",
        handoffId: input.handoffId,
      },
    });
    this.emit("changed");
    void this.pump();
    return queued;
  }

  async steerTurn(input: StartTurnInput): Promise<QueuedTurn | TurnReceipt> {
    const turn = await this.startTurn({ ...input, priority: 100, mode: "steer" });
    return turn.state === "queued" ? this.steerQueuedTurn(input.sessionId, turn.commandId) : turn;
  }

  async steerQueuedTurn(sessionId: string, commandId: string): Promise<TurnReceipt> {
    await this.initialize();
    const turn = this.pending.find((candidate) => candidate.sessionId === sessionId && candidate.commandId === commandId);
    if (!turn) {
      const receipt = [...this.terminalTurns.values()].find((candidate) => candidate.sessionId === sessionId && candidate.commandId === commandId);
      if (receipt) return receipt;
      throw new Error("未找到这条排队消息，请同步状态后重试");
    }
    if (turn.state === "uncertain" || turn.recoveryBlocked) throw new Error("这条消息的投递状态尚未确认，请先同步状态");
    if (turn.state !== "queued") return turn;
    if (this.dispatching.has(sessionId)) throw new Error("消息正在启动，请同步状态后重试");
    if (this.options.conversationState && !this.conversationRoute(sessionId).allowedActions.canSteer) {
      throw new Error("当前会话不支持立即调整");
    }
    const state = this.runtimeStates.get(sessionId);
    const active = state?.active;
    const host = state?.host;
    if ((active && !host) || (!active && this.options.observer.isMainTurnBusy(sessionId))) {
      throw new Error("当前任务不由 Bridge 托管，暂时无法立即调整");
    }
    if (host && state?.hostLaneId && state.hostLaneId !== turn.laneId) throw new Error("这条消息使用其他提供方通道，不能直接调整当前任务");
    turn.mode = "steer";
    turn.priority = 100;
    this.sortPending();
    if (active && host) {
      // Reserve this original command before persistence so repeated requests cannot submit it twice.
      turn.state = "running";
      turn.transport = "bridge-host";
      turn.turnId = randomUUID();
      turn.messageId = randomUUID();
      turn.submissionStartedAt = Date.now();
      try {
        await this.saveQueue();
        if (this.closed || !this.pending.includes(turn) || turn.state !== "running") return turn;
        if (this.runtimeStates.get(sessionId)?.host !== host) throw new Error("会话通道已变化，请同步状态后重试");
        host.send({ text: turn.text, attachments: turn.attachments, turnId: turn.turnId, messageId: turn.messageId, priority: "now" }, turn.origin);
      } catch (error) {
        if (this.pending.includes(turn)) {
          turn.state = "queued";
          delete turn.turnId;
          delete turn.messageId;
          delete turn.submissionStartedAt;
          if (state?.active === turn) {
            const next = this.pending.filter(candidate => candidate.sessionId === sessionId && candidate.state === "running")
              .sort((left, right) => (right.sessionAcceptedAt ?? 0) - (left.sessionAcceptedAt ?? 0))[0];
            if (next) state.active = next;
            else delete state.active;
            if (state.ownership !== "RELEASING") {
              state.ownership = next ? "BRIDGE_RUNNING" : "BRIDGE_IDLE";
              state.turnState = next ? next.sessionAcceptedAt ? "running" : "queued" : "idle";
              if (!next) this.activeTurns = Math.max(0, this.activeTurns - 1);
            }
          }
          await this.saveQueue();
        }
        this.emit("changed");
        throw error;
      }
    } else {
      await this.saveQueue();
    }
    this.emit("changed");
    void this.pump();
    return turn;
  }

  async stopSubagent(sessionId: string, agentId: string): Promise<void> {
    const state = this.runtimeStates.get(sessionId);
    if (state?.host && this.taskState.isRunning(sessionId, agentId)) {
      await state.host.stopTask(this.taskState.task(sessionId, agentId)!.taskId);
      return;
    } else {
      // Bridge has no channel into a process Claude Desktop owns, so the only
      // stop it can offer is ending that process, which needs an idle main turn.
      if (this.options.observer.isMainTurnBusy(sessionId)) {
        throw new Error("主对话还在运行，这个会话无法单独停止子代理。请先停止主对话。");
      }
      const session = this.session(sessionId);
      if (!session) throw new Error("Session not found");
      const processes = await scanClaudeSessionProcesses(this.options.paths, sessionId);
      const subagent = (await readClaudeSessionSubagents(
        this.options.paths.projects,
        sessionId,
        session.cwd,
        oldestLiveProcessStart(processes),
      )).find((candidate) => candidate.agentId === agentId);
      if (subagent?.state !== "running") throw new Error("这个子代理已经结束");
      const owner = processes
        .filter((candidate) => candidate.processAlive && candidate.startedAt <= subagent.startedAt)
        .sort((left, right) => right.startedAt - left.startedAt)[0];
      // A registration file can outlive its process and name a pid the system has since reused.
      if (owner?.pid === undefined || !await isClaudeSessionProcess(owner.pid)) {
        throw new Error("找不到运行这个子代理的 Claude 进程");
      }
      signalProcess(owner.pid);
    }
  }

  // Bridge has no channel into a process Claude Desktop owns, so stopping its main
  // turn ends that process. SIGINT makes the CLI abort the request and record the
  // interruption; SIGTERM would leave the transcript on an unfinished turn.
  private async interruptDesktopTurn(sessionId: string): Promise<boolean> {
    if (!this.options.observer.isMainTurnBusy(sessionId)) return false;
    const owner = (await this.sessionProcessScanner(this.options.paths, sessionId))
      .filter((candidate) => candidate.processAlive && candidate.entrypoint.startsWith("claude-desktop"))
      .sort((left, right) => right.startedAt - left.startedAt)[0];
    // A registration file can outlive its process and name a pid the system has since reused.
    if (owner?.pid === undefined || !await isClaudeSessionProcess(owner.pid)) return false;
    process.kill(owner.pid, "SIGINT");
    return true;
  }

  async interruptTurn(sessionId: string, commandId?: string, force = false): Promise<boolean> {
    const state = this.runtimeStates.get(sessionId);
    const active = state?.active;
    const activeMatches = Boolean(active && (!commandId || active.commandId === commandId));
    if (active && activeMatches && state.host) {
      this.permissionBroker.cancelSession(sessionId, "turn-interrupted");
      if (this.dispatching.has(sessionId) && !active.sessionAcceptedAt) {
        await this.forceCancelActive(sessionId, active);
        return true;
      }
      if (force) {
        await this.forceCancelActive(sessionId, active);
        return true;
      }
      await state.host.interrupt();
      return true;
    }
    if (force && active && activeMatches) {
      await this.forceCancelActive(sessionId, active);
      return true;
    }
    const index = this.pending.findIndex((turn) => (
      turn.sessionId === sessionId &&
      (turn.state === "queued" || (force && turn.state === "uncertain")) &&
      (!commandId || turn.commandId === commandId)
    ));
    if (index < 0) return commandId || state?.host ? false : this.interruptDesktopTurn(sessionId);
    const [cancelled] = this.pending.splice(index, 1);
    this.rememberTerminal(cancelled!, "cancelled");
    this.clearTakeoverRetry(sessionId);
    const remainingForSession = this.pending.some((turn) => (
      turn.sessionId === sessionId && (turn.state === "queued" || turn.state === "uncertain")
    ));
    if (state && !state.active) {
      state.ownership = "DESKTOP_OBSERVED";
      state.turnState = remainingForSession
        ? "queued"
        : this.options.observer.isMainTurnBusy(sessionId)
          ? "running"
          : "idle";
    }
    await this.saveQueue();
    await this.record({
      sessionId,
      ...(cancelled!.turnId ? { turnId: cancelled!.turnId } : {}),
      itemId: cancelled!.commandId,
      origin: "system",
      type: "turn.interrupted",
      data: {
        commandId: cancelled!.commandId,
        requestId: cancelled!.requestId,
        idempotencyKey: cancelled!.idempotencyKey,
        delivery: "cancelled",
        wasQueued: true,
      },
    });
    if (this.options.evidence && cancelled!.turnId) {
      void this.evidenceCall(() => this.options.evidence!.finalizeBridgeTurn({
        sessionId,
        turnId: cancelled!.turnId!,
        failed: true,
        error: "任务已停止",
      }));
    }
    this.emit("changed");
    await this.pump();
    return true;
  }

  private forceCancelActive(sessionId: string, turn: QueuedTurn): Promise<void> {
    const state = this.runtimeStates.get(sessionId);
    if (!state?.active || state.active.commandId !== turn.commandId) return Promise.resolve();
    const stopping = (async () => {
      this.permissionBroker.cancelSession(sessionId, "turn-interrupted");
      this.clearTakeoverRetry(sessionId);
      if (turn.turnId) {
        this.forceStoppedTurnIds.add(turn.turnId);
        while (this.forceStoppedTurnIds.size > 2_000) {
          const oldest = this.forceStoppedTurnIds.values().next().value;
          if (typeof oldest !== "string") break;
          this.forceStoppedTurnIds.delete(oldest);
        }
      }
      const host = state.host;
      delete state.active;
      if (state.releaseTimer) {
        clearTimeout(state.releaseTimer);
        delete state.releaseTimer;
      }
      const index = this.pending.findIndex((candidate) => candidate.commandId === turn.commandId);
      if (index >= 0) this.pending.splice(index, 1);
      this.rememberTerminal(turn, "cancelled");
      state.ownership = "RELEASING";
      await host?.close();
      delete state.host;
      delete state.hostLaneId;
      this.activeTurns = Math.max(0, this.activeTurns - 1);
      state.turnState = this.options.observer.isMainTurnBusy(sessionId) ? "running" : "idle";
      await this.saveQueue();
      await this.options.eventLog.flushDeltas(sessionId);
      await this.record({
        sessionId,
        ...(turn.turnId ? { turnId: turn.turnId } : {}),
        itemId: turn.commandId,
        origin: "system",
        type: "turn.interrupted",
        data: {
          commandId: turn.commandId,
          requestId: turn.requestId,
          idempotencyKey: turn.idempotencyKey,
          delivery: "cancelled",
          forced: true,
        },
      });
      if (this.options.evidence) {
        await this.evidenceCall(() => this.options.evidence!.finalizeBridgeTurn({
          sessionId,
          ...(turn.turnId ? { turnId: turn.turnId } : {}),
          failed: true,
          error: "任务已强制停止",
        }));
      }
      state.ownership = this.catalog.sessions.some((session) => session.sessionId === sessionId)
        ? "DESKTOP_OBSERVED" : "BRIDGE_IDLE";
      this.emit("changed");
      await this.pump();
    })().finally(() => this.forcedStops.delete(stopping));
    this.forcedStops.add(stopping);
    return stopping;
  }

  async confirmFallback(sessionId: string): Promise<BridgeSessionInfo> {
    await this.initialize();
    const session = this.session(sessionId);
    if (!session) throw new Error("Session not found");
    if (!await this.options.observer.canStartBridgeHost(sessionId)) {
      throw new Error("Claude Desktop 仍在执行当前会话，结束后 Bridge 会自动接管");
    }
    const stored = this.bridgeSessions.get(sessionId) ?? {
      sessionId,
      cwd: session.cwd,
      title: session.title,
      createdAt: session.lastActivityAt || Date.now(),
    };
    stored.fallbackConfirmedAt = Date.now();
    if (session.desktopSessionId) stored.desktopSessionId = session.desktopSessionId;
    this.bridgeSessions.set(sessionId, stored);
    const state = this.runtimeStates.get(sessionId) ?? {
      ownership: "BRIDGE_IDLE" as const,
      turnState: "queued" as const,
    };
    state.ownership = "BRIDGE_IDLE";
    this.runtimeStates.set(sessionId, state);
    await this.saveSessions();
    await this.record({
      sessionId,
      origin: "desktop",
      type: "session.transport",
      data: {
        transport: "bridge-host",
        confirmedFallback: true,
        detail: "Bridge 使用相同 sessionId 和 transcript 接管",
      },
    });
    this.emit("changed");
    setTimeout(() => void this.pump(), 500);
    return this.session(sessionId)!;
  }

  async resolveUncertainDelivery(commandId: string, action: "confirm" | "retry"): Promise<TurnReceipt> {
    const turn = this.pending.find((candidate) => candidate.commandId === commandId);
    if (!turn || turn.state !== "uncertain") throw new Error("Uncertain delivery was not found");
    if (turn.mode === "handoff") {
      throw new Error("接力首条消息结果不确定时禁止确认或重发；请取消后重新预览接力");
    }
    const state = this.runtimeStates.get(turn.sessionId);
    if (action === "confirm") {
      this.pending.splice(this.pending.indexOf(turn), 1);
      this.rememberTerminal(turn, "cancelled");
      if (state) { state.turnState = "idle"; state.ownership = "DESKTOP_OBSERVED"; }
      // Manual receipt confirmation prevents replay; it is not a completion result.
      await this.record({
        sessionId: turn.sessionId,
        ...(turn.turnId ? { turnId: turn.turnId } : {}),
        itemId: turn.commandId,
        origin: "desktop",
        type: "message.delivery",
        data: {
          commandId: turn.commandId,
          requestId: turn.requestId,
          idempotencyKey: turn.idempotencyKey,
          delivery: "session-received",
          manuallyConfirmed: true,
        },
      });
    } else {
      if (this.options.observer.isMainTurnBusy(turn.sessionId)) throw new Error("原会话仍在执行，请先确认原任务状态");
      turn.state = "queued";
      turn.transport = "bridge-host";
      turn.attempts = 0;
      delete turn.turnId;
      delete turn.sessionAcceptedAt;
      delete turn.uncertainResolved;
      delete turn.messageId;
      delete turn.submissionStartedAt;
      if (state) { state.turnState = "queued"; state.ownership = "BRIDGE_IDLE"; }
      await this.record({
        sessionId: turn.sessionId,
        itemId: turn.commandId,
        origin: "desktop",
        type: "message.delivery",
        data: {
          commandId: turn.commandId,
          requestId: turn.requestId,
          delivery: "host-received",
          manualRetry: true,
        },
      });
      void this.pump();
    }
    await this.saveQueue();
    this.emit("changed");
    return action === "confirm" ? this.terminalTurns.get(turn.idempotencyKey)! : turn;
  }

  resolvePermission(
    requestId: string,
    decision: PermissionDecision,
    message?: string,
    updatedInput?: Record<string, unknown>,
    resolver?: {
      deviceId: string;
      name: string;
    },
  ): boolean {
    return this.permissionBroker.resolveRequest(requestId, decision, message, updatedInput, resolver);
  }

  resolveNativePermissionSessionId(nativeSessionId: string): string | undefined {
    const associatedLane = this.options.conversationState?.findLanesByNativeSessionId(nativeSessionId)[0];
    const sessionId = associatedLane?.conversationId ?? nativeSessionId;
    if (!this.session(sessionId)) return undefined;
    if (this.runtimeStates.get(sessionId)?.active?.transport === "bridge-host") return undefined;
    return sessionId;
  }

  async history(sessionId: string, cursor?: string, limit = 50): Promise<BridgeHistoryPage> {
    const session = this.session(sessionId);
    if (!session) throw new Error("Session not found");
    return readSessionHistory({
      paths: this.options.paths, eventLog: this.options.eventLog, taskState: this.taskState,
      session, route: this.options.conversationState?.route(sessionId),
      activeTurn: Boolean(this.runtimeStates.get(sessionId)?.active), observedSessions: this.catalog.sessions,
    }, cursor, limit);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.clearRuntimeRetry();
    for (const timer of this.takeoverRetryTimers.values()) clearTimeout(timer);
    this.takeoverRetryTimers.clear();
    await this.pumpQueue;
    await Promise.allSettled(this.dispatching.values());
    await Promise.allSettled(this.conflictTasks.values());
    await Promise.allSettled(this.forcedStops);
    for (const state of this.runtimeStates.values()) {
      if (state.releaseTimer) clearTimeout(state.releaseTimer);
      await state.host?.close();
    }
    await this.eventQueue.catch(() => undefined);
    await this.desktopRegistration.close();
    await this.pumpQueue.catch(() => undefined);
    await this.saveQueue();
    await this.writeQueue.catch(() => undefined);
  }

  private async acquire(turn: QueuedTurn): Promise<void> {
    const session = this.session(turn.sessionId);
    if (!session || !this.runtime?.executablePath) return;
    const lane = this.options.conversationState?.lane(turn.laneId);
    const providerKind = lane?.providerKind ?? "claude-3p";
    if (providerKind === "claude-official") {
      await this.failQueuedTurn(turn, "Claude 官方通道为只读，请升级 Bridge 并在 Claude 官方继续");
      return;
    }
    if (providerKind === "claude-3p" && !this.runtime.credentialPath) return;
    const observed = this.catalog.sessions.find((candidate) => candidate.sessionId === turn.sessionId);
    const state = this.runtimeStates.get(turn.sessionId) ?? {
      ownership: "DESKTOP_OBSERVED" as const,
      turnState: "idle" as const,
    };
    this.runtimeStates.set(turn.sessionId, state);
    if (providerKind === "claude-3p" && this.hasConfirmedOwnershipConflict(turn.sessionId, state)) {
      await this.containOwnershipConflict(turn.sessionId, observed?.activeProcesses ?? []);
      return;
    }
    const externalWriteVersion = this.options.observer.externalWriteVersion(turn.sessionId);
    if (
      providerKind === "claude-3p" &&
      !await this.options.observer.canStartBridgeHost(
        turn.sessionId,
        Boolean(state.host && state.hostLaneId === turn.laneId),
      )
    ) {
      state.ownership = "DESKTOP_OBSERVED";
      state.turnState = "queued";
      await this.recordOwnership(turn.sessionId, state.ownership);
      this.scheduleTakeoverRetry(turn.sessionId);
      return;
    }
    if (!this.canDispatch(turn)) return;
    this.clearTakeoverRetry(turn.sessionId);
    if (!state.host && providerKind === "claude-3p") state.externalWriteVersion = externalWriteVersion;
    if (state.releaseTimer) {
      clearTimeout(state.releaseTimer);
      delete state.releaseTimer;
    }
    const liveWriters = providerKind === "claude-3p"
      ? (await this.sessionProcessScanner(this.options.paths, turn.sessionId))
          .filter((candidate) => candidate.processAlive)
      : [];
    const desktopWriter = liveWriters.some((candidate) => candidate.entrypoint.startsWith("claude-desktop"));
    const foreignBridgeWriter = (
      !state.host &&
      liveWriters.some((candidate) => candidate.entrypoint === "claude-bridge")
    );
    if (foreignBridgeWriter) {
      await this.containOwnershipConflict(turn.sessionId, liveWriters);
      return;
    }
    if (desktopWriter && !observed?.desktopProcessAlive) {
      state.ownership = "DESKTOP_OBSERVED";
      state.turnState = "queued";
      await this.recordOwnership(turn.sessionId, state.ownership);
      this.scheduleTakeoverRetry(turn.sessionId);
      this.emit("changed");
      return;
    }
    try {
      if (providerKind === "claude-3p") {
        await this.assertBridgeHostCompatible(session);
      }
    } catch (error) {
      const incompatibleHost = state.host;
      delete state.host;
      delete state.hostLaneId;
      await incompatibleHost?.close().catch(() => undefined);
      state.ownership = observed ? "DESKTOP_OBSERVED" : "BRIDGE_IDLE";
      state.turnState = "idle";
      await this.failQueuedTurn(turn, error instanceof Error ? error.message : String(error));
      await this.recordOwnership(turn.sessionId, state.ownership);
      return;
    }
    let accepted: ReturnType<SessionHostRuntime["send"]>;
    let evidenceId: string | undefined;
    try {
      if (providerKind === "claude-3p") await this.refreshDesktopConfiguration(turn.sessionId);
      if (!this.canDispatch(turn)) return;
      const host = await this.ensureHost(turn.sessionId, turn.laneId);
      const effective = this.effectiveProfile(turn.sessionId, session.cwd);
      await this.applyHostConfiguration(host, {
        ...effective,
        ...(lane?.model ? { model: lane.model, ultracode: false } : {}),
      });
      delete state.configurationPending;
      if (this.options.evidence) {
        evidenceId = await this.evidenceCall(() => this.options.evidence!.startBridgeTurn({
          sessionId: turn.sessionId,
          cwd: session.cwd,
          commandId: turn.commandId,
          laneId: turn.laneId,
          ...(lane ? { providerProfileId: lane.providerProfileId } : {}),
          startedAt: Date.now(),
        }));
      }
      if (!this.canDispatch(turn)) {
        this.scheduleRelease(turn.sessionId);
        return;
      }
      turn.state = "running";
      turn.transport = "bridge-host";
      turn.turnId = randomUUID();
      turn.messageId = randomUUID();
      turn.submissionStartedAt = Date.now();
      state.active = turn;
      state.ownership = "BRIDGE_RUNNING";
      state.turnState = "queued";
      this.activeTurns += 1;
      await this.saveQueue();
      if (this.closed || state.active !== turn || !this.pending.includes(turn)) return;
      accepted = host.send({
        text: turn.text,
        attachments: turn.attachments,
        turnId: turn.turnId,
        messageId: turn.messageId,
      }, turn.origin);
    } catch (error) {
      if (evidenceId) {
        void this.evidenceCall(() => this.options.evidence!.finalizeBridgeTurn({
          sessionId: turn.sessionId,
          failed: true,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
      await state.host?.close().catch(() => undefined);
      delete state.host;
      delete state.hostLaneId;
      state.ownership = "DESKTOP_OBSERVED";
      state.turnState = "queued";
      if (state.active === turn) { delete state.active; this.activeTurns -= 1; }
      delete turn.submissionStartedAt;
      delete turn.turnId;
      delete turn.messageId;
      turn.state = "queued";
      turn.attempts += 1;
      await this.saveQueue();
      await this.record({
        sessionId: turn.sessionId,
        itemId: turn.commandId,
        origin: "system",
        type: "runtime.error",
        data: {
          error: error instanceof Error ? error.message : String(error),
          retrying: turn.attempts < 5,
        },
      });
      if (turn.mode === "handoff") {
        await this.failQueuedTurn(turn, error instanceof Error ? error.message : String(error));
      } else if (turn.attempts < 5) setTimeout(() => void this.pump(), 3_000);
      else await this.failQueuedTurn(turn, error instanceof Error ? error.message : String(error));
      return;
    }
    turn.attempts += 1;
    turn.turnId = accepted.turnId;
    turn.messageId = accepted.messageId;
    if (evidenceId) {
      turn.evidenceId = evidenceId;
      await this.evidenceCall(() => this.options.evidence!.attachTurn(evidenceId, accepted.turnId));
    }
    await this.saveQueue();
    this.emit("changed");
  }

  private async ensureHost(sessionId: string, laneId: string): Promise<SessionHostRuntime> {
    const state = this.runtimeStates.get(sessionId);
    const existing = state?.host;
    if (existing && state.hostLaneId === laneId) return existing;
    if (existing) {
      await existing.close().catch(() => undefined);
      delete state.host;
      delete state.hostLaneId;
    }
    const starting = this.hostStarts.get(laneId);
    if (starting) return starting;
    const promise = this.createHost(sessionId, laneId);
    this.hostStarts.set(laneId, promise);
    try {
      return await promise;
    } finally {
      this.hostStarts.delete(laneId);
    }
  }

  private async createHost(sessionId: string, laneId: string): Promise<SessionHostRuntime> {
    const session = this.session(sessionId);
    if (!session) throw new Error("Session not found");
    if (!this.runtime?.executablePath) {
      throw new Error("Claude Host runtime is unavailable");
    }
    const lane = this.options.conversationState?.lane(laneId);
    if (this.options.conversationState && (!lane || lane.conversationId !== sessionId)) {
      throw new Error("Conversation lane is invalid");
    }
    const providerKind = lane?.providerKind ?? "claude-3p";
    if (providerKind === "claude-3p" && !this.runtime.credentialPath) {
      throw new Error("Claude-3p Host Credentials are unavailable");
    }
    const state = this.runtimeStates.get(sessionId) ?? {
      ownership: "DESKTOP_OBSERVED" as const,
      turnState: "idle" as const,
    };
    this.runtimeStates.set(sessionId, state);
    if (state.host && state.hostLaneId === laneId) return state.host;
    if (providerKind === "claude-3p") {
      state.externalWriteVersion ??= this.options.observer.externalWriteVersion(sessionId);
    }
    if (state.releaseTimer) {
      clearTimeout(state.releaseTimer);
      delete state.releaseTimer;
    }
    state.ownership = "ACQUIRING";
    await this.recordOwnership(sessionId, state.ownership);
    try {
      const plan = lane && this.options.runtimePool
        ? await this.options.runtimePool.hostPlan(sessionId, lane, this.runtime)
        : {
            logicalSessionId: sessionId,
            nativeSessionId: sessionId,
            executablePath: this.runtime.executablePath,
            environment: this.runtime.environment,
            providerKind: "claude-3p" as const,
          };
      const transcript = await findClaudeTranscriptFile(
        this.options.paths.projects,
        plan.nativeSessionId,
        session.cwd,
      );
      const profile = this.effectiveProfile(sessionId, session.cwd);
      const hostModel = lane?.model ?? this.modelForHost(profile);
      const host = this.hostFactory({
        sessionId: plan.nativeSessionId,
        eventSessionId: sessionId,
        cwd: session.cwd,
        executablePath: plan.executablePath,
        environment: plan.environment,
        permissionBroker: this.permissionBroker,
        resume: Boolean(transcript),
        ...(hostModel ? { model: hostModel } : {}),
        ...(profile.effort ? { effort: profile.effort } : {}),
      });
      let generation = randomUUID();
      this.taskState.restore(sessionId, this.options.eventLog.latestTaskEvents(sessionId));
      this.taskState.beginGeneration(sessionId, generation);
      this.options.observer.setSessionAlias?.(plan.nativeSessionId, sessionId);
      state.hostGeneration = generation;
      host.onEvent((event) => {
        // A Host can start another query. Capture its generation before queueing,
        // then advance broker authority in event order after the old query drains.
        if (event.type === "runtime.started") generation = randomUUID();
        const eventGeneration = generation;
        this.eventQueue = this.eventQueue
          .catch(() => undefined)
          .then(() => {
            if (event.type === "runtime.started") {
              if (state.host !== host) return;
              state.hostGeneration = eventGeneration;
            }
            return this.handleHostEvent(event, eventGeneration);
          });
      });
      state.host = host;
      state.hostLaneId = laneId;
      state.ownership = "BRIDGE_IDLE";
      state.turnState = "idle";
      await this.recordOwnership(sessionId, state.ownership);
      this.emit("changed");
      return host;
    } catch (error) {
      await state.host?.close().catch(() => undefined);
      delete state.host;
      delete state.hostLaneId;
      state.ownership = this.catalog.sessions.some((candidate) => candidate.sessionId === sessionId)
        ? "DESKTOP_OBSERVED"
        : "BRIDGE_IDLE";
      await this.recordOwnership(sessionId, state.ownership);
      this.emit("changed");
      throw error;
    }
  }

  private effectiveProfile(
    sessionId: string,
    cwd: string,
    configuration = this.sessionConfigurations.get(sessionId),
  ): EffectiveSessionProfile {
    const observed = this.catalog.sessions.find((candidate) => candidate.sessionId === sessionId);
    const bridge = this.bridgeSessions.get(sessionId);
    const projectModel = this.catalog.sessions.find((candidate) => (
      candidate.cwd === cwd && Boolean(candidate.hostModel)
    ));
    const projectEffort = this.catalog.sessions.find((candidate) => (
      candidate.cwd === cwd && Boolean(candidate.hostEffort)
    ));
    const sessionHostModel = observed?.hostModel ?? bridge?.hostModel;
    const sessionHostEffort = observed?.hostEffort ?? bridge?.hostEffort;
    const inheritedModel = sessionHostModel ?? projectModel?.hostModel;
    const inheritedEffort = sessionHostEffort ?? projectEffort?.hostEffort;
    const ultracode = !configuration?.model && observed?.hostUltracode === true;
    const inheritedModelSource: BridgeConfigurationSource = sessionHostModel
      ? "claude-desktop"
      : projectModel?.hostModel
        ? "project"
        : "default";
    const inheritedEffortSource: BridgeConfigurationSource = sessionHostEffort
      ? "claude-desktop"
      : projectEffort?.hostEffort
        ? "project"
        : "default";
    return {
      ...(configuration?.model ? { model: configuration.model } : inheritedModel ? { model: inheritedModel } : {}),
      ...(configuration?.effort ? { effort: configuration.effort } : inheritedEffort ? { effort: inheritedEffort } : {}),
      ...(ultracode ? { ultracode: true } : {}),
      ...(inheritedModel ? { inheritedModel } : {}),
      ...(inheritedEffort ? { inheritedEffort } : {}),
      modelSource: configuration?.model ? "bridge" : inheritedModelSource,
      effortSource: configuration?.effort ? "bridge" : inheritedEffortSource,
    };
  }

  private async applyHostConfiguration(
    host: SessionHostRuntime,
    profile: Pick<EffectiveSessionProfile, "model" | "effort" | "ultracode">,
  ): Promise<void> {
    await host.setAutoCompactWindow(this.modelCatalog.modelContextLimit(profile.model, profile.ultracode));
    await host.setModel(this.modelForHost(profile));
    await host.setEffort(profile.effort);
  }

  private modelForHost(
    profile: Pick<EffectiveSessionProfile, "model" | "ultracode">,
  ): string | undefined {
    if (!profile.model || !profile.ultracode || /\[1m\]/iu.test(profile.model)) return profile.model;
    return `${profile.model}[1m]`;
  }

  private async refreshGatewayModels(
    runtime = this.runtime,
  ): Promise<boolean> {
    const models = await this.gatewayModelDiscoverer(runtime).catch(() => []);
    if (!models.length) return false;
    this.modelCatalog.gatewayModelsDiscovered = true;
    this.modelCatalog.modelCatalogComplete = true;
    this.modelCatalog.rememberModels(models);
    return true;
  }

  private async discoverModelsWithoutAttaching(
    session: BridgeSessionInfo,
  ): ReturnType<SessionHostRuntime["supportedModels"]> {
    if (!this.runtime?.executablePath || !this.runtime.credentialPath) return [];
    const profile = this.effectiveProfile(session.sessionId, session.cwd);
    const host = this.hostFactory({
      sessionId: randomUUID(),
      cwd: dirname(this.options.sessionsPath),
      executablePath: this.runtime.executablePath,
      environment: this.runtime.environment,
      permissionBroker: this.permissionBroker,
      resume: false,
      ...(profile.model ? { model: profile.model } : {}),
      ...(profile.effort ? { effort: profile.effort } : {}),
      settingSources: [],
      persistSession: false,
    });
    let discoveryTimer: NodeJS.Timeout | undefined;
    try {
      host.start();
      return await Promise.race([
        host.supportedModels(),
        new Promise<never>((_resolve, reject) => {
          discoveryTimer = setTimeout(
            () => reject(new Error("Claude model discovery timed out")),
            MODEL_DISCOVERY_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      if (discoveryTimer) clearTimeout(discoveryTimer);
      await host.close().catch(() => undefined);
    }
  }

  private async estimatedContext(session: BridgeSessionInfo): Promise<BridgeSessionContextUsage | undefined> {
    const estimate = await readClaudeSessionContextEstimate(
      this.options.paths.projects,
      session.sessionId,
      session.cwd,
    );
    if (!estimate) return undefined;
    const profile = this.effectiveProfile(session.sessionId, session.cwd);
    const maxTokens = this.modelCatalog.modelContextLimit(profile.model, profile.ultracode);
    if (!maxTokens) return undefined;
    return {
      totalTokens: estimate.totalTokens,
      maxTokens,
      percentage: Math.min(100, (estimate.totalTokens / maxTokens) * 100),
      ...(estimate.model ? { model: estimate.model } : {}),
      estimated: true,
    };
  }

  private async assertContextFits(session: BridgeSessionInfo, model: string, ultracode = false): Promise<void> {
    const estimate = await readClaudeSessionContextEstimate(
      this.options.paths.projects,
      session.sessionId,
      session.cwd,
    );
    if (!estimate) return;
    const maxTokens = this.modelCatalog.modelContextLimit(model, ultracode);
    if (!maxTokens || estimate.totalTokens <= maxTokens) return;
    throw new Error(
      `当前会话约 ${estimate.totalTokens.toLocaleString("zh-CN")} tokens，所选模型仅提供约 `
      + `${maxTokens.toLocaleString("zh-CN")} tokens 上下文。请先压缩或新建会话，或选择 1M 模型。`,
    );
  }

  private sessionSourceProfile(sessionId: string): ClaudeDesktopProfile {
    const observed = this.catalog.sessions.find((candidate) => candidate.sessionId === sessionId);
    if (observed?.sourceProfile) return observed.sourceProfile;
    const registrationRoot = this.bridgeSessions.get(sessionId)?.desktopRegistration?.profileSessionsRoot;
    return registrationRoot ? claudeDesktopProfileForPath(registrationRoot) : "unknown";
  }

  private runtimeProfile(): ClaudeDesktopProfile {
    return this.runtime?.credentialPath
      ? claudeDesktopProfileForPath(this.runtime.credentialPath)
      : "unknown";
  }

  private profileLabel(profile: ClaudeDesktopProfile): string {
    return profile === "claude" ? "Claude 官方" : profile === "claude-3p" ? "Claude-3p" : "未知";
  }

  private async assertBridgeHostCompatible(session: BridgeSessionInfo): Promise<void> {
    const transcript = await findClaudeTranscriptFile(
      this.options.paths.projects,
      session.sessionId,
      session.cwd,
    );
    if (!transcript) return;

    const sourceProfile = this.sessionSourceProfile(session.sessionId);
    const targetProfile = this.runtimeProfile();
    if (
      sourceProfile !== "unknown" &&
      targetProfile !== "unknown" &&
      sourceProfile !== targetProfile
    ) {
      throw new Error(
        `为保护原会话，Bridge 已在发送前阻止本次操作：该会话来自${this.profileLabel(sourceProfile)}，`
        + `当前 Bridge Host 使用${this.profileLabel(targetProfile)}，Bridge 不允许跨 profile 直接续接。`
        + "原会话未写入新消息；请在原 Claude Desktop 会话继续，或新建 Bridge 会话。",
      );
    }
  }

  private async recordTask(sessionId: string, generation: string, task: SessionHostBackgroundTask, subagent: BridgeSubagentSummary): Promise<void> {
    await this.record({
      sessionId, itemId: subagent.toolUseId ?? `subagent:${subagent.agentId}`, timestamp: subagent.updatedAt,
      origin: "claude-host", type: subagent.state === "running" || subagent.state === "unknown" ? "tool.progress" : "tool.completed",
      data: { toolName: "Agent", summary: subagent.description, task, subagent, generation },
    });
  }

  private hostHasBackgroundWork(sessionId: string): boolean {
    const host = this.runtimeStates.get(sessionId)?.host;
    return Boolean(host?.hasPendingInput || host?.runningBackgroundTasks?.length ||
      this.permissionBroker.list(sessionId).length ||
      (this.taskState.hasAuthority(sessionId) ? this.taskState.runningSubagents(sessionId)
        : this.options.observer.runningSubagents(sessionId)));
  }

  private scheduleRelease(sessionId: string): void {
    const state = this.runtimeStates.get(sessionId);
    if (
      !state?.host ||
      state.active ||
      state.releaseTimer || this.hostHasBackgroundWork(sessionId) ||
      this.pending.some((turn) => turn.sessionId === sessionId)
    ) return;
    state.releaseTimer = setTimeout(() => {
      void this.releaseSession(sessionId);
    }, SESSION_RELEASE_DELAY_MS);
  }

  private async handleHostEvent(
    event: SessionHostEvent,
    generation?: string,
  ): Promise<void> {
    const eventOrigin = "claude-host";
    const runtime = this.runtimeStates.get(event.sessionId);
    if (generation && runtime?.hostGeneration !== generation) return;
    if (
      "turnId" in event &&
      typeof event.turnId === "string" &&
      this.forceStoppedTurnIds.has(event.turnId)
    ) return;
    const state = this.runtimeStates.get(event.sessionId);
    const active = (
      state?.active && state.active.turnId === ("turnId" in event ? event.turnId : undefined)
        ? state.active
        : this.pending.find((turn) => (
            turn.sessionId === event.sessionId &&
            turn.state === "running" &&
            (!("turnId" in event) || !event.turnId || turn.turnId === event.turnId)
          ))
    );
    if ((event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.interrupted") &&
      (!active || (event.turnId !== undefined && active.turnId !== event.turnId))) return;
    if (event.type === "assistant.delta") {
      // SDK stream event UUIDs identify chunks, not the assistant response stream.
      const itemId = event.turnId ? `assistant:${event.turnId}` : event.itemId;
      this.options.eventLog.appendCoalescedDelta({
        sessionId: event.sessionId,
        ...(event.turnId ? { turnId: event.turnId } : {}),
        itemId,
        timestamp: event.at,
        origin: eventOrigin,
        type: "assistant.delta",
      }, event.text);
      return;
    }
    if (event.type === "runtime.started") {
      if (generation) this.taskState.beginGeneration(event.sessionId, generation);
      return;
    }
    if (event.type === "runtime.ready") {
      this.emit("changed");
      return;
    }
    if (event.type === "runtime.stopped") {
      if (generation) {
        for (const summary of this.taskState.endGeneration(event.sessionId, generation, event.at)) {
          await this.recordTask(event.sessionId, generation, this.taskState.task(event.sessionId, summary.toolUseId ?? summary.agentId)!, summary);
        }
        this.options.observer.setHostTaskAuthority?.(event.sessionId, false);
      }
      this.emit("changed");
      return;
    }
    if (event.type === "background.tasks" || event.type === "task.started" || event.type === "task.progress" || event.type === "task.notification") {
      if (!generation) return;
      this.options.observer.setHostTaskAuthority?.(event.sessionId, true);
      const summaries = event.type === "background.tasks"
        ? this.taskState.replace(event.sessionId, generation, event.tasks, event.at)
        : [this.taskState.update(event.sessionId, generation, event)].filter((item): item is BridgeSubagentSummary => Boolean(item));
      for (const summary of summaries) {
        await this.recordTask(event.sessionId, generation, this.taskState.task(event.sessionId, summary.toolUseId ?? summary.agentId)!, summary);
      }
      if (this.taskState.runningSubagents(event.sessionId)) {
        if (state?.releaseTimer) { clearTimeout(state.releaseTimer); delete state.releaseTimer; }
      } else this.scheduleRelease(event.sessionId);
      this.emit("changed");
      return;
    }
    if (event.type === "user.submitted") {
      await this.record({sessionId:event.sessionId,turnId:event.turnId,itemId:event.messageId,timestamp:event.at,origin:eventOrigin,
        type:"message.delivery",data:{delivery:"submitted",messageId:event.messageId,...(active ? {commandId:active.commandId,requestId:active.requestId} : {})}});
      return;
    }
    if (event.type === "turn.started") {
      if (active && state) { state.active = active; state.turnState = "running"; }
      await this.record({
        sessionId: event.sessionId,
        turnId: event.turnId,
        timestamp: event.at,
        origin: eventOrigin,
        type: "turn.started",
        data: {
          delivery: "running",
          ...(active ? {
            commandId: active.commandId,
            requestId: active.requestId,
            idempotencyKey: active.idempotencyKey,
          } : {}),
        },
      });
      return;
    }
    if (event.type === "user.accepted") {
      if (this.options.eventLog.hasItem(event.sessionId, "user.message.accepted", event.messageId)) return;
      if (active) {
        active.messageId ??= event.messageId;
        active.sessionAcceptedAt = event.at;
        if (state) state.turnState = "running";
        await this.saveQueue();
      }
      await this.record({
        sessionId: event.sessionId,
        turnId: event.turnId,
        itemId: event.messageId,
        timestamp: event.at,
        origin: event.origin,
        type: "user.message.accepted",
        data: {
          text: event.text,
          attachments: event.attachments,
          delivery: "session-received",
          ...(active ? {
            commandId: active.commandId,
            requestId: active.requestId,
            idempotencyKey: active.idempotencyKey,
          } : {}),
        },
      });
      return;
    }
    if (event.type === "assistant.completed") {
      if (this.options.eventLog.hasItem(event.sessionId, "assistant.completed", event.itemId)) return;
      await this.options.eventLog.flushDeltas(event.sessionId);
      await this.record({
        sessionId: event.sessionId,
        ...(event.turnId ? { turnId: event.turnId } : {}),
        itemId: event.itemId,
        timestamp: event.at,
        origin: eventOrigin,
        type: "assistant.completed",
        data: { text: event.text },
      });
      return;
    }
    if (event.type === "tool.started") {
      if (this.options.eventLog.hasItem(event.sessionId, "tool.started", event.itemId)) return;
      this.toolNames.set(event.itemId, event.toolName);
      if (this.options.evidence) {
        await this.evidenceCall(() => this.options.evidence!.recordToolStarted({
          sessionId: event.sessionId,
          ...(event.turnId ? { turnId: event.turnId } : {}),
          itemId: event.itemId,
          toolName: event.toolName,
          toolInput: event.input,
          at: event.at,
        }));
      }
      const subagent = this.initialSubagentSummary(event.toolName, event.itemId, event.input, event.at);
      await this.record({
        sessionId: event.sessionId,
        ...(event.turnId ? { turnId: event.turnId } : {}),
        itemId: event.itemId,
        timestamp: event.at,
        origin: eventOrigin,
        type: "tool.started",
        data: {
          toolName: event.toolName,
          input: event.input,
          summary: this.toolSummary(event.toolName, event.input),
          ...(subagent ? { subagent } : {}),
        },
      });
      return;
    }
    if (event.type === "tool.progress") {
      await this.record({
        sessionId: event.sessionId,
        ...(event.turnId ? { turnId: event.turnId } : {}),
        itemId: event.itemId,
        timestamp: event.at,
        origin: eventOrigin,
        type: "tool.progress",
        data: { text: event.text, toolName: this.toolNames.get(event.itemId) ?? "" },
      });
      return;
    }
    if (event.type === "tool.completed") {
      if (this.options.eventLog.hasItem(event.sessionId, "tool.completed", event.itemId)) return;
      const toolName = this.toolNames.get(event.itemId) ?? "";
      if (this.options.evidence) {
        await this.evidenceCall(() => this.options.evidence!.recordToolCompleted({
          sessionId: event.sessionId,
          ...(event.turnId ? { turnId: event.turnId } : {}),
          itemId: event.itemId,
          output: event.output,
          at: event.at,
        }));
      }
      if (this.taskState.task(event.sessionId, event.itemId)) return;
      const outputText = this.extractToolOutputText(event.output);
      if (
        (toolName === "Agent" || toolName === "Task") &&
        outputText &&
        /Async agent launched successfully/iu.test(outputText)
      ) {
        const startedEvent = this.options.eventLog.latestItem(event.sessionId, "tool.started", event.itemId);
        const prevSubagent = startedEvent?.data.subagent as BridgeSubagentSummary | undefined;
        const agentIdMatch = outputText.match(/agentId:\s*([^\s(]+)/u);
        const subagent: BridgeSubagentSummary = {
          agentId: agentIdMatch?.[1] ?? prevSubagent?.agentId ?? event.itemId,
          toolUseId: event.itemId,
          ...(prevSubagent?.agentType ? { agentType: prevSubagent.agentType } : {}),
          description: prevSubagent?.description ?? "后台子代理运行中",
          state: "running",
          toolCount: prevSubagent?.toolCount ?? 0,
          startedAt: prevSubagent?.startedAt ?? event.at,
          updatedAt: event.at,
        };
        await this.record({
          sessionId: event.sessionId,
          ...(event.turnId ? { turnId: event.turnId } : {}),
          itemId: event.itemId,
          timestamp: subagent.startedAt,
          origin: eventOrigin,
          type: "tool.progress",
          data: {
            toolName,
            summary: `${subagent.description} (后台运行中)`,
            subagent,
          },
        });
        return;
      }
      const startedEvent = this.options.eventLog.latestItem(event.sessionId, "tool.started", event.itemId);
      const progressEvent = this.options.eventLog.latestItem(event.sessionId, "tool.progress", event.itemId);
      const prevSubagent = (progressEvent?.data.subagent ?? startedEvent?.data.subagent) as BridgeSubagentSummary | undefined;
      const completedSubagent: BridgeSubagentSummary | undefined = prevSubagent
        ? {
            ...prevSubagent,
            state: "completed",
            updatedAt: event.at,
            durationMs: Math.max(0, event.at - prevSubagent.startedAt),
            ...(outputText && !prevSubagent.reportText ? { reportText: outputText } : {}),
          }
        : undefined;
      await this.record({
        sessionId: event.sessionId,
        ...(event.turnId ? { turnId: event.turnId } : {}),
        itemId: event.itemId,
        timestamp: event.at,
        origin: eventOrigin,
        type: "tool.completed",
        data: {
          toolName,
          summary: completedSubagent
            ? `${completedSubagent.description}${completedSubagent.toolCount ? ` (${completedSubagent.toolCount} 步)` : ""}`
            : toolName ? `${toolName} completed` : "Tool completed",
          ...(completedSubagent ? { subagent: completedSubagent } : {}),
        },
      });
      return;
    }
    if (event.type === "turn.completed") {
      await this.options.eventLog.flushDeltas(event.sessionId);
      await this.record({
        sessionId: event.sessionId,
        ...(event.turnId ? { turnId: event.turnId } : {}),
        timestamp: event.at,
        origin: eventOrigin,
        type: "turn.completed",
        data: {
          result: event.result,
          delivery: "completed",
          ...(active ? {
            commandId: active.commandId,
            requestId: active.requestId,
            idempotencyKey: active.idempotencyKey,
          } : {}),
        },
      });
      if (this.options.evidence) {
        void this.evidenceCall(() => this.options.evidence!.finalizeBridgeTurn({
          sessionId: event.sessionId,
          ...(event.turnId ? { turnId: event.turnId } : {}),
          completedAt: event.at,
        }));
      }
      await this.finishTurn(event.sessionId, "completed", active);
      return;
    }
    if (event.type === "runtime.error") {
      // Query failures emit an explicit turn.failed for each unfinished input.
      // This process diagnostic can arrive after the next command has started.
      await this.record({
        sessionId: event.sessionId, timestamp: event.at, origin: eventOrigin,
        type: "runtime.error", data: { error: event.error, ...(generation ? { generation } : {}) },
      });
      return;
    }
    if (event.type === "turn.failed") {
      await this.options.eventLog.flushDeltas(event.sessionId);
      await this.record({
        sessionId: event.sessionId,
        ...(event.turnId ? { turnId: event.turnId } : {}),
        timestamp: event.at,
        origin: eventOrigin,
        type: "turn.failed",
        data: {
          error: event.error,
          retrying: false,
          delivery: "failed",
          ...(active ? {
            commandId: active.commandId,
            requestId: active.requestId,
            idempotencyKey: active.idempotencyKey,
          } : {}),
        },
      });
      if (this.options.evidence) {
        void this.evidenceCall(() => this.options.evidence!.finalizeBridgeTurn({
          sessionId: event.sessionId,
          ...(event.turnId ? { turnId: event.turnId } : {}),
          failed: true,
          error: event.error,
          completedAt: event.at,
        }));
      }
      await this.finishTurn(event.sessionId, "failed", active);
      return;
    }
    if (event.type === "turn.interrupted") {
      await this.options.eventLog.flushDeltas(event.sessionId);
      await this.record({
        sessionId: event.sessionId,
        ...(event.turnId ? { turnId: event.turnId } : {}),
        timestamp: event.at,
        origin: "system",
        type: "turn.interrupted",
        data: {
          delivery: "cancelled",
          ...(active ? {
            commandId: active.commandId,
            requestId: active.requestId,
            idempotencyKey: active.idempotencyKey,
          } : {}),
        },
      });
      if (this.options.evidence) {
        void this.evidenceCall(() => this.options.evidence!.finalizeBridgeTurn({
          sessionId: event.sessionId,
          ...(event.turnId ? { turnId: event.turnId } : {}),
          failed: true,
          error: "任务已停止",
          completedAt: event.at,
        }));
      }
      await this.finishTurn(event.sessionId, "interrupted", active);
    }
  }

  private async finishTurn(sessionId: string, terminal: "completed" | "failed" | "interrupted", turn = this.runtimeStates.get(sessionId)?.active): Promise<void> {
    const state = this.runtimeStates.get(sessionId);
    if (!state || !turn) return;
    const occupied = Boolean(state.active);
    const index = this.pending.findIndex((candidate) => candidate.commandId === turn.commandId);
    if (index >= 0) this.pending.splice(index, 1);
    this.rememberTerminal(turn, terminal === "interrupted" ? "cancelled" : terminal);
    if (state.active === turn) {
      const next = this.pending.filter(candidate => candidate.sessionId === sessionId && candidate.state === "running")
        .sort((left, right) => (right.sessionAcceptedAt ?? 0) - (left.sessionAcceptedAt ?? 0))[0];
      if (next) state.active = next;
      else delete state.active;
    }
    if (state.ownership !== "RELEASING") {
      state.ownership = state.active ? "BRIDGE_RUNNING" : "BRIDGE_IDLE";
      state.turnState = state.active ? state.active.sessionAcceptedAt ? "running" : "queued" : "idle";
      if (occupied && !state.active) this.activeTurns = Math.max(0, this.activeTurns - 1);
      if (!state.active && !this.taskState.runningSubagents(sessionId) && !state.host?.runningBackgroundTasks?.length) {
        this.permissionBroker.cancelSession(sessionId, terminal === "interrupted" ? "turn-interrupted" : "turn-finished");
      }
    }
    await this.saveQueue();
    this.scheduleRelease(sessionId);
    this.emit("changed");
    void this.reconcileDesktopRegistration(sessionId);
    await this.pump();
  }

  private reconcileDesktopRegistrations(): void {
    if (!this.options.desktopRegistrar || this.closed) return;
    for (const sessionId of this.bridgeSessions.keys()) {
      void this.reconcileDesktopRegistration(sessionId);
    }
  }

  private reconcileDesktopRegistration(sessionId: string, force = false): Promise<void> {
    return this.desktopRegistration.reconcile(sessionId, force);
  }

  private commandEvidence(turn: QueuedTurn): Promise<CommandEvidence> {
    return readCommandEvidence(
      this.options.eventLog, this.options.paths, turn,
      this.options.conversationState?.lane(turn.laneId)?.nativeSessionId ?? undefined,
    );
  }

  private async settleInterruptedCommand(turn: QueuedTurn, evidence: CommandEvidence): Promise<void> {
    const terminal = evidence.terminal ?? "cancelled";
    this.rememberTerminal(turn, terminal);
    if (this.options.eventLog.turnEvidence(turn).terminal) return;
    await this.record({
      sessionId: turn.sessionId,
      ...(turn.turnId ? { turnId: turn.turnId } : {}),
      itemId: turn.commandId,
      origin: "system",
      type: terminal === "completed" ? "turn.completed" : terminal === "failed" ? "turn.failed" : "turn.interrupted",
      data: {
        delivery: terminal,
        commandId: turn.commandId,
        requestId: turn.requestId,
        idempotencyKey: turn.idempotencyKey,
        reason: "execution-ended-without-result",
      },
    });
  }

  private async failQueuedTurn(turn: QueuedTurn, error: string): Promise<void> {
    const index = this.pending.findIndex((candidate) => candidate.commandId === turn.commandId);
    if (index >= 0) this.pending.splice(index, 1);
    this.rememberTerminal(turn, "failed");
    await this.saveQueue();
    await this.record({
      sessionId: turn.sessionId,
      itemId: turn.commandId,
      origin: "system",
      type: "turn.failed",
      data: {
        commandId: turn.commandId,
        requestId: turn.requestId,
        error,
        delivery: "failed",
        wasQueued: true,
      },
    });
    this.emit("changed");
  }

  private async releaseSession(sessionId: string): Promise<void> {
    const state = this.runtimeStates.get(sessionId);
    if (state?.releaseTimer) { clearTimeout(state.releaseTimer); delete state.releaseTimer; }
    if (!state?.host || state.active || state.ownership === "RELEASING" || this.hostHasBackgroundWork(sessionId) || this.pending.some((turn) => turn.sessionId === sessionId)) return;
    state.ownership = "RELEASING";
    await this.recordOwnership(sessionId, state.ownership);
    await state.host.close();
    delete state.host;
    delete state.hostLaneId;
    delete state.releaseTimer;
    state.ownership = this.catalog.sessions.some((session) => session.sessionId === sessionId)
      ? "DESKTOP_OBSERVED"
      : "BRIDGE_IDLE";
    await this.recordOwnership(sessionId, state.ownership);
    this.emit("changed");
    await this.pump();
  }

  private pump(): Promise<void> {
    const next = this.pumpQueue
      .catch(() => undefined)
      .then(() => this.pumpOnce());
    this.pumpQueue = next;
    return next.then(async () => { await Promise.all(this.dispatching.values()); });
  }

  private async pumpOnce(): Promise<void> {
    if (this.closed || !this.initialized) return;
    if (!this.runtime?.executablePath) {
      await this.refreshRuntime();
      if (!this.runtime?.executablePath) { this.scheduleRuntimeRetry(); return; }
    }
    this.sortPending();
    for (const turn of this.pending) {
      const starting = [...this.dispatching.keys()].filter((id) => !this.runtimeStates.get(id)?.active).length;
      if (this.activeTurns + starting >= this.maxParallelTurns) break;
      if (turn.state !== "queued" || turn.recoveryBlocked || this.dispatching.has(turn.sessionId)) continue;
      const providerKind = this.options.conversationState?.lane(turn.laneId)?.providerKind ?? "claude-3p";
      if (providerKind === "claude-3p" && !this.runtime.credentialPath) {
        this.scheduleRuntimeRetry();
        continue;
      }
      const state = this.runtimeStates.get(turn.sessionId);
      // Conflict containment owns the session until the old host is closed and the turn is persisted.
      const conflictSettling = this.conflictTasks.has(turn.sessionId) || (
        state?.ownership === "OWNERSHIP_CONFLICT" &&
        this.takeoverRetryTimers.has(turn.sessionId)
      );
      if (state?.active || state?.ownership === "RELEASING" || conflictSettling) continue;
      if (this.takeoverRetryTimers.has(turn.sessionId)) continue;
      const task = this.dispatchTurn(turn).catch(async (error: unknown) => {
        if (this.closed || !this.pending.includes(turn)) return;
        await this.failQueuedTurn(turn, error instanceof Error ? error.message : String(error));
      }).finally(() => {
        this.dispatching.delete(turn.sessionId);
        if (!this.closed && this.pending.some((candidate) => candidate.sessionId !== turn.sessionId &&
          candidate.state === "queued" && !this.takeoverRetryTimers.has(candidate.sessionId))) void this.pump();
      });
      this.dispatching.set(turn.sessionId, task);
    }
    this.emit("changed");
  }

  private async dispatchTurn(turn: QueuedTurn): Promise<void> {
    if (!this.canDispatch(turn)) return;
    await this.acquire(turn);
  }

  private canDispatch(turn: QueuedTurn): boolean {
    return !this.closed && turn.state === "queued" && this.pending.includes(turn)
      && this.runtimeStates.get(turn.sessionId)?.ownership !== "RELEASING";
  }

  private scheduleRuntimeRetry(): void {
    if (this.runtimeRetryTimer || this.closed) return;
    this.runtimeRetryTimer = setTimeout(() => {
      this.runtimeRetryTimer = undefined;
      void this.refreshRuntime();
    }, this.options.runtimeRetryDelayMs ?? RUNTIME_RETRY_DELAY_MS);
    this.runtimeRetryTimer.unref?.();
  }

  private scheduleTakeoverRetry(sessionId: string): void {
    if (this.closed || this.takeoverRetryTimers.has(sessionId)) return;
    const timer = setTimeout(() => {
      this.takeoverRetryTimers.delete(sessionId);
      void this.pump();
    }, 1_500);
    timer.unref?.();
    this.takeoverRetryTimers.set(sessionId, timer);
  }

  private clearTakeoverRetry(sessionId: string): void {
    const timer = this.takeoverRetryTimers.get(sessionId);
    if (!timer) return;
    clearTimeout(timer);
    this.takeoverRetryTimers.delete(sessionId);
  }

  private clearRuntimeRetry(): void {
    if (!this.runtimeRetryTimer) return;
    clearTimeout(this.runtimeRetryTimer);
    this.runtimeRetryTimer = undefined;
  }

  private hasConfirmedOwnershipConflict(
    sessionId: string,
    state = this.runtimeStates.get(sessionId),
  ): boolean {
    return Boolean(
      state?.host &&
      state.externalWriteVersion !== undefined &&
      this.options.observer.externalWriteVersion(sessionId) > state.externalWriteVersion
    );
  }

  private refreshObservedOwnership(): void {
    for (const observed of this.catalog.sessions) {
      const state = this.runtimeStates.get(observed.sessionId);
      if (this.hasConfirmedOwnershipConflict(observed.sessionId, state)) {
        void this.containOwnershipConflict(observed.sessionId, observed.activeProcesses);
        continue;
      }
      if (!state) continue;
      if (!state.host && !state.active) {
        state.ownership = "DESKTOP_OBSERVED";
        state.turnState = this.options.observer.isMainTurnBusy(observed.sessionId) ? "running" : "idle";
      }
    }
  }

  private async containOwnershipConflict(
    sessionId: string,
    processes: ClaudeCatalogSnapshot["sessions"][number]["activeProcesses"],
  ): Promise<void> {
    const existing = this.conflictTasks.get(sessionId);
    if (existing) return existing;
    const task = this.resolveOwnershipConflict(sessionId, processes)
      .finally(() => {
        if (this.conflictTasks.get(sessionId) === task) this.conflictTasks.delete(sessionId);
      });
    this.conflictTasks.set(sessionId, task);
    return task;
  }

  private async resolveOwnershipConflict(
    sessionId: string,
    processes: ClaudeCatalogSnapshot["sessions"][number]["activeProcesses"],
  ): Promise<void> {
    const existingState = this.runtimeStates.get(sessionId);
    const state = existingState ?? {
      ownership: "DESKTOP_OBSERVED" as const,
      turnState: "waiting" as const,
    };
    const wasConflict = existingState?.ownership === "OWNERSHIP_CONFLICT";
    const host = state.host;
    const active = state.active;
    if (state.releaseTimer) {
      clearTimeout(state.releaseTimer);
      delete state.releaseTimer;
    }
    delete state.host;
    delete state.hostLaneId;
    state.ownership = "OWNERSHIP_CONFLICT";
    state.turnState = active?.transport === "bridge-host"
      || this.pending.some((turn) => turn.sessionId === sessionId && turn.state === "queued")
      ? "queued"
      : "waiting";
    this.runtimeStates.set(sessionId, state);

    if (active?.transport === "bridge-host") {
      this.permissionBroker.cancelSession(sessionId);
      delete state.active;
      this.activeTurns = Math.max(0, this.activeTurns - 1);
      const evidence = await this.commandEvidence(active);
      if (active.submissionStartedAt || active.sessionAcceptedAt || evidence.submitted || evidence.accepted || evidence.terminal) {
        const index = this.pending.findIndex((candidate) => candidate.commandId === active.commandId);
        if (index >= 0) this.pending.splice(index, 1);
        await host?.close();
        await this.settleInterruptedCommand(active, evidence);
        state.turnState = this.pending.some((turn) => turn.sessionId === sessionId && turn.state === "queued")
          ? "queued" : "waiting";
        await this.saveQueue();
        if (this.options.evidence) {
          void this.evidenceCall(() => this.options.evidence!.finalizeBridgeTurn({
            sessionId,
            ...(active.turnId ? { turnId: active.turnId } : {}),
            failed: evidence.terminal !== "completed",
            completedAt: Date.now(),
          }));
        }
      } else {
        active.state = "queued";
        delete active.turnId;
        delete active.messageId;
        delete active.sessionAcceptedAt;
        await this.saveQueue();
        await host?.close().catch(() => undefined);
        await this.record({
          sessionId,
          itemId: active.commandId,
          origin: "system",
          type: "turn.queued",
          data: {
            commandId: active.commandId,
            requestId: active.requestId,
            idempotencyKey: active.idempotencyKey,
            delivery: "host-received",
            retrying: true,
            reason: "ownership-conflict",
            attempt: active.attempts,
          },
        });
      }
    } else {
      await host?.close().catch(() => undefined);
    }

    if (!wasConflict) {
      await this.record({
        sessionId,
        origin: "system",
        type: "session.ownership-conflict",
        data: {
          ownership: "OWNERSHIP_CONFLICT",
          writers: processes
            .filter((candidate) => candidate.processAlive)
            .map((candidate) => ({
              pid: candidate.pid,
              entrypoint: candidate.entrypoint,
              protocol: candidate.peerProtocol,
            })),
        },
      });
      await this.recordOwnership(sessionId, state.ownership);
    }
    this.emit("changed");
    this.scheduleTakeoverRetry(sessionId);
  }

  private async recordOwnership(sessionId: string, ownership: BridgeOwnershipState): Promise<void> {
    await this.record({
      sessionId,
      origin: "system",
      type: "session.ownership",
      data: { ownership },
    });
  }

  private async record(draft: BridgeEventDraft): Promise<void> {
    if (draft.sessionId && [
      "turn.queued", "turn.started", "turn.completed", "turn.failed", "turn.interrupted",
    ].includes(draft.type)) {
      const pendingCommandIds = this.pending.filter((turn) => (
        turn.sessionId === draft.sessionId &&
        (turn.state === "queued" || turn.state === "uncertain") &&
        (draft.type === "turn.queued" || turn.commandId !== draft.data?.commandId)
      )).map((turn) => turn.commandId);
      draft = {
        ...draft,
        data: { ...draft.data, pendingCount: pendingCommandIds.length, pendingCommandIds },
      };
    }
    await this.options.eventLog.append(draft);
  }

  private toolSummary(toolName: string, input: unknown): string {
    if (input && typeof input === "object") {
      const value = input as Record<string, unknown>;
      const target = value.description ?? value.command ?? value.file_path ?? value.path ?? value.query ?? value.prompt;
      if (typeof target === "string") return `${toolName}: ${compact(target, 120)}`;
    }
    return `${toolName} started`;
  }

  private initialSubagentSummary(
    toolName: string,
    itemId: string,
    input: unknown,
    startedAt: number,
  ): BridgeSubagentSummary | undefined {
    if (toolName !== "Agent" && toolName !== "Task") return undefined;
    const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
    const description = typeof record.description === "string" && record.description.trim()
      ? compact(record.description, 120)
      : typeof record.prompt === "string" && record.prompt.trim()
        ? compact(record.prompt, 120)
        : "Subagent";
    const agentType = typeof record.subagent_type === "string" && record.subagent_type.trim()
      ? record.subagent_type.trim()
      : undefined;
    return {
      agentId: itemId,
      toolUseId: itemId,
      ...(agentType ? { agentType } : {}),
      description,
      state: "running",
      toolCount: 0,
      startedAt,
      updatedAt: startedAt,
    };
  }

  private extractToolOutputText(output: unknown): string | undefined {
    if (typeof output === "string") return output.trim() || undefined;
    if (Array.isArray(output)) {
      const parts = output
        .map((entry) => {
          if (typeof entry === "string") return entry;
          if (entry && typeof entry === "object" && typeof (entry as { text?: unknown }).text === "string") {
            return (entry as { text: string }).text;
          }
          return "";
        })
        .filter(Boolean);
      const joined = parts.join("\n").trim();
      return joined || undefined;
    }
    if (output && typeof output === "object" && typeof (output as { text?: unknown }).text === "string") {
      return ((output as { text: string }).text).trim() || undefined;
    }
    return undefined;
  }

  private sortPending(): void {
    this.pending.sort((left, right) => right.priority - left.priority || left.requestedAt - right.requestedAt);
  }

  private rememberTerminal(turn: Pick<QueuedTurn, "idempotencyKey" | "commandId" | "requestId" | "sessionId">, state: TerminalTurnState): void {
    const receipt: TerminalTurnReceipt = {
      idempotencyKey: turn.idempotencyKey,
      commandId: turn.commandId,
      requestId: turn.requestId,
      sessionId: turn.sessionId,
      state,
    };
    this.completedKeys.delete(turn.idempotencyKey);
    this.completedKeys.add(turn.idempotencyKey);
    this.terminalTurns.set(turn.idempotencyKey, receipt);
    while (this.completedKeys.size > 2_000) {
      const oldest = this.completedKeys.values().next().value as string | undefined;
      if (!oldest) break;
      this.completedKeys.delete(oldest);
      this.terminalTurns.delete(oldest);
    }
  }

  private async loadSessions(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.options.sessionsPath, "utf8")) as Partial<BridgeSessionsFile>;
      if (parsed.version !== 2 || !Array.isArray(parsed.sessions)) throw new Error("Unsupported Bridge session file");
      for (const session of parsed.sessions) this.bridgeSessions.set(session.sessionId, session);
      for (const configuration of parsed.configurations ?? []) {
        if (
          !configuration ||
          typeof configuration.sessionId !== "string" ||
          typeof configuration.updatedAt !== "number" ||
          (configuration.model !== undefined && typeof configuration.model !== "string") ||
          (configuration.effort !== undefined && !EFFORT_LEVELS.includes(configuration.effort)) ||
          (
            configuration.permissionMode !== undefined &&
            configuration.permissionMode !== "standard" &&
            configuration.permissionMode !== "full-access"
          ) ||
          (!configuration.model && !configuration.effort && !configuration.permissionMode)
        ) continue;
        this.sessionConfigurations.set(configuration.sessionId, configuration);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      await rename(this.options.sessionsPath, `${this.options.sessionsPath}.archive-${Date.now()}`).catch(() => undefined);
    }
  }

  private async saveSessions(): Promise<void> {
    if (this.options.conversationState) {
      this.options.conversationState.saveBrokerSessions(
        [...this.bridgeSessions.values()],
        [...this.sessionConfigurations.values()],
      );
      return;
    }
    const contents = `${JSON.stringify({
      version: 2,
      sessions: [...this.bridgeSessions.values()],
      configurations: [...this.sessionConfigurations.values()],
    } satisfies BridgeSessionsFile, null, 2)}\n`;
    await this.atomicWrite(this.options.sessionsPath, contents);
  }

  private async loadQueue(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.options.queuePath, "utf8")) as Partial<TurnQueueFile>;
      if (parsed.version !== 2 || !Array.isArray(parsed.pending) || !Array.isArray(parsed.completedIdempotencyKeys)) {
        throw new Error("Unsupported Bridge queue file");
      }
      const terminalTurns = Array.isArray(parsed.terminalTurns)
        ? parsed.terminalTurns.filter((receipt): receipt is TerminalTurnReceipt => (
            Boolean(receipt) &&
            typeof receipt.idempotencyKey === "string" &&
            typeof receipt.commandId === "string" &&
            typeof receipt.requestId === "string" &&
            typeof receipt.sessionId === "string" &&
            ["completed", "failed", "cancelled"].includes(receipt.state)
          ))
        : [];
      await this.restoreQueue(parsed.pending, parsed.completedIdempotencyKeys, terminalTurns);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      await rename(this.options.queuePath, `${this.options.queuePath}.archive-${Date.now()}`).catch(() => undefined);
    }
  }

  private reconcileRotatedCatalogSessions(): void {
    let changed = false;
    for (const observed of this.catalog.sessions) {
      const priorIds = new Set(observed.priorSessionIds ?? []);
      if (observed.desktopSessionId) {
        for (const bridge of this.bridgeSessions.values()) {
          if (bridge.desktopSessionId === observed.desktopSessionId && bridge.sessionId !== observed.sessionId) {
            priorIds.add(bridge.sessionId);
          }
        }
      }
      for (const priorId of priorIds) {
        if (priorId === observed.sessionId) continue;
        const priorConfig = this.sessionConfigurations.get(priorId);
        if (priorConfig) {
          if (!this.sessionConfigurations.has(observed.sessionId)) {
            this.sessionConfigurations.set(observed.sessionId, {
              ...priorConfig,
              sessionId: observed.sessionId,
            });
          }
          this.sessionConfigurations.delete(priorId);
          changed = true;
        }
        if (this.bridgeSessions.has(priorId) && !this.hasActiveOrPending(priorId)) {
          this.bridgeSessions.delete(priorId);
          for (const child of this.bridgeSessions.values()) {
            if (child.parentSessionId === priorId) child.parentSessionId = observed.sessionId;
          }
          changed = true;
        }
      }
    }
    if (changed) void this.saveSessions();
  }

  private refreshRecoveryBlocks(): void {
    const observedIds = new Set(this.catalog.sessions.map((session) => session.sessionId));
    for (const turn of this.pending) {
      if (turn.state !== "queued" && turn.state !== "uncertain") continue;
      const blocked = !observedIds.has(turn.sessionId) && !this.bridgeSessions.has(turn.sessionId);
      turn.recoveryBlocked = blocked;
      if (!blocked || turn.state !== "uncertain") continue;
      if (turn.mode === "handoff") continue;
      if (turn.mode !== "steer") this.activeTurns = Math.max(0, this.activeTurns - 1);
      turn.state = "queued";
      this.runtimeStates.delete(turn.sessionId);
    }
  }

  private async saveQueue(): Promise<void> {
    if (this.options.conversationState) {
      this.options.conversationState.saveBrokerQueue(
        this.pending.map((turn) => ({ ...turn })),
        [...this.completedKeys].slice(-2_000),
        [...this.terminalTurns.values()].slice(-2_000),
      );
      return;
    }
    const contents = `${JSON.stringify({
      version: 2,
      pending: this.pending,
      completedIdempotencyKeys: [...this.completedKeys].slice(-2_000),
      terminalTurns: [...this.terminalTurns.values()].slice(-2_000),
    } satisfies TurnQueueFile, null, 2)}\n`;
    await this.atomicWrite(this.options.queuePath, contents);
  }

  private async atomicWrite(path: string, contents: string): Promise<void> {
    this.writeQueue = this.writeQueue.catch(() => undefined).then(async () => {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, path);
    });
    await this.writeQueue;
  }

  private async loadConversationState(): Promise<void> {
    const persisted = this.options.conversationState!.loadBrokerState();
    for (const session of persisted.sessions) {
      this.bridgeSessions.set(session.sessionId, session as StoredBridgeSession);
    }
    for (const configuration of persisted.configurations) {
      if (
        typeof configuration.sessionId !== "string" ||
        typeof configuration.updatedAt !== "number" ||
        (configuration.model !== undefined && typeof configuration.model !== "string") ||
        (configuration.effort !== undefined && !EFFORT_LEVELS.includes(configuration.effort as BridgeEffort)) ||
        (
          configuration.permissionMode !== undefined &&
          configuration.permissionMode !== "standard" &&
          configuration.permissionMode !== "full-access"
        ) ||
        (!configuration.model && !configuration.effort && !configuration.permissionMode)
      ) continue;
      this.sessionConfigurations.set(
        configuration.sessionId,
        configuration as StoredSessionConfiguration,
      );
    }
    await this.restoreQueue(
      persisted.pending as unknown as QueuedTurn[],
      persisted.completedIdempotencyKeys,
      persisted.terminalTurns as TerminalTurnReceipt[],
    );
  }

  private async restoreQueue(
    pending: QueuedTurn[],
    completedKeys: string[],
    terminalTurns: TerminalTurnReceipt[],
  ): Promise<void> {
    for (const key of completedKeys) this.completedKeys.add(key);
    for (const receipt of terminalTurns) {
      this.terminalTurns.set(receipt.idempotencyKey, receipt);
      this.completedKeys.add(receipt.idempotencyKey);
    }
    let settledDelivered = false;
    for (const turn of pending) {
      if (turn.state === "running" && turn.transport === "bridge-host") {
        const evidence = await this.commandEvidence(turn);
        if (turn.submissionStartedAt !== undefined || turn.sessionAcceptedAt !== undefined ||
          evidence.submitted || evidence.accepted || evidence.terminal) {
          await this.settleInterruptedCommand(turn, evidence);
          settledDelivered = true;
          continue;
        }
      }
      const state = turn.mode === "handoff" || turn.state === "uncertain" || (
        turn.state === "running" && turn.transport === "claude-desktop-managed"
      )
        ? "uncertain"
        : "queued";
      const restored: QueuedTurn = {
        ...turn,
        laneId: typeof turn.laneId === "string"
          ? turn.laneId
          : legacyClaudeLaneId(turn.sessionId),
        state,
        priority: turn.priority ?? 0,
        attempts: turn.attempts ?? 0,
        mode: turn.mode ?? "start",
        sessionTitle: turn.sessionTitle ?? `未完成任务：${compact(turn.text, 72)}`,
      };
      if (!restored.sessionCwd) {
        const transcriptPath = await findClaudeTranscriptFile(
          this.options.paths.projects,
          restored.sessionId,
        );
        if (transcriptPath) {
          const recoveredCwd = await transcriptCwd(transcriptPath);
          if (recoveredCwd) restored.sessionCwd = recoveredCwd;
        }
      }
      this.pending.push(restored);
      // Legacy managed/handoff receipts have no live host. Keep them reviewable,
      // without consuming runtime slots or automatically replaying their input.
    }
    this.sortPending();
    if (settledDelivered) await this.saveQueue();
  }
}
