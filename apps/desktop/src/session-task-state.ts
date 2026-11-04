import type { BridgeEvent, BridgeHistoryItem, BridgeSubagentSummary } from "@bridge/protocol";
import type { SessionHostBackgroundTask } from "./claude-session-host.js";

interface TaskRecord {
  task?: SessionHostBackgroundTask;
  summary: BridgeSubagentSummary;
  generation?: string;
  source: "host" | "restored";
  origin: BridgeHistoryItem["origin"];
}

interface SessionTasks {
  generation?: string;
  ended: boolean;
  authority: boolean;
  snapshotAt?: number;
  members: Set<string>;
  records: Map<string, TaskRecord>;
}

/** Host facts own live membership; restored and transcript facts only enrich history. */
export class SessionTaskState {
  private readonly sessions = new Map<string, SessionTasks>();

  private session(sessionId: string): SessionTasks {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = { ended: false, authority: false, members: new Set(), records: new Map() };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  private key(summary: BridgeSubagentSummary): string {
    return summary.toolUseId ?? `subagent:${summary.agentId}`;
  }

  private find(session: SessionTasks, id: string, toolUseId?: string): TaskRecord | undefined {
    if (toolUseId) return session.records.get(toolUseId) ?? session.records.get(`subagent:${id}`);
    return session.records.get(id) ?? [...session.records.values()]
      .filter((record) => record.summary.agentId === id)
      .sort((left, right) => right.summary.startedAt - left.summary.startedAt || right.summary.updatedAt - left.summary.updatedAt)[0];
  }

  private summary(task: SessionHostBackgroundTask, previous?: BridgeSubagentSummary): BridgeSubagentSummary {
    const running = task.state === "pending" || task.state === "running" || task.state === "paused";
    const text = task.summary ?? task.error;
    return {
      ...previous,
      agentId: task.taskId,
      ...(task.toolUseId ? { toolUseId: task.toolUseId } : {}),
      ...(task.subagentType ? { agentType: task.subagentType } : {}),
      description: task.description,
      state: running ? "running" : task.state as BridgeSubagentSummary["state"],
      toolCount: task.usage?.toolUses ?? previous?.toolCount ?? 0,
      ...(task.lastToolName ? { recentTools: [task.lastToolName] } : {}),
      ...(text ? running ? { latestText: text } : { reportText: text } : {}),
      startedAt: task.startedAt,
      updatedAt: task.updatedAt,
      ...(task.usage ? { durationMs: task.usage.durationMs }
        : task.completedAt !== undefined ? { durationMs: Math.max(0, task.completedAt - task.startedAt) } : {}),
    };
  }

  restore(sessionId: string, events: readonly BridgeEvent[]): void {
    const session = this.session(sessionId);
    for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
      if (event.sessionId !== sessionId) continue;
      const task = event.data.task as SessionHostBackgroundTask | undefined;
      const savedSummary = event.data.subagent as BridgeSubagentSummary | undefined;
      const summary = task ? this.summary(task, savedSummary) : savedSummary && { ...savedSummary };
      if (!summary) continue;
      if (savedSummary?.state === "unknown") {
        summary.state = "unknown";
        summary.updatedAt = Math.max(summary.updatedAt, savedSummary.updatedAt);
      } else if (summary.state === "running") summary.state = "unknown";
      const previous = this.find(session, summary.agentId, summary.toolUseId);
      if (previous?.source === "host" && previous.generation === session.generation) continue;
      if (previous && previous.summary.updatedAt > summary.updatedAt) continue;
      if (previous) session.records.delete(this.key(previous.summary));
      session.records.set(this.key(summary), {
        ...(task ? { task } : {}), summary: { ...previous?.summary, ...summary }, source: "restored", origin: event.origin,
        ...(typeof event.data.generation === "string" ? { generation: event.data.generation } : {}),
      });
    }
  }

  beginGeneration(sessionId: string, generation: string): void {
    const session = this.session(sessionId);
    if (session.generation === generation) return;
    session.generation = generation;
    session.ended = false;
    session.authority = false;
    delete session.snapshotAt;
    session.members.clear();
    for (const record of session.records.values()) {
      if (record.summary.state === "running") record.summary = { ...record.summary, state: "unknown" };
    }
  }

  hasAuthority(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.authority ?? false;
  }

  update(sessionId: string, generation: string, task: SessionHostBackgroundTask): BridgeSubagentSummary | undefined {
    const session = this.session(sessionId);
    if (session.generation !== generation || session.ended) return undefined;
    const candidate = this.find(session, task.taskId, task.toolUseId);
    const previous = !task.toolUseId && candidate?.summary.toolUseId && task.startedAt > candidate.summary.startedAt
      ? undefined : candidate;
    if (previous?.source === "host" && previous.generation === generation && previous.task && previous.task.updatedAt > task.updatedAt) return undefined;
    const summary = this.summary(task, previous?.summary);
    const key = this.key(summary);
    const background = task.isBackgrounded ?? previous?.task?.isBackgrounded;
    if (summary.state === "running" && background === true && session.snapshotAt !== undefined
      && !session.members.has(key) && !session.members.has(`subagent:${task.taskId}`)) {
      summary.state = "unknown";
    }
    if (session.snapshotAt !== undefined) summary.updatedAt = Math.max(summary.updatedAt, session.snapshotAt);
    if (previous) {
      session.records.delete(this.key(previous.summary));
      if (session.members.delete(this.key(previous.summary)) && summary.state === "running") session.members.add(key);
    }
    session.records.set(key, {
      task: { ...task, ...(background === undefined ? {} : { isBackgrounded: background }) },
      summary, generation, source: "host", origin: "claude-host",
    });
    session.authority = true;
    if (summary.state !== "running") session.members.delete(key);
    else if (session.snapshotAt === undefined || background !== true) session.members.add(key);
    return summary;
  }

  replace(sessionId: string, generation: string, tasks: readonly SessionHostBackgroundTask[], at: number): BridgeSubagentSummary[] {
    const session = this.session(sessionId);
    if (session.generation !== generation || session.ended || (session.snapshotAt !== undefined && session.snapshotAt > at)) return [];
    session.members = new Set([
      ...[...session.records.entries()].filter(([, record]) => record.source === "host" && record.generation === generation
        && record.summary.state === "running" && record.task?.isBackgrounded !== true).map(([key]) => key),
      ...tasks.map((task) => task.toolUseId ?? `subagent:${task.taskId}`),
    ]);
    session.snapshotAt = at;
    const summaries = tasks.flatMap((task) => {
      const summary = this.update(sessionId, generation, { ...task, isBackgrounded: true });
      return summary ? [summary] : [];
    });
    for (const record of session.records.values()) {
      if (record.source !== "host" || record.generation !== generation || record.summary.state !== "running"
        || record.task?.isBackgrounded !== true || session.members.has(this.key(record.summary))) continue;
      record.summary = { ...record.summary, state: "unknown", updatedAt: Math.max(at, record.summary.updatedAt) };
      summaries.push(record.summary);
    }
    session.authority = true;
    return summaries;
  }

  task(sessionId: string, id: string): SessionHostBackgroundTask | undefined {
    const session = this.sessions.get(sessionId);
    const record = session && this.find(session, id);
    return record?.source === "host" && record.generation === session?.generation ? record.task : undefined;
  }

  isRunning(sessionId: string, id: string): boolean {
    const task = this.task(sessionId, id);
    return Boolean(task && this.sessions.get(sessionId)?.members.has(task.toolUseId ?? `subagent:${task.taskId}`)
      && (task.state === "pending" || task.state === "running" || task.state === "paused"));
  }

  runningSubagents(sessionId: string): { count: number; lastUpdatedAt: number } | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    const tasks = [...session.members].flatMap((id) => this.isRunning(sessionId, id) ? [this.task(sessionId, id)!] : []);
    return tasks.length ? { count: tasks.length, lastUpdatedAt: Math.max(...tasks.map((task) => task.updatedAt)) } : undefined;
  }

  /** Only call after process exit is confirmed, never when a stop is merely requested. */
  endGeneration(sessionId: string, generation: string, at: number): BridgeSubagentSummary[] {
    const session = this.session(sessionId);
    if (session.generation !== generation || session.ended) return [];
    const summaries: BridgeSubagentSummary[] = [];
    for (const record of [...session.records.values()]) {
      if (record.source !== "host" || record.generation !== generation || record.summary.state !== "running"
        || !record.task || !session.members.has(this.key(record.summary))) continue;
      summaries.push(this.update(sessionId, generation, {
        ...record.task, state: "stopped", updatedAt: Math.max(at, record.task.updatedAt), completedAt: at,
      })!);
    }
    session.ended = true;
    session.authority = false;
    session.members.clear();
    return summaries;
  }

  mergeSubagents(sessionId: string, observed: readonly BridgeSubagentSummary[]): BridgeSubagentSummary[] {
    const session = this.sessions.get(sessionId);
    const merged = new Map<string, BridgeSubagentSummary>();
    for (const summary of [...observed, ...[...(session?.records.values() ?? [])].map((record) => record.summary)]) {
      const host = session && this.find(session, summary.agentId, summary.toolUseId);
      if (host?.task?.skipTranscript) continue;
      const id = this.key(host?.summary ?? summary);
      const previous = merged.get(id);
      const authoritative = host?.source === "host" && host.generation === session?.generation && !session?.ended;
      let latest = authoritative ? host.summary
        : previous && previous.updatedAt > summary.updatedAt ? previous : summary;
      if (!authoritative && latest.state === "running" && session?.authority && session.snapshotAt !== undefined) {
        latest = { ...latest, state: "unknown", updatedAt: Math.max(latest.updatedAt, session.snapshotAt) };
      }
      const details = latest === summary ? { ...previous, ...summary } : { ...summary, ...previous };
      const recentTools = [latest.recentTools, summary.recentTools, previous?.recentTools].find((tools) => tools?.length);
      // SDK notifications are summaries; keep the full transcript report alongside their state.
      const reportText = [latest.reportText, summary.reportText, previous?.reportText]
        .filter((text): text is string => Boolean(text))
        .sort((left, right) => right.length - left.length)[0];
      merged.set(id, {
        ...details, ...latest, agentId: host?.summary.agentId ?? latest.agentId,
        toolCount: Math.max(previous?.toolCount ?? 0, summary.toolCount, latest.toolCount),
        ...(recentTools ? { recentTools } : {}),
        ...(reportText ? { reportText } : {}),
      });
    }
    return [...merged.values()];
  }

  isInline(sessionId: string, id: string): boolean {
    const session = this.sessions.get(sessionId);
    return !session || this.find(session, id)?.task?.skipTranscript !== true;
  }

  historyItems(sessionId: string, observed: readonly BridgeSubagentSummary[] = []): BridgeHistoryItem[] {
    return this.mergeSubagents(sessionId, observed).map((subagent) => ({
      id: subagent.toolUseId ?? `subagent:${subagent.agentId}`,
      sessionId, role: "tool", toolName: "Agent",
      text: `${subagent.description} (${subagent.toolCount} 步)`,
      ...(subagent.state === "unknown" ? {} : { state: subagent.state === "stopped" ? "interrupted" as const : subagent.state }),
      createdAt: subagent.startedAt,
      origin: this.sessions.get(sessionId)?.records.get(this.key(subagent))?.origin ?? "claude-desktop",
      subagent,
    }));
  }
}
