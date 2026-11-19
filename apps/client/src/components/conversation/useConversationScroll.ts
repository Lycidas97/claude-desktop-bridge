import { useEffect, useLayoutEffect, useRef } from "react";
import type { SessionHistoryState } from "../../hooks/useMobileBridge.js";

type StreamAnchor = { key: string; offset: number };

export function useConversationScroll({ sessionId, sessionView, streamVisible, history, openedEvidenceIds, timelineStreamKeys, streamKeys, onLoadOlderHistory }: {
  sessionId: string;
  sessionView: "conversation" | "evidence";
  streamVisible: boolean;
  history: SessionHistoryState | undefined;
  openedEvidenceIds: ReadonlySet<string> | undefined;
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
    const historyPrepended = (
      firstHistoryKey !== undefined
      && previous.firstHistoryKey !== undefined
      && firstHistoryKey !== previous.firstHistoryKey
      && historyCount > previous.historyCount
    );
    const evidenceOpenedWhileReading = !shouldFollowBottom && openedEvidenceIds && openedEvidenceIds !== previous.openedEvidenceIds;
    // A card can land between the clipped row and the first row the reader can see in full.
    const savedAnchor = (evidenceOpenedWhileReading ? previous.fullyVisibleAnchor : undefined) ?? previous.anchor;
    if (entering) {
      stream.scrollTop = stream.scrollHeight;
    } else if (savedAnchor && (
      (previous.paused && !shouldFollowBottom) || firstKey !== previous.firstKey || historyPrepended || evidenceOpenedWhileReading
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
      historyCount,
      lastKey,
      paused: false,
      pinnedToBottom: entering || shouldFollowBottom,
    };
    rememberStreamPosition();
  }, [sessionView, streamVisible, firstHistoryKey, historyCount, openedEvidenceIds, sessionId, streamKeys, timelineStreamKeys]);

  function loadOlderNearTop(): void {
    const stream = streamRef.current;
    if (!streamVisible || !stream || !history?.hasMore || !history.nextCursor || history.status !== "ready" || history.error) return;
    if (stream.scrollTop < 200) void onLoadOlderHistory(sessionId);
  }

  useEffect(() => {
    if (sessionView === "conversation") loadOlderNearTop();
  }, [sessionView, streamVisible, firstHistoryKey, history?.nextCursor, sessionId, firstKey]);

  return {
    streamRef,
    onScroll() {
      if (!streamVisible) return;
      rememberStreamPosition(true);
      loadOlderNearTop();
    },
  };
}
