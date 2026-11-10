import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { BridgeModelInfo } from "@bridge/protocol";

export interface ConnectorPaths {
  claudeDesktop: string[];
  claudeCode: string;
  claudeSettings: string;
}

interface ClaudeConfig {
  mcpServers?: Record<string, unknown>;
  hooks?: Record<string, unknown>;
  [key: string]: unknown;
}

export const BRIDGE_HOOK_URL = "http://127.0.0.1:8790/hooks/claude";

async function readJson(path: string): Promise<ClaudeConfig> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as ClaudeConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    if (error instanceof SyntaxError) throw new Error("Claude configuration is not valid JSON");
    throw error;
  }
}

async function writeJsonSafely(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  try {
    await readFile(path);
    await writeFile(`${path}.bridge-backup`, await readFile(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function removeBridgeHooks(config: ClaudeConfig): boolean {
  let changed = false;
  const nextHooks: Record<string, unknown> = {};
  for (const [event, handlersValue] of Object.entries(config.hooks ?? {})) {
    if (!Array.isArray(handlersValue)) {
      nextHooks[event] = handlersValue;
      continue;
    }
    const handlers = handlersValue.flatMap((handler) => {
      if (!isRecord(handler) || !Array.isArray(handler.hooks)) return [handler];
      const hooks = handler.hooks.filter((candidate) => !(
        isRecord(candidate)
        && candidate.type === "http"
        && (
          candidate.url === BRIDGE_HOOK_URL
          || (
            typeof candidate.url === "string"
            && /^http:\/\/127\.0\.0\.1:\d+\/hooks\/claude-permission$/u.test(candidate.url)
            && isRecord(candidate.headers)
            && candidate.headers["X-Bridge-Permission-Host"] === "$BRIDGE_PERMISSION_HOST"
            && Array.isArray(candidate.allowedEnvVars)
            && candidate.allowedEnvVars.includes("BRIDGE_PERMISSION_HOST")
          )
        )
      ));
      if (hooks.length === handler.hooks.length) return [handler];
      changed = true;
      return hooks.length > 0 ? [{ ...handler, hooks }] : [];
    });
    if (handlers.length > 0 || handlersValue.length === 0) nextHooks[event] = handlers;
    else changed = true;
  }
  if (changed) config.hooks = nextHooks;
  return changed;
}

/** Read the saved picker directory without exposing settings, descriptions or environment. */
export async function readClaudeModelOptions(settingsPath: string): Promise<BridgeModelInfo[] | undefined> {
  const settings = await readJson(settingsPath);
  if (!isRecord(settings) || !isRecord(settings.modelPicker) || !Array.isArray(settings.modelPicker.options)) return undefined;
  const models = settings.modelPicker.options.flatMap(option =>
    isRecord(option) && typeof option.model === "string" && option.model.length > 0 && typeof option.label === "string" && option.label.length > 0
      ? [{ value: option.model, displayName: option.label }] : []);
  return models.length ? models : undefined;
}

export async function removeLegacyConnector(paths: ConnectorPaths): Promise<boolean> {
  let changed = false;
  for (const path of [...paths.claudeDesktop, paths.claudeCode]) {
    const config = await readJson(path);
    if (config.mcpServers?.["claude-bridge"] === undefined) continue;
    const mcpServers = { ...config.mcpServers };
    delete mcpServers["claude-bridge"];
    if (Object.keys(mcpServers).length > 0) config.mcpServers = mcpServers;
    else delete config.mcpServers;
    await writeJsonSafely(path, config);
    changed = true;
  }
  const settings = await readJson(paths.claudeSettings);
  if (removeBridgeHooks(settings)) {
    await writeJsonSafely(paths.claudeSettings, settings);
    changed = true;
  }
  return changed;
}
