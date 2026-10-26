import { describe, expect, it } from "vitest";
import type { BridgeArtifactManifest, BridgeEvidenceBundle, BridgeResponse } from "@bridge/protocol";
import { mediaArtifacts, mediaKind, openMediaTransfer } from "./media-preview.js";

const response = (result: unknown): BridgeResponse => ({ kind: "response", requestId: "test", ok: true, result });

describe("media previews", () => {
  it("recognizes image and PDF paths without treating other files as media", () => {
    expect(mediaKind("/work/图片 final.PNG")).toBe("image");
    expect(mediaKind("report.PDF")).toBe("pdf");
    expect(mediaKind("report.pdf.ts")).toBeUndefined();
  });

  it("uses the newest version and hides deleted or blocked media", () => {
    const artifact = (id: string, relativePath: string, changeKind = "modified", availability = "current-file") => ({ id, relativePath, name: relativePath, kind: "pdf", changeKind, availability }) as BridgeArtifactManifest;
    const bundle = (startedAt: number, artifacts: BridgeArtifactManifest[]) => ({ startedAt, artifacts }) as BridgeEvidenceBundle;
    expect(mediaArtifacts([
      bundle(1, [artifact("old", "report.pdf"), artifact("deleted-old", "gone.pdf")]),
      bundle(2, [artifact("new", "report.pdf"), artifact("deleted", "gone.pdf", "deleted"), artifact("blocked", "private.pdf", "modified", "blocked")]),
    ]).map((file) => file.id)).toEqual(["new"]);
  });

  it("fetches only requested chunks, reuses overlap, and closes its lease", async () => {
    const bytes = new TextEncoder().encode("0123456789abcdef");
    const reads: number[] = [];
    let closed = false;
    const source = await openMediaTransfer({ name: "report.pdf", kind: "pdf", artifactId: "pdf" }, async (method, params) => {
      if (method === "artifact.transfer.open") return response({ transfer: { transferId: "lease", size: bytes.length, chunkBytes: 4, totalChunks: 4 } });
      if (method === "artifact.transfer.close") { closed = true; return response({ closed: true }); }
      const index = Number(params.index);
      reads.push(index);
      return response({ chunk: { transferId: "lease", index, data: btoa(String.fromCharCode(...bytes.slice(index * 4, index * 4 + 4))) } });
    });
    expect(reads).toEqual([]);
    expect(new TextDecoder().decode(await source.read(5, 10))).toBe("56789");
    expect(reads).toEqual([1, 2]);
    expect(new TextDecoder().decode(await source.read(6, 8))).toBe("67");
    expect(reads).toEqual([1, 2]);
    await source.close();
    expect(closed).toBe(true);
    await expect(source.read(0, 4)).rejects.toThrow("预览已关闭");
  });
});
