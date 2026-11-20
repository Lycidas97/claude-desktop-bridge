import {
  buildPairingQrUrl,
  type BridgeDeviceInfo,
  type ClaudeDesktopDeveloperSettings,
  type ClaudeDesktopProfile,
  type DesktopApi,
  type DesktopControlSnapshot,
} from "@bridge/protocol";
import { Activity, ChevronRight, Clipboard, Download, Play, Power, QrCode, RefreshCw, Smartphone, Trash2 } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { isClaudeNativeRelay } from "../../hooks/useMobileBridge.js";
import type { ThemeControl } from "../../hooks/useTheme.js";
import { collectRendererDiagnosticsSnapshot, setDiagDialogOpen } from "../../lib/diagnostics.js";
import { MagpieQuotaDashboard } from "../../../../../plugins/magpie-quota/client.js";
import { AppearanceSettings } from "../common/AppearanceSettings.js";
import { ConfirmationDialog } from "../common/ConfirmationDialog.js";
import { EmptyState } from "../common/EmptyState.js";
import { IconButton } from "../common/IconButton.js";
import { SelectMenu } from "../common/SelectMenu.js";
import { SettingsGroup } from "../common/SettingsGroup.js";
import { ProviderSettings } from "../session/ProviderSettings.js";
import { RelaySettings } from "../pairing/RelaySettings.js";
import { DesktopUpdaterSection } from "../updater/UpdaterSections.js";
import "../session/settings.css";

const SECTIONS = [
  ["claude", "Claude 接入"],
  ["devices", "手机配对与设备"],
  ["providers", "模型与网关"],
  ["quota", "Magpie 额度"],
  ["connections", "连接与启动"],
  ["appearance", "外观与显示"],
  ["about", "诊断与关于"],
] as const;

export type DesktopSettingsSection = typeof SECTIONS[number][0];

function formatLastSeen(value: number | undefined, online: boolean): string {
  if (online) return "当前在线";
  if (!value) return "尚未上线";
  const elapsed = Math.max(0, Date.now() - value);
  if (elapsed < 60_000) return "刚刚在线";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前在线`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前在线`;
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(value);
}

export function DesktopDevices({
  snapshot,
  onCreatePairing,
  onRevoke,
}: {
  snapshot: DesktopControlSnapshot;
  onCreatePairing(): Promise<void>;
  onRevoke(deviceId: string): Promise<void>;
}) {
  const [revokeCandidate, setRevokeCandidate] = useState<BridgeDeviceInfo>();
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [pairingBusy, setPairingBusy] = useState(false);
  const [deviceError, setDeviceError] = useState<string>();
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const copyTimerRef = useRef<number | undefined>(undefined);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (copyTimerRef.current !== undefined) {
        window.clearTimeout(copyTimerRef.current);
        copyTimerRef.current = undefined;
      }
    };
  }, []);

  async function handleCreatePairing(): Promise<void> {
    if (pairingBusy) return;
    setPairingBusy(true);
    setDeviceError(undefined);
    try {
      await onCreatePairing();
    } catch (reason) {
      setDeviceError(reason instanceof Error ? reason.message : "二维码生成失败");
    } finally {
      setPairingBusy(false);
    }
  }

  async function copyPairingLink(): Promise<void> {
    if (!snapshot.pairingUrl) return;
    try {
      await navigator.clipboard.writeText(snapshot.pairingUrl);
      if (!mountedRef.current) return;
      setCopyState("copied");
      if (copyTimerRef.current !== undefined) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => {
        copyTimerRef.current = undefined;
        if (mountedRef.current) setCopyState("idle");
      }, 2_000);
    } catch {
      if (mountedRef.current) setCopyState("error");
    }
  }

  const activeDevices = (snapshot.devices ?? []).filter((device) => !device.revokedAt);

  return (
    <section className="mobile-settings-group desktop-devices-section" aria-label="手机配对与设备">
      <div className="settings-section-heading settings-hairline-heading">
        <h2>手机配对与端到端加密通道</h2>
        <button
          type="button"
          className="settings-inline-link-btn"
          disabled={pairingBusy}
          onClick={() => void handleCreatePairing()}
        >
          <QrCode size={15} aria-hidden="true" />
          添加手机
        </button>
      </div>
      {deviceError && <p role="alert" className="inline-error">{deviceError}</p>}
      {snapshot.pairingUrl && snapshot.pairingExpiresAt && (
        <section className="device-pairing-band" aria-label="手机扫码配对">
          <div className="qr-wrap">
            <QRCodeSVG
              value={buildPairingQrUrl(snapshot.pairingUrl) ?? snapshot.pairingUrl}
              size={104}
              level="M"
              marginSize={4}
              title="手机配对二维码"
            />
          </div>
          <div className="device-pairing-copy">
            <div className="device-pairing-title-row">
              <h3>使用手机 Bridge 扫描</h3>
              <small className="num">{Math.max(0, Math.ceil((snapshot.pairingExpiresAt - Date.now()) / 60_000))} 分钟后过期</small>
            </div>
            <p>旧版手机端请复制配对链接，在手机上粘贴。</p>
            <div className="device-pairing-meta-row">
              <span className="device-pairing-relay">{snapshot.host.relayUrl || "端到端加密配对通道"}</span>
              <div className="device-pairing-actions">
                <button type="button" className="settings-inline-link-btn" onClick={() => void copyPairingLink()}>
                  <Clipboard size={14} aria-hidden="true" />
                  {copyState === "copied" ? "已复制配对链接" : copyState === "error" ? "复制失败，请重试" : "复制配对链接"}
                </button>
                <button type="button" className="settings-inline-muted-btn" disabled={pairingBusy} onClick={() => void handleCreatePairing()}>
                  <RefreshCw size={13} aria-hidden="true" />
                  刷新
                </button>
              </div>
            </div>
          </div>
        </section>
      )}

      <div className="settings-section-heading settings-hairline-heading settings-subheading">
        <h2>已配对手机 · {activeDevices.length}</h2>
      </div>
      {activeDevices.length > 0 ? (
        <div className="desktop-device-list" role="list" aria-label="已配对手机">
          {activeDevices.map((device) => (
            <article className="desktop-device-row" role="listitem" key={device.deviceId}>
              <span className="device-icon" aria-hidden="true"><Smartphone size={16} /></span>
              <div className="device-copy">
                <div className="device-title-line">
                  <strong>{device.name}</strong>
                  <span className={`device-online-state ${device.online ? "online" : ""}`}>
                    <i aria-hidden="true" />
                    {device.online ? "在线" : "已授权"}
                  </span>
                </div>
                <span>{device.platform.toUpperCase()} · {formatLastSeen(device.lastSeenAt, device.online)}</span>
              </div>
              <IconButton label={`撤销 ${device.name}`} disabled={revokeBusy} onClick={() => setRevokeCandidate(device)}>
                <Trash2 size={16} />
              </IconButton>
            </article>
          ))}
        </div>
      ) : (
        <EmptyState
          className="desktop-page-empty"
          icon={<Smartphone size={22} aria-hidden="true" />}
          title="还没有配对手机"
        />
      )}
      <ConfirmationDialog
        open={Boolean(revokeCandidate)}
        title="撤销这台手机？"
        description={`撤销「${revokeCandidate?.name ?? "这台手机"}」后旧密钥会立即失效，手机需要重新扫码才能连接。`}
        confirmLabel="撤销权限"
        danger
        busy={revokeBusy}
        onCancel={() => {
          if (!revokeBusy) setRevokeCandidate(undefined);
        }}
        onConfirm={() => {
          if (!revokeCandidate || revokeBusy) return;
          const targetId = revokeCandidate.deviceId;
          setRevokeBusy(true);
          setDeviceError(undefined);
          void onRevoke(targetId)
            .then(() => setRevokeCandidate(undefined))
            .catch((reason: unknown) => {
              setDeviceError(reason instanceof Error ? reason.message : "撤销设备失败");
              setRevokeCandidate(undefined);
            })
            .finally(() => setRevokeBusy(false));
        }}
      />
    </section>
  );
}

export function DesktopSettings({
  snapshot,
  api,
  onSnapshot,
  themeControl,
  headerLeading,
  initialSection = "claude",
}: {
  snapshot: DesktopControlSnapshot;
  api: DesktopApi;
  onSnapshot(snapshot: DesktopControlSnapshot): void;
  themeControl: ThemeControl;
  headerLeading?: ReactNode | undefined;
  initialSection?: DesktopSettingsSection | undefined;
}) {
  const [section, setSection] = useState<DesktopSettingsSection>(initialSection);
  const [exportError, setExportError] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const inspector = snapshot.claudeInspector;
  const [developerSettings, setDeveloperSettings] = useState<ClaudeDesktopDeveloperSettings>();
  const [developerProfile, setDeveloperProfile] = useState<ClaudeDesktopProfile | "">("");
  const [developerBusy, setDeveloperBusy] = useState(false);
  const [developerError, setDeveloperError] = useState("");
  const [permissionError, setPermissionError] = useState("");
  const [desktopAction, setDesktopAction] = useState<"launch" | "quit">();
  const [desktopError, setDesktopError] = useState("");
  const desktopApp = snapshot.desktopApps?.find((app) => app.id === "claude-desktop") ?? { name: "Claude Desktop", ...snapshot.claudeDesktop };

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
    } finally {
      setDeveloperBusy(false);
    }
  }

  async function runDesktopAction(action: "launch" | "quit") {
    setDesktopAction(action);
    setDesktopError("");
    try {
      onSnapshot(await (action === "launch" ? api.launchDesktopApp("claude-desktop") : api.quitDesktopApp("claude-desktop")));
      if (action === "launch") await updateDeveloperSettings(developerProfile || undefined);
    } catch (reason) {
      setDesktopError(reason instanceof Error ? reason.message : "桌面应用操作失败");
    } finally {
      setDesktopAction(undefined);
    }
  }

  useEffect(() => {
    if (section === "claude") void updateDeveloperSettings(developerProfile || undefined);
  }, [section, api]);

  return (
    <section className="desktop-settings-page">
      <header className="m-header is-embedded desktop-settings-topbar">
        {headerLeading}
        <div className="m-header-copy">
          <h1>设置</h1>
        </div>
      </header>
      <div className="desktop-settings-body">
        <div className="desktop-settings-shell">
          <nav className="settings-sections" aria-label="设置分组">
            {SECTIONS.map(([value, label]) => (
              <button
                type="button"
                key={value}
                className={section === value ? "active" : ""}
                aria-current={section === value ? "page" : undefined}
                onClick={() => setSection(value)}
              >
                {label}
              </button>
            ))}
          </nav>
          <div className="settings-section-content">
            {section === "claude" && (
              <section className="mobile-settings-group" aria-label="Claude 接入">
                <div className="settings-section-heading settings-hairline-heading">
                  <h2>原生桌面通道</h2>
                  <span className={`settings-status-inline${snapshot.runtime.state === "ready" || snapshot.runtime.state === "working" ? " is-ready" : ""}`}>
                    <i aria-hidden="true" />
                    {snapshot.runtime.state === "ready" ? "通道已就绪" : snapshot.runtime.state === "working" ? "运行中" : "需要接入"}
                  </span>
                </div>
                {snapshot.runtime.detail && <p className="settings-notice">{snapshot.runtime.detail}</p>}
                <div className="desktop-app-control">
                  <span>
                    <strong>{desktopApp.name}</strong>
                    {desktopApp.detail && <small>{desktopApp.detail}</small>}
                  </span>
                  <div className="desktop-app-actions">
                    <button type="button" className="secondary-button" disabled={Boolean(desktopAction) || !desktopApp.canLaunch} onClick={() => void runDesktopAction("launch")}>
                      <Play size={15} aria-hidden="true" />
                      {desktopAction === "launch" ? "启动中" : "启动"}
                    </button>
                    <button type="button" className="danger-button" disabled={Boolean(desktopAction) || !desktopApp.canQuit} onClick={() => void runDesktopAction("quit")}>
                      <Power size={15} aria-hidden="true" />
                      {desktopAction === "quit" ? "退出中" : "退出"}
                    </button>
                  </div>
                </div>
                {desktopError && <p role="alert" className="inline-error">{desktopError}</p>}
                <section className="provider-settings-profile settings-flat-section" aria-label="Claude Desktop 开发者工具">
                  <h3>开发者工具</h3>
                  {developerSettings?.supported === false ? (
                    <p className="settings-notice">配置助手目前仅支持 macOS 与 Windows。</p>
                  ) : (
                    <>
                      {((developerSettings?.profiles.length ?? 0) > 1 || (!developerSettings && developerError)) && (
                        <div className="provider-key-settings">
                          <div className="provider-select-field">
                            <label htmlFor="claude-developer-profile">
                              <span>配置目录</span>
                            </label>
                            <SelectMenu
                              id="claude-developer-profile"
                              ariaLabel="配置目录"
                              value={developerProfile}
                              placeholder="请选择正在使用的 Claude 配置"
                              disabled={developerBusy}
                              options={(developerSettings?.profiles ?? [{ id: "Claude" }, { id: "Claude-3p" }]).map((profile) => ({
                                value: profile.id,
                                label: profile.id,
                              }))}
                              onChange={(nextId) => {
                                const profile = nextId as ClaudeDesktopProfile;
                                setDeveloperProfile(profile);
                                void updateDeveloperSettings(profile);
                              }}
                            />
                          </div>
                        </div>
                      )}
                      {developerSettings?.supported && developerSettings.profiles.length === 0 && (
                        <p className="settings-notice">请先启动 Claude Desktop 初始化配置目录，再重新检查。</p>
                      )}
                      {developerProfile && (
                        <dl className="settings-facts">
                          <div>
                            <dt>配置文件</dt>
                            <dd>{developerSettings?.profiles.find((profile) => profile.id === developerProfile)?.path}</dd>
                          </div>
                        </dl>
                      )}
                      <p role="status" className="settings-notice">
                        {developerBusy
                          ? "正在检查或更新配置…"
                          : developerError
                            ? "配置操作未完成，可根据下方提示重试。"
                            : developerSettings?.profile === developerProfile && developerProfile
                              ? developerSettings.accessRequired
                                ? "需要访问配置目录。点击开启后将请求授权。"
                                : developerSettings.changed
                                  ? "配置已开启，重启 Claude Desktop 后生效。"
                                  : developerSettings.enabled
                                    ? "配置已开启"
                                    : "配置未开启"
                              : developerSettings?.profiles.length
                                ? "请选择正在使用的配置目录，再开启开发者工具。"
                                : developerError
                                  ? "配置检查失败，可选择目录后重试。"
                                  : "尚未找到配置目录。"}
                      </p>
                      <div className="settings-inline-actions">
                        <button type="button" className="secondary-button" disabled={developerBusy} onClick={() => void updateDeveloperSettings(developerProfile || undefined)}>
                          重新检查
                        </button>
                        <button
                          type="button"
                          className="primary-button"
                          disabled={developerBusy || !developerProfile || (!developerError && developerSettings?.profile === developerProfile && developerSettings.enabled === true)}
                          onClick={() => void updateDeveloperSettings(developerProfile || undefined, true)}
                        >
                          一键开启
                        </button>
                      </div>
                      <p className="settings-notice">开启后重启 Claude Desktop。Bridge 会尝试开启主进程调试；若需要系统授权，请按提示允许。</p>
                    </>
                  )}
                  {developerError && <p role="alert" className="inline-error">{developerError}</p>}
                </section>
                <section className="inspector-connections settings-flat-section" aria-label="调试连接监测">
                  <h3>调试连接 · 127.0.0.1:{inspector?.port ?? 9229}</h3>
                  {!inspector ? (
                    <p className="settings-notice">后台未提供监测状态，请在任务结束后停止 Bridge 后台服务，再打开新版 Bridge。</p>
                  ) : inspector.state === "unsupported" ? (
                    <p className="settings-notice">目前仅支持 macOS 与 Windows。</p>
                  ) : (
                    <>
                      <p role="status" className="settings-notice">
                        {inspector.state === "starting"
                          ? "正在启动监测…"
                          : inspector.state === "error"
                            ? "监测不可用"
                            : inspector.state === "closed"
                              ? "调试端口未开放，后台持续检查。"
                              : `调试端口已开放 · ${inspector.clients.length} 个连接进程`}
                      </p>
                      {inspector.state === "closed" && (
                        <p className="settings-notice">
                          如需连接，请在 Claude Desktop 中{inspector.platform === "win32" ? "按 Alt 显示菜单，再" : "手动"}勾选 Developer › Enable Main Process Debugger，Bridge 会自动连接。
                        </p>
                      )}
                      {inspector.error && <p className="inline-error">{inspector.error}</p>}
                      {inspector.startup?.state === "accessibility-required" ? (
                        inspector.state === "closed" && (
                          <>
                            <p className="settings-notice">{inspector.startup.detail}</p>
                            {api.openAccessibilitySettings && (
                              <button
                                type="button"
                                className="secondary-button"
                                onClick={() => {
                                  setPermissionError("");
                                  void api.openAccessibilitySettings!().catch((reason: unknown) => setPermissionError(reason instanceof Error ? reason.message : "无法打开辅助功能设置"));
                                }}
                              >
                                打开辅助功能设置
                              </button>
                            )}
                            {permissionError && <p role="alert" className="inline-error">{permissionError}</p>}
                          </>
                        )
                      ) : inspector.startup?.state === "waiting" ? (
                        inspector.state === "closed" && <p className="settings-notice">{inspector.startup.detail}</p>
                      ) : inspector.startup ? (
                        <details className="settings-detection">
                          <summary>
                            历史启动记录 · {inspector.startup.recordedAt !== undefined ? (
                              <time dateTime={new Date(inspector.startup.recordedAt).toISOString()}>
                                {new Date(inspector.startup.recordedAt).toLocaleString("zh-CN")}
                              </time>
                            ) : "时间未知"}
                          </summary>
                          <p className="settings-notice">{inspector.startup.detail}</p>
                          <p className="settings-notice">本进程不再自动尝试开启调试端口。</p>
                        </details>
                      ) : null}
                      {inspector.notificationError && <p role="alert" className="inline-error">系统通知发送失败：{inspector.notificationError}</p>}
                      {inspector.clients.length > 0 && (
                        <ul className="inspector-process-list">
                          {inspector.clients.map((client) => (
                            <li key={client.pid} className={client.approved ? "" : "inspector-process-unknown"}>
                              <strong>PID {client.pid} · {client.name} · {client.approved ? "认可路径" : "未认可路径"}</strong>
                              <span>{client.executablePath ?? client.pathError ?? "路径未知"}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                      <p className="settings-notice">每 {inspector.pollIntervalMs / 1000} 秒检查，关闭窗口后仍会监测。Bridge 和 Google Chrome 为认可路径，其他或未知路径会告警；短连接可能漏检。</p>
                      {inspector.alerts.length > 0 && (
                        <details className="settings-detection">
                          <summary>最近告警（{inspector.alerts.length}）</summary>
                          <ul className="inspector-process-list">
                            {inspector.alerts.map((alert, index) => (
                              <li key={`${alert.detectedAt}-${alert.pid}-${index}`} className="inspector-process-unknown">
                                <strong>{new Date(alert.detectedAt).toLocaleString("zh-CN")} · PID {alert.pid} · {alert.name}</strong>
                                <span>{alert.executablePath ?? alert.pathError ?? "路径未知"}</span>
                              </li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </>
                  )}
                </section>
              </section>
            )}
            {section === "devices" && (
              <DesktopDevices
                snapshot={snapshot}
                onCreatePairing={async () => onSnapshot(await api.createPairing())}
                onRevoke={async (deviceId) => onSnapshot(await api.revokeDevice(deviceId))}
              />
            )}
            {section === "providers" && (
              <ProviderSettings
                snapshot={snapshot}
                desktopLocal
                onRefresh={async () => {
                  const response = await api.request({ method: "runtime.refresh", params: {} });
                  if (!response.ok) throw new Error(response.error?.message ?? "检测失败");
                  onSnapshot(await api.getSnapshot());
                }}
                onTestMagpieConnection={api.testMagpieConnection ? (input) => api.testMagpieConnection!(input) : undefined}
                onSaveMagpieConnection={api.saveMagpieConnection ? async (input) => {
                  const saved = await api.saveMagpieConnection!(input);
                  onSnapshot(saved);
                  return saved;
                } : undefined}
              />
            )}
            {section === "quota" && <MagpieQuotaDashboard />}
            {section === "connections" && (
              <SettingsGroup title="连接" label="连接与启动">
                <dl className="settings-facts">
                  <div><dt>主机状态</dt><dd>{snapshot.connection === "connected" ? "已连接" : snapshot.connection === "connecting" || snapshot.connection === "reconnecting" ? "正在连接" : "离线"}</dd></div>
                  <div><dt>连接方式</dt><dd>{snapshot.transport ? ({ direct: "直连", "public-relay": "安全中继", "lan-relay": "局域网连接" })[snapshot.transport.path] : "等待连接"} · 端到端加密</dd></div>
                  <div><dt>连接延迟</dt><dd>{snapshot.transport?.rttMs !== undefined ? `${Math.round(snapshot.transport.rttMs)} ms` : "正在测量"}</dd></div>
                  <div><dt>待发送</dt><dd>{snapshot.transport?.pendingCount ?? 0} 条</dd></div>
                  <div><dt>Relay 状态</dt><dd>{snapshot.transport?.relayHealthy ? "正常" : "健康检查未响应"}</dd></div>
                </dl>
                <RelaySettings relayUrl={snapshot.host.relayUrl} onSave={async (url) => onSnapshot(await api.setRelayUrl(url))} />
                <section className="provider-settings-profile settings-flat-section" aria-label="启动">
                  <h3>启动</h3>
                  <label className="mobile-settings-row toggle-row">
                    <span>
                      <strong>开机自动运行</strong>
                      <small>登录系统后 Bridge 自动待机</small>
                    </span>
                    <input
                      type="checkbox"
                      checked={snapshot.launchAtLogin}
                      onChange={(event) => {
                        setConnectionError("");
                        void api.setLaunchAtLogin(event.target.checked).then(onSnapshot).catch((reason: unknown) => setConnectionError(reason instanceof Error ? reason.message : "启动设置失败"));
                      }}
                    />
                    <i aria-hidden="true" />
                  </label>
                  {connectionError && <p role="alert" className="inline-error">{connectionError}</p>}
                </section>
              </SettingsGroup>
            )}
            {section === "appearance" && <AppearanceSettings themeControl={themeControl} />}
            {section === "about" && (
              <SettingsGroup title="诊断与关于" label="诊断与关于">
                <dl className="settings-facts">
                  <div><dt>Bridge 版本</dt><dd>{snapshot.host.version}</dd></div>
                  <div><dt>电脑</dt><dd>{snapshot.host.name}</dd></div>
                  <div><dt>Claude 版本</dt><dd>{snapshot.runtime.version ?? "未检测到"}</dd></div>
                  <div><dt>原生中转</dt><dd>{isClaudeNativeRelay(snapshot) ? "已就绪" : "未就绪"}</dd></div>
                  <div><dt>活动会话</dt><dd>{snapshot.runtime.activeTurns} / {snapshot.runtime.maxParallelTurns}</dd></div>
                  <div><dt>排队指令</dt><dd>{snapshot.sessions.reduce((sum, session) => sum + session.pendingCount, 0)}</dd></div>
                  <div><dt>待处理审批</dt><dd>{snapshot.permissions.length}</dd></div>
                  <div><dt>事件游标</dt><dd>{snapshot.latestSeq}</dd></div>
                </dl>
                <div className="desktop-diagnostics-group">
                  <label className="mobile-settings-row toggle-row">
                    <span>
                      <strong>后台诊断记录</strong>
                      <small>仅本机保存，内存快照可能包含会话内容</small>
                    </span>
                    <input
                      type="checkbox"
                      checked={snapshot.diagnosticsEnabled}
                      onChange={(event) => {
                        setExportError("");
                        void api.setDiagnosticsEnabled(event.target.checked).then(onSnapshot).catch((reason: unknown) => setExportError(reason instanceof Error ? reason.message : "诊断设置失败"));
                      }}
                    />
                    <i aria-hidden="true" />
                  </label>
                  <button type="button" className="mobile-settings-row" onClick={() => setDiagDialogOpen(true)}>
                    <Activity size={18} aria-hidden="true" />
                    <span><strong>连接诊断与日志</strong></span>
                    <ChevronRight size={18} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="mobile-settings-row"
                    onClick={() => {
                      setExportError("");
                      void (async () => {
                        const rendererDiagnostics = await collectRendererDiagnosticsSnapshot(snapshot);
                        await api.exportDiagnostics(rendererDiagnostics);
                      })().catch((reason: unknown) => setExportError(reason instanceof Error ? reason.message : "诊断导出失败"));
                    }}
                  >
                    <Download size={18} aria-hidden="true" />
                    <span><strong>导出诊断</strong></span>
                    <ChevronRight size={18} aria-hidden="true" />
                  </button>
                </div>
                {exportError && <p role="alert" className="inline-error">{exportError}</p>}
                <DesktopUpdaterSection snapshot={snapshot} api={api} onSnapshot={onSnapshot} />
              </SettingsGroup>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
