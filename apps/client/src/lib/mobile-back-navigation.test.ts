import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  enabled: false,
  app: { addListener: vi.fn(), minimizeApp: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("@capacitor/app", () => ({ App: native.app }));
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => native.enabled, getPlatform: () => "android" } }));
beforeEach(() => {
  native.enabled = false; vi.clearAllMocks();
  native.app.addListener.mockResolvedValue({ remove: vi.fn() });
  vi.stubGlobal("document", { removeEventListener: vi.fn() });
});
afterEach(() => vi.unstubAllGlobals());
import {
  dispatchMobileBack,
  isEdgeBackGesture,
  installMobileBackNavigation,
  registerMobileBackHandler,
} from "./mobile-back-navigation.js";

describe("Android system back", () => {
  it("moves the task to the background only after the session layer has returned to its list", async () => {
    native.enabled = true;
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
    native.enabled = true;
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

  it("recognizes only a quick horizontal swipe beginning at the left edge", () => {
    const start = { x: 10, y: 120, at: 1_000 };

    expect(isEdgeBackGesture(start, { x: 100, y: 126, at: 1_400 })).toBe(true);
    expect(isEdgeBackGesture({ ...start, x: 40 }, { x: 130, y: 126, at: 1_400 })).toBe(false);
    expect(isEdgeBackGesture(start, { x: 90, y: 220, at: 1_400 })).toBe(false);
    expect(isEdgeBackGesture(start, { x: 100, y: 126, at: 2_000 })).toBe(false);
  });
});
