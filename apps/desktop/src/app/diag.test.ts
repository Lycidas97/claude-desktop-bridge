import { afterEach, expect, test, vi } from "vitest";
import { chmodSync, mkdtempSync, readdirSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getHeapStatistics, writeHeapSnapshot } from "node:v8";
import { Diagnostics, diagnostics } from "./diag.js";
import { dispatchControllerRequest } from "../controller/controller-rpc.js";
import { cacheDeviceResponse, deliverTransportMessage } from "../transport/controller-transport.js";

vi.mock("node:v8", async importOriginal => ({ ...await importOriginal<typeof import("node:v8")>(), writeHeapSnapshot: vi.fn() }));
const directories: string[] = [];
function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}
afterEach(() => {
  vi.restoreAllMocks(); vi.mocked(writeHeapSnapshot).mockReset();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test("RPC stages distinguish handler from sending and settle on failure", async () => {
  const trace = new Diagnostics(true);
  vi.spyOn(diagnostics, "begin").mockImplementation(name => trace.begin(name));
  const handling = gate(), sending = gate();
  const host = { rememberDevice: vi.fn(async () => {}), responseCache: new Map(), handleRequest: vi.fn((request, origin) => dispatchControllerRequest({ snapshot: async () => { await handling.promise; return {}; } } as never, request, origin)), cacheResponse: vi.fn(), sendToDevice: vi.fn(async () => { await sending.promise; throw new Error("fixture send"); }), socket: { ack: vi.fn() } };
  const message = { header: { from: "mobile", fromDeviceId: "private-device" }, payload: { kind: "request", method: "snapshot.get", requestId: "private-request", params: {} } };
  const pending = deliverTransportMessage(host as never, message as never, { id: "private-envelope" } as never, () => ({ kind: "response", requestId: "private-request", ok: false, error: { code: "FIXTURE", message: "fixture", retryable: false } }));
  await vi.waitFor(() => expect(trace.snapshot().stages["handler.snapshot.get"]!.active).toBe(1));
  expect(trace.snapshot().stages["send.snapshot.get"]?.active ?? 0).toBe(0);
  handling.resolve();
  await vi.waitFor(() => expect(trace.snapshot().stages["send.snapshot.get"]!.active).toBe(1));
  expect(trace.snapshot().stages["handler.snapshot.get"]!.active).toBe(0);
  sending.resolve();
  await pending;
  expect(trace.snapshot().stages["rpc.snapshot.get"]!.active).toBe(0);
  expect(trace.snapshot().stages["send.snapshot.get"]!.settled).toBe(1);
  expect(JSON.stringify(trace.snapshot())).not.toMatch(/private-device|private-request|private-envelope/);
});

test("cached send rejection and remember rejection still settle delivery", async () => {
  const trace = new Diagnostics(true);
  vi.spyOn(diagnostics, "begin").mockImplementation(name => trace.begin(name));
  const host = { rememberDevice: vi.fn(async () => {}), responseCache: new Map([["fixture", { kind: "response", requestId: "fixture", ok: true }]]), sendToDevice: vi.fn(async () => { throw new Error("cached failure"); }) };
  const message = { header: { from: "mobile", fromDeviceId: "fixture" }, payload: { kind: "request", method: "snapshot.get", requestId: "fixture", params: {} } };
  await expect(deliverTransportMessage(host as never, message as never, {} as never, vi.fn())).rejects.toThrow("cached failure");
  expect(trace.snapshot().stages["rpc.snapshot.get"]!.active).toBe(0);
  expect(trace.snapshot().stages["send.snapshot.get"]!.active).toBe(0);
  host.rememberDevice.mockRejectedValueOnce(new Error("remember failure"));
  await expect(deliverTransportMessage(host as never, message as never, {} as never, vi.fn())).rejects.toThrow("remember failure");
  expect(trace.snapshot().stages["rpc.snapshot.get"]!.active).toBe(0);
});

test("encoded cache bytes update once on retries and disappear on eviction", () => {
  const trace = new Diagnostics(true);
  const response = { kind: "response" as const, requestId: "private-id", ok: true as const, result: { body: "PRIVATE_PAYLOAD" } };
  trace.response(response, "session.history");
  trace.cacheInsert(response);
  trace.encoded(response, 321);
  trace.encoded(response, 321);
  expect(trace.cache).toMatchObject({ current: 1, encodedItems: 1, jsonUtf8Bytes: 321 });
  expect(JSON.stringify(trace.snapshot())).not.toMatch(/PRIVATE_PAYLOAD|private-id/);
  trace.cacheEvict(response);
  expect(trace.cache).toMatchObject({ current: 0, encodedItems: 0, jsonUtf8Bytes: 0 });
});

test("numeric SQLite samples persist with a 900-row bound and private file mode", () => {
  const path = join(temporaryDirectory("bridge-oom-trace-"), "trace.sqlite");
  const trace = new Diagnostics(true);
  try {
    trace.start(path);
    for (let i = 0; i < 905; i++) trace.write();
  } finally { trace.close(); }
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    expect((db.prepare("SELECT count(*) AS n FROM samples").get() as { n: number }).n).toBe(900);
    expect(JSON.parse((db.prepare("SELECT data FROM samples ORDER BY id DESC LIMIT 1").get() as { data: string }).data).schema).toBe(1);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(path).size).toBeLessThanOrEqual(32 * 1024 * 1024);
  } finally { db.close(); }
});

test("an overlapping read transaction does not stop current or later numeric recording", () => {
  const directory = temporaryDirectory("bridge-oom-reader-");
  const path = join(directory, "trace.sqlite");
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const trace = new Diagnostics(true);
  trace.start(path);
  const reader = new DatabaseSync(path, { readOnly: true });
  try {
    reader.exec("BEGIN");
    expect((reader.prepare("SELECT count(*) AS n FROM samples").get() as { n: number }).n).toBe(1);
    trace.write();
    expect((reader.prepare("SELECT count(*) AS n FROM samples").get() as { n: number }).n).toBe(1);
    reader.exec("COMMIT");
    trace.write();
    expect((reader.prepare("SELECT count(*) AS n FROM samples").get() as { n: number }).n).toBe(3);
    expect(stderr).not.toHaveBeenCalled();
    expect(statSync(path + "-wal").mode & 0o777).toBe(0o600);
    expect(statSync(path + "-shm").mode & 0o777).toBe(0o600);
  } finally {
    if (reader.isTransaction) reader.exec("ROLLBACK");
    reader.close();
    trace.close();
  }
});

test("heap snapshot triggers at 60% once, after committing numeric evidence in a private directory", () => {
  const directory = temporaryDirectory("bridge-oom-threshold-");
  chmodSync(directory, 0o755);
  const path = join(directory, "trace.sqlite");
  const boundary = Math.ceil(getHeapStatistics().heap_size_limit * 0.6);
  const memory = process.memoryUsage();
  const usage = vi.spyOn(process, "memoryUsage").mockReturnValue({ ...memory, heapUsed: boundary - 1 });
  vi.mocked(writeHeapSnapshot).mockImplementation(snapshotFile => {
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(snapshotFile!).mode & 0o777).toBe(0o600);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const data = JSON.parse((db.prepare("SELECT data FROM samples ORDER BY id DESC LIMIT 1").get() as { data: string }).data);
      expect(data.memory.heapUsed).toBe(boundary);
      expect(data.heapSnapshot).toMatchObject({ thresholdRatio: 0.6, attempted: 1, written: 0 });
    } finally { db.close(); }
    return snapshotFile!;
  });
  const trace = new Diagnostics(true);
  try {
    trace.start(path);
    expect(writeHeapSnapshot).not.toHaveBeenCalled();
    usage.mockReturnValue({ ...memory, heapUsed: boundary });
    trace.write();
    for (let i = 0; i < 3; i++) trace.write();
    expect(writeHeapSnapshot).toHaveBeenCalledTimes(1);
    expect(readdirSync(directory).filter(name => name.endsWith(".heapsnapshot"))).toHaveLength(1);
    expect(trace.snapshot().heapSnapshot).toMatchObject({ attempted: 1, written: 1, failed: 0 });
  } finally { trace.close(); }
});

test("a heap snapshot write failure is attempted once while numeric recording continues", () => {
  const path = join(temporaryDirectory("bridge-oom-snapshot-failure-"), "trace.sqlite");
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  vi.mocked(writeHeapSnapshot).mockImplementation(() => { throw Object.assign(new Error("PRIVATE_FAILURE_MESSAGE"), { code: "ENOSPC" }); });
  const trace = new Diagnostics(true, 0);
  try {
    trace.start(path);
    trace.write();
    trace.write();
    expect(writeHeapSnapshot).toHaveBeenCalledTimes(1);
    expect(stderr).toHaveBeenCalledExactlyOnceWith("Bridge diagnostic heap snapshot failed: ENOSPC\n");
    expect(trace.snapshot().heapSnapshot).toMatchObject({ attempted: 1, written: 0, failed: 1 });
  } finally { trace.close(); }
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    expect((db.prepare("SELECT count(*) AS n FROM samples").get() as { n: number }).n).toBe(3);
    const data = (db.prepare("SELECT data FROM samples ORDER BY id DESC LIMIT 1").get() as { data: string }).data;
    expect(JSON.parse(data).heapSnapshot.failed).toBe(1);
    expect(data).not.toContain("PRIVATE_FAILURE_MESSAGE");
  } finally { db.close(); }
});

test("tracing defaults off without starting a timer or creating samples or files", () => {
  const directory = temporaryDirectory("bridge-oom-disabled-");
  vi.stubEnv("BRIDGE_OOM_TRACE", "1");
  const interval = vi.spyOn(globalThis, "setInterval");
  const trace = new Diagnostics();
  const sample = vi.spyOn(trace, "snapshot");
  try {
    expect(trace.enabled).toBe(false);
    trace.start(join(directory, "trace.sqlite"));
    trace.write();
  } finally { trace.close(); vi.unstubAllEnvs(); }
  expect(interval).not.toHaveBeenCalled();
  expect(sample).not.toHaveBeenCalled();
  expect(readdirSync(directory)).toEqual([]);
  expect(writeHeapSnapshot).not.toHaveBeenCalled();
});

test("one SQLite sink bounds stage rows and rejects private fields", () => {
  const path = join(temporaryDirectory("bridge-diag-stages-"), "trace.sqlite");
  const trace = new Diagnostics();
  trace.start(path);
  trace.setEnabled(true);
  const db = new DatabaseSync(path);
  try {
    db.exec(`WITH RECURSIVE rows(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM rows WHERE n<50000)
      INSERT INTO events(at,uptime,event,data) SELECT 0,0,'project.start','{}' FROM rows;`);
    trace.event("project.done", { count: 348, method: "PRIVATE_METHOD", payload: "PRIVATE_BODY" } as never);
    expect(db.prepare("SELECT count(*) AS n FROM events").get()).toMatchObject({ n: 50000 });
    const data = db.prepare("SELECT data FROM events ORDER BY id DESC LIMIT 1").get()!.data as string;
    expect(JSON.parse(data)).toEqual({ count: 348, method: "other" });
    expect(data).not.toContain("PRIVATE");
  } finally { db.close(); trace.close(); }
});

test("enabling with preexisting cache entries tolerates replacement and capacity eviction", () => {
  const path = join(temporaryDirectory("bridge-diag-toggle-"), "trace.sqlite");
  const trace = new Diagnostics();
  trace.start(path);
  vi.spyOn(diagnostics, "cacheInsert").mockImplementation(response => trace.cacheInsert(response));
  vi.spyOn(diagnostics, "cacheEvict").mockImplementation(response => trace.cacheEvict(response));
  const cache = new Map();
  for (let index = 0; index < 500; index++) cacheDeviceResponse(cache, { kind: "response", requestId: `old-${index}`, ok: true, result: {} });
  trace.setEnabled(true);
  try {
    const replacement = { kind: "response" as const, requestId: "old-1", ok: true as const, result: {} };
    cacheDeviceResponse(cache, replacement);
    expect(cache.get("old-1")).toBe(replacement);
    const inserted = { kind: "response" as const, requestId: "new", ok: true as const, result: {} };
    trace.response(inserted, "session.history");
    cacheDeviceResponse(cache, inserted);
    trace.encoded(inserted, 321);
    expect(cache.has("old-0")).toBe(false);
    expect(cache.size).toBe(500);
    expect(trace.cache).toMatchObject({ current: 2, encodedItems: 1, jsonUtf8Bytes: 321 });
    trace.cacheEvict(inserted);
    expect(trace.cache).toMatchObject({ current: 1, encodedItems: 0, jsonUtf8Bytes: 0 });
    const settled = trace.begin("native.other");
    trace.setEnabled(false);
    const sample = vi.spyOn(trace, "snapshot");
    settled();
    trace.event("project.start", { count: 1 });
    trace.write();
    expect(sample).not.toHaveBeenCalled();
    expect(trace.snapshot().stages["native.other"]).toMatchObject({ active: 0, settled: 0 });
    trace.setEnabled(true);
    expect(trace.cache.current).toBe(0);
    settled();
    expect(trace.snapshot().stages).toEqual({});
  } finally { trace.close(); }
});
