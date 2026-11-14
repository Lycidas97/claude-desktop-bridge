import { expect, test } from "vitest";
import { BridgeCrypto, type BridgeResponse } from "./index.js";

test("passive observer reports existing UTF8 encoding before compression without changing decryption", async () => {
  const { crypto } = await BridgeCrypto.createDesktop("ws://localhost:8788/ws", "Fixture");
  const payload: BridgeResponse = { kind: "response", requestId: "fixture", ok: true, result: { text: "中".repeat(2000) } };
  let observed = 0;
  BridgeCrypto.observeEncodedPayload = (value, bytes) => { expect(value).toBe(payload); observed = bytes; };
  try {
    const encrypted = await crypto.encrypt(payload, "desktop", "mobile", Date.now(), undefined, undefined, undefined, true);
    expect(observed).toBe(new TextEncoder().encode(JSON.stringify(payload)).byteLength);
    expect((await crypto.decrypt(encrypted)).payload).toEqual(payload);
  } finally { BridgeCrypto.observeEncodedPayload = undefined; }
});
