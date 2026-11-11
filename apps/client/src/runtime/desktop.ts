import type {
  BridgeDesktopRuntimeId,
  BridgeMagpieConnectionInput,
  BridgeMagpieConnectionTestResult,
  BridgeEvent,
  BridgeRequest,
  BridgeResponse,
  DesktopControlSnapshot,
} from "@bridge/protocol";

export type { DesktopControlSnapshot };

export interface LocalBridgeRequest {
  method: BridgeRequest["method"];
  params?: Record<string, unknown>;
  idempotencyKey?: string;
}

export type ClaudeDesktopProfile = "Claude" | "Claude-3p";

export interface ClaudeDesktopDeveloperSettings {
  supported: boolean;
  profiles: Array<{ id: ClaudeDesktopProfile; path: string; accessRequired?: boolean }>;
  accessRequired?: boolean;
  profile?: ClaudeDesktopProfile;
  path?: string;
  enabled?: boolean;
  changed?: boolean;
}

export interface DesktopApi {
  checkClaudeDesktopDeveloperSettings(profile?: ClaudeDesktopProfile): Promise<ClaudeDesktopDeveloperSettings>;
  enableClaudeDesktopDeveloperSettings(profile: ClaudeDesktopProfile): Promise<ClaudeDesktopDeveloperSettings>;
  getSnapshot(): Promise<DesktopControlSnapshot>;
  chooseDirectory?(initialPath?: string): Promise<string | undefined>;
  createPairing(): Promise<DesktopControlSnapshot>;
  revokeDevice(deviceId: string): Promise<DesktopControlSnapshot>;
  setLaunchAtLogin(enabled: boolean): Promise<DesktopControlSnapshot>;
  setRelayUrl(url: string): Promise<DesktopControlSnapshot>;
  testMagpieConnection?(input: BridgeMagpieConnectionInput): Promise<BridgeMagpieConnectionTestResult>;
  saveMagpieConnection?(input: BridgeMagpieConnectionInput): Promise<DesktopControlSnapshot>;
  setAnthropicApiKey(value: string): Promise<DesktopControlSnapshot>;
  removeAnthropicApiKey(): Promise<DesktopControlSnapshot>;
  launchClaudeDesktop(): Promise<DesktopControlSnapshot>;
  quitClaudeDesktop(): Promise<DesktopControlSnapshot>;
  launchDesktopApp(runtimeId: BridgeDesktopRuntimeId): Promise<DesktopControlSnapshot>;
  quitDesktopApp(runtimeId: BridgeDesktopRuntimeId): Promise<DesktopControlSnapshot>;
  request(request: LocalBridgeRequest): Promise<BridgeResponse>;
  exportDiagnostics(): Promise<{ saved: boolean; path?: string }>;
  onSnapshot(listener: (snapshot: DesktopControlSnapshot) => void): () => void;
  onEvent(listener: (event: BridgeEvent) => void): () => void;
}

export type BridgeMethod = BridgeRequest["method"];
