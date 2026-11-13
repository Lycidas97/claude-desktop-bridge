import { Activity, ChevronRight, Gauge, Moon, Settings2, Sun } from "lucide-react";
import { FONT_SIZES, type ThemeControl } from "../../hooks/useTheme.js";
import { useClientUpdater } from "../../lib/client-updater.js";
import { setDiagDialogOpen } from "../../lib/diagnostics.js";
import {
  MobileClientUpdaterSection,
  RemoteDesktopUpdaterSection,
  type ClientUpdaterHandle,
  type RemoteDesktopUpdateControl,
} from "../updater/UpdaterSections.js";
import { MobilePageHeader } from "./MobilePageHeader.js";

export function AppearanceSettings({ themeControl }: { themeControl: ThemeControl }) {
  return <section className="mobile-settings-group" aria-labelledby="appearance-title">
    <h2 id="appearance-title">外观</h2>
    <div className="mobile-settings-row"><span>显示模式</span><div className="segmented" role="group" aria-label="显示模式">
      <button type="button" className={themeControl.theme === "light" ? "active" : ""} aria-pressed={themeControl.theme === "light"} onClick={() => themeControl.setTheme("light")}><Sun size={16} /><span>浅色</span></button>
      <button type="button" className={themeControl.theme === "dark" ? "active" : ""} aria-pressed={themeControl.theme === "dark"} onClick={() => themeControl.setTheme("dark")}><Moon size={16} /><span>深色</span></button>
    </div></div>
    <div className="mobile-settings-row"><span>风格</span><div className="segmented" role="group" aria-label="主题风格">
      <button type="button" className={themeControl.family === "sunstone" ? "active" : ""} aria-pressed={themeControl.family === "sunstone"} onClick={() => themeControl.setFamily("sunstone")}>Sunstone</button>
      <button type="button" className={themeControl.family === "apple" ? "active" : ""} aria-pressed={themeControl.family === "apple"} onClick={() => themeControl.setFamily("apple")}>Apple</button>
    </div></div>
    <div className="mobile-settings-row font-size-settings-row"><span>字号</span><div className="segmented" role="group" aria-label="字号">
      {FONT_SIZES.map(size => <button type="button" key={size} className={(themeControl.fontSize ?? "standard") === size ? "active" : ""} aria-pressed={(themeControl.fontSize ?? "standard") === size} onClick={() => themeControl.setFontSize?.(size)}>{({ small: "小", standard: "标准", large: "大", larger: "更大" })[size]}</button>)}
    </div></div>
  </section>;
}

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
      {(providers || quota) && <section className="mobile-settings-group" aria-labelledby="mobile-computer-settings-title">
        <h2 id="mobile-computer-settings-title">当前电脑 · {providers?.desktopName ?? quota?.desktopName}</h2>
        {providers && <button type="button" className="mobile-settings-row" onClick={providers.onOpen}><Settings2 size={18} aria-hidden="true" /><div><strong>模型与网关</strong></div><ChevronRight size={18} aria-hidden="true" /></button>}
        {quota && <button type="button" className="mobile-settings-row" onClick={quota.onOpen}><Gauge size={18} aria-hidden="true" /><div><strong>Magpie 额度</strong><small>各账号剩余额度与重置时间</small></div><ChevronRight size={18} aria-hidden="true" /></button>}
      </section>}
      {remoteDesktop && <RemoteDesktopUpdaterSection remote={remoteDesktop} heading="远端桌面状态" />}
      <AppearanceSettings themeControl={themeControl} />
      <MobileClientUpdaterSection updater={resolvedUpdater} />
      <section className="mobile-settings-group" aria-labelledby="mobile-support-title">
        <h2 id="mobile-support-title">诊断与支持</h2>
        <button type="button" className="mobile-settings-row" onClick={() => setDiagDialogOpen(true)}><Activity size={18} aria-hidden="true" /><div><strong>连接诊断与日志</strong><small>检查连接，记录和导出诊断日志</small></div><ChevronRight size={18} aria-hidden="true" /></button>
      </section>
    </div>
  </main>;
}
