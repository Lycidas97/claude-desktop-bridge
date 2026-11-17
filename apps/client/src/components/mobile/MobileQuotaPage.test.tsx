import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QuotaLoader, QuotaSnapshot } from "../../../../../plugins/magpie-quota/contract.js";
import { MagpieQuotaProvider } from "../../../../../plugins/magpie-quota/client.js";
import {
  clearInitialRefreshedQuotaHost,
  MobileQuotaPage,
  resetInitialRefreshedQuotaHostsForTest,
  shouldFallbackAutoQuotaRefresh,
} from "./MobileQuotaPage.js";

type HookStore = {
  slots: any[];
  index: number;
  dirty: boolean;
  effects: Array<{ deps: unknown[] | undefined; cleanup: (() => void) | undefined }>;
  effectIndex: number;
  pending: Array<() => void>;
};

const hooks = vi.hoisted(() => ({
  current: undefined as HookStore | undefined,
  contexts: new Map<object, unknown>(),
}));

vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return {
    ...actual,
    createContext<T>(defaultValue: T) {
      const ctx = actual.createContext(defaultValue);
      const OriginalProvider = ctx.Provider;
      (ctx as any).Provider = function MockProvider({ value, children }: { value: T; children: ReactNode }) {
        return {
          type: OriginalProvider,
          key: null,
          props: { value, children, __ctx: ctx },
        } as unknown as ReactElement;
      };
      return ctx;
    },
    useContext(ctx: any) {
      return hooks.contexts.has(ctx) ? hooks.contexts.get(ctx) : ctx._currentValue;
    },
    useState(initial: any) {
      const store = hooks.current!;
      const index = store.index++;
      if (!(index in store.slots)) store.slots[index] = typeof initial === "function" ? initial() : initial;
      return [
        store.slots[index],
        (value: any) => {
          const next = typeof value === "function" ? value(store.slots[index]) : value;
          if (!Object.is(next, store.slots[index])) store.dirty = true;
          store.slots[index] = next;
        },
      ];
    },
    useRef(initial: unknown) {
      const store = hooks.current!;
      const index = store.index++;
      store.slots[index] ??= { current: initial };
      return store.slots[index];
    },
    useCallback(fn: unknown, deps?: unknown[]) {
      const store = hooks.current!;
      const index = store.index++;
      const prev = store.slots[index] as { fn: unknown; deps: unknown[] | undefined } | undefined;
      if (prev && deps && prev.deps && deps.length === prev.deps.length && deps.every((v, i) => Object.is(v, prev.deps![i]))) {
        return prev.fn;
      }
      store.slots[index] = { fn, deps };
      return fn;
    },
    useMemo: (create: () => unknown) => create(),
    useEffect(effect: () => (() => void) | void, deps?: unknown[]) {
      const store = hooks.current!;
      const index = store.effectIndex++;
      const previous = store.effects[index];
      if (
        previous
        && deps
        && deps.length === previous.deps?.length
        && deps.every((value, i) => Object.is(value, previous.deps?.[i]))
      ) return;
      store.pending.push(() => {
        previous?.cleanup?.();
        store.effects[index] = { deps, cleanup: effect() || undefined };
      });
    },
  };
});

vi.mock("../../lib/mobile-back-navigation.js", () => ({
  registerMobileBackHandler: () => () => undefined,
}));

const availableSnapshot: QuotaSnapshot = {
  status: "available",
  fetchedAt: 1_700_000_000_000,
  accounts: [
    {
      provider: "claude",
      user: "mobile@example.test",
      name: "Claude Max",
      windows: [{ name: "5 hours", remaining: 84 }],
    },
  ],
};

function createHarness() {
  const stores = new Map<string, HookStore>();
  return {
    draw(element: ReactNode) {
      for (let pass = 0; pass < 12; pass++) {
        const visited = new Set<string>();
        const pendingEffects: Array<() => void> = [];
        for (const store of stores.values()) store.dirty = false;

        function expand(node: ReactNode, path: string): void {
          if (Array.isArray(node)) {
            node.forEach((child, index) => expand(child, `${path}/${index}`));
            return;
          }
          if (!node || typeof node !== "object" || !("props" in node)) return;
          const el = node as ReactElement<Record<string, any>>;
          if (el.props.__ctx) {
            const prevExists = hooks.contexts.has(el.props.__ctx);
            const prevVal = hooks.contexts.get(el.props.__ctx);
            hooks.contexts.set(el.props.__ctx, el.props.value);
            expand(el.props.children, `${path}/ctx`);
            if (prevExists) hooks.contexts.set(el.props.__ctx, prevVal);
            else hooks.contexts.delete(el.props.__ctx);
            return;
          }
          if (typeof el.type === "function") {
            const name = el.type.name || "Anon";
            const key = `${path}/${name}:${el.key ?? ""}`;
            visited.add(key);
            let store = stores.get(key);
            if (!store) {
              store = { slots: [], index: 0, dirty: false, effects: [], effectIndex: 0, pending: [] };
              stores.set(key, store);
            }
            hooks.current = store;
            store.index = 0;
            store.effectIndex = 0;
            const out = (el.type as (props: any) => ReactNode)(el.props);
            const ownPending = store.pending.splice(0);
            expand(out, key);
            // Child effects run before parent effects, matching React commit order.
            pendingEffects.push(...ownPending);
            return;
          }
          expand(el.props.children, `${path}/${String(el.type)}`);
        }

        expand(element, "root");
        for (const [key, store] of [...stores.entries()]) {
          if (visited.has(key)) continue;
          store.effects.forEach((effect) => effect.cleanup?.());
          stores.delete(key);
        }
        pendingEffects.forEach((run) => run());
        if (![...stores.values()].some((store) => store.dirty)) return;
      }
      throw new Error("Harness did not settle");
    },
    cleanup() {
      for (const store of stores.values()) {
        store.effects.forEach((effect) => effect.cleanup?.());
      }
      stores.clear();
    },
  };
}

async function flushAsync() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("MobileQuotaPage initial refresh", () => {
  beforeEach(() => {
    resetInitialRefreshedQuotaHostsForTest();
  });

  afterEach(() => {
    resetInitialRefreshedQuotaHostsForTest();
  });

  it("triggers an automatic refresh:true on the first mobile open for each host without needing a prior desktop refresh", async () => {
    const calls: boolean[] = [];
    const loader: QuotaLoader = vi.fn(async (options) => {
      calls.push(Boolean(options?.refresh));
      return availableSnapshot;
    });
    const onBeforeAutoRefresh = vi.fn();
    const harness = createHarness();

    const renderShell = (quotaOpen: boolean, hostId = "host-mac") => (
      <MagpieQuotaProvider loader={loader} enabled sourceKey="auto|||0">
        {quotaOpen ? (
          <MobileQuotaPage
            hostId={hostId}
            desktopName="Mac mini"
            onBeforeAutoRefresh={onBeforeAutoRefresh}
            onBack={() => undefined}
          />
        ) : null}
      </MagpieQuotaProvider>
    );

    // Closed initially: zero quota RPCs
    harness.draw(renderShell(false));
    expect(calls).toEqual([]);

    // First open for host-mac: batches consumer registration + initial refresh into refresh:true
    harness.draw(renderShell(true));
    await flushAsync();
    harness.draw(renderShell(true));
    expect(calls).toEqual([true]);
    expect(onBeforeAutoRefresh).toHaveBeenCalledTimes(1);

    // Close and re-open for the same host with available data: passive refresh:false, no redundant refresh:true
    harness.draw(renderShell(false));
    harness.draw(renderShell(true));
    await flushAsync();
    harness.draw(renderShell(true));
    expect(calls).toEqual([true, false]);
    expect(onBeforeAutoRefresh).toHaveBeenCalledTimes(1);

    // Clearing forgotten host resets initial refresh state
    clearInitialRefreshedQuotaHost("host-mac");
    harness.draw(renderShell(false));
    harness.draw(renderShell(true));
    await flushAsync();
    expect(calls).toEqual([true, false, true]);

    harness.cleanup();
  });

  it("retries refresh:true once on open when cached snapshot status is unsupported without looping", async () => {
    const calls: boolean[] = [];
    const unsupportedSnapshot: QuotaSnapshot = {
      status: "unsupported",
      fetchedAt: 1_700_000_000_000,
      accounts: [],
    };
    const loader: QuotaLoader = vi.fn(async (options) => {
      calls.push(Boolean(options?.refresh));
      return unsupportedSnapshot;
    });
    const harness = createHarness();
    const renderShell = (quotaOpen: boolean) => (
      <MagpieQuotaProvider loader={loader} enabled sourceKey="auto|||0">
        {quotaOpen ? (
          <MobileQuotaPage hostId="host-win" desktopName="Win PC" onBack={() => undefined} />
        ) : null}
      </MagpieQuotaProvider>
    );

    // First open returns unsupported (only 1 call, does not infinite-loop)
    harness.draw(renderShell(true));
    await flushAsync();
    harness.draw(renderShell(true));
    expect(calls).toEqual([true]);

    // Close and re-open while status is still unsupported: retries refresh:true once on the new open
    harness.draw(renderShell(false));
    harness.draw(renderShell(true));
    await flushAsync();
    harness.draw(renderShell(true));
    expect(calls).toEqual([true, true]);

    harness.cleanup();
  });

  it("identifies read-only / non-refreshable errors eligible for passive fallback", () => {
    expect(shouldFallbackAutoQuotaRefresh("当前 Magpie 密钥为只读，无法主动刷新")).toBe(true);
    expect(shouldFallbackAutoQuotaRefresh("该网关不支持主动刷新额度")).toBe(true);
    expect(shouldFallbackAutoQuotaRefresh("API key is read-only")).toBe(true);
    expect(shouldFallbackAutoQuotaRefresh("连接超时")).toBe(false);
  });
});
