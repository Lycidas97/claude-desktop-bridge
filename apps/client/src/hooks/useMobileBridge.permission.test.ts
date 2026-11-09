import type { BridgeEvent, BridgeRequest } from "@bridge/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyPermissionEvent, useMobileBridge } from "./useMobileBridge.js";

const harness = vi.hoisted(() => ({
  state: undefined as any,
  refs: [] as Array<{ current: any }>,
  requests: [] as BridgeRequest[],
  result: {} as Record<string, unknown>,
  error: undefined as { code: string; message: string } | undefined,
  beforeReply: undefined as (() => void) | undefined,
}));

vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useState(initial: any) {
    harness.state = { ...initial, snapshot: harness.state.snapshot };
    return [harness.state, (update: any) => { harness.state = typeof update === "function" ? update(harness.state) : update; }];
  },
  useRef(initial: unknown) {
    const index = harness.refs.length;
    const ref = { current: initial as any };
    if (index === 1) ref.current = { encrypt: async (request: BridgeRequest) => ({ id: request.requestId, sentAt: 1, request }) };
    if (index === 3) ref.current = {
      state: "connected",
      sendEnvelope: async ({ request }: { request: BridgeRequest }) => {
        harness.requests.push(request);
        const pending = harness.refs[6]!.current.get(request.requestId);
        clearTimeout(pending.timer);
        harness.refs[6]!.current.delete(request.requestId);
        if (request.method !== "events.resume") harness.beforeReply?.();
        pending.resolve({
          kind: "response", requestId: request.requestId,
          ...(request.method === "events.resume"
            ? { ok: true, result: { events: [] } }
            : harness.error ? { ok: false, error: harness.error } : { ok: true, result: harness.result }),
        });
      },
    };
    harness.refs.push(ref);
    return ref;
  },
  useCallback: (callback: unknown) => callback,
  useEffect: () => undefined,
}));

beforeEach(() => {
  harness.refs = [];
  harness.requests = [];
  harness.result = {};
  harness.error = undefined;
  harness.beforeReply = undefined;
  harness.state = { snapshot: {
    host: { hostId: "computer", defaultPermissionMode: "standard" },
    sessions: [
      { sessionId: "codex-desktop:first", runtimeId: "codex-desktop" },
      { sessionId: "hermes-desktop:first", runtimeId: "hermes-desktop" },
    ],
    permissions: [],
  } };
});

describe("resolvePermission", () => {
  const permission = {
    requestId: "native-request", sessionId: "codex-desktop:first", toolUseId: "tool-1", toolName: "Bash",
    input: { command: "pwd" }, createdAt: 1, canAllowAlways: false, canSetNativeFullAccess: true,
  };

  it("retains the native full access capability from permission events", () => {
    const event: BridgeEvent = {
      eventId: "native-permission", seq: 1, timestamp: 1, origin: "claude-desktop",
      type: "permission.requested", sessionId: permission.sessionId, data: permission,
    };
    expect(applyPermissionEvent([], event)).toEqual([permission]);
  });

  it("sends the explicit native mode request and waits for the response before removing the prompt", async () => {
    const bridge = useMobileBridge();
    harness.state.permissions = [permission];
    harness.state.snapshot.permissions = [permission];
    harness.result = { requestId: permission.requestId, nativePermissionModeChange: { requestId: permission.requestId, state: "requested" } };
    harness.beforeReply = () => expect(harness.state.permissions).toEqual([permission]);

    await bridge.resolvePermission(permission.requestId, "allow-once", undefined, undefined, "bypassPermissions");

    expect(harness.requests[0]).toMatchObject({ method: "permission.resolve", params: {
      requestId: permission.requestId, decision: "allow-once", mode: "bypassPermissions",
    } });
    expect(harness.requests[0]!.params).not.toHaveProperty("updatedInput");
    expect(harness.requests[0]!.params).not.toHaveProperty("message");
    expect(harness.state.permissions).toEqual([]);
    expect(harness.state.snapshot.permissions).toEqual([]);
    expect(harness.state.snapshot.host.defaultPermissionMode).toBe("standard");
    expect(harness.state.snapshot.sessions[0].nativePermissionModeChange?.state).not.toBe("confirmed");
  });

  it.each(["allow-once", "allow-always", "deny"] as const)("omits native mode for an ordinary %s response", async (decision) => {
    const bridge = useMobileBridge();
    await bridge.resolvePermission(permission.requestId, decision, "Answer", { answers: { Question: "Choice" } });
    expect(harness.requests[0]).toMatchObject({ method: "permission.resolve", params: {
      requestId: permission.requestId, decision, message: "Answer", updatedInput: { answers: { Question: "Choice" } },
    } });
    expect(harness.requests[0]!.params).not.toHaveProperty("mode");
  });

  it("keeps a pending permission when the native request fails", async () => {
    const bridge = useMobileBridge();
    harness.state.permissions = [permission];
    harness.state.snapshot.permissions = [permission];
    harness.error = { code: "INVALID_REQUEST", message: "Native mode is unavailable" };
    await expect(bridge.resolvePermission(permission.requestId, "allow-once", undefined, undefined, "bypassPermissions"))
      .rejects.toThrow("Native mode is unavailable");
    expect(harness.state.permissions).toEqual([permission]);
    expect(harness.state.snapshot.permissions).toEqual([permission]);
  });

  it("clears an already resolved native prompt and resumes events", async () => {
    const bridge = useMobileBridge();
    harness.state.permissions = [permission];
    harness.state.snapshot.permissions = [permission];
    harness.error = { code: "ALREADY_RESOLVED", message: "Already handled on Desktop" };
    await expect(bridge.resolvePermission(permission.requestId, "allow-once", undefined, undefined, "bypassPermissions"))
      .rejects.toThrow("Already handled on Desktop");
    expect(harness.state.permissions).toEqual([]);
    expect(harness.state.snapshot.permissions).toEqual([]);
    expect(harness.requests.map((request) => request.method)).toEqual(["permission.resolve", "events.resume"]);
  });
});

describe("configureHostPermission", () => {
  it("sets an explicit runtime default with no session and applies the confirmed value only to that runtime", async () => {
    harness.state.snapshot.host.capabilities = ["permission.policy.v1", "permission.runtime-defaults.v1"];
    harness.state.snapshot.sessions = [];
    harness.state.snapshot.runtimes = [{ id: "codex-desktop", defaultPermissionMode: "standard" }];
    const bridge = useMobileBridge();
    harness.result = { runtimeId: "codex-desktop", defaultPermissionMode: "full-access" };
    await expect(bridge.configureHostPermission("codex-desktop", "full-access")).resolves.toBe("full-access");
    expect(harness.requests[0]).toMatchObject({ method: "permission.policy.configure", params: { scope: "host", runtimeId: "codex-desktop", mode: "full-access" } });
    expect(harness.requests[0]!.params).not.toHaveProperty("sessionId");
    expect(harness.state.snapshot.host.defaultPermissionMode).toBe("standard");
    expect(harness.state.snapshot.runtimes[0].defaultPermissionMode).toBe("full-access");
  });
  it.each(["permission", "detection"])("does not apply a delayed %s response from computer A after switching to B", async (operation) => {
    harness.state.snapshot.host.capabilities = ["permission.runtime-defaults.v1"];
    harness.state.snapshot.runtimes = [{ id: "codex-desktop", defaultPermissionMode: "standard" }];
    const bridge = useMobileBridge();
    harness.result = operation === "permission" ? { runtimeId: "codex-desktop", defaultPermissionMode: "full-access" } : { runtime: { state: "ready", detail: "Computer A" }, providers: [{ id: "A-only" }] };
    harness.beforeReply = () => {
      harness.state = { ...harness.state, snapshot: { ...harness.state.snapshot, host: { ...harness.state.snapshot.host, hostId: "computer-B" }, runtime: { state: "ready", detail: "Computer B" }, providers: [{ id: "B-only" }] } };
      harness.refs[0]!.current = harness.state;
      harness.refs[1]!.current = { ...harness.refs[1]!.current };
    };
    await (operation === "permission" ? bridge.configureHostPermission("codex-desktop", "full-access") : bridge.redetectProviders()).catch(() => undefined);
    expect(harness.state.snapshot.host.hostId).toBe("computer-B");
    expect(harness.state.snapshot.runtimes[0].defaultPermissionMode).toBe("standard");
    expect(harness.state.snapshot.runtime.detail).toBe("Computer B");
    expect(harness.state.snapshot.providers).toEqual([{ id: "B-only" }]);
  });

  it("saves Claude host defaults without a session or configuration response", async () => {
    const bridge = useMobileBridge();
    harness.result = { defaultPermissionMode: "full-access" };
    await expect(bridge.configureHostPermission("claude-desktop", "full-access", "codex-desktop:first"))
      .resolves.toBeUndefined();
    expect(harness.requests[0]).toMatchObject({ method: "permission.policy.configure", params: { scope: "host", mode: "full-access" } });
    expect(harness.requests[0]!.params).not.toHaveProperty("sessionId");
    expect(harness.state.snapshot.host.defaultPermissionMode).toBe("full-access");
  });

  it("targets one external app and preserves Claude's snapshot default", async () => {
    const bridge = useMobileBridge();
    harness.result = { runtimeId: "codex-desktop", runtimePermissionMode: "full-access" };
    await expect(bridge.configureHostPermission("codex-desktop", "full-access", "codex-desktop:first"))
      .resolves.toBeUndefined();
    expect(harness.requests[0]).toMatchObject({
      method: "permission.policy.configure",
      params: { scope: "host", mode: "full-access", sessionId: "codex-desktop:first" },
    });
    expect(harness.state.snapshot.host.defaultPermissionMode).toBe("standard");
  });

  it("rejects missing or another app's session before sending a host request", async () => {
    const bridge = useMobileBridge();
    await expect(bridge.configureHostPermission("codex-desktop", "full-access")).rejects.toThrow("有效会话");
    await expect(bridge.configureHostPermission("codex-desktop", "full-access", "hermes-desktop:first")).rejects.toThrow("有效会话");
    expect(harness.requests).toEqual([]);
  });

  it("keeps the existing session policy method's configuration return contract", async () => {
    const bridge = useMobileBridge();
    const configuration = { sessionId: "session-1", permissionPolicy: { hostMode: "standard", source: "host", effectiveMode: "standard" } };
    harness.result = { configuration };
    await expect(bridge.configurePermissionPolicy("session-1", "session", null)).resolves.toEqual(configuration);
    expect(harness.requests[0]).toMatchObject({
      method: "permission.policy.configure", params: { sessionId: "session-1", scope: "session", mode: null },
    });
  });
});
