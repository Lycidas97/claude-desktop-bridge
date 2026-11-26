import type { BridgeActionProposal, MailProposalAction, MailProposalDraft } from "@bridge/protocol";
import { useEffect, useId, useState, type FormEvent } from "react";
import { formatBytes } from "../../lib/media-preview.js";
import { registerMobileBackHandler } from "../../lib/mobile-back-navigation.js";
import { Sheet } from "../common/Sheet.js";
import { mailResult } from "./AssistantMailProvider.js";
import { proposalRef, useAssistantProposals } from "./AssistantProposalProvider.js";

export function MailProposalSheet({ proposal, action, mode, stale, mobile, onClose, onDone }: {
  proposal: BridgeActionProposal; action: MailProposalAction; mode: "send" | "edit" | "view"; stale: boolean; mobile: boolean;
  onClose(): void; onDone(result: BridgeActionProposal): void;
}) {
  const controller = useAssistantProposals()!;
  const formId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const editing = mode === "edit";
  const readOnly = mode === "view";
  const disabled = busy || stale || !controller.online;
  useEffect(() => {
    if (mobile) return registerMobileBackHandler(() => { if (!busy) onClose(); return true; }, 150);
  }, [mobile, busy, onClose]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled) return;
    setBusy(true);
    setError("");
    const ref = proposalRef(proposal);
    try {
      let params: Record<string, unknown> = { ...ref, confirmMail: true, ...(action.attachments?.length ? { confirmMailAttachments: true } : {}) };
      if (editing) {
        const data = new FormData(event.currentTarget);
        const fields = {
          accountKey: action.accountKey, to: String(data.get("to")).split(/[,\n]/u).map(value => value.trim()).filter(Boolean),
          cc: String(data.get("cc")).split(/[,\n]/u).map(value => value.trim()).filter(Boolean),
          replyTo: String(data.get("replyTo")).trim() || undefined, subject: String(data.get("subject")), bodyText: String(data.get("bodyText")),
        };
        const revised: MailProposalDraft = action.kind === "mail.reply" ? { ...fields, kind: action.kind, mailRefId: action.mailRefId } : { ...fields, kind: action.kind };
        params = { ...ref, action: revised };
      }
      const { proposal: result } = mailResult<{ proposal: BridgeActionProposal }>(await controller.request(editing ? "assistant.proposal.revise" : "assistant.proposal.commit", params));
      onDone(result);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法处理邮件提案。");
    } finally {
      setBusy(false);
      controller.refresh();
    }
  }

  return <Sheet title={readOnly ? "邮件提案记录" : editing ? "编辑邮件提案" : "核对并发送"} manageFocus busy={busy} onClose={onClose} footer={readOnly ? undefined : <>
    <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button>
    <button type="submit" className="primary-button" form={formId} disabled={disabled}>
      {busy ? (editing ? "正在保存…" : "正在发送…") : editing ? "保存新版本" : "确认立即发出"}
    </button>
  </>}>
    <form id={formId} className={`mail-proposal-sheet${editing ? " agenda-form" : ""}`} onSubmit={readOnly ? undefined : event => void submit(event)}>
      {!readOnly && !busy && stale && <p role="status">提案已更新或处理。关闭后重新核对。</p>}
      <dl className="proposal-fields">
        <dt>发件账号</dt><dd>{proposal.sourceLabel}</dd>
        <dt>发件人</dt><dd>{action.from}</dd>
        <dt>版本</dt><dd>{proposal.revision}</dd>
        {!editing && <>
          <dt>收件人 (To)</dt><dd>{action.to.join("\n")}</dd>
          <dt>抄送 (Cc)</dt><dd>{action.cc.join("\n") || "无"}</dd>
          {action.replyTo && <><dt>回复地址</dt><dd>{action.replyTo}</dd></>}
        </>}
        {action.attachments?.length ? <><dt>附件</dt><dd>
          {action.attachments.map(({ filename, size }, index) => <div key={index}><bdi>{filename}</bdi> · {formatBytes(size)}</div>)}
        </dd></> : null}
      </dl>
      {action.kind === "mail.reply" && action.replyToDiffers && <aside className="mail-proposal-address-warning" data-foreign={action.foreignReplyTo}>
        <strong>{action.foreignReplyTo ? "原信的 Reply-To 来自不同域名" : "原信的 Reply-To 与 From 不同"}</strong>
        <dl className="proposal-fields">
          <dt>原信 From</dt><dd>{action.originalFrom.join("\n") || "未知"}</dd>
          <dt>原信 Reply-To</dt><dd>{action.originalReplyTo.join("\n")}</dd>
        </dl>
      </aside>}
      {editing ? <fieldset disabled={disabled}>
        <label><span id={`${formId}-to`}>收件人 (To)</span><textarea name="to" aria-labelledby={`${formId}-to`} required defaultValue={action.to.join("\n")} /></label>
        <label><span id={`${formId}-cc`}>抄送 (Cc)</span><textarea name="cc" aria-labelledby={`${formId}-cc`} defaultValue={action.cc.join("\n")} /></label>
        <label>回复地址<input name="replyTo" type="email" defaultValue={action.replyTo} /></label>
        <label>主题<input name="subject" maxLength={500} defaultValue={action.subject} /></label>
        <label><span id={`${formId}-body`}>正文</span><textarea name="bodyText" aria-labelledby={`${formId}-body`} required maxLength={8000} defaultValue={action.bodyText} /></label>
      </fieldset> : <section className="mail-proposal-letter" aria-label="最终邮件">
        <h3>{action.subject || "（无主题）"}</h3>
        <p>{action.bodyText}</p>
      </section>}
      {error && <p role="alert">{error}</p>}
      {mode === "send" && !error && !stale && <p className="proposal-card-source">发出后无法撤回。</p>}
    </form>
  </Sheet>;
}
