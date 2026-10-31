import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import type { PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import { BRIDGE_HOOK_URL } from "./connector.js";
import type { PermissionBroker } from "./permission-broker.js";

const HOOK_EVENTS = [
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
  "SessionEnd",
] as const;

const HOOK_PATH = "/hooks/claude-permission";
export const BRIDGE_PERMISSION_HOST_ENV = "BRIDGE_PERMISSION_HOST";
export const BRIDGE_PERMISSION_HOST_HEADER = "X-Bridge-Permission-Host";

export interface ClaudePermissionHookOptions {
  settingsPath: string;
  broker: PermissionBroker;
  sessionId(nativeSessionId: string): string | undefined;
}

interface PendingHookPermission {
  id: string;
  nativeSessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  inputKey: string;
  controller: AbortController;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!isRecord(value)) return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function matchesPendingToolInput(
  entry: PendingHookPermission,
  postInput: Record<string, unknown>,
  postInputKey: string,
): boolean {
  if (entry.inputKey === postInputKey || entry.toolName === "AskUserQuestion") return true;
  const keys = Object.keys(entry.toolInput);
  return keys.length > 0 && keys.every((key) => (
    key in postInput && canonicalJson(postInput[key]) === canonicalJson(entry.toolInput[key])
  ));
}

const INITIAL_TAIL_BYTES = 512 * 1024;
const MAX_DELTA_READ_BYTES = 2 * 1024 * 1024;

async function watchTranscriptResolution(
  transcriptPath: string,
  toolName: string,
  inputKey: string,
  signal: AbortSignal,
  onResolved: () => void,
): Promise<void> {
  let matchedToolUseId: string | undefined;
  let byteOffset = 0;
  let sawPostRequestBoundary = false;
  let scanning = false;

  const inspectPostBoundaryLine = (line: string): void => {
    if (!line.trim()) return;
    let record: unknown;
    try {
      record = JSON.parse(line) as unknown;
    } catch {
      return;
    }
    if (!isRecord(record) || record.isSidechain === true) return;
    const message = isRecord(record.message) ? record.message : undefined;
    const content = Array.isArray(message?.content) ? message.content : [];
    if (record.type === "assistant" && !matchedToolUseId) {
      for (const block of content) {
        if (
          isRecord(block) &&
          block.type === "tool_use" &&
          block.name === toolName &&
          typeof block.id === "string" &&
          canonicalJson(isRecord(block.input) ? block.input : {}) === inputKey
        ) {
          matchedToolUseId = block.id;
        }
      }
    }
    if (record.type === "user") {
      for (const block of content) {
        if (!isRecord(block)) continue;
        if (
          block.type === "tool_result" &&
          Boolean(matchedToolUseId) &&
          block.tool_use_id === matchedToolUseId
        ) {
          sawPostRequestBoundary = true;
          break;
        }
        if (
          block.type === "text" &&
          typeof block.text === "string" &&
          block.text.includes("[Request interrupted by user")
        ) {
          sawPostRequestBoundary = true;
          break;
        }
      }
    }
  };

  const scan = async (initial: boolean): Promise<boolean> => {
    if (initial) {
      const handle = await open(transcriptPath, "r").catch(() => undefined);
      if (!handle) return false;
      try {
        const stats = await handle.stat();
        const startOffset = Math.max(0, stats.size - INITIAL_TAIL_BYTES);
        const length = stats.size - startOffset;
        if (length <= 0) {
          byteOffset = 0;
          return false;
        }
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(buffer, 0, length, startOffset);
        if (bytesRead <= 0) {
          byteOffset = startOffset;
          return false;
        }
        const slice = buffer.subarray(0, bytesRead);
        const lastNewline = slice.lastIndexOf(0x0a);
        const completeSlice = lastNewline >= 0 ? slice.subarray(0, lastNewline) : slice;
        byteOffset = lastNewline >= 0 ? startOffset + lastNewline + 1 : startOffset + bytesRead;
        let text = completeSlice.toString("utf8");
        if (startOffset > 0) {
          const firstNewline = text.indexOf("\n");
          text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
        }
        const lines = text.split("\n").filter((line) => line.trim().length > 0);
        let inspectFrom = lines.length;
        for (let index = lines.length - 1; index >= 0; index -= 1) {
          try {
            const record = JSON.parse(lines[index]!) as unknown;
            if (!isRecord(record) || record.isSidechain === true) continue;
            const message = isRecord(record.message) ? record.message : undefined;
            const content = Array.isArray(message?.content) ? message.content : [];
            for (const block of content) {
              if (
                isRecord(block) &&
                block.type === "tool_use" &&
                block.name === toolName &&
                typeof block.id === "string" &&
                canonicalJson(isRecord(block.input) ? block.input : {}) === inputKey
              ) {
                matchedToolUseId = block.id;
                inspectFrom = index + 1;
                break;
              }
            }
            if (matchedToolUseId) break;
          } catch {
            // Ignore malformed transcript lines.
          }
        }
        for (let index = inspectFrom; index < lines.length; index += 1) {
          inspectPostBoundaryLine(lines[index]!);
        }
        return sawPostRequestBoundary;
      } catch {
        return false;
      } finally {
        await handle.close().catch(() => undefined);
      }
    }

    const stats = await stat(transcriptPath).catch(() => undefined);
    if (!stats || stats.size <= byteOffset) return sawPostRequestBoundary;
    const handle = await open(transcriptPath, "r").catch(() => undefined);
    if (!handle) return sawPostRequestBoundary;
    try {
      const length = Math.min(stats.size - byteOffset, MAX_DELTA_READ_BYTES);
      if (length <= 0) return sawPostRequestBoundary;
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, byteOffset);
      if (bytesRead <= 0) return sawPostRequestBoundary;
      const slice = buffer.subarray(0, bytesRead);
      const lastNewline = slice.lastIndexOf(0x0a);
      if (lastNewline < 0) {
        if (byteOffset + bytesRead >= stats.size) {
          inspectPostBoundaryLine(slice.toString("utf8"));
          byteOffset += bytesRead;
        }
        return sawPostRequestBoundary;
      }
      const chunk = slice.subarray(0, lastNewline).toString("utf8");
      byteOffset += lastNewline + 1;
      for (const line of chunk.split("\n")) {
        inspectPostBoundaryLine(line);
      }
      return sawPostRequestBoundary;
    } catch {
      return sawPostRequestBoundary;
    } finally {
      await handle.close().catch(() => undefined);
    }
  };

  if (await scan(true)) {
    onResolved();
    return;
  }
  const timer = setInterval(() => {
    if (scanning) return;
    scanning = true;
    void scan(false)
      .then((resolved) => {
        if (resolved) {
          clearInterval(timer);
          onResolved();
        }
      })
      .finally(() => {
        scanning = false;
      });
  }, 120);
  timer.unref?.();
  signal.addEventListener("abort", () => clearInterval(timer), { once: true });
}

function isBridgeHookUrl(url: unknown): boolean {
  if (typeof url !== "string") return false;
  if (url === BRIDGE_HOOK_URL) return true;
  try {
    const parsed = new URL(url);
    return parsed.hostname === "127.0.0.1" && parsed.pathname === HOOK_PATH;
  } catch {
    return false;
  }
}

export class ClaudePermissionHook {
  private server: Server | undefined;
  private token = "";
  private url = "";
  private readonly pending = new Map<string, PendingHookPermission>();

  constructor(private readonly options: ClaudePermissionHookOptions) {}

  async start(): Promise<void> {
    if (this.server) return;
    this.token = randomBytes(32).toString("base64url");
    const server = createServer((req, res) => {
      void this.handleRequest(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("Failed to bind Claude permission hook server");
    }
    this.server = server;
    this.url = `http://127.0.0.1:${address.port}${HOOK_PATH}`;
    await this.syncSettings(true);
  }

  async close(): Promise<void> {
    for (const entry of this.pending.values()) entry.controller.abort();
    this.pending.clear();
    const server = this.server;
    this.server = undefined;
    if (server) {
      await new Promise((resolve) => setImmediate(resolve));
      server.closeIdleConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await this.syncSettings(false).catch(() => undefined);
  }

  private authorized(header: string | undefined): boolean {
    if (!header || !this.token) return false;
    const expected = Buffer.from(`Bearer ${this.token}`, "utf8");
    const actual = Buffer.from(header, "utf8");
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST" || req.url !== HOOK_PATH) {
      res.writeHead(404).end();
      return;
    }
    if (!this.authorized(req.headers.authorization)) {
      res.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    let raw = "";
    try {
      req.setEncoding("utf8");
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 4 * 1024 * 1024) {
          res.writeHead(413).end();
          return;
        }
      }
    } catch {
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }
    if (!isRecord(body) || typeof body.session_id !== "string" || typeof body.hook_event_name !== "string") {
      res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Invalid hook payload" }));
      return;
    }
    const hostHeader = req.headers[BRIDGE_PERMISSION_HOST_HEADER.toLowerCase()];
    if (hostHeader === "sdk") {
      res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
      return;
    }
    const nativeSessionId = body.session_id;
    const eventName = body.hook_event_name;

    if (eventName === "PostToolUse" || eventName === "PostToolUseFailure") {
      if (typeof body.tool_name === "string") {
        const postInput = isRecord(body.tool_input) ? body.tool_input : {};
        const inputKey = canonicalJson(postInput);
        for (const entry of this.pending.values()) {
          if (
            entry.nativeSessionId === nativeSessionId &&
            entry.toolName === body.tool_name &&
            matchesPendingToolInput(entry, postInput, inputKey)
          ) {
            entry.controller.abort();
          }
        }
      }
      res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
      return;
    }

    if (eventName === "Stop" || eventName === "SessionEnd") {
      for (const entry of this.pending.values()) {
        if (entry.nativeSessionId === nativeSessionId) entry.controller.abort();
      }
      res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
      return;
    }

    if (eventName !== "PermissionRequest" || typeof body.tool_name !== "string") {
      res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Unsupported hook event" }));
      return;
    }

    const logicalSessionId = this.options.sessionId(nativeSessionId);
    if (!logicalSessionId) {
      res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
      return;
    }

    const toolInput = isRecord(body.tool_input) ? body.tool_input : {};
    const inputKey = canonicalJson(toolInput);
    const controller = new AbortController();
    const id = randomUUID();
    this.pending.set(id, {
      id,
      nativeSessionId,
      toolName: body.tool_name,
      toolInput,
      inputKey,
      controller,
    });
    if (typeof body.transcript_path === "string" && body.transcript_path.trim()) {
      void watchTranscriptResolution(
        body.transcript_path,
        body.tool_name,
        inputKey,
        controller.signal,
        () => controller.abort(),
      );
    }
    res.once("close", () => {
      if (!res.writableEnded) controller.abort();
    });

    try {
      const suggestions = Array.isArray(body.permission_suggestions)
        ? body.permission_suggestions as PermissionUpdate[]
        : undefined;
      const description = typeof body.description === "string"
        ? body.description
        : typeof toolInput.description === "string"
          ? toolInput.description
          : undefined;
      const result = await this.options.broker.request(logicalSessionId, body.tool_name, toolInput, {
        signal: controller.signal,
        toolUseId: typeof body.tool_use_id === "string" ? body.tool_use_id : id,
        manualOnly: true,
        ...(suggestions ? { suggestions } : {}),
        ...(typeof body.title === "string" ? { title: body.title } : {}),
        ...(typeof body.display_name === "string" ? { displayName: body.display_name } : {}),
        ...(description ? { description } : {}),
      });
      if (res.writableEnded) return;
      if (
        controller.signal.aborted ||
        (result.behavior === "deny" && result.message === "Bridge session ended before this request was answered.")
      ) {
        res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
        return;
      }
      const updatedInput = result.behavior === "allow" &&
        result.updatedInput &&
        canonicalJson(result.updatedInput) !== inputKey
        ? result.updatedInput
        : undefined;
      const decision = result.behavior === "allow"
        ? {
            behavior: "allow" as const,
            ...(updatedInput ? { updatedInput } : {}),
            ...(result.updatedPermissions?.length ? { updatedPermissions: result.updatedPermissions } : {}),
          }
        : {
            behavior: "deny" as const,
            ...(result.message ? { message: result.message } : {}),
          };
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision,
        },
      }));
    } finally {
      this.pending.delete(id);
    }
  }

  private async syncSettings(enable: boolean): Promise<void> {
    let settings: Record<string, unknown> = {};
    try {
      const raw = JSON.parse(await readFile(this.options.settingsPath, "utf8")) as unknown;
      if (isRecord(raw)) settings = raw;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const existingHooks = isRecord(settings.hooks) ? settings.hooks : {};
    const nextHooks: Record<string, unknown> = {};

    for (const [event, groupsValue] of Object.entries(existingHooks)) {
      if (!Array.isArray(groupsValue)) {
        nextHooks[event] = groupsValue;
        continue;
      }
      const cleaned = groupsValue.flatMap((group) => {
        if (!isRecord(group) || !Array.isArray(group.hooks)) return [group];
        const hooks = group.hooks.filter((hook) => !(
          isRecord(hook) &&
          hook.type === "http" &&
          (enable ? isBridgeHookUrl(hook.url) : hook.url === this.url)
        ));
        return hooks.length > 0 ? [{ ...group, hooks }] : [];
      });
      if (cleaned.length > 0) nextHooks[event] = cleaned;
    }

    if (enable && this.url && this.token) {
      for (const event of HOOK_EVENTS) {
        const current = Array.isArray(nextHooks[event]) ? nextHooks[event] as unknown[] : [];
        nextHooks[event] = [
          ...current,
          {
            hooks: [
              {
                type: "http",
                url: this.url,
                timeout: event === "PermissionRequest" ? 600 : 5,
                headers: {
                  Authorization: `Bearer ${this.token}`,
                  [BRIDGE_PERMISSION_HOST_HEADER]: `$${BRIDGE_PERMISSION_HOST_ENV}`,
                },
                allowedEnvVars: [BRIDGE_PERMISSION_HOST_ENV],
              },
            ],
          },
        ];
      }
    }

    const nextSettings = { ...settings };
    if (Object.keys(nextHooks).length > 0) nextSettings.hooks = nextHooks;
    else delete nextSettings.hooks;

    await mkdir(dirname(this.options.settingsPath), { recursive: true });
    const temporary = `${this.options.settingsPath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(nextSettings, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.options.settingsPath);
  }
}
