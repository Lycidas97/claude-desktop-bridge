import type { BridgePermissionInfo, BridgeSessionInfo } from "@bridge/protocol";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { groupProjectSessionFamilies } from "../../lib/project-groups.js";
import { IconButton } from "../common/IconButton.js";
import { SessionFamilyList, type SessionFamilyListProps } from "./SessionFamilyList.js";

const session: BridgeSessionInfo = {
  sessionId: "root", title: "Main session", projectId: "project", projectName: "Project", cwd: "/tmp/project",
  source: "desktop", ownership: "DESKTOP_NATIVE_IDLE", transport: "claude-desktop-native",
  turnState: "idle", lastActivityAt: 1, pendingCount: 0,
};
const permission: BridgePermissionInfo = {
  requestId: "permission", sessionId: "root", toolUseId: "tool", toolName: "Bash", input: {}, createdAt: 1, canAllowAlways: false,
};

function elements(node: ReactNode): ReactElement<Record<string, any>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Record<string, any>>;
  return [element, ...elements(element.props.children)];
}

function render(overrides: Partial<SessionFamilyListProps> = {}) {
  return SessionFamilyList({
    families: groupProjectSessionFamilies([session]), projects: undefined, permissions: [], expandedForkParents: new Set(),
    onSelectSession: vi.fn(), onOpenSessionActions: vi.fn(), onToggleForkGroup: vi.fn(), ...overrides,
  });
}

function row(tree: ReactNode, sessionId = "root") {
  return elements(tree).find(element => element.props["data-session-id"] === sessionId)!;
}

function status(tree: ReactNode) {
  return elements(tree).find(element => String(element.props.className).startsWith("session-row-status"));
}

describe("SessionFamilyList", () => {
  it.each([
    { label: "idle background work", changes: {}, permissions: [], badge: "后台子代理", tone: "running" },
    { label: "stalled background work", changes: { runningSubagents: { count: 1, lastUpdatedAt: Date.now() - 11 * 60_000 } }, permissions: [], badge: "子代理无进展", tone: "queued" },
    { label: "main turn before background work", changes: { turnState: "running" as const, ownership: "DESKTOP_NATIVE_RUNNING" as const }, permissions: [], badge: "桌面运行中", tone: "running" },
    { label: "permission before main turn", changes: { turnState: "running" as const }, permissions: [permission], badge: "待授权", tone: "waiting" },
    { label: "question before background work", changes: {}, permissions: [{ ...permission, toolName: "AskUserQuestion" }], badge: "待回答", tone: "waiting" },
    { label: "archive before permission", changes: { archivedAt: 2 }, permissions: [permission], badge: "已归档", tone: "idle" },
  ])("keeps badge and state dot priority for $label", ({ changes, permissions, badge, tone }) => {
    const tree = render({
      families: groupProjectSessionFamilies([{ ...session, runningSubagents: { count: 1, lastUpdatedAt: Date.now() }, ...changes }]),
      permissions,
    });
    expect(status(row(tree))?.props.children).toBe(badge);
    expect(status(row(tree))?.props.className).toBe(`session-row-status ${tone}`);
    expect(elements(row(tree)).find(element => String(element.props.className).startsWith("session-state-dot"))?.props.className).toBe(`session-state-dot ${tone}`);
  });

  it("retains pending messages alongside a running Native turn and permission priority", () => {
    const families = groupProjectSessionFamilies<BridgeSessionInfo>([{ ...session, turnState: "running", ownership: "DESKTOP_NATIVE_RUNNING", pendingCount: 2 }]);
    const running = renderToStaticMarkup(render({ families }));
    expect(running).toContain("桌面运行中");
    expect(running).toContain('aria-label="2 条排队消息"');
    expect(renderToStaticMarkup(render({ families, permissions: [permission] }))).toContain("待授权");
    expect(renderToStaticMarkup(render({ families, permissions: [permission] }))).toContain('aria-label="2 条排队消息"');
    expect(renderToStaticMarkup(render({ families, archivedList: true }))).not.toContain("排队消息");
  });

  it("passes the selected session and action IDs without selecting through the action button", () => {
    const onSelectSession = vi.fn();
    const onOpenSessionActions = vi.fn();
    const tree = render({ selectedId: "root", onSelectSession, onOpenSessionActions });
    expect(row(tree).props.className).toContain(" active");
    elements(row(tree)).find(element => element.type === IconButton)!.props.onClick();
    expect(onOpenSessionActions).toHaveBeenCalledWith("root");
    expect(onSelectSession).not.toHaveBeenCalled();
    elements(row(tree)).find(element => element.props.className === "session-row-hit")!.props.onClick();
    expect(onSelectSession).toHaveBeenCalledWith("root");
    expect(row(render()).props.className).not.toContain("active");
  });

  it("keeps fork expansion controlled and distinguishes forks from sidechats", () => {
    const families = groupProjectSessionFamilies([
      session,
      { ...session, sessionId: "fork", title: "Fork session", parentSessionId: "root", forkLabel: "experiment", lastActivityAt: 2 },
      { ...session, sessionId: "btw", title: "Sidechat", parentSessionId: "root", sidechat: true, lastActivityAt: 3 },
    ]);
    const onToggleForkGroup = vi.fn();
    const collapsed = render({ families, onToggleForkGroup });
    expect(elements(collapsed).filter(element => element.props["data-session-id"])).toHaveLength(1);
    const toggle = elements(collapsed).find(element => element.props.className === "mobile-fork-toggle")!;
    expect(toggle.props["aria-expanded"]).toBe(false);
    expect(elements(toggle).find(element => element.type === "span")?.props.children).toBe("2 个分支与侧聊");
    toggle.props.onClick();
    expect(onToggleForkGroup).toHaveBeenCalledWith("root");
    const expanded = render({ families, expandedForkParents: new Set(["root"]) });
    expect(elements(expanded).filter(element => element.props["data-session-id"]).map(element => element.props["data-session-id"])).toEqual(["root", "btw", "fork"]);
    expect(elements(row(expanded, "btw")).find(element => element.type === "em")?.props.children).toBe("/btw");
    expect(elements(row(expanded, "fork")).find(element => element.type === "em")?.props.children).toBe("experiment");
  });

  it("separates inline archived forks from archived row mode and keeps live descendants reachable", () => {
    const families = groupProjectSessionFamilies([
      session,
      { ...session, sessionId: "archived", title: "Archived sidechat", parentSessionId: "root", sidechat: true, archivedAt: 3 },
      { ...session, sessionId: "live", title: "Live descendant", parentSessionId: "archived", turnState: "running" as const, ownership: "DESKTOP_NATIVE_RUNNING" as const, lastActivityAt: 4 },
    ]);
    const mobile = render({ families, expandedForkParents: new Set(["root"]) });
    expect(row(mobile, "archived")).toBeUndefined();
    expect(status(row(mobile, "live"))?.props.children).toBe("桌面运行中");
    const inline = render({ families, includeArchivedInline: true, expandedForkParents: new Set(["root", "archived"]) });
    expect(status(row(inline))).toBeUndefined();
    expect(status(row(inline, "archived"))?.props.children).toBe("已归档");
    expect(status(row(inline, "live"))?.props.children).toBe("桌面运行中");
    const archivedList = render({ families, archivedList: true, expandedForkParents: new Set(["root", "archived"]) });
    expect(status(row(archivedList))?.props.children).toBe("已归档");
    expect(status(row(archivedList, "live"))?.props.children).toBe("已归档");
  });

  it("keeps Desktop group subfolders in active rows and suppresses summaries in archived rows", () => {
    const families = groupProjectSessionFamilies([{ ...session, cwd: "C:\\work\\folder\\", currentSummary: "Latest progress" }]);
    const projects = [{ projectId: "project", name: "Section", kind: "desktop-group" as const, cwd: "", sessionCount: 1, runningCount: 0, pendingCount: 0, lastActivityAt: 1 }];
    const active = elements(row(render({ families, projects }))).find(element => element.type === "small")!;
    expect(active.props.children[0]).toBe("folder · ");
    expect(active.props.children[2]).toBe(" · Latest progress");
    const archived = elements(row(render({ families, projects, archivedList: true }))).find(element => element.type === "small")!;
    expect(archived.props.children[0]).toBe("");
    expect(archived.props.children[2]).toBe("");
  });
});
