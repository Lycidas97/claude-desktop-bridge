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
1. **Mobile Bridge state test assembly**: `useMobileBridgeStore` owns the React state and stable transport store. The renderer-free startup, command, host-sync and permission suites mock that named hook and use `createBridgeTestStore`, which shares `createBridgeStore` with production. The startup suite runs registered effects; the other three omit them. Host-sync cases can defer committing updates to `stateRef` to exercise requests and events that arrive before a render. `diagnostics-state-gauges.test.tsx` wraps the real `useMobileBridgeStore` in its test renderer and seeds the explicitly returned store. None of these suites identifies the store by the position, field names, or assignment behavior of a React ref or state slot.
2. **Decrypted-message online proof & proxy-drift guard**: Never mark a host `connected` from unauthenticated Relay presence alone — require a valid decrypted envelope from the host. `relayLinkAllowsSend` must block outbound sends on a foreign relay when the host's `homeRelayUrl` is known and the desktop is not present there.
3. **Atomic replacement pairing**: `vault.ts` and `confirmedPairingSnapshot` must never overwrite or delete an existing paired host identity until the new pairing's encrypted `snapshot.get` response matches the expected `hostId` and `pairingEpoch`.
4. **Per-host / per-session draft isolation & no legacy auto-resend**: Drafts and attachments stay strictly scoped to `(hostId, sessionId)`. Cached legacy `bridgeExecutionRequested` entries must never be automatically resent.

## Review Checks for Evidence Loading
- Apply the same freshness rule on desktop and mobile. In both entry points, hold an older `evidence.list` response until after a newer live event for the same bundle and verify the newer summary survives with the response's pagination intact.

## Minimum Verification
```bash
npm run ci:run -- test -w @bridge/client
npm run typecheck
npm run test:browser
```
