import type { BridgeEvidenceBundle, BridgeEvidencePage, BridgeResponse } from "@bridge/protocol";
import { expect, it, vi } from "vitest";
import { openBridgeSession, type BridgeSendRequest } from "./bridge-artifacts.js";
import { applyIncomingEventsToState, INITIAL_STATE, type MobileBridgeState } from "./bridge-reducers.js";

const sessionId = "session-1";
const collecting: BridgeEvidenceBundle = {
  id: "current", sessionId, source: "bridge-host", confidence: "exact",
  state: "collecting", startedAt: 2, toolCount: 0, changeCount: 0, artifactCount: 0,
  tools: [], artifacts: [], warnings: [],
};
const ready = { ...collecting, state: "ready", completedAt: 3, artifactCount: 2 } satisfies BridgeEvidenceBundle;

function deferredList() {
  let resolveList!: (response: BridgeResponse) => void;
  const response = new Promise<BridgeResponse>((resolve) => { resolveList = resolve; });
  return {
    response,
    async deliver(page: Omit<BridgeEvidencePage, "sessionId">) {
      resolveList({ kind: "response", requestId: "list", ok: true, result: { evidence: { sessionId, ...page } } });
      await response;
    },
  };
}

function sessionOpener(...lists: Array<Promise<BridgeResponse>>) {
  const stateRef: { current: MobileBridgeState } = { current: INITIAL_STATE };
  // Return the deferred promise itself so awaiting delivery also flushes the page callback.
  const sendRequest = vi.fn<BridgeSendRequest>((method) => method === "session.open"
    ? Promise.resolve({ kind: "response", requestId: "open", ok: true, result: { history: { sessionId, items: [], hasMore: false } } })
    : lists.shift()!);
  const ctx: Parameters<typeof openBridgeSession>[0] = {
    stateRef,
    setState: (update) => { stateRef.current = typeof update === "function" ? update(stateRef.current) : update; },
    cryptoRef: { current: undefined },
    socketRef: { current: undefined },
    openedSessionRef: { current: undefined },
    openingSessionsRef: { current: new Map() },
    historyReadSequenceRef: { current: 0 },
    sendRequest,
  };
  return { stateRef, sendRequest, open: () => openBridgeSession(ctx, sessionId) };
}

it("keeps live evidence updates that arrive before the first list response", async () => {
  const older = { ...ready, id: "older", startedAt: 1, artifactCount: 1 };
  const list = deferredList();
  const { stateRef, sendRequest, open } = sessionOpener(list.response);
  stateRef.current = {
    ...INITIAL_STATE,
    evidence: { [sessionId]: { status: "ready", items: [collecting], hasMore: false } },
  };
  await open();
  expect(sendRequest).toHaveBeenLastCalledWith("evidence.list", expect.objectContaining({ sessionId }), expect.anything());

  stateRef.current = applyIncomingEventsToState(stateRef.current, [{
    eventId: "ready-1", seq: 1, timestamp: 3, origin: "claude-host",
    type: "evidence.ready", sessionId, data: { evidence: ready },
  }]);
  expect(stateRef.current.evidence[sessionId]?.items).toMatchObject([ready]);

  await list.deliver({ items: [collecting, older], hasMore: true, nextCursor: "older-cursor" });
  expect(stateRef.current.evidence[sessionId]).toMatchObject({
    status: "ready", items: [ready, older], hasMore: true, nextCursor: "older-cursor",
  });

  const updated = { ...ready, artifactCount: 3 };
  stateRef.current = applyIncomingEventsToState(stateRef.current, [{
    eventId: "updated-2", seq: 2, timestamp: 4, origin: "claude-host",
    type: "evidence.updated", sessionId, data: { evidence: updated },
  }]);
  expect(stateRef.current.evidence[sessionId]?.items).toMatchObject([updated, older]);
});

it("applies a newer first page over a prior list response during overlapping opens", async () => {
  const first = deferredList();
  const second = deferredList();
  const { stateRef, sendRequest, open } = sessionOpener(first.response, second.response);
  await open();
  await open();
  expect(sendRequest.mock.calls.map(([method]) => method)).toEqual([
    "session.open", "evidence.list", "session.open", "evidence.list",
  ]);

  await first.deliver({ items: [collecting], hasMore: false });
  expect(stateRef.current.evidence[sessionId]?.items).toMatchObject([collecting]);
  await second.deliver({ items: [ready], hasMore: false });
  expect(stateRef.current.evidence[sessionId]?.items).toMatchObject([ready]);
});
