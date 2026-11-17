import type { BridgeMutableStore } from "./useMobileBridge.js";

// These refs identify the store passed to bridge transport, regardless of hook position.
export function captureBridgeStoreRef<T>(initial: T, onStore: (store: BridgeMutableStore) => void): { current: T } {
  let current = initial;
  return {
    get current() { return current; },
    set current(value: T) {
      current = value;
      if (typeof value === "object" && value !== null && "stateRef" in value && "pendingResponsesRef" in value) {
        onStore(value as unknown as BridgeMutableStore);
      }
    },
  };
}
