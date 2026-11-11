import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";
import { HostBrowser } from "./components/pairing/HostBrowser.js";
import { MobileAppShell } from "./components/mobile/MobileAppShell.js";
import { MobileHostDetails } from "./components/pairing/MobileHostDetails.js";
import { MobileSettings } from "./components/mobile/MobileSettings.js";
import { MobileWorkspace } from "./components/MobileWorkspace.js";
import { MediaPreviewProvider } from "./components/evidence/MediaPreviewProvider.js";
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
  tree = App() as ReactElement;
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
  it.each(["providers", "quota"])("returns from the %s subpage to settings, then the session directory", page => {
    tab("settings");
    component(MobileSettings)!.props[page].onOpen(); draw();
    expect(component(MobileSettings)).toBeUndefined();
    expect(back()).toBe(true);
    expect(component(MobileAppShell)!.props.tab).toBe("settings");
    expect(component(MobileSettings)).toBeDefined();
    const directoryRequest = component(MobileWorkspace)!.props.directoryRequest;
    expect(back()).toBe(true);
    expect(component(MobileAppShell)!.props.tab).toBe("sessions");
    expect(component(MobileWorkspace)!.props.directoryRequest).not.toBe(directoryRequest);
    expect(back()).toBe(false);
  });
  it("makes the sessions menu destination open the directory instead of a retained conversation", () => {
    const initial = component(MobileWorkspace)!.props.directoryRequest;
    tab("settings"); tab("sessions");
    expect(component(MobileWorkspace)!.props.directoryRequest).not.toBe(initial);
  });
  it("lets an unpaired start screen return to Android while keeping secure import in place", () => {
    hooks.mobile.state.hosts = []; hooks.mobile.state.activeHostId = undefined; draw();
    expect(back()).toBe(false);
    hooks.mobile.state.pairingSync = { stage: "syncing" }; draw();
    expect(back()).toBe(true);
  });
});
