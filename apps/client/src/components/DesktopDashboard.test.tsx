import type { BridgeHistoryItem, BridgePermissionInfo, BridgeSessionInfo, DesktopControlSnapshot } from "@bridge/protocol";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopDashboard } from "./DesktopDashboard.js";
import { MediaPreviewProvider } from "./evidence/MediaPreviewProvider.js";
import { ConfirmationDialog } from "./common/ConfirmationDialog.js";
import { ComposerAttachmentMenu, FileAttachmentPicker } from "./evidence/FileAttachmentPicker.js";
import { IconButton } from "./common/IconButton.js";
import { BackgroundTaskMarker, BackgroundTasksSheet } from "./conversation/BackgroundTasks.js";
import { ConversationMessageItem } from "./conversation/ConversationMessageItem.js";
import { ConversationToolGroup } from "./conversation/ConversationToolGroup.js";
import { ForkChainBar } from "./conversation/ForkChainBar.js";
import { InteractivePromptCard, PermissionPrompt } from "./conversation/PermissionPrompts.js";
import { SlashCommandInput } from "./conversation/SlashCommandInput.js";
import { SessionCommandDialogs } from "./conversation/SessionCommandDialogs.js";
import { SessionRewindDialog } from "./conversation/SessionRewindDialog.js";
import { SessionNoticeCard } from "./conversation/SessionNoticeCard.js";
import { SessionPrActions, SessionPrBar } from "./conversation/SessionPrBar.js";
import { SubagentCard } from "./conversation/SubagentCard.js";
import { EmptyState } from "./common/EmptyState.js";
import { ProjectGroupHeader } from "./session/ProjectGroupHeader.js";
import { SessionFamilyList } from "./session/SessionFamilyList.js";
import { SessionProfileSummary } from "./session/SessionProfileSummary.js";
import { ProjectOrderSheet } from "./mobile/ProjectOrderSheet.js";
import { Sheet } from "./common/Sheet.js";

type HookStore = {
  slots: any[]; index: number; dirty: boolean;
  effects: Array<{ deps: unknown[] | undefined; cleanup: (() => void) | undefined }>;
  effectIndex: number; pending: Array<() => void>;
};
const hooks = vi.hoisted(() => ({ current: undefined as HookStore | undefined }));
function recordEffect(effect: () => (() => void) | void, deps?: unknown[]) {
  const store = hooks.current!;
  const index = store.effectIndex++;
  const previous = store.effects[index];
  if (previous && deps && deps.length === previous.deps?.length && deps.every((value, i) => Object.is(value, previous.deps?.[i]))) return;
  store.pending.push(() => {
    previous?.cleanup?.();
    store.effects[index] = { deps, cleanup: effect() || undefined };
  });
}
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState(initial: any) {
    const store = hooks.current!;
    const index = store.index++;
    if (!(index in store.slots)) store.slots[index] = typeof initial === "function" ? initial() : initial;
    return [store.slots[index], (value: any) => {
      const next = typeof value === "function" ? value(store.slots[index]) : value;
      if (!Object.is(next, store.slots[index])) store.dirty = true;
      store.slots[index] = next;
    }];
  },
  useRef(initial: unknown) {
    const store = hooks.current!;
    const index = store.index++;
    store.slots[index] ??= { current: initial };
    return store.slots[index];
  },
  useMemo: (create: () => unknown) => create(),
  useContext: () => undefined,
  useEffect: recordEffect,
  useLayoutEffect: recordEffect,
}));
const mailContext = vi.hoisted(() => ({ current: undefined as any }));
vi.mock("./assistant/AssistantMailProvider.js", async (original) => ({
  ...await original<typeof import("./assistant/AssistantMailProvider.js")>(),
  useAssistantMail: () => mailContext.current,
}));
vi.mock("./evidence/MediaPreviewProvider.js", async original => ({ ...await original<typeof import("./evidence/MediaPreviewProvider.js")>(), useMediaPreview: () => vi.fn() }));
vi.mock("../lib/file-upload.js", async (original) => ({
  ...await original<typeof import("../lib/file-upload.js")>(),
  uploadSessionFile: vi.fn(),
}));
vi.mock("../lib/artifact-download.js", async (original) => ({
  ...await original<typeof import("../lib/artifact-download.js")>(),
  downloadBridgeSessionFile: vi.fn(),
}));

function elements(node: ReactNode): ReactElement<Record<string, any>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Record<string, any>>;
  const children = (
    element.type === EmptyState
    || element.type === ProjectGroupHeader
    || element.type === SessionFamilyList
    || element.type === SessionProfileSummary
    || element.type === ConversationMessageItem
    || element.type === ConversationToolGroup
    || element.type === ForkChainBar
  )
    ? (element.type as (props: any) => ReactNode)(element.props)
    : element.props.children;
  return [element, ...elements(children)];
}
const stores: HookStore[] = [];
function renderer(component: (props: any) => ReactNode, initialProps: any) {
  const store: HookStore = { slots: [], index: 0, dirty: false, effects: [], effectIndex: 0, pending: [] };
  stores.push(store);
  let props = initialProps;
  let tree: ReactNode;
  return {
    draw(nextProps = props) {
      props = nextProps;
      for (let i = 0; i < 12; i++) {
        hooks.current = store; store.dirty = false; store.index = 0; store.effectIndex = 0;
        tree = component(props);
        store.pending.splice(0).forEach((effect) => effect());
        if (!store.dirty) return tree;
      }
      throw new Error("Component did not settle");
    },
  };
}
async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

let snapshot: DesktopControlSnapshot;
let history: BridgeHistoryItem[];
let apiRequest: ReturnType<typeof vi.fn>;
let tree: ReactNode;
let sessions: ReturnType<typeof renderer>;
let dashboard: ReturnType<typeof renderer>;
let sessionsProps: any;
beforeEach(() => {
  const session: BridgeSessionInfo = {
    sessionId: "A", title: "Session A", projectId: "project", projectName: "Project", cwd: "/tmp/project",
    source: "desktop", ownership: "DESKTOP_NATIVE_IDLE", transport: "claude-desktop-native", turnState: "idle", lastActivityAt: 1, pendingCount: 0,
    allowedActions: { canSend: true, canSteer: true, canInterrupt: true, canConfigure: true, canSwitchProvider: false, canContinueOfficial: false },
  };
  snapshot = {
    host: { hostId: "computer", name: "Computer", capabilities: ["claude.native-relay.v1"], pairingEpoch: 1, relayUrl: "", online: true, lastSeenAt: 1, version: "1.0.3" },
    sessions: [session], projects: [{ projectId: "project", name: "Project", cwd: "/tmp/project", sessionCount: 1, runningCount: 0, pendingCount: 0, lastActivityAt: 1 }],
    devices: [], permissions: [], latestSeq: 0,
    runtime: { state: "ready", detail: "Ready", activeTurns: 0, maxParallelTurns: 2, desktopIntegration: { state: "not-managed", detail: "Unavailable", enabled: false, canRestart: false } },
    connection: "connected", launchAtLogin: false, diagnosticsEnabled: false, managedDesktopEnabled: false,
    claudeDesktop: { state: "stopped", detail: "Stopped", canLaunch: true, canQuit: false },
  };
  const saved = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => saved.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => saved.set(key, value)),
  });
  history = [];
  apiRequest = vi.fn(async ({ method }) => ({ kind: "response", requestId: "test", ok: true, result:
    method === "session.open" ? { history: { items: history, hasMore: false } }
      : method === "evidence.list" ? { evidence: { items: [], hasMore: false } } : {},
  }));
  vi.stubGlobal("window", { bridgeDesktop: {
    getSnapshot: async () => snapshot, onSnapshot: () => () => undefined, onEvent: () => () => undefined, request: apiRequest,
  } });
});
afterEach(() => {
  mailContext.current = undefined;
  stores.splice(0).forEach((store) => store.effects.forEach((effect) => effect.cleanup?.()));
  vi.unstubAllGlobals();
});
async function openSessions() {
  dashboard = renderer(DesktopDashboard, {
    themeControl: { theme: "dark", family: "apple", setTheme: vi.fn(), setFamily: vi.fn(), toggleTheme: vi.fn() },
    agentVisibility: { enabled: ["claude-desktop"], setEnabled: vi.fn() },
  });
  dashboard.draw(); await settle();
  const child = elements(dashboard.draw()).find((element) => typeof element.type === "function" && element.type.name === "DesktopSessions")!;
  sessionsProps = child.props;
  sessions = renderer(child.type as (props: any) => ReactNode, sessionsProps);
  sessions.draw(); await settle(); tree = sessions.draw();
  apiRequest.mockClear();
}
function questionPermission(requestId: string, question: string, sessionId = "A"): BridgePermissionInfo {
  return { requestId, sessionId, toolUseId: `tool-${requestId}`, toolName: "AskUserQuestion", createdAt: 1, canAllowAlways: false,
    input: { questions: [{ question, options: [{ label: "Main" }, { label: "Feature" }] }] } };
}

function textContent(node: ReactNode): string {
  return elements(node).flatMap(element => element.props.children).filter(child => typeof child === "string").join(" ");
}

describe("desktop session header", () => {
  it.each([false, true])("keeps observed settings visible when configuration is available=%s", async canConfigure => {
    Object.assign(snapshot.sessions[0]!, { model: "model-id", modelDisplayName: "Claude Opus 5.5 custom model", effort: "high", nativePermissionMode: "auto" });
    snapshot.sessions[0]!.allowedActions!.canConfigure = canConfigure;
    await openSessions();
    expect(textContent(tree).replace(/\s+/gu, " ")).toContain("Claude Opus 5.5 custom model · 自动模式 · reasoning high");
    expect(elements(tree).some(element => element.props["aria-label"] === "会话设置")).toBe(canConfigure);
    const updated = { ...snapshot, sessions: [{ ...snapshot.sessions[0]!, nativePermissionMode: "dontAsk" as const }] };
    tree = sessions.draw({ ...sessionsProps, snapshot: updated });
    expect(textContent(tree).replace(/\s+/gu, " ")).toContain("Claude Opus 5.5 custom model · 不询问 · reasoning high");
    expect(apiRequest).not.toHaveBeenCalled();
  });
});

describe("desktop session PR disclosure", () => {
  it("opens no-PR preferences and routes reads and writes through the desktop API", async () => {
    snapshot.host.capabilities.push("pr.autofix.v1");
    snapshot.runtime.desktopIntegration.state = "ready";
    await openSessions();
    const trigger = elements(tree).find(element => element.type === IconButton && element.props.label === "PR Auto-fix");
    expect(trigger).toBeDefined();
    trigger!.props.onClick();
    tree = sessions.draw();
    const actions = elements(tree).find(element => element.type === SessionPrActions)!;
    expect(actions.props.session.sessionId).toBe("A");
    expect(actions.props.online).toBe(true);
    actions.props.onWriteBusyChange(true);
    tree = sessions.draw();
    expect(elements(tree).find(element => element.type === Sheet)!.props.busy).toBe(true);
    actions.props.onWriteBusyChange(false);
    tree = sessions.draw();
    expect(elements(tree).find(element => element.type === Sheet)!.props.busy).toBe(false);
    const state = { sessionId: "A", prs: [], onlyOwnPrs: true, nextOwnPrArmed: false,
      capabilities: { bound: true, onlyOwnPrs: true, nextPr: true, checks: true } };
    apiRequest.mockResolvedValue({ kind: "response", requestId: "pr", ok: true, result: state });
    await expect(actions.props.onRead("A", undefined, false)).resolves.toEqual(state);
    expect(apiRequest).toHaveBeenLastCalledWith({ method: "pr.autoFix.read", params: { sessionId: "A", includeChecks: false } });
    const refresh = vi.fn().mockResolvedValue(undefined);
    tree = sessions.draw({ ...sessionsProps, onRefreshSnapshot: refresh });
    await elements(tree).find(element => element.type === SessionPrActions)!.props.onSet({ sessionId: "A", target: "own-prs", enabled: true });
    expect(apiRequest).toHaveBeenLastCalledWith({ method: "pr.autoFix.set", params: { sessionId: "A", target: "own-prs", enabled: true } });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("hides the header bar for a session without PRs even when Auto-fix is supported", async () => {
    snapshot.host.capabilities.push("pr.autofix.v1");
    await openSessions();
    expect(elements(tree).filter(element => element.type === SessionPrBar)).toHaveLength(0);
  });

  it("keeps the header bar for a session with a PR on an older host", async () => {
    snapshot.sessions[0]!.prs = [{ repo: "owner/project", prNumber: 42, url: "https://github.com/owner/project/pull/42", state: "OPEN" }];
    await openSessions();
    expect(elements(tree).find(element => element.type === SessionPrBar)!.props.supported).toBe(false);
  });
});

describe("desktop file stat capability", () => {
  it.each([false, true])("uses the snapshot capability when supported=%s regardless of version", async supported => {
    snapshot.host.version = "1.3.1";
    if (supported) snapshot.host.capabilities.push("artifact.transfer.stat.v1");
    await openSessions();
    expect(elements(dashboard.draw()).find(element => element.type === MediaPreviewProvider)!.props.supportsFileStat).toBe(supported);
  });
});

describe("session notice presentation", () => {
  it.each([
    ["<side-sessions-event>None of the sessions you started is working now; their notes are above.</side-sessions-event>", "子会话动态"],
    ['<ci-monitor-event>"Auto-fix pull requests" was just enabled for this session.</ci-monitor-event>', "Claude Desktop · CI 监控"],
  ])("uses the shared compact card instead of user rewind controls: %s", async (text, title) => {
    snapshot.host.capabilities.push("session.rewind.v1");
    history = [{ id: "notice", sessionId: "A", role: "user", text, createdAt: 1, origin: "claude-desktop" }];
    await openSessions();
    const cards = elements(tree).filter(element => element.type === SessionNoticeCard);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.props.source).toBe(text);
    expect(cards[0]!.props.itemId).toBe("notice");
    expect(cards[0]!.props.notice.title).toBe(title);
    expect(elements(tree).filter(element => element.props["aria-label"] === "回退到这条消息之前")).toHaveLength(0);
    expect(apiRequest).not.toHaveBeenCalled();
  });
});

describe("successful rewind completion", () => {
  it.each(["rejects", "pending"])("returns the Native prefill without waiting for a snapshot refresh that %s", async mode => {
    snapshot.host.capabilities.push("session.rewind.v1");
    history = [{ id: "rewind-user", sessionId: "A", role: "user", text: "Original request", createdAt: 1, origin: "claude-desktop" }];
    await openSessions();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const refresh = vi.fn(() => mode === "pending" ? held : Promise.reject(new Error("Snapshot refresh disconnected")));
    tree = sessions.draw({ ...sessionsProps, onRefreshSnapshot: refresh });
    elements(tree).find(element => element.props["aria-label"] === "回退到这条消息之前")!.props.onClick();
    tree = sessions.draw();
    const dialog = elements(tree).find(element => element.type === SessionRewindDialog)!;
    const rewind = { sessionId: "A", messageId: "rewind-user", scope: "conversation", prefill: "Original request" };
    apiRequest.mockResolvedValueOnce({ kind: "response", requestId: "rewind", ok: true, result: { rewind } });
    let outcome: unknown;
    const completion = dialog.props.onRewind("rewind-user", "conversation").then((result: unknown) => { outcome = { result }; }, (error: unknown) => { outcome = { error }; });
    try {
      await settle();
      expect(outcome).toEqual({ result: rewind });
      expect(refresh).not.toHaveBeenCalled();
      dialog.props.onComplete(rewind); tree = sessions.draw();
      expect(elements(tree).find(element => element.type === SlashCommandInput)!.props.value).toBe("Original request");
      expect(elements(tree).some(element => element.type === SessionRewindDialog)).toBe(false);
      expect(apiRequest).toHaveBeenCalledExactlyOnceWith({ method: "session.rewind", params: { sessionId: "A", messageId: "rewind-user", scope: "conversation" } });
    } finally { release(); await completion; }
  });
});

describe("desktop session deletion confirmation", () => {
  it.each(["claude-desktop", "codex-desktop", "hermes-desktop", "dsh-desktop"] as const)("describes the actual deletion target for %s without deleting on review", async runtimeId => {
    snapshot.host.capabilities.push("session.visibility.v1");
    await openSessions();
    const session = { ...snapshot.sessions[0]!, runtimeId, transport: runtimeId === "claude-desktop" ? "claude-desktop-native" as const : "bridge-host" as const };
    tree = sessions.draw({ ...sessionsProps, snapshot: { ...snapshot, sessions: [session] } });
    elements(tree).find(element => element.type === IconButton && element.props.label === "删除会话")!.props.onClick();
    tree = sessions.draw();
    const confirmation = elements(tree).find(element => element.type === ConfirmationDialog && element.props.title === "删除会话")!;
    expect(confirmation.props.open).toBe(true);
    if (runtimeId === "claude-desktop") {
      expect(confirmation.props.description).toContain("从 Claude Desktop 中删除「Session A」会话");
      expect(confirmation.props.description).not.toContain("原生会话与文件不受影响");
      expect(confirmation.props.description).not.toContain("从 Bridge 列表中删除");
    } else {
      expect(confirmation.props.description).toBe("从 Bridge 列表中删除「Session A」？对应 Desktop 应用中的原生会话与文件不受影响；Bridge 中的会话配置、排队与授权记录会被清除，此操作不可恢复。");
    }
    expect(confirmation.props.description).toContain("此操作不可恢复");
    confirmation.props.onCancel();
    expect(apiRequest.mock.calls.some(([request]) => request.method === "session.delete")).toBe(false);
  });
});

describe("desktop custom command input", () => {
  const input = () => elements(tree).find(element => element.type === SlashCommandInput)!;

  it("loads the selected logical session through the read-only RPC and changes text without sending", async () => {
    snapshot.host.capabilities = ["claude.native-relay.v1", "session.commands.v1"];
    await openSessions();
    const catalog = { sessionId: "A", commands: [{ name: "review", description: "检查变更" }] };
    apiRequest.mockResolvedValueOnce({ kind: "response", requestId: "commands", ok: true, result: { catalog } });
    await expect(input().props.onLoad()).resolves.toEqual(catalog);
    expect(apiRequest).toHaveBeenCalledExactlyOnceWith({ method: "session.commands", params: { sessionId: "A" } });
    input().props.onChange("/review "); tree = sessions.draw();
    expect(input().props.value).toBe("/review ");
    expect(apiRequest).toHaveBeenCalledOnce();
    elements(tree).find(element => element.type === "form" && element.props.className.startsWith("composer-form"))!.props.onSubmit({ preventDefault() {} });
    await settle();
    expect(apiRequest).toHaveBeenLastCalledWith(expect.objectContaining({ method: "turn.start", params: { sessionId: "A", text: "/review", attachments: [] } }));
  });

  it("propagates catalog errors and changes the widget identity across hosts and sessions", async () => {
    snapshot.host.capabilities = ["claude.native-relay.v1", "session.commands.v1"];
    snapshot.sessions.push({ ...snapshot.sessions[0]!, sessionId: "B", title: "Session B" });
    await openSessions();
    apiRequest.mockResolvedValueOnce({ kind: "response", requestId: "commands", ok: false, error: { code: "READ_FAILED", message: "命令目录不可读" } });
    await expect(input().props.onLoad()).rejects.toThrow("命令目录不可读");
    const firstKey = input().key;
    elements(tree).find(element => element.type === "button" && element.props.className === "session-row-hit" && textContent(element).includes("Session B"))!.props.onClick();
    tree = sessions.draw();
    expect(input().key).not.toBe(firstKey);
    const secondKey = input().key;
    tree = sessions.draw({ ...sessionsProps, snapshot: { ...snapshot, host: { ...snapshot.host, hostId: "other-computer" } } });
    expect(input().key).not.toBe(secondKey);
  });

  it("shows active and stalled background subagent state dot and label in desktop session rows when main turn is idle", async () => {
    const now = Date.now();
    snapshot.sessions[0]!.turnState = "idle";
    snapshot.sessions[0]!.runningSubagents = { count: 1, lastUpdatedAt: now - 10_000 };
    await openSessions();
    const row = () => elements(tree).find(element => element.type === "button" && element.props.className === "session-row-hit" && textContent(element).includes("Session A"))!;
    expect(elements(row()).find(element => String(element.props.className).startsWith("session-state-dot"))?.props.className).toBe("session-state-dot running");
    expect(textContent(row())).toContain("后台子代理");

    snapshot.sessions[0]!.runningSubagents = { count: 1, lastUpdatedAt: now - 11 * 60_000 };
    tree = sessions.draw({ ...sessionsProps, snapshot: { ...snapshot, sessions: [...snapshot.sessions] } });
    expect(elements(row()).find(element => String(element.props.className).startsWith("session-state-dot"))?.props.className).toBe("session-state-dot queued");
    expect(textContent(row())).toContain("子代理无进展");
  });

  it.each(["old-host", "codex-desktop", "hermes-desktop", "dsh-desktop"] as const)("keeps ordinary text input for %s", async runtime => {
    if (runtime !== "old-host") {
      snapshot.host.capabilities = ["claude.native-relay.v1", "session.commands.v1"];
      snapshot.sessions[0]!.runtimeId = runtime;
    }
    await openSessions();
    if (runtime !== "old-host") {
      // This renderer tests DesktopSessions directly; visibility is a separate dashboard concern.
      tree = sessions.draw({ ...sessionsProps, snapshot });
      await settle(); tree = sessions.draw(); apiRequest.mockClear();
    }
    expect(input().props.onLoad).toBeUndefined();
    input().props.onChange("/ordinary"); tree = sessions.draw();
    expect(input().props.value).toBe("/ordinary");
    expect(apiRequest).not.toHaveBeenCalled();
  });
});

describe("desktop empty creation", () => {
  it("enables the creation entry without any historical project", async () => {
    snapshot.sessions = []; snapshot.projects = [];
    await openSessions();
    const create = elements(tree).find(element => element.type === IconButton && element.props.label === "新建会话")!;
    expect(create.props.disabled).not.toBe(true);
    create.props.onClick(); tree = sessions.draw();
    expect(elements(tree).some(element => typeof element.type === "function" && element.type.name === "SessionCreateDialog")).toBe(true);
  });
});

describe("desktop shared catalog", () => {
  it.each(["ready", "not-managed"] as const)("distinguishes an empty catalog with Desktop %s and keeps creation", async state => {
    snapshot.sessions = []; snapshot.projects = [];
    snapshot.runtime.desktopIntegration.state = state;
    await openSessions();
    expect(textContent(tree)).toContain(state === "ready" ? "暂无活跃会话" : "未检测到 Claude Desktop");
    const empty = elements(tree).find(element => element.type === EmptyState)!;
    elements(empty).find(element => element.type === "button" && textContent(element).includes("新建会话"))!.props.onClick();
    tree = sessions.draw();
    expect(elements(tree).some(element => typeof element.type === "function" && element.type.name === "SessionCreateDialog")).toBe(true);
  });

  it("keeps archived sessions accessible when no active session remains", async () => {
    snapshot.host.capabilities.push("session.visibility.v1");
    snapshot.runtime.desktopIntegration.state = "ready";
    snapshot.sessions[0]!.archivedAt = 100;
    await openSessions();
    expect(textContent(tree)).toContain("暂无活跃会话");
    elements(tree).find(element => element.props["aria-controls"] === "desktop-archived-sessions")!.props.onClick();
    tree = sessions.draw();
    expect(elements(tree).filter(element => element.props.className === "session-row-hit")).toHaveLength(1);
    expect(textContent(elements(tree).find(element => element.props.className === "session-row-hit")!)).toContain("已归档");
  });

  it("prioritizes pending questions over running turns and background subagents", async () => {
    snapshot.sessions[0]!.turnState = "running";
    snapshot.sessions[0]!.runningSubagents = { count: 1, lastUpdatedAt: Date.now() };
    snapshot.permissions = [questionPermission("question", "Which branch?")];
    await openSessions();
    const row = elements(tree).find(element => element.props.className === "session-row-hit")!;
    expect(textContent(row)).toContain("待回答");
    expect(textContent(row)).not.toContain("后台子代理");
    expect(elements(row).some(element => element.props.className === "session-state-dot waiting")).toBe(true);
    expect(elements(tree).find(element => element.props["data-session-id"] === "A")!.props.className).toContain("active");
  });

  it("pins activity order, prepends new projects, restores manual order per host and can reorder by activity", async () => {
    snapshot.sessions.push({ ...snapshot.sessions[0]!, sessionId: "B", title: "Session B", projectId: "second", projectName: "Second", lastActivityAt: 2 });
    snapshot.projects.push({ ...snapshot.projects[0]!, projectId: "second", name: "Second", lastActivityAt: 2 });
    await openSessions();
    const titles = () => elements(tree).filter(element => element.type === ProjectGroupHeader).map(element => element.props.title);
    expect(titles()).toEqual(["Second", "Project"]);
    expect(JSON.parse(localStorage.getItem("bridge-project-order:computer")!)).toEqual(["second", "project"]);
    snapshot.sessions[0]!.lastActivityAt = 3;
    tree = sessions.draw({ ...sessionsProps, snapshot: { ...snapshot, sessions: [...snapshot.sessions] } });
    expect(titles()).toEqual(["Second", "Project"]);
    snapshot.sessions.push({ ...snapshot.sessions[0]!, sessionId: "C", title: "Session C", projectId: "third", projectName: "Third", lastActivityAt: 4 });
    tree = sessions.draw({ ...sessionsProps, snapshot: { ...snapshot, sessions: [...snapshot.sessions] } });
    expect(titles()).toEqual(["Third", "Second", "Project"]);
    elements(tree).find(element => element.type === IconButton && element.props.label === "调整项目顺序")!.props.onClick();
    tree = sessions.draw();
    let order = elements(tree).find(element => element.type === ProjectOrderSheet)!;
    order.props.onPlaceProjects(["project", "third", "second"]);
    tree = sessions.draw();
    expect(titles()).toEqual(["Project", "Third", "Second"]);
    await openSessions();
    expect(titles()).toEqual(["Project", "Third", "Second"]);
    elements(tree).find(element => element.type === IconButton && element.props.label === "调整项目顺序")!.props.onClick();
    tree = sessions.draw();
    order = elements(tree).find(element => element.type === ProjectOrderSheet)!;
    order.props.onPlaceProjects([...order.props.projectsByActivity]);
    tree = sessions.draw();
    expect(titles()).toEqual(["Third", "Project", "Second"]);
    order.props.onPlaceProjects(["second", "third", "project"]);
    tree = sessions.draw();
    expect(titles()).toEqual(["Second", "Third", "Project"]);
    snapshot.host.hostId = "another-computer";
    await openSessions();
    expect(titles()).toEqual(["Third", "Project", "Second"]);
    expect(JSON.parse(localStorage.getItem("bridge-project-order:computer")!)).toEqual(["second", "third", "project"]);
    expect(JSON.parse(localStorage.getItem("bridge-project-order:another-computer")!)).toEqual(["third", "project", "second"]);
  });
});

describe("desktop conversation actions", () => {
  it("suppresses an unanswered native question card in favor of the matching PermissionPrompt", async () => {
    const pending = questionPermission("matching", "Which branch?");
    snapshot.permissions = [questionPermission("other-session", "Which branch?", "B"), questionPermission("other-question", "Which color?"), pending];
    history = [{ id: "question", sessionId: "A", role: "assistant", text: "", createdAt: 1, origin: "claude-host",
      interactivePrompt: { kind: "question", toolUseId: pending.toolUseId, questions: pending.input.questions as NonNullable<NonNullable<BridgeHistoryItem["interactivePrompt"]>["questions"]> } }];
    await openSessions();
    expect(elements(tree).filter((element) => element.type === InteractivePromptCard)).toHaveLength(0);
    const prompts = elements(tree).filter((element) => element.type === PermissionPrompt);
    expect(prompts.map((element) => element.props.permission.requestId)).toEqual(["other-question", "matching"]);
    const matching = prompts.find((element) => element.props.permission.requestId === "matching")!;
    expect(matching.props.streamKey).toBe("permission:matching");
    await matching.props.onResolve("matching", "allow-once", undefined, { ...pending.input, answers: { "Which branch?": "Main" } });
    expect(apiRequest).toHaveBeenCalledExactlyOnceWith({ method: "permission.resolve", params: {
      requestId: "matching", decision: "allow-once", updatedInput: { ...pending.input, answers: { "Which branch?": "Main" } },
    } });
  });

  it("marks an expired native question unavailable without starting a turn", async () => {
    history = [{ id: "question", sessionId: "A", role: "assistant", text: "", createdAt: 1, origin: "claude-desktop",
      interactivePrompt: { kind: "question", toolUseId: "expired", questions: [{ question: "Which branch?", options: [{ label: "Main" }] }] } }];
    await openSessions();
    const card = elements(tree).find((element) => element.type === InteractivePromptCard)!;
    expect(card.props.unavailableReason).toBe("提问已不在待回答列表");
    await card.props.onSelectOption("Main"); await settle();
    expect(apiRequest).not.toHaveBeenCalled();
  });

  it("preserves quick replies in running sessions without a composer mode selector", async () => {
    Object.assign(snapshot.sessions[0]!, { turnState: "running", ownership: "DESKTOP_NATIVE_RUNNING" });
    snapshot.sessions[0]!.allowedActions!.canSteer = true;
    history = [{ id: "wrap-up", sessionId: "A", role: "assistant", text: "", createdAt: 1, origin: "claude-host",
      interactivePrompt: { kind: "wrap-up", actions: [{ label: "Continue", message: "Continue the task" }] } }];
    await openSessions();
    expect(elements(tree).some((element) => element.props.className === "composer-mode")).toBe(false);
    elements(tree).find((element) => element.type === InteractivePromptCard)!.props.onSelectOption("Continue the task"); await settle();
    expect(apiRequest).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ method: "turn.start", params: { sessionId: "A", text: "Continue the task", attachments: [] } }));
  });

  it("tracks a quick reply by its local RPC request ID rather than a nearby user message", async () => {
    history = [{ id: "wrap-up", sessionId: "A", role: "assistant", text: "", createdAt: 1, origin: "claude-desktop",
      interactivePrompt: { kind: "wrap-up", actions: [{ label: "Main", message: "Main" }] } }];
    await openSessions();
    apiRequest.mockResolvedValueOnce({ kind: "response", requestId: "desktop-answer", ok: true, result: { commandId: "answer-command", state: "queued" } });
    elements(tree).find(element => element.type === InteractivePromptCard)!.props.onSelectOption("Main");
    await settle();
    tree = sessions.draw({ ...sessionsProps, events: [
      { eventId: "reply-delivery", seq: 1, timestamp: 2, sessionId: "A", origin: "claude-host", type: "message.delivery",
        data: { requestId: "desktop-answer", commandId: "answer-command", delivery: "host-received" } },
      { eventId: "unrelated", seq: 2, timestamp: 3, sessionId: "A", origin: "mobile", itemId: "new-task", type: "user.message.accepted",
        data: { requestId: "other-request", text: "Deploy the documentation" } },
    ] });
    const card = elements(tree).find(element => element.type === InteractivePromptCard)!;
    expect(card.props.replyDelivery).toBe("host-received");
    const rendered = InteractivePromptCard(card.props as ComponentProps<typeof InteractivePromptCard>);
    expect(elements(rendered).find(element => element.props.className === "interactive-prompt-status")!.props.children).toBe("回复已排队");
    expect(apiRequest).toHaveBeenCalledOnce();
  });

  it("allows uploaded-file removal offline while upload remains disabled", async () => {
    const { uploadSessionFile } = await import("../lib/file-upload.js");
    vi.mocked(uploadSessionFile).mockResolvedValueOnce({ uploadId: "uploaded", sessionId: "A", name: "done.txt", path: ".bridge-uploads/done.txt", size: 8, sha256: "abc" });
    await openSessions();
    let picker = elements(tree).find((element) => element.type === FileAttachmentPicker)!;
    await picker.props.state.add([{ name: "done.txt", size: 8 }]);
    tree = sessions.draw({ ...sessionsProps, snapshot: { ...snapshot, connection: "closed" } });
    expect(elements(tree).find((element) => element.type === ComposerAttachmentMenu)!.props.fileDisabled).toBe(true);
    picker = elements(tree).find((element) => element.type === FileAttachmentPicker)!;
    const removal = elements(FileAttachmentPicker(picker.props as ComponentProps<typeof FileAttachmentPicker>))
      .find((element) => element.type === IconButton && element.props.label === "移除 done.txt")!;
    expect(removal.props.disabled).not.toBe(true);
    removal.props.onClick(); tree = sessions.draw();
    expect(elements(tree).find((element) => element.type === FileAttachmentPicker)!.props.state.entries).toEqual([]);
    expect(apiRequest).not.toHaveBeenCalled();
  });

  it("displays /btw sidechats under their active parent and navigates between parent and sidechats", async () => {
    snapshot.sessions = [
      snapshot.sessions[0]!,
      {
        ...snapshot.sessions[0]!,
        sessionId: "btw-1",
        title: "btw: 检查 IPv6 转发",
        parentSessionId: "A",
        forkLabel: "fork-4",
        sidechat: true,
      },
      {
        ...snapshot.sessions[0]!,
        sessionId: "btw-2",
        title: "btw: 收集白名单域名",
        parentSessionId: "A",
        forkLabel: "btw",
        sidechat: true,
        archivedAt: 100,
      },
    ];
    await openSessions();
    expect(textContent(tree)).toContain("2 个 /btw 侧聊");
    expect(textContent(tree)).toContain("/btw · btw: 检查 IPv6 转发");
    expect(textContent(tree)).toContain("/btw · btw: 收集白名单域名");
    const toggle = elements(tree).find((element) => element.type === "button" && element.props.className === "mobile-fork-toggle")!;
    toggle.props.onClick();
    tree = sessions.draw();
    const badges = elements(tree).filter((element) => element.type === "em" && String(element.props.className).includes("is-sidechat"));
    expect(badges.map((badge) => badge.props.children)).toEqual(["/btw", "/btw"]);
  });
});


describe("desktop common commands", () => {
  it("submits /help through session.command, displays the returned catalog and never sends a model turn", async () => {
    snapshot.host.capabilities = ["claude.native-relay.v1", "session.commands.v1", "session.command.v1"];
    await openSessions();
    const catalog = { sessionId: "A", commands: [{ name: "help", description: "帮助" }] };
    apiRequest.mockImplementation(async ({ method }) => ({ kind: "response", requestId: "command", ok: true,
      result: method === "session.commands" ? { catalog } : { command: { action: "help", catalog } },
    }));
    elements(tree).find(element => element.type === SlashCommandInput)!.props.onChange("/help"); tree = sessions.draw();
    elements(tree).find(element => element.type === "form" && element.props.className.startsWith("composer-form"))!.props.onSubmit({ preventDefault() {} });
    await settle(); tree = sessions.draw();
    expect(apiRequest.mock.calls.map(call => call[0].method)).toEqual(["session.commands", "session.command"]);
    expect(apiRequest.mock.calls[1]![0].params).toEqual({ sessionId: "A", text: "/help" });
    expect(elements(tree).find(element => element.type === SessionCommandDialogs)!.props.result).toEqual({ action: "help", catalog });
  });
  it("refreshes compacted history and switches reset sessions through real open requests", async () => {
    await openSessions();
    const event = { eventId: "compact", sessionId: "A", seq: 1, timestamp: 1, origin: "claude-host", type: "session.compacted", data: {} };
    tree = sessions.draw({ ...sessionsProps, events: [event] }); await settle(); tree = sessions.draw();
    expect(apiRequest).toHaveBeenCalledWith(expect.objectContaining({ method: "session.open", params: expect.objectContaining({ sessionId: "A" }) }));
    apiRequest.mockClear();
    const next = { ...snapshot.sessions[0]!, sessionId: "new-A", title: "New context", nativeSessionId: "new-native" };
    snapshot = { ...snapshot, sessions: [...snapshot.sessions, next] };
    const reset = { ...event, eventId: "reset", seq: 2, type: "session.reset", data: { sessionId: "new-A", previousSessionId: "A", nativeSessionId: "new-native" } };
    tree = sessions.draw({ ...sessionsProps, snapshot, events: [event, reset] }); await settle(); tree = sessions.draw();
    expect(apiRequest).toHaveBeenCalledWith(expect.objectContaining({ method: "session.open", params: expect.objectContaining({ sessionId: "new-A" }) }));
    expect(elements(tree).find(element => element.type === SessionCommandDialogs)!.props.session.sessionId).toBe("new-A");
  });
});


it("[edge] keeps an old session's slash failure out of the new draft and pending command", async () => {
  snapshot.host.capabilities = ["claude.native-relay.v1", "session.commands.v1", "session.command.v1"];
  snapshot.sessions.push({ ...snapshot.sessions[0]!, sessionId: "B", title: "Session B" });
  await openSessions();
  let failA!: (error: Error) => void;
  let finishB!: (result: unknown) => void;
  apiRequest.mockImplementation(async ({ method, params }) => {
    if (method === "session.commands") return { kind: "response", requestId: "catalog", ok: true, result: { catalog: { sessionId: params.sessionId, commands: [] } } };
    if (method === "session.command") return new Promise((resolve, reject) => { if (params.sessionId === "A") failA = reject; else finishB = resolve; });
    return { kind: "response", requestId: "history", ok: true, result: method === "session.open" ? { history: { items: [], hasMore: false } } : { evidence: { items: [], hasMore: false } } };
  });
  const input = () => elements(tree).find(element => element.type === SlashCommandInput)!;
  const send = () => elements(tree).find(element => element.type === "form" && element.props.className.startsWith("composer-form"))!.props.onSubmit({ preventDefault() {} });
  input().props.onChange("/context"); tree = sessions.draw(); send(); await settle(); tree = sessions.draw();
  elements(tree).find(element => element.type === "button" && element.props.className === "session-row-hit" && textContent(element).includes("Session B"))!.props.onClick(); tree = sessions.draw();
  input().props.onChange("/compact"); tree = sessions.draw();
  expect(elements(tree).find(element => element.type === "button" && element.props["aria-label"] === "发送")!.props.disabled).toBe(false);
  send(); await settle(); tree = sessions.draw();
  input().props.onChange("next B draft"); tree = sessions.draw();
  failA(new Error("A command failed")); await settle(); tree = sessions.draw();
  expect(input().props.value).toBe("next B draft");
  expect(elements(tree).some(element => element.props.role === "alert" && element.props.children === "A command failed")).toBe(false);
  expect(elements(tree).find(element => element.type === "button" && element.props["aria-label"] === "发送")!.props.disabled).toBe(true);
  finishB({ kind: "response", requestId: "B", ok: true, result: { command: { action: "sent" } } }); await settle(); tree = sessions.draw();
  expect(apiRequest.mock.calls.filter(call => call[0].method === "session.command").map(call => call[0].params)).toEqual([{ sessionId: "A", text: "/context" }, { sessionId: "B", text: "/compact" }]);
});

it("renders composer context usage only when present and degrades cleanly for unknown model capacity", async () => {
  await openSessions();
  expect(elements(tree).some(element => typeof element.props.className === "string" && element.props.className.includes("session-context-bar"))).toBe(false);

  snapshot.sessions[0]!.contextUsage = { totalTokens: 42_000, maxTokens: 1_000_000, percentage: 4.2, model: "claude-opus-5-5", estimated: false };
  tree = sessions.draw({ ...sessionsProps, snapshot });
  expect(elements(tree).some(element => typeof element.type === "function" && element.type.name === "SessionContextUsageBar")).toBe(true);

  snapshot.sessions[0]!.contextUsage = { totalTokens: 29_500, model: "custom/unknown-window", estimated: true };
  tree = sessions.draw({ ...sessionsProps, snapshot });
  const bar = elements(tree).find(element => typeof element.type === "function" && element.type.name === "SessionContextUsageBar")!;
  const rendered = (bar.type as (props: Record<string, unknown>) => ReactNode)(bar.props);
  expect(JSON.stringify(rendered)).toContain("30K");
  expect(JSON.stringify(rendered)).not.toContain("undefined");
});

describe("desktop conversation parity", () => {
  it("opens 50 history items, preserves cursor/items on paging error, and deduplicates retried older pages", async () => {
    history = [
      { id: "m-2", sessionId: "A", role: "user", text: "Recent question", createdAt: 20, origin: "claude-desktop" },
      { id: "m-3", sessionId: "A", role: "assistant", text: "Recent answer", createdAt: 30, origin: "claude-desktop" },
    ];
    apiRequest.mockImplementation(async ({ method }) => ({
      kind: "response",
      requestId: "page",
      ok: true,
      result: method === "session.open"
        ? { history: { items: history, hasMore: true, nextCursor: "m-2" } }
        : { evidence: { items: [], hasMore: false } },
    }));
    dashboard = renderer(DesktopDashboard, {
      themeControl: { theme: "dark", family: "apple", setTheme: vi.fn(), setFamily: vi.fn(), toggleTheme: vi.fn() },
      agentVisibility: { enabled: ["claude-desktop"], setEnabled: vi.fn() },
    });
    dashboard.draw(); await settle();
    const child = elements(dashboard.draw()).find((element) => typeof element.type === "function" && element.type.name === "DesktopSessions")!;
    sessionsProps = child.props;
    sessions = renderer(child.type as (props: any) => ReactNode, sessionsProps);
    sessions.draw(); await settle(); tree = sessions.draw();

    expect(apiRequest).toHaveBeenCalledWith({ method: "session.open", params: { sessionId: "A", limit: 50 } });
    apiRequest.mockClear();

    const loadOlder = () => elements(tree).find((element) => element.props.className === "load-older-button")!;
    expect(textContent(loadOlder())).toContain("加载更早消息");

    apiRequest.mockResolvedValueOnce({ kind: "response", requestId: "err", ok: false, error: { code: "HISTORY_ERR", message: "历史读取超时" } });
    loadOlder().props.onClick();
    await settle(); tree = sessions.draw();
    expect(apiRequest).toHaveBeenCalledExactlyOnceWith({ method: "session.history", params: { sessionId: "A", cursor: "m-2", limit: 50 } });
    expect(textContent(loadOlder())).toContain("重试加载更早消息");
    expect(elements(tree).some((element) => element.props.role === "alert" && element.props.children === "历史读取超时")).toBe(true);
    expect(elements(tree).filter((element) => element.type === ConversationMessageItem).map((element) => element.props.item.id)).toEqual(["m-2", "m-3"]);

    apiRequest.mockResolvedValueOnce({
      kind: "response",
      requestId: "older",
      ok: true,
      result: {
        history: {
          items: [
            { id: "m-1", sessionId: "A", role: "user", text: "Older question", createdAt: 10, origin: "claude-desktop" },
            { id: "m-2", sessionId: "A", role: "user", text: "Recent question", createdAt: 20, origin: "claude-desktop" },
          ],
          hasMore: false,
        },
      },
    });
    loadOlder().props.onClick();
    await settle(); tree = sessions.draw();
    expect(apiRequest).toHaveBeenLastCalledWith({ method: "session.history", params: { sessionId: "A", cursor: "m-2", limit: 50 } });
    expect(elements(tree).some((element) => element.props.className === "load-older-button")).toBe(false);
    expect(elements(tree).filter((element) => element.type === ConversationMessageItem).map((element) => element.props.item.id)).toEqual(["m-1", "m-2", "m-3"]);
  });

  it("groups consecutive tool rows, preserves group identity across backward paging, and forwards transcript.toolDetail.v1", async () => {
    snapshot.host.capabilities.push("transcript.toolDetail.v1");
    history = [
      { id: "t-3", sessionId: "A", role: "tool", toolName: "Edit", text: "src/a.ts", createdAt: 30, origin: "claude-desktop" },
      { id: "t-4", sessionId: "A", role: "tool", toolName: "Bash", text: "npm test", createdAt: 40, origin: "claude-desktop" },
    ];
    apiRequest.mockImplementation(async ({ method }) => ({
      kind: "response",
      requestId: "tools-page",
      ok: true,
      result: method === "session.open"
        ? { history: { items: history, hasMore: true, nextCursor: "t-3" } }
        : { evidence: { items: [], hasMore: false } },
    }));
    await openSessions();
    const groupsBefore = elements(tree).filter((element) => element.type === ConversationToolGroup);
    expect(groupsBefore).toHaveLength(1);
    expect(groupsBefore[0]!.props.tools).toHaveLength(2);
    expect(groupsBefore[0]!.props.supportsToolDetail).toBe(true);
    expect(groupsBefore[0]!.props.hostId).toBe("computer");
    const initialGroupKey = groupsBefore[0]!.key;

    apiRequest.mockResolvedValueOnce({
      kind: "response",
      requestId: "tools-older",
      ok: true,
      result: {
        history: {
          items: [
            { id: "t-1", sessionId: "A", role: "tool", toolName: "Read", text: "src/index.ts", createdAt: 10, origin: "claude-desktop" },
            { id: "t-2", sessionId: "A", role: "tool", toolName: "Read", text: "src/b.ts", createdAt: 20, origin: "claude-desktop" },
          ],
          hasMore: false,
        },
      },
    });
    elements(tree).find((element) => element.props.className === "load-older-button")!.props.onClick();
    await settle(); tree = sessions.draw();
    const groupsAfter = elements(tree).filter((element) => element.type === ConversationToolGroup);
    expect(groupsAfter).toHaveLength(1);
    expect(groupsAfter[0]!.props.tools.map((tool: any) => tool.id)).toEqual(["tool:t-1", "tool:t-2", "tool:t-3", "tool:t-4"]);
    expect(groupsAfter[0]!.key).toBe(initialGroupKey);
  });

  it("compensates scroll anchor when history prepends behind an older leading MailCard", async () => {
    mailContext.current = {
      cache: {
        changeToken: "tok",
        cards: [{
          seq: 1,
          mailRefId: "mail-early",
          accountKey: "acc",
          mailbox: "INBOX" as const,
          subject: "Early mail",
          from: [{ address: "ops@example.com" }],
          receivedAt: new Date(1).toISOString(),
          recordedAt: 1,
          preview: "Early preview",
          processingStatus: "processed" as const,
          nativeDelivery: { state: "observed" as const, nativeSessionId: "A" },
        }],
      },
      referenceFor: () => undefined,
    };
    history = [
      { id: "m-2", sessionId: "A", role: "user", text: "Later message", createdAt: 200, origin: "claude-desktop" },
    ];
    apiRequest.mockImplementation(async ({ method }) => ({
      kind: "response",
      requestId: "mail-page",
      ok: true,
      result: method === "session.open"
        ? { history: { items: history, hasMore: true, nextCursor: "m-2" } }
        : { evidence: { items: [], hasMore: false } },
    }));
    await openSessions();

    let anchorTop = 40;
    const anchorEl = {
      dataset: { streamKey: "m-2" },
      getBoundingClientRect: () => ({ top: anchorTop, bottom: anchorTop + 60 }),
    };
    const fakeStream = {
      scrollTop: 500,
      scrollHeight: 800,
      clientHeight: 300,
      getBoundingClientRect: () => ({ top: 0, bottom: 300 }),
      querySelectorAll: () => [anchorEl],
    };
    let streamDiv = elements(tree).find((element) => element.props.className === "desktop-conversation-stream")!;
    streamDiv.props.ref.current = fakeStream;
    tree = sessions.draw({
      ...sessionsProps,
      events: [{ eventId: "ev-tail", seq: 1, timestamp: 300, sessionId: "A", origin: "claude-desktop", itemId: "m-3", type: "assistant.completed", data: { text: "Tail reply" } }],
    });
    fakeStream.scrollTop = 250;
    streamDiv = elements(tree).find((element) => element.props.className === "desktop-conversation-stream")!;
    streamDiv.props.onScroll();

    anchorTop = 140;
    fakeStream.scrollHeight = 900;
    apiRequest.mockResolvedValueOnce({
      kind: "response",
      requestId: "mail-older",
      ok: true,
      result: {
        history: {
          items: [{ id: "m-1", sessionId: "A", role: "user", text: "Inserted between mail and m-2", createdAt: 100, origin: "claude-desktop" }],
          hasMore: false,
        },
      },
    });
    elements(tree).find((element) => element.props.className === "load-older-button")!.props.onClick();
    await settle(); tree = sessions.draw();
    expect(fakeStream.scrollTop).toBe(350);
  });

  it("polls background task details, opens focused task sheet, and confirms subagent stop scopes", async () => {
    snapshot.host.capabilities.push("subagent.stop.v1", "transcript.toolDetail.v1");
    snapshot.runtime.desktopIntegration.state = "ready";
    snapshot.sessions[0]!.subagentStopScope = "task";
    history = [{
      id: "sub-item",
      sessionId: "A",
      role: "tool",
      toolName: "Task",
      text: "Audit UI parity",
      createdAt: 1,
      origin: "claude-desktop",
      subagent: {
        agentId: "agent-1",
        toolUseId: "sub-call",
        description: "Audit UI parity",
        state: "running",
        toolCount: 0,
        startedAt: 1,
        updatedAt: 1,
      },
    }];
    const runningTask = {
      id: "sub-call",
      kind: "subagent" as const,
      taskId: "agent-1",
      toolUseId: "sub-call",
      description: "Audit UI parity",
      state: "running" as const,
      startedAt: 1,
      updatedAt: 2,
      subagent: history[0]!.subagent!,
    };
    apiRequest.mockImplementation(async ({ method }) => ({
      kind: "response",
      requestId: "bg",
      ok: true,
      result: method === "session.open"
        ? { history: { items: history, hasMore: false } }
        : method === "session.configuration"
          ? { session: { ...snapshot.sessions[0]!, backgroundTasks: [runningTask] } }
          : { evidence: { items: [], hasMore: false } },
    }));
    await openSessions();
    await settle(); tree = sessions.draw();
    const headerButton = elements(tree).find((element) => element.type === IconButton && element.props.label === "后台任务，1 个运行中")!;
    expect(headerButton).toBeDefined();
    const marker = elements(tree).find((element) => element.type === BackgroundTaskMarker)!;
    marker.props.onOpen();
    tree = sessions.draw();
    const sheet = elements(tree).find((element) => element.type === BackgroundTasksSheet)!;
    expect(sheet.props.focus?.id).toBe("tool:sub-call");
    expect(sheet.props.supportsToolDetail).toBe(true);

    const card = sheet.props.renderSubagent(sheet.props.items.find((item: any) => item.subagent?.agentId === "agent-1")) as ReactElement<ComponentProps<typeof SubagentCard>>;
    expect(card.type).toBe(SubagentCard);
    card.props.onStop!();
    tree = sessions.draw();
    const confirm = elements(tree).find((element) => element.type === ConfirmationDialog && element.props.title === "停止这个子代理？")!;
    expect(confirm.props.open).toBe(true);
    confirm.props.onConfirm();
    await settle(); tree = sessions.draw();
    expect(apiRequest).toHaveBeenCalledWith({ method: "subagent.stop", params: { sessionId: "A", agentId: "agent-1" } });
  });

  it("confirms workspace non-media file downloads and surfaces transfer errors", async () => {
    const { downloadBridgeSessionFile } = await import("../lib/artifact-download.js");
    history = [{ id: "file-msg", sessionId: "A", role: "assistant", text: "See [bundle.bin](dist/bundle.bin)", createdAt: 1, origin: "claude-desktop" }];
    await openSessions();
    const msg = elements(tree).find((element) => element.type === ConversationMessageItem)!;
    msg.props.onFileClick("dist/bundle.bin");
    tree = sessions.draw();
    const dialog = elements(tree).find((element) => element.type === ConfirmationDialog && element.props.title === "确认下载工作区文件？")!;
    expect(dialog.props.open).toBe(true);
    expect(dialog.props.description).toContain("bundle.bin");

    vi.mocked(downloadBridgeSessionFile).mockRejectedValueOnce(new Error("工作区文件不存在"));
    dialog.props.onConfirm();
    await settle(); tree = sessions.draw();
    expect(downloadBridgeSessionFile).toHaveBeenCalledWith("A", "dist/bundle.bin", expect.any(Function), expect.any(Function));
    expect(textContent(tree)).toContain("工作区文件不存在");
  });

  it("steers and cancels queued user messages and surfaces uncertain steer rejections", async () => {
    snapshot.host.capabilities.push("turn.queue.steer.v1", "turn.queue.cancel.v1");
    snapshot.sessions[0]!.pendingCount = 1;
    snapshot.sessions[0]!.pendingCommandIds = ["cmd-queued-1"];
    history = [{
      id: "queued-1",
      sessionId: "A",
      role: "user",
      text: "Queued follow-up",
      createdAt: 1,
      origin: "claude-desktop",
      delivery: "queued",
      commandId: "cmd-queued-1",
    }];
    await openSessions();

    apiRequest.mockResolvedValueOnce({ kind: "response", requestId: "steer-uncertain", ok: true, result: { state: "uncertain" } });
    await elements(tree).find((element) => element.type === "button" && element.props.children === "Send now")!.props.onClick();
    await settle(); tree = sessions.draw();
    expect(apiRequest).toHaveBeenCalledExactlyOnceWith({ method: "turn.queue.steer", params: { sessionId: "A", commandId: "cmd-queued-1" } });
    expect(textContent(tree)).toContain("消息投递状态尚未确认，请同步状态后重试");

    apiRequest.mockClear();
    apiRequest.mockResolvedValueOnce({ kind: "response", requestId: "steer-ok", ok: true, result: { state: "queued" } });
    await elements(tree).find((element) => element.type === "button" && element.props.children === "Send now")!.props.onClick();
    await settle(); tree = sessions.draw();
    expect(elements(tree).find((element) => element.type === "button" && element.props.children === "Send now")!.props.disabled).toBe(true);
    const cancelBtn = elements(tree).find((element) => element.type === "button" && element.props.children === "撤回")!;
    expect(cancelBtn.props.disabled).toBe(false);

    apiRequest.mockClear();
    apiRequest.mockResolvedValueOnce({ kind: "response", requestId: "cancel-ok", ok: true, result: { cancelled: true } });
    await cancelBtn.props.onClick();
    await settle(); tree = sessions.draw();
    expect(apiRequest).toHaveBeenCalledExactlyOnceWith({ method: "turn.queue.cancel", params: { sessionId: "A", commandId: "cmd-queued-1" } });
  });

  it("deduplicates uncertain delivery actions onto matching user bubbles while keeping orphan alerts", async () => {
    history = [{
      id: "u-uncertain",
      sessionId: "A",
      role: "user",
      text: "Message in flight",
      createdAt: 1,
      origin: "mobile",
      delivery: "uncertain",
      commandId: "cmd-matched",
    }];
    await openSessions();
    tree = sessions.draw({
      ...sessionsProps,
      events: [
        { eventId: "ev-matched", seq: 1, timestamp: 2, sessionId: "A", origin: "claude-host", type: "message.delivery",
          data: { commandId: "cmd-matched", delivery: "uncertain" } },
        { eventId: "ev-orphan", seq: 2, timestamp: 3, sessionId: "A", origin: "claude-host", type: "message.delivery",
          data: { commandId: "cmd-orphan", delivery: "uncertain", error: "连接中断" } },
      ],
    });
    const orphanCards = elements(tree).filter((element) => typeof element.props.className === "string" && element.props.className.includes("uncertain-delivery") && element.type === "article");
    expect(orphanCards).toHaveLength(1);
    expect(orphanCards[0]!.props["data-stream-key"]).toBe("uncertain:ev-orphan");
    const confirmButtons = elements(tree).filter((element) => element.type === "button" && element.props.children === "确认已发送");
    expect(confirmButtons).toHaveLength(2);
    confirmButtons[0]!.props.onClick();
    await settle();
    expect(apiRequest).toHaveBeenCalledWith({ method: "message.delivery.resolve", params: { commandId: "cmd-matched", action: "confirm" } });
  });
});
