import type { BridgeHistoryItem, BridgePermissionInfo, BridgeSessionInfo, DesktopControlSnapshot } from "@bridge/protocol";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopDashboard } from "./DesktopDashboard.js";
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
  const dashboard = renderer(DesktopDashboard, {
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
