import type { BridgeEffort } from "@bridge/protocol";
import type {
  ClaudeDesktopSessionRegistrar,
  DesktopSessionRegistrationInput,
  StoredDesktopRegistration,
} from "./claude-desktop-session-registrar.js";
import type { BridgeEventDraft } from "./session-event-log.js";

interface RegistrationSession {
  sessionId: string;
  cwd: string;
  title: string;
  createdAt: number;
  parentDesktopSessionId?: string;
  forkLabel?: string;
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
    lastActivityAt?: number | undefined;
  } | undefined;
  persist(): Promise<void>;
  record(event: BridgeEventDraft): Promise<unknown>;
  changed(): void;
}

/** Own registration jobs and persistence; the caller supplies session/profile selection. */
export class SessionDesktopRegistration {
  private readonly jobs = new Map<string, Promise<void>>();
  private closed = false;

  constructor(private readonly options: SessionDesktopRegistrationOptions) {}

  async reconcile(sessionId: string, force = false): Promise<void> {
    const registrar = this.options.registrar;
    if (!registrar || this.closed) return;
    const context = this.options.context(sessionId);
    if (!context) return;
    const { session, profile, overrides } = context;
    if (!force && (session.desktopRegistration?.state === "failed" || context.activeTurn)) return;
    const active = this.jobs.get(sessionId);
    if (active) return active;
    const task = (async () => {
      const input: DesktopSessionRegistrationInput = {
        sessionId,
        cwd: session.cwd,
        title: session.title,
        createdAt: session.createdAt,
        lastActivityAt: Math.max(session.createdAt, context.lastActivityAt ?? 0),
        ...(profile.model ? { model: profile.model } : {}),
        ...(profile.effort ? { effort: profile.effort } : {}),
        ...(overrides?.model ? { overrideModel: overrides.model } : {}),
        ...(overrides?.effort ? { overrideEffort: overrides.effort } : {}),
        ...(session.parentDesktopSessionId ? { parentDesktopSessionId: session.parentDesktopSessionId } : {}),
        ...(session.forkLabel ? { forkLabel: session.forkLabel } : {}),
      };
      let next: StoredDesktopRegistration;
      try {
        next = await registrar.register(input, session.desktopRegistration);
      } catch {
        const previous = session.desktopRegistration;
        next = {
          ...(previous?.metadataPath ? { metadataPath: previous.metadataPath } : {}),
          ...(previous?.metadataSha256 ? { metadataSha256: previous.metadataSha256 } : {}),
          ...(previous?.profileSessionsRoot ? { profileSessionsRoot: previous.profileSessionsRoot } : {}),
          ...(previous?.desktopSessionId ? { desktopSessionId: previous.desktopSessionId } : {}),
          ...(previous?.registeredAt ? { registeredAt: previous.registeredAt } : {}),
          ...(previous?.claudePidAtRegistration ? { claudePidAtRegistration: previous.claudePidAtRegistration } : {}),
          state: "failed",
          detail: "Claude Desktop 会话登记失败，Bridge 会话仍可正常使用。",
          updatedAt: Date.now(),
        };
      }
      if (!registrar.changed(session.desktopRegistration, next)) return;
      session.desktopRegistration = next;
      if (next.state === "registered" && next.desktopSessionId) session.desktopSessionId = next.desktopSessionId;
      await this.options.persist();
      await this.options.record({
        sessionId,
        origin: "system",
        type: "session.desktop-registration",
        data: { ...registrar.publicInfo(next) },
      });
      this.options.changed();
    })().finally(() => {
      if (this.jobs.get(sessionId) === task) this.jobs.delete(sessionId);
    });
    this.jobs.set(sessionId, task);
    return task;
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled(this.jobs.values());
  }
}
