import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Capacitor, SystemBars } from "@capacitor/core";
import { useTheme } from "./useTheme.js";

const hooks = vi.hoisted(() => ({ states: [] as any[], index: 0, effects: [] as Array<() => void> }));
vi.mock("react", () => ({
  useState(initial: any) {
    const index = hooks.index++;
    if (!(index in hooks.states)) hooks.states[index] = typeof initial === "function" ? initial() : initial;
    return [hooks.states[index], (next: any) => { hooks.states[index] = typeof next === "function" ? next(hooks.states[index]) : next; }];
  },
  useEffect(effect: () => void) { hooks.effects.push(effect); },
  useCallback: (callback: unknown) => callback,
}));
vi.mock("@capacitor/core", () => ({
  Capacitor: { getPlatform: vi.fn(() => "android") },
  SystemBars: { setStyle: vi.fn(async () => undefined) },
  SystemBarsStyle: { Dark: "DARK", Light: "LIGHT" },
}));

let stored: Map<string, string>;
let root: { dataset: Record<string, string> };
let meta: ReturnType<typeof vi.fn>;
function draw() {
  hooks.index = 0;
  const control = useTheme();
  hooks.effects.splice(0).forEach(effect => effect());
  return control;
}

beforeEach(() => {
  hooks.states = []; hooks.index = 0; hooks.effects = [];
  vi.clearAllMocks();
  vi.mocked(Capacitor.getPlatform).mockReturnValue("android");
  stored = new Map(); root = { dataset: {} }; meta = vi.fn();
  vi.stubGlobal("localStorage", { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) });
  vi.stubGlobal("document", { documentElement: root, querySelector: () => ({ setAttribute: meta }) });
});
afterEach(() => vi.unstubAllGlobals());

describe("native system bars follow the app theme", () => {
  it.each(["sunstone", "apple"] as const)("restores the saved %s theme and changes dark to light and back", family => {
    stored.set("bridge-theme-family", family);
    stored.set("bridge-theme", "dark");
    let control = draw();
    expect(SystemBars.setStyle).toHaveBeenLastCalledWith({ style: "DARK" });
    expect(root.dataset).toEqual({ theme: "dark", themeFamily: family });
    expect(meta).toHaveBeenLastCalledWith("content", "#000000");
    control.setTheme("light"); control = draw();
    expect(SystemBars.setStyle).toHaveBeenLastCalledWith({ style: "LIGHT" });
    expect(meta).toHaveBeenLastCalledWith("content", family === "apple" ? "#f2f2f7" : "#f6f4f0");
    expect(stored.get("bridge-theme")).toBe("light");
    control.toggleTheme(); draw();
    expect(SystemBars.setStyle).toHaveBeenLastCalledWith({ style: "DARK" });
  });

  it("initializes a saved light theme and follows palette changes", () => {
    stored.set("bridge-theme", "light");
    const control = draw();
    expect(SystemBars.setStyle).toHaveBeenLastCalledWith({ style: "LIGHT" });
    control.setFamily("apple"); draw();
    expect(root.dataset).toEqual({ theme: "light", themeFamily: "apple" });
    expect(meta).toHaveBeenLastCalledWith("content", "#f2f2f7");
    expect(SystemBars.setStyle).toHaveBeenLastCalledWith({ style: "LIGHT" });
  });

  it("keeps updating browser theme colors without calling an Android plugin", () => {
    vi.mocked(Capacitor.getPlatform).mockReturnValue("web");
    const control = draw();
    control.setTheme("light"); draw();
    expect(SystemBars.setStyle).not.toHaveBeenCalled();
    expect(root.dataset.theme).toBe("light");
    expect(meta).toHaveBeenLastCalledWith("content", "#f6f4f0");
  });
});
