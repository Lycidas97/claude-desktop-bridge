import type { Readable } from "node:stream";
import { MailParser, type AttachmentStream, type MessageText } from "mailparser";
import { convert } from "html-to-text";
import type { BridgeMailAttachment } from "../../packages/protocol/src/assistant-mail.js";

const MAX_HTML_LENGTH = 16 * 1024 * 1024;
const MAX_ATTACHMENTS = 256;

export class MailBodyParseError extends Error {}

export class MailAttachmentError extends Error {
  constructor(readonly code: "MAIL_ATTACHMENT_NOT_FOUND" | "MAIL_ATTACHMENT_TOO_LARGE" | "MAIL_ATTACHMENT_UNSUPPORTED" | "MAIL_ATTACHMENT_NO_TEXT", message: string) {
    super(message);
  }
}

interface ParsedMail {
  bodyText: string;
  bodyError?: MailBodyParseError;
  attachments: BridgeMailAttachment[];
  attachmentCount: number;
  bytes?: Buffer;
  tooLarge?: true;
}

export function cleanMailText(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "");
}

function attachmentName(filename: string | undefined, id: string): string {
  const name = filename?.normalize("NFC").split(/[/\\]/u).at(-1)
    ?.replace(/[\p{Cc}‪-‮⁦-⁩:*?"<>|]/gu, "_").trim().replace(/[. ]+$/u, "") ?? "";
  if (!name) return `attachment-${id}`;
  const extensionIndex = name.lastIndexOf(".");
  const extension = extensionIndex > 0 && name.length - extensionIndex <= 16 ? name.slice(extensionIndex) : "";
  const safe = name.length <= 120 ? name : Array.from(name).slice(0, 120 - extension.length).join("") + extension;
  return /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(safe) ? `_${safe}` : safe;
}

export function parseMail(source: Buffer | Readable, target?: { attachmentId: string; maxBytes: number }): Promise<ParsedMail> {
  return new Promise((resolve, reject) => {
    const parser = new MailParser({
      skipTextToHtml: true, skipImageLinks: true, skipTextLinks: true,
      ignoreEmbedded: true, maxHtmlLengthToParse: MAX_HTML_LENGTH, checksumAlgo: false,
      skipHtmlToText: Boolean(target),
    });
    // Named inline text parts are files, but MailParser treats them as message body.
    const nodes = parser as unknown as {
      createNode(node: { filename?: string; contentType?: string; disposition?: string; headers: { hasHeader(name: string): boolean } }): unknown;
    };
    const createNode = nodes.createNode.bind(parser);
    nodes.createNode = node => {
      if (node.filename && (node.contentType === "text/plain" || node.contentType === "text/html") && !node.headers.hasHeader("content-id")) {
        node.disposition = "attachment";
      }
      return createNode(node);
    };
    const result: ParsedMail = { bodyText: "", attachments: [], attachmentCount: 0 };
    parser.on("data", (part: AttachmentStream | MessageText) => {
      if (part.type === "attachment") {
        const attachmentId = part.partId ?? "0";
        const real = part.contentDisposition === "attachment" || !part.related && (part.contentDisposition !== "inline" || !part.cid || Boolean(part.filename));
        const collect = real && target?.attachmentId === attachmentId;
        const chunks: Buffer[] = [];
        let size = 0;
        if (collect) part.content.on("data", (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size <= target.maxBytes) chunks.push(chunk);
          else chunks.length = 0;
        });
        part.content.on("error", reject);
        part.content.on("end", () => {
          if (real) {
            result.attachmentCount++;
            if (result.attachments.length < MAX_ATTACHMENTS) {
              const header = part.headers.get("content-type");
              const declaredType = header && typeof header === "object" && "value" in header ? String(header.value).toLowerCase() : "";
              const charset = header && typeof header === "object" && "params" in header
                ? (header.params as Record<string, string>).charset?.trim().toLowerCase() : undefined;
              result.attachments.push({ attachmentId, filename: attachmentName(part.filename, attachmentId),
                mimeType: /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(declaredType) && declaredType.length <= 80
                  ? declaredType : "application/octet-stream", size: part.size!,
                ...(charset && /^[a-z0-9._:-]{1,40}$/u.test(charset) ? { charset } : {}) });
            }
            if (collect) {
              if (size > target.maxBytes) result.tooLarge = true;
              else result.bytes = Buffer.concat(chunks, size);
            }
          }
          part.release!();
        });
        part.content.resume();
      } else if (!target) {
        if (part.textConversionError) { result.bodyError = new MailBodyParseError(part.textConversionError.message); return; }
        if (part.text !== undefined) { result.bodyText = part.text; return; }
        if (typeof part.html === "string") {
          if (part.html.length > MAX_HTML_LENGTH) { result.bodyError = new MailBodyParseError("Mail HTML too long for parsing"); return; }
          // MailParser does not synthesize text for every HTML-only multipart layout.
          try { result.bodyText = convert(part.html, { limits: { maxInputLength: MAX_HTML_LENGTH } }); }
          catch (error) { result.bodyError = new MailBodyParseError(String(error)); }
        }
      }
    });
    parser.once("error", error => {
      if (!Buffer.isBuffer(source)) source.destroy();
      reject(new MailBodyParseError(error.message));
    });
    parser.once("end", () => resolve({ ...result, bodyText: cleanMailText(result.bodyText) }));
    if (Buffer.isBuffer(source)) parser.end(source);
    else {
      source.once("error", error => parser.destroy(error));
      source.pipe(parser);
    }
  });
}

export async function mailBodyText(source: Buffer | Readable): Promise<string> {
  const parsed = await parseMail(source);
  if (parsed.bodyError) throw parsed.bodyError;
  return parsed.bodyText;
}
