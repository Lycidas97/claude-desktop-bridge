import type { BridgeEffort, BridgePermissionMode } from "@bridge/protocol";
import { projectIdForCwd } from "./claude-session-catalog.js";
import type {
  ClaudeDesktopSessionRegistrar,
  DesktopSessionRegistrationInput,
  StoredDesktopRegistration,
} from "./claude-desktop-session-registrar.js";
import type { BridgeEventDraft } from "./session-event-log.js";

interface RegistrationSession {
  sessionId: string;
  cwd: string;
  projectId?: string;
  groupSessionsRoot?: string;
  groupScope?: string;
  title: string;
  createdAt: number;
  parentDesktopSessionId?: string;
  forkLabel?: string;
  sidechat?: boolean;
  desktopSessionId?: string;
  desktopRegistration?: StoredDesktopRegistration;
}

export interface SessionDesktopRegistrationOptions {
  registrar?: Pick<ClaudeDesktopSessionRegistrar, "register" | "changed" | "publicInfo"> | undefined;
  context(sessionId: string): {
    session: RegistrationSession;
    activeTurn: boolean;
    profile: { model?: string; effort?: BridgeEffort };
    overrides?: { model?: string; effort?: BridgeEffort } | undefined;
    permissionMode?: BridgePermissionMode;
    lastActivityAt?: number | undefined;
  } | undefined;
  persist(): Promise<void>;
  record(event: BridgeEventDraft): Promise<unknown>;
  changed(): void;
}

/** Own registration jobs and persistence; the caller supplies session/profile selection. */
export class SessionDesktopRegistration {
  private readonly jobs = new Map<string, { input: DesktopSessionRegistrationInput; task: Promise<void> }>();
  private closed = false;

  constructor(private readonly options: SessionDesktopRegistrationOptions) {}

  async reconcile(sessionId: string, force = false): Promise<void> {
    const registrar = this.options.registrar;
    if (!registrar || this.closed) return;
    const context = this.options.context(sessionId);
    if (!context) return;
    const { session, profile, overrides } = context;
    if (!force && (session.desktopRegistration?.state === "failed" || context.activeTurn)) return;
    const input: DesktopSessionRegistrationInput = {
      sessionId,
      cwd: session.cwd,
      ...(session.projectId && session.projectId !== projectIdForCwd(session.cwd) ? { groupId: session.projectId } : {}),
      ...(session.groupSessionsRoot ? { groupSessionsRoot: session.groupSessionsRoot } : {}),
      ...(session.groupScope ? { groupScope: session.groupScope } : {}),
      title: session.title,
      createdAt: session.createdAt,
      lastActivityAt: Math.max(session.createdAt, context.lastActivityAt ?? 0),
      ...(profile.model ? { model: profile.model } : {}),
      ...(profile.effort ? { effort: profile.effort } : {}),
      ...(overrides?.model ? { overrideModel: overrides.model } : {}),
      ...(overrides?.effort ? { overrideEffort: overrides.effort } : {}),
      ...(context.permissionMode ? { permissionMode: context.permissionMode } : {}),
      ...(session.parentDesktopSessionId ? { parentDesktopSessionId: session.parentDesktopSessionId } : {}),
      ...(session.forkLabel ? { forkLabel: session.forkLabel } : {}),
      ...(session.sidechat ? { sidechat: true } : {}),
    };
    const active = this.jobs.get(sessionId);
    if (active) {
      await active.task;
      if (force && JSON.stringify(active.input) !== JSON.stringify(input)) return this.reconcile(sessionId, true);
      return;
    }
    const task = (async () => {
      let next: StoredDesktopRegistration;
      try {
        next = await registrar.register(input, session.desktopRegistration);
      } catch {
        next = {
          ...session.desktopRegistration,
          state: "failed",
          detail: "Claude Desktop 会话登记失败，Bridge 会话仍可正常使用。",
          updatedAt: Date.now(),
        };
      }
      if (!registrar.changed(session.desktopRegistration, next)) return;
      session.desktopRegistration = next;
      if (next.desktopSessionId) session.desktopSessionId = next.desktopSessionId;
      await this.options.persist();
      await this.options.record({
        sessionId,
        origin: "system",
        type: "session.desktop-registration",
        data: { ...registrar.publicInfo(next) },
      });
      this.options.changed();
    })().finally(() => {
      if (this.jobs.get(sessionId)?.task === task) this.jobs.delete(sessionId);
    });
    this.jobs.set(sessionId, { input, task });
    return task;
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.jobs.values()].map((job) => job.task));
  }
}
