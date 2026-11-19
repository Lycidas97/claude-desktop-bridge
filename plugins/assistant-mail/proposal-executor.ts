import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { AssistantProposalAction, BridgeActionProposal, BridgeProposalSnapshot, ProposalRevisionRef } from "../../packages/protocol/src/assistant-proposal.js";
import type { AgendaCredentials } from "./agenda.js";
import type { AssistantMemory } from "./assistant-memory.js";
import { AgendaEditError, type AgendaStore, LOCAL_AGENDA_ID } from "./agenda-store.js";
import { CalDavError, requestCalDavMember } from "./caldav.js";
import { canonicalCalendarBody, proposalCalendarBody } from "./proposal-ical.js";
import { ProposalStore, publicProposal, type ProposalPayload, type StoredProposal } from "./proposal-store.js";

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
    private readonly profile?: { memory: AssistantMemory; allowed(sessionId: string): boolean },
  ) { super(); }

  snapshot(): BridgeProposalSnapshot {
    return { changeToken: this.changeToken, pendingCount: this.store.pendingCount(), sources: this.agenda.proposalSources() };
  }

  create(sessionId: string, action: AssistantProposalAction): ProposalRevisionRef {
    const id = randomUUID();
    const proposal = this.store.insert(sessionId, id, 1, this.freeze(action, id, sessionId));
    this.changed(true);
    return refOf(proposal);
  }

  revise(ref: ProposalRevisionRef, action: AssistantProposalAction, sessionId?: string): BridgeActionProposal {
    const proposal = this.store.transaction(() => {
      const current = this.store.requirePending(ref, sessionId);
      if (action.kind !== current.action.kind) throw new AgendaEditError("INVALID_PARAMS", "不能更改提案的动作类型。");
      const sameRecord = "recordId" in action && "recordId" in current.action && action.recordId === current.action.recordId;
      // A manual field edit keeps the baseline the user reviewed. A model revision can re-read it.
      const payload = this.freeze(action, current.proposalId, current.sessionId,
        sessionId === undefined && (sameRecord || action.kind === "memory.rule_upsert") ? current : undefined);
      return this.store.insert(current.sessionId, current.proposalId, current.revision + 1, { ...payload,
        ...(sessionId === undefined ? { nativeRevision: current.nativeRevision ?? current.revision } : {}),
      });
    });
    this.changed();
    return publicProposal(proposal);
  }

  reviseFromTool(sessionId: string, ref: ProposalRevisionRef, action: AssistantProposalAction): ProposalRevisionRef {
    return refOf(this.revise(ref, action, sessionId));
  }

  page(query: Parameters<ProposalStore["page"]>[0], sessionId?: string) { return this.store.page(query, sessionId); }
  resolve(sessionId: string, refs: ProposalRevisionRef[], latestForReview?: boolean) { return this.store.resolve(sessionId, refs, latestForReview); }
  pending(ref: ProposalRevisionRef, sessionId?: string) { return publicProposal(this.store.requirePending(ref, sessionId)); }

  dismiss(ref: ProposalRevisionRef, actor: string) {
    const proposal = this.store.transaction(() => {
      const proposal = this.store.requirePending(ref);
      this.store.claim(proposal, actor, "dismissed");
      return publicProposal({ ...proposal, state: "dismissed" });
    });
    this.changed();
    return proposal;
  }

  async commit(ref: ProposalRevisionRef, actor: string): Promise<BridgeActionProposal> {
    const { proposal, localResult } = this.store.transaction(() => {
      const proposal = this.store.requirePending(ref);
      this.store.claim(proposal, actor, "executing");
      return { proposal, localResult: proposal.intent.backend === "local" ? this.applyLocal(proposal, proposal.intent.baseRevision) : undefined };
    });
    this.changed();
    if (localResult) {
      if (localResult.state === "applied") this.notifyAgenda(LOCAL_AGENDA_ID);
      return localResult;
    }
    if (proposal.intent.backend === "profile") {
      // Claim and expected hash are durable before touching the file. Keep the local compare
      // and rename synchronous so two approvals in this process cannot share a baseline.
      const state = this.profile?.allowed(proposal.sessionId) ? this.profile.memory.apply(proposal.intent) : "conflict";
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

  private freeze(action: AssistantProposalAction, proposalId: string, sessionId: string, keepBase?: StoredProposal): ProposalPayload {
    if (action.kind === "memory.rule_upsert") {
      if (!this.profile?.allowed(sessionId)) throw new AgendaEditError("UNSUPPORTED", "此会话未启用受控记忆。");
      const frozen = this.profile.memory.freeze(action);
      if (keepBase && frozen.intent.baseProfileSha256 !== keepBase.profile?.baseProfileSha256) {
        throw new AgendaEditError("CONFLICT", "PROFILE.md 已变更，请让助理重新核对。");
      }
      return { action, sourceId: "profile", sourceLabel: "助理规则", ...frozen };
    }
    const kind = action.kind.startsWith("todo.") ? "todo" : "calendar";
    const record = "recordId" in action ? this.agenda.proposalRecord(kind, action.recordId) : undefined;
    const sourceId = record?.sourceId ?? ("sourceId" in action ? action.sourceId : LOCAL_AGENDA_ID);
    const source = sourceId === LOCAL_AGENDA_ID ? undefined : this.agenda.source(sourceId);
    if (source && (!source.enabled || (!record && !this.agenda.proposalSources().some(s => s.id === sourceId && s.kinds.includes(kind))))) {
      throw new AgendaEditError("UNSUPPORTED", "此来源当前不能写入这种记录。");
    }
    if (keepBase && (record?.revision !== (keepBase.intent.backend === "local" ? keepBase.intent.baseRevision : 1) ||
      (keepBase.intent.backend === "caldav" && record?.etag !== keepBase.intent.write.etag))) {
      throw new AgendaEditError("CONFLICT", "目标记录已更新，请让助理重新核对。");
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
    if (!object || object.recurring || record.recurrenceId) throw new AgendaEditError("UNSUPPORTED", "暂不支持修改或删除重复日历实例。");
    if (!etag || !/^"[^"\r\n]*"$/u.test(etag)) throw new AgendaEditError("UNSUPPORTED", "此来源没有可用于条件写入的版本。" );
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
        case "calendar.reschedule": this.agenda.saveEvent(action.value, { id: action.recordId, revision: baseRevision! }); break;
        case "calendar.delete": this.agenda.deleteLocalEvent(action.recordId, baseRevision!); break;
      }
    } catch (error) {
      if (error instanceof AgendaEditError && (error.code === "CONFLICT" || error.code === "NOT_FOUND")) return this.store.finish(proposal, "conflict");
      throw error;
    }
    return this.store.finish(proposal, "applied");
  }

  private remoteCredentials(proposal: StoredProposal, collection: string) {
    let source;
    try { source = this.agenda.source(proposal.sourceId); }
    catch (error) { if (error instanceof AgendaEditError && error.code === "NOT_FOUND") return; throw error; }
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
