import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SafeStorageLike } from "./config.js";
import { hasClaudeRuntimeCredentials, resolveClaudeGatewayConfig, type ClaudeRuntime } from "./claude-runtime-discovery.js";
import { MagpieConnectionRepository, testMagpieGateway } from "./magpie-connection.js";
import { Claude3pProviderAdapter } from "./provider-runtime-pool.js";
import { SessionBroker } from "./session-broker.js";
import { SessionEventLog } from "./session-event-log.js";
import { TranscriptObserver } from "./transcript-observer.js";

const roots: string[] = [];
const brokers: SessionBroker[] = [];
const logs: SessionEventLog[] = [];
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
  for (const broker of brokers.splice(0)) await broker.close();
  for (const log of logs.splice(0)) await log.close();
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

  it.each(["bearer", "x-api-key"] as const)("uses only the selected %s authentication for discovery, quota and an executor without a Host credential file", async (authScheme) => {
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
    const plan = await new Claude3pProviderAdapter().hostPlan("logical", {
      laneId: "lane", conversationId: "logical", providerProfileId: "profile", providerKind: "claude-3p",
      status: "active", access: "read-write", nativeSessionId: "native", createdAt: 1, updatedAt: 1,
    }, runtime);
    expect(plan.environment.ANTHROPIC_BASE_URL).toBe(manual.baseUrl);
    expect(plan.nativeSessionId).toBe("native");
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

it("applies manual settings to broker discovery and quota, keeps the saved setting on failed validation, and restores automatic discovery", async () => {
  const { root, path, repository } = await fixture();
  vi.stubGlobal("fetch", gatewayFetch);
  const paths = { sessions: join(root, "sessions"), projects: join(root, "projects"), tasks: join(root, "tasks"), desktopSessions: [] };
  const eventLog = new SessionEventLog(join(root, "events.jsonl"), 1);
  logs.push(eventLog);
  const observer = new TranscriptObserver({ paths, eventLog, platform: "linux", catalogIntervalMs: 0 });
  const broker = new SessionBroker({ paths, observer, eventLog, sessionsPath: join(root, "sessions.json"), queuePath: join(root, "queue.json"), magpieConnection: repository, prepareRuntime: async () => automatic });
  brokers.push(broker);
  await broker.initialize();
  const before = await broker.magpieSettings();
  expect(before.magpie).toMatchObject({ mode: "auto", baseUrl: "https://automatic.example.test" });
  await broker.testMagpieConnection(manual);
  expect(await broker.magpieSettings()).toEqual(before);
  await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  await broker.saveMagpieConnection(manual);
  expect(broker.runtimeStatus()).toMatchObject({ state: "ready", detection: { configSource: { type: "manual-gateway" }, modelDiscovery: { state: "ready", count: 1 } } });
  expect(await broker.gatewayConfig()).toMatchObject({ baseUrl: manual.baseUrl, authToken: manual.apiKey });
  expect(broker.availableModels().some((model) => model.value === "example/model")).toBe(true);
  vi.stubGlobal("fetch", async () => new Response("synthetic failure", { status: 401 }));
  await expect(broker.saveMagpieConnection({ ...manual, baseUrl: "https://bad.example.test" })).rejects.toThrow("模型列表读取失败");
  expect((await broker.magpieSettings()).magpie?.baseUrl).toBe(manual.baseUrl);
  vi.stubGlobal("fetch", gatewayFetch);
  await broker.saveMagpieConnection({ mode: "auto" });
  expect((await broker.gatewayConfig())?.baseUrl).toBe("https://automatic.example.test");
  expect((await broker.magpieSettings()).magpie?.mode).toBe("auto");
  expect(JSON.stringify(await broker.magpieSettings())).not.toContain("synthetic-auto-key");
});
