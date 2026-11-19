import type { Readable } from "node:stream";
import { MailParser, type Headers, type HeaderValue } from "mailparser";
import type { MailProposalAction, MailProposalDraft } from "../../packages/protocol/src/assistant-proposal.js";
import { AgendaEditError } from "./agenda-store.js";
import type { AssistantMailService } from "./desktop.js";
import { mailbox } from "./proposal-contract.js";
import type { ProposalPayload } from "./proposal-store.js";

function headerAddresses(header: HeaderValue | undefined): string[] {
  const values = Array.isArray(header) ? header : [header];
  return Array.from(new Set(values.flatMap(value => value && typeof value === "object" && "value" in value && Array.isArray(value.value)
    ? value.value.flatMap(({ address }) => {
      const parsed = mailbox.safeParse(address);
      return parsed.success ? [parsed.data] : [];
    }) : []))).slice(0, 20);
}

function readHeaders(source: Readable): Promise<Headers> {
  return new Promise((resolve, reject) => {
    const parser = new MailParser();
    parser.once("headers", headers => {
      source.destroy();
      parser.destroy();
      resolve(headers);
    });
    parser.once("error", () => {
      source.destroy();
      reject(new AgendaEditError("INVALID_PARAMS", "无法解析原邮件的邮件头。"));
    });
    parser.once("end", () => reject(new AgendaEditError("INVALID_PARAMS", "原邮件没有可用的邮件头。")));
    source.once("error", error => parser.destroy(error));
    source.pipe(parser);
    parser.resume();
  });
}

const validMessageId = /^<[^\s<>@]+@[^\s<>@]+>$/u;

export async function freezeMailDraft(mail: AssistantMailService, draft: MailProposalDraft): Promise<ProposalPayload> {
  const original = draft.kind === "mail.reply" ? mail.replySource(draft.accountKey, draft.mailRefId) : undefined;
  const headers = original && await readHeaders(original.source);
  const account = mail.smtpAccount(draft.accountKey);
  if (!account) throw new AgendaEditError("INVALID_PARAMS", "请选择已启用且配置了 SMTP 的发件账号。");

  const originalFrom = headerAddresses(headers?.get("from"));
  const originalReplyTo = headerAddresses(headers?.get("reply-to"));
  const to = Array.from(new Set(draft.to ?? originalFrom));
  if (!to.length) throw new AgendaEditError("INVALID_PARAMS", "原邮件没有可用的发件地址，请明确填写收件人。");
  const message = {
    accountKey: draft.accountKey, from: account.smtp.from, to,
    cc: Array.from(new Set(draft.cc)).filter(address => !to.includes(address)),
    ...(draft.replyTo ? { replyTo: draft.replyTo } : {}),
    subject: draft.subject ?? `Re: ${original!.subject.replace(/^re:\s*/iu, "").replace(/\p{Cc}/gu, " ")}`.slice(0, 500),
    bodyText: draft.bodyText.replace(/\r\n?/gu, "\n"),
  };
  let action: MailProposalAction;
  if (draft.kind === "mail.reply") {
    const originalId = headers!.get("message-id");
    const referencesHeader = headers!.get("references");
    const inReplyTo = typeof originalId === "string" && originalId.length <= 254 && validMessageId.test(originalId) ? originalId : undefined;
    const references = Array.from(new Set([
      ...(Array.isArray(referencesHeader) ? referencesHeader : typeof referencesHeader === "string" ? [referencesHeader] : [])
        .filter((value): value is string => typeof value === "string").flatMap(value => value.match(/<[^<>]*>/gu) ?? [])
        .filter(value => value.length <= 254 && validMessageId.test(value)),
      ...(inReplyTo ? [inReplyTo] : []),
    ])).slice(-20);
    const domains = originalFrom.map(address => address.split("@")[1]);
    action = { ...message, kind: draft.kind, mailRefId: draft.mailRefId, originalFrom, originalReplyTo,
      replyToDiffers: originalReplyTo.length > 0 && (originalReplyTo.length !== originalFrom.length || originalReplyTo.some(address => !originalFrom.includes(address))),
      foreignReplyTo: originalReplyTo.some(address => !domains.includes(address.split("@")[1])),
      ...(inReplyTo ? { inReplyTo } : {}), ...(references.length ? { references } : {}) };
  } else action = { ...message, kind: draft.kind };

  return { action, sourceId: draft.accountKey, sourceLabel: account.label, intent: { backend: "smtp", channelVersion: account.smtp.version } };
}
