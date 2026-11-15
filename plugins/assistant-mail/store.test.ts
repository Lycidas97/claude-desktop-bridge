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

it("deduplicates the full IMAP identity without replacing committed raw content", async () => {
  store.openMailbox("test-account", "1", 5);
  const event = await store.record(message());
  expect(await store.record({ ...message(), source: Buffer.from("replacement") })).toBeUndefined();
  expect(store.page().events).toHaveLength(1);
  expect((await store.read(event!.mailRefId))?.source).toEqual(message().source);
  expect(await fs.readdir(join(store.directory, "raw-mail"))).toHaveLength(1);
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

it("migrates an existing event and persists analysis/status on the same identity without changing raw bytes or watermark", async () => {
  store.openMailbox("test-account", "1", 5);
  const event = (await store.record(message()))!;
  store.close();
  const legacy = new DatabaseSync(join(root, "private", "assistant", "assistant.sqlite"));
  legacy.exec("ALTER TABLE mail_events DROP COLUMN analysis_json");
  legacy.close();
  store = new AssistantMailStore(root);
  await store.initialize();
  expect(store.page().events[0]?.analysis).toBeNull();
  const analysis = { summary: "External email asks for a payment", suggestions: ["Check with the user"], questions: ["Is this expected?"] };
  expect(store.updateAnalysis(event.mailRefId, analysis)).toEqual({ ...event, analysis });
  expect(store.setProcessingStatus(event.mailRefId, "processed")).toEqual({ ...event, analysis, processingStatus: "processed" });
  expect(store.updateAnalysis("missing", analysis)).toBeUndefined();
  expect(store.setProcessingStatus("missing", "pending")).toBeUndefined();
  store.close();
  store = new AssistantMailStore(root);
  await store.initialize();
  expect(store.page().events).toEqual([{ ...event, analysis, processingStatus: "processed" }]);
  expect((await store.read(event.mailRefId))?.source).toEqual(message().source);
  expect(store.openMailbox("test-account", "1", 100)).toBe(5);
});

it("creates exactly the three business tables and private POSIX files including WAL/SHM", async () => {
  store.openMailbox("test-account", "1", 5);
  await store.record(message());
  const database = new DatabaseSync(join(store.directory, "assistant.sqlite"));
  openDatabases.push(database);
  expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(row => row.name))
    .toEqual(["assistant_binding", "imap_watermarks", "mail_events"]);
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
