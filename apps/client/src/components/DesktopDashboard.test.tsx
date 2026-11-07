import type { BridgeHistoryItem, BridgePermissionInfo, BridgeSessionInfo, DesktopControlSnapshot } from "@bridge/protocol";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopDashboard } from "./DesktopDashboard.js";
import { DesktopHandoffNotice } from "./DesktopHandoffNotice.js";
import { ConfirmationDialog } from "./ConfirmationDialog.js";
import { ComposerAttachmentMenu, FileAttachmentPicker } from "./FileAttachmentPicker.js";
import { IconButton } from "./IconButton.js";
import { InteractivePromptCard } from "./MobileWorkspace.js";

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
vi.mock("./MediaPreviewProvider.js", () => ({ useMediaPreview: () => vi.fn() }));
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
    source: "bridge", ownership: "BRIDGE_IDLE", transport: "bridge-host", turnState: "idle", lastActivityAt: 1, pendingCount: 0,
  };
  snapshot = {
    host: { hostId: "computer", name: "Computer", capabilities: [], pairingEpoch: 1, relayUrl: "", online: true, lastSeenAt: 1, version: "1.0.3" },
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

describe("explicit Desktop handoff", () => {
  it.each([
    ["queued", "消息等待发送", "当前主轮结束后会自动交给 Desktop。"],
    ["submitted", "正在交给 Desktop", "等待原会话确认接收。"],
    ["held", "等待 Desktop 接收许可", "请在电脑端允许接收这条消息；尚未交给会话处理，无需重复发送。"],
  ] as const)("shows %s Desktop inbox progress without handoff or approval actions", (inputStatus, title, detail) => {
    snapshot.sessions[0]!.desktopHandoff = { state: "desktop-inbox", canReturn: false, canTakeover: true, inputStatus };
    const onReturn = vi.fn();
    const onTakeover = vi.fn();
    const notice = renderer(DesktopHandoffNotice, {
      session: { ...snapshot.sessions[0], pendingCount: 2 }, online: true, className: "desktop-channel-banner",
      onReturn, onTakeover, onRefresh: vi.fn(),
    });
    const rendered = notice.draw();
    expect(elements(rendered).find(element => element.type === "strong")!.props.children).toBe(title);
    expect(textContent(rendered)).toContain(detail);
    expect(elements(rendered).filter(element => element.type === "button")).toHaveLength(0);
    expect(elements(rendered).find(element => element.type === ConfirmationDialog)!.props.open).toBe(false);
    expect(onReturn).not.toHaveBeenCalled();
    expect(onTakeover).not.toHaveBeenCalled();
  });

  it("keeps an expired input recoverable and requires explicit confirmation before takeover", async () => {
    const onTakeover = vi.fn(async () => {});
    const notice = renderer(DesktopHandoffNotice, {
      session: { ...snapshot.sessions[0], pendingCount: 1, desktopHandoff: { state: "close-desktop", canReturn: false, canTakeover: true, reason: "inbox-confirmation-expired" } },
      online: true, className: "desktop-channel-banner", onTakeover,
    });
    const rendered = notice.draw();
    expect(textContent(rendered)).toContain("Desktop 接收确认已过期");
    expect(textContent(rendered)).toContain("消息仍保留在电脑队列中");
    expect(onTakeover).not.toHaveBeenCalled();
    elements(rendered).find(element => element.type === "button")!.props.onClick();
    const confirmation = elements(notice.draw()).find(element => element.type === ConfirmationDialog)!;
    expect(confirmation.props.open).toBe(true);
    expect(onTakeover).not.toHaveBeenCalled();
    await confirmation.props.onConfirm();
    expect(onTakeover).toHaveBeenCalledExactlyOnceWith("A");
  });

  it.each(["queued", "submitted", "held"] as const)("marks offline %s Desktop inbox status as unconfirmed", inputStatus => {
    snapshot.sessions[0]!.desktopHandoff = { state: "desktop-inbox", canReturn: false, canTakeover: true, inputStatus };
    const notice = renderer(DesktopHandoffNotice, {
      session: { ...snapshot.sessions[0], pendingCount: 2 }, online: false, className: "desktop-channel-banner",
      onReturn: vi.fn(), onTakeover: vi.fn(), onRefresh: vi.fn(),
    });
    const rendered = notice.draw();
    expect(elements(rendered).find(element => element.type === "strong")!.props.children).toBe("连接已断开，等待同步状态");
    expect(textContent(rendered)).toContain("上次同步的接收状态尚未确认。");
    expect(textContent(rendered)).not.toContain("等待原会话确认接收。");
    expect(textContent(rendered)).not.toContain("消息已由 Desktop 暂存");
    expect(textContent(rendered)).not.toContain("当前主轮结束后会自动交给 Desktop。");
    expect(elements(rendered).filter(element => element.type === "button")).toHaveLength(0);
  });

  it.each([
    ["close-desktop", "请关闭此 Desktop 会话", "仅等待空闲不会交接"],
    ["reopen-desktop", "请重新打开 Desktop 会话", "关闭并重新打开此会话，加载手机端产生的历史"],
  ] as const)("explains the required user action in %s", (state, title, detail) => {
    const notice = renderer(DesktopHandoffNotice, {
      session: { ...snapshot.sessions[0], desktopHandoff: { state, canReturn: false } },
      online: true, className: "desktop-channel-banner", onReturn: vi.fn(),
    });
    const rendered = notice.draw();
    expect(textContent(rendered)).toContain(title);
    expect(textContent(rendered)).toContain(detail);
    const buttons = elements(rendered).filter(element => element.type === "button");
    expect(buttons).toHaveLength(state === "close-desktop" ? 1 : 0);
    if (buttons[0]) expect(buttons[0].props).toMatchObject({ children: "接管此会话", disabled: true });
  });

  it.each(["main", "background", "queued", "offline"])("disables return while %s work prevents it", reason => {
    const onReturn = vi.fn();
    const notice = renderer(DesktopHandoffNotice, {
      session: { ...snapshot.sessions[0],
        ...(reason === "main" ? { turnState: "running", activeTurnId: "turn" } : {}),
        ...(reason === "background" ? { runningSubagents: { count: 1, lastUpdatedAt: 1 } } : {}),
        ...(reason === "queued" ? { pendingCount: 1, turnState: "queued" } : {}),
        desktopHandoff: { state: "bridge", canReturn: reason === "offline" },
      }, online: reason !== "offline", className: "desktop-channel-banner", onReturn,
    });
    const button = elements(notice.draw()).find(element => element.type === "button")!;
    expect(button.props.children).toBe("交还 Desktop");
    expect(button.props.disabled).toBe(true);
    button.props.onClick();
    expect(onReturn).not.toHaveBeenCalled();
  });

  it.each(["bridge", "close-desktop"])("returns directly from %s, blocks repeated clicks while pending, and surfaces a rejection", async state => {
    let reject!: (failure: Error) => void;
    const onReturn = vi.fn(() => new Promise<void>((_resolve, no) => { reject = no; }));
    const notice = renderer(DesktopHandoffNotice, {
      session: { ...snapshot.sessions[0], desktopHandoff: { state, canReturn: true } },
      online: true, className: "desktop-channel-banner", onReturn,
    });
    elements(notice.draw()).find(element => element.type === "button")!.props.onClick();
    const busy = elements(notice.draw()).find(element => element.type === "button")!;
    expect(busy.props.disabled).toBe(true);
    expect(busy.props.children).toBe("交还中");
    busy.props.onClick();
    expect(onReturn).toHaveBeenCalledExactlyOnceWith("A");
    reject(new Error("后台任务仍在运行")); await settle();
    const failed = notice.draw();
    expect(textContent(elements(failed).find(element => element.props.role === "alert"))).toContain("后台任务仍在运行");
    expect(elements(failed).find(element => element.type === "button")!.props.disabled).toBe(false);
  });

  it("sends the local RPC and applies its returned session without launching or quitting Desktop", async () => {
    snapshot.sessions[0]!.desktopHandoff = { state: "bridge", canReturn: true };
    await openSessions();
    const returned = { ...snapshot.sessions[0]!, desktopHandoff: { state: "reopen-desktop", canReturn: false } };
    apiRequest.mockResolvedValueOnce({ kind: "response", requestId: "return", ok: true, result: { session: returned } });
    const notice = elements(tree).find(element => element.type === DesktopHandoffNotice)!;
    await notice.props.onReturn("A");
    expect(apiRequest).toHaveBeenCalledExactlyOnceWith({ method: "session.return_to_desktop", params: { sessionId: "A" } });
    const child = elements(dashboard.draw()).find(element => typeof element.type === "function" && element.type.name === "DesktopSessions")!;
    expect(child.props.snapshot.sessions).toEqual([returned]);
    const updated = sessions.draw(child.props);
    expect(textContent(updated)).toContain("请重新打开 Desktop 会话");
    expect(textContent(updated)).not.toContain("Claude Desktop 同步");
  });

  it.each(["return", "takeover"] as const)("keeps the local %s action available while the relay is disconnected", async action => {
    snapshot.connection = "closed";
    snapshot.host.online = false;
    snapshot.sessions[0]!.desktopHandoff = action === "return"
      ? { state: "bridge", canReturn: true }
      : { state: "close-desktop", canReturn: false, canTakeover: true };
    await openSessions();
    apiRequest.mockResolvedValueOnce({ kind: "response", requestId: action, ok: true, result: { session: snapshot.sessions[0] } });
    const handoff = elements(tree).find(element => element.type === DesktopHandoffNotice)!;
    const notice = renderer(DesktopHandoffNotice, handoff.props);
    let rendered = notice.draw();
    const button = elements(rendered).find(element => element.type === "button"
      && element.props.children === (action === "return" ? "交还 Desktop" : "接管此会话"))!;
    expect(button.props.disabled).toBe(false);
    button.props.onClick();
    if (action === "takeover") {
      rendered = notice.draw();
      const confirmation = elements(rendered).find(element => element.type === ConfirmationDialog)!;
      expect(confirmation.props.open).toBe(true);
      confirmation.props.onConfirm();
    }
    await settle();
    expect(apiRequest).toHaveBeenCalledExactlyOnceWith({
      method: action === "return" ? "session.return_to_desktop" : "session.takeover_desktop", params: { sessionId: "A" },
    });
  });

  it("replaces legacy takeover guidance only for sessions with the handoff field", async () => {
    snapshot.sessions[0]!.ownership = "FALLBACK_CONFIRMATION_REQUIRED";
    await openSessions();
    expect(textContent(tree)).toContain("当前任务结束后");
    tree = sessions.draw({ ...sessionsProps, snapshot: { ...snapshot, sessions: [{ ...snapshot.sessions[0],
      desktopHandoff: { state: "close-desktop", canReturn: false },
    }] } });
    expect(elements(tree).find(element => element.type === DesktopHandoffNotice)!.props.session.desktopHandoff.state).toBe("close-desktop");
    expect(textContent(tree)).not.toContain("当前任务结束后");
  });
});

describe("explicit single-session Desktop takeover", () => {
  function noticeProps() {
    return { session: { ...snapshot.sessions[0]!, pendingCount: 2,
      desktopHandoff: { state: "close-desktop" as const, canReturn: false, canTakeover: true } },
      online: true, className: "desktop-channel-banner", onTakeover: vi.fn().mockResolvedValue(undefined) };
  }
  const button = (rendered: ReactNode) => elements(rendered).find(element => element.type === "button" && element.props.children === "接管此会话")!;
  const dialog = (rendered: ReactNode) => elements(rendered).find(element => element.type === ConfirmationDialog)!;

  it("keeps takeover visible in the queued waiting banner and requires a cancellable, scoped confirmation", async () => {
    const props = noticeProps();
    const notice = renderer(DesktopHandoffNotice, props);
    let rendered = notice.draw();
    expect(elements(rendered).filter(element => element.props["aria-label"] === "消息排队状态")).toHaveLength(1);
    expect(textContent(rendered)).toContain("2 条消息已到电脑");
    expect(button(rendered).props.disabled).toBe(false);
    button(rendered).props.onClick();
    rendered = notice.draw();
    expect(props.onTakeover).not.toHaveBeenCalled();
    expect(dialog(rendered).props.open).toBe(true);
    expect(dialog(rendered).props.description).toContain("仅结束此会话的 Desktop 执行进程");
    expect(dialog(rendered).props.description).toContain("保留 Desktop 应用和其他会话");
    expect(dialog(rendered).props.description).toContain("继续执行排队消息");
    expect(dialog(rendered).props.description).toContain("等待中的提问将被取消");
    expect(dialog(rendered).props.description).toContain("已发送的回答会保留并继续处理");
    dialog(rendered).props.onCancel();
    expect(dialog(notice.draw()).props.open).toBe(false);
    expect(props.onTakeover).not.toHaveBeenCalled();
    button(notice.draw()).props.onClick();
    dialog(notice.draw()).props.onConfirm(); await settle();
    expect(props.onTakeover).toHaveBeenCalledExactlyOnceWith("A");
    expect(dialog(notice.draw()).props.open).toBe(false);
  });

  it.each(["unsupported", "offline", "missing-callback"])("disables takeover when %s", reason => {
    const props = noticeProps();
    if (reason === "unsupported") delete (props.session.desktopHandoff as { canTakeover?: boolean }).canTakeover;
    if (reason === "offline") props.online = false;
    if (reason === "missing-callback") delete (props as { onTakeover?: unknown }).onTakeover;
    const notice = renderer(DesktopHandoffNotice, props);
    const action = button(notice.draw());
    expect(action.props.disabled).toBe(true);
    action.props.onClick();
    expect(dialog(notice.draw()).props.open).toBe(false);
  });

  it("disables both handoff actions while busy and surfaces backend refusal without losing the queue", async () => {
    let reject!: (failure: Error) => void;
    const props = { ...noticeProps(), onTakeover: vi.fn(() => new Promise<void>((_yes, no) => { reject = no; })), onReturn: vi.fn() };
    props.session.desktopHandoff.canReturn = true;
    const notice = renderer(DesktopHandoffNotice, props);
    button(notice.draw()).props.onClick();
    dialog(notice.draw()).props.onConfirm();
    let rendered = notice.draw();
    expect(dialog(rendered).props.busy).toBe(true);
    expect(elements(rendered).filter(element => element.type === "button").every(element => element.props.disabled)).toBe(true);
    dialog(rendered).props.onConfirm();
    elements(rendered).find(element => element.type === "button" && element.props.children === "交还 Desktop")!.props.onClick();
    expect(props.onTakeover).toHaveBeenCalledExactlyOnceWith("A");
    expect(props.onReturn).not.toHaveBeenCalled();
    reject(new Error("主任务或子代理仍在运行")); await settle();
    rendered = notice.draw();
    expect(dialog(rendered).props.open).toBe(false);
    expect(textContent(elements(rendered).find(element => element.props.role === "alert"))).toContain("主任务或子代理仍在运行");
    expect(textContent(rendered)).toContain("2 条消息已到电脑");
    expect(button(rendered).props.disabled).toBe(false);
  });

  it("rechecks availability if the connection closes during confirmation", () => {
    const props = noticeProps();
    const notice = renderer(DesktopHandoffNotice, props);
    button(notice.draw()).props.onClick();
    const rendered = notice.draw({ ...props, online: false });
    expect(button(rendered).props.disabled).toBe(true);
    dialog(rendered).props.onConfirm();
    expect(props.onTakeover).not.toHaveBeenCalled();
  });

  it("sends the Desktop local RPC for only the selected session and applies the returned session", async () => {
    snapshot.sessions[0]!.desktopHandoff = noticeProps().session.desktopHandoff;
    snapshot.sessions.push({ ...snapshot.sessions[0]!, sessionId: "B" });
    await openSessions();
    const returned = { ...snapshot.sessions[0]!, desktopHandoff: { state: "bridge", canReturn: false, canTakeover: false } };
    apiRequest.mockResolvedValueOnce({ kind: "response", requestId: "takeover", ok: true, result: { session: returned } });
    const notice = elements(tree).find(element => element.type === DesktopHandoffNotice)!;
    await notice.props.onTakeover("A");
    expect(apiRequest).toHaveBeenCalledExactlyOnceWith({ method: "session.takeover_desktop", params: { sessionId: "A" } });
    const child = elements(dashboard.draw()).find(element => typeof element.type === "function" && element.type.name === "DesktopSessions")!;
    expect(child.props.snapshot.sessions).toEqual([returned, snapshot.sessions[1]]);
  });

  it("propagates a Desktop backend refusal without changing the selected session", async () => {
    snapshot.sessions[0]!.desktopHandoff = noticeProps().session.desktopHandoff;
    await openSessions();
    apiRequest.mockResolvedValueOnce({ kind: "response", requestId: "takeover", ok: false, error: { code: "BUSY", message: "子代理仍在运行" } });
    const notice = elements(tree).find(element => element.type === DesktopHandoffNotice)!;
    await expect(notice.props.onTakeover("A")).rejects.toThrow("子代理仍在运行");
    const child = elements(dashboard.draw()).find(element => typeof element.type === "function" && element.type.name === "DesktopSessions")!;
    expect(child.props.snapshot.sessions).toEqual(snapshot.sessions);
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
});
