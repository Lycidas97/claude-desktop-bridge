import type { BridgeProjectInfo, BridgeSessionInfo } from "@bridge/protocol";
import { GripVertical } from "lucide-react";
import {
  Fragment,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { moveProject } from "../../lib/project-groups.js";
import { IconButton } from "../common/IconButton.js";
import { SelectMenu } from "../common/SelectMenu.js";
import { Sheet } from "../common/Sheet.js";

const LONG_PRESS_MS = 220;
const MOVE_CANCEL_PX = 8;

export interface ProjectOrderSheetProps {
  desktopName: string;
  projectOrder: readonly string[];
  projectsByActivity: readonly string[];
  projects: readonly BridgeProjectInfo[] | undefined;
  sessions: readonly BridgeSessionInfo[];
  manageFocus?: boolean;
  onPlaceProjects(order: string[]): void;
  onClose(): void;
}

interface DragSession {
  pointerId: number;
  projectId: string;
  startX: number;
  startY: number;
  clientX: number;
  clientY: number;
  offsetX: number;
  offsetY: number;
  moved: boolean;
  fromHandle: boolean;
  active: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export function ProjectOrderSheet({
  desktopName,
  projectOrder: fullProjectOrder,
  projectsByActivity: fullActivityOrder,
  projects,
  sessions,
  manageFocus = false,
  onPlaceProjects,
  onClose,
}: ProjectOrderSheetProps) {
  const managedProject = projects?.find(project => project.managedAssistant && fullProjectOrder.includes(project.projectId));
  const projectOrder = fullProjectOrder.filter(id => id !== managedProject?.projectId);
  const projectsByActivity = fullActivityOrder.filter(id => id !== managedProject?.projectId);
  const [drag, setDrag] = useState<{ projectId: string; order: string[] }>();
  const [ghost, setGhost] = useState<{ projectId: string; x: number; y: number; width: number; height: number; dropping?: boolean }>();
  const [positionProjectId, setPositionProjectId] = useState<string>();
  const listRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<DragSession | undefined>(undefined);
  const dragOrderRef = useRef<string[] | undefined>(undefined);
  const projectOrderRef = useRef(projectOrder);
  projectOrderRef.current = projectOrder;

  const isDragging = Boolean(drag);
  useEffect(() => {
    const list = listRef.current!;
    const preventTouchScroll = (event: TouchEvent) => {
      if (sessionRef.current?.active && event.cancelable) event.preventDefault();
    };
    list.addEventListener("touchmove", preventTouchScroll, { passive: false });
    return () => list.removeEventListener("touchmove", preventTouchScroll);
  }, []);

  useEffect(() => {
    if (!isDragging) return;
    const body = listRef.current!.closest<HTMLElement>(".m-sheet-body")!;
    let frame: number;
    let previousTop = body.scrollTop;
    const scrollAtEdge = () => {
      const session = sessionRef.current;
      if (!session?.active) return;
      if (session.moved) {
        const { top, bottom } = body.getBoundingClientRect();
        body.scrollTop += session.clientY < top + 40
          ? -Math.min(12, top + 40 - session.clientY)
          : session.clientY > bottom - 40 ? Math.min(12, session.clientY - bottom + 40) : 0;
        if (body.scrollTop !== previousTop) updateDragPosition(session.clientY);
      }
      previousTop = body.scrollTop;
      frame = requestAnimationFrame(scrollAtEdge);
    };
    frame = requestAnimationFrame(scrollAtEdge);
    return () => cancelAnimationFrame(frame);
  }, [isDragging]);

  useEffect(() => {
    if (!ghost?.dropping) return;
    const timer = setTimeout(() => setGhost(undefined), 140);
    return () => clearTimeout(timer);
  }, [ghost?.dropping]);

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
    setGhost(undefined);
  }

  function activateDrag(pointerId: number, projectId: string, vibrate: boolean): void {
    const initialOrder = [...projectOrderRef.current];
    const rect = listRef.current!.children[initialOrder.indexOf(projectId)]!.getBoundingClientRect();
    const session = sessionRef.current!;
    session.offsetX = session.startX - rect.left;
    session.offsetY = session.startY - rect.top;
    setGhost({ projectId, x: session.clientX - session.offsetX, y: session.clientY - session.offsetY, width: rect.width, height: rect.height });
    dragOrderRef.current = initialOrder;
    listRef.current?.setPointerCapture?.(pointerId);
    listRef.current!.focus({ preventScroll: true });
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
      clientX: event.clientX,
      clientY: event.clientY,
      offsetX: 0,
      offsetY: 0,
      moved: false,
      fromHandle: true,
      active: true,
      timer: undefined,
    };
    activateDrag(event.pointerId, projectId, event.pointerType === "touch");
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
      clientX,
      clientY,
      offsetX: 0,
      offsetY: 0,
      moved: false,
      fromHandle: false,
      active: false,
      timer,
    };
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    const session = sessionRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    session.clientX = event.clientX;
    session.clientY = event.clientY;
    const moved = Math.hypot(event.clientX - session.startX, event.clientY - session.startY) > MOVE_CANCEL_PX;
    if (!session.active) {
      if (moved) clearSession();
      return;
    }
    session.moved ||= moved;
    setGhost((current) => current && ({ ...current, x: event.clientX - session.offsetX, y: event.clientY - session.offsetY }));
    if (session.moved) updateDragPosition(event.clientY);
  }

  function updateDragPosition(clientY: number): void {
    const session = sessionRef.current;
    const currentOrder = dragOrderRef.current;
    const list = listRef.current;
    if (!session || !currentOrder || !list) return;
    const currentIndex = currentOrder.indexOf(session.projectId);
    if (currentIndex < 0) return;
    const rows = Array.from(list.children).slice(0, managedProject ? -1 : undefined);
    if (rows.length !== currentOrder.length) return;
    let targetIndex = currentIndex;
    for (let i = currentIndex + 1; i < rows.length; i += 1) {
      const rect = rows[i]!.getBoundingClientRect();
      if (clientY >= rect.top + rect.height / 2) targetIndex = i;
    }
    for (let i = currentIndex - 1; i >= 0; i -= 1) {
      const rect = rows[i]!.getBoundingClientRect();
      if (clientY <= rect.top + rect.height / 2) targetIndex = i;
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
    const dropRect = session.moved && ghost && !globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? listRef.current!.children[finalOrder!.indexOf(session.projectId)]!.getBoundingClientRect()
      : undefined;
    clearSession();
    if (session.fromHandle && !session.moved) setPositionProjectId((current) => current === session.projectId ? undefined : session.projectId);
    if (dropRect && ghost) setGhost({ ...ghost, x: dropRect.left, y: dropRect.top, dropping: true });
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
    <Sheet
      manageFocus={manageFocus}
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
        tabIndex={-1}
        aria-label="项目顺序列表"
        className={`m-group project-order-list${isDragging ? " is-dragging" : ""}`}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={(event) => {
          if (sessionRef.current?.pointerId === event.pointerId) clearSession();
        }}
        onLostPointerCapture={(event) => {
          if (event.target === event.currentTarget && sessionRef.current?.pointerId === event.pointerId) clearSession();
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
            <Fragment key={projectId}>
              <div
                role="listitem"
                className={`project-order-row${rowDragging ? " is-dragging" : ""}${ghost?.projectId === projectId ? " is-placeholder" : ""}`}
                data-project-id={projectId}
                onPointerDown={(event) => startRowPress(projectId, event)}
              >
                <span>
                  <strong>{name}</strong>
                  <small>{projectSessions.length} 个会话</small>
                  {positionProjectId === projectId && (
                    <SelectMenu
                      ariaLabel={`移动「${name}」到`}
                      autoFocus
                      value={String(index)}
                      options={projectOrder.map((_id, position) => ({
                        value: String(position),
                        label: `第 ${position + 1} 位`,
                      }))}
                      onChange={(nextPosition) => {
                        onPlaceProjects(moveProject(projectOrder, projectId, Number(nextPosition)));
                      }}
                    />
                  )}
                </span>
                <IconButton
                  label={`拖动「${name}」调整顺序`}
                  className="project-order-handle"
                  disabled={projectOrder.length < 2}
                  onPointerDown={(event) => startHandleDrag(projectId, event)}
                  onKeyDown={(event) => handleHandleKeyDown(projectId, index, event)}
                  aria-expanded={positionProjectId === projectId}
                  onClick={(event) => {
                    if (event.detail === 0) setPositionProjectId(positionProjectId === projectId ? undefined : projectId);
                  }}
                >
                  <GripVertical size={18} />
                </IconButton>
              </div>
              {ghost?.projectId === projectId && createPortal(
                <div
                  className={`project-order-ghost${ghost.dropping ? " is-dropping" : ""}`}
                  aria-hidden
                  inert
                  style={{ width: ghost.width, height: ghost.height, transform: `translate3d(${ghost.x}px, ${ghost.y}px, 0) scale(var(--ghost-scale))` }}
                >
                  <span><strong>{name}</strong><small>{projectSessions.length} 个会话</small></span>
                  <span className="project-order-ghost-grip"><GripVertical size={18} /></span>
                </div>,
                document.body,
              )}
            </Fragment>
          );
        })}
        {managedProject && <div role="listitem" className="project-order-row" data-project-id={managedProject.projectId}>
          <span><strong>{managedProject.name}</strong><small>{sessions.filter(session => session.projectId === managedProject.projectId && !session.archivedAt).length} 个会话</small></span>
        </div>}
      </div>
    </Sheet>
  );
}
