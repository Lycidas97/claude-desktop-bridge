import type { BridgeSessionInfo } from "@bridge/protocol";
import { activeSessionBadgeLabel, formatSessionModelLabel } from "../../lib/conversation-timeline.js";
import { NATIVE_MODE_LABELS } from "../conversation/PermissionPrompts.js";

export function SessionProfileSummary({ session, showActivity = false }: { session: BridgeSessionInfo; showActivity?: boolean }) {
  return (
    <span className="session-profile-summary">
      {[
        showActivity ? activeSessionBadgeLabel(session) : undefined,
        formatSessionModelLabel(session),
        session.nativePermissionMode ? NATIVE_MODE_LABELS[session.nativePermissionMode] : undefined,
        session.effort ? `reasoning ${session.effort}` : undefined,
      ].filter(Boolean).join(" · ")}
    </span>
  );
}
