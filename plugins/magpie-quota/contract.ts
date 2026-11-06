export const MAGPIE_QUOTA_METHOD = "plugin.magpie-quota.list" as const;

export interface QuotaWindow {
  name: string;
  pool?: string;
  used?: number;
  remaining?: number;
  resetsAt?: string;
  unit?: string;
  limit?: number;
  unlimited?: boolean;
  text?: boolean;
  display?: string;
  /** A prepaid wallet's figure left, in `unit`; `used` and `remaining` are then no share. */
  balance?: number;
}

export interface QuotaAccount {
  provider: string;
  /** Remote Magpie provenance; remote cards are retained rather than refreshed locally. */
  from?: string;
  name?: string;
  user?: string;
  alias?: string;
  kind?: string;
  plan?: string;
  readAt?: string;
  lastServedAt?: string;
  balance?: string;
  error?: string;
  /** Set when Magpie shows a reading kept from this time instead of a new one. */
  asOf?: string;
  /** With `asOf`: no read was requested (reads only when asked), rather than one failing. */
  readDeferred?: boolean;
  windows: QuotaWindow[];
}

export interface QuotaSnapshot {
  status: "available" | "unsupported";
  fetchedAt: number;
  accounts: QuotaAccount[];
}

export interface QuotaModel {
  value: string;
  resolvedModel?: string;
}

export type QuotaLoader = (options?: { refresh?: boolean }) => Promise<QuotaSnapshot>;

// The allowlist is the external API boundary; token/cost estimates and credentials
// from upstream responses never become part of the phone's quota payload.
export function parseQuotaAccounts(payload: unknown): QuotaAccount[] {
  if (!payload || typeof payload !== "object" || !("data" in payload) || !Array.isArray(payload.data)) {
    throw new Error("Magpie 额度响应格式错误");
  }
  return payload.data.map((raw: unknown): QuotaAccount => {
    if (!raw || typeof raw !== "object" || !("provider" in raw) || typeof raw.provider !== "string" || !raw.provider) {
      throw new Error("Magpie 额度账号格式错误");
    }
    const source = raw as Record<string, unknown>;
    const account: QuotaAccount = { provider: raw.provider, windows: [] };
    for (const key of ["name", "user", "alias", "kind", "plan", "readAt", "lastServedAt", "balance", "error", "asOf", "from"] as const) {
      if (typeof source[key] === "string") account[key] = source[key];
    }
    if (typeof source.readDeferred === "boolean") account.readDeferred = source.readDeferred;
    if (source.windows !== undefined && !Array.isArray(source.windows)) {
      throw new Error("Magpie 额度窗口格式错误");
    }
    account.windows = ((source.windows ?? []) as unknown[]).map((entry): QuotaWindow => {
      if (!entry || typeof entry !== "object" || !("name" in entry) || typeof entry.name !== "string") {
        throw new Error("Magpie 额度窗口格式错误");
      }
      const values = entry as Record<string, unknown>;
      const window: QuotaWindow = { name: entry.name };
      for (const key of ["pool", "resetsAt", "unit", "display"] as const) {
        if (typeof values[key] === "string") window[key] = values[key];
      }
      for (const key of ["used", "remaining", "limit", "balance"] as const) {
        if (typeof values[key] === "number" && Number.isFinite(values[key])) window[key] = values[key];
      }
      for (const key of ["unlimited", "text"] as const) {
        if (typeof values[key] === "boolean") window[key] = values[key];
      }
      return window;
    });
    return account;
  });
}
