import { useEffect, useLayoutEffect, useRef } from "react";
import type { SessionHistoryState } from "../../hooks/useMobileBridge.js";

type StreamAnchor = { key: string; offset: number };

export function useConversationScroll({ sessionId, sessionView, streamVisible, history, openedEvidenceIds, inlineProposalLayout, timelineStreamKeys, streamKeys, assistant, findingReply, onLoadOlderHistory }: {
  sessionId: string;
  sessionView: "conversation" | "evidence";
  assistant: boolean;
  findingReply: boolean;
  streamVisible: boolean;
  history: SessionHistoryState | undefined;
  openedEvidenceIds: ReadonlySet<string> | undefined;
  inlineProposalLayout: string;
  timelineStreamKeys: string[];
  streamKeys: string[];
  onLoadOlderHistory(sessionId: string): Promise<void>;
}) {
  const streamRef = useRef<HTMLDivElement>(null);
  const firstKey = timelineStreamKeys[0];
  const lastKey = streamKeys.at(-1);
  const firstHistoryKey = history?.items[0]?.id;
  const historyCount = history?.items.length ?? 0;
  const streamScrollState = useRef<{
    sessionId?: string | undefined;
    firstKey?: string | undefined;
    firstHistoryKey?: string | undefined;
    openedEvidenceIds?: ReadonlySet<string> | undefined;
    inlineProposalLayout?: string;
    historyCount: number;
    lastKey?: string | undefined;
    anchor?: StreamAnchor | undefined;
    fullyVisibleAnchor?: StreamAnchor | undefined;
    scrollTop?: number | undefined;
    paused?: boolean;
    pinnedToBottom: boolean;
  }>({ historyCount: 0, pinnedToBottom: true });

  function rememberStreamPosition(updateFollow = false): void {
    const stream = streamRef.current;
    if (!stream) return;
    const { top, bottom } = stream.getBoundingClientRect();
    let anchor: StreamAnchor | undefined;
    let fullyVisibleAnchor: StreamAnchor | undefined;
    for (const element of stream.querySelectorAll<HTMLElement>(":scope > [data-stream-key]")) {
      const bounds = element.getBoundingClientRect();
      if (bounds.top >= bottom) break;
      if (bounds.bottom <= top) continue;
      const row = { key: element.dataset.streamKey!, offset: bounds.top - top };
      anchor ??= row;
      if (bounds.top >= top && bounds.bottom <= bottom) {
        fullyVisibleAnchor = row;
        break;
      }
    }
    streamScrollState.current = {
      ...streamScrollState.current,
      anchor,
      fullyVisibleAnchor,
      scrollTop: stream.scrollTop,
      pinnedToBottom: updateFollow
        ? stream.scrollHeight - stream.scrollTop - stream.clientHeight <= 4
        : streamScrollState.current.pinnedToBottom,
    };
  }

  useLayoutEffect(() => {
    const previous = streamScrollState.current;
    if (!streamVisible) {
      previous.paused = true;
      return;
    }
    const stream = streamRef.current;
    if (!stream) {
      streamScrollState.current = { historyCount: 0, pinnedToBottom: true };
      return;
    }
    const entering = previous.sessionId !== sessionId || !previous.lastKey;
    if (previous.paused && !entering && !previous.pinnedToBottom && previous.scrollTop !== undefined) {
      stream.scrollTop = previous.scrollTop;
    }
    const scrolledUpSynchronously = (
      !previous.paused && previous.scrollTop !== undefined
      && stream.scrollTop < previous.scrollTop - 4
      && stream.scrollHeight - stream.scrollTop - stream.clientHeight > 4
    );
    const shouldFollowBottom = scrolledUpSynchronously ? false : previous.pinnedToBottom;
    const historyNeedsAnchor = historyCount > previous.historyCount && (
      !shouldFollowBottom || (previous.firstHistoryKey !== undefined && firstHistoryKey !== previous.firstHistoryKey)
    );
    const cardChangedWhileReading = !shouldFollowBottom && (
      (openedEvidenceIds && openedEvidenceIds !== previous.openedEvidenceIds) || inlineProposalLayout !== previous.inlineProposalLayout
    );
    // A card can land between the clipped row and the first row the reader can see in full.
    const savedAnchor = (cardChangedWhileReading ? previous.fullyVisibleAnchor : undefined) ?? previous.anchor;
    if (entering) {
      stream.scrollTop = stream.scrollHeight;
    } else if (savedAnchor && (
      (previous.paused && !shouldFollowBottom) || firstKey !== previous.firstKey || historyNeedsAnchor || cardChangedWhileReading
    )) {
      const anchor = [...stream.querySelectorAll<HTMLElement>(":scope > [data-stream-key]")]
        .find((element) => element.dataset.streamKey === savedAnchor.key);
      if (anchor) {
        stream.scrollTop += anchor.getBoundingClientRect().top - stream.getBoundingClientRect().top - savedAnchor.offset;
      } else if (shouldFollowBottom) {
        stream.scrollTop = stream.scrollHeight;
      }
    } else if (shouldFollowBottom) {
      stream.scrollTop = stream.scrollHeight;
    }
    streamScrollState.current = {
      ...previous,
      sessionId,
      firstKey,
      firstHistoryKey,
      openedEvidenceIds,
      inlineProposalLayout,
      historyCount,
      lastKey,
      paused: false,
      pinnedToBottom: entering || shouldFollowBottom,
    };
    rememberStreamPosition();
  }, [sessionView, streamVisible, firstHistoryKey, historyCount, openedEvidenceIds, inlineProposalLayout, sessionId, streamKeys, timelineStreamKeys]);

  const readSequence = history?.latestRead?.sequence;
  const assistantBackfill = useRef({ sessionId, readSequence, cursors: new Set<string>() });
  function loadOlderNearTop(automatic: boolean): void {
    const stream = streamRef.current;
    const cursor = history?.nextCursor;
    if (!streamVisible || !stream || !history?.hasMore || !cursor || history.status !== "ready" || history.error) return;
    if (assistant) {
      if (!automatic && !firstKey) return;
      if (automatic) {
        if (firstKey || findingReply) return;
        // Filtered wake pages cannot move scrollTop away from zero. Bound the search for chat.
        if (assistantBackfill.current.sessionId !== sessionId || assistantBackfill.current.readSequence !== readSequence) {
          assistantBackfill.current = { sessionId, readSequence, cursors: new Set() };
        }
        const { cursors } = assistantBackfill.current;
        if (cursors.size >= 2 || cursors.has(cursor)) return;
        cursors.add(cursor);
      }
    }
    if (stream.scrollTop < 200) void onLoadOlderHistory(sessionId);
  }

  useEffect(() => {
    if (sessionView === "conversation") loadOlderNearTop(true);
  }, [sessionView, streamVisible, firstHistoryKey, history?.nextCursor, sessionId, firstKey, assistant, findingReply, assistant ? readSequence : undefined]);

  return {
    streamRef,
    onScroll() {
      if (!streamVisible) return;
      rememberStreamPosition(true);
      loadOlderNearTop(false);
    },
  };
}
