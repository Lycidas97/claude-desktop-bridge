import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FetchMessageObject, ImapFlow } from "imapflow";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AssistantMailService } from "./desktop.js";
import { AssistantMailStore } from "./store.js";

class Inbox extends EventEmitter {
  capabilities = new Map([["IDLE", true]]);
  enabled = new Set<string>();
  fetchOne = vi.fn(async (uid: string) => this.messages.find(message => message.uid === Number(uid)) ?? false);
  uidValidity = 1n;
  uidNext = 5;
  messages: FetchMessageObject[] = [];
  scans: string[] = [];
  afterFetch: (() => void) | undefined;
  finishIdle: (() => void) | undefined;
  connect = vi.fn(async () => {});
  mailboxOpen = vi.fn(async () => ({ uidValidity: this.uidValidity, uidNext: this.uidNext }));
  noop = vi.fn(async () => { this.finishIdle?.(); });
  idle = vi.fn(() => new Promise<void>(resolve => { this.finishIdle = resolve; }));
  close = vi.fn(() => { this.finishIdle?.(); this.emit("close"); });

  async *fetch(range: string) {
    this.scans.push(range);
    const start = Number(range.split(":")[0]);
    const selected = this.messages.filter(message => message.uid >= start);
    for (const message of selected.length ? selected : this.messages.slice(-1)) yield message;
    this.afterFetch?.();
  }

  deliver(uid: number) {
    this.messages.push({ uid, seq: this.messages.length + 1, source: Buffer.from(`Subject: message ${uid}\r\n\r\nbody`),
      envelope: { subject: `message ${uid}`, from: [{ address: "sender@example.test" }] }, internalDate: new Date("2026-11-14T12:00:00Z") });
    this.uidNext = uid + 1;
    this.emit("exists", { count: this.messages.length });
  }
}

let root: string;
const services: AssistantMailService[] = [];
let secrets: Map<string, string>;
const account = { host: "imap.example.test", user: "test@example.test", password: "private-password" };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "assistant-mail-service-"));
  secrets = new Map();
});

afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

async function createService(inboxes: Inbox[] = [new Inbox()], supported = true) {
  const createClient = vi.fn(() => inboxes.shift()! as unknown as ImapFlow);
  const credentials = { supported,
    get: vi.fn(async (key: string) => secrets.get(key)),
    set: vi.fn(async (key: string, password: string) => { secrets.set(key, password); }),
  };
  const service = new AssistantMailService({ userDataPath: root, createClient, credentials });
  services.push(service);
  await service.initialize();
  return { service, createClient, credentials };
}

it("keeps one background receiver independent of readers, skips old tail UIDs and persists new mail", async () => {
  const inbox = new Inbox();
  inbox.deliver(4);
  const { service, createClient } = await createService([inbox]);
  expect(createClient).not.toHaveBeenCalled();
  await service.enable(account);
  await vi.waitFor(() => expect(inbox.idle).toHaveBeenCalledOnce());
  expect(service.page().events).toEqual([]);
  inbox.deliver(5);
  await vi.waitFor(() => expect(service.page().events).toHaveLength(1));
  const event = service.page().events[0]!;
  await Promise.all([service.read(event.mailRefId), service.read(event.mailRefId)]);
  service.page(); service.page();
  expect(createClient).toHaveBeenCalledOnce();
  expect(createClient.mock.calls[0]).toEqual([expect.objectContaining({ secure: true, logger: false, logRaw: false, emitLogs: false, disableAutoIdle: true })]);
  expect(inbox.mailboxOpen).toHaveBeenCalledExactlyOnceWith("INBOX", { readOnly: true });
  expect((await service.read(event.mailRefId))?.source).toEqual(inbox.messages[1]!.source);
  expect(JSON.stringify(service.status())).not.toContain(account.password);
  const config = await readFile(join(root, "private", "assistant", "account.json"), "utf8");
  expect(config).not.toContain(account.password);
  if (process.platform !== "win32") expect((await stat(join(root, "private", "assistant", "account.json"))).mode & 0o777).toBe(0o600);
});

it("persists all new UIDs even when FETCH responses arrive out of order", async () => {
  const inbox = new Inbox();
  const { service } = await createService([inbox]);
  await service.enable(account);
  await vi.waitFor(() => expect(inbox.idle).toHaveBeenCalledOnce());
  inbox.deliver(6); inbox.deliver(5);
  await vi.waitFor(() => expect(inbox.idle).toHaveBeenCalledTimes(2));
  expect(service.page().events.map(event => event.uid)).toEqual([6, 5]);
});

it("does not advance past an uncommitted lower UID when unordered mail encounters a write failure", async () => {
  const inbox = new Inbox();
  const recovered = new Inbox();
  const { service } = await createService([inbox, recovered]);
  const onError = vi.fn();
  service.on("error", onError);
  await service.enable(account);
  await vi.waitFor(() => expect(inbox.idle).toHaveBeenCalledOnce());
  const record = AssistantMailStore.prototype.record;
  vi.spyOn(AssistantMailStore.prototype, "record").mockImplementation(async function (this: AssistantMailStore, message) {
    if (message.uid === 6) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    return record.call(this, message);
  });
  inbox.deliver(6); inbox.deliver(5);
  await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
  expect(service.page().events.map(event => event.uid)).toEqual([5]);
  vi.restoreAllMocks();
  await service.disable();
  recovered.deliver(6); recovered.deliver(5);
  await service.enable(account);
  await vi.waitFor(() => expect(service.page().events.map(event => event.uid)).toEqual([6, 5]));
  expect(recovered.scans[0]).toBe("6:*");
});

it("keeps the healthy receiver running when new credentials cannot be saved", async () => {
  const inbox = new Inbox();
  const { service, credentials, createClient } = await createService([inbox]);
  await service.enable(account);
  await vi.waitFor(() => expect(inbox.idle).toHaveBeenCalledOnce());
  credentials.set.mockRejectedValueOnce(new Error("mail_credentials_unavailable"));
  await expect(service.enable({ ...account, password: "replacement" })).rejects.toThrow("mail_credentials_unavailable");
  expect(inbox.close).not.toHaveBeenCalled();
  expect(service.status().state).toBe("connected");
  inbox.deliver(5);
  await vi.waitFor(() => expect(service.page().events.map(event => event.uid)).toEqual([5]));
  expect(createClient).toHaveBeenCalledOnce();
});

it.each([false, true])("accepts active IMAP4rev2 semantics with dual revision advertisement=%s", async dualRevision => {
  const inbox = new Inbox();
  inbox.capabilities = new Map([["IMAP4rev2", true]]);
  if (dualRevision) { inbox.capabilities.set("IMAP4rev1", true); inbox.enabled.add("IMAP4REV2"); }
  const { service } = await createService([inbox]);
  await service.enable(account);
  await vi.waitFor(() => expect(service.status().state).toBe("connected"));
  expect(inbox.mailboxOpen).toHaveBeenCalledOnce();
});

it("retains an EXISTS notification arriving during a fetch without launching parallel scans", async () => {
  const inbox = new Inbox();
  const { service } = await createService([inbox]);
  await service.enable(account);
  await vi.waitFor(() => expect(inbox.idle).toHaveBeenCalledOnce());
  inbox.afterFetch = () => { inbox.afterFetch = undefined; inbox.deliver(6); };
  inbox.deliver(5);
  await vi.waitFor(() => expect(service.page().events.map(event => event.uid)).toEqual([6, 5]));
  expect(inbox.scans).toContain("6:*");
});

it("reconnects with a fresh client and committed watermark, then resumes again after service restart", async () => {
  vi.useFakeTimers();
  const first = new Inbox();
  const second = new Inbox();
  const { service, createClient } = await createService([first, second]);
  await service.enable(account);
  await vi.waitFor(() => expect(first.idle).toHaveBeenCalledOnce());
  first.deliver(5);
  await vi.waitFor(() => expect(service.page().events).toHaveLength(1));
  second.deliver(5); second.deliver(6);
  first.close();
  await vi.waitFor(() => expect(service.status().state).toBe("reconnecting"));
  await vi.advanceTimersByTimeAsync(5_000);
  await vi.waitFor(() => expect(service.page().events.map(event => event.uid)).toEqual([6, 5]));
  expect(createClient).toHaveBeenCalledTimes(2);
  expect(second.scans[0]).toBe("6:*");
  await service.close();
  services.splice(services.indexOf(service), 1);
  const third = new Inbox();
  third.deliver(6); third.deliver(7);
  const restarted = await createService([third]);
  await vi.waitFor(() => expect(restarted.service.page().events.map(event => event.uid)).toEqual([7, 6, 5]));
  expect(third.scans[0]).toBe("7:*");
});

it("rebases UIDVALIDITY without confusing new and old identities", async () => {
  vi.useFakeTimers();
  const first = new Inbox();
  const nextGeneration = new Inbox();
  nextGeneration.uidValidity = 2n;
  nextGeneration.uidNext = 3;
  const { service } = await createService([first, nextGeneration]);
  await service.enable(account);
  await vi.waitFor(() => expect(first.idle).toHaveBeenCalledOnce());
  first.deliver(5);
  await vi.waitFor(() => expect(service.page().events).toHaveLength(1));
  first.close();
  await vi.waitFor(() => expect(service.status().state).toBe("reconnecting"));
  await vi.advanceTimersByTimeAsync(5_000);
  await vi.waitFor(() => expect(nextGeneration.idle).toHaveBeenCalledOnce());
  nextGeneration.deliver(5);
  await vi.waitFor(() => expect(service.page().events.map(event => event.uidValidity)).toEqual(["2", "1"]));
});

it("refuses IDLE-less servers without a polling fallback", async () => {
  const inbox = new Inbox();
  inbox.capabilities.clear();
  const { service } = await createService([inbox]);
  await service.enable(account);
  await vi.waitFor(() => expect(service.status()).toMatchObject({ state: "unsupported", errorCode: "mail_idle_unsupported" }));
  expect(inbox.mailboxOpen).not.toHaveBeenCalled();
  expect(inbox.idle).not.toHaveBeenCalled();
  expect(inbox.noop).not.toHaveBeenCalled();
});

it("stops when an advertised IDLE command is refused", async () => {
  const inbox = new Inbox();
  inbox.idle.mockImplementationOnce(() => Promise.resolve(false) as unknown as Promise<void>);
  const { service, createClient } = await createService([inbox]);
  await service.enable(account);
  await vi.waitFor(() => expect(service.status()).toMatchObject({ state: "unsupported", errorCode: "mail_idle_unsupported" }));
  expect(createClient).toHaveBeenCalledOnce();
  expect(inbox.idle).toHaveBeenCalledOnce();
});

it("reports a storage failure once and allows explicit disable and re-enable after storage recovers", async () => {
  const inbox = new Inbox();
  const recovered = new Inbox();
  const { service, createClient } = await createService([inbox, recovered]);
  const failure = Object.assign(new Error("disk full"), { code: "ENOSPC" });
  const onError = vi.fn();
  service.on("error", onError);
  await service.enable(account);
  await vi.waitFor(() => expect(inbox.idle).toHaveBeenCalledOnce());
  vi.spyOn(AssistantMailStore.prototype, "record").mockRejectedValueOnce(failure);
  inbox.deliver(5);
  await vi.waitFor(() => expect(onError).toHaveBeenCalledExactlyOnceWith(failure));
  expect(service.status()).toMatchObject({ state: "error", errorCode: "mail_storage_failed" });
  expect(service.page().events).toEqual([]);
  expect(createClient).toHaveBeenCalledOnce();
  await expect(service.disable()).resolves.toBeUndefined();
  expect(service.status().state).toBe("disabled");
  await service.enable(account);
  await vi.waitFor(() => expect(recovered.idle).toHaveBeenCalledOnce());
  recovered.deliver(5);
  await vi.waitFor(() => expect(service.page().events.map(event => event.uid)).toEqual([5]));
  expect(createClient).toHaveBeenCalledTimes(2);
  expect(onError).toHaveBeenCalledOnce();
});

it("shows fixed connection errors without exposing server diagnostics or credentials", async () => {
  const inbox = new Inbox();
  inbox.connect.mockRejectedValueOnce(new Error(`AUTH failed: ${account.password}`));
  const { service } = await createService([inbox]);
  await service.enable(account);
  await vi.waitFor(() => expect(service.status()).toMatchObject({ state: "reconnecting", errorCode: "mail_connection_failed" }));
  expect(JSON.stringify(service.status())).not.toContain(account.password);
  await service.disable();
  expect(service.status().state).toBe("disabled");
});

it("stops the receiver on disable and does not restart it when the service is recreated", async () => {
  const inbox = new Inbox();
  const { service } = await createService([inbox]);
  await service.enable(account);
  await vi.waitFor(() => expect(inbox.idle).toHaveBeenCalledOnce());
  await service.disable();
  expect(inbox.close).toHaveBeenCalled();
  expect(service.status()).toMatchObject({ state: "disabled", account: { enabled: false } });
  await service.close();
  services.splice(services.indexOf(service), 1);
  const restarted = await createService();
  expect(restarted.createClient).not.toHaveBeenCalled();
});

it("rejects unsupported platform credentials before connecting or writing account configuration", async () => {
  const { service, createClient } = await createService([], false);
  await expect(service.enable(account)).rejects.toThrow("mail_credentials_unsupported");
  expect(createClient).not.toHaveBeenCalled();
  await expect(readFile(join(root, "private", "assistant", "account.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("exposes numeric unread gauges without leaking account addresses, passwords, or mail contents", async () => {
  const inbox = new Inbox();
  const { service } = await createService([inbox]);
  expect(service.diagnosticsGauges()).toEqual({ configured: false, unreadCount: 0 });
  await service.enable(account);
  await vi.waitFor(() => expect(inbox.idle).toHaveBeenCalledOnce());
  inbox.deliver(5);
  inbox.deliver(6);
  await vi.waitFor(() => expect(service.page().events).toHaveLength(2));
  expect(service.diagnosticsGauges()).toEqual({ configured: true, unreadCount: 2 });
  const firstRef = service.page().events[0]!.mailRefId;
  service.setProcessingStatus(firstRef, "processed");
  expect(service.diagnosticsGauges()).toEqual({ configured: true, unreadCount: 1 });
  expect(JSON.stringify(service.diagnosticsGauges())).not.toMatch(/example\.test|private-password|message 5|message 6/);
});
