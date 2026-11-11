import type {
  BridgeEvent,
  BridgeResponse,
  DesktopControlSnapshot,
  LocalBridgeRequest,
} from "@bridge/protocol";
import { summarizeEvidenceEvent } from "@bridge/protocol";
import {
  AlertTriangle,
  Clipboard,
  Laptop,
  MessageSquare,
  QrCode,
  Settings2,
  Smartphone,
  Trash2,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useMemo, useState } from "react";
import { MAGPIE_QUOTA_METHOD, type QuotaSnapshot } from "../../../../plugins/magpie-quota/contract.js";
import { MagpieQuotaProvider } from "../../../../plugins/magpie-quota/client.js";
import type { ThemeControl } from "../hooks/useTheme.js";
import { claudeSnapshot } from "../lib/claude-snapshot.js";
import { BrandMark } from "./common/BrandMark.js";
import { ConfirmationDialog } from "./common/ConfirmationDialog.js";
import { DiagnosticFloatingEntry } from "./common/DiagnosticLogDialog.js";
import { IconButton } from "./common/IconButton.js";
import { ThemeMenu } from "./common/ThemeMenu.js";
import { DesktopSessions, unwrap } from "./desktop/DesktopSessionsPane.js";
import { DesktopSettings } from "./desktop/DesktopSettings.js";
import { MediaPreviewProvider } from "./evidence/MediaPreviewProvider.js";

type DesktopTab = "sessions" | "devices" | "settings";

function formatLastSeen(value: number | undefined, online: boolean): string {
  if (online) return "当前在线";
  if (!value) return "尚未上线";
  const elapsed = Math.max(0, Date.now() - value);
  if (elapsed < 60_000) return "刚刚在线";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前在线`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前在线`;
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(value);
}

function connectionLabel(snapshot: DesktopControlSnapshot): string {
  if (snapshot.host.version.startsWith("0.2.")) return "需要升级";
  if (snapshot.connection === "connecting" || snapshot.connection === "reconnecting") return "正在重连";
  if (snapshot.connection !== "connected") return "主机离线";
  if (snapshot.transport?.path === "direct") return "直连";
  if (snapshot.transport?.path === "public-relay") return "安全中继";
  return "局域网连接";
}

function DesktopDevices({
  snapshot,
  onCreatePairing,
  onRevoke,
}: {
  snapshot: DesktopControlSnapshot;
  onCreatePairing(): Promise<void>;
  onRevoke(deviceId: string): Promise<void>;
}) {
  const [revokeCandidate, setRevokeCandidate] = useState<string>();
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");

  async function copyPairingLink(): Promise<void> {
    if (!snapshot.pairingUrl) return;
    try {
      await navigator.clipboard.writeText(snapshot.pairingUrl);
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 2_000);
    } catch {
      setCopyState("error");
    }
  }

  return (
    <section className="desktop-page">
      <header className="desktop-page-heading">
        <div><span>访问控制</span><h1>设备</h1></div>
        <button type="button" className="primary-button" onClick={() => void onCreatePairing()}><QrCode size={17} />添加手机</button>
      </header>
      {snapshot.pairingUrl && snapshot.pairingExpiresAt && (
        <section className="device-pairing-band">
          <div className="qr-wrap"><QRCodeSVG value={snapshot.pairingUrl} size={320} level="M" marginSize={4} title="手机配对二维码" /></div>
          <div>
            <span>一次性配对</span>
            <h2>使用手机 Bridge 扫描</h2>
            <p>二维码十分钟内有效，首次扫描后绑定到该手机安装。也可以复制配对链接，在手机端粘贴完成配对。</p>
            <div className="device-pairing-actions">
              <button type="button" className="secondary-button" onClick={() => void copyPairingLink()}>
                <Clipboard size={16} />
                {copyState === "copied" ? "已复制配对链接" : copyState === "error" ? "复制失败，请扫码" : "复制配对链接"}
              </button>
            </div>
            <small>{Math.max(0, Math.ceil((snapshot.pairingExpiresAt - Date.now()) / 60_000))} 分钟后过期</small>
          </div>
        </section>
      )}
      <div className="desktop-device-list">
        {snapshot.devices.filter((device) => !device.revokedAt).map((device) => (
          <article className="desktop-device-row" key={device.deviceId}>
            <span className="device-icon"><Smartphone size={20} /></span>
            <div><strong>{device.name}</strong><span>{device.platform.toUpperCase()} · {formatLastSeen(device.lastSeenAt, device.online)}</span></div>
            <span className={`device-online-state ${device.online ? "online" : ""}`}><i />{device.online ? "在线" : "已授权"}</span>
            <IconButton label={`撤销 ${device.name}`} onClick={() => setRevokeCandidate(device.deviceId)}><Trash2 size={17} /></IconButton>
          </article>
        ))}
        {snapshot.devices.filter((device) => !device.revokedAt).length === 0 && (
          <div className="desktop-page-empty"><Smartphone size={24} /><strong>还没有配对手机</strong><span>点击右上角生成十分钟有效的二维码。</span></div>
        )}
      </div>
      <ConfirmationDialog
        open={Boolean(revokeCandidate)}
        title="撤销这台手机？"
        description="撤销后旧密钥会立即失效，手机需要重新扫码才能连接。"
        confirmLabel="撤销权限"
        danger
        onCancel={() => setRevokeCandidate(undefined)}
        onConfirm={() => {
          if (!revokeCandidate) return;
          void onRevoke(revokeCandidate).finally(() => setRevokeCandidate(undefined));
        }}
      />
    </section>
  );
}

export function DesktopDashboard({ themeControl }: { themeControl: ThemeControl }) {
  const api = window.bridgeDesktop;
  const [snapshot, setSnapshot] = useState<DesktopControlSnapshot>();
  const [events, setEvents] = useState<BridgeEvent[]>([]);
  const [tab, setTab] = useState<DesktopTab>("sessions");
  const visibleSnapshot = useMemo(() => snapshot ? claudeSnapshot(snapshot) : undefined, [snapshot]);

  useEffect(() => {
    if (!api) return;
    void api.getSnapshot().then(setSnapshot);
    const stopSnapshots = api.onSnapshot(setSnapshot);
    const stopEvents = api.onEvent((event) => {
      setEvents((current) => [...current.filter((candidate) => candidate.eventId !== event.eventId), summarizeEvidenceEvent(event)]
        .sort((left, right) => left.seq - right.seq)
        .slice(-2_000));
    });
    return () => {
      stopSnapshots();
      stopEvents();
    };
  }, [api]);

  const loadMagpieQuota = useMemo(() => async (options?: { refresh?: boolean }): Promise<QuotaSnapshot> => {
    return unwrap<QuotaSnapshot>(await api!.request({ method: MAGPIE_QUOTA_METHOD, params: { refresh: options?.refresh ?? false } }));
  }, [api]);

  if (!api || !snapshot) return <div className="desktop-loading"><BrandMark /><span>正在准备会话主机</span></div>;

  async function request(input: LocalBridgeRequest): Promise<BridgeResponse> {
    return api!.request(input);
  }

  return (
    <MediaPreviewProvider request={(method, params) => request({ method, params })} supportsFileStat={snapshot.host.capabilities.includes("artifact.transfer.stat.v1")}>
    <MagpieQuotaProvider loader={loadMagpieQuota} enabled={snapshot.host.capabilities.includes("plugin.magpie-quota.v1")} sourceKey={snapshot.runtime.detection?.refreshedAt ?? 0}>
    <main className="desktop-shell-v2">
      <aside className="desktop-nav-v2">
        <BrandMark compact />
        <nav aria-label="Bridge 主导航">
          <button className={tab === "sessions" ? "active" : ""} type="button" onClick={() => setTab("sessions")}><MessageSquare size={19} /><span>会话</span></button>
          <button className={tab === "devices" ? "active" : ""} type="button" onClick={() => setTab("devices")}><Smartphone size={19} /><span>设备</span></button>
          <button className={tab === "settings" ? "active" : ""} type="button" onClick={() => setTab("settings")}><Settings2 size={19} /><span>设置</span></button>
        </nav>
        <div className="desktop-host-chip">
          <Laptop size={17} />
          <span><strong>{snapshot.host.name}</strong><small>{connectionLabel(snapshot)}</small></span>
        </div>
        <ThemeMenu control={themeControl} side="right" iconSize={18} />
      </aside>
      <section className="desktop-content-v2">
        {snapshot.claudeInspector?.state === "error" && <div role="alert" className="inspector-warning"><AlertTriangle size={18} /><span>Claude 调试连接监测不可用：{snapshot.claudeInspector.error}</span></div>}
        {snapshot.claudeInspector?.clients.some((client) => !client.approved) && <div role="alert" className="inspector-warning">
          <AlertTriangle size={18} /><div><strong>Claude 调试接口存在未认可的进程连接</strong>{snapshot.claudeInspector.clients.filter((client) => !client.approved).map((client) => <p key={client.pid}>PID {client.pid} · {client.name} · {client.executablePath ?? client.pathError ?? "路径未知"}</p>)}</div>
        </div>}
        {tab === "sessions" && (
          <DesktopSessions
            snapshot={visibleSnapshot!}
            events={events}
            apiRequest={request}
            onRefreshSnapshot={async () => {
              setSnapshot(await api.getSnapshot());
            }}

          />
        )}
        {tab === "devices" && (
          <DesktopDevices
            snapshot={snapshot}
            onCreatePairing={async () => setSnapshot(await api.createPairing())}
            onRevoke={async (deviceId) => setSnapshot(await api.revokeDevice(deviceId))}
          />
        )}
        {tab === "settings" && (
          <DesktopSettings snapshot={snapshot} api={api} onSnapshot={setSnapshot} themeControl={themeControl} />
        )}
      </section>
      <DiagnosticFloatingEntry desktopSnapshot={snapshot} />
    </main>
    </MagpieQuotaProvider>
    </MediaPreviewProvider>
  );
}
