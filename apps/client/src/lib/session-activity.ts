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
export function sessionActivity(
  session: Pick<BridgeSessionInfo, "turnState"> | undefined,
  items: readonly SessionActivityItem[],
): SessionActivity | undefined {
  if (!session) return undefined;
  const lastUser = [...items].reverse().find((item) => item.role === "user");
  const since = lastUser?.createdAt;
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
  if (session.turnState === "queued") return { kind: "queued", label: "排队等待中" };
  if (session.turnState !== "running") return undefined;
  const last = items[items.length - 1];
  if (last?.role === "tool" && last.state === "running") {
    return { kind: "running", label: `正在运行 · ${last.toolName ?? "工具"}`, ...(since ? { since } : {}) };
  }
  if (last?.role === "assistant") {
    return { kind: "generating", label: "正在生成回复", ...(since ? { since } : {}) };
  }
  return { kind: "thinking", label: "思考中", ...(since ? { since } : {}) };
}

export function formatElapsed(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 ? `${minutes} 分 ${seconds % 60} 秒` : `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分`;
}
