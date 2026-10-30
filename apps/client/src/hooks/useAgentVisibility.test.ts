import type { BridgeDesktopRuntime, BridgeDesktopRuntimeId, BridgeHostSnapshot } from "@bridge/protocol";
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentSettings } from "../components/AgentSettings.js";
import { visibleAgentSnapshot } from "./useAgentVisibility.js";

function snapshot(): BridgeHostSnapshot {
  const ids: BridgeDesktopRuntimeId[] = ["claude-desktop", "codex-desktop", "hermes-desktop", "dsh-desktop"];
  return {
    host: { hostId: "host", pairingEpoch: 1, name: "Computer", relayUrl: "", online: true, lastSeenAt: 0, version: "1.0.2", capabilities: [] },
    sessions: ids.map((runtimeId) => ({ sessionId: runtimeId, runtimeId, projectId: runtimeId, projectName: runtimeId, cwd: "/tmp/project", title: runtimeId, source: "desktop", ownership: "DESKTOP_OBSERVED", transport: "bridge-host", turnState: "idle", lastActivityAt: 0, pendingCount: 0 })),
    projects: ids.map((runtimeId) => ({ runtimeId, projectId: runtimeId, name: runtimeId, cwd: "/tmp/project", sessionCount: 1, runningCount: 0, pendingCount: 0, lastActivityAt: 0 })),
    runtimes: ids.map((id) => ({ id, name: id, state: id === "hermes-desktop" ? "unavailable" : id === "dsh-desktop" ? "error" : "ready", detail: "", capabilities: ["session.create"], sessionIsolation: "independent", sessionCount: 1, updatedAt: 0 } satisfies BridgeDesktopRuntime)),
    desktopApps: ids.map((id) => ({ id, name: id, state: "stopped", detail: "", canLaunch: true, canQuit: false })),
    permissions: ids.map((sessionId) => ({ permissionId: sessionId, sessionId, requestId: sessionId, toolUseId: sessionId, toolName: "Bash", input: {}, canAllowAlways: false, createdAt: 0 })),
    devices: [], latestSeq: 0,
    runtime: { state: "ready", detail: "", activeTurns: 0, maxParallelTurns: 2, desktopIntegration: { state: "not-managed", detail: "", enabled: false, canRestart: false } },
  };
}

describe("Agent visibility", () => {
  it("keeps only Claude by default across sessions, projects, apps, runtimes and permissions", () => {
    const original = snapshot();
    const visible = visibleAgentSnapshot(original, ["claude-desktop"]);
    expect(visible.sessions.map((session) => session.runtimeId)).toEqual(["claude-desktop"]);
    expect(visible.projects.map((project) => project.runtimeId)).toEqual(["claude-desktop"]);
    expect(visible.desktopApps?.map((app) => app.id)).toEqual(["claude-desktop"]);
    expect(visible.runtimes?.map((runtime) => runtime.id)).toEqual(["claude-desktop"]);
    expect(visible.permissions.map((permission) => permission.sessionId)).toEqual(["claude-desktop"]);
    expect(original.sessions).toHaveLength(4);
    expect(original.runtimes).toHaveLength(4);
  });

  it("shows an enabled ready Agent while hiding enabled unavailable and failed Agents", () => {
    const original = snapshot();
    const enabled: BridgeDesktopRuntimeId[] = ["claude-desktop", "codex-desktop", "hermes-desktop", "dsh-desktop"];
    expect(visibleAgentSnapshot(original, enabled).runtimes?.map((runtime) => runtime.id)).toEqual(["claude-desktop", "codex-desktop"]);
    original.runtimes![1]!.state = "starting";
    expect(visibleAgentSnapshot(original, enabled).sessions.map((session) => session.runtimeId)).toEqual(["claude-desktop"]);
    original.runtimes![1]!.state = "ready";
    expect(visibleAgentSnapshot(original, enabled).sessions.map((session) => session.runtimeId)).toEqual(["claude-desktop", "codex-desktop"]);
  });

  it("retains Claude and legacy sessions when the host omits runtime information", () => {
    const { runtimes: _runtimes, desktopApps: _apps, ...legacy } = snapshot();
    const { runtimeId: _sessionRuntime, ...session } = legacy.sessions[0]!;
    const { runtimeId: _projectRuntime, ...project } = legacy.projects[0]!;
    legacy.sessions = [session];
    legacy.projects = [project];
    const visible = visibleAgentSnapshot(legacy, []);
    expect(visible.sessions).toHaveLength(1);
    expect(visible.projects).toHaveLength(1);
    expect(visible).not.toHaveProperty("runtimes");
  });

  it("keeps hidden Agents available as unchecked settings and Claude always selected", () => {
    const html = renderToStaticMarkup(createElement(AgentSettings, {
      control: { enabled: ["claude-desktop"], setEnabled: vi.fn() }, snapshot: snapshot(),
    }));
    expect(html).toContain('aria-label="显示 Claude" disabled="" checked=""');
    expect(html).toContain('aria-label="显示 Codex"');
    expect(html.match(/checked=""/g)).toHaveLength(1);
    expect(html).toContain("未连接或未就绪，主界面隐藏");
  });
});
