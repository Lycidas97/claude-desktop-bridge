import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  query as createQuery,
  type CanUseTool,
  type ModelInfo,
  type Query,
  type SDKControlGetContextUsageResponse,
  type SDKMessage,
  type SDKUserMessage,
  type Settings,
} from "@anthropic-ai/claude-agent-sdk";
import {
  isClaudeTranscriptControlMessage,
  type BridgeAttachment,
  type BridgePermissionRules,
  type BridgeSDKPermissionMode,
  type BridgeSlashCommand,
} from "@bridge/protocol";
import { AsyncInputQueue } from "./async-input-queue.js";
import type { ClaudeSessionEffort } from "./claude-desktop-sessions.js";
import { BRIDGE_PERMISSION_HOST_ENV } from "./claude-permission-hook.js";
import type { PermissionBroker } from "./permission-broker.js";

export type SessionHostOrigin = "desktop" | "mobile" | "system";

export interface SessionHostBackgroundTask {
  taskId: string;
  toolUseId?: string;
  description: string;
  state: "pending" | "running" | "paused" | "completed" | "failed" | "stopped";
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  taskType?: string;
  subagentType?: string;
  summary?: string;
  outputFile?: string;
  error?: string;
  lastToolName?: string;
  isBackgrounded?: boolean;
  skipTranscript?: boolean;
  usage?: { totalTokens: number; toolUses: number; durationMs: number };
}

export type SessionHostEvent =
  | { type: "runtime.started"; sessionId: string; cwd: string; at: number }
  | { type: "runtime.ready"; sessionId: string; at: number }
  | { type: "runtime.stopped"; sessionId: string; at: number }
  | { type: "user.submitted"; sessionId: string; turnId: string; messageId: string; at: number }
  | { type: "background.tasks"; sessionId: string; tasks: SessionHostBackgroundTask[]; at: number }
  | ({ type: "task.started" | "task.progress" | "task.notification"; sessionId: string; turnId?: string; at: number } & SessionHostBackgroundTask)
  | { type: "turn.started"; sessionId: string; turnId: string; at: number }
  | { type: "command.output"; sessionId: string; turnId?: string; itemId: string; text: string; at: number }
  | { type: "command.status"; sessionId: string; turnId?: string; text: string; at: number }
  | { type: "session.compacted"; sessionId: string; itemId: string; at: number }
  | { type: "session.reset"; sessionId: string; previousNativeSessionId: string; nativeSessionId: string; at: number }
  | {
      type: "user.accepted";
      sessionId: string;
      turnId: string;
      messageId: string;
      text: string;
      attachments: Array<Omit<BridgeAttachment, "data">>;
      origin: SessionHostOrigin;
      at: number;
    }
  | { type: "assistant.delta"; sessionId: string; turnId?: string; itemId: string; text: string; at: number }
  | { type: "assistant.completed"; sessionId: string; turnId?: string; itemId: string; text: string; at: number }
  | { type: "tool.started"; sessionId: string; turnId?: string; itemId: string; toolName: string; input: unknown; at: number }
  | { type: "tool.progress"; sessionId: string; turnId?: string; itemId: string; text: string; at: number }
  | { type: "tool.completed"; sessionId: string; turnId?: string; itemId: string; output: unknown; at: number }
  | { type: "turn.completed"; sessionId: string; turnId?: string; result: string; at: number }
  | { type: "turn.failed"; sessionId: string; turnId?: string; error: string; at: number }
  | { type: "turn.interrupted"; sessionId: string; turnId?: string; at: number }
  | { type: "runtime.error"; sessionId: string; error: string; at: number };

export interface ClaudeSessionHostOptions {
  sessionId: string;
  eventSessionId?: string;
  cwd: string;
  executablePath: string;
  environment: NodeJS.ProcessEnv;
  permissionBroker: PermissionBroker;
  resume: boolean;
  model?: string;
  effort?: ClaudeSessionEffort;
  settingSources?: Array<"user" | "project" | "local">;
  persistSession?: boolean;
  queryFactory?: typeof createQuery;
}

export interface SessionHostInput {
  text: string;
  attachments?: BridgeAttachment[];
  messageId?: string;
  turnId?: string;
  priority?: SDKUserMessage["priority"];
}

function needsWindowsShell(executablePath: string): boolean {
  return process.platform === "win32" && /\.(?:cmd|bat)$/iu.test(executablePath);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textBlocks(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => (
    isRecord(block) && block.type === "text" && typeof block.text === "string"
      ? [block.text]
      : []
  ));
}

function toolBlocks(content: unknown): Array<{ id: string; name: string; input: unknown }> {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    if (!isRecord(block) || block.type !== "tool_use") return [];
    if (typeof block.id !== "string" || typeof block.name !== "string") return [];
    return [{ id: block.id, name: block.name, input: block.input }];
  });
}

function isSyntheticAssistantFailure(message: SDKMessage & { type: "assistant" }, text: string): boolean {
  const payload = message.message as unknown;
  if (!isRecord(payload) || payload.model !== "<synthetic>") return false;
  return payload.stop_reason === "model_context_window_exceeded" ||
    /^(?:Prompt is too long|API Error:|Error:)/iu.test(text);
}

function partialText(message: SDKMessage): { itemId: string; text: string } | undefined {
  if (message.type !== "stream_event") return undefined;
  const event = message.event as unknown;
  if (!isRecord(event) || event.type !== "content_block_delta" || !isRecord(event.delta)) return undefined;
  if (event.delta.type !== "text_delta" || typeof event.delta.text !== "string") return undefined;
  const index = typeof event.index === "number" ? event.index : 0;
  return { itemId: `${message.uuid}:${index}`, text: event.delta.text };
}

interface PendingTurn {
  turnId: string;
  messageId: string;
  userMessage: SDKUserMessage;
  interrupted: boolean;
  submitted: boolean;
  accepted: boolean;
  text: string;
  attachments: Array<Omit<BridgeAttachment, "data">>;
  origin: SessionHostOrigin;
}

export class ClaudeSessionHost extends EventEmitter {
  private input = new AsyncInputQueue<SDKUserMessage>();
  private readonly pendingTurns: PendingTurn[] = [];
  private readonly queryFactory: typeof createQuery;
  private queryProcess: Query | undefined;
  private streamTask: Promise<void> | undefined;
  private retiring = false;
  private hasStartedQuery = false;
  private sessionIdValue: string;
  private eventSessionId: string;
  private slashCommandsValue: BridgeSlashCommand[] | undefined;
  private permissionModeValue: BridgeSDKPermissionMode = "default";
  private permissionSettings: NonNullable<Settings["permissions"]> = {};
  private currentTurnId: string | undefined;
  private nativeSteering = false;
  private readonly toolTurns = new Map<string, string>();
  private readonly foregroundTasks = new Set<string>();
  private modelValue: string | undefined;
  private effortValue: ClaudeSessionEffort | undefined;
  private autoCompactWindow: number | undefined;
  private closed = false;
  private initializedValue = false;
  private readonly tasks = new Map<string, SessionHostBackgroundTask>();
  private backgroundTaskIds = new Set<string>();
  private hasBackgroundSnapshot = false;

  constructor(private readonly options: ClaudeSessionHostOptions) {
    super();
    this.queryFactory = options.queryFactory ?? createQuery;
    this.sessionIdValue = options.sessionId;
    this.eventSessionId = options.eventSessionId ?? options.sessionId;
    this.modelValue = options.model;
    this.effortValue = options.effort;
  }

  get sessionId(): string {
    return this.sessionIdValue;
  }

  get slashCommands(): BridgeSlashCommand[] | undefined {
    return this.slashCommandsValue;
  }

  rebindSession(logicalSessionId: string): void {
    this.eventSessionId = logicalSessionId;
  }

  get running(): boolean {
    return Boolean(this.streamTask);
  }

  get busy(): boolean {
    return this.currentTurnId !== undefined;
  }

  get initialized(): boolean {
    return this.initializedValue;
  }

  get hasPendingInput(): boolean {
    return this.pendingTurns.some((turn) => !turn.interrupted && !turn.accepted);
  }

  get backgroundTasksKnown(): boolean {
    return this.hasBackgroundSnapshot || this.tasks.size > 0;
  }

  get runningBackgroundTasks(): SessionHostBackgroundTask[] {
    return [...this.backgroundTaskIds].map((taskId) => ({ ...this.tasks.get(taskId)! }));
  }

  onEvent(listener: (event: SessionHostEvent) => void): () => void {
    this.on("event", listener);
    return () => this.off("event", listener);
  }

  start(): void {
    if (this.closed) throw new Error("Session host is closed");
    if (this.retiring) throw new Error("Session host is retiring its previous writer");
    if (this.streamTask) return;
    const canUseTool: CanUseTool = async (toolName, input, context) => (
      this.options.permissionBroker.request(this.eventSessionId, toolName, input, {
        signal: context.signal,
        toolUseId: context.toolUseID,
        ...(context.suggestions ? { suggestions: context.suggestions } : {}),
        ...(context.title ? { title: context.title } : {}),
        ...(context.displayName ? { displayName: context.displayName } : {}),
        ...(context.description ? { description: context.description } : {}),
      })
    );
    const resumeExistingSession = this.options.resume || this.hasStartedQuery;
    const executor = { exited: Promise.resolve(), stderr: "" };
    const settings: Settings = {
      ...(this.autoCompactWindow ? { autoCompactWindow: this.autoCompactWindow } : {}),
      ...(Object.keys(this.permissionSettings).length > 0 ? { permissions: this.permissionSettings } : {}),
    };
    const queryProcess = this.queryFactory({
      prompt: this.input,
      options: {
        cwd: this.options.cwd,
        env: {
          ...this.options.environment,
          [BRIDGE_PERMISSION_HOST_ENV]: "sdk",
        },
        pathToClaudeCodeExecutable: this.options.executablePath,
        includePartialMessages: true,
        includeHookEvents: true,
        extraArgs: { "replay-user-messages": null },
        settingSources: this.options.settingSources ?? ["user", "project", "local"],
        permissionMode: this.permissionModeValue,
        canUseTool,
        persistSession: this.options.persistSession ?? true,
        ...(this.modelValue ? { model: this.modelValue } : {}),
        ...(this.effortValue ? { effort: this.effortValue } : {}),
        ...(Object.keys(settings).length > 0 ? { settings } : {}),
        spawnClaudeCodeProcess: (options) => {
          const child = spawn(options.command, options.args, {
            cwd: options.cwd,
            env: options.env,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
            shell: needsWindowsShell(this.options.executablePath),
            signal: options.signal,
          });
          executor.exited = new Promise<void>((resolve) => {
            child.once("exit", () => resolve());
            child.once("error", () => {
              // A failed spawn has no executor; abort errors still need the exit event.
              if (child.pid === undefined) resolve();
            });
          });
          child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
            executor.stderr = (executor.stderr + chunk).slice(-2_048);
          });
          return child;
        },
        ...(resumeExistingSession
          ? { resume: this.sessionIdValue, forkSession: false }
          : { sessionId: this.sessionIdValue }),
      },
    });
    this.hasStartedQuery = true;
    this.queryProcess = queryProcess;
    this.emitEvent({
      type: "runtime.started",
      sessionId: this.sessionIdValue,
      cwd: this.options.cwd,
      at: Date.now(),
    });
    this.streamTask = this.consume(queryProcess, executor);
  }

  async ready(): Promise<void> {
    await this.activeQuery().initializationResult();
  }

  async setModel(model?: string): Promise<void> {
    if (this.modelValue === model) return;
    const query = this.activeQuery();
    await query.setModel(model);
    this.modelValue = model;
  }

  async setEffort(effort?: ClaudeSessionEffort): Promise<void> {
    if (this.effortValue === effort) return;
    const query = this.activeQuery();
    await query.applyFlagSettings({ effortLevel: effort ?? null });
    this.effortValue = effort;
  }

  async setAutoCompactWindow(maxTokens?: number): Promise<void> {
    if (this.autoCompactWindow === maxTokens) return;
    if (this.currentTurnId) throw new Error("Cannot change the auto-compact window during a turn");
    // Headless CLI only applies this setting at query startup.
    if (this.queryProcess) await this.retireQuery(undefined, this.queryProcess);
    this.autoCompactWindow = maxTokens;
  }

  getPermissions(): { mode: BridgeSDKPermissionMode; rules: BridgePermissionRules } {
    return {
      mode: this.permissionModeValue,
      rules: {
        allow: this.permissionSettings.allow ?? [],
        ask: this.permissionSettings.ask ?? [],
        deny: this.permissionSettings.deny ?? [],
      },
    };
  }

  async setPermissions(mode: BridgeSDKPermissionMode, rules: BridgePermissionRules): Promise<void> {
    const query = this.activeQuery();
    await query.setPermissionMode(mode);
    this.permissionModeValue = mode;
    const permissions = { ...this.permissionSettings, ...rules };
    await query.applyFlagSettings({ permissions });
    this.permissionSettings = permissions;
  }

  async supportedModels(): Promise<ModelInfo[]> {
    return this.activeQuery().supportedModels();
  }

  async contextUsage(): Promise<SDKControlGetContextUsageResponse> {
    return this.activeQuery().getContextUsage();
  }

  send(input: string | SessionHostInput, origin: SessionHostOrigin): { messageId: string; turnId: string } {
    const normalizedInput = typeof input === "string" ? { text: input } : input;
    const normalized = normalizedInput.text.trim();
    const attachments = normalizedInput.attachments ?? [];
    if (!normalized && attachments.length === 0) throw new Error("Message cannot be empty");
    if (this.closed) throw new Error("Session host is closed");
    if (this.currentTurnId && normalizedInput.priority !== "now") throw new Error("Session already has a running turn");
    const messageId = normalizedInput.messageId ?? randomUUID();
    const turnId = normalizedInput.turnId ?? randomUUID();
    this.currentTurnId ??= turnId;
    const content: Array<Record<string, unknown>> = [];
    if (normalized) content.push({ type: "text", text: normalized });
    for (const attachment of attachments) {
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: attachment.mimeType,
          data: attachment.data,
        },
      });
    }
    const userMessage: SDKUserMessage = {
      type: "user",
      message: { role: "user", content } as unknown as SDKUserMessage["message"],
      parent_tool_use_id: null,
      origin: { kind: "human" },
      uuid: messageId as NonNullable<SDKUserMessage["uuid"]>,
      session_id: this.sessionIdValue,
      ...(normalizedInput.priority ? { priority: normalizedInput.priority } : {}),
    };
    const pendingTurn: PendingTurn = {
      turnId,
      messageId,
      userMessage,
      interrupted: false,
      submitted: false,
      accepted: false,
      text: normalized,
      attachments: attachments.map(({ data: _data, ...attachment }) => attachment),
      origin,
    };
    this.pendingTurns.push(pendingTurn);
    try {
      if (normalizedInput.priority === "now" || this.pendingTurns[0] === pendingTurn) this.submitTurn(pendingTurn);
      if (normalizedInput.priority === "now") {
        this.nativeSteering = true;
        for (const toolUseId of this.foregroundTasks) {
          void this.queryProcess!.backgroundTasks(toolUseId).catch((error: unknown) => {
            process.stderr.write(`Bridge could not background tool ${toolUseId}: ${error instanceof Error ? error.message : String(error)}\n`);
          });
        }
      }
    } catch (error) {
      this.input.removePending(userMessage);
      if (this.currentTurnId === turnId) this.currentTurnId = undefined;
      const pendingIndex = this.pendingTurns.indexOf(pendingTurn);
      if (pendingIndex >= 0) this.pendingTurns.splice(pendingIndex, 1);
      throw error;
    }
    return { messageId, turnId };
  }

  async stopTask(taskId: string): Promise<void> {
    if (!this.queryProcess) throw new Error("这个会话的 Claude 进程已退出");
    await this.queryProcess.stopTask(taskId);
  }

  async interrupt(): Promise<void> {
    if (!this.queryProcess || !this.currentTurnId) return;
    const turnId = this.currentTurnId;
    const pendingTurn = this.pendingTurns.find((candidate) => candidate.turnId === turnId);
    if (!pendingTurn) return;
    pendingTurn.interrupted = true;
    if (!pendingTurn.submitted) {
      this.removePendingTurn(pendingTurn);
      this.currentTurnId = undefined;
      this.emitInterrupted(turnId);
      return;
    }
    const queryProcess = this.queryProcess;
    try {
      const receipt = await queryProcess.interrupt();
      const stillQueued = receipt?.still_queued.filter(id => this.pendingTurns.some(turn => turn.messageId === id)) ?? [];
      if (stillQueued.length > 0) {
        const cancellable = queryProcess as Query & {
          cancelAsyncMessage?(messageId: string): Promise<boolean>;
        };
        for (const id of stillQueued) await cancellable.cancelAsyncMessage?.(id).catch(() => false);
        await this.retireQuery(pendingTurn, queryProcess);
      }
    } catch (error) {
      if (this.pendingTurns.includes(pendingTurn)) {
        pendingTurn.interrupted = false;
        throw error;
      }
    }
    if (this.currentTurnId === turnId) this.currentTurnId = undefined;
    this.emitInterrupted(turnId);
  }

  async close(): Promise<void> {
    if (this.closed) return this.streamTask;
    this.closed = true;
    this.input.close();
    this.options.permissionBroker.cancelSession(this.eventSessionId);
    this.queryProcess?.close();
    await this.streamTask;
  }

  private async consume(queryProcess: Query, executor: { exited: Promise<void>; stderr: string }): Promise<void> {
    let failure: string | undefined;
    try {
      this.slashCommandsValue = (await queryProcess.initializationResult()).commands;
      if (!this.closed && !this.retiring) {
        this.initializedValue = true;
        this.emitEvent({ type: "runtime.ready", sessionId: this.sessionIdValue, at: Date.now() });
      }
      for await (const message of queryProcess) this.handleMessage(message);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      // initialize can reject before iteration enters the SDK's cleanup-owning generator.
      await queryProcess[Symbol.asyncDispose]();
      // SDK cleanup stops waiting after 2 s, before its TERM/KILL escalation finishes.
      await executor.exited;
      if (failure && executor.stderr.trim()) failure += `\n${executor.stderr.trim()}`;
      if (this.queryProcess === queryProcess) {
        const unfinishedTurns = this.pendingTurns.splice(0);
        const endedTasks = this.runningBackgroundTasks;
        const intentional = this.closed || this.retiring;
        const at = Date.now();
        this.queryProcess = undefined;
        this.streamTask = undefined;
        this.initializedValue = false;
        this.input.close();
        this.input = new AsyncInputQueue<SDKUserMessage>();
        this.currentTurnId = undefined;
        this.nativeSteering = false;
        this.toolTurns.clear();
        this.foregroundTasks.clear();
        this.tasks.clear();
        this.backgroundTaskIds.clear();
        this.hasBackgroundSnapshot = false;
        for (const turn of unfinishedTurns) {
          if (turn.interrupted) continue;
          if (intentional) this.emitInterrupted(turn.turnId);
          else this.emitEvent({
            type: "turn.failed", sessionId: this.sessionIdValue, turnId: turn.turnId,
            error: failure ?? "Claude session ended before returning a turn result", at,
          });
        }
        for (const task of endedTasks) {
          if (task.state === "completed" || task.state === "failed" || task.state === "stopped") continue;
          this.emitEvent({
            ...task, type: "task.notification", sessionId: this.sessionIdValue,
            state: intentional ? "stopped" : "failed", completedAt: at, updatedAt: at,
            ...(intentional ? {} : { error: failure ?? "Claude session ended while the task was running" }), at,
          });
        }
        this.emitEvent({ type: "background.tasks", sessionId: this.sessionIdValue, tasks: [], at });
        if (!intentional && (failure !== undefined || unfinishedTurns.some((turn) => !turn.interrupted) || endedTasks.length > 0)) {
          this.emitEvent({
            type: "runtime.error", sessionId: this.sessionIdValue,
            error: failure ?? "Claude session ended before returning a turn result", at,
          });
        }
        this.emitEvent({ type: "runtime.stopped", sessionId: this.sessionIdValue, at });
      }
    }
  }

  private activeQuery(): Query {
    if (this.closed) throw new Error("Session host is closed");
    if (this.retiring) throw new Error("Session host is retiring its previous writer");
    this.start();
    if (!this.queryProcess) throw new Error("Session host failed to start");
    return this.queryProcess;
  }

  private referencedTurns(message: SDKMessage): PendingTurn[] {
    const value = message as SDKMessage & { user_message_uuid?: unknown; user_message_uuids?: unknown };
    const ids = new Set([
      ...(Array.isArray(value.user_message_uuids) ? value.user_message_uuids.filter((id): id is string => typeof id === "string") : []),
      ...(typeof value.user_message_uuid === "string" ? [value.user_message_uuid] : []),
    ]);
    return this.pendingTurns.filter(turn => turn.submitted && ids.has(turn.messageId));
  }

  private handleMessage(message: SDKMessage): void {
    if (message.type === "conversation_reset") {
      const previousNativeSessionId = this.sessionIdValue;
      this.sessionIdValue = message.new_conversation_id;
      this.emitEvent({
        type: "session.reset", sessionId: this.eventSessionId,
        previousNativeSessionId, nativeSessionId: this.sessionIdValue, at: Date.now(),
      });
      return;
    }
    if (message.type === "system" && message.subtype === "init") {
      this.permissionModeValue = message.permissionMode;
      const commands = new Map(this.slashCommandsValue?.map(command => [command.name, command]));
      for (const name of message.slash_commands) {
        if (!commands.has(name)) commands.set(name, { name, description: "" });
      }
      this.slashCommandsValue = [...commands.values()];
      return;
    }
    if (message.type === "system" && message.subtype === "commands_changed") {
      this.slashCommandsValue = message.commands;
      return;
    }
    if (message.type === "system" && message.subtype === "compact_boundary") {
      this.emitEvent({ type: "session.compacted", sessionId: this.sessionIdValue, itemId: message.uuid, at: Date.now() });
      return;
    }
    if (message.type === "system" && message.subtype === "background_tasks_changed") {
      const at = Date.now();
      this.hasBackgroundSnapshot = true;
      this.backgroundTaskIds = new Set(message.tasks.map((task) => task.task_id));
      for (const task of message.tasks) {
        const previous = this.tasks.get(task.task_id);
        const continuing = previous && previous.completedAt === undefined ? previous : undefined;
        this.tasks.set(task.task_id, {
          ...continuing, taskId: task.task_id, taskType: task.task_type,
          description: task.description, state: "running", isBackgrounded: true,
          startedAt: continuing?.startedAt ?? at, updatedAt: at,
        });
      }
      this.emitEvent({ type: "background.tasks", sessionId: this.sessionIdValue, tasks: this.runningBackgroundTasks, at });
      return;
    }
    if (message.type === "system" && (
      message.subtype === "task_started" || message.subtype === "task_progress" ||
      message.subtype === "task_notification" || message.subtype === "task_updated"
    )) {
      const at = Date.now();
      const wasBackgroundMember = this.backgroundTaskIds.has(message.task_id);
      const previous = message.subtype === "task_started" && this.tasks.get(message.task_id)?.completedAt !== undefined
        ? undefined : this.tasks.get(message.task_id);
      const task: SessionHostBackgroundTask = {
        taskId: message.task_id, description: "", state: "running", startedAt: at,
        ...previous, updatedAt: at,
      };
      let type: "task.started" | "task.progress" | "task.notification";
      if (message.subtype === "task_updated") {
        type = "task.progress";
        if (message.patch.description !== undefined) task.description = message.patch.description;
        if (message.patch.status !== undefined) task.state = message.patch.status === "killed" ? "stopped" : message.patch.status;
        if (message.patch.end_time !== undefined) task.completedAt = message.patch.end_time;
        if (message.patch.error !== undefined) task.error = message.patch.error;
        if (message.patch.is_backgrounded !== undefined) task.isBackgrounded = message.patch.is_backgrounded;
      } else {
        if (message.tool_use_id !== undefined) task.toolUseId = message.tool_use_id;
        if ("skip_transcript" in message && message.skip_transcript !== undefined) task.skipTranscript = message.skip_transcript;
        if (message.subtype === "task_notification") {
          type = "task.notification";
          task.state = message.status;
          task.completedAt = at;
          task.summary = message.summary;
          task.outputFile = message.output_file;
        } else {
          type = message.subtype === "task_started" ? "task.started" : "task.progress";
          task.description = message.description;
          if (message.subagent_type !== undefined) task.subagentType = message.subagent_type;
          if (message.subtype === "task_started") {
            if (message.task_type !== undefined) task.taskType = message.task_type;
          } else {
            if (message.summary !== undefined) task.summary = message.summary;
            if (message.last_tool_name !== undefined) task.lastToolName = message.last_tool_name;
          }
        }
        if ("usage" in message && message.usage) task.usage = {
          totalTokens: message.usage.total_tokens, toolUses: message.usage.tool_uses, durationMs: message.usage.duration_ms,
        };
      }
      const terminal = task.state === "completed" || task.state === "failed" || task.state === "stopped";
      if (terminal) {
        task.completedAt ??= at;
        type = "task.notification";
      }
      this.tasks.set(task.taskId, task);
      // Older CLIs only emit task edges. Once a full set arrives it alone owns membership.
      if (!this.hasBackgroundSnapshot) {
        if (terminal || task.isBackgrounded === false) this.backgroundTaskIds.delete(task.taskId);
        else this.backgroundTaskIds.add(task.taskId);
      }
      this.emitEvent({ ...task, type, sessionId: this.sessionIdValue, at });
      if (wasBackgroundMember !== this.backgroundTaskIds.has(task.taskId)) {
        this.emitEvent({ type: "background.tasks", sessionId: this.sessionIdValue, tasks: this.runningBackgroundTasks, at });
      }
      return;
    }
    if (message.type === "user" && message.uuid && message.parent_tool_use_id === null && !message.isSynthetic &&
      (!message.origin || message.origin.kind === "human")) {
      const acknowledged = this.pendingTurns.find((turn) => turn.messageId === message.uuid && turn.submitted);
      if (acknowledged) this.acceptTurn(acknowledged);
    }
    const referenced = this.referencedTurns(message);
    const stampedTurn = referenced.at(-1);
    if (stampedTurn && (message.type === "assistant" || message.type === "stream_event")) this.currentTurnId = stampedTurn.turnId;
    const streamTurn = stampedTurn ?? this.pendingTurns.find(turn => turn.turnId === this.currentTurnId) ?? this.pendingTurns[0];
    const backgroundOutput = (message.type === "tool_progress" && message.task_id !== undefined) ||
      ("parent_tool_use_id" in message && message.parent_tool_use_id !== null);
    const turnId = backgroundOutput ? undefined : streamTurn?.turnId;
    const drainingInterruptedTurn = !backgroundOutput && streamTurn?.interrupted === true;
    if (message.type === "system" && message.subtype === "local_command_output") {
      this.emitEvent({
        type: "command.output", sessionId: this.sessionIdValue,
        ...(turnId ? { turnId } : {}), itemId: message.uuid, text: message.content, at: Date.now(),
      });
      return;
    }
    if (message.type === "system" && message.subtype === "status") {
      if (message.permissionMode !== undefined) this.permissionModeValue = message.permissionMode;
      const text = message.compact_result === "failed" ? message.compact_error ?? "Compaction failed"
        : message.status === "compacting" ? "Compacting conversation…" : undefined;
      if (text !== undefined) this.emitEvent({
        type: "command.status", sessionId: this.sessionIdValue,
        ...(turnId ? { turnId } : {}), text, at: Date.now(),
      });
      return;
    }
    const partial = partialText(message);
    if (partial) {
      if ((!turnId && !backgroundOutput) || drainingInterruptedTurn) return;
      this.emitEvent({
        type: "assistant.delta",
        sessionId: this.sessionIdValue,
        ...(turnId ? { turnId } : {}),
        itemId: partial.itemId,
        text: partial.text,
        at: Date.now(),
      });
      return;
    }
    if (message.type === "assistant") {
      if ((!turnId && !backgroundOutput) || drainingInterruptedTurn) return;
      const text = textBlocks(message.message.content).join("\n\n").trim();
      if (
        text &&
        !isClaudeTranscriptControlMessage("assistant", text) &&
        !isSyntheticAssistantFailure(message, text)
      ) {
        this.emitEvent({
          type: "assistant.completed",
          sessionId: this.sessionIdValue,
          ...(turnId ? { turnId } : {}),
          itemId: message.uuid,
          text,
          at: Date.now(),
        });
      }
      for (const tool of toolBlocks(message.message.content)) {
        if (turnId) this.toolTurns.set(tool.id, turnId);
        if (!backgroundOutput && (tool.name === "Bash" || tool.name === "Agent" || tool.name === "Task")) this.foregroundTasks.add(tool.id);
        this.emitEvent({
          type: "tool.started",
          sessionId: this.sessionIdValue,
          ...(turnId ? { turnId } : {}),
          itemId: tool.id,
          toolName: tool.name,
          input: tool.input,
          at: Date.now(),
        });
      }
      return;
    }
    if (message.type === "user" && Array.isArray(message.message.content)) {
      if ((!turnId && !backgroundOutput) || drainingInterruptedTurn) return;
      const results = message.message.content.filter((block) => block.type === "tool_result");
      for (const result of results) {
        this.foregroundTasks.delete(result.tool_use_id);
        const toolTurnId = backgroundOutput ? undefined : this.toolTurns.get(result.tool_use_id) ?? turnId;
        this.emitEvent({
          type: "tool.completed",
          sessionId: this.sessionIdValue,
          ...(toolTurnId ? { turnId: toolTurnId } : {}),
          itemId: result.tool_use_id,
          output: results.length === 1 ? message.tool_use_result ?? result.content : result.content,
          at: Date.now(),
        });
      }
      return;
    }
    if (message.type === "tool_progress") {
      const toolTurnId = backgroundOutput ? undefined : this.toolTurns.get(message.tool_use_id) ?? turnId;
      if ((!toolTurnId && !backgroundOutput) || drainingInterruptedTurn) return;
      this.emitEvent({
        type: "tool.progress",
        sessionId: this.sessionIdValue,
        ...(toolTurnId ? { turnId: toolTurnId } : {}),
        itemId: message.tool_use_id,
        text: `${message.tool_name} ${Math.round(message.elapsed_time_seconds)}s`,
        at: Date.now(),
      });
      return;
    }
    if (message.type === "result") {
      if (message.origin && message.origin.kind !== "human") return;
      // Native steering can finish inputs out of submission order or combine several into one result.
      // Legacy unstamped results are usable only before this query has submitted native steers.
      const stamped = "user_message_uuid" in message || "user_message_uuids" in message;
      const settled = stamped ? referenced : !this.nativeSteering && this.pendingTurns[0] ? [this.pendingTurns[0]] : [];
      for (const turn of settled) {
        if (!turn.interrupted) this.acceptTurn(turn, !this.pendingTurns.some(other => other !== turn && other.accepted));
        this.removePendingTurn(turn);
        if (this.currentTurnId === turn.turnId) this.currentTurnId = this.pendingTurns.find(other => !other.interrupted)?.turnId;
        if (turn.interrupted) continue;
        if (message.terminal_reason === "aborted_streaming" || message.terminal_reason === "aborted_tools") {
          this.emitInterrupted(turn.turnId);
        } else if (message.subtype === "success" && !message.is_error && !/^API Error:/iu.test(message.result.trim())) {
          this.emitEvent({ type: "turn.completed", sessionId: this.sessionIdValue, turnId: turn.turnId, result: message.result, at: Date.now() });
        } else {
          this.emitEvent({
            type: "turn.failed", sessionId: this.sessionIdValue, turnId: turn.turnId,
            error: message.subtype === "success" ? message.result : message.errors.join("\n") || message.subtype,
            at: Date.now(),
          });
        }
      }
      this.submitDeferredTurn();
    }
  }

  private acceptTurn(turn: PendingTurn, started = true): void {
    if (turn.accepted || turn.interrupted) return;
    turn.accepted = true;
    if (started) this.currentTurnId = turn.turnId;
    this.emitEvent({
      type: "user.accepted", sessionId: this.sessionIdValue, turnId: turn.turnId,
      messageId: turn.messageId, text: turn.text, attachments: turn.attachments,
      origin: turn.origin, at: Date.now(),
    });
    if (started) this.emitEvent({ type: "turn.started", sessionId: this.sessionIdValue, turnId: turn.turnId, at: Date.now() });
  }

  private submitTurn(turn: PendingTurn): void {
    if (turn.submitted) return;
    this.input.push(turn.userMessage);
    try {
      this.start();
      turn.submitted = true;
      this.emitEvent({
        type: "user.submitted", sessionId: this.sessionIdValue,
        turnId: turn.turnId, messageId: turn.messageId, at: Date.now(),
      });
    } catch (error) {
      this.input.removePending(turn.userMessage);
      throw error;
    }
  }

  private submitDeferredTurn(): void {
    const nextTurn = this.pendingTurns[0];
    if (!nextTurn || nextTurn.submitted) return;
    try {
      this.submitTurn(nextTurn);
    } catch (error) {
      this.removePendingTurn(nextTurn);
      if (this.currentTurnId === nextTurn.turnId) this.currentTurnId = undefined;
      this.emitEvent({
        type: "turn.failed",
        sessionId: this.sessionIdValue,
        turnId: nextTurn.turnId,
        error: error instanceof Error ? error.message : String(error),
        at: Date.now(),
      });
    }
  }

  private removePendingTurn(turn: PendingTurn): void {
    const index = this.pendingTurns.indexOf(turn);
    if (index >= 0) this.pendingTurns.splice(index, 1);
  }

  private async retireQuery(turn: PendingTurn | undefined, queryProcess: Query): Promise<void> {
    if (this.queryProcess !== queryProcess) return;
    const streamTask = this.streamTask;
    const input = this.input;
    this.retiring = true;
    try {
      input.close();
      queryProcess.close();
      await streamTask?.catch(() => undefined);
    } finally {
      if (this.queryProcess === queryProcess) {
        this.queryProcess = undefined;
        this.streamTask = undefined;
        this.input = new AsyncInputQueue<SDKUserMessage>();
      }
      if (turn) this.removePendingTurn(turn);
      this.retiring = false;
    }
  }

  private emitInterrupted(turnId: string): void {
    this.emitEvent({
      type: "turn.interrupted",
      sessionId: this.sessionIdValue,
      turnId,
      at: Date.now(),
    });
  }

  private emitEvent(event: SessionHostEvent): void {
    this.emit("event", event.sessionId === this.eventSessionId
      ? event
      : { ...event, sessionId: this.eventSessionId });
  }
}
