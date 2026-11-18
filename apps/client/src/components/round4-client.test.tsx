import type {
  BridgeHostSnapshot,
  BridgeResponse,
  BridgeSessionInfo,
  DesktopControlSnapshot,
  LocalBridgeRequest,
} from "@bridge/protocol";
import { createElement, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshotWithInspector } from "../lib/claude-snapshot.js";
import { EmptyState } from "./common/EmptyState.js";
import { IconButton } from "./common/IconButton.js";
import { SelectMenu } from "./common/SelectMenu.js";
import { Sheet, SheetAction } from "./common/Sheet.js";
import { DesktopSessions } from "./desktop/DesktopSessionsPane.js";
import { MobileWorkspace } from "./MobileWorkspace.js";
import { MobileInspectorCallout } from "./mobile/MobileInspectorCallout.js";
import { MobilePageHeader } from "./mobile/MobilePageHeader.js";
import { MobileSessionCatalog } from "./mobile/MobileSessionCatalog.js";
import { MobileSettings } from "./mobile/MobileSettings.js";
import { MobileHostDetails } from "./pairing/MobileHostDetails.js";
import { NewChatCanvas } from "./session/NewChatCanvas.js";
import { ProjectGroupHeader } from "./session/ProjectGroupHeader.js";
import { SectionCreateDialog } from "./session/SectionCreateDialog.js";
import { SessionActionSheets } from "./session/SessionActionSheets.js";
import { SessionFamilyList } from "./session/SessionFamilyList.js";

const hooks = vi.hoisted(() => ({
  slots: [] as any[],
  index: 0,
  effects: [] as Array<{ deps: unknown[] | undefined; cleanup: (() => void) | undefined }>,
  effectIndex: 0,
  pending: [] as Array<() => void>,
}));

vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState(initial: any) {
    const index = hooks.index++;
    if (!(index in hooks.slots)) {
      hooks.slots[index] = typeof initial === "function" ? initial() : initial;
    }
    return [
      hooks.slots[index],
      (value: any) => {
        hooks.slots[index] = typeof value === "function" ? value(hooks.slots[index]) : value;
      },
    ];
  },
  useRef(initial: unknown) {
    const index = hooks.index++;
    hooks.slots[index] ??= { current: initial };
    return hooks.slots[index];
  },
  useMemo: (create: () => unknown) => create(),
  useContext: () => undefined,
  useId: () => "mock-id",
  useEffect(effect: () => (() => void) | void, deps?: unknown[]) {
    const index = hooks.effectIndex++;
    const previous = hooks.effects[index];
    if (
      previous
      && deps
      && deps.length === previous.deps?.length
      && deps.every((value, i) => Object.is(value, previous.deps?.[i]))
    ) {
      return;
    }
    hooks.pending.push(() => {
      previous?.cleanup?.();
      hooks.effects[index] = { deps, cleanup: effect() || undefined };
    });
  },
  useLayoutEffect: () => undefined,
}));

vi.mock("./evidence/MediaPreviewProvider.js", () => ({
  useMediaPreview: () => vi.fn(),
  useMediaRequest: () => undefined,
}));

function elements(node: ReactNode): ReactElement<Record<string, any>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Record<string, any>>;
  const expand =
    element.type === EmptyState
    || element.type === ProjectGroupHeader
    || element.type === SessionFamilyList
    || element.type === MobilePageHeader
    || element.type === MobileSessionCatalog
    || element.type === SectionCreateDialog
    || element.type === SessionActionSheets
    || element.type === SheetAction;
  const children = expand
    ? (element.type as (props: any) => ReactNode)(element.props)
    : element.props.children;
  return [element, ...elements(children)];
}

function textContent(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join("");
  if (node && typeof node === "object" && "props" in node) {
    return textContent((node as ReactElement<Record<string, any>>).props.children);
  }
  return "";
}

function makeSession(overrides: Partial<BridgeSessionInfo> = {}): BridgeSessionInfo {
  return {
    sessionId: "sess-1",
    projectId: "sec-alpha",
    projectName: "Alpha 组",
    cwd: "/Users/demo/alpha",
    title: "原始会话标题",
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
      hostId: "host-desktop",
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

describe("Round 4 Client Deliverables", () => {
  beforeEach(() => {
    hooks.slots = [];
    hooks.effects = [];
    hooks.pending = [];
    const stored = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
      removeItem: (key: string) => stored.delete(key),
    });
    vi.stubGlobal("window", {});
  });

  afterEach(() => {
    hooks.effects.forEach((effect) => effect.cleanup?.());
    vi.unstubAllGlobals();
  });

  describe("Desktop sidebar ... menu parity (重命名 + 移动到分组 / 移出分组)", () => {
    it("opens rename modal with validation and calls session.command /rename, and supports moving between groups & out of group", async () => {
      const requests: LocalBridgeRequest[] = [];
      const apiRequest = vi.fn(async (req: LocalBridgeRequest): Promise<BridgeResponse> => {
        requests.push(req);
        if (req.method === "session.open") {
          return { kind: "response", requestId: "r1", ok: true, result: { history: { sessionId: "sess-1", items: [], hasMore: false } } };
        }
        if (req.method === "evidence.list") {
          return { kind: "response", requestId: "r2", ok: true, result: { evidence: { sessionId: "sess-1", items: [], hasMore: false } } };
        }
        if (req.method === "session.command") {
          return { kind: "response", requestId: "r3", ok: true, result: { command: { action: "rename" } } };
        }
        if (req.method === "section.move") {
          return {
            kind: "response",
            requestId: "r4",
            ok: true,
            result: { session: makeSession({ projectId: (req.params?.sectionId as string | null | undefined) ?? "claude-unsectioned" }) },
          };
        }
        return { kind: "response", requestId: "r0", ok: true, result: {} };
      });
      const onRefreshSnapshot = vi.fn().mockResolvedValue(undefined);
      const snapshot = makeDesktopSnapshot();

      function draw() {
        hooks.index = 0;
        hooks.effectIndex = 0;
        const tree = DesktopSessions({
          snapshot,
          events: [],
          apiRequest,
          onRefreshSnapshot,
        }) as ReactElement;
        hooks.pending.splice(0).forEach((fn) => fn());
        return tree;
      }

      let tree = draw();
      // Verify data-drop-section-id on manual groups
      const groupSections = elements(tree).filter((el) => el.type === "section" && el.props["data-drop-section-id"]);
      expect(groupSections.map((el) => el.props["data-drop-section-id"])).toEqual(["sec-alpha", "sec-beta"]);

      // Open row ... menu
      const rowMenuTrigger = elements(tree).find(
        (el) => el.type === IconButton && el.props.label === "会话操作：原始会话标题",
      )!;
      rowMenuTrigger.props.onClick();
      tree = draw();

      const renameAction = elements(tree).find((el) => el.type === SheetAction && el.props.label === "重命名")!;
      const moveAction = elements(tree).find((el) => el.type === SheetAction && el.props.label === "移动到分组")!;
      expect(renameAction).toBeDefined();
      expect(moveAction).toBeDefined();
      expect(moveAction.props.detail).toBe("Alpha 组");

      // Open rename modal
      renameAction.props.onClick();
      tree = draw();
      const renameDialog = elements(tree).find((el) => el.props["aria-label"] === "重命名会话")!;
      expect(renameDialog).toBeDefined();
      const renameInput = elements(renameDialog).find((el) => el.type === "input")!;
      const saveBtn = elements(renameDialog).find((el) => el.type === "button" && el.props.type === "submit")!;
      expect(renameInput.props.value).toBe("原始会话标题");
      expect(saveBtn.props.disabled).toBe(true); // unchanged

      renameInput.props.onChange({ target: { value: "   " } });
      tree = draw();
      expect(
        elements(tree).find((el) => el.type === "button" && el.props.type === "submit")!.props.disabled,
      ).toBe(true); // whitespace-only

      renameInput.props.onChange({ target: { value: "  新标题名称  " } });
      tree = draw();
      const activeDialog = elements(tree).find((el) => el.props["aria-label"] === "重命名会话")!;
      expect(
        elements(activeDialog).find((el) => el.type === "button" && el.props.type === "submit")!.props.disabled,
      ).toBe(false);
      elements(activeDialog).find((el) => el.type === "form")!.props.onSubmit({ preventDefault: vi.fn() });
      await vi.waitFor(() => {
        expect(requests.some((r) => r.method === "session.command")).toBe(true);
        expect(elements(draw()).find((el) => el.props["aria-label"] === "重命名会话")).toBeUndefined();
      });
      expect(requests.find((r) => r.method === "session.command")?.params).toEqual({
        sessionId: "sess-1",
        text: "/rename 新标题名称",
      });

      // Reopen row ... menu and enter 移动到分组 sub-view
      tree = draw();
      elements(tree).find(
        (el) => el.type === IconButton && el.props.label === "会话操作：原始会话标题",
      )!.props.onClick();
      tree = draw();
      elements(tree).find((el) => el.type === SheetAction && el.props.label === "移动到分组")!.props.onClick();
      tree = draw();

      const alphaOption = elements(tree).find((el) => el.type === SheetAction && el.props.label === "Alpha 组")!;
      const betaOption = elements(tree).find((el) => el.type === SheetAction && el.props.label === "Beta 组")!;
      const unsectionOption = elements(tree).find((el) => el.type === SheetAction && el.props.label === "移出分组")!;
      expect(alphaOption.props.detail).toBe("当前所在分组");
      expect(alphaOption.props.disabled).toBe(true);
      expect(betaOption.props.disabled).toBe(false);
      expect(unsectionOption.props.disabled).toBe(false);

      // Click 移出分组 -> moveSessionSection("sess-1", null)
      unsectionOption.props.onClick();
      await vi.waitFor(() => expect(requests.some((r) => r.method === "section.move")).toBe(true));
      expect(requests.find((r) => r.method === "section.move")?.params).toEqual({
        sessionId: "sess-1",
        sectionId: null,
      });
    });

    it("renders __unsectioned__ dropzone when dragging a grouped session and all active sessions belong to manual groups", () => {
      const listeners = new Map<string, Set<EventListener>>();
      vi.stubGlobal("window", {
        innerWidth: 1280,
        innerHeight: 800,
        addEventListener(type: string, fn: EventListener) {
          if (!listeners.has(type)) listeners.set(type, new Set());
          listeners.get(type)!.add(fn);
        },
        removeEventListener(type: string, fn: EventListener) {
          listeners.get(type)?.delete(fn);
        },
      });
      vi.stubGlobal("document", {
        visibilityState: "visible",
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        elementFromPoint: () => ({
          closest: () => ({ getAttribute: () => "__unsectioned__" }),
        }),
        body: undefined,
      });
      const snapshot = makeDesktopSnapshot();
      const apiRequest = vi.fn().mockResolvedValue({ kind: "response", requestId: "r0", ok: true, result: {} });

      function draw() {
        hooks.index = 0;
        hooks.effectIndex = 0;
        const tree = DesktopSessions({
          snapshot,
          events: [],
          apiRequest,
          onRefreshSnapshot: vi.fn().mockResolvedValue(undefined),
        }) as ReactElement;
        hooks.pending.splice(0).forEach((fn) => fn());
        return tree;
      }

      let tree = draw();
      expect(
        elements(tree).find((el) => el.props["data-drop-section-id"] === "__unsectioned__"),
      ).toBeUndefined();

      const draggableRow = elements(tree).find((el) => el.props["data-session-id"] === "sess-1")!;
      draggableRow.props.onPointerDown({
        pointerId: 5,
        pointerType: "mouse",
        button: 0,
        clientX: 40,
        clientY: 80,
        target: { closest: () => null },
      });
      for (const fn of listeners.get("pointermove") ?? []) {
        fn({
          pointerId: 5,
          clientX: 52,
          clientY: 96,
          cancelable: true,
          preventDefault: vi.fn(),
        } as unknown as Event);
      }

      tree = draw();
      const dropzone = elements(tree).find(
        (el) => el.props["data-drop-section-id"] === "__unsectioned__",
      )!;
      expect(dropzone).toBeDefined();
      expect(textContent(dropzone)).toBe("拖到这里移出分组（未分组）");
      expect(dropzone.props.className).toContain("is-drop-target");
    });
  });

  describe("NewChatCanvas optional 会话标题 input", () => {
    it("passes trimmed optional title to onCreateSession, preserves across directory picker, and resets after creation", async () => {
      const onCreateSession = vi.fn().mockResolvedValue(makeSession({ sessionId: "created-1", title: "自定义会话" }));
      const onSessionCreated = vi.fn();
      let pickedCallback: ((cwd: string) => void) | undefined;
      const onOpenDirectoryPicker = vi.fn((req) => {
        pickedCallback = req?.onPickDirectory;
      });
      const snapshot = makeDesktopSnapshot({ projects: [], sessions: [] });

      function drawCanvas() {
        hooks.index = 0;
        hooks.effectIndex = 0;
        const tree = NewChatCanvas({
          hostId: "host-desktop",
          snapshot,
          connected: true,
          onOpenDirectoryPicker,
          onCreateSession,
          onSessionCreated,
        }) as ReactElement;
        hooks.pending.splice(0).forEach((fn) => fn());
        return tree;
      }

      let tree = drawCanvas();
      const titleInput = elements(tree).find(
        (el) => el.type === "input" && el.props["aria-label"] === "会话标题",
      )!;
      expect(titleInput.props.placeholder).toBe("留空自动生成");
      expect(titleInput.props.maxLength).toBe(200);

      titleInput.props.onChange({ target: { value: "  第四轮联调验证  " } });
      tree = drawCanvas();

      // Clicking 创建空会话 with empty cwd opens directory picker while preserving sessionTitle
      const emptyCreateBtn = elements(tree).find(
        (el) => el.type === "button" && String(el.props.className).includes("new-chat-empty-create-btn"),
      )!;
      await emptyCreateBtn.props.onClick();
      expect(onOpenDirectoryPicker).toHaveBeenCalledOnce();
      pickedCallback?.("/Users/demo/project-x");

      tree = drawCanvas();
      expect(
        elements(tree).find((el) => el.type === "input" && el.props["aria-label"] === "会话标题")!.props.value,
      ).toBe("  第四轮联调验证  ");

      await elements(tree).find(
        (el) => el.type === "button" && String(el.props.className).includes("new-chat-empty-create-btn"),
      )!.props.onClick();
      expect(onCreateSession).toHaveBeenCalledWith(
        "/Users/demo/project-x",
        "第四轮联调验证",
        "claude-desktop",
        undefined,
      );

      tree = drawCanvas();
      expect(
        elements(tree).find((el) => el.type === "input" && el.props["aria-label"] === "会话标题")!.props.value,
      ).toBe("");
    });
  });

  describe("Remote Mobile One-Tap Start Claude Desktop & Enable Port 9229 UI + Mobile Settings", () => {
    it("enables activation while Claude is running with a closed port and shows permission guidance from the launch reply", async () => {
      const onActivate = vi.fn().mockResolvedValue({
        inspectorState: "closed",
        nativeReady: false,
        detail: "请在 macOS「系统设置 → 隐私与安全性 → 辅助功能」授权 Bridge 控制菜单后重试。",
      });
      const stoppedSnapshot: HostSnapshotWithInspector = {
        ...makeDesktopSnapshot(),
        runtime: {
          state: "unavailable",
          detail: "Claude Desktop 未启动",
          activeTurns: 0,
          maxParallelTurns: 0,
          desktopIntegration: { state: "disconnected", detail: "点击远程启动 Claude Desktop", enabled: true, canRestart: false },
        },
        claudeDesktop: { state: "stopped", detail: "已退出", canLaunch: true, canQuit: false },
        desktopApps: [{ id: "claude-desktop", name: "Claude Desktop", state: "stopped", detail: "已退出", canLaunch: true, canQuit: false }],
      };

      const stoppedMarkup = renderToStaticMarkup(
        createElement(MobileInspectorCallout, {
          snapshot: stoppedSnapshot,
          connected: true,
          onActivate,
        }),
      );
      expect(stoppedMarkup).toContain("mobile-inspector-callout");
      expect(stoppedMarkup).toContain("Claude Desktop 未启动");
      expect(stoppedMarkup).toContain("启动 Claude 并开启调试");

      // Running Claude Desktop with closed port 9229 (canLaunch=false because app is already running!) MUST keep button enabled
      const currentSnapshot: HostSnapshotWithInspector = {
        ...makeDesktopSnapshot(),
        runtime: {
          state: "unavailable",
          detail: "等待 9229 调试端口",
          activeTurns: 0,
          maxParallelTurns: 0,
          desktopIntegration: { state: "disconnected", detail: "Claude 已运行，尚未开启 9229 调试端口", enabled: true, canRestart: false },
        },
        claudeDesktop: { state: "running", detail: "Running", canLaunch: false, canQuit: true },
        desktopApps: [{ id: "claude-desktop", name: "Claude Desktop", state: "running", detail: "Running", canLaunch: false, canQuit: true }],
        claudeInspector: {
          state: "closed",
          port: 9229,
          pollIntervalMs: 2500,
          clients: [],
          alerts: [],
        },
      };

      function drawCallout(snapshot = currentSnapshot) {
        hooks.index = 0;
        hooks.effectIndex = 0;
        const tree = MobileInspectorCallout({
          snapshot,
          connected: true,
          onActivate,
        }) as ReactElement;
        hooks.pending.splice(0).forEach((fn) => fn());
        return tree;
      }

      let callout = drawCallout();
      const actionBtn = elements(callout).find((el) => el.type === "button")!;
      expect(actionBtn.props.disabled).toBe(false);
      expect(textContent(actionBtn)).toBe("开启调试端口");

      actionBtn.props.onClick();
      await vi.waitFor(() => expect(onActivate).toHaveBeenCalledOnce());
      callout = drawCallout();
      expect(textContent(callout)).toContain("辅助功能");

      const readySnapshot: HostSnapshotWithInspector = {
        ...currentSnapshot,
        claudeInspector: { ...currentSnapshot.claudeInspector!, state: "listening" },
        runtime: {
          ...currentSnapshot.runtime,
          state: "ready",
          desktopIntegration: { ...currentSnapshot.runtime.desktopIntegration, state: "ready" },
        },
      };
      expect(drawCallout(readySnapshot)).toBeNull();

      onActivate.mockResolvedValueOnce(undefined);
      elements(drawCallout()).find((el) => el.type === "button")!.props.onClick();
      await vi.waitFor(() => expect(onActivate).toHaveBeenCalledTimes(2));
      expect(textContent(drawCallout({
        ...currentSnapshot,
        claudeInspector: {
          ...currentSnapshot.claudeInspector!,
          startup: { state: "failed", detail: "未找到 Claude 的原生调试菜单。" },
        },
      }))).toContain("未找到 Claude 的原生调试菜单。");

      expect(textContent(drawCallout({
        ...currentSnapshot,
        claudeInspector: { ...readySnapshot.claudeInspector! },
        runtime: {
          ...currentSnapshot.runtime,
          desktopIntegration: { ...currentSnapshot.runtime.desktopIntegration, detail: "Claude 原生服务仍在启动。" },
        },
      }))).toContain("调试端口已开启，Claude 原生连接未就绪。Claude 原生服务仍在启动。");
      expect(textContent(drawCallout(readySnapshot))).toContain("调试端口已开启，Claude 原生连接已就绪。");
      expect(textContent(drawCallout(stoppedSnapshot))).not.toContain("Claude 原生连接已就绪");

      onActivate.mockResolvedValueOnce({ inspectorState: "listening", nativeReady: true });
      elements(drawCallout()).find((el) => el.type === "button")!.props.onClick();
      await vi.waitFor(() => expect(onActivate).toHaveBeenCalledTimes(3));
      expect(textContent(drawCallout(readySnapshot))).toContain("Claude 原生连接已就绪");
      expect(textContent(drawCallout({ ...readySnapshot }))).toContain("Claude 原生连接已就绪");
      expect(textContent(drawCallout())).not.toContain("Claude 原生连接已就绪");
    });

    it("wires the activation action into the workspace callout and renders port and notification controls", () => {
      const onActivateClaude = vi.fn();
      const onRefresh = vi.fn().mockResolvedValue(true);
      const snapshotWithClosedInspector: HostSnapshotWithInspector = {
        ...makeDesktopSnapshot(),
        runtime: {
          state: "unavailable",
          detail: "未开启调试",
          activeTurns: 0,
          maxParallelTurns: 0,
          desktopIntegration: { state: "disconnected", detail: "未开启 9229", enabled: true, canRestart: false },
        },
        claudeInspector: { state: "closed", port: 9229, pollIntervalMs: 2500, clients: [], alerts: [] },
      };

      hooks.slots = [];
      hooks.effects = [];
      hooks.pending = [];
      const workspaceProps: ComponentProps<typeof MobileWorkspace> = {
        activeHostId: "host-desktop",
        desktopName: "Studio Mac",
        connection: "connected",
        desktopOnline: true,
        snapshot: snapshotWithClosedInspector as BridgeHostSnapshot,
        permissions: [],
        histories: {},
        evidence: {},
        artifactPreviews: {},
        artifactTransfers: {},
        events: [],
        localTurns: [],
        pendingOutbound: 0,
        themeControl: { theme: "dark", family: "apple", setTheme: vi.fn(), setFamily: vi.fn(), toggleTheme: vi.fn() },
        onOpenSession: vi.fn(),
        onLoadOlderHistory: vi.fn(),
        onLoadOlderEvidence: vi.fn(),
        onPreviewArtifact: vi.fn(),
        onDownloadArtifact: vi.fn(),
        onSendTurn: vi.fn(),
        onInterruptTurn: vi.fn(),
        onResolveUncertain: vi.fn(),
        onResolvePermission: vi.fn(),
        onCreateSession: vi.fn(),
        onLoadSessionConfiguration: vi.fn(),
        onConfigureSession: vi.fn(),
        onActivateClaude,
        onRefresh,
        onBackToHosts: vi.fn(),
        onRetry: vi.fn(),
      };

      hooks.index = 0;
      hooks.effectIndex = 0;
      const wsTree = MobileWorkspace(workspaceProps) as ReactElement;
      hooks.pending.splice(0).forEach((fn) => fn());
      const calloutEl = elements(wsTree).find((el) => el.type === MobileInspectorCallout)!;
      expect(calloutEl.props.onActivate).toBe(onActivateClaude);

      // MobileHostDetails shows 9229 调试端口 status + 开启调试端口 button
      const hostDetailsHtml = renderToStaticMarkup(
        createElement(MobileHostDetails, {
          activeHostId: "host-desktop",
          desktopName: "Studio Mac",
          connection: "connected",
          desktopOnline: true,
          snapshot: snapshotWithClosedInspector as BridgeHostSnapshot,
          onRetry: vi.fn(),
          onRefresh,
          onDesktopAppAction: vi.fn(),
          onRemove: vi.fn(),
          onBack: vi.fn(),
        }),
      );
      expect(hostDetailsHtml).toContain("9229 调试端口");
      expect(hostDetailsHtml).toContain("未开启");
      expect(hostDetailsHtml).toContain("开启调试端口");

      // MobileSettings shows Claude 9229 status + 开启调试端口 + 任务通知 toggle + 授权通知 button
      const settingsHtml = renderToStaticMarkup(
        createElement(MobileSettings, {
          themeControl: { theme: "dark", family: "apple", setTheme: vi.fn(), setFamily: vi.fn(), toggleTheme: vi.fn() },
          claudeRuntime: {
            desktopName: "Studio Mac",
            snapshot: snapshotWithClosedInspector as BridgeHostSnapshot,
            connected: true,
            onActivate: vi.fn(),
          },
        }),
      );
      expect(settingsHtml).toContain("Claude 调试端口 (9229)");
      expect(settingsHtml).toContain("开启调试端口");
      expect(settingsHtml).toContain("任务通知");
      expect(settingsHtml).toContain("系统通知未授权");
      expect(settingsHtml).toContain("授权通知");
    });

    it("renders 助理 capsule inside mobile-drawer-topbar and supports ＋ 新建分组… inside NewChatCanvas without losing drafts", async () => {
      const createdSection = {
        projectId: "sec-new",
        name: "新研究组",
        cwd: "",
        kind: "desktop-group" as const,
        sessionCount: 0,
        runningCount: 0,
        pendingCount: 0,
        lastActivityAt: 200,
      };
      const onCreateSection = vi.fn().mockResolvedValue(createdSection);
      const onCreateSession = vi.fn().mockResolvedValue(makeSession({ sessionId: "sess-created", projectId: "sec-new" }));
      const onSelectTab = vi.fn();

      // 1. MobileSessionCatalog topbar renders drawer-assistant-capsule instead of standalone row
      const baseSnap = makeDesktopSnapshot();
      const snapWithAssistant: BridgeHostSnapshot = {
        ...baseSnap,
        projects: [{ ...baseSnap.projects[0]!, kind: "directory", projectId: "dir-1", name: "alpha", cwd: "/Users/demo/alpha" }],
        host: {
          ...baseSnap.host,
          capabilities: [...baseSnap.host.capabilities, "plugin.assistant-mail.v1", "section.create.v1"],
        },
      };
      const catalogHtml = renderToStaticMarkup(
        createElement(MobileSessionCatalog, {
          open: true,
          assistantAvailable: true,
          assistantUnreadCount: 3,
          onSelectTab,
          desktopName: "LycidasdeMac-mini",
          connection: "connected",
          desktopOnline: true,
          snapshot: snapWithAssistant,
          sessions: snapWithAssistant.sessions,
          archivedSessions: [],
          grouped: [{ project: snapWithAssistant.projects[0], sessions: snapWithAssistant.sessions }],
          collapsedProjectIds: new Set<string>(),
          expandedForkParents: new Set<string>(),
          projectOrder: ["dir-1"],
          projectsByActivity: ["dir-1"],
          permissions: [],
          connectionIssue: undefined,
          transportMetrics: undefined,
          search: "",
          directoryRef: { current: null },
          directoryScrollPositions: { current: new Map() },
          projectOrderOpen: false,
          sectionCreate: undefined,
          sectionCanCreate: true,
          sectionManage: {
            desktopName: "LycidasdeMac-mini",
            online: true,
            supportsRename: true,
            supportsDelete: true,
            hideEmptySections: false,
            emptySectionCount: 0,
            targetProject: undefined,
            state: undefined,
            canManage: () => false,
            shouldHideEmpty: () => false,
            revealEmptySections: vi.fn(),
            toggleHideEmptySections: vi.fn(),
            openMenu: vi.fn(),
            startRename: vi.fn(),
            updateName: vi.fn(),
            submitRename: vi.fn(async () => {}),
            startConfirmDelete: vi.fn(),
            runDelete: vi.fn(async () => {}),
            close: vi.fn(),
            renderDirectoryActions: () => null,
          },
          sessionOverlays: null,
          onBackToHosts: vi.fn(),
          onRetry: vi.fn(),
          onCreateSection,
          selectSession: vi.fn(),
          setSearch: vi.fn(),
          setProjectOrderOpen: vi.fn(),
          setSectionCreate: vi.fn(),
          onOpenSessionActions: vi.fn(),
          toggleProject: vi.fn(),
          toggleForkGroup: vi.fn(),
          openCreateDialogForProject: vi.fn(),
          placeProjects: vi.fn(),
          closeSectionCreate: vi.fn(),
          createSection: vi.fn(),
        }),
      );
      expect(catalogHtml).toContain('class="drawer-assistant-capsule"');
      expect(catalogHtml).toContain('aria-label="助理，3 条未读"');
      expect(catalogHtml).toContain('class="drawer-assistant-slot"');
      expect(catalogHtml).not.toContain("sidebar-assistant-row");

      // 2. NewChatCanvas shows 所属分组 even with 0 existing manual groups when section.create.v1 is supported,
      //    opens SectionCreateDialog on ＋ 新建分组…, auto-selects created.projectId, and preserves all form drafts.
      hooks.slots = [];
      hooks.effects = [];
      hooks.pending = [];
      let promptDraft = "";
      const draftsStub = {
        session: () => ({
          draftKey: "host:new",
          draft: { text: promptDraft, attachments: [], sending: false },
          promptReplies: {},
          queuedActions: {},
          fileUploads: [],
          setText: (v: string) => { promptDraft = v; },
          updateDraft: vi.fn(),
        }),
        resetSession: () => { promptDraft = ""; },
      };
      let currentSnapshot = snapWithAssistant;
      const drawCanvas = () => {
        hooks.index = 0;
        hooks.effectIndex = 0;
        const tree = NewChatCanvas({
          hostId: "host-desktop",
          snapshot: currentSnapshot,
          connected: true,
          mobile: true,
          initialCwd: "/Users/demo/alpha",
          conversationDrafts: draftsStub as any,
          onOpenDirectoryPicker: vi.fn(),
          onCreateSection,
          onCreateSession,
        }) as ReactElement;
        hooks.pending.splice(0).forEach((fn) => fn());
        return tree;
      };

      let canvasTree = drawCanvas();
      elements(canvasTree).find((el) => el.props["aria-label"] === "会话标题")!.props.onChange({ target: { value: "保留标题草稿" } });
      elements(canvasTree).find((el) => el.type === "textarea")!.props.onChange({ target: { value: "保留指令草稿" } });
      canvasTree = drawCanvas();

      const sectionMenu = elements(canvasTree).find((el) => el.type === SelectMenu && el.props.ariaLabel === "所属分组")!;
      expect(sectionMenu.props.options).toContainEqual({ value: "__create_section__", label: "＋ 新建分组…" });
      expect(sectionMenu.props.value).toBe("");

      // Select ＋ 新建分组… -> keeps selectedProjectId "" while opening SectionCreateDialog
      sectionMenu.props.onChange("__create_section__");
      canvasTree = drawCanvas();
      expect(elements(canvasTree).find((el) => el.type === SelectMenu && el.props.ariaLabel === "所属分组")!.props.value).toBe("");
      const createDialog = elements(canvasTree).find((el) => el.props["aria-label"] === "新建 Section")!;
      expect(createDialog).toBeDefined();

      elements(createDialog).find((el) => el.props["aria-label"] === "Section 名称")!.props.onChange({ target: { value: "  新研究组  " } });
      canvasTree = drawCanvas();
      const activeDialog = elements(canvasTree).find((el) => el.props["aria-label"] === "新建 Section")!;
      await elements(activeDialog).find((el) => el.type === "form")!.props.onSubmit({ preventDefault: vi.fn() });
      await Promise.resolve();
      canvasTree = drawCanvas();

      expect(onCreateSection).toHaveBeenCalledExactlyOnceWith("新研究组");
      expect(elements(canvasTree).find((el) => el.props["aria-label"] === "新建 Section")).toBeUndefined();
      const updatedMenu = elements(canvasTree).find((el) => el.type === SelectMenu && el.props.ariaLabel === "所属分组")!;
      expect(updatedMenu.props.value).toBe("sec-new");
      expect(elements(canvasTree).find((el) => el.props["aria-label"] === "会话标题")!.props.value).toBe("保留标题草稿");
      expect(elements(canvasTree).find((el) => el.type === "textarea")!.props.value).toBe("保留指令草稿");

      // Submit empty session -> passes created sectionId + preserved cwd & title
      elements(canvasTree).find((el) => el.type === "button" && textContent(el) === "创建空会话")!.props.onClick();
      await Promise.resolve();
      expect(onCreateSession).toHaveBeenCalledWith("/Users/demo/alpha", "保留标题草稿", "claude-desktop", "sec-new");

      // Once snapshot syncs createdSection and later deletes it externally, NewChatCanvas does not resurrect it
      currentSnapshot = { ...snapWithAssistant, projects: [...snapWithAssistant.projects, createdSection] };
      canvasTree = drawCanvas();
      currentSnapshot = snapWithAssistant;
      canvasTree = drawCanvas();
      expect(elements(canvasTree).some((el) => el.props.role === "alert" && textContent(el).includes("所选分组已不可用"))).toBe(true);
    });
  });
});
