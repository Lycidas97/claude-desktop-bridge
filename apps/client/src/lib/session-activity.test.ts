import { describe, expect, it } from "vitest";
import { backgroundSubagentBadge, formatElapsed, sessionActivity, sessionQueueLabel, subagentStalledSeconds } from "./session-activity.js";

describe("sessionActivity", () => {
  it("disappears when the session is idle or waiting", () => {
    expect(sessionActivity({ turnState: "idle" }, [])).toBeUndefined();
    expect(sessionActivity({ turnState: "waiting" }, [])).toBeUndefined();
    expect(sessionActivity(undefined, [])).toBeUndefined();
  });

  it("keeps the queue reason visible ahead of background subagents", () => {
    expect(sessionActivity({ turnState: "queued", ownership: "DESKTOP_OBSERVED", pendingCount: 1 }, [{
      role: "tool", createdAt: 1, subagent: { agentId: "old", state: "running", description: "后台任务", toolCount: 1, startedAt: 1, updatedAt: 2 },
    }])).toEqual({ kind: "queued", label: "等待电脑端空闲" });
    expect(sessionActivity({ turnState: "running", ownership: "BRIDGE_RUNNING", pendingCount: 1 }, []))
      .toEqual({ kind: "queued", label: "等待前一条消息完成" });
  });

  it("requires closing the Desktop session instead of waiting idle when explicit handoff is present", () => {
    const session = { turnState: "queued", ownership: "DESKTOP_OBSERVED", pendingCount: 1,
      desktopHandoff: { state: "close-desktop", canReturn: false },
    } as const;
    expect(sessionQueueLabel(session)).toBe("等待关闭此 Desktop 会话");
    expect(sessionActivity(session, [])).toEqual({ kind: "queued", label: "等待关闭此 Desktop 会话" });
  });

  it("reports queued sessions without a timer", () => {
    expect(sessionActivity({ turnState: "queued" }, [])).toEqual({ kind: "queued", label: "排队等待中" });
  });

  it.each([
    ["starting", "正在启动"],
    ["submitted", "已提交，等待执行"],
  ] as const)("shows %s before actual execution instead of stale tool activity or thinking", (executionStage, label) => {
    expect(sessionActivity({ turnState: "running", executionStage }, [{ role: "user", createdAt: 100 }]))
      .toEqual({ kind: "queued", label });
    expect(sessionActivity({ turnState: "running", executionStage }, [{ role: "tool", toolName: "Read", state: "running", createdAt: 50 }]))
      .toEqual({ kind: "queued", label });
  });

  it("shows actual execution after the running acknowledgment", () => {
    expect(sessionActivity({ turnState: "running", executionStage: "running" }, [{ role: "user", createdAt: 100 }]))
      .toEqual({ kind: "thinking", label: "思考中", since: 100 });
  });

  it("names the in-flight tool while one is running", () => {
    const activity = sessionActivity({ turnState: "running" }, [
      { role: "user", createdAt: 100 },
      { role: "tool", toolName: "Command", state: "running", createdAt: 200 },
    ]);
    expect(activity).toEqual({ kind: "running", label: "正在运行 · Command", since: 100 });
  });

  it("falls back to 思考中 once the last tool settled and nothing streams", () => {
    const activity = sessionActivity({ turnState: "running" }, [
      { role: "user", createdAt: 100 },
      { role: "tool", toolName: "Command", state: "completed", createdAt: 200 },
    ]);
    expect(activity?.kind).toBe("thinking");
  });

  it("reports 正在生成回复 while assistant text is the latest activity", () => {
    const activity = sessionActivity({ turnState: "running" }, [
      { role: "user", createdAt: 100 },
      { role: "assistant", createdAt: 300 },
    ]);
    expect(activity).toEqual({ kind: "generating", label: "正在生成回复", since: 100 });
  });

  it("times the current work from the latest user message, including steers", () => {
    const activity = sessionActivity({ turnState: "running" }, [
      { role: "user", createdAt: 100 },
      { role: "assistant", createdAt: 200 },
      { role: "user", createdAt: 400 },
    ]);
    expect(activity?.since).toBe(400);
  });

  it("surfaces running subagents in the composer activity line even after an assistant message", () => {
    const activity = sessionActivity({ turnState: "idle" }, [
      { role: "user", createdAt: 100 },
      {
        role: "tool",
        toolName: "Agent",
        state: "running",
        createdAt: 150,
        subagent: {
          agentId: "a1",
          description: "Audit chapter 3 citations",
          state: "running",
          toolCount: 4,
          startedAt: 150,
          updatedAt: 180,
        },
      },
      { role: "assistant", createdAt: 200 },
    ]);
    expect(activity).toEqual({
      kind: "running",
      label: "子代理运行中 · Audit chapter 3 citations (4 步)",
      since: 100,
    });
  });
});

describe("formatElapsed", () => {
  it("formats seconds, minutes and hours", () => {
    expect(formatElapsed(0)).toBe("0 秒");
    expect(formatElapsed(59)).toBe("59 秒");
    expect(formatElapsed(60)).toBe("1 分钟");
    expect(formatElapsed(75)).toBe("1 分 15 秒");
    expect(formatElapsed(3600)).toBe("1 小时 0 分");
    expect(formatElapsed(3725)).toBe("1 小时 2 分");
  });
});

describe("background subagent badge", () => {
  const now = 1_000_000_000;

  it("stays hidden with no running subagents", () => {
    expect(backgroundSubagentBadge({}, now)).toBeUndefined();
  });

  it("only mentions a stall after ten quiet minutes", () => {
    const session = (quietMs: number) => ({ runningSubagents: { count: 1, lastUpdatedAt: now - quietMs } });
    expect(backgroundSubagentBadge(session(10 * 60_000), now)).toEqual({ label: "后台子代理", stalled: false });
    expect(backgroundSubagentBadge(session(10 * 60_000 + 1), now)).toEqual({ label: "子代理无进展", stalled: true });
  });

  it("reports how long a subagent has been quiet", () => {
    expect(subagentStalledSeconds(now - 60_000, now)).toBeUndefined();
    expect(subagentStalledSeconds(now - 7 * 3_600_000, now)).toBe(7 * 3_600);
  });
});
