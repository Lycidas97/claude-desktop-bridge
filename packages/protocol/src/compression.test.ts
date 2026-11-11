import { afterEach, describe, expect, it, vi } from "vitest";
import { inflateSync } from "node:zlib";
import {
  BridgeCrypto, BridgeSocket, fromBase64Url, serializeHeader, utf8,
  type BridgeEvent, type BridgePayload, type EncryptedEnvelope,
} from "./index.js";

async function body(crypto: BridgeCrypto, envelope: EncryptedEnvelope): Promise<Uint8Array> {
  const { nonce, ciphertext, ...header } = envelope;
  return new Uint8Array(await globalThis.crypto.subtle.decrypt({
    name: "AES-GCM", iv: fromBase64Url(nonce), additionalData: serializeHeader(header), tagLength: 128,
  }, crypto.encryptionKey, fromBase64Url(ciphertext)));
}

const payload: BridgePayload = {
  kind: "request", requestId: "synthetic-request", idempotencyKey: "synthetic-idempotency",
  method: "turn.start", params: { sessionId: "synthetic-session", text: "中文 😀\n".repeat(400) },
};

afterEach(() => vi.unstubAllGlobals());

describe("authenticated payload deflate", () => {
  it.each([false, true])("delivers ordered frames before later events even when inflation is asynchronous (compress=%s)", async compress => {
    const paired = await BridgeCrypto.createDevicePairing({ roomId: "ordering", relayUrl: "ws://127.0.0.1:1/ws", desktopName: "Synthetic", deviceId: "phone" });
    const phone = await BridgeCrypto.fromPairing(paired.pairing);
    const events: BridgeEvent[] = [
      { eventId: "permission", seq: 1, timestamp: Date.now(), origin: "system", type: "permission.requested", sessionId: "session-A",
        data: { requestId: "permission-A", toolUseId: "tool-A", toolName: "Edit", input: { new_string: "document content\n".repeat(200) } } },
      { eventId: "unrelated-delta", seq: 2, timestamp: Date.now(), origin: "system", type: "assistant.delta", sessionId: "session-B", data: { text: "next" } },
    ];
    const frames: string[] = [];
    for (const event of events) {
      const envelope = await paired.desktopCrypto.withSenderDevice("desktop").encrypt({ kind: "event", event }, "desktop", "mobile", Date.now(), undefined, "phone", true, compress);
      frames.push(JSON.stringify({ type: "envelope", envelope }));
    }
    const received: number[] = [];
    const receiver = new BridgeSocket({ crypto: phone, role: "mobile", reconnect: false });
    receiver.onMessage(message => { if (message.payload.kind === "event") received.push(message.payload.event.seq); });
    await Promise.all(frames.map(raw => (receiver as unknown as { handleMessage(raw: string): Promise<void> }).handleMessage(raw)));
    expect(received).toEqual([1, 2]);
  });

  it.each(["missing", "unsupported"])("keeps old-format sending when native codec support is %s", async mode => {
    vi.resetModules();
    vi.stubGlobal("CompressionStream", mode === "missing" ? undefined : class {
      constructor() { throw new TypeError("Unsupported format"); }
    });
    const module = await import("./crypto.js");
    expect(module.PAYLOAD_DEFLATE_SUPPORTED).toBe(false);
    const { crypto: desktop } = await module.BridgeCrypto.createDesktop("ws://localhost:1/ws", "Synthetic");
    const envelope = await desktop.encrypt(payload, "desktop", "mobile", Date.now(), undefined, undefined, undefined, true);
    expect(JSON.parse(new TextDecoder().decode(await body(desktop, envelope)))).toEqual(payload);
    vi.resetModules();
  });

  it("encodes 0x01 + zlib deflate and restores the exact JSON bytes", async () => {
    const { crypto: desktop, pairing } = await BridgeCrypto.createDesktop("ws://localhost:1/ws", "Synthetic");
    const mobile = await BridgeCrypto.fromPairing(pairing);
    const envelope = await desktop.encrypt(payload, "desktop", "mobile", Date.now(), undefined, undefined, undefined, true);
    const plaintext = await body(desktop, envelope);
    expect(plaintext[0]).toBe(1);
    expect(plaintext.length).toBeLessThan(utf8(JSON.stringify(payload)).length);
    expect(inflateSync(plaintext.subarray(1))).toEqual(Buffer.from(JSON.stringify(payload)));
    expect((await mobile.decrypt(envelope)).payload).toEqual(payload);
  });

  it("keeps the default legacy body directly JSON.parse compatible", async () => {
    const { crypto: desktop, pairing } = await BridgeCrypto.createDesktop("ws://localhost:1/ws", "Synthetic");
    const mobile = await BridgeCrypto.fromPairing(pairing);
    const envelope = await desktop.encrypt(payload, "desktop", "mobile");
    expect(JSON.parse(new TextDecoder().decode(await body(desktop, envelope)))).toEqual(payload);
    expect((await mobile.decrypt(envelope)).payload).toEqual(payload);
  });

  it.each([1023, 1024, 1025])("uses UTF-8 byte threshold for a %i-byte payload", async (size) => {
    const { crypto: desktop } = await BridgeCrypto.createDesktop("ws://localhost:1/ws", "Synthetic");
    const candidate = { kind: "response", requestId: "threshold", ok: true, result: { text: "" } } satisfies BridgePayload;
    candidate.result.text = "中".repeat(100) + "x".repeat(size - utf8(JSON.stringify(candidate)).length - 300);
    expect(utf8(JSON.stringify(candidate))).toHaveLength(size);
    const envelope = await desktop.encrypt(candidate, "desktop", "mobile", Date.now(), undefined, undefined, undefined, true);
    expect((await body(desktop, envelope))[0]).toBe(size < 1024 ? 123 : 1);
  });

  it("counts the prefix and keeps JSON when compression is not smaller", async () => {
    const { crypto: desktop } = await BridgeCrypto.createDesktop("ws://localhost:1/ws", "Synthetic");
    // A deterministic stream boundary yielding unchanged bytes makes the candidate one byte larger.
    vi.stubGlobal("CompressionStream", class extends TransformStream {
      constructor() { super({ transform(chunk, controller) { controller.enqueue(chunk); } }); }
    });
    const envelope = await desktop.encrypt(payload, "desktop", "mobile", Date.now(), undefined, undefined, undefined, true);
    expect(await body(desktop, envelope)).toEqual(utf8(JSON.stringify(payload)));
  });

  it("does not invoke the decompressor when GCM authentication fails", async () => {
    const { crypto: desktop, pairing } = await BridgeCrypto.createDesktop("ws://localhost:1/ws", "Synthetic");
    const mobile = await BridgeCrypto.fromPairing(pairing);
    const envelope = await desktop.encrypt(payload, "desktop", "mobile", Date.now(), undefined, undefined, undefined, true);
    const decompress = vi.fn(() => { throw new Error("Unauthenticated inflate"); });
    vi.stubGlobal("DecompressionStream", decompress);
    await expect(mobile.decrypt({ ...envelope, sentAt: envelope.sentAt + 1 })).rejects.toThrow();
    expect(decompress).not.toHaveBeenCalled();
  });
});
