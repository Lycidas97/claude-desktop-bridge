import type { BridgeDesktopRegistrationInfo } from "@bridge/protocol";
import { describe, expect, it, vi } from "vitest";
import type { DesktopSessionRegistrationInput, StoredDesktopRegistration } from "./claude-desktop-session-registrar.js";
import { SessionDesktopRegistration, type SessionDesktopRegistrationOptions } from "./session-desktop-registration.js";

function fixture(previous?: StoredDesktopRegistration) {
  const session = { sessionId: "session-1", cwd: "/project", title: "Session title", createdAt: 10, parentDesktopSessionId: "local_parent", forkLabel: "Fork", ...(previous ? { desktopRegistration: previous } : {}) };
  const context = { session, activeTurn: false, profile: { model: "model-1", effort: "high" as const }, overrides: { model: "override-model", effort: "medium" as const }, lastActivityAt: 20 };
  const register = vi.fn(async (_input: DesktopSessionRegistrationInput, _previous?: StoredDesktopRegistration): Promise<StoredDesktopRegistration> => ({ state: "registered", detail: "Registered", desktopSessionId: "local_session", updatedAt: 30 }));
  const options: SessionDesktopRegistrationOptions = {
    registrar: {
      register,
      changed: vi.fn(() => true),
      publicInfo: vi.fn((next: StoredDesktopRegistration): BridgeDesktopRegistrationInfo => ({ state: next.state, detail: next.detail, updatedAt: next.updatedAt, ...(next.desktopSessionId ? { desktopSessionId: next.desktopSessionId } : {}) })),
    },
    context: vi.fn(() => context), persist: vi.fn(async () => {}), record: vi.fn(async () => {}), changed: vi.fn(),
  };
  return { session, context, register, options, registration: new SessionDesktopRegistration(options) };
}

describe("SessionDesktopRegistration", () => {
  it("projects profile overrides and fork metadata, then persists and publishes only public changes", async () => {
    const { session, register, options, registration } = fixture();
    await registration.reconcile("session-1");
    expect(register).toHaveBeenCalledWith({ sessionId: "session-1", cwd: "/project", title: "Session title", createdAt: 10, lastActivityAt: 20, model: "model-1", effort: "high", overrideModel: "override-model", overrideEffort: "medium", parentDesktopSessionId: "local_parent", forkLabel: "Fork" }, undefined);
    expect(session).toMatchObject({ desktopSessionId: "local_session", desktopRegistration: { state: "registered" } });
    expect(options.persist).toHaveBeenCalledOnce();
    expect(options.record).toHaveBeenCalledWith({ sessionId: "session-1", origin: "system", type: "session.desktop-registration", data: { state: "registered", detail: "Registered", desktopSessionId: "local_session", updatedAt: 30 } });
    expect(options.changed).toHaveBeenCalledOnce();
    expect(vi.mocked(options.persist).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(options.record).mock.invocationCallOrder[0]!);
    vi.mocked(options.registrar!.changed).mockReturnValue(false);
    await registration.reconcile("session-1");
    expect(options.persist).toHaveBeenCalledTimes(1);
    expect(options.record).toHaveBeenCalledTimes(1);
    await registration.close();
  });

  it("passes the effective permission policy into native registration", async () => {
    const { context, register, registration } = fixture();
    Object.assign(context, { permissionMode: "full-access" });
    await registration.reconcile("session-1");
    expect(register).toHaveBeenLastCalledWith(expect.objectContaining({ permissionMode: "full-access" }), undefined);
    Object.assign(context, { permissionMode: "standard" });
    await registration.reconcile("session-1");
    expect(register).toHaveBeenLastCalledWith(expect.objectContaining({ permissionMode: "standard" }), expect.any(Object));
    await registration.close();
  });

  it("skips busy and previously failed sessions unless forced and preserves metadata on registrar failure", async () => {
    const previous: StoredDesktopRegistration = { state: "failed", detail: "Previous failure", updatedAt: 1, metadataPath: "/metadata", metadataSha256: "sha", profileSessionsRoot: "/profile", desktopSessionId: "local_existing", registeredAt: 2, claudePidAtRegistration: 3 };
    const { context, session, register, registration } = fixture(previous);
    await registration.reconcile("session-1");
    expect(register).not.toHaveBeenCalled();
    context.activeTurn = true;
    session.desktopRegistration!.state = "registered";
    await registration.reconcile("session-1");
    expect(register).not.toHaveBeenCalled();
    register.mockRejectedValueOnce(new Error("registrar unavailable"));
    await registration.reconcile("session-1", true);
    expect(register).toHaveBeenCalledOnce();
    expect(session.desktopRegistration).toMatchObject({ ...previous, state: "failed", detail: "Claude Desktop 会话登记失败，Bridge 会话仍可正常使用。", updatedAt: expect.any(Number) });
    await registration.close();
  });

  it("coalesces in-flight registration, clears completed jobs, and awaits jobs during close", async () => {
    const { register, options, registration } = fixture();
    let finish!: (result: StoredDesktopRegistration) => void;
    register.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const first = registration.reconcile("session-1");
    const duplicate = registration.reconcile("session-1", true);
    expect(register).toHaveBeenCalledOnce();
    finish({ state: "registered", detail: "Registered", updatedAt: 30 });
    await Promise.all([first, duplicate]);
    await registration.reconcile("session-1");
    expect(register).toHaveBeenCalledTimes(2);
    register.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const third = registration.reconcile("session-1");
    let closed = false;
    const closing = registration.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    await registration.reconcile("session-2", true);
    expect(register).toHaveBeenCalledTimes(3);
    finish({ state: "registered", detail: "Registered", updatedAt: 40 });
    await Promise.all([third, closing]);
    expect(options.persist).toHaveBeenCalledTimes(3);
  });

  it("applies a forced settings change that arrives during registration", async () => {
    const { context, register, registration } = fixture();
    Object.assign(context, { permissionMode: "standard" });
    let finish!: (result: StoredDesktopRegistration) => void;
    register.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const first = registration.reconcile("session-1");
    Object.assign(context, { permissionMode: "full-access" });
    context.profile.model = "latest-model";
    context.overrides.model = "latest-model";
    const changed = registration.reconcile("session-1", true);
    finish({ state: "registered", detail: "Initial settings", updatedAt: 30 });
    await Promise.all([first, changed]);
    expect(register).toHaveBeenCalledTimes(2);
    expect(register).toHaveBeenLastCalledWith(expect.objectContaining({ model: "latest-model", overrideModel: "latest-model", permissionMode: "full-access" }), expect.any(Object));
    await registration.close();
  });

  it("uses the newest settings when several forced changes share an in-flight registration", async () => {
    const { context, register, registration } = fixture();
    let finish!: (result: StoredDesktopRegistration) => void;
    register.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const first = registration.reconcile("session-1");
    context.overrides.model = "intermediate-model";
    const intermediate = registration.reconcile("session-1", true);
    context.overrides.model = "newest-model";
    const newest = registration.reconcile("session-1", true);
    finish({ state: "registered", detail: "Initial", updatedAt: 30 });
    await Promise.all([first, intermediate, newest]);
    expect(register).toHaveBeenCalledTimes(2);
    expect(register).toHaveBeenLastCalledWith(expect.objectContaining({ overrideModel: "newest-model" }), expect.any(Object));
    await registration.close();
  });

  it("does not start a waiting settings update after close begins", async () => {
    const { context, register, registration } = fixture();
    let finish!: (result: StoredDesktopRegistration) => void;
    register.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const first = registration.reconcile("session-1");
    context.overrides.model = "after-initial";
    const changed = registration.reconcile("session-1", true);
    const closing = registration.close();
    finish({ state: "registered", detail: "Initial", updatedAt: 30 });
    await Promise.all([first, changed, closing]);
    expect(register).toHaveBeenCalledOnce();
  });

  it("ignores absent sessions and absent registrars", async () => {
    const { register, options, registration } = fixture();
    vi.mocked(options.context).mockReturnValue(undefined);
    await registration.reconcile("missing", true);
    const disabled = new SessionDesktopRegistration({ ...options, registrar: undefined });
    await disabled.reconcile("session-1", true);
    expect(register).not.toHaveBeenCalled();
    await registration.close();
    await disabled.close();
  });
});
