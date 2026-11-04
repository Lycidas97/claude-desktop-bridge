import { ChevronRight, Laptop, MoreHorizontal, Plus, ScanLine, Settings2, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { PairedHost } from "../hooks/useMobileBridge.js";
import type { ThemeControl } from "../hooks/useTheme.js";
import { registerMobileBackHandler } from "../lib/mobile-back-navigation.js";
import { ConfirmationDialog } from "./ConfirmationDialog.js";
import { IconButton } from "./IconButton.js";
import { MobilePageHeader } from "./MobilePageHeader.js";
import { MobileSheet, SheetAction } from "./MobileSheet.js";

function statusLabel(host: PairedHost): string {
  if (host.needsRepair) return "需重配";
  if (host.status === "running") return `${host.activeTurns} 个任务中`;
  if (host.status === "attention") return "待处理";
  if (host.status === "offline") return "离线";
  return "在线";
}

function lastSeenLabel(host: PairedHost): string {
  if (host.needsRepair) return "旧版配对，需要重新扫码";
  if (!host.lastSeenAt) return "已配对";
  const elapsed = Math.max(0, Date.now() - host.lastSeenAt);
  if (elapsed < 60_000) return "刚刚活跃";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`;
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(host.lastSeenAt);
}

export function HostBrowser({
  hosts,
  error,
  activeHostId,
  onDetails,
  onSelect,
  onRemove,
  onAdd,
  onRepair,
}: {
  hosts: PairedHost[];
  error?: string | undefined;
  themeControl?: ThemeControl;
  activeHostId?: string | undefined;
  onDetails?(hostId: string): void;
  onSelect(roomId: string, focusSessionId?: string): Promise<void>;
  onRemove(roomId: string): Promise<void>;
  onAdd(): void;
  onRepair(): void;
}) {
  const [openingHostId, setOpeningHostId] = useState<string>();
  const [menuHost, setMenuHost] = useState<PairedHost>();
  const [removeCandidate, setRemoveCandidate] = useState<PairedHost>();
  const [removing, setRemoving] = useState(false);

  useEffect(() => {
    if (!removeCandidate && !menuHost) return;
    return registerMobileBackHandler(() => {
      if (removeCandidate) {
        if (!removing) setRemoveCandidate(undefined);
      } else {
        setMenuHost(undefined);
      }
      return true;
    }, 200);
  }, [menuHost, removeCandidate, removing]);

  async function openHost(host: PairedHost, focusSessionId?: string): Promise<void> {
    if (openingHostId) return;
    if (host.needsRepair) {
      onRepair();
      return;
    }
    setOpeningHostId(host.roomId);
    try {
      if (focusSessionId) await onSelect(host.roomId, focusSessionId);
      else await onSelect(host.roomId);
    } finally {
      setOpeningHostId(undefined);
    }
  }

  async function removeHost(): Promise<void> {
    if (!removeCandidate || removing) return;
    setRemoving(true);
    try {
      await onRemove(removeCandidate.roomId);
      setRemoveCandidate(undefined);
    } finally {
      setRemoving(false);
    }
  }

  return (
    <main className="mobile-workspace host-list-workspace">
      <MobilePageHeader
        title="电脑"
        subtitle={`${hosts.length} 台电脑已配对`}
        actions={<IconButton label="添加电脑" onClick={onAdd}><Plus size={22} /></IconButton>}
      />

      <section className="host-browser" aria-label="已配对的电脑">
        <div className="host-rows">
          {hosts.map((host) => (
            <div className="host-row-shell" key={host.roomId}>
              <button
                type="button"
                className="host-row"
                onClick={() => void openHost(host)}
                disabled={Boolean(openingHostId) || removing}
              >
                <span className="host-row-icon"><Laptop size={20} /></span>
                <span className="host-row-copy">
                  <strong>{host.desktopName}</strong>
                  <small>
                    {openingHostId === host.roomId
                      ? "正在连接"
                      : `${host.roomId === activeHostId ? "当前电脑 · " : ""}${lastSeenLabel(host)}`}
                  </small>
                </span>
                <span className={`host-row-state ${host.needsRepair || host.status === "attention" ? "warning" : host.status}`}>
                  <i />{statusLabel(host)}
                </span>
              </button>
              <IconButton
                className="host-row-action"
                label={`${host.desktopName} 的操作`}
                onClick={() => setMenuHost(host)}
                disabled={Boolean(openingHostId) || removing}
              >
                <MoreHorizontal size={20} />
              </IconButton>
              {host.attentionSessionId && !host.needsRepair && (
                <button
                  type="button"
                  className="host-attention-button"
                  disabled={Boolean(openingHostId) || removing}
                  onClick={() => void openHost(host, host.attentionSessionId)}
                >
                  查看待处理<ChevronRight size={15} aria-hidden="true" />
                </button>
              )}
            </div>
          ))}
        </div>
        {error && <div className="inline-error host-error" role="alert">{error}</div>}
        <p className="host-browser-hint">点电脑查看它的会话；连接、桌面应用和默认授权在“⋯”中设置。</p>
      </section>
      {menuHost && (
        <MobileSheet
          eyebrow={menuHost.roomId === activeHostId ? "当前电脑" : "已配对电脑"}
          title={menuHost.desktopName}
          onClose={() => setMenuHost(undefined)}
        >
          <div className="m-group">
            {menuHost.needsRepair ? (
              <SheetAction
                icon={<ScanLine size={19} />}
                label="重新扫码配对"
                detail="旧版配对已失效，需要电脑端新二维码"
                onClick={() => {
                  setMenuHost(undefined);
                  onRepair();
                }}
              />
            ) : onDetails && (
              <SheetAction
                icon={<Settings2 size={19} />}
                label="连接与电脑设置"
                detail={menuHost.roomId === activeHostId ? "连接状态、桌面应用、默认授权" : "切换到这台电脑后打开"}
                onClick={() => {
                  setMenuHost(undefined);
                  onDetails(menuHost.roomId);
                }}
              />
            )}
          </div>
          <div className="m-group">
            <SheetAction
              icon={<Trash2 size={19} />}
              label="移除这台电脑"
              detail="清除手机上的密钥和消息"
              danger
              onClick={() => {
                setMenuHost(undefined);
                setRemoveCandidate(menuHost);
              }}
            />
          </div>
        </MobileSheet>
      )}
      <ConfirmationDialog
        open={Boolean(removeCandidate)}
        title="移除这台电脑？"
        description={`将清除“${removeCandidate?.desktopName ?? "这台电脑"}”在手机上的密钥和消息；电脑在线时也会同步撤销这台手机的权限。`}
        confirmLabel="移除电脑"
        danger
        busy={removing}
        onCancel={() => setRemoveCandidate(undefined)}
        onConfirm={() => void removeHost()}
      />
    </main>
  );
}
