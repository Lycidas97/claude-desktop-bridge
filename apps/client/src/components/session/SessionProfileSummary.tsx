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
  const modelText = formatSessionModelLabel(session);
  const effortLabel = formatSessionEffortLabel(session.effort ?? session.reasoningEffort);
  const modeLabel = session.nativePermissionMode ? HEADER_MODE_LABELS[session.nativePermissionMode] : undefined;
  const outputStyle = session.outputStyle === "default" ? undefined : session.outputStyle;
  const metaParts: Array<{ text: string; className?: string }> = [
    ...(effortLabel ? [{ text: effortLabel }] : []),
    ...(modeLabel ? [{ text: modeLabel, className: session.nativePermissionMode === "bypassPermissions" ? "is-bypass" : "" }] : []),
    ...(outputStyle ? [{ text: outputStyle, className: "is-output-style" }] : []),
  ];

  return (
    <span className={`session-profile-summary${metaParts.length > 0 ? " has-meta" : ""}`} id={id}>
      <span className="session-profile-line is-model-line">
        <span className="session-profile-part is-model">{modelText}</span>
      </span>
      {metaParts.length > 0 && (
        <>
          <span className="session-profile-sep is-line-sep"> · </span>
          <span className="session-profile-line is-meta-line">
            {metaParts.map((part, index) => (
              <Fragment key={index}>
                {index > 0 && <span className="session-profile-sep"> · </span>}
                <span
                  className={`session-profile-part${part.className ? ` ${part.className}` : ""}`}
                >
                  {part.text}
                </span>
              </Fragment>
            ))}
          </span>
        </>
      )}
    </span>
  );
}
