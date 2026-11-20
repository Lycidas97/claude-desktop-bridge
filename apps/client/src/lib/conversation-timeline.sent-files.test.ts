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

it("keeps a loaded SendUserFile card at the page boundary but hides earlier replay-only items", () => {
  const call: BridgeHistoryItem = { id: "toolu_123", sessionId: "session", role: "tool", origin: "claude-desktop",
    toolName: "SendUserFile", text: "原始输入", createdAt: 10 };
  const reply: BridgeHistoryItem = { id: "reply", sessionId: "session", role: "assistant", origin: "claude-desktop", text: "已发送", createdAt: 11 };
  const sentFiles = [{ name: "报告.md", path: "/workspace/报告.md" }];
  const history = projectHistoryPage({ sessionId: "session", items: [call, reply], hasMore: true, nextCursor: "older",
    sessionFileReceipts: { [call.id]: sentFiles } });
  const events: BridgeEvent[] = [
    { eventId: "old", itemId: "old", seq: 1, timestamp: 9, sessionId: "session", origin: "claude-desktop", type: "assistant.completed", data: { text: "Earlier replay" } },
    { eventId: "same-time", itemId: "same-time", seq: 2, timestamp: 10, sessionId: "session", origin: "claude-desktop", type: "assistant.completed", data: { text: "Same-time earlier replay" } },
    { eventId: "live", itemId: "live", seq: 3, timestamp: 12, sessionId: "session", origin: "claude-desktop", type: "assistant.completed", data: { text: "New reply" } },
  ];
  expect(conversationItems("session", history, events, [], true)).toMatchObject([
    { id: `tool:${call.id}`, createdAt: 10, sentFiles }, { id: reply.id }, { id: "live" },
  ]);
});
