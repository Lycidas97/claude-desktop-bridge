import type { BridgeHostSnapshot } from "@bridge/protocol";
import { Activity, Bell, ChevronRight, Gauge, LoaderCircle, Play, Settings2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { ThemeControl } from "../../hooks/useTheme.js";
import { useClientUpdater } from "../../lib/client-updater.js";
import { setDiagDialogOpen, useDiagnosticLogs } from "../../lib/diagnostics.js";
import {
  getSessionNotificationPermissionState,
  isSessionNotificationsEnabled,
  requestSessionNotificationPermission,
  setSessionNotificationsEnabled,
  type SessionNotificationPermissionState,
} from "../../lib/session-notifications.js";
import { AppearanceSettings } from "../common/AppearanceSettings.js";
import { SettingsGroup } from "../common/SettingsGroup.js";
import {
  MobileClientUpdaterSection,
  RemoteDesktopUpdaterSection,
  type ClientUpdaterHandle,
  type RemoteDesktopUpdateControl,
} from "../updater/UpdaterSections.js";
import {
  resolveClaudeRemoteActivationDetail,
  resolveClaudeRemoteActivationStatus,
  useClaudeRemoteActivation,
  type MobileInspectorCalloutProps,
} from "./MobileInspectorCallout.js";
import { MobilePageHeader } from "./MobilePageHeader.js";

function initialSyncNotificationPermission(): SessionNotificationPermissionState {
  if (typeof window !== "undefined" && window.bridgeDesktop) return "unsupported";
  if (typeof Notification !== "undefined") {
    if (Notification.permission === "granted") return "granted";
    if (Notification.permission === "denied") return "denied";
    return "prompt";
  }
  return "prompt";
}

export interface MobileClaudeRuntimeSettingsControl {
  desktopName: string;
  snapshot: BridgeHostSnapshot | undefined;
  connected: boolean;
  onActivate: NonNullable<MobileInspectorCalloutProps["onActivate"]>;
}

export function MobileSettings({
  themeControl,
  quota,
  providers,
  claudeRuntime,
  remoteDesktop,
  clientUpdater,
}: {
  themeControl: ThemeControl;
  quota?: { desktopName: string; onOpen(): void };
  providers?: { desktopName: string; onOpen(): void };
  claudeRuntime?: MobileClaudeRuntimeSettingsControl | undefined;
  remoteDesktop?: RemoteDesktopUpdateControl | undefined;
  clientUpdater?: ClientUpdaterHandle | undefined;
}) {
  const fallbackUpdater = useClientUpdater(false);
  const resolvedUpdater = clientUpdater ?? fallbackUpdater;
  const { enabled: diagEnabled } = useDiagnosticLogs();

  const [notificationsEnabled, setNotificationsEnabled] = useState<boolean>(
    () => isSessionNotificationsEnabled(),
  );
  const [notificationPermission, setNotificationPermission] = useState<SessionNotificationPermissionState>(
    () => initialSyncNotificationPermission(),
  );
  const [requestingPermission, setRequestingPermission] = useState(false);

  const claudeStatus = resolveClaudeRemoteActivationStatus(claudeRuntime?.snapshot);
  const { busy: claudeBusy, feedback: claudeFeedback, activate: activateClaude } = useClaudeRemoteActivation(
    claudeRuntime?.onActivate, claudeRuntime?.snapshot, claudeStatus,
  );
  const computerHeadingName = providers?.desktopName ?? quota?.desktopName ?? claudeRuntime?.desktopName;

  useEffect(() => {
    let active = true;
    const syncPermission = () => {
      void getSessionNotificationPermissionState().then((next) => {
        if (active) setNotificationPermission(next);
      });
    };
    syncPermission();
    if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
      const onVisibility = () => {
        if (document.visibilityState === "visible") syncPermission();
      };
      document.addEventListener("visibilitychange", onVisibility);
      return () => {
        active = false;
        document.removeEventListener("visibilitychange", onVisibility);
      };
    }
    return () => {
      active = false;
    };
  }, []);

  async function handleRequestNotificationPermission(): Promise<void> {
    if (requestingPermission) return;
    setRequestingPermission(true);
    try {
      const result = await requestSessionNotificationPermission();
      setNotificationPermission(result);
    } finally {
      setRequestingPermission(false);
    }
  }

  const claudeGuidance = claudeRuntime?.connected && claudeRuntime.snapshot
    ? claudeFeedback?.detail ?? (claudeStatus.nativeUnavailable && (
      claudeStatus.cannotActivate
      || claudeStatus.inspector?.startup?.state === "accessibility-required"
      || claudeStatus.inspector?.startup?.state === "failed"
    ) ? resolveClaudeRemoteActivationDetail(claudeRuntime.snapshot) : undefined)
    : undefined;

  return (
    <main className="mobile-workspace mobile-settings-page">
      <MobilePageHeader title="设置" />
      <div className="mobile-settings-content">
        {(providers || quota || claudeRuntime) && (
          <SettingsGroup title={`当前电脑 · ${computerHeadingName}`} titleId="mobile-computer-settings-title">
            {providers && (
              <button type="button" className="mobile-settings-row" onClick={providers.onOpen}>
                <Settings2 size={18} aria-hidden="true" />
                <div><strong>模型与网关</strong></div>
                <ChevronRight size={18} aria-hidden="true" />
              </button>
            )}
            {quota && (
              <button type="button" className="mobile-settings-row" onClick={quota.onOpen}>
                <Gauge size={18} aria-hidden="true" />
                <div>
                  <strong>Magpie 额度</strong>
                  <small>各账号剩余额度与重置时间</small>
                </div>
                <ChevronRight size={18} aria-hidden="true" />
              </button>
            )}
            {claudeRuntime && (
              <>
                <div className="mobile-settings-row">
                  <span>
                    <strong>Claude 调试端口 (9229)</strong>
                    <small>
                      {!claudeRuntime.connected
                        ? "电脑已离线"
                        : claudeStatus.claudeApp?.state === "stopped"
                          ? "Claude Desktop 未启动"
                          : claudeStatus.portLabel === "已开启"
                            ? (claudeStatus.nativeUnavailable ? "Claude 原生连接未就绪" : "Claude Desktop 已就绪")
                            : "调试端口未开启"}
                    </small>
                  </span>
                  {claudeRuntime.connected && claudeRuntime.snapshot && (claudeStatus.nativeUnavailable || claudeBusy) ? (
                    <button
                      type="button"
                      className="primary-button mobile-settings-compact-btn"
                      disabled={claudeBusy || claudeStatus.cannotActivate}
                      onClick={() => void activateClaude()}
                    >
                      {claudeBusy ? (
                        <>
                          <LoaderCircle size={14} className="is-spinning" aria-hidden="true" />
                          <span>正在开启…</span>
                        </>
                      ) : (
                        <>
                          <Play size={13} aria-hidden="true" />
                          <span>{claudeStatus.claudeApp?.state === "stopped" ? "启动 Claude" : claudeStatus.buttonLabel}</span>
                        </>
                      )}
                    </button>
                  ) : (
                    <span className="mobile-settings-value">
                      {claudeRuntime.connected && claudeRuntime.snapshot ? claudeStatus.portLabel : "未连接"}
                    </span>
                  )}
                </div>
                {claudeGuidance && (
                  <p className={claudeFeedback?.error ? "mobile-settings-row updater-error" : "mobile-settings-row detail-text"} role="status">
                    {claudeGuidance}
                  </p>
                )}
              </>
            )}
          </SettingsGroup>
        )}
        {remoteDesktop && <RemoteDesktopUpdaterSection remote={remoteDesktop} heading="远端桌面状态" />}
        <AppearanceSettings themeControl={themeControl} />
        <SettingsGroup title="任务通知" titleId="mobile-notifications-title">
          <div className="mobile-settings-row">
            <span>
              <strong>任务通知</strong>
              <small>后台或浏览其他会话时提醒任务完成与待授权</small>
            </span>
            <div className="segmented mobile-settings-compact-segmented" role="group" aria-label="任务通知开关">
              <button
                type="button"
                className={notificationsEnabled ? "active" : ""}
                aria-pressed={notificationsEnabled}
                onClick={() => {
                  setSessionNotificationsEnabled(true);
                  setNotificationsEnabled(true);
                  if (notificationPermission === "prompt") {
                    void handleRequestNotificationPermission();
                  }
                }}
              >
                开启
              </button>
              <button
                type="button"
                className={!notificationsEnabled ? "active" : ""}
                aria-pressed={!notificationsEnabled}
                onClick={() => {
                  setSessionNotificationsEnabled(false);
                  setNotificationsEnabled(false);
                }}
              >
                关闭
              </button>
            </div>
          </div>
          <div className="mobile-settings-row">
            <Bell size={18} aria-hidden="true" />
            <span>系统通知状态</span>
            {notificationPermission === "granted" ? (
              <span className="mobile-settings-value">已开启</span>
            ) : notificationPermission === "unsupported" ? (
              <span className="mobile-settings-value">当前环境不支持</span>
            ) : (
              <div className="mobile-settings-inline-action">
                <span className="mobile-settings-value">系统通知未授权</span>
                <button
                  type="button"
                  className="secondary-button mobile-settings-compact-btn"
                  disabled={requestingPermission}
                  onClick={() => void handleRequestNotificationPermission()}
                >
                  {requestingPermission ? "请求中…" : "授权通知"}
                </button>
              </div>
            )}
          </div>
        </SettingsGroup>
        <MobileClientUpdaterSection updater={resolvedUpdater} />
        <SettingsGroup title="诊断与支持" titleId="mobile-support-title">
          <button type="button" className="mobile-settings-row" onClick={() => setDiagDialogOpen(true)}>
            <Activity size={18} aria-hidden="true" />
            <div>
              <strong>连接诊断与日志</strong>
              <small>检查连接，记录和导出诊断日志</small>
            </div>
            {diagEnabled && <b className="settings-diag-badge">记录中</b>}
            <ChevronRight size={18} aria-hidden="true" />
          </button>
        </SettingsGroup>
      </div>
    </main>
  );
}
