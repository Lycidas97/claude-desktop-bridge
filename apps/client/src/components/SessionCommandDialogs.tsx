import type { BridgePermissionRules, BridgeSDKPermissionMode, BridgeSessionCommandResult, BridgeSessionInfo, BridgeSessionPermissions } from "@bridge/protocol";
import { LoaderCircle, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { registerMobileBackHandler } from "../lib/mobile-back-navigation.js";
import { IconButton } from "./IconButton.js";

const DIALOG_TITLES: Partial<Record<BridgeSessionCommandResult["action"], string>> = { help: "会话命令", permissions: "会话权限", resume: "恢复会话", rename: "重命名会话" };
const MODE_LABELS: Record<BridgeSDKPermissionMode, string> = { default: "标准授权", acceptEdits: "自动接受编辑", plan: "计划模式", dontAsk: "仅允许已批准", auto: "自动判断", bypassPermissions: "完全授权" };
const MODES: BridgeSDKPermissionMode[] = ["default", "acceptEdits", "plan", "dontAsk", "auto", "bypassPermissions"];
const RULES = ["allow", "ask", "deny"] as const;

export interface SessionPermissionsActions {
  onLoadPermissions(): Promise<BridgeSessionPermissions>;
  onSavePermissions(mode: BridgeSDKPermissionMode, rules: BridgePermissionRules): Promise<BridgeSessionPermissions>;
}

export function SessionPermissionsEditor({ onLoadPermissions, onSavePermissions, onClose }: SessionPermissionsActions & { onClose(): void }) {
  const [permissions, setPermissions] = useState<BridgeSessionPermissions>();
  const [mode, setMode] = useState<BridgeSDKPermissionMode>("default");
  const [rules, setRules] = useState({ allow: "", ask: "", deny: "" });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const mounted = useRef(true);
  useEffect(() => {
    let active = true;
    mounted.current = true;
    void onLoadPermissions().then(next => {
      if (!active) return;
      setPermissions(next);
      setMode(next.mode);
      setRules({ allow: next.rules.allow.join("\n"), ask: next.rules.ask.join("\n"), deny: next.rules.deny.join("\n") });
    }).catch(reason => {
      if (active) setError(reason instanceof Error ? reason.message : "权限读取失败");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; mounted.current = false; };
  }, []);

  async function save(): Promise<void> {
    setSaving(true);
    setError(undefined);
    try {
      await onSavePermissions(mode, {
        allow: rules.allow.split("\n").map(line => line.trim()).filter(Boolean),
        ask: rules.ask.split("\n").map(line => line.trim()).filter(Boolean),
        deny: rules.deny.split("\n").map(line => line.trim()).filter(Boolean),
      });
      if (mounted.current) onClose();
    } catch (reason) {
      if (!mounted.current) return;
      const failure = reason instanceof Error ? reason.message : "权限保存失败";
      setError(failure);
      try {
        // A mode change may have succeeded before replacement of the rules failed.
        const current = await onLoadPermissions();
        if (mounted.current) setPermissions(current);
      } catch (readError) {
        if (mounted.current) {
          setPermissions(undefined);
          setError(`${failure}；当前权限状态读取失败：${readError instanceof Error ? readError.message : "读取失败"}`);
        }
      }
    } finally {
      if (mounted.current) setSaving(false);
    }
  }

  return <div className="session-permissions-editor">
    <div className="session-command-body">
    {loading ? <div className="session-configuration-loading"><LoaderCircle className="is-spinning" size={18} />正在读取会话权限</div> : permissions && <>
      <div className="session-permission-status">当前生效：{MODE_LABELS[permissions.mode]}</div>
      <label className="session-model-field"><span>权限模式</span>
        <select value={mode} disabled={!permissions.canConfigure || saving} onChange={event => setMode(event.target.value as BridgeSDKPermissionMode)}>
          {MODES.map(value => <option key={value} value={value}>{MODE_LABELS[value]}</option>)}
        </select>
      </label>
      <fieldset className="session-permission-field"><legend>当前会话覆盖 · 每行一条规则</legend>
        {RULES.map(kind => <label className="session-model-field" key={kind}><span>{kind}</span>
          <textarea aria-label={`会话 ${kind} 规则`} rows={3} value={rules[kind]} disabled={!permissions.canConfigure || saving}
            onChange={event => setRules(current => ({ ...current, [kind]: event.target.value }))} />
        </label>)}
      </fieldset>
      {RULES.some(kind => permissions.inheritedRules[kind].length > 0) && <details className="session-permission-field"><summary>继承的规则</summary>
        {RULES.filter(kind => permissions.inheritedRules[kind].length > 0).map(kind => <div key={kind}><strong>{kind}</strong><pre>{permissions.inheritedRules[kind].join("\n")}</pre></div>)}
      </details>}
      <p className="session-configuration-notice">仅作用于当前会话，不写入个人或项目设置。</p>
      {permissions.unavailableReason && <div className="session-configuration-notice">{permissions.unavailableReason}</div>}
    </>}
    </div>
    {error && <div className="session-configuration-error" role="alert">{error}</div>}
    <footer>
      <button type="button" className="secondary-button" disabled={saving} onClick={onClose}>取消</button>
      <button type="button" className="primary-button" disabled={loading || saving || !permissions?.canConfigure} onClick={() => void save()}>
        {saving && <LoaderCircle className="is-spinning" size={16} />}保存权限
      </button>
    </footer>
  </div>;
}

export function SessionCommandDialogs({ result, session, onClose, onOpenSession, onRename, onLoadPermissions, onSavePermissions }: {
  result: BridgeSessionCommandResult | undefined;
  session: BridgeSessionInfo;
  onClose(): void;
  onOpenSession(sessionId: string): Promise<void>;
  onRename?(title: string): Promise<void>;
} & SessionPermissionsActions) {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState(session.title);
  useEffect(() => { setError(undefined); setTitle(session.title); }, [result]);
  useEffect(() => {
    if (!result) return;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) { event.stopPropagation(); onClose(); } };
    document.addEventListener("keydown", escape);
    const unregister = registerMobileBackHandler(() => { if (!busy) onClose(); return true; }, 145);
    return () => { document.removeEventListener("keydown", escape); unregister(); };
  }, [result, busy]);
  if (!result) return null;
  async function open(sessionId: string): Promise<void> {
    setBusy(true);
    try { await onOpenSession(sessionId); onClose(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "会话打开失败"); }
    finally { setBusy(false); }
  }
  async function rename(): Promise<void> {
    if (!onRename || !title.trim()) return;
    setBusy(true);
    try { await onRename(title.trim()); onClose(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "重命名失败"); }
    finally { setBusy(false); }
  }
  return <div className="modal-backdrop session-configuration-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="session-configuration-dialog session-command-dialog" role="dialog" aria-modal="true" aria-label={DIALOG_TITLES[result.action] ?? "命令结果"}>
      <header><h2>{DIALOG_TITLES[result.action] ?? "命令结果"}</h2>
        <IconButton label="关闭" disabled={busy} onClick={onClose}><X size={19} /></IconButton></header>
      {result.action === "help" && <div className="session-command-list">
        {result.catalog?.commands.map(command => <div className="session-command-entry" key={command.name} aria-disabled={Boolean(command.unavailableReason)}>
          <span className="slash-command-name"><strong>/{command.name}</strong>{command.argumentHint && <small>{command.argumentHint}</small>}</span>
          <span>{command.description}</span>
          {command.aliases?.length ? <small>{command.aliases.map(alias => `/${alias}`).join(" · ")}</small> : null}
          {command.unavailableReason && <small>{command.unavailableReason}</small>}
        </div>)}
        {result.catalog?.warnings?.map(warning => <p className="slash-command-warning" key={warning}>{warning}</p>)}
      </div>}
      {result.action === "resume" && <div className="session-command-list">
        {result.sessions?.length ? result.sessions.map(candidate => <button type="button" className="session-command-entry secondary-button" key={candidate.sessionId} disabled={busy} onClick={() => void open(candidate.sessionId)}>
          <strong>{candidate.title}</strong><small>{candidate.projectName} · {new Date(candidate.lastActivityAt).toLocaleString()}</small>
        </button>) : <p>没有可恢复的会话</p>}
      </div>}
      {result.action === "permissions" && <SessionPermissionsEditor onLoadPermissions={onLoadPermissions} onSavePermissions={onSavePermissions} onClose={onClose} />}
      {result.action === "rename" && <form onSubmit={event => { event.preventDefault(); void rename(); }}>
        <label className="session-model-field"><span>会话名称</span><input value={title} maxLength={120} autoFocus disabled={busy} onChange={event => setTitle(event.target.value)} /></label>
        <footer><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={busy || !title.trim()}>保存名称</button></footer>
      </form>}
      {result.message && <p className="session-configuration-notice" role="status">{result.message}</p>}
      {error && <div className="session-configuration-error" role="alert">{error}</div>}
    </section>
  </div>;
}
