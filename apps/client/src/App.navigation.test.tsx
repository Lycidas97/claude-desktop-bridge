import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";
import { HostBrowser } from "./components/pairing/HostBrowser.js";
import { MobileAppShell } from "./components/mobile/MobileAppShell.js";
import { MobileHostDetails } from "./components/pairing/MobileHostDetails.js";
import { MobileSettings } from "./components/mobile/MobileSettings.js";
import { MobileWorkspace } from "./components/MobileWorkspace.js";
import { MobileClientUpdateDialog } from "./components/updater/UpdaterSections.js";
import { MediaPreviewProvider } from "./components/evidence/MediaPreviewProvider.js";
import { AssistantPage } from "./components/assistant/AssistantPage.js";
import { ConversationDraftsProvider } from "./components/conversation/ConversationDraftsProvider.js";
import { dispatchMobileBack } from "./lib/mobile-back-navigation.js";

const hooks = vi.hoisted(() => ({
  slots: [] as any[], index: 0,
  effects: [] as Array<{ deps: unknown[] | undefined; cleanup: (() => void) | undefined }>,
  effectIndex: 0, pending: [] as Array<() => void>, mobile: {} as any,
}));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useState(initial: any) {
    const index = hooks.index++;
    if (!(index in hooks.slots)) hooks.slots[index] = typeof initial === "function" ? initial() : initial;
    return [hooks.slots[index], (value: any) => { hooks.slots[index] = typeof value === "function" ? value(hooks.slots[index]) : value; }];
  },
  useRef(current: unknown) {
    const index = hooks.index++;
    return hooks.slots[index] ??= { current };
  },
  useMemo: (create: () => unknown) => create(),
  useCallback: (callback: unknown) => callback,
  useEffect(effect: () => (() => void) | void, deps?: unknown[]) {
    const index = hooks.effectIndex++, previous = hooks.effects[index];
    if (previous && deps && deps.length === previous.deps?.length && deps.every((value, i) => Object.is(value, previous.deps?.[i]))) return;
    hooks.pending.push(() => { previous?.cleanup?.(); hooks.effects[index] = { deps, cleanup: effect() || undefined }; });
  },
}));
vi.mock("./hooks/useMobileBridge.js", () => ({ useMobileBridge: () => hooks.mobile }));
vi.mock("./hooks/useTheme.js", () => ({ useTheme: () => ({ theme: "light", family: "apple" }) }));
vi.mock("./lib/claude-snapshot.js", () => ({ claudeSnapshot: (snapshot: unknown) => snapshot }));

function elements(node: ReactNode): ReactElement<Record<string, any>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Record<string, any>>;
  return [element, ...elements(element.props.children)];
}
let tree: ReactElement;
function draw() {
  hooks.index = 0; hooks.effectIndex = 0;
  const mobileApp = App();
  tree = (mobileApp.type as (props: unknown) => ReactElement)(mobileApp.props);
  hooks.pending.splice(0).forEach(effect => effect());
}
function component(type: unknown) { return elements(tree).find(element => element.type === type); }
function tab(next: "sessions" | "computers" | "settings") { component(MobileAppShell)!.props.onTabChange(next); draw(); }
function back() { const handled = dispatchMobileBack(); draw(); return handled; }

beforeEach(() => {
  hooks.slots = []; hooks.effects = []; hooks.pending = [];
  vi.stubGlobal("window", {});
  hooks.mobile = {
    state: {
      activeHostId: "host", hosts: [{ roomId: "host", relayUrl: "ws://localhost" }], connection: "connected", desktopOnline: true,
      snapshot: { host: { capabilities: ["plugin.magpie-quota.v1"], relayUrl: "ws://localhost" }, sessions: [], runtime: {} },
      permissions: [], loading: false, histories: {}, evidence: {}, artifactPreviews: {}, artifactTransfers: {}, events: [], localTurns: [], pendingOutbound: 0,
    },
    requestMedia: vi.fn(), selectHost: vi.fn(),
  };
  draw();
});
afterEach(() => { hooks.effects.forEach(effect => effect.cleanup?.()); vi.unstubAllGlobals(); });

describe("unpaired client updates", () => {
  it.each(["pairing", "loading", "sync"])("mounts the update dialog on the %s route without paired hosts", route => {
    hooks.mobile.state.hosts = [];
    hooks.mobile.state.loading = route === "loading";
    hooks.mobile.state.pairingSync = route === "sync" ? { phase: "connecting" } : undefined;
    draw();
    expect(component(MobileClientUpdateDialog)).toBeDefined();
  });
});

describe("mobile file stat capability", () => {
  it.each([false, true])("uses explicit host support=%s for the same desktop version", supported => {
    hooks.mobile.state.snapshot.host.version = "1.3.1";
    hooks.mobile.state.snapshot.host.capabilities = supported ? ["artifact.transfer.stat.v1"] : ["artifact.transfer.v1"];
    draw();
    expect(component(MediaPreviewProvider)!.props.supportsFileStat).toBe(supported);
    hooks.mobile.state.snapshot = undefined; draw();
    expect(component(MediaPreviewProvider)!.props.supportsFileStat).toBe(false);
  });
});

describe("mobile app parent navigation", () => {
  it("wires Section creation only when the host declares support", () => {
    hooks.mobile.createSection = vi.fn();
    draw();
    expect(component(MobileWorkspace)!.props.onCreateSection).toBeUndefined();
    hooks.mobile.state.snapshot.host.capabilities.push("section.create.v1");
    draw();
    expect(component(MobileWorkspace)!.props.onCreateSection).toBe(hooks.mobile.createSection);
  });
  it("wires Section move and browse mkdir only when the host declares each capability", () => {
    hooks.mobile.moveSessionSection = vi.fn();
    hooks.mobile.createDirectory = vi.fn();
    draw();
    expect(component(MobileWorkspace)!.props.onMoveSessionSection).toBeUndefined();
    expect(component(MobileWorkspace)!.props.onCreateDirectory).toBeUndefined();
    hooks.mobile.state.snapshot.host.capabilities.push("section.move.v1", "directory.mkdir.v1");
    draw();
    expect(component(MobileWorkspace)!.props.onMoveSessionSection).toBe(hooks.mobile.moveSessionSection);
    expect(component(MobileWorkspace)!.props.onCreateDirectory).toBe(hooks.mobile.createDirectory);
  });
  it("wires Section rename and delete only when the host declares each capability", () => {
    hooks.mobile.renameSection = vi.fn();
    hooks.mobile.deleteSection = vi.fn();
    draw();
    expect(component(MobileWorkspace)!.props.onRenameSection).toBeUndefined();
    expect(component(MobileWorkspace)!.props.onDeleteSection).toBeUndefined();
    hooks.mobile.state.snapshot.host.capabilities.push("section.rename.v1", "section.delete.v1");
    draw();
    expect(component(MobileWorkspace)!.props.onRenameSection).toBe(hooks.mobile.renameSection);
    expect(component(MobileWorkspace)!.props.onDeleteSection).toBe(hooks.mobile.deleteSection);
  });
  it("releases back at the session directory so Android can leave the app", () => {
    expect(component(MobileAppShell)!.props.tab).toBe("sessions");
    expect(back()).toBe(false);
  });
  it("returns from computer details to the computer list before the session directory", () => {
    tab("computers");
    component(HostBrowser)!.props.onDetails("host"); draw();
    expect(component(MobileHostDetails)).toBeDefined();
    expect(back()).toBe(true);
    expect(component(MobileAppShell)!.props.tab).toBe("computers");
    expect(component(HostBrowser)).toBeDefined();
    expect(back()).toBe(true);
    expect(component(MobileAppShell)!.props.tab).toBe("sessions");
    expect(back()).toBe(false);
  });
  it.each(["providers", "quota"])("returns from the %s subpage to settings, then the active session canvas", page => {
    tab("settings");
    component(MobileSettings)!.props[page].onOpen(); draw();
    expect(component(MobileSettings)).toBeUndefined();
    expect(back()).toBe(true);
    expect(component(MobileAppShell)!.props.tab).toBe("settings");
    expect(component(MobileSettings)).toBeDefined();
    expect(back()).toBe(true);
    expect(component(MobileAppShell)!.props.tab).toBe("sessions");
    expect(back()).toBe(false);
  });
  it("passes paired hosts, quick host switcher callbacks, and tab navigation into MobileWorkspace", async () => {
    const workspace = component(MobileWorkspace)!;
    const initialDirReq = workspace.props.directoryRequest;
    expect(workspace.props.hosts).toBe(hooks.mobile.state.hosts);
    expect(typeof workspace.props.onSelectHost).toBe("function");
    expect(typeof workspace.props.onAddHost).toBe("function");
    expect(workspace.props.activeTab).toBe("sessions");
    workspace.props.onSelectTab("settings");
    draw();
    expect(component(MobileAppShell)!.props.tab).toBe("settings");
    await component(MobileWorkspace)!.props.onSelectHost("host");
    draw();
    expect(component(MobileAppShell)!.props.tab).toBe("sessions");
    expect(component(MobileWorkspace)!.props.directoryRequest).not.toBe(initialDirReq);
  });
  it("opens the previously pending session on another paired computer", async () => {
    hooks.mobile.state.hosts.push({
      roomId: "work-room", desktopName: "工作电脑", status: "attention", attentionSessionId: "pending-session",
    });
    tab("computers");
    const list = HostBrowser(component(HostBrowser)!.props as Parameters<typeof HostBrowser>[0]);
    const shortcut = elements(list).find(element => element.props.className === "host-attention-button");
    expect(shortcut?.props.children[0]).toBe("查看上次待处理");
    shortcut!.props.onClick();
    await Promise.resolve();
    draw();
    expect(hooks.mobile.selectHost).toHaveBeenCalledWith("work-room");
    expect(component(MobileWorkspace)?.props.focusRequest?.sessionId).toBe("pending-session");
  });
  it("opens active computer connection details directly from workspace inspection callback", () => {
    component(MobileWorkspace)!.props.onInspectConnection(); draw();
    expect(component(MobileAppShell)!.props.tab).toBe("computers");
    expect(component(MobileHostDetails)).toBeDefined();
    expect(back()).toBe(true);
    expect(component(HostBrowser)).toBeDefined();
  });
  it("lets an unpaired start screen return to Android while keeping secure import in place", () => {
    hooks.mobile.state.hosts = []; hooks.mobile.state.activeHostId = undefined; draw();
    expect(back()).toBe(false);
    hooks.mobile.state.pairingSync = { stage: "syncing" }; draw();
    expect(back()).toBe(true);
  });
  it.each(["list", "details"])("clears drafts and viewed mail when forgetting a computer from %s", async source => {
    hooks.mobile.forgetHost = vi.fn().mockResolvedValue(undefined);
    const removeItem = vi.fn();
    vi.stubGlobal("window", { localStorage: { removeItem } });
    tab("computers");
    const clearHost = vi.fn();
    component(ConversationDraftsProvider)!.props.controllerRef.clearHost = clearHost;
    if (source === "details") {
      component(HostBrowser)!.props.onDetails("host"); draw();
      await component(MobileHostDetails)!.props.onRemove();
    } else {
      await component(HostBrowser)!.props.onRemove("host");
    }
    expect(hooks.mobile.forgetHost).toHaveBeenCalledWith("host");
    expect(clearHost).toHaveBeenCalledWith("host");
    expect(removeItem).toHaveBeenCalledExactlyOnceWith("bridge-viewed-mail:host");
  });
  it("mounts sibling mobile tab pages for sessions and assistant without fixedSessionId coupling", () => {
    const tabPages = elements(tree).filter((element) => element.type === "div" && element.props.className === "mobile-tab-page");
    expect(tabPages).toHaveLength(2);
    expect(tabPages.map((page) => page.props.hidden)).toEqual([false, true]);
    expect(component(MobileWorkspace)!.props.visible).toBe(true);
    expect("fixedSessionId" in component(MobileWorkspace)!.props).toBe(false);
    expect(component(AssistantPage)!.props.active).toBe(false);
    expect(typeof component(AssistantPage)!.props.renderConversation).toBe("function");
    const beforeBackDirReq = component(MobileWorkspace)!.props.directoryRequest;
    component(MobileAppShell)!.props.onTabChange("assistant");
    draw();
    const switchedPages = elements(tree).filter((element) => element.type === "div" && element.props.className === "mobile-tab-page");
    expect(switchedPages.map((page) => page.props.hidden)).toEqual([true, false]);
    expect(component(MobileWorkspace)!.props.visible).toBe(false);
    expect(component(AssistantPage)!.props.active).toBe(true);
    component(MobileAppShell)!.props.onTabChange("sessions");
    draw();
    expect(component(MobileAppShell)!.props.tab).toBe("sessions");
    expect(component(MobileWorkspace)!.props.directoryRequest).toBe(beforeBackDirReq + 1);
  });
});
