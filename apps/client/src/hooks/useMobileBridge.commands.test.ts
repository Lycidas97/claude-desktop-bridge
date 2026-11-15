import type { BridgeHostSnapshot, BridgePermissionInfo, BridgeProjectInfo, BridgeRequest, BridgeSessionInfo, BridgeSlashCommandCatalog } from "@bridge/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMobileBridge } from "./useMobileBridge.js";

const harness = vi.hoisted(() => ({
  state: undefined as any,
  stateReady: false,
  refs: [] as Array<{ current: any }>,
  requests: [] as BridgeRequest[],
  response: {} as Record<string, unknown>,
  error: undefined as { code: string; message: string } | undefined,
  encrypt: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    if (!harness.stateReady) {
      harness.state = initial;
      harness.stateReady = true;
    }
    return [
      harness.state,
      (updater: unknown) => {
        harness.state = typeof updater === "function" ? (updater as (prev: unknown) => unknown)(harness.state) : updater;
        if (harness.refs[0]) harness.refs[0].current = harness.state;
      },
    ];
  },
  useRef(initial: unknown) {
    const index = harness.refs.length;
    const ref = { current: initial as any };
    if (index === 0 && harness.state !== undefined) ref.current = harness.state;
    if (index === 1) ref.current = { encrypt: harness.encrypt, identity: { roomId: "room-a" } };
    if (index === 3) ref.current = {
      state: "connected",
      sendEnvelope: async ({ request }: { request: BridgeRequest }) => {
        harness.requests.push(request);
        const pending = harness.refs[6]!.current.get(request.requestId);
        clearTimeout(pending.timer);
        harness.refs[6]!.current.delete(request.requestId);
        pending.resolve({ kind: "response", requestId: request.requestId,
          ...(harness.error ? { ok: false, error: harness.error } : { ok: true, result: harness.response }),
        });
      },
    };
    harness.refs.push(ref);
    return ref;
  },
  useCallback: (callback: unknown) => callback,
  useEffect: () => undefined,
}));

beforeEach(() => {
  harness.state = undefined; harness.stateReady = false;
  harness.refs = []; harness.requests = []; harness.response = {}; harness.error = undefined;
  harness.encrypt.mockReset().mockImplementation(async (request: BridgeRequest) => ({ id: request.requestId, sentAt: 1, request }));
});

describe("createSection", () => {
  it("waits for the native result without persisting an offline creation", async () => {
    const project: BridgeProjectInfo = { projectId: "native-section", name: "Research", kind: "desktop-group", cwd: "", sessionCount: 0, runningCount: 0, pendingCount: 0, lastActivityAt: 0 };
    harness.response = { project };
    await expect(useMobileBridge().createSection("Research")).resolves.toEqual(project);
    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0]).toMatchObject({ method: "section.create", params: { name: "Research" } });
    expect(harness.encrypt.mock.calls[0]![6]).toBe(true);
  });

  it("preserves a native creation error", async () => {
    harness.error = { code: "REQUEST_FAILED", message: "The sidebar isn't signed in to an account yet." };
    await expect(useMobileBridge().createSection("Research")).rejects.toThrow(harness.error.message);
    expect(harness.requests.map(request => request.method)).toEqual(["section.create"]);
  });

  it("rejects offline before encrypting or queuing a native creation", async () => {
    const bridge = useMobileBridge();
    harness.refs[3]!.current.state = "closed";
    await expect(bridge.createSection("Research")).rejects.toThrow("电脑当前离线");
    expect(harness.encrypt).not.toHaveBeenCalled();
    expect(harness.requests).toEqual([]);
  });
});

describe("loadSessionCommands", () => {
  it("uses the read-only command request, waits for its catalog, and does not persist an outbox envelope", async () => {
    const catalog: BridgeSlashCommandCatalog = { sessionId: "fork-A", commands: [{ name: "review", description: "检查变更" }], warnings: ["部分目录不可读"] };
    harness.response = { catalog };
    await expect(useMobileBridge().loadSessionCommands("fork-A")).resolves.toEqual(catalog);
    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0]).toMatchObject({ method: "session.commands", params: { sessionId: "fork-A" } });
    expect(harness.encrypt.mock.calls[0]![6]).toBe(true);
  });

  it("propagates a host failure to the menu", async () => {
    harness.error = { code: "READ_FAILED", message: "无法读取命令目录" };
    await expect(useMobileBridge().loadSessionCommands("A")).rejects.toThrow("无法读取命令目录");
    expect(harness.requests.map(request => request.method)).toEqual(["session.commands"]);
  });

  it("rejects offline before encrypting or queuing a catalog request", async () => {
    const bridge = useMobileBridge();
    harness.refs[3]!.current.state = "closed";
    await expect(bridge.loadSessionCommands("A")).rejects.toThrow("电脑当前离线");
    expect(harness.encrypt).not.toHaveBeenCalled();
    expect(harness.requests).toEqual([]);
  });
});

describe("moveSessionSection", () => {
  const movedSession: BridgeSessionInfo = {
    sessionId: "desktop-1",
    projectId: "sec-misc",
    projectName: "杂活",
    cwd: "/work/杂活/colab-connect",
    title: "Colab task",
    source: "desktop",
    ownership: "DESKTOP_NATIVE_IDLE",
    transport: "claude-desktop-native",
    turnState: "idle",
    lastActivityAt: 10,
    pendingCount: 0,
  };
  const projects: BridgeProjectInfo[] = [
    { projectId: "sec-misc", name: "杂活", kind: "desktop-group", cwd: "/work/杂活/colab-connect", sessionCount: 1, runningCount: 0, pendingCount: 0, lastActivityAt: 10 },
  ];

  it("sends section.move without offline persistence and supports both section IDs and null ungrouping", async () => {
    harness.response = { session: movedSession, projects };
    await expect(useMobileBridge().moveSessionSection("desktop-1", "sec-misc")).resolves.toEqual({ session: movedSession, projects });
    expect(harness.requests[0]).toMatchObject({ method: "section.move", params: { sessionId: "desktop-1", sectionId: "sec-misc" } });
    expect(harness.encrypt.mock.calls[0]![6]).toBe(true);

    harness.refs = []; harness.requests = [];
    harness.response = { session: { ...movedSession, projectId: "dir-colab", projectName: "colab-connect" }, projects: [] };
    await useMobileBridge().moveSessionSection("desktop-1", null);
    expect(harness.requests[0]).toMatchObject({ method: "section.move", params: { sessionId: "desktop-1", sectionId: null } });
  });

  it("propagates native move errors and rejects offline before encrypting", async () => {
    harness.error = { code: "REQUEST_FAILED", message: "This session cannot be moved between Sections" };
    await expect(useMobileBridge().moveSessionSection("desktop-1", "sec-misc")).rejects.toThrow("This session cannot be moved between Sections");

    harness.refs = []; harness.requests = []; harness.error = undefined;
    harness.encrypt.mockClear();
    const bridge = useMobileBridge();
    harness.refs[3]!.current.state = "closed";
    await expect(bridge.moveSessionSection("desktop-1", "sec-misc")).rejects.toThrow("电脑当前离线");
    expect(harness.encrypt).not.toHaveBeenCalled();
    expect(harness.requests).toEqual([]);
  });
});

describe("createDirectory", () => {
  it("sends directory.mkdir without offline persistence and returns the created path", async () => {
    harness.response = { path: "/work/杂活/colab-connect" };
    await expect(useMobileBridge().createDirectory("/work/杂活", "colab-connect")).resolves.toBe("/work/杂活/colab-connect");
    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0]).toMatchObject({ method: "directory.mkdir", params: { parentPath: "/work/杂活", name: "colab-connect" } });
    expect(harness.encrypt.mock.calls[0]![6]).toBe(true);
  });

  it("propagates mkdir validation errors and rejects offline before encrypting", async () => {
    harness.error = { code: "INVALID_PARAMS", message: "Folder name must be a single directory name" };
    await expect(useMobileBridge().createDirectory("/work/杂活", "a/b")).rejects.toThrow("Folder name must be a single directory name");

    harness.refs = []; harness.requests = []; harness.error = undefined;
    harness.encrypt.mockClear();
    const bridge = useMobileBridge();
    harness.refs[3]!.current.state = "closed";
    await expect(bridge.createDirectory("/work/杂活", "sub")).rejects.toThrow("电脑当前离线");
    expect(harness.encrypt).not.toHaveBeenCalled();
    expect(harness.requests).toEqual([]);
  });
});

describe("renameSection and deleteSection", () => {
  const renamedProject: BridgeProjectInfo = {
    projectId: "section:sec-misc",
    name: "核心任务",
    kind: "desktop-group",
    cwd: "/work/杂活/colab-connect",
    sessionCount: 1,
    runningCount: 0,
    pendingCount: 0,
    lastActivityAt: 10,
  };

  it("sends section.rename and section.delete without offline persistence", async () => {
    harness.response = { project: renamedProject, projects: [renamedProject], sessions: [] };
    await expect(useMobileBridge().renameSection("section:sec-misc", "核心任务")).resolves.toEqual({
      project: renamedProject,
      projects: [renamedProject],
      sessions: [],
    });
    expect(harness.requests[0]).toMatchObject({
      method: "section.rename",
      params: { sectionId: "section:sec-misc", name: "核心任务" },
    });
    expect(harness.encrypt.mock.calls[0]![6]).toBe(true);

    harness.refs = [];
    harness.requests = [];
    harness.response = { projects: [], sessions: [] };
    await expect(useMobileBridge().deleteSection("section:sec-misc")).resolves.toEqual({
      projects: [],
      sessions: [],
    });
    expect(harness.requests[0]).toMatchObject({
      method: "section.delete",
      params: { sectionId: "section:sec-misc" },
    });
    expect(harness.encrypt.mock.calls[0]![6]).toBe(true);
  });

  it("propagates native errors and rejects offline before encrypting", async () => {
    harness.error = { code: "REQUEST_FAILED", message: "Built-in sections cannot be deleted" };
    await expect(useMobileBridge().deleteSection("section:sessions")).rejects.toThrow("Built-in sections cannot be deleted");

    harness.refs = [];
    harness.requests = [];
    harness.error = undefined;
    harness.encrypt.mockClear();
    const bridge = useMobileBridge();
    harness.refs[3]!.current.state = "closed";
    await expect(bridge.renameSection("section:sec-misc", "新名")).rejects.toThrow("电脑当前离线");
    await expect(bridge.deleteSection("section:sec-misc")).rejects.toThrow("电脑当前离线");
    expect(harness.encrypt).not.toHaveBeenCalled();
    expect(harness.requests).toEqual([]);
  });
});

describe("loadBackgroundTasks", () => {
  it("syncs returned session runningSubagents into snapshot while stripping backgroundTasks payload", async () => {
    const baseSession: BridgeSessionInfo = {
      sessionId: "desktop-1",
      projectId: "proj-1",
      projectName: "bridge",
      cwd: "/work/bridge",
      title: "CI runner",
      source: "desktop",
      ownership: "DESKTOP_NATIVE_IDLE",
      transport: "claude-desktop-native",
      turnState: "idle",
      lastActivityAt: 100,
      pendingCount: 0,
    };
    const bridge = useMobileBridge();
    harness.state = {
      ...harness.state,
      snapshot: {
        host: { hostId: "h1", name: "Mac", platform: "darwin", version: "1.4.0", lastSeenAt: 100, capabilities: ["claude.native-relay.v1"] },
        runtime: { state: "ready", detail: "ready", activeTurns: 0, maxParallelTurns: 0 },
        projects: [],
        sessions: [baseSession],
        permissions: [],
        latestSeq: 1,
      },
    };
    const tasks = [{ id: "agent-1", kind: "subagent" as const, description: "Run local CI", state: "running" as const, startedAt: 90, updatedAt: 120 }];
    harness.response = {
      session: {
        ...baseSession,
        runningSubagents: { count: 1, lastUpdatedAt: 120 },
        backgroundTasks: tasks,
      },
    };
    await expect(bridge.loadBackgroundTasks("desktop-1")).resolves.toEqual(tasks);
    expect(harness.requests[0]).toMatchObject({ method: "session.configuration", params: { sessionId: "desktop-1", includeBackgroundTasks: true } });
    expect(harness.state.snapshot.sessions[0]).toEqual({
      ...baseSession,
      runningSubagents: { count: 1, lastUpdatedAt: 120 },
    });
    expect(harness.state.snapshot.sessions[0].backgroundTasks).toBeUndefined();
  });
});

describe("RPC state projection & host summary sync", () => {
  it("projects section create/move/rename/delete and fork/rename into snapshot and active host summary", async () => {
    const session: BridgeSessionInfo = {
      sessionId: "sess-1",
      projectId: "proj-1",
      projectName: "Bridge",
      cwd: "/work/bridge",
      title: "Initial",
      source: "bridge",
      ownership: "BRIDGE_IDLE",
      transport: "bridge-host",
      turnState: "idle",
      model: "sonnet",
      lastActivityAt: 100,
      pendingCount: 0,
    };
    const runningFork: BridgeSessionInfo = {
      ...session,
      sessionId: "sess-fork",
      title: "Forked Branch",
      ownership: "BRIDGE_RUNNING",
      turnState: "running",
      lastActivityAt: 110,
    };
    const createdSection: BridgeProjectInfo = {
      projectId: "sec-new",
      name: "Research",
      kind: "desktop-group",
      cwd: "",
      sessionCount: 0,
      runningCount: 0,
      pendingCount: 0,
      lastActivityAt: 0,
    };
    const bridge = useMobileBridge();
    const snapshot: BridgeHostSnapshot = {
      host: {
        hostId: "h1",
        pairingEpoch: 1,
        name: "Mac",
        relayUrl: "wss://relay.example/ws",
        online: true,
        version: "1.4.0",
        lastSeenAt: 120,
        capabilities: [],
      },
      devices: [],
      runtime: {
        state: "ready",
        detail: "ready",
        activeTurns: 0,
        maxParallelTurns: 2,
        desktopIntegration: { state: "ready", detail: "ready", enabled: true, canRestart: false },
      },
      projects: [{ ...createdSection, projectId: "proj-1", name: "Bridge" }],
      sessions: [session],
      permissions: [],
      latestSeq: 5,
    };
    harness.state = {
      ...harness.state,
      activeHostId: "room-a",
      hosts: [{
        hostId: "h1",
        roomId: "room-a",
        desktopName: "Mac",
        relayUrl: "wss://relay.example/ws",
        needsRepair: false,
        status: "standby",
        activeTurns: 0,
        path: "public-relay",
      }],
      snapshot,
    };
    harness.refs[0]!.current = harness.state;

    harness.response = { project: createdSection };
    await bridge.createSection("Research");
    expect(harness.state.snapshot.projects.map((p: BridgeProjectInfo) => p.projectId)).toEqual(["sec-new", "proj-1"]);

    harness.response = { session: runningFork };
    await bridge.forkSession("sess-1", "Forked Branch");
    expect(harness.state.snapshot.sessions.map((s: BridgeSessionInfo) => s.sessionId)).toEqual(["sess-fork", "sess-1"]);
    expect(harness.state.hosts[0]).toMatchObject({ status: "running", activeTurns: 1 });

    harness.response = { session: { sessionId: "sess-fork", title: "Renamed Fork" } };
    await bridge.renameSession("sess-fork", "Renamed Fork");
    expect(harness.state.snapshot.sessions[0]).toMatchObject({
      sessionId: "sess-fork",
      title: "Renamed Fork",
      model: "sonnet",
      turnState: "running",
    });

    harness.response = {
      session: { ...session, projectId: "sec-new", projectName: "Research" },
      projects: [{ ...createdSection, sessionCount: 1 }, { ...createdSection, projectId: "proj-1", name: "Bridge" }],
    };
    await bridge.moveSessionSection("sess-1", "sec-new");
    expect(harness.state.snapshot.sessions.find((s: BridgeSessionInfo) => s.sessionId === "sess-1")?.projectId).toBe("sec-new");

    harness.response = { project: { ...createdSection, name: "Core Research" } };
    await bridge.renameSection("sec-new", "Core Research");
    expect(harness.state.snapshot.projects[0]?.name).toBe("Core Research");

    harness.response = {};
    await bridge.deleteSection("sec-new");
    expect(harness.state.snapshot.projects.map((p: BridgeProjectInfo) => p.projectId)).toEqual(["proj-1"]);
  });

  it("dismisses resolved permission and clears ALREADY_RESOLVED permissions while syncing host status", async () => {
    const p1: BridgePermissionInfo = {
      requestId: "perm-1",
      sessionId: "sess-1",
      toolUseId: "tu-1",
      toolName: "Bash",
      input: { command: "ls" },
      createdAt: 1,
      canAllowAlways: false,
    };
    const p2: BridgePermissionInfo = { ...p1, requestId: "perm-2", toolUseId: "tu-2" };
    const bridge = useMobileBridge();
    harness.state = {
      ...harness.state,
      activeHostId: "room-a",
      permissions: [p1, p2],
      hosts: [{
        hostId: "h1",
        roomId: "room-a",
        desktopName: "Mac",
        relayUrl: "wss://relay.example/ws",
        needsRepair: false,
        status: "attention",
        activeTurns: 1,
        attentionSessionId: "sess-1",
        path: "public-relay",
      }],
      snapshot: {
        host: { hostId: "h1", name: "Mac", platform: "darwin", version: "1.4.0", lastSeenAt: 120, capabilities: [] },
        runtime: { state: "ready", detail: "ready", activeTurns: 0, maxParallelTurns: 2 },
        projects: [],
        sessions: [{
          sessionId: "sess-1",
          projectId: "proj-1",
          projectName: "Bridge",
          cwd: "/work/bridge",
          title: "Waiting",
          source: "bridge",
          ownership: "BRIDGE_IDLE",
          turnState: "waiting",
          lastActivityAt: 100,
          pendingCount: 0,
        }],
        permissions: [p1, p2],
        latestSeq: 5,
      },
    };
    harness.refs[0]!.current = harness.state;

    harness.response = {};
    await bridge.resolvePermission("perm-1", "allow-once");
    expect(harness.state.permissions.map((p: BridgePermissionInfo) => p.requestId)).toEqual(["perm-2"]);
    expect(harness.state.snapshot.permissions.map((p: BridgePermissionInfo) => p.requestId)).toEqual(["perm-2"]);
    expect(harness.state.hosts[0]?.status).toBe("attention");

    // ALREADY_RESOLVED removes the stale permission, calls events.resume, and restores standby summary.
    let callCount = 0;
    harness.refs[3]!.current.sendEnvelope = async ({ request }: { request: BridgeRequest }) => {
      harness.requests.push(request);
      callCount += 1;
      const pending = harness.refs[6]!.current.get(request.requestId);
      clearTimeout(pending.timer);
      harness.refs[6]!.current.delete(request.requestId);
      if (callCount === 1) {
        pending.resolve({
          kind: "response",
          requestId: request.requestId,
          ok: false,
          error: { code: "ALREADY_RESOLVED", message: "Permission already handled" },
        });
      } else {
        pending.resolve({
          kind: "response",
          requestId: request.requestId,
          ok: true,
          result: { events: [], latestSeq: 5, nextSeq: 5, hasMore: false },
        });
      }
    };
    await expect(bridge.resolvePermission("perm-2", "allow-once")).rejects.toThrow("Permission already handled");
    expect(harness.requests.map((r) => r.method)).toEqual(["permission.resolve", "permission.resolve", "events.resume"]);
    expect(harness.state.permissions).toEqual([]);
    expect(harness.state.snapshot.sessions[0]?.turnState).toBe("idle");
    expect(harness.state.hosts[0]?.status).toBe("standby");
    expect(harness.state.hosts[0]?.attentionSessionId).toBeUndefined();
  });

  it("projects openSession history + evidence and preserves nextCursor on loadOlderEvidence failure", async () => {
    const bundle = (id: string, startedAt: number) => ({
      id,
      sessionId: "sess-1",
      source: "bridge-host" as const,
      confidence: "exact" as const,
      state: "ready" as const,
      startedAt,
      toolCount: 0,
      changeCount: 0,
      artifactCount: 0,
      tools: [],
      artifacts: [],
      warnings: [],
    });
    const session: BridgeSessionInfo = {
      sessionId: "sess-1",
      projectId: "proj-1",
      projectName: "Bridge",
      cwd: "/work/bridge",
      title: "Opened",
      source: "bridge",
      ownership: "BRIDGE_IDLE",
      transport: "bridge-host",
      turnState: "idle",
      lastActivityAt: 200,
      pendingCount: 0,
    };
    const bridge = useMobileBridge();
    harness.state = {
      ...harness.state,
      activeHostId: "room-a",
      hosts: [{
        hostId: "h1",
        roomId: "room-a",
        desktopName: "Mac",
        relayUrl: "wss://relay.example/ws",
        needsRepair: false,
        status: "standby",
        activeTurns: 0,
        path: "public-relay",
      }],
      snapshot: {
        host: {
          hostId: "h1",
          pairingEpoch: 1,
          name: "Mac",
          relayUrl: "wss://relay.example/ws",
          online: true,
          version: "1.4.0",
          lastSeenAt: 200,
          capabilities: [],
        },
        devices: [],
        runtime: {
          state: "ready",
          detail: "ready",
          activeTurns: 0,
          maxParallelTurns: 2,
          desktopIntegration: { state: "ready", detail: "ready", enabled: true, canRestart: false },
        },
        projects: [],
        sessions: [{ ...session, title: "Before Open" }],
        permissions: [],
        latestSeq: 5,
      },
    };
    harness.refs[0]!.current = harness.state;

    let failEvidenceLoad = false;
    harness.refs[3]!.current.sendEnvelope = async ({ request }: { request: BridgeRequest }) => {
      harness.requests.push(request);
      const pending = harness.refs[6]!.current.get(request.requestId);
      clearTimeout(pending.timer);
      harness.refs[6]!.current.delete(request.requestId);
      if (request.method === "session.open") {
        pending.resolve({
          kind: "response",
          requestId: request.requestId,
          ok: true,
          result: {
            session,
            history: {
              sessionId: "sess-1",
              items: [{ id: "h-1", sessionId: "sess-1", role: "user", text: "hi", createdAt: 1, origin: "claude-desktop" }],
              hasMore: false,
            },
          },
        });
        return;
      }
      if (failEvidenceLoad) {
        pending.resolve({
          kind: "response",
          requestId: request.requestId,
          ok: false,
          error: { code: "ERR", message: "Evidence page unavailable" },
        });
        return;
      }
      const cursor = request.params.cursor as string | undefined;
      pending.resolve({
        kind: "response",
        requestId: request.requestId,
        ok: true,
        result: {
          evidence: cursor === "ev-cur-1"
            ? { sessionId: "sess-1", items: [bundle("ev-1", 10)], hasMore: false }
            : { sessionId: "sess-1", items: [bundle("ev-2", 20)], hasMore: true, nextCursor: "ev-cur-1" },
        },
      });
    };

    await bridge.openSession("sess-1");
    await vi.waitFor(() => expect(harness.state.evidence["sess-1"]?.status).toBe("ready"));
    expect(harness.state.snapshot.sessions[0]?.title).toBe("Opened");
    expect(harness.state.histories["sess-1"]?.items.map((item: { id: string }) => item.id)).toEqual(["h-1"]);
    expect(harness.state.evidence["sess-1"]).toMatchObject({
      status: "ready",
      hasMore: true,
      nextCursor: "ev-cur-1",
    });

    failEvidenceLoad = true;
    await bridge.loadOlderEvidence("sess-1");
    expect(harness.state.evidence["sess-1"]).toMatchObject({
      status: "error",
      hasMore: true,
      nextCursor: "ev-cur-1",
    });
    expect(harness.state.error).toBe("Evidence page unavailable");

    failEvidenceLoad = false;
    await bridge.loadOlderEvidence("sess-1");
    expect(harness.state.evidence["sess-1"]?.status).toBe("ready");
    expect(harness.state.evidence["sess-1"]?.items.map((item: { id: string }) => item.id)).toEqual(["ev-2", "ev-1"]);
    expect(harness.state.evidence["sess-1"]?.nextCursor).toBeUndefined();
  });
});

describe("uploadFile host-switch guard", () => {
  it("aborts cleanly when cryptoRef switches hosts mid-upload without writing or cancelling on the new host", async () => {
    const bridge = useMobileBridge();
    const newCrypto = { encrypt: vi.fn(), identity: { roomId: "room-b" } };
    harness.refs[3]!.current.sendEnvelope = async ({ request }: { request: BridgeRequest }) => {
      harness.requests.push(request);
      const pending = harness.refs[6]!.current.get(request.requestId);
      clearTimeout(pending.timer);
      harness.refs[6]!.current.delete(request.requestId);
      if (request.method === "file.upload.open") {
        // Switch active host crypto immediately after open resolves.
        harness.refs[1]!.current = newCrypto;
        pending.resolve({
          kind: "response",
          requestId: request.requestId,
          ok: true,
          result: { upload: { uploadId: "up-host-a", chunkBytes: 4, totalChunks: 2 } },
        });
        return;
      }
      pending.resolve({ kind: "response", requestId: request.requestId, ok: true, result: {} });
    };

    const file = new File([new Uint8Array([1, 2, 3, 4, 5, 6])], "notes.txt", { type: "text/plain" });
    await expect(bridge.uploadFile("sess-1", file, () => undefined, new AbortController().signal)).rejects.toThrow("已切换电脑，上传已中断");
    expect(harness.requests.map((request) => request.method)).toEqual(["file.upload.open"]);
    expect(newCrypto.encrypt).not.toHaveBeenCalled();
  });

  it("rejects immediately if cryptoRef already changed before the first upload request", async () => {
    const bridge = useMobileBridge();
    harness.refs[1]!.current = undefined;
    const file = new File(["hello"], "hello.txt", { type: "text/plain" });
    await expect(bridge.uploadFile("sess-1", file, () => undefined, new AbortController().signal)).rejects.toThrow("已切换电脑，上传已中断");
    expect(harness.requests).toEqual([]);
    expect(harness.encrypt).not.toHaveBeenCalled();
  });

  it("normalizes transport reset rejections and cancel-phase host switches to the host-switch error", async () => {
    const bridge = useMobileBridge();
    const newCrypto = { encrypt: vi.fn(), identity: { roomId: "room-b" } };
    harness.refs[3]!.current.sendEnvelope = async ({ request }: { request: BridgeRequest }) => {
      harness.requests.push(request);
      const pending = harness.refs[6]!.current.get(request.requestId);
      clearTimeout(pending.timer);
      harness.refs[6]!.current.delete(request.requestId);
      if (request.method === "file.upload.open") {
        harness.refs[1]!.current = newCrypto;
        pending.reject(new Error("连接已重置"));
        return;
      }
    };
    const file = new File(["hello"], "reset.txt", { type: "text/plain" });
    await expect(bridge.uploadFile("sess-1", file, () => undefined, new AbortController().signal)).rejects.toThrow("已切换电脑，上传已中断");
    expect(harness.requests.map((request) => request.method)).toEqual(["file.upload.open"]);

    // Reset to host A and switch during final cleanup after commit succeeds.
    const hostACrypto = { encrypt: harness.encrypt, identity: { roomId: "room-a" } };
    harness.refs[1]!.current = hostACrypto;
    harness.requests = [];
    harness.refs[3]!.current.sendEnvelope = async ({ request }: { request: BridgeRequest }) => {
      harness.requests.push(request);
      const pending = harness.refs[6]!.current.get(request.requestId);
      clearTimeout(pending.timer);
      harness.refs[6]!.current.delete(request.requestId);
      if (request.method === "file.upload.open") {
        pending.resolve({
          kind: "response",
          requestId: request.requestId,
          ok: true,
          result: { upload: { uploadId: "up-1", chunkBytes: 64, totalChunks: 1 } },
        });
        return;
      }
      if (request.method === "file.upload.write") {
        pending.resolve({ kind: "response", requestId: request.requestId, ok: true, result: { written: 5 } });
        return;
      }
      if (request.method === "file.upload.commit") {
        const committed = {
          uploadId: "up-1",
          sessionId: "sess-1",
          name: "reset.txt",
          path: ".bridge-uploads/up-1/reset.txt",
          size: 5,
          sha256: "abc",
        };
        pending.resolve({ kind: "response", requestId: request.requestId, ok: true, result: { file: committed } });
        return;
      }
      if (request.method === "file.upload.cancel") {
        harness.refs[1]!.current = newCrypto;
        pending.reject(new Error("连接已重置"));
        return;
      }
      pending.resolve({ kind: "response", requestId: request.requestId, ok: true, result: {} });
    };
    await expect(bridge.uploadFile("sess-1", file, () => undefined, new AbortController().signal)).rejects.toThrow("已切换电脑，上传已中断");
  });
});
