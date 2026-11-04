import type { BridgeEvent, BridgeHistoryItem, BridgeSubagentSummary } from "@bridge/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as history from "./claude-history.js";
import { readSessionHistory } from "./session-history.js";
import { SessionTaskState } from "./session-task-state.js";
import type { SessionHostBackgroundTask } from "./claude-session-host.js";

afterEach(() => vi.restoreAllMocks());

const task: SessionHostBackgroundTask = {
  taskId: "reused", toolUseId: "tool-1", description: "Check", state: "completed", startedAt: 100, updatedAt: 200,
};

async function read(tasks: SessionTaskState, events: BridgeEvent[], observed: BridgeSubagentSummary[] = []) {
  vi.spyOn(history, "readClaudeSessionHistory").mockResolvedValue({ available: true, truncated: false, messages: [] });
  vi.spyOn(history, "readClaudeSessionSubagents").mockResolvedValue(observed);
  return readSessionHistory({
    paths: { projects: "/fixture/projects" }, taskState: tasks,
    session: { sessionId: "session", cwd: "/fixture/project" }, activeTurn: false, observedSessions: [],
    eventLog: {
      latestTaskEvents: () => events,
      history: () => ({ sessionId: "session", hasMore: false, items: events.map((event): BridgeHistoryItem => ({
        id: event.itemId!, sessionId: "session", role: "tool", text: "Check", createdAt: event.timestamp, origin: "claude-host",
        state: "running", subagent: event.data.subagent as BridgeSubagentSummary,
      })) }),
    },
  });
}

function event(taskValue: SessionHostBackgroundTask, seq: number): BridgeEvent {
  return {
    eventId: `task-${seq}`, sessionId: "session", itemId: taskValue.toolUseId!, seq, timestamp: taskValue.startedAt,
    type: "tool.progress", origin: "claude-host", data: { task: taskValue, generation: "process-1", subagent: {
      agentId: taskValue.taskId, toolUseId: taskValue.toolUseId, description: taskValue.description,
      state: taskValue.state, toolCount: 0, startedAt: taskValue.startedAt, updatedAt: taskValue.updatedAt,
    } },
  };
}

describe("session history task boundaries", () => {
  it("preserves both invocations when the SDK reuses its task ID", async () => {
    const tasks = new SessionTaskState();
    const page = await read(tasks, [event(task, 1), event({ ...task, toolUseId: "tool-2", state: "running", startedAt: 300, updatedAt: 400 }, 2)]);
    expect(page.items.map((item) => item.id)).toEqual(["tool-1", "tool-2"]);
    expect(page.items.map((item) => item.subagent?.state)).toEqual(["completed", "unknown"]);
  });

  it("removes raw event cards for skip-transcript tasks", async () => {
    const page = await read(new SessionTaskState(), [event({ ...task, skipTranscript: true }, 1)]);
    expect(page.items).toEqual([]);
  });

  it("shows old-generation task history as unknown beside current explicit running work", async () => {
    const tasks = new SessionTaskState();
    tasks.beginGeneration("session", "process-2");
    tasks.replace("session", "process-2", [], 500);
    tasks.update("session", "process-2", { ...task, taskId: "current", toolUseId: "current-tool", state: "running", startedAt: 550, updatedAt: 600 });
    const page = await read(tasks, [event({ ...task, state: "running" }, 1)], [{
      agentId: task.taskId, toolUseId: task.toolUseId!, description: "Old", state: "running", toolCount: 1, startedAt: 100, updatedAt: 200,
    }]);
    expect(page.items.map((item) => [item.id, item.subagent?.state])).toEqual([["tool-1", "unknown"], ["current-tool", "running"]]);
    expect(page.items[0]?.state).toBeUndefined();
    expect(tasks.runningSubagents("session")?.count).toBe(1);
  });
});
