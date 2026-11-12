import type { BridgeHostSnapshot, BridgeProjectInfo, BridgeSessionInfo } from "@bridge/protocol";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchMobileBack } from "../../lib/mobile-back-navigation.js";
import { SectionManageDialog, useSectionManage } from "./SectionManageDialog.js";

const hooks = vi.hoisted(() => ({
  slots: [] as any[],
  index: 0,
  effects: [] as Array<{ deps: unknown[] | undefined; cleanup: (() => void) | undefined }>,
  effectIndex: 0,
  pending: [] as Array<() => void>,
  storage: new Map<string, string>(),
}));

vi.mock("react-dom", async (original) => ({
  ...await original<typeof import("react-dom")>(),
  createPortal: (node: unknown) => node,
}));

vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useId: () => "section-manage-id",
  useState(initial: any) {
    const index = hooks.index++;
    if (!(index in hooks.slots)) {
      hooks.slots[index] = typeof initial === "function" ? initial() : initial;
    }
    return [
      hooks.slots[index],
      (value: any) => {
        hooks.slots[index] = typeof value === "function" ? value(hooks.slots[index]) : value;
      },
    ];
  },
  useEffect(effect: () => (() => void) | void, deps?: unknown[]) {
    const index = hooks.effectIndex++;
    const previous = hooks.effects[index];
    if (
      previous
      && deps
      && deps.length === previous.deps?.length
      && deps.every((value, i) => Object.is(value, previous.deps?.[i]))
    ) {
      return;
    }
    hooks.pending.push(() => {
      previous?.cleanup?.();
      hooks.effects[index] = { deps, cleanup: effect() || undefined };
    });
  },
}));

function elements(node: ReactNode): ReactElement<Record<string, any>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Record<string, any>>;
  const rendered = typeof element.type === "function" ? (element.type as any)(element.props) : element.props.children;
  return [element, ...elements(rendered)];
}

function makeProject(overrides: Partial<BridgeProjectInfo> & { projectId: string; name: string }): BridgeProjectInfo {
  return {
    cwd: "",
    kind: "desktop-group",
    sessionCount: 0,
    runningCount: 0,
    pendingCount: 0,
    lastActivityAt: 0,
    ...overrides,
  };
}

function makeSession(overrides: Partial<BridgeSessionInfo> & { sessionId: string; projectId: string }): BridgeSessionInfo {
  return {
    projectName: "Group",
    cwd: "/work/repo",
    title: "Session",
    source: "desktop",
    ownership: "DESKTOP_NATIVE_IDLE",
    transport: "claude-desktop-native",
    turnState: "idle",
    lastActivityAt: 10,
    pendingCount: 0,
    ...overrides,
  };
}

describe("SectionManageDialog and useSectionManage", () => {
  let snapshot: BridgeHostSnapshot;
  let onRenameSection: ReturnType<typeof vi.fn>;
  let onDeleteSection: ReturnType<typeof vi.fn>;
  let connection: "connected" | "closed";
  let desktopOnline: boolean;

  function renderController() {
    hooks.index = 0;
    hooks.effectIndex = 0;
    const controller = useSectionManage({
      activeHostId: "host-1",
      desktopName: "Mac Studio",
      snapshot,
      connection,
      desktopOnline,
      onRenameSection,
      onDeleteSection,
    });
    hooks.pending.splice(0).forEach((run) => run());
    return controller;
  }

  beforeEach(() => {
    hooks.slots = [];
    hooks.effects = [];
    hooks.pending = [];
    hooks.storage = new Map();
    vi.stubGlobal("document", { body: {} });
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => hooks.storage.get(key) ?? null,
      setItem: (key: string, value: string) => { hooks.storage.set(key, value); },
      removeItem: (key: string) => { hooks.storage.delete(key); },
    });
    connection = "connected";
    desktopOnline = true;
    onRenameSection = vi.fn().mockResolvedValue({});
    onDeleteSection = vi.fn().mockResolvedValue({});
    snapshot = {
      host: {
        hostId: "host-1",
        pairingEpoch: 1,
        name: "Mac Studio",
        relayUrl: "ws://127.0.0.1/ws",
        online: true,
        lastSeenAt: 1,
        version: "1.3.2",
        capabilities: ["section.rename.v1", "section.delete.v1"],
      },
      runtime: {
        state: "ready",
        detail: "Ready",
        activeTurns: 0,
        maxParallelTurns: 4,
        desktopIntegration: {
          state: "ready",
          detail: "Ready",
          enabled: true,
          canRestart: true,
        },
      },
      devices: [],
      permissions: [],
      latestSeq: 0,
      projects: [
        makeProject({ projectId: "section:empty", name: "空分组", sessionCount: 0 }),
        makeProject({ projectId: "section:busy", name: "进行中", sessionCount: 2 }),
        makeProject({ projectId: "folder:repo", name: "repo", kind: "directory", cwd: "/work/repo", sessionCount: 1 }),
      ],
      sessions: [
        makeSession({ sessionId: "s-1", projectId: "section:busy" }),
        makeSession({ sessionId: "s-2", projectId: "section:busy" }),
        makeSession({ sessionId: "s-3", projectId: "folder:repo" }),
      ],
    };
  });

  afterEach(() => {
    hooks.effects.forEach((effect) => effect.cleanup?.());
    vi.unstubAllGlobals();
  });

  it("allows managing only custom desktop-group sections when host capabilities are present", () => {
    const controller = renderController();
    expect(controller.canManage(snapshot.projects[0])).toBe(true);
    expect(controller.canManage(snapshot.projects[2])).toBe(false);

    snapshot.host.capabilities = [];
    const disabled = renderController();
    expect(disabled.canManage(snapshot.projects[0])).toBe(false);
  });

  it("deletes an empty section in one tap without opening ConfirmationDialog", async () => {
    let controller = renderController();
    controller.openMenu("section:empty");
    controller = renderController();

    const tree = <SectionManageDialog controller={controller} />;
    const html = renderToStaticMarkup(tree);
    expect(html).toContain("重命名分组");
    expect(html).toContain("删除空分组");

    const deleteBtn = elements(tree).find(
      (el) => el.type === "button" && renderToStaticMarkup(el).includes("删除空分组"),
    )!;
    deleteBtn.props.onClick();
    await vi.waitFor(() => expect(onDeleteSection).toHaveBeenCalledWith("section:empty"));
    controller = renderController();
    expect(controller.state).toBeUndefined();
  });

  it("requires confirmation before deleting a non-empty section and intercepts mobile back", async () => {
    let controller = renderController();
    controller.openMenu("section:busy");
    controller = renderController();

    const sheetTree = <SectionManageDialog controller={controller} />;
    const deleteBtn = elements(sheetTree).find(
      (el) => el.type === "button" && renderToStaticMarkup(el).includes("删除分组"),
    )!;
    deleteBtn.props.onClick();
    controller = renderController();
    expect(onDeleteSection).not.toHaveBeenCalled();

    const confirmHtml = renderToStaticMarkup(<SectionManageDialog controller={controller} />);
    expect(confirmHtml).toContain("删除「进行中」分组？组内 2 个会话不会删除，将移回各自的项目目录。");

    expect(dispatchMobileBack()).toBe(true);
    controller = renderController();
    expect(controller.state).toBeUndefined();

    controller.openMenu("section:busy");
    controller = renderController();
    controller.startConfirmDelete();
    controller = renderController();
    await controller.runDelete();
    expect(onDeleteSection).toHaveBeenCalledWith("section:busy");
    controller = renderController();
    expect(controller.state).toBeUndefined();
  });

  it.each(["connection", "desktop"] as const)("disables deletion after %s disconnect while keeping feedback and cancellation", (disconnected) => {
    let controller = renderController();
    controller.openMenu("section:busy");
    controller = renderController();
    controller.startConfirmDelete();
    controller = renderController();
    const buttons = () => elements(<SectionManageDialog controller={controller} />)
      .filter((element) => element.type === "button");
    expect(buttons().find((button) => button.props.children === "删除分组")!.props.disabled).toBe(false);

    if (disconnected === "connection") connection = "closed";
    else desktopOnline = false;
    controller = renderController();
    expect(buttons().find((button) => button.props.children === "删除分组")!.props.disabled).toBe(true);
    expect(renderToStaticMarkup(<SectionManageDialog controller={controller} />)).toContain("电脑已离线，连接后可删除分组。");
    expect(onDeleteSection).not.toHaveBeenCalled();

    connection = "connected";
    desktopOnline = true;
    controller = renderController();
    expect(buttons().find((button) => button.props.children === "删除分组")!.props.disabled).toBe(false);

    desktopOnline = false;
    controller = renderController();
    const cancel = buttons().find((button) => button.props.children === "取消")!;
    expect(cancel.props.disabled).toBe(false);
    cancel.props.onClick();
    expect(renderController().state).toBeUndefined();
  });

  it("trims section names on rename, skips unchanged names, and surfaces rename errors", async () => {
    let controller = renderController();
    controller.openMenu("section:empty");
    controller = renderController();
    controller.startRename();
    controller = renderController();

    await controller.submitRename();
    expect(onRenameSection).not.toHaveBeenCalled();
    controller = renderController();
    expect(controller.state).toBeUndefined();

    onRenameSection.mockRejectedValueOnce(new Error("Section 名称已存在"));
    controller.openMenu("section:empty");
    controller = renderController();
    controller.startRename();
    controller = renderController();
    controller.updateName("  归档整理  ");
    controller = renderController();
    await controller.submitRename();
    expect(onRenameSection).toHaveBeenCalledWith("section:empty", "归档整理");
    controller = renderController();
    expect(renderToStaticMarkup(<SectionManageDialog controller={controller} />)).toContain("Section 名称已存在");
  });

  it("persists hideEmptySections per host, keeps search visible, and reveals on new section creation", () => {
    let controller = renderController();
    expect(controller.hideEmptySections).toBe(false);
    expect(controller.emptySectionCount).toBe(1);
    expect(controller.shouldHideEmpty(snapshot.projects[0], 0, "")).toBe(false);

    controller.toggleHideEmptySections();
    controller = renderController();
    expect(controller.hideEmptySections).toBe(true);
    expect(hooks.storage.get("bridge-hide-empty-sections:host-1")).toBe("1");
    expect(controller.shouldHideEmpty(snapshot.projects[0], 0, "")).toBe(true);
    expect(controller.shouldHideEmpty(snapshot.projects[0], 0, "空分")).toBe(false);
    expect(controller.shouldHideEmpty(snapshot.projects[1], 2, "")).toBe(false);
    expect(controller.shouldHideEmpty(snapshot.projects[2], 0, "")).toBe(false);

    const menuHtml = renderToStaticMarkup(
      <div>{controller.renderDirectoryActions({ activeGroupProject: undefined, closeDirectoryMenu: () => undefined })}</div>,
    );
    expect(menuHtml).toContain("显示空分组（1）");

    controller.revealEmptySections();
    controller = renderController();
    expect(controller.hideEmptySections).toBe(false);
    expect(hooks.storage.has("bridge-hide-empty-sections:host-1")).toBe(false);
  });
});
