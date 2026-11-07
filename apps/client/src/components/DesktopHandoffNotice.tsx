import type { BridgeSessionInfo } from "@bridge/protocol";
import { ArrowRightLeft } from "lucide-react";
import { useState } from "react";
import { ConfirmationDialog } from "./ConfirmationDialog.js";

export function DesktopHandoffNotice({ session, online, className, onReturn, onTakeover, onRefresh, refreshing = false }: {
  session: BridgeSessionInfo;
  online: boolean;
  className: string;
  onReturn?(sessionId: string): Promise<void>;
  onTakeover?(sessionId: string): Promise<void>;
  onRefresh?(): void;
  refreshing?: boolean;
}) {
  const [busy, setBusy] = useState<"return" | "takeover">();
  const [error, setError] = useState<string>();
  const [confirming, setConfirming] = useState(false);
  const handoff = session.desktopHandoff;
  if (!handoff) return null;
  const queued = handoff.state === "close-desktop" && session.pendingCount > 0;

  async function returnToDesktop(): Promise<void> {
    if (!handoff?.canReturn || !online || !onReturn || busy) return;
    setBusy("return");
    setError(undefined);
    try {
      await onReturn(session.sessionId);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "交还 Desktop 失败");
    } finally {
      setBusy(undefined);
    }
  }

  async function takeoverDesktop(): Promise<void> {
    if (!handoff?.canTakeover || !online || !onTakeover || busy) return;
    setBusy("takeover");
    setError(undefined);
    try {
      await onTakeover(session.sessionId);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "接管 Desktop 会话失败");
    } finally {
      setBusy(undefined);
      setConfirming(false);
    }
  }

  return (
    <>
      <div className={`${className}${error ? " danger" : ""}`} role="status" aria-label={queued ? "消息排队状态" : "Desktop 会话交接"}>
        <ArrowRightLeft size={17} />
        <span>
          <strong>{handoff.state === "desktop-inbox"
            ? !online
              ? "连接已断开，等待同步状态"
              : handoff.inputStatus === "queued"
                ? "消息等待发送"
                : handoff.inputStatus === "held" ? "等待 Desktop 接收许可" : "正在交给 Desktop"
            : queued
              ? !online ? "连接已断开，等待同步状态" : handoff.reason === "inbox-confirmation-expired" ? "Desktop 接收确认已过期" : "等待关闭此 Desktop 会话"
              : handoff.state === "close-desktop"
                ? "请关闭此 Desktop 会话"
                : handoff.state === "reopen-desktop" ? "请重新打开 Desktop 会话" : "由 Bridge 接续"}</strong>
          {handoff.state === "desktop-inbox"
            ? !online
              ? "上次同步的接收状态尚未确认。"
              : handoff.inputStatus === "queued"
                ? "当前主轮结束后会自动交给 Desktop。"
                : handoff.inputStatus === "held"
                  ? "请在电脑端允许接收这条消息；尚未交给会话处理，无需重复发送。"
                  : "等待原会话确认接收。"
            : queued && !online
              ? `上次同步时有 ${session.pendingCount} 条消息排队，当前进度尚未确认。`
              : handoff.state === "close-desktop"
                ? handoff.reason === "inbox-confirmation-expired"
                  ? "消息仍保留在电脑队列中，不会再次投递到同一收件箱。可确认接管此会话，由 Bridge 继续处理；仅等待空闲不会交接。"
                  : `${queued ? `${session.pendingCount} 条消息已到电脑。` : ""}请关闭此会话的 Desktop 执行进程，或接管此会话；仅等待空闲不会交接。`
                : handoff.state === "reopen-desktop"
                  ? "请在 Claude Desktop 中关闭并重新打开此会话，加载手机端产生的历史。"
                  : handoff.canReturn
                    ? "交还后需在 Desktop 重新打开此会话。"
                    : "主任务、后台任务和排队消息结束后可交还。"}
          {error && <span role="alert"><br />{error}</span>}
        </span>
        {(handoff.state === "bridge" || (handoff.state === "close-desktop" && handoff.canReturn)) && (
          <button
            type="button"
            className="secondary-button"
            disabled={!handoff.canReturn || !online || !onReturn || Boolean(busy)}
            onClick={() => void returnToDesktop()}
          >
            {busy === "return" ? "交还中" : "交还 Desktop"}
          </button>
        )}
        {handoff.state === "close-desktop" && (
          <button
            type="button"
            className="secondary-button"
            disabled={!handoff.canTakeover || !online || !onTakeover || Boolean(busy)}
            onClick={() => {
              if (handoff.canTakeover && online && onTakeover && !busy) setConfirming(true);
            }}
          >
            {busy === "takeover" ? "接管中" : "接管此会话"}
          </button>
        )}
        {queued && onRefresh && (
          <button type="button" className="secondary-button" disabled={refreshing || !online} onClick={onRefresh}>
            {refreshing ? "同步中" : "同步状态"}
          </button>
        )}
      </div>
      <ConfirmationDialog
        open={confirming}
        title="接管此会话？"
        description="仅结束此会话的 Desktop 执行进程，保留 Desktop 应用和其他会话，然后由 Bridge 继续执行排队消息。等待中的提问将被取消，已发送的回答会保留并继续处理。仍有任务或子代理运行时，接管会被拒绝。"
        confirmLabel="确认接管"
        busy={Boolean(busy)}
        danger
        onCancel={() => { if (!busy) setConfirming(false); }}
        onConfirm={() => void takeoverDesktop()}
      />
    </>
  );
}
