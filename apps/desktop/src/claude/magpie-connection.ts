import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { BridgeMagpieConnectionTestResult, BridgeMagpieSettings } from "@bridge/protocol";
import type { SafeStorageLike } from "../transport/config.js";
import { discoverClaudeGatewayModels, type ClaudeGatewayConfig, type ClaudeRuntime } from "./claude-runtime-discovery.js";
import { createMagpieQuotaPlugin } from "../../../../plugins/magpie-quota/desktop.js";
import { MAGPIE_QUOTA_METHOD } from "../../../../plugins/magpie-quota/contract.js";

type MagpieConnection = { mode: "auto" } | {
  mode: "manual";
  baseUrl: string;
  authScheme: "bearer" | "x-api-key";
  apiKey: string;
};

/** Bridge owns these credentials; native Desktop profiles are only read by automatic discovery. */
export class MagpieConnectionRepository {
  private connection: MagpieConnection = { mode: "auto" };

  constructor(private readonly path: string, private readonly storage: SafeStorageLike) {}

  async initialize(): Promise<void> {
    let file: Record<string, unknown>;
    try { file = JSON.parse(await readFile(this.path, "utf8")) as Record<string, unknown>; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (file.version !== 1) throw new Error("Magpie 接入配置版本无效");
    if (file.mode === "auto") { this.connection = { mode: "auto" }; return; }
    if (typeof file.protectedKey !== "string" || !file.protectedKey.startsWith("os:")) {
      throw new Error("Magpie Key 存储格式无效");
    }
    if (!this.storage.isEncryptionAvailable()) throw new Error("系统安全存储不可用，无法读取 Magpie Key");
    this.connection = this.resolve({
      mode: file.mode, baseUrl: file.baseUrl, authScheme: file.authScheme,
      apiKey: this.storage.decryptString(Buffer.from(file.protectedKey.slice(3), "base64")),
    });
  }

  resolve(input: unknown): MagpieConnection {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Magpie 接入配置无效");
    const value = input as Record<string, unknown>;
    if (value.mode === "auto") return { mode: "auto" };
    if (value.mode !== "manual" || typeof value.baseUrl !== "string" ||
      (value.authScheme !== "bearer" && value.authScheme !== "x-api-key") ||
      (value.apiKey !== undefined && typeof value.apiKey !== "string")) throw new Error("Magpie 接入配置无效");
    let url: URL;
    try { url = new URL(value.baseUrl.trim()); }
    catch { throw new Error("请输入有效的 Magpie 网关地址"); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error("Magpie 地址须为 HTTP 或 HTTPS，且不包含用户名、密码、查询参数或片段");
    }
    const baseUrl = url.href.replace(/\/+$/u, "");
    const apiKey = (value.apiKey as string | undefined)?.trim() ||
      (this.connection.mode === "manual" && this.connection.baseUrl === baseUrl &&
        this.connection.authScheme === value.authScheme ? this.connection.apiKey : "");
    if (!apiKey || apiKey.length > 8192 || /[\u0000- \u007f]/u.test(apiKey)) {
      throw new Error("请输入 Magpie Key；更换网关或认证方式后需要重新输入");
    }
    return { mode: "manual", baseUrl, authScheme: value.authScheme, apiKey };
  }

  async save(connection: MagpieConnection): Promise<void> {
    if (connection.mode === "manual" && !this.storage.isEncryptionAvailable()) {
      throw new Error("系统安全存储不可用，不能保存 Magpie Key");
    }
    const file = connection.mode === "auto" ? { version: 1, mode: "auto" } : {
      version: 1, mode: "manual", baseUrl: connection.baseUrl, authScheme: connection.authScheme,
      protectedKey: `os:${this.storage.encryptString(connection.apiKey).toString("base64")}`,
    };
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(file) + "\n", { mode: 0o600 });
    await rename(temporary, this.path);
    this.connection = connection;
  }

  settings(gateway?: ClaudeGatewayConfig): BridgeMagpieSettings {
    if (this.connection.mode === "manual") return {
      mode: "manual", baseUrl: this.connection.baseUrl, authScheme: this.connection.authScheme, keyConfigured: true,
    };
    const url = gateway ? new URL(gateway.baseUrl) : undefined;
    return {
      mode: "auto", ...(url ? { baseUrl: `${url.origin}${url.pathname}`.replace(/\/+$/u, "") } : {}),
      ...(gateway ? { authScheme: gateway.authScheme ?? "bearer" } : {}),
      keyConfigured: Boolean(gateway?.authToken || gateway?.apiKey),
    };
  }

  apply(runtime: ClaudeRuntime, connection = this.connection): ClaudeRuntime {
    if (connection.mode === "auto") return runtime;
    const environment = { ...runtime.environment };
    for (const key of [
      "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_CUSTOM_HEADERS", "ANTHROPIC_OAUTH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_HOST_CREDS_FILE", "CLAUDE_CODE_HOST_SESSION_ID",
      "CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_USE_VERTEX",
    ]) delete environment[key];
    environment.ANTHROPIC_BASE_URL = connection.baseUrl;
    const authVariable = connection.authScheme === "bearer" ? "ANTHROPIC_AUTH_TOKEN" : "ANTHROPIC_API_KEY";
    environment[authVariable] = connection.apiKey;
    environment.CLAUDE_CODE_HOST_AUTH_ENV_VAR = authVariable;
    environment.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = "1";
    const prepared: ClaudeRuntime = { ...runtime, environment, configSource: { type: "manual-gateway", profile: "unknown" } };
    delete prepared.credentialPath;
    return prepared;
  }
}

export async function testMagpieGateway(
  runtime: ClaudeRuntime,
  gateway: ClaudeGatewayConfig | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<BridgeMagpieConnectionTestResult> {
  if (!gateway) return {
    models: { state: "error", count: 0, error: "未找到可用的网关配置" },
    quota: { state: "unsupported" },
  };
  const [models, quota] = await Promise.all([
    discoverClaudeGatewayModels(runtime, fetchImpl).then((items): BridgeMagpieConnectionTestResult["models"] => (
      items.length ? { state: "ready", count: items.length } : { state: "error", count: 0, error: "网关未返回可用模型" }
    )).catch((): BridgeMagpieConnectionTestResult["models"] => ({ state: "error", count: 0, error: "模型列表读取失败，请检查地址、认证方式和 Key" })),
    createMagpieQuotaPlugin({ getGateway: () => gateway, fetchImpl }).handle({ method: MAGPIE_QUOTA_METHOD })
      .then((result): BridgeMagpieConnectionTestResult["quota"] => ({ state: result?.status === "available" ? "available" : "unsupported" }))
      .catch((): BridgeMagpieConnectionTestResult["quota"] => ({ state: "error", error: "额度读取失败，请检查网关权限或稍后重试" })),
  ]);
  return { models, quota };
}
