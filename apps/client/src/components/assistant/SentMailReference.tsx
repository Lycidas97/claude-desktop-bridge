import type { BridgeMailDetail } from "@bridge/protocol";
import { ChevronRight, Mail } from "lucide-react";
import { useEffect, useState } from "react";
import { registerMobileBackHandler } from "../../lib/mobile-back-navigation.js";
import { Sheet } from "../common/Sheet.js";
import { useAssistantMail } from "./AssistantMailProvider.js";
import "./assistant-mail.css";

export function SentMailReference({ mailRefId }: { mailRefId: string }) {
  const mail = useAssistantMail();
  const card = mail?.referenceCard(mailRefId);
  const subject = card ? card.subject || "无主题" : "邮件引用";
  const sender = card?.from.map(({ name, address }) => name || address).filter(Boolean).join("，") || "未知发件人";
  const receivedAt = card && new Date(card.receivedAt).toLocaleString("zh-CN", {
    month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<BridgeMailDetail>();
  const [error, setError] = useState("");

  useEffect(() => {
    if (open) return registerMobileBackHandler(() => { setOpen(false); return true; }, 150);
  }, [open]);
  useEffect(() => {
    if (!open || detail || !mail?.online) return;
    let reading = true;
    void mail.read(mailRefId).then(result => {
      if (!reading) return;
      setDetail(result);
      if (card) mail.markViewed(card);
    }).catch(reason => { if (reading) setError(reason instanceof Error ? reason.message : "原文读取失败"); });
    return () => { reading = false; };
  }, [open, detail, mail?.online, mailRefId]);

  return <>
    <button type="button" className="sent-mail-reference" aria-haspopup="dialog"
      aria-label={`打开邮件：${subject}${card ? `，${sender}，${receivedAt}` : ""}`} onClick={event => {
        event.currentTarget.focus({ preventScroll: true });
        setError("");
        setOpen(true);
      }}>
      <Mail size={16} aria-hidden="true" />
      <span className="sent-mail-reference-summary">
        <strong title={subject}>{subject}</strong>
        {card && <span><span title={sender}>{sender}</span><time dateTime={card.receivedAt}>{receivedAt}</time></span>}
      </span>
      <ChevronRight size={14} aria-hidden="true" />
    </button>
    {open && <Sheet title={subject} manageFocus onClose={() => setOpen(false)}>
      {detail ? <><pre className="sent-mail-original">{detail.bodyText}</pre>
        {detail.truncated && <p>原文过长，已截取前 256,000 个字符。</p>}
      </> : error ? <p role="alert">{error}</p>
        : <p role="status">{!mail ? "当前电脑不支持查看邮件" : mail.online ? "正在读取原文…" : "连接电脑后可查看原文"}</p>}
    </Sheet>}
  </>;
}
