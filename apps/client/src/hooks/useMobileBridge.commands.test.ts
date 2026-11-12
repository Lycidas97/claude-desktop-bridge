import type { BridgeProjectInfo, BridgeRequest, BridgeSessionInfo, BridgeSlashCommandCatalog } from "@bridge/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMobileBridge } from "./useMobileBridge.js";

const harness = vi.hoisted(() => ({
  refs: [] as Array<{ current: any }>,
  requests: [] as BridgeRequest[],
  response: {} as Record<string, unknown>,
  error: undefined as { code: string; message: string } | undefined,
  encrypt: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => [initial, vi.fn()],
  useRef(initial: unknown) {
    const index = harness.refs.length;
    const ref = { current: initial as any };
    if (index === 1) ref.current = { encrypt: harness.encrypt };
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

