import { IDBFactory } from "fake-indexeddb";
import { afterEach, expect, it, vi } from "vitest";
import clientPackage from "../../package.json";
import {
  BUILD_DIAG_TAG,
  buildDiagnosticReportText,
  clearDiagEntries,
  collectDiagnosticsStateSnapshot,
  collectRendererDiagnosticsSnapshot,
  diagLog,
  getDiagEntries,
  inspectIndexedDbSummary,
  registerDiagnosticsStateProvider,
  runRelayConnectivityProbe,
} from "./diagnostics.js";
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

it("probes the BIS relay health and WebSocket subpath by default", async () => {
  clearDiagEntries();
  const fetchUrls: string[] = [];
  const wsUrls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    fetchUrls.push(String(input));
    return { type: "opaque", status: 0 } as Response;
  }));
  class StubWebSocket extends EventTarget {
    readyState = 1;
    constructor(url: string | URL) {
      super();
      wsUrls.push(String(url));
      queueMicrotask(() => this.dispatchEvent(new Event("open")));
    }
    close(): void {}
  }
  vi.stubGlobal("WebSocket", StubWebSocket);

  await runRelayConnectivityProbe();

  expect(fetchUrls).toEqual(["https://bis.zju.edu.cn/bridge-relay/health"]);
  expect(wsUrls).toEqual(["wss://bis.zju.edu.cn/bridge-relay/ws"]);
  expect(getDiagEntries().some((entry) => entry.message.includes("https://bis.zju.edu.cn/bridge-relay/health"))).toBe(true);
});

it("pulls state gauges lazily without idle timers, guards against stale disposers, and strips non-numeric secrets", async () => {
  const intervalSpy = vi.spyOn(globalThis, "setInterval");
  const collectFirst = vi.fn(() => ({
    count: 3,
    active: true,
    connection: "connected",
    secretTitle: "SECRET_SESSION_TITLE",
    secretPath: "/Users/secret/file.ts",
    secretList: ["SECRET_ITEM"],
    nested: {
      bytes: 1024,
      leakedDraft: "SECRET_DRAFT_BODY",
    },
  }));
  const disposeFirst = registerDiagnosticsStateProvider("testOwner", collectFirst);
  expect(collectFirst).not.toHaveBeenCalled();
  expect(intervalSpy).not.toHaveBeenCalled();

  const stateSnapshot = collectDiagnosticsStateSnapshot();
  expect(collectFirst).toHaveBeenCalledOnce();
  expect(stateSnapshot.testOwner).toEqual({
    count: 3,
    active: true,
    connection: "connected",
    nested: { bytes: 1024 },
  });
  expect(JSON.stringify(stateSnapshot)).not.toMatch(/SECRET_SESSION_TITLE|\/Users\/secret|SECRET_ITEM|SECRET_DRAFT_BODY/);

  const collectSecond = vi.fn(() => ({ count: 9 }));
  const disposeSecond = registerDiagnosticsStateProvider("testOwner", collectSecond);
  // Stale disposer from an earlier mount must not delete a newer registration.
  disposeFirst();
  expect(collectDiagnosticsStateSnapshot().testOwner).toEqual({ count: 9 });

  disposeSecond();
  expect(collectDiagnosticsStateSnapshot()).not.toHaveProperty("testOwner");
});

it("captures renderer JS heap metrics and includes stateGauges in both structured snapshot and report text", async () => {
  clearDiagEntries();
  diagLog("warn", "net", "synthetic warning", undefined, true);
  diagLog("error", "ws", "synthetic failure", undefined, true);
  vi.stubGlobal("performance", {
    memory: {
      usedJSHeapSize: 12_345_678,
      totalJSHeapSize: 23_456_789,
      jsHeapSizeLimit: 2_147_483_648,
    },
  });
  const dispose = registerDiagnosticsStateProvider("customGauge", () => ({
    bufferedItems: 42,
    uploading: false,
  }));
  try {
    const desktopFixture = {
      host: { name: "Fixture Mac", online: true },
      connection: "connected",
      latestSeq: 19,
      runtime: { state: "ready" },
      transport: { path: "direct", rttMs: 3 },
    } as DesktopControlSnapshot;
    const structured = await collectRendererDiagnosticsSnapshot(desktopFixture);
    expect(structured).toMatchObject({
      schemaVersion: 1,
      buildTag: BUILD_DIAG_TAG,
      rendererMemory: {
        usedJSHeapSize: 12_345_678,
        totalJSHeapSize: 23_456_789,
        jsHeapSizeLimit: 2_147_483_648,
      },
      stateGauges: expect.objectContaining({
        customGauge: { bufferedItems: 42, uploading: false },
      }),
      eventLog: {
        count: 2,
        warnCount: 1,
        errorCount: 1,
      },
    });
    expect(structured).not.toHaveProperty("indexedDb");

    const report = await buildDiagnosticReportText(desktopFixture);
    expect(report).toContain('"rendererMemory"');
    expect(report).toContain('"usedJSHeapSize": 12345678');
    expect(report).toContain('"customGauge"');
    expect(report).toContain('"bufferedItems": 42');
  } finally {
    dispose();
    clearDiagEntries();
  }
});
