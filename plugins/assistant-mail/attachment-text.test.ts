import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { archiveAttachmentMember } from "./attachment-archive.js";
import { attachmentText, readAttachmentRange } from "./attachment-text.js";

it.each([
  ["document.docx", 1, { text: "Meeting notes\n" }],
  ["workbook.xlsx", 1, { text: "A1=Revenue\tB1=42\t\n", nextSection: 2, label: "Results" }],
  ["workbook.xlsx", 2, { text: "A1=TOTAL\t\n", label: "Totals" }],
  ["slides.pptx", 1, { text: "First slide\n", nextSection: 2 }],
  ["slides.pptx", 2, { text: "Second slide\n" }],
] as const)("reads %s section %d in document order without evaluating spreadsheet formulas", async (filename, section, expected) => {
  const bytes = await readFile(new URL(`./fixtures/attachments/${filename}`, import.meta.url));
  expect(await readAttachmentRange(bytes, { filename, mimeType: "application/octet-stream" }, { section })).toEqual(expected);
});

it("lists a ZIP and reads or saves only an explicitly selected member", async () => {
  const filename = "archive.zip";
  const bytes = await readFile(new URL(`./fixtures/attachments/${filename}`, import.meta.url));
  const attachment = { filename, mimeType: "application/zip" };
  expect(await readAttachmentRange(bytes, attachment, {})).toEqual({ text: "notes/agenda.txt\t18\noriginal.bin\t8" });
  expect(await readAttachmentRange(bytes, attachment, { entry: "notes/agenda.txt" })).toEqual({ text: "Line one\nLine two\n" });
  expect(await archiveAttachmentMember(bytes, "original.bin")).toEqual(Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]));
});

it("continues a text attachment beyond both the response and old byte limits", async () => {
  const content = `${"x".repeat(64_000)}${"y".repeat(1024 * 1024)}END`;
  const bytes = Buffer.from(content);
  const attachment = { filename: "large.txt", mimeType: "text/plain" };
  const start = await readAttachmentRange(bytes, attachment, {});
  expect(start).toEqual({ text: content.slice(0, 64_000), nextOffset: 64_000 });
  expect(await readAttachmentRange(bytes, attachment, { offset: content.length - 3 })).toEqual({ text: "END" });
});

it("extracts only text from a PDF with a standalone parser and worker", async () => {
  const content = "BT /F1 16 Tf 20 100 Td (Bridge PDF text) Tj ET";
  const pdf = Buffer.from(`%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>
endobj
4 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
5 0 obj
<< /Length ${content.length} >>
stream
${content}
endstream
endobj
trailer
<< /Root 1 0 R /Size 6 >>
%%EOF`);
  expect(await attachmentText(pdf, "application/pdf")).toBe("Bridge PDF text");
  await expect(attachmentText(Buffer.from("not a valid PDF"), "application/pdf")).rejects.toMatchObject({ code: "MAIL_ATTACHMENT_UNSUPPORTED" });
});

it("reads PDF page 101 and reports a page without a text layer", async () => {
  const refs = Array.from({ length: 101 }, (_, index) => index + 6);
  const content = "BT /F1 16 Tf 20 100 Td (Last page) Tj ET";
  const pdf = Buffer.from([
    "%PDF-1.4", "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    `2 0 obj << /Type /Pages /Kids [${refs.map(ref => `${ref} 0 R`).join(" ")}] /Count 101 >> endobj`,
    "4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj",
    `5 0 obj << /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj`,
    ...refs.map(ref => `${ref} 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] ${ref === refs.at(-1)
      ? "/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R" : ""} >> endobj`),
    "trailer << /Root 1 0 R /Size 107 >>", "%%EOF",
  ].join("\n"));
  const attachment = { filename: "long.pdf", mimeType: "application/pdf" };
  expect(await readAttachmentRange(pdf, attachment, { section: 100 })).toEqual({ text: "", nextSection: 101, scanned: true });
  expect(await readAttachmentRange(pdf, attachment, { section: 101 })).toEqual({ text: "Last page" });
  await expect(attachmentText(pdf, attachment.mimeType)).rejects.toMatchObject({ code: "MAIL_ATTACHMENT_TOO_LARGE" });
});
