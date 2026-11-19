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

export const ASSISTANT_SMTP_CAPABILITY = "plugin.assistant-mail.smtp.v1";

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
}

export const ASSISTANT_WORKSPACE_POLICY = "stage1-fenced-workspace";

export interface BridgeAssistantWorkspace {
  path: string;
  policy: typeof ASSISTANT_WORKSPACE_POLICY;
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
  accountConfigError?: "mail_account_config_unavailable";
  credentialsSupported?: boolean;
  workspace?: BridgeAssistantWorkspace;
  changeToken: string;
  history?: { available: boolean; loading: boolean; failed: boolean };
  /** User opt-in. A missing session or invalid policy can still pause submissions. */
  automaticDelivery: boolean;
  automaticDeliveryAvailable?: boolean;
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

export interface BridgeMailCard {
  /** Descending list order: positive for live arrivals, negative for historical imports. */
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
  analysis?: { summary?: string; suggestions?: string[]; questions?: string[] };
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
