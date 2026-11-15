import { MailParser, type AttachmentStream, type MessageText } from "mailparser";

/** Decode MIME on the host. Attachments are drained, never returned or opened. */
export function mailBodyText(source: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const parser = new MailParser({ skipTextToHtml: true, skipImageLinks: true, skipTextLinks: true });
    let text = "";
    parser.on("data", (part: AttachmentStream | MessageText) => {
      if (part.type === "attachment") {
        part.content.on("end", () => part.release!());
        part.content.on("error", reject);
        part.content.resume();
      } else {
        if (part.textConversionError) { reject(part.textConversionError); return; }
        text = part.text ?? "";
      }
    });
    parser.on("error", reject);
    parser.on("end", () => resolve(text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")));
    parser.end(source);
  });
}
