import { IDBFactory } from "fake-indexeddb";
import { afterEach, expect, it, vi } from "vitest";
import clientPackage from "../../package.json";
import { BUILD_DIAG_TAG, buildDiagnosticReportText, inspectIndexedDbSummary } from "./diagnostics.js";
import type { DesktopControlSnapshot } from "@bridge/protocol";

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

it("reports the desktop connection without inspecting the phone vault", async () => {
  const open = vi.fn(() => { throw new Error("phone vault must not be opened"); });
  vi.stubGlobal("indexedDB", { open });
  const report = await buildDiagnosticReportText({
    host: { name: "Fixture Mac", online: true }, connection: "connected", latestSeq: 17,
    runtime: { state: "ready" }, transport: { path: "direct", rttMs: 4 },
  } as DesktopControlSnapshot);
  expect(report).toContain("Bridge Desktop Diagnostic Report");
  expect(report).toContain('"connection": "connected"');
  expect(report).toContain('"desktopName": "Fixture Mac"');
  expect(report).not.toContain("indexedDb");
  expect(open).not.toHaveBeenCalled();
});

it("reports the package version rather than a stale hard-coded diagnostic tag", () => {
  expect(BUILD_DIAG_TAG).toBe(`v${clientPackage.version}`);
});
