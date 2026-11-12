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
1. **`useRef` / hook declaration order in `useMobileBridge.ts`**: `useMobileBridge.*.test.ts` (`useMobileBridge.startup.test.ts`, `useMobileBridge.host-sync.test.ts`, `useMobileBridge.permission.test.ts`, `useMobileBridge.commands.test.ts`, etc.) mock React hooks with an index-addressed array harness (`harness.refs[0].current = harness.state`, `harness.effects[...]`) without a full React renderer. **Do not reorder existing `useState` / `useRef` / `useEffect` calls at the top of `useMobileBridge.ts`**; place new pure logic in `hooks/bridge/*.ts` or append refs carefully while running the full `@bridge/client` suite.
2. **Decrypted-message online proof & proxy-drift guard**: Never mark a host `connected` from unauthenticated Relay presence alone — require a valid decrypted envelope from the host. `relayLinkAllowsSend` must block outbound sends on a foreign relay when the host's `homeRelayUrl` is known and the desktop is not present there.
3. **Atomic replacement pairing**: `vault.ts` and `confirmedPairingSnapshot` must never overwrite or delete an existing paired host identity until the new pairing's encrypted `snapshot.get` response matches the expected `hostId` and `pairingEpoch`.
4. **Per-host / per-session draft isolation & no legacy auto-resend**: Drafts and attachments stay strictly scoped to `(hostId, sessionId)`. Cached legacy `bridgeExecutionRequested` entries must never be automatically resent.

## Minimum Verification
```bash
npm run ci:run -- test -w @bridge/client
npm run typecheck
npm run test:browser
```
