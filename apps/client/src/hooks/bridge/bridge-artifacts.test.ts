import type { BridgeEvidenceBundle, BridgeEvidencePage, BridgeResponse } from "@bridge/protocol";
import { expect, it, vi } from "vitest";
import { openBridgeSession, type BridgeSendRequest } from "./bridge-artifacts.js";
import { applyIncomingEventsToState, INITIAL_STATE, type MobileBridgeState } from "./bridge-reducers.js";

it("keeps live evidence updates that arrive before the first list response", async () => {
  const sessionId = "session-1";
  const collecting: BridgeEvidenceBundle = {
    id: "current", sessionId, source: "bridge-host", confidence: "exact",
    state: "collecting", startedAt: 2, toolCount: 0, changeCount: 0, artifactCount: 0,
    tools: [], artifacts: [], warnings: [],
  };
  const ready = { ...collecting, state: "ready", completedAt: 3, artifactCount: 2 } satisfies BridgeEvidenceBundle;
  const older = { ...ready, id: "older", startedAt: 1, artifactCount: 1 };
  const stateRef: { current: MobileBridgeState } = { current: {
    ...INITIAL_STATE,
    evidence: { [sessionId]: { status: "ready", items: [collecting], hasMore: false } },
  } };
  let resolveList!: (response: BridgeResponse) => void;
  const listResponse = new Promise<BridgeResponse>((resolve) => { resolveList = resolve; });
  const sendRequest = vi.fn<BridgeSendRequest>((method) => method === "session.open"
    ? Promise.resolve({ kind: "response", requestId: "open", ok: true, result: {
        history: { sessionId, items: [], hasMore: false },
      } })
    : listResponse);

  await openBridgeSession({
    stateRef,
    setState: (update) => { stateRef.current = typeof update === "function" ? update(stateRef.current) : update; },
    cryptoRef: { current: undefined },
    socketRef: { current: undefined },
    openedSessionRef: { current: undefined },
    openingSessionsRef: { current: new Map() },
    sendRequest,
  }, sessionId);
  expect(sendRequest).toHaveBeenLastCalledWith("evidence.list", expect.objectContaining({ sessionId }), expect.anything());

  stateRef.current = applyIncomingEventsToState(stateRef.current, [{
    eventId: "ready-1", seq: 1, timestamp: 3, origin: "claude-host",
    type: "evidence.ready", sessionId, data: { evidence: ready },
  }]);
  expect(stateRef.current.evidence[sessionId]?.items).toMatchObject([ready]);

  resolveList({ kind: "response", requestId: "list", ok: true, result: {
    evidence: { sessionId, items: [collecting, older], hasMore: true, nextCursor: "older-cursor" } satisfies BridgeEvidencePage,
  } });
  await listResponse;
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
