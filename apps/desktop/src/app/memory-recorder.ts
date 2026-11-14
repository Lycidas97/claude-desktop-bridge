import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

const INTERVAL_MS = 30_000;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ROWS = 20_160;
const COLUMNS = ["at", "uptime", "kind", "heapUsed", "heapTotal", "rss", "external", "arrayBuffers", "schemaVersion", "appVersion"] as const;

function operationErrorCode(error: unknown): string | undefined {
  const value = error as { code?: string; errcode?: number } | null;
  if (["EACCES", "EPERM", "ENOSPC", "EIO", "EROFS", "EMFILE", "ENFILE", "ENOENT", "ENOTDIR", "EISDIR", "EEXIST"].includes(value?.code ?? "")) return value!.code;
  if (value?.code === "ERR_SQLITE_ERROR" && typeof value.errcode === "number") {
    const primary = value.errcode & 255;
    // Operational SQLite failures only; SQL syntax/binding/type errors propagate.
    if ([3, 5, 6, 8, 10, 11, 13, 14, 26].includes(primary)) return `SQLITE_${primary}`;
  }
  return undefined;
}

/** Local numeric service samples only. Never reads Claude/session/device data. */
export class MemoryRecorder {
  private database: DatabaseSync | undefined;
  private insert: StatementSync | undefined;
  private prune: StatementSync | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private status: "not-started" | "recording" | "stopped" | "unavailable" = "not-started";
  private errorCode: string | undefined;

  constructor(private readonly databasePath: string, private readonly appVersion: string) {}

  initialize(): void {
    this.io(() => {
      mkdirSync(dirname(this.databasePath), { recursive: true, mode: 0o700 });
      closeSync(openSync(this.databasePath, "a", 0o600));
      chmodSync(this.databasePath, 0o600);
      this.database = new DatabaseSync(this.databasePath);
      this.database.exec(`
        PRAGMA page_size = 4096;
        PRAGMA max_page_count = 2048;
        PRAGMA journal_mode = PERSIST;
        PRAGMA journal_size_limit = 262144;
        PRAGMA busy_timeout = 0;
        CREATE TABLE IF NOT EXISTS samples (
          id INTEGER PRIMARY KEY, at INTEGER NOT NULL, uptime REAL NOT NULL, kind INTEGER NOT NULL,
          heap_used INTEGER NOT NULL, heap_total INTEGER NOT NULL, rss INTEGER NOT NULL,
          external INTEGER NOT NULL, array_buffers INTEGER NOT NULL,
          schema_version INTEGER NOT NULL, app_version TEXT NOT NULL
        );
      `);
      this.prune = this.database.prepare(`DELETE FROM samples WHERE at < ? OR id IN (
        SELECT id FROM samples ORDER BY id DESC LIMIT -1 OFFSET ${MAX_ROWS - 1}
      )`);
      this.insert = this.database.prepare("INSERT INTO samples (at, uptime, kind, heap_used, heap_total, rss, external, array_buffers, schema_version, app_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)");
      this.write(0);
      this.status = "recording";
      this.timer = setInterval(() => this.sample(), INTERVAL_MS);
      this.timer.unref();
    });
  }

  sample(): void {
    if (this.status === "recording") this.io(() => this.write(1));
  }

  private write(kind: number): void {
    const at = Date.now();
    const memory = process.memoryUsage();
    const database = this.database!;
    database.exec("BEGIN IMMEDIATE");
    try {
      this.prune!.run(at - RETENTION_MS);
      this.insert!.run(at, process.uptime(), kind, memory.heapUsed, memory.heapTotal, memory.rss, memory.external, memory.arrayBuffers, this.appVersion);
      database.exec("COMMIT");
    } finally {
      if (database.isTransaction) database.exec("ROLLBACK");
    }
  }

  diagnostics(): Record<string, unknown> {
    const rows = this.database ? this.io(() => {
      const query = this.database!.prepare(`SELECT at, uptime, kind, heap_used, heap_total, rss, external, array_buffers, schema_version, app_version
        FROM samples WHERE at >= ? ORDER BY id DESC LIMIT ${MAX_ROWS}`);
      query.setReturnArrays(true);
      return query.all(Date.now() - RETENTION_MS);
    }) ?? [] : [];
    return { schemaVersion: 1, status: this.status, ...(this.errorCode ? { errorCode: this.errorCode } : {}),
      intervalMs: INTERVAL_MS, retentionDays: 7, maxRows: MAX_ROWS, mainDatabaseLimitBytes: 8 * 1024 * 1024,
      kinds: { startup: 0, sample: 1, shutdown: 2 }, columns: COLUMNS, rows };
  }

  close(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    try {
      if (this.status === "recording") this.io(() => this.write(2));
    } finally {
      const database = this.database;
      this.database = undefined;
      this.insert = undefined;
      this.prune = undefined;
      if (this.status !== "unavailable") this.status = "stopped";
      if (database) this.io(() => database.close());
    }
  }

  private io<T>(work: () => T): T | undefined {
    try { return work(); } catch (error) {
      const code = operationErrorCode(error);
      if (!code) throw error;
      this.status = "unavailable";
      this.errorCode = code;
      clearInterval(this.timer);
      this.timer = undefined;
      const database = this.database;
      this.database = undefined;
      this.insert = undefined;
      this.prune = undefined;
      if (database) this.io(() => database.close());
      return undefined;
    }
  }
}
