import type { BridgeProjectInfo, BridgeSessionInfo } from "@bridge/protocol";
import { GripVertical } from "lucide-react";
import {
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { moveProject } from "../../lib/project-groups.js";
import { IconButton } from "../common/IconButton.js";
import { MobileSheet } from "./MobileSheet.js";

const LONG_PRESS_MS = 220;
const MOVE_CANCEL_PX = 8;

export interface ProjectOrderSheetProps {
  desktopName: string;
  projectOrder: readonly string[];
  projectsByActivity: readonly string[];
  projects: readonly BridgeProjectInfo[] | undefined;
  sessions: readonly BridgeSessionInfo[];
  onPlaceProjects(order: string[]): void;
  onClose(): void;
}

interface DragSession {
  pointerId: number;
  projectId: string;
  startX: number;
  startY: number;
  active: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export function ProjectOrderSheet({
  desktopName,
  projectOrder,
  projectsByActivity,
  projects,
  sessions,
  onPlaceProjects,
  onClose,
}: ProjectOrderSheetProps) {
  const [drag, setDrag] = useState<{ projectId: string; order: string[] }>();
  const listRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<DragSession | undefined>(undefined);
  const dragOrderRef = useRef<string[] | undefined>(undefined);
  const projectOrderRef = useRef(projectOrder);
  projectOrderRef.current = projectOrder;

  const isDragging = Boolean(drag);
  useEffect(() => {
    if (!isDragging || typeof document === "undefined") return;
    const preventTouchScroll = (event: TouchEvent) => {
      if (event.cancelable) event.preventDefault();
    };
    document.addEventListener("touchmove", preventTouchScroll, { passive: false });
    return () => document.removeEventListener("touchmove", preventTouchScroll);
  }, [isDragging]);

  useEffect(() => () => {
    if (sessionRef.current?.timer !== undefined) clearTimeout(sessionRef.current.timer);
  }, []);

  function clearSession(): void {
    const session = sessionRef.current;
    if (session?.timer !== undefined) clearTimeout(session.timer);
    if (session?.active && listRef.current?.hasPointerCapture?.(session.pointerId)) {
      listRef.current.releasePointerCapture(session.pointerId);
    }
    sessionRef.current = undefined;
    dragOrderRef.current = undefined;
    setDrag(undefined);
  }

  function activateDrag(pointerId: number, projectId: string, vibrate: boolean): void {
    const initialOrder = [...projectOrderRef.current];
    dragOrderRef.current = initialOrder;
    listRef.current?.setPointerCapture?.(pointerId);
    if (vibrate) globalThis.navigator?.vibrate?.(10);
    setDrag({ projectId, order: initialOrder });
  }

  function startHandleDrag(projectId: string, event: ReactPointerEvent<HTMLButtonElement>): void {
    if (projectOrder.length < 2) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.stopPropagation();
    clearSession();
    sessionRef.current = {
      pointerId: event.pointerId,
      projectId,
      startX: event.clientX,
      startY: event.clientY,
      active: true,
      timer: undefined,
    };
    activateDrag(event.pointerId, projectId, false);
  }

  function startRowPress(projectId: string, event: ReactPointerEvent<HTMLDivElement>): void {
    if (projectOrder.length < 2) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    clearSession();
    const { pointerId, clientX, clientY } = event;
    const timer = setTimeout(() => {
      const current = sessionRef.current;
      if (!current || current.pointerId !== pointerId) return;
      current.active = true;
      current.timer = undefined;
      activateDrag(pointerId, projectId, true);
    }, LONG_PRESS_MS);
    sessionRef.current = {
      pointerId,
      projectId,
      startX: clientX,
      startY: clientY,
      active: false,
      timer,
    };
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    const session = sessionRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    if (!session.active) {
      if (Math.hypot(event.clientX - session.startX, event.clientY - session.startY) > MOVE_CANCEL_PX) {
        clearSession();
      }
      return;
    }
    const currentOrder = dragOrderRef.current;
    const list = listRef.current;
    if (!currentOrder || !list) return;
    const currentIndex = currentOrder.indexOf(session.projectId);
    if (currentIndex < 0) return;
    const rows = Array.from(list.children) as HTMLElement[];
    if (rows.length !== currentOrder.length) return;
    let targetIndex = currentIndex;
    for (let i = currentIndex + 1; i < rows.length; i += 1) {
      const rect = rows[i]!.getBoundingClientRect();
      if (event.clientY >= rect.top + rect.height / 2) targetIndex = i;
    }
    for (let i = currentIndex - 1; i >= 0; i -= 1) {
      const rect = rows[i]!.getBoundingClientRect();
      if (event.clientY <= rect.top + rect.height / 2) targetIndex = i;
    }
    if (targetIndex !== currentIndex) {
      const nextOrder = moveProject(currentOrder, session.projectId, targetIndex);
      dragOrderRef.current = nextOrder;
      setDrag({ projectId: session.projectId, order: nextOrder });
    }
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLDivElement>): void {
    const session = sessionRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    const finalOrder = session.active ? dragOrderRef.current : undefined;
    clearSession();
    if (finalOrder && finalOrder.some((id, index) => id !== projectOrderRef.current[index])) {
      onPlaceProjects(finalOrder);
    }
  }

  function handleHandleKeyDown(projectId: string, index: number, event: KeyboardEvent<HTMLButtonElement>): void {
    let targetIndex = index;
    if (event.key === "ArrowUp") targetIndex = Math.max(0, index - 1);
    else if (event.key === "ArrowDown") targetIndex = Math.min(projectOrder.length - 1, index + 1);
    else if (event.key === "Home") targetIndex = 0;
    else if (event.key === "End") targetIndex = projectOrder.length - 1;
    else return;
    event.preventDefault();
    if (targetIndex === index) return;
    const handle = event.currentTarget;
    onPlaceProjects(moveProject(projectOrder, projectId, targetIndex));
    queueMicrotask(() => handle.focus?.());
  }

  const visibleOrder = drag?.order ?? projectOrder;
  const isActivityOrder = projectOrder.length === projectsByActivity.length
    && projectOrder.every((id, index) => id === projectsByActivity[index]);

  return (
    <MobileSheet
      eyebrow={desktopName}
      title="项目顺序"
      onClose={() => {
        clearSession();
        onClose();
      }}
      footer={(
        <>
          <button
            type="button"
            className="secondary-button"
            disabled={isActivityOrder}
            onClick={() => {
              clearSession();
              onPlaceProjects([...projectsByActivity]);
            }}
          >
            按最近活动重排
          </button>
          <button
            type="button"
            className="primary-button"
            onClick={() => {
              clearSession();
              onClose();
            }}
          >
            完成
          </button>
        </>
      )}
    >
      <p className="m-sheet-note">项目按这里的顺序固定显示，点开或收到回复都不会移动项目；新出现的项目排在最前。项目内的会话按最近回复或打开的先后排列。</p>
      <div
        ref={listRef}
        role="list"
        aria-label="项目顺序列表"
        className={`m-group project-order-list${isDragging ? " is-dragging" : ""}`}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={(event) => {
          if (sessionRef.current?.pointerId === event.pointerId) clearSession();
        }}
        onLostPointerCapture={(event) => {
          if (sessionRef.current?.pointerId === event.pointerId) clearSession();
        }}
        onPointerLeave={() => {
          if (sessionRef.current && !sessionRef.current.active) clearSession();
        }}
        onContextMenu={(event) => {
          if (sessionRef.current) event.preventDefault();
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && sessionRef.current?.active) {
            event.preventDefault();
            event.stopPropagation();
            clearSession();
          }
        }}
      >
        {visibleOrder.map((projectId, index) => {
          const projectSessions = sessions.filter((session) => session.projectId === projectId && !session.archivedAt);
          const name = projects?.find((project) => project.projectId === projectId)?.name
            ?? projectSessions[0]?.projectName
            ?? projectId;
          const rowDragging = drag?.projectId === projectId;
          return (
            <div
              role="listitem"
              className={`project-order-row${rowDragging ? " is-dragging" : ""}`}
              key={projectId}
              data-project-id={projectId}
              onPointerDown={(event) => startRowPress(projectId, event)}
            >
              <span>
                <strong>{name}</strong>
                <small>{projectSessions.length} 个会话</small>
              </span>
              <IconButton
                label={`拖动「${name}」调整顺序`}
                className="project-order-handle"
                disabled={projectOrder.length < 2}
                onPointerDown={(event) => startHandleDrag(projectId, event)}
                onKeyDown={(event) => handleHandleKeyDown(projectId, index, event)}
              >
                <GripVertical size={18} />
              </IconButton>
            </div>
          );
        })}
      </div>
    </MobileSheet>
  );
}
