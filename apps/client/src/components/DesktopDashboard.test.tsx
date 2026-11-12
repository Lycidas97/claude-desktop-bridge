import type { BridgeHistoryItem, BridgePermissionInfo, BridgeSessionInfo, DesktopControlSnapshot } from "@bridge/protocol";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopDashboard } from "./DesktopDashboard.js";
import { MediaPreviewProvider } from "./evidence/MediaPreviewProvider.js";
import { ConfirmationDialog } from "./common/ConfirmationDialog.js";
import { ComposerAttachmentMenu, FileAttachmentPicker } from "./evidence/FileAttachmentPicker.js";
import { IconButton } from "./common/IconButton.js";
import { InteractivePromptCard } from "./conversation/PermissionPrompts.js";
import { SlashCommandInput } from "./conversation/SlashCommandInput.js";
import { SessionCommandDialogs } from "./conversation/SessionCommandDialogs.js";
import { SessionRewindDialog } from "./conversation/SessionRewindDialog.js";
import { SessionNoticeCard } from "./conversation/SessionNoticeCard.js";

type HookStore = {
  slots: any[]; index: number; dirty: boolean;
  effects: Array<{ deps: unknown[] | undefined; cleanup: (() => void) | undefined }>;
  effectIndex: number; pending: Array<() => void>;
};
const hooks = vi.hoisted(() => ({ current: undefined as HookStore | undefined }));
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
  useEffect(effect: () => (() => void) | void, deps?: unknown[]) {
    const store = hooks.current!;
    const index = store.effectIndex++;
    const previous = store.effects[index];
    if (previous && deps && deps.length === previous.deps?.length && deps.every((value, i) => Object.is(value, previous.deps?.[i]))) return;
    store.pending.push(() => {
      previous?.cleanup?.();
      store.effects[index] = { deps, cleanup: effect() || undefined };
    });
  },
}));
vi.mock("./evidence/MediaPreviewProvider.js", async original => ({ ...await original<typeof import("./evidence/MediaPreviewProvider.js")>(), useMediaPreview: () => vi.fn() }));
vi.mock("../lib/file-upload.js", async (original) => ({
  ...await original<typeof import("../lib/file-upload.js")>(),
  uploadSessionFile: vi.fn(),
}));

function elements(node: ReactNode): ReactElement<Record<string, any>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Record<string, any>>;
  return [element, ...elements(element.props.children)];
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
    connection: "connected", launchAtLogin: false, managedDesktopEnabled: false,
    claudeDesktop: { state: "stopped", detail: "Stopped", canLaunch: true, canQuit: false },
  };
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

describe("desktop file stat capability", () => {
  it.each([false, true])("uses the snapshot capability when supported=%s regardless of version", async supported => {
    snapshot.host.version = "1.3.1";
    if (supported) snapshot.host.capabilities.push("artifact.transfer.stat.v1");
    await openSessions();
    expect(elements(dashboard.draw()).find(element => element.type === MediaPreviewProvider)!.props.supportsFileStat).toBe(supported);
  });
});

describe("session notice presentation", () => {
  it("uses the shared compact card instead of user rewind controls", async () => {
    snapshot.host.capabilities.push("session.rewind.v1");
    const text = "<side-sessions-event>None of the sessions you started is working now; their notes are above.</side-sessions-event>";
    history = [{ id: "notice", sessionId: "A", role: "user", text, createdAt: 1, origin: "claude-desktop" }];
    await openSessions();
    const cards = elements(tree).filter(element => element.type === SessionNoticeCard);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.props.source).toBe(text);
    expect(cards[0]!.props.itemId).toBe("notice");
    expect(cards[0]!.props.notice.summary).toBe("当前没有运行中的子会话");
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
    elements(tree).find(element => element.type === "button" && element.props.className?.includes("desktop-session-row") && textContent(element).includes("Session B"))!.props.onClick();
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
    const row = () => elements(tree).find(element => element.type === "button" && element.props.className?.includes("desktop-session-row") && textContent(element).includes("Session A"))!;
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

describe("desktop conversation actions", () => {
  it("resolves the matching pending question instead of sending a new turn", async () => {
    const pending = questionPermission("matching", "Which branch?");
    snapshot.permissions = [questionPermission("other-session", "Which branch?", "B"), questionPermission("other-question", "Which color?"), pending];
    history = [{ id: "question", sessionId: "A", role: "assistant", text: "", createdAt: 1, origin: "claude-host",
      interactivePrompt: { kind: "question", questions: pending.input.questions as NonNullable<NonNullable<BridgeHistoryItem["interactivePrompt"]>["questions"]> } }];
    await openSessions();
    elements(tree).find((element) => element.type === InteractivePromptCard)!.props.onSelectOption("Main"); await settle();
    expect(apiRequest).toHaveBeenCalledExactlyOnceWith({ method: "permission.resolve", params: {
      requestId: "matching", decision: "allow-once", updatedInput: { ...pending.input, answers: { "Which branch?": "Main" } },
    } });
  });

  it("keeps multi-question choices in the permission form without starting a turn", async () => {
    const pending = questionPermission("multi", "Which branch?");
    pending.input.questions = [...pending.input.questions as unknown[], { question: "Which color?", options: [{ label: "Blue" }] }];
    snapshot.permissions = [pending];
    history = [{ id: "question", sessionId: "A", role: "assistant", text: "", createdAt: 1, origin: "claude-host",
      interactivePrompt: { kind: "question", questions: pending.input.questions as NonNullable<NonNullable<BridgeHistoryItem["interactivePrompt"]>["questions"]> } }];
    await openSessions();
    elements(tree).find((element) => element.type === InteractivePromptCard)!.props.onSelectOption("Main"); await settle();
    expect(apiRequest).not.toHaveBeenCalled();
  });

  it("preserves quick replies for wrap-up options", async () => {
    history = [{ id: "wrap-up", sessionId: "A", role: "assistant", text: "", createdAt: 1, origin: "claude-host",
      interactivePrompt: { kind: "wrap-up", actions: [{ label: "Continue", message: "Continue the task" }] } }];
    await openSessions();
    elements(tree).find((element) => element.type === InteractivePromptCard)!.props.onSelectOption("Continue the task"); await settle();
    expect(apiRequest).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ method: "turn.start", params: { sessionId: "A", text: "Continue the task", attachments: [] } }));
  });

  it("tracks a quick reply by its local RPC request ID rather than a nearby user message", async () => {
    history = [{ id: "question", sessionId: "A", role: "assistant", text: "", createdAt: 1, origin: "claude-desktop",
      interactivePrompt: { kind: "question", questions: [{ question: "Which branch?", options: [{ label: "Main" }] }] } }];
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
    const toggle = elements(tree).find((element) => element.type === "button" && element.props.className === "desktop-fork-toggle")!;
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
  elements(tree).find(element => element.type === "button" && element.props.className?.includes("desktop-session-row") && textContent(element).includes("Session B"))!.props.onClick(); tree = sessions.draw();
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
