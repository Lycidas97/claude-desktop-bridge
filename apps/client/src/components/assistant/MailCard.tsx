import { ARTIFACT_MAX_BYTES, mailAttachmentPreviewKind, type BridgeHistoryItem, type BridgeMailAttachment, type BridgeMailCard, type BridgeMailDetail } from "@bridge/protocol";
import { Download, Mail, Paperclip } from "lucide-react";
import { useState } from "react";
import { downloadMailAttachment } from "../../lib/artifact-download.js";
import { formatBytes } from "../../lib/media-preview.js";
import { useMediaPreview, useMediaRequest } from "../evidence/MediaPreviewProvider.js";
import { useAssistantMail } from "./AssistantMailProvider.js";
import "./assistant-mail.css";

export const DELIVERY_LABELS: Record<BridgeMailCard["nativeDelivery"]["state"], string> = {
  "not-submitted": "未提交", pending: "待提交", paused: "已暂停", submitting: "提交中", submitted: "已提交", queued: "排队中",
  observed: "原生已观测", uncertain: "不确定", failed: "失败", cancelled: "已撤回",
};
const PROCESSING_LABELS = { pending: "待处理", processing: "处理中", processed: "已处理" };

function MailAttachmentRow({ attachment, mailRefId, enabled }: { attachment: BridgeMailAttachment; mailRefId: string; enabled: boolean }) {
  const openPreview = useMediaPreview();
  const request = useMediaRequest();
  const [progress, setProgress] = useState<number>();
  const [error, setError] = useState("");
  const { filename, size, mimeType, attachmentId } = attachment;
  const kind = mailAttachmentPreviewKind(mimeType);
  const mailAttachment = { mailRefId, attachmentId };
  const oversized = size > ARTIFACT_MAX_BYTES;
  return <li>
    <div className="assistant-attachment-row">
      {kind ? <button type="button" className="assistant-attachment-name" title={filename} disabled={!enabled || oversized}
        aria-label={`预览 ${filename}`} onClick={() => openPreview({ name: filename, kind, mailAttachment, ...(attachment.charset ? { charset: attachment.charset } : {}) })}>{filename}</button>
        : <span className="assistant-attachment-name" title={filename}>{filename}</span>}
      <span className="assistant-attachment-size" title={mimeType}>{formatBytes(size)}</span>
      <button type="button" className="assistant-attachment-download" aria-label={`下载 ${filename}`} title="下载"
        disabled={!request || !enabled || oversized || progress !== undefined} onClick={() => {
          if (!request) return;
          setError("");
          setProgress(0);
          void downloadMailAttachment(mailAttachment, request, setProgress)
            .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "附件下载失败。"))
            .finally(() => setProgress(undefined));
        }}><Download size={16} aria-hidden="true" /></button>
    </div>
    {oversized && <small>超过 20 MiB 传输上限</small>}
    {progress !== undefined && <small role="status">下载中 {Math.round(progress * 100)}%</small>}
    {error && <small role="alert">{error}</small>}
  </li>;
}

export function MailCard({ card, nativeMessage, onDiscuss, showBatchDelivery = true }: {
  card: BridgeMailCard; nativeMessage?: BridgeHistoryItem; onDiscuss?(): void; showBatchDelivery?: boolean;
}) {
  const mail = useAssistantMail();
  const accountLabel = mail?.accountLabel(card.accountKey) ?? "邮件插件";
  const [detail, setDetail] = useState<BridgeMailDetail>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const attachments = detail?.attachments ?? card.attachments;
  const attachmentCount = detail?.attachmentCount ?? card.attachmentCount ?? attachments?.length;
  const attachmentList = attachments?.length ? <section className="assistant-attachments" aria-label="邮件附件">
    <h4><Paperclip size={14} aria-hidden="true" />{attachmentCount} 个附件</h4>
    <ul>{attachments.map(attachment => <MailAttachmentRow key={attachment.attachmentId} attachment={attachment}
      mailRefId={card.mailRefId} enabled={Boolean(mail?.online && mail.supportsAttachments)} />)}</ul>
    {attachmentCount !== undefined && attachmentCount > attachments.length && <small>仅显示前 {attachments.length} 个附件</small>}
  </section> : null;
  const links = detail ? [...new Set(detail.bodyText.match(/https?:\/\/[^\s<>"']+/gu) ?? [])].filter(href => URL.canParse(href)).map(href => new URL(href)) : [];
  return <article className="assistant-mail-card" data-mail-id={card.mailRefId} data-stream-key={`mail:${card.mailRefId}`} aria-label={`邮件：${card.subject || "无主题"}`}>
    <header><span><Mail size={15} aria-hidden="true" />{accountLabel}</span><time dateTime={card.receivedAt}>{new Date(card.receivedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time></header>
    <h3>{card.subject || "无主题"}</h3>
    <p className="assistant-mail-from">{card.from.map(sender => [sender.name, sender.address].filter(Boolean).join(" ")).join("，") || "未知发件人"}</p>
    {card.preview && <p className="assistant-mail-preview">{card.preview}</p>}
    {card.previewError && <p className="assistant-mail-from" role="status">{card.previewError}</p>}
    <dl className="assistant-mail-status">
      <div><dt>输入</dt><dd>已记录</dd></div>
      {!card.nativeDelivery.batchId || showBatchDelivery ? <div><dt>原生投递</dt><dd>{DELIVERY_LABELS[card.nativeDelivery.state]}</dd></div> : null}
      <div><dt>业务处理</dt><dd>{PROCESSING_LABELS[card.processingStatus]}</dd></div>
    </dl>
    {card.analysis && <details onToggle={event => {
      if (event.currentTarget.open && mail?.attention !== undefined && (card.analysis?.summary || card.analysis?.suggestions?.length || card.analysis?.questions?.length)) mail.markViewed(card);
    }}><summary>分析结果</summary>
      {card.analysis.summary && <pre>{card.analysis.summary}</pre>}
      {card.analysis.suggestions?.length ? <><h4>建议</h4><ul>{card.analysis.suggestions.map((suggestion, index) => <li key={index}>{suggestion}</li>)}</ul></> : null}
      {card.analysis.questions?.length ? <><h4>问题</h4><ul>{card.analysis.questions.map((question, index) => <li key={index}>{question}</li>)}</ul></> : null}
    </details>}
    {attachmentList}
    <details onToggle={event => {
      const disclosure = event.currentTarget;
      if (!disclosure.open || loading || !mail?.online) return;
      if (detail) { mail.markViewed(card); return; }
      setLoading(true); setError("");
      void mail.read(card.mailRefId).then(result => {
        setDetail(result);
        if (disclosure.open && disclosure.isConnected) mail.markViewed(card);
      })
        .catch(reason => setError(reason instanceof Error ? reason.message : "原文读取失败"))
        .finally(() => setLoading(false));
    }}><summary>原文</summary>
      {detail ? <><pre>{detail.bodyText}</pre>{detail.truncated && <p>原文过长，已截取前 256,000 个字符。</p>}
        {links.length > 0 && <ul className="assistant-mail-links" aria-label="邮件中的外部链接">{links.map((url, index) => <li key={index}><a href={url.href} target="_blank" rel="noopener noreferrer"><span>{url.host}</span><span className="assistant-mail-link-path">{url.pathname}{url.search}{url.hash}</span></a></li>)}</ul>}
      </> : <p role={error ? "alert" : "status"}>{error || (loading ? "正在读取原文…" : mail?.online ? "展开以读取原文" : "连接电脑后可查看原文")}</p>}
    </details>
    {nativeMessage && <details className="assistant-mail-native"><summary>关联原生消息</summary><code>{nativeMessage.id}</code><pre>{nativeMessage.text}</pre></details>}
    {mail && <button type="button" className="assistant-session-link" disabled={!mail.canReference} onClick={() => { mail.selectMail(card); onDiscuss?.(); }}>讨论此邮件</button>}
  </article>;
}
