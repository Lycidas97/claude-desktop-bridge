import type { BridgeMailCache, BridgeMailCard, BridgeMailPage } from "@bridge/protocol";

function receivedTime(value: string): number {
  const time = Date.parse(value);
  return Number.isNaN(time) ? -Infinity : time;
}

export function mailCardOrder(order: BridgeMailPage["order"]): (left: BridgeMailCard, right: BridgeMailCard) => number {
  return order === "received"
    ? (left, right) => receivedTime(right.receivedAt) - receivedTime(left.receivedAt) || Math.abs(right.seq) - Math.abs(left.seq)
    : (left, right) => right.seq - left.seq;
}

export function mergeMailCards(current: BridgeMailCard[], incoming: BridgeMailCard[], order?: BridgeMailPage["order"]): BridgeMailCard[] {
  const cards = new Map(current.map(card => [card.mailRefId, card]));
  for (const card of incoming) cards.set(card.mailRefId, card);
  return [...cards.values()].sort(mailCardOrder(order));
}

/** Re-read the loaded range, including newly imported history if the client was at the end. */
export async function refreshMailPages(load: (cursor?: string) => Promise<BridgeMailPage>, current: BridgeMailCache, changeToken: string): Promise<BridgeMailCache> {
  const firstPage = await load(undefined);
  const compare = mailCardOrder(firstPage.order);
  const oldest = current.order === firstPage.order ? current.cards.at(-1) : undefined;
  let page = firstPage;
  const cards = [...page.cards];
  while (page.nextCursor && oldest && (!current.nextCursor || compare(page.cards.at(-1)!, oldest) < 0)) {
    page = await load(page.nextCursor);
    cards.push(...page.cards);
  }
  const { nextCursor: _cursor, ...metadata } = firstPage;
  return { ...metadata, cards: mergeMailCards([], cards, firstPage.order), changeToken,
    ...(current.workspace ? { workspace: current.workspace } : {}), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
}
