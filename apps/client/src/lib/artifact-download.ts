import { Capacitor, registerPlugin } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import type {
  BridgeArtifactManifest,
  BridgeArtifactTransferChunk,
  BridgeArtifactTransferInfo,
  BridgeRequest,
  BridgeResponse,
} from "@bridge/protocol";

type RequestArtifact = (
  method: BridgeRequest["method"],
  params: Record<string, unknown>,
  options?: { wait?: boolean; timeoutMs?: number },
) => Promise<BridgeResponse | undefined>;

const BridgeFiles = registerPlugin<{ openFile(options: { path: string; mimeType: string }): Promise<void> }>("BridgeFiles");

let activeDownloadsCount = 0;
let activeDownloadsCachedBytes = 0;

export function getActiveArtifactDownloadGauges(): { activeCount: number; cachedBytes: number } {
  return {
    activeCount: activeDownloadsCount,
    cachedBytes: activeDownloadsCachedBytes,
  };
}

function unwrap<T>(response: BridgeResponse | undefined): T {
  if (!response?.ok) throw new Error(response?.error?.message ?? "成果传输失败");
  return response.result as T;
}

function base64Bytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function safeFilename(value: string): string {
  const normalized = value.replace(/[\\/:*?"<>|\u0000-\u001f]/gu, "_").trim();
  const encoder = new TextEncoder();
  const budget = new Uint8Array(160);
  const { read } = encoder.encodeInto(normalized, budget);
  if (read === normalized.length) return normalized || "Bridge-artifact";
  const dot = normalized.lastIndexOf(".");
  if (dot > 0) {
    const extension = normalized.slice(dot);
    const stemBudget = budget.length - encoder.encode(extension).length;
    if (stemBudget > 0) {
      return normalized.slice(0, encoder.encodeInto(normalized, budget.subarray(0, stemBudget)).read) + extension;
    }
  }
  return normalized.slice(0, read);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readChunkWithResume(
  request: RequestArtifact,
  transfer: BridgeArtifactTransferInfo,
  index: number,
): Promise<BridgeArtifactTransferChunk> {
  let waitMs = 500;
  while (Date.now() < transfer.expiresAt) {
    try {
      const response = unwrap<{ chunk: BridgeArtifactTransferChunk }>(await request(
        "artifact.transfer.read",
        { transferId: transfer.transferId, index },
        { wait: true, timeoutMs: 60_000 },
      ));
      return response.chunk;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/expired|index|校验|不存在|切换|取消/iu.test(message)) throw error;
      await delay(waitMs);
      waitMs = Math.min(5_000, waitMs * 2);
    }
  }
  throw new Error("成果传输租约已过期");
}

async function sha256Hex(chunks: Uint8Array[]): Promise<string> {
  const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function runArtifactTransfer(
  openParams: Record<string, unknown>,
  request: RequestArtifact,
  onProgress: (progress: number) => void,
): Promise<void> {
  const opened = unwrap<{ transfer: BridgeArtifactTransferInfo }>(await request(
    "artifact.transfer.open",
    openParams,
    { wait: true, timeoutMs: 60_000 },
  ));
  const transfer = opened.transfer;
  const chunks: Uint8Array[] = [];
  const native = Capacitor.getPlatform() === "android";
  const filename = safeFilename(transfer.name);
  const nativePath = `bridge-evidence/${transfer.transferId}/${filename}`;
  let nativeFileCreated = false;
  let transferCompleted = false;
  let bufferedBytes = 0;
  activeDownloadsCount += 1;
  try {
    for (let index = 0; index < transfer.totalChunks; index += 1) {
      const chunk = await readChunkWithResume(request, transfer, index);
      if (chunk.transferId !== transfer.transferId || chunk.index !== index) {
        throw new Error("成果分块顺序校验失败");
      }
      const bytes = base64Bytes(chunk.data);
      chunks.push(bytes);
      bufferedBytes += bytes.byteLength;
      activeDownloadsCachedBytes += bytes.byteLength;
      if (native) {
        if (index === 0) {
          await Filesystem.writeFile({
            path: nativePath,
            directory: Directory.Cache,
            data: chunk.data,
            recursive: true,
          });
          nativeFileCreated = true;
        } else {
          await Filesystem.appendFile({
            path: nativePath,
            directory: Directory.Cache,
            data: chunk.data,
          });
        }
      }
      onProgress((index + 1) / transfer.totalChunks);
    }
    if (await sha256Hex(chunks) !== transfer.sha256) throw new Error("成果完整性校验失败");
    transferCompleted = true;
    if (native) {
      await BridgeFiles.openFile({ path: nativePath, mimeType: transfer.mimeType });
      return;
    }
    const blob = new Blob(
      chunks.map((chunk) => Uint8Array.from(chunk).buffer),
      { type: transfer.mimeType },
    );
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  } finally {
    activeDownloadsCount = Math.max(0, activeDownloadsCount - 1);
    activeDownloadsCachedBytes = Math.max(0, activeDownloadsCachedBytes - bufferedBytes);
    await request(
      "artifact.transfer.close",
      { transferId: transfer.transferId },
      { wait: true, timeoutMs: 20_000 },
    ).catch(() => undefined);
    if (nativeFileCreated && !transferCompleted) {
      await Filesystem.deleteFile({
        path: nativePath,
        directory: Directory.Cache,
      }).catch(() => undefined);
    }
  }
}

export async function downloadBridgeArtifact(
  artifact: BridgeArtifactManifest,
  request: RequestArtifact,
  onProgress: (progress: number) => void,
): Promise<void> {
  await runArtifactTransfer({ artifactId: artifact.id }, request, onProgress);
}

export async function downloadBridgeSessionFile(
  sessionId: string,
  filePath: string,
  request: RequestArtifact,
  onProgress: (progress: number) => void,
  resolveRelativeLink?: true,
): Promise<void> {
  await runArtifactTransfer({ sessionId, path: filePath, ...(resolveRelativeLink ? { resolveRelativeLink } : {}) }, request, onProgress);
}
