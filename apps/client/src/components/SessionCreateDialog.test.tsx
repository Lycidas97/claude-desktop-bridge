import type { BridgeDirectoryListing, BridgeHostSnapshot, BridgeProjectInfo, BridgeSessionInfo } from "@bridge/protocol";
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchMobileBack, registerMobileBackHandler } from "../lib/mobile-back-navigation.js";
import { SessionCreateDialog, type SessionCreateDialogProps } from "./SessionCreateDialog.js";

// Match the existing client tests: exercise public form controls and effect
// cleanup without introducing a DOM test dependency.
const hooks = vi.hoisted(() => ({
  states: [] as unknown[],
  stateIndex: 0,
  effects: [] as Array<{ deps: unknown[] | undefined; cleanup: (() => void) | undefined }>,
  effectIndex: 0,
  pending: [] as Array<() => void>,
}));

vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useId: () => "session-create",
  useState(initial: unknown) {
    const index = hooks.stateIndex++;
    if (!(index in hooks.states)) hooks.states[index] = typeof initial === "function" ? initial() : initial;
    return [hooks.states[index], (next: unknown) => {
      hooks.states[index] = typeof next === "function" ? next(hooks.states[index]) : next;
    }];
  },
  useEffect(effect: () => (() => void) | void, deps?: unknown[]) {
    const index = hooks.effectIndex++;
    const previous = hooks.effects[index];
    if (previous && deps && deps.length === previous.deps?.length
      && deps.every((value, i) => Object.is(value, previous.deps?.[i]))) return;
    hooks.pending.push(() => {
      previous?.cleanup?.();
      hooks.effects[index] = { deps, cleanup: effect() || undefined };
    });
  },
}));

function render(props: SessionCreateDialogProps): ReactElement {
  hooks.stateIndex = 0;
  hooks.effectIndex = 0;
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
  if (node && typeof node === "object" && "props" in node) {
    return text((node as ReactElement<{ children?: ReactNode }>).props.children);
  }
  return "";
}

function field(tree: ReactElement, name: string): ReactElement<Record<string, any>> {
  return elements(tree).find((element) => element.props["aria-label"] === name)!;
}

function button(tree: ReactElement, name: string): ReactElement<Record<string, any>> {
  return elements(tree).find((element) => element.type === "button" && text(element.props.children).trim() === name)!;
}

function change(tree: ReactElement, name: string, value: string): void {
  field(tree, name).props.onChange({ target: { value } });
}

function submit(tree: ReactElement): void {
  elements(tree).find((element) => element.type === "form")!.props.onSubmit({ preventDefault: vi.fn() });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

beforeEach(() => {
  hooks.states = [];
  hooks.effects = [];
  hooks.pending = [];
});
afterEach(() => hooks.effects.forEach((effect) => effect.cleanup?.()));

const directory: BridgeProjectInfo = {
  projectId: "cwd-hash", name: "Existing folder", cwd: "/work/existing", kind: "directory", runtimeId: "claude-desktop",
  sessionCount: 1, runningCount: 0, pendingCount: 0, lastActivityAt: 1,
};
const group: BridgeProjectInfo = { ...directory, projectId: "desktop-group", name: "Research", kind: "desktop-group" };
const created = { sessionId: "created", cwd: "/work/new", projectId: "desktop-group" } as BridgeSessionInfo;

function snapshot(projects: BridgeProjectInfo[] = []): BridgeHostSnapshot {
  return {
    host: {
      hostId: "computer", name: "Work computer", pairingEpoch: 1, relayUrl: "ws://localhost:8788",
      online: true, lastSeenAt: 1, version: "1.1.2", capabilities: ["directory.browse.v1"],
    },
    projects, sessions: [], devices: [], permissions: [], latestSeq: 1,
    runtime: {
      state: "ready", detail: "", activeTurns: 0, maxParallelTurns: 1,
      desktopIntegration: { state: "ready", detail: "", enabled: true, canRestart: true },
    },
    runtimes: (["claude-desktop", "codex-desktop", "hermes-desktop"] as const).map((id) => ({
      id, name: id, state: id === "hermes-desktop" ? "unavailable" : "ready", detail: "",
      capabilities: id === "hermes-desktop" ? [] : ["session.create"],
      sessionIsolation: "independent", sessionCount: 0, updatedAt: 1,
    })),
  };
}

function props(host = snapshot()): SessionCreateDialogProps {
  return {
    snapshot: host, connected: true, onCreate: vi.fn().mockResolvedValue(created), onCreated: vi.fn(), onClose: vi.fn(),
  };
}

const listing: BridgeDirectoryListing = {
  path: "/work", parentPath: "/", directories: [{ name: "new", path: "/work/new" }], recentPaths: ["/recent"],
};

describe("SessionCreateDialog creation contract", () => {
  it("creates in a directly entered folder without any historical project", async () => {
    const input = props();
    let tree = render(input);
    expect(field(tree, "工作文件夹").props.value).toBe("");
    change(tree, "工作文件夹", "/work/new");
    tree = render(input);
    expect(button(tree, "创建会话").props.disabled).toBe(false);
    submit(tree);
    await settle();
    expect(input.onCreate).toHaveBeenCalledWith("/work/new", undefined, "claude-desktop", undefined);
    expect(input.onCreated).toHaveBeenCalledWith(created);
    expect(input.onClose).toHaveBeenCalledOnce();
  });

  it("keeps a selected native group when cwd changes and passes each value independently", async () => {
    const input = { ...props(snapshot([group])), initialProjectId: group.projectId };
    let tree = render(input);
    expect(field(tree, "工作文件夹").props.value).toBe(group.cwd);
    expect(field(tree, "项目分组（可选）").props.value).toBe(group.projectId);
    change(tree, "工作文件夹", "/work/new");
    tree = render(input);
    change(tree, "会话名称（可选）", "  New task  ");
    tree = render(input);
    expect(field(tree, "项目分组（可选）").props.value).toBe(group.projectId);
    submit(tree);
    await settle();
    expect(input.onCreate).toHaveBeenCalledWith("/work/new", "New task", "claude-desktop", group.projectId);
  });

  it("filters folders and groups by runtime and never falls back to another runtime's folder", async () => {
    const codexFolder = { ...directory, projectId: "codex-folder", cwd: "/codex", name: "Codex folder", runtimeId: "codex-desktop" as const };
    const input = { ...props(snapshot([group, directory, codexFolder])), initialProjectId: group.projectId };
    let tree = render(input);
    expect(text(tree)).not.toContain("Codex folder");
    change(tree, "运行时", "codex-desktop");
    tree = render(input);
    expect(field(tree, "工作文件夹").props.value).toBe("");
    expect(field(tree, "项目分组（可选）").props.value).toBe("");
    expect(text(tree)).not.toContain("Research");
    change(tree, "最近使用的文件夹", codexFolder.projectId);
    tree = render(input);
    submit(tree);
    await settle();
    expect(input.onCreate).toHaveBeenCalledWith("/codex", undefined, "codex-desktop", undefined);
  });

  it("leaves cwd empty on a runtime with no folders", () => {
    const input = props(snapshot([directory]));
    let tree = render(input);
    change(tree, "工作文件夹", "/typed");
    tree = render(input);
    change(tree, "运行时", "codex-desktop");
    tree = render(input);
    expect(field(tree, "工作文件夹").props.value).toBe("");
    expect(button(tree, "创建会话").props.disabled).toBe(true);
    expect(text(tree)).not.toContain("Existing folder");
  });

  it("uses auto-directory and untyped legacy projects only as cwd shortcuts", async () => {
    const legacy = { ...directory, projectId: "legacy", name: "Legacy folder" };
    delete legacy.kind;
    const input = { ...props(snapshot([directory, legacy])), initialProjectId: directory.projectId };
    let tree = render(input);
    expect(field(tree, "项目分组（可选）").props.value).toBe("");
    const options = elements(field(tree, "项目分组（可选）")).filter((element) => element.type === "option");
    expect(options).toHaveLength(1);
    submit(tree);
    await settle();
    expect(input.onCreate).toHaveBeenCalledWith(directory.cwd, undefined, "claude-desktop", undefined);
    change(tree, "最近使用的文件夹", legacy.projectId);
    tree = render(input);
    expect(field(tree, "工作文件夹").props.value).toBe(legacy.cwd);
  });

  it("does not apply an initial project from a different initial runtime", () => {
    const input = { ...props(snapshot([group])), initialProjectId: group.projectId, initialRuntimeId: "codex-desktop" as const };
    const tree = render(input);
    expect(field(tree, "运行时").props.value).toBe("codex-desktop");
    expect(field(tree, "工作文件夹").props.value).toBe("");
    expect(field(tree, "项目分组（可选）").props.value).toBe("");
  });

  it("preserves the path, title, and group after creation fails or returns no session", async () => {
    const input = { ...props(snapshot([group])), initialProjectId: group.projectId };
    vi.mocked(input.onCreate).mockRejectedValueOnce(new Error("Directory is not accessible")).mockResolvedValueOnce(undefined);
    let tree = render(input);
    change(tree, "工作文件夹", "/private/new");
    change(tree, "会话名称（可选）", "Keep this title");
    tree = render(input);
    submit(tree);
    await settle();
    tree = render(input);
    expect(text(tree)).toContain("Directory is not accessible");
    expect(field(tree, "工作文件夹").props.value).toBe("/private/new");
    expect(field(tree, "会话名称（可选）").props.value).toBe("Keep this title");
    expect(field(tree, "项目分组（可选）").props.value).toBe(group.projectId);
    submit(tree);
    await settle();
    tree = render(input);
    expect(elements(tree).some((element) => element.props.role === "alert")).toBe(true);
    expect(input.onCreated).not.toHaveBeenCalled();
    expect(input.onClose).not.toHaveBeenCalled();
  });

  it("disables offline creation and directory selection without discarding the form", () => {
    const input = { ...props(), onBrowseDirectory: vi.fn().mockResolvedValue(listing) };
    let tree = render(input);
    change(tree, "工作文件夹", "/work/new");
    tree = render(input);
    input.connected = false;
    tree = render(input);
    expect(field(tree, "工作文件夹").props.value).toBe("/work/new");
    expect(button(tree, "创建会话").props.disabled).toBe(true);
    expect(button(tree, "选择文件夹").props.disabled).toBe(true);
    expect(text(tree)).toContain("离线");
    submit(tree);
    expect(input.onCreate).not.toHaveBeenCalled();
    expect(input.onCreated).not.toHaveBeenCalled();
  });

  it("blocks creation for a runtime without creation capability", () => {
    const host = snapshot();
    host.runtimes![0]!.capabilities = ["session.list"];
    const input = props(host);
    let tree = render(input);
    change(tree, "工作文件夹", "/work/new");
    tree = render(input);
    expect(button(tree, "创建会话").props.disabled).toBe(true);
    submit(tree);
    expect(input.onCreate).not.toHaveBeenCalled();
  });
});

describe("host folder selection", () => {
  it("browses current, parent, subfolder, and recent paths, then chooses the shown folder", async () => {
    const input = {
      ...props(snapshot([group])), initialProjectId: group.projectId,
      onBrowseDirectory: vi.fn(async (path?: string) => ({ ...listing, path: path ?? "/work" })),
    };
    let tree = render(input);
    change(tree, "工作文件夹", "/work");
    tree = render(input);
    button(tree, "选择文件夹").props.onClick();
    render(input);
    await settle();
    tree = render(input);
    expect(input.onBrowseDirectory).toHaveBeenLastCalledWith("/work");
    expect(field(tree, "当前路径").props.value).toBe("/work");
    button(tree, "上级目录").props.onClick();
    render(input);
    await settle();
    tree = render(input);
    expect(input.onBrowseDirectory).toHaveBeenLastCalledWith("/");
    button(tree, "new").props.onClick();
    render(input);
    await settle();
    tree = render(input);
    expect(input.onBrowseDirectory).toHaveBeenLastCalledWith("/work/new");
    button(tree, "/recent").props.onClick();
    render(input);
    await settle();
    tree = render(input);
    expect(input.onBrowseDirectory).toHaveBeenLastCalledWith("/recent");
    change(tree, "当前路径", "/other");
    tree = render(input);
    button(tree, "打开").props.onClick();
    render(input);
    await settle();
    tree = render(input);
    expect(input.onBrowseDirectory).toHaveBeenLastCalledWith("/other");
    button(tree, "选择此文件夹").props.onClick();
    tree = render(input);
    expect(field(tree, "工作文件夹").props.value).toBe("/other");
    expect(field(tree, "项目分组（可选）").props.value).toBe(group.projectId);
  });

  it("requires a typed browser path to be opened before choosing it", async () => {
    const input = { ...props(), onBrowseDirectory: vi.fn().mockResolvedValue(listing) };
    let tree = render(input);
    button(tree, "选择文件夹").props.onClick();
    render(input);
    await settle();
    tree = render(input);
    expect(button(tree, "选择此文件夹").props.disabled).toBe(false);
    change(tree, "当前路径", "/another-folder");
    tree = render(input);
    expect(button(tree, "选择此文件夹").props.disabled).toBe(true);
    expect(button(tree, "打开").props.disabled).toBe(false);
  });

  it("keeps the creation form on browse errors and allows retrying the same path", async () => {
    const input = {
      ...props(snapshot([group])), initialProjectId: group.projectId,
      onBrowseDirectory: vi.fn().mockRejectedValueOnce(new Error("Permission denied")).mockResolvedValueOnce(listing),
    };
    let tree = render(input);
    change(tree, "工作文件夹", "/work");
    change(tree, "会话名称（可选）", "Keep title");
    tree = render(input);
    button(tree, "选择文件夹").props.onClick();
    render(input);
    await settle();
    tree = render(input);
    expect(text(tree)).toContain("Permission denied");
    expect(button(tree, "选择此文件夹").props.disabled).toBe(true);
    button(tree, "打开").props.onClick();
    render(input);
    await settle();
    tree = render(input);
    expect(input.onBrowseDirectory).toHaveBeenCalledTimes(2);
    button(tree, "返回").props.onClick();
    tree = render(input);
    expect(field(tree, "工作文件夹").props.value).toBe("/work");
    expect(field(tree, "会话名称（可选）").props.value).toBe("Keep title");
    expect(field(tree, "项目分组（可选）").props.value).toBe(group.projectId);
  });

  it("prefers the desktop native chooser and preserves the form when it is cancelled", async () => {
    const input = {
      ...props(snapshot([group])), initialProjectId: group.projectId,
      onChooseDirectory: vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce("/native/new"),
      onBrowseDirectory: vi.fn(),
    };
    let tree = render(input);
    button(tree, "选择文件夹").props.onClick();
    await settle();
    tree = render(input);
    expect(input.onChooseDirectory).toHaveBeenLastCalledWith(group.cwd);
    expect(field(tree, "工作文件夹").props.value).toBe(group.cwd);
    button(tree, "选择文件夹").props.onClick();
    await settle();
    tree = render(input);
    expect(field(tree, "工作文件夹").props.value).toBe("/native/new");
    expect(field(tree, "项目分组（可选）").props.value).toBe(group.projectId);
    expect(input.onBrowseDirectory).not.toHaveBeenCalled();
  });

  it("ignores a pending browse result after returning and switching runtime", async () => {
    let resolve!: (value: BridgeDirectoryListing) => void;
    const input = { ...props(), onBrowseDirectory: vi.fn(() => new Promise<BridgeDirectoryListing>((done) => { resolve = done; })) };
    let tree = render(input);
    button(tree, "选择文件夹").props.onClick();
    render(input);
    tree = render(input);
    button(tree, "返回").props.onClick();
    tree = render(input);
    change(tree, "运行时", "codex-desktop");
    tree = render(input);
    resolve(listing);
    await settle();
    tree = render(input);
    expect(field(tree, "工作文件夹").props.value).toBe("");
    button(tree, "选择文件夹").props.onClick();
    tree = render(input);
    expect(button(tree, "选择此文件夹").props.disabled).toBe(true);
    expect(text(tree)).not.toContain("/recent");
    expect(input.onCreated).not.toHaveBeenCalled();
  });

  it("gives the folder browser and dialog priority over workspace mobile back", () => {
    const workspaceBack = vi.fn(() => true);
    const removeWorkspace = registerMobileBackHandler(workspaceBack, 100);
    try {
      const input = { ...props(), onBrowseDirectory: vi.fn().mockResolvedValue(listing) };
      let tree = render(input);
      button(tree, "选择文件夹").props.onClick();
      render(input);
      expect(dispatchMobileBack()).toBe(true);
      tree = render(input);
      expect(field(tree, "工作文件夹")).toBeDefined();
      expect(input.onClose).not.toHaveBeenCalled();
      expect(workspaceBack).not.toHaveBeenCalled();
      dispatchMobileBack();
      expect(input.onClose).toHaveBeenCalledOnce();
    } finally {
      removeWorkspace();
    }
  });
});
