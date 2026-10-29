import { createContext, lazy, Suspense, useCallback, useContext, useState, type ReactNode } from "react";
import type { MediaRequest, MediaTarget } from "../lib/media-preview.js";

const MediaViewer = lazy(() => import("./MediaViewer.js"));
const MediaPreviewContext = createContext<(target: MediaTarget) => void>(() => undefined);

export function useMediaPreview() {
  return useContext(MediaPreviewContext);
}

export function MediaPreviewProvider({ request, children }: { request: MediaRequest; children: ReactNode }) {
  const [target, setTarget] = useState<MediaTarget>();
  const close = useCallback(() => setTarget(undefined), []);
  return (
    <MediaPreviewContext.Provider value={setTarget}>
      {children}
      {target && (
        <Suspense fallback={<div className="media-viewer-loading" role="status">正在打开查看器…</div>}>
          <MediaViewer key={target.artifactId ?? target.path ?? target.dataUrl} target={target} request={request} onClose={close} />
        </Suspense>
      )}
    </MediaPreviewContext.Provider>
  );
}
