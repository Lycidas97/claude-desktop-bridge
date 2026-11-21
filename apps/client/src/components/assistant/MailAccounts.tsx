import { MAIL_POLL_INTERVALS, type BridgeMailAccount, type BridgeMethod } from "@bridge/protocol";
import { useEffect, useId, useState, type FormEvent } from "react";
import { registerMobileBackHandler } from "../../lib/mobile-back-navigation.js";
import { ConfirmationDialog } from "../common/ConfirmationDialog.js";
import { mailResult, type AssistantRequest } from "./AssistantMailProvider.js";

const RECEIVER_LABELS: Record<BridgeMailAccount["state"], string> = {
  disabled: "已停用", connecting: "连接中", connected: "已连接", reconnecting: "重连中",
  unsupported: "不支持", error: "连接失败", closed: "未连接",
};
const RECEIVER_ERRORS = new Map([
  ["mail_authentication_failed", { label: "密码错误", state: "error" }],
  ["mail_credentials_unavailable", { label: "凭据不可用", state: "error" }],
  ["mail_idle_unsupported", { label: "不支持持续收件", state: "unsupported" }],
]);

export function MailAccounts({ accounts, configUnavailable, credentialsSupported, online, supportsPolling, supportsSmtp, supportsSharedAuth, supportsKeepCredential, request }: {
  accounts: BridgeMailAccount[];
  configUnavailable: boolean;
  credentialsSupported: boolean;
  online: boolean;
  supportsPolling: boolean;
  supportsSmtp: boolean;
  supportsSharedAuth: boolean;
  supportsKeepCredential: boolean;
  request: AssistantRequest;
}) {
  const headingId = useId();
  const [action, setAction] = useState<{ kind: "add" } | { kind: "edit" | "share" | "remove" | "smtp"; accountKey: string }>();
  const [busy, setBusy] = useState(false);
  const [pendingInterval, setPendingInterval] = useState<{ accountKey: string; value: string }>();
  const [error, setError] = useState("");
  const disabled = !online || configUnavailable || !credentialsSupported || busy;
  const editedAccount = action?.kind === "edit" || action?.kind === "share" ? accounts.find(account => account.accountKey === action.accountKey) : undefined;
  const hasSeparateSmtp = supportsSharedAuth && !!editedAccount?.smtp && !editedAccount.smtpSharedAuth;
  const showSharedSmtp = supportsSharedAuth && (!hasSeparateSmtp || action?.kind === "share");
  const smtpAccount = action?.kind === "smtp" ? accounts.find(account => account.accountKey === action.accountKey) : undefined;
  const removedAccount = action?.kind === "remove" ? accounts.find(account => account.accountKey === action.accountKey) : undefined;
  useEffect(() => {
    if (!removedAccount) return;
    return registerMobileBackHandler(() => {
      if (!busy) setAction(undefined);
      return true;
    }, 200);
  }, [removedAccount, busy]);

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
    const smtpHost = String(data.get("smtpHost") ?? "").trim();
    const user = editedAccount?.user ?? String(data.get("user")).trim();
    const smtp = smtpHost || smtpAccount || (showSharedSmtp && editedAccount?.smtp) ? { host: smtpHost, port: Number(data.get("smtpPort")), security: data.get("security"),
      from: String(data.get("from")).trim() || user } : undefined;
    if (smtpAccount) {
      void update("plugin.assistant-mail.account.set-smtp", { accountKey: smtpAccount.accountKey, smtp: {
        ...smtp, user, credential,
      } });
    } else if (editedAccount) {
      void update(supportsSharedAuth ? "plugin.assistant-mail.account.save" : "plugin.assistant-mail.account.update-credential",
        { accountKey: editedAccount.accountKey, ...(credential ? { credential } : {}), ...(smtp ? { smtp } : {}) });
    } else {
      const port = data.get("port");
      void update(supportsSharedAuth ? "plugin.assistant-mail.account.save" : "plugin.assistant-mail.account.add",
        { host: String(data.get("host")).trim(), user, ...(port ? { port: Number(port) } : {}), credential, ...(smtp ? { smtp } : {}) });
    }
  }

  const accountForm = <form key={action?.kind} onSubmit={save} autoComplete="off"
    aria-label={editedAccount ? `${supportsSharedAuth ? "账号设置" : "更新密码"}：${editedAccount.user}` : "添加邮箱"}>
    <fieldset className="assistant-account-form" disabled={disabled}>
      {!editedAccount && <>
        <legend>添加邮箱</legend>
        <label>邮箱地址<input name="user" required inputMode="email" autoCapitalize="none" spellCheck={false} /></label>
        <div className="assistant-account-server">
          <label>IMAP 服务器<input name="host" required autoCapitalize="none" spellCheck={false} /></label>
          <label>端口<input name="port" type="number" min={1} max={65535} placeholder="993" /></label>
        </div>
      </>}
      {showSharedSmtp
        ? <SmtpFields account={editedAccount} shared allowKeepCredential={supportsKeepCredential && editedAccount?.smtpSharedAuth === true} />
        : <label>密码<input name="credential" type="password" autoComplete="new-password" required /></label>}
      <div className="assistant-actions">
        <button type="button" className="secondary-button" onClick={() => { setError(""); setAction(undefined); }}>取消</button>
        {hasSeparateSmtp && action?.kind !== "share" && <button type="button" className="secondary-button"
          onClick={() => { setError(""); setAction({ kind: "share", accountKey: editedAccount.accountKey }); }}>改为共用授权</button>}
        {supportsSharedAuth && editedAccount?.smtp && <button type="button" className="secondary-button"
          onClick={() => void update("plugin.assistant-mail.account.set-smtp", { accountKey: editedAccount.accountKey, smtp: null })}>关闭发信</button>}
        <button type="submit" className="primary-button">{!editedAccount ? "添加账号" : action?.kind === "share" ? "保存并共用授权"
          : hasSeparateSmtp ? "保存收信密码" : supportsSharedAuth ? "保存设置" : "保存密码"}</button>
      </div>
    </fieldset>
  </form>;

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
        ? account.receivingMode === "polling" ? "定时轮询" : "实时接收"
        : supportsPolling && account.errorCode === "mail_idle_unsupported" && state === "unsupported"
          ? "不支持持续收件，轮询已关闭"
          : failure?.label ?? RECEIVER_LABELS[state];
      return <div className="assistant-account-row" key={account.accountKey}>
        <div className="assistant-account-identity">
          <strong>{account.user}</strong>
          <span>{account.host}:{account.port}</span>
          {supportsSharedAuth && account.smtp && <>
            <span>SMTP {account.smtp.host}:{account.smtp.port}</span>
            {!account.smtpSharedAuth && <span>发信使用独立授权</span>}
          </>}
        </div>
        <span className="assistant-account-state" data-state={failure?.state ?? state}>{status}</span>
        <div className="assistant-actions assistant-account-actions">
          <button type="button" className="assistant-session-link" aria-label={`${supportsSharedAuth ? "账号设置" : "更新密码"}：${account.user}`}
            aria-expanded={editedAccount?.accountKey === account.accountKey} disabled={disabled}
            onClick={() => { setError(""); setAction({ kind: "edit", accountKey: account.accountKey }); }}>{supportsSharedAuth ? "账号设置" : "更新密码"}</button>
          <button type="button" className="assistant-session-link" aria-label={`${account.enabled ? "停用" : "启用"}：${account.user}`} disabled={disabled} onClick={() => { void update("plugin.assistant-mail.account.set-enabled", { accountKey: account.accountKey, enabled: !account.enabled }); }}>{account.enabled ? "停用" : "启用"}</button>
          {supportsSmtp && !supportsSharedAuth && <button type="button" className="assistant-session-link" disabled={disabled}
            aria-label={`${account.smtp ? "SMTP 已配置" : "配置 SMTP"}：${account.user}`} aria-expanded={smtpAccount?.accountKey === account.accountKey}
            onClick={() => { setError(""); setAction({ kind: "smtp", accountKey: account.accountKey }); }}>
            {account.smtp ? "SMTP 已配置" : "配置 SMTP"}
          </button>}
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
        {editedAccount?.accountKey === account.accountKey && accountForm}
        {smtpAccount?.accountKey === account.accountKey && <form key="smtp" onSubmit={save} autoComplete="off" aria-label={`${account.user} 的发信设置`}>
          <fieldset className="assistant-account-form" disabled={disabled}>
            <SmtpFields account={account} shared={false} />
            <label>SMTP 密码<input name="credential" type="password" autoComplete="new-password" required /></label>
            <div className="assistant-actions">
              <button type="button" className="secondary-button" onClick={() => { setError(""); setAction(undefined); }}>取消</button>
              {account.smtp && <button type="button" className="secondary-button" onClick={() => void update("plugin.assistant-mail.account.set-smtp", { accountKey: account.accountKey, smtp: null })}>关闭发信</button>}
              <button type="submit" className="primary-button">保存发信设置</button>
            </div>
          </fieldset>
        </form>}
      </div>;
    })}
    {action?.kind === "add" && accountForm}
    <ConfirmationDialog
      open={Boolean(removedAccount)}
      title="移除邮箱？"
      description={`移除「${removedAccount?.user ?? ""}」？已收取的邮件仍可查看。`}
      error={removedAccount ? error : undefined}
      confirmLabel="确认移除"
      danger
      busy={busy}
      confirmDisabled={disabled}
      onCancel={() => { setError(""); setAction(undefined); }}
      onConfirm={() => { if (removedAccount) void update("plugin.assistant-mail.account.remove", { accountKey: removedAccount.accountKey }); }}
    />
    {error && !removedAccount && <p role="alert">{error}</p>}
  </section>;
}

function SmtpFields({ account, shared, allowKeepCredential }: { account: BridgeMailAccount | undefined; shared: boolean; allowKeepCredential?: boolean }) {
  const [host, setHost] = useState(account?.smtp?.host ?? "");
  const [port, setPort] = useState(String(account?.smtp?.port ?? 465));
  const [security, setSecurity] = useState<string>(account?.smtp?.security ?? "tls");
  const disabled = shared && !host.trim();
  const fields = <>
    <div className="assistant-account-server">
      <label>SMTP 服务器<input name="smtpHost" required={!shared || !!account?.smtp} value={host} onChange={event => setHost(event.target.value)} autoCapitalize="none" spellCheck={false} /></label>
      <label>端口<input name="smtpPort" aria-label={shared ? "SMTP 端口" : undefined} type="number" required disabled={disabled} min={1} max={65535} value={port} onChange={event => setPort(event.target.value)} /></label>
    </div>
    <label>加密方式<select name="security" disabled={disabled} value={security} onChange={event => {
      const next = event.currentTarget.value;
      const startTls = next === "starttls";
      if (port === (startTls ? "465" : "587")) setPort(startTls ? "587" : "465");
      setSecurity(next);
    }}>
      <option value="tls">TLS</option><option value="starttls">STARTTLS</option>
    </select></label>
    {!shared && <label>登录名<input name="user" required defaultValue={account?.smtp?.user ?? account?.user} autoCapitalize="none" spellCheck={false} /></label>}
    <label>发件地址<input name="from" type="email" required={!shared} disabled={disabled} defaultValue={account?.smtp?.from ?? (shared ? undefined : account?.user)}
      placeholder={shared ? "默认使用邮箱地址" : undefined} /></label>
  </>;
  if (!shared) return fields;
  const smtp = account?.smtp;
  const keepCredential = allowKeepCredential && smtp && smtp.host === host.trim().toLowerCase() && smtp.port === Number(port) && smtp.security === security;
  return <>
    <label>密码<input name="credential" type="password" autoComplete="new-password" required={!keepCredential}
      placeholder={keepCredential ? "留空不修改" : undefined} /></label>
    <fieldset className="assistant-smtp-fields">
      <legend>{smtp ? "发信" : "发信（选填）"}</legend>
      {fields}
    </fieldset>
  </>;
}
