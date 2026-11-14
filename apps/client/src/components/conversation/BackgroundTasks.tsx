import type { BridgeBackgroundTask, BridgeHistoryItem, BridgeSubagentSummary, BridgeToolCallDetail } from "@bridge/protocol";
import { Bot, Check, ChevronRight, LoaderCircle, MoreHorizontal, Terminal, Workflow, X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useMediaRequest } from "../evidence/MediaPreviewProvider.js";
import { MobileSheet } from "../mobile/MobileSheet.js";
import "./ToolCallDetailSheet.css";

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

function BashTaskDetail({
  sessionId,
  task,
  subagent,
  items,
  supportsToolDetail,
  showStatus = false,
}: {
  sessionId: string;
  task?: BridgeBackgroundTask;
  subagent?: BridgeSubagentSummary;
  items: readonly BridgeHistoryItem[];
  supportsToolDetail: boolean;
  showStatus?: boolean;
}) {
  const request = useMediaRequest();
  const requestRef = useRef(request);
  requestRef.current = request;
  const hasRequest = Boolean(request);
  const toolUseId = task?.toolUseId ?? subagent?.toolUseId;
  const history = task
    ? items.find(entry => entry.subagent && findBackgroundTask([task], entry.subagent))?.subagent ?? subagent
    : subagent;
  const state = task?.state ?? history?.state ?? "unknown";
  const summary = items.find(entry => entry.toolName === "Bash" && toolUseId
    && (entry.id === toolUseId || entry.id === `tool:${toolUseId}`))?.text;
  const output = history?.reportText ?? history?.latestText;
  const [result, setResult] = useState<{ detail?: BridgeToolCallDetail; error?: string }>({});

  useEffect(() => {
    if (!supportsToolDetail || !toolUseId || !hasRequest) return;
    void requestRef.current!("session.tool.detail", { sessionId, toolUseId }, { wait: true, timeoutMs: 30_000 })
      .then(response => {
        if (!response?.ok) throw new Error(response?.error?.message ?? "命令详情加载失败");
        const detail = (response.result as { detail?: BridgeToolCallDetail } | undefined)?.detail;
        setResult(detail ? { detail } : { error: "命令详情不可用" });
      })
      .catch((error: unknown) => setResult({ error: error instanceof Error ? error.message : "命令详情加载失败" }));
  }, [hasRequest, sessionId, supportsToolDetail, toolUseId]);

  return (
    <div className="tool-detail-body">
      {showStatus && (
        <div className="tool-detail-section-label" role="status">
          <StateGlyph state={state} />
          {STATE_LABELS[state]}
        </div>
      )}
      <section className="tool-detail-section" aria-label="命令">
        <span className="tool-detail-section-label">
          {result.detail ? (result.detail.inputTruncated ? "入参（已截断）" : "命令") : "命令摘要"}
        </span>
        {result.detail ? (
          <pre className="tool-detail-code"><code>{result.detail.inputTruncated
            ? result.detail.inputText
            : String(result.detail.input.command ?? JSON.stringify(result.detail.input, null, 2))}</code></pre>
        ) : summary ? (
          <pre className="tool-detail-code"><code>{summary}</code></pre>
        ) : (
          <div className="tool-detail-empty">{supportsToolDetail && toolUseId && hasRequest && !result.error ? "正在加载命令…" : "暂无命令详情"}</div>
        )}
        {result.error && <div className="tool-detail-fetch-error" role="alert">{result.error}</div>}
      </section>
      <section className="tool-detail-section" aria-label="任务输出">
        <span className="tool-detail-section-label">任务输出</span>
        {output ? <pre className="tool-detail-code"><code>{output}</code></pre> : <div className="tool-detail-empty">暂无任务输出</div>}
      </section>
      {result.detail?.outputText && result.detail.outputText !== output && (
        <section className="tool-detail-section" aria-label="启动结果">
          <span className="tool-detail-section-label">启动结果{result.detail.truncated ? "（已截断）" : ""}</span>
          <pre className="tool-detail-code"><code>{result.detail.outputText}</code></pre>
        </section>
      )}
    </div>
  );
}

/** The session's background tasks, grouped by kind from the header or focused on a single stream marker. */
export function BackgroundTasksSheet({
  sessionId,
  tasks,
  items,
  focus,
  supportsToolDetail = false,
  renderSubagent,
  onClose,
}: {
  sessionId: string;
  supportsToolDetail?: boolean;
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
  if (streamFocus?.subagent) {
    const focusSubagent = streamFocus.subagent;
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
          <BashTaskDetail
            key={`${sessionId}:${focusTask?.id ?? streamFocus.id}`}
            sessionId={sessionId}
            {...(focusTask ? { task: focusTask } : {})}
            subagent={focusSubagent}
            showStatus
            items={items}
            supportsToolDetail={supportsToolDetail}
          />
        ) : (
          renderSubagent(
            focusTask?.subagent
              ? subagentItem(sessionId, focusTask.subagent, items.includes(streamFocus) ? items : [...items, streamFocus])
              : streamFocus,
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
            const open = openId === task.id;
            const done = task.workflow?.agents.filter((agent) => agent.state === "completed").length;
            return (
              <div className={`background-task-entry${open ? " is-open" : ""}`} key={task.id}>
                <button
                  type="button"
                  className="background-task-row"
                  aria-expanded={open}
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
                {open && task.kind === "bash" && (
                  <BashTaskDetail
                    key={`${sessionId}:${task.id}`}
                    sessionId={sessionId}
                    task={task}
                    items={items}
                    supportsToolDetail={supportsToolDetail}
                  />
                )}
                {open && task.kind !== "bash" && task.subagent && renderSubagent(subagentItem(sessionId, task.subagent, items))}
              </div>
            );
          })}
        </section>
      ))}
    </MobileSheet>
  );
}
