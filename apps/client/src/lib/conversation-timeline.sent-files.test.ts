import type { BridgeEvent, BridgeHistoryItem } from "@bridge/protocol";
import { expect, it } from "vitest";
import { projectHistoryPage } from "../hooks/bridge/bridge-reducers.js";
import { conversationItems, conversationTimeline, groupTimelineTools } from "./conversation-timeline.js";

it("shows one file card at the SendUserFile call after an older page or live replay arrives", () => {
  const call: BridgeHistoryItem = { id: "send", sessionId: "session", role: "tool", origin: "claude-desktop",
    toolName: "SendUserFile", text: "原始输入", createdAt: 10 };
  const sentFiles = [{ name: "报告.md", path: "/workspace/报告.md" }];
  const latest = projectHistoryPage({ sessionId: "session", items: [], hasMore: true, nextCursor: "older", sessionFileReceipts: { send: sentFiles } });
  const loaded = projectHistoryPage({ sessionId: "session", items: [call], hasMore: false }, latest);
  const started: BridgeEvent = { sessionId: "session", itemId: call.id, origin: "claude-desktop", type: "tool.started",
    eventId: "sent-file-start", seq: 1, timestamp: 10, data: { toolName: call.toolName, text: call.text } };
  const completed: BridgeEvent = { ...started, type: "tool.completed", eventId: "sent-file-complete", seq: 2, timestamp: 20,
    data: { ...started.data, sentFiles } };
  const empty = { ...loaded, items: [], sessionFileReceipts: {} };
  const items = (history = loaded, events: BridgeEvent[] = []) => conversationItems("session", history, events, [], true);
  expect(items(latest)).toEqual([]);
  expect(items(latest, [completed])).toEqual([]);
  expect(items({ ...loaded, items: [{ ...call, toolName: "Read" }] })[0]?.sentFiles).toBeUndefined();
  for (const [history, events] of [[loaded, []], [loaded, [started]], [loaded, [started, completed]], [empty, [started, completed]]] as const) {
    const timeline = groupTimelineTools(conversationTimeline(items(history, [...events]), []));
    expect(timeline).toEqual([{ kind: "message", item: { ...call, id: "tool:send", toolUseId: "send", state: "completed", sentFiles } }]);
  }
  const unavailable = [{ name: "报告.md" }];
  expect(items({ ...loaded, sessionFileReceipts: { send: unavailable } }, [started, completed])[0]?.sentFiles).toEqual(unavailable);
});
