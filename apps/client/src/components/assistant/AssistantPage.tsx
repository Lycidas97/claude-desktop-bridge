import { MAIL_POLL_INTERVALS, type BridgeDirectoryListing, type BridgeHostSnapshot, type BridgeMailAccount, type BridgeMethod, type BridgeSessionInfo } from "@bridge/protocol";
import { Check, ChevronRight, LoaderCircle, RefreshCw, Settings } from "lucide-react";
import { useEffect, useId, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { formatSessionModelLabel } from "../../lib/conversation-timeline.js";
import { IconButton } from "../common/IconButton.js";
import { SelectMenu } from "../common/SelectMenu.js";
import type { ConversationViewProps } from "../conversation/ConversationView.js";
import { formatContextTokens } from "../conversation/SessionActivityIndicator.js";
import { MobilePageHeader } from "../mobile/MobilePageHeader.js";
import { effortLabel } from "../session/SessionConfigurationDialog.js";
import { SessionCreateDialog } from "../session/SessionCreateDialog.js";
import { mailResult, useAssistantMail, type AssistantRequest } from "./AssistantMailProvider.js";
import { AgendaSources } from "./AgendaSources.js";
import { AgendaView } from "./AgendaView.js";
import { useAssistantAgenda } from "./AssistantAgendaProvider.js";
import { MailCard } from "./MailCard.js";
import { MailReference } from "./MailReference.js";
import "./assistant-mail.css";

export function AssistantPage({ snapshot, mobile = false, active = true, headerLeading, onOpenSession, renderConversation }: {
  snapshot: BridgeHostSnapshot | undefined;
  mobile?: boolean;
  active?: boolean;
  headerLeading?: ReactNode | undefined;
  onOpenSession(sessionId: string): void;
  renderConversation(sessionId: string, stage: Pick<ConversationViewProps, "alternateStage" | "hideComposer">): ReactNode;
}) {
  const mail = useAssistantMail();
  const agenda = useAssistantAgenda();
  const toolWarningId = useId();
  const modelSettingsDescription = useId();
  const [view, setView] = useState<"conversation" | "mail" | "agenda" | "settings">("conversation");
  const [agendaTab, setAgendaTab] = useState<"todos" | "calendar">("todos");
  const [configuring, setConfiguring] = useState(false);
  const [selectedId, setSelectedId] = useState("");
  const [creating, setCreating] = useState(false);
  const [confirmWorkspace, setConfirmWorkspace] = useState(false);
  const [bindingBusy, setBindingBusy] = useState(false);
  const [bindingError, setBindingError] = useState("");
  const [deliveryBusy, setDeliveryBusy] = useState(false);
  const [deliveryError, setDeliveryError] = useState("");
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
  if (!mail && !agenda) return null;
  const binding = mail?.assistant?.binding;
  const workspace = mail?.assistant?.workspace;
  const capabilities = snapshot?.host.capabilities ?? mail?.cache.workspace?.capabilities ?? [];
  const supportsWorkspace = capabilities.includes("plugin.assistant-mail.workspace.v1") && Boolean(workspace);
  const session = snapshot?.sessions.find(candidate => candidate.sessionId === binding?.nativeSessionId && !candidate.archivedAt);
  const usage = session?.contextUsage;
  const managedProjectId = snapshot?.projects.find(project => project.managedAssistant)?.projectId;
  const bindableSessions = snapshot?.sessions.filter(candidate => candidate.transport === "claude-desktop-native" && !candidate.archivedAt
    && (candidate.sessionId === binding?.nativeSessionId || candidate.projectId !== managedProjectId)) ?? [];
  const state = mail?.assistant?.bindingState;
  const fallbackView = session ? "conversation" : mail ? "mail" : "agenda";
  const displayedView = (view === "conversation" && !session) || (view === "mail" && !mail) || (view === "agenda" && !agenda) ? fallbackView : view;

  async function configureBinding(method: "plugin.assistant-mail.bind" | "plugin.assistant-mail.workspace.initialize", params: Record<string, string>): Promise<boolean> {
    setBindingBusy(true); setBindingError("");
    try {
      mailResult(await mail!.request(method, params));
      setConfiguring(false);
      setConfirmWorkspace(false);
      setView("conversation");
      mail!.reload();
      return true;
    } catch (reason) {
      setBindingError(reason instanceof Error ? reason.message : "助理会话设置失败");
      return false;
    } finally { setBindingBusy(false); }
  }

  const refreshing = mail?.refreshStatus === "refreshing";
  const refreshed = mail?.refreshStatus === "refreshed";
  const viewTabs = (
    <nav className="assistant-view-tabs" aria-label="助理工作台">
      <div className="assistant-view-switch">
        {mail && <button type="button" aria-pressed={displayedView === "conversation"} disabled={!session} onClick={() => setView("conversation")}>对话</button>}
        {mail && <button type="button" aria-pressed={displayedView === "mail"} onClick={() => setView("mail")}>收件</button>}
        {agenda && <button type="button" aria-pressed={displayedView === "agenda"} onClick={() => setView("agenda")}>议程</button>}
      </div>
      {mail && <IconButton label={refreshing ? "正在刷新邮件列表" : refreshed ? "刷新邮件列表（已刷新）" : "刷新邮件列表"}
        className={displayedView === "agenda" ? "assistant-mail-refresh-hidden" : ""}
        disabled={!mail.online || mail.loading || refreshing} aria-busy={refreshing} onClick={mail.refresh}>
        {refreshing ? <LoaderCircle className="is-spinning" size={16} /> : refreshed ? <Check size={16} /> : <RefreshCw size={16} />}
      </IconButton>}
      {mail && displayedView !== "agenda" && <span className="assistant-mail-refresh-status" role="status">
        {refreshing ? "正在刷新邮件列表…" : refreshed ? "邮件列表已刷新" : ""}
      </span>}
      <IconButton label="助理设置" aria-pressed={displayedView === "settings"} onClick={() => setView("settings")}><Settings size={16} /></IconButton>
    </nav>
  );
  const bindingControls = mail && displayedView !== "agenda" && (displayedView === "settings" || !binding?.nativeSessionId || state === "needs-rebind" || state === "missing") && (
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
              ...bindableSessions.map(candidate => ({ value: candidate.sessionId, label: candidate.title || candidate.sessionId })),
            ]}
            onChange={setSelectedId}
          />
        </div>
        <div className="assistant-actions">
          <button type="button" className="primary-button" disabled={!mail.online || bindingBusy || !bindableSessions.some(candidate => candidate.sessionId === selectedId)} onClick={() => { void configureBinding("plugin.assistant-mail.bind", { sessionId: selectedId }); }}>绑定会话</button>
          {!supportsWorkspace && <button type="button" className="secondary-button" disabled={!mail.online || bindingBusy} onClick={() => setCreating(true)}>新建会话</button>}
        </div>
      </div>}
      {supportsWorkspace && workspace && (!workspace.nativeSessionId || workspace.repairFailed || state === "needs-rebind" || state === "missing") && (
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
      {displayedView === "settings" && capabilities.includes("plugin.assistant-mail.triggers.v1") && workspace?.nativeSessionId && binding?.nativeSessionId === workspace.nativeSessionId
        ? <div className="assistant-delivery-setting">
          <label className="toggle-row">
            <span><strong>主动助理</strong></span>
            <input type="checkbox" role="switch" checked={mail.assistant?.automaticDelivery === true}
              disabled={!mail.online || deliveryBusy || bindingBusy || (!mail.assistant?.automaticDelivery && !mail.assistant?.automaticDeliveryAvailable)}
              onChange={event => {
                setDeliveryError(""); setDeliveryBusy(true);
                void mail.request("plugin.assistant-mail.automatic-delivery.set", { sessionId: workspace.nativeSessionId, enabled: event.currentTarget.checked })
                  .then(result => { mailResult(result); })
                  .catch(reason => setDeliveryError(reason instanceof Error ? reason.message : "主动助理设置失败。"))
                  .finally(() => setDeliveryBusy(false));
              }} />
            <i aria-hidden="true" />
          </label>
          {mail.assistant?.automaticDelivery && !mail.assistant.automaticDeliveryAvailable && <p role="status">自动投递已暂停，等待托管会话就绪。</p>}
          {deliveryError && <p role="alert">{deliveryError}</p>}
        </div> : !mail.assistant?.automaticDelivery && <span className="assistant-delivery-disabled">自动投递未启用</span>}
      {binding?.previousSessionIds.length ? <details><summary>以前的会话</summary><ul>{binding.previousSessionIds.map(sessionId => {
        const previous = snapshot?.sessions.find(candidate => candidate.sessionId === sessionId);
        return <li key={sessionId}>{previous ? <button type="button" className="assistant-session-link" onClick={() => onOpenSession(sessionId)}>{previous.title || sessionId}</button> : <span>{sessionId}</span>}</li>;
      })}</ul></details> : null}
    </section>
  );
  const notices = mail && displayedView !== "agenda" && <>
    {workspace?.repairFailed && workspace.nativeSessionId && <p role="alert">托管工作区配置无法恢复。请重新初始化或更换会话。</p>}
    {workspace?.toolIsolation === "warning" && (workspace.unexpectedTools?.length ? (
      <details className="assistant-tool-warning">
        <summary aria-labelledby={toolWarningId}>
          <span id={toolWarningId} role="alert">工具目录超出托管白名单（{workspace.unexpectedTools.length} 项）</span>
        </summary>
        <ul tabIndex={0} aria-label="白名单外工具">
          {workspace.unexpectedTools.map(tool => <li key={tool}><code>{tool}</code></li>)}
        </ul>
      </details>
    ) : <p role="alert">工具目录超出托管白名单</p>)}
    {state === "unavailable" && !workspace?.repairFailed && <p role="status">原生会话暂不可用。</p>}
    {!mail.online && <p role="status">电脑离线，显示已缓存邮件。</p>}
    {!snapshot && binding?.nativeSessionId && <p>绑定会话：{binding.nativeSessionId}</p>}
    {displayedView === "mail" && mail.online && mail.assistant?.history?.failed && <p role="alert">更早邮件读取失败。</p>}
  </>;
  const stage = (openConfiguration?: () => void) => <div className="assistant-page-content">
    {bindingControls}
    {displayedView === "settings" && session && (
      <button type="button" className="assistant-model-settings" aria-label="模型与思考强度" aria-describedby={modelSettingsDescription} aria-haspopup="dialog"
        disabled={!openConfiguration || workspace?.repairFailed === true} onClick={openConfiguration}>
        <span>
          <strong>模型与思考强度</strong>
          <small id={modelSettingsDescription}>
            {formatSessionModelLabel(session)} · {session.effort ? effortLabel(session.effort) : "默认"}
          </small>
        </span>
        <ChevronRight size={16} aria-hidden="true" />
      </button>
    )}
    {displayedView === "settings" && usage && usage.totalTokens > 0 && <dl className="assistant-context-usage">
      <dt>上下文窗口</dt><dd>{formatContextTokens(usage.totalTokens)}
        {usage.maxTokens ? ` / ${formatContextTokens(usage.maxTokens)}` : ""} tokens</dd>
    </dl>}
    {notices}
    {displayedView === "settings" && mail && capabilities.includes("plugin.assistant-mail.account.v1") && <MailAccounts
      accounts={mail.assistant?.accounts ?? []}
      configUnavailable={mail.assistant?.accountConfigError === "mail_account_config_unavailable"}
      credentialsSupported={mail.assistant?.credentialsSupported === true}
      online={mail.online}
      supportsPolling={capabilities.includes("plugin.assistant-mail.polling.v1")}
      request={mail.request}
    />}
    {displayedView === "settings" && agenda && <AgendaSources />}
    {displayedView === "agenda" && agenda && <AgendaView tab={agendaTab} onTabChange={setAgendaTab} />}
    {displayedView === "mail" && mail && <>
      {!session && binding?.nativeSessionId && <MailReference sessionId={binding.nativeSessionId} />}
      <div className="assistant-mail-list" aria-label="邮件输入">{mail.cache.cards.map(card => <MailCard key={card.mailRefId} card={card} onDiscuss={() => setView("conversation")} />)}</div>
      {!mail.cache.cards.length && <p className="assistant-mail-empty" role="status">{mail.loading ? "正在读取邮件…" : "暂无已记录邮件"}</p>}
      {mail.hasOlderMail && <button type="button" className="secondary-button assistant-mail-older" disabled={!mail.online || mail.loading} onClick={() => void mail.loadOlder()}>{mail.loading ? "正在读取…" : "更早邮件"}</button>}
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
    {mail?.error && displayedView !== "agenda" && <div className="assistant-page-content assistant-mail-feedback">
      <p role="alert">{mail.error}</p>
    </div>}
    {session ? <>
      {displayedView === "conversation" && <div className="assistant-page-content">{bindingControls}{notices}</div>}
      <div className="assistant-conversation">{renderConversation(session.sessionId, {
        alternateStage: displayedView === "conversation" ? undefined : stage,
        hideComposer: displayedView === "settings" || displayedView === "agenda" || workspace?.repairFailed === true,
      })}</div>
    </> : stage()}
    {creating && snapshot && mail && <SessionCreateDialog snapshot={snapshot} connected={mail.online}
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
const RECEIVER_ERRORS = new Map([
  ["mail_authentication_failed", { label: "密码错误", state: "error" }],
  ["mail_credentials_unavailable", { label: "凭据不可用", state: "error" }],
  ["mail_idle_unsupported", { label: "不支持持续收件", state: "unsupported" }],
]);

function MailAccounts({ accounts, configUnavailable, credentialsSupported, online, supportsPolling, request }: {
  accounts: BridgeMailAccount[];
  configUnavailable: boolean;
  credentialsSupported: boolean;
  online: boolean;
  supportsPolling: boolean;
  request: AssistantRequest;
}) {
  const headingId = useId();
  const [action, setAction] = useState<{ kind: "add" } | { kind: "edit" | "remove"; accountKey: string }>();
  const [busy, setBusy] = useState(false);
  const [pendingInterval, setPendingInterval] = useState<{ accountKey: string; value: string }>();
  const [error, setError] = useState("");
  const disabled = !online || configUnavailable || !credentialsSupported || busy;
  const editedAccount = action?.kind === "edit" ? accounts.find(account => account.accountKey === action.accountKey) : undefined;
  const removedAccount = action?.kind === "remove" ? accounts.find(account => account.accountKey === action.accountKey) : undefined;

  async function update(method: BridgeMethod, params: Record<string, unknown>) {
    setBusy(true);
    setError("");
    try {
      mailResult(await request(method, params));
      if (method !== "plugin.assistant-mail.account.set-poll-interval") setAction(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "邮箱账号设置失败");
    } finally {
      setPendingInterval(undefined);
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
    {configUnavailable ? <p role="alert">无法读取邮箱配置。修复本机配置后重启 Bridge。</p>
      : !credentialsSupported ? <p role="status">当前电脑不支持存储邮箱凭据。</p>
      : !accounts.length && !action && <p>尚未添加邮箱。</p>}
    {accounts.map(account => {
      const state = account.enabled ? account.state : "disabled";
      const failure = account.enabled && account.errorCode ? RECEIVER_ERRORS.get(account.errorCode) : undefined;
      const status = supportsPolling && state === "connected"
        ? account.receivingMode === "polling" ? "轮询中" : "已连接（IDLE）"
        : supportsPolling && account.errorCode === "mail_idle_unsupported" && state === "unsupported"
          ? "不支持持续收件，轮询已关闭"
          : failure?.label ?? RECEIVER_LABELS[state];
      return <div className="assistant-account-row" key={account.accountKey}>
        <div className="assistant-account-identity">
          <strong>{account.user}</strong>
          <span>{account.host}:{account.port}</span>
        </div>
        <span className="assistant-account-state" data-state={failure?.state ?? state}>{status}</span>
        <div className="assistant-actions assistant-account-actions">
          <button type="button" className="assistant-session-link" aria-label={`更新密码：${account.user}`} disabled={disabled} onClick={() => { setError(""); setAction({ kind: "edit", accountKey: account.accountKey }); }}>更新密码</button>
          <button type="button" className="assistant-session-link" aria-label={`${account.enabled ? "停用" : "启用"}：${account.user}`} disabled={disabled} onClick={() => { void update("plugin.assistant-mail.account.set-enabled", { accountKey: account.accountKey, enabled: !account.enabled }); }}>{account.enabled ? "停用" : "启用"}</button>
          <button type="button" className="assistant-session-link assistant-remove" aria-label={`移除：${account.user}`} disabled={disabled} onClick={() => { setError(""); setAction({ kind: "remove", accountKey: account.accountKey }); }}>移除</button>
        </div>
        {supportsPolling && account.pollIntervalSeconds !== undefined && <label className="assistant-account-polling">
          备用轮询间隔
          <select value={pendingInterval?.accountKey === account.accountKey ? pendingInterval.value : account.pollIntervalSeconds ?? "off"} disabled={disabled}
            aria-label={`备用轮询间隔：${account.user} (${account.host}:${account.port})`}
            onChange={event => {
              const value = event.currentTarget.value;
              setPendingInterval({ accountKey: account.accountKey, value });
              void update("plugin.assistant-mail.account.set-poll-interval", { accountKey: account.accountKey, pollIntervalSeconds: value === "off" ? null : Number(value) });
            }}>
            <option value="off">关闭</option>
            {MAIL_POLL_INTERVALS.map(seconds => <option key={seconds} value={seconds}>{seconds < 60 ? `${seconds} 秒` : `${seconds / 60} 分钟`}</option>)}
          </select>
        </label>}
      </div>;
    })}
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
