import type { AgendaEventInput, AgendaTodoInput } from "./assistant-agenda.js";
import type { BridgeDeliveryState } from "./types.js";
import type { BridgeMailAttachmentRef } from "./assistant-mail.js";

export const ASSISTANT_PROPOSAL_CAPABILITY = "assistant.proposal.v1";
export const ASSISTANT_MEMORY_PROPOSAL_CAPABILITY = "assistant.proposal.memory.v1";
export const ASSISTANT_SESSION_PROPOSAL_CAPABILITY = "assistant.proposal.session.v1";
export const ASSISTANT_SESSION_CREATE_PROPOSAL_CAPABILITY = "assistant.proposal.session-create.v1";

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

export const ASSISTANT_MAIL_PROPOSAL_ATTACHMENTS_CAPABILITY = "assistant.proposal.mail-attachments.v1";
export type MailAttachmentSelection = BridgeMailAttachmentRef | { outputPath: string };
export type MailProposalAttachment = { filename: string; mimeType: string; charset?: string; size: number; sha256: string };

type MailDraftFields = { accountKey: string; cc?: string[] | undefined; replyTo?: string | undefined; bodyText: string;
  attachments?: MailAttachmentSelection[] | undefined };
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
  attachments?: MailProposalAttachment[];
} & (
  | { kind: "mail.send" }
  | { kind: "mail.reply"; mailRefId: string; originalFrom: string[]; originalReplyTo: string[]; replyToDiffers: boolean;
      foreignReplyTo: boolean; inReplyTo?: string; references?: string[] }
);

export type SessionCreateProposalAction = {
  kind: "session.create";
  cwd: string;
  projectId: string | null;
  model: string;
  title?: string | undefined;
  text?: string | undefined;
};

export type SessionProposalAction =
  | { kind: "session.open"; targetSessionId: string }
  | { kind: "session.send"; targetSessionId: string; text: string }
  | SessionCreateProposalAction;

export const SESSION_CREATE_OPTIONS_TOOL = "proposal.session_create_options";

export type ProposalDraftAction = AgendaProposalAction | MailProposalDraft | MemoryRuleProposalAction | SessionProposalAction;

export interface ProposalRevisionRef {
  proposalId: string;
  revision: number;
  payloadHash: string;
}

export type ProposalState = "pending" | "executing" | "applied" | "dismissed" | "conflict" | "failed" | "uncertain" | "delivery_uncertain" | "delivery_partial";

export interface MailSendFailure {
  reason: "connection" | "tls" | "auth" | "rejected" | "credential" | "unconfirmed" | "interrupted";
  responseCode?: number;
}

export interface BridgeActionProposal extends ProposalRevisionRef {
  sessionId: string;
  action: AgendaProposalAction | MailProposalAction | MemoryRuleProposalAction | SessionProposalAction;
  sessionTarget?: { title: string; cwd: string };
  sessionCreateTarget?: { projectName: string; modelName: string };
  sessionCreation?: { sessionId?: string; failure?: "trust-required" | "create" | "model" };
  sessionDelivery?: Extract<BridgeDeliveryState, "submitted" | "session-received" | "queued" | "running" | "completed" | "failed" | "cancelled" | "uncertain">;
  sourceId: string;
  sourceLabel: string;
  before?: AgendaTodoInput | AgendaEventInput;
  profile?: { before: string | null; baseProfileSha256: string };
  state: ProposalState;
  rejectedRecipients?: string[];
  mailSendFailure?: MailSendFailure;
}

export interface BridgeProposalSnapshot {
  changeToken: string;
  pendingCount: number;
  pendingMailCount?: number;
  pendingMailAttachmentCount?: number;
  pendingMemoryCount?: number;
  pendingSessionCount?: number;
  pendingSessionCreateCount?: number;
  sources: { id: string; label: string; kinds: ("todo" | "calendar")[] }[];
}

export interface BridgeProposalPage {
  proposals: BridgeActionProposal[];
  nextCursor?: string;
}

export const PROPOSAL_TOOLS = ["proposal.create", "proposal.update_pending", "proposal.list", SESSION_CREATE_OPTIONS_TOOL] as const;
