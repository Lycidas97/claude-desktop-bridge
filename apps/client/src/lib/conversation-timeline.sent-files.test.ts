import type { BridgeEvent, BridgeHistoryItem } from "@bridge/protocol";
import { expect, it } from "vitest";
import { projectHistoryPage } from "../hooks/bridge/bridge-reducers.js";
import { conversationItems, conversationTimeline, groupTimelineTools } from "./conversation-timeline.js";

it("shows one file card at the SendUserFile call after an older page or live replay arrives", () => {
  const call: BridgeHistoryItem = { id: "send", sessionId: "session", role: "tool", origin: "claude-desktop",
    toolName: "SendUserFile", text: "原始输入", createdAt: 10 };
  const sentFiles = [{ name: "报告.md", path: "/workspace/报告.md" }];
  const receipt: BridgeHistoryItem = { ...call, createdAt: 20, state: "completed", sentFiles };
  const latest = projectHistoryPage({ sessionId: "session", items: [receipt], hasMore: true, nextCursor: "older" });
  const loaded = projectHistoryPage({ sessionId: "session", items: [call], hasMore: false }, latest);
  const started: BridgeEvent = { sessionId: "session", itemId: call.id, origin: "claude-desktop", type: "tool.started",
    eventId: "sent-file-start", seq: 1, timestamp: 10, data: { toolName: call.toolName, text: call.text } };
  const completed: BridgeEvent = { ...started, type: "tool.completed", eventId: "sent-file-complete", seq: 2, timestamp: 20,
    data: { ...started.data, sentFiles } };
  for (const [history, events, createdAt] of [
    [latest, [], 20], [loaded, [], 10], [loaded, [started], 10], [loaded, [started, completed], 10],
    [{ status: "ready", items: [], hasMore: false }, [started, completed], 10],
  ] as const) {
    const timeline = groupTimelineTools(conversationTimeline(conversationItems("session", { ...history, items: [...history.items] }, [...events], [], true), []));
    expect(timeline).toEqual([{ kind: "message", item: { ...call, id: "tool:send", toolUseId: "send", createdAt, state: "completed", sentFiles } }]);
  }
});
