import { expect, it } from "vitest";
import { mailBodyText } from "./mime.js";

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
