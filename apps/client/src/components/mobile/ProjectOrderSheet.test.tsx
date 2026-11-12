import type { BridgeProjectInfo, BridgeSessionInfo } from "@bridge/protocol";
import { createElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectOrderSheet, type ProjectOrderSheetProps } from "./ProjectOrderSheet.js";

interface HookStore {
  slots: any[];
  index: number;
  dirty: boolean;
  effects: Array<{ deps: unknown[] | undefined; cleanup: (() => void) | undefined }>;
  effectIndex: number;
  pending: Array<() => void>;
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

vi.mock("./MobileSheet.js", () => ({
  MobileSheet: ({ title, footer, onClose, children }: {
    title: ReactNode;
    footer?: ReactNode;
    onClose(): void;
    children: ReactNode;
  }) => createElement("section", { "aria-label": title, "data-sheet": "true", onClose }, children, footer),
}));

function elements(node: ReactNode): ReactElement<Record<string, any>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Record<string, any>>;
  return [element, ...elements(element.props.children), ...elements(element.props.footer)];
}

function text(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  return node && typeof node === "object" && "props" in node
    ? text((node as ReactElement<{ children?: ReactNode }>).props.children)
    : "";
}

const projects: BridgeProjectInfo[] = [
  { projectId: "p-alpha", name: "Alpha", cwd: "/work/alpha", sessionCount: 2, runningCount: 0, pendingCount: 0, lastActivityAt: 10 },
  { projectId: "p-beta", name: "Beta", cwd: "/work/beta", sessionCount: 1, runningCount: 0, pendingCount: 0, lastActivityAt: 30 },
  { projectId: "p-gamma", name: "Gamma", cwd: "/work/gamma", sessionCount: 0, runningCount: 0, pendingCount: 0, lastActivityAt: 20 },
];

const baseSession: BridgeSessionInfo = {
  sessionId: "s-1",
  projectId: "p-alpha",
  projectName: "Alpha",
  cwd: "/work/alpha",
  title: "Alpha 1",
  source: "desktop",
  ownership: "DESKTOP_OBSERVED",
  transport: "bridge-host",
  turnState: "idle",
  lastActivityAt: 10,
  pendingCount: 0,
};

const sessions: BridgeSessionInfo[] = [
  baseSession,
  { ...baseSession, sessionId: "s-2", title: "Alpha 2" },
  { ...baseSession, sessionId: "s-archived", title: "Alpha Archived", archivedAt: 5 },
  { ...baseSession, sessionId: "s-3", projectId: "p-beta", projectName: "Beta", cwd: "/work/beta", lastActivityAt: 30 },
];

const ROW_HEIGHT = 56;
const LIST_TOP = 100;

let store: HookStore;
let props: ProjectOrderSheetProps;
let tree: ReactElement<Record<string, any>>;
let capturedPointers: Set<number>;
let vibrateMock: ReturnType<typeof vi.fn>;

function attachListGeometry(currentTree: ReactElement<Record<string, any>>): void {
  const listEl = elements(currentTree).find((el) => el.props.role === "list")!;
  const rowEls = elements(currentTree).filter((el) => el.props.role === "listitem");
  listEl.props.ref.current = {
    children: rowEls.map((_, index) => ({
      getBoundingClientRect: () => ({
        top: LIST_TOP + index * ROW_HEIGHT,
        bottom: LIST_TOP + (index + 1) * ROW_HEIGHT,
        height: ROW_HEIGHT,
        left: 16,
        right: 359,
        width: 343,
      }),
    })),
    setPointerCapture: vi.fn((id: number) => { capturedPointers.add(id); }),
    hasPointerCapture: vi.fn((id: number) => capturedPointers.has(id)),
    releasePointerCapture: vi.fn((id: number) => { capturedPointers.delete(id); }),
  };
}

function draw(): void {
  for (let i = 0; i < 12; i += 1) {
    hooks.current = store;
    store.index = 0;
    store.effectIndex = 0;
    store.dirty = false;
    tree = ProjectOrderSheet(props);
    attachListGeometry(tree);
    store.pending.splice(0).forEach((effect) => effect());
    if (!store.dirty) return;
  }
  throw new Error("ProjectOrderSheet did not settle");
}

function list() {
  return elements(tree).find((el) => el.props.role === "list")!;
}

function rows() {
  return elements(tree).filter((el) => el.props.role === "listitem");
}

function renderedIds(): string[] {
  return rows().map((row) => row.props["data-project-id"] as string);
}

function handleFor(name: string) {
  return elements(tree).find((el) => el.props.label === `拖动「${name}」调整顺序`)!;
}

function buttonByText(label: string) {
  return elements(tree).find((el) => el.type === "button" && text(el.props.children).trim() === label)!;
}

describe("ProjectOrderSheet", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    capturedPointers = new Set();
    vibrateMock = vi.fn(() => true);
    vi.stubGlobal("navigator", { vibrate: vibrateMock });
    store = { slots: [], index: 0, dirty: false, effects: [], effectIndex: 0, pending: [] };
    props = {
      desktopName: "Studio Mac",
      projectOrder: ["p-alpha", "p-beta", "p-gamma"],
      projectsByActivity: ["p-beta", "p-gamma", "p-alpha"],
      projects,
      sessions,
      onPlaceProjects: vi.fn((next: string[]) => {
        props = { ...props, projectOrder: next };
      }),
      onClose: vi.fn(),
    };
    draw();
  });

  afterEach(() => {
    store.effects.forEach((effect) => effect.cleanup?.());
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("renders rows with active session counts and a single drag handle without legacy arrow buttons", () => {
    expect(renderedIds()).toEqual(["p-alpha", "p-beta", "p-gamma"]);
    const rowTexts = rows().map((row) => text(row));
    expect(rowTexts).toEqual(["Alpha2 个会话", "Beta1 个会话", "Gamma0 个会话"]);
    for (const legacyPrefix of ["置顶「", "上移「", "下移「"]) {
      expect(elements(tree).some((el) => String(el.props.label ?? "").startsWith(legacyPrefix))).toBe(false);
    }
    expect(elements(tree).filter((el) => el.props.className === "project-order-handle")).toHaveLength(3);
  });

  it("reorders immediately via the drag handle with live preview and commits once on pointerup", () => {
    // Row midpoints: index 0 = 128, index 1 = 184, index 2 = 240.
    handleFor("Alpha").props.onPointerDown({
      pointerId: 1,
      pointerType: "mouse",
      button: 0,
      clientX: 330,
      clientY: 128,
      stopPropagation: vi.fn(),
    });
    draw();
    expect(rows()[0]!.props.className).toContain("is-dragging");
    expect(list().props.className).toContain("is-dragging");
    expect(vibrateMock).not.toHaveBeenCalled();

    // Move past Beta's midpoint (184) -> live preview becomes [Beta, Alpha, Gamma].
    list().props.onPointerMove({ pointerId: 1, clientX: 330, clientY: 192 });
    draw();
    expect(renderedIds()).toEqual(["p-beta", "p-alpha", "p-gamma"]);
    expect(props.onPlaceProjects).not.toHaveBeenCalled();

    // Move past Gamma's midpoint (240) and out of bounds below -> clamps to index 2.
    list().props.onPointerMove({ pointerId: 1, clientX: 330, clientY: 420 });
    draw();
    expect(renderedIds()).toEqual(["p-beta", "p-gamma", "p-alpha"]);
    expect(props.onPlaceProjects).not.toHaveBeenCalled();

    // Release -> persists once.
    list().props.onPointerUp({ pointerId: 1 });
    draw();
    expect(props.onPlaceProjects).toHaveBeenCalledTimes(1);
    expect(props.onPlaceProjects).toHaveBeenCalledWith(["p-beta", "p-gamma", "p-alpha"]);
    expect(list().props.className).not.toContain("is-dragging");
  });

  it("activates drag after a 220ms row long-press with haptic feedback, and clamps upward drag at index 0", () => {
    rows()[2]!.props.onPointerDown({
      pointerId: 7,
      pointerType: "touch",
      button: 0,
      clientX: 120,
      clientY: 240,
    });
    vi.advanceTimersByTime(219);
    draw();
    expect(list().props.className).not.toContain("is-dragging");
    expect(vibrateMock).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    draw();
    expect(list().props.className).toContain("is-dragging");
    expect(rows()[2]!.props.className).toContain("is-dragging");
    expect(vibrateMock).toHaveBeenCalledWith(10);

    // Drag well above the top boundary -> clamps cleanly to index 0.
    list().props.onPointerMove({ pointerId: 7, clientX: 120, clientY: 10 });
    draw();
    expect(renderedIds()).toEqual(["p-gamma", "p-alpha", "p-beta"]);

    list().props.onPointerUp({ pointerId: 7 });
    draw();
    expect(props.onPlaceProjects).toHaveBeenCalledExactlyOnceWith(["p-gamma", "p-alpha", "p-beta"]);
  });

  it("cancels pending long-press when the finger scrolls more than 8px before 220ms", () => {
    rows()[0]!.props.onPointerDown({
      pointerId: 3,
      pointerType: "touch",
      button: 0,
      clientX: 100,
      clientY: 128,
    });
    vi.advanceTimersByTime(100);
    list().props.onPointerMove({ pointerId: 3, clientX: 100, clientY: 142 });
    vi.advanceTimersByTime(200);
    draw();

    expect(list().props.className).not.toContain("is-dragging");
    expect(vibrateMock).not.toHaveBeenCalled();
    list().props.onPointerUp({ pointerId: 3 });
    expect(props.onPlaceProjects).not.toHaveBeenCalled();

    // Pointer leaving the list before 220ms also cancels pending long-press.
    rows()[1]!.props.onPointerDown({
      pointerId: 5,
      pointerType: "touch",
      button: 0,
      clientX: 100,
      clientY: 158,
    });
    vi.advanceTimersByTime(80);
    list().props.onPointerLeave();
    vi.advanceTimersByTime(200);
    draw();
    expect(list().props.className).not.toContain("is-dragging");
    expect(vibrateMock).not.toHaveBeenCalled();
  });

  it("reverts preview order without persisting on pointercancel, lostpointercapture, or Escape", () => {
    for (const cancel of ["pointercancel", "lostpointercapture", "Escape"] as const) {
      handleFor("Alpha").props.onPointerDown({
        pointerId: 9,
        pointerType: "touch",
        button: 0,
        clientX: 320,
        clientY: 128,
        stopPropagation: vi.fn(),
      });
      draw();
      list().props.onPointerMove({ pointerId: 9, clientX: 320, clientY: 250 });
      draw();
      expect(renderedIds()).toEqual(["p-beta", "p-gamma", "p-alpha"]);

      if (cancel === "pointercancel") list().props.onPointerCancel({ pointerId: 9 });
      else if (cancel === "lostpointercapture") list().props.onLostPointerCapture({
        pointerId: 9, target: list().props.ref.current, currentTarget: list().props.ref.current,
      });
      else list().props.onKeyDown({ key: "Escape", preventDefault: vi.fn(), stopPropagation: vi.fn() });
      draw();

      expect(renderedIds()).toEqual(["p-alpha", "p-beta", "p-gamma"]);
      expect(list().props.className).not.toContain("is-dragging");
      expect(props.onPlaceProjects).not.toHaveBeenCalled();
    }
  });

  it("keeps a touch long-press active when child implicit capture transfers to the list", () => {
    rows()[0]!.props.onPointerDown({ pointerId: 12, pointerType: "touch", button: 0, clientX: 100, clientY: 128 });
    list().props.onPointerMove({ pointerId: 12, clientX: 101, clientY: 128 });
    vi.advanceTimersByTime(220);
    draw();
    expect(list().props.className).toContain("is-dragging");
    list().props.onLostPointerCapture({
      pointerId: 12,
      target: { tagName: "STRONG" },
      currentTarget: list().props.ref.current,
    });
    draw();
    expect(list().props.className).toContain("is-dragging");
    list().props.onPointerMove({ pointerId: 12, clientX: 101, clientY: 250 });
    draw();
    list().props.onPointerUp({ pointerId: 12 });
    expect(props.onPlaceProjects).toHaveBeenCalledExactlyOnceWith(["p-beta", "p-gamma", "p-alpha"]);
  });

  it("offers native position selection through a screen reader's default click activation", () => {
    expect(handleFor("Alpha").props.onClick).toBeTypeOf("function");
    handleFor("Alpha").props.onClick({ detail: 0 });
    draw();
    const select = elements(tree).find((el) => el.type === "select")!;
    expect(select.props["aria-label"]).toBe("移动「Alpha」到");
    expect(select.props.value).toBe(0);
    select.props.onChange({ target: { value: "2" } });
    draw();
    expect(renderedIds()).toEqual(["p-beta", "p-gamma", "p-alpha"]);
    expect(props.onPlaceProjects).toHaveBeenCalledExactlyOnceWith(["p-beta", "p-gamma", "p-alpha"]);
  });

  it("does not persist when dropped back at the starting position", () => {
    handleFor("Beta").props.onPointerDown({
      pointerId: 4,
      pointerType: "mouse",
      button: 0,
      clientX: 320,
      clientY: 184,
      stopPropagation: vi.fn(),
    });
    draw();
    list().props.onPointerMove({ pointerId: 4, clientX: 320, clientY: 250 });
    draw();
    expect(renderedIds()).toEqual(["p-alpha", "p-gamma", "p-beta"]);

    list().props.onPointerMove({ pointerId: 4, clientX: 320, clientY: 180 });
    draw();
    expect(renderedIds()).toEqual(["p-alpha", "p-beta", "p-gamma"]);

    list().props.onPointerUp({ pointerId: 4 });
    draw();
    expect(props.onPlaceProjects).not.toHaveBeenCalled();
  });

  it("supports keyboard ArrowUp, ArrowDown, Home, and End on the drag handle", () => {
    const focus = vi.fn();
    handleFor("Alpha").props.onKeyDown({ key: "ArrowUp", preventDefault: vi.fn(), currentTarget: { focus } });
    expect(props.onPlaceProjects).not.toHaveBeenCalled();

    handleFor("Alpha").props.onKeyDown({ key: "ArrowDown", preventDefault: vi.fn(), currentTarget: { focus } });
    draw();
    expect(renderedIds()).toEqual(["p-beta", "p-alpha", "p-gamma"]);

    handleFor("Alpha").props.onKeyDown({ key: "End", preventDefault: vi.fn(), currentTarget: { focus } });
    draw();
    expect(renderedIds()).toEqual(["p-beta", "p-gamma", "p-alpha"]);

    handleFor("Alpha").props.onKeyDown({ key: "Home", preventDefault: vi.fn(), currentTarget: { focus } });
    draw();
    expect(renderedIds()).toEqual(["p-alpha", "p-beta", "p-gamma"]);
  });

  it("sorts by recent activity via footer button and disables it once already aligned", () => {
    const sortBtn = buttonByText("按最近活动重排");
    expect(sortBtn.props.disabled).toBe(false);
    sortBtn.props.onClick();
    draw();
    expect(props.onPlaceProjects).toHaveBeenCalledExactlyOnceWith(["p-beta", "p-gamma", "p-alpha"]);
    expect(buttonByText("按最近活动重排").props.disabled).toBe(true);

    buttonByText("完成").props.onClick();
    expect(props.onClose).toHaveBeenCalledOnce();
  });
});
