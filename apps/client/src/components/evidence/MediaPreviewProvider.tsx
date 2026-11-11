import { FILE_PREVIEW_CONFIRM_BYTES, type BridgeArtifactTransferMetadata } from "@bridge/protocol";
import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { formatBytes, type MediaRequest, type MediaTarget } from "../../lib/media-preview.js";
import { registerMobileBackHandler } from "../../lib/mobile-back-navigation.js";
import { ConfirmationDialog } from "../common/ConfirmationDialog.js";

const MediaViewer = lazy(() => import("./MediaViewer.js"));
const MediaPreviewContext = createContext<(target: MediaTarget) => void>(() => undefined);
type FilePreviewTarget = Omit<MediaTarget, "kind">;
const FilePreviewConfirmationContext = createContext<(target: FilePreviewTarget, open: () => void) => void>((_target, open) => open());
const MediaRequestContext = createContext<{
  request: MediaRequest;
  readThumbnail(read: () => Promise<void>): void;
} | undefined>(undefined);

export function useMediaRequest() {
  return useContext(MediaRequestContext)?.request;
}

export function useThumbnailRead() {
  return useContext(MediaRequestContext)?.readThumbnail;
}

export function useMediaPreview() {
  return useContext(MediaPreviewContext);
}

export function useFilePreviewConfirmation() {
  return useContext(FilePreviewConfirmationContext);
}

export function MediaPreviewProvider({ request, supportsFileStat = false, children }: { request: MediaRequest; supportsFileStat?: boolean; children: ReactNode }) {
  const [target, setTarget] = useState<MediaTarget>();
  const [pending, setPending] = useState<{
    target: FilePreviewTarget;
    open(): void;
    metadata?: BridgeArtifactTransferMetadata;
    error?: string;
  }>();
  const close = useCallback(() => setTarget(undefined), []);
  const cancel = useCallback(() => setPending(undefined), []);
  const requestRef = useRef(request);
  requestRef.current = request;
  const confirmPreview = useCallback((target: FilePreviewTarget, open: () => void) => {
    if (target.dataUrl || target.nativeImage) { open(); return; }
    setPending({ target, open });
  }, []);
  const openPreview = useCallback((target: MediaTarget) => confirmPreview(target, () => setTarget(target)), [confirmPreview]);
  const thumbnailRead = useRef(Promise.resolve());
  const readThumbnail = useCallback((read: () => Promise<void>) => {
    // Keep thumbnail leases sequential through close; the owner allows four
    // active transfers, and the viewer can still open alongside a thumbnail.
    thumbnailRead.current = thumbnailRead.current.then(read, read);
  }, []);

  useEffect(() => {
    if (!pending || pending.metadata || pending.error) return;
    // Older hosts interpret unknown purposes as content opens. Never probe them.
    if (!supportsFileStat) {
      setPending({ ...pending, error: "此电脑尚不支持文件大小预检。请更新电脑端 Bridge，然后重新连接再预览。" });
      return;
    }
    let disposed = false;
    void requestRef.current("artifact.transfer.open", {
      ...(pending.target.artifactId ? { artifactId: pending.target.artifactId }
        : { sessionId: pending.target.sessionId, path: pending.target.path?.trim().replace(/:\d+(?::\d+)?$/u, "") }),
      purpose: "stat",
    }, { wait: true, timeoutMs: 60_000 }).then((response) => {
      if (disposed) return;
      if (!response?.ok) throw new Error(response?.error?.message ?? "文件信息读取失败");
      const { metadata } = response.result as { metadata: BridgeArtifactTransferMetadata };
      if (metadata.size > FILE_PREVIEW_CONFIRM_BYTES) setPending({ ...pending, metadata });
      else { setPending(undefined); pending.open(); }
    }).catch((error: unknown) => {
      if (!disposed) setPending({ ...pending, error: error instanceof Error ? error.message : "文件信息读取失败" });
    });
    return () => { disposed = true; };
  }, [pending, supportsFileStat]);

  useEffect(() => {
    if (!pending) return;
    const unregister = registerMobileBackHandler(() => { cancel(); return true; }, 310);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); cancel(); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => { unregister(); window.removeEventListener("keydown", onKeyDown); };
  }, [pending, cancel]);

  return (
    <MediaRequestContext.Provider value={{ request, readThumbnail }}>
      <FilePreviewConfirmationContext.Provider value={confirmPreview}>
        <MediaPreviewContext.Provider value={openPreview}>
          {children}
          {pending && !pending.metadata && !pending.error && <div className="media-viewer-loading" role="status">
            <span>正在读取文件信息…</span><button className="secondary-button" onClick={cancel}>取消</button>
          </div>}
          <ConfirmationDialog
            open={Boolean(pending?.metadata || pending?.error)}
            title={pending?.error ? "文件预览失败" : "下载大文件预览？"}
            description={pending?.error ?? (pending?.metadata
              ? `「${pending.metadata.name}」大小为 ${formatBytes(pending.metadata.size)}（${pending.metadata.size.toLocaleString("zh-CN")} 字节）。预览需要下载文件数据，会消耗流量。`
              : "")}
            confirmLabel={pending?.error ? "重试" : "下载并预览"}
            onCancel={cancel}
            onConfirm={() => {
              if (!pending) return;
              if (pending.error) { setPending({ target: pending.target, open: pending.open }); return; }
              setPending(undefined);
              pending.open();
            }}
          />
          {target && (
            <Suspense fallback={<div className="media-viewer-loading" role="status">正在打开查看器…</div>}>
              <MediaViewer key={target.nativeImage ? `${target.sessionId}:${target.nativeImage.messageUuid}:${target.nativeImage.imageIndex}` : target.artifactId ?? target.path ?? target.dataUrl} target={target} request={request} onClose={close} />
            </Suspense>
          )}
        </MediaPreviewContext.Provider>
      </FilePreviewConfirmationContext.Provider>
    </MediaRequestContext.Provider>
  );
}
