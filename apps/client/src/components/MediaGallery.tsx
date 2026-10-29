import type { BridgeArtifactManifest } from "@bridge/protocol";
import { Eye, FileImage, FileText } from "lucide-react";
import { artifactMediaTarget } from "../lib/media-preview.js";
import { useMediaPreview } from "./MediaPreviewProvider.js";

export function MediaGallery({ artifacts, online = true }: { artifacts: BridgeArtifactManifest[]; online?: boolean }) {
  const open = useMediaPreview();
  if (artifacts.length === 0) return null;
  return (
    <section className="media-gallery" aria-label="图片与 PDF">
      <header><strong>图片与 PDF</strong><span>{artifacts.length} 个 · 点开加载</span></header>
      <div className="media-gallery-files">
        {artifacts.map((artifact) => {
          const target = artifactMediaTarget(artifact);
          if (!target) return null;
          return (
            <button className={`media-file ${target.kind}`} type="button" key={artifact.id} disabled={!online} onClick={() => open(target)}>
              <span className="media-file-cover" aria-hidden="true">
                {target.kind === "pdf" ? <FileText size={28} strokeWidth={1.4} /> : <FileImage size={28} strokeWidth={1.4} />}
                <span>{target.kind === "pdf" ? "PDF" : "图片"}</span>
              </span>
              <span className="media-file-copy"><strong title={artifact.relativePath}>{artifact.name}</strong><small>{target.kind === "pdf" ? "阅读 PDF" : "查看图片"}<Eye size={13} /></small></span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
