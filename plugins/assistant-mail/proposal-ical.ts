import ICAL from "ical.js";
import { tzlib_get_ical_block } from "timezones-ical-library";
import type { AgendaEventInput, AgendaTodoInput } from "../../packages/protocol/src/assistant-agenda.js";
import type { AgendaProposalAction } from "../../packages/protocol/src/assistant-proposal.js";
import { AgendaEditError } from "./agenda-store.js";

const todoStatuses: Record<AgendaTodoInput["status"], string> = {
  pending: "NEEDS-ACTION", "in-progress": "IN-PROCESS", completed: "COMPLETED", cancelled: "CANCELLED",
};

export function proposalCalendarBody(
  action: AgendaProposalAction,
  uid: string,
  previous?: { body: string; value: AgendaTodoInput | AgendaEventInput },
): string {
  const kind = action.kind.startsWith("todo.") ? "vtodo" : "vevent";
  const calendar = new ICAL.Component(previous ? ICAL.parse(previous.body) : "vcalendar");
  const components = calendar.getAllSubcomponents(kind);
  if (previous && (components.length !== 1 || calendar.getAllSubcomponents(kind === "vtodo" ? "vevent" : "vtodo").length)) {
    throw new AgendaEditError("UNSUPPORTED", "暂不支持修改包含多项记录的日历资源。");
  }
  if (action.kind === "calendar.delete") return "";
  const item = previous ? components[0]! : new ICAL.Component(kind);
  const now = ICAL.Time.fromJSDate(new Date(), true);
  if (!previous) {
    calendar.addPropertyWithValue("version", "2.0");
    calendar.addPropertyWithValue("prodid", "-//Bridge//Assistant//EN");
    calendar.addSubcomponent(item);
    item.addPropertyWithValue("uid", uid);
  }
  item.updatePropertyWithValue("dtstamp", now);
  item.updatePropertyWithValue("last-modified", now);

  function date(name: string, value: string | undefined, zone = ICAL.Timezone.utcTimezone) {
    item.removeAllProperties(name);
    if (!value) return;
    if (value.length === 10) item.addPropertyWithValue(name, ICAL.Time.fromDateString(value));
    else {
      const time = ICAL.Time.fromJSDate(new Date(value), true).convertToZone(zone);
      const property = item.addPropertyWithValue(name, time);
      if (zone !== ICAL.Timezone.utcTimezone) property.setParameter("tzid", zone.tzid);
    }
  }
  function field(name: string, value: string | number | undefined) {
    if (value === undefined) item.removeAllProperties(name);
    else item.updatePropertyWithValue(name, value);
  }
  if (action.kind !== "todo.complete") {
    if (previous?.value.title !== action.value.title) field("summary", action.value.title);
    if (previous?.value.notes !== action.value.notes) field("description", action.value.notes);
  }
  if (action.kind === "calendar.create" || action.kind === "calendar.reschedule") {
    const before = previous?.value as AgendaEventInput | undefined;
    const { location, startAt, endAt, timeZone, allDay } = action.value;
    if (before?.location !== location) field("location", location);
    if (before?.startAt !== startAt || before?.endAt !== endAt || before?.timeZone !== timeZone) {
      let zone = ICAL.Timezone.utcTimezone;
      if (!allDay && !["UTC", "GMT"].includes(timeZone)) {
        const existing = calendar.getTimeZoneByID(timeZone);
        if (existing) zone = existing;
        else {
          const data = tzlib_get_ical_block(timeZone);
          if (!Array.isArray(data) || !data[0]) throw new AgendaEditError("UNSUPPORTED", "缺少此日程的时区定义。");
          const definition = new ICAL.Component(ICAL.parse(data[0]));
          definition.updatePropertyWithValue("tzid", timeZone);
          calendar.addSubcomponent(definition);
          zone = new ICAL.Timezone(definition);
        }
      }
      item.removeAllProperties("duration");
      date("dtstart", startAt, zone);
      date("dtend", endAt, zone);
    }
    if (previous) item.updatePropertyWithValue("sequence", Number(item.getFirstPropertyValue("sequence") ?? 0) + 1);
  } else {
    const status = action.kind === "todo.complete" ? "completed" : action.value.status;
    field("status", todoStatuses[status]);
    if (status === "completed") {
      item.updatePropertyWithValue("completed", now);
      item.updatePropertyWithValue("percent-complete", 100);
    } else if ((previous?.value as AgendaTodoInput | undefined)?.status === "completed") {
      item.removeAllProperties("completed");
      item.removeAllProperties("percent-complete");
    }
    if (action.kind !== "todo.complete") {
      const before = previous?.value as AgendaTodoInput | undefined;
      const { dueAt, remindAt, priority } = action.value;
      if (before?.priority !== priority) field("priority", priority);
      const alarms = item.getAllSubcomponents("valarm");
      if (before?.dueAt !== dueAt) {
        if (before?.remindAt === remindAt && alarms.some(alarm => {
          const trigger = alarm.getFirstProperty("trigger");
          return trigger?.getFirstValue() instanceof ICAL.Duration && trigger.getFirstParameter("related")?.toUpperCase() === "END";
        })) throw new AgendaEditError("UNSUPPORTED", "修改截止时间会移动相对提醒，请同时明确调整提醒。");
        item.removeAllProperties("duration");
        date("due", dueAt);
      }
      if (before?.remindAt !== remindAt) {
        if (alarms.length > 1 || (alarms.length && alarms[0]!.getFirstPropertyValue("action") !== "DISPLAY")) {
          throw new AgendaEditError("UNSUPPORTED", "暂不支持编辑此日历的多个提醒或非显示提醒。");
        }
        if (alarms[0]) item.removeSubcomponent(alarms[0]);
        if (remindAt) {
          if (remindAt.length === 10) throw new AgendaEditError("INVALID_PARAMS", "CalDAV 提醒需要日期和时间。");
          const alarm = new ICAL.Component("valarm");
          alarm.addPropertyWithValue("action", "DISPLAY");
          alarm.addPropertyWithValue("description", action.value.title);
          const trigger = new ICAL.Property("trigger");
          trigger.resetType("date-time");
          trigger.setValue(ICAL.Time.fromJSDate(new Date(remindAt), true));
          alarm.addProperty(trigger);
          item.addSubcomponent(alarm);
        }
      }
    }
  }
  return `${calendar.toString()}\r\n`;
}

export function canonicalCalendarBody(body: string): string {
  return new ICAL.Component(ICAL.parse(body)).toString();
}
