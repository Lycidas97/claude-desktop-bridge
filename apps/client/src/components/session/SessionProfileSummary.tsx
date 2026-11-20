import type { BridgeSessionInfo } from "@bridge/protocol";
import { Fragment } from "react";
import { formatSessionModelLabel } from "../../lib/conversation-timeline.js";
import { PERMISSION_MODE_LABELS, effortLabel } from "./session-labels.js";

export function SessionProfileSummary({
  session,
  id,
}: {
  session: BridgeSessionInfo;
  showActivity?: boolean | undefined;
  id?: string | undefined;
}) {
  const modelText = formatSessionModelLabel(session);
  const effort = (session.effort ?? session.reasoningEffort)?.trim().toLowerCase();
  const modeLabel = session.nativePermissionMode ? PERMISSION_MODE_LABELS[session.nativePermissionMode] : undefined;
  const outputStyle = session.outputStyle === "default" ? undefined : session.outputStyle;
  const metaParts: Array<{ text: string; className?: string }> = [
    ...(effort ? [{ text: effortLabel(effort) }] : []),
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
