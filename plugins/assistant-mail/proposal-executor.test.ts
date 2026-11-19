import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgendaEventInput } from "../../packages/protocol/src/assistant-agenda.js";
import { AgendaStore } from "./agenda-store.js";
import { requestCalDavMember } from "./caldav.js";
import { proposalAction } from "./proposal-contract.js";
import { ProposalExecutor } from "./proposal-executor.js";
import { ProposalStore } from "./proposal-store.js";

const meeting: AgendaEventInput = { title: "Review", startAt: "2027-01-04T14:00:00.000Z", endAt: "2027-01-04T15:00:00.000Z", allDay: false, timeZone: "UTC" };
const window = { from: "2027-01-04T00:00:00Z", to: "2027-01-05T00:00:00Z" };
const collection = "https://calendar.example.test/work/";
const href = `${collection}review.ics`;
const sourceBody = ["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:review", "SUMMARY:Original", "DTSTART:20270104T120000Z",
  "DTEND:20270104T130000Z", "ORGANIZER:mailto:owner@example.test", "ATTENDEE;CN=Team:mailto:team@example.test", "END:VEVENT", "END:VCALENDAR", ""].join("\r\n");
const credentials = { available: () => true, encrypt: (value: string) => Buffer.from(value), decrypt: (value: Uint8Array) => Buffer.from(value).toString() };
let db: DatabaseSync;
let agenda: AgendaStore;
let ledger: ProposalStore;
let service: ProposalExecutor;
let directory: string;
let file: string;
const notifyAgenda = vi.fn();
const fetchDav = vi.fn<typeof fetch>();
function open() {
  db = new DatabaseSync(file);
  agenda = new AgendaStore(db, "UTC");
  ledger = new ProposalStore(db);
  service = new ProposalExecutor(ledger, agenda, credentials, notifyAgenda, options => requestCalDavMember(options, fetchDav));
}
function seedRemote(body = sourceBody) {
  const id = agenda.addSource({ label: "Work", url: collection, user: "owner" }, Buffer.from("fixture-credential"));
  agenda.applySync(id, { changed: [{ href, data: body, etag: '"version-one"' }], removed: [], proposalCreateKinds: ["calendar"] });
  return id;
}
beforeEach(() => {
  notifyAgenda.mockReset();
  fetchDav.mockReset();
  directory = mkdtempSync(join(tmpdir(), "bridge-proposal-"));
  file = join(directory, "assistant.sqlite");
  open();
});
afterEach(async () => {
  await service.close();
  db.close();
  rmSync(directory, { recursive: true });
});

it("stores immutable snapshots, rejects stale, wrong hash and repeat approvals, and attributes the one successful write", async () => {
  const first = await service.create("bound-session", { kind: "todo.create", sourceId: "local", value: { title: "Draft", status: "pending" } });
  const updated = await service.revise(first, { kind: "todo.create", sourceId: "local", value: { title: "Revised", status: "pending" } });
  expect(updated).toMatchObject({ proposalId: first.proposalId, revision: 2 });
  expect(updated.payloadHash).not.toBe(first.payloadHash);
  expect(agenda.listTodos({}).records).toHaveLength(0);
  expect(db.prepare("SELECT revision, hash FROM action_proposals ORDER BY revision").all()).toEqual([
    { revision: 1, hash: first.payloadHash }, { revision: 2, hash: updated.payloadHash },
  ]);
  expect(service.resolve("different-session", [first])).toEqual([]);
  expect(service.resolve("bound-session", [first])).toEqual([updated]);
  await expect(service.commit(first, "stale-phone")).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(service.commit({ ...first, revision: 2 }, "bad-hash")).rejects.toMatchObject({ code: "CONFLICT" });
  const results = await Promise.allSettled([service.commit(updated, "paired-phone"), service.commit(updated, "bridge-desktop")]);
  expect(results.map(item => item.status)).toEqual(["fulfilled", "rejected"]);
  expect(agenda.listTodos({}).records.map(record => record.title)).toEqual(["Revised"]);
  expect(db.prepare("SELECT actor, state FROM proposal_executions").all()).toEqual([{ actor: "paired-phone", state: "applied" }]);
  expect(notifyAgenda).toHaveBeenCalledExactlyOnceWith("local");
});

it("does not rebase a manual edit or overwrite a changed local task or event", async () => {
  const task = agenda.saveTodo({ title: "Original", status: "pending" });
  const event = agenda.saveEvent(meeting);
  const finish = await service.create("bound-session", { kind: "todo.complete", recordId: task.id });
  const remove = await service.create("bound-session", { kind: "calendar.delete", recordId: event.id });
  const reschedule = await service.create("bound-session", { kind: "calendar.reschedule", recordId: event.id, value: { ...meeting, title: "Proposed" } });
  agenda.saveTodo({ title: "External edit", status: "pending" }, task);
  agenda.saveEvent({ ...meeting, title: "Externally moved" }, event);
  await expect(service.revise(reschedule, { kind: "calendar.reschedule", recordId: event.id, value: meeting })).rejects.toThrow("目标记录已更新");
  for (const ref of [finish, remove, reschedule]) await expect(service.commit(ref, "paired-phone")).resolves.toMatchObject({ state: "conflict" });
  expect(agenda.listTodos({}).records[0]).toMatchObject({ title: "External edit", status: "pending" });
  expect(agenda.listEvents(window).records[0]?.title).toBe("Externally moved");
});

it("conditionally updates a CalDAV member without reconstructing its attendees, and returns conflict on 412", async () => {
  seedRemote();
  const event = agenda.listEvents(window).records[0]!;
  const ref = await service.create("bound-session", { kind: "calendar.reschedule", recordId: event.id, value: meeting });
  expect(fetchDav).not.toHaveBeenCalled();
  fetchDav.mockResolvedValueOnce(new Response(null, { status: 412 }));
  await expect(service.commit(ref, "desktop")).resolves.toMatchObject({ state: "conflict" });
  expect(fetchDav).toHaveBeenCalledOnce();
  const [address, request] = fetchDav.mock.calls[0]!;
  expect(String(address)).toBe(href);
  expect(request).toMatchObject({ method: "PUT", redirect: "manual", headers: { "If-Match": '"version-one"' } });
  expect(request?.body).toContain("ATTENDEE;CN=Team:mailto:team@example.test");
  expect(request?.body).toContain("DTSTART:20270104T140000Z");
  expect(agenda.listEvents(window).records[0]?.title).toBe("Original");
});

it("creates at a fixed address with If-None-Match, and duplicates cannot issue a second write while the first is in flight", async () => {
  const sourceId = seedRemote();
  const initial = await service.create("bound-session", { kind: "calendar.create", sourceId: "local", value: meeting });
  const revised = await service.revise(initial, { kind: "calendar.create", sourceId, value: meeting });
  expect(revised.payloadHash).not.toBe(initial.payloadHash);
  let release!: (value: Response) => void;
  fetchDav.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
  const committing = service.commit(revised, "phone");
  await expect(service.commit(revised, "desktop")).rejects.toMatchObject({ code: "CONFLICT" });
  expect(db.prepare("SELECT state FROM proposal_executions").get()).toEqual({ state: "executing" });
  const [address, request] = fetchDav.mock.calls[0]!;
  expect(String(address)).toBe(`${collection}${initial.proposalId}.ics`);
  expect(request).toMatchObject({ method: "PUT", headers: { "If-None-Match": "*" } });
  expect(request?.body).toContain(`UID:${initial.proposalId}`);
  release(new Response(null, { status: 201 }));
  await expect(committing).resolves.toMatchObject({ state: "applied" });
  expect(fetchDav).toHaveBeenCalledOnce();
});

it.each([true, false])("recovers a persisted external attempt by GET only (matching remote bytes: %s)", async matches => {
  const sourceId = seedRemote();
  const ref = await service.create("bound-session", { kind: "calendar.create", sourceId, value: meeting });
  const persisted = ledger.requirePending(ref);
  ledger.transaction(() => ledger.claim(persisted, "phone", "executing"));
  if (persisted.intent.backend !== "caldav" || persisted.intent.write.method !== "PUT") throw new Error("Expected persisted PUT");
  db.close();
  open();
  fetchDav.mockResolvedValueOnce(new Response(matches ? persisted.intent.write.body : sourceBody, { status: 200 }));
  service.start();
  await service.close();
  expect(fetchDav.mock.calls.map(([address, request]) => [String(address), request?.method])).toEqual([[`${collection}${ref.proposalId}.ics`, "GET"]]);
  expect(service.resolve("bound-session", [ref])[0]?.state).toBe(matches ? "applied" : "uncertain");
  await expect(service.commit(ref, "different-phone")).rejects.toMatchObject({ code: "CONFLICT" });
  expect(fetchDav).toHaveBeenCalledOnce();
});

it("applies local task updates, completion and calendar deletion only after confirmation", async () => {
  const task = agenda.saveTodo({ title: "Original task", status: "pending" });
  const event = agenda.saveEvent(meeting);
  const change = await service.create("bound-session", { kind: "todo.update", recordId: task.id, value: { title: "Revised task", status: "pending" } });
  const remove = await service.create("bound-session", { kind: "calendar.delete", recordId: event.id });
  expect(agenda.listTodos({}).records[0]?.title).toBe("Original task");
  expect(agenda.listEvents(window).records).toHaveLength(1);
  await expect(service.commit(change, "desktop")).resolves.toMatchObject({ state: "applied" });
  const complete = await service.create("bound-session", { kind: "todo.complete", recordId: task.id });
  await expect(service.commit(complete, "desktop")).resolves.toMatchObject({ state: "applied" });
  expect(agenda.listTodos({}).records[0]).toMatchObject({ title: "Revised task", status: "completed" });
  await expect(service.commit(remove, "desktop")).resolves.toMatchObject({ state: "applied" });
  expect(agenda.listEvents(window).records).toEqual([]);
});

it("completes a VTODO with If-Match and preserves its due date and priority", async () => {
  seedRemote(["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VTODO", "UID:work", "SUMMARY:Review task", "DUE;VALUE=DATE:20270104",
    "STATUS:NEEDS-ACTION", "PRIORITY:2", "END:VTODO", "END:VCALENDAR", ""].join("\r\n"));
  const task = agenda.listTodos({}).records[0]!;
  const ref = await service.create("bound-session", { kind: "todo.complete", recordId: task.id });
  fetchDav.mockResolvedValueOnce(new Response(null, { status: 204 }));
  await expect(service.commit(ref, "phone")).resolves.toMatchObject({ state: "applied" });
  const [address, request] = fetchDav.mock.calls[0]!;
  expect(String(address)).toBe(href);
  expect(request).toMatchObject({ method: "PUT", headers: { "If-Match": '"version-one"' } });
  expect(request?.body).toContain("DUE;VALUE=DATE:20270104");
  expect(request?.body).toContain("PRIORITY:2");
  expect(request?.body).toContain("STATUS:COMPLETED");
  expect(request?.body).toContain("PERCENT-COMPLETE:100");
});

it("checks that a CalDAV deletion with a lost reply left the reviewed resource absent", async () => {
  seedRemote();
  const event = agenda.listEvents(window).records[0]!;
  const ref = await service.create("bound-session", { kind: "calendar.delete", recordId: event.id });
  fetchDav.mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(new Response(null, { status: 404 }));
  await expect(service.commit(ref, "phone")).resolves.toMatchObject({ state: "applied" });
  expect(fetchDav.mock.calls.map(([address, request]) => [String(address), request?.method])).toEqual([[href, "DELETE"], [href, "GET"]]);
  expect(fetchDav.mock.calls[0]?.[1]?.headers).toMatchObject({ "If-Match": '"version-one"' });
});

it("does not let an old Native receipt expose a model revision or its manual descendant", async () => {
  const action = { kind: "todo.create", sourceId: "local", value: { title: "Initial", status: "pending" } } as const;
  const first = await service.create("bound-session", action);
  const detached = await service.reviseFromTool("bound-session", first, { ...action, value: { ...action.value, title: "Unanchored" } });
  expect(service.resolve("bound-session", [first])).toEqual([]);
  const edited = await service.revise(detached, { ...action, value: { ...action.value, title: "Manually edited" } });
  expect(service.resolve("bound-session", [first])).toEqual([]);
  expect(service.resolve("bound-session", [first], true)).toEqual([edited]);
  expect(service.resolve("other-session", [detached], true)).toEqual([]);
  expect(service.resolve("bound-session", [detached])).toEqual([edited]);
});

it("preserves full untouched CalDAV text properties when changing event times", async () => {
  const notes = `${"x".repeat(8000)}TAIL`;
  const summary = `${"x".repeat(499)} TITLETAIL`;
  const location = `${"x".repeat(1000)}PLACETAIL`;
  seedRemote(sourceBody.replace("SUMMARY:Original", `SUMMARY:${summary}\r\nDESCRIPTION:${notes}\r\nLOCATION:${location}`));
  const { id, title, notes: displayedNotes, location: displayedLocation } = agenda.listEvents(window).records[0]!;
  const ref = await service.create("bound-session", proposalAction.parse({ kind: "calendar.reschedule", recordId: id,
    value: { ...meeting, title, notes: displayedNotes, location: displayedLocation } }));
  fetchDav.mockResolvedValueOnce(new Response(null, { status: 204 }));
  await service.commit(ref, "phone");
  const unfolded = String(fetchDav.mock.calls[0]?.[1]?.body).replace(/\r\n[ \t]/gu, "");
  expect(unfolded).toContain(`SUMMARY:${summary}\r\n`);
  expect(unfolded).toContain(`DESCRIPTION:${notes}\r\n`);
  expect(unfolded).toContain(`LOCATION:${location}\r\n`);
});

it("preserves the approved CalDAV event timezone when rescheduling and importing it again", async () => {
  const sourceId = seedRemote(sourceBody.replace("DTSTART:20270104T120000Z", "DTSTART;TZID=America/New_York:20270104T090000")
    .replace("DTEND:20270104T130000Z", "DTEND;TZID=America/New_York:20270104T100000"));
  const event = agenda.listEvents(window).records[0]!;
  const next = { ...meeting, startAt: "2027-01-04T15:00:00.000Z", endAt: "2027-01-04T16:00:00.000Z", timeZone: event.timeZone };
  const ref = await service.create("bound-session", { kind: "calendar.reschedule", recordId: event.id, value: next });
  fetchDav.mockResolvedValueOnce(new Response(null, { status: 204 }));
  await service.commit(ref, "phone");
  const body = String(fetchDav.mock.calls[0]?.[1]?.body);
  expect(body).toContain("BEGIN:VTIMEZONE");
  expect(body).toContain("DTSTART;TZID=America/New_York:20270104T100000");
  agenda.applySync(sourceId, { changed: [{ href, data: body, etag: '"version-two"' }], removed: [] });
  expect(agenda.listEvents(window).records[0]).toMatchObject(next);
});

it.each(["05:30", "06:30"])("rejects an ambiguous NY CalDAV start of %s UTC before creating a proposal", async start => {
  const sourceId = seedRemote();
  const action = proposalAction.parse({ kind: "calendar.create", sourceId, value: {
    ...meeting, startAt: `2027-11-07T${start}:00.000Z`, endAt: "2027-11-07T07:30:00.000Z", timeZone: "America/New_York",
  } });
  await expect(service.create("bound-session", action)).rejects.toThrow("夏令时");
  expect(service.snapshot().pendingCount).toBe(0);
  expect(fetchDav).not.toHaveBeenCalled();
});

it("round-trips an unambiguous New York event on the DST fallback date", async () => {
  const sourceId = seedRemote();
  const value = { ...meeting, startAt: "2027-11-07T07:30:00.000Z", endAt: "2027-11-07T08:30:00.000Z", timeZone: "America/New_York" };
  const ref = await service.create("bound-session", proposalAction.parse({ kind: "calendar.create", sourceId, value }));
  fetchDav.mockResolvedValueOnce(new Response(null, { status: 201 }));
  await expect(service.commit(ref, "phone")).resolves.toMatchObject({ state: "applied" });
  const [target, request] = fetchDav.mock.calls[0]!;
  expect(request).toMatchObject({ method: "PUT", headers: { "If-None-Match": "*" } });
  agenda.applySync(sourceId, { changed: [{ href: String(target), etag: '"created"', data: String(request?.body) }], removed: [] });
  expect(agenda.listEvents({ from: "2027-11-07T00:00:00Z", to: "2027-11-08T00:00:00Z" }).records[0]).toMatchObject(value);
});

it("does not silently move a task's approved reminder when moving its deadline", async () => {
  seedRemote(["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VTODO", "UID:work", "SUMMARY:Review task", "DUE:20270105T170000Z",
    "BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:Review task", "TRIGGER;RELATED=END:-PT30M", "END:VALARM", "END:VTODO", "END:VCALENDAR", ""].join("\r\n"));
  const { id, title, status, remindAt } = agenda.listTodos({}).records[0]!;
  expect(remindAt).toBe("2027-01-05T16:30:00.000Z");
  await expect(service.create("bound-session", { kind: "todo.update", recordId: id, value: { title, status, remindAt, dueAt: "2027-01-07T17:00:00.000Z" } })).rejects.toThrow("相对提醒");
  expect(service.snapshot().pendingCount).toBe(0);
  expect(fetchDav).not.toHaveBeenCalled();
});

it("reconciles a 202 response without declaring a queued DELETE applied or resending it", async () => {
  seedRemote();
  const event = agenda.listEvents(window).records[0]!;
  const ref = await service.create("bound-session", { kind: "calendar.delete", recordId: event.id });
  fetchDav.mockResolvedValueOnce(new Response(null, { status: 202 })).mockResolvedValueOnce(new Response(sourceBody, { status: 200 }));
  await expect(service.commit(ref, "phone")).resolves.toMatchObject({ state: "uncertain" });
  expect(fetchDav.mock.calls.map(([, request]) => request?.method)).toEqual(["DELETE", "GET"]);
});

it("rejects deleting one occurrence through a resource-wide CalDAV DELETE", async () => {
  seedRemote(sourceBody.replace("END:VEVENT", "RRULE:FREQ=DAILY;COUNT=2\r\nEND:VEVENT"));
  const event = agenda.listEvents(window).records[0]!;
  await expect(service.create("bound-session", { kind: "calendar.delete", recordId: event.id })).rejects.toThrow("重复实例");
  expect(fetchDav).not.toHaveBeenCalled();
});
