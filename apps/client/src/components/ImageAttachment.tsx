import type { BridgeHistoryAttachment } from "@bridge/protocol";
import { AlertTriangle, LoaderCircle } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { openMediaTransfer, type MediaTarget } from "../lib/media-preview.js";
import { useMediaPreview, useMediaRequest, useThumbnailRead } from "./MediaPreviewProvider.js";

export function ImageAttachment({ attachment, sessionId }: { attachment: BridgeHistoryAttachment; sessionId: string }) {
  const openMedia = useMediaPreview();
  const request = useMediaRequest();
  const readThumbnail = useThumbnailRead();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dataUrl = attachment.data ? `data:${attachment.mimeType};base64,${attachment.data}` : undefined;
  const target: MediaTarget = useMemo(() => ({
    name: attachment.name, kind: "image", sessionId,
    ...(attachment.nativeImage ? { nativeImage: attachment.nativeImage } : {}),
    ...(dataUrl ? { dataUrl } : {}),
  }), [attachment.name, sessionId, attachment.nativeImage?.messageUuid, attachment.nativeImage?.imageIndex, dataUrl]);
  const [url, setUrl] = useState(dataUrl);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setUrl(dataUrl);
    setError("");
    if (dataUrl || !target.nativeImage || !request || !readThumbnail) return;
    let disposed = false;
    let objectUrl: string | undefined;
    async function load() {
      if (disposed) return;
      let source: Awaited<ReturnType<typeof openMediaTransfer>> | undefined;
      try {
        source = await openMediaTransfer(target, request!);
        if (disposed) return;
        const bytes = await source.read(0, source.transfer.size);
        if (disposed) return;
        objectUrl = URL.createObjectURL(new Blob([Uint8Array.from(bytes).buffer], { type: source.transfer.mimeType }));
        setUrl(objectUrl);
      } catch (failure) {
        if (!disposed) setError(failure instanceof Error ? failure.message : "图片加载失败");
      } finally {
        // Leases also expire on the host if the connection is lost during close.
        await source?.close().catch(() => undefined);
      }
    }
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      readThumbnail(load);
    });
    observer.observe(buttonRef.current!);
    return () => {
      disposed = true;
      observer.disconnect();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [target, request, readThumbnail, dataUrl, attempt]);

  return (
    <button ref={buttonRef} type="button" className={`conversation-image-preview${!url || error ? " is-placeholder" : ""}`}
      aria-label={`${error ? "重试" : "查看"} ${attachment.name}`} aria-busy={!url && !error}
      title={error || attachment.name}
      onClick={() => error ? setAttempt(value => value + 1) : openMedia({ ...target, ...(url ? { dataUrl: url } : {}) })}>
      {error ? <><AlertTriangle size={18} aria-hidden="true" /><span>加载失败，重试</span></>
        : url ? <img src={url} alt={attachment.name} loading="lazy" onError={() => setError("图片加载失败")} />
        : <LoaderCircle className="spin" size={20} aria-hidden="true" />}
    </button>
  );
}
