import type { BridgeHistoryItem, BridgeMailCard, BridgeMailPage } from "@bridge/protocol";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { mailResult, useAssistantMail } from "./AssistantMailProvider.js";
import { MailCard } from "./MailCard.js";
import { useVisibleMailRead } from "./useVisibleMailRead.js";

export const AssistantTranscriptVisibleContext = createContext(true);

const DELIVERY_LABELS: Record<BridgeMailCard["nativeDelivery"]["state"], string> = {
  "not-submitted": "未提交", pending: "待提交", paused: "已暂停", submitting: "提交中", submitted: "已提交", queued: "排队中",
  observed: "原生已观测", uncertain: "不确定", failed: "失败", cancelled: "已撤回",
};

export function AssistantTriggerBatch({ sessionId, batchId, cards, nativeMessage, onCancel }: {
  sessionId: string;
  batchId: string;
  cards: BridgeMailCard[];
  nativeMessage?: BridgeHistoryItem | undefined;
  onCancel?: ((sessionId: string, commandId: string) => Promise<void>) | undefined;
}) {
  const mail = useAssistantMail();
  const { online, request, supportsBatches } = mail ?? {};
  const changeToken = mail?.assistant?.changeToken;
  const linked = Boolean(nativeMessage);
  const visible = useContext(AssistantTranscriptVisibleContext);
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
  // The native receipt can report a withdrawal before the deferred mail read catches up.
  const state = delivery === "cancelled" ? delivery : loaded?.[0]?.nativeDelivery.state ?? (
    delivery === "queued" || delivery === "uncertain" || delivery === "failed"
      ? delivery : nativeMessage ? "observed" : nativeDelivery?.state ?? "pending");
  const commandId = nativeMessage?.commandId ?? nativeDelivery?.commandId;
  return <section className="assistant-trigger-batch" data-stream-key={`assistant-trigger:${batchId}`} aria-label="助理唤醒">
    <header><strong>助理唤醒</strong><span>{DELIVERY_LABELS[state]}</span>
      {state === "queued" && commandId && onCancel && <button type="button" className="message-copy-button queued-cancel-button"
        disabled={!online || cancelling} aria-busy={cancelling} aria-label="撤回助理唤醒" onClick={() => {
          setCancelError("");
          setCancelling(true);
          void onCancel(sessionId, commandId).catch(error => setCancelError(error instanceof Error ? error.message : "撤回失败"))
            .finally(() => setCancelling(false));
        }}>撤回</button>}
    </header>
    {readError && <p role="alert">{readError}</p>}
    {cancelError && <p role="alert">{cancelError}</p>}
    {visibleCards.map(card => <MailCard key={card.mailRefId} card={card} showBatchDelivery={false} />)}
    {nativeMessage && <details className="assistant-mail-native"><summary>关联原生消息</summary>
      <code>{nativeMessage.id}</code><pre>{nativeMessage.text}</pre>
    </details>}
  </section>;
}
