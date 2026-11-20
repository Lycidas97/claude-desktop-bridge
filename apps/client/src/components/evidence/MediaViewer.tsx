import { AlertTriangle, ChevronLeft, ChevronRight, Download, LoaderCircle, Maximize, RotateCw, X, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type TouchEvent } from "react";
import { flushSync } from "react-dom";
import type { BridgeArtifactPreview } from "@bridge/protocol";
import type { PDFDocumentProxy, PDFDocumentLoadingTask } from "pdfjs-dist";
import { saveMediaTarget } from "../../lib/artifact-download.js";
import { openMediaTransfer, readTextPreview, textPreviewLanguage, type MediaRequest, type MediaTarget } from "../../lib/media-preview.js";
import { registerMobileBackHandler } from "../../lib/mobile-back-navigation.js";
import { IconButton } from "../common/IconButton.js";
import { MessageCopyButton } from "../common/MessageCopyButton.js";
import { TextPreview } from "./TextPreview.js";

type Point = { x: number; y: number };
type Size = { width: number; height: number };

function mediaAnchor(bounds: DOMRect, point: Point): Point {
  return { x: (point.x - bounds.left) / bounds.width, y: (point.y - bounds.top) / bounds.height };
}

export default function MediaViewer({ target, request, onClose }: { target: MediaTarget; request: MediaRequest; onClose(): void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lastTouch = useRef<Point | undefined>(undefined);
  const pinch = useRef<{ distance: number; zoom: number; anchor: Point } | undefined>(undefined);
  const [imageUrl, setImageUrl] = useState(target.dataUrl);
  const [imageSize, setImageSize] = useState<Size>();
  const [text, setText] = useState<string>();
  const [showSource, setShowSource] = useState(false);
  const markdown = target.kind === "text" && !target.mailAttachment && textPreviewLanguage(target.name) === "markdown";
  const [pdf, setPdf] = useState<PDFDocumentProxy>();
  const [pdfProgress, setPdfProgress] = useState<{ loaded: number; total: number }>();
  const [pageNumber, setPageNumber] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [pdfZoom, setPdfZoom] = useState(1);
  const [pdfSize, setPdfSize] = useState<Size>();
  const [rotation, setRotation] = useState(0);
  const [{ width, height }, setViewportSize] = useState<Size>({ width: 0, height: 0 });
  const [busy, setBusy] = useState(!target.dataUrl);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const requestRef = useRef(request);
  requestRef.current = request;

  useEffect(() => {
    dialogRef.current?.showModal();
    return registerMobileBackHandler(() => { onClose(); return true; }, 300);
  }, [onClose]);

  useEffect(() => {
    if (target.kind === "text") return;
    const viewport = viewportRef.current!;
    // Fit against the same area before and after classic scrollbars appear.
    const observer = new ResizeObserver(([entry]) => {
      const { inlineSize, blockSize } = entry!.borderBoxSize[0]!;
      const inset = Number.parseFloat(getComputedStyle(viewport).paddingTop) * 2;
      setViewportSize({ width: inlineSize - inset, height: blockSize - inset });
    });
    observer.observe(viewport, { box: "border-box" });
    return () => observer.disconnect();
  }, [target.kind]);

  useEffect(() => {
    let disposed = false;
    let transfer: Awaited<ReturnType<typeof openMediaTransfer>> | undefined;
    let loadingTask: PDFDocumentLoadingTask | undefined;
    let objectUrl: string | undefined;
    setError("");
    setBusy(!target.dataUrl);
    setPdfProgress(undefined);
    async function load() {
      if (target.dataUrl) return;
      if (target.kind === "image" && (target.mailAttachment || target.artifactId && !/\.svg$/iu.test(target.name))) {
        const response = await requestRef.current("artifact.preview", target.mailAttachment ? { mailAttachment: target.mailAttachment } : { artifactId: target.artifactId }, { wait: true, timeoutMs: 60_000 });
        if (!response?.ok) throw new Error(response?.error?.message ?? "图片预览失败");
        const { preview } = response.result as { preview: BridgeArtifactPreview };
        if (!disposed) { setImageUrl(`data:${preview.mimeType};base64,${preview.data}`); setBusy(false); }
        return;
      }
      transfer = await openMediaTransfer(target, requestRef.current, target.kind === "pdf" ? (loaded, total) => {
        if (!disposed) setPdfProgress({ loaded, total });
      } : undefined);
      if (disposed) { await transfer.close(); transfer = undefined; return; }
      const source = transfer;
      if (target.kind === "text") {
        const content = await readTextPreview(source, target.charset);
        if (!disposed) { setText(content); setBusy(false); }
        return;
      }
      if (target.kind === "image") {
        const bytes = await source.read(0, source.transfer.size);
        if (disposed) return;
        objectUrl = URL.createObjectURL(new Blob([Uint8Array.from(bytes).buffer], { type: /\.svg$/iu.test(target.name) ? "image/svg+xml" : source.transfer.mimeType }));
        setImageUrl(objectUrl);
        setBusy(false);
        return;
      }
      const pdfjs = await import("pdfjs-dist");
      const { default: workerUrl } = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
      if (disposed) return;
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      class BridgePdfRange extends pdfjs.PDFDataRangeTransport {
        requestDataRange(begin: number, end: number) {
          void source.read(begin, end).then((bytes) => {
            if (!disposed) this.onDataRange(begin, bytes);
          }).catch((failure: unknown) => {
            if (!disposed) {
              setError(failure instanceof Error ? failure.message : "PDF 读取失败");
              setBusy(false);
              void loadingTask?.destroy();
            }
          });
        }
      }
      loadingTask = pdfjs.getDocument({
        range: new BridgePdfRange(source.transfer.size, new Uint8Array(), true),
        rangeChunkSize: source.transfer.chunkBytes,
        disableAutoFetch: true,
        disableStream: true,
        cMapUrl: new URL("pdfjs/cmaps/", document.baseURI).href,
        cMapPacked: true,
        standardFontDataUrl: new URL("pdfjs/standard_fonts/", document.baseURI).href,
        wasmUrl: new URL("pdfjs/wasm/", document.baseURI).href,
        useSystemFonts: true,
      });
      const pdfDocument = await loadingTask.promise;
      if (!disposed) setPdf(pdfDocument);
    }
    void load().catch((failure: unknown) => {
      if (!disposed) { setError(failure instanceof Error ? failure.message : "文件预览失败"); setBusy(false); }
    });
    return () => {
      disposed = true;
      void loadingTask?.destroy();
      // The host also expires leases if the connection is lost while closing.
      void transfer?.close().catch(() => undefined);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [target, attempt]);

  useEffect(() => {
    if (!pdf || !width) return;
    let disposed = false;
    let renderTask: ReturnType<Awaited<ReturnType<PDFDocumentProxy["getPage"]>>["render"]> | undefined;
    setError("");
    void pdf.getPage(pageNumber).then(async (page) => {
      if (disposed) return;
      const base = page.getViewport({ scale: 1, rotation });
      const fit = Math.min((width - 32) / base.width, 1.6);
      setPdfSize({ width: base.width * fit, height: base.height * fit });
      const viewport = page.getViewport({ scale: fit * pdfZoom, rotation });
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      // Keep the last bitmap visible until the sharper one is ready.
      const bitmap = document.createElement("canvas");
      bitmap.width = Math.floor(viewport.width * ratio);
      bitmap.height = Math.floor(viewport.height * ratio);
      renderTask = page.render({ canvas: bitmap, viewport, transform: [ratio, 0, 0, ratio, 0, 0] });
      await renderTask.promise;
      if (disposed) return;
      const canvas = canvasRef.current!;
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
      bitmap.width = 0;
      setBusy(false);
    }).catch((failure: unknown) => {
      if (!disposed) { setError(failure instanceof Error ? failure.message : "PDF 页面显示失败"); setBusy(false); }
    });
    return () => { disposed = true; renderTask?.cancel(); };
  }, [pdf, pageNumber, width, pdfZoom, rotation]);

  async function save() {
    setSaving(true);
    setSaveError("");
    try {
      await saveMediaTarget(target, request);
    } catch (failure) {
      setSaveError(failure instanceof Error ? failure.message : "文件保存失败");
    } finally {
      setSaving(false);
    }
  }

  function resetPosition() {
    stageRef.current!.style.removeProperty("--media-x");
    stageRef.current!.style.removeProperty("--media-y");
    viewportRef.current!.scrollTo(0, 0);
  }

  function changePage(value: number) {
    const next = Math.min(pdf?.numPages ?? 1, Math.max(1, value));
    if (next === pageNumber) return;
    setBusy(true);
    setPageNumber(next);
    resetPosition();
  }

  function rotatePage(next: number) {
    if (pdf) setBusy(true);
    setRotation(next);
    resetPosition();
  }

  function positionMedia(stage: HTMLDivElement, media: DOMRect, point: Point, anchor: Point) {
    const frame = stage.getBoundingClientRect();
    const x = point.x - frame.left - anchor.x * media.width;
    const y = point.y - frame.top - anchor.y * media.height;
    const spareWidth = frame.width - media.width;
    const spareHeight = frame.height - media.height;
    const insetX = Math.max(0, Math.min(x, spareWidth));
    const insetY = Math.max(0, Math.min(y, spareHeight));
    // Place the media in the available space on fitted axes; scroll on overflow.
    if (spareWidth > 0) stage.style.setProperty("--media-x", String(insetX / spareWidth));
    if (spareHeight > 0) stage.style.setProperty("--media-y", String(insetY / spareHeight));
    viewportRef.current!.scrollBy(insetX - x, insetY - y);
  }

  function zoomAt(value: number, point?: Point, anchor?: Point) {
    const next = Math.min(3, Math.max(0.5, value));
    const viewport = viewportRef.current!;
    const stage = stageRef.current!;
    const media = stage.firstElementChild;
    const before = media?.getBoundingClientRect();
    if (!media || !before?.width || !before.height) {
      setZoom(next);
      return next;
    }
    if (!point) {
      const bounds = viewport.getBoundingClientRect();
      point = {
        x: (Math.max(bounds.left, before.left) + Math.min(bounds.left + viewport.clientWidth, before.right)) / 2,
        y: (Math.max(bounds.top, before.top) + Math.min(bounds.top + viewport.clientHeight, before.bottom)) / 2,
      };
    }
    anchor ??= mediaAnchor(before, point);
    // Commit the new layout before measuring its origin and overflow.
    if (next !== zoom) flushSync(() => setZoom(next));
    positionMedia(stage, media.getBoundingClientRect(), point, anchor);
    return next;
  }

  function changeZoom(value: number) {
    const next = zoomAt(value);
    if (target.kind === "pdf") setPdfZoom(next);
  }

  function handleTouch(event: TouchEvent<HTMLDivElement>) {
    const viewport = event.currentTarget;
    const [first, second] = Array.from(event.touches).filter((touch) => touch.target instanceof Node && viewport.contains(touch.target));
    const previous = lastTouch.current;
    lastTouch.current = first && { x: first.clientX, y: first.clientY };
    if (!second && pinch.current) {
      pinch.current = undefined;
      if (target.kind === "pdf") setPdfZoom(zoom);
    }
    if (busy || error || !first) return;
    const stage = stageRef.current!;
    if (second) {
      const center = { x: (first.clientX + second.clientX) / 2, y: (first.clientY + second.clientY) / 2 };
      const distance = Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY);
      if (!pinch.current) {
        const bounds = stage.firstElementChild?.getBoundingClientRect();
        if (distance && bounds?.width && bounds.height) pinch.current = { distance, zoom, anchor: mediaAnchor(bounds, center) };
      } else if (event.type === "touchmove") {
        zoomAt(pinch.current.zoom * distance / pinch.current.distance, center, pinch.current.anchor);
      }
    } else if (event.type === "touchmove" && previous) {
      const x = first.clientX - previous.x;
      const y = first.clientY - previous.y;
      const bounds = stage.firstElementChild?.getBoundingClientRect();
      if (zoom > 1 && bounds) positionMedia(stage, bounds, { x: bounds.left + x, y: bounds.top + y }, { x: 0, y: 0 });
      else viewport.scrollBy(-x, -y);
    }
  }

  let fittedSize = pdfSize;
  if (imageSize && width > 0 && height > 0) {
    const fit = Math.min(1, width / imageSize.width, height / imageSize.height);
    fittedSize = { width: imageSize.width * fit, height: imageSize.height * fit };
  }
  const stageStyle = fittedSize && {
    "--media-width": `${fittedSize.width * zoom}px`,
    "--media-height": `${fittedSize.height * zoom}px`,
  } as CSSProperties;

  return (
    <dialog ref={dialogRef} className="media-viewer" aria-labelledby="media-viewer-title" onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="media-viewer-shell">
        <header>
          <div><span>{target.kind === "pdf" ? "PDF" : target.kind === "text" ? (markdown ? "Markdown" : "文本") : "图片"}</span><h2 id="media-viewer-title">{target.name}</h2></div>
          <div className="media-viewer-actions">
            {target.kind !== "text" && target.downloadAllowed !== false && <IconButton label="保存到本地" disabled={saving} onClick={() => void save()}>
              {saving ? <LoaderCircle className="is-spinning" size={20} /> : <Download size={20} />}
            </IconButton>}
            <IconButton label="关闭查看器" onClick={onClose}><X size={21} /></IconButton>
          </div>
        </header>
        <div className="media-viewer-toolbar">
          {target.kind === "text" && (markdown ? <div className="text-preview-tabs" role="tablist" aria-label="Markdown 显示方式">
            <button id="text-preview-rendered-tab" type="button" role="tab" aria-selected={!showSource} aria-controls="text-preview-content" tabIndex={showSource ? -1 : 0} onClick={() => setShowSource(false)} onKeyDown={(event) => { if (event.key === "ArrowRight" || event.key === "End") { setShowSource(true); document.getElementById("text-preview-source-tab")?.focus(); event.preventDefault(); } }}>预览</button>
            <button id="text-preview-source-tab" type="button" role="tab" aria-selected={showSource} aria-controls="text-preview-content" tabIndex={showSource ? 0 : -1} onClick={() => setShowSource(true)} onKeyDown={(event) => { if (event.key === "ArrowLeft" || event.key === "Home") { setShowSource(false); document.getElementById("text-preview-rendered-tab")?.focus(); event.preventDefault(); } }}>源码</button>
          </div> : <span className="text-preview-format">{target.mailAttachment ? "纯文本" : textPreviewLanguage(target.name) ?? "纯文本"}</span>)}
          {target.kind === "text" && !busy && !error && text !== undefined && <MessageCopyButton text={text} label="复制文件内容" />}
          {target.kind === "pdf" && <div className="media-page-controls">
            <IconButton label="上一页" disabled={!pdf || pageNumber === 1 || busy} onClick={() => changePage(pageNumber - 1)}><ChevronLeft size={19} /></IconButton>
            <label><input aria-label="页码" type="number" min={1} max={pdf?.numPages ?? 1} value={pageNumber} onChange={(event) => changePage(Number(event.target.value) || 1)} /><span>/ {pdf?.numPages ?? "…"}</span></label>
            <IconButton label="下一页" disabled={!pdf || pageNumber === pdf.numPages || busy} onClick={() => changePage(pageNumber + 1)}><ChevronRight size={19} /></IconButton>
          </div>}
          {target.kind !== "text" && <div className="media-zoom-controls">
            <IconButton label="缩小" disabled={zoom <= 0.5} onClick={() => changeZoom(zoom - 0.25)}><ZoomOut size={18} /></IconButton>
            <span>{Math.round(zoom * 100)}%</span>
            <IconButton label="放大" disabled={zoom >= 3} onClick={() => changeZoom(zoom + 0.25)}><ZoomIn size={18} /></IconButton>
            <IconButton label="适合窗口" onClick={() => {
              setZoom(1);
              if (target.kind === "pdf") setPdfZoom(1);
              if (rotation) rotatePage(0);
              else resetPosition();
            }}><Maximize size={17} /></IconButton>
            {target.kind === "pdf" && <IconButton label="旋转页面" onClick={() => rotatePage((rotation + 90) % 360)}><RotateCw size={17} /></IconButton>}
          </div>}
        </div>
        <div ref={viewportRef} className={`media-viewer-viewport ${target.kind}`} {...(target.kind !== "text" && {
          onTouchStart: handleTouch, onTouchMove: handleTouch, onTouchEnd: handleTouch, onTouchCancel: handleTouch,
        })}>
          {busy && <div className="media-viewer-status" role="status">
            <LoaderCircle className="is-spinning" size={22} />
            <span>{pdf ? `正在${pdfProgress && pdfProgress.loaded === pdfProgress.total ? "渲染" : "加载"}第 ${pageNumber} 页…` : "正在加载预览…"}</span>
            {pdfProgress && pdfProgress.total > 0 && <>
              <progress aria-label="PDF文件读取进度" value={pdfProgress.loaded} max={pdfProgress.total} />
              <small>文件已读取 {(pdfProgress.loaded / 1024 / 1024).toFixed(1)} / {(pdfProgress.total / 1024 / 1024).toFixed(1)} MiB</small>
            </>}
          </div>}
          {error && <div className="media-viewer-status" role="alert"><AlertTriangle size={22} /><span>{error}</span><button className="secondary-button" onClick={() => { setPdf(undefined); setAttempt((value) => value + 1); }}>重新加载</button></div>}
          {target.kind === "text" ? (!busy && !error && text !== undefined && <div id="text-preview-content" role={markdown ? "tabpanel" : undefined} aria-labelledby={markdown ? (showSource ? "text-preview-source-tab" : "text-preview-rendered-tab") : undefined} tabIndex={0}>
            {target.mailAttachment ? <pre className="text-preview-source text-preview-mail" aria-label={`${target.name} 全文`}><code>{text}</code></pre> : <TextPreview text={text} name={target.name} source={showSource} />}
          </div>) : <div ref={stageRef} className="media-viewer-stage" style={stageStyle}>
            {target.kind === "pdf" ? <canvas ref={canvasRef} aria-label={`${target.name} 第 ${pageNumber} 页`} style={{ visibility: busy || error ? "hidden" : "visible" }} /> : imageUrl && <img src={imageUrl} alt={target.name}
              onLoad={({ currentTarget }) => setImageSize({ width: currentTarget.naturalWidth, height: currentTarget.naturalHeight })}
              onError={() => { setError("图片无法显示，请重新加载"); setBusy(false); }} />}
          </div>}
        </div>
        <footer>{saveError ? <span role="alert">保存失败：{saveError}</span> : saving ? <span role="status">正在保存…</span>
          : target.kind === "text" ? `${text === "" && !busy && !error ? "空文件" : "全文预览"} · ${target.charset?.toUpperCase() ?? "UTF-8"}`
            : target.kind === "pdf" ? "按需读取页面内容" : "双指或按钮缩放"}</footer>
      </div>
    </dialog>
  );
}
