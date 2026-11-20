import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AssistantAttentionAcknowledgment, AssistantAttentionItem, BridgeMailAttachment, BridgeMailCategory, BridgeMailFolder, MailAttentionLevel } from "../../packages/protocol/src/assistant-mail.js";
import { MailBodyParseError, parseMail } from "./mime.js";
import { MailPageParameters } from "./tool-contract.js";
import { AssistantTriggerStore } from "./trigger-store.js";

export interface AssistantBinding {
  assistantId: string;
  nativeSessionId: string | null;
  sectionId: string | null;
  previousSessionIds: string[];
  managed?: { path: string; policy: string; token: string; automaticDelivery?: boolean };
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
  attention?: MailAttentionLevel | undefined;
  category?: BridgeMailCategory | undefined;
}

interface MailProjection {
  preview: string;
  previewError?: string;
  attachments: BridgeMailAttachment[];
  attachmentCount: number;
}

const unavailablePreview = "原文无法解析，预览不可用。";
const mailOrder = "CASE WHEN historical = 1 THEN -seq ELSE seq END";
const mailFolder = `CASE WHEN user_junk = 1 THEN 'marketing'
  WHEN filing IS NOT NULL THEN replace(filing, 'user:', '')
  WHEN json_extract(analysis_json, '$.category') = 'marketing' THEN 'marketing' ELSE 'inbox' END`;
export type MailPageScope = "all" | "legacy" | BridgeMailFolder | { query: string };

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
  hostRead?: true;
  folder?: BridgeMailCategory;
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
  host_read: number;
  user_junk: number;
  filing: BridgeMailFolder | `user:${BridgeMailFolder}` | null;
  analysis_json: string | null;
  raw_file: string;
  mime_projection: string | null;
  historical: number;
};

function eventFromRow(row: EventRow): MailEvent {
  const analysis = row.analysis_json ? JSON.parse(row.analysis_json) as MailAnalysis : null;
  const folder = row.user_junk === 1 ? "marketing" : row.filing
    ? row.filing.replace(/^user:/u, "") as BridgeMailFolder : analysis?.category === "marketing" ? "marketing" : "inbox";
  return {
    seq: row.historical === 1 ? -row.seq : row.seq, mailRefId: row.mail_ref_id, accountKey: row.account_key,
    mailbox: row.mailbox, uidValidity: row.uid_validity, uid: row.uid,
    subject: row.subject, from: JSON.parse(row.from_json) as MailEvent["from"],
    receivedAt: row.received_at, recordedAt: row.recorded_at,
    processingStatus: row.processing_status,
    ...(row.host_read === 1 ? { hostRead: true as const } : {}),
    ...(folder !== "inbox" ? { folder } : {}),
    analysis,
    ...(row.mime_projection ? JSON.parse(row.mime_projection) as MailProjection : { preview: "", attachments: [], attachmentCount: 0 }),
  };
}

export class AssistantMailStore {
  readonly directory: string;
  private database: DatabaseSync | undefined;
  triggers!: AssistantTriggerStore;

  constructor(private readonly userDataPath: string) {
    this.directory = join(userDataPath, "private", "assistant");
  }

  async initialize(extend?: (database: DatabaseSync) => void): Promise<void> {
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
      CREATE TABLE IF NOT EXISTS imap_history (
        account_key TEXT NOT NULL,
        uid_validity TEXT NOT NULL,
        before_uid INTEGER NOT NULL,
        PRIMARY KEY (account_key, uid_validity)
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
    if (!columns.includes("historical")) this.database.exec("ALTER TABLE mail_events ADD COLUMN historical INTEGER NOT NULL DEFAULT 0");
    if (!columns.includes("host_read")) this.database.exec("ALTER TABLE mail_events ADD COLUMN host_read INTEGER NOT NULL DEFAULT 0");
    if (!columns.includes("user_junk")) this.database.exec("ALTER TABLE mail_events ADD COLUMN user_junk INTEGER NOT NULL DEFAULT 0");
    if (!columns.includes("filing")) this.database.exec("ALTER TABLE mail_events ADD COLUMN filing TEXT");
    this.database.exec(`
      CREATE INDEX IF NOT EXISTS mail_events_page_order ON mail_events (${mailOrder});
      CREATE TABLE IF NOT EXISTS assistant_attention_ack (
        kind TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(kind, id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS assistant_attention_baseline (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1), seq INTEGER NOT NULL
      ) STRICT;
      INSERT OR IGNORE INTO assistant_attention_baseline VALUES (1, (SELECT COALESCE(max(seq), 0) FROM mail_events));
      CREATE TABLE IF NOT EXISTS assistant_attention_replies (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, title TEXT NOT NULL
      ) STRICT;
    `);
    this.triggers = new AssistantTriggerStore(this.database);
    extend?.(this.database);
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

  setAutomaticDelivery(enabled: boolean): void {
    this.db().prepare(`UPDATE assistant_managed_binding SET managed_json =
      json_set(managed_json, '$.automaticDelivery', json(?)) WHERE singleton = 1`).run(JSON.stringify(enabled));
  }

  /** Resume a committed generation, or establish a new baseline when a next UID is available. */
  openMailbox(accountKey: string, uidValidity: string, uidNext: number | undefined): number | undefined {
    const row = this.db().prepare("SELECT uid_validity, last_persisted_uid FROM imap_watermarks WHERE account_key = ? AND mailbox = 'INBOX'")
      .get(accountKey) as { uid_validity: string; last_persisted_uid: number } | undefined;
    if (row?.uid_validity === uidValidity) return row.last_persisted_uid;
    if (uidNext === undefined) return undefined;
    this.db().prepare(`
      INSERT INTO imap_watermarks (account_key, mailbox, uid_validity, last_persisted_uid) VALUES (?, 'INBOX', ?, ?)
      ON CONFLICT(account_key, mailbox) DO UPDATE SET uid_validity = excluded.uid_validity,
        last_persisted_uid = excluded.last_persisted_uid
    `).run(accountKey, uidValidity, uidNext - 1);
    return uidNext - 1;
  }

  historyWindow(accountKey: string, uidValidity: string, lastUid: number) {
    const history = this.db().prepare("SELECT before_uid FROM imap_history WHERE account_key = ? AND uid_validity = ?")
      .get(accountKey, uidValidity) as { before_uid: number } | undefined;
    const cursor = history?.before_uid ?? null;
    const { oldest, imported } = this.db().prepare(`
      SELECT MIN(uid) AS oldest, COALESCE(SUM(historical), 0) AS imported FROM mail_events
      WHERE account_key = ? AND mailbox = 'INBOX' AND uid_validity = ?
    `).get(accountKey, uidValidity) as { oldest: number | null; imported: number };
    // A partial batch may have committed before a connection was lost.
    return { cursor, before: Math.min(cursor ?? lastUid + 1, oldest ?? lastUid + 1), imported };
  }

  finishHistory(accountKey: string, uidValidity: string, before: number): void {
    this.db().prepare(`
      INSERT INTO imap_history (account_key, uid_validity, before_uid) VALUES (?, ?, ?)
      ON CONFLICT(account_key, uid_validity) DO UPDATE SET before_uid = excluded.before_uid
    `).run(accountKey, uidValidity, before);
  }

  async record(message: MailIdentity & Pick<MailEvent, "subject" | "from" | "receivedAt"> & { source: Buffer; historical?: true }): Promise<MailEvent | undefined> {
    if (this.db().prepare("SELECT 1 FROM mail_events WHERE account_key = ? AND mailbox = ? AND uid_validity = ? AND uid = ?")
      .get(message.accountKey, message.mailbox, message.uidValidity, message.uid)) return undefined;
    const mailRefId = randomUUID();
    const rawFile = `${mailRefId}.eml`;
    // No database record can reference a file that is still being written.
    await writeFile(join(this.directory, "raw-mail", rawFile), message.source, { flag: "wx", mode: 0o600 });
    const projection = await projectMail(message.source);
    const recordedAt = Date.now();
    const db = this.db();
    db.exec("BEGIN");
    try {
      const result = db.prepare(`
        INSERT INTO mail_events (mail_ref_id, account_key, mailbox, uid_validity, uid, subject, from_json,
          received_at, recorded_at, raw_file, mime_projection, historical) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(mailRefId, message.accountKey, message.mailbox, message.uidValidity, message.uid, message.subject,
        JSON.stringify(message.from), message.receivedAt, recordedAt, rawFile, JSON.stringify(projection), message.historical ? 1 : 0);
      if (!message.historical) {
        this.triggers.record({ kind: "mail.received", eventId: mailRefId },
          JSON.stringify([message.accountKey, message.mailbox, message.uidValidity, message.uid]), recordedAt);
        const watermark = db.prepare(`
          UPDATE imap_watermarks SET last_persisted_uid = MAX(last_persisted_uid, ?)
          WHERE account_key = ? AND mailbox = ? AND uid_validity = ?
        `).run(message.uid, message.accountKey, message.mailbox, message.uidValidity);
        if (watermark.changes !== 1) throw new Error("Mail watermark generation does not match");
      }
      db.exec("COMMIT");
      return eventFromRow(db.prepare("SELECT * FROM mail_events WHERE seq = ?").get(result.lastInsertRowid) as EventRow);
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  page(input: unknown = {}, includeHistory = true, scope: MailPageScope = "all"): { events: MailEvent[]; nextCursor?: string } {
    const { cursor, limit = 50, processingStatus } = MailPageParameters.parse(input);
    const order = includeHistory ? mailOrder : "seq";
    const scopeValue = typeof scope === "object" ? scope.query : scope === "legacy" || scope === "all" ? undefined : scope;
    const filter = typeof scope === "object" ? `AND (
      instr(lower(subject), lower($scope)) > 0 OR instr(lower(json_extract(mime_projection, '$.preview')), lower($scope)) > 0 OR
      EXISTS (SELECT 1 FROM json_each(from_json) WHERE instr(lower(json_extract(value, '$.name')), lower($scope)) > 0
        OR instr(lower(json_extract(value, '$.address')), lower($scope)) > 0)
    )` : scope === "legacy" ? "AND user_junk = 0" : scope === "all" ? "" : `AND (${mailFolder}) = $scope`;
    const rows = this.db().prepare(`
      SELECT * FROM mail_events WHERE (${order}) < $cursor AND ($status IS NULL OR processing_status = $status)${includeHistory ? "" : " AND historical = 0"}
      ${filter} ORDER BY (${order}) DESC LIMIT $limit
    `).all({ $cursor: cursor ? Number(cursor) : Number.MAX_SAFE_INTEGER, $status: processingStatus ?? null, $limit: limit + 1,
      ...(scopeValue !== undefined ? { $scope: scopeValue } : {}) }) as EventRow[];
    const events = rows.slice(0, limit).map(row => {
      const event = eventFromRow(row);
      return { ...event, attachments: event.attachments.slice(0, 32) };
    });
    return { events, ...(rows.length > limit ? { nextCursor: String(events.at(-1)!.seq) } : {}) };
  }

  folderCounts(includeHistory: boolean): Partial<Record<BridgeMailCategory, number>> {
    return Object.fromEntries(this.db().prepare(`SELECT (${mailFolder}) AS folder, count(*) AS count FROM mail_events
      WHERE (${mailFolder}) <> 'inbox' ${includeHistory ? "" : "AND historical = 0"} GROUP BY folder`)
      .all().map(({ folder, count }) => [folder, count]));
  }

  attention(automatic: boolean, sessionId?: string): AssistantAttentionItem[] {
    const db = this.db();
    const rows = db.prepare(`
      WITH candidates AS (
        SELECT mail_ref_id AS id, subject AS title, seq,
          CASE json_extract(analysis_json, '$.attention')
            WHEN 'ignore' THEN NULL
            WHEN 'action' THEN CASE WHEN resolved.id IS NULL THEN 'action' END
            ELSE CASE WHEN seen.id IS NULL THEN COALESCE(json_extract(analysis_json, '$.attention'), ?) END
          END AS reason
        FROM mail_events
          LEFT JOIN assistant_attention_ack seen ON seen.kind = 'mail' AND seen.id = mail_ref_id
          LEFT JOIN assistant_attention_ack resolved ON resolved.kind = 'mail-action' AND resolved.id = mail_ref_id
        WHERE historical = 0 AND (${mailFolder}) = 'inbox'
          AND (seq > (SELECT seq FROM assistant_attention_baseline) OR json_extract(analysis_json, '$.attention') IS NOT NULL)
      ) SELECT id, title, reason FROM candidates WHERE reason IS NOT NULL ORDER BY seq DESC LIMIT 100
    `).all(automatic ? "unscreened" : "new") as Omit<Extract<AssistantAttentionItem, { kind: "mail" }>, "kind">[];
    const items: AssistantAttentionItem[] = rows.map(row => ({ kind: "mail", ...row }));
    if (sessionId) {
      const replies = db.prepare(`SELECT id, title, session_id AS sessionId FROM assistant_attention_replies
        WHERE session_id = ? AND NOT EXISTS (SELECT 1 FROM assistant_attention_ack WHERE kind = 'reply' AND id = assistant_attention_replies.id)
        ORDER BY rowid DESC LIMIT 100`).all(sessionId) as Omit<Extract<AssistantAttentionItem, { kind: "reply" }>, "kind">[];
      items.push(...replies.map(reply => ({ kind: "reply" as const, ...reply })));
    }
    return items;
  }

  seenCalendarEvents(): Set<string> {
    return new Set(this.db().prepare("SELECT id FROM assistant_attention_ack WHERE kind = 'event'").all().map(row => row.id as string));
  }

  recordReply(sessionId: string, id: string, title: string): boolean {
    return Boolean(this.db().prepare(`INSERT OR IGNORE INTO assistant_attention_replies (id, session_id, title)
      SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM assistant_attention_ack WHERE kind = 'reply' AND id = ?)`).run(id, sessionId, title, id).changes);
  }

  removeReplies(sessionId: string, ids: string[]): boolean {
    return Boolean(this.db().prepare("DELETE FROM assistant_attention_replies WHERE session_id = ? AND id IN (SELECT value FROM json_each(?))")
      .run(sessionId, JSON.stringify(ids)).changes);
  }

  acknowledgeAttention(kind: AssistantAttentionAcknowledgment, id: string): boolean {
    return Boolean(this.db().prepare("INSERT OR IGNORE INTO assistant_attention_ack (kind, id) VALUES (?, ?)").run(kind, id).changes);
  }

  updateAnalysis(mailRefId: string, analysis: MailAnalysis): MailEvent | undefined {
    // The three text fields are replaced; omitted category and attention survive legacy analysis writes.
    const row = this.db().prepare(`UPDATE mail_events SET
      filing = COALESCE(filing, CASE
        WHEN COALESCE(json_extract(analysis_json, '$.category'), $category) = 'marketing' THEN 'marketing'
        WHEN COALESCE(json_extract(analysis_json, '$.category'), $category) IS NOT NULL THEN 'inbox' END),
      analysis_json = json_patch(COALESCE(analysis_json, '{}'), $analysis) WHERE mail_ref_id = $id RETURNING *`)
      .get({ $category: analysis.category ?? null, $analysis: JSON.stringify(analysis), $id: mailRefId }) as EventRow | undefined;
    return row ? eventFromRow(row) : undefined;
  }

  setProcessingStatus(mailRefId: string, status: MailProcessingStatus): MailEvent | undefined {
    const row = this.db().prepare("UPDATE mail_events SET processing_status = ? WHERE mail_ref_id = ? RETURNING *")
      .get(status, mailRefId) as EventRow | undefined;
    return row ? eventFromRow(row) : undefined;
  }

  setJunk(mailRefId: string, junk: boolean): boolean | undefined {
    const db = this.db();
    const row = db.prepare("SELECT user_junk FROM mail_events WHERE mail_ref_id = ?").get(mailRefId);
    if (!row) return undefined;
    if (row.user_junk === Number(junk)) return false;
    db.prepare("UPDATE mail_events SET user_junk = ?, filing = ? WHERE mail_ref_id = ?")
      .run(Number(junk), junk ? "user:marketing" : "user:inbox", mailRefId);
    return true;
  }

  setFolder(mailRefId: string, folder: BridgeMailFolder, source: "user" | "assistant"): boolean | undefined {
    const db = this.db();
    const row = db.prepare("SELECT user_junk, filing FROM mail_events WHERE mail_ref_id = ?")
      .get(mailRefId) as Pick<EventRow, "user_junk" | "filing"> | undefined;
    if (!row) return undefined;
    if (source === "assistant" && (row.user_junk === 1 || row.filing?.startsWith("user:"))) return false;
    const filing = source === "user" ? `user:${folder}` : folder;
    if (row.user_junk === 0 && row.filing === filing) return false;
    db.prepare("UPDATE mail_events SET user_junk = 0, filing = ? WHERE mail_ref_id = ?").run(filing, mailRefId);
    return true;
  }

  markRead(mailRefIds: readonly string[]): number | undefined {
    const db = this.db();
    const refs = [...new Set(mailRefIds)];
    const ids = JSON.stringify(refs);
    const { count } = db.prepare("SELECT COUNT(*) AS count FROM mail_events WHERE mail_ref_id IN (SELECT value FROM json_each(?))")
      .get(ids) as { count: number };
    if (count !== refs.length) return undefined;
    return Number(db.prepare("UPDATE mail_events SET host_read = 1 WHERE host_read = 0 AND mail_ref_id IN (SELECT value FROM json_each(?))")
      .run(ids).changes);
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
      .prepare(`SELECT COUNT(*) AS count FROM mail_events WHERE historical = 0 AND (${mailFolder}) = 'inbox' AND processing_status = 'pending'`)
      .get() as { count: number | bigint } | undefined;
    return Number(row?.count ?? 0);
  }

  close(): void {
    this.database?.close();
    this.database = undefined;
  }
}
