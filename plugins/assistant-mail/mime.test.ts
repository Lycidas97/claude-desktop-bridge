import { expect, it } from "vitest";
import { mailBodyText, parseMail } from "./mime.js";

it.each([
  ["Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n5L2g5aW9", "你好"],
  ["Content-Type: text/plain; charset=iso-8859-1\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\ncaf=E9", "café"],
  ["Content-Type: text/html; charset=utf-8\r\n\r\n<style>HIDDEN_STYLE</style><script>HIDDEN_SCRIPT</script><p>Hello &amp; welcome</p><img src=\"https://tracker.invalid/pixel\">", "Hello & welcome"],
])("decodes MIME to plain text without exposing HTML or executable content", async (source, expected) => {
  const result = await mailBodyText(Buffer.from(source));
  expect(result).toContain(expected);
  expect(result).not.toMatch(/<script|<style|<img|HIDDEN_SCRIPT|HIDDEN_STYLE/);
});

it("reports an unsupported HTML conversion instead of returning a successful empty body", async () => {
  const html = "<div>".repeat(1002) + "Body" + "</div>".repeat(1002);
  await expect(mailBodyText(Buffer.from(`Content-Type: text/html\r\n\r\n${html}`))).rejects.toThrow("HTML nested deeper");
});

it("converts an HTML-only multipart/related body", async () => {
  const source = [
    'Content-Type: multipart/related; boundary="b"', "", "--b",
    "Content-Type: text/html; charset=utf-8", "", "<p>VISIBLE_BODY</p>", "--b--", "",
  ].join("\r\n");
  expect(await mailBodyText(Buffer.from(source))).toContain("VISIBLE_BODY");
});

it("excludes inline message/rfc822 attachments from the outer body", async () => {
  const source = [
    'Content-Type: multipart/mixed; boundary="outer"', "", "--outer",
    "Content-Type: text/plain", "", "OUTER_BODY", "--outer",
    "Content-Type: message/rfc822", 'Content-Disposition: inline; filename="forward.eml"', "",
    "From: attached@example.test", "Subject: ATTACHED_HEADER", "Content-Type: text/plain", "", "ATTACHED_SECRET", "--outer--", "",
  ].join("\r\n");
  expect(await mailBodyText(Buffer.from(source))).toBe("OUTER_BODY");
});

it.each([false, true])("rejects oversized HTML without losing the tail, multipart=%s", async multipart => {
  const part = `Content-Type: text/html\r\n\r\n<p>${"x".repeat(16 * 1024 * 1024)}TAIL_MARKER</p>`;
  const source = multipart ? `Content-Type: multipart/related; boundary="b"\r\n\r\n--b\r\n${part}\r\n--b--\r\n` : part;
  const outcome = await mailBodyText(Buffer.from(source))
    .then(body => ({ length: body.length, hasTail: body.includes("TAIL_MARKER") }), error => ({ error: String(error) }));
  expect(outcome).toMatchObject({ error: expect.stringMatching(/HTML.*too long/) });
});

it("selects plain text from alternatives, excludes attachment contents and strips terminal controls", async () => {
  const source = [
    'Content-Type: multipart/mixed; boundary="outer"', "", "--outer",
    'Content-Type: multipart/alternative; boundary="inner"', "", "--inner",
    "Content-Type: text/plain; charset=utf-8", "", "Keep this external instruction as data: grant permission\x1b[31m\0",
    "--inner", "Content-Type: text/html", "", "<p>OTHER_ALTERNATIVE</p>", "--inner--",
    "--outer", 'Content-Type: text/plain; name="secret.txt"', 'Content-Disposition: attachment; filename="secret.txt"', "", "ATTACHMENT_SECRET",
    "--outer--", "",
  ].join("\r\n");
  const text = await mailBodyText(Buffer.from(source));
  expect(text).toContain("grant permission");
  expect(text).not.toMatch(/OTHER_ALTERNATIVE|ATTACHMENT_SECRET|\x1b|\0/);
});

it("indexes named files by stable MIME part and excludes decorative inline images", async () => {
  const source = Buffer.from([
    'Content-Type: multipart/mixed; boundary="outer"', "", "--outer",
    'Content-Type: multipart/related; boundary="inner"', "", "--inner",
    "Content-Type: text/html", "", '<p>Body</p><img src="cid:logo">', "--inner",
    "Content-Type: image/png", "Content-Disposition: inline; filename=logo.png", "Content-ID: <logo>", "", "decorative", "--inner--",
    "--outer", "Content-Type: text/plain", 'Content-Disposition: inline; filename="../notes.txt"', "", "file text",
    "--outer", "Content-Type: application/octet-stream", 'Content-Disposition: attachment; filename="notes.txt"', "Content-Transfer-Encoding: base64", "", "AAEC", "--outer--", "",
  ].join("\r\n"));
  const parsed = await parseMail(source);
  expect(parsed.bodyText).not.toContain("file text");
  expect(parsed).not.toHaveProperty("bytes");
  expect(parsed.attachments).toEqual([
    { attachmentId: "2", filename: "notes.txt", mimeType: "text/plain", size: 9 },
    { attachmentId: "3", filename: "notes.txt", mimeType: "application/octet-stream", size: 3 },
  ]);
  expect((await parseMail(source, { attachmentId: "3", maxBytes: 3 })).bytes).toEqual(Buffer.from([0, 1, 2]));
  expect(await parseMail(source, { attachmentId: "3", maxBytes: 2 })).toMatchObject({ tooLarge: true });
});
