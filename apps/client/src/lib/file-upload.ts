import type { BridgeFileUploadInfo, BridgeResponse, BridgeUploadedFile } from "@bridge/protocol";
import type { MediaRequest } from "./media-preview.js";

export const MAX_FILE_UPLOAD_BYTES = 20 * 1024 * 1024;

export type UploadFileHandler = (
  sessionId: string,
  file: File,
  onProgress: (progress: number) => void,
  signal: AbortSignal,
) => Promise<BridgeUploadedFile>;

function unwrap<T>(response: BridgeResponse | undefined): T {
  if (!response?.ok) throw new Error(response?.error?.message ?? "文件上传失败");
  return response.result as T;
}

export async function uploadSessionFile(
  request: MediaRequest,
  sessionId: string,
  file: File,
  onProgress?: (progress: number) => void,
  signal?: AbortSignal,
): Promise<BridgeUploadedFile> {
  if (file.size > MAX_FILE_UPLOAD_BYTES) throw new Error("单个文件不能超过 20 MiB");
  signal?.throwIfAborted();
  onProgress?.(0);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  signal?.throwIfAborted();
  const { upload } = unwrap<{ upload: BridgeFileUploadInfo }>(await request(
    "file.upload.open",
    { sessionId, name: file.name, size: file.size, sha256 },
    { wait: true, timeoutMs: 60_000 },
  ));
  try {
    for (let index = 0; index < upload.totalChunks; index += 1) {
      signal?.throwIfAborted();
      const chunk = bytes.subarray(index * upload.chunkBytes, (index + 1) * upload.chunkBytes);
      let binary = "";
      for (let offset = 0; offset < chunk.length; offset += 32_768) {
        binary += String.fromCharCode(...chunk.subarray(offset, offset + 32_768));
      }
      unwrap(await request("file.upload.write", {
        uploadId: upload.uploadId, index, data: btoa(binary),
      }, { wait: true, timeoutMs: 60_000 }));
      onProgress?.(Math.min(0.99, (index + 1) / upload.totalChunks));
    }
    signal?.throwIfAborted();
    const result = unwrap<{ file: BridgeUploadedFile }>(await request(
      "file.upload.commit", { uploadId: upload.uploadId }, { wait: true, timeoutMs: 60_000 },
    ));
    onProgress?.(1);
    return result.file;
  } finally {
    // Cancel releases the transfer slot, including after commit; saved files stay in the session directory.
    await request("file.upload.cancel", { uploadId: upload.uploadId }, { wait: true, timeoutMs: 10_000 })
      .catch(() => undefined); // Disconnection must not replace the upload result; the lease also expires.
  }
}

export function appendUploadedFilePaths(text: string, files: BridgeUploadedFile[]): string {
  if (!files.length) return text.trim();
  return [text.trim(), `已上传文件（相对当前会话目录）：\n${files.map((file) => `- ${JSON.stringify(file.path)}`).join("\n")}`]
    .filter(Boolean).join("\n\n");
}
