import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket, { WebSocketServer } from "ws";
import type { DesktopController } from "./controller.js";
import type { BridgeEvent, DesktopControlSnapshot } from "@bridge/protocol";
import { ServiceResources } from "./service-resources.js";

export const SERVICE_PROTOCOL = 1;
export const SERVICE_METHODS = [
  "snapshot", "createPairing", "revokeDevice", "setRelayUrl", "setLaunchAtLogin",
  "setAnthropicApiKey", "removeAnthropicApiKey", "launchClaudeDesktop", "quitClaudeDesktop",
  "launchDesktopApp", "quitDesktopApp", "dispatchLocal", "diagnostics", "refreshRuntime",
] as const;
export type ServiceMethod = typeof SERVICE_METHODS[number];
export type ServiceController = Pick<DesktopController, ServiceMethod | "on" | "off">;
type Arguments<M extends ServiceMethod> = Parameters<ServiceController[M]>;
type Result<M extends ServiceMethod> = Awaited<ReturnType<ServiceController[M]>>;
interface ServiceAddress { port: number; token: string; protocol: number }

/** One controller owns all runtime state; closing a UI socket only drops its subscription. */
export async function serveDesktopService(options: {
  addressPath: string;
  controller: ServiceController;
  shutdown(): void;
}): Promise<{ close(): Promise<void> }> {
  const resources = new ServiceResources();
  const token = randomBytes(32).toString("hex");
  const server = createServer((_request, response) => { response.writeHead(404); response.end(); });
  resources.defer("Local HTTP listener", () => {
    if (!server.listening) return;
    return new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
  resources.defer("Local WebSocket listener", () => {
    for (const client of sockets.clients) client.terminate();
    return new Promise<void>((resolve, reject) => sockets.close((error) => error ? reject(error) : resolve()));
  });
  try {
    server.on("upgrade", (request, socket, head) => {
      if (request.headers.authorization !== `Bearer ${token}` || request.headers.origin) {
        socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        return;
      }
      sockets.handleUpgrade(request, socket, head, (client) => sockets.emit("connection", client));
    });
    sockets.on("connection", (client) => {
      client.on("error", (error) => {
        process.stderr.write(`Bridge local service connection failed: ${error.stack ?? error.message}\n`);
        client.terminate();
      });
      client.send(JSON.stringify({ kind: "hello", protocol: SERVICE_PROTOCOL, pid: process.pid }));
      client.on("message", (data) => {
        void (async () => {
          let id: number | undefined;
          try {
            const request = JSON.parse(data.toString()) as { id?: unknown; method?: unknown; args?: unknown };
            if (typeof request.id !== "number" || !Number.isSafeInteger(request.id)) throw new Error("Invalid request id");
            id = request.id;
            if (!Array.isArray(request.args)) throw new Error("Invalid request arguments");
            if (request.method === "shutdown") {
              if (request.args.length) throw new Error("Unexpected shutdown arguments");
              client.send(JSON.stringify({ kind: "response", id, result: null }), () => options.shutdown());
              return;
            }
            if (!SERVICE_METHODS.includes(request.method as ServiceMethod)) throw new Error("Unknown service method");
            const method = request.method as ServiceMethod;
            const args = request.args;
            if (["setRelayUrl", "revokeDevice", "setAnthropicApiKey"].includes(method)) {
              if (args.length !== 1 || typeof args[0] !== "string") throw new Error("Expected one string");
            } else if (method === "setLaunchAtLogin") {
              if (args.length !== 1 || typeof args[0] !== "boolean") throw new Error("Expected one boolean");
            } else if (method === "launchDesktopApp" || method === "quitDesktopApp") {
              if (args.length !== 1 || !["claude-desktop", "codex-desktop", "hermes-desktop", "dsh-desktop"].includes(args[0])) throw new Error("Unknown Desktop runtime");
            } else if (method === "dispatchLocal") {
              if (args.length !== 1 || !args[0] || typeof args[0] !== "object" || typeof args[0].method !== "string" ||
                (args[0].params !== undefined && (!args[0].params || typeof args[0].params !== "object" || Array.isArray(args[0].params))) ||
                (args[0].idempotencyKey !== undefined && typeof args[0].idempotencyKey !== "string")) throw new Error("Invalid local request");
            } else if (args.length) throw new Error("Unexpected arguments");
            const action = options.controller[method] as (...values: unknown[]) => unknown;
            const result = await action.apply(options.controller, args);
            if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ kind: "response", id, result }));
          } catch (error) {
            if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ kind: "response", id, error: error instanceof Error ? error.message : String(error) }));
          }
        })();
      });
    });
    const broadcast = (kind: string, value: unknown) => {
      const message = JSON.stringify({ kind, value });
      for (const client of sockets.clients) if (client.readyState === WebSocket.OPEN) client.send(message);
    };
    const snapshot = (value: unknown) => broadcast("snapshot", value);
    const event = (value: unknown) => broadcast("event", value);
    resources.defer("Controller subscriptions", () => {
      options.controller.off("snapshot", snapshot);
      options.controller.off("event", event);
    });
    options.controller.on("snapshot", snapshot);
    options.controller.on("event", event);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Service address unavailable");
    await mkdir(dirname(options.addressPath), { recursive: true, mode: 0o700 });
    const temporaryAddressPath = `${options.addressPath}.${process.pid}.tmp`;
    await writeFile(temporaryAddressPath, JSON.stringify({ port: address.port, token, protocol: SERVICE_PROTOCOL }), { mode: 0o600 });
    await rename(temporaryAddressPath, options.addressPath);
    return { close: () => resources.close() };
  } catch (error) {
    return resources.fail(error);
  }
}

export class DesktopServiceClient extends EventEmitter {
  private socket: WebSocket | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private lastSeq: number | undefined;
  private replaying = false;
  private readonly bufferedEvents: BridgeEvent[] = [];
  private bufferedSnapshot: DesktopControlSnapshot | undefined;
  servicePid: number | undefined;

  constructor(private readonly addressPath: string) { super(); }

  async connect(): Promise<void> {
    const address = JSON.parse(await readFile(this.addressPath, "utf8")) as ServiceAddress;
    if (this.closed) throw new Error("后台服务连接已关闭");
    if (address.protocol !== SERVICE_PROTOCOL) throw new Error("后台服务版本不兼容，请在任务结束后停止后台服务再打开 Bridge。");
    if (!Number.isInteger(address.port) || address.port < 1 || address.port > 65535 || typeof address.token !== "string") throw new Error("Invalid service address");
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}`, { headers: { Authorization: `Bearer ${address.token}` }, handshakeTimeout: 5_000, maxPayload: 32 * 1024 * 1024 });
    // Own the socket during the handshake too, so close() can cancel it.
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { reject(new Error("后台服务连接超时")); socket.terminate(); }, 5_000);
      let ready = false;
      socket.on("error", (error) => {
        if (!ready) { clearTimeout(timeout); socket.terminate(); reject(error); }
      });
      socket.on("message", (data) => {
        if (this.closed) return;
        const message = JSON.parse(data.toString());
        if (message.kind === "hello") {
          clearTimeout(timeout);
          if (message.protocol !== SERVICE_PROTOCOL) { reject(new Error("Incompatible service protocol")); socket.close(); return; }
          ready = true;
          this.servicePid = message.pid;
          resolve();
        } else if (message.kind === "response") {
          const pending = this.pending.get(message.id);
          this.pending.delete(message.id);
          if (message.error) pending?.reject(new Error(message.error));
          else pending?.resolve(message.result);
        } else if (message.kind === "event") {
          if (this.replaying) this.bufferedEvents.push(message.value);
          else this.deliverEvent(message.value);
        } else if (message.kind === "snapshot") {
          if (this.replaying) this.bufferedSnapshot = message.value;
          else this.emit("snapshot", message.value);
        }
      });
      socket.on("close", () => {
        clearTimeout(timeout);
        if (this.socket === socket) this.socket = undefined;
        if (!ready) { reject(new Error("后台服务连接关闭")); return; }
        for (const pending of this.pending.values()) pending.reject(new Error("后台连接已断开，操作结果可能尚未返回，请重新同步。"));
        this.pending.clear();
        if (!this.closed) {
          this.emit("disconnected");
          this.scheduleReconnect();
        }
      });
    });
  }

  private deliverEvent(event: BridgeEvent): void {
    if (this.lastSeq !== undefined && event.seq <= this.lastSeq) return;
    this.lastSeq = event.seq;
    this.emit("event", event);
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.replaying = true;
      void this.connect().then(async () => {
        if (this.lastSeq !== undefined) {
          let hasMore = true;
          let afterSeq = this.lastSeq;
          while (hasMore) {
            const response = await this.call("dispatchLocal", { method: "events.resume", params: { afterSeq, limit: 250 } });
            if (!response.ok) throw new Error(response.error?.message ?? "Event replay failed");
            const page = response.result as { events: BridgeEvent[]; nextSeq: number; hasMore: boolean };
            for (const event of page.events) this.deliverEvent(event);
            afterSeq = page.nextSeq;
            hasMore = page.hasMore;
          }
        }
        // Pushes before this request are covered by the requested snapshot.
        this.bufferedSnapshot = undefined;
        const snapshot = await this.call("snapshot");
        if (this.closed) return;
        for (const event of this.bufferedEvents.splice(0).sort((a, b) => a.seq - b.seq)) this.deliverEvent(event);
        this.replaying = false;
        this.emit("snapshot", this.bufferedSnapshot ?? snapshot);
        this.bufferedSnapshot = undefined;
      }).catch(() => {
        this.replaying = false;
        this.bufferedEvents.length = 0;
        this.bufferedSnapshot = undefined;
        if (this.closed) return;
        this.socket?.terminate();
        this.scheduleReconnect();
      });
    }, 1_000);
  }

  async call<M extends ServiceMethod>(method: M, ...args: Arguments<M>): Promise<Result<M>> {
    const result = await this.request(method, args) as Result<M>;
    if (method === "snapshot" && this.lastSeq === undefined) this.lastSeq = (result as Result<"snapshot">).latestSeq;
    return result;
  }

  shutdown(): Promise<void> { return this.request("shutdown", []) as Promise<void>; }

  private request(method: string, args: unknown[]): Promise<unknown> {
    if (this.closed || this.socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error("后台服务未连接"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket!.send(JSON.stringify({ id, method, args }), (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  /** Detach the window; this deliberately does not stop the service or its tasks. */
  close(): void {
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    this.socket?.terminate();
  }
}

/** Only an absent listener authorizes starting a service; auth/version/timeouts do not. */
export async function connectDesktopService(
  addressPath: string,
  launch: () => void | Promise<void>,
  options: { signal?: AbortSignal; onStage?(stage: string): void } = {},
): Promise<DesktopServiceClient> {
  const client = new DesktopServiceClient(addressPath);
  const abort = () => client.close();
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    options.signal?.throwIfAborted();
    options.onStage?.("连接本机后台服务");
    try { await client.connect(); return client; } catch (error) {
      options.signal?.throwIfAborted();
      if (!["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
    options.onStage?.("启动后台服务进程");
    await launch();
    const deadline = Date.now() + 30_000;
    while (true) {
      options.signal?.throwIfAborted();
      try { await client.connect(); return client; } catch (error) {
        options.signal?.throwIfAborted();
        if (!["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "") || Date.now() >= deadline) throw error;
      }
      await delay(200, undefined, { signal: options.signal });
    }
  } catch (error) {
    if (!options.signal?.aborted) client.close();
    throw options.signal?.aborted ? options.signal.reason : error;
  } finally {
    options.signal?.removeEventListener("abort", abort);
  }
}
