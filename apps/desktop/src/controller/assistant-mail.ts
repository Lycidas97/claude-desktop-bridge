import type { BridgeAssistantMailSnapshot, BridgeMailCard, BridgeMailPage, BridgeSessionInfo } from "@bridge/protocol";
import { MailBodyParseError, type AssistantMailService } from "../../../../plugins/assistant-mail/desktop.js";

export function assistantMailSnapshot(
  mail: AssistantMailService,
  sessions: BridgeSessionInfo[],
  available: boolean,
  changeToken: string,
): BridgeAssistantMailSnapshot {
  const binding = mail.binding();
  const session = sessions.find(candidate => candidate.sessionId === binding?.nativeSessionId);
  return {
    ...(binding ? { binding } : {}),
    bindingState: !binding?.nativeSessionId ? binding?.previousSessionIds.length ? "needs-rebind" : "unbound"
      : session?.archivedAt ? "needs-rebind" : !available ? "unavailable" : !session ? "missing" : "ready",
    receiverState: mail.status().state,
    automaticDelivery: false,
    changeToken,
  };
}

/** Only a confirmed archive/delete pauses a binding. Catalog absence is not deletion. */
export function pauseAssistantBinding(mail: AssistantMailService | undefined, sessionId: string): void {
  const binding = mail?.binding();
  if (binding?.nativeSessionId !== sessionId) return;
  mail!.setBinding({ ...binding, nativeSessionId: null,
    previousSessionIds: [...new Set([...binding.previousSessionIds, sessionId])] });
}

export async function assistantMailPage(mail: AssistantMailService, options: Parameters<AssistantMailService["page"]>[0]): Promise<BridgeMailPage> {
  const page = mail.page(options);
  return {
    cards: await Promise.all(page.events.map(async event => {
      let preview: Pick<BridgeMailCard, "preview" | "previewError">;
      try {
        preview = { preview: (await mail.readEvent(event.mailRefId))!.bodyText.slice(0, 240) };
      } catch (error) {
        if (!(error instanceof MailBodyParseError)) throw error;
        preview = { preview: "", previewError: "原文无法解析，预览不可用。" };
      }
      return {
        seq: event.seq, mailRefId: event.mailRefId, accountKey: event.accountKey, mailbox: event.mailbox,
        subject: event.subject, from: event.from, receivedAt: event.receivedAt, recordedAt: event.recordedAt,
        processingStatus: event.processingStatus,
        ...(event.analysis ? { analysis: event.analysis } : {}),
        ...preview,
        nativeDelivery: { state: "not-submitted" },
      } satisfies BridgeMailCard;
    })),
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  };
}
