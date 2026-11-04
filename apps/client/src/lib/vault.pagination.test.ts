import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import { expect, it, vi } from "vitest";
import type { EncryptedEnvelope } from "@bridge/protocol";
import { BridgeVault } from "./vault.js";

it("reads only the newest requested records for this host", async () => {
  vi.stubGlobal("indexedDB", indexedDB);
  vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  const vault = new BridgeVault();
  for (let index = 0; index < 30; index++) {
    await vault.saveMessage({ id: `event-${index}`, roomId: index % 2 ? "A" : "B", sentAt: index } as EncryptedEnvelope);
  }
  const messages = await vault.listMessages("A", 4);
  expect(messages.map((x) => x.sentAt)).toEqual([23, 25, 27, 29]);
});

it("retains the newest progress sequence through concurrent writes, duplicates, and reopening", async () => {
  vi.stubGlobal("indexedDB", indexedDB);
  vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  const vault = new BridgeVault();
  const envelope = (id: string, sentAt: number) => ({ id, roomId: "progress-order-host", sentAt }) as EncryptedEnvelope;
  await vault.saveMessage(envelope("progress-10", 10), { key: "progress-order", seq: 10 });
  await Promise.all([
    vault.saveMessage(envelope("progress-12", 12), { key: "progress-order", seq: 12 }),
    vault.saveMessage(envelope("progress-11", 13), { key: "progress-order", seq: 11 }),
    vault.saveMessage(envelope("duplicate-12", 14), { key: "progress-order", seq: 12 }),
  ]);
  expect((await new BridgeVault().listMessages("progress-order-host")).map(message => message.id)).toEqual(["progress-12"]);
  await vault.saveMessage(envelope("sibling-progress", 15), { key: "sibling-progress-order", seq: 1 });
  expect((await vault.listMessages("progress-order-host")).map(message => message.id)).toEqual(["progress-12", "sibling-progress"]);
});
