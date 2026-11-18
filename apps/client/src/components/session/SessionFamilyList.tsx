import type { BridgePermissionInfo, BridgeProjectInfo, BridgeSessionInfo } from "@bridge/protocol";
import { ChevronDown, ChevronRight, MoreHorizontal } from "lucide-react";
import type { ReactNode } from "react";
import { activeSessionBadgeLabel, forkGroupToggleLabel, relativeTime, visibleSessionForks } from "../../lib/conversation-timeline.js";
import type { SessionFamily } from "../../lib/project-groups.js";
import { backgroundSubagentBadge } from "../../lib/session-activity.js";
import { IconButton } from "../common/IconButton.js";
import "./session-section-drag.css";
import type { SessionSectionDragController } from "./useSessionSectionDrag.js";

type TreeConnectorVariant = "summary" | "branch" | "last" | "only";

function SessionTreeConnector({ variant }: { variant: TreeConnectorVariant }) {
  if (variant === "summary") {
    return (
      <span className="session-tree-connector is-inline" aria-hidden="true">
        <svg className="session-tree-elbow" width="12" height="15" viewBox="0 0 12 15" fill="none">
          <path
            d="M 1.5 2 V 8.5 A 5 5 0 0 0 6.5 13.5 H 11.5"
            stroke="currentColor"
            strokeWidth="1.25"
            strokeLinecap="butt"
          />
        </svg>
      </span>
    );
  }
  if (variant === "branch") {
    return (
      <span className="session-tree-connector is-branch" aria-hidden="true">
        <span className="session-tree-tick" />
      </span>
    );
  }
  return (
    <span className={`session-tree-connector is-last${variant === "only" ? " is-only" : ""}`} aria-hidden="true">
      <svg className="session-tree-elbow" width="12" height="6" viewBox="0 0 12 6" fill="none">
        <path
          d="M 1.5 0 A 5 5 0 0 0 6.5 5 H 11.5"
          stroke="currentColor"
          strokeWidth="1.25"
          strokeLinecap="butt"
        />
      </svg>
    </span>
  );
}

export interface SessionFamilyListProps {
  families: readonly SessionFamily<BridgeSessionInfo>[];
  projects: readonly BridgeProjectInfo[] | undefined;
  permissions: readonly BridgePermissionInfo[];
  expandedForkParents: ReadonlySet<string>;
  archivedList?: boolean;
  flat?: boolean;
  selectedId?: string | undefined;
  seenCompletions?: Readonly<Record<string, string>> | undefined;
  onSelectSession(sessionId: string): void | Promise<void>;
  onOpenSessionActions?: (sessionId: string) => void;
  actionLabel?: (session: BridgeSessionInfo) => string;
  onToggleForkGroup(parentSessionId: string): void;
  sessionDrag?: Pick<SessionSectionDragController, "dragState" | "canMoveToSection" | "onSessionPointerDown"> | undefined;
}

export function SessionFamilyList({
  families,
  projects,
  permissions,
  expandedForkParents,
  archivedList = false,
  flat = false,
  selectedId,
  seenCompletions,
  onSelectSession,
  onOpenSessionActions,
  actionLabel,
  onToggleForkGroup,
  sessionDrag,
}: SessionFamilyListProps) {
  function renderSessionFamily(
    { primary: session, forks }: SessionFamily<BridgeSessionInfo>,
    forkBranchVariant?: "branch" | "last" | "only",
  ): ReactNode {
    const isForkChild = Boolean(forkBranchVariant);
    const isArchivedRow = archivedList || Boolean(session.archivedAt);
    const pendingPermission = isArchivedRow ? undefined : permissions.find(permission => permission.sessionId === session.sessionId);
    const rawTurnBadge = isArchivedRow ? "已归档" : pendingPermission ? pendingPermission.toolName === "AskUserQuestion" ? "待回答" : "待授权" : activeSessionBadgeLabel(session);
    const suppressTurnPill = flat
      && !isArchivedRow
      && !pendingPermission
      && (session.turnState === "running" || session.turnState === "queued")
      && !session.executionStage
      && !session.isCompacting;
    const turnBadge = suppressTurnPill ? undefined : rawTurnBadge;
    const subagentBadge = isArchivedRow || rawTurnBadge ? undefined : backgroundSubagentBadge(session);
    const badge = turnBadge ?? subagentBadge?.label;
    const unreadCompletion = flat && !isArchivedRow && !rawTurnBadge && !subagentBadge
      && session.turnState === "idle" && session.pendingCount === 0
      && Boolean(session.lastCompletedTurnId && seenCompletions?.[session.sessionId] !== session.lastCompletedTurnId);
    const statusTone = pendingPermission ? "waiting" : subagentBadge ? (subagentBadge.stalled ? "queued" : "running")
      : unreadCompletion ? "completed" : session.turnState;
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
    const visibleForks = visibleSessionForks(forks, isArchivedRow);
    const hasForks = visibleForks.length > 0;
    const showRightDot = flat && !isArchivedRow && statusTone !== "idle";
    const hasBadges = Boolean(showRightDot || badge || (!isArchivedRow && session.pendingCount > 0));
    const toggleSummary = hasForks ? forkGroupToggleLabel(visibleForks) : "";

    const badgesNode = hasBadges ? (
      <span className="session-row-badges">
        {showRightDot && <span className={`session-state-dot ${statusTone}`} />}
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
    ) : null;

    const canDragRow = Boolean(!isArchivedRow && sessionDrag?.canMoveToSection(session));
    const isDraggingSource = Boolean(
      sessionDrag?.dragState?.session.sessionId === session.sessionId,
    );

    return (
      <div className="mobile-session-family" key={session.sessionId}>
        <div
          className={`session-row-v2 session-tree-item ${isForkChild ? "is-fork-child" : ""}${hasForks ? " has-forks" : ""}${session.sessionId === selectedId ? " active" : ""}${canDragRow ? " is-draggable" : ""}${isDraggingSource ? " is-dragging-source" : ""}`}
          data-session-id={session.sessionId}
          {...(canDragRow && sessionDrag ? {
            onPointerDown: (event) => sessionDrag.onSessionPointerDown(session, event),
          } : {})}
        >
          {forkBranchVariant && <SessionTreeConnector variant={forkBranchVariant} />}
          <button
            type="button"
            className="session-row-hit"
            onClick={() => void onSelectSession(session.sessionId)}
          >
            {!showRightDot && <span className={`session-state-dot ${statusTone}`} />}
            <span className="session-row-copy">
              {flat ? (
                <strong>
                  {session.title}
                  {(isForkChild || session.parentSessionId) && (
                    <em className={`${badgeClassName} is-sr-only`}>{badgeLabel}</em>
                  )}
                </strong>
              ) : (
                <strong>
                  {isForkChild && <em className={badgeClassName}>{badgeLabel}</em>}
                  {session.title}
                  {!isForkChild && session.parentSessionId && (
                    <em className={badgeClassName}>{badgeLabel}</em>
                  )}
                </strong>
              )}
              <small>
                {subfolderLabel ? `${subfolderLabel} · ` : ""}
                {relativeTime(session.lastActivityAt)}
                {!isArchivedRow && session.currentSummary ? ` · ${session.currentSummary}` : ""}
              </small>
            </span>
            {unreadCompletion && <span className="session-fork-badge is-sr-only">已完成，未查看</span>}
            {hasForks && badge && <span className="session-fork-badge is-sr-only">{badge}</span>}
            {!hasForks && badgesNode}
          </button>
          {hasForks && (
            <button
              type="button"
              className="session-family-chevron"
              data-no-session-drag="true"
              aria-expanded={forksExpanded}
              aria-label={`${forksExpanded ? "收起" : "展开"}「${session.title}」的${toggleSummary}`}
              onClick={() => onToggleForkGroup(session.sessionId)}
            >
              {forksExpanded ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
            </button>
          )}
          {hasForks && badgesNode}
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
        {hasForks && (
          <div className={`mobile-fork-group ${forksExpanded ? "expanded" : "collapsed"}`}>
            {!forksExpanded ? (
              <button
                type="button"
                className="mobile-fork-toggle"
                aria-expanded={false}
                onClick={() => onToggleForkGroup(session.sessionId)}
              >
                <SessionTreeConnector variant="summary" />
                <span>{toggleSummary}</span>
              </button>
            ) : (
              <div className="mobile-fork-children">
                {visibleForks.map((fork, index) => {
                  const isLast = index === visibleForks.length - 1;
                  const childVariant = visibleForks.length === 1 ? "only" : isLast ? "last" : "branch";
                  return (
                    <div
                      className={`session-fork-branch${isLast ? " is-last" : ""}${visibleForks.length === 1 ? " is-only" : ""}`}
                      key={fork.primary.sessionId}
                    >
                      {renderSessionFamily(fork, childVariant)}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  return <>{families.map(family => renderSessionFamily(family))}</>;
}
