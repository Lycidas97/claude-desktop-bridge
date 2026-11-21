import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { AgendaStore } from "./agenda-store.js";

const url = "https://example.test/calendar/";
const ics = (...lines: string[]) => ["BEGIN:VCALENDAR", "VERSION:2.0", ...lines, "END:VCALENDAR", ""].join("\r\n");
const item = (type: string, uid: string, ...lines: string[]) => [`BEGIN:${type}`, `UID:${uid}`, `SUMMARY:${uid}`, ...lines, `END:${type}`];
const object = (uid: string, data: string) => ({ href: `${url}${uid}.ics`, etag: '"1"', data });
const window = { from: "2027-01-01T00:00:00.000Z", to: "2027-02-01T00:00:00.000Z" };
const customZone = ["BEGIN:VTIMEZONE", "TZID:Eastern Standard Time", "BEGIN:STANDARD", "DTSTART:19700101T000000",
  "TZOFFSETFROM:-0500", "TZOFFSETTO:-0500", "END:STANDARD", "END:VTIMEZONE"];

let database: DatabaseSync;
let store: AgendaStore;
let source: string;
beforeEach(() => {
  database = new DatabaseSync(":memory:");
  store = new AgendaStore(database, "UTC");
  source = store.addSource({ url, user: "fixture", label: "Test" }, Buffer.from("sealed"));
});
afterEach(() => { database.close(); vi.useRealTimers(); });

function sync(...changed: Array<ReturnType<typeof object>>) {
  store.applySync(source, { removed: [], changed });
}

test.each([
  ["RDATE:20270111T090000Z", "2027-01-11T10:00:00.000Z"],
  ["RDATE;VALUE=PERIOD:20270111T090000Z/20270111T110000Z", "2027-01-11T11:00:00.000Z"],
])("includes DTSTART and preserves the instance duration with %s", (rdate, endAt) => {
  sync(object("extra", ics(...item("VEVENT", "extra", "DTSTART:20270104T090000Z", "DURATION:PT1H", rdate))));
  expect(store.listEvents(window).records).toMatchObject([
    { startAt: "2027-01-04T09:00:00.000Z", endAt: "2027-01-04T10:00:00.000Z" },
    { startAt: "2027-01-11T09:00:00.000Z", endAt },
  ]);
  expect(store.freeSlots({ from: "2027-01-11T09:00:00.000Z", to: endAt, durationMinutes: 30 }).slots).toEqual([]);
});

test("applies EXDATE after merging DTSTART, RRULE and RDATE", () => {
  sync(object("excluded", ics(...item("VEVENT", "excluded", "DTSTART:20270104T090000Z", "DURATION:PT1H",
    "RRULE:FREQ=DAILY;COUNT=3", "RDATE:20270105T090000Z", "EXDATE:20270103T090000Z,20270104T090000Z,20270105T090000Z"))));
  expect(store.listEvents(window).records.map(record => record.startAt)).toEqual(["2027-01-06T09:00:00.000Z"]);
});

test("queries imported all-day spans by device date and timed entries by instant", () => {
  sync(object("one-day", ics(...item("VEVENT", "one-day", "DTSTART;VALUE=DATE:20271202", "DTEND;VALUE=DATE:20271203"))),
    object("multi-day", ics(...item("VEVENT", "multi-day", "DTSTART;VALUE=DATE:20271201", "DTEND;VALUE=DATE:20271203", "RRULE:FREQ=WEEKLY;COUNT=2"))),
    object("timed", ics(...item("VEVENT", "timed", "DTSTART:20271202T060000Z", "DURATION:PT1H"))));
  const names = (from: string, to: string, allDayOn: string) => store.listEvents({ from, to, allDayOn }).records.map(record => record.title).sort();
  expect(names("2027-12-01T08:00:00.000Z", "2027-12-02T08:00:00.000Z", "2027-12-01")).toEqual(["multi-day", "timed"]);
  expect(names("2027-12-02T08:00:00.000Z", "2027-12-03T08:00:00.000Z", "2027-12-02")).toEqual(["multi-day", "one-day"]);
  expect(names("2027-12-03T08:00:00.000Z", "2027-12-04T08:00:00.000Z", "2027-12-03")).toEqual([]);
});

test("retains the ETag of a valid unsupported resource alongside imported events", () => {
  const diary = object("diary", ics(...item("VJOURNAL", "diary", "DTSTART;VALUE=DATE:20270101")));
  const meeting = object("meeting", ics(...item("VEVENT", "meeting", "DTSTART:20270104T090000Z", "DURATION:PT1H", "RRULE:FREQ=WEEKLY;COUNT=1")));
  expect(store.applySync(source, { removed: [], changed: [diary] })).toBe(false);
  sync(meeting);
  expect(store.knownEtags(source).get(diary.href)).toBe(diary.etag);
  const agenda = store.listEvents(window);
  expect(agenda.records.map(record => record.uid)).toEqual(["meeting"]);
  expect(store.listTodos({}).records).toEqual([]);
  const editedDiary = { ...diary, etag: '"2"', data: diary.data.replace("SUMMARY:diary", "SUMMARY:edited diary") };
  expect(store.applySync(source, { removed: [], changed: [editedDiary] })).toBe(false);
  expect(store.knownEtags(source).get(diary.href)).toBe('"2"');
  expect(store.applySync(source, { removed: [diary.href], changed: [] })).toBe(false);
  expect(store.knownEtags(source).has(diary.href)).toBe(false);
  expect(store.listEvents(window)).toEqual(agenda);
  expect(() => sync(object("broken", ics(...item("VEVENT", "broken", "DTSTART:invalid"))))).toThrow();
  expect(store.listEvents(window).records.map(record => record.uid)).toEqual(["meeting"]);
  expect(store.applySync(source, { removed: [], changed: [{ ...diary, href: meeting.href }] })).toBe(true);
  expect(store.listEvents(window).records).toEqual([]);
});

test("an old hourly series still expands in a current one-day window", () => {
  sync(object("hourly", ics(...item("VEVENT", "hourly", "DTSTART:20140101T090000Z", "DURATION:PT30M", "RRULE:FREQ=HOURLY"))));
  const day = { from: window.from, to: "2027-01-02T00:00:00.000Z" };
  expect(store.listEvents(day).records).toHaveLength(24);
  expect(store.freeSlots({ ...day, durationMinutes: 30 }).slots).toHaveLength(24);
});

test("an old hourly series in a fixed-offset VTIMEZONE keeps its wall time and busy interval", () => {
  sync(object("fixed", ics(...customZone, ...item("VEVENT", "fixed", "DTSTART;TZID=Eastern Standard Time:20140101T091500",
    "DURATION:PT30M", "RRULE:FREQ=HOURLY"))));
  const day = { from: window.from, to: "2027-01-02T00:00:00.000Z" };
  const events = store.listEvents(day).records;
  expect(events).toHaveLength(24);
  expect(events[0]).toMatchObject({ startAt: "2027-01-01T00:15:00.000Z", recurrenceId: "2026-12-31T19:15:00" });
  expect(store.freeSlots({ from: "2027-01-01T00:15:00.000Z", to: "2027-01-01T00:45:00.000Z", durationMinutes: 30 }).slots).toEqual([]);
});

test("pages an old hourly VTODO from its original due date and can seek to a later cursor", () => {
  vi.setSystemTime(new Date(window.from));
  sync(object("hourly-task", ics(...item("VTODO", "hourly-task", "DTSTART:20140101T090000Z", "DUE:20140101T093000Z", "RRULE:FREQ=HOURLY"))));
  const first = store.listTodos({ limit: 1 });
  expect(first.records).toMatchObject([{ dueAt: "2014-01-01T09:30:00.000Z" }]);
  expect(store.listTodos({ limit: 1, cursor: first.nextCursor }).records).toMatchObject([{ dueAt: "2014-01-01T10:30:00.000Z" }]);
  const dueAt = "2027-01-01T00:30:00.000Z";
  const later = store.listTodos({ limit: 1, cursor: `0|${dueAt}|${"0".repeat(64)}` });
  expect(later.records).toMatchObject([{ dueAt, recurrenceId: "2027-01-01T00:00:00Z" }]);
  expect(later.nextCursor).toBeDefined();
  expect(store.listTodos({ limit: 1, cursor: later.nextCursor }).records).toMatchObject([{ dueAt: "2027-01-01T01:30:00.000Z" }]);
});

test("filters recurring task deadlines before paging, including civil dates", () => {
  sync(object("hourly-task", ics(...item("VTODO", "hourly-task", "DTSTART:20140101T090000Z", "DUE:20140101T093000Z", "RRULE:FREQ=HOURLY"))),
    object("date-task", ics(...item("VTODO", "date-task", "DTSTART;VALUE=DATE:20261231", "DUE;VALUE=DATE:20270101", "RRULE:FREQ=DAILY;COUNT=3"))));
  const dueOn = { date: "2027-01-02", from: "2027-01-01T15:00:00.000Z", to: "2027-01-02T15:00:00.000Z" };
  const page = store.listTodos({ dueOn, limit: 1 });
  expect(page.records[0]).toMatchObject({ dueAt: "2027-01-01T15:30:00.000Z" });
  const remaining = store.listTodos({ dueOn, cursor: page.nextCursor });
  expect(remaining.incomplete).toBeUndefined();
  expect(remaining.records).toHaveLength(24);
  expect(remaining.records).toContainEqual(expect.objectContaining({ title: "date-task", dueAt: "2027-01-02" }));
  expect(remaining.records.at(-1)).toMatchObject({ dueAt: "2027-01-02T14:30:00.000Z" });
});

const newYork = ["BEGIN:VTIMEZONE", "TZID:America/New_York", "BEGIN:STANDARD", "DTSTART:20071104T020000",
  "TZOFFSETFROM:-0400", "TZOFFSETTO:-0500", "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU", "END:STANDARD",
  "BEGIN:DAYLIGHT", "DTSTART:20070311T020000", "TZOFFSETFROM:-0500", "TZOFFSETTO:-0400",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU", "END:DAYLIGHT", "END:VTIMEZONE"];

test("reads the ready 2014 New York hourly event in winter and summer without omitting busy intervals", () => {
  sync(object("ny", ics(...newYork, ...item("VEVENT", "ny", "DTSTART;TZID=America/New_York:20140101T090000",
    "DURATION:PT30M", "RRULE:FREQ=HOURLY"))));
  expect(store.source(source).status).toBe("ready");
  for (const [month, localHour] of [["01", "19"], ["07", "20"]] as const) {
    const day = { from: `2027-${month}-01T00:00:00.000Z`, to: `2027-${month}-02T00:00:00.000Z` };
    const events = store.listEvents(day).records;
    expect(events).toHaveLength(24);
    expect(events[0]).toMatchObject({ startAt: day.from, recurrenceId: `${month === "01" ? "2026-12-31" : "2027-06-30"}T${localHour}:00:00` });
    const page = store.listEvents({ ...day, limit: 1 });
    expect(store.listEvents({ ...day, cursor: page.nextCursor, limit: 1 }).records[0]?.id).toBe(events[1]?.id);
    expect(store.freeSlots({ ...day, durationMinutes: 30 }).slots).toEqual(events.map((event, hour) => ({
      from: event.endAt, to: events[hour + 1]?.startAt ?? day.to,
    })));
  }
});

test.each(["2027-03-14", "2027-11-07"])("seeking on %s preserves the iterator's DST instances, IDs and busy intervals", date => {
  const day = { from: `${date}T04:00:00.000Z`, to: `${date}T11:00:00.000Z` };
  const series = (start: string, rule: string) => object("ny", ics(...newYork, ...item("VEVENT", "ny",
    `DTSTART;TZID=America/New_York:${start}T000000`, "DURATION:PT30M", `RRULE:${rule}`)));
  sync(series(date.startsWith("2027-03") ? "20270313" : "20271106", "FREQ=HOURLY;COUNT=48"));
  const reference = store.listEvents(day);
  const gaps = store.freeSlots({ ...day, durationMinutes: 30 });
  expect(reference.records.length).toBeGreaterThan(0);
  sync(series("20140101", "FREQ=HOURLY"));
  expect(store.listEvents(day)).toEqual(reference);
  expect(store.freeSlots({ ...day, durationMinutes: 30 })).toEqual(gaps);
});

test("keeps healthy events visible when an old rule exceeds the budget and refuses to report gaps", () => {
  const dense = object("dense", ics(...item("VEVENT", "dense", "DTSTART:20140101T090000Z", "DURATION:PT30M",
    "RRULE:FREQ=HOURLY;BYMINUTE=0")));
  sync(dense);
  const local = store.saveEvent({ title: "Local", startAt: window.from, endAt: "2027-01-01T01:00:00.000Z", allDay: false, timeZone: "UTC" });
  expect(store.listEvents(window)).toMatchObject({ records: [{ id: local.id }], incomplete: true });
  expect(() => store.freeSlots({ ...window, durationMinutes: 30 })).toThrow("Calendar expansion exceeds supported occurrence count");
  store.applySync(source, { removed: [dense.href], changed: [] });
  expect(store.listEvents(window)).toEqual({ records: [local] });
});

test("keeps healthy tasks and cursor pagination visible when a task series exceeds the budget", () => {
  vi.setSystemTime(new Date(window.from));
  sync(object("dense-task", ics(...item("VTODO", "dense-task", "DTSTART:20140101T090000Z", "DUE:20140101T093000Z",
    "RRULE:FREQ=HOURLY;BYMINUTE=0"))));
  const first = store.saveTodo({ title: "First", status: "pending", dueAt: "2027-01-04" });
  const second = store.saveTodo({ title: "Second", status: "pending", dueAt: "2027-01-05" });
  const page = store.listTodos({ limit: 1 });
  expect(page).toMatchObject({ records: [{ id: first.id }], incomplete: true });
  expect(page.nextCursor).toBeDefined();
  expect(store.listTodos({ cursor: page.nextCursor })).toEqual({ records: [second], incomplete: true });
});

test("pages the ready 2014 hourly task past a completed first occurrence and retains its ID", () => {
  vi.setSystemTime(new Date(window.from));
  const uid = "hourly-exception";
  sync(object(uid, ics(...item("VTODO", uid, "DTSTART:20140101T090000Z", "DUE:20140101T093000Z", "RRULE:FREQ=HOURLY"),
    ...item("VTODO", uid, "RECURRENCE-ID:20140101T090000Z", "DTSTART:20140101T090000Z", "DUE:20140101T093000Z", "STATUS:COMPLETED"))));
  expect(store.source(source).status).toBe("ready");
  const first = store.listTodos({ limit: 1 });
  expect(first.records).toMatchObject([{ recurrenceId: "2014-01-01T10:00:00Z", dueAt: "2014-01-01T10:30:00.000Z", status: "pending" }]);
  const second = store.listTodos({ limit: 1, cursor: first.nextCursor });
  expect(second.records).toMatchObject([{ recurrenceId: "2014-01-01T11:00:00Z" }]);
  const later = store.listTodos({ limit: 1, cursor: `0|2027-01-01T00:30:00.000Z|${"0".repeat(64)}` });
  expect(later.records).toMatchObject([{ recurrenceId: "2027-01-01T00:00:00Z" }]);
  const closed = store.listTodos({ status: "completed", limit: 1 });
  expect(closed.records).toMatchObject([{ recurrenceId: "2014-01-01T09:00:00Z", status: "completed" }]);
  expect(closed.nextCursor).toBeUndefined();
  expect(store.listTodos({ limit: 1, cursor: `1|2014-01-01T09:30:00.000Z|${"0".repeat(64)}` }).records).toEqual(closed.records);
  expect(store.listTodos({ limit: 1 }).records).toEqual(first.records);
});

test("uses collection VTIMEZONE for floating DTSTART and DUE, with host fallback", () => {
  const records = [object("meeting", ics(...item("VEVENT", "meeting", "DTSTART:20270104T090000", "DURATION:PT1H"))),
    object("task", ics(...item("VTODO", "task", "DUE:20270104T090000")))];
  sync(...records);
  expect(store.listEvents(window).records[0]?.startAt).toBe("2027-01-04T09:00:00.000Z");
  expect(store.listTodos({}).records[0]?.dueAt).toBe("2027-01-04T09:00:00.000Z");
  // A calendar can change its timezone while keeping the member ETags unchanged.
  const delta = { removed: [], changed: [], calendarTimeZone: ics(...customZone) };
  expect(store.applySync(source, delta)).toBe(true);
  expect(store.applySync(source, delta)).toBe(false);
  expect(store.listEvents(window).records[0]).toMatchObject({ startAt: "2027-01-04T14:00:00.000Z", timeZone: "Eastern Standard Time" });
  expect(store.listTodos({}).records[0]?.dueAt).toBe("2027-01-04T14:00:00.000Z");
  expect(store.freeSlots({ from: "2027-01-04T14:00:00.000Z", to: "2027-01-04T15:00:00.000Z", durationMinutes: 30 }).slots).toEqual([]);
});

test("collection timezone does not move a recurring date-only event off its local calendar date", () => {
  store.applySync(source, { removed: [], calendarTimeZone: ics(...customZone), changed: [object("all-day", ics(
    ...item("VEVENT", "all-day", "DTSTART;VALUE=DATE:20270104", "RRULE:FREQ=DAILY;COUNT=2"),
  ))] });
  const early = { from: "2027-01-05T00:00:00.000Z", to: "2027-01-05T01:00:00.000Z" };
  expect(store.listEvents(early).records).toMatchObject([{ allDay: true, startAt: "2027-01-05" }]);
  expect(store.freeSlots({ ...early, durationMinutes: 30 }).slots).toEqual([]);
});

test("a RANGE override advances instances into a narrow query window", () => {
  sync(object("early", ics(
    ...item("VEVENT", "early", "DTSTART:20270104T090000Z", "DURATION:PT1H", "RRULE:FREQ=DAILY;COUNT=4"),
    ...item("VEVENT", "early", "RECURRENCE-ID;RANGE=THISANDFUTURE:20270105T090000Z", "DTSTART:20270105T080000Z", "DURATION:PT1H"),
  )));
  const narrow = { from: "2027-01-06T08:00:00.000Z", to: "2027-01-06T08:30:00.000Z" };
  expect(store.listEvents(narrow).records).toMatchObject([{ startAt: "2027-01-06T08:00:00.000Z", recurrenceId: "2027-01-06T09:00:00Z" }]);
  expect(store.freeSlots({ ...narrow, durationMinutes: 15 }).slots).toEqual([]);
});

test("uses exact DTEND duration and nominal DURATION across daylight saving", () => {
  const start = "DTSTART;TZID=America/New_York:20270313T013000";
  sync(object("exact", ics(...item("VEVENT", "exact", start, "DTEND;TZID=America/New_York:20270313T033000", "RRULE:FREQ=DAILY;COUNT=2"))),
    object("nominal", ics(...item("VEVENT", "nominal", start, "DURATION:P1D", "RRULE:FREQ=DAILY;COUNT=2"))));
  const day = { from: "2027-03-14T06:30:00.000Z", to: "2027-03-14T08:31:00.000Z" };
  const records = store.listEvents(day).records;
  expect(records.find(record => record.uid === "exact")).toMatchObject({ startAt: "2027-03-14T06:30:00.000Z", endAt: "2027-03-14T08:30:00.000Z" });
  expect(records.find(record => record.uid === "nominal" && record.startAt === day.from)?.endAt).toBe("2027-03-15T05:30:00.000Z");
  store.applySync(source, { removed: [`${url}nominal.ics`], changed: [] });
  expect(store.freeSlots({ from: "2027-03-14T07:30:00.000Z", to: "2027-03-14T08:30:00.000Z", durationMinutes: 30 }).slots).toEqual([]);
});

test("repeating VTODO yields each due date and stable recurrence identity across pages", () => {
  vi.setSystemTime(new Date(window.from));
  sync(object("weekly", ics(...item("VTODO", "weekly", "DTSTART:20270104T090000Z", "DUE:20270104T100000Z", "RRULE:FREQ=WEEKLY;COUNT=3"))));
  const first = store.listTodos({ limit: 1 });
  expect(first.records).toMatchObject([{ dueAt: "2027-01-04T10:00:00.000Z", recurrenceId: "2027-01-04T09:00:00Z" }]);
  const remaining = store.listTodos({ cursor: first.nextCursor }).records;
  expect(remaining).toMatchObject([
    { dueAt: "2027-01-11T10:00:00.000Z", recurrenceId: "2027-01-11T09:00:00Z" },
    { dueAt: "2027-01-18T10:00:00.000Z", recurrenceId: "2027-01-18T09:00:00Z" },
  ]);
  expect(new Set([...first.records, ...remaining].map(record => record.id)).size).toBe(3);
});
