import type { BridgeArtifactManifest, BridgeEvent, BridgeEvidenceBundle, BridgeEvidenceDetailPage, BridgeToolEvidence, DesktopControlSnapshot } from "@bridge/protocol";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EvidencePanel } from "./EvidencePanel.js";
import { ConfirmationDialog } from "./ConfirmationDialog.js";
import { IconButton } from "./IconButton.js";
import { DesktopDashboard } from "./DesktopDashboard.js";

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
vi.mock("../lib/mobile-back-navigation.js", () => ({ registerMobileBackHandler: () => () => undefined }));

const stores = new Map<string, HookStore>();
let props: ComponentProps<typeof EvidencePanel>;
let tree: ReactNode;
// Reconcile local Evidence components by type/key, including unmount on close.
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
        hooks.current = store; store.index = 0; store.effectIndex = 0;
        const result = (element.type as (props: any) => ReactNode)(element.props);
        store.pending.splice(0).forEach((effect) => effect());
        return render(result, key);
      }
      return { ...element, props: { ...element.props, children: render(element.props.children, `${path}/${element.key ?? String(element.type)}`) } };
    }
    tree = render(<EvidencePanel {...props} />, "root");
    for (const [key, store] of stores) {
      if (visited.has(key)) continue;
      store.effects.forEach((effect) => effect.cleanup?.()); stores.delete(key);
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
function toggle(open: boolean) {
  const bundle = elements().find((element) => element.type === "details" && element.props.className.startsWith("evidence-bundle"))!;
  bundle.props.onToggle({ currentTarget: { open } }); draw();
}
function click(label: string) {
  const button = elements().find((element) => element.type === "button" && element.props["aria-label"] === label)!;
  expect(button, label).toBeDefined(); expect(button.props.disabled).not.toBe(true);
  button.props.onClick(); draw();
}
async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); draw(); }
function tool(id: string): BridgeToolEvidence {
  return { id, toolName: id, summary: id, status: "completed", startedAt: 1, completedAt: 2, truncated: false };
}
function artifact(id: string): BridgeArtifactManifest {
  return { id, evidenceId: "evidence", name: `${id}.txt`, relativePath: `${id}.txt`, kind: "text", changeKind: "created", mimeType: "text/plain", size: 8, availability: "snapshot", previewMode: "text", downloadAllowed: true };
}
function bundle(): BridgeEvidenceBundle {
  return { id: "evidence", sessionId: "session", source: "bridge-host", confidence: "exact", state: "ready", startedAt: 1, completedAt: 2, toolCount: 61, artifactCount: 61, changeCount: 61, tools: [], artifacts: [], warnings: [], detailsAvailable: true };
}
const loadDetails = vi.fn<(id: string, kind: "tools" | "artifacts", cursor?: string) => Promise<BridgeEvidenceDetailPage>>();
beforeEach(() => {
  stores.clear(); loadDetails.mockReset();
  loadDetails.mockImplementation(async (evidenceId, kind, cursor) => ({
    evidenceId, kind, items: kind === "tools"
      ? Array.from({ length: 30 }, (_, i) => tool(`tool-${cursor ?? "first"}-${i}`))
      : Array.from({ length: 30 }, (_, i) => artifact(`file-${cursor ?? "first"}-${i}`)),
    nextCursor: cursor ? "third" : "second", hasMore: true,
  }) as BridgeEvidenceDetailPage);
  props = { state: { status: "ready", items: [bundle()], hasMore: false }, previews: {}, transfers: {}, online: true,
    onLoadMore: vi.fn(), onPreview: vi.fn(), onDownload: vi.fn(), onLoadDetails: loadDetails };
});
afterEach(() => {
  for (const store of stores.values()) store.effects.forEach((effect) => effect.cleanup?.());
  vi.unstubAllGlobals();
});

describe("on-demand evidence details", () => {
  it("does not request or render details while the summary is closed", async () => {
    draw(); await settle();
    expect(elements().find((element) => element.type === "details")!.props.open).toBe(false);
    expect(loadDetails).not.toHaveBeenCalled();
    expect(elements().some((element) => element.props.className === "evidence-tool-list")).toBe(false);
  });

  it("loads tools and artifacts only after expanding and replaces both pages", async () => {
    draw(); toggle(true); await settle();
    expect(loadDetails.mock.calls).toEqual([["evidence", "tools", undefined], ["evidence", "artifacts", undefined]]);
    expect(text()).toContain("tool-first-0"); expect(text()).toContain("file-first-0.txt");
    expect(text()).toContain("共 61 项 · 第 1 页");
    click("工具与命令下一页"); click("文件与产物下一页"); await settle();
    expect(loadDetails).toHaveBeenCalledWith("evidence", "tools", "second");
    expect(loadDetails).toHaveBeenCalledWith("evidence", "artifacts", "second");
    expect(text()).not.toContain("tool-first-0"); expect(text()).not.toContain("file-first-0.txt");
    expect(text()).toContain("tool-second-0"); expect(text()).toContain("file-second-0.txt");
    expect(text()).toContain("共 61 项 · 第 2 页");
    expect(elements().filter((element) => element.props.className?.startsWith("evidence-tool "))).toHaveLength(30);
    expect(elements().filter((element) => element.props.className?.startsWith("evidence-artifact "))).toHaveLength(30);
    click("工具与命令上一页"); await settle();
    expect(text()).toContain("tool-first-0"); expect(text()).not.toContain("tool-second-0");
  });

  it("unmounts loaded details on close and reloads on reopening", async () => {
    draw(); toggle(true); await settle(); toggle(false); await settle();
    expect(text()).not.toContain("tool-first-0"); expect(text()).not.toContain("file-first-0.txt");
    expect(loadDetails).toHaveBeenCalledTimes(2);
    toggle(true); await settle(); expect(loadDetails).toHaveBeenCalledTimes(4);
  });

  it("does not restore a closed page when an in-flight request finishes", async () => {
    let resolve!: (page: BridgeEvidenceDetailPage) => void;
    loadDetails.mockImplementationOnce(() => new Promise((yes) => { resolve = yes; }));
    draw(); toggle(true); toggle(false);
    resolve({ evidenceId: "evidence", kind: "tools", items: [tool("late-tool")], hasMore: false }); await settle();
    expect(text()).not.toContain("late-tool");
    toggle(true); await settle(); expect(text()).not.toContain("late-tool");
    expect(loadDetails).toHaveBeenCalledTimes(4);
  });

  it("keeps the current page across live summaries and refreshes it explicitly", async () => {
    draw(); toggle(true); await settle(); click("工具与命令下一页"); await settle();
    props = { ...props, state: { ...props.state!, items: [{ ...bundle(), toolCount: 90, completedAt: 3 }] }, onLoadDetails: (...args) => loadDetails(...args) };
    draw(); await settle();
    expect(loadDetails).toHaveBeenCalledTimes(3); expect(text()).toContain("共 90 项 · 第 2 页");
    click("刷新工具与命令"); await settle();
    expect(loadDetails).toHaveBeenLastCalledWith("evidence", "tools", "second");
    expect(text()).toContain("tool-second-0");
  });

  it("retains a loaded page offline and retries the failed next page", async () => {
    draw(); toggle(true); await settle(); loadDetails.mockRejectedValueOnce(new Error("network unavailable"));
    click("工具与命令下一页"); await settle();
    expect(text()).toContain("network unavailable"); expect(text()).toContain("tool-first-0");
    props = { ...props, online: false }; draw();
    expect(text()).toContain("tool-first-0");
    expect(elements().find((element) => element.props["aria-label"] === "重试工具与命令")!.props.disabled).toBe(true);
    props = { ...props, online: true }; draw(); click("重试工具与命令"); await settle();
    expect(text()).toContain("tool-second-0"); expect(text()).not.toContain("tool-first-0");
  });

  it("previews and downloads artifacts loaded from a detail page", async () => {
    const previewFile = { ...artifact("preview-file"), name: "output.custom", relativePath: "output.custom" };
    loadDetails.mockResolvedValueOnce({ evidenceId: "evidence", kind: "tools", items: [], hasMore: false })
      .mockResolvedValueOnce({ evidenceId: "evidence", kind: "artifacts", items: [previewFile], hasMore: true, nextCursor: "second" });
    draw(); toggle(true); await settle();
    const preview = { artifactId: "preview-file", mode: "text" as const, mimeType: "text/plain", encoding: "utf8" as const, data: "preview contents", truncated: false, generatedAt: 3 };
    vi.mocked(props.onPreview).mockResolvedValue(preview);
    elements().find((element) => element.type === IconButton && element.props.label === "预览 output.custom")!.props.onClick(); await settle();
    expect(props.onPreview).toHaveBeenCalledWith("preview-file");
    props = { ...props, previews: { "preview-file": preview } }; draw();
    expect(elements().some((element) => element.props.role === "dialog")).toBe(true);
    expect(text()).toContain("preview contents");
    click("文件与产物下一页"); await settle();
    expect(text()).toContain("preview contents");
    elements().find((element) => element.type === IconButton && element.props.label === "下载 file-second-0.txt")!.props.onClick(); draw();
    elements().find((element) => element.type === ConfirmationDialog)!.props.onConfirm(); await settle();
    expect(props.onDownload).toHaveBeenCalledWith(artifact("file-second-0"));
  });

  it("keeps legacy desktop events and lists as summaries and pages via evidence.get", async () => {
    const snapshot: DesktopControlSnapshot = {
      host: { hostId: "computer", name: "Computer", capabilities: [], pairingEpoch: 1, relayUrl: "", online: true, lastSeenAt: 1, version: "1.0.3" },
      sessions: [{ sessionId: "session", title: "Session", projectId: "project", projectName: "Project", cwd: "/tmp/project", source: "bridge", ownership: "BRIDGE_IDLE", transport: "bridge-host", turnState: "idle", lastActivityAt: 1, pendingCount: 0 }],
      projects: [], devices: [], permissions: [], latestSeq: 0,
      runtime: { state: "ready", detail: "Ready", activeTurns: 0, maxParallelTurns: 2, desktopIntegration: { state: "not-managed", detail: "Unavailable", enabled: false, canRestart: false } },
      connection: "connected", launchAtLogin: false, managedDesktopEnabled: false,
      claudeDesktop: { state: "stopped", detail: "Stopped", canLaunch: true, canQuit: false },
    };
    const { detailsAvailable: _, ...summary } = bundle();
    const full = { ...summary, tools: Array.from({ length: 61 }, (_, i) => tool(`legacy-${i}`)), artifacts: [artifact("legacy")] };
    const request = vi.fn(async ({ method }: { method: string; params: Record<string, unknown> }) => ({ kind: "response", requestId: "test", ok: true, result:
      method === "session.open" ? { history: { items: [], hasMore: false } }
        : method === "evidence.list" ? { evidence: { items: [full], hasMore: false } }
        : method === "evidence.get" ? { evidence: full }
        : { page: { evidenceId: "evidence", kind: "tools", items: [tool("rpc-page")], hasMore: false } },
    }));
    let onEvent!: (event: BridgeEvent) => void;
    vi.stubGlobal("window", { bridgeDesktop: { getSnapshot: async () => snapshot, onSnapshot: () => () => undefined,
      onEvent: (receive: typeof onEvent) => { onEvent = receive; return () => undefined; }, request } });
    // Shallow-render the two dashboard levels, retaining separate hook stores.
    function renderComponent(component: (props: any) => ReactNode, initialProps: any) {
      const store: HookStore = { slots: [], index: 0, dirty: false, effects: [], effectIndex: 0, pending: [] };
      stores.set(component.name, store);
      return (nextProps = initialProps) => {
        let result: ReactNode;
        for (let pass = 0; pass < 12; pass++) {
          hooks.current = store; store.dirty = false; store.index = 0; store.effectIndex = 0;
          result = component(nextProps); store.pending.splice(0).forEach((effect) => effect());
          if (!store.dirty) return result;
        }
        throw new Error("Desktop did not settle");
      };
    }
    const dashboard = renderComponent(DesktopDashboard, {
      themeControl: { theme: "dark", family: "apple", setTheme: vi.fn(), setFamily: vi.fn(), toggleTheme: vi.fn() },
      agentVisibility: { enabled: ["claude-desktop"], setEnabled: vi.fn() },
    });
    dashboard(); await Promise.resolve();
    onEvent({ eventId: "legacy-event", seq: 1, timestamp: 2, sessionId: "session", origin: "claude-host", type: "evidence.ready", data: { evidence: full } });
    const child = elements(dashboard()).find((element) => typeof element.type === "function" && element.type.name === "DesktopSessions")!;
    expect(child.props.events[0].data.evidence).toMatchObject({ detailsAvailable: true, tools: [], artifacts: [], toolCount: 61 });
    const sessions = renderComponent(child.type as (props: any) => ReactNode, child.props);
    sessions(); for (let i = 0; i < 12; i++) await Promise.resolve();
    elements(sessions()).find((element) => element.type === "button" && text(element.props.children).startsWith("成果"))!.props.onClick();
    const panel = elements(sessions()).find((element) => element.type === EvidencePanel)!;
    expect(panel.props.state.items[0]).toMatchObject({ detailsAvailable: true, tools: [], artifacts: [] });
    expect(await panel.props.onLoadDetails("evidence", "tools", "30")).toMatchObject({ kind: "tools", items: full.tools.slice(30, 60), nextCursor: "60", hasMore: true });
    expect(request).toHaveBeenLastCalledWith({ method: "evidence.get", params: { evidenceId: "evidence" } });
    const modernPanel = elements(sessions({ ...child.props, snapshot: { ...snapshot, host: { ...snapshot.host, capabilities: ["evidence.details.v1"] } } })).find((element) => element.type === EvidencePanel)!;
    expect(await modernPanel.props.onLoadDetails("evidence", "tools", "cursor")).toMatchObject({ items: [tool("rpc-page")] });
    expect(request).toHaveBeenLastCalledWith({ method: "evidence.details", params: { evidenceId: "evidence", kind: "tools", cursor: "cursor", limit: 30 } });
  });

  it("continues to render legacy full bundles without a loader", async () => {
    const { detailsAvailable: _, ...legacy } = bundle();
    const { onLoadDetails: __, ...legacyProps } = props;
    props = { ...legacyProps, state: { status: "ready", hasMore: false, items: [{ ...legacy, tools: [tool("legacy-tool")], artifacts: [artifact("legacy-file")] }] } };
    draw(); await settle();
    expect(text()).toContain("legacy-tool"); expect(text()).toContain("legacy-file.txt");
    expect(loadDetails).not.toHaveBeenCalled();
  });
});
