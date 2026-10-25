import { Capacitor } from "@capacitor/core";
import { useEffect, useState } from "react";

export interface DiagnosticLogEntry {
  seq: number;
  at: number;
  level: "info" | "warn" | "error";
  tag: string;
  message: string;
  detail?: string | undefined;
}

const MAX_LOG_ENTRIES = 400;
const DIAG_ENABLED_STORAGE_KEY = "bridge.mobile.diag.enabled.v1";
export const BUILD_DIAG_TAG = "v1.0.2";
const DEFAULT_DIAG_RELAY_URL = String(
  import.meta.env.VITE_BRIDGE_PUBLIC_RELAY_URL ?? "wss://relay.alioxis.com/ws",
).trim();
const DEFAULT_DIAG_SERVICE_ORIGIN = String(
  import.meta.env.VITE_BRIDGE_SERVICE_ORIGIN ?? "https://relay.alioxis.com",
).trim();

let nextSeq = 1;
const entries: DiagnosticLogEntry[] = [];
const listeners = new Set<() => void>();
let installed = false;
let latestBridgeStateSummary: Record<string, unknown> = {};
let dialogOpen = false;
let diagEnabled = (() => {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(DIAG_ENABLED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
})();

function notify(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // Ignore listener errors.
    }
  }
}

export function isDiagEnabled(): boolean {
  return diagEnabled;
}

export function setDiagEnabled(enabled: boolean): void {
  if (diagEnabled === enabled) return;
  if (!enabled) {
    diagLog("info", "diag", "已停止按需诊断记录", undefined, true);
  }
  diagEnabled = enabled;
  try {
    if (typeof localStorage !== "undefined") {
      if (enabled) localStorage.setItem(DIAG_ENABLED_STORAGE_KEY, "true");
      else localStorage.removeItem(DIAG_ENABLED_STORAGE_KEY);
    }
  } catch {
    // Ignore storage errors.
  }
  if (enabled) {
    diagLog("info", "diag", `已开启按需诊断记录 (${BUILD_DIAG_TAG})`, {
      onLine: typeof navigator !== "undefined" ? navigator.onLine : undefined,
      visibility: typeof document !== "undefined" ? document.visibilityState : undefined,
    }, true);
  }
  notify();
}

export function isDiagDialogOpen(): boolean {
  return dialogOpen;
}

export function setDiagDialogOpen(open: boolean): void {
  if (dialogOpen === open) return;
  dialogOpen = open;
  notify();
}

function safeJson(value: unknown, maxLen = 600): string {
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (!text) return "";
    return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
  } catch {
    return String(value);
  }
}

export function diagLog(
  level: DiagnosticLogEntry["level"],
  tag: string,
  message: string,
  detail?: unknown,
  force = false,
): void {
  if (!diagEnabled && !force) return;
  const entry: DiagnosticLogEntry = {
    seq: nextSeq++,
    at: Date.now(),
    level,
    tag,
    message,
    ...(detail !== undefined ? { detail: safeJson(detail) } : {}),
  };
  entries.push(entry);
  if (entries.length > MAX_LOG_ENTRIES) {
    entries.splice(0, entries.length - MAX_LOG_ENTRIES);
  }
  notify();
}

export function setDiagBridgeStateSummary(summary: Record<string, unknown>): void {
  latestBridgeStateSummary = summary;
  if (diagEnabled || dialogOpen) notify();
}

export function getDiagEntries(): readonly DiagnosticLogEntry[] {
  return entries;
}

export function clearDiagEntries(): void {
  entries.length = 0;
  notify();
}

function summarizeClientWsFrame(raw: unknown): string {
  if (typeof raw !== "string") return `binary(${String(raw)})`;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const type = String(parsed.type ?? "unknown");
    if (type === "hello") {
      return JSON.stringify({
        type,
        version: parsed.version,
        roomId: parsed.roomId,
        role: parsed.role,
        deviceId: parsed.deviceId,
        instanceId: parsed.instanceId,
      });
    }
    if (type === "ack") {
      return JSON.stringify({ type, count: Array.isArray(parsed.ids) ? parsed.ids.length : 0, ids: parsed.ids });
    }
    if (type === "envelope") {
      const env = (parsed.envelope ?? {}) as Record<string, unknown>;
      return JSON.stringify({
        type,
        id: env.id,
        from: env.from,
        to: env.to,
        sentAt: env.sentAt,
        temporary: env.temporary,
      });
    }
    if (type === "envelope-chunk") {
      const chunk = (parsed.chunk ?? {}) as Record<string, unknown>;
      return JSON.stringify({
        type,
        transferId: chunk.transferId,
        index: chunk.index,
        total: chunk.total,
      });
    }
    return JSON.stringify({ type });
  } catch {
    return `raw(len=${raw.length})`;
  }
}

function summarizeServerWsFrame(raw: unknown): string {
  if (typeof raw !== "string") return `binary`;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const type = String(parsed.type ?? "unknown");
    if (type === "ready") {
      return JSON.stringify({
        type,
        roomId: parsed.roomId,
        onlineDevices: parsed.onlineDevices,
      });
    }
    if (type === "presence") {
      return JSON.stringify({
        type,
        role: parsed.role,
        deviceId: parsed.deviceId,
        online: parsed.online,
      });
    }
    if (type === "error") {
      return JSON.stringify({
        type,
        code: parsed.code,
        message: parsed.message,
        envelopeId: parsed.envelopeId,
      });
    }
    if (type === "stored" || type === "acknowledged") {
      return JSON.stringify({
        type,
        ids: parsed.ids,
      });
    }
    if (type === "envelope") {
      const env = (parsed.envelope ?? {}) as Record<string, unknown>;
      return JSON.stringify({
        type,
        id: env.id,
        from: env.from,
        fromDeviceId: env.fromDeviceId,
        sentAt: env.sentAt,
        ageMs: typeof env.sentAt === "number" ? Date.now() - env.sentAt : undefined,
      });
    }
    if (type === "envelope-chunk") {
      const chunk = (parsed.chunk ?? {}) as Record<string, unknown>;
      return JSON.stringify({
        type,
        transferId: chunk.transferId,
        index: chunk.index,
        total: chunk.total,
        sentAt: chunk.sentAt,
        ageMs: typeof chunk.sentAt === "number" ? Date.now() - chunk.sentAt : undefined,
      });
    }
    return JSON.stringify({ type });
  } catch {
    return `raw(len=${raw.length})`;
  }
}

let wsCounter = 0;

function installWebSocketMonitor(): void {
  if (typeof window === "undefined" || typeof window.WebSocket !== "function") return;
  const NativeWebSocket = window.WebSocket;
  const WrappedWebSocket = function (
    this: WebSocket,
    url: string | URL,
    protocols?: string | string[],
  ): WebSocket {
    const id = ++wsCounter;
    const urlStr = String(url);
    const openedAt = Date.now();
    diagLog("info", `ws#${id}`, `new WebSocket(${urlStr})`);
    let ws: WebSocket;
    try {
      ws = protocols !== undefined
        ? new NativeWebSocket(url, protocols)
        : new NativeWebSocket(url);
    } catch (error) {
      diagLog("error", `ws#${id}`, `WebSocket 构造异常: ${urlStr}`, error instanceof Error ? error.message : String(error));
      throw error;
    }

    const origSend = ws.send.bind(ws);
    ws.send = (data: string | ArrayBufferLike | Blob | ArrayBufferView) => {
      if (diagEnabled) {
        diagLog("info", `ws#${id}`, `-> send`, summarizeClientWsFrame(data));
      }
      return origSend(data);
    };

    ws.addEventListener("open", () => {
      if (diagEnabled) {
        diagLog("info", `ws#${id}`, `<- open (${Date.now() - openedAt}ms) ${urlStr}`);
      }
    });
    ws.addEventListener("message", (event) => {
      if (diagEnabled) {
        diagLog("info", `ws#${id}`, `<- recv`, summarizeServerWsFrame(event.data));
      }
    });
    ws.addEventListener("error", () => {
      if (diagEnabled) {
        diagLog("error", `ws#${id}`, `<- error (${Date.now() - openedAt}ms) ${urlStr} readyState=${ws.readyState}`);
      }
    });
    ws.addEventListener("close", (event) => {
      if (diagEnabled) {
        diagLog(
          event.code === 1000 ? "info" : "warn",
          `ws#${id}`,
          `<- close code=${event.code} reason=${event.reason || "(none)"} clean=${event.wasClean} (${Date.now() - openedAt}ms)`,
        );
      }
    });
    return ws;
  } as unknown as typeof WebSocket;

  Object.defineProperties(WrappedWebSocket, {
    CONNECTING: { value: NativeWebSocket.CONNECTING },
    OPEN: { value: NativeWebSocket.OPEN },
    CLOSING: { value: NativeWebSocket.CLOSING },
    CLOSED: { value: NativeWebSocket.CLOSED },
    prototype: { value: NativeWebSocket.prototype },
  });
  window.WebSocket = WrappedWebSocket;
}

export function installDiagnostics(): void {
  if (installed) return;
  installed = true;

  if (diagEnabled) {
    diagLog("info", "boot", `Bridge 客户端启动 (${BUILD_DIAG_TAG})`, {
      href: typeof window !== "undefined" ? window.location.href : "",
      platform: Capacitor.getPlatform(),
      isNative: Capacitor.isNativePlatform(),
      onLine: typeof navigator !== "undefined" ? navigator.onLine : undefined,
      visibility: typeof document !== "undefined" ? document.visibilityState : undefined,
      ua: typeof navigator !== "undefined" ? navigator.userAgent : "",
    });
  }

  installWebSocketMonitor();

  if (typeof window !== "undefined") {
    window.addEventListener("error", (event) => {
      if (!diagEnabled) return;
      diagLog("error", "window.error", event.message || "Uncaught error", {
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
      });
    });
    window.addEventListener("unhandledrejection", (event) => {
      if (!diagEnabled) return;
      const reason = event.reason;
      diagLog(
        "error",
        "unhandledrejection",
        reason instanceof Error ? reason.message : String(reason),
        reason instanceof Error ? reason.stack : undefined,
      );
    });
    window.addEventListener("online", () => diagLog("info", "net", "浏览器触发 online 事件"));
    window.addEventListener("offline", () => diagLog("warn", "net", "浏览器触发 offline 事件"));

    const origError = console.error.bind(console);
    console.error = (...args: unknown[]) => {
      if (diagEnabled) {
        diagLog("error", "console.error", args.map((a) => safeJson(a, 200)).join(" "));
      }
      origError(...args);
    };
    const origWarn = console.warn.bind(console);
    console.warn = (...args: unknown[]) => {
      if (diagEnabled) {
        diagLog("warn", "console.warn", args.map((a) => safeJson(a, 200)).join(" "));
      }
      origWarn(...args);
    };
  }
}

export async function runRelayConnectivityProbe(
  relayWsUrl = DEFAULT_DIAG_RELAY_URL,
): Promise<void> {
  const healthUrl = relayWsUrl
    .replace(/^wss:/iu, "https:")
    .replace(/^ws:/iu, "http:")
    .replace(/\/ws\/?$/iu, "/health");
  diagLog("info", "probe", `开始探测中继连通性: ${healthUrl} & ${relayWsUrl}`, undefined, true);

  const httpStart = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    const res = await fetch(healthUrl, {
      mode: "no-cors",
      cache: "no-store",
      signal: controller.signal,
    });
    clearTimeout(timer);
    diagLog("info", "probe", `HTTPS /health 可达 (${Date.now() - httpStart}ms) type=${res.type} status=${res.status}`, undefined, true);
  } catch (error) {
    diagLog(
      "error",
      "probe",
      `HTTPS /health 失败 (${Date.now() - httpStart}ms): ${error instanceof Error ? error.message : String(error)}`,
      undefined,
      true,
    );
  }

  const wsStart = Date.now();
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    let ws: WebSocket;
    try {
      ws = new WebSocket(relayWsUrl);
    } catch (error) {
      diagLog("error", "probe", `WebSocket 探测构造失败: ${error instanceof Error ? error.message : String(error)}`, undefined, true);
      finish();
      return;
    }
    const timer = setTimeout(() => {
      if (settled) return;
      diagLog("error", "probe", `WebSocket 探测 8s 超时 (readyState=${ws.readyState})`, undefined, true);
      try { ws.close(); } catch { /* ignore */ }
      finish();
    }, 8_000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      diagLog("info", "probe", `WebSocket 探测握手成功 (${Date.now() - wsStart}ms)`, undefined, true);
      try { ws.close(1000, "probe done"); } catch { /* ignore */ }
      finish();
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      diagLog("error", "probe", `WebSocket 探测触发 error (${Date.now() - wsStart}ms)`, undefined, true);
      finish();
    });
  });
}

export async function inspectIndexedDbSummary(): Promise<Record<string, unknown>> {
  if (typeof indexedDB === "undefined") return { available: false };
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open("claude-bridge", 3);
      req.addEventListener("error", () => {
        resolve({ error: req.error?.message ?? "indexedDB.open failed" });
      });
      req.addEventListener("success", () => {
        const db = req.result;
        const stores = [...db.objectStoreNames];
        if (!stores.includes("identity")) {
          db.close();
          resolve({ stores, identities: [] });
          return;
        }
        const tx = db.transaction(["identity", "messages", "outbox"].filter((s) => stores.includes(s)), "readonly");
        const idReq = tx.objectStore("identity").getAll();
        const msgCountReq = stores.includes("messages") ? tx.objectStore("messages").count() : undefined;
        const outboxCountReq = stores.includes("outbox") ? tx.objectStore("outbox").count() : undefined;
        tx.addEventListener("complete", () => {
          const rawIdentities = Array.isArray(idReq.result) ? idReq.result : [];
          const identities = rawIdentities.map((rec: Record<string, unknown>) => {
            const id = (rec?.identity ?? {}) as Record<string, unknown>;
            return {
              key: rec?.key,
              roomId: id.roomId,
              hostId: id.hostId,
              deviceId: id.deviceId,
              instanceId: id.instanceId,
              version: id.version,
              pairingEpoch: id.pairingEpoch,
              desktopName: id.desktopName,
              identityRelayUrl: id.relayUrl,
              serviceOrigin: rec?.serviceOrigin,
              activeEndpoint: rec?.activeEndpoint,
              desktopRelayUrl: rec?.desktopRelayUrl,
              relayEndpoints: rec?.relayEndpoints,
              updatedAt: rec?.updatedAt,
            };
          });
          db.close();
          resolve({
            stores,
            identities,
            messagesCount: msgCountReq?.result ?? 0,
            outboxCount: outboxCountReq?.result ?? 0,
            lastActiveHost: (() => {
              try { return localStorage.getItem("bridge.mobile.last-active-host.v1"); } catch { return null; }
            })(),
          });
        });
        tx.addEventListener("error", () => {
          db.close();
          resolve({ error: tx.error?.message ?? "tx failed" });
        });
      });
    } catch (error) {
      resolve({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}

export async function repairVaultAndReconnect(
  targetRelayUrl = DEFAULT_DIAG_RELAY_URL,
  targetServiceOrigin = DEFAULT_DIAG_SERVICE_ORIGIN,
): Promise<string> {
  diagLog("info", "repair", `开始执行本地缓存清理与中继路由修复 -> ${targetRelayUrl}`, undefined, true);
  if ("serviceWorker" in navigator) {
    const regs = await navigator.serviceWorker.getRegistrations().catch(() => []);
    await Promise.all(regs.map((r) => r.unregister())).catch(() => undefined);
  }
  if ("caches" in window) {
    const keys = await caches.keys().catch(() => []);
    await Promise.all(keys.map((k) => caches.delete(k))).catch(() => undefined);
  }
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("claude-bridge", 3);
    req.addEventListener("error", () => reject(req.error ?? new Error("无法打开 IndexedDB")));
    req.addEventListener("success", () => {
      const db = req.result;
      const tx = db.transaction(["identity", "messages", "outbox"], "readwrite");
      const idStore = tx.objectStore("identity");
      const msgStore = tx.objectStore("messages");
      const outboxStore = tx.objectStore("outbox");
      msgStore.clear();
      outboxStore.clear();
      const allReq = idStore.getAll();
      let repairedRoomId = "";
      allReq.addEventListener("success", () => {
        const records = Array.isArray(allReq.result) ? allReq.result : [];
        for (const rec of records as Array<Record<string, unknown>>) {
          if (!rec || typeof rec !== "object" || !rec.identity) continue;
          const id = rec.identity as Record<string, unknown>;
          const roomId = typeof id.roomId === "string" ? id.roomId : "";
          if (roomId && !repairedRoomId) repairedRoomId = roomId;
          idStore.put({
            ...rec,
            identity: {
              ...id,
              relayUrl: targetRelayUrl,
            },
            serviceOrigin: targetServiceOrigin,
            relayEndpoints: [
              {
                id: "public",
                kind: "public-relay",
                url: targetRelayUrl,
                priority: 10,
              },
            ],
            activeEndpoint: "public",
            desktopRelayUrl: targetRelayUrl,
            updatedAt: Date.now(),
          });
        }
      });
      tx.addEventListener("complete", () => {
        db.close();
        if (repairedRoomId) {
          try {
            localStorage.setItem("bridge.mobile.last-active-host.v1", repairedRoomId);
          } catch {
            // ignore
          }
        }
        diagLog("info", "repair", `修复完成 (roomId=${repairedRoomId || "none"})，已清空旧缓存消息与发件箱`, undefined, true);
        resolve(repairedRoomId);
      });
      tx.addEventListener("error", () => {
        db.close();
        reject(tx.error ?? new Error("IndexedDB 修复事务失败"));
      });
    });
  });
}

function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export async function buildDiagnosticReportText(): Promise<string> {
  const idbSummary = await inspectIndexedDbSummary();
  const header = {
    generatedAt: new Date().toISOString(),
    buildTag: BUILD_DIAG_TAG,
    diagRecordingEnabled: diagEnabled,
    location: typeof window !== "undefined" ? window.location.href : "",
    platform: Capacitor.getPlatform(),
    isNative: Capacitor.isNativePlatform(),
    onLine: typeof navigator !== "undefined" ? navigator.onLine : undefined,
    visibilityState: typeof document !== "undefined" ? document.visibilityState : undefined,
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
    bridgeState: latestBridgeStateSummary,
    indexedDb: idbSummary,
  };

  const logLines = entries.map((e) => (
    `[${formatTimestamp(e.at)}] #${e.seq} [${e.level.toUpperCase()}] [${e.tag}] ${e.message}${e.detail ? ` | ${e.detail}` : ""}`
  ));

  return [
    "=== Claude Desktop Bridge Mobile Diagnostic Report ===",
    JSON.stringify(header, null, 2),
    "",
    `=== Event Log (${entries.length} entries, on-demand recording: ${diagEnabled ? "ON" : "OFF"}) ===`,
    ...(logLines.length > 0 ? logLines : ["(按需诊断记录当前未开启；点击上方「开启按需记录」后再复现问题即可采集完整事件流)"]),
    "",
  ].join("\n");
}

export function useDiagnosticLogs() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const onUpdate = () => setTick((t) => t + 1);
    listeners.add(onUpdate);
    return () => {
      listeners.delete(onUpdate);
    };
  }, []);
  return {
    entries: getDiagEntries(),
    bridgeState: latestBridgeStateSummary,
    enabled: diagEnabled,
    dialogOpen,
  };
}
