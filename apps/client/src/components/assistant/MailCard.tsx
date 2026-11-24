import { ARTIFACT_MAX_BYTES, mailAttachmentPreviewKind, type BridgeMailCategoryEntry, type BridgeMailFolder, type BridgeHistoryItem, type BridgeMailAttachment, type BridgeMailCard, type BridgeMailDetail } from "@bridge/protocol";
import { ChevronRight, Download, Folder, Mail, Paperclip } from "lucide-react";
import { useEffect, useId, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { downloadMailAttachment } from "../../lib/artifact-download.js";
import { formatBytes } from "../../lib/media-preview.js";
import { registerMobileBackHandler } from "../../lib/mobile-back-navigation.js";
import { MessageCopyButton } from "../common/MessageCopyButton.js";
import { Sheet, SheetAction } from "../common/Sheet.js";
import { useMediaPreview, useMediaRequest } from "../evidence/MediaPreviewProvider.js";
import { useAssistantMail } from "./AssistantMailProvider.js";
import "./assistant-mail.css";

type DeliveryStatus = { detail: string; hint?: "waiting" | "failed" };
const DELIVERY_STATUS: Record<BridgeMailCard["nativeDelivery"]["state"], DeliveryStatus> = {
  "not-submitted": { detail: "未自动发给助理" },
  pending: { detail: "等待发给助理", hint: "waiting" },
  paused: { detail: "已暂停自动发送" },
  submitting: { detail: "正在发给助理", hint: "waiting" },
  submitted: { detail: "已发出，等待助理接收", hint: "waiting" },
  queued: { detail: "已排队等助理", hint: "waiting" },
  observed: { detail: "助理已收到" },
  uncertain: { detail: "尚未确认助理是否收到" },
  failed: { detail: "任务失败", hint: "failed" },
  cancelled: { detail: "任务已取消" },
};
const MAIL_HINT_LABELS = { waiting: "等待助理", processing: "处理中", failed: "助理任务失败" };
const PROCESSING_LABELS = { pending: "待处理", processing: "处理中", processed: "已处理" };
const RECEIVED_TIME_FORMAT = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

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

function MailCategoryPicker({ categories, disabled, move }: {
  categories: readonly BridgeMailCategoryEntry[]; disabled: boolean; move(category: string, control: HTMLElement): void;
}) {
  const [opener, setOpener] = useState<HTMLButtonElement>();
  useEffect(() => {
    if (!opener) return;
    if (disabled) { setOpener(undefined); return; }
    return registerMobileBackHandler(() => { setOpener(undefined); return true; }, 150);
  }, [disabled, opener]);

  return <>
    <button type="button" className="assistant-session-link" aria-haspopup="dialog" disabled={disabled} onClick={event => {
      event.currentTarget.focus({ preventScroll: true });
      setOpener(event.currentTarget);
    }}>收入分类</button>
    {opener && !disabled && <Sheet title="收入分类" manageFocus onClose={() => setOpener(undefined)}>
      <div className="m-group assistant-mail-category-options">
        {categories.map(({ id, label }) => <SheetAction key={id} icon={<Folder size={18} />}
          label={label} onClick={() => {
            setOpener(undefined);
            move(id, opener);
          }} />)}
      </div>
    </Sheet>}
  </>;
}

type MailCardProps = {
  card: BridgeMailCard; compact?: boolean; nativeMessage?: BridgeHistoryItem; onDiscuss?(): void; showBatchDelivery?: boolean;
  processingRecord?: boolean;
  junkAction?: { disabled: boolean; onMark(event: MouseEvent<HTMLButtonElement>): void } | undefined;
  filing?: { disabled: boolean; showFolder: boolean; move(folder: BridgeMailFolder, control: HTMLElement): void } | undefined;
};

export function MailCard(props: MailCardProps) {
  const { card, compact, processingRecord, showBatchDelivery = true } = props;
  const mail = useAssistantMail();
  const [open, setOpen] = useState(false);
  const subject = card.subject || "无主题";
  const sender = card.from.map(({ name, address }) => [name, address].filter(Boolean).join(" ")).join("，") || "未知发件人";
  const receivedDate = new Date(card.receivedAt);
  const receivedTime = <time dateTime={card.receivedAt}>{Number.isNaN(receivedDate.getTime()) ? "Invalid Date" : RECEIVED_TIME_FORMAT.format(receivedDate)}</time>;
  const delivery = showBatchDelivery || !card.nativeDelivery.batchId ? DELIVERY_STATUS[card.nativeDelivery.state] : undefined;
  const content = <MailCardContent {...props} subject={subject} sender={sender} delivery={delivery} receivedTime={compact ? null : receivedTime} />;
  return <article className="assistant-mail-card" data-mail-id={card.mailRefId} data-stream-key={`mail:${card.mailRefId}`} aria-label={`邮件：${subject}`}>
    {compact ? <details className="assistant-mail-row" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
      <summary>
        <span className="assistant-mail-row-heading">
          <span className="assistant-mail-row-subject">{subject}</span>
          {receivedTime}
        </span>
        <span className="assistant-mail-row-meta">
          <span className="assistant-mail-row-from">{sender}</span>
          {!open && delivery?.hint === "failed" && <span className="assistant-mail-hint" data-tone="failed">{MAIL_HINT_LABELS.failed}</span>}
        </span>
        <ChevronRight size={16} aria-hidden="true" />
      </summary>
      {open && <div className="assistant-mail-row-content">{content}</div>}
    </details> : content}
    {processingRecord && card.analysis && <div className="assistant-processing-analysis">
      {(card.analysis.category || card.analysis.attention) && <div className="assistant-processing-tags">
        {card.analysis.category && <span>{mail?.categoryLabel(card.analysis.category) ?? card.analysis.category}</span>}
        {card.analysis.attention && <span data-attention={card.analysis.attention}>
          {{ ignore: "无需关注", read: "值得看", action: "需要处理" }[card.analysis.attention]}
        </span>}
      </div>}
      <MailAnalysis analysis={card.analysis} />
    </div>}
  </article>;
}

function MailAnalysis({ analysis }: { analysis: NonNullable<BridgeMailCard["analysis"]> }) {
  return <>
    {analysis.summary && <pre>{analysis.summary}</pre>}
    {analysis.suggestions?.length ? <><h4>建议</h4><ul>{analysis.suggestions.map((suggestion, index) => <li key={index}>{suggestion}</li>)}</ul></> : null}
    {analysis.questions?.length ? <><h4>问题</h4><ul>{analysis.questions.map((question, index) => <li key={index}>{question}</li>)}</ul></> : null}
  </>;
}

function MailCardContent({ card, compact, subject, sender, delivery, receivedTime, nativeMessage, onDiscuss, junkAction, filing, processingRecord }: MailCardProps & {
  subject: string; sender: string; delivery: DeliveryStatus | undefined; receivedTime: ReactNode;
}) {
  const mail = useAssistantMail();
  const accountLabel = mail?.accountLabel(card.accountKey) ?? "邮件插件";
  const folderLabel = filing?.showFolder && card.folder ? mail?.categoryLabel(card.folder) : undefined;
  const [detail, setDetail] = useState<BridgeMailDetail>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const statusId = useId();
  const [originalOpen, setOriginalOpen] = useState(false);
  const originalVisible = useRef(false);
  function closeOriginal() {
    originalVisible.current = false;
    setOriginalOpen(false);
  }
  useEffect(() => {
    if (originalOpen) return registerMobileBackHandler(() => { closeOriginal(); return true; }, 150);
  }, [originalOpen]);
  const attachments = detail?.attachments ?? card.attachments;
  const attachmentCount = detail?.attachmentCount ?? card.attachmentCount ?? attachments?.length;
  const attachmentList = attachments?.length ? <section className="assistant-attachments" aria-label="邮件附件">
    <h4><Paperclip size={14} aria-hidden="true" />{attachmentCount} 个附件</h4>
    <ul>{attachments.map(attachment => <MailAttachmentRow key={attachment.attachmentId} attachment={attachment}
      mailRefId={card.mailRefId} enabled={Boolean(mail?.online && mail.supportsAttachments)} />)}</ul>
    {attachmentCount !== undefined && attachmentCount > attachments.length && <small>仅显示前 {attachments.length} 个附件</small>}
  </section> : null;
  const links = originalOpen && detail ? [...new Set(detail.bodyText.match(/https?:\/\/[^\s<>"']+/gu) ?? [])].filter(href => URL.canParse(href)).map(href => new URL(href)) : [];
  const copyLabel = detail?.truncated ? "复制已显示内容" : "复制全文";
  const hint = delivery?.hint === "failed" ? "failed" : card.processingStatus === "processing" ? "processing" : delivery?.hint;
  return <>
    <header><span><Mail size={15} aria-hidden="true" />{accountLabel}</span>{receivedTime}</header>
    {folderLabel && <p className="assistant-mail-folder-label">{folderLabel}</p>}
    {!compact && <><h3>{subject}</h3><p className="assistant-mail-from">{sender}</p></>}
    {card.preview && <p className="assistant-mail-preview">{card.preview}</p>}
    {card.previewError && <p className="assistant-mail-from" role="status">{card.previewError}</p>}
    {!processingRecord && card.analysis && <details onToggle={event => {
      if (event.currentTarget.open && mail?.attention !== undefined && (card.analysis?.summary || card.analysis?.suggestions?.length || card.analysis?.questions?.length)) mail.markViewed(card);
    }}><summary>分析结果</summary>
      <MailAnalysis analysis={card.analysis} />
    </details>}
    {attachmentList}
    <div className="assistant-actions assistant-mail-actions" role="group" aria-label="邮件操作">
      <button type="button" className="assistant-session-link" aria-expanded={statusOpen} aria-controls={statusId}
        onClick={() => setStatusOpen(open => !open)}>状态</button>
      <button type="button" className="assistant-session-link" aria-haspopup="dialog" onClick={event => {
        const opener = event.currentTarget;
        opener.focus({ preventScroll: true });
        originalVisible.current = true;
        setOriginalOpen(true);
        if (!mail?.online || loading) return;
        if (detail) { mail.markViewed(card); return; }
        setLoading(true); setError("");
        void mail.read(card.mailRefId, { original: true }).then(result => {
          setDetail(result);
          if (originalVisible.current && opener.isConnected) mail.markViewed(card);
        })
          .catch(reason => setError(reason instanceof Error ? reason.message : "原文读取失败"))
          .finally(() => setLoading(false));
      }}>原文</button>
      {mail && <>
        <button type="button" className="assistant-session-link" disabled={!mail.canReference} onClick={() => { mail.selectMail(card); onDiscuss?.(); }}>讨论此邮件</button>
        {filing && (card.folder
          ? <button type="button" className="assistant-session-link" disabled={filing.disabled} onClick={event => filing.move("inbox", event.currentTarget)}>收回收件</button>
          : <MailCategoryPicker categories={mail.categories} disabled={filing.disabled} move={filing.move} />)}
        {junkAction && <button type="button" className="assistant-session-link assistant-mail-junk-action" disabled={junkAction.disabled} onClick={junkAction.onMark}>标为垃圾邮件</button>}
      </>}
    </div>
    {!statusOpen && hint && <p className="assistant-mail-hint" data-tone={hint === "failed" ? "failed" : undefined}>{MAIL_HINT_LABELS[hint]}</p>}
    <dl id={statusId} className="assistant-mail-detail-status" hidden={!statusOpen}>
      <div><dt>助理处理</dt><dd>{PROCESSING_LABELS[card.processingStatus]}</dd></div>
      {delivery && <div><dt>自动发送</dt><dd>{delivery.detail}</dd></div>}
    </dl>
    {nativeMessage && <details className="assistant-mail-native"><summary>关联原生消息</summary><code>{nativeMessage.id}</code><pre>{nativeMessage.text}</pre></details>}
    {originalOpen && <Sheet title={subject} className="assistant-mail-original" manageFocus onClose={closeOriginal} footer={detail &&
      <MessageCopyButton text={detail.bodyText} label={copyLabel} buttonText={copyLabel} />}>
      {detail ? <>
        {detail.truncated && <p role="status">仅显示部分原文。</p>}
        <pre className="assistant-mail-original-body" tabIndex={0}>{detail.bodyText}</pre>
        {links.length > 0 && <ul className="assistant-mail-links" aria-label="邮件中的外部链接">{links.map((url, index) => <li key={index}><a href={url.href} target="_blank" rel="noopener noreferrer"><span>{url.host}</span><span className="assistant-mail-link-path">{url.pathname}{url.search}{url.hash}</span></a></li>)}</ul>}
      </> : <p role={error ? "alert" : "status"}>{error || (loading ? "正在读取原文…" : "连接电脑后可查看原文")}</p>}
    </Sheet>}
  </>;
}
