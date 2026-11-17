import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { BridgeModelInfo } from "@bridge/protocol";
import {
  findClaudeFixedGateway,
  findClaudeHostCredentials,
  magpieModelIdHash,
  parseMagpieSyntheticModelId,
  resolveClaudeGatewayConfig,
  type ClaudeGatewayConfig,
} from "./claude-runtime-discovery.js";

const DEFAULT_TITLE_MODEL = "claude-3-5-haiku-latest";
const DEFAULT_TITLE_TIMEOUT_MS = 8_000;
const MAX_GENERATED_TITLE_CHARS = 40;
const MAX_FALLBACK_CLAUSE_CHARS = 24;
const MAX_PROMPT_SOURCE_CHARS = 1_200;
const MAX_FALLBACK_INPUT_CHARS = 16_000;

const GENERIC_TITLE_RE = /^(?:claude\s*(?:会话|对话|session|chat)|new\s*(?:chat|session|conversation)|untitled(?:\s+(?:chat|session))?|新(?:建)?(?:会话|对话))$/iu;
const NON_PROSE_SLASH_COMMAND_RE = /^\/(?:compact|clear|cost|context|doctor|help|login|logout|memory|model|permissions|rename|rewind|status|vim|btw)(?:\s|$)/iu;

const TITLE_SYSTEM_PROMPT = [
  "Generate a concise plain-text session title summarizing the user's request.",
  "Use Chinese (<= 16 characters) when the request is primarily Chinese, or English (3-6 words) otherwise.",
  "Return ONLY a single-line title with no quotes, no markdown, and no trailing period.",
].join(" ");

export function stripLoneSurrogates(value: string): string {
  return value.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu, "");
}

function trimCodePoints(value: string, limit: number): string {
  const wellFormed = stripLoneSurrogates(value);
  const chars = Array.from(wellFormed);
  return chars.length > limit ? chars.slice(0, limit).join("").trimEnd() : wellFormed;
}

export function sanitizeGeneratedTitle(raw: string | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  const firstLine = stripLoneSurrogates(raw)
    .split(/\r?\n/u)
    .map(line => line.replace(/\s+/gu, " ").trim())
    .find(line => line.length > 0 && !/^```/u.test(line));
  if (!firstLine) return undefined;
  let cleaned = firstLine.replace(/^(?:title|session\s+title|标题|会话标题)\s*[:：-]\s*/iu, "");
  for (let pass = 0; pass < 4; pass += 1) {
    const next = cleaned
      .replace(/^(?:[#>*`~-]+\s*)+/u, "")
      .replace(/\*\*(.+?)\*\*/gu, "$1")
      .replace(/__(.+?)__/gu, "$1")
      .replace(/^["'“”‘’`「」『』《》*]+|["'“”‘’`「」『』《》*]+$/gu, "")
      .replace(/[.。；;，,、:：]+$/u, "")
      .replace(/\s+/gu, " ")
      .trim();
    if (next === cleaned) break;
    cleaned = next;
  }
  if (!cleaned || GENERIC_TITLE_RE.test(cleaned)) return undefined;
  const capped = trimCodePoints(cleaned, MAX_GENERATED_TITLE_CHARS);
  return capped && !GENERIC_TITLE_RE.test(capped) ? capped : undefined;
}

function stripLeadingFormatting(line: string): string {
  let current = line.trim();
  for (let pass = 0; pass < 4; pass += 1) {
    const next = current
      .replace(/^(?:[#>*+-]+|\d+[.)])\s+/u, "")
      .replace(/^\[[ xX]\]\s+/u, "")
      .replace(/^\/[a-z0-9_:-]+\s+/iu, "")
      .trim();
    if (next === current) break;
    current = next;
  }
  return current;
}

export function deriveFallbackSessionTitle(text: string, hasAttachments = false): string | undefined {
  const raw = typeof text === "string" ? trimCodePoints(text, MAX_FALLBACK_INPUT_CHARS) : "";
  const trimmedRaw = raw.trim();
  if (!trimmedRaw || NON_PROSE_SLASH_COMMAND_RE.test(trimmedRaw)) {
    return hasAttachments ? "图片分析" : undefined;
  }

  const withoutFences = raw
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/```[\s\S]*$/gu, " ");
  let working = withoutFences.trim()
    ? withoutFences
    : raw.replace(/```[^\r\n]*/gu, " ").replace(/```/gu, " ");

  working = working.replace(/`([^`]+)`/gu, "$1");

  const withoutUrls = working.replace(/https?:\/\/\S+/giu, " ");
  if (withoutUrls.replace(/\s+/gu, "").length > 0) {
    working = withoutUrls;
  }

  const cleanedLines = working
    .split(/\r?\n/u)
    .map(stripLeadingFormatting)
    .filter(line => line.length > 0 && !/^[-=_*]{3,}$/u.test(line));

  let combined = cleanedLines.join(" ").replace(/\s+/gu, " ").trim();
  if (/^\/([a-z0-9_:-]+)$/iu.test(combined)) {
    combined = combined.slice(1);
  }
  if (!combined) return hasAttachments ? "图片分析" : undefined;

  const firstClause = combined
    .split(/(?:[。！？!?；;\n]|(?<=\S)\.\s+)/u)
    .map(part => part
      .replace(/^["'“”‘’`「」『』《》]+|["'“”‘’`「」『』《》]+$/gu, "")
      .replace(/[.。；;，,、:：]+$/u, "")
      .trim())
    .find(part => part.length > 0);

  if (!firstClause || GENERIC_TITLE_RE.test(firstClause)) {
    return hasAttachments ? "图片分析" : undefined;
  }

  const chars = Array.from(firstClause);
  if (chars.length > MAX_FALLBACK_CLAUSE_CHARS) {
    return `${chars.slice(0, MAX_FALLBACK_CLAUSE_CHARS).join("").trimEnd()}…`;
  }
  return firstClause;
}

export function resolveTitleGenerationModel(
  preferredModel?: string,
  catalogModels?: readonly BridgeModelInfo[],
): string {
  const cleanCandidate = (value: string | undefined): string | undefined => {
    const stripped = value?.trim().replace(/\[1m\]$/iu, "").trim();
    if (!stripped || stripped.toLowerCase() === "default" || stripped === "<synthetic>") return undefined;
    return stripped;
  };

  const preferred = cleanCandidate(preferredModel);
  if (preferred) {
    const synthetic = parseMagpieSyntheticModelId(preferred);
    if (!synthetic) return preferred;
    const matchedCatalog = catalogModels?.find(item => {
      const base = cleanCandidate(item.value);
      return Boolean(base && !parseMagpieSyntheticModelId(base) && magpieModelIdHash(base) === synthetic.hash);
    });
    const matchedBase = cleanCandidate(matchedCatalog?.value);
    if (matchedBase) return matchedBase;
    const anthropicBase = cleanCandidate(synthetic.anthropicModel);
    if (anthropicBase) return anthropicBase;
  }

  for (const item of catalogModels ?? []) {
    const candidate = cleanCandidate(item.value);
    if (candidate && !parseMagpieSyntheticModelId(candidate)) return candidate;
  }
  return DEFAULT_TITLE_MODEL;
}

async function readSettingsDirectApiKey(settingsPath: string | undefined): Promise<ClaudeGatewayConfig | undefined> {
  if (!settingsPath) return undefined;
  try {
    const parsed = JSON.parse(await readFile(settingsPath, "utf8")) as { env?: Record<string, unknown> };
    const env = parsed?.env;
    if (!env || typeof env !== "object" || Array.isArray(env)) return undefined;
    const baseUrl = env.ANTHROPIC_BASE_URL;
    const authToken = typeof env.ANTHROPIC_AUTH_TOKEN === "string" && env.ANTHROPIC_AUTH_TOKEN.trim()
      ? env.ANTHROPIC_AUTH_TOKEN.trim()
      : undefined;
    const apiKey = typeof env.ANTHROPIC_API_KEY === "string" && env.ANTHROPIC_API_KEY.trim()
      ? env.ANTHROPIC_API_KEY.trim()
      : undefined;
    if (baseUrl !== undefined) {
      if (typeof baseUrl !== "string") return undefined;
      const resolved = await resolveClaudeGatewayConfig({
        environment: {
          ANTHROPIC_BASE_URL: baseUrl,
          ...(authToken ? { ANTHROPIC_AUTH_TOKEN: authToken } : {}),
          ...(apiKey ? { ANTHROPIC_API_KEY: apiKey } : {}),
          ...(typeof env.CLAUDE_CODE_HOST_AUTH_ENV_VAR === "string"
            ? { CLAUDE_CODE_HOST_AUTH_ENV_VAR: env.CLAUDE_CODE_HOST_AUTH_ENV_VAR }
            : {}),
        },
      });
      return resolved && (resolved.authToken || resolved.apiKey) ? resolved : undefined;
    }
    if (apiKey) {
      return { baseUrl: "https://api.anthropic.com", apiKey, authScheme: "x-api-key" };
    }
  } catch {
    // Optional settings.json may be absent or mid-edit.
  }
  return undefined;
}

function titleMessagesEndpoint(baseUrl: string): string {
  const trimmedBase = baseUrl.replace(/\/+$/u, "");
  return `${trimmedBase.endsWith("/v1") ? trimmedBase : `${trimmedBase}/v1`}/messages`;
}

export async function resolveActiveClaudeGateway({
  environment = process.env, home, platform, roots, settingsPath, allowAmbientDiscovery = true,
}: {
  environment?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
  roots?: string[];
  settingsPath?: string;
  allowAmbientDiscovery?: boolean;
} = {}): Promise<{ gateway: ClaudeGatewayConfig; profileModels?: BridgeModelInfo[] } | undefined> {
  const credentialPath = allowAmbientDiscovery
    ? await findClaudeHostCredentials(environment, home, roots, platform)
    : undefined;
  if (credentialPath) {
    const host = await resolveClaudeGatewayConfig({ credentialPath, environment: {} });
    if (host && (host.authToken || host.apiKey)) {
      const parent = dirname(credentialPath);
      const profileRoot = basename(parent) === "configLibrary" ? dirname(parent) : parent;
      const profile = await findClaudeFixedGateway(environment, home, [profileRoot], platform);
      return {
        gateway: host,
        ...(profile && titleMessagesEndpoint(profile.gateway.baseUrl) === titleMessagesEndpoint(host.baseUrl)
          ? { profileModels: profile.inferenceModels }
          : {}),
      };
    }
  }
  if (allowAmbientDiscovery) {
    const fixed = await findClaudeFixedGateway(environment, home, roots, platform);
    if (fixed) return { gateway: fixed.gateway, profileModels: fixed.inferenceModels };
  }

  const fromSettings = await readSettingsDirectApiKey(settingsPath);
  if (fromSettings) return { gateway: fromSettings };
  if (!allowAmbientDiscovery) return undefined;

  const fromEnvironment = await resolveClaudeGatewayConfig({ ...(credentialPath ? { credentialPath } : {}), environment });
  if (fromEnvironment && (fromEnvironment.authToken || fromEnvironment.apiKey)) return { gateway: fromEnvironment };
  const apiKey = environment.ANTHROPIC_API_KEY?.trim();
  return apiKey && environment.ANTHROPIC_BASE_URL === undefined
    ? { gateway: { baseUrl: "https://api.anthropic.com", apiKey, authScheme: "x-api-key" } }
    : undefined;
}

export async function generateSessionTitle(options: {
  text: string;
  hasAttachments?: boolean;
  gateway?: ClaudeGatewayConfig;
  preferredModel?: string;
  catalogModels?: readonly BridgeModelInfo[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<string | undefined> {
  const rawTrimmed = typeof options.text === "string" ? stripLoneSurrogates(options.text).trim() : "";
  if (NON_PROSE_SLASH_COMMAND_RE.test(rawTrimmed)) {
    return options.hasAttachments ? "图片分析" : undefined;
  }
  const fallback = deriveFallbackSessionTitle(options.text, options.hasAttachments);
  const promptSource = trimCodePoints(rawTrimmed, MAX_PROMPT_SOURCE_CHARS);
  if (!promptSource || !options.gateway || (!options.gateway.authToken && !options.gateway.apiKey)) {
    return fallback;
  }

  const endpoint = titleMessagesEndpoint(options.gateway.baseUrl);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    "anthropic-version": "2023-06-01",
  };
  if (options.gateway.authScheme === "x-api-key") {
    const key = options.gateway.apiKey ?? options.gateway.authToken;
    if (key) headers["x-api-key"] = key;
    if (options.gateway.authToken) headers.authorization = `Bearer ${options.gateway.authToken}`;
  } else {
    const token = options.gateway.authToken ?? options.gateway.apiKey;
    if (token) {
      headers.authorization = `Bearer ${token}`;
      headers["x-api-key"] = options.gateway.apiKey ?? token;
    }
  }

  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TITLE_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  const model = resolveTitleGenerationModel(options.preferredModel, options.catalogModels);

  try {
    const response = await (options.fetchImpl ?? fetch)(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        max_tokens: 48,
        system: TITLE_SYSTEM_PROMPT,
        messages: [{ role: "user", content: promptSource }],
      }),
      signal,
    });
    if (!response.ok) return fallback;
    const payload = await response.json() as { content?: unknown };
    if (!Array.isArray(payload?.content)) return fallback;
    const textBlock = payload.content.find((block): block is { type: "text"; text: string } => (
      Boolean(block && typeof block === "object" && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string")
    ));
    return sanitizeGeneratedTitle(textBlock?.text) ?? fallback;
  } catch {
    return fallback;
  }
}
