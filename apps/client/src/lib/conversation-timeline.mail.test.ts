import type { BridgeEvidenceBundle, BridgeMailCard } from "@bridge/protocol";
import { describe, expect, it } from "vitest";
import { conversationTimeline, type ConversationItem } from "./conversation-timeline.js";

function card(fields: Partial<BridgeMailCard> = {}): BridgeMailCard {
  return {
    seq: 1, mailRefId: "mail-1", accountKey: "account", mailbox: "INBOX",
    subject: "Mail subject", from: [{ address: "sender@example.invalid" }],
    receivedAt: "2026-11-14T00:00:00.000Z", recordedAt: 15, preview: "Shared text",
    processingStatus: "pending", nativeDelivery: { state: "not-submitted" }, ...fields,
  };
}

function message(fields: Partial<ConversationItem> = {}): ConversationItem {
  return {
    id: "native-message", sessionId: "native-session", role: "user",
    text: "Shared text", createdAt: 20, origin: "claude-desktop", ...fields,
  };
}

describe("mail conversation timeline", () => {
  it("correlates the exact session and message UUID before an observed ACK or business analysis", () => {
    const mail = card({ nativeDelivery: { state: "submitted", nativeSessionId: "native-session", messageId: "native-message" } });
    const wrongSession = message({ sessionId: "other-session", createdAt: 1 });
    const sameText = message({ id: "other-message", createdAt: 2 });
    const native = message({ text: "Native transcript text differs from the mail preview" });
    const reply = message({ id: "reply", role: "assistant", text: "Received", createdAt: 21 });

    expect(conversationTimeline([wrongSession, sameText, native, reply], [], [mail])).toEqual([
      { kind: "message", item: wrongSession },
      { kind: "message", item: sameText },
      { kind: "mail", card: mail, nativeMessage: native },
      { kind: "message", item: reply },
    ]);
    expect(mail.nativeDelivery.state).toBe("submitted");
    expect(mail.processingStatus).toBe("pending");
    expect(mail.analysis).toBeUndefined();
  });

  it.each([
    { name: "another session", item: message({ sessionId: "other-session" }) },
    { name: "another message UUID", item: message({ id: "other-message" }) },
    { name: "an assistant message", item: message({ role: "assistant" }) },
  ])("keeps $name separate even when the text matches the mail preview", ({ item }) => {
    const mail = card({ nativeDelivery: { state: "observed", nativeSessionId: "native-session", messageId: "native-message" } });

    expect(conversationTimeline([item], [], [mail])).toEqual([
      { kind: "mail", card: mail },
      { kind: "message", item },
    ]);
  });

  it("replaces old and current native UUIDs with one batch without merging each mail's business state", () => {
    const nativeDelivery = { state: "observed" as const, batchId: "batch", nativeSessionId: "native-session",
      messageId: "native-message", previousMessageIds: ["before-rekey"] };
    const first = card({ nativeDelivery });
    const second = card({ nativeDelivery, seq: 2, mailRefId: "second", processingStatus: "processed" });
    const alias = message({ id: "before-rekey", createdAt: 1 });
    const other = message({ sessionId: "other-session", createdAt: 10 });
    const native = message();
    const batch = { kind: "assistant-trigger-batch", batchId: "batch", cards: [first, second] };
    expect(conversationTimeline([alias, other, native], [], [second, first])).toEqual([
      { kind: "message", item: other }, { ...batch, nativeMessage: native },
    ]);
    expect(conversationTimeline([alias], [], [first, second])).toEqual([{ ...batch, nativeMessage: alias }]);
    expect(conversationTimeline([], [], [first, second])).toEqual([batch]);
  });

  it("shows recorded, unsubmitted mail without a native message, analysis, or ACK", () => {
    const mail = card();

    expect(conversationTimeline([], [], [mail])).toEqual([{ kind: "mail", card: mail }]);
  });

  it("does not infer native correlation from matching mail text without host-supplied IDs", () => {
    const mail = card();
    const item = message();

    expect(conversationTimeline([item], [], [mail])).toEqual([
      { kind: "mail", card: mail },
      { kind: "message", item },
    ]);
  });

  it("orders same-millisecond arrivals by ascending sequence when pages arrive newest first", () => {
    const cards = [3, 2, 1].map(seq => card({ seq, mailRefId: `mail-${seq}`, recordedAt: 15 }));

    expect(conversationTimeline([], [], cards)).toEqual([...cards].reverse().map(card => ({ kind: "mail", card })));
    expect(cards.map(card => card.seq)).toEqual([3, 2, 1]);
  });

  it("inserts standalone cards chronologically without sorting or rewriting the inputs", () => {
    const items = [message({ id: "first", createdAt: 10 }), message({ id: "last", createdAt: 30 })];
    const later = card({ seq: 2, mailRefId: "later", recordedAt: 25 });
    const earlier = card({ recordedAt: 5 });
    const cards = [later, earlier];
    const evidence: BridgeEvidenceBundle[] = [{
      id: "evidence", sessionId: "native-session", turnId: "first", source: "claude-desktop",
      confidence: "inferred", state: "ready", startedAt: 11, completedAt: 12,
      toolCount: 0, changeCount: 0, artifactCount: 0, tools: [], artifacts: [], warnings: [],
    }];
    const original = structuredClone({ items, cards, evidence });
    for (const item of items) Object.freeze(item);
    for (const mail of cards) {
      Object.freeze(mail.nativeDelivery);
      Object.freeze(mail);
    }
    Object.freeze(items);
    Object.freeze(cards);
    Object.freeze(evidence);

    expect(conversationTimeline(items, evidence, cards)).toEqual([
      { kind: "mail", card: earlier },
      { kind: "message", item: items[0] },
      { kind: "evidence", evidence: evidence[0] },
      { kind: "mail", card: later },
      { kind: "message", item: items[1] },
    ]);
    expect({ items, cards, evidence }).toEqual(original);
  });
});
