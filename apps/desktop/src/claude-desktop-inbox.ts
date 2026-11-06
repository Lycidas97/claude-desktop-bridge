import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";

export interface DesktopInboxEndpoint {
  socketPath: string;
  sessionId: string;
  pid: number;
}

export type DesktopInboxReceiptStatus = "held" | "denied" | "expired" | "delivered" | "refused" | "dropped";

export interface DesktopInboxReceipt {
  messageId: string;
  status: DesktopInboxReceiptStatus;
}

export class InboxSendError extends Error {
  constructor(message: string, readonly submitted: boolean, options?: ErrorOptions) {
    super(message, options);
    this.name = "InboxSendError";
  }
}

interface ReplyServer {
  path: string;
  server: Server;
  ready: Promise<void>;
}

const receiptStatuses = new Set<unknown>(["held", "denied", "expired", "delivered", "refused", "dropped"]);

function address(socketPath: string): string {
  return `uds:${socketPath.replace(/[^A-Za-z0-9:_/.\\-]/gu, (character) =>
    [...Buffer.from(character)].map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`).join(""))}`;
}

/** The caller supplies an OS-verified Desktop owner; all sockets live in this process. */
export class ClaudeDesktopInbox {
  private readonly events = new EventEmitter();
  private readonly replies = new Map<string, ReplyServer>();
  private readonly pending = new Map<string, { from: string; socket: Socket }>();
  private readonly connections = new Set<Socket>();
  private closed = false;

  /** Resolves after writing, without asserting that the native executor accepted the message. */
  async send(endpoint: DesktopInboxEndpoint, input: { messageId: string; text: string }): Promise<void> {
    if (process.platform !== "darwin") throw new InboxSendError("Desktop inbox is only enabled on macOS", false);
    if (this.closed) throw new InboxSendError("Desktop inbox is closed", false);
    const reply = this.replyServer(dirname(endpoint.socketPath));
    try {
      await reply.ready;
    } catch (error) {
      throw new InboxSendError("Could not open the Desktop inbox reply socket", false, { cause: error });
    }
    if (this.closed) throw new InboxSendError("Desktop inbox is closed", false);
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(endpoint.socketPath);
      this.connections.add(socket);
      this.pending.set(input.messageId, { from: address(endpoint.socketPath), socket });
      let submitted = false;
      let written = false;
      socket.once("error", (error) => reject(new InboxSendError("Could not write to the Desktop inbox", submitted, { cause: error })));
      socket.once("close", () => {
        this.connections.delete(socket);
        if (!written) reject(new InboxSendError("Desktop inbox connection closed before the write completed", submitted));
        if (!submitted) this.pending.delete(input.messageId);
      });
      socket.once("connect", () => {
        submitted = true;
        socket.write(`${JSON.stringify({
          msgV: 1,
          msg_id: input.messageId,
          type: "user",
          uuid: input.messageId,
          session_id: endpoint.sessionId,
          from: address(reply.path),
          message: { role: "user", content: input.text },
          priority: "next",
        })}\n`, (error) => {
          if (error) {
            reject(new InboxSendError("Could not write to the Desktop inbox", submitted, { cause: error }));
            return;
          }
          // Native peer credentials are read from the live connection when the line arrives.
          // Keep it open until a receipt or transcript confirmation releases this message.
          written = true;
          resolve();
        });
      });
    });
  }

  onReceipt(listener: (receipt: DesktopInboxReceipt) => void): () => void {
    this.events.on("receipt", listener);
    return () => { this.events.off("receipt", listener); };
  }

  onError(listener: (error: Error) => void): () => void {
    this.events.on("error", listener);
    return () => { this.events.off("error", listener); };
  }

  /** Release a message after its UUID appears in the transcript or the caller abandons it. */
  forget(messageId: string): void {
    this.pending.get(messageId)?.socket.end();
    this.pending.delete(messageId);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const socket of this.connections) socket.destroy();
    await Promise.all([...this.replies.values()].map(async ({ ready, server }) => {
      // A failed listener startup has already been returned to its send() caller.
      if ((await Promise.allSettled([ready]))[0]!.status === "rejected") return;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }));
    this.replies.clear();
    this.pending.clear();
    this.events.removeAllListeners();
  }

  private replyServer(directory: string): ReplyServer {
    const existing = this.replies.get(directory);
    if (existing) return existing;
    const path = join(directory, `bridge-${process.pid}-${randomUUID().slice(0, 8)}.sock`);
    const server = createServer((socket) => {
      this.connections.add(socket);
      socket.once("close", () => this.connections.delete(socket));
      socket.on("error", (error) => this.events.emit("error", error));
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        for (let newline; (newline = buffer.indexOf("\n")) >= 0;) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          this.receive(line);
        }
      });
    });
    const ready = new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => {
        server.off("error", reject);
        server.on("error", (error) => this.events.emit("error", error));
        resolve();
      });
    }).then(() => chmod(path, 0o600));
    const reply = { path, server, ready };
    this.replies.set(directory, reply);
    return reply;
  }

  private receive(line: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      this.events.emit("error", error);
      return;
    }
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) return;
    const value = frame as Record<string, unknown>;
    if (
      value.msgV !== 1 || value.type !== "control" || value.action !== "peer_message_status" ||
      typeof value.msg_id !== "string" || typeof value.orig_msg_id !== "string" ||
      typeof value.from !== "string" || !receiptStatuses.has(value.status) ||
      (value.status_detail !== undefined && value.status_detail !== "refused")
    ) return;
    if (this.pending.get(value.orig_msg_id)?.from !== value.from) return;
    const status = value.status === "expired" && value.status_detail === "refused"
      ? "refused" : value.status as DesktopInboxReceiptStatus;
    if (status !== "held") this.forget(value.orig_msg_id);
    this.events.emit("receipt", { messageId: value.orig_msg_id, status } satisfies DesktopInboxReceipt);
  }
}
