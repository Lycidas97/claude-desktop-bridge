import { BridgeCrypto, type BridgePayload } from "@bridge/protocol";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import { expect, it, vi } from "vitest";
import { BridgeVault } from "./vault.js";

it("restores compressed history and outbox without rewriting their encrypted envelopes", async () => {
  vi.stubGlobal("indexedDB", indexedDB);
  vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  const vault = new BridgeVault();
  try {
    const paired = await BridgeCrypto.createDevicePairing({ roomId: "synthetic-compressed-cache", relayUrl: "ws://127.0.0.1:1/ws", desktopName: "Synthetic" });
    const mobile = await vault.importPairing(paired.pairing);
    const outbound: BridgePayload = { kind: "request", requestId: "offline-request", idempotencyKey: "same-key", method: "turn.start", params: { sessionId: "synthetic-session", text: "离线发送 😀\n".repeat(1000) } };
    const incoming: BridgePayload = { kind: "event", event: { eventId: "history-event", seq: 73, timestamp: Date.now(), origin: "system", type: "assistant.delta", sessionId: "synthetic-session", data: { text: "历史内容 😀\n".repeat(1000) } } };
    const request = await mobile.encrypt(outbound, "mobile", "desktop", Date.now(), undefined, undefined, undefined, true);
    const history = await paired.desktopCrypto.encrypt(incoming, "desktop", "mobile", Date.now(), undefined, mobile.identity.deviceId, undefined, true);
    expect(request.ciphertext.length).toBeLessThan(1000);
    expect(history.ciphertext.length).toBeLessThan(1000);
    await vault.saveMessage(request);
    await vault.addOutbox(request);
    await vault.saveMessage(history);

    const reopened = new BridgeVault();
    const host = await reopened.getHost(mobile.identity.roomId);
    expect(host).toBeDefined();
    expect(await reopened.listOutbox(mobile.identity.roomId)).toEqual([request]);
    const messages = await reopened.listMessages(mobile.identity.roomId);
    expect(messages).toEqual(expect.arrayContaining([request, history]));
    expect((await host!.crypto.decrypt(messages.find(value => value.id === history.id)!)).payload).toEqual(incoming);
    expect((await host!.crypto.decrypt((await reopened.listOutbox(mobile.identity.roomId))[0]!)).payload).toEqual(outbound);
  } finally {
    await vault.clear();
    vi.unstubAllGlobals();
  }
});
