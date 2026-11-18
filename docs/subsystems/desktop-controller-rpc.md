# Subsystem: Desktop Controller, RPC & Host Transport

## Owned Paths
- `apps/desktop/src/controller/`
- `apps/desktop/src/transport/`

## Responsibilities
- Coordinates `DesktopController` runtime state, full `BridgeHostSnapshot` publication, Desktop Sections/project grouping, and capability advertisement.
- Routes incoming mobile and local desktop RPC requests (`controller-rpc.ts`) across session lifecycle, native messaging/queue actions, permissions, directory browsing/mkdir, evidence transfers, and `@bridge/plugin-magpie-quota`.
- Persists command idempotency keys and delivery receipts in SQLite (`conversation-state-store.ts`) and append-only replay events with monotonic `seq` and delta coalescing in `session-event-log.ts`.
- Manages host identity keys (`config.ts`), QR pairing claims, device revocation, Relay presence reconciliation, and native WebRTC peer connections (`controller-transport.ts`, `webrtc-runtime.ts`).

## Critical Invariants
1. **Controller test setup**: `createControllerFixture` (`controller-fixture.ts`) is the default entry point for controller tests and the Native browser fixture; tests invoke real `DesktopController` methods on the instances it builds. Two suites, `controller-assistant-mail.test.ts` and `controller-diagnostics.test.ts`, still construct `new DesktopController(...)` directly. Supply path-specific dependencies, including the optional updater or memory recorder through the constructor when needed. Service transport tests that only exercise the IPC boundary can use a minimal `ServiceController` fake. Use `initialize()` only in scenarios that exercise startup.
2. **Retired RPC methods stay `UNSUPPORTED`**: Legacy multi-agent and lane endpoints (`provider.list`, `conversation.route.get`, `runtime.handoff.*`, `runtime.goal.*`, `runtime.file.open`, `permission.policy.configure`) must deterministically return `UNSUPPORTED` (`windows-native-qa-contract.test.mjs` asserts this).
3. **End-to-end pairing & revocation**: Record `pairedAt` only after decrypting the mobile device's `snapshot.get` request. Intersect Relay `ready/presence` device IDs with non-revoked local device keys and immediately emit `device-revoke` for stale Relay presences.
4. **No legacy state import**: Never import pre-1.3 `sessions-v2.json` or `turn-queue-v2.json`, and never use `SessionEventLog` as a fallback source for Claude conversation history.

## Minimum Verification
```bash
npm run ci:run -- test -w @bridge/desktop
npm run test:infra
npm run test:browser
```
