import type { BridgeHistoryItem, BridgeMailCard, BridgeMailPage } from "@bridge/protocol";
import { useEffect, useMemo, useState } from "react";
import type { AssistantProcessingBatch } from "../../lib/conversation-timeline.js";
import { ToolCallGroupRows } from "../conversation/ToolCallDetailSheet.js";
import { mailResult, useAssistantMail } from "./AssistantMailProvider.js";
import { MailCard } from "./MailCard.js";
import { useVisibleMailRead } from "./useVisibleMailRead.js";

const RECORD_TIME = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const VISIBLE_DELIVERY = new Set(["pending", "paused", "uncertain", "failed", "cancelled"]);

const DELIVERY_LABELS: Record<BridgeMailCard["nativeDelivery"]["state"] | "running" | "completed", string> = {
  "not-submitted": "未提交", pending: "待提交", paused: "已暂停", submitting: "提交中", submitted: "已提交", queued: "排队中",
  observed: "原生已观测", running: "运行中", completed: "已完成", uncertain: "不确定", failed: "失败", cancelled: "已撤回",
};

export function AssistantTriggerBatch({ sessionId, batchId, cards, nativeMessage, onCancel, visible = true, record, onDiscuss }: {
  sessionId: string;
  batchId: string;
  cards: BridgeMailCard[];
  nativeMessage?: BridgeHistoryItem | undefined;
  onCancel?: ((sessionId: string, commandId: string) => Promise<void>) | undefined;
  visible?: boolean;
  record?: { occurredAt: number; outputs: AssistantProcessingBatch["outputs"]; hostId: string; supportsToolDetail: boolean };
  onDiscuss?: (() => void) | undefined;
}) {
  const mail = useAssistantMail();
  const { online, request, supportsBatches } = mail ?? {};
  const changeToken = mail?.assistant?.changeToken;
  const linked = Boolean(nativeMessage || (record && (!cards.length || cards[0]?.nativeDelivery.messageId)));
  const read = useVisibleMailRead(useMemo(() => linked && supportsBatches && online && request
    ? { request, sessionId, batchId, changeToken } : undefined,
  [linked, supportsBatches, online, request, sessionId, batchId, changeToken]), visible);
  const [loaded, setLoaded] = useState<BridgeMailCard[]>();
  const [readError, setReadError] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState("");
  useEffect(() => {
    if (!read) return;
    const { request, sessionId, batchId } = read;
    let active = true;
    setReadError("");
    void (async () => {
      const nextCards: BridgeMailCard[] = [];
      let cursor: string | undefined;
      do {
        const { mailPage } = mailResult<{ mailPage: BridgeMailPage }>(await request("plugin.assistant-mail.batch", {
          sessionId, batchId, ...(cursor ? { cursor } : {}),
        }));
        if (!active) return;
        nextCards.push(...mailPage.cards);
        cursor = mailPage.nextCursor;
      } while (cursor);
      setLoaded(nextCards);
    })().catch((error: unknown) => {
      if (active) setReadError(error instanceof Error ? error.message : "助理批次读取失败");
    });
    return () => { active = false; };
  }, [read]);

  const visibleCards = loaded ?? cards;
  const nativeDelivery = visibleCards[0]?.nativeDelivery;
  const delivery = nativeMessage?.delivery;
  // A deferred mail read can still show a batch as queued after Native has started or ended it.
  const state = delivery === "running" || delivery === "completed" || delivery === "failed" || delivery === "cancelled"
    ? delivery : loaded?.[0]?.nativeDelivery.state ?? (
      delivery === "queued" || delivery === "uncertain" ? delivery : nativeMessage ? "observed" : nativeDelivery?.state ?? "observed");
  const commandId = nativeMessage?.commandId ?? nativeDelivery?.commandId;
  const cancel = state === "queued" && commandId && onCancel && <button type="button" className="message-copy-button queued-cancel-button"
    disabled={!online || cancelling} aria-busy={cancelling} aria-label="撤回助理唤醒" onClick={() => {
      setCancelError("");
      setCancelling(true);
      void onCancel(sessionId, commandId).catch(error => setCancelError(error instanceof Error ? error.message : "撤回失败"))
        .finally(() => setCancelling(false));
    }}>撤回</button>;
  const lastText = record?.outputs.filter(item => item.role === "assistant" && item.text).at(-1);
  const conclusion = lastText && !lastText.text.startsWith("【给用户】") ? lastText : undefined;
  const tools = record?.outputs.filter(item => item.role === "tool") ?? [];
  const notes = record?.outputs.filter(item => item !== conclusion && item.role === "assistant" && item.text && !item.text.startsWith("【给用户】")) ?? [];
  const showStatus = !record || VISIBLE_DELIVERY.has(state);
  return <section className="assistant-trigger-batch" data-stream-key={`assistant-trigger:${batchId}`} aria-label="助理唤醒">
    <header>
      {record ? <time dateTime={new Date(record.occurredAt).toISOString()}>{RECORD_TIME.format(record.occurredAt)}</time> : <strong>助理唤醒</strong>}
      {showStatus && <span data-delivery={state}>{DELIVERY_LABELS[state]}</span>}
      {cancel}
    </header>
    {readError && <p role="alert">{readError}</p>}
    {cancelError && <p role="alert">{cancelError}</p>}
    {visibleCards.map(card => <MailCard key={card.mailRefId} card={card} compact processingRecord={Boolean(record)} showBatchDelivery={false}
      {...(onDiscuss ? { onDiscuss } : {})} />)}
    {conclusion && <p className="assistant-processing-conclusion">{conclusion.text}</p>}
    {record ? <details className="assistant-processing-execution">
      <summary>执行详情{tools.length ? ` · ${tools.length} 次工具调用` : ""}</summary>
      {!showStatus && <p>{DELIVERY_LABELS[state]}</p>}
      {notes.map(item => <pre key={item.id}>{item.text}</pre>)}
      {tools.length > 0 && <ToolCallGroupRows hostId={record.hostId} sessionId={sessionId} tools={tools} supportsToolDetail={record.supportsToolDetail} />}
      {nativeMessage && <details className="assistant-mail-native"><summary>关联原生消息</summary>
        <code>{nativeMessage.id}</code><pre>{nativeMessage.text}</pre>
      </details>}
    </details> : nativeMessage && <details className="assistant-mail-native"><summary>关联原生消息</summary>
      <code>{nativeMessage.id}</code><pre>{nativeMessage.text}</pre>
    </details>}
  </section>;
}
