import type { AgendaEventInput, AgendaTodoInput, BridgeAgendaEvent, BridgeAgendaTodo } from "@bridge/protocol";
import { CalendarDays, ChevronLeft, ChevronRight, Pencil } from "lucide-react";
import { useEffect, useId, useState, type FormEvent } from "react";
import { agendaCalendarDate, agendaInputTime, agendaInstant, agendaTimedRange } from "../../lib/assistant-agenda.js";
import { IconButton } from "../common/IconButton.js";
import { Sheet } from "../common/Sheet.js";
import { agendaDeviceZone as deviceZone, useAssistantAgenda } from "./AssistantAgendaProvider.js";
import { useAssistantMail } from "./AssistantMailProvider.js";
import "./assistant-agenda.css";

const dayLabel = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", weekday: "short" });
const timeZones = new Set([deviceZone, "UTC", ...Intl.supportedValuesOf("timeZone")]);
const priorityLabels = { 1: "高", 5: "中", 9: "低" };
const priorityGroup = (priority: number | undefined): keyof typeof priorityLabels | "" =>
  !priority ? "" : priority < 5 ? 1 : priority === 5 ? 5 : 9;
const shiftDate = (date: string, days: number) => new Date(Date.parse(`${date}T00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const todoStatuses: Record<AgendaTodoInput["status"], string> = {
  pending: "待处理", "in-progress": "进行中", completed: "已完成", cancelled: "已取消",
};

function displayTime(value: string, timeZone = deviceZone): string {
  return agendaInputTime(value, timeZone).replace("T", " ");
}

export function AgendaView() {
  const agenda = useAssistantAgenda()!;
  const mail = useAssistantMail();
  const { events, todos, allTodos, calendarOnly, date, today } = agenda;
  const dayId = useId();
  const [editing, setEditing] = useState<BridgeAgendaTodo | BridgeAgendaEvent>();
  const [completing, setCompleting] = useState<string>();
  const [acknowledging, setAcknowledging] = useState(false);
  const [error, setError] = useState("");
  // The provider keeps opened pages while the Assistant stage is switched away.
  useEffect(() => { agenda.openToday(); }, []);
  const sources = new Map(agenda.snapshot?.sources.map(source => [source.id, source]));
  const year = date.getFullYear();
  const month = date.getMonth();
  const selectedDay = agendaInputTime(date.toISOString(), deviceZone).slice(0, 10);
  const isToday = !calendarOnly && selectedDay === today;
  const otherTasks = !calendarOnly && (isToday || agenda.allTodosOpen) ? allTodos.records.flatMap(record => {
    const at = record.dueAt ? agendaInputTime(record.dueAt, deviceZone) : "";
    if (at.startsWith(selectedDay)) return [];
    return [{ record, at, overdue: at !== "" && at.slice(0, 10) < today && record.status !== "completed" && record.status !== "cancelled" }];
  }) : [];
  const overduePreview = isToday ? otherTasks.filter(entry => entry.overdue).slice(0, 3) : [];
  const entries = events.records.flatMap(record => {
    if (!calendarOnly && !agenda.daySupported && record.allDay && (selectedDay < record.startAt || selectedDay >= record.endAt)) return [];
    return [{ record, at: agendaInputTime(record.startAt, deviceZone), epoch: record.allDay ? -Infinity : Date.parse(record.startAt) }];
  });
  const reminders = mail?.attention?.filter(item => item.kind === "event") ?? [];
  // Match by occurrence ID: all-day rows can project the reminder time differently.
  const reminderByEventId = new Map(reminders.map(item => [item.id.slice(0, item.id.indexOf(":")), item]));
  const listedEventIds = new Set(entries.map(({ record }) => record.id));
  const unlistedReminders = [...reminderByEventId].filter(([id]) => !listedEventIds.has(id));
  const dayTodos = calendarOnly ? [] : todos.records.flatMap(record => {
    if (!record.dueAt) return [];
    const at = agendaInputTime(record.dueAt, deviceZone);
    return agenda.daySupported || at.startsWith(selectedDay) ? [{ record, at, epoch: record.dueAt.length === 10 ? -Infinity : Date.parse(record.dueAt) }] : [];
  });
  const days = new Map<string, Array<{ record: BridgeAgendaTodo | BridgeAgendaEvent; at: string }>>();
  for (const entry of [...entries, ...dayTodos].sort((a, b) =>
    (calendarOnly ? a.at.slice(0, 10).localeCompare(b.at.slice(0, 10)) : 0) || a.epoch - b.epoch)) {
    const day = calendarOnly ? entry.at.slice(0, 10) : selectedDay;
    const records = days.get(day);
    if (records) records.push(entry);
    else days.set(day, [entry]);
  }

  const pages = calendarOnly ? [{ name: "日程", page: events }] : [{ name: "日程", page: events }, { name: "待办", page: todos }];
  const loading = pages.some(({ page }) => page.loading);

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

  function reminderAction({ id, title }: (typeof reminders)[number]) {
    return mail && <button type="button" className="assistant-session-link" aria-label={`已看 ${title}`}
      disabled={!mail.online || acknowledging} onClick={() => {
        setAcknowledging(true); setError("");
        void mail.acknowledge("event", id)
          .catch(reason => setError(reason instanceof Error ? reason.message : "无法记录已看"))
          .finally(() => setAcknowledging(false));
      }}>已看</button>;
  }

  function row({ record, at, overdue }: { record: BridgeAgendaTodo | BridgeAgendaEvent; at: string; overdue?: boolean }, groupedDay?: string) {
    const source = sources.get(record.sourceId);
    const isTodo = "status" in record;
    const priority = isTodo ? priorityGroup(record.priority) : "";
    const reminder = !isTodo && reminderByEventId.get(record.id);
    return <li className={`agenda-record${isTodo && (record.status === "completed" || record.status === "cancelled") ? " is-closed" : ""}`} key={`${isTodo ? "todo" : "event"}:${record.id}`}>
      {isTodo ? <label className="agenda-marker agenda-check">
        <input type="checkbox" aria-label={`完成 ${record.title}`} checked={record.status === "completed"} disabled={!agenda.online || !source?.enabled || !source.writable || Boolean(completing) || (groupedDay ? todos.loading : allTodos.loading)}
          onChange={event => void complete(record, event.target.checked)} />
      </label> : <span className="agenda-marker agenda-event-marker" aria-hidden="true"><CalendarDays size={17} /></span>}
      <div className="agenda-record-copy">
        <strong>{record.title}</strong>
        {isTodo ? <div className="agenda-todo-meta">
          {overdue && <small className="agenda-overdue-label">已逾期</small>}
          {record.status !== "pending" && record.status !== "completed" && <small>{todoStatuses[record.status]}</small>}
          {at && (groupedDay ? at.length > 10 && <small>截止 {at.slice(11)}</small> : <small>截止 {at.replace("T", " ")}</small>)}
          {record.remindAt && <small>提醒 {displayTime(record.remindAt)}</small>}
          {priority && <small>优先级 {priorityLabels[priority]}</small>}
        </div> : <>
          <small>{record.allDay ? `全天${record.startAt === groupedDay ? "" : ` ${record.startAt}`}${record.endAt === shiftDate(record.startAt, 1) ? "" : ` 至 ${shiftDate(record.endAt, -1)}`}`
            : agendaTimedRange(record.startAt, record.endAt, record.timeZone, deviceZone, groupedDay)}</small>
          {record.remindAt && <small>提醒 {displayTime(record.remindAt)}</small>}
          {record.location && <small>{record.location}</small>}
          {!!record.attendees?.length && <small>{record.attendees.join("、")}</small>}
        </>}
        {record.notes && <p className="agenda-notes">{record.notes}</p>}
        {record.origin === "untrusted_external" && <small>{source?.label ?? record.collection}（只读）</small>}
      </div>
      {reminder && reminderAction(reminder)}
      {source?.enabled && source.writable && <IconButton label={`编辑 ${record.title}`} disabled={!agenda.online}
        onClick={() => setEditing(record)}><Pencil size={16} /></IconButton>}
    </li>;
  }

  return <section className="agenda-view" aria-label="议程">
    <div className="agenda-toolbar">
      <div className="agenda-month" role="group" aria-label={calendarOnly ? "日程月份" : "议程日期"}>
        <IconButton label={calendarOnly ? "上个月" : "前一天"} onClick={() => agenda.selectDate(calendarOnly ? new Date(year, month - 1, 1) : new Date(year, month, date.getDate() - 1))}><ChevronLeft size={18} /></IconButton>
        <strong aria-live="polite">{calendarOnly ? `${year}年${month + 1}月` : <time dateTime={selectedDay}>{selectedDay === today ? "今天 " : ""}{dayLabel.format(date)}</time>}</strong>
        <IconButton label={calendarOnly ? "下个月" : "后一天"} onClick={() => agenda.selectDate(calendarOnly ? new Date(year, month + 1, 1) : new Date(year, month, date.getDate() + 1))}><ChevronRight size={18} /></IconButton>
      </div>
      <nav className="assistant-view-switch" aria-label="议程视图">
        <button type="button" aria-pressed={!calendarOnly} onClick={() => agenda.setCalendarOnly(false)}>按日</button>
        <button type="button" aria-pressed={calendarOnly} onClick={() => agenda.setCalendarOnly(true)}>日历</button>
      </nav>
    </div>
    {!calendarOnly && !isToday && <button type="button" className="secondary-button agenda-return-today" onClick={agenda.openToday}>回到今天</button>}

    {!agenda.online && <p role="status">电脑离线，连接后可同步议程。</p>}
    {error && <p role="alert">{error}</p>}
    {unlistedReminders.length > 0 && <div className="agenda-day">
      <h3 id={`${dayId}-reminders`}>日程提醒</h3>
      <ul className="agenda-records" aria-labelledby={`${dayId}-reminders`}>
        {unlistedReminders.map(([, reminder]) => <li className="agenda-record" key={reminder.id}>
          <span className="agenda-marker agenda-event-marker" aria-hidden="true"><CalendarDays size={17} /></span>
          <div className="agenda-record-copy">
            <strong>{reminder.title}</strong>
            <small><time dateTime={reminder.startAt}>{reminder.startAt.length === 10 ? reminder.startAt : displayTime(reminder.startAt)}</time></small>
          </div>
          {reminderAction(reminder)}
        </li>)}
      </ul>
    </div>}
    {pages.map(({ name, page }) => <div key={name}>
      {page.error && <div className="assistant-actions"><p role="alert">{name}：{page.error}</p><button type="button" className="secondary-button" disabled={!agenda.online || page.loading} onClick={page.retry}>重试{name}</button></div>}
      {page.incomplete && <p role="status">部分重复{name}超出展开上限，未显示。</p>}
    </div>)}
    {agenda.online && loading && !days.size && <p role="status">正在同步议程…</p>}
    {pages.some(({ page }) => page.hasMore) && <div className="agenda-pagination">
      {pages.map(({ name, page }) => page.hasMore && <button key={name} type="button" className="secondary-button" disabled={!agenda.online || page.loading} onClick={page.loadMore}>更多{name}</button>)}
    </div>}
    {!days.size && agenda.online && !loading && pages.every(({ page }) => !page.error && !page.incomplete && !page.hasMore) &&
      <p className="assistant-mail-empty" role="status">{calendarOnly ? "本月暂无日程" : "当天暂无日程或待办"}</p>}
    {[...days].map(([day, records]) => calendarOnly ? <div className="agenda-day" key={day}>
      <h3 id={`${dayId}-${day}`}><time dateTime={day}>{dayLabel.format(new Date(`${day}T00:00`))}</time></h3>
      <ul className="agenda-records" aria-labelledby={`${dayId}-${day}`}>{records.map(entry => row(entry, day))}</ul>
    </div> : <ul key={day} className="agenda-records agenda-day" aria-label="当日议程">{records.map(entry => row(entry, day))}</ul>)}
    {overduePreview.length > 0 && <div className="agenda-day">
      <h3 id={`${dayId}-overdue`}>已逾期待办</h3>
      <ul className="agenda-records" aria-labelledby={`${dayId}-overdue`}>{overduePreview.map(({ record, at }) => row({ record, at }))}</ul>
    </div>}
    {!calendarOnly && <details className="agenda-other-todos" open={agenda.allTodosOpen} onToggle={event => agenda.setAllTodosOpen(event.currentTarget.open)}>
      <summary>其他待办</summary>
      {agenda.allTodosOpen && <>
        {allTodos.error && <div className="assistant-actions"><p role="alert">{allTodos.error}</p><button type="button" className="secondary-button" disabled={!agenda.online || allTodos.loading} onClick={allTodos.retry}>重试</button></div>}
        {allTodos.incomplete && <p role="status">部分重复待办超出展开上限，未显示。</p>}
        {allTodos.loading && <p role="status">正在读取待办…</p>}
        <ul className="agenda-records" aria-label="其他待办">{otherTasks.filter(entry => !overduePreview.includes(entry)).map(entry => row(entry))}</ul>
        {allTodos.hasMore && <button type="button" className="secondary-button" disabled={!agenda.online || allTodos.loading} onClick={allTodos.loadMore}>更多其他待办</button>}
      </>}
    </details>}
    {editing && <AgendaEditor record={editing} onClose={() => setEditing(undefined)} />}
  </section>;
}

function AgendaEditor({ record, onClose }: { record: BridgeAgendaTodo | BridgeAgendaEvent; onClose(): void }) {
  const agenda = useAssistantAgenda()!;
  const formId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const isTodo = "status" in record;
  const [allDay, setAllDay] = useState(!isTodo && record.allDay);
  const [timeZone, setTimeZone] = useState(isTodo ? deviceZone : record.timeZone);
  const [start, setStart] = useState(() => isTodo ? "" : agendaInputTime(record.startAt, timeZone));
  const [end, setEnd] = useState(() => isTodo ? "" : record.allDay ? shiftDate(record.endAt, -1) : agendaInputTime(record.endAt, timeZone));
  const supportsReminder = useAssistantMail()?.attention !== undefined;

  async function save(submission: FormEvent<HTMLFormElement>) {
    submission.preventDefault();
    const form = new FormData(submission.currentTarget);
    const text = String(form.get("title")).trim();
    if (!text) { setError("请输入标题。"); return; }
    const notes = String(form.get("notes")).trim();
    const fields = { title: text, ...(notes ? { notes } : {}) };
    const existing = { id: record.id, revision: record.revision };
    setBusy(true);
    setError("");
    try {
      if (isTodo) {
        const value: AgendaTodoInput = { ...fields, status: String(form.get("status")) as AgendaTodoInput["status"], mailRefId: record.mailRefId };
        const priority = String(form.get("priority"));
        if (priority) value.priority = Number(priority) === priorityGroup(record.priority) ? record.priority : Number(priority);
        for (const key of ["dueAt", "remindAt"] as const) {
          const date = String(form.get(key) ?? "");
          if (date) value[key] = agendaInstant(date, deviceZone, record[key]);
        }
        await agenda.mutate("plugin.assistant-agenda.todo.save", { existing, value });
        if (!value.dueAt) agenda.setAllTodosOpen(true);
        else if (value.dueAt !== record.dueAt) agenda.selectDate(agendaCalendarDate(value.dueAt, value.dueAt.length === 10));
      } else {
        const startAt = allDay ? start : agendaInstant(start, timeZone, record.allDay ? undefined : record.startAt);
        const endAt = allDay ? shiftDate(end, 1) : agendaInstant(end, timeZone, record.allDay ? undefined : record.endAt);
        if (startAt >= endAt) throw new Error(allDay ? "结束日期不能早于开始日期。" : "结束时间必须晚于开始时间。");
        const location = String(form.get("location")).trim();
        const value: AgendaEventInput = { ...fields, startAt, endAt, timeZone, allDay, ...(location ? { location } : {}) };
        const reminder = String(form.get("eventReminder") ?? "");
        await agenda.mutate("plugin.assistant-agenda.event.save", { existing, value: supportsReminder
          ? { ...value, remindAt: reminder ? agendaInstant(reminder, deviceZone, record.remindAt) : null } : value });
        agenda.selectDate(agendaCalendarDate(startAt, allDay));
      }
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  return <Sheet title={isTodo ? "编辑待办" : "编辑日程"} busy={busy} manageFocus onClose={onClose} footer={<>
    <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button>
    <button type="submit" className="primary-button" form={formId} disabled={busy || !agenda.online}>保存</button>
  </>}>
    <form id={formId} className="agenda-form" onSubmit={event => void save(event)}>
      <fieldset disabled={busy}>
        <label>标题<input name="title" required maxLength={500} defaultValue={record.title} /></label>
        {isTodo ? <>
          <div className="agenda-form-pair">
            <label>状态<select name="status" defaultValue={record.status}>
              {Object.entries(todoStatuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select></label>
            <label>优先级<select name="priority" defaultValue={priorityGroup(record.priority)}>
              <option value="">无</option>
              {([1, 5, 9] as const).map(value => <option key={value} value={value}>{priorityLabels[value]}</option>)}
            </select></label>
          </div>
          <AgendaTodoDate name="dueAt" label="截止" value={record.dueAt} />
          <AgendaTodoDate name="remindAt" label="提醒" value={record.remindAt} />
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
          {supportsReminder && <label>提醒时间<input name="eventReminder" type="datetime-local" defaultValue={record.remindAt && agendaInputTime(record.remindAt, deviceZone)} /></label>}
          <label>地点<input name="location" maxLength={1000} defaultValue={record.location} /></label>
        </>}
        <label>备注<textarea name="notes" maxLength={8000} rows={3} defaultValue={record.notes} /></label>
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
