import { DesktopController } from "./controller.js";

type ControllerArguments = ConstructorParameters<typeof DesktopController>;
type Stub<T> = Partial<Record<keyof T, unknown>>;
type Dependencies = {
  app?: Stub<ControllerArguments[0]>;
  repository?: Stub<ControllerArguments[1]>;
  pairingBaseUrl?: string;
  relayConnectUrl?: string;
  broker?: Stub<ControllerArguments[4]>;
  eventLog?: Stub<ControllerArguments[5]>;
  evidence?: Stub<ControllerArguments[6]>;
  claudeDesktop?: Stub<ControllerArguments[7]>;
  RTCPeerConnectionImpl?: unknown;
  desktopAppControls?: ReadonlyMap<string, Stub<ControllerArguments[7]>>;
  conversationState?: Stub<NonNullable<ControllerArguments[10]>> | undefined;
  updater?: ControllerArguments[11];
  memoryRecorder?: ControllerArguments[12];
};

type Internals = {
  allProjects: DesktopController["allProjects"];
  allSessions: DesktopController["allSessions"];
  broadcast: DesktopController["broadcast"];
  deviceCryptos: DesktopController["deviceCryptos"];
  deflateDevices: DesktopController["deflateDevices"];
  handleRequest: DesktopController["handleRequest"];
  lastPublishedSessions: DesktopController["lastPublishedSessions"];
  onlineDevices: DesktopController["onlineDevices"];
  publish: DesktopController["publish"];
  publishPermissions: DesktopController["publishPermissions"];
  publishTimer: DesktopController["publishTimer"];
  receiveMessage: DesktopController["receiveMessage"];
  rejectUnknownDevice: DesktopController["rejectUnknownDevice"];
  rememberDevice: DesktopController["rememberDevice"];
  responseCache: DesktopController["responseCache"];
  sendToDevice: DesktopController["sendToDevice"];
  socket: DesktopController["socket"];
  transportMetrics: DesktopController["transportMetrics"];
};
type Fixture<T> = Omit<DesktopController, keyof T> & Omit<Internals, keyof T> & T;

/** Construct controller state; the caller owns any synthetic runtime and I/O setup. */
export function createControllerFixture<T extends Dependencies & Record<string, unknown>>(fields: T): Fixture<NoInfer<T>> {
  const {
    app = {}, repository = {}, pairingBaseUrl = "http://127.0.0.1", relayConnectUrl = "ws://127.0.0.1",
    broker = {}, eventLog = {}, evidence = {}, claudeDesktop = {}, RTCPeerConnectionImpl,
    desktopAppControls, conversationState, updater, memoryRecorder, ...overrides
  } = fields;
  const args = [
    app, repository, pairingBaseUrl, relayConnectUrl, broker, eventLog, evidence, claudeDesktop,
    RTCPeerConnectionImpl, desktopAppControls, conversationState, updater, memoryRecorder,
  ] as unknown as ControllerArguments;
  return Object.assign(new DesktopController(...args), overrides) as unknown as Fixture<T>;
}
