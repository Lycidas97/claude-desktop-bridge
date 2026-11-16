import type { BridgeDirectoryListing, BridgeHostSnapshot, BridgeSessionInfo } from "@bridge/protocol";
import { RefreshCw, Settings } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { IconButton } from "../common/IconButton.js";
import { MobilePageHeader } from "../mobile/MobilePageHeader.js";
import { SessionCreateDialog } from "../session/SessionCreateDialog.js";
import { mailResult, useAssistantMail } from "./AssistantMailProvider.js";
import { MailCard } from "./MailCard.js";
import { MailReference } from "./MailReference.js";
import "./assistant-mail.css";

export function AssistantPage({ snapshot, mobile = false, active = true, headerLeading, onOpenSession, renderConversation }: {
  snapshot: BridgeHostSnapshot | undefined;
  mobile?: boolean;
  active?: boolean;
  headerLeading?: ReactNode | undefined;
  onOpenSession(sessionId: string): void;
  renderConversation(sessionId: string): ReactNode;
}) {
  const mail = useAssistantMail();
  const [view, setView] = useState<"conversation" | "mail" | "settings">("conversation");
  const [configuring, setConfiguring] = useState(false);
  const [selectedId, setSelectedId] = useState("");
  const [creating, setCreating] = useState(false);
  const [bindingBusy, setBindingBusy] = useState(false);
  const [bindingError, setBindingError] = useState("");
  const browseDirectory = useMemo(
    () => (async (path?: string) => mailResult<{ listing: BridgeDirectoryListing }>(await mail!.request("directory.list", path ? { path } : {})).listing),
    [mail?.request],
  );
  const createDirectory = useMemo(
    () => (async (parentPath: string, name: string) => (
      mailResult<{ path: string }>(await mail!.request("directory.mkdir", { parentPath, name })).path
    )),
    [mail?.request],
  );
  useEffect(() => { if (active) setView("conversation"); }, [active]);
  if (!active) return null;
  if (!mail) return null;
  const binding = mail.assistant?.binding;
  const session = snapshot?.sessions.find(candidate => candidate.sessionId === binding?.nativeSessionId && !candidate.archivedAt);
  const state = mail.assistant?.bindingState;
  const displayedView = view === "conversation" && !session ? "mail" : view;

  async function bind(sessionId: string): Promise<boolean> {
    setBindingBusy(true); setBindingError("");
    try {
      mailResult(await mail!.request("plugin.assistant-mail.bind", { sessionId }));
      setConfiguring(false);
      setView("conversation");
      mail!.refresh();
      return true;
    } catch (reason) {
      setBindingError(reason instanceof Error ? reason.message : "会话绑定失败");
      return false;
    } finally { setBindingBusy(false); }
  }

  const refresh = <IconButton label="刷新邮件" disabled={!mail.online || mail.loading} onClick={mail.refresh}><RefreshCw size={18} /></IconButton>;
  return <section className={`assistant-page ${mobile ? "assistant-page-mobile" : "desktop-page"}${displayedView === "conversation" ? " is-conversation" : ""}`}>
    {mobile && <MobilePageHeader title="助理" {...(headerLeading ? { leading: headerLeading } : {})} actions={refresh} />}
    {!mobile && headerLeading && <div className="assistant-desktop-topbar">{headerLeading}</div>}
    <div className="assistant-page-content">
      {!mobile && <header className="desktop-page-heading"><h1>助理</h1>{refresh}</header>}
      <nav className="assistant-view-tabs" aria-label="助理工作台">
        <button type="button" aria-pressed={displayedView === "conversation"} disabled={!session} onClick={() => setView("conversation")}>对话</button>
        <button type="button" aria-pressed={displayedView === "mail"} onClick={() => setView("mail")}>邮件</button>
        <IconButton label="助理设置" aria-pressed={displayedView === "settings"} onClick={() => setView("settings")}><Settings size={18} /></IconButton>
      </nav>
      {(displayedView === "settings" || !binding?.nativeSessionId || state === "needs-rebind" || state === "missing") && <section className="assistant-binding" aria-label="助理会话绑定">
        <div className="assistant-binding-current">
          {binding?.nativeSessionId ? <button type="button" className="assistant-session-link" onClick={() => setView("conversation")}>{session?.title || binding.nativeSessionId}</button> : <strong>{binding?.previousSessionIds.length ? "重新绑定会话" : "选择助理会话"}</strong>}
          {binding?.nativeSessionId && <button type="button" className="assistant-session-link" onClick={() => setConfiguring(value => !value)}>更换会话</button>}
        </div>
        {state === "needs-rebind" && <p role="status">原会话已归档或删除，请重新绑定。</p>}
        {state === "missing" && <p role="status">未找到绑定会话。连接恢复后可再次核对，或更换会话。</p>}
        {(configuring || !binding?.nativeSessionId) && <div className="assistant-binding-form">
          <label>助理会话<select aria-label="助理会话" value={selectedId} onChange={event => setSelectedId(event.target.value)} disabled={!mail.online || bindingBusy}>
            <option value="">选择现有会话</option>
            {snapshot?.sessions.filter(candidate => candidate.transport === "claude-desktop-native" && !candidate.archivedAt).map(candidate => <option key={candidate.sessionId} value={candidate.sessionId}>{candidate.title || candidate.sessionId}</option>)}
          </select></label>
          <div><button type="button" className="primary-button" disabled={!mail.online || bindingBusy || !selectedId} onClick={() => { void bind(selectedId); }}>绑定会话</button>
            <button type="button" className="secondary-button" disabled={!mail.online || bindingBusy} onClick={() => setCreating(true)}>新建会话</button></div>
        </div>}
        {bindingError && <p role="alert">{bindingError}</p>}
        <span className="assistant-delivery-disabled">自动投递未启用</span>
        {binding?.previousSessionIds.length ? <details><summary>以前的会话</summary><ul>{binding.previousSessionIds.map(sessionId => {
          const previous = snapshot?.sessions.find(candidate => candidate.sessionId === sessionId);
          return <li key={sessionId}>{previous ? <button type="button" className="assistant-session-link" onClick={() => onOpenSession(sessionId)}>{previous.title || sessionId}</button> : <span>{sessionId}</span>}</li>;
        })}</ul></details> : null}
      </section>}
      {state === "unavailable" && <p role="status">原生会话暂不可用。</p>}
      {!mail.online && <p role="status">电脑离线，显示已缓存邮件。</p>}
      {!snapshot && binding?.nativeSessionId && <p>绑定会话：{binding.nativeSessionId}</p>}
      {mail.error && <p role="alert">{mail.error}</p>}
      {displayedView === "mail" && <>
        {!session && binding?.nativeSessionId && <MailReference sessionId={binding.nativeSessionId} />}
        <div className="assistant-mail-list" aria-label="邮件输入">{mail.cache.cards.map(card => <MailCard key={card.mailRefId} card={card} onDiscuss={() => setView("conversation")} />)}</div>
        {!mail.cache.cards.length && <p className="assistant-mail-empty" role="status">{mail.loading ? "正在同步邮件…" : "暂无已记录邮件"}</p>}
        {mail.cache.nextCursor && <button type="button" className="secondary-button assistant-mail-older" disabled={!mail.online || mail.loading} onClick={() => void mail.loadOlder()}>{mail.loading ? "正在读取…" : "更早邮件"}</button>}
      </>}
    </div>
    {displayedView === "conversation" && session && <div className="assistant-conversation">{renderConversation(session.sessionId)}</div>}
    {creating && snapshot && <SessionCreateDialog snapshot={snapshot} connected={mail.online}
      {...(snapshot.host.capabilities.includes("directory.browse.v1") ? { onBrowseDirectory: browseDirectory } : {})}
      {...(snapshot.host.capabilities.includes("directory.mkdir.v1") ? { onCreateDirectory: createDirectory } : {})}
      {...(!mobile && window.bridgeDesktop?.chooseDirectory
        ? { onChooseDirectory: () => window.bridgeDesktop!.chooseDirectory!() }
        : {})}
      onCreate={async (cwd, title, runtimeId, projectId, trustWorkspace) => {
        const { session: created } = mailResult<{ session: BridgeSessionInfo }>(await mail.request("session.create", { cwd, title, runtimeId, projectId, trustWorkspace }));
        if (!await bind(created.sessionId)) throw new Error("会话已创建，绑定失败；可选择该会话重试。");
        return created;
      }} onCreated={() => {}} onClose={() => setCreating(false)} />}
  </section>;
}
