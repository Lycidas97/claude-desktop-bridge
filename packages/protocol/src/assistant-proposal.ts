import type { AgendaEventInput, AgendaTodoInput } from "./assistant-agenda.js";

export const ASSISTANT_PROPOSAL_CAPABILITY = "assistant.proposal.v1";

export type AgendaProposalAction =
  | { kind: "todo.create"; sourceId: string; value: AgendaTodoInput }
  | { kind: "todo.update"; recordId: string; value: AgendaTodoInput }
  | { kind: "todo.complete"; recordId: string }
  | { kind: "calendar.create"; sourceId: string; value: AgendaEventInput }
  | { kind: "calendar.reschedule"; recordId: string; value: AgendaEventInput }
  | { kind: "calendar.delete"; recordId: string };

type MailDraftFields = { accountKey: string; cc?: string[] | undefined; replyTo?: string | undefined; bodyText: string };
export type MailProposalDraft = MailDraftFields & (
  | { kind: "mail.reply"; mailRefId: string; to?: string[] | undefined; subject?: string | undefined }
  | { kind: "mail.send"; to: string[]; subject: string }
);

export type MailProposalAction = {
  accountKey: string;
  from: string;
  to: string[];
  cc: string[];
  replyTo?: string;
  subject: string;
  bodyText: string;
} & (
  | { kind: "mail.send" }
  | { kind: "mail.reply"; mailRefId: string; originalFrom: string[]; originalReplyTo: string[]; replyToDiffers: boolean;
      foreignReplyTo: boolean; inReplyTo?: string; references?: string[] }
);

export type ProposalDraftAction = AgendaProposalAction | MailProposalDraft;

export interface ProposalRevisionRef {
  proposalId: string;
  revision: number;
  payloadHash: string;
}

export type ProposalState = "pending" | "executing" | "applied" | "dismissed" | "conflict" | "failed" | "uncertain" | "delivery_uncertain" | "delivery_partial";

export interface BridgeActionProposal extends ProposalRevisionRef {
  sessionId: string;
  action: AgendaProposalAction | MailProposalAction;
  sourceId: string;
  sourceLabel: string;
  before?: AgendaTodoInput | AgendaEventInput;
  state: ProposalState;
  rejectedRecipients?: string[];
}

export interface BridgeProposalSnapshot {
  changeToken: string;
  pendingCount: number;
  pendingMailCount?: number;
  sources: { id: string; label: string; kinds: ("todo" | "calendar")[] }[];
}

export interface BridgeProposalPage {
  proposals: BridgeActionProposal[];
  nextCursor?: string;
}

export const PROPOSAL_TOOLS = ["proposal.create", "proposal.update_pending", "proposal.list"] as const;
