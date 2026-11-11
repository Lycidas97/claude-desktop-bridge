import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Capacitor, SystemBars } from "@capacitor/core";
import { useTheme } from "./useTheme.js";

const hooks = vi.hoisted(() => ({ states: [] as any[], index: 0, effects: [] as Array<() => void>, effectIndex: 0, effectDeps: [] as Array<unknown[] | undefined> }));
vi.mock("react", () => ({
  useState(initial: any) {
    const index = hooks.index++;
    if (!(index in hooks.states)) hooks.states[index] = typeof initial === "function" ? initial() : initial;
    return [hooks.states[index], (next: any) => { hooks.states[index] = typeof next === "function" ? next(hooks.states[index]) : next; }];
  },
  useEffect(effect: () => void, deps?: unknown[]) {
    const index = hooks.effectIndex++;
    const previous = hooks.effectDeps[index];
    if (deps && previous && deps.every((value, i) => Object.is(value, previous[i]))) return;
    hooks.effectDeps[index] = deps;
    hooks.effects.push(effect);
  },
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
  hooks.effectIndex = 0;
  const control = useTheme();
  hooks.effects.splice(0).forEach(effect => effect());
  return control;
}

beforeEach(() => {
  hooks.states = []; hooks.index = 0; hooks.effects = []; hooks.effectIndex = 0; hooks.effectDeps = [];
  vi.clearAllMocks();
  vi.mocked(Capacitor.getPlatform).mockReturnValue("android");
  stored = new Map(); root = { dataset: {} }; meta = vi.fn();
  vi.stubGlobal("localStorage", { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) });
  vi.stubGlobal("document", { documentElement: root, querySelector: () => ({ setAttribute: meta }) });
});
afterEach(() => vi.unstubAllGlobals());

describe("local font size preference", () => {
  it("uses the existing appearance by default", () => {
    expect(draw().fontSize).toBe("standard");
    expect(root.dataset.fontSize).toBe("standard");
    expect(stored.get("bridge-font-size")).toBe("standard");
  });

  it.each(["small", "standard", "large", "larger"] as const)("applies %s and restores it without opening settings", size => {
    let control = draw();
    control.setFontSize(size);
    control = draw();
    expect(control.fontSize).toBe(size);
    expect(root.dataset.fontSize).toBe(size);
    expect(stored.get("bridge-font-size")).toBe(size);
    expect(SystemBars.setStyle).toHaveBeenCalledTimes(1);
    hooks.states = []; hooks.effectDeps = []; root.dataset = {};
    expect(draw().fontSize).toBe(size);
    expect(root.dataset.fontSize).toBe(size);
  });

  it.each(["huge", "1.3", "", "LARGE"])("falls back for unsupported storage value %j", storedValue => {
    stored.set("bridge-font-size", storedValue);
    expect(draw().fontSize).toBe("standard");
    expect(root.dataset.fontSize).toBe("standard");
    expect(stored.get("bridge-font-size")).toBe("standard");
  });

  it("keeps font size when theme and family change", () => {
    const control = draw();
    control.setFontSize("larger"); draw();
    control.setTheme("light"); control.setFamily("apple"); draw();
    expect(root.dataset).toEqual({ theme: "light", themeFamily: "apple", fontSize: "larger" });
    expect(stored.get("bridge-font-size")).toBe("larger");
  });
});

describe("native system bars follow the app theme", () => {
  it.each(["sunstone", "apple"] as const)("restores the saved %s theme and changes dark to light and back", family => {
    stored.set("bridge-theme-family", family);
    stored.set("bridge-theme", "dark");
    let control = draw();
    expect(SystemBars.setStyle).toHaveBeenLastCalledWith({ style: "DARK" });
    expect(root.dataset).toEqual({ theme: "dark", themeFamily: family, fontSize: "standard" });
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
    expect(root.dataset).toEqual({ theme: "light", themeFamily: "apple", fontSize: "standard" });
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
