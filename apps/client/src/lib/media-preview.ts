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
  kind: "image" | "pdf";
  artifactId?: string;
  sessionId?: string;
  path?: string;
  dataUrl?: string;
}

export function mediaKind(path: string): MediaTarget["kind"] | undefined {
  if (/\.pdf$/iu.test(path)) return "pdf";
  if (/\.(?:png|jpe?g|gif|webp|svg|avif|bmp)$/iu.test(path)) return "image";
  return undefined;
}

export function artifactMediaTarget(artifact: BridgeArtifactManifest): MediaTarget | undefined {
  const kind = artifact.kind === "image" || artifact.kind === "pdf"
    ? artifact.kind : mediaKind(artifact.name);
  if (!kind || artifact.changeKind === "deleted" || artifact.availability === "blocked"
    || artifact.availability === "expired") return undefined;
  return { name: artifact.name, kind, artifactId: artifact.id };
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
  return [...files.values()].filter((artifact) => artifactMediaTarget(artifact));
}

function unwrap<T>(response: BridgeResponse | undefined): T {
  if (!response?.ok) throw new Error(response?.error?.message ?? "文件预览失败");
  return response.result as T;
}

export async function openMediaTransfer(target: MediaTarget, request: MediaRequest) {
  const { transfer } = unwrap<{ transfer: BridgeArtifactTransferInfo }>(await request(
    "artifact.transfer.open",
    target.artifactId ? { artifactId: target.artifactId } : { sessionId: target.sessionId, path: target.path },
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
