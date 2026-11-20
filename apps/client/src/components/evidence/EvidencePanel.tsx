import type {
  BridgeArtifactManifest,
  BridgeArtifactPreview,
  BridgeEvidenceBundle,
  BridgeEvidenceDetailPage,
} from "@bridge/protocol";
import {
  AlertTriangle,
  CheckCircle2,
  Code2,
  Download,
  Eye,
  File,
  FileCode2,
  FileDiff,
  FileImage,
  FileText,
  Globe,
  LoaderCircle,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionEvidenceState } from "../../hooks/useMobileBridge.js";
import type { ConversationItem, FileChangesSummary } from "../../lib/conversation-timeline.js";
import { artifactMediaTarget, formatBytes, mediaArtifacts, mediaKind } from "../../lib/media-preview.js";
import { registerMobileBackHandler } from "../../lib/mobile-back-navigation.js";
import { ConfirmationDialog } from "../common/ConfirmationDialog.js";
import { IconButton } from "../common/IconButton.js";
import { deduplicateSessionOutputFiles, type SessionOutputFileItem } from "./FileChangesCard.js";
import { MediaGallery } from "./MediaGallery.js";
import { useFilePreviewConfirmation, useMediaPreview } from "./MediaPreviewProvider.js";

function outputFileIcon(item: SessionOutputFileItem) {
  if (item.kind === "image") return <FileImage size={16} />;
  if (item.kind === "html") return <Globe size={16} />;
  if (item.kind === "code") return <Code2 size={16} />;
  if (item.kind === "diff") return <FileDiff size={16} />;
  if (item.kind === "pdf" || item.kind === "text" || item.kind === "log") return <FileText size={16} />;
  if (/\.(?:tsx?|jsx?|py|rs|go|java|kt|c|cpp|h|sh|json|ya?ml|toml|css|scss|md)$/iu.test(item.name)) {
    return <FileCode2 size={16} />;
  }
  return <File size={16} />;
}

function changeLabel(value: BridgeArtifactManifest["changeKind"]): string {
  if (value === "created") return "新增";
  if (value === "modified") return "修改";
  if (value === "deleted") return "删除";
  if (value === "renamed") return "重命名";
  return "发现";
}

function changeToneClass(value: BridgeArtifactManifest["changeKind"]): string {
  if (value === "created") return "is-created";
  if (value === "deleted") return "is-deleted";
  return "is-modified";
}

export type EvidenceDetailsLoader = (
  evidenceId: string,
  kind: "tools" | "artifacts",
  cursor?: string,
) => Promise<BridgeEvidenceDetailPage>;

interface BundleArtifactDetailState {
  signature: string;
  items: BridgeArtifactManifest[];
  nextCursor?: string | undefined;
  hasMore: boolean;
  loading: boolean;
  error?: string | undefined;
}

function bundleDetailSignature(bundle: BridgeEvidenceBundle): string {
  return `${bundle.state}:${bundle.artifactCount}:${bundle.completedAt ?? ""}`;
}

export function EvidenceInlineSummary({
  evidence,
  onOpen,
  entering = false,
}: {
  evidence: BridgeEvidenceBundle;
  onOpen(): void;
  entering?: boolean;
}) {
  if (
    evidence.state !== "failed"
    && evidence.changeCount === 0
    && evidence.artifactCount === 0
  ) {
    return null;
  }
  const parts: string[] = [];
  if (evidence.changeCount > 0) parts.push(`${evidence.changeCount} 处文件变更`);
  if (evidence.artifactCount > 0) parts.push(`${evidence.artifactCount} 个产物`);
  if (parts.length === 0) parts.push("本轮产出记录");

  return (
    <div className="evidence-inline-output" data-stream-key={`evidence:${evidence.id}`}>
      <MediaGallery artifacts={mediaArtifacts([evidence])} />
      <button
        type="button"
        className={`evidence-inline-summary ${evidence.confidence}${entering ? " is-entering" : ""}`}
        onClick={onOpen}
      >
        <span className="evidence-inline-icon">
          {evidence.state === "collecting"
            ? <LoaderCircle className="is-spinning" size={15} />
            : evidence.state === "failed"
              ? <AlertTriangle size={15} />
              : <CheckCircle2 size={15} />}
        </span>
        <span className="evidence-inline-copy">
          <strong>{parts.join(" · ")}</strong>
        </span>
        <b>查看</b>
      </button>
    </div>
  );
}

export function EvidencePanel({
  variant = "mobile",
  sessionId,
  cwd,
  state,
  conversationItems,
  fileChanges,
  previews,
  transfers,
  online,
  suppressEmpty = false,
  onLoadMore,
  onLoadDetails,
  onPreview,
  onDownload,
  onRequestSessionFileDownload,
  onResolvedFileCountChange,
}: {
  variant?: "mobile" | "desktop" | undefined;
  sessionId?: string | undefined;
  cwd?: string | undefined;
  state: SessionEvidenceState | undefined;
  conversationItems?: readonly ConversationItem[] | undefined;
  fileChanges?: FileChangesSummary | undefined;
  previews: Record<string, BridgeArtifactPreview>;
  transfers: Record<string, number>;
  online: boolean;
  suppressEmpty?: boolean | undefined;
  onLoadMore(): Promise<void>;
  onLoadDetails?: EvidenceDetailsLoader | undefined;
  onPreview(artifactId: string): Promise<BridgeArtifactPreview>;
  onDownload(artifact: BridgeArtifactManifest): Promise<void>;
  onRequestSessionFileDownload?: ((filePath: string) => void) | undefined;
  onResolvedFileCountChange?: ((count: number) => void) | undefined;
}) {
  const openMedia = useMediaPreview();
  const confirmPreview = useFilePreviewConfirmation();
  const [selectedArtifact, setSelectedArtifact] = useState<BridgeArtifactManifest>();
  const [previewBusy, setPreviewBusy] = useState<string>();
  const [pendingDownload, setPendingDownload] = useState<BridgeArtifactManifest>();
  const [error, setError] = useState("");
  const [detailPages, setDetailPages] = useState<Record<string, BundleArtifactDetailState>>({});
  const [retryTick, setRetryTick] = useState(0);

  const mountedRef = useRef(true);
  const onLoadDetailsRef = useRef(onLoadDetails);
  onLoadDetailsRef.current = onLoadDetails;
  const previewDialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const items = state?.items ?? [];
  const activeBundleIdsRef = useRef(new Set<string>());
  activeBundleIdsRef.current = new Set(items.map((bundle) => bundle.id));

  const summaryBundles = useMemo(
    () => items.filter((bundle) => Boolean(bundle.detailsAvailable && bundle.artifactCount > 0 && bundle.artifacts.length === 0)),
    [items],
  );
  const latestSummaryBundlesRef = useRef(new Map<string, BridgeEvidenceBundle>());
  latestSummaryBundlesRef.current = new Map(summaryBundles.map((bundle) => [bundle.id, bundle]));
  const summaryBundlesKey = summaryBundles
    .map((bundle) => `${bundle.id}:${bundleDetailSignature(bundle)}`)
    .join("|");

  useEffect(() => {
    const loader = onLoadDetailsRef.current;
    if (!online || !loader || summaryBundles.length === 0) return;

    const toLoad = summaryBundles.filter((bundle) => {
      const existing = detailPages[bundle.id];
      const signature = bundleDetailSignature(bundle);
      if (!existing) return true;
      if (existing.signature !== signature) return !existing.loading;
      return false;
    });
    if (toLoad.length === 0) return;

    setDetailPages((previous) => {
      const next = { ...previous };
      for (const bundle of toLoad) {
        const signature = bundleDetailSignature(bundle);
        const prior = previous[bundle.id];
        next[bundle.id] = {
          signature,
          items: prior?.items ?? [],
          hasMore: prior?.hasMore ?? false,
          nextCursor: undefined,
          loading: true,
          error: undefined,
        };
      }
      return next;
    });

    for (const bundle of toLoad) {
      const bundleId = bundle.id;
      const signature = bundleDetailSignature(bundle);
      void loader(bundleId, "artifacts")
        .then((page) => {
          if (!mountedRef.current || !activeBundleIdsRef.current.has(bundleId)) return;
          setDetailPages((previous) => ({
            ...previous,
            [bundleId]: {
              signature,
              items: page.kind === "artifacts" ? page.items : [],
              nextCursor: page.nextCursor,
              hasMore: page.hasMore,
              loading: false,
              error: undefined,
            },
          }));
          const latestBundle = latestSummaryBundlesRef.current.get(bundleId);
          if (latestBundle && bundleDetailSignature(latestBundle) !== signature) {
            setRetryTick((value) => value + 1);
          }
        })
        .catch((loadError: unknown) => {
          if (!mountedRef.current || !activeBundleIdsRef.current.has(bundleId)) return;
          const message = loadError instanceof Error ? loadError.message : "成果详情加载失败";
          setDetailPages((previous) => ({
            ...previous,
            [bundleId]: {
              signature,
              items: previous[bundleId]?.items ?? [],
              nextCursor: previous[bundleId]?.nextCursor,
              hasMore: previous[bundleId]?.hasMore ?? false,
              loading: false,
              error: message,
            },
          }));
          const latestBundle = latestSummaryBundlesRef.current.get(bundleId);
          if (latestBundle && bundleDetailSignature(latestBundle) !== signature) {
            setRetryTick((value) => value + 1);
          }
        });
    }
  }, [summaryBundlesKey, online, retryTick]);

  function loadMoreBundleArtifacts(bundleId: string): void {
    const loader = onLoadDetailsRef.current;
    const current = detailPages[bundleId];
    if (!online || !loader || !current || current.loading || !current.hasMore) return;
    const cursor = current.nextCursor;
    setDetailPages((previous) => ({
      ...previous,
      [bundleId]: {
        ...previous[bundleId]!,
        loading: true,
        error: undefined,
      },
    }));
    void loader(bundleId, "artifacts", cursor)
      .then((page) => {
        if (!mountedRef.current || !activeBundleIdsRef.current.has(bundleId)) return;
        setDetailPages((previous) => {
          const existing = previous[bundleId];
          if (!existing) return previous;
          return {
            ...previous,
            [bundleId]: {
              ...existing,
              items: page.kind === "artifacts" ? [...existing.items, ...page.items] : existing.items,
              nextCursor: page.nextCursor,
              hasMore: page.hasMore,
              loading: false,
              error: undefined,
            },
          };
        });
      })
      .catch((loadError: unknown) => {
        if (!mountedRef.current || !activeBundleIdsRef.current.has(bundleId)) return;
        const message = loadError instanceof Error ? loadError.message : "成果详情加载失败";
        setDetailPages((previous) => {
          const existing = previous[bundleId];
          if (!existing) return previous;
          return {
            ...previous,
            [bundleId]: {
              ...existing,
              loading: false,
              error: message,
            },
          };
        });
      });
  }

  function retryFailedBundleLoads(): void {
    setDetailPages((previous) => {
      const next = { ...previous };
      for (const bundle of summaryBundles) {
        if (next[bundle.id]?.error) {
          delete next[bundle.id];
        }
      }
      return next;
    });
    setRetryTick((value) => value + 1);
  }

  const detailArtifactsByBundleId = useMemo(() => {
    const record: Record<string, readonly BridgeArtifactManifest[]> = {};
    for (const bundle of summaryBundles) {
      const loaded = detailPages[bundle.id];
      if (loaded?.items.length) {
        record[bundle.id] = loaded.items;
      }
    }
    return record;
  }, [detailPages, summaryBundles]);

  const outputFiles = useMemo(
    () => deduplicateSessionOutputFiles({
      bundles: items,
      detailArtifactsByBundleId,
      conversationItems,
      fileChanges,
      cwd,
    }),
    [conversationItems, cwd, detailArtifactsByBundleId, fileChanges, items],
  );

  const anyDetailsLoading = summaryBundles.some((bundle) => detailPages[bundle.id]?.loading);
  const firstDetailsError = summaryBundles.map((bundle) => detailPages[bundle.id]?.error).find(Boolean);
  const bundleWithMoreArtifacts = summaryBundles.find((bundle) => detailPages[bundle.id]?.hasMore);
  const waitingInitialSummaryLoad = Boolean(
    online
    && onLoadDetails
    && summaryBundles.some((bundle) => !detailPages[bundle.id]),
  );

  useEffect(() => {
    if (waitingInitialSummaryLoad || anyDetailsLoading) return;
    onResolvedFileCountChange?.(outputFiles.length);
  }, [anyDetailsLoading, onResolvedFileCountChange, outputFiles.length, waitingInitialSummaryLoad]);

  const selectedPreview = selectedArtifact ? previews[selectedArtifact.id] : undefined;

  useEffect(() => {
    if (!selectedArtifact || !selectedPreview) return undefined;
    const dialog = previewDialogRef.current;
    const opener = typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null;
    if (typeof document !== "undefined" && dialog) {
      const firstControl = dialog.querySelector<HTMLElement>("button:not(:disabled)") ?? dialog;
      firstControl.focus();
    }
    const unregisterBack = registerMobileBackHandler(() => {
      setSelectedArtifact(undefined);
      return true;
    }, 200);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setSelectedArtifact(undefined);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      unregisterBack();
      window.removeEventListener("keydown", onKeyDown);
      if (typeof document !== "undefined") {
        const active = document.activeElement;
        if (
          opener?.isConnected
          && (!active || active === document.body || active === document.documentElement || Boolean(dialog?.contains(active)))
        ) {
          opener.focus();
        }
      }
    };
  }, [selectedArtifact, selectedPreview]);

  function openItemPreview(item: SessionOutputFileItem): void {
    setError("");
    const artifact = item.artifact;
    const media = artifact
      ? artifactMediaTarget(artifact)
      : (item.changeKind !== "deleted" && sessionId && mediaKind(item.filePath)
          ? { name: item.name, kind: mediaKind(item.filePath)!, sessionId, path: item.filePath }
          : undefined);
    const cached = artifact && previews[artifact.id];
    if (media?.kind === "image" && cached?.mode === "image" && cached.encoding === "base64") {
      openMedia({ ...media, dataUrl: `data:${cached.mimeType};base64,${cached.data}` });
      return;
    }
    if (artifact && cached) {
      setSelectedArtifact(artifact);
      return;
    }
    if (media) {
      openMedia(media);
      return;
    }
    if (!artifact) return;
    confirmPreview({ name: artifact.name, artifactId: artifact.id }, () => {
      setPreviewBusy(artifact.id);
      void onPreview(artifact.id)
        .then(() => {
          if (mountedRef.current) setSelectedArtifact(artifact);
        })
        .catch((previewError: unknown) => {
          if (mountedRef.current) {
            setError(previewError instanceof Error ? previewError.message : "成果预览失败");
          }
        })
        .finally(() => {
          if (mountedRef.current) setPreviewBusy(undefined);
        });
    });
  }

  async function download(artifact: BridgeArtifactManifest): Promise<void> {
    setError("");
    try {
      await onDownload(artifact);
    } catch (downloadError) {
      if (mountedRef.current) {
        setError(downloadError instanceof Error ? downloadError.message : "成果下载失败");
      }
    }
  }

  if (outputFiles.length === 0) {
    if ((state?.status === "loading" && items.length === 0) || anyDetailsLoading || waitingInitialSummaryLoad) {
      return (
        <div className="evidence-empty">
          <LoaderCircle className="is-spinning" size={20} />
          <strong>正在读取成果</strong>
        </div>
      );
    }
    if (state?.status === "error" && items.length === 0) {
      return (
        <div className="evidence-empty">
          <AlertTriangle size={20} />
          <strong>成果暂时无法读取</strong>
        </div>
      );
    }
    if (firstDetailsError) {
      return (
        <div className="evidence-empty">
          <AlertTriangle size={20} />
          <strong>{firstDetailsError}</strong>
          {online && (
            <button type="button" className="secondary-button" onClick={retryFailedBundleLoads}>
              重试
            </button>
          )}
        </div>
      );
    }
    if (suppressEmpty) return null;
    if (!online && summaryBundles.length > 0 && onLoadDetails) {
      return (
        <div className="evidence-empty">
          <FileDiff size={22} />
          <strong>连接电脑后可读取成果</strong>
        </div>
      );
    }
    return (
      <div className="evidence-empty">
        <FileDiff size={22} />
        <strong>这个会话还没有成果</strong>
        {state?.hasMore && (
          <button
            type="button"
            className="secondary-button"
            disabled={state.status === "loading"}
            onClick={() => void onLoadMore()}
          >
            {state.status === "loading" && <LoaderCircle className="is-spinning" size={14} />}
            加载更多
          </button>
        )}
      </div>
    );
  }

  return (
    <section className={`evidence-panel${variant === "desktop" ? " is-desktop" : " is-mobile"}`}>
      {error && (
        <div className="evidence-error" role="alert">
          <AlertTriangle size={16} />
          {error}
        </div>
      )}
      {firstDetailsError && (
        <div className="evidence-error" role="alert">
          <AlertTriangle size={16} />
          <span>{firstDetailsError}</span>
          <button
            type="button"
            className="file-changes-more"
            aria-label="重试加载成果"
            disabled={!online || anyDetailsLoading}
            onClick={retryFailedBundleLoads}
          >
            重试
          </button>
        </div>
      )}
      {!online && <div className="evidence-offline">电脑离线 · 已缓存预览仍可打开</div>}

      <header className="evidence-list-header">
        <span className="evidence-list-count">共 {outputFiles.length} 个文件</span>
      </header>

      <div className="evidence-file-list">
        {outputFiles.map((item, index) => {
          const artifact = item.artifact;
          const cachedPreview = artifact ? previews[artifact.id] : undefined;
          const cached = Boolean(cachedPreview);
          const mediaTarget = artifact
            ? artifactMediaTarget(artifact)
            : (item.changeKind !== "deleted" && sessionId && mediaKind(item.filePath)
                ? { name: item.name, kind: mediaKind(item.filePath)!, sessionId, path: item.filePath }
                : undefined);
          const previewable = cached
            || Boolean(mediaTarget)
            || Boolean(artifact && artifact.previewMode !== "none" && artifact.availability !== "blocked");
          const previewDisabled = Boolean(previewBusy) || (!online && !cached);

          const canDownloadArtifact = Boolean(artifact?.downloadAllowed);
          const canDownloadWorkspaceFile = Boolean(
            !canDownloadArtifact && item.changeKind !== "deleted" && onRequestSessionFileDownload,
          );
          const canDownload = canDownloadArtifact || canDownloadWorkspaceFile;
          const progress = (artifact ? transfers[artifact.id] : undefined) ?? transfers[`file:${item.filePath}`];
          const hasDiffStats = (item.additions ?? 0) > 0 || (item.deletions ?? 0) > 0;
          const hasByteSize = !hasDiffStats && typeof item.size === "number" && item.size > 0;
          const checkOnOpen = !hasDiffStats
            && artifact?.changeKind === "observed"
            && artifact.availability === "current-file"
            && artifact.size === 0;
          const imageThumbSrc = cachedPreview?.encoding === "base64" && cachedPreview.mimeType.startsWith("image/")
            ? `data:${cachedPreview.mimeType};base64,${cachedPreview.data}`
            : undefined;

          return (
            <article
              className={`evidence-file-row${artifact ? ` ${artifact.availability}` : ""}`}
              key={item.key}
            >
              <div
                className={`evidence-file-main${previewable && !previewDisabled ? " is-previewable" : ""}`}
                {...(previewable && !previewDisabled ? {
                  onClick: () => openItemPreview(item),
                } : {})}
              >
                <span className="evidence-file-index num">{String(index + 1).padStart(2, "0")}</span>
                <span className={`evidence-file-visual${item.kind === "image" ? " is-image" : ""}`}>
                  {imageThumbSrc ? <img src={imageThumbSrc} alt="" /> : outputFileIcon(item)}
                </span>
                <div className="evidence-file-copy">
                  <div className="evidence-file-primary">
                    <strong className="evidence-file-name" title={item.name}>{item.name}</strong>
                    <span className="evidence-file-inline-stats">
                      <span className={`evidence-file-change ${changeToneClass(item.changeKind)}`}>
                        {changeLabel(item.changeKind)}
                      </span>
                      {(hasDiffStats || hasByteSize || checkOnOpen) && (
                        <>
                          <span className="evidence-file-dot" aria-hidden="true">·</span>
                          {hasDiffStats ? (
                            <span className="evidence-file-diff num">
                              {(item.additions ?? 0) > 0 && <b className="add">+{item.additions}</b>}
                              {(item.deletions ?? 0) > 0 && <b className="del">-{item.deletions}</b>}
                            </span>
                          ) : checkOnOpen ? (
                            <span className="evidence-file-size">打开时校验</span>
                          ) : (
                            <span className="evidence-file-size num">{formatBytes(item.size!)}</span>
                          )}
                        </>
                      )}
                    </span>
                  </div>
                  <div className="evidence-file-secondary">
                    <span className={`evidence-file-mobile-meta ${changeToneClass(item.changeKind)}`}>
                      <span>{changeLabel(item.changeKind)}</span>
                      {(hasDiffStats || hasByteSize || checkOnOpen) && (
                        <>
                          <span aria-hidden="true">·</span>
                          {hasDiffStats ? (
                            <span className="evidence-file-diff num">
                              {(item.additions ?? 0) > 0 && <b className="add">+{item.additions}</b>}
                              {(item.deletions ?? 0) > 0 && <b className="del">-{item.deletions}</b>}
                            </span>
                          ) : checkOnOpen ? (
                            <span>打开时校验</span>
                          ) : (
                            <span className="num">{formatBytes(item.size!)}</span>
                          )}
                        </>
                      )}
                      <span aria-hidden="true">·</span>
                    </span>
                    <code className="evidence-file-path" title={item.displayPath}>{item.displayPath}</code>
                  </div>
                  {artifact?.blockedReason && <i className="evidence-file-blocked">{artifact.blockedReason}</i>}
                  {progress !== undefined && (
                    <span className="evidence-transfer-progress">
                      <i style={{ width: `${Math.round(progress * 100)}%` }} />
                    </span>
                  )}
                </div>
              </div>

              <div className="evidence-file-actions">
                {previewable && (
                  <IconButton
                    className="evidence-action-btn is-preview"
                    label={cached ? `打开 ${item.name} 的缓存预览` : `预览 ${item.name}`}
                    disabled={previewDisabled}
                    onClick={() => openItemPreview(item)}
                  >
                    {artifact && previewBusy === artifact.id
                      ? <LoaderCircle className="is-spinning" size={14} />
                      : <Eye size={14} />}
                    <span className="evidence-action-label">预览</span>
                  </IconButton>
                )}
                {canDownload && (
                  <IconButton
                    className="evidence-action-btn is-download"
                    label={`下载 ${item.name}`}
                    disabled={!online || progress !== undefined}
                    onClick={() => {
                      if (canDownloadArtifact && artifact) {
                        setPendingDownload(artifact);
                      } else if (canDownloadWorkspaceFile) {
                        onRequestSessionFileDownload!(item.filePath);
                      }
                    }}
                  >
                    {progress !== undefined
                      ? <LoaderCircle className="is-spinning" size={14} />
                      : <Download size={14} />}
                    <span className="evidence-action-label">下载</span>
                  </IconButton>
                )}
              </div>
            </article>
          );
        })}
      </div>

      {(bundleWithMoreArtifacts || state?.hasMore) && (
        <div className="evidence-panel-footer">
          {/* One control: finish the loaded batch's files first, then older batches. */}
          <button
            type="button"
            className="load-older-button"
            disabled={bundleWithMoreArtifacts ? !online || anyDetailsLoading : state?.status === "loading"}
            onClick={() => bundleWithMoreArtifacts ? loadMoreBundleArtifacts(bundleWithMoreArtifacts.id) : void onLoadMore()}
          >
            {(bundleWithMoreArtifacts ? anyDetailsLoading : state?.status === "loading") && <LoaderCircle className="is-spinning" size={15} />}
            加载更多
          </button>
        </div>
      )}

      {selectedArtifact && selectedPreview && (
        <div
          className="artifact-preview-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setSelectedArtifact(undefined);
          }}
        >
          <section
            ref={previewDialogRef}
            className="artifact-preview-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="artifact-preview-title"
            tabIndex={-1}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setSelectedArtifact(undefined);
              } else if (event.key === "Tab") {
                const controls = event.currentTarget.querySelectorAll<HTMLElement>(
                  'button:not(:disabled), [tabindex="0"]',
                );
                const first = controls[0];
                const last = controls[controls.length - 1];
                if (!first || !last) {
                  event.preventDefault();
                  return;
                }
                const active = typeof document !== "undefined" ? document.activeElement : null;
                if (event.shiftKey && (active === first || active === event.currentTarget || !event.currentTarget.contains(active))) {
                  event.preventDefault();
                  last.focus();
                } else if (!event.shiftKey && (active === last || !event.currentTarget.contains(active))) {
                  event.preventDefault();
                  first.focus();
                }
              }
            }}
          >
            <header>
              <div>
                <span>{selectedArtifact.relativePath}</span>
                <h2 id="artifact-preview-title">{selectedArtifact.name}</h2>
              </div>
              <IconButton label="关闭预览" onClick={() => setSelectedArtifact(undefined)}>
                <X size={19} />
              </IconButton>
            </header>
            <div className={`artifact-preview-content ${selectedPreview.mode}`}>
              {selectedPreview.encoding === "base64" ? (
                <img
                  alt={selectedArtifact.name}
                  src={`data:${selectedPreview.mimeType};base64,${selectedPreview.data}`}
                />
              ) : (
                <pre>{selectedPreview.data}</pre>
              )}
            </div>
            <footer>
              <span>{selectedPreview.truncated ? "预览已截断" : formatBytes(selectedArtifact.size)}</span>
              {selectedArtifact.downloadAllowed && (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={!online}
                  onClick={() => setPendingDownload(selectedArtifact)}
                >
                  <Download size={16} />
                  下载
                </button>
              )}
            </footer>
          </section>
        </div>
      )}

      <ConfirmationDialog
        open={Boolean(pendingDownload)}
        title={variant === "desktop" ? "确认下载文件？" : "确认下载文件到手机？"}
        description={pendingDownload
          ? `即将从电脑下载「${pendingDownload.name}」（${pendingDownload.relativePath}${pendingDownload.size > 0 ? ` · ${formatBytes(pendingDownload.size)}` : ""}）到当前设备。`
          : ""}
        confirmLabel="确认下载"
        onCancel={() => setPendingDownload(undefined)}
        onConfirm={() => {
          const target = pendingDownload;
          setPendingDownload(undefined);
          if (target) void download(target);
        }}
      />
    </section>
  );
}
