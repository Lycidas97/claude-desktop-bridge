import { createRequire } from "node:module";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { magpieModelIdHash } from "./claude-runtime-discovery.js";
import { MagpieConnectionRepository } from "./magpie-connection.js";
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

  it("rejects empty or generic placeholder titles and caps at 40 code points cleanly", () => {
    expect(sanitizeGeneratedTitle("")).toBeUndefined();
    expect(sanitizeGeneratedTitle("   ")).toBeUndefined();
    expect(sanitizeGeneratedTitle("Claude 会话")).toBeUndefined();
    expect(sanitizeGeneratedTitle('"New Chat."')).toBeUndefined();
    expect(sanitizeGeneratedTitle("新建会话")).toBeUndefined();
    const longEmoji = `${"🚀".repeat(45)}`;
    const capped = sanitizeGeneratedTitle(longEmoji)!;
    expect(Array.from(capped)).toHaveLength(40);
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
  it("resolves manual Magpie, configLibrary fixed gateway, and settingsPath API keys", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-title-gateway-"));
    directories.push(root);

    const storage = {
      isEncryptionAvailable: () => true,
      encryptString: (plain: string) => Buffer.from(plain, "utf8"),
      decryptString: (cipher: Buffer) => cipher.toString("utf8"),
    };
    const manualRepo = new MagpieConnectionRepository(join(root, "magpie.json"), storage);
    await manualRepo.save({
      mode: "manual",
      baseUrl: "https://magpie.example.test",
      authScheme: "bearer",
      apiKey: "manual-token",
    });
    await expect(resolveActiveClaudeGateway({ magpieConnection: manualRepo, allowAmbientDiscovery: false })).resolves.toEqual({
      baseUrl: "https://magpie.example.test",
      authToken: "manual-token",
      authScheme: "bearer",
    });

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
    await expect(resolveActiveClaudeGateway({
      home: root,
      platform,
      environment: { APPDATA: appData },
      allowAmbientDiscovery: true,
    })).resolves.toEqual({
      baseUrl: "https://fixed.example.test/v1",
      apiKey: "fixed-key",
      authScheme: "x-api-key",
    });

    const settingsPath = join(root, "settings.json");
    await writeFile(settingsPath, JSON.stringify({ env: { ANTHROPIC_API_KEY: "settings-direct-key" } }));
    await expect(resolveActiveClaudeGateway({
      settingsPath,
      allowAmbientDiscovery: false,
    })).resolves.toEqual({
      baseUrl: "https://api.anthropic.com",
      apiKey: "settings-direct-key",
      authScheme: "x-api-key",
    });
  });

  it("queries POST /v1/messages with bearer + x-api-key headers and falls back cleanly on HTTP/generic responses", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({
      content: [
        { type: "thinking", thinking: "internal" },
        { type: "text", text: '  "远程开启 9229 调试端口。"  ' },
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
    });

    fetchImpl.mockResolvedValueOnce(new Response("upstream unavailable", { status: 502 }));
    await expect(generateSessionTitle({
      text: "重构会话分组拖拽长按手势逻辑。补充单元测试。",
      gateway: { baseUrl: "https://gateway.example.test", authToken: "gw-bearer-token" },
      fetchImpl,
    })).resolves.toBe("重构会话分组拖拽长按手势逻辑");

    fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify({
      content: [{ type: "text", text: "Claude 会话" }],
    }), { status: 200 }));
    await expect(generateSessionTitle({
      text: "修复 Windows 空前台句柄菜单点击",
      gateway: { baseUrl: "https://gateway.example.test", authToken: "gw-bearer-token" },
      fetchImpl,
    })).resolves.toBe("修复 Windows 空前台句柄菜单点击");
  });
});
