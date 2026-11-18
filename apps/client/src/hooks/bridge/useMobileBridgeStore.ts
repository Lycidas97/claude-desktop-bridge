import type { BridgeTransport } from "@bridge/protocol";
import { useRef, useState, type MutableRefObject } from "react";
import { INITIAL_STATE, type MobileBridgeState } from "./bridge-reducers.js";
import type { BridgeTransportRefs } from "./bridge-transport.js";

export interface BridgeMutableStore extends BridgeTransportRefs {
  openedSessionRef: MutableRefObject<string | undefined>;
  handledCommandEvents: MutableRefObject<Set<string>>;
  openingSessionsRef: MutableRefObject<Map<string, { socket: BridgeTransport | undefined; task: Promise<void> }>>;
  loadingHistoryRef: MutableRefObject<Map<string, BridgeTransport | undefined>>;
  transferGaugesRef: MutableRefObject<{ activeUploads: number; activeDownloads: number }>;
}

export function createBridgeStore(state: MobileBridgeState, setState: BridgeTransportRefs["setState"]): BridgeMutableStore {
  return {
    setState,
    stateRef: { current: state },
    cryptoRef: { current: undefined },
    cryptoByRoomRef: { current: new Map() },
    socketRef: { current: undefined },
    connectionTimerRef: { current: undefined },
    pairingSyncTimerRef: { current: undefined },
    pendingResponsesRef: { current: new Map() },
    envelopeRequestsRef: { current: new Map() },
    desktopHomeRef: { current: undefined },
    linkGateRef: { current: () => true },
    sendAttemptedAtRef: { current: undefined },
    nativeRelayCapabilityRef: { current: undefined },
    payloadDeflateRef: { current: false },
    pendingCompletionNotificationsRef: { current: new Set() },
    openedSessionRef: { current: undefined },
    handledCommandEvents: { current: new Set() },
    openingSessionsRef: { current: new Map() },
    loadingHistoryRef: { current: new Map() },
    transferGaugesRef: { current: { activeUploads: 0, activeDownloads: 0 } },
  };
}

export function useMobileBridgeStore() {
  const [state, setState] = useState(INITIAL_STATE);
  const storeRef = useRef<BridgeMutableStore | undefined>(undefined);
  const store = storeRef.current ??= createBridgeStore(state, setState);
  store.setState = setState;
  store.stateRef.current = state;
  return { state, store };
}
