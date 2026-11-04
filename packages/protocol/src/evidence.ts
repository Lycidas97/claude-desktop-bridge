import type { BridgeEvidenceBundle, BridgeEvent } from "./types.js";

/** Keep complete records on the host; live events and lists carry only this header. */
export function evidenceSummary(bundle: BridgeEvidenceBundle): BridgeEvidenceBundle {
  return { ...bundle, tools: [], artifacts: [], detailsAvailable: true };
}

/** Also handles old full-bundle events during reconnect and cache restoration. */
export function summarizeEvidenceEvent(event: BridgeEvent): BridgeEvent {
  if (!event.type.startsWith("evidence.")) return event;
  const bundle = event.data.evidence as BridgeEvidenceBundle | undefined;
  if (!bundle || !Array.isArray(bundle.tools) || !Array.isArray(bundle.artifacts)) return event;
  if (bundle.detailsAvailable && !bundle.tools.length && !bundle.artifacts.length) return event;
  return { ...event, data: { ...event.data, evidence: evidenceSummary(bundle) } };
}
