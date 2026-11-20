import type { BridgeCapability } from "./types.js";

/** Business projections only. Claude Desktop remains the native execution authority. */
export interface BridgeAssistantBinding {
  assistantId: string;
  nativeSessionId: string | null;
  sectionId: string | null;
  previousSessionIds: string[];
}

export type BridgeMailReceiverState = "disabled" | "connecting" | "connected" | "reconnecting" | "unsupported" | "error" | "closed";

export const MAIL_POLL_INTERVALS = [30, 60, 120] as const;
export const DEFAULT_MAIL_POLL_INTERVAL = 60;
export type MailPollInterval = (typeof MAIL_POLL_INTERVALS)[number] | null;

export function isMailPollInterval(value: unknown): value is MailPollInterval {
  return value === null || MAIL_POLL_INTERVALS.some(seconds => value === seconds);
}

export const ASSISTANT_MAIL_SHARED_AUTH_CAPABILITY = "plugin.assistant-mail.shared-auth.v1";
export const ASSISTANT_SMTP_CAPABILITY = "plugin.assistant-mail.smtp.v1";
export const MAIL_ATTENTION_LEVELS = ["ignore", "read", "action"] as const;
export type MailAttentionLevel = (typeof MAIL_ATTENTION_LEVELS)[number];
export const ASSISTANT_MAIL_FILING_CAPABILITY = "plugin.assistant-mail.filing.v1";
export const ASSISTANT_MAIL_CATEGORIES_CAPABILITY = "plugin.assistant-mail.categories.v1";
export const ASSISTANT_MAIL_RECEIVED_ORDER_CAPABILITY = "plugin.assistant-mail.received-order.v1";
export const ASSISTANT_ATTENTION_CAPABILITY = "plugin.assistant-mail.attention.v1";

export type AssistantAttentionItem = { id: string; title: string } & (
  | { kind: "mail"; reason: "new" | "unscreened" | "read" | "action" }
  | { kind: "event"; startAt: string }
  | { kind: "todo" }
  | { kind: "reply"; sessionId: string }
);
export type AssistantAttentionAcknowledgment = "mail" | "mail-action" | "event" | "reply";

export interface BridgeSmtpChannel {
  host: string;
  port: number;
  security: "tls" | "starttls";
  user: string;
  from: string;
}

export interface BridgeMailAccount {
  accountKey: string;
  host: string;
  port: number;
  user: string;
  enabled: boolean;
  state: BridgeMailReceiverState;
  pollIntervalSeconds?: MailPollInterval;
  receivingMode?: "polling";
  errorCode?: string;
  smtp?: BridgeSmtpChannel;
  smtpSharedAuth?: true;
}

export const ASSISTANT_WORKSPACE_POLICY = "stage1-fenced-workspace";
export const ASSISTANT_MEMORY_POLICY = "stage3-fenced-memory";
export type AssistantWorkspacePolicy = typeof ASSISTANT_WORKSPACE_POLICY | typeof ASSISTANT_MEMORY_POLICY;

export function isAssistantWorkspacePolicy(value: unknown): value is AssistantWorkspacePolicy {
  return value === ASSISTANT_WORKSPACE_POLICY || value === ASSISTANT_MEMORY_POLICY;
}

export interface BridgeAssistantWorkspace {
  path: string;
  policy: AssistantWorkspacePolicy;
  nativeSessionId?: string;
  toolIsolation: "unobserved" | "compatible" | "warning";
  unexpectedTools?: string[];
  repairFailed?: true;
}

export interface BridgeAssistantMailSnapshot {
  binding?: BridgeAssistantBinding;
  bindingState: "unbound" | "ready" | "unavailable" | "missing" | "needs-rebind";
  receiverState: BridgeMailReceiverState;
  accounts?: BridgeMailAccount[];
  categories?: BridgeMailCategoryEntry[];
  accountConfigError?: "mail_account_config_unavailable";
  credentialsSupported?: boolean;
  workspace?: BridgeAssistantWorkspace;
  changeToken: string;
  history?: { available: boolean; loading: boolean; failed: boolean };
  /** User opt-in. A missing session or invalid policy can still pause submissions. */
  automaticDelivery: boolean;
  automaticDeliveryAvailable?: boolean;
  attention?: AssistantAttentionItem[];
}

export type AssistantTriggerKind = "mail.received" | "todo.due" | "calendar.upcoming" | "schedule.tick";

export function mailAttachmentPreviewKind(mimeType: string): "image" | "pdf" | "text" | undefined {
  if (mimeType === "image/png" || mimeType === "image/jpeg") return "image";
  if (mimeType === "application/pdf") return "pdf";
  if (["text/plain", "text/markdown", "text/csv", "application/json", "text/html", "application/xhtml+xml"].includes(mimeType)) return "text";
  return undefined;
}

export interface BridgeMailAttachmentRef {
  mailRefId: string;
  attachmentId: string;
}

export interface BridgeMailAttachment {
  attachmentId: string;
  filename: string;
  mimeType: string;
  charset?: string;
  size: number;
}

export const MAIL_JUNK_CATEGORY_ID = "marketing";
export const MAIL_CATEGORY_LABEL_MAX = 60;
export type BridgeMailCategory = string;
export type BridgeMailFolder = string;

export interface BridgeMailCategoryEntry {
  id: BridgeMailCategory;
  label: string;
}

/** Initial host catalog and the fixed vocabulary of older clients and hosts. */
export const DEFAULT_MAIL_CATEGORIES: readonly BridgeMailCategoryEntry[] = [
  { id: MAIL_JUNK_CATEGORY_ID, label: "营销与垃圾邮件" },
  { id: "verification", label: "验证码" },
  { id: "account", label: "账号注册" },
  { id: "other", label: "其他" },
];

export type BridgeMailCategoryChange =
  | { action: "add"; label: string }
  | { action: "rename"; id: BridgeMailCategory; label: string }
  | { action: "delete"; id: BridgeMailCategory };


export interface BridgeMailCard {
  /** Insertion sequence: positive for live arrivals, negative for historical imports. */
  seq: number;
  mailRefId: string;
  accountKey: string;
  mailbox: "INBOX";
  subject: string;
  from: Array<{ name?: string | undefined; address?: string | undefined }>;
  receivedAt: string;
  recordedAt: number;
  preview: string;
  previewError?: string;
  attachments?: BridgeMailAttachment[];
  attachmentCount?: number;
  processingStatus: "pending" | "processing" | "processed";
  /** Read on the Bridge host, independent of IMAP Seen and business processing. */
  hostRead?: true;
  folder?: BridgeMailCategory;
  analysis?: { summary?: string; suggestions?: string[]; questions?: string[]; category?: BridgeMailCategory | undefined; attention?: MailAttentionLevel | undefined };
  /** Correlation supplied by the host, never inferred from mail or transcript text. */
  nativeDelivery: {
    state: "not-submitted" | "pending" | "paused" | "submitting" | "submitted" | "queued" | "observed" | "uncertain" | "failed" | "cancelled";
    batchId?: string;
    readyAt?: number;
    nativeSessionId?: string;
    messageId?: string;
    previousMessageIds?: string[];
    commandId?: string;
  };
}

/** `plugin.assistant-mail.list` includes historical cards only with `includeHistory: true` on a history-capable host. */
export interface BridgeMailPage {
  cards: BridgeMailCard[];
  nextCursor?: string;
  /** Orders both cards and cursors. Omitted for legacy sequence order. */
  order?: "received";
  folderCounts?: Partial<Record<BridgeMailCategory, number>>;
  /** Filed live cards for legacy sequence-order inboxes. */
  filedTimelineCards?: BridgeMailCard[];
  /** Recent live cards absent from the receipt-order first page, for the assistant conversation. */
  timelineCards?: BridgeMailCard[];
}

export interface BridgeMailDetail {
  mailRefId: string;
  bodyText: string;
  truncated: boolean;
  attachments?: BridgeMailAttachment[];
  attachmentCount?: number;
}

/** Bounded, per-host encrypted client cache, independent of the ordinary message ring. */
export interface BridgeMailCache extends BridgeMailPage {
  changeToken: string;
  workspace?: { capabilities: BridgeCapability[]; assistantMail?: BridgeAssistantMailSnapshot };
}
