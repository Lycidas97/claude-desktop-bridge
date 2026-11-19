import type { BridgeAgendaSource } from "@bridge/protocol";
import { useId, useState, type FormEvent } from "react";
import { ConfirmationDialog } from "../common/ConfirmationDialog.js";
import { Sheet } from "../common/Sheet.js";
import { useAssistantAgenda } from "./AssistantAgendaProvider.js";

const statuses: Record<BridgeAgendaSource["status"], string> = {
  ready: "已就绪", pending: "等待同步", disabled: "已暂停", error: "同步失败",
};
const errors: Record<NonNullable<BridgeAgendaSource["errorCode"]>, string> = {
  credentials: "请检查或更换凭据。", connection: "无法连接日历服务器。", response: "服务器返回了无法读取的日历数据。",
};

type SourceEditor = { type: "add" } | { type: "credential"; source: BridgeAgendaSource };

export function AgendaSources() {
  const agenda = useAssistantAgenda()!;
  const [editor, setEditor] = useState<SourceEditor>();
  const [remove, setRemove] = useState<BridgeAgendaSource>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const formId = useId();
  const supported = agenda.snapshot?.credentialsSupported === true;
  const enabled = agenda.online && !busy;

  async function run(action: () => Promise<void>, onSuccess?: () => void) {
    setBusy(true);
    setError("");
    try {
      await action();
      onSuccess?.();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "日历来源操作失败");
    } finally {
      setBusy(false);
    }
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor || !enabled || !supported) return;
    const form = new FormData(event.currentTarget);
    // Clear the credential field immediately on submission, including a failed request.
    const credential = String(form.get("credential"));
    (event.currentTarget.elements.namedItem("credential") as HTMLInputElement).value = "";
    void run(() => editor.type === "add"
      ? agenda.mutate("plugin.assistant-agenda.source.add", {
          label: String(form.get("label")).trim(), url: String(form.get("url")).trim(), user: String(form.get("user")).trim(), credential,
        })
      : agenda.mutate("plugin.assistant-agenda.source.credential", { id: editor.source.id, credential }),
    () => setEditor(undefined));
  }

  function closeEditor() { setEditor(undefined); setError(""); }
  function closeRemove() { setRemove(undefined); setError(""); }

  return <section className="assistant-accounts agenda-sources" aria-label="日历来源">
    <header className="assistant-accounts-heading">
      <h2>日历来源</h2>
      {supported && <button type="button" className="assistant-session-link" disabled={!enabled} onClick={() => { setError(""); setEditor({ type: "add" }); }}>添加 CalDAV</button>}
    </header>
    {!agenda.online && <p role="status">电脑离线，连接后可管理日历来源。</p>}
    {agenda.snapshot && !supported && <p role="status">此电脑没有可用的系统凭据库。</p>}
    {error && !editor && !remove && <p role="alert">{error}</p>}
    {agenda.snapshot?.sources.map(source => <article key={source.id} className="assistant-account-row agenda-source-row" aria-label={source.label}>
      <div className="assistant-account-identity">
        <strong>{source.label}</strong>
        {source.errorCode && <span>{errors[source.errorCode]}</span>}
      </div>
      <span className="assistant-account-state" data-state={source.status === "error" ? "error" : source.status === "ready" ? "connected" : undefined}>{statuses[source.status]}</span>
      {source.configurable && <div className="assistant-actions assistant-account-actions">
        {supported && <button type="button" className="assistant-session-link" disabled={!enabled} onClick={() => { setError(""); setEditor({ type: "credential", source }); }}>更换凭据</button>}
        <button type="button" className="assistant-session-link" disabled={!enabled || (!source.enabled && !supported)} onClick={() => void run(() => agenda.mutate("plugin.assistant-agenda.source.enable", { id: source.id, enabled: !source.enabled }))}>{source.enabled ? "暂停" : "恢复"}</button>
        <button type="button" className="assistant-session-link" disabled={!enabled || !source.enabled || !supported} onClick={() => void run(() => agenda.mutate("plugin.assistant-agenda.source.refresh", { id: source.id }))}>刷新</button>
        <button type="button" className="assistant-session-link assistant-remove" disabled={!enabled} onClick={() => { setError(""); setRemove(source); }}>移除</button>
      </div>}
    </article>)}
    {editor && <Sheet title={editor.type === "add" ? "添加 CalDAV" : "更换凭据"} busy={busy} manageFocus onClose={closeEditor} footer={<>
      <button type="button" className="secondary-button" disabled={busy} onClick={closeEditor}>取消</button>
      <button type="submit" className="primary-button" form={formId} disabled={!enabled || !supported}>{editor.type === "add" ? "添加来源" : "保存凭据"}</button>
    </>}>
      <form id={formId} className="agenda-form" onSubmit={save}>
        <fieldset disabled={busy}>
          {editor.type === "add" && <>
            <label>名称<input name="label" required maxLength={500} /></label>
            <label>CalDAV 地址<input name="url" type="url" required maxLength={1500} placeholder="https://" /></label>
            <label>用户名<input name="user" required maxLength={320} autoComplete="off" /></label>
          </>}
          <label>凭据<input name="credential" type="password" required maxLength={1024} autoComplete="new-password" /></label>
        </fieldset>
        {error && <p role="alert">{error}</p>}
      </form>
    </Sheet>}
    {remove && <ConfirmationDialog open danger busy={busy} confirmDisabled={!agenda.online} title="移除日历来源？"
      description={`移除「${remove.label}」及其同步到助理的记录。远端数据会保留。`} error={error} confirmLabel="确认移除" onCancel={closeRemove}
      onConfirm={() => void run(() => agenda.mutate("plugin.assistant-agenda.source.remove", { id: remove.id }), closeRemove)} />}
  </section>;
}
