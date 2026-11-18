import { INITIAL_STATE, type MobileBridgeState } from "./bridge/bridge-reducers.js";
import { createBridgeStore, type BridgeMutableStore } from "./bridge/useMobileBridgeStore.js";

// Synthetic transports in these suites implement only the members their scenario calls.
export type HarnessStore = {
  [K in keyof BridgeMutableStore]: K extends "setState" ? BridgeMutableStore[K] : { current: any };
};

export function createBridgeTestStore(harness: {
  state: MobileBridgeState | undefined;
  commitStateImmediately?: boolean;
}) {
  const state = harness.state ??= { ...INITIAL_STATE };
  const store = createBridgeStore(state, update => {
    harness.state = typeof update === "function" ? update(harness.state!) : update;
    if (harness.commitStateImmediately !== false) store.stateRef.current = harness.state;
  });
  return { state, store };
}
