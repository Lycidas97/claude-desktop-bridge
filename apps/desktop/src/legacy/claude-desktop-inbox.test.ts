import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join, dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ClaudeDesktopInbox,
  InboxSendError,
  type DesktopInboxEndpoint,
  type DesktopInboxReceipt,
} from "./claude-desktop-inbox.js";

describe.skipIf(process.platform !== "darwin")("ClaudeDesktopInbox", () => {
  let directory: string;
  let inbox: ClaudeDesktopInbox;
  const servers: Server[] = [];
  const connections = new Set<Socket>();

  beforeEach(async () => {
    directory = await mkdtemp("/tmp/bridge-inbox-");
    inbox = new ClaudeDesktopInbox();
  });

  afterEach(async () => {
    await inbox.close();
    for (const socket of connections) socket.destroy();
    connections.clear();
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })));
    await rm(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function target(socketPath = join(directory, "desktop.sock")) {
    const frames: Record<string, any>[] = [];
    const server = createServer((socket) => {
      connections.add(socket);
      socket.once("close", () => connections.delete(socket));
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk;
        for (let newline; (newline = buffer.indexOf("\n")) >= 0;) {
          frames.push(JSON.parse(buffer.slice(0, newline)));
          buffer = buffer.slice(newline + 1);
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    servers.push(server);
    const endpoint: DesktopInboxEndpoint = { socketPath, sessionId: randomUUID(), pid: process.pid };
    return { frames, server, endpoint };
  }

  async function receipt(reply: string, frame: unknown) {
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(decodeURIComponent(reply.slice("uds:".length)));
      socket.once("error", reject);
      socket.once("connect", () => socket.end(`${typeof frame === "string" ? frame : JSON.stringify(frame)}\n`));
      socket.once("close", () => resolve());
    });
  }

  function status(endpoint: DesktopInboxEndpoint, messageId: string, value: string, extra = {}) {
    return {
      msgV: 1,
      msg_id: randomUUID(),
      type: "control",
      action: "peer_message_status",
      orig_msg_id: messageId,
      from: `uds:${endpoint.socketPath}`,
      status: value,
      ...extra,
    };
  }

  it("writes one official user frame with the native UUID and session, without waiting for a positive ACK", async () => {
    const { frames, endpoint } = await target();
    const messageId = randomUUID();
    const onReceipt = vi.fn();
    inbox.onReceipt(onReceipt);

    await inbox.send(endpoint, { messageId, text: "主轮已闲，继续\n下一行" });

    await vi.waitFor(() => expect(frames).toHaveLength(1));
    expect(frames[0]).toEqual({
      msgV: 1,
      msg_id: messageId,
      type: "user",
      uuid: messageId,
      session_id: endpoint.sessionId,
      from: expect.stringMatching(/^uds:/u),
      message: { role: "user", content: "主轮已闲，继续\n下一行" },
      priority: "next",
    });
    expect(onReceipt).not.toHaveBeenCalled();
  });

  it("keeps the sender connection alive for native peer credentials until forget", async () => {
    const { frames, endpoint, server } = await target();
    const messageId = randomUUID();
    const connectionCount = () => new Promise<number>((resolve, reject) => {
      server.getConnections((error, count) => error ? reject(error) : resolve(count));
    });
    await inbox.send(endpoint, { messageId, text: "retain peer credentials" });
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    expect(await connectionCount()).toBe(1);
    inbox.forget(messageId);
    await vi.waitFor(async () => expect(await connectionCount()).toBe(0));
  });

  it("reuses one private reply socket in the target namespace for concurrent sends", async () => {
    const first = await target();
    const second = await target(join(directory, "desktop-two.sock"));
    await Promise.all([
      inbox.send(first.endpoint, { messageId: randomUUID(), text: "first" }),
      inbox.send(second.endpoint, { messageId: randomUUID(), text: "second" }),
    ]);
    await vi.waitFor(() => {
      expect(first.frames).toHaveLength(1);
      expect(second.frames).toHaveLength(1);
    });
    const reply = decodeURIComponent(first.frames[0]!.from.slice(4));
    expect(second.frames[0]!.from).toBe(first.frames[0]!.from);
    expect(dirname(reply)).toBe(directory);
    expect((await stat(reply)).mode & 0o777).toBe(0o600);
  });

  it("percent-encodes UTF-8 and URI punctuation while preserving the native address alphabet", async () => {
    const namespace = join(directory, "中 !'()*#?%");
    await mkdir(namespace);
    const { frames, endpoint } = await target(join(namespace, "desktop.sock"));
    const messageId = randomUUID();
    await inbox.send(endpoint, { messageId, text: "encoded address" });
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    const address = frames[0]!.from as string;
    expect(address).toMatch(/^uds:[A-Za-z0-9:_/.\\%\-]+$/u);
    expect(address).toContain("%E4%B8%AD%20%21%27%28%29%2A%23%3F%25/");
    expect(dirname(decodeURIComponent(address.slice(4)))).toBe(namespace);
  });

  it("associates held and refused receipts by message ID and expected sender", async () => {
    const { frames, endpoint } = await target();
    const messageId = randomUUID();
    const received: DesktopInboxReceipt[] = [];
    inbox.onReceipt((value) => received.push(value));
    await inbox.send(endpoint, { messageId, text: "held input" });
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    const reply = frames[0]!.from as string;
    await receipt(reply, status(endpoint, "unrelated", "held"));
    await receipt(reply, status(endpoint, messageId, "held", { from: "uds:/tmp/wrong.sock" }));
    await receipt(reply, status(endpoint, messageId, "held"));
    await receipt(reply, status(endpoint, messageId, "expired", { status_detail: "refused" }));
    expect(received).toEqual([
      { messageId, status: "held" },
      { messageId, status: "refused" },
    ]);
    await receipt(reply, status(endpoint, messageId, "delivered"));
    expect(received).toHaveLength(2);
  });

  it.each(["denied", "expired", "delivered", "refused", "dropped"] as const)("forwards the terminal %s status once", async (value) => {
    const { frames, endpoint } = await target();
    const messageId = randomUUID();
    const listener = vi.fn();
    inbox.onReceipt(listener);
    await inbox.send(endpoint, { messageId, text: value });
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    await receipt(frames[0]!.from, status(endpoint, messageId, value));
    await receipt(frames[0]!.from, status(endpoint, messageId, value));
    expect(listener).toHaveBeenCalledExactlyOnceWith({ messageId, status: value });
  });

  it("forgets transcript-confirmed messages and removes receipt listeners", async () => {
    const { frames, endpoint } = await target();
    const first = randomUUID();
    const second = randomUUID();
    const listener = vi.fn();
    const unsubscribe = inbox.onReceipt(listener);
    await inbox.send(endpoint, { messageId: first, text: "confirmed by transcript" });
    await inbox.send(endpoint, { messageId: second, text: "listener removed" });
    await vi.waitFor(() => expect(frames).toHaveLength(2));
    inbox.forget(first);
    await receipt(frames[0]!.from, status(endpoint, first, "held"));
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
    await receipt(frames[1]!.from, status(endpoint, second, "held"));
    expect(listener).not.toHaveBeenCalled();
  });

  it("marks a connection failure before writing as unsubmitted and never retries", async () => {
    const endpoint: DesktopInboxEndpoint = {
      socketPath: join(directory, "absent.sock"), sessionId: randomUUID(), pid: process.pid,
    };
    const error = await inbox.send(endpoint, { messageId: randomUUID(), text: "not sent" }).catch((value) => value);
    expect(error).toBeInstanceOf(InboxSendError);
    expect(error).toMatchObject({ submitted: false, cause: { code: "ENOENT" } });
  });

  it("marks a peer disconnect during a buffered write as uncertain and never retries", async () => {
    const socketPath = join(directory, "disconnect.sock");
    const accepted = vi.fn((socket: Socket) => socket.destroy());
    const server = createServer(accepted);
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    servers.push(server);
    const error = await inbox.send(
      { socketPath, sessionId: randomUUID(), pid: process.pid },
      { messageId: randomUUID(), text: "x".repeat(4 * 1024 * 1024) },
    ).catch((value) => value);
    expect(error).toBeInstanceOf(InboxSendError);
    expect(error.submitted).toBe(true);
    expect(accepted).toHaveBeenCalledTimes(1);
  });

  it("reports malformed JSON through onError and ignores unrelated external frames", async () => {
    const { frames, endpoint } = await target();
    const messageId = randomUUID();
    const errors = vi.fn();
    const receipts = vi.fn();
    inbox.onError(errors);
    inbox.onReceipt(receipts);
    await inbox.send(endpoint, { messageId, text: "parse boundary" });
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    await receipt(frames[0]!.from, ["unknown", { type: "other" }]);
    await receipt(frames[0]!.from, status(endpoint, messageId, "unknown-status"));
    await receipt(frames[0]!.from, status(endpoint, messageId, "held", { msgV: 2 }));
    expect(receipts).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
    await receipt(frames[0]!.from, `{broken JSON\n${JSON.stringify(status(endpoint, messageId, "held"))}`);
    expect(errors).toHaveBeenCalledExactlyOnceWith(expect.any(SyntaxError));
    expect(receipts).toHaveBeenCalledExactlyOnceWith({ messageId, status: "held" });
  });

  it("does not submit a pending send when close starts before its write", async () => {
    const { endpoint, frames } = await target();
    await inbox.send(endpoint, { messageId: randomUUID(), text: "establish reply listener" });
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    const sending = inbox.send(endpoint, { messageId: randomUUID(), text: "shutdown pending" });
    const closing = inbox.close();
    await expect(sending).rejects.toMatchObject({ submitted: false });
    await closing;
    expect(frames).toHaveLength(1);
  });

  it("closes its reply socket and refuses future sends", async () => {
    const { frames, endpoint } = await target();
    await inbox.send(endpoint, { messageId: randomUUID(), text: "before close" });
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    const reply = decodeURIComponent(frames[0]!.from.slice(4));
    await inbox.close();
    await expect(stat(reply)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(inbox.send(endpoint, { messageId: randomUUID(), text: "after close" }))
      .rejects.toMatchObject({ submitted: false });
    expect(frames).toHaveLength(1);
  });
});
