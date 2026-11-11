import type { BridgeRequest } from "@bridge/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopController } from "./controller.js";
import type { ClaudeDesktopBridge } from "../claude/claude-desktop-bridge.js";

const request: BridgeRequest = {
  kind: "request", requestId: "quota", idempotencyKey: "quota", method: "plugin.magpie-quota.list", params: {},
};

function controller(gatewayConfig: ClaudeDesktopBridge["gatewayConfig"]) {
  const args = Array.from({ length: 8 }, () => ({}));
  args[4] = { gatewayConfig };
  return new (DesktopController as unknown as new (...values: unknown[]) => DesktopController)(...args) as unknown as {
    handleRequest(request: BridgeRequest, origin: "mobile"): Promise<unknown>;
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("Magpie quota plugin in the desktop controller", () => {
  it("reads quota through the gateway the broker's runtime uses", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ data: [{ provider: "claude", windows: [{ name: "5 hours", remaining: 40 }] }] }));
    vi.stubGlobal("fetch", fetchImpl);
    const gatewayConfig = vi.fn(async () => ({ baseUrl: "http://127.0.0.1:3425", authToken: "runtime-key", authScheme: "bearer" as const }));
    const result = await controller(gatewayConfig).handleRequest(request, "mobile");
    expect(result).toMatchObject({ status: "available", accounts: [{ provider: "claude", windows: [{ remaining: 40 }] }] });
    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:3425/v1/magpie/quotas", expect.objectContaining({
      headers: { accept: "application/json", authorization: "Bearer runtime-key" },
    }));
  });

  it("reports unsupported without a gateway and rejects a malformed refresh", async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);
    const host = controller(vi.fn(async () => undefined));
    expect(await host.handleRequest(request, "mobile")).toMatchObject({ status: "unsupported", accounts: [] });
    await expect(host.handleRequest({ ...request, params: { refresh: 1 } }, "mobile")).rejects.toThrow("refresh 必须为布尔值");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
