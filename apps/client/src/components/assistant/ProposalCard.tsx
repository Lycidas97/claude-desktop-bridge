import type { AgendaEventInput, AgendaPage, AgendaProposalAction, AgendaTodoInput, BridgeActionProposal, BridgeAgendaEvent, MailSendFailure, ProposalState } from "@bridge/protocol";
import { CalendarDays, FilePenLine, ListTodo, Mail, MessageSquare } from "lucide-react";
import { useEffect, useId, useState, type FormEvent } from "react";
import { agendaInputTime, agendaInstant, agendaTimedRange } from "../../lib/assistant-agenda.js";
import { registerMobileBackHandler } from "../../lib/mobile-back-navigation.js";
import { MessageCopyButton } from "../common/MessageCopyButton.js";
import { Sheet } from "../common/Sheet.js";
import { mailResult } from "./AssistantMailProvider.js";
import { proposalRef, useAssistantProposals } from "./AssistantProposalProvider.js";
import { MailProposalSheet } from "./MailProposalSheet.js";
import "./assistant-proposal.css";

const deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const todoLabels: Record<AgendaTodoInput["status"], string> = { pending: "待办", "in-progress": "进行中", completed: "已完成", cancelled: "已取消" };
export const proposalKindLabel: Record<BridgeActionProposal["action"]["kind"], string> = {
  "todo.create": "新建待办", "todo.update": "修改待办", "todo.complete": "完成待办",
  "calendar.create": "新建日程", "calendar.reschedule": "调整日程", "calendar.delete": "删除日程",
  "mail.reply": "回复邮件", "mail.send": "外发邮件",
  "memory.rule_upsert": "助理规则",
  "session.open": "打开会话", "session.send": "发送会话消息", "session.create": "新建会话",
};
const proposalStateLabel: Record<ProposalState, string> = {
  pending: "待确认", executing: "正在写入…", applied: "已写入", dismissed: "已忽略",
  conflict: "记录已更新", failed: "写入失败", uncertain: "结果不确定",
  delivery_uncertain: "投递不确定", delivery_partial: "部分地址被拒绝",
};

const sessionDeliveryLabel: Record<NonNullable<BridgeActionProposal["sessionDelivery"]>, string> = {
  submitted: "已提交给 Claude Desktop，尚未确认接收", "session-received": "目标会话已接收", queued: "已在目标会话排队",
  running: "目标会话正在处理", completed: "目标会话已完成此轮", failed: "原生投递或回合失败", cancelled: "原生回合或排队已取消",
  uncertain: "投递不确定，不会自动重发",
};

const proposalStateDetail: Partial<Record<ProposalState, string>> = {
  conflict: "目标记录已更新，未写入。", uncertain: "结果不确定，请核对来源。不会自动重试。",
};

const mailSendReason: Record<MailSendFailure["reason"], { label: string; guidance?: string }> = {
  connection: { label: "无法连接发信服务器", guidance: "请检查 SMTP 地址、端口和网络。" },
  tls: { label: "无法建立 TLS 连接", guidance: "请检查 SMTP 端口、加密方式和服务器证书。" },
  auth: { label: "SMTP 认证失败", guidance: "请检查邮箱账号的发信授权。" },
  rejected: { label: "服务器未接受邮件", guidance: "请核对发件人、收件地址和邮件内容。" },
  credential: { label: "发信授权不可用", guidance: "请在邮箱账号设置中核对发信授权。" },
  unconfirmed: { label: "未收到有效的发送回执" },
  interrupted: { label: "发送过程未能完成记录" },
};

function mailFailureSummary(failure: MailSendFailure | undefined) {
  if (!failure || !Object.hasOwn(mailSendReason, failure.reason)) return;
  const { label, guidance } = mailSendReason[failure.reason];
  return { label: `${label}${failure.responseCode ? `（SMTP ${failure.responseCode}）` : ""}`, guidance };
}

export function proposalStatus(proposal: BridgeActionProposal): string {
  if (proposal.action.kind === "session.open" && proposal.state === "applied") return "已批准打开";
  if (proposal.action.kind === "session.create") {
    const { state, sessionCreation, sessionDelivery } = proposal;
    if (sessionDelivery) return sessionDeliveryLabel[sessionDelivery];
    if (state === "executing") return "正在新建会话…";
    if (state === "applied") return "已新建会话";
    if (state === "delivery_uncertain") return "会话已建，首条消息投递不确定，不会自动重发。";
    if (state === "uncertain") return sessionCreation?.sessionId ? "会话已建，后续结果未确认。" : "创建结果不确定，请查看会话列表。";
    if (state === "failed") {
      if (sessionCreation?.failure === "trust-required") return "目录尚未获 Claude Desktop 信任，请先在 Claude Desktop 中确认。";
      if (sessionCreation?.failure === "model") return "会话已建，但模型未确认应用。";
      if (sessionCreation?.failure === "create") return sessionCreation.sessionId ? "会话已建，但未能完成分组或加载。" : "未能完成新建会话。";
      return "会话已建，未能提交首条消息。";
    }
  }
  if (proposal.action.kind === "session.send") {
    if (proposal.sessionDelivery) return sessionDeliveryLabel[proposal.sessionDelivery];
    if (proposal.state === "executing") return "正在提交给 Claude Desktop…";
    if (proposal.state === "applied" || proposal.state === "delivery_uncertain") return "投递未确认，不会自动重发";
    if (proposal.state === "failed") return "未能提交，不会自动重发";
  }
  if ("accountKey" in proposal.action) {
    if (proposal.state === "applied") return "发送服务器已接受";
    if (proposal.state === "executing") return "正在发送…";
    if (proposal.state === "failed" || proposal.state === "delivery_uncertain") {
      const label = proposal.state === "failed" ? "发送失败" : proposalStateLabel.delivery_uncertain;
      const failure = mailFailureSummary(proposal.mailSendFailure);
      return failure ? `${label}：${failure.label}` : label;
    }
  }
  return proposalStateLabel[proposal.state];
}

export function proposalTitle(proposal: BridgeActionProposal): string {
  const { action } = proposal;
  if (action.kind === "memory.rule_upsert") return `${action.category} / ${action.ruleId}`;
  if ("accountKey" in action) return action.subject || "（无主题）";
  if ("targetSessionId" in action) return proposal.sessionTarget?.title ?? action.targetSessionId;
  if (action.kind === "session.create") return action.title ?? proposal.sessionCreateTarget?.projectName ?? action.cwd;
  return "value" in action ? action.value.title : proposal.before?.title ?? proposalKindLabel[action.kind];
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
  const [mailSheet, setMailSheet] = useState<{ proposal: BridgeActionProposal; mode: "send" | "edit" | "view" }>();
  const [sessionSheet, setSessionSheet] = useState<BridgeActionProposal>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const current = outcome?.proposalId === proposal.proposalId && (outcome.revision > proposal.revision ||
    (outcome.revision === proposal.revision && proposal.state === "pending")) ? outcome : proposal;
  const { action, state } = current;
  const calendar = action.kind.startsWith("calendar.");
  const memory = action.kind === "memory.rule_upsert";
  const mail = "accountKey" in action;
  const failure = mail ? mailFailureSummary(current.mailSendFailure) : undefined;
  const create = action.kind === "session.create";
  const session = create || "targetSessionId" in action;
  const createdSessionId = current.sessionCreation?.sessionId;
  const Icon = session ? MessageSquare : mail ? Mail : memory ? FilePenLine : calendar ? CalendarDays : ListTodo;
  const disabled = !controller?.online || busy || replaced;
  const desired = "value" in action ? action.value : action.kind === "todo.complete" && current.before && "status" in current.before
    ? { ...current.before, status: "completed" as const } : current.before;

  async function decide(method: "assistant.proposal.commit" | "assistant.proposal.dismiss", pinned = current) {
    setBusy(true);
    setError("");
    try {
      const review = create ? method === "assistant.proposal.commit" ? { confirmSessionCreate: true } : { includeSessionCreate: true }
        : session ? method === "assistant.proposal.commit" ? { confirmSession: true } : { includeSession: true }
        : memory ? method === "assistant.proposal.commit" ? { confirmMemory: true } : { includeMemory: true } : {};
      const { proposal: result } = mailResult<{ proposal: BridgeActionProposal }>(await controller!.request(method, { ...proposalRef(pinned), ...review }));
      setOutcome(result);
      onResult?.(result);
      if (session) setSessionSheet(undefined);
      if (result.action.kind === "session.open" && result.state === "applied") controller!.openSession(result.action.targetSessionId);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "无法处理提案。"); }
    finally { setBusy(false); controller!.refresh(); }
  }

  return <section className={`proposal-card${review ? " is-review" : ""}`} aria-label={`提案：${proposalTitle(current)}`} data-proposal-id={current.proposalId} data-stream-key={review ? undefined : `proposal:${current.proposalId}`}>
    <header className="proposal-card-header">
      <Icon size={17} aria-hidden="true" />
      <span>{proposalKindLabel[action.kind]}</span>
      {current.revision > 1 && <span className="proposal-card-revision">版本 {current.revision}</span>}
    </header>
    <h3>{proposalTitle(current)}</h3>
    {memory ? <dl className="proposal-fields">
      <dt>变更前</dt><dd>{current.profile?.before ?? "无"}</dd>
      <dt>变更后</dt><dd>{action.text ?? "删除此规则"}</dd>
      <dt>理由</dt><dd>{action.reason}</dd>
    </dl> : !session && <>
      <p className="proposal-card-source">{mail ? "发件账号" : calendar ? "日历" : "待办来源"}：{current.sourceLabel}</p>
      {current.before && action.kind !== "calendar.delete" && <details className="proposal-before">
        <summary>原记录</summary>
        {current.before.title !== proposalTitle(current) && <strong>{current.before.title}</strong>}
        <AgendaFields value={current.before} />
      </details>}
      {desired && <AgendaFields value={desired} />}
    </>}
    {state === "pending" && calendar && current.before && "attendees" in current.before && Array.isArray(current.before.attendees) && current.before.attendees.length > 0 &&
      <p className="proposal-status">参与者：{current.before.attendees.join("、")}。日历服务可能发送变更通知。</p>}
    {replaced && <p role="status">提案已更新，请返回待确认列表核对。</p>}
    {state !== "pending" && <p className="proposal-status" data-state={current.sessionDelivery ?? state} role="status">{session ? proposalStatus(current) : mail && state === "failed" ? (failure
      ? `发送失败：${failure.label}。邮件未发出。${failure.guidance ?? ""}` : "发送失败，未自动重试。")
      : state === "delivery_uncertain" ? `投递不确定${failure ? `：${failure.label}` : ""}。请核查「已发送」；找不到副本不代表未发送。Bridge 不会自动重发。`
      : state === "delivery_partial" ? `发送服务器拒绝了以下地址：${current.rejectedRecipients?.join("、")}。其余地址已接受，不会自动重发。`
      : proposalStateDetail[state] ?? proposalStatus(current)}</p>}
    {error && !sessionSheet && <p role="alert">{error}</p>}
    {state === "pending" && !editing && <div className="proposal-actions">
      {session ? <button type="button" className="primary-button" disabled={disabled || !(create ? current.sessionCreateTarget : current.sessionTarget)} onClick={() => {
        setError("");
        setSessionSheet(current);
      }}>{create ? "核对新会话…" : action.kind === "session.send" ? "核对会话消息…" : "核对目标会话…"}</button> : mail ? <>
        <button type="button" className="primary-button" disabled={disabled} onClick={() => setMailSheet({ proposal: current, mode: "send" })}>核对并发送…</button>
        <button type="button" className="secondary-button" disabled={disabled} onClick={() => setMailSheet({ proposal: current, mode: "edit" })}>编辑</button>
      </> : <button type="button" className="primary-button" disabled={disabled} onClick={() => void decide("assistant.proposal.commit")}>
        {busy ? "处理中…" : action.kind === "calendar.delete" ? "确认删除日程" : memory ? (action.operation === "delete" ? "确认删除规则" : "确认保存规则") : "确认写入"}
      </button>}
      {"value" in action && <button type="button" className="secondary-button" disabled={disabled} onClick={() => setEditing(current)}>调整</button>}
      <button type="button" className="assistant-session-link" disabled={disabled} onClick={() => void decide("assistant.proposal.dismiss")}>忽略</button>
    </div>}
    {state !== "pending" && (create || action.kind === "session.send") && <div className="proposal-actions">
      {createdSessionId && <button type="button" className="primary-button" disabled={disabled} onClick={() => {
        try { controller!.openSession(createdSessionId); }
        catch (reason) { setError(reason instanceof Error ? reason.message : "无法打开会话。"); }
      }}>打开新会话</button>}
      <button type="button" className="secondary-button" onClick={() => { setError(""); setSessionSheet(current); }}>
        {create ? "查看新会话提案" : "查看消息原文"}
      </button>
    </div>}
    {sessionSheet && <SessionProposalSheet proposal={sessionSheet} hostName={controller!.hostName} mobile={mobile}
      onClose={() => { setSessionSheet(undefined); setError(""); }}
      confirmation={sessionSheet.state === "pending" ? {
        busy, error, stale: replaced || current.payloadHash !== sessionSheet.payloadHash || state !== "pending", offline: !controller?.online,
        confirm: () => void decide("assistant.proposal.commit", sessionSheet),
      } : undefined} />}
    {mail && state !== "pending" && <div className="proposal-actions">
      <button type="button" className="secondary-button" onClick={() => setMailSheet({ proposal: current, mode: "view" })}>查看邮件版本</button>
    </div>}
    {mailSheet && "accountKey" in mailSheet.proposal.action && <MailProposalSheet proposal={mailSheet.proposal} action={mailSheet.proposal.action}
      mode={mailSheet.mode} mobile={mobile} stale={replaced || current.revision !== mailSheet.proposal.revision ||
        current.payloadHash !== mailSheet.proposal.payloadHash || state !== "pending"}
      onClose={() => setMailSheet(undefined)} onDone={result => { setOutcome(result); onResult?.(result); }} />}
    {editing && <ProposalEditor proposal={editing} mobile={mobile} stale={replaced || current.revision !== editing.revision || state !== "pending"}
      onClose={() => setEditing(undefined)} onRevised={result => { setOutcome(result); onResult?.(result); }} />}
  </section>;
}

function SessionProposalSheet({ proposal, hostName, mobile, onClose, confirmation }: {
  proposal: BridgeActionProposal; hostName: string; mobile: boolean; onClose(): void;
  confirmation: { busy: boolean; error: string; stale: boolean; offline: boolean; confirm(): void } | undefined;
}) {
  const busy = confirmation?.busy ?? false;
  useEffect(() => {
    if (mobile) return registerMobileBackHandler(() => { if (!busy) onClose(); return true; }, 150);
  }, [mobile, busy, onClose]);
  const { action, sessionTarget, sessionCreateTarget, sessionCreation } = proposal;
  const create = action.kind === "session.create";
  if (!create && (!("targetSessionId" in action) || !sessionTarget)) return null;
  const send = action.kind === "session.send";
  const text = create || send ? action.text : undefined;
  return <Sheet title={create ? confirmation ? "核对新会话" : "新会话提案"
    : confirmation ? send ? "核对会话消息" : "核对目标会话" : "会话消息原文"} fullScreen={mobile} manageFocus busy={busy} onClose={onClose}
    footer={confirmation ? <div className="proposal-actions">
      <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button>
      <button type="button" className="primary-button" disabled={busy || confirmation.stale || confirmation.offline} onClick={confirmation.confirm}>
        {busy ? "处理中…" : create ? text ? "确认新建并发送" : "确认新建会话" : send ? "确认发送消息" : "确认打开会话"}
      </button>
    </div> : text && <div className="proposal-actions"><MessageCopyButton text={text} label="复制消息原文" buttonText="复制原文" /></div>}>
    <div className="session-proposal-review">
      <dl className="proposal-fields">
        <dt>电脑</dt><dd>{hostName}</dd>
        {create ? <>
          {action.title && <><dt>标题</dt><dd>{action.title}</dd></>}
          <dt>工作目录</dt><dd><bdi>{action.cwd}</bdi></dd>
          <dt>分组</dt><dd>{sessionCreateTarget?.projectName}</dd>
          <dt>模型</dt><dd>{sessionCreateTarget?.modelName}</dd>
          {sessionCreation?.sessionId && <><dt>会话 ID</dt><dd><bdi>{sessionCreation.sessionId}</bdi></dd></>}
        </> : <>
          <dt>目标会话</dt><dd>{sessionTarget!.title}</dd>
          <dt>工作目录</dt><dd>{sessionTarget!.cwd}</dd>
          <dt>会话 ID</dt><dd><bdi>{action.targetSessionId}</bdi></dd>
        </>}
        <dt>版本</dt><dd>{proposal.revision}</dd>
      </dl>
      {text !== undefined && <pre aria-label={create ? "完整首条消息" : "完整消息正文"}>{text}</pre>}
      {confirmation && <>
        {!create && <p>{send ? "发送可能启动一轮对话，仍使用目标会话的权限。" : "仅在此客户端打开会话，不发送消息。"}</p>}
        {confirmation.stale && <p role="status">提案已更新或处理。关闭后重新核对。</p>}
        {confirmation.offline && <p role="status">连接电脑后可确认。</p>}
        {confirmation.error && <p role="alert">{confirmation.error}</p>}
      </>}
    </div>
  </Sheet>;
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
        const notes = String(data.get("notes"));
        const sourceId = String(data.get("sourceId"));
        let next: AgendaProposalAction;
        if (action.kind === "calendar.create" || action.kind === "calendar.reschedule") {
          const startAt = allDay ? start : agendaInstant(start, timeZone, action.value.startAt);
          const endAt = allDay ? shiftDate(end, 1) : agendaInstant(end, timeZone, action.value.endAt);
          if (startAt >= endAt) throw new Error("结束时间必须晚于开始时间。");
          const location = String(data.get("location"));
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

  useEffect(() => {
    if (mobile) return registerMobileBackHandler(() => { if (!busy) onClose(); return true; }, 150);
  }, [mobile, busy, onClose]);

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
