import ICAL from "ical.js";

export type AgendaZone = string | ICAL.Timezone;

export function collectionZone(data: string | null | undefined, fallback: string): AgendaZone {
  if (!data) return fallback;
  const value = new ICAL.Component(ICAL.parse(data));
  const zone = value.name === "vtimezone" ? value : value.getFirstSubcomponent("vtimezone");
  if (!zone?.getFirstPropertyValue("tzid")) throw new Error("Invalid CalDAV calendar-timezone");
  return new ICAL.Timezone(zone);
}

function zoneOffsets(timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en", { timeZone, timeZoneName: "longOffset" });
  return (instant: number) => {
    const name = formatter.formatToParts(instant).find(part => part.type === "timeZoneName")!.value;
    const match = /GMT([+-])(\d{2}):(\d{2})(?::(\d{2}))?/u.exec(name);
    return match ? (match[1] === "-" ? -1 : 1) * ((+match[2]! * 60 + +match[3]!) * 60 + Number(match[4] ?? 0)) * 1000 : 0;
  };
}

/** A repeated local clock time cannot select one instant consistently across iCalendar clients. */
export function isRepeatedWallTime(instant: number, timeZone: string): boolean {
  const offsetAt = zoneOffsets(timeZone);
  const offset = offsetAt(instant);
  return [-86_400_000, 86_400_000].some(day => {
    const alternateOffset = offsetAt(instant + day);
    return alternateOffset !== offset && offsetAt(instant + offset - alternateOffset) === alternateOffset;
  });
}

/** Interpret a date or floating wall time in its calendar zone. */
export function agendaInstant(value: string, zone: AgendaZone): number {
  if (value.endsWith("Z")) return Date.parse(value);
  const wall = value.length === 10 ? `${value}T00:00:00` : value;
  if (typeof zone !== "string") {
    const time = ICAL.Time.fromDateTimeString(wall);
    time.zone = zone;
    return time.toUnixTime() * 1000;
  }
  const utc = Date.parse(`${wall}Z`);
  const offsetAt = zoneOffsets(zone);
  return utc - offsetAt(utc - offsetAt(utc));
}

export function timestamp(time: ICAL.Time, zone: AgendaZone): string {
  if (time.isDate) return time.toString();
  if (time.zone !== ICAL.Timezone.localTimezone) return time.toJSDate().toISOString();
  return new Date(agendaInstant(time.toString(), zone)).toISOString();
}

export function componentZone(component: ICAL.Component, fallback: AgendaZone): AgendaZone {
  const property = component.getFirstProperty("dtstart") ?? component.getFirstProperty("due");
  const time = property?.getFirstValue();
  if (time instanceof ICAL.Time && time.zone !== ICAL.Timezone.localTimezone) return time.zone;
  const label = property?.getFirstParameter("tzid");
  return label && (typeof fallback === "string" || fallback.tzid !== label) ? label : fallback;
}
