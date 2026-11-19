import ICAL from "ical.js";
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

  function date(name: string, value: string | undefined) {
    item.removeAllProperties(name);
    if (value) item.addPropertyWithValue(name, value.length === 10 ? ICAL.Time.fromDateString(value) : ICAL.Time.fromJSDate(new Date(value), true));
  }
  function field(name: string, value: string | number | undefined) {
    if (value === undefined) item.removeAllProperties(name);
    else item.updatePropertyWithValue(name, value);
  }
  if (action.kind !== "todo.complete") {
    field("summary", action.value.title);
    field("description", action.value.notes);
  }
  if (action.kind === "calendar.create" || action.kind === "calendar.reschedule") {
    const before = previous?.value as AgendaEventInput | undefined;
    field("location", action.value.location);
    if (before?.startAt !== action.value.startAt || before?.endAt !== action.value.endAt) {
      item.removeAllProperties("duration");
      date("dtstart", action.value.startAt);
      date("dtend", action.value.endAt);
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
      field("priority", priority);
      if (before?.dueAt !== dueAt) {
        item.removeAllProperties("duration");
        date("due", dueAt);
      }
      if (before?.remindAt !== remindAt) {
        const alarms = item.getAllSubcomponents("valarm");
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
