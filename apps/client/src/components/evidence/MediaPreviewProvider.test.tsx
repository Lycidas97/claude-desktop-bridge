import type { BridgeResponse } from "@bridge/protocol";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchMobileBack, registerMobileBackHandler } from "../../lib/mobile-back-navigation.js";
import type { MediaRequest, MediaTarget } from "../../lib/media-preview.js";
import { ConfirmationDialog } from "../common/ConfirmationDialog.js";
import { MediaPreviewProvider } from "./MediaPreviewProvider.js";

const hooks = vi.hoisted(() => ({ slots: [] as any[], index: 0, effects: [] as Array<{ deps: unknown[]; cleanup: (() => void) | undefined }>, effectIndex: 0, pending: [] as Array<() => void>, dirty: false }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState(initial: unknown) {
    const index = hooks.index++;
    if (!(index in hooks.slots)) hooks.slots[index] = initial;
    return [hooks.slots[index], (value: any) => { hooks.slots[index] = typeof value === "function" ? value(hooks.slots[index]) : value; hooks.dirty = true; }];
  },
  useRef(initial: unknown) { const index = hooks.index++; hooks.slots[index] ??= { current: initial }; return hooks.slots[index]; },
  useCallback: (callback: unknown) => callback,
  useEffect(effect: () => void | (() => void), deps: unknown[]) {
    const index = hooks.effectIndex++;
    const previous = hooks.effects[index];
    if (previous && deps.length === previous.deps?.length && deps.every((value, i) => Object.is(value, previous.deps?.[i]))) return;
    hooks.pending.push(() => { previous?.cleanup?.(); hooks.effects[index] = { deps, cleanup: effect() || undefined }; });
  },
}));

let tree: ReactElement<any>;
const response = (result: unknown): BridgeResponse => ({ kind: "response", requestId: "preview", ok: true, result });
const request = vi.fn<MediaRequest>();
let supportsFileStat: boolean | undefined;
function draw() {
  for (let pass = 0; pass < 10; pass++) {
    hooks.dirty = false; hooks.index = 0; hooks.effectIndex = 0;
    tree = MediaPreviewProvider({ request, children: null, ...(supportsFileStat === undefined ? {} : { supportsFileStat }) });
    hooks.pending.splice(0).forEach(effect => effect());
    if (!hooks.dirty) return;
  }
  throw new Error("Preview provider did not settle");
}
async function settle() { for (let i = 0; i < 8; i++) await Promise.resolve(); draw(); }
function open(target: MediaTarget) { tree.props.children.props.children.props.value(target); draw(); }
function dialog(): ReactElement<any> { return tree.props.children.props.children.props.children.find((child: any) => child?.type === ConfirmationDialog); }
function viewer() { return tree.props.children.props.children.props.children.find((child: any) => child?.props?.children?.props?.target)?.props.children; }
const target: MediaTarget = { name: "large.txt", kind: "text", sessionId: "preview_session", path: " /preview/large.txt:12:3 " };

beforeEach(() => {
  hooks.slots = []; hooks.effects = []; hooks.pending = []; supportsFileStat = true;
  vi.stubGlobal("window", new EventTarget());
  request.mockReset();
  request.mockResolvedValue(response({ metadata: { name: "large.txt", mimeType: "text/plain", size: 1048577 } }));
  draw();
});
afterEach(() => { hooks.effects.forEach(effect => effect.cleanup?.()); vi.unstubAllGlobals(); });

describe("file preview confirmation", () => {
  it.each([false, undefined])("blocks a legacy handler before any request when stat support is %s", async (support) => {
    supportsFileStat = support;
    let bodyReads = 0;
    const leases = new Set<string>();
    // 094cbdd checks only purpose === "text-preview"; every other purpose
    // reads the body and returns { transfer }, including the unknown "stat".
    request.mockImplementation(async () => {
      bodyReads++;
      const transferId = `old-lease-${bodyReads}`;
      leases.add(transferId);
      return response({ transfer: { transferId, size: 20 } });
    });
    draw();
    open(target); await settle();
    for (let attempt = 1; attempt < 4; attempt++) {
      dialog().props.onConfirm(); draw(); await settle();
    }
    expect({ requests: request.mock.calls.length, bodyReads, leases: leases.size }).toEqual({ requests: 0, bodyReads: 0, leases: 0 });
    expect(viewer()).toBeUndefined();
    expect(dialog().props.description).toContain("更新电脑端 Bridge");
    expect(dialog().props.description).toContain("重新连接");
  });

  it("keeps already-local data viewable without stat support", () => {
    supportsFileStat = false; draw();
    const local = { name: "photo.png", kind: "image" as const, dataUrl: "blob:cached" };
    open(local);
    expect(viewer().props.target).toEqual(local);
    expect(request).not.toHaveBeenCalled();
  });
  it.each([0, 20, 1048576])("opens %i bytes directly after metadata only", async (size) => {
    request.mockResolvedValue(response({ metadata: { name: "small.txt", mimeType: "text/plain", size } }));
    open(target); await settle();
    expect(request.mock.calls.map(([method, params]) => ({ method, params }))).toEqual([{ method: "artifact.transfer.open", params: { sessionId: "preview_session", path: "/preview/large.txt", purpose: "stat" } }]);
    expect(dialog().props.open).toBe(false);
    expect(viewer().props.target).toEqual(target);
  });

  it.each(["text", "pdf", "image"] as const)("waits for explicit confirmation before mounting the %s viewer", async (kind) => {
    open({ ...target, kind }); await settle();
    expect(viewer()).toBeUndefined();
    expect(dialog().props).toMatchObject({ open: true, confirmLabel: "下载并预览" });
    expect(dialog().props.description).toContain("1,048,577 字节");
    expect(dialog().props.description).toContain("流量");
    expect(request).toHaveBeenCalledTimes(1);
    dialog().props.onConfirm(); draw();
    expect(dialog().props.open).toBe(false);
    expect(viewer().props.target.kind).toBe(kind);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("cancels without opening or reading content", async () => {
    open(target); await settle(); dialog().props.onCancel(); draw();
    expect(viewer()).toBeUndefined();
    expect(request.mock.calls.every(([, params]) => params.purpose === "stat")).toBe(true);
  });

  it("handles back before the workspace and leaves the next back to it", async () => {
    const workspaceBack = vi.fn(() => true);
    const unregister = registerMobileBackHandler(workspaceBack, 100);
    try {
      open(target); await settle();
      expect(dispatchMobileBack()).toBe(true); draw();
      expect(workspaceBack).not.toHaveBeenCalled();
      expect(viewer()).toBeUndefined();
      expect(request).toHaveBeenCalledTimes(1);
      expect(dispatchMobileBack()).toBe(true);
      expect(workspaceBack).toHaveBeenCalledOnce();
    } finally { unregister(); }
  });

  it("does not open a viewer when metadata arrives after cancelling", async () => {
    let finish!: (response: BridgeResponse) => void;
    request.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    open(target);
    expect(dispatchMobileBack()).toBe(true); draw();
    finish(response({ metadata: { name: "small.txt", mimeType: "text/plain", size: 8 } }));
    await settle();
    expect(viewer()).toBeUndefined(); expect(dialog().props.open).toBe(false);
    expect(request).toHaveBeenCalledOnce();
  });

  it("uses the same confirmation for legacy artifact previews", async () => {
    const legacyPreview = vi.fn();
    tree.props.children.props.value({ name: "output.custom", artifactId: "preview_artifact" }, legacyPreview); draw(); await settle();
    expect(request).toHaveBeenCalledWith("artifact.transfer.open", { artifactId: "preview_artifact", purpose: "stat" }, expect.anything());
    expect(legacyPreview).not.toHaveBeenCalled();
    dialog().props.onConfirm(); draw();
    expect(legacyPreview).toHaveBeenCalledOnce(); expect(viewer()).toBeUndefined();
  });

  it("keeps local image data immediately viewable", () => {
    const local = { name: "photo.png", kind: "image" as const, dataUrl: "blob:already-downloaded" };
    open(local);
    expect(viewer().props.target).toEqual(local); expect(request).not.toHaveBeenCalled();
  });

  it("reports metadata failures without falling through to a content request", async () => {
    request.mockResolvedValue({ kind: "response", requestId: "preview", ok: false, error: { code: "FILE", message: "文件不存在", retryable: false } });
    open(target); await settle();
    expect(viewer()).toBeUndefined();
    expect(dialog().props).toMatchObject({ open: true, description: "文件不存在", confirmLabel: "重试" });
    expect(request).toHaveBeenCalledOnce();
  });
});
