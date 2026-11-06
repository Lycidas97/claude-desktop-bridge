import { beforeEach, expect, it, vi } from "vitest";
import { MagpieQuotaBoard, MagpieQuotaProvider } from "./client.js";
import type { QuotaSnapshot } from "./contract.js";

const hooks = vi.hoisted(() => ({ slots: [] as any[], index: 0, effects: [] as any[], effectIndex: 0, pending: [] as Array<() => void> }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState(initial: any) {
    const index = hooks.index++;
    if (!(index in hooks.slots)) hooks.slots[index] = typeof initial === "function" ? initial() : initial;
    return [hooks.slots[index], (value: any) => { hooks.slots[index] = typeof value === "function" ? value(hooks.slots[index]) : value; }];
  },
  useRef(initial: any) { const index = hooks.index++; return hooks.slots[index] ??= { current: initial }; },
  useCallback: (callback: any) => callback,
  useEffect(effect: () => (() => void) | void, deps: unknown[]) {
    const index = hooks.effectIndex++, old = hooks.effects[index];
    if (old && deps.every((value, i) => Object.is(value, old.deps[i]))) return;
    hooks.pending.push(() => { old?.cleanup?.(); hooks.effects[index] = { deps, cleanup: effect() }; });
  },
}));
beforeEach(() => { hooks.slots = []; hooks.effects = []; hooks.pending = []; });

it("keeps reads lazy and never presents a previous gateway's quota after configuration changes", async () => {
  let finish!: (snapshot: QuotaSnapshot) => void;
  const first: QuotaSnapshot = { status: "available", fetchedAt: 1, accounts: [{ provider: "first-gateway", windows: [] }] };
  const loader = vi.fn().mockResolvedValueOnce(first).mockImplementationOnce(() => new Promise<QuotaSnapshot>((resolve) => { finish = resolve; }));
  let sourceKey = "gateway-A";
  const draw = () => {
    hooks.index = 0; hooks.effectIndex = 0;
    const tree = MagpieQuotaProvider({ loader, sourceKey, children: null } as Parameters<typeof MagpieQuotaProvider>[0]);
    hooks.pending.splice(0).forEach((effect) => effect());
    return tree.props.value as any;
  };
  const stop = draw().request();
  expect(loader).not.toHaveBeenCalled();
  draw();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  expect(draw().snapshot).toEqual(first);
  sourceKey = "gateway-B";
  expect(draw().snapshot).toBeUndefined();
  expect(loader).toHaveBeenCalledTimes(2);
  finish({ status: "unsupported", fetchedAt: 2, accounts: [] });
  for (let i = 0; i < 8; i++) await Promise.resolve();
  expect(draw().snapshot.status).toBe("unsupported");
  stop(); draw();
  sourceKey = "gateway-C"; draw();
  expect(loader).toHaveBeenCalledTimes(2);
  hooks.effects.forEach((effect) => effect.cleanup?.());
});

it.each(["disconnect", "consumer leaves", "loader changes", "source changes"])(
  "consumes a manual refresh when it starts, even if %s while it is pending",
  async (interruption) => {
    const previous: QuotaSnapshot = { status: "available", fetchedAt: 1, accounts: [{ provider: "gateway-A", windows: [] }] };
    const resumed: QuotaSnapshot = { status: "available", fetchedAt: 2, accounts: [{ provider: "resumed", windows: [] }] };
    const abandoned: QuotaSnapshot = { status: "available", fetchedAt: 3, accounts: [{ provider: "abandoned", windows: [] }] };
    let finishRefresh!: (snapshot: QuotaSnapshot) => void;
    let loader = vi.fn().mockResolvedValue(resumed)
      .mockResolvedValueOnce(previous)
      .mockImplementationOnce(() => new Promise<QuotaSnapshot>((resolve) => { finishRefresh = resolve; }));
    let enabled = true;
    let sourceKey = "gateway-A";
    const draw = () => {
      hooks.index = 0; hooks.effectIndex = 0;
      const tree = MagpieQuotaProvider({ loader, enabled, sourceKey, children: null });
      hooks.pending.splice(0).forEach((effect) => effect());
      return tree.props.value;
    };
    let stop = draw().request();
    expect(loader).not.toHaveBeenCalled();
    draw();
    expect(loader).toHaveBeenLastCalledWith({ refresh: false });
    for (let i = 0; i < 8; i++) await Promise.resolve();
    let state = draw();
    expect(state.snapshot).toEqual(previous);
    const button = MagpieQuotaBoard(state).props.children[0].props.children[0].props.children[1];
    expect(button.props.disabled).toBe(false);
    button.props.onClick();
    state = draw();
    expect(state.snapshot).toEqual(previous);
    expect(state.loading).toBe(true);
    expect(MagpieQuotaBoard(state).props.children[0].props.children[0].props.children[1].props.disabled).toBe(true);
    expect(loader).toHaveBeenCalledTimes(2);
    expect(loader).toHaveBeenLastCalledWith({ refresh: true });

    switch (interruption) {
      case "disconnect":
        enabled = false; draw();
        enabled = true;
        break;
      case "consumer leaves":
        stop(); draw();
        stop = draw().request();
        break;
      case "loader changes":
        loader = vi.fn().mockResolvedValue(resumed);
        break;
      case "source changes":
        sourceKey = "gateway-B";
        break;
    }
    state = draw();
    expect(state.snapshot).toEqual(interruption === "source changes" ? undefined : previous);
    expect(loader).toHaveBeenLastCalledWith({ refresh: false });
    finishRefresh(abandoned);
    for (let i = 0; i < 8; i++) await Promise.resolve();
    state = draw();
    expect(state.snapshot).toEqual(resumed);
    expect(state.loading).toBe(false);
    MagpieQuotaBoard(state).props.children[0].props.children[0].props.children[1].props.onClick();
    draw();
    expect(loader).toHaveBeenLastCalledWith({ refresh: true });
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(draw().loading).toBe(false);
    stop(); draw();
    hooks.effects.forEach((effect) => effect.cleanup?.());
  },
);
