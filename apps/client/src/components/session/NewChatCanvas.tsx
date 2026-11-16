import type { BridgeHostSnapshot, BridgeProjectInfo } from "@bridge/protocol";
import { ArrowUp, ChevronDown, Folder, LoaderCircle, Plus, Sparkles } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { IconButton } from "../common/IconButton.js";
import { MobilePageHeader } from "../mobile/MobilePageHeader.js";
import { SessionProfileSummary } from "./SessionProfileSummary.js";

function formatDisplayDirectory(path: string | undefined): string {
  const trimmed = typeof path === "string" ? path.trim() : "";
  if (!trimmed) return "选择工作目录…";
  const macMatch = /^\/Users\/[^/]+(\/.*)$/u.exec(trimmed);
  if (macMatch) return `~${macMatch[1]}`;
  const linuxMatch = /^\/home\/[^/]+(\/.*)$/u.exec(trimmed);
  if (linuxMatch) return `~${linuxMatch[1]}`;
  return trimmed;
}

export interface NewChatDirectoryPickerRequest {
  initialProjectId?: string | undefined;
  initialCwd?: string | undefined;
  pendingPrompt?: string | undefined;
  onPickDirectory?: ((cwd: string) => void) | undefined;
}

export interface NewChatCanvasProps {
  snapshot: BridgeHostSnapshot | undefined;
  connected: boolean;
  mobile?: boolean | undefined;
  headerLeading?: ReactNode | undefined;
  onBack?: (() => void) | undefined;
  backLabel?: string | undefined;
  runtimeName?: string | undefined;
  onChooseDirectory?(initialPath?: string): Promise<string | undefined>;
  onOpenDirectoryPicker(request?: NewChatDirectoryPickerRequest): void;
  onQuickStart?(cwd: string, prompt: string, projectId?: string): Promise<void>;
}

export function NewChatCanvas({
  snapshot,
  connected,
  mobile = false,
  headerLeading,
  onBack,
  backLabel = "返回会话列表",
  runtimeName = "Claude",
  onChooseDirectory,
  onOpenDirectoryPicker,
  onQuickStart,
}: NewChatCanvasProps) {
  const projects: readonly BridgeProjectInfo[] = (snapshot?.projects ?? []).filter(
    (project) => (project.runtimeId ?? "claude-desktop") === "claude-desktop",
  );
  const defaultFolderProject = [...projects]
    .filter((project) => Boolean(project.cwd?.trim()))
    .sort((left, right) => right.lastActivityAt - left.lastActivityAt)[0];

  const [rawSelectedCwd, setSelectedCwd] = useState<string>(() => defaultFolderProject?.cwd ?? "");
  const [rawSelectedProjectId, setSelectedProjectId] = useState<string>(() => (
    defaultFolderProject?.kind === "desktop-group" ? defaultFolderProject.projectId : ""
  ));
  const [rawPrompt, setPrompt] = useState("");
  const selectedCwd = typeof rawSelectedCwd === "string" ? rawSelectedCwd : (defaultFolderProject?.cwd ?? "");
  const selectedProjectId = typeof rawSelectedProjectId === "string" ? rawSelectedProjectId : "";
  const prompt = typeof rawPrompt === "string" ? rawPrompt : "";
  const [busy, setBusy] = useState(false);
  const [choosingDirectory, setChoosingDirectory] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!selectedCwd && defaultFolderProject?.cwd) {
      setSelectedCwd(defaultFolderProject.cwd);
      if (defaultFolderProject.kind === "desktop-group") {
        setSelectedProjectId(defaultFolderProject.projectId);
      }
    }
  }, [defaultFolderProject?.cwd, defaultFolderProject?.kind, defaultFolderProject?.projectId, selectedCwd]);

  const quickProjects = projects.slice(0, 5);
  const activeChipId = selectedProjectId
    || projects.find((project) => Boolean(project.cwd) && project.cwd === selectedCwd)?.projectId;
  const referenceSession = snapshot?.sessions.find(
    (candidate) => (candidate.runtimeId ?? "claude-desktop") === "claude-desktop"
      && Boolean(
        candidate.model
        || candidate.modelDisplayName
        || candidate.effort
        || candidate.nativePermissionMode,
      ),
  );
  const locked = busy || choosingDirectory;

  function applyChosenDirectory(rawPath: string, overrideProjectId?: string): void {
    const nextCwd = rawPath.trim();
    if (!nextCwd) return;
    setSelectedCwd(nextCwd);
    setError(undefined);
    if (overrideProjectId !== undefined) {
      setSelectedProjectId(overrideProjectId);
      return;
    }
    const matchedGroup = projects.find(
      (project) => project.kind === "desktop-group" && project.cwd === nextCwd,
    );
    if (matchedGroup) {
      setSelectedProjectId(matchedGroup.projectId);
    } else if (selectedProjectId) {
      const currentGroup = projects.find((project) => project.projectId === selectedProjectId);
      if (currentGroup?.cwd?.trim() && currentGroup.cwd !== nextCwd) {
        setSelectedProjectId("");
      }
    }
  }

  async function handleChooseDirectory(targetProjectId?: string): Promise<void> {
    if (!connected || locked) return;
    const effectiveProjectId = targetProjectId ?? (selectedProjectId || undefined);
    if (onChooseDirectory) {
      setChoosingDirectory(true);
      setError(undefined);
      try {
        const chosen = await onChooseDirectory(selectedCwd.trim() || undefined);
        if (chosen?.trim()) {
          applyChosenDirectory(chosen, targetProjectId);
        }
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "文件夹选择失败");
      } finally {
        setChoosingDirectory(false);
      }
      return;
    }
    onOpenDirectoryPicker({
      initialProjectId: effectiveProjectId,
      initialCwd: selectedCwd.trim() || undefined,
      onPickDirectory: (pickedCwd) => applyChosenDirectory(pickedCwd, targetProjectId),
    });
  }

  async function handleSubmit(): Promise<void> {
    const trimmedPrompt = prompt.trim();
    if (!connected || locked || !trimmedPrompt) return;
    const trimmedCwd = selectedCwd.trim();
    if (!trimmedCwd || !onQuickStart) {
      onOpenDirectoryPicker({
        initialProjectId: selectedProjectId || undefined,
        pendingPrompt: trimmedPrompt,
      });
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await onQuickStart(trimmedCwd, trimmedPrompt, selectedProjectId || undefined);
      setPrompt("");
    } catch (reason) {
      const code = reason && typeof reason === "object" && "code" in reason
        ? String((reason as { code?: unknown }).code ?? "")
        : "";
      const message = reason instanceof Error ? reason.message : "会话创建失败";
      if (
        code === "WORKSPACE_TRUST_REQUIRED"
        || code === "WORKSPACE_TRUST_MANUAL_REQUIRED"
        || /\bWorkspaceTrustError\b|\[ccdErrorCategory:trust_required\]/u.test(message)
      ) {
        onOpenDirectoryPicker({
          initialProjectId: selectedProjectId || undefined,
          initialCwd: trimmedCwd,
          pendingPrompt: trimmedPrompt,
        });
      } else {
        setError(message);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={`new-chat-canvas${mobile ? " is-mobile" : " is-desktop"}`}>
      <MobilePageHeader
        navigation={mobile}
        title="新建会话"
        titleHidden
        {...(headerLeading ? { leading: headerLeading } : {})}
        {...(onBack ? { onBack, backLabel } : {})}
        subtitle={(
          <span className="m-presence new-chat-profile-pill">
            {referenceSession ? (
              <SessionProfileSummary session={referenceSession} />
            ) : (
              <span className="session-profile-summary">
                <strong className="session-profile-part is-model">{runtimeName}</strong>
              </span>
            )}
          </span>
        )}
      />

      <div className="new-chat-canvas-body">
        <div className="new-chat-canvas-hero">
          <span className="new-chat-spark" aria-hidden="true">
            <Sparkles size={19} />
          </span>
          <h2>准备在哪个目录开始？</h2>
          <button
            type="button"
            className="new-chat-dir-pill"
            disabled={!connected || locked}
            onClick={() => void handleChooseDirectory()}
          >
            {choosingDirectory ? (
              <LoaderCircle size={15} className="new-chat-dir-icon is-spinning" aria-hidden="true" />
            ) : (
              <Folder size={15} className="new-chat-dir-icon" aria-hidden="true" />
            )}
            <code className="new-chat-dir-path">{formatDisplayDirectory(selectedCwd)}</code>
            <ChevronDown size={13} aria-hidden="true" />
          </button>

          {quickProjects.length > 0 && (
            <div className="new-chat-quick-sections" aria-label="快捷分组">
              <span className="new-chat-quick-label">快捷分组：</span>
              {quickProjects.map((project, index) => {
                const isSelected = activeChipId === project.projectId;
                return (
                  <span className="new-chat-quick-item" key={project.projectId}>
                    {index > 0 && <span className="new-chat-quick-dot" aria-hidden="true">·</span>}
                    <button
                      type="button"
                      className={`new-chat-chip${isSelected ? " active" : ""}`}
                      disabled={!connected || locked}
                      onClick={() => {
                        if (project.cwd?.trim()) {
                          setSelectedCwd(project.cwd);
                          setSelectedProjectId(project.kind === "desktop-group" ? project.projectId : "");
                          setError(undefined);
                        } else {
                          const nextGroupId = project.kind === "desktop-group" ? project.projectId : "";
                          setSelectedProjectId(nextGroupId);
                          if (!selectedCwd.trim()) {
                            void handleChooseDirectory(nextGroupId || undefined);
                          }
                        }
                      }}
                    >
                      {project.name}
                    </button>
                  </span>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <footer className="mobile-composer">
        {error && <div className="composer-error" role="alert">{error}</div>}
        <form
          className="composer-form"
          onSubmit={(event) => {
            event.preventDefault();
            void handleSubmit();
          }}
        >
          <textarea
            rows={mobile ? 2 : 1}
            aria-label={`给 ${runtimeName} 发指令`}
            placeholder="输入问题或任务，按 Enter 在当前目录创建会话..."
            value={prompt}
            disabled={!connected || locked}
            onChange={(event) => {
              setPrompt(event.target.value);
              if (error) setError(undefined);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void handleSubmit();
              }
            }}
          />
          <div className="composer-bar">
            <div className="composer-bar-left">
              <IconButton
                label="选择工作目录"
                className="composer-attach-trigger"
                disabled={!connected || locked}
                onClick={() => void handleChooseDirectory()}
              >
                <Plus size={16} />
              </IconButton>
            </div>
            <div className="composer-bar-right">
              <button
                type="submit"
                className="primary-button send-button"
                aria-label="发送"
                disabled={!connected || locked || !prompt.trim()}
              >
                {busy ? <LoaderCircle className="is-spinning" size={15} /> : <ArrowUp size={16} strokeWidth={2.4} />}
              </button>
            </div>
          </div>
        </form>
      </footer>
    </section>
  );
}
