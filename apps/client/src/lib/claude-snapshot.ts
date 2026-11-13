import type { BridgeHostSnapshot } from "@bridge/protocol";

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
