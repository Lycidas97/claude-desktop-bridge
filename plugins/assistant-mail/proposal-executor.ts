import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { ASSISTANT_MEMORY_POLICY, ASSISTANT_WORKSPACE_POLICY, type AssistantWorkspacePolicy, type BridgeSmtpChannel } from "../../packages/protocol/src/assistant-mail.js";
import type { AgendaProposalAction, BridgeActionProposal, BridgeProposalSnapshot, MemoryRuleProposalAction, ProposalDraftAction, ProposalRevisionRef } from "../../packages/protocol/src/assistant-proposal.js";
import type { AgendaCredentials } from "./agenda.js";
import { agendaInstant } from "./agenda-time.js";
import type { AssistantMemory } from "./assistant-memory.js";
import { type AgendaStore, LOCAL_AGENDA_ID } from "./agenda-store.js";
import { AssistantError } from "./assistant-error.js";
import { CalDavError, requestCalDavMember } from "./caldav.js";
import { canonicalCalendarBody, proposalCalendarBody } from "./proposal-ical.js";
import { ProposalStore, publicProposal, type ProposalPayload, type StoredProposal } from "./proposal-store.js";
import type { AssistantMailService } from "./desktop.js";
import { freezeMailDraft } from "./proposal-mail.js";
import { submitSmtp, type SmtpResult } from "./smtp.js";

const refOf = ({ proposalId, revision, payloadHash }: ProposalRevisionRef): ProposalRevisionRef => ({ proposalId, revision, payloadHash });

/** Owns the approval boundary. MCP receives only the drafting methods. */
export class ProposalExecutor extends EventEmitter {
  private changeToken = randomUUID();
  private readonly active = new Set<Promise<unknown>>();

  constructor(
    private readonly store: ProposalStore,
    private readonly agenda: AgendaStore,
    private readonly credentials: AgendaCredentials,
    private readonly notifyAgenda: (sourceId: string) => void,
    private readonly memberRequest = requestCalDavMember,
    private readonly mail?: AssistantMailService,
    private readonly send = submitSmtp,
    private readonly profile?: { memory: AssistantMemory; policy(sessionId: string): AssistantWorkspacePolicy | undefined },
  ) { super(); }

  snapshot(): BridgeProposalSnapshot {
    return { changeToken: this.changeToken, ...this.store.pendingCounts(), sources: this.agenda.proposalSources() };
  }

  async create(sessionId: string, action: ProposalDraftAction, assertAuthorized?: () => void): Promise<ProposalRevisionRef> {
    const id = randomUUID();
    const payload = "accountKey" in action ? await freezeMailDraft(this.mailService(), action) : this.freeze(action, id, sessionId);
    assertAuthorized?.();
    const proposal = this.store.insert(sessionId, id, 1, payload);
    this.changed(true);
    return refOf(proposal);
  }

  async revise(ref: ProposalRevisionRef, action: ProposalDraftAction, sessionId?: string, assertAuthorized?: () => void): Promise<BridgeActionProposal> {
    const mailPayload = "accountKey" in action ? await freezeMailDraft(this.mailService(), action) : undefined;
    assertAuthorized?.();
    const proposal = this.store.transaction(() => {
      const current = this.store.requirePending(ref, sessionId);
      if (action.kind !== current.action.kind) throw new AssistantError("INVALID_PARAMS", "不能更改提案的动作类型。");
      const sameRecord = "recordId" in action && "recordId" in current.action && action.recordId === current.action.recordId;
      // A manual field edit keeps the baseline the user reviewed. A model revision can re-read it.
      const payload = mailPayload ?? this.freeze(action as AgendaProposalAction | MemoryRuleProposalAction, current.proposalId, current.sessionId,
        sessionId === undefined && (sameRecord || action.kind === "memory.rule_upsert") ? current : undefined);
      return this.store.insert(current.sessionId, current.proposalId, current.revision + 1, { ...payload,
        ...(sessionId === undefined ? { nativeRevision: current.nativeRevision ?? current.revision } : {}),
      });
    });
    this.changed();
    return publicProposal(proposal);
  }

  async reviseFromTool(sessionId: string, ref: ProposalRevisionRef, action: ProposalDraftAction, assertAuthorized: () => void): Promise<ProposalRevisionRef> {
    return refOf(await this.revise(ref, action, sessionId, assertAuthorized));
  }

  smtpAccounts() {
    return this.mail?.status().accounts.flatMap(account => account.enabled && account.smtp ? [{ accountKey: account.accountKey, from: account.smtp.from }] : []) ?? [];
  }

  page(query: Parameters<ProposalStore["page"]>[0], sessionId?: string) {
    return this.store.page(sessionId === undefined ? query : { ...query, includeMemory: this.profile?.policy(sessionId) === ASSISTANT_MEMORY_POLICY }, sessionId);
  }
  resolve(...params: Parameters<ProposalStore["resolve"]>) { return this.store.resolve(...params); }
  pending(ref: ProposalRevisionRef, sessionId?: string) { return publicProposal(this.store.requirePending(ref, sessionId)); }

  dismiss(ref: ProposalRevisionRef & { includeMemory?: true | undefined }, actor: string) {
    const proposal = this.store.transaction(() => {
      const proposal = this.store.requirePending(ref);
      if (proposal.intent.backend === "profile" && !ref.includeMemory) throw new AssistantError("NOT_FOUND", "找不到此提案。");
      this.store.claim(proposal, actor, "dismissed");
      return publicProposal({ ...proposal, state: "dismissed" });
    });
    this.changed();
    return proposal;
  }

  async commit(ref: ProposalRevisionRef & { confirmMail?: true | undefined; confirmMemory?: true | undefined }, actor: string): Promise<BridgeActionProposal> {
    const claimed = this.store.transaction(() => {
      const proposal = this.store.requirePending(ref);
      if (proposal.intent.backend === "profile" && !ref.confirmMemory) {
        throw new AssistantError("INVALID_PARAMS", "请在支持规则提案的 Bridge 中核对并确认变更。");
      }
      if (proposal.intent.backend === "smtp" && "accountKey" in proposal.action) {
        if (!ref.confirmMail) throw new AssistantError("INVALID_PARAMS", "请在发信确认抽屉中核对并发送。");
        const account = this.mailService().smtpAccount(proposal.action.accountKey);
        if (!account || account.smtp.version !== proposal.intent.channelVersion) {
          throw new AssistantError("CONFLICT", "发信账号已更改或停用。请调整提案后重新核对。");
        }
        const messageId = `<${proposal.proposalId}.${proposal.revision}@${proposal.action.from.split("@")[1]}>`;
        this.store.claim(proposal, actor, "executing", messageId);
        return { proposal, smtp: account.smtp, messageId };
      }
      this.store.claim(proposal, actor, "executing");
      return { proposal, localResult: proposal.intent.backend === "local" ? this.applyLocal(proposal, proposal.intent.baseRevision) : undefined };
    });
    this.changed();
    if (claimed.smtp) {
      // The approval acknowledgment must not wait for the SMTP server's final response.
      void this.track(this.applySmtp(claimed.proposal, claimed.smtp, claimed.messageId)).catch(error => this.emit("error", error));
      return publicProposal({ ...claimed.proposal, state: "executing" });
    }
    if (claimed.localResult) {
      if (claimed.localResult.state === "applied") this.notifyAgenda(LOCAL_AGENDA_ID);
      return claimed.localResult;
    }
    const { proposal } = claimed;
    if (proposal.intent.backend === "profile") {
      // Claim and expected hash are durable before touching the file. Keep the local compare
      // and rename synchronous so two approvals in this process cannot share a baseline.
      const policy = this.profile?.policy(proposal.sessionId);
      const state = policy ? this.profile!.memory.apply(proposal.intent, policy === ASSISTANT_WORKSPACE_POLICY) : "conflict";
      const result = this.store.finish(proposal, state);
      this.changed();
      return result;
    }
    return this.track(this.applyRemote(proposal));
  }

  start(): void {
    for (const proposal of this.store.interrupted()) void this.track(this.recover(proposal)).catch(error => this.emit("error", error));
  }

  async close(): Promise<void> { await Promise.allSettled(this.active); }

  private async track<T>(job: Promise<T>): Promise<T> {
    this.active.add(job);
    try { return await job; }
    finally { this.active.delete(job); }
  }

  private mailService(): AssistantMailService {
    if (!this.mail) throw new AssistantError("UNSUPPORTED", "当前宿主未启用发信提案。");
    return this.mail;
  }

  private async applySmtp(proposal: StoredProposal, channel: BridgeSmtpChannel & { version: string }, messageId: string) {
    if (!("accountKey" in proposal.action)) throw new Error("Expected an SMTP proposal");
    const password = await this.mailService().smtpPassword(proposal.action.accountKey, channel.version);
    return this.finishSmtp(proposal, password ? await this.send(channel, password, proposal.action, messageId)
      : { state: "failed", failure: { reason: "credential" } });
  }

  private finishSmtp(proposal: StoredProposal, result: SmtpResult) {
    const finished = this.store.finishSmtp(proposal, result);
    this.changed();
    return finished;
  }

  private freeze(action: AgendaProposalAction | MemoryRuleProposalAction, proposalId: string, sessionId: string, keepBase?: StoredProposal): ProposalPayload {
    if (action.kind === "memory.rule_upsert") {
      const policy = this.profile?.policy(sessionId);
      if (!policy) throw new AssistantError("UNSUPPORTED", "当前托管会话的规则文件不可用。");
      const frozen = this.profile!.memory.freeze(action, policy === ASSISTANT_WORKSPACE_POLICY);
      if (keepBase && frozen.intent.baseProfileSha256 !== keepBase.profile?.baseProfileSha256) {
        throw new AssistantError("CONFLICT", "PROFILE.md 已变更，请让助理重新核对。");
      }
      return { action, sourceId: "profile", sourceLabel: "助理规则", ...frozen };
    }
    const kind = action.kind.startsWith("todo.") ? "todo" : "calendar";
    const record = "recordId" in action ? this.agenda.proposalRecord(kind, action.recordId) : undefined;
    const sourceId = record?.sourceId ?? ("sourceId" in action ? action.sourceId : LOCAL_AGENDA_ID);
    const source = sourceId === LOCAL_AGENDA_ID ? undefined : this.agenda.source(sourceId);
    if (source && (!source.enabled || (!record && !this.agenda.proposalSources().some(s => s.id === sourceId && s.kinds.includes(kind))))) {
      throw new AssistantError("UNSUPPORTED", "此来源当前不能写入这种记录。");
    }
    if (keepBase && (record?.revision !== (keepBase.intent.backend === "local" ? keepBase.intent.baseRevision : 1) ||
      (keepBase.intent.backend === "caldav" && record?.etag !== keepBase.intent.write.etag))) {
      throw new AssistantError("CONFLICT", "目标记录已更新，请让助理重新核对。");
    }
    const before = record && (({ id: _id, sourceId: _source, revision: _revision, uid: _uid, collection: _collection,
      etag: _etag, resourceHref: _href, recurrenceId: _recurrence, origin: _origin, ...value }) => value)(record);
    const base = { action, sourceId, sourceLabel: source?.label ?? "本地", ...(before ? { before } : {}) };
    if (!source) return { ...base, intent: { backend: "local", ...(record ? { baseRevision: record.revision } : {}) } };

    const collection = source.url!;
    if (!record) return { ...base, intent: { backend: "caldav", collection,
      write: { method: "PUT", href: new URL(`${proposalId}.ics`, collection).href, body: proposalCalendarBody(action, proposalId) } } };
    const etag = record.etag;
    const href = record.resourceHref!;
    const object = this.agenda.proposalObject(sourceId, href);
    if (!object || object.recurring || record.recurrenceId) throw new AssistantError("UNSUPPORTED", "暂不支持修改或删除重复日历实例。");
    if (!etag || !/^"[^"\r\n]*"$/u.test(etag)) throw new AssistantError("UNSUPPORTED", "此来源没有可用于条件写入的版本。" );
    const body = proposalCalendarBody(action, record.uid, { body: object.data, value: before! });
    return { ...base, intent: { backend: "caldav", collection,
      write: action.kind === "calendar.delete" ? { method: "DELETE", href, etag } : { method: "PUT", href, etag, body } } };
  }

  private applyLocal(proposal: StoredProposal, baseRevision: number | undefined) {
    const { action } = proposal;
    try {
      switch (action.kind) {
        case "todo.create": this.agenda.saveTodo(action.value); break;
        case "todo.update": this.agenda.saveTodo(action.value, { id: action.recordId, revision: baseRevision! }); break;
        case "todo.complete": this.agenda.completeTodo({ id: action.recordId, revision: baseRevision!, completed: true }); break;
        case "calendar.create": this.agenda.saveEvent(action.value); break;
        case "calendar.reschedule": {
          const event = this.agenda.proposalRecord("calendar", action.recordId);
          const value = action.value;
          const remindAt = event.remindAt && "startAt" in event ? new Date(Date.parse(event.remindAt)
            + agendaInstant(value.startAt, value.timeZone) - agendaInstant(event.startAt, event.timeZone)).toISOString() : undefined;
          this.agenda.saveEvent({ ...value, remindAt }, { id: action.recordId, revision: baseRevision! });
          break;
        }
        case "calendar.delete": this.agenda.deleteLocalEvent(action.recordId, baseRevision!); break;
      }
    } catch (error) {
      if (error instanceof AssistantError && (error.code === "CONFLICT" || error.code === "NOT_FOUND")) return this.store.finish(proposal, "conflict");
      throw error;
    }
    return this.store.finish(proposal, "applied");
  }

  private remoteCredentials(proposal: StoredProposal, collection: string) {
    let source;
    try { source = this.agenda.source(proposal.sourceId); }
    catch (error) { if (error instanceof AssistantError && error.code === "NOT_FOUND") return; throw error; }
    if (!source.enabled || source.url !== collection || !source.credential || !this.credentials.available()) return;
    let credential;
    try { credential = this.credentials.decrypt(source.credential); }
    catch { return; } // An unavailable platform credential never starts a network write.
    return { url: collection, user: source.user!, credential };
  }

  private async applyRemote(proposal: StoredProposal): Promise<BridgeActionProposal> {
    const { intent } = proposal;
    if (intent.backend !== "caldav") throw new Error("Expected a CalDAV proposal");
    const credentials = this.remoteCredentials(proposal, intent.collection);
    if (!credentials) return this.finishRemote(proposal, "failed");
    let status: number;
    try { ({ status } = await this.memberRequest({ ...credentials, request: intent.write })); }
    catch (error) {
      if (error instanceof CalDavError) return error.code === "connection" ? this.recover(proposal) : this.finishRemote(proposal, "failed");
      throw error;
    }
    if (status === 412 || (status === 404 && intent.write.etag !== undefined)) return this.finishRemote(proposal, "conflict");
    if (status === 202 || status >= 500) return this.recover(proposal);
    return this.finishRemote(proposal, status >= 200 && status < 300 ? "applied" : "failed");
  }

  private async recover(proposal: StoredProposal): Promise<BridgeActionProposal> {
    const { intent } = proposal;
    if (intent.backend === "profile") {
      if (!this.profile) throw new Error("Profile recovery requires the managed workspace");
      const result = this.store.finish(proposal, this.profile.memory.reconcile(intent));
      this.changed();
      return result;
    }
    if (intent.backend === "smtp") return this.finishSmtp(proposal, { state: "delivery_uncertain", failure: { reason: "interrupted" } });
    if (intent.backend !== "caldav") throw new Error("A local proposal cannot have an interrupted execution");
    const credentials = this.remoteCredentials(proposal, intent.collection);
    if (!credentials) return this.finishRemote(proposal, "uncertain");
    let result;
    try { result = await this.memberRequest({ ...credentials, request: { method: "GET", href: intent.write.href } }); }
    catch (error) {
      if (error instanceof CalDavError) return this.finishRemote(proposal, "uncertain");
      throw error;
    }
    const verified = intent.write.method === "DELETE" ? result.status === 404
      : result.status === 200 && result.body !== undefined && this.matchesCalendar(result.body, intent.write.body);
    return this.finishRemote(proposal, verified ? "applied" : "uncertain");
  }

  private matchesCalendar(received: string, intended: string): boolean {
    // A server may rewrite the resource or return non-calendar content. Neither proves this attempt.
    let parsed: string;
    try { parsed = canonicalCalendarBody(received); }
    catch { return false; }
    return parsed === canonicalCalendarBody(intended);
  }

  private finishRemote(proposal: StoredProposal, state: "applied" | "conflict" | "failed" | "uncertain") {
    const result = this.store.finish(proposal, state);
    this.changed();
    if (state !== "failed") this.notifyAgenda(proposal.sourceId);
    return result;
  }

  private changed(wake = false) {
    this.changeToken = randomUUID();
    this.emit("changed", this.snapshot(), wake);
  }
}
