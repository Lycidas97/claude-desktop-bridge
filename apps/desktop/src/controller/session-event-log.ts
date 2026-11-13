import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createReadStream } from "node:fs";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { BridgeEvent, BridgeEventType, BridgeOrigin, BridgeSubagentSummary } from "@bridge/protocol";

export interface BridgeEventDraft {
  sessionId?: string;
  turnId?: string;
  itemId?: string;
  timestamp?: number;
  origin: BridgeOrigin;
  type: BridgeEventType;
  data?: Record<string, unknown>;
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

function parseRecord(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    // A partial trailing record can be left by a hard power loss and is ignored.
    return undefined;
  }
}

/** Split v1 index arrays before parsing so a historical first line never becomes one JS value. */
async function* logRecords(path: string): AsyncGenerator<{ value: unknown; fromReceipt: boolean }> {
  let record = "";
  let item = "";
  let depth = 0;
  let quoted = false;
  let escaped = false;
  let array: "items" | "turns" | undefined;
  for await (const chunk of createReadStream(path, { encoding: "utf8" })) {
    for (const character of chunk) {
      if (!array && character === "\n") {
        if (record.trim()) yield { value: parseRecord(record), fromReceipt: false };
        record = "";
        depth = 0;
        quoted = false;
        escaped = false;
        continue;
      }
      if (array && !quoted && depth === 2 && (character === "," || character === "]")) {
        if (array === "items" && item.trim()) yield { value: parseRecord(item), fromReceipt: true };
        item = "";
        if (character === "]") {
          record += "]";
          array = undefined;
          depth -= 1;
        }
        continue;
      }
      if (!array && !quoted && depth === 1 && character === "[") {
        const field = /"(items|turns)"\s*:\s*$/u.exec(record);
        if (field) {
          const header = parseRecord(`${record.slice(0, field.index).replace(/,\s*$/u, "")}}`) as { kind?: string; version?: number } | undefined;
          if (header?.kind === "bridge.receipt-index" && header.version === 1) {
            array = field[1] as "items" | "turns";
            record += "[";
            depth += 1;
            continue;
          }
        }
      }
      if (array === "items") item += character;
      else if (!array) record += character;
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
      } else if (character === '"') quoted = true;
      else if (character === "{" || character === "[") depth += 1;
      else if (character === "}" || character === "]") depth -= 1;
    }
  }
  if (record.trim()) yield { value: parseRecord(record), fromReceipt: false };
}

function eventBytes(event: BridgeEvent): number {
  return Buffer.byteLength(JSON.stringify(event)) + 1;
}

export class SessionEventLog extends EventEmitter {
  private readonly events: BridgeEvent[] = [];
  private readonly windowItems = new Map<string, BridgeEvent>();
  private database: DatabaseSync | undefined;
  private getReceipt: StatementSync | undefined;
  private putReceipt: StatementSync | undefined;
  private readonly pendingDeltas = new Map<string, PendingDelta>();
  private writeQueue: Promise<void> = Promise.resolve();
  private eventsBytes = 0;
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
    await mkdir(dirname(this.path), { recursive: true });
    this.database = new DatabaseSync(`${this.path}.receipts.sqlite`);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS item_receipts (
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        item_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        event_json TEXT NOT NULL,
        PRIMARY KEY (session_id, type, item_id)
      ) STRICT;
    `);
    this.getReceipt = this.database.prepare("SELECT event_json FROM item_receipts WHERE session_id = ? AND type = ? AND item_id = ?");
    this.putReceipt = this.database.prepare(`
      INSERT INTO item_receipts (session_id, type, item_id, seq, event_json) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (session_id, type, item_id) DO UPDATE SET seq = excluded.seq, event_json = excluded.event_json
    `);
    const stats = await stat(this.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (!stats) return;
    let compact = stats.size > this.compactBytes;
    let scanned = 0;
    let batchSize = 0;
    this.database.exec("BEGIN");
    for await (const { value, fromReceipt } of logRecords(this.path)) {
      if (isEvent(value)) {
        this.nextSeq = Math.max(this.nextSeq, value.seq + 1);
        if (!fromReceipt || RECEIPT_ITEM_TYPES.has(value.type)) this.indexEvent(value, fromReceipt);
        if (!fromReceipt) {
          scanned += 1;
          if (compact) {
            if (value.type === "session.desktop-registration" || value.type === "assistant.delta" ||
              value.type === "evidence.started" || value.type === "evidence.updated") continue;
            this.replaceProgress(value);
          }
          this.retainEvent(value, eventBytes(value), compact);
        }
      } else if (value && typeof value === "object") {
        const header = value as { kind?: string; version?: number; lastSeq?: number };
        if (header.kind === "bridge.receipt-index" && (header.version === 1 || header.version === 2) && typeof header.lastSeq === "number") {
          this.nextSeq = Math.max(this.nextSeq, header.lastSeq + 1);
          // Even a small v1 header must be rewritten after its receipts move to SQLite.
          compact ||= header.version === 1;
        }
      }
      if (++batchSize === 1_000) {
        this.database.exec("COMMIT; BEGIN");
        batchSize = 0;
      }
    }
    this.database.exec("COMMIT");
    this.events.sort((left, right) => left.seq - right.seq);
    if (!compact) return;
    const header = { kind: "bridge.receipt-index", version: 2, lastSeq: this.latestSeq() };
    const temporary = `${this.path}.compact-${process.pid}`;
    await writeFile(temporary, `${JSON.stringify(header)}\n${this.events.map((event) => `${JSON.stringify(event)}\n`).join("")}`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, this.path);
    console.warn(
      `[bridge] event log compacted: ${scanned} events / ${Math.round(stats.size / 1_048_576)} MB`
        + ` -> ${this.events.length} events`,
    );
  }

  private receipt(sessionId: string, type: BridgeEventType, itemId: string): BridgeEvent | undefined {
    const row = this.getReceipt?.get(sessionId, type, itemId) as { event_json: string } | undefined;
    return row ? JSON.parse(row.event_json) as BridgeEvent : undefined;
  }

  private indexEvent(event: BridgeEvent, fromReceipt = false): void {
    if (!event.itemId || !RECEIPT_ITEM_TYPES.has(event.type)) return;
    // Generic tool heartbeats update progress without replacing the task's SDK facts.
    if (event.type === "tool.progress" && !event.data.task && !event.data.subagent) {
      const previous = this.receipt(event.sessionId ?? "", event.type, event.itemId);
      const completed = this.receipt(event.sessionId ?? "", "tool.completed", event.itemId);
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
    this.putReceipt!.run(event.sessionId ?? "", event.type, event.itemId, event.seq, JSON.stringify({ ...event, data }));
  }

  private replaceProgress(event: BridgeEvent): void {
    if (!(event.type.startsWith("evidence.") || event.type === "tool.progress" ||
      (event.type === "runtime.updated" && event.itemId === "session:subagent-activity")) || !event.itemId) return;
    for (let index = this.events.length - 1; index >= 0; index -= 1) {
      const candidate = this.events[index]!;
      const sameFamily = event.type.startsWith("evidence.")
        ? candidate.type.startsWith("evidence.")
        : candidate.type === event.type;
      if (sameFamily && candidate.sessionId === event.sessionId && candidate.itemId === event.itemId) {
        const [removed] = this.events.splice(index, 1);
        if (removed) this.forgetEvent(removed);
      }
    }
  }

  private forgetEvent(removed: BridgeEvent): void {
    this.eventsBytes -= eventBytes(removed);
    if (removed.itemId) {
      const key = `${removed.sessionId ?? ""}\u001f${removed.type}\u001f${removed.itemId}`;
      if (this.windowItems.get(key) === removed) this.windowItems.delete(key);
    }
  }

  private retainEvent(event: BridgeEvent, bytes: number, trim: boolean, keepLatest = false): void {
    this.events.push(event);
    this.eventsBytes += bytes;
    if (event.itemId) this.windowItems.set(`${event.sessionId ?? ""}\u001f${event.type}\u001f${event.itemId}`, event);
    if (!trim) return;
    while (this.events.length > Number(keepLatest) && (this.events.length > this.retainEvents || this.eventsBytes > this.retainBytes)) {
      this.forgetEvent(this.events.shift()!);
    }
  }

  latestSeq(): number {
    return this.nextSeq - 1;
  }

  latestItem(sessionId: string, type: BridgeEventType, itemId: string): BridgeEvent | undefined {
    return this.windowItems.get(`${sessionId}\u001f${type}\u001f${itemId}`) ?? this.receipt(sessionId, type, itemId);
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
    this.replaceProgress(event);
    this.indexEvent(event);
    const line = `${JSON.stringify(event)}\n`;
    // Keep the latest append even when that single event exceeds the byte budget.
    this.retainEvent(event, Buffer.byteLength(line), true, true);
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

  async close(): Promise<void> {
    for (const delta of this.pendingDeltas.values()) clearTimeout(delta.timer);
    await this.flushDeltas();
    await this.writeQueue.catch(() => undefined);
    this.database?.close();
    this.database = undefined;
    this.getReceipt = undefined;
    this.putReceipt = undefined;
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
