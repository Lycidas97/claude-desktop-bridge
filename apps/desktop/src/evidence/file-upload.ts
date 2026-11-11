import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  ARTIFACT_MAX_BYTES,
  ARTIFACT_TRANSFER_CHUNK_BYTES,
  ARTIFACT_TRANSFER_TTL_MS,
  type BridgeFileUploadInfo,
  type BridgeUploadedFile,
} from "@bridge/protocol";

const MAX_TRANSFERS = 16;
const MAX_TRANSFERS_PER_OWNER = 4;
const MAX_DECLARED_BYTES = 80 * 1024 * 1024;

interface UploadRecord {
  owner: string;
  sessionId: string;
  cwd: string;
  sha256: string;
  info: BridgeFileUploadInfo;
  chunks: Map<number, Buffer>;
  receivedBytes: number;
  receipt?: BridgeUploadedFile;
}

export class FileUploadManager {
  private readonly uploads = new Map<string, UploadRecord>();

  async open(input: {
    owner: string;
    sessionId: string;
    cwd: string;
    name: string;
    size: number;
    sha256: string;
  }): Promise<BridgeFileUploadInfo> {
    this.prune();
    if (typeof input.owner !== "string" || !input.owner.trim()) throw new Error("Upload owner is required");
    if (typeof input.sessionId !== "string" || !input.sessionId.trim()) throw new Error("Upload session is required");
    if (typeof input.cwd !== "string" || !input.cwd.trim()) throw new Error("Upload cwd is required");
    if (
      typeof input.name !== "string" || !input.name || input.name === "." || input.name === ".." ||
      /[/\\\p{Cc}]/u.test(input.name)
    ) throw new Error("Upload filename must be a safe basename");
    if (!Number.isInteger(input.size) || input.size < 0 || input.size > ARTIFACT_MAX_BYTES) {
      throw new Error("Upload size must be an integer between 0 and 20 MiB");
    }
    if (typeof input.sha256 !== "string" || !/^[a-f\d]{64}$/iu.test(input.sha256)) {
      throw new Error("Upload SHA-256 must be a 64-character hex digest");
    }
    const cwd = await realpath(input.cwd);
    if (!(await stat(cwd)).isDirectory()) throw new Error("Upload cwd must be a directory");
    const transfers = [...this.uploads.values()].filter((upload) => !upload.receipt);
    if (
      transfers.length >= MAX_TRANSFERS ||
      transfers.filter((upload) => upload.owner === input.owner).length >= MAX_TRANSFERS_PER_OWNER
    ) throw new Error("Too many upload transfers are active");
    if (transfers.reduce((size, upload) => size + upload.info.size, input.size) > MAX_DECLARED_BYTES) {
      throw new Error("Upload transfers exceed the 80 MiB budget");
    }
    const info: BridgeFileUploadInfo = {
      uploadId: randomUUID(),
      name: input.name,
      size: input.size,
      chunkBytes: ARTIFACT_TRANSFER_CHUNK_BYTES,
      totalChunks: Math.max(1, Math.ceil(input.size / ARTIFACT_TRANSFER_CHUNK_BYTES)),
      expiresAt: Date.now() + ARTIFACT_TRANSFER_TTL_MS,
    };
    this.uploads.set(info.uploadId, {
      owner: input.owner,
      sessionId: input.sessionId,
      cwd,
      sha256: input.sha256.toLowerCase(),
      info,
      chunks: new Map(),
      receivedBytes: 0,
    });
    return { ...info };
  }

  write(uploadId: string, index: number, dataBase64: string, owner: string): number {
    const upload = this.get(uploadId, owner);
    if (upload.receipt) throw new Error("Upload is already committed");
    if (!Number.isInteger(index) || index < 0 || index >= upload.info.totalChunks) {
      throw new Error("Upload chunk index is invalid");
    }
    const expectedBytes = Math.min(ARTIFACT_TRANSFER_CHUNK_BYTES, upload.info.size - index * ARTIFACT_TRANSFER_CHUNK_BYTES);
    if (
      typeof dataBase64 !== "string" || dataBase64.length > 4 * Math.ceil(expectedBytes / 3) ||
      !/^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/u.test(dataBase64)
    ) throw new Error("Upload chunk base64 is invalid");
    const bytes = Buffer.from(dataBase64, "base64");
    if (bytes.byteLength !== expectedBytes) throw new Error("Upload chunk size is invalid");
    const previous = upload.chunks.get(index);
    if (previous) {
      if (!previous.equals(bytes)) throw new Error("Upload chunk already contains different bytes");
      return upload.chunks.size;
    }
    if (upload.receivedBytes + bytes.byteLength > upload.info.size) throw new Error("Upload exceeds its declared size");
    upload.chunks.set(index, bytes);
    upload.receivedBytes += bytes.byteLength;
    return upload.chunks.size;
  }

  async commit(uploadId: string, owner: string): Promise<BridgeUploadedFile> {
    const upload = this.get(uploadId, owner);
    if (upload.receipt) return { ...upload.receipt };
    if (upload.chunks.size !== upload.info.totalChunks || upload.receivedBytes !== upload.info.size) {
      throw new Error("Upload is incomplete or has an invalid size");
    }
    const chunks = [...upload.chunks.entries()].sort(([left], [right]) => left - right);
    const hash = createHash("sha256");
    for (const [, bytes] of chunks) hash.update(bytes);
    if (hash.digest("hex") !== upload.sha256) throw new Error("Upload SHA-256 does not match");

    let directory = upload.cwd;
    for (const component of [".bridge-uploads", uploadId]) {
      directory = resolve(directory, component);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      directory = await realpath(directory);
      const path = relative(upload.cwd, directory);
      if (!path || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
        throw new Error("Upload directory is outside the session cwd");
      }
    }
    const file = await open(resolve(directory, upload.info.name), "wx", 0o600);
    try {
      for (const [, bytes] of chunks) await file.writeFile(bytes);
    } finally {
      await file.close();
    }
    upload.receipt = {
      uploadId,
      sessionId: upload.sessionId,
      name: upload.info.name,
      path: `.bridge-uploads/${uploadId}/${upload.info.name}`,
      size: upload.info.size,
      sha256: upload.sha256,
    };
    upload.chunks.clear();
    return { ...upload.receipt };
  }

  cancel(uploadId: string, owner: string): boolean {
    this.prune();
    if (this.uploads.get(uploadId)?.owner !== owner) return false;
    return this.uploads.delete(uploadId);
  }

  close(): void {
    this.uploads.clear();
  }

  private get(uploadId: string, owner: string): UploadRecord {
    this.prune();
    const upload = this.uploads.get(uploadId);
    if (!upload || upload.owner !== owner) throw new Error("Upload transfer expired or unavailable");
    return upload;
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, upload] of this.uploads) {
      if (upload.info.expiresAt <= now) this.uploads.delete(id);
    }
  }
}
