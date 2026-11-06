import type {
  BridgeEvent,
  BridgeEvidenceBundle,
  BridgeHistoryItem,
  BridgeHostSnapshot,
  BridgePermissionInfo,
  BridgeSessionInfo,
  BridgeTaskPlan,
} from "@bridge/protocol";
import { type ComponentProps, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyEventToTurns, mergeBridgeEvents, type LocalTurn } from "../hooks/useMobileBridge.js";
import {
  MobileWorkspace,
  SubagentCard,
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
      onRefreshProviders: vi.fn(), onPreviewRuntimeHandoff: vi.fn(), onCommitRuntimeHandoff: vi.fn(), onConfirmRuntimeHandoff: vi.fn(), onCancelRuntimeHandoff: vi.fn(), onGetRuntimeHandoff: vi.fn(),
      onPauseRuntimeGoal: vi.fn(), onResumeRuntimeGoal: vi.fn(), onDesktopAppAction: vi.fn(), onRefresh: vi.fn(), onBackToHosts: vi.fn(), onRetry: vi.fn(),
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

  it("offers configuration according to session runtime capabilities", () => {
    expect(canConfigureSession(session)).toBe(true);
    expect(canConfigureSession({ ...session, allowedActions: { canConfigure: false } as NonNullable<BridgeSessionInfo["allowedActions"]> })).toBe(false);
    expect(canConfigureSession({ ...session, runtimeId: "codex-desktop" })).toBe(false);
    expect(canConfigureSession({ ...session, runtimeId: "codex-desktop", allowedActions: { canConfigure: true } as NonNullable<BridgeSessionInfo["allowedActions"]> })).toBe(true);
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
