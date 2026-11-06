import { Activity, ChevronRight, Gauge, Moon, Settings2, Sun } from "lucide-react";
import type { ThemeControl } from "../hooks/useTheme.js";
import { setDiagDialogOpen } from "../lib/diagnostics.js";
import type { BridgeHostSnapshot } from "@bridge/protocol";
import type { AgentVisibilityControl } from "../hooks/useAgentVisibility.js";
import { AgentSettings } from "./AgentSettings.js";
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
  </section>;
}

export function MobileSettings({ themeControl, agentVisibility, snapshot, quota, providers }: {
  themeControl: ThemeControl;
  agentVisibility: AgentVisibilityControl;
  snapshot?: BridgeHostSnapshot;
  quota?: { desktopName: string; onOpen(): void };
  providers?: { desktopName: string; onOpen(): void };
}) {
  return <main className="mobile-workspace mobile-settings-page">
    <MobilePageHeader title="设置" />
    <div className="mobile-settings-content">
      {providers && <section className="mobile-settings-group">
        <h2>提供方</h2><button type="button" className="mobile-settings-row" onClick={providers.onOpen}><Settings2 size={18} aria-hidden="true" /><div><strong>提供方与检测</strong><small>{providers.desktopName}</small></div><ChevronRight size={18} aria-hidden="true" /></button>
      </section>}
      {quota && <section className="mobile-settings-group" aria-labelledby="mobile-quota-title">
        <h2 id="mobile-quota-title">额度</h2><button type="button" className="mobile-settings-row" onClick={quota.onOpen}><Gauge size={18} aria-hidden="true" /><div><strong>Magpie 额度</strong><small>{quota.desktopName} · 各账号剩余额度与重置时间</small></div><ChevronRight size={18} aria-hidden="true" /></button>
      </section>}
      <AppearanceSettings themeControl={themeControl} />
      <AgentSettings control={agentVisibility} {...(snapshot ? { snapshot } : {})} />
      <section className="mobile-settings-group" aria-labelledby="mobile-support-title">
        <h2 id="mobile-support-title">诊断与支持</h2>
        <button type="button" className="mobile-settings-row" onClick={() => setDiagDialogOpen(true)}><Activity size={18} aria-hidden="true" /><div><strong>连接诊断与日志</strong><small>检查连接，记录和导出诊断日志</small></div><ChevronRight size={18} aria-hidden="true" /></button>
      </section>
    </div>
  </main>;
}
