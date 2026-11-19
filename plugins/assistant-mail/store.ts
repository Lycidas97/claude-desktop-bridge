import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { BridgeMailAttachment } from "../../packages/protocol/src/assistant-mail.js";
import { MailBodyParseError, parseMail } from "./mime.js";
import { MailPageParameters } from "./tool-contract.js";

export interface AssistantBinding {
  assistantId: string;
  nativeSessionId: string | null;
  sectionId: string | null;
  previousSessionIds: string[];
  managed?: { path: string; policy: string; token: string };
}

export interface MailIdentity {
  accountKey: string;
  mailbox: "INBOX";
  uidValidity: string;
  uid: number;
}

export type MailProcessingStatus = "pending" | "processing" | "processed";

export interface MailAnalysis {
  summary: string;
  suggestions: string[];
  questions: string[];
}

interface MailProjection {
  preview: string;
  previewError?: string;
  attachments: BridgeMailAttachment[];
  attachmentCount: number;
}

const unavailablePreview = "原文无法解析，预览不可用。";

function mailProjection({ bodyText, bodyError, attachments, attachmentCount }: Awaited<ReturnType<typeof parseMail>>): MailProjection {
  return { preview: bodyError ? "" : Array.from(bodyText.slice(0, 480)).slice(0, 240).join(""),
    ...(bodyError ? { previewError: unavailablePreview } : {}), attachments, attachmentCount };
}

async function projectMail(source: Parameters<typeof parseMail>[0]): Promise<MailProjection> {
  try {
    return mailProjection(await parseMail(source));
  } catch (error) {
    if (!(error instanceof MailBodyParseError)) throw error;
    return { preview: "", previewError: unavailablePreview, attachments: [], attachmentCount: 0 };
  }
}

export interface MailEvent extends MailIdentity, MailProjection {
  seq: number;
  mailRefId: string;
  subject: string;
  from: Array<{ name?: string | undefined; address?: string | undefined }>;
  receivedAt: string;
  recordedAt: number;
  processingStatus: MailProcessingStatus;
  analysis: MailAnalysis | null;
}

type EventRow = {
  seq: number;
  mail_ref_id: string;
  account_key: string;
  mailbox: "INBOX";
  uid_validity: string;
  uid: number;
  subject: string;
  from_json: string;
  received_at: string;
  recorded_at: number;
  processing_status: MailProcessingStatus;
  analysis_json: string | null;
  raw_file: string;
  mime_projection: string | null;
};

function eventFromRow(row: EventRow): MailEvent {
  return {
    seq: row.seq, mailRefId: row.mail_ref_id, accountKey: row.account_key,
    mailbox: row.mailbox, uidValidity: row.uid_validity, uid: row.uid,
    subject: row.subject, from: JSON.parse(row.from_json) as MailEvent["from"],
    receivedAt: row.received_at, recordedAt: row.recorded_at,
    processingStatus: row.processing_status,
    analysis: row.analysis_json ? JSON.parse(row.analysis_json) as MailAnalysis : null,
    ...(row.mime_projection ? JSON.parse(row.mime_projection) as MailProjection : { preview: "", attachments: [], attachmentCount: 0 }),
  };
}

export class AssistantMailStore {
  readonly directory: string;
  private database: DatabaseSync | undefined;

  constructor(private readonly userDataPath: string) {
    this.directory = join(userDataPath, "private", "assistant");
  }

  async initialize(): Promise<void> {
    for (const directory of [join(this.userDataPath, "private"), this.directory, join(this.directory, "raw-mail")]) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
    }
    const path = join(this.directory, "assistant.sqlite");
    await writeFile(path, "", { flag: "a", mode: 0o600 });
    await chmod(path, 0o600);
    this.database = new DatabaseSync(path);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS assistant_binding (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        assistant_id TEXT NOT NULL,
        native_session_id TEXT,
        section_id TEXT,
        previous_session_ids TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS assistant_managed_binding (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        managed_json TEXT NOT NULL
      ) STRICT;
      CREATE TRIGGER IF NOT EXISTS revoke_assistant_managed_binding
      AFTER UPDATE ON assistant_binding
      BEGIN
        DELETE FROM assistant_managed_binding WHERE singleton = NEW.singleton;
      END;
      CREATE TABLE IF NOT EXISTS imap_watermarks (
        account_key TEXT NOT NULL,
        mailbox TEXT NOT NULL,
        uid_validity TEXT NOT NULL,
        last_persisted_uid INTEGER NOT NULL,
        PRIMARY KEY (account_key, mailbox)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS mail_events (
        seq INTEGER PRIMARY KEY,
        mail_ref_id TEXT NOT NULL UNIQUE,
        account_key TEXT NOT NULL,
        mailbox TEXT NOT NULL,
        uid_validity TEXT NOT NULL,
        uid INTEGER NOT NULL,
        subject TEXT NOT NULL,
        from_json TEXT NOT NULL,
        received_at TEXT NOT NULL,
        recorded_at INTEGER NOT NULL,
        processing_status TEXT NOT NULL DEFAULT 'pending',
        analysis_json TEXT,
        raw_file TEXT NOT NULL,
        UNIQUE (account_key, mailbox, uid_validity, uid)
      ) STRICT;
    `);
    const columns = this.database.prepare("PRAGMA table_info(mail_events)").all().map(column => column.name);
    if (!columns.includes("analysis_json")) {
      this.database.exec("ALTER TABLE mail_events ADD COLUMN analysis_json TEXT");
    }
    if (!columns.includes("mime_projection")) this.database.exec("ALTER TABLE mail_events ADD COLUMN mime_projection TEXT");
  }

  async backfillMimeProjections(signal: AbortSignal): Promise<boolean> {
    const db = this.db();
    const legacyPage = db.prepare("SELECT seq, raw_file FROM mail_events WHERE mime_projection IS NULL AND seq > ? ORDER BY seq LIMIT 100");
    const saveProjection = db.prepare("UPDATE mail_events SET mime_projection = ? WHERE seq = ? AND mime_projection IS NULL");
    let seq = 0;
    while (!signal.aborted) {
      const rows = legacyPage.all(seq) as Array<Pick<EventRow, "seq" | "raw_file">>;
      if (rows.length === 0) break;
      for (const row of rows) {
        const projection = await projectMail(createReadStream(join(this.directory, "raw-mail", row.raw_file), { signal }));
        if (signal.aborted) return false;
        saveProjection.run(JSON.stringify(projection), row.seq);
        seq = row.seq;
      }
    }
    return seq !== 0 && !signal.aborted;
  }

  completeMimeProjection(mailRefId: string, parsed: Awaited<ReturnType<typeof parseMail>>): void {
    this.db().prepare("UPDATE mail_events SET mime_projection = ? WHERE mail_ref_id = ? AND mime_projection IS NULL")
      .run(JSON.stringify(mailProjection(parsed)), mailRefId);
  }

  private db(): DatabaseSync {
    if (!this.database) throw new Error("Assistant mail store is not initialized");
    return this.database;
  }

  binding(): AssistantBinding | undefined {
    const row = this.db().prepare(`
      SELECT binding.*, managed.managed_json FROM assistant_binding binding
      LEFT JOIN assistant_managed_binding managed USING (singleton)
      WHERE binding.singleton = 1
    `).get() as {
      assistant_id: string; native_session_id: string | null; section_id: string | null;
      previous_session_ids: string; managed_json: string | null;
    } | undefined;
    return row ? {
      assistantId: row.assistant_id, nativeSessionId: row.native_session_id,
      sectionId: row.section_id, previousSessionIds: JSON.parse(row.previous_session_ids) as string[],
      ...(row.managed_json ? { managed: JSON.parse(row.managed_json) as NonNullable<AssistantBinding["managed"]> } : {}),
    } : undefined;
  }

  setBinding(binding: AssistantBinding): void {
    const db = this.db();
    db.exec("BEGIN");
    try {
      db.prepare(`
        INSERT INTO assistant_binding VALUES (1, ?, ?, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET assistant_id = excluded.assistant_id,
          native_session_id = excluded.native_session_id, section_id = excluded.section_id,
          previous_session_ids = excluded.previous_session_ids
      `).run(binding.assistantId, binding.nativeSessionId, binding.sectionId, JSON.stringify(binding.previousSessionIds));
      if (binding.managed) {
        db.prepare("INSERT INTO assistant_managed_binding VALUES (1, ?)").run(JSON.stringify(binding.managed));
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  /** A new mailbox generation starts at enable time; an existing one resumes its committed UID. */
  openMailbox(accountKey: string, uidValidity: string, uidNext: number): number {
    const row = this.db().prepare("SELECT uid_validity, last_persisted_uid FROM imap_watermarks WHERE account_key = ? AND mailbox = 'INBOX'")
      .get(accountKey) as { uid_validity: string; last_persisted_uid: number } | undefined;
    if (row?.uid_validity === uidValidity) return row.last_persisted_uid;
    this.db().prepare(`
      INSERT INTO imap_watermarks VALUES (?, 'INBOX', ?, ?)
      ON CONFLICT(account_key, mailbox) DO UPDATE SET uid_validity = excluded.uid_validity,
        last_persisted_uid = excluded.last_persisted_uid
    `).run(accountKey, uidValidity, uidNext - 1);
    return uidNext - 1;
  }

  async record(message: MailIdentity & Pick<MailEvent, "subject" | "from" | "receivedAt"> & { source: Buffer }): Promise<MailEvent | undefined> {
    if (this.db().prepare("SELECT 1 FROM mail_events WHERE account_key = ? AND mailbox = ? AND uid_validity = ? AND uid = ?")
      .get(message.accountKey, message.mailbox, message.uidValidity, message.uid)) return undefined;
    const mailRefId = randomUUID();
    const rawFile = `${mailRefId}.eml`;
    // No database record can reference a file that is still being written.
    await writeFile(join(this.directory, "raw-mail", rawFile), message.source, { flag: "wx", mode: 0o600 });
    const projection = await projectMail(message.source);
    const db = this.db();
    db.exec("BEGIN");
    try {
      const result = db.prepare(`
        INSERT INTO mail_events (mail_ref_id, account_key, mailbox, uid_validity, uid, subject, from_json,
          received_at, recorded_at, raw_file, mime_projection) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(mailRefId, message.accountKey, message.mailbox, message.uidValidity, message.uid, message.subject,
        JSON.stringify(message.from), message.receivedAt, Date.now(), rawFile, JSON.stringify(projection));
      const watermark = db.prepare(`
        UPDATE imap_watermarks SET last_persisted_uid = MAX(last_persisted_uid, ?)
        WHERE account_key = ? AND mailbox = ? AND uid_validity = ?
      `).run(message.uid, message.accountKey, message.mailbox, message.uidValidity);
      if (watermark.changes !== 1) throw new Error("Mail watermark generation does not match");
      db.exec("COMMIT");
      return eventFromRow(db.prepare("SELECT * FROM mail_events WHERE seq = ?").get(result.lastInsertRowid) as EventRow);
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  page(input: unknown = {}): { events: MailEvent[]; nextCursor?: string } {
    const { cursor, limit = 50, processingStatus } = MailPageParameters.parse(input);
    const rows = this.db().prepare(`
      SELECT * FROM mail_events WHERE seq < ? AND (? IS NULL OR processing_status = ?)
      ORDER BY seq DESC LIMIT ?
    `).all(cursor ? Number(cursor) : Number.MAX_SAFE_INTEGER,
      processingStatus ?? null, processingStatus ?? null, limit + 1) as EventRow[];
    const events = rows.slice(0, limit).map(row => {
      const event = eventFromRow(row);
      return { ...event, attachments: event.attachments.slice(0, 32) };
    });
    return { events, ...(rows.length > limit ? { nextCursor: String(events.at(-1)!.seq) } : {}) };
  }

  updateAnalysis(mailRefId: string, analysis: MailAnalysis): MailEvent | undefined {
    const row = this.db().prepare("UPDATE mail_events SET analysis_json = ? WHERE mail_ref_id = ? RETURNING *")
      .get(JSON.stringify(analysis), mailRefId) as EventRow | undefined;
    return row ? eventFromRow(row) : undefined;
  }

  setProcessingStatus(mailRefId: string, status: MailProcessingStatus): MailEvent | undefined {
    const row = this.db().prepare("UPDATE mail_events SET processing_status = ? WHERE mail_ref_id = ? RETURNING *")
      .get(status, mailRefId) as EventRow | undefined;
    return row ? eventFromRow(row) : undefined;
  }

  event(mailRefId: string): MailEvent | undefined {
    const row = this.db().prepare("SELECT * FROM mail_events WHERE mail_ref_id = ?").get(mailRefId) as EventRow | undefined;
    return row && eventFromRow(row);
  }

  stream(mailRefId: string) {
    const row = this.db().prepare("SELECT raw_file FROM mail_events WHERE mail_ref_id = ?").get(mailRefId) as Pick<EventRow, "raw_file"> | undefined;
    return row && createReadStream(join(this.directory, "raw-mail", row.raw_file));
  }

  async read(mailRefId: string): Promise<{ event: MailEvent; source: Buffer } | undefined> {
    const row = this.db().prepare("SELECT * FROM mail_events WHERE mail_ref_id = ?").get(mailRefId) as EventRow | undefined;
    return row ? { event: eventFromRow(row), source: await readFile(join(this.directory, "raw-mail", row.raw_file)) } : undefined;
  }

  unreadCount(): number {
    if (!this.database) return 0;
    const row = this.database
      .prepare("SELECT COUNT(*) AS count FROM mail_events WHERE processing_status = 'pending'")
      .get() as { count: number | bigint } | undefined;
    return Number(row?.count ?? 0);
  }

  close(): void {
    this.database?.close();
    this.database = undefined;
  }
}
