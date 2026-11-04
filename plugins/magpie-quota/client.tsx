import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { QuotaAccount, QuotaLoader, QuotaModel, QuotaSnapshot } from "./contract.js";
import {
  formatQuotaTime, formatQuotaWindow, formatReset, modelQuotaLabel, quotaRows, quotasForModel, remainingPercent,
} from "./presentation.js";
import "./styles.css";

interface QuotaState {
  snapshot: QuotaSnapshot | undefined;
  loading: boolean;
  error: string | undefined;
  /** False while the computer is offline or does not provide the plugin. */
  enabled: boolean;
  refresh(): void;
}

const QuotaContext = createContext<(QuotaState & { request(): () => void }) | undefined>(undefined);

// One provider spans a host's whole UI so host details and the model picker share
// one snapshot. It reads only while something showing quota is mounted, so
// connecting or reconnecting with nothing on screen adds no request.
export function MagpieQuotaProvider({ loader, enabled = true, children }: {
  loader: QuotaLoader;
  enabled?: boolean;
  children: ReactNode;
}) {
  const [snapshot, setSnapshot] = useState<QuotaSnapshot>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [consumers, setConsumers] = useState(0);
  const [refreshCount, setRefreshCount] = useState(0);
  // Only the read answering a manual refresh bypasses the desktop cache.
  const delivered = useRef(0);
  const request = useCallback(() => {
    setConsumers((count) => count + 1);
    return () => setConsumers((count) => count - 1);
  }, []);
  // Loading set here commits with the tap itself, disabling the button before a double tap's
  // second click; set only in the effect, the second click still landed and read again.
  const refresh = useCallback(() => {
    setLoading(true);
    setRefreshCount((count) => count + 1);
  }, []);
  const wanted = consumers > 0;
  useEffect(() => {
    if (!enabled || !wanted) return;
    let active = true;
    setLoading(true);
    setError(undefined);
    void loader({ refresh: refreshCount > delivered.current })
      .then((next) => {
        if (!active) return;
        delivered.current = refreshCount;
        setSnapshot(next);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : "额度读取失败");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    // Going offline abandons the request; reconnecting reads again.
    return () => {
      active = false;
      setLoading(false);
    };
  }, [enabled, wanted, loader, refreshCount]);
  return (
    <QuotaContext.Provider value={{ snapshot, loading, error, enabled, refresh, request }}>
      {children}
    </QuotaContext.Provider>
  );
}

/**
 * For host components shared with screens that have no provider: undefined there.
 * While mounted and `active`, it keeps the provider reading.
 */
export function useOptionalMagpieQuota(active = true): QuotaState | undefined {
  const state = useContext(QuotaContext);
  const request = active ? state?.request : undefined;
  useEffect(() => request?.(), [request]);
  return state;
}

export function useMagpieQuota(): QuotaState {
  const state = useOptionalMagpieQuota();
  if (!state) throw new Error("Magpie 额度组件需要 MagpieQuotaProvider");
  return state;
}

function QuotaAccounts({ accounts, now }: { accounts: QuotaAccount[]; now: number }) {
  return <div className="magpie-quota-accounts">{accounts.map((account, index) => (
    // Remote magpies can repeat a provider and user; the list is replaced whole on each read.
    <article className="magpie-quota-account" key={`${account.provider}:${index}`}>
      <header>
        <strong>{account.user || account.alias || account.name || account.provider}</strong>
        <span>{[account.name, account.plan].filter(Boolean).join(" · ")}</span>
      </header>
      {(account.asOf || account.readDeferred) && (
        <p className="magpie-quota-kept">
          {account.readDeferred ? "Magpie 本次未重新读取" : "本次读取失败"}，显示{account.asOf ? ` ${formatQuotaTime(account.asOf)} ` : ""}保留的读数
        </p>
      )}
      {account.error && <p role="alert">读取异常：{account.error}</p>}
      <ul>
        {quotaRows(account.windows).map(({ label, variants, window }, rowIndex) => {
          const remaining = remainingPercent(window);
          const level = window.resetsAt && Date.parse(window.resetsAt) <= now ? "stale"
            : remaining === undefined ? undefined : remaining <= 0 ? "empty" : remaining < 20 ? "low" : "ok";
          return (
            <li key={rowIndex} data-level={level}>
              <div>
                <span>{label}{variants.length ? ` · ${variants.join(" / ")}` : ""}{window.pool && !label.includes(window.pool) ? ` · ${window.pool}` : ""}</span>
                <strong>{formatQuotaWindow(window)}</strong>
              </div>
              {remaining !== undefined && <span className="magpie-quota-bar" aria-hidden="true"><span style={{ width: `${remaining}%` }} /></span>}
              {window.resetsAt && (
                <small>{formatReset(window.resetsAt, now)} · <time dateTime={window.resetsAt}>{formatQuotaTime(window.resetsAt)}</time></small>
              )}
              {window.display && !window.text && <small>{window.display}</small>}
            </li>
          );
        })}
        {account.balance && <li><div><span>余额</span><strong>{account.balance}</strong></div></li>}
      </ul>
      {!account.windows.length && !account.balance && !account.error && <p>暂无额度数据</p>}
      {account.readAt && <small>上游采样：<time dateTime={account.readAt}>{formatQuotaTime(account.readAt)}</time></small>}
    </article>
  ))}</div>;
}

/** The dashboard's content; the host supplies the page and its header. */
export function MagpieQuotaBoard({ snapshot, loading, error, enabled, refresh }: QuotaState) {
  const now = Date.now();
  const available = snapshot?.status === "available" ? snapshot : undefined;
  const providers = [...new Set(available?.accounts.map((account) => account.provider))];
  const kept = available?.accounts.filter((account) => account.asOf || account.readDeferred).length;
  return (
    <div className="magpie-quota-board" aria-busy={loading}>
      <div className="magpie-quota-head">
        <section className="magpie-quota-status" aria-label="读取状态">
          <div>
            <strong>
              {available ? `读取于 ${formatQuotaTime(available.fetchedAt)}`
                : snapshot ? "Magpie 没有提供额度接口"
                  : error || !enabled ? "尚未读取" : "正在读取额度…"}
            </strong>
            {available && <small>{available.accounts.length} 个账号{kept ? ` · ${kept} 个为保留读数` : ""}</small>}
          </div>
          <button type="button" onClick={refresh} disabled={loading || !enabled}>{loading ? "读取中…" : "刷新"}</button>
        </section>
        {error && <p className="magpie-quota-note" role="alert">{error}{available ? "；以下为上次读取结果" : ""}</p>}
        {!enabled && <p className="magpie-quota-note">{available ? "电脑未连接，以下为上次读取结果" : "电脑连接后读取额度"}</p>}
        {available && !providers.length && <p className="magpie-quota-note">暂无额度账号</p>}
      </div>
      {providers.length > 1 && (
        <nav className="magpie-quota-jump" aria-label="跳到渠道">
          {providers.map((provider, index) => (
            <button
              type="button"
              key={provider}
              onClick={() => document.getElementById(`magpie-quota-provider-${index}`)?.scrollIntoView({ behavior: "smooth", block: "start" })}
            >
              {provider}<span>{available!.accounts.filter((account) => account.provider === provider).length}</span>
            </button>
          ))}
        </nav>
      )}
      {available && providers.map((provider, index) => {
        const accounts = available.accounts.filter((account) => account.provider === provider);
        return (
          <section className="magpie-quota-provider" id={`magpie-quota-provider-${index}`} key={provider} aria-label={provider}>
            <h2>{provider}<span>{accounts.length} 个账号</span></h2>
            <QuotaAccounts accounts={accounts} now={now} />
          </section>
        );
      })}
    </div>
  );
}

export function MagpieQuotaDashboard() {
  return <MagpieQuotaBoard {...useMagpieQuota()} />;
}

export function MagpieModelQuota({ model }: { model: QuotaModel }) {
  const { snapshot, loading, error, enabled } = useMagpieQuota();
  if (!snapshot || snapshot.status !== "available") return null;
  const match = quotasForModel(snapshot, model);
  if (match.status === "unmatched") return null;
  return <details className="magpie-quota-model">
    <summary>{modelQuotaLabel(snapshot, model)}{loading ? " · 刷新中" : error || !enabled ? " · 上次数据" : ""}</summary>
    {match.status === "routing"
      ? <p>自动路由会选择多个渠道，请在“设置 → Magpie 额度”查看各渠道账号。</p>
      : <QuotaAccounts accounts={match.accounts} now={Date.now()} />}
  </details>;
}
