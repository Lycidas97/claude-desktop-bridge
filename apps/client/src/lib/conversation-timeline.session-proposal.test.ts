import type { BridgeEvent, BridgeHistoryItem } from "@bridge/protocol";
import { describe, expect, it } from "vitest";
import { projectHistoryPage, type SessionHistoryState } from "../hooks/bridge/bridge-reducers.js";
import { conversationItems, conversationTimeline, groupTimelineTools } from "./conversation-timeline.js";

const proposal = { title: "#457 fork 日历告警", background: "在隔离夹具检查旧版日历告警。" };
const call: BridgeHistoryItem = { sessionId: "session", id: "call", role: "tool", origin: "claude-desktop",
  toolName: "mcp__ccd_session__start_session", text: "原始摘要", createdAt: 10, sessionProposal: proposal };
const started: BridgeEvent = { eventId: "start", sessionId: "session", itemId: "call", seq: 1, timestamp: 10,
  origin: "claude-desktop", type: "tool.started", data: { toolName: call.toolName, text: call.text, sessionProposal: proposal } };
const completed: BridgeEvent = { ...started, eventId: "complete", seq: 2, timestamp: 20, type: "tool.completed",
  data: { toolName: call.toolName, text: call.text, sessionProposalResult: true } };
const card = { kind: "message", item: { ...call, id: "tool:call", toolUseId: "call", state: "completed", sessionProposalConfirmed: true } };

function visible(history: SessionHistoryState, events: BridgeEvent[] = []) {
  return groupTimelineTools(conversationTimeline(conversationItems("session", history, events, [], true), []));
}

describe("native session proposals on the timeline", () => {
  it.each([false, true])("keeps the card at the original call across pagination (with completion replay: %s)", replay => {
    const earlierReply: BridgeHistoryItem = { sessionId: "session", id: "earlier-reply", role: "assistant", origin: "claude-desktop", text: "等提案生成", createdAt: 19 };
    const laterReply: BridgeHistoryItem = { ...earlierReply, id: "later-reply", text: "已发出提案", createdAt: 21 };
    const latest = projectHistoryPage({ sessionId: "session", hasMore: true, nextCursor: earlierReply.id,
      items: [earlierReply, laterReply], sessionProposalResults: ["call"] });
    const events = replay ? [{ ...completed, data: { ...completed.data, sessionProposal: proposal } }] : [];
    const replies = [earlierReply, laterReply].map(item => ({ kind: "message", item }));
    expect(visible(latest, events)).toEqual(replies);
    const older = projectHistoryPage({ sessionId: "session", hasMore: false, items: [call] }, latest);
    expect(visible(older, events)).toEqual([card, ...replies]);
  });

  it("upgrades the running tool in place and merges history and live replay without duplication", () => {
    const empty: SessionHistoryState = { status: "ready", items: [], hasMore: false };
    const history: SessionHistoryState = { ...empty, items: [call], sessionProposalResults: ["call"] };
    expect(visible(empty, [started])).toMatchObject([{ kind: "tool-group", tools: [{ id: "tool:call", state: "running" }] }]);
    expect(visible(empty, [started, completed])).toEqual([card]);
    expect(visible(history, [started, completed])).toEqual([card]);
    expect(visible(history, [started])).toEqual([card]);
  });

  it("does not upgrade unrelated calls, unconfirmed calls or errors", () => {
    const history: SessionHistoryState = { status: "ready", items: [{ ...call, id: "other" }], hasMore: false, sessionProposalResults: ["call"] };
    const start: BridgeHistoryItem = { sessionId: "session", id: "call", role: "tool", origin: "claude-desktop",
      toolName: call.toolName!, text: "普通启动", createdAt: 10 };
    const unconfirmed: SessionHistoryState = { ...history, items: [call], sessionProposalResults: [] };
    const error = { ...completed, data: { toolName: call.toolName, isError: true } };
    expect(visible(history)).toMatchObject([{ kind: "tool-group", tools: [{ id: "tool:other" }] }]);
    expect(visible({ ...history, items: [start] })).toMatchObject([{ kind: "tool-group", tools: [{ id: "tool:call" }] }]);
    expect(visible(unconfirmed, [{ ...completed, sessionId: "other" }])).toMatchObject([{ kind: "tool-group", tools: [{ id: "tool:call" }] }]);
    expect(visible(unconfirmed, [error])).toMatchObject([{ kind: "tool-group", tools: [{ id: "tool:call", isError: true }] }]);
  });
});
