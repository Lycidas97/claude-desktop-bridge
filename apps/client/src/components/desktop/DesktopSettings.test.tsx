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
  if (typeof element.type === "function") return elements((element.type as (p: any) => ReactNode)(element.props));
  return [element, ...elements(element.props.children ?? null)];
}
function text(node: ReactNode = tree): string {
  if (Array.isArray(node)) return node.map(child => text(child ?? null)).join("");
  if (!node || typeof node === "boolean") return "";
  if (typeof node === "object" && "props" in node) {
    const element = node as ReactElement<Record<string, any>>;
    if (typeof element.type === "function") return text((element.type as (p: any) => ReactNode)(element.props));
    return text(element.props.children ?? null);
  }
  return String(node);
}
function button(label: string) { return elements().find(e => e.type === "button" && text(e.props.children) === label)!; }
async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); draw(); }
const profile = { supported: true, profiles: [{ id: "Claude" as const, path: "/fixture/Claude/developer_settings.json" }], profile: "Claude" as const, enabled: false };
beforeEach(() => {
  hooks.slots = []; hooks.effects = []; hooks.pending = [];
  props = {
    snapshot: { host: { name: "Fixture", version: "1.3.2", capabilities: [] }, sessions: [], permissions: [], diagnosticsEnabled: false, runtime: { state: "unavailable" } } as unknown as DesktopControlSnapshot,
    api: { checkClaudeDesktopDeveloperSettings: vi.fn().mockResolvedValue(profile), enableClaudeDesktopDeveloperSettings: vi.fn().mockRejectedValue(new Error("权限申请被取消，原配置未修改")) } as unknown as ComponentProps<typeof DesktopSettings>["api"],
    onSnapshot: vi.fn(), themeControl: {} as ComponentProps<typeof DesktopSettings>["themeControl"],
  };
  draw();
});

it("uses the local recorder setting and displays the returned state", async () => {
  props.api.setDiagnosticsEnabled = vi.fn(async enabled => ({ ...props.snapshot, diagnosticsEnabled: enabled }));
  button("诊断与关于").props.onClick(); draw();
  const checkbox = () => elements().find(element => element.type === "input" && element.props.type === "checkbox")!;
  expect(checkbox().props.checked).toBe(false);
  checkbox().props.onChange({ target: { checked: true } }); await settle();
  expect(props.api.setDiagnosticsEnabled).toHaveBeenCalledWith(true);
  props.snapshot = vi.mocked(props.onSnapshot).mock.calls.at(-1)![0]; draw();
  expect(checkbox().props.checked).toBe(true);
  checkbox().props.onChange({ target: { checked: false } }); await settle();
  expect(props.api.setDiagnosticsEnabled).toHaveBeenLastCalledWith(false);
  props.snapshot = vi.mocked(props.onSnapshot).mock.calls.at(-1)![0]; draw();
  expect(checkbox().props.checked).toBe(false);
  vi.mocked(props.api.setDiagnosticsEnabled).mockRejectedValueOnce(new Error("Local recorder unavailable"));
  checkbox().props.onChange({ target: { checked: true } }); await settle();
  expect(checkbox().props.checked).toBe(false);
  expect(text()).toContain("Local recorder unavailable");
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

it("renders desktop updater controls and OS silent-restart boundary in about section", async () => {
  props.snapshot = {
    ...props.snapshot,
    host: { name: "Fixture", version: "1.3.2", capabilities: ["claude.native-relay.v1", "system.update.v1"] },
    permissions: [],
    latestSeq: 0,
    runtimes: [{ id: "claude-desktop", state: "ready", capabilities: ["session.list", "session.history"] }],
    updater: {
      platform: "darwin",
      arch: "arm64",
      currentVersion: "1.3.2",
      channel: "stable",
      autoCheck: true,
      applyMode: "prompt",
      canAutoRestart: false,
      phase: "ready",
      latestVersion: "1.3.3",
    },
  } as unknown as DesktopControlSnapshot;
  draw();
  button("诊断与关于").props.onClick();
  draw();
  expect(text()).toContain("已就绪");
  expect(text()).toContain("版本更新");
  expect(text()).toContain("macOS 未公证/DMG 包不支持后台静默覆盖系统目录");
  expect(button("空闲静默重启").props.disabled).toBe(true);
  expect(text()).toContain("打开安装包 (v1.3.3)");
});
