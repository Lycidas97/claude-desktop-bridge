import { IDBFactory } from "fake-indexeddb";
import { afterEach, expect, it, vi } from "vitest";
import clientPackage from "../../package.json";
import { BUILD_DIAG_TAG, inspectIndexedDbSummary } from "./diagnostics.js";

afterEach(() => vi.unstubAllGlobals());

it("inspects an existing v4 vault without downgrading, clearing messages, or clearing outbox", async () => {
  const indexedDB = new IDBFactory();
  vi.stubGlobal("indexedDB", indexedDB);
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("claude-bridge", 4);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("identity", { keyPath: "key" });
      request.result.createObjectStore("messages", { keyPath: "id" });
      request.result.createObjectStore("outbox", { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction(["identity", "messages", "outbox"], "readwrite");
    tx.objectStore("identity").put({ key: "host:synthetic", identity: { roomId: "synthetic", hostId: "host", deviceId: "phone", version: 4 } });
    tx.objectStore("messages").put({ id: "message" });
    tx.objectStore("outbox").put({ id: "outgoing" });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  database.close();
  const summary = await inspectIndexedDbSummary();
  expect(summary).toMatchObject({ version: 4, messagesCount: 1, outboxCount: 1, identities: [expect.objectContaining({ roomId: "synthetic", deviceId: "phone" })] });
  expect(summary).not.toHaveProperty("error");
  expect(await inspectIndexedDbSummary()).toEqual(summary);
});

it("reports the package version rather than a stale hard-coded diagnostic tag", () => {
  expect(BUILD_DIAG_TAG).toBe(`v${clientPackage.version}`);
});
