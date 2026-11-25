import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Readable } from "node:stream";
import { ARTIFACT_MAX_BYTES } from "../../packages/protocol/src/types.js";
import { isMissingPath, withinPath } from "./fs-guard.js";
import { attachmentName, MailAttachmentError } from "./mime.js";
import { domainToASCII } from "node:url";
import { MailParser, type EmailAddress, type Headers, type HeaderValue } from "mailparser";
import type { MailAttachmentSelection, MailProposalAction, MailProposalDraft } from "../../packages/protocol/src/assistant-proposal.js";
import { AssistantError } from "./assistant-error.js";
import type { AssistantMailService } from "./desktop.js";
import { mailbox } from "./account-contract.js";
import type { ProposalPayload } from "./proposal-store.js";

function headerAddresses(header: HeaderValue | undefined): string[] {
  const flatten = (values: EmailAddress[]): string[] => values.flatMap(({ address, group }) => {
    if (group) return flatten(group);
    if (!address) return [];
    const at = address.lastIndexOf("@");
    const parsed = mailbox.safeParse(address.slice(0, at + 1) + domainToASCII(address.slice(at + 1)));
    return parsed.success ? [parsed.data] : [];
  });
  const values = Array.isArray(header) ? header : [header];
  return Array.from(new Set(values.flatMap(value => value && typeof value === "object" && "value" in value && Array.isArray(value.value)
    ? flatten(value.value) : []))).slice(0, 20);
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
      reject(new AssistantError("INVALID_PARAMS", "无法解析原邮件的邮件头。"));
    });
    parser.once("end", () => reject(new AssistantError("INVALID_PARAMS", "原邮件没有可用的邮件头。")));
    source.once("error", error => parser.destroy(error));
    source.pipe(parser);
    parser.resume();
  });
}

const validMessageId = /^<[^\s<>@]+@[^\s<>@]+>$/u;

export async function loadMailAttachments(mail: AssistantMailService, sessionId: string, sources: readonly MailAttachmentSelection[]) {
  const attachments: { filename: string; mimeType: string; content: Buffer; size: number; sha256: string }[] = [];
  let remaining = ARTIFACT_MAX_BYTES;
  for (const source of sources) {
    let filename: string;
    let mimeType = "application/octet-stream";
    let content: Buffer;
    try {
      if ("outputPath" in source) {
        const binding = mail.binding();
        if (binding?.nativeSessionId !== sessionId || !binding.managed || source.outputPath.split("/").includes("..")) {
          throw new AssistantError("CONFLICT", "产物不在当前助理的 outputs/ 中。");
        }
        const workspace = await realpath(binding.managed.path);
        const root = join(workspace, "outputs");
        const path = await realpath(join(workspace, source.outputPath));
        if (!(await lstat(root)).isDirectory() || !withinPath(root, path)) throw new AssistantError("CONFLICT", "产物不在当前助理的 outputs/ 中。");
        const info = await lstat(path);
        if (!info.isFile() || info.nlink !== 1) throw new AssistantError("CONFLICT", "产物必须是工作区内的普通文件。");
        if (info.size > remaining) throw new AssistantError("INVALID_PARAMS", "邮件附件合计不能超过 20 MiB。");
        content = await readFile(path);
        filename = attachmentName(basename(source.outputPath), "output");
      } else {
        ({ filename, mimeType } = mail.attachment(source));
        content = await mail.attachmentBytes(source, remaining);
      }
    } catch (error) {
      if (error instanceof MailAttachmentError || isMissingPath(error)) {
        throw new AssistantError(error instanceof MailAttachmentError && error.code === "MAIL_ATTACHMENT_TOO_LARGE" ? "INVALID_PARAMS" : "CONFLICT",
          error instanceof MailAttachmentError ? error.message : "附件文件找不到了，请修订提案。");
      }
      throw error;
    }
    remaining -= content.length;
    if (remaining < 0) throw new AssistantError("INVALID_PARAMS", "邮件附件合计不能超过 20 MiB。");
    attachments.push({ filename, mimeType, content, size: content.length, sha256: createHash("sha256").update(content).digest("hex") });
  }
  return attachments;
}

export async function freezeMailDraft(mail: AssistantMailService, draft: MailProposalDraft, sessionId: string): Promise<ProposalPayload> {
  const original = draft.kind === "mail.reply" ? mail.replySource(draft.accountKey, draft.mailRefId) : undefined;
  const headers = original && await readHeaders(original.source);
  const account = mail.smtpAccount(draft.accountKey);
  if (!account) throw new AssistantError("INVALID_PARAMS", "请选择已启用且配置了 SMTP 的发件账号。");

  const originalFrom = headerAddresses(headers?.get("from"));
  const originalReplyTo = headerAddresses(headers?.get("reply-to"));
  const to = Array.from(new Set(draft.to ?? originalFrom));
  if (!to.length) throw new AssistantError("INVALID_PARAMS", "原邮件没有可用的发件地址，请明确填写收件人。");
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

  const attachmentSources = draft.attachments?.length ? draft.attachments : undefined;
  if (attachmentSources) {
    action.attachments = (await loadMailAttachments(mail, sessionId, attachmentSources)).map(({ filename, mimeType, size, sha256 }) => ({ filename, mimeType, size, sha256 }));
  }
  return { action, sourceId: draft.accountKey, sourceLabel: account.label,
    intent: { backend: "smtp", channelVersion: account.smtp.version, ...(attachmentSources ? { attachmentSources } : {}) } };
}
