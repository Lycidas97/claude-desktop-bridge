import { describe, expect, it } from "vitest";
import { magpieModelIdHash } from "./claude-runtime-discovery.js";
import { SessionModelCatalog } from "./session-model-catalog.js";

describe("SessionModelCatalog", () => {
  it("replaces observed model hints with discovered metadata and derives selected 1M capabilities", () => {
    const catalog = new SessionModelCatalog();
    expect([catalog.gatewayModelsDiscovered, catalog.modelCatalogComplete, catalog.modelCatalogDiscoveryAttempted]).toEqual([false, false, false]);
    catalog.rememberCatalogModels([{ hostModel: "claude-old-model" }, { hostModel: "mythos-magpie-1052229916" }, {}]);
    expect(catalog.availableModels()).toEqual([{ value: "claude-old-model", displayName: "Old Model" }]);
    const efforts = ["low", "high"];
    catalog.rememberModels([
      { value: "claude-sonnet-4-6", displayName: "Sonnet 4.6", description: "Gateway model", resolvedModel: "native-sonnet", maxInputTokens: 200_000, supportsEffort: true, supportedEffortLevels: efforts },
      { value: "claude-fable-5[1m]", displayName: "Fable 5 1M" },
    ]);
    efforts.push("max");
    const models = catalog.availableModels("claude-sonnet-4-6[1m]");
    expect(models[0]).toEqual({ value: "claude-sonnet-4-6[1m]", displayName: "Sonnet 4.6 · 1M", description: "Gateway model", resolvedModel: "native-sonnet[1m]", maxInputTokens: 1_000_000, supportsEffort: true, supportedEffortLevels: ["low", "high"] });
    expect(models.some((model) => model.value === "claude-old-model")).toBe(false);
    expect(catalog.findModelInfo("native-sonnet", models)?.value).toBe("claude-sonnet-4-6");
    expect(catalog.modelContextLimit("claude-sonnet-4-6")).toBe(200_000);
    expect(catalog.modelContextLimit("claude-sonnet-4-6[1m]")).toBe(1_000_000);
    expect(catalog.modelContextLimit(undefined, true)).toBe(1_000_000);
    catalog.modelCatalogComplete = true;
    catalog.rememberCatalogModels([{ hostModel: "another-hint" }]);
    catalog.rememberModels([]);
    expect(catalog.availableModels()).toHaveLength(3);
    expect(catalog.availableModels().some((model) => model.value === "another-hint")).toBe(false);
  });

  it("resolves synthetic Magpie aliases by hash and keeps gateway order and long-context display names", () => {
    const catalog = new SessionModelCatalog();
    catalog.gatewayModelsDiscovered = true;
    catalog.modelCatalogComplete = true;
    catalog.rememberModels([
      { value: "provider-z", displayName: "Z model", maxInputTokens: 120_000 },
      { value: "provider-a", displayName: "A model", maxInputTokens: 200_000 },
      { value: "provider-a[1m]", displayName: "A model 1M", maxInputTokens: 1_000_000 },
    ]);
    const synthetic = `mythos-magpie-${magpieModelIdHash("provider-a")}`;
    const selected = catalog.availableModels(`${synthetic}[1m]`);
    expect(selected.map((model) => model.value)).toEqual(["provider-a[1m]", "provider-z", "provider-a"]);
    expect(catalog.resolveModelDisplayName(synthetic)).toBe("A model");
    expect(catalog.resolveModelDisplayName(`${synthetic}[1m]`)).toBe("A model 1M");
    expect(catalog.modelContextLimit(synthetic)).toBe(200_000);
    expect(catalog.resolveModelDisplayName("provider-z[1m]")).toBe("Z model 1M");
    expect(catalog.availableModels("magpie-0000000000").map((model) => model.value)).toEqual(["provider-z", "provider-a", "provider-a[1m]"]);
  });

  it("formats unknown models without exposing synthetic hashes and honors resolved synthetic IDs", () => {
    const catalog = new SessionModelCatalog();
    expect(catalog.resolveModelDisplayName(undefined)).toBeUndefined();
    expect(catalog.resolveModelDisplayName("mythos-magpie-0000000000")).toBe("默认模型");
    expect(catalog.modelDisplayName("magpie-0000000000.anthropic.claude-opus-4-6[1m]")).toBe("Opus 4 6 · 1M");
    expect(catalog.modelDisplayName("claude-sonnet-4-6")).toBe("Sonnet 4 6");
    const resolvedModel = "magpie-0000000000.anthropic.claude-opus-4-6";
    catalog.rememberModels([{ value: "gateway-model", displayName: "Friendly model", resolvedModel, supportsEffort: false }]);
    expect(catalog.findModelInfo("mythos-magpie-0000000000", catalog.availableModels())?.value).toBe("gateway-model");
    expect(catalog.resolveModelDisplayName("mythos-magpie-0000000000[1m]")).toBe("Friendly model · 1M");
    expect(catalog.availableModels("custom-model")[0]).toEqual({ value: "custom-model", displayName: "Custom Model" });
    expect(catalog.availableModels().find((model) => model.value === "gateway-model")?.supportsEffort).toBe(false);
    expect(catalog.modelContextLimit("unknown")).toBeUndefined();
  });
});
