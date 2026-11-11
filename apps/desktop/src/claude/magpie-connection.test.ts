import { rm, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SafeStorageLike } from "../transport/config.js";
import { hasClaudeRuntimeCredentials, resolveClaudeGatewayConfig, type ClaudeRuntime } from "./claude-runtime-discovery.js";
import { MagpieConnectionRepository, testMagpieGateway } from "./magpie-connection.js";

const roots: string[] = [];
const storage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (text) => Buffer.from(text.split("").reverse().join("")),
  decryptString: (buffer) => buffer.toString().split("").reverse().join(""),
};
const manual = { mode: "manual" as const, baseUrl: "https://gateway.example.test", authScheme: "bearer" as const, apiKey: "synthetic-magpie-key" };
const automatic: ClaudeRuntime = {
  executablePath: "/synthetic/claude", credentialPath: "/synthetic/host-creds.json",
  environment: { ANTHROPIC_BASE_URL: "https://automatic.example.test", ANTHROPIC_AUTH_TOKEN: "synthetic-auto-key", CLAUDE_CODE_HOST_CREDS_FILE: "/synthetic/host-creds.json", ANTHROPIC_API_KEY: "stale" },
};
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bridge-magpie-config-"));
  roots.push(root);
  const path = join(root, "magpie.json");
  const repository = new MagpieConnectionRepository(path, storage);
  await repository.initialize();
  return { root, path, repository };
}
const gatewayFetch = vi.fn(async (url: string | URL | Request) => String(url).includes("/models")
  ? Response.json({ data: [{ id: "example/model", display_name: "Example model" }] })
  : Response.json({ data: [{ provider: "example", user: "synthetic", windows: [] }] }));

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  vi.unstubAllGlobals();
  gatewayFetch.mockClear();
});

describe("Magpie connection storage and authentication", () => {
  it("defaults to discovery, encrypts a manual key and restores it after restart without exposing it in settings", async () => {
    const { path, repository } = await fixture();
    expect(repository.settings()).toEqual({ mode: "auto", keyConfigured: false });
    await repository.save(repository.resolve(manual));
    const file = await readFile(path, "utf8");
    expect(file).not.toContain(manual.apiKey);
    expect(JSON.parse(file).protectedKey).toMatch(/^os:/u);
    const restarted = new MagpieConnectionRepository(path, storage);
    await restarted.initialize();
    expect(restarted.settings()).toEqual({ mode: "manual", baseUrl: manual.baseUrl, authScheme: "bearer", keyConfigured: true });
    expect(JSON.stringify(restarted.settings())).not.toContain(manual.apiKey);
    expect(await resolveClaudeGatewayConfig(restarted.apply(automatic))).toMatchObject({ baseUrl: manual.baseUrl, authToken: manual.apiKey });
  });

  it("preserves a saved key only for the same normalized URL and authentication", async () => {
    const { repository } = await fixture();
    await repository.save(repository.resolve(manual));
    expect(repository.resolve({ ...manual, baseUrl: `${manual.baseUrl}/`, apiKey: "" })).toMatchObject({ apiKey: manual.apiKey });
    expect(() => repository.resolve({ ...manual, baseUrl: "https://other.example.test", apiKey: "" })).toThrow("重新输入");
    expect(() => repository.resolve({ ...manual, authScheme: "x-api-key", apiKey: "" })).toThrow("重新输入");
  });

  it.each(["file:///private/config", "https://user:password@gateway.example.test", "https://gateway.example.test?key=secret", "https://gateway.example.test#secret"])("rejects a non-endpoint URL: %s", async (baseUrl) => {
    const { repository } = await fixture();
    expect(() => repository.resolve({ ...manual, baseUrl })).toThrow("Magpie 地址");
  });

  it("refuses to save a manual key without system encryption", async () => {
    const { path } = await fixture();
    const repository = new MagpieConnectionRepository(path, { ...storage, isEncryptionAvailable: () => false });
    await expect(repository.save(repository.resolve(manual))).rejects.toThrow("系统安全存储不可用");
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["bearer", "x-api-key"] as const)("uses only the selected %s authentication for discovery and quota without a Host credential file", async (authScheme) => {
    const { repository } = await fixture();
    const runtime = repository.apply(automatic, repository.resolve({ ...manual, authScheme }));
    expect(runtime.credentialPath).toBeUndefined();
    expect(runtime.environment.CLAUDE_CODE_HOST_CREDS_FILE).toBeUndefined();
    expect(hasClaudeRuntimeCredentials(runtime)).toBe(true);
    const gateway = await resolveClaudeGatewayConfig(runtime);
    const result = await testMagpieGateway(runtime, gateway, gatewayFetch as typeof fetch);
    expect(result).toEqual({ models: { state: "ready", count: 1 }, quota: { state: "available" } });
    for (const [, options] of gatewayFetch.mock.calls as unknown as Array<[string, RequestInit]>) {
      const headers = options.headers as Record<string, string>;
      expect(headers[authScheme === "bearer" ? "authorization" : "x-api-key"]).toBe(authScheme === "bearer" ? `Bearer ${manual.apiKey}` : manual.apiKey);
      expect(headers[authScheme === "bearer" ? "x-api-key" : "authorization"]).toBeUndefined();
    }
  });

  it("reports an unsupported quota endpoint separately from a working model endpoint", async () => {
    const { repository } = await fixture();
    const runtime = repository.apply(automatic, repository.resolve(manual));
    const result = await testMagpieGateway(runtime, await resolveClaudeGatewayConfig(runtime), (async (url) =>
      String(url).includes("/models") ? gatewayFetch(url) : new Response("not supported", { status: 404 })) as typeof fetch);
    expect(result).toEqual({ models: { state: "ready", count: 1 }, quota: { state: "unsupported" } });
  });

  it("does not disclose upstream bodies or credentials on authentication failure", async () => {
    const { repository } = await fixture();
    const runtime = repository.apply(automatic, repository.resolve(manual));
    const result = await testMagpieGateway(runtime, await resolveClaudeGatewayConfig(runtime), (async () => new Response(manual.apiKey, { status: 401 })) as typeof fetch);
    expect(result.models.state).toBe("error");
    expect(result.quota.state).toBe("error");
    expect(JSON.stringify(result)).not.toContain(manual.apiKey);
  });
});
