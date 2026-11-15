import type { BridgeMailCache, BridgeMailCard, BridgeMailPage } from "@bridge/protocol";
import { describe, expect, it, vi } from "vitest";
import { mergeMailCards, refreshMailPages } from "./assistant-mail.js";

function card(seq: number, fields: Partial<BridgeMailCard> = {}): BridgeMailCard {
  return {
    seq, mailRefId: `mail-${seq}`, accountKey: "account", mailbox: "INBOX",
    subject: `Mail ${seq}`, from: [{ address: "sender@example.invalid" }],
    receivedAt: "2026-11-14T00:00:00.000Z", recordedAt: seq, preview: `Preview ${seq}`,
    processingStatus: "pending", nativeDelivery: { state: "not-submitted" }, ...fields,
  };
}

describe("refreshMailPages", () => {
  it("walks through multiple pages of arrivals and refreshes the entire previously loaded range", async () => {
    const current: BridgeMailCache = { cards: [card(6), card(5), card(4)], nextCursor: "4", changeToken: "before" };
    const load = vi.fn<(cursor?: string) => Promise<BridgeMailPage>>()
      .mockResolvedValueOnce({ cards: [card(12), card(11), card(10)], nextCursor: "10" })
      .mockResolvedValueOnce({ cards: [card(9), card(8), card(7)], nextCursor: "7" })
      .mockResolvedValueOnce({ cards: [card(6), card(5), card(4)], nextCursor: "4" });

    const refreshed = await refreshMailPages(load, current, "after");

    expect(load.mock.calls).toEqual([[undefined], ["10"], ["7"]]);
    expect(refreshed).toEqual({
      cards: Array.from({ length: 9 }, (_, index) => card(12 - index)),
      nextCursor: "4", changeToken: "after",
    });
    expect(current).toEqual({ cards: [card(6), card(5), card(4)], nextCursor: "4", changeToken: "before" });
  });

  it("re-reads older analysis and processing status even when no insertion sequence changes", async () => {
    const current: BridgeMailCache = { cards: [card(6), card(5), card(4), card(3)], nextCursor: "3", changeToken: "before" };
    const updated = card(3, {
      processingStatus: "processed",
      analysis: { summary: "Reviewed", suggestions: ["Reply tomorrow"], questions: ["Which account?"] },
      nativeDelivery: { state: "observed", nativeSessionId: "native", messageId: "message-3" },
    });
    const load = vi.fn<(cursor?: string) => Promise<BridgeMailPage>>()
      .mockResolvedValueOnce({ cards: [card(6), card(5)], nextCursor: "5" })
      .mockResolvedValueOnce({ cards: [card(4), updated], nextCursor: "3" });

    const refreshed = await refreshMailPages(load, current, "analysis-changed");

    expect(load.mock.calls).toEqual([[undefined], ["5"]]);
    expect(refreshed).toEqual({ cards: [card(6), card(5), card(4), updated], nextCursor: "3", changeToken: "analysis-changed" });
    expect(current.cards.at(-1)).toEqual(card(3));
  });

  it("loads only the first page for an empty cache and keeps its older-page cursor", async () => {
    const load = vi.fn<(cursor?: string) => Promise<BridgeMailPage>>()
      .mockResolvedValue({ cards: [card(3), card(2)], nextCursor: "2" });

    expect(await refreshMailPages(load, { cards: [], changeToken: "" }, "initial")).toEqual({
      cards: [card(3), card(2)], nextCursor: "2", changeToken: "initial",
    });
    expect(load.mock.calls).toEqual([[undefined]]);
  });

  it("clears an exhausted cursor after reaching the end of the mailbox", async () => {
    const load = vi.fn<(cursor?: string) => Promise<BridgeMailPage>>()
      .mockResolvedValueOnce({ cards: [card(4), card(3)], nextCursor: "3" })
      .mockResolvedValueOnce({ cards: [card(2), card(1)] });

    expect(await refreshMailPages(load, { cards: [card(2), card(1)], nextCursor: "stale", changeToken: "before" }, "after"))
      .toEqual({ cards: [card(4), card(3), card(2), card(1)], changeToken: "after" });
    expect(load.mock.calls).toEqual([[undefined], ["3"]]);
  });
});

describe("mergeMailCards", () => {
  it("replaces an existing mail reference, sorts by sequence, and leaves both inputs intact", () => {
    const current = [card(2), card(1)];
    const updated = card(1, { processingStatus: "processed", analysis: { summary: "Done" } });
    const incoming = [updated, card(3)];
    Object.freeze(current);
    Object.freeze(incoming);

    expect(mergeMailCards(current, incoming)).toEqual([card(3), card(2), updated]);
    expect(current).toEqual([card(2), card(1)]);
    expect(incoming).toEqual([updated, card(3)]);
  });
});
