import { once } from "node:events";
import { appendFile, rm, mkdir, mkdtemp, readFile, readdir, realpath, symlink, truncate, writeFile } from "node:fs/promises";
import * as platform from "../app/platform.js";
import { ARTIFACT_MAX_BYTES, BridgeCrypto, isEncryptedEnvelope, type BridgeArtifactTransferInfo } from "@bridge/protocol";
import { EvidenceManager } from "../evidence/evidence-manager.js";
import { EvidenceStore } from "../evidence/evidence-store.js";
import { createControllerFixture } from "../controller/controller-fixture.js";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ClaudeDesktopBridge, DEFAULT_CONFIGURATION_SESSION_ID, nativeHistoryItems } from "./claude-desktop-bridge.js";
import { InspectorDisconnectedError, NativeCallError } from "./claude-desktop-inspector.js";
import { ConversationStateStore } from "../controller/conversation-state-store.js";
import { SessionEventLog } from "../controller/session-event-log.js";
import { magpieModelIdHash } from "./claude-runtime-discovery.js";
import { MagpieConnectionRepository } from "./magpie-connection.js";
import { fixture, NativeDesktop, withDatabase, turnInput as input } from "./claude-desktop-bridge-fixture.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, readFile: vi.fn(fs.readFile), realpath: vi.fn(fs.realpath) };
});

it("observes the main Native system/init tool directory with the Desktop session ID", async () => {
  const f = await fixture();
  try {
    const observed = vi.fn();
    f.bridge.on("system.init", observed);
    await f.message({ type: "system", subtype: "init", session_id: "cli-id", parent_tool_use_id: "agent", tools: ["Bash"] });
    await f.message({ type: "system", subtype: "init", session_id: "cli-id", tools: ["Read", null, "mcp__other__read"] });
    expect(observed).toHaveBeenCalledExactlyOnceWith("local-native", ["Read", "mcp__other__read"]);
  } finally { await f.close(); }
});

it.each(["assistant", "system"])("coalesces same-turn %s event projections without dropping messages", async (type) => {
  const f = await fixture();
  try {
    for (let index = 1; index < 348; index++) f.native.sessions.push({ ...f.native.sessions[0], sessionId: `other-${index}` });
    await f.bridge.refreshRuntime();
    const project = vi.spyOn(f.bridge as unknown as { projectSessions(): void }, "projectSessions");
    for (let index = 0; index < 32; index++) {
      f.native.emit("event", {
        type: "message", sessionId: "local-native",
        session: { ...f.native.sessions[0], title: `burst-${index}` },
        message: type === "assistant"
          ? { type, uuid: `message-${index}`, message: { content: [{ type: "text", text: `Message ${index}` }] } }
          : { type, uuid: `message-${index}`, subtype: "compact_boundary" },
      });
    }
    await vi.waitFor(() => {
      expect(f.bridge.session("local-native")?.title).toBe("burst-31");
      expect(f.eventLog.replay(0, 100).filter(event => event.type === (type === "assistant" ? "assistant.completed" : "session.compacted"))).toHaveLength(32);
    });
    expect(f.bridge.listSessions()).toHaveLength(348);
    expect(project).toHaveBeenCalledTimes(1);
  } finally { await f.close(); }
});

describe("Claude native relay", () => {
  it("projects the user's replan feedback without the internal Native prompt in event and history", async () => {
    const f = await fixture();
    try {
      const text = "Internal proposal instructions\n\nMove the review to Friday";
      const displayText = "Move the review to Friday";
      const receipt = await f.bridge.startTurn({ ...input, text, displayText });
      expect(f.native.calls.find(call => call.method === "sendMessage")?.args[1]).toBe(text);
      const message = { type: "user", uuid: receipt.messageId, message: { content: text } };
      f.native.page.messages = [message];
      await f.message(message);
      expect((await f.bridge.history(input.sessionId)).items).toEqual([expect.objectContaining({ id: receipt.messageId, text: displayText })]);
      const replay = f.eventLog.replay(0);
      expect(replay).toContainEqual(expect.objectContaining({ type: "user.message.accepted", data: expect.objectContaining({ text: displayText }) }));
      expect(JSON.stringify(replay)).not.toContain("Internal proposal instructions");
      expect(f.state.nativeDesktopReceipt(input.idempotencyKey)?.displayText).toBe(displayText);
    } finally { await f.close(); }
  });

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

  it("uses only saved model IDs and labels in order, and round-trips the full selected ID", async () => {
    const f = await fixture();
    try {
      const options = Array.from({ length: 24 }, (_, index) => ({ model: index === 3 ? "native-model" : `model-${index}[1m]`, label: `Saved label ${index}`, description: `private-account-${index}` }));
      await writeFile(f.options.settingsPath, JSON.stringify({ env: { PRIVATE_ACCOUNT: "fixture-private-account-value" }, modelPicker: { options } }));
      await f.bridge.refreshRuntime();
      const config = await f.bridge.configuration("local-native");
      expect(config).toMatchObject({ model: "native-model", modelDisplayName: "Saved label 3", modelsComplete: true, availableModels: options.map(option => ({ value: option.model, displayName: option.label })) });
      expect(f.bridge.session("local-native")?.modelDisplayName).toBe("Saved label 3");
      const selected = await f.bridge.configureSession({ sessionId: "local-native", model: options[10]!.model });
      expect(f.native.calls.find(call => call.method === "setModel")?.args).toEqual(["local-native", "model-10[1m]"]);
      expect(selected).toMatchObject({ model: "model-10[1m]", modelDisplayName: "Saved label 10" });
      const exposed = JSON.stringify({ config, selected, sessions: f.bridge.listSessions(), events: f.eventLog.replay(0) });
      expect(exposed).not.toContain("private-account");
      expect(exposed).not.toContain("fixture-private-account-value");
      expect(exposed).not.toContain("PRIVATE_ACCOUNT");
      expect(exposed).not.toContain("description");
      expect(f.native.availableCodeModels).toHaveBeenCalledExactlyOnceWith();
      expect(f.native.calls.some(call => call.method === "getAvailableCodeModels")).toBe(false);
    } finally { await f.close(); }
  });

  it.each([
    ["mythos-magpie-", ""],
    ["mythos-magpie-", "[1m]"],
    ["magpie-", ".anthropic.claude-opus-5-5[1m]"],
  ])("resolves the saved header label and picker selection for %s%s", async (prefix, suffix) => {
    const f = await fixture();
    try {
      const baseModel = "fixture-provider/model-alpha";
      const alias = `${prefix}${magpieModelIdHash(baseModel)}${suffix}`;
      const options = [
        { model: `${baseModel}[1m]`, label: "Saved long-context model" },
        { model: baseModel, label: "Saved standard model" },
      ];
      const selected = options[suffix.includes("[1m]") ? 0 : 1]!;
      f.native.sessions[0]!.model = alias;
      await writeFile(f.options.settingsPath, JSON.stringify({ modelPicker: { options } }));
      await f.bridge.refreshRuntime();
      expect(f.bridge.session("local-native")).toMatchObject({ model: alias, modelDisplayName: selected.label });
      expect(await f.bridge.configuration("local-native")).toMatchObject({
        model: selected.model, modelDisplayName: selected.label,
        availableModels: options.map(option => ({ value: option.model, displayName: option.label })),
      });
      await f.bridge.refreshRuntime();
      expect(f.bridge.session("local-native")?.modelDisplayName).toBe(selected.label);
      await f.bridge.configureSession({ sessionId: "local-native", model: selected.model });
      expect(f.native.calls.find(call => call.method === "setModel")?.args).toEqual(["local-native", selected.model]);
    } finally { await f.close(); }
  });

  it.each(["", "[1m]"])("maps a canonical model to the exact native directory alias for an empty session and first send (%s)", async suffix => {
    const f = await fixture();
    try {
      const base = "fixture-provider/model-alpha";
      const canonical = `${base}${suffix}`;
      const alias = `mythos-magpie-${magpieModelIdHash(base)}${suffix ? ".anthropic.claude-opus-5-5[1m]" : ""}`;
      f.native.unsupported.add("getAvailableCodeModels");
      f.native.codeModels = [`mythos-magpie-${magpieModelIdHash(base)}${suffix ? "" : "[1m]"}`, alias];
      await writeFile(f.options.settingsPath, JSON.stringify({ modelPicker: { options: [{ model: canonical, label: "Selected saved model" }] } }));
      const session = await f.bridge.createSession("/new-project");
      expect(session.model).toBe(canonical);
      expect(f.native.sessions.find(entry => entry.sessionId === session.sessionId)?.model).toBeUndefined();
      const configured = await f.bridge.configureSession({ sessionId: session.sessionId, model: canonical });
      expect(f.native.availableCodeModels).toHaveBeenCalledExactlyOnceWith();
      expect(f.native.calls.some(call => call.method === "getAvailableCodeModels")).toBe(false);
      expect(f.native.calls.find(call => call.method === "setModel")?.args).toEqual([session.sessionId, alias]);
      expect(configured).toMatchObject({ model: canonical, modelDisplayName: "Selected saved model" });
      await f.bridge.startTurn({ ...input, sessionId: session.sessionId });
      expect(f.native.sentModels).toEqual([alias]);
      expect(f.bridge.session(session.sessionId)).toMatchObject({ model: alias, modelDisplayName: "Selected saved model" });
    } finally { await f.close(); }
  });

  it("prefers the exact canonical ID when the native directory includes both representations", async () => {
    const f = await fixture();
    try {
      const model = "fixture-provider/model-alpha[1m]";
      f.native.codeModels = [`mythos-magpie-${magpieModelIdHash("fixture-provider/model-alpha")}[1m]`, model];
      await writeFile(f.options.settingsPath, JSON.stringify({ modelPicker: { options: [{ model, label: "Canonical" }] } }));
      expect(await f.bridge.configureSession({ sessionId: "local-native", model })).toMatchObject({ model });
      expect(f.native.calls.find(call => call.method === "setModel")?.args).toEqual(["local-native", model]);
    } finally { await f.close(); }
  });

  it.each(["canonical", "synthetic"])("preserves the selected context suffix when the native bootstrap lists only the %s base ID", async kind => {
    const f = await fixture();
    try {
      const base = "fixture-provider/model-alpha";
      const model = `${base}[1m]`;
      const nativeBase = kind === "synthetic" ? `mythos-magpie-${magpieModelIdHash(base)}` : base;
      f.native.unsupported.add("getAvailableCodeModels");
      f.native.codeModels = [nativeBase];
      await writeFile(f.options.settingsPath, JSON.stringify({ modelPicker: { options: [{ model, label: "Long context" }] } }));
      const session = await f.bridge.createSession("/new-project");
      expect(await f.bridge.configureSession({ sessionId: session.sessionId, model })).toMatchObject({ model, modelDisplayName: "Long context" });
      expect(f.native.calls.find(call => call.method === "setModel")?.args).toEqual([session.sessionId, `${nativeBase}[1m]`]);
      await f.bridge.startTurn({ ...input, sessionId: session.sessionId });
      expect(f.native.sentModels).toEqual([`${nativeBase}[1m]`]);
    } finally { await f.close(); }
  });

  it("keeps native empty-directory semantics and verifies direct canonical selection", async () => {
    const f = await fixture();
    try {
      f.native.codeModels = [];
      expect(await f.bridge.configureSession({ sessionId: "local-native", model: "fixture-provider/model-alpha" })).toMatchObject({ model: "fixture-provider/model-alpha" });
      expect(f.native.calls.find(call => call.method === "setModel")?.args).toEqual(["local-native", "fixture-provider/model-alpha"]);
    } finally { await f.close(); }
  });

  it("reports Native preferred 1M normalization as the actual Gemini selection", async () => {
    const f = await fixture();
    try {
      const model = ["antigravity", "gemini-4-argon"].join("/");
      expect(magpieModelIdHash(model)).toBe("1052229916");
      const alias = `mythos-magpie-${magpieModelIdHash(model)}`;
      f.native.codeModels = [alias];
      // Installed Desktop's modelIdForCli can add [1m] before validation.
      f.native.normalizeModel = value => value === alias ? `${alias}[1m]` : value;
      await writeFile(f.options.settingsPath, JSON.stringify({ modelPicker: { options: [{ model, label: "Gemini 4 Argon · Antigravity" }] } }));
      const selected = await f.bridge.configureSession({ sessionId: "local-native", model });
      expect(f.native.calls.find(call => call.method === "setModel")?.args).toEqual(["local-native", alias]);
      expect(selected).toMatchObject({ model: `${model}[1m]`, modelDisplayName: "Gemini 4 Argon · Antigravity · 1M" });
      expect(selected.availableModels).toContainEqual({ value: `${model}[1m]`, displayName: "Gemini 4 Argon · Antigravity · 1M" });
      expect(f.bridge.session("local-native")).toMatchObject({ model: `${alias}[1m]`, modelDisplayName: selected.modelDisplayName });
      expect((await f.bridge.configuration("local-native")).model).toBe(`${model}[1m]`);
    } finally { await f.close(); }
  });

  it.each(["canonical", "synthetic"])("keeps the only registered %s 1M target when the saved picker has a base model", async kind => {
    const f = await fixture();
    try {
      const model = "fixture-provider/model-alpha";
      const target = `${kind === "synthetic" ? `mythos-magpie-${magpieModelIdHash(model)}` : model}[1m]`;
      f.native.codeModels = [target];
      await writeFile(f.options.settingsPath, JSON.stringify({ modelPicker: { options: [{ model, label: "Selected model" }] } }));
      expect(await f.bridge.configureSession({ sessionId: "local-native", model })).toMatchObject({ model: `${model}[1m]`, modelDisplayName: "Selected model · 1M" });
      expect(f.native.calls.find(call => call.method === "setModel")?.args).toEqual(["local-native", target]);
    } finally { await f.close(); }
  });

  it("does not accept a Native context downgrade or a different normalized model", async () => {
    const f = await fixture();
    try {
      const model = "fixture-provider/model-alpha";
      const alias = `mythos-magpie-${magpieModelIdHash(model)}`;
      const other = "fixture-provider/model-beta";
      f.native.codeModels = [alias, `${alias}[1m]`];
      await writeFile(f.options.settingsPath, JSON.stringify({ modelPicker: { options: [
        { model, label: "Standard" }, { model: `${model}[1m]`, label: "Long context" }, { model: `${other}[1m]`, label: "Other model" },
      ] } }));
      f.native.normalizeModel = () => `${alias}[1m]`;
      await expect(f.bridge.configureSession({ sessionId: "local-native", model })).rejects.toThrow(/did not apply/iu);
      f.native.normalizeModel = () => alias;
      await expect(f.bridge.configureSession({ sessionId: "local-native", model: `${model}[1m]` })).rejects.toThrow(/did not apply/iu);
      f.native.normalizeModel = () => `mythos-magpie-${magpieModelIdHash(other)}[1m]`;
      await expect(f.bridge.configureSession({ sessionId: "local-native", model })).rejects.toThrow(/did not apply/iu);
    } finally { await f.close(); }
  });

  it("surfaces native model readback mismatch instead of claiming selection succeeded", async () => {
    const f = await fixture();
    try {
      f.native.codeModels = ["fixture-provider/model-alpha"];
      f.native.applyModel = false;
      await expect(f.bridge.configureSession({ sessionId: "local-native", model: "fixture-provider/model-alpha" })).rejects.toThrow(/model.*not applied|did not apply.*model/iu);
    } finally { await f.close(); }
  });

  it("does not invent a native alias when the directory has no matching model", async () => {
    const f = await fixture();
    try {
      f.native.codeModels = ["mythos-magpie-0000000000"];
      await expect(f.bridge.configureSession({ sessionId: "local-native", model: "fixture-provider/model-alpha" })).rejects.toThrow(/model/iu);
      expect(f.native.calls.some(call => call.method === "setModel")).toBe(false);
    } finally { await f.close(); }
  });

  it("prefers an explicitly saved alias label over a derived model label", async () => {
    const f = await fixture();
    try {
      const baseModel = "fixture-provider/model-alpha";
      const alias = `mythos-magpie-${magpieModelIdHash(baseModel)}`;
      f.native.sessions[0]!.model = alias;
      await writeFile(f.options.settingsPath, JSON.stringify({ modelPicker: { options: [
        { model: baseModel, label: "Derived model label" },
        { model: alias, label: "Explicit alias label" },
      ] } }));
      await f.bridge.refreshRuntime();
      expect(f.bridge.session("local-native")?.modelDisplayName).toBe("Explicit alias label");
      expect(await f.bridge.configuration("local-native")).toMatchObject({ model: alias, modelDisplayName: "Explicit alias label" });
    } finally { await f.close(); }
  });

  it("does not label an unknown native alias as an unrelated saved model or expose raw synthetic hashes", async () => {
    const f = await fixture();
    try {
      const alias = "mythos-magpie-0000000000";
      f.native.sessions[0]!.model = alias;
      await writeFile(f.options.settingsPath, JSON.stringify({ modelPicker: { options: [
        { model: "fixture-provider/model-alpha", label: "Unrelated model" },
      ] } }));
      await f.bridge.refreshRuntime();
      expect(f.bridge.session("local-native")?.modelDisplayName).toBeUndefined();
      const config = await f.bridge.configuration("local-native");
      expect(config.model).toBe(alias);
      expect(config.modelDisplayName).toBeUndefined();
    } finally { await f.close(); }
  });

  it("marks a missing model directory incomplete without treating history models as a catalog", async () => {
    const f = await fixture();
    try {
      f.native.sessions.push({ ...f.native.sessions[0], sessionId: "other", model: "historical-model" });
      await f.bridge.refreshRuntime();
      expect(await f.bridge.configuration("local-native")).toMatchObject({ model: "native-model", modelsComplete: false, availableModels: [{ value: "native-model", displayName: "native-model" }] });
    } finally { await f.close(); }
  });

  it("resolves host defaultConfiguration() from the most recent active session or catalog defaults when zero sessions exist", async () => {
    const f = await fixture();
    try {
      // Zero sessions and no model catalog yet.
      f.native.sessions = [];
      await f.bridge.refreshRuntime();
      const emptyUncatalogued = await f.bridge.defaultConfiguration();
      expect(emptyUncatalogued).toEqual({
        sessionId: DEFAULT_CONFIGURATION_SESSION_ID,
        effort: "high",
        nativePermissionMode: "default",
        modelSource: "claude-desktop",
        effortSource: "claude-desktop",
        availableModels: [],
        availableEffortLevels: ["low", "medium", "high", "xhigh", "max"],
        modelsComplete: false,
        appliesAfterTurn: false,
      });

      // Zero sessions with saved modelPicker catalog.
      const primaryModel = "fixture-provider/model-primary";
      const secondaryModel = "fixture-provider/model-secondary[1m]";
      await writeFile(f.options.settingsPath, JSON.stringify({
        modelPicker: {
          options: [
            { model: primaryModel, label: "Primary Saved Model" },
            { model: secondaryModel, label: "Secondary Long Context" },
          ],
        },
      }));
      const emptyCatalogued = await f.bridge.defaultConfiguration();
      expect(emptyCatalogued).toEqual({
        sessionId: DEFAULT_CONFIGURATION_SESSION_ID,
        model: primaryModel,
        modelDisplayName: "Primary Saved Model",
        effort: "high",
        nativePermissionMode: "default",
        modelSource: "claude-desktop",
        effortSource: "claude-desktop",
        availableModels: [
          { value: primaryModel, displayName: "Primary Saved Model" },
          { value: secondaryModel, displayName: "Secondary Long Context" },
        ],
        availableEffortLevels: ["low", "medium", "high", "xhigh", "max"],
        modelsComplete: true,
        appliesAfterTurn: false,
      });

      // Active and archived sessions exist: picks most recent non-archived session and keeps appliesAfterTurn=false.
      const secondaryAlias = `mythos-magpie-${magpieModelIdHash("fixture-provider/model-secondary")}[1m]`;
      f.native.sessions = [
        { sessionId: "older-active", cwd: "/project", model: primaryModel, effort: "low", permissionMode: "default", lastActivityAt: 100, turnRunning: false },
        { sessionId: "recent-active", cwd: "/project", model: secondaryAlias, effort: "max", permissionMode: "acceptEdits", lastActivityAt: 500, turnRunning: true },
        { sessionId: "newest-archived", cwd: "/project", model: primaryModel, effort: "medium", permissionMode: "plan", lastActivityAt: 900, isArchived: true, turnRunning: false },
      ];
      await f.bridge.refreshRuntime();
      expect(await f.bridge.defaultConfiguration()).toEqual({
        sessionId: DEFAULT_CONFIGURATION_SESSION_ID,
        model: secondaryModel,
        modelDisplayName: "Secondary Long Context",
        effort: "max",
        nativePermissionMode: "acceptEdits",
        modelSource: "claude-desktop",
        effortSource: "claude-desktop",
        availableModels: [
          { value: primaryModel, displayName: "Primary Saved Model" },
          { value: secondaryModel, displayName: "Secondary Long Context" },
        ],
        availableEffortLevels: ["low", "medium", "high", "xhigh", "max"],
        modelsComplete: true,
        appliesAfterTurn: false,
      });
    } finally { await f.close(); }
  });

  it("resolves real session models for retired Magpie synthetic hashes, [1m]-only picker entries, and unset/default native models", async () => {
    const f = await fixture();
    try {
      const autoOpus1m = "auto/claude-opus-5-5[1m]";
      const claudeOpus1m = "claude/claude-opus-5-5[1m]";
      const retiredGeminiAlias = `mythos-magpie-${magpieModelIdHash("antigravity/gemini-4-argon")}[1m]`;
      const retiredRouteAlias = "mythos-magpie-5277472942";
      const standardOpusAlias = `mythos-magpie-${magpieModelIdHash("auto/claude-opus-5-5")}`;

      await writeFile(f.options.settingsPath, JSON.stringify({
        model: claudeOpus1m,
        modelPicker: {
          options: [
            { model: autoOpus1m, label: "Claude Opus 5.5 · routing group · 1M" },
            { model: claudeOpus1m, label: "Claude Opus 5.5 · Claude" },
          ],
        },
      }));

      f.native.sessions = [
        { sessionId: "retired-gemini", cwd: "/project", model: retiredGeminiAlias, turnRunning: false, lastActivityAt: 400 },
        { sessionId: "retired-route-opus", cwd: "/project", model: retiredRouteAlias, turnRunning: false, lastActivityAt: 300 },
        { sessionId: "standard-opus", cwd: "/project", model: standardOpusAlias, turnRunning: false, lastActivityAt: 200 },
        { sessionId: "unset-with-turns", cwd: "/project", model: "default", turnRunning: false, lastActivityAt: 150 },
        { sessionId: "unset-empty", cwd: "/project", model: undefined, turnRunning: false, lastActivityAt: 100 },
      ];
      await f.bridge.refreshRuntime();

      // 1. Non-[1m] synthetic hash matches [1m]-only saved picker option and strips trailing " · 1M".
      expect(f.bridge.session("standard-opus")).toMatchObject({
        model: standardOpusAlias,
        modelDisplayName: "Claude Opus 5.5 · routing group",
      });
      expect(await f.bridge.configuration("standard-opus")).toMatchObject({
        model: "auto/claude-opus-5-5",
        modelDisplayName: "Claude Opus 5.5 · routing group",
      });

      // 2. Unset native.model with no turns falls back to settings.json default model instead of undefined / "默认模型".
      expect(f.bridge.session("unset-empty")).toMatchObject({
        model: claudeOpus1m,
        modelDisplayName: "Claude Opus 5.5 · Claude",
      });
      expect(await f.bridge.configuration("unset-empty")).toMatchObject({
        model: claudeOpus1m,
        modelDisplayName: "Claude Opus 5.5 · Claude",
      });

      // 3. Retired opaque synthetic hash [1m] hydrates actual upstream model from transcript tail on configuration().
      f.native.page = {
        messages: [{
          type: "assistant",
          uuid: "msg-gemini",
          message: { id: "msg-gemini", model: "antigravity/gemini-4-argon", usage: { input_tokens: 1_200, output_tokens: 80 } },
        }],
        hasMore: false,
      };
      const geminiConfig = await f.bridge.configuration("retired-gemini");
      expect(geminiConfig).toMatchObject({
        model: retiredGeminiAlias,
        modelDisplayName: "Gemini 4 Argon · 1M",
      });
      expect(f.bridge.session("retired-gemini")).toMatchObject({
        model: retiredGeminiAlias,
        modelDisplayName: "Gemini 4 Argon · 1M",
      });

      // 4. Retired opaque synthetic hash whose transcript model matches a saved Anthropic slug resolves saved label
      // even when the assistant message carries no token usage block.
      f.native.page = {
        messages: [
          { type: "assistant", uuid: "sidechain-ignored", isSidechain: true, message: { id: "side", model: "openai/gpt-5-4" } },
          { type: "assistant", uuid: "msg-opus", message: { id: "msg-opus", model: "claude/claude-opus-5-5" } },
        ],
        hasMore: false,
      };
      const opusConfig = await f.bridge.configuration("retired-route-opus");
      expect(opusConfig).toMatchObject({
        model: "claude/claude-opus-5-5",
        modelDisplayName: "Claude Opus 5.5 · Claude",
      });
      expect(f.bridge.session("retired-route-opus")).toMatchObject({
        model: retiredRouteAlias,
        modelDisplayName: "Claude Opus 5.5 · Claude",
      });

      // 5. Session with native.model === "default" migrates model-less live rawMaxTokens when tail hydration discovers the model.
      f.native.sessions.find(s => s.sessionId === "unset-with-turns")!.turnRunning = true;
      f.native.contextUsage = { totalTokens: 98_000, rawMaxTokens: 196_000 };
      f.native.page = {
        messages: [{
          type: "assistant",
          uuid: "msg-sonnet",
          message: { id: "msg-sonnet", model: "claude-sonnet-4-5" },
        }],
        hasMore: false,
      };
      const hydratedDefaultConfig = await f.bridge.configuration("unset-with-turns");
      expect(hydratedDefaultConfig).toMatchObject({
        model: "claude-sonnet-4-5",
        modelDisplayName: "Claude Sonnet 4.5",
        context: { totalTokens: 98_000, maxTokens: 196_000, percentage: 50, estimated: false },
      });
      expect(f.bridge.session("unset-with-turns")).toMatchObject({
        model: "claude-sonnet-4-5",
        modelDisplayName: "Claude Sonnet 4.5",
      });

      // 6. configureSession rejects unapplied setModel both on unset/default sessions and on retired-hash sessions
      // whose transcript history already matches the requested saved model.
      f.native.codeModels = [claudeOpus1m, "claude/claude-opus-5-5"];
      f.native.applyModel = false;
      await expect(f.bridge.configureSession({ sessionId: "unset-empty", model: claudeOpus1m }))
        .rejects.toThrow(/did not apply/iu);
      await expect(f.bridge.configureSession({ sessionId: "retired-route-opus", model: "claude/claude-opus-5-5" }))
        .rejects.toThrow(/did not apply/iu);
    } finally { await f.close(); }
  });

  it.each([[4, 32], [16, 32], [16, 128]])("projects %i sessions with at most one pass over %i receipts", async (sessionCount, receiptCount) => {
    const f = await fixture();
    const native = new NativeDesktop();
    const bridge = new ClaudeDesktopBridge({ ...f.options, inspector: native });
    try {
      native.sessions = Array.from({ length: sessionCount }, (_, index) => ({ ...native.sessions[0], sessionId: `local-${index}` }));
      for (let index = 0; index < receiptCount; index++) {
        f.state.saveNativeDesktopReceipt({
          idempotencyKey: `key-${index}`, commandId: `command-${index}`, requestId: `request-${index}`, messageId: `message-${index}`,
          sessionId: index === 3 ? "local-hidden" : `local-${index % 2}`,
          state: index < 4 ? "queued" : index === 4 ? "dispatching" : "completed",
        });
      }
      let reads = 0;
      const receipts = f.state.listNativeDesktopReceipts().map(receipt => new Proxy(receipt, {
        get(target, key, receiver) {
          if (key === "sessionId" || key === "state") reads++;
          return Reflect.get(target, key, receiver);
        },
      }));
      vi.spyOn(f.state, "listNativeDesktopReceipts").mockReturnValue(receipts);
      await bridge.initialize();
      expect(f.state.nativeDesktopReceipt("key-4")?.state).toBe("uncertain");
      reads = 0;
      expect(await bridge.refreshRuntime()).toBe(true);
      expect(bridge.listSessions()).toHaveLength(sessionCount);
      expect(bridge.session("local-0")).toMatchObject({ pendingCount: 2, pendingCommandIds: ["command-0", "command-2"] });
      expect(bridge.session("local-1")).toMatchObject({ pendingCount: 1, pendingCommandIds: ["command-1"] });
      expect(bridge.session("local-2")).toMatchObject({ pendingCount: 0, pendingCommandIds: [] });
      // Each receipt needs at most its state and session ID, independent of session count.
      expect(reads).toBeLessThanOrEqual(2 * receiptCount);
    } finally { await bridge.close(); await f.close(); }
  });

  it("announces only user replies and explicit deliveries from background turns", async () => {
    const f = await fixture();
    const received = vi.fn();
    f.bridge.on("assistant.user-reply", received);
    try {
      for (const [index, text] of ["筛选完毕", "【给用户】请查看预算"].entries()) {
        const receipt = await f.bridge.startTurn({ ...input, requestId: `background-${index}`, idempotencyKey: `background-${index}`, origin: "system", source: "assistant-trigger" });
        await f.message({ type: "user", uuid: receipt.messageId, message: { content: input.text } });
        await f.message({ type: "assistant", uuid: `background-reply-${index}`, message: { content: [{ type: "text", text }] } });
        await f.message({ type: "result", uuid: `background-result-${index}`, user_message_uuid: receipt.messageId, is_error: false });
      }
      await f.message({ type: "user", uuid: "user-root", message: { content: "请给我结果" } });
      await f.message({ type: "assistant", uuid: "native-reply", message: { id: "visible-reply", content: [{ type: "text", text: "用户请求的结果" }] } });
      await f.message({ type: "result", uuid: "result", is_error: false });
      expect(received.mock.calls).toEqual([
        [input.sessionId, "background-reply-1", "请查看预算"],
        [input.sessionId, "visible-reply", "用户请求的结果"],
      ]);
    } finally { await f.close(); }
  });

  it("does not mark failed, synthetic, or child results as completed", async () => {
    const f = await fixture();
    try {
      for (const outcome of [{ is_error: true }, { is_error: false, isSyntheticResult: true }, { is_error: false, parent_tool_use_id: "child" }]) {
        await f.message({ type: "result", uuid: "excluded-result", ...outcome });
        expect(f.bridge.session("local-native")?.lastCompletedTurnId).toBeUndefined();
      }
    } finally { await f.close(); }
  });

  it("uses the same assistant item ID for delta and completion without requiring a turn ID", async () => {
    const f = await fixture();
    try {
      await f.message({ type: "stream_event", event: { type: "message_start", message: { id: "assistant-api-id" } } });
      await f.message({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "partial" } } });
      await f.message({ type: "assistant", uuid: "transcript-row", message: { id: "assistant-api-id", content: [{ type: "text", text: "final" }] } });
      await f.eventLog.flushDeltas("local-native");
      const events = f.eventLog.replay(0).filter(event => event.type.startsWith("assistant."));
      expect(events.map(event => [event.type, event.itemId, event.turnId])).toEqual([["assistant.delta", "assistant-api-id", undefined], ["assistant.completed", "assistant-api-id", undefined]]);
    } finally { await f.close(); }
  });

  it("keeps sidechain streams and tool results out of the parent event log", async () => {
    const f = await fixture();
    try {
      await f.message({ type: "stream_event", event: { type: "message_start", message: { id: "parent-assistant" } } });
      await f.message({ type: "stream_event", isSidechain: true, parent_tool_use_id: null, event: { type: "message_start", message: { id: "child-assistant" } } });
      await f.message({ type: "stream_event", isSidechain: true, parent_tool_use_id: null, event: { type: "content_block_delta", delta: { type: "text_delta", text: "Child progress" } } });
      await f.message({ type: "user", isSidechain: true, parent_tool_use_id: null, uuid: "child-result", message: { content: [{ type: "tool_result", tool_use_id: "child-wrap", content: "Child finished" }] } });
      await f.message({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Parent progress" } } });
      await f.eventLog.flushDeltas("local-native");
      expect(f.eventLog.replay(0).map(event => ({ type: event.type, itemId: event.itemId, data: event.data }))).toEqual([
        { type: "assistant.delta", itemId: "parent-assistant", data: { text: "Parent progress" } },
      ]);
    } finally { await f.close(); }
  });

  it("reads only native Desktop records and leaves old queues untouched", async () => {
    const f = await fixture(true);
    try {
      expect(f.bridge.session("local-native")?.transport).toBe("claude-desktop-native");
      expect(f.bridge.session("legacy-unlinked")).toBeUndefined();
      const queued = withDatabase(f.databasePath, (db) => db.prepare("SELECT command_id FROM turn_queue").all() as Array<{ command_id: string }>);
      expect(queued[0]?.command_id).toBe("old-command");
      expect(f.native.calls.some(call => call.method === "sendMessage")).toBe(false);
      expect(f.bridge.session("local-native")?.turnState).toBe("idle"); // A warm CLI is not an active turn.
    } finally { await f.close(); }
  });

  it("creates an empty native session without starting a turn", async () => {
    const f = await fixture();
    try {
      const session = await f.bridge.createSession("/new-project", "New");
      expect(session.transport).toBe("claude-desktop-native");
      expect(f.native.calls.find(call => call.method === "start")?.args[0]).toMatchObject({ withoutFirstMessage: true, message: "" });
      expect(f.native.calls.some(call => call.method === "sendMessage")).toBe(false);
    } finally { await f.close(); }
  });

  it("deletes the native session and refreshes the Desktop list", async () => {
    const f = await fixture();
    try {
      await f.bridge.deleteSession("local-native");
      expect(f.native.calls.filter(call => call.method === "delete")).toEqual([{ method: "delete", args: ["local-native"] }]);
      expect(f.native.calls.some(call => call.method === "archive")).toBe(false);
      expect(f.bridge.listSessions()).toEqual([]);
    } finally { await f.close(); }
  });

  it.each([
    { isCompactSummary: true },
    { isMeta: true },
    { isSynthetic: true },
    { isVisibleInTranscriptOnly: true },
  ])("hides internal native summary history marked %j while retaining identical user input", async flags => {
    const f = await fixture();
    try {
      const content = "This session is being continued from a previous conversation that ran out of context.\n\nSummary:\nFixture context.";
      f.native.page = { messages: [
        { type: "user", uuid: "compact-command", message: { role: "user", content: "/compact" } },
        { type: "system", uuid: "compact-boundary", subtype: "compact_boundary" },
        { type: "user", uuid: "compact-summary", ...flags, message: { role: "user", content } },
        { type: "user", uuid: "typed-message", message: { role: "user", content } },
      ], hasMore: false };
      expect((await f.bridge.history("local-native")).items).toEqual([
        expect.objectContaining({ id: "compact-command", role: "user", text: "/compact" }),
        expect.objectContaining({ id: "typed-message", role: "user", text: content }),
      ]);
    } finally { await f.close(); }
  });

  it.each([
    { isCompactSummary: true },
    { isMeta: true },
    { isSynthetic: true },
    { isVisibleInTranscriptOnly: true },
  ])("does not accept internal native summary events marked %j as user messages", async flags => {
    const f = await fixture();
    try {
      const content = [{ type: "text", text: "This session is being continued from a previous conversation that ran out of context.\n\nSummary:\nFixture context." }];
      await f.message({ type: "user", uuid: "compact-command", message: { role: "user", content: "/compact" } });
      await f.message({ type: "system", uuid: "compact-boundary", subtype: "compact_boundary" });
      await f.message({ type: "user", uuid: "compact-summary", ...flags, message: { role: "user", content } });
      await f.message({ type: "user", uuid: "typed-message", isCompactSummary: false, isMeta: false, isSynthetic: false, isVisibleInTranscriptOnly: false, message: { role: "user", content } });
      expect(f.eventLog.replay(0).filter(event => event.type === "user.message.accepted")).toEqual([
        expect.objectContaining({ itemId: "compact-command", data: expect.objectContaining({ text: "/compact" }) }),
        expect.objectContaining({ itemId: "typed-message", data: expect.objectContaining({ text: content[0]!.text }) }),
      ]);
    } finally { await f.close(); }
  });

  it.each([false, true])("derives cursors from the oldest raw UUID and ends pagination (empty terminal page: %s)", async empty => {
    const f = await fixture();
    try {
      f.native.page = { messages: [{ type: "system", uuid: "oldest-control" }, { type: "assistant", uuid: "row", message: { id: "api-message", content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "Visible" }] } }], hasMore: true };
      f.native.pages.set("oldest-control", { hasMore: false, messages: empty ? [] : [
        { type: "user", uuid: "first-request", message: { content: "First request" } },
        { type: "assistant", uuid: "first-reply", message: { content: "First reply" } },
      ] });
      const page = await f.bridge.history("local-native", undefined, 2);
      expect(page).toMatchObject({ hasMore: true, nextCursor: "oldest-control", items: [{ id: "api-message", text: "Visible" }] });
      f.native.calls.length = 0;
      const last = await f.bridge.history("local-native", page.nextCursor, 2);
      expect(last).toMatchObject({ hasMore: false, items: empty ? [] : [
        { id: "first-request", text: "First request" }, { id: "first-reply", text: "First reply" },
      ] });
      expect(last).not.toHaveProperty("nextCursor");
      expect(f.native.calls).toEqual([{ method: "getTranscriptPage", args: ["local-native", "oldest-control", 2, { window: "accept" }] }]);
    } finally { await f.close(); }
  });

  it("opens a newly created session before its first message with empty history", async () => {
    const f = await fixture();
    try {
      const { sessionId } = await f.bridge.createSession("/project");
      expect(sessionId).not.toBe("local-native");
      const controller = createControllerFixture({ broker: f.bridge, eventLog: f.eventLog });
      f.native.calls.length = 0;
      const opened = await controller.dispatchLocal({ method: "session.open", params: { sessionId } });
      expect(opened).toMatchObject({ ok: true });
      expect(opened).toHaveProperty("result.history", { sessionId, items: [], hasMore: false });
      expect(f.native.calls.filter(call => call.method === "getTranscriptPage")).toEqual([
        { method: "getTranscriptPage", args: [sessionId, "", 18, { window: "accept" }] },
      ]);
    } finally { await f.close(); }
  });

  it.each(["default", "acceptEdits", "bypassPermissions", "plan", "auto", "dontAsk"])("projects the current native %s mode without a prior mode change", async mode => {
    const f = await fixture();
    try {
      f.native.sessions[0]!.permissionMode = mode;
      await f.bridge.refreshRuntime();
      expect(f.bridge.session("local-native")).toMatchObject({ nativePermissionMode: mode });
      expect(f.bridge.session("local-native")?.nativePermissionModeChange).toBeUndefined();
      delete f.native.sessions[0]!.permissionMode;
      await f.bridge.refreshRuntime();
      expect(f.bridge.session("local-native")).not.toHaveProperty("nativePermissionMode");
    } finally { await f.close(); }
  });

  it("waits for the new Native session's catalog before applying a preselected output style", async () => {
    const f = await fixture();
    try {
      f.native.globalOutputStyles = { builtIns: ["Concise"], customs: ["Personal notes"] };
      expect((await f.bridge.defaultConfiguration()).availableOutputStyles).toEqual(["Concise", "Personal notes"]);
      const created = await f.bridge.createSession("/project");
      const pending = f.bridge.configureSession({ sessionId: created.sessionId, outputStyle: "Concise" });
      expect(f.native.calls.some(call => call.method === "applyFlagSettings")).toBe(false);
      const session = f.native.sessions.find(entry => entry.sessionId === created.sessionId)!;
      session.availableOutputStyles = ["default", "concise", "Project notes"];
      f.native.emit("event", { type: "session_updated", sessionId: created.sessionId, session: structuredClone(session) });
      await expect(pending).resolves.toMatchObject({ outputStyle: "concise", availableOutputStyles: session.availableOutputStyles });
      expect(f.native.calls.filter(call => call.method === "applyFlagSettings")).toEqual([
        { method: "applyFlagSettings", args: [created.sessionId, { outputStyle: "concise" }] },
      ]);
      expect(f.bridge.session(created.sessionId)).toMatchObject({ outputStyle: "concise", outputStyleCatalogReady: true });
      expect(f.bridge.session("local-native")?.outputStyle).toBeUndefined();
    } finally { await f.close(); }
  });

  it("uses Native readback for an active session's next-turn style and rejects an unavailable or unapplied style", async () => {
    const f = await fixture();
    try {
      const session = f.native.sessions[0]!;
      Object.assign(session, { turnRunning: true, availableOutputStyles: ["default", "Project notes"], outputStyle: "default" });
      await expect(f.bridge.configureSession({
        sessionId: "local-native", outputStyle: "Unknown", model: "other-model", effort: "high", permissionMode: "plan",
      })).rejects.toThrow("此会话不提供输出风格");
      expect(f.native.calls.filter(call => ["applyFlagSettings", "setModel", "setEffort", "setPermissionMode"].includes(call.method))).toEqual([]);
      await expect(f.bridge.configureSession({ sessionId: "local-native", outputStyle: "Project notes" })).resolves.toMatchObject({
        appliesAfterTurn: true, outputStyle: "Project notes",
      });
      f.native.applyOutputStyle = false;
      await expect(f.bridge.configureSession({ sessionId: "local-native", outputStyle: "default" })).rejects.toThrow("未应用输出风格");
      expect(f.native.calls.some(call => call.method === "interrupt" || call.method === "sendMessage")).toBe(false);
    } finally { await f.close(); }
  });

  it("forwards permission IDs and native modes without a Bridge auto-approval policy", async () => {
    const f = await fixture();
    try {
      f.native.sessions[0]!.pendingToolPermissions = [{ requestId: "native-ask", sessionId: "local-native", toolName: "AskUserQuestion", input: { questions: [] } }];
      await f.bridge.refreshRuntime();
      expect(f.bridge.permissionsList()).toMatchObject([{ requestId: "native-ask", canAllowAlways: false }]);
      expect(f.native.calls.some(call => call.method === "respondToToolPermission")).toBe(false);
      expect(await f.bridge.resolvePermission("native-ask", "allow-once", undefined, { answers: { x: "yes" } })).toBe(true);
      expect(f.native.calls.find(call => call.method === "respondToToolPermission")?.args).toEqual(["native-ask", "once", { questions: [], answers: { x: "yes" } }]);
      const configured = await f.bridge.configureSession({ sessionId: "local-native", permissionMode: "plan" });
      expect(configured.nativePermissionMode).toBe("plan");
      expect(configured.permissionPolicy).toBeUndefined();
    } finally { await f.close(); }
  });

  it.each(["default", "acceptEdits", "bypassPermissions"] as const)("sets native %s before approving ExitPlanMode and confirms it from Desktop", async mode => {
    const f = await fixture();
    try {
      f.native.sessions[0]!.permissionMode = "plan";
      f.native.sessions[0]!.pendingToolPermissions = [{ requestId: "exit-plan", toolName: "ExitPlanMode", input: { plan: "Implement" } }];
      await f.bridge.refreshRuntime();
      expect(f.bridge.permissionsList()[0]?.canSetNativeFullAccess).toBe(true);
      const changes: unknown[] = [];
      f.bridge.on("changed", () => changes.push(f.bridge.session("local-native")?.nativePermissionModeChange));
      f.native.calls = [];
      expect(await f.bridge.resolvePermission("exit-plan", "allow-once", "Keep the diff small", { plan: "Updated" }, { deviceId: "phone", name: "Phone" }, mode)).toBe(true);
      expect(f.native.calls.filter(call => ["setPermissionMode", "respondToToolPermission"].includes(call.method))).toEqual([
        { method: "setPermissionMode", args: ["local-native", mode] },
        { method: "respondToToolPermission", args: ["exit-plan", "once", { plan: "Updated", _feedbackMessage: "Keep the diff small" }] },
      ]);
      expect(changes).toContainEqual({ requestId: "exit-plan", mode, state: "requested" });
      expect(f.bridge.session("local-native")?.nativePermissionModeChange).toEqual({ requestId: "exit-plan", mode, state: "confirmed", observedMode: mode });
      expect((await f.bridge.configuration("local-native")).nativePermissionMode).toBe(mode);
      expect(f.eventLog.replay(0).find(event => event.type === "permission.resolved")?.data).toMatchObject({ resolvedByDeviceId: "phone", resolvedByName: "Phone" });
    } finally { await f.close(); }
  });

  it("does not approve when the native mode setter is unsupported or rejects the choice", async () => {
    const f = await fixture();
    try {
      f.native.sessions[0]!.pendingToolPermissions = [{ requestId: "exit-plan", toolName: "ExitPlanMode", input: {} }];
      f.native.unsupported.add("setPermissionMode");
      await f.bridge.refreshRuntime();
      expect(f.bridge.permissionsList()[0]?.canSetNativeFullAccess).toBe(false);
      await expect(f.bridge.resolvePermission("exit-plan", "allow-once", undefined, undefined, undefined, "bypassPermissions")).rejects.toThrow(/unsupported/iu);
      expect(f.native.calls.some(call => call.method === "respondToToolPermission")).toBe(false);
      f.native.unsupported.clear();
      f.native.permissionModeResult = false;
      await expect(f.bridge.resolvePermission("exit-plan", "allow-once", undefined, undefined, undefined, "bypassPermissions")).rejects.toThrow(/permission mode/iu);
      expect(f.bridge.permissionsList()).toHaveLength(1);
      expect(f.bridge.session("local-native")?.nativePermissionModeChange).toMatchObject({ state: "not-applied", observedMode: "default" });
      expect(f.native.calls.some(call => call.method === "respondToToolPermission")).toBe(false);
    } finally { await f.close(); }
  });

  it("does not confirm a mode from the setter acknowledgment when Desktop metadata differs", async () => {
    const f = await fixture();
    try {
      f.native.applyPermissionMode = false;
      f.native.sessions[0]!.permissionMode = "plan";
      f.native.sessions[0]!.pendingToolPermissions = [{ requestId: "exit-plan", toolName: "ExitPlanMode", input: {} }];
      await f.bridge.refreshRuntime();
      await f.bridge.resolvePermission("exit-plan", "allow-once", undefined, undefined, undefined, "acceptEdits");
      expect(f.bridge.session("local-native")?.nativePermissionModeChange).toEqual({ requestId: "exit-plan", mode: "acceptEdits", state: "not-applied", observedMode: "plan" });
      expect(f.bridge.session("local-native")?.nativePermissionMode).toBe("plan");
      f.native.sessions[0]!.permissionMode = "acceptEdits";
      await f.bridge.refreshRuntime();
      expect(f.bridge.session("local-native")?.nativePermissionModeChange?.state).toBe("confirmed");
    } finally { await f.close(); }
  });

  it("denies with feedback without changing native mode even when a mode was supplied", async () => {
    const f = await fixture();
    try {
      f.native.sessions[0]!.pendingToolPermissions = [{ requestId: "exit-plan", toolName: "ExitPlanMode", input: { plan: "Implement" } }];
      f.native.unsupported.add("setPermissionMode");
      await f.bridge.refreshRuntime();
      expect(await f.bridge.resolvePermission("exit-plan", "deny", "Revise the plan", undefined, undefined, "bypassPermissions")).toBe(true);
      expect(f.native.calls.some(call => call.method === "setPermissionMode")).toBe(false);
      expect(f.native.calls.find(call => call.method === "respondToToolPermission")?.args).toEqual(["exit-plan", "deny", { plan: "Implement", _feedbackMessage: "Revise the plan" }]);
      expect(f.bridge.session("local-native")?.nativePermissionModeChange).toBeUndefined();
    } finally { await f.close(); }
  });

  it("keeps directory refresh independent of transcript catalog scans", async () => {
    const f = await fixture();
    try {
      f.options.scanCatalog.mockClear();
      await f.bridge.refreshRuntime();
      expect(f.bridge.listSessions()).toHaveLength(1);
      expect(f.options.scanCatalog).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it("refreshes one session without refreshing the entire directory", async () => {
    const f = await fixture();
    try {
      f.options.scanCatalog.mockClear();
      f.native.calls = [];
      await f.bridge.refreshDesktopSession("local-native");
      expect(f.native.calls).toContainEqual({ method: "getSession", args: ["local-native"] });
      expect(f.native.calls.some(call => call.method === "getAll")).toBe(false);
      expect(f.options.scanCatalog).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it("reads only the selected session metadata on sequential task polls", async () => {
    const f = await fixture(false, undefined, true);
    const paths = platform.claudeRuntimePaths("darwin", {}, f.directory);
    const resolvePaths = vi.spyOn(platform, "claudeRuntimePaths").mockReturnValue(paths);
    const reads = vi.mocked(readFile);
    reads.mockClear();
    vi.stubEnv("BRIDGE_DISABLE_PROCESS_SCAN", "1");
    try {
      const desktopRoot = paths.desktopSessions[0]!;
      const sessionId = "local-native";
      const sessionDir = join(desktopRoot, "profile", "account");
      const target = join(sessionDir, `${sessionId}.json`);
      const cwd = f.directory;
      await Promise.all([mkdir(sessionDir, { recursive: true }), mkdir(paths.projects, { recursive: true })]);
      await Promise.all([
        writeFile(target, JSON.stringify({ sessionId, cliSessionId: "target-cli", cwd })),
        ...Array.from({ length: 12 }, (_, index) => {
          const otherId = `local_11111111-1111-4111-8111-${String(index).padStart(12, "0")}`;
          return writeFile(join(sessionDir, `${otherId}.json`), JSON.stringify({ sessionId: otherId, cliSessionId: `other-${index}`, cwd }));
        }),
      ]);
      const transcript = join(paths.projects, "target-cli.jsonl");
      await writeFile(transcript, [
        { type: "assistant", uuid: "use", timestamp: new Date(10_000).toISOString(), message: { content: [{ type: "tool_use", id: "agent", name: "Agent", input: { description: "Inspect", prompt: "Inspect" } }] } },
        { type: "user", uuid: "result", parentUuid: "use", timestamp: new Date(11_000).toISOString(), message: { content: [{ type: "tool_result", tool_use_id: "agent", content: "Async agent launched successfully. agentId: ag-1" }] } },
      ].map(row => JSON.stringify(row)).join("\n") + "\n");

      expect(await f.bridge.backgroundTaskDetails(sessionId)).toMatchObject([{ id: "agent", state: "stopped" }]);
      await appendFile(transcript, JSON.stringify({
        type: "user", uuid: "done", parentUuid: "result", timestamp: new Date(12_000).toISOString(),
        message: { role: "user", content: "<task-notification>\n<task-id>ag-1</task-id>\n<status>completed</status>\n</task-notification>" },
      }) + "\n");
      expect(await f.bridge.backgroundTaskDetails(sessionId)).toMatchObject([{ id: "agent", state: "completed" }]);
      expect(reads.mock.calls.map(([path]) => path).filter(path => typeof path === "string" && path.startsWith(desktopRoot) && path.endsWith(".json"))).toEqual([target, target]);
    } finally {
      reads.mockClear();
      resolvePaths.mockRestore();
      vi.unstubAllEnvs();
      await f.close();
    }
  });

  it("merges effort declarations by gateway route across context variants", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-effort-catalog-"));
    const state = new ConversationStateStore({ databasePath: join(root, "state.sqlite") });
    const eventLog = new SessionEventLog(join(root, "events.jsonl"));
    await state.initialize();
    await eventLog.initialize();
    const settingsPath = join(root, "settings.json");
    const retired = `magpie-${magpieModelIdHash("group/retired")}.anthropic.claude-opus-5-5`;
    const bridge = new ClaudeDesktopBridge({
      settingsPath, eventLog, conversationState: state, inspector: new NativeDesktop(), home: root, environment: {},
      fetchImpl: async () => Response.json({ data: [
        { id: "group/runner", max_input_tokens: 200_000, reasoning_levels: ["ultra"] },
        { id: "claude/claude-opus-5-5", reasoning_levels: ["low", "ultra"] },
      ] }),
    });
    try {
      await writeFile(settingsPath, JSON.stringify({
        env: { ANTHROPIC_BASE_URL: "https://catalog.example.test" },
        modelPicker: { options: [{ model: "group/runner[1m]", label: "Runner 1M" }, { model: retired, label: "Retired" }] },
      }));
      await bridge.initialize();
      const { availableModels } = await bridge.defaultConfiguration();
      const runner = availableModels.find(model => model.value === "group/runner[1m]");
      expect.soft(runner).toMatchObject({ displayName: "Runner 1M", supportsEffort: false, declaredEffortLevels: ["ultra"] });
      expect.soft(runner).not.toHaveProperty("maxInputTokens", 200_000);
      expect.soft(availableModels.find(model => model.value === retired)).not.toHaveProperty("declaredEffortLevels");
    } finally {
      await bridge.close();
      await eventLog.close();
      state.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("opens the latest native history while the model catalog request is pending", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-open-catalog-"));
    const state = new ConversationStateStore({ databasePath: join(root, "state.sqlite") });
    const eventLog = new SessionEventLog(join(root, "events.jsonl"));
    await state.initialize();
    await eventLog.initialize();
    const native = new NativeDesktop();
    native.pages.set("", { hasMore: true, messages: [
      { type: "user", uuid: "newest", message: { content: "Latest native message" } },
    ] });
    native.pages.set("newest", { hasMore: false, messages: [] });
    let releaseCatalog!: () => void;
    const catalog = new Promise<Response>(resolve => {
      releaseCatalog = () => resolve(new Response(null, { status: 503 }));
    });
    const fetchImpl = vi.fn<typeof fetch>(() => catalog);
    const settingsPath = join(root, "settings.json");
    const bridge = new ClaudeDesktopBridge({
      settingsPath, eventLog, conversationState: state, inspector: native,
      home: root, environment: {}, fetchImpl, refreshIntervalMs: 60_000,
    });
    const controller = createControllerFixture({ broker: bridge, eventLog });
    const configurationRequest = {
      kind: "request" as const, method: "session.configuration" as const,
      requestId: "configuration", idempotencyKey: "configuration", params: { sessionId: "local-native" },
    };
    const pending: Promise<unknown>[] = [];
    try {
      await bridge.initialize();
      await writeFile(settingsPath, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://catalog.example.test" } }));
      const firstConfiguration = controller.handleRequest(configurationRequest, "mobile", "phone");
      pending.push(firstConfiguration);
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));

      native.sessions[0]!.title = "Fresh native title";
      const opened = vi.fn();
      pending.push(controller.handleRequest({
        ...configurationRequest, method: "session.open", requestId: "open", idempotencyKey: "open",
      }, "mobile", "phone").then(opened));
      await vi.waitFor(() => expect(opened).toHaveBeenCalledWith(expect.objectContaining({
        session: expect.objectContaining({ sessionId: "local-native", title: "Fresh native title" }),
        history: expect.objectContaining({
          items: [expect.objectContaining({ id: "newest", text: "Latest native message" })],
          hasMore: true, nextCursor: "newest",
        }),
      })));
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      releaseCatalog();
      expect(await firstConfiguration).toMatchObject({ session: { title: "Fresh native title" } });
      fetchImpl.mockResolvedValueOnce(Response.json({ data: [{ id: "fixture-model", display_name: "Fixture model" }] }));
      await expect(controller.handleRequest({ ...configurationRequest, requestId: "retry", idempotencyKey: "retry" }, "mobile", "phone")).resolves.toMatchObject({
        configuration: { modelsComplete: true, availableModels: [{ value: "fixture-model", displayName: "Fixture model" }] },
      });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      releaseCatalog();
      await Promise.allSettled(pending);
      await bridge.close();
      await eventLog.close();
      state.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps task detail reads optional and lets conversation opening finish independently", async () => {
    const f = await fixture();
    try {
      const controller = createControllerFixture({ broker: f.bridge, eventLog: f.eventLog });
      const tasks = [{ id: "shell", kind: "bash" as const, description: "Build", state: "completed" as const, startedAt: 1, updatedAt: 2 }];
      let release!: (value: typeof tasks) => void;
      const details = vi.spyOn(f.bridge, "backgroundTaskDetails").mockImplementation(() => new Promise<typeof tasks>(resolve => { release = resolve; }));
      const history = vi.spyOn(f.bridge, "history");
      const request = { kind: "request" as const, requestId: "configuration", idempotencyKey: "configuration", method: "session.configuration" as const, params: { sessionId: "local-native" } };
      await controller.handleRequest(request, "mobile", "phone");
      expect(details).not.toHaveBeenCalled();
      expect(history).not.toHaveBeenCalled();
      const pending = controller.handleRequest({ ...request, params: { ...request.params, includeBackgroundTasks: true } }, "mobile", "phone");
      await vi.waitFor(() => expect(details).toHaveBeenCalledExactlyOnceWith("local-native"));
      const opened = await controller.handleRequest({ ...request, method: "session.open" }, "mobile", "phone");
      expect(opened).toHaveProperty("history.items", []);
      release(tasks);
      expect(await pending).toHaveProperty("session.backgroundTasks", tasks);
      expect(history).toHaveBeenCalledTimes(1);
      expect(f.bridge.listSessions()[0]?.backgroundTasks).toBeUndefined();
    } finally { await f.close(); }
  });

  it("caches transcript background tasks by native Desktop ID and uses process lifetime independently of the main turn", async () => {
    const f = await fixture();
    try {
      const transcript = join(f.options.settingsPath, "..", "cli-session.jsonl");
      const rows = [
        { type: "assistant", message: { content: [{ type: "tool_use", id: "shell", name: "Bash", input: { command: "fixture-only", description: "Watch build", run_in_background: true } }] } },
        { type: "user", toolUseResult: { backgroundTaskId: "shell-task" }, message: { content: [{ type: "tool_result", tool_use_id: "shell", content: "Background task" }] } },
        { type: "assistant", message: { content: [{ type: "tool_use", id: "agent", name: "Agent", input: { description: "Read fixtures", prompt: "Read" } }] } },
        { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "agent", content: "Async agent launched successfully. agentId: agent-task" }] } },
        { type: "assistant", message: { content: [{ type: "tool_use", id: "workflow", name: "Workflow", input: { scriptPath: "/fixture.js" } }] } },
        { type: "user", toolUseResult: { status: "async_launched", taskId: "workflow-task", taskType: "local_workflow", workflowName: "Review", runId: "wf_fixture", summary: "Check fixtures" }, message: { content: [{ type: "tool_result", tool_use_id: "workflow", content: "Workflow launched" }] } },
      ];
      await writeFile(transcript, rows.map((row, index) => JSON.stringify({ ...row, uuid: `row-${index}`, ...(index ? { parentUuid: `row-${index - 1}` } : {}), timestamp: new Date(10_000 + index * 1_000).toISOString(), isSidechain: false })).join("\n") + "\n");
      await mkdir(join(transcript.replace(/\.jsonl$/u, ""), "subagents", "workflows", "wf_fixture"), { recursive: true });
      await writeFile(join(transcript.replace(/\.jsonl$/u, ""), "subagents", "workflows", "wf_fixture", "journal.jsonl"), JSON.stringify({ type: "started", agentId: "workflow-agent", phase: "Check", label: "Check sources" }) + "\n");
      const observed = {
        ...f.bridge.session("local-native")!, sessionId: "cli-session", desktopSessionId: "local-native", transcriptPath: transcript,
        transcriptMtimeMs: 0, processAlive: true, desktopProcessAlive: true, bridgeProcessAlive: false, processOverlap: false, activeTask: false,
        activeProcesses: [
          { startedAt: 1_000, processAlive: true, entrypoint: "claude-desktop-3p", source: "process" as const },
          { startedAt: 30_000, processAlive: true, entrypoint: "claude-desktop-3p", source: "process" as const },
        ],
      };
      f.options.scanCatalog.mockResolvedValue({ projects: [], sessions: [observed, { ...observed, sessionId: "foreign-cli", desktopSessionId: "foreign-native" }], observedAt: 0 });
      await f.bridge.refreshRuntime();
      const taskDetails = await f.bridge.backgroundTaskDetails("local-native");
      const snapshot = f.bridge.session("local-native")!;
      expect(snapshot.turnState).toBe("idle");
      expect(snapshot.runningSubagents?.count).toBe(1);
      expect(taskDetails).toMatchObject([
        { id: "workflow", kind: "workflow", state: "running", workflow: { runId: "wf_fixture", phases: ["Check"], agents: [{ agentId: "workflow-agent", state: "running" }] } },
        { id: "agent", kind: "subagent", state: "running" },
        { id: "shell", kind: "bash", state: "running" },
      ]);
      expect(f.bridge.listSessions()).toHaveLength(1);
      f.options.scanCatalog.mockClear();
      expect(snapshot.backgroundTasks).toBeUndefined();
      expect(f.bridge.listSessions()[0]?.backgroundTasks).toBeUndefined();
      expect(f.options.scanCatalog).not.toHaveBeenCalled();
      f.native.sessions[0]!.turnRunning = true;
      observed.activeProcesses = [];
      await f.bridge.refreshRuntime();
      expect(f.bridge.session("local-native")?.turnState).toBe("running");
      expect((await f.bridge.backgroundTaskDetails("local-native")).every(task => task.state === "stopped")).toBe(true);
      expect(f.bridge.session("local-native")?.runningSubagents).toBeUndefined();
    } finally { await f.close(); }
  });

  it("coalesces overlapping backgroundTaskDetails and subagent enrichment catalog reads while keeping subsequent reads fresh", async () => {
    const f = await fixture();
    try {
      const transcript = join(f.options.settingsPath, "..", "coalesce-session.jsonl");
      await writeFile(transcript, [
        JSON.stringify({ type: "assistant", uuid: "a1", timestamp: new Date(10_000).toISOString(), isSidechain: false, message: { content: [{ type: "tool_use", id: "agent-1", name: "Agent", input: { description: "First agent", prompt: "Inspect" } }] } }),
        JSON.stringify({ type: "user", uuid: "u1", parentUuid: "a1", timestamp: new Date(11_000).toISOString(), isSidechain: false, message: { content: [{ type: "tool_result", tool_use_id: "agent-1", content: "Async agent launched successfully. agentId: ag-1" }] } }),
      ].join("\n") + "\n");
      const observed = {
        ...f.bridge.session("local-native")!, sessionId: "coalesce-cli", desktopSessionId: "local-native", transcriptPath: transcript,
        transcriptMtimeMs: 0, processAlive: true, desktopProcessAlive: true, bridgeProcessAlive: false, processOverlap: false, activeTask: false,
        activeProcesses: [{ startedAt: 1_000, processAlive: true, entrypoint: "claude-desktop-3p", source: "process" as const }],
      };
      let releaseCatalog!: () => void;
      f.options.scanCatalog.mockClear();
      f.options.scanCatalog.mockImplementationOnce(() => new Promise(resolve => {
        releaseCatalog = () => resolve({ projects: [], sessions: [observed], observedAt: 0 });
      }));
      f.options.scanCatalog.mockResolvedValue({ projects: [], sessions: [{ ...observed, activeProcesses: [] }], observedAt: 1 });

      const overlapping = [
        f.bridge.backgroundTaskDetails("local-native"),
        f.bridge.backgroundTaskDetails("local-native"),
        f.bridge.backgroundTaskDetails("local-native"),
        f.message({ type: "system", subtype: "task_started", task_id: "ag-1", tool_use_id: "agent-1", description: "First agent", timestamp: 11_000 }),
      ] as const;
      await vi.waitFor(() => expect(f.options.scanCatalog).toHaveBeenCalledTimes(1));
      releaseCatalog();
      const [first, second, third] = await Promise.all(overlapping);
      expect(f.options.scanCatalog).toHaveBeenCalledTimes(1);
      expect(first).toEqual(second);
      expect(second).toEqual(third);
      expect(first[0]).toMatchObject({ id: "agent-1", state: "running" });

      const afterExit = await f.bridge.backgroundTaskDetails("local-native");
      expect(f.options.scanCatalog).toHaveBeenCalledTimes(2);
      expect(afterExit[0]).toMatchObject({ id: "agent-1", state: "stopped" });
    } finally { await f.close(); }
  });

  it("adds btw once to the native command menu and preserves native command metadata", async () => {
    const f = await fixture();
    try {
      expect((await f.bridge.commands("local-native")).commands.map(command => command.name)).toEqual(["compact", "btw", "rewind"]);
      f.native.commands.push({ name: "btw", description: "Native side question" });
      const catalog = await f.bridge.commands("local-native");
      expect(catalog.commands.filter(command => command.name === "btw")).toEqual([{ name: "btw", description: "Native side question" }]);
      expect(catalog.commands[0]).toEqual(f.native.commands[0]);
    } finally { await f.close(); }
  });

  it("starts a native btw child, sends only the question there, and restores native sidechat identity", async () => {
    const f = await fixture();
    let restarted: ClaudeDesktopBridge | undefined;
    let reloadedLog: SessionEventLog | undefined;
    try {
      const command = { ...input, text: "/btw Why does this work?" };
      const result = await f.bridge.runCommand(command);
      expect(result).toMatchObject({ action: "session", session: { sessionId: "local-child", parentSessionId: "local-native", sidechat: true } });
      expect(f.native.calls.filter(call => call.method === "startBtwChild")).toEqual([{ method: "startBtwChild", args: ["local-native"] }]);
      expect(f.native.calls.some(call => call.method === "forkSession")).toBe(false);
      expect(f.native.calls.filter(call => ["startBtwChild", "getSession", "sendMessage"].includes(call.method)).map(call => call.method)).toEqual(["startBtwChild", "getSession", "sendMessage"]);
      expect(f.native.calls.find(call => call.method === "sendMessage")?.args.slice(0, 2)).toEqual(["local-child", "Why does this work?"]);
      expect(f.native.sessions.find(session => session.sessionId === "local-child")?.spawnedFrom).toMatchObject({ sessionId: "local-native", btw: true });
      expect(f.eventLog.replay(0).some(event => event.type === "session.observed")).toBe(false);
      expect(withDatabase(f.databasePath, (db) => db.prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'bridge_sessions'",
      ).get())).toBeUndefined();
      expect(await f.bridge.runCommand(command)).toMatchObject({ action: "session", session: { sessionId: "local-child" } });
      expect(f.native.calls.filter(call => call.method === "startBtwChild")).toHaveLength(1);
      expect(f.native.calls.filter(call => call.method === "sendMessage")).toHaveLength(1);
      await f.bridge.close();
      await f.eventLog.close();
      reloadedLog = new SessionEventLog(f.eventLog.path);
      await reloadedLog.initialize();
      restarted = new ClaudeDesktopBridge({ ...f.options, eventLog: reloadedLog });
      await restarted.initialize();
      expect(restarted.session("local-child")).toMatchObject({ sidechat: true, parentSessionId: "local-native" });
    } finally { await restarted?.close(); await reloadedLog?.close(); await f.close(); }
  });

  it.each(["refused", "disabled", "failed"])("reports native btw %s without falling back to an ordinary fork", async status => {
    const f = await fixture();
    try {
      f.native.btwResult = { status, refusalReason: "native-policy" };
      await expect(f.bridge.runCommand({ ...input, text: "/btw Why?" })).rejects.toThrow(new RegExp(`${status}.*native-policy`, "u"));
      expect(f.native.calls.filter(call => call.method === "startBtwChild")).toHaveLength(1);
      expect(f.native.calls.some(call => call.method === "forkSession" || call.method === "sendMessage")).toBe(false);
      expect(f.bridge.listSessions()).toHaveLength(1);
    } finally { await f.close(); }
  });

  it("reports an unsupported native btw method without creating another session", async () => {
    const f = await fixture();
    try {
      f.native.unsupported.add("startBtwChild");
      await expect(f.bridge.runCommand({ ...input, text: "/btw Why?" })).rejects.toThrow("Unsupported");
      expect(f.native.calls.some(call => call.method === "forkSession" || call.method === "sendMessage")).toBe(false);
    } finally { await f.close(); }
  });

  it("projects sidechat and parent navigation from native metadata without a Bridge marker", async () => {
    const f = await fixture();
    try {
      f.native.sessions.push({ sessionId: "desktop-btw", cwd: "/project", spawnedFrom: { sessionId: "local-native", btw: true } });
      await f.bridge.refreshRuntime();
      expect(f.bridge.session("desktop-btw")).toMatchObject({ sidechat: true, parentSessionId: "local-native" });
      f.native.sessions[1]!.lineageDetached = true;
      await f.bridge.refreshRuntime();
      expect(f.bridge.session("desktop-btw")?.sidechat).toBeUndefined();
      expect(f.eventLog.replay(0).some(event => event.type === "session.observed")).toBe(false);
    } finally { await f.close(); }
  });

  it("requires a btw question before forking and forwards other native commands unchanged", async () => {
    const f = await fixture();
    try {
      await expect(f.bridge.runCommand({ ...input, text: "/btw   " })).rejects.toThrow(/question/iu);
      expect(f.native.calls.some(call => ["startBtwChild", "forkSession", "sendMessage"].includes(call.method))).toBe(false);
      expect(await f.bridge.runCommand({ ...input, text: "/compact" })).toEqual({ action: "sent" });
      expect(f.native.calls.find(call => call.method === "sendMessage")?.args.slice(0, 2)).toEqual(["local-native", "/compact"]);
    } finally { await f.close(); }
  });

  it.each(["Read", "Bash", "Edit", "mcp__reports__export"])("keeps %s identity and input summary on completion without its start event", async name => {
    const f = await fixture();
    try {
      await f.message({ type: "assistant", uuid: "named-call", message: { content: [{ type: "tool_use", id: "named-tool", name, input: { file_path: "/project/named.ts" } }] } });
      const started = f.eventLog.latestItem("local-native", "tool.started", "named-tool");
      expect(started?.data.toolName).toBe(name);
      await f.message({ type: "user", uuid: "named-result", message: { content: [{ type: "tool_result", tool_use_id: "named-tool", content: "Finished" }] } });
      expect(f.eventLog.latestItem("local-native", "tool.completed", "named-tool")?.data).toMatchObject({ toolName: name, text: started!.data.text });
    } finally { await f.close(); }
  });

  it.each([false, true])("keeps a persisted tool identity and dedup after Bridge restarts (compacted=%s)", async compacted => {
    const f = await fixture();
    let restarted: ClaudeDesktopBridge | undefined;
    let reloadedLog: SessionEventLog | undefined;
    try {
      const call = { type: "assistant", uuid: "restart-call", message: { content: [{ type: "tool_use", id: "restart-tool", name: "Read", input: { file_path: "/project/restart.ts" } }] } };
      await f.message(call);
      await f.bridge.close();
      await f.eventLog.close();
      reloadedLog = new SessionEventLog(f.eventLog.path, 80, compacted ? { bytesThreshold: 1, retainEvents: 0 } : undefined);
      await reloadedLog.initialize();
      restarted = new ClaudeDesktopBridge({ ...f.options, eventLog: reloadedLog });
      await restarted.initialize();
      const beforeDuplicate = reloadedLog.latestSeq();
      let changed = once(restarted, "changed");
      f.native.emit("event", { type: "message", sessionId: "local-native", message: call });
      await changed;
      expect(reloadedLog.latestSeq()).toBe(beforeDuplicate);
      // Discard the rehydrated in-memory tool so completion resolves its identity from the event log.
      await restarted.close();
      restarted = new ClaudeDesktopBridge({ ...f.options, eventLog: reloadedLog });
      await restarted.initialize();
      changed = once(restarted, "changed");
      f.native.emit("event", { type: "message", sessionId: "local-native", message: { type: "user", uuid: "restart-result", message: { content: [{ type: "tool_result", tool_use_id: "restart-tool", content: "Finished" }] } } });
      await changed;
      expect(reloadedLog.latestItem("local-native", "tool.completed", "restart-tool")?.data).toMatchObject({ toolName: "Read", text: compacted ? "" : expect.stringContaining("/project/restart.ts") });
    } finally { await restarted?.close(); await reloadedLog?.close(); await f.close(); }
  });

  it.each([
    { name: "mcp__ccd_turn__update_plan", attribution: {} },
    { name: "mcp__ccd_turn__wrap_up", attribution: {} },
    { name: "Read", attribution: { isSidechain: true } },
    { name: "Read", attribution: { parent_tool_use_id: "parent-agent" } },
  ])("does not create an anonymous completion for hidden $name ($attribution)", async ({ name, attribution }) => {
    const f = await fixture();
    try {
      await f.message({ type: "assistant", uuid: "hidden-call", ...attribution, message: { content: [{ type: "tool_use", id: "hidden-tool", name, input: { items: [{ content: "Inspect", status: "in_progress" }] } }] } });
      await f.message({ type: "user", uuid: "hidden-result", ...attribution, message: { content: [{ type: "tool_result", tool_use_id: "hidden-tool", content: "Done" }] } });
      expect(f.eventLog.latestItem("local-native", "tool.completed", "hidden-tool")).toBeUndefined();
    } finally { await f.close(); }
  });

  it("releases completed tool input and keeps raw tool output out of the event log", async () => {
    const f = await fixture();
    try {
      await f.message({ type: "assistant", uuid: "payload-call", message: { content: [{ type: "tool_use", id: "payload-tool", name: "Read", input: { file_path: "/project/payload.ts" } }] } });
      await f.message({ type: "user", uuid: "payload-result", message: { content: [{ type: "tool_result", tool_use_id: "payload-tool", content: "x".repeat(1_024) }] } });
      const completed = f.eventLog.latestItem("local-native", "tool.completed", "payload-tool");
      expect(completed?.data).toMatchObject({ toolName: "Read", text: expect.stringContaining("/project/payload.ts") });
      expect(completed?.data).not.toHaveProperty("output");
      expect((f.bridge as unknown as { tools: Map<string, unknown> }).tools.size).toBe(0);
    } finally { await f.close(); }
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

  it.each([undefined, "older-page"])("adds local actual child models to native history (%s), events and tray", async (cursor) => {
    const f = await fixture();
    try {
      const transcript = join(f.options.settingsPath, "..", "model-session.jsonl");
      await writeFile(transcript, "");
      const childDir = join(transcript.replace(/\.jsonl$/u, ""), "subagents");
      await mkdir(childDir, { recursive: true });
      const child = join(childDir, "agent-child-task.jsonl");
      await writeFile(join(childDir, "agent-child-task.meta.json"), JSON.stringify({ toolUseId: "agent-call" }));
      await writeFile(child, JSON.stringify({ type: "assistant", timestamp: new Date(1000).toISOString(), message: { model: "codex/gpt-6.1-sol", content: [], stop_reason: "tool_use" } }) + "\n");
      f.options.scanCatalog.mockResolvedValue({ projects: [], sessions: [{
        ...f.bridge.session("local-native")!, sessionId: "model-session", desktopSessionId: "local-native", transcriptPath: transcript,
        transcriptMtimeMs: 0, processAlive: true, desktopProcessAlive: true, bridgeProcessAlive: false, processOverlap: false, activeTask: false,
        activeProcesses: [{ startedAt: 1, processAlive: true, entrypoint: "claude-desktop-3p", source: "process" }],
      }], observedAt: 0 });
      const started = { type: "system", subtype: "task_started", task_id: "child-task", tool_use_id: "agent-call", description: "Inspect sources", timestamp: 1000 };
      const call = { type: "assistant", uuid: "call", message: { model: "parent-model", content: [{ type: "tool_use", id: "agent-call", name: "Agent", input: { model: "haiku" } }] } };
      f.native.page.messages = [call, started];
      expect((await f.bridge.history("local-native", cursor)).items.find(item => item.id === "agent-call")?.subagent).toMatchObject({ model: "codex/gpt-6.1-sol", state: "running" });
      // A page containing just the launch tool can still associate the child file by toolUseId.
      f.native.page.messages = [call];
      expect((await f.bridge.history("local-native", cursor)).items.find(item => item.id === "agent-call")?.subagent?.model).toBe("codex/gpt-6.1-sol");
      await f.message(started);
      expect(f.eventLog.latestItem("local-native", "tool.progress", "agent-call")?.data.subagent).toMatchObject({ model: "codex/gpt-6.1-sol", state: "running" });
      await writeFile(child, JSON.stringify({ type: "assistant", timestamp: new Date(2000).toISOString(), message: { model: "antigravity/gemini-4-carbon", content: [], stop_reason: "end_turn" } }) + "\n");
      await f.message({ type: "system", subtype: "task_notification", task_id: "child-task", status: "completed", summary: "Done", timestamp: 2000 });
      expect(f.eventLog.latestItem("local-native", "tool.completed", "agent-call")?.data.subagent).toMatchObject({ model: "antigravity/gemini-4-carbon", state: "completed" });
      expect((await f.bridge.backgroundTaskDetails("local-native"))[0]?.subagent).toMatchObject({ model: "antigravity/gemini-4-carbon", state: "completed" });
      // Once observed, subsequent native progress without a child file keeps the actual model.
      f.options.scanCatalog.mockResolvedValue({ projects: [], sessions: [], observedAt: 0 });
      await f.message({ type: "system", subtype: "task_notification", task_id: "child-task", status: "completed", timestamp: 3000 });
      expect(f.eventLog.latestItem("local-native", "tool.completed", "agent-call")?.data.subagent).toMatchObject({ model: "antigravity/gemini-4-carbon", state: "completed" });
      expect(f.native.calls.some(call => ["sendMessage", "subscribeToSession", "stopTask"].includes(call.method))).toBe(false);
    } finally { await f.close(); }
  });

  it("keeps native task IDs for individual task stopping", async () => {
    const f = await fixture();
    try {
      await f.message({ type: "system", subtype: "task_started", task_id: "native-task", tool_use_id: "tool-call", description: "Read sources", timestamp: 10 });
      expect(f.eventLog.latestItem("local-native", "tool.progress", "tool-call")?.data.subagent).toMatchObject({ agentId: "native-task", state: "running" });
      expect(f.bridge.session("local-native")?.runningSubagents?.count).toBe(1);
      await f.bridge.stopSubagent("local-native", "native-task");
      expect(f.native.calls.at(-1)).toEqual({ method: "stopTask", args: ["local-native", "native-task"] });
      await f.message({ type: "system", subtype: "task_notification", task_id: "native-task", status: "completed", summary: "Done", timestamp: 20 });
      expect(f.eventLog.latestItem("local-native", "tool.completed", "tool-call")?.data.subagent).toMatchObject({ agentId: "native-task", state: "completed", reportText: "Done" });
      expect(f.bridge.session("local-native")?.runningSubagents).toBeUndefined();
    } finally { await f.close(); }
  });

  it("projects a native task stop on the next detail read while the session process stays alive", async () => {
    const f = await fixture();
    try {
      const transcriptPath = join(f.directory, "stop-session.jsonl");
      const childDir = join(f.directory, "stop-session", "subagents");
      await mkdir(childDir, { recursive: true });
      await writeFile(transcriptPath, "");
      await writeFile(join(childDir, "agent-native-task.jsonl"), JSON.stringify({
        type: "assistant", timestamp: new Date(10_000).toISOString(), message: { stop_reason: null, content: [] },
      }) + "\n");
      f.options.scanCatalog.mockResolvedValue({ projects: [], sessions: [{
        ...f.bridge.session("local-native")!, sessionId: "stop-session", desktopSessionId: "local-native", transcriptPath,
        transcriptMtimeMs: 0, processAlive: true, desktopProcessAlive: true, bridgeProcessAlive: false,
        processOverlap: false, activeTask: false,
        activeProcesses: [{ startedAt: 1_000, processAlive: true, entrypoint: "claude-desktop-3p", source: "process" }],
      }], observedAt: 0 });
      const nativeCall = f.native.call.bind(f.native);
      const call = vi.spyOn(f.native, "call").mockImplementation(async (method, args) => {
        if (method === "stopTask") await writeFile(join(childDir, "agent-native-task.meta.json"), JSON.stringify({ stoppedByUser: true }));
        return nativeCall(method, args);
      });
      expect(await f.bridge.backgroundTaskDetails("local-native")).toMatchObject([{ taskId: "native-task", state: "running" }]);
      expect(f.bridge.session("local-native")?.runningSubagents?.count).toBe(1);

      await f.bridge.stopSubagent("local-native", "native-task");
      expect(call).toHaveBeenCalledWith("stopTask", ["local-native", "native-task"]);
      const changed = vi.fn();
      f.bridge.on("changed", changed);
      expect(await f.bridge.backgroundTaskDetails("local-native")).toMatchObject([{ taskId: "native-task", state: "stopped" }]);
      expect(f.bridge.session("local-native")?.runningSubagents).toBeUndefined();
      expect(changed).toHaveBeenCalledTimes(1);
    } finally { await f.close(); }
  });

  it("preserves full multi-thousand-character subagent reports without truncation over short native summaries", async () => {
    const f = await fixture();
    try {
      const transcript = join(f.options.settingsPath, "..", "cli-session.jsonl");
      const childDir = join(transcript.replace(/\.jsonl$/u, ""), "subagents");
      await mkdir(childDir, { recursive: true });
      const childPath = join(childDir, "agent-child-task.jsonl");
      const fullReport = `## Subagent Audit Report 🧪\n\n${"- Verified invariant and full markdown detail line with emoji 🔍\n".repeat(180)}\n### Final Verdict\nPASS`;
      expect([...fullReport].length).toBeGreaterThan(8_000);
      await writeFile(transcript, `${JSON.stringify({ type: "user", uuid: "u1", message: { role: "user", content: "Audit" } })}\n`);
      await writeFile(join(childDir, "agent-child-task.meta.json"), JSON.stringify({ toolUseId: "agent-call", agentType: "verifier", description: "Audit sources", finished: true }));
      await writeFile(childPath, `${JSON.stringify({
        type: "assistant",
        timestamp: new Date(2_000).toISOString(),
        message: { model: "codex/gpt-6.1-sol", role: "assistant", content: [{ type: "text", text: fullReport }], stop_reason: "end_turn" },
      })}\n`);
      f.options.scanCatalog.mockResolvedValue({
        projects: [],
        sessions: [{
          ...f.bridge.session("local-native")!,
          sessionId: "cli-session",
          desktopSessionId: "local-native",
          transcriptPath: transcript,
          transcriptMtimeMs: 0,
          processAlive: true,
          desktopProcessAlive: true,
          bridgeProcessAlive: false,
          processOverlap: false,
          activeTask: false,
          activeProcesses: [{ startedAt: 1, processAlive: true, entrypoint: "claude-desktop-3p", source: "process" }],
        }],
        observedAt: 0,
      });

      const call = { type: "assistant", uuid: "call", message: { model: "parent-model", content: [{ type: "tool_use", id: "agent-call", name: "Agent", input: { description: "Audit sources" } }] } };
      const shortNotification = { type: "system", subtype: "task_notification", task_id: "child-task", tool_use_id: "agent-call", status: "completed", summary: "Done", timestamp: 2_000 };
      f.native.page.messages = [call, shortNotification];
      const page = await f.bridge.history("local-native", "older-cursor");
      const historySubagent = page.items.find(item => item.id === "agent-call")?.subagent;
      expect(historySubagent).toMatchObject({
        agentId: "child-task",
        model: "codex/gpt-6.1-sol",
        agentType: "verifier",
        state: "completed",
        latestText: "Done",
        reportText: fullReport,
      });

      await f.message(shortNotification);
      expect(f.eventLog.latestItem("local-native", "tool.completed", "agent-call")?.data.subagent).toMatchObject({
        agentId: "child-task",
        model: "codex/gpt-6.1-sol",
        state: "completed",
        reportText: fullReport,
      });

      // Resuming the same agentId under a new toolUseId keeps the running resume call separate from the completed call's report.
      const resumeCall = { type: "assistant", uuid: "resume-msg", message: { model: "parent-model", content: [{ type: "tool_use", id: "resume-call", name: "Agent", input: { resume: "child-task", description: "Follow-up audit" } }] } };
      const resumeStarted = { type: "system", subtype: "task_started", task_id: "child-task", tool_use_id: "resume-call", description: "Follow-up audit", timestamp: 3_000 };
      f.native.page.messages = [call, shortNotification, resumeCall, resumeStarted];
      const resumedPage = await f.bridge.history("local-native", "older-cursor");
      expect(resumedPage.items.find(item => item.id === "agent-call")?.subagent).toMatchObject({
        agentId: "child-task",
        toolUseId: "agent-call",
        state: "completed",
        reportText: fullReport,
      });
      const runningResumed = resumedPage.items.find(item => item.id === "resume-call")?.subagent;
      expect(runningResumed).toMatchObject({
        agentId: "child-task",
        toolUseId: "resume-call",
        model: "codex/gpt-6.1-sol",
        state: "running",
      });
      expect(runningResumed?.reportText).toBeUndefined();
    } finally {
      await f.close();
    }
  });

  it("projects native task-plan updates and wrap-up onto one stable card", () => {
    const tool = (id: string, name: string, input: unknown) => ({ type: "assistant", uuid: id, timestamp: 1, message: { content: [{ type: "tool_use", id, name, input }] } });
    const items = nativeHistoryItems("native", [
      tool("plan", "mcp__ccd_turn__update_plan", { items: [{ content: "Read", status: "in_progress" }, { content: "Verify", status: "pending" }] }),
      tool("advance", "mcp__ccd_turn__update_plan", { advance: true }),
      tool("wrap", "mcp__ccd_turn__wrap_up", { recap: "Done" }),
    ]);
    const plans = items.filter(item => item.taskPlan);
    expect(plans).toHaveLength(1);
    expect(plans[0]?.id).toBe("plan:plan");
    expect(plans[0]?.taskPlan?.items.map(item => item.status)).toEqual(["completed", "completed"]);
  });

  it.each([
    ["history", { isSidechain: true, parent_tool_use_id: null }],
    ["live", { isSidechain: true, parent_tool_use_id: null }],
    ["history", { parent_tool_use_id: "agent-call" }],
    ["live", { parent_tool_use_id: "agent-call" }],
  ] as const)("isolates child plans and wrap-up from the parent in %s (%j)", async (source, attribution) => {
    const f = await fixture();
    try {
      const tool = (id: string, name: string, input: unknown) => ({ type: "assistant", uuid: id, isSidechain: false, timestamp: 1, message: { content: [{ type: "tool_use", id, name, input }] } });
      const planItems = [{ content: "Read", status: "in_progress" }, { content: "Verify", status: "pending" }];
      const messages = [
        tool("parent-plan", "mcp__ccd_turn__update_plan", { scope: "first_task", items: planItems }),
        { type: "system", subtype: "task_started", task_id: "child-task", tool_use_id: "agent-call", description: "Inspect sources", timestamp: 2 },
        { ...tool("child-plan", "mcp__ccd_turn__update_plan", { scope: "first_task", items: [{ content: "Inspect", status: "in_progress" }] }), ...attribution },
        { ...tool("child-advance", "mcp__ccd_turn__update_plan", { advance: true }), ...attribution },
        { ...tool("child-wrap", "mcp__ccd_turn__wrap_up", { recap: "Child finished" }), ...attribution },
        tool("parent-advance", "mcp__ccd_turn__update_plan", { advance: true }),
        tool("next-plan", "mcp__ccd_turn__update_plan", { scope: "new_task", items: planItems }),
      ];
      let plans;
      if (source === "history") {
        f.native.page.messages = messages;
        const history = await f.bridge.history("local-native");
        plans = new Map(history.items.filter(item => item.taskPlan).map(item => [item.id, item.taskPlan!]));
        expect(history.items.find(item => item.id === "agent-call")?.subagent).toMatchObject({ agentId: "child-task", state: "running" });
      } else {
        for (const message of messages) await f.message(message);
        plans = new Map(f.eventLog.replay(0).filter(event => event.data.taskPlan).map(event => [event.itemId, event.data.taskPlan]));
        expect(f.eventLog.latestItem("local-native", "tool.progress", "agent-call")?.data.subagent).toMatchObject({ agentId: "child-task", state: "running" });
      }
      expect([...plans.keys()]).toEqual(["plan:parent-plan", "plan:next-plan"]);
      expect(plans.get("plan:parent-plan")).toMatchObject({ id: "parent-plan", items: [{ content: "Read", status: "completed" }, { content: "Verify", status: "in_progress" }] });
      expect(plans.get("plan:next-plan")).toMatchObject({ id: "next-plan", items: planItems });
    } finally { await f.close(); }
  });

  const planMessage = (id: string, input: Record<string, unknown>, timestamp = 1, name = "mcp__ccd_turn__update_plan") => ({ type: "assistant", uuid: id, timestamp, message: { content: [{ type: "tool_use", id, name, input }] } });

  it.each([undefined, "newer-page"])("reads only the requested ordinary history page (cursor=%s)", async cursor => {
    const f = await fixture();
    try {
      if (!cursor) {
        await f.message(planMessage("live-plan", { scope: "first_task", items: [{ content: "Read", status: "in_progress" }] }));
        f.native.contextUsage = { totalTokens: 64_200, rawMaxTokens: 1_000_000 };
      }
      for (let index = 0; index < 18; index += 1) {
        f.native.pages.set(index === 0 ? cursor ?? "" : `ordinary-${index - 1}`, {
          messages: [{ type: "assistant", uuid: `ordinary-${index}`, message: { content: [{ type: "text", text: `Page ${index}` }] } }],
          hasMore: index < 17,
        });
      }

      const controller = createControllerFixture({ broker: f.bridge, eventLog: f.eventLog });
      const page = await controller.handleRequest({
        kind: "request", requestId: "history", idempotencyKey: "history", method: "session.history", params: { sessionId: "local-native", cursor, limit: 1 },
      }, "mobile", "phone");
      expect(page).toMatchObject({ history: { hasMore: true, nextCursor: "ordinary-0", items: [{ id: "ordinary-0", text: "Page 0" }] } });
      if (!cursor) expect(f.bridge.session("local-native")?.contextUsage).toMatchObject({ totalTokens: 64_200, maxTokens: 1_000_000, estimated: false });
      expect(f.native.calls.filter(call => ["getTranscriptPage", "getContextUsage"].includes(call.method))).toEqual([
        { method: "getTranscriptPage", args: ["local-native", cursor ?? "", 1, { window: "accept" }] },
        ...(cursor ? [] : [{ method: "getContextUsage", args: ["local-native"] }]),
      ]);
    } finally { await f.close(); }
  });

  it("keeps session proposal results out of legacy-readable history rows on the same or a newer page", async () => {
    const f = await fixture();
    try {
      const title = "检查日历告警";
      const call = planMessage("calendar-call", { title, initiation: "own_initiative", context: "fork", prompt: "验证旧告警" }, 10, "mcp__ccd_session__start_session");
      const result = { type: "user", uuid: "calendar-result", timestamp: 20, message: { content: [{
        type: "tool_result", tool_use_id: call.uuid, content: `Proposed "${title}" (task_id: task_d6c18845). The user sees a card and nothing runs.`,
      }] } };
      f.native.pages.set("", { messages: [result], hasMore: true });
      f.native.pages.set(result.uuid, { messages: [call], hasMore: false });
      const latest = await f.bridge.history("local-native", undefined, 1);
      expect(latest).toMatchObject({ items: [], sessionProposalResults: [call.uuid], nextCursor: result.uuid, hasMore: true });
      const older = await f.bridge.history("local-native", latest.nextCursor, 1);
      expect(older.items).toMatchObject([{ id: call.uuid, createdAt: 10, text: expect.stringContaining(title), sessionProposal: { title } }]);
      f.native.pages.set("", { messages: [call, result], hasMore: false });
      expect(await f.bridge.history("local-native")).toMatchObject({ items: older.items, sessionProposalResults: [call.uuid] });
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
        { path: "同名上传.pdf", size: 13, isImage: false, file_uuid: "uploaded-file-id" },
        { path: "project-only.pdf", size: 32, isImage: false, project_path: "项目文件夹/project-only.pdf" },
        { path: "upload-failed.md", size: 100, isImage: false, upload_error: "not delivered" },
      ] } };
      const expected = [{ name: "报告.md", path: await realpath(inside) }, { name: "工作区外.md" }, { name: "报告.md" },
        { name: ".env.example" }, { name: "large.apk" }, { name: "同名上传.pdf" }, { name: "project-only.pdf" }];
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

  it("keeps one plan identity when initialization and continuation occupy adjacent native history pages", async () => {
    const f = await fixture();
    try {
      const items = [{ content: "Read", status: "in_progress" }, { content: "Verify", status: "pending" }];
      const initial = planMessage("initial", { scope: "first_task", items }, 10);
      const continuation = planMessage("continuation", { scope: "continuation", items }, 20);
      f.native.page.messages = [initial, continuation];
      f.native.pages.set("", { messages: [continuation], hasMore: true });
      f.native.pages.set("continuation", { messages: [initial], hasMore: false });
      const latest = await f.bridge.history("local-native", undefined, 1);
      expect(latest.nextCursor).toBe("continuation");
      const older = await f.bridge.history("local-native", latest.nextCursor, 1);
      const reloaded = await f.bridge.history("local-native", undefined, 1);
      expect([latest, older, reloaded].map(page => page.items.filter(item => item.taskPlan).map(item => item.id))).toEqual([
        ["plan:initial"], ["plan:initial"], ["plan:initial"],
      ]);
      expect(latest.items.find(item => item.taskPlan)?.taskPlan).toMatchObject({ id: "initial", items });
    } finally { await f.close(); }
  });

  it("keeps identical top-level new_task plans distinct across adjacent native history pages", async () => {
    const f = await fixture();
    try {
      const items = [{ content: "Read", status: "in_progress" }, { content: "Verify", status: "pending" }];
      const initial = planMessage("initial", { scope: "first_task", items }, 10);
      const next = planMessage("next-task", { scope: "new_task", items }, 20);
      f.native.page.messages = [initial, next];
      f.native.pages.set("", { messages: [next], hasMore: true });
      f.native.pages.set("next-task", { messages: [initial], hasMore: false });
      const latest = await f.bridge.history("local-native", undefined, 1);
      const older = await f.bridge.history("local-native", latest.nextCursor, 1);
      expect([older, latest].map(page => page.items.filter(item => item.taskPlan).map(item => ({ id: item.id, planId: item.taskPlan!.id, items: item.taskPlan!.items }))))
        .toEqual([[{ id: "plan:initial", planId: "initial", items }], [{ id: "plan:next-task", planId: "next-task", items }]]);
    } finally { await f.close(); }
  });

  it("continues the loaded history plan with a live replacement list under its original identity", async () => {
    const f = await fixture();
    try {
      const initial = planMessage("history-plan", { scope: "first_task", items: [{ content: "Read", status: "in_progress" }, { content: "Verify", status: "pending" }] }, 10);
      f.native.page.messages = [initial];
      const history = await f.bridge.history("local-native");
      expect(history.items.find(item => item.taskPlan)?.id).toBe("plan:history-plan");
      const items = [{ content: "Read", status: "completed" }, { content: "Verify", status: "in_progress" }];
      await f.message(planMessage("live-continuation", { scope: "continuation", items }, 20));
      expect(f.eventLog.replay(0).filter(event => event.data.taskPlan)).toMatchObject([
        { itemId: "plan:history-plan", data: { taskPlanSource: "native-main", taskPlan: { id: "history-plan", items } } },
      ]);
    } finally { await f.close(); }
  });

  it.each(["advance", "wrap-up"])("applies a live %s to the loaded history plan without another initialization", async action => {
    const f = await fixture();
    try {
      f.native.page.messages = [planMessage("history-plan", { scope: "first_task", items: [{ content: "Read", status: "in_progress" }, { content: "Verify", status: "pending" }] }, 10)];
      const history = await f.bridge.history("local-native");
      expect(history.items.find(item => item.taskPlan)?.id).toBe("plan:history-plan");
      await f.message(action === "advance"
        ? planMessage("live-advance", { advance: true }, 20)
        : planMessage("live-wrap", { recap: "Done" }, 20, "mcp__ccd_turn__wrap_up"));
      expect(f.eventLog.replay(0).filter(event => event.data.taskPlan)).toMatchObject([
        { itemId: "plan:history-plan", data: { taskPlan: { id: "history-plan", items: [
          { content: "Read", status: "completed" },
          { content: "Verify", status: action === "advance" ? "in_progress" : "completed" },
        ] } } },
      ]);
    } finally { await f.close(); }
  });

  it("does not reset a progressed live plan when an older initialization page is loaded", async () => {
    const f = await fixture();
    try {
      const initial = planMessage("live-plan", { scope: "first_task", items: [{ content: "Read", status: "in_progress" }, { content: "Verify", status: "pending" }] }, 10);
      await f.message(initial);
      await f.message(planMessage("first-advance", { advance: true }, 20));
      f.native.pages.set("first-advance", { messages: [initial], hasMore: false });
      await f.bridge.history("local-native", "first-advance", 1);
      await f.message(planMessage("second-advance", { advance: true }, 30));
      expect(f.eventLog.latestItem("local-native", "assistant.completed", "plan:live-plan")?.data.taskPlan).toMatchObject({
        id: "live-plan", items: [{ content: "Read", status: "completed" }, { content: "Verify", status: "completed" }],
      });
    } finally { await f.close(); }
  });

  it("recovers an older history plan on a plain latest page before any live plan is observed", async () => {
    const f = await fixture();
    try {
      const ordinary = { type: "assistant", uuid: "ordinary", timestamp: 20, message: { content: [{ type: "text", text: "Continuing work" }] } };
      await f.message(ordinary);
      f.native.pages.set("", { messages: [ordinary], hasMore: true });
      f.native.pages.set("ordinary", { messages: [planMessage("history-plan", { scope: "first_task", items: [{ content: "Read", status: "in_progress" }, { content: "Verify", status: "pending" }] }, 10)], hasMore: false });
      const history = await f.bridge.history("local-native");
      expect(history.items.map(item => item.id)).toEqual(["ordinary"]);
      expect(f.native.calls.filter(call => call.method === "getTranscriptPage").map(call => call.args[1])).toEqual(["", "ordinary"]);
      await f.message(planMessage("live-advance", { advance: true }, 30));
      expect(f.eventLog.latestItem("local-native", "assistant.completed", "plan:history-plan")?.data.taskPlan).toMatchObject({
        id: "history-plan", items: [{ content: "Read", status: "completed" }, { content: "Verify", status: "in_progress" }],
      });
    } finally { await f.close(); }
  });

  it("does not reset a live plan from an older latest history snapshot", async () => {
    const f = await fixture();
    try {
      const initial = planMessage("live-plan", { scope: "first_task", items: [{ content: "Read", status: "in_progress" }, { content: "Verify", status: "pending" }] }, 10);
      await f.message(initial);
      await f.message(planMessage("first-advance", { advance: true }, 20));
      f.native.page.messages = [initial];
      await f.bridge.history("local-native");
      await f.message(planMessage("second-advance", { advance: true }, 30));
      expect(f.eventLog.latestItem("local-native", "assistant.completed", "plan:live-plan")?.data.taskPlan).toMatchObject({
        id: "live-plan", items: [{ content: "Read", status: "completed" }, { content: "Verify", status: "completed" }],
      });
    } finally { await f.close(); }
  });

  it.each([true, false])("does not resurrect a plan after an observed live wrap-up and a stale history snapshot (live initialization: %s)", async hadInitialization => {
    const f = await fixture();
    try {
      const initial = planMessage("finished-plan", { scope: "first_task", items: [{ content: "Read", status: "in_progress" }, { content: "Verify", status: "pending" }] }, 10);
      if (hadInitialization) await f.message(initial);
      await f.message(planMessage("live-wrap", { recap: "Done" }, 20, "mcp__ccd_turn__wrap_up"));
      const completed = f.eventLog.latestItem("local-native", "assistant.completed", "plan:finished-plan");
      f.native.page.messages = [initial];
      await f.bridge.history("local-native");
      await f.message(planMessage("orphan-advance", { advance: true }, 30));
      expect(f.eventLog.latestItem("local-native", "assistant.completed", "plan:finished-plan")).toEqual(completed);
      expect(f.eventLog.replay(0).filter(event => event.data.taskPlan)).toHaveLength(hadInitialization ? 2 : 0);
    } finally { await f.close(); }
  });

  it.each([undefined, "newer-page"])("restores plan context up to the nearest top-level new_task (cursor=%s)", async cursor => {
    const f = await fixture();
    try {
      const old = planMessage("older-plan", { scope: "first_task", items: [{ content: "Old work", status: "in_progress" }] }, 1);
      const initial = planMessage("current-plan", { scope: "new_task", items: [{ content: "Read", status: "in_progress" }, { content: "Verify", status: "pending" }] }, 10);
      const child = { ...planMessage("child-initial", { scope: "first_task", items: [{ content: "Child", status: "in_progress" }] }, 15), isSidechain: true };
      const continuation = planMessage("continued", { scope: "continuation", items: [{ content: "Read", status: "in_progress" }, { content: "Verify", status: "pending" }] }, 20);
      const text = { type: "assistant", uuid: "latest-text", timestamp: 25, message: { content: [{ type: "text", text: "Visible latest text" }] } };
      const advance = planMessage("latest-advance", { advance: true }, 30);
      f.native.pages.set(cursor ?? "", { messages: [text, advance], hasMore: true });
      f.native.pages.set("latest-text", { messages: [child, continuation], hasMore: true });
      f.native.pages.set("child-initial", { messages: [old, initial], hasMore: true });
      f.native.contextUsage = { totalTokens: 64_200, rawMaxTokens: 1_000_000 };
      const controller = createControllerFixture({ broker: f.bridge, eventLog: f.eventLog });
      const response = await controller.handleRequest({
        kind: "request", requestId: "history", idempotencyKey: "history", method: "session.history", params: { sessionId: "local-native", cursor, limit: 2 },
      }, "mobile", "phone");
      expect(response).toMatchObject({ history: { hasMore: true, nextCursor: "latest-text", items: [
        { id: "latest-text", text: "Visible latest text" },
        { id: "plan:current-plan", taskPlan: { id: "current-plan", items: [{ content: "Read", status: "completed" }, { content: "Verify", status: "in_progress" }] } },
      ] } });
      expect(f.native.calls.filter(call => ["getTranscriptPage", "getContextUsage"].includes(call.method))).toEqual([
        { method: "getTranscriptPage", args: ["local-native", cursor ?? "", 2, { window: "accept" }] },
        { method: "getTranscriptPage", args: ["local-native", "latest-text", 2, { window: "accept" }] },
        { method: "getTranscriptPage", args: ["local-native", "child-initial", 2, { window: "accept" }] },
        ...(cursor ? [] : [{ method: "getContextUsage", args: ["local-native"] }]),
      ]);
      expect(f.native.calls.some(call => call.method === "getTranscript")).toBe(false);
    } finally { await f.close(); }
  });

  it("stops history plan recovery at a preceding wrap-up without reviving its old plan", async () => {
    const f = await fixture();
    try {
      const initial = planMessage("finished-plan", { scope: "first_task", items: [{ content: "Read", status: "in_progress" }] }, 10);
      const wrap = planMessage("historical-wrap", { recap: "Done" }, 20, "mcp__ccd_turn__wrap_up");
      const advance = planMessage("orphan-advance", { advance: true }, 30);
      f.native.pages.set("", { messages: [advance], hasMore: true });
      f.native.pages.set("orphan-advance", { messages: [initial, wrap], hasMore: true });
      const controller = createControllerFixture({ broker: f.bridge, eventLog: f.eventLog });
      const response = await controller.handleRequest({
        kind: "request", requestId: "history", idempotencyKey: "history", method: "session.history", params: { sessionId: "local-native", limit: 1 },
      }, "mobile", "phone");
      expect(response).toMatchObject({ history: { hasMore: true, nextCursor: "orphan-advance", items: [] } });
      expect(f.native.calls.filter(call => call.method === "getTranscriptPage").map(call => call.args[1])).toEqual(["", "orphan-advance"]);
      await f.message(planMessage("later-orphan", { advance: true }, 40));
      expect(f.eventLog.replay(0).filter(event => event.data.taskPlan)).toEqual([]);
    } finally { await f.close(); }
  });

  it("rejects a malformed plan lookback page before querying live context usage", async () => {
    const f = await fixture();
    try {
      f.native.pages.set("", { messages: [planMessage("advance", { advance: true })], hasMore: true });
      f.native.pages.set("advance", { hasMore: true });
      const controller = createControllerFixture({ broker: f.bridge, eventLog: f.eventLog });
      await expect(controller.handleRequest({
        kind: "request", requestId: "history", idempotencyKey: "history", method: "session.history", params: { sessionId: "local-native", limit: 1 },
      }, "mobile", "phone")).rejects.toThrow(new NativeCallError("Desktop returned an invalid transcript page"));
      expect(f.native.calls.filter(call => ["getTranscriptPage", "getContextUsage"].includes(call.method))).toEqual([
        { method: "getTranscriptPage", args: ["local-native", "", 1, { window: "accept" }] },
        { method: "getTranscriptPage", args: ["local-native", "advance", 1, { window: "accept" }] },
      ]);
    } finally { await f.close(); }
  });

  it.each([
    { isSidechain: true, parent_tool_use_id: null },
    { parent_tool_use_id: "agent-call" },
  ])("inherits the main plan across pages containing child plan updates (%j)", async attribution => {
    const f = await fixture();
    try {
      const initial = planMessage("main-plan", { scope: "first_task", items: [{ content: "Read", status: "in_progress" }, { content: "Verify", status: "pending" }] }, 10);
      const recent = [
        { ...planMessage("child-plan", { scope: "new_task", items: [{ content: "Child inspect", status: "in_progress" }] }, 20), ...attribution },
        { ...planMessage("child-continuation", { scope: "continuation", items: [{ content: "Child inspect", status: "completed" }] }, 21), ...attribution },
        planMessage("main-advance", { advance: true }, 30),
      ];
      f.native.page.messages = [initial, ...recent];
      f.native.pages.set("", { messages: recent, hasMore: true });
      f.native.pages.set("child-plan", { messages: [initial], hasMore: false });
      const latest = await f.bridge.history("local-native", undefined, 3);
      expect(latest.nextCursor).toBe("child-plan");
      const older = await f.bridge.history("local-native", latest.nextCursor, 3);
      expect(older.items.filter(item => item.taskPlan).map(item => item.id)).toEqual(["plan:main-plan"]);
      expect(latest.items.filter(item => item.taskPlan)).toMatchObject([
        { id: "plan:main-plan", taskPlan: { id: "main-plan", items: [{ content: "Read", status: "completed" }, { content: "Verify", status: "in_progress" }] } },
      ]);
    } finally { await f.close(); }
  });

  it.each([
    { isCompactSummary: true },
    { isMeta: true },
    { isSynthetic: true },
    { isVisibleInTranscriptOnly: true },
  ])("can page past a wholly internal compact page without dropping identical older user input (%j)", async flags => {
    const f = await fixture();
    try {
      const text = "This session is being continued from a previous conversation that ran out of context.\n\nSummary:\nFixture context.";
      const typed = { type: "user", uuid: "typed-before-compact", message: { role: "user", content: text } };
      const hidden = { type: "user", uuid: "hidden-summary", ...flags, message: { role: "user", content: text } };
      const boundary = { type: "system", uuid: "compact-boundary", subtype: "compact_boundary" };
      f.native.page.messages = [typed, hidden, boundary];
      f.native.pages.set("", { messages: [hidden, boundary], hasMore: true });
      f.native.pages.set("hidden-summary", { messages: [typed], hasMore: false });
      const latest = await f.bridge.history("local-native", undefined, 2);
      expect(latest).toMatchObject({ items: [], hasMore: true, nextCursor: "hidden-summary" });
      const older = await f.bridge.history("local-native", latest.nextCursor, 2);
      expect(older).toMatchObject({ hasMore: false, items: [{ id: "typed-before-compact", role: "user", text }] });
      expect(older.nextCursor).toBeUndefined();
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

  it("projects a permission stream event as waiting immediately and ignores unknown sessions", async () => {
    const f = await fixture();
    try {
      const permission = { requestId: "stream-permission", sessionId: "local-native", toolName: "Bash", input: { command: "pwd" } };
      f.native.emit("permission", { ...permission, requestId: "foreign", sessionId: "unknown-native" });
      expect(f.bridge.permissionsList()).toEqual([]);
      f.native.emit("permission", permission);
      expect(f.bridge.permissionsList()).toMatchObject([{ requestId: "stream-permission", sessionId: "local-native" }]);
      expect(f.bridge.session("local-native")?.turnState).toBe("waiting");
      expect(f.native.calls.some(call => call.method === "respondToToolPermission")).toBe(false);
    } finally { await f.close(); }
  });

  it("resolves only the native request ID that was selected", async () => {
    const f = await fixture();
    try {
      f.native.sessions[0]!.pendingToolPermissions = [{ requestId: "first", sessionId: "local-native", toolName: "Bash", input: {} }];
      f.native.sessions.push({ ...f.native.sessions[0], sessionId: "other-native", pendingToolPermissions: [{ requestId: "other", sessionId: "other-native", toolName: "Bash", input: {} }] });
      await f.bridge.refreshRuntime();
      expect(await f.bridge.resolvePermission("missing", "allow-once")).toBe(false);
      expect(f.native.calls.some(call => call.method === "respondToToolPermission")).toBe(false);
      expect(await f.bridge.resolvePermission("first", "allow-once")).toBe(true);
      expect(f.bridge.permissionsList().map(permission => permission.requestId)).toEqual(["other"]);
      expect(f.bridge.session("other-native")?.turnState).toBe("waiting");
      expect(f.eventLog.replay(0).filter(event => event.type === "permission.resolved").map(event => event.data.requestId)).toEqual(["first"]);
    } finally { await f.close(); }
  });

  it("does not report permission resolution while Desktop still lists the request", async () => {
    const f = await fixture();
    try {
      f.native.sessions[0]!.pendingToolPermissions = [{ requestId: "pending", sessionId: "local-native", toolName: "Bash", input: {} }];
      await f.bridge.refreshRuntime();
      const original = f.native.call.bind(f.native);
      vi.spyOn(f.native, "call").mockImplementation((method, args) => method === "respondToToolPermission" ? Promise.resolve(undefined) : original(method, args));
      expect(await f.bridge.resolvePermission("pending", "allow-once")).toBe(false);
      expect(f.bridge.permissionsList()).toHaveLength(1);
      expect(f.eventLog.replay(0).some(event => event.type === "permission.resolved")).toBe(false);
    } finally { await f.close(); }
  });

  it("does not let the passive permission diff preempt a manual resolution", async () => {
    const f = await fixture();
    try {
      f.native.sessions[0]!.pendingToolPermissions = [{ requestId: "manual-permission", sessionId: "local-native", toolName: "Bash", input: {} }];
      await f.bridge.refreshRuntime();
      const controller = createControllerFixture({ broker: f.bridge, eventLog: f.eventLog });
      await controller.publishPermissions();
      const passive: Array<Promise<void>> = [];
      f.bridge.on("changed", () => { passive.push(controller.publishPermissions()); });
      expect(await f.bridge.resolvePermission("manual-permission", "allow-once", undefined, undefined, { deviceId: "phone-1", name: "Phone" })).toBe(true);
      await Promise.all(passive);
      const resolved = f.eventLog.replay().filter(event => event.type === "permission.resolved" && event.data.requestId === "manual-permission");
      expect(resolved.map(event => event.data)).toEqual([expect.objectContaining({
        requestId: "manual-permission", decision: "allow-once", resolvedByDeviceId: "phone-1", resolvedByName: "Phone",
      })]);
    } finally { await f.close(); }
  });

  it("does not use event replay as native history after disconnection", async () => {
    const f = await fixture();
    try {
      await f.message({ type: "assistant", uuid: "local-event", message: { content: "Only in the event log" } });
      f.native.ready = false;
      await expect(f.bridge.history("local-native")).rejects.toBeInstanceOf(InspectorDisconnectedError);
      expect(f.native.calls.some(call => call.method === "getTranscriptPage")).toBe(false);
    } finally { await f.close(); }
  });

  it.each([undefined, "older-page"])("updates a history-loaded native question when its live tool result arrives (cursor=%s)", async cursor => {
    const f = await fixture();
    try {
      f.native.page = { hasMore: false, messages: [{ type: "assistant", uuid: "question", timestamp: 10, message: { id: "question-body", content: [
        { type: "text", text: "选择接下来的检查" },
        { type: "tool_use", id: "ask", name: "AskUserQuestion", input: { questions: [{ question: "检查哪些？", multiSelect: true, options: [{ label: "稍后处理" }, { label: "类型检查" }, { label: "回归测试" }] }] } },
      ] } }] };
      await f.bridge.history("local-native", cursor);
      await f.message({ type: "user", uuid: "answer", timestamp: 20, toolUseResult: { answers: { "检查哪些？": "类型检查, 回归测试" } }, message: { content: [
        { type: "tool_result", tool_use_id: "ask", content: "User has answered your questions." },
      ] } });
      expect(f.eventLog.replay().find(event => event.type === "assistant.completed" && event.itemId === "question-body")?.data).toMatchObject({
        text: "选择接下来的检查", interactivePrompt: { kind: "question", answered: true, toolUseId: "ask", questions: [{
          answer: "类型检查, 回归测试", options: [{ label: "稍后处理" }, { label: "类型检查", selected: true }, { label: "回归测试", selected: true }],
        }] },
      });
    } finally { await f.close(); }
  });

  it.each([1, 2])("restores split-page answers on repeated cursor reads (%i clients)", async clients => {
    const f = await fixture();
    try {
      f.native.page = { hasMore: true, messages: [{ type: "user", uuid: "answer", timestamp: 20,
        toolUseResult: { answers: { "检查哪些？": "类型检查, 回归测试" } },
        message: { content: [{ type: "tool_result", tool_use_id: "ask", content: "User has answered your questions." }] },
      }] };
      f.native.pages.set("answer", { hasMore: false, messages: [{ type: "assistant", uuid: "question", timestamp: 10, message: { content: [
        { type: "tool_use", id: "ask", name: "AskUserQuestion", input: { questions: [{ question: "检查哪些？", multiSelect: true, options: [{ label: "稍后处理" }, { label: "类型检查" }, { label: "回归测试" }] }] } },
      ] } }] });
      const latest = await f.bridge.history("local-native");
      const second = clients === 2 ? await f.bridge.history("local-native") : latest;
      for (const cursor of [latest.nextCursor, second.nextCursor]) {
        const older = await f.bridge.history("local-native", cursor);
        expect(older.items.find(item => item.id === "question")?.interactivePrompt).toMatchObject({ answered: true, questions: [{
          answer: "类型检查, 回归测试", options: [{ label: "稍后处理" }, { label: "类型检查", selected: true }, { label: "回归测试", selected: true }],
        }] });
      }
    } finally { await f.close(); }
  });

  it("filters control messages and preserves native question cards", () => {
    const items = nativeHistoryItems("native", [{ type: "user", uuid: "hidden", message: { content: "[Request interrupted by user]" } }, { type: "assistant", uuid: "question", message: { content: [{ type: "tool_use", id: "ask", name: "AskUserQuestion", input: { questions: [{ question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] }] } }] } }]);
    expect(items.some(item => item.text.includes("Request interrupted"))).toBe(false);
    expect(items.find(item => item.interactivePrompt)?.interactivePrompt?.kind).toBe("question");
  });

  it.each([
    ["claude-sonnet-4-5", true],
    ["default", true],
    ["mythos-magpie-5277472942", true],
    ["default", false],
  ] as const)("reads the requested history page before the only live usage query (native model: %s, usage available: %s)", async (model, usageAvailable) => {
    const f = await fixture();
    try {
      f.native.sessions[0]!.model = model;
      f.native.sessions[0]!.turnRunning = true;
      f.native.contextUsage = usageAvailable ? { totalTokens: 98_000, rawMaxTokens: 196_000 } : null;
      f.native.page = { hasMore: false, messages: [{
        type: "assistant", uuid: "latest", message: { model: "claude-sonnet-4-5", content: "Latest response" },
      }] };
      const controller = createControllerFixture({ broker: f.bridge, eventLog: f.eventLog });
      f.native.calls.length = 0;

      const opened = await controller.handleRequest({
        kind: "request", requestId: "open", idempotencyKey: "open", method: "session.open", params: { sessionId: "local-native", limit: 7 },
      }, "mobile", "phone");

      expect(opened).toMatchObject({
        history: { items: [{ id: "latest", text: "Latest response" }], hasMore: false },
        session: {
          model: model === "default" ? "claude-sonnet-4-5" : model,
          modelDisplayName: "Claude Sonnet 4.5",
          ...(usageAvailable ? { contextUsage: { totalTokens: 98_000, maxTokens: 196_000, percentage: 50, estimated: false } } : {}),
        },
      });
      if (!usageAvailable) expect(opened).not.toHaveProperty("session.contextUsage");
      expect(f.native.calls.filter(call => ["getTranscriptPage", "getContextUsage"].includes(call.method))).toEqual([
        { method: "getTranscriptPage", args: ["local-native", "", 7, { window: "accept" }] },
        { method: "getContextUsage", args: ["local-native"] },
      ]);
    } finally { await f.close(); }
  });

  it("opens a running session with an estimate when Native lacks realtime usage", async () => {
    const f = await fixture();
    try {
      const model = "claude-sonnet-4-5";
      f.native.sessions[0]!.model = model;
      f.native.sessions[0]!.turnRunning = true;
      f.native.unsupported.add("getContextUsage");
      f.native.page = { hasMore: false, messages: [{
        type: "assistant", uuid: "only-reply", message: { model, content: "Only reply", usage: { input_tokens: 12_000, output_tokens: 400 } },
      }] };
      const controller = createControllerFixture({ broker: f.bridge, eventLog: f.eventLog });
      f.native.calls.length = 0;

      expect(await controller.dispatchLocal({ method: "session.open", params: { sessionId: "local-native" } })).toMatchObject({
        ok: true, result: {
          history: { hasMore: false, items: [{ id: "only-reply", text: "Only reply" }] },
          session: { contextUsage: { model, totalTokens: 12_400, estimated: true } },
        },
      });
      expect(f.native.calls.filter(call => ["getTranscriptPage", "getContextUsage"].includes(call.method))).toEqual([
        { method: "getTranscriptPage", args: ["local-native", "", 18, { window: "accept" }] },
      ]);
    } finally { await f.close(); }
  });

  it.each([
    { hold: "older page", compact: false },
    { hold: "empty live usage", compact: false },
    { hold: "older page", compact: true },
  ])("keeps a newer live usage sample with a delayed $hold (compacted: $compact)", async ({ hold, compact }) => {
    const f = await fixture();
    try {
      const model = "claude-sonnet-4-5";
      f.native.sessions[0]!.model = "default";
      f.native.sessions[0]!.turnRunning = true;
      await f.bridge.refreshRuntime();
      await f.message(planMessage("live-wrap", { recap: "Done" }, 20, "mcp__ccd_turn__wrap_up"));
      f.native.page = { hasMore: true, messages: [{ type: "user", uuid: "latest", message: { content: "Latest request" } }] };
      f.native.calls.length = 0;
      const older = {
        type: "assistant", uuid: "older", message: { model, content: "Earlier reply", usage: { input_tokens: 12_000, output_tokens: 400 } },
      };
      f.native.pages.set("latest", { hasMore: false, messages: [older, ...(compact ? [{
        type: "system", subtype: "compact_boundary", uuid: "compact",
        compactMetadata: { postTokens: 9_200, preservedSegment: { tailUuid: older.uuid } },
      }] : [])] });
      let markFirstReadPending!: () => void;
      const firstReadPending = new Promise<void>(resolve => { markFirstReadPending = resolve; });
      let releaseFirstRead!: () => void;
      const firstReadReleased = new Promise<void>(resolve => { releaseFirstRead = resolve; });
      const call = f.native.call.bind(f.native);
      vi.spyOn(f.native, "call").mockImplementation(async (method, args = []) => {
        const pause = hold === "older page"
          ? method === "getTranscriptPage" && args[1] === "latest"
          : method === "getContextUsage" && f.native.contextUsage === null;
        const result = call(method, args);
        if (pause) {
          markFirstReadPending();
          await firstReadReleased;
        }
        return result;
      });
      const controller = createControllerFixture({ broker: f.bridge, eventLog: f.eventLog });
      const first = controller.dispatchLocal({ method: "session.open", params: { sessionId: "local-native" } });
      await firstReadPending;
      f.native.contextUsage = { totalTokens: 64_200, rawMaxTokens: 1_000_000 };
      const second = await controller.dispatchLocal({ method: "session.open", params: { sessionId: "local-native" } });
      releaseFirstRead();
      const firstResult = await first;

      const live = { totalTokens: 64_200, maxTokens: 1_000_000, estimated: false };
      expect(second).toMatchObject({ ok: true, result: { session: { contextUsage: live } } });
      expect(firstResult).toMatchObject({
        ok: true,
        result: { history: { items: [{ id: "latest" }], hasMore: true, nextCursor: "latest" } },
      });
      expect({ firstResult, projected: f.bridge.session("local-native")?.contextUsage }).toMatchObject({
        firstResult: { ok: true, result: { session: { model, contextUsage: live } } }, projected: live,
      });
      expect(f.native.calls.filter(call => call.method === "getTranscriptPage").map(call => call.args.slice(1, 3))).toEqual(
        hold === "older page" ? [["", 18], ["latest", 100], ["", 18], ["", 20]] : [["", 18], ["", 18], ["", 20], ["latest", 100]],
      );
      if (compact) {
        await f.message(older);
        expect(f.bridge.session("local-native")?.contextUsage).toMatchObject(live);
      }
    } finally { await f.close(); }
  });

  it("keeps the live usage from the second concurrent open when both native replies arrive together", async () => {
    const f = await fixture();
    try {
      f.native.sessions[0]!.model = "claude-sonnet-4-5";
      f.native.page = { hasMore: false, messages: [{
        type: "assistant", uuid: "latest", message: { model: "claude-sonnet-4-5", content: "Latest response", usage: { input_tokens: 12_000, output_tokens: 400 } },
      }] };
      const usageReplies: Array<(value: unknown) => void> = [];
      let bothUsageCallsPending!: () => void;
      const usageCallsPending = new Promise<void>(resolve => { bothUsageCallsPending = resolve; });
      const call = f.native.call.bind(f.native);
      vi.spyOn(f.native, "call").mockImplementation((method, args = []) => {
        if (method !== "getContextUsage") return call(method, args);
        f.native.calls.push({ method, args });
        return new Promise(resolve => {
          usageReplies.push(resolve);
          if (usageReplies.length === 2) bothUsageCallsPending();
        });
      });
      const controller = createControllerFixture({ broker: f.bridge, eventLog: f.eventLog });
      const opens = ["phone-a", "phone-b"].map(phone => controller.handleRequest({
        kind: "request", requestId: phone, idempotencyKey: phone, method: "session.open", params: { sessionId: "local-native" },
      }, "mobile", phone));

      await usageCallsPending;
      usageReplies[0]!(null);
      usageReplies[1]!({ totalTokens: 64_200, rawMaxTokens: 1_000_000 });
      await Promise.all(opens);

      expect(f.bridge.session("local-native")?.contextUsage).toMatchObject({ totalTokens: 64_200, maxTokens: 1_000_000, estimated: false });
      expect(f.native.calls.filter(call => call.method === "getTranscriptPage").map(call => call.args[1])).toEqual(["", ""]);
    } finally { await f.close(); }
  });

  it.each([
    { hasMore: false, count: 1, limit: 50 },
    { hasMore: true, count: 20, limit: 30 },
  ])("skips a model tail already covered by the requested page ($count messages, hasMore=$hasMore)", async ({ hasMore, count, limit }) => {
    const f = await fixture();
    try {
      f.native.sessions[0]!.model = "default";
      f.native.sessions[0]!.turnRunning = true;
      f.native.contextUsage = { totalTokens: 98_000, rawMaxTokens: 196_000 };
      await f.bridge.refreshRuntime();
      await f.message(planMessage("live-wrap", { recap: "Done" }, 20, "mcp__ccd_turn__wrap_up"));
      f.native.page = { hasMore, messages: Array.from({ length: count }, (_, index) => ({
        type: "user", uuid: `request-${index}`, message: { content: `Request ${index}` },
      })) };
      const controller = createControllerFixture({ broker: f.bridge, eventLog: f.eventLog });
      f.native.calls.length = 0;

      const opened = await controller.handleRequest({
        kind: "request", requestId: "open", idempotencyKey: "open", method: "session.open", params: { sessionId: "local-native", limit },
      }, "mobile", "phone");

      expect(opened).toMatchObject({
        history: { hasMore, ...(hasMore ? { nextCursor: "request-0" } : {}) },
        session: { contextUsage: { totalTokens: 98_000, maxTokens: 196_000, percentage: 50, estimated: false } },
      });
      expect(opened).toHaveProperty("history.items.length", count);
      expect(f.native.calls.filter(call => ["getTranscriptPage", "getContextUsage"].includes(call.method))).toEqual([
        { method: "getTranscriptPage", args: ["local-native", "", limit, { window: "accept" }] },
        { method: "getContextUsage", args: ["local-native"] },
      ]);
    } finally { await f.close(); }
  });

  it.each(["available", "unavailable"])("only checks the model tail after opening a page without model hints (%s tail)", async tail => {
    const f = await fixture();
    try {
      f.native.sessions[0]!.model = "default";
      f.native.sessions[0]!.turnRunning = true;
      f.native.contextUsage = { totalTokens: 98_000, rawMaxTokens: 196_000 };
      await f.bridge.refreshRuntime();
      await f.message(planMessage("live-wrap", { recap: "Done" }, 20, "mcp__ccd_turn__wrap_up"));
      const newest = { type: "user", uuid: "latest", message: { content: "Latest request" } };
      f.native.page = { messages: [newest], hasMore: true };
      const call = f.native.call.bind(f.native);
      vi.spyOn(f.native, "call").mockImplementation(async (method, args) => {
        const result = await call(method, args);
        if (method !== "getTranscriptPage" || args?.[2] !== 20) return result;
        if (tail === "unavailable") throw new NativeCallError("Model tail unavailable");
        return { messages: [
          { type: "assistant", uuid: "older", message: { model: "claude-sonnet-4-5", content: "Earlier response" } }, newest,
        ], hasMore: false };
      });
      const controller = createControllerFixture({ broker: f.bridge, eventLog: f.eventLog });
      f.native.calls.length = 0;

      const opened = await controller.handleRequest({
        kind: "request", requestId: "open", idempotencyKey: "open", method: "session.open", params: { sessionId: "local-native", limit: 1 },
      }, "mobile", "phone");

      expect(opened).toMatchObject({
        history: { items: [{ id: "latest", text: "Latest request" }], hasMore: true, nextCursor: "latest" },
        session: { contextUsage: { totalTokens: 98_000, maxTokens: 196_000, percentage: 50, estimated: false } },
      });
      if (tail === "available") expect(opened).toHaveProperty("session.model", "claude-sonnet-4-5");
      expect(f.native.calls.filter(call => ["getTranscriptPage", "getContextUsage"].includes(call.method))).toEqual([
        { method: "getTranscriptPage", args: ["local-native", "", 1, { window: "accept" }] },
        { method: "getContextUsage", args: ["local-native"] },
        { method: "getTranscriptPage", args: ["local-native", "", 20, { window: "accept" }] },
      ]);
    } finally { await f.close(); }
  });

  it("reads live context usage for standalone session settings", async () => {
    const f = await fixture();
    try {
      f.native.sessions[0]!.model = "claude-opus-5-5";
      f.native.sessions[0]!.turnRunning = true;
      f.native.contextUsage = { totalTokens: 64_200, rawMaxTokens: 1_000_000 };
      const controller = createControllerFixture({ broker: f.bridge, eventLog: f.eventLog });
      f.native.calls.length = 0;

      const settings = await controller.handleRequest({
        kind: "request", requestId: "configuration", idempotencyKey: "configuration", method: "session.configuration", params: { sessionId: "local-native" },
      }, "mobile", "phone");

      const context = { totalTokens: 64_200, maxTokens: 1_000_000, percentage: 6.4, model: "claude-opus-5-5", estimated: false };
      expect(settings).toMatchObject({ configuration: { context }, session: { contextUsage: context } });
      expect(f.native.calls.filter(call => ["getTranscriptPage", "getContextUsage"].includes(call.method))).toEqual([
        { method: "getContextUsage", args: ["local-native"] },
      ]);
    } finally { await f.close(); }
  });

  it.each([
    { source: "the plan page", usagePage: 0, reads: 0 },
    { source: "a malformed estimate page", usagePage: null, reads: 1 },
    { source: "the eighth estimate page", usagePage: 8, reads: 8 },
    { source: "the unread ninth estimate page", usagePage: 9, reads: 8 },
  ])("preserves the history cursor and bounds context lookback with $source", async ({ usagePage, reads }) => {
    const f = await fixture();
    try {
      const model = "claude-sonnet-4-5";
      f.native.sessions[0]!.model = model;
      const usage = { id: "main-turn", model, usage: { input_tokens: 12_000, output_tokens: 400 } };
      const plan = planMessage("plan", { scope: "first_task", items: [{ content: "Read", status: "in_progress" }] }, 10);
      f.native.pages.set("", { hasMore: true, messages: [
        ...Array.from({ length: 19 }, (_, index) => ({ type: "user", uuid: `hidden-${index}`, isMeta: true })),
        planMessage("advance", { advance: true }, 20),
      ] });
      f.native.pages.set("hidden-0", { hasMore: true, messages: [
        { type: "assistant", uuid: "older-0", message: { ...(usagePage === 0 ? usage : {}), content: "Older plan page text" } },
        plan,
      ] });
      for (let index = 0; index < 9; index += 1) {
        f.native.pages.set(`older-${index}`, usagePage === null && index === 0 ? { hasMore: true } : {
          hasMore: true,
          messages: [{
            type: "assistant", uuid: `older-${index + 1}`,
            message: { ...(usagePage === index + 1 ? usage : {}), content: `Older estimate page ${index + 1} text` },
          }],
        });
      }

      const controller = createControllerFixture({ broker: f.bridge, eventLog: f.eventLog });
      const response = await controller.handleRequest({
        kind: "request", requestId: "open", idempotencyKey: "open", method: "session.open", params: { sessionId: "local-native", limit: 20 },
      }, "mobile", "phone");
      expect(response).toMatchObject({ history: { hasMore: true, nextCursor: "hidden-0", items: [
        { id: "plan:plan", taskPlan: { items: [{ content: "Read", status: "completed" }] } },
      ] } });
      if (usagePage === 0 || usagePage === 8) {
        expect(response).toMatchObject({ session: { contextUsage: { totalTokens: 12_400, model, estimated: true } } });
      } else {
        expect(response).not.toHaveProperty("session.contextUsage");
      }
      expect(f.native.calls.filter(call => ["getTranscriptPage", "getContextUsage"].includes(call.method))).toEqual([
        { method: "getTranscriptPage", args: ["local-native", "", 20, { window: "accept" }] },
        { method: "getTranscriptPage", args: ["local-native", "hidden-0", 20, { window: "accept" }] },
        { method: "getContextUsage", args: ["local-native"] },
        ...Array.from({ length: reads }, (_, index) => ({ method: "getTranscriptPage", args: ["local-native", `older-${index}`, 100, { window: "accept" }] })),
      ]);
    } finally { await f.close(); }
  });

  it("prioritizes live getContextUsage and falls back to single-turn main-chain transcript usage across known, [1m], and unknown models", async () => {
    const f = await fixture();
    try {
      expect(f.bridge.session("local-native")?.contextUsage).toBeUndefined();

      f.native.sessions[0]!.model = "claude-opus-5-5";
      f.native.contextUsage = { totalTokens: 64_200, rawMaxTokens: 1_000_000, model: "claude-opus-5-5" };
      f.native.page = {
        messages: [{
          type: "assistant",
          uuid: "older-turn",
          message: { id: "msg_1", model: "claude-opus-5-5", content: "hi", usage: { input_tokens: 12_000, output_tokens: 400 } },
        }],
        hasMore: false,
      };
      const controller = createControllerFixture({ broker: f.bridge, eventLog: f.eventLog });
      const openedLive = await controller.handleRequest({
        kind: "request", requestId: "open-live", idempotencyKey: "open-live", method: "session.open", params: { sessionId: "local-native" },
      }, "mobile", "phone");
      expect(openedLive).toHaveProperty("session.contextUsage", {
        totalTokens: 64_200,
        maxTokens: 1_000_000,
        percentage: 6.4,
        model: "claude-opus-5-5",
        estimated: false,
      });

      // With the live plan settled and no live usage, find main-chain usage behind a full sidechain page.
      f.native.contextUsage = null;
      f.native.sessions[0]!.model = "claude-sonnet-4-5";
      f.native.sessions[0]!.turnRunning = true;
      await f.bridge.refreshRuntime();
      await f.message(planMessage("live-wrap", { recap: "Done" }, 20, "mcp__ccd_turn__wrap_up"));
      f.native.calls.length = 0;
      const trailingSidechains = Array.from({ length: 18 }, (_, index) => ({
        type: "assistant",
        uuid: `side-${index}`,
        isSidechain: true,
        message: { id: `sub_${index}`, model: "claude-haiku-4-5", content: "sub", usage: { input_tokens: 150_000, output_tokens: 1_000 } },
      }));
      f.native.pages.set("", { messages: trailingSidechains, hasMore: true });
      f.native.pages.set("side-0", {
        messages: [
          { type: "assistant", uuid: "main-1", message: { id: "m1", model: "claude-sonnet-4-5", content: "first", usage: { input_tokens: 18_000, output_tokens: 500 } } },
          { type: "assistant", uuid: "main-2", message: { id: "m2", model: "claude-sonnet-4-5", content: "second", usage: { input_tokens: 10_000, cache_read_input_tokens: 30_000, output_tokens: 800 } } },
        ],
        hasMore: false,
      });
      const openedEstimated = await controller.handleRequest({
        kind: "request", requestId: "open-estimated", idempotencyKey: "open-estimated", method: "session.open", params: { sessionId: "local-native" },
      }, "mobile", "phone");
      expect(f.native.calls.filter(call => ["getTranscriptPage", "getContextUsage"].includes(call.method))).toEqual([
        { method: "getTranscriptPage", args: ["local-native", "", 18, { window: "accept" }] },
        { method: "getContextUsage", args: ["local-native"] },
        { method: "getTranscriptPage", args: ["local-native", "side-0", 100, { window: "accept" }] },
      ]);
      expect(openedEstimated).toHaveProperty("session.contextUsage", {
        totalTokens: 40_800,
        maxTokens: 200_000,
        percentage: 20.4,
        model: "claude-sonnet-4-5",
        estimated: true,
      });

      // Explicit [1m] suffix upgrades capacity to 1,000,000; custom third-party model omits unknown capacity.
      f.native.codeModels = ["claude-sonnet-4-5[1m]", "antigravity/gemini-3-pro"];
      await f.bridge.configureSession({ sessionId: "local-native", model: "claude-sonnet-4-5[1m]" });
      expect(f.bridge.session("local-native")?.contextUsage).toMatchObject({
        totalTokens: 40_800,
        maxTokens: 1_000_000,
        percentage: 4.1,
      });

      await f.bridge.configureSession({ sessionId: "local-native", model: "antigravity/gemini-3-pro" });
      expect(f.bridge.session("local-native")?.contextUsage).toEqual({
        totalTokens: 40_800,
        model: "antigravity/gemini-3-pro",
        estimated: true,
      });
    } finally { await f.close(); }
  });

  it("projects native compaction status until the native status clears", async () => {
    const f = await fixture();
    try {
      f.native.sessions[0]!.turnRunning = true;
      await f.bridge.refreshRuntime();
      await f.message({ type: "system", subtype: "status", status: "compacting" });
      expect(f.bridge.session("local-native")).toMatchObject({ turnState: "running", isCompacting: true });
      await f.bridge.refreshRuntime();
      expect(f.bridge.session("local-native")).toMatchObject({ isCompacting: true });
      await f.message({ type: "system", subtype: "status", status: null, compact_result: "success" });
      expect(f.bridge.session("local-native")).not.toHaveProperty("isCompacting");
    } finally { await f.close(); }
  });

  it("preserves main compaction after a local synthetic result", async () => {
    const f = await fixture();
    try {
      f.native.sessions[0]!.turnRunning = true;
      await f.bridge.refreshRuntime();
      await f.message({ type: "system", subtype: "status", status: "compacting" });
      await f.message({ type: "result", subtype: "success", uuid: "color-command-result", parent_tool_use_id: null, isSyntheticResult: true, result: "Session color set to red" });
      await f.bridge.refreshRuntime();
      expect(f.bridge.session("local-native")).toMatchObject({ turnState: "running", isCompacting: true });
    } finally { await f.close(); }
  });

  it("preserves newer compaction status while an older idle snapshot is in flight", async () => {
    const f = await fixture();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    try {
      let markSnapshotCaptured!: () => void;
      const snapshotCaptured = new Promise<void>(resolve => { markSnapshotCaptured = resolve; });
      Object.assign(f.native, { async sections() { markSnapshotCaptured(); await gate; } });
      const staleRefresh = f.bridge.refreshRuntime();
      await snapshotCaptured;
      f.native.sessions[0]!.turnRunning = true;
      f.native.emit("event", { type: "session_updated", sessionId: "local-native", session: structuredClone(f.native.sessions[0]) });
      const compacting = f.message({ type: "system", subtype: "status", status: "compacting" });
      release();
      await staleRefresh;
      await compacting;
      await vi.waitFor(() => expect(f.bridge.session("local-native")?.turnState).toBe("running"));
      expect(f.bridge.session("local-native")).toMatchObject({ isCompacting: true });
    } finally { release(); await f.close(); }
  });

  it("discards unconfirmed compaction after an inspector reconnect", async () => {
    const f = await fixture();
    try {
      f.native.sessions[0]!.turnRunning = true;
      await f.bridge.refreshRuntime();
      await f.message({ type: "system", subtype: "status", status: "compacting" });
      f.native.ready = false;
      f.native.emit("disconnected");
      // Native finishes compaction while disconnected, then continues generating.
      await f.bridge.refreshRuntime();
      expect(f.bridge.session("local-native")?.turnState).toBe("running");
      expect(f.bridge.session("local-native")).not.toHaveProperty("isCompacting");
      await f.message({ type: "system", subtype: "status", status: "compacting" });
      expect(f.bridge.session("local-native")).toMatchObject({ isCompacting: true });
    } finally { await f.close(); }
  });

  it.each([
    { parent_tool_use_id: "child-tool" },
    { isSidechain: true },
  ])("ignores subagent compaction status (%j)", async attribution => {
    const f = await fixture();
    try {
      f.native.sessions[0]!.turnRunning = true;
      await f.bridge.refreshRuntime();
      await f.message({ type: "system", subtype: "status", status: "compacting", ...attribution });
      expect(f.bridge.session("local-native")).not.toHaveProperty("isCompacting");
      await f.message({ type: "system", subtype: "status", status: "compacting" });
      await f.message({ type: "system", subtype: "status", status: null, ...attribution });
      expect(f.bridge.session("local-native")).toMatchObject({ isCompacting: true });
      await f.message({ type: "result", uuid: "child-result", ...attribution });
      expect(f.bridge.session("local-native")).toMatchObject({ isCompacting: true });
    } finally { await f.close(); }
  });

  it.each([
    { type: "system", subtype: "compact_boundary", uuid: "compact-done" },
    { type: "result", uuid: "compact-result", is_error: true },
  ])("clears compaction on native completion (%j)", async message => {
    const f = await fixture();
    try {
      f.native.sessions[0]!.turnRunning = true;
      await f.bridge.refreshRuntime();
      await f.message({ type: "system", subtype: "status", status: "compacting" });
      expect(f.bridge.session("local-native")).toMatchObject({ isCompacting: true });
      await f.message(message);
      expect(f.bridge.session("local-native")).not.toHaveProperty("isCompacting");
    } finally { await f.close(); }
  });

  it("clears compaction when Native reports the main turn idle", async () => {
    const f = await fixture();
    try {
      f.native.sessions[0]!.turnRunning = true;
      await f.bridge.refreshRuntime();
      await f.message({ type: "system", subtype: "status", status: "compacting" });
      expect(f.bridge.session("local-native")).toMatchObject({ isCompacting: true });
      f.native.sessions[0]!.turnRunning = false;
      await f.bridge.refreshRuntime();
      f.native.sessions[0]!.turnRunning = true;
      await f.bridge.refreshRuntime();
      expect(f.bridge.session("local-native")).not.toHaveProperty("isCompacting");
    } finally { await f.close(); }
  });

  it("retains a gateway window across assistant usage and history reloads, but changes it with the selected model", async () => {
    const f = await fixture();
    try {
      const model = "deepseek/deepseek[1m]";
      const alias = `mythos-magpie-${magpieModelIdHash("deepseek/deepseek")}[1m]`;
      const settings = { modelPicker: { options: [{ model, label: "DeepSeek" }] } };
      await writeFile(f.options.settingsPath, JSON.stringify(settings));
      f.native.sessions[0]!.model = alias;
      f.native.contextUsage = { totalTokens: 158_000, rawMaxTokens: 272_000, model: "deepseek" };
      await f.bridge.configuration("local-native");
      await f.bridge.history("local-native");
      expect(f.bridge.session("local-native")?.contextUsage?.maxTokens).toBe(272_000);

      const assistant = { type: "assistant", uuid: "next-context", message: { id: "next-context", model: "deepseek", content: "Next turn", usage: { input_tokens: 160_000, output_tokens: 100 } } };
      await f.message(assistant);
      expect(f.bridge.session("local-native")?.contextUsage).toMatchObject({ totalTokens: 160_100, maxTokens: 272_000, estimated: true });
      await f.message({ type: "result", modelUsage: { deepseek: { contextWindow: 272_000 } } });
      f.native.contextUsage = null;
      f.native.page = { messages: [assistant], hasMore: false };
      await f.bridge.history("local-native");
      expect(f.bridge.session("local-native")?.contextUsage).toMatchObject({ totalTokens: 160_100, maxTokens: 272_000 });
      await writeFile(f.options.settingsPath, JSON.stringify({ modelPicker: { options: [] } }));
      await f.bridge.refreshRuntime();
      expect(f.bridge.session("local-native")?.contextUsage?.maxTokens).toBe(272_000);
      await writeFile(f.options.settingsPath, JSON.stringify(settings));
      await f.bridge.refreshRuntime();
      expect(f.bridge.session("local-native")?.contextUsage?.maxTokens).toBe(272_000);

      f.native.sessions[0]!.model = "claude-sonnet-4-5";
      await f.bridge.refreshRuntime();
      expect(f.bridge.session("local-native")?.contextUsage?.maxTokens).toBe(200_000);
      f.native.contextUsage = { totalTokens: 160_100, rawMaxTokens: 196_000, model: "claude-sonnet-4-5" };
      await f.bridge.history("local-native");
      expect(f.bridge.session("local-native")?.contextUsage?.maxTokens).toBe(196_000);
      f.native.contextUsage = null;
      await f.bridge.configureSession({ sessionId: "local-native", model });
      expect(f.bridge.session("local-native")?.contextUsage?.maxTokens).toBe(272_000);
      f.native.sessions[0]!.model = "claude-sonnet-4-5";
      await f.bridge.refreshRuntime();
      expect(f.bridge.session("local-native")?.contextUsage?.maxTokens).toBe(196_000);
    } finally { await f.close(); }
  });

  it.each(["claude-sonnet-4-5", "deepseek/deepseek[1m]"])("does not attribute the running turn window to a model selected for the next turn (%s)", async nextModel => {
    const f = await fixture();
    try {
      const deepseek = "deepseek/deepseek[1m]";
      const sonnet = "claude-sonnet-4-5";
      const previousModel = nextModel === sonnet ? deepseek : sonnet;
      const previousUsageModel = previousModel === deepseek ? "deepseek" : sonnet;
      const previousWindow = previousModel === deepseek ? 272_000 : 200_000;
      await writeFile(f.options.settingsPath, JSON.stringify({ modelPicker: { options: [{ model: deepseek, label: "DeepSeek" }, { model: sonnet, label: "Sonnet" }] } }));
      f.native.sessions[0]!.model = `mythos-magpie-${magpieModelIdHash("deepseek/deepseek")}[1m]`;
      f.native.sessions[0]!.turnRunning = true;
      f.native.contextUsage = { totalTokens: 120_000, rawMaxTokens: 272_000, model: "deepseek" };
      await f.bridge.configuration("local-native");
      if (previousModel === sonnet) {
        await f.message({ type: "result", modelUsage: { deepseek: { contextWindow: 272_000 } } });
        f.native.sessions[0]!.turnRunning = false;
        f.native.contextUsage = null;
        await f.bridge.configureSession({ sessionId: "local-native", model: sonnet });
        f.native.sessions[0]!.turnRunning = true;
        f.native.contextUsage = { totalTokens: 120_000, rawMaxTokens: previousWindow, model: previousUsageModel };
        await f.bridge.configuration("local-native");
      }

      await f.bridge.configureSession({ sessionId: "local-native", model: nextModel });
      await f.bridge.configureSession({ sessionId: "local-native", model: previousModel });
      await f.bridge.configureSession({ sessionId: "local-native", model: nextModel });
      await f.message({ type: "stream_event", event: { type: "message_start", message: { id: "old-stream", model: previousUsageModel, usage: { input_tokens: 130_000 } } } });
      const oldAssistant = { type: "assistant", uuid: "old-turn", message: { id: "old-turn", model: previousUsageModel, usage: { input_tokens: 130_000, output_tokens: 100 } } };
      await f.message(oldAssistant);
      f.native.contextUsage = null;
      f.native.page = { messages: [oldAssistant], hasMore: false };
      await f.bridge.history("local-native");
      await f.message({ type: "stream_event", event: { type: "message_start", message: { id: "old-stream-tool-loop", model: previousUsageModel, usage: { input_tokens: 131_000 } } } });
      f.native.sessions[0]!.turnRunning = false;
      await f.bridge.refreshRuntime();
      await f.message({ type: "result", modelUsage: { [previousUsageModel]: { contextWindow: previousWindow } } });
      const usageModel = nextModel === deepseek ? "deepseek" : sonnet;
      const maxTokens = nextModel === deepseek ? 272_000 : 200_000;
      await f.message({ type: "assistant", uuid: "new-turn", message: { id: "new-turn", model: usageModel, usage: { input_tokens: 170_000 } } });
      expect(f.bridge.session("local-native")?.contextUsage).toMatchObject({ totalTokens: 170_000, maxTokens });
      await f.message({ type: "stream_event", event: { type: "message_start", message: { id: "new-stream", model: usageModel, usage: { input_tokens: 180_000 } } } });
      expect(f.bridge.session("local-native")?.contextUsage).toMatchObject({ totalTokens: 180_000, maxTokens });
    } finally { await f.close(); }
  });

  it("keeps a running turn's model when selection changes before its first usage sample", async () => {
    const f = await fixture();
    try {
      f.native.sessions[0]!.model = "claude-sonnet-4-5";
      f.native.sessions[0]!.turnRunning = true;
      await f.bridge.refreshRuntime();
      await f.bridge.configureSession({ sessionId: "local-native", model: "deepseek[1m]" });
      await f.message({ type: "assistant", uuid: "old-first-usage", message: { id: "old-first-usage", model: "claude-sonnet-4-5", usage: { input_tokens: 130_000 } } });
      await f.message({ type: "result", modelUsage: { "claude-sonnet-4-5": { contextWindow: 200_000 } } });
      await f.message({ type: "assistant", uuid: "new-first-usage", message: { id: "new-first-usage", model: "deepseek", usage: { input_tokens: 230_000 } } });
      expect(f.bridge.session("local-native")?.contextUsage).toMatchObject({ totalTokens: 230_000, maxTokens: 1_000_000, percentage: 23 });
    } finally { await f.close(); }
  });

  it("retains the model window when conversation rewind resets token usage", async () => {
    const f = await fixture();
    try {
      f.native.sessions[0]!.model = "deepseek[1m]";
      f.native.sessions[0]!.turnRunning = true;
      f.native.contextUsage = { totalTokens: 160_000, rawMaxTokens: 272_000, model: "deepseek" };
      await f.bridge.configuration("local-native");
      f.native.sessions[0]!.turnRunning = false;
      f.native.contextUsage = null;
      f.native.page = { messages: [{ type: "user", uuid: "rewind-user", message: { content: "Original prompt" } }], hasMore: false };
      await f.bridge.rewindSession("local-native", "rewind-user", "conversation");
      expect(f.bridge.session("local-native")?.contextUsage).toBeUndefined();
      await f.message({ type: "assistant", uuid: "after-rewind", message: { id: "after-rewind", model: "deepseek", usage: { input_tokens: 120_000 } } });
      expect(f.bridge.session("local-native")?.contextUsage).toMatchObject({ totalTokens: 120_000, maxTokens: 272_000 });
    } finally { await f.close(); }
  });

  it("tracks streaming growth, ignores sidechains, and updates or clears context usage across /compact and rewind", async () => {
    const f = await fixture();
    try {
      f.native.sessions[0]!.model = "claude-opus-5-5";
      await f.bridge.refreshRuntime();

      await f.message({
        type: "stream_event",
        event: {
          type: "message_start",
          message: { id: "msg_live", model: "claude-opus-5-5", usage: { input_tokens: 5_000, cache_read_input_tokens: 45_000, output_tokens: 20 } },
        },
      });
      expect(f.bridge.session("local-native")?.contextUsage).toMatchObject({ totalTokens: 50_020, maxTokens: 1_000_000, percentage: 5 });

      await f.message({
        type: "stream_event",
        event: { type: "message_delta", usage: { output_tokens: 480 } },
      });
      expect(f.bridge.session("local-native")?.contextUsage?.totalTokens).toBe(50_480);

      // Subagent sidechain stream_event and assistant messages must not overwrite main-chain context usage.
      await f.message({
        type: "assistant",
        uuid: "sub-msg",
        parent_tool_use_id: "toolu_sub",
        message: { id: "msg_sub", model: "claude-haiku-4-5", content: "subagent", usage: { input_tokens: 190_000, output_tokens: 2_000 } },
      });
      expect(f.bridge.session("local-native")?.contextUsage?.totalTokens).toBe(50_480);

      await f.message({
        type: "assistant",
        uuid: "main-msg",
        message: { id: "msg_live", model: "claude-opus-5-5", content: "done", usage: { input_tokens: 5_000, cache_read_input_tokens: 45_000, output_tokens: 500 } },
      });
      await f.message({
        type: "result",
        uuid: "res-1",
        modelUsage: {
          "claude-haiku-4-5": { contextWindow: 200_000 },
          "claude-opus-5-5": { contextWindow: 1_000_000 },
        },
      });
      expect(f.bridge.session("local-native")?.contextUsage).toEqual({
        totalTokens: 50_500,
        maxTokens: 1_000_000,
        percentage: 5.1,
        model: "claude-opus-5-5",
        estimated: false,
      });

      // /compact with postTokens adopts compacted token count and ignores preserved pre-compact assistant replay.
      await f.message({
        type: "system",
        subtype: "compact_boundary",
        uuid: "compact-1",
        compactMetadata: { preTokens: 50_500, postTokens: 9_200, preservedSegment: { headUuid: "u1", tailUuid: "main-msg" } },
      });
      expect(f.bridge.session("local-native")?.contextUsage).toMatchObject({ totalTokens: 9_200, maxTokens: 1_000_000, percentage: 0.9, estimated: true });

      await f.message({
        type: "assistant",
        uuid: "main-msg",
        message: { id: "msg_live", model: "claude-opus-5-5", content: "replayed", usage: { input_tokens: 50_000, output_tokens: 500 } },
      });
      expect(f.bridge.session("local-native")?.contextUsage?.totalTokens).toBe(9_200);

      // Rewind clears stale context even if post-rewind readback disconnects.
      f.native.page = {
        messages: [
          { type: "user", uuid: "rewind-user", message: { role: "user", content: "Initial prompt" } },
          { type: "assistant", uuid: "post-compact-reply", message: { id: "msg_after", model: "claude-opus-5-5", content: "Reply", usage: { input_tokens: 14_000, output_tokens: 300 } } },
        ],
        hasMore: false,
      };
      const originalCall = f.native.call.bind(f.native);
      vi.spyOn(f.native, "call").mockImplementation((method, args) => {
        if (method === "getSession" && f.native.calls.some(call => call.method === "rewindV2")) {
          return Promise.reject(new InspectorDisconnectedError("Disconnected after rewindV2"));
        }
        return originalCall(method, args);
      });
      await f.bridge.rewindSession("local-native", "rewind-user", "conversation");
      expect(f.bridge.session("local-native")?.contextUsage).toBeUndefined();
    } finally { await f.close(); }
  });

  it("projects background subagent state from native hasBackgroundWork, refines on history and backgroundTaskDetails, and ignores orphaned tasks on dead sessions", async () => {
    const f = await fixture();
    try {
      f.native.sessions = [
        { sessionId: "local-native", cwd: "/project", title: "Active background", isRunning: false, turnRunning: false, hasBackgroundWork: true, lastActivityAt: 12_345, permissionMode: "default", model: "native-model", pendingToolPermissions: [] },
        { sessionId: "dead-native", cwd: "/project", title: "Dead session", isRunning: false, turnRunning: false, hasBackgroundWork: false, lastActivityAt: 5_000, permissionMode: "default", model: "native-model", pendingToolPermissions: [] },
      ];
      await f.bridge.refreshRuntime();
      expect(f.bridge.session("local-native")).toMatchObject({
        turnState: "idle",
        runningSubagents: { count: 1, lastUpdatedAt: 12_345 },
      });
      expect(f.bridge.session("dead-native")?.runningSubagents).toBeUndefined();

      let changed = 0;
      f.bridge.on("changed", () => { changed += 1; });
      f.native.pages.set("", {
        messages: [
          { type: "system", subtype: "task_started", task_id: "bg-1", tool_use_id: "call-1", description: "Run local CI", timestamp: 20_000 },
          { type: "system", subtype: "task_started", task_id: "bg-2", tool_use_id: "call-2", description: "Audit report", timestamp: 25_000 },
        ],
        hasMore: false,
      });
      await f.bridge.history("local-native");
      expect(changed).toBe(1);
      expect(f.bridge.session("local-native")?.runningSubagents).toEqual({ count: 2, lastUpdatedAt: 25_000 });

      // Opening a dead historical session with an orphaned task_started must not revive runningSubagents.
      await f.bridge.history("dead-native");
      expect(f.bridge.session("dead-native")?.runningSubagents).toBeUndefined();

      // backgroundTaskDetails emits "changed" when local transcript subagent state changes.
      const transcript = join(f.options.settingsPath, "..", "bg-session.jsonl");
      await writeFile(
        transcript,
        [
          { type: "assistant", uuid: "row-0", timestamp: new Date(10_000).toISOString(), isSidechain: false, message: { content: [{ type: "tool_use", id: "call-1", name: "Agent", input: { description: "Run local CI", prompt: "Run" } }] } },
          { type: "user", uuid: "row-1", parentUuid: "row-0", timestamp: new Date(11_000).toISOString(), isSidechain: false, message: { content: [{ type: "tool_result", tool_use_id: "call-1", content: "Async agent launched successfully. agentId: bg-1" }] } },
        ].map(row => JSON.stringify(row)).join("\n") + "\n",
      );
      f.options.scanCatalog.mockResolvedValue({
        projects: [],
        sessions: [{
          ...f.bridge.session("local-native")!,
          sessionId: "bg-session",
          desktopSessionId: "local-native",
          transcriptPath: transcript,
          transcriptMtimeMs: 0,
          processAlive: true,
          desktopProcessAlive: true,
          bridgeProcessAlive: false,
          processOverlap: false,
          activeTask: false,
          activeProcesses: [{ startedAt: 1_000, processAlive: true, entrypoint: "claude-desktop-3p", source: "process" }],
        }],
        observedAt: 0,
      });
      changed = 0;
      await f.bridge.backgroundTaskDetails("local-native");
      expect(changed).toBe(1);
      expect(f.bridge.session("local-native")?.runningSubagents).toEqual({ count: 1, lastUpdatedAt: 10_000 });

      f.native.sessions[0]!.hasBackgroundWork = false;
      f.options.scanCatalog.mockResolvedValue({
        projects: [],
        sessions: [{
          ...f.bridge.session("local-native")!,
          sessionId: "bg-session",
          desktopSessionId: "local-native",
          transcriptPath: transcript,
          transcriptMtimeMs: 0,
          processAlive: false,
          desktopProcessAlive: false,
          bridgeProcessAlive: false,
          processOverlap: false,
          activeTask: false,
          activeProcesses: [],
        }],
        observedAt: 0,
      });
      await f.bridge.refreshRuntime();
      changed = 0;
      await f.bridge.backgroundTaskDetails("local-native");
      expect(changed).toBe(1);
      expect(f.bridge.session("local-native")?.runningSubagents).toBeUndefined();
    } finally { await f.close(); }
  });

  it.each([false, true])("reads gateway and model settings once per refresh (Host credentials file: %s)", async (withHostCredentials) => {
    const root = await mkdtemp(join(tmpdir(), "bridge-magpie-runtime-"));
    const state = new ConversationStateStore({ databasePath: join(root, "state.sqlite") });
    await state.initialize();
    const eventLog = new SessionEventLog(join(root, "events.jsonl"));
    await eventLog.initialize();
    const native = new NativeDesktop();
    const deepseekId = "remote-magpie/deepseek/deepseek-flash";
    const deepseekAlias = `mythos-magpie-${magpieModelIdHash(deepseekId)}`;
    const fableAlias = `magpie-${magpieModelIdHash("claude/claude-fable-5-2")}.anthropic.claude-fable-5-2[1m]`;
    native.sessions = [
      { sessionId: "win-session", cwd: "/project", title: "Win", isRunning: true, turnRunning: false, permissionMode: "default", model: deepseekAlias, pendingToolPermissions: [] },
      { sessionId: "mac-session", cwd: "/project", title: "Mac", isRunning: true, turnRunning: false, permissionMode: "default", model: fableAlias, pendingToolPermissions: [] },
    ];
    const localAppData = join(root, "AppData", "Local");
    const roamingAppData = join(root, "AppData", "Roaming");
    const configLib = join(localAppData, "Claude-3p", "configLibrary");
    const metaPath = join(configLib, "_meta.json");
    const activePath = join(configLib, "active.json");
    const settingsPath = join(root, "settings.json");
    const hostPath = join(localAppData, "Claude-3p", "host-creds-test.json");
    const reads = vi.mocked(readFile);
    const readCount = (target: string) => reads.mock.calls.filter(([path]) => path === target).length;
    await mkdir(configLib, { recursive: true });
    const hostBearer = "fixture-host-bearer";
    if (withHostCredentials) {
      await writeFile(hostPath, JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: hostBearer } }), { mode: 0o600 });
    }
    await writeFile(metaPath, JSON.stringify({ appliedId: "active" }));
    await writeFile(activePath, JSON.stringify({
      inferenceProvider: "gateway",
      inferenceGatewayBaseUrl: "http://127.0.0.1:3425",
      inferenceGatewayAuthScheme: "bearer",
      inferenceGatewayApiKey: "test-magpie-token",
      inferenceModels: [
        { name: "magpie-5782219464.anthropic.claude-fable-5-2", labelOverride: "Claude Fable 5.2 · Offline", prefer1m: true, supports1m: true },
      ],
    }), { mode: 0o600 });

    const magpieConnection = new MagpieConnectionRepository(join(root, "magpie-connection-v1.json"), {
      isEncryptionAvailable: () => true,
      encryptString: text => Buffer.from(text, "utf8"),
      decryptString: buf => buf.toString("utf8"),
    });
    let currentTime = 1_000;
    let failGateway = true;
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (failGateway) throw new Error("offline");
      if (String(url).includes("/magpie/quotas")) {
        return Response.json({ data: [{ provider: "deepseek", user: "synthetic", windows: [] }] });
      }
      return Response.json({
        data: [
          { id: deepseekId, display_name: "DeepSeek-V4.1-Flash", magpie_label: "DeepSeek-V4.1-Flash · DeepSeek · Remote magpie", max_input_tokens: 1_048_576 },
          { id: "claude/claude-fable-5-2", display_name: "Claude Fable 5.2", magpie_label: "Claude Fable 5.2 · Claude Code", max_input_tokens: 1_000_000, supports_1m: true },
        ],
      });
    }) as unknown as typeof fetch;

    const bridge = new ClaudeDesktopBridge({
      settingsPath,
      eventLog,
      conversationState: state,
      inspector: native,
      magpieConnection,
      platform: "win32",
      home: root,
      environment: { APPDATA: roamingAppData, LOCALAPPDATA: localAppData, ANTHROPIC_BASE_URL: "https://ambient.other.invalid" },
      fetchImpl,
      now: () => currentTime,
      gatewayModelsCacheMs: 60_000,
      refreshIntervalMs: 60_000,
    });
    try {
      reads.mockClear();
      await bridge.initialize();
      expect.soft([readCount(metaPath), readCount(activePath), readCount(settingsPath)], "initial offline refresh").toEqual([1, 1, 1]);
      expect.soft(readCount(hostPath), "offline Host credentials reads").toBe(Number(withHostCredentials));
      // Even when initial /v1/models fails, snapshot.magpie is populated and offline configLibrary inferenceModels + humanized slug avoid raw IDs.
      expect(bridge.magpieSettings()).toEqual({
        magpie: { mode: "auto", baseUrl: "http://127.0.0.1:3425", authScheme: "bearer", keyConfigured: true },
      });
      expect(bridge.session("mac-session")?.modelDisplayName).toBe("Claude Fable 5.2 · Offline");
      expect(bridge.session("win-session")?.modelDisplayName).toBeUndefined();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      if (withHostCredentials) {
        expect(fetchImpl).toHaveBeenLastCalledWith("http://127.0.0.1:3425/v1/models?limit=1000", expect.objectContaining({
          headers: expect.objectContaining({ authorization: `Bearer ${hostBearer}` }),
        }));
      }

      // Background refresh within negative cache TTL does not hammer /v1/models.
      currentTime += 2_000;
      reads.mockClear();
      expect(await bridge.refreshRuntime()).toBe(true);
      expect.soft([readCount(metaPath), readCount(activePath), readCount(settingsPath)], "cached refresh").toEqual([1, 1, 1]);
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      // Explicit configuration() retries a failed initial fetch immediately and loads full Windows Magpie catalog.
      failGateway = false;
      const winConfig = await bridge.configuration("win-session");
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(winConfig.modelsComplete).toBe(true);
      expect(winConfig.model).toBe(deepseekId);
      expect(winConfig.modelDisplayName).toBe("DeepSeek-V4.1-Flash");
      expect(bridge.session("win-session")?.modelDisplayName).toBe("DeepSeek-V4.1-Flash");

      // Subsequent configuration() and refreshRuntime() within 60s reuse the cached catalog without extra HTTP calls.
      currentTime += 5_000;
      await bridge.refreshRuntime();
      await bridge.configuration("mac-session");
      expect(fetchImpl).toHaveBeenCalledTimes(2);

      // If a later post-TTL background refresh fails, stale models are retained with ok=false so explicit configuration() retries immediately.
      currentTime += 65_000;
      failGateway = true;
      await bridge.refreshRuntime();
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(bridge.session("win-session")?.modelDisplayName).toBe("DeepSeek-V4.1-Flash");
      currentTime += 1_000;
      await bridge.refreshRuntime();
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      failGateway = false;
      await bridge.configuration("win-session");
      expect(fetchImpl).toHaveBeenCalledTimes(4);

      // Unsaved testMagpieConnection({ mode: "auto" }) uses full configLibrary gateway discovery even while saved mode is manual.
      reads.mockClear();
      await bridge.saveMagpieConnection({ mode: "manual", baseUrl: "https://manual.example.test", authScheme: "bearer", apiKey: "manual-key" });
      expect(fetchImpl).toHaveBeenCalledTimes(5);
      expect(fetchImpl).toHaveBeenLastCalledWith("https://manual.example.test/v1/models?limit=1000", expect.anything());
      expect.soft([readCount(metaPath), readCount(activePath), readCount(settingsPath)], "manual refresh").toEqual([0, 0, 1]);
      await expect(bridge.testMagpieConnection({ mode: "auto" })).resolves.toEqual({
        models: { state: "ready", count: 4 },
        quota: { state: "available" },
      });
      await bridge.saveMagpieConnection({ mode: "auto" });

      // When settings.json saves unprefixed claude-fable-5-2[1m], slug fallback matches both session display and configureSession.
      await writeFile(join(root, "settings.json"), JSON.stringify({
        modelPicker: { options: [{ model: "claude-fable-5-2[1m]", label: "Claude Fable 5.2 · Claude Code" }] },
      }));
      await bridge.refreshRuntime();
      expect(bridge.session("mac-session")?.modelDisplayName).toBe("Claude Fable 5.2 · Claude Code");
      native.codeModels = ["magpie-5782219464.anthropic.claude-fable-5-2"];
      const updated = await bridge.configureSession({ sessionId: "mac-session", model: "claude-fable-5-2[1m]" });
      expect(native.calls.find(call => call.method === "setModel")?.args).toEqual([
        "mac-session",
        "magpie-5782219464.anthropic.claude-fable-5-2[1m]",
      ]);
      expect(updated.modelDisplayName).toBe("Claude Fable 5.2 · Claude Code");

      // Removing the active gateway makes the next refresh use the same settings file for models and gateway credentials.
      await writeFile(activePath, "{}");
      await writeFile(settingsPath, JSON.stringify({
        model: "saved-default",
        modelPicker: { options: [{ model: "saved-first", label: "Saved first" }, { model: "saved-default", label: "Saved default" }] },
        env: { ANTHROPIC_BASE_URL: "https://settings.example.test", ANTHROPIC_API_KEY: "settings-key", CLAUDE_CODE_HOST_AUTH_ENV_VAR: "ANTHROPIC_API_KEY" },
      }));
      native.sessions[0]!.model = "default";
      reads.mockClear();
      expect(await bridge.refreshRuntime()).toBe(true);
      expect(fetchImpl).toHaveBeenLastCalledWith("https://settings.example.test/v1/models?limit=1000", expect.anything());
      expect(bridge.magpieSettings()).toEqual({
        magpie: { mode: "auto", baseUrl: "https://settings.example.test", authScheme: "x-api-key", keyConfigured: true },
      });
      expect(bridge.session("win-session")).toMatchObject({ model: "saved-default", modelDisplayName: "Saved default" });
      expect.soft([readCount(metaPath), readCount(activePath), readCount(settingsPath)], "settings gateway refresh").toEqual([1, 1, 1]);
      expect.soft(readCount(hostPath), "settings fallback Host credentials reads").toBe(Number(withHostCredentials));

      await writeFile(settingsPath, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://disconnected.example.test" } }));
      native.ready = false;
      vi.spyOn(native, "connect").mockRejectedValueOnce(new Error("inspector offline"));
      vi.mocked(fetchImpl).mockClear();
      expect(await bridge.refreshRuntime()).toBe(false);
      expect(bridge.magpieSettings().magpie?.baseUrl).toBe("https://disconnected.example.test");
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      reads.mockClear();
      await bridge.close();
      await eventLog.close();
      state.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses the saved Magpie gateway when a paused inspector refresh resumes", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-magpie-save-"));
    const state = new ConversationStateStore({ databasePath: join(root, "state.sqlite") });
    await state.initialize();
    const eventLog = new SessionEventLog(join(root, "events.jsonl"));
    await eventLog.initialize();
    const native = new NativeDesktop();
    const magpieConnection = new MagpieConnectionRepository(join(root, "magpie-connection-v1.json"), {
      isEncryptionAvailable: () => true,
      encryptString: text => Buffer.from(text, "utf8"),
      decryptString: buf => buf.toString("utf8"),
    });
    const fetchImpl = vi.fn<typeof fetch>(async url => Response.json({
      data: [{ id: "native-model", display_name: new URL(String(url)).hostname }],
    }));
    const bridge = new ClaudeDesktopBridge({
      settingsPath: join(root, "settings.json"), eventLog, conversationState: state, inspector: native,
      magpieConnection, environment: {}, home: root, fetchImpl, refreshIntervalMs: 60_000,
    });
    const saveGateway = (baseUrl: string) => bridge.saveMagpieConnection({ mode: "manual", baseUrl, authScheme: "bearer", apiKey: "fixture-gateway-key" });
    try {
      await bridge.initialize();
      await saveGateway("https://old.example.test");
      expect(bridge.session("local-native")?.modelDisplayName).toBe("old.example.test");
      fetchImpl.mockClear();

      let resumeGetAll!: () => void;
      const holdGetAll = new Promise<void>(resolve => { resumeGetAll = resolve; });
      let enterGetAll!: () => void;
      const getAllEntered = new Promise<void>(resolve => { enterGetAll = resolve; });
      vi.spyOn(native, "call").mockImplementationOnce(async () => {
        enterGetAll();
        await holdGetAll;
        return structuredClone(native.sessions);
      });
      const refresh = bridge.refreshRuntime();
      try {
        await getAllEntered;
        await saveGateway("https://new.example.test");
      } finally {
        resumeGetAll();
        expect(await refresh).toBe(true);
      }
      expect.soft(fetchImpl.mock.calls.map(([url]) => url)).toEqual(["https://new.example.test/v1/models?limit=1000"]);
      expect(bridge.session("local-native")?.modelDisplayName).toBe("new.example.test");
    } finally {
      await bridge.close();
      await eventLog.close();
      state.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
