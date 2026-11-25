import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

export type ClaudeCdpPatchRun = (
  file: string,
  args: string[],
  options: { encoding: "utf8"; timeout: number; maxBuffer: number },
) => Promise<{ stdout: string; stderr: string }>;

const runPatch = promisify(execFile) as unknown as ClaudeCdpPatchRun;

/**
 * Optional cold-start preparation from `userData/claude-cdp-patch-v1.json`
 * (`{"script": "<absolute path>"}`). Bridge carries no patch bytes; the
 * user-owned script receives the bundle path and must be idempotent.
 * Returns a user-facing note only when the script fails.
 */
export async function applyClaudeCdpPatch(options: {
  configPath: string;
  target: string;
  run?: ClaudeCdpPatchRun;
}): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await readFile(options.configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const script = (JSON.parse(raw) as { script?: unknown } | null)?.script;
  if (typeof script !== "string" || !script.startsWith("/")) {
    throw new Error(`${options.configPath} 的 "script" 必须是绝对路径。`);
  }
  try {
    await (options.run ?? runPatch)("/usr/bin/python3", ["-I", script, "--app", options.target], {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    return undefined;
  } catch (error) {
    const failure = error as { stderr?: string; message?: string };
    const reason = (failure.stderr?.trim() || failure.message || String(error)).split("\n")[0];
    return `调试补丁未应用：${reason}`;
  }
}
