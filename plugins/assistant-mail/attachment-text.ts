import { createRequire as createPdfRequire } from "node:module";
import { dirname, join, sep } from "node:path";
import { cleanMailText, MailAttachmentError } from "./mime.js";

export const MAIL_TEXT_MAX_BYTES = 1024 * 1024;
const MAX_TEXT_CHARS = 64_000;
const MAX_PDF_PAGES = 100;

export function supportsAttachmentText(mimeType: string): boolean {
  return ["text/plain", "text/markdown", "text/csv", "application/json", "application/pdf"].includes(mimeType);
}

export async function attachmentText(bytes: Buffer, mimeType: string, cMapUrl?: string, charset = "utf-8"): Promise<string> {
  if (mimeType !== "application/pdf") {
    let text: string;
    try { text = new TextDecoder(charset, { fatal: true }).decode(bytes); }
    catch (error) {
      if (!(error instanceof TypeError || error instanceof RangeError)) throw error;
      throw new MailAttachmentError("MAIL_ATTACHMENT_UNSUPPORTED", "附件的文本编码不受支持或内容不符合该编码。");
    }
    return Array.from(cleanMailText(text).slice(0, MAX_TEXT_CHARS * 2)).slice(0, MAX_TEXT_CHARS).join("");
  }

  const [pdf, worker] = await Promise.all([
    import("pdfjs-dist/legacy/build/pdf.mjs"),
    // The desktop bundle is CommonJS, so the default relative worker URL cannot be used there.
    // @ts-expect-error pdfjs-dist does not publish typings for this worker entrypoint.
    import("pdfjs-dist/legacy/build/pdf.worker.mjs"),
  ]);
  Object.assign(globalThis, { pdfjsWorker: worker });
  const resources = cMapUrl ?? join(dirname(createPdfRequire(import.meta.url).resolve("pdfjs-dist/package.json")), "cmaps") + sep;
  const loading = pdf.getDocument({ data: Uint8Array.from(bytes), cMapUrl: resources, cMapPacked: true, disableFontFace: true, useSystemFonts: false, useWasm: false, stopAtErrors: true });
  try {
    const document = await loading.promise;
    if (document.numPages > MAX_PDF_PAGES) throw new MailAttachmentError("MAIL_ATTACHMENT_TOO_LARGE", "PDF 超过 100 页。");
    let text = "";
    for (let page = 1; page <= document.numPages && text.length < MAX_TEXT_CHARS; page++) {
      const reader = (await document.getPage(page)).streamTextContent().getReader();
      try {
        while (text.length < MAX_TEXT_CHARS) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const item of value.items) {
            if (!("str" in item)) continue;
            text += cleanMailText(item.str).slice(0, MAX_TEXT_CHARS - text.length) + (item.hasEOL ? "\n" : " ");
            if (text.length >= MAX_TEXT_CHARS) break;
          }
        }
      } finally { await reader.cancel(); }
      if (text.length < MAX_TEXT_CHARS) text += "\n";
    }
    if (!text.trim()) throw new MailAttachmentError("MAIL_ATTACHMENT_NO_TEXT", "PDF 没有可提取的文本。");
    return text.slice(0, MAX_TEXT_CHARS).trim();
  } catch (error) {
    if (error instanceof pdf.InvalidPDFException || error instanceof pdf.PasswordException) {
      throw new MailAttachmentError("MAIL_ATTACHMENT_UNSUPPORTED", "PDF 格式无效或需要密码。");
    }
    throw error;
  } finally { await loading.destroy(); }
}
