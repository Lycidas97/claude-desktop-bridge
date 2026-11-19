import { ChevronRight, MoreHorizontal, Plus, ScanLine, Settings2, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { PairedHost } from "../../hooks/useMobileBridge.js";
import type { ThemeControl } from "../../hooks/useTheme.js";
import { registerMobileBackHandler } from "../../lib/mobile-back-navigation.js";
import { ConfirmationDialog } from "../common/ConfirmationDialog.js";
import { IconButton } from "../common/IconButton.js";
import { Sheet, SheetAction } from "../common/Sheet.js";
import { MobilePageHeader } from "../mobile/MobilePageHeader.js";
import { formatHostLastSeen } from "./host-last-seen.js";

function statusLabel(host: PairedHost, isCurrent: boolean, isOnline: boolean): string {
  if (host.needsRepair) return "需重新扫码配对";
  if (!isCurrent) return "未连接";
  if (!isOnline) return "离线";
  if (host.status === "running") return `${host.activeTurns} 个任务运行中`;
  if (host.status === "attention") return "有待处理消息";
  return "在线";
}

function statusDotClass(host: PairedHost, isCurrent: boolean, isOnline: boolean): string {
  if (host.needsRepair) return "m-status-dot waiting";
  if (!isCurrent) return "m-status-dot";
  if (!isOnline) return "m-status-dot is-offline";
  return host.status === "attention" ? "m-status-dot waiting" : "m-status-dot is-online";
}

export function HostBrowser({
  hosts,
  error,
  activeHostId,
  desktopOnline,
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
  desktopOnline: boolean;
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
        title="已配对电脑"
        actions={(
          <button
            type="button"
            className="mobile-header-pill-action"
            aria-label="添加电脑"
            onClick={onAdd}
          >
            <Plus size={14} aria-hidden="true" />
            <span>扫码</span>
          </button>
        )}
      />

      <section className="host-browser" aria-label="已配对的电脑">
        <header className="host-browser-section-head">
          <span>已授权主机 · {hosts.length}</span>
        </header>
        <div className="host-rows">
          {hosts.map((host) => {
            const isCurrent = host.roomId === activeHostId;
            const isOnline = isCurrent && desktopOnline && !host.needsRepair;
            return (
              <div className={`host-row-shell${isCurrent ? " is-current" : ""}`} key={host.roomId}>
                <button
                  type="button"
                  className="host-row"
                  aria-current={isCurrent ? "true" : undefined}
                  onClick={() => void openHost(host)}
                  disabled={Boolean(openingHostId) || removing}
                >
                  <i className={statusDotClass(host, isCurrent, isOnline)} aria-hidden="true" />
                  <span className="host-row-copy">
                    <strong>{host.desktopName}</strong>
                    <small>
                      {openingHostId === host.roomId
                        ? "正在连接…"
                        : `${isCurrent ? "当前电脑 · " : ""}${statusLabel(host, isCurrent, isOnline)} · ${host.needsRepair ? "旧版配对已失效" : formatHostLastSeen(host.lastSeenAt) ?? "已配对"}`}
                    </small>
                  </span>
                </button>
                <IconButton
                  className="host-row-action"
                  label={`${host.desktopName} 的操作`}
                  onClick={() => setMenuHost(host)}
                  disabled={Boolean(openingHostId) || removing}
                >
                  <MoreHorizontal size={18} />
                </IconButton>
                {host.attentionSessionId && !host.needsRepair && (
                  <button
                    type="button"
                    className="host-attention-button"
                    disabled={Boolean(openingHostId) || removing}
                    onClick={() => void openHost(host, host.attentionSessionId)}
                  >
                    {isOnline ? "查看待处理" : "查看上次待处理"}<ChevronRight size={15} aria-hidden="true" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
        {error && <div className="inline-error host-error" role="alert">{error}</div>}
        <p className="host-browser-hint">
          在电脑端打开 Bridge →「设置 → 手机配对与设备」即可展示配对二维码。所有会话流与工具审批均经端到端加密传输。
        </p>
      </section>
      {menuHost && (
        <Sheet
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
        </Sheet>
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
