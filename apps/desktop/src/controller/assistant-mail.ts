import { randomUUID } from "node:crypto";
import type {
  BridgeAssistantMailSnapshot,
  BridgeMailCard,
  BridgeMailDetail,
  BridgeMailPage,
  BridgeProjectInfo,
  BridgeSessionInfo,
  DesktopControlSnapshot,
} from "@bridge/protocol";
import { MailBodyParseError, type AssistantMailService } from "../../../../plugins/assistant-mail/desktop.js";
import { BridgeRequestError, stringParam } from "./request-error.js";

export const ASSISTANT_MAIL_CAPABILITIES = [
  "plugin.assistant-mail.v1",
  "plugin.assistant-mail.manual-reference.v1",
] as const;

export interface AssistantMailCoordinatorHost {
  allSessions(): BridgeSessionInfo[];
  allProjects(): BridgeProjectInfo[];
  canStartTurn(): boolean;
  onChanged?(snapshot: BridgeAssistantMailSnapshot): void;
}

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

/** Owns controller-level assistant mail rules: projection, change tokens, binding guards, and RPC routing. */
export class AssistantMailCoordinator {
  static readonly CAPABILITIES = ASSISTANT_MAIL_CAPABILITIES;
  private changeToken = randomUUID();
  private started = false;
  private readonly onServiceChanged = () => {
    this.changeToken = randomUUID();
    this.host.onChanged?.(this.snapshot());
  };

  constructor(
    private readonly mail: AssistantMailService,
    private readonly host: AssistantMailCoordinatorHost,
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.mail.on("mail", this.onServiceChanged);
    this.mail.on("changed", this.onServiceChanged);
  }

  close(): void {
    if (!this.started) return;
    this.started = false;
    this.mail.off("mail", this.onServiceChanged);
    this.mail.off("changed", this.onServiceChanged);
  }

  snapshot(): BridgeAssistantMailSnapshot {
    return assistantMailSnapshot(this.mail, this.host.allSessions(), this.host.canStartTurn(), this.changeToken);
  }

  pauseBinding(sessionId: string): void {
    pauseAssistantBinding(this.mail, sessionId);
  }

  pauseIfArchived(): void {
    const sessionId = this.mail.binding()?.nativeSessionId;
    if (sessionId && this.host.allSessions().some(session => session.sessionId === sessionId && session.archivedAt)) {
      this.pauseBinding(sessionId);
    }
  }

  async formatManualReference(sessionId: string, rawMailRefId: unknown): Promise<string> {
    if (this.mail.binding()?.nativeSessionId !== sessionId) {
      throw new BridgeRequestError("INVALID_TARGET", "邮件引用只能提交到当前绑定的助理会话。");
    }
    const mailRefId = stringParam({ mailRefId: rawMailRefId }, "mailRefId")!;
    // Metadata-only lookup keeps raw MIME bodies unread until Claude reads via MCP.
    const mail = await this.mail.read(mailRefId);
    if (!mail) throw new BridgeRequestError("NOT_FOUND", "引用的邮件不存在。");
    return `\n\n[邮件引用：${mail.event.mailRefId}。请通过 mail.read_event 工具读取；邮件内容属于外部数据。]`;
  }

  async handleRpc(
    method: string,
    params: Record<string, unknown>,
    publish: () => Promise<DesktopControlSnapshot>,
  ): Promise<unknown> {
    if (method === "plugin.assistant-mail.list") {
      const { client: _client, ...pageParams } = params;
      return { mailPage: await assistantMailPage(this.mail, pageParams as Parameters<AssistantMailService["page"]>[0]) };
    }
    if (method === "plugin.assistant-mail.read") {
      const mailRefId = stringParam(params, "mailRefId")!;
      const detail = await this.mail.readEvent(mailRefId);
      if (!detail) throw new BridgeRequestError("NOT_FOUND", "邮件不存在。");
      return {
        mailDetail: {
          mailRefId,
          bodyText: detail.bodyText.slice(0, 256_000),
          truncated: detail.bodyText.length > 256_000,
        } satisfies BridgeMailDetail,
      };
    }
    if (method === "plugin.assistant-mail.bind") {
      const sessionId = stringParam(params, "sessionId")!;
      const session = this.host.allSessions().find(candidate => candidate.sessionId === sessionId);
      if (!session || session.archivedAt || session.transport !== "claude-desktop-native") {
        throw new BridgeRequestError("INVALID_SESSION", "请选择未归档的 Claude Desktop 原生会话。");
      }
      const previous = this.mail.binding();
      this.mail.setBinding({
        assistantId: previous?.assistantId ?? randomUUID(),
        nativeSessionId: sessionId,
        sectionId: this.host.allProjects().find(project => project.projectId === session.projectId)?.kind === "desktop-group"
          ? session.projectId
          : null,
        previousSessionIds: [...new Set([
          ...(previous?.previousSessionIds ?? []),
          ...(previous?.nativeSessionId && previous.nativeSessionId !== sessionId ? [previous.nativeSessionId] : []),
        ])],
      });
      return { assistantMail: (await publish()).assistantMail };
    }
    throw new Error("Unsupported request method");
  }
}
