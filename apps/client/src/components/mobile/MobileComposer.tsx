import type {
  BridgeAttachment,
  BridgeHostSnapshot,
  BridgeSessionInfo,
  BridgeSlashCommandCatalog,
  SocketState,
} from "@bridge/protocol";
import { LoaderCircle, Send, Square, X } from "lucide-react";
import type { RefObject } from "react";
import type { MobileConnectionIssue } from "../../hooks/useMobileBridge.js";
import { canSendSession } from "../../lib/conversation-timeline.js";
import type { UploadFileHandler } from "../../lib/file-upload.js";
import { desktopRuntimeId } from "../../lib/runtime-labels.js";
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
  steer: boolean;
  imageError?: string | undefined;
}

export interface MobileComposerProps {
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
  steer: boolean;
  imageError: string | undefined;
  canAttachImages: boolean;
  bridgeRunning: boolean;
  commandDraft: boolean;
  hasDraft: boolean;
  stopTarget: BridgeSessionInfo | undefined;
  stopping: boolean;
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
  steer,
  imageError,
  canAttachImages,
  bridgeRunning,
  commandDraft,
  hasDraft,
  stopTarget,
  stopping,
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
              <button type="button" aria-label={`移除 ${attachment.name}`} onClick={() => updateDraft((current) => ({ ...current, attachments: current.attachments.filter((item) => item.id !== attachment.id) }))}>
                <X size={13} />
              </button>
            </span>
          ))}
        </div>
      )}
      {imageError && <div className="composer-error" role="alert">{imageError}</div>}
      {bridgeRunning && !commandDraft && (desktopRuntimeId(selectedSession) === "claude-desktop" ? canSendSession(selectedSession, snapshot) && selectedSession.allowedActions?.canSteer === true : selectedSession.allowedActions?.canSteer !== false) && (
        <div className="composer-mode" role="group" aria-label="发送方式">
          <button type="button" className={!steer ? "active" : ""} onClick={() => updateDraft((current) => ({ ...current, steer: false }))}>排到下一轮</button>
          <button type="button" className={steer ? "active" : ""} onClick={() => updateDraft((current) => ({ ...current, steer: true }))}>立即调整</button>
        </div>
      )}
      <form
        className={(canAttachImages || Boolean(onUploadFile)) ? "composer-form composer-form--with-attachment" : "composer-form"}
        onSubmit={(event) => { event.preventDefault(); void sendMessage(); }}
      >
        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/gif,image/webp"
          multiple
          hidden
          onChange={(event) => void addImages(event.target.files)}
        />
        {(canAttachImages || Boolean(onUploadFile)) && (
          <ComposerAttachmentMenu
            canAttachImages={canAttachImages}
            imageDisabled={commandDraft || !canSendSession(selectedSession, snapshot)}
            onPickImages={() => fileRef.current?.click()}
            {...(onUploadFile ? {
              fileUploads,
              fileDisabled: commandDraft || !canSendSession(selectedSession, snapshot) || sending || connection !== "connected" || !desktopOnline,
            } : {})}
          />
        )}
        <SlashCommandInput
          key={draftKey}
          textareaRef={composerRef}
          {...(onLoadSessionCommands && snapshot?.host.capabilities.includes("session.commands.v1") && desktopRuntimeId(selectedSession) === "claude-desktop" && loadCommands ? {
            onLoad: loadCommands,
          } : {})}
          value={text}
          onChange={(value) => updateDraft((current) => ({ ...current, text: value }))}
          disabled={!canSendSession(selectedSession, snapshot)}
          placeholder={desktopRuntimeId(selectedSession) === "claude-desktop" && !canSendSession(selectedSession, snapshot) ? "请连接 Claude Desktop 原生会话" : desktopOnline
            ? selectedSession.allowedActions?.reason ?? (
                selectedSession.source === "bridge"
                  ? "给这个 Bridge 会话发指令"
                  : `给这个 ${runtimeName} 会话发指令`
              )
            : "电脑离线，消息会保存在手机并自动送达"}
          aria-label={`给 ${runtimeName} 发指令`}
        />
        {stopTarget && !hasDraft && !sending ? (
          <button
            type="button"
            className="send-button is-stop"
            aria-label={stopTarget.sessionId === selectedSession.sessionId ? "停止任务" : "停止阻塞任务"}
            disabled={stopping}
            onClick={onOpenStopConfirm}
          >
            {stopping ? <LoaderCircle className="is-spinning" size={19} /> : <Square size={15} fill="currentColor" />}
          </button>
        ) : (
          <button
            type="submit"
            className="send-button"
            aria-label="发送"
            disabled={!canSendSession(selectedSession, snapshot) || sending || fileUploads.uploading || !hasDraft}
          >
            {sending ? <LoaderCircle className="is-spinning" size={19} /> : <Send size={19} />}
          </button>
        )}
      </form>
    </section>
  );
}
