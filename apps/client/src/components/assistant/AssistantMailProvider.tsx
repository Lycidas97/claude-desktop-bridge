import type { BridgeAssistantMailSnapshot, BridgeHostSnapshot, BridgeMailCache, BridgeMailCard, BridgeMailDetail, BridgeMailPage, BridgeMethod, BridgeResponse } from "@bridge/protocol";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { mergeMailCards, refreshMailPages } from "../../lib/assistant-mail.js";

export type AssistantRequest = (method: BridgeMethod, params: Record<string, unknown>) => Promise<BridgeResponse | undefined>;

export function mailResult<T>(response: BridgeResponse | undefined): T {
  if (!response?.ok) throw Object.assign(new Error(response?.error?.message ?? "邮件读取失败"), { code: response?.error?.code });
  return response.result as T;
}

interface AssistantMailState {
  cache: BridgeMailCache;
  unreadCount: number;
  accountLabel(accountKey: string): string;
  assistant: BridgeAssistantMailSnapshot | undefined;
  selectedMail: BridgeMailCard | undefined;
  canReference: boolean;
  supportsAttachments: boolean;
  selectMail(card: BridgeMailCard): void;
  clearReference(): void;
  referenceFor(sessionId: string): string | undefined;
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
export function AssistantMailProvider({ snapshot, online, request, loadCache, saveCache, onDiscuss, children }: {
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
  const [selection, setSelection] = useState<{ sessionId: string; mailRefId: string }>();
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
    void loadCache().then(stored => { if (active && stored) setCache(stored); })
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
  useEffect(() => {
    if (!enabled || !online || !cacheReady) return;
    let active = true;
    setLoading(true);
    setError("");
    void refreshMailPages(async cursor => mailResult<{ mailPage: BridgeMailPage }>(await request("plugin.assistant-mail.list", cursor ? { cursor } : {})).mailPage, cacheRef.current, changeToken)
      .then(next => { if (active) setCache(next); })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : "邮件同步失败"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [enabled, online, cacheReady, changeToken, refreshKey, request]);

  async function loadOlder(): Promise<void> {
    if (!online || loading || !cache.nextCursor) return;
    setLoading(true);
    setError("");
    try {
      const { mailPage } = mailResult<{ mailPage: BridgeMailPage }>(await request("plugin.assistant-mail.list", { cursor: cache.nextCursor }));
      if (!mounted.current) return;
      setCache({ cards: mergeMailCards(cacheRef.current.cards, mailPage.cards), changeToken,
        ...(cacheRef.current.workspace ? { workspace: cacheRef.current.workspace } : {}),
        ...(mailPage.nextCursor ? { nextCursor: mailPage.nextCursor } : {}) });
    } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : "邮件读取失败"); }
    finally { if (mounted.current) setLoading(false); }
  }

  const unreadCount = cache.cards.reduce((count, card) => count + (card.processingStatus === "pending" ? 1 : 0), 0);
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
  const selectedMail = selection?.sessionId === assistant?.binding?.nativeSessionId ? cache.cards.find(card => card.mailRefId === selection?.mailRefId) : undefined;
  return <AssistantMailContext.Provider value={enabled ? {
    cache, unreadCount, assistant, canReference, selectedMail,
    supportsAttachments: capabilities.includes("plugin.assistant-mail.attachments.v1"),
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
    selectMail: card => {
      if (!canReference) return;
      setSelection({ sessionId: assistant!.binding!.nativeSessionId!, mailRefId: card.mailRefId });
      onDiscuss?.();
    },
    clearReference: () => setSelection(undefined),
    loading, error, online, request, loadOlder,
    refresh: () => setRefreshKey(value => value + 1),
    read: async mailRefId => mailResult<{ mailDetail: BridgeMailDetail }>(await request("plugin.assistant-mail.read", { mailRefId })).mailDetail,
  } : undefined}>{children}</AssistantMailContext.Provider>;
}
