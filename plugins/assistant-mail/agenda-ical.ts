import ICAL from "ical.js";
import type { AgendaEventInput, AgendaTodoInput, AgendaWindow } from "../../packages/protocol/src/assistant-agenda.js";

const text = (component: ICAL.Component, name: string, limit: number) => {
  const value = component.getFirstPropertyValue(name);
  return typeof value === "string" ? value.slice(0, limit) : undefined;
};

function timestamp(time: ICAL.Time, timeZone?: string): string {
  if (time.isDate) return time.toString();
  if (time.zone !== ICAL.Timezone.localTimezone) return time.toJSDate().toISOString();
  if (!timeZone) return time.toJSDate().toISOString();
  return new Date(agendaInstant(time.toString(), timeZone)).toISOString();
}

/** Interpret a date or floating wall time relative to the calendar, not the reader's device. */
export function agendaInstant(value: string, zone: string): number {
  if (value.endsWith("Z")) return Date.parse(value);
  const utc = Date.parse(`${value.length === 10 ? `${value}T00:00:00` : value}Z`);
  const formatter = new Intl.DateTimeFormat("en", { timeZone: zone, timeZoneName: "longOffset" });
  const offsetAt = (instant: number) => {
    const name = formatter.formatToParts(instant).find(part => part.type === "timeZoneName")!.value;
    const match = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
    return match ? (match[1] === "-" ? -1 : 1) * (+match[2]! * 60 + +match[3]!) * 60_000 : 0;
  };
  return utc - offsetAt(utc - offsetAt(utc));
}

function eventFields(event: ICAL.Event, start: ICAL.Time, end: ICAL.Time, timeZone: string) {
  const component = event.component;
  return {
    title: text(component, "summary", 500) || "无标题日程",
    notes: text(component, "description", 8000), location: text(component, "location", 1000),
    startAt: timestamp(start, timeZone), endAt: timestamp(end, timeZone), timeZone,
    allDay: start.isDate,
    attendees: component.getAllProperties("attendee").slice(0, 30).map(property =>
      String(property.getFirstParameter("cn") ?? property.getFirstValue()).slice(0, 320)),
    busy: text(component, "transp", 32)?.toUpperCase() !== "TRANSPARENT",
  };
}

function componentZone(component: ICAL.Component, fallback: string) {
  const start = component.getFirstProperty("dtstart") ?? component.getFirstProperty("due");
  return start?.getFirstParameter("tzid") ?? (String(start?.getFirstValue()).endsWith("Z") ? "UTC" : fallback);
}

type RemoteEvent = AgendaEventInput & { attendees: string[]; busy: boolean; recurrenceId?: string | undefined };

export function parseAgendaObject(data: string, fallbackZone: string, window?: AgendaWindow): {
  uid: string; todos: Array<AgendaTodoInput & { recurrenceId?: string | undefined }>; events: RemoteEvent[]; recurring: boolean;
} {
  const calendar = new ICAL.Component(ICAL.parse(data));
  const components = [...calendar.getAllSubcomponents("vevent"), ...calendar.getAllSubcomponents("vtodo")];
  const uid = components[0] && text(components[0], "uid", 1000);
  if (!uid || components.some(component => component.getFirstPropertyValue("uid") !== uid)) throw new Error("Invalid calendar UID");
  const todos = calendar.getAllSubcomponents("vtodo").map(component => {
    const zone = componentZone(component, fallbackZone);
    const start = component.getFirstPropertyValue("dtstart") as ICAL.Time | null;
    let due = component.getFirstPropertyValue("due") as ICAL.Time | null;
    const duration = component.getFirstPropertyValue("duration") as ICAL.Duration | null;
    if (!due && start && duration) { due = start.clone(); due.addDuration(duration); }
    const alarm = component.getFirstSubcomponent("valarm")?.getFirstProperty("trigger");
    const trigger = alarm?.getFirstValue();
    let reminder = trigger instanceof ICAL.Time ? trigger : undefined;
    if (trigger instanceof ICAL.Duration) {
      const anchor = alarm?.getFirstParameter("related")?.toUpperCase() === "END" ? due : start;
      if (anchor) { reminder = anchor.clone(); reminder.isDate = false; reminder.addDuration(trigger); }
    }
    const status = text(component, "status", 32)?.toUpperCase();
    const priority = component.getFirstPropertyValue("priority");
    return {
      title: text(component, "summary", 500) || "无标题待办", notes: text(component, "description", 8000),
      ...(typeof priority === "number" && priority >= 0 && priority <= 9 ? { priority } : {}),
      dueAt: due ? timestamp(due, zone) : undefined, remindAt: reminder ? timestamp(reminder, zone) : undefined,
      status: (status === "COMPLETED" ? "completed" : status === "CANCELLED" ? "cancelled" : status === "IN-PROCESS" ? "in-progress" : "pending") as AgendaTodoInput["status"],
      recurrenceId: component.hasProperty("recurrence-id") ? String(component.getFirstPropertyValue("recurrence-id")) : undefined,
    };
  });
  const eventComponents = calendar.getAllSubcomponents("vevent");
  const master = eventComponents.find(component => !component.hasProperty("recurrence-id"));
  const recurring = Boolean(master?.hasProperty("rrule") || master?.hasProperty("rdate") || eventComponents.some(component => component.hasProperty("recurrence-id")));
  const events: RemoteEvent[] = [];
  const append = (event: ICAL.Event, start: ICAL.Time, end: ICAL.Time, recurrenceId?: string | undefined) => {
    if (text(event.component, "status", 32)?.toUpperCase() === "CANCELLED") return;
    const zone = componentZone(event.component, fallbackZone);
    if (!start || !end) throw new Error("Invalid event date");
    const value = eventFields(event, start, end, zone);
    const comparisonZone = start.isDate ? fallbackZone : zone;
    if (!window || agendaInstant(value.startAt, comparisonZone) < Date.parse(window.to) && agendaInstant(value.endAt, comparisonZone) >= Date.parse(window.from)) {
      events.push({ ...value, recurrenceId });
    }
  };
  if (master) {
    const event = new ICAL.Event(master);
    if (!window || !event.isRecurring()) append(event, event.startDate, event.endDate);
    else {
      const iterator = event.iterator();
      const end = Date.parse(window.to);
      const zone = componentZone(master, fallbackZone);
      // Direct overrides are added separately even if their original date lies outside the window.
      let count = 0;
      for (let occurrence = iterator.next(); occurrence; occurrence = iterator.next()) {
        if (agendaInstant(timestamp(occurrence, zone), zone) >= end) break;
        if (++count > 100_000) throw new Error("Calendar expansion exceeds supported occurrence count");
        if (Object.hasOwn(event.exceptions, occurrence.toString()) || Object.hasOwn(event.exceptions, occurrence.convertToZone(ICAL.Timezone.utcTimezone).toString())) continue;
        const details = event.getOccurrenceDetails(occurrence);
        append(details.item, details.startDate, details.endDate, occurrence.toString());
      }
    }
  }
  for (const component of eventComponents) {
    if (component === master || !component.hasProperty("recurrence-id") || text(component, "status", 32)?.toUpperCase() === "CANCELLED") continue;
    const event = new ICAL.Event(component);
    append(event, event.startDate, event.endDate, event.recurrenceId.toString());
  }
  return { uid, todos, events, recurring };
}
