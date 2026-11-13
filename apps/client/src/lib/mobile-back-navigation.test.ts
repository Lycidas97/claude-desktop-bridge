import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  app: { addListener: vi.fn(), minimizeApp: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("@capacitor/app", () => ({ App: native.app }));
vi.mock("@capacitor/core", () => ({ Capacitor: { getPlatform: () => "android" } }));
beforeEach(() => {
  vi.clearAllMocks();
  native.app.addListener.mockResolvedValue({ remove: vi.fn() });
});
import {
  dispatchMobileBack,
  installMobileBackNavigation,
  registerMobileBackHandler,
} from "./mobile-back-navigation.js";

describe("Android system back", () => {
  it("moves the task to the background only after the session layer has returned to its list", async () => {
    let conversationOpen = true;
    const remove = registerMobileBackHandler(() => {
      if (!conversationOpen) return false;
      conversationOpen = false; return true;
    }, 100);
    const dispose = installMobileBackNavigation();
    await Promise.resolve();
    const back = native.app.addListener.mock.calls[0]![1] as () => void;
    back();
    expect(conversationOpen).toBe(false);
    expect(native.app.minimizeApp).not.toHaveBeenCalled();
    back();
    expect(native.app.minimizeApp).toHaveBeenCalledOnce();
    remove(); dispose();
  });
  it("leaves the current page in front while an overlay consumes back", async () => {
    const remove = registerMobileBackHandler(() => true, 300);
    const dispose = installMobileBackNavigation(); await Promise.resolve();
    (native.app.addListener.mock.calls[0]![1] as () => void)();
    expect(native.app.minimizeApp).not.toHaveBeenCalled();
    remove(); dispose();
  });
});

describe("mobile back navigation", () => {
  it("offers back navigation to the highest layer before the app root", () => {
    const calls: string[] = [];
    const removeRoot = registerMobileBackHandler(() => {
      calls.push("root");
      return true;
    }, -100);
    const removeWorkspace = registerMobileBackHandler(() => {
      calls.push("workspace");
      return false;
    }, 100);

    expect(dispatchMobileBack()).toBe(true);
    expect(calls).toEqual(["workspace", "root"]);

    removeWorkspace();
    removeRoot();
  });

  it("stops after the topmost layer handles the gesture", () => {
    const calls: string[] = [];
    const removeRoot = registerMobileBackHandler(() => {
      calls.push("root");
      return true;
    }, -100);
    const removeDialog = registerMobileBackHandler(() => {
      calls.push("dialog");
      return true;
    }, 100);

    expect(dispatchMobileBack()).toBe(true);
    expect(calls).toEqual(["dialog"]);

    removeDialog();
    removeRoot();
  });
});
