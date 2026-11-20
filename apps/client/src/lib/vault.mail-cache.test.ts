import { BridgeCrypto, type BridgeMailCache, type EncryptedEnvelope } from "@bridge/protocol";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BridgeVault } from "./vault.js";

let vault: BridgeVault;

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  vault = new BridgeVault();
});

afterEach(async () => {
  await vault.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
}

async function pairHost(hostId: string, roomId = hostId): Promise<BridgeCrypto> {
  return vault.importPairing((await BridgeCrypto.createDevicePairing({
    hostId, roomId, pairingEpoch: 1,
    relayUrl: "ws://127.0.0.1:1/ws", desktopName: hostId,
  })).pairing);
}

function mailCache(seqs: number[], marker = "PRIVATE_MAIL_CACHE_MARKER"): BridgeMailCache {
  return {
    changeToken: `change-${marker}`,
    nextCursor: "0",
    workspace: {
      capabilities: ["plugin.assistant-mail.v1", "plugin.assistant-mail.manual-reference.v1"],
      assistantMail: { bindingState: "ready", receiverState: "disabled", changeToken: marker, automaticDelivery: false,
        binding: { assistantId: marker, nativeSessionId: `native-${marker}`, sectionId: null, previousSessionIds: [] } },
    },
    cards: seqs.map(seq => ({
      seq,
      mailRefId: `mail-${seq}`,
      accountKey: "test-account",
      mailbox: "INBOX",
      subject: `${marker} ${seq}`,
      from: [{ name: marker, address: "sender@example.invalid" }],
      receivedAt: "2026-11-14T00:00:00.000Z",
      recordedAt: seq,
      preview: marker,
      processingStatus: "pending",
      nativeDelivery: { state: "not-submitted" },
    })),
  };
}

it("restores mail cards and cursor directly after more than 150 ordinary envelopes", async () => {
  const crypto = await pairHost("mail-ring-host");
  const cache = mailCache(Array.from({ length: 180 }, (_, index) => 180 - index));
  await vault.saveMailCache(crypto, cache);
  const startTime = Date.now();
  for (let index = 0; index < 170; index++) {
    await vault.saveMessage(await crypto.encrypt({
      kind: "response", requestId: `ordinary-${index}`, ok: true, result: {},
    }, "mobile", "desktop", startTime + index));
  }

  const reopened = new BridgeVault();
  const restoredHost = await reopened.getHost(crypto.identity.roomId);
  expect(await reopened.listMessages(crypto.identity.roomId)).toHaveLength(150);
  expect(await reopened.listMessages(crypto.identity.roomId, 120)).toHaveLength(120);
  expect(await reopened.loadMailCache(restoredHost!.crypto)).toEqual(cache);
});

it("restores local mail after eight offline days without applying the transport TTL", async () => {
  const crypto = await pairHost("mail-offline-week");
  const cache = mailCache([1]);
  await vault.saveMailCache(crypto, cache);
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 8 * 24 * 60 * 60 * 1_000);

  expect(await new BridgeVault().loadMailCache(crypto)).toEqual(cache);
});

it("stores only an encrypted envelope for each room without plaintext mail in IndexedDB", async () => {
  const crypto = await pairHost("mail-private-host");
  const cache = mailCache([3, 2, 1]);
  await vault.saveMailCache(crypto, cache);

  const database = await requestResult(indexedDB.open("claude-bridge"));
  try {
    expect(database.version).toBe(5);
    const transaction = database.transaction(Array.from(database.objectStoreNames), "readonly");
    const records = await Promise.all(Array.from(database.objectStoreNames, name => (
      requestResult(transaction.objectStore(name).getAll())
    )));
    expect(JSON.stringify(records)).not.toContain("PRIVATE_MAIL_CACHE_MARKER");
    const envelopes = await requestResult(database.transaction("mailCache", "readonly").objectStore("mailCache").getAll()) as EncryptedEnvelope[];
    expect(envelopes).toEqual([expect.objectContaining({ roomId: crypto.identity.roomId, ciphertext: expect.any(String) })]);
    expect((await crypto.decrypt(envelopes[0]!)).payload).toEqual({
      kind: "response", requestId: "assistant-mail-cache", ok: true,
      result: { assistantMailCache: cache },
    });
  } finally {
    database.close();
  }
});

it("bounds storage to the newest 200 sequences and resumes from the last retained card", async () => {
  const crypto = await pairHost("mail-bounded-host");
  const cache = mailCache(Array.from({ length: 205 }, (_, index) => index + 1));
  await vault.saveMailCache(crypto, cache);

  expect(await vault.loadMailCache(crypto)).toEqual({
    ...cache,
    cards: [...cache.cards].reverse().slice(0, 200),
    nextCursor: "6",
  });
  expect(cache.cards.map(card => card.seq)).toEqual(Array.from({ length: 205 }, (_, index) => index + 1));

  const empty: BridgeMailCache = { changeToken: "empty", cards: [] };
  await vault.saveMailCache(crypto, empty);
  expect(await vault.loadMailCache(crypto)).toEqual(empty);
  const database = await requestResult(indexedDB.open("claude-bridge"));
  try {
    expect(await requestResult(database.transaction("mailCache", "readonly").objectStore("mailCache").count())).toBe(1);
  } finally {
    database.close();
  }
});

it("keeps the receipt-order cursor and unread baseline when capping an encrypted cache", async () => {
  const crypto = await pairHost("mail-receipt-boundary");
  const cache = { ...mailCache(Array.from({ length: 201 }, (_, index) => index + 1)), order: "received" as const, latestArrivalSeq: 201 };
  cache.cards[0] = { ...cache.cards[0]!, seq: -1, receivedAt: "2026-11-15T00:00:00.000Z" };
  await vault.saveMailCache(crypto, cache);

  expect(await vault.loadMailCache(crypto)).toEqual({
    ...cache, cards: [cache.cards[0], ...cache.cards.slice(2).reverse()], nextCursor: "3",
  });
});

it("isolates host caches and forgets only the selected host", async () => {
  const first = await pairHost("mail-first-host");
  const second = await pairHost("mail-second-host");
  const firstCache = mailCache([7, 6], "FIRST_HOST_MAIL");
  const secondCache = mailCache([4, 3], "SECOND_HOST_MAIL");
  expect(await vault.loadMailCache(first)).toBeUndefined();
  await vault.saveMailCache(first, firstCache);
  await vault.saveMailCache(second, secondCache);
  expect(await new BridgeVault().loadMailCache(first)).toEqual(firstCache);
  expect(await new BridgeVault().loadMailCache(second)).toEqual(secondCache);

  await vault.removeHost(first.identity.roomId);
  expect(await vault.loadMailCache(first)).toBeUndefined();
  expect(await vault.getHost(first.identity.roomId)).toBeUndefined();
  expect(await vault.loadMailCache(second)).toEqual(secondCache);
});

it("removes mail cache only when the forgotten device owns its envelope", async () => {
  const crypto = await pairHost("mail-device-host");
  const other = await pairHost("mail-other-host");
  const cache = mailCache([3, 2]);
  await vault.saveMailCache(crypto, cache);
  await vault.saveMailCache(other, cache);
  const provisional = await BridgeCrypto.fromPairing((await BridgeCrypto.createDevicePairing({
    hostId: crypto.identity.hostId!, roomId: crypto.identity.roomId, pairingEpoch: 1,
    relayUrl: "ws://127.0.0.1:1/ws", desktopName: "Provisional",
  })).pairing);

  await vault.removeDeviceArtifacts(crypto.identity.roomId, provisional.identity.deviceId);
  expect(await vault.loadMailCache(crypto)).toEqual(cache);
  await vault.saveMailCache(provisional, cache);
  await vault.removeDeviceArtifacts(crypto.identity.roomId, crypto.identity.deviceId);
  expect(await vault.loadMailCache(provisional)).toEqual(cache);
  await vault.removeDeviceArtifacts(crypto.identity.roomId, provisional.identity.deviceId);
  expect(await vault.loadMailCache(provisional)).toBeUndefined();
  expect(await vault.loadMailCache(other)).toEqual(cache);
});

it.each(["mail-old-room", "mail-replacement-room"])("discards stale cache when replacement pairing uses %s", async replacementRoom => {
  const previous = await pairHost("mail-repair-host", "mail-old-room");
  const other = await pairHost("mail-unrelated-host");
  const cache = mailCache([9, 8]);
  await vault.saveMailCache(previous, cache);
  await vault.saveMailCache(other, cache);

  const replacement = await pairHost("mail-repair-host", replacementRoom);
  expect(await vault.loadMailCache(previous)).toBeUndefined();
  expect(await vault.loadMailCache(replacement)).toBeUndefined();
  expect(await vault.loadMailCache(other)).toEqual(cache);
  const database = await requestResult(indexedDB.open("claude-bridge"));
  try {
    expect(await requestResult(database.transaction("mailCache", "readonly").objectStore("mailCache").getAllKeys())).toEqual([other.identity.roomId]);
  } finally {
    database.close();
  }
});

it("adds mail cache during a version 4 upgrade without losing ordinary ciphertext", async () => {
  const pairing = await BridgeCrypto.createDevicePairing({
    hostId: "mail-upgrade-host", roomId: "mail-upgrade-room", pairingEpoch: 1,
    relayUrl: "ws://127.0.0.1:1/ws", desktopName: "Upgrade",
  });
  const crypto = await BridgeCrypto.fromPairing(pairing.pairing);
  const envelope = await crypto.encrypt({ kind: "response", requestId: "existing", ok: true, result: {} }, "mobile", "desktop");
  const request = indexedDB.open("claude-bridge", 4);
  request.addEventListener("upgradeneeded", () => {
    request.result.createObjectStore("identity", { keyPath: "key" });
    request.result.createObjectStore("messages", { keyPath: "id" });
    request.result.createObjectStore("outbox", { keyPath: "id" });
  });
  const database = await requestResult(request);
  const transaction = database.transaction("messages", "readwrite");
  transaction.objectStore("messages").put({ id: envelope.id, envelope });
  await new Promise<void>((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("abort", () => reject(transaction.error));
  });
  database.close();

  const cache = mailCache([2, 1]);
  await vault.saveMailCache(crypto, cache);
  expect(await vault.loadMailCache(crypto)).toEqual(cache);
  expect(await vault.listMessages(crypto.identity.roomId)).toEqual([envelope]);
});

it("clears encrypted mail caches with the rest of the vault", async () => {
  const first = await pairHost("mail-clear-first");
  const second = await pairHost("mail-clear-second");
  await vault.saveMailCache(first, mailCache([2]));
  await vault.saveMailCache(second, mailCache([1]));
  await vault.clear();
  expect(await vault.loadMailCache(first)).toBeUndefined();
  expect(await vault.loadMailCache(second)).toBeUndefined();
});
