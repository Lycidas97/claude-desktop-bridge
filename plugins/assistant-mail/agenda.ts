import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { AgendaTodoInput, BridgeAgendaSnapshot } from "../../packages/protocol/src/assistant-agenda.js";
import { AgendaCalendarDataError, AgendaStore } from "./agenda-store.js";
import { AssistantError } from "./assistant-error.js";
import { CalDavError, readCalDav } from "./caldav.js";
import type { agendaRequests, freeSlotQuery } from "./agenda-contract.js";
import type { z } from "zod";

export interface AgendaCredentials {
  available(): boolean;
  encrypt(value: string): Uint8Array;
  decrypt(value: Uint8Array): string;
}

export class AssistantAgendaService extends EventEmitter {
  private changeToken = randomUUID();
  private recordsToken = randomUUID();
  private timer?: ReturnType<typeof setInterval>;
  private readonly active = new Map<string, { abort: AbortController; task: Promise<void> }>();

  constructor(private readonly store: AgendaStore, private readonly credentials?: AgendaCredentials, private readonly readRemote = readCalDav) { super(); }

  snapshot(): BridgeAgendaSnapshot {
    return { changeToken: this.changeToken, recordsToken: this.recordsToken, credentialsSupported: this.credentials?.available() ?? false, sources: this.store.sources() };
  }

  start() {
    this.resume();
    this.timer = setInterval(() => this.resume(), 15 * 60_000);
    this.timer.unref();
  }

  resume() {
    for (const id of this.store.enabledSourceIds()) void this.refresh(id).catch(error => this.emit("error", error));
  }

  async close() {
    clearInterval(this.timer);
    const jobs = [...this.active.values()];
    for (const job of jobs) job.abort.abort();
    await Promise.allSettled(jobs.map(job => job.task));
  }

  attention(now: number, seen: ReadonlySet<string>) { return this.store.attention(now, seen); }
  listTodos(query: z.output<typeof agendaRequests["plugin.assistant-agenda.todo.list"]>) { return this.store.listTodos(query); }
  listEvents(query: z.output<typeof agendaRequests["plugin.assistant-agenda.event.list"]>) { return this.store.listEvents(query); }
  freeSlots(query: z.output<typeof freeSlotQuery>) { return this.store.freeSlots(query); }

  saveTodo(input: { value: AgendaTodoInput; existing?: { id: string; revision: number } | undefined }) {
    this.store.saveTodo(input.value, input.existing);
    this.changed();
  }

  saveEvent(input: z.output<typeof agendaRequests["plugin.assistant-agenda.event.save"]>) {
    this.store.saveEvent(input.value, input.existing);
    this.changed();
  }

  completeTodo(input: { id: string; revision: number; completed: boolean }) {
    this.store.completeTodo(input);
    this.changed();
  }

  async addSource(input: { url: string; label: string; user: string; credential: string }) {
    const url = new URL(input.url);
    if (url.username || url.password || url.search || url.hash) throw new AssistantError("INVALID_PARAMS", "请输入不含账号、密码或查询参数的日历集合地址。");
    if (!url.pathname.endsWith("/")) url.pathname += "/";
    const id = this.store.addSource({ url: url.href, label: input.label, user: input.user }, this.seal(input.credential));
    this.changed(false);
    await this.refresh(id);
  }

  async setCredential(id: string, credential: string) {
    const source = this.store.source(id);
    this.store.setCredential(id, this.seal(credential));
    this.active.get(id)?.abort.abort();
    this.changed(false);
    if (source.enabled) await this.refresh(id);
  }

  async setEnabled(id: string, enabled: boolean) {
    const source = this.store.source(id);
    if (Boolean(source.enabled) === enabled) return;
    this.active.get(id)?.abort.abort();
    this.store.setEnabled(id, enabled);
    this.changed(false);
    if (enabled) await this.refresh(id);
  }

  removeSource(id: string) {
    this.store.source(id);
    this.active.get(id)?.abort.abort();
    this.store.removeSource(id);
    this.changed();
  }

  async refresh(id: string): Promise<void> {
    const source = this.store.source(id);
    if (!source.enabled) return;
    const active = this.active.get(id);
    if (active) {
      if (!active.abort.signal.aborted) return active.task;
      await active.task;
      if (!this.store.enabledSourceIds().includes(id)) return;
      return this.refresh(id);
    }
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]);
    const task = Promise.resolve().then(async () => {
      let credential: string;
      try {
        if (!source.credential || !this.credentials?.available()) throw new Error("Credentials unavailable");
        credential = this.credentials.decrypt(source.credential);
      } catch {
        if (!abort.signal.aborted) { this.store.markError(id, "credentials"); this.changed(false); }
        return;
      }
      let recordsChanged = false;
      try {
        const delta = await this.readRemote({ url: source.url!, user: source.user!, credential, signal,
          ...(source.ctag ? { ctag: source.ctag } : {}), ...(source.token ? { syncToken: source.token } : {}), knownEtags: this.store.knownEtags(id) });
        if (abort.signal.aborted) return;
        recordsChanged = this.store.applySync(id, delta);
      } catch (error) {
        if (abort.signal.aborted) return;
        if (error instanceof CalDavError) this.store.markError(id, error.code);
        else if (error instanceof AgendaCalendarDataError) this.store.markError(id, "response");
        else throw error;
      }
      this.changed(recordsChanged);
    }).finally(() => this.active.delete(id));
    this.active.set(id, { abort, task });
    return task;
  }

  async proposalChanged(sourceId: string): Promise<void> {
    if (sourceId === "local") { this.changed(); return; }
    await this.active.get(sourceId)?.task;
    if (this.store.enabledSourceIds().includes(sourceId)) await this.refresh(sourceId);
  }

  private seal(credential: string): Uint8Array {
    if (!this.credentials?.available()) throw new AssistantError("UNSUPPORTED", "此电脑没有可用的系统凭据库。");
    try { return this.credentials.encrypt(credential); }
    catch { throw new AssistantError("UNSUPPORTED", "系统凭据库暂不可用。"); }
  }

  private changed(recordsChanged = true) {
    this.changeToken = randomUUID();
    if (recordsChanged) this.recordsToken = randomUUID();
    this.emit("changed", this.snapshot());
  }
}
