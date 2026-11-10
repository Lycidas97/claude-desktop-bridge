import { createServer } from "node:http";
import { createContext, runInContext } from "node:vm";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { describe, expect, it } from "vitest";
import { ClaudeDesktopInspector, InspectorDisconnectedError, NativeCallError } from "./claude-desktop-inspector.js";

async function fixture() {
  const events = new Set<(value: unknown) => void>();
  const permissions = new Set<(value: unknown) => void>();
  const calls: unknown[][] = [];
  const api = {
    getAll: () => [{ sessionId: "local-native", cwd: "/project", isRunning: false }],
    canRewindTo: (...args: unknown[]) => { calls.push(args); return true; },
    rewindV2: (...args: unknown[]) => { calls.push(args); return { prefill: "Draft" }; },
    rewindFiles: (...args: unknown[]) => { calls.push(args); return { canRewind: true, filesChanged: ["native.ts"] }; },
    getAvailableCodeModels: (...args: unknown[]) => { calls.push(args); return ["native-model"]; },
    startBtwChild: (...args: unknown[]) => { calls.push(args); return { status: "started", sessionId: "native-child" }; },
    sendMessage: (...args: unknown[]) => { calls.push(args); if (args[2] === null) throw new Error("images failed validation"); },
    cancelQueuedMessage: (...args: unknown[]) => { calls.push(args); return args[1] !== "consumed"; },
    promoteQueuedMessage: (...args: unknown[]) => { calls.push(args); return args[1] !== "consumed"; },
    sendSteeredNow: (...args: unknown[]) => { calls.push(args); return args[1] !== "consumed"; },
    onOnEvent: (callback: (value: unknown) => void) => { events.add(callback); return () => events.delete(callback); },
    onOnToolPermissionRequest: (callback: (value: unknown) => void) => { permissions.add(callback); return () => permissions.delete(callback); },
  };
  const bootstrap = { ok: true, status: 200, body: { account: { email: "private-fixture@example.invalid" }, model_selector_config: [{ id: "chat", models: [{ id: "chat-only" }] }, { id: "code", models: [{ id: "native-model", name: "Private native label" }] }] } as unknown };
  const fetches: string[] = [];
  const fetch = async (path: string) => { fetches.push(path); return { ok: bootstrap.ok, status: bootstrap.status, json: async () => bootstrap.body }; };
  let context = createContext({ "claude.web": { LocalSessions: api }, fetch });
  let pageAvailable = true;
  const connection = { rejectHandshake: false };
  const page = { id: 42, getURL: () => "app://localhost/epitaxy/local-native", executeJavaScript: (source: string) => runInContext(source, context) };
  const main = createContext({ process: { mainModule: { require: () => ({ webContents: {
    getAllWebContents: () => [{ id: 1, getURL: () => "about:blank" }, ...(pageAvailable ? [page] : [])],
    fromId: (id: number) => id === 42 && pageAvailable ? page : undefined,
  } }) } } });
  const server = createServer((_, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify([{ type: "node", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/dynamic-id` }]));
  });
  const sockets = new WebSocketServer({ server, verifyClient: () => !connection.rejectHandshake });
  sockets.on("connection", socket => socket.on("message", async data => {
    const request = JSON.parse(String(data));
    try {
      const value = await runInContext(request.params.expression, main);
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ id: request.id, result: { result: { value } } }));
    } catch (error) {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ id: request.id, result: { exceptionDetails: { exception: { description: String(error) } } } }));
    }
  }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const inspector = new ClaudeDesktopInspector({ origin: `http://127.0.0.1:${port}`, rpcTimeoutMs: 300 });
  return {
    inspector, calls, events, permissions, api, connection, bootstrap, fetches,
    setPageAvailable(available: boolean) { pageAvailable = available; },
    reload() { events.clear(); permissions.clear(); context = createContext({ "claude.web": { LocalSessions: api }, fetch }); },
    drop() { for (const socket of sockets.clients) socket.terminate(); },
    async close() { await inspector.close(); for (const socket of sockets.clients) socket.terminate(); await new Promise<void>(resolve => sockets.close(() => server.close(() => resolve()))); },
  };
}

describe("native Desktop inspector", () => {
  it("discovers the renderer, receives both streams and unsubscribes on close", async () => {
    const f = await fixture();
    try {
      await f.inspector.connect();
      const received = once(f.inspector, "event");
      for (const callback of f.events) callback({ type: "session_updated", sessionId: "local-native" });
      expect(await received).toEqual([{ type: "session_updated", sessionId: "local-native" }]);
      const permission = once(f.inspector, "permission");
      for (const callback of f.permissions) callback({ requestId: "ask" });
      expect(await permission).toEqual([{ requestId: "ask" }]);
      await f.inspector.close();
      expect(f.events.size).toBe(0);
      expect(f.permissions.size).toBe(0);
    } finally { await f.close(); }
  });

  it("keeps optional arguments undefined and permits RPC while the event stream is idle", async () => {
    const f = await fixture();
    try {
      await f.inspector.connect();
      await f.inspector.call("sendMessage", ["local-native", "hi", undefined, undefined, undefined, "later"]);
      expect(f.calls).toEqual([["local-native", "hi", undefined, undefined, undefined, "later"]]);
      const sparse: unknown[] = ["local-native", "flags"];
      sparse[14] = { personSent: true };
      await f.inspector.call("sendMessage", sparse);
      expect(f.calls.at(-1)?.[14]).toEqual({ personSent: true });
      expect(await f.inspector.call("getAll")).toHaveLength(1);
      await expect(f.inspector.call("sendMessage", ["local-native", "hi", null])).rejects.toBeInstanceOf(NativeCallError);
      await expect(f.inspector.call("arbitraryEvaluate", [])).rejects.toThrow("Unsupported");
    } finally { await f.close(); }
  });

  it("forwards the verified native btw method with optional arguments omitted", async () => {
    const f = await fixture();
    try {
      await f.inspector.connect();
      expect(f.inspector.supports("startBtwChild")).toBe(true);
      expect(await f.inspector.call("startBtwChild", ["local-native"])).toEqual({ status: "started", sessionId: "native-child" });
      expect(f.calls).toEqual([["local-native"]]);
    } finally { await f.close(); }
  });

  it("allows all verified native rewind methods and preserves their arguments", async () => {
    const f = await fixture();
    try {
      await f.inspector.connect();
      for (const method of ["canRewindTo", "rewindV2", "rewindFiles"]) expect(f.inspector.supports(method)).toBe(true);
      expect(await f.inspector.call("canRewindTo", ["local-native", "raw-uuid"])).toBe(true);
      expect(await f.inspector.call("rewindFiles", ["local-native", "raw-uuid", true])).toMatchObject({ canRewind: true });
      expect(await f.inspector.call("rewindFiles", ["local-native", "raw-uuid", false, true])).toMatchObject({ canRewind: true });
      expect(await f.inspector.call("rewindV2", ["local-native", "raw-uuid"])).toEqual({ prefill: "Draft" });
      expect(f.calls).toEqual([["local-native", "raw-uuid"], ["local-native", "raw-uuid", true], ["local-native", "raw-uuid", false, true], ["local-native", "raw-uuid"]]);
    } finally { await f.close(); }
  });

  it.each(["cancelQueuedMessage", "promoteQueuedMessage", "sendSteeredNow"])("forwards verified %s UUID arguments and preserves native false", async method => {
    const f = await fixture();
    try {
      await f.inspector.connect();
      expect(f.inspector.supports(method)).toBe(true);
      expect(await f.inspector.call(method, ["local-native", "raw-uuid"])).toBe(true);
      expect(await f.inspector.call(method, ["local-native", "consumed"])).toBe(false);
      expect(f.calls).toEqual([["local-native", "raw-uuid"], ["local-native", "consumed"]]);
    } finally { await f.close(); }
  });

  it("reads only code model IDs from the fixed native bootstrap path without exposing account data", async () => {
    const f = await fixture();
    try {
      Reflect.deleteProperty(f.api, "getAvailableCodeModels");
      await f.inspector.connect();
      expect(f.inspector.supports("getAvailableCodeModels")).toBe(false);
      const models = await f.inspector.availableCodeModels();
      expect(models).toEqual(["native-model"]);
      expect(f.fetches).toEqual(["/api/bootstrap"]);
      expect(JSON.stringify(models)).not.toContain("private-fixture");
      expect(JSON.stringify(models)).not.toContain("Private native label");
      expect(f.calls).toEqual([]);
    } finally { await f.close(); }
  });

  it.each([null, {}, { model_selector_config: [] }, { model_selector_config: [{ id: "code", models: [{ id: 42 }] }] }])("rejects malformed native model catalog %j without forwarding its body", async body => {
    const f = await fixture();
    try {
      f.bootstrap.body = body;
      await f.inspector.connect();
      await expect(f.inspector.availableCodeModels()).rejects.toThrow("invalid native model catalog");
      expect(f.inspector.ready).toBe(true);
    } finally { await f.close(); }
  });

  it("reports a failed bootstrap request and accepts an empty code catalog", async () => {
    const f = await fixture();
    try {
      await f.inspector.connect();
      f.bootstrap.ok = false;
      f.bootstrap.status = 503;
      await expect(f.inspector.availableCodeModels()).rejects.toThrow("catalog request failed (503)");
      f.bootstrap.ok = true;
      f.bootstrap.body = { model_selector_config: [{ id: "code", models: [] }] };
      expect(await f.inspector.availableCodeModels()).toEqual([]);
      await f.inspector.close();
      await expect(f.inspector.availableCodeModels()).rejects.toBeInstanceOf(InspectorDisconnectedError);
    } finally { await f.close(); }
  });

  it("detects a replaced renderer and can establish a new subscription", async () => {
    const f = await fixture();
    try {
      await f.inspector.connect();
      f.reload();
      await expect(f.inspector.call("getAll")).rejects.toThrow(/BRIDGE_RENDERER_RELOADED|Desktop inspector disconnected/u);
      expect(f.inspector.ready).toBe(false);
      await f.inspector.connect();
      expect(await f.inspector.call("getAll")).toHaveLength(1);
      expect(f.events.size).toBe(1);
    } finally { await f.close(); }
  });

  it("rejects a failed WebSocket handshake and can reconnect", async () => {
    const f = await fixture();
    try {
      f.connection.rejectHandshake = true;
      await expect(f.inspector.connect()).rejects.toBeInstanceOf(InspectorDisconnectedError);
      expect(f.inspector.ready).toBe(false);
      expect(f.events.size).toBe(0);
      expect(f.permissions.size).toBe(0);
      f.connection.rejectHandshake = false;
      await f.inspector.connect();
      expect(await f.inspector.call("getAll")).toHaveLength(1);
      expect(f.events.size).toBe(1);
      expect(f.permissions.size).toBe(1);
    } finally { await f.close(); }
  });

  it("fails discovery when the renderer is absent and can try again", async () => {
    const f = await fixture();
    try {
      f.setPageAvailable(false);
      await expect(f.inspector.connect()).rejects.toThrow("LocalSessions renderer was not found");
      expect(f.inspector.ready).toBe(false);
      expect(f.events.size).toBe(0);
      expect(f.permissions.size).toBe(0);
      f.setPageAvailable(true);
      await f.inspector.connect();
      expect(await f.inspector.call("getAll")).toHaveLength(1);
    } finally { f.setPageAvailable(true); await f.close(); }
  });

  it.each(["missing", "throws"] as const)("cleans up a partial subscription when the permission method %s", async failure => {
    const f = await fixture();
    const subscribe = f.api.onOnToolPermissionRequest;
    try {
      if (failure === "missing") Reflect.deleteProperty(f.api, "onOnToolPermissionRequest");
      else f.api.onOnToolPermissionRequest = () => { throw new Error("permission subscription failed"); };
      await expect(f.inspector.connect()).rejects.toBeInstanceOf(NativeCallError);
      expect(f.inspector.ready).toBe(false);
      expect(f.events.size).toBe(0);
      expect(f.permissions.size).toBe(0);
      f.api.onOnToolPermissionRequest = subscribe;
      await f.inspector.connect();
      expect(f.events.size).toBe(1);
      expect(f.permissions.size).toBe(1);
    } finally { f.api.onOnToolPermissionRequest = subscribe; await f.close(); }
  });

  it("rejects absent methods and discovered methods outside the fixed whitelist", async () => {
    const f = await fixture();
    try {
      Reflect.deleteProperty(f.api, "sendMessage");
      await f.inspector.connect();
      expect(f.inspector.supports("sendMessage")).toBe(false);
      await expect(f.inspector.call("sendMessage", ["local-native", "unavailable"])).rejects.toThrow("Unsupported");
      expect(f.inspector.supports("onOnEvent")).toBe(false);
      await expect(f.inspector.call("onOnEvent")).rejects.toThrow("Unsupported");
      expect(f.calls).toEqual([]);
      expect(f.events.size).toBe(1);
      expect(await f.inspector.call("getAll")).toHaveLength(1);
    } finally { await f.close(); }
  });

  it.each(["success", "error"] as const)("ignores a late %s reply after a command times out", async reply => {
    const f = await fixture();
    let finish: (() => void) | undefined;
    try {
      await f.inspector.connect();
      f.api.sendMessage = (...args) => {
        f.calls.push(args);
        return new Promise<void>((resolve, reject) => { finish = () => reply === "success" ? resolve() : reject(new Error("late native error")); });
      };
      const pending = f.inspector.call("sendMessage", ["local-native", "once"]);
      await expect(pending).rejects.toBeInstanceOf(InspectorDisconnectedError);
      await expect(pending).rejects.toThrow("Desktop inspector RPC timed out; delivery is unconfirmed");
      expect(f.calls).toEqual([["local-native", "once"]]);
      expect(f.inspector.ready).toBe(true);
      const next = f.inspector.call("getAll");
      finish!();
      expect(await next).toHaveLength(1);
      const event = once(f.inspector, "event");
      for (const callback of f.events) callback({ type: "still-subscribed" });
      expect(await event).toEqual([{ type: "still-subscribed" }]);
      expect(f.calls).toHaveLength(1);
    } finally { finish?.(); await f.close(); }
  });

  it("reports unconfirmed delivery when sendMessage runs but its RPC reply is lost", async () => {
    const f = await fixture();
    try {
      await f.inspector.connect();
      f.api.sendMessage = (...args) => { f.calls.push(args); f.drop(); };
      await expect(f.inspector.call("sendMessage", ["local-native", "once"])).rejects.toMatchObject({
        message: "Desktop inspector disconnected; delivery is unconfirmed",
      });
      expect(f.calls).toEqual([["local-native", "once"]]);
      expect(f.inspector.ready).toBe(false);
      await f.inspector.connect();
      expect(await f.inspector.call("getAll")).toHaveLength(1);
      expect(f.calls).toHaveLength(1);
      expect(f.events.size).toBe(1);
      expect(f.permissions.size).toBe(1);
    } finally { await f.close(); }
  });

  it("disconnects when the selected renderer page disappears", async () => {
    const f = await fixture();
    try {
      await f.inspector.connect();
      expect(await f.inspector.call("getAll")).toHaveLength(1);
      f.setPageAvailable(false);
      await expect(f.inspector.call("getAll")).rejects.toBeInstanceOf(NativeCallError);
      expect(f.inspector.ready).toBe(false);
      await expect(f.inspector.call("sendMessage", ["local-native", "unavailable"])).rejects.toBeInstanceOf(InspectorDisconnectedError);
      expect(f.calls).toEqual([]);
      f.setPageAvailable(true);
      await f.inspector.connect();
      expect(await f.inspector.call("getAll")).toHaveLength(1);
      expect(f.events.size).toBe(1);
    } finally { f.setPageAvailable(true); await f.close(); }
  });

  it("rejects pending calls and disposes idle subscriptions on close", async () => {
    const f = await fixture();
    let finish: (() => void) | undefined;
    const streamErrors: unknown[] = [];
    f.inspector.on("stream-error", error => streamErrors.push(error));
    try {
      await f.inspector.connect();
      f.api.sendMessage = (...args) => {
        f.calls.push(args);
        return new Promise<void>(resolve => { finish = resolve; });
      };
      const pending = f.inspector.call("sendMessage", ["local-native", "pending"]).catch(error => error);
      await expect.poll(() => f.calls.length).toBe(1);
      await f.inspector.close();
      expect(await pending).toBeInstanceOf(InspectorDisconnectedError);
      expect(f.inspector.ready).toBe(false);
      expect(f.events.size).toBe(0);
      expect(f.permissions.size).toBe(0);
      expect(streamErrors).toEqual([]);
      await expect(f.inspector.call("getAll")).rejects.toBeInstanceOf(InspectorDisconnectedError);
      finish!();
      await f.inspector.connect();
      expect(await f.inspector.call("getAll")).toHaveLength(1);
      expect(f.events.size).toBe(1);
      expect(f.permissions.size).toBe(1);
      expect(f.calls).toHaveLength(1);
    } finally { finish?.(); await f.close(); }
  });

  it("does not replay a command when the socket is lost", async () => {
    const f = await fixture();
    try {
      await f.inspector.connect();
      await f.inspector.call("sendMessage", ["local-native", "once"]);
      const disconnected = once(f.inspector, "disconnected");
      f.drop();
      await disconnected;
      await expect(f.inspector.call("sendMessage", ["local-native", "again"])).rejects.toBeInstanceOf(InspectorDisconnectedError);
      await f.inspector.connect();
      expect(f.calls).toHaveLength(1);
    } finally { await f.close(); }
  });
});
