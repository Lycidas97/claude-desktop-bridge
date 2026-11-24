import { LoaderCircle } from "lucide-react";
import { createContext } from "react";
import type { SessionHistoryState } from "../../hooks/useMobileBridge.js";
import type { AssistantProcessingBatch } from "../../lib/conversation-timeline.js";
import { AssistantTriggerBatch } from "./AssistantTriggerBatch.js";

export const AssistantProcessingContext = createContext<{ visible: boolean; onDiscuss(): void } | undefined>(undefined);

export function AssistantProcessing({ batches, history, sessionId, hostId, visible, supportsToolDetail, onDiscuss, onCancel, onLoadOlder }: {
  batches: AssistantProcessingBatch[];
  history: SessionHistoryState | undefined;
  sessionId: string;
  hostId: string;
  visible: boolean;
  supportsToolDetail: boolean;
  onDiscuss(): void;
  onCancel?: ((sessionId: string, commandId: string) => Promise<void>) | undefined;
  onLoadOlder(sessionId: string): Promise<void>;
}) {
  return <section className="assistant-processing" aria-label="处理记录" hidden={!visible}>
    <div className="assistant-page-content">
      {batches.map(({ batchId, cards, nativeMessage, occurredAt, outputs }) => <AssistantTriggerBatch key={`${hostId}:${sessionId}:${batchId}`}
        sessionId={sessionId} batchId={batchId} cards={cards} nativeMessage={nativeMessage} visible={visible} onCancel={onCancel}
        onDiscuss={onDiscuss} record={{ occurredAt, outputs, hostId, supportsToolDetail }} />)}
      {!batches.length && <p className="assistant-mail-empty" role="status">{history?.status === "loading" ? "正在读取处理记录…" : "暂无处理记录"}</p>}
      {history?.error && <p role="alert">{history.error}</p>}
      {history?.hasMore && <button type="button" className="load-older-button" disabled={history.status === "loading"}
        onClick={() => void onLoadOlder(sessionId)}>
        {history.status === "loading" && <LoaderCircle size={15} className="is-spinning" aria-hidden="true" />}
        {history.status === "loading" ? "正在读取更早记录…" : history.error ? "重试读取更早记录" : "加载更早记录"}
      </button>}
    </div>
  </section>;
}
