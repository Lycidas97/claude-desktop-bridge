import ICAL from "ical.js";
import type { AgendaEventInput, AgendaTodoInput, AgendaWindow } from "../../packages/protocol/src/assistant-agenda.js";
import { agendaInstant, componentZone, timestamp, wallClock, type AgendaZone } from "./agenda-time.js";

const DAY = 86_400_000;
const expansionLimit = 100_000;

export class AgendaExpansionLimitError extends Error {
  constructor() { super("Calendar expansion exceeds supported occurrence count"); }
}
const utc = ICAL.Timezone.utcTimezone;
const text = (component: ICAL.Component, name: string, limit: number) => {
  const value = component.getFirstPropertyValue(name);
  return typeof value === "string" ? value.slice(0, limit) : undefined;
};
const instant = (time: ICAL.Time, zone: AgendaZone) => agendaInstant(timestamp(time, zone), zone);
const shifted = (time: ICAL.Time, seconds: number) => {
  const result = time.clone();
  if (time.isDate) result.adjust(seconds * 1000 / DAY, 0, 0, 0);
  else result.adjust(0, 0, 0, seconds);
  return result;
};

/** Days are calendar days. Hours, minutes and seconds are elapsed time within the resulting day. */
function durationEnd(start: ICAL.Time, duration: ICAL.Duration, zone: AgendaZone): string {
  const day = start.clone();
  const sign = duration.isNegative ? -1 : 1;
  day.day += sign * (duration.weeks * 7 + duration.days);
  if (day.isDate) return day.toString();
  const seconds = (duration.hours * 60 + duration.minutes) * 60 + duration.seconds;
  return new Date(instant(day, zone) + sign * seconds * 1000).toISOString();
}

function timeValue(component: ICAL.Component, name: string): ICAL.Time | undefined {
  const value = component.getFirstPropertyValue(name);
  if (value === null) return undefined;
  if (!(value instanceof ICAL.Time) || !Number.isFinite(Date.parse(value.toString().replace(/Z?$/, "Z")))) {
    throw new Error(`Invalid calendar ${name}`);
  }
  return value;
}

function timing(component: ICAL.Component, fallback: AgendaZone, allDayZone?: string) {
  const event = component.name === "vevent";
  const start = timeValue(component, "dtstart");
  const explicitEnd = timeValue(component, event ? "dtend" : "due");
  const zone = start?.isDate && allDayZone ? allDayZone : componentZone(component, fallback);
  const duration = component.getFirstPropertyValue("duration") as ICAL.Duration | null;
  const cancelled = text(component, "status", 32)?.toUpperCase() === "CANCELLED";
  if (event && !start && !cancelled) throw new Error("Missing event DTSTART");
  const exactDelta = start && explicitEnd ? instant(explicitEnd, zone) - instant(start, zone) : 0;
  const nominalDelta = start?.isDate && explicitEnd?.isDate ? explicitEnd.subtractDate(start).toSeconds() : undefined;
  const endAt = (occurrence = start): string | undefined => {
    if (explicitEnd) {
      if (!occurrence || occurrence === start) return timestamp(explicitEnd, zone);
      return nominalDelta !== undefined ? shifted(occurrence, nominalDelta).toString()
        : new Date(instant(occurrence, zone) + exactDelta).toISOString();
    }
    if (!occurrence) return undefined;
    if (duration) return durationEnd(occurrence, duration, zone);
    if (event) return timestamp(occurrence.isDate ? shifted(occurrence, DAY / 1000) : occurrence, zone);
    return undefined;
  };
  return { component, start, zone, endAt, cancelled };
}

type Timing = ReturnType<typeof timing>;
type Instance = { item: Timing; start: ICAL.Time | undefined; recurrenceId?: string | undefined; endAt?: string | undefined };

function repeatStep(rule: ICAL.Recur, start: ICAL.Time): number | undefined {
  const unit = ({ SECONDLY: 1000, MINUTELY: 60_000, HOURLY: 3_600_000 } as Record<string, number>)[rule.freq];
  return unit && !start.isDate && !Object.keys(rule.parts).length ? rule.interval * unit : undefined;
}

function hasFixedOffset(start: ICAL.Time, zone: AgendaZone): boolean {
  if (zone === utc || zone === "UTC") return true;
  if (typeof zone === "string") return false;
  const periods = zone.component?.getAllSubcomponents();
  const offset = zone.utcOffset(start);
  // ical.js uses zero before the first observance. DTSTART must already use the fixed offset.
  return !!periods?.length && periods.every(period => ["tzoffsetfrom", "tzoffsetto"].every(property =>
    (period.getFirstPropertyValue(property) as ICAL.UtcOffset | null)?.toSeconds() === offset));
}

function ruleStarts(rule: ICAL.Recur, start: ICAL.Time, zone: AgendaZone, floor: number, step: number | undefined, fixed: boolean) {
  if (step && fixed) {
    const origin = instant(start, zone);
    const offset = Date.parse(start.toString().replace(/Z?$/, "Z")) - origin;
    const until = rule.until ? instant(rule.until, zone) : Infinity;
    let index = Math.max(0, Math.ceil((floor - origin) / step));
    return () => {
      const time = origin + index * step;
      if ((rule.count !== null && index >= rule.count) || time > until) return null;
      index++;
      const occurrence = ICAL.Time.fromJSDate(new Date(time + offset), true);
      occurrence.zone = start.zone;
      return occurrence;
    };
  }
  if (step && rule.count === null && !rule.until && Number.isFinite(floor)) {
    // Anchor on the original wall-clock grid before the window. Let ical.js walk zone transitions.
    const wall = Date.parse(start.toString().replace(/Z?$/, "Z"));
    const index = Math.floor((floor - DAY - wall) / step);
    if (index > 0) {
      const seed = ICAL.Time.fromJSDate(new Date(wall + index * step), true);
      seed.zone = start.zone;
      start = seed;
    }
  }
  const iterator = rule.iterator(start);
  return () => iterator.next();
}

type TodoPage = { limit: number; closed: number; date: string; window?: AgendaWindow | undefined };

function expandSeries(items: Timing[], fallback: AgendaZone, window: AgendaWindow | undefined, expand: boolean, page?: TodoPage): Instance[] {
  const master = items.find(item => !item.component.hasProperty("recurrence-id"));
  const zone = master?.zone ?? fallback;
  const overrides = items.flatMap(item => {
    const recurrence = timeValue(item.component, "recurrence-id");
    return recurrence ? [{ item, recurrence, original: instant(recurrence, zone) }] : [];
  });
  const instances: Instance[] = overrides.map(({ item, recurrence }) => ({ item, start: item.start, recurrenceId: recurrence.toString() }));
  if (!master) return instances;
  const start = master.start;
  const rules = master.component.getAllProperties("rrule").map(property => property.getFirstValue() as ICAL.Recur);
  const extra = master.component.getAllProperties("rdate").flatMap(property => property.getValues() as Array<ICAL.Time | ICAL.Period>);
  if (start && (rules.length || extra.length)) {
    // Load recurrence fields at sync time, before the resource and cursor commit.
    for (const rule of rules) rule.iterator(start);
    master.component.getAllProperties("exdate").forEach(property => property.getValues());
  }
  if (!expand || !start || master.cancelled || (!rules.length && !extra.length)) {
    return [{ item: master, start }, ...instances];
  }

  const excluded = new Set(master.component.getAllProperties("exdate").flatMap(property =>
    (property.getValues() as ICAL.Time[]).map(time => instant(time, zone))));
  for (const override of overrides) excluded.add(override.original);
  const ranges = overrides.filter(({ item }) => item.component.getFirstProperty("recurrence-id")
    ?.getFirstParameter("range")?.toUpperCase() === "THISANDFUTURE")
    .map(override => ({ ...override, shift: override.item.start?.subtractDate(override.recurrence).toSeconds() ?? 0 }))
    .sort((a, b) => b.original - a.original);

  const from = window ? Date.parse(window.from) : -Infinity;
  const to = window ? Date.parse(window.to) : rules.some(rule => rule.count === null && !rule.until) ? Date.now() + 366 * DAY : Infinity;
  const utcSeries = !start.isDate && start.zone === utc && ranges.every(range => !range.item.start || range.item.start.zone === utc);
  // Local recurrences are ordered by wall time, and a zone transition can move an instant back.
  const zoneMargin = utcSeries ? 0 : DAY;
  const upper = to + Math.max(0, ...ranges.map(range => -range.shift * 1000)) + zoneMargin;
  const maxSpan = Math.max(0, ...items.map(item => {
    const end = item.endAt();
    return item.start && end ? agendaInstant(end, item.zone) - instant(item.start, item.zone) : 0;
  }));
  let lower = from - maxSpan - Math.max(0, ...ranges.map(range => range.shift * 1000)) - zoneMargin;
  let candidateLimit = Infinity;
  const steps = rules.map(rule => repeatStep(rule, start));
  const fixed = steps.some(Boolean) && hasFixedOffset(start, zone);
  if (!window && page && rules.length === 1 && steps[0] && fixed && !extra.length && !ranges.length) {
    const due = master.endAt();
    if (due?.endsWith("Z")) {
      const status = text(master.component, "status", 32)?.toUpperCase();
      const closed = Number(status === "COMPLETED" || status === "CANCELLED");
      if (closed < page.closed || (closed === page.closed && page.date === "~")) return instances;
      const after = Date.parse(page.date);
      if (closed === page.closed && Number.isFinite(after)) lower = after - (Date.parse(due) - instant(start, zone));
      // The store resolves the ID tie at the cursor and needs one extra result to detect the next page.
      candidateLimit = page.limit + 2;
    }
  }
  const candidates = new Map<number, { time: ICAL.Time; endAt?: string | undefined }>();
  const add = (time: ICAL.Time, endAt?: string) => {
    const key = instant(time, zone);
    if (key < lower && !endAt || key >= upper || excluded.has(key)) return;
    if (endAt || !candidates.has(key)) candidates.set(key, { time: time.clone(), endAt });
  };
  add(start);
  for (const date of extra) {
    const end = date instanceof ICAL.Period ? date.end : undefined;
    if (date instanceof ICAL.Period) add(date.start, end ? timestamp(end, zone) : durationEnd(date.start, date.duration!, zone));
    else add(date);
  }
  for (const [index, rule] of rules.entries()) {
    const next = ruleStarts(rule, start, zone, lower, steps[index], fixed);
    let count = 0;
    for (let occurrence = next(); occurrence && instant(occurrence, zone) < upper; occurrence = next()) {
      if (++count > expansionLimit) throw new AgendaExpansionLimitError();
      add(occurrence);
      if (candidates.size >= candidateLimit) break;
    }
  }
  for (const [key, date] of candidates) {
    const range = ranges.find(range => range.original < key);
    if (range?.item.cancelled) continue;
    const occurrence = range ? shifted(date.time, range.shift) : date.time;
    if (range?.item.start) occurrence.zone = range.item.start.zone;
    instances.push({ item: range?.item ?? master, start: occurrence, recurrenceId: date.time.toString(), endAt: range ? undefined : date.endAt });
  }
  return instances;
}

function alarmTime(component: ICAL.Component, zone: AgendaZone, startAt?: string, endAt?: string) {
  const alarm = component.getFirstSubcomponent("valarm")?.getFirstProperty("trigger");
  if (!alarm) return;
  let trigger;
  try { trigger = alarm.getFirstValue(); }
  catch (error) {
    if (error instanceof Error && /^(?:invalid (?:date-time|duration) value:|Could not extract integer from )/u.test(error.message)) return;
    throw error;
  }
  if (trigger instanceof ICAL.Time) return timestamp(trigger, zone);
  if (trigger instanceof ICAL.Duration) {
    const anchor = alarm.getFirstParameter("related")?.toUpperCase() === "END" ? endAt : startAt;
    if (!anchor) return;
    const at = agendaInstant(anchor, zone);
    if (trigger.weeks || trigger.days) return durationEnd(wallClock(at, zone), trigger, zone);
    const reminder = new Date(at + trigger.toSeconds() * 1000);
    return Number.isFinite(reminder.getTime()) ? reminder.toISOString() : undefined;
  }
}

function todoFields({ item: { component, zone, endAt }, start, recurrenceId, endAt: periodEnd }: Instance) {
  const dueAt = periodEnd ?? endAt(start);
  const remindAt = alarmTime(component, zone, start && timestamp(start, zone), dueAt);
  const status = text(component, "status", 32)?.toUpperCase();
  const priority = component.getFirstPropertyValue("priority");
  return {
    title: text(component, "summary", 500) || "无标题待办", notes: text(component, "description", 8000),
    ...(typeof priority === "number" && priority >= 0 && priority <= 9 ? { priority } : {}),
    dueAt, remindAt, recurrenceId,
    status: (status === "COMPLETED" ? "completed" : status === "CANCELLED" ? "cancelled" : status === "IN-PROCESS" ? "in-progress" : "pending") as AgendaTodoInput["status"],
  };
}

type RemoteEvent = AgendaEventInput & { attendees: string[]; busy: boolean; recurrenceId?: string | undefined };

export function parseAgendaObject(data: string, fallbackZone: AgendaZone, options?: { window: AgendaWindow; allDayZone: string } | { todos: TodoPage }) {
  const calendar = new ICAL.Component(ICAL.parse(data));
  if (calendar.name !== "vcalendar") throw new Error("Invalid calendar object");
  const events = calendar.getAllSubcomponents("vevent");
  const todos = calendar.getAllSubcomponents("vtodo");
  const components = [...events, ...todos];
  if (!components.length) return { uid: "", todos: [], events: [], recurring: 0 };
  const uid = components[0]!.getFirstPropertyValue("uid");
  if (typeof uid !== "string" || !uid || components.some(component => component.getFirstPropertyValue("uid") !== uid)) {
    throw new Error("Invalid calendar UID");
  }
  const recurring = (events.some(isRecurring) ? 1 : 0) | (todos.some(isRecurring) ? 2 : 0);
  const eventQuery = options && "window" in options ? options : undefined;
  const window = eventQuery?.window;
  const eventRecords: RemoteEvent[] = [];
  if (!options || window) {
    const from = window ? Date.parse(window.from) : -Infinity;
    const to = window ? Date.parse(window.to) : Infinity;
    const series = events.map(item => timing(item, fallbackZone, eventQuery?.allDayZone));
    for (const instance of expandSeries(series, fallbackZone, window, Boolean(window))) {
      const { item: { component, zone, endAt, cancelled }, start, recurrenceId } = instance;
      if (cancelled) continue;
      const startAt = timestamp(start!, zone);
      const end = instance.endAt ?? endAt(start)!;
      if (agendaInstant(startAt, zone) >= to || agendaInstant(end, zone) < from) continue;
      eventRecords.push({
        title: text(component, "summary", 500) || "无标题日程",
        notes: text(component, "description", 8000), location: text(component, "location", 1000),
        startAt, endAt: end, remindAt: alarmTime(component, zone, startAt, end),
        timeZone: typeof zone === "string" ? zone : zone === utc ? "UTC" : zone.tzid,
        allDay: start!.isDate, recurrenceId,
        attendees: component.getAllProperties("attendee").slice(0, 30).map(property =>
          String(property.getFirstParameter("cn") ?? property.getFirstValue()).slice(0, 320)),
        busy: text(component, "transp", 32)?.toUpperCase() !== "TRANSPARENT",
      });
    }
  }
  const todoPage = options && "todos" in options ? options.todos : undefined;
  return { uid, todos: window ? [] : expandSeries(todos.map(item => timing(item, fallbackZone)), fallbackZone, todoPage?.window, Boolean(todoPage), todoPage).map(todoFields), events: eventRecords, recurring };
}

function isRecurring(component: ICAL.Component) {
  return ["rrule", "rdate", "exdate", "recurrence-id"].some(name => component.hasProperty(name));
}
