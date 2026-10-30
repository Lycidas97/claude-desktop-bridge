import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileUploadManager } from "./file-upload.js";

const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

async function uploadFixture() {
  const directory = await mkdtemp(join(tmpdir(), "bridge-file-upload-"));
  directories.push(directory);
  return {
    directory,
    manager: new FileUploadManager(),
    input: {
      owner: "phone-1",
      sessionId: "session-1",
      cwd: directory,
      name: "report.txt",
      size: 3,
      sha256: createHash("sha256").update("abc").digest("hex"),
    },
  };
}

describe("FileUploadManager", () => {
  it("saves arbitrary bytes from out-of-order chunks beneath the session cwd", async () => {
    const { directory, manager, input } = await uploadFixture();
    const bytes = Buffer.alloc(300 * 1024);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 256;
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const info = await manager.open({
      ...input,
      name: "测试 data.bin",
      size: bytes.length,
      sha256: sha256.toUpperCase(),
    });
    expect(info).toMatchObject({ chunkBytes: 256 * 1024, totalChunks: 2 });
    expect(manager.write(info.uploadId, 1, bytes.subarray(info.chunkBytes).toString("base64"), input.owner)).toBe(1);
    expect(manager.write(info.uploadId, 0, bytes.subarray(0, info.chunkBytes).toString("base64"), input.owner)).toBe(2);
    const receipt = await manager.commit(info.uploadId, input.owner);

    expect(receipt).toEqual({
      uploadId: info.uploadId,
      sessionId: input.sessionId,
      name: "测试 data.bin",
      path: `.bridge-uploads/${info.uploadId}/测试 data.bin`,
      size: bytes.length,
      sha256,
    });
    expect(await readFile(join(directory, receipt.path))).toEqual(bytes);
    expect(await manager.commit(info.uploadId, input.owner)).toEqual(receipt);
    expect(() => manager.write(info.uploadId, 0, "", input.owner)).toThrow("already committed");
  });

  it("commits an empty file after one empty chunk", async () => {
    const { directory, manager, input } = await uploadFixture();
    const info = await manager.open({
      ...input,
      size: 0,
      sha256: createHash("sha256").update("").digest("hex"),
    });

    expect(info).toMatchObject({ size: 0, totalChunks: 1 });
    await expect(manager.commit(info.uploadId, input.owner)).rejects.toThrow("incomplete");
    expect(manager.write(info.uploadId, 0, "", input.owner)).toBe(1);
    const receipt = await manager.commit(info.uploadId, input.owner);
    expect(await readFile(join(directory, receipt.path))).toEqual(Buffer.alloc(0));
  });

  it("checks chunk indices, base64, lengths, and duplicate contents", async () => {
    const { manager, input } = await uploadFixture();
    const info = await manager.open(input);
    for (const index of [-1, 0.5, 1, Number.NaN]) {
      expect(() => manager.write(info.uploadId, index, "YWJj", input.owner)).toThrow("index");
    }
    for (const data of ["!!!!", "YQ", "YWJj\n", "YWJjZA=="]) {
      expect(() => manager.write(info.uploadId, 0, data, input.owner)).toThrow("base64");
    }
    expect(() => manager.write(info.uploadId, 0, "YQ==", input.owner)).toThrow("size");
    expect(manager.write(info.uploadId, 0, "YWJj", input.owner)).toBe(1);
    expect(manager.write(info.uploadId, 0, "YWJj", input.owner)).toBe(1);
    expect(() => manager.write(info.uploadId, 0, "YWJk", input.owner)).toThrow("different bytes");
  });

  it("rejects incomplete uploads and a mismatched whole-file digest before saving", async () => {
    const { directory, manager, input } = await uploadFixture();
    const info = await manager.open(input);
    await expect(manager.commit(info.uploadId, input.owner)).rejects.toThrow("incomplete");
    manager.write(info.uploadId, 0, Buffer.from("abd").toString("base64"), input.owner);
    await expect(manager.commit(info.uploadId, input.owner)).rejects.toThrow("SHA-256 does not match");
    expect(await readdir(directory)).toEqual([]);
  });

  it("binds writing, committing, and cancelling to the owner", async () => {
    const { manager, input } = await uploadFixture();
    const info = await manager.open(input);
    expect(() => manager.write(info.uploadId, 0, "YWJj", "phone-2")).toThrow("unavailable");
    await expect(manager.commit(info.uploadId, "phone-2")).rejects.toThrow("unavailable");
    expect(manager.cancel(info.uploadId, "phone-2")).toBe(false);
    expect(manager.write(info.uploadId, 0, "YWJj", input.owner)).toBe(1);
    await manager.commit(info.uploadId, input.owner);
    await expect(manager.commit(info.uploadId, "phone-2")).rejects.toThrow("unavailable");
    expect(manager.cancel(info.uploadId, input.owner)).toBe(true);
    await expect(manager.commit(info.uploadId, input.owner)).rejects.toThrow("unavailable");
  });

  it.each(["", ".", "..", "../escape", "dir/file.txt", "dir\\file.txt", "/tmp/file.txt", "bad\u0000name", "bad\nname"])(
    "rejects unsafe upload filename %j",
    async (name) => {
      const { directory, manager, input } = await uploadFixture();
      await expect(manager.open({ ...input, name })).rejects.toThrow("safe basename");
      expect(await readdir(directory)).toEqual([]);
    },
  );

  it("validates the cwd, declared size, and SHA-256", async () => {
    const { directory, manager, input } = await uploadFixture();
    await writeFile(join(directory, "file.txt"), "abc");
    await expect(manager.open({ ...input, cwd: join(directory, "missing") })).rejects.toThrow();
    await expect(manager.open({ ...input, cwd: join(directory, "file.txt") })).rejects.toThrow("directory");
    for (const size of [-1, 0.5, Number.NaN, 20 * 1024 * 1024 + 1]) {
      await expect(manager.open({ ...input, size })).rejects.toThrow("20 MiB");
    }
    for (const sha256 of ["", "abc", "z".repeat(64)]) {
      await expect(manager.open({ ...input, sha256 })).rejects.toThrow("64-character hex");
    }
  });

  it("accepts and preserves files at the 20 MiB limit", async () => {
    const { directory, manager, input } = await uploadFixture();
    const bytes = Buffer.alloc(20 * 1024 * 1024, 0xa5);
    const info = await manager.open({
      ...input,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    for (let index = 0; index < info.totalChunks; index += 1) {
      manager.write(info.uploadId, index, bytes.subarray(index * info.chunkBytes, (index + 1) * info.chunkBytes).toString("base64"), input.owner);
    }
    const receipt = await manager.commit(info.uploadId, input.owner);
    const saved = await readFile(join(directory, receipt.path));
    expect(saved.length).toBe(bytes.length);
    expect(createHash("sha256").update(saved).digest("hex")).toBe(receipt.sha256);
  });

  it("keeps uploads with the same filename separate", async () => {
    const { directory, manager, input } = await uploadFixture();
    const paths: string[] = [];
    for (const text of ["abc", "def"]) {
      const info = await manager.open({ ...input, sha256: createHash("sha256").update(text).digest("hex") });
      manager.write(info.uploadId, 0, Buffer.from(text).toString("base64"), input.owner);
      paths.push((await manager.commit(info.uploadId, input.owner)).path);
    }
    expect(paths[0]).not.toBe(paths[1]);
    expect(await readFile(join(directory, paths[0]!), "utf8")).toBe("abc");
    expect(await readFile(join(directory, paths[1]!), "utf8")).toBe("def");
  });

  it("rejects a .bridge-uploads symlink outside the session cwd", async () => {
    const { directory, manager, input } = await uploadFixture();
    const outside = await mkdtemp(join(tmpdir(), "bridge-upload-outside-"));
    directories.push(outside);
    await symlink(outside, join(directory, ".bridge-uploads"));
    const info = await manager.open(input);
    manager.write(info.uploadId, 0, "YWJj", input.owner);

    await expect(manager.commit(info.uploadId, input.owner)).rejects.toThrow("outside the session cwd");
    expect(await readdir(outside)).toEqual([]);
  });

  it("expires uploads and drops cancelled or closed chunks", async () => {
    const { manager, input } = await uploadFixture();
    const info = await manager.open(input);
    const now = vi.spyOn(Date, "now").mockReturnValue(info.expiresAt);
    expect(() => manager.write(info.uploadId, 0, "YWJj", input.owner)).toThrow("expired");
    expect(manager.cancel(info.uploadId, input.owner)).toBe(false);
    now.mockRestore();
    const cancelled = await manager.open(input);
    manager.write(cancelled.uploadId, 0, "YWJj", input.owner);
    expect(manager.cancel(cancelled.uploadId, input.owner)).toBe(true);
    await expect(manager.commit(cancelled.uploadId, input.owner)).rejects.toThrow("unavailable");
    const closed = await manager.open(input);
    manager.close();
    expect(() => manager.write(closed.uploadId, 0, "YWJj", input.owner)).toThrow("unavailable");
  });

  it("releases active transfer slots after committing", async () => {
    const { manager, input } = await uploadFixture();
    for (let index = 0; index < 5; index += 1) {
      const info = await manager.open(input);
      manager.write(info.uploadId, 0, "YWJj", input.owner);
      await manager.commit(info.uploadId, input.owner);
    }
  });

  it("limits active uploads per owner and across owners", async () => {
    const { manager, input } = await uploadFixture();
    for (let index = 0; index < 4; index += 1) await manager.open(input);
    await expect(manager.open(input)).rejects.toThrow("Too many");
    for (let index = 0; index < 12; index += 1) await manager.open({ ...input, owner: `other-${index}` });
    await expect(manager.open({ ...input, owner: "another-phone" })).rejects.toThrow("Too many");
  });

  it("limits declared bytes and releases the budget after committing", async () => {
    const { manager, input } = await uploadFixture();
    const info = await manager.open(input);
    manager.write(info.uploadId, 0, "YWJj", input.owner);
    await manager.commit(info.uploadId, input.owner);
    for (let index = 0; index < 4; index += 1) {
      await manager.open({ ...input, owner: "phone-2", size: 20 * 1024 * 1024 });
    }
    await expect(manager.open({ ...input, owner: "phone-3", size: 1 })).rejects.toThrow("80 MiB");
  });
});
