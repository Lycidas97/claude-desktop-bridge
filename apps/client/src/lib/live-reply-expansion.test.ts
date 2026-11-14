import { describe, expect, it } from "vitest";
import type { ConversationItem } from "./conversation-timeline.js";
import { LiveReplyExpansion } from "./live-reply-expansion.js";

function reply(id: string, fields: Partial<ConversationItem> = {}): ConversationItem {
  return { id, sessionId: "session", role: "assistant", text: "Reply", createdAt: 1, origin: "claude-desktop", ...fields };
}

describe("LiveReplyExpansion", () => {
  it("leaves history collapsed, including completed replies on first paint", () => {
    const tracker = new LiveReplyExpansion();
    expect(tracker.update("view", [reply("history", { turnId: "old-turn" })])).toEqual(new Set());
  });

  it("keeps a native reply expanded when completion retains its ID without a turn", () => {
    const tracker = new LiveReplyExpansion();
    expect(tracker.update("view", [reply("native", { live: true })])).toEqual(new Set(["native"]));
    expect(tracker.update("view", [reply("native")])).toEqual(new Set(["native"]));
  });

  it("transfers a viewed stream to its new final ID without expanding other replies in the turn", () => {
    const tracker = new LiveReplyExpansion();
    const earlier = reply("earlier", { turnId: "turn" });
    tracker.update("view", [earlier, reply("assistant:turn", { turnId: "turn", live: true })]);
    const completed = [earlier, reply("intermediate", { turnId: "turn" }), reply("final", { turnId: "turn" })];
    expect(tracker.update("view", completed)).toEqual(new Set(["final"]));
    expect(tracker.update("view", [...completed, reply("later", { turnId: "turn" })])).toEqual(new Set(["final"]));
  });

  it("keeps consecutive viewed replies expanded as later turns arrive", () => {
    const tracker = new LiveReplyExpansion();
    tracker.update("view", [reply("first", { live: true })]);
    tracker.update("view", [reply("first"), reply("assistant:second", { turnId: "second", live: true })]);
    expect(tracker.update("view", [reply("first"), reply("second-final", { turnId: "second" })])).toEqual(new Set(["first", "second-final"]));
  });

  it("clears reading state when switching views and reopening the same history", () => {
    const tracker = new LiveReplyExpansion();
    tracker.update("host-a:session", [reply("message", { live: true })]);
    tracker.update("host-b:session", [reply("message")]);
    expect(tracker.update("host-a:session", [reply("message")])).toEqual(new Set());
  });

  it("does not record replies while the conversation is hidden", () => {
    const tracker = new LiveReplyExpansion();
    tracker.update("view", [reply("message", { live: true })]);
    expect(tracker.update(undefined, [reply("message", { live: true })])).toEqual(new Set());
    expect(tracker.update("view", [reply("message")])).toEqual(new Set());
  });

  it("does not expand a reply that completes while another view is open", () => {
    const tracker = new LiveReplyExpansion();
    tracker.update("view", [reply("assistant:turn", { turnId: "turn", live: true })]);
    tracker.update(undefined, [reply("assistant:turn", { turnId: "turn", live: true })]);
    expect(tracker.update("view", [reply("final", { turnId: "turn" })])).toEqual(new Set());
  });
});
