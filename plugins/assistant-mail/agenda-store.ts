import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  AgendaDueDay, AgendaEventInput, AgendaPage, AgendaPageQuery, AgendaRecordIdentity, AgendaTodoInput, AgendaWindow,
  BridgeAgendaEvent, BridgeAgendaSource, BridgeAgendaTodo,
} from "../../packages/protocol/src/assistant-agenda.js";
import type { AssistantAttentionItem } from "../../packages/protocol/src/assistant-mail.js";
import { AgendaExpansionLimitError, hasRollingTodoSeries, parseAgendaObject } from "./agenda-ical.js";
import { agendaInstant, collectionZone } from "./agenda-time.js";
import { AssistantError } from "./assistant-error.js";

export const LOCAL_AGENDA_ID = "local";
const todoOrder = "(status IN ('completed', 'cancelled')), COALESCE(due_at, '~'), id";
export type AgendaErrorCode = NonNullable<BridgeAgendaSource["errorCode"]>;
export class AgendaCalendarDataError extends Error {}

type SourceRow = {
  id: string; label: string; url: string | null; user: string | null; credential: Uint8Array | null;
  enabled: number; status: BridgeAgendaSource["status"]; error: AgendaErrorCode | null;
  ctag: string | null; token: string | null; calendar_timezone: string | null; refreshed_at: string | null;
  proposal_create_kinds: string | null;
};
type RecordRow = { id: string; source_id: string; revision: number; value: string };
type RemoteObject = { source_id: string; url: string; href: string; etag: string; data: string; calendar_timezone: string | null };
type Entity = "todos" | "calendar_events";
const objectKey = (...parts: string[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");

function makePage<T>(records: T[], limit: number, key: (record: T) => string): AgendaPage<T> {
  const page = records.slice(0, limit);
  return { records: page, ...(records.length > page.length ? { nextCursor: key(page[page.length - 1]!) } : {}) };
}

// Include civil DATE values while expanding timed recurrences in the device window.
function includeCivilDate(window: AgendaWindow, date: string): AgendaWindow {
  const start = `${date}T00:00:00.000Z`;
  const end = new Date(Date.parse(start) + 86_400_000).toISOString();
  return { from: start < window.from ? start : window.from, to: end > window.to ? end : window.to };
}

export class AgendaStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
    private readonly now = () => Date.now(),
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS assistant_sources (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('local', 'caldav')), label TEXT NOT NULL,
        url TEXT, user TEXT, credential BLOB, enabled INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL, error TEXT, refreshed_at TEXT, ctag TEXT, token TEXT, calendar_timezone TEXT
      ) STRICT;
      INSERT OR IGNORE INTO assistant_sources (id, kind, label, status) VALUES ('local', 'local', '本地', 'ready');
      CREATE TABLE IF NOT EXISTS agenda_caldav_objects (
        source_id TEXT NOT NULL REFERENCES assistant_sources(id) ON DELETE CASCADE,
        href TEXT NOT NULL, etag TEXT NOT NULL, uid TEXT NOT NULL, data TEXT NOT NULL,
        recurring INTEGER NOT NULL, PRIMARY KEY (source_id, href)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS todos (
        id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES assistant_sources(id) ON DELETE CASCADE,
        href TEXT, revision INTEGER NOT NULL, value TEXT NOT NULL,
        status TEXT GENERATED ALWAYS AS (json_extract(value, '$.status')) STORED,
        due_at TEXT GENERATED ALWAYS AS (json_extract(value, '$.dueAt')) STORED
      ) STRICT;
      CREATE INDEX IF NOT EXISTS todo_status_order ON todos (${todoOrder});
      CREATE INDEX IF NOT EXISTS todo_source_href ON todos (source_id, href);
      CREATE TABLE IF NOT EXISTS calendar_events (
        id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES assistant_sources(id) ON DELETE CASCADE,
        href TEXT, revision INTEGER NOT NULL, value TEXT NOT NULL,
        start_at TEXT GENERATED ALWAYS AS (json_extract(value, '$.startAt')) STORED,
        end_at TEXT GENERATED ALWAYS AS (json_extract(value, '$.endAt')) STORED
      ) STRICT;
      CREATE INDEX IF NOT EXISTS event_source_href ON calendar_events (source_id, href);
    `);
    if (!db.prepare("PRAGMA table_info(assistant_sources)").all().some(column => column.name === "calendar_timezone")) {
      db.exec(`
        BEGIN;
        ALTER TABLE assistant_sources ADD COLUMN calendar_timezone TEXT;
        UPDATE agenda_caldav_objects AS object SET recurring = recurring | 2
        WHERE EXISTS (SELECT 1 FROM todos WHERE source_id = object.source_id AND href = object.href);
        COMMIT;
      `);
    }
    if (!db.prepare("PRAGMA table_info(assistant_sources)").all().some(column => column.name === "proposal_create_kinds")) {
      db.exec("ALTER TABLE assistant_sources ADD COLUMN proposal_create_kinds TEXT");
    }
  }

  proposalSources(): { id: string; label: string; kinds: ("todo" | "calendar")[] }[] {
    return this.db.prepare("SELECT id, label, proposal_create_kinds FROM assistant_sources WHERE enabled = 1 ORDER BY kind DESC, label, id").all().flatMap(row => {
      const kinds = row.id === LOCAL_AGENDA_ID ? ["todo", "calendar"] : JSON.parse((row.proposal_create_kinds ?? "[]") as string);
      return kinds.length ? [{ id: row.id as string, label: row.label as string, kinds }] : [];
    });
  }

  sources(): BridgeAgendaSource[] {
    const rows = this.db.prepare("SELECT id, label, enabled, status, error, refreshed_at FROM assistant_sources ORDER BY kind DESC, label, id").all() as Pick<SourceRow, "id" | "label" | "enabled" | "status" | "error" | "refreshed_at">[];
    return rows.map(row => ({
      id: row.id, label: row.label, enabled: Boolean(row.enabled), writable: row.id === LOCAL_AGENDA_ID,
      configurable: row.id !== LOCAL_AGENDA_ID, status: row.status,
      ...(row.error ? { errorCode: row.error } : {}), ...(row.refreshed_at ? { refreshedAt: row.refreshed_at } : {}),
    }));
  }

  source(id: string): SourceRow {
    const row = this.db.prepare("SELECT * FROM assistant_sources WHERE id = ? AND kind = 'caldav'").get(id) as SourceRow | undefined;
    if (!row) throw new AssistantError("NOT_FOUND", "找不到此日历源。");
    return row;
  }

  enabledSourceIds(): string[] {
    return this.db.prepare("SELECT id FROM assistant_sources WHERE kind = 'caldav' AND enabled = 1").all().map(row => row.id as string);
  }

  addSource(input: { url: string; label: string; user: string }, credential: Uint8Array): string {
    const id = objectKey(input.url, input.user);
    if (this.db.prepare("SELECT 1 FROM assistant_sources WHERE id = ?").get(id)) throw new AssistantError("CONFLICT", "此日历源已添加。");
    this.db.prepare(`INSERT INTO assistant_sources (id, kind, label, url, user, credential, status)
      VALUES (?, 'caldav', ?, ?, ?, ?, 'pending')`).run(id, input.label, input.url, input.user, credential);
    return id;
  }

  setCredential(id: string, credential: Uint8Array) {
    this.db.prepare("UPDATE assistant_sources SET credential = ?, error = NULL WHERE id = ?").run(credential, id);
  }

  setEnabled(id: string, enabled: boolean) {
    this.db.prepare("UPDATE assistant_sources SET enabled = ?, status = ?, error = NULL WHERE id = ?").run(Number(enabled), enabled ? "pending" : "disabled", id);
  }

  markError(id: string, error: AgendaErrorCode) {
    this.db.prepare("UPDATE assistant_sources SET status = 'error', error = ? WHERE id = ?").run(error, id);
  }

  removeSource(id: string) {
    this.db.prepare("DELETE FROM assistant_sources WHERE id = ?").run(id);
  }

  knownEtags(id: string): ReadonlyMap<string, string> {
    return new Map(this.db.prepare("SELECT href, etag FROM agenda_caldav_objects WHERE source_id = ?").all(id)
      .map(row => [row.href as string, row.etag as string]));
  }

  applySync(sourceId: string, delta: {
    ctag?: string; syncToken?: string; calendarTimeZone?: string;
    proposalCreateKinds?: ("todo" | "calendar")[];
    removed: string[]; changed: Array<{ href: string; etag: string; data: string }>;
  }): boolean {
    const source = this.source(sourceId);
    const collection = source.url!;
    const timeZone = delta.calendarTimeZone ?? null;
    const changed = [...delta.changed];
    if (timeZone !== source.calendar_timezone) {
      const replaced = new Set([...delta.removed, ...changed.map(item => item.href)]);
      const unchanged = this.db.prepare("SELECT href, etag, data FROM agenda_caldav_objects WHERE source_id = ?")
        .all(sourceId) as typeof changed;
      changed.push(...unchanged.filter(item => !replaced.has(item.href)));
    }
    // Parse all changed objects before replacing anything. A bad resource leaves the previous mirror and token intact.
    let parsed;
    try {
      const zone = collectionZone(timeZone, this.timeZone);
      parsed = changed.map(item => ({ ...item, ...parseAgendaObject(item.data, zone) }));
    } catch (cause) { throw new AgendaCalendarDataError("Invalid calendar data", { cause }); }
    let recordsChanged = parsed.some(item => item.todos.length || item.events.length);
    this.db.exec("BEGIN");
    try {
      for (const href of [...delta.removed, ...parsed.map(item => item.href)]) {
        const todos = this.db.prepare("DELETE FROM todos WHERE source_id = ? AND href = ?").run(sourceId, href);
        const events = this.db.prepare("DELETE FROM calendar_events WHERE source_id = ? AND href = ?").run(sourceId, href);
        if (todos.changes || events.changes) recordsChanged = true;
        this.db.prepare("DELETE FROM agenda_caldav_objects WHERE source_id = ? AND href = ?").run(sourceId, href);
      }
      for (const { href, etag, data, uid, recurring, todos, events } of parsed) {
        this.db.prepare("INSERT INTO agenda_caldav_objects VALUES (?, ?, ?, ?, ?, ?)").run(sourceId, href, etag, uid, data, Number(recurring));
        for (const [table, values] of [["todos", todos], ["calendar_events", events]] as const) {
          const insert = this.db.prepare(`INSERT INTO ${table} (id, source_id, href, revision, value) VALUES (?, ?, ?, ?, ?)`);
          for (const value of values) {
            const id = objectKey(sourceId, href, value.recurrenceId ?? "");
            insert.run(id, sourceId, href, 1, JSON.stringify({ ...value, id, sourceId, collection, uid, resourceHref: href, etag, revision: 1, origin: "untrusted_external" }));
          }
        }
      }
      this.db.prepare("UPDATE assistant_sources SET status = 'ready', error = NULL, ctag = ?, token = ?, calendar_timezone = ?, refreshed_at = ?, proposal_create_kinds = ? WHERE id = ?")
        .run(delta.ctag ?? null, delta.syncToken ?? null, timeZone, new Date(this.now()).toISOString(), JSON.stringify(delta.proposalCreateKinds ?? ["todo", "calendar"]), sourceId);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return recordsChanged;
  }

  saveTodo(value: AgendaTodoInput, existing?: { id: string; revision: number }): BridgeAgendaTodo {
    return this.saveLocal("todos", value, existing);
  }

  saveEvent(value: Omit<AgendaEventInput, "remindAt"> & { remindAt?: string | null | undefined }, existing?: { id: string; revision: number }): BridgeAgendaEvent {
    const { remindAt, ...event } = value;
    const previous = existing && remindAt === undefined ? JSON.parse(this.localRow("calendar_events", existing.id).value) as BridgeAgendaEvent : undefined;
    return this.saveLocal("calendar_events", { ...event, remindAt: remindAt === null ? undefined : remindAt ?? previous?.remindAt, busy: true }, existing);
  }

  completeTodo(input: { id: string; revision: number; completed: boolean }): BridgeAgendaTodo {
    const { id, sourceId, revision, collection, uid, origin, etag, recurrenceId, resourceHref, ...value } = JSON.parse(this.localRow("todos", input.id).value) as BridgeAgendaTodo;
    return this.saveTodo({ ...value, status: input.completed ? "completed" : "pending" }, input);
  }

  proposalRecord(kind: "todo" | "calendar", id: string): BridgeAgendaTodo | BridgeAgendaEvent {
    const row = this.db.prepare(`SELECT value FROM ${kind === "todo" ? "todos" : "calendar_events"} WHERE id = ?`).get(id);
    if (!row) throw new AssistantError("NOT_FOUND", "找不到可修改的单项记录（暂不支持重复实例）。");
    return JSON.parse(row.value as string);
  }

  proposalObject(sourceId: string, href: string) {
    return this.db.prepare("SELECT data, recurring FROM agenda_caldav_objects WHERE source_id = ? AND href = ?").get(sourceId, href) as
      { data: string; recurring: number } | undefined;
  }

  deleteLocalEvent(id: string, revision: number): void {
    if (!this.db.prepare("DELETE FROM calendar_events WHERE id = ? AND revision = ? AND source_id = 'local'").run(id, revision).changes) {
      throw new AssistantError("CONFLICT", "记录已更新或不存在。");
    }
  }

  private localRow(table: Entity, id: string): RecordRow {
    const row = this.db.prepare(`SELECT id, source_id, revision, value FROM ${table} WHERE id = ?`).get(id) as RecordRow | undefined;
    if (!row) throw new AssistantError("NOT_FOUND", "此记录已不存在。");
    if (row.source_id !== LOCAL_AGENDA_ID) throw new AssistantError("UNSUPPORTED", "此数据源只读。");
    return row;
  }

  private saveLocal<T extends AgendaTodoInput | (AgendaEventInput & { busy: boolean })>(table: Entity, value: T, existing?: { id: string; revision: number }): T & AgendaRecordIdentity {
    if (existing) this.localRow(table, existing.id);
    const id = existing?.id ?? randomUUID();
    const revision = (existing?.revision ?? 0) + 1;
    const record = { ...value, id, sourceId: LOCAL_AGENDA_ID, collection: LOCAL_AGENDA_ID, uid: id, revision, origin: "user_local" as const };
    if (existing) {
      const update = this.db.prepare(`UPDATE ${table} SET value = ?, revision = ? WHERE id = ? AND revision = ?`)
        .run(JSON.stringify(record), revision, id, existing.revision);
      if (!update.changes) throw new AssistantError("CONFLICT", "记录已更新，请重新打开后再编辑。");
    } else this.db.prepare(`INSERT INTO ${table} (id, source_id, revision, value) VALUES (?, 'local', 1, ?)`)
      .run(id, JSON.stringify(record));
    return record;
  }

  attention(now: number, seen: ReadonlySet<string>) {
    const items: AssistantAttentionItem[] = [];
    // Use the same one-year horizon as the agenda's recurring task projection.
    let nextAt = now + 86_400_000;
    const window = { from: new Date(now).toISOString(), to: new Date(now + 366 * 86_400_000).toISOString() };
    const todos = this.db.prepare(`SELECT value FROM todos
      WHERE status IN ('pending','in-progress') AND (due_at IS NOT NULL OR json_extract(value, '$.remindAt') IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM agenda_caldav_objects object
        WHERE object.source_id = todos.source_id AND object.href = todos.href AND (object.recurring & 2) != 0)`)
      .all().map(row => JSON.parse(row.value as string) as BridgeAgendaTodo);
    for (const row of this.recurringObjects(2)) {
      try {
        const { uid, todos: records } = parseAgendaObject(row.data, collectionZone(row.calendar_timezone, this.timeZone), {
          todos: { limit: 100, closed: 0, date: "" },
        });
        for (const record of records) if (record.status === "pending" || record.status === "in-progress") {
          todos.push({ ...record, ...this.importedIdentity(row, uid, record.recurrenceId) });
        }
      } catch (error) { if (!(error instanceof AgendaExpansionLimitError)) throw error; }
    }
    for (const { id, title, dueAt, remindAt } of todos) {
      const at = Math.min(dueAt ? agendaInstant(dueAt, this.timeZone) : Infinity, remindAt ? agendaInstant(remindAt, this.timeZone) : Infinity);
      if (at <= now) items.push({ kind: "todo", id, title });
      else nextAt = Math.min(nextAt, at);
    }

    const events = this.db.prepare(`SELECT value FROM calendar_events WHERE href IS NULL AND json_extract(value, '$.remindAt') IS NOT NULL`)
      .all().map(row => JSON.parse(row.value as string) as BridgeAgendaEvent);
    // Read the original iCalendar data: stored projections created before reminders omit VALARM.
    const remote = this.db.prepare(`SELECT object.source_id, object.href, object.etag, object.data, source.url, source.calendar_timezone
      FROM agenda_caldav_objects object JOIN assistant_sources source ON source.id = object.source_id
      WHERE object.data LIKE '%BEGIN:VALARM%'`).iterate() as Iterable<RemoteObject>;
    // Dense recurrences can exceed the annual expansion budget. At least scan until the next daily refresh.
    const today = { from: window.from, to: new Date(now + 86_400_000).toISOString() };
    for (const row of remote) {
      const zone = collectionZone(row.calendar_timezone, this.timeZone);
      for (const range of [window, today]) {
        try {
          const { uid, events: records } = parseAgendaObject(row.data, zone, { window: range, allDayZone: this.timeZone });
          for (const record of records) if (record.remindAt) events.push({ ...record, ...this.importedIdentity(row, uid, record.recurrenceId) });
          break;
        } catch (error) { if (!(error instanceof AgendaExpansionLimitError)) throw error; }
      }
    }
    for (const event of events) {
      const end = this.eventEnd(event);
      if (end <= now || !event.remindAt) continue;
      // A rescheduled occurrence may be a different reminder even when its event ID is unchanged.
      const id = `${event.id}:${event.remindAt}`;
      if (seen.has(id)) continue;
      const at = agendaInstant(event.remindAt, event.timeZone);
      if (at >= end) continue;
      if (at <= now) {
        items.push({ kind: "event", id, title: event.title, startAt: event.startAt });
        nextAt = Math.min(nextAt, end);
      } else nextAt = Math.min(nextAt, at);
    }
    return { items: items.slice(0, 100), nextAt };
  }

  listTodos(query: AgendaPageQuery & { status?: AgendaTodoInput["status"] | undefined; dueOn?: AgendaDueDay | undefined }): AgendaPage<BridgeAgendaTodo> {
    const limit = query.limit ?? 50;
    const [closed = "0", date = "", id = ""] = query.cursor?.split("|") ?? [];
    const window = query.dueOn;
    const day = window?.date;
    const recurrenceWindow = window && includeCivilDate(window, window.date);
    const rows = this.db.prepare(`SELECT value FROM todos WHERE (? IS NULL OR status = ?) AND (${todoOrder}) > (?, ?, ?)
      AND (? IS NULL OR due_at = ? OR (length(due_at) > 10 AND due_at >= ? AND due_at < ?))
      AND NOT EXISTS (SELECT 1 FROM agenda_caldav_objects object
        WHERE object.source_id = todos.source_id AND object.href = todos.href AND (object.recurring & 2) != 0)
      ORDER BY ${todoOrder} LIMIT ?`).all(query.status ?? null, query.status ?? null, Number(closed), date, id,
        day ?? null, day ?? null, window?.from ?? null, window?.to ?? null, limit + 1);
    // NUL sorts before the time suffix, matching SQLite's date-only vs date-time ordering.
    const key = (record: BridgeAgendaTodo) => [Number(record.status === "completed" || record.status === "cancelled"), record.dueAt ?? "~", record.id].join("\0");
    const cursor = [closed, date, id].join("\0");
    const entries = rows.map(row => JSON.parse(row.value as string) as BridgeAgendaTodo).map(record => ({ record, key: key(record) }));
    let incomplete = false;
    const now = this.now();
    for (const row of this.recurringObjects(2)) {
      try {
        const { uid, todos } = parseAgendaObject(row.data, collectionZone(row.calendar_timezone, this.timeZone), {
          todos: { limit, closed: Number(closed), date, window: recurrenceWindow, now },
        });
        for (const todo of todos) {
          if (query.status && todo.status !== query.status) continue;
          if (window && !(todo.dueAt === day || todo.dueAt && todo.dueAt.length > 10 && todo.dueAt >= window.from && todo.dueAt < window.to)) continue;
          const record = { ...todo, ...this.importedIdentity(row, uid, todo.recurrenceId) };
          const order = key(record);
          if (order > cursor) entries.push({ record, key: order });
        }
      } catch (error) {
        if (!(error instanceof AgendaExpansionLimitError)) throw error;
        incomplete = true;
      }
    }
    entries.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    const page = makePage(entries, limit, entry => entry.key.replaceAll("\0", "|"));
    return { ...page, records: page.records.map(entry => entry.record), ...(incomplete ? { incomplete: true } : {}) };
  }

  listEvents(query: AgendaPageQuery & AgendaWindow & { allDayOn?: string | undefined }): AgendaPage<BridgeAgendaEvent> {
    const limit = query.limit ?? 50;
    const key = (record: BridgeAgendaEvent) => `${new Date(this.eventStart(record)).toISOString()}|${record.id}`;
    const { records, incomplete } = this.eventsIn(query, { allowIncomplete: true });
    return { ...makePage(records.filter(record => !query.cursor || key(record) > query.cursor), limit, key), ...(incomplete ? { incomplete: true } : {}) };
  }

  private eventStart(event: BridgeAgendaEvent) {
    return agendaInstant(event.startAt, event.allDay && event.origin === "untrusted_external" ? this.timeZone : event.timeZone);
  }

  private eventEnd(event: BridgeAgendaEvent) {
    return agendaInstant(event.endAt, event.allDay && event.origin === "untrusted_external" ? this.timeZone : event.timeZone);
  }

  private eventsIn(window: AgendaWindow & { allDayOn?: string | undefined }, options?: { allowIncomplete: true }) {
    const { allDayOn } = window;
    const from = Date.parse(window.from), to = Date.parse(window.to);
    const expansion = allDayOn ? includeCivilDate(window, allDayOn) : window;
    const rows = this.db.prepare(`SELECT event.value FROM calendar_events event
      LEFT JOIN agenda_caldav_objects object ON object.source_id = event.source_id AND object.href = event.href
      WHERE (COALESCE(object.recurring, 0) & 1) = 0 AND event.start_at < ? AND event.end_at >= ?`)
      .all(new Date(Date.parse(expansion.to) + 86_400_000).toISOString(), new Date(Date.parse(expansion.from) - 86_400_000).toISOString().slice(0, 10));
    const records = rows.map(row => JSON.parse(row.value as string) as BridgeAgendaEvent);
    let incomplete = false;
    for (const row of this.recurringObjects(1)) {
      try {
        const { uid, events } = parseAgendaObject(row.data, collectionZone(row.calendar_timezone, this.timeZone), {
          window: expansion, allDayZone: allDayOn ? "UTC" : this.timeZone,
        });
        for (const event of events) records.push({ ...event, ...this.importedIdentity(row, uid, event.recurrenceId) });
      } catch (error) {
        if (!options?.allowIncomplete || !(error instanceof AgendaExpansionLimitError)) throw error;
        incomplete = true;
      }
    }
    return {
      records: records.filter(event => {
        if (allDayOn && event.allDay) return event.startAt <= allDayOn && allDayOn < event.endAt;
        const start = this.eventStart(event), end = this.eventEnd(event);
        return start < to && (end > from || start === end && start >= from);
      })
        .sort((a, b) => this.eventStart(a) - this.eventStart(b) || a.id.localeCompare(b.id)),
      incomplete,
    };
  }

  hasRollingTodos(): boolean {
    for (const { data } of this.recurringObjects(2)) if (hasRollingTodoSeries(data)) return true;
    return false;
  }

  private recurringObjects(kind: 1 | 2) {
    return this.db.prepare(`SELECT object.source_id, object.href, object.etag, object.data, source.url, source.calendar_timezone
      FROM agenda_caldav_objects object JOIN assistant_sources source ON source.id = object.source_id
      WHERE (object.recurring & ?) != 0`).iterate(kind) as Iterable<RemoteObject>;
  }

  private importedIdentity(row: RemoteObject, uid: string, recurrenceId: string | undefined): AgendaRecordIdentity {
    return {
      id: objectKey(row.source_id, row.href, recurrenceId ?? ""), sourceId: row.source_id, collection: row.url,
      uid, resourceHref: row.href, etag: row.etag, revision: 1, origin: "untrusted_external",
    };
  }

  freeSlots(query: AgendaWindow & { durationMinutes: number }) {
    let next = Date.parse(query.from);
    const end = Date.parse(query.to);
    const duration = query.durationMinutes * 60_000;
    const slots: Array<{ from: string; to: string }> = [];
    for (const event of this.eventsIn(query).records) {
      if (!event.busy || this.eventEnd(event) <= this.eventStart(event)) continue;
      const start = this.eventStart(event);
      if (start - next >= duration) slots.push({ from: new Date(next).toISOString(), to: new Date(start).toISOString() });
      next = Math.max(next, this.eventEnd(event));
    }
    if (end - next >= duration) slots.push({ from: new Date(next).toISOString(), to: query.to });
    return { slots: slots.slice(0, 100), truncated: slots.length > 100 };
  }
}
