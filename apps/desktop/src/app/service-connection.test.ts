import { execFile } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as http from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterEach, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { DesktopServiceClient, connectDesktopService, serveDesktopService, type ServiceController } from "./service-connection.js";

vi.mock("node:http", async (importOriginal) => {
  const actual = await importOriginal<typeof http>();
  return { ...actual, createServer: vi.fn(actual.createServer) };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

it("keeps the running task and pending approval alive across UI disconnect and reconnect", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-service-"));
  directories.push(root);
  const addressPath = join(root, "address.json");
  let permissions: Array<{ requestId: string }> = [];
  let resolveApproval!: (decision: string) => void;
  const approval = new Promise<string>(resolve => { resolveApproval = resolve; });
  let turns = 0;
  let running = false;
  const controller = Object.assign(new EventEmitter(), {
    async snapshot() { return { running, turns, permissions }; },
    async dispatchLocal(input: { method: string; params?: Record<string, unknown> }) {
      if (input.method === "turn.start") { turns++; running = true; }
      if (input.method === "permission.resolve" && permissions.some(request => request.requestId === input.params?.requestId)) { permissions = []; resolveApproval("once"); }
      return { ok: true };
    },
    diagnostics() { return { turns }; },
  });
  let shutdown = false;
  const server = await serveDesktopService({ addressPath, controller: controller as unknown as ServiceController, shutdown: () => { shutdown = true; } });
  const first = new DesktopServiceClient(addressPath);
  const second = new DesktopServiceClient(addressPath);
  try {
    await first.connect();
    await first.call("dispatchLocal", { method: "turn.start", idempotencyKey: "task-1" });
    const requestId = "native-approval";
    permissions = [{ requestId }];
    first.close();
    await second.connect();
    expect(await second.call("snapshot")).toMatchObject({ running: true, turns: 1, permissions: [{ requestId }] });
    expect(second.servicePid).toBe(process.pid);
    expect(shutdown).toBe(false);
    expect(await second.call("diagnostics")).toEqual({ turns: 1 });
    await second.call("dispatchLocal", { method: "permission.resolve", params: { requestId } });
    expect(await approval).toBe("once");
    running = false;
    const completed = new Promise((resolve) => second.once("event", resolve));
    controller.emit("event", { type: "turn.completed", seq: 1 });
    expect(await completed).toEqual({ type: "turn.completed", seq: 1 });
    expect(await second.call("snapshot")).toMatchObject({ running: false, turns: 1, permissions: [] });
    await second.shutdown();
    await new Promise((resolve) => setImmediate(resolve));
    expect(shutdown).toBe(true);
  } finally { first.close(); second.close(); await server.close(); }
});

it("requires the local bearer token and refuses non-allowlisted methods", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-service-auth-"));
  directories.push(root);
  const addressPath = join(root, "address.json");
  const controller = Object.assign(new EventEmitter(), { async snapshot() { return {}; } });
  const server = await serveDesktopService({ addressPath, controller: controller as unknown as ServiceController, shutdown() {} });
  const client = new DesktopServiceClient(addressPath);
  try {
    const { port } = JSON.parse(await readFile(addressPath, "utf8"));
    const rejected = new WebSocket(`ws://127.0.0.1:${port}`);
    expect(await new Promise<string>((resolve) => rejected.once("error", (error) => resolve(error.message)))).toContain("401");
    const { token } = JSON.parse(await readFile(addressPath, "utf8"));
    const browser = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { Authorization: `Bearer ${token}`, Origin: "https://example.com" } });
    expect(await new Promise<string>((resolve) => browser.once("error", (error) => resolve(error.message)))).toContain("401");
    await client.connect();
    await expect((client.call as (method: string) => Promise<unknown>)("close")).rejects.toThrow("Unknown service method");
    await expect(client.call("setLaunchAtLogin", "false" as unknown as boolean)).rejects.toThrow("Expected one boolean");
  } finally { client.close(); await server.close(); }
});

it("routes Magpie testing and saving only through the authenticated local service", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-service-magpie-"));
  directories.push(root);
  const addressPath = join(root, "address.json");
  const input = { mode: "manual" as const, baseUrl: "https://example.test", authScheme: "bearer" as const, apiKey: "synthetic-key" };
  const testMagpieConnection = vi.fn(async () => ({ models: { state: "ready", count: 2 }, quota: { state: "available" } }));
  const saveMagpieConnection = vi.fn(async () => ({ magpie: { mode: "manual", baseUrl: input.baseUrl, keyConfigured: true } }));
  const controller = Object.assign(new EventEmitter(), { async snapshot() { return {}; }, testMagpieConnection, saveMagpieConnection });
  const server = await serveDesktopService({ addressPath, controller: controller as unknown as ServiceController, shutdown() {} });
  const client = new DesktopServiceClient(addressPath);
  try {
    await client.connect();
    expect(await client.call("testMagpieConnection", input)).toMatchObject({ models: { count: 2 } });
    expect(await client.call("saveMagpieConnection", input)).toMatchObject({ magpie: { keyConfigured: true } });
    expect(testMagpieConnection).toHaveBeenCalledWith(input);
    expect(saveMagpieConnection).toHaveBeenCalledWith(input);
    await expect((client.call as (...args: unknown[]) => Promise<unknown>)("saveMagpieConnection")).rejects.toThrow("Expected one Magpie configuration");
  } finally { client.close(); await server.close(); }
});

it("replays events missed during a connection loss before publishing the new snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-service-replay-"));
  directories.push(root);
  const addressPath = join(root, "address.json");
  const events: Array<{ seq: number; type: string }> = [];
  const controller = Object.assign(new EventEmitter(), {
    async snapshot() { return { latestSeq: events.length }; },
    async dispatchLocal(input: { params: { afterSeq: number } }) {
      return { ok: true, result: { events: events.filter((event) => event.seq > input.params.afterSeq), hasMore: false } };
    },
  });
  const server = await serveDesktopService({ addressPath, controller: controller as unknown as ServiceController, shutdown() {} });
  const client = new DesktopServiceClient(addressPath);
  try {
    await client.connect();
    await client.call("snapshot");
    const received: number[] = [];
    client.on("event", (event) => received.push(event.seq));
    const reconnected = new Promise((resolve) => client.once("snapshot", resolve));
    (client as unknown as { socket: WebSocket }).socket.terminate();
    events.push({ seq: 1, type: "turn.completed" });
    expect(await reconnected).toEqual({ latestSeq: 1 });
    expect(received).toEqual([1]);
  } finally { client.close(); await server.close(); }
});

it("schedules one reconnect when the event replay connection closes", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-service-replay-close-"));
  directories.push(root);
  const addressPath = join(root, "address.json");
  const replayStarted = new EventEmitter();
  let attempts = 0;
  let finishReplay!: () => void;
  const replayWait = new Promise<void>((resolve) => { finishReplay = resolve; });
  const controller = Object.assign(new EventEmitter(), {
    async snapshot() { return { latestSeq: 0 }; },
    async dispatchLocal() {
      if (++attempts === 1) { replayStarted.emit("started"); await replayWait; }
      return { ok: true, result: { events: [], nextSeq: 0, hasMore: false } };
    },
  });
  const server = await serveDesktopService({ addressPath, controller: controller as unknown as ServiceController, shutdown() {} });
  const client = new DesktopServiceClient(addressPath);
  const connect = vi.spyOn(client, "connect");
  try {
    await client.connect();
    await client.call("snapshot");
    const replay = once(replayStarted, "started");
    (client as unknown as { socket: WebSocket }).socket.terminate();
    await replay;
    const disconnected = once(client, "disconnected");
    (client as unknown as { socket: WebSocket }).socket.terminate();
    await disconnected;
    const restored = once(client, "snapshot");
    await restored;
    // Both retry timers in the broken path are due in the same timer interval.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(connect).toHaveBeenCalledTimes(3);
  } finally { finishReplay(); client.close(); await server.close(); connect.mockRestore(); }
});

it("closes a connection that is still waiting for the service hello", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-service-handshake-close-"));
  directories.push(root);
  const addressPath = join(root, "address.json");
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("Missing test server");
  await writeFile(addressPath, JSON.stringify({ port: address.port, token: "test", protocol: 1 }));
  const client = new DesktopServiceClient(addressPath);
  try {
    const accepted = once(server, "connection");
    const connected = client.connect().then(() => "connected", () => "closed");
    const [socket] = await accepted as [WebSocket];
    client.close();
    socket.send(JSON.stringify({ kind: "hello", protocol: 1, pid: process.pid }));
    expect(await connected).toBe("closed");
  } finally {
    client.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("preserves a pushed snapshot received while the reconnect snapshot is pending", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-service-snapshot-order-"));
  directories.push(root);
  const addressPath = join(root, "address.json");
  const snapshotStarted = new EventEmitter();
  let reads = 0;
  let finishSnapshot!: () => void;
  const snapshotWait = new Promise<void>((resolve) => { finishSnapshot = resolve; });
  const controller = Object.assign(new EventEmitter(), {
    async snapshot() {
      if (++reads === 2) { snapshotStarted.emit("started"); await snapshotWait; }
      return { latestSeq: 0, launchAtLogin: false };
    },
    async dispatchLocal() { return { ok: true, result: { events: [], nextSeq: 0, hasMore: false } }; },
  });
  const server = await serveDesktopService({ addressPath, controller: controller as unknown as ServiceController, shutdown() {} });
  const client = new DesktopServiceClient(addressPath);
  try {
    await client.connect();
    await client.call("snapshot");
    const snapshot = once(snapshotStarted, "started");
    (client as unknown as { socket: WebSocket }).socket.terminate();
    await snapshot;
    const received = once((client as unknown as { socket: WebSocket }).socket, "message");
    controller.emit("snapshot", { latestSeq: 0, launchAtLogin: true });
    await received;
    const restored = once(client, "snapshot");
    finishSnapshot();
    expect((await restored)[0]).toMatchObject({ launchAtLogin: true });
  } finally { finishSnapshot(); client.close(); await server.close(); }
});

it("releases the listener and subscriptions when publishing the address fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-service-publish-failure-"));
  directories.push(root);
  const addressPath = join(root, "connection.json");
  await mkdir(addressPath);
  const controller = new EventEmitter();
  const createServer = vi.mocked(http.createServer);
  createServer.mockClear();
  try {
    // A directory cannot be overwritten with the connection JSON, after listen succeeds.
    await expect(serveDesktopService({ addressPath, controller: controller as unknown as ServiceController, shutdown() {} })).rejects.toThrow();
    expect(controller.listenerCount("snapshot")).toBe(0);
    expect(controller.listenerCount("event")).toBe(0);
    expect((createServer.mock.results[0]!.value as http.Server).listening).toBe(false);
  } finally {
    const server = createServer.mock.results[0]?.value as http.Server | undefined;
    if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    createServer.mockClear();
  }
});

it("makes concurrent and repeated server shutdown share completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-service-close-"));
  directories.push(root);
  const server = await serveDesktopService({ addressPath: join(root, "address.json"), controller: new EventEmitter() as unknown as ServiceController, shutdown() {} });
  await expect(Promise.all([server.close(), server.close()])).resolves.toEqual([undefined, undefined]);
  await expect(server.close()).resolves.toBeUndefined();
});

it("cancels startup connection polling when the desktop exits", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-service-startup-cancel-"));
  directories.push(root);
  const signal = new AbortController();
  const launch = vi.fn(() => { signal.abort(new Error("desktop exited")); });
  const connect = vi.spyOn(DesktopServiceClient.prototype, "connect");
  const close = vi.spyOn(DesktopServiceClient.prototype, "close");
  try {
    const result = connectDesktopService(join(root, "absent.json"), launch, { signal: signal.signal });
    await expect(result).rejects.toThrow("desktop exited");
    expect(connect).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  } finally { connect.mockRestore(); close.mockRestore(); }
});

it("returns a launch failure immediately and releases the startup client", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-service-launch-failure-"));
  directories.push(root);
  const close = vi.spyOn(DesktopServiceClient.prototype, "close");
  try {
    await expect(connectDesktopService(join(root, "absent.json"), () => { throw new Error("spawn EACCES"); })).rejects.toThrow("spawn EACCES");
    expect(close).toHaveBeenCalledOnce();
  } finally { close.mockRestore(); }
});

it.each(["oversized", "unmasked"] as const)("keeps the service alive after an authenticated %s WebSocket frame", async (kind) => {
  const root = await mkdtemp(join(tmpdir(), "bridge-service-frame-"));
  directories.push(root);
  const bundle = await build({
    stdin: {
      resolveDir: fileURLToPath(new URL(".", import.meta.url)),
      sourcefile: "service-frame-repro.ts",
      contents: `
        import { EventEmitter, once } from 'node:events';
        import { readFile } from 'node:fs/promises';
        import WebSocket from 'ws';
        import { DesktopServiceClient, serveDesktopService } from './service-connection.js';
        const addressPath = process.argv[2];
        const controller = Object.assign(new EventEmitter(), { async snapshot() { return { alive: true }; } });
        const service = await serveDesktopService({ addressPath, controller, shutdown() {} });
        const { port, token } = JSON.parse(await readFile(addressPath, 'utf8'));
        const bad = new WebSocket('ws://127.0.0.1:' + port, { headers: { Authorization: 'Bearer ' + token } });
        await once(bad, 'message');
        const closed = once(bad, 'close');
        if (process.argv[3] === 'oversized') {
          const header = Buffer.alloc(14);
          header[0] = 0x82; header[1] = 0xff;
          header.writeBigUInt64BE(BigInt(32 * 1024 * 1024 + 1), 2);
          bad._socket.write(header);
        } else bad._socket.write(Buffer.from([0x81, 0x00]));
        await closed;
        const healthy = new DesktopServiceClient(addressPath);
        await healthy.connect();
        if (!(await healthy.call('snapshot')).alive) throw new Error('service unavailable');
        healthy.close();
        await service.close();
        process.stdout.write('service survived\\n');
      `,
    },
    bundle: true, platform: "node", format: "esm", write: false,
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  });
  const script = join(root, "service-frame.mjs");
  await writeFile(script, bundle.outputFiles[0]!.text);
  const result = await new Promise<{ code: number | string | null | undefined; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, [script, join(root, "address.json"), kind], { timeout: 5_000 }, (error, stdout, stderr) => {
      resolve({ code: error?.code, stdout, stderr });
    });
  });
  expect(result, result.stderr).toMatchObject({ code: undefined, stdout: "service survived\n" });
  expect(result.stderr).toContain(kind === "oversized" ? "Max payload size exceeded" : "MASK must be set");
});

it.each([false, true])("publishes only a complete descriptor while its write is pending (replace=%s)", async (replace) => {
  const root = await mkdtemp(join(tmpdir(), "bridge-service-atomic-address-"));
  directories.push(root);
  const addressPath = join(root, "connection.json");
  const previous = JSON.stringify({ port: 1, token: "old-token", protocol: 1 });
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  if (replace) await actual.writeFile(addressPath, previous, { mode: 0o600 });
  let release!: () => void;
  let started!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const writing = new Promise<void>(resolve => { started = resolve; });
  vi.mocked(writeFile).mockImplementationOnce(async (path, data, options) => {
    // Model writeFile's truncate/partial-write interval at its real output path.
    await actual.writeFile(path, '{"port":', options);
    started();
    await held;
    await actual.writeFile(path, data, options);
  });
  const starting = serveDesktopService({ addressPath, controller: new EventEmitter() as unknown as ServiceController, shutdown() {} });
  await writing;
  const client = new DesktopServiceClient(addressPath);
  try {
    if (replace) expect(await readFile(addressPath, "utf8")).toBe(previous);
    else await expect(readFile(addressPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    release();
    const service = await starting;
    try {
      await client.connect();
      expect(JSON.parse(await readFile(addressPath, "utf8"))).toMatchObject({ port: expect.any(Number), token: expect.any(String), protocol: 1 });
      if (process.platform !== "win32") expect((await stat(addressPath)).mode & 0o777).toBe(0o600);
    } finally { client.close(); await service.close(); }
  }
});

it("reuses the existing service without launching another writer", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-service-reuse-"));
  directories.push(root);
  const addressPath = join(root, "address.json");
  const server = await serveDesktopService({ addressPath, controller: new EventEmitter() as unknown as ServiceController, shutdown() {} });
  let launches = 0;
  const client = await connectDesktopService(addressPath, () => { launches++; });
  try { expect(launches).toBe(0); } finally { client.close(); await server.close(); }
});
