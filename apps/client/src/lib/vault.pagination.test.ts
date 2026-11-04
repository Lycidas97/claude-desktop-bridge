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
