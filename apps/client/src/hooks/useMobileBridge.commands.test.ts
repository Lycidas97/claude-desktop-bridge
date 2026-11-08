import type { BridgeRequest, BridgeSlashCommandCatalog } from "@bridge/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMobileBridge } from "./useMobileBridge.js";

const harness = vi.hoisted(() => ({
  refs: [] as Array<{ current: any }>,
  requests: [] as BridgeRequest[],
  response: {} as Record<string, unknown>,
  error: undefined as { code: string; message: string } | undefined,
  encrypt: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => [initial, vi.fn()],
  useRef(initial: unknown) {
    const index = harness.refs.length;
    const ref = { current: initial as any };
    if (index === 1) ref.current = { encrypt: harness.encrypt };
    if (index === 3) ref.current = {
      state: "connected",
      sendEnvelope: async ({ request }: { request: BridgeRequest }) => {
        harness.requests.push(request);
        const pending = harness.refs[6]!.current.get(request.requestId);
        clearTimeout(pending.timer);
        harness.refs[6]!.current.delete(request.requestId);
        pending.resolve({ kind: "response", requestId: request.requestId,
          ...(harness.error ? { ok: false, error: harness.error } : { ok: true, result: harness.response }),
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
  harness.refs = []; harness.requests = []; harness.response = {}; harness.error = undefined;
  harness.encrypt.mockReset().mockImplementation(async (request: BridgeRequest) => ({ id: request.requestId, sentAt: 1, request }));
});

describe("loadSessionCommands", () => {
  it("uses the read-only command request, waits for its catalog, and does not persist an outbox envelope", async () => {
    const catalog: BridgeSlashCommandCatalog = { sessionId: "fork-A", commands: [{ name: "review", description: "检查变更" }], warnings: ["部分目录不可读"] };
    harness.response = { catalog };
    await expect(useMobileBridge().loadSessionCommands("fork-A")).resolves.toEqual(catalog);
    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0]).toMatchObject({ method: "session.commands", params: { sessionId: "fork-A" } });
    expect(harness.encrypt.mock.calls[0]![6]).toBe(true);
  });

  it("propagates a host failure to the menu", async () => {
    harness.error = { code: "READ_FAILED", message: "无法读取命令目录" };
    await expect(useMobileBridge().loadSessionCommands("A")).rejects.toThrow("无法读取命令目录");
    expect(harness.requests.map(request => request.method)).toEqual(["session.commands"]);
  });

  it("rejects offline before encrypting or queuing a catalog request", async () => {
    const bridge = useMobileBridge();
    harness.refs[3]!.current.state = "closed";
    await expect(bridge.loadSessionCommands("A")).rejects.toThrow("电脑当前离线");
    expect(harness.encrypt).not.toHaveBeenCalled();
    expect(harness.requests).toEqual([]);
  });
});
