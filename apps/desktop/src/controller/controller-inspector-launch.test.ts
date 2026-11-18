import type { BridgeInspectorStatus, DesktopControlSnapshot } from "@bridge/protocol";
import { describe, expect, it, vi } from "vitest";
import { createControllerFixture } from "./controller-fixture.js";

function createHarness(options: {
  initialAppState?: "stopped" | "running";
  initialInspector?: BridgeInspectorStatus;
  enableInspector?: () => Promise<BridgeInspectorStatus>;
  runtimeStates?: Array<"unavailable" | "ready" | "working">;
}) {
  let appState: "stopped" | "running" = options.initialAppState ?? "stopped";
  let runtimeIndex = 0;
  const states = options.runtimeStates ?? ["ready"];
  const launch = vi.fn(async (_opts?: { activate?: boolean }) => {
    appState = "running";
    return { state: appState, detail: "Claude Desktop 正在运行。", canLaunch: false, canQuit: true };
  });
  const refreshRuntime = vi.fn(async () => {
    if (runtimeIndex + 1 < states.length) runtimeIndex += 1;
    return states[runtimeIndex] !== "unavailable";
  });
  let observation = 0;
  const status = vi.fn(async (_force?: boolean): Promise<DesktopControlSnapshot["claudeDesktop"]> => ({
    state: appState,
    detail: `Observation ${++observation}`,
    canLaunch: appState === "stopped",
    canQuit: appState === "running",
  }));
  const claudeDesktop = {
    definition: { id: "claude-desktop" as const, displayName: "Claude Desktop" },
    status,
    launch,
    quit: vi.fn(async () => {
      appState = "stopped";
      return { state: appState, detail: "Claude Desktop 已退出。", canLaunch: true, canQuit: false };
    }),
  };

  const runtimeAttachSleep = vi.fn(async () => undefined);
  const broadcast = vi.fn(async () => undefined);

  const controller = createControllerFixture({
    config: {
      devices: [],
      relayEndpoints: [],
      hostDeviceId: "host-1",
      pairingEpoch: 1,
      desktopName: "Mac Studio",
      relayUrl: "ws://127.0.0.1:8787",
      launchAtLogin: false,
      managedDesktopEnabled: false,
    },
    app: { getVersion: () => "1.3.5" },
    inspectorStatus: options.initialInspector,
    runtimeAttachSleep,
    claudeDesktop,
    desktopAppControls: new Map([["claude-desktop", claudeDesktop]]),
    broker: {
      refreshRuntime,
      runtimeStatus: () => {
        const state = states[runtimeIndex]!;
        return {
          state,
          detail: state === "ready" ? "已连接" : "Claude Desktop inspector 尚未连接",
          activeTurns: 0,
          maxParallelTurns: 0,
          desktopIntegration: {
            state: state === "ready" ? "ready" as const : "disconnected" as const,
            detail: state === "ready" ? "已连接" : "Claude Desktop inspector 尚未连接",
            enabled: true,
            canRestart: false,
          },
        };
      },
      capabilities: () => ["session.list"],
      listSessions: () => [],
      listProjects: () => [],
      magpieSettings: async () => ({}),
      promptsList: () => [],
      permissionsList: () => [],
    },
    eventLog: { latestSeq: () => 0, append: vi.fn(async () => undefined) },
    broadcast,
  });

  if (options.enableInspector) {
    controller.attachInspectorEnabler(options.enableInspector);
  }
  return { controller, launch, status, refreshRuntime, broadcast, runtimeAttachSleep };
}

describe("DesktopController app status snapshots", () => {
  it("uses a single passive status read for both snapshot fields", async () => {
    const { controller, status } = createHarness({});

    const snapshot = await controller.snapshot();

    expect(status).toHaveBeenCalledExactlyOnceWith(false);
    expect(snapshot.desktopApps).toEqual([
      { id: "claude-desktop", name: "Claude Desktop", ...snapshot.claudeDesktop },
    ]);
  });

  it("returns the published app status after quit", async () => {
    const { controller, status, broadcast } = createHarness({ initialAppState: "running" });

    const result = await controller.handleRequest({
      kind: "request",
      requestId: "req-quit",
      idempotencyKey: "idem-quit",
      method: "desktop.app.quit",
      params: { runtimeId: "claude-desktop" },
    }, "mobile");

    expect(result).toEqual({ desktopApps: [expect.objectContaining({ state: "stopped" })] });
    expect(broadcast).toHaveBeenCalledWith({ kind: "snapshot", snapshot: expect.objectContaining(result) });
    expect(status).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("publishes and returns unavailable when the post-action status probe fails", async () => {
    const { controller, status, broadcast } = createHarness({ initialAppState: "running" });
    const readStatus = status.getMockImplementation()!;
    status.mockImplementation(async (force) => {
      if (force) throw new Error("Status probe failed");
      return readStatus(force);
    });

    const result = await controller.handleRequest({
      kind: "request",
      requestId: "req-quit",
      idempotencyKey: "idem-quit",
      method: "desktop.app.quit",
      params: { runtimeId: "claude-desktop" },
    }, "mobile");

    const claudeDesktop = { state: "unavailable", detail: "Status probe failed", canLaunch: false, canQuit: false };
    const desktopApps = [{ id: "claude-desktop", name: "Claude Desktop", ...claudeDesktop }];
    expect(result).toEqual({ desktopApps });
    expect(broadcast).toHaveBeenCalledWith({
      kind: "snapshot", snapshot: expect.objectContaining({ claudeDesktop, desktopApps }),
    });
  });
});

describe("DesktopController launchDesktopApp + explicit inspector enablement", () => {
  it("launches/activates Claude Desktop, enables port 9229, retries broker attach, and broadcasts ready snapshot", async () => {
    const enableInspector = vi.fn<() => Promise<BridgeInspectorStatus>>(async () => ({
      platform: "darwin",
      state: "listening",
      port: 9229,
      pollIntervalMs: 3_000,
      clients: [],
      alerts: [],
      startup: { state: "attempted", recordedAt: 100, detail: "已通过原生菜单请求开启主进程调试。" },
    }));
    const { controller, launch, status, refreshRuntime, broadcast, runtimeAttachSleep } = createHarness({
      initialInspector: {
        platform: "darwin",
        state: "closed",
        port: 9229,
        pollIntervalMs: 3_000,
        clients: [],
        alerts: [],
      },
      enableInspector,
      runtimeStates: ["unavailable", "unavailable", "ready"],
    });

    const result = await controller.handleRequest({
      kind: "request",
      requestId: "req-launch",
      idempotencyKey: "idem-launch",
      method: "desktop.app.launch",
      params: { runtimeId: "claude-desktop" },
    }, "mobile");

    const desktopApps = [expect.objectContaining({ id: "claude-desktop", state: "running", detail: "Observation 1" })];
    expect(result).toEqual({
      desktopApps,
      claudeActivation: { inspectorState: "listening", nativeReady: true },
    });
    expect(status).toHaveBeenCalledExactlyOnceWith(true);
    expect(launch).toHaveBeenCalledExactlyOnceWith({ activate: true });
    expect(enableInspector).toHaveBeenCalledOnce();
    expect(refreshRuntime).toHaveBeenCalledTimes(2);
    expect(runtimeAttachSleep).toHaveBeenCalledExactlyOnceWith(500);

    const snapshot = await controller.snapshot();
    expect(snapshot.claudeInspector).toMatchObject({ state: "listening", port: 9229 });
    expect(snapshot.runtime.desktopIntegration.state).toBe("ready");
    expect(broadcast).toHaveBeenCalledWith({
      kind: "snapshot",
      snapshot: expect.objectContaining({
        claudeInspector: expect.objectContaining({ state: "listening" }),
        desktopApps,
      }),
    });
  });

  it("returns the launch attempt's permission error even if monitoring publishes a newer status", async () => {
    const enableInspector = vi.fn<() => Promise<BridgeInspectorStatus>>(async () => ({
      platform: "darwin",
      state: "closed",
      port: 9229,
      pollIntervalMs: 3_000,
      clients: [],
      alerts: [],
      startup: {
        state: "accessibility-required",
        detail: "请在系统设置 › 隐私与安全性 › 辅助功能中添加并开启 /Applications/Bridge.app。授权后 Bridge 会自动继续。",
      },
    }));
    const { controller, refreshRuntime, runtimeAttachSleep } = createHarness({
      initialInspector: { platform: "darwin", state: "closed", port: 9229, pollIntervalMs: 3_000, clients: [], alerts: [] },
      enableInspector,
      runtimeStates: ["unavailable"],
    });

    refreshRuntime.mockImplementationOnce(async () => {
      controller.updateInspectorStatus({ platform: "darwin", state: "closed", port: 9229, pollIntervalMs: 3_000, clients: [], alerts: [] });
      return false;
    });

    await expect(controller.handleRequest({
      kind: "request",
      requestId: "req-launch-blocked",
      idempotencyKey: "idem-launch-blocked",
      method: "desktop.app.launch",
      params: { runtimeId: "claude-desktop" },
    }, "mobile")).resolves.toEqual({
      desktopApps: [expect.objectContaining({ id: "claude-desktop", state: "running" })],
      claudeActivation: { inspectorState: "closed", nativeReady: false, detail: expect.stringContaining("/Applications/Bridge.app") },
    });
    expect((await controller.snapshot()).claudeInspector?.startup).toBeUndefined();
    // Does not spin-retry broker attach when port 9229 is still closed.
    expect(refreshRuntime).toHaveBeenCalledOnce();
    expect(runtimeAttachSleep).not.toHaveBeenCalled();
  });

  it("reports a current inspector scan error instead of retained startup success", async () => {
    const inspectorStatus: BridgeInspectorStatus = {
      platform: "darwin", state: "error", port: 9229, pollIntervalMs: 3_000, clients: [], alerts: [],
      startup: { state: "already-open", detail: "首次发现时调试端口已开放。" },
      error: "扫描调试端口超时。",
    };
    const { controller } = createHarness({
      initialAppState: "running",
      initialInspector: inspectorStatus,
      enableInspector: async () => inspectorStatus,
      runtimeStates: ["unavailable"],
    });

    await expect(controller.handleRequest({
      kind: "request",
      requestId: "req-inspector-scan-error",
      idempotencyKey: "idem-inspector-scan-error",
      method: "desktop.app.launch",
      params: { runtimeId: "claude-desktop" },
    }, "mobile")).resolves.toMatchObject({
      claudeActivation: { inspectorState: "error", nativeReady: false, detail: "扫描调试端口超时。" },
    });
  });

  it("skips menu automation when port 9229 is already listening", async () => {
    const enableInspector = vi.fn<() => Promise<BridgeInspectorStatus>>();
    const { controller, launch } = createHarness({
      initialInspector: { platform: "win32", state: "listening", port: 9229, pollIntervalMs: 3_000, clients: [], alerts: [] },
      enableInspector,
      runtimeStates: ["ready"],
    });

    await controller.launchClaudeDesktop();
    expect(launch).toHaveBeenCalledExactlyOnceWith();
    expect(enableInspector).not.toHaveBeenCalled();
  });

  it("exposes canLaunch: true when Claude Desktop is already running with port 9229 closed so UI buttons can trigger explicit enablement", async () => {
    const enableInspector = vi.fn<() => Promise<BridgeInspectorStatus>>(async () => ({
      platform: "darwin",
      state: "listening",
      port: 9229,
      pollIntervalMs: 3_000,
      clients: [],
      alerts: [],
      startup: { state: "attempted", recordedAt: 200, detail: "已通过原生菜单请求开启主进程调试。" },
    }));
    const { controller, launch, status } = createHarness({
      initialAppState: "running",
      initialInspector: { platform: "darwin", state: "closed", port: 9229, pollIntervalMs: 3_000, clients: [], alerts: [] },
      enableInspector,
      runtimeStates: ["unavailable", "ready"],
    });

    const before = await controller.snapshot();
    expect(before.claudeDesktop).toMatchObject({ state: "running", canLaunch: true, canQuit: true });
    expect(before.desktopApps?.[0]).toMatchObject({ id: "claude-desktop", state: "running", canLaunch: true, canQuit: true });
    status.mockClear();
    await expect(controller.handleRequest({
      kind: "request",
      requestId: "status-1",
      idempotencyKey: "status-1",
      method: "claude.desktop.status",
      params: {},
    }, "mobile")).resolves.toEqual({
      claudeDesktop: expect.objectContaining({ state: "running", canLaunch: true }),
    });
    await expect(controller.handleRequest({
      kind: "request",
      requestId: "status-2",
      idempotencyKey: "status-2",
      method: "desktop.app.status",
      params: {},
    }, "mobile")).resolves.toEqual({
      desktopApps: [expect.objectContaining({ id: "claude-desktop", state: "running", canLaunch: true })],
    });

    expect(status.mock.calls).toEqual([[true], [true]]);

    const after = await controller.launchDesktopApp("claude-desktop");
    expect(launch).toHaveBeenCalledExactlyOnceWith({ activate: true });
    expect(enableInspector).toHaveBeenCalledOnce();
    expect(after.claudeInspector?.state).toBe("listening");
    expect(after.claudeDesktop).toMatchObject({ state: "running", canLaunch: false, canQuit: true });
    expect(after.desktopApps?.[0]).toMatchObject({ id: "claude-desktop", state: "running", canLaunch: false, canQuit: true });
  });
});
