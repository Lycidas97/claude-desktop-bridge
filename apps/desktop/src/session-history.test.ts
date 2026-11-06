import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BridgeExecutionLane, BridgeInteractivePrompt, BridgeSubagentSummary } from "@bridge/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as history from "./claude-history.js";
import { readSessionHistory, type SessionHistoryOptions } from "./session-history.js";
import { SessionEventLog } from "./session-event-log.js";
import { SessionTaskState } from "./session-task-state.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fixture(): Promise<SessionHistoryOptions & { eventLog: SessionEventLog }> {
  const root = await mkdtemp(join(tmpdir(), "bridge-session-history-"));
  directories.push(root);
  return {
    paths: { projects: root },
    eventLog: new SessionEventLog(join(root, "events.jsonl")),
    taskState: new SessionTaskState(),
    session: { sessionId: "session-1", cwd: join(root, "project") },
    activeTurn: false,
    observedSessions: [],
  };
}

function lane(nativeSessionId: string | undefined, providerKind: "claude-official" | "claude-3p"): BridgeExecutionLane {
  return {
    laneId: `lane-${nativeSessionId ?? "empty"}`, conversationId: "session-1", providerProfileId: providerKind,
    providerKind, status: "active", access: "read-write", createdAt: 1, updatedAt: 1,
    ...(nativeSessionId ? { nativeSessionId } : {}),
  };
}

describe("readSessionHistory", () => {
  it("keeps native ordering timestamps when host events arrive late", async () => {
    const options = await fixture();
    await writeFile(join(options.paths.projects, "session-1.jsonl"), [
      { uuid: "a", parentUuid: null, type: "user", timestamp: new Date(100).toISOString(), message: { role: "user", content: "First" } },
      { uuid: "b", parentUuid: "a", type: "assistant", timestamp: new Date(200).toISOString(), message: { role: "assistant", content: "Second" } },
    ].map(row => JSON.stringify({ ...row, sessionId: "session-1", cwd: options.session.cwd })).join("\n"));
    await options.eventLog.append({ sessionId: "session-1", itemId: "a", timestamp: 300, type: "user.message.accepted", origin: "mobile", data: { text: "First accepted" } });
    const first = await readSessionHistory(options, undefined, 1);
    expect(first.items.map(item => item.id)).toEqual(["b"]);
    const second = await readSessionHistory(options, first.nextCursor, 1);
    expect(second.items).toMatchObject([{ id: "a", text: "First accepted", createdAt: 100 }]);
    expect(second.hasMore).toBe(false);
    await options.eventLog.close();
  });

  it("uses the cursor's code-unit ordering for mixed-case timestamp ties", async () => {
    const options = await fixture();
    for (const id of ["a", "B"]) {
      await options.eventLog.append({ sessionId: "session-1", itemId: id, timestamp: 1, type: "assistant.completed", origin: "claude-host", data: { text: id } });
    }
    const first = await readSessionHistory(options, undefined, 1);
    const second = await readSessionHistory(options, first.nextCursor, 1);
    expect([...second.items, ...first.items].map(item => item.id)).toEqual(["B", "a"]);
    await options.eventLog.close();
  });

  it("paginates native timestamp ties with the same ordering as merged history", async () => {
    const options = await fixture();
    await writeFile(join(options.paths.projects, "session-1.jsonl"), [
      { uuid: "a", parentUuid: null, type: "user", message: { role: "user", content: "First" } },
      { uuid: "B", parentUuid: "a", type: "assistant", message: { role: "assistant", content: "Second" } },
    ].map(row => JSON.stringify({ ...row, timestamp: new Date(1).toISOString(), sessionId: "session-1", cwd: options.session.cwd })).join("\n"));
    const first = await readSessionHistory(options, undefined, 1);
    const second = await readSessionHistory(options, first.nextCursor, 1);
    expect([...second.items, ...first.items].map(item => item.id)).toEqual(["B", "a"]);
    await options.eventLog.close();
  });

  it("paginates event-only items older than the source's 10,000-item page", async () => {
    const options = await fixture();
    const rows = Array.from({ length: 10_001 }, (_, index) => ({
      eventId: `e${index}`, seq: index + 1, sessionId: "session-1", itemId: `item${index}`,
      timestamp: index + 1, type: "assistant.completed", origin: "claude-host", data: { text: `Message ${index}` },
    }));
    await writeFile(options.eventLog.path, rows.map(row => JSON.stringify(row)).join("\n"));
    await options.eventLog.initialize();
    const page = await readSessionHistory(options, Buffer.from(JSON.stringify({ at: 2, id: "item1" })).toString("base64url"), 1);
    expect(page.items.map(item => item.id)).toEqual(["item0"]);
    expect(page.hasMore).toBe(false);
    await options.eventLog.close();
  });

  it("preserves full transcript paging around oversized messages and older clipped event copies", async () => {
    const options = await fixture();
    const text = `开头\n${"完整中段".repeat(30_000)}\n结尾`;
    const rows = [
      { id: "u1", role: "user", text: "Earlier question" },
      { id: "a1", role: "assistant", text },
      { id: "u2", role: "user", text: "Latest question" },
      { id: "a2", role: "assistant", text: "Latest answer" },
    ];
    await writeFile(join(options.paths.projects, "session-1.jsonl"), rows.map((row, index) => JSON.stringify({
      uuid: row.id, parentUuid: rows[index - 1]?.id ?? null, type: row.role, sessionId: "session-1", cwd: options.session.cwd,
      timestamp: new Date(1_000 + index * 1_000).toISOString(), message: { role: row.role, content: row.text },
    })).join("\n"));
    for (const [index, row] of rows.entries()) {
      await options.eventLog.append({ sessionId: "session-1", itemId: row.id, timestamp: 1_000 + index * 1_000, origin: "claude-desktop", type: "session.observed", data: { role: row.role, text: row.id === "a1" ? "Clipped answer" : row.text } });
    }
    const first = await readSessionHistory(options);
    expect(first.items.map((item) => item.id)).toEqual(["u2", "a2"]);
    expect(first.hasMore).toBe(true);
    expect(JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString("utf8"))).toEqual({ at: 3_000, id: "u2" });
    const second = await readSessionHistory(options, first.nextCursor);
    expect(second.items.map((item) => item.id)).toEqual(["a1"]);
    expect(second.items[0]?.text).toBe(text);
    expect(second.items[0]?.origin).toBe("claude-host");
    const third = await readSessionHistory(options, second.nextCursor);
    expect(third.items.map((item) => item.id)).toEqual(["u1"]);
    expect(third.hasMore).toBe(false);
    await options.eventLog.close();
  });

  it("merges native aliases and lane origins while SDK task state remains authoritative", async () => {
    const options = await fixture();
    const taskState = new SessionTaskState();
    taskState.beginGeneration("session-1", "host-1");
    taskState.update("session-1", "host-1", { taskId: "sdk-task", toolUseId: "tool-1", description: "Current work", state: "running", startedAt: 20, updatedAt: 50 });
    options.taskState = taskState;
    options.route = { lanes: [lane("official", "claude-official"), lane("third-party", "claude-3p"), lane(undefined, "claude-3p")] };
    options.activeTurn = true;
    options.observedSessions = [{ sessionId: "official", activeProcesses: [{ startedAt: 100, processAlive: true, entrypoint: "desktop", source: "registration" }] }];
    const interactivePrompt: BridgeInteractivePrompt = { kind: "question", questions: [] };
    const readHistory = vi.spyOn(history, "readClaudeSessionHistory").mockImplementation(async (_root, nativeSessionId) => ({
      messages: nativeSessionId === "official" ? [
        { id: "official-answer", role: "assistant", text: "Full official answer", createdAt: 10, interactivePrompt },
      ] : [{ id: "host-answer", role: "assistant", text: "Native host answer", createdAt: 30 }], available: true, truncated: false,
    }));
    const observedTask: BridgeSubagentSummary = { agentId: "transcript-task", toolUseId: "tool-1", description: "Transcript work", state: "completed", toolCount: 4, startedAt: 20, updatedAt: 200, reportText: "Full transcript report" };
    const readTasks = vi.spyOn(history, "readClaudeSessionSubagents").mockImplementation(async (_root, nativeSessionId) => nativeSessionId === "official" ? [observedTask] : []);
    await options.eventLog.append({ sessionId: "official", itemId: "official-answer", timestamp: 10, type: "session.observed", origin: "claude-desktop", data: { role: "assistant", text: "Clipped official answer" } });
    await options.eventLog.append({ sessionId: "third-party", itemId: "host-answer", timestamp: 30, type: "assistant.completed", origin: "claude-host", data: { text: "Host event answer" } });
    await options.eventLog.append({ sessionId: "session-1", itemId: "tool-1", timestamp: 20, type: "tool.completed", origin: "claude-desktop", data: { toolName: "Agent", subagent: observedTask } });
    const page = await readSessionHistory(options);
    expect(page.items).toMatchObject([
      { id: "official-answer", sessionId: "session-1", origin: "claude-desktop", text: "Full official answer", interactivePrompt },
      { id: "tool-1", sessionId: "session-1", state: "running", subagent: { agentId: "sdk-task", state: "running", reportText: "Full transcript report" } },
      { id: "host-answer", sessionId: "session-1", origin: "claude-host", text: "Host event answer" },
    ]);
    expect(readHistory).toHaveBeenCalledTimes(2);
    expect(readTasks.mock.calls.map((call) => call[3])).toEqual([0, 0]);
    await options.eventLog.close();
  });

  it("keeps timestamp ties, tool-exempt page counts, invalid cursors, and process-start filtering", async () => {
    const options = await fixture();
    const readHistory = vi.spyOn(history, "readClaudeSessionHistory").mockResolvedValue({ messages: [], available: true, truncated: false });
    const readTasks = vi.spyOn(history, "readClaudeSessionSubagents").mockResolvedValue([]);
    options.observedSessions = [{ sessionId: "session-1", activeProcesses: [
      { startedAt: 100, processAlive: false, entrypoint: "desktop", source: "registration" },
      { startedAt: 200, processAlive: true, entrypoint: "desktop", source: "registration" },
    ] }];
    await options.eventLog.append({ sessionId: "session-1", itemId: "a", timestamp: 1, type: "user.message.accepted", origin: "mobile", data: { text: "First" } });
    await options.eventLog.append({ sessionId: "session-1", itemId: "b", timestamp: 1, type: "assistant.completed", origin: "claude-host", data: { text: "Second" } });
    await options.eventLog.append({ sessionId: "session-1", itemId: "c", timestamp: 1, type: "tool.started", origin: "claude-host", data: { toolName: "Read" } });
    const first = await readSessionHistory(options, "invalid-cursor", 1);
    expect(first.items.map((item) => item.id)).toEqual(["b", "c"]);
    expect(first.hasMore).toBe(true);
    expect(readTasks).toHaveBeenCalledWith(options.paths.projects, "session-1", options.session.cwd, 200);
    const second = await readSessionHistory(options, first.nextCursor, 1);
    expect(second.items.map((item) => item.id)).toEqual(["a"]);
    expect(second.hasMore).toBe(false);
    expect(readHistory).toHaveBeenLastCalledWith(options.paths.projects, "session-1", options.session.cwd, { limit: 3, chronological: true, before: { createdAt: 1, id: "b" } });
    await options.eventLog.close();
  });

  it("merges an initial task-ID snapshot and a later tool-use-ID event into one canonical card", async () => {
    const options = await fixture();
    vi.spyOn(history, "readClaudeSessionHistory").mockResolvedValue({ messages: [], available: true, truncated: false });
    vi.spyOn(history, "readClaudeSessionSubagents").mockResolvedValue([]);
    const state = new SessionTaskState();
    options.taskState = state;
    state.beginGeneration("session-1", "host-1");
    const task = { taskId: "task-1", description: "Background work", state: "running" as const, startedAt: 10, updatedAt: 20 };
    const [snapshot] = state.replace("session-1", "host-1", [task], 20);
    await options.eventLog.append({ sessionId: "session-1", itemId: "subagent:task-1", timestamp: 10, type: "tool.progress", origin: "claude-host", data: { task, generation: "host-1", subagent: snapshot } });
    const richerTask = { ...task, toolUseId: "tool-1", updatedAt: 30 };
    const started = state.update("session-1", "host-1", richerTask);
    await options.eventLog.append({ sessionId: "session-1", itemId: "tool-1", timestamp: 10, type: "tool.progress", origin: "claude-host", data: { task: richerTask, generation: "host-1", subagent: started } });
    const page = await readSessionHistory(options);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ id: "tool-1", state: "running", subagent: { agentId: "task-1", toolUseId: "tool-1", state: "running" } });
    await options.eventLog.close();
  });

  it("removes stale event state when the task projector reports unknown membership", async () => {
    const options = await fixture();
    vi.spyOn(history, "readClaudeSessionHistory").mockResolvedValue({ messages: [], available: true, truncated: false });
    vi.spyOn(history, "readClaudeSessionSubagents").mockResolvedValue([]);
    await options.eventLog.append({ sessionId: "session-1", itemId: "tool-1", timestamp: 1, type: "tool.progress", origin: "claude-host", data: { toolName: "Agent", subagent: { agentId: "task-1", toolUseId: "tool-1", description: "Old task", state: "running", toolCount: 1, startedAt: 1, updatedAt: 2 } } });
    const page = await readSessionHistory(options);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.subagent?.state).toBe("unknown");
    expect(page.items[0]).not.toHaveProperty("state");
    await options.eventLog.close();
  });

  it("uses the strictest transcript cursor boundary across lanes and retains prompt metadata on host overrides", async () => {
    const options = await fixture();
    options.route = { lanes: [lane("official", "claude-official"), lane("third-party", "claude-3p")] };
    const interactivePrompt: BridgeInteractivePrompt = { kind: "question", questions: [] };
    vi.spyOn(history, "readClaudeSessionHistory").mockImplementation(async (_root, nativeSessionId) => ({
      messages: nativeSessionId === "official" ? [{ id: "b", role: "assistant", text: "Official", createdAt: 20 }] : [{ id: "c", role: "assistant", text: "Native", createdAt: 30, interactivePrompt }],
      available: true, truncated: false, nextCursor: nativeSessionId === "official" ? "b" : "c",
    }));
    vi.spyOn(history, "readClaudeSessionSubagents").mockResolvedValue([]);
    await options.eventLog.append({ sessionId: "session-1", itemId: "a", timestamp: 10, type: "user.message.accepted", origin: "mobile", data: { text: "Old copy" } });
    await options.eventLog.append({ sessionId: "session-1", itemId: "c", timestamp: 30, type: "assistant.completed", origin: "claude-host", data: { text: "Host override" } });
    const page = await readSessionHistory(options);
    expect(page.items).toMatchObject([{ id: "c", text: "Host override", interactivePrompt }]);
    expect(page.hasMore).toBe(true);
    expect(JSON.parse(Buffer.from(page.nextCursor!, "base64url").toString("utf8"))).toEqual({ at: 30, id: "c" });
    await options.eventLog.close();
  });
});
