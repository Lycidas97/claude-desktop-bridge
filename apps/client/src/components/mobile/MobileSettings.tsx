import { Activity, ChevronRight, Gauge, Settings2 } from "lucide-react";
import type { ThemeControl } from "../../hooks/useTheme.js";
import { AppearanceSettings } from "../common/AppearanceSettings.js";
import { SettingsGroup } from "../common/SettingsGroup.js";
import { useClientUpdater } from "../../lib/client-updater.js";
import { setDiagDialogOpen } from "../../lib/diagnostics.js";
import {
  MobileClientUpdaterSection,
  RemoteDesktopUpdaterSection,
  type ClientUpdaterHandle,
  type RemoteDesktopUpdateControl,
} from "../updater/UpdaterSections.js";
import { MobilePageHeader } from "./MobilePageHeader.js";

export function MobileSettings({ themeControl, quota, providers, remoteDesktop, clientUpdater }: {
  themeControl: ThemeControl;
  quota?: { desktopName: string; onOpen(): void };
  providers?: { desktopName: string; onOpen(): void };
  remoteDesktop?: RemoteDesktopUpdateControl | undefined;
  clientUpdater?: ClientUpdaterHandle | undefined;
}) {
  const fallbackUpdater = useClientUpdater(false);
  const resolvedUpdater = clientUpdater ?? fallbackUpdater;
  return <main className="mobile-workspace mobile-settings-page">
    <MobilePageHeader title="设置" />
    <div className="mobile-settings-content">
      {(providers || quota) && <SettingsGroup title={`当前电脑 · ${providers?.desktopName ?? quota?.desktopName}`} titleId="mobile-computer-settings-title">
        {providers && <button type="button" className="mobile-settings-row" onClick={providers.onOpen}><Settings2 size={18} aria-hidden="true" /><div><strong>模型与网关</strong></div><ChevronRight size={18} aria-hidden="true" /></button>}
        {quota && <button type="button" className="mobile-settings-row" onClick={quota.onOpen}><Gauge size={18} aria-hidden="true" /><div><strong>Magpie 额度</strong><small>各账号剩余额度与重置时间</small></div><ChevronRight size={18} aria-hidden="true" /></button>}
      </SettingsGroup>}
      {remoteDesktop && <RemoteDesktopUpdaterSection remote={remoteDesktop} heading="远端桌面状态" />}
      <AppearanceSettings themeControl={themeControl} />
      <MobileClientUpdaterSection updater={resolvedUpdater} />
      <SettingsGroup title="诊断与支持" titleId="mobile-support-title">
        <button type="button" className="mobile-settings-row" onClick={() => setDiagDialogOpen(true)}><Activity size={18} aria-hidden="true" /><div><strong>连接诊断与日志</strong><small>检查连接，记录和导出诊断日志</small></div><ChevronRight size={18} aria-hidden="true" /></button>
      </SettingsGroup>
    </div>
  </main>;
}
