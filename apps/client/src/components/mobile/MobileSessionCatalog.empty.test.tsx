import type { BridgeHostSnapshot, BridgeSessionInfo } from "@bridge/protocol";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileWorkspace } from "../MobileWorkspace.js";
import { SessionCreateDialog } from "../session/SessionCreateDialog.js";

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

vi.mock("../evidence/MediaPreviewProvider.js", () => ({ useMediaPreview: () => vi.fn() }));

function elements(node: ReactNode): ReactElement<Record<string, any>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Record<string, any>>;
  return [element, ...elements(element.props.children)];
}

function textContent(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join("");
  if (node && typeof node === "object" && "props" in node) {
    return textContent((node as ReactElement<Record<string, any>>).props.children);
  }
  return "";
}

describe("MobileSessionCatalog empty states", () => {
  let props: ComponentProps<typeof MobileWorkspace>;
  let tree: ReactElement;

  const baseSession: BridgeSessionInfo = {
    sessionId: "session-1",
    projectId: "project-1",
    projectName: "Project",
    cwd: "/tmp/project",
    title: "Existing session",
    source: "desktop",
    ownership: "DESKTOP_NATIVE_IDLE",
    transport: "claude-desktop-native",
    turnState: "idle",
    lastActivityAt: 10,
    pendingCount: 0,
  };

  function makeSnapshot(overrides: Partial<BridgeHostSnapshot> = {}): BridgeHostSnapshot {
    return {
      host: {
        hostId: "host-1",
        pairingEpoch: 1,
        name: "My Mac",
        relayUrl: "ws://127.0.0.1:8788/ws",
        online: true,
        lastSeenAt: 10,
        version: "1.3.1",
        capabilities: ["claude.native-relay.v1", "directory.browse.v1"],
      },
      projects: [],
      sessions: [],
      devices: [],
      runtime: {
        state: "ready",
        detail: "连接 Claude Desktop；会话和执行由 Desktop 管理",
        activeTurns: 0,
        maxParallelTurns: 0,
        desktopIntegration: {
          state: "ready",
          detail: "连接 Claude Desktop；会话和执行由 Desktop 管理",
          enabled: true,
          canRestart: false,
        },
      },
      runtimes: [{
        id: "claude-desktop",
        name: "Claude Desktop",
        state: "ready",
        detail: "连接 Claude Desktop；会话和执行由 Desktop 管理",
        capabilities: ["session.list", "session.history", "session.create", "turn.start"],
        sessionIsolation: "independent",
        sessionCount: 0,
        updatedAt: 10,
      }],
      claudeDesktop: { state: "running", detail: "Running", canLaunch: false, canQuit: true },
      permissions: [],
      latestSeq: 0,
      ...overrides,
    };
  }

  function draw() {
    hooks.index = 0;
    hooks.effectIndex = 0;
    tree = MobileWorkspace(props) as ReactElement;
    hooks.pending.splice(0).forEach((effect) => effect());
  }

  function emptyStateBox() {
    return elements(tree).find((element) => element.props.className === "session-catalog-loading");
  }

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
    props = {
      activeHostId: "host-1",
      desktopName: "My Mac",
      connection: "connected",
      desktopOnline: true,
      snapshot: makeSnapshot(),
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
      onPreviewProviderSwitch: vi.fn(),
      onCommitProviderSwitch: vi.fn(),
      onCancelProviderSwitch: vi.fn(),
      onRefreshProviders: vi.fn(),
      onDesktopAppAction: vi.fn(),
      onRefresh: vi.fn(),
      onBackToHosts: vi.fn(),
      onInspectConnection: vi.fn(),
      onRetry: vi.fn(),
    };
    draw();
  });

  afterEach(() => {
    hooks.effects.forEach((effect) => effect.cleanup?.());
    vi.unstubAllGlobals();
  });

  it("shows search-empty prompt without create or connection actions when search matches nothing", () => {
    props = {
      ...props,
      snapshot: makeSnapshot({
        projects: [{ projectId: "project-1", name: "Project", cwd: "/tmp/project", sessionCount: 1, runningCount: 0, pendingCount: 0, lastActivityAt: 10 }],
        sessions: [baseSession],
      }),
    };
    draw();
    const searchInput = elements(tree).find(
      (element) => element.type === "input" && element.props.placeholder === "搜索项目或会话",
    )!;
    searchInput.props.onChange({ target: { value: "nonexistent-keyword" } });
    draw();

    const box = emptyStateBox()!;
    expect(elements(box).find((el) => el.type === "strong")?.props.children).toBe("没有匹配的会话");
    expect(elements(box).find((el) => el.type === "span")?.props.children).toBe("换一个关键词试试。");
    expect(elements(box).find((el) => el.type === "button")).toBeUndefined();
  });

  it("shows ready empty state and opens SessionCreateDialog from primary button when Desktop is online with 0 sessions", () => {
    const box = emptyStateBox()!;
    expect(elements(box).find((el) => el.type === "strong")?.props.children).toBe("暂无会话");
    expect(elements(box).find((el) => el.type === "span")?.props.children).toBe(
      "当前电脑上尚未创建会话，可随时开始新的对话。",
    );
    expect(elements(tree).some((el) => el.type === SessionCreateDialog)).toBe(false);

    const createButton = elements(box).find((el) => el.type === "button")!;
    expect(createButton.props.className).toContain("primary-button");
    expect(textContent(createButton)).toBe("新建会话");
    createButton.props.onClick();
    draw();

    expect(elements(tree).some((el) => el.type === SessionCreateDialog)).toBe(true);
  });

  it("distinguishes archived-only sessions on an online Desktop and preserves the archived group entry", () => {
    props = {
      ...props,
      snapshot: makeSnapshot({
        sessions: [{ ...baseSession, sessionId: "archived-1", archivedAt: 20 }],
      }),
    };
    draw();

    const box = emptyStateBox()!;
    expect(elements(box).find((el) => el.type === "strong")?.props.children).toBe("暂无活跃会话");
    expect(textContent(elements(box).find((el) => el.type === "button"))).toBe("新建会话");
    expect(elements(tree).some((el) => el.type === "strong" && el.props.children === "已归档会话")).toBe(true);
  });

  it.each([
    {
      label: "Bridge connected while host is offline",
      override: () => ({ connection: "connected" as const, desktopOnline: false, snapshot: makeSnapshot() }),
    },
    {
      label: "Bridge and host online while Claude Desktop inspector is unavailable",
      override: () => ({
        connection: "connected" as const,
        desktopOnline: true,
        snapshot: makeSnapshot({
          runtime: {
            state: "unavailable",
            detail: "Claude Desktop 未启动",
            activeTurns: 0,
            maxParallelTurns: 0,
            desktopIntegration: { state: "disconnected", detail: "Claude Desktop 未启动", enabled: true, canRestart: false },
          },
          runtimes: [{
            id: "claude-desktop",
            name: "Claude Desktop",
            state: "unavailable",
            detail: "Claude Desktop 未启动",
            capabilities: ["session.list", "session.history"],
            sessionIsolation: "independent",
            sessionCount: 0,
            updatedAt: 10,
          }],
          claudeDesktop: { state: "stopped", detail: "Stopped", canLaunch: true, canQuit: false },
        }),
      }),
    },
  ])("shows missing Claude Desktop prompt and triggers connection inspection ($label)", ({ override }) => {
    const onInspectConnection = vi.fn();
    props = { ...props, ...override(), onInspectConnection };
    draw();

    const box = emptyStateBox()!;
    expect(elements(box).find((el) => el.type === "strong")?.props.children).toBe("未检测到 Claude Desktop");
    expect(elements(box).find((el) => el.type === "span")?.props.children).toBe(
      "请在电脑端打开 Claude Desktop。启动后 Bridge 将自动建立连接。",
    );
    const inspectButton = elements(box).find((el) => el.type === "button")!;
    expect(inspectButton.props.className).toContain("secondary-button");
    expect(textContent(inspectButton)).toBe("检查连接");
    inspectButton.props.onClick();
    expect(onInspectConnection).toHaveBeenCalledTimes(1);
  });

  it.each(["connecting", "reconnecting", "closed"] as const)("shows connection state before the first snapshot (%s)", connection => {
    props = { ...props, snapshot: undefined, connection, desktopOnline: false };
    draw();
    const box = emptyStateBox()!;
    expect(elements(box).find(el => el.type === "strong")?.props.children).toBe(
      connection === "closed" ? "当前未连接电脑" : "正在连接电脑",
    );
    elements(box).find(el => el.type === "button")!.props.onClick();
    expect(props.onInspectConnection).toHaveBeenCalledTimes(1);
  });

  it.each(["ready", "working", "unavailable"] as const)("uses native runtime state for older snapshots (%s)", state => {
    const { runtimes: _omitted, ...snapshot } = makeSnapshot();
    props = { ...props, snapshot: { ...snapshot, runtime: { ...snapshot.runtime, state } } };
    draw();
    expect(elements(emptyStateBox()).find(el => el.type === "strong")?.props.children).toBe(
      state === "unavailable" ? "未检测到 Claude Desktop" : "暂无会话",
    );
  });

  it("reflects reconnecting and disconnected Bridge transport states with a fallback connection check callback", () => {
    const onBackToHosts = vi.fn();
    const { onInspectConnection: _omitted, ...restProps } = props;
    props = { ...restProps, connection: "reconnecting", desktopOnline: false, onBackToHosts };
    draw();
    expect(elements(emptyStateBox()).find((el) => el.type === "strong")?.props.children).toBe("正在连接电脑");

    props = { ...restProps, connection: "closed", desktopOnline: false, onBackToHosts };
    draw();
    const box = emptyStateBox()!;
    expect(elements(box).find((el) => el.type === "strong")?.props.children).toBe("当前未连接电脑");
    elements(box).find((el) => el.type === "button")!.props.onClick();
    expect(onBackToHosts).toHaveBeenCalledTimes(1);
  });
});
