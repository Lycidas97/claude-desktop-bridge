import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ARTIFACT_TRANSFER_TTL_MS,
  TOOL_DETAIL_MAX_BYTES,
  type BridgeRequest,
  type DecryptedEnvelope,
  type EncryptedEnvelope,
} from "@bridge/protocol";
import { ClaudeDesktopBridge, nativeHistoryItems } from "../claude/claude-desktop-bridge.js";
import type { ClaudeDesktopInspector } from "../claude/claude-desktop-inspector.js";
import { DesktopController } from "../controller/controller.js";
import { ConversationStateStore } from "../controller/conversation-state-store.js";
import { SessionEventLog } from "../controller/session-event-log.js";
import { deliverTransportMessage } from "../transport/controller-transport.js";
import {
  extractToolCallDetailFromMessages,
  readSubagentToolCallDetail,
  summarizeNativeToolInput,
  truncateUtf8,
} from "./transcript-tool-detail.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("extractToolCallDetailFromMessages", () => {
  it("extracts plain string tool_result and full input for completed calls", () => {
    const detail = extractToolCallDetailFromMessages({
      sessionId: "local_1",
      toolUseId: "toolu_bash_1",
      messages: [
        {
          type: "assistant",
          uuid: "a1",
          message: {
            content: [
              {
                type: "tool_use",
                id: "toolu_bash_1",
                name: "Bash",
                input: { command: "git status -sb", description: "Check branch status" },
              },
            ],
          },
        },
        {
          type: "user",
          uuid: "u1",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_bash_1",
                content: "## main...origin/main\n M apps/client/src/App.tsx\n",
              },
            ],
          },
        },
      ],
    });

    expect(detail).toEqual({
      sessionId: "local_1",
      toolUseId: "toolu_bash_1",
      toolName: "Bash",
      input: { command: "git status -sb", description: "Check branch status" },
      status: "completed",
      outputText: "## main...origin/main\n M apps/client/src/App.tsx\n",
      truncated: false,
      totalBytes: Buffer.byteLength("## main...origin/main\n M apps/client/src/App.tsx\n", "utf8"),
    });
  });

  it.each(["user", "queued", "system"])("includes matching Bash completion content from %s notifications", (kind) => {
    const notification = "<task-notification>\n<task-id>bsh01</task-id>\n<status>failed</status>\n<summary>Client build failed with exit code 2</summary>\n</task-notification>";
    const messages = [
      { type: "assistant", message: { content: [{ type: "tool_use", id: "bash-call", name: "Bash", input: { command: "npm run build", run_in_background: true } }] } },
      { type: "user", toolUseResult: { stdout: "", stderr: "", backgroundTaskId: "bsh01" }, message: {
        content: [{ type: "tool_result", tool_use_id: "bash-call", content: "Command running in background with ID: bsh01" }],
      } },
      ...(kind === "system"
        ? [{ type: "system", subtype: "task_notification", task_id: "bsh01", status: "failed", summary: "Client build failed with exit code 2" }]
        : kind === "user"
          ? [{ type: "user", message: { role: "user", content: notification } }]
          : [{ type: "attachment", attachment: { type: "queued_command", commandMode: "task-notification", origin: { kind: "task-notification", producer: "session-task" }, prompt: notification } }]),
    ];
    // User/queued notifications are hidden; system notifications appear only in their loaded history page.
    if (kind === "system") expect(JSON.stringify(nativeHistoryItems("local_1", messages))).toContain("Client build failed with exit code 2");
    else expect(JSON.stringify(nativeHistoryItems("local_1", messages))).not.toContain("Client build failed with exit code 2");
    const detail = extractToolCallDetailFromMessages({ sessionId: "local_1", toolUseId: "bash-call", messages });
    expect(detail?.outputText).toContain("Command running in background with ID: bsh01");
    expect(detail?.outputText).toContain("Client build failed with exit code 2");
    expect(detail?.outputText).not.toContain("<task-notification>");
    expect(detail?.outputText).not.toContain("<summary>");
    expect(detail?.status).toBe("completed");
    expect(detail?.isError).toBeUndefined();
    expect(detail?.totalBytes).toBe(Buffer.byteLength(detail!.outputText!, "utf8"));
  });

  it("redacts and bounds notification output carried in user text blocks", () => {
    const notification = `<task-notification><task-id>bsh01</task-id><status>completed</status><output>Authorization: Bearer notification-secret-value\n${"中文日志🚀".repeat(1_000)}</output></task-notification>`;
    const detail = extractToolCallDetailFromMessages({ sessionId: "local_1", toolUseId: "bash-call", maxBytes: 160, messages: [
      { type: "assistant", message: { content: [{ type: "tool_use", id: "bash-call", name: "Bash", input: { command: "npm test" } }] } },
      { type: "user", toolUseResult: { backgroundTaskId: "bsh01" }, message: { content: [{ type: "tool_result", tool_use_id: "bash-call", content: "Background task launched" }] } },
      { type: "user", message: { content: [{ type: "text", text: notification }] } },
    ] });
    expect(detail?.outputText).toContain("中文日志");
    expect(detail?.outputText).not.toContain("notification-secret-value");
    expect(detail?.outputText).not.toContain("�");
    expect(detail?.truncated).toBe(true);
    expect(detail?.totalBytes).toBeGreaterThan(160);
    expect(Buffer.byteLength(detail!.outputText!, "utf8")).toBeLessThanOrEqual(160);
  });

  it("preserves launch output when the Bash task has no completion text, or none for this task", () => {
    const messages = [
      { type: "assistant", message: { content: [{ type: "tool_use", id: "bash-call", name: "Bash", input: { command: "npm test" } }] } },
      { type: "user", toolUseResult: { backgroundTaskId: "bsh01" }, message: { content: [
        { type: "tool_result", tool_use_id: "bash-call", content: "Command running in background with ID: bsh01" },
      ] } },
      { type: "user", message: { content: "<task-notification><task-id>other</task-id><status>completed</status><summary>Other task output</summary></task-notification>" } },
      { type: "user", isSidechain: true, message: { content: "<task-notification><task-id>bsh01</task-id><status>completed</status><summary>Child task output</summary></task-notification>" } },
      { type: "system", subtype: "task_notification", task_id: "other", status: "completed", summary: "Other system task output" },
      { type: "system", subtype: "task_notification", isSidechain: true, task_id: "bsh01", status: "completed", summary: "Child system task output" },
    ];
    const detail = extractToolCallDetailFromMessages({ sessionId: "local_1", toolUseId: "bash-call", messages });
    expect(detail?.outputText).toBe("Command running in background with ID: bsh01");
  });

  it("returns an empty result when a Bash task has neither launch nor notification text", () => {
    const detail = extractToolCallDetailFromMessages({ sessionId: "local_1", toolUseId: "bash-call", messages: [
      { type: "assistant", message: { content: [{ type: "tool_use", id: "bash-call", name: "Bash", input: { command: "npm test" } }] } },
      { type: "user", toolUseResult: { backgroundTaskId: "bsh01" }, message: { content: [{ type: "tool_result", tool_use_id: "bash-call", content: "" }] } },
    ] });
    expect(detail).toMatchObject({ status: "completed", outputText: "", truncated: false, totalBytes: 0 });
  });

  it("extracts array content blocks, strips hidden thinking blocks, and converts non-text blocks to placeholders without base64", () => {
    const fakeBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const detail = extractToolCallDetailFromMessages({
      sessionId: "local_1",
      toolUseId: "toolu_read_img",
      messages: [
        {
          type: "assistant",
          message: {
            content: [
              { type: "thinking", thinking: "SECRET_INTERNAL_COT" },
              { type: "tool_use", id: "toolu_read_img", name: "Read", input: { file_path: "/project/diagram.png" } },
            ],
          },
        },
        {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_read_img",
                content: [
                  { type: "thinking", thinking: "HIDDEN_RESULT_THINKING" },
                  { type: "text", text: "Image dimensions: 1200x800" },
                  { type: "image", source: { type: "base64", media_type: "image/png", data: fakeBase64 } },
                  { type: "image", source: { type: "base64", media_type: "image/png", data: fakeBase64 } },
                  { type: "document", media_type: "application/pdf", data: "JVBERi0xLjQK" },
                ],
              },
            ],
          },
        },
      ],
    });

    expect(detail).toEqual({
      sessionId: "local_1",
      toolUseId: "toolu_read_img",
      toolName: "Read",
      input: { file_path: "/project/diagram.png" },
      status: "completed",
      outputText: "Image dimensions: 1200x800",
      omittedBlocks: [
        { type: "image", mimeType: "image/png", count: 2 },
        { type: "document", mimeType: "application/pdf", count: 1 },
      ],
      truncated: false,
      totalBytes: Buffer.byteLength("Image dimensions: 1200x800", "utf8"),
    });
    expect(JSON.stringify(detail)).not.toContain(fakeBase64);
    expect(JSON.stringify(detail)).not.toContain("THINKING");
    expect(JSON.stringify(detail)).not.toContain("SECRET_INTERNAL_COT");
  });

  it("marks is_error tool_result as status=error and isError=true", () => {
    const detail = extractToolCallDetailFromMessages({
      sessionId: "local_1",
      toolUseId: "toolu_err",
      messages: [
        {
          type: "assistant",
          message: { content: [{ type: "tool_use", id: "toolu_err", name: "Bash", input: { command: "exit 1" } }] },
        },
        {
          type: "user",
          message: {
            content: [{ type: "tool_result", tool_use_id: "toolu_err", is_error: true, content: "Command failed with exit code 1" }],
          },
        },
      ],
    });

    expect(detail).toMatchObject({
      status: "error",
      isError: true,
      outputText: "Command failed with exit code 1",
    });
  });

  it("returns status=running when tool_use has not yet produced a tool_result, and undefined for unknown or hidden IDs", () => {
    const messages = [
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "toolu_running", name: "Bash", input: { command: "npm test" } },
            { type: "tool_use", id: "plan_1", name: "mcp__ccd_turn__update_plan", input: { items: [] } },
          ],
        },
      },
      {
        type: "assistant",
        isSidechain: true,
        message: { content: [{ type: "tool_use", id: "sidechain_tool", name: "Read", input: { file_path: "/side.ts" } }] },
      },
    ];

    expect(extractToolCallDetailFromMessages({ sessionId: "local_1", toolUseId: "toolu_running", messages })).toEqual({
      sessionId: "local_1",
      toolUseId: "toolu_running",
      toolName: "Bash",
      input: { command: "npm test" },
      status: "running",
      truncated: false,
      totalBytes: 0,
    });
    expect(extractToolCallDetailFromMessages({ sessionId: "local_1", toolUseId: "unknown_id", messages })).toBeUndefined();
    expect(extractToolCallDetailFromMessages({ sessionId: "local_1", toolUseId: "plan_1", messages })).toBeUndefined();
    expect(extractToolCallDetailFromMessages({ sessionId: "local_1", toolUseId: "sidechain_tool", messages })).toBeUndefined();
  });

  it("truncates oversized UTF-8 output cleanly on codepoint boundaries and redacts secrets", () => {
    const multiByte = "中文日志行🚀\n".repeat(30_000);
    expect(Buffer.byteLength(multiByte, "utf8")).toBeGreaterThan(TOOL_DETAIL_MAX_BYTES);

    const detail = extractToolCallDetailFromMessages({
      sessionId: "local_1",
      toolUseId: "toolu_huge",
      messages: [
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "toolu_huge",
                name: "Bash",
                input: { command: "curl -H 'Authorization: Bearer secret-bearer-value' https://example.com" },
              },
            ],
          },
        },
        {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_huge",
                content: `token=sk-1234567890abcdefghijklmnop\n${multiByte}`,
              },
            ],
          },
        },
      ],
    });

    expect(detail?.truncated).toBe(true);
    expect(detail?.totalBytes).toBeGreaterThan(TOOL_DETAIL_MAX_BYTES);
    expect(Buffer.byteLength(detail?.outputText ?? "", "utf8")).toBeLessThanOrEqual(TOOL_DETAIL_MAX_BYTES);
    expect(detail?.outputText).not.toContain("�");
    expect(detail?.outputText).not.toContain("sk-1234567890abcdefghijklmnop");
    expect(detail?.outputText).toContain("[已隐藏令牌]");
    expect(String(detail?.input.command)).not.toContain("secret-bearer-value");
    expect(String(detail?.input.command)).toContain("[已隐藏]");

    // Direct UTF-8 boundary check cutting right inside a 4-byte emoji
    const cutEmoji = truncateUtf8("abc🚀def", 5);
    expect(cutEmoji).toEqual({ text: "abc", totalBytes: 10, truncated: true });
  });

  it("redacts credential fields at every nesting level while preserving ordinary input structure", () => {
    const detail = extractToolCallDetailFromMessages({
      sessionId: "local_1",
      toolUseId: "toolu_credentials",
      messages: [{
        type: "assistant",
        message: { content: [{
          type: "tool_use",
          id: "toolu_credentials",
          name: "CustomTool",
          input: {
            client_secret: "synthetic-client-secret",
            nested: { access_token: "synthetic-access-token", enabled: true },
            accounts: [{ "api-key": "synthetic key with spaces", label: "primary" }],
            headers: { Authorization: 'Bearer "synthetic-quoted-token"' },
            command: "curl -H 'Authorization: Bearer synthetic-inline-token' https://example.com",
            count: 2,
          },
        }] },
      }],
    });

    expect(detail?.input).toEqual({
      client_secret: "[已隐藏]",
      nested: { access_token: "[已隐藏]", enabled: true },
      accounts: [{ "api-key": "[已隐藏]", label: "primary" }],
      headers: { Authorization: "[已隐藏]" },
      command: "curl -H 'Authorization: [已隐藏]' https://example.com",
      count: 2,
    });
    expect(JSON.stringify(detail)).not.toContain("synthetic-client-secret");
  });

  it("bounds oversized tool input payloads above 256 KiB via inputText and inputTruncated", () => {
    const hugeContent = "x".repeat(TOOL_DETAIL_MAX_BYTES + 4096);
    const detail = extractToolCallDetailFromMessages({
      sessionId: "local_1",
      toolUseId: "toolu_write_huge",
      messages: [
        {
          type: "assistant",
          message: {
            content: [{ type: "tool_use", id: "toolu_write_huge", name: "Write", input: { file_path: "/a.txt", content: hugeContent } }],
          },
        },
      ],
    });

    expect(detail?.inputTruncated).toBe(true);
    expect(detail?.input).toEqual({});
    expect(Buffer.byteLength(detail?.inputText ?? "", "utf8")).toBeLessThanOrEqual(TOOL_DETAIL_MAX_BYTES);
  });

  it("reads nested workflow subagent JSONL records even without record UUIDs", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-tool-detail-subagent-"));
    tempDirs.push(root);
    const transcriptPath = join(root, "main-session.jsonl");
    await writeFile(transcriptPath, "");
    const nestedDir = join(root, "main-session", "subagents", "workflows", "wf_review");
    await mkdir(nestedDir, { recursive: true });
    await writeFile(
      join(nestedDir, "agent-sub_42.jsonl"),
      [
        JSON.stringify({
          type: "assistant",
          isSidechain: true,
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id: "sub_tool_1", name: "Grep", input: { pattern: "readToolDetail", path: "apps/desktop" } }],
          },
        }),
        JSON.stringify({
          type: "user",
          isSidechain: true,
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "sub_tool_1", content: "apps/desktop/src/claude/claude-desktop-bridge.ts:581" }],
          },
        }),
      ].join("\n") + "\n",
    );

    const detail = await readSubagentToolCallDetail({
      sessionId: "local_1",
      transcriptPath,
      agentId: "sub_42",
      toolUseId: "sub_tool_1",
    });

    expect(detail).toEqual({
      sessionId: "local_1",
      toolUseId: "sub_tool_1",
      agentId: "sub_42",
      toolName: "Grep",
      input: { pattern: "readToolDetail", path: "apps/desktop" },
      status: "completed",
      outputText: "apps/desktop/src/claude/claude-desktop-bridge.ts:581",
      truncated: false,
      totalBytes: Buffer.byteLength("apps/desktop/src/claude/claude-desktop-bridge.ts:581", "utf8"),
    });
    expect(await readSubagentToolCallDetail({
      sessionId: "local_1",
      transcriptPath,
      agentId: "../main-session",
      toolUseId: "sub_tool_1",
    })).toBeUndefined();
  });
});

describe("zero-bloat timeline projection & RPC wiring", () => {
  it.each(["queued", "system"])("keeps tool bodies out of the timeline and reads unloaded %s Bash notifications through RPC", async (kind) => {
    const dir = await mkdtemp(join(tmpdir(), "bridge-tool-detail-bridge-"));
    tempDirs.push(dir);
    const largeWriteBody = "LARGE_WRITE_BODY_".repeat(5_000);
    const largeToolOutput = "LARGE_TOOL_OUTPUT_".repeat(5_000);
    const transcriptMessages: unknown[] = [];
    let latestPageOnly = false;

    const inspector = Object.assign(new EventEmitter(), {
      ready: true,
      supports: (method: string) => ["getAll", "getSession", "getTranscript", "getTranscriptPage"].includes(method),
      availableCodeModels: async () => [],
      connect: async () => {},
      close: async () => {},
      async call(method: string) {
        if (method === "getAll") return [{ sessionId: "local_native", cwd: "/project", title: "Native", pendingToolPermissions: [] }];
        if (method === "getSession") return { sessionId: "local_native", cwd: "/project", title: "Native", pendingToolPermissions: [] };
        if (method === "getTranscript") return { messages: transcriptMessages };
        if (method === "getTranscriptPage") return { messages: latestPageOnly ? transcriptMessages.slice(-1) : transcriptMessages, hasMore: false };
        throw new Error(`Unexpected method: ${method}`);
      },
    }) as unknown as ClaudeDesktopInspector;

    const state = new ConversationStateStore({
      databasePath: join(dir, "state.sqlite"),
      sessionsPath: join(dir, "sessions.json"),
      queuePath: join(dir, "queue.json"),
      masterSecret: "test-secret",
    });
    await state.initialize();
    const eventLog = new SessionEventLog(join(dir, "events.jsonl"));
    await eventLog.initialize();
    const bridge = new ClaudeDesktopBridge({
      eventLog,
      conversationState: state,
      inspector,
      settingsPath: join(dir, "claude.json"),
      scanCatalog: async () => ({ projects: [], sessions: [], observedAt: Date.now() }),
    });
    await bridge.initialize();

    try {
      const assistantCall = {
        type: "assistant",
        uuid: "call-1",
        message: {
          content: [{ type: "tool_use", id: "write-1", name: "Write", input: { file_path: "/project/big.ts", content: largeWriteBody } }],
        },
      };
      const userResult = {
        type: "user",
        uuid: "res-1",
        message: {
          content: [{ type: "tool_result", tool_use_id: "write-1", content: largeToolOutput }],
        },
      };
      transcriptMessages.push(assistantCall, userResult);

      const projected = nativeHistoryItems("local_native", transcriptMessages);
      expect(projected).toEqual([
        expect.objectContaining({ id: "write-1", toolName: "Write", text: "/project/big.ts" }),
      ]);
      expect(JSON.stringify(projected)).not.toContain("LARGE_WRITE_BODY_");
      expect(JSON.stringify(projected)).not.toContain("LARGE_TOOL_OUTPUT_");
      expect(summarizeNativeToolInput("Bash", { description: "Run tests", command: "npm test" })).toBe("Run tests · npm test");

      (inspector as unknown as EventEmitter).emit("event", { type: "message", sessionId: "local_native", message: assistantCall });
      (inspector as unknown as EventEmitter).emit("event", { type: "message", sessionId: "local_native", message: userResult });
      await vi.waitFor(() => expect(eventLog.latestItem("local_native", "tool.completed", "write-1")).toBeDefined());

      const completedEvent = eventLog.latestItem("local_native", "tool.completed", "write-1")!;
      expect(completedEvent.data.output).toBeUndefined();
      expect(completedEvent.data.text).toBe("/project/big.ts");

      // On-demand RPC retrieves the complete input and output
      const controller = Object.assign(Object.create(DesktopController.prototype), { broker: bridge });
      const req: BridgeRequest = {
        kind: "request",
        requestId: "req-detail",
        idempotencyKey: "idem-detail",
        method: "session.tool.detail",
        params: { sessionId: "local_native", toolUseId: "write-1" },
      };
      const res = await controller.handleRequest(req, "mobile", "phone") as { detail: { input: Record<string, unknown>; outputText?: string } };
      expect(res.detail.input).toEqual({ file_path: "/project/big.ts", content: largeWriteBody });
      expect(res.detail.outputText).toBe(largeToolOutput);

      transcriptMessages.push(
        { type: "assistant", uuid: "bash-use", message: { content: [{ type: "tool_use", id: "bash-1", name: "Bash", input: { command: "npm test" } }] } },
        { type: "user", uuid: "bash-launch", toolUseResult: { backgroundTaskId: "bsh01" }, message: { content: [
          { type: "tool_result", tool_use_id: "bash-1", content: "Command running in background with ID: bsh01" },
        ] } },
        kind === "system"
          ? { type: "system", subtype: "task_notification", task_id: "bsh01", status: "completed", summary: "Earlier Bash finished with exit code 0" }
          : { type: "attachment", attachment: { type: "queued_command", commandMode: "task-notification", prompt:
            "<task-notification><task-id>bsh01</task-id><status>completed</status><summary>Earlier Bash finished with exit code 0</summary></task-notification>",
          } },
        { type: "assistant", uuid: "latest-unrelated", message: { content: [{ type: "text", text: "Latest unrelated page" }] } },
      );
      latestPageOnly = true;
      const page = await bridge.history("local_native");
      expect(page.items.map(item => item.text)).toEqual(["Latest unrelated page"]);
      const bash = await controller.handleRequest({ ...req, params: { sessionId: "local_native", toolUseId: "bash-1" } }, "mobile", "phone") as { detail: { outputText: string } };
      expect(bash.detail.outputText).toContain("Earlier Bash finished with exit code 0");
      expect(bash.detail.outputText).toContain("Command running in background with ID: bsh01");

      // Invalid agentId parameter rejected cleanly at boundary
      await expect(
        controller.handleRequest({ ...req, params: { sessionId: "local_native", toolUseId: "write-1", agentId: "" } }, "mobile", "phone"),
      ).rejects.toThrow("agentId");
      await expect(
        controller.handleRequest({ ...req, params: { sessionId: "local_native", toolUseId: "write-1", agentId: 123 } }, "mobile", "phone"),
      ).rejects.toThrow("agentId");
    } finally {
      await bridge.close();
      await eventLog.close();
      state.close();
    }
  });

  it("delivers session.tool.detail as temporary with short TTL and skips responseCache retention", async () => {
    const cacheResponse = vi.fn();
    const sendToDevice = vi.fn().mockResolvedValue("env-out");
    const ack = vi.fn();
    const handleRequest = vi.fn().mockResolvedValue({
      detail: {
        sessionId: "local_1",
        toolUseId: "toolu_1",
        toolName: "Bash",
        input: { command: "pwd" },
        status: "completed",
        outputText: "/project",
        truncated: false,
        totalBytes: 8,
      },
    });

    const requestPayload: BridgeRequest = {
      kind: "request",
      requestId: "r-tool-detail",
      idempotencyKey: "k-tool-detail",
      method: "session.tool.detail",
      params: { sessionId: "local_1", toolUseId: "toolu_1" },
    };
    const message: DecryptedEnvelope = {
      header: {
        version: 3,
        id: "env-in-1",
        roomId: "room_1",
        from: "mobile",
        to: "desktop",
        fromDeviceId: "phone_1",
        toDeviceId: "desktop_1",
        sentAt: 1,
        expiresAt: 1000,
      },
      payload: requestPayload,
    };
    const encrypted = { id: "env-in-1" } as EncryptedEnvelope;

    await deliverTransportMessage(
      {
        socket: { ack } as any,
        responseCache: new Map(),
        rememberDevice: async () => {},
        sendToDevice,
        handleRequest,
        cacheResponse,
        revokeDevice: async () => {},
      },
      message,
      encrypted,
      (requestId, error) => ({
        kind: "response",
        requestId,
        ok: false,
        error: { code: "ERR", message: String(error), retryable: false },
      }),
    );

    expect(handleRequest).toHaveBeenCalledOnce();
    expect(cacheResponse).not.toHaveBeenCalled();
    expect(sendToDevice).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "response", requestId: "r-tool-detail", ok: true }),
      "phone_1",
      ARTIFACT_TRANSFER_TTL_MS,
      true,
      true,
    );
    expect(ack).toHaveBeenCalledWith(["env-in-1"]);
  });
});
