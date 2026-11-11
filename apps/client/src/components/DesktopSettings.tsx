import type { DesktopControlSnapshot } from "@bridge/protocol";
import { Activity, Download, Play, Power } from "lucide-react";
import { useEffect, useState } from "react";
import { isClaudeNativeRelay } from "../hooks/useMobileBridge.js";
import type { ThemeControl } from "../hooks/useTheme.js";
import { setDiagDialogOpen } from "../lib/diagnostics.js";
import type { ClaudeDesktopDeveloperSettings, ClaudeDesktopProfile, DesktopApi } from "../runtime/desktop.js";
import { AppearanceSettings } from "./MobileSettings.js";
import { ProviderSettings } from "./ProviderSettings.js";
import { RelaySettings } from "./RelaySettings.js";
import "./settings.css";

const SECTIONS = [
  ["claude", "Claude 接入"], ["providers", "模型与网关"], ["connections", "连接与启动"], ["appearance", "外观与显示"], ["about", "诊断与关于"],
] as const;

export function DesktopSettings({ snapshot, api, onSnapshot, themeControl }: {
  snapshot: DesktopControlSnapshot;
  api: DesktopApi;
  onSnapshot(snapshot: DesktopControlSnapshot): void;
  themeControl: ThemeControl;
}) {
  const [section, setSection] = useState<typeof SECTIONS[number][0]>("claude");
  const [exportError, setExportError] = useState("");
  const inspector = snapshot.claudeInspector;
  const [developerSettings, setDeveloperSettings] = useState<ClaudeDesktopDeveloperSettings>();
  const [developerProfile, setDeveloperProfile] = useState<ClaudeDesktopProfile | "">("");
  const [developerBusy, setDeveloperBusy] = useState(false);
  const [developerError, setDeveloperError] = useState("");
  const [desktopAction, setDesktopAction] = useState<"launch" | "quit">();
  const [desktopError, setDesktopError] = useState("");
  const desktopApp = snapshot.desktopApps?.find(app => app.id === "claude-desktop") ?? { name: "Claude Desktop", ...snapshot.claudeDesktop };

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

  async function runDesktopAction(action: "launch" | "quit") {
    setDesktopAction(action);
    setDesktopError("");
    try {
      onSnapshot(await (action === "launch" ? api.launchDesktopApp("claude-desktop") : api.quitDesktopApp("claude-desktop")));
      if (action === "launch") await updateDeveloperSettings(developerProfile || undefined);
    } catch (reason) {
      setDesktopError(reason instanceof Error ? reason.message : "桌面应用操作失败");
    } finally { setDesktopAction(undefined); }
  }

  useEffect(() => {
    if (section === "claude") void updateDeveloperSettings(developerProfile || undefined);
  }, [section, api]);

  return <section className="desktop-settings-page">
    <header className="desktop-page-heading"><h1>设置</h1></header>
    <nav className="settings-sections" aria-label="设置分组">{SECTIONS.map(([value, label]) => <button type="button" key={value} className={section === value ? "active" : ""} aria-current={section === value ? "page" : undefined} onClick={() => setSection(value)}>{label}</button>)}</nav>
    <div className="settings-section-content">
      {section === "claude" && <section className="mobile-settings-group" aria-label="Claude 接入">
        <div className="settings-section-heading"><h2>Claude Desktop</h2><span>{snapshot.runtime.state === "ready" ? "通道已就绪" : snapshot.runtime.state === "working" ? "运行中" : "需要接入"}</span></div>
        <p className="settings-notice">{snapshot.runtime.detail}</p>
        <div className="desktop-app-control">
          <span><strong>{desktopApp.name}</strong><small>{desktopApp.detail}</small></span>
          <div className="desktop-app-actions">
            <button type="button" className="secondary-button" disabled={Boolean(desktopAction) || !desktopApp.canLaunch} onClick={() => void runDesktopAction("launch")}><Play size={15} />{desktopAction === "launch" ? "启动中" : "启动"}</button>
            <button type="button" className="danger-button" disabled={Boolean(desktopAction) || !desktopApp.canQuit} onClick={() => void runDesktopAction("quit")}><Power size={15} />{desktopAction === "quit" ? "退出中" : "退出"}</button>
          </div>
        </div>
        {desktopError && <p role="alert" className="inline-error">{desktopError}</p>}
        <section className="provider-settings-profile" aria-label="Claude Desktop 开发者工具">
          <h3>开发者工具</h3>
          {developerSettings?.supported === false ? <p className="settings-notice">配置助手目前仅支持 macOS 与 Windows。</p> : <>
            {((developerSettings?.profiles.length ?? 0) > 1 || (!developerSettings && developerError)) && <div className="provider-key-settings">
              <label htmlFor="claude-developer-profile"><span>配置目录</span><select id="claude-developer-profile" value={developerProfile} disabled={developerBusy} onChange={(event) => {
                const profile = event.target.value as ClaudeDesktopProfile;
                setDeveloperProfile(profile);
                void updateDeveloperSettings(profile);
              }}><option value="" disabled>请选择正在使用的 Claude 配置</option>{(developerSettings?.profiles ?? [{ id: "Claude" }, { id: "Claude-3p" }]).map((profile) => <option key={profile.id} value={profile.id}>{profile.id}</option>)}</select></label>
            </div>}
            {developerSettings?.supported && developerSettings.profiles.length === 0 && <p className="settings-notice">请先启动 Claude Desktop 初始化配置目录，再重新检查。</p>}
            {developerProfile && <dl className="settings-facts"><div><dt>配置文件</dt><dd>{developerSettings?.profiles.find((profile) => profile.id === developerProfile)?.path}</dd></div></dl>}
            <p role="status" className="settings-notice">{developerBusy ? "正在检查或更新配置…" : developerError ? "配置操作未完成，可根据下方提示重试。" : developerSettings?.profile === developerProfile && developerProfile
              ? developerSettings.accessRequired ? "需要访问配置目录。点击开启后将请求授权。" : developerSettings.changed ? "配置已开启，重启 Claude Desktop 后生效。" : developerSettings.enabled ? "配置已开启" : "配置未开启"
              : developerSettings?.profiles.length ? "请选择正在使用的配置目录，再开启开发者工具。" : developerError ? "配置检查失败，可选择目录后重试。" : "尚未找到配置目录。"}</p>
            <div className="settings-inline-actions">
              <button type="button" className="secondary-button" disabled={developerBusy} onClick={() => void updateDeveloperSettings(developerProfile || undefined)}>重新检查</button>
              <button type="button" className="primary-button" disabled={developerBusy || !developerProfile || (!developerError && developerSettings?.profile === developerProfile && developerSettings.enabled === true)} onClick={() => void updateDeveloperSettings(developerProfile || undefined, true)}>一键开启</button>
            </div>
            <p className="settings-notice">开启后重启 Claude Desktop。Bridge 会尝试开启主进程调试；若需要系统授权，请按提示允许。</p>
          </>}
          {developerError && <p role="alert" className="inline-error">{developerError}</p>}
        </section>
        <section className="inspector-connections" aria-label="调试连接监测">
          <h3>调试连接 · 127.0.0.1:{inspector?.port ?? 9229}</h3>
          {!inspector ? <p className="settings-notice">后台未提供监测状态，请在任务结束后停止 Bridge 后台服务，再打开新版 Bridge。</p>
            : inspector.state === "unsupported" ? <p className="settings-notice">目前仅支持 macOS。</p> : <>
              <p role="status" className="settings-notice">{inspector.state === "starting" ? "正在启动监测…" : inspector.state === "error" ? "监测不可用" : inspector.state === "closed" ? "调试端口未开放，后台持续检查。" : `调试端口已开放 · ${inspector.clients.length} 个连接进程`}</p>
              {inspector.error && <p className="inline-error">{inspector.error}</p>}
              {inspector.notificationError && <p role="alert" className="inline-error">系统通知发送失败：{inspector.notificationError}</p>}
              {inspector.clients.length > 0 && <ul className="inspector-process-list">{inspector.clients.map((client) => <li key={client.pid} className={client.approved ? "" : "inspector-process-unknown"}>
                <strong>PID {client.pid} · {client.name} · {client.approved ? "认可路径" : "未认可路径"}</strong><span>{client.executablePath ?? client.pathError ?? "路径未知"}</span>
              </li>)}</ul>}
              <p className="settings-notice">每 {inspector.pollIntervalMs / 1000} 秒检查，关闭窗口后仍会监测。Bridge 和 Google Chrome 为认可路径，其他或未知路径会告警；短连接可能漏检。</p>
              {inspector.alerts.length > 0 && <details className="settings-detection"><summary>最近告警（{inspector.alerts.length}）</summary><ul className="inspector-process-list">{inspector.alerts.map((alert, index) => <li key={`${alert.detectedAt}-${alert.pid}-${index}`} className="inspector-process-unknown">
                <strong>{new Date(alert.detectedAt).toLocaleString("zh-CN")} · PID {alert.pid} · {alert.name}</strong><span>{alert.executablePath ?? alert.pathError ?? "路径未知"}</span>
              </li>)}</ul></details>}
            </>}
        </section>
      </section>}
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
      {section === "connections" && <section className="mobile-settings-group" aria-label="连接与启动">
        <h2>连接</h2>
        <dl className="settings-facts">
          <div><dt>主机状态</dt><dd>{snapshot.connection === "connected" ? "已连接" : snapshot.connection === "connecting" || snapshot.connection === "reconnecting" ? "正在连接" : "离线"}</dd></div>
          <div><dt>连接方式</dt><dd>{snapshot.transport ? ({ direct: "直连", "public-relay": "安全中继", "lan-relay": "局域网连接" })[snapshot.transport.path] : "等待连接"} · 端到端加密</dd></div>
          <div><dt>连接延迟</dt><dd>{snapshot.transport?.rttMs !== undefined ? `${Math.round(snapshot.transport.rttMs)} ms` : "正在测量"}</dd></div>
          <div><dt>待发送</dt><dd>{snapshot.transport?.pendingCount ?? 0} 条</dd></div>
          <div><dt>Relay 状态</dt><dd>{snapshot.transport?.relayHealthy ? "正常" : "健康检查未响应"}</dd></div>
        </dl>
        <RelaySettings relayUrl={snapshot.host.relayUrl} onSave={async url => onSnapshot(await api.setRelayUrl(url))} />
        <section className="provider-settings-profile" aria-label="启动"><h3>启动</h3>
          <label className="toggle-row"><span><strong>开机自动运行</strong><small>登录系统后 Bridge 自动待机</small></span><input type="checkbox" checked={snapshot.launchAtLogin} onChange={event => void api.setLaunchAtLogin(event.target.checked).then(onSnapshot)} /><i aria-hidden="true" /></label>
        </section>
      </section>}
      {section === "appearance" && <AppearanceSettings themeControl={themeControl} />}
      {section === "about" && <section className="mobile-settings-group" aria-label="诊断与关于">
        <h2>诊断与关于</h2>
        <dl className="settings-facts">
          <div><dt>Bridge 版本</dt><dd>{snapshot.host.version}</dd></div><div><dt>电脑</dt><dd>{snapshot.host.name}</dd></div>
          <div><dt>Claude 版本</dt><dd>{snapshot.runtime.version ?? "未检测到"}</dd></div>
          <div><dt>原生中转</dt><dd>{isClaudeNativeRelay(snapshot) ? "已就绪" : "未就绪"}</dd></div>
          <div><dt>活动会话</dt><dd>{snapshot.runtime.activeTurns} / {snapshot.runtime.maxParallelTurns}</dd></div>
          <div><dt>排队指令</dt><dd>{snapshot.sessions.reduce((sum, session) => sum + session.pendingCount, 0)}</dd></div>
          <div><dt>待处理审批</dt><dd>{snapshot.permissions.length}</dd></div>
          <div><dt>事件游标</dt><dd>{snapshot.latestSeq}</dd></div>
        </dl>
        <div className="settings-inline-actions">
          <button type="button" className="secondary-button" onClick={() => setDiagDialogOpen(true)}><Activity size={16} />连接诊断与日志</button>
          <button type="button" className="secondary-button" onClick={() => { setExportError(""); void api.exportDiagnostics().catch((reason: unknown) => setExportError(reason instanceof Error ? reason.message : "诊断导出失败")); }}><Download size={16} />导出诊断</button>
        </div>
        {exportError && <p role="alert" className="inline-error">{exportError}</p>}
      </section>}
    </div>
  </section>;
}
