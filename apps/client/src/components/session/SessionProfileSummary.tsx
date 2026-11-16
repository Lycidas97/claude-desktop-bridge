import type { BridgeSDKPermissionMode, BridgeSessionInfo } from "@bridge/protocol";
import { Fragment } from "react";
import { formatSessionModelLabel } from "../../lib/conversation-timeline.js";

export const HEADER_MODE_LABELS: Record<BridgeSDKPermissionMode, string> = {
  default: "Manual",
  auto: "Auto",
  bypassPermissions: "Bypass",
  acceptEdits: "Accept Edits",
  plan: "Plan",
  dontAsk: "Don't Ask",
};

const EFFORT_LABELS: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
};

export function formatSessionEffortLabel(effort: string | undefined): string | undefined {
  const trimmed = effort?.trim();
  if (!trimmed) return undefined;
  return EFFORT_LABELS[trimmed.toLowerCase()] ?? `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
}

export function SessionProfileSummary({
  session,
  id,
}: {
  session: BridgeSessionInfo;
  showActivity?: boolean | undefined;
  id?: string | undefined;
}) {
  const effortLabel = formatSessionEffortLabel(session.effort ?? session.reasoningEffort);
  const modeLabel = session.nativePermissionMode ? HEADER_MODE_LABELS[session.nativePermissionMode] : undefined;
  const parts: Array<{ text: string; model?: boolean; bypass?: boolean }> = [
    { text: formatSessionModelLabel(session), model: true },
    ...(effortLabel ? [{ text: effortLabel }] : []),
    ...(modeLabel
      ? [{ text: modeLabel, ...(session.nativePermissionMode === "bypassPermissions" ? { bypass: true } : {}) }]
      : []),
  ];

  return (
    <span className="session-profile-summary" id={id}>
      {parts.map((part, index) => (
        <Fragment key={index}>
          {index > 0 && <span className="session-profile-sep"> · </span>}
          <span
            className={`session-profile-part${part.model ? " is-model" : ""}${part.bypass ? " is-bypass" : ""}`}
          >
            {part.text}
          </span>
        </Fragment>
      ))}
    </span>
  );
}
