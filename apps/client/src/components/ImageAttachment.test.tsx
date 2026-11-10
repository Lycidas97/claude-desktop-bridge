import type { BridgeHistoryAttachment, BridgeResponse } from "@bridge/protocol";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImageAttachment } from "./ImageAttachment.js";
import { MediaPreviewProvider } from "./MediaPreviewProvider.js";

const hooks = vi.hoisted(() => ({
  slots: [] as any[], index: 0, dirty: false, effectIndex: 0,
  effects: [] as Array<{ deps: unknown[]; cleanup: (() => void) | undefined }>, pending: [] as Array<() => void>,
  observers: [] as Array<{ callback: (entries: Array<{ isIntersecting: boolean }>) => void; disconnect: ReturnType<typeof vi.fn> }>,
  request: vi.fn(), open: vi.fn(), createUrl: vi.fn(), revokeUrl: vi.fn(),
  readThumbnail: undefined as unknown as (read: () => Promise<void>) => void,
}));
vi.mock("./MediaPreviewProvider.js", async original => ({
  ...await original<typeof import("./MediaPreviewProvider.js")>(),
  useMediaPreview: () => hooks.open, useMediaRequest: () => hooks.request, useThumbnailRead: () => hooks.readThumbnail,
}));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useState(initial: any) {
    const index = hooks.index++;
    const slots = hooks.slots;
    if (!(index in slots)) slots[index] = initial;
    return [slots[index], (value: any) => {
      const next = typeof value === "function" ? value(slots[index]) : value;
      if (!Object.is(next, slots[index])) hooks.dirty = true;
      slots[index] = next;
    }];
  },
  useRef(initial: unknown) {
    const index = hooks.index++;
    return hooks.slots[index] ??= { current: initial };
  },
  useCallback: (callback: unknown) => callback,
  useMemo(create: () => unknown, deps: unknown[]) {
    const index = hooks.index++;
    const previous = hooks.slots[index];
    if (!previous || deps.some((dep, i) => !Object.is(dep, previous.deps[i]))) hooks.slots[index] = { deps, value: create() };
    return hooks.slots[index].value;
  },
  useEffect(effect: () => (() => void) | void, deps: unknown[]) {
    const index = hooks.effectIndex++;
    const previous = hooks.effects[index];
    if (previous && deps.every((dep, i) => Object.is(dep, previous.deps[i]))) return;
    hooks.pending.push(() => {
      previous?.cleanup?.();
      hooks.effects[index] = { deps, cleanup: effect() || undefined };
    });
  },
}));
const attachment: BridgeHistoryAttachment = {
  id: "native-image:uuid:4", name: "photo.png", mimeType: "image/png", size: 5,
  nativeImage: { messageUuid: "uuid", imageIndex: 4 },
};
let current: BridgeHistoryAttachment;
let tree: ReactElement<Record<string, any>>;
function draw() {
  for (let i = 0; i < 8; i++) {
    hooks.index = 0; hooks.effectIndex = 0; hooks.dirty = false;
    tree = ImageAttachment({ attachment: current, sessionId: "session" });
    tree.props.ref.current = {};
    hooks.pending.splice(0).forEach(effect => effect());
    if (!hooks.dirty) return;
  }
  throw new Error("Image attachment did not settle");
}
async function settle() { for (let i = 0; i < 20; i++) await Promise.resolve(); draw(); }
const response = (result: unknown): BridgeResponse => ({ kind: "response", requestId: "test", ok: true, result });
function transferResponse(method: string) {
  if (method === "artifact.transfer.read") return response({ chunk: { transferId: "lease", index: 0, data: btoa("image") } });
  return response({ transfer: { transferId: "lease", size: 5, chunkBytes: 8, mimeType: "image/png" } });
}
function cleanup() { hooks.effects.forEach(effect => effect.cleanup?.()); hooks.effects = []; }
beforeEach(() => {
  hooks.slots = []; hooks.effects = []; hooks.pending = []; hooks.observers = []; hooks.index = 0;
  const provider = MediaPreviewProvider({ request: hooks.request, children: null });
  hooks.readThumbnail = provider.props.value.readThumbnail;
  hooks.slots = [];
  hooks.request.mockReset().mockImplementation(async (method: string) => transferResponse(method));
  hooks.open.mockReset(); hooks.createUrl.mockReset().mockReturnValue("blob:thumbnail"); hooks.revokeUrl.mockReset();
  vi.spyOn(URL, "createObjectURL").mockImplementation(hooks.createUrl);
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(hooks.revokeUrl);
  vi.stubGlobal("IntersectionObserver", class {
    disconnect = vi.fn();
    constructor(public callback: (entries: Array<{ isIntersecting: boolean }>) => void) { hooks.observers.push(this); }
    observe() {}
  });
  current = attachment;
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("ImageAttachment", () => {
  it("uses local image bytes immediately and opens the existing viewer without a transfer", () => {
    current = { ...attachment, data: btoa("image") };
    draw();
    expect(tree.props.children.props.src).toBe(`data:image/png;base64,${current.data}`);
    tree.props.onClick();
    expect(hooks.open).toHaveBeenCalledWith(expect.objectContaining({ dataUrl: `data:image/png;base64,${current.data}` }));
    expect(hooks.observers).toHaveLength(0);
    expect(hooks.request).not.toHaveBeenCalled();
  });

  it("loads a visible native thumbnail in chunks, closes the lease and reuses its URL in the viewer", async () => {
    draw();
    expect(tree.props["aria-busy"]).toBe(true);
    expect(hooks.request).not.toHaveBeenCalled();
    hooks.observers[0]!.callback([{ isIntersecting: false }]);
    expect(hooks.request).not.toHaveBeenCalled();
    hooks.observers[0]!.callback([{ isIntersecting: true }]);
    await settle();
    expect(hooks.request.mock.calls.map(([method, params]) => [method, params])).toEqual([
      ["artifact.transfer.open", { sessionId: "session", nativeImage: attachment.nativeImage }],
      ["artifact.transfer.read", { transferId: "lease", index: 0 }],
      ["artifact.transfer.close", { transferId: "lease" }],
    ]);
    expect(tree.props.children.props.src).toBe("blob:thumbnail");
    tree.props.onClick();
    expect(hooks.open).toHaveBeenCalledWith(expect.objectContaining({ nativeImage: attachment.nativeImage, dataUrl: "blob:thumbnail" }));
    cleanup();
    expect(hooks.revokeUrl).toHaveBeenCalledWith("blob:thumbnail");
  });

  it("loads five simultaneously visible images within the existing four-transfer owner cap", async () => {
    const active = new Set<string>();
    const reads: Array<() => void> = [];
    const closes: Array<() => void> = [];
    let opened = 0;
    let rejected = 0;
    hooks.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === "artifact.transfer.open") {
        if (active.size >= 4) { rejected += 1; return { kind: "response", requestId: "test", ok: false, error: { code: "TRANSFER_LIMIT", message: "Too many transfers" } }; }
        const transferId = `lease-${opened++}`; active.add(transferId);
        return response({ transfer: { transferId, size: 5, chunkBytes: 8, mimeType: "image/png" } });
      }
      if (method === "artifact.transfer.read") {
        await new Promise<void>(resolve => reads.push(resolve));
        return response({ chunk: { transferId: params.transferId, index: 0, data: btoa("image") } });
      }
      await new Promise<void>(resolve => closes.push(resolve));
      active.delete(String(params.transferId));
      return response({ closed: true });
    });
    const images = Array.from({ length: 5 }, (_, imageIndex) => {
      hooks.slots = []; hooks.effects = [];
      current = { ...attachment, nativeImage: { messageUuid: "uuid", imageIndex } };
      draw();
      return { slots: hooks.slots, effects: hooks.effects, attachment: current };
    });
    hooks.observers.forEach(observer => observer.callback([{ isIntersecting: true }]));
    for (let step = 0; step < 16; step++) {
      for (let tick = 0; tick < 20; tick++) await Promise.resolve();
      reads.splice(0).forEach(resolve => resolve());
      closes.splice(0).forEach(resolve => resolve());
    }
    const states = images.map(image => {
      hooks.slots = image.slots; hooks.effects = image.effects; current = image.attachment; draw();
      return tree.props["aria-label"];
    });
    images.forEach(image => image.effects.forEach(effect => effect.cleanup?.()));
    hooks.effects = [];
    expect(rejected).toBe(0);
    expect(opened).toBe(5);
    expect(hooks.createUrl).toHaveBeenCalledTimes(5);
    expect(states.every(label => label === "查看 photo.png")).toBe(true);
    expect(active.size).toBe(0);
  });

  it("opens an offscreen native image on demand without using a project path", () => {
    draw(); tree.props.onClick();
    expect(hooks.open).toHaveBeenCalledWith({ name: "photo.png", kind: "image", sessionId: "session", nativeImage: attachment.nativeImage });
    expect(hooks.request).not.toHaveBeenCalled();
  });

  it("offers a small retry control after a transfer failure", async () => {
    hooks.request.mockResolvedValueOnce({ kind: "response", requestId: "test", ok: false, error: { code: "NOT_FOUND", message: "图片不可用" } });
    draw(); hooks.observers[0]!.callback([{ isIntersecting: true }]); await settle();
    expect(tree.props["aria-label"]).toBe("重试 photo.png");
    expect(tree.props.title).toBe("图片不可用");
    tree.props.onClick(); draw(); hooks.observers.at(-1)!.callback([{ isIntersecting: true }]); await settle();
    expect(tree.props["aria-label"]).toBe("查看 photo.png");
    expect(tree.props.children.props.src).toBe("blob:thumbnail");
  });

  it("closes an open transfer when its thumbnail unmounts before open finishes", async () => {
    let resolve!: (value: BridgeResponse) => void;
    hooks.request.mockImplementationOnce(() => new Promise<BridgeResponse>(yes => { resolve = yes; }));
    draw(); hooks.observers[0]!.callback([{ isIntersecting: true }]);
    await Promise.resolve(); cleanup();
    resolve(transferResponse("artifact.transfer.open"));
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(hooks.request.mock.calls.map(([method]) => method)).toEqual(["artifact.transfer.open", "artifact.transfer.close"]);
    expect(hooks.createUrl).not.toHaveBeenCalled();
  });
});
