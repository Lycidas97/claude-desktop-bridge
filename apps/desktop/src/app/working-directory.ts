import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";

/** The filesystem boundary shared by browsing and session creation. */
export async function accessibleDirectory(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error("Working directory path must be absolute");
  const normalized = normalize(path);
  if (!(await stat(normalized)).isDirectory()) throw new Error("Working directory path must be a directory");
  await access(normalized, constants.R_OK | constants.X_OK);
  return normalized;
}
