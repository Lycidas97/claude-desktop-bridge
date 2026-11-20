import { ASSISTANT_ATTENTION_CAPABILITY, type AssistantAttentionAcknowledgment, type AssistantAttentionItem, type BridgeAssistantMailSnapshot, type BridgeHostSnapshot, type BridgeMailCache, type BridgeMailCard, type BridgeMailDetail, type BridgeMailPage, type BridgeMethod, type BridgeResponse } from "@bridge/protocol";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { mergeMailCards, refreshMailPages } from "../../lib/assistant-mail.js";

export type AssistantRequest = (method: BridgeMethod, params: Record<string, unknown>) => Promise<BridgeResponse | undefined>;

export function mailResult<T>(response: BridgeResponse | undefined): T {
  if (!response?.ok) throw Object.assign(new Error(response?.error?.message ?? "邮件读取失败"), { code: response?.error?.code });
  return response.result as T;
}

interface AssistantMailState {
  cache: BridgeMailCache;
  unreadCount: number;
  attention: AssistantAttentionItem[] | undefined;
  acknowledge(kind: AssistantAttentionAcknowledgment, id: string): Promise<void>;
  accountLabel(accountKey: string): string;
  assistant: BridgeAssistantMailSnapshot | undefined;
  selectedMail: BridgeMailCard | undefined;
  canReference: boolean;
  supportsAttachments: boolean;
  supportsBatches: boolean;
  markViewed(card: BridgeMailCard): void;
  selectMail(card: BridgeMailCard): void;
  clearReference(): void;
  referenceFor(sessionId: string): string | undefined;
  loading: boolean;
  hasOlderMail: boolean;
  error: string;
  online: boolean;
  loadOlder(): Promise<void>;
  reload(): void;
  refresh(): void;
  refreshStatus: "refreshing" | "refreshed" | undefined;
  read(mailRefId: string): Promise<BridgeMailDetail>;
  request: AssistantRequest;
}
const AssistantMailContext = createContext<AssistantMailState | undefined>(undefined);
export function useAssistantMail(): AssistantMailState | undefined { return useContext(AssistantMailContext); }

export function viewedMailStorageKey(hostId: string): string { return `bridge-viewed-mail:${hostId}`; }

/** Mount keyed by host identity so page state and pending reads never cross computers. */
export function AssistantMailProvider({ hostId, snapshot, online, request, loadCache, saveCache, onDiscuss, children }: {
  hostId: string | undefined;
  snapshot: BridgeHostSnapshot | undefined;
  online: boolean;
  request: AssistantRequest;
  loadCache?: () => Promise<BridgeMailCache | undefined>;
  saveCache?: (cache: BridgeMailCache) => Promise<void>;
  onDiscuss?(): void;
  children: ReactNode;
}) {
  const [cache, setCache] = useState<BridgeMailCache>({ cards: [], changeToken: "" });
  const [cacheReady, setCacheReady] = useState(!loadCache);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [refreshStatus, setRefreshStatus] = useState<AssistantMailState["refreshStatus"]>();
  const reload = () => setRefreshKey(value => value + 1);
  useEffect(() => {
    if (refreshStatus !== "refreshed") return;
    const timer = setTimeout(() => setRefreshStatus(undefined), 2_400);
    return () => clearTimeout(timer);
  }, [refreshStatus]);
  const [selection, setSelection] = useState<{ sessionId: string; card: BridgeMailCard }>();
  const storageKey = hostId ? viewedMailStorageKey(hostId) : undefined;
  const [readState, setReadState] = useState<{ baselineSeq: number; viewed: Set<string> } | undefined>(() => {
    const saved = storageKey && typeof window !== "undefined" ? window.localStorage.getItem(storageKey) : null;
    if (!saved) return undefined;
    const [baselineSeq, ...viewed] = saved.split("\n");
    return { baselineSeq: Number(baselineSeq), viewed: new Set(viewed) };
  });
  useEffect(() => {
    if (storageKey && readState) window.localStorage.setItem(storageKey, [readState.baselineSeq, ...readState.viewed].join("\n"));
  }, [storageKey, readState]);

  function initializeUnreadBaseline(baselineSeq: number): void {
    setReadState(current => current ?? { baselineSeq: Math.max(0, baselineSeq), viewed: new Set() });
  }

  async function acknowledge(kind: AssistantAttentionAcknowledgment, id: string): Promise<void> {
    mailResult(await request("plugin.assistant-mail.attention.ack", { kind, id }));
  }

  function markViewed({ seq, mailRefId }: BridgeMailCard): void {
    if (capabilities.includes(ASSISTANT_ATTENTION_CAPABILITY)) {
      if (online) void acknowledge("mail", mailRefId).catch(reason => setError(reason instanceof Error ? reason.message : "无法记录已看"));
      return;
    }
    setReadState(current => !current || seq <= current.baselineSeq || current.viewed.has(mailRefId)
      ? current : { ...current, viewed: new Set(current.viewed).add(mailRefId) });
  }

  const enabled = snapshot ? snapshot.host.capabilities.includes("plugin.assistant-mail.v1")
    : cache.workspace ? cache.workspace.capabilities.includes("plugin.assistant-mail.v1") : cache.cards.length > 0;
  const assistant = snapshot ? snapshot.assistantMail : cache.workspace?.assistantMail;
  const capabilities = snapshot?.host.capabilities ?? cache.workspace?.capabilities ?? [];
  const canReference = capabilities.includes("plugin.assistant-mail.manual-reference.v1") && Boolean(assistant?.binding?.nativeSessionId);
  const cacheRef = useRef(cache);
  cacheRef.current = cache;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!loadCache) return;
    let active = true;
    void loadCache().then(stored => {
      if (!active || !stored) return;
      // An empty cache can have been saved before the first successful sync.
      if (stored.cards[0]) initializeUnreadBaseline(stored.cards[0].seq);
      setCache(stored);
    })
      .catch(reason => { if (active) setError(String(reason)); })
      .finally(() => { if (active) setCacheReady(true); });
    return () => { active = false; };
  }, [loadCache]);

  useEffect(() => {
    if (!snapshot || !cacheReady) return;
    const workspace: NonNullable<BridgeMailCache["workspace"]> = {
      capabilities: snapshot.host.capabilities.filter(value => value.startsWith("plugin.assistant-mail.")),
      ...(snapshot.assistantMail ? { assistantMail: snapshot.assistantMail } : {}),
    };
    if (JSON.stringify(workspace) === JSON.stringify(cacheRef.current.workspace)) return;
    cacheRef.current = { ...cacheRef.current, workspace };
    setCache(cacheRef.current);
  }, [snapshot?.host.capabilities, snapshot?.assistantMail, cacheReady]);

  useEffect(() => {
    if (!cacheReady || !saveCache) return;
    void saveCache(cacheRef.current).catch(reason => setError(reason instanceof Error ? reason.message : "邮件缓存保存失败"));
  }, [cache, cacheReady, saveCache]);

  useEffect(() => { setSelection(undefined); }, [assistant?.binding?.nativeSessionId]);
  const changeToken = assistant?.changeToken ?? "";
  const supportsHistory = capabilities.includes("plugin.assistant-mail.history.v1");
  const loadPage = useCallback(async (cursor?: string) => mailResult<{ mailPage: BridgeMailPage }>(await request(
    "plugin.assistant-mail.list", { ...(cursor ? { cursor } : {}), ...(supportsHistory ? { includeHistory: true } : {}) },
  )).mailPage, [request, supportsHistory]);
  useEffect(() => {
    if (!online) {
      setLoading(false);
      setRefreshStatus(undefined);
      return;
    }
    if (!enabled || !cacheReady) return;
    let active = true;
    setLoading(true);
    setError("");
    void refreshMailPages(loadPage, cacheRef.current, changeToken)
      .then(next => {
        if (!active) return;
        initializeUnreadBaseline(next.cards[0]?.seq ?? 0);
        setCache(next);
        setRefreshStatus(status => status === "refreshing" ? "refreshed" : undefined);
      })
      .catch(reason => {
        if (!active) return;
        setError(reason instanceof Error ? reason.message : "邮件读取失败");
        setRefreshStatus(undefined);
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [enabled, online, cacheReady, changeToken, refreshKey, loadPage]);

  const canFetchHistory = supportsHistory && assistant?.history?.available === true;
  const historyLoading = online && assistant?.history?.loading === true;
  const hasOlderMail = Boolean(cache.nextCursor || canFetchHistory);
  async function loadOlder(): Promise<void> {
    if (!online || loading || historyLoading || !hasOlderMail) return;
    setLoading(true);
    setError("");
    try {
      if (!cache.nextCursor) {
        mailResult(await request("plugin.assistant-mail.history", {}));
        return;
      }
      const mailPage = await loadPage(cache.nextCursor);
      if (!mounted.current) return;
      setCache({ cards: mergeMailCards(cacheRef.current.cards, mailPage.cards), changeToken,
        ...(cacheRef.current.workspace ? { workspace: cacheRef.current.workspace } : {}),
        ...(mailPage.nextCursor ? { nextCursor: mailPage.nextCursor } : {}) });
    } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : "邮件读取失败"); }
    finally { if (mounted.current) setLoading(false); }
  }

  const unreadCount = readState ? cache.cards.filter(card => card.seq > readState.baselineSeq && !card.hostRead && !readState.viewed.has(card.mailRefId)).length : 0;
  const accounts = assistant?.accounts;
  const { accountLabels, showAccount } = useMemo(() => {
    const seenUsers = new Set<string>();
    const duplicateUsers = new Set<string>();
    for (const { user } of accounts ?? []) {
      if (seenUsers.has(user)) duplicateUsers.add(user);
      seenUsers.add(user);
    }
    const accountLabels = new Map(accounts?.map(({ accountKey, user, host, port }) => [
      accountKey, duplicateUsers.has(user) ? `${user} (${host}:${port})` : user,
    ]));
    const accountKeys = new Set(accountLabels.keys());
    for (const card of cache.cards) accountKeys.add(card.accountKey);
    return { accountLabels, showAccount: accountKeys.size > 1 };
  }, [accounts, cache.cards]);
  const selectedMail = selection && selection.sessionId === assistant?.binding?.nativeSessionId
    ? cache.cards.find(card => card.mailRefId === selection.card.mailRefId) ?? selection.card : undefined;
  return <AssistantMailContext.Provider value={enabled ? {
    cache, unreadCount, attention: assistant?.attention, acknowledge, assistant, canReference, selectedMail,
    supportsAttachments: capabilities.includes("plugin.assistant-mail.attachments.v1"),
    supportsBatches: capabilities.includes("plugin.assistant-mail.batches.v1"),
    accountLabel: accountKey => {
      const label = accountLabels.get(accountKey);
      if (accounts && !label) return "已移除的邮箱";
      return showAccount ? label ?? accountKey.slice(0, 8) : "邮件插件";
    },
    referenceFor: sessionId => {
      if (!selectedMail || assistant?.binding?.nativeSessionId !== sessionId) return undefined;
      if (!canReference) throw new Error("当前电脑不支持邮件引用，请先清除引用。");
      return selectedMail.mailRefId;
    },
    markViewed,
    selectMail: card => {
      if (!canReference) return;
      if (!capabilities.includes(ASSISTANT_ATTENTION_CAPABILITY)) markViewed(card);
      setSelection({ sessionId: assistant!.binding!.nativeSessionId!, card });
      onDiscuss?.();
    },
    clearReference: () => setSelection(undefined),
    loading: loading || historyLoading, hasOlderMail, error, online, request, loadOlder, reload, refreshStatus,
    refresh: () => { setRefreshStatus("refreshing"); reload(); },
    read: async mailRefId => mailResult<{ mailDetail: BridgeMailDetail }>(await request("plugin.assistant-mail.read", { mailRefId })).mailDetail,
  } : undefined}>{children}</AssistantMailContext.Provider>;
}
