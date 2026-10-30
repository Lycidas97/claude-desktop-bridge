import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { BridgeEffort, BridgeModelInfo } from "@bridge/protocol";

const execFileAsync = promisify(execFile);
const GATEWAY_EFFORT_LEVELS = new Set<BridgeEffort>(["low", "medium", "high", "xhigh", "max"]);
const GATEWAY_LONG_CONTEXT_TOKENS = 1_000_000;
const GATEWAY_MODELS_TIMEOUT_MS = 4_000;

function pathIsWithin(root: string, candidate: string): boolean {
  const relation = relative(resolve(root), resolve(candidate));
  return relation === "" || (
    relation !== ".." &&
    !relation.startsWith(`..${sep}`) &&
    !isAbsolute(relation)
  );
}

/**
 * PATH is ambient process state, not an explicit project selection. Avoid
 * probing privacy-protected folders while Bridge is only looking for a CLI.
 */
export function isSafeForBackgroundRuntimeScan(
  candidate: string,
  home = homedir(),
  platform = process.platform,
): boolean {
  if (platform !== "darwin") return true;
  const protectedRoots = [
    join(home, "Desktop"),
    join(home, "Documents"),
    join(home, "Downloads"),
    join(home, "Movies"),
    join(home, "Music"),
    join(home, "Pictures"),
    join(home, "Library", "CloudStorage"),
    join(home, "Library", "Mobile Documents"),
    "/Volumes",
  ];
  return !protectedRoots.some((root) => pathIsWithin(root, candidate));
}

async function isExecutable(path: string, platform = process.platform): Promise<boolean> {
  return access(path, platform === "win32" ? constants.F_OK : constants.X_OK)
    .then(() => true, () => false);
}

function credentialRoots(
  home: string,
  environment: NodeJS.ProcessEnv,
  platform = process.platform,
): string[] {
  if (platform === "darwin") {
    return [
      join(home, "Library", "Application Support", "Claude-3p"),
      join(home, "Library", "Application Support", "Claude"),
    ];
  }
  if (platform === "win32") {
    const appData = environment.APPDATA ?? join(home, "AppData", "Roaming");
    return [join(appData, "Claude-3p"), join(appData, "Claude")];
  }
  const configHome = environment.XDG_CONFIG_HOME ?? join(home, ".config");
  return [join(configHome, "Claude-3p"), join(configHome, "Claude")];
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

export function applyClaudeHostCredentials(environment: NodeJS.ProcessEnv, path: string): void {
  environment.CLAUDE_CODE_HOST_CREDS_FILE = path;
  environment.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = "1";
  environment.CLAUDE_CODE_HOST_AUTH_ENV_VAR = "ANTHROPIC_AUTH_TOKEN";
  environment.CLAUDE_CODE_HOST_SESSION_ID ??= `bridge-${process.pid}`;
  environment.CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH = "1";
}

async function bundledClaudeCandidates(home: string, platform = process.platform): Promise<string[]> {
  if (platform !== "darwin") return [];
  const roots = [
    join(home, "Library", "Application Support", "Claude-3p", "claude-code"),
    join(home, "Library", "Application Support", "Claude", "claude-code"),
  ];
  const candidates: string[] = [];
  for (const root of roots) {
    let versions: string[];
    try {
      versions = (await readdir(root)).sort((left, right) => (
        right.localeCompare(left, undefined, { numeric: true })
      ));
    } catch {
      continue;
    }
    for (const version of versions) {
      candidates.push(join(root, version, "claude.app", "Contents", "MacOS", "claude"));
    }
  }
  return candidates;
}

export async function findClaudeExecutable(
  environment: NodeJS.ProcessEnv = process.env,
  home = homedir(),
  platform: NodeJS.Platform = process.platform,
): Promise<string | undefined> {
  const names = platform === "win32"
    ? ["claude.exe", "claude.cmd", "claude.bat", "claude"]
    : ["claude"];
  const pathCandidates = (environment.PATH ?? "")
    .split(platform === "win32" ? ";" : delimiter)
    .filter(Boolean)
    .flatMap((directory) => names.map((name) => join(directory, name)))
    .filter((candidate) => isSafeForBackgroundRuntimeScan(candidate, home, platform));
  const configured = [environment.BRIDGE_CLAUDE_PATH, environment.CLAUDE_CODE_EXECUTABLE]
    .filter((value): value is string => Boolean(value));
  const local = platform === "win32"
    ? [
        join(home, ".local", "bin", "claude.exe"),
        join(home, ".local", "bin", "claude.cmd"),
        join(home, ".local", "bin", "claude.bat"),
      ]
    : [join(home, ".local", "bin", "claude"), join(home, ".claude", "local", "claude")];
  const bundled = await bundledClaudeCandidates(home, platform);
  for (const candidate of [...configured, ...bundled, ...local, ...pathCandidates]) {
    if (await isExecutable(candidate, platform)) return candidate;
  }
  return undefined;
}

export function buildClaudeRuntimeEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const runtimeEnvironment: NodeJS.ProcessEnv = {
    ...environment,
    CLAUDE_CODE_ENTRYPOINT: "claude-bridge",
    CLAUDE_AGENT_SDK_CLIENT_APP: "claude-bridge/0.6.0",
    BRIDGE_SESSION_RUNTIME: "1",
  };
  delete runtimeEnvironment.CLAUDECODE;
  return runtimeEnvironment;
}

export interface ClaudeRuntime {
  environment: NodeJS.ProcessEnv;
  executablePath?: string;
  /** Source file: a Host credential file or the active fixed gateway profile. */
  credentialPath?: string;
  version?: string;
}

export async function prepareClaudeRuntime(
  environment: NodeJS.ProcessEnv = process.env,
  previous?: ClaudeRuntime,
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
): Promise<ClaudeRuntime> {
  const prepared = buildClaudeRuntimeEnvironment(environment);
  let credentialPath = await findClaudeHostCredentials(prepared, home, undefined, platform);
  if (credentialPath) {
    applyClaudeHostCredentials(prepared, credentialPath);
  } else {
    // Desktop passes fixed gateway keys directly; recent versions no longer
    // materialize host-creds files for this credential source.
    for (const root of credentialRoots(home, prepared, platform)) {
      let entry: ConfigLibraryEntryFile;
      let path: string;
      try {
        const library = join(root, "configLibrary");
        const meta = JSON.parse(await readFile(join(library, "_meta.json"), "utf8")) as ConfigLibraryMetaFile;
        const appliedId = nonEmptyString(meta?.appliedId);
        if (!appliedId || !/^[a-z0-9._-]+$/iu.test(appliedId)) continue;
        path = join(library, `${appliedId}.json`);
        if (!await protectedCredential(path, platform)) continue;
        entry = JSON.parse(await readFile(path, "utf8")) as ConfigLibraryEntryFile;
      } catch {
        // A profile may have no saved gateway configuration.
        continue;
      }
      const baseUrl = nonEmptyString(entry?.inferenceGatewayBaseUrl);
      const key = nonEmptyString(entry?.inferenceGatewayApiKey);
      const scheme = entry?.inferenceGatewayAuthScheme;
      if (
        entry?.inferenceProvider !== "gateway" || !baseUrl || !key ||
        (scheme !== "bearer" && scheme !== "x-api-key")
      ) continue;
      const url = URL.parse(baseUrl);
      if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) continue;
      credentialPath = path;
      prepared.ANTHROPIC_BASE_URL = baseUrl;
      prepared.ANTHROPIC_AUTH_TOKEN = scheme === "bearer" ? key : "";
      prepared.ANTHROPIC_API_KEY = scheme === "x-api-key" ? key : "";
      prepared.CLAUDE_CODE_HOST_AUTH_ENV_VAR = scheme === "bearer" ? "ANTHROPIC_AUTH_TOKEN" : "ANTHROPIC_API_KEY";
      prepared.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = "1";
      delete prepared.CLAUDE_CODE_HOST_CREDS_FILE;
      delete prepared.CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH;
      break;
    }
  }
  const previousExecutable = previous?.executablePath && await isExecutable(previous.executablePath, platform)
    ? previous.executablePath
    : undefined;
  const executablePath = previousExecutable ?? await findClaudeExecutable(prepared, home, platform);
  let version = executablePath === previous?.executablePath ? previous?.version : undefined;
  if (executablePath && !version) {
    try {
      const result = await execFileAsync(executablePath, ["--version"], {
        cwd: home,
        env: prepared,
        ...(platform === "win32" && /\.(?:cmd|bat)$/iu.test(executablePath) ? { shell: true } : {}),
        timeout: 8_000,
        maxBuffer: 64 * 1024,
      });
      version = result.stdout.trim().slice(0, 100) || undefined;
    } catch {
      version = undefined;
    }
  }
  return {
    environment: prepared,
    ...(executablePath ? { executablePath } : {}),
    ...(credentialPath ? { credentialPath } : {}),
    ...(version ? { version } : {}),
  };
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

interface ConfigLibraryEntryFile {
  inferenceProvider?: unknown;
  inferenceGatewayBaseUrl?: unknown;
  inferenceGatewayAuthScheme?: unknown;
  inferenceGatewayApiKey?: unknown;
}

interface GatewayModelPayload {
  id?: unknown;
  display_name?: unknown;
  description?: unknown;
  max_input_tokens?: unknown;
  context_window?: unknown;
  context_length?: unknown;
  supports_1m?: unknown;
  reasoning?: unknown;
  reasoning_levels?: unknown;
  supported_reasoning_levels?: unknown;
}

interface GatewayModelsResponsePayload {
  data?: unknown;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export async function resolveClaudeGatewayConfig(
  runtime: Pick<ClaudeRuntime, "credentialPath" | "environment"> | undefined,
): Promise<ClaudeGatewayConfig | undefined> {
  if (!runtime) return undefined;
  let baseUrl: string | undefined;
  let authToken: string | undefined;
  let apiKey: string | undefined;
  let authScheme: "bearer" | "x-api-key" | undefined;

  if (runtime.credentialPath) {
    try {
      const parsed = JSON.parse(await readFile(runtime.credentialPath, "utf8")) as HostCredentialsFile;
      const env = parsed && typeof parsed.env === "object" && parsed.env !== null && !Array.isArray(parsed.env)
        ? parsed.env
        : (parsed as Record<string, unknown>);
      baseUrl = nonEmptyString(env?.ANTHROPIC_BASE_URL);
      authToken = nonEmptyString(env?.ANTHROPIC_AUTH_TOKEN);
      apiKey = nonEmptyString(env?.ANTHROPIC_API_KEY);
      if (env?.CLAUDE_CODE_HOST_AUTH_ENV_VAR === "ANTHROPIC_API_KEY") authScheme = "x-api-key";
      else if (env?.CLAUDE_CODE_HOST_AUTH_ENV_VAR === "ANTHROPIC_AUTH_TOKEN") authScheme = "bearer";
    } catch {
      // Ignore unreadable or missing credential files and fall back to configLibrary / environment.
    }

    const configLibraryDir = join(dirname(runtime.credentialPath), "configLibrary");
    try {
      const meta = JSON.parse(await readFile(join(configLibraryDir, "_meta.json"), "utf8")) as ConfigLibraryMetaFile;
      const appliedId = nonEmptyString(meta?.appliedId);
      if (appliedId && /^[a-z0-9._-]+$/iu.test(appliedId)) {
        const entry = JSON.parse(
          await readFile(join(configLibraryDir, `${appliedId}.json`), "utf8"),
        ) as ConfigLibraryEntryFile;
        baseUrl ??= nonEmptyString(entry?.inferenceGatewayBaseUrl);
        if (entry?.inferenceGatewayAuthScheme === "bearer" || entry?.inferenceGatewayAuthScheme === "x-api-key") {
          authScheme ??= entry.inferenceGatewayAuthScheme;
        }
        const gatewayKey = nonEmptyString(entry?.inferenceGatewayApiKey);
        if (gatewayKey) {
          if (authScheme === "x-api-key") apiKey ??= gatewayKey;
          else authToken ??= gatewayKey;
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
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const id = nonEmptyString((raw as GatewayModelPayload).id);
    if (id) existingIds.add(id.toLocaleLowerCase());
  }
  const results: BridgeModelInfo[] = [];
  const seen = new Set<string>();
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as GatewayModelPayload;
    const id = nonEmptyString(item.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const displayName = nonEmptyString(item.display_name) ?? id;
    const description = nonEmptyString(item.description);
    const maxInputTokens = [item.max_input_tokens, item.context_window, item.context_length]
      .find((value): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0);
    const rawLevels = Array.isArray(item.supported_reasoning_levels)
      ? item.supported_reasoning_levels
      : Array.isArray(item.reasoning_levels)
        ? item.reasoning_levels
        : undefined;
    const supportedEffortLevels = rawLevels?.filter((level): level is BridgeEffort => (
      typeof level === "string" && GATEWAY_EFFORT_LEVELS.has(level as BridgeEffort)
    ));
    const supportsEffort = typeof item.reasoning === "boolean"
      ? item.reasoning
      : supportedEffortLevels && supportedEffortLevels.length > 0
        ? true
        : undefined;
    results.push({
      value: id,
      displayName,
      ...(description ? { description } : {}),
      ...(maxInputTokens ? { maxInputTokens } : {}),
      ...(supportsEffort !== undefined ? { supportsEffort } : {}),
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
        ...(supportedEffortLevels?.length ? { supportedEffortLevels } : {}),
      });
    }
  }
  return results;
}

export async function discoverClaudeGatewayModels(
  runtime: Pick<ClaudeRuntime, "credentialPath" | "environment"> | undefined,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = GATEWAY_MODELS_TIMEOUT_MS,
): Promise<BridgeModelInfo[]> {
  const gateway = await resolveClaudeGatewayConfig(runtime);
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
    return [];
  }
  if (!response.ok) return [];
  let payload: GatewayModelsResponsePayload;
  try {
    payload = (await response.json()) as GatewayModelsResponsePayload;
  } catch {
    return [];
  }
  if (!Array.isArray(payload?.data)) return [];
  return parseClaudeGatewayModels(payload.data);
}
