import type { BridgeDesktopRuntimeId, BridgeSessionInfo } from "@bridge/protocol";

/** Legacy snapshots without a runtime ID belong to Claude. */
export function desktopRuntimeId(session: BridgeSessionInfo): BridgeDesktopRuntimeId {
  return session.runtimeId ?? "claude-desktop";
}

/** Short chip label, per the 0.9.6 desktopless naming pass. */
export function desktopRuntimeName(_runtimeId: BridgeDesktopRuntimeId | undefined): string {
  return "Claude";
}
