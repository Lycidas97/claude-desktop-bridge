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

test("retains the ETag of a valid unsupported resource alongside imported events", () => {
  const diary = object("diary", ics(...item("VJOURNAL", "diary", "DTSTART;VALUE=DATE:20270101")));
  const meeting = object("meeting", ics(...item("VEVENT", "meeting", "DTSTART:20270104T090000Z", "DURATION:PT1H")));
  sync(diary, meeting);
  expect(store.knownEtags(source).get(diary.href)).toBe(diary.etag);
  expect(store.listEvents(window).records.map(record => record.uid)).toEqual(["meeting"]);
  expect(store.listTodos({}).records).toEqual([]);
  expect(() => sync(object("broken", ics(...item("VEVENT", "broken", "DTSTART:invalid"))))).toThrow();
  expect(store.listEvents(window).records.map(record => record.uid)).toEqual(["meeting"]);
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

test("uses collection VTIMEZONE for floating DTSTART and DUE, with host fallback", () => {
  const records = [object("meeting", ics(...item("VEVENT", "meeting", "DTSTART:20270104T090000", "DURATION:PT1H"))),
    object("task", ics(...item("VTODO", "task", "DUE:20270104T090000")))];
  sync(...records);
  expect(store.listEvents(window).records[0]?.startAt).toBe("2027-01-04T09:00:00.000Z");
  expect(store.listTodos({}).records[0]?.dueAt).toBe("2027-01-04T09:00:00.000Z");
  // A calendar can change its timezone while keeping the member ETags unchanged.
  const delta = { removed: [], changed: [], calendarTimeZone: ics(...customZone) };
  store.applySync(source, delta);
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
