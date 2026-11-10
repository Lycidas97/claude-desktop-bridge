import { EventEmitter } from "node:events";

const STREAM = "__claudeBridgeNativeStreamV1";
const METHODS = new Set([
  "getAll", "getSession", "start", "forkSession", "startBtwChild", "updateSession", "archive", "unarchive", "delete",
  "sendMessage", "sendSteeredNow", "promoteQueuedMessage", "cancelQueuedMessage", "interrupt", "stopTask", "setModel", "setEffort",
  "setPermissionMode", "getContextUsage", "getSupportedCommands", "getTranscript", "getTranscriptPage",
  "getTranscriptTail", "respondToToolPermission", "findLocalSessionIdForBridgeId", "getAvailableCodeModels",
  "canRewindTo", "rewindV2", "rewindFiles",
]);

export class NativeCallError extends Error {}
export class InspectorDisconnectedError extends Error {}

export interface NativeDesktopEvent {
  kind: "event" | "permission";
  payload: unknown;
}

interface InspectorReply {
  id?: number;
  result?: { result?: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } };
  error?: { message: string };
}

/** Attaches to an existing Desktop. It never launches Desktop or a Claude CLI. */
export class ClaudeDesktopInspector extends EventEmitter {
  private socket: WebSocket | undefined;
  private nextId = 0;
  private readonly pending = new Map<number, {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer?: ReturnType<typeof setTimeout>;
  }>();
  private webContentsId: number | undefined;
  private receiving: Promise<void> | undefined;
  private methods = new Set<string>();
  ready = false;

  constructor(private readonly options: { origin?: string; fetchImpl?: typeof fetch; rpcTimeoutMs?: number } = {}) {
    super();
  }

  supports(method: string): boolean {
    return METHODS.has(method) && this.methods.has(method);
  }

  async connect(): Promise<void> {
    if (this.ready) return;
    const response = await (this.options.fetchImpl ?? fetch)(`${this.options.origin ?? "http://127.0.0.1:9229"}/json/list`, {
      signal: AbortSignal.timeout(this.options.rpcTimeoutMs ?? 10_000),
    });
    if (!response.ok) throw new Error(`Desktop inspector discovery failed (${response.status})`);
    const targets = await response.json() as Array<{ type: string; webSocketDebuggerUrl?: string }>;
    const target = targets.find(candidate => candidate.type === "node" && candidate.webSocketDebuggerUrl);
    if (!target?.webSocketDebuggerUrl) throw new Error("Claude Desktop Node inspector is unavailable");
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    this.socket = socket;
    socket.addEventListener("message", event => this.receive(JSON.parse(String(event.data)) as InspectorReply));
    socket.addEventListener("close", () => {
      if (this.socket === socket) this.disconnected();
    });
    socket.addEventListener("error", () => {
      if (this.socket === socket) this.disconnected();
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new InspectorDisconnectedError("Desktop inspector connection timed out")); }, this.options.rpcTimeoutMs ?? 10_000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new InspectorDisconnectedError("Desktop inspector connection failed")); }, { once: true });
    });
    try {
      const page = await this.evaluate(`(async () => {
        for (const page of process.mainModule.require('electron').webContents.getAllWebContents()) {
          if (!page.getURL().startsWith('app://localhost/')) continue;
          const methods = await page.executeJavaScript("Object.keys(globalThis['claude.web']?.LocalSessions || {})");
          if (methods.includes('getAll') && methods.includes('onOnEvent')) return { id: page.id, methods };
        }
        throw new Error('Claude Desktop LocalSessions renderer was not found');
      })()`) as { id: number; methods: string[] };
      this.webContentsId = page.id;
      this.methods = new Set(page.methods);
      await this.renderer(`(() => {
        globalThis[${JSON.stringify(STREAM)}]?.dispose();
        const api = globalThis['claude.web'].LocalSessions;
        const queue = [];
        let waiter;
        const emit = (kind, payload) => {
          queue.push({ kind, payload });
          if (waiter) { const resolve = waiter; waiter = undefined; resolve(queue.splice(0)); }
        };
        const stops = [];
        try {
          for (const [method, kind] of [['onOnEvent', 'event'], ['onOnToolPermissionRequest', 'permission']]) {
            const stop = api[method](payload => emit(kind, payload));
            if (typeof stop !== 'function') throw new Error('Desktop subscriptions must return unsubscribe functions');
            stops.push(stop);
          }
        } catch (error) {
          for (const stop of stops) stop();
          throw error;
        }
        globalThis[${JSON.stringify(STREAM)}] = {
          next() { return queue.length ? Promise.resolve(queue.splice(0)) : new Promise(resolve => { waiter = resolve; }); },
          dispose() { for (const stop of stops) stop(); if (waiter) waiter(null); delete globalThis[${JSON.stringify(STREAM)}]; }
        };
        return true;
      })()`);
      this.ready = true;
      this.receiving = this.receiveEvents(socket);
      this.emit("connected");
    } catch (error) {
      this.disconnected();
      socket.close();
      throw error;
    }
  }

  async call(method: string, args: unknown[] = []): Promise<unknown> {
    if (!this.ready) throw new InspectorDisconnectedError("Claude Desktop inspector is disconnected; open the Node inspector from Desktop's developer menu");
    if (!this.supports(method)) throw new NativeCallError(`Unsupported Claude Desktop method: ${method}`);
    return this.renderer(`(() => {
      if (!globalThis[${JSON.stringify(STREAM)}]) throw new Error('BRIDGE_RENDERER_RELOADED');
      return globalThis['claude.web'].LocalSessions[${JSON.stringify(method)}](${Array.from(args, arg => arg === undefined ? "undefined" : JSON.stringify(arg)).join(",")});
    })()`);
  }

  async availableCodeModels(): Promise<string[]> {
    if (!this.ready) throw new InspectorDisconnectedError("Claude Desktop inspector is disconnected");
    return this.renderer(`(async () => {
      if (!globalThis[${JSON.stringify(STREAM)}]) throw new Error('BRIDGE_RENDERER_RELOADED');
      const response = await fetch('/api/bootstrap');
      if (!response.ok) throw new Error('Desktop model catalog request failed (' + response.status + ')');
      const bootstrap = await response.json();
      const surfaces = bootstrap?.model_selector_config;
      const models = Array.isArray(surfaces) ? surfaces.find(surface => surface?.id === 'code')?.models : undefined;
      if (!Array.isArray(models) || !models.every(model => typeof model?.id === 'string' && model.id.length > 0)) throw new Error('Desktop returned an invalid native model catalog');
      return models.map(model => model.id);
    })()`) as Promise<string[]>;
  }

  async close(): Promise<void> {
    const socket = this.socket;
    if (!socket) return;
    this.ready = false;
    try {
      if (socket.readyState === WebSocket.OPEN && this.webContentsId !== undefined) {
        await this.renderer(`globalThis[${JSON.stringify(STREAM)}]?.dispose()`);
      }
    } finally {
      this.disconnected();
      socket.close();
      await this.receiving;
    }
  }

  private async receiveEvents(socket: WebSocket): Promise<void> {
    try {
      while (this.ready && this.socket === socket) {
        const events = await this.renderer(`globalThis[${JSON.stringify(STREAM)}]?.next()`, false) as NativeDesktopEvent[] | null | undefined;
        if (!events) break;
        for (const event of events) this.emit(event.kind, event.payload);
      }
    } catch (error) {
      if (this.socket === socket) this.emit("stream-error", error);
    } finally {
      if (this.socket === socket && this.ready) { this.disconnected(); socket.close(); }
    }
  }

  private async renderer(expression: string, timeout = true): Promise<unknown> {
    // Electron masks rejected executeJavaScript promises; carry native errors across that boundary.
    const wrapped = `(async () => { try { return { ok: true, value: await (${expression}) }; } catch (error) { return { ok: false, error: String(error?.message ?? error) }; } })()`;
    const result = await this.evaluate(`(() => {
      const page = process.mainModule.require('electron').webContents.fromId(${this.webContentsId});
      if (!page) throw new Error('BRIDGE_RENDERER_RELOADED');
      return page.executeJavaScript(${JSON.stringify(wrapped)});
    })()`, timeout) as { ok: boolean; value?: unknown; error?: string };
    if (!result.ok) {
      if (result.error?.includes("BRIDGE_RENDERER_RELOADED")) { const socket = this.socket; this.disconnected(); socket?.close(); }
      throw new NativeCallError(result.error ?? "Desktop renderer call failed");
    }
    return result.value;
  }

  private evaluate(expression: string, timeout = true): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new InspectorDisconnectedError("Desktop inspector disconnected"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = timeout ? setTimeout(() => {
        this.pending.delete(id);
        reject(new InspectorDisconnectedError("Desktop inspector RPC timed out; delivery is unconfirmed"));
      }, this.options.rpcTimeoutMs ?? 15_000) : undefined;
      this.pending.set(id, { resolve, reject, ...(timer ? { timer } : {}) });
      socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
    });
  }

  private receive(reply: InspectorReply): void {
    if (reply.id === undefined) return;
    const pending = this.pending.get(reply.id);
    if (!pending) return;
    this.pending.delete(reply.id);
    clearTimeout(pending.timer);
    const exception = reply.result?.exceptionDetails;
    if (reply.error || exception) {
      const message = reply.error?.message ?? exception?.exception?.description ?? exception?.text ?? "Desktop call failed";
      pending.reject(new NativeCallError(message));
      if (message.includes("BRIDGE_RENDERER_RELOADED")) { const socket = this.socket; this.disconnected(); socket?.close(); }
    } else pending.resolve(reply.result?.result?.value);
  }

  private disconnected(): void {
    this.ready = false;
    this.socket = undefined;
    this.webContentsId = undefined;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new InspectorDisconnectedError("Desktop inspector disconnected; delivery is unconfirmed"));
    }
    this.pending.clear();
    this.emit("disconnected");
  }
}
