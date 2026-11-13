import type { BridgeEvent, BridgeHostSnapshot, BridgePendingPrompt, BridgePrAutoFixState } from "@bridge/protocol";
import { describe, expect, it } from "vitest";
import { conversationItems } from "../../lib/conversation-timeline.js";
import { applyEventsToSnapshot, applyEventToSnapshot, applyPrAutoFixToSnapshot, hostStatus, rebaseSnapshot } from "./bridge-reducers.js";

const prompt: BridgePendingPrompt = {
  kind: "auto-mode-server-fallback", sessionId: "native", promptId: "fallback", title: "确认继续", canRespond: true,
  choices: [{ value: "continue", label: "继续" }, { value: "interrupt", label: "停止" }],
};
const before = {
  host: {}, latestSeq: 0, permissions: [], prompts: [],
  runtime: { activeTurns: 0 },
  sessions: [{ sessionId: "native", transport: "claude-desktop-native", turnState: "idle" }],
} as unknown as BridgeHostSnapshot;
const opened: BridgeEvent = {
  eventId: "open", seq: 1, timestamp: 1, sessionId: "native", origin: "claude-desktop", type: "prompt.requested", data: { ...prompt },
};
const resolved: BridgeEvent = {
  eventId: "resolve", seq: 2, timestamp: 2, sessionId: "native", origin: "claude-desktop", type: "prompt.resolved",
  data: { promptId: "fallback", kind: prompt.kind, choice: "interrupt", resolvedByName: "我的手机", resolvedByDeviceId: "phone", resolvedAt: 2 },
};

describe("Native PR state", () => {
  it("applies read/set results and then replaces them with Native settlement projection", () => {
    const state: BridgePrAutoFixState = {
      sessionId: "native", prs: [], onlyOwnPrs: true, nextOwnPrArmed: true,
      capabilities: { bound: true, onlyOwnPrs: true, nextPr: true, checks: true },
    };
    const armed = applyPrAutoFixToSnapshot(before, state)!;
    expect(armed.sessions[0]?.prAutoFix).toEqual({ onlyOwnPrs: true, nextOwnPrArmed: true });
    const update: BridgeEvent = {
      eventId: "runtime", seq: 1, timestamp: 1, sessionId: "native", origin: "system", type: "runtime.updated",
      data: { replaceSession: true, session: { ...armed.sessions[0], prAutoFix: { onlyOwnPrs: true, nextOwnPrArmed: false } } },
    };
    expect(applyEventToSnapshot(armed, update, [])?.sessions[0]?.prAutoFix?.nextOwnPrArmed).toBe(false);
    expect(applyEventsToSnapshot(armed, [update], []).snapshot?.sessions[0]?.prAutoFix?.nextOwnPrArmed).toBe(false);
    expect(applyPrAutoFixToSnapshot(armed, { sessionId: "native", prs: [], capabilities: state.capabilities })?.sessions[0]?.prAutoFix).toBeUndefined();
  });
});

describe("Native prompt state", () => {
  it("adds opened dialogs and clears a locally answered dialog through the resolved event", () => {
    const pending = applyEventToSnapshot(before, opened, [])!;
    expect(pending.prompts).toEqual([prompt]);
    expect(hostStatus(pending)).toBe("attention");
    const after = applyEventToSnapshot(pending, resolved, [])!;
    expect(after.prompts).toEqual([]);
    expect(hostStatus(after)).toBe("standby");
    expect(applyEventsToSnapshot(before, [opened, resolved], []).snapshot).toEqual(after);
  });

  it("does not resurrect a prompt from stale replay and retains fresh snapshot replacement", () => {
    const after = applyEventsToSnapshot(before, [opened, resolved], []).snapshot!;
    expect(applyEventToSnapshot(after, opened, [])).toBe(after);
    expect(rebaseSnapshot({ ...before, latestSeq: 1, prompts: [prompt] }, [resolved]).snapshot.prompts).toEqual([]);
    expect(rebaseSnapshot({ ...before, latestSeq: 2 }, [opened, resolved]).snapshot.prompts).toEqual([]);
  });

  it("removes pending dialogs when their session disappears", () => {
    const deleted = { ...resolved, type: "session.deleted" as const, data: {} };
    const after = applyEventsToSnapshot({ ...before, prompts: [prompt] }, [deleted], []).snapshot!;
    expect(after.prompts).toEqual([]);
    expect(after.sessions).toEqual([]);
  });

  it("keeps resolver attribution in the conversation without inventing a tool permission result", () => {
    const items = conversationItems("native", undefined, [resolved], []);
    expect(items.some(item => item.text === "我的手机回答了 Desktop 提示")).toBe(true);
    expect(items.some(item => item.text.includes("允许了这一次操作"))).toBe(false);
  });
});
