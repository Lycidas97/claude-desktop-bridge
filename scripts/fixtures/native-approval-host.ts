import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  BridgePendingPrompt, BridgePermissionInfo, BridgePermissionResolution, BridgePullRequest, BridgeRequest, BridgeSDKPermissionMode,
} from "../../packages/protocol/src/index.js";
import { ClaudeDesktopBridge } from "../../apps/desktop/src/claude/claude-desktop-bridge.js";
import { InspectorDisconnectedError } from "../../apps/desktop/src/claude/claude-desktop-inspector.js";
import { ConversationStateStore } from "../../apps/desktop/src/controller/conversation-state-store.js";
import { DesktopController } from "../../apps/desktop/src/controller/controller.js";
import { SessionEventLog } from "../../apps/desktop/src/controller/session-event-log.js";
import { EvidenceManager } from "../../apps/desktop/src/evidence/evidence-manager.js";
import { EvidenceStore } from "../../apps/desktop/src/evidence/evidence-store.js";
import { discoverSlashCommands } from "../../apps/desktop/src/claude/slash-command-catalog.js";
import { magpieModelIdHash } from "../../apps/desktop/src/claude/claude-runtime-discovery.js";
import { createNativeSectionFixture } from "./native-section-store.js";

interface NativeApprovalResult {
  requestId: string;
  decision: "once" | "always" | "deny";
  response: Record<string, unknown>;
}

const nativeDialogs = {
  "refusal-fallback": { field: "pendingRefusalFallbackPrompt", event: "refusal_fallback_prompt", payload: "refusalFallbackPrompt", method: "respondToRefusalFallbackPrompt", choices: ["retry_fallback", "edit_prompt"] },
  "auto-mode-server-fallback": { field: "pendingAutoModeServerFallbackPrompt", event: "auto_mode_server_fallback_prompt", payload: "autoModeServerFallbackPrompt", method: "respondToAutoModeServerFallbackPrompt", choices: ["continue", "interrupt"] },
  "lanyard-consent": { field: "pendingLanyardConsent", event: "lanyard_consent", payload: "lanyardConsent", method: "respondToLanyardConsent", choices: ["consent_workspace", "decline_workspace"] },
  "violin-bow": { field: "pendingViolinBowPrompt", event: "violin_bow_prompt", payload: "violinBowPrompt", method: "respondToViolinBowPrompt", choices: ["confirm_native_operation", "cancel_native_operation"] },
  "cwd-trust": { field: "pendingCwdTrustPrompt", method: "answerPendingCwdTrust", choices: ["trust", "cancel"] },
} as const;

/** The real Controller and facade relay to a synthetic LocalSessions boundary. */
export async function startNativeApprovalHost(options: {
  directory: string;
  sessionId: string;
  title: string;
  deviceId: string;
  onRequested(request: BridgePermissionInfo): void;
  onResolved(request: BridgePermissionInfo, result: NativeApprovalResult, resolution: BridgePermissionResolution): void;
  onModeChanged?(mode: BridgeSDKPermissionMode): void;
  onModelChanged?(model: string): void;
  sections?: boolean;
}) {
  const commandCwd = join(options.directory, "command-project");
  const commandHome = join(options.directory, "command-personal");
  const settingsPath = join(commandHome, "settings.json");
  const harnessCwd = join(commandCwd, ".claude/worktrees/隔离工作树");
  await mkdir(harnessCwd, { recursive: true });
  await writeFile(join(commandCwd, "report.json"), "{\"source\":\"wrong project root\"}");
  await writeFile(join(harnessCwd, "report.json"), "{\"source\":\"worktree\",\"checked\":9}\n");
  await writeFile(join(harnessCwd, "说明 notes.md"), "# Worktree preview\n\nNative file routing verified.\n");
  await mkdir(join(commandCwd, ".claude/commands/frontend"), { recursive: true });
  await mkdir(join(commandHome, "skills/audit"), { recursive: true });
  const savedModels = [
    { model: "synthetic-model", label: "隔离模型 · 标准", description: "Private fixture metadata" },
    { model: "synthetic-model-large[1m]", label: "隔离模型 · 长上下文" },
    { model: "claude/claude-opus-5-5", label: "Magpie 额度模型" },
    { model: ["antigravity", "gemini-4-argon"].join("/"), label: "Gemini 4 Argon · Antigravity" },
  ];
  const nativeModelIds = savedModels.map(option => `mythos-magpie-${magpieModelIdHash(option.model)}${/\[1m\]$/iu.test(option.model) ? "[1m]" : ""}`);
  await writeFile(settingsPath, JSON.stringify({ modelPicker: { options: savedModels } }));
  await writeFile(join(commandHome, "skills/audit/SKILL.md"), "---\nname: inspect-changes\ndescription: 核对当前改动\nargument-hint: '[path]'\n---\nSynthetic fixture body; never sent to the model.\n");
  await writeFile(join(commandCwd, ".claude/commands/frontend/component.md"), "---\ndescription: 检查组件结构\nargument-hint: '[component]'\n---\nSynthetic command body.\n");
  for (const [name, description] of [["review", "审查当前改动"], ["report", "整理结果报告"], ...Array.from({ length: 12 }, (_, index) => [`tool-${String(index + 1).padStart(2, "0")}`, `示例工具 ${index + 1}`])]) {
    await writeFile(join(commandCwd, `.claude/commands/${name}.md`), `---\ndescription: ${description}\nargument-hint: '[path]'\n---\nSynthetic command body.\n`);
  }
  const native = {
    sessionId: options.sessionId, cwd: commandCwd, harnessCwd, title: options.title, model: nativeModelIds[0]!,
    turnRunning: false,
    prs: [] as BridgePullRequest[],
    pendingRefusalFallbackPrompt: undefined as Record<string, unknown> | undefined,
    pendingAutoModeServerFallbackPrompt: undefined as Record<string, unknown> | undefined,
    pendingLanyardConsent: undefined as Record<string, unknown> | undefined,
    pendingViolinBowPrompt: undefined as Record<string, unknown> | undefined,
    pendingCwdTrustPrompt: undefined as Record<string, unknown> | undefined,
    permissionMode: "default" as BridgeSDKPermissionMode, pendingToolPermissions: [] as Array<{
      sessionId: string; requestId: string; cliToolUseId: string; toolName: string; input: Record<string, unknown>; requestedAt: number;
    }>,
  };
  const miscRoot = join(options.directory, "work", "杂活");
  const miscSubdir = join(miscRoot, "existing-tool");
  const untrustedDir = join(options.directory, "untrusted-para");
  const manualTrustDir = join(options.directory, "manual-trust-dir");
  await Promise.all([mkdir(untrustedDir, { recursive: true }), mkdir(manualTrustDir, { recursive: true })]);
  if (options.sections) {
    await mkdir(miscSubdir, { recursive: true });
    await writeFile(join(miscRoot, "conflict-file"), "not a directory\n");
  }
  const nativeSessions: Array<typeof native & { forkedFromSessionId?: string }> = [
    native,
    ...(options.sections ? [
      { ...native, sessionId: "browser-e2e-misc-sub", cwd: miscSubdir, harnessCwd: miscSubdir, title: "同步现有脚本配置" },
      { ...native, sessionId: "browser-e2e-misc-root", cwd: miscRoot, harnessCwd: miscRoot, title: "整理杂活根目录说明" },
    ] : []),
  ];
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const messages: Record<string, unknown>[] = [];
  const pending = new Map<string, (reply: NativeApprovalResult) => void>();
  const replies = new Map<string, NativeApprovalResult>();
  const queued = new Set<string>();
  const queueResults = new Map<string, boolean>();
  let queueGate: Promise<void> | undefined;
  let reportQueued = true;
  let rewindReadbackFailure: "getSession" | "getTranscriptPage" | undefined;
  let rewindCompleted = false;
  const failedRewindReadbacks: string[] = [];
  const trustedCwds = new Set<string>([commandCwd, harnessCwd, miscRoot, miscSubdir]);
  let saveTrustSupported = true;
  let keepUntrustedAfterSave = false;
  let applyPrWrites = true;
  let choicesAvailable = true;
  const preferences = { onlyOwnPrs: false };
  let nextPrBranch: string | undefined;
  const nativeEvents: Record<string, unknown>[] = [];
  const unsupportedMethods = new Set<string>();
  const inspector = Object.assign(new EventEmitter(), {
    ready: true,
    supports: (method: string) => !unsupportedMethods.has(method) && ["getAll", "getSession", "getTranscript", "getTranscriptPage", "getSupportedCommands", "respondToToolPermission", "setPermissionMode", "setModel", "setEffort", "canRewindTo", "rewindFiles", "rewindV2", "sendMessage", "promoteQueuedMessage", "sendSteeredNow", "cancelQueuedMessage", "interrupt", "start", "getPrOverview", "getPrChecks", "setBoundPrAutoFix", "setAutoFixOwnPrsWanted", "armAutoFixOnNextPr", "getGitInfo", ...Object.values(nativeDialogs).map(dialog => dialog.method), ...(saveTrustSupported ? ["saveTrust"] : [])].includes(method),
    async prPreferences(id: string) {
      return id === options.sessionId ? { ...preferences, nextOwnPrArmed: nextPrBranch !== undefined } : undefined;
    },
    async promptChoices(id: string, promptId: string) {
      if (id !== options.sessionId || !choicesAvailable) return undefined;
      return Object.values(nativeDialogs).find(dialog => native[dialog.field]?.promptId === promptId)?.choices.slice();
    },
    async startAutoFixOnNextPr(id: string, branch: string) {
      calls.push({ method: "armAutoFixOnNextPr", args: [id, branch] });
      assert.equal(id, options.sessionId);
      assert.equal(branch, "feature/owned", "Native arms a branch string, not an enabled boolean");
      if (applyPrWrites) nextPrBranch = branch;
    },
    async availableCodeModels() { return [...new Set(nativeModelIds.map(id => id.replace(/\[1m\]$/iu, "")))]; },
    async connect() {},
    async close() {},
    async call(method: string, args: unknown[] = []): Promise<unknown> {
      calls.push({ method, args: structuredClone(args) });
      if (rewindCompleted && method === rewindReadbackFailure) {
        failedRewindReadbacks.push(method);
        throw new InspectorDisconnectedError(`Synthetic ${method} disconnected after successful rewind`);
      }
      if (method === "getGitInfo") {
        assert.deepEqual(args, [harnessCwd]);
        return { branch: "feature/owned" };
      }
      if (method === "getAll" || method === "getSession") {
        return structuredClone(method === "getAll" ? nativeSessions : nativeSessions.find(session => session.sessionId === args[0]));
      }
      const dialog = Object.values(nativeDialogs).find(dialog => dialog.method === method);
      if (dialog) {
        assert.equal(args.length, 3);
        assert.equal(args[0], options.sessionId);
        const info = native[dialog.field];
        if (info?.promptId !== args[1]) return false;
        if (method === "answerPendingCwdTrust") assert.equal(typeof args[2], "boolean");
        else assert.ok((dialog.choices as readonly string[]).includes(String(args[2])), "The Native dialog accepts its own choice strings only");
        native[dialog.field] = undefined;
        const event = "event" in dialog
          ? { type: `${dialog.event}_resolved`, sessionId: options.sessionId, [dialog.payload]: info }
          : { type: "session_updated", sessionId: options.sessionId, session: structuredClone(native) };
        nativeEvents.push(structuredClone(event));
        inspector.emit("event", event);
        return true;
      }
      if (method === "setBoundPrAutoFix") {
        assert.equal(args.length, 5, "LocalSessions fixes actor=person internally and takes host as its fifth argument");
        assert.equal(args[0], options.sessionId);
        assert.equal(typeof args[3], "boolean");
        const binding = native.prs.find(pr => pr.repo === args[1] && pr.prNumber === args[2] && pr.host === args[4]);
        assert.ok(binding, "Auto-fix must target the bound PR and its Native host");
        if (applyPrWrites) binding.autoFix = args[3] as boolean;
        return;
      }
      if (method === "setAutoFixOwnPrsWanted") {
        assert.deepEqual(args.slice(0, 1), [options.sessionId]);
        assert.equal(args.length, 2);
        assert.equal(typeof args[1], "boolean");
        if (applyPrWrites) preferences.onlyOwnPrs = args[1] as boolean;
        return;
      }
      if (method === "getPrOverview" || method === "getPrChecks") {
        assert.equal(args[0], harnessCwd);
        const binding = native.prs.find(pr => pr.prNumber === args[1] && pr.repo === args[2]);
        assert.ok(binding, "PR reads must use the existing Native binding");
        if (method === "getPrOverview") {
          assert.equal(args.length, 5);
          assert.equal(args[3], options.sessionId);
          assert.equal(args[4], true);
          return { success: true, overview: { title: "隔离 Native PR", state: binding.state, url: binding.url } };
        }
        assert.equal(args.length, 4);
        assert.equal(args[3], binding.host);
        return { success: true, checks: [{ name: "native-ci-failure", state: "FAILURE", bucket: "fail", url: "https://github.com/fixture/native/actions/runs/42" }] };
      }
      if (method === "saveTrust") {
        if (!keepUntrustedAfterSave) trustedCwds.add(String(args[0]));
        return;
      }
      if (method === "start") {
        const input = args[0] as { cwd: string; title?: string; sessionId?: string };
        if (!trustedCwds.has(input.cwd)) {
          throw new Error("Error invoking remote method '$eipc_message$d32c5f9b_$_claude.web_$_LocalSessions_$_start': WorkspaceTrustError: Workspace requires trust approval before starting a session. [ccdErrorCategory:trust_required]");
        }
        const now = Date.now();
        const created = {
          ...native,
          sessionId: input.sessionId ?? `local_${randomUUID()}`,
          cwd: input.cwd,
          harnessCwd: input.cwd,
          title: input.title?.trim() || "新建会话",
          createdAt: now,
          lastActivityAt: now,
          pendingToolPermissions: [],
        };
        nativeSessions.unshift(created);
        return structuredClone(created);
      }
      if (method === "sendMessage") {
        assert.equal(args[0], options.sessionId);
        assert.equal(typeof args[7], "string");
        queued.add(args[7] as string);
        messages.push({ type: "user", uuid: args[7], timestamp: Date.now(), message: { content: args[1] } });
        return reportQueued ? { delivered: true, queued: true } : { delivered: true };
      }
      if (["promoteQueuedMessage", "sendSteeredNow", "cancelQueuedMessage"].includes(method)) {
        assert.equal(args[0], options.sessionId);
        if (queueGate) await queueGate;
        const accepted = queued.has(String(args[1])) && queueResults.get(method) !== false;
        if (accepted && method === "cancelQueuedMessage") queued.delete(String(args[1]));
        return accepted;
      }
      if (method === "interrupt") throw new Error("Queue actions must never interrupt the synthetic native turn");
      if (method === "getTranscript") return structuredClone(messages);
      if (method === "getTranscriptPage") {
        const end = args[1] ? messages.findIndex(message => message.uuid === args[1]) : messages.length;
        const start = Math.max(0, end - Number(args[2]));
        return { messages: structuredClone(messages.slice(start, end)), hasMore: start > 0 };
      }
      if (method === "getSupportedCommands") return discoverSlashCommands(commandCwd, commandHome);
      if (method === "canRewindTo") {
        const index = messages.findIndex(message => message.uuid === args[1] && message.type === "user");
        return index > 0 && messages.slice(0, index).some(message => message.type === "assistant");
      }
      if (method === "rewindFiles") {
        if (native.turnRunning) return { canRewind: false, error: "Session is busy" };
        if (args[2] === false) await writeFile(join(harnessCwd, "report.json"), "{\"source\":\"rewound\",\"checked\":1}\n");
        return { canRewind: true, filesChanged: [join(harnessCwd, "report.json")] };
      }
      if (method === "rewindV2") {
        const index = messages.findIndex(message => message.uuid === args[1]);
        const assistantUuid = messages.slice(0, index).findLast(message => message.type === "assistant")?.uuid;
        if (index < 0 || typeof assistantUuid !== "string") return null;
        const target = messages[index]!.message as { content: string };
        const withdrawnUuids = [...queued];
        queued.clear();
        native.turnRunning = false;
        native.pendingToolPermissions = [];
        messages.splice(index);
        rewindCompleted = true;
        inspector.emit("event", { type: "close", sessionId: options.sessionId, code: 0, withdrawnUuids, session: structuredClone(native) });
        return { prefill: target.content, assistantUuid };
      }
      if (method === "setModel") {
        const index = nativeModelIds.findIndex(id => id.replace(/\[1m\]$/iu, "") === String(args[1]).replace(/\[1m\]$/iu, ""));
        if (index < 0) throw new Error("Native fixture rejects canonical model IDs");
        native.model = args[1] as string;
        // Reproduce Desktop's modelIdForCli preferred-context normalization.
        if (savedModels[index]!.label === "Gemini 4 Argon · Antigravity" && !/\[1m\]$/iu.test(native.model)) native.model += "[1m]";
        options.onModelChanged?.(savedModels[index]!.model);
        return;
      }
      if (method === "setEffort") return;
      if (method === "setPermissionMode") {
        native.permissionMode = args[1] as BridgeSDKPermissionMode;
        options.onModeChanged?.(native.permissionMode);
        return;
      }
      if (method === "respondToToolPermission") {
        const requestId = String(args[0]);
        const finish = pending.get(requestId);
        if (!finish) throw new Error("Unknown native requestID");
        const reply = { requestId, decision: args[1] as NativeApprovalResult["decision"], response: args[2] as Record<string, unknown> };
        pending.delete(requestId);
        native.pendingToolPermissions = native.pendingToolPermissions.filter(request => request.requestId !== requestId);
        replies.set(requestId, reply);
        finish(reply);
        return;
      }
      throw new Error(`Unsupported synthetic LocalSessions method: ${method}`);
    },
  });
  const sections = options.sections ? await createNativeSectionFixture(options.directory) : undefined;
  if (sections) Object.assign(inspector, {
    sections: sections.sections,
    createSection: sections.createSection,
    assignSection: sections.assignSection,
    renameSection: sections.renameSection,
    deleteSection: sections.deleteSection,
  });
  const state = new ConversationStateStore({
    databasePath: join(options.directory, "native-state.sqlite"), sessionsPath: join(options.directory, "sessions.json"),
    queuePath: join(options.directory, "queue.json"), masterSecret: "isolated-browser-native-fixture",
  });
  await state.initialize();
  const eventLog = new SessionEventLog(join(options.directory, "native-events.jsonl"));
  await eventLog.initialize();
  const broker = new ClaudeDesktopBridge({ eventLog, conversationState: state, inspector, settingsPath,
    scanCatalog: async () => ({ projects: [], sessions: [], observedAt: Date.now() }),
  });
  await broker.initialize();
  const evidence = new EvidenceManager({ eventLog, store: new EvidenceStore({
    databasePath: join(options.directory, "evidence.sqlite"), blobsPath: join(options.directory, "blobs"),
    masterSecret: Buffer.alloc(32, 5).toString("base64url"),
  }) });
  await evidence.initialize();
  const controller = Object.assign(Object.create(DesktopController.prototype), {
    routesToExternalRuntime: () => false,
    broker, evidence, allSessions: () => broker.listSessions(), allProjects: () => broker.listProjects(), publish: async () => {},
    config: { hostDeviceId: "synthetic-desktop", desktopName: "隔离电脑", devices: [{ deviceId: options.deviceId, name: "隔离手机", platform: "android", pairedAt: 1 }] },
  }) as { handleRequest(request: BridgeRequest, origin: "mobile", deviceId: string): Promise<unknown> };
  let sequence = 0;
  function dialogs(after = 0) {
    return {
      events: eventLog.replay(after), nativeEvents: structuredClone(nativeEvents),
      session: structuredClone(broker.session(options.sessionId)!), prompts: broker.promptsList(),
      prs: structuredClone(native.prs), prefs: { ...preferences, nextOwnPrArmed: nextPrBranch !== undefined }, runtimeCapabilities: broker.capabilities(),
    };
  }
  async function emitDialogEvent(event: Record<string, unknown>) {
    const after = eventLog.latestSeq();
    const changed = once(broker, "changed");
    nativeEvents.push(structuredClone(event));
    inspector.emit("event", event);
    await changed;
    return dialogs(after);
  }
  return {
    cwd: commandCwd, harnessCwd, miscRoot, calls, failedRewindReadbacks, sections,
    untrustedDir, manualTrustDir,
    dialogs,
    async openPrompt(kind: BridgePendingPrompt["kind"]) {
      const dialog = nativeDialogs[kind];
      const info: Record<string, unknown> = {
        promptId: `native-dialog-${++sequence}`,
        ...(kind === "refusal-fallback" ? { originalModel: "Native primary", fallbackModel: "Native fallback", apiRefusalCategory: "隔离回退请求" }
          : kind === "cwd-trust" ? { directory: harnessCwd, sources: ["隔离测试目录"] }
            : kind === "lanyard-consent" ? {
              targetKind: "channel", title: "访问频道", lead: "读取并向隔离频道发消息",
              channelId: "owned-channel", channelName: "隔离频道", workspace: "隔离工作区",
              permalink: "https://example.invalid/owned-channel", bullets: ["读取频道历史", "向频道发消息"],
              postsIntro: "发帖身份", postsAs: "隔离账号", postsLabelled: "AI", pollIntervalSeconds: 60,
            } : kind === "violin-bow" ? {
              title: "复制文件", body: "复制选中的文件", detail: "将文件复制到隔离电脑",
              folder: harnessCwd, machineName: "隔离电脑", fileCount: 2, totalBytes: 123,
            } : { paragraphs: ["隔离自动模式确认"] }),
      };
      native[dialog.field] = info;
      const update = await emitDialogEvent("event" in dialog
        ? { type: dialog.event, sessionId: options.sessionId, [dialog.payload]: info }
        : { type: "session_updated", sessionId: options.sessionId, session: structuredClone(native) });
      return { ...update, prompt: update.prompts.find(prompt => prompt.promptId === info.promptId)! };
    },
    async answerPromptLocally(promptId: string) {
      const dialog = Object.values(nativeDialogs).find(dialog => native[dialog.field]?.promptId === promptId);
      assert.ok(dialog, "Only an owned pending Native prompt can be answered locally");
      const info = native[dialog.field]!;
      native[dialog.field] = undefined;
      return emitDialogEvent("event" in dialog
        ? { type: `${dialog.event}_resolved`, sessionId: options.sessionId, [dialog.payload]: info }
        : { type: "session_updated", sessionId: options.sessionId, session: structuredClone(native) });
    },
    async seedPullRequest(pr: BridgePullRequest = { repo: "fixture/native", prNumber: 42, host: "github.com", url: "https://github.com/fixture/native/pull/42", branch: "fixture-42", state: "OPEN", autoFix: false }) {
      native.prs = [structuredClone(pr)];
      await broker.refreshRuntime();
      return dialogs();
    },
    async setPromptsPrPolicy(policy: { applyPrWrites?: boolean; choicesAvailable?: boolean; supported?: boolean }) {
      if (policy.applyPrWrites !== undefined) applyPrWrites = policy.applyPrWrites;
      if (policy.choicesAvailable !== undefined) choicesAvailable = policy.choicesAvailable;
      if (policy.supported !== undefined) for (const method of [...Object.values(nativeDialogs).map(dialog => dialog.method), "setBoundPrAutoFix", "setAutoFixOwnPrsWanted", "armAutoFixOnNextPr", "getPrOverview", "getPrChecks"]) {
        if (policy.supported) unsupportedMethods.delete(method);
        else unsupportedMethods.add(method);
      }
      await broker.refreshRuntime();
      return dialogs();
    },
    trustWorkspace(cwd: string) { trustedCwds.add(cwd); },
    setTrustPolicy(policy: { saveTrustSupported?: boolean; keepUntrustedAfterSave?: boolean }) {
      if (policy.saveTrustSupported !== undefined) saveTrustSupported = policy.saveTrustSupported;
      if (policy.keepUntrustedAfterSave !== undefined) keepUntrustedAfterSave = policy.keepUntrustedAfterSave;
    },
    async sectionCatalog() {
      await broker.refreshRuntime();
      const caps = broker.capabilities();
      return {
        projects: broker.listProjects(),
        sessions: broker.listSessions(),
        capable: caps.includes("section.create"),
        moveCapable: caps.includes("section.move"),
        renameCapable: caps.includes("section.rename"),
        deleteCapable: caps.includes("section.delete"),
        trustCapable: caps.includes("workspace.trust"),
        runtimeCapabilities: caps,
      };
    },
    createSection: (request: BridgeRequest) => controller.handleRequest(request, "mobile", options.deviceId),
    controllerRequest: (request: BridgeRequest) => controller.handleRequest(request, "mobile", options.deviceId),
    failRewindReadback(method: "getSession" | "getTranscriptPage") { rewindReadbackFailure = method; rewindCompleted = false; },
    profile() {
      const session = broker.session(options.sessionId)!;
      return { model: session.model, modelDisplayName: session.modelDisplayName };
    },
    async projectCatalog() {
      const project = join(options.directory, "claude-desktop-bridge");
      const worktree = join(project, ".claude", "worktrees", "fixture-worktree-7a2f");
      const gitDir = join(project, ".git", "worktrees", "fixture-worktree-7a2f");
      const otherProject = join(options.directory, "other-project");
      await Promise.all([
        mkdir(join(project, ".git", "objects"), { recursive: true }),
        mkdir(join(project, ".git", "refs"), { recursive: true }),
        mkdir(gitDir, { recursive: true }), mkdir(worktree, { recursive: true }),
        mkdir(join(otherProject, ".git", "objects"), { recursive: true }),
        mkdir(join(otherProject, ".git", "refs"), { recursive: true }),
      ]);
      trustedCwds.add(project);
      trustedCwds.add(worktree);
      trustedCwds.add(otherProject);
      await Promise.all([
        writeFile(join(project, ".git", "HEAD"), "ref: refs/heads/main\n"),
        writeFile(join(otherProject, ".git", "HEAD"), "ref: refs/heads/main\n"),
        writeFile(join(gitDir, "HEAD"), "ref: refs/heads/task\n"),
        writeFile(join(gitDir, "commondir"), "../..\n"),
        writeFile(join(gitDir, "gitdir"), join(worktree, ".git") + "\n"),
        writeFile(join(worktree, ".git"), `gitdir: ${gitDir}\n`),
      ]);
      Object.assign(native, { cwd: worktree, harnessCwd: worktree, title: "实现并验证中继链路压缩" });
      nativeSessions.splice(0, nativeSessions.length,
        { ...native, sessionId: "browser-e2e-parent", cwd: project, harnessCwd: project, title: "主会话" },
        native,
        { ...native, sessionId: "browser-e2e-fork", title: "真实 Fork 会话", forkedFromSessionId: "browser-e2e-parent" },
        { ...native, sessionId: "browser-e2e-btw-archived", cwd: project, harnessCwd: project, title: "btw: 已结束白名单排查", spawnedFrom: { sessionId: "browser-e2e-parent", btw: true }, isArchived: true },
        { ...native, sessionId: "browser-e2e-other", cwd: otherProject, harnessCwd: otherProject, title: "其他项目会话" },
      );
      await broker.refreshRuntime();
      return { projects: broker.listProjects(), sessions: broker.listSessions() };
    },
    files: (request: BridgeRequest) => controller.handleRequest(request, "mobile", options.deviceId),
    history: () => broker.history(options.sessionId),
    session: () => structuredClone(broker.session(options.sessionId)!),
    receipts: () => state.listNativeDesktopReceipts(),
    queuedReply(enabled: boolean) { reportQueued = enabled; },
    queueResult(method: "promoteQueuedMessage" | "sendSteeredNow" | "cancelQueuedMessage", accepted: boolean) {
      queueResults.set(method, accepted);
    },
    holdQueueAction() {
      let release!: () => void;
      queueGate = new Promise<void>(finish => { release = finish; });
      return () => { queueGate = undefined; release(); };
    },
    async request(request: BridgeRequest) {
      const after = eventLog.latestSeq();
      const result = await controller.handleRequest(request, "mobile", options.deviceId);
      return { result, ...dialogs(after), history: await broker.history(options.sessionId) };
    },
    async enqueue(text: string, mode: "deferred" | "steered" = "deferred") {
      native.turnRunning = true;
      await broker.refreshRuntime();
      const after = eventLog.latestSeq();
      const result = await controller.handleRequest({ kind: "request", requestId: randomUUID(), idempotencyKey: randomUUID(), method: "turn.start", params: { sessionId: options.sessionId, text } }, "mobile", options.deviceId);
      const receipt = state.listNativeDesktopReceipts().at(-1)!;
      if (mode === "steered") {
        const changed = once(broker, "changed");
        inspector.emit("event", { type: "message", sessionId: options.sessionId, message: { type: "command_lifecycle", command_uuid: receipt.messageId, state: "queued" } });
        await changed;
      }
      return { result, receipt: state.listNativeDesktopReceipts().find(value => value.commandId === receipt.commandId)!, events: eventLog.replay(after), history: await broker.history(options.sessionId), session: structuredClone(broker.session(options.sessionId)!) };
    },
    async event(event: Record<string, unknown>) {
      const after = eventLog.latestSeq();
      if (event.type === "steers_rekeyed") for (const { from, to } of event.rekeyedSteers as Array<{ from: string; to: string }>) {
        const message = messages.find(message => message.uuid === from);
        if (message) message.uuid = to;
        if (queued.delete(from)) queued.add(to);
      }
      const changed = once(broker, "changed");
      inspector.emit("event", { ...event, sessionId: options.sessionId });
      await changed;
      await eventLog.flushDeltas(options.sessionId);
      return { events: eventLog.replay(after), history: await broker.history(options.sessionId), session: structuredClone(broker.session(options.sessionId)!) };
    },
    async message(message: Record<string, unknown>) {
      messages.push(message);
      const after = eventLog.latestSeq();
      const changed = once(broker, "changed");
      inspector.emit("event", { type: "message", sessionId: options.sessionId, message });
      await changed;
      await eventLog.flushDeltas(options.sessionId);
      return eventLog.replay(after);
    },
    commands: (request: BridgeRequest) => controller.handleRequest(request, "mobile", options.deviceId),
    configuration: (request: BridgeRequest) => controller.handleRequest(request, "mobile", options.deviceId),
    async rewind(request: BridgeRequest) {
      const after = eventLog.latestSeq();
      let result;
      try { result = await controller.handleRequest(request, "mobile", options.deviceId); }
      finally { if (request.method === "session.rewind") { rewindReadbackFailure = undefined; rewindCompleted = false; } }
      return { result, events: eventLog.replay(after), history: await broker.history(options.sessionId), session: structuredClone(broker.session(options.sessionId)!) };
    },
    list: () => broker.permissionsList(),
    permissionMode: () => native.permissionMode,
    async observe(mode: BridgeSDKPermissionMode) {
      native.permissionMode = mode;
      await broker.refreshRuntime();
      options.onModeChanged?.(mode);
    },
    async open(toolName: string, input: Record<string, unknown>) {
      const requestId = `native-request-${++sequence}`;
      const response = new Promise<NativeApprovalResult>(finish => pending.set(requestId, finish));
      native.pendingToolPermissions.push({ sessionId: options.sessionId, requestId, cliToolUseId: `native-tool-${sequence}`, toolName, input, requestedAt: Date.now() });
      await broker.refreshRuntime();
      const request = broker.permissionsList().find(value => value.requestId === requestId)!;
      options.onRequested(request);
      return { request, response };
    },
    async resolve(request: BridgeRequest) {
      const nativeRequest = broker.permissionsList().find(value => value.requestId === request.params.requestId);
      const result = await controller.handleRequest(request, "mobile", options.deviceId);
      if (nativeRequest) {
        const event = eventLog.replay().findLast(event => event.type === "permission.resolved" && event.data.requestId === nativeRequest.requestId);
        if (!event || typeof event.data.resolvedByDeviceId !== "string" || typeof event.data.resolvedByName !== "string" || typeof event.data.resolvedAt !== "number") {
          throw new Error("Native facade omitted permission resolution attribution");
        }
        options.onResolved(nativeRequest, replies.get(nativeRequest.requestId)!, {
          requestId: nativeRequest.requestId, decision: event.data.decision as BridgePermissionResolution["decision"],
          resolvedByDeviceId: event.data.resolvedByDeviceId, resolvedByName: event.data.resolvedByName, resolvedAt: event.data.resolvedAt,
        });
      }
      return result;
    },
    async close() {
      await broker.close();
      await evidence.close();
      await eventLog.close();
      state.close();
    },
  };
}
