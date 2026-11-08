import type { BridgeEvent, BridgeHistoryItem, BridgeTaskPlan } from "@bridge/protocol";
import { describe, expect, it } from "vitest";
import { conversationItems } from "./MobileWorkspace.js";

const plan: BridgeTaskPlan = { id: "plan-tool", updatedAt: 1000, items: [{ content: "Check", status: "in_progress" }, { content: "Deliver", status: "pending" }] };
const history: BridgeHistoryItem[] = [{ id: "plan:plan-tool", sessionId: "session", role: "assistant", text: "", createdAt: 1000, origin: "claude-desktop", taskPlan: plan }];
const observed: BridgeEvent = { eventId: "observed", seq: 1, timestamp: 1000, sessionId: "session", itemId: "plan:plan-tool", origin: "claude-desktop", type: "session.observed", data: { role: "assistant", text: "", taskPlan: plan } };
const invalidated: BridgeEvent = { ...observed, eventId: "invalidated", seq: 2, timestamp: 2000, data: { taskPlanInvalidated: true } };

describe("failed native plan updates", () => {
  it("removes an invalidated plan from both loaded history and replayed events", () => {
    const ordinary: BridgeHistoryItem = { id: "answer", sessionId: "session", role: "assistant", text: "The answer remains", createdAt: 3000, origin: "claude-desktop" };
    const items = conversationItems("session", { status: "ready", items: [...history, ordinary], hasMore: false }, [observed, invalidated], []);
    expect(items.filter(item => item.taskPlan)).toEqual([]);
    expect(items.find(item => item.id === "answer")?.text).toBe("The answer remains");
  });

  it("accepts the authoritative newer correction after a provisional advance fails", () => {
    const provisional = { ...plan, updatedAt: 2000, items: [{ content: "Check", status: "completed" as const }, { content: "Deliver", status: "in_progress" as const }] };
    const correction = { ...observed, eventId: "correction", seq: 3, timestamp: 3000, data: { role: "assistant", text: "", taskPlan: { ...plan, updatedAt: 3000 } } };
    const items = conversationItems("session", { status: "ready", items: [{ ...history[0]!, taskPlan: provisional }], hasMore: false }, [{ ...observed, data: { ...observed.data, taskPlan: provisional } }, correction], []);
    expect(items.find(item => item.taskPlan)?.taskPlan?.items).toEqual(plan.items);
  });

  it("keeps another session's plan and tolerates repeated invalidations", () => {
    expect(conversationItems("session", { status: "ready", items: history, hasMore: false }, [{ ...invalidated, sessionId: "other" }], []).filter(item => item.taskPlan)).toHaveLength(1);
    expect(conversationItems("session", { status: "ready", items: history, hasMore: false }, [observed, invalidated, invalidated], []).filter(item => item.taskPlan)).toEqual([]);
  });
});
