/** Business projections only. Claude Desktop remains the native execution authority. */
export interface BridgeAssistantBinding {
  assistantId: string;
  nativeSessionId: string | null;
  sectionId: string | null;
  previousSessionIds: string[];
}

export interface BridgeAssistantMailSnapshot {
  binding?: BridgeAssistantBinding;
  bindingState: "unbound" | "ready" | "unavailable" | "missing" | "needs-rebind";
  receiverState: "disabled" | "connecting" | "connected" | "reconnecting" | "unsupported" | "error" | "closed";
  changeToken: string;
  /** The native delivery gate is closed. Enabling delivery belongs to a later capability. */
  automaticDelivery: false;
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
}

/** Bounded, per-host encrypted client cache, independent of the ordinary message ring. */
export interface BridgeMailCache extends BridgeMailPage {
  changeToken: string;
}
