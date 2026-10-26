import { AlertTriangle, ChevronLeft, ChevronRight, LoaderCircle, Maximize, RotateCw, X, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { BridgeArtifactPreview } from "@bridge/protocol";
import type { PDFDocumentProxy, PDFDocumentLoadingTask } from "pdfjs-dist";
import { openMediaTransfer, type MediaRequest, type MediaTarget } from "../lib/media-preview.js";
import { registerMobileBackHandler } from "../lib/mobile-back-navigation.js";
import { IconButton } from "./IconButton.js";

export default function MediaViewer({ target, request, onClose }: { target: MediaTarget; request: MediaRequest; onClose(): void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [imageUrl, setImageUrl] = useState(target.dataUrl);
  const [pdf, setPdf] = useState<PDFDocumentProxy>();
  const [pageNumber, setPageNumber] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [width, setWidth] = useState(0);
  const [busy, setBusy] = useState(!target.dataUrl);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const requestRef = useRef(request);
  requestRef.current = request;

  useEffect(() => {
    dialogRef.current?.showModal();
    return registerMobileBackHandler(() => { onClose(); return true; }, 300);
  }, [onClose]);

  useEffect(() => {
    const viewport = viewportRef.current!;
    const observer = new ResizeObserver(([entry]) => setWidth(entry!.contentRect.width));
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let disposed = false;
    let transfer: Awaited<ReturnType<typeof openMediaTransfer>> | undefined;
    let loadingTask: PDFDocumentLoadingTask | undefined;
    let objectUrl: string | undefined;
    setError("");
    setBusy(!target.dataUrl);
    async function load() {
      if (target.dataUrl) return;
      if (target.kind === "image" && target.artifactId && !/\.svg$/iu.test(target.name)) {
        const response = await requestRef.current("artifact.preview", { artifactId: target.artifactId }, { wait: true, timeoutMs: 60_000 });
        if (!response?.ok) throw new Error(response?.error?.message ?? "图片预览失败");
        const { preview } = response.result as { preview: BridgeArtifactPreview };
        if (!disposed) { setImageUrl(`data:${preview.mimeType};base64,${preview.data}`); setBusy(false); }
        return;
      }
      transfer = await openMediaTransfer(target, requestRef.current);
      if (disposed) { await transfer.close(); transfer = undefined; return; }
      const source = transfer;
      if (target.kind === "image") {
        const bytes = await source.read(0, source.transfer.size);
        if (disposed) return;
        objectUrl = URL.createObjectURL(new Blob([Uint8Array.from(bytes).buffer], { type: source.transfer.mimeType }));
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
    setBusy(true);
    setError("");
    void pdf.getPage(pageNumber).then(async (page) => {
      if (disposed) return;
      const base = page.getViewport({ scale: 1, rotation });
      const viewport = page.getViewport({ scale: Math.min((width - 32) / base.width, 1.6) * zoom, rotation });
      const canvas = canvasRef.current!;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      renderTask = page.render({ canvas, viewport, transform: [ratio, 0, 0, ratio, 0, 0] });
      await renderTask.promise;
      if (!disposed) { setBusy(false); viewportRef.current?.scrollTo(0, 0); }
    }).catch((failure: unknown) => {
      if (!disposed) { setError(failure instanceof Error ? failure.message : "PDF 页面显示失败"); setBusy(false); }
    });
    return () => { disposed = true; renderTask?.cancel(); };
  }, [pdf, pageNumber, width, zoom, rotation]);

  function changePage(value: number) {
    setPageNumber(Math.min(pdf?.numPages ?? 1, Math.max(1, value)));
  }

  return (
    <dialog ref={dialogRef} className="media-viewer" aria-labelledby="media-viewer-title" onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="media-viewer-shell">
        <header>
          <div><span>{target.kind === "pdf" ? "PDF" : "图片"}</span><h2 id="media-viewer-title">{target.name}</h2></div>
          <IconButton label="关闭查看器" onClick={onClose}><X size={21} /></IconButton>
        </header>
        <div className="media-viewer-toolbar">
          {target.kind === "pdf" && <div className="media-page-controls">
            <IconButton label="上一页" disabled={!pdf || pageNumber === 1 || busy} onClick={() => changePage(pageNumber - 1)}><ChevronLeft size={19} /></IconButton>
            <label><input aria-label="页码" type="number" min={1} max={pdf?.numPages ?? 1} value={pageNumber} onChange={(event) => changePage(Number(event.target.value) || 1)} /><span>/ {pdf?.numPages ?? "…"}</span></label>
            <IconButton label="下一页" disabled={!pdf || pageNumber === pdf.numPages || busy} onClick={() => changePage(pageNumber + 1)}><ChevronRight size={19} /></IconButton>
          </div>}
          <div className="media-zoom-controls">
            <IconButton label="缩小" disabled={zoom <= 0.5} onClick={() => setZoom((value) => Math.max(0.5, value - 0.25))}><ZoomOut size={18} /></IconButton>
            <span>{Math.round(zoom * 100)}%</span>
            <IconButton label="放大" disabled={zoom >= 3} onClick={() => setZoom((value) => Math.min(3, value + 0.25))}><ZoomIn size={18} /></IconButton>
            <IconButton label="适合窗口" onClick={() => { setZoom(1); setRotation(0); }}><Maximize size={17} /></IconButton>
            {target.kind === "pdf" && <IconButton label="旋转页面" onClick={() => setRotation((value) => (value + 90) % 360)}><RotateCw size={17} /></IconButton>}
          </div>
        </div>
        <div ref={viewportRef} className={`media-viewer-viewport ${target.kind}`}>
          {busy && <div className="media-viewer-status" role="status"><LoaderCircle className="is-spinning" size={22} /><span>{pdf ? `正在显示第 ${pageNumber} 页…` : "正在加载预览…"}</span></div>}
          {error && <div className="media-viewer-status" role="alert"><AlertTriangle size={22} /><span>{error}</span><button className="secondary-button" onClick={() => { setPdf(undefined); setAttempt((value) => value + 1); }}>重新加载</button></div>}
          {target.kind === "pdf" ? <canvas ref={canvasRef} aria-label={`${target.name} 第 ${pageNumber} 页`} style={{ visibility: busy || error ? "hidden" : "visible" }} /> : imageUrl && <img src={imageUrl} alt={target.name} style={{ width: zoom === 1 ? "auto" : `${zoom * 100}%`, maxWidth: zoom === 1 ? "100%" : "none", maxHeight: zoom === 1 ? "100%" : "none" }} onError={() => { setError("图片无法显示，请重新加载"); setBusy(false); }} />}
        </div>
        <footer>{target.kind === "pdf" ? "按需读取页面内容" : "滚动查看图片 · 使用上方按钮缩放"}</footer>
      </div>
    </dialog>
  );
}
