import { contextBridge, ipcRenderer } from "electron";
import type { BridgeEvent, BridgeResponse, DesktopControlSnapshot, LocalBridgeRequest } from "@bridge/protocol";

contextBridge.exposeInMainWorld("bridgeDesktop", {
  getSnapshot: () => ipcRenderer.invoke("bridge:get-snapshot") as Promise<DesktopControlSnapshot>,
  createPairing: () => ipcRenderer.invoke("bridge:create-pairing") as Promise<DesktopControlSnapshot>,
  chooseDirectory: (initialPath?: string) => (
    ipcRenderer.invoke("bridge:choose-directory", initialPath) as Promise<string | undefined>
  ),
  revokeDevice: (deviceId: string) => (
    ipcRenderer.invoke("bridge:revoke-device", deviceId) as Promise<DesktopControlSnapshot>
  ),
  setRelayUrl: (url: string) => (
    ipcRenderer.invoke("bridge:set-relay-url", url) as Promise<DesktopControlSnapshot>
  ),
  setLaunchAtLogin: (enabled: boolean) => (
    ipcRenderer.invoke("bridge:set-launch-at-login", enabled) as Promise<DesktopControlSnapshot>
  ),
  testMagpieConnection: (input: unknown) => ipcRenderer.invoke("bridge:test-magpie-connection", input),
  saveMagpieConnection: (input: unknown) => ipcRenderer.invoke("bridge:save-magpie-connection", input),
  setAnthropicApiKey: (value: string) => (
    ipcRenderer.invoke("bridge:set-anthropic-api-key", value) as Promise<DesktopControlSnapshot>
  ),
  removeAnthropicApiKey: () => (
    ipcRenderer.invoke("bridge:remove-anthropic-api-key") as Promise<DesktopControlSnapshot>
  ),
  launchClaudeDesktop: () => (
    ipcRenderer.invoke("bridge:launch-claude-desktop") as Promise<DesktopControlSnapshot>
  ),
  quitClaudeDesktop: () => (
    ipcRenderer.invoke("bridge:quit-claude-desktop") as Promise<DesktopControlSnapshot>
  ),
  launchDesktopApp: (runtimeId: string) => (
    ipcRenderer.invoke("bridge:launch-desktop-app", runtimeId) as Promise<DesktopControlSnapshot>
  ),
  quitDesktopApp: (runtimeId: string) => (
    ipcRenderer.invoke("bridge:quit-desktop-app", runtimeId) as Promise<DesktopControlSnapshot>
  ),
  request: (request: LocalBridgeRequest) => (
    ipcRenderer.invoke("bridge:request", request) as Promise<BridgeResponse>
  ),
  checkClaudeDesktopDeveloperSettings: (profile?: string) => (
    ipcRenderer.invoke("bridge:check-claude-developer-settings", profile)
  ),
  enableClaudeDesktopDeveloperSettings: (profile: string) => (
    ipcRenderer.invoke("bridge:enable-claude-developer-settings", profile)
  ),
  exportDiagnostics: () => (
    ipcRenderer.invoke("bridge:export-diagnostics") as Promise<{ saved: boolean; path?: string }>
  ),
  onSnapshot: (listener: (snapshot: DesktopControlSnapshot) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: DesktopControlSnapshot) => listener(snapshot);
    ipcRenderer.on("bridge:snapshot", handler);
    return () => ipcRenderer.off("bridge:snapshot", handler);
  },
  onEvent: (listener: (event: BridgeEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, event: BridgeEvent) => listener(event);
    ipcRenderer.on("bridge:event", handler);
    return () => ipcRenderer.off("bridge:event", handler);
  },
});
