import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeInspectorMonitor, parseInspectorSockets } from "./claude-inspector-monitor.js";

const client = { pid: 42, name: "node", executablePath: "/opt/homebrew/bin/node", approved: false };
afterEach(() => vi.useRealTimers());

describe("inspector socket parsing", () => {
  it("excludes the server end, listener and unrelated ports, and deduplicates client sockets", () => {
    expect(parseInspectorSockets([
      "p10", "cClaude", "f47", "n127.0.0.1:9229", "TST=LISTEN",
      "f48", "n127.0.0.1:9229->127.0.0.1:55001", "TST=ESTABLISHED",
      "p42", "cnode", "f4", "n127.0.0.1:55001->127.0.0.1:9229", "TST=ESTABLISHED",
      "f5", "n[::1]:55002->[::1]:9229", "TST=ESTABLISHED",
      "p77", "cother", "f3", "n127.0.0.1:55003->127.0.0.1:9230", "TST=ESTABLISHED",
    ].join("\n"))).toEqual({ listening: true, clients: [{ pid: 42, name: "node" }] });
  });
  it("does not treat a connecting or closing socket as an established client", () => {
    expect(parseInspectorSockets("p42\ncnode\nf4\nn127.0.0.1:55001->127.0.0.1:9229\nTST=SYN_SENT\n")).toEqual({ listening: false, clients: [] });
  });
});

describe("background inspector monitor", () => {
  it("alerts once per continuous unknown process and alerts again after disconnection", async () => {
    vi.useFakeTimers();
    const scan = vi.fn().mockResolvedValue({ listening: true, clients: [client] });
    const onAlert = vi.fn(() => undefined);
    const onUpdate = vi.fn();
    const monitor = new ClaudeInspectorMonitor({ scan, onAlert, onUpdate, platform: "darwin" });
    try {
      await monitor.start();
      expect(onAlert).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(9_000);
      expect(scan).toHaveBeenCalledTimes(4);
      expect(onAlert).toHaveBeenCalledOnce();
      expect(onUpdate).toHaveBeenCalledOnce();
      scan.mockResolvedValueOnce({ listening: true, clients: [] });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(onUpdate.mock.lastCall?.[0]).toMatchObject({ clients: [], alerts: [client] });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(onAlert).toHaveBeenCalledTimes(2);
      expect(onUpdate.mock.lastCall?.[0].alerts).toHaveLength(2);
    } finally { monitor.close(); }
  });

  it("shows approved clients without alerting and warns when a path cannot be identified", async () => {
    const onAlert = vi.fn(() => undefined);
    const onUpdate = vi.fn();
    const clients = [{ ...client, approved: true }, { pid: 99, name: "unknown", pathError: "permission denied", approved: false }];
    const monitor = new ClaudeInspectorMonitor({ scan: async () => ({ listening: true, clients }), onAlert, onUpdate, platform: "darwin" });
    try {
      await monitor.start();
      expect(onAlert).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ pid: 99, pathError: "permission denied" }));
      expect(onUpdate.mock.lastCall?.[0].clients).toEqual(clients);
    } finally { monitor.close(); }
  });

  it("retains an explicit failure and recovers on the next scan", async () => {
    vi.useFakeTimers();
    const onUpdate = vi.fn();
    const scan = vi.fn().mockRejectedValueOnce(new Error("lsof denied")).mockResolvedValue({ listening: false, clients: [] });
    const monitor = new ClaudeInspectorMonitor({ scan, onAlert: () => undefined, onUpdate, platform: "darwin" });
    try {
      await monitor.start();
      expect(onUpdate.mock.lastCall?.[0]).toMatchObject({ state: "error", error: "lsof denied" });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(onUpdate.mock.lastCall?.[0]).toMatchObject({ state: "closed" });
      expect(onUpdate.mock.lastCall?.[0].error).toBeUndefined();
    } finally { monitor.close(); }
  });

  it("keeps notification delivery failures visible", async () => {
    const onUpdate = vi.fn();
    const monitor = new ClaudeInspectorMonitor({ scan: async () => ({ listening: true, clients: [client] }), onAlert: () => "notifications unavailable", onUpdate, platform: "darwin" });
    try {
      await monitor.start();
      expect(onUpdate.mock.lastCall?.[0].notificationError).toBe("notifications unavailable");
      monitor.notificationFailed("notification rejected");
      expect(onUpdate.mock.lastCall?.[0].notificationError).toBe("notification rejected");
    } finally { monitor.close(); }
  });

  it("stops polling when the background service closes, including a pending scan", async () => {
    vi.useFakeTimers();
    let finish!: (result: { listening: boolean; clients: typeof client[] }) => void;
    const scan = vi.fn(() => new Promise<{ listening: boolean; clients: typeof client[] }>((resolve) => { finish = resolve; }));
    const onAlert = vi.fn(() => undefined);
    const onUpdate = vi.fn();
    const monitor = new ClaudeInspectorMonitor({ scan, onAlert, onUpdate, platform: "darwin" });
    const started = monitor.start();
    monitor.close();
    finish({ listening: true, clients: [client] });
    await started;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(scan).toHaveBeenCalledOnce();
    expect(onAlert).not.toHaveBeenCalled();
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("publishes persistent startup errors alongside socket and client alerts", async () => {
    vi.useFakeTimers();
    const onUpdate = vi.fn();
    const onAlert = vi.fn(() => undefined);
    const startup = vi.fn(async () => "本进程自动开启失败：辅助功能权限不足");
    const monitor = new ClaudeInspectorMonitor({
      scan: async () => ({ listening: false, clients: [client] }), startup, onAlert, onUpdate, platform: "darwin",
    });
    try {
      await monitor.start();
      await vi.advanceTimersByTimeAsync(6_000);
      expect(startup).toHaveBeenCalledTimes(3);
      expect(onUpdate.mock.lastCall?.[0]).toMatchObject({ state: "closed", error: "本进程自动开启失败：辅助功能权限不足" });
      expect(onAlert).toHaveBeenCalledOnce();
    } finally { monitor.close(); }
  });

  it("does not run macOS tools on other platforms", async () => {
    const scan = vi.fn();
    const onUpdate = vi.fn();
    const monitor = new ClaudeInspectorMonitor({ scan, onAlert: () => undefined, onUpdate, platform: "win32" });
    await monitor.start();
    expect(scan).not.toHaveBeenCalled();
    expect(onUpdate.mock.lastCall?.[0].state).toBe("unsupported");
    monitor.close();
  });
});
