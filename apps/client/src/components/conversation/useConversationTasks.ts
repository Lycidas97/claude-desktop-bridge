import type { BridgeBackgroundTask, BridgeSessionInfo } from "@bridge/protocol";
import { useEffect, useMemo, useState } from "react";
import { isQueuedConversationMessage, stoppableBridgeTask, type ConversationItem } from "../../lib/conversation-timeline.js";
import { sessionActivity } from "../../lib/session-activity.js";
import { findBackgroundTask } from "./BackgroundTasks.js";

export function useConversationTasks({ draftKey, session, sessions, items, showQueueActivity, pollEnabled, onLoadBackgroundTasks, onInterruptTurn, onStopSubagent }: {
  draftKey: string;
  session: BridgeSessionInfo;
  sessions: BridgeSessionInfo[];
  items: ConversationItem[];
  showQueueActivity: boolean;
  pollEnabled: boolean;
  onLoadBackgroundTasks?: ((sessionId: string) => Promise<BridgeBackgroundTask[]>) | undefined;
  onInterruptTurn(sessionId: string): Promise<void>;
  onStopSubagent?: ((sessionId: string, agentId: string) => Promise<void>) | undefined;
}) {
  const [stoppingSessionId, setStoppingSessionId] = useState<string>();
  const [stopError, setStopError] = useState<string>();
  const [stopConfirmOpen, setStopConfirmOpen] = useState(false);
  const [stopSubagentTarget, setStopSubagentTarget] = useState<{
    sessionId: string;
    agentId: string;
    description: string;
    scope: "task" | "process";
  }>();
  const [subagentStopBusy, setSubagentStopBusy] = useState(false);
  const [backgroundTasksOpen, setBackgroundTasksOpen] = useState<{ focus?: ConversationItem }>();
  const [backgroundTaskDetails, setBackgroundTaskDetails] = useState<{
    key: string;
    tasks: BridgeBackgroundTask[] | undefined;
    error?: string;
  }>();

  useEffect(() => {
    if (!onLoadBackgroundTasks || !pollEnabled) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const tasks = await onLoadBackgroundTasks(session.sessionId);
        if (active) setBackgroundTaskDetails({ key: draftKey, tasks });
      } catch (error) {
        if (active) {
          setBackgroundTaskDetails((current) => ({
            key: draftKey,
            tasks: current && current.key === draftKey ? current.tasks : undefined,
            error: error instanceof Error ? error.message : String(error),
          }));
        }
      }
      if (active) timer = setTimeout(() => void refresh(), 2_000);
    };
    void refresh();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [
    draftKey,
    onLoadBackgroundTasks,
    session.sessionId,
    pollEnabled,
  ]);

  const selectedTaskDetails = backgroundTaskDetails?.key === draftKey ? backgroundTaskDetails : undefined;
  const activityTasks = selectedTaskDetails?.tasks ?? session.backgroundTasks;
  const activity = useMemo(() => {
    const activityItems = items.filter(item => item.role !== "user"
      || (item.delivery !== "queued" && !isQueuedConversationMessage(item, session)));
    return sessionActivity(
      session,
      selectedTaskDetails?.error ? activityItems.map((item) => {
        const subagent = item.subagent;
        if (subagent?.state !== "running") return item;
        const task = findBackgroundTask(activityTasks, subagent);
        return task && task.state !== "running"
          && (!subagent.workflowRunId || task.workflow?.agents.some((agent) => agent.agentId === subagent.agentId))
          ? { ...item, subagent: { ...subagent, state: task.state } }
          : item;
      }) : activityItems,
      selectedTaskDetails?.error ? undefined : activityTasks,
      showQueueActivity,
    );
  }, [activityTasks, items, selectedTaskDetails?.error, session, showQueueActivity]);

  const backgroundTasks = activityTasks ?? [];
  const runningBackgroundTasks = backgroundTasks.filter((task) => task.state === "running").length;

  async function stopTask(targetSessionId: string): Promise<void> {
    if (stoppingSessionId) return;
    setStoppingSessionId(targetSessionId);
    setStopError(undefined);
    try {
      await onInterruptTurn(targetSessionId);
    } catch (error) {
      setStopError(error instanceof Error ? error.message : "任务停止失败");
    } finally {
      setStoppingSessionId(undefined);
    }
  }

  async function stopSubagent(): Promise<void> {
    if (!stopSubagentTarget || subagentStopBusy) return;
    setSubagentStopBusy(true);
    setStopError(undefined);
    try {
      await onStopSubagent?.(stopSubagentTarget.sessionId, stopSubagentTarget.agentId);
    } catch (error) {
      setStopError(error instanceof Error ? error.message : "子代理停止失败");
    } finally {
      setSubagentStopBusy(false);
      setStopSubagentTarget(undefined);
    }
  }

  const selectedBusy = session.pendingCount > 0
    || session.turnState === "running"
    || session.turnState === "queued"
    || session.turnState === "waiting";
  const stopTarget = selectedBusy ? stoppableBridgeTask(sessions, session.sessionId) : undefined;
  const stopping = Boolean(stopTarget && stoppingSessionId === stopTarget.sessionId);
  return {
    backgroundTasks,
    runningBackgroundTasks,
    loadError: selectedTaskDetails?.error,
    activity,
    backgroundTasksOpen,
    setBackgroundTasksOpen,
    stopSubagentTarget,
    setStopSubagentTarget,
    subagentStopBusy,
    stopSubagent,
    stopConfirmOpen,
    setStopConfirmOpen,
    stopError,
    stopTask,
    stopTarget,
    stopping,
    resetSelection() {
      setBackgroundTasksOpen(undefined);
      setStopSubagentTarget(undefined);
      setStopError(undefined);
      setStopConfirmOpen(false);
    },
  };
}
