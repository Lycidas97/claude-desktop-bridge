import type {
  BridgeDesktopRuntimeId,
  BridgeDirectoryListing,
  BridgeHostSnapshot,
  BridgeSessionInfo,
} from "@bridge/protocol";
import { ArrowUp, Check, ChevronLeft, ChevronRight, Folder, FolderOpen, FolderPlus, LoaderCircle, Monitor, Pencil, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { registerMobileBackHandler } from "../../lib/mobile-back-navigation.js";
import { desktopRuntimeName } from "../../lib/runtime-labels.js";
import { IconButton } from "../common/IconButton.js";
import "./session-create.css";

export interface SessionCreateDialogProps {
  snapshot: BridgeHostSnapshot;
  initialProjectId?: string;
  connected: boolean;
  onBrowseDirectory?(path?: string): Promise<BridgeDirectoryListing>;
  onCreateDirectory?(parentPath: string, name: string): Promise<string>;
  onChooseDirectory?(initialPath?: string): Promise<string | undefined>;
  onCreate(cwd: string, title?: string, runtimeId?: BridgeDesktopRuntimeId, projectId?: string): Promise<BridgeSessionInfo | undefined>;
  onCreated(session: BridgeSessionInfo): void;
  onClose(): void;
}

function folderName(path: string): string {
  return path.replace(/[\\/]+$/u, "").split(/[\\/]/u).at(-1) || path;
}

/** Mount with the host ID as key so each computer owns its creation draft. */
export function SessionCreateDialog({ snapshot, initialProjectId, connected, onBrowseDirectory, onCreateDirectory, onChooseDirectory, onCreate, onCreated, onClose }: SessionCreateDialogProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const runtimeId = "claude-desktop";
  const projects = snapshot.projects.filter((project) => (project.runtimeId ?? "claude-desktop") === runtimeId);
  const initialProject = projects.find((project) => project.projectId === initialProjectId);
  const [cwd, setCwd] = useState(initialProject?.cwd ?? "");
  const [projectId, setProjectId] = useState(initialProject?.kind === "desktop-group" ? initialProject.projectId : "");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState("");
  const [view, setView] = useState<"form" | "recent" | "browse">("form");
  const [browseTarget, setBrowseTarget] = useState<{ path: string | undefined }>();
  const [browseInput, setBrowseInput] = useState("");
  const [listing, setListing] = useState<BridgeDirectoryListing>();
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseError, setBrowseError] = useState("");
  const [pathEditing, setPathEditing] = useState(false);
  const [mkdirOpen, setMkdirOpen] = useState(false);
  const [mkdirName, setMkdirName] = useState("");
  const [mkdirBusy, setMkdirBusy] = useState(false);
  const [mkdirError, setMkdirError] = useState("");

  const runtime = snapshot.runtimes?.find((candidate) => candidate.id === runtimeId);
  const runtimeAvailable = snapshot.runtimes
    ? runtime?.state === "ready" && runtime.capabilities.includes("session.create")
    : runtimeId === "claude-desktop" && (snapshot.runtime.state === "ready" || snapshot.runtime.state === "working");
  const groups = projects.filter((project) => project.kind === "desktop-group");
  const recentPaths = [...new Set([
    ...[...projects].sort((left, right) => right.lastActivityAt - left.lastActivityAt).map((project) => project.cwd),
    ...(listing?.recentPaths ?? []),
  ])].filter(Boolean);
  const locked = busy || choosing || mkdirBusy;
  const groupUnavailable = Boolean(projectId && !groups.some((project) => project.projectId === projectId));
  const canCreate = connected && runtimeAvailable && Boolean(cwd.trim()) && !groupUnavailable && !locked;
  const canSelectFolder = connected && !browseLoading && !mkdirBusy && (onBrowseDirectory
    ? Boolean(listing && browseInput.trim() === listing.path)
    : Boolean(browseInput.trim()));

  function resetMkdir(): void {
    setMkdirOpen(false);
    setMkdirName("");
    setMkdirError("");
  }

  function back(): void {
    if (locked) return;
    if (view === "browse" && mkdirOpen) {
      resetMkdir();
      return;
    }
    if (view === "form") onClose();
    else {
      resetMkdir();
      setView("form");
      setBrowseTarget(undefined);
    }
  }

  useEffect(() => registerMobileBackHandler(() => { back(); return true; }, 150), [view, mkdirOpen, locked, onClose]);

  useEffect(() => {
    if (!dialogRef.current?.contains(document.activeElement)) dialogRef.current?.focus();
  }, [view, pathEditing, mkdirOpen, browseLoading]);

  useEffect(() => {
    if (!browseTarget || !onBrowseDirectory) return;
    if (!connected) { setBrowseLoading(false); return; }
    let active = true;
    void onBrowseDirectory(browseTarget.path)
      .then((next) => {
        if (!active) return;
        setListing(next);
        setBrowseInput(next.path);
        setPathEditing(false);
      })
      .catch((reason: unknown) => {
        if (active) setBrowseError(reason instanceof Error ? reason.message : "文件夹读取失败");
      })
      .finally(() => { if (active) setBrowseLoading(false); });
    return () => { active = false; };
  }, [browseTarget, runtimeId, snapshot.host.hostId, connected, onBrowseDirectory]);

  function openDirectory(path?: string): void {
    resetMkdir();
    setBrowseInput(path ?? "");
    setListing(undefined);
    setBrowseError("");
    setBrowseLoading(Boolean(onBrowseDirectory));
    setBrowseTarget({ path });
  }

  function selectFolder(path: string): void {
    resetMkdir();
    setCwd(path);
    setView("form");
    setBrowseTarget(undefined);
    setPathEditing(false);
    setError("");
  }

  async function createSubdirectory(): Promise<void> {
    const trimmed = mkdirName.trim();
    if (!onCreateDirectory || !listing || !connected || browseLoading || mkdirBusy || !trimmed) return;
    if (trimmed === "." || trimmed === ".." || /[\\/\0]/u.test(trimmed) || trimmed.length > 255) {
      setMkdirError("请输入合法的单层文件夹名称");
      return;
    }
    setMkdirBusy(true);
    setMkdirError("");
    try {
      const createdPath = await onCreateDirectory(listing.path, trimmed);
      openDirectory(createdPath);
    } catch (reason) {
      setMkdirError(reason instanceof Error ? reason.message : "新建文件夹失败");
    } finally {
      setMkdirBusy(false);
    }
  }

  async function chooseDirectory(): Promise<void> {
    if (!connected || locked) return;
    if (!onChooseDirectory) {
      setView(projects.length ? "recent" : "browse");
      setPathEditing(!onBrowseDirectory);
      openDirectory(cwd.trim() || undefined);
      return;
    }
    setChoosing(true);
    setError("");
    try {
      const path = await onChooseDirectory(cwd.trim() || undefined);
      if (path) selectFolder(path);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "文件夹选择失败");
    } finally { setChoosing(false); }
  }

  async function createSession(): Promise<void> {
    if (!canCreate) return;
    setBusy(true);
    setError("");
    try {
      const session = await onCreate(cwd.trim(), title.trim() || undefined, runtimeId, projectId || undefined);
      if (!session) { setError("会话未创建，请重试。"); return; }
      onCreated(session);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "会话创建失败");
    } finally { setBusy(false); }
  }

  return (
    <div className="modal-backdrop session-create-backdrop" role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget) back(); }}
      onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); back(); } }}>
      <section ref={dialogRef} tabIndex={-1} className={`create-session-dialog session-create-dialog${view !== "form" ? " is-folder-picker" : ""}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="session-create-header">
          {view !== "form" && <button type="button" className="session-create-back" aria-label="返回新建会话" onClick={back}><ChevronLeft size={22} /></button>}
          <div className="session-create-heading">
            <h2 id={titleId}>{view === "form" ? "新建会话" : "选择文件夹"}</h2>
            <p className="session-create-host"><Monitor size={13} />{snapshot.host.name}</p>
          </div>
          {view === "form" && <IconButton label="关闭" disabled={locked} onClick={onClose}><X size={18} /></IconButton>}
        </header>
        <form onSubmit={(event) => {
          event.preventDefault();
          if (view === "form") void createSession();
          else if (view === "browse" && pathEditing && connected && !browseLoading && onBrowseDirectory) openDirectory(browseInput.trim() || undefined);
          else if (view === "browse" && mkdirOpen) void createSubdirectory();
        }}>
          {view !== "form" && (
            <nav className="session-create-tabs" aria-label="文件夹来源">
              <button type="button" aria-pressed={view === "recent"} disabled={mkdirBusy} onClick={() => { resetMkdir(); setView("recent"); }}>最近使用</button>
              <button type="button" aria-pressed={view === "browse"} disabled={mkdirBusy} onClick={() => setView("browse")}>{onBrowseDirectory ? "浏览电脑" : "输入路径"}</button>
            </nav>
          )}
          <div className="session-create-body">
            {view === "recent" ? (
              <>
                <ul className="session-create-directories" aria-label="最近使用的文件夹">
                  {recentPaths.map((path) => (
                    <li key={path}>
                      <button type="button" aria-label={`选择 ${path}`} aria-current={cwd === path ? "true" : undefined} disabled={!connected} onClick={() => selectFolder(path)}>
                        <Folder size={20} /><span className="session-create-folder-copy"><strong>{folderName(path)}</strong><small>{path}</small></span>{cwd === path && <Check size={18} />}
                      </button>
                    </li>
                  ))}
                </ul>
                {!recentPaths.length && <div className="session-create-empty"><FolderOpen size={28} /><p>还没有最近使用的文件夹</p></div>}
                {browseLoading && <p className="session-create-status" role="status"><LoaderCircle className="is-spinning" size={15} />正在更新文件夹</p>}
              </>
            ) : view === "browse" ? (
              <>
                {pathEditing ? (
                  <label className="session-create-path-editor">
                    <span>电脑上的绝对路径</span>
                    <div className="session-create-folder-row">
                      <input aria-label="当前路径" value={browseInput} autoFocus autoCapitalize="none" autoCorrect="off" spellCheck={false} disabled={browseLoading} placeholder="输入文件夹路径" onChange={(event) => setBrowseInput(event.target.value)} />
                      {onBrowseDirectory && <button type="submit" className="secondary-button" disabled={!connected || browseLoading}>前往</button>}
                    </div>
                  </label>
                ) : (
                  <div className="session-create-location">
                    <button type="button" className="session-create-parent" aria-label="上级目录" title="上级目录" disabled={!connected || browseLoading || mkdirBusy || !listing?.parentPath} onClick={() => openDirectory(listing!.parentPath)}><ArrowUp size={19} /></button>
                    <span className="session-create-location-path">{listing?.path ?? (browseInput || "电脑主目录")}</span>
                    <button type="button" className="session-create-edit-path" aria-label="输入路径" title="输入路径" disabled={browseLoading || mkdirBusy} onClick={() => { resetMkdir(); setPathEditing(true); }}><Pencil size={17} /></button>
                  </div>
                )}
                {!pathEditing && onBrowseDirectory && onCreateDirectory && listing && !browseLoading && (
                  mkdirOpen ? (
                    <div className="session-create-mkdir-box">
                      <label>
                        <span>在「{folderName(listing.path)}」下新建文件夹</span>
                        <input
                          aria-label="新文件夹名称"
                          value={mkdirName}
                          autoFocus
                          autoCapitalize="none"
                          autoCorrect="off"
                          spellCheck={false}
                          maxLength={255}
                          disabled={mkdirBusy}
                          placeholder="单层文件夹名称"
                          onChange={(event) => { setMkdirName(event.target.value); setMkdirError(""); }}
                        />
                      </label>
                      {mkdirError && <p className="session-create-error" role="alert">{mkdirError}</p>}
                      <div className="session-create-mkdir-actions">
                        <button type="button" className="secondary-button" disabled={mkdirBusy} onClick={resetMkdir}>取消</button>
                        <button type="submit" className="secondary-button is-confirm" disabled={!connected || mkdirBusy || !mkdirName.trim()}>
                          {mkdirBusy && <LoaderCircle className="is-spinning" size={15} />}创建并进入
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button type="button" className="session-create-mkdir-trigger" disabled={!connected} onClick={() => { setMkdirOpen(true); setMkdirName(""); setMkdirError(""); }}>
                      <FolderPlus size={18} /><span>新建文件夹</span>
                    </button>
                  )
                )}
                {browseLoading && <div className="session-create-status" role="status"><LoaderCircle className="is-spinning" size={16} />正在读取文件夹</div>}
                {browseError && <div className="session-create-browse-error"><p className="session-create-error" role="alert">{browseError}</p><button type="button" className="secondary-button" disabled={!connected || browseLoading || mkdirBusy} onClick={() => openDirectory(browseInput.trim() || undefined)}>重试</button></div>}
                {listing && !browseLoading && (
                  <ul className="session-create-directories" aria-label="子文件夹">
                    {listing.directories.map((directory) => (
                      <li key={directory.path}><button type="button" aria-label={`打开 ${directory.name}`} disabled={!connected || mkdirBusy} onClick={() => openDirectory(directory.path)}><Folder size={20} /><span>{directory.name}</span><ChevronRight size={17} /></button></li>
                    ))}
                    {!listing.directories.length && <li className="session-create-no-children">没有子文件夹，可直接使用当前文件夹</li>}
                  </ul>
                )}
              </>
            ) : (
              <>
                <div className="session-create-folder">
                  <span className="session-create-field-label">工作文件夹</span>
                  <button type="button" className={`session-create-folder-trigger${cwd ? " has-folder" : ""}`} aria-label="选择文件夹" aria-describedby={`${titleId}-folder`} disabled={!connected || locked} onClick={() => void chooseDirectory()}>
                    {choosing ? <LoaderCircle className="is-spinning" size={22} /> : <FolderOpen size={22} />}
                    <span id={`${titleId}-folder`} className="session-create-folder-copy" aria-label="工作文件夹"><strong>{cwd ? folderName(cwd) : "选择工作文件夹"}</strong><small>{cwd || "电脑上的文件夹"}</small></span><ChevronRight size={18} />
                  </button>
                  {onChooseDirectory && <button type="button" className="session-create-folder-alternative" disabled={!connected || locked} onClick={() => {
                    setView("recent"); setPathEditing(!onBrowseDirectory); openDirectory(cwd.trim() || undefined);
                  }}>最近使用或输入路径</button>}
                </div>
                {(groups.length > 0 || groupUnavailable) && <label><span>项目分组（可选）</span><select aria-label="项目分组（可选）" value={projectId} disabled={locked} onChange={(event) => setProjectId(event.target.value)}>
                  <option value="">未分组</option>
                  {groupUnavailable && <option value={projectId} disabled>分组已不可用</option>}
                  {groups.map((project) => <option key={project.projectId} value={project.projectId}>{project.name}</option>)}
                </select></label>}
                <label><span>会话名称（可选）</span><input aria-label="会话名称（可选）" value={title} disabled={locked} placeholder="可留空，稍后命名" onChange={(event) => setTitle(event.target.value)} /></label>
                {groupUnavailable && <p className="session-create-error" role="alert">所选分组已不可用，请重新选择。</p>}
                {connected && !runtimeAvailable && <p className="session-create-error" role="alert">{desktopRuntimeName(runtimeId)} 当前无法创建会话。</p>}
                {error && <p className="session-create-error" role="alert">{error}</p>}
              </>
            )}
          </div>
          {!connected && <p className="session-create-status session-create-offline" role="status">电脑已离线，连接后可创建会话。</p>}
          <footer className="dialog-actions session-create-actions">
            {view === "form" ? (
              <><button type="button" className="secondary-button" disabled={locked} onClick={onClose}>取消</button><button key="create-session" type="submit" className="primary-button" disabled={!canCreate}>{busy && <LoaderCircle className="is-spinning" size={16} />}创建会话</button></>
            ) : (
              <><button type="button" className="secondary-button" onClick={back}>取消选择</button>{view === "browse" ? <button key="use-folder" type="button" className="primary-button" disabled={!canSelectFolder} onClick={() => selectFolder(onBrowseDirectory ? listing!.path : browseInput.trim())}>使用此文件夹</button> : <button key="open-browse" type="button" className="primary-button" onClick={() => setView("browse")}>{onBrowseDirectory ? "浏览电脑文件夹" : "输入文件夹路径"}</button>}</>
            )}
          </footer>
        </form>
      </section>
    </div>
  );
}
