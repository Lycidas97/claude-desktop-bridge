import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import type {
  BridgeEvent,
  BridgeEventType,
  BridgeHistoryItem,
  BridgeHistoryPage,
  BridgeInteractivePrompt,
  BridgeOrigin,
  BridgeSubagentSummary,
  BridgeTaskPlan,
} from "@bridge/protocol";
import { isClaudeTranscriptControlMessage } from "@bridge/protocol";

export interface BridgeEventDraft {
  sessionId?: string;
  turnId?: string;
  itemId?: string;
  timestamp?: number;
  origin: BridgeOrigin;
  type: BridgeEventType;
  data?: Record<string, unknown>;
}

export interface CommandEvidence {
  submitted?: true;
  accepted?: true;
  terminal?: "completed" | "failed" | "cancelled";
  messageId?: string;
}

export interface CommandEvidenceQuery {
  sessionId: string;
  turnId?: string;
  commandId?: string;
  messageId?: string;
}

interface TurnReceipt extends CommandEvidenceQuery, CommandEvidence {
  terminalSeq?: number;
}

interface ReceiptIndex {
  kind: "bridge.receipt-index";
  version: 1;
  lastSeq: number;
  turns: TurnReceipt[];
  items: BridgeEvent[];
}

const RECEIPT_ITEM_TYPES = new Set<BridgeEventType>([
  "session.observed", "user.message.accepted", "assistant.completed",
  "command.output", "command.status", "session.compacted", "session.reset",
  "tool.started", "tool.progress", "tool.completed", "session.desktop-handoff",
]);
const DEDUP_FIELDS = ["text", "interactivePrompt", "taskPlan", "summary"] as const;

function dedupDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value) ?? "undefined").digest("base64url");
}

interface PendingDelta {
  draft: BridgeEventDraft;
  text: string;
  timer: ReturnType<typeof setTimeout>;
}

function isEvent(value: unknown): value is BridgeEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<BridgeEvent>;
  return (
    typeof event.eventId === "string" &&
    typeof event.seq === "number" &&
    typeof event.timestamp === "number" &&
    typeof event.origin === "string" &&
    typeof event.type === "string" &&
    Boolean(event.data) &&
    typeof event.data === "object"
  );
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function historyItem(event: BridgeEvent): BridgeHistoryItem | undefined {
  if (!event.sessionId) return undefined;
  const base = {
    sessionId: event.sessionId,
    ...(event.turnId ? { turnId: event.turnId } : {}),
    createdAt: event.timestamp,
    origin: event.origin,
  };
  if (event.type === "user.message.accepted") {
    const text = textValue(event.data.text);
    const attachments = Array.isArray(event.data.attachments)
      ? event.data.attachments as BridgeHistoryItem["attachments"]
      : undefined;
    if (!text && !attachments?.length) return undefined;
    return {
      ...base,
      id: event.itemId ?? event.eventId,
      role: "user",
      text,
      ...(attachments?.length ? { attachments } : {}),
    };
  }
  if (event.type === "assistant.completed") {
    const text = textValue(event.data.text);
    const interactivePrompt = event.data.interactivePrompt && typeof event.data.interactivePrompt === "object"
      ? event.data.interactivePrompt as BridgeInteractivePrompt
      : undefined;
    const taskPlan = event.data.taskPlan && typeof event.data.taskPlan === "object"
      ? event.data.taskPlan as BridgeTaskPlan
      : undefined;
    if (!text && !interactivePrompt && !taskPlan) return undefined;
    return {
      ...base,
      id: event.itemId ?? event.eventId,
      role: "assistant",
      text,
      ...(interactivePrompt ? { interactivePrompt } : {}),
      ...(taskPlan ? { taskPlan } : {}),
    };
  }
  if (event.type === "command.output" || event.type === "command.status" ||
    event.type === "session.compacted" || event.type === "session.reset") {
    const text = textValue(event.data.text);
    if (!text) return undefined;
    return {
      ...base,
      id: event.itemId ?? event.eventId,
      role: "system",
      text,
    };
  }
  if (event.type === "session.observed") {
    const role = event.data.role;
    const text = textValue(event.data.text);
    const interactivePrompt = event.data.interactivePrompt && typeof event.data.interactivePrompt === "object"
      ? event.data.interactivePrompt as BridgeInteractivePrompt
      : undefined;
    const taskPlan = event.data.taskPlan && typeof event.data.taskPlan === "object"
      ? event.data.taskPlan as BridgeTaskPlan
      : undefined;
    if ((role !== "user" && role !== "assistant") || (!text && !interactivePrompt && !taskPlan)) return undefined;
    if (text && isClaudeTranscriptControlMessage(role, text)) return undefined;
    return {
      ...base,
      id: event.itemId ?? event.eventId,
      role,
      text,
      ...(interactivePrompt ? { interactivePrompt } : {}),
      ...(taskPlan ? { taskPlan } : {}),
    };
  }
  if (event.type === "tool.started" || event.type === "tool.progress") {
    const toolName = textValue(event.data.toolName) || "Tool";
    const subagent = event.data.subagent && typeof event.data.subagent === "object"
      ? event.data.subagent as BridgeSubagentSummary
      : undefined;
    return {
      ...base,
      id: event.itemId ?? event.eventId,
      role: "tool",
      toolName,
      text: textValue(event.data.summary) || textValue(event.data.text) || `${toolName} started`,
      ...(subagent?.state === "unknown" ? {} : { state: "running" as const }),
      ...(subagent ? { subagent } : {}),
    };
  }
  if (event.type === "tool.completed") {
    const toolName = textValue(event.data.toolName) || "Tool";
    const subagent = event.data.subagent && typeof event.data.subagent === "object"
      ? event.data.subagent as BridgeSubagentSummary
      : undefined;
    return {
      ...base,
      id: `${event.itemId ?? event.eventId}:completed`,
      role: "tool",
      toolName,
      text: textValue(event.data.summary) || `${toolName} completed`,
      ...(subagent?.state === "unknown" ? {} : { state: "completed" as const }),
      ...(subagent ? { subagent } : {}),
    };
  }
  if (event.type === "turn.failed") {
    return {
      ...base,
      id: event.eventId,
      role: "system",
      text: textValue(event.data.error) || "Turn failed",
      state: "failed",
    };
  }
  if (event.type === "turn.interrupted") {
    return {
      ...base,
      id: event.eventId,
      role: "system",
      text: "Turn stopped",
      state: "interrupted",
    };
  }
  return undefined;
}

export class SessionEventLog extends EventEmitter {
  private readonly events: BridgeEvent[] = [];
  private readonly itemKeys = new Set<string>();
  private readonly latestItems = new Map<string, BridgeEvent>();
  private readonly itemReceipts = new Map<string, BridgeEvent>();
  private readonly turnReceipts = new Map<string, TurnReceipt>();
  private readonly pendingDeltas = new Map<string, PendingDelta>();
  private writeQueue: Promise<void> = Promise.resolve();
  private nextSeq = 1;
  private initialized = false;
  private readonly compactBytes: number;
  private readonly retainEvents: number;
  private readonly retainBytes: number;

  constructor(
    readonly path: string,
    private readonly deltaWindowMs = 80,
    compaction?: { bytesThreshold?: number; retainEvents?: number; retainBytes?: number },
  ) {
    super();
    this.compactBytes = compaction?.bytesThreshold ?? 2 * 1024 * 1024;
    this.retainEvents = compaction?.retainEvents ?? 5_000;
    this.retainBytes = compaction?.retainBytes ?? 1_536 * 1024;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    const stats = await stat(this.path).catch(() => undefined);
    if (stats && stats.size > this.compactBytes) {
      await this.loadWithCompaction(stats.size);
      return;
    }
    let raw = "";
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // A partial trailing line can be left by a hard power loss and is ignored.
        continue;
      }
      const event = this.loadRecord(parsed);
      if (event) this.events.push(event);
    }
    this.events.sort((left, right) => left.seq - right.seq);
  }

  private loadRecord(value: unknown, compact = false): BridgeEvent | undefined {
    if (isEvent(value)) {
      this.nextSeq = Math.max(this.nextSeq, value.seq + 1);
      this.indexEvent(value, compact);
      return value;
    }
    if (!value || typeof value !== "object") return undefined;
    const index = value as Partial<ReceiptIndex>;
    if (
      index.kind !== "bridge.receipt-index" || index.version !== 1 ||
      typeof index.lastSeq !== "number" || !Array.isArray(index.turns) || !Array.isArray(index.items)
    ) return undefined;
    this.nextSeq = Math.max(this.nextSeq, index.lastSeq + 1);
    for (const receipt of index.turns) {
      if (!receipt || typeof receipt.sessionId !== "string") continue;
      if (receipt.turnId) this.turnReceipts.set(`${receipt.sessionId}\u001fturn:${receipt.turnId}`, receipt);
      if (receipt.commandId) this.turnReceipts.set(`${receipt.sessionId}\u001fcommand:${receipt.commandId}`, receipt);
      if (receipt.messageId) this.turnReceipts.set(`${receipt.sessionId}\u001fmessage:${receipt.messageId}`, receipt);
    }
    for (const item of index.items) {
      if (isEvent(item) && RECEIPT_ITEM_TYPES.has(item.type)) this.indexEvent(item, true, true);
    }
    return undefined;
  }

  private indexEvent(event: BridgeEvent, compact = false, fromReceipt = false): void {
    if (event.itemId) {
      const key = `${event.sessionId ?? ""}\u001f${event.type}\u001f${event.itemId}`;
      if (!compact || RECEIPT_ITEM_TYPES.has(event.type)) this.itemKeys.add(key);
      if (RECEIPT_ITEM_TYPES.has(event.type)) {
        // Generic tool heartbeats update progress without replacing the task's SDK facts.
        if (event.type === "tool.progress" && !event.data.task && !event.data.subagent) {
          const previous = this.itemReceipts.get(key);
          const completed = this.itemReceipts.get(`${event.sessionId ?? ""}\u001ftool.completed\u001f${event.itemId}`);
          if (previous && (!completed || previous.seq > completed.seq)) {
            for (const name of ["task", "subagent", "generation"] as const) {
              if (previous.data[name] !== undefined) event.data[name] = previous.data[name];
            }
          }
        }
        const data: Record<string, unknown> = {};
        for (const name of ["role", "toolName", "task", "generation", "taskPlanInvalidated"] as const) {
          if (event.data[name] !== undefined) data[name] = event.data[name];
        }
        if (event.data.subagent && typeof event.data.subagent === "object") {
          const { latestText: _latestText, reportText: _reportText, ...subagent } = event.data.subagent as BridgeSubagentSummary;
          data.subagent = subagent;
        }
        if (event.type === "session.desktop-handoff") {
          data.state = event.data.state;
          if (event.data.desktopProcesses !== undefined) data.desktopProcesses = event.data.desktopProcesses;
        }
        // Fields used for edit detection persist as fixed-size digests, not transcript payloads.
        if (fromReceipt) {
          if (event.data.dedup) data.dedup = event.data.dedup;
        } else {
          data.dedup = Object.fromEntries(DEDUP_FIELDS.map((name) => [name, dedupDigest(event.data[name])]));
        }
        const item = { ...event, data };
        this.itemReceipts.set(key, item);
        this.latestItems.set(key, compact ? item : event);
      } else if (!compact) {
        this.latestItems.set(key, event);
      }
    }
    if (!event.sessionId) return;
    const submitted = event.type === "turn.started" ||
      (event.type === "message.delivery" && event.data.delivery === "submitted");
    const accepted = event.type === "user.message.accepted" || event.type === "assistant.delta" ||
      event.type === "assistant.completed" || event.type === "tool.started" ||
      event.type === "tool.progress" || event.type === "tool.completed" || event.type === "turn.completed";
    const terminal = event.type === "turn.completed" ? "completed"
      : event.type === "turn.interrupted" ? "cancelled"
        : event.type === "turn.failed" || (event.type === "runtime.error" && event.data.delivery === "failed") ? "failed"
          : undefined;
    if (!submitted && !accepted && !terminal) return;
    const commandId = typeof event.data.commandId === "string" ? event.data.commandId : undefined;
    const messageId = event.type === "user.message.accepted" || (event.type === "message.delivery" && submitted)
      ? textValue(event.data.messageId) || event.itemId
      : undefined;
    const keys = [
      ...(event.turnId ? [`${event.sessionId}\u001fturn:${event.turnId}`] : []),
      ...(commandId ? [`${event.sessionId}\u001fcommand:${commandId}`] : []),
      ...(messageId ? [`${event.sessionId}\u001fmessage:${messageId}`] : []),
    ];
    if (!keys.length) return;
    const existing = [...new Set(keys.map((key) => this.turnReceipts.get(key)).filter((receipt): receipt is TurnReceipt => (
      receipt !== undefined && (!event.turnId || !receipt.turnId || receipt.turnId === event.turnId)
    )))];
    const receipt: TurnReceipt = existing[0] ?? { sessionId: event.sessionId };
    for (const other of existing.slice(1)) {
      if (other.submitted) receipt.submitted = true;
      if (other.accepted) receipt.accepted = true;
      if (other.messageId) receipt.messageId ??= other.messageId;
      if (other.commandId) receipt.commandId ??= other.commandId;
      if (other.turnId) receipt.turnId ??= other.turnId;
      if (other.terminal && other.terminalSeq !== undefined && other.terminalSeq > (receipt.terminalSeq ?? 0)) {
        receipt.terminal = other.terminal;
        receipt.terminalSeq = other.terminalSeq;
      }
      for (const [key, value] of this.turnReceipts) {
        if (value === other) this.turnReceipts.set(key, receipt);
      }
    }
    if (event.turnId) receipt.turnId = event.turnId;
    if (commandId) receipt.commandId = commandId;
    if (messageId) receipt.messageId = messageId;
    if (submitted || accepted) receipt.submitted = true;
    if (accepted) receipt.accepted = true;
    if (terminal && event.seq >= (receipt.terminalSeq ?? 0)) {
      receipt.terminal = terminal;
      receipt.terminalSeq = event.seq;
    }
    for (const key of keys) this.turnReceipts.set(key, receipt);
  }

  /** Compact UI history independently of durable command and task receipts. */
  private async loadWithCompaction(fileBytes: number): Promise<void> {
    const retained: BridgeEvent[] = [];
    let retainedBytes = 0;
    let scanned = 0;
    const reader = createInterface({
      input: createReadStream(this.path, { encoding: "utf8" }),
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    for await (const line of reader) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const event = this.loadRecord(parsed, true);
      if (!event) continue;
      scanned += 1;
      if (
        event.type === "session.desktop-registration" ||
        event.type === "assistant.delta" ||
        event.type === "evidence.started" ||
        event.type === "evidence.updated"
      ) continue;
      if ((event.type.startsWith("evidence.") || event.type === "tool.progress" ||
        (event.type === "runtime.updated" && event.itemId === "session:subagent-activity")) && event.itemId) {
        const previousIndex = retained.findIndex((candidate) => (
          (event.type.startsWith("evidence.") ? candidate.type.startsWith("evidence.") : candidate.type === event.type) &&
          candidate.sessionId === event.sessionId &&
          candidate.itemId === event.itemId
        ));
        if (previousIndex !== -1) {
          const [removed] = retained.splice(previousIndex, 1);
          if (removed) retainedBytes -= Buffer.byteLength(JSON.stringify(removed)) + 1;
        }
      }
      retained.push(event);
      retainedBytes += Buffer.byteLength(JSON.stringify(event)) + 1;
      while (retained.length > this.retainEvents || retainedBytes > this.retainBytes) {
        const removed = retained.shift();
        if (!removed) break;
        retainedBytes -= Buffer.byteLength(JSON.stringify(removed)) + 1;
      }
    }
    const events = retained.sort((left, right) => left.seq - right.seq);
    const index: ReceiptIndex = {
      kind: "bridge.receipt-index",
      version: 1,
      lastSeq: this.latestSeq(),
      turns: [...new Set(this.turnReceipts.values())],
      items: [...this.itemReceipts.values()],
    };
    const temporary = `${this.path}.compact-${process.pid}`;
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(temporary, `${JSON.stringify(index)}\n${events.map((event) => `${JSON.stringify(event)}\n`).join("")}`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, this.path);
    this.latestItems.clear();
    for (const [key, item] of this.itemReceipts) this.latestItems.set(key, item);
    for (const event of events) {
      if (event.itemId) this.latestItems.set(`${event.sessionId ?? ""}\u001f${event.type}\u001f${event.itemId}`, event);
    }
    this.events.push(...events);
    console.warn(
      `[bridge] event log compacted: ${scanned} events / ${Math.round(fileBytes / 1_048_576)} MB`
        + ` -> ${events.length} events`,
    );
  }

  latestSeq(): number {
    return this.nextSeq - 1;
  }

  hasItem(sessionId: string, type: BridgeEventType, itemId: string): boolean {
    return this.itemKeys.has(`${sessionId}\u001f${type}\u001f${itemId}`);
  }

  latestItem(sessionId: string, type: BridgeEventType, itemId: string): BridgeEvent | undefined {
    return this.latestItems.get(`${sessionId}\u001f${type}\u001f${itemId}`);
  }

  itemMatches(sessionId: string, type: BridgeEventType, itemId: string, data: Record<string, unknown>): boolean {
    const item = this.latestItem(sessionId, type, itemId);
    if (!item) return false;
    const digests = item.data.dedup as Record<string, string> | undefined;
    return Object.entries(data).every(([name, value]) => (
      digests?.[name] !== undefined
        ? digests[name] === dedupDigest(value)
        : JSON.stringify(item.data[name]) === JSON.stringify(value)
    ));
  }

  turnEvidence(turn: CommandEvidenceQuery): CommandEvidence {
    const receipt = [
      turn.turnId ? this.turnReceipts.get(`${turn.sessionId}\u001fturn:${turn.turnId}`) : undefined,
      turn.commandId ? this.turnReceipts.get(`${turn.sessionId}\u001fcommand:${turn.commandId}`) : undefined,
      turn.messageId ? this.turnReceipts.get(`${turn.sessionId}\u001fmessage:${turn.messageId}`) : undefined,
    ].find((candidate) => candidate &&
      (!turn.turnId || !candidate.turnId || candidate.turnId === turn.turnId) &&
      (!turn.commandId || !candidate.commandId || candidate.commandId === turn.commandId) &&
      (!turn.messageId || !candidate.messageId || candidate.messageId === turn.messageId));
    const messageId = turn.messageId ?? receipt?.messageId;
    const observed = messageId ? this.latestItem(turn.sessionId, "session.observed", messageId) : undefined;
    const accepted = receipt?.accepted || observed?.data.role === "user";
    return {
      ...(receipt?.submitted || accepted ? { submitted: true } : {}),
      ...(accepted ? { accepted: true } : {}),
      ...(receipt?.terminal ? { terminal: receipt.terminal } : {}),
      ...(messageId ? { messageId } : {}),
    };
  }

  latestDesktopHandoffs(): BridgeEvent[] {
    return [...this.latestItems.values()].filter((event) => event.type === "session.desktop-handoff");
  }

  latestTaskEvents(sessionId: string): BridgeEvent[] {
    const tasks = new Map<string, BridgeEvent>();
    for (const event of this.latestItems.values()) {
      if (event.sessionId !== sessionId || !event.itemId ||
        (event.type !== "tool.progress" && event.type !== "tool.completed") ||
        (!event.data.task && !event.data.subagent)) continue;
      if (event.seq > (tasks.get(event.itemId)?.seq ?? 0)) tasks.set(event.itemId, event);
    }
    return [...tasks.values()].sort((left, right) => left.seq - right.seq);
  }

  isUserMessageSettled(sessionId: string, messageId: string): boolean {
    return Boolean(this.turnEvidence({ sessionId, messageId }).terminal);
  }

  async append(draft: BridgeEventDraft): Promise<BridgeEvent> {
    await this.initialize();
    const event: BridgeEvent = {
      eventId: randomUUID(),
      seq: this.nextSeq++,
      timestamp: draft.timestamp ?? Date.now(),
      origin: draft.origin,
      type: draft.type,
      data: { ...draft.data },
      ...(draft.sessionId ? { sessionId: draft.sessionId } : {}),
      ...(draft.turnId ? { turnId: draft.turnId } : {}),
      ...(draft.itemId ? { itemId: draft.itemId } : {}),
    };
    if ((event.type.startsWith("evidence.") || event.type === "tool.progress" ||
      (event.type === "runtime.updated" && event.itemId === "session:subagent-activity")) && event.itemId) {
      for (let index = this.events.length - 1; index >= 0; index -= 1) {
        const candidate = this.events[index]!;
        const sameFamily = event.type.startsWith("evidence.")
          ? candidate.type.startsWith("evidence.")
          : candidate.type === event.type;
        if (
          sameFamily &&
          candidate.sessionId === event.sessionId &&
          candidate.itemId === event.itemId
        ) {
          this.events.splice(index, 1);
        }
      }
    }
    this.events.push(event);
    this.indexEvent(event);
    const line = `${JSON.stringify(event)}\n`;
    this.writeQueue = this.writeQueue.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(this.path, line, { flag: "a", encoding: "utf8", mode: 0o600 });
    });
    await this.writeQueue;
    this.emit("event", event);
    return event;
  }

  appendCoalescedDelta(draft: BridgeEventDraft, text: string): void {
    if (!draft.sessionId || !draft.itemId || !text) return;
    const key = `${draft.sessionId}\u001f${draft.turnId ?? ""}\u001f${draft.itemId}`;
    const existing = this.pendingDeltas.get(key);
    if (existing) {
      existing.text += text;
      return;
    }
    const pending: PendingDelta = {
      draft,
      text,
      timer: setTimeout(() => {
        void this.flushDelta(key);
      }, this.deltaWindowMs),
    };
    this.pendingDeltas.set(key, pending);
  }

  async flushDeltas(sessionId?: string): Promise<void> {
    const keys = [...this.pendingDeltas.entries()]
      .filter(([, delta]) => !sessionId || delta.draft.sessionId === sessionId)
      .map(([key]) => key);
    await Promise.all(keys.map((key) => this.flushDelta(key)));
  }

  replay(afterSeq = 0, limit = 500, sessionId?: string): BridgeEvent[] {
    return this.events
      .filter((event) => event.seq > afterSeq && (!sessionId || event.sessionId === sessionId))
      .slice(0, Math.max(1, Math.min(limit, 1_000)));
  }

  history(sessionId: string, cursor?: string, limit = 50): BridgeHistoryPage {
    const beforeSeq = cursor ? Number.parseInt(cursor, 10) : Number.POSITIVE_INFINITY;
    const byId = new Map<string, BridgeHistoryItem>();
    for (const event of this.events) {
      if (event.sessionId !== sessionId || event.seq >= beforeSeq) continue;
      if (event.type === "session.observed" && event.data.taskPlanInvalidated === true) {
        if (event.itemId) byId.delete(event.itemId);
        continue;
      }
      const item = historyItem(event);
      if (!item) continue;
      if (item.role === "tool" && item.id.endsWith(":completed")) {
        const baseId = item.id.replace(/:completed$/u, "");
        const started = byId.get(baseId);
        if (started) {
          const mergedToolName = started.toolName || item.toolName;
          const mergedSubagent = item.subagent ?? started.subagent;
          const { state: _startedState, ...startedItem } = started;
          byId.set(baseId, {
            ...startedItem,
            ...(mergedSubagent?.state === "unknown" ? {} : { state: "completed" as const }),
            ...(mergedToolName ? { toolName: mergedToolName } : {}),
            ...(mergedSubagent ? { subagent: mergedSubagent } : {}),
            text: started.text && !started.text.endsWith(" started") ? started.text : item.text,
          });
          continue;
        }
        byId.set(baseId, { ...item, id: baseId });
        continue;
      }
      byId.set(item.id, item);
    }
    const all = [...byId.values()];
    const pageSize = Math.max(1, Math.min(limit, 10_000));
    const items = all.slice(-pageSize);
    const first = items[0];
    const firstEvent = first
      ? this.events.find((event) => (event.itemId ?? event.eventId) === first.id.replace(/:completed$/u, ""))
      : undefined;
    const hasMore = all.length > items.length;
    return {
      sessionId,
      items,
      hasMore,
      ...(hasMore && firstEvent ? { nextCursor: String(firstEvent.seq) } : {}),
    };
  }

  async close(): Promise<void> {
    for (const delta of this.pendingDeltas.values()) clearTimeout(delta.timer);
    await this.flushDeltas();
    await this.writeQueue.catch(() => undefined);
  }

  private async flushDelta(key: string): Promise<void> {
    const pending = this.pendingDeltas.get(key);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingDeltas.delete(key);
    await this.append({
      ...pending.draft,
      type: "assistant.delta",
      data: { ...pending.draft.data, text: pending.text },
    });
  }
}
