import type { BridgeMailCache, BridgeMailCard, BridgeMailCategory, BridgeMailFolder, BridgeMailPage } from "@bridge/protocol";
import { ChevronRight, Search, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { mergeMailCards, refreshMailPages } from "../../lib/assistant-mail.js";
import { mailResult, type useAssistantMail } from "./AssistantMailProvider.js";
import { MailCard } from "./MailCard.js";
import { useVisibleMailRead } from "./useVisibleMailRead.js";

export function InboxMailList({ mail, mobile, filed, canMarkJunk, onOpenFiled, onDiscuss }: {
  mail: NonNullable<ReturnType<typeof useAssistantMail>>; mobile: boolean; filed: boolean; canMarkJunk: boolean;
  onOpenFiled(): void; onDiscuss(): void;
}) {
  const { cards, folderCounts } = mail.cache;
  const inboxCards = mail.supportsFiling ? cards.filter(card => !card.folder) : cards;
  const filedCount = mail.categories.reduce((total, { id }) => total + (folderCounts?.[id] ?? 0), 0);
  const filedEntry = useRef<HTMLButtonElement>(null);
  const wasFiled = useRef(filed);
  useEffect(() => {
    if (wasFiled.current && !filed) filedEntry.current?.focus();
    wasFiled.current = filed;
  }, [filed]);
  const [searchText, setSearchText] = useState("");
  const [query, setQuery] = useState("");
  const [openedFolders, setOpenedFolders] = useState<ReadonlySet<BridgeMailCategory>>(new Set());
  type Placement = { junk: boolean } | { folder: BridgeMailFolder };
  const [lastMove, setLastMove] = useState<{ mailRefId: string; subject: string; placement: Placement; previous: Placement; focusUndo: boolean }>();
  const receipt = lastMove && [lastMove.placement, lastMove.previous].every(placement =>
    "junk" in placement || placement.folder === "inbox" || mail.categories.some(({ id }) => id === placement.folder)) ? lastMove : undefined;
  const undoButton = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const disabled = !mail.online || busy;
  useEffect(() => {
    if (receipt?.focusUndo) undoButton.current?.focus({ preventScroll: true });
  }, [receipt]);

  async function move({ mailRefId, subject }: Pick<BridgeMailCard, "mailRefId" | "subject">, placement: Placement, previous?: Placement, control?: HTMLElement) {
    setBusy(true);
    setError("");
    try {
      mailResult(await mail.request("junk" in placement ? "plugin.assistant-mail.junk.set" : "plugin.assistant-mail.filing.set", { mailRefId, ...placement }));
      setLastMove(previous ? { mailRefId, subject: subject || "无主题", previous, placement,
        focusUndo: Boolean(control && (document.activeElement === control || document.activeElement === document.body)),
      } : undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法更新邮件收纳位置。");
    } finally { setBusy(false); }
  }

  const renderCard = (card: BridgeMailCard, compact: boolean, stale = false) => <MailCard key={card.mailRefId} card={card} compact={compact} onDiscuss={onDiscuss}
    junkAction={canMarkJunk ? { disabled, onMark: event => { void move(card, { junk: true }, { junk: false }, event.detail === 0 ? event.currentTarget : undefined); } } : undefined}
    filing={mail.supportsFiling ? { disabled: disabled || stale, showFolder: Boolean(query), move: (folder, control) => {
      void move(card, { folder }, { folder: card.folder ?? "inbox" }, control);
    } } : undefined} />;

  return <>
    {!filed && mail.supportsFiling && <form className="assistant-mail-search" role="search" onSubmit={event => {
      event.preventDefault(); setQuery(searchText.trim()); setError("");
    }}>
      <Search size={16} aria-hidden="true" />
      <input type="search" aria-label="搜索邮件" placeholder="搜索邮件" maxLength={200} value={searchText} onChange={event => {
        setSearchText(event.target.value);
        if (!event.target.value) setQuery("");
      }} />
      {query && <button type="button" className="assistant-session-link" aria-label="清除搜索" onClick={() => {
        setSearchText(""); setQuery(""); setError("");
      }}><X size={16} aria-hidden="true" /></button>}
      <button type="submit" className="assistant-session-link" disabled={!mail.online}>搜索</button>
    </form>}
    {/* Keep expanded categories and their loaded pages mounted when returning to the inbox. */}
    {mail.supportsFiling && (filed || openedFolders.size > 0) && <section hidden={!filed} className="assistant-mail-list" aria-label="已收纳">
      {filedCount ? <div className="assistant-mail-groups">
        {mail.categories.map(({ id: category, label }) => {
          const count = folderCounts?.[category] ?? 0;
          return count > 0 && <details className="assistant-mail-group" key={category} open={openedFolders.has(category)} onToggle={event => {
            const { open } = event.currentTarget;
            setOpenedFolders(current => current.has(category) === open ? current
              : open ? new Set(current).add(category) : new Set([...current].filter(folder => folder !== category)));
          }}>
            <summary><span>{label}</span><small>{count} 封</small><ChevronRight size={16} aria-hidden="true" /></summary>
            {openedFolders.has(category) && <div className="assistant-mail-group-cards">
              <ScopedMailList mail={mail} folder={category} visible={filed} renderCard={(card, stale) => renderCard(card, false, stale)} />
              {count > 1 && <button type="button" className="assistant-session-link assistant-mail-close-folder" onClick={event => {
                const details = event.currentTarget.closest("details")!;
                details.open = false;
                details.querySelector("summary")?.focus();
              }}>收起「{label}」</button>}
            </div>}
          </details>;
        })}
      </div> : <p className="assistant-mail-empty" role="status">{mail.loading ? "正在读取邮件…" : "暂无已收纳邮件"}</p>}
    </section>}
    {!filed && (mail.supportsFiling && query ? <div className="assistant-mail-list" aria-label="搜索结果">
      <ScopedMailList key={query} mail={mail} query={query} renderCard={card => renderCard(card, mobile)} />
    </div> : <>
      {mail.supportsFiling && <button ref={filedEntry} type="button" className="assistant-mail-filed-entry" onClick={onOpenFiled}>
        <span>已收纳</span><small>{filedCount} 封</small><ChevronRight size={16} aria-hidden="true" />
      </button>}
      <div className="assistant-mail-list" aria-label="邮件输入">{inboxCards.map(card => renderCard(card, mobile))}</div>
      {!inboxCards.length && <p className="assistant-mail-empty" role="status">{mail.loading ? "正在读取邮件…" : filedCount ? "暂无收件" : "暂无已记录邮件"}</p>}
      {mail.hasOlderMail && <button type="button" className="secondary-button assistant-mail-older" disabled={!mail.online || mail.loading} onClick={() => void mail.loadOlder()}>{mail.loading ? "正在读取…" : "更早邮件"}</button>}
    </>)}
    {(receipt || error) && <div className="assistant-mail-junk-feedback">
      {error && <span role="alert">{error}</span>}
      {receipt && <>
        <span role="status" title={receipt.subject}>{"junk" in receipt.placement ? "已在 Bridge 标为垃圾邮件" : receipt.placement.folder === "inbox"
          ? "已收回收件" : `已收入「${mail.categoryLabel(receipt.placement.folder)}」`}：{receipt.subject}</span>
        <button ref={undoButton} type="button" className="assistant-session-link" disabled={disabled} onClick={() => {
          void move(receipt, receipt.previous);
        }}>撤销</button>
      </>}
    </div>}
  </>;
}

function ScopedMailList({ mail, folder, query, visible = true, renderCard }: {
  mail: NonNullable<ReturnType<typeof useAssistantMail>>; folder?: BridgeMailCategory; query?: string; visible?: boolean; renderCard(card: BridgeMailCard, stale: boolean): ReactNode;
}) {
  const { online, request, supportsCategories, order } = mail;
  const changeToken = mail.assistant?.changeToken ?? "";
  const [page, setPage] = useState<BridgeMailCache>({ cards: [], changeToken: "" });
  const pageRef = useRef(page);
  pageRef.current = page;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const loadPage = useCallback(async (cursor?: string) => mailResult<{ mailPage: BridgeMailPage }>(await request("plugin.assistant-mail.list", {
    includeHistory: true, ...(folder ? { folder } : { query }), ...(cursor ? { cursor } : {}),
    ...(supportsCategories ? { includeCustomCategories: true } : {}), ...(order ? { order } : {}),
  })).mailPage, [request, folder, query, supportsCategories, order]);
  const read = useVisibleMailRead(useMemo(() => online ? { loadPage, changeToken } : undefined,
    [online, loadPage, changeToken]), visible);
  useEffect(() => {
    if (!read) return;
    let current = true;
    setLoading(true); setError("");
    void refreshMailPages(read.loadPage, pageRef.current, read.changeToken)
      .then(next => { if (current) setPage(next); })
      .catch(reason => { if (current) setError(reason instanceof Error ? reason.message : "邮件读取失败"); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [read]);
  async function loadMore() {
    setLoading(true); setError("");
    try {
      const cursor = page.order === order ? page.nextCursor : undefined;
      const next = await loadPage(cursor);
      setPage({ ...next, cards: cursor ? mergeMailCards(page.cards, next.cards, next.order) : next.cards,
        changeToken: cursor ? page.changeToken : changeToken });
    } catch (reason) { setError(reason instanceof Error ? reason.message : "邮件读取失败"); }
    finally { setLoading(false); }
  }
  const stale = page.changeToken !== changeToken;
  return <>
    {page.cards.map(card => renderCard(card, stale))}
    {error ? <p className="assistant-mail-empty" role="alert">{error}</p>
      : !online ? <p className="assistant-mail-empty" role="status">连接电脑后可{query ? "搜索邮件" : "读取分类邮件"}。</p>
      : loading && !page.cards.length ? <p className="assistant-mail-empty" role="status">正在读取邮件…</p>
      : !page.cards.length ? <p className="assistant-mail-empty" role="status">{query ? "没有找到匹配的邮件" : "暂无邮件"}</p> : null}
    {page.nextCursor && <button type="button" className="secondary-button assistant-mail-older" disabled={!online || loading}
      onClick={() => void loadMore()}>更多邮件</button>}
  </>;
}
