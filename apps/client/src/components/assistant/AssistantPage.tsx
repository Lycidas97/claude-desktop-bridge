import type { BridgeDirectoryListing, BridgeHostSnapshot, BridgeMailAccount, BridgeMethod, BridgeSessionInfo } from "@bridge/protocol";
import { RefreshCw, Settings } from "lucide-react";
import { useEffect, useId, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { IconButton } from "../common/IconButton.js";
import { SelectMenu } from "../common/SelectMenu.js";
import { MobilePageHeader } from "../mobile/MobilePageHeader.js";
import { SessionCreateDialog } from "../session/SessionCreateDialog.js";
import { mailResult, useAssistantMail, type AssistantRequest } from "./AssistantMailProvider.js";
import { MailCard } from "./MailCard.js";
import { MailReference } from "./MailReference.js";
import "./assistant-mail.css";

export function AssistantPage({ snapshot, mobile = false, active = true, headerLeading, onOpenSession, renderConversation }: {
  snapshot: BridgeHostSnapshot | undefined;
  mobile?: boolean;
  active?: boolean;
  headerLeading?: ReactNode | undefined;
  onOpenSession(sessionId: string): void;
  renderConversation(sessionId: string, stage: { alternateStage?: ReactNode | undefined; hideComposer?: boolean | undefined }): ReactNode;
}) {
  const mail = useAssistantMail();
  const [view, setView] = useState<"conversation" | "mail" | "settings">("conversation");
  const [configuring, setConfiguring] = useState(false);
  const [selectedId, setSelectedId] = useState("");
  const [creating, setCreating] = useState(false);
  const [confirmWorkspace, setConfirmWorkspace] = useState(false);
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
  const workspace = mail.assistant?.workspace;
  const capabilities = snapshot?.host.capabilities ?? mail.cache.workspace?.capabilities ?? [];
  const supportsWorkspace = capabilities.includes("plugin.assistant-mail.workspace.v1") && Boolean(workspace);
  const session = snapshot?.sessions.find(candidate => candidate.sessionId === binding?.nativeSessionId && !candidate.archivedAt);
  const state = mail.assistant?.bindingState;
  const displayedView = view === "conversation" && !session ? "mail" : view;

  async function configureBinding(method: "plugin.assistant-mail.bind" | "plugin.assistant-mail.workspace.initialize", params: Record<string, string>): Promise<boolean> {
    setBindingBusy(true); setBindingError("");
    try {
      mailResult(await mail!.request(method, params));
      setConfiguring(false);
      setConfirmWorkspace(false);
      setView("conversation");
      mail!.refresh();
      return true;
    } catch (reason) {
      setBindingError(reason instanceof Error ? reason.message : "助理会话设置失败");
      return false;
    } finally { setBindingBusy(false); }
  }

  const refresh = <IconButton label="刷新邮件" disabled={!mail.online || mail.loading} onClick={mail.refresh}><RefreshCw size={16} /></IconButton>;
  const viewTabs = (
    <nav className="assistant-view-tabs" aria-label="助理工作台">
      <div className="assistant-view-switch">
        <button type="button" aria-pressed={displayedView === "conversation"} disabled={!session} onClick={() => setView("conversation")}>对话</button>
        <button type="button" aria-pressed={displayedView === "mail"} onClick={() => setView("mail")}>收件</button>
      </div>
      <IconButton label="助理设置" aria-pressed={displayedView === "settings"} onClick={() => setView("settings")}><Settings size={16} /></IconButton>
      {refresh}
    </nav>
  );
  const bindingControls = (displayedView === "settings" || !binding?.nativeSessionId || state === "needs-rebind" || state === "missing") && (
    <section className="assistant-binding" aria-label="助理会话绑定">
      <div className="assistant-binding-current">
        {binding?.nativeSessionId ? <button type="button" className="assistant-session-link" onClick={() => setView("conversation")}>{session?.title || binding.nativeSessionId}</button> : <strong>{binding?.previousSessionIds.length ? "重新绑定会话" : "选择助理会话"}</strong>}
        {binding?.nativeSessionId && <button type="button" className="assistant-session-link" onClick={() => setConfiguring(value => !value)}>更换会话</button>}
      </div>
      {state === "needs-rebind" && <p role="status">原会话已归档或删除，请重新绑定。</p>}
      {state === "missing" && <p role="status">未找到绑定会话。连接恢复后可再次核对，或更换会话。</p>}
      {(configuring || !binding?.nativeSessionId) && <div className="assistant-binding-form">
        <div className="assistant-binding-select">
          <span>助理会话</span>
          <SelectMenu
            ariaLabel="助理会话"
            value={selectedId}
            placeholder="选择现有会话"
            disabled={!mail.online || bindingBusy}
            options={[
              { value: "", label: "选择现有会话" },
              ...(snapshot?.sessions
                .filter(candidate => candidate.transport === "claude-desktop-native" && !candidate.archivedAt)
                .map(candidate => ({ value: candidate.sessionId, label: candidate.title || candidate.sessionId })) ?? []),
            ]}
            onChange={setSelectedId}
          />
        </div>
        <div className="assistant-actions">
          <button type="button" className="primary-button" disabled={!mail.online || bindingBusy || !selectedId} onClick={() => { void configureBinding("plugin.assistant-mail.bind", { sessionId: selectedId }); }}>绑定会话</button>
          {!supportsWorkspace && <button type="button" className="secondary-button" disabled={!mail.online || bindingBusy} onClick={() => setCreating(true)}>新建会话</button>}
        </div>
      </div>}
      {supportsWorkspace && workspace && (!workspace.nativeSessionId || state === "needs-rebind" || state === "missing") && (
        confirmWorkspace ? <div className="assistant-workspace-confirm">
          <p>确认信任此工作区并创建托管助理会话？</p>
          <code>{workspace.path}</code>
          <div className="assistant-actions">
            <button type="button" className="secondary-button" disabled={bindingBusy} onClick={() => setConfirmWorkspace(false)}>取消</button>
            <button type="button" className="primary-button" disabled={!mail.online || bindingBusy} onClick={() => { void configureBinding("plugin.assistant-mail.workspace.initialize", { workspacePath: workspace.path }); }}>确认初始化</button>
          </div>
        </div> : <button type="button" className="secondary-button" disabled={!mail.online || bindingBusy} onClick={() => setConfirmWorkspace(true)}>初始化托管助理</button>
      )}
      {bindingError && <p role="alert">{bindingError}</p>}
      <span className="assistant-delivery-disabled">自动投递未启用</span>
      {binding?.previousSessionIds.length ? <details><summary>以前的会话</summary><ul>{binding.previousSessionIds.map(sessionId => {
        const previous = snapshot?.sessions.find(candidate => candidate.sessionId === sessionId);
        return <li key={sessionId}>{previous ? <button type="button" className="assistant-session-link" onClick={() => onOpenSession(sessionId)}>{previous.title || sessionId}</button> : <span>{sessionId}</span>}</li>;
      })}</ul></details> : null}
    </section>
  );
  const notices = <>
    {workspace?.toolIsolation === "warning" && <p role="alert">检测到托管助理的工具隔离异常{workspace.unexpectedTools?.length ? `：${workspace.unexpectedTools.join("、")}` : "。"}</p>}
    {state === "unavailable" && <p role="status">原生会话暂不可用。</p>}
    {!mail.online && <p role="status">电脑离线，显示已缓存邮件。</p>}
    {!snapshot && binding?.nativeSessionId && <p>绑定会话：{binding.nativeSessionId}</p>}
    {mail.error && <p role="alert">{mail.error}</p>}
  </>;
  const stage = <div className="assistant-page-content">
    {bindingControls}
    {notices}
    {displayedView === "settings" && capabilities.includes("plugin.assistant-mail.account.v1") && <MailAccounts
      accounts={mail.assistant?.accounts ?? []}
      credentialsSupported={mail.assistant?.credentialsSupported === true}
      online={mail.online}
      request={mail.request}
    />}
    {displayedView === "mail" && <>
      {!session && binding?.nativeSessionId && <MailReference sessionId={binding.nativeSessionId} />}
      <div className="assistant-mail-list" aria-label="邮件输入">{mail.cache.cards.map(card => <MailCard key={card.mailRefId} card={card} onDiscuss={() => setView("conversation")} />)}</div>
      {!mail.cache.cards.length && <p className="assistant-mail-empty" role="status">{mail.loading ? "正在同步邮件…" : "暂无已记录邮件"}</p>}
      {mail.cache.nextCursor && <button type="button" className="secondary-button assistant-mail-older" disabled={!mail.online || mail.loading} onClick={() => void mail.loadOlder()}>{mail.loading ? "正在读取…" : "更早邮件"}</button>}
    </>}
  </div>;
  return <section className={`assistant-page ${mobile ? "assistant-page-mobile" : "desktop-page"}${session ? " has-conversation" : ""}`}>
    {mobile && <MobilePageHeader title="助理" {...(headerLeading ? { leading: headerLeading } : {})} actions={viewTabs} />}
    {!mobile && <div className="assistant-desktop-header-band">
      {headerLeading && <div className="assistant-desktop-leading">{headerLeading}</div>}
      <div className="assistant-page-header-inner">
        <header className="desktop-page-heading"><h1>助理</h1>{viewTabs}</header>
      </div>
    </div>}
    {session ? <>
      {displayedView === "conversation" && <div className="assistant-page-content">{bindingControls}{notices}</div>}
      <div className="assistant-conversation">{renderConversation(session.sessionId, {
        alternateStage: displayedView === "conversation" ? undefined : stage,
        hideComposer: displayedView === "settings",
      })}</div>
    </> : stage}
    {creating && snapshot && <SessionCreateDialog snapshot={snapshot} connected={mail.online}
      {...(snapshot.host.capabilities.includes("directory.browse.v1") ? { onBrowseDirectory: browseDirectory } : {})}
      {...(snapshot.host.capabilities.includes("directory.mkdir.v1") ? { onCreateDirectory: createDirectory } : {})}
      {...(!mobile && window.bridgeDesktop?.chooseDirectory
        ? { onChooseDirectory: () => window.bridgeDesktop!.chooseDirectory!() }
        : {})}
      onCreate={async (cwd, title, runtimeId, projectId, trustWorkspace) => {
        const { session: created } = mailResult<{ session: BridgeSessionInfo }>(await mail.request("session.create", { cwd, title, runtimeId, projectId, trustWorkspace }));
        if (!await configureBinding("plugin.assistant-mail.bind", { sessionId: created.sessionId })) throw new Error("会话已创建，绑定失败；可选择该会话重试。");
        return created;
      }} onCreated={() => {}} onClose={() => setCreating(false)} />}
  </section>;
}

const RECEIVER_LABELS: Record<BridgeMailAccount["state"], string> = {
  disabled: "已停用", connecting: "连接中", connected: "已连接", reconnecting: "重连中",
  unsupported: "不支持", error: "连接失败", closed: "未连接",
};

function MailAccounts({ accounts, credentialsSupported, online, request }: {
  accounts: BridgeMailAccount[];
  credentialsSupported: boolean;
  online: boolean;
  request: AssistantRequest;
}) {
  const headingId = useId();
  const [action, setAction] = useState<{ kind: "add" } | { kind: "edit" | "remove"; accountKey: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const disabled = !online || !credentialsSupported || busy;
  const editedAccount = action?.kind === "edit" ? accounts.find(account => account.accountKey === action.accountKey) : undefined;
  const removedAccount = action?.kind === "remove" ? accounts.find(account => account.accountKey === action.accountKey) : undefined;

  async function update(method: BridgeMethod, params: Record<string, unknown>) {
    setBusy(true);
    setError("");
    try {
      mailResult(await request(method, params));
      setAction(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "邮箱账号设置失败");
    } finally {
      setBusy(false);
    }
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const credential = String(data.get("credential"));
    form.querySelector<HTMLInputElement>('input[name="credential"]')!.value = "";
    if (editedAccount) {
      void update("plugin.assistant-mail.account.update-credential", { accountKey: editedAccount.accountKey, credential });
    } else {
      const host = String(data.get("host")).trim();
      const user = String(data.get("user")).trim();
      const port = data.get("port");
      void update("plugin.assistant-mail.account.add", { host, user, ...(port ? { port: Number(port) } : {}), credential });
    }
  }

  return <section className="assistant-accounts" aria-labelledby={headingId}>
    <div className="assistant-accounts-heading">
      <h2 id={headingId}>邮箱账号</h2>
      <button type="button" className="assistant-session-link" disabled={disabled || action?.kind === "add"} onClick={() => { setError(""); setAction({ kind: "add" }); }}>添加邮箱</button>
    </div>
    {!credentialsSupported && <p role="status">当前电脑不支持存储邮箱凭据。</p>}
    {credentialsSupported && !accounts.length && !action && <p>尚未添加邮箱。</p>}
    {accounts.map(account => <div className="assistant-account-row" key={account.accountKey}>
      <div className="assistant-account-identity">
        <strong>{account.user}</strong>
        <span>{account.host}:{account.port}</span>
      </div>
      <span className="assistant-account-state" data-state={account.enabled ? account.state : "disabled"}>{account.enabled ? RECEIVER_LABELS[account.state] : "已停用"}</span>
      <div className="assistant-actions assistant-account-actions">
        <button type="button" className="assistant-session-link" aria-label={`更新密码：${account.user}`} disabled={disabled} onClick={() => { setError(""); setAction({ kind: "edit", accountKey: account.accountKey }); }}>更新密码</button>
        <button type="button" className="assistant-session-link" aria-label={`${account.enabled ? "停用" : "启用"}：${account.user}`} disabled={disabled} onClick={() => { void update("plugin.assistant-mail.account.set-enabled", { accountKey: account.accountKey, enabled: !account.enabled }); }}>{account.enabled ? "停用" : "启用"}</button>
        <button type="button" className="assistant-session-link assistant-remove" aria-label={`移除：${account.user}`} disabled={disabled} onClick={() => { setError(""); setAction({ kind: "remove", accountKey: account.accountKey }); }}>移除</button>
      </div>
    </div>)}
    {(action?.kind === "add" || editedAccount) && <form key={editedAccount?.accountKey ?? "add"} onSubmit={save} autoComplete="off">
      <fieldset className="assistant-account-form" disabled={disabled}>
        <legend>{editedAccount ? `更新 ${editedAccount.user} 的密码` : "添加邮箱"}</legend>
        {!editedAccount && <>
          <label>邮箱地址<input name="user" required inputMode="email" autoCapitalize="none" spellCheck={false} /></label>
          <div className="assistant-account-server">
            <label>IMAP 服务器<input name="host" required autoCapitalize="none" spellCheck={false} /></label>
            <label>端口<input name="port" type="number" min={1} max={65535} placeholder="993" /></label>
          </div>
        </>}
        <label>密码<input name="credential" type="password" autoComplete="new-password" required /></label>
        <div className="assistant-actions">
          <button type="button" className="secondary-button" onClick={() => { setError(""); setAction(undefined); }}>取消</button>
          <button type="submit" className="primary-button">{editedAccount ? "保存密码" : "添加账号"}</button>
        </div>
      </fieldset>
    </form>}
    {removedAccount && <div className="assistant-account-confirm">
      <p>移除 {removedAccount.user}？已收取的邮件仍可查看。</p>
      <div className="assistant-actions">
        <button type="button" className="secondary-button" disabled={busy} onClick={() => { setError(""); setAction(undefined); }}>取消</button>
        <button type="button" className="secondary-button assistant-remove" disabled={disabled} onClick={() => { void update("plugin.assistant-mail.account.remove", { accountKey: removedAccount.accountKey }); }}>确认移除</button>
      </div>
    </div>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
