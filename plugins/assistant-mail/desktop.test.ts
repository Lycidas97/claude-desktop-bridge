import { createHash } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { ImapFlow, type FetchMessageObject } from "imapflow";
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
    delete: vi.fn(async (key: string) => { secrets.delete(key); }),
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
  const config = await readFile(join(root, "private", "assistant", "accounts.json"), "utf8");
  expect(config).not.toContain(account.password);
  if (process.platform !== "win32") expect((await stat(join(root, "private", "assistant", "accounts.json"))).mode & 0o777).toBe(0o600);
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
  await vi.waitFor(() => expect(second.idle).toHaveBeenCalledOnce());
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

async function waitForMailState(service: AssistantMailService, state: ReturnType<AssistantMailService["status"]>["state"]) {
  while (service.status().state !== state) await once(service, "changed");
}

it("polls for new mail by default when the server does not advertise IDLE", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const inbox = new Inbox();
  const recovered = new Inbox();
  inbox.capabilities.clear();
  recovered.capabilities.clear();
  inbox.deliver(4);
  const { service, createClient } = await createService([inbox, recovered]);
  await service.enable(account);
  await waitForMailState(service, "polling");
  inbox.deliver(5);
  await vi.advanceTimersByTimeAsync(59_999);
  expect(inbox.scans).toEqual(["5:*"]);
  expect(service.page().events).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  await vi.waitFor(() => expect(service.page().events.map(event => event.uid)).toEqual([5]));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(service.page().events.map(event => event.uid)).toEqual([5]);
  expect(inbox.fetchOne).toHaveBeenCalledOnce();

  inbox.uidValidity = 2n;
  inbox.messages = [];
  inbox.deliver(4);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(service.page().events.map(event => event.uidValidity)).toEqual(["1"]);
  inbox.deliver(5);
  await vi.advanceTimersByTimeAsync(60_000);
  await vi.waitFor(() => expect(service.page().events.map(event => [event.uidValidity, event.uid])).toEqual([["2", 5], ["1", 5]]));
  expect(inbox.mailboxOpen).toHaveBeenLastCalledWith("INBOX", { readOnly: true });
  expect(inbox.idle).not.toHaveBeenCalled();
  expect(createClient).toHaveBeenCalledOnce();

  recovered.uidValidity = 2n;
  recovered.deliver(5);
  recovered.deliver(6);
  inbox.close();
  await waitForMailState(service, "reconnecting");
  expect(service.status().errorCode).toBe("mail_connection_failed");
  await vi.advanceTimersByTimeAsync(4_999);
  expect(createClient).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  await vi.waitFor(() => expect(service.page().events.map(event => event.uid)).toEqual([6, 5, 5]));
  expect(service.status().state).toBe("polling");
});

it("saves separate polling intervals, applies them to active receivers and restores them after restart", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const inbox = new Inbox();
  const peer = new Inbox();
  inbox.capabilities.clear();
  peer.capabilities.clear();
  const { service, createClient, credentials } = await createService([inbox, peer]);
  await service.enable(account);
  await service.enable({ ...account, user: "peer@example.test" });
  await vi.waitFor(() => expect(service.status().accounts.map(account => account.state)).toEqual(["polling", "polling"]));
  const [first, second] = service.status().accounts;
  await service.setAccountPollInterval(first!.accountKey, 30);
  await service.setAccountPollInterval(second!.accountKey, null);
  await vi.waitFor(() => expect(service.status().accounts).toMatchObject([
    { state: "polling", pollIntervalSeconds: 30 },
    { state: "unsupported", errorCode: "mail_idle_unsupported", pollIntervalSeconds: null },
  ]));
  expect(createClient).toHaveBeenCalledTimes(2);
  expect(credentials.set).toHaveBeenCalledTimes(2);
  await service.close();
  services.splice(services.indexOf(service), 1);

  const resumed = new Inbox();
  const paused = new Inbox();
  resumed.capabilities.clear();
  paused.capabilities.clear();
  const reenabled = new Inbox();
  reenabled.capabilities.clear();
  const { service: restarted } = await createService([resumed, paused, reenabled]);
  await waitForMailState(restarted, "polling");
  expect(restarted.status().accounts).toMatchObject([
    { accountKey: first!.accountKey, state: "polling", pollIntervalSeconds: 30 },
    { accountKey: second!.accountKey, state: "unsupported", pollIntervalSeconds: null },
  ]);
  resumed.deliver(5);
  await vi.advanceTimersByTimeAsync(29_999);
  expect(restarted.page().events).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  await vi.waitFor(() => expect(restarted.page().events.map(event => event.uid)).toEqual([5]));
  expect(paused.mailboxOpen).not.toHaveBeenCalled();
  await restarted.setAccountPollInterval(second!.accountKey, 120);
  await vi.waitFor(() => expect(restarted.status().accounts[1]).toMatchObject({ state: "polling", pollIntervalSeconds: 120 }));
});

it.each(["NO", "BYE"])("receives new mail after an IMAP server advertising IDLE replies %s", async refusal => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const commands: string[] = [];
  let delivered = false;
  const source = "Subject: mail after IDLE refusal\r\n\r\nbody\r\n";
  const server = createServer(socket => {
    socket.write("* PREAUTH test mailbox\r\n");
    createInterface({ input: socket }).on("line", line => {
      const [tag, command] = line.split(" ");
      commands.push(line.slice(tag!.length + 1));
      const ok = `${tag} OK done\r\n`;
      switch (command) {
        case "CAPABILITY": socket.write(`* CAPABILITY IMAP4rev1 IDLE\r\n${ok}`); break;
        case "LIST": socket.write(`* LIST () "/" INBOX\r\n${ok}`); break;
        case "EXAMINE":
          socket.write(`* ${delivered ? 1 : 0} EXISTS\r\n* OK [UIDVALIDITY 1] valid\r\n* OK [UIDNEXT ${delivered ? 6 : 5}] next\r\n${tag} OK [READ-ONLY] examined\r\n`);
          break;
        case "UID":
          socket.write((!delivered ? "" : line.includes("BODY.PEEK[]")
            ? `* 1 FETCH (UID 5 BODY[] {${Buffer.byteLength(source)}}\r\n${source})\r\n`
            : "* 1 FETCH (UID 5)\r\n") + ok);
          break;
        case "NOOP": socket.write(ok); break;
        case "IDLE":
          if (refusal === "BYE") socket.end("* BYE IDLE disabled\r\n");
          else socket.write(`${tag} NO IDLE disabled\r\n`);
          break;
        default: socket.write(`${tag} BAD unexpected command\r\n`);
      }
    });
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  const service = new AssistantMailService({ userDataPath: root,
    createClient: options => new ImapFlow({ ...options, secure: false, doSTARTTLS: false }),
    credentials: { supported: true, get: async () => "fixture", set: async () => {}, delete: async () => {} },
  });
  try {
    await service.initialize();
    await service.enable({ ...account, host: "127.0.0.1", port });
    if (refusal === "BYE") {
      await waitForMailState(service, "reconnecting");
      await vi.advanceTimersByTimeAsync(4_999);
      expect(commands.filter(command => command === "EXAMINE INBOX")).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
    }
    await waitForMailState(service, "polling");
    delivered = true;
    await vi.advanceTimersByTimeAsync(59_999);
    expect(service.page().events).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(service.page().events.map(event => event.uid)).toEqual([5]));
    expect(commands.filter(command => command === "IDLE")).toHaveLength(1);
    expect(commands).toContain("EXAMINE INBOX");
    expect(commands.some(command => command.includes("BODY.PEEK[]"))).toBe(true);
  } finally {
    await service.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it.each([0, 1])("polls an IMAP mailbox without UIDNEXT, with %s old messages", async oldCount => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const oldUid = 2_500_000_000;
  const newUid = oldUid + 1;
  const commands: string[] = [];
  let delivered = 0;
  const source = "Subject: mail without UIDNEXT\r\n\r\nbody\r\n";
  const server = createServer(socket => {
    socket.write("* PREAUTH test mailbox\r\n");
    createInterface({ input: socket }).on("line", line => {
      const [tag, command] = line.split(" ");
      commands.push(line.slice(tag!.length + 1));
      const ok = `${tag} OK done\r\n`;
      const count = oldCount + delivered;
      const tail = `* ${count} FETCH (UID ${oldUid + delivered}`;
      switch (command) {
        case "CAPABILITY": socket.write(`* CAPABILITY IMAP4rev1\r\n${ok}`); break;
        case "LIST": socket.write(`* LIST () "/" INBOX\r\n${ok}`); break;
        case "EXAMINE":
          socket.write(`* ${count} EXISTS\r\n* OK [UIDVALIDITY 1] valid\r\n${tag} OK [READ-ONLY] examined\r\n`);
          break;
        case "FETCH":
        case "UID":
          socket.write((!count ? "" : line.includes("BODY.PEEK[]")
            ? `${tail} BODY[] {${Buffer.byteLength(source)}}\r\n${source})\r\n`
            : `${tail})\r\n`) + ok);
          break;
        default: socket.write(`${tag} BAD unexpected command\r\n`);
      }
    });
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  const service = new AssistantMailService({ userDataPath: root,
    createClient: options => new ImapFlow({ ...options, secure: false, doSTARTTLS: false }),
    credentials: { supported: true, get: async () => "fixture", set: async () => {}, delete: async () => {} },
  });
  service.on("error", vi.fn());
  try {
    await service.initialize();
    await service.enable({ ...account, host: "127.0.0.1", port });
    await vi.waitFor(() => expect(service.status().accounts[0]).toMatchObject({ state: "polling" }));
    expect(service.page().events).toEqual([]);
    expect(commands).toContain(`UID FETCH ${oldCount ? newUid : 1}:* UID`);
    expect(commands.some(command => command.includes("BODY.PEEK[]"))).toBe(false);

    delivered++;
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(service.page().events.map(event => event.uid)).toEqual([newUid]));
    expect((await service.read(service.page().events[0]!.mailRefId))?.source.toString()).toBe(source);

    const { accountKey } = service.status().accounts[0]!;
    await service.setAccountEnabled(accountKey, false);
    delivered++;
    await service.setAccountEnabled(accountKey, true);
    await vi.waitFor(() => expect(service.page().events.map(event => event.uid)).toEqual([newUid + 1, newUid]));
    expect(commands.filter(command => command.startsWith("FETCH "))).toEqual(oldCount ? ["FETCH 1 UID"] : []);
  } finally {
    await service.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
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
  await vi.waitFor(() => expect(onError).toHaveBeenCalledExactlyOnceWith(failure, {
    accountKey: service.status().accounts[0]!.accountKey, errorCode: "mail_storage_failed",
  }));
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

it.each([
  [false, "mail_connection_failed"], [true, "mail_authentication_failed"],
])("shows a fixed connection error with authenticationFailed=%s", async (authenticationFailed, errorCode) => {
  const inbox = new Inbox();
  inbox.connect.mockRejectedValueOnce(Object.assign(new Error(`AUTH failed: ${account.password}`), { authenticationFailed }));
  const { service } = await createService([inbox]);
  await service.enable(account);
  await vi.waitFor(() => expect(service.status()).toMatchObject({ state: "reconnecting", errorCode,
    accounts: [{ state: "reconnecting", errorCode }],
  }));
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
  await expect(readFile(join(root, "private", "assistant", "accounts.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("receives the same UID independently and manages one account without interrupting its peer", async () => {
  const first = new Inbox();
  const peer = new Inbox();
  const replacement = new Inbox();
  const reenabled = new Inbox();
  const { service, createClient, credentials } = await createService([first, peer, replacement, reenabled]);
  const second = { host: "imap.other.test", port: 1993, user: "other@example.test", password: "peer-secret" };
  await Promise.all([service.enable(account), service.enable(second)]);
  await vi.waitFor(() => expect(service.status().accounts.map(entry => entry.state)).toEqual(["connected", "connected"]));
  const [firstStatus, secondStatus] = service.status().accounts;
  const firstKey = firstStatus!.accountKey;
  const secondKey = secondStatus!.accountKey;
  expect(firstKey).not.toBe(secondKey);
  expect(secondStatus).toEqual({ accountKey: secondKey, host: second.host, port: second.port, user: second.user, enabled: true, pollIntervalSeconds: 60, state: "connected" });
  expect(JSON.parse(await readFile(join(root, "private", "assistant", "accounts.json"), "utf8"))).toEqual([
    { host: account.host, port: 993, user: account.user, enabled: true, pollIntervalSeconds: 60 },
    { host: second.host, port: second.port, user: second.user, enabled: true, pollIntervalSeconds: 60 },
  ]);
  first.deliver(5); peer.deliver(5);
  await vi.waitFor(() => expect(service.page().events).toHaveLength(2));
  const historical = service.page().events.find(event => event.accountKey === firstKey)!;
  expect(service.page().events).toContainEqual(expect.objectContaining({ accountKey: secondKey, uid: 5 }));
  expect(historical.uid).toBe(5);

  credentials.set.mockRejectedValueOnce(new Error(`Keychain diagnostics: ${account.password}`));
  await expect(service.replacePassword(firstKey, "replacement-secret")).rejects.toThrow(/^mail_credentials_unavailable$/);
  expect(first.close).not.toHaveBeenCalled();
  replacement.deliver(5); replacement.deliver(6);
  await service.replacePassword(firstKey, "replacement-secret");
  await vi.waitFor(() => expect(replacement.idle).toHaveBeenCalledOnce());
  expect(first.close).toHaveBeenCalled();
  expect(replacement.scans[0]).toBe("6:*");
  expect(createClient).toHaveBeenLastCalledWith(expect.objectContaining({ auth: { user: account.user, pass: "replacement-secret" } }));

  await service.setAccountEnabled(firstKey, false);
  await service.replacePassword(firstKey, "disabled-secret");
  expect(service.status().accounts[0]).toMatchObject({ enabled: false, state: "disabled" });
  expect(createClient).toHaveBeenCalledTimes(3);
  await service.setAccountEnabled(firstKey, true);
  await vi.waitFor(() => expect(reenabled.idle).toHaveBeenCalledOnce());
  expect(createClient).toHaveBeenLastCalledWith(expect.objectContaining({ auth: { user: account.user, pass: "disabled-secret" } }));
  expect(reenabled.scans[0]).toBe("7:*");

  credentials.delete.mockRejectedValueOnce(new Error(`Keychain diagnostics: ${account.password}`));
  await expect(service.removeAccount(firstKey)).rejects.toThrow(/^mail_credentials_unavailable$/);
  expect(reenabled.close).not.toHaveBeenCalled();
  await service.removeAccount(firstKey);
  expect(reenabled.close).toHaveBeenCalled();
  expect(credentials.delete).toHaveBeenCalledWith(firstKey);
  expect(secrets.has(firstKey)).toBe(false);
  expect(secrets.get(secondKey)).toBe(second.password);
  expect(service.status().accounts).toEqual([secondStatus]);
  expect(JSON.parse(await readFile(join(root, "private", "assistant", "accounts.json"), "utf8"))).toEqual([
    { host: second.host, port: second.port, user: second.user, enabled: true, pollIntervalSeconds: 60 },
  ]);
  expect((await service.read(historical.mailRefId))?.source).toEqual(first.messages[0]!.source);
  expect(peer.close).not.toHaveBeenCalled();
  expect(peer.connect).toHaveBeenCalledOnce();
  peer.deliver(6);
  await vi.waitFor(() => expect(service.page().events).toContainEqual(expect.objectContaining({ accountKey: secondKey, uid: 6 })));
});

it.each(["write", "rename"])("keeps credentials untouched when adding an account cannot %s the config", async failure => {
  const { service, createClient, credentials } = await createService();
  const path = join(root, "private", "assistant", "accounts.json");
  await mkdir(failure === "rename" ? path : `${path}.tmp`);
  await expect(service.enable(account)).rejects.toThrow(/^mail_storage_failed$/);
  expect(service.status().accounts).toEqual([]);
  expect(createClient).not.toHaveBeenCalled();
  expect(credentials.set).not.toHaveBeenCalled();
  expect(secrets.size).toBe(0);
});

it("rolls back a new account if Keychain rejects its credential and preserves peer changes", async () => {
  const { service, credentials } = await createService();
  const peer = { ...account, user: "peer@example.test" };
  await service.enable(peer);
  const [configured] = service.status().accounts;
  const path = join(root, "private", "assistant", "accounts.json");
  let savedDuringSet: unknown;
  credentials.set.mockImplementationOnce(async () => {
    await service.setAccountEnabled(configured!.accountKey, false);
    savedDuringSet = JSON.parse(await readFile(path, "utf8"));
    throw new Error("Keychain rejected the credential");
  });
  await expect(service.enable(account)).rejects.toThrow(/^mail_credentials_unavailable$/);
  expect(savedDuringSet).toEqual([
    { host: peer.host, port: 993, user: peer.user, enabled: false, pollIntervalSeconds: 60 },
    { host: account.host, port: 993, user: account.user, enabled: true, pollIntervalSeconds: 60 },
  ]);
  expect(service.status().accounts).toMatchObject([{ accountKey: configured!.accountKey, enabled: false }]);
  expect(secrets.size).toBe(1);
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual([{ host: peer.host, port: 993, user: peer.user, enabled: false, pollIntervalSeconds: 60 }]);
});

it("keeps a failed add manageable when updating the account file also fails during rollback", async () => {
  const { service, createClient, credentials } = await createService();
  const path = join(root, "private", "assistant", "accounts.json");
  const changed = vi.fn();
  service.on("changed", changed);
  credentials.set.mockImplementationOnce(async () => {
    await mkdir(`${path}.tmp`);
    throw new Error("Keychain rejected the credential");
  });
  await expect(service.enable(account)).rejects.toThrow(/^mail_storage_failed$/);
  expect(changed).toHaveBeenCalledOnce();
  const [configured] = service.status().accounts;
  expect(configured).toMatchObject({ user: account.user, enabled: true });
  expect(createClient).not.toHaveBeenCalled();
  expect(secrets.size).toBe(0);
  await rename(`${path}.tmp`, `${path}.blocked`);
  await service.removeAccount(configured!.accountKey);
  expect(service.status().accounts).toEqual([]);
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual([]);
});

it("removes the credential after an overlapping update while an unrelated account can change", async () => {
  const inbox = new Inbox();
  const peer = new Inbox();
  const { service, credentials } = await createService([inbox, peer, new Inbox()]);
  await service.enable(account);
  await service.enable({ ...account, user: "peer@example.test" });
  await vi.waitFor(() => expect(inbox.idle).toHaveBeenCalledOnce());
  const [first, second] = service.status().accounts;
  let notifyWriteStarted!: () => void;
  let finishWrite!: () => void;
  const writeStarted = new Promise<void>(resolve => { notifyWriteStarted = resolve; });
  const writeReleased = new Promise<void>(resolve => { finishWrite = resolve; });
  credentials.set.mockImplementationOnce(async (key, value) => {
    notifyWriteStarted();
    await writeReleased;
    secrets.set(key, value);
  });
  const update = service.replacePassword(first!.accountKey, "fixture replacement");
  await writeStarted;
  const removal = service.removeAccount(first!.accountKey);
  try {
    await service.setAccountEnabled(second!.accountKey, false);
    // Let a removal that incorrectly overtakes the pending write complete.
    await new Promise<void>(resolve => setImmediate(resolve));
  } finally {
    finishWrite();
    await Promise.all([update, removal]);
  }
  expect(secrets.has(first!.accountKey)).toBe(false);
  expect(secrets.has(second!.accountKey)).toBe(true);
  expect(service.status().accounts).toMatchObject([{ accountKey: second!.accountKey, enabled: false }]);
  expect(JSON.parse(await readFile(join(root, "private", "assistant", "accounts.json"), "utf8"))).toEqual([
    { host: second!.host, port: second!.port, user: second!.user, enabled: false, pollIntervalSeconds: 60 },
  ]);
});

it.each(["write", "rename"])("keeps the running account and credential when removal cannot %s the config", async failure => {
  const inbox = new Inbox();
  const { service, credentials } = await createService([inbox]);
  await service.enable(account);
  await vi.waitFor(() => expect(inbox.idle).toHaveBeenCalledOnce());
  const [configured] = service.status().accounts;
  const path = join(root, "private", "assistant", "accounts.json");
  if (failure === "rename") {
    await rename(path, `${path}.before-test`);
    await mkdir(path);
  } else {
    await mkdir(`${path}.tmp`);
  }
  await expect(service.removeAccount(configured!.accountKey)).rejects.toThrow(/^mail_storage_failed$/);
  expect(credentials.delete).not.toHaveBeenCalled();
  expect(secrets.has(configured!.accountKey)).toBe(true);
  expect(service.status().accounts).toEqual([configured]);
  expect(inbox.close).not.toHaveBeenCalled();
});

it.each([true, false])("reads the legacy account without modifying its format and preserves credentials and watermarks with enabled=%s", async enabled => {
  const store = new AssistantMailStore(root);
  await store.initialize();
  const key = createHash("sha256").update(JSON.stringify([account.host, 993, account.user])).digest("hex");
  store.openMailbox(key, "1", 6);
  store.close();
  secrets.set(key, account.password);
  const path = join(store.directory, "account.json");
  const legacy = JSON.stringify({ host: " IMAP.EXAMPLE.TEST ", port: 993, user: ` ${account.user} `, enabled });
  await writeFile(path, legacy, { mode: 0o600 });
  const inbox = new Inbox();
  inbox.deliver(5); inbox.deliver(6);
  const { service, credentials, createClient } = await createService([inbox]);
  expect(await readFile(path, "utf8")).toBe(legacy);
  expect(service.status().accounts[0]).toMatchObject({ accountKey: key, enabled });
  if (!enabled) {
    service.resume();
    expect(createClient).not.toHaveBeenCalled();
    await service.setAccountEnabled(key, true);
  }
  await vi.waitFor(() => expect(service.page().events.map(event => event.uid)).toEqual([6]));
  expect(inbox.scans[0]).toBe("6:*");
  expect(credentials.get).toHaveBeenCalledExactlyOnceWith(key);
  expect(credentials.set).not.toHaveBeenCalled();
  expect(credentials.delete).not.toHaveBeenCalled();
});

it("resumes all enabled accounts from the persisted array and wakes both IDLE and reconnect delays", async () => {
  vi.useFakeTimers();
  const oldFirst = new Inbox();
  const oldSecond = new Inbox();
  const { service } = await createService([oldFirst, oldSecond]);
  await service.enable(account);
  await service.enable({ ...account, user: "other@example.test" });
  await vi.waitFor(() => expect(oldSecond.idle).toHaveBeenCalledOnce());
  const [firstKey, secondKey] = service.status().accounts.map(entry => entry.accountKey);
  await service.close();
  services.splice(services.indexOf(service), 1);

  const first = new Inbox();
  const second = new Inbox();
  const reconnected = new Inbox();
  const restarted = await createService([first, second, reconnected]);
  await vi.waitFor(() => expect(restarted.service.status().accounts.map(entry => entry.state)).toEqual(["connected", "connected"]));
  first.deliver(5); second.deliver(5);
  await vi.waitFor(() => expect(restarted.service.page().events).toHaveLength(2));
  first.removeAllListeners("exists"); second.removeAllListeners("exists");
  first.deliver(6); second.deliver(6);
  restarted.service.resume();
  await vi.waitFor(() => expect(restarted.service.page().events.filter(event => event.uid === 6).map(event => event.accountKey).sort())
    .toEqual([firstKey, secondKey].sort()));

  reconnected.deliver(6); reconnected.deliver(7);
  first.close(); second.deliver(7);
  await vi.waitFor(() => expect(restarted.service.status()).toMatchObject({ state: "connected", accounts: [
    { state: "reconnecting", errorCode: "mail_connection_failed" }, { state: "connected" },
  ] }));
  expect(restarted.createClient).toHaveBeenCalledTimes(2);
  restarted.service.resume();
  await vi.waitFor(() => expect(restarted.service.page().events.filter(event => event.uid === 7).map(event => event.accountKey).sort())
    .toEqual([firstKey, secondKey].sort()));
  expect(reconnected.scans[0]).toBe("7:*");
  expect(second.close).not.toHaveBeenCalled();
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
