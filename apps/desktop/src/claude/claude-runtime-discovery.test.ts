import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discoverClaudeGateway,
  discoverClaudeGatewayConfig,
  fetchClaudeGatewayModels,
  findClaudeFixedGateway,
  findClaudeHostCredentials,
  humanizeMagpieAnthropicModel,
  humanizeUpstreamModelId,
  magpieModelIdHash,
  normalizeAnthropicModelSlug,
  parseMagpieSyntheticModelId,
  parseClaudeGatewayModels,
  resolveClaudeGatewayConfig,
} from "./claude-runtime-discovery.js";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("Claude gateway and model discovery", () => {
  it("finds the newest Windows Host Credentials file under roaming AppData", async () => {
    const home = await mkdtemp(join(tmpdir(), "bridge-credentials-windows-"));
    directories.push(home);
    const appData = join(home, "AppData", "Roaming");
    const root = join(appData, "Claude-3p");
    const credential = join(root, "host-creds-windows.json");
    await mkdir(root, { recursive: true });
    await writeFile(credential, "{}\n", "utf8");

    await expect(findClaudeHostCredentials({ APPDATA: appData }, home, undefined, "win32"))
      .resolves.toBe(credential);
  });

  it("discovers custom gateway models, display names, and 1M variants from Claude-3p credentials", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-gateway-models-"));
    directories.push(root);
    const credentialPath = join(root, "host-creds-test.json");
    await writeFile(credentialPath, JSON.stringify({
      env: {
        ANTHROPIC_AUTH_TOKEN: "test-gateway-token",
        ANTHROPIC_API_KEY: "",
        CLAUDE_CODE_HOST_AUTH_ENV_VAR: "ANTHROPIC_AUTH_TOKEN",
        ANTHROPIC_BASE_URL: "http://127.0.0.1:3425/",
      },
    }), "utf8");

    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("http://127.0.0.1:3425/v1/models?limit=1000");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer test-gateway-token");
      expect(headers.get("anthropic-version")).toBe("2023-06-01");
      return new Response(JSON.stringify({
        data: [
          {
            id: "gateway-model-alpha",
            display_name: "Claude Opus 4.6 · Gateway",
            max_input_tokens: 1_000_000,
            reasoning: true,
            supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max"],
          },
          {
            id: "gateway-model-beta",
            display_name: "Claude Sonnet 4.6 · Gateway",
            max_input_tokens: 200_000,
            supports_1m: false,
            reasoning: true,
            supported_reasoning_levels: ["low", "medium", "high"],
          },
        ],
      }), { status: 200 });
    }) as unknown as typeof fetch;

    const gateway = await resolveClaudeGatewayConfig({ credentialPath, environment: {} });
    const models = await fetchClaudeGatewayModels(gateway, fetchImpl);
    expect(models).toEqual([
      {
        value: "gateway-model-alpha",
        displayName: "Claude Opus 4.6 · Gateway",
        maxInputTokens: 1_000_000,
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
      },
      {
        value: "gateway-model-alpha[1m]",
        displayName: "Claude Opus 4.6 · Gateway 1M",
        description: "1M context window",
        maxInputTokens: 1_000_000,
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
      },
      {
        value: "gateway-model-beta",
        displayName: "Claude Sonnet 4.6 · Gateway",
        maxInputTokens: 200_000,
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high"],
      },
    ]);
  });

  it("preserves gateway input capacity for custom models and generated 1M variants", () => {
    expect(parseClaudeGatewayModels([
      { id: "custom-codex", display_name: "GPT · Codex", max_input_tokens: 400_000 },
      { id: "custom-context", context_window: 512_000 },
      { id: "custom-length", context_length: 400_000 },
      { id: "custom-long", max_input_tokens: 200_000, supports_1m: true },
      { id: "unknown-model", max_input_tokens: -1 },
    ])).toEqual([
      { value: "custom-codex", displayName: "GPT · Codex", maxInputTokens: 400_000 },
      { value: "custom-context", displayName: "custom-context", maxInputTokens: 512_000 },
      { value: "custom-length", displayName: "custom-length", maxInputTokens: 400_000 },
      { value: "custom-long", displayName: "custom-long", maxInputTokens: 200_000 },
      { value: "custom-long[1m]", displayName: "custom-long 1M", description: "1M context window", maxInputTokens: 1_000_000 },
      { value: "unknown-model", displayName: "unknown-model" },
    ]);
  });

  it.each(["bearer", "x-api-key"] as const)("uses the active fixed gateway with %s auth without a Host file", async (authScheme) => {
    const home = await mkdtemp(join(tmpdir(), "bridge-fixed-gateway-"));
    directories.push(home);
    const platform = process.platform === "win32" ? "win32" : "darwin";
    const appData = platform === "win32" ? join(home, "AppData", "Roaming") : join(home, "Library", "Application Support");
    const configLibrary = join(appData, "Claude-3p", "configLibrary");
    await mkdir(configLibrary, { recursive: true });
    const credentialPath = join(configLibrary, "active.json");
    await writeFile(join(configLibrary, "_meta.json"), JSON.stringify({ appliedId: "active" }));
    await writeFile(credentialPath, JSON.stringify({
      inferenceProvider: "gateway",
      inferenceGatewayBaseUrl: "http://127.0.0.1:3425",
      inferenceGatewayAuthScheme: authScheme,
      inferenceGatewayApiKey: "fixed-test-key",
    }), { mode: 0o600 });
    const environment = {
      PATH: "",
      APPDATA: appData,
      CLAUDE_CODE_HOST_CREDS_FILE: join(home, "missing.json"),
      CLAUDE_CODE_HOST_AUTH_ENV_VAR: "ANTHROPIC_AUTH_TOKEN",
      CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH: "1",
      ANTHROPIC_BASE_URL: "http://stale.invalid",
      ANTHROPIC_API_KEY: "stale-api-key",
      ANTHROPIC_AUTH_TOKEN: "stale-bearer",
    };
    const fixed = await findClaudeFixedGateway(environment, home, undefined, platform);
    expect(fixed?.path).toBe(credentialPath);
    expect(fixed?.gateway).toEqual({
      baseUrl: "http://127.0.0.1:3425",
      authScheme,
      ...(authScheme === "bearer" ? { authToken: "fixed-test-key" } : { apiKey: "fixed-test-key" }),
    });
    await expect(resolveClaudeGatewayConfig({ credentialPath, environment: {} })).resolves.toEqual(fixed?.gateway);
  });

  it.each([
    { inferenceProvider: "anthropic" },
    { inferenceGatewayApiKey: "" },
    { inferenceGatewayAuthScheme: "sso" },
    { inferenceGatewayBaseUrl: "file:///tmp/gateway" },
  ])("does not treat an unsupported active gateway as ready: %j", async (override) => {
    const home = await mkdtemp(join(tmpdir(), "bridge-fixed-invalid-"));
    directories.push(home);
    const configLibrary = join(home, "Library", "Application Support", "Claude-3p", "configLibrary");
    await mkdir(configLibrary, { recursive: true });
    await writeFile(join(configLibrary, "_meta.json"), JSON.stringify({ appliedId: "active" }));
    await writeFile(join(configLibrary, "active.json"), JSON.stringify({
      inferenceProvider: "gateway",
      inferenceGatewayBaseUrl: "http://127.0.0.1:3425",
      inferenceGatewayAuthScheme: "bearer",
      inferenceGatewayApiKey: "fixed-test-key",
      ...override,
    }), { mode: 0o600 });
    expect(await findClaudeFixedGateway({ PATH: "" }, home, undefined, "darwin")).toBeUndefined();
  });

  it("falls back to Claude-3p configLibrary when host-creds omits the gateway base URL", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-gateway-configlib-"));
    directories.push(root);
    const credentialPath = join(root, "host-creds-test.json");
    const configLibrary = join(root, "configLibrary");
    const appliedId = "00000000-0000-4000-8000-000000000001";
    await mkdir(configLibrary, { recursive: true });
    await writeFile(credentialPath, "{}\n", "utf8");
    await writeFile(join(configLibrary, "_meta.json"), JSON.stringify({ appliedId }), "utf8");
    await writeFile(join(configLibrary, `${appliedId}.json`), JSON.stringify({
      inferenceProvider: "gateway",
      inferenceGatewayBaseUrl: "http://127.0.0.1:3425/v1",
      inferenceGatewayAuthScheme: "bearer",
      inferenceGatewayApiKey: "configlib-token",
    }), "utf8");

    await expect(resolveClaudeGatewayConfig({
      credentialPath,
      environment: {},
    })).resolves.toEqual({
      baseUrl: "http://127.0.0.1:3425/v1",
      authToken: "configlib-token",
      authScheme: "bearer",
    });
  });

  it("keeps Host credential completion separate from offline model eligibility and preserves ambient fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-host-gateway-"));
    directories.push(root);
    const hostPath = join(root, "host-creds-test.json");
    const library = join(root, "configLibrary");
    const profile = join(library, "active.json");
    await mkdir(library);
    const authToken = "fixture-host-bearer";
    await writeFile(hostPath, JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: authToken } }), { mode: 0o600 });
    await writeFile(join(library, "_meta.json"), JSON.stringify({ appliedId: "active" }));
    await writeFile(profile, JSON.stringify({
      inferenceProvider: "gateway",
      inferenceGatewayBaseUrl: "https://profile.example.test",
      inferenceGatewayAuthScheme: "bearer",
      inferenceModels: [{ name: "offline-model", labelOverride: "Offline model" }],
    }), { mode: 0o600 });
    const options = { roots: [root], environment: { ANTHROPIC_BASE_URL: "https://ambient.example.test" } };
    const discovery = await discoverClaudeGateway(options);
    expect(discovery.gateway).toEqual({ baseUrl: "https://profile.example.test", authToken, authScheme: "bearer" });
    await expect(discovery.offlineModels?.()).resolves.toEqual([]);

    await writeFile(profile, "{}");
    await expect(discoverClaudeGatewayConfig(options)).resolves.toEqual({ baseUrl: "https://ambient.example.test", authToken });
  });

  it("computes Magpie 10-digit FNV-1a model hashes and disambiguates duplicate gateway display names", () => {
    expect(magpieModelIdHash("antigravity/gemini-4-argon")).toBe("1052229916");
    expect(magpieModelIdHash("claude/claude-opus-5-5")).toBe("2213244526");
    expect(parseMagpieSyntheticModelId("mythos-magpie-1052229916[1m]")).toEqual({
      hash: "1052229916",
      longContext: true,
    });
    expect(parseMagpieSyntheticModelId("magpie-2213244526.anthropic.claude-opus-5-5[1m]")).toEqual({
      hash: "2213244526",
      anthropicModel: "claude-opus-5-5",
      longContext: true,
    });

    expect(parseClaudeGatewayModels([
      {
        id: "auto/claude-opus-5-5",
        display_name: "Claude Opus 5.5",
        magpie_label: "Claude Opus 5.5 · routing group",
        supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }],
      },
      {
        id: "claude/claude-opus-5-5",
        display_name: "Claude Opus 5.5",
        magpie_label: "Claude Opus 5.5 · Claude Code",
        supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }, { effort: "max" }],
      },
      {
        id: "antigravity/gemini-4-argon",
        display_name: "Gemini 4 Argon",
        magpie_label: "Gemini 4 Argon · Antigravity",
        supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }],
      },
    ])).toEqual([
      {
        value: "auto/claude-opus-5-5",
        displayName: "Claude Opus 5.5 · routing group",
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high"],
      },
      {
        value: "claude/claude-opus-5-5",
        displayName: "Claude Opus 5.5 · Claude Code",
        supportsEffort: true,
        supportedEffortLevels: ["low", "high", "max"],
      },
      {
        value: "antigravity/gemini-4-argon",
        displayName: "Gemini 4 Argon",
        description: "Gemini 4 Argon · Antigravity",
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high"],
      },
    ]);
  });

  it("discovers active configLibrary gateways across macOS and Windows LocalAppData/MSIX profiles and falls back to settings.json", async () => {
    const home = await mkdtemp(join(tmpdir(), "bridge-discover-gateway-"));
    directories.push(home);
    const localAppData = join(home, "AppData", "Local");
    const roamingAppData = join(home, "AppData", "Roaming");
    const winConfigLib = join(localAppData, "Claude-3p", "configLibrary");
    const claudeRoaming = join(roamingAppData, "Claude");
    await mkdir(winConfigLib, { recursive: true });
    await mkdir(claudeRoaming, { recursive: true });
    // An official Claude host-creds file without a gateway base URL must not block Claude-3p's active fixed gateway.
    await writeFile(join(claudeRoaming, "host-creds-official.json"), JSON.stringify({ env: { ANTHROPIC_OAUTH_TOKEN: "oauth-only" } }), { mode: 0o600 });
    const entryPath = join(winConfigLib, "win-magpie.json");
    await writeFile(join(winConfigLib, "_meta.json"), JSON.stringify({ appliedId: "win-magpie" }));
    await writeFile(entryPath, JSON.stringify({
      inferenceProvider: "gateway",
      inferenceGatewayBaseUrl: "http://127.0.0.1:3425",
      inferenceGatewayAuthScheme: "bearer",
      inferenceGatewayApiKey: "win-local-token",
    }), { mode: 0o600 });

    // Direct credentialPath inside configLibrary resolves without environment duplication.
    await expect(resolveClaudeGatewayConfig({ credentialPath: entryPath, environment: {} })).resolves.toEqual({
      baseUrl: "http://127.0.0.1:3425",
      authScheme: "bearer",
      authToken: "win-local-token",
    });

    // Windows LocalAppData Claude-3p wins over ambient process.env.ANTHROPIC_BASE_URL.
    await expect(discoverClaudeGatewayConfig({
      platform: "win32",
      home,
      environment: {
        APPDATA: roamingAppData,
        LOCALAPPDATA: localAppData,
        ANTHROPIC_BASE_URL: "https://ambient.other.invalid/api/anthropic",
        ANTHROPIC_AUTH_TOKEN: "ambient-other-token",
      },
    })).resolves.toEqual({
      baseUrl: "http://127.0.0.1:3425",
      authScheme: "bearer",
      authToken: "win-local-token",
    });

    // When neither host-creds nor configLibrary defines a gateway, settings.json env wins cleanly without mixing ambient tokens.
    const emptyHome = await mkdtemp(join(tmpdir(), "bridge-discover-settings-"));
    directories.push(emptyHome);
    const settingsPath = join(emptyHome, "settings.json");
    await writeFile(settingsPath, JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: "http://127.0.0.1:3425/",
        ANTHROPIC_API_KEY: "settings-api-key",
        CLAUDE_CODE_HOST_AUTH_ENV_VAR: "ANTHROPIC_API_KEY",
      },
    }));
    await expect(discoverClaudeGatewayConfig({
      platform: "darwin",
      home: emptyHome,
      settingsPath,
      environment: {
        ANTHROPIC_BASE_URL: "https://ambient.other.invalid",
        ANTHROPIC_AUTH_TOKEN: "ambient-bearer-should-not-leak",
      },
    })).resolves.toEqual({
      baseUrl: "http://127.0.0.1:3425/",
      apiKey: "settings-api-key",
      authScheme: "x-api-key",
    });
  });

  it("normalizes and humanizes synthetic Magpie Anthropic model slugs without exposing opaque hashes", () => {
    expect(normalizeAnthropicModelSlug("magpie-5782219464.anthropic.claude-fable-5-2[1m]")).toBe("claude-fable-5-2");
    expect(normalizeAnthropicModelSlug("claude-fable-5.2[1m]")).toBe("claude-fable-5-2");
    expect(normalizeAnthropicModelSlug("claude/claude-fable-5-2")).toBe("claude-fable-5-2");
    expect(normalizeAnthropicModelSlug("mythos-magpie-3436308304")).toBeUndefined();
    expect(normalizeAnthropicModelSlug("deepseek/deepseek-flash")).toBeUndefined();
    expect(humanizeMagpieAnthropicModel("magpie-5782219464.anthropic.claude-fable-5-2[1m]")).toBe("Claude Fable 5.2 · 1M");
    expect(humanizeMagpieAnthropicModel("magpie-2213244526.anthropic.claude-opus-4-7")).toBe("Claude Opus 4.7");
    expect(humanizeMagpieAnthropicModel("mythos-magpie-3436308304")).toBeUndefined();
    expect(humanizeMagpieAnthropicModel("claude-sonnet-4-5")).toBe("claude-sonnet-4-5");
    expect(humanizeUpstreamModelId("claude/claude-opus-5-5[1m]")).toBe("Claude Opus 5.5 · 1M");
    expect(humanizeUpstreamModelId("codex/gpt-6-1-sol")).toBe("GPT 6.1 Sol");
  });
});
