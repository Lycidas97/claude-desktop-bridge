import { expect, it } from "vitest";
import { magpieModelIdHash } from "./claude-runtime-discovery.js";
import { mergeModelCatalog, resolveSessionModel } from "./native-model-catalog.js";

it("keeps picker labels and order, enriches from exact ID, same-window hash and slug, then appends new models", () => {
  const saved = [
    { value: "fixture-provider/first", displayName: "First saved label" },
    { value: "claude/claude-opus-5-5", displayName: "Second saved label" },
    { value: "claude/claude-sonnet-4-6[1m]", displayName: "Third saved label" },
  ];
  const firstHash = magpieModelIdHash(saved[0]!.value);
  const secondHash = magpieModelIdHash(saved[1]!.value);
  const extra = { value: "fixture-provider/extra", displayName: "Gateway-only model" };
  const discovered = [
    { value: `mythos-magpie-${firstHash}`, displayName: "First hash", maxInputTokens: 90_000 },
    { value: "anthropic/claude-opus-5-5", displayName: "Second slug", maxInputTokens: 95_000 },
    { value: `mythos-magpie-${secondHash}[1m]`, displayName: "Second long variant", maxInputTokens: 1_000_000 },
    { value: `mythos-magpie-${secondHash}`, displayName: "Second hash", maxInputTokens: 128_000 },
    { value: "anthropic/claude-sonnet-4-6[1m]", displayName: "Third slug", maxInputTokens: 900_000 },
    { value: saved[0]!.value, displayName: "First discovered label", maxInputTokens: 200_000, supportsEffort: false, supportedEffortLevels: ["low"] },
    extra,
  ];

  expect(mergeModelCatalog(saved, discovered)).toEqual([
    { ...saved[0], maxInputTokens: 200_000, supportsEffort: false, supportedEffortLevels: ["low"] },
    { ...saved[1], maxInputTokens: 128_000 },
    { ...saved[2], maxInputTokens: 900_000 },
    extra,
  ]);
});

it("resolves an unset or default native model from observation, configured default, then picker order", () => {
  const first = { value: "fixture-provider/first", displayName: "First option" };
  const configured = { value: "fixture-provider/configured[1m]", displayName: "Configured 1M label" };
  const observed = { value: "fixture-provider/observed", displayName: "Observed label" };
  const models = [first, configured, observed];

  expect(resolveSessionModel({ nativeModel: " DEFAULT ", contextModel: ` ${observed.value} `, models, defaultModel: configured.value })).toEqual({
    sessionModel: observed.value, configModel: observed.value, modelDisplayName: observed.displayName, extraOption: observed,
  });
  expect(resolveSessionModel({ nativeModel: undefined, contextModel: "mythos-magpie-0000000000", models, defaultModel: configured.value })).toEqual({
    sessionModel: configured.value, configModel: configured.value, modelDisplayName: configured.displayName, extraOption: configured,
  });
  expect(resolveSessionModel({ nativeModel: "default", contextModel: undefined, models, defaultModel: undefined })).toEqual({
    sessionModel: first.value, configModel: first.value, modelDisplayName: first.displayName, extraOption: first,
  });
});

it("uses the explicit model's saved alias before the observed context and keeps the native ID", () => {
  const canonical = { value: "fixture-provider/first[1m]", displayName: "Canonical label" };
  const alias = { value: `mythos-magpie-${magpieModelIdHash(canonical.value)}[1m]`, displayName: "Saved alias label" };
  const contextModel = "claude-sonnet-4-6";

  expect(resolveSessionModel({ nativeModel: alias.value, contextModel, models: [canonical, alias], defaultModel: undefined })).toEqual({
    sessionModel: alias.value, configModel: alias.value, modelDisplayName: alias.displayName, extraOption: alias,
  });
  expect(resolveSessionModel({ nativeModel: alias.value, contextModel, models: [canonical], defaultModel: undefined })).toEqual({
    sessionModel: alias.value, configModel: canonical.value, modelDisplayName: canonical.displayName, extraOption: canonical,
  });
});

it("uses the observed model to label an opaque native alias while preserving its long-context setting", () => {
  const nativeModel = "mythos-magpie-0000000000[1m]";
  const base = { value: "claude/claude-sonnet-4-6", displayName: "Saved Sonnet", maxInputTokens: 250_000 };
  const long = { ...base, value: `${base.value}[1m]`, displayName: "Saved Sonnet · 1M" };

  expect(resolveSessionModel({ nativeModel, contextModel: "claude-sonnet-4-6", models: [base], defaultModel: undefined })).toEqual({
    sessionModel: nativeModel, configModel: long.value, modelDisplayName: long.displayName, extraOption: long,
  });
  expect(resolveSessionModel({ nativeModel, contextModel: undefined, models: [base], defaultModel: base.value })).toEqual({
    sessionModel: nativeModel, configModel: nativeModel,
  });
});
