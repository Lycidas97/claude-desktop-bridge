import type { BridgeSubagentSummary } from "@bridge/protocol";
import { Check, ChevronDown, CircleStop, LoaderCircle, MoreHorizontal, X } from "lucide-react";
import type { ConversationItem } from "../../lib/conversation-timeline.js";
import { formatElapsed, subagentStalledSeconds } from "../../lib/session-activity.js";
import { MarkdownText } from "../common/MarkdownText.js";

const SUBAGENT_STATE_LABELS: Record<BridgeSubagentSummary["state"], string> = {
  running: "运行中",
  completed: "已完成",
  failed: "失败",
  stopped: "已停止",
  unknown: "状态未知",
};

export function SubagentCard({
  item,
  entering = false,
  stopping = false,
  stopBlockedReason,
  onStop,
  onFileClick,
}: {
  item: ConversationItem;
  entering?: boolean;
  stopping?: boolean;
  /** Shown instead of the stop button when only ending the whole process could stop it. */
  stopBlockedReason?: string;
  onStop?: () => void;
  onFileClick?: (filePath: string) => void;
}) {
  const subagent = item.subagent;
  if (!subagent) return null;
  const isRunning = subagent.state === "running";
  const isUnknown = subagent.state === "unknown";
  const stalledSeconds = isRunning ? subagentStalledSeconds(subagent.updatedAt) : undefined;
  const agentBadge = subagent.agentType && subagent.agentType !== "general-purpose"
    ? `Subagent · ${subagent.agentType}`
    : "Subagent";
  const durationLabel = subagent.durationMs && subagent.durationMs >= 1_000
    ? `${Math.round(subagent.durationMs / 1_000)}s`
    : undefined;
  const recentTools = subagent.recentTools ?? [];
  const hasDetails = Boolean(subagent.reportText || subagent.latestText || recentTools.length > 0);
  return (
    <article
      className={`conversation-subagent-card ${isRunning ? "is-running" : isUnknown ? "is-unknown" : `is-completed is-${subagent.state}`}${entering ? " is-entering" : ""}`}
      data-stream-key={item.id}
    >
      <div className="subagent-card-header">
        <div className="subagent-card-title-row">
          <span className={`subagent-status-badge ${isRunning ? "running" : isUnknown ? "unknown" : "completed"}`}>
            {isRunning
              ? <LoaderCircle className="is-spinning" size={13} />
              : isUnknown ? <MoreHorizontal size={13} /> : subagent.state === "completed" ? <Check size={13} /> : <X size={13} />}
            <span>{agentBadge}</span>
          </span>
          <strong className="subagent-description">{subagent.description}</strong>
        </div>
        <div className="subagent-card-meta">
          {subagent.toolCount > 0 && <span>{subagent.toolCount} 步</span>}
          {durationLabel && <span>{durationLabel}</span>}
          <span className={`subagent-state-label ${isRunning ? "running" : isUnknown ? "unknown" : "completed"}`}>
            {SUBAGENT_STATE_LABELS[subagent.state]}
          </span>
        </div>
        {subagent.model && <span className="subagent-card-model" aria-label={`模型：${subagent.model}`}>{subagent.model}</span>}
      </div>

      {isRunning && (subagent.latestText || recentTools.length > 0) && (
        <div className="subagent-live-progress">
          {subagent.latestText && (
            <div className="subagent-live-note">{subagent.latestText}</div>
          )}
          {recentTools.length > 0 && (
            <div className="subagent-recent-tools">
              {recentTools.slice(-3).map((toolLine, idx) => (
                <span className="subagent-tool-pill" key={`${idx}:${toolLine}`}>
                  {toolLine}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {isRunning && (stalledSeconds !== undefined || onStop || stopBlockedReason) && (
        <div className="subagent-card-controls">
          <span className="subagent-control-note">
            {stopBlockedReason
              ?? (stalledSeconds !== undefined ? `已有 ${formatElapsed(stalledSeconds)}没有新进展，可能已卡住` : "")}
          </span>
          {onStop && !stopBlockedReason && (
            <button type="button" className="secondary-button subagent-stop-button" disabled={stopping} onClick={onStop}>
              {stopping ? <LoaderCircle className="is-spinning" size={14} /> : <CircleStop size={14} />}
              {stopping ? "停止中" : "停止"}
            </button>
          )}
        </div>
      )}

      {hasDetails && (
        <details className="subagent-details">
          <summary>
            <span>
              {subagent.reportText
                ? "查看子代理结论与执行记录"
                : recentTools.length > 0
                  ? `查看已执行的 ${recentTools.length} 个步骤`
                  : "查看子代理进度"}
            </span>
            <ChevronDown size={14} className="subagent-details-chevron" aria-hidden="true" />
          </summary>
          <div className="subagent-details-body">
            {recentTools.length > 0 && (
              <div className="subagent-steps-section">
                <div className="subagent-section-label">最近执行步骤</div>
                <div className="subagent-recent-tools">
                  {recentTools.map((toolLine, idx) => (
                    <span className="subagent-tool-pill" key={`${idx}:${toolLine}`}>
                      {toolLine}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {(subagent.reportText || subagent.latestText) && (
              <div className="subagent-report-section">
                <div className="subagent-section-label">
                  {subagent.reportText ? "子代理回报" : "当前输出"}
                </div>
                <MarkdownText
                  text={subagent.reportText ?? subagent.latestText ?? ""}
                  {...(onFileClick ? { onFileClick } : {})}
                />
              </div>
            )}
          </div>
        </details>
      )}
    </article>
  );
}
