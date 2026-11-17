import type { BridgeProjectInfo, BridgeSessionInfo } from "@bridge/protocol";
import type { PointerEvent as ReactPointerEvent } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  UNSECTIONED_DROP_ID,
  formatSessionDragBadge,
  isInteractiveDragExclusion,
  useSessionSectionDrag,
  type UseSessionSectionDragOptions,
} from "./useSessionSectionDrag.js";

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
}));

class FakeListenerTarget {
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
    const event = {
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
      listener(event);
    }
    return { prevented, stopped };
  }
}

const manualSections: BridgeProjectInfo[] = [
  {
    projectId: "sec-work",
    name: "工作项目",
    kind: "desktop-group",
    cwd: "/tmp/work",
    sessionCount: 1,
    runningCount: 0,
    pendingCount: 0,
    lastActivityAt: 10,
  },
  {
    projectId: "sec-research",
    name: "调研分组",
    kind: "desktop-group",
    cwd: "/tmp/research",
    sessionCount: 0,
    runningCount: 0,
    pendingCount: 0,
    lastActivityAt: 5,
  },
];

function makeSession(overrides: Partial<BridgeSessionInfo> = {}): BridgeSessionInfo {
  return {
    sessionId: "sess-1",
    projectId: "sec-work",
    projectName: "工作项目",
    cwd: "/tmp/work",
    title: "重构客户端菜单",
    source: "desktop",
    ownership: "DESKTOP_NATIVE_IDLE",
    transport: "claude-desktop-native",
    turnState: "idle",
    lastActivityAt: 10,
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

describe("useSessionSectionDrag", () => {
  let fakeWindow: FakeListenerTarget & { innerWidth: number; innerHeight: number };
  let fakeDoc: FakeListenerTarget & {
    visibilityState: string;
    body: { classList: { add(c: string): void; remove(c: string): void; contains(c: string): boolean } };
    elementFromPoint(x: number, y: number): { closest(selector: string): { getAttribute(attr: string): string | null } | null } | null;
  };
  let hoveredSectionAtPoint: string | undefined;
  let vibrateSpy: ReturnType<typeof vi.fn>;
  let currentOptions: UseSessionSectionDragOptions;

  function renderHook() {
    hooks.index = 0;
    hooks.effectIndex = 0;
    const ctrl = useSessionSectionDrag(currentOptions);
    hooks.pending.splice(0).forEach((fn) => fn());
    return ctrl;
  }

  function rowHitTarget() {
    return {
      closest(selector: string) {
        if (selector.includes("button:not(.session-row-hit)")) return null;
        return null;
      },
    } as unknown as EventTarget;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    hooks.slots = [];
    hooks.effects = [];
    hooks.pending = [];
    hoveredSectionAtPoint = undefined;
    vibrateSpy = vi.fn();

    fakeWindow = Object.assign(new FakeListenerTarget(), { innerWidth: 1280, innerHeight: 800 });
    const bodyClasses = new Set<string>();
    fakeDoc = Object.assign(new FakeListenerTarget(), {
      visibilityState: "visible",
      body: {
        classList: {
          add: (c: string) => { bodyClasses.add(c); },
          remove: (c: string) => { bodyClasses.delete(c); },
          contains: (c: string) => bodyClasses.has(c),
        },
      },
      elementFromPoint: () => (
        hoveredSectionAtPoint
          ? {
              closest: (selector: string) => (
                selector === "[data-drop-section-id]"
                  ? { getAttribute: () => hoveredSectionAtPoint! }
                  : null
              ),
            }
          : null
      ),
    });

    vi.stubGlobal("window", fakeWindow);
    vi.stubGlobal("document", fakeDoc);
    vi.stubGlobal("navigator", { vibrate: vibrateSpy });
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    currentOptions = {
      hostOnline: true,
      capabilities: ["section.move.v1"],
      manualSections,
      onMoveSessionSection: vi.fn(),
    };
  });

  afterEach(() => {
    hooks.effects.forEach((entry) => entry.cleanup?.());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("ignores micro-clicks (<6px), activates mouse drag at >=6px, suppresses ensuing click, and moves to target section", () => {
    const onMove = vi.fn();
    currentOptions.onMoveSessionSection = onMove;
    const session = makeSession();

    let ctrl = renderHook();
    expect(ctrl.canMoveToSection(session)).toBe(true);

    // Micro-click (3px) does NOT activate drag or suppress click
    ctrl.onSessionPointerDown(session, {
      pointerId: 1,
      pointerType: "mouse",
      button: 0,
      clientX: 100,
      clientY: 100,
      target: rowHitTarget(),
    } as unknown as ReactPointerEvent<HTMLElement>);
    fakeWindow.dispatch("pointermove", { pointerId: 1, clientX: 103, clientY: 100 });
    ctrl = renderHook();
    expect(ctrl.dragState).toBeUndefined();
    fakeWindow.dispatch("pointerup", { pointerId: 1, clientX: 103, clientY: 100 });
    expect(fakeWindow.dispatch("click").prevented).toBe(false);
    expect(onMove).not.toHaveBeenCalled();

    // Real mouse drag (>= 6px)
    ctrl.onSessionPointerDown(session, {
      pointerId: 2,
      pointerType: "mouse",
      button: 0,
      clientX: 100,
      clientY: 100,
      target: rowHitTarget(),
    } as unknown as ReactPointerEvent<HTMLElement>);
    hoveredSectionAtPoint = "sec-work";
    fakeWindow.dispatch("pointermove", { pointerId: 2, clientX: 108, clientY: 100 });
    ctrl = renderHook();
    expect(ctrl.dragState?.session.sessionId).toBe("sess-1");
    expect(fakeDoc.body.classList.contains("is-session-dragging")).toBe(true);
    expect(ctrl.dropZoneState("sec-work")).toBe("origin");
    expect(formatSessionDragBadge(ctrl.dragState!, manualSections)).toBe("拖动到目标分组");

    hoveredSectionAtPoint = "sec-research";
    fakeWindow.dispatch("pointermove", { pointerId: 2, clientX: 112, clientY: 220 });
    ctrl = renderHook();
    expect(ctrl.dropZoneState("sec-research")).toBe("target");
    expect(formatSessionDragBadge(ctrl.dragState!, manualSections)).toBe("移动到「调研分组」");

    fakeWindow.dispatch("pointerup", { pointerId: 2, clientX: 112, clientY: 220 });
    ctrl = renderHook();
    expect(ctrl.dragState).toBeUndefined();
    expect(fakeDoc.body.classList.contains("is-session-dragging")).toBe(false);
    expect(onMove).toHaveBeenCalledExactlyOnceWith("sess-1", "sec-research");

    // Post-drop synthetic click is suppressed once
    const suppressed = fakeWindow.dispatch("click");
    expect(suppressed.prevented).toBe(true);
    expect(suppressed.stopped).toBe(true);
    expect(fakeWindow.dispatch("click").prevented).toBe(false);
  });

  it("cancels touch drag immediately when scrolling (>8px before 320ms) and activates on 320ms hold to drop onto __unsectioned__", () => {
    const onMove = vi.fn();
    currentOptions.onMoveSessionSection = onMove;
    const session = makeSession();
    let ctrl = renderHook();

    // Scroll gesture (>8px before 320ms): cancels cleanly without locking touchmove
    ctrl.onSessionPointerDown(session, {
      pointerId: 10,
      pointerType: "touch",
      button: 0,
      clientX: 50,
      clientY: 100,
      target: rowHitTarget(),
    } as unknown as ReactPointerEvent<HTMLElement>);
    fakeWindow.dispatch("pointermove", { pointerId: 10, clientX: 50, clientY: 115 });
    vi.advanceTimersByTime(350);
    ctrl = renderHook();
    expect(ctrl.dragState).toBeUndefined();
    expect(vibrateSpy).not.toHaveBeenCalled();
    expect(fakeWindow.dispatch("touchmove").prevented).toBe(false);

    // Long-press hold (320ms within 8px): activates, vibrates, locks touchmove, drops onto __unsectioned__
    hoveredSectionAtPoint = UNSECTIONED_DROP_ID;
    ctrl.onSessionPointerDown(session, {
      pointerId: 11,
      pointerType: "touch",
      button: 0,
      clientX: 60,
      clientY: 120,
      target: rowHitTarget(),
    } as unknown as ReactPointerEvent<HTMLElement>);
    vi.advanceTimersByTime(320);
    ctrl = renderHook();
    expect(ctrl.dragState?.hoveredTargetId).toBe(UNSECTIONED_DROP_ID);
    expect(vibrateSpy).toHaveBeenCalledWith(12);
    expect(fakeWindow.dispatch("touchmove").prevented).toBe(true);
    expect(formatSessionDragBadge(ctrl.dragState!, manualSections)).toBe("移出到未分组");

    fakeWindow.dispatch("pointerup", { pointerId: 11, clientX: 60, clientY: 360 });
    ctrl = renderHook();
    expect(onMove).toHaveBeenCalledExactlyOnceWith("sess-1", null);
    expect(fakeWindow.dispatch("touchmove").prevented).toBe(false);
  });

  it("excludes nested interactive buttons (chevron / ... menu) while allowing .session-row-hit, and cleans up on Escape / cancel / disconnect", () => {
    const onMove = vi.fn();
    currentOptions.onMoveSessionSection = onMove;
    const session = makeSession();
    let ctrl = renderHook();

    const menuButtonTarget = {
      closest: (selector: string) => (selector.includes("button:not(.session-row-hit)") ? {} : null),
    } as unknown as EventTarget;
    expect(isInteractiveDragExclusion(menuButtonTarget)).toBe(true);
    expect(isInteractiveDragExclusion(rowHitTarget())).toBe(false);

    // Non-primary mouse button is ignored
    ctrl.onSessionPointerDown(session, {
      pointerId: 20,
      pointerType: "mouse",
      button: 2,
      clientX: 10,
      clientY: 10,
      target: rowHitTarget(),
    } as unknown as ReactPointerEvent<HTMLElement>);
    fakeWindow.dispatch("pointermove", { pointerId: 20, clientX: 40, clientY: 40 });
    expect(renderHook().dragState).toBeUndefined();

    // Escape cancels active drag and restores body class
    hoveredSectionAtPoint = "sec-research";
    ctrl.onSessionPointerDown(session, {
      pointerId: 21,
      pointerType: "mouse",
      button: 0,
      clientX: 10,
      clientY: 10,
      target: rowHitTarget(),
    } as unknown as ReactPointerEvent<HTMLElement>);
    fakeWindow.dispatch("pointermove", { pointerId: 21, clientX: 30, clientY: 30 });
    expect(renderHook().dragState).toBeDefined();
    expect(fakeDoc.body.classList.contains("is-session-dragging")).toBe(true);

    fakeWindow.dispatch("keydown", { key: "Escape" });
    ctrl = renderHook();
    expect(ctrl.dragState).toBeUndefined();
    expect(fakeDoc.body.classList.contains("is-session-dragging")).toBe(false);
    expect(onMove).not.toHaveBeenCalled();

    // Host disconnect cancels active drag immediately
    ctrl.onSessionPointerDown(session, {
      pointerId: 22,
      pointerType: "mouse",
      button: 0,
      clientX: 10,
      clientY: 10,
      target: rowHitTarget(),
    } as unknown as ReactPointerEvent<HTMLElement>);
    fakeWindow.dispatch("pointermove", { pointerId: 22, clientX: 30, clientY: 30 });
    expect(renderHook().dragState).toBeDefined();
    currentOptions = { ...currentOptions, hostOnline: false };
    renderHook();
    ctrl = renderHook();
    expect(ctrl.dragState).toBeUndefined();
    expect(fakeDoc.body.classList.contains("is-session-dragging")).toBe(false);
  });
});
