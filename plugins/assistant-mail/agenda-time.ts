import ICAL from "ical.js";

export type AgendaZone = string | ICAL.Timezone;

export function collectionZone(data: string | null | undefined, fallback: string): AgendaZone {
  if (!data) return fallback;
  const value = new ICAL.Component(ICAL.parse(data));
  const zone = value.name === "vtimezone" ? value : value.getFirstSubcomponent("vtimezone");
  if (!zone?.getFirstPropertyValue("tzid")) throw new Error("Invalid CalDAV calendar-timezone");
  return new ICAL.Timezone(zone);
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
  const formatter = new Intl.DateTimeFormat("en", { timeZone: zone, timeZoneName: "longOffset" });
  const offsetAt = (instant: number) => {
    const name = formatter.formatToParts(instant).find(part => part.type === "timeZoneName")!.value;
    const match = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
    return match ? (match[1] === "-" ? -1 : 1) * (+match[2]! * 60 + +match[3]!) * 60_000 : 0;
  };
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
