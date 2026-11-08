import type { BridgeSessionInfo } from "@bridge/protocol";
import { ArrowRightLeft } from "lucide-react";
import { useState } from "react";
import { ConfirmationDialog } from "./ConfirmationDialog.js";

export function DesktopHandoffNotice({ session, online, className, onReturn, onTakeover, onRefresh, refreshing = false }: {
  session: BridgeSessionInfo;
  online: boolean;
  className: string;
  onReturn?(sessionId: string): Promise<void>;
  onTakeover?(sessionId: string, commandId?: string): Promise<void>;
  onRefresh?(): void;
  refreshing?: boolean;
}) {
  const [busy, setBusy] = useState<"return" | "takeover">();
  const [error, setError] = useState<string>();
  const [confirming, setConfirming] = useState(false);
  const handoff = session.desktopHandoff;
  if (!handoff) return null;
  const queued = handoff.state === "close-desktop" && session.pendingCount > 0;
  const requested = handoff.reason === "bridge-execution-requested";
  const remoteCommandId = queued && (requested || session.allowedActions?.canRequestBridgeExecution)
    ? session.pendingCommandIds?.[0] : undefined;
  const canTakeover = Boolean((!requested || handoff.error) && (remoteCommandId || handoff.canTakeover));
  const failure = error ?? handoff.error;

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
    if (!canTakeover || !online || !onTakeover || busy) return;
    setBusy("takeover");
    setError(undefined);
    try {
      if (remoteCommandId) await onTakeover(session.sessionId, remoteCommandId);
      else await onTakeover(session.sessionId);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "接管 Desktop 会话失败");
    } finally {
      setBusy(undefined);
      setConfirming(false);
    }
  }

  return (
    <>
      <div className={`${className}${failure ? " danger" : ""}`} role="status" aria-label={queued ? "消息排队状态" : "Desktop 会话交接"}>
        <ArrowRightLeft size={17} />
        <span>
          <strong>{requested
            ? !online ? "连接已断开，等待同步状态" : failure ? "交接未完成" : "等待交接给 Bridge"
            : handoff.state === "desktop-inbox"
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
          {requested
            ? !online ? "交接进度尚未同步，消息仍保留在电脑队列中。" : failure ? "消息已保留，可确认后重试交接。" : "当前工作结束后自动继续，排队消息已保留，无需到电脑允许接收。"
            : handoff.state === "desktop-inbox"
            ? !online
              ? "上次同步的接收状态尚未确认。"
              : handoff.inputStatus === "queued"
                ? "当前主轮结束后会自动交给 Desktop。"
                : handoff.inputStatus === "held"
                  ? "请在电脑端允许接收这条消息，完全授权不会代替此确认；无需重复发送。"
                  : "等待原会话确认接收。"
            : queued && !online
              ? `上次同步时有 ${session.pendingCount} 条消息排队，当前进度尚未确认。`
              : handoff.state === "close-desktop"
                ? handoff.reason === "inbox-confirmation-expired"
                  ? `消息仍保留在电脑队列中，不会再次投递到同一收件箱。${canTakeover ? "可确认接管此会话，由 Bridge 继续处理；仅等待空闲不会交接。" : "当前不可接管此会话。"}`
                  : `${queued ? `${session.pendingCount} 条消息已到电脑。` : ""}请关闭此会话的 Desktop 执行进程，或接管此会话；仅等待空闲不会交接。`
                : handoff.state === "reopen-desktop"
                  ? "请在 Claude Desktop 中关闭并重新打开此会话，加载手机端产生的历史。"
                  : handoff.canReturn
                    ? "交还后需在 Desktop 重新打开此会话。"
                    : "主任务、后台任务和排队消息结束后可交还。"}
          {failure && <span role="alert"><br />{failure}</span>}
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
        {handoff.state === "close-desktop" && (!requested || handoff.error) && (
          <button
            type="button"
            className="secondary-button"
            disabled={!canTakeover || !online || !onTakeover || Boolean(busy)}
            onClick={() => {
              if (canTakeover && online && onTakeover && !busy) setConfirming(true);
            }}
          >
            {busy === "takeover" ? "接管中" : handoff.error ? "重试交接" : "接管此会话"}
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
        title={remoteCommandId ? "由 Bridge 继续执行？" : "接管此会话？"}
        description={remoteCommandId
          ? "等待当前主任务、提问和后台任务结束后，仅结束此会话的闲置 Desktop 执行进程，保留历史并继续执行这条原排队消息。工具审批仍按当前授权设置。"
          : "仅结束此会话的 Desktop 执行进程，保留 Desktop 应用和其他会话，然后由 Bridge 继续执行排队消息。等待中的提问将被取消，已发送的回答会保留并继续处理。仍有任务或子代理运行时，接管会被拒绝。"}
        confirmLabel={remoteCommandId ? "确认继续" : "确认接管"}
        busy={Boolean(busy)}
        danger
        onCancel={() => { if (!busy) setConfirming(false); }}
        onConfirm={() => void takeoverDesktop()}
      />
    </>
  );
}
