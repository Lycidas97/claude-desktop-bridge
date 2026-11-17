import type { BridgeSessionContextUsage, BridgeTokenUsage } from "@bridge/protocol";
import { LoaderCircle, Minimize2 } from "lucide-react";
import { useEffect, useState, type RefObject } from "react";
import { type SessionActivity } from "../../lib/session-activity.js";

export function formatCompactElapsed(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 ? `${minutes}m ${seconds % 60}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
}

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  return <small className="session-activity-elapsed">· {formatCompactElapsed((now - since) / 1_000)}</small>;
}

export function formatContextTokens(value: number): string {
  if (value >= 999_500) {
    const millions = Math.round((value / 1_000_000) * 10) / 10;
    return Number.isInteger(millions) ? `${millions}M` : `${millions.toFixed(1)}M`;
  }
  if (value >= 10_000) return `${Math.round(value / 1_000)}K`;
  if (value >= 1_000) {
    const thousands = Math.round((value / 1_000) * 10) / 10;
    return Number.isInteger(thousands) ? `${thousands}K` : `${thousands.toFixed(1)}K`;
  }
  return String(Math.round(value));
}

export function formatContextPercentage(value: number): string {
  const clamped = Math.min(100, Math.max(0, value));
  if (clamped > 0 && clamped < 1) return "<1%";
  return `${Math.round(clamped)}%`;
}

export interface ContextTokenBreakdown {
  inputTokens: number;
  cacheTokens: number;
  outputTokens: number;
}

export function resolveContextTokenBreakdown(
  usage: BridgeSessionContextUsage,
  turnUsage?: BridgeTokenUsage | undefined,
): ContextTokenBreakdown {
  const total = Math.max(0, Math.round(usage.totalTokens));
  if (!turnUsage) {
    return { inputTokens: total, cacheTokens: 0, outputTokens: 0 };
  }
  const rawInput = Math.max(0, Math.round((turnUsage.inputTokens ?? 0) + (turnUsage.cacheWriteTokens ?? 0)));
  const rawCache = Math.max(0, Math.round(turnUsage.cacheReadTokens ?? 0));
  const rawOutput = Math.max(0, Math.round(turnUsage.outputTokens ?? 0));
  if (rawInput + rawCache + rawOutput <= 0) {
    return { inputTokens: total, cacheTokens: 0, outputTokens: 0 };
  }
  const cacheTokens = Math.min(total, rawCache);
  const outputTokens = Math.min(Math.max(0, total - cacheTokens), rawOutput);
  const inputTokens = Math.max(0, total - cacheTokens - outputTokens);
  return { inputTokens, cacheTokens, outputTokens };
}

export interface SessionContextUsageBarProps {
  usage?: BridgeSessionContextUsage | undefined;
  turnUsage?: BridgeTokenUsage | undefined;
  open?: boolean | undefined;
  onToggle?: (() => void) | undefined;
  onCompact?: (() => void) | undefined;
  compactDisabled?: boolean | undefined;
  compactBusy?: boolean | undefined;
  triggerRef?: RefObject<HTMLButtonElement | null> | undefined;
  popoverRef?: RefObject<HTMLDivElement | null> | undefined;
  containerRef?: RefObject<HTMLDivElement | null> | undefined;
}

export function SessionContextUsageBar({
  usage,
  turnUsage,
  open = false,
  onToggle,
  onCompact,
  compactDisabled = false,
  compactBusy = false,
  triggerRef,
  popoverRef,
  containerRef,
}: SessionContextUsageBarProps) {
  if (!usage || !(usage.totalTokens > 0)) return null;
  const hasCapacity = typeof usage.maxTokens === "number"
    && usage.maxTokens > 0
    && typeof usage.percentage === "number"
    && Number.isFinite(usage.percentage);
  const pct = hasCapacity ? Math.min(100, Math.max(0, usage.percentage!)) : undefined;
  const tone = pct === undefined ? "" : pct >= 90 ? " is-critical" : pct >= 75 ? " is-high" : "";
  const pillText = hasCapacity ? formatContextPercentage(pct!) : formatContextTokens(usage.totalTokens);
  const pillLabel = hasCapacity
    ? `上下文窗口 ${pillText} (${formatContextTokens(usage.totalTokens)} / ${formatContextTokens(usage.maxTokens!)})`
    : `上下文窗口 ${pillText}`;
  const breakdown = resolveContextTokenBreakdown(usage, turnUsage);
  const denom = hasCapacity ? usage.maxTokens! : Math.max(1, usage.totalTokens);
  const inputWidth = Math.min(100, (breakdown.inputTokens / denom) * 100);
  const cacheWidth = Math.min(Math.max(0, 100 - inputWidth), (breakdown.cacheTokens / denom) * 100);
  const outputWidth = Math.min(Math.max(0, 100 - inputWidth - cacheWidth), (breakdown.outputTokens / denom) * 100);

  return (
    <div className={`session-context-bar${tone}${open ? " is-open" : ""}`} ref={containerRef}>
      <button
        type="button"
        ref={triggerRef}
        className={`session-context-pill num${open ? " is-open" : ""}`}
        aria-label={pillLabel}
        title={pillLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={onToggle}
      >
        {pillText}
      </button>
      {open && (
        <div
          className="context-window-popover"
          ref={popoverRef}
          role="dialog"
          aria-label="上下文窗口"
          tabIndex={-1}
        >
          <div className="context-popover-header">
            <span className="context-popover-title">上下文窗口</span>
            <strong className="context-popover-pct num">{pillText}</strong>
          </div>

          <div className="context-popover-meter">
            {pct !== undefined && (
              <div
                className="context-popover-track"
                role="progressbar"
                aria-label="上下文占用比例"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(pct)}
              >
                {inputWidth > 0 && <span className="seg is-input" style={{ width: `${Math.max(1.2, inputWidth)}%` }} />}
                {cacheWidth > 0 && <span className="seg is-cache" style={{ width: `${Math.max(0.8, cacheWidth)}%` }} />}
                {outputWidth > 0 && <span className="seg is-output" style={{ width: `${Math.max(0.8, outputWidth)}%` }} />}
              </div>
            )}
            <div className="context-popover-total num">
              {formatContextTokens(usage.totalTokens)}
              {hasCapacity ? ` / ${formatContextTokens(usage.maxTokens!)} tokens` : " tokens"}
            </div>
          </div>

          <div className="context-popover-breakdown">
            <div className="context-popover-row">
              <span className="context-popover-key"><i className="dot is-input" aria-hidden="true" />输入提示</span>
              <span className="num">{formatContextTokens(breakdown.inputTokens)}</span>
            </div>
            <div className="context-popover-row">
              <span className="context-popover-key"><i className="dot is-cache" aria-hidden="true" />缓存命中</span>
              <span className="num">{formatContextTokens(breakdown.cacheTokens)}</span>
            </div>
            <div className="context-popover-row">
              <span className="context-popover-key"><i className="dot is-output" aria-hidden="true" />模型输出</span>
              <span className="num">{formatContextTokens(breakdown.outputTokens)}</span>
            </div>
          </div>

          {onCompact && (
            <button
              type="button"
              className="context-popover-compact"
              disabled={compactDisabled || compactBusy}
              onClick={onCompact}
            >
              <span className="context-popover-compact-main">
                {compactBusy ? <LoaderCircle className="is-spinning" size={13.5} /> : <Minimize2 size={13.5} />}
                <span>{compactBusy ? "正在压缩上下文…" : "压缩上下文 (/compact)"}</span>
              </span>
              <small>释放空间</small>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Quiet inline liveness indicator inside the floating composer footer:
 * single warm dot + concise activity label + elapsed seconds.
 */
export function SessionActivityIndicator({ activity }: { activity?: SessionActivity | undefined }) {
  if (!activity) return null;
  return (
    <div className={`session-activity ${activity.kind}`} role="status" aria-live="polite">
      <span className="session-activity-dot" aria-hidden="true" />
      <span className="session-activity-label">{activity.label}</span>
      {activity.since ? <Elapsed since={activity.since} /> : null}
    </div>
  );
}
