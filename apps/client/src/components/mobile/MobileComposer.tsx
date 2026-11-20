import type {
  BridgeAttachment,
  BridgeHostSnapshot,
  BridgeSessionInfo,
  BridgeSlashCommandCatalog,
  BridgeTokenUsage,
  SocketState,
} from "@bridge/protocol";
import { ArrowUp, LoaderCircle, Square, X } from "lucide-react";
import type { RefObject } from "react";
import type { MobileConnectionIssue } from "../../hooks/useMobileBridge.js";
import { canSendSession } from "../../lib/conversation-timeline.js";
import type { UploadFileHandler } from "../../lib/file-upload.js";
import { desktopRuntimeId } from "../../lib/runtime-labels.js";
import type { SessionActivity } from "../../lib/session-activity.js";
import {
  SessionActivityIndicator,
  SessionContextUsageBar,
} from "../conversation/SessionActivityIndicator.js";
import { SlashCommandInput } from "../conversation/SlashCommandInput.js";
import {
  ComposerAttachmentMenu,
  FileAttachmentPicker,
  type useFileAttachments,
} from "../evidence/FileAttachmentPicker.js";

export interface MobileDraftState {
  text: string;
  attachments: BridgeAttachment[];
  sending: boolean;
  imageError?: string | undefined;
}

export interface MobileComposerProps {
  variant?: "mobile" | "desktop" | undefined;
  sessionView?: "conversation" | "evidence" | undefined;
  selectedSession: BridgeSessionInfo;
  snapshot: BridgeHostSnapshot | undefined;
  connection: SocketState;
  desktopOnline: boolean;
  connectionIssue: MobileConnectionIssue | undefined;
  runtimeName: string;
  draftKey: string;
  text: string;
  attachments: BridgeAttachment[];
  sending: boolean;
  imageError: string | undefined;
  canAttachImages: boolean;
  commandDraft: boolean;
  hasDraft: boolean;
  stopTarget: BridgeSessionInfo | undefined;
  stopping: boolean;
  activity?: SessionActivity | undefined;
  turnUsage?: BridgeTokenUsage | undefined;
  contextPopoverOpen?: boolean | undefined;
  onToggleContextPopover?: (() => void) | undefined;
  onCompactContext?: (() => void) | undefined;
  compactContextDisabled?: boolean | undefined;
  compactContextBusy?: boolean | undefined;
  contextTriggerRef?: RefObject<HTMLButtonElement | null> | undefined;
  contextPopoverRef?: RefObject<HTMLDivElement | null> | undefined;
  contextContainerRef?: RefObject<HTMLDivElement | null> | undefined;
  fileUploads: ReturnType<typeof useFileAttachments>;
  fileRef: RefObject<HTMLInputElement | null>;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  onUploadFile: UploadFileHandler | undefined;
  onLoadSessionCommands: ((sessionId: string) => Promise<BridgeSlashCommandCatalog>) | undefined;
  loadCommands: (() => Promise<BridgeSlashCommandCatalog>) | undefined;
  updateDraft(change: (current: MobileDraftState) => MobileDraftState): void;
  addImages(files: FileList | null): Promise<void>;
  sendMessage(): Promise<void>;
  onOpenStopConfirm(): void;
  onRetry(): Promise<void>;
}

export function MobileComposer({
  variant = "mobile",
  sessionView = "conversation",
  selectedSession,
  snapshot,
  connection,
  desktopOnline,
  connectionIssue,
  runtimeName,
  draftKey,
  text,
  attachments,
  sending,
  imageError,
  canAttachImages,
  commandDraft,
  hasDraft,
  stopTarget,
  stopping,
  activity,
  turnUsage,
  contextPopoverOpen = false,
  onToggleContextPopover,
  onCompactContext,
  compactContextDisabled = false,
  compactContextBusy = false,
  contextTriggerRef,
  contextPopoverRef,
  contextContainerRef,
  fileUploads,
  fileRef,
  composerRef,
  onUploadFile,
  onLoadSessionCommands,
  loadCommands,
  updateDraft,
  addImages,
  sendMessage,
  onOpenStopConfirm,
  onRetry,
}: MobileComposerProps) {
  const hasAttach = canAttachImages || Boolean(onUploadFile);
  const defaultOnlinePlaceholder = variant === "desktop"
    ? (sessionView === "evidence"
        ? "针对成果继续提问，或输入修改要求…"
        : "继续追问，或输入 / 调用技能…")
    : "继续追问…";

  return (
    <section className="mobile-composer">
      {connectionIssue && (
        <button type="button" className="composer-connection" onClick={() => void onRetry()}>
          {connectionIssue.message} 点击重试
        </button>
      )}
      {onUploadFile && <FileAttachmentPicker state={fileUploads} />}
      {attachments.length > 0 && (
        <div className="composer-attachments">
          {attachments.map((attachment) => (
            <span key={attachment.id}>
              {attachment.name}
              <button
                type="button"
                aria-label={`移除 ${attachment.name}`}
                onClick={() => updateDraft((current) => ({
                  ...current,
                  attachments: current.attachments.filter((item) => item.id !== attachment.id),
                }))}
              >
                <X size={13} />
              </button>
            </span>
          ))}
        </div>
      )}
      {imageError && <div className="composer-error" role="alert">{imageError}</div>}
      <form
        className={hasAttach ? "composer-form composer-form--with-attachment" : "composer-form"}
        onSubmit={(event) => {
          event.preventDefault();
          void sendMessage();
        }}
      >
        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/gif,image/webp"
          multiple
          hidden
          onChange={(event) => void addImages(event.target.files)}
        />
        <SlashCommandInput
          key={draftKey}
          sessionKey={draftKey}
          textareaRef={composerRef}
          {...(onLoadSessionCommands
            && snapshot?.host.capabilities.includes("session.commands.v1")
            && desktopRuntimeId(selectedSession) === "claude-desktop"
            && loadCommands
            ? { onLoad: loadCommands }
            : {})}
          value={text}
          onChange={(value) => updateDraft((current) => ({ ...current, text: value }))}
          disabled={!canSendSession(selectedSession, snapshot)}
          placeholder={
            desktopRuntimeId(selectedSession) === "claude-desktop" && !canSendSession(selectedSession, snapshot)
              ? "请连接 Claude Desktop 原生会话"
              : desktopOnline
                ? selectedSession.allowedActions?.reason ?? defaultOnlinePlaceholder
                : variant === "desktop"
                  ? "Claude Desktop 连接已断开"
                  : "电脑离线，消息会保存在手机并自动送达"
          }
          aria-label={`给 ${runtimeName} 发指令`}
        />
        <div className="composer-bar">
          <div className="composer-bar-left">
            {hasAttach && (
              <ComposerAttachmentMenu
                canAttachImages={canAttachImages}
                imageDisabled={commandDraft || !canSendSession(selectedSession, snapshot)}
                onPickImages={() => fileRef.current?.click()}
                {...(onUploadFile
                  ? {
                      fileUploads,
                      fileDisabled: commandDraft
                        || !canSendSession(selectedSession, snapshot)
                        || sending
                        || connection !== "connected"
                        || !desktopOnline,
                    }
                  : {})}
              />
            )}
            <SessionActivityIndicator activity={activity} />
          </div>
          <div className="composer-bar-right">
            <SessionContextUsageBar
              usage={selectedSession.contextUsage}
              turnUsage={turnUsage}
              open={contextPopoverOpen}
              {...(onToggleContextPopover ? { onToggle: onToggleContextPopover } : {})}
              {...(onCompactContext ? { onCompact: onCompactContext } : {})}
              compactDisabled={compactContextDisabled}
              compactBusy={compactContextBusy}
              triggerRef={contextTriggerRef}
              popoverRef={contextPopoverRef}
              containerRef={contextContainerRef}
            />
            {stopTarget && !hasDraft && !sending ? (
              <button
                type="button"
                className="send-button is-stop"
                aria-label={stopTarget.sessionId === selectedSession.sessionId ? "停止任务" : "停止阻塞任务"}
                disabled={stopping}
                onClick={onOpenStopConfirm}
              >
                {stopping
                  ? <LoaderCircle className="is-spinning" size={16} />
                  : <Square size={10} fill="currentColor" />}
              </button>
            ) : (
              <button
                type="submit"
                className="send-button"
                aria-label="发送"
                disabled={!canSendSession(selectedSession, snapshot) || sending || fileUploads.uploading || !hasDraft}
              >
                {sending
                  ? <LoaderCircle className="is-spinning" size={16} />
                  : <ArrowUp size={16} strokeWidth={2.4} />}
              </button>
            )}
          </div>
        </div>
      </form>
    </section>
  );
}
