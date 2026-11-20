import type { BridgePermissionInfo, BridgeSessionInfo } from "@bridge/protocol";
import { ChevronDown, ChevronRight } from "lucide-react";
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

function hasNestedButtonHtml(html: string): boolean {
  let depth = 0;
  for (const match of html.matchAll(/<\/?button\b[^>]*>/giu)) {
    if (match[0].startsWith("</")) {
      depth = Math.max(0, depth - 1);
    } else {
      depth += 1;
      if (depth > 1) return true;
    }
  }
  return false;
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

  it("shows an accessible completion dot only for a new result on an idle active row", () => {
    const completed = { ...session, lastCompletedTurnId: "new-result" };
    const families = groupProjectSessionFamilies([completed]);
    const props = { families, flat: true };
    const unread = renderToStaticMarkup(render({ ...props, seenCompletions: { root: "old-result" } }));
    expect(unread).toContain("session-state-dot completed");
    expect(unread).toContain("已完成，未查看");
    expect(renderToStaticMarkup(render({ ...props, seenCompletions: { root: "new-result" } }))).not.toContain("已完成，未查看");
    expect(renderToStaticMarkup(render({ ...props, permissions: [permission] }))).not.toContain("已完成，未查看");
    expect(renderToStaticMarkup(render({ ...props, archivedList: true }))).not.toContain("已完成，未查看");
    for (const state of [{ turnState: "running" as const }, { pendingCount: 1 }, { runningSubagents: { count: 1, lastUpdatedAt: Date.now() } }]) {
      expect(renderToStaticMarkup(render({ ...props, families: groupProjectSessionFamilies([{ ...completed, ...state }]) }))).not.toContain("已完成，未查看");
    }
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

  it("renders inline parent chevron without nested buttons, summary toggle when collapsed, and direct tree children when expanded", () => {
    const families = groupProjectSessionFamilies([
      session,
      { ...session, sessionId: "fork", title: "Fork session", parentSessionId: "root", forkLabel: "experiment", lastActivityAt: 2 },
      { ...session, sessionId: "btw", title: "Sidechat", parentSessionId: "root", sidechat: true, lastActivityAt: 3 },
    ]);
    const onSelectSession = vi.fn();
    const onToggleForkGroup = vi.fn();
    expect(hasNestedButtonHtml("<button type=\"button\"><span><button type=\"button\">bad</button></span></button>")).toBe(true);
    const collapsed = render({ families, onSelectSession, onToggleForkGroup });
    const collapsedHtml = renderToStaticMarkup(collapsed);
    expect(hasNestedButtonHtml(collapsedHtml)).toBe(false);
    expect(elements(collapsed).filter(element => element.props["data-session-id"])).toHaveLength(1);

    const parentChevron = elements(row(collapsed, "root")).find(element => element.props.className === "session-family-chevron")!;
    expect(parentChevron.props["aria-expanded"]).toBe(false);
    expect(elements(parentChevron).some(element => element.type === ChevronRight)).toBe(true);
    parentChevron.props.onClick();
    expect(onToggleForkGroup).toHaveBeenCalledWith("root");
    expect(onSelectSession).not.toHaveBeenCalled();

    const toggle = elements(collapsed).find(element => element.props.className === "mobile-fork-toggle")!;
    expect(toggle.props["aria-expanded"]).toBe(false);
    expect(elements(toggle).find(element => element.type === "span")?.props.children).toBe("2 个分支与侧聊");
    expect(collapsedHtml).toContain("session-tree-elbow");
    toggle.props.onClick();
    expect(onToggleForkGroup).toHaveBeenCalledTimes(2);

    const expanded = render({ families, expandedForkParents: new Set(["root"]), onToggleForkGroup });
    const expandedHtml = renderToStaticMarkup(expanded);
    expect(hasNestedButtonHtml(expandedHtml)).toBe(false);
    expect(elements(expanded).some(element => element.props.className === "mobile-fork-toggle")).toBe(false);
    const expandedChevron = elements(row(expanded, "root")).find(element => element.props.className === "session-family-chevron")!;
    expect(expandedChevron.props["aria-expanded"]).toBe(true);
    expect(elements(expandedChevron).some(element => element.type === ChevronDown)).toBe(true);
    expect(elements(expanded).filter(element => element.props["data-session-id"]).map(element => element.props["data-session-id"])).toEqual(["root", "btw", "fork"]);
    expect(elements(row(expanded, "btw")).find(element => element.type === "em")?.props.children).toBe("/btw");
    expect(elements(row(expanded, "fork")).find(element => element.type === "em")?.props.children).toBe("experiment");
    const branches = elements(expanded).filter(element => String(element.props.className).startsWith("session-fork-branch"));
    expect(branches.map(element => element.props.className)).toEqual(["session-fork-branch", "session-fork-branch is-last"]);

    const flatExpanded = render({
      families: groupProjectSessionFamilies([
        session,
        { ...session, sessionId: "fork", title: "Fork session", parentSessionId: "root", forkLabel: "fork-1", lastActivityAt: 2 },
        { ...session, sessionId: "btw", title: "Sidechat", parentSessionId: "root", sidechat: true, turnState: "running" as const, ownership: "DESKTOP_NATIVE_RUNNING" as const, lastActivityAt: 3 },
      ]),
      flat: true,
      expandedForkParents: new Set(["root"]),
    });
    expect(elements(flatExpanded).some(element => element.props.className === "mobile-fork-toggle")).toBe(false);
    expect(elements(row(flatExpanded, "btw")).find(element => String(element.props.className).startsWith("session-state-dot"))?.props.className).toBe("session-state-dot running");
    const btwBadges = elements(row(flatExpanded, "btw")).find(element => element.props.className === "session-row-badges")!;
    expect(elements(btwBadges).some(element => element.props.className === "session-state-dot running")).toBe(true);
    expect(elements(row(flatExpanded, "fork")).find(element => String(element.props.className).startsWith("session-state-dot"))?.props.className).toBe("session-state-dot idle");
    expect(elements(row(flatExpanded, "btw")).find(element => element.type === "em")?.props.className).toContain("is-sr-only");
    expect(elements(row(flatExpanded, "fork")).find(element => element.type === "em")?.props.className).toContain("is-sr-only");

    const singleChildExpanded = render({
      families: groupProjectSessionFamilies([
        session,
        { ...session, sessionId: "only-child", title: "Only child", parentSessionId: "root", lastActivityAt: 2 },
      ]),
      flat: true,
      expandedForkParents: new Set(["root"]),
    });
    const onlyBranch = elements(singleChildExpanded).find(element => String(element.props.className).startsWith("session-fork-branch"))!;
    expect(onlyBranch.props.className).toBe("session-fork-branch is-last is-only");
  });

  it("keeps exactly three recent roots and shows hidden activity and attention on the disclosure", () => {
    const families = groupProjectSessionFamilies<BridgeSessionInfo>([
      session,
      { ...session, sessionId: "second", lastActivityAt: 70 },
      { ...session, sessionId: "third", lastActivityAt: 60 },
      { ...session, sessionId: "older", lastActivityAt: 50, turnState: "queued", pendingCount: 2 },
      { ...session, sessionId: "older-fork", parentSessionId: "older", lastActivityAt: 45, turnState: "waiting" },
      { ...session, sessionId: "orphan", parentSessionId: "archived-parent", lastActivityAt: 55, turnState: "running" },
      { ...session, sessionId: "question", parentSessionId: "older", lastActivityAt: 40 },
      { ...session, sessionId: "fork", parentSessionId: "root", lastActivityAt: 90 },
    ]);
    const onToggle = vi.fn();
    const props = {
      families, selectedId: "older", expandedForkParents: new Set(["root", "older"]),
      permissions: [{ ...permission, sessionId: "older-fork" }, { ...permission, sessionId: "question", toolName: "AskUserQuestion" }],
    };
    const collapsed = elements(render({ ...props, olderSessionsDisclosure: { expanded: false, onToggle } }));
    expect(collapsed.flatMap(element => element.props["data-session-id"] ?? [])).toEqual(["root", "fork", "second", "third"]);
    const disclosure = collapsed.find(element => element.props.className === "session-history-toggle")!;
    expect(disclosure.props["aria-expanded"]).toBe(false);
    expect(renderToStaticMarkup(disclosure)).toContain("显示其余 2 个会话");
    expect(renderToStaticMarkup(disclosure)).toContain("2 个待处理");
    expect(renderToStaticMarkup(disclosure)).toContain("2 个进行中");
    disclosure.props.onClick();
    expect(onToggle).toHaveBeenCalledOnce();
    const expanded = render({ ...props, olderSessionsDisclosure: { expanded: true, onToggle } });
    expect(row(expanded, "orphan")).toBeDefined();
    expect(row(expanded, "older").props.className).toContain(" active");
    expect(status(row(expanded, "older-fork"))?.props.children).toBe("待授权");
    expect(status(row(expanded, "question"))?.props.children).toBe("待回答");
    expect(row(render({ ...props, archivedList: true }), "older")).toBeDefined();
  });

  it("excludes archived forks from active families while keeping live descendants reachable and rendering archived rows in archive mode", () => {
    const families = groupProjectSessionFamilies([
      session,
      { ...session, sessionId: "archived", title: "Archived sidechat", parentSessionId: "root", sidechat: true, archivedAt: 3 },
      { ...session, sessionId: "live", title: "Live descendant", parentSessionId: "archived", turnState: "running" as const, ownership: "DESKTOP_NATIVE_RUNNING" as const, lastActivityAt: 4 },
    ]);
    const active = render({ families, expandedForkParents: new Set(["root"]) });
    expect(row(active, "archived")).toBeUndefined();
    expect(status(row(active, "live"))?.props.children).toBe("桌面运行中");
    const archivedList = render({ families, archivedList: true, expandedForkParents: new Set(["root", "archived"]) });
    expect(status(row(archivedList))?.props.children).toBe("已归档");
    expect(status(row(archivedList, "archived"))?.props.children).toBe("已归档");
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
