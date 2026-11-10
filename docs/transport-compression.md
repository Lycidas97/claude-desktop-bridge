# Transport compression

Bridge can compress a message body before AES-GCM encryption. The outer protocol remains V3; pairing, authenticated header fields, message IDs, event sequence numbers, attachment bytes, acknowledgements and replay retain their existing formats.

## Body encoding

The default body remains the original UTF-8 `JSON.stringify(payload)` bytes. A sender may use the new body only after the recipient declares `payload.deflate.v1`:

```text
0x01 || CompressionStream("deflate") output
```

`deflate` means the zlib-wrapped format, not raw DEFLATE. Each message uses a new stream. Bodies of at least 1,024 UTF-8 bytes are candidates; the compressed bytes plus their one-byte marker must be strictly smaller than the original JSON. Otherwise the sender retains the old bytes. AES-GCM authenticates the entire body before the receiver checks the marker and inflates it. Invalid bodies fail directly.

`BridgeCrypto.encrypt()` defaults to the old body. Its final `compress` argument, and transport `SendOptions.compress`, are explicit opt-ins for callers that already know the recipient's capability. `sendEnvelope()` forwards existing ciphertext without recompressing or generating a different ID/nonce.

Desktop advertises support in `snapshot.host.capabilities`; mobile advertises it in request `params.client.capabilities`. Support is advertised only when both native stream constructors accept `deflate`. Capability state is learned from the connection, not restored from cached host state. In 1.3, catalog bootstrap uses `snapshot.get`; all such requests/responses, including cached responses, retain the old body. Broadcasts before a device declares support also retain JSON. Later updates and requests can compress for capable recipients. Unadvertised and old recipients keep receiving JSON bodies.

New receivers read both formats, including saved encrypted messages and outbox entries. Downgrading an endpoint to a version that cannot read compressed messages already queued or cached is outside this compatibility guarantee. Replay preserves those original envelopes. The existing 80 ms text merge window is unchanged.

BridgeSocket preserves arrival order during asynchronous encrypted-frame processing, chunk assembly, decryption and inflation; WebRTC does the same per peer. This does not guarantee global event-sequence delivery order: while a sender waits for chunk-query acknowledgements, a later small event from another runtime can arrive first. Mobile permission projection separately uses the snapshot sequence and each request's lifecycle to accept unseen delayed permission events newer than the snapshot baseline, without reviving requests resolved by newer events. Control frames retain their existing immediate handling.

## Relay WebSocket compression

The Relay enables negotiated `permessage-deflate` with `server_no_context_takeover`, `client_no_context_takeover`, level 6 for its own compressor, and a 1,024-byte WebSocket-message threshold. This threshold measures the outer serialized frame, independently of the plaintext-body threshold. The existing `ws` zlib concurrency limit remains unchanged. No-context resets streams between messages; allocations can remain until connection cleanup.

Set `BRIDGE_RELAY_PERMESSAGE_DEFLATE=0` to disable it, or pass `perMessageDeflate: false` to `startRelayServer()`. Clients without the extension continue to work. HTTP gzip does not compress WebSocket frames. Browser negotiation and client compression settings belong to the runtime: extension negotiation alone does not establish that upstream frames are compressed. Node 26's global WebSocket negotiated the extension but sent uncompressed upstream frames in local measurements; Node `ws` compressed both directions.

PMD adds zlib CPU and memory costs while recovering the Base64/JSON overhead around encrypted data. Native codec and protocol checks also pass in the cached Electron 43.1.1 / Node 24.18.0 engine with `ELECTRON_RUN_AS_NODE=1`, without launching Bridge. Synthetic loopback measurements do not establish Android/iOS behavior, installed Desktop application integration, low-end Linux server capacity, or WSS proxy behavior. Deployment can use the disable switch if those runtime costs are unacceptable.

## Regression coverage

- Protocol compression tests cover exact Unicode bytes, legacy bodies, 1,023/1,024/1,025-byte boundaries, only-smaller selection, unavailable codecs and authentication before inflation.
- Controller/mobile tests cover declarations, initial and cached bootstrap formats, old devices, and connection resets. Native codec regressions cover a large earlier permission event followed by a small event from another session, verifying receive order and the retained mobile permission card.
- Relay tests cover compressed history and high-entropy attachment chunks, a missing chunk, duplicate sends, temporary messages, offline replay and exact ACK identities.
- WebRTC tests cover compressed direct delivery, fallback with the same envelope and ACK fallback. Vault tests reopen compressed message/outbox storage without changing ciphertext.

Run validation through `npm run ci:run` so Node cleanup uses the system recycle bin.
