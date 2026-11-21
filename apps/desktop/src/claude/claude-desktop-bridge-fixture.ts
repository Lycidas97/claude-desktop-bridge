import { EventEmitter, once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { vi } from "vitest";
import { ConversationStateStore } from "../controller/conversation-state-store.js";
import { SessionEventLog } from "../controller/session-event-log.js";
import { ClaudeDesktopBridge } from "./claude-desktop-bridge.js";
import { NativeCallError } from "./claude-desktop-inspector.js";
import type { ClaudeCatalogSnapshot } from "./claude-session-catalog.js";

export class NativeDesktop extends EventEmitter {
  ready = false;
  calls: Array<{ method: string; args: unknown[] }> = [];
  sessions: Array<Record<string, unknown>> = [{ sessionId: "local-native", cwd: "/project", title: "Native", isRunning: true, turnRunning: false, permissionMode: "default", model: "native-model", pendingToolPermissions: [] }];
  page: Record<string, unknown> = { messages: [], hasMore: false };
  resolvedSessionFiles = new Map<string, string>();
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
  applyOutputStyle = true;
  globalOutputStyles: { builtIns: string[]; customs: string[] } = { builtIns: [], customs: [] };
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
  promptChoiceValues: string[] | undefined;
  applyPrSettings = true;
  gitInfo: { branch: string } | null = { branch: "feature/owned" };
  promptResult = true;
  ignoreStartTitle = false;
  inputQueueDrained = vi.fn(async () => false);
  async promptChoices() { return this.promptChoiceValues; }
  async prPreferences(sessionId: string) {
    const session = this.sessions.find(session => session.sessionId === sessionId);
    return session ? { onlyOwnPrs: session.autoFixOwnPrs === true, nextOwnPrArmed: typeof session.autoFixNextOwnPr === "string" && session.autoFixNextOwnPr.length > 0 } : undefined;
  }
  async startAutoFixOnNextPr(sessionId: string, branch: string) {
    this.calls.push({ method: "armAutoFixOnNextPr", args: [sessionId, branch] });
    const session = this.sessions.find(session => session.sessionId === sessionId)!;
    if (this.applyPrSettings) session.autoFixNextOwnPr = branch;
  }
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
    if (method === "resolveSessionFileQuietly") return this.resolvedSessionFiles.get(String(args[1])) ?? null;
    if (method === "getContextUsage") return structuredClone(this.contextUsage);
    if (method === "getGitInfo") return this.gitInfo;
    const promptField = ({ respondToRefusalFallbackPrompt: "pendingRefusalFallbackPrompt", respondToAutoModeServerFallbackPrompt: "pendingAutoModeServerFallbackPrompt", respondToLanyardConsent: "pendingLanyardConsent", respondToViolinBowPrompt: "pendingViolinBowPrompt", answerPendingCwdTrust: "pendingCwdTrustPrompt" } as Record<string, string>)[method];
    if (promptField) {
      if (!this.promptResult || !session || (session[promptField] as { promptId?: string } | undefined)?.promptId !== args[1]) return false;
      delete session[promptField];
      return true;
    }
    if (method === "setBoundPrAutoFix" && session) {
      const binding = (session.prs as Array<Record<string, unknown>>).find(pr => pr.repo === args[1] && pr.prNumber === args[2] && pr.host === args[4]);
      if (binding && this.applyPrSettings) binding.autoFix = args[3];
      return;
    }
    if (method === "setAutoFixOwnPrsWanted" && session && this.applyPrSettings) session.autoFixOwnPrs = args[1];
    if (method === "getPrOverview") return { success: true, overview: { title: "Native pull request", state: "OPEN", url: "https://github.com/owner/repo/pull/42" } };
    if (method === "getPrChecks") return { success: true, checks: [{ name: "ci/local-distributed", state: "FAILURE", bucket: "fail", url: "https://github.com/owner/repo/actions/runs/1" }] };
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
    if (method === "listGlobalOutputStyles") return this.globalOutputStyles;
    if (method === "applyFlagSettings" && session) {
      const { outputStyle } = args[1] as { outputStyle: string };
      if (!(session.availableOutputStyles as string[] | undefined)?.includes(outputStyle)) throw new NativeCallError("Style not available");
      if (this.applyOutputStyle) session.outputStyle = outputStyle;
      return;
    }
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
    if (method === "updateSession" && session && args[1] && typeof args[1] === "object") {
      Object.assign(session, args[1]);
      return;
    }
    if (method === "start") {
      const input = args[0] as Record<string, unknown>;
      if (this.untrustedCwds.has(String(input.cwd))) {
        throw new NativeCallError("Error invoking remote method '$eipc_message$d32c5f9b_$_claude.web_$_LocalSessions_$_start': WorkspaceTrustError: Workspace requires trust approval before starting a session. [ccdErrorCategory:trust_required]");
      }
      this.sessions.push({
        ...input,
        ...(this.ignoreStartTitle ? { title: "" } : {}),
        isRunning: false,
        turnRunning: false,
      });
      return { sessionId: input.sessionId };
    }
    return undefined;
  }
}

export function withDatabase<T>(databasePath: string, run: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(databasePath);
  try {
    return run(db);
  } finally {
    db.close();
  }
}

export async function fixture(legacy = false, evidence?: ConstructorParameters<typeof ClaudeDesktopBridge>[0]["evidence"], useRuntimeFiles = false) {
  const directory = await mkdtemp(join(tmpdir(), "bridge-native-"));
  const databasePath = join(directory, "state.sqlite");
  const state = new ConversationStateStore({ databasePath, sessionsPath: join(directory, "sessions.json"), queuePath: join(directory, "queue.json"), masterSecret: Buffer.alloc(32, 7).toString("base64url") });
  if (legacy) {
    withDatabase(databasePath, (db) => {
      db.exec(`
        CREATE TABLE provider_profiles (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          name TEXT NOT NULL,
          status TEXT NOT NULL,
          detail TEXT NOT NULL,
          configured INTEGER NOT NULL,
          local_only_configuration INTEGER NOT NULL,
          read_only INTEGER NOT NULL,
          models_json TEXT NOT NULL,
          default_model TEXT,
          refreshed_at INTEGER
        ) STRICT;
        CREATE TABLE conversations (
          id TEXT PRIMARY KEY,
          cwd TEXT NOT NULL,
          title TEXT NOT NULL,
          source TEXT NOT NULL,
          active_lane_id TEXT,
          active_provider_profile_id TEXT,
          route_state TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE lanes (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL,
          provider_profile_id TEXT NOT NULL,
          provider_kind TEXT NOT NULL,
          native_session_id TEXT,
          status TEXT NOT NULL,
          access TEXT NOT NULL,
          model TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          last_used_at INTEGER,
          FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
          FOREIGN KEY (provider_profile_id) REFERENCES provider_profiles(id)
        ) STRICT;
        CREATE TABLE bridge_sessions (
          session_id TEXT PRIMARY KEY,
          session_json TEXT NOT NULL
        ) STRICT;
        CREATE TABLE turn_queue (
          command_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          lane_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL UNIQUE,
          state TEXT NOT NULL,
          turn_json TEXT NOT NULL,
          FOREIGN KEY (lane_id) REFERENCES lanes(id)
        ) STRICT;
      `);
      db.prepare(`
        INSERT INTO provider_profiles(id, kind, name, status, detail, configured, local_only_configuration, read_only, models_json)
        VALUES ('provider:claude-3p:default', 'claude-3p', 'Claude-3p', 'unavailable', '', 0, 0, 0, '[]')
      `).run();
      db.prepare(`
        INSERT INTO conversations(id, cwd, title, source, active_lane_id, active_provider_profile_id, route_state, created_at, updated_at)
        VALUES ('legacy-unlinked', '/legacy', 'Native', 'bridge', 'lane:claude-3p:legacy-unlinked', 'provider:claude-3p:default', 'ready', 1, 1)
      `).run();
      db.prepare(`
        INSERT INTO lanes(id, conversation_id, provider_profile_id, provider_kind, native_session_id, status, access, model, created_at, updated_at, last_used_at)
        VALUES ('lane:claude-3p:legacy-unlinked', 'legacy-unlinked', 'provider:claude-3p:default', 'claude-3p', 'legacy-unlinked', 'active', 'read-write', NULL, 1, 1, 1)
      `).run();
      db.prepare("INSERT INTO bridge_sessions(session_id, session_json) VALUES (?, ?)").run(
        "legacy-unlinked",
        JSON.stringify({ sessionId: "legacy-unlinked", cwd: "/legacy", title: "Native", createdAt: 1 }),
      );
      db.prepare(`
        INSERT INTO turn_queue(command_id, session_id, lane_id, idempotency_key, state, turn_json)
        VALUES ('old-command', 'legacy-unlinked', 'lane:claude-3p:legacy-unlinked', 'old-key', 'pending', ?)
      `).run(JSON.stringify({
        sessionId: "legacy-unlinked", laneId: "lane:claude-3p:legacy-unlinked", commandId: "old-command",
        requestId: "old-request", idempotencyKey: "old-key", state: "pending", text: "Never replay",
      }));
    });
  }
  await state.initialize();
  const eventLog = new SessionEventLog(join(directory, "events.jsonl"));
  await eventLog.initialize();
  const native = new NativeDesktop();
  const scanCatalog = vi.fn<() => Promise<ClaudeCatalogSnapshot>>().mockResolvedValue({ projects: [], sessions: [], observedAt: 0 });
  const options = { eventLog, conversationState: state, inspector: native, settingsPath: join(directory, "settings.json"), ...(evidence ? { evidence } : {}), refreshIntervalMs: 60_000 };
  const bridge = new ClaudeDesktopBridge(useRuntimeFiles ? options : { ...options, scanCatalog });
  await bridge.initialize();
  return {
    bridge, native, state, eventLog, options: { ...options, scanCatalog }, directory, databasePath,
    async message(message: Record<string, unknown>) {
      const changed = once(bridge, "changed");
      native.emit("event", { type: "message", sessionId: "local-native", message });
      await changed;
    },
    async close() { await bridge.close(); await eventLog.close(); state.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

export const turnInput = { sessionId: "local-native", text: "hello", requestId: "request", idempotencyKey: "key", origin: "mobile" } as const;
