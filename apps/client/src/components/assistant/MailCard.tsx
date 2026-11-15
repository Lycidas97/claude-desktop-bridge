import type { BridgeHistoryItem, BridgeMailCard, BridgeMailDetail } from "@bridge/protocol";
import { Mail } from "lucide-react";
import { useState } from "react";
import { useAssistantMail } from "./AssistantMailProvider.js";
import "./assistant-mail.css";

const DELIVERY_LABELS = {
  "not-submitted": "未提交", submitting: "提交中", submitted: "已提交", observed: "原生已观测", uncertain: "不确定", failed: "失败",
};
const PROCESSING_LABELS = { pending: "待处理", processing: "处理中", processed: "已处理" };

export function MailCard({ card, nativeMessage }: { card: BridgeMailCard; nativeMessage?: BridgeHistoryItem }) {
  const mail = useAssistantMail();
  const [detail, setDetail] = useState<BridgeMailDetail>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const links = detail ? [...new Set(detail.bodyText.match(/https?:\/\/[^\s<>"']+/gu) ?? [])].filter(href => URL.canParse(href)).map(href => new URL(href)) : [];
  return <article className="assistant-mail-card" data-mail-id={card.mailRefId} aria-label={`邮件：${card.subject || "无主题"}`}>
    <header><span><Mail size={15} aria-hidden="true" />邮件插件</span><time dateTime={card.receivedAt}>{new Date(card.recordedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time></header>
    <h3>{card.subject || "无主题"}</h3>
    <p className="assistant-mail-from">{card.from.map(sender => [sender.name, sender.address].filter(Boolean).join(" ")).join("，") || "未知发件人"}</p>
    {card.preview && <p className="assistant-mail-preview">{card.preview}</p>}
    <dl className="assistant-mail-status">
      <div><dt>输入</dt><dd>已记录</dd></div>
      <div><dt>原生投递</dt><dd>{DELIVERY_LABELS[card.nativeDelivery.state]}</dd></div>
      <div><dt>业务处理</dt><dd>{PROCESSING_LABELS[card.processingStatus]}</dd></div>
    </dl>
    {card.analysis && <details><summary>分析结果</summary>
      {card.analysis.summary && <pre>{card.analysis.summary}</pre>}
      {card.analysis.suggestions?.map((suggestion, index) => <p key={index}>{suggestion}</p>)}
      {card.analysis.questions?.map((question, index) => <p key={index}>{question}</p>)}
    </details>}
    <details onToggle={event => {
      if (!event.currentTarget.open || detail || loading || !mail?.online) return;
      setLoading(true); setError("");
      void mail.read(card.mailRefId).then(setDetail)
        .catch(reason => setError(reason instanceof Error ? reason.message : "原文读取失败"))
        .finally(() => setLoading(false));
    }}><summary>原文</summary>
      {detail ? <><pre>{detail.bodyText}</pre>{detail.truncated && <p>原文过长，已截取前 256,000 个字符。</p>}
        {links.length > 0 && <ul className="assistant-mail-links" aria-label="邮件中的外部链接">{links.map((url, index) => <li key={index}><a href={url.href} target="_blank" rel="noopener noreferrer">{url.host}</a></li>)}</ul>}
      </> : <p role={error ? "alert" : "status"}>{error || (loading ? "正在读取原文…" : mail?.online ? "展开以读取原文" : "连接电脑后可查看原文")}</p>}
    </details>
    {nativeMessage && <details className="assistant-mail-native"><summary>关联原生消息</summary><code>{nativeMessage.id}</code><pre>{nativeMessage.text}</pre></details>}
  </article>;
}
