import type { BridgeSessionCommandResult, BridgeSessionPermissions } from "@bridge/protocol";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findSessionCommand, sessionCommandName, useSessionCommands } from "../../hooks/useSessionCommands.js";
import { SessionPermissionsEditor } from "./SessionCommandDialogs.js";

const hooks = vi.hoisted(() => ({ slots: [] as any[], index: 0, dirty: false, effects: [] as Array<{ deps?: unknown[]; cleanup?: (() => void) | undefined }>, pending: [] as Array<() => void>, effectIndex: 0 }));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useState(initial: any) {
    const index = hooks.index++;
    const slots = hooks.slots;
    if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
    return [slots[index], (value: any) => {
      const next = typeof value === "function" ? value(slots[index]) : value;
      if (!Object.is(next, slots[index])) hooks.dirty = true;
      slots[index] = next;
    }];
  },
  useRef(initial: unknown) {
    const index = hooks.index++;
    hooks.slots[index] ??= { current: initial };
    return hooks.slots[index];
  },
  useEffect(effect: () => (() => void) | void, deps?: unknown[]) {
    const index = hooks.effectIndex++;
    const prev = hooks.effects[index];
    if (prev && deps && deps.every((value, i) => Object.is(value, prev.deps?.[i]))) return;
    hooks.pending.push(() => { prev?.cleanup?.(); hooks.effects[index] = { ...(deps ? { deps } : {}), cleanup: effect() || undefined }; });
  },
}));
function elements(node: ReactNode): ReactElement<Record<string, any>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Record<string, any>>;
  return [element, ...elements(element.props.children)];
}
function renderer(component: () => ReactNode) {
  return () => {
    for (let i = 0; i < 12; i++) {
      hooks.index = 0; hooks.effectIndex = 0; hooks.dirty = false;
      const tree = component();
      hooks.pending.splice(0).forEach(effect => effect());
      if (!hooks.dirty) return tree;
    }
    throw new Error("Component did not settle");
  };
}
async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
beforeEach(() => { hooks.slots = []; hooks.effects = []; hooks.pending = []; });
afterEach(() => { hooks.effects.forEach(effect => effect.cleanup?.()); });

const catalog = { sessionId: "A", commands: [
  { name: "compact", description: "压缩", action: "sdk" as const },
  { name: "review", aliases: ["check"], description: "检查" },
] };

describe("session command dispatch", () => {
  it.each(["/absolute/path", "/tmp/file.md text", "hello /compact", " /compact", "/a\\b", "/"])("does not recognize prose or paths %s", text => {
    expect(sessionCommandName(text)).toBeUndefined();
    expect(findSessionCommand(text, catalog)).toBeUndefined();
  });

  it("resolves catalog aliases and common commands only on explicit execution", async () => {
    const onRun = vi.fn().mockResolvedValue({ action: "sent" });
    const options = { sessionId: "A", enabled: true, supported: true, onLoad: vi.fn().mockResolvedValue(catalog), onRun, onModel: vi.fn(), onSession: vi.fn() };
    let commands!: ReturnType<typeof useSessionCommands>;
    const draw = renderer(() => { commands = useSessionCommands(options); return null; });
    draw();
    await commands.load!(); draw();
    expect(commands.recognizes("/check files")).toBe(true);
    expect(onRun).not.toHaveBeenCalled();
    await expect(commands.execute("/check files", false)).resolves.toBe(true);
    expect(onRun).toHaveBeenCalledWith("/check files");
    expect(await commands.execute("/unknown words", false)).toBe(false);
  });

  it.each(["/help", "/context", "/usage", "/compact notes", "/model", "/permissions", "/new", "/clear", "/fork branch", "/resume", "/rename"])("blocks builtin %s on older hosts", async text => {
    const onRun = vi.fn();
    let commands!: ReturnType<typeof useSessionCommands>;
    renderer(() => { commands = useSessionCommands({ sessionId: "A", enabled: true, supported: false, onRun, onModel: vi.fn(), onSession: vi.fn() }); return null; })();
    await expect(commands.execute(text, false)).rejects.toThrow("更新 Bridge");
    expect(onRun).not.toHaveBeenCalled();
  });

  it("surfaces native unavailability and rejects attachments without running or steering", async () => {
    const onRun = vi.fn();
    let commands!: ReturnType<typeof useSessionCommands>;
    renderer(() => { commands = useSessionCommands({ sessionId: "A", enabled: true, supported: true,
      onLoad: async () => ({ ...catalog, commands: [{ name: "context", description: "上下文", unavailableReason: "请在 Claude Desktop 中执行" }, ...catalog.commands] }),
      onRun, onModel: vi.fn(), onSession: vi.fn(),
    }); return null; })();
    await expect(commands.execute("/context", false)).rejects.toThrow("请在 Claude Desktop 中执行");
    await expect(commands.execute("/compact", true)).rejects.toThrow("先移除附件");
    expect(onRun).not.toHaveBeenCalled();
  });

  it.each(["model", "rename", "session", "help", "resume", "permissions"] as const)("routes %s to its real UI action", async action => {
    const result = { action, session: { sessionId: "fork-A" }, sessions: [], catalog } as unknown as BridgeSessionCommandResult;
    const onModel = vi.fn(); const onRename = vi.fn(); const onSession = vi.fn();
    let commands!: ReturnType<typeof useSessionCommands>;
    const draw = renderer(() => { commands = useSessionCommands({ sessionId: "A", enabled: true, supported: true, onRun: async () => result, onModel, onRename, onSession }); return null; });
    draw(); await commands.execute("/help", false); draw();
    if (action === "model") expect(onModel).toHaveBeenCalledOnce();
    else if (action === "rename") expect(onRename).toHaveBeenCalledOnce();
    else if (action === "session") expect(onSession).toHaveBeenCalledWith("fork-A");
    else expect(commands.dialog).toEqual(result);
  });
});

describe("SDK session permissions", () => {
  const permissions: BridgeSessionPermissions = { sessionId: "A", mode: "acceptEdits", rules: { allow: ["Read"], ask: [], deny: ["Bash(rm:*)"] }, inheritedRules: { allow: ["Bash(git status)"], ask: ["WebFetch"], deny: [] }, canConfigure: true };
  let props: ComponentProps<typeof SessionPermissionsEditor>;
  let draw: () => ReactNode;
  let tree: ReactNode;
  beforeEach(() => {
    props = { onLoadPermissions: vi.fn().mockResolvedValue(permissions), onSavePermissions: vi.fn().mockResolvedValue(permissions), onClose: vi.fn() };
    draw = renderer(() => SessionPermissionsEditor(props));
  });
  async function load() { tree = draw(); await settle(); tree = draw(); }
  const button = (label: string) => elements(tree).find(element => element.type === "button" && elements(element).length === 1 && element.props.children === label)
    ?? elements(tree).find(element => element.type === "button" && Array.isArray(element.props.children) && element.props.children.includes(label))!;

  it("loads actual SDK mode and isolates override fields from inherited rules", async () => {
    await load();
    expect(elements(tree).find(element => element.type === "select")!.props.value).toBe("acceptEdits");
    expect(elements(tree).filter(element => element.type === "option").map(element => [element.props.value, element.props.children])).toEqual([
      ["default", "标准授权"], ["acceptEdits", "自动接受编辑"], ["plan", "计划模式"], ["dontAsk", "仅允许已批准"], ["auto", "自动判断"], ["bypassPermissions", "完全授权"],
    ]);
    const body = elements(tree).find(element => element.props.className === "session-command-body")!;
    expect(elements(body).filter(element => element.type === "textarea")).toHaveLength(3);
    expect(elements(body).some(element => element.type === "footer")).toBe(false);
    expect(elements(tree).filter(element => element.type === "textarea").map(element => element.props.value)).toEqual(["Read", "", "Bash(rm:*)"]);
    expect(elements(tree).filter(element => element.type === "pre").map(element => element.props.children)).toEqual(["Bash(git status)", "WebFetch"]);
    expect(props.onSavePermissions).not.toHaveBeenCalled();
    button("取消").props.onClick();
    expect(props.onClose).toHaveBeenCalledOnce();
    expect(props.onSavePermissions).not.toHaveBeenCalled();
  });

  it("saves all three overrides only after explicit confirmation", async () => {
    await load();
    elements(tree).find(element => element.type === "select")!.props.onChange({ target: { value: "plan" } });
    elements(tree).find(element => element.props["aria-label"] === "会话 ask 规则")!.props.onChange({ target: { value: "Edit\nBash(git:*)\n" } });
    tree = draw();
    expect(props.onSavePermissions).not.toHaveBeenCalled();
    button("保存权限").props.onClick(); await settle();
    expect(props.onSavePermissions).toHaveBeenCalledWith("plan", { allow: ["Read"], ask: ["Edit", "Bash(git:*)"], deny: ["Bash(rm:*)"] });
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it("keeps the editor open and displays an SDK bypass error", async () => {
    props.onSavePermissions = vi.fn().mockRejectedValue(new Error("bypassPermissions was not enabled at startup"));
    await load();
    elements(tree).find(element => element.type === "select")!.props.onChange({ target: { value: "bypassPermissions" } });
    tree = draw(); button("保存权限").props.onClick(); await settle(); tree = draw();
    expect(elements(tree).find(element => element.props.role === "alert")!.props.children).toContain("not enabled at startup");
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("shows an unavailable runtime as read-only", async () => {
    props.onLoadPermissions = vi.fn().mockResolvedValue({ ...permissions, canConfigure: false, unavailableReason: "SDK host 尚未启动" });
    await load();
    expect(elements(tree).filter(element => element.type === "textarea" || element.type === "select").every(element => element.props.disabled)).toBe(true);
    expect(button("保存权限").props.disabled).toBe(true);
  });
});


it("does not reuse a command catalog across computers sharing a logical session ID", async () => {
  const onRun = vi.fn().mockResolvedValue({ action: "sent" });
  const options = { sessionId: "A", sessionKey: "computer-1:A", enabled: true, supported: true,
    onLoad: vi.fn().mockResolvedValue({ sessionId: "A", commands: [{ name: "context", description: "上下文", unavailableReason: "computer-1 only" }] }),
    onRun, onModel: vi.fn(), onSession: vi.fn(),
  };
  let commands!: ReturnType<typeof useSessionCommands>;
  const draw = renderer(() => { commands = useSessionCommands(options); return null; });
  draw(); await commands.load!(); draw();
  options.sessionKey = "computer-2:A";
  options.onLoad.mockResolvedValue({ sessionId: "A", commands: [] });
  draw(); await expect(commands.execute("/context", false)).resolves.toBe(true);
  expect(onRun).toHaveBeenCalledWith("/context");
});


it("does not open a returned fork in a newly selected computer or session", async () => {
  let resolve!: (result: BridgeSessionCommandResult) => void;
  const pending = new Promise<BridgeSessionCommandResult>(yes => { resolve = yes; });
  const onSession = vi.fn();
  const options = { sessionId: "A", sessionKey: "host-1:A", enabled: true, supported: true,
    onRun: () => pending, onModel: vi.fn(), onSession,
  };
  let commands!: ReturnType<typeof useSessionCommands>;
  const draw = renderer(() => { commands = useSessionCommands(options); return null; });
  draw(); const command = commands.execute("/fork", false);
  options.sessionKey = "host-2:A"; draw();
  resolve({ action: "session", session: { sessionId: "old-fork" } } as BridgeSessionCommandResult);
  await command;
  expect(onSession).not.toHaveBeenCalled();
});


describe("frontend command edges", () => {
  it("[edge] replaces a cached alias when the refreshed catalog becomes empty", async () => {
    const onRun = vi.fn().mockResolvedValue({ action: "sent" });
    const onLoad = vi.fn().mockResolvedValue(catalog);
    let commands!: ReturnType<typeof useSessionCommands>;
    const draw = renderer(() => { commands = useSessionCommands({ sessionId: "A", enabled: true, supported: true, onLoad, onRun, onModel: vi.fn(), onSession: vi.fn() }); return null; });
    draw(); await commands.load!(); draw();
    expect(commands.recognizes("/check files")).toBe(true);
    onLoad.mockResolvedValue({ sessionId: "A", commands: [] });
    await commands.load!(); draw();
    expect(commands.recognizes("/check files")).toBe(false);
    await expect(commands.execute("/check files", false)).resolves.toBe(false);
    await expect(commands.execute("/help", false)).resolves.toBe(true);
    expect(onRun).toHaveBeenCalledExactlyOnceWith("/help");
  });
});

describe("permission lifecycle edges", () => {
  const initial: BridgeSessionPermissions = { sessionId: "A", mode: "acceptEdits", rules: { allow: ["Read"], ask: ["Edit"], deny: [] }, inheritedRules: { allow: ["Bash(git status)"], ask: [], deny: [] }, canConfigure: true };
  let props: ComponentProps<typeof SessionPermissionsEditor>;
  let draw: () => ReactNode;
  let tree: ReactNode;
  beforeEach(() => {
    props = { onLoadPermissions: vi.fn().mockResolvedValue(initial), onSavePermissions: vi.fn().mockResolvedValue(initial), onClose: vi.fn() };
    draw = renderer(() => SessionPermissionsEditor(props));
  });
  async function load() { tree = draw(); await settle(); tree = draw(); }
  function click(label: string) {
    const button = elements(tree).find(element => element.type === "button" && (element.props.children === label || (Array.isArray(element.props.children) && element.props.children.includes(label))))!;
    button.props.onClick();
  }
  function mode(value: string) { elements(tree).find(element => element.type === "select")!.props.onChange({ target: { value } }); tree = draw(); }
  function reopen() {
    hooks.effects.forEach(effect => effect.cleanup?.());
    hooks.slots = []; hooks.effects = []; hooks.pending = [];
    draw = renderer(() => SessionPermissionsEditor(props));
  }

  it("[edge] reloads actual permission mode after mode succeeds but rule replacement fails, preserving the draft", async () => {
    let actual = initial;
    props.onLoadPermissions = vi.fn(async () => actual);
    props.onSavePermissions = vi.fn(async selected => {
      actual = { ...actual, mode: selected };
      throw new Error("rule replacement failed");
    });
    await load(); mode("plan");
    elements(tree).find(element => element.props["aria-label"] === "会话 ask 规则")!.props.onChange({ target: { value: "Bash(git push)" } }); tree = draw();
    click("保存权限"); await settle(); tree = draw();
    expect(props.onLoadPermissions).toHaveBeenCalledTimes(2);
    expect(elements(tree).find(element => element.props.className === "session-permission-status")!.props.children.join("")).toBe("当前生效：计划模式");
    expect(elements(tree).find(element => element.props["aria-label"] === "会话 ask 规则")!.props.value).toBe("Bash(git push)");
    expect(elements(tree).find(element => element.props.role === "alert")!.props.children).toContain("rule replacement failed");
    expect(props.onSavePermissions).toHaveBeenCalledOnce(); expect(props.onClose).not.toHaveBeenCalled();
  });

  it("[edge] does not claim the old effective mode when permission saving and its status reload both fail", async () => {
    props.onLoadPermissions = vi.fn().mockResolvedValueOnce(initial).mockRejectedValueOnce(new Error("status unavailable"));
    props.onSavePermissions = vi.fn().mockRejectedValue(new Error("rule replacement failed"));
    await load(); mode("plan"); click("保存权限"); await settle(); tree = draw();
    expect(props.onLoadPermissions).toHaveBeenCalledTimes(2);
    expect(elements(tree).some(element => element.props.className === "session-permission-status")).toBe(false);
    const error = elements(tree).find(element => element.props.role === "alert")!.props.children;
    expect(error).toContain("rule replacement failed"); expect(error).toContain("status unavailable");
    expect(props.onClose).not.toHaveBeenCalled(); expect(props.onSavePermissions).toHaveBeenCalledOnce();
  });

  it("[edge] discards canceled permission edits and reads a new snapshot when reopened", async () => {
    await load(); mode("plan");
    elements(tree).find(element => element.props["aria-label"] === "会话 allow 规则")!.props.onChange({ target: { value: "Write" } }); tree = draw();
    click("取消");
    props.onLoadPermissions = vi.fn().mockResolvedValue({ ...initial, mode: "dontAsk", rules: { allow: ["Read", "Edit"], ask: [], deny: ["Bash(sudo:*)"] } });
    reopen(); await load();
    expect(elements(tree).find(element => element.type === "select")!.props.value).toBe("dontAsk");
    expect(elements(tree).filter(element => element.type === "textarea").map(element => element.props.value)).toEqual(["Read\nEdit", "", "Bash(sudo:*)"]);
    expect(props.onSavePermissions).not.toHaveBeenCalled();
  });

  it("[edge] a previous permission save finishing after close does not close the newly reopened panel", async () => {
    let resolve!: (value: BridgeSessionPermissions) => void;
    props.onSavePermissions = vi.fn(() => new Promise<BridgeSessionPermissions>(yes => { resolve = yes; }));
    await load(); mode("plan"); click("保存权限"); tree = draw();
    // The dialog's header/escape can close the old editor while its explicit save is pending.
    props.onClose(); reopen(); await load();
    expect(props.onClose).toHaveBeenCalledOnce();
    resolve({ ...initial, mode: "plan" }); await settle(); tree = draw();
    expect(props.onClose).toHaveBeenCalledOnce();
    expect(elements(tree).find(element => element.type === "select")!.props.value).toBe("acceptEdits");
  });
});
