import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { getHeapStatistics, writeHeapSnapshot } from "node:v8";
import { BridgeCrypto, type BridgePayload } from "@bridge/protocol";

const METHODS = ["session.open", "session.history", "session.tool.detail", "session.configuration", "snapshot.get", "events.resume", "artifact.preview", "artifact.transfer.read", "turn.start", "turn.steer", "other"] as const;
type Method = typeof METHODS[number];
export type DiagBucket = `${"rpc" | "handler" | "send" | "response"}.${Method}`
  | "native.getTranscriptPage" | "native.getTranscript" | "native.other" | "native.stream"
  | "history.initial" | "history.cursor" | "history.planPage" | "publish" | "native.event" | "file.toolDetail";
type Stage = "inspector.recv" | "inspector.parsed" | "inspector.received" | "inspector.call.start" | "inspector.call.done"
  | "inspector.events.wait" | "inspector.events.batch" | "inspector.events.emitted" | "inspector.send"
  | "refresh.start" | "refresh.connected" | "refresh.getAll" | "refresh.sections" | "refresh.models" | "refresh.observed" | "refresh.done"
  | "project.start" | "project.done" | "snapshot.build" | "publish.snapshot" | "history.messages"
  | "process.scan.start" | "process.scan.read" | "process.scan.done" | "catalog.start" | "catalog.listed" | "catalog.done"
  | "transport.frame" | "transport.message";
type DiagEvent = Stage | `${DiagBucket}.start` | `${DiagBucket}.done`;
type Fields = Partial<Record<"count" | "codeUnits" | "pending" | "request" | "limit" | "messages" | "runtimes" | "sessions" | "processes" | "active", number>>
  & { timeout?: boolean; ready?: boolean; ok?: boolean; reply?: boolean; cursor?: boolean; method?: string; origin?: "desktop" | "mobile" };
type Bucket = { started: number; settled: number; peak: number; total: number; max: number; last: number; pending: Map<number, number> };
const NATIVE_METHODS = new Set(["getAll", "getSession", "start", "saveTrust", "forkSession", "startBtwChild", "updateSession", "archive", "unarchive", "delete", "sendMessage", "sendSteeredNow", "promoteQueuedMessage", "cancelQueuedMessage", "interrupt", "stopTask", "setModel", "setEffort", "setPermissionMode", "getContextUsage", "getSupportedCommands", "getTranscript", "getTranscriptPage", "getTranscriptTail", "respondToToolPermission", "findLocalSessionIdForBridgeId", "getAvailableCodeModels", "canRewindTo", "rewindV2", "rewindFiles", "respondToRefusalFallbackPrompt", "respondToAutoModeServerFallbackPrompt", "respondToLanyardConsent", "respondToViolinBowPrompt", "answerPendingCwdTrust", "getPrOverview", "getPrChecks", "setBoundPrAutoFix", "setAutoFixOwnPrsWanted", "armAutoFixOnNextPr", "getGitInfo"]);
const NUMERIC_FIELDS = new Set(["count", "codeUnits", "pending", "request", "limit", "messages", "runtimes", "sessions", "processes", "active", "timeout", "ready", "ok", "reply", "cursor"]);
const noop = () => {};

/** One opt-in recorder. Structured records are numeric; heap snapshots stay local and can contain plaintext. */
export class Diagnostics {
  private readonly buckets = new Map<DiagBucket, Bucket>();
  private responses = new WeakMap<object, { method: Method; bytes: number; cached: boolean }>();
  private sequence = 0;
  private path: string | undefined;
  private database: DatabaseSync | undefined;
  private insertSample: StatementSync | undefined;
  private pruneSamples: StatementSync | undefined;
  private insertEvent: StatementSync | undefined;
  private pruneEvents: StatementSync | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastSampleAt = 0;
  private heapSnapshotPath: string | undefined;
  private heapSnapshot = { attempted: 0, written: 0, failed: 0 };
  readonly cache = { inserts: 0, evicts: 0, hits: 0, current: 0, encodedItems: 0, jsonUtf8Bytes: 0 };

  constructor(public enabled = false, private readonly heapSnapshotThreshold = 0.6) {}

  method(method: string): Method { return (METHODS as readonly string[]).includes(method) ? method as Method : "other"; }

  event(event: DiagEvent, fields?: Fields): void {
    if (!this.database) return;
    const data: Record<string, number | boolean | string> = {};
    for (const [key, value] of Object.entries(fields ?? {})) {
      if (NUMERIC_FIELDS.has(key) && (typeof value === "number" || typeof value === "boolean")) data[key] = value;
      else if (key === "method" && typeof value === "string") data.method = NATIVE_METHODS.has(value) ? value : this.method(value);
      else if (key === "origin" && (value === "desktop" || value === "mobile")) data.origin = value;
    }
    this.persist(() => {
      this.pruneEvents!.run();
      this.insertEvent!.run(Date.now(), Math.round(process.uptime() * 1000), event, JSON.stringify(data));
    });
  }

  begin(name: DiagBucket, fields?: Fields): () => void {
    if (!this.enabled) return noop;
    let bucket = this.buckets.get(name);
    if (!bucket) {
      bucket = { started: 0, settled: 0, peak: 0, total: 0, max: 0, last: 0, pending: new Map() };
      this.buckets.set(name, bucket);
    }
    const id = ++this.sequence;
    bucket.started++;
    bucket.pending.set(id, Date.now());
    bucket.peak = Math.max(bucket.peak, bucket.pending.size);
    this.event(`${name}.start`, fields);
    return () => {
      if (!bucket.pending.delete(id)) return;
      bucket.settled++;
      this.event(`${name}.done`);
    };
  }

  count(name: DiagBucket): void {
    const end = this.begin(name);
    end();
  }

  observe(name: DiagBucket, amount: number): void {
    if (!this.enabled) return;
    let bucket = this.buckets.get(name);
    if (!bucket) {
      bucket = { started: 0, settled: 0, peak: 0, total: 0, max: 0, last: 0, pending: new Map() };
      this.buckets.set(name, bucket);
    }
    bucket.total += amount; bucket.last = amount; bucket.max = Math.max(bucket.max, amount);
  }

  response(response: object, method: string): void {
    if (this.enabled) this.responses.set(response, { method: this.method(method), bytes: 0, cached: false });
  }

  cacheHit(): void { if (this.enabled) this.cache.hits++; }

  cacheInsert(response: object): void {
    if (!this.enabled) return;
    const entry = this.responses.get(response) ?? { method: "other" as const, bytes: 0, cached: false };
    entry.cached = true;
    this.responses.set(response, entry);
    this.cache.inserts++; this.cache.current++;
    this.cache.jsonUtf8Bytes += entry.bytes;
    if (entry.bytes) this.cache.encodedItems++;
  }

  cacheEvict(response: object): void {
    if (!this.enabled) return;
    const entry = this.responses.get(response);
    // Responses cached before enabling are outside the tracked-since-enable metrics.
    if (!entry?.cached) return;
    entry.cached = false;
    this.cache.evicts++; this.cache.current--;
    this.cache.jsonUtf8Bytes -= entry.bytes;
    if (entry.bytes) this.cache.encodedItems--;
  }

  encoded(payload: BridgePayload, bytes: number): void {
    if (!this.enabled || payload.kind !== "response") return;
    const entry = this.responses.get(payload);
    this.observe(`response.${entry?.method ?? "other"}`, bytes);
    if (!entry) return;
    if (entry.cached) {
      this.cache.jsonUtf8Bytes += bytes - entry.bytes;
      if (!entry.bytes) this.cache.encodedItems++;
    }
    entry.bytes = bytes;
  }

  snapshot() {
    const now = Date.now();
    return { schema: 1, at: now, pid: process.pid, uptime: process.uptime(), sampleGapMs: now - this.lastSampleAt,
      units: { native: "inspector-reply-UTF16-code-units", response: "JSON-UTF8-bytes-before-compression", age: "milliseconds", cache: "tracked-since-enable" },
      memory: process.memoryUsage(), cache: { ...this.cache },
      heapSnapshot: { heapSizeLimit: getHeapStatistics().heap_size_limit, thresholdRatio: this.heapSnapshotThreshold, ...this.heapSnapshot },
      stages: Object.fromEntries([...this.buckets].map(([name, bucket]) => [name, {
        started: bucket.started, settled: bucket.settled, active: bucket.pending.size, peak: bucket.peak,
        oldestMs: bucket.pending.size ? now - bucket.pending.values().next().value! : 0,
        total: bucket.total, max: bucket.max, last: bucket.last,
      }])),
    };
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.close();
    this.enabled = enabled;
    if (enabled) this.start(this.path!);
  }

  start(path: string): void {
    this.path = path;
    if (!this.enabled) return;
    this.buckets.clear();
    this.responses = new WeakMap();
    Object.assign(this.cache, { inserts: 0, evicts: 0, hits: 0, current: 0, encodedItems: 0, jsonUtf8Bytes: 0 });
    this.lastSampleAt = Date.now();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    chmodSync(dirname(path), 0o700);
    this.heapSnapshotPath = join(dirname(path), `heap-${Date.now()}-${process.pid}.heapsnapshot`);
    closeSync(openSync(path, "a", 0o600));
    chmodSync(path, 0o600);
    this.database = new DatabaseSync(path);
    this.database.exec(`PRAGMA page_size=4096; PRAGMA max_page_count=8192; PRAGMA journal_mode=WAL; PRAGMA journal_size_limit=262144; PRAGMA busy_timeout=0;
      CREATE TABLE IF NOT EXISTS samples (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, uptime INTEGER NOT NULL, event TEXT NOT NULL, data TEXT NOT NULL);`);
    this.insertSample = this.database.prepare("INSERT INTO samples (at,data) VALUES (?,?)");
    this.pruneSamples = this.database.prepare("DELETE FROM samples WHERE id IN (SELECT id FROM samples ORDER BY id DESC LIMIT -1 OFFSET 899)");
    this.insertEvent = this.database.prepare("INSERT INTO events (at,uptime,event,data) VALUES (?,?,?,?)");
    this.pruneEvents = this.database.prepare("DELETE FROM events WHERE id <= (SELECT max(id) FROM events) - 49999");
    BridgeCrypto.observeEncodedPayload = (payload, bytes) => this.encoded(payload, bytes);
    this.write();
    if (!this.database) return;
    this.timer = setInterval(() => this.write(), 1000);
    this.timer.unref();
  }

  private persist(write: () => void): boolean {
    this.database!.exec("BEGIN IMMEDIATE");
    try {
      write();
      this.database!.exec("COMMIT");
      return true;
    } catch (error) {
      if (this.database!.isTransaction) this.database!.exec("ROLLBACK");
      process.stderr.write(`Bridge diagnostics stopped: ${(error as { code?: string }).code ?? "DIAG_WRITE_FAILED"}\n`);
      this.close();
      return false;
    }
  }

  write(): void {
    if (!this.database) return;
    const sample = this.snapshot();
    const capture = !this.heapSnapshot.attempted && sample.memory.heapUsed >= sample.heapSnapshot.heapSizeLimit * this.heapSnapshotThreshold;
    if (capture) this.heapSnapshot.attempted = sample.heapSnapshot.attempted = 1;
    if (!this.persist(() => {
      this.pruneSamples!.run();
      this.insertSample!.run(sample.at, JSON.stringify(sample));
    })) return;
    this.lastSampleAt = sample.at;
    if (capture) {
      try {
        closeSync(openSync(this.heapSnapshotPath!, "wx", 0o600));
        writeHeapSnapshot(this.heapSnapshotPath!);
        this.heapSnapshot.written = 1;
      } catch (error) {
        this.heapSnapshot.failed = 1;
        process.stderr.write(`Bridge diagnostic heap snapshot failed: ${(error as { code?: string }).code ?? "SNAPSHOT_FAILED"}\n`);
      }
    }
  }

  close(): void {
    this.enabled = false;
    clearInterval(this.timer);
    this.timer = undefined;
    BridgeCrypto.observeEncodedPayload = undefined;
    for (const bucket of this.buckets.values()) bucket.pending.clear();
    this.database?.close();
    this.database = undefined;
  }
}

export const diagnostics = new Diagnostics();
export const diag = (event: Stage, fields?: Fields): void => diagnostics.event(event, fields);
