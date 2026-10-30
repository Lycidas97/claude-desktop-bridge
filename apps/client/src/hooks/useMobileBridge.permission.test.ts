import type { BridgeRequest } from "@bridge/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMobileBridge } from "./useMobileBridge.js";

const harness = vi.hoisted(() => ({
  state: undefined as any,
  refs: [] as Array<{ current: any }>,
  requests: [] as BridgeRequest[],
  result: {} as Record<string, unknown>,
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
        pending.resolve({
          kind: "response", requestId: request.requestId, ok: true,
          result: request.method === "events.resume" ? { events: [] } : harness.result,
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
  harness.state = { snapshot: {
    host: { hostId: "computer", defaultPermissionMode: "standard" },
    sessions: [
      { sessionId: "codex-desktop:first", runtimeId: "codex-desktop" },
      { sessionId: "hermes-desktop:first", runtimeId: "hermes-desktop" },
    ],
    permissions: [],
  } };
});

describe("configureHostPermission", () => {
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
