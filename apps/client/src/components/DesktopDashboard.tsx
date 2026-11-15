import type {
  BridgeDeviceInfo,
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
  Mail,
  QrCode,
  Settings2,
  Smartphone,
  Trash2,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useMemo, useRef, useState } from "react";
import { MAGPIE_QUOTA_METHOD, type QuotaSnapshot } from "../../../../plugins/magpie-quota/contract.js";
import { MagpieQuotaProvider } from "../../../../plugins/magpie-quota/client.js";
import type { ThemeControl } from "../hooks/useTheme.js";
import { claudeSnapshot } from "../lib/claude-snapshot.js";
import { BrandMark } from "./common/BrandMark.js";
import { ConfirmationDialog } from "./common/ConfirmationDialog.js";
import { DiagnosticFloatingEntry } from "./common/DiagnosticLogDialog.js";
import { EmptyState } from "./common/EmptyState.js";
import { IconButton } from "./common/IconButton.js";
import { ThemeMenu } from "./common/ThemeMenu.js";
import {
  DesktopConversationProvider,
  DesktopSessionConversation,
} from "./desktop/DesktopSessionConversation.js";
import { DesktopSessions, unwrap } from "./desktop/DesktopSessionsPane.js";
import { DesktopSettings } from "./desktop/DesktopSettings.js";
import { MediaPreviewProvider } from "./evidence/MediaPreviewProvider.js";

import { AssistantMailProvider, useAssistantMail, type AssistantRequest } from "./assistant/AssistantMailProvider.js";
import { AssistantPage } from "./assistant/AssistantPage.js";
import { ConversationDraftsProvider } from "./conversation/ConversationDraftsProvider.js";

type DesktopTab = "sessions" | "assistant" | "devices" | "settings";
const EMPTY_EVENTS: BridgeEvent[] = [];

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

function DesktopAssistantNavButton({
  active,
  onSelect,
}: {
  active: boolean;
  onSelect(): void;
}) {
  const assistantMail = useAssistantMail();
  const unreadCount = assistantMail?.unreadCount ?? 0;
  return (
    <button
      className={active ? "active" : ""}
      type="button"
      aria-current={active ? "page" : undefined}
      onClick={onSelect}
    >
      <span className="desktop-nav-icon-wrap">
        <Mail size={19} aria-hidden="true" />
        {unreadCount > 0 && (
          <b className="desktop-nav-badge" aria-hidden="true">
            {unreadCount > 99 ? "99+" : unreadCount}
          </b>
        )}
      </span>
      <span>助理</span>
    </button>
  );
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

  const activeDevices = snapshot.devices.filter((device) => !device.revokedAt);

  return (
    <section className="desktop-page">
      <div className="desktop-page-shell">
        <header className="desktop-page-heading">
          <h1>设备</h1>
          <button type="button" className="primary-button" disabled={pairingBusy} onClick={() => void handleCreatePairing()}>
            <QrCode size={17} aria-hidden="true" />
            添加手机
          </button>
        </header>
        {deviceError && <p role="alert" className="inline-error">{deviceError}</p>}
        {snapshot.pairingUrl && snapshot.pairingExpiresAt && (
          <section className="device-pairing-band" aria-label="手机扫码配对">
            <div className="qr-wrap">
              <QRCodeSVG value={snapshot.pairingUrl} size={320} level="M" marginSize={4} title="手机配对二维码" />
            </div>
            <div className="device-pairing-copy">
              <h2>使用手机 Bridge 扫描</h2>
              <p>二维码十分钟内有效，首次扫描后绑定到该手机安装。也可以复制配对链接，在手机端粘贴完成配对。</p>
              <div className="device-pairing-actions">
                <button type="button" className="secondary-button" onClick={() => void copyPairingLink()}>
                  <Clipboard size={16} aria-hidden="true" />
                  {copyState === "copied" ? "已复制配对链接" : copyState === "error" ? "复制失败，请扫码" : "复制配对链接"}
                </button>
              </div>
              <small>{Math.max(0, Math.ceil((snapshot.pairingExpiresAt - Date.now()) / 60_000))} 分钟后过期</small>
            </div>
          </section>
        )}
        {activeDevices.length > 0 ? (
          <div className="m-group desktop-device-list" role="list" aria-label="已配对手机">
            {activeDevices.map((device) => (
              <article className="desktop-device-row" role="listitem" key={device.deviceId}>
                <span className="device-icon" aria-hidden="true"><Smartphone size={19} /></span>
                <div>
                  <strong>{device.name}</strong>
                  <span>{device.platform.toUpperCase()} · {formatLastSeen(device.lastSeenAt, device.online)}</span>
                </div>
                <span className={`device-online-state ${device.online ? "online" : ""}`}>
                  <i aria-hidden="true" />
                  {device.online ? "在线" : "已授权"}
                </span>
                <IconButton label={`撤销 ${device.name}`} disabled={revokeBusy} onClick={() => setRevokeCandidate(device)}>
                  <Trash2 size={17} />
                </IconButton>
              </article>
            ))}
          </div>
        ) : (
          <EmptyState
            className="desktop-page-empty m-group"
            icon={<Smartphone size={24} aria-hidden="true" />}
            title="还没有配对手机"
            description="点击右上角生成十分钟有效的二维码。"
          />
        )}
      </div>
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

export function DesktopDashboard({ themeControl }: { themeControl: ThemeControl }) {
  const api = window.bridgeDesktop;
  const [snapshot, setSnapshot] = useState<DesktopControlSnapshot>();
  const [eventsByHost, setEventsByHost] = useState<Record<string, BridgeEvent[]>>({});
  const [tab, setTab] = useState<DesktopTab>("sessions");
  const [focusRequest, setFocusRequest] = useState<{ sessionId: string; key: number }>();
  const focusKeyRef = useRef(0);
  const activeHostIdRef = useRef<string | undefined>(undefined);
  if (snapshot) activeHostIdRef.current = snapshot.host.hostId;
  const mailRequest = useMemo<AssistantRequest>(() => (method, params) => api!.request({ method, params }), [api]);
  const visibleSnapshot = useMemo(() => snapshot ? claudeSnapshot(snapshot) : undefined, [snapshot]);

  function applySnapshot(nextSnapshot: DesktopControlSnapshot): void {
    activeHostIdRef.current = nextSnapshot.host.hostId;
    setSnapshot(nextSnapshot);
  }

  useEffect(() => {
    if (!api) return;
    void api.getSnapshot().then(applySnapshot);
    const stopSnapshots = api.onSnapshot(applySnapshot);
    const stopEvents = api.onEvent((event) => {
      const currentHostId = activeHostIdRef.current;
      if (!currentHostId) return;
      setEventsByHost((current) => {
        const hostEvents = current[currentHostId] ?? EMPTY_EVENTS;
        const nextHostEvents = [
          ...hostEvents.filter((candidate) => candidate.eventId !== event.eventId),
          summarizeEvidenceEvent(event),
        ]
          .sort((left, right) => left.seq - right.seq)
          .slice(-2_000);
        return { ...current, [currentHostId]: nextHostEvents };
      });
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

  const events = eventsByHost[snapshot.host.hostId] ?? EMPTY_EVENTS;
  const hostOnline = snapshot.connection === "connected" && !snapshot.host.version.startsWith("0.2.");

  async function request(input: LocalBridgeRequest): Promise<BridgeResponse> {
    return api!.request(input);
  }

  async function refreshSnapshot(): Promise<void> {
    applySnapshot(await api!.getSnapshot());
  }

  function openDesktopSession(sessionId: string): void {
    focusKeyRef.current += 1;
    setFocusRequest({ sessionId, key: focusKeyRef.current });
    setTab("sessions");
  }

  return (
    <ConversationDraftsProvider activeHostId={snapshot.host.hostId}>
    <DesktopConversationProvider snapshot={visibleSnapshot!} events={events} eventsByHost={eventsByHost} apiRequest={request} onRefreshSnapshot={refreshSnapshot}>
    <MediaPreviewProvider request={(method, params) => request({ method, params })} supportsFileStat={snapshot.host.capabilities.includes("artifact.transfer.stat.v1")}>
    <MagpieQuotaProvider loader={loadMagpieQuota} enabled={snapshot.host.capabilities.includes("plugin.magpie-quota.v1")} sourceKey={snapshot.runtime.detection?.refreshedAt ?? 0}>
    <AssistantMailProvider key={snapshot.host.hostId} snapshot={snapshot} online request={mailRequest} onDiscuss={() => setTab("assistant")}>
    <main className="desktop-shell-v2">
      <aside className="desktop-nav-v2">
        <BrandMark compact />
        <nav aria-label="Bridge 主导航">
          <button
            className={tab === "sessions" ? "active" : ""}
            type="button"
            aria-current={tab === "sessions" ? "page" : undefined}
            onClick={() => setTab("sessions")}
          >
            <MessageSquare size={19} aria-hidden="true" />
            <span>会话</span>
          </button>
          {snapshot.host.capabilities.includes("plugin.assistant-mail.v1") && (
            <DesktopAssistantNavButton active={tab === "assistant"} onSelect={() => setTab("assistant")} />
          )}
          <button
            className={tab === "devices" ? "active" : ""}
            type="button"
            aria-current={tab === "devices" ? "page" : undefined}
            onClick={() => setTab("devices")}
          >
            <Smartphone size={19} aria-hidden="true" />
            <span>设备</span>
          </button>
          <button
            className={tab === "settings" ? "active" : ""}
            type="button"
            aria-current={tab === "settings" ? "page" : undefined}
            onClick={() => setTab("settings")}
          >
            <Settings2 size={19} aria-hidden="true" />
            <span>设置</span>
          </button>
        </nav>
        <div className="desktop-host-chip" title={`${snapshot.host.name} · ${connectionLabel(snapshot)}`}>
          <span className="desktop-host-chip-icon">
            <Laptop size={16} aria-hidden="true" />
            <i className={`m-status-dot ${hostOnline ? "is-online" : ""}`} aria-hidden="true" />
          </span>
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
            initialSessionId={focusRequest?.sessionId}
            focusRequest={focusRequest}
            events={events}
            apiRequest={request}
            onRefreshSnapshot={refreshSnapshot}
          />
        )}
        {tab === "assistant" && (
          <AssistantPage
            snapshot={visibleSnapshot!}
            onOpenSession={openDesktopSession}
            renderConversation={(sessionId) => {
              const boundSession = visibleSnapshot!.sessions.find((candidate) => candidate.sessionId === sessionId);
              return boundSession ? (
                <section className="desktop-conversation">
                  <DesktopSessionConversation
                    session={boundSession}
                    snapshot={visibleSnapshot!}
                    events={events}
                    apiRequest={request}
                    onRefreshSnapshot={refreshSnapshot}
                    onSelectSession={(nextSessionId) => {
                      if (nextSessionId !== sessionId) openDesktopSession(nextSessionId);
                    }}
                  />
                </section>
              ) : (
                <section className="desktop-conversation">
                  <div className="desktop-conversation-empty">
                    <MessageSquare size={24} />
                    <span>绑定会话暂不可用，请在助理设置中核对绑定。</span>
                  </div>
                </section>
              );
            }}
          />
        )}
        {tab === "devices" && (
          <DesktopDevices
            snapshot={snapshot}
            onCreatePairing={async () => applySnapshot(await api.createPairing())}
            onRevoke={async (deviceId) => applySnapshot(await api.revokeDevice(deviceId))}
          />
        )}
        {tab === "settings" && (
          <DesktopSettings snapshot={snapshot} api={api} onSnapshot={applySnapshot} themeControl={themeControl} />
        )}
      </section>
      <DiagnosticFloatingEntry desktopSnapshot={snapshot} />
    </main>
    </AssistantMailProvider>
    </MagpieQuotaProvider>
    </MediaPreviewProvider>
    </DesktopConversationProvider>
    </ConversationDraftsProvider>
  );
}
