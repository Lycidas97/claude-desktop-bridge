import type { BridgeSessionInfo } from "@bridge/protocol";
import { Fragment } from "react";
import { activeSessionBadgeLabel, formatSessionModelLabel } from "../../lib/conversation-timeline.js";
import { NATIVE_MODE_LABELS } from "../conversation/PermissionPrompts.js";

export function SessionProfileSummary({ session, showActivity = false }: { session: BridgeSessionInfo; showActivity?: boolean }) {
  return (
    <span className="session-profile-summary">
      {[
        { text: showActivity ? activeSessionBadgeLabel(session) : undefined },
        { text: formatSessionModelLabel(session), model: true },
        { text: session.nativePermissionMode ? NATIVE_MODE_LABELS[session.nativePermissionMode] : undefined },
        { text: session.effort ? `reasoning ${session.effort}` : undefined },
      ].filter(part => part.text).map((part, index) => (
        <Fragment key={index}>
          {index > 0 && " "}
          <span className={`session-profile-part${part.model ? " is-model" : ""}`}>
            {index > 0 && "· "}{part.text}
          </span>
        </Fragment>
      ))}
    </span>
  );
}
