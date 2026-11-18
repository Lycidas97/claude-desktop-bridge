import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationStateStore, type NativeDesktopReceipt } from "./conversation-state-store.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

function withDatabase<T>(databasePath: string, run: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(databasePath);
  try {
    return run(db);
  } finally {
    db.close();
  }
}

async function createStore(): Promise<{
  directory: string;
  sessionsPath: string;
  queuePath: string;
  databasePath: string;
  store: ConversationStateStore;
}> {
  const directory = await mkdtemp(join(tmpdir(), "bridge-conversation-state-"));
  directories.push(directory);
  const sessionsPath = join(directory, "sessions-v2.json");
  const queuePath = join(directory, "turn-queue-v2.json");
  const databasePath = join(directory, "conversation-state-v1.sqlite");
  const store = new ConversationStateStore({
    databasePath,
    sessionsPath,
    queuePath,
    masterSecret: "test-conversation-state-secret",
  });
  return { directory, sessionsPath, queuePath, databasePath, store };
}

describe("ConversationStateStore", () => {
  it("initializes a new database with exactly the four retained tables", async () => {
    const { store, databasePath } = await createStore();
    try {
      await store.initialize();
    } finally {
      store.close();
    }
    withDatabase(databasePath, (db) => {
      expect(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all().map((row) => row.name))
        .toEqual(["conversation_meta", "native_desktop_receipts", "session_titles", "session_visibility"]);
      expect(db.prepare("SELECT value FROM conversation_meta WHERE key = 'version'").get()).toEqual({ value: "1" });
    });
  });

  it("persists display titles by full logical session ID", async () => {
    const { store } = await createStore();
    try {
      await store.initialize();
      expect(store.sessionTitle("native-1")).toBeUndefined();
      store.setSessionTitle("native-1", "手机名称");
      store.setSessionTitle("codex-desktop:native-1", "Codex 名称");
      store.setSessionTitle("native-1", "再次改名");
      store.close();
      expect(store.sessionTitle("native-1")).toBeUndefined();
      await store.initialize();
      await store.initialize();
      expect(store.sessionTitle("native-1")).toBe("再次改名");
      expect(store.sessionTitle("codex-desktop:native-1")).toBe("Codex 名称");
      store.close();
      expect(() => store.setSessionTitle("native-1", "失败写入")).toThrow();
      expect(store.sessionTitle("native-1")).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("leaves legacy sessions and queue files untouched and unimported across startups", async () => {
    const fixture = await createStore();
    const sessions = JSON.stringify({
      version: 2,
      sessions: [{ sessionId: "session-1", cwd: "/tmp/project-one", title: "Project one", createdAt: 1_000 }],
      configurations: [{ sessionId: "session-1", model: "legacy-model", updatedAt: 1_100 }],
    }, null, 2) + "\n";
    const queue = JSON.stringify({
      version: 2,
      pending: [{
        commandId: "command-1", requestId: "request-1", idempotencyKey: "idempotency-1", sessionId: "session-1",
        text: "continue", origin: "mobile", state: "queued",
      }],
      completedIdempotencyKeys: ["already-complete"],
      terminalTurns: [{
        idempotencyKey: "old-receipt", commandId: "old-command", requestId: "old-request", sessionId: "session-1", state: "completed",
      }],
    }, null, 2) + "\n";
    await writeFile(fixture.sessionsPath, sessions);
    await writeFile(fixture.queuePath, queue);
    const sourceStats = await Promise.all([fixture.sessionsPath, fixture.queuePath].map((path) => stat(path)));
    const receipt: NativeDesktopReceipt = {
      idempotencyKey: "native-key",
      commandId: "native-command",
      requestId: "native-request",
      sessionId: "native-session",
      messageId: "native-message",
      queueMode: "steered",
      state: "queued",
    };
    for (let startup = 0; startup < 3; startup += 1) {
      try {
        await fixture.store.initialize();
        if (startup === 0) {
          fixture.store.setSessionTitle("native-1", "Existing database title");
          fixture.store.saveNativeDesktopReceipt(receipt);
        }
        expect(fixture.store.sessionTitle("native-1")).toBe("Existing database title");
        expect(fixture.store.nativeDesktopReceipt(receipt.idempotencyKey)).toEqual(receipt);
        expect(fixture.store.listNativeDesktopReceipts()).toEqual([receipt]);
        expect(await readFile(fixture.sessionsPath, "utf8")).toBe(sessions);
        expect(await readFile(fixture.queuePath, "utf8")).toBe(queue);
        for (const [index, path] of [fixture.sessionsPath, fixture.queuePath].entries()) {
          const current = await stat(path);
          expect({ ino: current.ino, mtimeMs: current.mtimeMs }).toEqual({
            ino: sourceStats[index]!.ino,
            mtimeMs: sourceStats[index]!.mtimeMs,
          });
        }
        expect((await readdir(fixture.directory)).filter((name) => name.startsWith("sessions-v2.json") || name.startsWith("turn-queue-v2.json")).sort())
          .toEqual(["sessions-v2.json", "turn-queue-v2.json"]);
      } finally {
        fixture.store.close();
      }
    }
  });

  it("does not parse malformed legacy JSON and persists receipts by insertion order", async () => {
    const fixture = await createStore();
    await writeFile(fixture.sessionsPath, "{ untouched legacy sessions");
    await writeFile(fixture.queuePath, "old queue content");
    const first: NativeDesktopReceipt = {
      idempotencyKey: "k-1", commandId: "c-1", requestId: "r-1", sessionId: "s-1", messageId: "m-1", state: "dispatching",
    };
    const second: NativeDesktopReceipt = {
      idempotencyKey: "k-2", commandId: "c-2", requestId: "r-2", sessionId: "s-1", messageId: "m-2", state: "queued",
    };
    try {
      await fixture.store.initialize();
      fixture.store.saveNativeDesktopReceipt(first);
      fixture.store.saveNativeDesktopReceipt(second);
      fixture.store.saveNativeDesktopReceipt({ ...first, state: "completed" });
      fixture.store.close();
      await fixture.store.initialize();
      expect(fixture.store.nativeDesktopReceipt("k-1")?.state).toBe("completed");
      expect(fixture.store.listNativeDesktopReceipts().map((entry) => entry.idempotencyKey)).toEqual(["k-1", "k-2"]);
      expect(await readFile(fixture.sessionsPath, "utf8")).toBe("{ untouched legacy sessions");
      expect(await readFile(fixture.queuePath, "utf8")).toBe("old queue content");
    } finally {
      fixture.store.close();
    }
  });

  it("preserves historical schema and rows when opening an existing database", async () => {
    const { store, databasePath } = await createStore();
    withDatabase(databasePath, (db) => db.exec(`
      CREATE TABLE session_visibility (
        session_id TEXT PRIMARY KEY,
        visibility TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      INSERT INTO session_visibility VALUES ('native-1', 'archived', 10), ('native-2', 'deleted', 11);

      CREATE TABLE runtime_handoffs (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        source_runtime TEXT NOT NULL,
        source_session_id TEXT NOT NULL,
        source_native_session_id TEXT,
        target_runtime TEXT NOT NULL,
        target_session_id TEXT,
        target_native_session_id TEXT,
        objective TEXT NOT NULL,
        summary TEXT NOT NULL,
        plan_text TEXT,
        package_encrypted BLOB,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER
      ) STRICT;
      CREATE INDEX runtime_handoffs_source ON runtime_handoffs(source_session_id, created_at DESC);
      CREATE INDEX runtime_handoffs_target ON runtime_handoffs(target_session_id, created_at DESC);
      INSERT INTO runtime_handoffs (
        id, state, source_runtime, source_session_id, target_runtime, objective, summary, package_encrypted, created_at, updated_at
      ) VALUES ('old-handoff', 'applied', 'claude', 'old-session', 'codex', 'Objective', 'Summary', X'0080FF', 12, 13);
    `));
    const readHistoricalHandoffs = () => withDatabase(databasePath, (db) => ({
      schema: db.prepare("SELECT name, sql FROM sqlite_schema WHERE tbl_name = 'runtime_handoffs' ORDER BY name").all(),
      rows: db.prepare("SELECT * FROM runtime_handoffs ORDER BY id").all(),
    }));
    const historicalHandoffs = readHistoricalHandoffs();
    try {
      await store.initialize();
    } finally {
      store.close();
    }
    expect(readHistoricalHandoffs()).toEqual(historicalHandoffs);
    expect(withDatabase(databasePath, (db) => db.prepare(
      "SELECT session_id, visibility, updated_at FROM session_visibility ORDER BY session_id",
    ).all())).toEqual([
      { session_id: "native-1", visibility: "archived", updated_at: 10 },
      { session_id: "native-2", visibility: "deleted", updated_at: 11 },
    ]);
  });
});
