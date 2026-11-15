import type { BridgeDirectoryListing, BridgeHostSnapshot, BridgeSessionInfo } from "@bridge/protocol";
import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { IconButton } from "../common/IconButton.js";
import { MobilePageHeader } from "../mobile/MobilePageHeader.js";
import { SessionCreateDialog } from "../session/SessionCreateDialog.js";
import { mailResult, useAssistantMail } from "./AssistantMailProvider.js";
import { MailCard } from "./MailCard.js";
import "./assistant-mail.css";

export function AssistantPage({ snapshot, mobile = false, onOpenSession }: {
  snapshot: BridgeHostSnapshot;
  mobile?: boolean;
  onOpenSession(sessionId: string): void;
}) {
  const mail = useAssistantMail();
  const [configuring, setConfiguring] = useState(false);
  const [selectedId, setSelectedId] = useState("");
  const [creating, setCreating] = useState(false);
  const [bindingBusy, setBindingBusy] = useState(false);
  const [bindingError, setBindingError] = useState("");
  if (!mail) return null;
  const binding = snapshot.assistantMail?.binding;
  const session = snapshot.sessions.find(candidate => candidate.sessionId === binding?.nativeSessionId);
  const state = snapshot.assistantMail?.bindingState;

  async function bind(sessionId: string): Promise<boolean> {
    setBindingBusy(true); setBindingError("");
    try {
      mailResult(await mail!.request("plugin.assistant-mail.bind", { sessionId }));
      setConfiguring(false);
      mail!.refresh();
      return true;
    } catch (reason) {
      setBindingError(reason instanceof Error ? reason.message : "会话绑定失败");
      return false;
    } finally { setBindingBusy(false); }
  }

  const refresh = <IconButton label="刷新邮件" disabled={!mail.online || mail.loading} onClick={mail.refresh}><RefreshCw size={18} /></IconButton>;
  return <section className={`assistant-page ${mobile ? "assistant-page-mobile" : "desktop-page"}`}>
    {mobile && <MobilePageHeader title="助理" actions={refresh} />}
    <div className="assistant-page-content">
      {!mobile && <header className="desktop-page-heading"><h1>助理</h1>{refresh}</header>}
      <section className="assistant-binding" aria-label="助理会话绑定">
        <div className="assistant-binding-current">
          {session && !session.archivedAt ? <button type="button" className="assistant-session-link" onClick={() => onOpenSession(session.sessionId)}>{session.title || "助理会话"}</button> : <strong>{binding?.nativeSessionId || binding?.previousSessionIds.length ? "重新绑定会话" : "选择助理会话"}</strong>}
          {binding?.nativeSessionId && <button type="button" className="assistant-session-link" onClick={() => setConfiguring(value => !value)}>更换会话</button>}
        </div>
        {state === "needs-rebind" && <p role="status">原会话已归档或删除，请重新绑定。</p>}
        {state === "missing" && <p role="status">未找到绑定会话。连接恢复后可再次核对，或更换会话。</p>}
        {state === "unavailable" && <p role="status">原生会话暂不可用。</p>}
        {(configuring || !binding?.nativeSessionId) && <div className="assistant-binding-form">
          <label>助理会话<select aria-label="助理会话" value={selectedId} onChange={event => setSelectedId(event.target.value)} disabled={!mail.online || bindingBusy}>
            <option value="">选择现有会话</option>
            {snapshot.sessions.filter(candidate => candidate.transport === "claude-desktop-native" && !candidate.archivedAt).map(candidate => <option key={candidate.sessionId} value={candidate.sessionId}>{candidate.title || candidate.sessionId}</option>)}
          </select></label>
          <div><button type="button" className="primary-button" disabled={!mail.online || bindingBusy || !selectedId} onClick={() => { void bind(selectedId); }}>绑定会话</button>
            <button type="button" className="secondary-button" disabled={!mail.online || bindingBusy} onClick={() => setCreating(true)}>新建会话</button></div>
        </div>}
        {bindingError && <p role="alert">{bindingError}</p>}
        <span className="assistant-delivery-disabled">自动投递未启用</span>
        {binding?.previousSessionIds.length ? <details><summary>以前的会话</summary><ul>{binding.previousSessionIds.map(sessionId => {
          const previous = snapshot.sessions.find(candidate => candidate.sessionId === sessionId);
          return <li key={sessionId}>{previous ? <button type="button" className="assistant-session-link" onClick={() => onOpenSession(sessionId)}>{previous.title || sessionId}</button> : <span>{sessionId}</span>}</li>;
        })}</ul></details> : null}
      </section>
      {!mail.online && <p role="status">电脑离线，显示已缓存邮件。</p>}
      {mail.error && <p role="alert">{mail.error}</p>}
      <div className="assistant-mail-list" aria-label="邮件输入">{mail.cache.cards.map(card => <MailCard key={card.mailRefId} card={card} />)}</div>
      {!mail.cache.cards.length && <p className="assistant-mail-empty" role="status">{mail.loading ? "正在同步邮件…" : "暂无已记录邮件"}</p>}
      {mail.cache.nextCursor && <button type="button" className="secondary-button assistant-mail-older" disabled={!mail.online || mail.loading} onClick={() => void mail.loadOlder()}>{mail.loading ? "正在读取…" : "更早邮件"}</button>}
    </div>
    {creating && <SessionCreateDialog snapshot={snapshot} connected={mail.online}
      {...(snapshot.host.capabilities.includes("directory.browse.v1") ? { onBrowseDirectory: async (path?: string) => mailResult<{ listing: BridgeDirectoryListing }>(await mail.request("directory.list", path ? { path } : {})).listing } : {})}
      onCreate={async (cwd, title, runtimeId, projectId, trustWorkspace) => {
        const { session: created } = mailResult<{ session: BridgeSessionInfo }>(await mail.request("session.create", { cwd, title, runtimeId, projectId, trustWorkspace }));
        if (!await bind(created.sessionId)) throw new Error("会话已创建，绑定失败；可选择该会话重试。");
        return created;
      }} onCreated={() => {}} onClose={() => setCreating(false)} />}
  </section>;
}
