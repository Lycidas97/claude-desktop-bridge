import { readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ClaudeDesktopDeveloperSettings } from "@bridge/protocol";
import { claudeDesktopProfileDirectories, supportsClaudeDesktop } from "./platform.js";

export async function claudeDesktopDeveloperSettings({
  profile,
  enable = false,
  platform = process.platform,
  environment = process.env,
  home = homedir(),
  requestAccess,
}: {
  profile?: unknown;
  enable?: boolean;
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  home?: string;
  requestAccess?(directory: string): Promise<void>;
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
    let blocked: ClaudeDesktopDeveloperSettings["profiles"][number] | undefined;
    for (const dir of candidates[id]) {
      const candidate = { id, path: join(dir, "developer_settings.json") };
      try {
        if ((await stat(dir)).isDirectory()) {
          profiles.push(candidate);
          blocked = undefined;
          break;
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EPERM" || code === "EACCES") blocked ??= { ...candidate, accessRequired: true };
        else if (code !== "ENOENT") throw error;
      }
    }
    if (blocked) profiles.push(blocked);
  }
  const selected = profile ?? (profiles.length === 1 ? profiles[0]!.id : undefined);
  if (!selected) return { supported: true, profiles };
  const target = profiles.find((candidate) => candidate.id === selected);
  if (!target) throw new Error(`未找到 ${selected} 配置目录，请先启动一次 Claude Desktop`);
  const result = { supported: true, profiles, profile: target.id, path: target.path };
  if (!enable && target.accessRequired) return { ...result, accessRequired: true };

  // Retry only after the user's explicit directory selection. Always reread the file
  // before merging, including when the first write was refused.
  for (let attempt = 0; ; attempt++) {
    try {
      let settings: unknown = {};
      try {
        settings = JSON.parse(await readFile(target.path, "utf8"));
      } catch (error) {
        if (error instanceof SyntaxError) throw new Error(`${target.path} 不是有效 JSON，原文件未修改`);
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
        throw new Error(`${target.path} 必须是 JSON 对象，原文件未修改`);
      }
      const enabled = (settings as Record<string, unknown>).allowDevTools === true;
      if (enable && !enabled) {
        await writeFile(target.path, `${JSON.stringify({ ...settings, allowDevTools: true }, null, 2)}\n`, "utf8");
      }
      return { ...result, enabled: enable || enabled, changed: enable && !enabled };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EACCES") throw error;
      if (!enable) return { ...result, accessRequired: true };
      if (!requestAccess) throw error;
      if (attempt > 0) {
        throw new Error(
          `仍无法访问 ${dirname(target.path)}。${platform === "darwin" ? "请在 macOS「系统设置 → 隐私与安全性」允许 Bridge 访问其他 App 的数据后重试；" : ""}原配置未修改。`,
          { cause: error },
        );
      }
      await requestAccess(dirname(target.path));
    }
  }
}
