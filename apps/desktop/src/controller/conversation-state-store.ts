import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const STORE_VERSION = 1;

interface SqlRow {
  [key: string]: string | number | bigint | Uint8Array | null;
}

export interface NativeDesktopReceipt {
  idempotencyKey: string;
  commandId: string;
  requestId: string;
  sessionId: string;
  messageId: string;
  displayText?: string;
  queueSettled?: true;
  queueMode?: "deferred" | "steered";
  state: "dispatching" | "submitted" | "session-received" | "queued" | "running" | "completed" | "cancelled" | "uncertain" | "failed";
  error?: string;
}

export interface ConversationStateStoreOptions {
  databasePath: string;
  /** Retained for backwards compatibility; legacy JSON files are never read or migrated. */
  sessionsPath?: string;
  /** Retained for backwards compatibility; legacy JSON files are never read or migrated. */
  queuePath?: string;
  /** Retained for backwards compatibility with older callers. */
  masterSecret?: string;
}

/** SQLite-backed store for session titles and native send receipts. */
export class ConversationStateStore {
  private database: DatabaseSync | undefined;
  private readonly sessionTitles = new Map<string, string>();

  constructor(private readonly options: ConversationStateStoreOptions) {}

  async initialize(): Promise<void> {
    if (this.database) return;
    await mkdir(dirname(this.options.databasePath), { recursive: true });
    const database = new DatabaseSync(this.options.databasePath);
    // Initialize the retained schema and leave retired tables in existing databases in place.
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS native_desktop_receipts (
        idempotency_key TEXT PRIMARY KEY,
        receipt_json TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS conversation_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS session_titles (
        session_id TEXT PRIMARY KEY,
        title TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS session_visibility (
        session_id TEXT PRIMARY KEY,
        visibility TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
    `);
    database.prepare(`
      INSERT INTO conversation_meta(key, value) VALUES ('version', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(String(STORE_VERSION));
    this.database = database;
    for (const row of database.prepare("SELECT session_id, title FROM session_titles").all() as SqlRow[]) {
      this.sessionTitles.set(String(row.session_id), String(row.title));
    }
  }

  close(): void {
    this.database?.close();
    this.database = undefined;
    this.sessionTitles.clear();
  }

  sessionTitle(sessionId: string): string | undefined {
    return this.sessionTitles.get(sessionId);
  }

  setSessionTitle(sessionId: string, title: string): void {
    this.db.prepare(`
      INSERT INTO session_titles(session_id, title) VALUES (?, ?)
      ON CONFLICT(session_id) DO UPDATE SET title = excluded.title
    `).run(sessionId, title);
    this.sessionTitles.set(sessionId, title);
  }

  nativeDesktopReceipt(idempotencyKey: string): NativeDesktopReceipt | undefined {
    const row = this.db.prepare(
      "SELECT receipt_json FROM native_desktop_receipts WHERE idempotency_key = ?",
    ).get(idempotencyKey) as SqlRow | undefined;
    return row ? JSON.parse(String(row.receipt_json)) as NativeDesktopReceipt : undefined;
  }

  listNativeDesktopReceipts(): NativeDesktopReceipt[] {
    return (this.db.prepare(
      "SELECT receipt_json FROM native_desktop_receipts ORDER BY rowid",
    ).all() as SqlRow[]).map((row) => JSON.parse(String(row.receipt_json)) as NativeDesktopReceipt);
  }

  saveNativeDesktopReceipt(receipt: NativeDesktopReceipt): void {
    this.db.prepare(`
      INSERT INTO native_desktop_receipts(idempotency_key, receipt_json) VALUES (?, ?)
      ON CONFLICT(idempotency_key) DO UPDATE SET receipt_json = excluded.receipt_json
    `).run(receipt.idempotencyKey, JSON.stringify(receipt));
  }

  private get db(): DatabaseSync {
    if (!this.database) throw new Error("Conversation state store is not initialized");
    return this.database;
  }
}
