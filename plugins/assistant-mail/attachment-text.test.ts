import { expect, it } from "vitest";
import { attachmentText } from "./attachment-text.js";

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
