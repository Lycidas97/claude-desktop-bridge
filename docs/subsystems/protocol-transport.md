# Subsystem: Protocol & Transport

## Owned Paths
- `packages/protocol/src/`
  - Crypto & encoding: `crypto.ts`, `encoding.ts`, `socket.ts`
  - Transports & endpoints: `transport.ts`, `relay-transport.ts`, `webrtc-transport.ts`, `endpoints.ts`, `ice.ts`
  - Wire contracts & validation: `types.ts`, `validation.ts`, `evidence.ts`, `transcript.ts`, `desktop-ipc.ts`, `index.ts`

## Responsibilities
- Defines Protocol V3 wire envelopes, RPC request/response/event schemas, Pairing Bundle V4 structures, and capability identifiers (`*.v1`).
- Implements per-device AES-256-GCM end-to-end encryption (`BridgeCrypto`), compression, and 64 KiB transport chunking with full-payload SHA-256 reassembly verification.
- Implements `BridgeTransport` multiplexing across public WSS Relay, LAN WS candidates, and peer-to-peer WebRTC DataChannels (`WebRtcTransport`).
- Owns `desktop-ipc.ts`, the shared TypeScript contract between Electron `preload.ts` (`window.bridgeDesktop`) and the `apps/client` desktop renderer.

## Critical Invariants
1. **Encrypt-before-chunk, verify-before-ACK**: Large envelopes are compressed and AES-256-GCM encrypted *before* 64 KiB framing splits them. Receivers send final delivery ACKs only after reassembling all chunks, verifying the SHA-256 digest, and decrypting the envelope.
2. **Protocol V3 & Pairing V4 stability**: Reject legacy V0.3 pairing bundles while preserving existing V4 host/device keys and `pairingEpoch` across upgrades without forced re-pairing.
3. **WebRTC signaling & seamless fallback**: SDP/ICE signaling rides inside E2EE envelopes over Relay WSS (Relay never sees candidate IPs). `WebRtcTransport` races direct ICE connection within a 5s window using explicit ICE servers (`ice.ts` — never derived from Relay or `serviceOrigin` hostnames). If the DataChannel drops, unacknowledged outbox envelopes fall back to Relay WSS with the **same envelope ID** so commands never execute twice.
4. **Build ordering**: Other workspaces import `@bridge/protocol` build outputs in production/CI builds (`npm run build -w @bridge/protocol` must precede downstream bundle/APK/installer builds).
5. **Capability flags**: Whenever adding a new RPC method or optional parameter in `types.ts` that older hosts might not implement, gate client invocation behind an explicit `host.capabilities` token and add the token to synthetic fixtures in `scripts/browser-e2e.mjs` and `scripts/windows-native-qa-contract.test.mjs`.

## Minimum Verification
```bash
npm run ci:run -- run build -w @bridge/protocol
npm run ci:run -- test -w @bridge/protocol
npm run typecheck
```
