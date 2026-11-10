import type { BridgeHostSnapshot, BridgeMagpieConnectionInput, BridgeMagpieConnectionTestResult, DesktopControlSnapshot } from "@bridge/protocol";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopSettings } from "./DesktopSettings.js";
import { ProviderSettings } from "./ProviderSettings.js";

// Match the existing settings tests: drive hooks and public controls without a DOM dependency.
const hooks = vi.hoisted(() => ({
  slots: [] as any[], index: 0, dirty: false,
  effects: [] as Array<{ deps: unknown[] | undefined }>,
  effectIndex: 0, pending: [] as Array<() => void>,
}));
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
  useEffect(effect: () => void, deps?: unknown[]) {
    const index = hooks.effectIndex++;
    const previous = hooks.effects[index];
    if (previous && deps && deps.length === previous.deps?.length && deps.every((value, i) => Object.is(value, previous.deps?.[i]))) return;
    hooks.pending.push(() => { hooks.effects[index] = { deps }; effect(); });
  },
}));

const host = {
  host: { hostId: "computer", name: "Studio Mac", capabilities: [] },
  runtime: { state: "ready", detail: "Ready" },
  providers: [{ id: "api", kind: "anthropic-api", name: "Anthropic API", configured: false, models: [] }],
  sessions: [], projects: [],
  magpie: { mode: "manual", baseUrl: "https://saved.example.com", authScheme: "bearer", keyConfigured: true },
} as unknown as BridgeHostSnapshot;
const ready: BridgeMagpieConnectionTestResult = { models: { state: "ready", count: 7 }, quota: { state: "available" } };
let props: ComponentProps<typeof ProviderSettings>;
let tree: ReactElement;

function draw() {
  for (let pass = 0; pass < 12; pass++) {
    hooks.index = 0; hooks.effectIndex = 0; hooks.dirty = false;
    tree = ProviderSettings(props);
    hooks.pending.splice(0).forEach((effect) => effect());
    if (!hooks.dirty) return;
  }
  throw new Error("Provider settings did not settle");
}
function elements(node: ReactNode = tree): ReactElement<Record<string, any>>[] {
  if (Array.isArray(node)) return node.flatMap((child) => elements(child ?? null));
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Record<string, any>>;
  return [element, ...elements(element.props.children ?? null)];
}
function text(node: ReactNode = tree): string {
  if (Array.isArray(node)) return node.map((child) => text(child ?? null)).join("");
  if (!node || typeof node === "boolean") return "";
  if (typeof node !== "object") return String(node);
  return "props" in node ? text((node as ReactElement<Record<string, any>>).props.children ?? null) : "";
}
function field(id: string) { return elements().find((element) => element.props.id === id)!; }
function button(label: string) { return elements().find((element) => element.type === "button" && text(element.props.children) === label)!; }
function edit(id: string, value: string) { field(id).props.onChange({ target: { value } }); draw(); }
function click(label: string) {
  expect(button(label).props.disabled).not.toBe(true);
  button(label).props.onClick(); draw();
}
async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); draw(); }

beforeEach(() => {
  hooks.slots = []; hooks.effects = []; hooks.pending = [];
  props = {
    snapshot: { ...host }, desktopLocal: true, onRefresh: vi.fn(),
    onSetApiKey: vi.fn(), onRemoveApiKey: vi.fn(),
    onTestMagpieConnection: vi.fn().mockResolvedValue(ready),
    onSaveMagpieConnection: vi.fn(async (input: BridgeMagpieConnectionInput) => {
      const magpie: BridgeHostSnapshot["magpie"] = input.mode === "manual"
        ? { mode: "manual", baseUrl: input.baseUrl, authScheme: input.authScheme, keyConfigured: true }
        : { mode: "auto", baseUrl: "https://automatic.example.com", authScheme: "x-api-key", keyConfigured: true };
      props = { ...props, snapshot: { ...props.snapshot!, magpie } };
      return props.snapshot as DesktopControlSnapshot;
    }),
  };
  draw();
});

describe("Magpie connection settings", () => {
  it("does not refill stored keys and tests the current saved connection without saving", async () => {
    expect(field("magpie-api-key").props.value).toBe("");
    expect(field("magpie-api-key").props.placeholder).toContain("留空保留");
    expect(button("保存 Magpie 配置").props.disabled).toBe(true);
    click("测试连接");
    expect(text()).toContain("正在测试 Magpie 连接");
    expect(button("测试连接").props.disabled).toBe(true);
    await settle();
    expect(props.onTestMagpieConnection).toHaveBeenCalledWith({ mode: "manual", baseUrl: "https://saved.example.com", authScheme: "bearer" });
    expect(props.onSaveMagpieConnection).not.toHaveBeenCalled();
    const status = elements().find((element) => element.props.role === "status")!;
    expect(text(status)).toContain("模型列表可用 · 7 个模型");
    expect(text(status)).toContain("额度接口可用");
    expect(status.props["aria-live"]).toBe("polite");
  });

  it.each([
    { models: { state: "ready", count: 3 }, quota: { state: "unsupported" } },
    { models: { state: "error", count: 0, error: "模型请求被拒绝" }, quota: { state: "available" } },
    { models: { state: "ready", count: 2 }, quota: { state: "error", error: "额度请求失败" } },
  ] satisfies BridgeMagpieConnectionTestResult[])("keeps model and quota outcomes separate: %j", async (result) => {
    vi.mocked(props.onTestMagpieConnection!).mockResolvedValue(result);
    click("测试连接"); await settle();
    expect(text()).toContain(result.models.state === "ready" ? `${result.models.count} 个模型` : result.models.error);
    expect(text()).toContain(result.quota.state === "unsupported" ? "额度接口不支持" : result.quota.state === "available" ? "额度接口可用" : result.quota.error);
    expect(props.onSaveMagpieConnection).not.toHaveBeenCalled();
    edit("magpie-auth-scheme", "x-api-key");
    expect(text()).not.toContain("额度接口");
  });

  it.each([["magpie-base-url", "https://new.example.com"], ["magpie-auth-scheme", "x-api-key"]])("requires a key after changing %s", (id, value) => {
    edit(id, value);
    expect(button("测试连接").props.disabled).toBe(true);
    expect(button("保存 Magpie 配置").props.disabled).toBe(true);
    expect(text()).toContain("更换网关、认证方式");
    edit("magpie-api-key", "new-secret");
    expect(button("测试连接").props.disabled).toBe(false);
    expect(button("保存 Magpie 配置").props.disabled).toBe(false);
  });

  it("retains the stored key for an equivalent canonical URL", async () => {
    edit("magpie-base-url", "https://SAVED.example.com:443/");
    expect(button("测试连接").props.disabled).toBe(false);
    click("测试连接"); await settle();
    expect(props.onTestMagpieConnection).toHaveBeenCalledWith({ mode: "manual", baseUrl: "https://SAVED.example.com:443/", authScheme: "bearer" });
  });

  it("requires a key when switching an inherited connection to manual", () => {
    props.snapshot = { ...host, magpie: { ...host.magpie!, mode: "auto" } };
    draw();
    edit("magpie-mode", "manual");
    expect(button("测试连接").props.disabled).toBe(true);
    expect(button("保存 Magpie 配置").props.disabled).toBe(true);
  });

  it("saves the draft, clears the entered secret, and refreshes the saved source", async () => {
    edit("magpie-base-url", "https://new.example.com");
    edit("magpie-auth-scheme", "x-api-key");
    edit("magpie-api-key", "new-secret");
    const save = props.onSaveMagpieConnection;
    click("保存 Magpie 配置");
    expect(button("测试连接").props.disabled).toBe(true);
    expect(field("magpie-api-key").props.disabled).toBe(true);
    await settle();
    expect(save).toHaveBeenCalledWith({ mode: "manual", baseUrl: "https://new.example.com", authScheme: "x-api-key", apiKey: "new-secret" });
    expect(field("magpie-api-key").props.value).toBe("");
    expect(text()).toContain("网关 URLhttps://new.example.com");
    expect(text()).toContain("认证方式x-api-key");
    expect(text()).toContain("Magpie 配置已保存");
    expect(text()).toContain("保存后用于 Magpie 额度查询");
    expect(text()).not.toContain("下次启动 Bridge 执行器");
    expect(button("保存 Magpie 配置").props.disabled).toBe(true);
    expect(props.onSetApiKey).not.toHaveBeenCalled();
  });

  it("restores the automatic source and sends no manual credentials", async () => {
    edit("magpie-api-key", "discarded-secret");
    edit("magpie-mode", "auto");
    expect(field("magpie-api-key")).toBeUndefined();
    const save = props.onSaveMagpieConnection;
    click("保存 Magpie 配置"); await settle();
    expect(save).toHaveBeenCalledWith({ mode: "auto" });
    expect(text()).toContain("当前来源沿用 Claude/Claude-3p 配置");
    expect(text()).toContain("https://automatic.example.com");
    edit("magpie-mode", "manual");
    expect(field("magpie-api-key").props.value).toBe("");
  });

  it.each(["test", "save"] as const)("keeps the full draft after a %s failure", async (action) => {
    edit("magpie-base-url", "https://draft.example.com");
    edit("magpie-api-key", "keep-this-secret");
    if (action === "test") vi.mocked(props.onTestMagpieConnection!).mockRejectedValue(new Error("连接被拒绝"));
    else vi.mocked(props.onSaveMagpieConnection!).mockRejectedValue(new Error("连接被拒绝"));
    click(action === "test" ? "测试连接" : "保存 Magpie 配置"); await settle();
    expect(field("magpie-base-url").props.value).toBe("https://draft.example.com");
    expect(field("magpie-api-key").props.value).toBe("keep-this-secret");
    expect(elements().find((element) => element.props.role === "alert")?.props.children).toBe("连接被拒绝");
    expect(text()).not.toContain("Magpie 配置已保存");
    expect(button("保存 Magpie 配置").props.disabled).toBe(false);
  });

  it("preserves a tested draft across unrelated broadcasts and changed saved settings", async () => {
    edit("magpie-base-url", "https://draft.example.com");
    edit("magpie-api-key", "draft-secret");
    click("测试连接"); await settle();
    props.snapshot = { ...props.snapshot!, latestSeq: 45, magpie: { ...props.snapshot!.magpie! } };
    draw();
    expect(field("magpie-base-url").props.value).toBe("https://draft.example.com");
    expect(field("magpie-api-key").props.value).toBe("draft-secret");
    expect(text()).toContain("7 个模型");
    props.snapshot = { ...props.snapshot!, magpie: { ...props.snapshot!.magpie!, baseUrl: "https://external-save.example.com" } };
    draw();
    expect(field("magpie-base-url").props.value).toBe("https://draft.example.com");
    expect(field("magpie-api-key").props.value).toBe("draft-secret");
  });

  it("updates a clean form only when actual saved settings change", async () => {
    click("测试连接"); await settle();
    props.snapshot = { ...props.snapshot!, latestSeq: 46, magpie: { ...props.snapshot!.magpie! } };
    draw();
    expect(text()).toContain("7 个模型");
    props.snapshot = { ...props.snapshot!, magpie: { mode: "manual", baseUrl: "https://external.example.com", authScheme: "x-api-key", keyConfigured: true } };
    draw();
    expect(field("magpie-base-url").props.value).toBe("https://external.example.com");
    expect(field("magpie-auth-scheme").props.value).toBe("x-api-key");
    expect(text()).not.toContain("7 个模型");
    expect(field("magpie-api-key").props.value).toBe("");
  });

  it("disables test and save offline while retaining the draft", () => {
    edit("magpie-api-key", "offline-draft");
    props.connected = false; draw();
    expect(button("测试连接").props.disabled).toBe(true);
    expect(button("保存 Magpie 配置").props.disabled).toBe(true);
    expect(field("magpie-api-key").props.value).toBe("offline-draft");
    expect(props.onSaveMagpieConnection).not.toHaveBeenCalled();
  });
});

describe("desktop Magpie API wiring", () => {
  it("passes the optional methods through and publishes the saved snapshot", async () => {
    hooks.slots = []; hooks.index = 0;
    const saved = { ...host, magpie: { mode: "auto", keyConfigured: false } } as DesktopControlSnapshot;
    const api = { testMagpieConnection: vi.fn().mockResolvedValue(ready), saveMagpieConnection: vi.fn().mockResolvedValue(saved) };
    const onSnapshot = vi.fn();
    const wrapper = DesktopSettings({ snapshot: host as DesktopControlSnapshot, api, onSnapshot } as unknown as ComponentProps<typeof DesktopSettings>);
    const provider = elements(wrapper).find((element) => element.type === ProviderSettings)!;
    const input = { mode: "auto" } as const;
    expect(await provider.props.onTestMagpieConnection(input)).toBe(ready);
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(await provider.props.onSaveMagpieConnection(input)).toBe(saved);
    expect(api.testMagpieConnection).toHaveBeenCalledWith(input);
    expect(api.saveMagpieConnection).toHaveBeenCalledWith(input);
    expect(onSnapshot).toHaveBeenCalledWith(saved);
  });

  it("omits the edit callbacks on an older desktop host", () => {
    hooks.slots = []; hooks.index = 0;
    const wrapper = DesktopSettings({ snapshot: host as DesktopControlSnapshot, api: {} } as unknown as ComponentProps<typeof DesktopSettings>);
    const provider = elements(wrapper).find((element) => element.type === ProviderSettings)!;
    expect(provider.props.onTestMagpieConnection).toBeUndefined();
    expect(provider.props.onSaveMagpieConnection).toBeUndefined();
  });
});
