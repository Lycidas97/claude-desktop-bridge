import type { BridgeClaudeActivationResult, BridgeDesktopAppStatus, BridgeHostSnapshot, BridgeInspectorStatus } from "@bridge/protocol";
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
    : inspector?.state === "listening"
      ? "重新连接 Claude"
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
  options?: { attempted?: boolean },
): string {
  const unavailableApp = snapshot?.desktopApps?.find((app) => app.id === "claude-desktop") ?? snapshot?.claudeDesktop;
  if (unavailableApp?.state === "unavailable") return unavailableApp.detail;
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
  onActivate?: (() => Promise<BridgeClaudeActivationResult | undefined>) | undefined;
}

export function useClaudeRemoteActivation(
  onActivate: MobileInspectorCalloutProps["onActivate"],
  snapshot: BridgeHostSnapshot | undefined,
) {
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ detail: string; error?: boolean } | "missing">();
  useEffect(() => setFeedback(undefined), [snapshot?.host.hostId]);

  async function activate(): Promise<void> {
    if (busy || !onActivate) return;
    setBusy(true);
    setFeedback(undefined);
    try {
      const result = await onActivate();
      if (!result) {
        setFeedback("missing");
      } else if (result.inspectorState === "listening") {
        setFeedback({ detail: result.nativeReady
          ? "调试端口已开启，Claude 原生连接已就绪。"
          : `调试端口已开启，Claude 原生连接未就绪。${result.detail ?? ""}` });
      } else {
        const fallback = {
          closed: "本次未开启调试端口，请在电脑上手动开启。",
          unsupported: "当前电脑不支持自动开启调试端口。",
          starting: "电脑仍在检查调试端口，暂未确认是否开启。",
          error: "电脑无法检查调试端口状态。",
          unknown: "电脑无法确认调试端口是否开启。",
        }[result.inspectorState];
        setFeedback({ detail: result.detail || fallback, error: true });
      }
    } catch (reason) {
      setFeedback({ detail: reason instanceof Error ? reason.message : "开启调试端口失败", error: true });
    } finally {
      setBusy(false);
    }
  }

  const startup = readClaudeInspector(snapshot)?.startup;
  return {
    busy,
    feedback: feedback === "missing"
      ? { detail: startup?.detail || "电脑未返回本次开启结果。", error: startup?.state === "failed" || startup?.state === "accessibility-required" }
      : feedback,
    activate,
  };
}

export function MobileInspectorCallout({ snapshot, connected, onActivate }: MobileInspectorCalloutProps) {
  const status = resolveClaudeRemoteActivationStatus(snapshot);
  const { busy, feedback, activate } = useClaudeRemoteActivation(onActivate, snapshot);
  if (!connected || !snapshot || !onActivate || (!status.nativeUnavailable && !busy && !feedback)) return null;

  return (
    <section className="mobile-inspector-callout" role="status">
      <div className="mobile-inspector-callout-copy">
        {status.nativeUnavailable && <strong>{status.title}</strong>}
        <p className={feedback?.error ? "is-error" : undefined}>
          {feedback?.detail ?? (status.nativeUnavailable ? resolveClaudeRemoteActivationDetail(snapshot) : "正在确认开启结果…")}
        </p>
      </div>
      {status.nativeUnavailable && <button
        type="button"
        className="primary-button mobile-inspector-callout-btn"
        disabled={busy || status.cannotActivate}
        onClick={() => void activate()}
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
      </button>}
    </section>
  );
}
