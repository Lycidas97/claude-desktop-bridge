import { describe, expect, it, vi } from "vitest";
import type { BridgeArtifactManifest, BridgeEvidenceBundle, BridgeResponse } from "@bridge/protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TextPreview } from "../components/evidence/TextPreview.js";
import { artifactMediaTarget, mediaArtifacts, mediaKind, openMediaTransfer, readTextPreview, textPreviewLanguage } from "./media-preview.js";

const response = (result: unknown): BridgeResponse => ({ kind: "response", requestId: "test", ok: true, result });

describe("media previews", () => {
  it("recognizes image, PDF and text suffixes including source line references", () => {
    expect(mediaKind("/work/图片 final.PNG")).toBe("image");
    expect(mediaKind("report.PDF:2")).toBe("pdf");
    expect(mediaKind("report.pdf.ts")).toBe("text");
    expect(mediaKind(" /work/说明.MARKDOWN:20:4 ")).toBe("text");
    expect(mediaKind("C:\\work\\main.rs:12:3")).toBe("text");
    expect(mediaKind("src/App.tsx.bak")).toBeUndefined();
    expect(mediaKind("report.pdf.zip")).toBeUndefined();
    expect(mediaKind("readme.md/unknown")).toBeUndefined();
  });

  it.each(["Dockerfile", "Dockerfile.dev", ".env.local", ".gitignore", "Makefile", "README"])("recognizes the extensionless text file %s", (name) => {
    expect(mediaKind(`/work/${name}`)).toBe("text");
  });

  it.each([
    ["src/App.tsx:12:3", "typescript"], ["main.mjs", "javascript"], ["tool.PY", "python"],
    ["README.MDX:2", "markdown"], ["C:\\work\\settings.toml", "ini"], ["Dockerfile.dev", "dockerfile"],
    ["/work/.zshrc", "bash"], ["main.rs", "rust"], ["Makefile", "makefile"], ["notes.txt", undefined],
  ])("selects a syntax grammar for %s", (name, language) => {
    expect(textPreviewLanguage(name)).toBe(language);
  });

  it("allows text artifacts without adding them to the image/PDF gallery", () => {
    const artifact = { id: "text", name: "notes.md", relativePath: "docs/notes.md", kind: "text", availability: "current-file" } as BridgeArtifactManifest;
    expect(artifactMediaTarget(artifact)).toEqual({ name: "notes.md", kind: "text", artifactId: "text", path: "docs/notes.md" });
    expect(mediaArtifacts([{ startedAt: 1, artifacts: [artifact] } as BridgeEvidenceBundle])).toEqual([]);
    expect(artifactMediaTarget({ ...artifact, availability: "blocked" })).toBeUndefined();
  });

  it("uses full text previews for artifacts explicitly marked as text or diff", () => {
    for (const previewMode of ["text", "diff"] as const) {
      expect(artifactMediaTarget({ id: "custom", name: "output.custom", previewMode } as BridgeArtifactManifest)).toMatchObject({ kind: "text", artifactId: "custom" });
    }
    expect(artifactMediaTarget({ id: "custom", name: "output.custom", previewMode: "none" } as BridgeArtifactManifest)).toBeUndefined();
  });

  it("uses the newest version and hides deleted or blocked media", () => {
    const artifact = (id: string, relativePath: string, changeKind = "modified", availability = "current-file") => ({ id, relativePath, name: relativePath, kind: "pdf", changeKind, availability }) as BridgeArtifactManifest;
    const bundle = (startedAt: number, artifacts: BridgeArtifactManifest[]) => ({ startedAt, artifacts }) as BridgeEvidenceBundle;
    expect(mediaArtifacts([
      bundle(1, [artifact("old", "report.pdf"), artifact("deleted-old", "gone.pdf")]),
      bundle(2, [artifact("new", "report.pdf"), artifact("deleted", "gone.pdf", "deleted"), artifact("blocked", "private.pdf", "modified", "blocked")]),
    ]).map((file) => file.id)).toEqual(["new"]);
  });

  it("opens native images by stable reference without a project path", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const nativeImage = { messageUuid: "user-uuid", imageIndex: 4 };
    const source = await openMediaTransfer({ name: "image.png", kind: "image", sessionId: "session", nativeImage }, async (method, params) => {
      calls.push({ method, params });
      if (method === "artifact.transfer.read") return response({ chunk: { transferId: "image-lease", index: 0, data: btoa("image") } });
      return response({ transfer: { transferId: "image-lease", size: 5, chunkBytes: 8, mimeType: "image/png" } });
    });
    expect(calls).toEqual([{ method: "artifact.transfer.open", params: { sessionId: "session", nativeImage } }]);
    expect(new TextDecoder().decode(await source.read(0, 5))).toBe("image");
    await source.close();
    expect(calls.at(-1)).toEqual({ method: "artifact.transfer.close", params: { transferId: "image-lease" } });
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

  it("reports unique decoded bytes before a multi-chunk range finishes", async () => {
    const progress: number[][] = [];
    const reads: number[] = [];
    const pending = new Map<number, (value: BridgeResponse) => void>();
    const request = async (method: string, params: Record<string, unknown>) => {
      if (method === "artifact.transfer.open") return response({ transfer: { transferId: "lease", size: 10, chunkBytes: 4 } });
      if (method === "artifact.transfer.close") return response({ closed: true });
      reads.push(Number(params.index));
      return new Promise<BridgeResponse>((resolve) => pending.set(Number(params.index), resolve));
    };
    const source = await openMediaTransfer({ name: "report.pdf", kind: "pdf", artifactId: "pdf" }, request, (loaded, total) => progress.push([loaded, total]));
    expect(progress).toEqual([[0, 10]]);
    const range = source.read(0, 10);
    const overlap = source.read(1, 4);
    expect(reads).toEqual([0]);
    pending.get(0)!(response({ chunk: { transferId: "lease", index: 0, data: btoa("0123") } }));
    expect(new TextDecoder().decode(await overlap)).toBe("123");
    expect(progress).toEqual([[0, 10], [4, 10]]);
    await source.read(0, 2);
    expect(progress).toEqual([[0, 10], [4, 10]]);
    expect(reads).toEqual([0, 1]);
    pending.get(1)!(response({ chunk: { transferId: "lease", index: 1, data: btoa("4567") } }));
    await source.read(4, 8);
    expect(progress.at(-1)).toEqual([8, 10]);
    pending.get(2)!(response({ chunk: { transferId: "lease", index: 2, data: btoa("89") } }));
    expect(new TextDecoder().decode(await range)).toBe("0123456789");
    expect(progress).toEqual([[0, 10], [4, 10], [8, 10], [10, 10]]);
    expect(reads).toEqual([0, 1, 2]);
    await source.close();
    const reopened = await openMediaTransfer({ name: "report.pdf", kind: "pdf", artifactId: "pdf" }, request, (loaded, total) => progress.push([loaded, total]));
    expect(progress.at(-1)).toEqual([0, 10]);
    await reopened.close();
  });

  it("does not count a failed chunk as downloaded", async () => {
    const progress: number[] = [];
    const source = await openMediaTransfer({ name: "report.pdf", kind: "pdf", artifactId: "pdf" }, async (method) => {
      if (method === "artifact.transfer.open") return response({ transfer: { transferId: "lease", size: 4, chunkBytes: 4 } });
      return response({ chunk: { transferId: "other-lease", index: 0, data: btoa("0123") } });
    }, (loaded) => progress.push(loaded));
    await expect(source.read(0, 4)).rejects.toThrow("文件分块校验失败");
    expect(progress).toEqual([0]);
  });

  it("requests text-preview and decodes UTF-8 only after reading every chunk", async () => {
    const text = "# 完整文档\nconst emoji = '🧪';\n最后一行\n";
    const bytes = new TextEncoder().encode(text);
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const source = await openMediaTransfer({ name: "guide.md", kind: "text", sessionId: "session", path: " /work/guide.md:12:3 " }, async (method, params) => {
      calls.push({ method, params });
      if (method === "artifact.transfer.open") return response({ transfer: { transferId: "text-lease", size: bytes.length, chunkBytes: 4 } });
      if (method === "artifact.transfer.close") return response({ closed: true });
      const index = Number(params.index);
      return response({ chunk: { transferId: "text-lease", index, data: btoa(String.fromCharCode(...bytes.slice(index * 4, index * 4 + 4))) } });
    });
    expect(calls[0]).toEqual({ method: "artifact.transfer.open", params: { sessionId: "session", path: "/work/guide.md", purpose: "text-preview" } });
    expect(await readTextPreview(source)).toBe(text);
    expect(calls.filter((call) => call.method === "artifact.transfer.read").map((call) => call.params.index))
      .toEqual(Array.from({ length: Math.ceil(bytes.length / 4) }, (_, index) => index));
    await source.close();
    expect(calls.at(-1)).toEqual({ method: "artifact.transfer.close", params: { transferId: "text-lease" } });
  });

  it("also requests text-preview for artifacts", async () => {
    let openParams: Record<string, unknown> | undefined;
    const source = await openMediaTransfer({ name: "notes.md", kind: "text", artifactId: "notes" }, async (method, params) => {
      if (method === "artifact.transfer.open") openParams = params;
      return response({ transfer: { transferId: "text-lease", size: 0, chunkBytes: 4 } });
    });
    expect(openParams).toEqual({ artifactId: "notes", purpose: "text-preview" });
    expect(await readTextPreview(source)).toBe("");
    await source.close();
  });

  it.each([1024 * 1024, 1024 * 1024 + 1])("decodes the complete %i-byte text after the preview is allowed", async (size) => {
    const text = "x".repeat(size - 1) + "Z";
    const bytes = new TextEncoder().encode(text);
    const read = vi.fn(async (begin: number, end: number) => {
      expect([begin, end]).toEqual([0, bytes.length]);
      return bytes;
    });
    expect(await readTextPreview({ transfer: { size }, read })).toBe(text);
    expect(read).toHaveBeenCalledOnce();
  });

  it("handles an empty UTF-8 file and strips only the UTF-8 BOM", async () => {
    for (const [bytes, expected] of [[new Uint8Array(), ""], [Uint8Array.from([0xef, 0xbb, 0xbf, 0x61, 0x0a]), "a\n"]] as const) {
      expect(await readTextPreview({ transfer: { size: bytes.length }, read: async () => bytes })).toBe(expected);
    }
  });

  it.each([
    [Uint8Array.from([0x61, 0, 0x62]), "二进制"],
    [Uint8Array.from([0xff, 0xfe, 0x61]), "UTF-8"],
    [Uint8Array.from([0xe4, 0xb8]), "UTF-8"],
  ])("reports binary or invalid UTF-8 content instead of replacement characters", async (bytes, message) => {
    await expect(readTextPreview({ transfer: { size: bytes.length }, read: async () => bytes })).rejects.toThrow(message);
  });

  it.each([
    ["sample.ts", "const value: number = 42;"],
    ["sample.js", "const value = 42;"],
    ["sample.py", "def answer():\n    return 42\n"],
  ])("renders highlighted %s as React spans", (name, text) => {
    const html = renderToStaticMarkup(createElement(TextPreview, { text, name, source: true }));
    expect(html).toContain('class="hljs-keyword"');
    expect(html).toContain('class="hljs-number"');
  });

  it("escapes HTML inside highlighted source and plain text", () => {
    const text = '<img src=x onerror=alert(1)><script>alert("x")</script>';
    for (const name of ["sample.html", "notes.txt"]) {
      const html = renderToStaticMarkup(createElement(TextPreview, { text, name, source: true }));
      expect(html).not.toMatch(/<(?:img|script)\b/u);
      expect(html).toContain("&lt;");
    }
  });

  it("renders full Markdown through MarkdownText and supports its source view", () => {
    const text = "# Guide\n\n" + "A paragraph with **bold** text.\n\n".repeat(100) + "## End of file\n\n<script>alert(1)</script>\n[unsafe](javascript:alert(1))";
    const rendered = renderToStaticMarkup(createElement(TextPreview, { text, name: "guide.md", source: false }));
    expect(rendered).toContain('class="markdown-heading markdown-h1"');
    expect(rendered).toContain("<strong>bold</strong>");
    expect(rendered).toContain("End of file</h2>");
    expect(rendered).not.toContain("expandable-message");
    expect(rendered).not.toContain("<script>");
    expect(rendered).not.toContain('href="javascript:');
    const source = renderToStaticMarkup(createElement(TextPreview, { text, name: "guide.md", source: true }));
    expect(source).toContain('class="text-preview-source"');
    expect(source).toContain("# Guide");
    expect(source).not.toContain("<h1");
  });
});
