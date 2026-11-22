import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { PassThrough, Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { ImapFlow, ImapFlowOptions } from "imapflow";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgendaStore } from "./agenda-store.js";
import { AssistantMailService } from "./desktop.js";
import { serveAssistantMailTools } from "./local-channel.js";
import { ProposalExecutor } from "./proposal-executor.js";
import { ProposalStore } from "./proposal-store.js";
import type { submitSmtp } from "./smtp.js";
import { AssistantMailStore } from "./store.js";

const account = { host: "imap.example.com", user: "reader@example.com", port: 993, enabled: true };
const accountKey = createHash("sha256").update(JSON.stringify([account.host, account.port, account.user])).digest("hex");
const channel = { host: "smtp.example.com", port: 465, security: "tls", user: "login", from: "writer@example.com", credential: "for-test-only" } as const;
const draft = { kind: "mail.send", accountKey, to: ["first@example.net", "second@example.net"], cc: ["copy@example.org"],
  subject: "Draft", bodyText: "Draft body\r\nSecond line" } as const;
const send = vi.fn<typeof submitSmtp>();
const createClient = vi.fn<(options: ImapFlowOptions) => ImapFlow>();
const vault = new Map<string, string>();
const deleteCredential = async (key: string) => { vault.delete(key); };
const credentials = { supported: true, get: async (key: string) => vault.get(key), set: async (key: string, value: string) => { vault.set(key, value); },
  delete: vi.fn(deleteCredential) };
const agendaCredentials = { available: () => false, encrypt: () => { throw new Error("No calendar credentials"); }, decrypt: () => { throw new Error("No calendar credentials"); } };
let directory: string;
let db: DatabaseSync;
let mail: AssistantMailService;
let ledger: ProposalStore;
let executor: ProposalExecutor;
let originalId: string;

async function open() {
  mail = new AssistantMailService({ userDataPath: directory, credentials, createClient });
  await mail.initialize(database => { db = database; ledger = new ProposalStore(db); }, false);
  executor = new ProposalExecutor(ledger, new AgendaStore(db), agendaCredentials, () => {}, undefined, mail, send);
}

beforeEach(async () => {
  send.mockReset();
  createClient.mockReset();
  credentials.delete.mockReset();
  vault.clear();
  vault.set(accountKey, "imap-fixture-value");
  directory = await mkdtemp(join(tmpdir(), "bridge-mail-proposals-"));
  const store = new AssistantMailStore(directory);
  await store.initialize();
  try {
    store.openMailbox(accountKey, "1", 1);
    const original = await store.record({ accountKey, mailbox: "INBOX", uidValidity: "1", uid: 1, subject: "Original", from: [{ address: "sender@example.net" }],
      receivedAt: new Date().toISOString(), source: Buffer.from([
        "From: Sender <sender@EXAMPLE.NET>", "Reply-To: another@example.net, other@foreign.example.org", "Subject: Original",
        "Message-ID: <current@example.net>", "References: <parent@example.net>", "", "Original body",
      ].join("\r\n")) });
    originalId = original!.mailRefId;
    await writeFile(join(store.directory, "accounts.json"), JSON.stringify([account]));
  } finally { store.close(); }
  await open();
  await mail.setSmtp(accountKey, channel);
});

afterEach(async () => {
  await executor.close();
  await mail.close();
  await rm(directory, { recursive: true });
});

it("binds replies to the original mailbox, threads them, and never silently selects Reply-To", async () => {
  const reply = { kind: "mail.reply" as const, accountKey, mailRefId: originalId, bodyText: "Reply", cc: ["first@example.net"] };
  await expect(executor.create("bound", { ...reply, mailRefId: randomUUID() })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(executor.create("bound", { ...reply, accountKey: "b".repeat(64) })).rejects.toMatchObject({ code: "NOT_FOUND" });
  const ref = await executor.create("bound", reply);
  expect(executor.pending(ref).action).toEqual({
    kind: "mail.reply", accountKey, from: channel.from, to: ["sender@example.net"], cc: reply.cc,
    subject: "Re: Original", bodyText: "Reply", mailRefId: originalId, originalFrom: ["sender@example.net"],
    originalReplyTo: ["another@example.net", "other@foreign.example.org"], replyToDiffers: true, foreignReplyTo: true,
    inReplyTo: "<current@example.net>", references: ["<parent@example.net>", "<current@example.net>"],
  });
  expect(executor.snapshot()).toMatchObject({ pendingCount: 0, pendingMailCount: 1 });
  expect(executor.page({ limit: 10 }).proposals).toEqual([]);
  expect(executor.resolve("bound", [ref])).toEqual([]);
  expect(executor.resolve("bound", [ref], false, true)).toEqual([executor.pending(ref)]);
  expect(send).not.toHaveBeenCalled();
});

it("keeps grouped Reply-To and ASCII domain equivalence without silently retargeting the reply", async () => {
  vi.spyOn(mail, "replySource").mockReturnValueOnce({ subject: "Original", source: Readable.from([
    "From: sender@xn--bcher-kva.xn--p1ai\r\nReply-To: Replies: reader@foreign.example.org, help@xn--bcher-kva.xn--p1ai;\r\n\r\nOriginal body",
  ]) });
  const ref = await executor.create("bound", { kind: "mail.reply", accountKey, mailRefId: originalId, bodyText: "Reply" });
  expect(executor.pending(ref).action).toMatchObject({ to: ["sender@xn--bcher-kva.xn--p1ai"],
    originalReplyTo: ["reader@foreign.example.org", "help@xn--bcher-kva.xn--p1ai"], foreignReplyTo: true, replyToDiffers: true });
});

it.each(["proposal.create", "proposal.update_pending"] as const)("does not let %s write after the managed token is revoked during header reading", async name => {
  const action = { kind: "mail.reply" as const, accountKey, mailRefId: originalId, bodyText: "Reply" };
  const initial = name === "proposal.update_pending" ? await executor.create("bound", action) : undefined;
  const headers = new PassThrough();
  let signalReading!: () => void;
  const reading = new Promise<void>(resolve => { signalReading = resolve; });
  vi.spyOn(mail, "replySource").mockImplementationOnce(() => {
    signalReading();
    return { source: headers, subject: "Original" };
  });
  let token = "bound-token";
  const server = await serveAssistantMailTools({ userDataPath: directory, service: mail, proposals: executor,
    authorizeManagedToken: value => value === token ? "bound" : undefined });
  try {
    const { port } = JSON.parse(await readFile(join(directory, "private", "assistant", "mail-tools.json"), "utf8"));
    const response = fetch(`http://127.0.0.1:${port}/tools`, { method: "POST", headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name, arguments: { ...initial, action } }) });
    await reading;
    token = "rebound-token";
    headers.end("From: sender@example.net\r\n\r\nOriginal body");
    expect((await response).status).toBe(403);
    expect(db.prepare("SELECT revision FROM action_proposals").all()).toEqual(initial ? [{ revision: 1 }] : []);
  } finally {
    headers.destroy();
    await server.close();
  }
});

it.each([{ state: "applied", accepted: [...draft.to, ...draft.cc], rejected: [] },
  { state: "failed", failure: { reason: "rejected", responseCode: 550 } },
  { state: "delivery_uncertain", failure: { reason: "unconfirmed" } }] as const)("persists one exact attempt for $state", async result => {
  const action = { ...draft, to: [...draft.to], cc: [...draft.cc] };
  const first = await executor.create("bound", action);
  const approved = await executor.revise(first, { ...action, to: ["updated@example.net", ...draft.to], subject: "Final", bodyText: "Final text" });
  expect(approved.payloadHash).not.toBe(first.payloadHash);
  await expect(executor.commit({ ...first, confirmMail: true }, "stale")).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(executor.commit(approved, "old-client")).rejects.toMatchObject({ code: "INVALID_PARAMS" });
  expect(db.prepare("SELECT * FROM send_attempts").all()).toEqual([]);
  send.mockImplementationOnce(async () => {
    expect(db.prepare("SELECT revision, result FROM send_attempts").all()).toEqual([{ revision: approved.revision, result: null }]);
    expect(db.prepare("SELECT actor, state FROM proposal_executions").all()).toEqual([{ actor: "phone", state: "executing" }]);
    return result.state === "applied" ? { ...result, accepted: ["updated@example.net", ...result.accepted], rejected: [] } : result;
  });
  const committing = executor.commit({ ...approved, confirmMail: true }, "phone");
  await expect(executor.commit({ ...approved, confirmMail: true }, "desktop")).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(committing).resolves.toMatchObject({ state: "executing" });
  await executor.close();
  const resolved = executor.resolve("bound", [first], false, true)[0];
  expect(resolved?.state).toBe(result.state);
  expect(resolved?.mailSendFailure).toEqual("failure" in result ? result.failure : undefined);
  if ("failure" in result) expect(createClient).not.toHaveBeenCalled();
  expect(executor.page({ limit: 10, includeMail: true, history: true }).proposals).toEqual([resolved]);
  expect(executor.page({ limit: 10, includeMail: true }).proposals).toEqual([]);
  expect(send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ host: channel.host }), channel.credential, approved.action,
    `<${approved.proposalId}.2@example.com>`);
  const stored = db.prepare("SELECT result, finished_at FROM send_attempts").all();
  expect(stored).toHaveLength(1);
  expect(stored[0]!.finished_at).toEqual(expect.any(Number));
  expect(JSON.parse(String(stored[0]!.result))).toEqual(result.state === "applied"
    ? { ...result, accepted: ["updated@example.net", ...result.accepted] } : result);
});

it.each([
  ["applied", true, "filed"], ["delivery_partial", true, "filed"], ["applied", false, "unconfirmed"],
] as const)("keeps SMTP %s independent of Sent APPEND success=%s", async (state, appended, sentCopy) => {
  const path = "邮箱/已发送";
  const proposal = await executor.create("bound", { ...draft, to: [...draft.to], cc: [...draft.cc] });
  const action = executor.pending(proposal).action;
  const messageId = `<${proposal.proposalId}.1@example.com>`;
  const source = Buffer.from(`Message-ID: ${messageId}\r\nSubject: Draft\r\n\r\nDraft body\r\n`);
  const accepted = state === "applied" ? [...draft.to, ...draft.cc] : [...draft.to];
  const rejected = state === "applied" ? [] : [...draft.cc];
  const imap = {
    on: vi.fn(), connect: vi.fn(), close: vi.fn(),
    list: vi.fn(async () => [{ path, flags: new Set(["\\Sent"]) }]),
    mailboxOpen: vi.fn(), search: vi.fn(async () => []), append: vi.fn(async () => {
      expect(executor.resolve("bound", [proposal], false, true)[0]?.state).toBe(state);
      return appended ? { destination: path } : false;
    }),
  };
  createClient.mockReturnValueOnce(imap as unknown as ImapFlow);
  send.mockResolvedValueOnce({ state, accepted, rejected, source });
  await executor.commit({ ...proposal, confirmMail: true }, "phone");
  await executor.close();
  const resolved = executor.resolve("bound", [proposal], false, true)[0];
  expect(resolved?.state).toBe(state);
  expect(resolved?.rejectedRecipients).toEqual(rejected.length ? rejected : undefined);
  expect(resolved?.mailSendFailure).toBeUndefined();
  expect(createClient).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ host: account.host, port: account.port, secure: true,
    tls: { rejectUnauthorized: true }, auth: { user: account.user, pass: vault.get(accountKey) } }));
  expect(imap.append).toHaveBeenCalledExactlyOnceWith(path, source, ["\\Seen"]);
  expect(send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ host: channel.host }), channel.credential, action, messageId);
  expect(JSON.parse(String(db.prepare("SELECT result FROM send_attempts").get()!.result))).toEqual({ state, accepted, rejected, sentCopy });
  await expect(executor.commit({ ...proposal, confirmMail: true }, "desktop")).rejects.toMatchObject({ code: "CONFLICT" });
  expect(send).toHaveBeenCalledOnce();
});

it("reads a legacy failed attempt with no reason", async () => {
  const ref = await executor.create("bound", { ...draft, to: [...draft.to], cc: [...draft.cc] });
  ledger.transaction(() => {
    ledger.claim(ledger.requirePending(ref), "phone", "executing", "<legacy@example.com>");
    db.prepare("UPDATE proposal_executions SET state = 'failed'").run();
    db.prepare("UPDATE send_attempts SET result = ?").run('{"state":"failed","responseCode":550}');
  });
  const [result] = executor.page({ limit: 10, includeMail: true, history: true }).proposals;
  expect(result).toMatchObject({ proposalId: ref.proposalId, state: "failed" });
  expect(result).not.toHaveProperty("mailSendFailure");
});

it("recovers a consumed but interrupted approval without SMTP, and never reopens it", async () => {
  const ref = await executor.create("bound", { ...draft, to: [...draft.to], cc: [...draft.cc] });
  const row = ledger.requirePending(ref);
  ledger.transaction(() => ledger.claim(row, "phone", "executing", "<interrupted@example.com>"));
  await executor.close();
  await mail.close();
  await open();
  executor.start();
  await executor.close();
  expect(send).not.toHaveBeenCalled();
  expect(executor.resolve("bound", [ref], false, true)[0]).toMatchObject({ state: "delivery_uncertain", mailSendFailure: { reason: "interrupted" } });
  expect(db.prepare("SELECT message_id, result FROM send_attempts").all()).toEqual([
    { message_id: "<interrupted@example.com>", result: '{"state":"delivery_uncertain","failure":{"reason":"interrupted"}}' },
  ]);
  await expect(executor.commit({ ...ref, confirmMail: true }, "desktop")).rejects.toMatchObject({ code: "CONFLICT" });
});

it("keeps credentials separate and rejects mail reviewed against a changed channel", async () => {
  const ref = await executor.create("bound", { ...draft, to: [...draft.to], cc: [...draft.cc] });
  await mail.setSmtp(accountKey, { ...channel, host: "other.example.com" });
  expect(vault.get(accountKey)).toBe("imap-fixture-value");
  expect(vault.size).toBe(2);
  const settings = await readFile(join(directory, "private", "assistant", "accounts.json"), "utf8");
  expect(settings).not.toContain(channel.credential);
  expect(JSON.stringify(mail.status().accounts)).not.toContain(channel.credential);
  await expect(executor.commit({ ...ref, confirmMail: true }, "phone")).rejects.toMatchObject({ code: "CONFLICT" });
  expect(db.prepare("SELECT * FROM send_attempts").all()).toEqual([]);
  expect(send).not.toHaveBeenCalled();
  await mail.setSmtp(accountKey, null);
  expect([...vault]).toEqual([[accountKey, "imap-fixture-value"]]);
});

it("requires new approval after shared authorization conversion or same-host channel edits", async () => {
  const { credential, user: _user, ...shared } = channel;
  await mail.setSmtp(accountKey, { ...channel, user: account.user });
  const before = mail.smtpAccount(accountKey)!.smtp;
  expect(await mail.smtpPassword(accountKey, before.version)).toBe(credential);
  const action = { ...draft, to: [...draft.to], cc: [...draft.cc] };
  const ref = await executor.create("bound", action);
  await mail.setAccountEnabled(accountKey, false);
  await mail.replacePassword(accountKey, "shared-fixture-value", shared);
  expect([...vault]).toEqual([[accountKey, "shared-fixture-value"]]);
  expect(mail.status().accounts[0]).toMatchObject({ accountKey, enabled: false, smtpSharedAuth: true });
  // Reopen with receiving still stopped, but with sending enabled in the persisted account.
  await mail.close();
  const path = join(directory, "private", "assistant", "accounts.json");
  const saved = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, JSON.stringify([{ ...saved[0], enabled: true }]));
  await open();
  const channelNow = mail.smtpAccount(accountKey)!.smtp;
  expect(channelNow).toEqual({ ...before, version: expect.any(String) });
  expect(channelNow.version).not.toBe(before.version);
  await expect(executor.commit({ ...ref, confirmMail: true }, "phone")).rejects.toMatchObject({ code: "CONFLICT" });
  expect(db.prepare("SELECT * FROM send_attempts").all()).toEqual([]);
  await expect(mail.setSmtp(accountKey, channel)).rejects.toMatchObject({ code: "UNSUPPORTED" });
  const sharedDraft = await executor.revise(ref, action);
  await mail.updateSharedSmtp(accountKey, { ...shared, port: 587, security: "starttls" });
  await expect(executor.commit({ ...sharedDraft, confirmMail: true }, "phone")).rejects.toMatchObject({ code: "CONFLICT" });
  expect(db.prepare("SELECT * FROM send_attempts").all()).toEqual([]);
  expect(send).not.toHaveBeenCalled();

  send.mockResolvedValueOnce({ state: "applied", accepted: [...draft.to, ...draft.cc], rejected: [] });
  const revised = await executor.revise(sharedDraft, action);
  await executor.commit({ ...revised, confirmMail: true }, "phone");
  await executor.close();
  expect(send).toHaveBeenCalledExactlyOnceWith({ ...channelNow, port: 587, security: "starttls", version: expect.any(String) },
    "shared-fixture-value", revised.action, expect.any(String));
});

it("rolls back a newly saved SMTP credential if account settings cannot be persisted", async () => {
  const previous = mail.smtpAccount(accountKey)!.smtp;
  const secrets = new Map(vault);
  await mkdir(join(directory, "private", "assistant", "accounts.json.tmp"));
  await expect(mail.setSmtp(accountKey, { ...channel, host: "replacement.example.net" })).rejects.toThrow("mail_storage_failed");
  expect(vault).toEqual(secrets);
  expect(mail.smtpAccount(accountKey)?.smtp).toEqual(previous);
});

it.each(["replace-smtp", "disable-smtp", "remove-mailbox"] as const)("keeps the original settings and secrets if credential storage fails during %s", async kind => {
  const before = new Map(vault);
  const previous = mail.smtpAccount(accountKey)!.smtp;
  const keyToReject = kind === "remove-mailbox" ? accountKey : `smtp-${previous.version}`;
  credentials.delete.mockImplementation(async key => {
    if (key === keyToReject) throw new Error("mail_credentials_unavailable");
    await deleteCredential(key);
  });
  await expect(kind === "remove-mailbox" ? mail.removeAccount(accountKey)
    : mail.setSmtp(accountKey, kind === "disable-smtp" ? null : { ...channel, host: "replacement.example.net" }))
    .rejects.toThrow("mail_credentials_unavailable");
  expect(vault).toEqual(before);
  expect(mail.smtpAccount(accountKey)?.smtp).toEqual(previous);
  await mail.close();
  await open();
  expect(mail.smtpAccount(accountKey)?.smtp).toEqual(previous);
});
