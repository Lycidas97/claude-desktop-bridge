import type { BridgePermissionInfo, BridgeSessionInfo } from "@bridge/protocol";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InteractivePromptCard, MobileWorkspace, PermissionPrompt } from "./MobileWorkspace.js";
import { ComposerAttachmentMenu, FileAttachmentPicker } from "./FileAttachmentPicker.js";
import { IconButton } from "./IconButton.js";
import { MessageCopyButton } from "./MessageCopyButton.js";

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

describe("mobile conversation draft ownership", () => {
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
