import type { BridgeHostSnapshot, BridgeInspectorStatus } from "@bridge/protocol";

export type HostSnapshotWithInspector = BridgeHostSnapshot & {
  claudeInspector?: BridgeInspectorStatus | undefined;
};

export function readClaudeInspector(
  snapshot: BridgeHostSnapshot | undefined,
): BridgeInspectorStatus | undefined {
  return (snapshot as HostSnapshotWithInspector | undefined)?.claudeInspector;
}

/** Keep saved snapshots from retired hosts within the current Claude UI. */
export function claudeSnapshot<T extends BridgeHostSnapshot>(snapshot: T): T {
  const sessions = snapshot.sessions.filter((session) => (session.runtimeId ?? "claude-desktop") === "claude-desktop");
  const sessionIds = new Set(sessions.map((session) => session.sessionId));
  return {
    ...snapshot,
    sessions,
    projects: snapshot.projects.filter((project) => (project.runtimeId ?? "claude-desktop") === "claude-desktop"),
    permissions: snapshot.permissions.filter((permission) => sessionIds.has(permission.sessionId)),
    ...(snapshot.prompts ? { prompts: snapshot.prompts.filter(prompt => sessionIds.has(prompt.sessionId)) } : {}),
    ...(snapshot.runtimes ? { runtimes: snapshot.runtimes.filter((runtime) => runtime.id === "claude-desktop") } : {}),
    ...(snapshot.desktopApps ? { desktopApps: snapshot.desktopApps.filter((app) => app.id === "claude-desktop") } : {}),
  };
}
