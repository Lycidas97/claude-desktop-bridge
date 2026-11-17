import type { BridgeProjectInfo, BridgeSessionInfo } from "@bridge/protocol";
import {
  createElement,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactPortal,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

export const UNSECTIONED_DROP_ID = "__unsectioned__";

const MOUSE_DRAG_DISTANCE_PX = 6;
const TOUCH_CANCEL_DISTANCE_PX = 8;
const TOUCH_LONG_PRESS_MS = 320;
const AUTO_SCROLL_EDGE_PX = 48;
const AUTO_SCROLL_MAX_STEP_PX = 10;
const CLICK_SUPPRESS_WINDOW_MS = 80;

export interface SessionSectionDragState {
  session: BridgeSessionInfo;
  originSectionId: string;
  clientX: number;
  clientY: number;
  hoveredTargetId: string | undefined;
}

export interface UseSessionSectionDragOptions {
  hostOnline: boolean;
  capabilities: readonly string[] | undefined;
  manualSections: readonly BridgeProjectInfo[];
  scrollContainerRef?: RefObject<HTMLElement | null> | undefined;
  onMoveSessionSection?: ((sessionId: string, sectionId: string | null) => Promise<void> | void) | undefined;
}

export interface SessionSectionDragController {
  dragState: SessionSectionDragState | undefined;
  canMoveToSection(session: BridgeSessionInfo): boolean;
  originSectionFor(session: BridgeSessionInfo): string;
  dropZoneState(dropSectionId: string | undefined): "target" | "origin" | undefined;
  onSessionPointerDown(session: BridgeSessionInfo, event: ReactPointerEvent<HTMLElement>): void;
  cancel(): void;
}

export function resolveDropSectionIdAtPoint(clientX: number, clientY: number): string | undefined {
  if (typeof document === "undefined" || typeof document.elementFromPoint !== "function") {
    return undefined;
  }
  const hit = document.elementFromPoint(clientX, clientY);
  const zone = hit && typeof hit.closest === "function"
    ? hit.closest("[data-drop-section-id]")
    : null;
  const raw = zone?.getAttribute("data-drop-section-id");
  return raw ? raw : undefined;
}

export function isInteractiveDragExclusion(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== "function") return false;
  return Boolean(
    (target as Element).closest(
      "button:not(.session-row-hit), a, input, textarea, select, [data-no-session-drag]",
    ),
  );
}

interface ActiveGesture {
  pointerId: number;
  pointerType: string;
  session: BridgeSessionInfo;
  originSectionId: string;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  active: boolean;
  hoveredTargetId: string | undefined;
  longPressTimer: ReturnType<typeof setTimeout> | undefined;
  rafId: number | undefined;
  cleanupListeners: (() => void) | undefined;
  cleanupTouchLock: (() => void) | undefined;
}

export function useSessionSectionDrag(
  options: UseSessionSectionDragOptions,
): SessionSectionDragController {
  const latestRef = useRef(options);
  latestRef.current = options;

  const [dragState, setDragState] = useState<SessionSectionDragState | undefined>(undefined);
  const gestureRef = useRef<ActiveGesture | undefined>(undefined);
  const clickSuppressCleanupRef = useRef<(() => void) | undefined>(undefined);

  function originSectionFor(session: BridgeSessionInfo): string {
    const { manualSections } = latestRef.current;
    return manualSections.some((section) => section.projectId === session.projectId)
      ? session.projectId
      : UNSECTIONED_DROP_ID;
  }

  function canMoveToSection(session: BridgeSessionInfo): boolean {
    const { hostOnline, capabilities, manualSections, onMoveSessionSection } = latestRef.current;
    if (!hostOnline || !onMoveSessionSection || session.archivedAt) return false;
    if (!capabilities?.includes("section.move.v1")) return false;
    if (!session.allowedActions?.canMoveSection) return false;
    return manualSections.length > 0 || manualSections.some((s) => s.projectId === session.projectId);
  }

  function setBodyDraggingClass(enabled: boolean): void {
    if (typeof document === "undefined" || !document.body) return;
    if (enabled) {
      document.body.classList.add("is-session-dragging");
    } else {
      document.body.classList.remove("is-session-dragging");
    }
  }

  function teardownGesture(): void {
    const gesture = gestureRef.current;
    gestureRef.current = undefined;
    if (gesture) {
      if (gesture.longPressTimer !== undefined) {
        clearTimeout(gesture.longPressTimer);
        gesture.longPressTimer = undefined;
      }
      if (gesture.rafId !== undefined && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(gesture.rafId);
        gesture.rafId = undefined;
      }
      gesture.cleanupTouchLock?.();
      gesture.cleanupTouchLock = undefined;
      gesture.cleanupListeners?.();
      gesture.cleanupListeners = undefined;
    }
    setBodyDraggingClass(false);
    setDragState((current) => (current === undefined ? current : undefined));
  }

  function installPostDropClickSuppressor(): void {
    if (typeof window === "undefined") return;
    clickSuppressCleanupRef.current?.();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const handleCaptureClick = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
      cleanup();
    };
    const cleanup = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      window.removeEventListener("click", handleCaptureClick, true);
      if (clickSuppressCleanupRef.current === cleanup) {
        clickSuppressCleanupRef.current = undefined;
      }
    };
    window.addEventListener("click", handleCaptureClick, true);
    timer = setTimeout(cleanup, CLICK_SUPPRESS_WINDOW_MS);
    clickSuppressCleanupRef.current = cleanup;
  }

  function computeAutoScrollDelta(container: HTMLElement, clientY: number): number {
    const rect = container.getBoundingClientRect();
    if (rect.height <= 0) return 0;
    if (clientY < rect.top + AUTO_SCROLL_EDGE_PX && clientY >= rect.top - 40) {
      const ratio = Math.min(1, (rect.top + AUTO_SCROLL_EDGE_PX - Math.max(clientY, rect.top)) / AUTO_SCROLL_EDGE_PX);
      return -Math.max(1, Math.round(ratio * AUTO_SCROLL_MAX_STEP_PX));
    }
    if (clientY > rect.bottom - AUTO_SCROLL_EDGE_PX && clientY <= rect.bottom + 40) {
      const ratio = Math.min(1, (Math.min(clientY, rect.bottom) - (rect.bottom - AUTO_SCROLL_EDGE_PX)) / AUTO_SCROLL_EDGE_PX);
      return Math.max(1, Math.round(ratio * AUTO_SCROLL_MAX_STEP_PX));
    }
    return 0;
  }

  function startAutoScrollLoop(gesture: ActiveGesture): void {
    if (typeof requestAnimationFrame !== "function") return;
    const step = () => {
      if (gestureRef.current !== gesture || !gesture.active) return;
      const container = latestRef.current.scrollContainerRef?.current;
      if (container) {
        const delta = computeAutoScrollDelta(container, gesture.lastY);
        if (delta !== 0) {
          const previousTop = container.scrollTop;
          container.scrollTop += delta;
          if (container.scrollTop !== previousTop) {
            const nextHovered = resolveDropSectionIdAtPoint(gesture.lastX, gesture.lastY);
            if (nextHovered !== gesture.hoveredTargetId) {
              gesture.hoveredTargetId = nextHovered;
              setDragState({
                session: gesture.session,
                originSectionId: gesture.originSectionId,
                clientX: gesture.lastX,
                clientY: gesture.lastY,
                hoveredTargetId: nextHovered,
              });
            }
          }
        }
      }
      gesture.rafId = requestAnimationFrame(step);
    };
    gesture.rafId = requestAnimationFrame(step);
  }

  function activateGesture(gesture: ActiveGesture, clientX: number, clientY: number): void {
    if (gestureRef.current !== gesture || gesture.active) return;
    gesture.active = true;
    gesture.lastX = clientX;
    gesture.lastY = clientY;
    if (gesture.longPressTimer !== undefined) {
      clearTimeout(gesture.longPressTimer);
      gesture.longPressTimer = undefined;
    }
    if (gesture.pointerType !== "mouse") {
      try {
        if (typeof navigator !== "undefined") {
          navigator.vibrate?.(12);
        }
      } catch {
        // Ignore unsupported vibration APIs.
      }
      if (typeof window !== "undefined") {
        const preventTouchScroll = (touchEvent: TouchEvent) => {
          if (gestureRef.current === gesture && gesture.active && touchEvent.cancelable) {
            touchEvent.preventDefault();
          }
        };
        const preventContextMenu = (menuEvent: Event) => {
          if (gestureRef.current === gesture && gesture.active) {
            menuEvent.preventDefault();
          }
        };
        window.addEventListener("touchmove", preventTouchScroll, { passive: false });
        window.addEventListener("contextmenu", preventContextMenu, true);
        gesture.cleanupTouchLock = () => {
          window.removeEventListener("touchmove", preventTouchScroll);
          window.removeEventListener("contextmenu", preventContextMenu, true);
        };
      }
    }
    setBodyDraggingClass(true);
    const hoveredTargetId = resolveDropSectionIdAtPoint(clientX, clientY);
    gesture.hoveredTargetId = hoveredTargetId;
    setDragState({
      session: gesture.session,
      originSectionId: gesture.originSectionId,
      clientX,
      clientY,
      hoveredTargetId,
    });
    startAutoScrollLoop(gesture);
  }

  function onSessionPointerDown(
    session: BridgeSessionInfo,
    event: ReactPointerEvent<HTMLElement>,
  ): void {
    if (typeof window === "undefined") return;
    if (!canMoveToSection(session)) return;
    if (typeof event.button === "number" && event.button !== 0) return;
    if (isInteractiveDragExclusion(event.target)) return;

    teardownGesture();

    const pointerType = event.pointerType || "mouse";
    const gesture: ActiveGesture = {
      pointerId: event.pointerId,
      pointerType,
      session,
      originSectionId: originSectionFor(session),
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      active: false,
      hoveredTargetId: undefined,
      longPressTimer: undefined,
      rafId: undefined,
      cleanupListeners: undefined,
      cleanupTouchLock: undefined,
    };
    gestureRef.current = gesture;

    const handlePointerMove = (moveEvent: PointerEvent) => {
      if (gestureRef.current !== gesture || moveEvent.pointerId !== gesture.pointerId) return;
      gesture.lastX = moveEvent.clientX;
      gesture.lastY = moveEvent.clientY;
      const distance = Math.hypot(moveEvent.clientX - gesture.startX, moveEvent.clientY - gesture.startY);

      if (!gesture.active) {
        if (gesture.pointerType === "mouse") {
          if (distance >= MOUSE_DRAG_DISTANCE_PX) {
            moveEvent.preventDefault();
            activateGesture(gesture, moveEvent.clientX, moveEvent.clientY);
          }
        } else if (distance > TOUCH_CANCEL_DISTANCE_PX) {
          // User is scrolling the list — cancel immediately so native touch scroll stays 100% smooth.
          teardownGesture();
        }
        return;
      }

      if (moveEvent.cancelable) moveEvent.preventDefault();
      const hoveredTargetId = resolveDropSectionIdAtPoint(moveEvent.clientX, moveEvent.clientY);
      gesture.hoveredTargetId = hoveredTargetId;
      setDragState({
        session: gesture.session,
        originSectionId: gesture.originSectionId,
        clientX: moveEvent.clientX,
        clientY: moveEvent.clientY,
        hoveredTargetId,
      });
    };

    const handlePointerUp = (upEvent: PointerEvent) => {
      if (gestureRef.current !== gesture || upEvent.pointerId !== gesture.pointerId) return;
      if (!gesture.active) {
        teardownGesture();
        return;
      }
      if (upEvent.cancelable) upEvent.preventDefault();
      const finalTarget = resolveDropSectionIdAtPoint(upEvent.clientX, upEvent.clientY) ?? gesture.hoveredTargetId;
      const originSectionId = gesture.originSectionId;
      const targetSessionId = gesture.session.sessionId;
      installPostDropClickSuppressor();
      teardownGesture();
      if (finalTarget && finalTarget !== originSectionId) {
        const nextSectionId = finalTarget === UNSECTIONED_DROP_ID ? null : finalTarget;
        void latestRef.current.onMoveSessionSection?.(targetSessionId, nextSectionId);
      }
    };

    const handlePointerCancel = (cancelEvent: PointerEvent) => {
      if (gestureRef.current !== gesture || cancelEvent.pointerId !== gesture.pointerId) return;
      teardownGesture();
    };

    const handleKeyDown = (keyEvent: KeyboardEvent) => {
      if (gestureRef.current !== gesture) return;
      if (keyEvent.key === "Escape") {
        if (gesture.active) {
          keyEvent.preventDefault();
          keyEvent.stopPropagation();
        }
        teardownGesture();
      }
    };

    const handleWindowBlur = () => {
      if (gestureRef.current === gesture) teardownGesture();
    };

    const handleVisibilityChange = () => {
      if (gestureRef.current === gesture && typeof document !== "undefined" && document.visibilityState !== "visible") {
        teardownGesture();
      }
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerCancel);
    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("blur", handleWindowBlur);
    if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
      document.addEventListener("visibilitychange", handleVisibilityChange);
    }

    gesture.cleanupListeners = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerCancel);
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("blur", handleWindowBlur);
      if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
        document.removeEventListener("visibilitychange", handleVisibilityChange);
      }
    };

    if (pointerType !== "mouse") {
      gesture.longPressTimer = setTimeout(() => {
        activateGesture(gesture, gesture.lastX, gesture.lastY);
      }, TOUCH_LONG_PRESS_MS);
    }
  }

  useEffect(() => {
    if (!options.hostOnline && gestureRef.current) {
      teardownGesture();
    }
  }, [options.hostOnline]);

  useEffect(() => () => {
    clickSuppressCleanupRef.current?.();
    teardownGesture();
  }, []);

  function dropZoneState(dropSectionId: string | undefined): "target" | "origin" | undefined {
    if (!dragState || !dropSectionId || dragState.hoveredTargetId !== dropSectionId) {
      return undefined;
    }
    return dropSectionId === dragState.originSectionId ? "origin" : "target";
  }

  return {
    dragState,
    canMoveToSection,
    originSectionFor,
    dropZoneState,
    onSessionPointerDown,
    cancel: teardownGesture,
  };
}

export function formatSessionDragBadge(
  dragState: SessionSectionDragState,
  manualSections: readonly BridgeProjectInfo[],
): string {
  const target = dragState.hoveredTargetId;
  if (!target || target === dragState.originSectionId) {
    return "拖动到目标分组";
  }
  if (target === UNSECTIONED_DROP_ID) {
    return "移出到未分组";
  }
  const targetName = manualSections.find((section) => section.projectId === target)?.name ?? target;
  return `移动到「${targetName}」`;
}

export function SessionSectionDragGhost({
  dragState,
  manualSections,
}: {
  dragState: SessionSectionDragState | undefined;
  manualSections: readonly BridgeProjectInfo[];
}): ReactPortal | null {
  if (!dragState || typeof document === "undefined" || !document.body) {
    return null;
  }
  const viewportWidth = typeof window !== "undefined" && window.innerWidth > 0 ? window.innerWidth : 1024;
  const viewportHeight = typeof window !== "undefined" && window.innerHeight > 0 ? window.innerHeight : 768;
  const ghostMaxWidth = Math.min(264, Math.max(160, viewportWidth - 16));
  const clampedLeft = Math.min(
    Math.max(8, dragState.clientX + 12),
    Math.max(8, viewportWidth - ghostMaxWidth - 8),
  );
  const clampedTop = Math.min(
    Math.max(8, dragState.clientY - 26),
    Math.max(8, viewportHeight - 62),
  );
  const isOverValidTarget = Boolean(
    dragState.hoveredTargetId && dragState.hoveredTargetId !== dragState.originSectionId,
  );
  const badge = formatSessionDragBadge(dragState, manualSections);

  return createPortal(
    createElement(
      "div",
      {
        className: `session-drag-ghost${isOverValidTarget ? " is-over-target" : ""}`,
        style: {
          left: `${Math.round(clampedLeft)}px`,
          top: `${Math.round(clampedTop)}px`,
          maxWidth: `${Math.round(ghostMaxWidth)}px`,
        },
        "aria-hidden": "true",
      },
      createElement("strong", { className: "session-drag-ghost-title" }, dragState.session.title),
      createElement("span", { className: "session-drag-ghost-badge" }, badge),
    ),
    document.body,
  );
}
