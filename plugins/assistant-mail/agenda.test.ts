import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test, vi } from "vitest";
import { AssistantAgendaService } from "./agenda.js";
import { AgendaStore } from "./agenda-store.js";
import { CalDavError } from "./caldav.js";
import { AssistantMailService } from "./desktop.js";

const closers: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

function testStore() {
  const database = new DatabaseSync(":memory:");
  closers.push(() => database.close());
  return new AgendaStore(database, "America/Los_Angeles");
}

const wrap = (...lines: string[]) => ["BEGIN:VCALENDAR", "VERSION:2.0", ...lines, "END:VCALENDAR", ""].join("\r\n");
const url = "https://example.test/cal/";
const source = { url, label: "Shared calendar", user: "user" };
const object = (name: string, data: string, etag = '\"1\"') => ({ href: `${url}${name}.ics`, data, etag });
const todo = object("todo", wrap("BEGIN:VTODO", "UID:todo1", "SUMMARY:外部待办", "DESCRIPTION:来自外部的内容", "DTSTART:20270101T170000Z",
  "DUE:20270101T190000Z", "STATUS:IN-PROCESS", "PRIORITY:2", "BEGIN:VALARM", "TRIGGER;RELATED=END:-PT15M", "ACTION:DISPLAY", "DESCRIPTION:Reminder", "END:VALARM", "END:VTODO"));
const calendar = object("event", wrap(
  "BEGIN:VEVENT", "UID:meeting", "SUMMARY:Daily", "DTSTART;TZID=America/Los_Angeles:20270313T090000", "DTEND;TZID=America/Los_Angeles:20270313T100000",
  "RRULE:FREQ=DAILY;COUNT=4", "EXDATE;TZID=America/Los_Angeles:20270314T090000", "END:VEVENT",
  "BEGIN:VEVENT", "UID:meeting", "RECURRENCE-ID;TZID=America/Los_Angeles:20270315T090000", "SUMMARY:Moved",
  "DTSTART;TZID=America/Los_Angeles:20270315T110000", "DTEND;TZID=America/Los_Angeles:20270315T120000", "END:VEVENT"));

test("local records survive assistant restart, support paging, and reject stale edit versions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bridge-agenda-"));
  let store!: AgendaStore;
  const mail = new AssistantMailService({ userDataPath: directory });
  await mail.initialize(database => { store = new AgendaStore(database, "UTC"); });
  try {
    const task = store.saveTodo({ title: "First", status: "pending", dueAt: "2027-01-02" });
    store.saveTodo({ title: "Later", status: "pending" });
    store.saveTodo({ title: "Cancelled", status: "cancelled", dueAt: "2027-01-01" });
    store.completeTodo({ id: task.id, revision: task.revision, completed: true });
    expect(() => store.saveTodo({ title: "Stale", status: "pending" }, task)).toThrow(expect.objectContaining({ code: "CONFLICT" }));
    store.saveEvent({ title: "All day", startAt: "2027-01-02", endAt: "2027-01-03", allDay: true, timeZone: "UTC" });
  } finally { await mail.close(); }
  const restarted = new AssistantMailService({ userDataPath: directory });
  closers.push(() => restarted.close());
  await restarted.initialize(database => { store = new AgendaStore(database, "UTC"); });
  const page = store.listTodos({ limit: 1 });
  expect(page.records).toMatchObject([{ title: "Later", status: "pending" }]);
  expect(store.listTodos({ cursor: page.nextCursor }).records).toMatchObject([
    { title: "Cancelled", status: "cancelled" },
    { title: "First", status: "completed", revision: 2, sourceId: "local" },
  ]);
  expect(store.listEvents({ from: "2027-01-02T00:00:00.000Z", to: "2027-01-03T00:00:00.000Z" }).records)
    .toMatchObject([{ title: "All day", startAt: "2027-01-02", allDay: true }]);
});

test("pages a device day's dated todos before unrelated tasks can consume the page", () => {
  const store = testStore();
  for (let index = 0; index < 51; index++) store.saveTodo({ title: `Old task ${index}`, status: "pending", dueAt: "2027-03-13" });
  for (const [title, dueAt] of [
    ["Before", "2027-03-14T07:59:59.999Z"], ["Start", "2027-03-14T08:00:00.000Z"],
    ["Last", "2027-03-15T06:59:59.999Z"], ["After", "2027-03-15T07:00:00.000Z"],
    ["Date only", "2027-03-14"], ["Undated", undefined],
  ] as const) store.saveTodo({ title, dueAt, status: title === "Last" ? "completed" : "pending" });
  const dueOn = { date: "2027-03-14", timeZone: "America/Los_Angeles" };
  const first = store.listTodos({ dueOn, limit: 2 });
  expect(first.records.map(record => record.title)).toEqual(["Date only", "Start"]);
  expect(first.nextCursor).toBeDefined();
  expect(store.listTodos({ dueOn, cursor: first.nextCursor }).records.map(record => record.title)).toEqual(["Last"]);
  expect(store.listTodos({ limit: 100 }).records).toHaveLength(57);
});

test("normalizes remote todo status and alarms, preserves identity, and computes availability across overrides", () => {
  const store = testStore();
  const id = store.addSource(source, Buffer.from("sealed"));
  store.applySync(id, { syncToken: "token-1", ctag: "ctag-1", removed: [], changed: [todo, calendar] });
  const [record] = store.listTodos({}).records;
  expect(record).toMatchObject({ uid: "todo1", etag: '\"1\"', sourceId: id, collection: url, origin: "untrusted_external",
    priority: 2, status: "in-progress", remindAt: "2027-01-01T18:45:00.000Z" });
  expect(() => store.completeTodo({ id: record!.id, revision: 1, completed: true })).toThrow(expect.objectContaining({ code: "UNSUPPORTED" }));
  const range = { from: "2027-03-13T00:00:00.000Z", to: "2027-03-17T00:00:00.000Z" };
  expect(store.listEvents(range).records).toMatchObject([
    { title: "Daily", startAt: "2027-03-13T17:00:00.000Z", recurrenceId: "2027-03-13T09:00:00" },
    { title: "Moved", startAt: "2027-03-15T18:00:00.000Z", recurrenceId: "2027-03-15T09:00:00" },
    { title: "Daily", startAt: "2027-03-16T16:00:00.000Z", recurrenceId: "2027-03-16T09:00:00" },
  ]);
  const first = store.listEvents({ ...range, limit: 1 });
  expect(store.listEvents({ ...range, cursor: first.nextCursor }).records.map(record => record.title)).toEqual(["Moved", "Daily"]);
  expect(store.freeSlots({ from: "2027-03-15T17:00:00.000Z", to: "2027-03-15T20:00:00.000Z", durationMinutes: 60 }).slots)
    .toEqual([{ from: "2027-03-15T17:00:00.000Z", to: "2027-03-15T18:00:00.000Z" }, { from: "2027-03-15T19:00:00.000Z", to: "2027-03-15T20:00:00.000Z" }]);
});

test("malformed remote data cannot advance the token or delete a previously committed object", () => {
  const store = testStore();
  const id = store.addSource(source, Buffer.from("sealed"));
  store.applySync(id, { syncToken: "token-1", removed: [], changed: [todo] });
  expect(() => store.applySync(id, { syncToken: "token-2", removed: [todo.href], changed: [object("bad", "malformed")] })).toThrow();
  expect(store.source(id).token).toBe("token-1");
  expect(store.listTodos({}).records.map(record => record.uid)).toEqual(["todo1"]);
  store.applySync(id, { syncToken: "token-2", removed: [todo.href], changed: [] });
  expect(store.listTodos({}).records).toEqual([]);
});

test("resume catches up using the last committed token and publishes fixed health without credentials", async () => {
  const store = testStore();
  const remote = vi.fn().mockResolvedValueOnce({ syncToken: "token-1", changed: [todo], removed: [] })
    .mockRejectedValueOnce(new CalDavError("credentials"))
    .mockResolvedValueOnce({ syncToken: "token-2", changed: [], removed: [todo.href] });
  const service = new AssistantAgendaService(store, { available: () => true, encrypt: () => Buffer.from("sealed"), decrypt: () => "fixture-access" }, remote);
  closers.push(() => service.close());
  await service.addSource({ ...source, credential: "fixture-access" });
  const id = store.enabledSourceIds()[0]!;
  expect(store.source(id).credential).toEqual(new Uint8Array(Buffer.from("sealed")));
  await service.refresh(id);
  expect(service.snapshot().sources).toContainEqual(expect.objectContaining({ status: "error", errorCode: "credentials" }));
  expect(JSON.stringify(service.snapshot())).not.toContain("fixture-access");
  const changed = once(service, "changed");
  service.resume();
  await changed;
  expect(remote.mock.calls[2]?.[0]).toMatchObject({ syncToken: "token-1", knownEtags: new Map([[todo.href, todo.etag]]) });
  expect(service.listTodos({}).records).toEqual([]);
  expect(store.source(id).token).toBe("token-2");
});
