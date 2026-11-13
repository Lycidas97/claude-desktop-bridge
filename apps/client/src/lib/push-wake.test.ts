import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  platform: "android",
  listeners: new Map<string, (event: { value: string }) => void>(),
  plugin: {
    addListener: vi.fn(),
    checkPermissions: vi.fn(),
    requestPermissions: vi.fn(),
    register: vi.fn(),
  },
}));
vi.mock("@capacitor/core", () => ({ Capacitor: { getPlatform: () => native.platform } }));
vi.mock("@capacitor/push-notifications", () => ({ PushNotifications: native.plugin }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv("VITE_BRIDGE_PUSH_ENABLED", "true");
  native.platform = "android";
  native.listeners.clear();
  native.plugin.addListener.mockImplementation((event, listener) => {
    native.listeners.set(event, listener);
    return Promise.resolve({ remove: vi.fn() });
  });
  native.plugin.checkPermissions.mockResolvedValue({ receive: "prompt" });
  native.plugin.requestPermissions.mockResolvedValue({ receive: "granted" });
  native.plugin.register.mockImplementation(() => native.listeners.get("registration")!({ value: "device-push-token" }));
});
afterEach(() => vi.unstubAllEnvs());

describe("native push wake", () => {
  it.each(["ios", "web"])("does not register tokens or install native listeners on %s", async (platform) => {
    native.platform = platform;
    const push = await import("./push-wake.js");
    const remove = push.onNativePushWake(vi.fn());
    expect(await push.nativePushRegistration()).toBeUndefined();
    expect(native.plugin.addListener).not.toHaveBeenCalled();
    expect(native.plugin.checkPermissions).not.toHaveBeenCalled();
    expect(native.plugin.register).not.toHaveBeenCalled();
    remove();
  });

  it("registers Android once and delivers received and tapped wake events", async () => {
    const push = await import("./push-wake.js");
    expect(await push.nativePushRegistration()).toEqual({ platform: "android", token: "device-push-token" });
    expect(await push.nativePushRegistration()).toEqual({ platform: "android", token: "device-push-token" });
    expect(native.plugin.register).toHaveBeenCalledOnce();
    expect(native.plugin.requestPermissions).toHaveBeenCalledOnce();
    const wake = vi.fn();
    const remove = push.onNativePushWake(wake);
    native.listeners.get("pushNotificationReceived")!({ value: "" });
    native.listeners.get("pushNotificationActionPerformed")!({ value: "" });
    expect(wake).toHaveBeenCalledTimes(2);
    remove();
    native.listeners.get("pushNotificationReceived")!({ value: "" });
    expect(wake).toHaveBeenCalledTimes(2);
  });
});
