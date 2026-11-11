import type { DesktopControlSnapshot } from "@bridge/protocol";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { DesktopSettings } from "./DesktopSettings.js";

const hooks = vi.hoisted(() => ({ slots: [] as any[], index: 0, dirty: false, effects: [] as unknown[][], effectIndex: 0, pending: [] as Array<() => void> }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState(initial: any) {
    const index = hooks.index++;
    if (!(index in hooks.slots)) hooks.slots[index] = typeof initial === "function" ? initial() : initial;
    return [hooks.slots[index], (value: any) => {
      const next = typeof value === "function" ? value(hooks.slots[index]) : value;
      if (!Object.is(next, hooks.slots[index])) hooks.dirty = true;
      hooks.slots[index] = next;
    }];
  },
  useEffect(effect: () => void, deps: unknown[]) {
    const index = hooks.effectIndex++;
    if (hooks.effects[index]?.every((value, i) => Object.is(value, deps[i]))) return;
    hooks.pending.push(() => { hooks.effects[index] = deps; effect(); });
  },
}));
let props: ComponentProps<typeof DesktopSettings>;
let tree: ReactNode;
function draw() {
  for (let i = 0; i < 12; i++) {
    hooks.index = 0; hooks.effectIndex = 0; hooks.dirty = false;
    tree = DesktopSettings(props);
    hooks.pending.splice(0).forEach(effect => effect());
    if (!hooks.dirty) return;
  }
  throw new Error("Settings did not settle");
}
function elements(node: ReactNode = tree): ReactElement<Record<string, any>>[] {
  if (Array.isArray(node)) return node.flatMap(child => elements(child ?? null));
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Record<string, any>>;
  return [element, ...elements(element.props.children ?? null)];
}
function text(node: ReactNode = tree): string {
  if (Array.isArray(node)) return node.map(child => text(child ?? null)).join("");
  if (!node || typeof node === "boolean") return "";
  return typeof node === "object" && "props" in node ? text((node as ReactElement<Record<string, any>>).props.children ?? null) : String(node);
}
function button(label: string) { return elements().find(e => e.type === "button" && text(e.props.children) === label)!; }
async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); draw(); }
const profile = { supported: true, profiles: [{ id: "Claude" as const, path: "/fixture/Claude/developer_settings.json" }], profile: "Claude" as const, enabled: false };
beforeEach(() => {
  hooks.slots = []; hooks.effects = []; hooks.pending = [];
  props = {
    snapshot: { host: { name: "Fixture", version: "1.3.2", capabilities: [] }, sessions: [], runtime: { state: "unavailable" } } as unknown as DesktopControlSnapshot,
    api: { checkClaudeDesktopDeveloperSettings: vi.fn().mockResolvedValue(profile), enableClaudeDesktopDeveloperSettings: vi.fn().mockRejectedValue(new Error("权限申请被取消，原配置未修改")) } as unknown as ComponentProps<typeof DesktopSettings>["api"],
    onSnapshot: vi.fn(), themeControl: {} as ComponentProps<typeof DesktopSettings>["themeControl"],
  };
  draw();
});

it("lets the user retry after an enable attempt is canceled or denied", async () => {
  await settle();
  expect(button("一键开启").props.disabled).toBe(false);
  button("一键开启").props.onClick(); draw(); await settle();
  expect(text()).toContain("权限申请被取消，原配置未修改");
  expect(button("一键开启").props.disabled).toBe(false);
  button("一键开启").props.onClick(); draw(); await settle();
  expect(props.api.enableClaudeDesktopDeveloperSettings).toHaveBeenCalledTimes(2);
});

it("keeps a known selected profile actionable after a later check fails", async () => {
  await settle();
  vi.mocked(props.api.checkClaudeDesktopDeveloperSettings).mockRejectedValueOnce(new Error("EPERM: access denied"));
  button("重新检查").props.onClick(); draw(); await settle();
  expect(text()).toContain("EPERM: access denied");
  expect(button("一键开启").props.disabled).toBe(false);
});
