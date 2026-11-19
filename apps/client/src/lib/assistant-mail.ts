import type { BridgeMailCache, BridgeMailCard, BridgeMailPage } from "@bridge/protocol";

export function mergeMailCards(current: BridgeMailCard[], incoming: BridgeMailCard[]): BridgeMailCard[] {
  const cards = new Map(current.map(card => [card.mailRefId, card]));
  for (const card of incoming) cards.set(card.mailRefId, card);
  return [...cards.values()].sort((left, right) => right.seq - left.seq);
}

/** Re-read the loaded range, including newly imported history if the client was at the end. */
export async function refreshMailPages(load: (cursor?: string) => Promise<BridgeMailPage>, current: BridgeMailCache, changeToken: string): Promise<BridgeMailCache> {
  const oldest = current.cards.at(-1)?.seq;
  let cards: BridgeMailCard[] = [];
  let page: BridgeMailPage;
  let cursor: string | undefined;
  do {
    page = await load(cursor);
    cards = mergeMailCards(cards, page.cards);
    cursor = page.nextCursor;
  } while (cursor && oldest !== undefined && (!current.nextCursor || page.cards.at(-1)!.seq > oldest));
  return { cards, changeToken, ...(current.workspace ? { workspace: current.workspace } : {}), ...(cursor ? { nextCursor: cursor } : {}) };
}
