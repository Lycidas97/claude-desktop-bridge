import { useRef } from "react";
import type { ConversationItem } from "./conversation-timeline.js";

export class LiveReplyExpansion {
  private view: string | undefined;
  private expanded = new Set<string>();
  private seen = new Set<string>();
  private liveTurns = new Map<string, string>();

  update(viewKey: string | undefined, items: readonly ConversationItem[]): ReadonlySet<string> {
    if (this.view !== viewKey) {
      this.view = viewKey;
      this.expanded.clear();
      this.seen.clear();
      this.liveTurns.clear();
    }
    if (!viewKey) return this.expanded;

    const replies = items.filter(item => item.role === "assistant" && item.text && !item.sessionNotice);
    const present = new Set(replies.map(item => item.id));
    this.expanded = new Set([...this.expanded].filter(id => present.has(id)));
    for (const [turnId, liveId] of this.liveTurns) {
      if (present.has(liveId)) continue;
      // A completed reply can replace assistant:<turnId> with its canonical ID.
      // Bind once to the new final, leaving earlier replies in the turn alone.
      const final = replies.filter(item => item.turnId === turnId && !item.live && !this.seen.has(item.id)).at(-1);
      if (final) this.expanded.add(final.id);
      this.liveTurns.delete(turnId);
    }
    for (const item of replies) {
      if (!item.live) continue;
      this.expanded.add(item.id);
      if (item.turnId) this.liveTurns.set(item.turnId, item.id);
    }
    this.seen = present;
    return this.expanded;
  }
}

export function useLiveReplyExpansion(
  viewKey: string | undefined,
  items: readonly ConversationItem[],
): ReadonlySet<string> {
  const tracker = useRef<LiveReplyExpansion | undefined>(undefined);
  if (!tracker.current) tracker.current = new LiveReplyExpansion();
  return tracker.current.update(viewKey, items);
}
