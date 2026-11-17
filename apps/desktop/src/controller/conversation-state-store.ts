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
    // Keep historical table DDL intact so existing desktop databases never fail opening or lose schema continuity.
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

      CREATE TABLE IF NOT EXISTS provider_profiles (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        detail TEXT NOT NULL,
        configured INTEGER NOT NULL,
        local_only_configuration INTEGER NOT NULL,
        read_only INTEGER NOT NULL,
        models_json TEXT NOT NULL,
        default_model TEXT,
        refreshed_at INTEGER
      ) STRICT;

      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        cwd TEXT NOT NULL,
        title TEXT NOT NULL,
        source TEXT NOT NULL,
        active_lane_id TEXT,
        active_provider_profile_id TEXT,
        route_state TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS lanes (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        provider_profile_id TEXT NOT NULL,
        provider_kind TEXT NOT NULL,
        native_session_id TEXT,
        status TEXT NOT NULL,
        access TEXT NOT NULL,
        model TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_used_at INTEGER,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
        FOREIGN KEY (provider_profile_id) REFERENCES provider_profiles(id)
      ) STRICT;

      CREATE UNIQUE INDEX IF NOT EXISTS lanes_provider_native
        ON lanes(provider_profile_id, native_session_id)
        WHERE native_session_id IS NOT NULL;

      CREATE INDEX IF NOT EXISTS lanes_conversation
        ON lanes(conversation_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS handoffs (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        source_lane_id TEXT NOT NULL,
        target_provider_profile_id TEXT NOT NULL,
        target_lane_id TEXT,
        state TEXT NOT NULL,
        summary TEXT NOT NULL,
        package_encrypted BLOB,
        requires_user_confirmation INTEGER NOT NULL,
        candidate_native_ids_json TEXT NOT NULL,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
        FOREIGN KEY (source_lane_id) REFERENCES lanes(id),
        FOREIGN KEY (target_lane_id) REFERENCES lanes(id),
        FOREIGN KEY (target_provider_profile_id) REFERENCES provider_profiles(id)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS handoffs_conversation
        ON handoffs(conversation_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS bridge_sessions (
        session_id TEXT PRIMARY KEY,
        session_json TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS session_configurations (
        session_id TEXT PRIMARY KEY,
        configuration_json TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS turn_queue (
        command_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        lane_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL,
        turn_json TEXT NOT NULL,
        FOREIGN KEY (lane_id) REFERENCES lanes(id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS completed_idempotency_keys (
        idempotency_key TEXT PRIMARY KEY,
        completed_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS terminal_receipts (
        idempotency_key TEXT PRIMARY KEY,
        receipt_json TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS migration_markers (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS runtime_handoffs (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        source_runtime TEXT NOT NULL,
        source_session_id TEXT NOT NULL,
        source_native_session_id TEXT,
        target_runtime TEXT NOT NULL,
        target_session_id TEXT,
        target_native_session_id TEXT,
        objective TEXT NOT NULL,
        summary TEXT NOT NULL,
        plan_text TEXT,
        package_encrypted BLOB,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER
      ) STRICT;

      CREATE INDEX IF NOT EXISTS runtime_handoffs_source
        ON runtime_handoffs(source_session_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS runtime_handoffs_target
        ON runtime_handoffs(target_session_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS runtime_goals (
        session_id TEXT PRIMARY KEY,
        handoff_id TEXT NOT NULL,
        runtime_id TEXT NOT NULL,
        native_session_id TEXT NOT NULL,
        objective TEXT NOT NULL,
        status TEXT NOT NULL,
        native INTEGER NOT NULL,
        continuations INTEGER NOT NULL,
        detail TEXT,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (handoff_id) REFERENCES runtime_handoffs(id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS runtime_session_permissions (
        session_id TEXT PRIMARY KEY,
        permission_mode TEXT NOT NULL,
        updated_at INTEGER NOT NULL
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

      CREATE TABLE IF NOT EXISTS desktop_archive_requests (
        session_id TEXT PRIMARY KEY,
        desktop_session_id TEXT NOT NULL,
        metadata_path TEXT NOT NULL,
        archived INTEGER NOT NULL,
        requested_at INTEGER NOT NULL
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
