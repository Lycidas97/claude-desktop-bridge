import { z } from "zod";
import { eventInput, todoInput } from "./agenda-contract.js";

const recordId = z.string().regex(/^(?:[a-f0-9]{64}|[a-f0-9-]{36})$/u);
const sourceId = z.string().regex(/^(?:local|[a-f0-9]{64})$/u).default("local");
const limit = z.number().int().min(1).max(50).default(30);
const cursor = z.string().regex(/^[1-9]\d*$/u).refine(value => Number.isSafeInteger(Number(value))).optional();

export const mailbox = z.email({ pattern: z.regexes.html5Email }).max(254).transform(address => {
  const at = address.lastIndexOf("@");
  return address.slice(0, at + 1) + address.slice(at + 1).toLowerCase();
});
const subject = z.string().trim().max(500).regex(/^[^\p{Cc}]*$/u);
const mailDraft = {
  accountKey: z.string().regex(/^[a-f0-9]{64}$/u),
  cc: z.array(mailbox).max(20).optional(),
  replyTo: mailbox.optional(),
  bodyText: z.string().min(1).max(8000).regex(/^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]*$/u),
};
const recipients = z.array(mailbox).min(1).max(20);
export const smtpChannel = z.strictObject({ host: z.string().trim().toLowerCase().min(1).max(253).regex(/^[a-z0-9.-]+$/u),
  port: z.number().int().min(1).max(65535), security: z.enum(["tls", "starttls"]),
  user: z.string().trim().min(1).max(300), from: mailbox });
export const sharedSmtpChannel = smtpChannel.omit({ user: true });
const sharedMailSettings = { credential: z.string().min(1), smtp: sharedSmtpChannel.optional() };
export const saveMailAccount = z.union([
  z.strictObject({ host: z.string().trim().min(1).regex(/^\S+$/u), port: z.number().int().min(1).max(65535).optional(),
    user: z.string().trim().min(1), ...sharedMailSettings }),
  z.strictObject({ accountKey: mailDraft.accountKey, ...sharedMailSettings }),
]);
export const configureSmtp = z.strictObject({ accountKey: mailDraft.accountKey,
  smtp: smtpChannel.extend({ credential: z.string().min(1).max(1800) }).nullable() });

export const proposalAction = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("todo.create"), sourceId, value: todoInput }),
  z.strictObject({ kind: z.literal("todo.update"), recordId, value: todoInput }),
  z.strictObject({ kind: z.literal("todo.complete"), recordId }),
  z.strictObject({ kind: z.literal("calendar.create"), sourceId, value: eventInput }),
  z.strictObject({ kind: z.literal("calendar.reschedule"), recordId, value: eventInput }),
  z.strictObject({ kind: z.literal("calendar.delete"), recordId }),
  z.strictObject({
    kind: z.literal("memory.rule_upsert"),
    category: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/u),
    ruleId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
    operation: z.enum(["add", "update", "delete"]),
    text: z.string().trim().min(1).max(4_000).optional(),
    reason: z.string().trim().min(1).max(1_000),
  }).refine(({ operation, text }) => (operation === "delete") === (text === undefined)),
  z.strictObject({ kind: z.literal("mail.reply"), ...mailDraft, mailRefId: z.uuid(), to: recipients.optional(), subject: subject.optional() }),
  z.strictObject({ kind: z.literal("mail.send"), ...mailDraft, to: recipients, subject }),
]);
export const proposalRef = z.strictObject({
  proposalId: z.uuid(), revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), payloadHash: z.string().regex(/^[a-f0-9]{64}$/u),
});
export const reviseProposal = z.strictObject({ ...proposalRef.shape, action: proposalAction });
export const listProposals = z.strictObject({ cursor, limit });
export const proposalRequests = {
  "assistant.proposal.list": listProposals.extend({ history: z.boolean().default(false), includeMail: z.literal(true).optional(), includeMemory: z.literal(true).optional() }),
  "assistant.proposal.resolve": z.strictObject({ sessionId: z.string().min(1).max(512), refs: z.array(proposalRef).max(100), latestForReview: z.boolean().optional(), includeMail: z.literal(true).optional(), includeMemory: z.literal(true).optional() }),
  "assistant.proposal.revise": reviseProposal,
  "assistant.proposal.commit": proposalRef.extend({ confirmMail: z.literal(true).optional(), confirmMemory: z.literal(true).optional() }),
  "assistant.proposal.dismiss": proposalRef.extend({ includeMemory: z.literal(true).optional() }),
  "assistant.proposal.replan": z.strictObject({ ...proposalRef.shape, feedback: z.string().trim().min(1).max(4000) }),
};
