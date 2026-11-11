import type { BridgeSlashCommandCatalog } from "@bridge/protocol";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchMobileBack } from "../../lib/mobile-back-navigation.js";
import { SlashCommandInput } from "./SlashCommandInput.js";

interface HookStore {
  slots: any[]; index: number; dirty: boolean;
  effects: Array<{ deps: unknown[] | undefined; cleanup: (() => void) | undefined }>;
  effectIndex: number; pending: Array<() => void>;
}
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
  useId: () => "slash-test",
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
  useLayoutEffect(effect: () => (() => void) | void, deps?: unknown[]) {
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

function elements(node: ReactNode): ReactElement<Record<string, any>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Record<string, any>>;
  return [element, ...elements(element.props.children)];
}
function deferred<T>() {
  let resolve!: (result: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const catalog: BridgeSlashCommandCatalog = {
  sessionId: "A", commands: [
    { name: "review", description: "检查当前变更", argumentHint: "[文件]", aliases: ["check"] },
    { name: "release", description: "准备发布" },
    { name: "team:review", description: "" },
  ],
};
let store: HookStore;
let props: ComponentProps<typeof SlashCommandInput>;
let tree: ReactElement<Record<string, any>>;
let listeners: Map<string, (event: any) => void>;
const textarea = { focus: vi.fn(), setSelectionRange: vi.fn(), selectionStart: 0, selectionEnd: 0 };
class TestNode {}
function draw() {
  for (let i = 0; i < 12; i++) {
    hooks.current = store; store.index = 0; store.effectIndex = 0; store.dirty = false;
    tree = SlashCommandInput(props);
    tree.props.ref.current = { contains: (target: unknown) => target === textarea };
    input().props.ref.current = textarea;
    store.pending.splice(0).forEach(effect => effect());
    if (!store.dirty) return;
  }
  throw new Error("Slash input did not settle");
}
function input() { return elements(tree).find(element => element.type === "textarea")!; }
function options() { return elements(tree).filter(element => element.props.role === "option"); }
function menu() { return elements(tree).find(element => element.props.className === "slash-command-menu"); }
function focus() { input().props.onFocus({ currentTarget: textarea }); draw(); }
function type(value: string, cursor = value.length) {
  textarea.selectionStart = cursor; textarea.selectionEnd = cursor;
  input().props.onChange({ target: { value, selectionStart: cursor, selectionEnd: cursor }, currentTarget: { value, selectionStart: cursor, selectionEnd: cursor } });
  draw();
}
function cursor(position: number) {
  textarea.selectionStart = position; textarea.selectionEnd = position;
  input().props.onSelect({ currentTarget: textarea }); draw();
}
function key(key: string, nativeEvent: Record<string, unknown> = {}) {
  const event = { key, nativeEvent, preventDefault: vi.fn(), stopPropagation: vi.fn() };
  input().props.onKeyDown(event); draw();
  return event;
}
async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); draw(); }
function unmount() { store.effects.forEach(effect => effect.cleanup?.()); }
function mount() {
  store = { slots: [], index: 0, dirty: false, effects: [], effectIndex: 0, pending: [] };
  draw();
}
beforeEach(() => {
  listeners = new Map();
  vi.stubGlobal("Node", TestNode);
  vi.stubGlobal("document", {
    addEventListener: (type: string, callback: (event: any) => void) => listeners.set(type, callback),
    removeEventListener: (type: string, callback: (event: any) => void) => { if (listeners.get(type) === callback) listeners.delete(type); },
  });
  textarea.focus.mockClear(); textarea.setSelectionRange.mockClear();
  textarea.selectionStart = 0; textarea.selectionEnd = 0;
  props = { value: "", onChange: vi.fn(value => { props = { ...props, value }; }), onLoad: vi.fn().mockResolvedValue(catalog), "aria-label": "消息" };
  mount(); focus();
});
afterEach(() => { unmount(); vi.unstubAllGlobals(); });

describe("custom slash command composer", () => {
  it("opens once, filters names and aliases locally, and refreshes after reopening", async () => {
    type("/");
    expect(menu()).toBeDefined();
    expect(elements(tree).some(element => element.props.children === "正在读取会话命令…")).toBe(true);
    await settle();
    expect(options()).toHaveLength(3);
    expect(input().props).toMatchObject({ role: "combobox", "aria-expanded": true, "aria-controls": "slash-test-list" });
    type("/RE"); await settle();
    expect(options()).toHaveLength(2);
    type("/CH"); await settle();
    expect(options()).toHaveLength(1);
    expect(options()[0]!.props.children[0].props.children[0].props.children).toEqual(["/", "review"]);
    expect(props.onLoad).toHaveBeenCalledOnce();
    key("Escape"); expect(menu()).toBeUndefined();
    type("/c"); await settle();
    expect(props.onLoad).toHaveBeenCalledTimes(2);
  });

  it.each(["hello /re", " /re", "/absolute/path", "/re argument", "/re\nprose"])("keeps normal text input for %j", async value => {
    type(value); await settle();
    expect(menu()).toBeUndefined();
    expect(props.onLoad).not.toHaveBeenCalled();
    expect(key("Enter").preventDefault).not.toHaveBeenCalled();
  });

  it.each(["Enter", "Tab"])("consumes %s to insert the active command without submitting", async selectKey => {
    const submit = vi.fn();
    type("/re"); await settle();
    key("ArrowDown");
    const event = key(selectKey);
    if (!event.preventDefault.mock.calls.length) submit();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(submit).not.toHaveBeenCalled();
    expect(props.value).toBe("/release ");
    expect(menu()).toBeUndefined();
    expect(textarea.setSelectionRange).toHaveBeenLastCalledWith(9, 9);
    expect(textarea.focus).toHaveBeenCalled();
    expect(key("Enter").preventDefault).not.toHaveBeenCalled();
  });

  it("wraps arrow navigation and marks the active option accessibly", async () => {
    type("/"); await settle(); key("ArrowUp");
    expect(options().map(option => option.props["aria-selected"])).toEqual([false, false, true]);
    expect(input().props["aria-activedescendant"]).toBe(options()[2]!.props.id);
    key("ArrowDown");
    expect(options()[0]!.props["aria-selected"]).toBe(true);
  });

  it("replaces the whole leading token and preserves arguments and later lines", async () => {
    type("/revOld  file.ts\nkeep this suffix", 4); await settle();
    expect(options()).toHaveLength(1);
    options()[0]!.props.onClick(); draw();
    expect(props.value).toBe("/review  file.ts\nkeep this suffix");
    expect(textarea.setSelectionRange).toHaveBeenLastCalledWith(8, 8);
  });

  it("uses click selection, retains mouse focus, and leaves touch pointer movement unhandled", async () => {
    type("/ch"); await settle();
    const option = options()[0]!;
    expect(option.props.type).toBe("button");
    expect(option.props.onPointerDown).toBeUndefined();
    const mouse = { preventDefault: vi.fn(), button: 0 };
    option.props.onMouseDown(mouse);
    expect(mouse.preventDefault).toHaveBeenCalledOnce();
    expect(props.value).toBe("/ch");
    option.props.onClick(); draw();
    expect(props.value).toBe("/review ");
  });

  it.each(["composition", "isComposing", "229"])("does not select or consume IME confirmation (%s)", async mode => {
    type("/re"); await settle();
    if (mode === "composition") input().props.onCompositionStart();
    const event = key("Enter", mode === "isComposing" ? { isComposing: true } : mode === "229" ? { keyCode: 229 } : {});
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(props.onChange).toHaveBeenCalledTimes(1);
    expect(props.value).toBe("/re");
    if (mode === "composition") input().props.onCompositionEnd();
  });

  it("keeps click selection from replacing an active IME composition", async () => {
    type("/re"); await settle();
    input().props.onCompositionStart();
    options()[0]!.props.onClick(); draw();
    expect(props.value).toBe("/re");
    expect(menu()).toBeDefined();
    input().props.onCompositionEnd();
    options()[0]!.props.onClick(); draw();
    expect(props.value).toBe("/review ");
  });

  it.each(["Escape", "back", "outside"])("closes on %s without changing the draft, and releases Android back", async action => {
    type("/re"); await settle();
    if (action === "Escape") expect(key("Escape").preventDefault).toHaveBeenCalledOnce();
    if (action === "back") { expect(dispatchMobileBack()).toBe(true); draw(); }
    if (action === "outside") { listeners.get("pointerdown")!({ target: new TestNode() }); draw(); }
    expect(menu()).toBeUndefined();
    expect(props.value).toBe("/re");
    expect(dispatchMobileBack()).toBe(false);
    expect(key("Enter").preventDefault).not.toHaveBeenCalled();
  });

  it("closes when the caret enters arguments and reopens when it returns to the token", async () => {
    type("/re arg", 3); await settle();
    expect(menu()).toBeDefined();
    cursor(7); expect(menu()).toBeUndefined();
    cursor(3); await settle();
    expect(menu()).toBeDefined();
    expect(props.onLoad).toHaveBeenCalledTimes(2);
  });

  it("shows empty results and a concise warning without inventing built-in commands", async () => {
    vi.mocked(props.onLoad!).mockResolvedValue({ sessionId: "A", commands: [], warnings: ["部分命令无法读取"] });
    type("/"); await settle();
    expect(options()).toEqual([]);
    expect(elements(tree).some(element => element.props.children === "没有可用的会话命令")).toBe(true);
    expect(elements(tree).find(element => element.props.className === "slash-command-warning")?.props.children.join("")).toBe("部分命令无法读取");
    expect(key("Enter").preventDefault).not.toHaveBeenCalled();
  });

  it.each(["Enter", "Tab"])("preserves normal %s when the prefix has no matching option", async selectKey => {
    type("/no-such-command"); await settle();
    expect(menu()).toBeDefined();
    expect(options()).toHaveLength(0);
    expect(key(selectKey).preventDefault).not.toHaveBeenCalled();
    expect(props.value).toBe("/no-such-command");
  });

  it("surfaces a failed catalog read and refreshes after close", async () => {
    vi.mocked(props.onLoad!).mockRejectedValueOnce(new Error("目录读取被拒绝"));
    type("/"); await settle();
    expect(elements(tree).find(element => element.props.role === "alert")?.props.children).toBe("目录读取被拒绝");
    key("Escape"); type("/r"); await settle();
    expect(options()).toHaveLength(2);
  });

  it("keeps plain textarea behavior without a loader or when disabled", async () => {
    props = { ...props, onLoad: undefined }; draw(); type("/"); await settle();
    expect(menu()).toBeUndefined();
    expect(input().props.role).toBeUndefined();
    expect(key("Enter").preventDefault).not.toHaveBeenCalled();
    props = { ...props, onLoad: vi.fn().mockResolvedValue(catalog), disabled: true }; draw();
    expect(menu()).toBeUndefined();
    expect(props.onLoad).not.toHaveBeenCalled();
  });

  it("does not retain a pending catalog after the host/session key remounts", async () => {
    const old = deferred<BridgeSlashCommandCatalog>();
    vi.mocked(props.onLoad!).mockReturnValueOnce(old.promise);
    type("/");
    unmount();
    props = { ...props, value: "/", onLoad: vi.fn().mockResolvedValue({ sessionId: "B", commands: [{ name: "other", description: "" }] }) };
    mount(); focus(); await settle();
    old.resolve(catalog); await settle();
    expect(options()).toHaveLength(1);
    options()[0]!.props.onClick(); draw();
    expect(props.value).toBe("/other ");
  });

  it("ignores a closed opening's late result after reopening", async () => {
    const old = deferred<BridgeSlashCommandCatalog>();
    vi.mocked(props.onLoad!).mockReturnValueOnce(old.promise);
    type("/"); key("Escape");
    vi.mocked(props.onLoad!).mockResolvedValueOnce({ sessionId: "A", commands: [{ name: "new", description: "" }] });
    type("/n"); await settle();
    old.resolve(catalog); await settle();
    expect(options()).toHaveLength(1);
    key("Enter");
    expect(props.value).toBe("/new ");
  });
});


it("keeps unavailable common commands visible, disabled and out of draft selection", async () => {
  props = { ...props, onLoad: vi.fn().mockResolvedValue({ sessionId: "A", commands: [{ name: "usage", description: "用量", unavailableReason: "当前运行时不支持" }] }) };
  type("/u"); await settle();
  expect(options()[0]!.props.disabled).toBe(true);
  expect(options()[0]!.props["aria-disabled"]).toBe(true);
  key("Enter");
  expect(input().props.value).toBe("/u");
  expect(options()[0]!.props.children[1].props.children).toBe("当前运行时不支持");
});
