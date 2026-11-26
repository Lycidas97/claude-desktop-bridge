import { once } from "node:events";
import { mkdir, readFile, readdir, realpath, symlink, truncate, writeFile } from "node:fs/promises";
import { ARTIFACT_MAX_BYTES, BridgeCrypto, isEncryptedEnvelope, type BridgeArtifactTransferInfo } from "@bridge/protocol";
import { EvidenceManager } from "../evidence/evidence-manager.js";
import { EvidenceStore } from "../evidence/evidence-store.js";
import { createControllerFixture } from "../controller/controller-fixture.js";
import { basename, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { NativeCallError } from "./claude-desktop-inspector.js";
import { fixture, planMessage } from "./claude-desktop-bridge-fixture.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, realpath: vi.fn(fs.realpath) };
});

describe("native workspace paths and file delivery", () => {
  it("keeps all five native image refs and exact text in history and accepted without persisting bytes", async () => {
    const f = await fixture();
    try {
      const images = Array.from({ length: 5 }, (_, index) => ({ type: "image", name: `photo-${index}.jpg`, source: { type: "base64", media_type: "image/jpeg", data: Buffer.from(`original image ${index}`).toString("base64") } }));
      const message = { type: "user", uuid: "native-user-uuid", message: { id: "different-body-id", content: [{ type: "text", text: "  literal [图片] text  " }, ...images] } };
      f.native.page.messages = [message, { ...message, uuid: "image-only", message: { content: images } }, { ...message, uuid: "internal", isSynthetic: true }];
      const history = await f.bridge.history("local-native");
      expect(history.items).toHaveLength(2);
      expect(history.items[0]).toMatchObject({ id: "native-user-uuid", text: "  literal [图片] text  ", attachments: images.map((image, imageIndex) => ({ id: `native-image:native-user-uuid:${imageIndex}`, name: image.name, mimeType: "image/jpeg", size: Buffer.from(image.source.data, "base64").length, nativeImage: { messageUuid: "native-user-uuid", imageIndex } })) });
      expect(history.items[1]).toMatchObject({ id: "image-only", text: "" });
      expect(history.items[1]!.attachments).toHaveLength(5);
      await f.message(message);
      await f.message({ ...message, uuid: "internal", isSynthetic: true });
      const accepted = f.eventLog.replay(0).filter(event => event.type === "user.message.accepted");
      expect(accepted).toHaveLength(1);
      expect(accepted[0]).toMatchObject({ itemId: "native-user-uuid", data: { text: history.items[0]!.text, attachments: history.items[0]!.attachments } });
      const persisted = await readFile(f.eventLog.path, "utf8");
      for (const image of images) {
        expect(JSON.stringify(history)).not.toContain(image.source.data);
        expect(persisted).not.toContain(image.source.data);
      }
    } finally { await f.close(); }
  });

  it("projects ten five-image messages below the real encrypted envelope limit and streams exact originals", async () => {
    const f = await fixture();
    const directory = join(f.options.settingsPath, "..");
    const store = new EvidenceStore({ databasePath: join(directory, "media.sqlite"), blobsPath: join(directory, "media-blobs"), masterSecret: Buffer.alloc(32, 4).toString("base64url") });
    const evidence = new EvidenceManager({ store, eventLog: f.eventLog });
    await evidence.initialize();
    try {
      const images = Array.from({ length: 5 }, (_, index) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: Buffer.alloc(202_500, index + 1).toString("base64") } }));
      const messages = Array.from({ length: 10 }, (_, index) => ({ type: "user", uuid: `large-user-${index}`, message: { content: images } }));
      f.native.page.messages = messages;
      const { crypto } = await BridgeCrypto.createDesktop("ws://localhost:8788/ws", "Fixture");
      const rawEnvelope = await crypto.encrypt({ kind: "response", requestId: "raw", ok: true, result: { messages } }, "desktop", "mobile");
      expect(rawEnvelope.ciphertext.length).toBeGreaterThan(16_000_000);
      expect(isEncryptedEnvelope(rawEnvelope)).toBe(false);
      const history = await f.bridge.history("local-native", undefined, 10);
      expect(history.items).toHaveLength(10);
      expect(history.items.every(item => item.attachments?.length === 5)).toBe(true);
      const metadataEnvelope = await crypto.encrypt({ kind: "response", requestId: "history", ok: true, result: { history } }, "desktop", "mobile");
      expect(isEncryptedEnvelope(metadataEnvelope)).toBe(true);
      expect(metadataEnvelope.ciphertext.length).toBeLessThan(30_000);
      for (const message of messages) await f.message(message);
      expect(JSON.stringify(f.eventLog.replay(0))).not.toContain(images[0]!.source.data);
      for (const imageIndex of [0, 1, 2, 3, 4]) {
        const image = await f.bridge.readNativeImage("local-native", { messageUuid: "large-user-7", imageIndex });
        const transfer = evidence.openBytesTransfer(image, "phone");
        const bytes = Buffer.concat(Array.from({ length: transfer.totalChunks }, (_, index) => Buffer.from(evidence.readTransfer(transfer.transferId, index, "phone").data, "base64")));
        expect(bytes).toEqual(Buffer.from(images[imageIndex]!.source.data, "base64"));
        expect(() => evidence.readTransfer(transfer.transferId, 0, "other-phone")).toThrow("expired");
        expect(evidence.closeTransfer(transfer.transferId, "phone")).toBe(true);
      }
      const original = Buffer.alloc(600 * 1024, 0x72);
      const multiChunk = { type: "user", uuid: "multi-chunk", message: { content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: original.toString("base64") } }] } };
      f.native.page.messages = [multiChunk];
      const transfer = evidence.openBytesTransfer(await f.bridge.readNativeImage("local-native", { messageUuid: "multi-chunk", imageIndex: 0 }), "phone");
      expect(transfer.totalChunks).toBe(3);
      expect(Buffer.concat([0, 1, 2].map(index => Buffer.from(evidence.readTransfer(transfer.transferId, index, "phone").data, "base64")))).toEqual(original);
      expect(store.artifact(transfer.artifactId)).toBeUndefined();
      expect(await readdir(join(directory, "media-blobs"))).toEqual([]);
      f.native.page.messages = messages;
      await expect(f.bridge.readNativeImage("local-native", { messageUuid: "missing", imageIndex: 0 })).rejects.toThrow();
      await expect(f.bridge.readNativeImage("local-native", { messageUuid: "large-user-7", imageIndex: 5 })).rejects.toThrow();
    } finally { await evidence.close(); await f.close(); }
  }, 30_000);

  it.each(["embedded", "external", "nested", "fork", "live", "worktree-only", "worktree-first", "alias"])("groups a linked worktree with its repository while retaining its execution cwd and native identity (%s)", async layout => {
    const f = await fixture();
    try {
      const directory = join(f.options.settingsPath, "..");
      const physicalProject = join(directory, "repo");
      const project = layout === "alias" ? join(directory, "repo-alias") : physicalProject;
      if (layout === "alias") {
        await mkdir(physicalProject, { recursive: true });
        await symlink(physicalProject, project, "junction");
      }
      const worktree = layout === "external" ? join(directory, "outside-worktree") : join(physicalProject, ".claude", "worktrees", "adoring-khayyam");
      const cwd = layout === "nested" ? join(worktree, "src") : worktree;
      const gitDir = join(physicalProject, ".git", "worktrees", "adoring-khayyam");
      await Promise.all([
        mkdir(join(project, ".git", "objects"), { recursive: true }),
        mkdir(join(project, ".git", "refs"), { recursive: true }),
        mkdir(gitDir, { recursive: true }),
        mkdir(cwd, { recursive: true }),
      ]);
      await Promise.all([
        writeFile(join(project, ".git", "HEAD"), "ref: refs/heads/main\n"),
        writeFile(join(gitDir, "HEAD"), "ref: refs/heads/task\n"),
        writeFile(join(gitDir, "commondir"), "../..\n"),
        writeFile(join(gitDir, "gitdir"), join(worktree, ".git") + "\n"),
        writeFile(join(worktree, ".git"), `gitdir: ${gitDir}\n`),
      ]);
      Object.assign(f.native.sessions[0]!, { cwd: project });
      await f.bridge.refreshRuntime();
      const original = f.bridge.session("local-native")!;
      const child = { ...f.native.sessions[0]!, sessionId: "worktree-native", cwd, title: "Compression implementation", ...(layout === "fork" ? { forkedFromSessionId: "local-native" } : {}) };
      if (layout === "worktree-only") f.native.sessions = [child];
      else if (layout === "worktree-first") f.native.sessions.unshift(child);
      else f.native.sessions.push(child);
      if (layout === "live") {
        const changed = once(f.bridge, "changed");
        f.native.emit("event", { type: "session", sessionId: child.sessionId, session: child });
        await changed;
      } else await f.bridge.refreshRuntime();
      expect(f.bridge.session("worktree-native")).toMatchObject({
        sessionId: "worktree-native", cwd,
        projectId: original.projectId, projectName: original.projectName,
      });
      expect(f.bridge.executionCwd("worktree-native")).toBe(cwd);
      expect(f.bridge.session("worktree-native")?.parentSessionId).toBe(layout === "fork" ? "local-native" : undefined);
      expect(f.bridge.listProjects()).toEqual([expect.objectContaining({ projectId: original.projectId, name: original.projectName, cwd: project, sessionCount: layout === "worktree-only" ? 1 : 2 })]);
      await f.bridge.configuration("worktree-native");
      expect(f.bridge.session("worktree-native")?.projectId).toBe(original.projectId);
      f.native.emit("disconnected");
      expect(f.bridge.session("worktree-native")?.projectId).toBe(original.projectId);
      expect(f.native.calls.every(call => ["getAll", "getAvailableCodeModels", "getSession"].includes(call.method))).toBe(true);
    } finally { await f.close(); }
  });

  it.each(["plain", "lookalike", "nested-repository", "submodule", "primary-subdirectory", "broken-git-file"])("keeps unrelated directory projects distinct (%s)", async layout => {
    const f = await fixture();
    try {
      const directory = join(f.options.settingsPath, "..");
      const project = join(directory, "repo");
      const cwd = layout === "plain" ? join(directory, "plain") : layout === "primary-subdirectory" ? join(project, "packages", "client") : join(project, ".claude", "worktrees", "independent");
      await Promise.all([mkdir(join(project, ".git", "objects"), { recursive: true }), mkdir(join(project, ".git", "refs"), { recursive: true }), mkdir(cwd, { recursive: true })]);
      await writeFile(join(project, ".git", "HEAD"), "ref: refs/heads/main\n");
      if (layout === "nested-repository" || layout === "submodule") {
        const gitDir = layout === "submodule" ? join(project, ".git", "modules", "independent") : join(cwd, ".git");
        await Promise.all([mkdir(join(gitDir, "objects"), { recursive: true }), mkdir(join(gitDir, "refs"), { recursive: true })]);
        await writeFile(join(gitDir, "HEAD"), "ref: refs/heads/main\n");
        if (layout === "submodule") await writeFile(join(cwd, ".git"), `gitdir: ${gitDir}\n`);
      }
      if (layout === "broken-git-file") await writeFile(join(cwd, ".git"), "gitdir: missing-directory\n");
      Object.assign(f.native.sessions[0]!, { cwd: project });
      f.native.sessions.push({ ...f.native.sessions[0]!, sessionId: "separate-native", cwd });
      await f.bridge.refreshRuntime();
      expect(f.bridge.session("separate-native")).toMatchObject({ cwd, projectName: basename(cwd) });
      expect(f.bridge.session("separate-native")?.projectId).not.toBe(f.bridge.session("local-native")?.projectId);
      expect(f.bridge.listProjects()).toHaveLength(2);
      expect(f.bridge.listProjects().map(project => project.cwd)).toEqual([project, cwd]);
    } finally { await f.close(); }
  });

  it.each(["worktree-only", "same-name", "plain"])("previews native files from the execution directory without changing the project (%s)", async mode => {
    const f = await fixture();
    const directory = join(f.options.settingsPath, "..");
    const store = new EvidenceStore({ databasePath: join(directory, "files.sqlite"), blobsPath: join(directory, "file-blobs"), masterSecret: Buffer.alloc(32, 4).toString("base64url") });
    const evidence = new EvidenceManager({ store, eventLog: f.eventLog });
    await evidence.initialize();
    try {
      const project = join(directory, "repo");
      const harnessCwd = join(project, ".claude/worktrees/工作树");
      const readCwd = mode === "plain" ? project : harnessCwd;
      const relativePath = "artifacts/browser run/report.json";
      await mkdir(join(readCwd, "artifacts/browser run"), { recursive: true });
      if (mode === "same-name") {
        await mkdir(join(project, "artifacts/browser run"), { recursive: true });
        await writeFile(join(project, relativePath), "wrong project-root report");
      }
      await writeFile(join(readCwd, relativePath), "{\"source\":\"execution directory\"}");
      Object.assign(f.native.sessions[0]!, { cwd: project, ...(mode !== "plain" ? { harnessCwd } : {}) });
      await f.bridge.refreshRuntime();
      const controller = createControllerFixture({ broker: f.bridge, evidence });
      for (const path of [relativePath, `./${relativePath}`, `${relativePath}:12:3`, `repo/${relativePath}`, join(readCwd, relativePath)]) {
        const { transfer } = await controller.handleRequest({ kind: "request", requestId: "preview", idempotencyKey: "preview", method: "artifact.transfer.open", params: { sessionId: "local-native", path, purpose: "text-preview" } }, "mobile", "phone") as { transfer: BridgeArtifactTransferInfo };
        expect(transfer).toMatchObject({ name: "report.json", mimeType: "text/plain" });
        expect(Buffer.from(evidence.readTransfer(transfer.transferId, 0, "phone").data, "base64").toString()).toBe("{\"source\":\"execution directory\"}");
        evidence.closeTransfer(transfer.transferId, "phone");
      }
      expect(f.bridge.session("local-native")?.cwd).toBe(project);
      expect(f.bridge.listProjects()[0]?.cwd).toBe(project);
    } finally { await evidence.close(); await f.close(); }
  });

  it("previews a relative link to a file Desktop resolves in a shell subdirectory", async () => {
    const f = await fixture();
    const store = new EvidenceStore({ databasePath: join(f.directory, "files.sqlite"), blobsPath: join(f.directory, "file-blobs"), masterSecret: Buffer.alloc(32, 4).toString("base64url") });
    const evidence = new EvidenceManager({ store, eventLog: f.eventLog });
    await evidence.initialize();
    try {
      const project = join(f.directory, "repo");
      const subdirectory = join(project, "shell-work");
      const name = "report.md";
      const contents = "# Shell report";
      await mkdir(subdirectory, { recursive: true });
      await writeFile(join(subdirectory, name), contents);
      Object.assign(f.native.sessions[0]!, { cwd: project });
      await f.bridge.refreshRuntime();
      f.native.resolvedSessionFiles.set(name, join(subdirectory, name));
      f.native.resolvedSessionFiles.set(`output/${name}`, join(subdirectory, name));
      const controller = createControllerFixture({ broker: f.bridge, evidence, allSessions: () => f.bridge.listSessions() });
      await expect(controller.handleRequest({ kind: "request", requestId: "sidebar", idempotencyKey: "sidebar", method: "artifact.transfer.open", params: { sessionId: "local-native", path: `output/${name}`, purpose: "stat" } }, "mobile", "phone")).rejects.toThrow("文件不存在或无法读取");
      expect(await controller.handleRequest({ kind: "request", requestId: "stat", idempotencyKey: "stat", method: "artifact.transfer.open", params: { sessionId: "local-native", path: name, purpose: "stat", resolveRelativeLink: true } }, "mobile", "phone")).toMatchObject({ metadata: { name, size: Buffer.byteLength(contents) } });
      const { transfer } = await controller.handleRequest({ kind: "request", requestId: "preview", idempotencyKey: "preview", method: "artifact.transfer.open", params: { sessionId: "local-native", path: `${name}:12:3`, purpose: "text-preview", resolveRelativeLink: true } }, "mobile", "phone") as { transfer: BridgeArtifactTransferInfo };
      expect(Buffer.from(evidence.readTransfer(transfer.transferId, 0, "phone").data, "base64").toString()).toBe(contents);
      expect(f.native.calls.filter(call => call.method === "resolveSessionFileQuietly").map(call => call.args)).toEqual([["local-native", name], ["local-native", name]]);
    } finally { await evidence.close(); await f.close(); }
  });

  it.each(["outside-project", "parent-checkout"])("keeps Desktop's relative file fallback inside the allowed directory (%s)", async location => {
    const f = await fixture();
    const store = new EvidenceStore({ databasePath: join(f.directory, "files.sqlite"), blobsPath: join(f.directory, "file-blobs"), masterSecret: Buffer.alloc(32, 4).toString("base64url") });
    const evidence = new EvidenceManager({ store, eventLog: f.eventLog });
    await evidence.initialize();
    try {
      const project = join(f.directory, "repo");
      const harnessCwd = join(project, ".claude/worktrees/task");
      await mkdir(harnessCwd, { recursive: true });
      const name = "report.md";
      const parentCheckout = location === "parent-checkout";
      const resolved = join(parentCheckout ? project : f.directory, name);
      await writeFile(resolved, "other report");
      Object.assign(f.native.sessions[0]!, { cwd: project, ...(parentCheckout ? { harnessCwd } : {}) });
      await f.bridge.refreshRuntime();
      f.native.resolvedSessionFiles.set(name, resolved);
      const controller = createControllerFixture({ broker: f.bridge, evidence, allSessions: () => f.bridge.listSessions() });
      await expect(controller.handleRequest({ kind: "request", requestId: "preview", idempotencyKey: "preview", method: "artifact.transfer.open", params: { sessionId: "local-native", path: name, purpose: "text-preview", resolveRelativeLink: true } }, "mobile", "phone")).rejects.toThrow(parentCheckout ? "工作树之外" : "项目目录之外");
    } finally { await evidence.close(); await f.close(); }
  });

  it("archives native relative tool paths from the execution directory under the original project root", async () => {
    const upsertDesktopEvidence = vi.fn();
    const f = await fixture(false, { upsertDesktopEvidence });
    const directory = join(f.options.settingsPath, "..");
    const store = new EvidenceStore({ databasePath: join(directory, "files.sqlite"), blobsPath: join(directory, "file-blobs"), masterSecret: Buffer.alloc(32, 4).toString("base64url") });
    const evidence = new EvidenceManager({ store, eventLog: f.eventLog });
    await evidence.initialize();
    upsertDesktopEvidence.mockImplementation(input => evidence.upsertDesktopEvidence(input));
    try {
      const project = join(directory, "repo");
      const harnessCwd = join(project, ".claude/worktrees/task");
      await mkdir(harnessCwd, { recursive: true });
      await writeFile(join(project, "report.json"), "wrong root report");
      await writeFile(join(harnessCwd, "report.json"), "correct worktree report");
      Object.assign(f.native.sessions[0]!, { cwd: project, harnessCwd });
      await f.bridge.refreshRuntime();
      await f.message({ type: "assistant", uuid: "file-call", message: { content: [{ type: "tool_use", id: "write-report", name: "Write", input: { file_path: "report.json" } }] } });
      await f.message({ type: "user", uuid: "file-result", message: { content: [{ type: "tool_result", tool_use_id: "write-report", content: "File written" }] } });
      expect(upsertDesktopEvidence).toHaveBeenCalledTimes(1);
      const artifact = store.get("native:local-native:write-report")!.artifacts[0]!;
      expect(artifact.relativePath).toBe(".claude/worktrees/task/report.json");
      expect(store.artifact(artifact.id)?.rootPath).toBe(project);
      const transfer = await evidence.openTransfer(artifact.id, "phone");
      expect(Buffer.from(evidence.readTransfer(transfer.transferId, 0, "phone").data, "base64").toString()).toBe("correct worktree report");
    } finally { await evidence.close(); await f.close(); }
  });

  it("collects evidence for a newly observed session before its deferred projection", async () => {
    const upsertDesktopEvidence = vi.fn().mockResolvedValue({});
    const f = await fixture(false, { upsertDesktopEvidence });
    try {
      const session = { ...f.native.sessions[0], sessionId: "new-native", cwd: "/new-project" };
      f.native.sessions.push(session);
      expect(f.bridge.session("new-native")).toBeUndefined();
      f.native.emit("event", { type: "message", sessionId: "new-native", session, message: { type: "assistant", uuid: "new-call", message: { content: [{ type: "tool_use", id: "new-tool", name: "Read", input: { file_path: "/new-project/a.ts" } }] } } });
      f.native.emit("event", { type: "message", sessionId: "new-native", session, message: { type: "user", uuid: "new-result", message: { content: [{ type: "tool_result", tool_use_id: "new-tool", content: "file contents" }] } } });
      await vi.waitFor(() => {
        expect(upsertDesktopEvidence).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sessionId: "new-native", cwd: "/new-project", readCwd: "/new-project", paths: ["/new-project/a.ts"] }));
        expect(f.bridge.session("new-native")?.cwd).toBe("/new-project");
      });
    } finally { await f.close(); }
  });

  it("collects evidence when tool start and result arrive in the same batch", async () => {
    const upsertDesktopEvidence = vi.fn().mockResolvedValue({});
    const f = await fixture(false, { upsertDesktopEvidence });
    try {
      f.native.emit("event", { sessionId: "local-native", message: { type: "assistant", uuid: "call", message: { content: [{ type: "tool_use", id: "T", name: "Read", input: { file_path: "/project/a.ts" } }] } } });
      f.native.emit("event", { sessionId: "local-native", message: { type: "user", uuid: "result", message: { content: [{ type: "tool_result", tool_use_id: "T", content: "file contents" }] } } });
      await vi.waitFor(() => expect(upsertDesktopEvidence).toHaveBeenCalledTimes(1), { timeout: 500 });
    } finally { await f.close(); }
  });

  it("projects only the native SendUserFile receipt, in split history and on live completion", async () => {
    const f = await fixture();
    try {
      const cwd = join(f.directory, "project");
      const harnessCwd = join(cwd, "worktree");
      await mkdir(harnessCwd, { recursive: true });
      const inside = join(harnessCwd, "报告.md");
      const outside = join(f.directory, "工作区外.md");
      const large = join(harnessCwd, "large.apk");
      await Promise.all([
        writeFile(inside, "worktree"), writeFile(outside, "outside"), writeFile(join(cwd, "报告.md"), "namesake"),
        writeFile(join(harnessCwd, ".env.example"), "EXAMPLE=fixture"), writeFile(large, ""),
        writeFile(join(harnessCwd, "同名上传.pdf"), "different local file"),
      ]);
      await truncate(large, ARTIFACT_MAX_BYTES + 1);
      Object.assign(f.native.sessions[0]!, { cwd, harnessCwd });
      await f.bridge.refreshRuntime();
      const call = planMessage("send-call", { files: [outside, "unconfirmed.txt"] }, 10, "SendUserFile");
      const result = { type: "user", uuid: "send-result", timestamp: 20, message: { content: [{
        type: "tool_result", tool_use_id: call.uuid, content: [{ type: "text", text: "Files sent" }],
      }] }, toolUseResult: { attachments: [
        { path: "报告.md", size: 8, isImage: false, pathValidated: true, project_path: "项目文件夹/报告.md" },
        { path: outside, size: 7, isImage: false },
        { path: join(cwd, "报告.md"), size: 8, isImage: false },
        { path: ".env.example", size: 15, isImage: false },
        { path: "large.apk", size: 20, isImage: false }, // Grew after being shared; the current size governs transport.
        { path: "missing.pdf", size: 32, isImage: false },
        { path: "同名上传.pdf", size: 13, isImage: false, file_uuid: "uploaded-file-id" },
        { path: "project-only.pdf", size: 32, isImage: false, project_path: "项目文件夹/project-only.pdf" },
        { path: "upload-failed.md", size: 100, isImage: false, upload_error: "not delivered" },
      ] } };
      const expected = [
        { name: "报告.md", path: await realpath(inside) },
        { name: "工作区外.md", blockedReason: "文件不在会话工作区内" },
        { name: "报告.md", blockedReason: "文件不在会话工作区内" },
        { name: ".env.example", blockedReason: "环境变量文件不允许远程读取" },
        { name: "large.apk", blockedReason: "文件超过 20 MiB 传输上限" },
        { name: "missing.pdf", blockedReason: "找不到文件或无法读取" },
        { name: "同名上传.pdf", blockedReason: "没有可供传输的本地文件" },
        { name: "project-only.pdf", blockedReason: "没有可供传输的本地文件" },
      ];
      f.native.pages.set("", { messages: [result], hasMore: true });
      f.native.pages.set(result.uuid, { messages: [call], hasMore: false });
      const latest = await f.bridge.history("local-native", undefined, 1);
      expect(latest).toMatchObject({ items: [], nextCursor: result.uuid, sessionFileReceipts: { [call.uuid]: expected } });
      const older = await f.bridge.history("local-native", latest.nextCursor, 1);
      expect(older.items).toMatchObject([{ id: call.uuid, createdAt: 10, toolName: "SendUserFile" }]);
      expect(older.sessionFileReceipts).toBeUndefined();
      await f.message(call);
      const start = f.eventLog.latestItem("local-native", "tool.started", call.uuid);
      expect(start?.data.sentFiles).toBeUndefined();
      const reads = f.native.calls.length;
      await f.message(result);
      expect(f.eventLog.latestItem("local-native", "tool.completed", call.uuid)?.data.sentFiles).toEqual(expected);
      expect(f.native.calls.slice(reads).some(({ method }) => method === "getTranscript")).toBe(false);
      const unrelated = planMessage("other-call", {}, 30, "Read");
      await f.message(unrelated);
      await f.message({ ...result, message: { content: [{ ...result.message.content[0], tool_use_id: unrelated.uuid }] } });
      expect(f.eventLog.latestItem("local-native", "tool.completed", unrelated.uuid)?.data.sentFiles).toBeUndefined();
    } finally { await f.close(); }
  });

  it("projects all 33 successful attachments in a native SendUserFile receipt", async () => {
    const f = await fixture();
    try {
      const cwd = await realpath(f.directory);
      f.native.sessions[0]!.cwd = cwd;
      await f.bridge.refreshRuntime();
      const names = Array.from({ length: 33 }, (_, index) => `attachment-${index + 1}.txt`);
      await Promise.all(names.map(name => writeFile(join(cwd, name), "x")));
      f.native.page.messages = [{ type: "user", uuid: "receipt", message: { content: [{
        type: "tool_result", tool_use_id: "send", content: "Files sent",
      }] }, toolUseResult: { attachments: names.map(path => ({ path, size: 1, isImage: false })) } }];
      const page = await f.bridge.history("local-native");
      expect(page.sessionFileReceipts?.send).toEqual(names.map(name => ({ name, path: join(cwd, name) })));
    } finally { await f.close(); }
  });

  it("keeps the file receipt and ordinary history while the native directory is rebuilding", async () => {
    const f = await fixture();
    let releasePath!: () => void;
    let releaseRefresh!: () => void;
    const pathGate = new Promise<void>(resolve => { releasePath = resolve; });
    const refreshGate = new Promise<void>(resolve => { releaseRefresh = resolve; });
    try {
      const cwd = await realpath(f.directory);
      const worktree = join(cwd, "worktree");
      await mkdir(worktree);
      await writeFile(join(worktree, "sent.txt"), "x");
      Object.assign(f.native.sessions[0]!, { cwd, harnessCwd: worktree });
      await f.bridge.refreshRuntime();
      f.native.pages.set("older", { messages: [
        { type: "assistant", uuid: "plain", message: { content: [{ type: "text", text: "Ordinary history" }] } },
        { type: "user", uuid: "receipt", message: { content: [{ type: "tool_result", tool_use_id: "send", content: "File sent" }] },
          toolUseResult: { attachments: [{ path: "sent.txt", size: 1, isImage: false }] } },
      ], hasMore: false });
      let markPathStarted!: () => void;
      const pathStarted = new Promise<void>(resolve => { markPathStarted = resolve; });
      vi.mocked(realpath).mockImplementationOnce(async path => {
        expect(path).toBe(worktree);
        markPathStarted();
        await pathGate;
        return worktree;
      });
      const history = f.bridge.history("local-native", "older");
      await pathStarted;

      f.native.sessions.unshift({ ...f.native.sessions[0]!, sessionId: "other-native", pendingViolinBowPrompt: { promptId: "other-prompt" } });
      let markRefreshPaused!: () => void;
      const refreshPaused = new Promise<void>(resolve => { markRefreshPaused = resolve; });
      vi.spyOn(f.native, "promptChoices").mockImplementationOnce(async () => {
        markRefreshPaused();
        await refreshGate;
        return undefined;
      });
      const refresh = f.bridge.refreshRuntime();
      await refreshPaused;
      expect(f.bridge.executionCwd("other-native")).toBe(worktree);
      expect(f.bridge.executionCwd("local-native")).toBeUndefined();
      releasePath();
      try {
        await expect(history).resolves.toMatchObject({
          items: [{ id: "plain", text: "Ordinary history" }],
          sessionFileReceipts: { send: [{ name: "sent.txt", path: join(worktree, "sent.txt") }] },
        });
      } finally {
        releaseRefresh();
        await refresh;
      }
    } finally {
      releasePath();
      releaseRefresh();
      vi.mocked(realpath).mockReset();
      await f.close();
    }
  });

  it("returns ordinary history without reading the full transcript for a split file receipt", async () => {
    const f = await fixture();
    try {
      const recent = { type: "assistant", uuid: "plain-message", timestamp: 20, message: { content: [{ type: "text", text: "Ordinary history" }] } };
      const receipt = { type: "user", uuid: "send-file-receipt", timestamp: 30, message: { content: [{
        type: "tool_result", tool_use_id: "older-send-file", content: "File sent",
      }] }, tool_use_result: { attachments: [{ path: "uploaded.txt", size: 1, isImage: false, file_uuid: "upload-id" }] } };
      f.native.pages.set("", { messages: [recent, receipt], hasMore: true });
      const original = f.native.call.bind(f.native);
      vi.spyOn(f.native, "call").mockImplementation((method, args) => method === "getTranscript"
        ? Promise.reject(new NativeCallError("Full transcript unavailable")) : original(method, args));
      expect(await f.bridge.history("local-native", undefined, 2)).toMatchObject({
        items: [{ id: recent.uuid, text: "Ordinary history" }], hasMore: true, nextCursor: recent.uuid,
        sessionFileReceipts: { "older-send-file": [{ name: "uploaded.txt" }] },
      });
    } finally { await f.close(); }
  });

  it.each(["absolute-project", "absolute-worktree", "parent-relative"])("archives native %s tool paths without rebasing them onto the wrong directory", async pathKind => {
    const upsertDesktopEvidence = vi.fn();
    const f = await fixture(false, { upsertDesktopEvidence });
    const directory = join(f.options.settingsPath, "..");
    const store = new EvidenceStore({ databasePath: join(directory, "path-files.sqlite"), blobsPath: join(directory, "path-blobs"), masterSecret: Buffer.alloc(32, 4).toString("base64url") });
    const evidence = new EvidenceManager({ store, eventLog: f.eventLog });
    await evidence.initialize();
    upsertDesktopEvidence.mockImplementation(input => evidence.upsertDesktopEvidence(input));
    try {
      const project = join(directory, "repo");
      const harnessCwd = join(project, ".claude/worktrees/task");
      await mkdir(join(project, "artifacts"), { recursive: true });
      await mkdir(join(harnessCwd, "artifacts"), { recursive: true });
      await writeFile(join(project, "artifacts/结果 report.txt"), "project artifact");
      await writeFile(join(harnessCwd, "artifacts/结果 report.txt"), "worktree artifact");
      Object.assign(f.native.sessions[0]!, { cwd: project, harnessCwd });
      await f.bridge.refreshRuntime();
      const path = pathKind === "absolute-project" ? join(project, "artifacts/结果 report.txt")
        : pathKind === "absolute-worktree" ? join(harnessCwd, "artifacts/结果 report.txt") : "../../../artifacts/结果 report.txt";
      await f.message(planMessage("read-call", { file_path: path }, 10, "Read"));
      await f.message({ type: "user", uuid: "read-result", message: { content: [{ type: "tool_result", tool_use_id: "read-call", content: "Read complete" }] } });
      expect(upsertDesktopEvidence).toHaveBeenCalledTimes(1);
      const artifact = store.get("native:local-native:read-call")!.artifacts[0]!;
      expect(artifact.relativePath).toBe(`${pathKind === "absolute-worktree" ? ".claude/worktrees/task/" : ""}artifacts/结果 report.txt`);
      expect(store.artifact(artifact.id)?.rootPath).toBe(project);
      const transfer = await evidence.openTransfer(artifact.id, "phone");
      expect(Buffer.from(evidence.readTransfer(transfer.transferId, 0, "phone").data, "base64").toString())
        .toBe(pathKind === "absolute-worktree" ? "worktree artifact" : "project artifact");
      expect(f.bridge.session("local-native")?.cwd).toBe(project);
      expect(f.bridge.executionCwd("local-native")).toBe(harnessCwd);
    } finally { await evidence.close(); await f.close(); }
  });
});
