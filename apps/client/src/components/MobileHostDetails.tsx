import type {
  BridgeDesktopAppStatus,
  BridgeDesktopRuntimeId,
  BridgeHostSnapshot,
  BridgeTransportMetrics,
  SocketState,
} from "@bridge/protocol";
import { Activity, ArrowLeft, LoaderCircle, Play, Power, RefreshCw, Trash2 } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import type { MobileConnectionIssue } from "../hooks/useMobileBridge.js";
import { setDiagDialogOpen } from "../lib/diagnostics.js";
import { registerMobileBackHandler } from "../lib/mobile-back-navigation.js";
import { desktopRuntimeName } from "../lib/runtime-labels.js";
import { ConfirmationDialog } from "./ConfirmationDialog.js";
import { IconButton } from "./IconButton.js";

export interface MobileHostDetailsProps {
  activeHostId: string;
  desktopName: string;
  connection: SocketState;
  desktopOnline: boolean;
  snapshot: BridgeHostSnapshot | undefined;
  transportMetrics?: BridgeTransportMetrics | undefined;
  pendingOutbound?: number | undefined;
  connectionIssue?: MobileConnectionIssue | undefined;
  onRetry(): Promise<void>;
  onRefresh(): Promise<boolean>;
  onDesktopAppAction(runtimeId: BridgeDesktopRuntimeId, action: "launch" | "quit"): Promise<BridgeDesktopAppStatus[]>;
  onRemove(): Promise<void>;
  onBack(): void;
  permissionSettings?: ReactNode;
}

export function MobileHostDetails({
  activeHostId,
  desktopName,
  connection,
  desktopOnline,
  snapshot,
  transportMetrics,
  pendingOutbound,
  connectionIssue,
  onRetry,
  onRefresh,
  onDesktopAppAction,
  onRemove,
  onBack,
  permissionSettings,
}: MobileHostDetailsProps) {
  const [connectionAction, setConnectionAction] = useState<"retry" | "refresh">();
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [desktopAction, setDesktopAction] = useState<{ runtimeId: BridgeDesktopRuntimeId; action: "launch" | "quit" }>();
  const [desktopActionError, setDesktopActionError] = useState<{ runtimeId: BridgeDesktopRuntimeId; message: string }>();
  const [quitDesktopTarget, setQuitDesktopTarget] = useState<BridgeDesktopRuntimeId>();
  const [removeOpen, setRemoveOpen] = useState(false);
  const [removing, setRemoving] = useState(false);

  useEffect(() => registerMobileBackHandler(() => {
    if (!removing) onBack();
    return true;
  }, 50), [onBack, removing]);

  useEffect(() => {
    if (!removeOpen && !quitDesktopTarget) return;
    return registerMobileBackHandler(() => {
      if (removeOpen) {
        if (!removing) setRemoveOpen(false);
      } else {
        setQuitDesktopTarget(undefined);
      }
      return true;
    }, 200);
  }, [removeOpen, removing, quitDesktopTarget]);

  async function runConnectionAction(action: "retry" | "refresh"): Promise<void> {
    if (connectionAction) return;
    setConnectionAction(action);
    setNotice("");
    setError("");
    try {
      if (action === "retry") {
        await onRetry();
      } else {
        setNotice(await onRefresh() ? "已同步电脑状态" : "电脑暂未响应同步，请稍后重试。");
      }
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError));
    } finally {
      setConnectionAction(undefined);
    }
  }

  async function runDesktopAppAction(runtimeId: BridgeDesktopRuntimeId, action: "launch" | "quit"): Promise<void> {
    if (desktopAction) return;
    if (action === "quit") setQuitDesktopTarget(undefined);
    setDesktopAction({ runtimeId, action });
    setDesktopActionError(undefined);
    try {
      await onDesktopAppAction(runtimeId, action);
    } catch (actionError) {
      setDesktopActionError({
        runtimeId,
        message: actionError instanceof Error ? actionError.message : String(actionError),
      });
    } finally {
      setDesktopAction(undefined);
    }
  }

  async function removeHost(): Promise<void> {
    if (removing) return;
    setRemoving(true);
    setError("");
    try {
      await onRemove();
      setRemoveOpen(false);
      onBack();
    } catch (removeError) {
      setRemoveOpen(false);
      setError(removeError instanceof Error ? removeError.message : String(removeError));
    } finally {
      setRemoving(false);
    }
  }

  const desktopApps = snapshot?.desktopApps ?? [{
    id: "claude-desktop" as const,
    name: "Claude Desktop",
    state: snapshot?.claudeDesktop?.state ?? "unavailable",
    detail: snapshot?.claudeDesktop?.detail ?? "正在读取电脑端运行状态。",
    canLaunch: snapshot?.claudeDesktop?.canLaunch ?? false,
    canQuit: snapshot?.claudeDesktop?.canQuit ?? false,
  }];

  return (
    <main className="mobile-workspace mobile-settings-page mobile-host-details" data-host-id={activeHostId}>
      <header className="mobile-page-header">
        <IconButton label="返回电脑列表" disabled={removing} onClick={onBack}><ArrowLeft size={21} /></IconButton>
        <div>
          <h1>{desktopName}</h1>
          <p className="detail-text">当前电脑</p>
        </div>
      </header>

      <div className="mobile-settings-content">
      <section className="mobile-settings-group" aria-labelledby="host-connection-title">
        <h2 id="host-connection-title">连接与同步</h2>
        <div className="mobile-settings-row">
          <span>电脑状态</span>
          <span className="mobile-settings-value">{desktopOnline ? "在线" : "离线"}</span>
        </div>
        <div className="mobile-settings-row">
          <span>连接状态</span>
          <span className="mobile-settings-value">{{ idle: "尚未连接", connecting: "正在连接", connected: "已连接", reconnecting: "正在重连", closed: "连接已关闭" }[connection]}</span>
        </div>
        <div className="mobile-settings-row">
          <span>连接方式</span>
          <span className="mobile-settings-value">{transportMetrics ? { direct: "直连", "public-relay": "安全中继", "lan-relay": "局域网连接" }[transportMetrics.path] : "等待连接"}</span>
        </div>
        {transportMetrics?.rttMs !== undefined && (
          <div className="mobile-settings-row">
            <span>连接延迟</span><span className="mobile-settings-value">{Math.round(transportMetrics.rttMs)} ms</span>
          </div>
        )}
        {pendingOutbound !== undefined && (
          <div className="mobile-settings-row">
            <span>待发送消息</span><span className="mobile-settings-value">{pendingOutbound}</span>
          </div>
        )}
        {snapshot?.host.version && (
          <div className="mobile-settings-row">
            <span>电脑端版本</span><span className="mobile-settings-value">{snapshot.host.version}</span>
          </div>
        )}
        {connectionIssue && <p className="inline-error" role="alert">{connectionIssue.message}</p>}
        <div className="mobile-settings-row mobile-settings-actions">
          <button type="button" className="secondary-button" disabled={Boolean(connectionAction) || removing} onClick={() => void runConnectionAction("retry")}>
            {connectionAction === "retry" && <LoaderCircle className="is-spinning" size={16} />}
            {connectionAction === "retry" ? "重连中" : "重新连接"}
          </button>
          <button type="button" className="secondary-button" disabled={Boolean(connectionAction) || removing} onClick={() => void runConnectionAction("refresh")}>
            {connectionAction === "refresh" ? <LoaderCircle className="is-spinning" size={16} /> : <RefreshCw size={16} />}
            {connectionAction === "refresh" ? "同步中" : "强制同步"}
          </button>
        </div>
        {notice && <p className="detail-text" role="status">{notice}</p>}
        <button type="button" className="mobile-settings-row" onClick={() => setDiagDialogOpen(true)}>
          <Activity size={18} /><span>连接诊断与日志</span>
        </button>
      </section>

      <section className="mobile-settings-group" aria-labelledby="host-desktop-apps-title">
        <h2 id="host-desktop-apps-title">桌面应用控制</h2>
        {desktopApps.map((desktopApp) => (
          <section className={`mobile-desktop-control ${desktopApp.state}`} key={desktopApp.id}>
            <div className="mobile-desktop-control-copy">
              <i aria-hidden="true" />
              <span>
                <strong>{desktopApp.name}</strong>
                <small className={desktopActionError?.runtimeId === desktopApp.id ? "desktop-app-error" : undefined}>
                  {desktopActionError?.runtimeId === desktopApp.id ? desktopActionError.message : desktopApp.detail}
                </small>
              </span>
            </div>
            <div className="mobile-desktop-control-actions">
              <button
                type="button"
                className="secondary-button"
                disabled={Boolean(desktopAction) || removing || !desktopOnline || !desktopApp.canLaunch}
                onClick={() => void runDesktopAppAction(desktopApp.id, "launch")}
              >
                <Play size={15} />
                {desktopAction?.runtimeId === desktopApp.id && desktopAction.action === "launch" ? "启动中" : "启动"}
              </button>
              <button
                type="button"
                className="danger-button"
                disabled={Boolean(desktopAction) || removing || !desktopOnline || !desktopApp.canQuit}
                onClick={() => setQuitDesktopTarget(desktopApp.id)}
              >
                <Power size={15} />
                {desktopAction?.runtimeId === desktopApp.id && desktopAction.action === "quit" ? "退出中" : "退出"}
              </button>
            </div>
          </section>
        ))}
      </section>

      {permissionSettings}

      <section className="mobile-settings-group" aria-label="移除电脑">
        <button type="button" className="mobile-settings-row danger" disabled={removing} onClick={() => setRemoveOpen(true)}>
          <Trash2 size={18} /><span>移除这台电脑</span>
        </button>
        <p className="detail-text">清除这台电脑在手机上的密钥和消息，并撤销这台手机的访问权限。</p>
      </section>
      {error && <p className="inline-error" role="alert">{error}</p>}
      </div>

      <ConfirmationDialog
        open={Boolean(quitDesktopTarget)}
        title={`退出电脑上的 ${quitDesktopTarget ? desktopRuntimeName(quitDesktopTarget) : ""}？`}
        description={`${quitDesktopTarget ? desktopRuntimeName(quitDesktopTarget) : ""} 窗口会关闭，Bridge 主机仍保持在线，可继续管理已接管的远程会话。`}
        confirmLabel={`退出 ${quitDesktopTarget ? desktopRuntimeName(quitDesktopTarget) : ""}`}
        busy={desktopAction?.action === "quit"}
        danger
        onCancel={() => setQuitDesktopTarget(undefined)}
        onConfirm={() => {
          if (quitDesktopTarget) void runDesktopAppAction(quitDesktopTarget, "quit");
        }}
      />
      <ConfirmationDialog
        open={removeOpen}
        title="移除这台电脑？"
        description={`将清除“${desktopName}”在手机上的密钥和消息；电脑在线时也会同步撤销这台手机的权限。`}
        confirmLabel="移除电脑"
        danger
        busy={removing}
        onCancel={() => setRemoveOpen(false)}
        onConfirm={() => void removeHost()}
      />
    </main>
  );
}
