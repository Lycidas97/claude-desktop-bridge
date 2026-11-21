import { ASSISTANT_MAIL_KEEP_CREDENTIAL_CAPABILITY, ASSISTANT_MAIL_SHARED_AUTH_CAPABILITY, ASSISTANT_SMTP_CAPABILITY, type BridgeActionProposal, type BridgeDirectoryListing, type BridgeHostSnapshot, type BridgeSessionInfo } from "@bridge/protocol";
import { ArrowLeft, Check, ChevronRight, ListChecks, LoaderCircle, RefreshCw, Settings } from "lucide-react";
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { registerMobileBackHandler } from "../../lib/mobile-back-navigation.js";
import { formatSessionModelLabel } from "../../lib/conversation-timeline.js";
import { IconButton } from "../common/IconButton.js";
import { SelectMenu } from "../common/SelectMenu.js";
import type { ConversationViewProps } from "../conversation/ConversationView.js";
import { formatContextTokens } from "../conversation/SessionActivityIndicator.js";
import { MobilePageHeader } from "../mobile/MobilePageHeader.js";
import { effortLabel } from "../session/session-labels.js";
import { SessionCreateDialog } from "../session/SessionCreateDialog.js";
import { mailResult, useAssistantMail } from "./AssistantMailProvider.js";
import { AgendaSources } from "./AgendaSources.js";
import { AgendaView } from "./AgendaView.js";
import { useAssistantAgenda } from "./AssistantAgendaProvider.js";
import { pendingProposalCount, useAssistantProposals } from "./AssistantProposalProvider.js";
import { AssistantAttention } from "./AssistantAttention.js";
import { ProposalPanel } from "./ProposalPanel.js";
import { InboxMailList } from "./InboxMailList.js";
import { MailAccounts } from "./MailAccounts.js";
import { MailCategoryManager } from "./MailCategoryManager.js";
import { MailReference } from "./MailReference.js";
import "./assistant-mail.css";

type AssistantView = "conversation" | "mail" | "filed" | "agenda" | "settings" | "proposals";

export function AssistantPage({ snapshot, mobile = false, active = true, headerLeading, onOpenSession, renderConversation }: {
  snapshot: BridgeHostSnapshot | undefined;
  mobile?: boolean;
  active?: boolean;
  headerLeading?: ReactNode | undefined;
  onOpenSession(sessionId: string): void;
  renderConversation(sessionId: string, stage: Pick<ConversationViewProps, "alternateStage" | "hideComposer" | "assistantReplyTarget">): ReactNode;
}) {
  const mail = useAssistantMail();
  const agenda = useAssistantAgenda();
  const proposals = useAssistantProposals();
  const toolWarningId = useId();
  const modelSettingsDescription = useId();
  // Unset opens the bound conversation, or 收件 while no session is bound.
  const [view, setView] = useState<AssistantView>();
  const [proposalReturn, setProposalReturn] = useState<Exclude<AssistantView, "proposals">>("conversation");
  const [settingsReturn, setSettingsReturn] = useState<Exclude<AssistantView, "settings">>("conversation");
  const [selectedProposal, setSelectedProposal] = useState<BridgeActionProposal>();
  const [replyTarget, setReplyTarget] = useState<ConversationViewProps["assistantReplyTarget"]>();
  const [replyError, setReplyError] = useState("");
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
  function backFromProposals() {
    if (selectedProposal) setSelectedProposal(undefined);
    else setView(proposalReturn);
  }
  useEffect(() => { if (active) { setView(undefined); setSelectedProposal(undefined); setReplyTarget(undefined); setReplyError(""); } }, [active]);
  const supportsFiling = mail?.supportsFiling;
  const backToInbox = () => setView("mail");
  const backFromSettings = () => setView(settingsReturn);
  useEffect(() => {
    if (!active || !mobile) return;
    if (view === "proposals" && proposals) {
      return registerMobileBackHandler(() => { backFromProposals(); return true; }, 110);
    }
    if (view === "filed" && supportsFiling) {
      return registerMobileBackHandler(() => { backToInbox(); return true; }, 110);
    }
    if (view === "settings") {
      return registerMobileBackHandler(() => { backFromSettings(); return true; }, 110);
    }
  }, [active, mobile, view, Boolean(proposals), selectedProposal, proposalReturn, settingsReturn, supportsFiling]);
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
  const displayedView = !view || (view === "conversation" && !mail) || (view === "mail" && !mail) || (view === "agenda" && !agenda)
    || (view === "filed" && !supportsFiling) || (view === "proposals" && !proposals) ? fallbackView : view;
  const filed = displayedView === "filed";
  const filedBack = filed && <IconButton key="filed-back" label="返回收件" autoFocus onClick={backToInbox}>
    <ArrowLeft size={mobile ? 20 : 16} aria-hidden="true" />
  </IconButton>;
  const filedActions = filed && mail?.supportsCategories && <MailCategoryManager categories={mail.categories}
    mobile={mobile} online={mail.online} request={mail.request} />;
  const pendingCount = pendingProposalCount(proposals);
  function openProposals() {
    if (displayedView !== "proposals") { setProposalReturn(displayedView); setSelectedProposal(undefined); }
    setView("proposals");
  }
  function openSettings() {
    if (displayedView !== "settings") setSettingsReturn(displayedView);
    setView("settings");
  }

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
  const showMailFeedback = displayedView !== "agenda" && displayedView !== "proposals";
  const viewTabs = (
    <nav className="assistant-view-tabs" aria-label="助理工作台">
      <div className="assistant-view-switch">
        {mail && <button type="button" aria-pressed={displayedView === "conversation"} onClick={() => setView("conversation")}>对话</button>}
        {mail && <button type="button" aria-pressed={displayedView === "mail"} onClick={() => setView("mail")}>收件</button>}
        {agenda && <button type="button" aria-pressed={displayedView === "agenda"} onClick={() => setView("agenda")}>议程</button>}
      </div>
      {!mobile && proposals && <IconButton label="待确认提案" aria-pressed={displayedView === "proposals"} onClick={openProposals}><ListChecks size={16} /></IconButton>}
      {mail && <IconButton label={refreshing ? "正在刷新邮件列表" : refreshed ? "刷新邮件列表（已刷新）" : "刷新邮件列表"}
        className={showMailFeedback ? "" : "assistant-mail-refresh-hidden"}
        disabled={!mail.online || mail.loading || refreshing} aria-busy={refreshing} onClick={mail.refresh}>
        {refreshing ? <LoaderCircle className="is-spinning" size={16} /> : refreshed ? <Check size={16} /> : <RefreshCw size={16} />}
      </IconButton>}
      {mail && showMailFeedback && <span className="assistant-mail-refresh-status" role="status">
        {refreshing ? "正在刷新邮件列表…" : refreshed ? "邮件列表已刷新" : ""}
      </span>}
      <IconButton label="助理设置" aria-pressed={displayedView === "settings"} onClick={openSettings}><Settings size={16} /></IconButton>
    </nav>
  );
  const bindingControls = mail && displayedView === "settings" && (
    <section className="assistant-binding" aria-label="助理会话绑定">
      <div className="assistant-binding-current">
        {binding?.nativeSessionId ? <button type="button" className="assistant-session-link" onClick={() => setView("conversation")}>{session?.title || binding.nativeSessionId}</button> : <strong>{binding?.previousSessionIds.length ? "重新绑定会话" : "选择助理会话"}</strong>}
        {binding?.nativeSessionId && <button type="button" className="assistant-session-link" onClick={() => setConfiguring(value => !value)}>更换会话</button>}
      </div>
      {(configuring || !binding?.nativeSessionId) && <div className="assistant-binding-form">
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
      {capabilities.includes("plugin.assistant-mail.triggers.v1") && workspace?.nativeSessionId && binding?.nativeSessionId === workspace.nativeSessionId
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
    {state === "needs-rebind" && <p role="status">原会话已归档或删除，请重新绑定。</p>}
    {state === "missing" && <p role="status">未找到绑定会话。连接恢复后可再次核对，或更换会话。</p>}
    {state === "unavailable" && !workspace?.repairFailed && <p role="status">原生会话暂不可用。</p>}
    {!mail.online && <p role="status">电脑离线，显示已缓存邮件。</p>}
    {!snapshot && binding?.nativeSessionId && <p>绑定会话：{binding.nativeSessionId}</p>}
    {displayedView === "mail" && mail.online && mail.assistant?.history?.failed && <p role="alert">更早邮件读取失败。</p>}
  </>;
  const stage = (openConfiguration?: () => void) => displayedView === "proposals" ? <div className="assistant-page-content"><ProposalPanel mobile={mobile} selected={selectedProposal} onSelect={setSelectedProposal} /></div> : <div className="assistant-page-content">
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
    {displayedView === "conversation" && <div className="assistant-unbound">
      {!binding?.nativeSessionId && <p>尚未绑定会话</p>}
      <button type="button" className="primary-button" onClick={openSettings}>前往助理设置</button>
    </div>}
    {displayedView === "settings" && mail && capabilities.includes("plugin.assistant-mail.account.v1") && <MailAccounts
      accounts={mail.assistant?.accounts ?? []}
      configUnavailable={mail.assistant?.accountConfigError === "mail_account_config_unavailable"}
      credentialsSupported={mail.assistant?.credentialsSupported === true}
      online={mail.online}
      supportsPolling={capabilities.includes("plugin.assistant-mail.polling.v1")}
      supportsSmtp={capabilities.includes(ASSISTANT_SMTP_CAPABILITY)}
      supportsSharedAuth={capabilities.includes(ASSISTANT_MAIL_SHARED_AUTH_CAPABILITY)}
      supportsKeepCredential={capabilities.includes(ASSISTANT_MAIL_KEEP_CREDENTIAL_CAPABILITY)}
      request={mail.request}
    />}
    {displayedView === "settings" && agenda && <AgendaSources />}
    {displayedView === "agenda" && agenda && <AgendaView />}
    {(displayedView === "mail" || filed) && mail && <>
      {!filed && !session && binding?.nativeSessionId && <MailReference sessionId={binding.nativeSessionId} />}
      <InboxMailList mail={mail} mobile={mobile} filed={filed} canMarkJunk={!supportsFiling && capabilities.includes("plugin.assistant-mail.junk.v1")}
        onOpenFiled={() => setView("filed")} onDiscuss={() => setView("conversation")} />
    </>}
  </div>;
  return <section className={`assistant-page ${mobile ? "assistant-page-mobile" : "desktop-page"}${session ? " has-conversation" : ""}`}>
    {mobile && (filed ? <MobilePageHeader title="已收纳" leading={filedBack} actions={filedActions || undefined} />
      : displayedView === "proposals" ? <MobilePageHeader title={selectedProposal ? "提案详情" : "待确认提案"} onBack={backFromProposals} />
      : displayedView === "settings" ? <MobilePageHeader title="助理设置" onBack={backFromSettings} />
      : <MobilePageHeader title="助理" {...(headerLeading ? { leading: headerLeading } : {})} actions={viewTabs} />)}
    {!mobile && <div className="assistant-desktop-header-band">
      {headerLeading && <div className="assistant-desktop-leading">{headerLeading}</div>}
      <div className="assistant-page-header-inner">
        <header className="desktop-page-heading">
          {filed ? <><div className="assistant-filed-heading">
            {filedBack}
            <h1>已收纳</h1>
          </div>{filedActions}</> : <><h1>助理</h1>{viewTabs}</>}
        </header>
      </div>
    </div>}
    {mail?.error && showMailFeedback && <div className="assistant-page-content assistant-mail-feedback">
      <p role="alert">{mail.error}</p>
    </div>}
    {proposals && !filed && displayedView !== "proposals" && (mobile || pendingCount > 0) && <div className="assistant-proposal-dock">
      <button type="button" className="permission-dock" data-empty={!pendingCount} onClick={openProposals}>
        <span className="permission-dock-icon"><ListChecks size={18} aria-hidden="true" /></span>
        <span><strong>{pendingCount ? `${pendingCount} 项待你确认` : "提案"}</strong></span>
        <ChevronRight size={16} aria-hidden="true" />
      </button>
    </div>}
    {displayedView === "conversation" && (replyTarget || replyError) && <div className="assistant-page-content assistant-mail-feedback">
      {replyError ? <p role="alert">{replyError}</p> : <p role="status">正在查找回复…</p>}
    </div>}
    {!filed && displayedView !== "proposals" && <AssistantAttention onReply={itemId => {
      setView("conversation"); setReplyError("");
      setReplyTarget({ itemId, done(error) { setReplyTarget(undefined); setReplyError(error ?? ""); } });
    }}
      onTodo={() => { agenda?.setCalendarOnly(false); agenda?.setAllTodosOpen(true); setView("agenda"); }} />}
    {session ? <>
      {displayedView === "conversation" && <div className="assistant-page-content">{notices}</div>}
      <div className="assistant-conversation">{renderConversation(session.sessionId, {
        alternateStage: displayedView === "conversation" ? undefined : stage,
        assistantReplyTarget: replyTarget,
        hideComposer: filed || displayedView === "settings" || displayedView === "agenda" || displayedView === "proposals" || workspace?.repairFailed === true,
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
