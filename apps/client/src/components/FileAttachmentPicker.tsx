import type { BridgeUploadedFile } from "@bridge/protocol";
import { FileUp, LoaderCircle, Paperclip, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { UploadFileHandler } from "../lib/file-upload.js";
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

export function FileAttachmentPicker({ state, disabled = false }: {
  state: ReturnType<typeof useFileAttachments>;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="file-attachment-picker">
      <div className="file-upload-actions">
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          disabled={disabled || state.uploading}
          aria-label="选择要上传的文件"
          onChange={(event) => {
            void state.add(event.target.files);
            event.target.value = "";
          }}
        />
        <button type="button" className="file-upload-trigger" disabled={disabled || state.uploading} onClick={() => inputRef.current?.click()}>
          <Paperclip size={15} />添加文件
        </button>
        <span>每个文件 ≤20 MiB · 上传到会话目录</span>
      </div>
      {state.entries.length > 0 && (
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
                disabled={disabled}
                onClick={() => state.remove(entry.id)}
              ><X size={14} /></IconButton>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
