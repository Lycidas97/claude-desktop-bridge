import type { BridgePermissionInfo, BridgeSessionInfo } from "@bridge/protocol";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InteractivePromptCard, MobileWorkspace, PermissionPrompt, SubagentCard } from "./MobileWorkspace.js";
import { ComposerAttachmentMenu, FileAttachmentPicker } from "./FileAttachmentPicker.js";
import { IconButton } from "./IconButton.js";
import { MessageCopyButton } from "./MessageCopyButton.js";
import { TaskPlanCard } from "./TaskPlanCard.js";
import { DesktopHandoffNotice } from "./DesktopHandoffNotice.js";
import { SessionCreateDialog } from "./SessionCreateDialog.js";
import { dispatchMobileBack } from "../lib/mobile-back-navigation.js";

const hooks = vi.hoisted(() => ({
  slots: [] as any[], index: 0, dirty: false,
  effects: [] as Array<{ deps: unknown[] | undefined; cleanup: (() => void) | undefined }>,
  effectIndex: 0, pending: [] as Array<() => void>,
  readers: [] as any[],
}));

vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState(initial: any) {
    const index = hooks.index++;
    const slots = hooks.slots;
    if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
    return [slots[index], (value: any) => {
      const next = typeof value === "function" ? value(slots[index]) : value;
      if (!Object.is(next, slots[index])) hooks.dirty = true;
      slots[index] = next;
    }];
  },
  useRef(initial: unknown) {
    const index = hooks.index++;
    hooks.slots[index] ??= { current: initial };
    return hooks.slots[index];
  },
  useMemo: (create: () => unknown) => create(),
  useEffect(effect: () => (() => void) | void, deps?: unknown[]) {
    const index = hooks.effectIndex++;
    const previous = hooks.effects[index];
    if (previous && deps && deps.length === previous.deps?.length && deps.every((value, i) => Object.is(value, previous.deps?.[i]))) return;
    hooks.pending.push(() => {
      previous?.cleanup?.();
      hooks.effects[index] = { deps, cleanup: effect() || undefined };
    });
  },
  useLayoutEffect: () => undefined,
}));

vi.mock("./MediaPreviewProvider.js", () => ({ useMediaPreview: () => vi.fn() }));

class DeferredFileReader {
  result = "data:image/png;base64,cGljdHVyZQ==";
  error = new Error("image read failed");
  listeners = new Map<string, () => void>();
  addEventListener(name: string, listener: () => void) { this.listeners.set(name, listener); }
  readAsDataURL() { hooks.readers.push(this); }
  finish() { this.listeners.get("load")!(); }
  fail() { this.listeners.get("error")!(); }
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function elements(node: ReactNode): ReactElement<Record<string, any>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Record<string, any>>;
  return [element, ...elements(element.props.children)];
}

let props: ComponentProps<typeof MobileWorkspace>;
let tree: ReactElement;
let focusKey = 0;
function draw() {
  for (let i = 0; i < 12; i++) {
    hooks.dirty = false;
    hooks.index = 0;
    hooks.effectIndex = 0;
    tree = MobileWorkspace(props) as ReactElement;
    hooks.pending.splice(0).forEach((effect) => effect());
    if (!hooks.dirty) return;
  }
  throw new Error("Workspace did not settle");
}
function input() { return elements(tree).find((e) => e.type === "textarea")!; }
function form() { return elements(tree).find((e) => e.type === "form" && e.props.className.startsWith("composer-form"))!; }
function sendButton() { return elements(tree).find((e) => e.type === "button" && e.props["aria-label"] === "发送")!; }
function text(value: string) { input().props.onChange({ target: { value } }); draw(); }
function open(sessionId: string) {
  props = { ...props, focusRequest: { sessionId, key: ++focusKey } };
  draw();
}
async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); draw(); }
function selectImage() {
  const input = elements(tree).find((e) => e.type === "input" && e.props.accept?.startsWith("image/"))!;
  return input.props.onChange({ target: { files: [{ name: "A.png", type: "image/png", size: 8 }] } });
}
function imageNames() {
  return elements(tree).filter((e) => e.type === "button" && e.props["aria-label"]?.startsWith("移除 ")).map((e) => e.props["aria-label"]);
}

beforeEach(() => {
  hooks.slots = []; hooks.effects = []; hooks.pending = []; hooks.readers = []; focusKey = 0;
  vi.stubGlobal("FileReader", DeferredFileReader);
  // Node's global localStorage has no storage file here; the workspace keeps project order in it.
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
  });
  const base: BridgeSessionInfo = {
    sessionId: "A", title: "Session A", projectId: "project", projectName: "Project", cwd: "/tmp/project",
    source: "bridge", ownership: "BRIDGE_IDLE", transport: "bridge-host", turnState: "idle", lastActivityAt: 1, pendingCount: 0,
  };
  props = {
    activeHostId: "computer-1", desktopName: "Computer", connection: "connected", desktopOnline: true,
    snapshot: {
      host: { hostId: "computer-1", name: "Computer", capabilities: [], pairingEpoch: 1, relayUrl: "", online: true, lastSeenAt: 1, version: "1.0.2" },
      sessions: [base, { ...base, sessionId: "B", title: "Session B" }],
      projects: [{ projectId: "project", name: "Project", cwd: "/tmp/project", sessionCount: 2, runningCount: 0, pendingCount: 0, lastActivityAt: 1 }],
      devices: [], permissions: [], latestSeq: 0,
      runtime: { state: "ready", detail: "Ready", activeTurns: 0, maxParallelTurns: 2,
        desktopIntegration: { state: "not-managed", detail: "Unavailable", enabled: false, canRestart: false } },
    },
    permissions: [], histories: { A: { status: "ready", items: [], hasMore: false }, B: { status: "ready", items: [], hasMore: false } },
    evidence: {}, artifactPreviews: {}, artifactTransfers: {}, events: [], localTurns: [], pendingOutbound: 0,
    themeControl: { theme: "dark", family: "apple", setTheme: vi.fn(), setFamily: vi.fn(), toggleTheme: vi.fn() },
    onOpenSession: vi.fn(), onLoadOlderHistory: vi.fn(), onLoadOlderEvidence: vi.fn(), onPreviewArtifact: vi.fn(), onDownloadArtifact: vi.fn(),
    onSendTurn: vi.fn().mockResolvedValue(undefined), onInterruptTurn: vi.fn(), onResolveUncertain: vi.fn(), onResolvePermission: vi.fn(), onCreateSession: vi.fn(),
    onLoadSessionConfiguration: vi.fn(), onConfigureSession: vi.fn(), onPreviewProviderSwitch: vi.fn(), onCommitProviderSwitch: vi.fn(), onCancelProviderSwitch: vi.fn(),
    onRefreshProviders: vi.fn(), onPreviewRuntimeHandoff: vi.fn(), onCommitRuntimeHandoff: vi.fn(), onConfirmRuntimeHandoff: vi.fn(), onCancelRuntimeHandoff: vi.fn(), onGetRuntimeHandoff: vi.fn(),
    onPauseRuntimeGoal: vi.fn(), onResumeRuntimeGoal: vi.fn(), onDesktopAppAction: vi.fn(), onRefresh: vi.fn(), onBackToHosts: vi.fn(), onRetry: vi.fn(),
  };
  open("A");
});
afterEach(() => { hooks.effects.forEach((e) => e.cleanup?.()); vi.unstubAllGlobals(); });

describe("session back navigation", () => {
  it("returns to the directory without sending or losing the draft, then releases root back", () => {
    text("保留这条未发送的草稿");
    expect(dispatchMobileBack()).toBe(true); draw();
    expect(input()).toBeUndefined();
    expect(dispatchMobileBack()).toBe(false);
    open("A");
    expect(input().props.value).toBe("保留这条未发送的草稿");
    expect(props.onSendTurn).not.toHaveBeenCalled();
  });
  it("closes session actions before leaving the conversation", () => {
    const header = elements(tree).find(element => element.props.backLabel === "返回会话列表")!;
    elements(header.props.actions).find(element => element.type === IconButton && element.props.label === "会话操作")!.props.onClick(); draw();
    expect(dispatchMobileBack()).toBe(true); draw();
    expect(input()).toBeDefined();
    expect(dispatchMobileBack()).toBe(true); draw();
    expect(input()).toBeUndefined();
  });
});

describe("subagent overflow", () => {
  function agents(count: number) {
    const now = Date.now();
    props = { ...props, onStopSubagent: vi.fn().mockResolvedValue(undefined),
      snapshot: { ...props.snapshot!, sessions: props.snapshot!.sessions.map(session => ({ ...session, subagentStopScope: "task" as const })) },
      histories: { ...props.histories, A: { status: "ready", hasMore: false, items: Array.from({ length: count }, (_, index) => ({
        id: `tool:agent-tool-${index}`, sessionId: "A", role: "tool" as const, text: "", toolName: "Agent", createdAt: now + index, origin: "claude-host" as const,
        subagent: { agentId: `agent-${index}`, toolUseId: `agent-tool-${index}`, description: `子代理 ${index + 1}`, state: "running" as const, toolCount: 1, startedAt: now + index, updatedAt: now + index },
      })) } },
    };
    draw();
  }
  const overflow = () => elements(tree).find(element => element.type === "details" && element.props.className === "subagent-overflow");

  it.each([0, 1, 3, 4, 8])("leaves three visible and collapses only the excess of %s subagents", count => {
    agents(count);
    const hidden = overflow() ? elements(overflow()!.props.children[1]).filter(element => element.type === SubagentCard) : [];
    expect(Boolean(overflow())).toBe(count > 3);
    expect(overflow()?.props.open).toBeUndefined();
    expect(hidden).toHaveLength(Math.max(0, count - 3));
    expect(elements(tree).filter(element => element.type === SubagentCard).length - hidden.length).toBe(Math.min(3, count));
  });

  it("updates the existing group and retains a hidden agent's stop action", async () => {
    agents(6);
    const key = overflow()!.key;
    const hidden = elements(overflow()!.props.children[1]).find(element => element.type === SubagentCard)!;
    hidden.props.onStop();
    draw();
    const confirmation = elements(tree).find(element => element.props.title === "停止这个子代理？")!;
    expect(confirmation.props.description).toContain("子代理 4");
    await confirmation.props.onConfirm();
    expect(props.onStopSubagent).toHaveBeenCalledWith("A", "agent-3");
    props = { ...props, histories: { ...props.histories, A: { ...props.histories.A!, items: props.histories.A!.items.map(item => ({ ...item, subagent: { ...item.subagent!, state: "completed" as const, toolCount: 9 } })) } } };
    draw();
    expect(overflow()!.key).toBe(key);
    expect(elements(overflow()!.props.children[1]).filter(element => element.type === SubagentCard).every(element => element.props.item.subagent.state === "completed")).toBe(true);
  });

  it("keeps separate batches on their own sides of an assistant message", () => {
    agents(8);
    const items = [...props.histories.A!.items];
    items.splice(3, 0, { id: "separator", sessionId: "A", role: "assistant", text: "继续下一批", createdAt: items[2]!.createdAt + 0.5, origin: "claude-host" });
    props = { ...props, histories: { ...props.histories, A: { ...props.histories.A!, items } } };
    draw();
    expect(elements(tree).filter(element => element.type === "details" && element.props.className === "subagent-overflow")).toHaveLength(1);
    expect(elements(overflow()!.props.children[1]).filter(element => element.type === SubagentCard)).toHaveLength(2);
  });
});

describe("mobile session creation", () => {
  it("opens creation from an empty computer without historical projects", () => {
    props = { ...props, snapshot: { ...props.snapshot!, sessions: [], projects: [] } };
    draw();
    const header = elements(tree).find(element => element.props.title === "会话" && element.props.actions)!;
    const create = elements(header.props.actions).find(element => element.type === IconButton && element.props.label === "新建会话")!;
    expect(create.props.disabled).toBe(false);
    create.props.onClick(); draw();
    expect(elements(tree).find(element => element.type === SessionCreateDialog)?.props.initialProjectId).toBe("");
  });
  it("passes the selected logical project when two projects share a cwd", async () => {
    props = { ...props, snapshot: { ...props.snapshot!,
      projects: [
        { ...props.snapshot!.projects[0]!, projectId: "project-1", name: "First project", sessionCount: 1 },
        { ...props.snapshot!.projects[0]!, projectId: "project-2", name: "Second project", sessionCount: 1 },
      ],
      sessions: props.snapshot!.sessions.map((session, index) => ({ ...session,
        projectId: `project-${index + 1}`, projectName: index === 0 ? "First project" : "Second project",
      })),
    } };
    vi.mocked(props.onCreateSession).mockResolvedValue(undefined);
    draw();
    elements(tree).find(element => element.props.backLabel === "返回会话列表")!.props.onBack();
    draw();
    const header = elements(tree).find(element => element.props.title === "会话" && element.props.actions)!;
    elements(header.props.actions).find(element => element.type === IconButton && element.props.label === "新建会话")!.props.onClick();
    draw();
    const dialog = elements(tree).find(element => element.type === SessionCreateDialog)!;
    expect(dialog.props.snapshot.projects.map((project: { projectId: string }) => project.projectId)).toEqual(["project-1", "project-2"]);
    expect(dialog.props.initialProjectId).toBe("");
    expect(dialog.props.connected).toBe(true);
    await dialog.props.onCreate("/tmp/project", "Created", "claude-desktop", "project-2");
    expect(props.onCreateSession).toHaveBeenCalledOnce();
    expect(props.onCreateSession).toHaveBeenCalledWith("/tmp/project", "Created", "claude-desktop", "project-2");
  });
});

describe("mobile session renaming", () => {
  function enableRename() {
    props = { ...props, onRenameSession: vi.fn().mockResolvedValue(undefined),
      snapshot: { ...props.snapshot!, host: { ...props.snapshot!.host, capabilities: ["session.rename.v1"] } },
    };
    draw();
  }
  function openMenu(entry: "list" | "conversation") {
    if (entry === "list") {
      elements(tree).find(element => element.props.backLabel === "返回会话列表")!.props.onBack(); draw();
      const row = elements(tree).find(element => element.props["data-session-id"] === "A")!;
      elements(row).find(element => element.type === IconButton && element.props.label === "会话操作")!.props.onClick();
    } else {
      const header = elements(tree).find(element => element.props.backLabel === "返回会话列表")!;
      elements(header.props.actions).find(element => element.type === IconButton && element.props.label === "会话操作")!.props.onClick();
    }
    draw();
  }
  const renameAction = () => elements(tree).find(element => element.props.label === "重命名");
  const dialog = () => elements(tree).find(element => element.props.role === "dialog" && element.props["aria-label"] === "重命名会话");
  const titleInput = () => elements(dialog()).find(element => element.type === "input")!;
  const save = () => elements(dialog()).find(element => element.type === "button" && element.props.type === "submit")!;
  function editTitle(value: string) { titleInput().props.onChange({ target: { value } }); draw(); }
  async function submit() {
    elements(dialog()).find(element => element.type === "form")!.props.onSubmit({ preventDefault() {} });
    await settle();
  }

  it.each(["list", "conversation"] as const)("prefills and saves a trimmed title from the %s menu", async entry => {
    enableRename(); openMenu(entry);
    expect(renameAction()).toBeDefined();
    expect(elements(tree).some(element => element.props.label === "同步此会话")).toBe(true);
    renameAction()!.props.onClick(); draw();
    expect(titleInput().props.value).toBe("Session A");
    editTitle("  手机项目名称  ");
    await submit();
    expect(props.onRenameSession).toHaveBeenCalledExactlyOnceWith("A", "手机项目名称");
    expect(dialog()).toBeUndefined();
    expect(props.onSendTurn).not.toHaveBeenCalled();
  });

  it("cancels without sending a rename and prefills the current title next time", () => {
    enableRename(); openMenu("conversation"); renameAction()!.props.onClick(); draw();
    editTitle("尚未保存");
    elements(dialog()).find(element => element.type === "button" && element.props.children === "取消")!.props.onClick(); draw();
    expect(dialog()).toBeUndefined();
    expect(props.onRenameSession).not.toHaveBeenCalled();
    props = { ...props, snapshot: { ...props.snapshot!, sessions: props.snapshot!.sessions.map(session => session.sessionId === "A" ? { ...session, title: "另一端名称" } : session) } };
    openMenu("conversation"); renameAction()!.props.onClick(); draw();
    expect(titleInput().props.value).toBe("另一端名称");
  });

  it("retains the title and host error after a failed save, then allows retry", async () => {
    enableRename();
    vi.mocked(props.onRenameSession!).mockRejectedValueOnce(new Error("名称保存失败，请重试"));
    openMenu("conversation"); renameAction()!.props.onClick(); draw(); editTitle("保留输入");
    await submit();
    expect(titleInput().props.value).toBe("保留输入");
    expect(elements(dialog()).find(element => element.props.role === "alert")!.props.children).toBe("名称保存失败，请重试");
    expect(save().props.disabled).toBe(false);
    await submit();
    expect(props.onRenameSession).toHaveBeenCalledTimes(2);
    expect(dialog()).toBeUndefined();
  });

  it.each(["", "  \t  ", "Session A", "  Session A  "])("does not send an empty or unchanged title (%j)", async title => {
    enableRename(); openMenu("conversation"); renameAction()!.props.onClick(); draw(); editTitle(title);
    expect(save().props.disabled).toBe(true);
    await submit();
    expect(props.onRenameSession).not.toHaveBeenCalled();
  });

  it("renames a running session while keeping deletion unavailable", async () => {
    enableRename();
    props = { ...props, onDeleteSession: vi.fn(), snapshot: { ...props.snapshot!, sessions: props.snapshot!.sessions.map(session => session.sessionId === "A"
      ? { ...session, ownership: "BRIDGE_RUNNING", turnState: "running", activeTurnId: "turn", pendingCount: 1, pendingCommandIds: ["queued"] } : session) } };
    draw(); openMenu("conversation");
    expect(renameAction()!.props.disabled).toBe(false);
    expect(elements(tree).find(element => element.props.label === "删除会话")!.props.disabled).toBe(true);
    renameAction()!.props.onClick(); draw(); editTitle("运行中的新名称"); await submit();
    expect(props.onRenameSession).toHaveBeenCalledExactlyOnceWith("A", "运行中的新名称");
    expect(props.onInterruptTurn).not.toHaveBeenCalled();
  });

  it.each(["capability", "callback"])("hides rename without the %s", missing => {
    enableRename();
    if (missing === "capability") props = { ...props, snapshot: { ...props.snapshot!, host: { ...props.snapshot!.host, capabilities: [] } } };
    else delete props.onRenameSession;
    draw(); openMenu("conversation");
    expect(renameAction()).toBeUndefined();
    expect(elements(tree).some(element => element.props.label === "同步此会话")).toBe(true);
  });
});

describe("session update timestamps", () => {
  it("keeps time and order when opening a session, then advances them for an actual update", async () => {
    const now = Date.now();
    const opened = JSON.stringify({ A: now + 3_600_000 });
    localStorage.setItem("bridge-session-opened:computer-1", opened);
    props = { ...props, snapshot: { ...props.snapshot!, sessions: props.snapshot!.sessions.map(session => ({
      ...session, lastActivityAt: now - (session.sessionId === "A" ? 21 : 3) * 3_600_000,
    })) } };
    draw();
    elements(tree).find(element => element.props.backLabel === "返回会话列表")!.props.onBack();
    draw();
    expect(elements(tree).filter(element => element.props["data-session-id"]).map(element => element.props["data-session-id"])).toEqual(["B", "A"]);
    const row = elements(tree).find(element => element.props["data-session-id"] === "A")!;
    row.props.children[0].props.onClick();
    await settle();
    elements(tree).find(element => element.props.backLabel === "返回会话列表")!.props.onBack();
    draw();
    expect(elements(tree).filter(element => element.props["data-session-id"]).map(element => element.props["data-session-id"])).toEqual(["B", "A"]);
    expect(elements(tree).filter(element => element.type === "small").flatMap(element => element.props.children)).toContain("21 小时前");
    expect(localStorage.getItem("bridge-session-opened:computer-1")).toBe(opened);
    props = { ...props, snapshot: { ...props.snapshot!, sessions: props.snapshot!.sessions.map(session => session.sessionId === "A" ? { ...session, lastActivityAt: now } : session) } };
    draw();
    expect(elements(tree).filter(element => element.props["data-session-id"]).map(element => element.props["data-session-id"])).toEqual(["A", "B"]);
    expect(elements(tree).filter(element => element.type === "small").flatMap(element => element.props.children)).toContain("刚刚");
  });
});

describe("steering a message already queued on the host", () => {
  function queued(callback = vi.fn().mockResolvedValue(undefined), message = "排队中的指令") {
    props = { ...props, onSteerQueuedTurn: callback,
      snapshot: { ...props.snapshot!, sessions: props.snapshot!.sessions.map(session => session.sessionId === "A"
        ? { ...session, ownership: "BRIDGE_RUNNING", turnState: "running", pendingCount: 1, pendingCommandIds: ["queued-command"] } : session) },
      localTurns: [{ requestId: "original-request", idempotencyKey: "original-key", sessionId: "A", text: message,
        attachments: [{ id: "image", name: "context.png", mimeType: "image/png", size: 7 }], createdAt: 10, delivery: "host-received", commandId: "queued-command" }],
    };
    draw();
  }
  const action = () => elements(tree).find(element => element.type === "button" && element.props.className?.includes("queued-steer-button"));

  it("targets the original command, keeps the draft, and never sends a second message", async () => {
    const callback = vi.fn().mockResolvedValue(undefined);
    queued(callback);
    text("尚未发送的草稿");
    expect(action()?.props.children).toBe("立即调整");
    await action()!.props.onClick();
    draw();
    expect(callback).toHaveBeenCalledWith("A", "queued-command");
    expect(props.onSendTurn).not.toHaveBeenCalled();
    expect(input().props.value).toBe("尚未发送的草稿");
    expect(action()?.props.children).toBe("已调整");
    expect(action()?.props.disabled).toBe(true);
    props = { ...props, snapshot: { ...props.snapshot!, sessions: props.snapshot!.sessions.map(session => ({ ...session, pendingCount: 0, pendingCommandIds: [] })) } };
    draw();
    expect(action()).toBeUndefined();
  });

  it("works for an attachment-only queued message", () => {
    queued(undefined, "");
    expect(action()).toBeDefined();
  });

  it("shows pending state and keeps a failure on the original message after switching sessions", async () => {
    const held = deferred();
    queued(vi.fn(() => held.promise));
    const pending = action()!.props.onClick();
    draw();
    expect(action()?.props.children).toBe("调整中…");
    expect(action()?.props.disabled).toBe(true);
    open("B");
    held.reject(new Error("电脑响应超时，调整结果尚未确认"));
    await pending;
    draw();
    expect(elements(tree).some(element => element.props.role === "alert" && String(element.props.children).includes("调整结果"))).toBe(false);
    open("A");
    expect(action()?.props.disabled).toBe(false);
    expect(elements(tree).some(element => element.props.role === "alert" && String(element.props.children).includes("调整结果"))).toBe(true);
    expect(props.localTurns[0]).toMatchObject({ text: "排队中的指令", commandId: "queued-command", delivery: "host-received" });
    expect(props.localTurns[0]?.attachments).toHaveLength(1);
  });

  it.each(["offline", "disconnected"])("disables the action while %s", status => {
    queued();
    props = status === "offline" ? { ...props, desktopOnline: false } : { ...props, connection: "closed" };
    draw();
    expect(action()?.props.disabled).toBe(true);
    expect(action()?.props.title).toContain("离线");
  });

  it.each(["unsupported-host", "unsupported-runtime", "cannot-steer", "not-queued", "not-received", "no-active-turn"])("hides an inapplicable action: %s", status => {
    queued();
    if (status === "unsupported-host") delete props.onSteerQueuedTurn;
    if (status === "not-received") props = { ...props, localTurns: props.localTurns.map(turn => ({ ...turn, delivery: "local-saved" })) };
    if (!["unsupported-host", "not-received"].includes(status)) {
      props = { ...props, snapshot: { ...props.snapshot!, sessions: props.snapshot!.sessions.map(session => ({ ...session,
        ...(status === "unsupported-runtime" ? { runtimeId: "codex-desktop" as const } : {}),
        ...(status === "cannot-steer" ? { allowedActions: { canSend: true, canSteer: false, canInterrupt: true, canSwitchProvider: false, canContinueOfficial: false, canConfigure: true } } : {}),
        ...(status === "not-queued" ? { pendingCount: 0, pendingCommandIds: [] } : {}),
        ...(status === "no-active-turn" ? { turnState: "idle" as const } : {}),
      })) } };
    }
    draw();
    expect(action()).toBeUndefined();
  });
});

describe("explicit Desktop handoff", () => {
  it("requires closing the queued Desktop executor and preserves refresh and queue cancellation", async () => {
    const onTakeoverDesktop = vi.fn().mockResolvedValue(undefined);
    props = { ...props, onTakeoverDesktop, snapshot: { ...props.snapshot!, sessions: props.snapshot!.sessions.map(session => session.sessionId === "A" ? {
      ...session, ownership: "FALLBACK_CONFIRMATION_REQUIRED", turnState: "queued", pendingCount: 1, pendingCommandIds: ["queued"],
      desktopHandoff: { state: "close-desktop", canReturn: false, canTakeover: true },
    } : session) } };
    text("保留草稿");
    const notices = elements(tree).filter(element => element.type === DesktopHandoffNotice);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.props.session.pendingCount).toBe(1);
    expect(notices[0]!.props.session.desktopHandoff.canTakeover).toBe(true);
    expect(notices[0]!.props.online).toBe(true);
    expect(elements(tree).some(element => element.props["aria-label"] === "消息排队状态")).toBe(false);
    expect(elements(tree).some(element => element.props.children === "正在等待同会话接管")).toBe(false);
    await notices[0]!.props.onRefresh();
    expect(props.onRefresh).toHaveBeenCalledWith("A");
    await notices[0]!.props.onTakeover("A");
    expect(onTakeoverDesktop).toHaveBeenCalledExactlyOnceWith("A");
    expect(input().props.value).toBe("保留草稿");
    expect(props.onSendTurn).not.toHaveBeenCalled();
    text("");
    elements(tree).find(element => element.props["aria-label"] === "停止任务")!.props.onClick(); draw();
    const confirmation = elements(tree).find(element => element.props.open && element.props.title === "停止当前任务？")!;
    expect(confirmation.props.description).toContain("排在最前面的一条指令会被取消");
    confirmation.props.onConfirm(); await settle();
    expect(props.onInterruptTurn).toHaveBeenCalledWith("A");
  });

  it.each(["close-desktop", "bridge", "reopen-desktop"] as const)("passes the selected %s session and return action to its notice", async state => {
    const onReturnToDesktop = vi.fn().mockResolvedValue(undefined);
    props = { ...props, onReturnToDesktop, snapshot: { ...props.snapshot!, sessions: props.snapshot!.sessions.map(session => session.sessionId === "A" ? {
      ...session, desktopHandoff: { state, canReturn: state === "bridge" },
    } : session) } };
    draw();
    const notice = elements(tree).find(element => element.type === DesktopHandoffNotice)!;
    expect(notice.props.session).toBe(props.snapshot!.sessions[0]);
    expect(notice.props.online).toBe(true);
    await notice.props.onReturn(notice.props.session.sessionId);
    expect(onReturnToDesktop).toHaveBeenCalledExactlyOnceWith("A");
    props = { ...props, desktopOnline: false }; draw();
    expect(elements(tree).find(element => element.type === DesktopHandoffNotice)!.props.online).toBe(false);
  });
});

describe("native structured approvals", () => {
  function nativePrompt(prompt: NonNullable<ComponentProps<typeof InteractivePromptCard>["prompt"]>, id = "tool:native-question") {
    props = { ...props, snapshot: { ...props.snapshot!, sessions: props.snapshot!.sessions.map(session => session.sessionId === "A"
      ? { ...session, source: "desktop", transport: "claude-desktop-managed", ownership: "DESKTOP_OBSERVED", runtimeId: "claude-desktop" } : session) },
      histories: { ...props.histories, A: { status: "ready", hasMore: false, items: [
        { id, sessionId: "A", role: "assistant", toolName: prompt.kind === "question" ? "AskUserQuestion" : "mcp__ccd_turn__wrap_up", text: "", createdAt: 1, origin: "claude-desktop", interactivePrompt: { ...prompt, toolUseId: "native-question" } },
      ] } } };
    draw();
    return elements(tree).find(element => element.type === InteractivePromptCard)!;
  }

  it("does not send blocked native wrap-up approval as peer chat", async () => {
    const card = nativePrompt({ kind: "wrap-up", blocked: true, ask: "批准实施？", actions: [{ label: "批准实施", message: "批准实施" }] });
    const rendered = InteractivePromptCard(card.props as ComponentProps<typeof InteractivePromptCard>);
    expect(elements(rendered).filter(element => element.type === "button").every(element => element.props.disabled)).toBe(true);
    expect(elements(rendered).find(element => element.props.className === "interactive-prompt-status")?.props.children).toBe("需在电脑端确认");
    card.props.onSelectOption("批准实施");
    await settle();
    expect(props.onSendTurn).not.toHaveBeenCalled();
    expect(props.onResolvePermission).not.toHaveBeenCalled();
  });

  it("does not turn an unmatched native question into a chat reply", async () => {
    const card = nativePrompt({ kind: "question", questions: [{ question: "Which branch?", options: [{ label: "Main" }] }] });
    const rendered = InteractivePromptCard(card.props as ComponentProps<typeof InteractivePromptCard>);
    expect(elements(rendered).filter(element => element.type === "button").every(element => element.props.disabled)).toBe(true);
    card.props.onSelectOption("Main");
    await settle();
    expect(props.onSendTurn).not.toHaveBeenCalled();
    expect(props.onResolvePermission).not.toHaveBeenCalled();
  });

  it("uses the native tool ID when two live questions have identical text", async () => {
    const question = { question: "Which branch?", options: [{ label: "Main" }, { label: "Feature" }] };
    const permission: BridgePermissionInfo = { requestId: "exact-request", sessionId: "A", toolUseId: "native-question", toolName: "AskUserQuestion", input: { questions: [question] }, createdAt: 1, canAllowAlways: false };
    props = { ...props, permissions: [{ ...permission, requestId: "other-request", toolUseId: "another-tool" }, permission] };
    const card = nativePrompt({ kind: "question", questions: [question] });
    card.props.onSelectOption("Main");
    await settle();
    expect(props.onResolvePermission).toHaveBeenCalledExactlyOnceWith("exact-request", "allow-once", undefined, { ...permission.input, answers: { "Which branch?": "Main" } });
    expect(props.onSendTurn).not.toHaveBeenCalled();
  });

  it("does not close another native question when identical text was answered elsewhere", () => {
    const question = { question: "Which branch?", options: [{ label: "Main" }] };
    nativePrompt({ kind: "question", questions: [question] });
    const first = props.histories.A!.items[0]!;
    props = { ...props, histories: { ...props.histories, A: { status: "ready", hasMore: false, items: [
      { ...first, id: "question-first", interactivePrompt: { kind: "question", toolUseId: "first-tool", questions: [question] } },
      { ...first, id: "question-second", createdAt: 2, interactivePrompt: { kind: "question", toolUseId: "second-tool", questions: [question] } },
    ] } }, events: [{ eventId: "resolved-first", seq: 1, timestamp: 3, sessionId: "A", origin: "system", type: "question.resolved", data: { requestId: "first-request", toolUseId: "first-tool", decision: "allow-once" } }] };
    draw();
    const cards = elements(tree).filter(element => element.type === InteractivePromptCard);
    expect(cards.find(card => card.props.prompt.toolUseId === "first-tool")?.props.prompt.answered).toBe(true);
    expect(cards.find(card => card.props.prompt.toolUseId === "second-tool")?.props.prompt.answered).not.toBe(true);
  });

  it("preserves non-blocking native quick replies as messages", async () => {
    const card = nativePrompt({ kind: "wrap-up", blocked: false, ask: "接下来做什么？", actions: [{ label: "继续调查", message: "继续调查" }] });
    card.props.onSelectOption("继续调查");
    await settle();
    expect(props.onSendTurn).toHaveBeenCalledExactlyOnceWith("A", "继续调查", [], false);
    expect(props.onResolvePermission).not.toHaveBeenCalled();
  });

  it("submits all checkbox answers through the pending question request", async () => {
    const permission: BridgePermissionInfo = { requestId: "multi-request", sessionId: "A", toolUseId: "native-question", toolName: "AskUserQuestion", createdAt: 1, canAllowAlways: false,
      input: { questions: [{ question: "Which checks?", multiSelect: true, options: [{ label: "类型检查" }, { label: "回归测试" }] }] } };
    const onResolve = vi.fn().mockResolvedValue(undefined);
    const child = PermissionPrompt({ permission, onResolve });
    const drawQuestion = () => { hooks.index = 0; return (child.type as (props: unknown) => ReactElement)(child.props); };
    hooks.slots = [];
    let rendered = drawQuestion();
    expect(elements(rendered).filter(element => element.type === "input").map(element => element.props.type)).toEqual(["checkbox", "checkbox"]);
    elements(rendered).filter(element => element.type === "input")[0]!.props.onChange();
    rendered = drawQuestion();
    elements(rendered).filter(element => element.type === "input")[1]!.props.onChange();
    rendered = drawQuestion();
    elements(rendered).find(element => element.props.className === "primary-button")!.props.onClick();
    await Promise.resolve();
    expect(onResolve).toHaveBeenCalledExactlyOnceWith("multi-request", "allow-once", undefined, { ...permission.input, answers: { "Which checks?": "类型检查, 回归测试" } });
  });
});

describe("question answer delivery", () => {
  it.each(["host-received", "submitted", "running"] as const)("labels this card's %s answer accurately without duplicating it or clearing the draft", async delivery => {
    props = { ...props, histories: { ...props.histories, A: { status: "ready", hasMore: false, items: [
      { id: "question", sessionId: "A", role: "assistant", text: "", createdAt: 1, origin: "claude-desktop",
        interactivePrompt: { kind: "question", questions: [{ question: "Which branch?", options: [{ label: "Main" }] }] } },
    ] } } };
    vi.mocked(props.onSendTurn).mockResolvedValueOnce({ requestId: "answer" });
    text("保留草稿");
    elements(tree).find(element => element.type === InteractivePromptCard)!.props.onSelectOption("Main");
    await settle();
    props = { ...props, localTurns: [{ requestId: "answer", idempotencyKey: "answer-key", commandId: "queued", sessionId: "A", text: "Main", attachments: [], createdAt: 2, delivery }] };
    draw();
    const card = elements(tree).find(element => element.type === InteractivePromptCard)!;
    expect(card.props.replyDelivery).toBe(delivery);
    const rendered = InteractivePromptCard(card.props as ComponentProps<typeof InteractivePromptCard>);
    const status = elements(rendered).find(element => element.props.className === "interactive-prompt-status")!;
    expect(status.props.children).toBe(delivery === "running" ? "已回复" : "回复已排队");
    expect(elements(rendered).filter(element => element.type === "button").every(element => element.props.disabled)).toBe(true);
    expect(elements(tree).filter(element => element.props.className === "conversation-bubble")).toHaveLength(1);
    expect(input().props.value).toBe("保留草稿");
    expect(props.onSendTurn).toHaveBeenCalledExactlyOnceWith("A", "Main", [], false);
  });

  it.each(["history-and-assistant", "history", "resolution", "assistant"])("keeps a confirmed reply complete after its receipt leaves memory (%s)", async confirmation => {
    props = { ...props, histories: { ...props.histories, A: { status: "ready", hasMore: false, items: [
      { id: "question", sessionId: "A", role: "assistant", text: "", createdAt: 1, origin: "claude-desktop",
        interactivePrompt: { kind: "question", questions: [{ question: "Which branch?", options: [{ label: "Main" }] }] } },
    ] } } };
    const question = props.histories.A!.items[0]!;
    vi.mocked(props.onSendTurn).mockResolvedValueOnce({ requestId: "answer" });
    draw();
    elements(tree).find(element => element.type === InteractivePromptCard)!.props.onSelectOption("Main");
    await settle();
    props = { ...props, localTurns: [{ requestId: "answer", idempotencyKey: "answer-key", commandId: "queued", sessionId: "A", text: "Main", attachments: [], createdAt: 2, delivery: "host-received" }] };
    draw();
    let card = elements(tree).find(element => element.type === InteractivePromptCard)!;
    let rendered = InteractivePromptCard(card.props as ComponentProps<typeof InteractivePromptCard>);
    expect(elements(rendered).find(element => element.props.className === "interactive-prompt-status")!.props.children).toBe("回复已排队");

    props = { ...props, histories: { ...props.histories, A: { status: "ready", hasMore: false, items: [
      { ...question, interactivePrompt: { ...question.interactivePrompt!, answered: confirmation.includes("history") } },
      ...(confirmation.includes("assistant") ? [{ id: "continuation", sessionId: "A", role: "assistant" as const, text: "已收到回答继续执行", createdAt: 3, origin: "claude-desktop" as const }] : []),
    ] } }, events: confirmation === "resolution" ? [
      { eventId: "resolved", seq: 1, timestamp: 3, sessionId: "A", origin: "system", type: "question.resolved",
        data: { requestId: "permission", toolName: "AskUserQuestion", input: { questions: question.interactivePrompt!.questions }, decision: "allow-once" } },
    ] : [], localTurns: [{ requestId: "new-task", idempotencyKey: "new-key", commandId: "new-command", sessionId: "A", text: "处理新的无关任务", attachments: [], createdAt: 4, delivery: "host-received" }] };
    draw();
    card = elements(tree).find(element => element.type === InteractivePromptCard)!;
    rendered = InteractivePromptCard(card.props as ComponentProps<typeof InteractivePromptCard>);
    expect(elements(rendered).find(element => element.props.className === "interactive-prompt-status")!.props.children).toBe("已回复");
    expect(card.props.replyDelivery).toBeUndefined();
    expect(card.props.replyPending).not.toBe(true);
    expect(elements(rendered).filter(element => element.type === "button").every(element => element.props.disabled)).toBe(true);
    expect(props.onSendTurn).toHaveBeenCalledExactlyOnceWith("A", "Main", [], false);
  });

  it("keeps the prompt receipt with its session and computer across navigation", async () => {
    props = { ...props, histories: Object.fromEntries(["A", "B"].map(sessionId => [sessionId, {
      status: "ready", hasMore: false, items: [{ id: "question", sessionId, role: "assistant", text: "", createdAt: 1, origin: "claude-desktop",
        interactivePrompt: { kind: "question", questions: [{ question: "Which branch?", options: [{ label: "Main" }] }] } }],
    }])) };
    vi.mocked(props.onSendTurn).mockResolvedValueOnce({ requestId: "answer" });
    draw();
    elements(tree).find(element => element.type === InteractivePromptCard)!.props.onSelectOption("Main");
    await settle();
    const answer = { requestId: "answer", idempotencyKey: "answer-key", sessionId: "A", text: "Main", attachments: [], createdAt: 2, delivery: "host-received" as const };
    props = { ...props, localTurns: [answer, { ...answer, sessionId: "B", delivery: "failed" }] };
    open("B");
    expect(elements(tree).find(element => element.type === InteractivePromptCard)!.props.replyDelivery).toBeUndefined();
    open("A");
    expect(elements(tree).find(element => element.type === InteractivePromptCard)!.props.replyDelivery).toBe("host-received");
    props = { ...props, activeHostId: "computer-2", localTurns: [{ ...answer, delivery: "failed" }] };
    draw();
    expect(elements(tree).find(element => element.type === InteractivePromptCard)!.props.replyDelivery).toBeUndefined();
    props = { ...props, activeHostId: "computer-1", localTurns: [answer] };
    draw();
    expect(elements(tree).find(element => element.type === InteractivePromptCard)!.props.replyDelivery).toBe("host-received");
    expect(props.onSendTurn).toHaveBeenCalledOnce();
  });

  it("keeps a legacy quick reply pending when its callback supplies no receipt", async () => {
    props = { ...props, histories: { ...props.histories, A: { status: "ready", hasMore: false, items: [
      { id: "question", sessionId: "A", role: "assistant", text: "", createdAt: 1, origin: "claude-desktop",
        interactivePrompt: { kind: "question", questions: [{ question: "Which branch?", options: [{ label: "Main" }] }] } },
    ] } } };
    draw();
    elements(tree).find(element => element.type === InteractivePromptCard)!.props.onSelectOption("Main");
    await settle();
    const card = elements(tree).find(element => element.type === InteractivePromptCard)!;
    const rendered = InteractivePromptCard(card.props as ComponentProps<typeof InteractivePromptCard>);
    expect(elements(rendered).find(element => element.props.className === "interactive-prompt-status")!.props.children).toBe("已提交，等待处理");
    expect(elements(rendered).filter(element => element.type === "button").every(element => element.props.disabled)).toBe(true);
    expect(props.onSendTurn).toHaveBeenCalledExactlyOnceWith("A", "Main", [], false);
  });
});

describe("mobile task plan cards", () => {
  it("renders one stable card through live updates, reconnect history, and session navigation", () => {
    const plan = { id: "plan:task-1", updatedAt: 100, items: [{ content: "Implement sync", status: "in_progress" as const }] };
    props = { ...props, events: [{ eventId: "plan-event", seq: 1, timestamp: 100, sessionId: "A", itemId: plan.id,
      type: "session.observed", origin: "claude-desktop", data: { role: "assistant", text: "", taskPlan: plan } }] };
    draw();
    const cards = () => elements(tree).filter((element) => element.type === TaskPlanCard);
    expect(cards()).toHaveLength(1);
    const key = cards()[0]!.key;
    expect(cards()[0]!.props.plan).toEqual(plan);
    expect(elements(tree).filter((element) => element.type === MessageCopyButton)).toHaveLength(0);
    const completed = { ...plan, updatedAt: 200, items: [{ content: "Implement sync", status: "completed" as const }] };
    const revision = { ...props.events[0]!, eventId: "updated-plan", seq: 2, timestamp: 200, data: { role: "assistant", text: "", taskPlan: completed } };
    props = { ...props, events: [...props.events, revision, revision] };
    draw();
    expect(cards()).toHaveLength(1);
    expect(cards()[0]!.key).toBe(key);
    expect(cards()[0]!.props.plan).toEqual(completed);
    props = { ...props, events: [props.events[0]!], histories: { ...props.histories, A: { status: "ready", hasMore: false, items: [
      { id: plan.id, sessionId: "A", role: "assistant", text: "", createdAt: 100, origin: "claude-desktop", taskPlan: completed },
    ] } } };
    draw();
    expect(cards()).toHaveLength(1);
    expect(cards()[0]!.key).toBe(key);
    expect(cards()[0]!.props.plan).toEqual(completed);
    open("B");
    expect(cards()).toHaveLength(0);
    open("A");
    expect(cards()).toHaveLength(1);
    expect(cards()[0]!.props.plan).toEqual(completed);
  });
});

describe("mobile conversation draft ownership", () => {
  it("keeps the mobile completion receipt visible after acceptance", () => {
    props = { ...props, events: [
      { eventId: "accepted", seq: 1, timestamp: 100, sessionId: "A", turnId: "t1", itemId: "m1", origin: "mobile", type: "user.message.accepted", data: { text: "检查部署", requestId: "r1", commandId: "c1" } },
      { eventId: "done", seq: 2, timestamp: 200, sessionId: "A", turnId: "t1", origin: "claude-host", type: "turn.completed", data: { commandId: "c1" } },
    ] };
    draw();
    expect(elements(tree).find((e) => e.props.className === "delivery-state completed")?.props.children).toBe("已完成");
  });

  it("explains waiting for Desktop and offers status synchronization", async () => {
    props = { ...props, snapshot: { ...props.snapshot!, sessions: props.snapshot!.sessions.map((s) => s.sessionId === "A"
      ? { ...s, ownership: "DESKTOP_OBSERVED", turnState: "queued", pendingCount: 1, pendingCommandIds: ["c1"] } : s) } };
    draw();
    const status = elements(tree).find((e) => e.props["aria-label"] === "消息排队状态");
    expect(status).toBeDefined();
    const button = elements(status).find((e) => e.type === "button" && e.props.children === "同步状态");
    expect(button).toBeDefined();
    await button!.props.onClick();
    expect(props.onRefresh).toHaveBeenCalledWith("A");
    props = { ...props, snapshot: { ...props.snapshot!, sessions: props.snapshot!.sessions.map((s) => ({ ...s, turnState: "idle", pendingCount: 0, pendingCommandIds: [] })) } };
    draw();
    expect(elements(tree).some((e) => e.props["aria-label"] === "消息排队状态")).toBe(false);
  });

  it("provides copy actions with each message's full source text", () => {
    const fullReply = "# 回复\n" + "折叠内容\n".repeat(1000) + "结尾标记";
    props = { ...props, histories: { A: { status: "ready", hasMore: false, items: [
      { id: "question", sessionId: "A", role: "user", text: "<system-reminder>自动附带的上下文</system-reminder>\n\n我的问题", createdAt: 1, origin: "mobile" },
      { id: "reminder-only", sessionId: "A", role: "user", text: "<system-reminder>内部提示</system-reminder>", createdAt: 1, origin: "claude-desktop" },
      { id: "reply", sessionId: "A", role: "assistant", text: fullReply, createdAt: 2, origin: "claude-host" },
      { id: "notice", sessionId: "A", role: "system", text: "系统状态", createdAt: 3, origin: "system" },
    ] } } };
    draw();
    const copies = elements(tree).filter((element) => element.type === MessageCopyButton);
    expect(copies.map((element) => element.props.text)).toEqual(["我的问题", fullReply]);
    expect(copies.map((element) => element.props.label)).toEqual(["复制这条消息", "复制这条回复"]);
  });

  it("keeps each conversation's text and images when navigating between sessions", async () => {
    text("draft for A");
    selectImage(); hooks.readers[0].finish(); await settle();
    expect(imageNames()).toEqual(["移除 A.png"]);
    open("B");
    expect(input().props.value).toBe("");
    expect(imageNames()).toEqual([]);
    expect(sendButton().props.disabled).toBe(true);
    text("draft for B");
    open("A");
    expect(input().props.value).toBe("draft for A");
    expect(imageNames()).toEqual(["移除 A.png"]);
    open("B");
    form().props.onSubmit({ preventDefault() {} }); await settle();
    expect(props.onSendTurn).toHaveBeenCalledWith("B", "draft for B", [], false);
  });

  it("restores a failed send to its own session without changing the next session's draft", async () => {
    const sending = deferred();
    vi.mocked(props.onSendTurn).mockReturnValueOnce(sending.promise);
    text("retry A");
    selectImage(); hooks.readers[0].finish(); await settle();
    form().props.onSubmit({ preventDefault() {} }); draw();
    open("B"); text("keep B");
    expect(sendButton().props.disabled).toBe(false);
    sending.reject(new Error("send failed")); await settle();
    expect(input().props.value).toBe("keep B");
    expect(imageNames()).toEqual([]);
    open("A");
    expect(input().props.value).toBe("retry A");
    expect(imageNames()).toEqual(["移除 A.png"]);
  });

  it.each([true, false])("preserves a new draft typed while a send finishes (success=%s)", async (success) => {
    const sending = deferred();
    vi.mocked(props.onSendTurn).mockReturnValueOnce(sending.promise);
    text("first draft");
    form().props.onSubmit({ preventDefault() {} }); draw();
    text("next draft");
    if (success) sending.resolve(); else sending.reject(new Error("send failed"));
    await settle();
    expect(input().props.value).toBe(success ? "next draft" : "first draft\nnext draft");
    expect(sendButton().props.disabled).toBe(false);
  });

  it.each([true, false])("keeps delayed image completion in its original session (success=%s)", async (success) => {
    selectImage();
    open("B"); text("keep B");
    if (success) hooks.readers[0].finish(); else hooks.readers[0].fail();
    await settle();
    expect(imageNames()).toEqual([]);
    expect(elements(tree).some((e) => e.props.className === "composer-error")).toBe(false);
    open("A");
    if (success) expect(imageNames()).toEqual(["移除 A.png"]);
    else expect(elements(tree).find((e) => e.props.className === "composer-error")?.props.children).toBe("image read failed");
  });

  it("keeps the immediate-adjustment choice with its own conversation", async () => {
    props = { ...props, snapshot: { ...props.snapshot!, sessions: props.snapshot!.sessions.map((session) => ({ ...session, ownership: "BRIDGE_RUNNING", turnState: "running" })) } };
    draw();
    elements(tree).find((e) => e.type === "button" && e.props.children === "立即调整")!.props.onClick();
    draw();
    open("B"); text("queue B");
    form().props.onSubmit({ preventDefault() {} }); await settle();
    expect(props.onSendTurn).toHaveBeenLastCalledWith("B", "queue B", [], false);
    open("A"); text("adjust A");
    form().props.onSubmit({ preventDefault() {} }); await settle();
    expect(props.onSendTurn).toHaveBeenLastCalledWith("A", "adjust A", [], true);
  });

  it("does not reuse a draft for an equal session ID on another computer", () => {
    text("computer 1 draft");
    props = { ...props, activeHostId: "computer-2" }; draw();
    expect(input().props.value).toBe("");
    text("computer 2 draft");
    props = { ...props, activeHostId: "computer-1" }; draw();
    expect(input().props.value).toBe("computer 1 draft");
  });

  it.each([
    { connection: "closed" as const, desktopOnline: true },
    { connection: "connected" as const, desktopOnline: false },
  ])("allows local upload cancellation and uploaded-file removal offline (%j)", async (offline) => {
    const completed = { uploadId: "uploaded", name: "done.txt", path: ".bridge-uploads/done.txt", size: 8, sha256: "abc" };
    const pending = deferred();
    let signal: AbortSignal | undefined;
    props = { ...props, onUploadFile: vi.fn()
      .mockResolvedValueOnce(completed)
      .mockImplementationOnce((_sessionId, _file, _progress, nextSignal) => {
        signal = nextSignal;
        return pending.promise;
      }) };
    draw();
    let picker = elements(tree).find((element) => element.type === FileAttachmentPicker)!;
    await picker.props.state.add([{ name: "done.txt", size: 8 }]); draw();
    picker = elements(tree).find((element) => element.type === FileAttachmentPicker)!;
    const adding = picker.props.state.add([{ name: "pending.txt", size: 8 }]); draw();
    props = { ...props, ...offline }; draw();
    expect(elements(tree).find((element) => element.type === ComposerAttachmentMenu)!.props.fileDisabled).toBe(true);
    expect(sendButton().props.disabled).toBe(true);
    for (const name of ["pending.txt", "done.txt"]) {
      picker = elements(tree).find((element) => element.type === FileAttachmentPicker)!;
      const removal = elements(FileAttachmentPicker(picker.props as ComponentProps<typeof FileAttachmentPicker>))
        .find((element) => element.type === IconButton && element.props.label === `移除 ${name}`)!;
      expect(removal.props.disabled).not.toBe(true);
      removal.props.onClick(); draw();
    }
    expect(signal?.aborted).toBe(true);
    expect(elements(tree).find((element) => element.type === FileAttachmentPicker)!.props.state.entries).toEqual([]);
    pending.resolve(); await adding; await settle();
    expect(elements(tree).find((element) => element.type === FileAttachmentPicker)!.props.state.entries).toEqual([]);
    expect(props.onSendTurn).not.toHaveBeenCalled();
  });

  it("resets answers and submission state when the next permission replaces the current one", async () => {
    const first: BridgePermissionInfo = {
      requestId: "first", sessionId: "A", toolUseId: "tool-first", toolName: "AskUserQuestion",
      input: { questions: [{ question: "Which branch?", options: [{ label: "Main" }, { label: "Feature" }] }] },
      createdAt: 1, canAllowAlways: false,
    };
    props = { ...props, permissions: [first] }; draw();
    // Reconcile the public prompt by React's type/key identity, keeping its hook
    // slots separate from the workspace just as the renderer does.
    const workspaceSlots = hooks.slots;
    let promptSlots: any[] = [];
    let identity: unknown;
    let questionTree: ReactElement;
    const drawPrompt = () => {
      const prompt = elements(tree).find((element) => element.type === PermissionPrompt)!;
      if (identity !== prompt.key) promptSlots = [];
      identity = prompt.key;
      const child = PermissionPrompt(prompt.props as ComponentProps<typeof PermissionPrompt>);
      hooks.slots = promptSlots; hooks.index = 0;
      questionTree = (child.type as (props: unknown) => ReactElement)(child.props);
      hooks.slots = workspaceSlots;
      return questionTree;
    };
    drawPrompt();
    elements(questionTree!).find((element) => element.type === "input")!.props.onChange();
    drawPrompt();
    expect(elements(questionTree!).find((element) => element.props.className === "primary-button")!.props.disabled).toBe(false);
    const submitting = deferred();
    vi.mocked(props.onResolvePermission).mockReturnValueOnce(submitting.promise);
    elements(questionTree!).find((element) => element.props.className === "primary-button")!.props.onClick();
    props = { ...props, permissions: [{ ...first, requestId: "second", toolUseId: "tool-second" }] }; draw();
    drawPrompt();
    expect(elements(questionTree!).filter((element) => element.type === "input").map((element) => element.props.checked)).toEqual([false, false]);
    expect(elements(questionTree!).find((element) => element.props.className === "secondary-button")!.props.disabled).toBe(false);
    expect(elements(questionTree!).find((element) => element.props.className === "primary-button")!.props.disabled).toBe(true);
    submitting.reject(new Error("Previous answer failed")); await settle(); drawPrompt();
    expect(elements(questionTree!).some((element) => element.props.role === "alert")).toBe(false);
  });

  it("resolves the matching pending question when another question is first in the queue", () => {
    const question = { question: "Which branch?", options: [{ label: "Main" }, { label: "Feature" }] };
    const permission: BridgePermissionInfo = {
      requestId: "matching", sessionId: "A", toolUseId: "matching-tool", toolName: "AskUserQuestion",
      input: { questions: [question] }, createdAt: 2, canAllowAlways: false,
    };
    props = { ...props, permissions: [
      { ...permission, requestId: "other", input: { questions: [{ ...question, question: "Which color?" }] } },
      permission,
    ], histories: { A: { status: "ready", hasMore: false, items: [
      { id: "question", sessionId: "A", role: "assistant", text: "", createdAt: 1, origin: "claude-host", interactivePrompt: { kind: "question", questions: [question] } },
    ] } } };
    draw();
    elements(tree).find((element) => element.type === InteractivePromptCard)!.props.onSelectOption("Main");
    expect(props.onResolvePermission).toHaveBeenCalledWith("matching", "allow-once", undefined, { ...permission.input, answers: { "Which branch?": "Main" } });
    expect(props.onSendTurn).not.toHaveBeenCalled();
  });

  it("merges image and file attachment actions into a single + menu in the composer", () => {
    const onUploadFile = vi.fn().mockResolvedValue({
      uploadId: "up-1",
      name: "report.txt",
      path: ".bridge-uploads/up-1/report.txt",
      size: 12,
      sha256: "abc",
    });
    props = { ...props, onUploadFile };
    draw();
    const attachMenus = elements(tree).filter((element) => element.type === ComposerAttachmentMenu);
    expect(attachMenus).toHaveLength(1);
    expect(attachMenus[0]!.props.canAttachImages).toBe(true);
    expect(attachMenus[0]!.props.fileUploads).toBeDefined();
    expect(typeof attachMenus[0]!.props.onPickImages).toBe("function");
  });
});
