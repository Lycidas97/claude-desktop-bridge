import { useEffect, useLayoutEffect, useRef } from "react";
import type { SessionHistoryState } from "../../hooks/useMobileBridge.js";

export function useConversationScroll({ sessionId, sessionView, history, timelineStreamKeys, streamKeys, onLoadOlderHistory }: {
  sessionId: string;
  sessionView: "conversation" | "evidence";
  history: SessionHistoryState | undefined;
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
    historyCount: number;
    lastKey?: string | undefined;
    anchorKey?: string | undefined;
    anchorOffset: number;
    scrollTop?: number | undefined;
    pinnedToBottom: boolean;
  }>({ historyCount: 0, anchorOffset: 0, pinnedToBottom: true });

  function rememberStreamPosition(updateFollow = false): void {
    const stream = streamRef.current;
    if (!stream) return;
    const top = stream.getBoundingClientRect().top;
    const anchor = [...stream.querySelectorAll<HTMLElement>(":scope > [data-stream-key]")]
      .find((element) => element.getBoundingClientRect().bottom > top);
    streamScrollState.current = {
      ...streamScrollState.current,
      anchorKey: anchor?.dataset.streamKey,
      anchorOffset: anchor ? anchor.getBoundingClientRect().top - top : 0,
      scrollTop: stream.scrollTop,
      pinnedToBottom: updateFollow
        ? stream.scrollHeight - stream.scrollTop - stream.clientHeight <= 4
        : streamScrollState.current.pinnedToBottom,
    };
  }

  useLayoutEffect(() => {
    const stream = streamRef.current;
    if (!stream) {
      streamScrollState.current = { historyCount: 0, anchorOffset: 0, pinnedToBottom: true };
      return;
    }
    const previous = streamScrollState.current;
    const entering = previous.sessionId !== sessionId || !previous.lastKey;
    const scrolledUpSynchronously = (
      previous.scrollTop !== undefined
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
    if (entering) {
      stream.scrollTop = stream.scrollHeight;
    } else if ((firstKey !== previous.firstKey || historyPrepended) && previous.anchorKey) {
      const anchor = [...stream.querySelectorAll<HTMLElement>(":scope > [data-stream-key]")]
        .find((element) => element.dataset.streamKey === previous.anchorKey);
      if (anchor) {
        stream.scrollTop += anchor.getBoundingClientRect().top - stream.getBoundingClientRect().top - previous.anchorOffset;
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
      historyCount,
      lastKey,
      pinnedToBottom: entering || shouldFollowBottom,
    };
    rememberStreamPosition();
  }, [sessionView, firstHistoryKey, historyCount, sessionId, streamKeys, timelineStreamKeys]);

  function loadOlderNearTop(): void {
    const stream = streamRef.current;
    if (!stream || !history?.hasMore || !history.nextCursor || history.status !== "ready" || history.error) return;
    if (stream.scrollTop < 200) void onLoadOlderHistory(sessionId);
  }

  useEffect(() => {
    if (sessionView === "conversation") loadOlderNearTop();
  }, [sessionView, firstHistoryKey, history?.nextCursor, sessionId, firstKey]);

  return {
    streamRef,
    onScroll() {
      rememberStreamPosition(true);
      loadOlderNearTop();
    },
  };
}
