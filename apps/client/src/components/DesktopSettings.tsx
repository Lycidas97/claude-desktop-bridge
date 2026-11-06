import type { BridgePermissionMode, BridgeSessionConfiguration, DesktopControlSnapshot } from "@bridge/protocol";
import { Download } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { AgentVisibilityControl } from "../hooks/useAgentVisibility.js";
import type { ThemeControl } from "../hooks/useTheme.js";
import type { DesktopApi } from "../runtime/desktop.js";
import { AgentSettings } from "./AgentSettings.js";
import { HostPermissionSettings } from "./HostPermissionSettings.js";
import { AppearanceSettings } from "./MobileSettings.js";
import { ProviderSettings } from "./ProviderSettings.js";
import "./settings.css";

const SECTIONS = [
  ["providers", "提供方"], ["permissions", "默认权限"], ["connections", "连接与设备"], ["appearance", "外观与显示"], ["about", "诊断与关于"],
] as const;

export function DesktopSettings({ snapshot, api, onSnapshot, themeControl, agentVisibility, connections }: {
  snapshot: DesktopControlSnapshot;
  api: DesktopApi;
  onSnapshot(snapshot: DesktopControlSnapshot): void;
  themeControl: ThemeControl;
  agentVisibility: AgentVisibilityControl;
  connections: ReactNode;
}) {
  const [section, setSection] = useState<typeof SECTIONS[number][0]>("providers");
  const [exportError, setExportError] = useState("");
  return <section className="desktop-settings-page">
    <header className="desktop-page-heading"><h1>设置</h1></header>
    <nav className="settings-sections" aria-label="设置分组">{SECTIONS.map(([value, label]) => <button type="button" key={value} className={section === value ? "active" : ""} aria-current={section === value ? "page" : undefined} onClick={() => setSection(value)}>{label}</button>)}</nav>
    <div className="settings-section-content">
      {section === "providers" && <ProviderSettings snapshot={snapshot} desktopLocal onRefresh={async () => {
        const response = await api.request({ method: "runtime.refresh", params: {} });
        if (!response.ok) throw new Error(response.error?.message ?? "检测失败");
        onSnapshot(await api.getSnapshot());
      }} onSetApiKey={async (value) => onSnapshot(await api.setAnthropicApiKey(value))} onRemoveApiKey={async () => onSnapshot(await api.removeAnthropicApiKey())} />}
      {section === "permissions" && <HostPermissionSettings snapshot={snapshot} onLoadSessionConfiguration={async (sessionId) => {
        const response = await api.request({ method: "session.configuration", params: { sessionId } });
        if (!response.ok) throw new Error(response.error?.message ?? "授权配置读取失败");
        return (response.result as { configuration: BridgeSessionConfiguration }).configuration;
      }} onConfigureHostPermission={async (runtimeId, mode, sessionId) => {
        const response = await api.request({ method: "permission.policy.configure", params: { scope: "host", runtimeId, mode, ...(sessionId ? { sessionId } : {}) } });
        if (!response.ok) throw new Error(response.error?.message ?? "默认授权保存失败");
        onSnapshot(await api.getSnapshot());
        return (response.result as { defaultPermissionMode: BridgePermissionMode }).defaultPermissionMode;
      }} />}
      {section === "connections" && connections}
      {section === "appearance" && <><AppearanceSettings themeControl={themeControl} /><AgentSettings control={agentVisibility} snapshot={snapshot} /></>}
      {section === "about" && <section className="mobile-settings-group">
        <h2>诊断与关于</h2>
        <dl className="settings-facts"><div><dt>Bridge 版本</dt><dd>{snapshot.host.version}</dd></div><div><dt>电脑</dt><dd>{snapshot.host.name}</dd></div></dl>
        <button type="button" className="secondary-button" onClick={() => { setExportError(""); void api.exportDiagnostics().catch((reason: unknown) => setExportError(reason instanceof Error ? reason.message : "诊断导出失败")); }}><Download size={16} />导出诊断</button>
        {exportError && <p role="alert" className="inline-error">{exportError}</p>}
      </section>}
    </div>
  </section>;
}
