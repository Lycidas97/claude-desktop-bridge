import type { BridgeProjectInfo, BridgeSessionInfo } from "@bridge/protocol";
import {
  Archive,
  ArchiveRestore,
  Check,
  FilePenLine,
  Folder,
  FolderOpen,
  GitFork,
  LoaderCircle,
  RefreshCw,
  Settings2,
  Trash2,
} from "lucide-react";
import type { ReactNode, RefObject } from "react";
import { conciseModelName } from "../../lib/conversation-timeline.js";
import { desktopRuntimeId, desktopRuntimeName } from "../../lib/runtime-labels.js";
import { ConfirmationDialog } from "../common/ConfirmationDialog.js";
import { Sheet, SheetAction } from "../common/Sheet.js";
import { trapModalTabKey } from "./SectionCreateDialog.js";

export interface SessionSyncMenuAction {
  refreshing: boolean;
  syncFlash: boolean;
  disabled: boolean;
  onSync(): void | Promise<void>;
}

export interface SessionActionSheetsProps {
  menuSession: BridgeSessionInfo | undefined;
  renameSession: BridgeSessionInfo | undefined;
  deleteSession: BridgeSessionInfo | undefined;
  moveMenuOpen: boolean;
  manualSections: readonly BridgeProjectInfo[];
  online: boolean;
  busy: boolean;
  error: string | undefined;
  supportsRename: boolean;
  renameDisabled?: boolean | undefined;
  supportsMoveSection: boolean;
  supportsFork: boolean;
  renameTitle: string;
  renameDialogRef?: RefObject<HTMLElement | null> | undefined;
  leadingGroup?: ReactNode | undefined;
  prActions?: ReactNode | undefined;
  onCloseMenu(): void;
  onOpenMoveMenu(): void;
  onBackFromMoveMenu(): void;
  onMoveToSection(sectionId: string | null): void | Promise<void>;
  onStartRename(): void;
  onChangeRenameTitle(title: string): void;
  onSubmitRename(): void | Promise<void>;
  onCloseRename(): void;
  onOpenConfiguration?: (() => void) | undefined;
  syncAction?: SessionSyncMenuAction | undefined;
  onFork?: (() => void | Promise<void>) | undefined;
  onArchive?: ((archived: boolean) => void | Promise<void>) | undefined;
  onRequestDelete?: (() => void) | undefined;
  onCancelDelete(): void;
  onConfirmDelete(): void | Promise<void>;
}

export function SessionActionSheets({
  menuSession,
  renameSession,
  deleteSession,
  moveMenuOpen,
  manualSections,
  online,
  busy,
  error,
  supportsRename,
  renameDisabled = false,
  supportsMoveSection,
  supportsFork,
  renameTitle,
  renameDialogRef,
  leadingGroup,
  prActions,
  onCloseMenu,
  onOpenMoveMenu,
  onBackFromMoveMenu,
  onMoveToSection,
  onStartRename,
  onChangeRenameTitle,
  onSubmitRename,
  onCloseRename,
  onOpenConfiguration,
  syncAction,
  onFork,
  onArchive,
  onRequestDelete,
  onCancelDelete,
  onConfirmDelete,
}: SessionActionSheetsProps) {
  const currentMenuSection = menuSession
    ? manualSections.find((project) => project.projectId === menuSession.projectId)
    : undefined;
  const sessionBusy = Boolean(
    menuSession && (
      menuSession.turnState === "running"
      || menuSession.turnState === "queued"
      || menuSession.turnState === "waiting"
    ),
  );
  const renameCanSave = Boolean(
    renameSession
    && renameTitle.trim()
    && renameTitle.trim() !== renameSession.title
    && !busy,
  );
  const hasManagementGroup = Boolean(
    supportsRename || supportsMoveSection || onOpenConfiguration || syncAction,
  );

  return (
    <>
      {menuSession && !renameSession && (
        <Sheet
          manageFocus
          focusPaused={Boolean(deleteSession) || Boolean(renameSession)}
          eyebrow={moveMenuOpen ? menuSession.title : `${menuSession.projectName} · ${desktopRuntimeName(desktopRuntimeId(menuSession))}`}
          title={moveMenuOpen ? "移动到分组" : menuSession.title}
          busy={busy}
          onClose={onCloseMenu}
          {...(moveMenuOpen ? {
            footer: (
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={onBackFromMoveMenu}
              >
                返回
              </button>
            ),
          } : {})}
        >
          {moveMenuOpen ? (
            <>
              {manualSections.length > 0 && (
                <div className="m-group">
                  {manualSections.map((section) => {
                    const isCurrent = currentMenuSection?.projectId === section.projectId;
                    return (
                      <SheetAction
                        key={section.projectId}
                        icon={isCurrent ? <Check size={19} /> : <Folder size={19} />}
                        label={section.name}
                        detail={isCurrent ? "当前所在分组" : undefined}
                        disabled={busy || !online || isCurrent}
                        onClick={() => void onMoveToSection(section.projectId)}
                      />
                    );
                  })}
                </div>
              )}
              {currentMenuSection && (
                <div className="m-group">
                  <SheetAction
                    icon={<FolderOpen size={19} />}
                    label="移出分组"
                    disabled={busy || !online}
                    onClick={() => void onMoveToSection(null)}
                  />
                </div>
              )}
            </>
          ) : (
            <>
              {leadingGroup}
              {hasManagementGroup && (
                <div className="m-group">
                  {supportsRename && (
                    <SheetAction
                      icon={<FilePenLine size={19} />}
                      label="重命名"
                      disabled={busy || renameDisabled}
                      onClick={onStartRename}
                    />
                  )}
                  {supportsMoveSection && (
                    <SheetAction
                      icon={<Folder size={19} />}
                      label="移动到分组"
                      detail={currentMenuSection ? currentMenuSection.name : manualSections.length > 0 ? "未分组" : "暂无可用分组"}
                      disabled={busy || !online || (!currentMenuSection && manualSections.length === 0)}
                      onClick={onOpenMoveMenu}
                    />
                  )}
                  {onOpenConfiguration && (
                    <SheetAction
                      icon={<Settings2 size={19} />}
                      label="会话设置"
                      detail={conciseModelName(menuSession)}
                      disabled={busy}
                      onClick={onOpenConfiguration}
                    />
                  )}
                  {syncAction && (
                    <SheetAction
                      icon={syncAction.refreshing ? <LoaderCircle className="is-spinning" size={19} /> : syncAction.syncFlash ? <Check size={19} /> : <RefreshCw size={19} />}
                      label={syncAction.refreshing ? "正在同步" : syncAction.syncFlash ? "已同步" : "同步此会话"}
                      detail="重新读取电脑端的最新记录"
                      disabled={busy || syncAction.disabled}
                      onClick={() => void syncAction.onSync()}
                    />
                  )}
                </div>
              )}
              {prActions && <div className="m-group">{prActions}</div>}
              {supportsFork && onFork && (
                <div className="m-group">
                  <SheetAction
                    icon={<GitFork size={19} />}
                    label="Fork 分支"
                    detail="复制完整对话为独立会话，原会话不变"
                    disabled={busy}
                    onClick={() => void onFork()}
                  />
                </div>
              )}
              {(onArchive || onRequestDelete) && (
                <div className="m-group">
                  {onArchive && (
                    <SheetAction
                      icon={menuSession.archivedAt ? <ArchiveRestore size={19} /> : <Archive size={19} />}
                      label={menuSession.archivedAt ? "恢复会话" : "归档会话"}
                      detail={menuSession.archivedAt ? "放回所属项目" : "从列表收起，历史保留"}
                      disabled={busy}
                      onClick={() => void onArchive(!menuSession.archivedAt)}
                    />
                  )}
                  {onRequestDelete && (
                    <SheetAction
                      icon={<Trash2 size={19} />}
                      label="删除会话"
                      detail={sessionBusy
                        ? "任务进行中，先停止再删除"
                        : menuSession.transport === "claude-desktop-native"
                          ? "删除 Claude Desktop 中的会话"
                          : "仅从 Bridge 移除，Desktop 原会话保留"}
                      danger
                      disabled={busy || sessionBusy}
                      onClick={onRequestDelete}
                    />
                  )}
                </div>
              )}
            </>
          )}
          {busy && <p className="m-sheet-note" role="status"><LoaderCircle className="is-spinning" size={15} />正在处理…</p>}
          {error && <p className="m-sheet-note is-error" role="alert">{error}</p>}
        </Sheet>
      )}

      {renameSession && (
        <div
          className="modal-backdrop session-create-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !busy) onCloseRename();
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              if (!busy) onCloseRename();
              return;
            }
            if (renameDialogRef?.current) {
              trapModalTabKey(event, renameDialogRef.current);
            }
          }}
        >
          <section
            ref={renameDialogRef}
            className="create-session-dialog session-create-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="重命名会话"
            tabIndex={-1}
            onKeyDown={(event) => {
              if (!renameDialogRef?.current) trapModalTabKey(event, event.currentTarget);
            }}
          >
            <header className="session-create-header">
              <h2>重命名会话</h2>
            </header>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void onSubmitRename();
              }}
            >
              <div className="session-create-body">
                <label>
                  <span>会话名称</span>
                  <input
                    aria-label="会话名称"
                    value={renameTitle}
                    autoFocus
                    required
                    maxLength={200}
                    disabled={busy}
                    onFocus={(event) => event.target.select()}
                    onChange={(event) => onChangeRenameTitle(event.target.value)}
                  />
                </label>
                {error && <p className="session-create-error" role="alert">{error}</p>}
              </div>
              <footer className="dialog-actions session-create-actions">
                <button type="button" className="secondary-button" disabled={busy} onClick={onCloseRename}>
                  取消
                </button>
                <button type="submit" className="primary-button" disabled={!renameCanSave}>
                  {busy ? "正在保存…" : "保存"}
                </button>
              </footer>
            </form>
          </section>
        </div>
      )}

      <ConfirmationDialog
        open={Boolean(deleteSession)}
        title="删除会话"
        description={deleteSession
          ? (deleteSession.transport === "claude-desktop-native"
              ? `从 Claude Desktop 中删除「${deleteSession.title}」会话及其对话记录？此操作不可恢复。`
              : `从 Bridge 列表中删除「${deleteSession.title}」？对应 Desktop 应用中的原生会话与文件不受影响；Bridge 中的会话配置、排队与授权记录会被清除，此操作不可恢复。`)
          : ""}
        confirmLabel="删除会话"
        danger
        busy={busy}
        onCancel={onCancelDelete}
        onConfirm={() => void onConfirmDelete()}
      />
    </>
  );
}
