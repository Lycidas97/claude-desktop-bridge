import { createContext, lazy, Suspense, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import type { MediaRequest, MediaTarget } from "../lib/media-preview.js";

const MediaViewer = lazy(() => import("./MediaViewer.js"));
const MediaPreviewContext = createContext<(target: MediaTarget) => void>(() => undefined);
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

export function MediaPreviewProvider({ request, children }: { request: MediaRequest; children: ReactNode }) {
  const [target, setTarget] = useState<MediaTarget>();
  const close = useCallback(() => setTarget(undefined), []);
  const thumbnailRead = useRef(Promise.resolve());
  const readThumbnail = useCallback((read: () => Promise<void>) => {
    // Keep thumbnail leases sequential through close; the owner allows four
    // active transfers, and the viewer can still open alongside a thumbnail.
    thumbnailRead.current = thumbnailRead.current.then(read, read);
  }, []);
  return (
    <MediaRequestContext.Provider value={{ request, readThumbnail }}>
      <MediaPreviewContext.Provider value={setTarget}>
        {children}
        {target && (
          <Suspense fallback={<div className="media-viewer-loading" role="status">正在打开查看器…</div>}>
            <MediaViewer key={target.nativeImage ? `${target.sessionId}:${target.nativeImage.messageUuid}:${target.nativeImage.imageIndex}` : target.artifactId ?? target.path ?? target.dataUrl} target={target} request={request} onClose={close} />
          </Suspense>
        )}
      </MediaPreviewContext.Provider>
    </MediaRequestContext.Provider>
  );
}
