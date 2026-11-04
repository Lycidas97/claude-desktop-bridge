import type { QuotaAccount, QuotaModel, QuotaSnapshot, QuotaWindow } from "./contract.js";

export function remainingPercent(window: QuotaWindow): number | undefined {
  if (window.unlimited) return 100;
  // Magpie sends remaining = 100 - used even where used is no reading.
  if (window.text || window.balance !== undefined) return undefined;
  const value = window.remaining ?? (window.used === undefined ? undefined : 100 - window.used);
  return value === undefined ? undefined : Math.max(0, Math.min(100, value));
}

export function formatQuotaWindow(window: QuotaWindow): string {
  if (window.unlimited) return "无限制";
  if (window.text) return window.display ?? "查看上游额度";
  if (window.balance !== undefined) return `余额 ${Number(window.balance.toFixed(2))}${window.unit ? ` ${window.unit}` : ""}`;
  const remaining = remainingPercent(window);
  return remaining === undefined ? window.display ?? "余量未知" : `剩余 ${Number(remaining.toFixed(1))}%`;
}

/** "11月2日 09:12" in the phone's time zone; built by hand because ICU builds disagree on zh month-day. */
export function formatQuotaTime(time: string | number): string {
  const date = new Date(time);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatReset(resetsAt: string, now: number): string {
  const minutes = Math.ceil((Date.parse(resetsAt) - now) / 60_000);
  if (minutes <= 0) return "已到重置时间，等待 Magpie 更新";
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days) return `${days} 天${hours ? ` ${hours} 小时` : ""}后重置`;
  if (!hours) return `${minutes} 分钟后重置`;
  return `${hours} 小时${minutes % 60 ? ` ${minutes % 60} 分钟` : ""}后重置`;
}

// Antigravity lists "Claude Opus 5.5 (High)", "(Low)" and "(Medium)" with one reading
// and one reset; they show as one row. Tiers that differ keep their own rows.
export function quotaRows(windows: QuotaWindow[]): { label: string; variants: string[]; window: QuotaWindow }[] {
  const rows: { label: string; variants: string[]; window: QuotaWindow }[] = [];
  for (const window of windows) {
    const [, label = window.name, variant] = /^(.+?)\s*\(([^)]+)\)$/u.exec(window.name) ?? [];
    const same = variant && rows.find((row) => row.variants.length && row.label === label
      && row.window.resetsAt === window.resetsAt && formatQuotaWindow(row.window) === formatQuotaWindow(window));
    if (same) same.variants.push(variant);
    else rows.push({ label, variants: variant ? [variant] : [], window });
  }
  return rows;
}

// "Gemini 3.8 Flash (High)" and "gemini-3.8-flash[1m]" both become "gemini-3-8-flash".
function modelSlug(text: string): string {
  return text.toLowerCase().replace(/\[1m\]|\([^)]*\)/gu, "").replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");
}

export function quotasForModel(snapshot: QuotaSnapshot, model: QuotaModel): {
  status: "matched" | "routing" | "unmatched";
  accounts: QuotaAccount[];
} {
  const ids = [model.resolvedModel, model.value].filter((id): id is string => Boolean(id));
  if (ids.some((id) => id.startsWith("auto/"))) return { status: "routing", accounts: [] };
  const providers = [...new Set(snapshot.accounts.map((account) => account.provider))].sort((a, b) => b.length - a.length);
  const provider = providers.find((candidate) => ids.some((id) => id.startsWith(`${candidate}/`)));
  if (!provider) return { status: "unmatched", accounts: [] };
  const qualifiedId = ids.find((id) => id.startsWith(`${provider}/`))!;
  const modelName = qualifiedId.slice(provider.length + 1).toLowerCase();
  const family = modelName.includes("gemini") ? "gemini"
    : modelName.includes("claude") ? "claude"
      : /gpt|codex/u.test(modelName) ? "gpt" : undefined;
  return {
    status: "matched",
    accounts: snapshot.accounts.filter((account) => account.provider === provider).map((account) => ({
      ...account,
      windows: account.windows.filter((window) => {
        if (window.pool) return Boolean(family && window.pool.toLowerCase().includes(family));
        // A pool's own windows carry the pool; one naming a model without it counts for that model alone.
        return !/gemini|claude|gpt/iu.test(window.name) || modelSlug(window.name) === modelSlug(modelName);
      }),
    })),
  };
}

// Percentages belong to independent account windows: take the limiting window
// per account, then the best account. Adding percentages would invent capacity.
export function modelQuotaLabel(snapshot: QuotaSnapshot, model: QuotaModel, now = Date.now()): string | undefined {
  if (snapshot.status !== "available") return undefined;
  const match = quotasForModel(snapshot, model);
  if (match.status === "routing") return "自动路由 · 查看各渠道额度";
  if (match.status === "unmatched") return undefined;
  const remaining: number[] = [];
  for (const account of match.accounts) {
    if (account.error) continue;
    // Text rows and wallet figures hold no share: they neither give one nor hide the others.
    const shares = account.windows.filter((window) => !window.text && window.balance === undefined);
    if (!shares.length) continue;
    const values = shares.map((window) => (
      window.resetsAt && Date.parse(window.resetsAt) <= now ? undefined : remainingPercent(window)
    ));
    if (values.every((value): value is number => value !== undefined)) remaining.push(Math.min(...values));
  }
  if (remaining.length) {
    return `单账号最高可用 ${Number(Math.max(...remaining).toFixed(1))}%`;
  }
  const balances = match.accounts.flatMap((account) => {
    if (account.error) return [];
    const wallet = account.windows.find((window) => window.balance !== undefined);
    return account.balance ? [`余额 ${account.balance}`] : wallet ? [formatQuotaWindow(wallet)] : [];
  });
  if (balances.length === 1) return balances[0];
  if (balances.length > 1) return `${balances.length} 个账号有余额`;
  return "额度待更新";
}
