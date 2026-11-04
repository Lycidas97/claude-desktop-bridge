import type { BridgeEvent, BridgeSubagentSummary } from "@bridge/protocol";
import { describe, expect, it } from "vitest";
import type { SessionHostBackgroundTask } from "./claude-session-host.js";
import { SessionTaskState } from "./session-task-state.js";

const task: SessionHostBackgroundTask = {
  taskId: "task-1", toolUseId: "tool-1", description: "Inspect", state: "running", startedAt: 100, updatedAt: 200, isBackgrounded: true,
};
const observed: BridgeSubagentSummary = {
  agentId: "transcript-agent", toolUseId: "tool-1", description: "Inspect", state: "stopped", toolCount: 5,
  recentTools: ["Read file.ts"], startedAt: 100, updatedAt: 250,
};

function saved(taskValue: SessionHostBackgroundTask, seq: number, generation = "old-process"): BridgeEvent {
  return {
    eventId: `event-${seq}`, sessionId: "session", itemId: taskValue.toolUseId ?? `subagent:${taskValue.taskId}`,
    seq, timestamp: taskValue.updatedAt, origin: "claude-host", type: taskValue.state === "running" ? "tool.progress" : "tool.completed",
    data: { task: taskValue, generation },
  };
}

describe("SessionTaskState", () => {
  it("preserves reused task IDs as separate tool invocations without carrying old output", () => {
    const state = new SessionTaskState();
    state.beginGeneration("session", "process-1");
    state.update("session", "process-1", { ...task, state: "completed", summary: "Old report", completedAt: 250, usage: { totalTokens: 10, toolUses: 8, durationMs: 150 } });
    const next = state.update("session", "process-1", { ...task, toolUseId: "tool-2", description: "Next run", startedAt: 300, updatedAt: 350 });
    expect(next).not.toHaveProperty("reportText");
    expect(next).not.toHaveProperty("durationMs");
    expect(next?.toolCount).toBe(0);
    expect(state.historyItems("session")).toMatchObject([
      { id: "tool-1", subagent: { state: "completed", reportText: "Old report" } },
      { id: "tool-2", subagent: { state: "running", description: "Next run" } },
    ]);
    expect(state.task("session", task.taskId)?.toolUseId).toBe("tool-2");
    expect(state.task("session", "tool-1")?.state).toBe("completed");
    expect(state.isRunning("session", "tool-1")).toBe(false);
    expect(state.isRunning("session", "tool-2")).toBe(true);
  });

  it("keeps a completed invocation when a reused task first reappears without its new tool ID", () => {
    const state = new SessionTaskState();
    state.beginGeneration("session", "process-1");
    state.update("session", "process-1", { ...task, state: "completed", completedAt: 250, summary: "Old report" });
    const { toolUseId: _tool, ...next } = task;
    state.replace("session", "process-1", [{ ...next, startedAt: 300, updatedAt: 300 }], 300);
    state.update("session", "process-1", { ...next, toolUseId: "tool-2", startedAt: 300, updatedAt: 350 });
    expect(state.historyItems("session").map((item) => [item.id, item.subagent?.state, item.subagent?.reportText]))
      .toEqual([["tool-1", "completed", "Old report"], ["tool-2", "running", undefined]]);
  });

  it.each([undefined, false])("keeps explicit running task facts outside the background set (%s)", (isBackgrounded) => {
    const state = new SessionTaskState();
    state.beginGeneration("session", "process-1");
    state.replace("session", "process-1", [], 100);
    const { isBackgrounded: _background, ...foreground } = task;
    state.update("session", "process-1", { ...foreground, ...(isBackgrounded === false ? { isBackgrounded } : {}) });
    expect(state.runningSubagents("session")?.count).toBe(1);
    expect(state.historyItems("session")).toMatchObject([{ subagent: { state: "running" } }]);
    state.replace("session", "process-1", [], 300);
    expect(state.runningSubagents("session")?.count).toBe(1);
    expect(state.historyItems("session")).toMatchObject([{ subagent: { state: "running" } }]);
  });

  it("downgrades old unmatched transcript running state once a new host snapshot has authority", () => {
    const state = new SessionTaskState();
    state.beginGeneration("session", "process-2");
    state.replace("session", "process-2", [], 500);
    const { isBackgrounded: _background, ...foreground } = task;
    state.update("session", "process-2", { ...foreground, taskId: "current", toolUseId: "current-tool", startedAt: 550, updatedAt: 600 });
    const summaries = state.mergeSubagents("session", [{ ...observed, agentId: "old", state: "running" }]);
    expect(summaries).toMatchObject([{ agentId: "old", state: "unknown", updatedAt: 500 }, { agentId: "current", state: "running" }]);
    expect(state.runningSubagents("session")?.count).toBe(1);
  });

  it("tracks skip-transcript ambient tasks without rendering inline history", () => {
    const state = new SessionTaskState();
    state.beginGeneration("session", "process-1");
    state.update("session", "process-1", { ...task, skipTranscript: true });
    expect(state.runningSubagents("session")?.count).toBe(1);
    expect(state.isInline("session", "tool-1")).toBe(false);
    expect(state.historyItems("session", [observed])).toEqual([]);
    const restored = new SessionTaskState();
    restored.restore("session", [saved({ ...task, skipTranscript: true }, 1)]);
    expect(restored.historyItems("session", [observed])).toEqual([]);
  });

  it("uses full host snapshots for membership, retaining absent tasks without inventing terminal state", () => {
    const state = new SessionTaskState();
    state.beginGeneration("session", "process-1");
    expect(state.hasAuthority("session")).toBe(false);
    state.update("session", "process-1", task);
    expect(state.hasAuthority("session")).toBe(true);
    expect(state.runningSubagents("session")).toEqual({ count: 1, lastUpdatedAt: 200 });
    expect(state.replace("session", "process-1", [], 300)).toMatchObject([{ state: "unknown", updatedAt: 300 }]);
    expect(state.historyItems("session")).toMatchObject([{ subagent: { state: "unknown" } }]);
    expect(state.historyItems("session")[0]?.state).toBeUndefined();
    expect(state.runningSubagents("session")).toBeUndefined();
    expect(state.task("session", "task-1")?.state).toBe("running");
    state.update("session", "process-1", { ...task, updatedAt: 400 });
    expect(state.runningSubagents("session"), "progress does not replace full membership").toBeUndefined();
    expect(state.mergeSubagents("session", [])).toMatchObject([{ state: "unknown" }]);
    state.replace("session", "process-1", [{ ...task, state: "paused", updatedAt: 500 }], 500);
    expect(state.runningSubagents("session")).toEqual({ count: 1, lastUpdatedAt: 500 });
    state.replace("session", "process-1", [], 450);
    expect(state.runningSubagents("session")?.count).toBe(1);
  });

  it.each([false, true])("restores unowned running tasks as unknown and preserves a saved unknown observation (%s)", (savedUnknown) => {
    const state = new SessionTaskState();
    const event = saved(task, 1);
    if (savedUnknown) event.data.subagent = { ...observed, agentId: task.taskId, state: "unknown", updatedAt: 300 };
    state.restore("session", [event]);
    expect(state.historyItems("session")).toMatchObject([{ subagent: { state: "unknown", updatedAt: savedUnknown ? 300 : 200 } }]);
    expect(state.historyItems("session")[0]?.state).toBeUndefined();
    expect(state.runningSubagents("session")).toBeUndefined();
    expect(state.task("session", task.taskId)).toBeUndefined();
  });

  it("leaves absent tasks unknown after process exit and resolves later observed terminal evidence", () => {
    const state = new SessionTaskState();
    state.beginGeneration("session", "process-1");
    state.update("session", "process-1", task);
    state.replace("session", "process-1", [], 300);
    expect(state.endGeneration("session", "process-1", 400)).toEqual([]);
    expect(state.historyItems("session")).toMatchObject([{ subagent: { state: "unknown" } }]);
    expect(state.mergeSubagents("session", [{ ...observed, state: "completed", updatedAt: 500 }])).toMatchObject([{ state: "completed" }]);
    expect(state.mergeSubagents("session", [{ ...observed, state: "running", updatedAt: 600 }])).toMatchObject([{ state: "running" }]);
  });

  it("resolves unknown state from an actual SDK terminal notification", () => {
    const state = new SessionTaskState();
    state.beginGeneration("session", "process-1");
    state.update("session", "process-1", task);
    state.replace("session", "process-1", [], 300);
    expect(state.update("session", "process-1", { ...task, state: "completed", updatedAt: 400 })).toMatchObject({ state: "completed" });
    expect(state.historyItems("session")).toMatchObject([{ state: "completed", subagent: { state: "completed" } }]);
  });

  it("restores running state when a later snapshot re-adds unchanged task metadata", () => {
    const state = new SessionTaskState();
    state.beginGeneration("session", "process-1");
    state.replace("session", "process-1", [task], 200);
    state.replace("session", "process-1", [], 300);
    expect(state.replace("session", "process-1", [task], 400)).toMatchObject([{ state: "running", updatedAt: 400 }]);
    expect(state.isRunning("session", task.taskId)).toBe(true);
    expect(state.historyItems("session")).toMatchObject([{ subagent: { state: "running", updatedAt: 400 } }]);
    state.beginGeneration("session", "process-2");
    expect(state.isRunning("session", task.taskId)).toBe(false);
    expect(state.historyItems("session")).toMatchObject([{ subagent: { state: "unknown" } }]);
  });

  it("keeps SDK state authoritative while merging transcript metadata and task aliases once", () => {
    const state = new SessionTaskState();
    state.beginGeneration("session", "process-1");
    state.update("session", "process-1", { ...task, subagentType: "Explore", usage: { totalTokens: 30, toolUses: 2, durationMs: 100 } });
    expect(state.mergeSubagents("session", [observed, { ...observed, agentId: "task-1" }])).toEqual([expect.objectContaining({
      agentId: "task-1", toolUseId: "tool-1", agentType: "Explore", state: "running", toolCount: 5, recentTools: ["Read file.ts"], updatedAt: 200,
    })]);
    expect(state.task("session", "tool-1")?.taskId).toBe("task-1");
    expect(state.historyItems("session", [observed])).toEqual([expect.objectContaining({
      id: "tool-1", sessionId: "session", origin: "claude-host", state: "running", subagent: expect.objectContaining({ agentId: "task-1", state: "running" }),
    })]);
  });

  it("keeps complete transcript reports and details when SDK notifications contain only a summary", () => {
    const state = new SessionTaskState();
    state.beginGeneration("session", "process-1");
    state.update("session", "process-1", { ...task, state: "completed", summary: "Checked", updatedAt: 300 });
    const reportText = "Checked\n\nFull evidence and references.";
    expect(state.mergeSubagents("session", [
      { ...observed, state: "completed", reportText },
      { ...observed, agentId: "task-1", recentTools: [], latestText: "Final checks" },
    ])).toMatchObject([{ state: "completed", reportText, recentTools: ["Read file.ts"], latestText: "Final checks" }]);
  });

  it("preserves external transcript origins when restoring legacy summaries", () => {
    const state = new SessionTaskState();
    state.restore("session", [{ ...saved(task, 1), origin: "claude-desktop", data: { subagent: observed } }]);
    expect(state.historyItems("session")).toMatchObject([{ origin: "claude-desktop" }]);
  });

  it("restores metadata without restoring process authority and accepts a resumed task after an old stop", () => {
    const state = new SessionTaskState();
    state.restore("session", [saved({ ...task, state: "stopped", updatedAt: 300 }, 2)]);
    expect(state.hasAuthority("session")).toBe(false);
    expect(state.runningSubagents("session")).toBeUndefined();
    expect(state.task("session", "task-1")).toBeUndefined();
    expect(state.mergeSubagents("session", [])).toMatchObject([{ state: "stopped" }]);
    state.beginGeneration("session", "process-2");
    expect(state.update("session", "old-process", { ...task, updatedAt: 600 })).toBeUndefined();
    state.update("session", "process-2", { ...task, updatedAt: 400 });
    expect(state.runningSubagents("session")).toEqual({ count: 1, lastUpdatedAt: 400 });
    expect(state.mergeSubagents("session", [observed])).toMatchObject([{ state: "running", agentId: "task-1" }]);
    expect(state.update("session", "process-2", { ...task, state: "stopped", updatedAt: 350 })).toBeUndefined();
  });

  it("settles tasks only on confirmed process end and rejects later events from that process", () => {
    const state = new SessionTaskState();
    state.beginGeneration("session", "process-1");
    state.update("session", "process-1", task);
    expect(state.endGeneration("session", "other-process", 300)).toEqual([]);
    expect(state.endGeneration("session", "process-1", 300)).toMatchObject([{ state: "stopped", updatedAt: 300 }]);
    expect(state.runningSubagents("session")).toBeUndefined();
    expect(state.task("session", "task-1")).toMatchObject({ state: "stopped", completedAt: 300 });
    expect(state.update("session", "process-1", { ...task, updatedAt: 400 })).toBeUndefined();
    expect(state.hasAuthority("session"), "an ended SDK process cannot own later external task state").toBe(false);
    expect(state.mergeSubagents("session", [{ ...observed, state: "running", updatedAt: 450 }])).toMatchObject([{ state: "running", updatedAt: 450 }]);
    state.beginGeneration("session", "process-2");
    state.update("session", "process-2", { ...task, updatedAt: 500 });
    expect(state.mergeSubagents("session", [])).toMatchObject([{ state: "running", updatedAt: 500 }]);
  });

  it("restores legacy subagent summaries using latest observation and never makes them stop targets", () => {
    const state = new SessionTaskState();
    const legacy = saved(task, 1);
    legacy.data = { subagent: observed };
    state.restore("session", [legacy]);
    expect(state.task("session", observed.agentId)).toBeUndefined();
    expect(state.mergeSubagents("session", [{ ...observed, state: "running", updatedAt: 300 }])).toMatchObject([{ state: "running", updatedAt: 300 }]);
    state.restore("session", [saved({ ...task, state: "failed", summary: "Failed check", error: "Unavailable", updatedAt: 400 }, 2)]);
    expect(state.mergeSubagents("session", [observed])).toMatchObject([{ state: "failed", reportText: "Failed check", updatedAt: 400 }]);
  });
});
