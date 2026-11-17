import type { BridgeDesktopAppStatus, BridgeHostSnapshot, BridgeInspectorStatus } from "@bridge/protocol";
import { LoaderCircle, Play } from "lucide-react";
import { useEffect, useState } from "react";
import { readClaudeInspector } from "../../lib/claude-snapshot.js";

export interface ClaudeRemoteActivationStatus {
  inspector: BridgeInspectorStatus | undefined;
  claudeApp: BridgeDesktopAppStatus | undefined;
  inspectorClosed: boolean;
  nativeUnavailable: boolean;
  cannotActivate: boolean;
  portLabel: "已开启" | "未开启";
  title: string;
  buttonLabel: string;
}

export function resolveClaudeRemoteActivationStatus(
  snapshot: BridgeHostSnapshot | undefined,
): ClaudeRemoteActivationStatus {
  const inspector = readClaudeInspector(snapshot);
  const claudeApp: BridgeDesktopAppStatus | undefined = snapshot?.desktopApps?.find(
    (app) => app.id === "claude-desktop",
  ) ?? (snapshot?.claudeDesktop
    ? { id: "claude-desktop", name: "Claude Desktop", ...snapshot.claudeDesktop }
    : undefined);
  const inspectorClosed = inspector?.state === "closed" || inspector?.state === "error";
  const nativeUnavailable = !snapshot
    ? false
    : snapshot.runtime.desktopIntegration.state !== "ready" || inspectorClosed;
  const cannotActivate = claudeApp?.state === "unavailable"
    || (claudeApp?.state !== "running" && claudeApp?.canLaunch === false);
  const portLabel: "已开启" | "未开启" = !nativeUnavailable || inspector?.state === "listening"
    ? "已开启"
    : "未开启";
  const title = claudeApp?.state === "stopped"
    ? "Claude Desktop 未启动"
    : inspectorClosed
      ? "Claude 调试端口未开启"
      : "Claude 原生连接未就绪";
  const buttonLabel = claudeApp?.state === "stopped"
    ? "启动 Claude 并开启调试"
    : "开启调试端口";

  return {
    inspector,
    claudeApp,
    inspectorClosed,
    nativeUnavailable,
    cannotActivate,
    portLabel,
    title,
    buttonLabel,
  };
}

export function resolveClaudeRemoteActivationDetail(
  snapshot: BridgeHostSnapshot | undefined,
  options?: { actionError?: string | undefined; attempted?: boolean | undefined },
): string {
  if (options?.actionError) return options.actionError;
  const inspector = readClaudeInspector(snapshot);
  if (
    inspector?.startup?.state === "accessibility-required"
    || inspector?.startup?.state === "failed"
    || (options?.attempted && inspector?.state !== "listening" && Boolean(inspector?.startup?.detail))
  ) {
    if (inspector?.startup?.detail) return inspector.startup.detail;
  }
  return snapshot?.runtime.desktopIntegration.detail || "点击远程启动 Claude 并开启 9229 调试端口";
}

export interface MobileInspectorCalloutProps {
  snapshot: BridgeHostSnapshot | undefined;
  connected: boolean;
  onActivate?: (() => Promise<void>) | undefined;
}

export function MobileInspectorCallout({
  snapshot,
  connected,
  onActivate,
}: MobileInspectorCalloutProps) {
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [attempted, setAttempted] = useState(false);

  const status = resolveClaudeRemoteActivationStatus(snapshot);
  const hostId = snapshot?.host.hostId;

  useEffect(() => {
    setActionError(undefined);
    setAttempted(false);
  }, [hostId]);

  useEffect(() => {
    if (!status.nativeUnavailable) {
      setActionError(undefined);
      setAttempted(false);
    }
  }, [status.nativeUnavailable]);

  if (!connected || !snapshot || !status.nativeUnavailable || !onActivate) {
    return null;
  }

  const detail = resolveClaudeRemoteActivationDetail(snapshot, { actionError, attempted });

  async function handleActivate(): Promise<void> {
    if (busy || status.cannotActivate || !onActivate) return;
    setBusy(true);
    setActionError(undefined);
    setAttempted(true);
    try {
      await onActivate();
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : "开启调试端口失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mobile-inspector-callout" role="status">
      <div className="mobile-inspector-callout-copy">
        <strong>{status.title}</strong>
        <p className={actionError ? "is-error" : undefined}>{detail}</p>
      </div>
      <button
        type="button"
        className="primary-button mobile-inspector-callout-btn"
        disabled={busy || status.cannotActivate}
        onClick={() => void handleActivate()}
      >
        {busy ? (
          <>
            <LoaderCircle size={15} className="is-spinning" aria-hidden="true" />
            <span>正在开启…</span>
          </>
        ) : (
          <>
            <Play size={14} aria-hidden="true" />
            <span>{status.buttonLabel}</span>
          </>
        )}
      </button>
    </section>
  );
}
