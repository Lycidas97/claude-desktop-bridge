import type { AgendaEventInput, AgendaTodoInput } from "./assistant-agenda.js";

export const ASSISTANT_PROPOSAL_CAPABILITY = "assistant.proposal.v1";

export type AgendaProposalAction =
  | { kind: "todo.create"; sourceId: string; value: AgendaTodoInput }
  | { kind: "todo.update"; recordId: string; value: AgendaTodoInput }
  | { kind: "todo.complete"; recordId: string }
  | { kind: "calendar.create"; sourceId: string; value: AgendaEventInput }
  | { kind: "calendar.reschedule"; recordId: string; value: AgendaEventInput }
  | { kind: "calendar.delete"; recordId: string };

export type MemoryRuleProposalAction = {
  kind: "memory.rule_upsert";
  category: string;
  ruleId: string;
  operation: "add" | "update" | "delete";
  text?: string | undefined;
  reason: string;
};
export type AssistantProposalAction = AgendaProposalAction | MemoryRuleProposalAction;

export interface ProposalRevisionRef {
  proposalId: string;
  revision: number;
  payloadHash: string;
}

export type ProposalState = "pending" | "executing" | "applied" | "dismissed" | "conflict" | "failed" | "uncertain";

export interface BridgeActionProposal extends ProposalRevisionRef {
  sessionId: string;
  action: AssistantProposalAction;
  sourceId: string;
  sourceLabel: string;
  before?: AgendaTodoInput | AgendaEventInput;
  profile?: { before: string | null; baseProfileSha256: string };
  state: ProposalState;
}

export interface BridgeProposalSnapshot {
  changeToken: string;
  pendingCount: number;
  sources: { id: string; label: string; kinds: ("todo" | "calendar")[] }[];
}

export interface BridgeProposalPage {
  proposals: BridgeActionProposal[];
  nextCursor?: string;
}

export const PROPOSAL_TOOLS = ["proposal.create", "proposal.update_pending", "proposal.list"] as const;
