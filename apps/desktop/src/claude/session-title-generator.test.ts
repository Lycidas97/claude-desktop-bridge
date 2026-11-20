import { createRequire } from "node:module";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverClaudeGatewayConfig, magpieModelIdHash } from "./claude-runtime-discovery.js";
import {
  deriveFallbackSessionTitle,
  generateSessionTitle,
  resolveActiveClaudeGateway,
  resolveTitleGenerationModel,
  sanitizeGeneratedTitle,
} from "./session-title-generator.js";

createRequire(import.meta.url)("../../../../scripts/recycle-cleanup.cjs");

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe("sanitizeGeneratedTitle", () => {
  it("strips quotes, markdown, prefixes, and trailing punctuation while collapsing whitespace", () => {
    expect(sanitizeGeneratedTitle('  # "修复登录超时问题。" \n\t ')).toBe("修复登录超时问题");
    expect(sanitizeGeneratedTitle("Title: `**Fix WebSocket Reconnect Bug.**`")).toBe("Fix WebSocket Reconnect Bug");
    expect(sanitizeGeneratedTitle("标题：「移动端字体缩放适配」")).toBe("移动端字体缩放适配");
  });

  it("rejects empty or generic placeholder titles and titles over 40 code points", () => {
    expect(sanitizeGeneratedTitle("")).toBeUndefined();
    expect(sanitizeGeneratedTitle("   ")).toBeUndefined();
    expect(sanitizeGeneratedTitle("Claude 会话")).toBeUndefined();
    expect(sanitizeGeneratedTitle('"New Chat."')).toBeUndefined();
    expect(sanitizeGeneratedTitle("新建会话")).toBeUndefined();
    const maxTitle = "🚀".repeat(40);
    expect(sanitizeGeneratedTitle(maxTitle)).toBe(maxTitle);
    expect(sanitizeGeneratedTitle(`${maxTitle}🚀`)).toBeUndefined();
  });
});

describe("deriveFallbackSessionTitle", () => {
  it("strips code fences, URLs when prose exists, markdown bullets, and slash command prefixes", () => {
    const prompt = [
      "- # /review 请检查 https://github.com/org/repo/pull/123 为什么移动端顶部标题会出现重复渲染问题。顺便看看暗色主题。",
      "```tsx",
      "export function Header() { return <div />; }",
      "```",
    ].join("\n");
    expect(deriveFallbackSessionTitle(prompt, false)).toBe("请检查 为什么移动端顶部标题会出现重复渲染问题");
  });

  it("truncates long clauses to 24 code points with ellipsis and handles image-only or code-only messages", () => {
    expect(deriveFallbackSessionTitle("", true)).toBe("图片分析");
    expect(deriveFallbackSessionTitle("   \n  ", false)).toBeUndefined();
    expect(deriveFallbackSessionTitle("Investigate why Windows 11 foreground window restoration fails when desktop is idle", false))
      .toBe("Investigate why Windows…");
    expect(deriveFallbackSessionTitle("```ts\nfunction parseSocketFrame() {}\n```", false))
      .toBe("function parseSocketFram…");
    expect(deriveFallbackSessionTitle("https://example.com/only-url", false))
      .toBe("https://example.com/only…");
  });
});

describe("resolveTitleGenerationModel", () => {
  it("strips [1m] and resolves Magpie synthetic model hashes against the catalog", () => {
    const upstream = "anthropic/claude-sonnet-4-6";
    const synthetic = `mythos-magpie-${magpieModelIdHash(upstream)}.anthropic.claude-sonnet-4-6[1m]`;
    expect(resolveTitleGenerationModel(synthetic, [
      { value: `${upstream}[1m]`, displayName: "Claude Sonnet 4.6" },
    ])).toBe(upstream);
    expect(resolveTitleGenerationModel(synthetic, [])).toBe("claude-sonnet-4-6");
    expect(resolveTitleGenerationModel("default", [])).toBe("claude-3-5-haiku-latest");
  });
});

describe("resolveActiveClaudeGateway and generateSessionTitle", () => {
  it("prefers a Desktop gateway, then a settings API key, then the environment", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-title-gateway-"));
    directories.push(root);
    const settingsPath = join(root, "settings.json");
    await writeFile(settingsPath, JSON.stringify({ env: { ANTHROPIC_API_KEY: "settings-direct-key" } }));

    const platform = process.platform === "win32" ? "win32" : "darwin";
    const appData = platform === "win32" ? join(root, "AppData", "Roaming") : join(root, "Library", "Application Support");
    const profileDir = join(appData, "Claude-3p", "configLibrary");
    await mkdir(profileDir, { recursive: true });
    await writeFile(join(profileDir, "_meta.json"), JSON.stringify({ appliedId: "gw-1" }));
    const entryPath = join(profileDir, "gw-1.json");
    await writeFile(entryPath, JSON.stringify({
      inferenceProvider: "gateway",
      inferenceGatewayBaseUrl: "https://fixed.example.test/v1",
      inferenceGatewayAuthScheme: "x-api-key",
      inferenceGatewayApiKey: "fixed-key",
    }), { mode: 0o600 });
    await chmod(entryPath, 0o600);
    const environment = {
      APPDATA: appData,
      ANTHROPIC_BASE_URL: "https://ambient.example.test",
      ANTHROPIC_AUTH_TOKEN: "test-ambient-auth",
    };
    const options = { home: root, platform, environment } as const;
    const hostPath = join(root, "host-creds-test.json");
    await writeFile(hostPath, JSON.stringify({ env: {
      ANTHROPIC_BASE_URL: "https://host.example.test",
      ANTHROPIC_API_KEY: "host-key",
      CLAUDE_CODE_HOST_AUTH_ENV_VAR: "ANTHROPIC_API_KEY",
    } }), { mode: 0o600 });
    const withHost = { ...options, settingsPath, environment: { ...environment, CLAUDE_CODE_HOST_CREDS_FILE: hostPath } };
    expect((await resolveActiveClaudeGateway(withHost))?.gateway).toEqual({
      baseUrl: "https://host.example.test", apiKey: "host-key", authScheme: "x-api-key",
    });
    await writeFile(hostPath, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://host.example.test" } }));
    expect((await resolveActiveClaudeGateway(withHost))?.gateway).toEqual({
      baseUrl: "https://fixed.example.test/v1",
      apiKey: "fixed-key",
      authScheme: "x-api-key",
    });
    expect((await resolveActiveClaudeGateway({ ...options, roots: [], settingsPath }))?.gateway).toEqual({
      baseUrl: "https://api.anthropic.com",
      apiKey: "settings-direct-key",
      authScheme: "x-api-key",
    });
    expect((await resolveActiveClaudeGateway({ ...options, roots: [] }))?.gateway).toEqual({
      baseUrl: environment.ANTHROPIC_BASE_URL,
      authToken: environment.ANTHROPIC_AUTH_TOKEN,
    });
  });

  it.each(["custom.example.test", ""])("skips invalid explicit gateway URL %j in settings and environment", async (baseUrl) => {
    const root = await mkdtemp(join(tmpdir(), "bridge-title-gateway-"));
    directories.push(root);
    const settingsPath = join(root, "settings.json");
    await writeFile(settingsPath, JSON.stringify({ env: {
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_API_KEY: "settings-key",
    } }));

    const environment = { ANTHROPIC_BASE_URL: "https://ambient.example.test", ANTHROPIC_API_KEY: "ambient-key" };
    expect.soft((await resolveActiveClaudeGateway({ roots: [], settingsPath, environment }))?.gateway).toEqual({
      baseUrl: environment.ANTHROPIC_BASE_URL, apiKey: environment.ANTHROPIC_API_KEY,
    });
    await expect.soft(resolveActiveClaudeGateway({ roots: [], environment: {
      ...environment, ANTHROPIC_BASE_URL: baseUrl,
    } })).resolves.toBeUndefined();
    expect((await resolveActiveClaudeGateway({ roots: [], environment: { ANTHROPIC_API_KEY: "ambient-key" } }))?.gateway).toEqual({
      baseUrl: "https://api.anthropic.com", apiKey: "ambient-key", authScheme: "x-api-key",
    });
  });

  it("preserves Desktop Host credentials completed by the environment after settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-title-gateway-"));
    directories.push(root);
    const hostPath = join(root, "host-creds-test.json");
    await writeFile(hostPath, JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "host-title-token" } }), { mode: 0o600 });
    const options = { roots: [root], environment: { ANTHROPIC_BASE_URL: "https://ambient.example.test" } };
    const gateway = await discoverClaudeGatewayConfig(options);
    expect(gateway).toEqual({ baseUrl: options.environment.ANTHROPIC_BASE_URL, authToken: "host-title-token" });
    expect((await resolveActiveClaudeGateway(options))?.gateway).toEqual(gateway);

    const settingsPath = join(root, "settings.json");
    await writeFile(settingsPath, JSON.stringify({ env: { ANTHROPIC_API_KEY: "settings-key" } }));
    expect((await resolveActiveClaudeGateway({ ...options, settingsPath }))?.gateway).toEqual({
      baseUrl: "https://api.anthropic.com", apiKey: "settings-key", authScheme: "x-api-key",
    });
  });

  it.each([
    { name: "short unrelated text", texts: ["示例开发工具背景信息 由示例公司开发"] },
    { name: "long unrelated text", texts: ["关于示例开发工具的背景信息与功能介绍：此工具由示例公司开发，可在终端中执行多种自动化任务。"] },
    { name: "model self-description before an untagged title", texts: ["Request is to produce a title only.\n\n松港用户动线检查"] },
    { name: "extra text in another block", texts: ["<title>松港用户动线检查</title>", "Here is an explanation."] },
    { name: "a multiline tagged title", texts: ["<title>松港界面\n用户动线检查</title>"] },
    { name: "a Unicode line separator", texts: [`<title>松港用户动线检查${String.fromCodePoint(0x2028)}这里是补充说明</title>`] },
    { name: "a Unicode paragraph separator", texts: [`<title>松港用户动线检查${String.fromCodePoint(0x2029)}这里是补充说明</title>`] },
    { name: "a code fence fragment", texts: ["<title>```json</title>"] },
    { name: "duplicate title envelopes", texts: ["<title>松港界面检查</title><title>松港用户动线检查</title>"] },
    { name: "an overlong tagged title", texts: [`<title>${"字".repeat(41)}</title>`] },
    { name: "an output token limit", texts: ["<title>松港用户动线检查</title>"], stopReason: "max_tokens" },
    { name: "a context window limit", texts: ["<title>松港用户动线检查</title>"], stopReason: "model_context_window_exceeded" },
    { name: "a refusal", texts: ["<title>松港用户动线检查</title>"], stopReason: "refusal" },
  ])("falls back to the first message for $name", async ({ texts, stopReason }) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      content: texts.map(text => ({ type: "text", text })),
      stop_reason: stopReason ?? "end_turn",
    }));

    await expect(generateSessionTitle({
      text: "检查松港界面的用户动线。找出风格不统一的页面。",
      gateway: { baseUrl: "https://gateway.example.test", authToken: "test-token" },
      fetchImpl,
    })).resolves.toBe("检查松港界面的用户动线");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("queries POST /v1/messages with bearer + x-api-key headers and falls back cleanly on HTTP/generic responses", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({
      stop_reason: "end_turn",
      content: [
        { type: "thinking", thinking: "internal" },
        { type: "text", text: '  <title>"远程开启 9229 调试端口。"</title>  ' },
      ],
    }), { status: 200 }));

    const title = await generateSessionTitle({
      text: "请帮我实现手机端一键远程启动 Claude Desktop 并开启 9229 端口",
      gateway: {
        baseUrl: "https://gateway.example.test/v1/",
        authToken: "gw-bearer-token",
        authScheme: "bearer",
      },
      preferredModel: "claude-sonnet-4-6[1m]",
      fetchImpl,
    });
    expect(title).toBe("远程开启 9229 调试端口");
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://gateway.example.test/v1/messages");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      "anthropic-version": "2023-06-01",
      authorization: "Bearer gw-bearer-token",
      "x-api-key": "gw-bearer-token",
    });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: "claude-sonnet-4-6",
      max_tokens: 48,
      system: expect.stringContaining("between <title> and </title>"),
    });

    fetchImpl.mockResolvedValueOnce(new Response("upstream unavailable", { status: 502 }));
    await expect(generateSessionTitle({
      text: "重构会话分组拖拽长按手势逻辑。补充单元测试。",
      gateway: { baseUrl: "https://gateway.example.test", authToken: "gw-bearer-token" },
      fetchImpl,
    })).resolves.toBe("重构会话分组拖拽长按手势逻辑");

    fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify({
      content: [{ type: "text", text: "<title>Claude 会话</title>" }],
    }), { status: 200 }));
    await expect(generateSessionTitle({
      text: "修复 Windows 空前台句柄菜单点击",
      gateway: { baseUrl: "https://gateway.example.test", authToken: "gw-bearer-token" },
      fetchImpl,
    })).resolves.toBe("修复 Windows 空前台句柄菜单点击");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
