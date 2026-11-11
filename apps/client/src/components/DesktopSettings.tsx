import type { DesktopControlSnapshot } from "@bridge/protocol";
import { Download } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { ThemeControl } from "../hooks/useTheme.js";
import type { ClaudeDesktopDeveloperSettings, ClaudeDesktopProfile, DesktopApi } from "../runtime/desktop.js";
import { AppearanceSettings } from "./MobileSettings.js";
import { ProviderSettings } from "./ProviderSettings.js";
import "./settings.css";

const SECTIONS = [
  ["providers", "提供方"], ["connections", "连接与设备"], ["appearance", "外观与显示"], ["about", "诊断与关于"],
] as const;

export function DesktopSettings({ snapshot, api, onSnapshot, themeControl, connections }: {
  snapshot: DesktopControlSnapshot;
  api: DesktopApi;
  onSnapshot(snapshot: DesktopControlSnapshot): void;
  themeControl: ThemeControl;
  connections: ReactNode;
}) {
  const [section, setSection] = useState<typeof SECTIONS[number][0]>("providers");
  const [exportError, setExportError] = useState("");
  const inspector = snapshot.claudeInspector;
  const [developerSettings, setDeveloperSettings] = useState<ClaudeDesktopDeveloperSettings>();
  const [developerProfile, setDeveloperProfile] = useState<ClaudeDesktopProfile | "">("");
  const [developerBusy, setDeveloperBusy] = useState(false);
  const [developerError, setDeveloperError] = useState("");

  async function updateDeveloperSettings(profile?: ClaudeDesktopProfile, enable = false) {
    setDeveloperBusy(true);
    setDeveloperError("");
    try {
      const result = enable
        ? await api.enableClaudeDesktopDeveloperSettings(profile!)
        : await api.checkClaudeDesktopDeveloperSettings(profile);
      setDeveloperSettings(result);
      setDeveloperProfile(result.profile ?? "");
    } catch (reason) {
      setDeveloperError(reason instanceof Error ? reason.message : "开发者工具配置检查失败");
    } finally { setDeveloperBusy(false); }
  }

  useEffect(() => {
    if (section === "about") void updateDeveloperSettings(developerProfile || undefined);
  }, [section, api]);

  return <section className="desktop-settings-page">
    <header className="desktop-page-heading"><h1>设置</h1></header>
    <nav className="settings-sections" aria-label="设置分组">{SECTIONS.map(([value, label]) => <button type="button" key={value} className={section === value ? "active" : ""} aria-current={section === value ? "page" : undefined} onClick={() => setSection(value)}>{label}</button>)}</nav>
    <div className="settings-section-content">
      {section === "providers" && <ProviderSettings snapshot={snapshot} desktopLocal onRefresh={async () => {
        const response = await api.request({ method: "runtime.refresh", params: {} });
        if (!response.ok) throw new Error(response.error?.message ?? "检测失败");
        onSnapshot(await api.getSnapshot());
      }} onSetApiKey={async (value) => onSnapshot(await api.setAnthropicApiKey(value))} onRemoveApiKey={async () => onSnapshot(await api.removeAnthropicApiKey())}
        onTestMagpieConnection={api.testMagpieConnection ? (input) => api.testMagpieConnection!(input) : undefined}
        onSaveMagpieConnection={api.saveMagpieConnection ? async (input) => {
          const saved = await api.saveMagpieConnection!(input);
          onSnapshot(saved);
          return saved;
        } : undefined} />}

      {section === "connections" && connections}
      {section === "appearance" && <AppearanceSettings themeControl={themeControl} />}
      {section === "about" && <section className="mobile-settings-group">
        <h2>诊断与关于</h2>
        <dl className="settings-facts"><div><dt>Bridge 版本</dt><dd>{snapshot.host.version}</dd></div><div><dt>电脑</dt><dd>{snapshot.host.name}</dd></div></dl>
        <button type="button" className="secondary-button" onClick={() => { setExportError(""); void api.exportDiagnostics().catch((reason: unknown) => setExportError(reason instanceof Error ? reason.message : "诊断导出失败")); }}><Download size={16} />导出诊断</button>
        {exportError && <p role="alert" className="inline-error">{exportError}</p>}
        <section className="provider-settings-profile" aria-label="Claude Desktop 开发者工具">
          <h3>Claude Desktop 开发者工具</h3>
          {developerSettings?.supported === false ? <p className="settings-notice">目前仅支持 macOS 与 Windows。</p> : <>
            {developerSettings && developerSettings.profiles.length > 1 && <div className="provider-key-settings">
              <label htmlFor="claude-developer-profile"><span>配置目录</span><select id="claude-developer-profile" value={developerProfile} disabled={developerBusy} onChange={(event) => {
                const profile = event.target.value as ClaudeDesktopProfile;
                setDeveloperProfile(profile);
                void updateDeveloperSettings(profile);
              }}><option value="" disabled>请选择配置目录</option>{developerSettings.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.id}</option>)}</select></label>
            </div>}
            {developerSettings?.supported && developerSettings.profiles.length === 0 && <p className="settings-notice">未找到 Claude 配置目录，请先启动一次 Claude Desktop。</p>}
            {developerProfile && <dl className="settings-facts">
              <div><dt>配置文件</dt><dd>{developerSettings?.profiles.find((profile) => profile.id === developerProfile)?.path}</dd></div>
            </dl>}
            {(developerBusy || developerError || Boolean(developerSettings?.profiles.length)) && <p role="status" className="settings-notice">{developerBusy ? "正在检查或更新配置…" : developerError ? "配置检查失败" : developerSettings?.profile === developerProfile && developerProfile
              ? developerSettings.changed ? "配置已开启，重启 Claude Desktop 后生效。" : developerSettings.enabled ? "配置已开启" : "配置未开启"
              : "请选择需要检查的配置目录。"}</p>}
            <div className="settings-inline-actions">
              <button type="button" className="secondary-button" disabled={developerBusy} onClick={() => void updateDeveloperSettings(developerProfile || undefined)}>重新检查</button>
              <button type="button" className="primary-button" disabled={developerBusy || !developerProfile || !developerSettings || Boolean(developerError) || developerSettings.profile !== developerProfile || developerSettings.enabled} onClick={() => void updateDeveloperSettings(developerProfile || undefined, true)}>一键开启</button>
            </div>
            <p className="settings-notice">修改后需重启 Claude Desktop。需要主进程调试时，再从 Developer → Enable Main Process Debugger 开启。</p>
          </>}
          {developerError && <p role="alert" className="inline-error">{developerError}</p>}
          <section className="inspector-connections" aria-label="调试连接监测">
            <h4>调试连接监测 · 127.0.0.1:{inspector?.port ?? 9229}</h4>
            {!inspector ? <p className="settings-notice">后台未提供监测状态，请在任务结束后停止 Bridge 后台服务，再打开新版 Bridge。</p>
              : inspector.state === "unsupported" ? <p className="settings-notice">目前仅支持 macOS。</p> : <>
                <p role="status" className="settings-notice">{inspector.state === "starting" ? "正在启动监测…" : inspector.state === "error" ? "监测不可用" : inspector.state === "closed" ? "调试端口未开放，后台持续检查。" : `调试端口已开放 · ${inspector.clients.length} 个连接进程`}</p>
                {inspector.error && <p className="inline-error">{inspector.error}</p>}
                {inspector.notificationError && <p role="alert" className="inline-error">系统通知发送失败：{inspector.notificationError}</p>}
                {inspector.clients.length > 0 && <ul className="inspector-process-list">{inspector.clients.map((client) => <li key={client.pid} className={client.approved ? "" : "inspector-process-unknown"}>
                  <strong>PID {client.pid} · {client.name} · {client.approved ? "认可路径" : "未认可路径"}</strong>
                  <span>{client.executablePath ?? client.pathError ?? "路径未知"}</span>
                </li>)}</ul>}
                <p className="settings-notice">每 {inspector.pollIntervalMs / 1000} 秒检查。关闭窗口后后台继续监测；短连接可能漏检。Bridge 应用包及 /Applications/Google Chrome.app/ 内的进程为认可路径，其他路径或路径未知时告警。</p>
                {inspector.alerts.length > 0 && <details className="settings-detection"><summary>最近告警（{inspector.alerts.length}）</summary><ul className="inspector-process-list">{inspector.alerts.map((alert, index) => <li key={`${alert.detectedAt}-${alert.pid}-${index}`} className="inspector-process-unknown">
                  <strong>{new Date(alert.detectedAt).toLocaleString("zh-CN")} · PID {alert.pid} · {alert.name}</strong>
                  <span>{alert.executablePath ?? alert.pathError ?? "路径未知"}</span>
                </li>)}</ul></details>}
              </>}
          </section>
        </section>
      </section>}
    </div>
  </section>;
}
