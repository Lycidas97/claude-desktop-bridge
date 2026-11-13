import type { BridgeDirectoryListing, BridgeHostSnapshot, BridgeProjectInfo, BridgeSessionInfo } from "@bridge/protocol";
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchMobileBack, registerMobileBackHandler } from "../../lib/mobile-back-navigation.js";
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
  it("offers only Claude folders and creates Claude without a runtime selector", async () => {
    const codex = { ...directory, projectId: "codex", cwd: "/codex", runtimeId: "codex-desktop" as const };
    const input = { ...props(snapshot([group, codex])), initialProjectId: group.projectId };
    expect(field(render(input), "运行时")).toBeUndefined();
    let tree = await click(input, "选择文件夹");
    expect(button(tree, "选择 /codex")).toBeUndefined();
    tree = await click(input, `选择 ${group.cwd}`); submit(tree); await settle();
    expect(input.onCreate).toHaveBeenCalledWith(group.cwd, undefined, "claude-desktop", group.projectId);
  });
  it("leaves the folder empty when only retired Agent history exists", () => {
    const codex = { ...directory, projectId: "codex", cwd: "/codex", runtimeId: "codex-desktop" as const };
    const input = props(snapshot([codex]));
    expect(button(render(input), "创建会话").props.disabled).toBe(true);
    expect(text(field(render(input), "工作文件夹"))).toContain("选择工作文件夹");
  });
  it("does not apply an initial project from a retired Agent", () => {
    const codex = { ...group, runtimeId: "codex-desktop" as const };
    const input = { ...props(snapshot([codex])), initialProjectId: codex.projectId };
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
  it("keeps an empty native Section selectable without an empty recent folder", async () => {
    const empty = { ...group, cwd: "", sessionCount: 0 };
    const input = props(snapshot([empty]));
    expect(text(field(render(input), "项目分组（可选）"))).toContain("Research");
    const tree = await click(input, "选择文件夹");
    expect(button(tree, "选择 ")).toBeUndefined();
    expect(text(tree)).toContain("还没有最近使用的文件夹");
  });
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
  it("ignores an outstanding browse result after returning to the form", async () => {
    let resolve!: (value: BridgeDirectoryListing) => void;
    const input = { ...props(), onBrowseDirectory: vi.fn(() => new Promise<BridgeDirectoryListing>((done) => { resolve = done; })) };
    await click(input, "选择文件夹"); await click(input, "取消选择");
    render(input); resolve(listing); await settle();
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

describe("strict browse-only directory creation", () => {
  it("never shows mkdir or creates a directory automatically in form or recent views", async () => {
    const onCreateDirectory = vi.fn();
    const input = { ...props(snapshot([group, directory])), initialProjectId: group.projectId, onBrowseDirectory: vi.fn().mockResolvedValue(listing), onCreateDirectory };
    let tree = render(input);
    expect(button(tree, "新建文件夹")).toBeUndefined();
    submit(tree); await settle();
    expect(onCreateDirectory).not.toHaveBeenCalled();
    expect(input.onCreate).toHaveBeenCalledWith(group.cwd, undefined, "claude-desktop", group.projectId);
    tree = await click(input, "选择文件夹");
    expect(button(tree, "新建文件夹")).toBeUndefined();
    expect(onCreateDirectory).not.toHaveBeenCalled();
  });

  it("hides mkdir on legacy hosts without onCreateDirectory and while editing manual paths", async () => {
    const legacy = { ...props(), onBrowseDirectory: vi.fn().mockResolvedValue(listing) };
    let tree = await click(legacy, "选择文件夹");
    expect(button(tree, "新建文件夹")).toBeUndefined();

    const capable = { ...legacy, onCreateDirectory: vi.fn().mockResolvedValue("/work/sub") };
    hooks.states = []; hooks.effects = []; hooks.pending = [];
    tree = await click(capable, "选择文件夹");
    expect(button(tree, "新建文件夹")).toBeDefined();
    tree = await click(capable, "输入路径");
    expect(button(tree, "新建文件夹")).toBeUndefined();
  });

  it("disables mkdir trigger when disconnected", async () => {
    const input = { ...props(), onBrowseDirectory: vi.fn().mockResolvedValue(listing), onCreateDirectory: vi.fn() };
    await click(input, "选择文件夹");
    input.connected = false;
    expect(button(render(input), "新建文件夹").props.disabled).toBe(true);
  });

  it.each([".", "..", "nested/dir", "nested\\dir", "a".repeat(256)])("rejects invalid single-level folder name %j before RPC", async (invalidName) => {
    const onCreateDirectory = vi.fn();
    const input = { ...props(), onBrowseDirectory: vi.fn().mockResolvedValue(listing), onCreateDirectory };
    await click(input, "选择文件夹");
    let tree = await click(input, "新建文件夹");
    change(tree, "新文件夹名称", invalidName);
    submit(render(input)); await settle();
    tree = render(input);
    expect(text(tree)).toContain("请输入合法的单层文件夹名称");
    expect(onCreateDirectory).not.toHaveBeenCalled();
  });

  it("creates a subdirectory on demand, refreshes into it, and closes only the mkdir box on back", async () => {
    const onBrowseDirectory = vi.fn(async (path?: string) => ({
      ...listing,
      path: path ?? "/work/杂活",
      parentPath: "/work",
      directories: path === "/work/杂活/colab-connect" ? [] : listing.directories,
    }));
    const onCreateDirectory = vi.fn().mockRejectedValueOnce(new Error("同名文件已存在")).mockResolvedValueOnce("/work/杂活/colab-connect");
    const input = { ...props(), onBrowseDirectory, onCreateDirectory };
    await click(input, "选择文件夹");
    let tree = await click(input, "新建文件夹");
    expect(dispatchMobileBack()).toBe(true);
    tree = render(input);
    expect(field(tree, "新文件夹名称")).toBeUndefined();
    expect(button(tree, "新建文件夹")).toBeDefined();

    tree = await click(input, "新建文件夹");
    change(tree, "新文件夹名称", "  colab-connect  ");
    submit(render(input)); await settle();
    tree = render(input);
    expect(text(tree)).toContain("同名文件已存在");
    expect(button(tree, "创建并进入").props.type).toBe("submit");

    submit(render(input)); await settle(); render(input); await settle();
    tree = render(input);
    expect(onCreateDirectory).toHaveBeenLastCalledWith("/work/杂活", "colab-connect");
    expect(onBrowseDirectory).toHaveBeenLastCalledWith("/work/杂活/colab-connect");
    expect(field(tree, "新文件夹名称")).toBeUndefined();
    expect(button(tree, "使用此文件夹").props.disabled).toBe(false);
    tree = await click(input, "使用此文件夹");
    expect(text(field(tree, "工作文件夹"))).toContain("/work/杂活/colab-connect");
    expect(input.onCreate).not.toHaveBeenCalled();
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
  it("keys primary footer buttons distinctly so confirming a folder never mutates into a submit button mid-click", async () => {
    const input = { ...props(snapshot([directory])), onBrowseDirectory: vi.fn().mockResolvedValue({ path: "/work/existing", directories: [] }) };
    expect(button(render(input), "创建会话").key).toBe("create-session");
    const recentTree = await click(input, "选择文件夹");
    expect(button(recentTree, "浏览电脑文件夹").key).toBe("open-browse");
    const browseTree = await click(input, "浏览电脑文件夹");
    expect(button(browseTree, "使用此文件夹").key).toBe("use-folder");
  });

  it.each(["D:\\PARA", "/work/untrusted"])("confirms workspace trust and retries with trustWorkspace=true when capability is advertised (%s)", async (targetCwd) => {
    const host = snapshot([group]);
    host.host.capabilities.push("workspace.trust.v1");
    host.runtimes![0]!.capabilities.push("workspace.trust");
    const onCreate = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("此文件夹首次在 Claude Desktop 中使用，需要确认信任后才能创建会话。"), { code: "WORKSPACE_TRUST_REQUIRED" }))
      .mockResolvedValueOnce({ ...created, cwd: targetCwd });
    const input = { ...props(host), initialProjectId: group.projectId, onCreate };

    let tree = await manual(input, targetCwd);
    change(tree, "会话名称（可选）", "Trust check");
    submit(render(input)); await settle();
    tree = render(input);

    expect(onCreate).toHaveBeenNthCalledWith(1, targetCwd, "Trust check", "claude-desktop", group.projectId);
    expect(text(tree)).toContain(`是否信任并允许 Claude 访问「${targetCwd}」`);
    expect(text(tree)).not.toContain("$eipc_message$");
    expect(button(tree, "信任并创建")).toBeDefined();
    expect(input.onClose).not.toHaveBeenCalled();

    submit(tree); await settle();
    expect(onCreate).toHaveBeenNthCalledWith(2, targetCwd, "Trust check", "claude-desktop", group.projectId, true);
    expect(input.onCreated).toHaveBeenCalledWith({ ...created, cwd: targetCwd });
    expect(input.onClose).toHaveBeenCalledOnce();
  });

  it.each([
    ["manual code", { code: "WORKSPACE_TRUST_MANUAL_REQUIRED", message: "请在电脑端 Claude 窗口打开并信任此文件夹后重试。" }, true],
    ["legacy raw eipc", { message: "Error invoking remote method '$eipc_message$abc_$_claude.web_$_LocalSessions_$_start': WorkspaceTrustError: Workspace requires trust approval before starting a session. [ccdErrorCategory:trust_required]" }, false],
  ])("falls back to manual desktop guidance and one-click retry without trustWorkspace (%s)", async (_caseName, errSpec, advertiseCapability) => {
    const host = snapshot();
    if (advertiseCapability) {
      host.host.capabilities.push("workspace.trust.v1");
      host.runtimes![0]!.capabilities.push("workspace.trust");
    }
    const onCreate = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error(errSpec.message), "code" in errSpec ? { code: errSpec.code } : {}))
      .mockResolvedValueOnce({ ...created, cwd: "D:\\PARA" });
    const input = { ...props(host), onCreate };

    let tree = await manual(input, "D:\\PARA");
    submit(tree); await settle();
    tree = render(input);

    expect(text(tree)).toContain("请在电脑端 Claude 窗口打开并信任「D:\\PARA」后重试。");
    expect(text(tree)).not.toContain("$eipc_message$");
    expect(button(tree, "重试创建")).toBeDefined();

    submit(tree); await settle();
    expect(onCreate).toHaveBeenNthCalledWith(2, "D:\\PARA", undefined, "claude-desktop", undefined);
    expect(input.onCreated).toHaveBeenCalledOnce();
  });

  it("clears workspace trust prompt when choosing another folder", async () => {
    const host = snapshot([directory]);
    host.host.capabilities.push("workspace.trust.v1");
    host.runtimes![0]!.capabilities.push("workspace.trust");
    const onCreate = vi.fn().mockRejectedValueOnce(Object.assign(new Error("需要确认信任"), { code: "WORKSPACE_TRUST_REQUIRED" }));
    const input = { ...props(host), onCreate };

    let tree = await manual(input, "D:\\PARA");
    submit(tree); await settle();
    expect(button(render(input), "信任并创建")).toBeDefined();

    await click(input, "选择文件夹");
    tree = await click(input, `选择 ${directory.cwd}`);
    expect(button(tree, "创建会话")).toBeDefined();
    expect(text(tree)).not.toContain("是否信任并允许 Claude 访问");
  });
});
