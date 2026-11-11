import { readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ClaudeDesktopDeveloperSettings } from "../../client/src/runtime/desktop.js";
import { claudeDesktopProfileDirectories, supportsClaudeDesktop } from "./platform.js";

export async function claudeDesktopDeveloperSettings({
  profile,
  enable = false,
  platform = process.platform,
  environment = process.env,
  home = homedir(),
}: {
  profile?: unknown;
  enable?: boolean;
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  home?: string;
} = {}): Promise<ClaudeDesktopDeveloperSettings> {
  if (!supportsClaudeDesktop(platform)) {
    if (enable) throw new Error("目前仅支持 macOS 与 Windows 的 Claude Desktop 开发者工具配置");
    return { supported: false, profiles: [] };
  }
  if (profile !== undefined && profile !== "Claude" && profile !== "Claude-3p") {
    throw new Error("请选择 Claude 或 Claude-3p 配置目录");
  }
  if (enable && profile === undefined) throw new Error("请先选择 Claude Desktop 配置目录");

  const candidates = claudeDesktopProfileDirectories(platform, environment, home);
  const profiles: ClaudeDesktopDeveloperSettings["profiles"] = [];
  for (const id of ["Claude", "Claude-3p"] as const) {
    for (const dir of candidates[id]) {
      try {
        if ((await stat(dir)).isDirectory()) {
          profiles.push({ id, path: join(dir, "developer_settings.json") });
          break;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  const selected = profile ?? (profiles.length === 1 ? profiles[0]!.id : undefined);
  if (!selected) return { supported: true, profiles };
  const target = profiles.find((candidate) => candidate.id === selected);
  if (!target) throw new Error(`未找到 ${selected} 配置目录，请先启动一次 Claude Desktop`);

  let settings: unknown = {};
  try {
    settings = JSON.parse(await readFile(target.path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new Error(`${target.path} 必须是 JSON 对象，原文件未修改`);
  }
  const enabled = (settings as Record<string, unknown>).allowDevTools === true;
  if (enable && !enabled) {
    await writeFile(target.path, `${JSON.stringify({ ...settings, allowDevTools: true }, null, 2)}\n`, "utf8");
  }
  return {
    supported: true, profiles, profile: target.id, path: target.path,
    enabled: enable || enabled, changed: enable && !enabled,
  };
}
