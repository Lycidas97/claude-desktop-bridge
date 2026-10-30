import { TEXT_PREVIEW_MAX_BYTES } from "@bridge/protocol";
import type {
  BridgeArtifactManifest,
  BridgeArtifactTransferChunk,
  BridgeArtifactTransferInfo,
  BridgeEvidenceBundle,
  BridgeRequest,
  BridgeResponse,
} from "@bridge/protocol";

export type MediaRequest = (
  method: BridgeRequest["method"],
  params: Record<string, unknown>,
  options?: { wait?: boolean; timeoutMs?: number },
) => Promise<BridgeResponse | undefined>;

export interface MediaTarget {
  name: string;
  kind: "image" | "pdf" | "text";
  artifactId?: string;
  sessionId?: string;
  path?: string;
  dataUrl?: string;
}

export function mediaKind(path: string): MediaTarget["kind"] | undefined {
  const filePath = path.trim().replace(/:\d+(?::\d+)?$/u, "");
  if (/\.pdf$/iu.test(filePath)) return "pdf";
  if (/\.(?:png|jpe?g|gif|webp|svg|avif|bmp)$/iu.test(filePath)) return "image";
  if (/\.(?:md|markdown|mdx|txt|text|log|csv|tsv|json|jsonl|ndjson|ts|tsx|mts|cts|js|jsx|mjs|cjs|py|pyi|sh|bash|zsh|fish|ya?ml|toml|ini|conf|cfg|xml|tex|bib|html?|xhtml|css|scss|sass|less|sql|r|rb|go|rs|java|kt|kts|c|h|cc|cpp|cxx|hpp|cs|swift|m|mm|php|vue|svelte|diff|patch|gitignore|gitattributes|editorconfig|dockerignore)$/iu.test(filePath)
    || /(?:^|[/\\])(?:\.(?:gitignore|gitattributes|gitmodules|editorconfig|dockerignore|npmrc|nvmrc|prettierrc|eslintignore|eslintrc|bashrc|bash_profile|zshrc|zprofile|profile|env(?:\.[\w-]+)?)|Dockerfile(?:\.[\w-]+)?|Makefile|GNUmakefile|CMakeLists\.txt|LICENSE|LICENCE|NOTICE|README|CHANGELOG)$/iu.test(filePath)) return "text";
  return undefined;
}

export function textPreviewLanguage(path: string): string | undefined {
  const name = path.trim().replace(/:\d+(?::\d+)?$/u, "").split(/[/\\]/u).at(-1)!.toLowerCase();
  if (/^dockerfile(?:\.|$)/u.test(name)) return "dockerfile";
  if (name === "makefile" || name === "gnumakefile") return "makefile";
  const extension = name.split(".").at(-1)!;
  return ({
    md: "markdown", markdown: "markdown", mdx: "markdown",
    ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
    js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
    py: "python", pyi: "python", sh: "bash", bash: "bash", zsh: "bash",
    bashrc: "bash", bash_profile: "bash", zshrc: "bash", zprofile: "bash", profile: "bash",
    json: "json", jsonl: "json", ndjson: "json", yaml: "yaml", yml: "yaml",
    toml: "ini", ini: "ini", xml: "xml", html: "xml", htm: "xml", xhtml: "xml", vue: "xml", svelte: "xml",
    css: "css", scss: "scss", less: "less", sql: "sql", r: "r", rb: "ruby", go: "go", rs: "rust",
    java: "java", kt: "kotlin", kts: "kotlin", c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp",
    cs: "csharp", swift: "swift", m: "objectivec", mm: "objectivec", php: "php", tex: "latex",
    diff: "diff", patch: "diff",
  } as Record<string, string>)[extension];
}

export async function readTextPreview(source: { transfer: Pick<BridgeArtifactTransferInfo, "size">; read(begin: number, end: number): Promise<Uint8Array> }): Promise<string> {
  if (source.transfer.size > TEXT_PREVIEW_MAX_BYTES) throw new Error("文本预览仅支持 1 MiB 以内的文件，请下载查看全文");
  const bytes = await source.read(0, source.transfer.size);
  if (bytes.includes(0)) throw new Error("文件包含二进制内容，无法作为文本预览，请下载查看");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("文件不是有效的 UTF-8 文本，无法预览，请下载查看");
  }
}

export function artifactMediaTarget(artifact: BridgeArtifactManifest): MediaTarget | undefined {
  const kind = artifact.kind === "image" || artifact.kind === "pdf"
    ? artifact.kind : mediaKind(artifact.name);
  if (!kind || artifact.changeKind === "deleted" || artifact.availability === "blocked"
    || artifact.availability === "expired") return undefined;
  return { name: artifact.name, kind, artifactId: artifact.id, path: artifact.relativePath };
}

export function mediaArtifacts(bundles: BridgeEvidenceBundle[]): BridgeArtifactManifest[] {
  const files = new Map<string, BridgeArtifactManifest>();
  for (const bundle of [...bundles].sort((a, b) => b.startedAt - a.startedAt)) {
    for (const artifact of bundle.artifacts) {
      if (files.has(artifact.relativePath)) continue;
      // A newer deletion must also hide an older preview of the same file.
      files.set(artifact.relativePath, artifact);
    }
  }
  return [...files.values()].filter((artifact) => {
    const kind = artifactMediaTarget(artifact)?.kind;
    return kind === "image" || kind === "pdf";
  });
}

function unwrap<T>(response: BridgeResponse | undefined): T {
  if (!response?.ok) throw new Error(response?.error?.message ?? "文件预览失败");
  return response.result as T;
}

export async function openMediaTransfer(target: MediaTarget, request: MediaRequest) {
  const { transfer } = unwrap<{ transfer: BridgeArtifactTransferInfo }>(await request(
    "artifact.transfer.open",
    {
      ...(target.artifactId ? { artifactId: target.artifactId } : { sessionId: target.sessionId, path: target.path?.trim().replace(/:\d+(?::\d+)?$/u, "") }),
      ...(target.kind === "text" ? { purpose: "text-preview" } : {}),
    },
    { wait: true, timeoutMs: 60_000 },
  ));
  const chunks = new Map<number, Promise<Uint8Array>>();
  let closed = false;
  return {
    transfer,
    async read(begin: number, end: number): Promise<Uint8Array> {
      const bytes = new Uint8Array(end - begin);
      for (let index = Math.floor(begin / transfer.chunkBytes); index < Math.ceil(end / transfer.chunkBytes); index += 1) {
        if (closed) throw new Error("预览已关闭");
        let pending = chunks.get(index);
        if (!pending) {
          pending = request("artifact.transfer.read", { transferId: transfer.transferId, index }, {
            wait: true, timeoutMs: 60_000,
          }).then((response) => {
            const { chunk } = unwrap<{ chunk: BridgeArtifactTransferChunk }>(response);
            if (chunk.transferId !== transfer.transferId || chunk.index !== index) throw new Error("文件分块校验失败");
            return Uint8Array.from(atob(chunk.data), (char) => char.charCodeAt(0));
          });
          chunks.set(index, pending);
        }
        const chunk = await pending;
        const offset = index * transfer.chunkBytes;
        const from = Math.max(begin, offset);
        const to = Math.min(end, offset + chunk.length);
        bytes.set(chunk.subarray(from - offset, to - offset), from - begin);
      }
      return bytes;
    },
    async close(): Promise<void> {
      closed = true;
      chunks.clear();
      await request("artifact.transfer.close", { transferId: transfer.transferId }, {
        wait: true, timeoutMs: 20_000,
      });
    },
  };
}
