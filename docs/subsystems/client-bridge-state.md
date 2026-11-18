# Subsystem: Client Bridge State & Vault

## Owned Paths
- `apps/client/src/hooks/` (including `hooks/bridge/`)
- `apps/client/src/lib/` (excluding `conversation-timeline.ts`)

## Responsibilities
- Drives the client-side encrypted session, pairing, outbox, event-resume (`events.resume`), and WebRTC/Relay connection state machine (`useMobileBridge.ts`).
- Applies pure snapshot and turn reducers (`bridge-reducers.ts`) for native queued/steered/rekeyed/cancelled message deliveries, permission lifecycles, and snapshot rebasing.
- Manages chunked artifact downloads/previews and file uploads (`bridge-artifacts.ts`, `artifact-download.ts`, `file-upload.ts`).
- Persists per-host E2EE keys, compressed snapshots, paginated history caches, drafts, and pending outbox envelopes in IndexedDB/localStorage (`vault.ts`).

## Critical Invariants
1. **Renderer-free `useMobileBridge` suites**: The startup, commands, host-sync and permission suites (`useMobileBridge.*.test.ts`) call `useMobileBridge()` under a mocked `react` without a renderer. Their `useRef` mock wraps every ref in `captureBridgeStoreRef` (`useMobileBridge.test-harness.ts`), which picks out the `BridgeMutableStore` when an object holding `stateRef` and `pendingResponsesRef` is assigned to a ref's `.current`, so hook position does not matter. The store must keep reaching its ref by assignment (`storeRef.current ??= { ... }`); a store passed as `useRef`'s initial value is never captured. These mocks implement only `useState`, `useRef`, `useCallback` and `useEffect`, and route every `useState` call into one `MobileBridgeState` slot; the startup suite runs each registered effect once in declaration order and the others drop effects. A second `useState`, or any other React hook in `useMobileBridge.ts`, needs those four mocks updated in the same change. `diagnostics-state-gauges.test.tsx` captures the store the same way inside its slot-based renderer.
2. **Decrypted-message online proof & proxy-drift guard**: Never mark a host `connected` from unauthenticated Relay presence alone — require a valid decrypted envelope from the host. `relayLinkAllowsSend` must block outbound sends on a foreign relay when the host's `homeRelayUrl` is known and the desktop is not present there.
3. **Atomic replacement pairing**: `vault.ts` and `confirmedPairingSnapshot` must never overwrite or delete an existing paired host identity until the new pairing's encrypted `snapshot.get` response matches the expected `hostId` and `pairingEpoch`.
4. **Per-host / per-session draft isolation & no legacy auto-resend**: Drafts and attachments stay strictly scoped to `(hostId, sessionId)`. Cached legacy `bridgeExecutionRequested` entries must never be automatically resent.

## Minimum Verification
```bash
npm run ci:run -- test -w @bridge/client
npm run typecheck
npm run test:browser
```
