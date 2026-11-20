import type { AssistantAttentionItem, BridgeMailDetail } from "@bridge/protocol";
import { ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { Sheet } from "../common/Sheet.js";
import { useAssistantMail } from "./AssistantMailProvider.js";
import "./assistant-attention.css";

const mailReasons = { new: "新邮件", unscreened: "尚未筛选", read: "值得看", action: "需要处理" };

export function AssistantAttention({ onReply, onTodo }: { onReply(itemId: string): void; onTodo(): void }) {
  const mail = useAssistantMail();
  const [selected, setSelected] = useState<Extract<AssistantAttentionItem, { kind: "mail" | "event" }>>();
  const items = mail?.attention;
  if (!items?.length && !selected) return null;
  return <>
    {Boolean(items?.length) && <details className="assistant-attention">
      <summary><i className="sidebar-unread-dot" aria-hidden="true" />待关注 <ChevronRight size={15} aria-hidden="true" /></summary>
      <ul>
        {items?.map(item => <li key={`${item.kind}:${item.id}`}>
          <button type="button" disabled={item.kind === "reply" && !mail?.online} onClick={() => {
            if (item.kind === "reply") onReply(item.id.slice(item.sessionId.length + 1));
            else if (item.kind === "todo") onTodo();
            else setSelected(item);
          }}>
            <span>{item.title || "无主题"}</span>
            <small>{item.kind === "mail" ? mailReasons[item.reason] : item.kind === "reply" ? "助理回复" : item.kind === "todo" ? "到期待办" : "日程提醒"}</small>
          </button>
        </li>)}
      </ul>
    </details>}
    {selected && <AttentionDetail key={selected.id} item={selected} onClose={() => setSelected(undefined)} />}
  </>;
}

function AttentionDetail({ item, onClose }: { item: Extract<AssistantAttentionItem, { kind: "mail" | "event" }>; onClose(): void }) {
  const mail = useAssistantMail()!;
  const [detail, setDetail] = useState<BridgeMailDetail>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (item.kind !== "mail" || !mail.online || detail) return;
    let open = true;
    void mail.read(item.id).then(result => {
      if (!open) return;
      setDetail(result);
    }).catch(reason => { if (open) setError(reason instanceof Error ? reason.message : "无法读取原文"); });
    return () => { open = false; };
  }, [item, mail.online, detail]);
  useEffect(() => {
    if (!detail || !mail.online || item.kind !== "mail") return;
    void mail.acknowledge("mail", item.id).catch(reason => setError(reason instanceof Error ? reason.message : "无法记录已看"));
  }, [detail, item, mail.online]);

  const confirm = item.kind === "event" ? "已看" : item.reason === "action" ? "标为已解决" : undefined;
  return <Sheet title={item.title || "无主题"} manageFocus busy={busy} onClose={onClose} footer={confirm && (
    <button type="button" className="primary-button" disabled={!mail.online || busy || (item.kind === "mail" && !detail)} onClick={() => {
      setBusy(true); setError("");
      void mail.acknowledge(item.kind === "event" ? "event" : "mail-action", item.id).then(onClose)
        .catch(reason => setError(reason instanceof Error ? reason.message : "无法更新事项"))
        .finally(() => setBusy(false));
    }}>{confirm}</button>
  )}>
    {item.kind === "event" ? <time dateTime={item.startAt}>{item.startAt.length === 10 ? item.startAt :
      new Date(item.startAt).toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" })}</time>
      : detail ? <><pre className="assistant-attention-original">{detail.bodyText}</pre>{detail.truncated && <p>原文过长，已截取前 256,000 个字符。</p>}</>
        : !error && <p role="status">{mail.online ? "正在读取原文…" : "连接电脑后可查看原文"}</p>}
    {error && <p role="alert">{error}</p>}
  </Sheet>;
}
