import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionEventLog } from "./session-event-log.js";

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
    await first.append({
      sessionId: "session-1",
      origin: "mobile",
      type: "user.message.accepted",
      itemId: "user-1",
      data: { text: "Continue" },
    });
    first.appendCoalescedDelta({
      sessionId: "session-1",
      origin: "claude-host",
      type: "assistant.delta",
      itemId: "assistant-1",
    }, "Hel");
    first.appendCoalescedDelta({
      sessionId: "session-1",
      origin: "claude-host",
      type: "assistant.delta",
      itemId: "assistant-1",
    }, "lo");
    await first.flushDeltas();
    await first.append({
      sessionId: "session-1",
      origin: "claude-desktop",
      type: "session.observed",
      itemId: "interrupted-control",
      data: { role: "user", text: "[Request interrupted by user]" },
    });
    await first.append({
      sessionId: "session-1",
      origin: "claude-desktop",
      type: "session.observed",
      itemId: "synthetic-control",
      data: { role: "assistant", text: "No response requested." },
    });
    await first.close();

    const reopened = new SessionEventLog(path);
    await reopened.initialize();
    expect(reopened.replay()).toHaveLength(4);
    expect(reopened.replay(1)[0]).toMatchObject({ seq: 2, data: { text: "Hello" } });
    expect(reopened.latestItem("session-1", "user.message.accepted", "user-1")).toMatchObject({
      seq: 1,
      data: { text: "Continue" },
    });
    expect(reopened.history("session-1").items).toMatchObject([
      { role: "user", text: "Continue" },
    ]);
    await reopened.close();
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

  it.each(["tool.progress", "tool.completed"] as const)("does not claim a turn state for unknown subagents in %s history", async (type) => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-events-unknown-task-"));
    directories.push(directory);
    const log = new SessionEventLog(join(directory, "events.jsonl"));
    try {
      await log.append({ sessionId: "session-1", itemId: "task-1", origin: "claude-host", type: "tool.started", data: { toolName: "Agent" } });
      await log.append({ sessionId: "session-1", itemId: "task-1", origin: "claude-host", type, data: {
        toolName: "Agent", subagent: { agentId: "task-1", description: "Inspect", state: "unknown", toolCount: 0, startedAt: 100, updatedAt: 200 },
      } });
      const items = log.history("session-1").items;
      expect(items).toHaveLength(1);
      expect(items[0]?.subagent?.state).toBe("unknown");
      expect(items[0]?.state).toBeUndefined();
    } finally {
      await log.close();
    }
  });

  it("matches terminal receipts to accepted message IDs across reopening and compaction", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-events-settled-"));
    directories.push(directory);
    const path = join(directory, "events.jsonl");
    const first = new SessionEventLog(path);
    await first.append({ sessionId: "session-1", turnId: "turn-1", itemId: "user-1", type: "user.message.accepted", origin: "mobile" });
    expect(first.isUserMessageSettled("session-1", "user-1")).toBe(false);
    await first.append({ sessionId: "session-1", turnId: "other-turn", type: "turn.completed", origin: "claude-host" });
    await first.append({ sessionId: "other-session", turnId: "turn-1", type: "turn.completed", origin: "claude-host" });
    await first.append({ sessionId: "session-1", turnId: "turn-1", type: "runtime.error", origin: "claude-host", data: { retrying: true, delivery: "host-received" } });
    expect(first.isUserMessageSettled("session-1", "user-1")).toBe(false);
    await first.append({ sessionId: "session-1", turnId: "turn-1", type: "turn.completed", origin: "claude-host", data: { result: "" } });
    await first.append({ sessionId: "session-1", turnId: "turn-2", itemId: "user-2", type: "user.message.accepted", origin: "mobile" });
    expect(first.isUserMessageSettled("session-1", "user-1")).toBe(true);
    expect(first.isUserMessageSettled("session-1", "user-2")).toBe(false);
    for (let index = 0; index < 5; index += 1) {
      await first.append({ sessionId: "another-session", type: "session.observed", origin: "claude-desktop", itemId: `noise-${index}`, data: { role: "assistant", text: "Other work" } });
    }
    await first.close();
    const reopened = new SessionEventLog(path, 80, { bytesThreshold: 1, retainEvents: 2 });
    try {
      await reopened.initialize();
      expect(reopened.isUserMessageSettled("session-1", "user-1")).toBe(true);
      expect(reopened.isUserMessageSettled("session-1", "user-2")).toBe(false);
    } finally {
      await reopened.close();
    }
    const twiceReopened = new SessionEventLog(path);
    try {
      await twiceReopened.initialize();
      expect(twiceReopened.isUserMessageSettled("session-1", "user-1")).toBe(true);
      expect(twiceReopened.isUserMessageSettled("session-1", "user-2")).toBe(false);
    } finally {
      await twiceReopened.close();
    }
  });

  it("finds execution evidence beyond the UI replay limit without treating queueing as submission", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-event-evidence-"));
    directories.push(directory);
    const log = new SessionEventLog(join(directory, "events.jsonl"));
    for (let index = 0; index < 1_005; index += 1) {
      await log.append({ sessionId: "session-1", origin: "system", type: "session.desktop-registration" });
    }
    await log.append({ sessionId: "session-1", itemId: "command-1", origin: "mobile", type: "turn.queued", data: { commandId: "command-1", delivery: "host-received" } });
    expect(log.turnEvidence({ sessionId: "session-1", commandId: "command-1" })).toEqual({});
    await log.append({ sessionId: "session-1", turnId: "turn-1", itemId: "user-1", origin: "claude-host", type: "message.delivery", data: { commandId: "command-1", delivery: "submitted" } });
    expect(log.turnEvidence({ sessionId: "session-1", commandId: "command-1" })).toEqual({ submitted: true, messageId: "user-1" });
    await log.append({ sessionId: "session-1", turnId: "turn-1", itemId: "user-1", origin: "mobile", type: "user.message.accepted", data: { commandId: "command-1", text: "payload" } });
    await log.append({ sessionId: "session-1", turnId: "turn-1", origin: "claude-host", type: "turn.failed" });
    expect(log.replay(0, 2_000)).toHaveLength(1_000);
    expect(log.turnEvidence({ sessionId: "session-1", commandId: "command-1" })).toEqual({ submitted: true, accepted: true, terminal: "failed", messageId: "user-1" });
    expect(log.turnEvidence({ sessionId: "other", turnId: "turn-1" })).toEqual({});
    await log.close();
  });

  it("preserves all compact receipts, user mappings, and task progress through two compactions and reloads", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-event-receipts-"));
    directories.push(directory);
    const path = join(directory, "events.jsonl");
    const first = new SessionEventLog(path);
    for (const [index, type] of ["turn.completed", "turn.failed", "turn.interrupted", "runtime.error"].entries()) {
      await first.append({ sessionId: "session-1", turnId: `turn-${index}`, itemId: `user-${index}`, type: "user.message.accepted", origin: "mobile", data: { commandId: `command-${index}`, text: "OMIT_FULL_INPUT_PAYLOAD" } });
      await first.append({ sessionId: "session-1", turnId: `turn-${index}`, type: type as "turn.completed" | "turn.failed" | "turn.interrupted" | "runtime.error", origin: "claude-host", data: { delivery: type === "runtime.error" ? "failed" : undefined, result: "OMIT_FULL_RESULT_PAYLOAD" } });
    }
    await first.append({ sessionId: "session-1", turnId: "unconfirmed", itemId: "unconfirmed-user", type: "message.delivery", origin: "claude-host", data: { commandId: "unconfirmed-command", delivery: "submitted" } });
    await first.append({ sessionId: "session-1", turnId: "pending", itemId: "pending-user", type: "message.delivery", origin: "claude-host", data: { commandId: "pending-command", delivery: "submitted" } });
    await first.append({ sessionId: "session-1", turnId: "pending", itemId: "task-1", type: "tool.progress", origin: "claude-host", data: { toolName: "Agent", generation: "generation-1", task: { taskId: "task-1", toolUseId: "task-1", state: "running" }, text: "OMIT_FULL_PROGRESS_PAYLOAD", subagent: { agentId: "agent-1", description: "Background task", state: "running", toolCount: 3, startedAt: 1, updatedAt: 2, latestText: "OMIT_FULL_REPORT_PAYLOAD" } } });
    for (let index = 0; index < 8; index += 1) {
      await first.append({ sessionId: "other", type: "session.observed", origin: "claude-desktop", itemId: `noise-${index}`, data: { role: "assistant", text: "Unrelated" } });
    }
    // The highest sequence is itself discarded by compaction.
    await first.append({ sessionId: "other", type: "assistant.delta", origin: "claude-host", data: { text: "OMIT_FINAL_DELTA" } });
    const lastSeq = first.latestSeq();
    await first.close();
    for (const compact of [true, false, true, false]) {
      const reopened = new SessionEventLog(path, 80, compact ? { bytesThreshold: 1, retainEvents: 2 } : undefined);
      await reopened.initialize();
      for (const [index, terminal] of ["completed", "failed", "cancelled", "failed"].entries()) {
        expect(reopened.turnEvidence({ sessionId: "session-1", commandId: `command-${index}` })).toEqual({ accepted: true, submitted: true, terminal, messageId: `user-${index}` });
        expect(reopened.isUserMessageSettled("session-1", `user-${index}`)).toBe(true);
        expect(reopened.hasItem("session-1", "user.message.accepted", `user-${index}`)).toBe(true);
      }
      expect(reopened.turnEvidence({ sessionId: "session-1", commandId: "unconfirmed-command" })).toEqual({ submitted: true, messageId: "unconfirmed-user" });
      expect(reopened.turnEvidence({ sessionId: "session-1", turnId: "pending" })).toEqual({ submitted: true, accepted: true, messageId: "pending-user" });
      expect(reopened.isUserMessageSettled("session-1", "pending-user")).toBe(false);
      expect(reopened.hasItem("session-1", "tool.progress", "task-1")).toBe(true);
      expect(reopened.latestItem("session-1", "tool.progress", "task-1")).toMatchObject({ data: { toolName: "Agent", subagent: { agentId: "agent-1", state: "running", toolCount: 3 } } });
      expect(reopened.latestTaskEvents("session-1")).toMatchObject([{ itemId: "task-1", type: "tool.progress", data: { generation: "generation-1", task: { taskId: "task-1", state: "running" } } }]);
      expect(reopened.latestSeq()).toBe(lastSeq);
      expect(reopened.replay()).toHaveLength(2);
      await reopened.close();
      expect(await readFile(path, "utf8")).not.toContain("OMIT_");
    }
  });

  it("keeps explicit attempts separate and restores the latest task state by sequence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-event-attempts-"));
    directories.push(directory);
    const path = join(directory, "events.jsonl");
    const first = new SessionEventLog(path);
    await first.append({ sessionId: "session-1", turnId: "old-turn", itemId: "old-user", type: "user.message.accepted", origin: "mobile", data: { commandId: "command-1" } });
    await first.append({ sessionId: "session-1", turnId: "old-turn", type: "turn.failed", origin: "claude-host", data: { commandId: "command-1" } });
    expect(first.turnEvidence({ sessionId: "session-1", turnId: "new-turn", commandId: "command-1", messageId: "new-user" })).toEqual({ messageId: "new-user" });
    await first.append({ sessionId: "session-1", turnId: "new-turn", itemId: "new-user", type: "message.delivery", origin: "claude-host", data: { commandId: "command-1", delivery: "submitted" } });
    await first.append({ sessionId: "session-1", itemId: "task-1", type: "tool.completed", origin: "claude-host", data: { task: { taskId: "task-1", state: "completed" }, generation: "old" } });
    await first.append({ sessionId: "session-1", itemId: "task-1", type: "tool.progress", origin: "claude-host", data: { task: { taskId: "task-1", state: "running" }, generation: "new" } });
    await first.append({ sessionId: "session-1", itemId: "task-2", type: "tool.progress", origin: "claude-host", data: { subagent: { agentId: "agent-2", state: "running" } } });
    await first.append({ sessionId: "session-1", itemId: "task-2", type: "tool.completed", origin: "claude-host", data: { subagent: { agentId: "agent-2", state: "completed" } } });
    await first.close();
    for (const compact of [true, false]) {
      const log = new SessionEventLog(path, 80, compact ? { bytesThreshold: 1, retainEvents: 0 } : undefined);
      await log.initialize();
      expect(log.turnEvidence({ sessionId: "session-1", commandId: "command-1" })).toEqual({ submitted: true, messageId: "new-user" });
      expect(log.turnEvidence({ sessionId: "session-1", turnId: "old-turn" })).toMatchObject({ terminal: "failed", messageId: "old-user" });
      expect(log.latestTaskEvents("session-1")).toMatchObject([
        { itemId: "task-1", type: "tool.progress", data: { generation: "new", task: { state: "running" } } },
        { itemId: "task-2", type: "tool.completed", data: { subagent: { state: "completed" } } },
      ]);
      await log.close();
    }
  });

  it("keeps canonical task facts when generic progress for the same item arrives later", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-event-task-heartbeat-"));
    directories.push(directory);
    const path = join(directory, "events.jsonl");
    const first = new SessionEventLog(path);
    await first.append({ sessionId: "session-1", itemId: "task-1", type: "tool.progress", origin: "claude-host", data: { task: { taskId: "task-1", state: "running" }, subagent: { agentId: "task-1", state: "running" }, generation: "host-1" } });
    await first.append({ sessionId: "session-1", itemId: "task-1", type: "tool.progress", origin: "claude-host", data: { toolName: "Agent", text: "Still running" } });
    expect(first.latestTaskEvents("session-1")).toMatchObject([{ data: { task: { taskId: "task-1", state: "running" }, generation: "host-1" } }]);
    expect(first.history("session-1").items).toMatchObject([{ subagent: { agentId: "task-1", state: "running" } }]);
    await first.append({ sessionId: "session-1", itemId: "task-2", type: "tool.progress", origin: "claude-host", data: { task: { taskId: "task-2", state: "running" }, generation: "host-1" } });
    await first.append({ sessionId: "session-1", itemId: "task-2", type: "tool.completed", origin: "claude-host", data: { task: { taskId: "task-2", state: "completed" }, generation: "host-1" } });
    await first.append({ sessionId: "session-1", itemId: "task-2", type: "tool.progress", origin: "claude-host", data: { text: "Late heartbeat" } });
    expect(first.latestTaskEvents("session-1").find((event) => event.itemId === "task-2")?.type).toBe("tool.completed");
    await first.close();
    for (const compact of [false, true, false]) {
      const log = new SessionEventLog(path, 80, compact ? { bytesThreshold: 1, retainEvents: 0 } : undefined);
      await log.initialize();
      expect(log.latestTaskEvents("session-1")).toMatchObject([
        { data: { task: { taskId: "task-1", state: "running" }, subagent: { agentId: "task-1" }, generation: "host-1" } },
        { type: "tool.completed", data: { task: { taskId: "task-2", state: "completed" } } },
      ]);
      await log.close();
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
      await log.initialize();
      expect(log.itemMatches("session-1", "session.observed", "message-1", data)).toBe(true);
      expect(log.itemMatches("session-1", "session.observed", "message-1", { text: data.text })).toBe(true);
      expect(log.itemMatches("session-1", "session.observed", "message-1", { ...data, interactivePrompt: { kind: "question", ask: "Changed" } })).toBe(false);
      expect(log.itemMatches("session-1", "session.observed", "empty", { text: "", interactivePrompt: undefined })).toBe(true);
      expect(log.itemMatches("session-1", "session.observed", "missing", { text: undefined, interactivePrompt: undefined })).toBe(true);
      expect(log.itemMatches("session-1", "session.observed", "missing", { text: "" })).toBe(false);
      expect(log.itemMatches("session-1", "session.observed", "absent", { text: undefined })).toBe(false);
      await log.close();
      expect(await readFile(path, "utf8")).not.toContain("OMIT_");
    }
  });

  it("retains only dedup and task item receipts while preserving command evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-event-receipt-types-"));
    directories.push(directory);
    const path = join(directory, "events.jsonl");
    const first = new SessionEventLog(path);
    for (const type of ["assistant.delta", "permission.requested", "evidence.updated", "evidence.ready", "message.delivery", "turn.queued"] as const) {
      await first.append({ sessionId: "session-1", turnId: "turn-1", itemId: `disposable-${type}`, type, origin: "system", data: { commandId: "command-1", delivery: "submitted" } });
    }
    await first.append({ sessionId: "session-1", turnId: "turn-1", type: "turn.completed", origin: "claude-host", data: { commandId: "command-1" } });
    await first.close();
    const log = new SessionEventLog(path, 80, { bytesThreshold: 1, retainEvents: 0 });
    await log.initialize();
    expect(log.turnEvidence({ sessionId: "session-1", commandId: "command-1" })).toMatchObject({ submitted: true, terminal: "completed" });
    const index = JSON.parse((await readFile(path, "utf8")).split("\n")[0]!);
    expect(index.items).toEqual([]);
    expect(index.turns).toHaveLength(1);
    await log.close();
  });

  it("compacts an oversized log, dropping registration churn and stream deltas", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-events-"));
    directories.push(directory);
    const path = join(directory, "events.jsonl");
    const first = new SessionEventLog(path, 1);
    // Junk that used to flood the log: no-op registration events and deltas.
    for (let index = 0; index < 5; index += 1) {
      await first.append({
        sessionId: "session-1",
        origin: "system",
        type: "session.desktop-registration",
        data: { state: "registered", updatedAt: index },
      });
    }
    await first.append({
      sessionId: "session-1",
      origin: "claude-host",
      type: "assistant.delta",
      itemId: "assistant-1",
      data: { text: "partial" },
    });
    await first.append({
      sessionId: "session-1",
      origin: "mobile",
      type: "user.message.accepted",
      itemId: "user-1",
      data: { text: "Continue" },
    });
    await first.append({
      sessionId: "session-1",
      origin: "claude-host",
      type: "assistant.completed",
      itemId: "assistant-1",
      data: { text: "Done" },
    });
    const lastSeq = first.latestSeq();
    await first.close();

    // A 1-byte threshold forces the compaction path on reopen.
    const reopened = new SessionEventLog(path, 80, { bytesThreshold: 1 });
    await reopened.initialize();
    expect(reopened.replay().map((event) => event.type)).toEqual([
      "user.message.accepted",
      "assistant.completed",
    ]);
    // Sequences stay monotonic across compaction; dedup indexes survive.
    expect(reopened.latestSeq()).toBe(lastSeq);
    expect(reopened.hasItem("session-1", "user.message.accepted", "user-1")).toBe(true);
    expect(reopened.latestItem("session-1", "assistant.completed", "assistant-1")).toMatchObject({
      data: { text: "Done" },
    });
    await reopened.append({
      sessionId: "session-1",
      origin: "system",
      type: "session.archived",
      data: { sessionId: "session-1", archived: true, archivedAt: 1 },
    });
    expect(reopened.latestSeq()).toBe(lastSeq + 1);
    await reopened.close();
  });

  it("keeps only the bounded tail when the retained window overflows", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-events-"));
    directories.push(directory);
    const path = join(directory, "events.jsonl");
    const first = new SessionEventLog(path, 1);
    for (let index = 0; index < 6; index += 1) {
      await first.append({
        sessionId: "session-1",
        origin: "claude-desktop",
        type: "session.observed",
        itemId: `message-${index}`,
        data: { role: "assistant", text: `m${index}` },
      });
    }
    await first.close();

    const reopened = new SessionEventLog(path, 80, { bytesThreshold: 1, retainEvents: 3 });
    await reopened.initialize();
    expect(reopened.replay().map((event) => event.data.text)).toEqual(["m3", "m4", "m5"]);
    expect(reopened.latestSeq()).toBe(6);
    await reopened.close();
  });
});
