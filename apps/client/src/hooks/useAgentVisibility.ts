import type { BridgeDesktopRuntimeId, BridgeHostSnapshot } from "@bridge/protocol";
import { useEffect, useState } from "react";

export const AGENT_IDS: BridgeDesktopRuntimeId[] = [
  "claude-desktop", "codex-desktop", "hermes-desktop", "dsh-desktop",
];
const STORAGE_KEY = "bridge-visible-agents";

export interface AgentVisibilityControl {
  enabled: BridgeDesktopRuntimeId[];
  setEnabled(id: BridgeDesktopRuntimeId, enabled: boolean): void;
}

export function useAgentVisibility(): AgentVisibilityControl {
  const [enabled, setEnabled] = useState<BridgeDesktopRuntimeId[]>(() => {
    const stored = typeof localStorage === "undefined" ? null : localStorage.getItem(STORAGE_KEY);
    return AGENT_IDS.filter((id) => id === "claude-desktop" || stored?.split(",").includes(id));
  });
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, enabled.join(","));
  }, [enabled]);
  return {
    enabled,
    setEnabled(id, show) {
      setEnabled((current) => AGENT_IDS.filter((candidate) => candidate === "claude-desktop"
        || (candidate === id ? show : current.includes(candidate))));
    },
  };
}

/** Apply display preferences to UI snapshots; the host retains all native sessions. */
export function visibleAgentSnapshot<T extends BridgeHostSnapshot>(snapshot: T, enabled: BridgeDesktopRuntimeId[]): T {
  const visible = new Set<BridgeDesktopRuntimeId>(["claude-desktop", ...enabled.filter((id) => (
    snapshot.runtimes?.some((runtime) => runtime.id === id && runtime.state === "ready")
  ))]);
  const sessions = snapshot.sessions.filter((session) => visible.has(session.runtimeId ?? "claude-desktop"));
  const sessionIds = new Set(sessions.map((session) => session.sessionId));
  return {
    ...snapshot,
    sessions,
    projects: snapshot.projects.filter((project) => visible.has(project.runtimeId ?? "claude-desktop")),
    permissions: snapshot.permissions.filter((permission) => sessionIds.has(permission.sessionId)),
    ...(snapshot.runtimes ? { runtimes: snapshot.runtimes.filter((runtime) => visible.has(runtime.id)) } : {}),
    ...(snapshot.desktopApps ? { desktopApps: snapshot.desktopApps.filter((app) => visible.has(app.id)) } : {}),
  };
}
