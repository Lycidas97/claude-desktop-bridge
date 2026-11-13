import { lstat, mkdir, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import {
  evidenceSummary,
  isBridgeNativeImageRef,
  summarizeEvidenceEvent,
  type BridgeAttachment,
  type BridgeDesktopAppStatus,
  type BridgeDesktopRuntime,
  type BridgeDesktopRuntimeId,
  type BridgeDirectoryListing,
  type BridgeEffort,
  type BridgeEvent,
  type BridgeNativePermissionMode,
  type BridgeRequest,
  type BridgeResponse,
  type BridgeSDKPermissionMode,
  type BridgeSessionInfo,
  type DesktopControlSnapshot,
} from "@bridge/protocol";
import { MAGPIE_QUOTA_METHOD } from "../../../../plugins/magpie-quota/contract.js";
import type { createMagpieQuotaPlugin } from "../../../../plugins/magpie-quota/desktop.js";
import type { ClaudeDesktopLifecycle } from "../app/claude-desktop-lifecycle.js";
import { accessibleDirectory } from "../app/working-directory.js";
import { WorkspaceTrustRequiredError, type ClaudeDesktopBridge } from "../claude/claude-desktop-bridge.js";
import type { EvidenceManager } from "../evidence/evidence-manager.js";
import type { FileUploadManager } from "../evidence/file-upload.js";
import type { LoadedDesktopConfig } from "../transport/config.js";
import type { ConversationStateStore } from "./conversation-state-store.js";
import type { SessionEventLog } from "./session-event-log.js";

export class BridgeRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "BridgeRequestError";
  }
}

export function stringParam(params: Record<string, unknown>, key: string, required = true): string | undefined {
  const value = params[key];
  if (typeof value === "string" && value.trim()) return value;
  if (required) throw new Error(`${key} is required`);
  return undefined;
}

export function runtimeIdParam(
  params: Record<string, unknown>,
  key: string,
  required = false,
): BridgeDesktopRuntimeId | undefined {
  if (params[key] !== undefined && (typeof params[key] !== "string" || !params[key].trim())) throw new Error("Unknown Desktop runtime");
  const value = stringParam(params, key, required);
  if (!value) return undefined;
  if (value === "claude-desktop") return value;
  throw new BridgeRequestError("UNSUPPORTED", "当前仅支持 Claude Desktop，其他 Agent 适配已停用。");
}

export function numberParam(params: Record<string, unknown>, key: string, fallback: number): number {
  const value = params[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function integerParam(params: Record<string, unknown>, key: string): number {
  const value = params[key];
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`${key} must be an integer`);
  return value;
}

export function nullableStringParam(params: Record<string, unknown>, key: string): string | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(params, key)) return undefined;
  const value = params[key];
  if (value === null) return null;
  if (typeof value === "string" && value.trim()) return value.trim();
  throw new Error(`${key} must be a non-empty string or null`);
}

export function nullableBooleanParam(params: Record<string, unknown>, key: string): boolean | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(params, key)) return undefined;
  const value = params[key];
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  throw new Error(`${key} must be a boolean or null`);
}

export function effortParam(params: Record<string, unknown>, key: string): BridgeEffort | null | undefined {
  const value = nullableStringParam(params, key);
  if (value === undefined || value === null) return value;
  if (["low", "medium", "high", "xhigh", "max"].includes(value)) return value as BridgeEffort;
  throw new Error("Invalid effort");
}

export function attachmentsParam(params: Record<string, unknown>): BridgeAttachment[] {
  if (params.attachments === undefined) return [];
  if (!Array.isArray(params.attachments)) throw new Error("attachments must be an array");
  let total = 0;
  return params.attachments.map((value) => {
    if (!value || typeof value !== "object") throw new Error("Invalid attachment");
    const attachment = value as Partial<BridgeAttachment>;
    if (
      typeof attachment.id !== "string" ||
      typeof attachment.name !== "string" ||
      typeof attachment.mimeType !== "string" ||
      !["image/jpeg", "image/png", "image/gif", "image/webp"].includes(attachment.mimeType) ||
      typeof attachment.size !== "number" ||
      typeof attachment.data !== "string"
    ) throw new Error("Invalid image attachment");
    total += attachment.size;
    if (attachment.size > 4 * 1024 * 1024 || total > 6 * 1024 * 1024) {
      throw new Error("Image attachments exceed the 6 MB limit");
    }
    return attachment as BridgeAttachment;
  });
}

export function errorResponse(requestId: string, error: unknown): BridgeResponse {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof BridgeRequestError) {
    return {
      kind: "response",
      requestId,
      ok: false,
      error: {
        code: error.code,
        message,
        retryable: error.retryable,
      },
    };
  }
  const retryable = /unavailable|busy|offline|connect|runtime/iu.test(message);
  return {
    kind: "response",
    requestId,
    ok: false,
    error: {
      code: message.toLocaleUpperCase().replace(/[^A-Z0-9]+/gu, "_").slice(0, 80) || "REQUEST_FAILED",
      message,
      retryable,
    },
  };
}

export interface ControllerRpcHost {
  readonly config: LoadedDesktopConfig | undefined;
  readonly broker: ClaudeDesktopBridge;
  readonly eventLog: SessionEventLog;
  readonly evidence: EvidenceManager;
  readonly claudeDesktop: ClaudeDesktopLifecycle;
  readonly conversationState?: ConversationStateStore;
  readonly uploads: FileUploadManager;
  readonly magpieQuota: ReturnType<typeof createMagpieQuotaPlugin>;
  snapshot(): Promise<DesktopControlSnapshot>;
  publish(): Promise<DesktopControlSnapshot>;
  launchClaudeDesktop(): Promise<DesktopControlSnapshot>;
  quitClaudeDesktop(): Promise<DesktopControlSnapshot>;
  desktopAppStatuses(force?: boolean): Promise<BridgeDesktopAppStatus[]>;
  launchDesktopApp(runtimeId: BridgeDesktopRuntimeId): Promise<DesktopControlSnapshot>;
  quitDesktopApp(runtimeId: BridgeDesktopRuntimeId): Promise<DesktopControlSnapshot>;
  desktopRuntimes(): BridgeDesktopRuntime[];
  allProjects(): DesktopControlSnapshot["projects"];
  allSessions(): BridgeSessionInfo[];
  listedSessions(projectId?: string, search?: string, runtimeId?: BridgeDesktopRuntimeId): BridgeSessionInfo[];
}

export async function dispatchControllerRequest(
  host: ControllerRpcHost,
  request: BridgeRequest,
  origin: "desktop" | "mobile",
  sourceDeviceId?: string,
): Promise<unknown> {
  const params = request.params;
  if (
    (typeof params.sessionId === "string" && /^(?:codex|hermes|dsh)-desktop:/u.test(params.sessionId)) ||
    request.method.startsWith("runtime.handoff.") || request.method.startsWith("runtime.goal.") ||
    request.method === "runtime.file.open" || request.method === "permission.policy.configure"
  ) {
    throw new BridgeRequestError("UNSUPPORTED", "当前仅支持 Claude Desktop，其他 Agent 适配已停用。");
  }
  if (request.method === "claude.desktop.status") {
    return { claudeDesktop: await host.claudeDesktop.status(true) };
  }
  if (request.method === "claude.desktop.launch") {
    return { claudeDesktop: (await host.launchClaudeDesktop()).claudeDesktop };
  }
  if (request.method === "claude.desktop.quit") {
    return { claudeDesktop: (await host.quitClaudeDesktop()).claudeDesktop };
  }
  if (request.method === "desktop.app.status") {
    return { desktopApps: await host.desktopAppStatuses(true) };
  }
  if (request.method === "desktop.app.launch") {
    const runtimeId = runtimeIdParam(params, "runtimeId");
    if (!runtimeId) throw new Error("desktop.app.launch 缺少 runtimeId");
    await host.launchDesktopApp(runtimeId);
    return { desktopApps: await host.desktopAppStatuses(true) };
  }
  if (request.method === "desktop.app.quit") {
    const runtimeId = runtimeIdParam(params, "runtimeId");
    if (!runtimeId) throw new Error("desktop.app.quit 缺少 runtimeId");
    await host.quitDesktopApp(runtimeId);
    return { desktopApps: await host.desktopAppStatuses(true) };
  }
  if (request.method === "snapshot.get") return { snapshot: await host.snapshot() };
  if (request.method === "runtime.list") return { runtimes: host.desktopRuntimes() };
  if (request.method === "runtime.refresh") {
    const runtimeId = runtimeIdParam(params, "runtimeId");
    if (!runtimeId || runtimeId === "claude-desktop") await host.broker.refreshRuntime();
    await host.publish();
    return { runtime: host.broker.runtimeStatus(), runtimes: host.desktopRuntimes() };
  }
  if (request.method === "project.list") return { projects: host.allProjects() };
  if (request.method === "directory.list") {
    if (params.path !== undefined && (typeof params.path !== "string" || !params.path.trim())) throw new Error("path must be a non-empty string");
    const path = await accessibleDirectory(typeof params.path === "string" ? params.path : homedir());
    const listing: BridgeDirectoryListing = {
      path,
      ...(dirname(path) !== path ? { parentPath: dirname(path) } : {}),
      directories: (await readdir(path, { withFileTypes: true }))
        .filter(entry => entry.isDirectory())
        .map(entry => ({ name: entry.name, path: join(path, entry.name) }))
        .sort((left, right) => left.name.localeCompare(right.name)),
      recentPaths: [...new Set([...host.allSessions(), ...host.allProjects()].map(item => item.cwd).filter(isAbsolute))],
    };
    return { listing };
  }
  if (request.method === "directory.mkdir") {
    const parent = await accessibleDirectory(stringParam(params, "parentPath")!);
    const name = stringParam(params, "name")!.trim();
    if (name === "." || name === ".." || /[\\/\0]/u.test(name) || name.length > 255) {
      throw new Error("请输入合法的单层文件夹名称");
    }
    const target = join(parent, name);
    try {
      await mkdir(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !(await lstat(target)).isDirectory()) {
        throw (error as NodeJS.ErrnoException).code === "EEXIST"
          ? new Error("已存在同名非目录项，无法创建文件夹")
          : error;
      }
    }
    return { path: await accessibleDirectory(target) };
  }
  if (
    request.method === "provider.list" || request.method === "provider.refresh" ||
    request.method === "conversation.route.get" || request.method === "conversation.switch.preview" ||
    request.method === "conversation.switch.commit" || request.method === "conversation.switch.cancel" ||
    request.method === "handoff.get"
  ) {
    throw new BridgeRequestError("UNSUPPORTED", "Claude Desktop 原生会话不支持 Bridge 独立提供方或执行通道接力。");
  }
  if (request.method === "session.list") {
    return {
      sessions: host.listedSessions(
        stringParam(params, "projectId", false),
        stringParam(params, "search", false),
        runtimeIdParam(params, "runtimeId"),
      ),
    };
  }
  if (request.method === "session.open") {
    const sessionId = stringParam(params, "sessionId")!;

    await host.broker.refreshDesktopConfiguration(sessionId);
    const session = host.broker.session(sessionId);
    if (!session) throw new Error("Session not found");
    const history = await host.broker.history(sessionId, undefined, numberParam(params, "limit", 18));
    return {
      session: host.broker.session(sessionId) ?? session,
      history,
      latestSeq: host.eventLog.latestSeq(),
    };
  }
  if (request.method === "session.rename") {
    const sessionId = stringParam(params, "sessionId")!;
    const title = stringParam(params, "title")!.trim();
    if (!host.conversationState) throw new Error("Session rename is unavailable");
    const session = host.allSessions().find((candidate) => candidate.sessionId === sessionId);
    if (!session) throw new Error("Session not found");
    if (session.title === title) return { session };
    await host.broker.rename(sessionId, title);
    const snapshot = await host.publish();
    return { session: snapshot.sessions.find((candidate) => candidate.sessionId === sessionId) };
  }
  if (request.method === "section.create") {
    if (!host.broker.capabilities().includes("section.create")) throw new BridgeRequestError("UNSUPPORTED", "当前 Claude Desktop 不支持创建 Section。");
    const name = stringParam(params, "name")!.trim();
    if (!name || name.length > 200) throw new Error("name must contain 1–200 characters");
    const project = await host.broker.createSection(name);
    await host.publish();
    return { project };
  }
  if (request.method === "section.move") {
    if (!host.broker.capabilities().includes("section.move")) throw new BridgeRequestError("UNSUPPORTED", "当前 Claude Desktop 不支持移动会话分组。");
    const sessionId = stringParam(params, "sessionId")!;
    const sectionId = nullableStringParam(params, "sectionId");
    if (sectionId === undefined) throw new Error("sectionId is required");
    const session = await host.broker.moveSessionSection(sessionId, sectionId);
    await host.publish();
    return { session, projects: host.allProjects() };
  }
  if (request.method === "section.rename") {
    if (!host.broker.capabilities().includes("section.rename")) throw new BridgeRequestError("UNSUPPORTED", "当前 Claude Desktop 不支持重命名 Section。");
    const sectionId = stringParam(params, "sectionId")!.trim();
    const name = stringParam(params, "name")!.trim();
    if (!name || name.length > 200) throw new Error("name must contain 1–200 characters");
    const project = await host.broker.renameSection(sectionId, name);
    await host.publish();
    return { project, projects: host.allProjects(), sessions: host.allSessions() };
  }
  if (request.method === "section.delete") {
    if (!host.broker.capabilities().includes("section.delete")) throw new BridgeRequestError("UNSUPPORTED", "当前 Claude Desktop 不支持删除 Section。");
    const sectionId = stringParam(params, "sectionId")!.trim();
    await host.broker.deleteSection(sectionId);
    await host.publish();
    return { projects: host.allProjects(), sessions: host.allSessions() };
  }
  if (request.method === "session.create") {
    runtimeIdParam(params, "runtimeId");
    const projectId = params.projectId;
    if (projectId !== undefined && (typeof projectId !== "string" || !projectId.trim())) {
      throw new Error("projectId must be a non-empty string");
    }
    if (params.trustWorkspace !== undefined && typeof params.trustWorkspace !== "boolean") {
      throw new Error("trustWorkspace must be a boolean");
    }
    try {
      return {
        session: await host.broker.createSession(
          stringParam(params, "cwd")!,
          stringParam(params, "title", false),
          typeof projectId === "string" ? projectId.trim() : undefined,
          ...(params.trustWorkspace === true ? [true] as const : []),
        ),
      };
    } catch (error) {
      if (error instanceof WorkspaceTrustRequiredError) {
        throw new BridgeRequestError(
          error.manual ? "WORKSPACE_TRUST_MANUAL_REQUIRED" : "WORKSPACE_TRUST_REQUIRED",
          error.message,
        );
      }
      throw error;
    }
  }
  if (request.method === "session.fork") {
    const sessionId = stringParam(params, "sessionId")!;

    return {
      session: await host.broker.forkSession(
        sessionId,
        stringParam(params, "title", false),
      ),
    };
  }
  if (request.method === "session.history") {
    const sessionId = stringParam(params, "sessionId")!;

    return {
      history: await host.broker.history(
        sessionId,
        stringParam(params, "cursor", false),
        numberParam(params, "limit", 50),
      ),
    };
  }
  if (request.method === "session.rewind.preview" || request.method === "session.rewind") {
    const sessionId = stringParam(params, "sessionId")!;
    const messageId = stringParam(params, "messageId")!;

    if (request.method === "session.rewind.preview") return { rewind: await host.broker.previewRewind(sessionId, messageId) };
    const scope = stringParam(params, "scope")!;
    if (scope !== "conversation" && scope !== "files" && scope !== "both") throw new Error("Invalid rewind scope");
    return { rewind: await host.broker.rewindSession(sessionId, messageId, scope), session: host.broker.session(sessionId) };
  }
  if (request.method === "session.commands") {
    const sessionId = stringParam(params, "sessionId")!;

    return { catalog: await host.broker.commands(sessionId) };
  }
  if (request.method === "session.command") {
    const sessionId = stringParam(params, "sessionId")!;

    return { command: await host.broker.runCommand({
      sessionId, text: stringParam(params, "text")!, requestId: request.requestId,
      idempotencyKey: request.idempotencyKey, origin,
      ...(sourceDeviceId ? { sourceDeviceId } : {}),
    }) };
  }
  if (request.method === "session.permissions" || request.method === "session.permissions.configure") {
    throw new BridgeRequestError("UNSUPPORTED", "SDK 权限策略由 Claude Desktop 原生会话管理。");
  }
  if (request.method === "session.configuration") {
    const sessionId = stringParam(params, "sessionId")!;

    const configuration = await host.broker.configuration(sessionId);
    const backgroundTasks = nullableBooleanParam(params, "includeBackgroundTasks") === true
      ? await host.broker.backgroundTaskDetails(sessionId) : undefined;
    return {
      configuration,
      session: backgroundTasks !== undefined
        ? { ...host.broker.session(sessionId)!, backgroundTasks } : host.broker.session(sessionId),
    };
  }
  if (request.method === "session.configure") {
    const sessionId = stringParam(params, "sessionId")!;

    const input: Parameters<ClaudeDesktopBridge["configureSession"]>[0] = { sessionId };
    if (Object.prototype.hasOwnProperty.call(params, "model")) {
      const model = nullableStringParam(params, "model");
      if (model !== undefined) input.model = model;
    }
    if (Object.prototype.hasOwnProperty.call(params, "effort")) {
      const effort = effortParam(params, "effort");
      if (effort !== undefined) input.effort = effort;
    }
    if (Object.prototype.hasOwnProperty.call(params, "permissionMode")) {
      const mode = stringParam(params, "permissionMode")!;
      if (!["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"].includes(mode)) {
        throw new Error("Invalid native permission mode");
      }
      input.permissionMode = mode as BridgeSDKPermissionMode;
    }
    const configuration = await host.broker.configureSession(input);
    return { configuration, session: host.broker.session(sessionId) };
  }
  if (request.method === "session.desktop.register") {
    throw new BridgeRequestError("UNSUPPORTED", "Claude 会话直接由 Claude Desktop 创建，无需 Bridge 登记。");
  }
  if (request.method === "session.archive") {
    const sessionId = stringParam(params, "sessionId")!;
    const archived = params.archived !== false;
    const all = host.allSessions();
    const session = all.find((candidate) => candidate.sessionId === sessionId);
    if (!session) throw new Error("Session not found");
    const changedAt = Date.now();
    const archivedAt = archived ? changedAt : undefined;
    // Restoring stays on the chosen session so children archived on their own stay archived.
    const targetIds = [
      sessionId,
      ...(archived ? all : [])
        .filter((candidate) => candidate.parentSessionId === sessionId && !candidate.archivedAt)
        .map((candidate) => candidate.sessionId),
    ];
    for (const targetId of targetIds) {
      await host.broker.archive(targetId, archived);
      await host.eventLog.append({
        sessionId: targetId,
        origin,
        type: "session.archived",
        data: { sessionId: targetId, archived: archivedAt !== undefined, ...(archivedAt ? { archivedAt } : {}) },
      });
    }
    return {
      session: host.allSessions().find((candidate) => candidate.sessionId === sessionId),
    };
  }
  if (request.method === "session.delete") {
    const sessionId = stringParam(params, "sessionId")!;
    const session = host.allSessions().find((candidate) => candidate.sessionId === sessionId);
    if (!session) throw new Error("Session not found");
    if (session.turnState === "running" || session.turnState === "queued" || session.turnState === "waiting") {
      throw new Error("任务仍在进行中，请先停止再删除会话");
    }
    await host.broker.deleteSession(sessionId);
    await host.eventLog.append({
      sessionId,
      origin,
      type: "session.deleted",
      data: { sessionId },
    });
    return { deleted: true, sessionId };
  }
  if (
    request.method === "session.takeover_desktop" || request.method === "session.return_to_desktop" ||
    request.method === "session.fallback.confirm"
  ) {
    throw new BridgeRequestError("UNSUPPORTED", "Claude 执行始终由 Claude Desktop 原生会话管理，不支持 Bridge 接管或回退执行。");
  }
  if (request.method === "message.delivery.resolve") {
    const action = stringParam(params, "action")!;
    if (action !== "confirm" && action !== "retry") throw new Error("Invalid uncertain delivery action");
    const turn = await host.broker.resolveUncertainDelivery(
      stringParam(params, "commandId")!,
      action,
    );
    return { commandId: turn.commandId, state: turn.state };
  }
  if (request.method === "turn.queue.steer" || request.method === "turn.queue.cancel") {
    const sessionId = stringParam(params, "sessionId")!;

    const turn = request.method === "turn.queue.cancel"
      ? await host.broker.cancelQueuedTurn(sessionId, stringParam(params, "commandId")!)
      : await host.broker.steerQueuedTurn(sessionId, stringParam(params, "commandId")!);
    return { commandId: turn.commandId, state: turn.state };
  }
  if (request.method === "turn.start" || request.method === "turn.steer") {
    const sessionId = stringParam(params, "sessionId")!;
    const text = stringParam(params, "text", false) ?? "";
    const attachments = attachmentsParam(params);
    if (params.bridgeExecutionRequested !== undefined && typeof params.bridgeExecutionRequested !== "boolean") {
      throw new Error("Invalid bridgeExecutionRequested");
    }
    if (params.bridgeExecutionRequested) {
      throw new BridgeRequestError("UNSUPPORTED", "Claude 执行始终由 Claude Desktop 原生会话管理。");
    }

    const input = {
      requestId: request.requestId,
      idempotencyKey: request.idempotencyKey,
      sessionId,
      text,
      attachments,
      origin,
      ...(sourceDeviceId ? { sourceDeviceId } : {}),
    };
    const turn = request.method === "turn.steer"
      ? await host.broker.steerTurn(input)
      : await host.broker.startTurn(input);
    return { commandId: turn.commandId, state: turn.state };
  }
  if (request.method === "turn.interrupt") {
    const sessionId = stringParam(params, "sessionId")!;
    // Stopping a goal-mode session must also pause its goal so the
    // supervisor never fights a user-initiated stop.

    return {
      interrupted: await host.broker.interruptTurn(
        sessionId,
        stringParam(params, "commandId", false),
        params.force === true,
      ),
    };
  }
  if (request.method === "subagent.stop") {
    const sessionId = stringParam(params, "sessionId")!;

    await host.broker.stopSubagent(sessionId, stringParam(params, "agentId")!);
    return { stopped: true };
  }
  if (request.method === "permission.resolve") {
    const decision = stringParam(params, "decision")!;
    if (!["allow-once", "allow-always", "deny"].includes(decision)) throw new Error("Invalid permission decision");
    const requestId = stringParam(params, "requestId")!;
    // `nativeMode: "full-access"` is the pre-`mode` spelling of bypassPermissions, still sent by older phones.
    const mode = params.nativeMode === "full-access" ? "bypassPermissions" : stringParam(params, "mode", false);
    if (
      (params.nativeMode !== undefined && params.nativeMode !== "full-access") ||
      (mode !== undefined && !["default", "acceptEdits", "bypassPermissions"].includes(mode))
    ) throw new Error("Invalid native permission mode");
    const updatedInput = params.updatedInput && typeof params.updatedInput === "object" && !Array.isArray(params.updatedInput)
      ? params.updatedInput as Record<string, unknown>
      : undefined;
    const resolver = origin === "mobile"
      ? {
          deviceId: sourceDeviceId ?? "mobile",
          name: host.config?.devices.find((device) => device.deviceId === sourceDeviceId)?.name ?? "手机 Bridge",
        }
      : {
          deviceId: host.config?.hostDeviceId ?? "desktop",
          name: host.config?.desktopName ?? "电脑端 Bridge",
        };
    const resolved = await host.broker.resolvePermission(
      requestId,
      decision as "allow-once" | "allow-always" | "deny",
      stringParam(params, "message", false),
      updatedInput,
      resolver,
      mode as BridgeNativePermissionMode | undefined,
    );
    if (!resolved) {
      throw new BridgeRequestError(
        "ALREADY_RESOLVED",
        "这项授权已由其他设备处理。",
      );
    }
    return {
      resolved: true,
    };
  }
  if (request.method === "events.resume") {
    const afterSeq = numberParam(params, "afterSeq", 0);
    const bootstrap = params.bootstrap === true && afterSeq === 0;
    if (bootstrap) {
      const latestSeq = host.eventLog.latestSeq();
      return {
        events: [],
        latestSeq,
        nextSeq: latestSeq,
        hasMore: false,
      };
    }
    const limit = numberParam(params, "limit", 250);
    const rawEvents = host.eventLog.replay(
      afterSeq,
      limit,
      stringParam(params, "sessionId", false),
    );
    const latestSeq = host.eventLog.latestSeq();
    const events: BridgeEvent[] = [];
    let scannedSeq = afterSeq;
    let bytes = 0;
    let truncatedByBytes = false;
    const maxPageBytes = 40 * 1024;
    for (const record of rawEvents) {
      const event = summarizeEvidenceEvent(record);
      if (
        event.type === "session.desktop-registration" ||
        event.type === "evidence.started" ||
        event.type === "evidence.updated"
      ) {
        scannedSeq = event.seq;
        continue;
      }
      const serializedLength = Buffer.byteLength(JSON.stringify(event), "utf8");
      if (events.length > 0 && bytes + serializedLength > maxPageBytes) {
        truncatedByBytes = true;
        break;
      }
      events.push(event);
      bytes += serializedLength;
      scannedSeq = event.seq;
    }
    const reachedEnd = !truncatedByBytes && rawEvents.length < Math.max(1, Math.min(limit, 1_000));
    const nextSeq = reachedEnd ? Math.max(scannedSeq, latestSeq) : scannedSeq;
    return {
      events,
      latestSeq,
      nextSeq,
      hasMore: nextSeq < latestSeq,
    };
  }
  if (request.method === "evidence.list") {
    const sessionId = stringParam(params, "sessionId")!;

    if (!host.broker.session(sessionId)) throw new Error("Session not found");
    return {
      evidence: host.evidence.list(
        sessionId,
        stringParam(params, "cursor", false),
        numberParam(params, "limit", 30),
      ),
    };
  }
  if (request.method === "evidence.get") {
    const evidence = host.evidence.get(stringParam(params, "evidenceId")!);
    if (!evidence) throw new Error("Evidence not found");
    return { evidence: evidenceSummary(evidence) };
  }
  if (request.method === "evidence.details") {
    const kind = stringParam(params, "kind");
    if (kind !== "tools" && kind !== "artifacts") throw new Error("Unknown evidence detail kind");
    const page = host.evidence.details(
      stringParam(params, "evidenceId")!, kind,
      stringParam(params, "cursor", false), numberParam(params, "limit", 30),
    );
    if (!page) throw new Error("Evidence not found");
    return { page };
  }
  if (request.method.startsWith("file.upload.")) {
    const owner = sourceDeviceId ?? "desktop";
    if (request.method === "file.upload.open") {
      const sessionId = stringParam(params, "sessionId")!;
      const session = host.allSessions().find((candidate) => candidate.sessionId === sessionId);
      if (!session) throw new Error("Session not found");
      if (session.allowedActions?.canSend === false) throw new Error("当前会话不允许上传文件");
      return { upload: await host.uploads.open({
        owner,
        sessionId,
        cwd: session.cwd,
        name: stringParam(params, "name")!,
        size: integerParam(params, "size"),
        sha256: stringParam(params, "sha256")!,
      }) };
    }
    const uploadId = stringParam(params, "uploadId")!;
    if (request.method === "file.upload.write") {
      return { received: host.uploads.write(uploadId, integerParam(params, "index"), stringParam(params, "data", false) ?? "", owner) };
    }
    if (request.method === "file.upload.commit") return { file: await host.uploads.commit(uploadId, owner) };
    return { cancelled: host.uploads.cancel(uploadId, owner) };
  }
  if (request.method === "artifact.preview") {
    return {
      preview: await host.evidence.preview(stringParam(params, "artifactId")!),
    };
  }
  if (request.method === "artifact.transfer.open") {
    const textPreview = params.purpose === "text-preview";
    if (params.nativeImage !== undefined) {
      if (!isBridgeNativeImageRef(params.nativeImage)) throw new Error("Invalid native image reference");
      const image = await host.broker.readNativeImage(stringParam(params, "sessionId")!, params.nativeImage);
      return { transfer: host.evidence.openBytesTransfer(image, sourceDeviceId ?? "desktop") };
    }
    const artifactId = stringParam(params, "artifactId", false);
    if (artifactId) {
      if (params.purpose === "stat") return { metadata: await host.evidence.artifactTransferMetadata(artifactId) };
      return {
        transfer: await host.evidence.openTransfer(
          artifactId,
          sourceDeviceId ?? "desktop",
          textPreview,
        ),
      };
    }
    const sessionId = stringParam(params, "sessionId")!;
    const filePath = stringParam(params, "path")!;
    const session = host.allSessions().find((candidate) => candidate.sessionId === sessionId);
    if (!session) throw new Error("Session not found");
    if (params.purpose === "stat") {
      return { metadata: await host.evidence.fileTransferMetadata(session.cwd, filePath, host.broker.executionCwd(sessionId)) };
    }
    return {
      transfer: await host.evidence.openFileTransfer(
        session.cwd,
        filePath,
        sourceDeviceId ?? "desktop",
        textPreview,
        host.broker.executionCwd(sessionId),
      ),
    };
  }
  if (request.method === "artifact.transfer.read") {
    return {
      chunk: host.evidence.readTransfer(
        stringParam(params, "transferId")!,
        integerParam(params, "index"),
        sourceDeviceId ?? "desktop",
      ),
    };
  }
  if (request.method === "artifact.transfer.close") {
    return {
      closed: host.evidence.closeTransfer(
        stringParam(params, "transferId")!,
        sourceDeviceId ?? "desktop",
      ),
    };
  }
  if (request.method === "device.revoke") {
    const deviceId = stringParam(params, "deviceId")!;
    if (origin === "mobile" && sourceDeviceId !== deviceId) throw new Error("A phone can only revoke itself");
    return { scheduled: true, deviceId };
  }
  if (request.method === MAGPIE_QUOTA_METHOD) return host.magpieQuota.handle(request);
  throw new Error("Unsupported request method");
}
