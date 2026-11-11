import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BridgeBackgroundTask, ClaudeHistoryMessage } from "@bridge/protocol";
import {
  ClaudeTranscriptEvidenceCursor,
  getClaudeSubagentsMtimeMs,
  parseClaudeTranscriptSnapshot,
  readClaudeTranscriptBackgroundTasks,
  readClaudeTranscriptSubagents,
} from "../transcript/claude-history.js";
import type { ObservedDesktopEvidence } from "../evidence/evidence-manager.js";
import {
  oldestLiveProcessStart,
  scanClaudeCatalog,
  type ClaudeCatalogSnapshot,
  type ObservedClaudeSession,
} from "../claude/claude-session-catalog.js";
import type { ClaudeRuntimePaths } from "../app/platform.js";
import type { SessionEventLog } from "../controller/session-event-log.js";

export interface TranscriptObserverOptions {
  paths: ClaudeRuntimePaths;
  eventLog: SessionEventLog;
  platform?: NodeJS.Platform;
  pollIntervalMs?: number;
  catalogIntervalMs?: number;
  idleGraceMs?: number;
  evidence?: {
    upsertDesktopEvidence(input: ObservedDesktopEvidence): Promise<unknown>;
  };
}

export class TranscriptObserver extends EventEmitter {
  private readonly pollIntervalMs: number;
  private readonly catalogIntervalMs: number;
  private readonly idleGraceMs: number;
  private catalogValue: ClaudeCatalogSnapshot = { projects: [], sessions: [], observedAt: 0 };
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private closed = false;
  private readonly knownMessages = new Map<string, Map<string, string>>();
  private readonly knownUserMessages = new Map<string, Map<string, string>>();
  private readonly lastChangedAt = new Map<string, number>();
  private readonly lastMtime = new Map<string, number>();
  private readonly transcriptTurnBoundaries = new Map<string, boolean>();
  private readonly waitingForUserInput = new Set<string>();
  private readonly pendingBackgroundShellTasks = new Set<string>();
  private readonly transcriptPendingUserMessages = new Map<string, string>();
  private readonly externalWriteVersions = new Map<string, number>();
  private readonly knownEvidence = new Map<string, string>();
  private readonly knownSubagents = new Map<string, Map<string, string>>();
  private readonly runningSubagentSessions = new Map<string, { count: number; lastUpdatedAt: number }>();
  private readonly backgroundTaskSessions = new Map<string, BridgeBackgroundTask[]>();
  private readonly sessionAliases = new Map<string, string>();
  private readonly hostTaskAuthority = new Set<string>();
  private readonly pendingSubagentRefresh = new Set<string>();
  private evidenceFailureReported = false;
  private readonly evidenceCursors = new Map<string, {
    path: string;
    cursor: ClaudeTranscriptEvidenceCursor;
  }>();
  private readonly evidenceBackfill = new Set<string>();
  private nextCatalogAt = 0;
  private lastDesktopConfigMtimeMs = 0;

  constructor(private readonly options: TranscriptObserverOptions) {
    super();
    this.pollIntervalMs = options.pollIntervalMs ?? 1_500;
    this.catalogIntervalMs = options.catalogIntervalMs ?? 10_000;
    this.idleGraceMs = options.idleGraceMs ?? 2_500;
  }

  get catalog(): ClaudeCatalogSnapshot {
    return this.catalogValue;
  }

  onCatalog(listener: (catalog: ClaudeCatalogSnapshot) => void): () => void {
    this.on("catalog", listener);
    return () => this.off("catalog", listener);
  }

  async start(): Promise<void> {
    await this.options.eventLog.initialize();
    await this.poll();
  }

  isDesktopBusy(sessionId: string, now = Date.now()): boolean {
    if (this.isMainTurnBusy(sessionId, now)) return true;
    return Boolean(this.runningSubagents(sessionId)) && !this.isPendingTurnSettled(sessionId);
  }

  /** The main conversation only; subagents outlive its turns and are reported separately. */
  isMainTurnBusy(sessionId: string, now = Date.now()): boolean {
    const session = this.session(sessionId);
    if (!session || this.isPendingTurnSettled(session.sessionId)) return false;
    sessionId = session.sessionId;
    if (!session.processAlive) return false;
    const atTurnBoundary = this.transcriptTurnBoundaries.get(sessionId);
    if (atTurnBoundary !== undefined) return !atTurnBoundary;
    if (session.activeTask) return true;
    const changedAt = this.lastChangedAt.get(sessionId) ?? session.transcriptMtimeMs;
    return now - changedAt < this.idleGraceMs;
  }

  isWaitingForUserInput(sessionId: string): boolean {
    return this.waitingForUserInput.has(this.session(sessionId)?.sessionId ?? sessionId);
  }

  hasPendingBackgroundShellTasks(sessionId: string): boolean {
    return this.pendingBackgroundShellTasks.has(this.session(sessionId)?.sessionId ?? sessionId);
  }

  private isPendingTurnSettled(sessionId: string): boolean {
    sessionId = this.session(sessionId)?.sessionId ?? sessionId;
    const lastUserMessage = this.transcriptPendingUserMessages.get(sessionId);
    return Boolean(lastUserMessage && this.options.eventLog.isUserMessageSettled(
      this.sessionAliases.get(sessionId) ?? sessionId,
      lastUserMessage,
    ));
  }

  runningSubagents(sessionId: string): { count: number; lastUpdatedAt: number } | undefined {
    return this.runningSubagentSessions.get(this.session(sessionId)?.sessionId ?? sessionId);
  }

  backgroundTasks(sessionId: string): readonly BridgeBackgroundTask[] {
    return this.backgroundTaskSessions.get(this.session(sessionId)?.sessionId ?? sessionId) ?? [];
  }

  externalWriteVersion(sessionId: string): number {
    return this.externalWriteVersions.get(this.sessionAliases.get(sessionId) ?? sessionId) ?? 0;
  }

  async canStartBridgeHost(sessionId: string, _reusingIdleHost = false): Promise<boolean> {
    const session = this.session(sessionId);
    sessionId = session?.sessionId ?? sessionId;
    if (session?.transcriptPath && !this.knownUserMessages.has(sessionId)) {
      await this.primeTranscript(session);
    }
    // An idle Desktop executor still retains its loaded conversation head.
    return !session?.desktopProcessAlive;
  }

  session(sessionId: string): ObservedClaudeSession | undefined {
    return this.catalogValue.sessions.find((candidate) => candidate.sessionId === sessionId)
      ?? this.catalogValue.sessions.find((candidate) => this.sessionAliases.get(candidate.sessionId) === sessionId);
  }

  setSessionAlias(nativeSessionId: string, logicalSessionId: string): void {
    if (this.sessionAliases.get(nativeSessionId) === logicalSessionId) return;
    const previousId = this.sessionAliases.get(nativeSessionId) ?? nativeSessionId;
    this.sessionAliases.set(nativeSessionId, logicalSessionId);
    if (previousId !== logicalSessionId && this.externalWriteVersions.has(previousId)) {
      this.externalWriteVersions.set(logicalSessionId, Math.max(
        this.externalWriteVersions.get(logicalSessionId) ?? 0,
        this.externalWriteVersions.get(previousId)!,
      ));
      this.externalWriteVersions.delete(previousId);
    }
  }

  setHostTaskAuthority(sessionId: string, active: boolean): void {
    sessionId = this.sessionAliases.get(sessionId) ?? sessionId;
    if (active) this.hostTaskAuthority.add(sessionId);
    else if (this.hostTaskAuthority.delete(sessionId)) {
      for (const session of this.catalogValue.sessions) {
        if ((this.sessionAliases.get(session.sessionId) ?? session.sessionId) !== sessionId) continue;
        this.knownSubagents.delete(session.sessionId);
        this.pendingSubagentRefresh.add(session.sessionId);
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 10));
  }

  private async poll(): Promise<void> {
    if (this.closed || this.running) return;
    this.running = true;
    try {
      const now = Date.now();
      let changed = false;
      const desktopConfigMtimeMs = await this.readDesktopConfigMtimeMs();
      const desktopConfigChanged = desktopConfigMtimeMs !== this.lastDesktopConfigMtimeMs;
      this.lastDesktopConfigMtimeMs = desktopConfigMtimeMs;
      if (!this.catalogValue.observedAt || now >= this.nextCatalogAt || desktopConfigChanged) {
        const catalog = await scanClaudeCatalog(this.options.paths, this.options.platform);
        const initialCandidates = new Set(
          catalog.sessions
            .filter((session, index) => index < 24 || session.processAlive || session.activeTask)
            .map((session) => session.sessionId),
        );
        for (const session of catalog.sessions) {
          if (session.transcriptPath && !this.evidenceCursors.has(session.sessionId)) {
            this.evidenceBackfill.add(session.sessionId);
          }
          const subagentsMtimeMs = session.transcriptPath && initialCandidates.has(session.sessionId)
            ? await getClaudeSubagentsMtimeMs(session.transcriptPath)
            : 0;
          const combinedMtimeMs = Math.max(session.transcriptMtimeMs, subagentsMtimeMs);
          session.transcriptMtimeMs = combinedMtimeMs;
          session.lastActivityAt = Math.max(session.lastActivityAt, combinedMtimeMs);
          const previousMtime = this.lastMtime.get(session.sessionId);
          this.lastMtime.set(session.sessionId, combinedMtimeMs);
          if (this.pendingSubagentRefresh.has(session.sessionId)) await this.observeSubagents(session, false);
          if (
            initialCandidates.has(session.sessionId) &&
            !this.knownUserMessages.has(session.sessionId)
          ) {
            await this.primeTranscript(session);
          } else if (previousMtime !== undefined && previousMtime !== combinedMtimeMs) {
            this.lastChangedAt.set(session.sessionId, now);
            await this.observeTranscript(session);
          }
        }
        this.catalogValue = catalog;
        this.nextCatalogAt = now + this.catalogIntervalMs;
        await this.backfillEvidence(8);
        changed = true;
      } else {
        changed = await this.pollRecentTranscripts(now);
        await this.backfillEvidence(8);
      }
      if (changed) this.emit("catalog", this.catalogValue);
    } finally {
      this.running = false;
      if (!this.closed) this.timer = setTimeout(() => void this.poll(), this.pollIntervalMs);
    }
  }

  private async readDesktopConfigMtimeMs(): Promise<number> {
    const mtimes = await Promise.all(
      this.options.paths.desktopSessions.flatMap((root) => [
        stat(join(dirname(root), "claude_desktop_config.json")).then((metadata) => metadata.mtimeMs, () => 0),
        stat(join(root, "claude_desktop_config.json")).then((metadata) => metadata.mtimeMs, () => 0),
      ]),
    );
    return Math.max(0, ...mtimes);
  }

  private async pollRecentTranscripts(now: number): Promise<boolean> {
    const candidates = this.catalogValue.sessions.filter((session, index) => (
      Boolean(session.transcriptPath) &&
      (index < 24 || session.processAlive || session.activeTask)
    ));
    const mtimes = await Promise.all(candidates.map(async (session) => {
      const [mainMtime, subMtime] = await Promise.all([
        stat(session.transcriptPath!).then((metadata) => metadata.mtimeMs, () => 0),
        getClaudeSubagentsMtimeMs(session.transcriptPath!),
      ]);
      return {
        session,
        mtimeMs: Math.max(mainMtime, subMtime),
      };
    }));
    let changed = false;
    for (const { session, mtimeMs } of mtimes) {
      const previousMtime = this.lastMtime.get(session.sessionId);
      if (previousMtime === mtimeMs) {
        // Process exit may write nothing, so re-read while any subagent or background task runs.
        if (this.runningSubagentSessions.has(session.sessionId) || this.pendingSubagentRefresh.has(session.sessionId)
          || this.backgroundTaskSessions.get(session.sessionId)?.some((task) => task.state === "running")) {
          if (await this.observeSubagents(session, false)) changed = true;
          if (!this.runningSubagentSessions.has(session.sessionId)) changed = true;
        }
        continue;
      }
      this.lastMtime.set(session.sessionId, mtimeMs);
      this.lastChangedAt.set(session.sessionId, now);
      session.transcriptMtimeMs = mtimeMs;
      session.lastActivityAt = Math.max(session.lastActivityAt, mtimeMs);
      await this.observeTranscript(session);
      changed = true;
    }
    if (changed) this.catalogValue.observedAt = now;
    return changed;
  }

  private async observeTranscript(session: ObservedClaudeSession): Promise<void> {
    if (!session.transcriptPath) return;
    const result = await parseClaudeTranscriptSnapshot(session.transcriptPath, { limit: 50 });
    this.updateTurnBoundary(session.sessionId, result);
    await this.invalidateFailedPlans(session, result);
    const sessionId = this.sessionAliases.get(session.sessionId) ?? session.sessionId;
    const known = this.knownMessages.get(session.sessionId) ?? new Map<string, string>();
    const knownUsers = this.knownUserMessages.get(session.sessionId) ?? new Map<string, string>();
    // A competing Desktop input can land on a non-terminal branch while Bridge keeps writing.
    for (const message of result.userMessages) {
      const previousText = knownUsers.get(message.id);
      if (previousText === message.text || (previousText === undefined && this.options.eventLog.itemMatches(
        sessionId, "session.observed", message.id, { text: message.text },
      ))) continue;
      // The transcript can precede the SDK's accepted-input echo.
      const bridgeOwned = this.options.eventLog.turnEvidence({ sessionId, messageId: message.id }).submitted;
      if (previousText === undefined && !this.options.eventLog.hasItem(sessionId, "session.observed", message.id) && !bridgeOwned) {
        this.externalWriteVersions.set(
          sessionId,
          this.externalWriteVersion(sessionId) + 1,
        );
      }
      knownUsers.set(message.id, message.text);
      await this.appendObserved(session, message);
    }
    this.knownUserMessages.set(session.sessionId, knownUsers);
    for (const message of result.messages) {
      if (message.role === "user") continue;
      const currentSig = `${message.text}\0${message.interactivePrompt ? JSON.stringify(message.interactivePrompt) : ""}\0${message.taskPlan ? JSON.stringify(message.taskPlan) : ""}`;
      const previousSig = known.get(message.id);
      if (previousSig === currentSig || (previousSig === undefined && this.options.eventLog.itemMatches(
        sessionId, "session.observed", message.id, { text: message.text, interactivePrompt: message.interactivePrompt, taskPlan: message.taskPlan },
      ))) continue;
      known.set(message.id, currentSig);
      await this.appendObserved(session, message);
    }
    this.knownMessages.set(session.sessionId, known);
    await this.observeSubagents(session, false);
    await this.observeEvidence(session);
  }

  private async primeTranscript(session: ObservedClaudeSession): Promise<void> {
    if (!session.transcriptPath) return;
    const result = await parseClaudeTranscriptSnapshot(session.transcriptPath, { limit: 50 });
    this.updateTurnBoundary(session.sessionId, result);
    await this.invalidateFailedPlans(session, result);
    this.knownMessages.set(
      session.sessionId,
      new Map(result.messages.map((message) => [
        message.id,
        `${message.text}\0${message.interactivePrompt ? JSON.stringify(message.interactivePrompt) : ""}\0${message.taskPlan ? JSON.stringify(message.taskPlan) : ""}`,
      ])),
    );
    this.knownUserMessages.set(
      session.sessionId,
      new Map(result.userMessages.map((message) => [message.id, message.text])),
    );
    const sessionId = this.sessionAliases.get(session.sessionId) ?? session.sessionId;
    for (const message of result.messages) {
      if (message.taskPlan && !this.options.eventLog.itemMatches(sessionId, "session.observed", message.id, {
        text: message.text, interactivePrompt: message.interactivePrompt, taskPlan: message.taskPlan,
      })) await this.appendObserved(session, message);
    }
    await this.observeSubagents(session, true);
    await this.observeEvidence(session);
  }

  private async invalidateFailedPlans(session: ObservedClaudeSession, snapshot: Awaited<ReturnType<typeof parseClaudeTranscriptSnapshot>>): Promise<void> {
    const sessionId = this.sessionAliases.get(session.sessionId) ?? session.sessionId;
    for (const id of snapshot.branch?.failedPlanToolUseIds ?? []) {
      const itemId = `plan:${id}`;
      if (!this.options.eventLog.hasItem(sessionId, "session.observed", itemId) ||
        this.options.eventLog.latestItem(sessionId, "session.observed", itemId)?.data.taskPlanInvalidated === true) continue;
      await this.options.eventLog.append({ sessionId, itemId, origin: "claude-desktop", type: "session.observed", data: { taskPlanInvalidated: true } });
    }
  }

  /** Resolves true when the session's background task list changed. */
  private async observeSubagents(session: ObservedClaudeSession, primeOnly: boolean): Promise<boolean> {
    if (!session.transcriptPath) return false;
    const liveSince = oldestLiveProcessStart(session.activeProcesses);
    const subagents = await readClaudeTranscriptSubagents(session.transcriptPath, liveSince);
    const tasks = await readClaudeTranscriptBackgroundTasks(session.transcriptPath, subagents, liveSince);
    const tasksChanged = JSON.stringify(tasks) !== JSON.stringify(this.backgroundTaskSessions.get(session.sessionId) ?? []);
    if (tasks.length) this.backgroundTaskSessions.set(session.sessionId, tasks);
    else this.backgroundTaskSessions.delete(session.sessionId);
    const running = subagents.filter((subagent) => subagent.state === "running");
    if (running.length > 0) {
      this.runningSubagentSessions.set(session.sessionId, {
        count: running.length,
        lastUpdatedAt: Math.max(...running.map((subagent) => subagent.updatedAt)),
      });
    } else {
      this.runningSubagentSessions.delete(session.sessionId);
    }
    this.pendingSubagentRefresh.delete(session.sessionId);
    const sessionId = this.sessionAliases.get(session.sessionId) ?? session.sessionId;
    if (this.hostTaskAuthority.has(sessionId)) return tasksChanged;
    const known = this.knownSubagents.get(session.sessionId) ?? new Map<string, string>();
    for (const subagent of subagents) {
      const itemId = subagent.toolUseId ?? `subagent:${subagent.agentId}`;
      const signature = JSON.stringify({
        state: subagent.state,
        toolCount: subagent.toolCount,
        recentTools: subagent.recentTools,
        latestText: subagent.latestText,
        reportText: subagent.reportText,
      });
      if (known.get(itemId) === signature) continue;
      known.set(itemId, signature);
      if (primeOnly && subagent.state !== "running") {
        // Still owed a terminal event only if the log last saw it running, before a restart.
        const progress = this.options.eventLog.latestItem(sessionId, "tool.progress", itemId);
        const completed = this.options.eventLog.latestItem(sessionId, "tool.completed", itemId);
        if (!progress || (completed && completed.seq > progress.seq)) continue;
      }
      await this.options.eventLog.append({
        sessionId,
        itemId,
        timestamp: subagent.startedAt,
        origin: "claude-desktop",
        type: subagent.state === "running" ? "tool.progress" : "tool.completed",
        data: {
          toolName: "Agent",
          summary: `${subagent.description} (${subagent.toolCount} 步)`,
          subagent,
        },
      });
    }
    this.knownSubagents.set(session.sessionId, known);
    return tasksChanged;
  }

  private updateTurnBoundary(
    sessionId: string,
    snapshot: Awaited<ReturnType<typeof parseClaudeTranscriptSnapshot>>,
  ): void {
    if (snapshot.waitingForUserInput) this.waitingForUserInput.add(sessionId);
    else this.waitingForUserInput.delete(sessionId);
    if (snapshot.pendingBackgroundShellTaskIds?.length) this.pendingBackgroundShellTasks.add(sessionId);
    else this.pendingBackgroundShellTasks.delete(sessionId);
    const lastUserMessage = snapshot.pendingUserMessageId;
    if (lastUserMessage) this.transcriptPendingUserMessages.set(sessionId, lastUserMessage);
    else this.transcriptPendingUserMessages.delete(sessionId);
    if (snapshot.atTurnBoundary === undefined) this.transcriptTurnBoundaries.delete(sessionId);
    else this.transcriptTurnBoundaries.set(sessionId, snapshot.atTurnBoundary);
  }

  private async observeEvidence(session: ObservedClaudeSession): Promise<void> {
    if (!this.options.evidence || !session.transcriptPath) return;
    const existingCursor = this.evidenceCursors.get(session.sessionId);
    const cursor = existingCursor?.path === session.transcriptPath
      ? existingCursor.cursor
      : new ClaudeTranscriptEvidenceCursor();
    this.evidenceCursors.set(session.sessionId, {
      path: session.transcriptPath,
      cursor,
    });
    this.evidenceBackfill.delete(session.sessionId);
    const turns = await cursor.read(session.transcriptPath);
    const sessionId = this.sessionAliases.get(session.sessionId) ?? session.sessionId;
    for (const turn of turns) {
      const tools = turn.tools.filter((tool) => !this.options.eventLog.hasItem(
        sessionId,
        "tool.started",
        tool.id,
      ));
      if (tools.length === 0) continue;
      const evidenceId = `desktop-${createHash("sha256")
        .update(`${session.sessionId}\0${turn.id}`)
        .digest("base64url")
        .slice(0, 32)}`;
      const input: ObservedDesktopEvidence = {
        id: evidenceId,
        sessionId: this.sessionAliases.get(session.sessionId) ?? session.sessionId,
        cwd: session.cwd,
        turnId: turn.id,
        startedAt: turn.startedAt,
        completedAt: turn.completedAt,
        tools,
        paths: turn.paths,
      };
      const signature = createHash("sha256").update(JSON.stringify(input)).digest("base64url");
      if (this.knownEvidence.get(evidenceId) === signature) continue;
      try {
        await this.options.evidence.upsertDesktopEvidence(input);
        this.knownEvidence.set(evidenceId, signature);
      } catch {
        if (!this.evidenceFailureReported) {
          this.evidenceFailureReported = true;
          process.stderr.write("Claude Desktop evidence recovery failed; transcript observation will continue.\n");
        }
      }
    }
  }

  private async backfillEvidence(limit: number): Promise<void> {
    if (!this.options.evidence || this.evidenceBackfill.size === 0) return;
    const sessionIds = [...this.evidenceBackfill].slice(0, limit);
    for (const sessionId of sessionIds) {
      const session = this.catalogValue.sessions.find((candidate) => candidate.sessionId === sessionId);
      if (!session?.transcriptPath) {
        this.evidenceBackfill.delete(sessionId);
        continue;
      }
      await this.observeEvidence(session);
    }
  }

  private async appendObserved(session: ObservedClaudeSession, message: ClaudeHistoryMessage): Promise<void> {
    const type = "session.observed" as const;
    const sessionId = this.sessionAliases.get(session.sessionId) ?? session.sessionId;
    if (
      this.options.eventLog.hasItem(sessionId, "user.message.accepted", message.id) ||
      this.options.eventLog.hasItem(sessionId, "assistant.completed", message.id)
    ) return;
    await this.options.eventLog.append({
      sessionId,
      itemId: message.id,
      timestamp: message.createdAt || Date.now(),
      origin: "claude-desktop",
      type,
      data: {
        role: message.role,
        text: message.text,
        ...(message.interactivePrompt ? { interactivePrompt: message.interactivePrompt } : {}),
        ...(message.taskPlan ? { taskPlan: message.taskPlan } : {}),
      },
    });
  }
}
