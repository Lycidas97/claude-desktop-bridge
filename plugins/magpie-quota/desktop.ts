import {
  MAGPIE_QUOTA_METHOD,
  parseQuotaAccounts,
  type QuotaSnapshot,
} from "./contract.js";

export interface QuotaGatewayConfig {
  baseUrl: string;
  authToken?: string;
  apiKey?: string;
  authScheme?: "bearer" | "x-api-key";
}

export function createMagpieQuotaPlugin({
  getGateway,
  fetchImpl = fetch,
  now = Date.now,
  cacheMs = 30_000,
  timeoutMs = 15_000,
  refreshTimeoutMs = 60_000,
}: {
  getGateway(): QuotaGatewayConfig | undefined | Promise<QuotaGatewayConfig | undefined>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  cacheMs?: number;
  timeoutMs?: number;
  refreshTimeoutMs?: number;
}) {
  let cached: { gatewayKey: string; snapshot: QuotaSnapshot } | undefined;
  return {
    id: "magpie-quota",
    async handle(request: { method: string; params?: Record<string, unknown> }): Promise<QuotaSnapshot | undefined> {
      if (request.method !== MAGPIE_QUOTA_METHOD) return undefined;
      if (request.params?.refresh !== undefined && typeof request.params.refresh !== "boolean") {
        throw new Error("refresh 必须为布尔值");
      }
      const gateway = await getGateway();
      if (!gateway) {
        cached = undefined;
        return { status: "unsupported", accounts: [], fetchedAt: now() };
      }
      const refresh = request.params?.refresh === true;
      const gatewayKey = JSON.stringify(gateway);
      if (!refresh && cached?.gatewayKey === gatewayKey && now() - cached.snapshot.fetchedAt < cacheMs) {
        return cached.snapshot;
      }
      const base = gateway.baseUrl.replace(/\/+$/u, "");
      const endpoint = `${base.endsWith("/v1") ? base : `${base}/v1`}/magpie/quotas`;
      const headers: Record<string, string> = { accept: "application/json" };
      if (gateway.authScheme === "x-api-key") {
        const key = gateway.apiKey ?? gateway.authToken;
        if (key) headers["x-api-key"] = key;
      } else {
        const token = gateway.authToken ?? gateway.apiKey;
        if (token) headers.authorization = `Bearer ${token}`;
      }
      // One deadline spans discovery, all targeted refreshes and the normalized report.
      const signal = AbortSignal.timeout(refresh ? refreshTimeoutMs : timeoutMs);
      const requestJson = async (url: string, method: "GET" | "POST" = "GET"): Promise<unknown> => {
        let response: Response;
        let payload: unknown;
        // This boundary never exposes upstream bodies, account URLs or credentials to the phone.
        try {
          response = await fetchImpl(url, { headers, signal, ...(method === "POST" ? { method } : {}) });
          if (response.ok) payload = await response.json();
        } catch (error) {
          if (error instanceof SyntaxError) throw new Error("Magpie 额度响应格式错误", { cause: error });
          const timedOut = signal.aborted || error instanceof Error && error.name === "TimeoutError";
          throw new Error(timedOut ? (refresh ? "Magpie 额度主动刷新超时" : "Magpie 额度读取超时") : "无法连接 Magpie 网关", { cause: error });
        }
        if (response.status === 404 || response.status === 405) {
          if (refresh) throw new Error("Magpie 不支持主动刷新额度，请更新 Magpie");
          return undefined;
        }
        if (!response.ok) {
          if (refresh && response.status === 403) {
            // Error bodies are optional; only this fixed code changes the user-facing message.
            const failure = await response.json().catch(() => undefined) as { error?: { code?: unknown } } | undefined;
            if (failure?.error?.code === "gateway_key_read_only") throw new Error("当前 Magpie 密钥为只读，不能主动刷新额度");
          }
          throw new Error(`Magpie 额度${refresh ? "主动刷新" : "读取"}失败（HTTP ${response.status}）`);
        }
        return payload;
      };
      const payload = await requestJson(endpoint);
      let snapshot: QuotaSnapshot;
      if (payload === undefined) {
        snapshot = { status: "unsupported", accounts: [], fetchedAt: now() };
      } else {
        let accounts = parseQuotaAccounts(payload);
        if (refresh) {
          const remote = accounts.filter((account) => account.from || account.provider.includes("/"));
          const targets = new Map(accounts.filter((account) => !account.from && !account.provider.includes("/"))
            .map((account) => [JSON.stringify([account.provider, account.user || ""]), account]));
          await Promise.all([...targets.values()].map((account) => {
            const query = new URLSearchParams({ provider: account.provider });
            if (account.user) query.set("user", account.user);
            return requestJson(`${endpoint}/refresh?${query}`, "POST");
          }));
          // Refresh returns raw cards; only the kept GET has normalized percentage/reset fields.
          accounts = [
            ...parseQuotaAccounts(await requestJson(`${endpoint}?kept=1`)),
            ...remote.map((account) => ({ ...account, readDeferred: true })),
          ];
        }
        snapshot = { status: "available", accounts, fetchedAt: now() };
      }
      cached = { gatewayKey, snapshot };
      return snapshot;
    },
  };
}
