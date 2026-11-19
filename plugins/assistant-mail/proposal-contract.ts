import { z } from "zod";
import { eventInput, todoInput } from "./agenda-contract.js";

const recordId = z.string().regex(/^(?:[a-f0-9]{64}|[a-f0-9-]{36})$/u);
const sourceId = z.string().regex(/^(?:local|[a-f0-9]{64})$/u).default("local");
const limit = z.number().int().min(1).max(50).default(30);
const cursor = z.string().regex(/^[1-9]\d*$/u).refine(value => Number.isSafeInteger(Number(value))).optional();

export const proposalAction = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("todo.create"), sourceId, value: todoInput }),
  z.strictObject({ kind: z.literal("todo.update"), recordId, value: todoInput }),
  z.strictObject({ kind: z.literal("todo.complete"), recordId }),
  z.strictObject({ kind: z.literal("calendar.create"), sourceId, value: eventInput }),
  z.strictObject({ kind: z.literal("calendar.reschedule"), recordId, value: eventInput }),
  z.strictObject({ kind: z.literal("calendar.delete"), recordId }),
]);
export const proposalRef = z.strictObject({
  proposalId: z.uuid(), revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), payloadHash: z.string().regex(/^[a-f0-9]{64}$/u),
});
export const reviseProposal = z.strictObject({ ...proposalRef.shape, action: proposalAction });
export const listProposals = z.strictObject({ cursor, limit });
export const proposalRequests = {
  "assistant.proposal.list": listProposals.extend({ history: z.boolean().default(false) }),
  "assistant.proposal.resolve": z.strictObject({ sessionId: z.string().min(1).max(512), refs: z.array(proposalRef).max(100), latestForReview: z.boolean().optional() }),
  "assistant.proposal.revise": reviseProposal,
  "assistant.proposal.commit": proposalRef,
  "assistant.proposal.dismiss": proposalRef,
  "assistant.proposal.replan": z.strictObject({ ...proposalRef.shape, feedback: z.string().trim().min(1).max(4000) }),
};
