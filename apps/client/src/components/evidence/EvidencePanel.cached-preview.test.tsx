import type { BridgeArtifactManifest } from "@bridge/protocol";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EvidencePanel } from "./EvidencePanel.js";
import { MediaPreviewProvider } from "./MediaPreviewProvider.js";
import { ConfirmationDialog } from "../common/ConfirmationDialog.js";
import { IconButton } from "../common/IconButton.js";
import type { MediaRequest } from "../../lib/media-preview.js";

type Store = { slots: any[]; index: number; dirty: boolean; effects: Array<{ deps: unknown[] | undefined; cleanup: (() => void) | undefined }>; effectIndex: number; pending: Array<() => void> };
const hooks = vi.hoisted(() => ({ current: undefined as Store | undefined, contexts: new Map<unknown, unknown>() }));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useContext: (context: unknown) => hooks.contexts.get(context),
  useState(initial: any) {
    const store = hooks.current!, index = store.index++;
    if (!(index in store.slots)) store.slots[index] = typeof initial === "function" ? initial() : initial;
    return [store.slots[index], (value: any) => {
      const next = typeof value === "function" ? value(store.slots[index]) : value;
      if (!Object.is(next, store.slots[index])) store.dirty = true;
      store.slots[index] = next;
    }];
  },
  useRef(initial: unknown) { const store = hooks.current!, index = store.index++; return store.slots[index] ??= { current: initial }; },
  useMemo: (create: () => unknown) => create(),
  useCallback: (callback: unknown) => callback,
  useEffect(effect: () => (() => void) | void, deps?: unknown[]) {
    const store = hooks.current!, index = store.effectIndex++, previous = store.effects[index];
    if (previous && deps && deps.length === previous.deps?.length && deps.every((value, i) => Object.is(value, previous.deps?.[i]))) return;
    store.pending.push(() => { previous?.cleanup?.(); store.effects[index] = { deps, cleanup: effect() || undefined }; });
  },
}));

// Run the actual Provider and Evidence components with their actual context
// values. Only React's renderer/hooks are substituted; confirmation is not mocked.
const stores = new Map<string, Store>();
const request = vi.fn<MediaRequest>();
let props: ComponentProps<typeof EvidencePanel>;
let tree: ReactNode;
function draw() {
  for (let pass = 0; pass < 12; pass++) {
    for (const store of stores.values()) store.dirty = false;
    function render(node: ReactNode, path: string): ReactNode {
      if (Array.isArray(node)) return node.map((child, index) => render(child, `${path}/${index}`));
      if (!node || typeof node !== "object" || !("props" in node)) return node;
      const element = node as ReactElement<Record<string, any>>;
      if (typeof element.type === "object" && "value" in element.props && "$$typeof" in element.type) {
        hooks.contexts.set(element.type, element.props.value);
      }
      if (typeof element.type === "function" && (element.type === MediaPreviewProvider || element.type.name.startsWith("Evidence"))) {
        const key = `${path}/${element.type.name}:${element.key ?? ""}`;
        let store = stores.get(key);
        if (!store) { store = { slots: [], index: 0, dirty: false, effects: [], effectIndex: 0, pending: [] }; stores.set(key, store); }
        hooks.current = store; store.index = 0; store.effectIndex = 0;
        const result = (element.type as (props: any) => ReactNode)(element.props);
        store.pending.splice(0).forEach(effect => effect());
        return render(result, key);
      }
      return { ...element, props: { ...element.props, children: render(element.props.children, `${path}/${element.key ?? String(element.type)}`) } };
    }
    tree = render(<MediaPreviewProvider request={request} {...{ supportsFileStat: true }}><EvidencePanel {...props} /></MediaPreviewProvider>, "root");
    if (![...stores.values()].some(store => store.dirty)) return;
  }
  throw new Error("Cached preview did not settle");
}
function elements(node: ReactNode = tree): ReactElement<Record<string, any>>[] {
  if (Array.isArray(node)) return node.flatMap(child => elements(child ?? null));
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Record<string, any>>;
  return [element, ...elements(element.props.children ?? null)];
}
async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); draw(); }
const file: BridgeArtifactManifest = { id: "cached", evidenceId: "evidence", name: "output.custom", relativePath: "output.custom", kind: "text", changeKind: "created", mimeType: "text/plain", size: 8, availability: "snapshot", previewMode: "text", downloadAllowed: true };
beforeEach(() => {
  stores.clear(); hooks.contexts.clear(); vi.stubGlobal("window", new EventTarget());
  request.mockReset().mockRejectedValue(new Error("原文件已不存在"));
  props = {
    state: { status: "ready", hasMore: false, items: [{ id: "evidence", sessionId: "session", source: "bridge-host", confidence: "exact", state: "ready", startedAt: 1, completedAt: 2, toolCount: 0, artifactCount: 1, changeCount: 1, tools: [], artifacts: [file], warnings: [] }] },
    previews: { cached: { artifactId: "cached", mode: "text", mimeType: "text/plain", encoding: "utf8", data: "LOCAL_CACHED_CONTENT", truncated: false, generatedAt: 3 } },
    transfers: {}, online: true, onLoadMore: vi.fn(), onPreview: vi.fn(), onDownload: vi.fn(),
  };
});
afterEach(() => { for (const store of stores.values()) store.effects.forEach(effect => effect.cleanup?.()); vi.unstubAllGlobals(); });

describe("local evidence preview precedence", () => {
  it.each([
    { online: false, availability: "expired", previewMode: "text", kind: "text" },
    { online: true, availability: "current-file", previewMode: "text", kind: "text" },
    { online: true, availability: "current-file", previewMode: "diff", kind: "diff" },
    { online: true, availability: "snapshot", previewMode: "html-screenshot", kind: "html" },
  ] as const)("opens cached $previewMode directly with online=$online, availability=$availability", async scenario => {
    props.online = scenario.online;
    props.state!.items[0]!.artifacts = [{ ...file, ...scenario }];
    draw();
    const button = elements().find(element => element.type === IconButton && element.props.label === "打开 output.custom 的缓存预览")!;
    expect(button).toBeDefined(); expect(button.props.disabled).not.toBe(true);
    button.props.onClick(); draw(); await settle();
    expect(request).not.toHaveBeenCalled();
    expect(props.onPreview).not.toHaveBeenCalled();
    expect(elements().find(element => element.props.className === "artifact-preview-dialog")).toBeDefined();
    expect(elements().find(element => element.type === "pre")!.props.children).toBe("LOCAL_CACHED_CONTENT");
    expect(elements().filter(element => element.type === ConfirmationDialog).every(element => !element.props.open)).toBe(true);
  });
});
