import type { BridgePermissionInfo, BridgeProjectInfo, BridgeSessionInfo } from "@bridge/protocol";
import { ChevronDown, ChevronRight, GitFork, MoreHorizontal } from "lucide-react";
import type { ReactNode } from "react";
import { activeSessionBadgeLabel, forkGroupToggleLabel, relativeTime, visibleSessionForks } from "../../lib/conversation-timeline.js";
import type { SessionFamily } from "../../lib/project-groups.js";
import { backgroundSubagentBadge } from "../../lib/session-activity.js";
import { IconButton } from "../common/IconButton.js";

export interface SessionFamilyListProps {
  families: readonly SessionFamily<BridgeSessionInfo>[];
  projects: readonly BridgeProjectInfo[] | undefined;
  permissions: readonly BridgePermissionInfo[];
  expandedForkParents: ReadonlySet<string>;
  archivedList?: boolean;
  includeArchivedInline?: boolean;
  flat?: boolean;
  selectedId?: string | undefined;
  onSelectSession(sessionId: string): void | Promise<void>;
  onOpenSessionActions?: (sessionId: string) => void;
  actionLabel?: (session: BridgeSessionInfo) => string;
  onToggleForkGroup(parentSessionId: string): void;
}

export function SessionFamilyList({
  families,
  projects,
  permissions,
  expandedForkParents,
  archivedList = false,
  includeArchivedInline = false,
  flat = false,
  selectedId,
  onSelectSession,
  onOpenSessionActions,
  actionLabel,
  onToggleForkGroup,
}: SessionFamilyListProps) {
  function renderSessionFamily({ primary: session, forks }: SessionFamily<BridgeSessionInfo>, isForkChild = false): ReactNode {
    const isArchivedRow = archivedList || Boolean(session.archivedAt);
    const pendingPermission = isArchivedRow ? undefined : permissions.find(permission => permission.sessionId === session.sessionId);
    const rawTurnBadge = isArchivedRow ? "已归档" : pendingPermission ? pendingPermission.toolName === "AskUserQuestion" ? "待回答" : "待授权" : activeSessionBadgeLabel(session);
    const suppressTurnPill = flat
      && !isArchivedRow
      && !pendingPermission
      && (session.turnState === "running" || session.turnState === "queued")
      && !session.isCompacting;
    const turnBadge = suppressTurnPill ? undefined : rawTurnBadge;
    const subagentBadge = isArchivedRow || rawTurnBadge ? undefined : backgroundSubagentBadge(session);
    const badge = turnBadge ?? subagentBadge?.label;
    const statusTone = pendingPermission ? "waiting" : subagentBadge ? (subagentBadge.stalled ? "queued" : "running") : session.turnState;
    const forksExpanded = expandedForkParents.has(session.sessionId);
    const badgeLabel = session.sidechat ? "/btw" : (session.forkLabel || "fork");
    const badgeClassName = `session-fork-badge${session.sidechat ? " is-sidechat" : ""}`;
    const sessionProject = !isArchivedRow
      ? projects?.find(candidate => candidate.projectId === session.projectId)
      : undefined;
    const sessionFolder = session.cwd.replace(/[\\/]+$/u, "").split(/[\\/]/u).at(-1) || "";
    const subfolderLabel = sessionProject?.kind === "desktop-group" && sessionFolder && sessionFolder !== sessionProject.name
      ? sessionFolder
      : "";
    const visibleForks = visibleSessionForks(forks, includeArchivedInline || isArchivedRow);
    return (
      <div className="mobile-session-family" key={session.sessionId}>
        <div className={`session-row-v2 ${isForkChild ? "is-fork-child" : ""}${session.sessionId === selectedId ? " active" : ""}`} data-session-id={session.sessionId}>
          <button
            type="button"
            className="session-row-hit"
            onClick={() => void onSelectSession(session.sessionId)}
          >
            <span className={`session-state-dot ${statusTone}`} />
            <span className="session-row-copy">
              <strong>
                {isForkChild && <em className={badgeClassName}>{badgeLabel}</em>}
                {session.title}
                {!isForkChild && session.parentSessionId && (
                  <em className={badgeClassName}>{badgeLabel}</em>
                )}
              </strong>
              <small>
                {subfolderLabel ? `${subfolderLabel} · ` : ""}
                {relativeTime(session.lastActivityAt)}
                {!isArchivedRow && session.currentSummary ? ` · ${session.currentSummary}` : ""}
              </small>
            </span>
            <span className="session-row-badges">
              {badge && (
                <span className={`session-row-status ${statusTone}`}>
                  {badge}
                </span>
              )}
              {!isArchivedRow && session.pendingCount > 0 && (
                <span className="session-row-status queued" aria-label={`${session.pendingCount} 条排队消息`}>
                  {session.pendingCount}
                </span>
              )}
            </span>
          </button>
          {onOpenSessionActions && (
            <IconButton
              label={actionLabel ? actionLabel(session) : "会话操作"}
              className="session-row-action"
              onClick={() => onOpenSessionActions(session.sessionId)}
            >
              <MoreHorizontal size={18} />
            </IconButton>
          )}
        </div>
        {visibleForks.length > 0 && (
          <div className={`mobile-fork-group ${forksExpanded ? "expanded" : "collapsed"}`}>
            <button
              type="button"
              className="mobile-fork-toggle"
              aria-expanded={forksExpanded}
              onClick={() => onToggleForkGroup(session.sessionId)}
            >
              <GitFork size={12} />
              <span>{forkGroupToggleLabel(visibleForks)}</span>
              {forksExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            </button>
            {forksExpanded && (
              <div className="mobile-fork-children">
                {visibleForks.map(fork => renderSessionFamily(fork, true))}
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  return <>{families.map(family => renderSessionFamily(family))}</>;
}
