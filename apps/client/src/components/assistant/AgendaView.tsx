import type { AgendaEventInput, AgendaTodoInput, BridgeAgendaEvent, BridgeAgendaTodo } from "@bridge/protocol";
import { CalendarDays, ChevronLeft, ChevronRight, Pencil } from "lucide-react";
import { useEffect, useId, useState, type FormEvent } from "react";
import { agendaCalendarDate, agendaInputTime, agendaInstant, agendaTimedRange } from "../../lib/assistant-agenda.js";
import { IconButton } from "../common/IconButton.js";
import { Sheet } from "../common/Sheet.js";
import { useAssistantAgenda } from "./AssistantAgendaProvider.js";
import "./assistant-agenda.css";

const deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const timeZones = new Set([deviceZone, "UTC", ...Intl.supportedValuesOf("timeZone")]);
const priorityLabels = { 1: "高", 5: "中", 9: "低" };
const priorityGroup = (priority: number | undefined): keyof typeof priorityLabels | "" =>
  !priority ? "" : priority < 5 ? 1 : priority === 5 ? 5 : 9;
const shiftDate = (date: string, days: number) => new Date(Date.parse(`${date}T00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const todoStatuses: Record<AgendaTodoInput["status"], string> = {
  pending: "待处理", "in-progress": "进行中", completed: "已完成", cancelled: "已取消",
};

type Editor = { type: "todo"; record?: BridgeAgendaTodo } | { type: "event"; record?: BridgeAgendaEvent };

function displayTime(value: string, timeZone = deviceZone): string {
  return agendaInputTime(value, timeZone).replace("T", " ");
}

export function AgendaView({ calendarOnly, onCalendarOnlyChange }: { calendarOnly: boolean; onCalendarOnlyChange(calendarOnly: boolean): void }) {
  const agenda = useAssistantAgenda()!;
  const dayId = useId();
  const [editor, setEditor] = useState<Editor>();
  const [completing, setCompleting] = useState<string>();
  const [error, setError] = useState("");
  // The provider keeps opened pages while the Assistant stage is switched away.
  useEffect(() => { agenda.selectMonth(); }, []);
  const { events, todos } = agenda;
  const sources = new Map(agenda.snapshot?.sources.map(source => [source.id, source]));
  const canCreate = agenda.online && agenda.snapshot?.sources.some(source => source.enabled && source.writable);
  const year = agenda.month.getFullYear();
  const month = agenda.month.getMonth();
  const entries = [
    ...events.records.map(record => ({ record, at: agendaInputTime(record.startAt, deviceZone) })),
    ...(calendarOnly ? [] : todos.records.map(record => ({ record, at: record.dueAt ? agendaInputTime(record.dueAt, deviceZone) : "" }))),
  ].sort((a, b) => Number(!a.at) - Number(!b.at) || a.at.localeCompare(b.at));
  const days = new Map<string, typeof entries>();
  for (const entry of entries) {
    const day = entry.at.slice(0, 10);
    const records = days.get(day);
    if (records) records.push(entry);
    else days.set(day, [entry]);
  }
  const pages = calendarOnly ? [{ name: "日程", page: events }] : [{ name: "日程", page: events }, { name: "待办", page: todos }];

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

  function row({ record, at }: (typeof entries)[number]) {
    const source = sources.get(record.sourceId);
    const isTodo = "status" in record;
    const priority = isTodo ? priorityGroup(record.priority) : "";
    return <li className={`agenda-record${isTodo && (record.status === "completed" || record.status === "cancelled") ? " is-closed" : ""}`} key={`${isTodo ? "todo" : "event"}:${record.id}`}>
      {isTodo ? <label className="agenda-marker agenda-check">
        <input type="checkbox" aria-label={`完成 ${record.title}`} checked={record.status === "completed"} disabled={!agenda.online || !source?.enabled || !source.writable || Boolean(completing) || todos.loading}
          onChange={event => void complete(record, event.target.checked)} />
      </label> : <span className="agenda-marker agenda-event-marker" aria-hidden="true"><CalendarDays size={17} /></span>}
      <div className="agenda-record-copy">
        <strong>{record.title}</strong>
        {isTodo ? <div className="agenda-todo-meta">
          {record.status !== "pending" && record.status !== "completed" && <small>{todoStatuses[record.status]}</small>}
          {at.length > 10 && <small>截止 {at.slice(11)}</small>}
          {record.remindAt && <small>提醒 {displayTime(record.remindAt)}</small>}
          {priority && <small>优先级 {priorityLabels[priority]}</small>}
        </div> : <>
          <small>{record.allDay ? record.endAt === shiftDate(record.startAt, 1) ? "全天" : `全天 · 至 ${shiftDate(record.endAt, -1)}`
            : agendaTimedRange(record.startAt, record.endAt, record.timeZone, deviceZone, at.slice(0, 10))}</small>
          {record.location && <small>{record.location}</small>}
          {!!record.attendees?.length && <small>{record.attendees.join("、")}</small>}
        </>}
        {record.notes && <p className="agenda-notes">{record.notes}</p>}
        {record.origin === "untrusted_external" && <small>{source?.label ?? record.collection}（只读）</small>}
      </div>
      {source?.enabled && source.writable && <IconButton label={`编辑 ${record.title}`} disabled={!agenda.online}
        onClick={() => setEditor(isTodo ? { type: "todo", record } : { type: "event", record })}><Pencil size={16} /></IconButton>}
    </li>;
  }

  return <section className="agenda-view" aria-label="议程">
    <div className="agenda-toolbar">
      <div className="agenda-month" role="group" aria-label="日程月份">
        <IconButton label="上个月" onClick={() => agenda.selectMonth(new Date(year, month - 1, 1))}><ChevronLeft size={18} /></IconButton>
        <strong aria-live="polite">{year}年{month + 1}月</strong>
        <IconButton label="下个月" onClick={() => agenda.selectMonth(new Date(year, month + 1, 1))}><ChevronRight size={18} /></IconButton>
      </div>
      <nav className="assistant-view-switch" aria-label="议程视图">
        <button type="button" aria-pressed={!calendarOnly} onClick={() => onCalendarOnlyChange(false)}>全部</button>
        <button type="button" aria-pressed={calendarOnly} onClick={() => onCalendarOnlyChange(true)}>日历</button>
      </nav>
    </div>
    <div className="agenda-actions">
      {!calendarOnly && <button type="button" className="secondary-button" disabled={!canCreate} onClick={() => setEditor({ type: "todo" })}>新建待办</button>}
      <button type="button" className="primary-button" disabled={!canCreate} onClick={() => setEditor({ type: "event" })}>新建日程</button>
    </div>
    {!agenda.online && <p role="status">电脑离线，连接后可同步议程。</p>}
    {error && <p role="alert">{error}</p>}
    {pages.map(({ name, page }) => <div key={name}>
      {page.error && <div className="assistant-actions"><p role="alert">{name}：{page.error}</p><button type="button" className="secondary-button" disabled={!agenda.online || page.loading} onClick={page.retry}>重试{name}</button></div>}
      {page.incomplete && <p role="status">部分重复{name}超出展开上限，未显示。</p>}
    </div>)}
    {!entries.length && agenda.online && pages.every(({ page }) => !page.error && !page.incomplete) && <p className="assistant-mail-empty" role="status">
      {pages.some(({ page }) => page.loading) ? "正在同步议程…" : calendarOnly ? "本月暂无日程" : "暂无日程或待办"}
    </p>}
    {[...days].map(([day, records]) => <div className="agenda-day" key={day}>
      <h3 id={`${dayId}-${day}`}>{day ? <time dateTime={day}>{day}</time> : "无截止日期"}</h3>
      <ul className="agenda-records" aria-labelledby={`${dayId}-${day}`}>{records.map(row)}</ul>
    </div>)}
    {pages.some(({ page }) => page.hasMore) && <div className="agenda-pagination">
      {pages.map(({ name, page }) => page.hasMore && <button key={name} type="button" className="secondary-button" disabled={!agenda.online || page.loading} onClick={page.loadMore}>
        {page.loading ? `正在读取${name}…` : `更多${name}`}
      </button>)}
    </div>}
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
  const [end, setEnd] = useState(() => event ? event.allDay ? shiftDate(event.endAt, -1) : agendaInputTime(event.endAt, timeZone) : `${start.slice(0, 10)}T10:00`);
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
        if (priority) value.priority = Number(priority) === priorityGroup(todo?.priority) ? todo?.priority : Number(priority);
        for (const key of ["dueAt", "remindAt"] as const) {
          const date = String(form.get(key) ?? "");
          if (date) value[key] = agendaInstant(date, deviceZone, todo?.[key]);
        }
        await agenda.mutate("plugin.assistant-agenda.todo.save", { existing, value });
      } else {
        const zone = timeZone;
        const startAt = allDay ? start : agendaInstant(start, zone, event?.allDay === false ? event.startAt : undefined);
        const endAt = allDay ? shiftDate(end, 1) : agendaInstant(end, zone, event?.allDay === false ? event.endAt : undefined);
        if (startAt >= endAt) throw new Error(allDay ? "结束日期不能早于开始日期。" : "结束时间必须晚于开始时间。");
        const location = String(form.get("location")).trim();
        const value: AgendaEventInput = { ...fields, startAt, endAt, timeZone: zone, allDay, ...(location ? { location } : {}) };
        await agenda.mutate("plugin.assistant-agenda.event.save", { existing, value });
        agenda.selectMonth(agendaCalendarDate(startAt, allDay));
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
            <label>优先级<select name="priority" defaultValue={priorityGroup(todo?.priority)}>
              <option value="">无</option>
              {([1, 5, 9] as const).map(value => <option key={value} value={value}>{priorityLabels[value]}</option>)}
            </select></label>
          </div>
          <AgendaTodoDate name="dueAt" label="截止" value={todo?.dueAt} />
          <AgendaTodoDate name="remindAt" label="提醒" value={todo?.remindAt} />
        </> : <>
          <label className="agenda-form-option"><input type="checkbox" checked={allDay} onChange={event => {
            const checked = event.target.checked;
            const startDate = start.slice(0, 10);
            const endDate = end.slice(0, 10);
            setStart(checked || !startDate ? startDate : `${startDate}T09:00`);
            setEnd(checked || !endDate ? endDate : `${endDate}T10:00`);
            setAllDay(checked);
          }} />全天</label>
          <div className="agenda-form-pair">
            <label>{allDay ? "开始日期" : "开始时间"}<input type={allDay ? "date" : "datetime-local"} required value={start} onChange={event => setStart(event.target.value)} /></label>
            <label>{allDay ? "结束日期" : "结束时间"}<input type={allDay ? "date" : "datetime-local"} required value={end} onChange={event => setEnd(event.target.value)} /></label>
          </div>
          <label>时区<select value={timeZone} onChange={event => setTimeZone(event.target.value)}>
            {!timeZones.has(timeZone) && <option value={timeZone}>{timeZone}</option>}
            {[...timeZones].map(zone => <option key={zone} value={zone}>{zone}</option>)}
          </select></label>
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
