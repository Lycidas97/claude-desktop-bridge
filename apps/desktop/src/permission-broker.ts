import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type {
  BridgeNativePermissionModeChange,
  BridgePermissionDecision,
  BridgePermissionMode,
  BridgePermissionResolution,
  BridgePermissionResolutionReason,
} from "@bridge/protocol";
import type { PermissionResult, PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";

export type PermissionDecision = BridgePermissionDecision;

export interface PendingPermission {
  requestId: string;
  sessionId: string;
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  title?: string;
  displayName?: string;
  description?: string;
  suggestions: PermissionUpdate[];
  createdAt: number;
  manualOnly?: boolean;
  canSetNativeFullAccess?: boolean;
}

export interface ExternalPermissionRequest {
  requestId: string;
  sessionId: string;
  toolUseId?: string;
  toolName: string;
  input?: Record<string, unknown>;
  suggestions?: PermissionUpdate[];
  title?: string;
  displayName?: string;
  description?: string;
  createdAt?: number;
}

interface PendingResolver {
  request: PendingPermission;
  resolve(result: PermissionResult, resolution: BridgePermissionResolution): void;
  abort(reason: BridgePermissionResolutionReason): void;
}

export class PermissionBroker extends EventEmitter {
  private readonly pending = new Map<string, PendingResolver>();
  private readonly nativeModes = new Map<string, BridgeNativePermissionModeChange>();

  nativeModeChange(sessionId: string): BridgeNativePermissionModeChange | undefined {
    return this.nativeModes.get(sessionId);
  }

  observeNativeMode(sessionId: string, requestId: string, mode: string): void {
    const change = this.nativeModes.get(sessionId);
    if (!change || change.requestId !== requestId || change.state !== "requested") return;
    this.nativeModes.set(sessionId, {
      requestId,
      state: mode === "bypassPermissions" ? "confirmed" : "not-applied",
      observedMode: mode,
    });
    this.emit("native-mode");
  }

  constructor(
    private readonly modeForSession: (sessionId: string) => BridgePermissionMode = () => "standard",
  ) {
    super();
  }

  list(sessionId?: string): PendingPermission[] {
    return [...this.pending.values()]
      .map((entry) => entry.request)
      .filter((request) => !sessionId || request.sessionId === sessionId)
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  async request(
    sessionId: string,
    toolName: string,
    input: Record<string, unknown>,
    options: {
      signal: AbortSignal;
      toolUseId: string;
      requestId?: string;
      suggestions?: PermissionUpdate[];
      title?: string;
      displayName?: string;
      description?: string;
      manualOnly?: boolean;
      canSetNativeFullAccess?: boolean;
    },
  ): Promise<PermissionResult> {
    const request: PendingPermission = {
      requestId: options.requestId ?? randomUUID(),
      sessionId,
      toolUseId: options.toolUseId,
      toolName,
      input,
      suggestions: options.suggestions ?? [],
      createdAt: Date.now(),
      ...(options.manualOnly ? { manualOnly: true } : {}),
      ...(options.canSetNativeFullAccess ? { canSetNativeFullAccess: true } : {}),
      ...(options.title ? { title: options.title } : {}),
      ...(options.displayName ? { displayName: options.displayName } : {}),
      ...(options.description ? { description: options.description } : {}),
    };
    if (this.canApproveAutomatically(request)) {
      return this.approveAutomatically(request);
    }
    return new Promise<PermissionResult>((resolve) => {
      const onAbort = () => abort("session-ended");
      const finish = (result: PermissionResult, resolution: BridgePermissionResolution) => {
        if (!this.pending.delete(request.requestId)) return;
        options.signal.removeEventListener("abort", onAbort);
        resolve(result);
        this.emit("resolved", request, result, resolution);
      };
      const abort = (reason: BridgePermissionResolutionReason) => finish({
        behavior: "deny",
        message: "Bridge session ended before this request was answered.",
        toolUseID: request.toolUseId,
      }, {
        requestId: request.requestId,
        decision: "deny",
        resolvedByDeviceId: "system",
        resolvedByName: "Bridge",
        resolvedAt: Date.now(),
        automatic: true,
        reason,
      });
      this.pending.set(request.requestId, { request, resolve: finish, abort });
      options.signal.addEventListener("abort", onAbort, { once: true });
      if (options.signal.aborted) {
        onAbort();
        return;
      }
      this.emit("requested", request);
    });
  }

  registerExternal(
    input: ExternalPermissionRequest,
    responder: (
      decision: PermissionDecision,
      updatedInput?: Record<string, unknown>,
    ) => Promise<void> | void,
  ): boolean {
    if (this.pending.has(input.requestId)) return false;
    const request: PendingPermission = {
      requestId: input.requestId,
      sessionId: input.sessionId,
      toolUseId: input.toolUseId ?? input.requestId,
      toolName: input.toolName,
      input: input.input ?? {},
      suggestions: input.suggestions ?? [],
      createdAt: input.createdAt ?? Date.now(),
      ...(input.title ? { title: input.title } : {}),
      ...(input.displayName ? { displayName: input.displayName } : {}),
      ...(input.description ? { description: input.description } : {}),
    };
    if (this.canApproveAutomatically(request)) {
      this.approveAutomatically(request);
      void Promise.resolve(responder("allow-once", request.input)).catch((error) => {
        this.emit("external-error", request, error);
      });
      return true;
    }
    const finish = (result: PermissionResult, resolution: BridgePermissionResolution) => {
      if (!this.pending.delete(request.requestId)) return;
      const updatedInput = result.behavior === "allow" ? result.updatedInput : undefined;
      void Promise.resolve(responder(resolution.decision, updatedInput)).catch((error) => {
        this.emit("external-error", request, error);
      });
      this.emit("resolved", request, result, resolution);
    };
    const abort = (reason: BridgePermissionResolutionReason) => finish({
      behavior: "deny",
      message: "Bridge session ended before this request was answered.",
      toolUseID: request.toolUseId,
    }, {
      requestId: request.requestId,
      decision: "deny",
      resolvedByDeviceId: "system",
      resolvedByName: "Bridge",
      resolvedAt: Date.now(),
      automatic: true,
      reason,
    });
    this.pending.set(request.requestId, { request, resolve: finish, abort });
    this.emit("requested", request);
    return true;
  }

  resolveRequest(
    requestId: string,
    decision: PermissionDecision,
    message = "User denied this action.",
    updatedInput?: Record<string, unknown>,
    resolver: {
      deviceId: string;
      name: string;
    } = {
      deviceId: "desktop",
      name: "电脑端 Bridge",
    },
    metadata?: {
      automatic?: boolean;
      reason?: BridgePermissionResolutionReason;
      nativeMode?: "full-access";
    },
  ): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    if (metadata?.nativeMode && (decision !== "allow-once" || !pending.request.canSetNativeFullAccess)) {
      throw new Error("此请求不支持修改原生 Desktop 会话授权");
    }
    const canAllowAlways = pending.request.suggestions.some(
      (suggestion) => suggestion.destination === "localSettings",
    );
    const effectiveDecision = decision === "allow-always" && !canAllowAlways
      ? "allow-once"
      : decision;
    const resolution: BridgePermissionResolution = {
      requestId,
      decision: effectiveDecision,
      resolvedByDeviceId: resolver.deviceId,
      resolvedByName: resolver.name,
      resolvedAt: Date.now(),
      ...(metadata?.automatic ? { automatic: true } : {}),
      ...(metadata?.reason ? { reason: metadata.reason } : {}),
    };
    if (effectiveDecision === "deny") {
      pending.resolve(
        { behavior: "deny", message, toolUseID: pending.request.toolUseId },
        resolution,
      );
      return true;
    }
    const updatedPermissions: PermissionUpdate[] = metadata?.nativeMode
      ? [{ type: "setMode", mode: "bypassPermissions", destination: "session" }]
      : effectiveDecision === "allow-always"
        ? pending.request.suggestions.filter((suggestion) => suggestion.destination === "localSettings")
        : [];
    if (metadata?.nativeMode) this.nativeModes.set(pending.request.sessionId, { requestId, state: "requested" });
    pending.resolve(
      {
        behavior: "allow",
        updatedInput: updatedInput ?? pending.request.input,
        toolUseID: pending.request.toolUseId,
        ...(updatedPermissions.length > 0 ? { updatedPermissions } : {}),
      },
      resolution,
    );
    return true;
  }

  applyPolicy(sessionId?: string): number {
    const requests = this.list(sessionId);
    let resolved = 0;
    for (const request of requests) {
      if (!this.canApproveAutomatically(request)) continue;
      if (this.resolveRequest(
        request.requestId,
        "allow-once",
        undefined,
        undefined,
        { deviceId: "policy", name: "Bridge 完全授权" },
        { automatic: true, reason: "policy-full-access" },
      )) resolved += 1;
    }
    return resolved;
  }

  cancelSession(
    sessionId: string,
    reason: BridgePermissionResolutionReason = "session-ended",
  ): void {
    for (const pending of this.pending.values()) {
      if (pending.request.sessionId === sessionId) pending.abort(reason);
    }
  }

  private canApproveAutomatically(request: PendingPermission): boolean {
    return !request.manualOnly && request.toolName !== "AskUserQuestion" && this.modeForSession(request.sessionId) === "full-access";
  }

  private approveAutomatically(request: PendingPermission): PermissionResult {
    const result: PermissionResult = {
      behavior: "allow",
      updatedInput: request.input,
      toolUseID: request.toolUseId,
    };
    const resolution: BridgePermissionResolution = {
      requestId: request.requestId,
      decision: "allow-once",
      resolvedByDeviceId: "policy",
      resolvedByName: "Bridge 完全授权",
      resolvedAt: Date.now(),
      automatic: true,
      reason: "policy-full-access",
    };
    this.emit("resolved", request, result, resolution);
    return result;
  }
}
