import type { ReactElement, ReactNode } from "react";
import type { BridgeUpdaterSnapshot, DesktopApi, DesktopControlSnapshot } from "@bridge/protocol";
import { beforeEach, expect, it, vi } from "vitest";
import { GITHUB_RELEASES_PAGE_URL } from "../../lib/client-updater.js";
import {
  DesktopUpdaterSection,
  MobileClientUpdateDialog,
  MobileClientUpdaterSection,
  RemoteDesktopUpdaterSection,
  type ClientUpdaterHandle,
  type RemoteDesktopUpdateControl,
} from "./UpdaterSections.js";

const hooks = vi.hoisted(() => ({ slots: [] as unknown[], index: 0, deps: undefined as unknown[] | undefined }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState(initial: unknown) {
    const index = hooks.index++;
    if (!(index in hooks.slots)) hooks.slots[index] = initial;
    return [hooks.slots[index], (value: unknown) => { hooks.slots[index] = value; }];
  },
  useEffect(effect: () => void, deps: unknown[]) {
    if (!hooks.deps || deps.some((value, index) => value !== hooks.deps![index])) effect();
    hooks.deps = deps;
  },
}));
vi.mock("react-dom", () => ({ createPortal: (node: unknown) => node }));

function elements(node: ReactNode): ReactElement<Record<string, any>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Record<string, any>>;
  return [element, ...elements(element.props.children)];
}
function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join("");
  if (!node || typeof node === "boolean") return "";
  if (typeof node === "object" && "props" in node) return text((node as ReactElement<{ children?: ReactNode }>).props.children);
  return String(node);
}
function drawRemote(remote: RemoteDesktopUpdateControl) {
  hooks.index = 0;
  return RemoteDesktopUpdaterSection({ remote });
}

const baseUpdater: BridgeUpdaterSnapshot = {
  platform: "win32",
  arch: "x64",
  currentVersion: "1.3.4",
  channel: "stable",
  autoCheck: true,
  applyMode: "prompt",
  canAutoRestart: false,
  phase: "idle",
};

beforeEach(() => {
  hooks.slots = [];
  hooks.index = 0;
  hooks.deps = undefined;
});

it("renders DesktopUpdaterSection with browser-jump link when available and no silent-restart or duplicate links", () => {
  const api = { request: vi.fn(), getSnapshot: vi.fn() } as unknown as DesktopApi;
  const idleTree = DesktopUpdaterSection({
    snapshot: { updater: { ...baseUpdater, phase: "up-to-date" } } as unknown as DesktopControlSnapshot,
    api,
    onSnapshot: vi.fn(),
  });
  const idleLinks = elements(idleTree).filter((el) => el.type === "a");
  expect(idleLinks).toHaveLength(1);
  expect(text(idleLinks[0])).toContain("GitHub Releases");
  expect(idleLinks[0]!.props.href).toBe(GITHUB_RELEASES_PAGE_URL);
  expect(text(idleTree)).not.toContain("空闲静默重启");
  expect(text(idleTree)).not.toContain("下载完成后");

  hooks.index = 0;
  const availableTree = DesktopUpdaterSection({
    snapshot: {
      updater: {
        ...baseUpdater,
        phase: "available",
        latestVersion: "1.3.5",
        releaseUrl: "https://github.com/Lycidas97/claude-desktop-bridge/releases/tag/v1.3.5",
        releaseNotes: "- Release 1.3.5 notes",
      },
    } as unknown as DesktopControlSnapshot,
    api,
    onSnapshot: vi.fn(),
  });
  const availableLinks = elements(availableTree).filter((el) => el.type === "a");
  expect(availableLinks).toHaveLength(1);
  expect(availableLinks[0]!.props.className).toBe("primary-button");
  expect(availableLinks[0]!.props.href).toBe("https://github.com/Lycidas97/claude-desktop-bridge/releases/tag/v1.3.5");
  expect(availableLinks[0]!.props.target).toBe("_blank");
  expect(text(availableLinks[0])).toContain("前往下载 v1.3.5");
  expect(text(availableTree)).toContain("v1.3.5 更新说明");
});

it("keeps RemoteDesktopUpdaterSection strictly check-only with version, channel toggle, and single 检查更新 button", async () => {
  let reply!: (value: BridgeUpdaterSnapshot) => void;
  const onInvoke = vi.fn(() => new Promise<BridgeUpdaterSnapshot>((resolve) => { reply = resolve; }));
  const remote: RemoteDesktopUpdateControl = {
    hostVersion: "1.3.4",
    connected: true,
    supported: true,
    updater: { ...baseUpdater, phase: "idle" },
    onInvoke,
  };
  const initialTree = drawRemote(remote);
  const actionButtons = elements(initialTree)
    .filter((el) => el.type === "div" && String(el.props.className ?? "").includes("mobile-settings-actions"))
    .flatMap((div) => elements(div).filter((el) => el.type === "button"));
  expect(actionButtons.map((btn) => text(btn))).toEqual(["检查更新"]);
  expect(text(initialTree)).not.toContain("检查并升级");
  expect(text(initialTree)).not.toContain("检查并下载");
  expect(text(initialTree)).not.toContain("下载更新");
  expect(text(initialTree)).not.toContain("重启并升级");

  const channelGroup = elements(initialTree).find((el) => el.props["aria-label"] === "电脑端更新通道")!;
  const [stableBtn, prereleaseBtn] = elements(channelGroup).filter((el) => el.type === "button");
  stableBtn!.props.onClick();
  expect(onInvoke).not.toHaveBeenCalled();

  prereleaseBtn!.props.onClick();
  expect(onInvoke).toHaveBeenCalledExactlyOnceWith({ action: "check", channel: "prerelease" });

  const pushed = { ...remote, updater: { ...baseUpdater, phase: "available" as const, channel: "prerelease" as const, latestVersion: "1.3.5-rc.1" } };
  drawRemote(pushed);
  reply(baseUpdater);
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  const result = drawRemote(pushed);
  expect(text(result)).toContain("发现 v1.3.5-rc.1");
});

it("opens the GitHub release page from MobileClientUpdaterSection and MobileClientUpdateDialog", () => {
  const openReleasesPage = vi.fn(async () => {});
  const dismissPrompt = vi.fn();
  const handle = {
    state: {
      platform: "android",
      nativeSupported: true,
      currentVersion: "1.3.4",
      arch: "arm64",
      channel: "stable",
      autoCheck: true,
      phase: "available",
      latestVersion: "1.3.5",
      releaseUrl: "https://github.com/Lycidas97/claude-desktop-bridge/releases/tag/v1.3.5",
      releaseNotes: "- Release 1.3.5",
      promptOpen: true,
    },
    check: vi.fn(),
    setChannel: vi.fn(),
    setAutoCheck: vi.fn(),
    dismissPrompt,
    openPrompt: vi.fn(),
    openReleasesPage,
  } as unknown as ClientUpdaterHandle;

  const sectionTree = MobileClientUpdaterSection({ updater: handle });
  const downloadBtn = elements(sectionTree).find((el) => el.type === "button" && text(el).includes("前往下载 v1.3.5"))!;
  expect(downloadBtn).toBeDefined();
  downloadBtn.props.onClick();
  expect(openReleasesPage).toHaveBeenCalledOnce();

  vi.stubGlobal("document", { body: {} });
  try {
    hooks.index = 0;
    const dialogTree = MobileClientUpdateDialog({ updater: handle });
    const dialogJumpBtn = elements(dialogTree).find((el) => el.type === "button" && text(el).includes("前往发布页下载"))!;
    expect(dialogJumpBtn.props.disabled).toBe(false);
    dialogJumpBtn.props.onClick();
    expect(dismissPrompt).toHaveBeenCalledOnce();
    expect(openReleasesPage).toHaveBeenLastCalledWith("https://github.com/Lycidas97/claude-desktop-bridge/releases/tag/v1.3.5");
  } finally {
    vi.unstubAllGlobals();
  }
});
