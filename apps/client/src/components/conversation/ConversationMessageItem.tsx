import type { BridgeSessionInfo } from "@bridge/protocol";
import type { ReactNode } from "react";
import { deliveryLabel, formatTime, type ConversationItem } from "../../lib/conversation-timeline.js";
import { desktopRuntimeId } from "../../lib/runtime-labels.js";
import { sessionQueueLabel } from "../../lib/session-activity.js";
import { MarkdownText } from "../common/MarkdownText.js";
import { MessageCopyButton } from "../common/MessageCopyButton.js";
import { ImageAttachment } from "../evidence/ImageAttachment.js";
import { TaskPlanCard } from "./TaskPlanCard.js";

export interface QueuedTurnActionState {
  state: "pending" | "requested" | "error";
  action: "steer" | "cancel";
  error?: string | undefined;
}

export interface ConversationMessageItemProps {
  item: ConversationItem;
  session: BridgeSessionInfo;
  entering?: boolean | undefined;
  online?: boolean | undefined;
  canSend?: boolean | undefined;
  queueAction?: QueuedTurnActionState | undefined;
  onSteerQueuedTurn?: ((sessionId: string, commandId: string) => void | Promise<void>) | undefined;
  onCancelQueuedTurn?: ((sessionId: string, commandId: string) => void | Promise<void>) | undefined;
  onQueueActionChange?: ((next: QueuedTurnActionState) => void) | undefined;
  rewindAvailable?: boolean | undefined;
  rewindDisabled?: boolean | undefined;
  onRewind?: ((messageId: string) => void) | undefined;
  onResolveUncertain?: ((commandId: string, action: "confirm" | "retry") => void | Promise<void>) | undefined;
  onFileClick?: ((filePath: string) => void) | undefined;
  interactivePrompt?: ReactNode;
}

export function ConversationMessageItem({
  item,
  session,
  entering = false,
  online = true,
  canSend = false,
  queueAction,
  onSteerQueuedTurn,
  onCancelQueuedTurn,
  onQueueActionChange,
  rewindAvailable = false,
  rewindDisabled = false,
  onRewind,
  onResolveUncertain,
  onFileClick,
  interactivePrompt,
}: ConversationMessageItemProps) {
  const showDelivery = Boolean(item.delivery);
  const messageQueued = Boolean(
    (item.delivery === "queued" || item.delivery === "host-received")
    && item.commandId
    && session.pendingCommandIds?.includes(item.commandId),
  );
  const canActOnQueued = Boolean(
    item.role === "user"
    && item.commandId
    && (messageQueued || item.delivery === "submitted" || item.delivery === "session-received")
    && desktopRuntimeId(session) === "claude-desktop"
    && canSend,
  );
  const copyable = (item.role === "assistant" || item.role === "user") && Boolean(item.text.trim());
  const content = (
    <>
      {item.text && (
        item.role === "assistant" || item.role === "user" ? (
          <MarkdownText
            text={item.text}
            collapsible={!item.live}
            {...(onFileClick ? { onFileClick } : {})}
          />
        ) : (
          <div className="conversation-text">{item.text}</div>
        )
      )}
      {item.taskPlan && <TaskPlanCard key={`${item.sessionId}:${item.taskPlan.id}`} plan={item.taskPlan} />}
      {interactivePrompt}
      {item.attachments?.length ? (
        <div className="conversation-attachments">
          {item.attachments.map((attachment) => attachment.data || attachment.nativeImage ? (
            <ImageAttachment key={attachment.id} attachment={attachment} sessionId={item.sessionId} />
          ) : (
            <span className="attachment-chip" key={attachment.id}>{attachment.name}</span>
          ))}
        </div>
      ) : null}
    </>
  );

  return (
    <article
      className={`conversation-item ${item.role} ${item.live ? "live" : ""}${entering ? " is-entering" : ""}`}
      data-stream-key={item.id}
    >
      {item.role === "system" && (
        <div className="conversation-item-meta">
          <strong>Bridge</strong>
          <time>{formatTime(item.createdAt)}</time>
        </div>
      )}
      {/* A sent message's bubble holds only what was sent; status and copy sit under it. */}
      {item.role === "user" ? <div className="conversation-bubble">{content}</div> : content}
      {(copyable || showDelivery || (rewindAvailable && item.role === "user")) && (
        <div className="conversation-message-actions">
          {showDelivery && (
            <span className={`delivery-state ${item.delivery}`} role="status">
              {messageQueued ? `已排队 · ${sessionQueueLabel(session)}` : deliveryLabel(item.delivery!)}
            </span>
          )}
          {canActOnQueued && ([
            { label: "Send now", action: "steer", callback: onSteerQueuedTurn, className: "queued-steer-button" },
            { label: "撤回", action: "cancel", callback: onCancelQueuedTurn, className: "queued-cancel-button" },
          ] as const).map(({ label, action, callback, className }) => callback && (
            <button
              key={label}
              type="button"
              className={`message-copy-button ${className}`}
              disabled={!online || queueAction?.state === "pending"
                || (queueAction?.state === "requested" && (queueAction.action === "cancel" || queueAction.action === action))}
              aria-busy={queueAction?.state === "pending" && queueAction.action === action}
              title={!online ? "电脑离线，连接后再操作" : label === "Send now" ? "立即发送这条排队消息" : "撤回这条排队消息"}
              onClick={async () => {
                onQueueActionChange?.({ state: "pending", action });
                try {
                  await callback(session.sessionId, item.commandId!);
                  onQueueActionChange?.({ state: "requested", action });
                } catch (error) {
                  onQueueActionChange?.({ state: "error", action, error: error instanceof Error ? error.message : `${label}失败` });
                }
              }}
            >
              {label}
            </button>
          ))}
          {copyable && <MessageCopyButton text={item.text} label={item.role === "assistant" ? "复制这条回复" : "复制这条消息"} />}
          {rewindAvailable && onRewind && item.role === "user" && !item.id.startsWith("local:") && (
            <button
              type="button"
              className="message-copy-button"
              aria-label="回退到这条消息之前"
              disabled={rewindDisabled}
              onClick={() => onRewind(item.id)}
            >
              回退
            </button>
          )}
        </div>
      )}
      {queueAction?.error && <div className="delivery-error-detail" role="alert">{queueAction.error}</div>}
      {item.delivery === "failed" && item.error && (
        <div className="delivery-error-detail">{item.error}</div>
      )}
      {item.delivery === "uncertain" && item.commandId && onResolveUncertain && (
        <div className="uncertain-delivery-actions">
          <button type="button" className="secondary-button" onClick={() => void onResolveUncertain(item.commandId!, "confirm")}>确认已发送</button>
          <button type="button" className="secondary-button" onClick={() => void onResolveUncertain(item.commandId!, "retry")}>检查后重发</button>
        </div>
      )}
    </article>
  );
}
