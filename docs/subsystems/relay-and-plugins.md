# Subsystem: Relay Server & Quota Plugin

## Owned Paths
- `apps/relay/src/`
- `plugins/magpie-quota/`

## Responsibilities
- `apps/relay`: Zero-plaintext WebSocket relay providing one-time pairing credential claims, device-targeted ciphertext routing, SQLite WAL 7-day offline queues (`sqlite-store.ts`), 64 KiB chunk forwarding, device revocation, metrics/backups, and body-free Android FCM push wakeups (`push.ts`).
- `plugins/magpie-quota` (`@bridge/plugin-magpie-quota`): Standalone plugin querying Magpie gateway quota/window usage on Desktop (`desktop.ts`) and rendering compact quota cards on Desktop and Mobile (`client.tsx`, `presentation.ts`).

## Critical Invariants
1. **Zero-plaintext Relay**: `apps/relay` sees only routing headers (`hostId`, `toDeviceId`, envelope IDs, TTL/ephemeral flags) and opaque ciphertext. Never log, inspect, or transmit session IDs, message previews, or credentials in Relay frames or push payloads (`bridge-wake` carries zero message body).
2. **Ephemeral vs. queued envelopes**: Ephemeral artifact transfer frames (10-minute TTL) bypass the 7-day SQLite offline queue so large binary previews never bloat `sqlite-store.ts`.
3. **Plugin workspace boundary**: `plugins/magpie-quota` sits outside npm `workspaces` (`apps/*`, `packages/*`) by design. Root `npm test` (`scripts/test.mjs`) and `npm run typecheck` run it explicitly (`quota` suite and `npm --prefix plugins/magpie-quota run typecheck`), whereas `-ws` workspace-only commands skip it. Always run explicit plugin checks when editing `plugins/magpie-quota/`.
4. **No duplicate quota surfaces**: Keep Magpie quota presentation consolidated in its designated Settings/Quota surfaces without duplicating redundant quota widgets across unrelated settings tabs.
5. **Android push registration & historical records**: New push registrations accept only Android. Retain readable historical iOS device records without a schema migration, but never pass their tokens to FCM; only `pushPlatform === "android"` is eligible for dispatch.

## Minimum Verification
```bash
npm run ci:run -- test -w @bridge/relay
npm run ci:run -- --prefix plugins/magpie-quota test
npm run typecheck
npm run probe:relay
```
