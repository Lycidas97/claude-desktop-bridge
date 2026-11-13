import { describe, expect, it, vi } from "vitest";
import type { BridgeMethod, BridgeRequest } from "@bridge/protocol";
import { dispatchControllerRequest, type ControllerRpcHost } from "./controller-rpc.js";

function fixture() {
  const broker = {
    promptsList: vi.fn(() => []), resolvePrompt: vi.fn(async () => true),
    readPrAutoFix: vi.fn(async () => ({ prs: [] })), setPrAutoFix: vi.fn(async () => ({ prs: [] })),
    resolvePermission: vi.fn(),
  };
  const host = { broker, config: { hostDeviceId: "computer", desktopName: "Office", devices: [{ deviceId: "phone", name: "Travel phone" }] } } as unknown as ControllerRpcHost;
  function call(method: BridgeMethod, params: Record<string, unknown>, origin: "mobile" | "desktop" = "mobile") {
    return dispatchControllerRequest(host, { kind: "request", requestId: "request", idempotencyKey: "key", method, params } satisfies BridgeRequest, origin, "phone");
  }
  return { broker, call };
}

describe("Native prompt and PR RPC boundary", () => {
  it("keeps prompts separate from tool permissions and attributes choices to the connected device", async () => {
    const f = fixture();
    await f.call("prompt.list", { sessionId: "session" });
    expect(f.broker.promptsList).toHaveBeenCalledWith("session");
    await expect(f.call("prompt.resolve", { sessionId: "session", promptId: "prompt", choice: "edit_prompt", resolvedByName: "spoofed" })).resolves.toEqual({ resolved: true });
    expect(f.broker.resolvePrompt).toHaveBeenCalledWith("session", "prompt", "edit_prompt", { deviceId: "phone", name: "Travel phone" });
    expect(f.broker.resolvePermission).not.toHaveBeenCalled();
    f.broker.resolvePrompt.mockResolvedValue(false);
    await expect(f.call("prompt.resolve", { sessionId: "session", promptId: "prompt", choice: "continue" })).rejects.toMatchObject({ code: "ALREADY_RESOLVED" });
  });

  it("forwards bound and preference updates with trusted device attribution", async () => {
    const f = fixture();
    await f.call("pr.autoFix.set", { sessionId: "session", target: "bound", repo: "owner/repo", prNumber: 42, host: "github.example", enabled: true });
    expect(f.broker.setPrAutoFix).toHaveBeenLastCalledWith({ sessionId: "session", target: "bound", repo: "owner/repo", prNumber: 42, host: "github.example", enabled: true }, { deviceId: "phone", name: "Travel phone" });
    await f.call("pr.autoFix.set", { sessionId: "session", target: "next-pr", enabled: false }, "desktop");
    expect(f.broker.setPrAutoFix).toHaveBeenLastCalledWith({ sessionId: "session", target: "next-pr", enabled: false }, { deviceId: "computer", name: "Office" });
  });

  it("validates settings and explicit check targets before calling Native", async () => {
    const f = fixture();
    for (const params of [
      { target: "bound", repo: "owner/repo", prNumber: 1.5, enabled: true },
      { target: "bound", repo: "owner/repo", prNumber: -1, enabled: true },
      { target: "own-prs", enabled: "true" },
      { target: "auto-merge", enabled: true },
    ]) await expect(f.call("pr.autoFix.set", { sessionId: "session", ...params })).rejects.toThrow();
    for (const params of [{ repo: "owner/repo" }, { prNumber: 42 }, { includeChecks: true }, { includeChecks: "true" }]) await expect(f.call("pr.autoFix.read", { sessionId: "session", ...params })).rejects.toThrow();
    expect(f.broker.setPrAutoFix).not.toHaveBeenCalled();
    expect(f.broker.readPrAutoFix).not.toHaveBeenCalled();
    await f.call("pr.autoFix.read", { sessionId: "session", repo: "owner/repo", prNumber: 42, host: "github.example", includeChecks: true });
    expect(f.broker.readPrAutoFix).toHaveBeenCalledWith("session", { repo: "owner/repo", prNumber: 42, host: "github.example", includeChecks: true });
  });
});
