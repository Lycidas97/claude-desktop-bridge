import type { BridgeModelInfo } from "@bridge/protocol";
import {
  humanizeMagpieAnthropicModel,
  humanizeUpstreamModelId,
  magpieModelIdHash,
  normalizeAnthropicModelSlug,
  parseMagpieSyntheticModelId,
} from "./claude-runtime-discovery.js";

export function modelOptionHash(value: string): string {
  return parseMagpieSyntheticModelId(value)?.hash ?? magpieModelIdHash(value);
}

export function mergeModelCatalog(
  saved: BridgeModelInfo[] | undefined,
  discovered: BridgeModelInfo[] | undefined,
): BridgeModelInfo[] | undefined {
  if (!discovered?.length) return saved;
  if (!saved?.length) return discovered;
  const merged = saved.map(option => {
    const longContext = /\[1m\]$/iu.test(option.value);
    const hash = modelOptionHash(option.value);
    const slug = normalizeAnthropicModelSlug(option.value);
    const match = discovered.find(item => item.value === option.value)
      ?? discovered.find(item => modelOptionHash(item.value) === hash && /\[1m\]$/iu.test(item.value) === longContext)
      ?? (slug ? discovered.find(item => normalizeAnthropicModelSlug(item.value) === slug && /\[1m\]$/iu.test(item.value) === longContext) : undefined);
    if (!match) return option;
    return {
      ...option,
      ...(match.maxInputTokens ? { maxInputTokens: match.maxInputTokens } : {}),
      ...(match.supportsEffort !== undefined ? { supportsEffort: match.supportsEffort } : {}),
      ...(match.supportedEffortLevels?.length ? { supportedEffortLevels: match.supportedEffortLevels } : {}),
    };
  });
  // Keep the picker's context choices authoritative, including for Native's base-to-1M readback.
  const coveredHashes = new Set(saved.map(option => modelOptionHash(option.value)));
  const coveredSlugs = new Set(saved.map(option => normalizeAnthropicModelSlug(option.value)));
  for (const item of discovered) {
    const hash = modelOptionHash(item.value);
    const slug = normalizeAnthropicModelSlug(item.value);
    if (coveredHashes.has(hash) || (slug && coveredSlugs.has(slug))) continue;
    merged.push(item);
  }
  return merged;
}

export function savedModelOption(models: readonly BridgeModelInfo[] | undefined, model: string): BridgeModelInfo | undefined {
  const exact = models?.find(option => option.value === model);
  if (exact) return exact;
  const longContext = /\[1m\]$/iu.test(model);
  const alias = parseMagpieSyntheticModelId(model);
  const targetSlug = normalizeAnthropicModelSlug(model);
  const matched = (alias
    ? models?.find(option => modelOptionHash(option.value) === alias.hash && /\[1m\]$/iu.test(option.value) === alias.longContext)
    : undefined)
    ?? (targetSlug
      ? models?.find(option => normalizeAnthropicModelSlug(option.value) === targetSlug && /\[1m\]$/iu.test(option.value) === longContext)
      : undefined);
  if (matched) return matched;
  if (!longContext) {
    const longOption = models?.find(option => option.value.toLowerCase() === `${model.toLowerCase()}[1m]`)
      ?? (alias
        ? models?.find(option => /\[1m\]$/iu.test(option.value) && modelOptionHash(option.value) === alias.hash)
        : undefined)
      ?? (targetSlug
        ? models?.find(option => /\[1m\]$/iu.test(option.value) && normalizeAnthropicModelSlug(option.value) === targetSlug)
        : undefined);
    if (!longOption) return undefined;
    const { maxInputTokens, ...rest } = longOption;
    return {
      ...rest,
      value: longOption.value.replace(/\[1m\]$/iu, ""),
      displayName: longOption.displayName.replace(/\s*(?:·\s*)?1M$/iu, ""),
      ...(maxInputTokens !== undefined && maxInputTokens !== 1_000_000 ? { maxInputTokens } : {}),
    };
  }
  const base = models?.find(option => model === `${option.value}[1m]`)
    ?? (alias
      ? models?.find(option => !/\[1m\]$/iu.test(option.value) && modelOptionHash(option.value) === alias.hash)
      : undefined)
    ?? (targetSlug
      ? models?.find(option => !/\[1m\]$/iu.test(option.value) && normalizeAnthropicModelSlug(option.value) === targetSlug)
      : undefined);
  // Desktop's provider can prefer 1M even when the saved picker only lists the base model.
  return base ? { ...base, value: `${base.value}[1m]`, displayName: `${base.displayName} · 1M` } : undefined;
}

export function directModelDisplayName(model: string | undefined, models: readonly BridgeModelInfo[] | undefined): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed || trimmed.toLowerCase() === "default") return undefined;
  const saved = savedModelOption(models, trimmed);
  if (saved) return saved.displayName;
  if (trimmed.includes("/") || /^(?:claude|gpt|gemini)-/iu.test(trimmed)) {
    return humanizeUpstreamModelId(trimmed);
  }
  return humanizeMagpieAnthropicModel(trimmed);
}

export function resolveSessionModel({ nativeModel, contextModel, models, defaultModel }: {
  nativeModel: string | undefined;
  contextModel: string | undefined;
  models: readonly BridgeModelInfo[] | undefined;
  defaultModel: string | undefined;
}): {
  sessionModel?: string;
  configModel?: string;
  modelDisplayName?: string;
  extraOption?: BridgeModelInfo;
} {
  const trimmedNative = nativeModel?.trim();
  const explicitNative = trimmedNative && trimmedNative.toLowerCase() !== "default" ? trimmedNative : undefined;
  const trimmedContext = contextModel?.trim();
  const observedModel = trimmedContext && trimmedContext.toLowerCase() !== "default" && !parseMagpieSyntheticModelId(trimmedContext)
    ? trimmedContext
    : undefined;

  if (explicitNative) {
    const saved = savedModelOption(models, explicitNative);
    const directDisplay = saved?.displayName ?? directModelDisplayName(explicitNative, models);
    if (directDisplay) {
      return {
        sessionModel: explicitNative,
        configModel: saved?.value ?? explicitNative,
        modelDisplayName: directDisplay,
        ...(saved ? { extraOption: saved } : {}),
      };
    }
    if (observedModel) {
      const effectiveContext = /\[1m\]$/iu.test(explicitNative) && !/\[1m\]$/iu.test(observedModel)
        ? `${observedModel}[1m]`
        : observedModel;
      const contextSaved = savedModelOption(models, effectiveContext);
      const contextDisplay = contextSaved?.displayName ?? humanizeUpstreamModelId(effectiveContext);
      return {
        sessionModel: explicitNative,
        configModel: contextSaved?.value ?? explicitNative,
        ...(contextDisplay ? { modelDisplayName: contextDisplay } : {}),
        ...(contextSaved ? { extraOption: contextSaved } : {}),
      };
    }
    return { sessionModel: explicitNative, configModel: explicitNative };
  }

  const fallbackRaw = observedModel ?? defaultModel ?? models?.[0]?.value;
  if (!fallbackRaw) return {};
  const saved = savedModelOption(models, fallbackRaw);
  const resolvedValue = saved?.value ?? fallbackRaw;
  const displayName = saved?.displayName ?? directModelDisplayName(resolvedValue, models) ?? humanizeUpstreamModelId(resolvedValue);
  return {
    sessionModel: resolvedValue,
    configModel: resolvedValue,
    ...(displayName ? { modelDisplayName: displayName } : {}),
    ...(saved ? { extraOption: saved } : {}),
  };
}
