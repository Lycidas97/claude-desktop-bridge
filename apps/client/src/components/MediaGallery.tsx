import type { BridgeArtifactManifest } from "@bridge/protocol";
import { ChevronDown, ChevronUp, Eye, FileImage, FileText } from "lucide-react";
import { useState } from "react";
import { artifactMediaTarget } from "../lib/media-preview.js";
import { useMediaPreview } from "./MediaPreviewProvider.js";

const COLLAPSED_MEDIA_LIMIT = 6;
const MEDIA_PAGE_STEP = 24;

export function MediaGallery({ artifacts, online = true }: { artifacts: BridgeArtifactManifest[]; online?: boolean }) {
  const open = useMediaPreview();
  const [collapsed, setCollapsed] = useState(false);
  const [visibleCount, setVisibleCount] = useState(COLLAPSED_MEDIA_LIMIT);
  const items = artifacts.flatMap((artifact) => {
    const target = artifactMediaTarget(artifact);
    return target ? [{ artifact, target }] : [];
  });
  if (items.length === 0) return null;
  const shown = items.slice(0, visibleCount);
  const hiddenCount = Math.max(0, items.length - shown.length);
  return (
    <section className={`media-gallery${collapsed ? " is-collapsed" : ""}`} aria-label="图片与 PDF">
      <header>
        <strong>图片与 PDF</strong>
        <span>{items.length} 个 · {collapsed ? "已收起" : "点开加载"}</span>
        {items.length > 1 && (
          <button
            type="button"
            className="media-gallery-toggle"
            aria-expanded={!collapsed}
            onClick={() => setCollapsed((current) => !current)}
          >
            {collapsed ? <>展开 <ChevronDown size={13} /></> : <>收起 <ChevronUp size={13} /></>}
          </button>
        )}
      </header>
      {!collapsed && (
        <>
          <div className="media-gallery-files">
            {shown.map(({ artifact, target }) => (
              <button className={`media-file ${target.kind}`} type="button" key={artifact.id} disabled={!online} onClick={() => open(target)}>
                <span className="media-file-cover" aria-hidden="true">
                  {target.kind === "pdf" ? <FileText size={28} strokeWidth={1.4} /> : <FileImage size={28} strokeWidth={1.4} />}
                  <span>{target.kind === "pdf" ? "PDF" : "图片"}</span>
                </span>
                <span className="media-file-copy"><strong title={artifact.relativePath}>{artifact.name}</strong><small>{target.kind === "pdf" ? "阅读 PDF" : "查看图片"}<Eye size={13} /></small></span>
              </button>
            ))}
          </div>
          {(hiddenCount > 0 || visibleCount > COLLAPSED_MEDIA_LIMIT) && (
            <div className="media-gallery-actions">
              {hiddenCount > 0 && (
                <button
                  type="button"
                  className="file-changes-more"
                  onClick={() => setVisibleCount((current) => Math.min(items.length, current + MEDIA_PAGE_STEP))}
                >
                  再显示 {Math.min(hiddenCount, MEDIA_PAGE_STEP)} 个（剩余 {hiddenCount} 个） <ChevronDown size={14} />
                </button>
              )}
              {visibleCount > COLLAPSED_MEDIA_LIMIT && (
                <button
                  type="button"
                  className="file-changes-more"
                  onClick={() => setVisibleCount(COLLAPSED_MEDIA_LIMIT)}
                >
                  收起至前 {COLLAPSED_MEDIA_LIMIT} 个 <ChevronUp size={14} />
                </button>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
