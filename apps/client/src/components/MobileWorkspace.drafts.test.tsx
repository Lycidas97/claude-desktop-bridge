import { execFileSync } from "node:child_process";
import { appendFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BridgeBackgroundTask, BridgeEvent, BridgeHistoryItem, BridgePermissionInfo, BridgeSessionInfo, BridgeSubagentSummary } from "@bridge/protocol";
import { readClaudeSessionHistoryPage } from "../../../desktop/src/transcript/claude-history.js";
import { BackgroundTaskMarker, BackgroundTasksSheet } from "./conversation/BackgroundTasks.js";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { conversationItems } from "../lib/conversation-timeline.js";
import { InteractivePromptCard, PermissionPrompt } from "./conversation/PermissionPrompts.js";
import { SubagentCard } from "./conversation/SubagentCard.js";
import { MobileWorkspace } from "./MobileWorkspace.js";
import { ComposerAttachmentMenu, FileAttachmentPicker } from "./evidence/FileAttachmentPicker.js";
import { IconButton } from "./common/IconButton.js";
import { MessageCopyButton } from "./common/MessageCopyButton.js";
import { TaskPlanCard } from "./conversation/TaskPlanCard.js";
import { SessionCreateDialog } from "./session/SessionCreateDialog.js";
import { dispatchMobileBack } from "../lib/mobile-back-navigation.js";
import { SlashCommandInput } from "./conversation/SlashCommandInput.js";
import { SessionCommandDialogs } from "./conversation/SessionCommandDialogs.js";
import { SessionConfigurationDialog } from "./session/SessionConfigurationDialog.js";
import { SessionRewindDialog } from "./conversation/SessionRewindDialog.js";
import { ConfirmationDialog } from "./common/ConfirmationDialog.js";

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

vi.mock("./evidence/MediaPreviewProvider.js", () => ({ useMediaPreview: () => vi.fn(), useMediaRequest: () => undefined }));

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
function input() { return elements(tree).find((e) => e.type === SlashCommandInput)!; }
function form() { return elements(tree).find((e) => e.type === "form" && e.props.className.startsWith("composer-form"))!; }
function sendButton() { return elements(tree).find((e) => e.type === "button" && e.props["aria-label"] === "发送")!; }
function text(value: string) { input().props.onChange(value); draw(); }
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
    source: "desktop", ownership: "DESKTOP_NATIVE_IDLE", transport: "claude-desktop-native", turnState: "idle", lastActivityAt: 1, pendingCount: 0,
    allowedActions: { canSend: true, canSteer: true, canInterrupt: true, canConfigure: true, canSwitchProvider: false, canContinueOfficial: false },
  };
  props = {
    activeHostId: "computer-1", desktopName: "Computer", connection: "connected", desktopOnline: true,
    snapshot: {
      host: { hostId: "computer-1", name: "Computer", capabilities: ["claude.native-relay.v1"], pairingEpoch: 1, relayUrl: "", online: true, lastSeenAt: 1, version: "1.0.2" },
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
    onRefreshProviders: vi.fn(),
    onDesktopAppAction: vi.fn(), onRefresh: vi.fn(), onBackToHosts: vi.fn(), onRetry: vi.fn(),
  };
  open("A");
});
afterEach(() => { hooks.effects.forEach((e) => e.cleanup?.()); vi.unstubAllGlobals(); });

describe("history pagination on upward scroll", () => {
  let stream: { scrollTop: number; scrollHeight: number; clientHeight: number; getBoundingClientRect: () => { top: number }; querySelectorAll: () => never[] };
  function scroll(top: number) {
    stream.scrollTop = top;
    elements(tree).find(element => element.props.className === "conversation-stream")!.props.onScroll({ currentTarget: stream });
  }
  beforeEach(() => {
    props = { ...props, histories: { A: { status: "ready", items: [{ id: "recent", sessionId: "A", role: "user", text: "Current history", createdAt: 1, origin: "claude-desktop" }], hasMore: true, nextCursor: "oldest-native-uuid" } } };
    draw();
    stream = { scrollTop: 0, scrollHeight: 1200, clientHeight: 400, getBoundingClientRect: () => ({ top: 0 }), querySelectorAll: () => [] };
    elements(tree).find(element => element.props.className === "conversation-stream")!.props.ref.current = stream;
  });

  it("loads one older page on upward arrival near the top without sending a message", () => {
    scroll(800);
    scroll(400);
    expect(props.onLoadOlderHistory).not.toHaveBeenCalled();
    scroll(32);
    expect(props.onLoadOlderHistory).toHaveBeenCalledExactlyOnceWith("A");
    expect(props.onSendTurn).not.toHaveBeenCalled();
  });

  it("loads when already at the top and ignores scrolling away from the threshold", () => {
    scroll(0);
    expect(props.onLoadOlderHistory).toHaveBeenCalledExactlyOnceWith("A");
    scroll(800);
    scroll(400);
    scroll(600);
    expect(props.onLoadOlderHistory).toHaveBeenCalledTimes(1);
  });

  it.each([
    { status: "loading" as const, hasMore: true, nextCursor: "older" },
    { status: "ready" as const, hasMore: false, nextCursor: "older" },
    { status: "ready" as const, hasMore: true },
  ])("does not load a page that is loading, exhausted, or lacks a cursor (%j)", history => {
    props = { ...props, histories: { A: { items: props.histories.A!.items, ...history } } };
    draw();
    scroll(800);
    scroll(0);
    expect(props.onLoadOlderHistory).not.toHaveBeenCalled();
  });

  it("shows a pagination failure and waits for an explicit retry", () => {
    props = { ...props, histories: { A: { ...props.histories.A!, error: "Network unavailable" } } };
    draw();
    scroll(800);
    scroll(0);
    scroll(40);
    scroll(0);
    expect(props.onLoadOlderHistory).not.toHaveBeenCalled();
    expect(elements(tree).some(element => element.props.children === "Network unavailable")).toBe(true);
    const button = elements(tree).find(element => element.props.className === "load-older-button")!;
    expect(elements(button).some(element => Array.isArray(element.props.children) && element.props.children.includes("重试加载更早消息"))).toBe(true);
    button.props.onClick();
    expect(props.onLoadOlderHistory).toHaveBeenCalledExactlyOnceWith("A");
    expect(props.histories.A!.items.map(item => item.id)).toEqual(["recent"]);
    props = { ...props, histories: { A: { ...props.histories.A!, status: "loading" } } };
    draw();
    expect(elements(tree).some(element => element.props.children === "Network unavailable")).toBe(true);
    expect(elements(tree).find(element => element.props.className === "load-older-button")!.props.disabled).toBe(true);
    scroll(40);
    scroll(0);
    expect(props.onLoadOlderHistory).toHaveBeenCalledTimes(1);
    expect(props.onSendTurn).not.toHaveBeenCalled();
  });
});

describe("image selection completeness", () => {
  it("keeps all five selected images and sends all five", async () => {
    const picker = elements(tree).find(e => e.type === "input" && e.props.accept?.startsWith("image/"))!;
    const selecting = picker.props.onChange({ target: { files: Array.from({ length: 5 }, (_, index) => ({ name: `${index + 1}.png`, type: "image/png", size: 8 })) } });
    hooks.readers.forEach(reader => reader.finish());
    await selecting; await settle();
    expect(imageNames()).toEqual(["移除 1.png", "移除 2.png", "移除 3.png", "移除 4.png", "移除 5.png"]);
    await form().props.onSubmit({ preventDefault() {} });
    expect(props.onSendTurn).toHaveBeenCalledWith("A", "", expect.arrayContaining(Array.from({ length: 5 }, (_, index) => expect.objectContaining({ name: `${index + 1}.png` }))), false);
    expect(vi.mocked(props.onSendTurn).mock.calls[0]![2]).toHaveLength(5);
  });
});

describe("mobile session deletion confirmation", () => {
  it.each(["claude-desktop", "codex-desktop", "hermes-desktop", "dsh-desktop"] as const)("describes the actual deletion target for %s without deleting on review", runtimeId => {
    props = { ...props, onDeleteSession: vi.fn(), snapshot: { ...props.snapshot!, sessions: props.snapshot!.sessions.map(session => ({
      ...session, runtimeId, transport: runtimeId === "claude-desktop" ? "claude-desktop-native" : "bridge-host",
    })) } };
    draw();
    const header = elements(tree).find(element => element.props.backLabel === "返回会话列表")!;
    elements(header.props.actions).find(element => element.type === IconButton && element.props.label === "会话操作")!.props.onClick(); draw();
    const action = elements(tree).find(element => element.props.label === "删除会话")!;
    action.props.onClick(); draw();
    const confirmation = elements(tree).find(element => element.type === ConfirmationDialog && element.props.title === "删除会话")!;
    expect(confirmation.props.open).toBe(true);
    if (runtimeId === "claude-desktop") {
      expect(confirmation.props.description).toContain("从 Claude Desktop 中删除「Session A」会话");
      expect(confirmation.props.description).not.toContain("原生会话与文件不受影响");
      expect(confirmation.props.description).not.toContain("从 Bridge 列表中删除");
      expect(action.props.detail).toBe("删除 Claude Desktop 中的会话");
    } else {
      expect(confirmation.props.description).toBe("从 Bridge 列表中删除「Session A」？对应 Desktop 应用中的原生会话与文件不受影响；Bridge 中的会话配置、排队与授权记录会被清除，此操作不可恢复。");
      expect(action.props.detail).toBe("仅从 Bridge 移除，Desktop 原会话保留");
    }
    expect(confirmation.props.description).toContain("此操作不可恢复");
    confirmation.props.onCancel(); draw();
    expect(props.onDeleteSession).not.toHaveBeenCalled();
  });
});

describe("mobile custom command input", () => {
  it.each([undefined, "claude-desktop", "codex-desktop", "hermes-desktop", "dsh-desktop"] as const)("only loads Claude commands for runtime %s", async runtimeId => {
    const catalog = { sessionId: "A", commands: [{ name: "review", description: "检查变更" }] };
    const load = vi.fn().mockResolvedValue(catalog);
    props = { ...props, onLoadSessionCommands: load, snapshot: { ...props.snapshot!,
      host: { ...props.snapshot!.host, capabilities: ["claude.native-relay.v1", "session.commands.v1"] },
      sessions: props.snapshot!.sessions.map(session => ({ ...session, ...(runtimeId ? { runtimeId } : {}) })),
    } };
    draw();
    if (runtimeId === undefined || runtimeId === "claude-desktop") {
      await expect(input().props.onLoad()).resolves.toEqual(catalog);
      expect(load).toHaveBeenCalledExactlyOnceWith("A");
    } else {
      expect(input().props.onLoad).toBeUndefined();
      expect(load).not.toHaveBeenCalled();
    }
    expect(props.onLoadSessionConfiguration).not.toHaveBeenCalled();
    expect(props.onSendTurn).not.toHaveBeenCalled();
  });

  it("retains text, image, and the autoheight ref when the input changes without sending", async () => {
    text("/re");
    selectImage(); hooks.readers[0].finish(); await settle();
    expect(input().props.textareaRef).toBeDefined();
    input().props.onChange("/review "); draw();
    expect(input().props.value).toBe("/review ");
    expect(imageNames()).toEqual(["移除 A.png"]);
    expect(props.onSendTurn).not.toHaveBeenCalled();
  });

  it("isolates menu state by host and logical fork session, and omits loaders for old hosts", () => {
    props = { ...props, onLoadSessionCommands: vi.fn(), snapshot: { ...props.snapshot!, host: { ...props.snapshot!.host, capabilities: ["claude.native-relay.v1", "session.commands.v1"] } } };
    draw();
    const originalKey = input().key;
    open("B");
    expect(input().key).not.toBe(originalKey);
    const otherSessionKey = input().key;
    props = { ...props, activeHostId: "computer-2" }; draw();
    expect(input().key).not.toBe(otherSessionKey);
    props = { ...props, snapshot: { ...props.snapshot!, host: { ...props.snapshot!.host, capabilities: [] } } }; draw();
    expect(input().props.onLoad).toBeUndefined();
  });
});

describe("native relay composer", () => {
  it("sends directly without a Host execution flag or handoff confirmation", async () => {
    text("Native input");
    await form().props.onSubmit({ preventDefault() {} }); await settle();
    expect(props.onSendTurn).toHaveBeenCalledExactlyOnceWith("A", "Native input", [], false);
    expect(elements(tree).some(element => element.type === ConfirmationDialog && element.props.title === "由 Bridge 继续执行？")).toBe(false);
  });

  it("keeps a legacy Claude snapshot read-only even when its old actions claim it can send", async () => {
    props = { ...props, snapshot: { ...props.snapshot!, host: { ...props.snapshot!.host, capabilities: [] },
      sessions: props.snapshot!.sessions.map(session => ({ ...session, transport: "bridge-host", ownership: "BRIDGE_IDLE" })) } };
    draw(); text("Retain draft");
    expect(input().props.disabled).toBe(true);
    await form().props.onSubmit({ preventDefault() {} }); await settle();
    expect(props.onSendTurn).not.toHaveBeenCalled();
    expect(input().props.value).toBe("Retain draft");
    props = { ...props, permissions: [{ requestId: "retired-permission", sessionId: "A", toolUseId: "old-tool", toolName: "Bash", input: {}, createdAt: 1, canAllowAlways: true }] };
    draw();
    expect(elements(tree).some(element => element.type === "button" && element.props.className === "permission-dock")).toBe(false);
  });

});

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

describe("background tasks", () => {
  function agents(count: number, extra: (index: number) => Partial<BridgeSubagentSummary> = () => ({}), backgroundTasks?: BridgeBackgroundTask[]) {
    const now = Date.now();
    props = { ...props, onStopSubagent: vi.fn().mockResolvedValue(undefined),
      snapshot: { ...props.snapshot!, sessions: props.snapshot!.sessions.map(session => ({
        ...session, subagentStopScope: "task" as const, ...(backgroundTasks ? { backgroundTasks } : {}),
      })) },
      histories: { ...props.histories, A: { status: "ready", hasMore: false, items: Array.from({ length: count }, (_, index) => ({
        id: `tool:agent-tool-${index}`, sessionId: "A", role: "tool" as const, text: "", toolName: "Agent", createdAt: now + index, origin: "claude-host" as const,
        subagent: { agentId: `agent-${index}`, toolUseId: `agent-tool-${index}`, description: `子代理 ${index + 1}`, state: "running" as const, toolCount: 1, startedAt: now + index, updatedAt: now + index, ...extra(index) },
      })) } },
    };
    draw();
  }
  const markers = () => elements(tree).filter(element => element.type === BackgroundTaskMarker);
  const traySheet = () => elements(tree).find(element => element.type === BackgroundTasksSheet);
  const trayButton = () => {
    const header = elements(tree).find(element => element.props.backLabel === "返回会话列表")!;
    return elements(header.props.actions).find(element => element.type === IconButton && element.props.label.startsWith("后台任务"));
  };
  const running: BridgeBackgroundTask = {
    id: "agent-tool-0", kind: "subagent", taskId: "agent-0", toolUseId: "agent-tool-0", description: "子代理 1", state: "running", startedAt: 1, updatedAt: 2,
  };
  const shell: BridgeBackgroundTask = {
    id: "bash-call", kind: "bash", taskId: "bsh01", toolUseId: "bash-call", description: "Start dev server", state: "completed", startedAt: 1, updatedAt: 2,
  };

  it("loads selected-session task details without putting them in the directory", async () => {
    props = { ...props, onLoadBackgroundTasks: vi.fn().mockResolvedValue([running, shell]) };
    draw(); await settle();
    expect(props.onLoadBackgroundTasks).toHaveBeenCalledExactlyOnceWith("A");
    expect(trayButton()!.props.label).toBe("后台任务，1 个运行中");
    props = { ...props, snapshot: { ...props.snapshot!, sessions: props.snapshot!.sessions.map(session => ({ ...session })) } };
    draw();
    trayButton()!.props.onClick(); draw();
    expect(traySheet()!.props.tasks).toEqual([running, shell]);
    expect(props.snapshot!.sessions.every(session => session.backgroundTasks === undefined)).toBe(true);
  });

  it("keeps a late task response in its original conversation", async () => {
    const pending = deferred();
    props = { ...props, onLoadBackgroundTasks: vi.fn((id: string) => id === "A" ? pending.promise.then(() => [running]) : Promise.resolve([shell])) };
    draw(); open("B"); await settle();
    pending.resolve(); await settle();
    expect(trayButton()!.props.label).toBe("后台任务");
    trayButton()!.props.onClick(); draw();
    expect(traySheet()!.props.tasks).toEqual([shell]);
  });

  it("waits for initial history before loading task details", async () => {
    props = { ...props, onLoadBackgroundTasks: vi.fn().mockResolvedValue([running]), histories: { ...props.histories, A: { status: "loading", items: [], hasMore: false } } };
    draw(); await settle();
    expect(props.onLoadBackgroundTasks).not.toHaveBeenCalled();
    props = { ...props, histories: { ...props.histories, A: { status: "ready", items: [], hasMore: false } } };
    draw(); await settle();
    expect(props.onLoadBackgroundTasks).toHaveBeenCalledExactlyOnceWith("A");
  });

  it("refreshes task progress only while the selected conversation is visible", async () => {
    vi.useFakeTimers();
    try {
      props = { ...props, onLoadBackgroundTasks: vi.fn().mockResolvedValueOnce([running]).mockResolvedValue([shell]) };
      draw(); await settle();
      expect(trayButton()!.props.label).toBe("后台任务，1 个运行中");
      await vi.advanceTimersByTimeAsync(2_000); await settle();
      expect(trayButton()!.props.label).toBe("后台任务");
      props = { ...props, visible: false }; draw();
      await vi.advanceTimersByTimeAsync(4_000); await settle();
      expect(props.onLoadBackgroundTasks).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });

  it.each([0, 1, 4, 8])("shows each of %s subagents as one line instead of an inline card", count => {
    agents(count);
    expect(markers()).toHaveLength(count);
    expect(elements(tree).filter(element => element.type === SubagentCard)).toHaveLength(0);
  });

  it("gives a workflow run one line for all of its agents", () => {
    agents(5, index => index < 4 ? { workflowRunId: "wf_1", workflowPhase: index < 2 ? "Draft" : "Check" } : {});
    expect(markers().map(marker => marker.key)).toEqual(["A:workflow:wf_1", "A:tool:agent-tool-4"]);
  });

  it("shows the header entry only when the session has background tasks, counting running ones", () => {
    agents(1);
    expect(trayButton()).toBeUndefined();
    agents(1, () => ({}), [running, shell]);
    expect(trayButton()!.props.label).toBe("后台任务，1 个运行中");
    agents(1, () => ({}), [shell]);
    expect(trayButton()!.props.label).toBe("后台任务");
  });

  it("opens the tray from the header and from a line focused on its item, and closes it on back", () => {
    agents(2, () => ({}), [running, shell]);
    trayButton()!.props.onClick(); draw();
    expect(traySheet()!.props.tasks).toEqual([running, shell]);
    expect(traySheet()!.props.focus).toBeUndefined();
    expect(dispatchMobileBack()).toBe(true); draw();
    expect(traySheet()).toBeUndefined();
    expect(markers()[0]!.props.task).toBe(running);
    markers()[1]!.props.onOpen(); draw();
    expect(traySheet()!.props.focus.id).toBe("tool:agent-tool-1");
    expect(traySheet()!.props.renderSubagent(props.histories.A!.items[1]).props.collapsible).toBe(false);
    expect(dispatchMobileBack()).toBe(true); draw();
    expect(traySheet()).toBeUndefined();
  });

  it("keeps the stop action on subagent cards inside the tray", async () => {
    agents(2, () => ({}), [running]);
    markers()[0]!.props.onOpen(); draw();
    const card = traySheet()!.props.renderSubagent(props.histories.A!.items[0]);
    card.props.onStop(); draw();
    const confirmation = elements(tree).find(element => element.props.title === "停止这个子代理？")!;
    expect(confirmation.props.description).toContain("子代理 1");
    await confirmation.props.onConfirm();
    expect(props.onStopSubagent).toHaveBeenCalledWith("A", "agent-0");
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

describe("mobile section creation", () => {
  let create: ReturnType<typeof vi.fn>;
  const createAction = () => elements(tree).find(element => element.props.label === "新建 Section");
  const dialog = () => elements(tree).find(element => element.props.role === "dialog" && element.props["aria-label"] === "新建 Section");
  const nameInput = () => elements(dialog()).find(element => element.type === "input")!;
  const submitButton = () => elements(dialog()).find(element => element.type === "button" && element.props.type === "submit")!;
  function enable(capable = true) {
    create = vi.fn().mockResolvedValue({ ...props.snapshot!.projects[0], projectId: "new-section", name: "Research", kind: "desktop-group", sessionCount: 0 });
    props = Object.assign({ ...props, snapshot: { ...props.snapshot!, host: {
      ...props.snapshot!.host, capabilities: ["claude.native-relay.v1" as const, ...(capable ? ["section.create.v1" as const] : [])],
    } } }, { onCreateSection: create });
    draw();
    elements(tree).find(element => element.props.backLabel === "返回会话列表")!.props.onBack(); draw();
    const header = elements(tree).find(element => element.props.title === "会话" && element.props.actions)!;
    elements(header.props.actions).find(element => element.type === IconButton && element.props.label === "目录选项")!.props.onClick(); draw();
  }
  function openCreate() { enable(); createAction()!.props.onClick(); draw(); }
  function editName(value: string) { nameInput().props.onChange({ target: { value } }); draw(); }
  async function submit() {
    elements(dialog()).find(element => element.type === "form")!.props.onSubmit({ preventDefault() {} });
    await settle();
  }

  it("offers native section creation in the catalog menu", () => {
    enable();
    expect(createAction()).toBeDefined();
  });
  it("submits a trimmed name and closes after native success", async () => {
    openCreate(); editName("  Research  ");
    await submit();
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0]![0]).toBe("Research");
    expect(dialog()).toBeUndefined();
  });
  it("keeps blank names disabled without a native write", async () => {
    openCreate(); editName("   ");
    expect(submitButton().props.disabled).toBe(true);
    await submit();
    expect(create).not.toHaveBeenCalled();
    expect(dialog()).toBeDefined();
  });
  it("cancels the name draft without a native write", () => {
    openCreate(); editName("Cancelled");
    elements(dialog()).find(element => element.type === "button" && element.props.children === "取消")!.props.onClick(); draw();
    expect(create).not.toHaveBeenCalled();
    expect(dialog()).toBeUndefined();
  });
  it("preserves the name and displays a native failure", async () => {
    openCreate(); editName("Research"); create.mockRejectedValue(new Error("原生分组创建失败"));
    await submit();
    expect(nameInput().props.value).toBe("Research");
    expect(elements(dialog()).find(element => element.props.role === "alert")!.props.children).toBe("原生分组创建失败");
  });
  it("disables submission if the computer disconnects while editing", async () => {
    openCreate(); editName("Research");
    props = { ...props, connection: "reconnecting", desktopOnline: false }; draw();
    expect(submitButton().props.disabled).toBe(true);
    await submit();
    expect(create).not.toHaveBeenCalled();
  });
  it("omits creation for older hosts without the capability", () => {
    enable(false);
    expect(createAction()).toBeUndefined();
    expect(create).not.toHaveBeenCalled();
  });
  it("shows an empty native section on a computer without sessions", () => {
    props = { ...props, snapshot: { ...props.snapshot!, sessions: [], projects: [{
      ...props.snapshot!.projects[0]!, projectId: "empty-section", name: "Research", cwd: "", kind: "desktop-group", sessionCount: 0,
    }] } };
    draw();
    expect(elements(tree).some(element => element.type === "strong" && element.props.children === "Research")).toBe(true);
    expect(elements(tree).some(element => element.props.children === "暂未发现 Desktop 会话")).toBe(false);
  });
  it("searches empty native sections by name without exposing empty directories", () => {
    props = { ...props, snapshot: { ...props.snapshot!, sessions: [], projects: [
      { ...props.snapshot!.projects[0]!, projectId: "empty-section", name: "Research", cwd: "", kind: "desktop-group", sessionCount: 0 },
      { ...props.snapshot!.projects[0]!, projectId: "empty-directory", name: "Empty directory", kind: "directory", sessionCount: 0 },
    ] } };
    draw();
    const search = () => elements(tree).find(element => element.type === "input" && element.props.placeholder === "搜索项目或会话")!;
    search().props.onChange({ target: { value: "rese" } }); draw();
    expect(elements(tree).some(element => element.type === "strong" && element.props.children === "Research")).toBe(true);
    search().props.onChange({ target: { value: "empty" } }); draw();
    expect(elements(tree).some(element => element.type === "strong" && element.props.children === "Research")).toBe(false);
    expect(elements(tree).some(element => element.type === "strong" && element.props.children === "Empty directory")).toBe(false);
  });
});

describe("mobile session renaming", () => {
  function enableRename() {
    props = { ...props, onRenameSession: vi.fn().mockResolvedValue(undefined),
      snapshot: { ...props.snapshot!, host: { ...props.snapshot!.host, capabilities: ["claude.native-relay.v1", "session.rename.v1"] } },
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

describe("actions on messages already queued in native Desktop", () => {
  function queued(message = "排队中的指令") {
    props = { ...props, onSteerQueuedTurn: vi.fn().mockResolvedValue(undefined), onCancelQueuedTurn: vi.fn().mockResolvedValue(undefined),
      snapshot: { ...props.snapshot!, sessions: props.snapshot!.sessions.map(session => session.sessionId === "A"
        ? { ...session, pendingCount: 1, pendingCommandIds: ["queued-command"], allowedActions: { ...session.allowedActions!, canSteer: false } } : session) },
      localTurns: [{ requestId: "original-request", idempotencyKey: "original-key", sessionId: "A", text: message,
        attachments: [{ id: "image", name: "context.png", mimeType: "image/png", size: 7 }], createdAt: 10, delivery: "queued", commandId: "queued-command" }],
    };
    draw();
  }
  const action = (label: string) => elements(tree).find(element => element.type === "button" && element.props.children === label);
  const actions = () => elements(tree).filter(element => element.type === "button" && /queued-(steer|cancel)-button/u.test(element.props.className ?? ""));

  it.each(["Send now", "撤回"])("%s targets the original command while idle, retains the text and image draft, and never resends or interrupts", async label => {
    queued();
    text("尚未发送的草稿");
    const selecting = selectImage(); hooks.readers[0].finish(); await selecting; await settle();
    const original = props.localTurns[0];
    expect(actions().map(element => element.props.children)).toEqual(["Send now", "撤回"]);
    await action(label)!.props.onClick(); draw();
    expect(label === "Send now" ? props.onSteerQueuedTurn : props.onCancelQueuedTurn).toHaveBeenCalledExactlyOnceWith("A", "queued-command");
    expect(label === "Send now" ? props.onCancelQueuedTurn : props.onSteerQueuedTurn).not.toHaveBeenCalled();
    expect(props.onSendTurn).not.toHaveBeenCalled();
    expect(props.onInterruptTurn).not.toHaveBeenCalled();
    expect(props.localTurns[0]).toBe(original);
    expect(input().props.value).toBe("尚未发送的草稿");
    expect(imageNames()).toEqual(["移除 A.png"]);
    expect(actions().map(element => element.props.disabled)).toEqual([true, label === "撤回"]);
    props = { ...props, snapshot: { ...props.snapshot!, sessions: props.snapshot!.sessions.map(session => ({ ...session, pendingCount: 0, pendingCommandIds: [] })) } };
    draw();
    expect(actions()).toHaveLength(0);
  });

  it.each(["submitted", "session-received"] as const)("shows Send now for a %s native receipt without a queued lifecycle event", async delivery => {
    queued();
    props = { ...props, snapshot: { ...props.snapshot!, sessions: props.snapshot!.sessions.map(session => session.sessionId === "A" ? { ...session, pendingCount: 0, pendingCommandIds: [], turnState: "running" } : session) }, localTurns: props.localTurns.map(turn => ({ ...turn, messageId: "received-native-uuid", delivery })) };
    draw();
    expect(actions().map(element => element.props.children)).toEqual(["Send now", "撤回"]);
    await action("Send now")!.props.onClick();
    expect(props.onSteerQueuedTurn).toHaveBeenCalledExactlyOnceWith("A", "queued-command");
    expect(props.onSendTurn).not.toHaveBeenCalled();
    expect(props.onInterruptTurn).not.toHaveBeenCalled();
  });

  it.each(["queued", "session-received"] as const)("opens native rewind preview for a %s message while work is running", async delivery => {
    queued();
    props = { ...props,
      onPreviewRewind: vi.fn().mockResolvedValue({ sessionId: "A", messageId: "received-native-uuid", canRewindConversation: true, canRewindFiles: false, filesChanged: [] }),
      onRewindSession: vi.fn(),
      snapshot: { ...props.snapshot!, host: { ...props.snapshot!.host, capabilities: [...props.snapshot!.host.capabilities, "session.rewind.v1"] }, sessions: props.snapshot!.sessions.map(session => session.sessionId === "A" ? { ...session, turnState: "running" } : session) },
      localTurns: props.localTurns.map(turn => ({ ...turn, messageId: "received-native-uuid", delivery })),
    };
    draw();
    const rewind = elements(tree).find(element => element.props["aria-label"] === "回退到这条消息之前");
    expect(rewind).toBeDefined();
    expect(rewind!.props.disabled).toBe(false);
    rewind!.props.onClick(); draw();
    const dialog = elements(tree).find(element => element.type === SessionRewindDialog)!;
    expect(dialog.props.initialMessageId).toBe("received-native-uuid");
    expect(dialog.props.disabled).toBe(false);
    await dialog.props.onPreview("received-native-uuid");
    expect(props.onPreviewRewind).toHaveBeenCalledExactlyOnceWith("A", "received-native-uuid");
    expect(props.onCancelQueuedTurn).not.toHaveBeenCalled();
    expect(props.onSendTurn).not.toHaveBeenCalled();
    expect(props.onInterruptTurn).not.toHaveBeenCalled();
  });

  it.each(["Send now", "撤回"])("%s works for an attachment-only queued message", async label => {
    queued("");
    expect(actions()).toHaveLength(2);
    await action(label)!.props.onClick();
    expect(label === "Send now" ? props.onSteerQueuedTurn : props.onCancelQueuedTurn).toHaveBeenCalledWith("A", "queued-command");
    expect(props.onSendTurn).not.toHaveBeenCalled();
    expect(props.onInterruptTurn).not.toHaveBeenCalled();
  });

  it.each(["Send now", "撤回"])("%s disables both actions while pending, shows failure on the original session, and allows retry", async label => {
    queued();
    const held = deferred();
    const callback = vi.fn().mockImplementationOnce(() => held.promise).mockResolvedValue(undefined);
    props = { ...props, ...(label === "Send now" ? { onSteerQueuedTurn: callback } : { onCancelQueuedTurn: callback }) };
    draw();
    const pending = action(label)!.props.onClick(); draw();
    expect(actions().every(element => element.props.disabled)).toBe(true);
    expect(action(label)!.props["aria-busy"]).toBe(true);
    open("B");
    held.reject(new Error("电脑响应超时，请重试")); await pending; draw();
    expect(elements(tree).some(element => element.props.role === "alert" && element.props.children === "电脑响应超时，请重试")).toBe(false);
    open("A");
    expect(actions().every(element => !element.props.disabled)).toBe(true);
    expect(elements(tree).some(element => element.props.role === "alert" && element.props.children === "电脑响应超时，请重试")).toBe(true);
    await action(label)!.props.onClick(); draw();
    expect(callback).toHaveBeenCalledTimes(2);
    expect(elements(tree).some(element => element.props.role === "alert" && element.props.children === "电脑响应超时，请重试")).toBe(false);
    expect(props.onSendTurn).not.toHaveBeenCalled();
    expect(props.onInterruptTurn).not.toHaveBeenCalled();
  });

  it.each(["offline", "disconnected"])("disables both actions while %s", status => {
    queued();
    props = status === "offline" ? { ...props, desktopOnline: false } : { ...props, connection: "closed" };
    draw();
    expect(actions()).toHaveLength(2);
    expect(actions().every(element => element.props.disabled && element.props.title.includes("离线"))).toBe(true);
  });

  it("offers host-received compatibility only while the command is confirmed pending", () => {
    queued();
    props = { ...props, localTurns: props.localTurns.map(turn => ({ ...turn, delivery: "host-received" })) };
    draw(); expect(actions()).toHaveLength(2);
    props = { ...props, snapshot: { ...props.snapshot!, sessions: props.snapshot!.sessions.map(session => ({ ...session, pendingCommandIds: [] })) } };
    draw(); expect(actions()).toHaveLength(0);
  });

  it("can withdraw a message that remains queued after Send now succeeds", async () => {
    queued();
    await action("Send now")!.props.onClick(); draw();
    expect(action("撤回")!.props.disabled).toBe(false);
    await action("撤回")!.props.onClick(); draw();
    expect(props.onSteerQueuedTurn).toHaveBeenCalledExactlyOnceWith("A", "queued-command");
    expect(props.onCancelQueuedTurn).toHaveBeenCalledExactlyOnceWith("A", "queued-command");
    expect(props.onSendTurn).not.toHaveBeenCalled();
    expect(props.onInterruptTurn).not.toHaveBeenCalled();
  });

  it("offers history-only queued actions and removes them when its cancellation receipt arrives", async () => {
    queued();
    const item: BridgeHistoryItem & { commandId: string } = {
      id: "history-uuid", sessionId: "A", role: "user", text: "排队中的指令", createdAt: 10, origin: "claude-desktop", delivery: "queued", commandId: "queued-command",
    };
    props = { ...props, localTurns: [], histories: { A: { status: "ready", hasMore: false, items: [item] } } };
    draw(); expect(actions()).toHaveLength(2);
    await action("撤回")!.props.onClick();
    props = { ...props, events: [{ eventId: "cancelled", seq: 1, timestamp: 20, sessionId: "A", origin: "claude-desktop", type: "message.delivery",
      itemId: "history-uuid", data: { commandId: "queued-command", messageId: "history-uuid", delivery: "cancelled" } }] };
    draw(); expect(actions()).toHaveLength(0);
    expect(props.onInterruptTurn).not.toHaveBeenCalled();
  });

  it.each(["Send now", "撤回"])("shows only the supported callback action when %s is missing", missing => {
    queued();
    if (missing === "Send now") delete props.onSteerQueuedTurn;
    else delete props.onCancelQueuedTurn;
    draw();
    expect(actions().map(element => element.props.children)).toEqual([missing === "Send now" ? "撤回" : "Send now"]);
  });

  it.each(["Send now", "撤回"])("keeps %s pending across a connection flap without resubmitting or losing the draft", async label => {
    queued(); text("连接恢复后仍保留");
    const held = deferred();
    const callback = vi.fn(() => held.promise);
    props = { ...props, ...(label === "Send now" ? { onSteerQueuedTurn: callback } : { onCancelQueuedTurn: callback }) };
    draw();
    const pending = action(label)!.props.onClick(); draw();
    props = { ...props, connection: "closed", desktopOnline: false }; draw();
    expect(actions().every(button => button.props.disabled)).toBe(true);
    props = { ...props, connection: "connected", desktopOnline: true }; draw();
    expect(actions().every(button => button.props.disabled)).toBe(true);
    expect(callback).toHaveBeenCalledTimes(1);
    held.reject(new Error("操作结果未确认")); await pending; draw();
    expect(actions().every(button => !button.props.disabled)).toBe(true);
    expect(input().props.value).toBe("连接恢复后仍保留");
    expect(props.onSendTurn).not.toHaveBeenCalled();
    expect(props.onInterruptTurn).not.toHaveBeenCalled();
  });

  it.each(["Send now", "撤回"])("does not attach a pending %s failure to another host with identical session and command IDs", async label => {
    queued(); text("电脑一草稿");
    const held = deferred();
    props = { ...props, ...(label === "Send now" ? { onSteerQueuedTurn: vi.fn(() => held.promise) } : { onCancelQueuedTurn: vi.fn(() => held.promise) }) };
    draw(); const pending = action(label)!.props.onClick(); draw();
    props = { ...props, activeHostId: "computer-2", snapshot: { ...props.snapshot!, host: { ...props.snapshot!.host, hostId: "computer-2" } } };
    open("A"); text("电脑二草稿");
    expect(actions().every(button => !button.props.disabled)).toBe(true);
    held.reject(new Error("仅电脑一操作失败")); await pending; draw();
    expect(elements(tree).some(element => element.props.role === "alert" && element.props.children === "仅电脑一操作失败")).toBe(false);
    expect(input().props.value).toBe("电脑二草稿");
    props = { ...props, activeHostId: "computer-1", snapshot: { ...props.snapshot!, host: { ...props.snapshot!.host, hostId: "computer-1" } } };
    open("A");
    expect(elements(tree).some(element => element.props.role === "alert" && element.props.children === "仅电脑一操作失败")).toBe(true);
    expect(input().props.value).toBe("电脑一草稿");
  });

  it("keeps two identical queued messages independently actionable while one request is pending", async () => {
    queued("同文消息");
    props = { ...props, snapshot: { ...props.snapshot!, sessions: props.snapshot!.sessions.map(session => session.sessionId === "A"
      ? { ...session, pendingCount: 2, pendingCommandIds: ["queued-command", "second-command"] } : session) },
      localTurns: [...props.localTurns, { ...props.localTurns[0]!, requestId: "second-request", commandId: "second-command", idempotencyKey: "second-key", createdAt: 11 }] };
    const held = deferred(); props = { ...props, onCancelQueuedTurn: vi.fn().mockImplementationOnce(() => held.promise).mockResolvedValue(undefined) };
    draw();
    const articles = elements(tree).filter(element => element.type === "article" && element.props.className.includes("user"));
    const first = elements(articles[0]).find(button => button.type === "button" && button.props.children === "撤回")!;
    const pending = first.props.onClick(); draw();
    const rows = elements(tree).filter(element => element.type === "article" && element.props.className.includes("user"));
    expect(elements(rows[0]).filter(button => /queued-(steer|cancel)-button/u.test(button.props.className ?? "")).every(button => button.props.disabled)).toBe(true);
    const second = elements(rows[1]).find(button => button.type === "button" && button.props.children === "撤回")!;
    expect(second.props.disabled).toBe(false); await second.props.onClick();
    held.resolve(); await pending; draw();
    expect(props.onCancelQueuedTurn).toHaveBeenNthCalledWith(1, "A", "queued-command");
    expect(props.onCancelQueuedTurn).toHaveBeenNthCalledWith(2, "A", "second-command");
    expect(props.onSendTurn).not.toHaveBeenCalled();
  });

  it.each(["running", "completed", "cancelled"] as const)("hides actions when native state becomes %s while a request is pending", async delivery => {
    queued(); text("保留草稿");
    const held = deferred(); props = { ...props, onSteerQueuedTurn: vi.fn(() => held.promise) }; draw();
    const pending = action("Send now")!.props.onClick(); draw();
    props = { ...props, localTurns: props.localTurns.map(turn => ({ ...turn, delivery })), snapshot: { ...props.snapshot!, sessions: props.snapshot!.sessions.map(session => ({ ...session, pendingCount: 0, pendingCommandIds: [] })) } };
    draw(); expect(actions()).toHaveLength(0);
    held.resolve(); await pending; draw(); expect(actions()).toHaveLength(0);
    expect(input().props.value).toBe("保留草稿");
    expect(props.localTurns[0]?.delivery).toBe(delivery);
    expect(props.onInterruptTurn).not.toHaveBeenCalled();
  });

  it("preserves command action state when Send now rekeys the bubble", async () => {
    queued(); props = { ...props, localTurns: props.localTurns.map(turn => ({ ...turn, messageId: "old-queue-uuid" })) }; draw();
    await action("Send now")!.props.onClick(); draw();
    props = { ...props, localTurns: props.localTurns.map(turn => ({ ...turn, messageId: "new-queue-uuid" })), events: [{ eventId: "rekey", seq: 1, timestamp: 20, sessionId: "A", origin: "claude-desktop", type: "message.delivery", data: { commandId: "queued-command", previousMessageId: "old-queue-uuid", messageId: "new-queue-uuid", delivery: "queued" } }] };
    draw(); expect(action("Send now")!.props.disabled).toBe(true); expect(action("撤回")!.props.disabled).toBe(false);
    expect(elements(tree).filter(element => element.type === "article" && element.props.className.includes("user"))).toHaveLength(1);
    await action("撤回")!.props.onClick();
    expect(props.onCancelQueuedTurn).toHaveBeenCalledExactlyOnceWith("A", "queued-command");
  });

  it.each(["unsupported-host", "unsupported-runtime", "cannot-send", "not-native", "not-queued", "local-saved", "relay-received", "running", "completed"])("hides inapplicable native queue actions: %s", status => {
    queued();
    if (["local-saved", "relay-received", "session-received", "running", "completed"].includes(status)) {
      props = { ...props, localTurns: props.localTurns.map(turn => ({ ...turn, delivery: status as typeof turn.delivery })) };
    }
    props = { ...props, snapshot: { ...props.snapshot!,
      ...(status === "unsupported-host" ? { host: { ...props.snapshot!.host, capabilities: [] } } : {}),
      sessions: props.snapshot!.sessions.map(session => ({ ...session,
        ...(status === "unsupported-runtime" ? { runtimeId: "codex-desktop" as const } : {}),
        ...(status === "cannot-send" ? { allowedActions: { ...session.allowedActions!, canSend: false } } : {}),
        ...(status === "not-native" ? { transport: "bridge-host" as const } : {}),
        ...(status === "not-queued" ? { pendingCount: 0, pendingCommandIds: [] } : {}),
      })),
    } };
    draw(); expect(actions()).toHaveLength(0);
  });
});

describe("native structured approvals", () => {
  function nativePrompt(prompt: NonNullable<ComponentProps<typeof InteractivePromptCard>["prompt"]>, id = "tool:native-question") {
    props = { ...props, snapshot: { ...props.snapshot!, sessions: props.snapshot!.sessions.map(session => session.sessionId === "A"
      ? { ...session, source: "desktop", transport: "claude-desktop-native", ownership: "DESKTOP_NATIVE_IDLE", runtimeId: "claude-desktop" } : session) },
      histories: { ...props.histories, A: { status: "ready", hasMore: false, items: [
        { id, sessionId: "A", role: "assistant", toolName: prompt.kind === "question" ? "AskUserQuestion" : "mcp__ccd_turn__wrap_up", text: "", createdAt: 1, origin: "claude-desktop", interactivePrompt: { ...prompt, toolUseId: "native-question" } },
      ] } } };
    draw();
    return elements(tree).find(element => element.type === InteractivePromptCard)!;
  }

  it.each(["history", "streaming", "completed"] as const)("keeps the current native question after the latest %s output without moving its context", stage => {
    const question = { question: "接下来检查什么？", options: [{ label: "检查全文" }] };
    props = { ...props, permissions: [{ requestId: "pending-question", sessionId: "A", toolUseId: "native-question", toolName: "AskUserQuestion", input: { questions: [question] }, createdAt: 1, canAllowAlways: false }] };
    nativePrompt({ kind: "question", questions: [question] });
    const prompt = props.histories.A!.items[0]!;
    props = { ...props, histories: { ...props.histories, A: { status: "ready", hasMore: false, items: [
      { ...prompt, text: "提问前的上下文" },
      ...(stage === "history" ? [{ id: "latest-output", sessionId: "A", role: "assistant" as const, text: "最新的总结内容", createdAt: 3, origin: "claude-desktop" as const }] : []),
    ] } }, events: stage === "history" ? [] : [{ eventId: "latest-event", seq: 1, timestamp: 3, sessionId: "A", itemId: "latest-output", origin: "claude-desktop", type: stage === "streaming" ? "assistant.delta" : "assistant.completed", data: { text: "最新的总结内容" } }] };
    draw();
    const nodes = elements(tree);
    const cards = nodes.filter(element => element.type === PermissionPrompt && element.props.permission.requestId === "pending-question");
    expect(cards).toHaveLength(1);
    expect(nodes.some(element => element.type === InteractivePromptCard)).toBe(false);
    expect(nodes.findIndex(element => element.props.text === "提问前的上下文")).toBeLessThan(nodes.findIndex(element => element.props.text === "最新的总结内容"));
    expect(nodes.indexOf(cards[0]!)).toBeGreaterThan(nodes.findIndex(element => element.props.text === "最新的总结内容"));
  });

  it.each(["Bash", "AskUserQuestion"])("keeps the %s entry below output and above the composer even before history arrives", toolName => {
    props = { ...props, permissions: [{ requestId: "pending-before-history", sessionId: "A", toolUseId: "pending-before-history-tool", toolName, input: toolName === "AskUserQuestion" ? { questions: [{ question: "选哪个？", options: [{ label: "继续" }] }] } : { command: "synthetic-noop" }, createdAt: 1, canAllowAlways: false }], histories: { A: { status: "loading", hasMore: false, items: [] } } };
    draw();
    const nodes = elements(tree);
    const stream = nodes.findIndex(element => element.props.className === "conversation-stream");
    const dock = nodes.findIndex(element => String(element.props.className).startsWith("permission-dock-slot"));
    const composer = nodes.findIndex(element => element.props.className === "mobile-composer");
    expect(dock).toBeGreaterThan(stream);
    expect(dock).toBeLessThan(composer);
    expect(nodes.some(element => element.type === PermissionPrompt && element.props.permission.requestId === "pending-before-history")).toBe(true);
    if (toolName === "AskUserQuestion") {
      expect(elements(nodes[stream]!).some(element => element.type === PermissionPrompt && element.props.permission.requestId === "pending-before-history")).toBe(true);
      expect(nodes.some(element => element.props.title === "Claude 等待授权")).toBe(false);
    } else {
      expect(nodes.some(element => element.type === "strong" && [element.props.children].flat().join("") === "Claude 正在等待授权")).toBe(true);
    }
  });

  it.each(["Bash", "AskUserQuestion"])("marks the session's current %s request without requiring loaded history or inferred native state", toolName => {
    props = { ...props, permissions: [{ requestId: "list-request", sessionId: "B", toolUseId: "list-tool", toolName, input: {}, createdAt: 1, canAllowAlways: false }] };
    elements(tree).find(element => element.props.backLabel === "返回会话列表")!.props.onBack(); draw();
    const row = elements(tree).find(element => element.props["data-session-id"] === "B")!;
    expect(elements(row).find(element => String(element.props.className).startsWith("session-row-status"))?.props.children).toBe(toolName === "AskUserQuestion" ? "待回答" : "待授权");
    expect(props.snapshot!.sessions.find(session => session.sessionId === "B")!.turnState).toBe("idle");
    elements(row).find(element => element.props.className === "session-row-hit")!.props.onClick(); draw();
    expect(props.onOpenSession).toHaveBeenCalledWith("B");
    expect(elements(tree).some(element => element.type === PermissionPrompt && element.props.permission.requestId === "list-request")).toBe(true);
    props = { ...props, permissions: [] }; draw();
    elements(tree).find(element => element.props.backLabel === "返回会话列表")!.props.onBack(); draw();
    const clearedRow = elements(tree).find(element => element.props["data-session-id"] === "B")!;
    expect(elements(clearedRow).some(element => String(element.props.className).startsWith("session-row-status"))).toBe(false);
  });

  it("synchronizes catalog row state dot and badge for active and stalled background subagents when main turn is idle", () => {
    const now = Date.now();
    const setRunningSubagents = (runningSubagents?: { count: number; lastUpdatedAt: number }) => {
      props = {
        ...props,
        snapshot: {
          ...props.snapshot!,
          sessions: props.snapshot!.sessions.map(session => session.sessionId === "B"
            ? { ...session, turnState: "idle", ...(runningSubagents ? { runningSubagents } : {}) }
            : session),
        },
        histories: {
          ...props.histories,
          B: {
            status: "ready",
            hasMore: false,
            items: runningSubagents
              ? [{
                  id: "subagent-item",
                  sessionId: "B",
                  role: "tool",
                  toolName: "Agent",
                  text: "Run full local distributed CI",
                  createdAt: runningSubagents.lastUpdatedAt,
                  origin: "claude-desktop",
                  subagent: {
                    agentId: "agent-ci",
                    toolUseId: "subagent-item",
                    description: "Run full local distributed CI",
                    state: "running",
                    startedAt: now - 60_000,
                    updatedAt: runningSubagents.lastUpdatedAt,
                    toolCount: 3,
                  },
                }]
              : [],
          },
        },
      };
      if (!runningSubagents) {
        const target = props.snapshot!.sessions.find(session => session.sessionId === "B")!;
        delete target.runningSubagents;
      }
      draw();
    };

    elements(tree).find(element => element.props.backLabel === "返回会话列表")!.props.onBack(); draw();
    setRunningSubagents({ count: 1, lastUpdatedAt: now - 30_000 });
    const activeRow = elements(tree).find(element => element.props["data-session-id"] === "B")!;
    expect(elements(activeRow).find(element => String(element.props.className).startsWith("session-state-dot"))?.props.className).toBe("session-state-dot running");
    const activeBadge = elements(activeRow).find(element => String(element.props.className).startsWith("session-row-status"))!;
    expect(activeBadge.props.className).toBe("session-row-status running");
    expect(activeBadge.props.children).toBe("后台子代理");

    // Open session detail, verify detail activity indicator, then return to catalog and confirm sync persists.
    elements(activeRow).find(element => element.props.className === "session-row-hit")!.props.onClick(); draw();
    expect(elements(tree).some(element => String(element.props.activity?.label ?? "").includes("子代理运行中 · Run full local distributed CI"))).toBe(true);
    elements(tree).find(element => element.props.backLabel === "返回会话列表")!.props.onBack(); draw();
    const returnedRow = elements(tree).find(element => element.props["data-session-id"] === "B")!;
    expect(elements(returnedRow).find(element => String(element.props.className).startsWith("session-state-dot"))?.props.className).toBe("session-state-dot running");
    expect(elements(returnedRow).find(element => String(element.props.className).startsWith("session-row-status"))?.props.children).toBe("后台子代理");

    // Stalled > 10 minutes switches both dot and badge to queued warning tone.
    setRunningSubagents({ count: 1, lastUpdatedAt: now - 11 * 60_000 });
    const stalledRow = elements(tree).find(element => element.props["data-session-id"] === "B")!;
    expect(elements(stalledRow).find(element => String(element.props.className).startsWith("session-state-dot"))?.props.className).toBe("session-state-dot queued");
    const stalledBadge = elements(stalledRow).find(element => String(element.props.className).startsWith("session-row-status"))!;
    expect(stalledBadge.props.className).toBe("session-row-status queued");
    expect(stalledBadge.props.children).toBe("子代理无进展");

    // Clearing runningSubagents restores idle dot and removes badge.
    setRunningSubagents(undefined);
    const idleRow = elements(tree).find(element => element.props["data-session-id"] === "B")!;
    expect(elements(idleRow).find(element => String(element.props.className).startsWith("session-state-dot"))?.props.className).toBe("session-state-dot idle");
    expect(elements(idleRow).some(element => String(element.props.className).startsWith("session-row-status"))).toBe(false);
  });

  it("keeps a newly arrived question reachable while reading session evidence", () => {
    props = { ...props, histories: { A: { status: "ready", hasMore: false, items: [{ id: "prior-user", sessionId: "A", turnId: "prior-turn", role: "user", text: "之前的工作", createdAt: 1, origin: "claude-desktop" }] } },
      evidence: { A: { status: "ready", hasMore: false, items: [{ id: "prior-evidence", sessionId: "A", turnId: "prior-turn", source: "claude-desktop", confidence: "exact", state: "ready", startedAt: 1, completedAt: 2, toolCount: 0, changeCount: 0, artifactCount: 0, tools: [], artifacts: [], warnings: [] }] } } };
    draw();
    elements(tree).find(element => element.props.evidence?.id === "prior-evidence")!.props.onOpen(); draw();
    expect(elements(tree).some(element => element.props.className === "mobile-evidence-view")).toBe(true);
    props = { ...props, permissions: [{ requestId: "evidence-question", sessionId: "A", toolUseId: "evidence-tool", toolName: "AskUserQuestion", input: { questions: [{ question: "继续吗？", options: [{ label: "继续" }] }] }, createdAt: 3, canAllowAlways: false }] }; draw();
    const entry = elements(tree).find(element => element.props.className === "permission-dock")!;
    expect(entry).toBeDefined();
    entry.props.onClick(); draw();
    expect(elements(tree).some(element => element.type === PermissionPrompt && element.props.permission.requestId === "evidence-question")).toBe(true);
    expect(elements(tree).some(element => element.props.title === "Claude 等待授权")).toBe(false);
  });

  it("keeps an answered historical wrap-up before its later summary", () => {
    nativePrompt({ kind: "wrap-up", answered: true, ask: "继续？", actions: [{ label: "继续", message: "继续", selected: true }] });
    props = { ...props, histories: { ...props.histories, A: { ...props.histories.A!, items: [...props.histories.A!.items,
      { id: "answered-summary", sessionId: "A", role: "assistant", text: "已完成的后续总结", createdAt: 3, origin: "claude-desktop" },
    ] } } };
    draw();
    const nodes = elements(tree);
    const card = nodes.find(element => element.type === InteractivePromptCard)!;
    expect(card.props.prompt.answered).toBe(true);
    expect(nodes.indexOf(card)).toBeLessThan(nodes.findIndex(element => element.props.text === "已完成的后续总结"));
    expect(nodes.some(element => element.props.className === "permission-dock")).toBe(false);
  });

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
    nativePrompt({ kind: "question", questions: [question] });
    const card = elements(tree).find(element => element.type === PermissionPrompt && element.props.permission.toolUseId === "native-question")!;
    const child = PermissionPrompt(card.props as ComponentProps<typeof PermissionPrompt>);
    hooks.slots = [];
    const drawQuestion = () => { hooks.index = 0; return (child.type as (props: unknown) => ReactElement)(child.props); };
    elements(drawQuestion()).find(element => element.type === "input")!.props.onChange();
    const answering = elements(drawQuestion()).find(element => element.props.className === "primary-button")!.props.onClick();
    await answering;
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

  it.each(["single", "multi", "open"] as const)("submits a %s text answer through the original question without sending chat", async mode => {
    const question = { question: "下一步怎么做？", multiSelect: mode === "multi", options: mode === "open" ? [] : [{ label: "先检查" }] };
    const permission: BridgePermissionInfo = { requestId: "text-answer", sessionId: "A", toolUseId: "text-tool", toolName: "AskUserQuestion", createdAt: 1, canAllowAlways: false, input: { questions: [question] } };
    const onResolve = vi.fn().mockRejectedValueOnce(new Error("回答尚未提交")).mockResolvedValue(undefined);
    const child = PermissionPrompt({ permission, onResolve });
    hooks.slots = [];
    const drawQuestion = () => { hooks.index = 0; return (child.type as (props: unknown) => ReactElement)(child.props); };
    if (mode !== "open") elements(drawQuestion()).find(element => element.type === "input" && element.props.type !== "text")!.props.onChange();
    elements(drawQuestion()).find(element => element.type === "input" && element.props.type === "text")!.props.onChange({ target: { value: "  按修订意见继续  " } });
    expect(elements(drawQuestion()).find(element => element.props.className === "primary-button")!.props.disabled).toBe(false);
    elements(drawQuestion()).find(element => element.props.className === "primary-button")!.props.onClick();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(elements(drawQuestion()).find(element => element.props.role === "alert")?.props.children).toBe("回答尚未提交");
    expect(elements(drawQuestion()).find(element => element.type === "input" && element.props.type === "text")!.props.value).toBe("  按修订意见继续  ");
    elements(drawQuestion()).find(element => element.props.className === "primary-button")!.props.onClick();
    expect(onResolve).toHaveBeenCalledTimes(2);
    expect(onResolve).toHaveBeenLastCalledWith("text-answer", "allow-once", undefined, { ...permission.input, answers: { "下一步怎么做？": mode === "multi" ? "先检查, 按修订意见继续" : "按修订意见继续" } });
    expect(props.onSendTurn).not.toHaveBeenCalled();
  });

  it("submits all checkbox answers through the pending question request", async () => {
    const permission: BridgePermissionInfo = { requestId: "multi-request", sessionId: "A", toolUseId: "native-question", toolName: "AskUserQuestion", createdAt: 1, canAllowAlways: false,
      input: { questions: [{ question: "Which checks?", multiSelect: true, options: [{ label: "类型检查" }, { label: "回归测试" }] }] } };
    const onResolve = vi.fn().mockResolvedValue(undefined);
    const child = PermissionPrompt({ permission, onResolve });
    const drawQuestion = () => { hooks.index = 0; return (child.type as (props: unknown) => ReactElement)(child.props); };
    hooks.slots = [];
    let rendered = drawQuestion();
    expect(elements(rendered).filter(element => element.type === "input").map(element => element.props.type)).toEqual(["checkbox", "checkbox", "text"]);
    elements(rendered).filter(element => element.type === "input")[0]!.props.onChange();
    rendered = drawQuestion();
    elements(rendered).filter(element => element.type === "input")[1]!.props.onChange();
    rendered = drawQuestion();
    elements(rendered).find(element => element.props.className === "primary-button")!.props.onClick();
    await Promise.resolve();
    expect(onResolve).toHaveBeenCalledExactlyOnceWith("multi-request", "allow-once", undefined, { ...permission.input, answers: { "Which checks?": "类型检查, 回归测试" } });
  });
});

describe("automatic native question disappearance", () => {
  const question = { question: "Which branch?", options: [{ label: "Main" }, { label: "Feature" }] };
  const permission: BridgePermissionInfo = {
    requestId: "candidate3-request", sessionId: "A", toolUseId: "T", toolName: "AskUserQuestion",
    input: { questions: [question] }, createdAt: 100, canAllowAlways: false,
  };
  // Exact automatic disappearance shape from DesktopController.publish().
  const automatic: BridgeEvent = {
    eventId: "candidate3-disappeared", seq: 2, timestamp: 200, sessionId: "A", itemId: "T",
    origin: "claude-desktop", type: "question.resolved",
    data: { requestId: "candidate3-request", automatic: true },
  };
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "bridge-candidate3-question-"));
    await writeFile(join(directory, "A.jsonl"), [
      { type: "user", uuid: "candidate3-user", parentUuid: null, timestamp: new Date(50).toISOString(),
        message: { role: "user", content: "Choose a branch." } },
      { type: "assistant", uuid: "candidate3-question", parentUuid: "candidate3-user", timestamp: new Date(100).toISOString(),
        message: { role: "assistant", content: [{ type: "tool_use", id: "T", name: "AskUserQuestion", input: permission.input }], stop_reason: "tool_use" } },
    ].map(record => JSON.stringify(record)).join("\n") + "\n", "utf8");
    const page = await readClaudeSessionHistoryPage(directory, "A");
    expect(page.items.map(item => item.id)).toEqual(["candidate3-user", "candidate3-question"]);
    expect(page.items[1]!.interactivePrompt).toMatchObject({ kind: "question", toolUseId: "T" });
    props = { ...props, permissions: [permission],
      snapshot: { ...props.snapshot!, permissions: [permission] },
      histories: { ...props.histories, A: { ...page, status: "ready" } },
      events: [{ eventId: "candidate3-requested", seq: 1, timestamp: 100, sessionId: "A", itemId: "T",
        origin: "claude-desktop", type: "question.requested", data: { ...permission } }],
    };
    draw();
    expect(elements(tree).filter(element => element.type === PermissionPrompt && element.props.permission.toolUseId === "T")).toHaveLength(1);
    expect(elements(tree).some(element => element.type === InteractivePromptCard)).toBe(false);
  });

  afterEach(() => {
    // ci:run supplies recycle-cleanup.cjs through inherited NODE_OPTIONS.
    execFileSync(process.execPath, [fileURLToPath(new URL("../../../../scripts/clean.mjs", import.meta.url)), directory]);
  });

  function disappear() {
    props = { ...props, permissions: [], snapshot: { ...props.snapshot!, permissions: [] }, events: [...props.events, automatic] };
    draw();
    return elements(tree).find(element => element.type === InteractivePromptCard)!;
  }

  it("reproduces an unavailable unanswered card after external disappearance without inventing an answer or actor", () => {
    const card = disappear();
    expect(elements(tree).some(element => element.type === PermissionPrompt)).toBe(false);
    expect(card.props.prompt.toolUseId).toBe("T");
    expect(card.props.prompt.answered).not.toBe(true);
    expect(card.props.prompt.questions).toEqual([question]);
    expect(card.props.replyDelivery).toBeUndefined();
    expect(card.props.replyPending).not.toBe(true);
    const rendered = InteractivePromptCard(card.props as ComponentProps<typeof InteractivePromptCard>);
    expect(elements(rendered).find(element => element.props.className === "interactive-prompt-status")!.props.children).toBe("提问已不在待回答列表");
    expect(elements(rendered).filter(element => element.type === "button").every(element => element.props.disabled)).toBe(true);
    expect(conversationItems("A", props.histories.A, props.events, []).filter(item => item.role === "system")).toEqual([]);
    expect(props.onResolvePermission).not.toHaveBeenCalled();
    expect(props.onSendTurn).not.toHaveBeenCalled();
  });

  it("recognizes an external answer only once the real transcript records the matching tool result", async () => {
    await appendFile(join(directory, "A.jsonl"), JSON.stringify({
      type: "user", uuid: "candidate3-answer", parentUuid: "candidate3-question", timestamp: new Date(150).toISOString(),
      toolUseResult: { questions: [question], answers: { "Which branch?": "Main" } },
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "T", content: 'User has answered your questions: "Which branch?"="Main".' }] },
    }) + "\n", "utf8");
    const page = await readClaudeSessionHistoryPage(directory, "A");
    props = { ...props, histories: { ...props.histories, A: { ...page, status: "ready" } } };
    const card = disappear();
    expect(card.props.prompt).toMatchObject({ toolUseId: "T", answered: true, questions: [{
      question: "Which branch?", answer: "Main", options: [{ label: "Main", selected: true }, { label: "Feature" }],
    }] });
    const rendered = InteractivePromptCard(card.props as ComponentProps<typeof InteractivePromptCard>);
    expect(elements(rendered).find(element => element.props.className === "interactive-prompt-status")!.props.children).toBe("已回复");
    expect(conversationItems("A", props.histories.A, props.events, []).filter(item => item.role === "system")).toEqual([]);
    expect(props.onResolvePermission).not.toHaveBeenCalled();
    expect(props.onSendTurn).not.toHaveBeenCalled();
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
    expect(elements(questionTree!).filter((element) => element.type === "input" && element.props.type === "radio").map((element) => element.props.checked)).toEqual([false, false]);
    expect(elements(questionTree!).find(element => element.type === "input" && element.props.type === "text")?.props.value).toBe("");
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
      { id: "question", sessionId: "A", role: "assistant", text: "", createdAt: 1, origin: "claude-host", interactivePrompt: { kind: "question", toolUseId: "matching-tool", questions: [question] } },
    ] } } };
    draw();
    const prompt = elements(tree).find(element => element.type === PermissionPrompt && element.props.permission.requestId === "matching")!;
    const child = PermissionPrompt(prompt.props as ComponentProps<typeof PermissionPrompt>);
    hooks.slots = [];
    const drawQuestion = () => { hooks.index = 0; return (child.type as (props: unknown) => ReactElement)(child.props); };
    elements(drawQuestion()).find(element => element.type === "input" && element.props.type === "radio")!.props.onChange();
    elements(drawQuestion()).find(element => element.props.className === "primary-button")!.props.onClick();
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

describe("sidechat and slash command integration", () => {
  it.each([false, true])("keeps command discovery and execution on the selected sidechat (archived=%s)", async archived => {
    const sidechat = { ...props.snapshot!.sessions[1]!, title: "btw: Side question", parentSessionId: "A", sidechat: true,
      ...(archived ? { archivedAt: 100 } : {}) };
    props = { ...props, snapshot: { ...props.snapshot!, sessions: [props.snapshot!.sessions[0]!, sidechat],
      host: { ...props.snapshot!.host, capabilities: ["claude.native-relay.v1", "session.commands.v1", "session.command.v1"] } },
      onLoadSessionCommands: vi.fn(async sessionId => ({ sessionId, commands: [{ name: "help", description: "Help", action: "help" as const }] })),
      onRunSessionCommand: vi.fn(async () => ({ action: "help" as const })),
    };
    text("parent draft"); open("B");
    expect(elements(tree).some(element => Array.isArray(element.props.children) && element.props.children.includes("主会话：Session A"))).toBe(true);
    await input().props.onLoad(); await settle();
    text("/help"); form().props.onSubmit({ preventDefault() {} }); await settle();
    expect(props.onLoadSessionCommands).toHaveBeenCalledExactlyOnceWith("B");
    expect(props.onRunSessionCommand).toHaveBeenCalledExactlyOnceWith("B", "/help");
    expect(elements(tree).find(element => element.type === SessionCommandDialogs)!.props.session.sessionId).toBe("B");
    expect(props.onSendTurn).not.toHaveBeenCalled();
    elements(tree).find(element => element.type === "button" && Array.isArray(element.props.children) && element.props.children.includes("主会话：Session A"))!.props.onClick(); await settle();
    expect(input().props.value).toBe("parent draft");
    expect(props.onOpenSession).toHaveBeenLastCalledWith("A");
  });

  it("opens an archived sidechat from /resume with its own history and parent navigation", async () => {
    const sidechat = { ...props.snapshot!.sessions[1]!, title: "btw: Archived", parentSessionId: "A", sidechat: true, archivedAt: 100 };
    props = { ...props, snapshot: { ...props.snapshot!, sessions: [props.snapshot!.sessions[0]!, sidechat],
      host: { ...props.snapshot!.host, capabilities: ["claude.native-relay.v1", "session.commands.v1", "session.command.v1"] } },
      onLoadSessionCommands: vi.fn(async sessionId => ({ sessionId, commands: [] })),
      onRunSessionCommand: vi.fn(async () => ({ action: "resume" as const, sessions: [sidechat] })),
    };
    text("/resume"); form().props.onSubmit({ preventDefault() {} }); await settle();
    const dialog = elements(tree).find(element => element.type === SessionCommandDialogs)!;
    expect(dialog.props.result.sessions).toEqual([sidechat]);
    await dialog.props.onOpenSession("B"); await settle();
    expect(props.onOpenSession).toHaveBeenLastCalledWith("B");
    expect(elements(tree).some(element => Array.isArray(element.props.children) && element.props.children.includes("主会话：Session A"))).toBe(true);
    expect(props.onRunSessionCommand).toHaveBeenCalledExactlyOnceWith("A", "/resume");
    expect(props.onSendTurn).not.toHaveBeenCalled();
  });

  it("does not follow a late sidechat fork result after returning to its parent", async () => {
    let finish!: (result: { action: "session"; session: BridgeSessionInfo }) => void;
    props = { ...props, snapshot: { ...props.snapshot!,
      sessions: props.snapshot!.sessions.map(session => session.sessionId === "B" ? { ...session, parentSessionId: "A", sidechat: true } : session),
      host: { ...props.snapshot!.host, capabilities: ["claude.native-relay.v1", "session.commands.v1", "session.command.v1"] } },
      onLoadSessionCommands: vi.fn(async sessionId => ({ sessionId, commands: [] })),
      onRunSessionCommand: vi.fn(() => new Promise<{ action: "session"; session: BridgeSessionInfo }>(resolve => { finish = resolve; })),
    };
    text("parent draft"); open("B"); text("/fork branch"); form().props.onSubmit({ preventDefault() {} }); await settle();
    elements(tree).find(element => element.type === "button" && Array.isArray(element.props.children) && element.props.children.includes("主会话：Session A"))!.props.onClick(); await settle();
    finish({ action: "session", session: { ...props.snapshot!.sessions[1]!, sessionId: "late-fork" } }); await settle();
    expect(props.onRunSessionCommand).toHaveBeenCalledExactlyOnceWith("B", "/fork branch");
    expect(props.onOpenSession).not.toHaveBeenCalledWith("late-fork");
    expect(input().props.value).toBe("parent draft");
    expect(props.onSendTurn).not.toHaveBeenCalled();
  });

  it("excludes archived sidechats from the active parent session menu and fork chain once archived", async () => {
    const activeSidechat: BridgeSessionInfo = { ...props.snapshot!.sessions[1]!, sessionId: "btw-live", title: "btw: Live", parentSessionId: "A", sidechat: true };
    const archivedSidechat: BridgeSessionInfo = { ...props.snapshot!.sessions[1]!, sessionId: "btw-done", title: "btw: Done", parentSessionId: "A", sidechat: true, archivedAt: 100 };
    const clickHeaderMenu = () => {
      const header = elements(tree).find(element => element.props.backLabel === "返回会话列表")!;
      elements(header.props.actions).find(element => element.type === IconButton && element.props.label === "会话操作")!.props.onClick();
      draw();
    };
    props = { ...props, snapshot: { ...props.snapshot!, sessions: [props.snapshot!.sessions[0]!, activeSidechat, archivedSidechat] } };
    draw();
    clickHeaderMenu();
    const menuLabelsBefore = elements(tree).map(element => element.props?.label).filter(Boolean);
    expect(menuLabelsBefore).toContain("侧聊 1");
    expect(menuLabelsBefore).not.toContain("侧聊 2");
    elements(tree).find(element => element.props?.label === "侧聊 1")!.props.onClick();
    draw();
    expect(elements(tree).some(element => Array.isArray(element.props?.children) && element.props.children.includes("/btw · btw: Live"))).toBe(true);
    expect(elements(tree).some(element => Array.isArray(element.props?.children) && element.props.children.includes("/btw · btw: Done"))).toBe(false);

    props = {
      ...props,
      snapshot: {
        ...props.snapshot!,
        sessions: [props.snapshot!.sessions[0]!, { ...activeSidechat, archivedAt: 200 }, archivedSidechat],
      },
    };
    draw();
    expect(elements(tree).some(element => element.props?.className === "relay-chain-bar fork-chain-bar")).toBe(false);
    clickHeaderMenu();
    const menuLabelsAfter = elements(tree).map(element => element.props?.label).filter(Boolean);
    expect(menuLabelsAfter.some(label => String(label).startsWith("侧聊"))).toBe(false);
  });
});

describe("mobile common commands", () => {
  function enable(result: Record<string, unknown>) {
    props = { ...props, onRunSessionCommand: vi.fn().mockResolvedValue(result), onRenameSession: vi.fn(),
      onLoadSessionCommands: vi.fn().mockResolvedValue({ sessionId: "A", commands: [] }),
      snapshot: { ...props.snapshot!, host: { ...props.snapshot!.host, capabilities: ["claude.native-relay.v1", "session.commands.v1", "session.command.v1", "session.rename.v1"] } },
    }; draw();
  }
  it.each(["help", "permissions", "resume"])("dispatches /%s to the shared action UI without sending a model prompt", async action => {
    enable({ action, sessions: [props.snapshot!.sessions[1]], catalog: { sessionId: "A", commands: [] } });
    text(`/${action}`); form().props.onSubmit({ preventDefault() {} }); await settle();
    expect(props.onRunSessionCommand).toHaveBeenCalledWith("A", `/${action}`);
    expect(props.onSendTurn).not.toHaveBeenCalled();
    const dialog = elements(tree).find(element => element.type === SessionCommandDialogs)!;
    expect(dialog.props.result.action).toBe(action);
    if (action === "resume") {
      await dialog.props.onOpenSession("B"); await settle();
      expect(props.onOpenSession).toHaveBeenCalledWith("B");
    }
  });
  it("opens rewind from the command and restores only its original text to the composer after confirmation", async () => {
    enable({ action: "rewind" });
    props = { ...props, snapshot: { ...props.snapshot!, host: { ...props.snapshot!.host, capabilities: [...props.snapshot!.host.capabilities, "session.rewind.v1"] } },
      onPreviewRewind: vi.fn(), onRewindSession: vi.fn(),
      histories: { ...props.histories, A: { status: "ready", hasMore: false, items: [{ id: "user-uuid", sessionId: "A", role: "user", text: "Original request", createdAt: 1, origin: "claude-desktop" }] } },
    }; draw(); text("/rewind"); form().props.onSubmit({ preventDefault() {} }); await settle();
    const dialog = elements(tree).find(element => element.type === SessionRewindDialog)!;
    expect(dialog).toBeDefined();
    expect(props.onSendTurn).not.toHaveBeenCalled();
    expect(props.onRewindSession).not.toHaveBeenCalled();
    dialog.props.onComplete({ sessionId: "A", messageId: "user-uuid", scope: "conversation", prefill: "Original request" }); draw();
    expect(input().props.value).toBe("Original request");
    expect(elements(tree).some(element => element.type === SessionRewindDialog)).toBe(false);
  });

  it.each([
    { destination: "session", scope: "conversation" }, { destination: "session", scope: "files" },
    { destination: "host", scope: "conversation" }, { destination: "host", scope: "files" },
  ] as const)("[boundary] keeps a delayed $scope rewind completion on its original draft after changing $destination", async ({ destination, scope }) => {
    props = { ...props, onPreviewRewind: vi.fn(), onRewindSession: vi.fn(),
      snapshot: { ...props.snapshot!, host: { ...props.snapshot!.host, capabilities: [...props.snapshot!.host.capabilities, "session.rewind.v1"] } },
      histories: { ...props.histories, A: { status: "ready", hasMore: false, items: [{ id: "original-user", sessionId: "A", role: "user", text: "Original request", createdAt: 1, origin: "claude-desktop" }] } },
    }; draw(); text("A draft");
    const image = selectImage(); hooks.readers.at(-1).finish(); await image; await settle();
    elements(tree).find(element => element.props["aria-label"] === "回退到这条消息之前")!.props.onClick(); draw();
    const originalDialog = elements(tree).find(element => element.type === SessionRewindDialog)!;
    if (destination === "host") props = { ...props, activeHostId: "computer-2", snapshot: { ...props.snapshot!, host: { ...props.snapshot!.host, hostId: "computer-2" } } };
    open(destination === "host" ? "A" : "B"); text("Other draft");
    const otherImage = selectImage(); hooks.readers.at(-1).finish(); await otherImage; await settle();
    originalDialog.props.onComplete({ sessionId: "A", messageId: "original-user", scope, prefill: "Original request" }); draw();
    expect(input().props.value).toBe("Other draft");
    expect(imageNames()).toEqual(["移除 A.png"]);
    if (destination === "host") props = { ...props, activeHostId: "computer-1", snapshot: { ...props.snapshot!, host: { ...props.snapshot!.host, hostId: "computer-1" } } };
    open("A");
    expect(input().props.value).toBe(scope === "files" ? "A draft" : "Original request");
    expect(imageNames()).toEqual(scope === "files" ? ["移除 A.png"] : []);
    expect(props.onSendTurn).not.toHaveBeenCalled(); expect(props.onInterruptTurn).not.toHaveBeenCalled();
  });

  it("opens the existing model picker without configuring anything on selection or cancellation", async () => {
    enable({ action: "model" }); text("/model");
    expect(props.onRunSessionCommand).not.toHaveBeenCalled();
    form().props.onSubmit({ preventDefault() {} }); await settle();
    const dialog = elements(tree).find(element => element.type === SessionConfigurationDialog)!;
    expect(dialog).toBeDefined();
    const commandDialog = elements(tree).find(element => element.type === SessionCommandDialogs)!;
    expect(commandDialog.key).not.toBe(dialog.key);
    dialog.props.onClose(); draw();
    expect(props.onConfigureSession).not.toHaveBeenCalled();
  });
  it("selects the actual returned fork and opens its history", async () => {
    enable({ action: "session", session: props.snapshot!.sessions[1] }); text("/fork branch");
    form().props.onSubmit({ preventDefault() {} }); await settle();
    expect(props.onOpenSession).toHaveBeenLastCalledWith("B");
    expect(props.onSendTurn).not.toHaveBeenCalled();
  });
  it("keeps unavailable builtin drafts and displays the server reason", async () => {
    enable({ action: "sent" });
    props.onLoadSessionCommands = vi.fn().mockResolvedValue({ sessionId: "A", commands: [{ name: "context", description: "上下文", unavailableReason: "请在 Desktop 中执行" }] });
    draw(); text("/context"); form().props.onSubmit({ preventDefault() {} }); await settle();
    expect(input().props.value).toBe("/context");
    expect(elements(tree).find(element => element.props.role === "alert")!.props.children).toBe("请在 Desktop 中执行");
    expect(props.onRunSessionCommand).not.toHaveBeenCalled(); expect(props.onSendTurn).not.toHaveBeenCalled();
  });
  it("disables command attachments and steering while preserving path messages", async () => {
    enable({ action: "sent" }); text("/compact notes");
    const attachments = elements(tree).find(element => element.type === ComposerAttachmentMenu)!;
    expect(attachments.props.imageDisabled).toBe(true);
    expect(elements(tree).some(element => element.props.className === "composer-mode")).toBe(false);
    text("/absolute/path prompt"); form().props.onSubmit({ preventDefault() {} }); await settle();
    expect(props.onSendTurn).toHaveBeenCalledWith("A", "/absolute/path prompt", [], false);
    expect(props.onRunSessionCommand).not.toHaveBeenCalled();
  });
});

it("follows session.reset only while the old session is selected and loads the new empty context", async () => {
  props = { ...props, events: [{ eventId: "reset-A", seq: 1, timestamp: 1, sessionId: "A", origin: "claude-host", type: "session.reset",
    data: { sessionId: "B", previousSessionId: "A", nativeSessionId: "new-native" } }] };
  draw(); await settle();
  expect(props.onOpenSession).toHaveBeenLastCalledWith("B");
  expect(input().props.value).toBe("");
});

describe("mobile slash submission edges", () => {
  function enable() {
    props = { ...props, onRunSessionCommand: vi.fn().mockResolvedValue({ action: "sent" }),
      onLoadSessionCommands: vi.fn().mockResolvedValue({ sessionId: "A", commands: [] }),
      snapshot: { ...props.snapshot!, host: { ...props.snapshot!.host, capabilities: ["claude.native-relay.v1", "session.commands.v1", "session.command.v1"] } },
    }; draw();
  }

  it("[edge] keeps the command and concurrently typed text after a submit-time catalog failure without model fallback", async () => {
    enable();
    const catalog = deferred();
    props.onLoadSessionCommands = vi.fn().mockReturnValue(catalog.promise);
    draw(); text("/context"); form().props.onSubmit({ preventDefault() {} }); draw();
    text("follow-up draft"); catalog.reject(new Error("catalog unavailable")); await settle();
    expect(input().props.value).toBe("/context\nfollow-up draft");
    expect(elements(tree).find(element => element.props.role === "alert")!.props.children).toBe("catalog unavailable");
    expect(props.onRunSessionCommand).not.toHaveBeenCalled(); expect(props.onSendTurn).not.toHaveBeenCalled();
    expect(sendButton().props.disabled).toBe(false);
  });

  it("[edge] a delayed catalog follows the original send but does not open its model panel in the next session", async () => {
    enable();
    let resolve!: (catalog: { sessionId: string; commands: [] }) => void;
    props.onLoadSessionCommands = vi.fn(() => new Promise<{ sessionId: string; commands: [] }>(yes => { resolve = yes; }));
    props.onRunSessionCommand = vi.fn().mockResolvedValue({ action: "model" });
    draw(); text("/model"); form().props.onSubmit({ preventDefault() {} }); draw();
    open("B"); text("keep B"); resolve({ sessionId: "A", commands: [] }); await settle();
    expect(props.onRunSessionCommand).toHaveBeenCalledExactlyOnceWith("A", "/model");
    expect(props.onSendTurn).not.toHaveBeenCalled();
    expect(elements(tree).some(element => element.type === SessionConfigurationDialog)).toBe(false);
    expect(input().props.value).toBe("keep B"); expect(sendButton().props.disabled).toBe(false);
    open("A"); expect(input().props.value).toBe(""); expect(sendButton().props.disabled).toBe(true);
  });

  it("[edge] rejects slash attachments while preserving image, uploaded file and immediate-adjustment choice", async () => {
    enable();
    const file = { uploadId: "done", name: "done.txt", path: ".bridge-uploads/done.txt", size: 8, sha256: "abc" };
    props = { ...props, onUploadFile: vi.fn().mockResolvedValue(file), snapshot: { ...props.snapshot!, sessions: props.snapshot!.sessions.map(item => ({ ...item, turnState: "running", ownership: "BRIDGE_RUNNING" })) } };
    draw(); elements(tree).find(element => element.type === "button" && element.props.children === "立即调整")!.props.onClick(); draw();
    selectImage(); hooks.readers[0].finish(); await settle();
    await elements(tree).find(element => element.type === FileAttachmentPicker)!.props.state.add([{ name: "done.txt", size: 8 }]); draw();
    text("/compact keep decisions"); form().props.onSubmit({ preventDefault() {} }); await settle();
    expect(props.onRunSessionCommand).not.toHaveBeenCalled(); expect(props.onSendTurn).not.toHaveBeenCalled();
    expect(input().props.value).toBe("/compact keep decisions"); expect(imageNames()).toEqual(["移除 A.png"]);
    expect(elements(tree).find(element => element.type === FileAttachmentPicker)!.props.state.files).toEqual([file]);
    text("continue analysis");
    expect(elements(tree).find(element => element.type === "button" && element.props.children === "立即调整")!.props.className).toBe("active");
    form().props.onSubmit({ preventDefault() {} }); await settle();
    expect(props.onSendTurn).toHaveBeenCalledWith("A", expect.stringContaining(".bridge-uploads/done.txt"), [expect.objectContaining({ name: "A.png" })], true);
  });
});

describe("older history auto-load", () => {
  const item = (id: string) => ({ id, sessionId: "A", turnId: `t-${id}`, role: "user" as const, text: id, createdAt: 1, origin: "mobile" as const });
  function stream() { return elements(tree).find((e) => e.type === "section" && e.props.className === "conversation-stream")!; }
  function place(scrollTop: number) {
    const element = stream();
    (element.props.ref ?? (element as unknown as { ref: { current: unknown } }).ref).current = {
      scrollTop, scrollHeight: 2_000, clientHeight: 600, querySelectorAll: () => [], getBoundingClientRect: () => ({ top: 0, bottom: 0 }),
    };
  }
  function history(ids: string[], status: "ready" | "loading" = "ready") {
    props = { ...props, histories: { ...props.histories, A: { status, items: ids.map(item), hasMore: true, nextCursor: ids[0]! } } };
    draw();
  }

  it("keeps filling a short stream page by page without retrying a failed load", () => {
    place(0);
    history(["m3"]);
    expect(props.onLoadOlderHistory).toHaveBeenCalledExactlyOnceWith("A");
    history(["m3"], "loading");
    history(["m3"]);
    expect(props.onLoadOlderHistory).toHaveBeenCalledTimes(1);
    history(["m2", "m3"]);
    expect(props.onLoadOlderHistory).toHaveBeenCalledTimes(2);
  });

  it("continues after an older page advances the cursor without adding visible messages", () => {
    place(0);
    history(["m3"]);
    expect(props.onLoadOlderHistory).toHaveBeenCalledTimes(1);
    history(["m3"], "loading");
    props = { ...props, histories: { ...props.histories, A: { ...props.histories.A!, status: "ready", nextCursor: "older-internal" } } };
    draw();
    expect(props.onLoadOlderHistory).toHaveBeenCalledTimes(2);
  });

  it("continues when the first page contains no visible messages but has older history", () => {
    place(0);
    history([], "loading");
    props = { ...props, histories: { ...props.histories, A: { status: "ready", items: [], hasMore: true, nextCursor: "internal-only" } } };
    draw();
    expect(props.onLoadOlderHistory).toHaveBeenCalledExactlyOnceWith("A");
  });

  it("loads on scroll only near the top and never while a page is loading", () => {
    place(800);
    history(["m3"]);
    expect(props.onLoadOlderHistory).not.toHaveBeenCalled();
    stream().props.onScroll();
    expect(props.onLoadOlderHistory).not.toHaveBeenCalled();
    place(120);
    stream().props.onScroll();
    expect(props.onLoadOlderHistory).toHaveBeenCalledExactlyOnceWith("A");
    history(["m3"], "loading");
    stream().props.onScroll();
    expect(props.onLoadOlderHistory).toHaveBeenCalledTimes(1);
  });
});

describe("mobile section movement and subfolder labels", () => {
  const flatText = (node: ReactNode): string => {
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(flatText).join("");
    return node && typeof node === "object" && "props" in node
      ? flatText((node as ReactElement<{ children?: ReactNode }>).props.children)
      : "";
  };

  function toDirectory() {
    const header = elements(tree).find(element => element.props.backLabel === "返回会话列表");
    if (header) { header.props.onBack(); draw(); }
  }

  function openHeaderSessionMenu() {
    const header = elements(tree).find(element => element.props.backLabel === "返回会话列表")!;
    elements(header.props.actions).find(element => element.type === IconButton && element.props.label === "会话操作")!.props.onClick();
    draw();
  }

  it("moves sessions into, between, and out of native Sections with capability and offline gating", async () => {
    const miscGroup = { projectId: "sec-misc", name: "杂活", cwd: "/Users/lycidas/work/杂活", kind: "desktop-group" as const, sessionCount: 0, runningCount: 0, pendingCount: 0, lastActivityAt: 2 };
    const researchGroup = { projectId: "sec-research", name: "Research", cwd: "/Users/lycidas/work/research", kind: "desktop-group" as const, sessionCount: 0, runningCount: 0, pendingCount: 0, lastActivityAt: 1 };
    const onMoveSessionSection = vi.fn().mockResolvedValue({});
    props = {
      ...props,
      onMoveSessionSection,
      snapshot: {
        ...props.snapshot!,
        host: { ...props.snapshot!.host, capabilities: ["claude.native-relay.v1", "section.move.v1"] },
        projects: [props.snapshot!.projects[0]!, miscGroup, researchGroup],
        sessions: props.snapshot!.sessions.map(session => session.sessionId === "A"
          ? { ...session, allowedActions: { ...session.allowedActions!, canMoveSection: true } }
          : session),
      },
    };
    draw();

    // Session B lacks canMoveSection -> menu hides "移动到分组"
    open("B");
    openHeaderSessionMenu();
    expect(elements(tree).some(element => element.props.label === "移动到分组")).toBe(false);
    expect(dispatchMobileBack()).toBe(true);
    draw();

    // Session A is eligible -> offline disables "移动到分组" while keeping it visible
    open("A");
    props = { ...props, desktopOnline: false };
    draw();
    openHeaderSessionMenu();
    const offlineMove = elements(tree).find(element => element.props.label === "移动到分组")!;
    expect(offlineMove.props.detail).toBe("未分组");
    expect(offlineMove.props.disabled).toBe(true);

    // Back online -> open "移动到分组" step, test mobile back to main menu, then move into "杂活"
    props = { ...props, desktopOnline: true };
    draw();
    elements(tree).find(element => element.props.label === "移动到分组")!.props.onClick();
    draw();
    expect(elements(tree).some(element => element.props.title === "移动到分组")).toBe(true);
    expect(elements(tree).some(element => element.props.label === "移出分组")).toBe(false);
    expect(dispatchMobileBack()).toBe(true);
    draw();
    expect(elements(tree).some(element => element.props.title === "Session A")).toBe(true);

    elements(tree).find(element => element.props.label === "移动到分组")!.props.onClick();
    draw();
    await elements(tree).find(element => element.props.label === "杂活")!.props.onClick();
    await settle();
    expect(onMoveSessionSection).toHaveBeenCalledWith("A", "sec-misc");
    expect(elements(tree).some(element => element.props.title === "移动到分组")).toBe(false);

    // Session A now inside "杂活": directory row menu shows current section, marks it disabled, and supports moving out to Ungrouped
    props = {
      ...props,
      snapshot: {
        ...props.snapshot!,
        sessions: props.snapshot!.sessions.map(session => session.sessionId === "A"
          ? { ...session, projectId: "sec-misc", projectName: "杂活" }
          : session),
      },
    };
    toDirectory();
    const rowA = elements(tree).find(element => element.props["data-session-id"] === "A")!;
    elements(rowA).find(element => element.type === IconButton && element.props.label === "会话操作")!.props.onClick();
    draw();
    const inGroupMove = elements(tree).find(element => element.props.label === "移动到分组")!;
    expect(inGroupMove.props.detail).toBe("杂活");
    inGroupMove.props.onClick();
    draw();
    const currentItem = elements(tree).find(element => element.props.label === "杂活")!;
    expect(currentItem.props.detail).toBe("当前所在分组");
    expect(currentItem.props.disabled).toBe(true);
    await elements(tree).find(element => element.props.label === "移出分组")!.props.onClick();
    await settle();
    expect(onMoveSessionSection).toHaveBeenLastCalledWith("A", null);
  });

  it("returns from an emptied directory group page when its project disappears after moving", () => {
    const base = props.snapshot!.sessions[0]!;
    props = {
      ...props,
      snapshot: {
        ...props.snapshot!,
        projects: [{ projectId: "project", name: "Project", cwd: "/tmp/project", sessionCount: 6, runningCount: 0, pendingCount: 0, lastActivityAt: 6 }],
        sessions: Array.from({ length: 6 }, (_, index) => ({ ...base, sessionId: `S-${index}`, title: `Session ${index}`, lastActivityAt: index + 1 })),
      },
    };
    toDirectory();
    elements(tree).find(element => element.props.className === "project-group-more-button")!.props.onClick();
    draw();
    expect(elements(tree).some(element => element.props.className === "host-detail project-detail-view")).toBe(true);

    // Remove "project" from snapshot.projects (simulating all sessions moved into a Section)
    props = {
      ...props,
      snapshot: {
        ...props.snapshot!,
        projects: [{ projectId: "sec-misc", name: "杂活", cwd: "/work/杂活", kind: "desktop-group", sessionCount: 6, runningCount: 0, pendingCount: 0, lastActivityAt: 6 }],
        sessions: props.snapshot!.sessions.map(session => ({ ...session, projectId: "sec-misc", projectName: "杂活" })),
      },
    };
    draw();
    expect(elements(tree).some(element => element.props.className === "host-detail project-detail-view")).toBe(false);
    expect(elements(tree).some(element => element.props.title === "会话")).toBe(true);
  });

  it("shows subfolder name only for desktop-group sessions whose folder differs from the group name", () => {
    props = {
      ...props,
      snapshot: {
        ...props.snapshot!,
        projects: [
          { projectId: "sec-misc", name: "杂活", cwd: "/Users/lycidas/work/杂活", kind: "desktop-group", sessionCount: 2, runningCount: 0, pendingCount: 0, lastActivityAt: 2 },
          { projectId: "dir-plain", name: "plain-repo", cwd: "/Users/lycidas/work/plain-repo", kind: "directory", sessionCount: 1, runningCount: 0, pendingCount: 0, lastActivityAt: 1 },
        ],
        sessions: [
          { ...props.snapshot!.sessions[0]!, sessionId: "sub", title: "Colab task", projectId: "sec-misc", projectName: "杂活", cwd: "/Users/lycidas/work/杂活/colab-connect" },
          { ...props.snapshot!.sessions[0]!, sessionId: "same", title: "Root task", projectId: "sec-misc", projectName: "杂活", cwd: "/Users/lycidas/work/杂活" },
          { ...props.snapshot!.sessions[1]!, sessionId: "plain", title: "Plain task", projectId: "dir-plain", projectName: "plain-repo", cwd: "/Users/lycidas/work/plain-repo" },
        ],
      },
    };
    toDirectory();
    const rowSmall = (id: string) => {
      const row = elements(tree).find(element => element.props["data-session-id"] === id)!;
      return flatText(elements(row).find(element => element.type === "small"));
    };
    expect(rowSmall("sub")).toMatch(/^colab-connect · /u);
    expect(rowSmall("same")).not.toContain("杂活 ·");
    expect(rowSmall("plain")).not.toContain("plain-repo ·");

    // Also verify projectSearch inside a desktop-group matches subfolder names
    props = {
      ...props,
      snapshot: {
        ...props.snapshot!,
        sessions: [
          ...props.snapshot!.sessions,
          ...Array.from({ length: 4 }, (_, index) => ({ ...props.snapshot!.sessions[1]!, sessionId: `extra-${index}`, title: `Extra ${index}`, lastActivityAt: index })),
        ],
      },
    };
    draw();
    elements(tree).find(element => element.props.className === "project-group-more-button")!.props.onClick();
    draw();
    elements(tree).find(element => element.type === "input" && element.props.placeholder === "搜索「杂活」")!.props.onChange({ target: { value: "colab-connect" } });
    draw();
    expect(elements(tree).filter(element => element.props["data-session-id"]).map(element => element.props["data-session-id"])).toEqual(["sub"]);
  });
});
