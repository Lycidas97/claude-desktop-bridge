import type { BridgeModelInfo } from "@bridge/protocol";
import { magpieModelIdHash, parseMagpieSyntheticModelId } from "./claude-runtime-discovery.js";

const LONG_CONTEXT_TOKENS = 1_000_000;

export class SessionModelCatalog {
  private readonly modelCache = new Map<string, BridgeModelInfo>();
  gatewayModelsDiscovered = false;
  modelCatalogComplete = false;
  modelCatalogDiscoveryAttempted = false;

  clear(): void {
    this.modelCache.clear();
    this.gatewayModelsDiscovered = false;
    this.modelCatalogComplete = false;
    this.modelCatalogDiscoveryAttempted = false;
  }

  rememberCatalogModels(sessions: readonly { hostModel?: string }[]): void {
    if (this.modelCatalogComplete) return;
    for (const session of sessions) {
      if (!session.hostModel || parseMagpieSyntheticModelId(session.hostModel)) continue;
      this.modelCache.set(session.hostModel, {
        value: session.hostModel,
        displayName: this.modelDisplayName(session.hostModel),
      });
    }
  }

  rememberModels(models: BridgeModelInfo[]): void {
    if (models.length > 0) this.modelCache.clear();
    for (const model of models) {
      if (!model.value) continue;
      const displayName = model.displayName && !parseMagpieSyntheticModelId(model.displayName)
        ? model.displayName
        : this.resolveModelDisplayName(model.displayName) ?? this.formatStandardModelDisplayName(model.value);
      this.modelCache.set(model.value, {
        value: model.value,
        displayName,
        ...(model.description ? { description: model.description } : {}),
        ...(model.resolvedModel ? { resolvedModel: model.resolvedModel } : {}),
        ...("maxInputTokens" in model ? { maxInputTokens: model.maxInputTokens } : {}),
        ...(model.supportsEffort !== undefined ? { supportsEffort: model.supportsEffort } : {}),
        ...(model.supportedEffortLevels?.length
          ? { supportedEffortLevels: [...model.supportedEffortLevels] }
          : {}),
      });
    }
  }

  availableModels(selected?: string): BridgeModelInfo[] {
    const models = new Map(this.modelCache);
    const longContextAvailable = [...models.keys(), selected ?? ""].some((value) => /\[1m\]/iu.test(value));
    if (longContextAvailable) {
      for (const model of [...models.values()]) {
        if (/\[1m\]/iu.test(model.value) || !/^claude-(?:fable|sonnet|opus)-/iu.test(model.value)) continue;
        const value = `${model.value}[1m]`;
        if (models.has(value)) continue;
        models.set(value, {
          ...model,
          value,
          displayName: `${model.displayName} · 1M`,
          ...(model.resolvedModel ? { resolvedModel: `${model.resolvedModel}[1m]` } : {}),
          maxInputTokens: LONG_CONTEXT_TOKENS,
        });
      }
    }
    const matchedSelected = this.findModelInfo(selected, [...models.values()]);
    if (selected && !matchedSelected && !parseMagpieSyntheticModelId(selected)) {
      models.set(selected, { value: selected, displayName: this.modelDisplayName(selected) });
    }
    const selectedValue = matchedSelected?.value ?? selected;
    return [...models.values()].sort((left, right) => (
      Number(right.value === selectedValue) - Number(left.value === selectedValue)
      || (this.gatewayModelsDiscovered ? 0 : left.displayName.localeCompare(right.displayName, "zh-CN"))
    ));
  }

  findModelInfo(model: string | undefined, models: BridgeModelInfo[]): BridgeModelInfo | undefined {
    if (!model) return undefined;
    const direct = models.find((candidate) => candidate.value === model)
      ?? models.find((candidate) => candidate.resolvedModel === model);
    if (direct) return direct;
    const magpie = parseMagpieSyntheticModelId(model);
    if (!magpie) return undefined;
    const matchingHash = models.filter((candidate) => {
      const candidateSyn = parseMagpieSyntheticModelId(candidate.value)
        ?? parseMagpieSyntheticModelId(candidate.resolvedModel);
      if (candidateSyn) return candidateSyn.hash === magpie.hash;
      return magpieModelIdHash(candidate.value) === magpie.hash;
    });
    return matchingHash.find((candidate) => /\[1m\]/iu.test(candidate.value) === magpie.longContext)
      ?? matchingHash[0];
  }

  resolveModelDisplayName(value: string | undefined): string | undefined {
    if (!value) return undefined;
    const cached = this.findModelInfo(value, [...this.modelCache.values()]);
    if (cached?.displayName && !parseMagpieSyntheticModelId(cached.displayName)) {
      if (/\[1m\]/iu.test(value) && !/\b1m\b/iu.test(cached.displayName)) {
        return `${cached.displayName}${this.gatewayModelsDiscovered ? " 1M" : " · 1M"}`;
      }
      return cached.displayName;
    }
    if (/\[1m\]/iu.test(value)) {
      const baseValue = value.replace(/\[1m\]/giu, "");
      const baseCached = this.findModelInfo(baseValue, [...this.modelCache.values()]);
      if (baseCached?.displayName && !parseMagpieSyntheticModelId(baseCached.displayName)) {
        return `${baseCached.displayName}${this.gatewayModelsDiscovered ? " 1M" : " · 1M"}`;
      }
    }
    const magpie = parseMagpieSyntheticModelId(value);
    if (magpie?.anthropicModel) {
      return this.formatStandardModelDisplayName(`${magpie.anthropicModel}${magpie.longContext ? "[1m]" : ""}`);
    }
    if (magpie) return magpie.longContext ? "默认模型 · 1M" : "默认模型";
    return undefined;
  }

  formatStandardModelDisplayName(value: string): string {
    const longContext = /\[1m\]/iu.test(value);
    const normalized = value
      .replace(/\[1m\]/giu, "")
      .replace(/^claude-/iu, "")
      .split("-")
      .filter(Boolean)
      .map((part) => part.length <= 2 ? part.toLocaleUpperCase() : `${part[0]!.toLocaleUpperCase()}${part.slice(1)}`)
      .join(" ");
    return `${normalized || value}${longContext ? " · 1M" : ""}`;
  }

  modelDisplayName(value: string): string {
    const resolved = this.resolveModelDisplayName(value);
    if (resolved) return resolved;
    return this.formatStandardModelDisplayName(value);
  }

  modelContextLimit(model: string | undefined, ultracode = false): number | undefined {
    if (ultracode || (model !== undefined && /\[1m\]|(?:^|[-_])1m(?:$|[-_])/iu.test(model))) {
      return LONG_CONTEXT_TOKENS;
    }
    return this.findModelInfo(model, [...this.modelCache.values()])?.maxInputTokens;
  }
}
