import type { DesktopControlSnapshot } from "@bridge/protocol";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { registerDiagnosticsStateProvider } from "../../lib/diagnostics.js";
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
vi.mock("../../../../../plugins/magpie-quota/client.js", () => ({
  MagpieQuotaDashboard: () => <div data-quota-dashboard />,
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
    snapshot: { host: { name: "Fixture", version: "1.3.2", relayUrl: "ws://127.0.0.1:8788/ws", capabilities: [] }, sessions: [], permissions: [], diagnosticsEnabled: false, runtime: { state: "unavailable" } } as unknown as DesktopControlSnapshot,
    api: { checkClaudeDesktopDeveloperSettings: vi.fn().mockResolvedValue(profile), enableClaudeDesktopDeveloperSettings: vi.fn().mockRejectedValue(new Error("权限申请被取消，原配置未修改")) } as unknown as ComponentProps<typeof DesktopSettings>["api"],
    onSnapshot: vi.fn(), themeControl: {} as ComponentProps<typeof DesktopSettings>["themeControl"],
  };
  draw();
});

it("mounts quota only in its unique group and returns to existing settings", () => {
  expect(elements().filter(element => element.props["data-quota-dashboard"])).toHaveLength(0);
  expect(elements().filter(element => element.type === "button" && text(element.props.children) === "Magpie 额度")).toHaveLength(1);
  button("Magpie 额度").props.onClick(); draw();
  expect(elements().filter(element => element.props["data-quota-dashboard"])).toHaveLength(1);
  for (const [label, content] of [["连接与启动", "开机自动运行"], ["外观与显示", "显示模式"], ["诊断与关于", "后台诊断记录"], ["Claude 接入", "开发者工具"]]) {
    button(label!).props.onClick(); draw();
    expect(text()).toContain(content);
    expect(elements().filter(element => element.props["data-quota-dashboard"])).toHaveLength(0);
  }
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

it("keeps timestamped startup history outside current errors after the port recovers", () => {
  props.snapshot.claudeInspector = { state: "closed", port: 9229, pollIntervalMs: 3000, clients: [], alerts: [],
    startup: { state: "failed", recordedAt: 1794697200000, detail: "自动开启失败：旧权限错误 (-2700)" } };
  draw();
  const history = () => elements().find(element => element.type === "details" && text(element.props.children).includes("历史启动记录"))!;
  expect(history().props.open).toBeUndefined();
  expect(text(history())).toContain("旧权限错误 (-2700)");
  expect(text(history())).toContain("本进程不再自动尝试");
  expect(elements(history()).find(element => element.type === "time")?.props.dateTime).toBe(new Date(1794697200000).toISOString());
  expect(elements().filter(element => element.props.className === "inline-error")).toHaveLength(0);
  props.snapshot.claudeInspector.state = "listening";
  draw();
  expect(text()).toContain("调试端口已开放");
  expect(text(history())).toContain("旧权限错误 (-2700)");
  expect(elements().filter(element => element.props.className === "inline-error")).toHaveLength(0);
  props.snapshot.claudeInspector.startup = { state: "legacy", detail: "旧版启动记录" };
  draw();
  expect(text(history())).toContain("时间未知");
});

it("shows the native debugger menu action only while the port is closed", () => {
  props.snapshot.claudeInspector = { state: "closed", port: 9229, pollIntervalMs: 3000, clients: [], alerts: [] };
  draw();
  expect(text()).toContain("调试端口未开放");
  expect(text()).toContain("Developer › Enable Main Process Debugger");
  props.snapshot.claudeInspector.state = "listening";
  draw();
  expect(text()).toContain("调试端口已开放");
  expect(text()).not.toContain("Developer › Enable Main Process Debugger");
});

it("renders Windows Alt instructions with live connection state", () => {
  props.snapshot.claudeInspector = { platform: "win32", state: "closed", port: 9229, pollIntervalMs: 3000, clients: [], alerts: [] };
  draw();
  expect(text()).toContain("按 Alt 显示菜单");
  expect(text()).not.toContain("仅支持 macOS");
  props.snapshot.claudeInspector.state = "listening";
  props.snapshot.claudeInspector.clients = [{ pid: 42, name: "Bridge", approved: true, executablePath: "D:\\Tools\\Bridge\\Bridge.exe" }];
  draw();
  expect(text()).toContain("调试端口已开放 · 1 个连接进程");
  expect(text()).not.toContain("按 Alt 显示菜单");
});

it("shows actionable Accessibility consent separately from historical attempts", async () => {
  props.api.openAccessibilitySettings = vi.fn().mockResolvedValue(undefined);
  props.snapshot.claudeInspector = { platform: "darwin", state: "closed", port: 9229, pollIntervalMs: 3000, clients: [], alerts: [],
    startup: { state: "accessibility-required", detail: "请添加 /Applications/Bridge.app，授权后自动继续。" } };
  draw();
  expect(text()).toContain("/Applications/Bridge.app");
  expect(text()).not.toContain("历史启动记录");
  expect(text()).not.toContain("本进程不再自动尝试");
  button("打开辅助功能设置").props.onClick(); await settle();
  expect(props.api.openAccessibilitySettings).toHaveBeenCalledOnce();
  vi.mocked(props.api.openAccessibilitySettings).mockRejectedValueOnce(new Error("系统设置不可用"));
  button("打开辅助功能设置").props.onClick(); await settle();
  expect(text()).toContain("系统设置不可用");
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

it("passes the collected renderer diagnostics snapshot to exportDiagnostics while preserving diagnostic labels", async () => {
  const dispose = registerDiagnosticsStateProvider("desktopConversations", () => ({
    trackedHosts: 1,
    totalBufferedEvents: 7,
  }));
  vi.stubGlobal("performance", {
    memory: {
      usedJSHeapSize: 10_000_000,
      totalJSHeapSize: 20_000_000,
      jsHeapSizeLimit: 500_000_000,
    },
  });
  props.api.exportDiagnostics = vi.fn().mockResolvedValue({ saved: true, path: "/tmp/diag.json" });
  try {
    button("诊断与关于").props.onClick();
    draw();
    expect(text()).toContain("后台诊断记录");
    expect(button("连接诊断与日志")).toBeDefined();
    expect(button("导出诊断")).toBeDefined();

    button("导出诊断").props.onClick();
    await settle();
    expect(props.api.exportDiagnostics).toHaveBeenCalledOnce();
    const payload = vi.mocked(props.api.exportDiagnostics).mock.calls[0]![0]!;
    expect(payload).toMatchObject({
      schemaVersion: 1,
      rendererMemory: {
        usedJSHeapSize: 10_000_000,
        totalJSHeapSize: 20_000_000,
        jsHeapSizeLimit: 500_000_000,
      },
      stateGauges: expect.objectContaining({
        desktopConversations: {
          trackedHosts: 1,
          totalBufferedEvents: 7,
        },
      }),
    });

    vi.mocked(props.api.exportDiagnostics).mockRejectedValueOnce(new Error("磁盘写入权限不足"));
    button("导出诊断").props.onClick();
    await settle();
    expect(text()).toContain("磁盘写入权限不足");
  } finally {
    dispose();
    vi.unstubAllGlobals();
  }
});

it("surfaces launchAtLogin errors cleanly inside connections group", async () => {
  props.api.setLaunchAtLogin = vi.fn().mockRejectedValueOnce(new Error("登录项写入被系统拒绝"));
  button("连接与启动").props.onClick();
  draw();
  const checkbox = elements().find(element => element.type === "input" && element.props.type === "checkbox")!;
  checkbox.props.onChange({ target: { checked: true } });
  await settle();
  expect(props.api.setLaunchAtLogin).toHaveBeenCalledWith(true);
  expect(text()).toContain("登录项写入被系统拒绝");
});
