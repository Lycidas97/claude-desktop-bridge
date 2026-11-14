import type { BridgeBackgroundTask, BridgeHistoryItem, BridgeSubagentSummary } from "@bridge/protocol";
import { Bot, Check, ChevronRight, LoaderCircle, MoreHorizontal, Terminal, Workflow, X } from "lucide-react";
import { type ReactNode, useState } from "react";
import { MobileSheet } from "../mobile/MobileSheet.js";

type TaskState = BridgeSubagentSummary["state"];

const KIND_ICONS = {
  subagent: Bot,
  workflow: Workflow,
  bash: Terminal,
} as const;

const KIND_TITLES: Record<BridgeBackgroundTask["kind"], string> = {
  workflow: "工作流",
  subagent: "子代理",
  bash: "后台命令",
};

const STATE_LABELS: Record<TaskState, string> = {
  running: "运行中",
  completed: "已完成",
  failed: "失败",
  stopped: "已停止",
  unknown: "状态未知",
};

function StateGlyph({ state }: { state: TaskState }) {
  return (
    <span className={`background-task-state is-${state}`} role="img" aria-label={STATE_LABELS[state]}>
      {state === "running" ? <LoaderCircle className="is-spinning" size={14} />
        : state === "completed" ? <Check size={14} />
          : state === "unknown" ? <MoreHorizontal size={14} /> : <X size={14} />}
    </span>
  );
}

/** Kind of a stream subagent item: host tasks carry it, workflow members carry their run. */
function itemKind(subagent: BridgeSubagentSummary): BridgeBackgroundTask["kind"] {
  return subagent.workflowRunId ? "workflow" : subagent.taskKind ?? "subagent";
}

/** The tray entry a stream item stands for: its workflow run, else its tool use or task id. */
export function findBackgroundTask(
  tasks: readonly BridgeBackgroundTask[] | undefined,
  subagent: BridgeSubagentSummary,
): BridgeBackgroundTask | undefined {
  if (!tasks) return undefined;
  if (subagent.workflowRunId) return tasks.find((task) => task.workflow?.runId === subagent.workflowRunId);
  return (subagent.toolUseId ? tasks.find((task) => task.toolUseId === subagent.toolUseId) : undefined)
    ?? tasks.find((task) => task.taskId === subagent.agentId && !(task.toolUseId && subagent.toolUseId));
}

function sameSubagentInvocation(left: BridgeSubagentSummary, right: BridgeSubagentSummary): boolean {
  return left.toolUseId && right.toolUseId
    ? left.toolUseId === right.toolUseId
    : left.agentId === right.agentId;
}

function latestSubagentModel(stream: BridgeSubagentSummary, tray?: BridgeSubagentSummary): string | undefined {
  return tray && tray.updatedAt >= stream.updatedAt
    ? tray.model ?? stream.model
    : stream.model ?? tray?.model;
}

/** One line in the conversation for an Agent, Workflow run or background command. */
export function BackgroundTaskMarker({
  item,
  task,
  entering = false,
  onOpen,
}: {
  item: BridgeHistoryItem;
  task?: BridgeBackgroundTask;
  entering?: boolean;
  onOpen(): void;
}) {
  const subagent = item.subagent!;
  const kind = task?.kind ?? itemKind(subagent);
  const Icon = KIND_ICONS[kind];
  const description = kind === "workflow" && subagent.workflowRunId
    ? task?.workflow?.name ?? task?.description ?? KIND_TITLES.workflow
    : task?.description ?? subagent.description;
  const state = task?.state ?? subagent.state;
  const model = kind === "subagent" ? latestSubagentModel(subagent, task?.subagent) : undefined;
  return (
    <button
      type="button"
      className={`background-task-marker is-${state}${entering ? " is-entering" : ""}`}
      data-stream-key={item.id}
      aria-label={`${KIND_TITLES[kind]}：${description}，${STATE_LABELS[state]}${model ? `，模型：${model}` : ""}`}
      onClick={onOpen}
    >
      <Icon size={15} aria-hidden="true" />
      <span className="background-task-marker-text">{description}</span>
      {model && <small className="subagent-model" title={model}>{model}</small>}
      <StateGlyph state={state} />
      <ChevronRight size={15} className="background-task-marker-chevron" aria-hidden="true" />
    </button>
  );
}

function subagentItem(sessionId: string, subagent: BridgeSubagentSummary, items: readonly BridgeHistoryItem[]): BridgeHistoryItem {
  // The stream's item has the full report; the tray copy is compact.
  const streamItem = items.find((item) => item.subagent && sameSubagentInvocation(item.subagent, subagent));
  const model = latestSubagentModel(streamItem?.subagent ?? subagent, subagent);
  if (!streamItem?.subagent) {
    return {
      id: subagent.toolUseId ?? `subagent:${subagent.agentId}`,
      sessionId, role: "tool", toolName: "Agent", text: subagent.description,
      createdAt: subagent.startedAt, origin: "claude-desktop", subagent,
    };
  }
  const merged = subagent.updatedAt > streamItem.subagent.updatedAt
    ? { ...streamItem.subagent, ...subagent, ...(streamItem.subagent.reportText ? { reportText: streamItem.subagent.reportText } : {}) }
    : { ...subagent, ...streamItem.subagent };
  return { ...streamItem, subagent: {
    ...merged,
    toolCount: Math.max(streamItem.subagent.toolCount, subagent.toolCount),
    ...(streamItem.subagent.latestText ? { latestText: streamItem.subagent.latestText } : {}),
    ...(model ? { model } : {}),
    state: subagent.state,
  } };
}

function WorkflowTimeline({
  task,
  sessionId,
  items,
  renderSubagent,
}: {
  task: BridgeBackgroundTask;
  sessionId: string;
  items: readonly BridgeHistoryItem[];
  renderSubagent(item: BridgeHistoryItem): ReactNode;
}) {
  const [openAgentId, setOpenAgentId] = useState<string>();
  const workflow = task.workflow;
  if (!workflow) return null;
  const phases = workflow.agents.some((agent) => !agent.workflowPhase) ? [...workflow.phases, ""] : workflow.phases;
  return (
    <ol className="workflow-timeline">
      {phases.map((phase) => {
        const agents = workflow.agents.filter((agent) => (agent.workflowPhase ?? "") === phase);
        const done = agents.filter((agent) => agent.state === "completed").length;
        const state = agents.length === 0 ? "pending"
          : agents.some((agent) => agent.state === "running") ? "running"
            : agents.find((agent) => agent.state !== "completed")?.state ?? "completed";
        return (
          <li className={`workflow-phase is-${state}`} key={phase || "__unphased"}>
            <div className="workflow-phase-header">
              <i className="workflow-phase-dot" aria-hidden="true" />
              <strong>{phase || "其他"}</strong>
              {agents.length > 0 && <small>{done}/{agents.length}</small>}
            </div>
            {agents.length > 0 && (
              <ul className="workflow-phase-agents">
                {agents.map((agent) => (
                  <li key={agent.agentId}>
                    <button
                      type="button"
                      className="background-task-row is-nested"
                      aria-expanded={openAgentId === agent.agentId}
                      onClick={() => setOpenAgentId(openAgentId === agent.agentId ? undefined : agent.agentId)}
                    >
                      <StateGlyph state={agent.state} />
                      <span className="background-task-row-text">{agent.description}</span>
                      {agent.model && <small className="subagent-model" title={agent.model}>{agent.model}</small>}
                      {agent.toolCount > 0 && <small>{agent.toolCount} 步</small>}
                    </button>
                    {openAgentId === agent.agentId && renderSubagent(subagentItem(sessionId, agent, items))}
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** The session's background tasks, grouped by kind from the header or focused on a single stream marker. */
export function BackgroundTasksSheet({
  sessionId,
  tasks,
  items,
  focus,
  renderSubagent,
  onClose,
}: {
  sessionId: string;
  tasks: readonly BridgeBackgroundTask[];
  /** Loaded conversation items, used for full subagent reports. */
  items: readonly BridgeHistoryItem[];
  /** Stream item the sheet was opened from. */
  focus?: BridgeHistoryItem;
  renderSubagent(item: BridgeHistoryItem): ReactNode;
  onClose(): void;
}) {
  const [focused, setFocused] = useState(focus);
  const [openId, setOpenId] = useState<string>();
  const streamFocus = focused?.subagent
    ? items.find((entry) => entry.id === focused.id)
      ?? items.find((entry) => entry.subagent && sameSubagentInvocation(entry.subagent, focused.subagent!))
      ?? focused
    : undefined;
  if (streamFocus?.subagent && focused?.subagent) {
    const model = latestSubagentModel(focused.subagent, streamFocus.subagent);
    const focusSubagent = {
      ...focused.subagent,
      ...streamFocus.subagent,
      toolCount: Math.max(focused.subagent.toolCount, streamFocus.subagent.toolCount),
      ...(model ? { model } : {}),
    };
    const focusItem = { ...streamFocus, subagent: focusSubagent };
    const focusTask = findBackgroundTask(tasks, focusSubagent);
    const kind = focusTask?.kind ?? itemKind(focusSubagent);
    const title = kind === "workflow" && focusSubagent.workflowRunId
      ? focusTask?.workflow?.name ?? focusTask?.description ?? KIND_TITLES.workflow
      : focusTask?.description ?? focusSubagent.description;
    return (
      <MobileSheet
        eyebrow={KIND_TITLES[kind]}
        title={title}
        onClose={onClose}
        {...(tasks.length > 0 ? {
          footer: (
            <button type="button" className="secondary-button" onClick={() => setFocused(undefined)}>
              全部后台任务
            </button>
          ),
        } : {})}
      >
        {kind === "workflow" && focusTask?.workflow ? (
          <>
            <div className="background-task-state" role="status">
              <StateGlyph state={focusTask.state} />
              {STATE_LABELS[focusTask.state]}
            </div>
            <WorkflowTimeline task={focusTask} sessionId={sessionId} items={items} renderSubagent={renderSubagent} />
          </>
        ) : kind === "bash" ? (
          <div className="background-task-entry">
            <button type="button" className="background-task-row" disabled>
              <Terminal size={16} aria-hidden="true" />
              <span className="background-task-row-text">{title}</span>
              <StateGlyph state={focusTask?.state ?? focusSubagent.state} />
            </button>
          </div>
        ) : (
          renderSubagent(
            focusTask?.subagent
              ? subagentItem(sessionId, focusTask.subagent, [focusItem])
              : focusItem,
          )
        )}
      </MobileSheet>
    );
  }
  const groups = (["workflow", "subagent", "bash"] as const)
    .map((kind) => ({ kind, tasks: tasks.filter((task) => task.kind === kind) }))
    .filter((group) => group.tasks.length > 0);
  return (
    <MobileSheet title="后台任务" onClose={onClose}>
      {groups.map((group) => (
        <section className="background-task-group" key={group.kind} aria-label={KIND_TITLES[group.kind]}>
          <h3>{KIND_TITLES[group.kind]}</h3>
          {group.tasks.map((task) => {
            const Icon = KIND_ICONS[task.kind];
            const expandable = task.kind !== "bash";
            const open = expandable && openId === task.id;
            const done = task.workflow?.agents.filter((agent) => agent.state === "completed").length;
            return (
              <div className={`background-task-entry${open ? " is-open" : ""}`} key={task.id}>
                <button
                  type="button"
                  className="background-task-row"
                  disabled={!expandable}
                  {...(expandable ? { "aria-expanded": open } : {})}
                  onClick={() => setOpenId(open ? undefined : task.id)}
                >
                  <Icon size={16} aria-hidden="true" />
                  <span className="background-task-row-text">{task.workflow?.name ?? task.description}</span>
                  {task.workflow && <small>{done}/{task.workflow.agents.length}</small>}
                  {task.subagent?.model && <small className="subagent-model" title={task.subagent.model}>{task.subagent.model}</small>}
                  {task.subagent && task.subagent.toolCount > 0 && <small>{task.subagent.toolCount} 步</small>}
                  <StateGlyph state={task.state} />
                </button>
                {open && task.workflow && (
                  <WorkflowTimeline task={task} sessionId={sessionId} items={items} renderSubagent={renderSubagent} />
                )}
                {open && task.subagent && renderSubagent(subagentItem(sessionId, task.subagent, items))}
              </div>
            );
          })}
        </section>
      ))}
    </MobileSheet>
  );
}
