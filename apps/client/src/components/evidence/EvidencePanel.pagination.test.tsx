import type {
  BridgeArtifactManifest,
  BridgeEvent,
  BridgeEvidenceBundle,
  BridgeEvidenceDetailPage,
  BridgeToolEvidence,
  DesktopControlSnapshot,
} from "@bridge/protocol";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmationDialog } from "../common/ConfirmationDialog.js";
import { IconButton } from "../common/IconButton.js";
import { DesktopDashboard } from "../DesktopDashboard.js";
import { DesktopConversationProvider, DesktopSessionConversation } from "../desktop/DesktopSessionConversation.js";
import { DesktopSessions } from "../desktop/DesktopSessionsPane.js";
import { EvidencePanel } from "./EvidencePanel.js";

type HookStore = {
  slots: any[];
  index: number;
  dirty: boolean;
  effects: Array<{ deps: unknown[] | undefined; cleanup: (() => void) | undefined }>;
  effectIndex: number;
  pending: Array<() => void>;
};
const hooks = vi.hoisted(() => ({
  current: undefined as HookStore | undefined,
  contexts: new Map<unknown, unknown>(),
}));
const media = vi.hoisted(() => ({
  open: vi.fn(),
  confirm: vi.fn<(_target: unknown, open: () => void) => void>((_target, open) => open()),
}));

function recordEffect(effect: () => (() => void) | void, deps?: unknown[]) {
  const store = hooks.current!;
  const index = store.effectIndex++;
  const previous = store.effects[index];
  if (
    previous
    && deps
    && deps.length === previous.deps?.length
    && deps.every((value, i) => Object.is(value, previous.deps?.[i]))
  ) return;
  store.pending.push(() => {
    previous?.cleanup?.();
    store.effects[index] = { deps, cleanup: effect() || undefined };
  });
}

vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
  useState(initial: any) {
    const store = hooks.current!;
    const index = store.index++;
    if (!(index in store.slots)) store.slots[index] = typeof initial === "function" ? initial() : initial;
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
    const store = hooks.current!;
    const index = store.index++;
    store.slots[index] ??= { current: initial };
    return store.slots[index];
  },
  useMemo: (create: () => unknown) => create(),
  useCallback: (callback: unknown) => callback,
  useContext: (context: unknown) => hooks.contexts.get(context),
  useEffect: recordEffect,
  useLayoutEffect: recordEffect,
}));

vi.mock("./MediaPreviewProvider.js", async (original) => ({
  ...(await original<typeof import("./MediaPreviewProvider.js")>()),
  useMediaPreview: () => media.open,
  useFilePreviewConfirmation: () => media.confirm,
}));
vi.mock("../../lib/mobile-back-navigation.js", () => ({
  registerMobileBackHandler: () => () => undefined,
}));

const stores = new Map<string, HookStore>();
let props: ComponentProps<typeof EvidencePanel>;
let tree: ReactNode;

function draw() {
  for (let pass = 0; pass < 12; pass++) {
    const visited = new Set<string>();
    for (const store of stores.values()) store.dirty = false;
    function render(node: ReactNode, path: string): ReactNode {
      if (Array.isArray(node)) return node.map((child, index) => render(child, `${path}/${index}`));
      if (!node || typeof node !== "object" || !("props" in node)) return node;
      const element = node as ReactElement<Record<string, any>>;
      if (typeof element.type === "function" && element.type.name.startsWith("Evidence")) {
        const key = `${path}/${element.type.name}:${element.key ?? ""}`;
        visited.add(key);
        let store = stores.get(key);
        if (!store) {
          store = { slots: [], index: 0, dirty: false, effects: [], effectIndex: 0, pending: [] };
          stores.set(key, store);
        }
        hooks.current = store;
        store.index = 0;
        store.effectIndex = 0;
        const result = (element.type as (props: any) => ReactNode)(element.props);
        store.pending.splice(0).forEach((effect) => effect());
        return render(result, key);
      }
      return {
        ...element,
        props: {
          ...element.props,
          children: render(element.props.children, `${path}/${element.key ?? String(element.type)}`),
        },
      };
    }
    tree = render(<EvidencePanel {...props} />, "root");
    for (const [key, store] of stores) {
      if (visited.has(key)) continue;
      store.effects.forEach((effect) => effect.cleanup?.());
      stores.delete(key);
    }
    if (![...stores.values()].some((store) => store.dirty)) return;
  }
  throw new Error("Evidence panel did not settle");
}

function elements(node: ReactNode = tree): ReactElement<Record<string, any>>[] {
  if (Array.isArray(node)) return node.flatMap((child) => elements(child ?? null));
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Record<string, any>>;
  return [element, ...elements(element.props.children ?? null)];
}

function text(node: ReactNode = tree): string {
  if (Array.isArray(node)) return node.map((child) => text(child ?? null)).join("");
  if (!node || typeof node === "boolean") return "";
  if (typeof node !== "object") return String(node);
  return "props" in node ? text((node as ReactElement<Record<string, any>>).props.children ?? null) : "";
}

async function settle() {
  for (let i = 0; i < 8; i++) {
    draw();
    await Promise.resolve();
  }
  draw();
}

function tool(id: string): BridgeToolEvidence {
  return { id, toolName: id, summary: id, status: "completed", startedAt: 1, completedAt: 2, truncated: false };
}

function artifact(id: string, overrides: Partial<BridgeArtifactManifest> = {}): BridgeArtifactManifest {
  return {
    id,
    evidenceId: "evidence",
    name: `${id}.txt`,
    relativePath: `${id}.txt`,
    kind: "text",
    changeKind: "created",
    mimeType: "text/plain",
    size: 8,
    availability: "snapshot",
    previewMode: "text",
    downloadAllowed: true,
    ...overrides,
  };
}

function bundle(overrides: Partial<BridgeEvidenceBundle> = {}): BridgeEvidenceBundle {
  return {
    id: "evidence",
    sessionId: "session",
    source: "bridge-host",
    confidence: "exact",
    state: "ready",
    startedAt: 1,
    completedAt: 2,
    toolCount: 61,
    artifactCount: 61,
    changeCount: 61,
    tools: [],
    artifacts: [],
    warnings: [],
    detailsAvailable: true,
    ...overrides,
  };
}

const loadDetails = vi.fn<
  (id: string, kind: "tools" | "artifacts", cursor?: string) => Promise<BridgeEvidenceDetailPage>
>();

beforeEach(() => {
  stores.clear();
  loadDetails.mockReset();
  media.open.mockClear();
  media.confirm.mockReset().mockImplementation((_target, open) => open());
  vi.stubGlobal("window", new EventTarget());
  loadDetails.mockImplementation(async (evidenceId, kind, cursor) => ({
    evidenceId,
    kind,
    items: kind === "tools"
      ? Array.from({ length: 30 }, (_, i) => tool(`tool-${cursor ?? "first"}-${i}`))
      : Array.from({ length: 30 }, (_, i) => artifact(`file-${cursor ?? "first"}-${i}`)),
    ...(cursor ? { hasMore: false } : { nextCursor: "second", hasMore: true }),
  }) as BridgeEvidenceDetailPage);
  props = {
    state: { status: "ready", items: [bundle()], hasMore: false },
    previews: {},
    transfers: {},
    online: true,
    onLoadMore: vi.fn(),
    onPreview: vi.fn(),
    onDownload: vi.fn(),
    onLoadDetails: loadDetails,
  };
});

afterEach(() => {
  for (const store of stores.values()) store.effects.forEach((effect) => effect.cleanup?.());
  vi.unstubAllGlobals();
});

describe("deduplicated chronological output-file evidence list", () => {
  it("loads artifact details automatically without requesting tool logs and supports loading remaining pages", async () => {
    draw();
    await settle();
    expect(loadDetails.mock.calls).toEqual([["evidence", "artifacts"]]);
    expect(text()).toContain("共 30 个文件");
    expect(text()).toContain("file-first-0.txt");
    expect(text()).not.toContain("工具与命令");
    expect(elements().some((element) => element.type === "details")).toBe(false);

    const moreButton = elements().find(
      (element) => element.type === "button" && text(element.props.children).includes("加载更多"),
    )!;
    expect(moreButton).toBeDefined();
    moreButton.props.onClick();
    await settle();
    expect(loadDetails).toHaveBeenCalledWith("evidence", "artifacts", "second");
    expect(text()).toContain("共 60 个文件");
    expect(text()).toContain("file-first-0.txt");
    expect(text()).toContain("file-second-0.txt");
  });

  it("deduplicates repeated edits across turns in latest-updated descending order while projecting latest snapshot", async () => {
    const turn2 = bundle({
      id: "turn-2",
      startedAt: 20,
      completedAt: 25,
      detailsAvailable: false,
      artifactCount: 2,
      artifacts: [
        artifact("alpha-v2", { name: "alpha.ts", relativePath: "src/alpha.ts", changeKind: "modified", size: 512 }),
        artifact("gamma-v1", { name: "gamma.ts", relativePath: "src/gamma.ts", changeKind: "created", size: 128 }),
      ],
    });
    const turn1 = bundle({
      id: "turn-1",
      startedAt: 10,
      completedAt: 15,
      detailsAvailable: false,
      artifactCount: 2,
      artifacts: [
        artifact("alpha-v1", { name: "alpha.ts", relativePath: "src/alpha.ts", changeKind: "created", size: 256 }),
        artifact("beta-v1", { name: "beta.ts", relativePath: "src/beta.ts", changeKind: "created", size: 64 }),
      ],
    });
    props = {
      ...props,
      state: { status: "ready", hasMore: false, items: [turn2, turn1] },
    };
    draw();
    await settle();

    const rowNames = elements()
      .filter((element) => element.props.className === "evidence-file-name")
      .map((element) => text(element.props.children));
    expect(rowNames).toEqual(["gamma.ts", "alpha.ts", "beta.ts"]);
    expect(text()).toContain("共 3 个文件");
    expect(loadDetails).not.toHaveBeenCalled();

    // Clicking download on alpha.ts downloads the latest snapshot (alpha-v2), not alpha-v1.
    elements().find((element) => element.type === IconButton && element.props.label === "下载 alpha.ts")!.props.onClick();
    draw();
    elements().find((element) => element.type === ConfirmationDialog)!.props.onConfirm();
    await settle();
    expect(props.onDownload).toHaveBeenCalledWith(expect.objectContaining({ id: "alpha-v2", changeKind: "modified" }));
  });

  it("surfaces failed detail loads with retry and retains loaded files when going offline", async () => {
    loadDetails.mockRejectedValueOnce(new Error("network unavailable"));
    draw();
    await settle();
    expect(text()).toContain("network unavailable");
    expect(elements().some((element) => element.props.className === "evidence-empty")).toBe(true);

    const retry = elements().find((element) => element.type === "button" && text(element.props.children) === "重试")!;
    retry.props.onClick();
    await settle();
    expect(text()).toContain("file-first-0.txt");

    props = { ...props, online: false };
    draw();
    expect(text()).toContain("电脑离线 · 已缓存预览仍可打开");
    expect(text()).toContain("file-first-0.txt");
  });

  it("previews and confirms legacy html-screenshot previews on deduplicated rows", async () => {
    const textFile = artifact("preview-file", { name: "output.custom", relativePath: "output.custom" });
    const htmlFile = artifact("screenshot", {
      name: "report.html",
      relativePath: "artifacts/report.html",
      kind: "html",
      previewMode: "html-screenshot",
    });
    loadDetails.mockResolvedValueOnce({
      evidenceId: "evidence",
      kind: "artifacts",
      items: [textFile, htmlFile],
      hasMore: false,
    });
    media.confirm.mockImplementationOnce(() => undefined);
    vi.mocked(props.onPreview).mockResolvedValue({
      artifactId: htmlFile.id,
      mode: "html-screenshot",
      mimeType: "image/png",
      encoding: "base64",
      data: "preview",
      truncated: false,
      generatedAt: 3,
    });

    draw();
    await settle();

    elements().find((element) => element.type === IconButton && element.props.label === "预览 output.custom")!.props.onClick();
    await settle();
    expect(media.open).toHaveBeenCalledWith({
      name: "output.custom",
      kind: "text",
      artifactId: "preview-file",
      path: "output.custom",
    });
    expect(props.onPreview).not.toHaveBeenCalled();

    // report.html matches mediaKind("text") via .html extension unless non-media custom extension is used:
    const customHtml = artifact("custom-html", {
      name: "snapshot.htmshot",
      relativePath: "artifacts/snapshot.htmshot",
      kind: "html",
      previewMode: "html-screenshot",
    });
    props = {
      ...props,
      state: {
        status: "ready",
        hasMore: false,
        items: [bundle({ detailsAvailable: false, artifactCount: 1, artifacts: [customHtml] })],
      },
    };
    draw();
    await settle();
    elements().find((element) => element.type === IconButton && element.props.label === "预览 snapshot.htmshot")!.props.onClick();
    await settle();
    expect(media.confirm).toHaveBeenCalledWith({ name: customHtml.name, artifactId: customHtml.id }, expect.any(Function));
    expect(props.onPreview).not.toHaveBeenCalled();
    media.confirm.mock.calls[0]![1]();
    await settle();
    expect(props.onPreview).toHaveBeenCalledWith(customHtml.id);
  });

  it("keeps legacy desktop events and lists as summaries and pages via evidence.get or evidence.details", async () => {
    const snapshot: DesktopControlSnapshot = {
      host: {
        hostId: "computer",
        name: "Computer",
        capabilities: [],
        pairingEpoch: 1,
        relayUrl: "",
        online: true,
        lastSeenAt: 1,
        version: "1.0.3",
      },
      sessions: [{
        sessionId: "session",
        title: "Session",
        projectId: "project",
        projectName: "Project",
        cwd: "/tmp/project",
        source: "bridge",
        ownership: "BRIDGE_IDLE",
        transport: "bridge-host",
        turnState: "idle",
        lastActivityAt: 1,
        pendingCount: 0,
      }],
      projects: [],
      devices: [],
      permissions: [],
      latestSeq: 0,
      runtime: {
        state: "ready",
        detail: "Ready",
        activeTurns: 0,
        maxParallelTurns: 2,
        desktopIntegration: { state: "not-managed", detail: "Unavailable", enabled: false, canRestart: false },
      },
      connection: "connected",
      launchAtLogin: false,
      diagnosticsEnabled: false,
      managedDesktopEnabled: false,
      claudeDesktop: { state: "stopped", detail: "Stopped", canLaunch: true, canQuit: false },
    };
    const { detailsAvailable: _, ...summary } = bundle();
    const full = {
      ...summary,
      tools: Array.from({ length: 61 }, (_, i) => tool(`legacy-${i}`)),
      artifacts: [artifact("legacy")],
    };
    const request = vi.fn(async ({ method }: { method: string; params: Record<string, unknown> }) => ({
      kind: "response",
      requestId: "test",
      ok: true,
      result: method === "session.open"
        ? { history: { items: [], hasMore: false } }
        : method === "evidence.list"
          ? { evidence: { items: [full], hasMore: false } }
          : method === "evidence.get"
            ? { evidence: full }
            : { page: { evidenceId: "evidence", kind: "artifacts", items: [artifact("rpc-page")], hasMore: false } },
    }));
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn() });
    let onEvent!: (event: BridgeEvent) => void;
    let onSnapshot!: (snapshot: DesktopControlSnapshot) => void;
    vi.stubGlobal("window", {
      bridgeDesktop: {
        getSnapshot: async () => snapshot,
        onSnapshot: (receive: typeof onSnapshot) => {
          onSnapshot = receive;
          return () => undefined;
        },
        onEvent: (receive: typeof onEvent) => {
          onEvent = receive;
          return () => undefined;
        },
        request,
      },
    });

    function renderComponent(component: (props: any) => ReactNode, initialProps: any) {
      const subStores = new Map<string, HookStore>();
      return (nextProps = initialProps) => {
        let result: ReactNode;
        for (let pass = 0; pass < 12; pass++) {
          const visited = new Set<string>();
          for (const store of subStores.values()) store.dirty = false;
          function expand(node: ReactNode, path: string): ReactNode {
            if (Array.isArray(node)) return node.map((child, index) => expand(child, `${path}/${index}`));
            if (!node || typeof node !== "object" || !("props" in node)) return node;
            const element = node as ReactElement<Record<string, any>>;
            if (typeof element.type === "object" && "value" in element.props) {
              hooks.contexts.set(element.type, element.props.value);
              try {
                return expand(element.props.children, `${path}/provider`);
              } finally {
                hooks.contexts.delete(element.type);
              }
            }
            if (
              element.type === DesktopConversationProvider
              || element.type === DesktopSessions
              || element.type === DesktopSessionConversation
              || (typeof element.type === "function" && ["ConversationView", "MobilePageHeader"].includes(element.type.name))
            ) {
              const key = `${path}/${element.type.name}:${element.key ?? ""}`;
              visited.add(key);
              let childStore = subStores.get(key);
              if (!childStore) {
                childStore = { slots: [], index: 0, dirty: false, effects: [], effectIndex: 0, pending: [] };
                subStores.set(key, childStore);
                stores.set(`${component.name}:${key}`, childStore);
              }
              hooks.current = childStore;
              childStore.index = 0;
              childStore.effectIndex = 0;
              const childOut = (element.type as (props: any) => ReactNode)(element.props);
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
            stores.set(component.name, rootStore);
          }
          visited.add("root");
          hooks.current = rootStore;
          rootStore.index = 0;
          rootStore.effectIndex = 0;
          const rootOut = component(nextProps);
          rootStore.pending.splice(0).forEach((effect) => effect());
          result = expand(rootOut, "root");
          for (const [key, store] of subStores) {
            if (visited.has(key)) continue;
            store.effects.forEach((effect) => effect.cleanup?.());
            subStores.delete(key);
          }
          if (![...subStores.values()].some((store) => store.dirty)) return result;
        }
        throw new Error("Desktop did not settle");
      };
    }

    const dashboard = renderComponent(DesktopDashboard, {
      themeControl: { theme: "dark", family: "apple", setTheme: vi.fn(), setFamily: vi.fn(), toggleTheme: vi.fn() },
      agentVisibility: { enabled: ["claude-desktop"], setEnabled: vi.fn() },
    });
    dashboard();
    await Promise.resolve();
    onEvent({
      eventId: "legacy-event",
      seq: 1,
      timestamp: 2,
      sessionId: "session",
      origin: "claude-host",
      type: "evidence.ready",
      data: { evidence: full },
    });
    const child = elements(dashboard()).find((element) => element.type === DesktopSessions)!;
    expect(child.props.events[0].data.evidence).toMatchObject({
      detailsAvailable: true,
      tools: [],
      artifacts: [],
      toolCount: 61,
    });
    for (let i = 0; i < 12; i++) await Promise.resolve();
    elements(dashboard()).find((element) => element.type === "button" && text(element.props.children).startsWith("成果"))!.props.onClick();
    const panel = elements(dashboard()).find((element) => element.type === EvidencePanel)!;
    expect(panel.props.state.items[0]).toMatchObject({ detailsAvailable: true, tools: [], artifacts: [] });
    expect(await panel.props.onLoadDetails("evidence", "artifacts")).toMatchObject({
      kind: "artifacts",
      items: [artifact("legacy")],
      hasMore: false,
    });
    expect(request).toHaveBeenLastCalledWith({ method: "evidence.get", params: { evidenceId: "evidence" } });
    onSnapshot({ ...snapshot, host: { ...snapshot.host, capabilities: ["evidence.details.v1"] } });
    const modernPanel = elements(dashboard()).find((element) => element.type === EvidencePanel)!;
    expect(await modernPanel.props.onLoadDetails("evidence", "artifacts", "cursor")).toMatchObject({
      items: [artifact("rpc-page")],
    });
    expect(request).toHaveBeenLastCalledWith({
      method: "evidence.details",
      params: { evidenceId: "evidence", kind: "artifacts", cursor: "cursor", limit: 30 },
    });
  });

  it("renders legacy full bundles directly without calling onLoadDetails", async () => {
    const { detailsAvailable: _, ...legacy } = bundle();
    const { onLoadDetails: __, ...legacyProps } = props;
    props = {
      ...legacyProps,
      state: {
        status: "ready",
        hasMore: false,
        items: [{ ...legacy, tools: [tool("legacy-tool")], artifacts: [artifact("legacy-file")] }],
      },
    };
    draw();
    await settle();
    expect(text()).toContain("legacy-file.txt");
    expect(text()).not.toContain("legacy-tool");
    expect(loadDetails).not.toHaveBeenCalled();
  });

  it("reloads artifact details when a bundle updates while its initial detail request is in flight", async () => {
    let resolveFirst!: (page: BridgeEvidenceDetailPage) => void;
    const firstPending = new Promise<BridgeEvidenceDetailPage>((resolve) => {
      resolveFirst = resolve;
    });
    loadDetails
      .mockReset()
      .mockImplementationOnce(() => firstPending)
      .mockResolvedValueOnce({
        evidenceId: "evidence",
        kind: "artifacts",
        items: [artifact("first-file"), artifact("second-file")],
        hasMore: false,
      });

    props = {
      ...props,
      state: {
        status: "ready",
        hasMore: false,
        items: [bundle({ artifactCount: 1, completedAt: 10 })],
      },
    };
    draw();
    expect(loadDetails).toHaveBeenCalledTimes(1);

    // Bundle updates while first detail request is still in flight.
    props = {
      ...props,
      state: {
        status: "ready",
        hasMore: false,
        items: [bundle({ artifactCount: 2, completedAt: 20 })],
      },
    };
    draw();
    expect(loadDetails).toHaveBeenCalledTimes(1);

    // Resolve stale response -> component must detect signature drift and load latest details.
    resolveFirst({
      evidenceId: "evidence",
      kind: "artifacts",
      items: [artifact("first-file")],
      hasMore: false,
    });
    await settle();

    expect(loadDetails).toHaveBeenCalledTimes(2);
    expect(text()).toContain("first-file.txt");
    expect(text()).toContain("second-file.txt");
    expect(text()).toContain("共 2 个文件");
  });
});
