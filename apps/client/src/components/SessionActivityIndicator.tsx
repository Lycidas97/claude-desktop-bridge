import type { BridgeSessionContextUsage } from "@bridge/protocol";
import { useEffect, useState } from "react";
import { formatElapsed, type SessionActivity } from "../lib/session-activity.js";

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  return <small className="session-activity-elapsed">已持续 {formatElapsed((now - since) / 1_000)}</small>;
}

export function formatContextTokens(value: number): string {
  if (value >= 999_500) {
    const millions = Math.round((value / 1_000_000) * 10) / 10;
    return Number.isInteger(millions) ? `${millions}M` : `${millions.toFixed(1)}M`;
  }
  if (value >= 10_000) return `${Math.round(value / 1_000)}K`;
  if (value >= 1_000) {
    const thousands = Math.round(value / 100) / 10;
    return Number.isInteger(thousands) ? `${thousands}K` : `${thousands.toFixed(1)}K`;
  }
  return String(Math.round(value));
}

export function formatContextPercentage(value: number): string {
  const clamped = Math.min(100, Math.max(0, value));
  if (clamped > 0 && clamped < 1) return "<1%";
  return `${Math.round(clamped)}%`;
}

export function SessionContextUsageBar({ usage }: { usage?: BridgeSessionContextUsage | undefined }) {
  if (!usage || !(usage.totalTokens > 0)) return null;
  const hasCapacity = typeof usage.maxTokens === "number" && usage.maxTokens > 0
    && typeof usage.percentage === "number" && Number.isFinite(usage.percentage);
  const pct = hasCapacity ? Math.min(100, Math.max(0, usage.percentage!)) : undefined;
  const tone = pct === undefined ? "" : pct >= 90 ? " is-critical" : pct >= 75 ? " is-high" : "";
  return (
    <div className={`session-context-bar${tone}`} aria-label="当前上下文用量">
      <span className="session-context-bar-label">上下文</span>
      {pct !== undefined && (
        <span
          className="session-context-bar-track"
          role="progressbar"
          aria-label="上下文占用比例"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(pct)}
        >
          <i style={{ width: `${Math.max(pct > 0 ? 3 : 0, pct)}%` }} />
        </span>
      )}
      <span className="session-context-bar-value">
        {formatContextTokens(usage.totalTokens)}
        {hasCapacity ? ` / ${formatContextTokens(usage.maxTokens!)} · ${formatContextPercentage(pct!)}` : ""}
      </span>
    </div>
  );
}

/**
 * Liveness line above the composer: pulsing dots plus what the task is
 * doing right now. Rendered only while the session is queued/running, so
 * its disappearance is itself the "task settled" signal.
 */
export function SessionActivityIndicator({ activity }: { activity?: SessionActivity | undefined }) {
  if (!activity) return null;
  return (
    <div className={`session-activity ${activity.kind}`} role="status" aria-live="polite">
      <span className="session-activity-dots" aria-hidden="true"><i /><i /><i /></span>
      <span className="session-activity-label">{activity.label}</span>
      {activity.since ? <Elapsed since={activity.since} /> : null}
    </div>
  );
}
