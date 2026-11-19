import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgendaStore } from "./agenda-store.js";
import { AssistantMailService } from "./desktop.js";
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
const vault = new Map<string, string>();
const credentials = { supported: true, get: async (key: string) => vault.get(key), set: async (key: string, value: string) => { vault.set(key, value); },
  delete: async (key: string) => { vault.delete(key); } };
const agendaCredentials = { available: () => false, encrypt: () => { throw new Error("No calendar credentials"); }, decrypt: () => { throw new Error("No calendar credentials"); } };
let directory: string;
let db: DatabaseSync;
let mail: AssistantMailService;
let ledger: ProposalStore;
let executor: ProposalExecutor;
let originalId: string;

async function open() {
  mail = new AssistantMailService({ userDataPath: directory, credentials });
  await mail.initialize(database => { db = database; ledger = new ProposalStore(db); }, false);
  executor = new ProposalExecutor(ledger, new AgendaStore(db), agendaCredentials, () => {}, undefined, mail, send);
}

beforeEach(async () => {
  send.mockReset();
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

it.each([{ state: "applied", accepted: [...draft.to, ...draft.cc], rejected: [] },
  { state: "failed", responseCode: 550 }, { state: "delivery_uncertain" }] as const)("persists one exact attempt for $state", async result => {
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
  await expect(committing).resolves.toMatchObject({ state: result.state });
  expect(send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ host: channel.host }), channel.credential, approved.action,
    `<${approved.proposalId}.2@example.com>`);
  const stored = db.prepare("SELECT result, finished_at FROM send_attempts").all();
  expect(stored).toHaveLength(1);
  expect(stored[0]!.finished_at).toEqual(expect.any(Number));
  expect(JSON.parse(String(stored[0]!.result))).toMatchObject({ state: result.state });
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
  expect(executor.resolve("bound", [ref], false, true)[0]?.state).toBe("delivery_uncertain");
  expect(db.prepare("SELECT message_id, result FROM send_attempts").all()).toEqual([
    { message_id: "<interrupted@example.com>", result: '{"state":"delivery_uncertain"}' },
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
