import type {
  BridgeHostSnapshot,
  BridgeProjectInfo,
  BridgeSessionInfo,
  SocketState,
} from "@bridge/protocol";
import { Eye, EyeOff, LoaderCircle, Pencil, Trash2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { registerMobileBackHandler } from "../../lib/mobile-back-navigation.js";
import { ConfirmationDialog } from "../common/ConfirmationDialog.js";
import { MobileSheet, SheetAction } from "../mobile/MobileSheet.js";

export interface UseSectionManageOptions {
  activeHostId: string | undefined;
  desktopName: string;
  snapshot: BridgeHostSnapshot | undefined;
  connection: SocketState;
  desktopOnline: boolean;
  onRenameSection: ((
    sectionId: string,
    name: string,
  ) => Promise<{ project?: BridgeProjectInfo; projects?: BridgeProjectInfo[]; sessions?: BridgeSessionInfo[] }>) | undefined;
  onDeleteSection: ((
    sectionId: string,
  ) => Promise<{ projects?: BridgeProjectInfo[]; sessions?: BridgeSessionInfo[] }>) | undefined;
}

type SectionManageMode = "menu" | "rename" | "confirm-delete";

interface SectionManageState {
  sectionId: string;
  mode: SectionManageMode;
  name: string;
  busy: boolean;
  error: string;
}

export interface SectionManageController {
  desktopName: string;
  online: boolean;
  supportsRename: boolean;
  supportsDelete: boolean;
  hideEmptySections: boolean;
  emptySectionCount: number;
  targetProject: BridgeProjectInfo | undefined;
  state: SectionManageState | undefined;
  canManage(project: BridgeProjectInfo | undefined): boolean;
  shouldHideEmpty(project: BridgeProjectInfo | undefined, visibleSessionCount: number, query: string): boolean;
  revealEmptySections(): void;
  toggleHideEmptySections(): void;
  openMenu(sectionId: string): void;
  startRename(): void;
  updateName(name: string): void;
  submitRename(): Promise<void>;
  startConfirmDelete(): void;
  runDelete(explicitSectionId?: string): Promise<void>;
  close(): void;
  renderDirectoryActions(options: {
    activeGroupProject: BridgeProjectInfo | undefined;
    closeDirectoryMenu(): void;
  }): ReactNode;
}

export function useSectionManage({
  activeHostId,
  desktopName,
  snapshot,
  connection,
  desktopOnline,
  onRenameSection,
  onDeleteSection,
}: UseSectionManageOptions): SectionManageController {
  const hideStorageKey = `bridge-hide-empty-sections:${activeHostId}`;
  const [hideEmptySections, setHideEmptySections] = useState(
    () => localStorage.getItem(hideStorageKey) === "1",
  );
  const [state, setState] = useState<SectionManageState>();

  const online = connection === "connected" && desktopOnline;
  const supportsRename = Boolean(onRenameSection && snapshot?.host.capabilities.includes("section.rename.v1"));
  const supportsDelete = Boolean(onDeleteSection && snapshot?.host.capabilities.includes("section.delete.v1"));
  const manualSections = (snapshot?.projects ?? []).filter((project) => project.kind === "desktop-group");
  const sessions = snapshot?.sessions ?? [];
  const activeParentProjects = new Map(
    sessions.filter((session) => !session.archivedAt).map((session) => [session.sessionId, session.projectId]),
  );
  const visibleCounts = new Map<string, number>(manualSections.map((project) => [project.projectId, 0]));
  for (const session of sessions) {
    if (
      visibleCounts.has(session.projectId)
      && (!session.archivedAt || Boolean(session.sidechat && session.parentSessionId && activeParentProjects.get(session.parentSessionId) === session.projectId))
    ) {
      visibleCounts.set(session.projectId, (visibleCounts.get(session.projectId) ?? 0) + 1);
    }
  }
  const emptySectionCount = manualSections.filter((project) => (visibleCounts.get(project.projectId) ?? 0) === 0).length;
  const targetProject = state
    ? manualSections.find((project) => project.projectId === state.sectionId)
    : undefined;

  useEffect(() => {
    if (state && !state.busy && !targetProject) setState(undefined);
  }, [state, targetProject]);

  useEffect(() => {
    if (!state || !targetProject) return;
    return registerMobileBackHandler(() => {
      if (state.busy) return true;
      setState(undefined);
      return true;
    }, 150);
  }, [state, targetProject]);

  function canManage(project: BridgeProjectInfo | undefined): boolean {
    return Boolean(project?.kind === "desktop-group" && (supportsRename || supportsDelete));
  }

  function shouldHideEmpty(project: BridgeProjectInfo | undefined, visibleSessionCount: number, query: string): boolean {
    return Boolean(hideEmptySections && !query && project?.kind === "desktop-group" && visibleSessionCount === 0);
  }

  function setPersistedHideEmpty(next: boolean): void {
    setHideEmptySections(next);
    if (next) localStorage.setItem(hideStorageKey, "1");
    else localStorage.removeItem(hideStorageKey);
  }

  function revealEmptySections(): void {
    if (hideEmptySections) setPersistedHideEmpty(false);
  }

  function toggleHideEmptySections(): void {
    setPersistedHideEmpty(!hideEmptySections);
  }

  function openMenu(sectionId: string): void {
    const project = manualSections.find((candidate) => candidate.projectId === sectionId);
    if (!project || !canManage(project)) return;
    setState({ sectionId, mode: "menu", name: project.name, busy: false, error: "" });
  }

  function openRename(sectionId: string): void {
    const project = manualSections.find((candidate) => candidate.projectId === sectionId);
    if (!project || !supportsRename) return;
    setState({ sectionId, mode: "rename", name: project.name, busy: false, error: "" });
  }

  function startRename(): void {
    if (!state || !targetProject || state.busy || !supportsRename) return;
    setState({ ...state, mode: "rename", name: targetProject.name, error: "" });
  }

  function updateName(name: string): void {
    if (!state || state.busy) return;
    setState({ ...state, name, error: "" });
  }

  async function submitRename(): Promise<void> {
    if (!state || !targetProject || state.busy || !online || !supportsRename || !onRenameSection) return;
    const trimmed = state.name.trim();
    if (!trimmed) return;
    if (trimmed === targetProject.name) {
      setState(undefined);
      return;
    }
    setState({ ...state, busy: true, error: "" });
    try {
      await onRenameSection(targetProject.projectId, trimmed);
      setState(undefined);
    } catch (reason) {
      setState({
        ...state,
        busy: false,
        error: reason instanceof Error ? reason.message : "重命名分组失败",
      });
    }
  }

  function startConfirmDelete(): void {
    if (!state || !targetProject || state.busy || !supportsDelete) return;
    setState({ ...state, mode: "confirm-delete", error: "" });
  }

  async function runDelete(explicitSectionId?: string): Promise<void> {
    const sectionId = explicitSectionId ?? state?.sectionId;
    const project = sectionId ? manualSections.find((candidate) => candidate.projectId === sectionId) : undefined;
    if (!project || state?.busy || !online || !supportsDelete || !onDeleteSection) return;
    setState({
      sectionId: project.projectId,
      mode: state?.mode ?? "menu",
      name: project.name,
      busy: true,
      error: "",
    });
    try {
      await onDeleteSection(project.projectId);
      setState(undefined);
    } catch (reason) {
      setState({
        sectionId: project.projectId,
        mode: "menu",
        name: project.name,
        busy: false,
        error: reason instanceof Error ? reason.message : "删除分组失败",
      });
    }
  }

  function close(): void {
    if (!state?.busy) setState(undefined);
  }

  function renderDirectoryActions({
    activeGroupProject,
    closeDirectoryMenu,
  }: {
    activeGroupProject: BridgeProjectInfo | undefined;
    closeDirectoryMenu(): void;
  }): ReactNode {
    if (activeGroupProject?.kind === "desktop-group") {
      if (!canManage(activeGroupProject)) return null;
      return (
        <>
          {supportsRename && (
            <SheetAction
              icon={<Pencil size={19} />}
              label="重命名分组"
              disabled={!online}
              onClick={() => {
                closeDirectoryMenu();
                openRename(activeGroupProject.projectId);
              }}
            />
          )}
          {supportsDelete && (
            <SheetAction
              icon={<Trash2 size={19} />}
              label={activeGroupProject.sessionCount === 0 ? "删除空分组" : "删除分组"}
              danger
              disabled={!online}
              onClick={() => {
                closeDirectoryMenu();
                if (activeGroupProject.sessionCount === 0) {
                  void runDelete(activeGroupProject.projectId);
                } else {
                  setState({
                    sectionId: activeGroupProject.projectId,
                    mode: "confirm-delete",
                    name: activeGroupProject.name,
                    busy: false,
                    error: "",
                  });
                }
              }}
            />
          )}
        </>
      );
    }

    if (activeGroupProject || manualSections.length === 0) return null;
    const countSuffix = emptySectionCount > 0 ? `（${emptySectionCount}）` : "";
    return (
      <SheetAction
        icon={hideEmptySections ? <Eye size={19} /> : <EyeOff size={19} />}
        label={hideEmptySections ? `显示空分组${countSuffix}` : `隐藏空分组${countSuffix}`}
        onClick={() => {
          toggleHideEmptySections();
          closeDirectoryMenu();
        }}
      />
    );
  }

  return {
    desktopName,
    online,
    supportsRename,
    supportsDelete,
    hideEmptySections,
    emptySectionCount,
    targetProject,
    state,
    canManage,
    shouldHideEmpty,
    revealEmptySections,
    toggleHideEmptySections,
    openMenu,
    startRename,
    updateName,
    submitRename,
    startConfirmDelete,
    runDelete,
    close,
    renderDirectoryActions,
  };
}

export function SectionManageDialog({ controller }: { controller: SectionManageController }) {
  const { desktopName, online, supportsRename, supportsDelete, targetProject, state } = controller;
  if (!state || !targetProject) return null;

  if (state.mode === "rename") {
    const trimmed = state.name.trim();
    const canSave = Boolean(online && trimmed && !state.busy);
    return (
      <div
        className="modal-backdrop session-create-backdrop"
        role="presentation"
        onMouseDown={(event) => { if (event.target === event.currentTarget) controller.close(); }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            controller.close();
          }
        }}
      >
        <section
          className="create-session-dialog session-create-dialog section-create-dialog"
          role="dialog"
          aria-modal="true"
          aria-label="重命名分组"
        >
          <header className="session-create-header"><h2>重命名分组</h2></header>
          <form onSubmit={(event) => { event.preventDefault(); void controller.submitRename(); }}>
            <div className="session-create-body">
              <label>
                <span>分组名称</span>
                <input
                  aria-label="分组名称"
                  value={state.name}
                  autoFocus
                  required
                  maxLength={200}
                  disabled={state.busy}
                  onFocus={(event) => event.target.select()}
                  onChange={(event) => controller.updateName(event.target.value)}
                />
              </label>
              {state.error && <p className="session-create-error" role="alert">{state.error}</p>}
              {!online && <p className="session-create-status" role="status">电脑已离线，连接后可修改分组。</p>}
            </div>
            <footer className="dialog-actions session-create-actions">
              <button type="button" className="secondary-button" disabled={state.busy} onClick={controller.close}>取消</button>
              <button type="submit" className="primary-button" disabled={!canSave}>{state.busy ? "正在保存…" : "保存"}</button>
            </footer>
          </form>
        </section>
      </div>
    );
  }

  if (state.mode === "confirm-delete") {
    return (
      <ConfirmationDialog
        open
        title="删除分组"
        description={`删除「${targetProject.name}」分组？组内 ${targetProject.sessionCount} 个会话不会删除，将移回各自的项目目录。${online ? "" : "电脑已离线，连接后可删除分组。"}`}
        confirmLabel="删除分组"
        danger
        busy={state.busy}
        confirmDisabled={!online}
        onCancel={controller.close}
        onConfirm={() => void controller.runDelete()}
      />
    );
  }

  return (
    <MobileSheet eyebrow={desktopName} title={targetProject.name} onClose={controller.close}>
      <div className="m-group">
        {supportsRename && (
          <SheetAction
            icon={<Pencil size={19} />}
            label="重命名分组"
            disabled={!online || state.busy}
            onClick={controller.startRename}
          />
        )}
        {supportsDelete && (
          <SheetAction
            icon={<Trash2 size={19} />}
            label={targetProject.sessionCount === 0 ? "删除空分组" : "删除分组"}
            danger
            disabled={!online || state.busy}
            onClick={() => {
              if (targetProject.sessionCount === 0) void controller.runDelete();
              else controller.startConfirmDelete();
            }}
          />
        )}
      </div>
      {state.busy && <p className="m-sheet-note" role="status"><LoaderCircle className="is-spinning" size={15} />正在处理…</p>}
      {state.error && <p className="m-sheet-note is-error" role="alert">{state.error}</p>}
      {!online && <p className="m-sheet-note" role="status">电脑已离线，连接后可管理分组。</p>}
    </MobileSheet>
  );
}
