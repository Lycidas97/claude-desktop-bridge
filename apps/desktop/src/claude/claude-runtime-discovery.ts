import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { BRIDGE_EFFORT_LEVELS, type BridgeModelInfo, type BridgeRuntimeDetection } from "@bridge/protocol";
import { claudeDesktopProfileDirectories } from "../app/platform.js";

const execFileAsync = promisify(execFile);
const GATEWAY_LONG_CONTEXT_TOKENS = 1_000_000;
const GATEWAY_MODELS_TIMEOUT_MS = 4_000;

export interface ClaudeProjectDirectory {
  cwd: string;
  realCwd: string;
}

/** Project grouping only; the Native execution directory stays unchanged. */
export async function discoverClaudeProjectDirectory(cwd: string): Promise<ClaudeProjectDirectory> {
  let projectCwd = cwd;
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"], { windowsHide: true });
    const [gitDir, commonDir] = stdout.replace(/\r?\n$/u, "").split(/\r?\n/u);
    if (gitDir && commonDir && gitDir !== commonDir) {
      const { stdout: worktrees } = await execFileAsync("git", ["-C", cwd, "worktree", "list", "--porcelain", "-z"], { windowsHide: true });
      const primary = worktrees.split("\0\0")[0]!.split("\0");
      if (primary[0]?.startsWith("worktree ") && !primary.includes("bare")) projectCwd = primary[0].slice("worktree ".length);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (typeof code !== "number" && !["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(code ?? "")) throw error;
  }
  return {
    cwd: projectCwd,
    realCwd: await realpath(projectCwd).catch((error: NodeJS.ErrnoException) => {
      if (!["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(error.code ?? "")) throw error;
      return projectCwd;
    }),
  };
}

function credentialRoots(
  home: string,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const profiles = claudeDesktopProfileDirectories(platform, environment, home);
  return [...new Set([...profiles["Claude-3p"], ...profiles.Claude])];
}

async function protectedCredential(
  path: string,
  platform = process.platform,
): Promise<{ path: string; mtimeMs: number } | undefined> {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile()) return undefined;
    if (platform !== "win32" && (metadata.mode & 0o077) !== 0) return undefined;
    await access(path, constants.R_OK);
    return { path, mtimeMs: metadata.mtimeMs };
  } catch {
    return undefined;
  }
}

export async function findClaudeHostCredentials(
  environment: NodeJS.ProcessEnv = process.env,
  home = homedir(),
  roots?: string[],
  platform: NodeJS.Platform = process.platform,
): Promise<string | undefined> {
  if (environment.CLAUDE_CODE_HOST_CREDS_FILE) {
    const explicit = await protectedCredential(environment.CLAUDE_CODE_HOST_CREDS_FILE, platform);
    if (explicit) return explicit.path;
  }
  const candidates: Array<{ path: string; mtimeMs: number }> = [];
  for (const root of roots ?? credentialRoots(home, environment, platform)) {
    let names: string[];
    try {
      names = await readdir(root);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!/^host-creds-[a-z0-9-]+\.json$/iu.test(name)) continue;
      const candidate = await protectedCredential(join(root, name), platform);
      if (candidate) candidates.push(candidate);
    }
  }
  return candidates.sort((left, right) => right.mtimeMs - left.mtimeMs)[0]?.path;
}

export interface ClaudeRuntime {
  environment: NodeJS.ProcessEnv;
  executablePath?: string;
  /** Source file: a Host credential file or the active fixed gateway profile. */
  credentialPath?: string;
  configSource?: BridgeRuntimeDetection["configSource"];
  version?: string;
}

export interface ClaudeGatewayConfig {
  baseUrl: string;
  authToken?: string;
  apiKey?: string;
  authScheme?: "bearer" | "x-api-key";
}

interface HostCredentialsFile {
  env?: Record<string, unknown>;
  ANTHROPIC_BASE_URL?: unknown;
  ANTHROPIC_AUTH_TOKEN?: unknown;
  ANTHROPIC_API_KEY?: unknown;
  CLAUDE_CODE_HOST_AUTH_ENV_VAR?: unknown;
}

interface ConfigLibraryMetaFile {
  appliedId?: unknown;
}

interface ConfigLibraryInferenceModel {
  name?: unknown;
  labelOverride?: unknown;
  prefer1m?: unknown;
  supports1m?: unknown;
}

interface ConfigLibraryEntryFile {
  inferenceProvider?: unknown;
  inferenceGatewayBaseUrl?: unknown;
  inferenceGatewayAuthScheme?: unknown;
  inferenceGatewayApiKey?: unknown;
  inferenceModels?: unknown;
}

interface GatewayModelPayload {
  id?: unknown;
  display_name?: unknown;
  magpie_label?: unknown;
  description?: unknown;
  max_input_tokens?: unknown;
  context_window?: unknown;
  context_length?: unknown;
  supports_1m?: unknown;
  reasoning?: unknown;
  reasoning_levels?: unknown;
  supported_reasoning_levels?: unknown;
}

const MAGPIE_SYNTHETIC_MODEL_RE = /^(?:(?:mythos|claude)-magpie-|anthropic\/magpie-|magpie-)(\d{10})(?:\.anthropic\.([^[\]\s]+))?(\[1m\])?$/iu;

export function magpieModelIdHash(modelId: string): string {
  const baseId = modelId.trim().replace(/\[1m\]$/iu, "");
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(baseId, "utf8")) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return String(hash % 10_000_000_000n).padStart(10, "0");
}

export function parseMagpieSyntheticModelId(
  modelId: string | undefined,
): { hash: string; anthropicModel?: string; longContext: boolean } | undefined {
  if (!modelId) return undefined;
  const match = MAGPIE_SYNTHETIC_MODEL_RE.exec(modelId.trim());
  if (!match) return undefined;
  return {
    hash: match[1]!,
    ...(match[2] ? { anthropicModel: match[2] } : {}),
    longContext: Boolean(match[3]),
  };
}

export function normalizeAnthropicModelSlug(rawModel: string | undefined): string | undefined {
  const trimmed = rawModel?.trim().replace(/\[1m\]$/iu, "");
  if (!trimmed) return undefined;
  const alias = parseMagpieSyntheticModelId(trimmed);
  let candidate = alias ? alias.anthropicModel : trimmed;
  if (!candidate) return undefined;
  const slash = candidate.indexOf("/");
  if (slash >= 0) {
    const provider = candidate.slice(0, slash).toLowerCase();
    if (provider !== "claude" && provider !== "anthropic") return undefined;
    candidate = candidate.slice(slash + 1);
  }
  const normalized = candidate
    .toLowerCase()
    .replace(/^(?:us|eu|apac|au|global)\.anthropic\./u, "")
    .replace(/-v\d+:\d+$/u, "")
    .replace(/-(?:20\d{6}|latest)$/u, "")
    .replace(/(\d)\.(\d)/gu, "$1-$2");
  return normalized || undefined;
}

const KNOWN_UPSTREAM_MODEL_WORDS: Record<string, string> = {
  claude: "Claude",
  opus: "Opus",
  sonnet: "Sonnet",
  haiku: "Haiku",
  fable: "Fable",
  mythos: "Mythos",
  gpt: "GPT",
  gemini: "Gemini",
};

function formatModelSlugLabel(slug: string, longContext: boolean): string | undefined {
  const cleaned = slug
    .trim()
    .replace(/^(?:us|eu|apac|au|global)\.anthropic\./iu, "")
    .replace(/-v\d+:\d+$/iu, "")
    .replace(/-(?:20\d{6}|latest)$/iu, "")
    .replace(/(^|-)(\d+)-(\d+)(?=-|$)/gu, "$1$2.$3");
  const label = cleaned
    .split(/[-_]+/u)
    .filter(Boolean)
    .map((part) => KNOWN_UPSTREAM_MODEL_WORDS[part.toLowerCase()] ?? (/^[a-z]/iu.test(part) ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join(" ");
  if (!label) return undefined;
  return longContext ? `${label} · 1M` : label;
}

export function humanizeMagpieAnthropicModel(rawModel: string | undefined): string | undefined {
  const alias = parseMagpieSyntheticModelId(rawModel);
  if (!alias) return rawModel?.trim() || undefined;
  return alias.anthropicModel ? formatModelSlugLabel(alias.anthropicModel, alias.longContext) : undefined;
}

export function humanizeUpstreamModelId(rawModel: string | undefined): string | undefined {
  const trimmed = rawModel?.trim();
  if (!trimmed || trimmed.toLowerCase() === "default" || trimmed === "<synthetic>") return undefined;
  if (parseMagpieSyntheticModelId(trimmed)) return humanizeMagpieAnthropicModel(trimmed);
  const longContext = /\[1m\]$/iu.test(trimmed);
  const withoutContext = trimmed.replace(/\[1m\]$/iu, "").trim();
  if (!withoutContext) return undefined;
  const slug = withoutContext.includes("/")
    ? withoutContext.slice(withoutContext.lastIndexOf("/") + 1)
    : withoutContext;
  return formatModelSlugLabel(slug, longContext);
}

interface GatewayModelsResponsePayload {
  data?: unknown;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseFixedGatewayEntry(entry: ConfigLibraryEntryFile | undefined): ClaudeGatewayConfig | undefined {
  const baseUrl = nonEmptyString(entry?.inferenceGatewayBaseUrl);
  const key = nonEmptyString(entry?.inferenceGatewayApiKey);
  const scheme = entry?.inferenceGatewayAuthScheme;
  if (
    entry?.inferenceProvider !== "gateway" || !baseUrl || !key ||
    (scheme !== "bearer" && scheme !== "x-api-key")
  ) return undefined;
  const url = URL.parse(baseUrl);
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) return undefined;
  return {
    baseUrl,
    authScheme: scheme,
    ...(scheme === "bearer" ? { authToken: key } : { apiKey: key }),
  };
}

function parseConfigLibraryInferenceModels(rawModels: unknown): BridgeModelInfo[] {
  if (!Array.isArray(rawModels)) return [];
  const results: BridgeModelInfo[] = [];
  const seen = new Set<string>();
  for (const raw of rawModels) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as ConfigLibraryInferenceModel;
    const name = nonEmptyString(item.name);
    const label = nonEmptyString(item.labelOverride);
    if (!name || !label) continue;
    const value = item.prefer1m === true && !/\[1m\]$/iu.test(name) ? `${name}[1m]` : name;
    if (seen.has(value)) continue;
    seen.add(value);
    const supports1m = item.supports1m === true || item.prefer1m === true || /\[1m\]$/iu.test(value);
    results.push({
      value,
      displayName: label,
      ...(supports1m ? { maxInputTokens: GATEWAY_LONG_CONTEXT_TOKENS } : {}),
    });
  }
  return results;
}

async function readGatewayJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function findClaudeFixedGateway(
  environment: NodeJS.ProcessEnv = process.env,
  home = homedir(),
  roots?: string[],
  platform: NodeJS.Platform = process.platform,
  readJson = readGatewayJson,
): Promise<{ path: string; gateway: ClaudeGatewayConfig; inferenceModels: BridgeModelInfo[] } | undefined> {
  for (const root of roots ?? credentialRoots(home, environment, platform)) {
    let entry: ConfigLibraryEntryFile;
    let path: string;
    try {
      const library = join(root, "configLibrary");
      const meta = await readJson(join(library, "_meta.json")) as ConfigLibraryMetaFile;
      const appliedId = nonEmptyString(meta?.appliedId);
      if (!appliedId || !/^[a-z0-9._-]+$/iu.test(appliedId)) continue;
      path = join(library, `${appliedId}.json`);
      if (!await protectedCredential(path, platform)) continue;
      entry = await readJson(path) as ConfigLibraryEntryFile;
    } catch {
      // A profile may have no saved gateway configuration.
      continue;
    }
    const gateway = parseFixedGatewayEntry(entry);
    if (gateway) return { path, gateway, inferenceModels: parseConfigLibraryInferenceModels(entry.inferenceModels) };
  }
  return undefined;
}

interface ClaudeGatewayDiscoveryOptions {
  environment?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
  roots?: string[];
}

export interface ClaudeGatewayDiscovery {
  gateway: ClaudeGatewayConfig | undefined;
  offlineModels?: () => Promise<BridgeModelInfo[]>;
}

export async function discoverClaudeGatewayConfig({ settingsPath, ...options }: ClaudeGatewayDiscoveryOptions & {
  settingsPath?: string;
} = {}): Promise<ClaudeGatewayConfig | undefined> {
  return (await discoverClaudeGateway(options, settingsPath ? () => readGatewayJson(settingsPath) : undefined)).gateway;
}

export async function discoverClaudeGateway(
  options: ClaudeGatewayDiscoveryOptions,
  readSettings?: () => Promise<unknown>,
): Promise<ClaudeGatewayDiscovery> {
  const environment = options.environment ?? process.env;
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  const roots = options.roots ?? credentialRoots(home, environment, platform);
  // Host credential completion and strict fixed-profile discovery can read the same configLibrary files.
  const parsed = new Map<string, Promise<unknown>>();
  const readJson = (path: string) => {
    const existing = parsed.get(path);
    if (existing) return existing;
    const value = readGatewayJson(path);
    parsed.set(path, value);
    return value;
  };
  const findFixed = () => findClaudeFixedGateway(environment, home, roots, platform, readJson);
  const credentialPath = await findClaudeHostCredentials(environment, home, roots, platform);
  if (credentialPath) {
    const gateway = await resolveClaudeGatewayConfig({ credentialPath, environment: {} }, readJson);
    if (gateway) return { gateway, offlineModels: async () => (await findFixed())?.inferenceModels ?? [] };
  }
  const fixed = await findFixed();
  if (fixed) return { gateway: fixed.gateway, offlineModels: async () => fixed.inferenceModels };
  if (readSettings) {
    try {
      const parsed = await readSettings() as HostCredentialsFile;
      if (parsed && typeof parsed.env === "object" && parsed.env !== null && !Array.isArray(parsed.env)) {
        const settingsEnv: NodeJS.ProcessEnv = {};
        for (const key of [
          "ANTHROPIC_BASE_URL",
          "ANTHROPIC_AUTH_TOKEN",
          "ANTHROPIC_API_KEY",
          "CLAUDE_CODE_HOST_AUTH_ENV_VAR",
        ] as const) {
          const value = nonEmptyString(parsed.env[key]);
          if (value) settingsEnv[key] = value;
        }
        const settingsGateway = await resolveClaudeGatewayConfig({ environment: settingsEnv });
        if (settingsGateway) return { gateway: settingsGateway };
      }
    } catch {
      // Optional settings.json may not exist or may be mid-edit.
    }
  }
  return { gateway: await resolveClaudeGatewayConfig({ ...(credentialPath ? { credentialPath } : {}), environment }, readJson) };
}

export async function resolveClaudeGatewayConfig(
  runtime: Pick<ClaudeRuntime, "credentialPath" | "environment"> | undefined,
  readJson = readGatewayJson,
): Promise<ClaudeGatewayConfig | undefined> {
  if (!runtime) return undefined;
  let baseUrl: string | undefined;
  let authToken: string | undefined;
  let apiKey: string | undefined;
  let authScheme: "bearer" | "x-api-key" | undefined;

  if (runtime.credentialPath) {
    try {
      const parsed = await readJson(runtime.credentialPath) as HostCredentialsFile & ConfigLibraryEntryFile;
      const directFixed = parseFixedGatewayEntry(parsed);
      if (directFixed) {
        baseUrl = directFixed.baseUrl;
        authToken = directFixed.authToken;
        apiKey = directFixed.apiKey;
        authScheme = directFixed.authScheme;
      } else {
        const env = parsed && typeof parsed.env === "object" && parsed.env !== null && !Array.isArray(parsed.env)
          ? parsed.env
          : (parsed as Record<string, unknown>);
        baseUrl = nonEmptyString(env?.ANTHROPIC_BASE_URL);
        authToken = nonEmptyString(env?.ANTHROPIC_AUTH_TOKEN);
        apiKey = nonEmptyString(env?.ANTHROPIC_API_KEY);
        if (env?.CLAUDE_CODE_HOST_AUTH_ENV_VAR === "ANTHROPIC_API_KEY") authScheme = "x-api-key";
        else if (env?.CLAUDE_CODE_HOST_AUTH_ENV_VAR === "ANTHROPIC_AUTH_TOKEN") authScheme = "bearer";
      }
    } catch {
      // Ignore unreadable or missing credential files and fall back to configLibrary / environment.
    }

    const parentDir = dirname(runtime.credentialPath);
    const configLibraryDir = basename(parentDir) === "configLibrary" ? parentDir : join(parentDir, "configLibrary");
    try {
      const meta = await readJson(join(configLibraryDir, "_meta.json")) as ConfigLibraryMetaFile;
      const appliedId = nonEmptyString(meta?.appliedId);
      if (appliedId && /^[a-z0-9._-]+$/iu.test(appliedId)) {
        const entry = await readJson(join(configLibraryDir, `${appliedId}.json`)) as ConfigLibraryEntryFile;
        if (entry?.inferenceProvider === "gateway") {
          baseUrl ??= nonEmptyString(entry.inferenceGatewayBaseUrl);
          if (entry.inferenceGatewayAuthScheme === "bearer" || entry.inferenceGatewayAuthScheme === "x-api-key") {
            authScheme ??= entry.inferenceGatewayAuthScheme;
          }
          const gatewayKey = nonEmptyString(entry.inferenceGatewayApiKey);
          if (gatewayKey) {
            if (authScheme === "x-api-key") apiKey ??= gatewayKey;
            else authToken ??= gatewayKey;
          }
        }
      }
    } catch {
      // Optional configLibrary metadata is only present on Claude-3p profiles with a saved gateway.
    }
  }

  baseUrl ??= nonEmptyString(runtime.environment?.ANTHROPIC_BASE_URL);
  authToken ??= nonEmptyString(runtime.environment?.ANTHROPIC_AUTH_TOKEN);
  apiKey ??= nonEmptyString(runtime.environment?.ANTHROPIC_API_KEY);
  if (!authScheme) {
    if (runtime.environment?.CLAUDE_CODE_HOST_AUTH_ENV_VAR === "ANTHROPIC_API_KEY") {
      authScheme = "x-api-key";
    } else if (runtime.environment?.CLAUDE_CODE_HOST_AUTH_ENV_VAR === "ANTHROPIC_AUTH_TOKEN") {
      authScheme = "bearer";
    }
  }

  if (!baseUrl) return undefined;
  try {
    const parsedUrl = new URL(baseUrl);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") return undefined;
  } catch {
    return undefined;
  }
  return {
    baseUrl,
    ...(authToken ? { authToken } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(authScheme ? { authScheme } : {}),
  };
}

export function parseClaudeGatewayModels(items: unknown[]): BridgeModelInfo[] {
  const existingIds = new Set<string>();
  const displayNameCounts = new Map<string, number>();
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as GatewayModelPayload;
    const id = nonEmptyString(item.id);
    if (id) existingIds.add(id.toLocaleLowerCase());
    const rawDisplay = nonEmptyString(item.display_name);
    if (rawDisplay) {
      displayNameCounts.set(rawDisplay, (displayNameCounts.get(rawDisplay) ?? 0) + 1);
    }
  }
  const results: BridgeModelInfo[] = [];
  const seen = new Set<string>();
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as GatewayModelPayload;
    const id = nonEmptyString(item.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const rawDisplay = nonEmptyString(item.display_name);
    const magpieLabel = nonEmptyString(item.magpie_label);
    const displayName = rawDisplay && (displayNameCounts.get(rawDisplay) ?? 0) > 1 && magpieLabel
      ? magpieLabel
      : rawDisplay ?? id;
    const description = nonEmptyString(item.description)
      ?? (magpieLabel && magpieLabel !== displayName ? magpieLabel : undefined);
    const maxInputTokens = [item.max_input_tokens, item.context_window, item.context_length]
      .find((value): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0);
    const rawLevels = Array.isArray(item.supported_reasoning_levels)
      ? item.supported_reasoning_levels
      : Array.isArray(item.reasoning_levels)
        ? item.reasoning_levels
        : undefined;
    const declaredEffortLevels = rawLevels && [...new Set(rawLevels.map((level) => nonEmptyString(
      level && typeof level === "object" ? (level as { effort?: unknown }).effort : level,
    )).filter((level): level is string => level !== undefined))];
    const supportedEffortLevels = declaredEffortLevels && item.reasoning !== false
      ? BRIDGE_EFFORT_LEVELS.filter((level) => declaredEffortLevels.includes(level))
      : undefined;
    const supportsEffort = declaredEffortLevels ? Boolean(supportedEffortLevels?.length)
      : typeof item.reasoning === "boolean" ? item.reasoning : undefined;
    results.push({
      value: id,
      displayName,
      ...(description ? { description } : {}),
      ...(maxInputTokens ? { maxInputTokens } : {}),
      ...(supportsEffort !== undefined ? { supportsEffort } : {}),
      ...(declaredEffortLevels ? { declaredEffortLevels } : {}),
      ...(supportedEffortLevels?.length ? { supportedEffortLevels } : {}),
    });

    const supports1m = typeof item.supports_1m === "boolean"
      ? item.supports_1m
      : typeof item.max_input_tokens === "number" && item.max_input_tokens >= GATEWAY_LONG_CONTEXT_TOKENS;
    const longContextId = `${id}[1m]`;
    if (
      supports1m &&
      !/\[1m\]/iu.test(id) &&
      !existingIds.has(longContextId.toLocaleLowerCase()) &&
      !seen.has(longContextId)
    ) {
      seen.add(longContextId);
      results.push({
        value: longContextId,
        displayName: `${displayName} 1M`,
        description: description ? `${description} · 1M context window` : "1M context window",
        maxInputTokens: GATEWAY_LONG_CONTEXT_TOKENS,
        ...(supportsEffort !== undefined ? { supportsEffort } : {}),
        ...(declaredEffortLevels ? { declaredEffortLevels } : {}),
        ...(supportedEffortLevels?.length ? { supportedEffortLevels } : {}),
      });
    }
  }
  return results;
}

export async function fetchClaudeGatewayModels(
  gateway: ClaudeGatewayConfig | undefined,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = GATEWAY_MODELS_TIMEOUT_MS,
): Promise<BridgeModelInfo[]> {
  if (!gateway) return [];
  const trimmedBase = gateway.baseUrl.replace(/\/+$/u, "");
  const endpoint = `${trimmedBase.endsWith("/v1") ? trimmedBase : `${trimmedBase}/v1`}/models?limit=1000`;
  const headers: Record<string, string> = {
    accept: "application/json",
    "anthropic-version": "2023-06-01",
  };
  if (gateway.authScheme === "x-api-key") {
    const key = gateway.apiKey ?? gateway.authToken;
    if (key) headers["x-api-key"] = key;
  } else {
    const token = gateway.authToken ?? gateway.apiKey;
    if (token) headers.authorization = `Bearer ${token}`;
    if (gateway.apiKey) headers["x-api-key"] = gateway.apiKey;
  }
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new Error("Gateway model discovery request failed");
  }
  if (!response.ok) throw new Error(`Gateway model discovery failed (HTTP ${response.status})`);
  let payload: GatewayModelsResponsePayload;
  try {
    payload = (await response.json()) as GatewayModelsResponsePayload;
  } catch {
    throw new Error("Gateway model discovery returned invalid JSON");
  }
  if (!Array.isArray(payload?.data)) throw new Error("Gateway model discovery returned invalid data");
  return parseClaudeGatewayModels(payload.data);
}
