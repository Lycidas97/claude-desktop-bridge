import { createHash } from "node:crypto";
import type { BridgeFileUploadInfo, BridgeResponse, BridgeUploadedFile } from "@bridge/protocol";
import { describe, expect, it, vi } from "vitest";
import { appendUploadedFilePaths, MAX_FILE_UPLOAD_BYTES, uploadSessionFile } from "./file-upload.js";
import type { MediaRequest } from "./media-preview.js";

const response = (result: unknown): BridgeResponse => ({ kind: "response", requestId: "upload-test", ok: true, result });
const upload: BridgeFileUploadInfo = {
  uploadId: "upload-1", name: "binary.dat", size: 0, chunkBytes: 256 * 1024, totalChunks: 1, expiresAt: Date.now() + 60_000,
};
const receipt: BridgeUploadedFile = {
  uploadId: upload.uploadId, sessionId: "session-1", name: upload.name,
  path: `.bridge-uploads/${upload.uploadId}/${upload.name}`, size: 0, sha256: "",
};

describe("session file uploads", () => {
  it("reassembles binary chunks exactly and hashes the complete file before opening", async () => {
    const bytes = Uint8Array.from({ length: upload.chunkBytes * 2 + 37 }, (_, index) => index % 256);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const chunks: Buffer[] = [];
    const methods: string[] = [];
    const progress: number[] = [];
    const request = vi.fn<MediaRequest>(async (method, params, options) => {
      methods.push(method);
      expect(options?.wait).toBe(true);
      if (method === "file.upload.open") {
        expect(params).toEqual({ sessionId: "session-1", name: "binary.dat", size: bytes.length, sha256: digest });
        return response({ upload: { ...upload, size: bytes.length, totalChunks: 3 } });
      }
      if (method === "file.upload.write") {
        expect(params.uploadId).toBe(upload.uploadId);
        expect(params.index).toBe(chunks.length);
        chunks.push(Buffer.from(params.data as string, "base64"));
        return response({ received: chunks.length });
      }
      if (method === "file.upload.commit") {
        expect(chunks.map((chunk) => chunk.length)).toEqual([upload.chunkBytes, upload.chunkBytes, 37]);
        expect(Buffer.concat(chunks).equals(Buffer.from(bytes))).toBe(true);
        expect(createHash("sha256").update(Buffer.concat(chunks)).digest("hex")).toBe(digest);
        expect(progress.at(-1)).toBeLessThan(1);
        return response({ file: { ...receipt, size: bytes.length, sha256: digest } });
      }
      expect(params).toEqual({ uploadId: upload.uploadId });
      return response({ cancelled: true });
    });
    const file = await uploadSessionFile(request, "session-1", new File([bytes], "binary.dat"), (value) => progress.push(value));
    expect(file).toEqual({ ...receipt, size: bytes.length, sha256: digest });
    expect(methods).toEqual(["file.upload.open", "file.upload.write", "file.upload.write", "file.upload.write", "file.upload.commit", "file.upload.cancel"]);
    expect(progress).toEqual([0, 1 / 3, 2 / 3, 0.99, 1]);
  });

  it("uploads an empty file using its single empty chunk", async () => {
    const request = vi.fn<MediaRequest>(async (method, params) => {
      if (method === "file.upload.open") {
        expect(params.sha256).toBe(createHash("sha256").digest("hex"));
        return response({ upload });
      }
      if (method === "file.upload.write") expect(params).toEqual({ uploadId: upload.uploadId, index: 0, data: "" });
      return response(method === "file.upload.commit" ? { file: receipt } : {});
    });
    expect(await uploadSessionFile(request, "session-1", new File([], "binary.dat"))).toEqual(receipt);
    expect(request.mock.calls.map(([method]) => method)).toContain("file.upload.commit");
  });

  it("accepts exactly 20 MiB and rejects larger files before reading or requesting", async () => {
    const file = new File([new Uint8Array(MAX_FILE_UPLOAD_BYTES)], "limit.dat");
    const request = vi.fn<MediaRequest>(async (method) => {
      if (method === "file.upload.open") return response({ upload: { ...upload, name: file.name, size: file.size, totalChunks: 80 } });
      if (method === "file.upload.commit") return response({ file: { ...receipt, name: file.name, size: file.size } });
      return response({});
    });
    expect((await uploadSessionFile(request, "session-1", file)).size).toBe(MAX_FILE_UPLOAD_BYTES);
    expect(request.mock.calls.filter(([method]) => method === "file.upload.write")).toHaveLength(80);
    const oversized = new File([], "oversized.dat");
    Object.defineProperty(oversized, "size", { value: MAX_FILE_UPLOAD_BYTES + 1 });
    const read = vi.spyOn(oversized, "arrayBuffer");
    request.mockClear();
    await expect(uploadSessionFile(request, "session-1", oversized)).rejects.toThrow("20 MiB");
    expect(read).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("cancels after a failed chunk without committing or hiding the original failure", async () => {
    const request = vi.fn<MediaRequest>(async (method) => {
      if (method === "file.upload.open") return response({ upload });
      if (method === "file.upload.write") return { kind: "response", requestId: "bad-chunk", ok: false, error: { code: "UPLOAD_FAILED", message: "chunk rejected", retryable: false } };
      if (method === "file.upload.cancel") throw new Error("connection closed");
      throw new Error(`Unexpected method ${method}`);
    });
    await expect(uploadSessionFile(request, "session-1", new File([], "binary.dat"))).rejects.toThrow("chunk rejected");
    expect(request.mock.calls.map(([method]) => method)).toEqual(["file.upload.open", "file.upload.write", "file.upload.cancel"]);
  });

  it("cancels an active upload when removed and sends no subsequent chunks", async () => {
    const controller = new AbortController();
    const request = vi.fn<MediaRequest>(async (method) => {
      if (method === "file.upload.open") return response({ upload: { ...upload, chunkBytes: 1, totalChunks: 2, size: 2 } });
      if (method === "file.upload.write") controller.abort();
      return response({});
    });
    await expect(uploadSessionFile(request, "session-1", new File([new Uint8Array([0, 255])], "binary.dat"), undefined, controller.signal))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(request.mock.calls.map(([method]) => method)).toEqual(["file.upload.open", "file.upload.write", "file.upload.cancel"]);
  });

  it("appends relative paths for files-only messages and preserves whitespace within paths", () => {
    const file = { ...receipt, path: '.bridge-uploads/upload-1/report "final" \\ v2.txt' };
    expect(appendUploadedFilePaths("  please read  ", [file])).toBe(`please read\n\n已上传文件（相对当前会话目录）：\n- ${JSON.stringify(file.path)}`);
    expect(appendUploadedFilePaths("", [file])).toBe(`已上传文件（相对当前会话目录）：\n- ${JSON.stringify(file.path)}`);
    expect(appendUploadedFilePaths(" text only ", [])).toBe("text only");
  });
});
