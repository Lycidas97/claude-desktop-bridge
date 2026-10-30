import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  open,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARTIFACT_TRANSFER_TTL_MS, type BridgeArtifactTransferInfo } from "@bridge/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EvidenceManager } from "./evidence-manager.js";
import { EvidenceStore } from "./evidence-store.js";
import { FileUploadManager } from "./file-upload.js";
import { SessionEventLog } from "./session-event-log.js";

const directories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  const fixtures = directories.splice(0);
  if (fixtures.length === 0) return;
  const recycle = process.platform === "darwin"
    ? "/usr/bin/trash"
    : process.platform === "linux" ? "trash-put" : undefined;
  if (!recycle) {
    console.warn("No recycle command configured; keeping test fixtures:", fixtures);
    return;
  }
  try {
    execFileSync(recycle, fixtures);
  } catch (error) {
    console.warn("Could not recycle test fixtures; keeping remaining files:", fixtures, error);
  }
});

async function managerFixture() {
  const directory = await mkdtemp(join(tmpdir(), "bridge-evidence-manager-"));
  directories.push(directory);
  const store = new EvidenceStore({
    databasePath: join(directory, "evidence.sqlite"),
    blobsPath: join(directory, "blobs"),
    masterSecret: "manager-test-secret",
  });
  const eventLog = new SessionEventLog(join(directory, "events.jsonl"));
  await eventLog.initialize();
  const manager = new EvidenceManager({ store, eventLog });
  await manager.initialize();
  return { directory, manager, eventLog, store };
}

describe("EvidenceManager", () => {
  it("redacts recovered tool output and blocks sensitive or project-external paths", async () => {
    const { directory, manager } = await managerFixture();
    await writeFile(join(directory, "report.txt"), "report body\n");
    await writeFile(join(directory, ".env"), "SECRET=hidden\n");
    const outside = join(directory, "..", `outside-${Date.now()}.txt`);
    await writeFile(outside, "outside\n");
    directories.push(outside);

    const evidence = await manager.upsertDesktopEvidence({
      id: "desktop-evidence-1",
      sessionId: "session-1",
      cwd: directory,
      turnId: "turn-1",
      startedAt: 1_000,
      completedAt: 2_000,
      tools: [{
        id: "tool-1",
        toolName: "Bash",
        input: { command: "cat ./report.txt" },
        output: {
          exitCode: 1,
          stdout: "Authorization: Bearer top-secret\napi_key=sk-1234567890abcdefgh",
        },
        startedAt: 1_100,
        completedAt: 1_200,
      }],
      paths: [
        "report.txt",
        "./report.txt",
        join(directory, "report.txt"),
        ".env",
        outside,
      ],
    });

    expect(evidence.confidence).toBe("inferred");
    expect(evidence.tools[0]).toMatchObject({ status: "failed", exitCode: 1 });
    expect(evidence.tools[0]?.outputSummary).not.toContain("top-secret");
    expect(evidence.tools[0]?.outputSummary).not.toContain("sk-1234567890abcdefgh");
    expect(evidence.artifacts.find((artifact) => artifact.relativePath === ".env"))
      .toMatchObject({ availability: "blocked", downloadAllowed: false });
    expect(evidence.artifacts.filter((artifact) => artifact.relativePath === "report.txt"))
      .toHaveLength(1);
    const external = evidence.artifacts.find((artifact) => artifact.relativePath.startsWith("[项目外]"));
    expect(external).toMatchObject({ availability: "blocked", downloadAllowed: false });
    expect(external?.relativePath).not.toContain(directory);
    await manager.close();
  });

  it("previews text and supports owner-bound out-of-order 256 KiB transfer chunks", async () => {
    const { directory, manager } = await managerFixture();
    const bytes = Buffer.alloc(300 * 1024, 0x61);
    await writeFile(join(directory, "result.txt"), bytes);
    await manager.upsertDesktopEvidence({
      id: "desktop-evidence-2",
      sessionId: "session-1",
      cwd: directory,
      startedAt: 1_000,
      completedAt: 2_000,
      tools: [{
        id: "tool-2",
        toolName: "Write",
        input: { file_path: "result.txt" },
        output: "ok",
        startedAt: 1_100,
        completedAt: 1_200,
      }],
      paths: ["result.txt"],
    });
    const artifact = manager.get("desktop-evidence-2")!.artifacts[0]!;
    const preview = await manager.preview(artifact.id);
    const transfer = await manager.openTransfer(artifact.id, "phone-1");

    expect(preview).toMatchObject({ mode: "text", truncated: false });
    expect(transfer.chunkBytes).toBe(256 * 1024);
    expect(transfer.totalChunks).toBe(2);
    const second = manager.readTransfer(transfer.transferId, 1, "phone-1");
    const first = manager.readTransfer(transfer.transferId, 0, "phone-1");
    expect(Buffer.concat([
      Buffer.from(first.data, "base64"),
      Buffer.from(second.data, "base64"),
    ])).toEqual(bytes);
    expect(() => manager.readTransfer(transfer.transferId, 0, "phone-2"))
      .toThrow("expired");
    expect(manager.closeTransfer(transfer.transferId, "phone-1")).toBe(true);
    await manager.close();
  });

  it.each([false, true])("keeps overlapping artifact transfers readable (first text preview: %s)", async (textPreview) => {
    const { directory, manager } = await managerFixture();
    try {
      const bytes = Buffer.concat([Buffer.alloc(256 * 1024, 0x61), Buffer.alloc(44 * 1024, 0x62)]);
      await writeFile(join(directory, "shared.txt"), bytes);
      const evidence = await manager.upsertDesktopEvidence({
        id: "overlapping-artifact",
        sessionId: "session-1",
        cwd: directory,
        startedAt: 1_000,
        completedAt: 2_000,
        tools: [],
        paths: ["shared.txt"],
      });
      const first = await manager.openTransfer(evidence.artifacts[0]!.id, "phone-1", textPreview);
      const second = await manager.openTransfer(evidence.artifacts[0]!.id, "phone-1", !textPreview);

      expect(second.transferId).not.toBe(first.transferId);
      expect(second.artifactId).toBe(first.artifactId);
      for (const index of [1, 0]) {
        for (const transfer of [first, second]) {
          expect(Buffer.from(manager.readTransfer(transfer.transferId, index, "phone-1").data, "base64"))
            .toEqual(bytes.subarray(index * transfer.chunkBytes, (index + 1) * transfer.chunkBytes));
        }
      }
      expect(manager.closeTransfer(first.transferId, "phone-2")).toBe(false);
      expect(manager.closeTransfer(first.transferId, "phone-1")).toBe(true);
      expect(() => manager.readTransfer(first.transferId, 0, "phone-1")).toThrow("expired");
      expect(Buffer.from(manager.readTransfer(second.transferId, 0, "phone-1").data, "base64"))
        .toEqual(bytes.subarray(0, second.chunkBytes));
    } finally {
      await manager.close();
    }
  });

  it.each([false, true])("keeps overlapping direct-file transfers readable (first text preview: %s)", async (textPreview) => {
    const { directory, manager } = await managerFixture();
    try {
      const bytes = Buffer.concat([Buffer.alloc(256 * 1024, 0x61), Buffer.alloc(44 * 1024, 0x62)]);
      await writeFile(join(directory, "shared.txt"), bytes);
      const first = await manager.openFileTransfer(directory, "shared.txt", "phone-1", textPreview);
      const second = await manager.openFileTransfer(directory, "./shared.txt", "phone-1", !textPreview);

      expect(second.transferId).not.toBe(first.transferId);
      expect(second.artifactId).toBe(first.artifactId);
      for (const index of [1, 0]) {
        for (const transfer of [first, second]) {
          expect(Buffer.from(manager.readTransfer(transfer.transferId, index, "phone-1").data, "base64"))
            .toEqual(bytes.subarray(index * transfer.chunkBytes, (index + 1) * transfer.chunkBytes));
        }
      }
      expect(manager.closeTransfer(first.transferId, "phone-2")).toBe(false);
      expect(manager.closeTransfer(first.transferId, "phone-1")).toBe(true);
      expect(() => manager.readTransfer(first.transferId, 0, "phone-1")).toThrow("expired");
      expect(Buffer.from(manager.readTransfer(second.transferId, 0, "phone-1").data, "base64"))
        .toEqual(bytes.subarray(0, second.chunkBytes));
    } finally {
      await manager.close();
    }
  });

  it("distinguishes equal relative file paths in different working directories", async () => {
    const { directory, manager } = await managerFixture();
    try {
      await mkdir(join(directory, "project-a"));
      await mkdir(join(directory, "project-b"));
      await writeFile(join(directory, "project-a", "report.txt"), "project A\n");
      await writeFile(join(directory, "project-b", "report.txt"), "project B\n");
      const first = await manager.openFileTransfer(join(directory, "project-a"), "report.txt", "phone-1");
      const second = await manager.openFileTransfer(join(directory, "project-b"), "report.txt", "phone-1");

      expect.soft(second.artifactId).not.toBe(first.artifactId);
      expect(Buffer.from(manager.readTransfer(first.transferId, 0, "phone-1").data, "base64").toString())
        .toBe("project A\n");
      expect(Buffer.from(manager.readTransfer(second.transferId, 0, "phone-1").data, "base64").toString())
        .toBe("project B\n");
      expect(manager.closeTransfer(first.transferId, "phone-1")).toBe(true);
      expect(Buffer.from(manager.readTransfer(second.transferId, 0, "phone-1").data, "base64").toString())
        .toBe("project B\n");
    } finally {
      await manager.close();
    }
  });

  it.each(["artifact", "file"] as const)("enforces owner and global limits without invalidating active %s transfers", async (source) => {
    const { directory, manager } = await managerFixture();
    try {
      await writeFile(join(directory, "shared.txt"), "shared bytes");
      const evidence = await manager.upsertDesktopEvidence({
        id: "transfer-limits",
        sessionId: "session-1",
        cwd: directory,
        startedAt: 1_000,
        completedAt: 2_000,
        tools: [],
        paths: ["shared.txt"],
      });
      const transfers: { owner: string; info: BridgeArtifactTransferInfo }[] = [];
      for (let ownerIndex = 0; ownerIndex < 4; ownerIndex += 1) {
        const owner = `phone-${ownerIndex}`;
        for (let index = 0; index < 4; index += 1) {
          transfers.push({
            owner,
            info: source === "artifact"
              ? await manager.openTransfer(evidence.artifacts[0]!.id, owner)
              : await manager.openFileTransfer(directory, "shared.txt", owner),
          });
        }
        await expect(source === "artifact"
          ? manager.openTransfer(evidence.artifacts[0]!.id, owner)
          : manager.openFileTransfer(directory, "shared.txt", owner)).rejects.toThrow(/Too many|过多/u);
      }
      await expect(source === "artifact"
        ? manager.openTransfer(evidence.artifacts[0]!.id, "phone-extra")
        : manager.openFileTransfer(directory, "shared.txt", "phone-extra")).rejects.toThrow(/Too many|过多/u);
      for (const { owner, info } of transfers) {
        expect(Buffer.from(manager.readTransfer(info.transferId, 0, owner).data, "base64").toString())
          .toBe("shared bytes");
      }
      expect(manager.closeTransfer(transfers[0]!.info.transferId, "phone-0")).toBe(true);
      const replacement = source === "artifact"
        ? await manager.openTransfer(evidence.artifacts[0]!.id, "phone-0")
        : await manager.openFileTransfer(directory, "shared.txt", "phone-0");
      expect(Buffer.from(manager.readTransfer(replacement.transferId, 0, "phone-0").data, "base64").toString())
        .toBe("shared bytes");
    } finally {
      await manager.close();
    }
  });

  it.each(["artifact", "file"] as const)("expires overlapping %s transfers at their own ten-minute deadlines", async (source) => {
    const { directory, manager } = await managerFixture();
    try {
      await writeFile(join(directory, "shared.txt"), "shared bytes");
      const evidence = await manager.upsertDesktopEvidence({
        id: "transfer-expiry",
        sessionId: "session-1",
        cwd: directory,
        startedAt: 1_000,
        completedAt: 2_000,
        tools: [],
        paths: ["shared.txt"],
      });
      const clock = vi.spyOn(Date, "now").mockReturnValue(2_000_000_000_000);
      const first = source === "artifact"
        ? await manager.openTransfer(evidence.artifacts[0]!.id, "phone-1")
        : await manager.openFileTransfer(directory, "shared.txt", "phone-1");
      expect(first.expiresAt).toBe(Date.now() + 10 * 60 * 1000);
      clock.mockReturnValue(Date.now() + 100);
      const second = source === "artifact"
        ? await manager.openTransfer(evidence.artifacts[0]!.id, "phone-1")
        : await manager.openFileTransfer(directory, "shared.txt", "phone-1");
      expect(second.expiresAt - first.expiresAt).toBe(100);
      clock.mockReturnValue(first.expiresAt - 1);
      expect(manager.readTransfer(first.transferId, 0, "phone-1").data).toBe(Buffer.from("shared bytes").toString("base64"));
      clock.mockReturnValue(first.expiresAt);
      expect(() => manager.readTransfer(first.transferId, 0, "phone-1")).toThrow("expired");
      expect(manager.readTransfer(second.transferId, 0, "phone-1").data).toBe(Buffer.from("shared bytes").toString("base64"));
      clock.mockReturnValue(second.expiresAt);
      expect(() => manager.readTransfer(second.transferId, 0, "phone-1")).toThrow("expired");
      expect(ARTIFACT_TRANSFER_TTL_MS).toBe(10 * 60 * 1000);
    } finally {
      await manager.close();
    }
  });

  it("rejects symlink escapes and files above the 20 MiB hard limit", async () => {
    const { directory, manager } = await managerFixture();
    const outsideDirectory = await mkdtemp(join(tmpdir(), "bridge-evidence-outside-"));
    directories.push(outsideDirectory);
    await writeFile(join(outsideDirectory, "outside.txt"), "outside\n");
    await symlink(join(outsideDirectory, "outside.txt"), join(directory, "linked.txt"));
    const large = await open(join(directory, "large.bin"), "w");
    await large.truncate(20 * 1024 * 1024 + 1);
    await large.close();
    await manager.upsertDesktopEvidence({
      id: "desktop-evidence-3",
      sessionId: "session-1",
      cwd: directory,
      startedAt: 1_000,
      completedAt: 2_000,
      tools: [{
        id: "tool-3",
        toolName: "Read",
        input: { file_path: "linked.txt" },
        output: "ok",
        startedAt: 1_100,
        completedAt: 1_200,
      }],
      paths: ["linked.txt", "large.bin"],
    });
    const evidence = manager.get("desktop-evidence-3")!;
    const linked = evidence.artifacts.find((artifact) => artifact.relativePath === "linked.txt")!;
    const oversized = evidence.artifacts.find((artifact) => artifact.relativePath === "large.bin")!;

    await expect(manager.preview(linked.id)).rejects.toThrow("项目目录");
    await expect(manager.openTransfer(oversized.id, "phone-1")).rejects.toThrow("20 MiB");
    await manager.close();
  });

  it("reads session file ranges with owner checks and rejects unsafe paths", async () => {
    const { directory, manager } = await managerFixture();
    const bytes = Buffer.alloc(300 * 1024, 0x61);
    await writeFile(join(directory, "report.pdf"), bytes);
    await writeFile(join(directory, ".env"), "TEST_SECRET=fixture\n");
    const outside = await mkdtemp(join(tmpdir(), "bridge-media-outside-"));
    directories.push(outside);
    await writeFile(join(outside, "outside.pdf"), bytes);
    await symlink(join(outside, "outside.pdf"), join(directory, "escape.pdf"));
    const large = await open(join(directory, "large.pdf"), "w");
    await large.truncate(20 * 1024 * 1024 + 1);
    await large.close();

    const transfer = await manager.openFileTransfer(directory, "report.pdf", "phone-1");
    expect(transfer).toMatchObject({ mimeType: "application/pdf", size: bytes.length, totalChunks: 2 });
    const last = manager.readTransfer(transfer.transferId, 1, "phone-1");
    const first = manager.readTransfer(transfer.transferId, 0, "phone-1");
    expect(Buffer.concat([Buffer.from(first.data, "base64"), Buffer.from(last.data, "base64")])).toEqual(bytes);
    expect(() => manager.readTransfer(transfer.transferId, 0, "phone-2")).toThrow("expired");
    await expect(manager.openFileTransfer(directory, ".env", "phone-1")).rejects.toThrow();
    await expect(manager.openFileTransfer(directory, join(outside, "outside.pdf"), "phone-1")).rejects.toThrow("项目");
    await expect(manager.openFileTransfer(directory, "escape.pdf", "phone-1")).rejects.toThrow("项目");
    await expect(manager.openFileTransfer(directory, "large.pdf", "phone-1")).rejects.toThrow("20 MiB");
    expect(manager.closeTransfer(transfer.transferId, "phone-1")).toBe(true);
    expect(() => manager.readTransfer(transfer.transferId, 0, "phone-1")).toThrow("expired");
    await manager.close();
  });

  it("transfers zero-byte files as one verifiable empty chunk", async () => {
    const { directory, manager } = await managerFixture();
    await writeFile(join(directory, "empty.txt"), "");
    await manager.upsertDesktopEvidence({
      id: "desktop-evidence-4",
      sessionId: "session-1",
      cwd: directory,
      startedAt: 1_000,
      completedAt: 2_000,
      tools: [{
        id: "tool-4",
        toolName: "Write",
        input: { file_path: "empty.txt" },
        output: "ok",
        startedAt: 1_100,
        completedAt: 1_200,
      }],
      paths: ["empty.txt"],
    });
    const artifact = manager.get("desktop-evidence-4")!.artifacts[0]!;
    const transfer = await manager.openTransfer(artifact.id, "phone-1");
    const chunk = manager.readTransfer(transfer.transferId, 0, "phone-1");

    expect(transfer).toMatchObject({ size: 0, totalChunks: 1 });
    expect(chunk.data).toBe("");
    await manager.close();
  });

  it("enforces the 1 MiB text-preview limit before and after an artifact download is cached", async () => {
    const { directory, manager, store } = await managerFixture();
    const bytes = Buffer.alloc(1024 * 1024 + 1, 0x61);
    await writeFile(join(directory, "large.txt"), bytes);
    const evidence = await manager.upsertDesktopEvidence({
      id: "preview-limit",
      sessionId: "session-1",
      cwd: directory,
      startedAt: 1_000,
      completedAt: 2_000,
      tools: [],
      paths: ["large.txt"],
    });
    const artifact = evidence.artifacts[0]!;
    expect(artifact.size).toBe(0);
    await expect(manager.openTransfer(artifact.id, "phone-1", true)).rejects.toThrow("1 MB");
    const download = await manager.openTransfer(artifact.id, "phone-1");
    expect(download.size).toBe(bytes.length);
    await expect(manager.openTransfer(artifact.id, "phone-1", true)).rejects.toThrow("1 MB");

    // A cached body must also enforce the limit when its manifest has an old size.
    const record = store.artifact(artifact.id)!;
    await store.replaceArtifacts(evidence.id, [{
      manifest: { ...record.manifest, size: 0 },
      rootPath: directory,
      snapshot: bytes,
    }]);
    await expect(manager.openTransfer(artifact.id, "phone-2", true)).rejects.toThrow("1 MB");
    await manager.close();
  });

  it("accepts exactly 1 MiB for text previews and rejects larger direct-file previews after downloading", async () => {
    const { directory, manager } = await managerFixture();
    const bytes = Buffer.alloc(1024 * 1024, 0x61);
    await writeFile(join(directory, "boundary.txt"), bytes);
    const evidence = await manager.upsertDesktopEvidence({
      id: "preview-boundary",
      sessionId: "session-1",
      cwd: directory,
      startedAt: 1_000,
      completedAt: 2_000,
      tools: [],
      paths: ["boundary.txt"],
    });
    expect(await manager.openTransfer(evidence.artifacts[0]!.id, "phone-1", true)).toMatchObject({ size: bytes.length });
    const direct = await manager.openFileTransfer(directory, "boundary.txt", "phone-1", true);
    expect(direct).toMatchObject({ size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    await writeFile(join(directory, "boundary.txt"), Buffer.alloc(bytes.length + 1, 0x62));
    const download = await manager.openFileTransfer(directory, "boundary.txt", "phone-1");
    expect(download.size).toBe(bytes.length + 1);
    await expect(manager.openFileTransfer(directory, "boundary.txt", "phone-1", true)).rejects.toThrow("1 MB");
    expect(manager.readTransfer(download.transferId, 0, "phone-1").data).not.toBe("");
    await manager.close();
  });

  it("transfers arbitrary direct-file bytes with hashes, owner checks, and an empty-file chunk", async () => {
    const { directory, manager } = await managerFixture();
    const bytes = Buffer.alloc(300 * 1024, 0xff);
    await writeFile(join(directory, "binary.bin"), bytes);
    const transfer = await manager.openFileTransfer(directory, "binary.bin", "phone-1");
    expect(transfer).toMatchObject({
      name: "binary.bin",
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      totalChunks: 2,
    });
    const second = manager.readTransfer(transfer.transferId, 1, "phone-1");
    const first = manager.readTransfer(transfer.transferId, 0, "phone-1");
    expect(Buffer.concat([Buffer.from(first.data, "base64"), Buffer.from(second.data, "base64")])).toEqual(bytes);
    expect(() => manager.readTransfer(transfer.transferId, 0, "phone-2")).toThrow("expired");
    for (const index of [-1, 0.5, 2]) {
      expect(() => manager.readTransfer(transfer.transferId, index, "phone-1")).toThrow("index");
    }
    expect(manager.closeTransfer(transfer.transferId, "phone-2")).toBe(false);
    expect(manager.closeTransfer(transfer.transferId, "phone-1")).toBe(true);
    await writeFile(join(directory, "empty.bin"), "");
    const empty = await manager.openFileTransfer(directory, "empty.bin", "phone-1");
    expect(empty).toMatchObject({ size: 0, totalChunks: 1, sha256: createHash("sha256").update("").digest("hex") });
    expect(manager.readTransfer(empty.transferId, 0, "phone-1").data).toBe("");
    await manager.close();
  });

  it("confines direct-file paths and enforces the 20 MiB download limit", async () => {
    const { directory, manager } = await managerFixture();
    const outside = await mkdtemp(join(tmpdir(), "bridge-file-outside-"));
    directories.push(outside);
    await writeFile(join(outside, "outside.txt"), "outside");
    await symlink(join(outside, "outside.txt"), join(directory, "linked.txt"));
    await writeFile(join(directory, ".env"), "SECRET=hidden");
    await mkdir(join(directory, "folder"));
    const large = await open(join(directory, "large.bin"), "w");
    await large.truncate(20 * 1024 * 1024 + 1);
    await large.close();
    await expect(manager.openFileTransfer(directory, "", "phone-1")).rejects.toThrow("不能为空");
    await expect(manager.openFileTransfer(directory, "missing.txt", "phone-1")).rejects.toThrow("不存在");
    await expect(manager.openFileTransfer(directory, join(outside, "outside.txt"), "phone-1")).rejects.toThrow("项目目录");
    await expect(manager.openFileTransfer(directory, "linked.txt", "phone-1")).rejects.toThrow("项目目录");
    await expect(manager.openFileTransfer(directory, ".env", "phone-1")).rejects.toThrow();
    await expect(manager.openFileTransfer(directory, "folder", "phone-1")).rejects.toThrow("普通文件");
    await expect(manager.openFileTransfer(directory, "large.bin", "phone-1")).rejects.toThrow("20 MiB");
    const boundary = await open(join(directory, "large.bin"), "w");
    await boundary.truncate(20 * 1024 * 1024);
    await boundary.close();
    expect(await manager.openFileTransfer(directory, "large.bin", "phone-1")).toMatchObject({ size: 20 * 1024 * 1024 });
    await manager.close();
  });

  it("previews uploaded text through its .bridge-uploads relative path", async () => {
    const { directory, manager } = await managerFixture();
    const uploads = new FileUploadManager();
    const text = "uploaded notes\n测试文本\n";
    const info = await uploads.open({
      owner: "phone-1",
      sessionId: "session-1",
      cwd: directory,
      name: "notes.txt",
      size: Buffer.byteLength(text),
      sha256: createHash("sha256").update(text).digest("hex"),
    });
    uploads.write(info.uploadId, 0, Buffer.from(text).toString("base64"), "phone-1");
    const receipt = await uploads.commit(info.uploadId, "phone-1");
    const transfer = await manager.openFileTransfer(directory, receipt.path, "phone-1", true);

    expect(transfer).toMatchObject({ name: "notes.txt", mimeType: "text/plain", size: receipt.size, sha256: receipt.sha256 });
    expect(Buffer.from(manager.readTransfer(transfer.transferId, 0, "phone-1").data, "base64").toString("utf8")).toBe(text);
    uploads.close();
    await manager.close();
  });

  it("reports the hard download limit correctly for an oversized cached snapshot", async () => {
    const { directory, manager, store } = await managerFixture();
    await writeFile(join(directory, "cached.txt"), "small");
    const evidence = await manager.upsertDesktopEvidence({
      id: "cached-hard-limit",
      sessionId: "session-1",
      cwd: directory,
      startedAt: 1_000,
      completedAt: 2_000,
      tools: [],
      paths: ["cached.txt"],
    });
    vi.spyOn(store, "readArtifact").mockResolvedValue(Buffer.alloc(20 * 1024 * 1024 + 1));
    await expect(manager.openTransfer(evidence.artifacts[0]!.id, "phone-1")).rejects.toThrow("20 MiB");
    await manager.close();
  });

  it("keeps tool bodies out of evidence events and exposes redacted output only on demand", async () => {
    const { directory, manager, eventLog } = await managerFixture();
    const evidenceId = await manager.startBridgeTurn({
      sessionId: "session-1",
      cwd: directory,
      commandId: "command-1",
    });
    await manager.attachTurn(evidenceId, "turn-1");
    await manager.recordToolStarted({
      sessionId: "session-1",
      turnId: "turn-1",
      itemId: "tool-1",
      toolName: "Bash",
      toolInput: { command: "printf result" },
      at: 1_100,
    });
    await manager.recordToolCompleted({
      sessionId: "session-1",
      turnId: "turn-1",
      itemId: "tool-1",
      output: {
        exitCode: 0,
        stdout: "project source body\nAuthorization: Bearer private-token",
      },
      at: 1_200,
    });
    const evidence = await manager.finalizeBridgeTurn({
      sessionId: "session-1",
      turnId: "turn-1",
      completedAt: 1_300,
    });

    expect(evidence?.tools[0]?.outputSummary).toContain("正文按需打开");
    expect(JSON.stringify(evidence)).not.toContain("project source body");
    expect(JSON.stringify(eventLog.replay())).not.toContain("project source body");
    const outputArtifact = evidence!.artifacts.find((artifact) => artifact.kind === "log")!;
    const preview = await manager.preview(outputArtifact.id);
    expect(preview.data).toContain("project source body");
    expect(preview.data).not.toContain("private-token");
    await manager.close();
  });

  it("keeps a redacted input snapshot on tool rows and persists turn usage + runtime attribution", async () => {
    const { directory, manager } = await managerFixture();
    const evidenceId = await manager.startBridgeTurn({
      sessionId: "dsh-desktop:session-9",
      cwd: directory,
      commandId: "dsh:turn-1",
      source: "runtime-host",
      runtimeId: "dsh-desktop",
      startedAt: 2_000,
    });
    await manager.attachTurn(evidenceId, "dsh:turn-1");
    await manager.recordToolStarted({
      sessionId: "dsh-desktop:session-9",
      turnId: "dsh:turn-1",
      itemId: "call-1",
      toolName: "str_replace_editor",
      toolInput: { command: "create", path: "/tmp/x.html", file_text: "Authorization: Bearer should-hide" },
      at: 2_100,
    });
    const evidence = await manager.finalizeBridgeTurn({
      sessionId: "dsh-desktop:session-9",
      turnId: "dsh:turn-1",
      completedAt: 2_600,
      usage: { inputTokens: 120, outputTokens: 45, cacheReadTokens: 300, reasoningTokens: 12 },
    });

    expect(evidence?.source).toBe("runtime-host");
    expect(evidence?.runtimeId).toBe("dsh-desktop");
    expect(evidence?.usage).toEqual({ inputTokens: 120, outputTokens: 45, cacheReadTokens: 300, reasoningTokens: 12 });
    expect(evidence?.tools[0]?.input).toContain("create");
    expect(evidence?.tools[0]?.input).not.toContain("should-hide");
    expect(evidence?.tools[0]?.startedAt).toBe(2_100);
    expect(evidence?.completedAt).toBe(2_600);

    // Reload through the store: usage and runtime attribution survive persistence.
    const reloaded = manager.list("dsh-desktop:session-9", undefined, 10).items[0];
    expect(reloaded?.runtimeId).toBe("dsh-desktop");
    expect(reloaded?.usage).toEqual({ inputTokens: 120, outputTokens: 45, cacheReadTokens: 300, reasoningTokens: 12 });
    await manager.close();
  });

  it("fails orphaned collecting evidence after a desktop restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-evidence-restart-"));
    directories.push(directory);
    const databasePath = join(directory, "evidence.sqlite");
    const blobsPath = join(directory, "blobs");
    const previousStore = new EvidenceStore({
      databasePath,
      blobsPath,
      masterSecret: "restart-test-secret",
    });
    await previousStore.initialize();
    previousStore.saveBundle({
      id: "interrupted-evidence",
      sessionId: "session-1",
      turnId: "turn-1",
      source: "bridge-host",
      confidence: "exact",
      state: "collecting",
      startedAt: 1_000,
      toolCount: 1,
      changeCount: 0,
      artifactCount: 0,
      tools: [{
        id: "tool-1",
        toolName: "Bash",
        status: "running",
        summary: "npm test",
        startedAt: 1_100,
        truncated: false,
      }],
      artifacts: [],
      warnings: [],
    });
    await previousStore.close();

    const eventLog = new SessionEventLog(join(directory, "events.jsonl"));
    const manager = new EvidenceManager({
      store: new EvidenceStore({
        databasePath,
        blobsPath,
        masterSecret: "restart-test-secret",
      }),
      eventLog,
    });
    await manager.initialize();

    expect(manager.get("interrupted-evidence")).toMatchObject({
      confidence: "partial",
      state: "failed",
      tools: [{ status: "failed" }],
      warnings: [expect.stringContaining("重新启动")],
    });
    expect(eventLog.replay().at(-1)).toMatchObject({
      type: "evidence.failed",
      itemId: "interrupted-evidence",
    });
    await manager.close();
    await eventLog.close();
  });
});
