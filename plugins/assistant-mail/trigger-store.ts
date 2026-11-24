import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ASSISTANT_MEMORY_POLICY, ASSISTANT_WORKSPACE_POLICY, type AssistantTriggerKind } from "../../packages/protocol/src/assistant-mail.js";

export interface TriggerEventRef {
  kind: AssistantTriggerKind;
  eventId: string;
}

export interface TriggerBatch {
  batchId: string;
  nativeSessionId: string;
  idempotencyKey: string;
  readyAt: number;
  attemptedAt: number | null;
  commandId: string | null;
}

const batchColumns = `batch_id AS batchId, native_session_id AS nativeSessionId, idempotency_key AS idempotencyKey,
  ready_at AS readyAt, attempted_at AS attemptedAt, command_id AS commandId`;
const MAX_BATCH_EVENTS = 32;
export const ASSISTANT_TRIGGER_KEY_PREFIX = "assistant-trigger/";

/** The mail store shares this connection so forward receipt, watermark and trigger commit together. */
export class AssistantTriggerStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS trigger_batches (
        batch_id TEXT PRIMARY KEY, native_session_id TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
        ready_at INTEGER NOT NULL, attempted_at INTEGER, command_id TEXT, message_id TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS trigger_batch_pending ON trigger_batches(native_session_id, ready_at) WHERE command_id IS NULL;
      CREATE TABLE IF NOT EXISTS trigger_deliveries (
        seq INTEGER PRIMARY KEY, kind TEXT NOT NULL, event_id TEXT NOT NULL,
        source_key TEXT NOT NULL, batch_id TEXT NOT NULL REFERENCES trigger_batches(batch_id),
        UNIQUE(kind, source_key), UNIQUE(kind, event_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS trigger_delivery_batch ON trigger_deliveries(batch_id, seq);
    `);
  }

  /** Call inside the producer's business transaction, with host-issued event IDs only. */
  record(event: TriggerEventRef, sourceKey: string, recordedAt: number): void {
    const binding = this.db.prepare(`
      SELECT native_session_id AS sessionId FROM assistant_binding JOIN assistant_managed_binding USING (singleton)
      WHERE native_session_id IS NOT NULL AND json_extract(managed_json, '$.policy') IN (?, ?)
        AND json_extract(managed_json, '$.automaticDelivery') = 1
    `).get(ASSISTANT_WORKSPACE_POLICY, ASSISTANT_MEMORY_POLICY) as { sessionId: string } | undefined;
    if (!binding || this.db.prepare("SELECT 1 FROM trigger_deliveries WHERE kind = ? AND source_key = ?").get(event.kind, sourceKey)) return;
    const open = this.db.prepare(`
      SELECT batch_id AS batchId FROM trigger_batches WHERE native_session_id = ? AND command_id IS NULL
        AND attempted_at IS NULL AND ready_at > ?
        AND (SELECT count(*) FROM trigger_deliveries d WHERE d.batch_id = trigger_batches.batch_id) < ?
      ORDER BY rowid DESC LIMIT 1
    `).get(binding.sessionId, recordedAt, MAX_BATCH_EVENTS) as { batchId: string } | undefined;
    const batchId = open?.batchId ?? randomUUID();
    if (!open) this.db.prepare("INSERT INTO trigger_batches (batch_id, native_session_id, idempotency_key, ready_at) VALUES (?, ?, ?, ?)")
      .run(batchId, binding.sessionId, `${ASSISTANT_TRIGGER_KEY_PREFIX}${batchId}`, recordedAt + 3_000);
    this.db.prepare("INSERT INTO trigger_deliveries (kind, event_id, source_key, batch_id) VALUES (?, ?, ?, ?)")
      .run(event.kind, event.eventId, sourceKey, batchId);
  }

  nextPending(sessionId: string): TriggerBatch | undefined {
    return this.db.prepare(`SELECT ${batchColumns} FROM trigger_batches WHERE native_session_id = ? AND command_id IS NULL ORDER BY ready_at, rowid LIMIT 1`)
      .get(sessionId) as unknown as TriggerBatch | undefined;
  }

  interrupted(): TriggerBatch[] {
    return this.db.prepare(`SELECT ${batchColumns} FROM trigger_batches WHERE attempted_at IS NOT NULL AND command_id IS NULL`).all() as unknown as TriggerBatch[];
  }

  batch(batchId: string): TriggerBatch | undefined {
    return this.db.prepare(`SELECT ${batchColumns} FROM trigger_batches WHERE batch_id = ?`).get(batchId) as unknown as TriggerBatch | undefined;
  }

  batchForEvent(kind: AssistantTriggerKind, eventId: string): TriggerBatch | undefined {
    return this.db.prepare(`SELECT ${batchColumns} FROM trigger_batches WHERE batch_id = (
      SELECT batch_id FROM trigger_deliveries WHERE kind = ? AND event_id = ?
    )`).get(kind, eventId) as unknown as TriggerBatch | undefined;
  }

  refs(batchId: string): TriggerEventRef[] {
    return this.db.prepare("SELECT kind, event_id AS eventId FROM trigger_deliveries WHERE batch_id = ? ORDER BY seq")
      .all(batchId) as unknown as TriggerEventRef[];
  }

  markSubmitting(batchId: string, now: number): void {
    this.db.prepare("UPDATE trigger_batches SET attempted_at = ? WHERE batch_id = ? AND attempted_at IS NULL").run(now, batchId);
  }

  link(batchId: string, receipt: { commandId: string; messageId: string }): void {
    this.db.prepare(`UPDATE trigger_batches SET command_id = ?, message_id = ? WHERE batch_id = ? AND
      (command_id IS NOT ? OR message_id IS NOT ?)`).run(receipt.commandId, receipt.messageId, batchId, receipt.commandId, receipt.messageId);
  }

  countProcessedMail(sessionId: string, since: number): number {
    const row = this.db.prepare(`
      SELECT count(*) AS count FROM mail_events m
      JOIN trigger_deliveries d ON d.kind = 'mail.received' AND d.event_id = m.mail_ref_id
      JOIN trigger_batches b USING (batch_id)
      WHERE b.native_session_id = ? AND m.recorded_at >= ? AND m.processing_status = 'processed'
    `).get(sessionId, since) as { count: number };
    return row.count;
  }

  unfinished(sessionId: string, cursor = Number.MAX_SAFE_INTEGER) {
    const rows = this.db.prepare(`
      SELECT d.seq, d.kind, d.event_id AS eventId, b.batch_id AS batchId FROM trigger_deliveries d
      JOIN trigger_batches b USING (batch_id) LEFT JOIN mail_events m ON d.kind = 'mail.received' AND d.event_id = m.mail_ref_id
      WHERE b.native_session_id = ? AND d.seq < ? AND (m.processing_status IS NULL OR m.processing_status <> 'processed')
      ORDER BY d.seq DESC LIMIT 101
    `).all(sessionId, cursor) as unknown as Array<TriggerEventRef & { batchId: string; seq: number }>;
    return { refs: rows.slice(0, 100).map(({ seq: _seq, ...ref }) => ref),
      ...(rows.length > 100 ? { nextCursor: rows[99]!.seq } : {}),
    };
  }
}
