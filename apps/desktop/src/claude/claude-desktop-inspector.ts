import { EventEmitter } from "node:events";

const STREAM = "__claudeBridgeNativeStreamV1";
const METHODS = new Set([
  "getAll", "getSession", "start", "saveTrust", "forkSession", "startBtwChild", "updateSession", "archive", "unarchive", "delete",
  "sendMessage", "sendSteeredNow", "promoteQueuedMessage", "cancelQueuedMessage", "interrupt", "stopTask", "setModel", "setEffort",
  "setPermissionMode", "getContextUsage", "getSupportedCommands", "getTranscript", "getTranscriptPage",
  "getTranscriptTail", "respondToToolPermission", "findLocalSessionIdForBridgeId", "getAvailableCodeModels",
  "canRewindTo", "rewindV2", "rewindFiles",
]);

export interface NativeSectionCatalog {
  sections: Array<{ id: string; name: string; order: number }>;
  assignments: Record<string, string>;
  canRename?: boolean;
  canDelete?: boolean;
}

// Verified against Desktop 4.23118.1 and 5.1231.2: discover already-loaded
// ccd_sidebar and claudeCodeSessionManager exports by structural contract.
const SIDEBAR_RUNTIME = `
  const modules = Object.values(process.mainModule.require('module')._cache);
  let sidebar;
  let manager;
  for (const mod of modules) {
    const exports = mod?.exports;
    if (!exports || (typeof exports !== 'object' && typeof exports !== 'function')) continue;
    if (!manager && exports.claudeCodeSessionManager) {
      const candidate = exports.claudeCodeSessionManager;
      if (typeof candidate.listCustomGroups === 'function' && typeof candidate.getSessionCustomGroup === 'function') {
        manager = candidate;
      }
    }
    if (!sidebar) {
      for (const key of Object.keys(exports)) {
        let value;
        try { value = exports[key]; } catch { continue; }
        let candidate = value;
        if (typeof value === 'function' && value.length === 0 && /\\bserverName\\b/.test(String(value)) && /\\bhandleToolCall\\b/.test(String(value))) {
          try { candidate = value(); } catch { continue; }
        }
        if (candidate?.serverName === 'ccd_sidebar') {
          sidebar = candidate;
          break;
        }
      }
    }
    if (sidebar && manager) break;
  }
  const available = sidebar?.serverName === 'ccd_sidebar'
    && typeof sidebar.isEnabled === 'function'
    && typeof sidebar.handleToolCall === 'function'
    && Array.isArray(sidebar.tools)
    && sidebar.isEnabled({ sessionType: 'ccd' })
    && ['list_sections', 'create_section', 'move_sessions'].every(name => sidebar.tools.some(tool => tool?.name === name))
    && Boolean(manager);
`;

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

  async sections(sessionIds: string[]): Promise<NativeSectionCatalog | undefined> {
    if (!this.ready) throw new InspectorDisconnectedError("Claude Desktop inspector is disconnected");
    return this.evaluate(`(async () => {
      ${SIDEBAR_RUNTIME}
      if (!available) return;
      const reply = await sidebar.handleToolCall('list_sections', {});
      if (reply.isError) return;
      const sections = JSON.parse(reply.content.filter(item => item.type === 'text').map(item => item.text).join('\\n'));
      const groups = manager.listCustomGroups();
      if (!groups) return;
      const shown = new Set(sections.filter(section => section.kind === 'manual' && section.shown !== false).map(section => section.id));
      const canRename = sidebar.tools.some(tool => tool?.name === 'rename_section');
      const canDelete = sidebar.tools.some(tool => tool?.name === 'delete_section');
      return {
        sections: groups.filter(group => shown.has(group.id)).map(({ id, name, order }) => ({ id, name, order })),
        assignments: Object.fromEntries(${JSON.stringify(sessionIds)}.flatMap(id => {
          const group = manager.getSessionCustomGroup(id);
          return group && shown.has(group.id) ? [[id, group.id]] : [];
        })),
        ...(canRename ? { canRename: true } : {}),
        ...(canDelete ? { canDelete: true } : {}),
      };
    })()`) as Promise<NativeSectionCatalog | undefined>;
  }

  private async sidebarTool(method: "create_section" | "move_sessions" | "rename_section" | "delete_section", params: Record<string, unknown>, sessionId?: string): Promise<string> {
    if (!this.ready) throw new InspectorDisconnectedError("Claude Desktop inspector is disconnected");
    const reply = await this.evaluate(`(async () => {
      ${SIDEBAR_RUNTIME}
      if (!available || !sidebar.tools.some(tool => tool?.name === ${JSON.stringify(method)})) throw new Error('This Claude Desktop version does not support Sections');
      return sidebar.handleToolCall(${JSON.stringify(method)}, ${JSON.stringify(params)}, ${JSON.stringify({ sessionId })});
    })()`) as { isError?: boolean; content: Array<{ type: string; text?: string }> };
    const text = reply.content.filter(item => item.type === "text").map(item => item.text).join("\n");
    if (reply.isError) throw new NativeCallError(text);
    return text;
  }

  async createSection(name: string): Promise<string> {
    return (JSON.parse(await this.sidebarTool("create_section", { name })) as { id: string }).id;
  }

  async assignSection(sessionId: string, sectionId: string): Promise<void> {
    await this.sidebarTool("move_sessions", { session_ids: [sessionId], section_id: sectionId }, sessionId);
  }

  async renameSection(sectionId: string, name: string): Promise<void> {
    await this.sidebarTool("rename_section", { section_id: sectionId, name });
  }

  async deleteSection(sectionId: string): Promise<void> {
    await this.sidebarTool("delete_section", { section_id: sectionId });
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
