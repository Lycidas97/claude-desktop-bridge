import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  enabled: true,
  plugin: {
    checkPermissions: vi.fn(),
    requestPermissions: vi.fn(),
    createChannel: vi.fn(),
    schedule: vi.fn(),
    addListener: vi.fn(),
  },
}));
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => native.enabled, getPlatform: () => "android" } }));
vi.mock("@capacitor/local-notifications", () => ({ LocalNotifications: native.plugin }));

async function load() {
  vi.resetModules();
  return import("./session-notifications.js");
}

afterEach(() => vi.unstubAllGlobals());

beforeEach(() => {
  vi.stubGlobal("document", { visibilityState: "visible" });
  vi.clearAllMocks();
  native.enabled = true;
  native.plugin.checkPermissions.mockResolvedValue({ display: "prompt" });
  native.plugin.requestPermissions.mockResolvedValue({ display: "granted" });
  native.plugin.createChannel.mockResolvedValue(undefined);
  native.plugin.schedule.mockResolvedValue({ notifications: [] });
});

describe("session notifications", () => {
  it("does nothing outside the native app", async () => {
    native.enabled = false;
    const notifications = await load();
    await notifications.showSessionNotification({ hostId: "room", sessionId: "s1" }, "Title", "Body");
    notifications.onSessionNotificationTap(vi.fn())();
    expect(native.plugin.checkPermissions).not.toHaveBeenCalled();
    expect(native.plugin.schedule).not.toHaveBeenCalled();
    expect(native.plugin.addListener).not.toHaveBeenCalled();
  });

  it("asks once, then keeps one notification per session carrying its target", async () => {
    const notifications = await load();
    await notifications.showSessionNotification({ hostId: "room", sessionId: "s1" }, "Fix tests", "任务已完成");
    await notifications.showSessionNotification({ hostId: "room", sessionId: "s1" }, "Fix tests", "任务失败");
    await notifications.showSessionNotification({ hostId: "room", sessionId: "s2" }, "Docs", "任务已完成");

    expect(native.plugin.requestPermissions).toHaveBeenCalledTimes(1);
    expect(native.plugin.createChannel).toHaveBeenCalledTimes(1);
    const [first, second, third] = native.plugin.schedule.mock.calls.map(([options]) => options.notifications[0]);
    expect(first).toMatchObject({
      title: "Fix tests",
      body: "任务已完成",
      channelId: "bridge-sessions",
      isExactNotification: false,
      autoCancel: true,
      extra: { hostId: "room", sessionId: "s1" },
    });
    expect(Number.isInteger(first.id) && first.id >= 0).toBe(true);
    expect(second.id).toBe(first.id);
    expect(third.id).not.toBe(first.id);
  });

  it("stays silent when the user denies the permission", async () => {
    native.plugin.requestPermissions.mockResolvedValue({ display: "denied" });
    const notifications = await load();
    await notifications.showSessionNotification({ hostId: "room", sessionId: "s1" }, "Title", "Body");
    expect(native.plugin.createChannel).not.toHaveBeenCalled();
    expect(native.plugin.schedule).not.toHaveBeenCalled();
  });

  it("recognizes a permission granted in Settings after an earlier denial", async () => {
    native.plugin.checkPermissions.mockResolvedValue({ display: "denied" });
    const notifications = await load();
    await notifications.showSessionNotification({ hostId: "room", sessionId: "s1" }, "Task", "任务已完成");
    expect(native.plugin.schedule).not.toHaveBeenCalled();
    native.plugin.checkPermissions.mockResolvedValue({ display: "granted" });
    await notifications.showSessionNotification({ hostId: "room", sessionId: "s1" }, "Task", "任务已完成");
    expect(native.plugin.schedule).toHaveBeenCalledOnce();
    expect(native.plugin.requestPermissions).not.toHaveBeenCalled();
  });

  it("waits until the foreground to request permission after a background completion", async () => {
    vi.stubGlobal("document", { visibilityState: "hidden" });
    const notifications = await load();
    await notifications.showSessionNotification({ hostId: "room", sessionId: "s1" }, "Task", "任务已完成");
    expect(native.plugin.requestPermissions).not.toHaveBeenCalled();
    expect(native.plugin.schedule).not.toHaveBeenCalled();
    vi.stubGlobal("document", { visibilityState: "visible" });
    expect(await notifications.ensureSessionNotificationPermission()).toBe(true);
    expect(native.plugin.requestPermissions).toHaveBeenCalledOnce();
  });

  it("hands the tapped notification's target to the listener", async () => {
    const remove = vi.fn();
    native.plugin.addListener.mockResolvedValue({ remove });
    const notifications = await load();
    const listener = vi.fn();
    const unsubscribe = notifications.onSessionNotificationTap(listener);
    const handler = native.plugin.addListener.mock.calls[0]![1];
    handler({ actionId: "tap", notification: { extra: { hostId: "room", sessionId: "s1" } } });
    expect(listener).toHaveBeenCalledWith({ hostId: "room", sessionId: "s1" });
    unsubscribe();
    await vi.waitFor(() => expect(remove).toHaveBeenCalled());
  });
});
