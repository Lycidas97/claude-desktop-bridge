import { ChevronRight, Laptop, ScanLine, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { PairedHost } from "../hooks/useMobileBridge.js";
import type { ThemeControl } from "../hooks/useTheme.js";
import { registerMobileBackHandler } from "../lib/mobile-back-navigation.js";
import { ConfirmationDialog } from "./ConfirmationDialog.js";
import { IconButton } from "./IconButton.js";

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
  const [removeCandidate, setRemoveCandidate] = useState<PairedHost>();
  const [removing, setRemoving] = useState(false);

  useEffect(() => {
    if (!removeCandidate) return;
    return registerMobileBackHandler(() => {
      if (!removing) setRemoveCandidate(undefined);
      return true;
    }, 200);
  }, [removeCandidate, removing]);

  async function openHost(host: PairedHost, focusSessionId?: string): Promise<void> {
    if (openingHostId) return;
    if (host.needsRepair) {
      onRepair();
      return;
    }
    if (!focusSessionId && host.roomId === activeHostId && onDetails) {
      onDetails(host.roomId);
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
      <header className="mobile-page-header">
        <div>
          <h1>电脑</h1>
          <p className="detail-text">{hosts.length} 台电脑已配对</p>
        </div>
      </header>

      <section className="host-browser" aria-label="已配对的电脑">
        <div className="host-rows">
          {hosts.map((host) => (
            <div className={`host-row-shell ${onDetails && host.roomId === activeHostId ? "host-row-shell--details" : "host-row-shell--removable"}`} key={host.roomId}>
              <button
                type="button"
                className="host-row"
                onClick={() => void openHost(host)}
                disabled={Boolean(openingHostId) || removing}
              >
                <span className="host-row-icon"><Laptop size={19} /></span>
                <span className="host-row-copy">
                  <strong>{host.desktopName}</strong>
                  <small>
                    {host.roomId === activeHostId && <span className="host-current-label">当前电脑 · </span>}
                    {openingHostId === host.roomId ? "正在连接" : host.needsRepair ? lastSeenLabel(host) : host.roomId !== activeHostId ? "切换到此电脑" : lastSeenLabel(host)}
                  </small>
                </span>
                <span className={`host-row-state ${host.needsRepair || host.status === "attention" ? "warning" : host.status}`}>
                  <i />{statusLabel(host)}
                </span>
                <ChevronRight size={18} aria-hidden="true" />
              </button>
              {(!onDetails || host.roomId !== activeHostId) && (
                <IconButton
                  className="host-remove-button"
                  label={`删除 ${host.desktopName}`}
                  onClick={() => setRemoveCandidate(host)}
                  disabled={Boolean(openingHostId) || removing}
                >
                  <Trash2 size={17} />
                </IconButton>
              )}
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
        <button type="button" className="secondary-button add-host-button" onClick={onAdd}>
          <ScanLine size={18} /><span>添加电脑</span>
        </button>
      </section>
      <ConfirmationDialog
        open={Boolean(removeCandidate)}
        title="删除这台电脑？"
        description={`将清除“${removeCandidate?.desktopName ?? "这台电脑"}”在手机上的密钥和消息；电脑在线时也会同步撤销这台手机的权限。`}
        confirmLabel="删除主机"
        danger
        busy={removing}
        onCancel={() => setRemoveCandidate(undefined)}
        onConfirm={() => void removeHost()}
      />
    </main>
  );
}
