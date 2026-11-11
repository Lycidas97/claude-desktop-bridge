import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DesktopArchiveRequest } from "../controller/conversation-state-store.js";

async function replaceFile(path: string, contents: string): Promise<void> {
  const temporary = `${path}.bridge-${process.pid}.tmp`;
  await writeFile(temporary, contents, { mode: 0o600 });
  await rename(temporary, path);
}

/**
 * Write a Bridge archive change into Claude Desktop's session record and its
 * archive index. Desktop rewrites every record from memory when it saves, so
 * call this only while Desktop is not running. Returns false when the record
 * no longer exists.
 */
export async function writeDesktopArchiveState(request: DesktopArchiveRequest): Promise<boolean> {
  let contents: string;
  try {
    contents = await readFile(request.metadataPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const record = JSON.parse(contents) as Record<string, unknown>;
  if (record.sessionId !== request.desktopSessionId || record.cliSessionId !== request.sessionId) {
    throw new Error("Claude Desktop 会话记录已指向其他会话");
  }
  if (record.isArchived !== request.archived) {
    record.isArchived = request.archived;
    await replaceFile(request.metadataPath, JSON.stringify(record));
  }
  const indexPath = join(dirname(request.metadataPath), "archived-sessions.idx");
  let index: { v?: unknown; archived?: unknown };
  try {
    index = JSON.parse(await readFile(indexPath, "utf8")) as typeof index;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  // Desktop loads without an index it cannot read, so only keep the format it writes in step.
  if (index.v !== 1 || !Array.isArray(index.archived)) return true;
  const ids = new Set(index.archived as string[]);
  if (ids.has(request.desktopSessionId) === request.archived) return true;
  if (request.archived) ids.add(request.desktopSessionId);
  else ids.delete(request.desktopSessionId);
  await replaceFile(indexPath, JSON.stringify({ v: 1, archived: [...ids].sort() }));
  return true;
}
