import type { AgendaPage } from "@bridge/protocol";

export async function rereadAgendaPages<T>(
  read: (cursor?: string) => Promise<AgendaPage<T>>,
  loadedPages: number,
  signal?: AbortSignal,
): Promise<AgendaPage<T> & { pages: number }> {
  const records: T[] = [];
  let pages = 0;
  let nextCursor: string | undefined;
  do {
    const page = await read(nextCursor);
    records.push(...page.records);
    nextCursor = page.nextCursor;
    pages += 1;
  } while (nextCursor && pages < loadedPages && !signal?.aborted);
  return { records, pages, nextCursor };
}

export function agendaInputTime(instant: string, timeZone: string): string {
  if (instant.length === 10) return instant;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(instant));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

/** Convert the form's wall time in its selected zone. A repeated time defaults to the earlier instant. */
export function agendaInstant(value: string, timeZone: string, original?: string): string {
  if (value.length === 10) return value;
  if (original && agendaInputTime(original, timeZone) === value) return original;
  const nominal = Date.parse(`${value}Z`);
  // Sample offsets on both sides to cover changes at daylight-saving transitions.
  for (const sample of [nominal - 86_400_000, nominal + 86_400_000]) {
    const offset = Date.parse(`${agendaInputTime(new Date(sample).toISOString(), timeZone)}Z`) - sample;
    const instant = new Date(nominal - offset).toISOString();
    if (agendaInputTime(instant, timeZone) === value) return instant;
  }
  throw new Error("此时区没有这个时间，请选择另一个时间。");
}
