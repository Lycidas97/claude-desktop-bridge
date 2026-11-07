import type { BridgeSessionInfo, BridgeSubagentSummary, BridgeTurnState } from "@bridge/protocol";

export interface SessionActivityItem {
  role: string;
  state?: BridgeTurnState | string;
  createdAt: number;
  toolName?: string;
  subagent?: BridgeSubagentSummary;
}

export interface SessionActivity {
  kind: "queued" | "running" | "thinking" | "generating";
  label: string;
  /** Timestamp of the user message that started the current work, when known. */
  since?: number;
}

/**
 * Derives the composer-level liveness line for a session: the answer to
 * "is this task still alive, and what is it doing right now?" Returns
 * undefined when the session is idle (or only waiting on input) and the
 * indicator should disappear entirely.
 */
export function sessionQueueLabel(
  session: Pick<BridgeSessionInfo, "ownership" | "turnState" | "desktopHandoff">,
): string {
  if (session.desktopHandoff?.reason === "inbox-confirmation-expired") return "等待确认交接";
  if (session.desktopHandoff?.inputStatus === "held") return "等待电脑允许接收";
  if (session.desktopHandoff?.state === "close-desktop") return "等待关闭此 Desktop 会话";
  if (session.ownership === "OWNERSHIP_CONFLICT") return "等待写入冲突解除";
  if (session.ownership === "DESKTOP_OBSERVED" || session.ownership === "FALLBACK_CONFIRMATION_REQUIRED") return "等待电脑端空闲";
  if (session.turnState === "running" || session.turnState === "waiting") return "等待前一条消息完成";
  return "消息排队中";
}

export function sessionActivity(
  session: Pick<BridgeSessionInfo, "turnState" | "executionStage" | "desktopHandoff"> & Partial<Pick<BridgeSessionInfo, "ownership" | "pendingCount">> | undefined,
  items: readonly SessionActivityItem[],
): SessionActivity | undefined {
  if (!session) return undefined;
  const lastUser = [...items].reverse().find((item) => item.role === "user");
  const since = lastUser?.createdAt;
  if (session.turnState === "queued" || (session.pendingCount ?? 0) > 0) return {
    kind: "queued",
    label: session.ownership ? sessionQueueLabel({ ...session, ownership: session.ownership }) : "排队等待中",
  };
  const runningSubagents = items.filter(
    (item) => item.role === "tool" && item.subagent?.state === "running",
  );
  if (runningSubagents.length > 0) {
    const latest = runningSubagents[runningSubagents.length - 1]!.subagent!;
    const label = runningSubagents.length === 1
      ? `子代理运行中 · ${latest.description}${latest.toolCount ? ` (${latest.toolCount} 步)` : ""}`
      : `${runningSubagents.length} 个子代理运行中 · ${latest.description}`;
    return { kind: "running", label, ...(since ?? latest.startedAt ? { since: since ?? latest.startedAt } : {}) };
  }
  if (session.turnState !== "running") return undefined;
  if (session.executionStage === "starting") return { kind: "queued", label: "正在启动" };
  if (session.executionStage === "submitted") return { kind: "queued", label: "已提交，等待执行" };
  const last = items[items.length - 1];
  if (last?.role === "tool" && last.state === "running") {
    return { kind: "running", label: `正在运行 · ${last.toolName ?? "工具"}`, ...(since ? { since } : {}) };
  }
  if (last?.role === "assistant") {
    return { kind: "generating", label: "正在生成回复", ...(since ? { since } : {}) };
  }
  return { kind: "thinking", label: "思考中", ...(since ? { since } : {}) };
}

/** Past this a running subagent may be hung. This only informs the user; it never changes state. */
const SUBAGENT_STALL_MS = 10 * 60_000;

/** Seconds without new output, once that is long enough to mention. */
export function subagentStalledSeconds(lastUpdatedAt: number, now = Date.now()): number | undefined {
  return now - lastUpdatedAt > SUBAGENT_STALL_MS ? (now - lastUpdatedAt) / 1_000 : undefined;
}

export function backgroundSubagentBadge(
  session: Pick<BridgeSessionInfo, "runningSubagents">,
  now = Date.now(),
): { label: string; stalled: boolean } | undefined {
  if (!session.runningSubagents) return undefined;
  return subagentStalledSeconds(session.runningSubagents.lastUpdatedAt, now) === undefined
    ? { label: "后台子代理", stalled: false }
    : { label: "子代理无进展", stalled: true };
}

export function formatElapsed(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 ? `${minutes} 分 ${seconds % 60} 秒` : `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分`;
}
