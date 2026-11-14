import type {
  BridgeEvent,
  BridgeEvidenceBundle,
  BridgeHistoryItem,
  BridgeHostSnapshot,
  BridgePermissionInfo,
  BridgeSessionInfo,
  BridgeTaskPlan,
} from "@bridge/protocol";
import * as React from "react";
import { type ComponentProps, type ReactElement, type ReactNode, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyEventToTurns, mergeBridgeEvents, type LocalTurn } from "../hooks/useMobileBridge.js";
import {
  aggregateFileChanges,
  canConfigureSession,
  canStopBridgeTask,
  conversationItems,
  conversationTimeline,
  ownershipLabel,
  restorableSessionId,
  sessionProfile,
  stoppableBridgeTask,
  supportsProviderSwitching,
} from "../lib/conversation-timeline.js";
import { groupProjectSessionFamilies } from "../lib/project-groups.js";
import { MobileWorkspace } from "./MobileWorkspace.js";
import { MobileSessionCatalog } from "./mobile/MobileSessionCatalog.js";
import { PermissionPrompt, permissionPresentation } from "./conversation/PermissionPrompts.js";
import { SubagentCard } from "./conversation/SubagentCard.js";
import { ConfirmationDialog } from "./common/ConfirmationDialog.js";

vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return { ...actual, useState: vi.fn(actual.useState), useEffect: vi.fn(actual.useEffect) };
});

function elements(node: ReactNode): ReactElement<Record<string, any>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Record<string, any>>;
  return [element, ...elements(element.props.children)];
}

describe("mobile workspace directory", () => {
  // Node's global localStorage has no storage file here; the workspace keeps project order in it.
  beforeEach(() => {
    const stored = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
      removeItem: (key: string) => stored.delete(key),
    });
  });

  const session: BridgeSessionInfo = {
    sessionId: "session-1",
    projectId: "project-1",
    projectName: "Project",
    cwd: "/tmp/project",
    title: "Visible session",
    source: "desktop",
    ownership: "DESKTOP_OBSERVED",
    transport: "bridge-host",
    turnState: "idle",
    lastActivityAt: 1,
    pendingCount: 0,
  };
  const snapshot: BridgeHostSnapshot = {
    host: { hostId: "host-1", pairingEpoch: 1, name: "My computer", relayUrl: "", online: true, lastSeenAt: 1, version: "1.0.2", capabilities: [] },
    projects: [{ projectId: "project-1", name: "Project", cwd: "/tmp/project", sessionCount: 2, runningCount: 0, pendingCount: 0, lastActivityAt: 1 }],
    sessions: [session, { ...session, sessionId: "archive-1", title: "Archived session", archivedAt: 2 }],
    devices: [],
    runtime: {
      state: "ready", detail: "Ready", activeTurns: 0, maxParallelTurns: 1,
      desktopIntegration: { state: "not-managed", detail: "Unavailable", enabled: false, canRestart: false },
    },
    permissions: [],
    latestSeq: 0,
  };

  function workspaceProps(): ComponentProps<typeof MobileWorkspace> {
    return {
      activeHostId: "host-1", desktopName: "My computer", connection: "connected", desktopOnline: true,
      snapshot, permissions: [], histories: {}, evidence: {}, artifactPreviews: {}, artifactTransfers: {}, events: [], localTurns: [], pendingOutbound: 0,
      themeControl: { theme: "dark", family: "apple", setTheme: vi.fn(), setFamily: vi.fn(), toggleTheme: vi.fn() },
      onOpenSession: vi.fn(), onLoadOlderHistory: vi.fn(), onLoadOlderEvidence: vi.fn(), onPreviewArtifact: vi.fn(), onDownloadArtifact: vi.fn(),
      onSendTurn: vi.fn(), onInterruptTurn: vi.fn(), onResolveUncertain: vi.fn(), onResolvePermission: vi.fn(), onCreateSession: vi.fn(),
      onLoadSessionConfiguration: vi.fn(), onConfigureSession: vi.fn(), onPreviewProviderSwitch: vi.fn(), onCommitProviderSwitch: vi.fn(), onCancelProviderSwitch: vi.fn(),
      onRefreshProviders: vi.fn(),
    onDesktopAppAction: vi.fn(), onRefresh: vi.fn(), onBackToHosts: vi.fn(), onRetry: vi.fn(),
    };
  }

  it("opens on the directory with an archive page entry and closed action menus", () => {
    const props = workspaceProps();
    const html = renderToStaticMarkup(createElement(MobileWorkspace, props));
    expect(html).toContain('<h1>会话</h1>');
    expect(html).toContain('class="m-header is-title-hidden"');
    expect(html).toContain('aria-label="当前电脑：My computer，查看电脑"');
    expect(html).toContain('aria-label="新建会话"');
    expect(html).toContain('aria-label="目录选项"');
    expect(html).toContain("Visible session");
    expect(html).toContain("已归档会话");
    expect(html).not.toContain("Archived session");
    expect(html).not.toContain("desktop-agents-drawer");
    expect(html).not.toContain('aria-label="强制同步"');
    expect(html).not.toContain('role="dialog"');
    expect(props.onOpenSession).not.toHaveBeenCalled();
  });

  it("orders and timestamps sessions by their last update, ignoring saved phone-open times", () => {
    const hour = 3_600_000;
    localStorage.setItem("bridge-session-opened:host-1", JSON.stringify({ "opened-old": Date.now() }));
    const html = renderToStaticMarkup(createElement(MobileWorkspace, {
      ...workspaceProps(),
      snapshot: { ...snapshot, sessions: [
        { ...session, sessionId: "replied", title: "Replied three hours ago", lastActivityAt: Date.now() - 3 * hour },
        { ...session, sessionId: "opened-old", title: "Opened here just now", lastActivityAt: Date.now() - 21 * hour },
      ] },
    }));
    expect(html.indexOf("Replied three hours ago")).toBeLessThan(html.indexOf("Opened here just now"));
    expect(html).toMatch(/Opened here just now<\/strong><small>21 小时前/u);
    expect(html).toMatch(/Replied three hours ago<\/strong><small>3 小时前/u);
  });

  it("keeps the project order set on this phone and leads with projects not placed yet", () => {
    localStorage.setItem("bridge-project-order:host-1", JSON.stringify(["project-2", "project-1"]));
    const html = renderToStaticMarkup(createElement(MobileWorkspace, {
      ...workspaceProps(),
      snapshot: { ...snapshot, projects: [
        { ...snapshot.projects[0]!, projectId: "project-1", name: "First" },
        { ...snapshot.projects[0]!, projectId: "project-2", name: "Second" },
        { ...snapshot.projects[0]!, projectId: "project-3", name: "Newcomer" },
      ], sessions: [
        { ...session, sessionId: "one", projectId: "project-1", projectName: "First", lastActivityAt: 3 },
        { ...session, sessionId: "two", projectId: "project-2", projectName: "Second", lastActivityAt: 1 },
        { ...session, sessionId: "new", projectId: "project-3", projectName: "Newcomer", lastActivityAt: 2 },
      ] },
    }));
    const order = ["Newcomer", "Second", "First"].map((name) => html.indexOf(`<strong>${name}</strong>`));
    expect(order.every((position) => position >= 0)).toBe(true);
    expect([...order].sort((left, right) => left - right)).toEqual(order);
    expect(html).toMatch(/class="project-order-bar"><span>项目顺序已固定<\/span><button[^>]*>.*调整顺序<\/button>/u);
  });

  it.each([["starting", "正在启动"], ["submitted", "已提交，等待执行"]] as const)("labels %s sessions before execution in the directory", (executionStage, label) => {
    const html = renderToStaticMarkup(createElement(MobileWorkspace, {
      ...workspaceProps(), snapshot: { ...snapshot, sessions: [{ ...session, source: "bridge", ownership: "BRIDGE_RUNNING", turnState: "running", executionStage }] },
    }));
    expect(html).toContain(label);
    expect(html).not.toContain(">运行中<");
    expect(ownershipLabel({ ...session, turnState: "running", executionStage })).toBe(label);
  });

  it("does not render hidden workspace content or consume navigation callbacks", () => {
    const props = workspaceProps();
    expect(renderToStaticMarkup(createElement(MobileWorkspace, {
      ...props, visible: false, focusRequest: { sessionId: session.sessionId, key: 1 }, onFocusHandled: vi.fn(),
    }))).toBe("");
    expect(props.onOpenSession).not.toHaveBeenCalled();
  });

  it("shows the direct Fork group without flattening nested branches", () => {
    const props = workspaceProps();
    const html = renderToStaticMarkup(createElement(MobileWorkspace, {
      ...props,
      snapshot: {
        ...snapshot,
        sessions: [session, { ...session, sessionId: "fork-1", title: "Fork", parentSessionId: session.sessionId }, { ...session, sessionId: "fork-2", title: "Nested Fork", parentSessionId: "fork-1" }],
      },
    }));
    expect(html).toContain("1 个 Fork 分支");
    expect(html).not.toContain("Nested Fork");
  });

  it("shows only active forks/sidechats in session families and keeps archived branches in the archive page", () => {
    const sidechatActive: BridgeSessionInfo = {
      ...session,
      sessionId: "btw-active",
      title: "btw: 检查 IPv6 转发",
      parentSessionId: session.sessionId,
      forkLabel: "fork-4",
      sidechat: true,
    };
    const sidechatArchived: BridgeSessionInfo = {
      ...session,
      sessionId: "btw-archived",
      title: "btw: 收集白名单域名",
      parentSessionId: session.sessionId,
      forkLabel: "btw",
      sidechat: true,
      archivedAt: 100,
    };
    const directoryHtml = renderToStaticMarkup(createElement(MobileWorkspace, {
      ...workspaceProps(),
      snapshot: {
        ...snapshot,
        sessions: [session, sidechatActive, sidechatArchived],
      },
    }));
    expect(directoryHtml).toContain("1 个 /btw 侧聊");
    expect(directoryHtml).not.toContain("2 个 /btw 侧聊");
    expect(directoryHtml).not.toContain(sidechatArchived.title);

    const archivedOnlyHtml = renderToStaticMarkup(createElement(MobileWorkspace, {
      ...workspaceProps(),
      snapshot: {
        ...snapshot,
        sessions: [session, sidechatArchived],
      },
    }));
    expect(archivedOnlyHtml).not.toContain("mobile-fork-toggle");
    expect(archivedOnlyHtml).not.toContain("1 个已结束侧聊");
    expect(archivedOnlyHtml).not.toContain("1 个 /btw 侧聊");
    expect(archivedOnlyHtml).not.toContain(sidechatArchived.title);
    expect(archivedOnlyHtml).toMatch(/已归档会话<\/strong><b class="project-count-pill">1<\/b>/u);

    const allMixedSessions: BridgeSessionInfo[] = [
      session,
      sidechatActive,
      sidechatArchived,
      { ...session, sessionId: "fork-archived", title: "历史实验分支", parentSessionId: session.sessionId, archivedAt: 120, lastActivityAt: 120 },
    ];
    const renderCatalog = (expandedForkParents: Set<string>, activeProjectId?: string, catalogSessions = allMixedSessions) => {
      const activeList = catalogSessions.filter((candidate) => !candidate.archivedAt || Boolean(candidate.sidechat && candidate.parentSessionId === session.sessionId));
      const archivedList = catalogSessions.filter((candidate) => Boolean(candidate.archivedAt));
      return renderToStaticMarkup(createElement(MobileSessionCatalog, {
        desktopName: "My computer",
        connection: "connected",
        desktopOnline: true,
        snapshot: { ...snapshot, sessions: catalogSessions },
        sessions: catalogSessions,
        archivedSessions: archivedList,
        activeParentProjects: new Map([[session.sessionId, session.projectId]]),
        grouped: [{ project: snapshot.projects[0], sessions: activeList }],
        groupedProjectIds: [session.projectId],
        allProjectsCollapsed: false,
        collapsedProjectIds: new Set<string>(),
        expandedForkParents,
        projectOrder: [session.projectId],
        projectsByActivity: [session.projectId],
        permissions: [],
        connectionIssue: undefined,
        transportMetrics: undefined,
        pendingOutbound: 0,
        activeProjectId,
        search: "",
        projectSearch: "",
        directoryRef: { current: null },
        directoryScrollPositions: { current: new Map() },
        directoryMenuOpen: false,
        projectOrderOpen: false,
        refreshing: false,
        syncFlash: false,
        sectionCreate: undefined,
        sectionCanCreate: false,
        sectionManage: {
          desktopName: "My computer",
          online: true,
          supportsRename: false,
          supportsDelete: false,
          hideEmptySections: false,
          emptySectionCount: 0,
          targetProject: undefined,
          state: undefined,
          canManage: vi.fn(() => false),
          shouldHideEmpty: vi.fn(() => false),
          revealEmptySections: vi.fn(),
          toggleHideEmptySections: vi.fn(),
          openMenu: vi.fn(),
          startRename: vi.fn(),
          updateName: vi.fn(),
          submitRename: vi.fn(async () => {}),
          startConfirmDelete: vi.fn(),
          runDelete: vi.fn(async () => {}),
          close: vi.fn(),
          renderDirectoryActions: vi.fn(() => null),
        },
        createOpen: false,
        createProjectId: "",
        sessionOverlays: null,
        onBackToHosts: vi.fn(),
        onRetry: vi.fn(),
        onRefresh: vi.fn(),
        onCreateSection: undefined,
        onBrowseDirectory: undefined,
        onCreateDirectory: undefined,
        onCreateSession: vi.fn(),
        selectSession: vi.fn(),
        setSearch: vi.fn(),
        setProjectSearch: vi.fn(),
        setDirectoryMenuOpen: vi.fn(),
        setProjectOrderOpen: vi.fn(),
        setCollapsedProjectIds: vi.fn(),
        setSectionCreate: vi.fn(),
        setCreateOpen: vi.fn(),
        onOpenSessionActions: vi.fn(),
        toggleProject: vi.fn(),
        toggleForkGroup: vi.fn(),
        openProjectGroup: vi.fn(),
        closeProjectGroup: vi.fn(),
        openCreateDialogForProject: vi.fn(),
        placeProjects: vi.fn(),
        runRefresh: vi.fn(),
        closeSectionCreate: vi.fn(),
        createSection: vi.fn(),
      }));
    };
    for (const activeProjectId of [undefined, session.projectId]) {
      const primaryExpandedHtml = renderCatalog(new Set([session.sessionId]), activeProjectId);
      expect(primaryExpandedHtml).toContain(sidechatActive.title);
      expect(primaryExpandedHtml).not.toContain("is-archived-fold");
      expect(primaryExpandedHtml).not.toContain("已归档分支");
      expect(primaryExpandedHtml).not.toContain(sidechatArchived.title);
      expect(primaryExpandedHtml).not.toContain("历史实验分支");
    }
    expect(renderCatalog(new Set())).toMatch(/已归档会话<\/strong><b class="project-count-pill">2<\/b>/u);
    const archivedBranchesHtml = renderCatalog(new Set(), "__archived__");
    expect(archivedBranchesHtml).toContain(sidechatArchived.title);
    expect(archivedBranchesHtml).toContain("历史实验分支");
    expect(archivedBranchesHtml).not.toContain(sidechatActive.title);
    expect(archivedBranchesHtml.match(/class="session-row-status [^"]+">已归档<\/span>/gu)).toHaveLength(2);
    expect(archivedBranchesHtml).not.toContain("is-archived-fold");

    const liveGrandchild: BridgeSessionInfo = {
      ...session, sessionId: "live-fork", title: "仍在执行的孙分支", parentSessionId: sidechatArchived.sessionId,
      transport: "claude-desktop-native", ownership: "DESKTOP_NATIVE_RUNNING", turnState: "running",
    };
    const threeLevelSessions = [session, sidechatArchived, liveGrandchild];
    const threeLevelCollapsedHtml = renderCatalog(new Set<string>(), undefined, threeLevelSessions);
    expect(threeLevelCollapsedHtml).toContain("1 个 Fork 分支");
    expect(threeLevelCollapsedHtml).not.toContain("is-archived-only");
    const threeLevelActiveHtml = renderCatalog(new Set([session.sessionId]), undefined, threeLevelSessions);
    expect(threeLevelActiveHtml).toContain(liveGrandchild.title);
    expect(threeLevelActiveHtml).not.toContain("1 个已结束侧聊");
    expect(threeLevelActiveHtml).not.toContain(sidechatArchived.title);
    const liveRow = /data-session-id="live-fork"([\s\S]*?)<\/button>/u.exec(threeLevelActiveHtml)![1]!;
    expect(liveRow).toContain("桌面运行中");
    expect(liveRow).not.toContain("已归档");
    expect(threeLevelActiveHtml.match(/data-session-id="live-fork"/gu)).toHaveLength(1);
    const threeLevelHistoryHtml = renderCatalog(new Set([sidechatArchived.sessionId]), "__archived__", threeLevelSessions);
    expect(threeLevelHistoryHtml).toContain(sidechatArchived.title);
    expect(threeLevelHistoryHtml).not.toContain(liveGrandchild.title);

    const archivedParent: BridgeSessionInfo = { ...session, sessionId: "archived-parent", title: "已归档父会话", archivedAt: 50 };
    const archivedChild: BridgeSessionInfo = { ...session, sessionId: "btw-of-archived-parent", title: "btw: 归档父会话的侧聊", parentSessionId: "archived-parent", sidechat: true, archivedAt: 60 };
    expect(groupProjectSessionFamilies([archivedParent, archivedChild])[0]!.forks).toHaveLength(1);
    const archivedPageHtml = renderCatalog(new Set(["archived-parent"]), "__archived__", [archivedParent, archivedChild]);
    expect(archivedPageHtml).toContain("1 个 /btw 侧聊");
    expect(archivedPageHtml).toContain("btw: 归档父会话的侧聊");
    expect(archivedPageHtml).not.toContain("is-archived-fold");

    const useState = vi.mocked(React.useState).getMockImplementation()!;
    const stateSpy = vi.mocked(React.useState)
      .mockImplementationOnce(useState)
      .mockImplementationOnce(useState)
      .mockReturnValueOnce(["btw-archived", vi.fn()]);
    try {
      const detailHtml = renderToStaticMarkup(createElement(MobileWorkspace, {
        ...workspaceProps(),
        snapshot: {
          ...snapshot,
          sessions: [session, sidechatActive, sidechatArchived],
        },
      }));
      expect(detailHtml).toContain(`主会话：${session.title}`);
    } finally {
      stateSpy.mockReset();
    }

    const mixedHtml = renderToStaticMarkup(createElement(MobileWorkspace, {
      ...workspaceProps(),
      snapshot: {
        ...snapshot,
        sessions: [
          session,
          sidechatActive,
          sidechatArchived,
          { ...session, sessionId: "fork-regular", title: "普通分支", parentSessionId: session.sessionId, forkLabel: "fork-2" },
          archivedParent,
          archivedChild,
          { ...session, sessionId: "btw-wrong-project", title: "btw: 跨项目孤儿保护", parentSessionId: session.sessionId, projectId: "other-project", sidechat: true, archivedAt: 70 },
        ],
      },
    }));
    expect(mixedHtml).toContain("2 个分支与侧聊");
    expect(mixedHtml).not.toContain("3 个分支与侧聊");
    expect(mixedHtml).not.toContain("btw: 归档父会话的侧聊");
    expect(mixedHtml).not.toContain("btw: 跨项目孤儿保护");
  });

  it.each([
    ["requested", undefined, "已请求切换为「完全授权」，等待 Desktop 确认"],
    ["requested", "acceptEdits", "已请求切换为「自动接受编辑」，等待 Desktop 确认"],
    ["confirmed", "default", "Desktop 已确认本次授权变更"],
    ["not-applied", "default", "Desktop 未切换为「逐个确认」，后续请求仍需确认"],
  ] as const)("shows the %s Desktop session mode change (%s) without claiming a permanent mode", (state, mode, label) => {
    const useState = vi.mocked(React.useState).getMockImplementation()!;
    const stateSpy = vi.mocked(React.useState)
      .mockImplementationOnce(useState)
      .mockImplementationOnce(useState)
      .mockReturnValueOnce([session.sessionId, vi.fn()]);
    try {
      const html = renderToStaticMarkup(createElement(MobileWorkspace, {
        ...workspaceProps(),
        snapshot: { ...snapshot, sessions: [{ ...session, nativePermissionModeChange: { requestId: "native-request", state, ...(mode ? { mode } : {}) } }] },
      }));
      expect(html).toContain('aria-label="Desktop 会话授权变更"');
      expect(html).toContain(label);
      expect(html).not.toContain("永久完全授权");
      expect(html).not.toContain("全局完全授权");
    } finally {
      stateSpy.mockReset();
    }
  });

  it("shows native queue and permission state without Desktop handoff guidance", () => {
    const useState = vi.mocked(React.useState).getMockImplementation()!;
    const stateSpy = vi.mocked(React.useState)
      .mockImplementationOnce(useState)
      .mockImplementationOnce(useState)
      .mockReturnValueOnce([session.sessionId, vi.fn()]);
    try {
      const html = renderToStaticMarkup(createElement(MobileWorkspace, {
        ...workspaceProps(), snapshot: { ...snapshot, host: { ...snapshot.host, capabilities: ["claude.native-relay.v1"] }, sessions: [{ ...session,
          transport: "claude-desktop-native", ownership: "DESKTOP_NATIVE_RUNNING", pendingCount: 1,
          nativePermissionModeChange: { requestId: "native-request", state: "confirmed" },
        }] },
      }));
      expect(html).toContain("Desktop 已确认本次授权变更");
      expect(html).toContain('aria-label="消息排队状态"');
      expect(html).not.toContain("等待关闭此 Desktop 会话");
      expect(html).not.toContain("旧会话仅供查看");
    } finally { stateSpy.mockReset(); }
  });

  it("offers configuration according to session runtime capabilities", () => {
    expect(canConfigureSession(session)).toBe(false);
    expect(canConfigureSession({ ...session, allowedActions: { canConfigure: false } as NonNullable<BridgeSessionInfo["allowedActions"]> })).toBe(false);
    expect(canConfigureSession({ ...session, runtimeId: "codex-desktop" })).toBe(false);
    expect(canConfigureSession({ ...session, runtimeId: "codex-desktop", allowedActions: { canConfigure: true } as NonNullable<BridgeSessionInfo["allowedActions"]> })).toBe(false);
  });
});

describe("native Desktop permission actions", () => {
  const permission: BridgePermissionInfo = {
    requestId: "native-request", sessionId: "session-1", toolUseId: "tool-1", toolName: "Bash",
    input: { command: "pwd" }, createdAt: 1, canAllowAlways: false, canSetNativeFullAccess: true,
  };
  afterEach(() => {
    vi.mocked(React.useState).mockReset();
    vi.mocked(React.useEffect).mockReset();
  });

  it.each([
    [true, true, true],
    [true, false, false],
    [false, true, false],
    [false, false, false],
  ])("requires capability %s and a native callback %s to show the native button", (capability, callback, visible) => {
    const html = renderToStaticMarkup(createElement(PermissionPrompt, {
      permission: { ...permission, canSetNativeFullAccess: capability }, onResolve: vi.fn(),
      ...(callback ? { onEnableNativeFullAccess: vi.fn() } : {}),
    }));
    expect(html.includes("此 Desktop 会话完全授权")).toBe(visible);
    expect(html).not.toContain("Bridge 默认完全授权");
    expect(html).not.toContain("电脑默认完全授权");
  });

  it("does not offer either upgrade action on AskUserQuestion", () => {
    const html = renderToStaticMarkup(createElement(PermissionPrompt, {
      permission: { ...permission, toolName: "AskUserQuestion", input: { questions: [{ question: "选择环境？", options: [{ label: "测试" }] }] } },
      onResolve: vi.fn(), onEnableNativeFullAccess: vi.fn(),
    }));
    expect(html).toContain("选择环境？");
    expect(html).not.toContain("此 Desktop 会话完全授权");
    expect(html).not.toContain("Bridge 默认完全授权");
  });

  it("requires explicit confirmation before changing the native session mode", async () => {
    const onResolve = vi.fn().mockResolvedValue(undefined);
    const onEnableNativeFullAccess = vi.fn().mockResolvedValue(undefined);
    vi.mocked(React.useState)
      .mockReturnValueOnce([false, vi.fn()])
      .mockReturnValueOnce([undefined, vi.fn()])
      .mockReturnValueOnce([true, vi.fn()])
      .mockReturnValueOnce([undefined, vi.fn()]);
    vi.mocked(React.useEffect).mockImplementationOnce(() => undefined);
    const child = PermissionPrompt({ permission, onResolve, onEnableNativeFullAccess });
    const tree = (child.type as (props: typeof child.props) => ReactNode)(child.props);
    const confirmation = elements(tree).find(element => element.type === ConfirmationDialog)!;
    expect(confirmation.props.open).toBe(true);
    expect(confirmation.props.title).toBe("此 Desktop 会话完全授权");
    expect(confirmation.props.description).toContain("允许当前工具");
    expect(confirmation.props.description).toContain("需等待 Desktop 确认");
    expect(confirmation.props.description).toContain("提问和强制确认仍需响应");
    expect(confirmation.props.description).toContain("收件箱接收许可仍需在电脑端确认");
    expect(onEnableNativeFullAccess).not.toHaveBeenCalled();
    confirmation.props.onConfirm();
    await Promise.resolve();
    expect(onEnableNativeFullAccess).toHaveBeenCalledWith(permission.requestId);
    expect(onResolve).not.toHaveBeenCalled();
  });

  const renderPrompt = (props: ComponentProps<typeof PermissionPrompt>, feedback?: string) => {
    vi.mocked(React.useState)
      .mockReturnValueOnce([false, vi.fn()])
      .mockReturnValueOnce([undefined, vi.fn()])
      .mockReturnValueOnce([undefined, vi.fn()])
      .mockReturnValueOnce([feedback, vi.fn()]);
    vi.mocked(React.useEffect).mockImplementationOnce(() => undefined);
    const child = PermissionPrompt(props);
    return elements((child.type as (props: typeof child.props) => ReactNode)(child.props));
  };
  const button = (tree: ReactElement<Record<string, any>>[], label: string) => tree.find((element) => (
    element.type === "button" && [element.props.children].flat().includes(label)
  ));
  const plan: BridgePermissionInfo = { ...permission, toolName: "ExitPlanMode", input: { plan: "# 计划\n\n- 第一步" } };

  it("renders the full ExitPlanMode plan and maps each approval to a session mode", async () => {
    const html = renderToStaticMarkup(createElement(PermissionPrompt, { permission: plan, onResolve: vi.fn() }));
    expect(html).toContain("<h1");
    expect(html).not.toContain("查看完整参数");
    const onResolve = vi.fn().mockResolvedValue(undefined);
    const tree = renderPrompt({ permission: plan, onResolve, onEnableNativeFullAccess: vi.fn() });
    expect(button(tree, "是，完全授权")).toBeDefined();
    button(tree, "是，自动接受编辑")!.props.onClick();
    await Promise.resolve();
    expect(onResolve).toHaveBeenCalledWith(plan.requestId, "allow-once", undefined, undefined, "acceptEdits");
    button(renderPrompt({ permission: plan, onResolve }), "是，逐个确认")!.props.onClick();
    await Promise.resolve();
    expect(onResolve).toHaveBeenLastCalledWith(plan.requestId, "allow-once", undefined, undefined, "default");
  });

  it("offers plain plan approval when the request cannot change the session mode", () => {
    const html = renderToStaticMarkup(createElement(PermissionPrompt, {
      permission: { ...plan, canSetNativeFullAccess: false }, onResolve: vi.fn(),
    }));
    expect(html).toContain("批准计划");
    expect(html).toContain("否，继续规划");
    expect(html).not.toContain("自动接受编辑");
  });

  it.each([
    [permission, "拒绝", "改用只读命令"],
    [plan, "继续规划", "先补充回滚方案"],
  ] as const)("sends deny feedback from the %s composer", async (request, label, text) => {
    const onResolve = vi.fn().mockResolvedValue(undefined);
    const tree = renderPrompt({ permission: request, onResolve }, `  ${text} `);
    expect(tree.some((element) => element.type === "textarea")).toBe(true);
    expect(button(tree, "允许一次")).toBeUndefined();
    button(tree, label)!.props.onClick();
    await Promise.resolve();
    expect(onResolve).toHaveBeenCalledWith(request.requestId, "deny", text, undefined, undefined);
  });
});

describe("native user image attachments", () => {
  const attachments = Array.from({ length: 5 }, (_, imageIndex) => ({
    id: `native-image:user-uuid:${imageIndex}`, name: `${imageIndex + 1}.png`, mimeType: "image/png" as const, size: 8,
    nativeImage: { messageUuid: "user-uuid", imageIndex },
  }));
  const historyItem: BridgeHistoryItem = { id: "user-uuid", sessionId: "session", role: "user", text: "[图片] 这是我手写的文字", origin: "claude-desktop", createdAt: 2, attachments };
  const local: LocalTurn = { requestId: "request", idempotencyKey: "key", sessionId: "session", text: historyItem.text,
    attachments: attachments.map((attachment, index) => ({ ...attachment, id: `local-${index}`, data: btoa(`image-${index}`) })), createdAt: 1, delivery: "submitted" };
  const accepted: BridgeEvent = { eventId: "accepted", seq: 2, timestamp: 2, sessionId: "session", itemId: historyItem.id,
    origin: "claude-desktop", type: "user.message.accepted", data: { requestId: local.requestId, text: historyItem.text, attachments } };

  it("retains all local previews on the accepted canonical UUID", () => {
    const items = conversationItems("session", undefined, [accepted], [local]);
    expect(items).toHaveLength(1);
    expect(items[0]?.attachments?.map(attachment => attachment.data)).toEqual(local.attachments.map(attachment => attachment.data));
    expect(items[0]?.attachments?.map(attachment => attachment.nativeImage)).toEqual(attachments.map(attachment => attachment.nativeImage));
    expect(items[0]?.text).toBe(historyItem.text);
  });

  it("restores all five stable references with no original bytes after reopening", () => {
    const items = conversationItems("session", { status: "ready", hasMore: false, items: [historyItem] }, [], []);
    expect(items[0]?.attachments).toEqual(attachments);
    expect(items[0]?.attachments?.every(attachment => !attachment.data)).toBe(true);
    expect(items[0]?.text).toBe(historyItem.text);
  });
});

describe("native transcript delivery recovery", () => {
  const users: BridgeHistoryItem[] = ["one", "two"].map((id, index) => ({
    id: `uuid-${id}`, sessionId: "session", role: "user", text: "相同正文", createdAt: index,
    origin: "claude-desktop", delivery: "session-received",
  }));
  const history = { status: "ready" as const, items: users, hasMore: false };
  const stage = (type: BridgeEvent["type"], seq: number, turnId?: string): BridgeEvent => ({
    eventId: `stage-${seq}`, seq, timestamp: seq, sessionId: "session", origin: "claude-desktop", type, ...(turnId ? { turnId } : {}), data: {},
  });

  it("recovers saved history stages with no local turns or event replay", () => {
    const deliveries = ["submitted", "session-received", "queued", "running", "completed", "failed", "cancelled"] as const;
    const items = deliveries.map((delivery, index) => ({ ...users[0]!, id: `uuid-${index}`, delivery }));
    expect(conversationItems("session", { ...history, items }, [], []).map(item => item.delivery)).toEqual(deliveries);
  });

  it("advances history users by UUID without needing a local request", () => {
    const items = conversationItems("session", history, [stage("turn.queued", 2, "uuid-one"), stage("turn.started", 3, "uuid-two"), stage("turn.completed", 4)], []);
    expect(items.map(item => item.delivery)).toEqual(["queued", "running"]);
  });

  it("corrects completed to failed from a later result for the same UUID without local turns", () => {
    const queued = { ...history, items: [{ ...users[0]!, delivery: "queued" as const }] };
    const items = conversationItems("session", queued, [stage("turn.completed", 2, "uuid-one"), stage("turn.failed", 3, "uuid-one")], []);
    expect(items.find(item => item.role === "user")).toMatchObject({ id: "uuid-one", delivery: "failed" });
  });

  it.each(["completed", "failed", "cancelled"] as const)("keeps restored %s when accepted receipt arrives late", delivery => {
    const restored = { ...history, items: [{ ...users[0]!, delivery }] };
    const accepted: BridgeEvent = { ...stage("user.message.accepted", 3), itemId: "uuid-one", data: { text: "相同正文", delivery: "session-received" } };
    expect(conversationItems("session", restored, [accepted], []).find(item => item.role === "user")?.delivery).toBe(delivery);
  });

  it("keeps started when receipt arrives later and consumes accepted delivery", () => {
    const accepted = (id: string, delivery: string, seq: number): BridgeEvent => ({
      ...stage("user.message.accepted", seq), itemId: id, data: { text: "相同正文", delivery },
    });
    const items = conversationItems("session", history, [stage("turn.started", 2, "uuid-one"), accepted("uuid-one", "session-received", 3), accepted("uuid-two", "queued", 4)], []);
    expect(items.map(item => [item.id, item.delivery])).toEqual([["uuid-one", "running"], ["uuid-two", "queued"]]);
  });
});

describe("mobile message delivery receipts", () => {
  const accepted: BridgeEvent = {
    eventId: "accepted", seq: 2, timestamp: 200, sessionId: "session-1", turnId: "turn-1", itemId: "message-1",
    origin: "mobile", type: "user.message.accepted", data: { requestId: "request-1", commandId: "command-1", text: "检查部署" },
  };

  it.each([
    ["turn.completed", "completed"],
    ["turn.failed", "failed"],
    ["turn.interrupted", "cancelled"],
  ] as const)("retains %s on the accepted message after removing its local placeholder", (type, delivery) => {
    const events: BridgeEvent[] = [accepted, { ...accepted, eventId: "terminal", seq: 3, timestamp: 300, type,
      data: { commandId: "command-1", error: "模型服务不可用" } }];
    const items = conversationItems("session-1", undefined, events, [{
      requestId: "request-1", idempotencyKey: "key-1", commandId: "command-1", turnId: "turn-1", sessionId: "session-1",
      text: "检查部署", attachments: [], createdAt: 100, delivery,
    }]);
    const users = items.filter((item) => item.role === "user");
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ id: "message-1", commandId: "command-1", delivery });
    if (delivery === "failed") expect(users[0]?.error).toBe("模型服务不可用");
  });

  it("restores terminal status from replay even without a local message cache", () => {
    const completed: BridgeEvent = { ...accepted, eventId: "done", type: "turn.completed", seq: 3, data: { commandId: "command-1" } };
    const items = conversationItems("session-1", undefined, [accepted, completed], []);
    expect(items[0]).toMatchObject({ delivery: "completed", commandId: "command-1" });
  });

  it("keeps the receipt when transcript synchronization updates the same user message", () => {
    const completed: BridgeEvent = { ...accepted, eventId: "done", type: "turn.completed", seq: 3, data: { commandId: "command-1" } };
    const observed: BridgeEvent = { eventId: "observed", seq: 4, timestamp: 250, sessionId: "session-1", itemId: "message-1", origin: "claude-desktop", type: "session.observed", data: { role: "user", text: "检查部署" } };
    expect(conversationItems("session-1", undefined, [accepted, completed, observed], [])[0])
      .toMatchObject({ id: "message-1", delivery: "completed", commandId: "command-1" });
  });

  it("does not apply another turn's terminal receipt to an accepted message", () => {
    const other: BridgeEvent = { ...accepted, eventId: "other", type: "turn.completed", turnId: "turn-2", data: { commandId: "command-2" } };
    expect(conversationItems("session-1", undefined, [accepted, other], [])[0]?.delivery).toBe("session-received");
  });
});

describe("native queued delivery and message rekeying", () => {
  const user: BridgeHistoryItem & { commandId: string } = {
    id: "old-uuid", sessionId: "session-1", role: "user" as const, text: "相同正文", createdAt: 100,
    origin: "claude-desktop" as const, delivery: "queued" as const, commandId: "stable-command",
    attachments: [{ id: "image", name: "context.png", mimeType: "image/png", size: 7 }],
  };
  const receipt: BridgeEvent = {
    eventId: "cancelled", seq: 5, timestamp: 150, sessionId: "session-1", origin: "claude-desktop",
    type: "message.delivery", turnId: "old-uuid", itemId: "old-uuid",
    data: { requestId: "stable-request", commandId: "stable-command", messageId: "old-uuid", delivery: "cancelled" },
  };

  it.each(["messageId", "commandId", "requestId"] as const)("cancels a history-only queued user by %s with no local cache", identity => {
    const item = { ...user, requestId: "stable-request" };
    const data = { delivery: "cancelled", [identity]: receipt.data[identity] };
    const { itemId: _itemId, turnId: _turnId, ...event } = receipt;
    expect(conversationItems("session-1", { status: "ready", hasMore: false, items: [item] }, [
      { ...event, data },
    ], [])).toEqual([expect.objectContaining({ id: "old-uuid", delivery: "cancelled", commandId: "stable-command" })]);
  });

  it("orders queue cancellation and turn stages by event sequence, independent of array order", () => {
    const started: BridgeEvent = { ...receipt, eventId: "started", seq: 3, type: "turn.started", data: { commandId: "stable-command" } };
    const queued: BridgeEvent = { ...receipt, eventId: "queued", seq: 2, type: "message.delivery", data: { ...receipt.data, delivery: "queued" } };
    expect(conversationItems("session-1", { status: "ready", hasMore: false, items: [user] }, [receipt, started, queued], [])
      .find(item => item.role === "user")).toMatchObject({ delivery: "cancelled" });
  });

  it.each(["history", "accepted", "local"])("updates native image references after rekeying a %s message", source => {
    const attachment = { ...user.attachments![0]!, nativeImage: { messageUuid: "old-uuid", imageIndex: 0 } };
    const rekey: BridgeEvent = { ...receipt, seq: 2, itemId: "new-uuid", turnId: "new-uuid", data: { commandId: "stable-command", previousMessageId: "old-uuid", messageId: "new-uuid", delivery: "queued" } };
    const accepted: BridgeEvent = { ...receipt, seq: 1, type: "user.message.accepted", data: { text: user.text, commandId: "stable-command", attachments: [attachment] } };
    const items = conversationItems("session-1", source === "history" ? { status: "ready", hasMore: false, items: [{ ...user, attachments: [attachment] }] } : undefined,
      source === "accepted" ? [accepted, rekey] : [rekey], source === "local" ? [{ requestId: "stable-request", idempotencyKey: "key", sessionId: "session-1", messageId: "old-uuid", commandId: "stable-command", text: user.text, attachments: [attachment], createdAt: 100, delivery: "queued" }] : []);
    expect(items.find(item => item.role === "user")).toMatchObject({ id: "new-uuid", attachments: [{ nativeImage: { messageUuid: "new-uuid", imageIndex: 0 } }] });
    expect(attachment.nativeImage.messageUuid).toBe("old-uuid");
  });

  it("follows a multi-hop rekey chain with shuffled duplicate events and all image indices", () => {
    const attachments = [0, 1, 2, 3, 4].map(imageIndex => ({ ...user.attachments![0]!, id: `image-${imageIndex}`, nativeImage: { messageUuid: "old-uuid", imageIndex } }));
    const first: BridgeEvent = { ...receipt, seq: 1, eventId: "first-rekey", data: { commandId: "stable-command", previousMessageId: "old-uuid", messageId: "middle-uuid", delivery: "queued" } };
    const second: BridgeEvent = { ...receipt, seq: 2, eventId: "second-rekey", data: { commandId: "stable-command", previousMessageId: "middle-uuid", messageId: "final-uuid", delivery: "queued" } };
    const items = conversationItems("session-1", { status: "ready", hasMore: false, items: [{ ...user, attachments }, { ...user, id: "unrelated-uuid", commandId: "other-command" }] }, [second, first, second], []);
    expect(items).toHaveLength(2);
    expect(items.find(item => item.commandId === "stable-command")).toMatchObject({ id: "final-uuid", attachments: attachments.map((attachment, imageIndex) => ({ nativeImage: { messageUuid: "final-uuid", imageIndex } })) });
    expect(items.find(item => item.id === "unrelated-uuid")).toMatchObject({ text: user.text, commandId: "other-command" });
    expect(attachments.every(attachment => attachment.nativeImage.messageUuid === "old-uuid")).toBe(true);
  });

  it.each([false, true])("reconciles fresh rekeyed history with cached old identity when the rekey event is unavailable (old echo=%s)", oldEcho => {
    const current = { ...user, id: "current-native-uuid", requestId: "stable-request" };
    const local: LocalTurn = { requestId: "stable-request", idempotencyKey: "stable-key", sessionId: "session-1", commandId: "stable-command", messageId: "old-uuid", text: user.text, attachments: user.attachments!, createdAt: 100, delivery: "queued" };
    const accepted: BridgeEvent = { ...receipt, seq: 1, type: "user.message.accepted", data: { commandId: "stable-command", requestId: "stable-request", messageId: "old-uuid", text: user.text, delivery: "queued" } };
    const items = conversationItems("session-1", { status: "ready", hasMore: false, items: [current] }, oldEcho ? [accepted] : [], [local]);
    expect(items.filter(item => item.role === "user")).toEqual([expect.objectContaining({ id: "current-native-uuid", commandId: "stable-command", requestId: "stable-request", delivery: "queued" })]);
  });

  it.each(["commandId", "requestId"] as const)("merges missing-rekey history by %s and updates cached image references", identity => {
    const attachment = { ...user.attachments![0]!, nativeImage: { messageUuid: "old-uuid", imageIndex: 0 } };
    const { commandId: _commandId, ...bareUser } = user;
    const historyItem: BridgeHistoryItem = { ...bareUser, id: "current-native-uuid", [identity]: identity === "commandId" ? "stable-command" : "stable-request" };
    const local: LocalTurn = { requestId: "stable-request", idempotencyKey: "stable-key", sessionId: "session-1", commandId: "stable-command", messageId: "old-uuid", text: user.text, attachments: [attachment], createdAt: 100, delivery: "queued" };
    const items = conversationItems("session-1", { status: "ready", hasMore: false, items: [{ ...historyItem, attachments: [attachment] }] }, [], [local]);
    expect(items).toEqual([expect.objectContaining({ id: "current-native-uuid", attachments: [expect.objectContaining({ nativeImage: { messageUuid: "current-native-uuid", imageIndex: 0 } })] })]);
    expect(attachment.nativeImage.messageUuid).toBe("old-uuid");
  });

  it.each(["completed", "failed", "cancelled"] as const)("keeps fresh history's %s after merging its old queued local receipt", delivery => {
    const local: LocalTurn = { requestId: "stable-request", idempotencyKey: "stable-key", sessionId: "session-1", commandId: "stable-command", messageId: "old-uuid", text: user.text, attachments: [], createdAt: 100, delivery: "queued" };
    const items = conversationItems("session-1", { status: "ready", hasMore: false, items: [{ ...user, id: "current-native-uuid", requestId: "stable-request", delivery }] }, [], [local]);
    expect(items).toEqual([expect.objectContaining({ id: "current-native-uuid", delivery })]);
  });

  it("keeps an explicit later rekey ahead of the history UUID when linking a receipt", () => {
    const rekey: BridgeEvent = { ...receipt, data: { ...receipt.data, previousMessageId: "old-uuid", messageId: "newest-uuid", delivery: "queued" } };
    const local: LocalTurn = { requestId: "stable-request", idempotencyKey: "stable-key", sessionId: "session-1", commandId: "stable-command", messageId: "old-uuid", text: user.text, attachments: [], createdAt: 100, delivery: "queued" };
    expect(conversationItems("session-1", { status: "ready", hasMore: false, items: [{ ...user, requestId: "stable-request" }] }, [rekey], [local]))
      .toEqual([expect.objectContaining({ id: "newest-uuid", commandId: "stable-command" })]);
  });

  it("keeps same-text messages with different receipts distinct without rekey events", () => {
    const historyItems = ["first", "second"].map(key => ({ ...user, id: `current-${key}`, commandId: `command-${key}`, requestId: `request-${key}` }));
    const local: LocalTurn[] = ["first", "second"].map(key => ({ requestId: `request-${key}`, idempotencyKey: `key-${key}`, sessionId: "session-1", commandId: `command-${key}`, messageId: `old-${key}`, text: user.text, attachments: [], createdAt: 100, delivery: "queued" }));
    const items = conversationItems("session-1", { status: "ready", hasMore: false, items: historyItems }, [], local);
    expect(items.map(item => item.id)).toEqual(["current-first", "current-second"]);
    expect(items.map(item => item.commandId)).toEqual(["command-first", "command-second"]);
  });

  it("does not rekey a same-UUID image using a different session's event", () => {
    const attachment = { ...user.attachments![0]!, nativeImage: { messageUuid: "old-uuid", imageIndex: 0 } };
    const foreign: BridgeEvent = { ...receipt, sessionId: "foreign-session", data: { commandId: "stable-command", previousMessageId: "old-uuid", messageId: "foreign-uuid", delivery: "queued" } };
    expect(conversationItems("session-1", { status: "ready", hasMore: false, items: [{ ...user, attachments: [attachment] }] }, [foreign], [])).toEqual([expect.objectContaining({ id: "old-uuid", attachments: [attachment], delivery: "queued" })]);
  });

  it.each([undefined, "old-uuid", "new-uuid"])("canonicalizes explicitly rekeyed history, acceptance, echo and local message %s without text deduplication", messageId => {
    const rekey: BridgeEvent = {
      ...receipt, eventId: "rekey", seq: 4, itemId: "new-uuid", turnId: "new-uuid",
      data: { requestId: "stable-request", commandId: "stable-command", previousMessageId: "old-uuid", messageId: "new-uuid", delivery: "queued" },
    };
    const accepted: BridgeEvent = {
      ...receipt, eventId: "accepted-old", seq: 1, itemId: "old-uuid", turnId: "old-uuid", type: "user.message.accepted",
      data: { text: user.text, commandId: "stable-command", delivery: "queued" },
    };
    const echo: BridgeEvent = {
      ...receipt, eventId: "echo-new", seq: 6, timestamp: 160, itemId: "new-uuid", turnId: "new-uuid", type: "session.observed",
      data: { role: "user", text: user.text },
    };
    const local: LocalTurn = {
      requestId: "stable-request", idempotencyKey: "key", sessionId: "session-1", commandId: "stable-command",
      ...(messageId ? { messageId } : {}), text: user.text, attachments: user.attachments!, createdAt: 100, delivery: "queued",
    };
    const history = { status: "ready" as const, hasMore: false, items: [
      { ...user, id: "new-uuid" }, user, { ...user, id: "unrelated-uuid", commandId: "unrelated-command" },
    ] };
    const items = conversationItems("session-1", history, [echo, rekey, accepted], [local]);
    expect(items.filter(item => item.role === "user")).toHaveLength(2);
    expect(items.find(item => item.id === "new-uuid")).toMatchObject({
      requestId: "stable-request", commandId: "stable-command", turnId: "new-uuid", delivery: "queued", attachments: user.attachments,
    });
    expect(items.find(item => item.id === "unrelated-uuid")).toMatchObject({ text: user.text, commandId: "unrelated-command" });
    expect(conversationItems("session-1", history, [echo, rekey, accepted, {
      ...receipt, seq: 7, itemId: "new-uuid", turnId: "new-uuid", data: { ...receipt.data, messageId: "new-uuid" },
    }], [local]).find(item => item.id === "new-uuid")?.delivery).toBe("cancelled");
  });
});

describe("submitted mobile message identity", () => {
  const local: LocalTurn = {
    requestId: "request-1", idempotencyKey: "key-1", commandId: "command-1", sessionId: "session-1",
    text: "检查部署", attachments: [], createdAt: 100, delivery: "submitted",
  };
  const queued: BridgeEvent = {
    eventId: "queued", seq: 1, timestamp: 110, sessionId: "session-1", turnId: "turn-1", origin: "mobile", type: "turn.queued",
    data: { requestId: "request-1", commandId: "command-1", text: local.text },
  };
  const submitted: BridgeEvent = {
    ...queued, eventId: "submitted", seq: 2, timestamp: 120, itemId: "message-1", origin: "claude-host", type: "message.delivery",
    data: { requestId: "request-1", commandId: "command-1", messageId: "message-1", delivery: "submitted" },
  };
  const observed: BridgeEvent = {
    eventId: "observed", seq: 3, timestamp: 130, sessionId: "session-1", itemId: "message-1", origin: "claude-desktop",
    type: "session.observed", data: { role: "user", text: local.text },
  };
  const interrupted: BridgeEvent = {
    ...queued, eventId: "interrupted", seq: 4, timestamp: 140, origin: "system", type: "turn.interrupted",
    data: { requestId: "request-1", commandId: "command-1" },
  };
  const accepted: BridgeEvent = {
    ...submitted, eventId: "late-accepted", seq: 5, timestamp: 150, type: "user.message.accepted",
    data: { text: local.text },
  };

  it.each(["observed", "interrupted", "late-accepted"] as const)("shows one user bubble at %s using the submitted request/message link", (phase) => {
    const events = [queued, submitted, observed, ...(phase === "observed" ? [] : [interrupted]), ...(phase === "late-accepted" ? [accepted] : [])];
    const delivery = phase === "observed" ? "submitted" : "cancelled";
    const items = conversationItems("session-1", undefined, events, [{ ...local, delivery }]);
    expect(items.filter((item) => item.role === "user")).toEqual([
      expect.objectContaining({ id: "message-1", text: local.text, requestId: "request-1", commandId: "command-1", delivery }),
    ]);
    if (phase !== "observed") expect(items.filter((item) => item.role === "system")).toHaveLength(1);
  });

  it.each(["submitted", "session-received", "completed"] as const)("keeps one %s message after the 2,000-event window rolls over", delivery => {
    const receipts = [submitted,
      ...(delivery === "submitted" ? [] : [{ ...accepted, data: { ...accepted.data, requestId: "request-1", commandId: "command-1" } }]),
      ...(delivery !== "completed" ? [] : [{ ...interrupted, eventId: "completed", seq: 6, type: "turn.completed" as const }]),
    ];
    const savedTurns = receipts.reduce<LocalTurn[]>((turns, event) => applyEventToTurns(turns, event), [local]);
    const recent = mergeBridgeEvents(receipts, Array.from({ length: 2_001 }, (_, index): BridgeEvent => ({
      eventId: `later-${index}`, seq: 100 + index, timestamp: 100 + index,
      sessionId: "another-session", origin: "claude-host", type: "assistant.delta", data: { text: "Progress" },
    })));
    expect(recent).toHaveLength(2_000);
    expect(recent.some(event => event.data.requestId === "request-1")).toBe(false);
    const items = conversationItems("session-1", { status: "ready", hasMore: false, items: [{
      id: "message-1", sessionId: "session-1", role: "user", text: local.text, createdAt: 130, origin: "claude-desktop",
    }] }, recent, savedTurns);
    expect(items.filter(item => item.role === "user")).toEqual([
      expect.objectContaining({ id: "message-1", requestId: "request-1", commandId: "command-1", delivery }),
    ]);
  });

  it.each([[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]].map(order => ({ order })))("learns message identity without regressing completion for arrival order $order", ({ order }) => {
    const receipts: BridgeEvent[] = [submitted,
      { ...accepted, data: { requestId: "request-1", commandId: "command-1", text: local.text } },
      { ...interrupted, eventId: "completed", seq: 6, type: "turn.completed" },
    ];
    const saved = order.reduce<LocalTurn[]>((turns, index) => applyEventToTurns(turns, receipts[index]!), [local]);
    expect(saved[0]).toMatchObject({ delivery: "completed", messageId: "message-1" });
    expect(conversationItems("session-1", { status: "ready", hasMore: false, items: [{
      id: "message-1", sessionId: "session-1", role: "user", text: local.text, createdAt: 130, origin: "claude-desktop",
    }] }, [], saved).filter(item => item.role === "user")).toHaveLength(1);
  });

  it.each([false, true])("preserves a native user echo after earlier submission stages are replayed (cached=%s)", cached => {
    const events: BridgeEvent[] = [
      { ...submitted, eventId: "host", seq: 1, origin: "claude-desktop", data: { ...submitted.data, delivery: "host-received", text: local.text } },
      { ...submitted, origin: "claude-desktop" },
      { ...accepted, origin: "claude-desktop", data: { ...submitted.data, text: local.text, delivery: "session-received" } },
    ];
    const saved = events.reduce<LocalTurn[]>((turns, event) => applyEventToTurns(turns, event), [local]);
    expect(saved[0]?.delivery).toBe("session-received");
    const history = cached ? { status: "ready" as const, hasMore: false, items: [{
      id: "message-1", sessionId: "session-1", role: "user" as const, text: local.text,
      createdAt: 130, origin: "claude-desktop" as const, delivery: "session-received" as const,
      commandId: "command-1", requestId: local.requestId,
    }] } : undefined;
    expect(conversationItems("session-1", history, events, saved).filter(item => item.role === "user"))
      .toEqual([expect.objectContaining({ id: "message-1", delivery: "session-received", commandId: local.commandId })]);
  });

  it("merges a submitted local message with its cached transcript row", () => {
    const historyItem: BridgeHistoryItem = {
      id: "message-1", sessionId: "session-1", role: "user", text: local.text, createdAt: 130, origin: "claude-desktop",
      attachments: [{ id: "image-1", name: "photo.png", mimeType: "image/png", size: 10 }],
    };
    const items = conversationItems("session-1", { status: "ready", hasMore: false, items: [historyItem] }, [queued, submitted], [local]);
    expect(items).toEqual([expect.objectContaining({ ...historyItem, requestId: "request-1", commandId: "command-1", delivery: "submitted" })]);
  });

  it.each(["host-received", "session-received"] as const)("does not treat a %s command receipt as the transcript UUID", (delivery) => {
    const receipt: BridgeEvent = {
      ...submitted, eventId: "manual-receipt", seq: 4, timestamp: 140, itemId: "command-1",
      data: { requestId: "request-1", commandId: "command-1", delivery },
    };
    const items = conversationItems("session-1", undefined, [queued, submitted, observed, receipt], [local]);
    expect(items.filter(item => item.role === "user")).toEqual([
      expect.objectContaining({ id: "message-1", requestId: "request-1", commandId: "command-1", text: local.text }),
    ]);
  });

  it("keeps different submitted requests distinct even with equal text and turn IDs", () => {
    const other: LocalTurn = { ...local, requestId: "request-2", idempotencyKey: "key-2", commandId: "command-2", createdAt: 200 };
    const items = conversationItems("session-1", undefined, [
      queued, submitted, observed,
      { ...queued, eventId: "queued-2", seq: 4, timestamp: 210, data: { requestId: "request-2", commandId: "command-2", text: other.text } },
      { ...submitted, eventId: "submitted-2", seq: 5, timestamp: 220, itemId: "message-2", data: { requestId: "request-2", commandId: "command-2", messageId: "message-2", delivery: "submitted" } },
      { ...observed, eventId: "observed-2", seq: 6, timestamp: 230, itemId: "message-2" },
    ], [local, other]);
    expect(items.filter((item) => item.role === "user").map((item) => [item.id, item.requestId, item.text, item.delivery])).toEqual([
      ["message-1", "request-1", local.text, "submitted"], ["message-2", "request-2", other.text, "submitted"],
    ]);
  });
});

describe("native tool completion identity", () => {
  const completed: BridgeEvent = { eventId: "result-only", seq: 1, timestamp: 200, sessionId: "session-1", itemId: "read-call", origin: "claude-desktop", type: "tool.completed", data: { output: "file contents" } };

  it("does not invent an anonymous tool row for a cached native result with no call definition", () => {
    expect(conversationItems("session-1", undefined, [completed], [])).toEqual([]);
  });

  it("recovers a cached result's real name and input when its native history call is loaded", () => {
    const history: BridgeHistoryItem = { id: "read-call", sessionId: "session-1", role: "tool", toolName: "Read", text: '{"file_path":"/fixture/source.ts"}', createdAt: 100, origin: "claude-desktop" };
    expect(conversationItems("session-1", { status: "ready", hasMore: false, items: [history] }, [completed], [])).toEqual([expect.objectContaining({ id: "tool:read-call", toolName: "Read", text: history.text, state: "completed" })]);
  });

  it("renders a named native completion without requiring the earlier start event", () => {
    expect(conversationItems("session-1", undefined, [{ ...completed, data: { ...completed.data, toolName: "Read", text: '{"file_path":"/fixture/source.ts"}' } }], [])).toEqual([expect.objectContaining({ id: "tool:read-call", toolName: "Read", text: '{"file_path":"/fixture/source.ts"}', state: "completed" })]);
  });
});

describe("question reply delivery association", () => {
  const question: BridgeHistoryItem = {
    id: "question", sessionId: "session-1", role: "assistant", text: "", createdAt: 1, origin: "claude-desktop",
    interactivePrompt: { kind: "question", questions: [{ question: "Which branch?", options: [{ label: "Main" }] }] },
  };
  const history = (items: BridgeHistoryItem[]) => ({ status: "ready" as const, hasMore: false, items });
  const unrelated = (delivery: LocalTurn["delivery"]): LocalTurn => ({
    requestId: "new-task", idempotencyKey: "new-task-key", commandId: "new-command", sessionId: "session-1",
    text: "Deploy the documentation", attachments: [], createdAt: 4, delivery,
  });

  it.each(["host-received", "failed"] as const)("keeps a transcript-resolved question independent of a later %s task", delivery => {
    const resolved: BridgeHistoryItem = { ...question, interactivePrompt: {
      ...question.interactivePrompt!, answered: true,
      questions: [{ ...question.interactivePrompt!.questions![0]!, answer: "Main", options: [{ label: "Main", selected: true }] }],
    } };
    const before = conversationItems("session-1", history([resolved]), [], []);
    const after = conversationItems("session-1", history([resolved]), [], [unrelated(delivery)]);
    expect(after.find(item => item.id === question.id)).toEqual(before[0]);
    expect(after.find(item => item.role === "user")?.delivery).toBe(delivery);
  });

  it.each(["host-received", "failed"] as const)("does not assign a later %s task to a permission-resolved question with no visible user reply", delivery => {
    const resolved: BridgeEvent = { eventId: "resolved", seq: 1, timestamp: 2, sessionId: "session-1", origin: "system",
      itemId: "permission", type: "question.resolved", data: { requestId: "permission", toolName: "AskUserQuestion", decision: "allow-once" } };
    const items = conversationItems("session-1", history([question]), [resolved], [unrelated(delivery)]);
    expect(items.find(item => item.id === question.id)).toMatchObject({ interactivePrompt: { answered: true } });
    expect(items.find(item => item.id === question.id)?.replyDelivery).toBeUndefined();
    expect(items.find(item => item.role === "user")?.delivery).toBe(delivery);
  });

  it("does not borrow a new task's delivery after assistant activity has already closed a question", () => {
    const items = conversationItems("session-1", history([question, {
      id: "continuation", sessionId: "session-1", role: "assistant", text: "Using Main", createdAt: 2, origin: "claude-desktop",
    }]), [], [unrelated("failed")]);
    expect(items.find(item => item.id === question.id)).toMatchObject({ interactivePrompt: { answered: true } });
    expect(items.find(item => item.id === question.id)?.replyDelivery).toBeUndefined();
  });

  it.each([false, true])("uses the submitted reply request even when a nearer user message has the same text (transcript answered=%s)", answered => {
    const items = conversationItems("session-1", history([{ ...question, interactivePrompt: { ...question.interactivePrompt!, answered } }]), [], [
      { ...unrelated("failed"), text: "Main" }, { ...unrelated("host-received"), requestId: "actual-answer", idempotencyKey: "answer-key", text: "Main", createdAt: 5 },
    ], false, { question: "actual-answer" });
    expect(items.find(item => item.id === question.id)?.replyDelivery).toBe("host-received");
    expect(items.find(item => item.id === question.id)?.interactivePrompt?.answered).toBe(true);
  });

  it("reads a matching delivery event by request ID before a visible user message exists", () => {
    const event: BridgeEvent = { eventId: "queued-reply", seq: 1, timestamp: 2, sessionId: "session-1", origin: "claude-host",
      type: "message.delivery", data: { requestId: "actual-answer", commandId: "answer-command", delivery: "host-received" } };
    const items = conversationItems("session-1", history([question]), [event], [unrelated("failed")], false, { question: "actual-answer" });
    expect(items.find(item => item.id === question.id)?.replyDelivery).toBe("host-received");
  });

  it("does not call an unlinked pending user message a confirmed question reply", () => {
    const items = conversationItems("session-1", history([question]), [], [unrelated("host-received")]);
    expect(items.find(item => item.id === question.id)?.replyDelivery).toBeUndefined();
    expect(items.find(item => item.id === question.id)?.replyPending).toBe(true);
  });

  it("keeps a submitted reply pending if only another request's receipt is present", () => {
    const items = conversationItems("session-1", history([question]), [], [unrelated("failed")], false, { question: "actual-answer" });
    expect(items.find(item => item.id === question.id)?.replyDelivery).toBeUndefined();
    expect(items.find(item => item.id === question.id)?.replyPending).toBe(true);
  });

  it("preserves a reply's terminal receipt after acceptance replaces its local placeholder", () => {
    const events: BridgeEvent[] = [
      { eventId: "accepted-reply", seq: 1, timestamp: 2, sessionId: "session-1", origin: "mobile", itemId: "reply", type: "user.message.accepted",
        data: { requestId: "actual-answer", commandId: "answer-command", text: "Main" } },
      { eventId: "failed-reply", seq: 2, timestamp: 3, sessionId: "session-1", origin: "claude-host", type: "turn.failed", data: { commandId: "answer-command" } },
    ];
    const items = conversationItems("session-1", history([question]), events, [unrelated("host-received")], false, { question: "actual-answer" });
    expect(items.find(item => item.id === question.id)?.replyDelivery).toBe("failed");
    expect(items.filter(item => item.role === "user").map(item => item.delivery)).toEqual(["failed", "host-received"]);
  });

  it("does not close the final question using itself, an empty user item, or an earlier resolution", () => {
    const resolved: BridgeEvent = { eventId: "old-resolution", seq: 1, timestamp: 0, sessionId: "session-1", origin: "system",
      type: "question.resolved", data: { decision: "allow-once" } };
    const items = conversationItems("session-1", history([question, {
      id: "empty-user", sessionId: "session-1", role: "user", text: "  ", createdAt: 2, origin: "claude-desktop",
    }]), [resolved], []);
    expect(items.find(item => item.id === question.id)?.interactivePrompt?.answered).toBeUndefined();
  });

  it("uses the nearest nonempty user reply when selecting wrap-up actions", () => {
    const items = conversationItems("session-1", history([
      { ...question, interactivePrompt: { kind: "wrap-up", actions: [{ label: "Feature", message: "Feature" }, { label: "Main", message: "Main" }] } },
      { id: "empty-user", sessionId: "session-1", role: "user", text: "  ", createdAt: 2, origin: "claude-desktop" },
      { id: "first-reply", sessionId: "session-1", role: "user", text: " Feature ", createdAt: 3, origin: "claude-desktop" },
      { id: "later-user", sessionId: "session-1", role: "user", text: "Main", createdAt: 4, origin: "claude-desktop" },
    ]), [], []);
    expect(items[0]!.interactivePrompt?.actions?.map(action => Boolean(action.selected))).toEqual([true, false]);
    expect(items[0]!.replyDelivery).toBeUndefined();
  });
});

describe("restorableSessionId", () => {
  const sessions = [{ sessionId: "session-1" }] as BridgeSessionInfo[];

  it("restores only a session that still belongs to the selected host", () => {
    expect(restorableSessionId("session-1", sessions)).toBe("session-1");
    expect(restorableSessionId("removed-session", sessions)).toBeUndefined();
    expect(restorableSessionId(undefined, sessions)).toBeUndefined();
  });
});

describe("sessionProfile", () => {
  it("uses modelDisplayName from custom gateway catalog when present", () => {
    const baseSession: BridgeSessionInfo = {
      sessionId: "session-1",
      projectId: "project-1",
      projectName: "Project",
      cwd: "/tmp/project",
      title: "Task",
      source: "desktop",
      ownership: "DESKTOP_OBSERVED",
      transport: "bridge-host",
      turnState: "idle",
      lastActivityAt: 1,
      pendingCount: 0,
      model: "gateway-model-alpha[1m]",
      effort: "high",
    };

    expect(sessionProfile(baseSession)).toBe("gateway model alpha 1M · HIGH");
    expect(sessionProfile({
      ...baseSession,
      modelDisplayName: "Claude Opus 4.6 · Gateway 1M",
    })).toBe("Claude Opus 4.6 · Gateway 1M · HIGH");
    expect(sessionProfile({
      ...baseSession,
      model: "mythos-magpie-1052229916[1m]",
    })).toBe("默认模型 1M · HIGH");
    expect(sessionProfile({
      ...baseSession,
      model: "magpie-2213244526.anthropic.claude-opus-5-5[1m]",
    })).toBe("opus 5 5 1M · HIGH");
  });
});

function evidence(
  id: string,
  turnId: string,
  state: BridgeEvidenceBundle["state"],
  startedAt: number,
): BridgeEvidenceBundle {
  return {
    id,
    sessionId: "session-1",
    turnId,
    source: "claude-desktop",
    confidence: "inferred",
    state,
    startedAt,
    ...(state === "collecting" ? {} : { completedAt: startedAt + 1 }),
    toolCount: 1,
    changeCount: 0,
    artifactCount: 0,
    tools: [],
    artifacts: [],
    warnings: [],
  };
}

describe("ownershipLabel", () => {
  it("identifies an active observed Claude session as Desktop running", () => {
    const session: BridgeSessionInfo = {
      sessionId: "session-1",
      projectId: "project-1",
      projectName: "Project",
      cwd: "/tmp/project",
      title: "Task",
      source: "desktop",
      ownership: "DESKTOP_OBSERVED",
      transport: "bridge-host",
      turnState: "running",
      lastActivityAt: 1,
      pendingCount: 0,
    };

    expect(ownershipLabel(session)).toBe("桌面运行中");
  });

  it("identifies a Bridge-created session without implying Desktop visibility", () => {
    const session: BridgeSessionInfo = {
      sessionId: "bridge-session-1",
      projectId: "project-1",
      projectName: "Project",
      cwd: "/tmp/project",
      title: "Task",
      source: "bridge",
      ownership: "BRIDGE_IDLE",
      transport: "bridge-host",
      turnState: "idle",
      lastActivityAt: 1,
      pendingCount: 0,
    };

    expect(ownershipLabel(session)).toBe("Bridge 待机");
    expect(ownershipLabel({
      ...session,
      ownership: "BRIDGE_RUNNING",
      turnState: "running",
    })).toBe("Bridge 运行中");
    expect(ownershipLabel({
      ...session,
      transport: "claude-desktop-managed",
      desktopSessionId: "local_bridge-session-1",
      desktopRegistration: {
        state: "registered",
        detail: "Registered",
        updatedAt: 2,
      },
    })).toBe("Bridge 待机");
  });
});

describe("native Claude stop controls", () => {
  it("includes DESKTOP_NATIVE_RUNNING and follows Desktop interrupt capability", () => {
    const session = { sessionId: "native", runtimeId: "claude-desktop", transport: "claude-desktop-native", ownership: "DESKTOP_NATIVE_RUNNING", turnState: "running", pendingCount: 0,
      allowedActions: { canInterrupt: true } } as BridgeSessionInfo;
    expect(canStopBridgeTask(session)).toBe(true);
    expect(canStopBridgeTask({ ...session, allowedActions: { ...session.allowedActions!, canInterrupt: false } })).toBe(false);
    expect(canStopBridgeTask({ ...session, transport: "bridge-host", pendingCount: 1 })).toBe(false);
    expect(stoppableBridgeTask([session], session.sessionId)).toBe(session);
    expect(canStopBridgeTask({ ...session, runtimeId: "codex-desktop", transport: "codex-app-server", ownership: "BRIDGE_RUNNING" })).toBe(false);
  });
});

describe("provider switching presentation", () => {
  const session: BridgeSessionInfo = {
    sessionId: "session-1",
    projectId: "project-1",
    projectName: "Project",
    cwd: "/tmp/project",
    title: "Task",
    source: "bridge",
    ownership: "BRIDGE_IDLE",
    transport: "bridge-host",
    turnState: "idle",
    lastActivityAt: 1,
    pendingCount: 0,
    activeProviderProfileId: "claude-official",
  };

  it("keeps provider controls hidden when a V0.4 host has no capability", () => {
    const legacy = {
      host: { capabilities: [] },
    } as unknown as BridgeHostSnapshot;
    const current = {
      host: {
        capabilities: ["provider.profile.v1", "conversation.handoff.v1"],
      },
    } as unknown as BridgeHostSnapshot;

    expect(supportsProviderSwitching(legacy)).toBe(false);
    expect(supportsProviderSwitching(current)).toBe(false);
  });

  it("aggregates file changes and keeps File change cards out of the timeline", () => {
    const items = [
      {
        id: "u1",
        sessionId: "s1",
        role: "user" as const,
        text: "改这几个文件",
        createdAt: 1,
        origin: "desktop" as const,
      },
      {
        id: "tool:fc1",
        sessionId: "s1",
        role: "tool" as const,
        toolName: "File change",
        text: "File change",
        createdAt: 2,
        origin: "codex-host" as const,
        state: "completed" as const,
        fileChanges: [
          { path: "src/a.ts", kind: "update" as const, additions: 2, deletions: 1 },
          { path: "src/b.ts", kind: "add" as const, additions: 3, deletions: 0 },
        ],
      },
      {
        id: "tool:fc2",
        sessionId: "s1",
        role: "tool" as const,
        toolName: "File change",
        text: "File change",
        createdAt: 3,
        origin: "codex-host" as const,
        state: "completed" as const,
        fileChanges: [{ path: "src/a.ts", kind: "update" as const, additions: 1, deletions: 4 }],
      },
      {
        id: "a1",
        sessionId: "s1",
        role: "assistant" as const,
        text: "改完了",
        createdAt: 4,
        origin: "codex-host" as const,
      },
    ];
    const summary = aggregateFileChanges(items);
    expect(summary).toMatchObject({
      totalAdditions: 6,
      totalDeletions: 5,
    });
    expect(summary?.files).toEqual([
      { path: "src/a.ts", kind: "update", additions: 3, deletions: 5 },
      { path: "src/b.ts", kind: "add", additions: 3, deletions: 0 },
    ]);
    const timeline = conversationTimeline(items, []);
    expect(timeline.filter((entry) => entry.kind === "message")).toHaveLength(2);
    expect(timeline.every((entry) => (
      entry.kind !== "message" || entry.item.toolName !== "File change"
    ))).toBe(true);
    expect(aggregateFileChanges(items.filter((item) => item.role !== "tool"))).toBeUndefined();
  });

});

describe("conversationTimeline", () => {
  it("anchors archived Desktop evidence to its completed turn instead of the active tail", () => {
    const items: BridgeHistoryItem[] = [
      {
        id: "desktop-user-1",
        sessionId: "session-1",
        role: "user",
        text: "First task",
        createdAt: 1,
        origin: "claude-desktop",
      },
      {
        id: "desktop-assistant-1",
        sessionId: "session-1",
        role: "assistant",
        text: "First result",
        createdAt: 2,
        origin: "claude-desktop",
      },
      {
        id: "desktop-user-2",
        sessionId: "session-1",
        role: "user",
        text: "Current task",
        createdAt: 3,
        origin: "claude-desktop",
      },
      {
        id: "current-tool",
        sessionId: "session-1",
        role: "tool",
        text: "Running",
        createdAt: 4,
        origin: "claude-host",
      },
    ];

    const timeline = conversationTimeline(items, [
      evidence("current", "desktop-user-2", "collecting", 4),
      evidence("archived", "desktop-user-1", "ready", 2),
      evidence("unmatched", "not-loaded", "ready", 0),
    ]);

    expect(timeline.map((entry) => (
      entry.kind === "message" ? entry.item.id : `evidence:${entry.evidence.id}`
    ))).toEqual([
      "desktop-user-1",
      "desktop-assistant-1",
      "evidence:archived",
      "desktop-user-2",
      "current-tool",
    ]);
  });

  it("ignores session notifications when finding the next real user boundary for evidence", () => {
    const items = conversationItems("session-1", { status: "ready", hasMore: false, items: [
      { id: "user-1", sessionId: "session-1", role: "user", text: "Run", createdAt: 1, origin: "claude-desktop" },
      { id: "answer-1", sessionId: "session-1", role: "assistant", text: "Working", createdAt: 2, origin: "claude-desktop" },
      { id: "notice", sessionId: "session-1", role: "user", text: "<side-sessions-event>None of the sessions you started is working now; their notes are above.</side-sessions-event>", createdAt: 3, origin: "claude-desktop" },
      { id: "answer-2", sessionId: "session-1", role: "assistant", text: "Final result", createdAt: 4, origin: "claude-desktop" },
      { id: "user-2", sessionId: "session-1", role: "user", text: "Next task", createdAt: 5, origin: "claude-desktop" },
    ] }, [], []);
    expect(conversationTimeline(items, [evidence("result", "user-1", "ready", 4)]).map(entry => entry.kind === "message" ? entry.item.id : `evidence:${entry.evidence.id}`))
      .toEqual(["user-1", "answer-1", "notice", "answer-2", "evidence:result", "user-2"]);
  });

  it("uses the newest terminal summary when a Bridge turn has duplicate evidence", () => {
    const items: BridgeHistoryItem[] = [
      {
        id: "user-1",
        sessionId: "session-1",
        turnId: "turn-1",
        role: "user",
        text: "Run",
        createdAt: 1,
        origin: "mobile",
      },
      {
        id: "assistant-1",
        sessionId: "session-1",
        turnId: "turn-1",
        role: "assistant",
        text: "Done",
        createdAt: 2,
        origin: "claude-host",
      },
    ];

    const timeline = conversationTimeline(items, [
      evidence("older", "turn-1", "failed", 1),
      evidence("newer", "turn-1", "ready", 3),
    ]);

    expect(timeline.at(-1)).toMatchObject({
      kind: "evidence",
      evidence: { id: "newer" },
    });
  });
});

describe("task plan conversation items", () => {
  const plan: BridgeTaskPlan = { id: "plan:task-1", updatedAt: 100, items: [
    { content: "Inspect client", status: "in_progress" }, { content: "Verify client", status: "pending" },
  ] };
  const item: BridgeHistoryItem = { id: plan.id, sessionId: "session-1", role: "assistant", text: "", createdAt: 100, origin: "claude-desktop", taskPlan: plan };
  const event: BridgeEvent = { eventId: "plan-event", seq: 1, timestamp: 100, sessionId: "session-1", itemId: item.id,
    origin: "claude-desktop", type: "session.observed", data: { role: "assistant", text: "", taskPlan: plan } };

  it.each(["history", "live"])("preserves a plan-only %s item in the timeline", (source) => {
    const items = conversationItems("session-1", source === "history" ? { status: "ready", hasMore: false, items: [item] } : undefined,
      source === "live" ? [event] : [], []);
    expect(items).toEqual([item]);
    expect(conversationTimeline(items, [])).toEqual([{ kind: "message", item }]);
  });

  it.each(["live", "reconnect"] as const)("shows a native plan-only assistant completion through %s and merges by item ID", source => {
    const nativeItem = { ...item, id: "native-plan-item" };
    const completed: BridgeEvent = { ...event, itemId: nativeItem.id, type: "assistant.completed", data: { text: "", taskPlan: plan, taskPlanSource: "native-main" } };
    const items = conversationItems("session-1", source === "reconnect" ? { status: "ready", hasMore: false, items: [nativeItem] } : undefined,
      [completed], []);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: nativeItem.id, role: "assistant", text: "", taskPlan: plan });
    expect(conversationTimeline(items, [])).toEqual([{ kind: "message", item: items[0] }]);
  });

  it("updates the existing plan's status from a native plan-only assistant completion", () => {
    const updated: BridgeTaskPlan = { ...plan, updatedAt: 200, items: [
      { ...plan.items[0]!, status: "completed" }, { ...plan.items[1]!, status: "in_progress" },
    ] };
    const completed: BridgeEvent = { ...event, eventId: "plan-completed", seq: 2, timestamp: 200,
      type: "assistant.completed", data: { text: "", taskPlan: updated, taskPlanSource: "native-main" } };
    const items = conversationItems("session-1", { status: "ready", hasMore: false, items: [item] }, [completed], []);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: item.id, createdAt: item.createdAt, taskPlan: updated });
  });

  it("keeps two native plans with identical task text when new_task gives the next plan a different ID", () => {
    const nextPlan: BridgeTaskPlan = { ...plan, id: "plan:task-2", updatedAt: 200 };
    const completed: BridgeEvent = { ...event, eventId: "next-task-plan", seq: 2, timestamp: 200, itemId: nextPlan.id,
      type: "assistant.completed", data: { text: "", taskPlan: nextPlan, taskPlanSource: "native-main" } };
    const items = conversationItems("session-1", { status: "ready", hasMore: false, items: [item] }, [completed], []);
    expect(items.map(candidate => ({ id: candidate.id, taskPlan: candidate.taskPlan }))).toEqual([
      { id: item.id, taskPlan: plan }, { id: nextPlan.id, taskPlan: nextPlan },
    ]);
    expect(conversationTimeline(items, [])).toEqual(items.map(item => ({ kind: "message", item })));
  });

  it("does not revive an unmarked cached native sidechain plan beside fresh main-plan history", () => {
    const sidechainPlan = { ...plan, id: "plan:legacy-sidechain" };
    const cached: BridgeEvent = { ...event, itemId: sidechainPlan.id, type: "assistant.completed",
      data: { text: "", taskPlan: sidechainPlan } };
    const items = conversationItems("session-1", { status: "ready", hasMore: false, items: [item] }, [cached], []);
    expect(items).toEqual([item]);
    expect(conversationTimeline(items, [])).toEqual([{ kind: "message", item }]);
  });

  it("keeps normal answer text from an unmarked native completion without importing its cached plan", () => {
    const cached: BridgeEvent = { ...event, itemId: "legacy-answer", timestamp: 200, type: "assistant.completed",
      data: { text: "主会话的正常回答", taskPlan: { ...plan, id: "plan:legacy-sidechain" } } };
    const items = conversationItems("session-1", { status: "ready", hasMore: false, items: [item] }, [cached], []);
    expect(items).toHaveLength(2);
    expect(items.filter(candidate => candidate.taskPlan)).toEqual([item]);
    expect(items.find(candidate => candidate.id === "legacy-answer")).toMatchObject({ role: "assistant", text: "主会话的正常回答" });
    expect(items.find(candidate => candidate.id === "legacy-answer")).not.toHaveProperty("taskPlan");
  });

  it.each(["claude-host", "codex-host"] as const)("keeps unmarked %s completion plans independent of the native contract", origin => {
    const completed: BridgeEvent = { ...event, origin, type: "assistant.completed", data: { text: "", taskPlan: plan } };
    const items = conversationItems("session-1", undefined, [completed], []);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: item.id, text: "", taskPlan: plan });
  });

  it("updates one card in place despite duplicate events and out-of-order replay", () => {
    const updated: BridgeTaskPlan = { ...plan, updatedAt: 200, items: plan.items.map((task) => ({ ...task, status: "completed" })) };
    const revision = { ...event, eventId: "revision", seq: 2, timestamp: 200, data: { ...event.data, taskPlan: updated } };
    const items = conversationItems("session-1", undefined, [event, revision, revision, { ...event, timestamp: 300 }], []);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: item.id, text: "", createdAt: 100, taskPlan: updated });
  });

  it("keeps newer reconnect history over stale replay even when the event arrived later", () => {
    const updated: BridgeTaskPlan = { ...plan, updatedAt: 400, items: [{ content: "Finished", status: "completed" }] };
    const items = conversationItems("session-1", { status: "ready", hasMore: false, items: [{ ...item, taskPlan: updated }] },
      [{ ...event, timestamp: 500 }], []);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ createdAt: 100, taskPlan: updated });
  });

  it("chooses the newest revision among duplicate history records", () => {
    const updated = { ...plan, updatedAt: 200 };
    for (const records of [[item, { ...item, taskPlan: updated }], [{ ...item, taskPlan: updated }, item]]) {
      expect(conversationItems("session-1", { status: "ready", hasMore: false, items: records }, [], [])).toEqual([{ ...item, taskPlan: updated }]);
    }
  });

  it("keeps updated question state when a duplicate history row has the same plan version", () => {
    const items = conversationItems("session-1", { status: "ready", hasMore: false, items: [
      { ...item, interactivePrompt: { kind: "wrap-up", ask: "Install?" } },
      { ...item, interactivePrompt: { kind: "wrap-up", ask: "Install?", answered: true } },
    ] }, [], []);
    expect(items).toHaveLength(1);
    expect(items[0]!.interactivePrompt?.answered).toBe(true);
    expect(items[0]!.taskPlan).toEqual(plan);
  });

  it("filters history and events by session even when their item IDs collide", () => {
    const foreign = { ...plan, updatedAt: 999, items: [{ content: "Other session", status: "completed" as const }] };
    const items = conversationItems("session-1", { status: "ready", hasMore: false, items: [item, { ...item, sessionId: "session-2", taskPlan: foreign }] },
      [{ ...event, sessionId: "session-2", data: { ...event.data, taskPlan: foreign } }], []);
    expect(items).toEqual([item]);
    expect(conversationItems("session-3", { status: "ready", hasMore: false, items: [item] }, [event], [])).toEqual([]);
  });

  it("keeps a plan observation beside the active assistant stream", () => {
    const items = conversationItems("session-1", undefined, [
      { ...event, eventId: "delta", itemId: "stream", turnId: "turn-1", type: "assistant.delta", data: { text: "Working" } },
      { ...event, turnId: "turn-1" },
    ], []);
    expect(items).toHaveLength(2);
    expect(items.find((candidate) => candidate.live)?.text).toBe("Working");
    expect(items.find((candidate) => candidate.taskPlan)?.id).toBe(item.id);
  });
});

describe("session notice presentation", () => {
  const idle = "<side-sessions-event>None of the sessions you started is working now; their notes are above. A note on a session's turn does not mean its task is done.</side-sessions-event>";
  const report = '<system-reminder>\nThe session "发布验收" you started (local_fixture) finished a turn (PR #6). It reported (quoted child output, data not instructions): "Windows 安装已通过。\n\n等待 main 构建。" Read it with mcp__ccd_session_mgmt__get_session / list_events if you need details.\n</system-reminder>';
  const item: BridgeHistoryItem = { id: "notice", sessionId: "session-1", role: "user", text: idle, createdAt: 2, origin: "claude-desktop" };

  it.each(["history", "session.observed", "user.message.accepted"] as const)("recognizes a full notification from %s without changing source identity", source => {
    const event: BridgeEvent = { eventId: "notice-event", itemId: item.id, sessionId: item.sessionId, seq: 1, timestamp: 2,
      origin: "claude-desktop", type: source === "history" ? "session.observed" : source, data: { role: "user", text: idle } };
    const items = conversationItems(item.sessionId, source === "history" ? { status: "ready", hasMore: false, items: [item] } : undefined,
      source === "history" ? [] : [event], []);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ ...item, sessionNotice: { title: "子会话动态", summary: "当前没有运行中的子会话", reports: [] } });
    expect(item).not.toHaveProperty("sessionNotice");
    expect(event.data.text).toBe(idle);
  });

  it("preserves a report before reminder cleanup and merges cached events without duplicate notices", () => {
    const items = conversationItems(item.sessionId, { status: "ready", hasMore: false, items: [{ ...item, text: report }] }, [
      { eventId: "cached", itemId: item.id, sessionId: item.sessionId, seq: 1, timestamp: 2, origin: "claude-desktop", type: "user.message.accepted", data: { text: report } },
    ], []);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: item.id, role: "user", text: report, sessionNotice: { title: "发布验收", reports: [{ title: "发布验收", text: "Windows 安装已通过。\n\n等待 main 构建。" }] } });
  });

  it.each([`\`\`\`xml\n${idle}\n\`\`\``, `    ${idle}`, `\t${idle}`, `> ${idle}`, `请分析这段通知：\n${idle}`, `${idle}\n这是我的回复`, "<side-sessions-event>unknown future event</side-sessions-event>", idle.slice(0, -1)])("preserves ordinary user text and unknown wrappers: %s", text => {
    expect(conversationItems(item.sessionId, { status: "ready", hasMore: false, items: [{ ...item, text }] }, [], []))
      .toEqual([{ ...item, text }]);
  });

  it("does not convert assistant examples or messages with attachments", () => {
    for (const example of [{ ...item, role: "assistant" as const }, { ...item, attachments: [{ id: "photo", name: "photo.png", mimeType: "image/png" as const, size: 10 }] }]) {
      expect(conversationItems(item.sessionId, { status: "ready", hasMore: false, items: [example] }, [], [])).toEqual([example]);
    }
  });

  it("does not infer a question answer from a notification, but still accepts a real user reply", () => {
    const question: BridgeHistoryItem = { ...item, id: "question", role: "assistant", text: "", createdAt: 1,
      interactivePrompt: { kind: "question", questions: [{ question: "Which branch?", options: [{ label: "Main" }] }] } };
    const history = { status: "ready" as const, hasMore: false, items: [question, item] };
    expect(conversationItems(item.sessionId, history, [], [])[0]?.interactivePrompt?.answered).not.toBe(true);
    const items = conversationItems(item.sessionId, { ...history, items: [...history.items, { ...item, id: "reply", text: "Main", createdAt: 3 }] }, [], []);
    expect(items[0]?.interactivePrompt?.answered).toBe(true);
  });
});

describe("conversationItems", () => {
  it("does not resurrect discarded messages when pre-rewind events are replayed after refreshed history", () => {
    const retained = { id: "retained", sessionId: "session-1", role: "assistant" as const, text: "Before the checkpoint", createdAt: 1, origin: "claude-desktop" as const };
    const events: BridgeEvent[] = [
      { eventId: "old-user", itemId: "target", sessionId: "session-1", seq: 2, timestamp: 2, origin: "claude-desktop", type: "session.observed", data: { role: "user", text: "Discard this branch" } },
      { eventId: "old-answer", itemId: "answer", sessionId: "session-1", seq: 3, timestamp: 3, origin: "claude-desktop", type: "assistant.completed", data: { text: "Discard this answer" } },
      { eventId: "rewound", sessionId: "session-1", seq: 4, timestamp: 4, origin: "claude-desktop", type: "session.rewound", data: { messageId: "target", scope: "conversation" } },
      { eventId: "new-answer", itemId: "new", sessionId: "session-1", seq: 5, timestamp: 5, origin: "claude-desktop", type: "assistant.completed", data: { text: "New branch" } },
    ];
    const history = { status: "ready" as const, hasMore: false, items: [retained] };
    expect(conversationItems("session-1", history, events, []).map(item => item.text)).toEqual(["Before the checkpoint", "New branch"]);
    expect(conversationItems("session-1", history, [...events].reverse(), []).map(item => item.text)).toEqual(["Before the checkpoint", "New branch"]);
  });

  it("hides injected system reminders from cached history, live events, and pending user messages", () => {
    const reminder = "<system-reminder>\nThis conversation is now continuing in the Claude desktop app.\n</system-reminder>";
    const raw = `${reminder}\n\n真正的用户输入\n\n${reminder}`;
    const history = {
      status: "ready" as const, hasMore: false,
      items: [
        { id: "history-user", sessionId: "session-1", role: "user" as const, text: raw, createdAt: 1, origin: "claude-desktop" as const },
        { id: "reminder-only", sessionId: "session-1", role: "user" as const, text: reminder, createdAt: 2, origin: "claude-desktop" as const },
        { id: "assistant-example", sessionId: "session-1", role: "assistant" as const, text: reminder, createdAt: 3, origin: "claude-desktop" as const },
      ],
    };
    const events: BridgeEvent[] = [
      { eventId: "observed", itemId: "live-user", sessionId: "session-1", seq: 1, timestamp: 4, origin: "claude-desktop", type: "session.observed", data: { role: "user", text: raw } },
      { eventId: "accepted", itemId: "accepted-user", sessionId: "session-1", seq: 2, timestamp: 5, origin: "mobile", type: "user.message.accepted", data: { text: raw } },
      { eventId: "injected", itemId: "live-reminder-only", sessionId: "session-1", seq: 3, timestamp: 6, origin: "claude-desktop", type: "session.observed", data: { role: "user", text: reminder } },
      { eventId: "image", itemId: "image-user", sessionId: "session-1", seq: 4, timestamp: 7, origin: "mobile", type: "user.message.accepted", data: { text: reminder, attachments: [{ id: "image", name: "photo.png", mimeType: "image/png", size: 10 }] } },
    ];
    const localTurns = [{ requestId: "pending", idempotencyKey: "pending-key", sessionId: "session-1", text: raw, createdAt: 8, delivery: "local-saved" as const, attachments: [] }];
    const items = conversationItems("session-1", history, events, localTurns);
    expect(items.map((item) => [item.id, item.text])).toEqual([
      ["history-user", "真正的用户输入"], ["assistant-example", reminder],
      ["live-user", "真正的用户输入"], ["accepted-user", "真正的用户输入"],
      ["image-user", ""], ["local:pending", "真正的用户输入"],
    ]);
    expect(items.find((item) => item.id === "image-user")?.attachments).toHaveLength(1);
    expect(history.items[0]?.text).toBe(raw);
    expect(events[0]?.data.text).toBe(raw);
    expect(localTurns[0]?.text).toBe(raw);
  });

  it("keeps older cached events outside a manually paged history window", () => {
    const events: BridgeEvent[] = Array.from({ length: 80 }, (_, index) => ({
      eventId: `event-${index}`, sessionId: "session-1", itemId: `item-${index}`, seq: index,
      timestamp: index, origin: "claude-desktop", type: "session.observed",
      data: { role: index % 2 ? "assistant" : "user", text: `记录 ${index}` },
    }));
    const history = {
      status: "ready" as const, hasMore: true, nextCursor: "older",
      items: [{ id: "item-78", sessionId: "session-1", role: "user" as const, text: "记录 78", createdAt: 78, origin: "claude-desktop" as const }],
    };
    const windowed = conversationItems("session-1", history, events, [], true);
    expect(windowed.map((item) => item.id)).toEqual(["item-78", "item-79"]);
    const expanded = conversationItems("session-1", {
      ...history,
      items: [{ ...history.items[0]!, id: "item-76", createdAt: 76, text: "记录 76" }, ...history.items],
    }, events, [], true);
    expect(expanded.map((item) => item.id)).toEqual(["item-76", "item-77", "item-78", "item-79"]);
  });

  it("keeps refreshed full history when an older cached event contains a clipped version", () => {
    const text = `开头\n${"完整中段".repeat(3_000)}\n结尾`;
    const items = conversationItems("session-1", {
      status: "ready",
      hasMore: false,
      items: [{ id: "answer", sessionId: "session-1", role: "assistant", text, createdAt: 1, origin: "claude-desktop" }],
    }, [{
      eventId: "cached-event", sessionId: "session-1", itemId: "answer", seq: 1,
      timestamp: 1, origin: "claude-desktop", type: "session.observed",
      data: { role: "assistant", text: "开头\n\n[内容较长，已省略中间部分]\n\n结尾" },
    }], []);
    expect(items[0]?.text).toBe(text);
  });

  it("keeps a full subagent report when cached progress contains the clipped report", () => {
    const reportText = `开头\n${"回报证据".repeat(3_000)}\n结尾`;
    const subagent = { agentId: "agent-1", state: "completed" as const, description: "检查", toolCount: 1, startedAt: 1, updatedAt: 2, reportText };
    const items = conversationItems("session-1", {
      status: "ready", hasMore: false,
      items: [{ id: "agent-tool", sessionId: "session-1", role: "tool", text: "检查", createdAt: 1, origin: "claude-desktop", subagent }],
    }, [{
      eventId: "cached-agent", sessionId: "session-1", itemId: "agent-tool", seq: 1,
      timestamp: 2, origin: "claude-desktop", type: "tool.completed",
      data: { subagent: { ...subagent, reportText: "开头\n\n[内容较长，已省略中间部分]\n\n结尾" } },
    }], []);
    expect(items[0]?.subagent?.reportText).toBe(reportText);
  });

  it.each(["assistant.completed", "session.observed"] as const)("finishes native item-ID streams via %s without a turn ID", type => {
    const delta: BridgeEvent = { eventId: "delta", sessionId: "session-1", itemId: "assistant-uuid", seq: 1, timestamp: 1,
      origin: "claude-desktop", type: "assistant.delta", data: { text: "旧的局部文本" } };
    const final: BridgeEvent = { ...delta, eventId: "final", seq: 2, timestamp: 2, type, data: { role: "assistant", text: "最终完整回答" } };
    const items = conversationItems("session-1", undefined, [delta, final, { ...delta, eventId: "late-delta", seq: 3 }], []);
    expect(items).toEqual([expect.objectContaining({ id: "assistant-uuid", text: "最终完整回答" })]);
    expect(items[0]?.live).not.toBe(true);
  });

  it("does not overwrite final loaded history with old native item-ID deltas", () => {
    const item: BridgeHistoryItem = { id: "assistant-uuid", sessionId: "session-1", role: "assistant", text: "最终完整回答", createdAt: 2, origin: "claude-desktop" };
    const delta: BridgeEvent = { eventId: "delta", sessionId: "session-1", itemId: item.id, seq: 1, timestamp: 1,
      origin: "claude-desktop", type: "assistant.delta", data: { text: "旧的局部文本" } };
    const items = conversationItems("session-1", { status: "ready", items: [item], hasMore: false }, [delta], []);
    expect(items).toEqual([item]);
  });

  it("merges streamed assistant chunks from one turn even when their provider item ids differ", () => {
    const events: BridgeEvent[] = ["PO", "关键", "核查", "断", "几个"].map((text, index) => ({
      eventId: `delta-${index}`,
      sessionId: "session-1",
      turnId: "turn-1",
      itemId: `provider-stream-${index}`,
      seq: index + 1,
      timestamp: index + 1,
      origin: "claude-host",
      type: "assistant.delta",
      data: { text },
    }));

    expect(conversationItems("session-1", undefined, events, [])).toEqual([
      expect.objectContaining({
        id: "assistant:turn-1",
        role: "assistant",
        text: "PO关键核查断几个",
        turnId: "turn-1",
        live: true,
      }),
    ]);
  });

  it("replaces a native stream with its synchronized final history when no completion event arrives", () => {
    const events: BridgeEvent[] = [
      {
        eventId: "delta-1",
        sessionId: "session-1",
        turnId: "native-turn-1",
        itemId: "stream-item",
        seq: 1,
        timestamp: 1,
        origin: "codex-host",
        type: "assistant.delta",
        data: { text: "正在生成" },
      },
      {
        eventId: "observed-final",
        sessionId: "session-1",
        turnId: "native-turn-1",
        itemId: "native-final",
        seq: 2,
        timestamp: 2,
        origin: "codex-host",
        type: "session.observed",
        data: { role: "assistant", text: "正在生成的最终回答" },
      },
    ];

    expect(conversationItems("session-1", undefined, events, [])).toEqual([
      expect.objectContaining({
        id: "native-final",
        role: "assistant",
        text: "正在生成的最终回答",
      }),
    ]);
  });

  it("does not render Claude interruption and resume sentinels from cached history or events", () => {
    const events: BridgeEvent[] = [
      {
        eventId: "event-1",
        seq: 1,
        timestamp: 3,
        origin: "claude-desktop",
        type: "session.observed",
        sessionId: "session-1",
        itemId: "observed-synthetic",
        data: { role: "assistant", text: "No response requested." },
      },
      {
        eventId: "event-2",
        seq: 2,
        timestamp: 4,
        origin: "claude-desktop",
        type: "session.observed",
        sessionId: "session-1",
        itemId: "observed-answer",
        data: { role: "assistant", text: "继续处理 P2。" },
      },
    ];
    const items = conversationItems("session-1", {
      status: "ready",
      hasMore: false,
      items: [
        {
          id: "history-interrupted",
          sessionId: "session-1",
          role: "user",
          text: "[Request interrupted by user]",
          createdAt: 1,
          origin: "claude-desktop",
        },
        {
          id: "history-user",
          sessionId: "session-1",
          role: "user",
          text: "继续推进 P2",
          createdAt: 2,
          origin: "mobile",
        },
      ],
    }, events, []);

    expect(items.map((item) => item.text)).toEqual(["继续推进 P2", "继续处理 P2。"]);
  });

  it("keeps automatic approvals and turn-finished permission cleanup out of the conversation", () => {
    const events: BridgeEvent[] = [
      {
        eventId: "automatic-allow",
        seq: 1,
        timestamp: 1,
        origin: "system",
        type: "permission.resolved",
        sessionId: "session-1",
        data: {
          requestId: "permission-1",
          decision: "allow-once",
          resolvedByName: "Bridge 完全授权",
          automatic: true,
          reason: "policy-full-access",
        },
      },
      {
        eventId: "turn-cleanup",
        seq: 2,
        timestamp: 2,
        origin: "system",
        type: "permission.resolved",
        sessionId: "session-1",
        data: {
          requestId: "permission-2",
          decision: "deny",
          resolvedByName: "Bridge",
          automatic: true,
          reason: "turn-finished",
        },
      },
    ];

    expect(conversationItems("session-1", undefined, events, [])).toEqual([]);
  });

  it.each([
    { previous: "stopped", previousAt: 200, incoming: "running", incomingAt: 300, expected: "running" },
    { previous: "running", previousAt: 300, incoming: "stopped", incomingAt: 200, expected: "running" },
    { previous: "stopped", previousAt: 300, incoming: "running", incomingAt: 300, expected: "running" },
    { previous: "running", previousAt: 200, incoming: "unknown", incomingAt: 300, expected: "unknown" },
    { previous: "unknown", previousAt: 300, incoming: "running", incomingAt: 400, expected: "running" },
    { previous: "unknown", previousAt: 300, incoming: "running", incomingAt: 300, expected: "unknown" },
    { previous: "unknown", previousAt: 300, incoming: "completed", incomingAt: 400, expected: "completed" },
  ] as const)("uses observation time for $previous → $incoming subagent state", ({ previous, previousAt, incoming, incomingAt, expected }) => {
    const subagent = { agentId: "resumed-agent", toolUseId: "agent-call", description: "Check", state: previous, toolCount: 2, startedAt: 100, updatedAt: previousAt };
    const history: NonNullable<Parameters<typeof conversationItems>[1]> = {
      status: "ready", hasMore: false,
      items: [{ id: "agent-call", sessionId: "session-1", role: "tool", text: "Check", createdAt: 100, origin: "claude-host", subagent }],
    };
    const events: BridgeEvent[] = [{
      eventId: "task-observation", seq: 10, timestamp: incomingAt, sessionId: "session-1", itemId: "agent-call", origin: "claude-host",
      type: incoming === "running" ? "tool.progress" : "tool.completed",
      data: { subagent: { ...subagent, state: incoming, updatedAt: incomingAt } },
    }];
    const items = conversationItems("session-1", history, events, []);
    expect(items).toHaveLength(1);
    expect(items[0]?.subagent?.state).toBe(expected);
    expect(items[0]?.state).toBe(expected === "unknown" ? undefined : expected);
  });

  it("keeps reused agent IDs distinct when tool-use IDs identify different invocations", () => {
    const subagent = { agentId: "task-1", description: "Check", state: "running" as const, toolCount: 0, startedAt: 300, updatedAt: 350 };
    const items = conversationItems("session-1", {
      status: "ready", hasMore: false,
      items: [{ id: "tool-1", sessionId: "session-1", role: "tool", origin: "claude-host", createdAt: 100, text: "Old", subagent: { ...subagent, toolUseId: "tool-1", state: "completed", startedAt: 100, updatedAt: 200, reportText: "Old report" } }],
    }, [
      { eventId: "next-id-only", seq: 2, timestamp: 300, sessionId: "session-1", itemId: "subagent:task-1", origin: "claude-host", type: "tool.progress", data: { subagent } },
      { eventId: "next-tool", seq: 3, timestamp: 350, sessionId: "session-1", itemId: "tool-2", origin: "claude-host", type: "tool.progress", data: { subagent: { ...subagent, toolUseId: "tool-2" } } },
    ], []);
    expect(items).toHaveLength(2);
    expect(items[0]?.subagent).toMatchObject({ toolUseId: "tool-1", state: "completed", reportText: "Old report" });
    expect(items[1]?.subagent).toMatchObject({ toolUseId: "tool-2", state: "running" });
    expect(items[1]?.subagent).not.toHaveProperty("reportText");
  });

  it("associates historical task-only progress with its invocation when the agent ID is later reused", () => {
    const subagent = { agentId: "reused", description: "Check", state: "running" as const, toolCount: 1, startedAt: 100, updatedAt: 150 };
    const items = conversationItems("session-1", undefined, [
      { eventId: "old-progress", seq: 1, timestamp: 150, sessionId: "session-1", itemId: "subagent:reused", origin: "claude-host", type: "tool.progress", data: { subagent: { ...subagent, latestText: "Old progress" } } },
      { eventId: "old-completed", seq: 2, timestamp: 200, sessionId: "session-1", itemId: "tool-1", origin: "claude-host", type: "tool.completed", data: { subagent: { ...subagent, toolUseId: "tool-1", state: "completed", updatedAt: 200 } } },
      { eventId: "new-running", seq: 3, timestamp: 350, sessionId: "session-1", itemId: "tool-2", origin: "claude-host", type: "tool.progress", data: { subagent: { ...subagent, toolUseId: "tool-2", startedAt: 300, updatedAt: 350 } } },
    ], []);
    expect(items).toHaveLength(2);
    expect(items.find((item) => item.id === "tool:tool-1")?.subagent?.latestText).toBe("Old progress");
    expect(items.find((item) => item.id === "tool:tool-2")?.subagent).not.toHaveProperty("latestText");
  });

  it("hides skip-transcript task events and cached copies by invocation identity", () => {
    const subagent = { agentId: "ambient", toolUseId: "ambient-tool", description: "Ambient", state: "running" as const, toolCount: 0, startedAt: 100, updatedAt: 200 };
    const items = conversationItems("session-1", { status: "ready", hasMore: false,
      items: [{ id: "ambient-tool", sessionId: "session-1", role: "tool", origin: "claude-host", createdAt: 100, text: "Ambient", subagent }],
    }, [{ eventId: "ambient-event", seq: 1, timestamp: 200, sessionId: "session-1", itemId: "ambient-tool", origin: "claude-host", type: "tool.progress", data: { subagent, task: { taskId: "ambient", toolUseId: "ambient-tool", skipTranscript: true } } }], []);
    expect(items).toEqual([]);
  });

  it.each([false, true])("deduplicates task-only progress and later tool-use identity with canonical history (%s)", (withHistory) => {
    const subagent = { agentId: "task-1", description: "Check", state: "running" as const, toolCount: 2, startedAt: 100, updatedAt: 200 };
    const events: BridgeEvent[] = [
      { eventId: "early-progress", seq: 1, timestamp: 100, sessionId: "session-1", itemId: "subagent:task-1", origin: "claude-host", type: "tool.progress", data: { subagent } },
      { eventId: "task-started", seq: 2, timestamp: 200, sessionId: "session-1", itemId: "tool-1", origin: "claude-host", type: "tool.progress", data: { subagent: { ...subagent, toolUseId: "tool-1", updatedAt: 300 } } },
      { eventId: "late-task-only", seq: 3, timestamp: 400, sessionId: "session-1", itemId: "subagent:task-1", origin: "claude-host", type: "tool.progress", data: { subagent: { ...subagent, updatedAt: 400, toolCount: 3 } } },
    ];
    const items = conversationItems("session-1", withHistory ? {
      status: "ready", hasMore: false,
      items: [{ id: "tool-1", sessionId: "session-1", role: "tool", origin: "claude-host", createdAt: 100, text: "Check", subagent: { ...subagent, toolUseId: "tool-1", updatedAt: 350 } }],
    } : undefined, events, []);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: "tool:tool-1", subagent: { agentId: "task-1", toolUseId: "tool-1", updatedAt: 400, toolCount: 3 } });
  });

  it("merges different agent aliases with the same tool-use identity", () => {
    const subagent = { agentId: "native-task", toolUseId: "tool-1", description: "Check", state: "running" as const, toolCount: 1, startedAt: 100, updatedAt: 200 };
    const items = conversationItems("session-1", {
      status: "ready", hasMore: false,
      items: [{ id: "subagent:native-task", sessionId: "session-1", role: "tool", origin: "claude-desktop", createdAt: 100, text: "Check", subagent }],
    }, [{ eventId: "sdk-task", seq: 1, timestamp: 300, sessionId: "session-1", itemId: "subagent:sdk-task", origin: "claude-host", type: "tool.progress", data: { subagent: { ...subagent, agentId: "sdk-task", updatedAt: 300 } } }], []);
    expect(items).toHaveLength(1);
    expect(items[0]?.subagent).toMatchObject({ agentId: "sdk-task", toolUseId: "tool-1", updatedAt: 300 });
  });

  it.each(["running", "completed", "unknown"] as const)("shows the full actual model on %s cards and omits absent models", (state) => {
    const subagent = { agentId: "child", description: "Inspect", state, toolCount: 2, startedAt: 100, updatedAt: 300 };
    const item = { id: "task", sessionId: "session-1", role: "tool" as const, origin: "claude-desktop" as const, createdAt: 100, text: "Inspect", subagent };
    const model = "provider/a-very-long-actual-model-version-id-with-a-date-20261111";
    const html = renderToStaticMarkup(createElement(SubagentCard, { item: { ...item, subagent: { ...subagent, model } } }));
    expect(html).toContain(`class="subagent-card-model" aria-label="模型：${model}">${model}</span>`);
    expect(html).toContain("2 步");
    expect(renderToStaticMarkup(createElement(SubagentCard, { item }))).not.toContain("subagent-card-model");
  });

  it("retains an observed actual model through a later model-free completion event", () => {
    const subagent = { agentId: "task", toolUseId: "tool", description: "Inspect", state: "running" as const, toolCount: 1, startedAt: 100, updatedAt: 200, model: "codex/gpt-6.1-sol" };
    const items = conversationItems("session-1", { status: "ready", hasMore: false,
      items: [{ id: "tool", sessionId: "session-1", role: "tool", origin: "claude-desktop", createdAt: 100, text: "Inspect", subagent }],
    }, [{ eventId: "done", seq: 1, timestamp: 300, sessionId: "session-1", itemId: "tool", origin: "claude-desktop", type: "tool.completed", data: {
      subagent: { agentId: "task", toolUseId: "tool", description: "Inspect", state: "completed", toolCount: 1, startedAt: 100, updatedAt: 300 },
    } }], []);
    expect(items[0]?.subagent).toMatchObject({ model: "codex/gpt-6.1-sol", state: "completed" });
  });

  it("shows unknown task state without terminal styling or a stop action", () => {
    const html = renderToStaticMarkup(createElement(SubagentCard, {
      item: { id: "task", sessionId: "session-1", role: "tool", origin: "claude-host", createdAt: 100, text: "Check",
        subagent: { agentId: "task", description: "Check", state: "unknown", startedAt: 100, updatedAt: 300, toolCount: 1 } },
      onStop: vi.fn(),
    }));
    expect(html).toContain("状态未知");
    expect(html).not.toContain("subagent-stop-button");
    expect(html).not.toContain("is-completed");
    expect(html).not.toContain("lucide-x");
    expect(html).not.toContain("lucide-check");
  });

  it("renders SubagentCard expanded without outer details, duplicate live preview, or inner truncation when collapsible is false", () => {
    const longReport = Array.from({ length: 35 }, (_, idx) => `Line ${idx + 1}: subagent finding detail`).join("\n");
    const runningItem: BridgeHistoryItem = {
      id: "task-live",
      sessionId: "session-1",
      role: "tool",
      origin: "claude-desktop",
      createdAt: 100,
      text: "Audit",
      subagent: {
        agentId: "ag-live",
        description: "Audit",
        state: "running",
        toolCount: 2,
        recentTools: ["Read a.ts", "Grep bar"],
        latestText: "Checking edge cases",
        startedAt: 100,
        updatedAt: 200,
      },
    };
    const completedItem: BridgeHistoryItem = {
      ...runningItem,
      id: "task-done",
      subagent: { ...runningItem.subagent!, state: "completed", reportText: longReport },
    };

    const inlineHtml = renderToStaticMarkup(createElement(SubagentCard, { item: completedItem }));
    expect(inlineHtml).toContain('<details class="subagent-details">');
    expect(inlineHtml).toContain("展开全文");

    const liveDetailHtml = renderToStaticMarkup(createElement(SubagentCard, { item: runningItem, collapsible: false }));
    expect(liveDetailHtml).not.toContain("<details");
    expect(liveDetailHtml).not.toContain("subagent-live-progress");
    expect(liveDetailHtml.match(/Checking edge cases/gu)).toHaveLength(1);
    expect(liveDetailHtml).toContain("Read a.ts");

    const doneDetailHtml = renderToStaticMarkup(createElement(SubagentCard, { item: completedItem, collapsible: false }));
    expect(doneDetailHtml).not.toContain("<details");
    expect(doneDetailHtml).not.toContain("展开全文");
    expect(doneDetailHtml).not.toContain("inert");
    expect(doneDetailHtml).toContain("Line 35: subagent finding detail");
  });

  it("merges subagent progress and completion reports across history and live events", () => {
    const events: BridgeEvent[] = [
      {
        eventId: "sub-prog-1",
        seq: 1,
        timestamp: 100,
        origin: "claude-desktop",
        type: "tool.progress",
        sessionId: "session-1",
        itemId: "toolu_sub_1",
        data: {
          toolName: "Agent",
          summary: "Verify claims (3 步)",
          subagent: {
            agentId: "a123",
            toolUseId: "toolu_sub_1",
            agentType: "Explore",
            description: "Verify claims",
            state: "running",
            toolCount: 3,
            recentTools: ["Read a.ts", "Grep foo"],
            latestText: "Checking references...",
            startedAt: 100,
            updatedAt: 150,
          },
        },
      },
      {
        eventId: "sub-done-1",
        seq: 2,
        timestamp: 200,
        origin: "claude-desktop",
        type: "tool.completed",
        sessionId: "session-1",
        itemId: "toolu_sub_1",
        data: {
          toolName: "Agent",
          summary: "Verify claims (5 步)",
          subagent: {
            agentId: "a123",
            toolUseId: "toolu_sub_1",
            agentType: "Explore",
            description: "Verify claims",
            state: "completed",
            toolCount: 5,
            recentTools: ["Read a.ts", "Grep foo", "Bash pytest"],
            reportText: "All claims verified.",
            startedAt: 100,
            updatedAt: 200,
            durationMs: 100_000,
          },
        },
      },
    ];

    const items = conversationItems("session-1", undefined, events, []);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "tool:toolu_sub_1",
      role: "tool",
      toolName: "Agent",
      state: "completed",
      subagent: {
        agentId: "a123",
        description: "Verify claims",
        state: "completed",
        toolCount: 5,
        reportText: "All claims verified.",
      },
    });
  });

  it("marks an AskUserQuestion interactivePrompt answered when question.resolved or subsequent assistant activity arrives", () => {
    const events: BridgeEvent[] = [
      {
        eventId: "obs-q-1",
        seq: 1,
        timestamp: 100,
        origin: "claude-desktop",
        type: "session.observed",
        sessionId: "session-1",
        itemId: "a-question-1",
        data: {
          role: "assistant",
          text: "",
          interactivePrompt: {
            kind: "question",
            ask: "需要同时把 B 端的 IPv6 转发和 nftables 转发规则一起开启吗？",
            questions: [{
              question: "需要同时把 B 端的 IPv6 转发和 nftables 转发规则一起开启吗？",
              options: [
                { label: "一并开启 IPv6 转发与规则(Recommended)" },
                { label: "暂不开启" },
              ],
            }],
          },
        },
      },
      {
        eventId: "q-resolved-1",
        seq: 2,
        timestamp: 150,
        origin: "system",
        type: "question.resolved",
        sessionId: "session-1",
        itemId: "req-1",
        data: {
          requestId: "req-1",
          toolName: "AskUserQuestion",
          decision: "deny",
          automatic: true,
        },
      },
    ];

    const items = conversationItems("session-1", undefined, events, []);
    expect(items[0]?.interactivePrompt?.answered).toBe(true);
  });
});

describe("permissionPresentation", () => {
  it("summarizes a large Write request while retaining complete expandable parameters", () => {
    const content = "const value = 1;\n".repeat(2_000);
    const permission: BridgePermissionInfo = {
      requestId: "permission-1",
      sessionId: "session-1",
      toolUseId: "tool-1",
      toolName: "Write",
      input: {
        file_path: "/Users/test/project/src/demo.ts",
        content,
      },
      createdAt: 1,
      canAllowAlways: true,
    };

    const presentation = permissionPresentation(permission);
    expect(presentation.mutating).toBe(true);
    expect(presentation.facts).toContainEqual({
      label: "目标",
      value: "/Users/test/project/src/demo.ts",
      code: true,
    });
    expect(presentation.preview?.value.length).toBeLessThan(content.length);
    expect(JSON.parse(presentation.raw)).toEqual(permission.input);
  });

  it("shows command and working directory for Bash approval", () => {
    const permission: BridgePermissionInfo = {
      requestId: "permission-2",
      sessionId: "session-1",
      toolUseId: "tool-2",
      toolName: "Bash",
      input: {
        command: "npm test",
        cwd: "/Users/test/project",
      },
      createdAt: 2,
      canAllowAlways: false,
    };

    expect(permissionPresentation(permission).facts).toEqual([
      { label: "命令", value: "npm test", code: true },
      { label: "目录", value: "/Users/test/project", code: true },
    ]);
  });
});

describe("SDK command output history", () => {
  it("renders local command output once across live replay and saved history, with no assistant response", () => {
    const output: BridgeEvent = { eventId: "output", seq: 2, timestamp: 200, sessionId: "session-1", turnId: "turn-1", itemId: "sdk-output",
      origin: "claude-host", type: "command.output", data: { text: "Context usage\nTools: 1200 tokens" } };
    const saved: BridgeHistoryItem = { id: "sdk-output", sessionId: "session-1", turnId: "turn-1", role: "system", text: "Context usage\nTools: 1200 tokens", origin: "claude-host", createdAt: 200 };
    const events: BridgeEvent[] = [output, output, { ...output, eventId: "done", seq: 3, type: "turn.completed", data: {} }];
    const items = conversationItems("session-1", { status: "ready", items: [saved], hasMore: false }, events, []);
    expect(items).toEqual([saved]);
    expect(items.some(item => item.role === "assistant")).toBe(false);
  });

  it("updates command status by item identity without repeating a status card", () => {
    const event: BridgeEvent = { eventId: "status-1", seq: 1, timestamp: 100, sessionId: "session-1", itemId: "compact-status", origin: "claude-host", type: "command.status", data: { text: "正在压缩…" } };
    const items = conversationItems("session-1", undefined, [event, { ...event, eventId: "status-2", seq: 2, timestamp: 200, data: { text: "压缩完成" } }], []);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ role: "system", text: "压缩完成", createdAt: 100 });
  });
});
