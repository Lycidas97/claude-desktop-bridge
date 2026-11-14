import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { DesktopController } from "../controller/controller.js";
import { MemoryRecorder } from "./memory-recorder.js";

const roots: string[] = [];
const recorders: MemoryRecorder[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "bridge-memory-")); roots.push(root);
  const path = join(root, "memory.sqlite");
  const recorder = new MemoryRecorder(path, "1.3.3"); recorders.push(recorder);
  return { root, path, recorder };
}
function db(recorder: MemoryRecorder): DatabaseSync { return (recorder as unknown as { database: DatabaseSync }).database; }
function diagnostics(recorder: MemoryRecorder) {
  return DesktopController.prototype.diagnostics.call({
    config: { relayUrl: "ws://127.0.0.1/ws", devices: [] }, relayConnectUrl: "ws://127.0.0.1/ws", app: { getVersion: () => "1.3.3" },
    broker: { runtimeStatus: () => ({ state: "ready" }) }, desktopRuntimes: () => [], allProjects: () => [],
    allSessions: () => [], claudePermissions: () => [], eventLog: { latestSeq: () => 0 }, memoryRecorder: recorder,
  } as unknown as DesktopController);
}
afterEach(() => {
  vi.restoreAllMocks(); vi.useRealTimers();
  for (const recorder of recorders.splice(0)) recorder.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it("records startup, 30-second samples and shutdown; reopens them through existing diagnostics", () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-14T00:00:00Z"));
  const { recorder, path } = fixture();
  recorder.initialize();
  expect(vi.getTimerCount()).toBe(1);
  vi.advanceTimersByTime(29999);
  expect((recorder.diagnostics().rows as unknown[]).length).toBe(1);
  vi.advanceTimersByTime(1);
  const memory = diagnostics(recorder).memory as { columns: string[]; rows: Array<Array<number | string>> };
  expect(memory.columns).toEqual(["at", "uptime", "kind", "heapUsed", "heapTotal", "rss", "external", "arrayBuffers", "schemaVersion", "appVersion"]);
  expect(memory.rows.map(row => row[2])).toEqual([1, 0]);
  for (const row of memory.rows) {
    expect(row).toHaveLength(10);
    expect(row.slice(0, 9).every(value => typeof value === "number")).toBe(true);
    expect(row[8]).toBe(1); expect(row[9]).toBe("1.3.3");
  }
  recorder.close(); expect(vi.getTimerCount()).toBe(0);
  const reopened = new MemoryRecorder(path, "1.3.3"); recorders.push(reopened); reopened.initialize();
  expect((reopened.diagnostics().rows as Array<Array<unknown>>).map(row => row[2])).toEqual([0, 2, 1, 0]);
  if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
});
it("bounds rows, seven-day export, actual main pages and rollback journal capacity", () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-14T00:00:00Z"));
  const { recorder, path } = fixture(); recorder.initialize();
  const database = db(recorder);
  expect(database.prepare("PRAGMA journal_mode").get()!.journal_mode).toBe("persist");
  expect(database.prepare("PRAGMA busy_timeout").get()!.timeout).toBe(0);
  expect(database.prepare("PRAGMA max_page_count").get()!.max_page_count).toBe(2048);
  let journalPeak = 0;
  const exec = database.exec.bind(database);
  vi.spyOn(database, "exec").mockImplementation(sql => {
    if (sql.includes("COMMIT")) journalPeak = Math.max(journalPeak, statSync(path + "-journal").size);
    return exec(sql);
  });
  // Bulk fixture population avoids 20k fsync transactions; actual sampler still
  // performs its normal bounded DELETE-before-INSERT transaction below.
  database.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < 20160)
    INSERT INTO samples (at, uptime, kind, heap_used, heap_total, rss, external, array_buffers, schema_version, app_version)
    SELECT ?, x, 1, 12345678, 23456789, 34567890, 456789, 12345, 1, '1.3.3' FROM n`).run(Date.now());
  recorder.sample();
  expect(database.prepare("SELECT count(*) AS n FROM samples").get()!.n).toBe(20160);
  const fullExportBytes = Buffer.byteLength(JSON.stringify(diagnostics(recorder), null, 2));
  expect(fullExportBytes).toBeLessThan(32 * 1024 * 1024);
  const mainBytes = statSync(path).size;
  const pageCount = Number(database.prepare("PRAGMA page_count").get()!.page_count);
  expect(mainBytes).toBe(pageCount * 4096);
  expect(mainBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
  vi.setSystemTime(Date.now() + 8 * 86400000);
  expect(recorder.diagnostics().rows).toEqual([]);
  recorder.sample();
  expect(database.prepare("SELECT count(*) AS n FROM samples").get()!.n).toBe(1);
  const retainedJournalBytes = statSync(path + "-journal").size;
  expect(journalPeak).toBeGreaterThan(0);
  expect(retainedJournalBytes).toBeLessThanOrEqual(262144);
  // SQLite enforces the configured main-file ceiling independently of row policy.
  expect(() => database.exec("CREATE TABLE capacity_probe (data BLOB); INSERT INTO capacity_probe VALUES (zeroblob(9437184))"))
    .toThrow(expect.objectContaining({ code: "ERR_SQLITE_ERROR", errcode: 13 }));
  expect(statSync(path).size).toBeLessThanOrEqual(8 * 1024 * 1024);
  console.info("memory-recorder-capacity", JSON.stringify({ rows: 20160, mainBytes, pageCount, journalPeak, retainedJournalBytes, fullExportBytes }));
});
it("stops on an actual SQLite busy error without waiting or retrying", () => {
  vi.useFakeTimers();
  const { recorder, path } = fixture(); recorder.initialize();
  const connection = db(recorder);
  const lock = new DatabaseSync(path);
  try {
    lock.exec("BEGIN IMMEDIATE");
    recorder.sample();
    expect(recorder.diagnostics()).toMatchObject({ status: "unavailable", errorCode: "SQLITE_5", rows: [] });
    expect(connection.isOpen).toBe(false); expect(vi.getTimerCount()).toBe(0);
  } finally { lock.exec("ROLLBACK"); lock.close(); }
});
it("reports a fixed I/O code rather than raw file error text", () => {
  const { root } = fixture();
  const blocker = join(root, "blocked"); writeFileSync(blocker, "not a directory");
  const recorder = new MemoryRecorder(join(blocker, "memory.sqlite"), "1.3.3"); recorders.push(recorder);
  recorder.initialize();
  expect(recorder.diagnostics()).toMatchObject({ status: "unavailable", errorCode: "EEXIST", rows: [] });
  expect(JSON.stringify(recorder.diagnostics())).not.toContain(blocker);
});
it.each([new TypeError("binding bug"), Object.assign(new Error("syntax bug"), { code: "ERR_SQLITE_ERROR", errcode: 1 })])("propagates programmer errors: %s", error => {
  const { recorder } = fixture(); recorder.initialize();
  vi.spyOn(StatementSync.prototype, "run").mockImplementationOnce(() => { throw error; });
  expect(() => recorder.sample()).toThrow(error);
  expect(db(recorder).isTransaction).toBe(false);
});
it("closes a partially initialized database after a programming error", () => {
  const { recorder } = fixture();
  vi.spyOn(DatabaseSync.prototype, "exec").mockImplementationOnce(() => { throw new Error("invalid schema SQL"); });
  expect(() => recorder.initialize()).toThrow("invalid schema SQL");
  const connection = db(recorder); expect(connection.isOpen).toBe(true);
  recorder.close(); expect(connection.isOpen).toBe(false);
});
