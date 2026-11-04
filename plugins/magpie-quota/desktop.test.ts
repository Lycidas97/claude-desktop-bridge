import { describe, expect, it, vi } from "vitest";
import { MAGPIE_QUOTA_METHOD, parseQuotaAccounts } from "./contract.js";
import { createMagpieQuotaPlugin } from "./desktop.js";

const raw = {
  data: [{
    provider: "claude",
    user: "person@example.test",
    plan: "pro",
    readAt: "2026-10-31T17:00:00Z",
    token: "upstream-secret",
    windows: [{ name: "5 hours", used: 25, remaining: 75, holds: { cost: 10 } }],
  }],
};
const request = { method: MAGPIE_QUOTA_METHOD };

function setup(baseUrl = "http://127.0.0.1:3425") {
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(raw));
  const getGateway = vi.fn(() => ({ baseUrl, authToken: "local-key" }));
  const now = vi.fn(() => 1_000);
  return { fetchImpl, getGateway, now, plugin: createMagpieQuotaPlugin({ getGateway, fetchImpl, now }) };
}

describe("standalone Magpie quota desktop plugin", () => {
  it.each(["http://127.0.0.1:3425", "http://127.0.0.1:3425/v1", "http://127.0.0.1:3425/v1/"])("uses the existing gateway at %s", async (base) => {
    const { plugin, fetchImpl } = setup(base);
    const result = await plugin.handle(request);
    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:3425/v1/magpie/quotas", expect.objectContaining({
      headers: { accept: "application/json", authorization: "Bearer local-key" },
      signal: expect.any(AbortSignal),
    }));
    expect(result).toEqual({
      status: "available", fetchedAt: 1_000,
      accounts: [{ provider: "claude", user: "person@example.test", plan: "pro", readAt: "2026-10-31T17:00:00Z",
        windows: [{ name: "5 hours", used: 25, remaining: 75 }] }],
    });
    expect(JSON.stringify(result)).not.toMatch(/local-key|upstream-secret|holds/);
  });

  it("supports x-api-key gateway authentication", async () => {
    const { fetchImpl } = setup();
    const plugin = createMagpieQuotaPlugin({
      getGateway: () => ({ baseUrl: "https://gateway.example.test", apiKey: "api-key", authScheme: "x-api-key" }),
      fetchImpl,
    });
    await plugin.handle(request);
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toEqual({ accept: "application/json", "x-api-key": "api-key" });
  });

  it("caches for 30 seconds, allows refresh and follows gateway changes", async () => {
    const { plugin, fetchImpl, getGateway, now } = setup();
    const first = await plugin.handle(request);
    now.mockReturnValue(30_999);
    expect(await plugin.handle(request)).toBe(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now.mockReturnValue(31_000);
    await plugin.handle(request);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await plugin.handle({ ...request, params: { refresh: true } });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    getGateway.mockReturnValue({ baseUrl: "https://other.example.test", authToken: "different-key" });
    await plugin.handle(request);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(fetchImpl.mock.calls[3]?.[0]).toBe("https://other.example.test/v1/magpie/quotas");
  });

  it("does not handle unrelated requests or fetch without a gateway", async () => {
    const { fetchImpl, getGateway } = setup();
    const plugin = createMagpieQuotaPlugin({ getGateway: () => undefined, fetchImpl });
    expect(await plugin.handle({ method: "session.configure" })).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(getGateway).not.toHaveBeenCalled();
    expect(await plugin.handle(request)).toMatchObject({ status: "unsupported", accounts: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([404, 405])("reports unsupported when a gateway lacks the API (%s)", async (status) => {
    const { plugin, fetchImpl } = setup();
    fetchImpl.mockResolvedValue(new Response("not supported", { status }));
    expect(await plugin.handle(request)).toMatchObject({ status: "unsupported", accounts: [] });
  });

  it.each([401, 403, 500])("surfaces HTTP %s without leaking the response body", async (status) => {
    const { plugin, fetchImpl } = setup();
    fetchImpl.mockResolvedValue(new Response("secret-error-detail", { status }));
    await expect(plugin.handle(request)).rejects.toThrow(`Magpie 额度读取失败（HTTP ${status}）`);
  });

  it("reports connection failures in the phone's language and retries rather than caching failure", async () => {
    const { plugin, fetchImpl } = setup();
    fetchImpl.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(plugin.handle(request)).rejects.toThrow("无法连接 Magpie 网关");
    expect(await plugin.handle(request)).toMatchObject({ status: "available" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("times out a gateway that never answers", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    }));
    const plugin = createMagpieQuotaPlugin({ getGateway: () => ({ baseUrl: "http://127.0.0.1:1" }), fetchImpl, timeoutMs: 20 });
    await expect(plugin.handle(request)).rejects.toThrow("Magpie 额度读取超时");
  });

  it("rejects a non-JSON success body without echoing it", async () => {
    const { plugin, fetchImpl } = setup();
    fetchImpl.mockResolvedValue(new Response("<html>secret proxy page</html>", { status: 200 }));
    const error = await plugin.handle(request).catch((reason: Error) => reason);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Magpie 额度响应格式错误");
  });

  it("keeps kept-reading markers and wallet balances, drops cost estimates", () => {
    expect(parseQuotaAccounts({ data: [{
      provider: "claude", asOf: "2026-11-01T04:00:00Z", readDeferred: true, readAt: "2026-11-01T04:00:00Z",
      windows: [{ name: "Points", used: 0, remaining: 100, balance: 12.5, unit: "points", holdsWhy: "low", holds: {} }],
    }] })).toEqual([{
      provider: "claude", asOf: "2026-11-01T04:00:00Z", readDeferred: true, readAt: "2026-11-01T04:00:00Z",
      windows: [{ name: "Points", used: 0, remaining: 100, balance: 12.5, unit: "points" }],
    }]);
    expect(parseQuotaAccounts({ data: [{ provider: "claude", readDeferred: "yes", windows: [{ name: "w", balance: Number.NaN }] }] }))
      .toEqual([{ provider: "claude", windows: [{ name: "w" }] }]);
  });

  it("validates refresh and the upstream response at its boundary", async () => {
    const { plugin, fetchImpl } = setup();
    await expect(plugin.handle({ ...request, params: { refresh: "yes" } })).rejects.toThrow("refresh 必须为布尔值");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(() => parseQuotaAccounts({ data: "invalid" })).toThrow("响应格式错误");
    expect(() => parseQuotaAccounts({ data: [{}] })).toThrow("账号格式错误");
    expect(() => parseQuotaAccounts({ data: [{ provider: "claude", windows: {} }] })).toThrow("窗口格式错误");
    expect(() => parseQuotaAccounts({ data: [{ provider: "claude", windows: [{}] }] })).toThrow("窗口格式错误");
  });

  it("preserves balance, pool and textual windows without unlisted fields", () => {
    expect(parseQuotaAccounts({ data: [{
      provider: "antigravity", balance: "$12.00", error: "upstream unavailable",
      windows: [{ name: "Gemini", pool: "Gemini", text: true, display: "100 requests", secret: true }],
    }] })).toEqual([{
      provider: "antigravity", balance: "$12.00", error: "upstream unavailable",
      windows: [{ name: "Gemini", pool: "Gemini", text: true, display: "100 requests" }],
    }]);
  });
});
