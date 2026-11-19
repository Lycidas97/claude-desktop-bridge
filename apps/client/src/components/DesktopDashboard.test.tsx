import type { BridgeArtifactManifest, BridgeEvent, BridgeHistoryItem, BridgePermissionInfo, BridgeResponse, BridgeSessionInfo, DesktopControlSnapshot } from "@bridge/protocol";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadBridgeSessionFile } from "../lib/artifact-download.js";
import { collectDiagnosticsStateSnapshot } from "../lib/diagnostics.js";
import { AssistantMailProvider } from "./assistant/AssistantMailProvider.js";
import { AssistantPage } from "./assistant/AssistantPage.js";
import { ConversationDraftsProvider } from "./conversation/ConversationDraftsProvider.js";
import { ConversationView } from "./conversation/ConversationView.js";
import { DesktopDashboard } from "./DesktopDashboard.js";
import {
  DesktopConversationProvider,
  DesktopSessionConversation,
} from "./desktop/DesktopSessionConversation.js";
import { DesktopSessions } from "./desktop/DesktopSessionsPane.js";
import { DesktopDevices, DesktopSettings } from "./desktop/DesktopSettings.js";
import { EvidencePanel } from "./evidence/EvidencePanel.js";
import { NewChatCanvas } from "./session/NewChatCanvas.js";
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
import { SectionCreateDialog } from "./session/SectionCreateDialog.js";
import { SectionManageDialog } from "./session/SectionManageDialog.js";
import { SessionActionSheets } from "./session/SessionActionSheets.js";
import { SessionCreateDialog } from "./session/SessionCreateDialog.js";
import { MobilePageHeader } from "./mobile/MobilePageHeader.js";
import { ProjectOrderSheet } from "./mobile/ProjectOrderSheet.js";
import { Sheet, SheetAction } from "./common/Sheet.js";
import { MagpieQuotaProvider } from "../../../../plugins/magpie-quota/client.js";

type HookStore = {
  slots: any[]; index: number; dirty: boolean;
  effects: Array<{ deps: unknown[] | undefined; cleanup: (() => void) | undefined }>;
  effectIndex: number; pending: Array<() => void>;
};
const hooks = vi.hoisted(() => ({ current: undefined as HookStore | undefined }));
const contexts = vi.hoisted(() => ({ current: new Map<unknown, unknown>() }));
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
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
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
  useCallback: (callback: unknown) => callback,
  useId: () => "mock-id",
  useContext: (context: unknown) => contexts.current.get(context),
  useEffect: recordEffect,
  useLayoutEffect: recordEffect,
}));
const mailContext = vi.hoisted(() => ({ current: undefined as any }));
vi.mock("./assistant/AssistantMailProvider.js", async (original) => {
  const actual = await original<typeof import("./assistant/AssistantMailProvider.js")>();
  return {
    ...actual,
    useAssistantMail: () => mailContext.current ?? actual.useAssistantMail(),
  };
});
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
    || element.type === SectionCreateDialog
    || element.type === SectionManageDialog
    || element.type === SessionActionSheets
    || element.type === SessionFamilyList
    || element.type === SessionProfileSummary
    || element.type === ConversationMessageItem
    || element.type === ConversationToolGroup
    || element.type === ForkChainBar
    || element.type === MobilePageHeader
    || element.type === SheetAction
  )
    ? (element.type as (props: any) => ReactNode)(element.props)
    : element.props.children;
  return [element, ...elements(children)];
}
const stores: HookStore[] = [];
function StandaloneDesktopSessions(props: ComponentProps<typeof DesktopSessions>) {
  return (
    <DesktopConversationProvider {...props}>
      <DesktopSessions {...props} />
    </DesktopConversationProvider>
  );
}

function renderer(
  component: (props: any) => ReactNode,
  initialProps: any,
  options?: { expandDashboard?: boolean; expandMailProvider?: boolean },
) {
  const subStores = new Map<string, HookStore>();
  let props = initialProps;
  let tree: ReactNode;
  function shouldExpand(type: unknown): type is (props: any) => ReactNode {
    if (type === DesktopSessionConversation || type === ConversationView || type === NewChatCanvas) return true;
    if (typeof type === "function" && type.name === "DesktopAssistantNavButton") return true;
    if (options?.expandMailProvider && type === AssistantMailProvider) return true;
    if (component === StandaloneDesktopSessions) return type === DesktopConversationProvider || type === DesktopSessions;
    if (!options?.expandDashboard) return false;
    return (
      type === ConversationDraftsProvider
      || type === DesktopConversationProvider
      || type === DesktopSessions
      || type === DesktopSettings
      || type === DesktopDevices
      || type === AssistantPage
    );
  }
  return {
    draw(nextProps = props) {
      props = nextProps;
      for (let i = 0; i < 12; i++) {
        const visited = new Set<string>();
        for (const store of subStores.values()) store.dirty = false;
        function expand(node: ReactNode, path: string): ReactNode {
          if (Array.isArray(node)) return node.map((child, index) => expand(child, `${path}/${index}`));
          if (!node || typeof node !== "object" || !("props" in node)) return node;
          const element = node as ReactElement<Record<string, any>>;
          if (
            typeof element.type === "object"
            && element.type !== null
            && "value" in element.props
            && ("_context" in (element.type as Record<string, unknown>) || "Provider" in (element.type as Record<string, unknown>))
          ) {
            const ctx = (element.type as { _context?: unknown })._context ?? element.type;
            const hadPrevious = contexts.current.has(ctx);
            const previousValue = contexts.current.get(ctx);
            contexts.current.set(ctx, element.props.value);
            try {
              return { ...element, props: { ...element.props, children: expand(element.props.children, `${path}/provider`) } };
            } finally {
              if (hadPrevious) contexts.current.set(ctx, previousValue);
              else contexts.current.delete(ctx);
            }
          }
          if (shouldExpand(element.type)) {
            const key = `${path}/${element.type.name}:${element.key ?? ""}`;
            visited.add(key);
            let childStore = subStores.get(key);
            if (!childStore) {
              childStore = { slots: [], index: 0, dirty: false, effects: [], effectIndex: 0, pending: [] };
              subStores.set(key, childStore);
              stores.push(childStore);
            }
            hooks.current = childStore;
            childStore.index = 0;
            childStore.effectIndex = 0;
            const childOut = element.type(element.props);
            childStore.pending.splice(0).forEach((effect) => effect());
            return { ...element, props: { ...element.props, children: expand(childOut, key) } };
          }
          return {
            ...element,
            props: {
              ...element.props,
              children: expand(element.props.children, `${path}/${element.key ?? String(element.type)}`),
            },
          };
        }
        let rootStore = subStores.get("root");
        if (!rootStore) {
          rootStore = { slots: [], index: 0, dirty: false, effects: [], effectIndex: 0, pending: [] };
          subStores.set("root", rootStore);
          stores.push(rootStore);
        }
        visited.add("root");
        hooks.current = rootStore;
        rootStore.index = 0;
        rootStore.effectIndex = 0;
        const rootOut = component(props);
        rootStore.pending.splice(0).forEach((effect) => effect());
        tree = expand(rootOut, "root");
        for (const [key, store] of subStores) {
          if (visited.has(key)) continue;
          store.effects.forEach((effect) => effect.cleanup?.());
          subStores.delete(key);
        }
        if (![...subStores.values()].some((store) => store.dirty)) return tree;
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
    removeItem: vi.fn((key: string) => saved.delete(key)),
  });
  history = [];
  vi.mocked(downloadBridgeSessionFile).mockReset();
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
  contexts.current.clear();
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
  sessions = renderer(StandaloneDesktopSessions, sessionsProps);
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
    expect(textContent(tree).replace(/\s+/gu, " ")).toContain("Claude Opus 5.5 custom model · High · Auto");
    expect(elements(tree).some(element => element.props["aria-label"] === "会话设置")).toBe(canConfigure);
    const updated = { ...snapshot, sessions: [{ ...snapshot.sessions[0]!, nativePermissionMode: "dontAsk" as const }] };
    tree = sessions.draw({ ...sessionsProps, snapshot: updated });
    expect(textContent(tree).replace(/\s+/gu, " ")).toContain("Claude Opus 5.5 custom model · High · Don't Ask");
    const bypassed = { ...snapshot, sessions: [{ ...snapshot.sessions[0]!, nativePermissionMode: "bypassPermissions" as const }] };
    tree = sessions.draw({ ...sessionsProps, snapshot: bypassed });
    expect(textContent(tree).replace(/\s+/gu, " ")).toContain("Claude Opus 5.5 custom model · High · Bypass");
    expect(elements(tree).some(element => typeof element.props.className === "string" && element.props.className.includes("is-bypass"))).toBe(true);
    expect(apiRequest).not.toHaveBeenCalled();
  });
});

describe("desktop session PR disclosure", () => {
  it("opens no-PR preferences and routes reads and writes through the desktop API", async () => {
    snapshot.host.capabilities.push("pr.autofix.v1");
    snapshot.runtime.desktopIntegration.state = "ready";
    await openSessions();
    const trigger = elements(tree).find(element => element.type === IconButton && element.props.label === "会话操作");
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

describe("desktop session menu mutations", () => {
  const menuAction = (tree: ReactNode, label: string) =>
    elements(tree).find(element => element.type === SheetAction && element.props.label === label)!;

  function openConversationMenu(onSelectSession = vi.fn(), onRefreshSnapshot = vi.fn().mockResolvedValue(undefined)) {
    snapshot.host.capabilities = ["session.visibility.v1"];
    snapshot.runtime.desktopIntegration.state = "ready";
    const events: BridgeEvent[] = [];
    const conversation = renderer(() => (
      <DesktopConversationProvider snapshot={snapshot} events={events} apiRequest={apiRequest} onRefreshSnapshot={onRefreshSnapshot}>
        <DesktopSessionConversation session={snapshot.sessions[0]!} snapshot={snapshot} events={events} onSelectSession={onSelectSession} />
      </DesktopConversationProvider>
    ), undefined, { expandDashboard: true });
    elements(conversation.draw()).find(element => element.type === IconButton && element.props.label === "会话操作")!.props.onClick();
    return conversation;
  }

  it("selects the returned fork exactly once and dismisses the menu", async () => {
    const onSelectSession = vi.fn();
    const conversation = openConversationMenu(onSelectSession);
    await settle();
    apiRequest.mockClear().mockResolvedValueOnce({
      kind: "response", requestId: "fork", ok: true,
      result: { session: { ...snapshot.sessions[0]!, sessionId: "fork-A" } },
    });

    menuAction(conversation.draw(), "Fork 分支").props.onClick();
    await settle();

    expect(apiRequest).toHaveBeenCalledExactlyOnceWith({ method: "session.fork", params: { sessionId: "A" } });
    expect(onSelectSession).toHaveBeenCalledExactlyOnceWith("fork-A");
    expect(elements(conversation.draw()).some(element => element.type === Sheet)).toBe(false);
  });

  it("keeps the archive menu open with the error and dismisses it after a successful retry", async () => {
    const conversation = openConversationMenu();
    await settle();
    apiRequest.mockClear().mockResolvedValueOnce({
      kind: "response", requestId: "archive", ok: false, error: { code: "FAILED", message: "原生归档失败" },
    });

    menuAction(conversation.draw(), "归档会话").props.onClick();
    await settle();

    const failed = conversation.draw();
    const sheet = elements(failed).find(element => element.type === Sheet)!;
    expect(sheet?.props.busy).toBe(false);
    expect(elements(sheet).some(element => element.props.role === "alert" && textContent(element).includes("原生归档失败"))).toBe(true);
    expect(menuAction(failed, "归档会话").props.disabled).toBe(false);

    menuAction(failed, "归档会话").props.onClick();
    await settle();

    expect(apiRequest.mock.calls).toEqual([
      [{ method: "session.archive", params: { sessionId: "A", archived: true } }],
      [{ method: "session.archive", params: { sessionId: "A", archived: true } }],
    ]);
    expect(elements(conversation.draw()).some(element => element.type === Sheet)).toBe(false);
  });

  it("keeps a pending sync failure out of an unsubmitted delete confirmation", async () => {
    let rejectRefresh!: (error: Error) => void;
    const onRefreshSnapshot = vi.fn(() => new Promise<void>((_, reject) => { rejectRefresh = reject; }));
    const conversation = openConversationMenu(undefined, onRefreshSnapshot);
    await settle();
    apiRequest.mockClear();

    menuAction(conversation.draw(), "同步此会话").props.onClick();
    expect(onRefreshSnapshot).toHaveBeenCalledOnce();
    const deleteAction = menuAction(conversation.draw(), "删除会话");
    expect(deleteAction.props.disabled).toBe(false);
    deleteAction.props.onClick();

    rejectRefresh(new Error("读取快照失败"));
    await settle();

    const confirmation = elements(conversation.draw()).find(element => element.type === ConfirmationDialog && element.props.open)!;
    expect(apiRequest).not.toHaveBeenCalled();
    expect(confirmation.props.error).toBeUndefined();
    confirmation.props.onCancel();
    expect(textContent(conversation.draw())).toContain("读取快照失败");
  });

  it("keeps the delete confirmation and draft after a rejected request", async () => {
    const conversation = openConversationMenu();
    const confirmation = () => elements(conversation.draw()).find(element => element.type === ConfirmationDialog && element.props.open);
    elements(conversation.draw()).find(element => element.type === SlashCommandInput)!.props.onChange("保留草稿");
    menuAction(conversation.draw(), "删除会话").props.onClick();
    await settle();
    apiRequest.mockClear().mockResolvedValueOnce({
      kind: "response", requestId: "delete", ok: false, error: { code: "FAILED", message: "原生删除失败" },
    });

    expect(apiRequest).not.toHaveBeenCalled();
    expect(confirmation()).toBeDefined();
    confirmation()!.props.onConfirm();
    await settle();

    expect(apiRequest).toHaveBeenCalledExactlyOnceWith({ method: "session.delete", params: { sessionId: "A" } });
    expect(confirmation()?.props).toMatchObject({ open: true, busy: false, error: "原生删除失败" });
    expect(elements(conversation.draw()).find(element => element.type === SlashCommandInput)!.props.value).toBe("保留草稿");

    confirmation()!.props.onConfirm();
    await settle();
    expect(confirmation()).toBeUndefined();
    expect(elements(conversation.draw()).find(element => element.type === SlashCommandInput)!.props.value).toBe("");
  });
});

describe("desktop session deletion confirmation", () => {
  it.each(["claude-desktop", "codex-desktop", "hermes-desktop", "dsh-desktop"] as const)("describes the actual deletion target for %s without deleting on review", async runtimeId => {
    snapshot.host.capabilities.push("session.visibility.v1");
    await openSessions();
    const session = { ...snapshot.sessions[0]!, runtimeId, transport: runtimeId === "claude-desktop" ? "claude-desktop-native" as const : "bridge-host" as const };
    tree = sessions.draw({ ...sessionsProps, snapshot: { ...snapshot, sessions: [session] } });
    elements(tree).find(element => element.type === IconButton && element.props.label === "会话操作")!.props.onClick();
    tree = sessions.draw();
    elements(tree).find(element => element.type === SheetAction && element.props.label === "删除会话")!.props.onClick();
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
    expect(elements(tree).some(element => element.type === NewChatCanvas)).toBe(true);
    elements(tree).find(element => element.type === "button" && element.props["aria-label"] === "选择文件夹")!.props.onClick();
    tree = sessions.draw();
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
    expect(elements(tree).some(element => element.type === NewChatCanvas)).toBe(true);
    elements(tree).find(element => element.type === "button" && element.props["aria-label"] === "选择文件夹")!.props.onClick();
    tree = sessions.draw();
    expect(elements(tree).some(element => typeof element.type === "function" && element.type.name === "SessionCreateDialog")).toBe(true);
  });

  it("keeps archived sessions accessible when no active session remains", async () => {
    snapshot.host.capabilities.push("session.visibility.v1");
    snapshot.runtime.desktopIntegration.state = "ready";
    snapshot.sessions[0]!.archivedAt = 100;
    await openSessions();
    expect(textContent(tree)).toContain("暂无活跃会话");
    const archivedHeader = elements(tree).find(element => element.type === ProjectGroupHeader && element.props.title === "已归档")!;
    expect(archivedHeader.props.count).toBe(1);
    expect(archivedHeader.props.controlsId).toBe("desktop-archived-sessions");
    expect(elements(tree).some(element => typeof element.props.className === "string" && element.props.className.includes("desktop-project-toggle"))).toBe(false);
    elements(tree).find(element => element.props["aria-controls"] === "desktop-archived-sessions")!.props.onClick();
    tree = sessions.draw();
    const archivedGroup = elements(tree).find(element => element.props.id === "desktop-archived-sessions")!;
    expect(archivedGroup.props.className).toBeUndefined();
    expect(elements(tree).some(element => typeof element.props.className === "string" && element.props.className.includes("desktop-project-sessions"))).toBe(false);
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
    const openOrder = () => elements(elements(tree).find(element => String(element.props.className).includes("project-order-bar"))!).find(element => element.props["aria-label"] === "调整顺序")!;
    openOrder().props.onClick();
    tree = sessions.draw();
    let order = elements(tree).find(element => element.type === ProjectOrderSheet)!;
    order.props.onPlaceProjects(["project", "third", "second"]);
    tree = sessions.draw();
    expect(titles()).toEqual(["Project", "Third", "Second"]);
    await openSessions();
    expect(titles()).toEqual(["Project", "Third", "Second"]);
    openOrder().props.onClick();
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
    expect(elements(tree).some((element) => element.props["data-stream-key"] === "question:matching")).toBe(true);
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

  it("displays active /btw sidechats under their parent, moves archived sidechats to archive, and shows ForkChainBar only on child sessions", async () => {
    snapshot.host.capabilities.push("session.visibility.v1");
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
    expect(textContent(tree)).toContain("1 个 /btw 侧聊");
    expect(textContent(tree)).not.toContain("2 个 /btw 侧聊");
    expect(textContent(tree)).not.toContain("btw: 收集白名单域名");
    expect(elements(tree).some((element) => element.props?.className === "relay-chain-bar fork-chain-bar")).toBe(false);
    const toggle = elements(tree).find((element) => element.type === "button" && element.props.className === "mobile-fork-toggle")!;
    toggle.props.onClick();
    tree = sessions.draw();
    expect(textContent(tree)).toContain("btw: 检查 IPv6 转发");
    expect(textContent(tree)).not.toContain("btw: 收集白名单域名");
    const badges = elements(tree).filter((element) => element.type === "em" && String(element.props.className).includes("is-sidechat"));
    expect(badges.map((badge) => badge.props.children)).toEqual(["/btw"]);

    elements(tree).find((element) => element.props["aria-controls"] === "desktop-archived-sessions")!.props.onClick();
    tree = sessions.draw();
    const archivedGroup = elements(tree).find((element) => element.props.id === "desktop-archived-sessions")!;
    expect(textContent(archivedGroup)).toContain("btw: 收集白名单域名");
    expect(textContent(archivedGroup)).toContain("已归档");

    elements(tree).find((element) => element.type === "button" && element.props.className === "session-row-hit" && textContent(element).includes("btw: 检查 IPv6 转发"))!.props.onClick();
    await settle();
    tree = sessions.draw();
    const forkBar = elements(tree).find((element) => element.props.className === "relay-chain-bar fork-chain-bar")!;
    expect(textContent(forkBar)).toContain("主会话：Session A");
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
  it("refreshes compacted history", async () => {
    await openSessions();
    const event = { eventId: "compact", sessionId: "A", seq: 1, timestamp: 1, origin: "claude-host", type: "session.compacted", data: {} };
    sessions.draw({ ...sessionsProps, events: [event] });
    await settle();
    expect(apiRequest).toHaveBeenCalledWith(expect.objectContaining({ method: "session.open", params: expect.objectContaining({ sessionId: "A" }) }));
  });

  it.each([
    { timing: "already in the snapshot", present: true },
    { timing: "published by the refreshed snapshot", present: false },
  ])("opens the reset session once and shows its history when it is $timing", async ({ present }) => {
    await openSessions();
    const next = { ...snapshot.sessions[0]!, sessionId: "new-A", title: "New context", nativeSessionId: "new-native" };
    const refreshed = { ...snapshot, sessions: [...snapshot.sessions, next] };
    const reset: BridgeEvent = {
      eventId: "reset", sessionId: "A", seq: 1, timestamp: 1, origin: "claude-host", type: "session.reset",
      data: { sessionId: "new-A", previousSessionId: "A", nativeSessionId: "new-native" },
    };
    history = [{ id: "new-message", sessionId: "new-A", role: "assistant", text: "New context history", createdAt: 2, origin: "claude-desktop" }];
    sessions.draw({ ...sessionsProps, snapshot: present ? refreshed : snapshot, events: [reset] });
    snapshot = refreshed;
    await settle();
    sessions.draw({ ...sessionsProps, snapshot, events: [reset] });
    await settle();
    tree = sessions.draw();

    expect(elements(tree).find(element => element.type === SessionCommandDialogs)!.props.session.sessionId).toBe("new-A");
    expect(apiRequest.mock.calls.filter(([req]) => req.method === "session.open" && req.params.sessionId === "new-A")).toHaveLength(1);
    expect(elements(tree).filter((element) => element.type === ConversationMessageItem).map((element) => element.props.item.text))
      .toEqual(["New context history"]);
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
  it.each(["ready", "error"])("shows history and retries paging while evidence is pending, then evidence becomes %s", async (evidenceStatus) => {
    history = [
      { id: "m-2", sessionId: "A", role: "user", text: "Recent question", createdAt: 20, origin: "claude-desktop" },
      { id: "m-3", sessionId: "A", role: "assistant", text: "Recent answer", createdAt: 30, origin: "claude-desktop" },
    ];
    let finishEvidence!: (response: BridgeResponse) => void;
    const firstEvidence = new Promise<BridgeResponse>((resolve) => { finishEvidence = resolve; });
    apiRequest.mockImplementation(async ({ method }) => {
      if (method === "evidence.list") return firstEvidence;
      return {
        kind: "response",
        requestId: "page",
        ok: true,
        result: { history: { items: history, hasMore: true, nextCursor: "m-2" } },
      };
    });
    dashboard = renderer(DesktopDashboard, {
      themeControl: { theme: "dark", family: "apple", setTheme: vi.fn(), setFamily: vi.fn(), toggleTheme: vi.fn() },
      agentVisibility: { enabled: ["claude-desktop"], setEnabled: vi.fn() },
    });
    dashboard.draw(); await settle();
    const child = elements(dashboard.draw()).find((element) => typeof element.type === "function" && element.type.name === "DesktopSessions")!;
    sessionsProps = child.props;
    sessions = renderer(StandaloneDesktopSessions, sessionsProps);
    sessions.draw(); await settle(); tree = sessions.draw();
    expect(apiRequest).toHaveBeenCalledWith({ method: "evidence.list", params: { sessionId: "A", limit: 30 } });
    expect(apiRequest).toHaveBeenCalledWith({ method: "session.open", params: { sessionId: "A", limit: 50 } });
    const messageIds = () => elements(tree).filter((element) => element.type === ConversationMessageItem).map((element) => element.props.item.id);
    expect(messageIds()).toEqual(["m-2", "m-3"]);
    expect(textContent(tree)).not.toContain("正在加载最新对话…");

    function switchView(label: string) {
      const navigation = elements(tree).find((element) => element.props["aria-label"] === "会话视图")!;
      elements(navigation).find((element) => element.type === "button" && textContent(element).includes(label))!.props.onClick();
      tree = sessions.draw();
    }
    const evidenceState = () => elements(tree).find((element) => element.type === EvidencePanel)!.props.state;
    switchView("成果");
    expect(evidenceState().status).toBe("loading");
    switchView("对话");

    apiRequest.mockClear();
    const loadOlder = () => elements(tree).find((element) => element.props.className === "load-older-button")!;
    expect(textContent(loadOlder())).toContain("加载更早消息");

    apiRequest.mockResolvedValueOnce({ kind: "response", requestId: "err", ok: false, error: { code: "HISTORY_ERR", message: "历史读取超时" } });
    loadOlder().props.onClick();
    await settle(); tree = sessions.draw();
    expect(apiRequest).toHaveBeenCalledExactlyOnceWith({ method: "session.history", params: { sessionId: "A", cursor: "m-2", limit: 50 } });
    expect(textContent(loadOlder())).toContain("重试加载更早消息");
    expect(elements(tree).some((element) => element.props.role === "alert" && element.props.children === "历史读取超时")).toBe(true);
    expect(messageIds()).toEqual(["m-2", "m-3"]);

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
    expect(messageIds()).toEqual(["m-1", "m-2", "m-3"]);

    finishEvidence(evidenceStatus === "ready"
      ? { kind: "response", requestId: "evidence", ok: true, result: { evidence: { items: [{
        id: "evidence-1", sessionId: "A", startedAt: 1, status: "completed", tools: [], artifacts: [],
      }], hasMore: false } } }
      : { kind: "response", requestId: "evidence", ok: false, error: { code: "EVIDENCE_ERR", message: "成果读取超时", retryable: true } });
    await settle(); tree = sessions.draw();
    switchView("成果");
    expect(evidenceState().status).toBe(evidenceStatus);
    expect(evidenceState().items.map((item: { id: string }) => item.id)).toEqual(evidenceStatus === "ready" ? ["evidence-1"] : []);
    switchView("对话");
    expect(messageIds()).toEqual(["m-1", "m-2", "m-3"]);
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
    let streamDiv = elements(tree).find((element) => typeof element.props.className === "string" && element.props.className.includes("desktop-conversation-stream"))!;
    streamDiv.props.ref.current = fakeStream;
    tree = sessions.draw({
      ...sessionsProps,
      events: [{ eventId: "ev-tail", seq: 1, timestamp: 300, sessionId: "A", origin: "claude-desktop", itemId: "m-3", type: "assistant.completed", data: { text: "Tail reply" } }],
    });
    fakeStream.scrollTop = 250;
    streamDiv = elements(tree).find((element) => typeof element.props.className === "string" && element.props.className.includes("desktop-conversation-stream"))!;
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

  it("keeps the reading position when the first evidence page inserts a card above it", async () => {
    let finishHistory!: (response: BridgeResponse) => void;
    const openingHistory = new Promise<BridgeResponse>((resolve) => { finishHistory = resolve; });
    let finishEvidence!: (response: BridgeResponse) => void;
    const openingEvidence = new Promise<BridgeResponse>((resolve) => { finishEvidence = resolve; });
    apiRequest.mockImplementation(({ method }) => method === "session.open" ? openingHistory : openingEvidence);
    await openSessions();

    const streamDiv = () => elements(tree).find((element) => typeof element.props.className === "string" && element.props.className.includes("desktop-conversation-stream"))!;
    let anchorContentTop = 290;
    const fakeStream = {
      scrollTop: 0,
      scrollHeight: 800,
      clientHeight: 300,
      getBoundingClientRect: () => ({ top: 0, bottom: 300 }),
      querySelectorAll: () => [{
        dataset: { streamKey: "m-1" },
        getBoundingClientRect: () => ({ top: 210 - fakeStream.scrollTop, bottom: 270 - fakeStream.scrollTop }),
      }, {
        dataset: { streamKey: "m-2" },
        getBoundingClientRect: () => ({ top: anchorContentTop - fakeStream.scrollTop, bottom: anchorContentTop - fakeStream.scrollTop + 60 }),
      }],
    };
    streamDiv().props.ref.current = fakeStream;
    finishHistory({ kind: "response", requestId: "history", ok: true, result: { history: { hasMore: false, items: [
      { id: "m-1", sessionId: "A", turnId: "t-1", role: "assistant", text: "Changed files", createdAt: 10, origin: "claude-desktop" },
      { id: "m-2", sessionId: "A", turnId: "t-2", role: "user", text: "Reading here", createdAt: 20, origin: "claude-desktop" },
    ] } } });
    await settle(); tree = sessions.draw();
    fakeStream.scrollTop = 250;
    streamDiv().props.onScroll();

    anchorContentTop += 100;
    fakeStream.scrollHeight += 100;
    const collecting = { id: "live-bundle", sessionId: "A", turnId: "t-2", startedAt: 21, state: "collecting", changeCount: 1, tools: [], artifacts: [] };
    finishEvidence({ kind: "response", requestId: "evidence", ok: true, result: { evidence: { hasMore: false, items: [
      { id: "bundle", sessionId: "A", turnId: "t-1", startedAt: 9, completedAt: 11, state: "completed", changeCount: 1, tools: [], artifacts: [] },
      collecting,
    ] } } });
    await settle(); tree = sessions.draw();
    const evidenceCard = elements(tree).find((element) => element.key === "evidence:bundle");
    expect(evidenceCard).toBeDefined();
    expect.soft(fakeStream.scrollTop).toBe(350);
    expect(evidenceCard!.props.entering).toBe(false);
    expect(elements(tree).find((element) => element.key === "evidence:live-bundle")).toBeUndefined();

    tree = sessions.draw({ ...sessionsProps, events: [{
      eventId: "live-evidence-ready", seq: 1, timestamp: 22, sessionId: "A", origin: "claude-host", type: "evidence.ready",
      data: { evidence: { ...collecting, state: "completed", completedAt: 22 } },
    }] });
    expect(elements(tree).find((element) => element.key === "evidence:live-bundle")?.props.entering).toBe(true);
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

  it("keeps the projected evidence page unchanged through text deltas and merges the next evidence event", async () => {
    await openSessions();
    elements(tree).find((element) => element.type === "button" && textContent(element) === "成果")!.props.onClick();
    const page = () => elements(tree).find((element) => element.type === EvidencePanel)!.props.state;
    const evidence: BridgeEvent = {
      eventId: "evidence-ready", seq: 1, timestamp: 10, sessionId: "A", origin: "claude-host", type: "evidence.ready",
      data: { evidence: { id: "bundle", sessionId: "A", startedAt: 10, summary: "First", tools: [], artifacts: [] } },
    };
    tree = sessions.draw({ ...sessionsProps, events: [evidence] });
    const firstPage = page();
    expect(firstPage.items.map((item: { summary: string }) => item.summary)).toEqual(["First"]);

    const delta: BridgeEvent = {
      eventId: "delta", seq: 2, timestamp: 11, sessionId: "A", origin: "claude-host", type: "assistant.delta",
      itemId: "assistant", data: { text: "Still writing" },
    };
    tree = sessions.draw({ ...sessionsProps, events: [evidence, delta] });
    expect(page()).toBe(firstPage);

    const update: BridgeEvent = {
      ...evidence, eventId: "evidence-updated", seq: 3, timestamp: 12, type: "evidence.updated",
      data: { evidence: { ...evidence.data.evidence as object, summary: "Updated" } },
    };
    tree = sessions.draw({ ...sessionsProps, events: [evidence, delta, update] });
    expect(page().items.map((item: { summary: string }) => item.summary)).toEqual(["Updated"]);

    const replacement: BridgeEvent = {
      ...update,
      data: { evidence: { ...update.data.evidence as object, summary: "Replacement" } },
    };
    tree = sessions.draw({ ...sessionsProps, events: [delta, replacement] });
    expect(page().items.map((item: { summary: string }) => item.summary)).toEqual(["Replacement"]);
  });

  it("keeps live evidence that arrives while history is still opening", async () => {
    let finishHistory!: (value: BridgeResponse) => void;
    const openingHistory = new Promise<BridgeResponse>((resolve) => { finishHistory = resolve; });
    const bundle = { id: "bundle", sessionId: "A", turnId: "t-1", state: "completed", startedAt: 10, artifactCount: 0, tools: [], artifacts: [] };
    apiRequest.mockImplementation(({ method }) => method === "session.open" ? openingHistory : Promise.resolve({
      kind: "response", requestId: "evidence", ok: true,
      result: { evidence: { items: [bundle], hasMore: true, nextCursor: "older" } },
    }));
    await openSessions();
    elements(tree).find((element) => element.type === "button" && textContent(element) === "成果")!.props.onClick();
    tree = sessions.draw();
    const panel = () => elements(tree).find((element) => element.type === EvidencePanel)!.props;
    expect(panel().state).toEqual({ status: "ready", items: [expect.objectContaining(bundle)], hasMore: true, nextCursor: "older" });
    const update: BridgeEvent = {
      eventId: "update-while-opening", seq: 1, timestamp: 11, sessionId: "A", origin: "claude-host", type: "evidence.updated",
      data: { evidence: { ...bundle, artifactCount: 1 } },
    };
    tree = sessions.draw({ ...sessionsProps, events: [update] });
    expect(panel().state.items[0].artifactCount).toBe(1);

    finishHistory({ kind: "response", requestId: "history", ok: true, result: { history: { items: [
      { id: "m-1", sessionId: "A", turnId: "t-1", role: "assistant", text: "Finished", createdAt: 10, origin: "claude-desktop" },
    ], hasMore: false } } });
    await settle();
    const delta: BridgeEvent = {
      eventId: "delta-after-opening", seq: 2, timestamp: 12, sessionId: "A", origin: "claude-host", type: "assistant.delta",
      itemId: "assistant", data: { text: "Still writing" },
    };
    tree = sessions.draw({ ...sessionsProps, events: [update, delta] });
    expect(panel().state).toMatchObject({ items: [expect.objectContaining({ artifactCount: 1 })], hasMore: true, nextCursor: "older" });

    const earlier = { ...bundle, id: "earlier", turnId: "t-0", startedAt: 1 };
    apiRequest.mockResolvedValueOnce({
      kind: "response", requestId: "older-evidence", ok: true,
      result: { evidence: { items: [earlier], hasMore: false } },
    });
    await panel().onLoadMore();
    tree = sessions.draw();
    expect(apiRequest).toHaveBeenLastCalledWith({ method: "evidence.list", params: { sessionId: "A", cursor: "older", limit: 30 } });
    expect(panel().state).toEqual({
      status: "ready", items: [expect.objectContaining({ id: "bundle", artifactCount: 1 }), expect.objectContaining(earlier)], hasMore: false,
    });

    elements(tree).find((element) => element.type === "button" && textContent(element) === "对话")!.props.onClick();
    tree = sessions.draw();
    expect(elements(tree).find((element) => element.key === "evidence:bundle")?.props.entering).toBe(false);
  });

  it("pages legacy artifact details and passes opaque cursors to capable hosts", async () => {
    await openSessions();
    elements(tree).find((element) => element.type === "button" && textContent(element) === "成果")!.props.onClick();
    tree = sessions.draw();
    const loadDetails = () => elements(tree).find((element) => element.type === EvidencePanel)!.props.onLoadDetails;
    const artifacts = Array.from({ length: 32 }, (_, i) => ({ id: `artifact-${i}` }));
    apiRequest.mockResolvedValueOnce({ kind: "response", requestId: "legacy", ok: true, result: { evidence: { artifacts, tools: [] } } });
    await expect(loadDetails()("bundle", "artifacts", "30")).resolves.toEqual({
      evidenceId: "bundle", kind: "artifacts", items: artifacts.slice(30), hasMore: false,
    });
    expect(apiRequest).toHaveBeenLastCalledWith({ method: "evidence.get", params: { evidenceId: "bundle" } });

    snapshot.host.capabilities.push("evidence.details.v1");
    tree = sessions.draw({ ...sessionsProps, snapshot });
    const page = { evidenceId: "bundle", kind: "artifacts", items: [artifacts[0]], hasMore: true, nextCursor: "next" };
    apiRequest.mockResolvedValueOnce({ kind: "response", requestId: "paged", ok: true, result: { page } });
    await expect(loadDetails()("bundle", "artifacts", "opaque")).resolves.toEqual(page);
    expect(apiRequest).toHaveBeenLastCalledWith({
      method: "evidence.details", params: { evidenceId: "bundle", kind: "artifacts", cursor: "opaque", limit: 30 },
    });
  });

  it("keeps onLoadBackgroundTasks stable across live conversation and evidence events without restarting polling", async () => {
    vi.useFakeTimers();
    try {
      snapshot.host.capabilities.push("claude.native-relay.v1");
      snapshot.runtime.desktopIntegration.state = "ready";
      history = [{ id: "m1", sessionId: "A", role: "user", text: "Run checks", createdAt: 1, origin: "claude-desktop" }];
      let backgroundTaskReads = 0;
      apiRequest.mockImplementation(async ({ method, params }) => {
        if (method === "session.configuration" && (params as { includeBackgroundTasks?: boolean })?.includeBackgroundTasks) {
          backgroundTaskReads += 1;
          return {
            kind: "response",
            requestId: `bg-${backgroundTaskReads}`,
            ok: true,
            result: { session: { ...snapshot.sessions[0]!, backgroundTasks: [] } },
          };
        }
        return {
          kind: "response",
          requestId: "open",
          ok: true,
          result: method === "session.open"
            ? { history: { items: history, hasMore: false } }
            : { evidence: { items: [], hasMore: false } },
        };
      });
      await openSessions();
      await settle(); tree = sessions.draw();
      expect(backgroundTaskReads).toBe(1);

      const firstEvents: BridgeEvent[] = [
        { eventId: "ev-1", seq: 1, timestamp: 2, sessionId: "A", origin: "claude-desktop", type: "tool.started", itemId: "t1", data: { toolName: "Bash", text: "npm test" } },
      ];
      tree = sessions.draw({ ...sessionsProps, snapshot, events: firstEvents });
      await settle(); tree = sessions.draw();

      const secondEvents: BridgeEvent[] = [
        ...firstEvents,
        { eventId: "ev-2", seq: 2, timestamp: 3, sessionId: "A", origin: "claude-desktop", type: "evidence.updated", itemId: "ev1", data: { evidence: { id: "ev1", sessionId: "A", startedAt: 2, tools: [], artifacts: [] } } },
        { eventId: "ev-3", seq: 3, timestamp: 4, sessionId: "A", origin: "claude-desktop", type: "assistant.delta", itemId: "a1", data: { text: "Progress..." } },
      ];
      tree = sessions.draw({ ...sessionsProps, snapshot, events: secondEvents });
      await settle(); tree = sessions.draw();

      expect(backgroundTaskReads).toBe(1);
      await vi.advanceTimersByTimeAsync(2_000);
      await settle(); tree = sessions.draw();
      expect(backgroundTaskReads).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([true, false])("confirms workspace non-media file downloads and surfaces transfer errors (relative link support: %s)", async (supportsRelativeLinks) => {
    const { downloadBridgeSessionFile } = await import("../lib/artifact-download.js");
    if (supportsRelativeLinks) snapshot.host.capabilities.push("artifact.transfer.relative-link.v1");
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
    expect(downloadBridgeSessionFile).toHaveBeenCalledWith("A", "dist/bundle.bin", expect.any(Function), expect.any(Function), supportsRelativeLinks ? true : undefined);
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
    await elements(tree).find((element) => element.type === "button" && element.props.children === "立即发送")!.props.onClick();
    await settle(); tree = sessions.draw();
    expect(apiRequest).toHaveBeenCalledExactlyOnceWith({ method: "turn.queue.steer", params: { sessionId: "A", commandId: "cmd-queued-1" } });
    expect(textContent(tree)).toContain("消息投递状态尚未确认，请同步状态后重试");

    apiRequest.mockClear();
    apiRequest.mockResolvedValueOnce({ kind: "response", requestId: "steer-ok", ok: true, result: { state: "queued" } });
    await elements(tree).find((element) => element.type === "button" && element.props.children === "立即发送")!.props.onClick();
    await settle(); tree = sessions.draw();
    expect(elements(tree).find((element) => element.type === "button" && element.props.children === "立即发送")!.props.disabled).toBe(true);
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

  it("renders shared session-channel-warning banners and fork chain bar without legacy desktop-channel-banner", async () => {
    snapshot.host.capabilities.push("session.visibility.v1");
    snapshot.runtime.desktopIntegration.state = "ready";
    snapshot.sessions = [
      { ...snapshot.sessions[0]!, sessionId: "parent-1", title: "Parent Session" },
      { ...snapshot.sessions[0]!, sessionId: "fork-1", title: "Archived Fork", parentSessionId: "parent-1", archivedAt: 200 },
    ];
    await openSessions();
    elements(tree).find(element => element.props["aria-controls"] === "desktop-archived-sessions")!.props.onClick();
    tree = sessions.draw();
    elements(tree).find(element => element.type === "button" && element.props.className === "session-row-hit" && textContent(element).includes("Archived Fork"))!.props.onClick();
    await settle();
    tree = sessions.draw();

    const warnings = elements(tree).filter(element => element.props.className === "session-channel-warning");
    expect(warnings.some(element => textContent(element).includes("此会话已归档"))).toBe(true);
    const forkBar = elements(tree).find(element => element.props.className === "relay-chain-bar fork-chain-bar")!;
    expect(textContent(forkBar)).toContain("主会话：Parent Session");

    apiRequest.mockResolvedValueOnce({ kind: "response", requestId: "fork-fail", ok: false, error: { code: "FAILED", message: "分支创建失败" } });
    elements(tree).find(element => element.type === IconButton && element.props.label === "会话操作")!.props.onClick();
    tree = sessions.draw();
    await elements(tree).find(element => element.type === SheetAction && element.props.label === "Fork 分支")!.props.onClick();
    await settle();
    tree = sessions.draw();
    const menuSheet = elements(tree).find(element => element.type === Sheet && element.props.title === "Archived Fork")!;
    expect(elements(menuSheet).some(element => element.props.role === "alert" && textContent(element).includes("分支创建失败"))).toBe(true);
    expect(elements(tree).some(element => typeof element.props.className === "string" && element.props.className.includes("desktop-channel-banner"))).toBe(false);
  });
});

describe("unified desktop and assistant conversation composition", () => {
  it("shares drafts, history, evidence and transfers across desktop tabs and stops reopening unmounted conversations", async () => {
    snapshot.host.capabilities.push("plugin.assistant-mail.v1");
    snapshot.sessions = [
      snapshot.sessions[0]!,
      { ...snapshot.sessions[0]!, sessionId: "B", title: "Session B" },
    ];
    snapshot.assistantMail = {
      binding: {
        assistantId: "assistant-1",
        nativeSessionId: "A",
        sectionId: null,
        previousSessionIds: ["B"],
      },
      bindingState: "ready",
      receiverState: "connected",
      changeToken: "tok",
      automaticDelivery: false,
    };
    mailContext.current = {
      assistant: snapshot.assistantMail,
      online: true,
      loading: false,
      error: "",
      cache: { changeToken: "tok", cards: [] },
      refresh: vi.fn(),
      loadOlder: vi.fn(),
      request: apiRequest,
      referenceFor: () => undefined,
    };
    history = [
      { id: "msg-shared-1", sessionId: "A", role: "assistant", text: "Shared native reply", createdAt: 10, origin: "claude-desktop" },
    ];
    let pushEvent!: (event: BridgeEvent) => void;
    window.bridgeDesktop!.onEvent = (listener) => {
      pushEvent = listener;
      return () => undefined;
    };

    const fullDashboard = renderer(
      DesktopDashboard,
      {
        themeControl: { theme: "dark", family: "apple", setTheme: vi.fn(), setFamily: vi.fn(), toggleTheme: vi.fn() },
      },
      { expandDashboard: true },
    );
    fullDashboard.draw();
    await settle();
    fullDashboard.draw();
    await settle();
    let fullTree = fullDashboard.draw();

    const composerInput = () => elements(fullTree).find((element) => element.type === SlashCommandInput)!;
    expect(elements(fullTree).some((element) => element.type === DesktopSessions)).toBe(true);
    expect(elements(fullTree).some((element) => String(element.props.className).includes("desktop-session-sidebar"))).toBe(true);
    expect(elements(fullTree).some((element) => element.props.className === "desktop-nav-v2")).toBe(false);
    expect(elements(fullTree).filter((element) => element.type === ConversationMessageItem).map((element) => element.props.item.id)).toEqual(["msg-shared-1"]);

    composerInput().props.onChange("从会话页输入的草稿");
    fullTree = fullDashboard.draw();
    expect(composerInput().props.value).toBe("从会话页输入的草稿");

    const navButton = (label: string) => elements(fullTree).find((element) => (
      element.type === "button"
      && elements(element).some((child) => child.type === "span" && child.props.children === label)
    ))!;

    navButton("助理").props.onClick();
    await settle();
    fullTree = fullDashboard.draw();

    const assistantEl = elements(fullTree).find((element) => element.type === AssistantPage)!;
    expect(assistantEl).toBeDefined();
    expect(elements(fullTree).some((element) => element.type === DesktopSessionConversation)).toBe(true);
    expect(elements(fullTree).some((element) => element.type === ConversationView)).toBe(true);
    expect(elements(fullTree).some((element) => element.type === DesktopSessions)).toBe(true);
    expect(elements(assistantEl).some((element) => String(element.props.className).includes("desktop-session-sidebar"))).toBe(false);
    expect(elements(fullTree).some((element) => typeof element.props.className === "string" && element.props.className.includes("is-fixed-session"))).toBe(false);
    expect(composerInput().props.value).toBe("从会话页输入的草稿");
    expect(elements(fullTree).filter((element) => element.type === ConversationMessageItem).map((element) => element.props.item.id)).toEqual(["msg-shared-1"]);

    // Survives 助理 subview switches: 对话 -> 收件 -> 助理设置 -> 对话
    const assistantTabs = () => elements(fullTree).find((element) => element.props.className === "assistant-view-tabs")!;
    elements(assistantTabs()).find((element) => element.type === "button" && element.props.children === "收件")!.props.onClick();
    fullTree = fullDashboard.draw();
    expect(elements(fullTree).filter((element) => element.type === ConversationView)).toHaveLength(1);
    expect(elements(fullTree).find((element) => element.type === ConversationView)?.props.alternateStage).toBeDefined();
    expect(composerInput().props.value).toBe("从会话页输入的草稿");
    const sharedEvidence = { id: "shared-bundle", sessionId: "A", startedAt: 12, summary: "Shared evidence", tools: [], artifacts: [] };
    apiRequest.mockClear();
    apiRequest.mockImplementation(async ({ method, params }) => ({
      kind: "response", requestId: "test", ok: true,
      result: method === "session.open" ? { history: { items: history, hasMore: false } }
        : method === "evidence.list" ? { evidence: { items: params.sessionId === "A" ? [sharedEvidence] : [], hasMore: false } } : {},
    }));
    pushEvent({
      eventId: "shared-compact", seq: 1, timestamp: 11, sessionId: "A", origin: "claude-host", type: "session.compacted", data: {},
    });
    pushEvent({
      eventId: "shared-evidence", seq: 2, timestamp: 12, sessionId: "A", origin: "claude-host", type: "evidence.ready",
      data: { evidence: sharedEvidence },
    });
    fullTree = fullDashboard.draw();
    expect(apiRequest.mock.calls.filter(([request]) => request.method === "session.open")).toHaveLength(1);

    elements(assistantTabs()).find((element) => element.type === IconButton && element.props.label === "助理设置")!.props.onClick();
    fullTree = fullDashboard.draw();
    expect(elements(fullTree).find((element) => element.type === ConversationView)?.props.hideComposer).toBe(true);
    elements(assistantTabs()).find((element) => element.type === "button" && element.props.children === "对话")!.props.onClick();
    fullTree = fullDashboard.draw();
    const conversationEvidence = () => elements(fullTree).find((element) => element.type === ConversationView)?.props.evidence;
    await settle();
    fullTree = fullDashboard.draw();
    expect(conversationEvidence()).toMatchObject({ status: "ready", items: [{ id: "shared-bundle" }] });
    expect(composerInput().props.value).toBe("从会话页输入的草稿");
    expect(apiRequest.mock.calls.filter(([request]) => request.method === "session.open")).toHaveLength(1);

    composerInput().props.onChange("助理页修改后的草稿");
    let finishDownload!: () => void;
    vi.mocked(downloadBridgeSessionFile).mockImplementationOnce((_sessionId, _path, _request, onProgress) => {
      onProgress(0.5);
      return new Promise<void>((resolve) => { finishDownload = resolve; });
    });
    const download = elements(fullTree).find((element) => element.type === ConversationView)!.props.onDownloadSessionFile("A", "dist/report.zip");
    fullTree = fullDashboard.draw();

    // Delegated navigation to another session switches DesktopDashboard back to 会话 focused on Session B
    elements(assistantTabs()).find((element) => element.type === IconButton && element.props.label === "助理设置")!.props.onClick();
    fullTree = fullDashboard.draw();
    elements(fullTree).find((element) => element.type === "button" && element.props.className === "assistant-session-link" && element.props.children === "Session B")!.props.onClick();
    await settle();
    fullTree = fullDashboard.draw();

    expect(elements(fullTree).some((element) => element.type === DesktopSessions)).toBe(true);
    expect(elements(fullTree).some((element) => String(element.props.className).includes("desktop-session-sidebar"))).toBe(true);
    expect(textContent(elements(fullTree).find((element) => typeof element.props.className === "string" && element.props.className.startsWith("m-header"))!)).toContain("Session B");

    // Switching back to Session A in 会话 shows the updated draft from 助理
    elements(fullTree).find((element) => element.type === "button" && element.props.className === "session-row-hit" && textContent(element).includes("Session A"))!.props.onClick();
    await settle();
    fullTree = fullDashboard.draw();
    expect(composerInput().props.value).toBe("助理页修改后的草稿");

    elements(fullTree).find((element) => element.type === "button" && textContent(element) === "成果")!.props.onClick();
    fullTree = fullDashboard.draw();
    expect(elements(fullTree).find((element) => element.type === EvidencePanel)!.props.transfers).toEqual({ "file:dist/report.zip": 0.5 });
    finishDownload();
    await download;
    fullTree = fullDashboard.draw();
    expect(elements(fullTree).find((element) => element.type === EvidencePanel)!.props.transfers).toEqual({});
  });

  it("isolates retained and live event buffers across host switches without replaying old evidence or rewound events", async () => {
    let pushSnapshot: ((next: DesktopControlSnapshot) => void) | undefined;
    let pushEvent: ((event: BridgeEvent) => void) | undefined;
    vi.stubGlobal("window", {
      bridgeDesktop: {
        getSnapshot: async () => snapshot,
        onSnapshot: (listener: (next: DesktopControlSnapshot) => void) => {
          pushSnapshot = listener;
          return () => undefined;
        },
        onEvent: (listener: (event: BridgeEvent) => void) => {
          pushEvent = listener;
          return () => undefined;
        },
        request: apiRequest,
      },
    });

    const fullDashboard = renderer(
      DesktopDashboard,
      {
        themeControl: { theme: "dark", family: "apple", setTheme: vi.fn(), setFamily: vi.fn(), toggleTheme: vi.fn() },
      },
      { expandDashboard: true },
    );
    fullDashboard.draw();
    await settle();
    fullDashboard.draw();
    await settle();
    let fullTree = fullDashboard.draw();

    const evidenceEvent: BridgeEvent = {
      eventId: "ev-bundle-1",
      seq: 1,
      timestamp: 10,
      origin: "claude-host",
      sessionId: "A",
      type: "evidence.ready",
      data: {
        evidence: {
          id: "bundle-host-1",
          sessionId: "A",
          turnId: "turn-1",
          startedAt: 10,
          summary: "Host 1 bundle",
          tools: [],
          artifacts: [],
        },
      },
    };
    const rewoundEvent: BridgeEvent = {
      eventId: "ev-rewound-1",
      seq: 2,
      timestamp: 11,
      origin: "claude-host",
      sessionId: "A",
      type: "session.rewound",
      data: {},
    };
    pushEvent!(evidenceEvent);
    pushEvent!(rewoundEvent);
    fullTree = fullDashboard.draw();
    await settle();
    fullTree = fullDashboard.draw();

    // Switch conversation to 成果 view on host-1 and verify bundle-host-1 is present
    const viewSwitch = () => elements(fullTree).find((element) => element.props.className === "session-view-switch desktop-session-view-switch")!;
    elements(viewSwitch()).find((element) => element.type === "button" && textContent(element).includes("成果"))!.props.onClick();
    fullTree = fullDashboard.draw();
    expect(elements(fullTree).find((element) => element.type === EvidencePanel)!.props.state?.items.map((item: any) => item.id)).toEqual(["bundle-host-1"]);

    // Switch DesktopDashboard snapshot to host-2
    apiRequest.mockClear();
    const host2Snapshot: DesktopControlSnapshot = {
      ...snapshot,
      host: { ...snapshot.host, hostId: "computer-2", name: "Computer 2" },
    };
    snapshot = host2Snapshot;
    pushSnapshot!(host2Snapshot);
    fullTree = fullDashboard.draw();
    await settle();
    fullTree = fullDashboard.draw();

    expect(apiRequest.mock.calls.filter(([req]) => req.method === "session.open")).toHaveLength(1);
    elements(viewSwitch()).find((element) => element.type === "button" && textContent(element).includes("成果"))!.props.onClick();
    fullTree = fullDashboard.draw();
    expect(elements(fullTree).find((element) => element.type === EvidencePanel)!.props.state?.items ?? []).toEqual([]);

    // Also verify standalone DesktopSessions when caller retains the same events array across a host switch
    const retainedEvents: BridgeEvent[] = [
      evidenceEvent,
      rewoundEvent,
      {
        eventId: "ev-compacted-1",
        seq: 3,
        timestamp: 12,
        origin: "claude-host",
        sessionId: "A",
        type: "session.compacted",
        data: {},
      },
    ];
    const host1Snapshot: DesktopControlSnapshot = {
      ...host2Snapshot,
      host: { ...host2Snapshot.host, hostId: "standalone-host-1" },
    };
    const standalone = renderer(StandaloneDesktopSessions, {
      snapshot: host1Snapshot,
      events: retainedEvents,
      apiRequest,
      onRefreshSnapshot: async () => undefined,
    });
    standalone.draw();
    await settle();
    let standaloneTree = standalone.draw();
    const standaloneSwitch = () => elements(standaloneTree).find((element) => element.props.className === "session-view-switch desktop-session-view-switch")!;
    elements(standaloneSwitch()).find((element) => element.type === "button" && textContent(element).includes("成果"))!.props.onClick();
    standaloneTree = standalone.draw();
    expect(elements(standaloneTree).find((element) => element.type === EvidencePanel)!.props.state?.items.map((item: any) => item.id)).toEqual(["bundle-host-1"]);

    apiRequest.mockClear();
    const standaloneHost2: DesktopControlSnapshot = {
      ...host1Snapshot,
      host: { ...host1Snapshot.host, hostId: "standalone-host-2" },
    };
    standaloneTree = standalone.draw({
      snapshot: standaloneHost2,
      events: retainedEvents,
      apiRequest,
      onRefreshSnapshot: async () => undefined,
    });
    await settle();
    standaloneTree = standalone.draw();
    expect(apiRequest.mock.calls.filter(([req]) => req.method === "session.open")).toHaveLength(1);
    elements(standaloneSwitch()).find((element) => element.type === "button" && textContent(element).includes("成果"))!.props.onClick();
    standaloneTree = standalone.draw();
    expect(elements(standaloneTree).find((element) => element.type === EvidencePanel)!.props.state?.items ?? []).toEqual([]);
  });

  it("cancels in-flight artifact and session file downloads when switching hosts after transfer.open is in flight", async () => {
    const actualDownloadModule = await vi.importActual<typeof import("../lib/artifact-download.js")>("../lib/artifact-download.js");
    vi.mocked(downloadBridgeSessionFile).mockImplementation(actualDownloadModule.downloadBridgeSessionFile);

    history = [
      { id: "msg-file", sessionId: "A", role: "assistant", text: "Check `dist/archive.zip`", createdAt: 10, origin: "claude-desktop" },
    ];

    let resolveArtifactOpen!: (value: BridgeResponse) => void;
    let resolveSessionFileOpen!: (value: BridgeResponse) => void;
    const host1Api = vi.fn(async ({ method, params }: { method: string; params?: Record<string, unknown> }): Promise<BridgeResponse> => {
      if (method === "session.open") {
        return { kind: "response", requestId: "open-1", ok: true, result: { history: { items: history, hasMore: false } } };
      }
      if (method === "evidence.list") {
        return {
          kind: "response",
          requestId: "ev-1",
          ok: true,
          result: {
            evidence: {
              items: [{
                id: "bundle-1",
                sessionId: "A",
                turnId: "turn-1",
                startedAt: 10,
                summary: "Bundle",
                tools: [],
                artifacts: [{ id: "art-1", kind: "file", name: "build.zip", mimeType: "application/zip", size: 128, createdAt: 10 }],
              }],
              hasMore: false,
            },
          },
        };
      }
      if (method === "artifact.transfer.open") {
        if ("artifactId" in (params ?? {})) {
          return new Promise<BridgeResponse>((resolve) => {
            resolveArtifactOpen = resolve;
          });
        }
        return new Promise<BridgeResponse>((resolve) => {
          resolveSessionFileOpen = resolve;
        });
      }
      return { kind: "response", requestId: "other-1", ok: true, result: {} };
    });

    const host2Api = vi.fn(async ({ method }: { method: string }): Promise<BridgeResponse> => ({
      kind: "response",
      requestId: "host2",
      ok: true,
      result: method === "session.open"
        ? { history: { items: history, hasMore: false } }
        : method === "evidence.list"
          ? { evidence: { items: [], hasMore: false } }
          : {},
    }));

    const host1Snapshot: DesktopControlSnapshot = {
      ...snapshot,
      host: { ...snapshot.host, hostId: "dl-host-1" },
    };
    const host2Snapshot: DesktopControlSnapshot = {
      ...snapshot,
      host: { ...snapshot.host, hostId: "dl-host-2" },
    };

    const standalone = renderer(StandaloneDesktopSessions, {
      snapshot: host1Snapshot,
      events: [],
      apiRequest: host1Api,
      onRefreshSnapshot: async () => undefined,
    });
    standalone.draw();
    await settle();
    let standaloneTree = standalone.draw();

    // 1) Trigger workspace session file download on host-1 (deferred artifact.transfer.open)
    const msgItem = elements(standaloneTree).find((element) => element.type === ConversationMessageItem)!;
    msgItem.props.onFileClick("dist/archive.zip");
    standaloneTree = standalone.draw();
    const confirmDialog = elements(standaloneTree).find((element) => element.type === ConfirmationDialog && element.props.title === "确认下载工作区文件？")!;
    expect(confirmDialog.props.open).toBe(true);
    confirmDialog.props.onConfirm();

    // 2) Switch to 成果 view and trigger EvidencePanel.onDownload(artifact) on host-1 (deferred artifact.transfer.open)
    const viewSwitch = elements(standaloneTree).find((element) => element.props.className === "session-view-switch desktop-session-view-switch")!;
    elements(viewSwitch).find((element) => element.type === "button" && textContent(element).includes("成果"))!.props.onClick();
    standaloneTree = standalone.draw();
    const artifact: BridgeArtifactManifest = {
      id: "art-1",
      evidenceId: "bundle-1",
      relativePath: "dist/build.zip",
      name: "build.zip",
      kind: "binary",
      changeKind: "created",
      mimeType: "application/zip",
      size: 128,
      availability: "snapshot",
      previewMode: "none",
      downloadAllowed: true,
      capturedAt: 10,
    };
    const artifactDownloadPromise = elements(standaloneTree).find((element) => element.type === EvidencePanel)!.props.onDownload(artifact);
    await settle();

    expect(typeof resolveArtifactOpen).toBe("function");
    expect(typeof resolveSessionFileOpen).toBe("function");
    const transfers = () => elements(standaloneTree).find((element) => element.type === ConversationView)!.props.renderEvidence({}).props.transfers;
    standaloneTree = standalone.draw();
    expect(transfers()).toEqual({ "art-1": 0, "file:dist/archive.zip": 0 });

    // 3) Switch active host from dl-host-1 to dl-host-2 BEFORE either transfer.open resolves
    standaloneTree = standalone.draw({
      snapshot: host2Snapshot,
      events: [],
      apiRequest: host2Api,
      onRefreshSnapshot: async () => undefined,
    });
    await settle();
    expect(transfers()).toEqual({});
    expect(collectDiagnosticsStateSnapshot().desktopConversations).toMatchObject({ artifactTransfersCount: 2 });
    host1Api.mockClear();
    host2Api.mockClear();

    // 4) Resolve the old host's open responses one at a time and observe cleanup
    resolveArtifactOpen({
      kind: "response",
      requestId: "open-art",
      ok: true,
      result: {
        transfer: {
          transferId: "transfer-art-host-1",
          name: "build.zip",
          mimeType: "application/zip",
          size: 128,
          sha256: "00",
          chunkSize: 64,
          totalChunks: 2,
          expiresAt: Date.now() + 60_000,
        },
      },
    });
    await expect(artifactDownloadPromise).rejects.toThrow("主机已切换");
    standaloneTree = standalone.draw();
    expect(collectDiagnosticsStateSnapshot().desktopConversations).toMatchObject({ artifactTransfersCount: 1 });

    resolveSessionFileOpen({
      kind: "response",
      requestId: "open-file",
      ok: true,
      result: {
        transfer: {
          transferId: "transfer-file-host-1",
          name: "report.txt",
          mimeType: "text/plain",
          size: 64,
          sha256: "00",
          chunkSize: 32,
          totalChunks: 2,
          expiresAt: Date.now() + 60_000,
        },
      },
    });

    await settle();
    standaloneTree = standalone.draw();
    expect(collectDiagnosticsStateSnapshot().desktopConversations).toMatchObject({ artifactTransfersCount: 0 });
    expect(elements(standaloneTree).some((element) => element.props.role === "alert" && textContent(element).includes("主机已切换"))).toBe(true);

    // Neither host-2 nor host-1 receives read or close with stale transferIds after the host switch
    expect(host2Api).not.toHaveBeenCalled();
    expect(host1Api).not.toHaveBeenCalled();

    standaloneTree = standalone.draw({
      snapshot: host1Snapshot,
      events: [],
      apiRequest: host1Api,
      onRefreshSnapshot: async () => undefined,
    });
    expect(transfers()).toEqual({});
  });
});

describe("desktop mobile-aligned session sidebar and permission dock", () => {
  it("keeps the sidebar delete confirmation open on rejection and closes it after retry", async () => {
    snapshot.host.capabilities.push("session.visibility.v1");
    await openSessions();
    elements(tree).find((element) => element.type === IconButton && element.props.label === `会话操作：${snapshot.sessions[0]!.title}`)!.props.onClick();
    elements(sessions.draw()).find((element) => element.type === SheetAction && element.props.label === "删除会话")!.props.onClick();
    const confirmation = () => elements(sessions.draw()).find((element) => element.type === ConfirmationDialog && element.props.open);
    apiRequest.mockClear().mockResolvedValueOnce({
      kind: "response", requestId: "delete", ok: false, error: { code: "FAILED", message: "侧栏删除失败" },
    });

    confirmation()!.props.onConfirm();
    await settle();
    expect(confirmation()?.props).toMatchObject({ open: true, busy: false, error: "侧栏删除失败" });
    expect(apiRequest).toHaveBeenCalledExactlyOnceWith({ method: "session.delete", params: { sessionId: "A" } });

    confirmation()!.props.onConfirm();
    await settle();
    expect(confirmation()).toBeUndefined();
    expect(elements(sessions.draw()).some((element) => element.type === Sheet)).toBe(false);
  });

  it("filters sessions across title, summary, cwd, and runtime and jumps to pending permissions", async () => {
    snapshot.sessions.push({
      ...snapshot.sessions[0]!,
      sessionId: "B",
      title: "Backend Worker",
      currentSummary: "Investigating Redis latency",
      projectId: "second",
      projectName: "Service",
      cwd: "/srv/redis-api",
      runtimeId: "codex-desktop",
      transport: "bridge-host",
      lastActivityAt: 2,
    });
    snapshot.projects.push({
      ...snapshot.projects[0]!,
      projectId: "second",
      name: "Service",
      cwd: "/srv/redis-api",
      lastActivityAt: 2,
    });
    snapshot.permissions = [{
      requestId: "perm-bash",
      sessionId: "A",
      toolUseId: "tool-bash",
      toolName: "Bash",
      input: { command: "git status" },
      createdAt: 5,
      canAllowAlways: true,
    }];
    await openSessions();
    tree = sessions.draw({ ...sessionsProps, snapshot });

    const searchInput = () => elements(elements(tree).find((element) => element.props.className === "session-search")!)
      .find((element) => element.type === "input")!;
    searchInput().props.onChange({ target: { value: "redis latency" } });
    tree = sessions.draw({ ...sessionsProps, snapshot });
    expect(elements(tree).filter((element) => element.type === ProjectGroupHeader).map((element) => element.props.title)).toEqual(["Service"]);

    searchInput().props.onChange({ target: { value: "nonexistent-keyword" } });
    tree = sessions.draw({ ...sessionsProps, snapshot });
    expect(textContent(tree)).toContain("没有匹配的会话");

    // Clicking host-permission-alert clears search, expands target project, and selects session A
    const alertBtn = elements(tree).find((element) => element.props.className === "host-permission-alert")!;
    expect(textContent(alertBtn)).toContain("有操作待你授权");
    alertBtn.props.onClick();
    await settle();
    tree = sessions.draw({ ...sessionsProps, snapshot });
    expect(searchInput().props.value).toBe("");
    expect(elements(tree).find((element) => element.props["data-session-id"] === "A")!.props.className).toContain("active");

    // Permission dock opens shared Sheet with PermissionPrompt on Desktop
    const dockBtn = elements(tree).find((element) => element.props.className === "permission-dock")!;
    expect(textContent(dockBtn)).toContain("正在等待授权");
    dockBtn.props.onClick();
    tree = sessions.draw({ ...sessionsProps, snapshot });
    const prompt = elements(tree).find((element) => element.type === PermissionPrompt)!;
    expect(prompt.props.permission.requestId).toBe("perm-bash");
  });

  it("supports directory menu actions, section create/rename/delete, and directory browse/mkdir in SessionCreateDialog", async () => {
    snapshot.host.capabilities.push(
      "section.create.v1",
      "section.rename.v1",
      "section.delete.v1",
      "directory.browse.v1",
      "directory.mkdir.v1",
    );
    snapshot.projects.push({
      projectId: "sec-1",
      name: "Research",
      cwd: "",
      kind: "desktop-group",
      sessionCount: 0,
      runningCount: 0,
      pendingCount: 0,
      lastActivityAt: 0,
    });
    const refresh = vi.fn().mockResolvedValue(undefined);
    await openSessions();
    tree = sessions.draw({ ...sessionsProps, onRefreshSnapshot: refresh });

    // Sidebar collapse & expand toggle via right-pane header leading button; no ⋯ 目录选项 next to hostname
    expect(elements(tree).some((element) => element.type === IconButton && element.props.label === "目录选项")).toBe(false);
    expect(textContent(tree)).not.toContain("项目顺序已固定");
    elements(tree).find((element) => element.type === IconButton && element.props.label === "收起侧栏")!.props.onClick();
    tree = sessions.draw();
    expect(elements(tree).some((element) => String(element.props.className).includes("desktop-session-sidebar"))).toBe(false);
    elements(tree).find((element) => element.type === IconButton && element.props.label === "展开侧栏")!.props.onClick();
    tree = sessions.draw();
    expect(elements(tree).some((element) => String(element.props.className).includes("desktop-session-sidebar"))).toBe(true);

    // 0-session manual group (Research) defaults to collapsed until explicitly expanded or newly created
    expect(elements(tree).some((element) => element.props.className === "project-group-empty")).toBe(false);
    elements(tree).find((element) => element.type === ProjectGroupHeader && element.props.title === "Research")!.props.onToggle();
    tree = sessions.draw();
    expect(elements(tree).some((element) => element.props.className === "project-group-empty" && element.props.children === "此分组暂无会话")).toBe(true);

    // Create section via 项目 micro-header + 分组 -> 新建 Section modal (auto-expanded via revealedEmptySectionKey)
    elements(tree).find((element) => element.type === "button" && element.props.children === "+ 分组")!.props.onClick();
    tree = sessions.draw();
    const sectionInput = elements(tree).find((element) => element.props["aria-label"] === "Section 名称")!;
    sectionInput.props.onChange({ target: { value: "Experiments" } });
    tree = sessions.draw();
    apiRequest.mockResolvedValueOnce({
      kind: "response",
      requestId: "sec-create",
      ok: true,
      result: {
        project: {
          projectId: "sec-2",
          name: "Experiments",
          cwd: "",
          kind: "desktop-group",
          sessionCount: 0,
          runningCount: 0,
          pendingCount: 0,
          lastActivityAt: 0,
        },
      },
    });
    const sectionDialog = elements(tree).find((element) => element.props["aria-label"] === "新建 Section")!;
    const sectionForm = elements(sectionDialog).find((element) => element.type === "form")!;
    sectionForm.props.onSubmit({ preventDefault: vi.fn() });
    await settle();
    expect(apiRequest).toHaveBeenCalledWith({ method: "section.create", params: { name: "Experiments" } });
    expect(refresh).toHaveBeenCalledTimes(1);

    // Rename & delete empty section via per-group 管理分组：<项目名> (with manageFocus enabled on Sheet)
    tree = sessions.draw();
    elements(tree).find((element) => element.type === IconButton && element.props.label === "管理分组：Research")!.props.onClick();
    tree = sessions.draw();
    expect(elements(tree).find((element) => element.type === Sheet && element.props.title === "Research")?.props.manageFocus).toBe(true);
    elements(tree).find((element) => element.type === SheetAction && element.props.label === "重命名分组")!.props.onClick();
    tree = sessions.draw();
    elements(tree).find((element) => element.props["aria-label"] === "分组名称")!.props.onChange({ target: { value: "Lab" } });
    tree = sessions.draw();
    apiRequest.mockResolvedValueOnce({ kind: "response", requestId: "sec-rename", ok: true, result: {} });
    const renameSectionDialog = elements(tree).find((element) => element.props["aria-label"] === "重命名分组")!;
    elements(renameSectionDialog).find((element) => element.type === "form")!.props.onSubmit({ preventDefault: vi.fn() });
    await settle();
    expect(apiRequest).toHaveBeenCalledWith({ method: "section.rename", params: { sectionId: "sec-1", name: "Lab" } });

    tree = sessions.draw();
    elements(tree).find((element) => element.type === IconButton && element.props.label === "管理分组：Research")!.props.onClick();
    tree = sessions.draw();
    apiRequest.mockResolvedValueOnce({ kind: "response", requestId: "sec-delete", ok: true, result: {} });
    elements(tree).find((element) => element.type === SheetAction && element.props.label === "删除空分组")!.props.onClick();
    await settle();
    expect(apiRequest).toHaveBeenCalledWith({ method: "section.delete", params: { sectionId: "sec-1" } });

    // When !hasActiveSessions && !searchQuery, sidebar shows ONLY clean EmptyState and right pane renders NewChatCanvas
    const emptySnapshot: DesktopControlSnapshot = {
      ...snapshot,
      sessions: [],
      projects: [{
        projectId: "sec-empty",
        name: "Empty Section",
        cwd: "",
        kind: "desktop-group",
        sessionCount: 0,
        runningCount: 0,
        pendingCount: 0,
        lastActivityAt: 0,
      }],
    };
    tree = sessions.draw({ ...sessionsProps, snapshot: emptySnapshot });
    expect(elements(tree).find((element) => element.type === EmptyState)?.props.title).toBe("未检测到 Claude Desktop");
    const readyEmptySnapshot: DesktopControlSnapshot = {
      ...emptySnapshot,
      runtime: {
        ...emptySnapshot.runtime,
        desktopIntegration: { ...emptySnapshot.runtime.desktopIntegration, state: "ready" },
      },
    };
    tree = sessions.draw({ ...sessionsProps, snapshot: readyEmptySnapshot });
    expect(elements(tree).find((element) => element.type === EmptyState)?.props.title).toBe("暂无活跃会话");
    expect(elements(tree).some((element) => element.props.className === "primary-button session-catalog-empty-action")).toBe(true);
    expect(elements(tree).some((element) => element.type === ProjectGroupHeader)).toBe(false);
    expect(elements(tree).some((element) => element.type === NewChatCanvas)).toBe(true);
    expect(textContent(tree)).toContain("工作目录");

    // Desktop 会话操作 menu includes 同步此会话 via onOpenSession and pauses Sheet focus while delete ConfirmationDialog is open
    snapshot.host.capabilities.push("session.visibility.v1");
    tree = sessions.draw(sessionsProps);
    await settle();
    elements(tree).find((element) => element.type === IconButton && element.props.label === "会话操作")!.props.onClick();
    tree = sessions.draw();
    const syncAction = elements(tree).find((element) => element.type === SheetAction && element.props.label === "同步此会话");
    expect(syncAction).toBeDefined();
    const openCallsBefore = apiRequest.mock.calls.filter(([req]) => req.method === "session.open").length;
    await syncAction!.props.onClick();
    await settle();
    sessionsProps = elements(dashboard.draw()).find((element) => typeof element.type === "function" && element.type.name === "DesktopSessions")!.props;
    tree = sessions.draw(sessionsProps);
    expect(apiRequest.mock.calls.filter(([req]) => req.method === "session.open").length).toBe(openCallsBefore + 1);
    expect(elements(tree).some((element) => element.type === SheetAction && element.props.label === "已同步")).toBe(true);

    // Sync failure surfaces error alert inside Sheet
    apiRequest.mockImplementationOnce(async (req: any) => (
      req.method === "session.open"
        ? { kind: "response", requestId: "open-fail", ok: false, error: { code: "READ_FAILED", message: "记录同步失败", retryable: true } }
        : { kind: "response", requestId: "other", ok: true, result: { evidence: { items: [], hasMore: false } } }
    ));
    await elements(tree).find((element) => element.type === SheetAction && element.props.label === "已同步")!.props.onClick();
    await settle();
    sessionsProps = elements(dashboard.draw()).find((element) => typeof element.type === "function" && element.type.name === "DesktopSessions")!.props;
    tree = sessions.draw(sessionsProps);
    expect(elements(tree).some((element) => element.props.role === "alert" && textContent(element).includes("记录同步失败"))).toBe(true);

    // Opening delete confirmation pauses underlying Sheet focus management
    const activeTitle = snapshot.sessions[0]!.title;
    elements(tree).find((element) => element.type === SheetAction && element.props.label === "删除会话")!.props.onClick();
    tree = sessions.draw();
    const menuSheet = elements(tree).find((element) => element.type === Sheet && element.props.title === activeTitle)!;
    expect(menuSheet.props.focusPaused).toBe(true);
    elements(tree).find((element) => element.type === ConfirmationDialog && element.props.title === "删除会话")!.props.onCancel();
    tree = sessions.draw();
    expect(elements(tree).find((element) => element.type === Sheet && element.props.title === activeTitle)!.props.focusPaused).toBe(false);
    elements(tree).find((element) => element.type === Sheet && element.props.title === activeTitle)!.props.onClose();
    tree = sessions.draw();

    // Per-project 新建会话：<项目名> opens unified NewChatCanvas with initialProjectId and wires directory browse/mkdir
    tree = sessions.draw();
    elements(tree).find((element) => element.type === IconButton && element.props.label === "新建会话：Project")!.props.onClick();
    tree = sessions.draw();
    const projectCanvas = elements(tree).find((element) => element.type === NewChatCanvas)!;
    expect(projectCanvas.props.initialProjectId).toBe("project");
    elements(tree).find((element) => element.type === "button" && element.props["aria-label"] === "选择文件夹")!.props.onClick();
    tree = sessions.draw();
    const createDialog = elements(tree).find((element) => element.type === SessionCreateDialog)!;
    expect(typeof createDialog.props.onPickDirectory).toBe("function");
    apiRequest.mockResolvedValueOnce({
      kind: "response",
      requestId: "dir-list",
      ok: true,
      result: { listing: { path: "/tmp", directories: [], recentPaths: [] } },
    });
    await expect(createDialog.props.onBrowseDirectory("/tmp")).resolves.toEqual({ path: "/tmp", directories: [], recentPaths: [] });
    expect(apiRequest).toHaveBeenLastCalledWith({ method: "directory.list", params: { path: "/tmp" } });
    apiRequest.mockResolvedValueOnce({
      kind: "response",
      requestId: "dir-mkdir",
      ok: true,
      result: { path: "/tmp/demo" },
    });
    await expect(createDialog.props.onCreateDirectory("/tmp", "demo")).resolves.toBe("/tmp/demo");
    expect(apiRequest).toHaveBeenLastCalledWith({ method: "directory.mkdir", params: { parentPath: "/tmp", name: "demo" } });
  });

  it("wires section.move and session.rename end-to-end from DesktopSessionConversation menu", async () => {
    snapshot.host.capabilities.push("section.move.v1", "session.rename.v1", "session.command.v1");
    snapshot.runtime.desktopIntegration.state = "ready";
    snapshot.projects.push({
      projectId: "sec-1",
      name: "Lab",
      cwd: "",
      kind: "desktop-group",
      sessionCount: 0,
      runningCount: 0,
      pendingCount: 0,
      lastActivityAt: 2,
    });
    snapshot.sessions[0]!.allowedActions = {
      ...snapshot.sessions[0]!.allowedActions!,
      canMoveSection: true,
    };
    await openSessions();

    // Move session into section sec-1
    elements(tree).find((element) => element.type === IconButton && element.props.label === "会话操作")!.props.onClick();
    tree = sessions.draw();
    elements(tree).find((element) => element.type === SheetAction && element.props.label === "移动到分组")!.props.onClick();
    tree = sessions.draw();
    apiRequest.mockResolvedValueOnce({
      kind: "response",
      requestId: "move-in",
      ok: true,
      result: { session: { ...snapshot.sessions[0]!, projectId: "sec-1", projectName: "Lab" }, projects: snapshot.projects },
    });
    await elements(tree).find((element) => element.type === SheetAction && element.props.label === "Lab")!.props.onClick();
    await settle();
    expect(apiRequest).toHaveBeenCalledWith({ method: "section.move", params: { sessionId: "A", sectionId: "sec-1" } });

    // Move session out of section (sectionId: null)
    snapshot.sessions[0] = { ...snapshot.sessions[0]!, projectId: "sec-1", projectName: "Lab" };
    sessionsProps = elements(dashboard.draw()).find((element) => typeof element.type === "function" && element.type.name === "DesktopSessions")!.props;
    tree = sessions.draw(sessionsProps);
    elements(tree).find((element) => element.type === IconButton && element.props.label === "会话操作")!.props.onClick();
    tree = sessions.draw();
    elements(tree).find((element) => element.type === SheetAction && element.props.label === "移动到分组")!.props.onClick();
    tree = sessions.draw();
    apiRequest.mockResolvedValueOnce({
      kind: "response",
      requestId: "move-out",
      ok: true,
      result: { session: { ...snapshot.sessions[0]!, projectId: "project", projectName: "Project" }, projects: snapshot.projects },
    });
    await elements(tree).find((element) => element.type === SheetAction && element.props.label === "移出分组")!.props.onClick();
    await settle();
    expect(apiRequest).toHaveBeenCalledWith({ method: "section.move", params: { sessionId: "A", sectionId: null } });

    // Rename session via /rename when session.command.v1 is supported on claude-desktop
    tree = sessions.draw();
    elements(tree).find((element) => element.type === IconButton && element.props.label === "会话操作")!.props.onClick();
    tree = sessions.draw();
    elements(tree).find((element) => element.type === SheetAction && element.props.label === "重命名")!.props.onClick();
    tree = sessions.draw();
    const renameDialog = elements(tree).find((element) => element.props["aria-label"] === "重命名会话")!;
    elements(renameDialog).find((element) => element.type === "input")!.props.onChange({ target: { value: "  新桌面标题  " } });
    tree = sessions.draw();
    apiRequest.mockResolvedValueOnce({
      kind: "response",
      requestId: "cmd-rename",
      ok: true,
      result: { command: { status: "executed", message: "Renamed" } },
    });
    const activeRenameDialog = elements(tree).find((element) => element.props["aria-label"] === "重命名会话")!;
    elements(activeRenameDialog).find((element) => element.type === "form")!.props.onSubmit({ preventDefault: vi.fn() });
    await settle();
    expect(apiRequest).toHaveBeenCalledWith({ method: "session.command", params: { sessionId: "A", text: "/rename 新桌面标题" } });

    // Rename session via session.rename RPC when session.command.v1 is absent
    snapshot.host.capabilities = snapshot.host.capabilities.filter((cap) => cap !== "session.command.v1");
    sessionsProps = elements(dashboard.draw()).find((element) => typeof element.type === "function" && element.type.name === "DesktopSessions")!.props;
    tree = sessions.draw(sessionsProps);
    elements(tree).find((element) => element.type === IconButton && element.props.label === "会话操作")!.props.onClick();
    tree = sessions.draw();
    elements(tree).find((element) => element.type === SheetAction && element.props.label === "重命名")!.props.onClick();
    tree = sessions.draw();
    const directDialog = elements(tree).find((element) => element.props["aria-label"] === "重命名会话")!;
    elements(directDialog).find((element) => element.type === "input")!.props.onChange({ target: { value: "  RPC 标题  " } });
    tree = sessions.draw();
    apiRequest.mockResolvedValueOnce({
      kind: "response",
      requestId: "rpc-rename",
      ok: true,
      result: { session: { ...snapshot.sessions[0]!, title: "RPC 标题" } },
    });
    const activeDirectDialog = elements(tree).find((element) => element.props["aria-label"] === "重命名会话")!;
    elements(activeDirectDialog).find((element) => element.type === "form")!.props.onSubmit({ preventDefault: vi.fn() });
    await settle();
    expect(apiRequest).toHaveBeenCalledWith({ method: "session.rename", params: { sessionId: "A", title: "RPC 标题" } });

    // Rename dialog traps Tab focus onto dialog container while saving (all controls disabled)
    let resolvePendingRename!: (value: BridgeResponse) => void;
    apiRequest.mockImplementationOnce(() => new Promise<BridgeResponse>((resolve) => {
      resolvePendingRename = resolve;
    }));
    elements(tree).find((element) => element.type === IconButton && element.props.label === "会话操作")!.props.onClick();
    tree = sessions.draw();
    elements(tree).find((element) => element.type === SheetAction && element.props.label === "重命名")!.props.onClick();
    tree = sessions.draw();
    const busyRenameDialog = elements(tree).find((element) => element.props["aria-label"] === "重命名会话")!;
    expect(busyRenameDialog.props.tabIndex).toBe(-1);
    elements(busyRenameDialog).find((element) => element.type === "input")!.props.onChange({ target: { value: "保存中标题" } });
    tree = sessions.draw();
    const activeBusyDialog = elements(tree).find((element) => element.props["aria-label"] === "重命名会话")!;
    const focusDialog = vi.fn();
    const dialogDomStub = {
      querySelectorAll: () => [],
      contains: () => true,
      focus: focusDialog,
    };
    const refObj = (activeBusyDialog.props.ref ?? (activeBusyDialog as unknown as { ref?: { current: unknown } }).ref) as { current: unknown };
    refObj.current = dialogDomStub;
    elements(activeBusyDialog).find((element) => element.type === "form")!.props.onSubmit({ preventDefault: vi.fn() });
    tree = sessions.draw();
    expect(focusDialog).toHaveBeenCalled();
    const backdrop = elements(tree).find((element) => String(element.props.className).includes("session-create-backdrop"))!;
    const preventTabDefault = vi.fn();
    backdrop.props.onKeyDown({ key: "Tab", shiftKey: false, preventDefault: preventTabDefault, stopPropagation: vi.fn() });
    expect(preventTabDefault).toHaveBeenCalledOnce();
    resolvePendingRename({
      kind: "response",
      requestId: "rpc-rename-2",
      ok: true,
      result: { session: { ...snapshot.sessions[0]!, title: "保存中标题" } },
    });
    await settle();

    // Refresh failure propagates error instead of flashing 已同步 when session history was already ready
    tree = sessions.draw();
    elements(tree).find((element) => element.type === IconButton && element.props.label === "会话操作")!.props.onClick();
    tree = sessions.draw();
    apiRequest.mockImplementation(async (req: { method: string }) => {
      if (req.method === "session.open") {
        return { kind: "response", requestId: "open-fail", ok: false, error: { code: "E_OPEN", message: "同步拉取失败", retryable: true } };
      }
      return { kind: "response", requestId: "other", ok: true, result: { evidence: { items: [], hasMore: false } } };
    });
    await elements(tree).find((element) => element.type === SheetAction && element.props.label === "同步此会话")!.props.onClick();
    await settle();
    tree = sessions.draw();
    expect(textContent(tree)).toContain("同步拉取失败");
    expect(textContent(tree)).not.toContain("已同步");
  });

  it("renders unified DesktopDashboard rail from real AssistantMailProvider cards, DesktopDevices pairing/revoke/unmount-safe copy, and AssistantPage directory mkdir", async () => {
    snapshot.host.capabilities.push("plugin.assistant-mail.v1", "directory.browse.v1", "directory.mkdir.v1");
    snapshot.assistantMail = {
      bindingState: "unbound",
      receiverState: "connected",
      changeToken: "tok-1",
      automaticDelivery: false,
    };
    let mailCards = [
      {
        seq: 2,
        mailRefId: "mail-2",
        accountKey: "acc",
        mailbox: "INBOX" as const,
        subject: "Pending A",
        from: [{ address: "a@example.com" }],
        receivedAt: "2026-01-01T00:00:00Z",
        recordedAt: 2,
        preview: "hi",
        processingStatus: "pending" as const,
        nativeDelivery: { state: "not-submitted" as const },
      },
      {
        seq: 1,
        mailRefId: "mail-1",
        accountKey: "acc",
        mailbox: "INBOX" as const,
        subject: "Processed B",
        from: [{ address: "b@example.com" }],
        receivedAt: "2026-01-01T00:00:00Z",
        recordedAt: 1,
        preview: "done",
        processingStatus: "processed" as const,
        nativeDelivery: { state: "not-submitted" as const },
      },
    ];
    apiRequest.mockImplementation(async (req: { method: string }) => {
      if (req.method === "plugin.assistant-mail.list") {
        return {
          kind: "response",
          requestId: "mail-list",
          ok: true,
          result: { mailPage: { cards: mailCards } },
        };
      }
      return { kind: "response", requestId: "ok", ok: true, result:
        req.method === "session.open" ? { history: { items: [], hasMore: false } }
          : req.method === "evidence.list" ? { evidence: { items: [], hasMore: false } } : {},
      };
    });
    const createPairing = vi.fn(async () => ({
      ...snapshot,
      pairingUrl: "bridge://pair/demo",
      pairingExpiresAt: Date.now() + 600_000,
      devices: [{
        deviceId: "dev-1",
        name: "Pixel 9",
        platform: "android",
        pairedAt: 1,
        lastSeenAt: Date.now(),
        online: true,
      }],
    }));
    const revokeDevice = vi.fn(async () => ({ ...snapshot, devices: [] }));
    const chooseDirectory = vi.fn(async () => "/Users/demo");
    let onSnapshotListener: ((next: DesktopControlSnapshot) => void) | undefined;
    const scheduledTimers = new Set<number>();
    let nextTimerId = 1;
    vi.stubGlobal("window", {
      localStorage: { getItem: vi.fn().mockReturnValue(null) },
      setTimeout: vi.fn((fn: () => void) => {
        const id = nextTimerId++;
        scheduledTimers.add(id);
        void fn;
        return id;
      }),
      clearTimeout: vi.fn((id: number) => {
        scheduledTimers.delete(id);
      }),
      bridgeDesktop: {
        getSnapshot: async () => snapshot,
        onSnapshot: (cb: (next: DesktopControlSnapshot) => void) => {
          onSnapshotListener = cb;
          return () => { onSnapshotListener = undefined; };
        },
        onEvent: () => () => undefined,
        request: apiRequest,
        createPairing,
        revokeDevice,
        chooseDirectory,
      },
    });

    const fullDashboard = renderer(
      DesktopDashboard,
      {
        themeControl: { theme: "dark", family: "sunstone", setTheme: vi.fn(), setFamily: vi.fn(), toggleTheme: vi.fn() },
      },
      { expandDashboard: true, expandMailProvider: true },
    );
    fullDashboard.draw();
    await settle();
    fullDashboard.draw();
    await settle();
    let dashTree = fullDashboard.draw();

    // Both unopened mails count, including the one the assistant already processed.
    expect(elements(dashTree).some((element) => element.props.className === "desktop-nav-v2")).toBe(false);
    const navBadge = elements(dashTree).find((element) => element.props.className === "desktop-nav-badge")!;
    expect(navBadge.props["aria-hidden"]).toBe("true");
    expect(navBadge.props.children).toBe(2);
    expect(elements(dashTree).some((element) => String(element.props.className).includes("m-status-dot is-online"))).toBe(true);

    mailCards = mailCards.map((card) => ({ ...card, processingStatus: "processed" as const }));
    snapshot = {
      ...snapshot,
      assistantMail: { ...snapshot.assistantMail!, changeToken: "tok-2" },
    };
    onSnapshotListener?.(snapshot);
    dashTree = fullDashboard.draw();
    await settle();
    dashTree = fullDashboard.draw();
    expect(elements(dashTree).find((element) => element.props.className === "desktop-nav-badge")?.props.children).toBe(2);

    // Switch to 设置 -> 手机配对与设备 and verify folded DesktopDevices, empty state, pairing QR, unmount-safe clipboard, and revoke
    elements(dashTree).find((element) => element.type === "button" && String(element.props.className).includes("desktop-dock-settings"))!.props.onClick();
    dashTree = fullDashboard.draw();
    elements(dashTree).find((element) => element.type === "button" && element.props.children === "手机配对与设备")!.props.onClick();
    let devTree = fullDashboard.draw();
    expect(textContent(devTree)).not.toContain("访问控制");
    expect(elements(devTree).find((element) => element.type === EmptyState)?.props.title).toBe("还没有配对手机");

    elements(devTree).find((element) => element.type === "button" && textContent(element).includes("添加手机"))!.props.onClick();
    await settle();
    expect(createPairing).toHaveBeenCalledOnce();
    devTree = fullDashboard.draw();
    expect(textContent(devTree)).not.toContain("一次性配对");
    expect(textContent(devTree)).toContain("使用手机 Bridge 扫描");
    expect(textContent(devTree)).toContain("Pixel 9");

    // Unmount while clipboard.writeText is pending must not schedule a leaked timer
    let resolveClipboard!: () => void;
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: vi.fn(() => new Promise<void>((resolve) => {
          resolveClipboard = resolve;
        })),
      },
    });
    const transientDevices = renderer(DesktopDevices, {
      snapshot: {
        ...snapshot,
        pairingUrl: "bridge://pair/demo",
        pairingExpiresAt: Date.now() + 600_000,
        devices: [],
      },
      onCreatePairing: async () => undefined,
      onRevoke: async () => undefined,
    });
    const transientTree = transientDevices.draw();
    const transientStore = stores[stores.length - 1]!;
    elements(transientTree).find((element) => element.type === "button" && textContent(element).includes("复制配对链接"))!.props.onClick();
    transientStore.effects.forEach((effect) => effect.cleanup?.());
    resolveClipboard();
    await settle();
    expect(scheduledTimers.size).toBe(0);

    elements(devTree).find((element) => element.type === IconButton && element.props.label === "撤销 Pixel 9")!.props.onClick();
    devTree = fullDashboard.draw();
    const revokeDialog = elements(devTree).find((element) => element.type === ConfirmationDialog && element.props.open === true)!;
    expect(revokeDialog.props.description).toContain("Pixel 9");
    revokeDialog.props.onConfirm();
    await settle();
    expect(revokeDevice).toHaveBeenCalledWith("dev-1");

    // AssistantPage wires onBrowseDirectory, onCreateDirectory (returning path), and onChooseDirectory on desktop
    const mailReq = vi.fn(async (method: string) => ({
      kind: "response" as const,
      requestId: "mail-dir",
      ok: true,
      result: method === "directory.mkdir" ? { path: "/Users/demo/sub" } : { listing: { path: "/Users/demo", directories: [], recentPaths: [] } },
    }));
    mailContext.current = {
      cache: { cards: [], changeToken: "tok-2" },
      unreadCount: 0,
      assistant: snapshot.assistantMail,
      selectedMail: undefined,
      canReference: false,
      selectMail: vi.fn(),
      clearReference: vi.fn(),
      referenceFor: () => undefined,
      loading: false,
      error: "",
      online: true,
      loadOlder: vi.fn(),
      refresh: vi.fn(),
      read: vi.fn(),
      request: mailReq,
    };
    const assistantRenderer = renderer(AssistantPage, {
      snapshot,
      mobile: false,
      onOpenSession: vi.fn(),
      renderConversation: () => null,
    });
    let assistantTree = assistantRenderer.draw();
    elements(assistantTree).find((element) => element.type === "button" && element.props.children === "新建会话")!.props.onClick();
    assistantTree = assistantRenderer.draw();
    const assistantCreateDialog = elements(assistantTree).find((element) => element.type === SessionCreateDialog)!;
    await expect(assistantCreateDialog.props.onCreateDirectory("/Users/demo", "sub")).resolves.toBe("/Users/demo/sub");
    expect(mailReq).toHaveBeenCalledWith("directory.mkdir", { parentPath: "/Users/demo", name: "sub" });
    await expect(assistantCreateDialog.props.onChooseDirectory()).resolves.toBe("/Users/demo");
  });

  it("preserves NewChatCanvas prompts across empty-cwd creation, directory picker handoff, delayed turn.start failure, and legacy hide-empty-sections state", async () => {
    localStorage.setItem("bridge-hide-empty-sections:computer", "1");
    snapshot.projects = [{
      projectId: "group-empty",
      name: "reproAPA",
      cwd: "",
      kind: "desktop-group",
      sessionCount: 0,
      runningCount: 0,
      pendingCount: 0,
      lastActivityAt: 2,
    }];
    snapshot.sessions = [];
    await openSessions();

    // Empty workspace NewChatCanvas shows honest runtime name rather than hardcoded model/effort/mode
    expect(textContent(tree)).not.toContain("Opus 4.6");

    // Empty workspace submitting prompt with no cwd opens SessionCreateDialog and hands prompt to newly created session
    const canvasTextarea = () => elements(tree).find(
      (element) => element.type === "textarea" && element.props["aria-label"] === "给 Claude 发指令",
    )!;
    canvasTextarea().props.onChange({ target: { value: "首条空目录指令" } });
    tree = sessions.draw();

    // Directory pill without native chooseDirectory opens folder-picker dialog and returns cwd while keeping draft
    elements(tree).find((element) => element.type === "button" && element.props["aria-label"] === "选择文件夹")!.props.onClick();
    tree = sessions.draw();
    const pickerDialog = elements(tree).find((element) => element.type === SessionCreateDialog)!;
    expect(typeof pickerDialog.props.onPickDirectory).toBe("function");
    pickerDialog.props.onPickDirectory("/Users/demo/repo");
    pickerDialog.props.onClose();
    tree = sessions.draw();
    expect(textContent(tree)).toContain("~/repo");
    expect(canvasTextarea().props.value).toBe("首条空目录指令");

    // Clear cwd scenario via empty workspace and test directory picker + NewChatCanvas creation prompt handoff
    snapshot.projects = [];
    elements(tree).find((element) => element.type === IconButton && element.props.label === "新建会话")!.props.onClick();
    tree = sessions.draw({ ...sessionsProps, snapshot: { ...snapshot, projects: [], sessions: [] } });
    canvasTextarea().props.onChange({ target: { value: "弹窗接力指令" } });
    tree = sessions.draw();
    elements(tree).find((element) => element.type === "form" && element.props.className === "composer-form")!.props.onSubmit({
      preventDefault() {},
    });
    tree = sessions.draw();
    const createDialog = elements(tree).find((element) => element.type === SessionCreateDialog)!;
    expect(typeof createDialog.props.onPickDirectory).toBe("function");
    createDialog.props.onPickDirectory("/Users/demo/repo");
    createDialog.props.onClose();
    tree = sessions.draw();
    expect(canvasTextarea().props.value).toBe("弹窗接力指令");

    const createdSession: BridgeSessionInfo = {
      sessionId: "new-1",
      title: "New Session",
      projectId: "folder-1",
      projectName: "repo",
      cwd: "/Users/demo/repo",
      source: "desktop",
      ownership: "DESKTOP_NATIVE_IDLE",
      transport: "claude-desktop-native",
      turnState: "idle",
      lastActivityAt: 10,
      pendingCount: 0,
      allowedActions: {
        canSend: true,
        canSteer: true,
        canInterrupt: true,
        canConfigure: true,
        canSwitchProvider: false,
        canContinueOfficial: false,
      },
    };
    let rejectTurnStart!: (reason?: unknown) => void;
    apiRequest.mockImplementation((req: { method: string }) => {
      if (req.method === "session.create") {
        snapshot.projects = [{
          projectId: "group-empty",
          name: "reproAPA",
          cwd: "",
          kind: "desktop-group",
          sessionCount: 0,
          runningCount: 0,
          pendingCount: 0,
          lastActivityAt: 2,
        }, {
          projectId: "folder-1",
          name: "repo",
          cwd: "/Users/demo/repo",
          sessionCount: 1,
          runningCount: 0,
          pendingCount: 0,
          lastActivityAt: 10,
        }];
        snapshot.sessions = [createdSession];
        return Promise.resolve({ kind: "response", requestId: "create-1", ok: true, result: { session: createdSession } });
      }
      if (req.method === "turn.start") {
        return new Promise<BridgeResponse>((_, reject) => {
          rejectTurnStart = reject;
        });
      }
      if (req.method === "session.open") {
        return Promise.resolve({ kind: "response", requestId: "open", ok: true, result: { history: { items: [], hasMore: false } } });
      }
      if (req.method === "evidence.list") {
        return Promise.resolve({ kind: "response", requestId: "ev", ok: true, result: { evidence: { items: [], hasMore: false } } });
      }
      return Promise.resolve({ kind: "response", requestId: "ok", ok: true, result: {} });
    });

    await elements(tree).find((element) => element.type === "form" && element.props.className === "composer-form")!.props.onSubmit({
      preventDefault() {},
    });
    await settle();
    tree = sessions.draw({ ...sessionsProps, snapshot: { ...snapshot } });
    await settle();
    tree = sessions.draw({ ...sessionsProps, snapshot: { ...snapshot } });

    // NewChatCanvas is now unmounted and DesktopSessionConversation is mounted while turn.start is still pending
    expect(elements(tree).some((element) => element.type === NewChatCanvas)).toBe(false);
    expect(apiRequest).toHaveBeenCalledWith(expect.objectContaining({
      method: "turn.start",
      params: { sessionId: "new-1", text: "弹窗接力指令", attachments: [] },
    }));

    // Legacy bridge-hide-empty-sections=1 does not hide empty manual group on Desktop; it renders collapsed by default
    const emptyHeader = elements(tree).find((element) => element.type === ProjectGroupHeader && element.props.title === "reproAPA");
    expect(emptyHeader).toBeDefined();
    expect(emptyHeader!.props.expanded).toBe(false);

    // Delayed turn.start failure surfaces alert and restores prompt text in the newly mounted conversation composer
    rejectTurnStart(new Error("首次发送超时"));
    await settle();
    tree = sessions.draw({ ...sessionsProps, snapshot: { ...snapshot } });
    expect(textContent(tree)).toContain("首次发送超时");
    const composerInput = elements(tree).find((element) => element.type === SlashCommandInput)!;
    expect(composerInput.props.value).toBe("弹窗接力指令");
  });

  it("derives MagpieQuotaProvider sourceKey from snapshot.magpie and evicts DesktopConversationProvider history/evidence on deleteSession and session.deleted", async () => {
    let onSnapshotListener: ((next: DesktopControlSnapshot) => void) | undefined;
    let onEventListener: ((event: BridgeEvent) => void) | undefined;
    snapshot.magpie = {
      mode: "auto",
      baseUrl: "http://127.0.0.1:4190",
      authScheme: "bearer",
      keyConfigured: true,
    };
    apiRequest.mockImplementation(async (req: { method: string; params?: Record<string, unknown> }) => {
      if (req.method === "session.open") {
        return {
          kind: "response",
          requestId: "open",
          ok: true,
          result: { history: { items: [{ id: "h-1", role: "assistant", text: "cached", createdAt: 1 }], hasMore: false } },
        };
      }
      if (req.method === "evidence.list") {
        return {
          kind: "response",
          requestId: "ev",
          ok: true,
          result: {
            evidence: {
              items: [{
                id: "ev-1",
                sessionId: String(req.params?.sessionId ?? "s-1"),
                startedAt: 1,
                status: "completed",
                tools: [],
                artifacts: [],
              }],
              hasMore: false,
            },
          },
        };
      }
      return { kind: "response", requestId: "ok", ok: true, result: {} };
    });
    vi.stubGlobal("window", {
      setTimeout: vi.fn(() => 1),
      clearTimeout: vi.fn(),
      bridgeDesktop: {
        getSnapshot: async () => snapshot,
        onSnapshot: (cb: (next: DesktopControlSnapshot) => void) => {
          onSnapshotListener = cb;
          return () => { onSnapshotListener = undefined; };
        },
        onEvent: (cb: (event: BridgeEvent) => void) => {
          onEventListener = cb;
          return () => { onEventListener = undefined; };
        },
        request: apiRequest,
      },
    });

    const dash = renderer(
      DesktopDashboard,
      { themeControl: { theme: "dark", family: "sunstone", setTheme: vi.fn(), setFamily: vi.fn(), toggleTheme: vi.fn() } },
      { expandDashboard: true },
    );
    dash.draw();
    await settle();
    let dashTree = dash.draw();
    await settle();
    dashTree = dash.draw();

    const quotaProvider = () => elements(dashTree).find((element) => element.type === MagpieQuotaProvider)!;
    expect(quotaProvider().props.sourceKey).toBe("auto|http://127.0.0.1:4190|bearer|1");

    snapshot = {
      ...snapshot,
      magpie: {
        mode: "manual",
        baseUrl: "http://127.0.0.1:8080",
        authScheme: "x-api-key",
        keyConfigured: false,
      },
    };
    onSnapshotListener?.(snapshot);
    dashTree = dash.draw();
    expect(quotaProvider().props.sourceKey).toBe("manual|http://127.0.0.1:8080|x-api-key|0");

    const convProviderValue = () => elements(dashTree).find(
      (element) => element.props?.value && typeof element.props.value === "object" && "deleteSession" in element.props.value && "historyFor" in element.props.value,
    )!.props.value;

    const firstId = snapshot.sessions[0]!.sessionId;
    await convProviderValue().openSession(firstId);
    await settle();
    dashTree = dash.draw();
    expect(convProviderValue().historyFor(firstId)?.items).toHaveLength(1);
    expect(convProviderValue().evidenceFor(firstId)?.items).toHaveLength(1);

    await convProviderValue().deleteSession(firstId);
    await settle();
    dashTree = dash.draw();
    expect(convProviderValue().historyFor(firstId)).toBeUndefined();
    expect(convProviderValue().evidenceFor(firstId)).toBeUndefined();

    // Also evicts when session.deleted arrives as a live event
    await convProviderValue().openSession(firstId);
    await settle();
    dashTree = dash.draw();
    expect(convProviderValue().historyFor(firstId)?.items).toHaveLength(1);
    expect(convProviderValue().evidenceFor(firstId)?.items).toHaveLength(1);

    onEventListener?.({
      seq: 98,
      eventId: "ev-live-1",
      sessionId: firstId,
      origin: "claude-host",
      type: "evidence.ready",
      timestamp: 98,
      data: { evidence: { id: "ev-live", sessionId: firstId, startedAt: 98, tools: [], artifacts: [] } },
    });
    dashTree = dash.draw();
    expect(convProviderValue().evidenceFor(firstId)?.items).toHaveLength(2);

    onEventListener?.({
      seq: 99,
      eventId: "ev-deleted-1",
      sessionId: firstId,
      origin: "system",
      type: "session.deleted",
      timestamp: Date.now(),
      data: {},
    });
    onEventListener?.({
      seq: 100,
      eventId: "ev-late-update",
      sessionId: firstId,
      origin: "claude-host",
      type: "evidence.updated",
      timestamp: 100,
      data: { evidence: { id: "ev-live", sessionId: firstId, startedAt: 98, tools: [], artifacts: [], artifactCount: 1 } },
    });
    dashTree = dash.draw();
    await settle();
    dashTree = dash.draw();
    expect(convProviderValue().historyFor(firstId)).toBeUndefined();
    expect(convProviderValue().evidenceFor(firstId)).toBeUndefined();

    onEventListener?.({
      seq: 101,
      eventId: "ev-unrelated-delta",
      sessionId: "another-session",
      origin: "claude-host",
      type: "assistant.delta",
      timestamp: 101,
      data: { text: "Unrelated progress" },
    });
    dashTree = dash.draw();
    expect(convProviderValue().evidenceFor(firstId)).toBeUndefined();
  });
});
