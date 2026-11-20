import * as fs from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AssistantMailStore } from "./store.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

let root: string;
let store: AssistantMailStore;
const openDatabases: DatabaseSync[] = [];

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "assistant-mail-store-"));
  store = new AssistantMailStore(root);
  await store.initialize();
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const database of openDatabases.splice(0)) database.close();
  store.close();
  await fs.rm(root, { recursive: true, force: true });
});

const message = (uid = 5, uidValidity = "1") => ({
  accountKey: "test-account", mailbox: "INBOX" as const, uidValidity, uid,
  subject: "<img src=https://tracker.invalid/x>", from: [{ address: "sender@example.test", name: "External sender" }],
  receivedAt: "2026-11-14T12:00:00.000Z", source: Buffer.from("Subject: raw\r\n\r\nBody\0binary\xff", "latin1"),
});

it("ignores historical UIDs on enable and resumes the committed watermark after restart", async () => {
  expect(store.openMailbox("test-account", "1", 5)).toBe(4);
  const event = await store.record(message());
  expect(event).toMatchObject({ uid: 5, uidValidity: "1", processingStatus: "pending" });
  expect(await store.read(event!.mailRefId)).toEqual({ event, source: message().source });
  store.close();
  store = new AssistantMailStore(root);
  await store.initialize();
  expect(store.openMailbox("test-account", "1", 99)).toBe(5);
  expect(store.page().events).toEqual([event]);
});

it("shows new mail immediately and separates attention from read and processing state", async () => {
  store.openMailbox("test-account", "1", 5);
  const { mailRefId: id } = (await store.record(message()))!;
  const analysis = { summary: "screened", suggestions: [], questions: [] };
  expect(store.attention(false)).toMatchObject([{ id, reason: "new" }]);
  expect(store.attention(true)).toMatchObject([{ id, reason: "unscreened" }]);
  store.setProcessingStatus(id, "processed");
  store.markRead([id]);
  expect(store.attention(true)).toMatchObject([{ id, reason: "unscreened" }]);
  store.updateAnalysis(id, { ...analysis, attention: "read", category: "account" });
  expect(store.attention(true)).toMatchObject([{ id, reason: "read" }]);
  store.acknowledgeAttention("mail", id);
  expect(store.attention(false)).toEqual([]);
  store.updateAnalysis(id, { ...analysis, attention: "action" });
  store.updateAnalysis(id, { ...analysis, summary: "updated" });
  expect(store.attention(true)).toMatchObject([{ id, reason: "action" }]);
  store.acknowledgeAttention("mail-action", id);
  store.close();
  store = new AssistantMailStore(root);
  await store.initialize();
  expect(store.attention(true)).toEqual([]);
  expect(store.page().events[0]).toMatchObject({ processingStatus: "processed", hostRead: true, analysis: { attention: "action", category: "account" } });
});

it("suppresses marked mail attention without acknowledging it", async () => {
  store.openMailbox("test-account", "1", 5);
  const { mailRefId } = (await store.record(message()))!;
  store.recordReply("current", "reply", "Separate reply");
  expect(store.attention(true, "current").map(item => item.id)).toEqual([mailRefId, "reply"]);
  store.setJunk(mailRefId, true);
  expect(store.attention(true, "current")).toEqual([{ kind: "reply", id: "reply", title: "Separate reply", sessionId: "current" }]);
  store.updateAnalysis(mailRefId, { summary: "Review", suggestions: [], questions: [], attention: "action" });
  expect(store.attention(false, "current").map(item => item.id)).toEqual(["reply"]);
  store.setJunk(mailRefId, false);
  expect(store.attention(false, "current").map(item => item.id)).toEqual([mailRefId, "reply"]);
});

it("pages by receipt time across accounts and imports, with a stable anchor that can leave the folder", async () => {
  store.openMailbox("test-account", "1", 1);
  store.openMailbox("other-account", "1", 1);
  const live = (await store.record(message(1)))!;
  const late = (await store.record({ ...message(1), accountKey: "other-account", receivedAt: "2026-11-13T15:00:00.000Z" }))!;
  const newest = (await store.record({ ...message(2), historical: true, receivedAt: "2026-11-15T19:00:00.000Z" }))!;
  const tied = (await store.record({ ...message(2), accountKey: "other-account", historical: true, receivedAt: "2026-11-14T13:00:00+01:00" }))!;
  const undated = (await store.record({ ...message(3), historical: true, receivedAt: "now" }))!;
  const first = store.page({ limit: 2 }, true, "inbox", true, true);
  expect(first).toEqual({ events: [newest, tied], nextCursor: String(tied.seq) });
  store.changeCategory({ action: "add", label: "Project receipts" });
  const category = store.categories().at(-1)!.id;
  store.setFolder(tied.mailRefId, category, "user");
  expect(store.page({ cursor: first.nextCursor }, true, "inbox", true, true).events).toEqual([live, late, undated]);
  expect(store.page({}, false, "inbox", true, true).events).toEqual([live, late]);
  store.setFolder(late.mailRefId, category, "user");
  const folder = store.page({ limit: 1 }, true, category, true, true);
  expect(folder.events.map(event => event.mailRefId)).toEqual([tied.mailRefId]);
  expect(store.page({ cursor: folder.nextCursor }, true, category, true, true).events.map(event => event.mailRefId)).toEqual([late.mailRefId]);
  expect(store.page({}, true, { query: "External sender" }, true, true).events.map(event => event.mailRefId))
    .toEqual([newest, tied, live, late, undated].map(event => event.mailRefId));
  expect(store.page({}, true, "inbox", false, true).events).toEqual([newest, tied, live, late, undated]);
});

it("pages and searches saved folders independently and keeps an explicit restore after restart", async () => {
  store.openMailbox("test-account", "1", 5);
  const old = (await store.record({ ...message(5), subject: "Test 5%" }))!;
  const verification = (await store.record({ ...message(6), subject: "Test 6%" }))!;
  const promo = (await store.record({ ...message(7), subject: "Test 7%" }))!;
  const junk = (await store.record({ ...message(8), subject: "Test 8%" }))!;
  const analysis = { summary: "screened", suggestions: [], questions: [] };
  store.updateAnalysis(verification.mailRefId, { ...analysis, category: "verification" });
  store.updateAnalysis(verification.mailRefId, { ...analysis, category: "marketing" });
  store.updateAnalysis(promo.mailRefId, { ...analysis, category: "marketing", attention: "action" });
  store.setJunk(junk.mailRefId, true);
  expect(store.page({ limit: 2 }, true, "inbox").events.map(event => event.mailRefId)).toEqual([verification.mailRefId, old.mailRefId]);
  expect(store.folderCounts(true)).toEqual({ marketing: 2 });
  const first = store.page({ limit: 1 }, true, "marketing");
  expect(first.events.map(event => event.mailRefId)).toEqual([junk.mailRefId]);
  expect(store.page({ cursor: first.nextCursor }, true, "marketing").events.map(event => event.mailRefId)).toEqual([promo.mailRefId]);
  expect(store.page({}, true, { query: "TEST 8%" }).events).toMatchObject([{ mailRefId: junk.mailRefId, folder: "marketing" }]);
  expect(store.page({}, true, { query: "external sender" }).events).toHaveLength(4);
  expect(store.page({}, true, { query: "Body" }).events).toHaveLength(4);
  expect(store.attention(true).map(item => item.id)).toEqual([verification.mailRefId, old.mailRefId]);
  expect(store.setFolder(verification.mailRefId, "verification", "assistant")).toBe(true);
  expect(store.folderCounts(true)).toEqual({ marketing: 2, verification: 1 });
  expect(store.setFolder(junk.mailRefId, "inbox", "user")).toBe(true);
  expect(store.setFolder(promo.mailRefId, "inbox", "user")).toBe(true);
  store.close();
  store = new AssistantMailStore(root);
  await store.initialize();
  expect(store.setFolder(promo.mailRefId, "account", "assistant")).toBe(false);
  expect(store.updateAnalysis(promo.mailRefId, { ...analysis, category: "marketing" })).not.toHaveProperty("folder");
  expect(store.attention(true)).toContainEqual({ kind: "mail", id: promo.mailRefId, title: promo.subject, reason: "action" });
  expect(store.page({}, true, "inbox").events.map(event => event.mailRefId)).toContain(junk.mailRefId);
  expect(store.page({}, true, "legacy").events.map(event => event.mailRefId)).toContain(junk.mailRefId);
});

it("keeps category IDs across renames and returns mail from a deleted category without deleting the original", async () => {
  store.openMailbox("test-account", "1", 5);
  const userMail = (await store.record(message(5)))!;
  const assistantMail = (await store.record(message(6)))!;
  const promo = (await store.record(message(7)))!;
  const junk = (await store.record(message(8)))!;
  store.changeCategory({ action: "add", label: "订单" });
  const { id } = store.categories().at(-1)!;
  const analysis = { summary: "订单已发货", suggestions: ["查看物流"], questions: [], attention: "action" as const };
  expect(store.updateAnalysis(userMail.mailRefId, { ...analysis, category: id })).not.toHaveProperty("folder");
  store.setFolder(userMail.mailRefId, id, "user");
  store.setFolder(assistantMail.mailRefId, id, "assistant");
  store.markRead([userMail.mailRefId]);
  store.setProcessingStatus(userMail.mailRefId, "processed");
  store.changeCategory({ action: "rename", id, label: "采购记录" });
  expect(store.categories().at(-1)).toEqual({ id, label: "采购记录" });
  expect(store.page({}, true, id).events.map(event => event.mailRefId)).toEqual([assistantMail.mailRefId, userMail.mailRefId]);

  store.changeCategory({ action: "rename", id: "marketing", label: "广告" });
  expect(() => store.changeCategory({ action: "delete", id: "marketing" })).toThrow("此分类用于垃圾邮件和自动收纳，不能删除");
  store.updateAnalysis(promo.mailRefId, { ...analysis, category: "marketing" });
  store.setJunk(junk.mailRefId, true);
  store.changeCategory({ action: "delete", id });
  store.changeCategory({ action: "delete", id: "account" });
  store.close();
  store = new AssistantMailStore(root);
  await store.initialize();

  expect(store.categories()).toEqual([{ id: "marketing", label: "广告" }, { id: "verification", label: "验证码" }, { id: "other", label: "其他" }]);
  expect(store.folderCounts(true)).toEqual({ marketing: 2 });
  expect(store.page({}, true, "inbox").events.map(event => event.mailRefId)).toEqual([assistantMail.mailRefId, userMail.mailRefId]);
  const original = (await store.read(userMail.mailRefId))!;
  expect(original.source).toEqual(message(5).source);
  expect(original.event).toMatchObject({ hostRead: true, processingStatus: "processed", analysis });
  expect(original.event.analysis).not.toHaveProperty("category");
  expect(store.setFolder(userMail.mailRefId, "verification", "assistant")).toBe(false);
  expect(store.setFolder(assistantMail.mailRefId, "verification", "assistant")).toBe(false);
  expect(store.attention(false)).toContainEqual({ kind: "mail", id: userMail.mailRefId, title: userMail.subject, reason: "action" });
});

it("keeps custom-filed mail visible after rollback and honors the old host's moves on re-upgrade", async () => {
  store.openMailbox("test-account", "1", 5);
  const kept = (await store.record(message(5)))!;
  const moved = (await store.record(message(6)))!;
  const olderCategory = (await store.record(message(7)))!;
  store.changeCategory({ action: "add", label: "订单" });
  const { id } = store.categories().at(-1)!;
  store.changeCategory({ action: "delete", id: "account" });
  store.setFolder(kept.mailRefId, id, "user");
  store.setFolder(moved.mailRefId, id, "user");
  store.close();

  const previous = new DatabaseSync(join(store.directory, "assistant.sqlite"));
  try {
    // The previous host reads only filing, user_junk and the legacy marketing fallback.
    const inbox = previous.prepare(`SELECT mail_ref_id FROM mail_events WHERE
      CASE WHEN user_junk = 1 THEN 'marketing' WHEN filing IS NOT NULL THEN replace(filing, 'user:', '')
        WHEN json_extract(analysis_json, '$.category') = 'marketing' THEN 'marketing' ELSE 'inbox' END = 'inbox'
      ORDER BY seq`);
    expect(inbox.all().map(row => row.mail_ref_id)).toEqual([kept.mailRefId, moved.mailRefId, olderCategory.mailRefId]);
    const file = previous.prepare("UPDATE mail_events SET user_junk = 0, filing = ? WHERE mail_ref_id = ?");
    file.run("user:verification", moved.mailRefId);
    file.run("user:inbox", moved.mailRefId);
    file.run("user:account", olderCategory.mailRefId);
    previous.prepare("UPDATE mail_events SET analysis_json = ? WHERE mail_ref_id = ?")
      .run(JSON.stringify({ summary: "Old analysis", suggestions: [], questions: [], category: "account" }), olderCategory.mailRefId);
  } finally { previous.close(); }

  store = new AssistantMailStore(root);
  await store.initialize();
  expect(store.categories().map(category => category.id)).not.toContain("account");
  expect(store.page({}, true, id).events.map(event => event.mailRefId)).toEqual([kept.mailRefId]);
  expect(store.page({}, true, "inbox").events.map(event => event.mailRefId)).toEqual([olderCategory.mailRefId, moved.mailRefId]);
  expect(store.event(olderCategory.mailRefId)?.analysis).toEqual({ summary: "Old analysis", suggestions: [], questions: [] });
  expect(store.setFolder(olderCategory.mailRefId, "verification", "assistant")).toBe(false);
});

it("keeps mail already in the inbox eligible for its first classification", async () => {
  store.openMailbox("test-account", "1", 5);
  const { mailRefId } = (await store.record(message()))!;
  expect(store.setFolder(mailRefId, "inbox", "assistant")).toBe(false);
  expect(store.updateAnalysis(mailRefId, { summary: "Promotion", suggestions: [], questions: [], category: "marketing" }))
    .toMatchObject({ folder: "marketing" });
});

it("remembers separately acknowledged replies only for the current binding", () => {
  store.recordReply("current", "first", "First");
  store.recordReply("current", "second", "Second");
  store.recordReply("previous", "old", "Old");
  expect(store.attention(false, "current").map(item => item.id)).toEqual(["second", "first"]);
  store.acknowledgeAttention("reply", "second");
  expect(store.recordReply("current", "second", "Duplicate")).toBe(false);
  expect(store.attention(false, "current").map(item => item.id)).toEqual(["first"]);
});

it("deduplicates the full IMAP identity without replacing committed raw content", async () => {
  store.openMailbox("test-account", "1", 5);
  const event = await store.record(message());
  expect(await store.record({ ...message(), source: Buffer.from("replacement") })).toBeUndefined();
  expect(store.page().events).toHaveLength(1);
  expect((await store.read(event!.mailRefId))?.source).toEqual(message().source);
  expect(await fs.readdir(join(store.directory, "raw-mail"))).toHaveLength(1);
});

it("accepts a rolled-back receiver's four-value watermark write for both an existing and a new account", () => {
  store.openMailbox("test-account", "1", 5);
  store.finishHistory("test-account", "1", 2);
  const database = new DatabaseSync(join(store.directory, "assistant.sqlite"));
  openDatabases.push(database);
  const legacyOpen = database.prepare(`
    INSERT INTO imap_watermarks VALUES (?, 'INBOX', ?, ?)
    ON CONFLICT(account_key, mailbox) DO UPDATE SET uid_validity = excluded.uid_validity,
      last_persisted_uid = excluded.last_persisted_uid
  `);
  legacyOpen.run("test-account", "2", 19);
  legacyOpen.run("another-account", "1", 9);
  expect(store.openMailbox("test-account", "2", undefined)).toBe(19);
  expect(store.openMailbox("another-account", "1", undefined)).toBe(9);
  expect(store.historyWindow("test-account", "2", 19)).toMatchObject({ cursor: null, before: 20 });
  expect(store.historyWindow("another-account", "1", 9)).toMatchObject({ cursor: null, before: 10 });
});

it("rebaselines a new UIDVALIDITY generation and retains both identities", async () => {
  store.openMailbox("test-account", "1", 5);
  const oldEvent = await store.record(message());
  expect(store.openMailbox("test-account", "2", 3)).toBe(2);
  const newEvent = await store.record(message(5, "2"));
  expect(newEvent!.mailRefId).not.toBe(oldEvent!.mailRefId);
  expect(store.page().events.map(event => event.uidValidity)).toEqual(["2", "1"]);
  expect(store.openMailbox("test-account", "2", 100)).toBe(5);
});

it("has readable raw bytes before the event transaction and rolls back event and watermark together", async () => {
  store.openMailbox("test-account", "1", 5);
  const database = (store as unknown as { database: DatabaseSync }).database;
  let checked = false;
  database.function("check_raw", () => {
    const files = readdirSync(join(store.directory, "raw-mail"));
    expect(readFileSync(join(store.directory, "raw-mail", files[0]!))).toEqual(message().source);
    checked = true;
    return 1;
  });
  database.exec(`
    CREATE TEMP TRIGGER inspect_raw BEFORE INSERT ON mail_events BEGIN SELECT check_raw(); END;
    CREATE TEMP TRIGGER fail_watermark BEFORE UPDATE ON imap_watermarks BEGIN SELECT RAISE(ABORT, 'injected transaction failure'); END;
  `);
  await expect(store.record(message())).rejects.toThrow("injected transaction failure");
  expect(checked).toBe(true);
  expect(store.page().events).toEqual([]);
  expect(store.openMailbox("test-account", "1", 99)).toBe(4);
  database.exec("DROP TRIGGER fail_watermark; DROP TRIGGER inspect_raw;");
  await store.record(message());
  expect(store.openMailbox("test-account", "1", 99)).toBe(5);
});

it("commits forward triggers only while opted in, with the event and watermark", async () => {
  store.openMailbox("test-account", "1", 5);
  store.setBinding({ assistantId: "assistant", nativeSessionId: "managed", sectionId: null, previousSessionIds: [],
    managed: { path: "/fixture/workspace", policy: "stage1-fenced-workspace", token: "fixture" } });
  const before = (await store.record(message(5)))!;
  store.setAutomaticDelivery(true);
  const archived = (await store.record({ ...message(4), historical: true }))!;
  const database = new DatabaseSync(join(store.directory, "assistant.sqlite"));
  openDatabases.push(database);
  database.exec("CREATE TRIGGER reject_trigger BEFORE INSERT ON trigger_deliveries BEGIN SELECT RAISE(ABORT, 'trigger write failed'); END");
  await expect(store.record(message(6))).rejects.toThrow("trigger write failed");
  expect(store.openMailbox("test-account", "1", 99)).toBe(5);
  expect(store.page().events.map(event => event.uid)).toEqual([5, 4]);
  expect(store.triggers.nextPending("managed")).toBeUndefined();
  database.exec("DROP TRIGGER reject_trigger");
  const after = (await store.record(message(6)))!;
  expect(store.triggers.batchForEvent("mail.received", before.mailRefId)).toBeUndefined();
  expect(store.triggers.batchForEvent("mail.received", archived.mailRefId)).toBeUndefined();
  const batch = store.triggers.nextPending("managed")!;
  expect(store.triggers.refs(batch.batchId)).toEqual([{ kind: "mail.received", eventId: after.mailRefId }]);
  expect(batch.readyAt).toBe(after.recordedAt + 3_000);
  expect(store.openMailbox("test-account", "1", 99)).toBe(6);
});

it("does not create an event or advance the watermark if raw storage fails", async () => {
  store.openMailbox("test-account", "1", 5);
  vi.spyOn(fs, "writeFile").mockRejectedValueOnce(Object.assign(new Error("disk full"), { code: "ENOSPC" }));
  await expect(store.record(message())).rejects.toThrow("disk full");
  expect(store.page().events).toEqual([]);
  expect(store.openMailbox("test-account", "1", 99)).toBe(4);
});

it("pages deterministically while new events arrive and never exposes raw paths", async () => {
  store.openMailbox("test-account", "1", 5);
  for (const uid of [5, 6, 7]) await store.record(message(uid));
  const first = store.page({ limit: 2 });
  expect(first.events.map(event => event.uid)).toEqual([7, 6]);
  await store.record(message(8));
  const second = store.page({ cursor: first.nextCursor!, limit: 2, processingStatus: "pending" });
  expect(second.events.map(event => event.uid)).toEqual([5]);
  expect(second.nextCursor).toBeUndefined();
  expect(JSON.stringify(first)).not.toContain("raw_file");
  expect(await store.read("../../outside")).toBeUndefined();
  expect(() => store.page({ cursor: "1 OR 1=1" })).toThrow("cursor");
  expect(() => store.page({ limit: 101 })).toThrow("limit");
});

it("persists the single assistant binding and previous native session references", async () => {
  const binding = { assistantId: "assistant", nativeSessionId: "native-new", sectionId: null, previousSessionIds: ["native-old"] };
  expect(store.binding()).toBeUndefined();
  store.setBinding(binding);
  store.close();
  store = new AssistantMailStore(root);
  await store.initialize();
  expect(store.binding()).toEqual(binding);
});

it("allows a legacy five-value binding write after provisioning a managed binding", () => {
  const binding = { assistantId: "assistant", nativeSessionId: "native-managed", sectionId: null, previousSessionIds: [] };
  store.setBinding({ ...binding, managed: { path: "/fixture/workspace", policy: "stage1-fenced-workspace", token: "fixture-managed-token" } });
  const database = new DatabaseSync(join(store.directory, "assistant.sqlite"));
  openDatabases.push(database);
  const legacyBind = database.prepare(`
    INSERT INTO assistant_binding VALUES (1, ?, ?, ?, ?)
    ON CONFLICT(singleton) DO UPDATE SET assistant_id = excluded.assistant_id,
      native_session_id = excluded.native_session_id, section_id = excluded.section_id,
      previous_session_ids = excluded.previous_session_ids
  `);
  legacyBind.run(binding.assistantId, "native-legacy", null, JSON.stringify([binding.nativeSessionId]));
  expect(store.binding()).toEqual({ ...binding, nativeSessionId: "native-legacy", previousSessionIds: [binding.nativeSessionId] });
  legacyBind.run(binding.assistantId, binding.nativeSessionId, null, JSON.stringify(["native-legacy"]));
  expect(store.binding()).not.toHaveProperty("managed");
});

it("migrates an existing event and persists analysis/status on the same identity without changing raw bytes or watermark", async () => {
  store.openMailbox("test-account", "1", 5);
  const event = (await store.record(message()))!;
  store.close();
  const legacy = new DatabaseSync(join(root, "private", "assistant", "assistant.sqlite"));
  legacy.exec("ALTER TABLE mail_events DROP COLUMN analysis_json; ALTER TABLE mail_events DROP COLUMN mime_projection");
  legacy.close();
  store = new AssistantMailStore(root);
  await store.initialize();
  await store.backfillMimeProjections(new AbortController().signal);
  expect(store.page().events[0]?.analysis).toBeNull();
  const analysis = { summary: "External email asks for a payment", suggestions: ["Check with the user"], questions: ["Is this expected?"], category: "marketing" as const };
  expect(store.updateAnalysis(event.mailRefId, analysis)).toEqual({ ...event, analysis, folder: "marketing" });
  expect(store.setProcessingStatus(event.mailRefId, "processed")).toEqual({ ...event, analysis, processingStatus: "processed", folder: "marketing" });
  expect(store.updateAnalysis("missing", analysis)).toBeUndefined();
  expect(store.setProcessingStatus("missing", "pending")).toBeUndefined();
  store.close();
  store = new AssistantMailStore(root);
  await store.initialize();
  expect(store.page().events).toEqual([{ ...event, analysis, processingStatus: "processed", folder: "marketing" }]);
  expect((await store.read(event.mailRefId))?.source).toEqual(message().source);
  expect(store.openMailbox("test-account", "1", 100)).toBe(5);
});

it("migrates legacy mail as unmarked and retains host read marks after reopening", async () => {
  store.openMailbox("test-account", "1", 5);
  const event = (await store.record(message()))!;
  store.close();
  const legacy = new DatabaseSync(join(store.directory, "assistant.sqlite"));
  try { legacy.exec("ALTER TABLE mail_events DROP COLUMN host_read"); }
  finally { legacy.close(); }
  await store.initialize();
  expect(store.event(event.mailRefId)).toEqual(event);
  expect(store.markRead([event.mailRefId])).toBe(1);
  store.close();
  await store.initialize();
  expect(await store.read(event.mailRefId)).toEqual({ event: { ...event, hostRead: true }, source: message().source });
  expect(store.openMailbox("test-account", "1", 100)).toBe(5);
});

it("migrates and keeps local junk marks across reopen without changing mail identity, processing, or raw bytes", async () => {
  store.openMailbox("test-account", "1", 5);
  const older = (await store.record({ ...message(4), historical: true }))!;
  const target = (await store.record(message(5)))!;
  const latest = (await store.record(message(6)))!;
  store.close();
  const legacy = new DatabaseSync(join(store.directory, "assistant.sqlite"));
  try { legacy.exec("ALTER TABLE mail_events DROP COLUMN user_junk"); }
  finally { legacy.close(); }
  await store.initialize();

  expect(store.page({ limit: 2 }, true, "inbox")).toEqual({ events: [latest, target], nextCursor: String(target.seq) });
  expect(store.setJunk("missing", true)).toBeUndefined();
  expect(store.setJunk(target.mailRefId, true)).toBe(true);
  expect(store.setJunk(target.mailRefId, true)).toBe(false);
  expect(store.unreadCount()).toBe(1);
  store.close();
  await store.initialize();

  expect(store.page({ limit: 2 }, true, "inbox")).toEqual({ events: [latest, older] });
  expect(store.page({ cursor: String(target.seq) }, true, "inbox").events).toEqual([older]);
  expect(store.page().events).toEqual([latest, { ...target, folder: "marketing" }, older]);
  expect(await store.record(message(5))).toBeUndefined();
  expect(await store.read(target.mailRefId)).toEqual({ event: { ...target, folder: "marketing" }, source: message(5).source });
  expect(store.setJunk(target.mailRefId, false)).toBe(true);
  expect(store.page({}, true, "inbox").events).toEqual([latest, target, older]);
});

it("creates the assistant business tables and private POSIX files including WAL/SHM", async () => {
  store.openMailbox("test-account", "1", 5);
  await store.record(message());
  const database = new DatabaseSync(join(store.directory, "assistant.sqlite"));
  openDatabases.push(database);
  expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(row => row.name))
    .toEqual(["assistant_attention_ack", "assistant_attention_baseline", "assistant_attention_replies", "assistant_binding", "assistant_managed_binding", "imap_history", "imap_watermarks", "mail_categories", "mail_events", "trigger_batches", "trigger_deliveries"]);
  if (process.platform === "win32") return;
  for (const path of [join(root, "private"), store.directory, join(store.directory, "raw-mail")]) {
    expect((await fs.stat(path)).mode & 0o777).toBe(0o700);
  }
  for (const name of ["assistant.sqlite", "assistant.sqlite-wal", "assistant.sqlite-shm"]) {
    expect((await fs.stat(join(store.directory, name))).mode & 0o777).toBe(0o600);
  }
  const raw = await fs.readdir(join(store.directory, "raw-mail"));
  expect((await fs.stat(join(store.directory, "raw-mail", raw[0]!))).mode & 0o777).toBe(0o600);
});

it("keeps paginated previews and attachment metadata when the original is unavailable", async () => {
  store.openMailbox("test-account", "1", 5);
  const event = await store.record({ ...message(), source: Buffer.from('Content-Type: text/plain\r\nContent-Disposition: attachment; filename="notes.txt"\r\n\r\nPrivate text') });
  await fs.rename(join(store.directory, "raw-mail"), join(store.directory, "detached-raw-mail"));
  expect(store.page().events[0]).toMatchObject({ mailRefId: event?.mailRefId, attachmentCount: 1,
    attachments: [{ attachmentId: "0", filename: "notes.txt", mimeType: "text/plain", size: 12 }] });
});

it("removes malformed template residue from new and saved previews without changing the original", async () => {
  store.openMailbox("test-account", "1", 5);
  const text = `Prize draw opens\r\nSee the rules.\r\n${" \r\n".repeat(34)}  96\r\na.footer-link,a.footer-link:link{color:#2F2F2F!important;}\r\nPrize draw opens`;
  const source = Buffer.from([
    'Content-Type: multipart/alternative; boundary="excerpt"', "", "--excerpt", "Content-Type: text/plain; charset=utf-8", "", text,
    "--excerpt", "Content-Type: text/html", "", "<p>HTML alternative is not the original text.</p>", "--excerpt--", "",
  ].join("\r\n"));
  const event = (await store.record({ ...message(), source }))!;
  expect(event.preview).toBe("Prize draw opens\nSee the rules.");
  expect((await store.read(event.mailRefId))?.source).toEqual(source);
  const db = new DatabaseSync(join(root, "private", "assistant", "assistant.sqlite"));
  openDatabases.push(db);
  db.prepare("UPDATE mail_events SET mime_projection = json_set(mime_projection, '$.preview', ?) WHERE mail_ref_id = ?")
    .run(text, event.mailRefId);
  expect(store.page({}, true, { query: "footer-link" }).events).toEqual([]);
  expect(store.page({}, true, { query: "Prize draw" }).events[0]?.preview).toBe(event.preview);
  expect(store.page().events[0]?.preview).toBe(event.preview);
});

it("keeps text after formatting whitespace and bounds long previews on code-point boundaries", async () => {
  store.openMailbox("test-account", "1", 5);
  const formatted = await store.record({ ...message(), source: Buffer.from("Content-Type: text/plain\r\n\r\nFirst line\r\n\r\n\r\nNext paragraph") });
  expect(formatted?.preview).toBe("First line\nNext paragraph");
  const source = Buffer.from(`Content-Type: text/plain; charset=utf-8\r\n\r\n${"📬🧪".repeat(800)}`);
  const event = await store.record({ ...message(6), source });
  expect(event?.preview).toBe("📬🧪".repeat(512));
});

it("opens and pages a legacy store while a historical MIME stream is still pending", async () => {
  store.openMailbox("test-account", "1", 5);
  const event = (await store.record(message()))!;
  store.close();
  const database = new DatabaseSync(join(root, "private", "assistant", "assistant.sqlite"));
  database.exec("UPDATE mail_events SET mime_projection = NULL");
  database.close();
  store = new AssistantMailStore(root);
  await store.initialize();
  expect(store.page().events[0]).toMatchObject({ mailRefId: event.mailRefId, preview: "" });
  const abort = new AbortController();
  const interrupted = store.backfillMimeProjections(abort.signal);
  abort.abort();
  expect(await interrupted).toBe(false);
  store.close();
  store = new AssistantMailStore(root);
  await store.initialize();
  expect(store.page().events[0]?.preview).toBe("");
  expect(await store.backfillMimeProjections(new AbortController().signal)).toBe(true);
  expect(store.page().events[0]).toEqual(event);
});
