import { z } from "zod";
import { mailAccountKey, mailbox } from "./account-contract.js";
import { eventInput, todoInput } from "./agenda-contract.js";

const recordId = z.string().regex(/^(?:[a-f0-9]{64}|[a-f0-9-]{36})$/u);
const sourceId = z.string().regex(/^(?:local|[a-f0-9]{64})$/u).default("local");
const limit = z.number().int().min(1).max(50).default(30);
const cursor = z.string().regex(/^[1-9]\d*$/u).refine(value => Number.isSafeInteger(Number(value))).optional();

const subject = z.string().trim().max(500).regex(/^[^\p{Cc}]*$/u);
const mailDraft = {
  accountKey: mailAccountKey,
  cc: z.array(mailbox).max(20).optional(),
  replyTo: mailbox.optional(),
  bodyText: z.string().min(1).max(8000).regex(/^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]*$/u),
};
const recipients = z.array(mailbox).min(1).max(20);

export const MEMORY_RULE_TEXT_REQUIREMENT = "For memory.rule_upsert, omit text for delete; provide text for add and update.";
const memoryRule = z.strictObject({
  kind: z.literal("memory.rule_upsert"),
  category: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/u),
  ruleId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
  reason: z.string().trim().min(1).max(1_000),
});

export const proposalAction = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("todo.create"), sourceId, value: todoInput }),
  z.strictObject({ kind: z.literal("todo.update"), recordId, value: todoInput }),
  z.strictObject({ kind: z.literal("todo.complete"), recordId }),
  z.strictObject({ kind: z.literal("calendar.create"), sourceId, value: eventInput }),
  z.strictObject({ kind: z.literal("calendar.reschedule"), recordId, value: eventInput }),
  z.strictObject({ kind: z.literal("calendar.delete"), recordId }),
  z.discriminatedUnion("operation", [
    memoryRule.extend({ operation: z.literal("delete"), text: z.never().optional() }),
    memoryRule.extend({ operation: z.enum(["add", "update"]), text: z.string().trim().min(1).max(4_000) }),
  ]),
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
