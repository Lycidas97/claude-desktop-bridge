import type { ReactElement, ReactNode } from "react";
import type { BridgeUpdaterSnapshot } from "@bridge/protocol";
import { beforeEach, expect, it, vi } from "vitest";
import { MobileClientUpdateDialog, RemoteDesktopUpdaterSection, type RemoteDesktopUpdateControl } from "./UpdaterSections.js";

const hooks = vi.hoisted(() => ({ slots: [] as unknown[], index: 0, deps: undefined as unknown[] | undefined }));
vi.mock("react", async original => ({
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
function draw(remote: RemoteDesktopUpdateControl) {
  hooks.index = 0;
  return RemoteDesktopUpdaterSection({ remote });
}
const snapshot: BridgeUpdaterSnapshot = {
  platform: "win32", arch: "x64", currentVersion: "1.3.2", channel: "stable", autoCheck: true,
  applyMode: "prompt", canAutoRestart: true, phase: "downloading", downloadedBytes: 0, totalBytes: 512,
};
beforeEach(() => { hooks.slots = []; hooks.index = 0; hooks.deps = undefined; });

it("keeps a newer ready host push when an older downloading RPC resolves later", async () => {
  let reply!: (value: BridgeUpdaterSnapshot) => void;
  const remote: RemoteDesktopUpdateControl = {
    hostVersion: "1.3.2", connected: true, supported: true, updater: { ...snapshot, phase: "idle" },
    onInvoke: vi.fn(() => new Promise<BridgeUpdaterSnapshot>(resolve => { reply = resolve; })),
  };
  const button = elements(draw(remote)).find(element => element.type === "button" && text(element).includes("检查更新"))!;
  button.props.onClick();
  const pushed = { ...remote, updater: { ...snapshot, phase: "ready" as const, latestVersion: "1.3.3" } };
  draw(pushed);
  reply(snapshot);
  await new Promise<void>(resolve => queueMicrotask(resolve));
  const result = draw(pushed);
  expect(text(result)).toContain("已就绪 v1.3.3");
  expect(text(result)).not.toContain("正在下载");
  expect(elements(result).find(element => element.type === "button" && text(element).includes("重启升级"))?.props.disabled).toBe(false);
});

it("uses the shared byte formatter for sub-kilobyte progress", () => {
  const tree = draw({ hostVersion: "1.3.2", connected: true, supported: true, updater: snapshot, onInvoke: vi.fn() });
  const progress = elements(tree).find(element => typeof element.type === "function" && element.type.name === "ProgressBar")!;
  const rendered = (progress.type as (props: unknown) => ReactNode)(progress.props);
  expect(text(rendered)).toContain("0 B / 512 B");
});

it("disables the APK action while a channel check is still pending", () => {
  vi.stubGlobal("document", { body: {} });
  try {
    const tree = MobileClientUpdateDialog({ updater: {
      state: { nativeSupported: true, promptOpen: true, latestVersion: "1.4.0-rc.1", currentVersion: "1.3.2", phase: "checking", assetName: "Bridge.apk" },
      dismissPrompt: vi.fn(), downloadAndInstall: vi.fn(),
    } as unknown as Parameters<typeof MobileClientUpdateDialog>[0]["updater"] });
    const button = elements(tree).find(element => element.type === "button" && text(element).includes("下载并安装"))!;
    expect(button.props.disabled).toBe(true);
  } finally { vi.unstubAllGlobals(); }
});
