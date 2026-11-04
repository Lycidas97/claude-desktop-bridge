import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  ModelInfo,
  Query,
  SDKControlGetContextUsageResponse,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { ClaudeSessionHost, type SessionHostEvent } from "./claude-session-host.js";
import { PermissionBroker } from "./permission-broker.js";
import { AsyncInputQueue } from "./async-input-queue.js";

class FakeQuery implements AsyncGenerator<SDKMessage, void> {
  private readonly messages: SDKMessage[] = [];
  private resolveNext: (() => void) | undefined;
  interrupted = false;
  closed = false;
  holdClose = false;
  interruptStillQueued: string[] = [];
  readonly cancelledMessages: string[] = [];
  readonly stoppedTasks: string[] = [];
  readonly backgroundedTools: Array<string | undefined> = [];
  initialization: Promise<void> = Promise.resolve();
  disposal: Promise<void> = Promise.resolve();
  disposing = false;
  selectedModel: string | undefined;
  selectedEffort: string | null | undefined;

  push(message: SDKMessage): void {
    this.messages.push(message);
    this.resolveNext?.();
    this.resolveNext = undefined;
  }

  async next(): Promise<IteratorResult<SDKMessage, void>> {
    while (!this.closed && this.messages.length === 0) {
      await new Promise<void>((resolve) => { this.resolveNext = resolve; });
    }
    const message = this.messages.shift();
    return message ? { done: false, value: message } : { done: true, value: undefined };
  }

  async return(): Promise<IteratorResult<SDKMessage, void>> {
    this.close();
    return { done: true, value: undefined };
  }

  async throw(error?: unknown): Promise<IteratorResult<SDKMessage, void>> {
    throw error;
  }

  [Symbol.asyncIterator](): AsyncGenerator<SDKMessage, void> {
    return this;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.disposing = true;
    this.close();
    await this.disposal;
  }

  async interrupt(): Promise<{ still_queued: string[] }> {
    this.interrupted = true;
    return { still_queued: this.interruptStillQueued };
  }

  async cancelAsyncMessage(messageId: string): Promise<boolean> {
    this.cancelledMessages.push(messageId);
    return true;
  }

  async setPermissionMode(): Promise<void> {}
  async setModel(model?: string): Promise<void> { this.selectedModel = model; }
  async setMaxThinkingTokens(): Promise<void> {}
  async setThinking(): Promise<void> {}
  async setEffort(): Promise<void> {}
  async setFastMode(): Promise<void> {}
  async setFastModeVolume(): Promise<void> {}
  async setMcpServerPermissionMode(): Promise<Record<string, unknown>> { return {}; }
  async setSandboxSettings(): Promise<void> {}
  async setAdditionalDirectories(): Promise<void> {}
  async setPlugins(): Promise<void> {}
  async setTools(): Promise<void> {}
  async setSkills(): Promise<void> {}
  async applyFlagSettings(settings: { effortLevel?: string | null }): Promise<void> {
    this.selectedEffort = settings.effortLevel;
  }
  async supportedModels(): Promise<ModelInfo[]> {
    return [{
      value: "claude-fable-5[1m]",
      displayName: "Fable 5 · 1M",
      description: "Long context",
    }];
  }
  async getContextUsage(): Promise<SDKControlGetContextUsageResponse> {
    return {
      categories: [],
      totalTokens: 300_000,
      maxTokens: 1_000_000,
      rawMaxTokens: 1_000_000,
      percentage: 30,
      gridRows: [],
      model: "claude-fable-5[1m]",
      memoryFiles: [],
      mcpTools: [],
      agents: [],
      isAutoCompactEnabled: true,
      apiUsage: null,
    };
  }
  async supportedCommands(): Promise<never[]> { return []; }
  async mcpServerStatus(): Promise<never[]> { return []; }
  async accountInfo(): Promise<undefined> { return undefined; }
  async rewindFiles(): Promise<void> {}
  async reconnectMcpServer(): Promise<void> {}
  async toggleMcpServer(): Promise<void> {}
  async initializationResult(): Promise<unknown> { await this.initialization; return {}; }
  async stopTask(taskId: string): Promise<void> { this.stoppedTasks.push(taskId); }
  async backgroundTasks(toolUseId?: string): Promise<boolean> { this.backgroundedTools.push(toolUseId); return true; }

  close(): void {
    this.closed = true;
    if (this.holdClose) return;
    this.releaseClose();
  }

  releaseClose(): void {
    this.resolveNext?.();
    this.resolveNext = undefined;
  }
}

function waitForEvent(events: SessionHostEvent[], type: SessionHostEvent["type"]): Promise<SessionHostEvent> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), 1_000);
    const poll = () => {
      const match = events.find((event) => event.type === type);
      if (match) {
        clearTimeout(timeout);
        resolve(match);
      } else {
        setTimeout(poll, 1);
      }
    };
    poll();
  });
}

describe("native Send now", () => {
  function fixture() {
    const fake = new FakeQuery();
    const events: SessionHostEvent[] = [];
    let input!: AsyncIterator<SDKUserMessage>;
    let calls = 0;
    const host = new ClaudeSessionHost({
      sessionId: randomUUID(), cwd: "/tmp/bridge-native-steer", executablePath: "/fake/claude", environment: {},
      permissionBroker: new PermissionBroker(), resume: false,
      queryFactory: ((options) => {
        calls++;
        input = (options.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
        return fake as unknown as Query;
      }) as typeof import("@anthropic-ai/claude-agent-sdk").query,
    });
    host.onEvent(event => events.push(event));
    const first = host.send("Original task", "mobile");
    const sendNow = () => host.send({ text: "Adjust this task", priority: "now" }, "mobile");
    const result = (messageId: string, extra: Record<string, unknown> = {}) => fake.push({
      type: "result", subtype: "success", is_error: false, result: "Done", user_message_uuid: messageId,
      origin: { kind: "human" }, session_id: host.sessionId, uuid: randomUUID(), ...extra,
    } as SDKMessage);
    return { fake, host, events, first, sendNow, result, get input() { return input; }, get calls() { return calls; } };
  }

  it("submits priority now through the same live query without interrupting or closing it", async () => {
    const f = fixture();
    try {
      await f.input.next();
      const next = f.sendNow();
      const input = await f.input.next();
      expect(input.value).toMatchObject({ uuid: next.messageId, priority: "now", session_id: f.host.sessionId });
      expect(f.calls).toBe(1);
      expect(f.fake.interrupted).toBe(false);
      expect(f.fake.closed).toBe(false);
      expect(f.host.hasPendingInput).toBe(true);
    } finally { await f.host.close(); }
  });

  it.each([true, false])("settles by message UUID when results arrive out of order (newFirst=%s)", async newFirst => {
    const f = fixture();
    try {
      const next = f.sendNow();
      const firstResult = newFirst ? next : f.first;
      const lastResult = newFirst ? f.first : next;
      f.result(firstResult.messageId);
      await waitForEvent(f.events, "turn.completed");
      expect(f.events.filter(event => event.type === "turn.completed").map(event => event.turnId)).toEqual([firstResult.turnId]);
      expect(f.host.busy).toBe(true);
      f.result(lastResult.messageId);
      await new Promise(resolve => setImmediate(resolve));
      expect(f.events.filter(event => event.type === "turn.completed").map(event => event.turnId)).toEqual([firstResult.turnId, lastResult.turnId]);
      expect(f.host.busy).toBe(false);
    } finally { await f.host.close(); }
  });

  it("settles all members named by a coalesced native result", async () => {
    const f = fixture();
    try {
      const next = f.sendNow();
      f.result(next.messageId, { user_message_uuids: [f.first.messageId, next.messageId] });
      await new Promise(resolve => setImmediate(resolve));
      expect(f.events.filter(event => event.type === "turn.completed").map(event => event.turnId)).toEqual([f.first.turnId, next.turnId]);
      expect(f.host.busy).toBe(false);
    } finally { await f.host.close(); }
  });

  it.each(["aborted_streaming", "aborted_tools"])("recognizes native preemption without a Stop request: %s", async terminalReason => {
    const f = fixture();
    try {
      const next = f.sendNow();
      f.result(f.first.messageId, { terminal_reason: terminalReason, result: "" });
      await waitForEvent(f.events, "turn.interrupted");
      expect(f.events.filter(event => event.type === "turn.interrupted").map(event => event.turnId)).toEqual([f.first.turnId]);
      expect(f.host.busy).toBe(true);
      f.result(next.messageId);
      await waitForEvent(f.events, "turn.completed");
      expect(f.fake.interrupted).toBe(false);
    } finally { await f.host.close(); }
  });

  it("does not settle a live Send now command from an unknown or duplicate old result", async () => {
    const f = fixture();
    try {
      const next = f.sendNow();
      f.result(f.first.messageId);
      await waitForEvent(f.events, "turn.completed");
      f.result(f.first.messageId);
      f.result("historical-message");
      await new Promise(resolve => setImmediate(resolve));
      expect(f.host.busy).toBe(true);
      expect(f.events.filter(event => event.type === "turn.completed")).toHaveLength(1);
      f.result(next.messageId);
      await new Promise(resolve => setImmediate(resolve));
      expect(f.events.filter(event => event.type === "turn.completed")).toHaveLength(2);
    } finally { await f.host.close(); }
  });

  it("backgrounds only live Bash and Agent calls and keeps late tool results on the original turn", async () => {
    const f = fixture();
    try {
      f.fake.push({ type: "assistant", uuid: randomUUID(), session_id: f.host.sessionId, parent_tool_use_id: null, message: {
        role: "assistant", content: [
          { type: "tool_use", id: "shell", name: "Bash", input: {} },
          { type: "tool_use", id: "agent", name: "Agent", input: {} },
          { type: "tool_use", id: "read", name: "Read", input: {} },
        ],
      } } as SDKMessage);
      await waitForEvent(f.events, "tool.started");
      const next = f.sendNow();
      expect(f.fake.backgroundedTools.sort()).toEqual(["agent", "shell"]);
      f.fake.push({ type: "user", uuid: next.messageId, session_id: f.host.sessionId, parent_tool_use_id: null, origin: { kind: "human" }, message: { role: "user", content: "Adjust this task" } } as SDKMessage);
      f.fake.push({ type: "user", uuid: randomUUID(), session_id: f.host.sessionId, parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "shell", content: "Still working in background" }] } } as SDKMessage);
      await waitForEvent(f.events, "tool.completed");
      expect(f.events.find(event => event.type === "tool.completed" && event.itemId === "shell")).toMatchObject({ turnId: f.first.turnId });
      expect(f.fake.stoppedTasks).toEqual([]);
      expect(f.fake.interrupted).toBe(false);
    } finally { await f.host.close(); }
  });

  it("keeps the submitted native message when backgrounding a tool fails", async () => {
    const f = fixture();
    const background = vi.spyOn(f.fake, "backgroundTasks").mockRejectedValueOnce(new Error("Background RPC failed"));
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await f.input.next();
      f.fake.push({ type: "assistant", uuid: randomUUID(), session_id: f.host.sessionId, parent_tool_use_id: null, message: {
        role: "assistant", content: [{ type: "tool_use", id: "shell", name: "Bash", input: {} }],
      } } as SDKMessage);
      await waitForEvent(f.events, "tool.started");
      const next = f.sendNow();
      expect((await f.input.next()).value).toMatchObject({ uuid: next.messageId, priority: "now" });
      expect(background).toHaveBeenCalledTimes(1);
      expect(background).toHaveBeenCalledWith("shell");
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining("Background RPC failed"));
      expect(f.events.filter(event => event.type === "turn.failed")).toEqual([]);
      expect(f.fake.interrupted).toBe(false);
      expect(f.fake.closed).toBe(false);
      f.result(f.first.messageId);
      f.result(next.messageId);
      await new Promise(resolve => setImmediate(resolve));
      expect(f.events.filter(event => event.type === "turn.completed").map(event => event.turnId)).toEqual([f.first.turnId, next.turnId]);
      expect(f.host.hasPendingInput).toBe(false);
    } finally { stderr.mockRestore(); await f.host.close(); }
  });

  it("does not background a tool that finished before the native steer", async () => {
    const f = fixture();
    try {
      f.fake.push({ type: "assistant", uuid: randomUUID(), session_id: f.host.sessionId, parent_tool_use_id: null, message: {
        role: "assistant", content: [{ type: "tool_use", id: "finished-shell", name: "Bash", input: {} }],
      } } as SDKMessage);
      await waitForEvent(f.events, "tool.started");
      f.fake.push({ type: "user", uuid: randomUUID(), session_id: f.host.sessionId, parent_tool_use_id: null, message: {
        role: "user", content: [{ type: "tool_result", tool_use_id: "finished-shell", content: "Done" }],
      } } as SDKMessage);
      await waitForEvent(f.events, "tool.completed");
      f.sendNow();
      expect(f.fake.backgroundedTools).toEqual([]);
      expect(f.fake.stoppedTasks).toEqual([]);
      expect(f.fake.interrupted).toBe(false);
    } finally { await f.host.close(); }
  });

  it("does not leave another native input alive after a manual Stop receipt lists it", async () => {
    const f = fixture();
    try {
      const next = f.sendNow();
      f.fake.interruptStillQueued = [next.messageId];
      await f.host.interrupt();
      expect(f.fake.closed).toBe(true);
      expect(f.host.hasPendingInput).toBe(false);
      expect(f.events.filter(event => event.type === "turn.interrupted").map(event => event.turnId).sort()).toEqual([f.first.turnId, next.turnId].sort());
    } finally { await f.host.close(); }
  });

  it("fails every unfinished native input when the query unexpectedly exits", async () => {
    const f = fixture();
    try {
      const next = f.sendNow();
      f.fake.close();
      await waitForEvent(f.events, "runtime.stopped");
      expect(f.events.filter(event => event.type === "turn.failed").map(event => event.turnId)).toEqual([f.first.turnId, next.turnId]);
      expect(f.host.busy).toBe(false);
      expect(f.host.hasPendingInput).toBe(false);
    } finally { await f.host.close(); }
  });

  it("still queues ordinary sends outside the running host", async () => {
    const f = fixture();
    try {
      expect(() => f.host.send("An ordinary next turn", "mobile")).toThrow("already has a running turn");
      expect(f.fake.interrupted).toBe(false);
    } finally { await f.host.close(); }
  });

  it("keeps unstamped results from falsely completing a native-steered input", async () => {
    const f = fixture();
    try {
      f.sendNow();
      f.fake.push({ type: "result", subtype: "success", is_error: false, result: "Unattributed", session_id: f.host.sessionId, uuid: randomUUID() } as SDKMessage);
      await new Promise(resolve => setImmediate(resolve));
      expect(f.events.filter(event => event.type === "turn.completed")).toEqual([]);
      expect(f.host.busy).toBe(true);
    } finally { await f.host.close(); }
  });
});

describe("ClaudeSessionHost", () => {
  it("keeps one streaming query alive across turns and never forks", async () => {
    const fake = new FakeQuery();
    let queryCalls = 0;
    let captured: Parameters<typeof import("@anthropic-ai/claude-agent-sdk").query>[0] | undefined;
    const sessionId = randomUUID();
    const host = new ClaudeSessionHost({
      sessionId,
      cwd: "/tmp/bridge-project",
      executablePath: "/tmp/claude",
      environment: { PATH: "/usr/bin" },
      permissionBroker: new PermissionBroker(),
      resume: true,
      model: "claude-fable-5[1m]",
      effort: "high",
      queryFactory: ((params) => {
        queryCalls += 1;
        captured = params;
        return fake as unknown as Query;
      }) as typeof import("@anthropic-ai/claude-agent-sdk").query,
    });
    const events: SessionHostEvent[] = [];
    host.onEvent((event) => events.push(event));

    host.send("first", "mobile");
    fake.push({
      type: "result",
      subtype: "success",
      duration_ms: 1,
      duration_api_ms: 1,
      is_error: false,
      num_turns: 1,
      result: "one",
      stop_reason: "end_turn",
      total_cost_usd: 0,
      usage: {} as never,
      modelUsage: {},
      permission_denials: [],
      uuid: randomUUID(),
      session_id: sessionId,
    });
    await waitForEvent(events, "turn.completed");
    await host.setModel("claude-opus-4-8[1m]");
    await host.setEffort("xhigh");
    expect(fake.selectedModel).toBe("claude-opus-4-8[1m]");
    expect(fake.selectedEffort).toBe("xhigh");
    await expect(host.supportedModels()).resolves.toEqual([
      expect.objectContaining({ value: "claude-fable-5[1m]" }),
    ]);
    await expect(host.contextUsage()).resolves.toMatchObject({
      totalTokens: 300_000,
      maxTokens: 1_000_000,
    });
    host.send("second", "desktop");
    expect(queryCalls).toBe(1);
    expect(captured?.options).toMatchObject({
      resume: sessionId,
      forkSession: false,
      cwd: "/tmp/bridge-project",
      includePartialMessages: true,
      permissionMode: "default",
      model: "claude-fable-5[1m]",
      effort: "high",
    });

    await host.interrupt();
    expect(fake.interrupted).toBe(true);
    await host.close();
  });

  it("starts and resumes the native query with the updated auto-compact window", async () => {
    const queries: FakeQuery[] = [];
    const options: Array<Parameters<typeof import("@anthropic-ai/claude-agent-sdk").query>[0]["options"]> = [];
    const sessionId = randomUUID();
    const host = new ClaudeSessionHost({
      sessionId, cwd: "/tmp/bridge-project", executablePath: "/tmp/claude",
      environment: {}, permissionBroker: new PermissionBroker(), resume: true,
      queryFactory: ((params) => {
        const fake = new FakeQuery();
        queries.push(fake);
        options.push(params.options);
        return fake as unknown as Query;
      }) as typeof import("@anthropic-ai/claude-agent-sdk").query,
    });
    try {
      await host.setAutoCompactWindow(400_000);
      await host.contextUsage();
      expect(options[0]).toMatchObject({ settings: { autoCompactWindow: 400_000 } });
      await host.setAutoCompactWindow(400_000);
      expect(queries[0]?.closed).toBe(false);
      await host.setAutoCompactWindow(200_000);
      expect(queries[0]?.closed).toBe(true);
      await host.contextUsage();
      expect(options[1]).toMatchObject({ resume: sessionId, forkSession: false, settings: { autoCompactWindow: 200_000 } });
      await host.setAutoCompactWindow(undefined);
      expect(queries[1]?.closed).toBe(true);
      await host.contextUsage();
      expect(options[2]?.settings).toBeUndefined();
    } finally {
      await host.close();
    }
  });

  it("withdraws an unconsumed prompt when query startup fails", async () => {
    const fake = new FakeQuery();
    const sessionId = randomUUID();
    let queryCalls = 0;
    let retryPrompt: AsyncIterable<SDKUserMessage> | undefined;
    const host = new ClaudeSessionHost({
      sessionId,
      cwd: "/tmp/bridge-project",
      executablePath: "/tmp/claude",
      environment: { PATH: "/usr/bin" },
      permissionBroker: new PermissionBroker(),
      resume: true,
      queryFactory: ((params) => {
        queryCalls += 1;
        if (queryCalls === 1) throw new Error("query startup failed");
        retryPrompt = params.prompt as AsyncIterable<SDKUserMessage>;
        return fake as unknown as Query;
      }) as typeof import("@anthropic-ai/claude-agent-sdk").query,
    });
    const events: SessionHostEvent[] = [];
    host.onEvent((event) => events.push(event));

    expect(() => host.send("stale prompt", "mobile")).toThrow("query startup failed");
    expect(host.busy).toBe(false);
    const retry = host.send("retry prompt", "mobile");
    expect(queryCalls).toBe(2);
    if (!retryPrompt) throw new Error("Retry query did not receive a prompt iterable");
    const queued = await retryPrompt[Symbol.asyncIterator]().next();
    expect(queued.done).toBe(false);
    expect((queued.value.message.content as Array<{ type: string; text?: string }>))
      .toEqual([{ type: "text", text: "retry prompt" }]);

    fake.push({
      type: "result",
      subtype: "success",
      duration_ms: 1,
      duration_api_ms: 1,
      is_error: false,
      num_turns: 1,
      result: "Recovered",
      stop_reason: "end_turn",
      total_cost_usd: 0,
      usage: {} as never,
      modelUsage: {},
      permission_denials: [],
      uuid: randomUUID(),
      session_id: sessionId,
    });
    await expect(waitForEvent(events, "turn.completed")).resolves.toMatchObject({
      type: "turn.completed",
      turnId: retry.turnId,
      result: "Recovered",
    });
    await host.close();
  });

  it("matches tool results to their tool use IDs instead of the parent agent", async () => {
    const fake = new FakeQuery();
    const sessionId = randomUUID();
    const host = new ClaudeSessionHost({
      sessionId,
      cwd: "/tmp/bridge-project",
      executablePath: "/tmp/claude",
      environment: { PATH: "/usr/bin" },
      permissionBroker: new PermissionBroker(),
      resume: true,
      queryFactory: (() => fake as unknown as Query) as typeof import("@anthropic-ai/claude-agent-sdk").query,
    });
    const events: SessionHostEvent[] = [];
    host.onEvent((event) => events.push(event));
    host.send("run two tools", "mobile");
    fake.push({
      type: "user",
      uuid: randomUUID(),
      session_id: sessionId,
      parent_tool_use_id: "parent-agent",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "bash-tool", content: "command output" },
          { type: "tool_result", tool_use_id: "read-tool", content: "file content" },
        ],
      },
      tool_use_result: { stdout: "command output" },
    });
    try {
      await waitForEvent(events, "tool.completed");
      expect(events.filter((event) => event.type === "tool.completed")).toEqual([
        expect.objectContaining({ itemId: "bash-tool", output: "command output" }),
        expect.objectContaining({ itemId: "read-tool", output: "file content" }),
      ]);
    } finally {
      await host.close();
    }
  });

  it("preserves structured output for a single tool result", async () => {
    const fake = new FakeQuery();
    const sessionId = randomUUID();
    const host = new ClaudeSessionHost({
      sessionId,
      cwd: "/tmp/bridge-project",
      executablePath: "/tmp/claude",
      environment: { PATH: "/usr/bin" },
      permissionBroker: new PermissionBroker(),
      resume: true,
      queryFactory: (() => fake as unknown as Query) as typeof import("@anthropic-ai/claude-agent-sdk").query,
    });
    const events: SessionHostEvent[] = [];
    host.onEvent((event) => events.push(event));
    host.send("run tool", "mobile");
    fake.push({
      type: "user",
      uuid: randomUUID(),
      session_id: sessionId,
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "bash-tool", content: "output" }],
      },
      tool_use_result: { stdout: "output", exitCode: 0 },
    });
    try {
      await expect(waitForEvent(events, "tool.completed")).resolves.toMatchObject({
        itemId: "bash-tool",
        output: { stdout: "output", exitCode: 0 },
      });
    } finally {
      await host.close();
    }
  });

  it("reports provider API errors as failed turns", async () => {
    const fake = new FakeQuery();
    const sessionId = randomUUID();
    const host = new ClaudeSessionHost({
      sessionId,
      cwd: "/tmp/bridge-project",
      executablePath: "/tmp/claude",
      environment: { PATH: "/usr/bin" },
      permissionBroker: new PermissionBroker(),
      resume: true,
      queryFactory: (() => fake as unknown as Query) as typeof import("@anthropic-ai/claude-agent-sdk").query,
    });
    const events: SessionHostEvent[] = [];
    host.onEvent((event) => events.push(event));

    host.send("continue", "mobile");
    fake.push({
      type: "result",
      subtype: "success",
      duration_ms: 1,
      duration_api_ms: 1,
      is_error: true,
      num_turns: 1,
      result: "API Error: request exceeded model token limit",
      stop_reason: null,
      total_cost_usd: 0,
      usage: {} as never,
      modelUsage: {},
      permission_denials: [],
      uuid: randomUUID(),
      session_id: sessionId,
    });

    await expect(waitForEvent(events, "turn.failed")).resolves.toMatchObject({
      type: "turn.failed",
      error: "API Error: request exceeded model token limit",
    });
    await host.close();
  });

  it("emits one visible failure for a synthetic SDK error and keeps normal assistant text", async () => {
    const fake = new FakeQuery();
    const sessionId = randomUUID();
    const host = new ClaudeSessionHost({
      sessionId,
      cwd: "/tmp/bridge-project",
      executablePath: "/tmp/claude",
      environment: { PATH: "/usr/bin" },
      permissionBroker: new PermissionBroker(),
      resume: true,
      queryFactory: (() => fake as unknown as Query) as typeof import("@anthropic-ai/claude-agent-sdk").query,
    });
    const events: SessionHostEvent[] = [];
    host.onEvent((event) => events.push(event));

    host.send("continue", "mobile");
    fake.push({
      type: "assistant",
      uuid: randomUUID(),
      session_id: sessionId,
      parent_tool_use_id: null,
      message: {
        id: randomUUID(),
        type: "message",
        role: "assistant",
        model: "<synthetic>",
        content: [{ type: "text", text: "Prompt is too long", citations: [] }],
        stop_reason: "model_context_window_exceeded",
        stop_sequence: null,
        usage: {} as never,
      } as never,
    });
    fake.push({
      type: "result",
      subtype: "success",
      duration_ms: 1,
      duration_api_ms: 1,
      is_error: true,
      num_turns: 1,
      result: "Prompt is too long",
      stop_reason: "model_context_window_exceeded",
      total_cost_usd: 0,
      usage: {} as never,
      modelUsage: {},
      permission_denials: [],
      uuid: randomUUID(),
      session_id: sessionId,
    });
    await waitForEvent(events, "turn.failed");
    expect(events.filter((event) => event.type === "turn.failed")).toHaveLength(1);
    expect(events.some((event) => event.type === "assistant.completed")).toBe(false);

    host.send("retry in a new context", "mobile");
    const normalAssistantId = randomUUID();
    fake.push({
      type: "assistant",
      uuid: normalAssistantId,
      session_id: sessionId,
      parent_tool_use_id: null,
      message: {
        id: randomUUID(),
        type: "message",
        role: "assistant",
        model: "claude-opus-5",
        content: [{ type: "text", text: "正常回复", citations: [] }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {} as never,
      } as never,
    });
    fake.push({
      type: "result",
      subtype: "success",
      duration_ms: 1,
      duration_api_ms: 1,
      is_error: false,
      num_turns: 1,
      result: "正常回复",
      stop_reason: "end_turn",
      total_cost_usd: 0,
      usage: {} as never,
      modelUsage: {},
      permission_denials: [],
      uuid: randomUUID(),
      session_id: sessionId,
    });
    await waitForEvent(events, "turn.completed");
    expect(events).toContainEqual(expect.objectContaining({
      type: "assistant.completed",
      itemId: normalAssistantId,
      text: "正常回复",
    }));
    await host.close();
  });

  it.each(["different-input", "notification-origin", "peer-origin", "notification-error"])("ignores a restored %s result until the submitted human input completes", async (source) => {
    const fake = new FakeQuery();
    const sessionId = randomUUID();
    const host = new ClaudeSessionHost({
      sessionId, cwd: "/tmp/bridge-project", executablePath: "/fake/claude", environment: {},
      permissionBroker: new PermissionBroker(), resume: true,
      queryFactory: (() => fake as unknown as Query) as typeof import("@anthropic-ai/claude-agent-sdk").query,
    });
    const events: SessionHostEvent[] = [];
    host.onEvent((event) => events.push(event));
    try {
      const turn = host.send("Continue the review", "mobile");
      fake.push({
        type: "result", subtype: source === "notification-error" ? "error_during_execution" : "success", is_error: source === "notification-error", result: "", errors: ["Old notification failed"], num_turns: 0,
        duration_ms: 1, duration_api_ms: 0, stop_reason: null, total_cost_usd: 0,
        usage: {} as never, modelUsage: {}, permission_denials: [],
        ...(source === "different-input" ? { user_message_uuid: "restored-notification" }
          : source === "peer-origin" ? { origin: { kind: "peer", from: "old-session" } }
            : { origin: { kind: "task-notification" } }),
        session_id: sessionId, uuid: randomUUID(),
      } as SDKMessage);
      fake.push({
        type: "assistant", session_id: sessionId, uuid: randomUUID(), parent_tool_use_id: null,
        message: { content: [{ type: "text", text: "Review continued" }] } as never,
      } as SDKMessage);
      await waitForEvent(events, "assistant.completed");
      expect(host.busy).toBe(true);
      expect(events.some((event) => event.type === "turn.completed")).toBe(false);
      fake.push({
        type: "result", subtype: "success", is_error: false, result: "Review continued", num_turns: 1,
        user_message_uuid: turn.messageId, origin: { kind: "human" }, session_id: sessionId, uuid: randomUUID(),
      } as SDKMessage);
      await waitForEvent(events, "turn.completed");
      expect(events.filter((event) => event.type === "turn.completed")).toEqual([
        expect.objectContaining({ turnId: turn.turnId, result: "Review continued" }),
      ]);
      expect(host.busy).toBe(false);
    } finally {
      await host.close();
    }
  });

  it("accepts a matching human result even when its response text is empty", async () => {
    const fake = new FakeQuery();
    const sessionId = randomUUID();
    const host = new ClaudeSessionHost({
      sessionId, cwd: "/tmp/bridge-project", executablePath: "/fake/claude", environment: {},
      permissionBroker: new PermissionBroker(), resume: true,
      queryFactory: (() => fake as unknown as Query) as typeof import("@anthropic-ai/claude-agent-sdk").query,
    });
    const events: SessionHostEvent[] = [];
    host.onEvent((event) => events.push(event));
    try {
      const turn = host.send("Run without a visible reply", "mobile");
      fake.push({ type: "result", subtype: "success", is_error: false, result: "", user_message_uuid: turn.messageId, origin: { kind: "human" }, session_id: sessionId, uuid: randomUUID() } as SDKMessage);
      await expect(waitForEvent(events, "turn.completed")).resolves.toMatchObject({ turnId: turn.turnId, result: "" });
      expect(host.busy).toBe(false);
    } finally { await host.close(); }
  });

  it("drains an interrupted result before settling an immediate retry", async () => {
    const fake = new FakeQuery();
    const sessionId = randomUUID();
    let prompt: AsyncIterable<SDKUserMessage> | undefined;
    const host = new ClaudeSessionHost({
      sessionId,
      cwd: "/tmp/bridge-project",
      executablePath: "/tmp/claude",
      environment: { PATH: "/usr/bin" },
      permissionBroker: new PermissionBroker(),
      resume: true,
      queryFactory: ((params) => {
        prompt = params.prompt as AsyncIterable<SDKUserMessage>;
        return fake as unknown as Query;
      }) as typeof import("@anthropic-ai/claude-agent-sdk").query,
    });
    const events: SessionHostEvent[] = [];
    host.onEvent((event) => events.push(event));

    const interrupted = host.send("continue P2", "mobile");
    if (!prompt) throw new Error("Query did not receive a prompt iterable");
    const promptIterator = prompt[Symbol.asyncIterator]();
    await expect(promptIterator.next()).resolves.toMatchObject({
      done: false,
      value: { uuid: interrupted.messageId },
    });
    await host.interrupt();
    const retry = host.send("retry P2", "mobile");
    expect(events.filter((event) => event.type === "user.submitted")).toEqual([
      expect.objectContaining({ messageId: interrupted.messageId }),
    ]);
    expect(events.some((event) => event.type === "user.accepted")).toBe(false);
    let retrySubmitted = false;
    const retryPrompt = promptIterator.next().then((value) => {
      retrySubmitted = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(retrySubmitted).toBe(false);
    fake.push({
      type: "assistant",
      uuid: randomUUID(),
      session_id: sessionId,
      parent_tool_use_id: null,
      message: {
        id: randomUUID(),
        type: "message",
        role: "assistant",
        model: "<synthetic>",
        content: [{ type: "text", text: "No response requested.", citations: [] }],
        stop_reason: "stop_sequence",
        stop_sequence: "",
        usage: {} as never,
      } as never,
    });
    fake.push({
      type: "result",
      subtype: "error_during_execution",
      duration_ms: 1,
      duration_api_ms: 1,
      is_error: true,
      num_turns: 0,
      errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null"],
      total_cost_usd: 0,
      usage: {} as never,
      modelUsage: {},
      permission_denials: [],
      stop_reason: null,
      uuid: randomUUID(),
      session_id: sessionId,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(events.filter((event) => event.type === "turn.interrupted")).toEqual([
      expect.objectContaining({ turnId: interrupted.turnId }),
    ]);
    expect(events.some((event) => event.type === "assistant.completed")).toBe(false);
    expect(events.some((event) => event.type === "turn.failed")).toBe(false);
    expect(events.some((event) => event.type === "user.accepted")).toBe(false);
    expect(events.filter((event) => event.type === "user.submitted")).toEqual([
      expect.objectContaining({ messageId: interrupted.messageId }),
      expect.objectContaining({ messageId: retry.messageId }),
    ]);
    expect(host.busy).toBe(true);
    await expect(retryPrompt).resolves.toMatchObject({
      done: false,
      value: { uuid: retry.messageId },
    });

    fake.push({
      type: "result",
      subtype: "success",
      duration_ms: 1,
      duration_api_ms: 1,
      is_error: false,
      num_turns: 1,
      result: "Done",
      stop_reason: "end_turn",
      total_cost_usd: 0,
      usage: {} as never,
      modelUsage: {},
      permission_denials: [],
      uuid: randomUUID(),
      session_id: sessionId,
    });
    await expect(waitForEvent(events, "turn.completed")).resolves.toMatchObject({
      type: "turn.completed",
      turnId: retry.turnId,
      result: "Done",
    });
    expect(host.busy).toBe(false);
    await host.close();
  });

  it("retires the writer when an interrupted prompt would otherwise still run", async () => {
    const firstQuery = new FakeQuery();
    const secondQuery = new FakeQuery();
    const prompts: AsyncIterable<SDKUserMessage>[] = [];
    const queryOptions: Array<Parameters<typeof import("@anthropic-ai/claude-agent-sdk").query>[0]["options"]> = [];
    let queryCalls = 0;
    const sessionId = randomUUID();
    const host = new ClaudeSessionHost({
      sessionId,
      cwd: "/tmp/bridge-project",
      executablePath: "/tmp/claude",
      environment: { PATH: "/usr/bin" },
      permissionBroker: new PermissionBroker(),
      resume: false,
      queryFactory: ((params) => {
        prompts.push(params.prompt as AsyncIterable<SDKUserMessage>);
        queryOptions.push(params.options);
        return (queryCalls++ === 0 ? firstQuery : secondQuery) as unknown as Query;
      }) as typeof import("@anthropic-ai/claude-agent-sdk").query,
    });
    const events: SessionHostEvent[] = [];
    host.onEvent((event) => events.push(event));

    const interrupted = host.send("queued old prompt", "mobile");
    await expect(prompts[0]![Symbol.asyncIterator]().next()).resolves.toMatchObject({
      done: false,
      value: { uuid: interrupted.messageId },
    });
    firstQuery.interruptStillQueued = [interrupted.messageId];
    await host.interrupt();

    expect(firstQuery.cancelledMessages).toEqual([interrupted.messageId]);
    expect(firstQuery.closed).toBe(true);
    expect(queryCalls).toBe(1);
    expect(queryOptions[0]).toMatchObject({ sessionId });
    expect(queryOptions[0]?.resume).toBeUndefined();
    expect(events).toContainEqual(expect.objectContaining({
      type: "turn.interrupted",
      turnId: interrupted.turnId,
    }));

    const retry = host.send("safe retry", "mobile");
    expect(queryCalls).toBe(2);
    expect(queryOptions[1]).toMatchObject({ resume: sessionId, forkSession: false });
    expect(queryOptions[1]?.sessionId).toBeUndefined();
    await expect(prompts[1]![Symbol.asyncIterator]().next()).resolves.toMatchObject({
      done: false,
      value: { uuid: retry.messageId },
    });
    secondQuery.push({
      type: "result",
      subtype: "success",
      duration_ms: 1,
      duration_api_ms: 1,
      is_error: false,
      num_turns: 1,
      result: "Retried safely",
      stop_reason: "end_turn",
      total_cost_usd: 0,
      usage: {} as never,
      modelUsage: {},
      permission_denials: [],
      uuid: randomUUID(),
      session_id: sessionId,
    });
    await expect(waitForEvent(events, "turn.completed")).resolves.toMatchObject({
      type: "turn.completed",
      turnId: retry.turnId,
      result: "Retried safely",
    });
    await host.close();
  });

  it("does not start a configuration writer while an interrupted writer retires", async () => {
    const firstQuery = new FakeQuery();
    const secondQuery = new FakeQuery();
    firstQuery.holdClose = true;
    let queryCalls = 0;
    let prompt: AsyncIterable<SDKUserMessage> | undefined;
    const sessionId = randomUUID();
    const host = new ClaudeSessionHost({
      sessionId,
      cwd: "/tmp/bridge-project",
      executablePath: "/tmp/claude",
      environment: { PATH: "/usr/bin" },
      permissionBroker: new PermissionBroker(),
      resume: true,
      queryFactory: ((params) => {
        prompt = params.prompt as AsyncIterable<SDKUserMessage>;
        return (queryCalls++ === 0 ? firstQuery : secondQuery) as unknown as Query;
      }) as typeof import("@anthropic-ai/claude-agent-sdk").query,
    });

    const interrupted = host.send("queued prompt", "mobile");
    if (!prompt) throw new Error("Query did not receive a prompt iterable");
    await expect(prompt[Symbol.asyncIterator]().next()).resolves.toMatchObject({
      value: { uuid: interrupted.messageId },
    });
    firstQuery.interruptStillQueued = [interrupted.messageId];
    const interrupting = host.interrupt();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(firstQuery.closed).toBe(true);
    expect(() => host.start()).toThrow(/retiring its previous writer/u);
    await expect(host.supportedModels()).rejects.toThrow(/retiring its previous writer/u);
    expect(queryCalls).toBe(1);

    firstQuery.releaseClose();
    await interrupting;
    host.send("safe retry", "mobile");
    expect(queryCalls).toBe(2);
    await host.close();
  });

  it.each(["unfinished", "error", "idle", "closed", "interrupted"])("cleans up a %s query when its stream ends", async (ending) => {
    const queries: Array<{ output: AsyncInputQueue<SDKMessage>; prompt: AsyncIterator<SDKUserMessage> }> = [];
    const sessionId = randomUUID();
    const host = new ClaudeSessionHost({
      sessionId, cwd: "/tmp/bridge-project", executablePath: "/fake/claude",
      environment: {}, permissionBroker: new PermissionBroker(), resume: true,
      queryFactory: ((params) => {
        const query = { output: new AsyncInputQueue<SDKMessage>(), prompt: (params.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]() };
        queries.push(query);
        return {
          [Symbol.asyncIterator]: () => query.output[Symbol.asyncIterator](),
          async initializationResult() { return {}; },
          async [Symbol.asyncDispose]() { query.output.close(); },
          async interrupt() { return { still_queued: [] }; },
          close() { query.output.close(); },
        } as unknown as Query;
      }) as typeof import("@anthropic-ai/claude-agent-sdk").query,
    });
    const events: SessionHostEvent[] = [];
    host.onEvent((event) => events.push(event));
    try {
      host.send("First", "mobile");
      const first = queries[0]!;
      await first.prompt.next();
      const streamTask = (host as unknown as { streamTask: Promise<void> }).streamTask;
      if (ending === "idle") {
        first.output.push({ type: "result", subtype: "success", is_error: false, result: "Done", stop_reason: "end_turn", uuid: randomUUID(), session_id: sessionId } as SDKMessage);
        await waitForEvent(events, "turn.completed");
      }
      if (ending === "interrupted") await host.interrupt();
      if (ending === "closed") await host.close();
      else first.output.close(ending === "error" ? new Error("Stream failed") : undefined);
      await streamTask;
      expect(host.busy).toBe(false);
      expect(host.running).toBe(false);
      expect(events.filter((event) => event.type === "runtime.stopped")).toHaveLength(1);
      expect(events.filter((event) => event.type === "runtime.error")).toHaveLength(ending === "unfinished" || ending === "error" ? 1 : 0);
      if (ending !== "closed") {
        const next = host.send("Next", "mobile");
        expect(queries).toHaveLength(2);
        await expect(queries[1]!.prompt.next()).resolves.toMatchObject({ done: false, value: { uuid: next.messageId } });
      }
    } finally {
      await host.close();
    }
  });

  it("acknowledges stored input only after a matching CLI replay and preserves supplied IDs", async () => {
    const fake = new FakeQuery();
    let initialize!: () => void;
    fake.initialization = new Promise((resolve) => { initialize = resolve; });
    let captured: Parameters<typeof import("@anthropic-ai/claude-agent-sdk").query>[0] | undefined;
    const sessionId = randomUUID();
    const host = new ClaudeSessionHost({
      sessionId, eventSessionId: "broker-session", cwd: "/tmp/bridge-project", executablePath: "/fake/claude", environment: {},
      permissionBroker: new PermissionBroker(), resume: true,
      queryFactory: ((params) => { captured = params; return fake as unknown as Query; }) as typeof import("@anthropic-ai/claude-agent-sdk").query,
    });
    const events: SessionHostEvent[] = [];
    host.onEvent((event) => events.push(event));
    try {
      const input = { text: "  original input  ", messageId: randomUUID(), turnId: randomUUID(), attachments: [{ id: "image", name: "photo.png", mimeType: "image/png" as const, size: 3, data: "YWJj" }] };
      const turn = host.send(input, "mobile");
      expect(events.some((event) => event.type === "turn.started")).toBe(false);
      expect(events.some((event) => event.type === "user.accepted")).toBe(false);
      expect(turn).toEqual({ messageId: input.messageId, turnId: input.turnId });
      expect(host.hasPendingInput).toBe(true);
      expect(host.initialized).toBe(false);
      expect(events).toContainEqual(expect.objectContaining({ type: "user.submitted", ...turn, sessionId: "broker-session" }));
      expect(captured?.options?.extraArgs).toMatchObject({ "replay-user-messages": null });
      initialize();
      await waitForEvent(events, "runtime.ready");
      expect(host.initialized).toBe(true);
      expect(events.some((event) => event.type === "user.accepted")).toBe(false);
      fake.push({ type: "user", uuid: randomUUID(), session_id: sessionId, parent_tool_use_id: null, isReplay: true, message: { role: "user", content: "restored input" } });
      fake.push({ type: "user", uuid: input.messageId, session_id: sessionId, parent_tool_use_id: null, isReplay: true, message: { role: "user", content: "CLI normalized input" } });
      await waitForEvent(events, "user.accepted");
      expect(events.filter((event) => event.type === "user.accepted")).toEqual([expect.objectContaining({
        ...turn, text: "original input", origin: "mobile", sessionId: "broker-session",
        attachments: [{ id: "image", name: "photo.png", mimeType: "image/png", size: 3 }],
      })]);
      expect(host.hasPendingInput).toBe(false);
      fake.push({ type: "result", subtype: "success", is_error: false, result: "Done", user_message_uuid: turn.messageId, origin: { kind: "human" }, session_id: sessionId, uuid: randomUUID() } as SDKMessage);
      await waitForEvent(events, "turn.completed");
      expect(events.filter((event) => event.type === "user.accepted")).toHaveLength(1);
    } finally { initialize(); await host.close(); }
  });

  it("does not accept pending input from restored or background output", async () => {
    const fake = new FakeQuery();
    const sessionId = randomUUID();
    const host = new ClaudeSessionHost({
      sessionId, cwd: "/tmp/bridge-project", executablePath: "/fake/claude", environment: {},
      permissionBroker: new PermissionBroker(), resume: true,
      queryFactory: (() => fake as unknown as Query) as typeof import("@anthropic-ai/claude-agent-sdk").query,
    });
    const events: SessionHostEvent[] = [];
    host.onEvent((event) => events.push(event));
    try {
      const turn = host.send("human input", "mobile");
      fake.push({ type: "result", subtype: "success", is_error: false, result: "Old", user_message_uuid: "historical", session_id: sessionId, uuid: randomUUID() } as SDKMessage);
      fake.push({ type: "assistant", parent_tool_use_id: "background-agent", message: { content: [{ type: "text", text: "Background reply" }] }, session_id: sessionId, uuid: randomUUID() } as SDKMessage);
      fake.push({ type: "result", subtype: "success", is_error: false, result: "Background", origin: { kind: "task-notification" }, session_id: sessionId, uuid: randomUUID() } as SDKMessage);
      await new Promise((resolve) => setImmediate(resolve));
      expect(events.some((event) => event.type === "user.accepted")).toBe(false);
      expect(host.hasPendingInput).toBe(true);
      fake.push({ type: "result", subtype: "success", is_error: false, result: "", user_message_uuid: turn.messageId, origin: { kind: "human" }, session_id: sessionId, uuid: randomUUID() } as SDKMessage);
      await waitForEvent(events, "turn.completed");
      expect(events.filter((event) => event.type === "user.accepted")).toEqual([expect.objectContaining({ ...turn, text: "human input" })]);
    } finally { await host.close(); }
  });

  it("keeps canonical background tasks alive after the main result until authoritative termination", async () => {
    const fake = new FakeQuery();
    const sessionId = randomUUID();
    const host = new ClaudeSessionHost({
      sessionId, cwd: "/tmp/bridge-project", executablePath: "/fake/claude", environment: {},
      permissionBroker: new PermissionBroker(), resume: true,
      queryFactory: (() => fake as unknown as Query) as typeof import("@anthropic-ai/claude-agent-sdk").query,
    });
    const events: SessionHostEvent[] = [];
    host.onEvent((event) => events.push(event));
    try {
      const turn = host.send("start agent", "mobile");
      fake.push({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "task-A", task_type: "local_agent", description: "Research" }], session_id: sessionId, uuid: randomUUID() });
      fake.push({ type: "system", subtype: "task_started", task_id: "task-A", tool_use_id: "tool-A", task_type: "local_agent", subagent_type: "Explore", description: "Research", session_id: sessionId, uuid: randomUUID() });
      fake.push({ type: "result", subtype: "success", is_error: false, result: "Agent launched", user_message_uuid: turn.messageId, session_id: sessionId, uuid: randomUUID() } as SDKMessage);
      await waitForEvent(events, "turn.completed");
      expect(host.busy).toBe(false);
      expect(host.running).toBe(true);
      expect(host.runningBackgroundTasks).toEqual([expect.objectContaining({ taskId: "task-A", toolUseId: "tool-A", description: "Research", state: "running", startedAt: expect.any(Number), updatedAt: expect.any(Number) })]);
      await host.stopTask("task-A");
      expect(fake.stoppedTasks).toEqual(["task-A"]);
      expect(host.runningBackgroundTasks).toHaveLength(1);
      expect(events.some((event) => event.type === "task.notification")).toBe(false);
      fake.push({ type: "system", subtype: "task_progress", task_id: "task-A", description: "Reading", usage: { total_tokens: 10, tool_uses: 2, duration_ms: 50 }, last_tool_name: "Read", summary: "Reading sources", session_id: sessionId, uuid: randomUUID() });
      await waitForEvent(events, "task.progress");
      expect(host.runningBackgroundTasks[0]).toMatchObject({ taskId: "task-A", toolUseId: "tool-A", description: "Reading", summary: "Reading sources", usage: { totalTokens: 10, toolUses: 2, durationMs: 50 } });
      fake.push({ type: "system", subtype: "background_tasks_changed", tasks: [], session_id: sessionId, uuid: randomUUID() });
      fake.push({ type: "system", subtype: "task_notification", task_id: "task-A", status: "stopped", summary: "Stopped", output_file: "/tmp/task-A.output", session_id: sessionId, uuid: randomUUID() });
      await waitForEvent(events, "task.notification");
      expect(host.runningBackgroundTasks).toEqual([]);
      expect(events).toContainEqual(expect.objectContaining({ type: "task.notification", taskId: "task-A", toolUseId: "tool-A", state: "stopped", completedAt: expect.any(Number), outputFile: "/tmp/task-A.output" }));
      expect(events.filter((event) => event.type === "background.tasks").at(-1)).toMatchObject({ tasks: [] });
      expect(events.some((event) => event.type === "runtime.stopped")).toBe(false);
    } finally { await host.close(); }
  });

  it.each(["completed", "failed", "stopped"] as const)("tracks legacy task edges and preserves %s terminal status", async (state) => {
    const fake = new FakeQuery();
    const sessionId = randomUUID();
    const host = new ClaudeSessionHost({
      sessionId, cwd: "/tmp/bridge-project", executablePath: "/fake/claude", environment: {},
      permissionBroker: new PermissionBroker(), resume: true,
      queryFactory: (() => fake as unknown as Query) as typeof import("@anthropic-ai/claude-agent-sdk").query,
    });
    const events: SessionHostEvent[] = [];
    host.onEvent((event) => events.push(event));
    try {
      host.start();
      fake.push({ type: "system", subtype: "task_started", task_id: "legacy-task", tool_use_id: "legacy-tool", description: "Running", session_id: sessionId, uuid: randomUUID() });
      await new Promise((resolve) => setImmediate(resolve));
      expect(host.runningBackgroundTasks).toEqual([expect.objectContaining({ taskId: "legacy-task", state: "running" })]);
      fake.push({ type: "system", subtype: "task_notification", task_id: "legacy-task", status: state, output_file: "/tmp/legacy.output", summary: "Finished", session_id: sessionId, uuid: randomUUID() });
      await waitForEvent(events, "task.notification");
      expect(events).toContainEqual(expect.objectContaining({ type: "task.notification", taskId: "legacy-task", toolUseId: "legacy-tool", state }));
      expect(host.runningBackgroundTasks).toEqual([]);
    } finally { await host.close(); }
  });

  it("replaces background membership even when task bookends arrive later", async () => {
    const fake = new FakeQuery();
    const sessionId = randomUUID();
    const host = new ClaudeSessionHost({
      sessionId, cwd: "/tmp/bridge-project", executablePath: "/fake/claude", environment: {},
      permissionBroker: new PermissionBroker(), resume: true,
      queryFactory: (() => fake as unknown as Query) as typeof import("@anthropic-ai/claude-agent-sdk").query,
    });
    const events: SessionHostEvent[] = [];
    host.onEvent((event) => events.push(event));
    try {
      host.start();
      fake.push({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "live", task_type: "local_bash", description: "Command" }], session_id: sessionId, uuid: randomUUID() });
      await new Promise((resolve) => setImmediate(resolve));
      expect(host.runningBackgroundTasks).toHaveLength(1);
      fake.push({ type: "system", subtype: "background_tasks_changed", tasks: [], session_id: sessionId, uuid: randomUUID() });
      fake.push({ type: "system", subtype: "task_started", task_id: "live", tool_use_id: "tool", description: "Command", session_id: sessionId, uuid: randomUUID() });
      await waitForEvent(events, "task.started");
      expect(host.runningBackgroundTasks).toEqual([]);
      expect(events.filter((event) => event.type === "background.tasks").at(-1)).toMatchObject({ tasks: [] });
    } finally { await host.close(); }
  });

  it("reports stopped only when a closing stream ends and resets task state", async () => {
    const fake = new FakeQuery();
    fake.holdClose = true;
    const sessionId = randomUUID();
    const host = new ClaudeSessionHost({
      sessionId, cwd: "/tmp/bridge-project", executablePath: "/fake/claude", environment: {},
      permissionBroker: new PermissionBroker(), resume: true,
      queryFactory: (() => fake as unknown as Query) as typeof import("@anthropic-ai/claude-agent-sdk").query,
    });
    const events: SessionHostEvent[] = [];
    host.onEvent((event) => events.push(event));
    host.start();
    fake.push({ type: "system", subtype: "task_started", task_id: "live", description: "Command", session_id: sessionId, uuid: randomUUID() });
    await new Promise((resolve) => setImmediate(resolve));
    const closing = host.close();
    try {
      expect(host.running).toBe(true);
      expect(events.some((event) => event.type === "runtime.stopped")).toBe(false);
    } finally { fake.releaseClose(); await closing; }
    expect(host.running).toBe(false);
    expect(host.initialized).toBe(false);
    expect(host.runningBackgroundTasks).toEqual([]);
    expect(events.filter((event) => event.type === "runtime.stopped")).toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({ type: "task.notification", taskId: "live", state: "stopped" }));
  });

  it("keeps background output visible after a result without attaching it to the next human turn", async () => {
    const fake = new FakeQuery();
    const sessionId = randomUUID();
    const host = new ClaudeSessionHost({
      sessionId, cwd: "/tmp/bridge-project", executablePath: "/fake/claude", environment: {},
      permissionBroker: new PermissionBroker(), resume: true,
      queryFactory: (() => fake as unknown as Query) as typeof import("@anthropic-ai/claude-agent-sdk").query,
    });
    const events: SessionHostEvent[] = [];
    host.onEvent((event) => events.push(event));
    try {
      const first = host.send("launch", "mobile");
      fake.push({ type: "system", subtype: "task_started", task_id: "agent", tool_use_id: "agent-tool", description: "Research", session_id: sessionId, uuid: randomUUID() });
      fake.push({ type: "result", subtype: "success", is_error: false, result: "Launched", user_message_uuid: first.messageId, session_id: sessionId, uuid: randomUUID() } as SDKMessage);
      await waitForEvent(events, "turn.completed");
      fake.push({ type: "tool_progress", task_id: "agent", tool_use_id: "agent-read", tool_name: "Read", parent_tool_use_id: "agent-tool", elapsed_time_seconds: 1, session_id: sessionId, uuid: randomUUID() });
      await new Promise((resolve) => setImmediate(resolve));
      expect(events).toContainEqual(expect.objectContaining({ type: "tool.progress", itemId: "agent-read" }));
      expect(events.find((event) => event.type === "tool.progress")).not.toHaveProperty("turnId");
      const second = host.send("next question", "mobile");
      fake.push({ type: "assistant", parent_tool_use_id: "agent-tool", message: { content: [{ type: "text", text: "Research update" }] }, session_id: sessionId, uuid: randomUUID() } as SDKMessage);
      await waitForEvent(events, "assistant.completed");
      expect(events.find((event) => event.type === "assistant.completed")).not.toHaveProperty("turnId");
      expect(events.filter((event) => event.type === "user.accepted")).toEqual([expect.objectContaining({ messageId: first.messageId })]);
      expect(host.busy).toBe(true);
      expect(host.hasPendingInput).toBe(true);
      fake.push({ type: "result", subtype: "success", is_error: false, result: "Answered", user_message_uuid: second.messageId, session_id: sessionId, uuid: randomUUID() } as SDKMessage);
      await new Promise((resolve) => setImmediate(resolve));
      expect(host.busy).toBe(false);
    } finally { await host.close(); }
  });

  it("turns task_updated killed status into a canonical stopped task", async () => {
    const fake = new FakeQuery();
    const sessionId = randomUUID();
    const host = new ClaudeSessionHost({
      sessionId, cwd: "/tmp/bridge-project", executablePath: "/fake/claude", environment: {},
      permissionBroker: new PermissionBroker(), resume: true,
      queryFactory: (() => fake as unknown as Query) as typeof import("@anthropic-ai/claude-agent-sdk").query,
    });
    const events: SessionHostEvent[] = [];
    host.onEvent((event) => events.push(event));
    try {
      host.start();
      fake.push({ type: "system", subtype: "task_started", task_id: "agent", tool_use_id: "agent-tool", description: "Research", session_id: sessionId, uuid: randomUUID() });
      fake.push({ type: "system", subtype: "task_updated", task_id: "agent", patch: { status: "paused", description: "Waiting", is_backgrounded: true }, session_id: sessionId, uuid: randomUUID() });
      await waitForEvent(events, "task.progress");
      expect(host.runningBackgroundTasks[0]).toMatchObject({ state: "paused", description: "Waiting" });
      fake.push({ type: "system", subtype: "task_updated", task_id: "agent", patch: { status: "killed", end_time: 1234 }, session_id: sessionId, uuid: randomUUID() });
      await waitForEvent(events, "task.notification");
      expect(events).toContainEqual(expect.objectContaining({ type: "task.notification", taskId: "agent", toolUseId: "agent-tool", state: "stopped", completedAt: 1234 }));
      expect(host.runningBackgroundTasks).toEqual([]);
    } finally { await host.close(); }
  });

  it("fails unfinished tasks on an unexpected stream exit and resets membership for the next process", async () => {
    const output = new AsyncInputQueue<SDKMessage>();
    const nextQuery = new FakeQuery();
    const sessionId = randomUUID();
    let queries = 0;
    const host = new ClaudeSessionHost({
      sessionId, cwd: "/tmp/bridge-project", executablePath: "/fake/claude", environment: {},
      permissionBroker: new PermissionBroker(), resume: true,
      queryFactory: (() => queries++ === 0 ? {
        [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](),
        async initializationResult() { return {}; }, close() { output.close(); },
        async [Symbol.asyncDispose]() { output.close(); },
      } as unknown as Query : nextQuery as unknown as Query) as typeof import("@anthropic-ai/claude-agent-sdk").query,
    });
    const events: SessionHostEvent[] = [];
    host.onEvent((event) => events.push(event));
    try {
      host.start();
      output.push({ type: "system", subtype: "task_started", task_id: "agent", tool_use_id: "agent-tool", description: "Research", session_id: sessionId, uuid: randomUUID() });
      await waitForEvent(events, "task.started");
      output.close(new Error("CLI exited"));
      await waitForEvent(events, "runtime.stopped");
      expect(events).toContainEqual(expect.objectContaining({ type: "task.notification", taskId: "agent", state: "failed", error: "CLI exited" }));
      expect(host.backgroundTasksKnown).toBe(false);
      host.start();
      expect(host.runningBackgroundTasks).toEqual([]);
      nextQuery.push({ type: "system", subtype: "background_tasks_changed", tasks: [], session_id: sessionId, uuid: randomUUID() });
      await new Promise((resolve) => setImmediate(resolve));
      expect(host.backgroundTasksKnown).toBe(true);
    } finally { await host.close(); }
  });

  it("does not report ready after initialization fails", async () => {
    const fake = new FakeQuery();
    fake.initialization = Promise.reject(new Error("Initialization failed"));
    const host = new ClaudeSessionHost({
      sessionId: randomUUID(), cwd: "/tmp/bridge-project", executablePath: "/fake/claude", environment: {},
      permissionBroker: new PermissionBroker(), resume: true,
      queryFactory: (() => fake as unknown as Query) as typeof import("@anthropic-ai/claude-agent-sdk").query,
    });
    const events: SessionHostEvent[] = [];
    host.onEvent((event) => events.push(event));
    try {
      const turn = host.send("input", "mobile");
      await waitForEvent(events, "runtime.stopped");
      expect(events).toContainEqual(expect.objectContaining({ type: "turn.failed", turnId: turn.turnId, error: "Initialization failed" }));
      expect(events.some((event) => event.type === "runtime.ready" || event.type === "user.accepted")).toBe(false);
      expect(host.running).toBe(false);
      expect(host.hasPendingInput).toBe(false);
    } finally { await host.close(); }
  });

  it("starts a fresh run when the SDK reuses a completed task ID", async () => {
    const fake = new FakeQuery();
    const sessionId = randomUUID();
    const host = new ClaudeSessionHost({
      sessionId, cwd: "/tmp/bridge-project", executablePath: "/fake/claude", environment: {},
      permissionBroker: new PermissionBroker(), resume: true,
      queryFactory: (() => fake as unknown as Query) as typeof import("@anthropic-ai/claude-agent-sdk").query,
    });
    const events: SessionHostEvent[] = [];
    host.onEvent((event) => events.push(event));
    try {
      host.start();
      fake.push({ type: "system", subtype: "task_started", task_id: "agent", tool_use_id: "old-tool", description: "First run", session_id: sessionId, uuid: randomUUID() });
      fake.push({ type: "system", subtype: "task_notification", task_id: "agent", status: "completed", output_file: "/tmp/first.output", summary: "First finished", session_id: sessionId, uuid: randomUUID() });
      await waitForEvent(events, "task.notification");
      fake.push({ type: "system", subtype: "task_started", task_id: "agent", tool_use_id: "resume-tool", description: "Resumed run", session_id: sessionId, uuid: randomUUID() });
      await new Promise((resolve) => setImmediate(resolve));
      expect(events.filter((event) => event.type === "task.started")).toHaveLength(2);
      expect(host.runningBackgroundTasks).toEqual([expect.objectContaining({ taskId: "agent", toolUseId: "resume-tool", state: "running", description: "Resumed run" })]);
      expect(host.runningBackgroundTasks[0]).not.toHaveProperty("completedAt");
      expect(host.runningBackgroundTasks[0]).not.toHaveProperty("outputFile");
    } finally { await host.close(); }
  });

  it("makes the completed turn idle before emitting its completion event", async () => {
    const fake = new FakeQuery();
    const sessionId = randomUUID();
    const host = new ClaudeSessionHost({
      sessionId, cwd: "/tmp/bridge-project", executablePath: "/fake/claude", environment: {},
      permissionBroker: new PermissionBroker(), resume: true,
      queryFactory: (() => fake as unknown as Query) as typeof import("@anthropic-ai/claude-agent-sdk").query,
    });
    const observed: boolean[] = [];
    host.onEvent((event) => { if (event.type === "turn.completed") observed.push(host.busy); });
    try {
      const turn = host.send("input", "mobile");
      fake.push({ type: "result", subtype: "success", is_error: false, result: "Done", user_message_uuid: turn.messageId, session_id: sessionId, uuid: randomUUID() } as SDKMessage);
      await new Promise((resolve) => setImmediate(resolve));
      expect(observed).toEqual([false]);
    } finally { await host.close(); }
  });

  it.each(["failure", "close", "retire"] as const)("waits for SDK disposal after initialization %s before releasing the writer", async (ending) => {
    const fake = new FakeQuery();
    let rejectInitialization!: (error: Error) => void;
    let finishDisposal!: () => void;
    fake.initialization = new Promise((_resolve, reject) => { rejectInitialization = reject; });
    fake.disposal = new Promise((resolve) => { finishDisposal = resolve; });
    let queries = 0;
    const nextQuery = new FakeQuery();
    const host = new ClaudeSessionHost({
      sessionId: randomUUID(), cwd: "/tmp/bridge-project", executablePath: "/fake/claude", environment: {},
      permissionBroker: new PermissionBroker(), resume: true,
      queryFactory: (() => queries++ === 0 ? fake as unknown as Query : nextQuery as unknown as Query) as typeof import("@anthropic-ai/claude-agent-sdk").query,
    });
    const events: SessionHostEvent[] = [];
    host.onEvent((event) => events.push(event));
    host.start();
    let operationDone = false;
    const closing = ending === "close" ? host.close() : ending === "retire" ? host.setAutoCompactWindow(100_000) : Promise.resolve();
    void closing.then(() => { operationDone = true; });
    // SDK close rejects pending initialize controls before its async cleanup finishes.
    rejectInitialization(new Error("Initialize rejected"));
    await new Promise((resolve) => setImmediate(resolve));
    try {
      expect(host.running).toBe(true);
      expect(fake.disposing).toBe(true);
      expect(events.some((event) => event.type === "runtime.stopped")).toBe(false);
      if (ending !== "failure") expect(operationDone).toBe(false);
      if (ending === "failure") host.start();
      expect(queries).toBe(1);
    } finally { finishDisposal(); await closing; }
    await waitForEvent(events, "runtime.stopped");
    expect(host.running).toBe(false);
    if (ending !== "close") { host.start(); expect(queries).toBe(2); }
    await host.close();
  });

  it("never attaches child output before task_started to a pending human turn", async () => {
    const fake = new FakeQuery();
    const sessionId = randomUUID();
    const host = new ClaudeSessionHost({
      sessionId, cwd: "/tmp/bridge-project", executablePath: "/fake/claude", environment: {},
      permissionBroker: new PermissionBroker(), resume: true,
      queryFactory: (() => fake as unknown as Query) as typeof import("@anthropic-ai/claude-agent-sdk").query,
    });
    const events: SessionHostEvent[] = [];
    host.onEvent((event) => events.push(event));
    try {
      host.send("waiting for replay", "mobile");
      fake.push({ type: "stream_event", parent_tool_use_id: "unseen-parent", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Child delta" } }, session_id: sessionId, uuid: randomUUID() } as SDKMessage);
      fake.push({ type: "assistant", parent_tool_use_id: "unseen-parent", message: { content: [{ type: "text", text: "Child reply" }, { type: "tool_use", id: "nested-tool", name: "Read", input: {} }] }, session_id: sessionId, uuid: randomUUID() } as SDKMessage);
      fake.push({ type: "user", parent_tool_use_id: "unseen-parent", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "nested-tool", content: "Nested result" }] }, session_id: sessionId, uuid: randomUUID() });
      fake.push({ type: "tool_progress", parent_tool_use_id: "unseen-parent", tool_use_id: "nested-tool", tool_name: "Read", elapsed_time_seconds: 1, session_id: sessionId, uuid: randomUUID() });
      await waitForEvent(events, "tool.progress");
      const output = events.filter((event) => event.type.startsWith("assistant.") || event.type.startsWith("tool."));
      expect(output).toHaveLength(5);
      for (const event of output) expect(event).not.toHaveProperty("turnId");
      expect(host.hasPendingInput).toBe(true);
      expect(events.some((event) => event.type === "user.accepted" || event.type === "turn.started")).toBe(false);
    } finally { await host.close(); }
  });

  it("preserves ambient task visibility through progress and terminal notifications", async () => {
    const fake = new FakeQuery();
    const sessionId = randomUUID();
    const host = new ClaudeSessionHost({
      sessionId, cwd: "/tmp/bridge-project", executablePath: "/fake/claude", environment: {},
      permissionBroker: new PermissionBroker(), resume: true,
      queryFactory: (() => fake as unknown as Query) as typeof import("@anthropic-ai/claude-agent-sdk").query,
    });
    const events: SessionHostEvent[] = [];
    host.onEvent((event) => events.push(event));
    try {
      host.start();
      fake.push({ type: "system", subtype: "task_started", task_id: "housekeeping", description: "Background maintenance", skip_transcript: true, session_id: sessionId, uuid: randomUUID() });
      fake.push({ type: "system", subtype: "task_progress", task_id: "housekeeping", description: "Still maintaining", usage: { total_tokens: 0, tool_uses: 0, duration_ms: 1 }, session_id: sessionId, uuid: randomUUID() });
      await waitForEvent(events, "task.progress");
      expect(host.runningBackgroundTasks[0]).toMatchObject({ skipTranscript: true });
      fake.push({ type: "system", subtype: "task_notification", task_id: "housekeeping", status: "completed", output_file: "", summary: "Done", session_id: sessionId, uuid: randomUUID() });
      await waitForEvent(events, "task.notification");
      for (const event of events.filter((event) => event.type.startsWith("task."))) expect(event).toMatchObject({ skipTranscript: true });
      fake.push({ type: "system", subtype: "task_notification", task_id: "ambient-notification-only", status: "completed", output_file: "", summary: "Done", skip_transcript: true, session_id: sessionId, uuid: randomUUID() });
      await new Promise((resolve) => setImmediate(resolve));
      expect(events.filter((event) => event.type === "task.notification").at(-1)).toMatchObject({ skipTranscript: true });
    } finally { await host.close(); }
  });

  it.each([false, true])("emits individual progress without resending every background task (snapshot=%s)", async (snapshot) => {
    const fake = new FakeQuery();
    const sessionId = randomUUID();
    const host = new ClaudeSessionHost({
      sessionId, cwd: "/tmp/bridge-project", executablePath: "/fake/claude", environment: {},
      permissionBroker: new PermissionBroker(), resume: true,
      queryFactory: (() => fake as unknown as Query) as typeof import("@anthropic-ai/claude-agent-sdk").query,
    });
    const events: SessionHostEvent[] = [];
    host.onEvent((event) => events.push(event));
    try {
      host.start();
      if (snapshot) fake.push({ type: "system", subtype: "background_tasks_changed", tasks: ["A", "B"].map(task_id => ({ task_id, task_type: "local_agent", description: task_id })), session_id: sessionId, uuid: randomUUID() });
      for (const task_id of ["A", "B"]) fake.push({ type: "system", subtype: "task_started", task_id, description: task_id, session_id: sessionId, uuid: randomUUID() });
      await new Promise((resolve) => setImmediate(resolve));
      const membershipEvents = events.filter((event) => event.type === "background.tasks").length;
      expect(membershipEvents).toBe(snapshot ? 1 : 2);
      events.length = 0;
      fake.push({ type: "system", subtype: "task_progress", task_id: "A", description: "Updated A", usage: { total_tokens: 3, tool_uses: 1, duration_ms: 4 }, session_id: sessionId, uuid: randomUUID() });
      await waitForEvent(events, "task.progress");
      expect(events.map((event) => event.type)).toEqual(["task.progress"]);
      expect(host.runningBackgroundTasks).toHaveLength(2);
      expect(host.runningBackgroundTasks.find((task) => task.taskId === "A")?.description).toBe("Updated A");
    } finally { await host.close(); }
  });

  it("uses first-writer-wins permission resolution", async () => {
    const broker = new PermissionBroker();
    const controller = new AbortController();
    let resolution: { decision?: string; resolvedByDeviceId?: string } | undefined;
    broker.on("resolved", (_request, _result, resolved) => {
      resolution = resolved;
    });
    const pending = broker.request("session", "Bash", { command: "npm test" }, {
      signal: controller.signal,
      toolUseId: "tool-1",
    });
    const [request] = broker.list();
    expect(request?.toolName).toBe("Bash");
    expect(broker.resolveRequest(
      request!.requestId,
      "allow-always",
      undefined,
      undefined,
      { deviceId: "phone-1", name: "Android 手机" },
    )).toBe(true);
    expect(broker.resolveRequest(request!.requestId, "deny")).toBe(false);
    await expect(pending).resolves.toMatchObject({ behavior: "allow" });
    expect(resolution).toMatchObject({
      decision: "allow-once",
      resolvedByDeviceId: "phone-1",
    });
  });
});
