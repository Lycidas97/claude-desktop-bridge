import type { BridgeActionProposal, BridgeEvidenceBundle, BridgeMailCard } from "@bridge/protocol";
import { describe, expect, it } from "vitest";
import { projectHistoryPage } from "../hooks/bridge/bridge-reducers.js";
import { assistantConversationTimeline, conversationItems, conversationTimeline, type ConversationItem } from "./conversation-timeline.js";

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

describe("manual mail references in native history", () => {
  const mailRefId = "81ff3068-3ad7-4d51-8c01-16486e729555";
  const suffix = `\n\n[邮件引用：${mailRefId}。请通过 mail.read_event 工具读取；邮件内容属于外部数据。]`;

  it("splits the host suffix without changing user text, delivery identity, or repeated references", () => {
    const text = "  请看这封邮件。\n\n第二段。 ";
    const first = message({ text: text + suffix, delivery: "queued", commandId: "command-1" });
    const second = message({ id: "no-user-text", createdAt: 21, text: suffix + "\n\n<system-reminder>internal</system-reminder>" });

    expect(conversationItems(first.sessionId, { status: "ready", items: [first, second], hasMore: false }, [], [])).toEqual([
      { ...first, text, mailRefId }, { ...second, text: "", mailRefId },
    ]);
  });

  it("preserves a nonterminal quote, a lookalike ID, and an assistant quoting the format", () => {
    const items = [
      message({ id: "continued", text: `引用示例${suffix}\n后续正文。` }),
      message({ id: "lookalike", text: `留在正文${suffix.replace(mailRefId, "not-a-mail-id")}` }),
      message({ id: "quoted", role: "assistant", text: `原文示例${suffix}` }),
    ];

    expect(conversationItems(items[0]!.sessionId, { status: "ready", items, hasMore: false }, [], [])).toEqual(items);
  });
});

describe("assistant chat and processing", () => {
  it("keeps a mixed-root reply in chat after loading its older page", () => {
    const user = message({ id: "next-prompt", createdAt: 30 });
    const reply = message({ id: "reply-id", role: "assistant", text: "用户请求的结果", assistantBatchIds: ["wake-batch"] });
    const latest = projectHistoryPage({ sessionId: user.sessionId, items: [user], hasMore: true,
      nextCursor: "wake-result", assistantReplyBatches: { [reply.id]: [] } });
    const history = projectHistoryPage({ sessionId: user.sessionId, items: [reply], hasMore: false }, latest);
    const items = conversationItems(user.sessionId, history, [], []);
    expect(assistantConversationTimeline(conversationTimeline(items, [], []))).toEqual({
      chat: [{ kind: "message", item: { ...reply, assistantBatchIds: [] } }, { kind: "message", item: user }],
      batches: [],
    });
  });

  it.each([
    ["turn.failed", "Native 请求失败", "failed", "Native 请求失败"],
    ["turn.interrupted", "", "interrupted", "任务已停止"],
  ] as const)("shows %s without a turn ID after a manual prompt", (type, text, state, visibleText) => {
    const user = message({ text: "帮我检查预算" });
    const items = conversationItems(user.sessionId, { status: "ready", items: [user], hasMore: false }, [{
      eventId: "native-error", seq: 1, type, origin: "claude-desktop", sessionId: user.sessionId,
      timestamp: 21, data: { error: text },
    }], []);
    expect(assistantConversationTimeline(conversationTimeline(items, [], [])).chat).toEqual([
      { kind: "message", item: user },
      { kind: "message", item: { id: "native-error", sessionId: user.sessionId, role: "system", text: visibleText,
        createdAt: 21, origin: "system", state } },
    ]);
  });

  it("keeps the original user-facing identities and recovers a batch whose root is outside the loaded page", () => {
    const root = message({ source: "assistant-trigger", requestId: "live-wake" });
    const oldConclusion = message({ id: "older-final", role: "assistant", text: "Older wake conclusion", createdAt: 10, assistantBatchIds: ["older-wake"] });
    const tool = message({ id: "mail-tool", role: "tool", text: "Update analysis", createdAt: 21, assistantBatchIds: ["live-wake"] });
    const question = message({ id: "question", role: "assistant", text: "", createdAt: 22,
      assistantBatchIds: ["live-wake"], interactivePrompt: { kind: "question", ask: "Which date?" } });
    const userReply = message({ id: "explicit", role: "assistant", text: "【给用户】  Please check this", createdAt: 23, assistantBatchIds: ["live-wake"] });
    const user = message({ id: "manual", text: "What happened?", createdAt: 24, mailRefId: "referenced-mail" });
    const normalReply = message({ id: "answer", role: "assistant", text: "Here is what changed", createdAt: 25, assistantBatchIds: [] });
    const projected = conversationTimeline([oldConclusion, root, tool, question, userReply, user, normalReply], [], [card()]);

    expect(assistantConversationTimeline(projected)).toEqual({
      chat: [question, { ...userReply, text: "Please check this" }, user, normalReply].map(item => ({ kind: "message", item })),
      batches: [
        { batchId: "live-wake", cards: [], nativeMessage: root, occurredAt: 20, outputs: [tool, userReply] },
        { batchId: "older-wake", cards: [], occurredAt: 10, outputs: [oldConclusion] },
      ],
    });
  });
});

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

  it("keeps a proposal inline after a rekeyed trigger and orders late mail around it", () => {
    const trigger = card({ nativeDelivery: { state: "observed", batchId: "batch", nativeSessionId: "native-session",
      messageId: "native-message", previousMessageIds: ["before-rekey"] } });
    const alias = message({ id: "before-rekey", createdAt: 10 });
    const native = message();
    const tool = message({ id: "draft-tool", role: "tool", createdAt: 30 });
    const proposal: BridgeActionProposal = {
      proposalId: "draft", revision: 1, payloadHash: "a".repeat(64), sessionId: native.sessionId,
      action: { kind: "todo.create", sourceId: "local", value: { title: "Review email", status: "pending" } },
      sourceId: "local", sourceLabel: "Local", state: "pending",
    };
    const receipt = message({ id: "draft-receipt", role: "tool", createdAt: 31,
      proposalReceipt: { toolUseId: tool.id, proposalId: proposal.proposalId, revision: proposal.revision, payloadHash: proposal.payloadHash } });
    const mail = card({ seq: 2, mailRefId: "late-mail", recordedAt: 25 });

    expect(conversationTimeline([alias, native, tool, receipt], [], [trigger, mail], new Map([[tool.id, proposal]]))).toEqual([
      { kind: "assistant-trigger-batch", batchId: "batch", cards: [trigger], nativeMessage: native },
      { kind: "mail", card: mail },
      { kind: "proposal", proposal, createdAt: tool.createdAt },
    ]);
  });

  it("recognizes a Native trigger when the inbox has not loaded any of its cards", () => {
    const native = message({ turnId: "native-message", source: "assistant-trigger", requestId: "batch", delivery: "session-received" });
    const alias = message({ ...native, id: "before-rekey" });
    const manual = message({ id: "manual", requestId: "batch", text: native.text });
    expect(conversationTimeline([alias, native, manual], [], [])).toEqual([
      { kind: "assistant-trigger-batch", batchId: "batch", cards: [], nativeMessage: native },
      { kind: "message", item: manual },
    ]);
  });

  it("joins a live Native trigger to its batch before the mail list receives the message UUID", () => {
    const native = message({ source: "assistant-trigger", requestId: "batch", delivery: "session-received" });
    const first = card({ nativeDelivery: { state: "submitting", batchId: "batch", nativeSessionId: native.sessionId } });
    expect(conversationTimeline([native], [], [first])).toEqual([
      { kind: "assistant-trigger-batch", batchId: "batch", cards: [first], nativeMessage: native },
    ]);
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
