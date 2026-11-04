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
}: {
  getGateway(): QuotaGatewayConfig | undefined | Promise<QuotaGatewayConfig | undefined>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  cacheMs?: number;
  timeoutMs?: number;
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
      const gatewayKey = JSON.stringify(gateway);
      if (!request.params?.refresh && cached?.gatewayKey === gatewayKey && now() - cached.snapshot.fetchedAt < cacheMs) {
        return cached.snapshot;
      }
      const base = gateway.baseUrl.replace(/\/+$/u, "");
      const headers: Record<string, string> = { accept: "application/json" };
      if (gateway.authScheme === "x-api-key") {
        const key = gateway.apiKey ?? gateway.authToken;
        if (key) headers["x-api-key"] = key;
      } else {
        const token = gateway.authToken ?? gateway.apiKey;
        if (token) headers.authorization = `Bearer ${token}`;
      }
      let response: Response;
      let payload: unknown;
      // Error text reaches the phone: say what happened, never echo the body or the runtime's English.
      try {
        response = await fetchImpl(`${base.endsWith("/v1") ? base : `${base}/v1`}/magpie/quotas`, {
          headers,
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (response.ok) payload = await response.json();
      } catch (error) {
        if (error instanceof SyntaxError) throw new Error("Magpie 额度响应格式错误", { cause: error });
        const timedOut = error instanceof Error && error.name === "TimeoutError";
        throw new Error(timedOut ? "Magpie 额度读取超时" : "无法连接 Magpie 网关", { cause: error });
      }
      let snapshot: QuotaSnapshot;
      if (response.status === 404 || response.status === 405) {
        snapshot = { status: "unsupported", accounts: [], fetchedAt: now() };
      } else {
        if (!response.ok) throw new Error(`Magpie 额度读取失败（HTTP ${response.status}）`);
        snapshot = { status: "available", accounts: parseQuotaAccounts(payload), fetchedAt: now() };
      }
      cached = { gatewayKey, snapshot };
      return snapshot;
    },
  };
}
