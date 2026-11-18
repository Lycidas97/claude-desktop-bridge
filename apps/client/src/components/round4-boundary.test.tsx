import type {
  BridgeCrypto,
  BridgeEvent,
  BridgeHostSnapshot,
  BridgeProjectInfo,
  BridgeResponse,
  BridgeSessionInfo,
  DesktopControlSnapshot,
  LocalBridgeRequest,
} from "@bridge/protocol";
import type { PointerEvent as ReactPointerEvent, ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nativeCap = vi.hoisted(() => ({
  isNative: false,
  localNotifications: {
    checkPermissions: vi.fn(),
    requestPermissions: vi.fn(),
    createChannel: vi.fn(),
    schedule: vi.fn(),
    addListener: vi.fn(),
  },
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => nativeCap.isNative,
    getPlatform: () => (nativeCap.isNative ? "android" : "web"),
  },
}));

vi.mock("@capacitor/local-notifications", () => ({
  LocalNotifications: nativeCap.localNotifications,
}));

interface HookStore {
  slots: any[];
  index: number;
  dirty: boolean;
  effects: Array<{ deps: unknown[] | undefined; cleanup: (() => void) | undefined }>;
  effectIndex: number;
  pending: Array<() => void>;
}

const rt = vi.hoisted(() => ({
  store: undefined as HookStore | undefined,
}));

vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return {
    ...actual,
    useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
    useState(initial: any) {
      const store = rt.store!;
      const index = store.index++;
      if (!(index in store.slots)) {
        store.slots[index] = typeof initial === "function" ? initial() : initial;
      }
      return [
        store.slots[index],
        (value: any) => {
          const next = typeof value === "function" ? value(store.slots[index]) : value;
          if (!Object.is(next, store.slots[index])) store.dirty = true;
          store.slots[index] = next;
        },
      ];
    },
    useRef(initial: unknown) {
      const store = rt.store!;
      const index = store.index++;
      store.slots[index] ??= { current: initial };
      return store.slots[index];
    },
    useMemo: (create: () => unknown) => create(),
    useCallback: <T extends (...args: any[]) => any>(fn: T) => fn,
    useContext: (context: unknown) => readDesktopConversationTestContext(context),
    useId: () => "r4-boundary-id",
    useEffect(effect: () => (() => void) | void, deps?: unknown[]) {
      const store = rt.store!;
      const index = store.effectIndex++;
      const previous = store.effects[index];
      if (
        previous
        && deps
        && deps.length === previous.deps?.length
        && deps.every((val, i) => Object.is(val, previous.deps?.[i]))
      ) {
        return;
      }
      store.pending.push(() => {
        previous?.cleanup?.();
        store.effects[index] = { deps, cleanup: effect() || undefined };
      });
    },
    useLayoutEffect(effect: () => (() => void) | void, deps?: unknown[]) {
      const store = rt.store!;
      const index = store.effectIndex++;
      const previous = store.effects[index];
      if (
        previous
        && deps
        && deps.length === previous.deps?.length
        && deps.every((val, i) => Object.is(val, previous.deps?.[i]))
      ) {
        return;
      }
      store.pending.push(() => {
        previous?.cleanup?.();
        store.effects[index] = { deps, cleanup: effect() || undefined };
      });
    },
  };
});

vi.mock("./evidence/MediaPreviewProvider.js", () => ({
  useMediaPreview: () => vi.fn(),
  useMediaRequest: () => undefined,
}));

import { notifyBridgeCompletedTurns } from "../hooks/bridge/bridge-transport.js";
import { useTheme } from "../hooks/useTheme.js";
import { dispatchMobileBack } from "../lib/mobile-back-navigation.js";
import { readStoredProjectOrder, writeStoredProjectOrder } from "../lib/project-groups.js";
import { EmptyState } from "./common/EmptyState.js";
import { IconButton } from "./common/IconButton.js";
import { SheetAction } from "./common/Sheet.js";
import {
  CONVERSATION_DRAFTS_STORAGE_KEY,
  ConversationDraftsProvider,
  type ConversationDraftsController,
} from "./conversation/ConversationDraftsProvider.js";
import { SlashCommandInput } from "./conversation/SlashCommandInput.js";
import { readDesktopConversationTestContext, renderDesktopSessions } from "./desktop/DesktopSessions.test-fixture.js";
import { MobileWorkspace } from "./MobileWorkspace.js";
import { MobilePageHeader } from "./mobile/MobilePageHeader.js";
import { MobileSessionCatalog } from "./mobile/MobileSessionCatalog.js";
import { NewChatCanvas } from "./session/NewChatCanvas.js";
import { ProjectGroupHeader } from "./session/ProjectGroupHeader.js";
import { SectionCreateDialog } from "./session/SectionCreateDialog.js";
import { SectionManageDialog, useSectionManage } from "./session/SectionManageDialog.js";
import { SessionActionSheets } from "./session/SessionActionSheets.js";
import { SessionFamilyList } from "./session/SessionFamilyList.js";
import {
  UNSECTIONED_DROP_ID,
  useSessionSectionDrag,
  type UseSessionSectionDragOptions,
} from "./session/useSessionSectionDrag.js";

function createStore(): HookStore {
  return { slots: [], index: 0, dirty: false, effects: [], effectIndex: 0, pending: [] };
}

function runWithStore<T>(store: HookStore, render: () => T): T {
  for (let pass = 0; pass < 12; pass += 1) {
    rt.store = store;
    store.dirty = false;
    store.index = 0;
    store.effectIndex = 0;
    const out = render();
    store.pending.splice(0).forEach(fn => fn());
    if (!store.dirty) return out;
  }
  throw new Error("Hook store did not settle");
}

function unmountStore(store: HookStore): void {
  store.effects.forEach(eff => eff.cleanup?.());
  store.effects = [];
  store.slots = [];
}

function elements(node: ReactNode): ReactElement<Record<string, any>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const el = node as ReactElement<Record<string, any>>;
  if (typeof el.type === "function") {
    const expand =
      el.type === EmptyState
      || el.type === ProjectGroupHeader
      || el.type === SessionFamilyList
      || el.type === MobilePageHeader
      || el.type === MobileSessionCatalog
      || el.type === SectionCreateDialog
      || el.type === SessionActionSheets
      || el.type === SheetAction;
    if (expand) {
      return [el, ...elements((el.type as (props: any) => ReactNode)(el.props))];
    }
  }
  return [el, ...elements(el.props.children)];
}

class FakeEventTarget {
  listeners = new Map<string, Set<EventListener>>();
  addEventListener(type: string, listener: EventListener): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }
  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }
  dispatch(type: string, detail: Record<string, unknown> = {}): { prevented: boolean; stopped: boolean } {
    let prevented = false;
    let stopped = false;
    const ev = {
      type,
      cancelable: true,
      preventDefault() {
        prevented = true;
      },
      stopPropagation() {
        stopped = true;
      },
      stopImmediatePropagation() {
        stopped = true;
      },
      ...detail,
    } as unknown as Event;
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(ev);
    }
    return { prevented, stopped };
  }
}

function makeSession(overrides: Partial<BridgeSessionInfo> = {}): BridgeSessionInfo {
  return {
    sessionId: "sess-1",
    projectId: "sec-alpha",
    projectName: "Alpha 组",
    cwd: "/Users/demo/alpha",
    title: "边界测试会话",
    source: "desktop",
    ownership: "DESKTOP_NATIVE_IDLE",
    transport: "claude-desktop-native",
    turnState: "idle",
    lastActivityAt: 100,
    pendingCount: 0,
    allowedActions: {
      canSend: true,
      canSteer: true,
      canInterrupt: true,
      canSwitchProvider: false,
      canContinueOfficial: false,
      canConfigure: true,
      canMoveSection: true,
    },
    ...overrides,
  };
}

function makeDesktopSnapshot(overrides: Partial<DesktopControlSnapshot> = {}): DesktopControlSnapshot {
  return {
    host: {
      hostId: "host-a",
      pairingEpoch: 1,
      name: "Studio Mac",
      relayUrl: "ws://127.0.0.1:8788/ws",
      online: true,
      lastSeenAt: 100,
      version: "1.3.5",
      capabilities: [
        "claude.native-relay.v1",
        "session.command.v1",
        "session.rename.v1",
        "section.create.v1",
        "section.move.v1",
        "session.visibility.v1",
        "directory.browse.v1",
      ],
    },
    projects: [
      {
        projectId: "sec-alpha",
        name: "Alpha 组",
        kind: "desktop-group",
        cwd: "/Users/demo/alpha",
        sessionCount: 1,
        runningCount: 0,
        pendingCount: 0,
        lastActivityAt: 100,
      },
      {
        projectId: "sec-beta",
        name: "Beta 组",
        kind: "desktop-group",
        cwd: "/Users/demo/beta",
        sessionCount: 0,
        runningCount: 0,
        pendingCount: 0,
        lastActivityAt: 90,
      },
    ],
    sessions: [makeSession()],
    devices: [],
    runtime: {
      state: "ready",
      detail: "Ready",
      activeTurns: 0,
      maxParallelTurns: 0,
      desktopIntegration: { state: "ready", detail: "Ready", enabled: true, canRestart: false },
    },
    runtimes: [{
      id: "claude-desktop",
      name: "Claude Desktop",
      state: "ready",
      detail: "Ready",
      capabilities: ["session.list", "session.create", "session.configure", "section.move"],
      sessionIsolation: "independent",
      sessionCount: 1,
      updatedAt: 100,
    }],
    permissions: [],
    latestSeq: 10,
    connection: "connected",
    launchAtLogin: false,
    diagnosticsEnabled: false,
    managedDesktopEnabled: true,
    claudeDesktop: { state: "running", detail: "Running", canLaunch: false, canQuit: true },
    ...overrides,
  };
}

describe("Round-4 Boundary 2B.1: localStorage corruption, QuotaExceededError, SecurityError & host isolation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    "{broken-json",
    "null",
    "42",
    "[1, 2]",
    "{}",
    "[1, null, \"\", \"sec-beta\", \"sec-beta\"]",
  ])("mounts and interacts cleanly when localStorage keys hold %s and setItem throws QuotaExceededError", async (corruptValue) => {
    const map = new Map<string, string>();
    for (const key of [
      CONVERSATION_DRAFTS_STORAGE_KEY,
      "bridge-project-order:host-a",
      "bridge-project-order:desktop",
      "bridge-mobile-notifications:v1",
      "bridge-font-size",
      "bridge-theme",
      "bridge-theme-family",
      "bridge-hide-empty-sections:host-a",
    ]) {
      map.set(key, corruptValue);
    }

    let throwQuota = true;
    const storage = {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (throwQuota) {
          const err = new Error("QuotaExceededError");
          err.name = "QuotaExceededError";
          throw err;
        }
        map.set(key, value);
      },
      removeItem: (key: string) => {
        map.delete(key);
      },
    };
    const bodyAttrs = new Map<string, string>();
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("window", {
      localStorage: storage,
      matchMedia: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
    });
    vi.stubGlobal("document", {
      visibilityState: "visible",
      querySelector: () => null,
      documentElement: {
        dataset: {} as Record<string, string>,
        style: { setProperty: vi.fn(), removeProperty: vi.fn() },
        setAttribute: (k: string, v: string) => bodyAttrs.set(k, v),
        removeAttribute: (k: string) => bodyAttrs.delete(k),
      },
      body: { classList: { add: vi.fn(), remove: vi.fn(), contains: () => false } },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });

    // 1. Project order reader sanitizes non-arrays / non-strings & dedupes; writer swallows QuotaExceededError
    const parsedOrder = readStoredProjectOrder("bridge-project-order:host-a");
    if (corruptValue.includes("sec-beta")) {
      expect(parsedOrder).toEqual(["sec-beta"]);
    } else {
      expect(parsedOrder).toEqual([]);
    }
    expect(() => writeStoredProjectOrder("bridge-project-order:host-a", ["sec-beta", "sec-alpha"])).not.toThrow();

    // 2. useTheme never throws on corrupt keys or QuotaExceededError
    const themeStore = createStore();
    const themeApi = runWithStore(themeStore, () => useTheme());
    expect(() => runWithStore(themeStore, () => {
      themeApi.setTheme("dark");
      themeApi.setFontSize("larger");
      themeApi.setFamily("apple");
      return useTheme();
    })).not.toThrow();
    unmountStore(themeStore);

    // 3. useSectionManage + SectionManageDialog never throw on corrupt hide-empty-sections or QuotaExceededError
    const sectionStore = createStore();
    const renderSectionCtrl = () => runWithStore(sectionStore, () => useSectionManage({
      activeHostId: "host-a",
      desktopName: "Studio Mac",
      snapshot: makeDesktopSnapshot(),
      connection: "connected",
      desktopOnline: true,
      onRenameSection: vi.fn(),
      onDeleteSection: vi.fn(),
    }));
    const secCtrl = renderSectionCtrl();
    expect(() => {
      secCtrl.toggleHideEmptySections();
      const updated = renderSectionCtrl();
      SectionManageDialog({ controller: updated });
    }).not.toThrow();
    unmountStore(sectionStore);

    // 4. DesktopSessions & MobileWorkspace mount cleanly despite corrupt projectOrderKey + QuotaExceededError
    const apiRequest = vi.fn(async (_req: LocalBridgeRequest): Promise<BridgeResponse> => ({
      kind: "response",
      requestId: "r",
      ok: true,
      result: { history: { sessionId: "sess-1", items: [], hasMore: false }, evidence: { sessionId: "sess-1", items: [], hasMore: false } },
    }));
    const desktopStore = createStore();
    expect(() => runWithStore(desktopStore, () => renderDesktopSessions({
      snapshot: makeDesktopSnapshot(),
      events: [],
      apiRequest,
      onRefreshSnapshot: vi.fn().mockResolvedValue(undefined),
    }))).not.toThrow();
    unmountStore(desktopStore);

    const mobileStore = createStore();
    expect(() => runWithStore(mobileStore, () => MobileWorkspace({
      hostId: "host-a",
      hostName: "Studio Mac",
      connection: "connected",
      desktopOnline: true,
      sessions: [makeSession()],
      snapshot: makeDesktopSnapshot(),
      events: [],
      localTurns: [],
      permissions: [],
      evidenceBySession: {},
      selectedSessionId: undefined,
      hasPairedHosts: true,
      onSelectSession: vi.fn(),
      onOpenPairing: vi.fn(),
      onRefresh: vi.fn().mockResolvedValue(true),
      onSendTurn: vi.fn(),
      onSteerTurn: vi.fn(),
      onCancelQueuedTurn: vi.fn(),
      onInterrupt: vi.fn(),
      onResolveUncertain: vi.fn(),
      onResolvePermission: vi.fn(),
      onCreateSession: vi.fn(),
      onLoadSessionConfiguration: vi.fn(),
      onConfigureSession: vi.fn(),
      onPreviewRewind: vi.fn(),
      onRewindSession: vi.fn(),
      onForkSession: vi.fn(),
      onOpenEvidence: vi.fn(),
      onEnsureEvidence: vi.fn(),
      onDownloadArtifact: vi.fn(),
    } as any))).not.toThrow();
    unmountStore(mobileStore);

    // 5. SecurityError when accessing global localStorage getter
    vi.stubGlobal("window", {
      get localStorage() {
        throw new Error("SecurityError: Storage disabled");
      },
    });
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("SecurityError: Storage disabled");
      },
    });
    expect(readStoredProjectOrder("bridge-project-order:host-a")).toEqual([]);
    expect(() => writeStoredProjectOrder("bridge-project-order:host-a", ["sec-alpha"])).not.toThrow();
    throwQuota = false;
  });

  it("isolates placedProjects order per hostId when switching between hosts", () => {
    const map = new Map<string, string>([
      ["bridge-project-order:host-a", JSON.stringify(["sec-beta", "sec-alpha"])],
      ["bridge-project-order:host-b", JSON.stringify(["sec-alpha", "sec-beta"])],
    ]);
    const storage = {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, val: string) => map.set(key, val),
      removeItem: (key: string) => map.delete(key),
    };
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("window", { localStorage: storage });
    vi.stubGlobal("document", {
      visibilityState: "visible",
      body: { classList: { add: vi.fn(), remove: vi.fn(), contains: () => false } },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });

    const store = createStore();
    const apiRequest = vi.fn(async (): Promise<BridgeResponse> => ({
      kind: "response",
      requestId: "r",
      ok: true,
      result: { history: { sessionId: "sess-1", items: [], hasMore: false }, evidence: { sessionId: "sess-1", items: [], hasMore: false } },
    }));

    // Render host-a (both sections non-empty so both render in order)
    const projectsBothActive: BridgeProjectInfo[] = [
      { projectId: "sec-alpha", name: "Alpha 组", kind: "desktop-group", cwd: "/a", sessionCount: 1, runningCount: 0, pendingCount: 0, lastActivityAt: 100 },
      { projectId: "sec-beta", name: "Beta 组", kind: "desktop-group", cwd: "/b", sessionCount: 1, runningCount: 0, pendingCount: 0, lastActivityAt: 100 },
    ];
    const sessionsBoth = [
      makeSession({ sessionId: "s-a", projectId: "sec-alpha" }),
      makeSession({ sessionId: "s-b", projectId: "sec-beta" }),
    ];

    const treeA = runWithStore(store, () => renderDesktopSessions({
      snapshot: makeDesktopSnapshot({
        host: { ...makeDesktopSnapshot().host, hostId: "host-a" },
        projects: projectsBothActive,
        sessions: sessionsBoth,
      }),
      events: [],
      apiRequest,
      onRefreshSnapshot: vi.fn().mockResolvedValue(undefined),
    })) as ReactElement;
    const headersA = elements(treeA)
      .filter(el => el.type === ProjectGroupHeader)
      .map(el => el.props.title);
    expect(headersA).toEqual(["Beta 组", "Alpha 组"]);

    // Switch same mounted DesktopSessions instance to host-b -> must immediately reflect host-b's stored order!
    const treeB = runWithStore(store, () => renderDesktopSessions({
      snapshot: makeDesktopSnapshot({
        host: { ...makeDesktopSnapshot().host, hostId: "host-b" },
        projects: projectsBothActive,
        sessions: sessionsBoth,
      }),
      events: [],
      apiRequest,
      onRefreshSnapshot: vi.fn().mockResolvedValue(undefined),
    })) as ReactElement;
    const headersB = elements(treeB)
      .filter(el => el.type === ProjectGroupHeader)
      .map(el => el.props.title);
    expect(headersB).toEqual(["Alpha 组", "Beta 组"]);
    unmountStore(store);
  });
});

describe("Round-4 Boundary 2B.2: Drafts 100-entry LRU, 100KB paste, delete cleanup & mid-IME session switch", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("enforces 100-entry LRU eviction across 105 sessions, handles 100KB emoji paste, and cleans draft on resetSession", () => {
    vi.useFakeTimers();
    const map = new Map<string, string>();
    const storage = {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, val: string) => map.set(key, val),
      removeItem: (key: string) => map.delete(key),
    };
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("window", { localStorage: storage });

    const store = createStore();
    let controller!: ConversationDraftsController;

    function renderDrafts() {
      const providerEl = runWithStore(store, () => (
        ConversationDraftsProvider({ activeHostId: "host-1", children: null }) as ReactElement<{ value: ConversationDraftsController }>
      ));
      controller = providerEl.props.value;
    }

    renderDrafts();
    let now = 1_000;
    const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      now += 10;
      return now;
    });

    for (let i = 1; i <= 105; i += 1) {
      controller.session("host-1", `sess-${i}`).setText(`草稿内容 #${i} 🚀`);
      renderDrafts();
    }

    vi.runOnlyPendingTimers();
    const persisted = JSON.parse(map.get(CONVERSATION_DRAFTS_STORAGE_KEY)!);
    expect(persisted.entries).toHaveLength(100);
    const persistedKeys = new Set(persisted.entries.map((e: { key: string }) => e.key));
    // Oldest 5 (sess-1..sess-5) evicted; newest 100 (sess-6..sess-105) retained
    expect(persistedKeys.has(JSON.stringify(["host-1", "sess-1"]))).toBe(false);
    expect(persistedKeys.has(JSON.stringify(["host-1", "sess-5"]))).toBe(false);
    expect(persistedKeys.has(JSON.stringify(["host-1", "sess-6"]))).toBe(true);
    expect(persistedKeys.has(JSON.stringify(["host-1", "sess-105"]))).toBe(true);

    // 100KB huge paste with surrogate pairs
    const hugePaste = `${"🚀🧪".repeat(25_000)}尾部校验`;
    expect(hugePaste.length).toBeGreaterThan(100_000);
    controller.session("host-1", "sess-105").setText(hugePaste);
    renderDrafts();
    expect(controller.session("host-1", "sess-105").draft.text).toBe(hugePaste);

    // Deleting session cleans up its draft via resetSession
    controller.resetSession("host-1", "sess-105");
    renderDrafts();
    expect(controller.session("host-1", "sess-105").draft.text).toBe("");

    dateSpy.mockRestore();
    unmountStore(store);
  });

  it("prevents mid-IME composition session switch in SlashCommandInput from clobbering target session draft, and guards NewChatCanvas IME/mobile Enter", () => {
    class TestNode {}
    vi.stubGlobal("Node", TestNode);
    vi.stubGlobal("document", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });

    const store = createStore();
    const draftsBySession: Record<string, string> = {
      "sess-A": "/rev",
      "sess-B": "会话 B 原有草稿",
    };
    let activeSession = "sess-A";
    const textareaMock = { focus: vi.fn(), setSelectionRange: vi.fn(), selectionStart: 4, selectionEnd: 4 };

    function renderSlash() {
      return runWithStore(store, () => {
        const currentSession = activeSession;
        const tree = SlashCommandInput({
          sessionKey: currentSession,
          value: draftsBySession[currentSession]!,
          placeholder: "发消息",
          disabled: false,
          onChange: (next) => {
            draftsBySession[currentSession] = next;
          },
        });
        tree.props.ref.current = { contains: () => false };
        const ta = elements(tree).find(el => el.type === "textarea")!;
        ta.props.ref.current = textareaMock;
        return ta;
      });
    }

    let ta = renderSlash();
    // Simulate React <StrictMode> mount double-invocation (cleanup -> re-run effects) and verify editing still works!
    store.effects.forEach((eff) => {
      eff.cleanup?.();
      eff.deps = undefined;
    });
    ta = renderSlash();
    ta.props.onChange({
      currentTarget: { value: "/rev", selectionStart: 4, selectionEnd: 4 },
    });
    expect(draftsBySession["sess-A"]).toBe("/rev");
    // Start IME composition on Session A
    ta.props.onCompositionStart();
    // Switch to Session B BEFORE compositionend fires!
    activeSession = "sess-B";
    ta = renderSlash();
    // Browser fires trailing compositionend on the reused textarea element with Session A's text or stale target
    ta.props.onCompositionEnd({
      currentTarget: { value: "会话 A 的拼音候选词", selectionStart: 9 },
    });
    renderSlash();
    // Session B's draft MUST remain untouched!
    expect(draftsBySession["sess-B"]).toBe("会话 B 原有草稿");
    unmountStore(store);

    // NewChatCanvas: mobile Enter inserts newline (no submit), desktop keyCode=229 IME Enter does NOT submit, normal desktop Enter submits!
    const onCreateSession = vi.fn().mockResolvedValue(makeSession({ sessionId: "created-1" }));
    const canvasStore = createStore();
    function renderCanvas(mobile: boolean) {
      return runWithStore(canvasStore, () => NewChatCanvas({
        mobile,
        connected: true,
        snapshot: makeDesktopSnapshot(),
        onOpenDirectoryPicker: vi.fn(),
        onCreateSession,
        onLoadSessionConfiguration: vi.fn().mockResolvedValue({
          sessionId: "__default__",
          availableModels: [{ value: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6" }],
          availableEffortLevels: ["medium", "high"],
          modelsComplete: true,
          appliesAfterTurn: false,
        }),
        onConfigureSession: vi.fn(),
        onSessionCreated: vi.fn(),
      })) as ReactElement;
    }

    let mobileTree = renderCanvas(true);
    let promptTa = elements(mobileTree).find(el => el.type === "textarea")!;
    promptTa.props.onChange({ target: { value: "首条指令" } });
    mobileTree = renderCanvas(true);
    promptTa = elements(mobileTree).find(el => el.type === "textarea")!;
    promptTa.props.onKeyDown({
      key: "Enter",
      shiftKey: false,
      nativeEvent: { isComposing: false, keyCode: 13 },
      preventDefault: vi.fn(),
    });
    expect(onCreateSession).not.toHaveBeenCalled();

    let desktopTree = renderCanvas(false);
    promptTa = elements(desktopTree).find(el => el.type === "textarea")!;
    // keyCode 229 (macOS WebKit / Chromium IME commit Enter) must NOT submit
    promptTa.props.onKeyDown({
      key: "Enter",
      shiftKey: false,
      nativeEvent: { isComposing: false, keyCode: 229 },
      preventDefault: vi.fn(),
    });
    expect(onCreateSession).not.toHaveBeenCalled();

    // Composition active must NOT submit
    promptTa.props.onCompositionStart();
    promptTa.props.onKeyDown({
      key: "Enter",
      shiftKey: false,
      nativeEvent: { isComposing: false, keyCode: 13 },
      preventDefault: vi.fn(),
    });
    expect(onCreateSession).not.toHaveBeenCalled();
    promptTa.props.onCompositionEnd();

    // Clean desktop Enter submits!
    const preventDefault = vi.fn();
    promptTa.props.onKeyDown({
      key: "Enter",
      shiftKey: false,
      nativeEvent: { isComposing: false, keyCode: 13 },
      preventDefault,
    });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(onCreateSession).toHaveBeenCalledOnce();
    unmountStore(canvasStore);
  });
});

describe("Round-4 Boundary 2B.3: Notification deduplication, replay, stale age & error resilience", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nativeCap.isNative = true;
    nativeCap.localNotifications.checkPermissions.mockResolvedValue({ display: "granted" });
    nativeCap.localNotifications.requestPermissions.mockResolvedValue({ display: "granted" });
    nativeCap.localNotifications.createChannel.mockResolvedValue(undefined);
    nativeCap.localNotifications.schedule.mockResolvedValue({ notifications: [] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("deduplicates live + resume eventId, suppresses bootstrap & >30m stale & bridgeDesktop events, and catches schedule/permission/Notification errors", async () => {
    const map = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => map.set(k, v),
      removeItem: (k: string) => map.delete(k),
    });
    vi.stubGlobal("document", { visibilityState: "hidden" });
    vi.stubGlobal("window", {});

    const cryptoMock = {
      identity: { roomId: "host-room", desktopName: "Studio Mac" },
    } as unknown as BridgeCrypto;

    const refs = {
      stateRef: {
        current: {
          events: [] as BridgeEvent[],
          snapshot: {
            sessions: [makeSession({ sessionId: "sess-notify", title: "部署脚本修复" })],
          } as unknown as BridgeHostSnapshot,
        },
      } as any,
      pendingCompletionNotificationsRef: { current: new Set<string>() },
    };

    const now = 1_795_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);

    const makeCompletedEvent = (id: string, seq: number, timestamp = now - 5_000): BridgeEvent => ({
      eventId: id,
      seq,
      timestamp,
      sessionId: "sess-notify",
      origin: "claude-desktop",
      type: "turn.completed",
      data: { text: "已完成全部检查并通过验证" },
    });

    // 1. bootstrap: true with 20 turn.completed events -> 0 notifications
    const bootstrapBatch = Array.from({ length: 20 }, (_, idx) => makeCompletedEvent(`boot-${idx}`, idx + 1));
    notifyBridgeCompletedTurns(refs, bootstrapBatch, cryptoMock, { bootstrap: true });
    await Promise.resolve();
    expect(nativeCap.localNotifications.schedule).not.toHaveBeenCalled();

    // 2. Stale event (> 30 minutes old) -> 0 notifications
    notifyBridgeCompletedTurns(refs, [makeCompletedEvent("stale-1", 25, now - 31 * 60_000)], cryptoMock);
    await Promise.resolve();
    expect(nativeCap.localNotifications.schedule).not.toHaveBeenCalled();

    // 3. window.bridgeDesktop defined (Electron renderer) -> 0 mobile notifications
    vi.stubGlobal("window", { bridgeDesktop: { version: "1.3.5" } });
    notifyBridgeCompletedTurns(refs, [makeCompletedEvent("desktop-1", 26)], cryptoMock);
    await Promise.resolve();
    expect(nativeCap.localNotifications.schedule).not.toHaveBeenCalled();
    vi.stubGlobal("window", {});

    // 4. Duplicate eventId across live socket + events.resume -> fires ONCE, never twice!
    const liveEvent = makeCompletedEvent("dup-live-1", 27);
    notifyBridgeCompletedTurns(refs, [liveEvent], cryptoMock);
    notifyBridgeCompletedTurns(refs, [liveEvent], cryptoMock, { fromResume: true });
    refs.stateRef.current.events = [liveEvent];
    notifyBridgeCompletedTurns(refs, [liveEvent], cryptoMock, { fromResume: true });
    await vi.waitFor(() => expect(nativeCap.localNotifications.schedule).toHaveBeenCalledTimes(1));

    // 5. LocalNotifications.schedule rejecting & checkPermissions rejecting -> zero unhandled rejections, recovers cleanly!
    vi.resetModules();
    const freshNotifications = await import("../lib/session-notifications.js");
    nativeCap.localNotifications.checkPermissions.mockRejectedValueOnce(new Error("Binder dead"));
    await expect(freshNotifications.ensureSessionNotificationPermission()).resolves.toBe(false);
    // Subsequent call must NOT be stuck on a poisoned permissionPromise!
    nativeCap.localNotifications.checkPermissions.mockResolvedValueOnce({ display: "granted" });
    await expect(freshNotifications.ensureSessionNotificationPermission()).resolves.toBe(true);

    nativeCap.localNotifications.schedule.mockRejectedValueOnce(new Error("AlarmManager limit"));
    await expect(
      freshNotifications.showSessionNotification({ hostId: "host-room", sessionId: "sess-notify" }, "标题", "内容"),
    ).resolves.toBeUndefined();

    // Malformed notification tap extra is ignored safely
    let tapHandler!: (event: unknown) => void;
    nativeCap.localNotifications.addListener.mockImplementation(async (_name, cb) => {
      tapHandler = cb;
      return { remove: vi.fn() };
    });
    const tapSpy = vi.fn();
    freshNotifications.onSessionNotificationTap(tapSpy);
    tapHandler({ notification: { extra: { hostId: 12345, sessionId: "sess-1" } } });
    tapHandler({ notification: { extra: { hostId: "", sessionId: "sess-1" } } });
    tapHandler({ notification: { extra: null } });
    expect(tapSpy).not.toHaveBeenCalled();
    tapHandler({ notification: { extra: { hostId: "host-room", sessionId: "sess-1" } } });
    expect(tapSpy).toHaveBeenCalledExactlyOnceWith({ hostId: "host-room", sessionId: "sess-1" });

    // 6. Android Chrome Web Notification constructor throwing TypeError: Illegal constructor
    nativeCap.isNative = false;
    const IllegalNotification = Object.assign(
      function BrokenNotification() {
        throw new TypeError("Illegal constructor");
      },
      { permission: "granted" },
    );
    vi.stubGlobal("Notification", IllegalNotification);
    expect(() => freshNotifications.showBrowserDesktopOrWebNotification("标题", "内容", "tag-1")).not.toThrow();
  });
});

describe("Round-4 Boundary 2B.4: Drag-and-drop edge boundaries", () => {
  let fakeWin: FakeEventTarget & { innerWidth: number; innerHeight: number };
  let fakeDoc: FakeEventTarget & {
    visibilityState: string;
    body: { classList: { add(c: string): void; remove(c: string): void; contains(c: string): boolean } };
    elementFromPoint(x: number, y: number): { closest(s: string): { getAttribute(a: string): string | null } | null } | null;
  };
  let hoveredDropId: string | undefined;
  let cancelRafSpy: ReturnType<typeof vi.fn>;
  let store: HookStore;
  let options: UseSessionSectionDragOptions;

  const manualSections: BridgeProjectInfo[] = [
    { projectId: "sec-alpha", name: "Alpha 组", kind: "desktop-group", cwd: "/a", sessionCount: 1, runningCount: 0, pendingCount: 0, lastActivityAt: 10 },
    { projectId: "sec-beta", name: "Beta 组", kind: "desktop-group", cwd: "/b", sessionCount: 0, runningCount: 0, pendingCount: 0, lastActivityAt: 5 },
  ];

  function renderDrag() {
    return runWithStore(store, () => useSessionSectionDrag(options));
  }

  function validRowTarget() {
    return {
      closest: () => null,
    } as unknown as EventTarget;
  }

  function buttonTarget() {
    return {
      closest: (selector: string) => (selector.includes("button:not(.session-row-hit)") ? {} : null),
    } as unknown as EventTarget;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    store = createStore();
    hoveredDropId = undefined;
    cancelRafSpy = vi.fn();
    fakeWin = Object.assign(new FakeEventTarget(), { innerWidth: 1280, innerHeight: 800 });
    const bodyClasses = new Set<string>();
    fakeDoc = Object.assign(new FakeEventTarget(), {
      visibilityState: "visible",
      body: {
        classList: {
          add: (c: string) => bodyClasses.add(c),
          remove: (c: string) => bodyClasses.delete(c),
          contains: (c: string) => bodyClasses.has(c),
        },
      },
      elementFromPoint: () => (
        hoveredDropId
          ? {
              closest: (sel: string) => (
                sel === "[data-drop-section-id]"
                  ? { getAttribute: () => hoveredDropId! }
                  : null
              ),
            }
          : null
      ),
    });
    vi.stubGlobal("window", fakeWin);
    vi.stubGlobal("document", fakeDoc);
    vi.stubGlobal("navigator", { vibrate: vi.fn() });
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 77));
    vi.stubGlobal("cancelAnimationFrame", cancelRafSpy);

    options = {
      hostOnline: true,
      capabilities: ["section.move.v1"],
      manualSections,
      sessions: [makeSession()],
      onMoveSessionSection: vi.fn().mockResolvedValue(undefined),
    };
  });

  afterEach(() => {
    unmountStore(store);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("handles 3px jitter, interactive button exclusion, multi-touch ignore, dynamic unsectioned drop, Escape/blur/disconnect/archive/Back cleanup, and post-drop click suppression", () => {
    const sess = makeSession();
    let ctrl = renderDrag();

    // 1. Interactive button (... or >) pointerdown is ignored completely
    ctrl.onSessionPointerDown(sess, {
      pointerId: 1,
      pointerType: "mouse",
      button: 0,
      isPrimary: true,
      clientX: 100,
      clientY: 100,
      target: buttonTarget(),
    } as unknown as ReactPointerEvent<HTMLElement>);
    fakeWin.dispatch("pointermove", { pointerId: 1, clientX: 140, clientY: 140 });
    ctrl = renderDrag();
    expect(ctrl.dragState).toBeUndefined();

    // 2. 3px mouse jitter does NOT activate drag, and click works immediately without suppression
    ctrl.onSessionPointerDown(sess, {
      pointerId: 2,
      pointerType: "mouse",
      button: 0,
      isPrimary: true,
      clientX: 100,
      clientY: 100,
      target: validRowTarget(),
    } as unknown as ReactPointerEvent<HTMLElement>);
    fakeWin.dispatch("pointermove", { pointerId: 2, clientX: 102, clientY: 102 });
    fakeWin.dispatch("pointerup", { pointerId: 2, clientX: 102, clientY: 102 });
    ctrl = renderDrag();
    expect(ctrl.dragState).toBeUndefined();
    expect(fakeWin.dispatch("click").prevented).toBe(false);

    // 3. Active drag ignores secondary touch pointer (isPrimary: false / pointerId: 99), drops onto UNSECTIONED_DROP_ID -> null,
    // suppresses immediate synthetic click, and allows normal click 100ms+ later!
    ctrl.onSessionPointerDown(sess, {
      pointerId: 10,
      pointerType: "mouse",
      button: 0,
      isPrimary: true,
      clientX: 100,
      clientY: 200,
      target: validRowTarget(),
    } as unknown as ReactPointerEvent<HTMLElement>);
    hoveredDropId = UNSECTIONED_DROP_ID;
    fakeWin.dispatch("pointermove", { pointerId: 10, clientX: 120, clientY: 20 }); // near top edge -> starts rAF auto-scroll
    ctrl = renderDrag();
    expect(ctrl.dragState?.hoveredTargetId).toBe(UNSECTIONED_DROP_ID);
    expect(fakeDoc.body.classList.contains("is-session-dragging")).toBe(true);

    // Second finger pointerdown + pointerup must NOT hijack or end pointer 10's drag
    ctrl.onSessionPointerDown(sess, {
      pointerId: 99,
      pointerType: "touch",
      button: 0,
      isPrimary: false,
      clientX: 300,
      clientY: 300,
      target: validRowTarget(),
    } as unknown as ReactPointerEvent<HTMLElement>);
    fakeWin.dispatch("pointerup", { pointerId: 99, clientX: 300, clientY: 300 });
    ctrl = renderDrag();
    expect(ctrl.dragState?.session.sessionId).toBe("sess-1");

    // Drop pointer 10 onto dynamic unsectioned drop zone -> calls onMoveSessionSection("sess-1", null)
    fakeWin.dispatch("pointerup", { pointerId: 10, clientX: 120, clientY: 20 });
    ctrl = renderDrag();
    expect(options.onMoveSessionSection).toHaveBeenCalledExactlyOnceWith("sess-1", null);
    expect(ctrl.dragState).toBeUndefined();
    expect(fakeDoc.body.classList.contains("is-session-dragging")).toBe(false);
    expect(cancelRafSpy).toHaveBeenCalled();

    // Synthetic post-drop click is suppressed once, and subsequent normal click 100ms later works normally!
    expect(fakeWin.dispatch("click").prevented).toBe(true);
    vi.advanceTimersByTime(100);
    expect(fakeWin.dispatch("click").prevented).toBe(false);

    // A brand-new pointerdown immediately after a drop disarms post-drop click suppression so fast follow-up taps (e.g. 新建会话) are never swallowed!
    ctrl.onSessionPointerDown(sess, {
      pointerId: 11,
      pointerType: "touch",
      button: 0,
      isPrimary: true,
      clientX: 60,
      clientY: 120,
      target: validRowTarget(),
    } as unknown as ReactPointerEvent<HTMLElement>);
    vi.advanceTimersByTime(320);
    fakeWin.dispatch("pointerup", { pointerId: 11, clientX: 60, clientY: 220 });
    fakeWin.dispatch("pointerdown", { pointerId: 12 });
    expect(fakeWin.dispatch("click").prevented).toBe(false);

    // 4. Escape, blur, pointercancel, Android Back, host disconnect, and mid-drag session archive all clean up 100%
    for (const cancelTrigger of ["escape", "blur", "pointercancel", "androidBack", "disconnect", "archive"] as const) {
      options = { ...options, hostOnline: true, sessions: [sess] };
      ctrl = renderDrag();
      ctrl.onSessionPointerDown(sess, {
        pointerId: 20,
        pointerType: "mouse",
        button: 0,
        isPrimary: true,
        clientX: 100,
        clientY: 100,
        target: validRowTarget(),
      } as unknown as ReactPointerEvent<HTMLElement>);
      fakeWin.dispatch("pointermove", { pointerId: 20, clientX: 130, clientY: 130 });
      ctrl = renderDrag();
      expect(ctrl.dragState?.session.sessionId).toBe("sess-1");

      if (cancelTrigger === "escape") {
        fakeWin.dispatch("keydown", { key: "Escape" });
      } else if (cancelTrigger === "blur") {
        fakeWin.dispatch("blur");
      } else if (cancelTrigger === "pointercancel") {
        fakeWin.dispatch("pointercancel", { pointerId: 20 });
      } else if (cancelTrigger === "androidBack") {
        expect(dispatchMobileBack()).toBe(true);
      } else if (cancelTrigger === "disconnect") {
        options = { ...options, hostOnline: false };
      } else if (cancelTrigger === "archive") {
        options = { ...options, sessions: [makeSession({ archivedAt: 999 })] };
      }
      ctrl = renderDrag();
      expect(ctrl.dragState).toBeUndefined();
      expect(fakeDoc.body.classList.contains("is-session-dragging")).toBe(false);
    }

    // 5. Dynamic "拖到这里移出分组（未分组）" drop zone renders in DesktopSessions when all active sessions are in manual sections!
    const map = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => map.set(k, v),
      removeItem: (k: string) => map.delete(k),
    });
    const sidebarStore = createStore();
    const apiRequest = vi.fn(async (): Promise<BridgeResponse> => ({
      kind: "response",
      requestId: "r",
      ok: true,
      result: { history: { sessionId: "sess-1", items: [], hasMore: false }, evidence: { sessionId: "sess-1", items: [], hasMore: false } },
    }));
    let sidebarTree = runWithStore(sidebarStore, () => renderDesktopSessions({
      snapshot: makeDesktopSnapshot(),
      events: [],
      apiRequest,
      onRefreshSnapshot: vi.fn().mockResolvedValue(undefined),
    })) as ReactElement;
    // Before drag starts, dynamic unsectioned drop zone is NOT rendered
    expect(elements(sidebarTree).some(el => el.props?.["data-drop-section-id"] === UNSECTIONED_DROP_ID)).toBe(false);
    // Start dragging the sectioned session row
    const draggableRow = elements(sidebarTree).find(
      el => typeof el.props?.onPointerDown === "function" && String(el.props?.className ?? "").includes("session-row"),
    )!;
    draggableRow.props.onPointerDown({
      pointerId: 33,
      pointerType: "mouse",
      button: 0,
      isPrimary: true,
      clientX: 80,
      clientY: 120,
      target: validRowTarget(),
    });
    fakeWin.dispatch("pointermove", { pointerId: 33, clientX: 95, clientY: 140 });
    sidebarTree = runWithStore(sidebarStore, () => renderDesktopSessions({
      snapshot: makeDesktopSnapshot(),
      events: [],
      apiRequest,
      onRefreshSnapshot: vi.fn().mockResolvedValue(undefined),
    })) as ReactElement;
    const dynamicDropZone = elements(sidebarTree).find(el => el.props?.["data-drop-section-id"] === UNSECTIONED_DROP_ID);
    expect(dynamicDropZone).toBeDefined();
    unmountStore(sidebarStore);
  });
});
