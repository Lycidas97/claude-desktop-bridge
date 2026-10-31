import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discoverClaudeGatewayModels,
  findClaudeHostCredentials,
  findClaudeExecutable,
  isSafeForBackgroundRuntimeScan,
  magpieModelIdHash,
  parseMagpieSyntheticModelId,
  prepareClaudeRuntime,
  parseClaudeGatewayModels,
  resolveClaudeGatewayConfig,
} from "./claude-runtime-discovery.js";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    const result = process.platform === "win32"
      ? spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
          "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($env:BRIDGE_TEST_TRASH_DIRECTORY, 'OnlyErrorDialogs', 'SendToRecycleBin')",
        ], { env: { ...process.env, BRIDGE_TEST_TRASH_DIRECTORY: directory } })
      : spawnSync(process.platform === "darwin" ? "/usr/bin/trash" : "trash-put", [directory]);
    if (result.error || result.status !== 0) {
      console.warn(`Could not recycle test fixtures; retained ${directory}: ${result.error?.message ?? result.stderr.toString()}`);
    }
  }
});

describe("Claude runtime discovery privacy", () => {
  it("does not automatically probe macOS privacy-protected user folders", () => {
    if (process.platform === "win32") return;
    const home = "/Users/test";
    expect(isSafeForBackgroundRuntimeScan("/usr/local/bin/claude", home, "darwin")).toBe(true);
    expect(isSafeForBackgroundRuntimeScan("/Users/test/.local/bin/claude", home, "darwin")).toBe(true);
    expect(isSafeForBackgroundRuntimeScan("/Users/test/Documents/tools/claude", home, "darwin")).toBe(false);
    expect(isSafeForBackgroundRuntimeScan("/Users/test/Desktop/claude", home, "darwin")).toBe(false);
    expect(isSafeForBackgroundRuntimeScan("/Volumes/External/claude", home, "darwin")).toBe(false);
    expect(isSafeForBackgroundRuntimeScan("/Users/test/Documents/tools/claude", home, "linux")).toBe(true);
  });

  it("skips protected PATH entries but honors an explicitly configured executable", async () => {
    if (process.platform !== "darwin") return;
    const home = await mkdtemp(join(tmpdir(), "bridge-runtime-home-"));
    directories.push(home);
    const executable = join(home, "Documents", "tools", "claude");
    await mkdir(join(home, "Documents", "tools"), { recursive: true });
    await writeFile(executable, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(executable, 0o755);

    await expect(findClaudeExecutable({ PATH: join(home, "Documents", "tools") }, home))
      .resolves.toBeUndefined();
    await expect(findClaudeExecutable({
      PATH: join(home, "Documents", "tools"),
      BRIDGE_CLAUDE_PATH: executable,
    }, home)).resolves.toBe(executable);
  });

  it("runs the automatic version probe from home instead of the app launch directory", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "bridge-runtime-version-"));
    directories.push(root);
    const cwdReport = join(root, "cwd.txt");
    const executable = join(root, "claude");
    await writeFile(
      executable,
      `#!/bin/sh\npwd > ${JSON.stringify(cwdReport)}\necho bridge-test\n`,
      "utf8",
    );
    await chmod(executable, 0o755);

    await expect(prepareClaudeRuntime({
      PATH: "",
      BRIDGE_CLAUDE_PATH: executable,
    }, undefined, process.platform, root)).resolves.toMatchObject({
      executablePath: executable,
      version: "bridge-test",
    });
    await expect(readFile(cwdReport, "utf8")).resolves.toBe(`${await realpath(root)}\n`);
  });

  it("discovers Windows CLI shims from a Windows-style PATH", async () => {
    const home = await mkdtemp(join(tmpdir(), "bridge-runtime-windows-"));
    directories.push(home);
    const bin = join(home, "bin");
    const executable = join(bin, "claude.cmd");
    await mkdir(bin, { recursive: true });
    await writeFile(executable, "@echo off\r\necho bridge-windows\r\n", "utf8");

    await expect(findClaudeExecutable({ PATH: bin }, home, "win32"))
      .resolves.toBe(executable);
  });

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

    const models = await discoverClaudeGatewayModels(
      { credentialPath, environment: {} },
      fetchImpl,
    );
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
    const configLibrary = join(home, "Library", "Application Support", "Claude-3p", "configLibrary");
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
      CLAUDE_CODE_HOST_CREDS_FILE: join(home, "missing.json"),
      CLAUDE_CODE_HOST_AUTH_ENV_VAR: "ANTHROPIC_AUTH_TOKEN",
      CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH: "1",
      ANTHROPIC_BASE_URL: "http://stale.invalid",
      ANTHROPIC_API_KEY: "stale-api-key",
      ANTHROPIC_AUTH_TOKEN: "stale-bearer",
    };
    const runtime = await prepareClaudeRuntime(environment, undefined, "darwin", home);
    expect(runtime.credentialPath).toBe(credentialPath);
    expect(runtime.environment.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:3425");
    expect(runtime.environment.CLAUDE_CODE_HOST_CREDS_FILE).toBeUndefined();
    expect(runtime.environment.CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH).toBeUndefined();
    expect(runtime.environment.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBe("1");
    expect(runtime.environment.CLAUDE_CODE_HOST_AUTH_ENV_VAR).toBe(
      authScheme === "bearer" ? "ANTHROPIC_AUTH_TOKEN" : "ANTHROPIC_API_KEY",
    );
    await expect(resolveClaudeGatewayConfig(runtime)).resolves.toEqual({
      baseUrl: "http://127.0.0.1:3425",
      authScheme,
      ...(authScheme === "bearer" ? { authToken: "fixed-test-key" } : { apiKey: "fixed-test-key" }),
    });
    expect(environment.ANTHROPIC_API_KEY).toBe("stale-api-key");

    const hostPath = join(home, "host-creds-priority.json");
    await writeFile(hostPath, "{}", { mode: 0o600 });
    const withHost = await prepareClaudeRuntime({ ...environment, CLAUDE_CODE_HOST_CREDS_FILE: hostPath }, undefined, "darwin", home);
    expect(withHost.credentialPath).toBe(hostPath);
    expect(withHost.environment.CLAUDE_CODE_HOST_CREDS_FILE).toBe(hostPath);
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
    expect((await prepareClaudeRuntime({ PATH: "" }, undefined, "darwin", home)).credentialPath).toBeUndefined();
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
});
