import { lstat, open, opendir, realpath } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import { AssistantError } from "./assistant-error.js";
import { attachmentText, MAIL_TEXT_MAX_BYTES } from "./attachment-text.js";
import { isAssistantReadDirectory, isMcpConfig, overlapsAssistantData, withinPath } from "./fs-guard.js";
import { MailAttachmentError } from "./mime.js";

export class DirectoryReadDenied extends Error {}

export async function readGrantedDirectory(workspace: string, directories: readonly string[], path?: string, cMapUrl?: string) {
  if (path === undefined) return { directories };
  if (!isAssistantReadDirectory(workspace, path)) throw new DirectoryReadDenied();
  const requested = resolve(path);
  if (!directories.some(directory => withinPath(directory, requested)) || isMcpConfig(requested)) throw new DirectoryReadDenied();

  try {
    const physical = await realpath(requested);
    // Grants record physical roots. The exact resolved path must stay in the granted root without aliases.
    if (relative(requested, physical) !== "" || overlapsAssistantData(workspace, physical)) throw new DirectoryReadDenied();
    const info = await lstat(physical);
    if (info.isDirectory()) {
      const entries: { name: string; kind: "directory" | "file" }[] = [];
      for await (const entry of await opendir(physical)) {
        if (isMcpConfig(entry.name) || !(entry.isDirectory() || entry.isFile())) continue;
        if (entries.length === 100) return { entries, truncated: true };
        entries.push({ name: entry.name, kind: entry.isDirectory() ? "directory" : "file" });
      }
      return { entries, truncated: false };
    }
    if (!info.isFile() || info.nlink !== 1) throw new DirectoryReadDenied();
    if (info.size > MAIL_TEXT_MAX_BYTES) throw new MailAttachmentError("MAIL_ATTACHMENT_TOO_LARGE", "文件超过 1 MiB。");
    const file = await open(physical, "r");
    let bytes: Buffer;
    try {
      const chunks: Buffer[] = [];
      // `end` is inclusive. Read one extra byte to detect a file above the limit.
      for await (const chunk of file.createReadStream({ start: 0, end: MAIL_TEXT_MAX_BYTES, autoClose: false })) chunks.push(chunk);
      bytes = Buffer.concat(chunks);
    } finally { await file.close(); }
    if (bytes.length > MAIL_TEXT_MAX_BYTES) throw new MailAttachmentError("MAIL_ATTACHMENT_TOO_LARGE", "文件超过 1 MiB。");
    return { text: await attachmentText(bytes, extname(physical).toLowerCase() === ".pdf" ? "application/pdf" : "text/plain", cMapUrl) };
  } catch (error) {
    if (error instanceof Error && "code" in error && ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes(String(error.code))) {
      throw new AssistantError("NOT_FOUND", "文件或文件夹不可读。");
    }
    throw error;
  }
}
