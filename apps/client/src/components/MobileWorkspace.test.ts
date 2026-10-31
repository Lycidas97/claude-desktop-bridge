import type {
  BridgeEvent,
  BridgeEvidenceBundle,
  BridgeHistoryItem,
  BridgeHostSnapshot,
  BridgePermissionInfo,
  BridgeSessionInfo,
} from "@bridge/protocol";
import { type ComponentProps, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  MobileWorkspace,
  aggregateFileChanges,
  canConfigureSession,
  canStopBridgeTask,
  conversationItems,
  conversationTimeline,
  goalStatusLabel,
  ownershipLabel,
  permissionPresentation,
  restorableSessionId,
  sessionProfile,
  stoppableBridgeTask,
  supportsProviderSwitching,
  supportsRuntimeHandoff,
  usesOfficialComposer,
} from "./MobileWorkspace.js";

describe("mobile workspace directory", () => {
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
      onRefreshProviders: vi.fn(), onPreviewRuntimeHandoff: vi.fn(), onCommitRuntimeHandoff: vi.fn(), onConfirmRuntimeHandoff: vi.fn(), onCancelRuntimeHandoff: vi.fn(), onGetRuntimeHandoff: vi.fn(),
      onPauseRuntimeGoal: vi.fn(), onResumeRuntimeGoal: vi.fn(), onDesktopAppAction: vi.fn(), onRefresh: vi.fn(), onBackToHosts: vi.fn(), onRetry: vi.fn(),
    };
  }

  it("opens on the directory with an archive page entry and closed action menus", () => {
    const props = workspaceProps();
    const html = renderToStaticMarkup(createElement(MobileWorkspace, props));
    expect(html).toContain('<h1>会话</h1>');
    expect(html).toContain('aria-label="当前电脑：My computer，查看电脑"');
    expect(html).toContain('aria-label="目录更多"');
    expect(html).toContain("Visible session");
    expect(html).toContain("已归档会话");
    expect(html).not.toContain("Archived session");
    expect(html).not.toContain("desktop-agents-drawer");
    expect(html).not.toContain('aria-label="强制同步"');
    expect(html).not.toContain('role="dialog"');
    expect(props.onOpenSession).not.toHaveBeenCalled();
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

  it("offers configuration according to session runtime capabilities", () => {
    expect(canConfigureSession(session)).toBe(true);
    expect(canConfigureSession({ ...session, allowedActions: { canConfigure: false } as NonNullable<BridgeSessionInfo["allowedActions"]> })).toBe(false);
    expect(canConfigureSession({ ...session, runtimeId: "codex-desktop" })).toBe(false);
    expect(canConfigureSession({ ...session, runtimeId: "codex-desktop", allowedActions: { canConfigure: true } as NonNullable<BridgeSessionInfo["allowedActions"]> })).toBe(true);
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

describe("canStopBridgeTask", () => {
  const session = (overrides: Partial<BridgeSessionInfo>): BridgeSessionInfo => ({
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
    ...overrides,
  });

  it("keeps stop available for queued and uncertain Bridge work", () => {
    expect(canStopBridgeTask(session({
      turnState: "queued",
      pendingCount: 1,
    }))).toBe(true);
    expect(canStopBridgeTask(session({
      ownership: "DESKTOP_MANAGED_RUNNING",
      transport: "claude-desktop-managed",
      turnState: "waiting",
      pendingCount: 1,
    }))).toBe(true);
  });

  it("does not offer Bridge stop for an idle or native observed Desktop turn", () => {
    expect(canStopBridgeTask(session({}))).toBe(false);
    expect(canStopBridgeTask(session({
      ownership: "DESKTOP_OBSERVED",
      turnState: "running",
    }))).toBe(false);
  });

  it("finds a recovered blocker even when a native Desktop turn is selected", () => {
    const native = session({
      sessionId: "desktop-current",
      ownership: "DESKTOP_OBSERVED",
      turnState: "running",
    });
    const recovered = session({
      sessionId: "recovered-queue",
      source: "bridge",
      ownership: "BRIDGE_IDLE",
      turnState: "queued",
      pendingCount: 1,
    });

    expect(stoppableBridgeTask([native, recovered], native.sessionId)?.sessionId)
      .toBe(recovered.sessionId);
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
    expect(supportsProviderSwitching(current)).toBe(true);
  });

  it("gates the runtime relay entry on the host capability and labels goal states", () => {
    expect(supportsRuntimeHandoff(undefined)).toBe(false);
    expect(supportsRuntimeHandoff({
      host: { capabilities: [] },
    } as never)).toBe(false);
    expect(supportsRuntimeHandoff({
      host: { capabilities: ["runtime.handoff.v1"] },
    } as never)).toBe(true);
    expect(goalStatusLabel("active")).toBe("goal 执行中");
    expect(goalStatusLabel("paused")).toBe("goal 已暂停");
    expect(goalStatusLabel("blocked")).toBe("goal 受阻");
    expect(goalStatusLabel("complete")).toBe("goal 已完成");
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

  it("replaces the writable composer for a Claude official lane", () => {
    expect(usesOfficialComposer(session, [{
      id: "claude-official",
      kind: "claude-official",
      name: "Claude 官方",
      status: "ready",
      detail: "Read-only",
      configured: true,
      localOnlyConfiguration: false,
      readOnly: true,
      models: [],
    }])).toBe(true);
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

describe("conversationItems", () => {
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
