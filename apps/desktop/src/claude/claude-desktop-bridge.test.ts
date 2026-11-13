import { EventEmitter, once } from "node:events";
import { rm, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { BridgeCrypto, isEncryptedEnvelope } from "@bridge/protocol";
import { EvidenceManager } from "../evidence/evidence-manager.js";
import { EvidenceStore } from "../evidence/evidence-store.js";
import { DesktopController } from "../controller/controller.js";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ClaudeDesktopBridge, WorkspaceTrustRequiredError, nativeHistoryItems } from "./claude-desktop-bridge.js";
import { InspectorDisconnectedError, NativeCallError } from "./claude-desktop-inspector.js";
import { ConversationStateStore } from "../controller/conversation-state-store.js";
import { SessionEventLog } from "../controller/session-event-log.js";
import { magpieModelIdHash } from "./claude-runtime-discovery.js";
import type { ClaudeCatalogSnapshot } from "./claude-session-catalog.js";
import { createNativeSectionFixture } from "../../../../scripts/fixtures/native-section-store.js";

class NativeDesktop extends EventEmitter {
  ready = false;
  calls: Array<{ method: string; args: unknown[] }> = [];
  sessions: Array<Record<string, unknown>> = [{ sessionId: "local-native", cwd: "/project", title: "Native", isRunning: true, turnRunning: false, permissionMode: "default", model: "native-model", pendingToolPermissions: [] }];
  page: Record<string, unknown> = { messages: [], hasMore: false };
  pages = new Map<string, Record<string, unknown>>();
  sendError: Error | undefined;
  sendReply: Promise<unknown> | undefined;
  sendResult: unknown = { delivered: true };
  queueResult = true;
  unsupported = new Set<string>();
  commands = [{ name: "compact", description: "Compact native history" }];
  permissionModeResult = true;
  applyPermissionMode = true;
  btwResult: Record<string, unknown> = { status: "started", sessionId: "local-child" };
  codeModels: string[] = [];
  applyModel = true;
  normalizeModel: ((model: string) => string) | undefined;
  sentModels: unknown[] = [];
  canRewind = true;
  contextUsage: Record<string, unknown> | null = null;
  filesPreview: Record<string, unknown> | null = { canRewind: true, filesChanged: ["src/native.ts"], insertions: 4, deletions: 2 };
  filesRestore: Record<string, unknown> | null = { canRewind: true };
  filesPreviewError: Error | undefined;
  conversationRewind: { prefill: string } | null = { prefill: "Original draft" };
  conversationRewindError: Error | undefined;
  untrustedCwds = new Set<string>();
  keepUntrustedAfterSave = false;
  supports(method: string) { return !this.unsupported.has(method); }
  async connect() { this.ready = true; }
  async close() { this.ready = false; }
  availableCodeModels = vi.fn(async () => this.codeModels);
  async call(method: string, args: unknown[] = []): Promise<unknown> {
    this.calls.push({ method, args });
    if (!this.supports(method)) throw new Error(`Unsupported Claude Desktop method: ${method}`);
    if (method === "getAll") return structuredClone(this.sessions);
    if (method === "delete") this.sessions = this.sessions.filter(session => session.sessionId !== args[0]);
    const session = this.sessions.find(session => session.sessionId === args[0]);
    if (method === "getSession") return structuredClone(session);
    if (method === "getContextUsage") return structuredClone(this.contextUsage);
    if (method === "getTranscriptPage") return this.pages.get(String(args[1] ?? "")) ?? this.page;
    if (method === "getTranscript") return this.page.messages;
    if (method === "canRewindTo") return this.canRewind;
    if (method === "rewindFiles") {
      if (args[2] === true && this.filesPreviewError) throw this.filesPreviewError;
      return args[2] === true ? this.filesPreview : this.filesRestore;
    }
    if (method === "rewindV2") {
      if (this.conversationRewindError) throw this.conversationRewindError;
      if (this.conversationRewind) this.page.messages = (this.page.messages as Array<Record<string, unknown>>).slice(0, (this.page.messages as Array<Record<string, unknown>>).findIndex(message => message.uuid === args[1]));
      return this.conversationRewind;
    }
    if (method === "sendMessage") {
      if (this.sendError) throw this.sendError;
      this.sentModels.push(session?.model);
      return this.sendReply ? await this.sendReply : this.sendResult;
    }
    if (["promoteQueuedMessage", "sendSteeredNow", "cancelQueuedMessage"].includes(method)) return this.queueResult;
    if (method === "getAvailableCodeModels") return this.codeModels;
    if (method === "setModel" && session && this.applyModel) session.model = this.codeModels.length && !this.codeModels.some(model => model.replace(/\[1m\]$/iu, "") === String(args[1]).replace(/\[1m\]$/iu, "")) ? "default" : this.normalizeModel?.(String(args[1])) ?? args[1];
    if (method === "setPermissionMode" && session) {
      if (this.permissionModeResult && this.applyPermissionMode) session.permissionMode = args[1];
      return this.permissionModeResult;
    }
    if (method === "getSupportedCommands") return this.commands;
    if (method === "startBtwChild" && session) {
      if (this.btwResult.status === "started" && typeof this.btwResult.sessionId === "string") this.sessions.push({
        ...session, sessionId: this.btwResult.sessionId, pendingToolPermissions: [], turnRunning: false,
        forkedFromSessionId: session.sessionId, spawnedFrom: { sessionId: session.sessionId, sideSession: true, userFork: true, btw: true },
      });
      return this.btwResult;
    }
    if (method === "forkSession" && session) {
      const child = { ...session, sessionId: "local-child", forkedFromSessionId: session.sessionId, pendingToolPermissions: [], turnRunning: false };
      this.sessions.push(child);
      return { sessionId: child.sessionId };
    }
    if (method === "respondToToolPermission") for (const session of this.sessions) {
      if (Array.isArray(session.pendingToolPermissions)) session.pendingToolPermissions = session.pendingToolPermissions.filter(permission => permission.requestId !== args[0]);
    }
    if (method === "saveTrust") {
      if (!this.keepUntrustedAfterSave) this.untrustedCwds.delete(String(args[0]));
      return;
    }
    if (method === "start") {
      const input = args[0] as Record<string, unknown>;
      if (this.untrustedCwds.has(String(input.cwd))) {
        throw new NativeCallError("Error invoking remote method '$eipc_message$d32c5f9b_$_claude.web_$_LocalSessions_$_start': WorkspaceTrustError: Workspace requires trust approval before starting a session. [ccdErrorCategory:trust_required]");
      }
      this.sessions.push({ ...input, isRunning: false, turnRunning: false });
      return { sessionId: input.sessionId };
    }
    return undefined;
  }
}

async function fixture(legacy = false, evidence?: ConstructorParameters<typeof ClaudeDesktopBridge>[0]["evidence"]) {
  const directory = await mkdtemp(join(tmpdir(), "bridge-native-"));
  const state = new ConversationStateStore({ databasePath: join(directory, "state.sqlite"), sessionsPath: join(directory, "sessions.json"), queuePath: join(directory, "queue.json"), masterSecret: Buffer.alloc(32, 7).toString("base64url") });
  await state.initialize();
  if (legacy) {
    state.saveBrokerSessions([{ sessionId: "legacy-unlinked", cwd: "/legacy", title: "Native", createdAt: 1 }], []);
    const lane = state.listLanes("legacy-unlinked")[0]!;
    state.saveBrokerQueue([{ sessionId: "legacy-unlinked", laneId: lane.laneId, commandId: "old-command", requestId: "old-request", idempotencyKey: "old-key", state: "pending", text: "Never replay" }], [], []);
  }
  const eventLog = new SessionEventLog(join(directory, "events.jsonl"));
  await eventLog.initialize();
  const native = new NativeDesktop();
  const scanCatalog = vi.fn<() => Promise<ClaudeCatalogSnapshot>>().mockResolvedValue({ projects: [], sessions: [], observedAt: 0 });
  const options = { eventLog, conversationState: state, inspector: native, scanCatalog, settingsPath: join(directory, "settings.json"), ...(evidence ? { evidence } : {}), refreshIntervalMs: 60_000 };
  const bridge = new ClaudeDesktopBridge(options);
  await bridge.initialize();
  return {
    bridge, native, state, eventLog, options, directory,
    async message(message: Record<string, unknown>) {
      const changed = once(bridge, "changed");
      native.emit("event", { type: "message", sessionId: "local-native", message });
      await changed;
    },
    async close() { await bridge.close(); await eventLog.close(); state.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

const input = { sessionId: "local-native", text: "hello", requestId: "request", idempotencyKey: "key", origin: "mobile" as const };

describe("native Sections", () => {
  it("reads back a persisted empty native group, retains it after reconnect/restart, and isolates account/org scopes", async () => {
    const f = await fixture();
    let restarted: ClaudeDesktopBridge | undefined;
    try {
      const sections = await createNativeSectionFixture(f.directory);
      Object.assign(f.native, { sections: sections.sections, createSection: sections.createSection, assignSection: sections.assignSection });
      await f.bridge.refreshRuntime();
      expect(f.bridge.capabilities()).toContain("section.create");
      const project = await f.bridge.createSection("Research");
      expect(project).toMatchObject({ name: "Research", kind: "desktop-group", cwd: "", sessionCount: 0 });
      const saved = JSON.parse(await readFile(sections.profile, "utf8"));
      expect(saved["account-a/org-a"].sections).toEqual([{ id: project.projectId, name: "Research", order: 0 }]);
      expect(await f.bridge.createSection("Research")).toEqual(project);
      sections.scope = "account-a/org-b";
      await f.bridge.refreshRuntime();
      expect(f.bridge.listProjects().some(value => value.projectId === project.projectId)).toBe(false);
      const other = await f.bridge.createSection("Other org");
      expect(sections.calls.at(-1)).toMatchObject({ scope: "account-a/org-b", name: "Other org" });
      sections.scope = "account-b/org-a";
      await f.bridge.refreshRuntime();
      expect(f.bridge.listProjects().filter(value => value.kind === "desktop-group")).toEqual([]);
      sections.scope = "account-a/org-a";
      await sections.reread();
      await f.native.close();
      await f.bridge.refreshRuntime();
      expect(f.bridge.listProjects().find(value => value.projectId === project.projectId)).toEqual(project);
      await f.bridge.close();
      restarted = new ClaudeDesktopBridge(f.options);
      await restarted.initialize();
      expect(restarted.listProjects().filter(value => value.kind === "desktop-group")).toEqual([project]);
      expect(restarted.listProjects().some(value => value.projectId === other.projectId)).toBe(false);
      expect(f.native.calls.every(call => call.method !== "start")).toBe(true);
    } finally { await restarted?.close(); await f.close(); }
  });

  it("assigns a newly created session to its selected native Section and projects native membership", async () => {
    const f = await fixture();
    try {
      const sections = await createNativeSectionFixture(f.directory);
      Object.assign(f.native, { sections: sections.sections, createSection: sections.createSection, assignSection: sections.assignSection });
      await f.bridge.refreshRuntime();
      const project = await f.bridge.createSection("Research");
      const session = await f.bridge.createSession("/new-project", "New", project.projectId);
      expect(sections.calls.at(-1)).toEqual({ method: "move_sessions", scope: "account-a/org-a", sessionId: session.sessionId, sectionId: project.projectId });
      expect(session).toMatchObject({ projectId: project.projectId, projectName: "Research", cwd: "/new-project" });
      expect(f.bridge.listProjects().find(value => value.projectId === project.projectId)).toMatchObject({ sessionCount: 1 });
    } finally { await f.close(); }
  });

  it("rejects a Section deleted after the last refresh before starting any native session", async () => {
    const f = await fixture();
    try {
      const sections = await createNativeSectionFixture(f.directory);
      const assignSection = vi.fn().mockRejectedValue(new NativeCallError("No section with that id exists"));
      Object.assign(f.native, { sections: sections.sections, createSection: sections.createSection, assignSection });
      await f.bridge.refreshRuntime();
      const project = await f.bridge.createSection("Research");
      await writeFile(sections.profile, JSON.stringify({ "account-a/org-a": { sections: [], assignments: {} } }));
      expect(f.bridge.listProjects().some(value => value.projectId === project.projectId)).toBe(true);
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(f.bridge.createSession("/new-project", "New", project.projectId)).rejects.toThrow();
      }
      expect(f.native.calls.filter(call => call.method === "start")).toEqual([]);
      expect(assignSection).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it.each(["D:\\PARA", "/Users/lycidas/work/new-folder"])("sanitizes WorkspaceTrustError, authorizes via saveTrust on confirmation, and falls back to manual when required (%s)", async cwd => {
    const f = await fixture();
    try {
      f.native.untrustedCwds.add(cwd);
      expect(f.bridge.capabilities()).toContain("workspace.trust");
      await expect(f.bridge.createSession(cwd, "Untrusted")).rejects.toEqual(new WorkspaceTrustRequiredError(false));
      expect(f.native.calls.some(call => call.method === "saveTrust")).toBe(false);

      const created = await f.bridge.createSession(cwd, "Untrusted", undefined, true);
      expect(created.cwd).toBe(cwd);
      expect(f.native.calls.filter(call => call.method === "saveTrust")).toEqual([{ method: "saveTrust", args: [cwd] }]);

      f.native.untrustedCwds.add(cwd);
      f.native.keepUntrustedAfterSave = true;
      await expect(f.bridge.createSession(cwd, "Still untrusted", undefined, true)).rejects.toEqual(new WorkspaceTrustRequiredError(true));

      f.native.keepUntrustedAfterSave = false;
      f.native.unsupported.add("saveTrust");
      expect(f.bridge.capabilities()).not.toContain("workspace.trust");
      await expect(f.bridge.createSession(cwd, "Manual desktop")).rejects.toEqual(new WorkspaceTrustRequiredError(true));
    } finally { await f.close(); }
  });

  it("rejects legacy capability, native errors and creation without authoritative readback", async () => {
    const f = await fixture();
    try {
      await expect(f.bridge.createSection("Research")).rejects.toThrow("does not support Sections");
      const sections = await createNativeSectionFixture(f.directory);
      Object.assign(f.native, { sections: sections.sections, createSection: sections.createSection, assignSection: sections.assignSection });
      await f.bridge.refreshRuntime();
      sections.failure = "Native section limit reached";
      await expect(f.bridge.createSection("Research")).rejects.toThrow(sections.failure);
      sections.failure = "";
      sections.publishCreated = false;
      await expect(f.bridge.createSection("Research")).rejects.toThrow("has not published");
      expect(f.bridge.listProjects().some(value => value.kind === "desktop-group")).toBe(false);
      sections.supported = false;
      await f.bridge.refreshRuntime();
      expect(f.bridge.capabilities()).not.toContain("section.create");
      expect(f.bridge.capabilities()).not.toContain("section.move");
      expect(f.native.calls.every(call => call.method !== "start")).toBe(true);
    } finally { await f.close(); }
  });

  it("moves existing sessions into, between and out of native Sections while preserving cwd and eligibility gates", async () => {
    const f = await fixture();
    try {
      f.native.sessions.push(
        { sessionId: "local-archived", cwd: "/archived", title: "Archived", isArchived: true, turnRunning: false },
        { sessionId: "local-scheduled", cwd: "/scheduled", title: "Scheduled", scheduledTaskId: "task-1", turnRunning: false },
      );
      await expect(f.bridge.moveSessionSection("local-native", null)).rejects.toThrow("does not support Sections");
      const sections = await createNativeSectionFixture(f.directory);
      Object.assign(f.native, { sections: sections.sections, createSection: sections.createSection, assignSection: sections.assignSection });
      await f.bridge.refreshRuntime();
      expect(f.bridge.capabilities()).toContain("section.move");
      expect(f.bridge.session("local-native")?.allowedActions?.canMoveSection).toBe(true);
      expect(f.bridge.session("local-archived")?.allowedActions?.canMoveSection).toBeUndefined();
      expect(f.bridge.session("local-scheduled")?.allowedActions?.canMoveSection).toBeUndefined();

      const zahuo = await f.bridge.createSection("杂活");
      const research = await f.bridge.createSection("Research");
      const originalProjectId = f.bridge.session("local-native")!.projectId;
      const originalCwd = f.bridge.session("local-native")!.cwd;

      const inZahuo = await f.bridge.moveSessionSection("local-native", zahuo.projectId);
      expect(inZahuo).toMatchObject({ projectId: zahuo.projectId, projectName: "杂活", cwd: originalCwd });
      expect(f.bridge.listProjects().find(value => value.projectId === zahuo.projectId)).toMatchObject({ sessionCount: 1 });

      const inResearch = await f.bridge.moveSessionSection("local-native", research.projectId);
      expect(inResearch).toMatchObject({ projectId: research.projectId, projectName: "Research", cwd: originalCwd });
      expect(f.bridge.listProjects().find(value => value.projectId === zahuo.projectId)).toMatchObject({ sessionCount: 0 });
      expect(f.bridge.listProjects().find(value => value.projectId === research.projectId)).toMatchObject({ sessionCount: 1 });

      const ungrouped = await f.bridge.moveSessionSection("local-native", null);
      expect(sections.calls.at(-1)).toEqual({ method: "move_sessions", scope: "account-a/org-a", sessionId: "local-native", sectionId: "sessions" });
      expect(ungrouped).toMatchObject({ projectId: originalProjectId, cwd: originalCwd });
      expect(f.bridge.listProjects().find(value => value.projectId === research.projectId)).toMatchObject({ sessionCount: 0 });
      expect(f.bridge.listProjects().some(value => value.projectId === originalProjectId)).toBe(true);

      await expect(f.bridge.moveSessionSection("local-archived", zahuo.projectId)).rejects.toThrow("cannot be moved");
      await expect(f.bridge.moveSessionSection("local-scheduled", zahuo.projectId)).rejects.toThrow("cannot be moved");
      await expect(f.bridge.moveSessionSection("local-native", originalProjectId)).rejects.toThrow("no longer available");
    } finally { await f.close(); }
  });

  it("renames and deletes native Sections while returning assigned sessions to their default project directories", async () => {
    const f = await fixture();
    try {
      await expect(f.bridge.renameSection("missing", "Next")).rejects.toThrow("does not support Sections");
      await expect(f.bridge.deleteSection("missing")).rejects.toThrow("does not support Sections");
      const sections = await createNativeSectionFixture(f.directory);
      Object.assign(f.native, {
        sections: sections.sections,
        createSection: sections.createSection,
        assignSection: sections.assignSection,
        renameSection: sections.renameSection,
        deleteSection: sections.deleteSection,
      });
      await f.bridge.refreshRuntime();
      expect(f.bridge.capabilities()).toContain("section.rename");
      expect(f.bridge.capabilities()).toContain("section.delete");

      const originalProjectId = f.bridge.session("local-native")!.projectId;
      const originalCwd = f.bridge.session("local-native")!.cwd;
      const created = await f.bridge.createSection("破甲");
      await f.bridge.moveSessionSection("local-native", created.projectId);
      expect(f.bridge.session("local-native")).toMatchObject({ projectId: created.projectId, projectName: "破甲" });

      const renamed = await f.bridge.renameSection(created.projectId, "Bridge 开发维护");
      expect(renamed).toMatchObject({ projectId: created.projectId, name: "Bridge 开发维护", kind: "desktop-group", sessionCount: 1 });
      expect(f.bridge.session("local-native")).toMatchObject({ projectId: created.projectId, projectName: "Bridge 开发维护", cwd: originalCwd });

      await f.bridge.deleteSection(created.projectId);
      expect(f.bridge.listProjects().some(project => project.projectId === created.projectId)).toBe(false);
      expect(f.bridge.session("local-native")).toMatchObject({ projectId: originalProjectId, cwd: originalCwd });

      await expect(f.bridge.renameSection(created.projectId, "Gone")).rejects.toThrow("no longer available");
      await expect(f.bridge.deleteSection(created.projectId)).rejects.toThrow("no longer available");
    } finally { await f.close(); }
  });
});

describe("Claude native relay", () => {
  const rewindUser = { type: "user", uuid: "raw-user-uuid", message: { id: "body-id-is-not-the-target", content: "Original draft" } };

  it("previews native rewind without executing either restore and preserves raw UUID arguments", async () => {
    const f = await fixture();
    try {
      f.native.page.messages = [rewindUser];
      expect(await f.bridge.previewRewind("local-native", rewindUser.uuid)).toEqual({ sessionId: "local-native", messageId: rewindUser.uuid, canRewindConversation: true, canRewindFiles: true, filesChanged: ["src/native.ts"], insertions: 4, deletions: 2 });
      expect(f.native.calls.filter(call => ["canRewindTo", "rewindFiles", "rewindV2"].includes(call.method))).toEqual([
        { method: "canRewindTo", args: ["local-native", rewindUser.uuid] },
        { method: "rewindFiles", args: ["local-native", rewindUser.uuid, true] },
      ]);
      expect(f.eventLog.replay(0)).toEqual([]);
    } finally { await f.close(); }
  });

  it.each([null, { canRewind: false, error: "No checkpoint" }, { canRewind: true, inFlight: true, filesChanged: ["pending.ts"] }])("reports unavailable file rewind preview %j", async filesPreview => {
    const f = await fixture();
    try {
      f.native.page.messages = [rewindUser];
      f.native.canRewind = false;
      f.native.filesPreview = filesPreview;
      const preview = await f.bridge.previewRewind("local-native", rewindUser.uuid);
      expect(preview).toMatchObject({ canRewindConversation: false, canRewindFiles: false, filesChanged: filesPreview?.filesChanged ?? [] });
      if (filesPreview?.error) expect(preview.fileError).toBe(filesPreview.error);
      if (filesPreview?.inFlight) expect(preview.filesInFlight).toBe(true);
    } finally { await f.close(); }
  });

  it.each(["first-user", "image-only"])("allows files-only rewind when native conversation rewind rejects %s", async kind => {
    const f = await fixture();
    try {
      f.native.page.messages = [{ ...rewindUser, ...(kind === "image-only" ? { message: { content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "aGk=" } }] } } : {}) }];
      f.native.canRewind = false;
      expect(await f.bridge.previewRewind("local-native", rewindUser.uuid)).toMatchObject({ canRewindConversation: false, canRewindFiles: true });
      f.native.calls = [];
      expect(await f.bridge.rewindSession("local-native", rewindUser.uuid, "files")).toEqual({ sessionId: "local-native", messageId: rewindUser.uuid, scope: "files" });
      expect(f.native.calls.filter(call => call.method === "rewindFiles").map(call => call.args)).toEqual([["local-native", rewindUser.uuid, true], ["local-native", rewindUser.uuid, false, true]]);
      expect(f.native.calls.some(call => ["canRewindTo", "rewindV2"].includes(call.method))).toBe(false);
      expect(f.native.page.messages).toHaveLength(1);
      expect(f.eventLog.replay(0).some(event => event.type === "session.rewound")).toBe(false);
    } finally { await f.close(); }
  });

  it.each([
    { type: "assistant", uuid: "raw-user-uuid", message: { content: "Assistant" } },
    { ...rewindUser, uuid: "other-uuid" },
    { ...rewindUser, isSidechain: true },
    { ...rewindUser, parent_tool_use_id: "child-tool" },
    { ...rewindUser, isSynthetic: true },
    { ...rewindUser, message: { content: [{ type: "tool_result", tool_use_id: "tool", content: "Result" }] } },
  ])("rejects a non-user or foreign target %j before native rewind", async target => {
    const f = await fixture();
    try {
      f.native.page.messages = [target];
      await expect(f.bridge.previewRewind("local-native", rewindUser.uuid)).rejects.toThrow(/user message/iu);
      await expect(f.bridge.rewindSession("local-native", rewindUser.uuid, "both")).rejects.toThrow(/user message/iu);
      await expect(f.bridge.previewRewind("missing-session", rewindUser.uuid)).rejects.toThrow(/session not found/iu);
      expect(f.native.calls.some(call => ["canRewindTo", "rewindFiles", "rewindV2"].includes(call.method))).toBe(false);
    } finally { await f.close(); }
  });

  it.each([{ turnRunning: true }, { hasBackgroundWork: true }, { queued: true }, { pendingToolPermissions: [{ requestId: "ask" }] }])("delegates rewind eligibility to Native while the session has activity %j", async activity => {
    const f = await fixture();
    try {
      f.native.page.messages = [{ type: "assistant", uuid: "native-anchor", message: { content: "Previous turn" } }, rewindUser];
      Object.assign(f.native.sessions[0]!, activity);
      if ("queued" in activity) {
        f.native.sendResult = { delivered: true, queued: true };
        await f.bridge.startTurn(input);
      }
      expect(await f.bridge.previewRewind("local-native", rewindUser.uuid)).toMatchObject({ canRewindConversation: true });
      expect(await f.bridge.rewindSession("local-native", rewindUser.uuid, "conversation")).toMatchObject({ messageId: rewindUser.uuid, prefill: "Original draft" });
      expect(f.native.calls.find(call => call.method === "rewindV2")?.args).toEqual(["local-native", rewindUser.uuid]);
      expect(f.native.calls.some(call => ["interrupt", "stopTask"].includes(call.method))).toBe(false);
    } finally { await f.close(); }
  });

  it("retains conversation rewind when the Native file preview is unavailable", async () => {
    const f = await fixture();
    try {
      f.native.page.messages = [rewindUser];
      f.native.filesPreviewError = new NativeCallError("File rewind unavailable");
      expect(await f.bridge.previewRewind("local-native", rewindUser.uuid)).toMatchObject({ canRewindConversation: true, canRewindFiles: false, fileError: "File rewind unavailable" });
      expect(await f.bridge.rewindSession("local-native", rewindUser.uuid, "conversation")).toMatchObject({ prefill: "Original draft" });
    } finally { await f.close(); }
  });

  it("does not hide an unexpected programming error behind a file preview status", async () => {
    const f = await fixture();
    try {
      f.native.page.messages = [rewindUser];
      f.native.filesPreviewError = new TypeError("Unexpected implementation bug");
      await expect(f.bridge.previewRewind("local-native", rewindUser.uuid)).rejects.toThrow("Unexpected implementation bug");
    } finally { await f.close(); }
  });

  it("keeps conversation projection and history intact after a files-only rewind", async () => {
    const f = await fixture();
    try {
      f.native.page.messages = [rewindUser];
      await f.message({ type: "assistant", uuid: "plan", message: { content: [{ type: "tool_use", id: "retained-plan", name: "mcp__ccd_turn__update_plan", input: { scope: "first_task", items: [{ content: "Retained work", status: "in_progress" }] } }] } });
      expect(await f.bridge.rewindSession("local-native", rewindUser.uuid, "files")).not.toHaveProperty("prefill");
      await f.message({ type: "assistant", uuid: "advance", message: { content: [{ type: "tool_use", id: "advance", name: "mcp__ccd_turn__update_plan", input: { advance: true } }] } });
      expect(f.eventLog.latestItem("local-native", "assistant.completed", "plan:retained-plan")?.data.taskPlan).toMatchObject({ id: "retained-plan", items: [{ content: "Retained work", status: "completed" }] });
      expect(f.native.page.messages).toEqual([rewindUser]);
      expect(f.eventLog.replay(0).some(event => event.type === "session.rewound")).toBe(false);
    } finally { await f.close(); }
  });

  it("rechecks selected scopes, restores files before conversation, and persists a rewind boundary", async () => {
    const f = await fixture();
    try {
      f.native.page.messages = [rewindUser];
      await f.bridge.previewRewind("local-native", rewindUser.uuid);
      f.native.calls = [];
      expect(await f.bridge.rewindSession("local-native", rewindUser.uuid, "both")).toEqual({ sessionId: "local-native", messageId: rewindUser.uuid, scope: "both", prefill: "Original draft" });
      expect(f.native.calls.filter(call => ["canRewindTo", "rewindFiles", "rewindV2"].includes(call.method))).toEqual([
        { method: "canRewindTo", args: ["local-native", rewindUser.uuid] },
        { method: "rewindFiles", args: ["local-native", rewindUser.uuid, true] },
        { method: "rewindFiles", args: ["local-native", rewindUser.uuid, false, true] },
        { method: "rewindV2", args: ["local-native", rewindUser.uuid] },
      ]);
      expect(f.eventLog.replay(0)).toMatchObject([{ type: "session.rewound", sessionId: "local-native", data: { messageId: rewindUser.uuid, scope: "both" } }]);
      const after = f.native.calls.slice(f.native.calls.findIndex(call => call.method === "rewindV2") + 1).map(call => call.method);
      expect(after).toContain("getSession");
      expect(after).toContain("getTranscriptPage");
    } finally { await f.close(); }
  });

  it("does not execute a stale conversation preview when native eligibility changes", async () => {
    const f = await fixture();
    try {
      f.native.page.messages = [rewindUser];
      await f.bridge.previewRewind("local-native", rewindUser.uuid);
      f.native.canRewind = false;
      await expect(f.bridge.rewindSession("local-native", rewindUser.uuid, "both")).rejects.toThrow(/conversation/iu);
      expect(f.native.calls.some(call => call.method === "rewindV2" || (call.method === "rewindFiles" && call.args[2] === false))).toBe(false);
    } finally { await f.close(); }
  });

  it.each([null, { canRewind: false }, { canRewind: true, error: "Restore failed" }, { canRewind: true, inFlight: true }])("blocks conversation when native file restore fails with %j", async filesRestore => {
    const f = await fixture();
    try {
      f.native.page.messages = [rewindUser];
      f.native.filesRestore = filesRestore;
      await expect(f.bridge.rewindSession("local-native", rewindUser.uuid, "both")).rejects.toThrow(/files|Restore failed/iu);
      expect(f.native.calls.some(call => call.method === "rewindV2")).toBe(false);
      expect(f.eventLog.replay(0)).toEqual([]);
    } finally { await f.close(); }
  });

  it.each([null, { canRewind: false }, { canRewind: true, error: "Checkpoint failed" }, { canRewind: true, inFlight: true }])("rechecks file eligibility before executing %j", async filesPreview => {
    const f = await fixture();
    try {
      f.native.page.messages = [rewindUser];
      f.native.filesPreview = filesPreview;
      await expect(f.bridge.rewindSession("local-native", rewindUser.uuid, "files")).rejects.toThrow();
      expect(f.native.calls.some(call => call.method === "rewindFiles" && call.args[2] === false)).toBe(false);
    } finally { await f.close(); }
  });

  it.each(["conversation", "both"] as const)("does not claim conversation success on native null (%s)", async scope => {
    const f = await fixture();
    try {
      f.native.page.messages = [rewindUser];
      f.native.conversationRewind = null;
      await expect(f.bridge.rewindSession("local-native", rewindUser.uuid, scope)).rejects.toThrow(scope === "both" ? /files.*restored.*conversation/iu : /conversation/iu);
      expect(f.eventLog.replay(0).some(event => event.type === "session.rewound")).toBe(false);
      expect(f.native.page.messages).toEqual([rewindUser]);
    } finally { await f.close(); }
  });

  it("reports partial completion if conversation throws after restoring files", async () => {
    const f = await fixture();
    try {
      f.native.page.messages = [rewindUser];
      f.native.conversationRewindError = new Error("Native conversation failed");
      await expect(f.bridge.rewindSession("local-native", rewindUser.uuid, "both")).rejects.toThrow(/files.*restored.*Native conversation failed/iu);
      expect(f.eventLog.replay(0)).toEqual([]);
    } finally { await f.close(); }
  });

  it("resets eliminated live plans and tasks after conversation rewind without reappending history", async () => {
    const f = await fixture();
    try {
      const plan = { type: "assistant", uuid: "plan-row", message: { content: [{ type: "tool_use", id: "old-plan", name: "mcp__ccd_turn__update_plan", input: { scope: "first_task", items: [{ content: "Eliminated work", status: "in_progress" }] } }] } };
      await f.message(plan);
      await f.message({ type: "system", subtype: "task_started", task_id: "removed-task", tool_use_id: "removed-tool", description: "Removed task" });
      await f.message({ type: "system", subtype: "task_notification", task_id: "removed-task", status: "completed" });
      f.native.page.messages = [rewindUser, plan];
      expect(await f.bridge.rewindSession("local-native", rewindUser.uuid, "conversation")).toMatchObject({ prefill: "Original draft" });
      expect((await f.bridge.history("local-native")).items).toEqual([]);
      expect(f.bridge.session("local-native")?.runningSubagents).toBeUndefined();
      const boundary = f.eventLog.replay(0).find(event => event.type === "session.rewound")!;
      await f.message({ type: "assistant", uuid: "orphan", message: { content: [{ type: "tool_use", id: "advance", name: "mcp__ccd_turn__update_plan", input: { advance: true } }] } });
      expect(f.eventLog.replay(boundary.seq).filter(event => event.data.taskPlan || event.type === "user.message.accepted")).toEqual([]);
    } finally { await f.close(); }
  });

  it.each(["canRewindTo", "rewindFiles", "rewindV2"])("advertises rewind and adds its UI command only when all native methods exist (missing %s)", async missing => {
    const f = await fixture();
    try {
      expect(f.bridge.capabilities()).toContain("session.rewind");
      expect((await f.bridge.commands("local-native")).commands.filter(command => command.name === "rewind")).toEqual([{ name: "rewind", description: expect.any(String), action: "rewind" }]);
      expect(await f.bridge.runCommand({ ...input, text: "/rewind" })).toEqual({ action: "rewind" });
      expect(f.native.calls.some(call => call.method === "sendMessage")).toBe(false);
      f.native.unsupported.add(missing);
      expect(f.bridge.capabilities()).not.toContain("session.rewind");
      expect((await f.bridge.commands("local-native")).commands.some(command => command.name === "rewind")).toBe(false);
      await expect(f.bridge.runCommand({ ...input, text: "/rewind" })).rejects.toThrow(/unsupported/iu);
    } finally { await f.close(); }
  });

  describe("v116 independent native boundaries", () => {
    it.each(["disconnected", "missing-method", "removed-target"] as const)("rejects an approved preview after %s before either restore", async change => {
      const f = await fixture();
      try {
        f.native.page.messages = [rewindUser];
        expect(await f.bridge.previewRewind(input.sessionId, rewindUser.uuid)).toMatchObject({ canRewindConversation: true, canRewindFiles: true });
        f.native.calls = [];
        if (change === "disconnected") f.native.ready = false;
        if (change === "missing-method") f.native.unsupported.add("rewindV2");
        if (change === "removed-target") f.native.page.messages = [];
        await expect(f.bridge.rewindSession(input.sessionId, rewindUser.uuid, "both")).rejects.toThrow(
          change === "disconnected" ? /disconnected/iu : change === "missing-method" ? /unsupported/iu : /user message/iu,
        );
        expect(f.native.calls.filter(call => ["canRewindTo", "rewindFiles", "rewindV2", "interrupt", "sendMessage"].includes(call.method))).toEqual([]);
        expect(f.eventLog.replay(0)).toEqual([]);
      } finally { await f.close(); }
    });

    it("rejects files that become in flight after an approved combined preview", async () => {
      const f = await fixture();
      try {
        f.native.page.messages = [rewindUser];
        await f.bridge.previewRewind(input.sessionId, rewindUser.uuid);
        f.native.filesPreview = { canRewind: true, inFlight: true };
        f.native.calls = [];
        await expect(f.bridge.rewindSession(input.sessionId, rewindUser.uuid, "both")).rejects.toThrow("file changes are in flight");
        expect(f.native.calls.filter(call => ["canRewindTo", "rewindFiles", "rewindV2"].includes(call.method))).toEqual([
          { method: "canRewindTo", args: [input.sessionId, rewindUser.uuid] },
          { method: "rewindFiles", args: [input.sessionId, rewindUser.uuid, true] },
        ]);
        expect(f.native.page.messages).toEqual([rewindUser]);
        expect(f.eventLog.replay(0)).toEqual([]);
      } finally { await f.close(); }
    });

    it("reports files already restored when Native rejects conversation eligibility during restoration", async () => {
      const f = await fixture();
      try {
        f.native.page.messages = [rewindUser];
        await f.bridge.previewRewind(input.sessionId, rewindUser.uuid);
        const original = f.native.call.bind(f.native);
        vi.spyOn(f.native, "call").mockImplementation(async (method, args = []) => {
          if (method === "rewindV2" && !f.native.canRewind) {
            f.native.calls.push({ method, args });
            throw new NativeCallError("Native checkpoint expired during file restore");
          }
          const result = await original(method, args);
          if (method === "rewindFiles" && args[2] === false) f.native.canRewind = false;
          return result;
        });
        f.native.calls = [];
        await expect(f.bridge.rewindSession(input.sessionId, rewindUser.uuid, "both")).rejects.toThrow("Files were restored, but conversation rewind failed: Native checkpoint expired during file restore");
        expect(f.native.calls.filter(call => ["canRewindTo", "rewindFiles", "rewindV2"].includes(call.method))).toEqual([
          { method: "canRewindTo", args: [input.sessionId, rewindUser.uuid] },
          { method: "rewindFiles", args: [input.sessionId, rewindUser.uuid, true] },
          { method: "rewindFiles", args: [input.sessionId, rewindUser.uuid, false, true] },
          { method: "rewindV2", args: [input.sessionId, rewindUser.uuid] },
        ]);
        expect(f.native.page.messages).toEqual([rewindUser]);
        expect(f.eventLog.replay(0)).toEqual([]);
      } finally { await f.close(); }
    });

    it("accepts an empty Native prefill as a successful conversation rewind", async () => {
      const f = await fixture();
      try {
        f.native.page.messages = [rewindUser];
        f.native.conversationRewind = { prefill: "" };
        expect(await f.bridge.rewindSession(input.sessionId, rewindUser.uuid, "conversation")).toEqual({ sessionId: input.sessionId, messageId: rewindUser.uuid, scope: "conversation", prefill: "" });
        expect(f.native.page.messages).toEqual([]);
        expect(f.eventLog.replay(0)).toMatchObject([{ type: "session.rewound", data: { messageId: rewindUser.uuid, scope: "conversation" } }]);
      } finally { await f.close(); }
    });

    it("preserves the live plan and queued receipt when rewindV2 rejects", async () => {
      const f = await fixture();
      try {
        f.native.page.messages = [rewindUser];
        f.native.sendResult = { delivered: true, queued: true };
        const receipt = await f.bridge.startTurn(input);
        await f.message({ type: "assistant", uuid: "preserved-plan", message: { content: [{ type: "tool_use", id: "preserved-plan", name: "mcp__ccd_turn__update_plan", input: { scope: "first_task", items: [{ content: "Keep work", status: "in_progress" }] } }] } });
        const before = f.eventLog.replay(0);
        f.native.conversationRewindError = new NativeCallError("Native rejected rewindV2");
        await expect(f.bridge.rewindSession(input.sessionId, rewindUser.uuid, "conversation")).rejects.toBe(f.native.conversationRewindError);
        expect(f.eventLog.replay(0)).toEqual(before);
        expect(f.state.nativeDesktopReceipt(input.idempotencyKey)).toMatchObject({ commandId: receipt.commandId, messageId: receipt.messageId, state: "queued" });
        expect(f.bridge.session(input.sessionId)?.pendingCommandIds).toEqual([receipt.commandId]);
        await f.message({ type: "assistant", uuid: "advance-preserved-plan", message: { content: [{ type: "tool_use", id: "advance-preserved-plan", name: "mcp__ccd_turn__update_plan", input: { advance: true } }] } });
        expect(f.eventLog.latestItem(input.sessionId, "assistant.completed", "plan:preserved-plan")?.data.taskPlan).toMatchObject({ id: "preserved-plan", items: [{ content: "Keep work", status: "completed" }] });
      } finally { await f.close(); }
    });

    it("validates the rewind UUID against the selected session transcript", async () => {
      const f = await fixture();
      try {
        f.native.sessions.push({ ...f.native.sessions[0], sessionId: "other-native" });
        await f.bridge.refreshRuntime();
        const original = f.native.call.bind(f.native);
        vi.spyOn(f.native, "call").mockImplementation((method, args = []) => {
          if (method !== "getTranscript") return original(method, args);
          f.native.calls.push({ method, args });
          return Promise.resolve(args[0] === "other-native" ? [rewindUser] : []);
        });
        await expect(f.bridge.previewRewind(input.sessionId, rewindUser.uuid)).rejects.toThrow("Rewind target must be a user message in this native session");
        expect(await f.bridge.previewRewind("other-native", rewindUser.uuid)).toMatchObject({ sessionId: "other-native", canRewindConversation: true, canRewindFiles: true });
        expect(f.native.calls.filter(call => ["canRewindTo", "rewindFiles", "rewindV2"].includes(call.method))).toEqual([
          { method: "canRewindTo", args: ["other-native", rewindUser.uuid] },
          { method: "rewindFiles", args: ["other-native", rewindUser.uuid, true] },
        ]);
      } finally { await f.close(); }
    });

    it("returns the successful combined rewind result if metadata readback disconnects", async () => {
      const f = await fixture();
      try {
        f.native.page.messages = [rewindUser];
        const original = f.native.call.bind(f.native);
        vi.spyOn(f.native, "call").mockImplementation((method, args = []) => {
          if (method === "getSession" && f.native.calls.some(call => call.method === "rewindV2")) {
            f.native.calls.push({ method, args });
            return Promise.reject(new InspectorDisconnectedError("Native readback disconnected after rewind"));
          }
          return original(method, args);
        });
        await expect(f.bridge.rewindSession(input.sessionId, rewindUser.uuid, "both")).resolves.toEqual({ sessionId: input.sessionId, messageId: rewindUser.uuid, scope: "both", prefill: "Original draft" });
        expect(f.native.page.messages).toEqual([]);
        expect(f.eventLog.replay(0)).toMatchObject([{ type: "session.rewound", sessionId: input.sessionId, data: { messageId: rewindUser.uuid, scope: "both" } }]);
        expect(f.native.calls.filter(call => call.method === "rewindV2")).toHaveLength(1);
        expect(f.native.calls.some(call => ["sendMessage", "interrupt"].includes(call.method))).toBe(false);
      } finally { await f.close(); }
    });

    it.each(["getSession", "getTranscriptPage"])("returns Native success and prefill when %s disconnects after rewind", async method => {
      const f = await fixture();
      try {
        f.native.page.messages = [rewindUser];
        const original = f.native.call.bind(f.native);
        vi.spyOn(f.native, "call").mockImplementation((called, args = []) => {
          if (called === method && f.native.calls.some(call => call.method === "rewindV2")) {
            f.native.calls.push({ method: called, args });
            return Promise.reject(new InspectorDisconnectedError("Readback disconnected after successful rewind"));
          }
          return original(called, args);
        });
        const outcome = await f.bridge.rewindSession(input.sessionId, rewindUser.uuid, "conversation")
          .then(result => ({ result }), error => ({ error }));
        expect(f.native.page.messages).toEqual([]);
        expect(f.native.calls.filter(call => call.method === "rewindV2")).toHaveLength(1);
        expect(f.eventLog.replay(0)).toMatchObject([{ type: "session.rewound" }]);
        expect(outcome).toMatchObject({ result: { sessionId: input.sessionId, messageId: rewindUser.uuid, scope: "conversation", prefill: "Original draft" } });
      } finally { await f.close(); }
    });

    it("returns files-only success if its metadata refresh disconnects", async () => {
      const f = await fixture();
      try {
        f.native.page.messages = [rewindUser];
        const original = f.native.call.bind(f.native);
        vi.spyOn(f.native, "call").mockImplementation((method, args = []) => {
          if (method === "getSession" && f.native.calls.some(call => call.method === "rewindFiles" && call.args[2] === false)) return Promise.reject(new InspectorDisconnectedError("File restore readback disconnected"));
          return original(method, args);
        });
        await expect(f.bridge.rewindSession(input.sessionId, rewindUser.uuid, "files")).resolves.toEqual({ sessionId: input.sessionId, messageId: rewindUser.uuid, scope: "files" });
        expect(f.native.page.messages).toEqual([rewindUser]);
        expect(f.eventLog.replay(0)).toEqual([]);
        expect(f.native.calls.some(call => call.method === "rewindV2")).toBe(false);
      } finally { await f.close(); }
    });

    it.each([new TypeError("Invalid refresh implementation"), new NativeCallError("Renderer context failed")])("does not swallow a non-disconnection refresh error: %s", async error => {
      const f = await fixture();
      try {
        f.native.page.messages = [rewindUser];
        const original = f.native.call.bind(f.native);
        vi.spyOn(f.native, "call").mockImplementation((method, args = []) => {
          if (method === "getSession" && f.native.calls.some(call => call.method === "rewindV2")) return Promise.reject(error);
          return original(method, args);
        });
        await expect(f.bridge.rewindSession(input.sessionId, rewindUser.uuid, "conversation")).rejects.toBe(error);
      } finally { await f.close(); }
    });

    it("does not report success when persisting the rewind boundary fails", async () => {
      const f = await fixture();
      try {
        f.native.page.messages = [rewindUser];
        const error = new Error("Event log write failed");
        vi.spyOn(f.eventLog, "append").mockRejectedValueOnce(error);
        await expect(f.bridge.rewindSession(input.sessionId, rewindUser.uuid, "conversation")).rejects.toBe(error);
        expect(f.native.calls.filter(call => call.method === "rewindV2")).toHaveLength(1);
        expect(f.eventLog.replay(0)).toEqual([]);
      } finally { await f.close(); }
    });

    it.each([
      { received: false, action: "send-now" }, { received: true, action: "send-now" },
      { received: false, action: "cancel" }, { received: true, action: "cancel" },
    ] as const)("keeps completion across received=$received, queued, and a late $action acknowledgment", async ({ received, action }) => {
      const f = await fixture();
      let release!: (accepted: boolean) => void;
      let pending: ReturnType<ClaudeDesktopBridge["steerQueuedTurn"]> | undefined;
      try {
        const receipt = await f.bridge.startTurn(input);
        if (received) await f.message({ type: "user", uuid: receipt.messageId, message: { content: input.text } });
        expect(receipt.state).toBe(received ? "session-received" : "submitted");
        const method = action === "cancel" ? "cancelQueuedMessage" : "promoteQueuedMessage";
        const original = f.native.call.bind(f.native);
        vi.spyOn(f.native, "call").mockImplementation((called, args = []) => {
          if (called !== method) return original(called, args);
          f.native.calls.push({ method: called, args });
          return new Promise(resolve => { release = resolve; });
        });
        f.native.calls = [];
        pending = action === "cancel" ? f.bridge.cancelQueuedTurn(input.sessionId, receipt.commandId) : f.bridge.steerQueuedTurn(input.sessionId, receipt.commandId);
        expect(f.native.calls).toEqual([{ method, args: [input.sessionId, receipt.messageId] }]);
        await f.message({ type: "command_lifecycle", command_uuid: receipt.messageId, state: "queued" });
        expect(f.bridge.session(input.sessionId)?.pendingCommandIds).toEqual([receipt.commandId]);
        await f.message({ type: "command_lifecycle", command_uuid: receipt.messageId, state: "started" });
        await f.message({ type: "result", user_message_uuid: receipt.messageId, is_error: false });
        const before = f.eventLog.replay(0);
        release(true);
        expect(await pending).toMatchObject({ commandId: receipt.commandId, messageId: receipt.messageId, queueMode: "steered", state: "completed" });
        expect(f.state.nativeDesktopReceipt(input.idempotencyKey)?.state).toBe("completed");
        expect(f.bridge.session(input.sessionId)?.pendingCommandIds).toEqual([]);
        expect(f.eventLog.replay(0)).toEqual(before);
        expect(f.native.calls).toEqual([{ method, args: [input.sessionId, receipt.messageId] }]);
      } finally {
        release?.(false);
        await pending?.catch(() => undefined);
        await f.close();
      }
    });

    it("keeps a rekeyed completion when cancellation of the old UUID acknowledges late", async () => {
      const f = await fixture();
      let release!: (accepted: boolean) => void;
      let pending: ReturnType<ClaudeDesktopBridge["cancelQueuedTurn"]> | undefined;
      try {
        f.native.sendResult = { delivered: true, queued: true };
        const receipt = await f.bridge.startTurn(input);
        const oldUuid = receipt.messageId;
        const original = f.native.call.bind(f.native);
        vi.spyOn(f.native, "call").mockImplementation((method, args = []) => {
          if (method !== "cancelQueuedMessage") return original(method, args);
          f.native.calls.push({ method, args });
          return new Promise(resolve => { release = resolve; });
        });
        f.native.calls = [];
        pending = f.bridge.cancelQueuedTurn(input.sessionId, receipt.commandId);
        const changed = once(f.bridge, "changed");
        f.native.emit("event", { type: "steers_rekeyed", sessionId: input.sessionId, rekeyedSteers: [{ from: oldUuid, to: "v116-rekeyed" }] });
        await changed;
        await f.message({ type: "result", user_message_uuid: "v116-rekeyed", is_error: false });
        const before = f.eventLog.replay(0);
        release(true);
        expect(await pending).toMatchObject({ messageId: "v116-rekeyed", state: "completed" });
        expect(f.state.nativeDesktopReceipt(input.idempotencyKey)).toMatchObject({ messageId: "v116-rekeyed", state: "completed" });
        expect(f.eventLog.replay(0)).toEqual(before);
        expect(f.native.calls).toEqual([{ method: "cancelQueuedMessage", args: [input.sessionId, oldUuid] }]);
      } finally {
        release?.(false);
        await pending?.catch(() => undefined);
        await f.close();
      }
    });

    it.each(["started", "completed", "failed", "close"] as const)("isolates foreign %s evidence when both sessions own the same UUID", async state => {
      const f = await fixture();
      try {
        f.native.sessions.push({ ...f.native.sessions[0], sessionId: "other-native" });
        await f.bridge.refreshRuntime();
        f.native.sendResult = { delivered: true, queued: true };
        const local = await f.bridge.startTurn(input);
        const foreign = await f.bridge.startTurn({ ...input, sessionId: "other-native", requestId: "v116-foreign", idempotencyKey: "v116-foreign" });
        let changed = once(f.bridge, "changed");
        f.native.emit("event", { type: "steers_rekeyed", sessionId: "other-native", rekeyedSteers: [{ from: foreign.messageId, to: local.messageId }] });
        await changed;
        changed = once(f.bridge, "changed");
        f.native.emit("event", state === "close"
          ? { type: "close", sessionId: "other-native", withdrawnUuids: [local.messageId], lostUuids: [] }
          : { type: "message", sessionId: "other-native", message: state === "started"
            ? { type: "command_lifecycle", command_uuid: local.messageId, state }
            : { type: "result", user_message_uuid: local.messageId, is_error: state === "failed" } });
        await changed;
        expect(f.state.nativeDesktopReceipt(input.idempotencyKey)).toMatchObject({ messageId: local.messageId, state: "queued" });
        expect(f.state.nativeDesktopReceipt("v116-foreign")).toMatchObject({ messageId: local.messageId, state: state === "close" ? "cancelled" : state === "started" ? "running" : state });
        expect(f.bridge.session(input.sessionId)?.pendingCommandIds).toEqual([local.commandId]);
        expect(f.bridge.session("other-native")?.pendingCommandIds).toEqual([]);
        expect(f.eventLog.turnEvidence({ sessionId: input.sessionId, messageId: local.messageId }).terminal).toBeUndefined();
      } finally { await f.close(); }
    });

    it.each(["close", "held_input_withdrawn"] as const)("keeps %s withdrawal terminal through late echo, lifecycle, and restart", async type => {
      const f = await fixture();
      let restarted: ClaudeDesktopBridge | undefined;
      try {
        f.native.sendResult = { delivered: true, queued: true };
        const receipt = await f.bridge.startTurn(input);
        const changed = once(f.bridge, "changed");
        f.native.emit("event", { type, sessionId: input.sessionId, withdrawnUuids: [receipt.messageId] });
        await changed;
        for (const state of ["queued", "started", "completed", "failed", "cancelled", "interrupted"]) {
          await f.message({ type: "command_lifecycle", command_uuid: receipt.messageId, state });
          expect(f.state.nativeDesktopReceipt(input.idempotencyKey)?.state).toBe("cancelled");
        }
        await f.message({ type: "user", uuid: receipt.messageId, message: { content: input.text } });
        expect(f.state.nativeDesktopReceipt(input.idempotencyKey)?.state).toBe("cancelled");
        await f.bridge.close();
        const restoredNative = new NativeDesktop();
        restarted = new ClaudeDesktopBridge({ ...f.options, inspector: restoredNative });
        await restarted.initialize();
        restoredNative.calls = [];
        await expect(restarted.steerQueuedTurn(input.sessionId, receipt.commandId)).rejects.toThrow("当前不可调整");
        await expect(restarted.cancelQueuedTurn(input.sessionId, receipt.commandId)).rejects.toThrow("当前不可调整");
        expect(restarted.session(input.sessionId)?.pendingCommandIds).toEqual([]);
        expect(f.state.nativeDesktopReceipt(input.idempotencyKey)?.state).toBe("cancelled");
        expect(restoredNative.calls).toEqual([]);
      } finally { await restarted?.close(); await f.close(); }
    });

    // Conflicting Native evidence has no verified production sequence yet; keep these probes opt-in.
    it.runIf(process.env.BRIDGE_NATIVE_CONFLICT_PROBES === "1").each([false, true])("probe: keeps close withdrawal terminal after a late result (error=%s)", async isError => {
      const f = await fixture();
      try {
        f.native.sendResult = { delivered: true, queued: true };
        const receipt = await f.bridge.startTurn(input);
        const changed = once(f.bridge, "changed");
        f.native.emit("event", { type: "close", sessionId: input.sessionId, withdrawnUuids: [receipt.messageId], lostUuids: [] });
        await changed;
        expect(f.state.nativeDesktopReceipt(input.idempotencyKey)?.state).toBe("cancelled");
        await f.message({ type: "result", user_message_uuid: receipt.messageId, is_error: isError });
        expect(f.state.nativeDesktopReceipt(input.idempotencyKey)?.state).toBe("cancelled");
      } finally { await f.close(); }
    });

    it.runIf(process.env.BRIDGE_NATIVE_CONFLICT_PROBES === "1").each(["completed", "close-withdrawn"] as const)("probe: retains %s evidence after a late send refusal", async terminal => {
      const f = await fixture();
      let release!: (result: unknown) => void;
      f.native.sendReply = new Promise(resolve => { release = resolve; });
      const sending = f.bridge.startTurn(input);
      const outcome = sending.then(receipt => ({ receipt }), error => ({ error }));
      try {
        await vi.waitFor(() => expect(f.native.calls.some(call => call.method === "sendMessage")).toBe(true));
        const receipt = f.state.nativeDesktopReceipt(input.idempotencyKey)!;
        if (terminal === "completed") await f.message({ type: "result", user_message_uuid: receipt.messageId, is_error: false });
        else {
          const changed = once(f.bridge, "changed");
          f.native.emit("event", { type: "close", sessionId: input.sessionId, withdrawnUuids: [receipt.messageId], lostUuids: [] });
          await changed;
        }
        const state = terminal === "completed" ? "completed" : "cancelled";
        expect(f.state.nativeDesktopReceipt(input.idempotencyKey)?.state).toBe(state);
        release({ delivered: false, reason: "Native send response arrived after terminal evidence" });
        const settled = await outcome;
        expect.soft(f.state.nativeDesktopReceipt(input.idempotencyKey)?.state).toBe(state);
        expect.soft(settled).toMatchObject({ receipt: { commandId: receipt.commandId, state } });
        expect(f.native.calls.filter(call => call.method === "sendMessage")).toHaveLength(1);
        expect(f.bridge.session(input.sessionId)?.pendingCommandIds).toEqual([]);
      } finally {
        release({ delivered: true });
        await outcome;
        await f.close();
      }
    });
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
      const controller = Object.assign(Object.create(DesktopController.prototype), { broker: f.bridge, evidence, allSessions: () => f.bridge.listSessions() });
      for (const path of [relativePath, `./${relativePath}`, `${relativePath}:12:3`, join(readCwd, relativePath)]) {
        const { transfer } = await controller.handleRequest({ kind: "request", requestId: "preview", idempotencyKey: "preview", method: "artifact.transfer.open", params: { sessionId: "local-native", path, purpose: "text-preview" } }, "mobile", "phone");
        expect(transfer).toMatchObject({ name: "report.json", mimeType: "text/plain" });
        expect(Buffer.from(evidence.readTransfer(transfer.transferId, 0, "phone").data, "base64").toString()).toBe("{\"source\":\"execution directory\"}");
        evidence.closeTransfer(transfer.transferId, "phone");
      }
      expect(f.bridge.session("local-native")?.cwd).toBe(project);
      expect(f.bridge.listProjects()[0]?.cwd).toBe(project);
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

  it("does not label an unknown native alias as an unrelated saved model", async () => {
    const f = await fixture();
    try {
      const alias = "mythos-magpie-0000000000";
      f.native.sessions[0]!.model = alias;
      await writeFile(f.options.settingsPath, JSON.stringify({ modelPicker: { options: [
        { model: "fixture-provider/model-alpha", label: "Unrelated model" },
      ] } }));
      await f.bridge.refreshRuntime();
      expect(f.bridge.session("local-native")?.modelDisplayName).toBe(alias);
      expect(await f.bridge.configuration("local-native")).toMatchObject({ model: alias, modelDisplayName: alias });
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

  it("persists queued, started and correlated results on exact UUID history snapshots across restarts", async () => {
    const f = await fixture();
    let restarted: ClaudeDesktopBridge | undefined;
    try {
      const first = await f.bridge.startTurn(input);
      const second = await f.bridge.startTurn({ ...input, idempotencyKey: "second", requestId: "second" });
      f.native.page.messages = [first, second].map(receipt => ({ type: "user", uuid: receipt.messageId, message: { content: "hello" } }));
      await f.message({ type: "command_lifecycle", command_uuid: first.commandId, state: "queued" });
      expect(f.state.nativeDesktopReceipt("key")?.state).toBe("submitted");
      await f.message({ type: "command_lifecycle", command_uuid: first.messageId, state: "queued" });
      expect(f.state.nativeDesktopReceipt("key")?.state).toBe("queued");
      expect((await f.bridge.history("local-native")).items[0]).toMatchObject({ delivery: "queued", commandId: first.commandId, requestId: first.requestId });
      await f.message({ type: "command_lifecycle", command_uuid: first.messageId, state: "started" });
      await f.message({ type: "user", uuid: first.messageId, message: { content: "hello" } });
      expect(f.eventLog.latestItem("local-native", "user.message.accepted", first.messageId)?.data.delivery).toBe("running");
      expect((await f.bridge.history("local-native")).items[0]?.delivery).toBe("running");
      await f.message({ type: "result", uuid: "uncorrelated", is_error: false });
      expect(f.state.nativeDesktopReceipt("key")?.state).toBe("running");
      expect(f.state.nativeDesktopReceipt("second")?.state).toBe("submitted");
      await f.message({ type: "result", uuid: "correlated", user_message_uuids: [first.messageId], is_error: false });
      await f.message({ type: "command_lifecycle", command_uuid: first.messageId, state: "queued" });
      await f.bridge.close();
      restarted = new ClaudeDesktopBridge(f.options);
      await restarted.initialize();
      expect((await restarted.history("local-native")).items.map(item => item.delivery)).toEqual(["completed", "submitted"]);
    } finally { await restarted?.close(); await f.close(); }
  });

  it("broadcasts unmatched native results without inventing Bridge command identities or receipts", async () => {
    const f = await fixture();
    try {
      const user = { type: "user", uuid: "desktop-input", message: { content: "desktop text" } };
      f.native.page.messages = [user, { ...user, uuid: "unobserved" }];
      await f.message(user);
      await f.message({ type: "command_lifecycle", command_uuid: "desktop-input", state: "queued" });
      await f.message({ type: "command_lifecycle", command_uuid: "desktop-input", state: "started" });
      await f.message({ type: "result", uuid: "desktop-result", user_message_uuid: "desktop-input", is_error: false });
      expect((await f.bridge.history("local-native")).items.map(item => item.delivery)).toEqual([undefined, undefined]);
      expect(f.state.listNativeDesktopReceipts()).toEqual([]);
      const terminal = f.eventLog.replay(0).filter(event => event.type === "turn.completed");
      expect(terminal).toHaveLength(1);
      expect(terminal[0]).toMatchObject({ sessionId: "local-native", itemId: "desktop-result", data: {} });
      expect(terminal[0]?.turnId).toBeUndefined();
    } finally { await f.close(); }
  });

  it("accepts a true failure result after the matching lifecycle reported completion", async () => {
    const f = await fixture();
    try {
      const receipt = await f.bridge.startTurn(input);
      await f.message({ type: "command_lifecycle", command_uuid: receipt.messageId, state: "completed" });
      expect(f.state.nativeDesktopReceipt("key")?.state).toBe("completed");
      await f.message({ type: "result", uuid: "failed-result", user_message_uuid: receipt.messageId, is_error: true, result: "native execution failed" });
      expect(f.state.nativeDesktopReceipt("key")?.state).toBe("failed");
      await f.message({ type: "command_lifecycle", command_uuid: receipt.messageId, state: "completed" });
      expect(f.state.nativeDesktopReceipt("key")?.state).toBe("failed");
      expect(f.eventLog.turnEvidence({ sessionId: input.sessionId, messageId: receipt.messageId }).terminal).toBe("failed");
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
      expect(f.state.loadBrokerState().pending[0]?.commandId).toBe("old-command");
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

  it("persists idempotent receipts without inventing execution acknowledgments", async () => {
    const f = await fixture();
    let restarted: ClaudeDesktopBridge | undefined;
    try {
      const first = await f.bridge.startTurn(input);
      expect(first.state).toBe("submitted");
      expect(f.native.calls.filter(call => call.method === "sendMessage")).toHaveLength(1);
      const send = f.native.calls.find(call => call.method === "sendMessage")!;
      expect(send.args[7]).toBe(first.messageId);
      expect(send.args[14]).toEqual({ personSent: true, rejectUndelivered: true });
      await f.bridge.close();
      restarted = new ClaudeDesktopBridge(f.options);
      await restarted.initialize();
      expect((await restarted.startTurn(input)).commandId).toBe(first.commandId);
      expect(f.native.calls.filter(call => call.method === "sendMessage")).toHaveLength(1);
      expect(f.eventLog.replay(0).some(event => event.type === "turn.started")).toBe(false);
    } finally { await restarted?.close(); await f.close(); }
  });

  it("accepts only the exact native UUID and keeps later commands after a result", async () => {
    const f = await fixture();
    try {
      const receipt = await f.bridge.startTurn(input);
      await f.message({ type: "user", uuid: "other-input", message: { content: "hello" } });
      expect(f.state.nativeDesktopReceipt("key")?.state).toBe("submitted");
      await f.message({ type: "user", uuid: receipt.messageId, message: { content: "hello" } });
      expect(f.state.nativeDesktopReceipt("key")?.state).toBe("session-received");
      const later = await f.bridge.startTurn({ ...input, idempotencyKey: "later", requestId: "later" });
      await f.message({ type: "result", uuid: "result", subtype: "success", is_error: false });
      expect(f.state.nativeDesktopReceipt("later")?.messageId).toBe(later.messageId);
      expect(f.state.nativeDesktopReceipt("later")?.state).toBe("submitted");
    } finally { await f.close(); }
  });

  it("settles only UUIDs explicitly named by native lifecycle and result messages", async () => {
    const f = await fixture();
    try {
      const receipt = await f.bridge.startTurn(input);
      await f.message({ type: "user", uuid: receipt.messageId, message: { content: "hello" } });
      await f.message({ type: "command_lifecycle", command_uuid: receipt.messageId, state: "started", uuid: "start-event" });
      expect(f.state.nativeDesktopReceipt("key")?.state).toBe("running");
      await f.message({ type: "user", uuid: receipt.messageId, message: { content: "hello" } });
      expect(f.state.nativeDesktopReceipt("key")?.state).toBe("running");
      const later = await f.bridge.startTurn({ ...input, idempotencyKey: "next", requestId: "next" });
      await f.message({ type: "result", uuid: "native-result", is_error: false, user_message_uuid: receipt.messageId, user_message_uuids: [receipt.messageId] });
      expect(f.state.nativeDesktopReceipt("key")?.state).toBe("completed");
      expect(f.eventLog.turnEvidence({ sessionId: "local-native", messageId: receipt.messageId }).terminal).toBe("completed");
      expect(f.state.nativeDesktopReceipt("next")?.messageId).toBe(later.messageId);
      expect(f.state.nativeDesktopReceipt("next")?.state).toBe("submitted");
    } finally { await f.close(); }
  });

  it("retains uncertain delivery and never automatically retries it", async () => {
    const f = await fixture();
    try {
      f.native.sendError = new InspectorDisconnectedError("connection lost after submission");
      expect((await f.bridge.startTurn(input)).state).toBe("uncertain");
      f.native.sendError = undefined;
      await f.bridge.refreshRuntime();
      expect((await f.bridge.startTurn(input)).state).toBe("uncertain");
      expect(f.native.calls.filter(call => call.method === "sendMessage")).toHaveLength(1);
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

  it("derives native history cursors from the oldest raw UUID", async () => {
    const f = await fixture();
    try {
      f.native.page = { messages: [{ type: "system", uuid: "oldest-control" }, { type: "assistant", uuid: "row", message: { id: "api-message", content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "Visible" }] } }], hasMore: true };
      f.native.pages.set("oldest-control", { messages: [], hasMore: false });
      const page = await f.bridge.history("local-native", undefined, 2);
      expect(page.nextCursor).toBe("oldest-control");
      expect(page.items).toMatchObject([{ id: "api-message", text: "Visible" }]);
      await f.bridge.history("local-native", page.nextCursor, 2);
      expect(f.native.calls.at(-1)?.args[1]).toBe("oldest-control");
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

  it("refreshes one session configuration without refreshing the entire directory", async () => {
    const f = await fixture();
    try {
      f.options.scanCatalog.mockClear();
      f.native.calls = [];
      await f.bridge.refreshDesktopConfiguration("local-native");
      expect(f.native.calls).toContainEqual({ method: "getSession", args: ["local-native"] });
      expect(f.native.calls.some(call => call.method === "getAll")).toBe(false);
      expect(f.options.scanCatalog).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it("keeps task detail reads optional and lets conversation opening finish independently", async () => {
    const f = await fixture();
    try {
      const controller = Object.assign(Object.create(DesktopController.prototype), { broker: f.bridge, eventLog: f.eventLog, allSessions: () => f.bridge.listSessions() });
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
      expect(opened.history.items).toEqual([]);
      release(tasks);
      expect((await pending).session.backgroundTasks).toEqual(tasks);
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
      expect(f.state.loadBrokerState().sessions).toEqual([]);
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

  it("keeps a persisted tool identity when its completion arrives after Bridge restarts", async () => {
    const f = await fixture();
    let restarted: ClaudeDesktopBridge | undefined;
    try {
      await f.message({ type: "assistant", uuid: "restart-call", message: { content: [{ type: "tool_use", id: "restart-tool", name: "Read", input: { file_path: "/project/restart.ts" } }] } });
      await f.bridge.close();
      restarted = new ClaudeDesktopBridge(f.options);
      await restarted.initialize();
      const changed = once(restarted, "changed");
      f.native.emit("event", { type: "message", sessionId: "local-native", message: { type: "user", uuid: "restart-result", message: { content: [{ type: "tool_result", tool_use_id: "restart-tool", content: "Finished" }] } } });
      await changed;
      expect(f.eventLog.latestItem("local-native", "tool.completed", "restart-tool")?.data).toMatchObject({ toolName: "Read", text: expect.stringContaining("/project/restart.ts") });
    } finally { await restarted?.close(); await f.close(); }
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

  it("recovers a history plan after an ordinary live assistant message initialized the projection", async () => {
    const f = await fixture();
    try {
      await f.message({ type: "assistant", uuid: "ordinary", timestamp: 20, message: { content: [{ type: "text", text: "Continuing work" }] } });
      f.native.page.messages = [planMessage("history-plan", { scope: "first_task", items: [{ content: "Read", status: "in_progress" }, { content: "Verify", status: "pending" }] }, 10)];
      await f.bridge.history("local-native");
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

  it("restores only plan context across multiple pages and stops at the nearest top-level new_task", async () => {
    const f = await fixture();
    try {
      const old = planMessage("older-plan", { scope: "first_task", items: [{ content: "Old work", status: "in_progress" }] }, 1);
      const initial = planMessage("current-plan", { scope: "new_task", items: [{ content: "Read", status: "in_progress" }, { content: "Verify", status: "pending" }] }, 10);
      const child = { ...planMessage("child-initial", { scope: "first_task", items: [{ content: "Child", status: "in_progress" }] }, 15), isSidechain: true };
      const continuation = planMessage("continued", { scope: "continuation", items: [{ content: "Read", status: "in_progress" }, { content: "Verify", status: "pending" }] }, 20);
      const text = { type: "assistant", uuid: "latest-text", timestamp: 25, message: { content: [{ type: "text", text: "Visible latest text" }] } };
      const advance = planMessage("latest-advance", { advance: true }, 30);
      f.native.pages.set("", { messages: [text, advance], hasMore: true });
      f.native.pages.set("latest-text", { messages: [child, continuation], hasMore: true });
      f.native.pages.set("child-initial", { messages: [old, initial], hasMore: true });
      const latest = await f.bridge.history("local-native", undefined, 2);
      expect(latest).toMatchObject({ hasMore: true, nextCursor: "latest-text", items: [
        { id: "latest-text", text: "Visible latest text" },
        { id: "plan:current-plan", taskPlan: { id: "current-plan", items: [{ content: "Read", status: "completed" }, { content: "Verify", status: "in_progress" }] } },
      ] });
      expect(latest.items).toHaveLength(2);
      expect(f.native.calls.filter(call => call.method === "getTranscriptPage").map(call => call.args[1])).toEqual(["", "latest-text", "child-initial"]);
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
      const history = await f.bridge.history("local-native", undefined, 1);
      expect(history.items).toEqual([]);
      expect(history.nextCursor).toBe("orphan-advance");
      expect(f.native.calls.filter(call => call.method === "getTranscriptPage").map(call => call.args[1])).toEqual(["", "orphan-advance"]);
      await f.message(planMessage("later-orphan", { advance: true }, 40));
      expect(f.eventLog.replay(0).filter(event => event.data.taskPlan)).toEqual([]);
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

  it.each([false, true])("projects native queued acceptance after an early echo (%s)", async echo => {
    const f = await fixture();
    let resolveSend!: (result: unknown) => void;
    f.native.sendReply = new Promise(resolve => { resolveSend = resolve; });
    const sending = f.bridge.startTurn(input);
    try {
      await vi.waitFor(() => expect(f.native.calls.some(call => call.method === "sendMessage")).toBe(true));
      const messageId = f.state.nativeDesktopReceipt(input.idempotencyKey)!.messageId;
      if (echo) await f.message({ type: "user", uuid: messageId, message: { content: "hello" } });
      resolveSend({ delivered: true, queued: true });
      const receipt = await sending;
      expect(receipt).toMatchObject({ state: "queued", queueMode: "deferred" });
      expect(f.state.nativeDesktopReceipt(input.idempotencyKey)).toMatchObject(receipt);
      expect(f.bridge.session(input.sessionId)).toMatchObject({ pendingCount: 1, pendingCommandIds: [receipt.commandId] });
      expect(f.eventLog.replay(0).at(-1)).toMatchObject({ type: "message.delivery", data: { delivery: "queued", commandId: receipt.commandId, messageId } });
    } finally { resolveSend({ delivered: true }); await sending; await f.close(); }
  });

  it.each(["queued", "started", "cancelled"])("preserves early native %s when queued acceptance arrives last", async state => {
    const f = await fixture();
    let resolveSend!: (result: unknown) => void;
    f.native.sendReply = new Promise(resolve => { resolveSend = resolve; });
    const sending = f.bridge.startTurn(input);
    try {
      await vi.waitFor(() => expect(f.native.calls.some(call => call.method === "sendMessage")).toBe(true));
      const messageId = f.state.nativeDesktopReceipt(input.idempotencyKey)!.messageId;
      await f.message({ type: "command_lifecycle", command_uuid: messageId, state });
      resolveSend({ delivered: true, queued: true });
      const receipt = await sending;
      expect(receipt.state).toBe(state === "started" ? "running" : state);
      if (state === "queued") expect(receipt).toMatchObject({ queueMode: "steered" });
      expect(f.bridge.session(input.sessionId)?.pendingCommandIds).toEqual(state === "queued" ? [receipt.commandId] : []);
    } finally { resolveSend({ delivered: true }); await sending; await f.close(); }
  });

  it("does not infer queued from a successful immediate steer", async () => {
    const f = await fixture();
    try {
      f.native.sessions[0]!.turnRunning = true;
      await f.bridge.refreshRuntime();
      expect((await f.bridge.steerTurn(input)).state).toBe("submitted");
      expect(f.bridge.session(input.sessionId)?.pendingCount).toBe(0);
    } finally { await f.close(); }
  });

  it("surfaces explicit native refusal instead of reporting a successful send", async () => {
    const f = await fixture();
    try {
      f.native.sendResult = { delivered: false, reason: "Target session was archived" };
      await expect(f.bridge.startTurn(input)).rejects.toThrow("Target session was archived");
      expect(f.state.nativeDesktopReceipt(input.idempotencyKey)).toMatchObject({ state: "failed", error: "Target session was archived" });
    } finally { await f.close(); }
  });

  it.each(["normal", "immediate"])("persists the %s send route before Native replies", async send => {
    const f = await fixture();
    let resolveSend!: (value: unknown) => void;
    f.native.sendReply = new Promise(resolve => { resolveSend = resolve; });
    const sending = send === "immediate" ? f.bridge.steerTurn(input) : f.bridge.startTurn(input);
    try {
      await vi.waitFor(() => expect(f.native.calls.some(call => call.method === "sendMessage")).toBe(true));
      expect(f.state.nativeDesktopReceipt(input.idempotencyKey)).toMatchObject({ state: "dispatching", queueMode: send === "immediate" ? "steered" : "deferred" });
    } finally { resolveSend({ delivered: true }); await sending; await f.close(); }
  });

  it.each([
    { send: "normal", action: "send-now" }, { send: "immediate", action: "send-now" }, { send: "legacy", action: "send-now" },
    { send: "normal", action: "cancel" }, { send: "immediate", action: "cancel" }, { send: "legacy", action: "cancel" },
  ])("allows $action for a $send received message without a native queued flag", async ({ send, action }) => {
    const f = await fixture();
    try {
      f.native.sessions[0]!.turnRunning = true;
      f.native.sendResult = { delivered: true };
      await f.bridge.refreshRuntime();
      const receipt = send === "immediate" ? await f.bridge.steerTurn(input) : await f.bridge.startTurn(input);
      await f.message({ type: "user", uuid: receipt.messageId, message: { content: input.text } });
      expect(receipt.state).toBe("session-received");
      expect(f.bridge.session(input.sessionId)?.pendingCount).toBe(0);
      if (send === "legacy") { delete receipt.queueMode; f.state.saveNativeDesktopReceipt(receipt); }
      const method = action === "send-now" ? send === "immediate" ? "sendSteeredNow" : "promoteQueuedMessage" : "cancelQueuedMessage";
      const operate = () => action === "send-now" ? f.bridge.steerQueuedTurn(input.sessionId, receipt.commandId) : f.bridge.cancelQueuedTurn(input.sessionId, receipt.commandId);
      f.native.calls = [];
      if (send === "legacy" && action === "send-now") {
        await expect(operate()).rejects.toThrow("发送通道");
        expect(f.native.calls).toEqual([]);
        return;
      }
      f.native.queueResult = false;
      await expect(operate()).rejects.toThrow(action === "send-now" ? "无法立即发送" : "无法撤回");
      expect(receipt.state).toBe("session-received");
      expect(f.native.calls).toEqual([{ method, args: [input.sessionId, receipt.messageId] }]);
      f.native.queueResult = true;
      expect(await operate()).toMatchObject({ commandId: receipt.commandId, state: action === "send-now" ? "session-received" : "cancelled" });
      expect(f.native.calls).toEqual([{ method, args: [input.sessionId, receipt.messageId] }, { method, args: [input.sessionId, receipt.messageId] }]);
      expect(f.native.calls.some(call => ["sendMessage", "interrupt"].includes(call.method))).toBe(false);
    } finally { await f.close(); }
  });

  it.each(["deferred", "steered"] as const)("uses the native %s Send now operation and checks its result", async mode => {
    const f = await fixture();
    try {
      f.native.sendResult = { delivered: true, queued: true };
      const receipt = await f.bridge.startTurn(input);
      if (mode === "steered") await f.message({ type: "command_lifecycle", command_uuid: receipt.messageId, state: "queued" });
      f.native.calls = [];
      await f.bridge.steerQueuedTurn(input.sessionId, receipt.commandId);
      const method = mode === "deferred" ? "promoteQueuedMessage" : "sendSteeredNow";
      expect(f.native.calls).toEqual([{ method, args: [input.sessionId, receipt.messageId] }]);
      f.native.queueResult = false;
      await expect(f.bridge.steerQueuedTurn(input.sessionId, receipt.commandId)).rejects.toThrow("无法立即发送");
      expect(f.native.calls.map(call => call.method)).toEqual([method, method]);
      expect(f.state.nativeDesktopReceipt(input.idempotencyKey)?.state).toBe("queued");
    } finally { await f.close(); }
  });

  it.each([false, true])("withdraws only the selected native UUID when cancellation succeeds (%s)", async accepted => {
    const f = await fixture();
    try {
      f.native.sendResult = { delivered: true, queued: true };
      const receipt = await f.bridge.startTurn(input);
      f.native.calls = [];
      f.native.queueResult = accepted;
      if (accepted) {
        expect(await f.bridge.cancelQueuedTurn(input.sessionId, receipt.commandId)).toMatchObject({ commandId: receipt.commandId, state: "cancelled" });
        expect(f.bridge.session(input.sessionId)).toMatchObject({ pendingCount: 0, pendingCommandIds: [] });
        expect(f.eventLog.replay(0).at(-1)).toMatchObject({ type: "message.delivery", data: { delivery: "cancelled", commandId: receipt.commandId } });
      } else {
        await expect(f.bridge.cancelQueuedTurn(input.sessionId, receipt.commandId)).rejects.toThrow("无法撤回");
        expect(f.state.nativeDesktopReceipt(input.idempotencyKey)?.state).toBe("queued");
      }
      expect(f.native.calls).toEqual([{ method: "cancelQueuedMessage", args: [input.sessionId, receipt.messageId] }]);
    } finally { await f.close(); }
  });

  it("rejects actions for a foreign session or an already consumed command before native calls", async () => {
    const f = await fixture();
    try {
      f.native.sendResult = { delivered: true, queued: true };
      const receipt = await f.bridge.startTurn(input);
      f.native.calls = [];
      await expect(f.bridge.steerQueuedTurn("other-session", receipt.commandId)).rejects.toThrow();
      await expect(f.bridge.cancelQueuedTurn("other-session", receipt.commandId)).rejects.toThrow();
      await f.message({ type: "command_lifecycle", command_uuid: receipt.messageId, state: "started" });
      await expect(f.bridge.steerQueuedTurn(input.sessionId, receipt.commandId)).rejects.toThrow();
      await expect(f.bridge.cancelQueuedTurn(input.sessionId, receipt.commandId)).rejects.toThrow();
      expect(f.native.calls).toEqual([]);
    } finally { await f.close(); }
  });

  it("persists rekeyed native identity and follows the new UUID through withdrawal and completion", async () => {
    const f = await fixture();
    try {
      f.native.sendResult = { delivered: true, queued: true };
      const receipt = await f.bridge.startTurn(input);
      const previousMessageId = receipt.messageId;
      const changed = once(f.bridge, "changed");
      f.native.emit("event", { type: "steers_rekeyed", sessionId: input.sessionId, rekeyedSteers: [{ from: previousMessageId, to: "native-rekeyed" }] });
      await changed;
      expect(f.state.nativeDesktopReceipt(input.idempotencyKey)).toMatchObject({ commandId: receipt.commandId, requestId: input.requestId, messageId: "native-rekeyed" });
      expect(f.eventLog.replay(0).at(-1)).toMatchObject({ type: "message.delivery", itemId: "native-rekeyed", data: { previousMessageId, messageId: "native-rekeyed", commandId: receipt.commandId } });
      f.native.calls = [];
      f.native.queueResult = false;
      await expect(f.bridge.cancelQueuedTurn(input.sessionId, receipt.commandId)).rejects.toThrow();
      expect(f.native.calls).toEqual([{ method: "cancelQueuedMessage", args: [input.sessionId, "native-rekeyed"] }]);
      await f.message({ type: "command_lifecycle", command_uuid: "native-rekeyed", state: "started" });
      await f.message({ type: "result", user_message_uuid: "native-rekeyed", is_error: false });
      expect(f.state.nativeDesktopReceipt(input.idempotencyKey)).toMatchObject({ state: "completed", messageId: "native-rekeyed" });
    } finally { await f.close(); }
  });

  it.each([
    { withdrawn: true, lost: false, state: "cancelled" },
    { withdrawn: false, lost: true, state: "queued" },
    { withdrawn: true, lost: true, state: "queued" },
  ])("handles Native close withdrawal without confusing lost inputs ($withdrawn/$lost)", async ({ withdrawn, lost, state }) => {
    const f = await fixture();
    try {
      f.native.sendResult = { delivered: true, queued: true };
      const receipt = await f.bridge.startTurn(input);
      const changed = once(f.bridge, "changed");
      f.native.emit("event", { type: "close", sessionId: input.sessionId, code: 0, ...(withdrawn ? { withdrawnUuids: [receipt.messageId] } : {}), ...(lost ? { lostUuids: [receipt.messageId] } : {}) });
      await changed;
      expect(f.state.nativeDesktopReceipt(input.idempotencyKey)?.state).toBe(state);
      expect(f.bridge.session(input.sessionId)?.pendingCount).toBe(state === "queued" ? 1 : 0);
    } finally { await f.close(); }
  });

  it("retains Desktop withdrawal that arrives before queued send acceptance", async () => {
    const f = await fixture();
    let resolveSend!: (result: unknown) => void;
    f.native.sendReply = new Promise(resolve => { resolveSend = resolve; });
    const sending = f.bridge.startTurn(input);
    try {
      await vi.waitFor(() => expect(f.native.calls.some(call => call.method === "sendMessage")).toBe(true));
      const messageId = f.state.nativeDesktopReceipt(input.idempotencyKey)!.messageId;
      const changed = once(f.bridge, "changed");
      f.native.emit("event", { type: "held_input_withdrawn", sessionId: input.sessionId, withdrawnUuids: [messageId] });
      await changed;
      resolveSend({ delivered: true, queued: true });
      expect((await sending).state).toBe("cancelled");
      expect(f.bridge.session(input.sessionId)?.pendingCount).toBe(0);
    } finally { resolveSend({ delivered: true }); await sending; await f.close(); }
  });

  it("observes Desktop withdrawal only for explicit withdrawn UUIDs", async () => {
    const f = await fixture();
    try {
      f.native.sendResult = { delivered: true, queued: true };
      const first = await f.bridge.startTurn(input);
      const second = await f.bridge.startTurn({ ...input, requestId: "second", idempotencyKey: "second" });
      const changed = once(f.bridge, "changed");
      f.native.emit("event", { type: "held_input_withdrawn", sessionId: input.sessionId, withdrawnUuids: [first.messageId], lostUuids: [second.messageId] });
      await changed;
      expect(f.state.nativeDesktopReceipt(input.idempotencyKey)?.state).toBe("cancelled");
      expect(f.state.nativeDesktopReceipt("second")?.state).toBe("queued");
      expect(f.bridge.session(input.sessionId)?.pendingCommandIds).toEqual([second.commandId]);
    } finally { await f.close(); }
  });

  it("restores queued identity and mode without sending its contents again", async () => {
    const f = await fixture();
    let restarted: ClaudeDesktopBridge | undefined;
    try {
      f.native.sendResult = { delivered: true, queued: true };
      const receipt = await f.bridge.startTurn(input);
      await f.message({ type: "command_lifecycle", command_uuid: receipt.messageId, state: "queued" });
      await f.bridge.close();
      restarted = new ClaudeDesktopBridge(f.options);
      await restarted.initialize();
      f.native.calls = [];
      await restarted.steerQueuedTurn(input.sessionId, receipt.commandId);
      expect(f.native.calls).toEqual([{ method: "sendSteeredNow", args: [input.sessionId, receipt.messageId] }]);
      expect(restarted.session(input.sessionId)?.pendingCommandIds).toEqual([receipt.commandId]);
    } finally { await restarted?.close(); await f.close(); }
  });

  describe("v113 queue action boundaries", () => {
    it.each([
      { action: "send-now", method: "promoteQueuedMessage", failure: new Error("Native promotion response rejected"), state: "completed" },
      { action: "cancel", method: "cancelQueuedMessage", failure: new InspectorDisconnectedError("Native cancellation response lost"), state: "cancelled" },
    ] as const)("preserves committed Native evidence when $action subsequently rejects", async ({ action, method, failure, state }) => {
      const f = await fixture();
      let rejectCall!: (error: Error) => void;
      let pending: ReturnType<ClaudeDesktopBridge["steerQueuedTurn"]> | undefined;
      try {
        f.native.sendResult = { delivered: true, queued: true };
        const receipt = await f.bridge.startTurn(input);
        const identity = { commandId: receipt.commandId, requestId: receipt.requestId, messageId: receipt.messageId };
        const original = f.native.call.bind(f.native);
        vi.spyOn(f.native, "call").mockImplementation((called, args = []) => {
          if (called !== method) return original(called, args);
          f.native.calls.push({ method: called, args });
          return new Promise((_resolve, reject) => { rejectCall = reject; });
        });
        f.native.calls = [];
        pending = action === "send-now" ? f.bridge.steerQueuedTurn(input.sessionId, receipt.commandId) : f.bridge.cancelQueuedTurn(input.sessionId, receipt.commandId);
        await vi.waitFor(() => expect(f.native.calls).toEqual([{ method, args: [input.sessionId, identity.messageId] }]));
        if (action === "send-now") {
          await f.message({ type: "command_lifecycle", command_uuid: identity.messageId, state: "started" });
          await f.message({ type: "result", user_message_uuid: identity.messageId, is_error: false });
        } else {
          const changed = once(f.bridge, "changed");
          f.native.emit("event", { type: "held_input_withdrawn", sessionId: input.sessionId, withdrawnUuids: [identity.messageId] });
          await changed;
          f.native.ready = false;
          f.native.emit("disconnected");
        }
        expect(f.state.nativeDesktopReceipt(input.idempotencyKey)).toMatchObject({ ...identity, state });
        const eventCount = f.eventLog.replay(0).length;
        const rejected = expect(pending).rejects.toBe(failure);
        rejectCall(failure);
        await rejected;
        expect(f.state.nativeDesktopReceipt(input.idempotencyKey)).toMatchObject({ ...identity, state });
        expect(f.bridge.session(input.sessionId)?.pendingCommandIds).toEqual([]);
        expect(f.eventLog.replay(0)).toHaveLength(eventCount);
        expect(f.native.calls).toEqual([{ method, args: [input.sessionId, identity.messageId] }]);
      } finally {
        rejectCall?.(failure);
        await pending?.catch(() => undefined);
        await f.close();
      }
    });

    it.each([
      { action: "send-now", mode: "deferred", nativeState: "started", accepted: false },
      { action: "send-now", mode: "steered", nativeState: "completed", accepted: false },
      { action: "cancel", mode: "deferred", nativeState: "completed", accepted: false },
      { action: "cancel", mode: "steered", nativeState: "completed", accepted: true },
      { action: "cancel", mode: "steered", nativeState: "failed", accepted: true },
      { action: "cancel", mode: "steered", nativeState: "cancelled", accepted: true },
    ] as const)("retains $nativeState during pending $mode $action (Native=$accepted)", async ({ action, mode, nativeState, accepted }) => {
      const f = await fixture();
      let resolveCall!: (result: boolean) => void;
      let pending: ReturnType<ClaudeDesktopBridge["steerQueuedTurn"]> | undefined;
      try {
        f.native.sendResult = { delivered: true, queued: true };
        const receipt = await f.bridge.startTurn(input);
        const identity = { commandId: receipt.commandId, requestId: receipt.requestId, messageId: receipt.messageId };
        if (mode === "steered") await f.message({ type: "command_lifecycle", command_uuid: identity.messageId, state: "queued" });
        const method = action === "cancel" ? "cancelQueuedMessage" : mode === "steered" ? "sendSteeredNow" : "promoteQueuedMessage";
        const original = f.native.call.bind(f.native);
        vi.spyOn(f.native, "call").mockImplementation((called, args = []) => {
          if (called !== method) return original(called, args);
          f.native.calls.push({ method: called, args });
          return new Promise(resolve => { resolveCall = resolve; });
        });
        f.native.calls = [];
        pending = action === "send-now" ? f.bridge.steerQueuedTurn(input.sessionId, receipt.commandId) : f.bridge.cancelQueuedTurn(input.sessionId, receipt.commandId);
        await vi.waitFor(() => expect(f.native.calls).toEqual([{ method, args: [input.sessionId, identity.messageId] }]));
        await f.message({ type: "command_lifecycle", command_uuid: identity.messageId, state: "started" });
        if (nativeState === "completed" || nativeState === "failed") await f.message({ type: "result", user_message_uuid: identity.messageId, is_error: nativeState === "failed" });
        if (nativeState === "cancelled") await f.message({ type: "command_lifecycle", command_uuid: identity.messageId, state: "cancelled" });
        const state = nativeState === "started" ? "running" : nativeState;
        expect(f.state.nativeDesktopReceipt(input.idempotencyKey)).toMatchObject({ ...identity, state });
        if (accepted) {
          resolveCall(true);
          expect.soft(await pending).toMatchObject({ ...identity, state });
        } else {
          const rejected = expect(pending).rejects.toThrow(action === "cancel" ? "无法撤回" : "无法立即发送");
          resolveCall(false);
          await rejected;
        }
        expect.soft(f.state.nativeDesktopReceipt(input.idempotencyKey)).toMatchObject({ ...identity, state });
        expect(f.bridge.session(input.sessionId)?.pendingCommandIds).toEqual([]);
        expect(f.native.calls).toEqual([{ method, args: [input.sessionId, identity.messageId] }]);
        expect(f.eventLog.replay(0).filter(event => event.type === "message.delivery" && event.data.delivery === "cancelled")).toEqual([]);
      } finally {
        resolveCall?.(false);
        await pending?.catch(() => undefined);
        await f.close();
      }
    });

    it("keeps identical text and attachments independently actionable by Native UUID", async () => {
      const f = await fixture();
      try {
        f.native.sendResult = { delivered: true, queued: true };
        const attachments = [{ id: "same-image", name: "same.png", mimeType: "image/png" as const, size: 2, data: "aGk=" }];
        const first = await f.bridge.startTurn({ ...input, attachments });
        const second = await f.bridge.startTurn({ ...input, attachments, requestId: "second-identical", idempotencyKey: "second-identical" });
        expect(first.commandId).not.toBe(second.commandId);
        expect(first.messageId).not.toBe(second.messageId);
        const sends = f.native.calls.filter(call => call.method === "sendMessage");
        expect(sends).toHaveLength(2);
        expect(sends.map(call => [call.args[1], call.args[2], call.args[7]])).toEqual([
          [input.text, [{ base64: "aGk=", mimeType: "image/png", filename: "same.png" }], first.messageId],
          [input.text, [{ base64: "aGk=", mimeType: "image/png", filename: "same.png" }], second.messageId],
        ]);
        await f.message({ type: "command_lifecycle", command_uuid: second.messageId, state: "queued" });
        f.native.calls = [];
        f.native.queueResult = false;
        await expect(f.bridge.cancelQueuedTurn(input.sessionId, first.commandId)).rejects.toThrow("无法撤回");
        expect(f.bridge.session(input.sessionId)?.pendingCommandIds).toEqual([first.commandId, second.commandId]);
        f.native.queueResult = true;
        await f.bridge.steerQueuedTurn(input.sessionId, second.commandId);
        await f.message({ type: "command_lifecycle", command_uuid: second.messageId, state: "started" });
        await f.message({ type: "result", user_message_uuid: second.messageId, is_error: false });
        expect(f.state.nativeDesktopReceipt(input.idempotencyKey)).toMatchObject({ commandId: first.commandId, messageId: first.messageId, state: "queued" });
        expect(f.state.nativeDesktopReceipt("second-identical")).toMatchObject({ commandId: second.commandId, messageId: second.messageId, state: "completed" });
        await f.bridge.cancelQueuedTurn(input.sessionId, first.commandId);
        expect(f.state.nativeDesktopReceipt(input.idempotencyKey)?.state).toBe("cancelled");
        expect(f.bridge.session(input.sessionId)?.pendingCommandIds).toEqual([]);
        expect(f.native.calls).toEqual([
          { method: "cancelQueuedMessage", args: [input.sessionId, first.messageId] },
          { method: "sendSteeredNow", args: [input.sessionId, second.messageId] },
          { method: "cancelQueuedMessage", args: [input.sessionId, first.messageId] },
        ]);
      } finally { await f.close(); }
    });

    it("follows repeated and multi-hop rekeys through new UUID actions and restart", async () => {
      const f = await fixture();
      let restarted: ClaudeDesktopBridge | undefined;
      try {
        f.native.sendResult = { delivered: true, queued: true };
        const receipt = await f.bridge.startTurn(input);
        const originalMessageId = receipt.messageId;
        const identity = { commandId: receipt.commandId, requestId: receipt.requestId, messageId: "native-hop-final", state: "queued", queueMode: "steered" };
        await f.message({ type: "command_lifecycle", command_uuid: originalMessageId, state: "queued" });
        for (const rekeyedSteers of [
          [{ from: originalMessageId, to: "native-hop-middle" }, { from: originalMessageId, to: "native-hop-middle" }, { from: "native-hop-middle", to: "native-hop-final" }],
          [{ from: originalMessageId, to: "native-stale-hop" }, { from: "native-hop-middle", to: "native-stale-hop" }],
        ]) {
          const changed = once(f.bridge, "changed");
          f.native.emit("event", { type: "steers_rekeyed", sessionId: input.sessionId, rekeyedSteers });
          await changed;
          expect(f.state.nativeDesktopReceipt(input.idempotencyKey)).toMatchObject(identity);
        }
        expect(f.eventLog.replay(0).filter(event => event.data.previousMessageId).map(event => [event.data.previousMessageId, event.data.messageId, event.data.commandId])).toEqual([
          [originalMessageId, "native-hop-middle", receipt.commandId],
          ["native-hop-middle", "native-hop-final", receipt.commandId],
        ]);
        f.native.calls = [];
        expect(await f.bridge.steerQueuedTurn(input.sessionId, receipt.commandId)).toMatchObject(identity);
        expect(f.native.calls).toEqual([{ method: "sendSteeredNow", args: [input.sessionId, "native-hop-final"] }]);
        await f.bridge.close();
        const restoredNative = new NativeDesktop();
        restarted = new ClaudeDesktopBridge({ ...f.options, inspector: restoredNative });
        await restarted.initialize();
        expect(restoredNative.calls.some(call => ["sendMessage", "interrupt"].includes(call.method))).toBe(false);
        restoredNative.calls = [];
        restoredNative.queueResult = false;
        await expect(restarted.cancelQueuedTurn(input.sessionId, receipt.commandId)).rejects.toThrow("无法撤回");
        expect(restoredNative.calls).toEqual([{ method: "cancelQueuedMessage", args: [input.sessionId, "native-hop-final"] }]);
        expect(f.state.nativeDesktopReceipt(input.idempotencyKey)).toMatchObject(identity);
        for (const message of [
          { type: "command_lifecycle", command_uuid: originalMessageId, state: "started" },
          { type: "command_lifecycle", command_uuid: "native-hop-middle", state: "started" },
          { type: "command_lifecycle", command_uuid: "native-hop-final", state: "started" },
          { type: "result", user_message_uuid: "native-hop-final", is_error: false },
        ]) {
          const changed = once(restarted, "changed");
          restoredNative.emit("event", { type: "message", sessionId: input.sessionId, message });
          await changed;
          if (message.command_uuid !== "native-hop-final" && message.type !== "result") expect(f.state.nativeDesktopReceipt(input.idempotencyKey)?.state).toBe("queued");
        }
        expect(f.state.nativeDesktopReceipt(input.idempotencyKey)).toMatchObject({ ...identity, state: "completed" });
        expect(restarted.session(input.sessionId)?.pendingCommandIds).toEqual([]);
        restoredNative.calls = [];
        await expect(restarted.steerQueuedTurn(input.sessionId, receipt.commandId)).rejects.toThrow("当前不可调整");
        await expect(restarted.cancelQueuedTurn(input.sessionId, receipt.commandId)).rejects.toThrow("当前不可调整");
        expect(restoredNative.calls).toEqual([]);
      } finally { await restarted?.close(); await f.close(); }
    });

    it("isolates rekeys, public withdrawal and actions when sessions reuse a Native UUID", async () => {
      const f = await fixture();
      try {
        f.native.sessions.push({ ...f.native.sessions[0], sessionId: "other-native" });
        await f.bridge.refreshRuntime();
        f.native.sendResult = { delivered: true, queued: true };
        const local = await f.bridge.startTurn(input);
        const foreign = await f.bridge.startTurn({ ...input, sessionId: "other-native", requestId: "foreign", idempotencyKey: "foreign" });
        const sharedMessageId = local.messageId;
        const oldForeignMessageId = foreign.messageId;
        for (const rekeyedSteers of [
          [{ from: sharedMessageId, to: "foreign-only-rekey" }],
          [{ from: oldForeignMessageId, to: sharedMessageId }],
        ]) {
          const changed = once(f.bridge, "changed");
          f.native.emit("event", { type: "steers_rekeyed", sessionId: "other-native", rekeyedSteers });
          await changed;
          expect(f.state.nativeDesktopReceipt(input.idempotencyKey)).toMatchObject({ messageId: sharedMessageId, state: "queued" });
        }
        expect(f.state.nativeDesktopReceipt("foreign")).toMatchObject({ commandId: foreign.commandId, messageId: sharedMessageId, state: "queued" });
        f.native.calls = [];
        await expect(f.bridge.steerQueuedTurn("other-native", local.commandId)).rejects.toThrow("当前不可调整");
        await expect(f.bridge.cancelQueuedTurn(input.sessionId, foreign.commandId)).rejects.toThrow("当前不可调整");
        for (const uuid of [oldForeignMessageId, sharedMessageId]) {
          const changed = once(f.bridge, "changed");
          f.native.emit("event", { type: "held_input_withdrawn", sessionId: "other-native", withdrawnUuids: [uuid], lostUuids: [sharedMessageId] });
          await changed;
          expect(f.state.nativeDesktopReceipt(input.idempotencyKey)).toMatchObject({ commandId: local.commandId, messageId: sharedMessageId, state: "queued" });
          expect(f.state.nativeDesktopReceipt("foreign")?.state).toBe(uuid === sharedMessageId ? "cancelled" : "queued");
        }
        expect(f.native.calls).toEqual([]);
        expect(f.bridge.session(input.sessionId)?.pendingCommandIds).toEqual([local.commandId]);
        expect(f.bridge.session("other-native")?.pendingCommandIds).toEqual([]);
        await f.bridge.cancelQueuedTurn(input.sessionId, local.commandId);
        expect(f.native.calls).toEqual([{ method: "cancelQueuedMessage", args: [input.sessionId, sharedMessageId] }]);
        expect(f.state.nativeDesktopReceipt(input.idempotencyKey)?.state).toBe("cancelled");
        expect(f.eventLog.replay(0).filter(event => event.data.delivery === "cancelled").map(event => [event.sessionId, event.data.commandId])).toEqual([
          ["other-native", foreign.commandId], [input.sessionId, local.commandId],
        ]);
      } finally { await f.close(); }
    });

    it("surfaces unsupported queue methods and rejects stale or unknown commands without fallback", async () => {
      const f = await fixture();
      try {
        f.native.sendResult = { delivered: true, queued: true };
        const receipt = await f.bridge.startTurn(input);
        f.native.calls = [];
        for (const method of ["promoteQueuedMessage", "sendSteeredNow", "cancelQueuedMessage"]) f.native.unsupported.add(method);
        await expect(f.bridge.steerQueuedTurn(input.sessionId, receipt.commandId)).rejects.toThrow("Unsupported Claude Desktop method: promoteQueuedMessage");
        await f.message({ type: "command_lifecycle", command_uuid: receipt.messageId, state: "queued" });
        await expect(f.bridge.steerQueuedTurn(input.sessionId, receipt.commandId)).rejects.toThrow("Unsupported Claude Desktop method: sendSteeredNow");
        await expect(f.bridge.cancelQueuedTurn(input.sessionId, receipt.commandId)).rejects.toThrow("Unsupported Claude Desktop method: cancelQueuedMessage");
        expect(f.state.nativeDesktopReceipt(input.idempotencyKey)).toMatchObject({ commandId: receipt.commandId, messageId: receipt.messageId, state: "queued", queueMode: "steered" });
        expect(f.native.calls).toEqual(["promoteQueuedMessage", "sendSteeredNow", "cancelQueuedMessage"].map(method => ({ method, args: [input.sessionId, receipt.messageId] })));
        f.native.unsupported.clear();
        await f.message({ type: "result", user_message_uuid: receipt.messageId, is_error: false });
        f.native.calls = [];
        for (const commandId of [receipt.commandId, receipt.messageId, "missing-command"]) {
          await expect(f.bridge.steerQueuedTurn(input.sessionId, commandId)).rejects.toThrow("当前不可调整");
          await expect(f.bridge.cancelQueuedTurn(input.sessionId, commandId)).rejects.toThrow("当前不可调整");
        }
        expect(f.state.nativeDesktopReceipt(input.idempotencyKey)?.state).toBe("completed");
        expect(f.native.calls).toEqual([]);
      } finally { await f.close(); }
    });

    it("surfaces delivered false after an early user echo without replaying the send", async () => {
      const f = await fixture();
      let resolveSend!: (result: unknown) => void;
      f.native.sendReply = new Promise(resolve => { resolveSend = resolve; });
      const sending = f.bridge.startTurn(input);
      try {
        await vi.waitFor(() => expect(f.native.calls.some(call => call.method === "sendMessage")).toBe(true));
        const identity = f.state.nativeDesktopReceipt(input.idempotencyKey)!;
        await f.message({ type: "user", uuid: identity.messageId, message: { content: input.text } });
        expect(f.state.nativeDesktopReceipt(input.idempotencyKey)?.state).toBe("session-received");
        const rejected = expect(sending).rejects.toThrow("Native refused after echo");
        resolveSend({ delivered: false, queued: true, reason: "Native refused after echo" });
        await rejected;
        expect(f.state.nativeDesktopReceipt(input.idempotencyKey)).toMatchObject({ commandId: identity.commandId, requestId: identity.requestId, messageId: identity.messageId, state: "failed", error: "Native refused after echo" });
        expect(f.eventLog.replay(0).filter(event => event.type === "user.message.accepted")).toMatchObject([{ itemId: identity.messageId, data: { commandId: identity.commandId } }]);
        expect(f.eventLog.replay(0).at(-1)).toMatchObject({ type: "message.delivery", data: { messageId: identity.messageId, delivery: "failed" } });
        expect(f.bridge.session(input.sessionId)?.pendingCommandIds).toEqual([]);
        expect((await f.bridge.startTurn(input)).state).toBe("failed");
        expect(f.native.calls.filter(call => call.method === "sendMessage")).toHaveLength(1);
        expect(f.native.calls.some(call => ["interrupt", "promoteQueuedMessage", "sendSteeredNow", "cancelQueuedMessage"].includes(call.method))).toBe(false);
      } finally {
        resolveSend({ delivered: true });
        await sending.catch(() => undefined);
        await f.close();
      }
    });

    it("forwards concurrent duplicate queue actions and reports each Native outcome", async () => {
      const f = await fixture();
      const releases: Array<(result: boolean) => void> = [];
      let pending: Array<ReturnType<ClaudeDesktopBridge["steerQueuedTurn"]>> = [];
      try {
        f.native.sendResult = { delivered: true, queued: true };
        const first = await f.bridge.startTurn(input);
        const second = await f.bridge.startTurn({ ...input, requestId: "duplicate-cancel", idempotencyKey: "duplicate-cancel" });
        const original = f.native.call.bind(f.native);
        vi.spyOn(f.native, "call").mockImplementation((method, args = []) => {
          if (!["promoteQueuedMessage", "cancelQueuedMessage"].includes(method)) return original(method, args);
          f.native.calls.push({ method, args });
          return new Promise(resolve => { releases.push(resolve); });
        });
        f.native.calls = [];
        pending = [
          f.bridge.steerQueuedTurn(input.sessionId, first.commandId), f.bridge.steerQueuedTurn(input.sessionId, first.commandId),
          f.bridge.cancelQueuedTurn(input.sessionId, second.commandId), f.bridge.cancelQueuedTurn(input.sessionId, second.commandId),
        ];
        const outcomes = Promise.allSettled(pending);
        await vi.waitFor(() => expect(releases).toHaveLength(4));
        releases.forEach((release, index) => release(index % 2 === 0));
        const results = await outcomes;
        expect(results.map(result => result.status)).toEqual(["fulfilled", "rejected", "fulfilled", "rejected"]);
        expect(results[0]).toMatchObject({ value: { commandId: first.commandId, messageId: first.messageId, state: "queued" } });
        expect(results[2]).toMatchObject({ value: { commandId: second.commandId, messageId: second.messageId, state: "cancelled" } });
        expect(results[1]).toMatchObject({ reason: { message: expect.stringContaining("无法立即发送") } });
        expect(results[3]).toMatchObject({ reason: { message: expect.stringContaining("无法撤回") } });
        expect(f.state.nativeDesktopReceipt(input.idempotencyKey)?.state).toBe("queued");
        expect(f.state.nativeDesktopReceipt("duplicate-cancel")?.state).toBe("cancelled");
        expect(f.bridge.session(input.sessionId)?.pendingCommandIds).toEqual([first.commandId]);
        expect(f.native.calls).toEqual([
          { method: "promoteQueuedMessage", args: [input.sessionId, first.messageId] },
          { method: "promoteQueuedMessage", args: [input.sessionId, first.messageId] },
          { method: "cancelQueuedMessage", args: [input.sessionId, second.messageId] },
          { method: "cancelQueuedMessage", args: [input.sessionId, second.messageId] },
        ]);
      } finally {
        releases.forEach(release => release(false));
        await Promise.allSettled(pending);
        await f.close();
      }
    });
  });

  it("sends only once when twenty identical requests arrive concurrently", async () => {
    const f = await fixture();
    try {
      const receipts = await Promise.all(Array.from({ length: 20 }, () => f.bridge.startTurn(input)));
      expect(new Set(receipts.map(receipt => receipt.commandId)).size).toBe(1);
      expect(new Set(receipts.map(receipt => receipt.messageId)).size).toBe(1);
      expect(f.native.calls.filter(call => call.method === "sendMessage")).toHaveLength(1);
      expect(f.eventLog.replay(0).some(event => event.type === "turn.started")).toBe(false);
    } finally { await f.close(); }
  });

  it.each([
    ["session-received", "user", undefined],
    ["running", "command_lifecycle", "started"],
    ["completed", "result", false],
    ["failed", "result", true],
    ["cancelled", "command_lifecycle", "interrupted"],
  ] as const)("retains native %s evidence when the send RPC subsequently disconnects", async (state, type, status) => {
    const f = await fixture();
    let rejectSend!: (error: Error) => void;
    f.native.sendReply = new Promise<void>((_resolve, reject) => { rejectSend = reject; });
    const sending = f.bridge.startTurn(input);
    try {
      await vi.waitFor(() => expect(f.native.calls.some(call => call.method === "sendMessage")).toBe(true));
      const messageId = f.state.nativeDesktopReceipt(input.idempotencyKey)!.messageId;
      await f.message({ type, uuid: type === "user" ? messageId : "native-proof", command_uuid: messageId,
        user_message_uuid: messageId, state: status, is_error: status === true, message: { content: "hello" } });
      expect(f.state.nativeDesktopReceipt(input.idempotencyKey)?.state).toBe(state);
      rejectSend(new InspectorDisconnectedError("RPC response lost after native evidence"));
      expect((await sending).state).toBe(state);
      expect(f.state.nativeDesktopReceipt(input.idempotencyKey)?.state).toBe(state);
      expect(f.native.calls.filter(call => call.method === "sendMessage")).toHaveLength(1);
    } finally {
      rejectSend(new InspectorDisconnectedError("test cleanup"));
      await sending.catch(() => undefined);
      await f.close();
    }
  });

  it.each([false, true])("does not let late lifecycle frames replace a native result (error=%s)", async isError => {
    const f = await fixture();
    try {
      const receipt = await f.bridge.startTurn(input);
      await f.message({ type: "result", uuid: "result", user_message_uuid: receipt.messageId, is_error: isError });
      for (const state of ["queued", "started", "completed"]) {
        await f.message({ type: "command_lifecycle", command_uuid: receipt.messageId, state, uuid: `late-${state}` });
        expect(f.state.nativeDesktopReceipt(input.idempotencyKey)?.state).toBe(isError ? "failed" : "completed");
      }
      expect(f.eventLog.turnEvidence({ sessionId: input.sessionId, messageId: receipt.messageId }).terminal).toBe(isError ? "failed" : "completed");
      expect(f.eventLog.replay(0).filter(event => event.type === "turn.started")).toEqual([]);
    } finally { await f.close(); }
  });

  it("does not downgrade completed evidence when a stale confirmation action arrives", async () => {
    const f = await fixture();
    try {
      f.native.sendError = new InspectorDisconnectedError("response lost");
      const receipt = await f.bridge.startTurn(input);
      expect(receipt.state).toBe("uncertain");
      f.native.sendError = undefined;
      await f.message({ type: "result", uuid: "result", user_message_uuid: receipt.messageId, is_error: false });
      f.native.page.messages = [{ type: "user", uuid: receipt.messageId, message: { content: "hello" } }];
      expect((await f.bridge.resolveUncertainDelivery(receipt.commandId, "confirm")).state).toBe("completed");
      expect(f.state.nativeDesktopReceipt(input.idempotencyKey)?.state).toBe("completed");
      expect(f.state.nativeDesktopReceipt(input.idempotencyKey)?.error).toBeUndefined();
    } finally { await f.close(); }
  });

  it("retains a result that arrives while native delivery confirmation is awaiting history", async () => {
    const f = await fixture();
    let releaseHistory!: (messages: unknown[]) => void;
    let confirming: ReturnType<ClaudeDesktopBridge["resolveUncertainDelivery"]> | undefined;
    try {
      f.native.sendError = new InspectorDisconnectedError("response lost");
      const receipt = await f.bridge.startTurn(input);
      f.native.sendError = undefined;
      const original = f.native.call.bind(f.native);
      vi.spyOn(f.native, "call").mockImplementation((method, args) => method === "getTranscript" ? new Promise(resolve => { releaseHistory = resolve; }) : original(method, args));
      confirming = f.bridge.resolveUncertainDelivery(receipt.commandId, "confirm");
      await f.message({ type: "result", uuid: "completed-during-confirm", user_message_uuid: receipt.messageId, is_error: false });
      releaseHistory([]);
      expect((await confirming).state).toBe("completed");
      expect(f.state.nativeDesktopReceipt(input.idempotencyKey)?.state).toBe("completed");
    } finally {
      releaseHistory?.([]);
      await confirming?.catch(() => undefined);
      await f.close();
    }
  });

  it("keeps a running receipt when an older queued lifecycle frame arrives", async () => {
    const f = await fixture();
    try {
      const receipt = await f.bridge.startTurn(input);
      await f.message({ type: "command_lifecycle", command_uuid: receipt.messageId, state: "started" });
      await f.message({ type: "command_lifecycle", command_uuid: receipt.messageId, state: "queued" });
      expect(f.state.nativeDesktopReceipt(input.idempotencyKey)?.state).toBe("running");
      expect(f.eventLog.replay(0).some(event => event.type === "turn.queued")).toBe(false);
    } finally { await f.close(); }
  });

  it("restores a crash-time dispatch receipt as uncertain without replaying old or native input", async () => {
    const f = await fixture(true);
    let restarted: ClaudeDesktopBridge | undefined;
    try {
      await f.bridge.close();
      f.state.saveNativeDesktopReceipt({ idempotencyKey: "crash", commandId: "crash-command", requestId: "crash-request", sessionId: "local-native", messageId: "crash-message", state: "dispatching" });
      restarted = new ClaudeDesktopBridge(f.options);
      await restarted.initialize();
      expect(f.state.nativeDesktopReceipt("crash")?.state).toBe("uncertain");
      expect((await restarted.startTurn({ ...input, idempotencyKey: "crash" })).commandId).toBe("crash-command");
      expect(f.native.calls.filter(call => call.method === "sendMessage")).toEqual([]);
      expect(f.state.loadBrokerState().pending[0]?.commandId).toBe("old-command");
    } finally { await restarted?.close(); await f.close(); }
  });

  it("does not attribute a result from another native session to the same message UUID", async () => {
    const f = await fixture();
    try {
      f.native.sessions.push({ ...f.native.sessions[0], sessionId: "other-native" });
      await f.bridge.refreshRuntime();
      const receipt = await f.bridge.startTurn(input);
      const changed = once(f.bridge, "changed");
      f.native.emit("event", { sessionId: "other-native", message: { type: "result", uuid: "foreign-result", user_message_uuid: receipt.messageId, is_error: false } });
      await changed;
      expect(f.state.nativeDesktopReceipt(input.idempotencyKey)?.state).toBe("submitted");
      expect(f.eventLog.turnEvidence({ sessionId: input.sessionId, messageId: receipt.messageId }).terminal).toBeUndefined();
    } finally { await f.close(); }
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

  it("does not use event replay as native history after disconnection", async () => {
    const f = await fixture();
    try {
      await f.message({ type: "assistant", uuid: "local-event", message: { content: "Only in the event log" } });
      f.native.ready = false;
      await expect(f.bridge.history("local-native")).rejects.toBeInstanceOf(InspectorDisconnectedError);
      expect(f.native.calls.some(call => call.method === "getTranscriptPage")).toBe(false);
    } finally { await f.close(); }
  });

  it("filters control messages and preserves native question cards", () => {
    const items = nativeHistoryItems("native", [{ type: "user", uuid: "hidden", message: { content: "[Request interrupted by user]" } }, { type: "assistant", uuid: "question", message: { content: [{ type: "tool_use", id: "ask", name: "AskUserQuestion", input: { questions: [{ question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] }] } }] } }]);
    expect(items.some(item => item.text.includes("Request interrupted"))).toBe(false);
    expect(items.find(item => item.interactivePrompt)?.interactivePrompt?.kind).toBe("question");
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
      const controller = Object.assign(Object.create(DesktopController.prototype), {
        broker: f.bridge,
        eventLog: f.eventLog,
        allSessions: () => f.bridge.listSessions(),
      });
      const openedLive = await controller.handleRequest({
        kind: "request", requestId: "open-live", idempotencyKey: "open-live", method: "session.open", params: { sessionId: "local-native" },
      }, "mobile", "phone");
      expect(openedLive.session?.contextUsage).toEqual({
        totalTokens: 64_200,
        maxTokens: 1_000_000,
        percentage: 6.4,
        model: "claude-opus-5-5",
        estimated: false,
      });

      // Idle fallback: getContextUsage returns null, sidechain messages > 50 do not hide or pollute main-chain usage.
      f.native.contextUsage = null;
      f.native.sessions[0]!.model = "claude-sonnet-4-5";
      await f.bridge.refreshRuntime();
      const trailingSidechains = Array.from({ length: 50 }, (_, index) => ({
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
      await f.bridge.history("local-native", undefined, 50);
      expect(f.bridge.session("local-native")?.contextUsage).toEqual({
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
});
