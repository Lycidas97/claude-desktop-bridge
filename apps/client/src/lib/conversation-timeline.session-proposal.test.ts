import type { BridgeEvent, BridgeHistoryItem } from "@bridge/protocol";
import { describe, expect, it } from "vitest";
import { conversationItems, conversationTimeline, groupTimelineTools } from "./conversation-timeline.js";

const proposal = { title: "#457 fork 日历告警", background: "在隔离夹具检查旧版日历告警。" };
const call: BridgeHistoryItem = { sessionId: "session", id: "call", role: "tool", origin: "claude-desktop",
  toolName: "mcp__ccd_session__start_session", text: "原始摘要", createdAt: 10, sessionProposal: proposal };
const receipt: BridgeHistoryItem = { sessionId: "session", id: "call:completed", role: "tool", origin: "claude-desktop",
  text: "", createdAt: 20, sessionProposalResultFor: "call" };
const started: BridgeEvent = { eventId: "start", sessionId: "session", itemId: "call", seq: 1, timestamp: 10,
  origin: "claude-desktop", type: "tool.started", data: { toolName: call.toolName, text: call.text, sessionProposal: proposal } };
const completed: BridgeEvent = { ...started, eventId: "complete", seq: 2, timestamp: 20, type: "tool.completed",
  data: { toolName: call.toolName, text: call.text, sessionProposalResult: true } };

function visible(history: BridgeHistoryItem[], events: BridgeEvent[] = [], hasMore = false) {
  return groupTimelineTools(conversationTimeline(conversationItems("session", {
    status: "ready", items: history, hasMore,
  }, events, [], true), []));
}

describe("native session proposals on the timeline", () => {
  it("only shows a card once the older page supplies the matching call, in the original position", () => {
    const later: BridgeHistoryItem = { sessionId: "session", id: "reply", role: "assistant", origin: "claude-desktop", text: "已发出提案", createdAt: 21 };
    expect(visible([receipt, later], [], true)).toEqual([{ kind: "message", item: later }]);
    expect(visible([call, receipt, later], [], true)).toEqual([
      { kind: "message", item: { ...call, id: "tool:call", toolUseId: "call", state: "completed", sessionProposalConfirmed: true } },
      { kind: "message", item: later },
    ]);
  });

  it("upgrades the running tool in place and merges history and live replay without duplication", () => {
    expect(visible([], [started])).toMatchObject([{ kind: "tool-group", tools: [{ id: "tool:call", state: "running" }] }]);
    const card = { kind: "message", item: { ...call, id: "tool:call", toolUseId: "call", state: "completed", sessionProposalConfirmed: true } };
    expect(visible([], [started, completed])).toEqual([card]);
    expect(visible([call, receipt], [started, completed])).toEqual([card]);
    expect(visible([call, receipt], [started])).toEqual([card]);
    expect(visible([], [{ ...completed, data: { ...completed.data, sessionProposal: proposal } }])).toMatchObject([
      { kind: "message", item: { id: "tool:call", sessionProposal: proposal, sessionProposalConfirmed: true } },
    ]);
  });

  it("does not upgrade unrelated calls, unconfirmed calls or errors", () => {
    const other = { ...call, id: "other" };
    const start: BridgeHistoryItem = { sessionId: "session", id: "call", role: "tool", origin: "claude-desktop",
      toolName: call.toolName!, text: "普通启动", createdAt: 10 };
    const error = { ...completed, data: { toolName: call.toolName, isError: true } };
    expect(visible([other, receipt])).toMatchObject([{ kind: "tool-group", tools: [{ id: "tool:other" }] }]);
    expect(visible([start, receipt])).toMatchObject([{ kind: "tool-group", tools: [{ id: "tool:call" }] }]);
    expect(visible([call, { ...receipt, sessionId: "other" }])).toMatchObject([{ kind: "tool-group", tools: [{ id: "tool:call" }] }]);
    expect(visible([call], [error])).toMatchObject([{ kind: "tool-group", tools: [{ id: "tool:call", isError: true }] }]);
  });
});
