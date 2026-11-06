import type { BridgeDirectoryListing, BridgeHostSnapshot, BridgeProjectInfo, BridgeSessionInfo } from "@bridge/protocol";
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchMobileBack, registerMobileBackHandler } from "../lib/mobile-back-navigation.js";
import { SessionCreateDialog, type SessionCreateDialogProps } from "./SessionCreateDialog.js";

// Exercise public controls and effect cleanup using the existing client harness.
const hooks = vi.hoisted(() => ({
  states: [] as unknown[], stateIndex: 0,
  effects: [] as Array<{ deps: unknown[] | undefined; cleanup: (() => void) | undefined }>,
  effectIndex: 0, pending: [] as Array<() => void>,
}));
vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useId: () => "session-create",
  useRef: () => ({ current: null }),
  useState(initial: unknown) {
    const index = hooks.stateIndex++;
    if (!(index in hooks.states)) hooks.states[index] = typeof initial === "function" ? initial() : initial;
    return [hooks.states[index], (next: unknown) => { hooks.states[index] = typeof next === "function" ? next(hooks.states[index]) : next; }];
  },
  useEffect(effect: () => (() => void) | void, deps?: unknown[]) {
    const index = hooks.effectIndex++;
    const previous = hooks.effects[index];
    if (previous && deps && deps.length === previous.deps?.length && deps.every((value, i) => Object.is(value, previous.deps?.[i]))) return;
    hooks.pending.push(() => { previous?.cleanup?.(); hooks.effects[index] = { deps, cleanup: effect() || undefined }; });
  },
}));
function render(props: SessionCreateDialogProps): ReactElement {
  hooks.stateIndex = 0; hooks.effectIndex = 0;
  const tree = SessionCreateDialog(props);
  hooks.pending.splice(0).forEach((effect) => effect());
  return tree;
}
function elements(node: ReactNode): ReactElement<Record<string, any>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Record<string, any>>;
  return [element, ...elements(element.props.children)];
}
function text(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  return node && typeof node === "object" && "props" in node ? text((node as ReactElement<{ children?: ReactNode }>).props.children) : "";
}
function field(tree: ReactElement, name: string): ReactElement<Record<string, any>> {
  return elements(tree).find((element) => element.props["aria-label"] === name)!;
}
function button(tree: ReactElement, name: string): ReactElement<Record<string, any>> {
  return elements(tree).find((element) => element.type === "button" && (element.props["aria-label"] === name || text(element.props.children).trim() === name))!;
}
function change(tree: ReactElement, name: string, value: string): void { field(tree, name).props.onChange({ target: { value } }); }
function submit(tree: ReactElement): void { elements(tree).find((element) => element.type === "form")!.props.onSubmit({ preventDefault: vi.fn() }); }
async function settle(): Promise<void> { for (let i = 0; i < 8; i += 1) await Promise.resolve(); }
async function click(input: SessionCreateDialogProps, name: string): Promise<ReactElement> {
  button(render(input), name).props.onClick(); render(input); await settle(); return render(input);
}
beforeEach(() => { hooks.states = []; hooks.effects = []; hooks.pending = []; });
afterEach(() => hooks.effects.forEach((effect) => effect.cleanup?.()));
const directory: BridgeProjectInfo = {
  projectId: "cwd-hash", name: "Existing folder", cwd: "/work/existing", kind: "directory", runtimeId: "claude-desktop",
  sessionCount: 1, runningCount: 0, pendingCount: 0, lastActivityAt: 1,
};
const group: BridgeProjectInfo = { ...directory, projectId: "desktop-group", name: "Research", kind: "desktop-group" };
const created = { sessionId: "created", cwd: "/work/new", projectId: "desktop-group" } as BridgeSessionInfo;
function snapshot(projects: BridgeProjectInfo[] = []): BridgeHostSnapshot {
  return {
    host: { hostId: "computer", name: "Work computer", pairingEpoch: 1, relayUrl: "ws://localhost:8788", online: true, lastSeenAt: 1, version: "1.1.2", capabilities: ["directory.browse.v1"] },
    projects, sessions: [], devices: [], permissions: [], latestSeq: 1,
    runtime: { state: "ready", detail: "", activeTurns: 0, maxParallelTurns: 1, desktopIntegration: { state: "ready", detail: "", enabled: true, canRestart: true } },
    runtimes: (["claude-desktop", "codex-desktop", "hermes-desktop"] as const).map((id) => ({
      id, name: id, state: id === "hermes-desktop" ? "unavailable" : "ready", detail: "", capabilities: id === "hermes-desktop" ? [] : ["session.create"], sessionIsolation: "independent", sessionCount: 0, updatedAt: 1,
    })),
  };
}
function props(host = snapshot()): SessionCreateDialogProps {
  return { snapshot: host, connected: true, onCreate: vi.fn().mockResolvedValue(created), onCreated: vi.fn(), onClose: vi.fn() };
}
const listing: BridgeDirectoryListing = { path: "/work", parentPath: "/", directories: [{ name: "new", path: "/work/new" }], recentPaths: ["/recent"] };
async function manual(input: SessionCreateDialogProps, path: string): Promise<ReactElement> {
  await click(input, "选择文件夹");
  let tree = render(input);
  if (!field(tree, "当前路径")) tree = await click(input, "输入路径");
  change(tree, "当前路径", path);
  return click(input, "使用此文件夹");
}

describe("runtime and draft preservation", () => {
  it("filters history by runtime and never falls back to the old runtime folder", async () => {
    const codex = { ...directory, projectId: "codex", cwd: "/codex", runtimeId: "codex-desktop" as const };
    const input = { ...props(snapshot([group, codex])), initialProjectId: group.projectId };
    change(render(input), "运行时", "codex-desktop");
    expect(text(field(render(input), "工作文件夹"))).not.toContain(group.cwd);
    expect(field(render(input), "项目分组（可选）")).toBeUndefined();
    let tree = await click(input, "选择文件夹");
    expect(button(tree, `选择 ${group.cwd}`)).toBeUndefined();
    tree = await click(input, "选择 /codex"); submit(tree); await settle();
    expect(input.onCreate).toHaveBeenCalledWith("/codex", undefined, "codex-desktop", undefined);
  });
  it("leaves the folder empty when the new runtime has no history", () => {
    const input = { ...props(snapshot([group])), initialProjectId: group.projectId };
    change(render(input), "运行时", "codex-desktop");
    expect(button(render(input), "创建会话").props.disabled).toBe(true);
    expect(text(field(render(input), "工作文件夹"))).toContain("选择工作文件夹");
  });
  it("does not apply an initial project from a different runtime", () => {
    const input = { ...props(snapshot([group])), initialProjectId: group.projectId, initialRuntimeId: "codex-desktop" as const };
    expect(field(render(input), "项目分组（可选）")).toBeUndefined();
    expect(button(render(input), "创建会话").props.disabled).toBe(true);
  });
  it("uses untyped legacy projects only as directory shortcuts", async () => {
    const legacy = { ...directory, projectId: "legacy" }; delete legacy.kind;
    const input = props(snapshot([legacy]));
    await click(input, "选择文件夹");
    const tree = await click(input, `选择 ${legacy.cwd}`);
    expect(field(tree, "项目分组（可选）")).toBeUndefined();
    submit(tree); await settle();
    expect(input.onCreate).toHaveBeenCalledWith(legacy.cwd, undefined, "claude-desktop", undefined);
  });
  it("preserves the draft after a failed creation or an empty response", async () => {
    const input = { ...props(snapshot([group])), initialProjectId: group.projectId };
    vi.mocked(input.onCreate).mockRejectedValueOnce(new Error("Permission denied")).mockResolvedValueOnce(undefined);
    let tree = await manual(input, "/private/new");
    change(tree, "会话名称（可选）", "Keep title");
    submit(render(input)); await settle(); tree = render(input);
    expect(text(tree)).toContain("Permission denied");
    expect(text(field(tree, "工作文件夹"))).toContain("/private/new");
    expect(field(tree, "会话名称（可选）").props.value).toBe("Keep title");
    expect(field(tree, "项目分组（可选）").props.value).toBe(group.projectId);
    submit(tree); await settle(); expect(text(render(input))).toContain("会话未创建");
    expect(input.onClose).not.toHaveBeenCalled();
  });
  it("disables offline creation and folder selection without discarding the draft", () => {
    const input = { ...props(snapshot([group])), initialProjectId: group.projectId };
    render(input); input.connected = false;
    const tree = render(input);
    expect(text(field(tree, "工作文件夹"))).toContain(group.cwd);
    expect(button(tree, "创建会话").props.disabled).toBe(true);
    expect(button(tree, "选择文件夹").props.disabled).toBe(true);
    submit(tree); expect(input.onCreate).not.toHaveBeenCalled();
  });
  it("blocks runtimes without creation capability and missing selected groups", () => {
    const input = { ...props(snapshot([group])), initialProjectId: group.projectId };
    render(input); input.snapshot.runtimes![0]!.capabilities = ["session.list"];
    expect(button(render(input), "创建会话").props.disabled).toBe(true);
    input.snapshot.runtimes![0]!.capabilities = ["session.create"]; input.snapshot.projects = [];
    const tree = render(input);
    expect(button(tree, "创建会话").props.disabled).toBe(true);
    expect(text(tree)).toContain("分组已不可用");
  });
});

describe("folder navigation", () => {
  it("deduplicates recent directories and displays the folder name rather than group names", async () => {
    const input = { ...props(snapshot([group, directory])), onBrowseDirectory: vi.fn().mockResolvedValue({ ...listing, recentPaths: [directory.cwd, "/recent"] }) };
    const tree = await click(input, "选择文件夹");
    expect(elements(tree).filter((element) => element.type === "button" && element.props["aria-label"] === `选择 ${directory.cwd}`)).toHaveLength(1);
    expect(text(tree)).toContain("existing"); expect(text(tree)).not.toContain("Research");
    const selected = await click(input, "选择 /recent");
    expect(text(field(selected, "工作文件夹"))).toContain("/recent");
    expect(input.onCreate).not.toHaveBeenCalled();
  });
  it("navigates parent and children without choosing until the explicit confirmation", async () => {
    const input = { ...props(), onBrowseDirectory: vi.fn(async (path?: string) => ({ ...listing, path: path ?? "/work" })) };
    let tree = await click(input, "选择文件夹");
    expect(field(tree, "当前路径")).toBeUndefined();
    expect(elements(tree).some((element) => element.type === "input" && element.props.autoFocus)).toBe(false);
    tree = await click(input, "上级目录"); expect(input.onBrowseDirectory).toHaveBeenLastCalledWith("/");
    tree = await click(input, "打开 new"); expect(input.onBrowseDirectory).toHaveBeenLastCalledWith("/work/new");
    expect(input.onCreate).not.toHaveBeenCalled();
    tree = await click(input, "使用此文件夹"); expect(text(field(tree, "工作文件夹"))).toContain("/work/new");
  });
  it("requires an edited path to be opened successfully before confirming it", async () => {
    const input = { ...props(), onBrowseDirectory: vi.fn(async (path?: string) => ({ ...listing, path: path ?? "/work" })) };
    await click(input, "选择文件夹"); let tree = await click(input, "输入路径");
    expect(field(tree, "当前路径").props.autoFocus).toBe(true);
    change(tree, "当前路径", "/other"); tree = render(input);
    expect(button(tree, "使用此文件夹").props.disabled).toBe(true);
    submit(tree); render(input); await settle(); tree = render(input);
    expect(input.onBrowseDirectory).toHaveBeenLastCalledWith("/other");
    expect(button(tree, "使用此文件夹").props.disabled).toBe(false);
    expect(field(tree, "当前路径")).toBeUndefined();
  });
  it("retries a failed read at the same path and returns without losing the draft", async () => {
    const input = { ...props(snapshot([group])), initialProjectId: group.projectId, onBrowseDirectory: vi.fn().mockRejectedValueOnce(new Error("Permission denied")).mockResolvedValueOnce(listing) };
    change(render(input), "会话名称（可选）", "Keep title");
    await click(input, "选择文件夹"); let tree = await click(input, "浏览电脑");
    expect(text(tree)).toContain("Permission denied"); expect(button(tree, "使用此文件夹").props.disabled).toBe(true);
    await click(input, "重试"); expect(input.onBrowseDirectory).toHaveBeenCalledTimes(2);
    tree = await click(input, "返回新建会话");
    expect(text(field(tree, "工作文件夹"))).toContain(group.cwd);
    expect(field(tree, "会话名称（可选）").props.value).toBe("Keep title");
    expect(field(tree, "项目分组（可选）").props.value).toBe(group.projectId);
    expect(input.onClose).not.toHaveBeenCalled();
  });
  it("announces the selected directory as the folder control description", () => {
    const input = { ...props(snapshot([directory])), initialProjectId: directory.projectId };
    const tree = render(input);
    const trigger = button(tree, "选择文件夹");
    const description = elements(tree).find((element) => element.props.id === trigger.props["aria-describedby"]);
    expect(description).toBeDefined();
    expect(text(description)).toContain(directory.cwd);
  });
  it("keeps recent folders and path entry available alongside the desktop native chooser", async () => {
    const input = { ...props(snapshot([directory])), onChooseDirectory: vi.fn() };
    let tree = await click(input, "最近使用或输入路径");
    expect(button(tree, `选择 ${directory.cwd}`)).toBeDefined();
    tree = await click(input, "输入路径");
    change(tree, "当前路径", "/desktop/manual");
    tree = await click(input, "使用此文件夹");
    expect(text(field(tree, "工作文件夹"))).toContain("/desktop/manual");
    expect(input.onChooseDirectory).not.toHaveBeenCalled();
  });
  it("prefers the native desktop chooser and preserves selection on cancellation", async () => {
    const input = { ...props(snapshot([group])), initialProjectId: group.projectId, onChooseDirectory: vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce("/native/new"), onBrowseDirectory: vi.fn() };
    let tree = await click(input, "选择文件夹"); expect(text(field(tree, "工作文件夹"))).toContain(group.cwd);
    tree = await click(input, "选择文件夹"); expect(text(field(tree, "工作文件夹"))).toContain("/native/new");
    expect(input.onChooseDirectory).toHaveBeenNthCalledWith(1, group.cwd); expect(input.onBrowseDirectory).not.toHaveBeenCalled();
  });
  it("ignores an outstanding browse result after returning and switching runtime", async () => {
    let resolve!: (value: BridgeDirectoryListing) => void;
    const input = { ...props(), onBrowseDirectory: vi.fn(() => new Promise<BridgeDirectoryListing>((done) => { resolve = done; })) };
    await click(input, "选择文件夹"); await click(input, "取消选择");
    change(render(input), "运行时", "codex-desktop"); render(input); resolve(listing); await settle();
    const tree = await click(input, "选择文件夹");
    expect(button(tree, "使用此文件夹").props.disabled).toBe(true);
    expect(text(tree)).not.toContain("/recent"); expect(input.onClose).not.toHaveBeenCalled();
  });
  it.each(["escape", "backdrop", "mobile-back"])("returns one level on %s before closing the creation dialog", async (method) => {
    const workspaceBack = vi.fn(() => true); const remove = registerMobileBackHandler(workspaceBack, 100);
    const input = { ...props(), onBrowseDirectory: vi.fn().mockResolvedValue(listing) };
    try {
      const tree = await click(input, "选择文件夹");
      if (method === "escape") elements(tree)[0]!.props.onKeyDown({ key: "Escape", stopPropagation: vi.fn() });
      else if (method === "backdrop") { const target = {}; elements(tree)[0]!.props.onMouseDown({ target, currentTarget: target }); }
      else expect(dispatchMobileBack()).toBe(true);
      expect(field(render(input), "工作文件夹")).toBeDefined();
      expect(input.onClose).not.toHaveBeenCalled(); expect(workspaceBack).not.toHaveBeenCalled();
      dispatchMobileBack(); expect(input.onClose).toHaveBeenCalledOnce();
    } finally { remove(); }
  });
});

describe("creation contract", () => {
  it("uses one folder entry and supports a manually specified directory without history", async () => {
    const input = props();
    const form = render(input);
    expect(field(form, "工作文件夹").type).toBe("span");
    expect(field(form, "最近使用的文件夹")).toBeUndefined();
    const tree = await manual(input, " /work/new ");
    expect(text(field(tree, "工作文件夹"))).toContain("/work/new");
    submit(tree); await settle();
    expect(input.onCreate).toHaveBeenCalledWith("/work/new", undefined, "claude-desktop", undefined);
    expect(input.onCreated).toHaveBeenCalledWith(created);
    expect(input.onClose).toHaveBeenCalledOnce();
  });
  it("keeps folder, trimmed title and native group independent", async () => {
    const input = { ...props(snapshot([group])), initialProjectId: group.projectId };
    let tree = await manual(input, "/work/new");
    change(tree, "会话名称（可选）", " New task "); tree = render(input);
    expect(field(tree, "项目分组（可选）").props.value).toBe(group.projectId);
    submit(tree); await settle();
    expect(input.onCreate).toHaveBeenCalledWith("/work/new", "New task", "claude-desktop", group.projectId);
  });
  it("selecting a group does not fill or replace the work folder", () => {
    const input = props(snapshot([group]));
    change(render(input), "项目分组（可选）", group.projectId);
    expect(text(field(render(input), "工作文件夹"))).toContain("选择工作文件夹");
    expect(button(render(input), "创建会话").props.disabled).toBe(true);
  });
});
