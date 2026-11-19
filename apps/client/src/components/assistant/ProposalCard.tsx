import type { AgendaEventInput, AgendaPage, AgendaProposalAction, AgendaTodoInput, BridgeActionProposal, BridgeAgendaEvent, ProposalState } from "@bridge/protocol";
import { CalendarDays, ListTodo } from "lucide-react";
import { useEffect, useId, useState, type FormEvent } from "react";
import { agendaInputTime, agendaInstant, agendaTimedRange } from "../../lib/assistant-agenda.js";
import { Sheet } from "../common/Sheet.js";
import { mailResult } from "./AssistantMailProvider.js";
import { proposalRef, useAssistantProposals } from "./AssistantProposalProvider.js";
import "./assistant-proposal.css";

const deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const todoLabels: Record<AgendaTodoInput["status"], string> = { pending: "待办", "in-progress": "进行中", completed: "已完成", cancelled: "已取消" };
export const proposalKindLabel: Record<AgendaProposalAction["kind"], string> = {
  "todo.create": "新建待办", "todo.update": "修改待办", "todo.complete": "完成待办",
  "calendar.create": "新建日程", "calendar.reschedule": "调整日程", "calendar.delete": "删除日程",
};
export const proposalStateLabel: Record<ProposalState, string> = {
  pending: "待确认", executing: "正在写入…", applied: "已写入", dismissed: "已忽略",
  conflict: "目标记录已更新，未写入。", failed: "写入失败。", uncertain: "结果不确定，请核对来源。不会自动重试。",
};

export function proposalTitle(proposal: BridgeActionProposal): string {
  return "value" in proposal.action ? proposal.action.value.title : proposal.before?.title ?? proposalKindLabel[proposal.action.kind];
}

function shiftDate(value: string, days: number): string {
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function dateRange(event: AgendaEventInput) {
  return event.allDay ? `${event.startAt} 至 ${shiftDate(event.endAt, -1)} 全天`
    : agendaTimedRange(event.startAt, event.endAt, event.timeZone, deviceZone);
}

function AgendaFields({ value }: { value: AgendaEventInput | AgendaTodoInput }) {
  return <dl className="proposal-fields">
    {"startAt" in value ? <>
      <dt>时间</dt><dd>{dateRange(value)}</dd>
      {value.location && <><dt>地点</dt><dd>{value.location}</dd></>}
    </> : <>
      {value.dueAt && <><dt>截止</dt><dd>{agendaInputTime(value.dueAt, deviceZone).replace("T", " ")}</dd></>}
      {value.remindAt && <><dt>提醒</dt><dd>{agendaInputTime(value.remindAt, deviceZone).replace("T", " ")}</dd></>}
      {value.priority !== undefined && value.priority > 0 && <><dt>优先级</dt><dd>{value.priority}</dd></>}
      <dt>状态</dt><dd>{todoLabels[value.status]}</dd>
    </>}
    {value.notes && <><dt>备注</dt><dd>{value.notes}</dd></>}
  </dl>;
}

export function ProposalCard({ proposal, mobile, review = false, replaced = false, onResult }: {
  proposal: BridgeActionProposal; mobile: boolean; review?: boolean; replaced?: boolean; onResult?(proposal: BridgeActionProposal): void;
}) {
  const controller = useAssistantProposals();
  const [outcome, setOutcome] = useState<BridgeActionProposal>();
  const [editing, setEditing] = useState<BridgeActionProposal>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const current = outcome?.proposalId === proposal.proposalId && (outcome.revision > proposal.revision ||
    (outcome.revision === proposal.revision && proposal.state === "pending")) ? outcome : proposal;
  const { action, state } = current;
  const calendar = action.kind.startsWith("calendar.");
  const Icon = calendar ? CalendarDays : ListTodo;
  const disabled = !controller?.online || busy || replaced;
  const desired = "value" in action ? action.value : action.kind === "todo.complete" && current.before && "status" in current.before
    ? { ...current.before, status: "completed" as const } : current.before;

  async function decide(method: "assistant.proposal.commit" | "assistant.proposal.dismiss") {
    setBusy(true);
    setError("");
    try {
      const { proposal: result } = mailResult<{ proposal: BridgeActionProposal }>(await controller!.request(method, { ...proposalRef(current) }));
      setOutcome(result);
      onResult?.(result);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "无法处理提案。"); }
    finally { setBusy(false); controller!.refresh(); }
  }

  return <section className={`proposal-card${review ? " is-review" : ""}`} aria-label={`提案：${proposalTitle(current)}`} data-proposal-id={current.proposalId}>
    <header className="proposal-card-header">
      <Icon size={17} aria-hidden="true" />
      <span>{proposalKindLabel[action.kind]}</span>
      <span className="proposal-card-revision">版本 {current.revision}</span>
    </header>
    <h3>{proposalTitle(current)}</h3>
    <p className="proposal-card-source">{calendar ? "日历" : "待办来源"}：{current.sourceLabel}</p>
    {current.before && action.kind !== "calendar.delete" && <details className="proposal-before">
      <summary>原记录</summary>
      {current.before.title !== proposalTitle(current) && <strong>{current.before.title}</strong>}
      <AgendaFields value={current.before} />
    </details>}
    {desired && <AgendaFields value={desired} />}
    {state === "pending" && calendar && current.before && "attendees" in current.before && Array.isArray(current.before.attendees) && current.before.attendees.length > 0 &&
      <p className="proposal-status">参与者：{current.before.attendees.join("、")}。日历服务可能发送变更通知。</p>}
    {replaced && <p role="status">提案已更新，请返回待确认列表核对。</p>}
    {state !== "pending" && <p className="proposal-status" data-state={state} role="status">{proposalStateLabel[state]}</p>}
    {error && <p role="alert">{error}</p>}
    {state === "pending" && !editing && <div className="proposal-actions">
      <button type="button" className="primary-button" disabled={disabled} onClick={() => void decide("assistant.proposal.commit")}>
        {busy ? "处理中…" : action.kind === "calendar.delete" ? "确认删除日程" : "确认写入"}
      </button>
      {"value" in action && <button type="button" className="secondary-button" disabled={disabled} onClick={() => setEditing(current)}>调整</button>}
      <button type="button" className="assistant-session-link" disabled={disabled} onClick={() => void decide("assistant.proposal.dismiss")}>忽略</button>
    </div>}
    {editing && <ProposalEditor proposal={editing} mobile={mobile} stale={replaced || current.revision !== editing.revision || state !== "pending"}
      onClose={() => setEditing(undefined)} onRevised={result => { setOutcome(result); onResult?.(result); }} />}
  </section>;
}

function ProposalEditor({ proposal, mobile, stale, onClose, onRevised }: {
  proposal: BridgeActionProposal; mobile: boolean; stale: boolean; onClose(): void; onRevised(proposal: BridgeActionProposal): void;
}) {
  const controller = useAssistantProposals()!;
  const { action } = proposal;
  const value = "value" in action ? action.value : undefined;
  const event = value && "startAt" in value ? value : undefined;
  const todo = value && "status" in value ? value : undefined;
  const [mode, setMode] = useState<"assistant" | "manual">("assistant");
  const [allDay, setAllDay] = useState(event?.allDay ?? false);
  const [start, setStart] = useState(event ? agendaInputTime(event.startAt, event.timeZone) : "");
  const [end, setEnd] = useState(event ? event.allDay ? shiftDate(event.endAt, -1) : agendaInputTime(event.endAt, event.timeZone) : "");
  const [feedback, setFeedback] = useState("");
  const [nearby, setNearby] = useState<BridgeAgendaEvent[]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const formId = useId();
  const disabled = busy || stale || !controller.online;
  const timeZone = event?.timeZone ?? deviceZone;
  const { request, online } = controller;
  useEffect(() => {
    if (!event || !online) return;
    let current = true;
    void request("plugin.assistant-agenda.event.list", {
      from: `${shiftDate(event.startAt, -1)}T00:00:00Z`, to: `${shiftDate(event.startAt, 2)}T00:00:00Z`, limit: 8,
    }).then(response => {
      if (current) setNearby(mailResult<{ agendaPage: AgendaPage<BridgeAgendaEvent> }>(response).agendaPage.records);
    }).catch(() => { if (current) setNearby(undefined); });
    return () => { current = false; };
  }, [event, online, request]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled) return;
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      const ref = proposalRef(proposal);
      if (mode === "assistant") {
        mailResult(await request("assistant.proposal.replan", { ...ref, feedback }));
      } else if ("value" in action) {
        const title = String(data.get("title")).trim();
        if (!title) throw new Error("请输入标题。");
        const notes = String(data.get("notes")).trim();
        const sourceId = String(data.get("sourceId"));
        let next: AgendaProposalAction;
        if (action.kind === "calendar.create" || action.kind === "calendar.reschedule") {
          const startAt = allDay ? start : agendaInstant(start, timeZone, action.value.startAt);
          const endAt = allDay ? shiftDate(end, 1) : agendaInstant(end, timeZone, action.value.endAt);
          if (startAt >= endAt) throw new Error("结束时间必须晚于开始时间。");
          const location = String(data.get("location")).trim();
          next = { ...action, ...(action.kind === "calendar.create" ? { sourceId } : {}), value: { title, notes: notes || undefined, location: location || undefined, startAt, endAt, timeZone, allDay } };
        } else {
          const due = String(data.get("dueAt") ?? "");
          const reminder = String(data.get("remindAt") ?? "");
          next = { ...action, ...(action.kind === "todo.create" ? { sourceId } : {}), value: {
            ...action.value, title, notes: notes || undefined, status: String(data.get("status")) as AgendaTodoInput["status"],
            dueAt: due ? due.length === 10 ? due : agendaInstant(due, deviceZone, action.value.dueAt) : undefined,
            remindAt: reminder ? reminder.length === 10 ? reminder : agendaInstant(reminder, deviceZone, action.value.remindAt) : undefined,
          } };
        }
        const result = mailResult<{ proposal: BridgeActionProposal }>(await request("assistant.proposal.revise", { ...ref, action: next }));
        onRevised(result.proposal);
        controller.refresh();
      }
      onClose();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "无法更新提案。"); controller.refresh(); }
    finally { setBusy(false); }
  }

  const footer = <div className="proposal-actions">
    <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button>
    <button type="submit" form={formId} className="primary-button" disabled={disabled || (mode === "assistant" && !feedback.trim())}>
      {mode === "manual" ? "保存修改" : event ? "让助理重排" : "让助理调整"}
    </button>
  </div>;
  const content = <form id={formId} className="proposal-edit-form agenda-form" onSubmit={submission => void save(submission)}>
    <nav className="assistant-view-switch" aria-label="调整方式">
      <button type="button" aria-pressed={mode === "assistant"} onClick={() => setMode("assistant")}>让助理改</button>
      <button type="button" aria-pressed={mode === "manual"} onClick={() => setMode("manual")}>手动编辑</button>
    </nav>
    {stale && <p role="status">提案已更新。关闭后重新核对。</p>}
    {mode === "assistant" ? <>
      {event && <div className="proposal-nearby">
        <strong>邻近日程</strong>
        {nearby ? nearby.length ? <ul>{nearby.map(item => <li key={item.id}>{dateRange(item)}　{item.title}</li>)}</ul>
          : <p>未查到邻近日程</p> : <p>暂未取得邻近日程</p>}
      </div>}
      <label className="proposal-edit-text">{event ? "调期意见" : "调整意见"}<textarea disabled={disabled} maxLength={4000} value={feedback} onChange={change => setFeedback(change.target.value)} /></label>
    </> : <fieldset disabled={disabled}>
      <label>标题<input name="title" required maxLength={500} defaultValue={value?.title} /></label>
      {action.kind === "calendar.create" || action.kind === "todo.create" ? <label>{event ? "目标日历" : "待办来源"}
        <select name="sourceId" defaultValue={proposal.sourceId}>
          {!controller.summary.sources.some(source => source.id === proposal.sourceId) && <option value={proposal.sourceId}>{proposal.sourceLabel}</option>}
          {controller.summary.sources.filter(source => source.kinds.includes(event ? "calendar" : "todo")).map(source => <option key={source.id} value={source.id}>{source.label}</option>)}
        </select>
      </label> : <p className="proposal-card-source">{event ? "日历" : "待办来源"}：{proposal.sourceLabel}</p>}
      {event ? <>
        <label className="agenda-form-option"><input type="checkbox" checked={allDay} onChange={change => {
          const checked = change.target.checked;
          setStart(checked ? start.slice(0, 10) : `${start}T09:00`);
          setEnd(checked ? end.slice(0, 10) : `${end}T10:00`);
          setAllDay(checked);
        }} />全天</label>
        <div className="agenda-form-pair">
          <label>{allDay ? "开始日期" : "开始时间"}<input aria-describedby={`${formId}-zone`} type={allDay ? "date" : "datetime-local"} required value={start} onChange={change => setStart(change.target.value)} /></label>
          <label>{allDay ? "结束日期" : "结束时间"}<input aria-describedby={`${formId}-zone`} type={allDay ? "date" : "datetime-local"} required value={end} onChange={change => setEnd(change.target.value)} /></label>
        </div>
        <span id={`${formId}-zone`} className="proposal-card-source">{timeZone}</span>
        <label>地点<input name="location" maxLength={1000} defaultValue={event.location} /></label>
      </> : todo && <>
        <label>状态<select name="status" defaultValue={todo.status}>{Object.entries(todoLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <div className="agenda-form-pair">
          <label>截止<input name="dueAt" type={todo.dueAt?.length === 10 ? "date" : "datetime-local"} defaultValue={todo.dueAt ? agendaInputTime(todo.dueAt, deviceZone) : ""} /></label>
          <label>提醒<input name="remindAt" type={todo.remindAt?.length === 10 ? "date" : "datetime-local"} defaultValue={todo.remindAt ? agendaInputTime(todo.remindAt, deviceZone) : ""} /></label>
        </div>
      </>}
      <label className="proposal-edit-text">备注<textarea name="notes" maxLength={8000} defaultValue={value?.notes} /></label>
    </fieldset>}
    {error && <p role="alert">{error}</p>}
  </form>;

  return mobile ? <Sheet title={event ? "调整日程提案" : "调整待办提案"} fullScreen manageFocus busy={busy} onClose={onClose} footer={footer}>{content}</Sheet>
    : <div className="proposal-inline-editor">{content}{footer}</div>;
}
