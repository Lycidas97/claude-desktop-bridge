import { MailParser, type AttachmentStream, type MessageText } from "mailparser";
import { convert } from "html-to-text";

const MAX_HTML_LENGTH = 16 * 1024 * 1024;

export class MailBodyParseError extends Error {}

/** Decode MIME on the host. Attachments are drained, never returned or opened. */
export function mailBodyText(source: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const parser = new MailParser({
      skipTextToHtml: true, skipImageLinks: true, skipTextLinks: true,
      ignoreEmbedded: true, maxHtmlLengthToParse: MAX_HTML_LENGTH,
    });
    let text = "";
    parser.on("data", (part: AttachmentStream | MessageText) => {
      if (part.type === "attachment") {
        part.content.on("end", () => part.release!());
        part.content.on("error", reject);
        part.content.resume();
      } else {
        if (part.textConversionError) { reject(new MailBodyParseError(part.textConversionError.message)); return; }
        if (part.text !== undefined) { text = part.text; return; }
        if (typeof part.html === "string") {
          if (part.html.length > MAX_HTML_LENGTH) { reject(new MailBodyParseError("Mail HTML too long for parsing")); return; }
          // MailParser does not synthesize text for every HTML-only multipart layout.
          try { text = convert(part.html, { limits: { maxInputLength: MAX_HTML_LENGTH } }); }
          catch (error) { reject(error); }
        }
      }
    });
    parser.on("error", error => reject(new MailBodyParseError(error.message)));
    parser.on("end", () => resolve(text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")));
    parser.end(source);
  });
}
