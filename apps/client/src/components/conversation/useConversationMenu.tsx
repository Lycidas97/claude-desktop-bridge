import type { BridgeEvent, BridgeHostSnapshot, BridgePrAutoFixState, BridgePrAutoFixUpdate, BridgeProjectInfo, BridgePullRequest, BridgeSessionCommandResult, BridgeSessionInfo } from "@bridge/protocol";
import { CornerUpLeft, GitFork, MessageSquare, PackageCheck } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { SessionHistoryState } from "../../hooks/useMobileBridge.js";
import { desktopRuntimeId } from "../../lib/runtime-labels.js";
import { SheetAction } from "../common/Sheet.js";
import { SessionActionSheets } from "../session/SessionActionSheets.js";
import { useSessionMenuAction } from "../session/useSessionMenuAction.js";
import { SessionPrActions } from "./SessionPrBar.js";

export type ConversationMenuBindings = {
  open(): void;
  requestRename(session: BridgeSessionInfo): void;
} | {
  rename?: ((sessionId: string, title: string) => Promise<void>) | undefined;
  move?: ((sessionId: string, sectionId: string | null) => Promise<{ session?: BridgeSessionInfo; projects?: BridgeProjectInfo[] } | void>) | undefined;
  fork?: ((sessionId: string) => Promise<BridgeSessionInfo | undefined>) | undefined;
  archive?: ((sessionId: string, archived: boolean) => Promise<void>) | undefined;
  delete?: ((sessionId: string) => Promise<void>) | undefined;
  error?: string | undefined;
};

export function useConversationMenu({ hostId, draftKey, previousDraftKeyRef, session, snapshot, history, isMobile, isOnline, refreshing, onRefresh, onOpenSession, onSelectSession, onRunSessionCommand, sessionMenu, onDeleted }: {
  hostId: string;
  draftKey: string;
  previousDraftKeyRef: RefObject<string>;
  session: BridgeSessionInfo;
  snapshot: BridgeHostSnapshot | undefined;
  history: SessionHistoryState | undefined;
  isMobile: boolean;
  isOnline: boolean;
  refreshing: boolean;
  onRefresh?: ((sessionId?: string) => Promise<unknown>) | undefined;
  onOpenSession(sessionId: string): Promise<void>;
  onSelectSession(sessionId: string): void | Promise<void>;
  onRunSessionCommand?: ((sessionId: string, text: string) => Promise<BridgeSessionCommandResult>) | undefined;
  sessionMenu?: ConversationMenuBindings | undefined;
  onDeleted(): void;
}) {
  const external = sessionMenu && "open" in sessionMenu ? sessionMenu : undefined;
  const { rename: onRenameSession, move: onMoveSessionSection, fork: onForkSession,
    archive: onArchiveSession, delete: onDeleteSession, error: sessionActionError } =
    sessionMenu && !("open" in sessionMenu) ? sessionMenu : {};
  const runtimeId = desktopRuntimeId(session);
  const { busy: actionBusy, setBusy: setActionBusy, error: actionError, setError: setActionError, run: runMenuAction } = useSessionMenuAction();
  const [internalMenuOpen, setInternalMenuOpen] = useState(false);
  const [moveMenuOpen, setMoveMenuOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameTitle, setRenameTitle] = useState("");
  const [internalRefreshing, setInternalRefreshing] = useState(false);
  const [syncCheckTick, setSyncCheckTick] = useState(0);
  const [syncFlash, setSyncFlash] = useState(false);
  const [deleteSessionOpen, setDeleteSessionOpen] = useState(false);
  const [deleteSessionError, setDeleteSessionError] = useState<string>();
  const syncPendingKeyRef = useRef<string | undefined>(undefined);

  const effectiveActionError = actionError ?? sessionActionError;

  useEffect(() => {
    if (internalRefreshing || syncPendingKeyRef.current !== draftKey) return;
    if (history?.status === "loading") return;
    syncPendingKeyRef.current = undefined;
    if (history?.status === "error") {
      setActionError(history.error ?? "同步会话失败");
    } else {
      setSyncFlash(true);
    }
  }, [draftKey, history?.error, history?.status, internalRefreshing, syncCheckTick]);

  useEffect(() => {
    if (!syncFlash) return;
    const timer = setTimeout(() => setSyncFlash(false), 2_400);
    return () => clearTimeout(timer);
  }, [syncFlash]);

  const manualSections = (snapshot?.projects ?? []).filter((project) => project.kind === "desktop-group");
  const menuSupportsMoveSection = Boolean(
    onMoveSessionSection
    && snapshot?.host.capabilities.includes("section.move.v1")
    && session.allowedActions?.canMoveSection,
  );
  const menuSupportsRename = Boolean(
    onRenameSession
      ? (
          !snapshot
          || snapshot.host.capabilities.includes("session.rename.v1")
          || (snapshot.host.capabilities.includes("session.command.v1") && runtimeId === "claude-desktop")
        )
      : (
          onRunSessionCommand
          && snapshot?.host.capabilities.includes("session.command.v1")
          && runtimeId === "claude-desktop"
        ),
  );
  const renameCanSave = Boolean(renameTitle.trim() && renameTitle.trim() !== session.title && !actionBusy);
  const menuSupportsFork = Boolean(onForkSession && runtimeId === "claude-desktop");
  const menuSupportsVisibility = isMobile || Boolean(snapshot?.host.capabilities.includes("session.visibility.v1"));
  const canSyncSession = Boolean(onRefresh || !isMobile);
  const effectiveRefreshing = refreshing || internalRefreshing;
  const renameDialogRef = useRef<HTMLElement>(null);
  const menuOpenerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!renameOpen || typeof document === "undefined") return;
    const dialog = renameDialogRef.current;
    return () => {
      const opener = menuOpenerRef.current;
      const active = document.activeElement;
      const focusReleased = !active || active === document.body || active === document.documentElement || Boolean(dialog?.contains(active));
      if (opener && opener.isConnected && focusReleased) {
        opener.focus();
      }
    };
  }, [renameOpen]);

  useEffect(() => {
    if (!renameOpen || !actionBusy) return;
    renameDialogRef.current?.focus();
  }, [renameOpen, actionBusy]);

  function closeInternalRename(): void {
    if (actionBusy) return;
    setRenameOpen(false);
    setInternalMenuOpen(false);
  }

  function runInternalRename(): void | Promise<void> {
    if (!renameCanSave || (!onRenameSession && !onRunSessionCommand)) return;
    return runMenuAction("重命名会话失败", async () => {
      if (onRenameSession) {
        await onRenameSession(session.sessionId, renameTitle.trim());
      } else {
        await onRunSessionCommand!(session.sessionId, `/rename ${renameTitle.trim()}`);
      }
      setRenameOpen(false);
      setInternalMenuOpen(false);
    });
  }

  function runInternalMoveSection(sectionId: string | null): void | Promise<void> {
    if (!onMoveSessionSection || !isOnline) return;
    return runMenuAction("移动分组失败", async () => {
      await onMoveSessionSection(session.sessionId, sectionId);
      setMoveMenuOpen(false);
      setInternalMenuOpen(false);
    });
  }

  async function runInternalRefresh(): Promise<void> {
    if (!canSyncSession || effectiveRefreshing || actionBusy) return;
    const targetKey = draftKey;
    setInternalRefreshing(true);
    setActionError(undefined);
    setSyncFlash(false);
    if (!onRefresh) syncPendingKeyRef.current = targetKey;
    try {
      if (onRefresh) {
        if (await onRefresh(session.sessionId)) {
          if (previousDraftKeyRef.current === targetKey) setSyncFlash(true);
        }
      } else {
        await onOpenSession(session.sessionId);
      }
    } catch (error) {
      if (syncPendingKeyRef.current === targetKey) syncPendingKeyRef.current = undefined;
      if (previousDraftKeyRef.current === targetKey) {
        setActionError(error instanceof Error ? error.message : "同步会话失败");
      }
    } finally {
      if (previousDraftKeyRef.current === targetKey) {
        setInternalRefreshing(false);
        setSyncCheckTick((value) => value + 1);
      }
    }
  }

  function runInternalFork(): void | Promise<void> {
    if (!onForkSession) return;
    return runMenuAction("Fork 分支创建失败", async () => {
      const created = await onForkSession(session.sessionId);
      if (!created) return;
      setInternalMenuOpen(false);
      await onSelectSession(created.sessionId);
    });
  }

  function runInternalArchive(archived: boolean): void | Promise<void> {
    if (!onArchiveSession) return;
    return runMenuAction("归档设置失败", async () => {
      await onArchiveSession(session.sessionId, archived);
      setInternalMenuOpen(false);
    });
  }

  function runInternalDelete(): void | Promise<void> {
    if (!onDeleteSession) return;
    return runMenuAction("删除会话失败", async () => {
      await onDeleteSession(session.sessionId);
      onDeleted();
      setDeleteSessionOpen(false);
      setInternalMenuOpen(false);
    }, setDeleteSessionError);
  }

  function startRename(): void {
    setRenameTitle(session.title);
    setActionError(undefined);
    setRenameOpen(true);
  }

  const closeOnBack = useCallback(() => {
    if (external) return false;
    if (renameOpen) {
      if (!actionBusy) {
        setRenameOpen(false);
        setInternalMenuOpen(false);
      }
      return true;
    }
    if (deleteSessionOpen) {
      if (!actionBusy) setDeleteSessionOpen(false);
      return true;
    }
    if (internalMenuOpen) {
      if (!actionBusy) {
        if (moveMenuOpen) setMoveMenuOpen(false);
        else setInternalMenuOpen(false);
      }
      return true;
    }
    return false;
  }, [actionBusy, deleteSessionOpen, external, internalMenuOpen, moveMenuOpen, renameOpen]);

  return {
    open() {
      if (external) {
        external.open();
      } else {
        if (typeof document !== "undefined" && document.activeElement instanceof HTMLElement) {
          menuOpenerRef.current = document.activeElement;
        }
        setActionError(undefined);
        setMoveMenuOpen(false);
        setInternalMenuOpen(true);
      }
    },
    closeOnBack,
    onRename: external ? () => external.requestRename(session) : (onRenameSession || onRunSessionCommand) ? startRename : undefined,
    commitRename: onRenameSession ? (title: string) => onRenameSession(session.sessionId, title) : undefined,
    canSync: canSyncSession,
    refreshing: effectiveRefreshing,
    refresh: runInternalRefresh,
    error: !internalMenuOpen && !renameOpen ? effectiveActionError : undefined,
    setError: setActionError,
    resetSelection() {
      setDeleteSessionOpen(false);
      setInternalMenuOpen(false);
      setMoveMenuOpen(false);
      setRenameOpen(false);
      setActionError(undefined);
      syncPendingKeyRef.current = undefined;
      setInternalRefreshing(false);
      setSyncFlash(false);
    },
    renderSheets({ sessionView, evidenceCount, parentSession, onToggleView, onConfigure, prSupported, events, isNativeReady, onReadPrAutoFix, onSetPrAutoFix }: {
      sessionView: "conversation" | "evidence";
      evidenceCount: number;
      parentSession: BridgeSessionInfo | undefined;
      onToggleView(): void;
      onConfigure?: (() => void) | undefined;
      prSupported: boolean;
      events: BridgeEvent[];
      isNativeReady: boolean;
      onReadPrAutoFix?: ((sessionId: string, pr?: BridgePullRequest, includeChecks?: boolean) => Promise<BridgePrAutoFixState>) | undefined;
      onSetPrAutoFix?: ((update: BridgePrAutoFixUpdate) => Promise<BridgePrAutoFixState>) | undefined;
    }) {
      if (external) return null;
      return (
        <SessionActionSheets
          menuSession={internalMenuOpen ? session : undefined}
          renameSession={renameOpen ? session : undefined}
          deleteSession={menuSupportsVisibility && onDeleteSession && deleteSessionOpen ? session : undefined}
          moveMenuOpen={moveMenuOpen}
          manualSections={manualSections}
          online={isOnline}
          busy={actionBusy}
          error={deleteSessionOpen ? deleteSessionError : effectiveActionError}
          supportsRename={menuSupportsRename}
          supportsMoveSection={menuSupportsMoveSection}
          supportsFork={menuSupportsFork}
          renameTitle={renameTitle}
          renameDialogRef={renameDialogRef}
          leadingGroup={(
            <div className="m-group">
              <SheetAction
                icon={sessionView === "evidence" ? <MessageSquare size={19} /> : <PackageCheck size={19} />}
                label={sessionView === "evidence" ? "返回对话" : `成果${evidenceCount > 0 ? ` ${evidenceCount}` : ""}`}
                disabled={actionBusy}
                detail={sessionView === "evidence" ? "回到对话记录" : "文件变更、产物与图片"}
                onClick={() => {
                  onToggleView();
                  setInternalMenuOpen(false);
                }}
              />
              {parentSession && (
                <SheetAction
                  icon={session.sidechat ? <CornerUpLeft size={19} /> : <GitFork size={19} />}
                  label="主会话"
                  disabled={actionBusy}
                  detail={`来自：${parentSession.title}`}
                  onClick={() => {
                    setInternalMenuOpen(false);
                    void onSelectSession(parentSession.sessionId);
                  }}
                />
              )}
            </div>
          )}
          prActions={!session.prs?.length && prSupported ? (
            <SessionPrActions
              key={`${hostId}:${session.sessionId}`}
              session={session}
              events={events}
              onWriteBusyChange={setActionBusy}
              supported
              online={isNativeReady}
              {...(onReadPrAutoFix ? { onRead: onReadPrAutoFix } : {})}
              {...(onSetPrAutoFix ? { onSet: onSetPrAutoFix } : {})}
            />
          ) : undefined}
          onCloseMenu={() => {
            if (!actionBusy) {
              setMoveMenuOpen(false);
              setInternalMenuOpen(false);
            }
          }}
          onOpenMoveMenu={() => {
            setActionError(undefined);
            setMoveMenuOpen(true);
          }}
          onBackFromMoveMenu={() => {
            setActionError(undefined);
            setMoveMenuOpen(false);
          }}
          onMoveToSection={runInternalMoveSection}
          onStartRename={startRename}
          onChangeRenameTitle={(title) => {
            setRenameTitle(title);
            if (actionError) setActionError(undefined);
          }}
          onSubmitRename={runInternalRename}
          onCloseRename={closeInternalRename}
          onOpenConfiguration={onConfigure ? () => {
            onConfigure();
            setInternalMenuOpen(false);
          } : undefined}
          syncAction={canSyncSession ? {
            refreshing: effectiveRefreshing,
            syncFlash,
            disabled: effectiveRefreshing || (!onRefresh && !isOnline),
            onSync: runInternalRefresh,
          } : undefined}
          onFork={menuSupportsFork ? runInternalFork : undefined}
          onArchive={menuSupportsVisibility && onArchiveSession ? runInternalArchive : undefined}
          onRequestDelete={menuSupportsVisibility && onDeleteSession ? () => {
            setActionError(undefined);
            setDeleteSessionError(undefined);
            setDeleteSessionOpen(true);
          } : undefined}
          onCancelDelete={() => {
            if (!actionBusy) setDeleteSessionOpen(false);
          }}
          onConfirmDelete={runInternalDelete}
        />
      );
    },
  };
}
