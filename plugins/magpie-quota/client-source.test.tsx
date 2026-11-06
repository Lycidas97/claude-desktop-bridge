import { beforeEach, expect, it, vi } from "vitest";
import { MagpieQuotaProvider } from "./client.js";
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
