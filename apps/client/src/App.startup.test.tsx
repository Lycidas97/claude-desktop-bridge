import { BridgeCrypto } from "@bridge/protocol";
import type { ReactElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "./App.js";
import { ConversationDraftsProvider } from "./components/conversation/ConversationDraftsProvider.js";
import * as artifactDownload from "./lib/artifact-download.js";
import { collectDiagnosticsStateSnapshot } from "./lib/diagnostics.js";
import * as mediaPreview from "./lib/media-preview.js";
import { bridgeVault, type StoredBridgeHost } from "./lib/vault.js";

const { effects, connect } = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  connect: vi.fn(),
}));
const cleanups: Array<() => void> = [];

vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => [typeof initial === "function" ? initial() : initial, () => undefined],
  useRef: (current: unknown) => ({ current }),
  useCallback: (callback: unknown) => callback,
  useMemo: (create: () => unknown) => create(),
  useEffect: (effect: () => void | (() => void)) => effects.push(effect),
}));
vi.mock("./hooks/useTheme.js", () => ({ useTheme: () => ({ theme: "light", family: "apple" }) }));
vi.mock("./lib/client-updater.js", () => ({ useClientUpdater: vi.fn() }));
vi.mock("./lib/vault.js", () => ({ bridgeVault: {
  listHosts: vi.fn(),
  getHost: vi.fn(),
  listMessages: vi.fn(async () => []),
  listOutbox: vi.fn(async () => []),
} }));

class ConnectingWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  readonly readyState = ConnectingWebSocket.CONNECTING;

  constructor(url: string) {
    super();
    connect(url);
  }

  close() { this.dispatchEvent(new Event("close")); }
}

// Mount the entry and its selected branch. Leaf UI providers own no bridge startup.
function mountApp() {
  let tree: ReactElement = App();
  while (typeof tree.type === "function" && tree.type !== ConversationDraftsProvider) {
    tree = (tree.type as (props: unknown) => ReactElement)(tree.props);
  }
  for (const effect of effects.splice(0)) {
    const cleanup = effect();
    if (cleanup) cleanups.push(cleanup);
  }
}

let network: EventTarget;
let host: StoredBridgeHost;

beforeEach(async () => {
  vi.clearAllMocks();
  const { crypto } = await BridgeCrypto.createHost("wss://test.example/ws", "Saved computer");
  const device = await BridgeCrypto.createDevicePairing({
    roomId: crypto.identity.roomId, hostId: crypto.identity.deviceId,
    desktopName: crypto.identity.desktopName, relayUrl: crypto.identity.relayUrl,
  });
  host = { ...device.pairing, crypto: await BridgeCrypto.fromPairing(device.pairing), updatedAt: 1, needsRepair: false };
  vi.mocked(bridgeVault.listHosts).mockResolvedValue([host]);
  vi.mocked(bridgeVault.getHost).mockResolvedValue(host);
  network = Object.assign(new EventTarget(), { type: "wifi" });
  vi.stubGlobal("navigator", { connection: network, onLine: true, userAgent: "Test browser" });
  vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() });
  vi.stubGlobal("WebSocket", ConnectingWebSocket);
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("uses desktop IPC without reading a restorable phone pairing, connecting or subscribing to network wake", async () => {
  const desktop = {
    getSnapshot: vi.fn(async () => ({ host: { hostId: "local-desktop" } })),
    onSnapshot: vi.fn(() => vi.fn()),
    onEvent: vi.fn(() => vi.fn()),
  };
  Object.assign(window, { bridgeDesktop: desktop });
  const subscribeNetwork = vi.spyOn(network, "addEventListener");

  mountApp();
  await new Promise<void>((resolve) => setImmediate(resolve));

  expect(desktop.getSnapshot).toHaveBeenCalledOnce();
  expect(desktop.onSnapshot).toHaveBeenCalledOnce();
  expect(desktop.onEvent).toHaveBeenCalledOnce();
  expect({
    vaultReads: vi.mocked(bridgeVault.listHosts).mock.calls.length,
    relayConnections: connect.mock.calls.length,
    networkListeners: subscribeNetwork.mock.calls.length,
  }).toEqual({ vaultReads: 0, relayConnections: 0, networkListeners: 0 });

  vi.spyOn(artifactDownload, "getActiveArtifactDownloadGauges").mockReturnValue({ activeCount: 1, cachedBytes: 512 });
  vi.spyOn(mediaPreview, "getActiveMediaTransferGauges").mockReturnValue({ activeCount: 2, cachedBytes: 1024 });

  expect(collectDiagnosticsStateSnapshot().bridgeState).toEqual({
    activeDownloads: 1,
    artifactTransfers: { count: 3, activeCount: 2, totalCachedBytes: 1536 },
  });
});

it("loads the saved pairing, opens a relay connection and reconnects on phone network wake", async () => {
  mountApp();

  await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
  expect(bridgeVault.listHosts).toHaveBeenCalledOnce();
  expect(connect).toHaveBeenCalledWith(host.relayUrl);
  window.dispatchEvent(new Event("online"));
  expect(connect).toHaveBeenCalledTimes(2);
});
