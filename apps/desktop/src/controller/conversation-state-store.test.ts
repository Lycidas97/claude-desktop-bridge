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
  it("persists display titles by full logical session ID without seeding provider_profiles or broker rows", async () => {
    const { store, databasePath } = await createStore();
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
      expect(withDatabase(databasePath, (db) => db.prepare("SELECT id FROM provider_profiles").all())).toEqual([]);
      expect(withDatabase(databasePath, (db) => db.prepare("SELECT session_id FROM bridge_sessions").all())).toEqual([]);
      const tables = withDatabase(databasePath, (db) => (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
      )).map((row) => row.name);
      expect(tables).toEqual(expect.arrayContaining([
        "native_desktop_receipts",
        "conversation_meta",
        "provider_profiles",
        "conversations",
        "lanes",
        "handoffs",
        "bridge_sessions",
        "session_configurations",
        "turn_queue",
        "completed_idempotency_keys",
        "terminal_receipts",
        "migration_markers",
        "runtime_handoffs",
        "runtime_goals",
        "runtime_session_permissions",
        "session_titles",
        "session_visibility",
        "desktop_archive_requests",
      ]));
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

  it("persists session visibility markers across restarts", async () => {
    const fixture = await createStore();
    try {
      await fixture.store.initialize();

      fixture.store.setSessionVisibility("session-1", "archived");
      fixture.store.setSessionVisibility("codex-desktop:native-1", "deleted");
      fixture.store.setSessionVisibility("junk", "nonsense" as never);
    } finally {
      fixture.store.close();
    }
    const reopened = new ConversationStateStore({
      databasePath: fixture.databasePath,
    });
    try {
      await reopened.initialize();
      const entries = reopened.listSessionVisibility();
      expect(entries).toHaveLength(2);
      expect(entries.find((entry) => entry.sessionId === "session-1")?.visibility).toBe("archived");
      expect(entries.find((entry) => entry.sessionId === "codex-desktop:native-1")?.visibility).toBe("deleted");

      // Upgrading archived -> deleted reuses the row; clearing removes it.
      reopened.setSessionVisibility("session-1", "deleted");
      expect(reopened.listSessionVisibility().find((entry) => entry.sessionId === "session-1")?.visibility).toBe("deleted");
      reopened.setSessionVisibility("session-1", null);
      expect(reopened.listSessionVisibility().map((entry) => entry.sessionId)).toEqual(["codex-desktop:native-1"]);
    } finally {
      reopened.close();
    }
  });
});
