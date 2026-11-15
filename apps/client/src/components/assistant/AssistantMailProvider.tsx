import type { BridgeHostSnapshot, BridgeMailCache, BridgeMailDetail, BridgeMailPage, BridgeMethod, BridgeResponse } from "@bridge/protocol";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { mergeMailCards, refreshMailPages } from "../../lib/assistant-mail.js";

export type AssistantRequest = (method: BridgeMethod, params: Record<string, unknown>) => Promise<BridgeResponse | undefined>;

export function mailResult<T>(response: BridgeResponse | undefined): T {
  if (!response?.ok) throw Object.assign(new Error(response?.error?.message ?? "邮件读取失败"), { code: response?.error?.code });
  return response.result as T;
}

interface AssistantMailState {
  cache: BridgeMailCache;
  loading: boolean;
  error: string;
  online: boolean;
  loadOlder(): Promise<void>;
  refresh(): void;
  read(mailRefId: string): Promise<BridgeMailDetail>;
  request: AssistantRequest;
}
const AssistantMailContext = createContext<AssistantMailState | undefined>(undefined);
export function useAssistantMail(): AssistantMailState | undefined { return useContext(AssistantMailContext); }

/** Mount keyed by host identity so page state and pending reads never cross computers. */
export function AssistantMailProvider({ snapshot, online, request, loadCache, saveCache, children }: {
  snapshot: BridgeHostSnapshot | undefined;
  online: boolean;
  request: AssistantRequest;
  loadCache?: () => Promise<BridgeMailCache | undefined>;
  saveCache?: (cache: BridgeMailCache) => Promise<void>;
  children: ReactNode;
}) {
  const enabled = snapshot?.host.capabilities.includes("plugin.assistant-mail.v1") ?? false;
  const [cache, setCache] = useState<BridgeMailCache>({ cards: [], changeToken: "" });
  const [cacheReady, setCacheReady] = useState(!loadCache);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const cacheRef = useRef(cache);
  cacheRef.current = cache;
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  useEffect(() => {
    if (!enabled || !loadCache) return;
    let active = true;
    void loadCache().then(stored => { if (active && stored) setCache(stored); })
      .catch(reason => { if (active) setError(String(reason)); })
      .finally(() => { if (active) setCacheReady(true); });
    return () => { active = false; };
  }, [enabled, loadCache]);

  const changeToken = snapshot?.assistantMail?.changeToken ?? "";
  useEffect(() => {
    if (!enabled || !online || !cacheReady) return;
    let active = true;
    setLoading(true);
    setError("");
    void refreshMailPages(async cursor => mailResult<{ mailPage: BridgeMailPage }>(await request("plugin.assistant-mail.list", cursor ? { cursor } : {})).mailPage, cacheRef.current, changeToken)
      .then(async next => {
        if (!active) return;
        setCache(next);
        await saveCache?.(next);
      })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : "邮件同步失败"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [enabled, online, cacheReady, changeToken, refreshKey, request, saveCache]);

  async function loadOlder(): Promise<void> {
    if (!online || loading || !cache.nextCursor) return;
    setLoading(true);
    setError("");
    try {
      const { mailPage } = mailResult<{ mailPage: BridgeMailPage }>(await request("plugin.assistant-mail.list", { cursor: cache.nextCursor }));
      if (!mounted.current) return;
      const next = { cards: mergeMailCards(cacheRef.current.cards, mailPage.cards), changeToken,
        ...(mailPage.nextCursor ? { nextCursor: mailPage.nextCursor } : {}) };
      setCache(next);
      await saveCache?.(next);
    } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : "邮件读取失败"); }
    finally { if (mounted.current) setLoading(false); }
  }

  return <AssistantMailContext.Provider value={enabled ? {
    cache, loading, error, online, request, loadOlder,
    refresh: () => setRefreshKey(value => value + 1),
    read: async mailRefId => mailResult<{ mailDetail: BridgeMailDetail }>(await request("plugin.assistant-mail.read", { mailRefId })).mailDetail,
  } : undefined}>{children}</AssistantMailContext.Provider>;
}
