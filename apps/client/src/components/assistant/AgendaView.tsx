import type { AgendaEventInput, AgendaTodoInput, BridgeAgendaEvent, BridgeAgendaTodo } from "@bridge/protocol";
import { ChevronLeft, ChevronRight, Pencil, Plus } from "lucide-react";
import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { agendaInputTime, agendaInstant } from "../../lib/assistant-agenda.js";
import { IconButton } from "../common/IconButton.js";
import { Sheet } from "../common/Sheet.js";
import { useAssistantAgenda } from "./AssistantAgendaProvider.js";
import "./assistant-agenda.css";

const deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const todoStatuses: Record<AgendaTodoInput["status"], string> = {
  pending: "待处理", "in-progress": "进行中", completed: "已完成", cancelled: "已取消",
};

type Editor = { type: "todo"; record?: BridgeAgendaTodo } | { type: "event"; record?: BridgeAgendaEvent };

function displayTime(value: string, timeZone = deviceZone): string {
  return agendaInputTime(value, timeZone).replace("T", " ");
}

export function AgendaView({ tab, onTabChange }: { tab: "todos" | "calendar"; onTabChange(tab: "todos" | "calendar"): void }) {
  const agenda = useAssistantAgenda()!;
  const [editor, setEditor] = useState<Editor>();
  const [completing, setCompleting] = useState<string>();
  const [error, setError] = useState("");
  // The provider keeps opened pages while the Assistant stage is switched away.
  useEffect(() => {
    if (tab === "todos") agenda.openTodos();
    else agenda.openCalendar();
  }, [tab]);
  const calendar = tab === "calendar";
  const page = calendar ? agenda.events : agenda.todos;
  const sources = new Map(agenda.snapshot?.sources.map(source => [source.id, source]));
  const canCreate = agenda.online && agenda.snapshot?.sources.some(source => source.enabled && source.writable);
  const year = agenda.month.getFullYear();
  const month = agenda.month.getMonth();

  async function complete(todo: BridgeAgendaTodo, completed: boolean) {
    setCompleting(todo.id);
    setError("");
    try {
      await agenda.mutate("plugin.assistant-agenda.todo.complete", { id: todo.id, revision: todo.revision, completed });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "待办更新失败");
    } finally {
      setCompleting(undefined);
    }
  }

  function row(record: BridgeAgendaTodo | BridgeAgendaEvent, detail: ReactNode, toggle?: ReactNode, edit?: Editor) {
    const source = sources.get(record.sourceId);
    return <li className="agenda-record" key={record.id}>
      {toggle}
      <div className="agenda-record-copy">
        <strong>{record.title}</strong>
        {detail}
        {record.notes && <p className="agenda-notes">{record.notes}</p>}
        {record.origin === "untrusted_external" && <small>{source?.label ?? record.collection}（只读）</small>}
      </div>
      {source?.enabled && source.writable && edit && <IconButton label={`编辑 ${record.title}`} disabled={!agenda.online} onClick={() => setEditor(edit)}><Pencil size={16} /></IconButton>}
    </li>;
  }

  return <section className="agenda-view" aria-label="议程">
    <div className="agenda-toolbar">
      <nav className="assistant-view-switch" aria-label="议程视图">
        <button type="button" aria-pressed={!calendar} onClick={() => onTabChange("todos")}>待办</button>
        <button type="button" aria-pressed={calendar} onClick={() => onTabChange("calendar")}>日历</button>
      </nav>
      <button type="button" className="primary-button agenda-new" disabled={!canCreate} onClick={() => setEditor({ type: calendar ? "event" : "todo" })}>
        <Plus size={16} aria-hidden="true" />{calendar ? "新建日程" : "新建待办"}
      </button>
    </div>
    {calendar && <div className="agenda-month">
      <IconButton label="上个月" onClick={() => agenda.openCalendar(new Date(year, month - 1, 1))}><ChevronLeft size={18} /></IconButton>
      <strong aria-live="polite">{year}年{month + 1}月</strong>
      <IconButton label="下个月" onClick={() => agenda.openCalendar(new Date(year, month + 1, 1))}><ChevronRight size={18} /></IconButton>
    </div>}
    {!agenda.online && <p role="status">电脑离线，连接后可同步议程。</p>}
    {error && <p role="alert">{error}</p>}
    {page.error && <div className="assistant-actions"><p role="alert">{page.error}</p><button type="button" className="secondary-button" disabled={!agenda.online || page.loading} onClick={page.retry}>重试</button></div>}
    {!page.records.length && !page.error && agenda.online && <p className="assistant-mail-empty" role="status">{page.loading ? "正在同步议程…" : calendar ? "本月暂无日程" : "暂无待办"}</p>}
    {page.records.length > 0 && <ul className="agenda-records" aria-label={calendar ? "日程列表" : "待办列表"}>
      {calendar ? agenda.events.records.map(event => row(event, <>
        <small>{displayTime(event.startAt, event.timeZone)} 至 {displayTime(event.endAt, event.timeZone)}{event.allDay ? "（全天，结束日期不含当天）" : ` (${event.timeZone})`}</small>
        {event.location && <small>{event.location}</small>}
        {!!event.attendees?.length && <small>{event.attendees.join("、")}</small>}
      </>, undefined, { type: "event", record: event })) : agenda.todos.records.map(todo => {
        const source = sources.get(todo.sourceId);
        return row(todo, <div className="agenda-todo-meta">
          {todo.status !== "pending" && todo.status !== "completed" && <small>{todoStatuses[todo.status]}</small>}
          {todo.dueAt && <small>截止 {displayTime(todo.dueAt)}</small>}
          {todo.remindAt && <small>提醒 {displayTime(todo.remindAt)}</small>}
          {!!todo.priority && <small>优先级 {todo.priority}</small>}
        </div>, <label className="agenda-check">
          <input type="checkbox" aria-label={`完成 ${todo.title}`} checked={todo.status === "completed"} disabled={!agenda.online || !source?.enabled || !source.writable || Boolean(completing) || page.loading}
            onChange={event => void complete(todo, event.target.checked)} />
        </label>, { type: "todo", record: todo });
      })}
    </ul>}
    {page.hasMore && <button type="button" className="secondary-button assistant-mail-older" disabled={!agenda.online || page.loading} onClick={page.loadMore}>{page.loading ? "正在读取…" : "加载更多"}</button>}
    {editor && <AgendaEditor editor={editor} month={agenda.month} onClose={() => setEditor(undefined)} />}
  </section>;
}

function AgendaEditor({ editor, month, onClose }: { editor: Editor; month: Date; onClose(): void }) {
  const agenda = useAssistantAgenda()!;
  const formId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const todo = editor.type === "todo" ? editor.record : undefined;
  const event = editor.type === "event" ? editor.record : undefined;
  const [allDay, setAllDay] = useState(event?.allDay ?? false);
  const [timeZone, setTimeZone] = useState(event?.timeZone ?? deviceZone);
  const [start, setStart] = useState(() => {
    if (event) return agendaInputTime(event.startAt, timeZone);
    const now = new Date();
    const day = now.getFullYear() === month.getFullYear() && now.getMonth() === month.getMonth() ? now : month;
    return `${agendaInputTime(day.toISOString(), timeZone).slice(0, 10)}T09:00`;
  });
  const [end, setEnd] = useState(() => event ? agendaInputTime(event.endAt, timeZone) : `${start.slice(0, 10)}T10:00`);
  const title = editor.type === "todo" ? (todo ? "编辑待办" : "新建待办") : (event ? "编辑日程" : "新建日程");
  const record = editor.record;

  async function save(submission: FormEvent<HTMLFormElement>) {
    submission.preventDefault();
    const form = new FormData(submission.currentTarget);
    const text = String(form.get("title")).trim();
    if (!text) { setError("请输入标题。"); return; }
    const notes = String(form.get("notes")).trim();
    const fields = { title: text, ...(notes ? { notes } : {}) };
    const existing = record ? { id: record.id, revision: record.revision } : undefined;
    setBusy(true);
    setError("");
    try {
      if (editor.type === "todo") {
        const value: AgendaTodoInput = { ...fields, status: String(form.get("status")) as AgendaTodoInput["status"], mailRefId: todo?.mailRefId };
        const priority = String(form.get("priority"));
        if (priority) value.priority = Number(priority);
        for (const key of ["dueAt", "remindAt"] as const) {
          const date = String(form.get(key) ?? "");
          if (date) value[key] = agendaInstant(date, deviceZone, todo?.[key]);
        }
        await agenda.mutate("plugin.assistant-agenda.todo.save", { existing, value });
      } else {
        const zone = timeZone.trim();
        try { new Intl.DateTimeFormat("en", { timeZone: zone }); }
        catch (reason) { if (reason instanceof RangeError) throw new Error("请输入有效的时区，例如 Asia/Shanghai。"); throw reason; }
        const startAt = allDay ? start : agendaInstant(start, zone, event?.allDay === false ? event.startAt : undefined);
        const endAt = allDay ? end : agendaInstant(end, zone, event?.allDay === false ? event.endAt : undefined);
        if (startAt >= endAt) throw new Error("结束时间必须晚于开始时间。");
        const location = String(form.get("location")).trim();
        const value: AgendaEventInput = { ...fields, startAt, endAt, timeZone: zone, allDay, ...(location ? { location } : {}) };
        await agenda.mutate("plugin.assistant-agenda.event.save", { existing, value });
        const [year, monthValue] = start.split("-").map(Number) as [number, number];
        agenda.openCalendar(new Date(year, monthValue - 1, 1));
      }
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  return <Sheet title={title} busy={busy} manageFocus onClose={onClose} footer={<>
    <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button>
    <button type="submit" className="primary-button" form={formId} disabled={busy || !agenda.online}>保存</button>
  </>}>
    <form id={formId} className="agenda-form" onSubmit={event => void save(event)}>
      <fieldset disabled={busy}>
        <label>标题<input name="title" required maxLength={500} defaultValue={record?.title} /></label>
        {editor.type === "todo" ? <>
          <div className="agenda-form-pair">
            <label>状态<select name="status" defaultValue={todo?.status ?? "pending"}>
              {Object.entries(todoStatuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select></label>
            <label>优先级<input name="priority" type="number" min={0} max={9} defaultValue={todo?.priority} /></label>
          </div>
          <AgendaTodoDate name="dueAt" label="截止" value={todo?.dueAt} />
          <AgendaTodoDate name="remindAt" label="提醒" value={todo?.remindAt} />
        </> : <>
          <label className="agenda-form-option"><input type="checkbox" checked={allDay} onChange={event => {
            const checked = event.target.checked;
            const startDate = start.slice(0, 10);
            const endDate = end.slice(0, 10);
            setStart(checked ? startDate : `${startDate}T09:00`);
            setEnd(checked && startDate === endDate ? new Date(Date.parse(`${endDate}T00:00Z`) + 86_400_000).toISOString().slice(0, 10) : checked ? endDate : `${endDate}T10:00`);
            setAllDay(checked);
          }} />全天</label>
          <div className="agenda-form-pair">
            <label>{allDay ? "开始日期" : "开始时间"}<input type={allDay ? "date" : "datetime-local"} required value={start} onChange={event => setStart(event.target.value)} /></label>
            <label>{allDay ? "结束日期（不含当天）" : "结束时间"}<input type={allDay ? "date" : "datetime-local"} required value={end} onChange={event => setEnd(event.target.value)} /></label>
          </div>
          <label>时区<input name="timeZone" required maxLength={128} value={timeZone} onChange={event => setTimeZone(event.target.value)} /></label>
          <label>地点<input name="location" maxLength={1000} defaultValue={event?.location} /></label>
        </>}
        <label>备注<textarea name="notes" maxLength={8000} rows={3} defaultValue={record?.notes} /></label>
      </fieldset>
      {error && <p role="alert">{error}</p>}
    </form>
  </Sheet>;
}

function AgendaTodoDate({ name, label, value }: { name: string; label: string; value?: string | undefined }) {
  const [mode, setMode] = useState(value?.length === 10 ? "date" : value ? "datetime-local" : "none");
  const [input, setInput] = useState(value ? agendaInputTime(value, deviceZone) : "");
  return <div className="agenda-form-pair">
    <label>{label}<select value={mode} onChange={event => {
      const next = event.target.value;
      if (next === "date") setInput(input.slice(0, 10));
      else if (next === "datetime-local" && input.length === 10) setInput(`${input}T09:00`);
      setMode(next);
    }}><option value="none">无</option><option value="date">仅日期</option><option value="datetime-local">日期和时间</option></select></label>
    {mode !== "none" && <input aria-label={`${label}${mode === "date" ? "日期" : "时间"}`} name={name} type={mode} value={input} required onChange={event => setInput(event.target.value)} />}
  </div>;
}
