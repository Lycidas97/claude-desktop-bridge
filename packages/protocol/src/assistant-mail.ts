import type { BridgeCapability } from "./types.js";

/** Business projections only. Claude Desktop remains the native execution authority. */
export interface BridgeAssistantBinding {
  assistantId: string;
  nativeSessionId: string | null;
  sectionId: string | null;
  previousSessionIds: string[];
}

export type BridgeMailReceiverState = "disabled" | "connecting" | "connected" | "reconnecting" | "unsupported" | "error" | "closed";

export interface BridgeMailAccount {
  accountKey: string;
  host: string;
  port: number;
  user: string;
  enabled: boolean;
  state: BridgeMailReceiverState;
  errorCode?: string;
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
  /** The native delivery gate is closed. Enabling delivery belongs to a later capability. */
  automaticDelivery: false;
}

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
  size: number;
}

export interface BridgeMailCard {
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
    state: "not-submitted" | "submitting" | "submitted" | "observed" | "uncertain" | "failed";
    nativeSessionId?: string;
    messageId?: string;
    commandId?: string;
  };
}

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
