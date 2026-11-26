import { createRequire as createPdfRequire } from "node:module";
import { dirname, extname, join } from "node:path";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { BridgeMailAttachment } from "../../packages/protocol/src/assistant-mail.js";
import { archiveAttachmentMember, readOfficeSection, withAttachmentZip } from "./attachment-archive.js";
import { cleanMailText, MailAttachmentError } from "./mime.js";

export const MAIL_TEXT_MAX_BYTES = 1024 * 1024;
const MAX_TEXT_CHARS = 64_000;
const MAX_DIRECTORY_PDF_PAGES = 100;

const plainTypes = ["text/plain", "text/markdown", "text/csv", "application/json"];
export function supportsAttachmentText(mimeType: string): boolean {
  return mimeType === "application/pdf" || plainTypes.includes(mimeType);
}

function decodeText(bytes: Buffer, charset: string): string {
  try { return cleanMailText(new TextDecoder(charset, { fatal: true }).decode(bytes)); }
  catch (error) {
    if (!(error instanceof TypeError || error instanceof RangeError)) throw error;
    throw new MailAttachmentError("MAIL_ATTACHMENT_UNSUPPORTED", "附件的文本编码不受支持或内容不符合该编码。");
  }
}

async function withPdf<T>(bytes: Buffer, cMapUrl: string | undefined, use: (document: PDFDocumentProxy) => Promise<T>): Promise<T> {
  const [pdf, worker] = await Promise.all([
    import("pdfjs-dist/legacy/build/pdf.mjs"),
    // The desktop bundle is CommonJS, so the default relative worker URL cannot be used there.
    // @ts-expect-error pdfjs-dist does not publish typings for this worker entrypoint.
    import("pdfjs-dist/legacy/build/pdf.worker.mjs"),
  ]);
  Object.assign(globalThis, { pdfjsWorker: worker });
  const resources = cMapUrl ?? join(dirname(createPdfRequire(import.meta.url).resolve("pdfjs-dist/package.json")), "cmaps") + "/";
  const loading = pdf.getDocument({ data: Uint8Array.from(bytes), cMapUrl: resources, cMapPacked: true, disableFontFace: true, useSystemFonts: false, useWasm: false, stopAtErrors: true });
  try { return await use(await loading.promise); }
  catch (error) {
    if (error instanceof pdf.InvalidPDFException || error instanceof pdf.PasswordException) {
      throw new MailAttachmentError("MAIL_ATTACHMENT_UNSUPPORTED", "PDF 格式无效或需要密码。");
    }
    throw error;
  } finally { await loading.destroy(); }
}

async function pdfPageText(document: PDFDocumentProxy, page: number, offset: number, length: number) {
  const reader = (await document.getPage(page)).streamTextContent().getReader();
  let text = "";
  try {
    while (text.length < length) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const item of value.items) {
        if (!("str" in item)) continue;
        const piece = cleanMailText(item.str) + (item.hasEOL ? "\n" : " ");
        text += piece.slice(offset, offset + length - text.length);
        offset = Math.max(0, offset - piece.length);
        if (text.length >= length) break;
      }
    }
  } finally { await reader.cancel(); }
  return text;
}

/** Legacy bounded reader for grants outside the managed workspace. */
export async function attachmentText(bytes: Buffer, mimeType: string, cMapUrl?: string, charset = "utf-8"): Promise<string> {
  if (mimeType !== "application/pdf") return Array.from(decodeText(bytes, charset).slice(0, MAX_TEXT_CHARS * 2)).slice(0, MAX_TEXT_CHARS).join("");
  return withPdf(bytes, cMapUrl, async document => {
    if (document.numPages > MAX_DIRECTORY_PDF_PAGES) throw new MailAttachmentError("MAIL_ATTACHMENT_TOO_LARGE", "PDF 超过 100 页。");
    let text = "";
    for (let page = 1; page <= document.numPages && text.length < MAX_TEXT_CHARS; page++) {
      text += await pdfPageText(document, page, 0, MAX_TEXT_CHARS - text.length) + "\n";
    }
    if (!text.trim()) throw new MailAttachmentError("MAIL_ATTACHMENT_NO_TEXT", "PDF 没有可提取的文本。");
    return text.slice(0, MAX_TEXT_CHARS).trim();
  });
}

export type AttachmentRange = { offset?: number | undefined; section?: number | undefined; entry?: string | undefined };
function textRange(text: string, offset: number) {
  let end = offset + MAX_TEXT_CHARS;
  if (/[\uD800-\uDBFF]/u.test(text.charAt(end - 1)) && /[\uDC00-\uDFFF]/u.test(text.charAt(end))) end--;
  return { text: text.slice(offset, end), ...(end < text.length ? { nextOffset: end } : {}) };
}

const extensionByMime = new Map([
  ["application/pdf", ".pdf"], ["application/zip", ".zip"], ["application/x-zip-compressed", ".zip"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".docx"],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xlsx"],
  ["application/vnd.openxmlformats-officedocument.presentationml.presentation", ".pptx"],
]);

export async function readAttachmentRange(bytes: Buffer, attachment: Pick<BridgeMailAttachment, "filename" | "mimeType" | "charset">,
  { offset = 0, section = 1, entry }: AttachmentRange, cMapUrl?: string): Promise<{ text: string; nextOffset?: number; nextSection?: number; label?: string; scanned?: true }> {
  const { filename, mimeType, charset } = attachment;
  const extension = extensionByMime.get(mimeType) ?? extname(filename).toLowerCase();
  if (extension === ".zip") {
    if (entry !== undefined) return readAttachmentRange(await archiveAttachmentMember(bytes, entry), { filename: entry, mimeType: "application/octet-stream" }, { offset, section }, cMapUrl);
    return withAttachmentZip(bytes, async (_zip, entries) => textRange(Array.from(entries, ([name, item]) => `${cleanMailText(name)}\t${item.uncompressedSize}`).join("\n"), offset));
  }
  if (entry !== undefined) throw new MailAttachmentError("MAIL_ATTACHMENT_UNSUPPORTED", "仅 ZIP 支持选择归档条目。");
  if (extension === ".docx" || extension === ".pptx" || extension === ".xlsx") {
    const { text, ...info } = await readOfficeSection(bytes, extension === ".docx" ? "docx" : extension === ".pptx" ? "pptx" : "xlsx", section);
    return { ...info, ...textRange(text, offset) };
  }
  if (extension === ".pdf") return withPdf(bytes, cMapUrl, async document => {
    if (section > document.numPages) throw new MailAttachmentError("MAIL_ATTACHMENT_NOT_FOUND", "PDF 没有该页。");
    const text = await pdfPageText(document, section, offset, MAX_TEXT_CHARS + 1);
    const result = textRange(text, 0);
    return { text: result.text.trimEnd(), ...(result.nextOffset !== undefined ? { nextOffset: offset + result.nextOffset }
      : section < document.numPages ? { nextSection: section + 1 } : {}), ...(!offset && !text.trim() ? { scanned: true as const } : {}) };
  });
  if (plainTypes.includes(mimeType) || [".txt", ".md", ".csv", ".json", ".tsv", ".log"].includes(extension)) {
    return textRange(decodeText(bytes, charset ?? "utf-8"), offset);
  }
  throw new MailAttachmentError("MAIL_ATTACHMENT_UNSUPPORTED", "此附件格式不支持提取文本；可下载原件后处理。");
}
