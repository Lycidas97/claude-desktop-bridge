import { z } from "zod";

const instant = z.iso.datetime({ offset: true }).transform(value => new Date(value).toISOString());
const timestamp = z.union([z.iso.date(), instant]);
const title = z.string().trim().min(1).max(500);
const notes = z.string().max(8000).optional();
const id = z.string().min(1).max(1500);
const revision = z.number().int().positive();
export const todoStatus = z.enum(["pending", "in-progress", "completed", "cancelled"]);
export const todoInput = z.strictObject({
  title, notes, status: todoStatus, priority: z.number().int().min(0).max(9).optional(),
  dueAt: timestamp.optional(), remindAt: timestamp.optional(), mailRefId: z.uuid().optional(),
});
const timeZone = z.string().min(1).max(128).refine(value => {
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; }
  catch (error) { if (error instanceof RangeError) return false; throw error; }
});
export const eventInput = z.strictObject({
  title, notes, startAt: timestamp, endAt: timestamp, allDay: z.boolean(), timeZone,
  location: z.string().max(1000).optional(),
}).refine(({ startAt, endAt, allDay }) => startAt < endAt && [startAt, endAt].every(value => (value.length === 10) === allDay), {
  message: "The end must follow the start, with matching date or time fields",
});
const page = {
  cursor: z.string().regex(/^(?:~|[0-9TZ:.-]{10,28})\|[a-f0-9-]{36,64}$/).optional(), limit: z.number().int().min(1).max(100).optional(),
};
const window = { from: instant, to: instant };
const validWindow = ({ from, to }: { from: string; to: string }) =>
  from < to && Date.parse(to) - Date.parse(from) <= 366 * 86_400_000;
const validDay = ({ from, to }: { from: string; to: string }, date: string) => {
  const civil = Date.parse(date);
  return from < to && Math.max(Date.parse(to), civil + 86_400_000) - Math.min(Date.parse(from), civil) <= 3 * 86_400_000;
};
export const todoList = z.strictObject({ ...page, cursor: z.string().regex(/^[01]\|(?:~|[0-9TZ:.-]{10,28})\|[a-f0-9-]{36,64}$/).optional(), status: todoStatus.optional() });
const eventPage = z.strictObject({ ...page, ...window });
export const eventList = eventPage.refine(validWindow, "Choose a window of up to 366 days");
export const freeSlotQuery = z.strictObject({ ...window, durationMinutes: z.number().int().min(1).max(1440) }).refine(validWindow, "Choose a window of up to 366 days");
const existing = z.strictObject({ id, revision });
const secret = z.string().min(1).max(1024);
export const agendaRequests = {
  "plugin.assistant-agenda.todo.list": todoList.extend({ dueOn: z.strictObject({ date: z.iso.date(), ...window }).refine(query => validDay(query, query.date)).optional() }),
  "plugin.assistant-agenda.event.list": eventPage.extend({ allDayOn: z.iso.date().optional() })
    .refine(query => query.allDayOn ? validDay(query, query.allDayOn) : validWindow(query)),
  "plugin.assistant-agenda.todo.save": z.strictObject({ existing: existing.optional(), value: todoInput }),
  "plugin.assistant-agenda.event.save": z.strictObject({ existing: existing.optional(), value: eventInput }),
  "plugin.assistant-agenda.todo.complete": z.strictObject({ ...existing.shape, completed: z.boolean() }),
  "plugin.assistant-agenda.source.add": z.strictObject({ label: title, url: z.url({ protocol: /^https$/ }).max(1500), user: z.string().trim().min(1).max(320).refine(value => !value.includes(":")), credential: secret }),
  "plugin.assistant-agenda.source.credential": z.strictObject({ id, credential: secret }),
  "plugin.assistant-agenda.source.enable": z.strictObject({ id, enabled: z.boolean() }),
  "plugin.assistant-agenda.source.refresh": z.strictObject({ id }),
  "plugin.assistant-agenda.source.remove": z.strictObject({ id }),
} as const;