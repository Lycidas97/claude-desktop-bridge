import type {
  BridgeDesktopRuntimeId,
  BridgeDirectoryListing,
  BridgeHostSnapshot,
  BridgeSessionInfo,
} from "@bridge/protocol";
import { ArrowUp, ChevronRight, Folder, FolderOpen, History, LoaderCircle, X } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { registerMobileBackHandler } from "../lib/mobile-back-navigation.js";
import { desktopRuntimeName } from "../lib/runtime-labels.js";
import { IconButton } from "./IconButton.js";
import "./session-create.css";

export interface SessionCreateDialogProps {
  snapshot: BridgeHostSnapshot;
  initialProjectId?: string;
  initialRuntimeId?: BridgeDesktopRuntimeId;
  connected: boolean;
  onBrowseDirectory?(path?: string): Promise<BridgeDirectoryListing>;
  onChooseDirectory?(initialPath?: string): Promise<string | undefined>;
  onCreate(
    cwd: string,
    title?: string,
    runtimeId?: BridgeDesktopRuntimeId,
    projectId?: string,
  ): Promise<BridgeSessionInfo | undefined>;
  onCreated(session: BridgeSessionInfo): void;
  onClose(): void;
}

/** Mount with the host ID as key so each computer owns its creation draft. */
export function SessionCreateDialog({
  snapshot,
  initialProjectId,
  initialRuntimeId,
  connected,
  onBrowseDirectory,
  onChooseDirectory,
  onCreate,
  onCreated,
  onClose,
}: SessionCreateDialogProps) {
  const titleId = useId();
  const initialProject = snapshot.projects.find((project) => project.projectId === initialProjectId);
  const [runtimeId, setRuntimeId] = useState<BridgeDesktopRuntimeId>(initialRuntimeId ?? initialProject?.runtimeId ?? "claude-desktop");
  const [cwd, setCwd] = useState((initialProject?.runtimeId ?? "claude-desktop") === runtimeId ? initialProject?.cwd ?? "" : "");
  const [projectId, setProjectId] = useState(runtimeId === "claude-desktop" && initialProject?.kind === "desktop-group"
    ? initialProject.projectId : "");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState("");
  const [browseTarget, setBrowseTarget] = useState<{ path: string | undefined }>();
  const [browseInput, setBrowseInput] = useState("");
  const [listing, setListing] = useState<BridgeDirectoryListing>();
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseError, setBrowseError] = useState("");

  const runtime = snapshot.runtimes?.find((candidate) => candidate.id === runtimeId);
  const runtimeAvailable = snapshot.runtimes
    ? runtime?.state === "ready" && runtime.capabilities.includes("session.create")
    : runtimeId === "claude-desktop" && (snapshot.runtime.state === "ready" || snapshot.runtime.state === "working");
  const runtimeIds = snapshot.runtimes?.map((candidate) => candidate.id) ?? ["claude-desktop" as const];
  if (!runtimeIds.includes(runtimeId)) runtimeIds.push(runtimeId);
  const projects = snapshot.projects.filter((project) => (project.runtimeId ?? "claude-desktop") === runtimeId);
  const groups = runtimeId === "claude-desktop" ? projects.filter((project) => project.kind === "desktop-group") : [];
  // Legacy IDs can be raw Desktop group IDs or cwd hashes; only explicit kind
  // identifies a group. Untyped projects remain useful as folder shortcuts.
  const folders = projects.filter((project) => project.kind !== "desktop-group");
  const locked = busy || choosing;
  const groupUnavailable = Boolean(projectId && !groups.some((project) => project.projectId === projectId));
  const canCreate = connected && runtimeAvailable && Boolean(cwd.trim()) && !groupUnavailable && !locked;

  function back(): void {
    if (locked) return;
    if (browseTarget) setBrowseTarget(undefined);
    else onClose();
  }

  useEffect(() => registerMobileBackHandler(() => {
    back();
    return true;
  }, 150), [browseTarget, locked, onClose]);

  useEffect(() => {
    if (!browseTarget || !onBrowseDirectory) return;
    if (!connected) {
      setBrowseLoading(false);
      return;
    }
    let active = true;
    void onBrowseDirectory(browseTarget.path)
      .then((next) => {
        if (!active) return;
        setListing(next);
        setBrowseInput(next.path);
      })
      .catch((reason: unknown) => {
        if (active) setBrowseError(reason instanceof Error ? reason.message : "文件夹读取失败");
      })
      .finally(() => {
        if (active) setBrowseLoading(false);
      });
    return () => { active = false; };
  }, [browseTarget, runtimeId, snapshot.host.hostId, connected, onBrowseDirectory]);

  function openDirectory(path?: string): void {
    setBrowseInput(path ?? "");
    setListing(undefined);
    setBrowseError("");
    setBrowseLoading(true);
    setBrowseTarget({ path });
  }

  async function chooseDirectory(): Promise<void> {
    if (!connected || locked) return;
    if (!onChooseDirectory) {
      openDirectory(cwd.trim() || undefined);
      return;
    }
    setChoosing(true);
    setError("");
    try {
      const path = await onChooseDirectory(cwd.trim() || undefined);
      if (path) setCwd(path);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "文件夹选择失败");
    } finally {
      setChoosing(false);
    }
  }

  async function createSession(): Promise<void> {
    if (!canCreate) return;
    setBusy(true);
    setError("");
    try {
      const session = await onCreate(cwd.trim(), title.trim() || undefined, runtimeId, projectId || undefined);
      if (!session) {
        setError("会话未创建，请重试。");
        return;
      }
      onCreated(session);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "会话创建失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="modal-backdrop session-create-backdrop"
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget && !locked) onClose(); }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          back();
        }
      }}
    >
      <section className="create-session-dialog session-create-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header>
          <h2 id={titleId}>{browseTarget ? "选择文件夹" : "新建会话"}</h2>
          <IconButton label="关闭" disabled={locked} onClick={onClose}><X size={18} /></IconButton>
        </header>
        <form onSubmit={(event) => {
          event.preventDefault();
          if (browseTarget) {
            if (connected && !browseLoading) openDirectory(browseInput.trim() || undefined);
          } else void createSession();
        }}>
          {browseTarget ? (
            <>
              <p className="session-create-host">{snapshot.host.name}</p>
              <label>
                <span>当前路径</span>
                <div className="session-create-folder-row">
                  <input
                    aria-label="当前路径"
                    value={browseInput}
                    autoFocus
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    onChange={(event) => setBrowseInput(event.target.value)}
                  />
                  <button type="button" className="secondary-button" disabled={!connected || browseLoading} onClick={() => openDirectory(browseInput.trim() || undefined)}>打开</button>
                </div>
              </label>
              <button
                type="button"
                className="secondary-button session-create-parent"
                disabled={!connected || browseLoading || !listing?.parentPath}
                onClick={() => openDirectory(listing!.parentPath)}
              ><ArrowUp size={16} />上级目录</button>
              {browseLoading && <div className="session-create-status" role="status"><LoaderCircle className="is-spinning" size={16} />正在读取文件夹</div>}
              {browseError && <p className="session-create-error" role="alert">{browseError}</p>}
              {listing && !browseLoading && (
                <>
                  <ul className="session-create-directories" aria-label="子文件夹">
                    {listing.directories.map((directory) => (
                      <li key={directory.path}>
                        <button type="button" disabled={!connected} onClick={() => openDirectory(directory.path)}>
                          <Folder size={17} /><span>{directory.name}</span><ChevronRight size={16} />
                        </button>
                      </li>
                    ))}
                    {!listing.directories.length && <li className="session-create-empty">没有子文件夹</li>}
                  </ul>
                  {listing.recentPaths.length > 0 && (
                    <section className="session-create-recent" aria-label="最近使用">
                      <h3>最近使用</h3>
                      <ul className="session-create-directories">
                        {listing.recentPaths.map((path) => (
                          <li key={path}>
                            <button type="button" disabled={!connected} onClick={() => openDirectory(path)}>
                              <History size={16} /><span>{path}</span><ChevronRight size={16} />
                            </button>
                          </li>
                        ))}
                      </ul>
                    </section>
                  )}
                </>
              )}
              <footer className="dialog-actions">
                <button type="button" className="secondary-button" onClick={back}>返回</button>
                <button
                  type="button"
                  className="primary-button"
                  disabled={!connected || browseLoading || !listing || browseInput.trim() !== listing.path}
                  onClick={() => {
                    setCwd(listing!.path);
                    setBrowseTarget(undefined);
                  }}
                >选择此文件夹</button>
              </footer>
            </>
          ) : (
            <>
              <label>
                <span>运行时</span>
                <select
                  aria-label="运行时"
                  value={runtimeId}
                  disabled={locked}
                  autoFocus
                  onChange={(event) => {
                    setRuntimeId(event.target.value as BridgeDesktopRuntimeId);
                    setCwd("");
                    setProjectId("");
                    setError("");
                    setBrowseTarget(undefined);
                    setListing(undefined);
                  }}
                >
                  {runtimeIds.map((id) => {
                    const candidate = snapshot.runtimes?.find((item) => item.id === id);
                    const available = snapshot.runtimes
                      ? candidate?.state === "ready" && candidate.capabilities.includes("session.create")
                      : runtimeAvailable;
                    return <option key={id} value={id} disabled={!available}>{desktopRuntimeName(id)}{available ? "" : "（不可用）"}</option>;
                  })}
                </select>
              </label>
              <div className="session-create-folder">
                <label>
                  <span>工作文件夹</span>
                  <input
                    aria-label="工作文件夹"
                    value={cwd}
                    disabled={locked}
                    placeholder="输入电脑上的绝对路径"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    onChange={(event) => setCwd(event.target.value)}
                  />
                </label>
                {(onChooseDirectory || onBrowseDirectory) && (
                  <button type="button" className="secondary-button" disabled={!connected || locked} onClick={() => void chooseDirectory()}>
                    {choosing ? <LoaderCircle className="is-spinning" size={16} /> : <FolderOpen size={16} />}选择文件夹
                  </button>
                )}
                {folders.length > 0 && (
                  <select
                    aria-label="最近使用的文件夹"
                    value=""
                    disabled={locked}
                    onChange={(event) => setCwd(folders.find((project) => project.projectId === event.target.value)!.cwd)}
                  >
                    <option value="" disabled>最近使用的文件夹</option>
                    {folders.map((project) => <option key={project.projectId} value={project.projectId}>{project.name} — {project.cwd}</option>)}
                  </select>
                )}
              </div>
              <label>
                <span>项目分组（可选）</span>
                <select
                  aria-label="项目分组（可选）"
                  value={projectId}
                  disabled={locked || runtimeId !== "claude-desktop"}
                  onChange={(event) => {
                    setProjectId(event.target.value);
                    if (!cwd.trim()) setCwd(groups.find((project) => project.projectId === event.target.value)?.cwd ?? "");
                  }}
                >
                  <option value="">{runtimeId === "claude-desktop" ? "未分组" : "按工作文件夹归类"}</option>
                  {groupUnavailable && <option value={projectId} disabled>分组已不可用</option>}
                  {groups.length > 0 && (
                    <optgroup label="Desktop 分组">
                      {groups.map((project) => <option key={project.projectId} value={project.projectId}>{project.name}</option>)}
                    </optgroup>
                  )}
                </select>
              </label>
              <label>
                <span>会话名称（可选）</span>
                <input aria-label="会话名称（可选）" value={title} disabled={locked} placeholder="可留空" onChange={(event) => setTitle(event.target.value)} />
              </label>
              {groupUnavailable && <p className="session-create-error" role="alert">所选分组已不可用，请重新选择。</p>}
              {connected && !runtimeAvailable && <p className="session-create-error" role="alert">{desktopRuntimeName(runtimeId)} 当前无法创建会话。</p>}
              {error && <p className="session-create-error" role="alert">{error}</p>}
              <footer className="dialog-actions">
                <button type="button" className="secondary-button" disabled={locked} onClick={onClose}>取消</button>
                <button type="submit" className="primary-button" disabled={!canCreate}>
                  {busy && <LoaderCircle className="is-spinning" size={16} />}创建会话
                </button>
              </footer>
            </>
          )}
          {!connected && <p className="session-create-status" role="status">电脑已离线，连接后可创建会话。</p>}
        </form>
      </section>
    </div>
  );
}
