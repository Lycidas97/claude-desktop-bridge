import { Activity, Bell, ChevronRight, Gauge, Laptop, Settings2 } from "lucide-react";
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
import { MobileClientUpdaterSection, type ClientUpdaterHandle } from "../updater/UpdaterSections.js";
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

export function MobileSettings({
  themeControl,
  computer,
  quota,
  providers,
  clientUpdater,
}: {
  themeControl: ThemeControl;
  // Remote version, update channel and the debug port live in this computer's connection settings.
  computer?: { desktopName: string; onOpen(): void };
  quota?: { onOpen(): void };
  providers?: { onOpen(): void };
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

  return (
    <main className="mobile-workspace mobile-settings-page">
      <MobilePageHeader title="设置" />
      <div className="mobile-settings-content">
        {computer && (
          <SettingsGroup title={`当前电脑 · ${computer.desktopName}`} titleId="mobile-computer-settings-title">
            <button type="button" className="mobile-settings-row" onClick={computer.onOpen}>
              <Laptop size={18} aria-hidden="true" />
              <div><strong>连接与电脑设置</strong></div>
              <ChevronRight size={18} aria-hidden="true" />
            </button>
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
                <div><strong>Magpie 额度</strong></div>
                <ChevronRight size={18} aria-hidden="true" />
              </button>
            )}
          </SettingsGroup>
        )}
        <AppearanceSettings themeControl={themeControl} />
        <SettingsGroup title="通知" titleId="mobile-notifications-title">
          <div className="mobile-settings-row">
            <span><strong>任务通知</strong></span>
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
            <span><strong>连接诊断与日志</strong></span>
            {diagEnabled && <b className="settings-diag-badge">记录中</b>}
            <ChevronRight size={18} aria-hidden="true" />
          </button>
        </SettingsGroup>
      </div>
    </main>
  );
}
