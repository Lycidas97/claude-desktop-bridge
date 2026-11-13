import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionEventLog } from "./session-event-log.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("SessionEventLog", () => {
  it("persists monotonic events and resumes after a cursor", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-events-"));
    directories.push(directory);
    const path = join(directory, "events.jsonl");
    const first = new SessionEventLog(path, 1);
    await first.append({ sessionId: "session-1", origin: "mobile", type: "user.message.accepted", itemId: "user-1", data: { text: "Continue" } });
    first.appendCoalescedDelta({ sessionId: "session-1", origin: "claude-host", type: "assistant.delta", itemId: "assistant-1" }, "Hel");
    first.appendCoalescedDelta({ sessionId: "session-1", origin: "claude-host", type: "assistant.delta", itemId: "assistant-1" }, "lo");
    await first.flushDeltas();
    await first.close();

    const reopened = new SessionEventLog(path);
    try {
      await reopened.initialize();
      expect(reopened.replay()).toHaveLength(2);
      expect(reopened.replay(1)[0]).toMatchObject({ seq: 2, data: { text: "Hello" } });
      expect(reopened.latestItem("session-1", "user.message.accepted", "user-1")).toMatchObject({ seq: 1, data: { text: "Continue" } });
    } finally {
      await reopened.close();
    }
  });

  it("keeps command UUID receipts and text digests after the replay window is compacted away", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-command-receipts-"));
    directories.push(directory);
    const path = join(directory, "events.jsonl");
    const first = new SessionEventLog(path);
    try {
      for (const type of ["command.output", "command.status", "session.compacted", "session.reset"] as const) {
        await first.append({ sessionId: "session-1", itemId: `item-${type}`, origin: "claude-host", type, data: { text: `OMIT_PAYLOAD_${type}` } });
      }
    } finally {
      await first.close();
    }
    for (const compact of [true, false, true, false]) {
      const log = new SessionEventLog(path, 80, compact ? { bytesThreshold: 1, retainEvents: 0 } : undefined);
      try {
        await log.initialize();
        expect(log.replay()).toEqual([]);
        for (const type of ["command.output", "command.status", "session.compacted", "session.reset"] as const) {
          expect(log.latestItem("session-1", type, `item-${type}`)).toMatchObject({ type, itemId: `item-${type}` });
          expect(log.itemMatches("session-1", type, `item-${type}`, { text: `OMIT_PAYLOAD_${type}` })).toBe(true);
          expect(log.itemMatches("session-1", type, `item-${type}`, { text: "Changed" })).toBe(false);
          expect(log.latestItem("other-session", type, `item-${type}`)).toBeUndefined();
        }
        expect(await readFile(path, "utf8")).not.toContain("OMIT_PAYLOAD_");
      } finally {
        await log.close();
      }
    }
  });

  it("keeps the latest activity aggregate without displacing conversation events during compaction", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-progress-compaction-"));
    directories.push(directory);
    const path = join(directory, "events.jsonl");
    const compaction = { bytesThreshold: 1, retainEvents: 3, retainBytes: 100_000 };
    const log = new SessionEventLog(path, 1, compaction);
    try {
      await log.append({ sessionId: "session-1", origin: "claude-host", type: "assistant.completed", data: { text: "Done" } });
      for (let timestamp = 1; timestamp <= 20; timestamp++) {
        await log.append({ sessionId: "session-1", itemId: "session:subagent-activity", origin: "system", type: "runtime.updated",
          data: { session: { sessionId: "session-1", lastActivityAt: timestamp, runningSubagents: { count: 1, lastUpdatedAt: timestamp } } },
        });
      }
      expect(log.replay()).toHaveLength(2);
      expect(log.replay()[1]).toMatchObject({ seq: 21, data: { session: { lastActivityAt: 20 } } });
    } finally {
      await log.close();
    }
    const reopened = new SessionEventLog(path, 1, compaction);
    try {
      await reopened.initialize();
      expect(reopened.replay().map(event => event.type)).toEqual(["assistant.completed", "runtime.updated"]);
      expect(reopened.replay()[1]).toMatchObject({ seq: 21, data: { session: { lastActivityAt: 20 } } });
    } finally {
      await reopened.close();
    }
  });

  it("coalesces activity per session while preserving cursor replay across compaction", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-progress-siblings-"));
    directories.push(directory);
    const path = join(directory, "events.jsonl");
    const compaction = { bytesThreshold: 1, retainEvents: 3, retainBytes: 100_000 };
    const log = new SessionEventLog(path, 1, compaction);
    try {
      for (const [sessionId, lastActivityAt] of [["A", 10], ["B", 20], ["A", 30]] as const) {
        await log.append({ sessionId, itemId: "session:subagent-activity", origin: "system", type: "runtime.updated", data: { session: { sessionId, lastActivityAt } } });
      }
      expect(log.replay(1).map(event => [event.sessionId, event.seq])).toEqual([["B", 2], ["A", 3]]);
    } finally {
      await log.close();
    }
    const reopened = new SessionEventLog(path, 1, compaction);
    try {
      await reopened.initialize();
      expect(reopened.replay(1).map(event => [event.sessionId, event.seq, (event.data.session as { lastActivityAt: number }).lastActivityAt])).toEqual([["B", 2, 20], ["A", 3, 30]]);
      expect(reopened.replay(3)).toEqual([]);
    } finally {
      await reopened.close();
    }
  });

  it("keeps canonical task facts when generic progress for the same item arrives later", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-event-task-heartbeat-"));
    directories.push(directory);
    const path = join(directory, "events.jsonl");
    const first = new SessionEventLog(path);
    await first.append({ sessionId: "session-1", itemId: "task-1", type: "tool.progress", origin: "claude-host", data: { task: { taskId: "task-1", state: "running" }, subagent: { agentId: "task-1", state: "running" }, generation: "host-1" } });
    await first.append({ sessionId: "session-1", itemId: "task-1", type: "tool.progress", origin: "claude-host", data: { toolName: "Agent", text: "Still running" } });
    expect(first.latestItem("session-1", "tool.progress", "task-1")).toMatchObject({ data: { task: { state: "running" }, subagent: { agentId: "task-1", state: "running" }, generation: "host-1" } });
    await first.append({ sessionId: "session-1", itemId: "task-2", type: "tool.progress", origin: "claude-host", data: { task: { taskId: "task-2", state: "running" }, generation: "host-1" } });
    await first.append({ sessionId: "session-1", itemId: "task-2", type: "tool.completed", origin: "claude-host", data: { task: { taskId: "task-2", state: "completed" }, generation: "host-1" } });
    await first.append({ sessionId: "session-1", itemId: "task-2", type: "tool.progress", origin: "claude-host", data: { text: "Late heartbeat" } });
    await first.close();
    for (const compact of [false, true, false]) {
      const log = new SessionEventLog(path, 80, compact ? { bytesThreshold: 1, retainEvents: 0 } : undefined);
      try {
        await log.initialize();
        expect(log.latestItem("session-1", "tool.progress", "task-1")).toMatchObject({ data: { task: { state: "running" }, subagent: { agentId: "task-1" }, generation: "host-1" } });
        expect(log.latestItem("session-1", "tool.completed", "task-2")).toMatchObject({ data: { task: { state: "completed" } } });
        expect(log.latestItem("session-1", "tool.progress", "task-2")?.data).not.toHaveProperty("task");
      } finally {
        await log.close();
      }
    }
  });

  it("matches compact dedup digests across reload without storing full payloads", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-event-dedup-"));
    directories.push(directory);
    const path = join(directory, "events.jsonl");
    const first = new SessionEventLog(path);
    const data = { text: "OMIT_LONG_TEXT".repeat(10_000), interactivePrompt: { kind: "question", ask: "OMIT_LONG_PROMPT".repeat(10_000) } };
    await first.append({ sessionId: "session-1", itemId: "message-1", type: "session.observed", origin: "claude-desktop", data: { role: "assistant", ...data } });
    await first.append({ sessionId: "session-1", itemId: "empty", type: "session.observed", origin: "claude-desktop", data: { text: "", interactivePrompt: undefined } });
    await first.append({ sessionId: "session-1", itemId: "missing", type: "session.observed", origin: "claude-desktop" });
    await first.close();
    for (const compact of [true, false, true, false]) {
      const log = new SessionEventLog(path, 80, compact ? { bytesThreshold: 1, retainEvents: 0 } : undefined);
      try {
        await log.initialize();
        expect(log.itemMatches("session-1", "session.observed", "message-1", data)).toBe(true);
        expect(log.itemMatches("session-1", "session.observed", "message-1", { text: data.text })).toBe(true);
        expect(log.itemMatches("session-1", "session.observed", "message-1", { ...data, interactivePrompt: { kind: "question", ask: "Changed" } })).toBe(false);
        expect(log.itemMatches("session-1", "session.observed", "empty", { text: "", interactivePrompt: undefined })).toBe(true);
        expect(log.itemMatches("session-1", "session.observed", "missing", { text: undefined, interactivePrompt: undefined })).toBe(true);
        expect(log.itemMatches("session-1", "session.observed", "missing", { text: "" })).toBe(false);
        expect(log.itemMatches("session-1", "session.observed", "absent", { text: undefined })).toBe(false);
      } finally {
        await log.close();
      }
      expect(await readFile(path, "utf8")).not.toContain("OMIT_");
    }
  });

  it("compacts an oversized log, dropping registration churn and stream deltas", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-events-"));
    directories.push(directory);
    const path = join(directory, "events.jsonl");
    const first = new SessionEventLog(path, 1);
    for (let index = 0; index < 5; index += 1) {
      await first.append({ sessionId: "session-1", origin: "system", type: "session.desktop-registration", data: { state: "registered", updatedAt: index } });
    }
    await first.append({ sessionId: "session-1", origin: "claude-host", type: "assistant.delta", itemId: "assistant-1", data: { text: "partial" } });
    await first.append({ sessionId: "session-1", origin: "mobile", type: "user.message.accepted", itemId: "user-1", data: { text: "Continue" } });
    await first.append({ sessionId: "session-1", origin: "claude-host", type: "assistant.completed", itemId: "assistant-1", data: { text: "Done" } });
    const lastSeq = first.latestSeq();
    await first.close();

    const reopened = new SessionEventLog(path, 80, { bytesThreshold: 1 });
    try {
      await reopened.initialize();
      expect(reopened.replay().map((event) => event.type)).toEqual(["user.message.accepted", "assistant.completed"]);
      expect(reopened.latestSeq()).toBe(lastSeq);
      expect(reopened.latestItem("session-1", "user.message.accepted", "user-1")).toBeDefined();
      expect(reopened.latestItem("session-1", "assistant.completed", "assistant-1")).toMatchObject({ data: { text: "Done" } });
      await reopened.append({ sessionId: "session-1", origin: "system", type: "session.archived", data: { sessionId: "session-1", archived: true, archivedAt: 1 } });
      expect(reopened.latestSeq()).toBe(lastSeq + 1);
    } finally {
      await reopened.close();
    }
  });

  it("applies the event retention window while appending instead of only on reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-events-runtime-window-"));
    directories.push(directory);
    const log = new SessionEventLog(join(directory, "events.jsonl"), 1, { bytesThreshold: 1_000_000, retainEvents: 3, retainBytes: 1_000_000 });
    try {
      for (let index = 0; index < 12; index += 1) {
        await log.append({ sessionId: "session-1", turnId: "turn-1", itemId: `output-${index}`, origin: "claude-host", type: "command.output", data: { text: `line-${index}` } });
      }
      expect(log.replay(0, 100).map((event) => event.itemId)).toEqual(["output-9", "output-10", "output-11"]);
      expect(log.itemMatches("session-1", "command.output", "output-0", { text: "line-0" })).toBe(true);
      expect(log.latestItem("session-1", "command.output", "output-0")).toMatchObject({ seq: 1 });
      expect(log.latestItem("session-1", "command.output", "output-0")?.data).not.toHaveProperty("text");
      expect(log.latestItem("session-1", "command.output", "output-11")).toMatchObject({ data: { text: "line-11" } });
    } finally {
      await log.close();
    }
  });

  it("prefers full window payloads over narrow receipts until events age out", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-events-window-priority-"));
    directories.push(directory);
    const log = new SessionEventLog(join(directory, "events.jsonl"), 1, { bytesThreshold: 1_000_000, retainEvents: 2, retainBytes: 1_000_000 });
    try {
      await log.append({ sessionId: "session-1", itemId: "task-1", origin: "claude-host", type: "tool.progress", data: { toolName: "Agent", subagent: { agentId: "agent-1", state: "running", latestText: "window-step" } } });
      expect(log.latestItem("session-1", "tool.progress", "task-1")?.data.subagent).toMatchObject({ latestText: "window-step" });
      await log.append({ sessionId: "session-1", itemId: "output-1", origin: "claude-host", type: "command.output", data: { text: "evict-1" } });
      await log.append({ sessionId: "session-1", itemId: "output-2", origin: "claude-host", type: "command.output", data: { text: "evict-2" } });
      expect(log.latestItem("session-1", "tool.progress", "task-1")).toMatchObject({ data: { toolName: "Agent", subagent: { agentId: "agent-1", state: "running" } } });
      expect(log.latestItem("session-1", "tool.progress", "task-1")?.data.subagent).not.toHaveProperty("latestText");
    } finally {
      await log.close();
    }
  });

  it("bounds retained events by bytes while appending", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-events-runtime-bytes-"));
    directories.push(directory);
    const log = new SessionEventLog(join(directory, "events.jsonl"), 1, { bytesThreshold: 1_000_000, retainEvents: 100, retainBytes: 1_200 });
    try {
      for (let index = 0; index < 12; index += 1) {
        await log.append({ sessionId: "session-1", itemId: `payload-${index}`, origin: "claude-host", type: "command.output", data: { text: "x".repeat(400) } });
      }
      const retained = log.replay(0, 100);
      expect(retained.length).toBeGreaterThan(0);
      expect(retained.length).toBeLessThan(6);
      expect(retained.reduce((bytes, event) => bytes + Buffer.byteLength(JSON.stringify(event)) + 1, 0)).toBeLessThanOrEqual(1_200);
      expect(retained.at(-1)?.itemId).toBe("payload-11");
      await log.close();
      const reopened = new SessionEventLog(join(directory, "events.jsonl"));
      await reopened.initialize();
      expect(reopened.itemMatches("session-1", "command.output", "payload-0", { text: "x".repeat(400) })).toBe(true);
      await reopened.close();

      const crlfPath = join(directory, "crlf-events.jsonl");
      const seed = new SessionEventLog(crlfPath, 1);
      await seed.append({ sessionId: "session-1", itemId: "seed-1", origin: "claude-host", type: "command.output", data: { text: "s".repeat(500) } });
      await seed.close();
      const raw = (await readFile(crlfPath, "utf8")).trimEnd();
      await writeFile(crlfPath, `${raw}${" ".repeat(900)}\r\n`, "utf8");
      const loaded = new SessionEventLog(crlfPath, 1, { bytesThreshold: 1_000_000, retainEvents: 10, retainBytes: 900 });
      try {
        await loaded.append({ sessionId: "session-1", itemId: "next-1", origin: "claude-host", type: "command.output", data: { text: "a" } });
        await loaded.append({ sessionId: "session-1", itemId: "next-2", origin: "claude-host", type: "command.output", data: { text: "b" } });
        expect(loaded.replay(0, 10).map((event) => event.itemId)).toEqual(["next-1", "next-2"]);
      } finally {
        await loaded.close();
      }
    } finally {
      await log.close();
    }
  });

  it("keeps only the bounded tail when the retained window overflows", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-events-"));
    directories.push(directory);
    const path = join(directory, "events.jsonl");
    const first = new SessionEventLog(path, 1);
    for (let index = 0; index < 6; index += 1) {
      await first.append({ sessionId: "session-1", origin: "claude-desktop", type: "session.observed", itemId: `message-${index}`, data: { role: "assistant", text: `m${index}` } });
    }
    await first.close();
    const reopened = new SessionEventLog(path, 80, { bytesThreshold: 1, retainEvents: 3 });
    try {
      await reopened.initialize();
      expect(reopened.replay().map((event) => event.data.text)).toEqual(["m3", "m4", "m5"]);
      expect(reopened.latestSeq()).toBe(6);
    } finally {
      await reopened.close();
    }
  });

  it("migrates a multi-chunk v1 index to SQLite and keeps the replay file bounded across reopening", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-receipt-migration-"));
    directories.push(directory);
    const path = join(directory, "events.jsonl");
    const count = 5_000;
    const toolName = 'Agent "\\[]{}中文🙂';
    const digest = createHash("sha256").update(JSON.stringify("synthetic")).digest("base64url");
    const items = Array.from({ length: count }, (_, index) => ({
      eventId: `old-${index}`, seq: index + 1, timestamp: 100,
      sessionId: "session-1", itemId: `item-${index}`, origin: "claude-desktop", type: "tool.started",
      data: { toolName, subagent: { agentId: `agent-${index}`, description: "x".repeat(300), state: "completed" }, dedup: { text: digest } },
    }));
    const tail = { eventId: "tail", seq: count + 1, timestamp: 200, origin: "system", type: "host.presence", data: {} };
    const dropped = { ...tail, eventId: "delta", seq: count + 2, type: "assistant.delta" };
    await writeFile(path, `${JSON.stringify({ kind: "bridge.receipt-index", version: 1, lastSeq: count, turns: [{ sessionId: "old", terminal: "completed" }], items })}\n${JSON.stringify(tail)}\n${JSON.stringify(dropped)}\n`);
    for (const compact of [true, false, true]) {
      const log = new SessionEventLog(path, 80, compact ? { bytesThreshold: 1, retainEvents: 20, retainBytes: 4_096 } : undefined);
      try {
        await log.initialize();
        for (const index of [0, 999, 1_000, count - 1]) {
          expect(log.latestItem("session-1", "tool.started", `item-${index}`)).toMatchObject({ seq: index + 1, data: { toolName } });
          expect(log.itemMatches("session-1", "tool.started", `item-${index}`, { text: "synthetic" })).toBe(true);
          expect(log.itemMatches("session-1", "tool.started", `item-${index}`, { text: "changed" })).toBe(false);
        }
        expect(log.latestItem("other-session", "tool.started", "item-0")).toBeUndefined();
        expect(log.latestSeq()).toBe(count + 2);
        expect(log.replay()).toEqual([tail]);
      } finally {
        await log.close();
      }
      expect((await stat(path)).size).toBeLessThan(8_192);
      expect(JSON.parse((await readFile(path, "utf8")).split("\n")[0]!)).toEqual({ kind: "bridge.receipt-index", version: 2, lastSeq: count + 2 });
    }
    const appended = new SessionEventLog(path);
    try {
      expect(await appended.append({ origin: "system", type: "host.presence" })).toMatchObject({ seq: count + 3 });
    } finally {
      await appended.close();
    }
  });

  it("does not persist a receipt when the JSONL append fails, across reopening", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-receipt-failed-append-"));
    directories.push(directory);
    const path = join(directory, "events.jsonl");
    const seed = new SessionEventLog(path);
    await seed.append({ origin: "system", type: "host.presence" });
    await seed.close();
    const failed = new SessionEventLog(path);
    const draft = { sessionId: "session-1", itemId: "retry-message", origin: "claude-desktop" as const, type: "session.observed" as const, data: { role: "assistant", text: "Retry this event" } };
    try {
      await failed.initialize();
      vi.mocked(writeFile).mockRejectedValueOnce(Object.assign(new Error("JSONL append denied"), { code: "EACCES" }));
      await expect(failed.append(draft)).rejects.toMatchObject({ code: "EACCES" });
      expect(writeFile).toHaveBeenLastCalledWith(path, expect.any(String), { flag: "a", encoding: "utf8", mode: 0o600 });
    } finally {
      await failed.close();
    }
    const reopened = new SessionEventLog(path);
    try {
      await reopened.initialize();
      expect(reopened.latestSeq()).toBe(1);
      expect(reopened.replay().map(event => event.type)).toEqual(["host.presence"]);
      expect(reopened.itemMatches("session-1", "session.observed", "retry-message", draft.data)).toBe(false);
      expect(reopened.latestItem("session-1", "session.observed", "retry-message")).toBeUndefined();
      expect(await reopened.append(draft)).toMatchObject({ seq: 2 });
    } finally {
      await reopened.close();
    }
    const delivered = new SessionEventLog(path);
    try {
      await delivered.initialize();
      expect(delivered.latestSeq()).toBe(2);
      expect(delivered.itemMatches("session-1", "session.observed", "retry-message", draft.data)).toBe(true);
      expect(delivered.replay()).toHaveLength(2);
    } finally {
      await delivered.close();
    }
  });

  it.skipIf(process.platform === "win32")("keeps the SQLite database, WAL and SHM owner-only under umask 022", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-receipt-permissions-"));
    directories.push(directory);
    const path = join(directory, "events.jsonl");
    const previousUmask = process.umask(0o022);
    const log = new SessionEventLog(path);
    try {
      await log.append({ sessionId: "session-1", itemId: "tool-1", origin: "claude-desktop", type: "tool.started", data: { toolName: "Agent", subagent: { description: "Private task" } } });
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      for (const suffix of [".receipts.sqlite", ".receipts.sqlite-wal", ".receipts.sqlite-shm"]) {
        expect((await stat(`${path}${suffix}`)).mode & 0o777, suffix).toBe(0o600);
      }
    } finally {
      process.umask(previousUmask);
      await log.close();
    }
  });

  it("migrates a small v1 header even below the compaction threshold", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-small-receipt-migration-"));
    directories.push(directory);
    const path = join(directory, "events.jsonl");
    await writeFile(path, `${JSON.stringify({ kind: "bridge.receipt-index", version: 1, lastSeq: 42, turns: [], items: [] })}\n`);
    const log = new SessionEventLog(path);
    try {
      await log.initialize();
      expect(log.latestSeq()).toBe(42);
      expect(JSON.parse((await readFile(path, "utf8")).trim())).toEqual({ kind: "bridge.receipt-index", version: 2, lastSeq: 42 });
    } finally {
      await log.close();
    }
  });
});
