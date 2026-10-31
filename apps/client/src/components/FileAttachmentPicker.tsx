import type { BridgeUploadedFile } from "@bridge/protocol";
import { FileUp, ImagePlus, LoaderCircle, Paperclip, Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { UploadFileHandler } from "../lib/file-upload.js";
import { registerMobileBackHandler } from "../lib/mobile-back-navigation.js";
import { IconButton } from "./IconButton.js";
import "./FileAttachmentPicker.css";

interface FileEntry {
  id: string;
  sessionId: string;
  name: string;
  size: number;
  progress: number;
  result?: BridgeUploadedFile;
  error?: string;
}

export function useFileAttachments(sessionId: string | undefined, onUploadFile: UploadFileHandler | undefined) {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const controllers = useRef(new Map<string, AbortController>());
  useEffect(() => () => {
    for (const controller of controllers.current.values()) controller.abort();
  }, []);

  const selectedEntries = entries.filter((entry) => entry.sessionId === sessionId);
  return {
    entries: selectedEntries,
    files: selectedEntries.flatMap((entry) => entry.result ? [entry.result] : []),
    uploading: selectedEntries.some((entry) => !entry.result && !entry.error),
    async add(files: FileList | null) {
      if (!sessionId || !onUploadFile || !files?.length) return;
      const selectedFiles = Array.from(files, (file) => ({ file, id: crypto.randomUUID(), controller: new AbortController() }));
      for (const item of selectedFiles) controllers.current.set(item.id, item.controller);
      setEntries((current) => [...current, ...selectedFiles.map(({ file, id }) => ({
        id, sessionId, name: file.name, size: file.size, progress: 0,
      }))]);
      for (const { file, id, controller } of selectedFiles) {
        try {
          controller.signal.throwIfAborted();
          const result = await onUploadFile(sessionId, file, (progress) => {
            setEntries((current) => current.map((entry) => entry.id === id ? { ...entry, progress } : entry));
          }, controller.signal);
          setEntries((current) => current.map((entry) => entry.id === id ? { ...entry, result, progress: 1 } : entry));
        } catch (error) {
          if (!controller.signal.aborted) {
            setEntries((current) => current.map((entry) => entry.id === id
              ? { ...entry, error: error instanceof Error ? error.message : "文件上传失败" } : entry));
          }
        } finally {
          controllers.current.delete(id);
        }
      }
    },
    remove(id: string) {
      controllers.current.get(id)?.abort();
      setEntries((current) => current.filter((entry) => entry.id !== id));
    },
    clear(files: BridgeUploadedFile[]) {
      setEntries((current) => current.filter((entry) => !files.some((file) => file.uploadId === entry.result?.uploadId)));
    },
  };
}

export function FileAttachmentPicker({ state }: {
  state: ReturnType<typeof useFileAttachments>;
}) {
  if (state.entries.length === 0) return null;
  return (
    <div className="file-attachment-picker">
      <ul className="file-upload-list" aria-label="待发送文件">
        {state.entries.map((entry) => (
          <li key={entry.id} className={entry.error ? "file-upload-entry is-error" : "file-upload-entry"}>
            {!entry.result && !entry.error ? <LoaderCircle size={16} className="is-spinning" /> : <FileUp size={16} />}
            <div className="file-upload-details">
              <span className="file-upload-name" title={entry.result?.path ?? entry.name}>{entry.name}</span>
              <span className="file-upload-status" role={entry.error ? "alert" : "status"}>
                {entry.error ?? (entry.result ? "已上传，发送时附上路径" : entry.progress >= 0.99 ? "正在保存…" : `上传中 ${Math.floor(entry.progress * 100)}%`)}
                {!entry.error && ` · ${entry.size < 1024 * 1024 ? `${(entry.size / 1024).toFixed(1)} KiB` : `${(entry.size / (1024 * 1024)).toFixed(1)} MiB`}`}
              </span>
              {!entry.result && !entry.error && <progress value={entry.progress} max={1} aria-label={`${entry.name} 上传进度`} />}
            </div>
            <IconButton
              label={`移除 ${entry.name}`}
              title={entry.result ? "从消息移除，已上传文件仍保留在会话目录" : "取消上传并移除"}
              onClick={() => state.remove(entry.id)}
            ><X size={14} /></IconButton>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ComposerAttachmentMenu({
  canAttachImages = false,
  imageDisabled = false,
  onPickImages,
  fileUploads,
  fileDisabled = false,
}: {
  canAttachImages?: boolean;
  imageDisabled?: boolean;
  onPickImages?: () => void;
  fileUploads?: ReturnType<typeof useFileAttachments>;
  fileDisabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const hasImageOption = Boolean(canAttachImages && onPickImages);
  const hasFileOption = Boolean(fileUploads);
  const fileOptionDisabled = fileDisabled || Boolean(fileUploads?.uploading);
  const triggerDisabled = (!hasImageOption || imageDisabled) && (!hasFileOption || fileOptionDisabled);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (containerRef.current && event.target instanceof Node && !containerRef.current.contains(event.target)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    const unregisterBack = registerMobileBackHandler(() => {
      setOpen(false);
      return true;
    }, 140);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      unregisterBack();
    };
  }, [open]);

  useEffect(() => {
    if (triggerDisabled && open) setOpen(false);
  }, [triggerDisabled, open]);

  if (!hasImageOption && !hasFileOption) return null;

  return (
    <div className="composer-attach-control" ref={containerRef}>
      {fileUploads && (
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          disabled={fileOptionDisabled}
          aria-label="选择要上传的文件"
          onChange={(event) => {
            void fileUploads.add(event.target.files);
            event.target.value = "";
          }}
        />
      )}
      <button
        type="button"
        className={`icon-button composer-attach-trigger${open ? " is-open" : ""}`}
        aria-label="添加附件"
        title="添加图片或文件"
        aria-expanded={open}
        aria-haspopup="menu"
        disabled={triggerDisabled}
        onClick={() => setOpen((current) => !current)}
      >
        <Plus size={20} />
      </button>
      {open && (
        <div className="composer-attach-menu" role="menu" aria-label="添加附件选项">
          {hasImageOption && (
            <button
              type="button"
              role="menuitem"
              className="composer-attach-option"
              disabled={imageDisabled}
              onClick={() => {
                setOpen(false);
                onPickImages?.();
              }}
            >
              <ImagePlus size={16} />
              <span className="composer-attach-option-text">
                <strong>添加图片</strong>
                <small>JPG / PNG / GIF / WebP</small>
              </span>
            </button>
          )}
          {fileUploads && (
            <button
              type="button"
              role="menuitem"
              className="composer-attach-option"
              disabled={fileOptionDisabled}
              onClick={() => {
                setOpen(false);
                fileInputRef.current?.click();
              }}
            >
              <Paperclip size={16} />
              <span className="composer-attach-option-text">
                <strong>添加文件</strong>
                <small>单文件 ≤20 MiB · 上传到会话目录</small>
              </span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
