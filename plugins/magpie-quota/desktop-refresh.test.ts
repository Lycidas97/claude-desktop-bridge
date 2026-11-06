import { describe, expect, it, vi } from "vitest";
import { MAGPIE_QUOTA_METHOD, parseQuotaAccounts } from "./contract.js";
import { createMagpieQuotaPlugin } from "./desktop.js";

const read = { method: MAGPIE_QUOTA_METHOD };
const refresh = { ...read, params: { refresh: true } };
const old = "2026-11-01T01:00:00Z", fresh = "2026-11-06T17:00:00Z";
const account = { provider: "claude", user: "name+tag &中@example.test", readAt: old, windows: [{ name: "5 hours", remaining: 75 }] };
const gateway = { baseUrl: "https://gateway.example.test/v1/", authToken: "unit-refresh-token" };

function fixture(post?: (url: URL, init: RequestInit) => Promise<Response>) {
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (init?.method === "POST") return post ? post(url, init) : Response.json({ data: [{ provider: "claude", windows: [{ name: "raw", used: 40, resetSecs: 60 }] }] });
    return Response.json({ data: [{ ...account, ...(url.searchParams.has("kept") ? { readAt: fresh, windows: [{ name: "5 hours", remaining: 60, resetsAt: "2026-11-07T00:00:00Z" }] } : {}) }] });
  });
  return { fetchImpl, plugin: createMagpieQuotaPlugin({ getGateway: () => gateway, fetchImpl, now: () => 1_000 }) };
}

describe("manual Magpie refresh", () => {
  it("uses targeted POST before reading the normalized kept report and caches the new sample", async () => {
    const { plugin, fetchImpl } = fixture();
    const initial = await plugin.handle(read);
    expect(initial?.accounts[0]?.readAt).toBe(old);
    const result = await plugin.handle(refresh);
    expect(fetchImpl.mock.calls.map(([url, init]) => [init?.method ?? "GET", new URL(String(url)).pathname, new URL(String(url)).searchParams.get("kept")])).toEqual([
      ["GET", "/v1/magpie/quotas", null], ["GET", "/v1/magpie/quotas", null],
      ["POST", "/v1/magpie/quotas/refresh", null], ["GET", "/v1/magpie/quotas", "1"],
    ]);
    const [postUrl, postInit] = fetchImpl.mock.calls[2]!;
    expect(new URL(String(postUrl)).searchParams.get("provider")).toBe("claude");
    expect(new URL(String(postUrl)).searchParams.get("user")).toBe(account.user);
    expect(postInit?.headers).toEqual({ accept: "application/json", authorization: `Bearer ${gateway.authToken}` });
    expect(result?.accounts[0]).toMatchObject({ readAt: fresh, windows: [{ remaining: 60, resetsAt: "2026-11-07T00:00:00Z" }] });
    expect(JSON.stringify(result)).not.toContain("resetSecs");
    expect(JSON.stringify(result)).not.toContain(gateway.authToken);
    expect(await plugin.handle(read)).toBe(result);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(fetchImpl.mock.calls.slice(1).every(([, init]) => init?.signal === postInit?.signal)).toBe(true);
  });

  it("deduplicates local account targets, runs them concurrently and retains remote samples", async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const remote = [{ ...account, from: "office", provider: "claude", user: "remote-1" }, { ...account, provider: "office/codex", user: "remote-2" }];
    const local = [account, { ...account }, { provider: "codex", windows: [] }, { provider: "deepseek", user: "balance", windows: [] }];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      if (init?.method === "POST") { await pending; return Response.json({ data: [] }); }
      return Response.json({ data: new URL(String(input)).searchParams.has("kept") ? local.slice(0, 1) : [...local, ...remote] });
    });
    const plugin = createMagpieQuotaPlugin({ getGateway: () => ({ ...gateway, authScheme: "x-api-key" }), fetchImpl });
    const result = plugin.handle(refresh);
    try {
      await vi.waitFor(() => expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(3), { timeout: 300 });
      expect(fetchImpl.mock.calls).toHaveLength(4);
      const targets = fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST").map(([input, init]) => {
        expect(init?.headers).toEqual({ accept: "application/json", "x-api-key": gateway.authToken });
        const url = new URL(String(input)); return [url.searchParams.get("provider"), url.searchParams.get("user")];
      });
      expect(targets).toEqual([["claude", account.user], ["codex", null], ["deepseek", "balance"]]);
    } finally { release(); }
    expect((await result)?.accounts).toEqual([...parseQuotaAccounts({ data: local.slice(0, 1) }), ...parseQuotaAccounts({ data: remote }).map(row => ({ ...row, readDeferred: true }))]);
  });

  it("keeps upstream cooldown and failed-reading markers instead of fabricating freshness", async () => {
    const kept = { ...account, asOf: old, readDeferred: false, error: "upstream read failed" };
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ data: [kept] }));
    const plugin = createMagpieQuotaPlugin({ getGateway: () => gateway, fetchImpl });
    expect((await plugin.handle(refresh))?.accounts).toEqual(parseQuotaAccounts({ data: [kept] }));
    expect(fetchImpl.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true);
  });

  it.each([
    [403, { error: { code: "gateway_key_read_only", message: "private body" } }, "当前 Magpie 密钥为只读，不能主动刷新额度"],
    [403, "private body", "Magpie 额度主动刷新失败（HTTP 403）"],
    [404, "private body", "Magpie 不支持主动刷新额度，请更新 Magpie"],
    [405, "private body", "Magpie 不支持主动刷新额度，请更新 Magpie"],
    [500, "private body", "Magpie 额度主动刷新失败（HTTP 500）"],
  ] as const)("fails honestly for POST HTTP %s and preserves the previous cache", async (status, body, message) => {
    const { plugin, fetchImpl } = fixture(async () => typeof body === "string" ? new Response(body, { status }) : Response.json(body, { status }));
    const previous = await plugin.handle(read);
    await expect(plugin.handle(refresh)).rejects.toThrow(message);
    expect(await plugin.handle(read)).toBe(previous);
    expect(fetchImpl.mock.calls.some(([url]) => new URL(String(url)).searchParams.has("kept"))).toBe(false);
  });

  it.each(["network", "post-json", "report-json"])("reports %s failure without fallback or sensitive body", async mode => {
    const { fetchImpl, plugin } = fixture(async () => {
      if (mode === "network") throw new TypeError("private gateway URL and bearer");
      return mode === "post-json" ? new Response("private invalid JSON") : Response.json({ data: [] });
    });
    if (mode === "report-json") fetchImpl.mockImplementation(async (input, init) => {
      if (init?.method === "POST") return Response.json({ data: [] });
      return new URL(String(input)).searchParams.has("kept") ? Response.json({ data: "invalid" }) : Response.json({ data: [account] });
    });
    await expect(plugin.handle(refresh)).rejects.toThrow(mode === "network" ? "无法连接 Magpie 网关" : "Magpie 额度响应格式错误");
  });

  it("uses one overall manual deadline across discovery, concurrent refresh and the final read", async () => {
    const signals: AbortSignal[] = [];
    let calls = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      signals.push(init!.signal! as AbortSignal);
      if (++calls === 1) { await new Promise(resolve => setTimeout(resolve, 30)); return Response.json({ data: [account] }); }
      return new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true }));
    });
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const plugin = createMagpieQuotaPlugin({ getGateway: () => gateway, fetchImpl, refreshTimeoutMs: 50 });
    try {
      await expect(plugin.handle(refresh)).rejects.toThrow("Magpie 额度主动刷新超时");
      expect(calls).toBe(2);
      expect(signals[1]).toBe(signals[0]);
      expect(timeout).toHaveBeenCalledExactlyOnceWith(50);
    } finally { timeout.mockRestore(); }
  });

  it("keeps ordinary and manual timeout budgets separate", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const { plugin } = fixture();
    try {
      await plugin.handle(read);
      await plugin.handle(refresh);
      expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([15_000, 60_000]);
    } finally { timeout.mockRestore(); }
  });

  it("allowlists remote provenance without exposing private fields", () => {
    expect(parseQuotaAccounts({ data: [{ provider: "claude", from: "office", token: "private", authToken: "private", windows: [] }] })).toEqual([{ provider: "claude", from: "office", windows: [] }]);
    expect(parseQuotaAccounts({ data: [{ provider: "claude", from: 42, windows: [] }] })).toEqual([{ provider: "claude", windows: [] }]);
  });
});
