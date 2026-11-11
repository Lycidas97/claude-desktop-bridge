import {
  BridgeCrypto,
  randomId,
  type BridgeArtifactManifest,
  type BridgeArtifactPreview,
  type BridgeAttachment,
  type BridgeBackgroundTask,
  type BridgeDesktopAppStatus,
  type BridgeDesktopRuntimeId,
  type BridgeDirectoryListing,
  type BridgeEvent,
  type BridgeEvidenceDetailPage,
  type BridgeHostSnapshot,
  type BridgeNativePermissionMode,
  type BridgePayload,
  type BridgePermissionInfo,
  type BridgePermissionRules,
  type BridgeProjectInfo,
  type BridgeProviderProfile,
  type BridgeRequest,
  type BridgeResponse,
  type BridgeSDKPermissionMode,
  type BridgeSessionCommandResult,
  type BridgeSessionConfiguration,
  type BridgeSessionInfo,
  type BridgeSessionPermissions,
  type BridgeSessionRewindPreview,
  type BridgeSessionRewindResult,
  type BridgeSessionRewindScope,
  type BridgeSlashCommandCatalog,
  type BridgeTransport,
  type ClaudeDesktopAppStatus,
  type EncryptedEnvelope,
  type PairingBundle,
} from "@bridge/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { diagLog } from "../lib/diagnostics.js";
import type { UploadFileHandler } from "../lib/file-upload.js";
import { onNativePushWake } from "../lib/push-wake.js";
import {
  downloadBridgeSessionArtifact,
  downloadBridgeSessionPathFile,
  loadBridgeEvidenceDetails,
  loadOlderBridgeEvidence,
  loadOlderBridgeHistory,
  openBridgeSession,
  previewBridgeArtifact,
  syncSessionCommandEvents,
  uploadBridgeSessionFile,
} from "./bridge/bridge-artifacts.js";
import {
  INITIAL_STATE,
  applySessionToSnapshot,
  hostWithRuntimeState,
  isClaudeNativeRelay,
  snapshotWithClaudeDesktop,
  snapshotWithPermissions,
  type MobileBridgeState,
  type PairingConnectionPhase,
  type PendingResponse,
} from "./bridge/bridge-reducers.js";
import {
  applyBridgeLanRelayAdvertisement,
  backToBridgeHosts,
  bootstrapStoredBridgeHosts,
  forgetBridgeHost,
  handleBridgePayload,
  notifyBridgeCompletedTurns,
  pairBridgeHost,
  reconnectAndResumeBridge,
  refreshBridgeHostState,
  refreshBridgeSessionList,
  refreshBridgeSnapshot,
  resumeBridgeEvents,
  selectBridgeHost,
  sendBridgeRequest,
  setBridgeRelayUrl,
  startBridgeConnection,
  subscribeCapacitorAppWake,
  subscribeNetworkAndVisibilityWake,
  syncBridgeDiagnostics,
  updateBridgeHostCache,
  type BridgeTransportRefs,
  type StoredHostState,
} from "./bridge/bridge-transport.js";

export {
  applyEventsToSnapshot,
  applyEventToSnapshot,
  applyEventToTurns,
  applyPermissionEvent,
  applySessionToSnapshot,
  confirmedPairingSnapshot,
  isClaudeNativeRelay,
  mergeAcceptedDelivery,
  mergeBridgeEvents,
  rebaseSnapshot,
  relayLinkAllowsSend,
  snapshotWithClaudeDesktop,
  type LocalTurn,
  type MobileConnectionIssue,
  type PairedHost,
  type PairingSyncStage,
  type PairingSyncState,
  type SessionEvidenceState,
  type SessionHistoryState,
} from "./bridge/bridge-reducers.js";

export function useMobileBridge() {
  const [state, setState] = useState<MobileBridgeState>(INITIAL_STATE);
  const stateRef = useRef(state);
  stateRef.current = state;
  const cryptoRef = useRef<BridgeCrypto | undefined>(undefined);
  const cryptoByRoomRef = useRef(new Map<string, BridgeCrypto>());
  const socketRef = useRef<BridgeTransport | undefined>(undefined);
  const connectionTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pairingSyncTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingResponsesRef = useRef(new Map<string, PendingResponse>());
  const envelopeRequestsRef = useRef(new Map<string, string>());
  const desktopHomeRef = useRef<string | undefined>(undefined);
  const linkGateRef = useRef<() => boolean>(() => true);
  const sendAttemptedAtRef = useRef<number | undefined>(undefined);
  const nativeRelayCapabilityRef = useRef<boolean | undefined>(undefined);
  const payloadDeflateRef = useRef(false);
  const pendingCompletionNotificationsRef = useRef(new Set<string>());

  const transportRefs: BridgeTransportRefs = {
    setState,
    stateRef,
    cryptoRef,
    cryptoByRoomRef,
    socketRef,
    connectionTimerRef,
    pairingSyncTimerRef,
    pendingResponsesRef,
    envelopeRequestsRef,
    desktopHomeRef,
    linkGateRef,
    sendAttemptedAtRef,
    nativeRelayCapabilityRef,
    payloadDeflateRef,
    pendingCompletionNotificationsRef,
  };

  const updateHostCache = useCallback((
    roomId: string,
    snapshot: BridgeHostSnapshot,
    permissions: BridgePermissionInfo[] = snapshot.permissions,
  ) => updateBridgeHostCache(setState, roomId, snapshot, permissions), []);

  const applyLanRelayAdvertisement = useCallback(
    (roomId: string, snapshot: BridgeHostSnapshot) => applyBridgeLanRelayAdvertisement(roomId, snapshot),
    [],
  );

  const handlePayload = useCallback((
    payload: BridgePayload,
    encrypted: EncryptedEnvelope,
    crypto: BridgeCrypto,
  ) => handleBridgePayload(transportRefs, applyLanRelayAdvertisement, payload, encrypted, crypto), [applyLanRelayAdvertisement]);

  const sendRequest = useCallback((
    method: BridgeRequest["method"],
    params: Record<string, unknown>,
    options: { wait?: boolean; allowOffline?: boolean; requestId?: string; idempotencyKey?: string; timeoutMs?: number } = {},
  ) => sendBridgeRequest(transportRefs, method, params, options), []);

  const notifyCompletedTurns = useCallback(
    (events: BridgeEvent[], crypto: BridgeCrypto) => notifyBridgeCompletedTurns(transportRefs, events, crypto),
    [],
  );

  const resumeEvents = useCallback(
    (bootstrap = false, fromSeq?: number) => resumeBridgeEvents(transportRefs, sendRequest, notifyCompletedTurns, bootstrap, fromSeq),
    [notifyCompletedTurns, sendRequest],
  );

  const refreshSessionList = useCallback(
    () => refreshBridgeSessionList(transportRefs, sendRequest),
    [sendRequest],
  );

  const refreshSnapshot = useCallback(
    (verifiedSnapshot?: BridgeHostSnapshot) => refreshBridgeSnapshot(transportRefs, sendRequest, applyLanRelayAdvertisement, verifiedSnapshot),
    [applyLanRelayAdvertisement, sendRequest],
  );

  const start = useCallback((
    crypto: BridgeCrypto,
    bootstrap = false,
    focusSessionId?: string,
    provisionalPairing?: PairingBundle,
    pairingPhase?: PairingConnectionPhase,
    restored?: StoredHostState,
  ) => startBridgeConnection(
    transportRefs,
    { handlePayload, notifyCompletedTurns, refreshSessionList, refreshSnapshot, resumeEvents, updateHostCache },
    crypto,
    bootstrap,
    focusSessionId,
    provisionalPairing,
    pairingPhase,
    restored,
  ), [handlePayload, notifyCompletedTurns, refreshSessionList, refreshSnapshot, resumeEvents, updateHostCache]);

  useEffect(() => {
    syncBridgeDiagnostics(state);
  }, [
    state.activeHostId,
    state.connection,
    state.connectionIssue,
    state.desktopName,
    state.desktopOnline,
    state.error,
    state.hosts,
    state.latestSeq,
    state.loading,
    state.pendingOutbound,
    state.transportMetrics,
  ]);

  useEffect(() => bootstrapStoredBridgeHosts(transportRefs, start), [start]);

  const reconnectAndResume = useCallback(
    (networkChanged = false) => reconnectAndResumeBridge(socketRef, refreshSnapshot, resumeEvents, networkChanged),
    [refreshSnapshot, resumeEvents],
  );

  useEffect(() => onNativePushWake(() => reconnectAndResume()), [reconnectAndResume]);

  useEffect(() => subscribeNetworkAndVisibilityWake(reconnectAndResume), [reconnectAndResume]);

  useEffect(() => subscribeCapacitorAppWake(reconnectAndResume), [reconnectAndResume]);

  const pair = useCallback(
    (pairing: PairingBundle): Promise<boolean> => pairBridgeHost(
      transportRefs,
      { start, sendRequest, refreshSnapshot, resumeEvents },
      pairing,
    ),
    [refreshSessionList, refreshSnapshot, resumeEvents, sendRequest, start],
  );

  const selectHost = useCallback(
    (roomId: string, focusSessionId?: string) => selectBridgeHost(transportRefs, start, roomId, focusSessionId),
    [start],
  );

  const backToHosts = useCallback(() => backToBridgeHosts(transportRefs), []);

  const openedSessionRef = useRef<string | undefined>(undefined);
  const handledCommandEvents = useRef(new Set<string>());
  const openingSessionsRef = useRef(new Map<string, { socket: BridgeTransport | undefined; task: Promise<void> }>());

  const artifactCtx = { setState, stateRef, cryptoRef, socketRef, sendRequest };

  const openSession = useCallback(
    (sessionId: string) => openBridgeSession({ ...artifactCtx, openedSessionRef, openingSessionsRef }, sessionId),
    [sendRequest],
  );

  useEffect(() => {
    syncSessionCommandEvents({
      events: state.events,
      handledCommandEvents,
      openedSessionRef,
      setState,
      refreshSnapshot,
      openSession,
    });
  }, [state.events, openSession, refreshSnapshot]);

  const loadOlderEvidence = useCallback(
    (sessionId: string) => loadOlderBridgeEvidence(artifactCtx, sessionId),
    [sendRequest],
  );

  const loadEvidenceDetails = useCallback(
    (evidenceId: string, kind: "tools" | "artifacts", cursor?: string): Promise<BridgeEvidenceDetailPage> => (
      loadBridgeEvidenceDetails(artifactCtx, evidenceId, kind, cursor)
    ),
    [sendRequest],
  );

  const previewArtifact = useCallback(
    (artifactId: string): Promise<BridgeArtifactPreview> => previewBridgeArtifact(artifactCtx, artifactId),
    [sendRequest],
  );

  const downloadArtifact = useCallback(
    (artifact: BridgeArtifactManifest) => downloadBridgeSessionArtifact(artifactCtx, artifact),
    [sendRequest],
  );

  const downloadSessionFile = useCallback(
    (sessionId: string, filePath: string) => downloadBridgeSessionPathFile(artifactCtx, sessionId, filePath),
    [sendRequest],
  );

  const loadingHistoryRef = useRef(new Map<string, BridgeTransport | undefined>());
  const loadOlderHistory = useCallback(
    (sessionId: string) => loadOlderBridgeHistory({ ...artifactCtx, loadingHistoryRef }, sessionId),
    [sendRequest],
  );

  const sendTurn = useCallback(async (
    sessionId: string,
    text: string,
    attachments: BridgeAttachment[] = [],
    steer = false,
  ) => {
    const session = stateRef.current.snapshot?.sessions.find(candidate => candidate.sessionId === sessionId);
    if ((!session?.runtimeId || session.runtimeId === "claude-desktop") &&
        (!isClaudeNativeRelay(stateRef.current.snapshot) || session?.transport !== "claude-desktop-native" || session.allowedActions?.canSend !== true)) {
      throw new Error("请先连接支持原生中转的 Claude Desktop 会话。");
    }
    const requestId = randomId();
    await sendRequest(steer ? "turn.steer" : "turn.start", { sessionId, text, attachments },
      { allowOffline: true, requestId, idempotencyKey: randomId() });
    return { requestId };
  }, [sendRequest]);

  const interruptTurn = useCallback(async (sessionId: string, commandId?: string) => {
    const response = await sendRequest("turn.interrupt", {
      sessionId,
      ...(commandId ? { commandId } : {}),
      force: true,
    }, { allowOffline: false, wait: true });
    if (!response?.ok) throw new Error(response?.error?.message ?? "任务停止失败");
    const result = response.result as { interrupted?: boolean } | undefined;
    if (result?.interrupted !== true) throw new Error("当前没有可停止的 Bridge 任务");
    await resumeEvents();
  }, [resumeEvents, sendRequest]);

  const steerQueuedTurn = useCallback(async (sessionId: string, commandId: string) => {
    const response = await sendRequest("turn.queue.steer", { sessionId, commandId }, { allowOffline: false, wait: true });
    if (!response?.ok) throw new Error(response?.error?.message ?? "立即发送失败");
    const result = response.result as { state: string };
    await resumeEvents();
    if (result.state === "uncertain") throw new Error("消息投递状态尚未确认，请同步状态后重试");
  }, [resumeEvents, sendRequest]);

  const cancelQueuedTurn = useCallback(async (sessionId: string, commandId: string) => {
    const response = await sendRequest("turn.queue.cancel", { sessionId, commandId }, { allowOffline: false, wait: true });
    if (!response?.ok) throw new Error(response?.error?.message ?? "撤回失败");
    await resumeEvents();
  }, [resumeEvents, sendRequest]);

  const stopSubagent = useCallback(async (sessionId: string, agentId: string) => {
    const response = await sendRequest("subagent.stop", { sessionId, agentId }, { allowOffline: false, wait: true });
    if (!response?.ok) throw new Error(response?.error?.message ?? "子代理停止失败");
    await resumeEvents();
  }, [resumeEvents, sendRequest]);

  const resolveUncertainDelivery = useCallback(async (
    commandId: string,
    action: "confirm" | "retry",
  ) => {
    const response = await sendRequest("message.delivery.resolve", {
      commandId,
      action,
    }, { allowOffline: false, wait: true });
    if (!response?.ok) throw new Error(response?.error?.message ?? "投递状态处理失败");
    await resumeEvents();
  }, [resumeEvents, sendRequest]);

  const resolvePermission = useCallback(async (
    requestId: string,
    decision: "allow-once" | "allow-always" | "deny",
    message?: string,
    updatedInput?: Record<string, unknown>,
    mode?: BridgeNativePermissionMode,
  ) => {
    diagLog("info", "permission", `resolve ${requestId} ${decision}${mode ? ` mode=${mode}` : ""}`);
    const response = await sendRequest("permission.resolve", {
      requestId,
      decision,
      ...(message ? { message } : {}),
      ...(updatedInput ? { updatedInput } : {}),
      ...(mode ? { mode } : {}),
    }, { allowOffline: false, wait: true });
    if (!response?.ok) {
      diagLog("error", "permission", `resolve ${requestId} 失败`, response?.error ?? "no response", true);
      if (response?.error?.code === "ALREADY_RESOLVED") {
        setState((current) => {
          const permissions = current.permissions.filter((permission) => permission.requestId !== requestId);
          const snapshot = snapshotWithPermissions(current.snapshot, permissions);
          return {
            ...current,
            snapshot,
            permissions,
            hosts: current.hosts.map((host) => host.roomId === current.activeHostId
              ? hostWithRuntimeState(host, snapshot, permissions)
              : host),
          };
        });
        await resumeEvents();
      }
      throw new Error(response?.error?.message ?? "授权处理失败");
    }
    setState((current) => {
      const permissions = current.permissions.filter((permission) => permission.requestId !== requestId);
      const snapshot = snapshotWithPermissions(current.snapshot, permissions);
      return {
        ...current,
        snapshot,
        permissions,
        hosts: current.hosts.map((host) => host.roomId === current.activeHostId
          ? hostWithRuntimeState(host, snapshot, permissions)
          : host),
      };
    });
  }, [resumeEvents, sendRequest]);

  const createSection = useCallback(async (name: string): Promise<BridgeProjectInfo | undefined> => {
    const response = await sendRequest("section.create", { name }, { allowOffline: false, wait: true });
    if (!response?.ok) throw new Error(response?.error?.message ?? "Section 创建失败");
    const { project } = response.result as { project?: BridgeProjectInfo };
    if (project) setState(current => current.snapshot ? {
      ...current, snapshot: { ...current.snapshot, projects: [project, ...current.snapshot.projects.filter(item => item.projectId !== project.projectId)] },
    } : current);
    return project;
  }, [sendRequest]);

  const moveSessionSection = useCallback(async (
    sessionId: string,
    sectionId: string | null,
  ): Promise<{ session?: BridgeSessionInfo; projects?: BridgeProjectInfo[] }> => {
    const response = await sendRequest("section.move", { sessionId, sectionId }, { allowOffline: false, wait: true });
    if (!response?.ok) throw new Error(response?.error?.message ?? "移动分组失败");
    const result = response.result as { session?: BridgeSessionInfo; projects?: BridgeProjectInfo[] };
    setState((current) => {
      if (!current.snapshot) return current;
      const withSession = applySessionToSnapshot(current.snapshot, result.session)!;
      const snapshot = Array.isArray(result.projects) ? { ...withSession, projects: result.projects } : withSession;
      return {
        ...current,
        snapshot,
        hosts: current.hosts.map((host) => host.roomId === current.activeHostId
          ? hostWithRuntimeState(host, snapshot, current.permissions)
          : host),
      };
    });
    return result;
  }, [sendRequest]);

  const createSession = useCallback(async (
    cwd: string,
    title?: string,
    runtimeId?: BridgeDesktopRuntimeId,
    projectId?: string,
  ): Promise<BridgeSessionInfo | undefined> => {
    const response = await sendRequest("session.create", {
      cwd,
      ...(title ? { title } : {}),
      ...(runtimeId ? { runtimeId } : {}),
      ...(projectId !== undefined ? { projectId } : {}),
    }, { wait: true });
    if (!response?.ok) throw new Error(response?.error?.message ?? "新建会话失败");
    const result = response.result as { session?: BridgeSessionInfo };
    if (result.session) {
      setState((current) => ({ ...current, snapshot: applySessionToSnapshot(current.snapshot, result.session) }));
    }
    return result.session;
  }, [sendRequest]);

  const forkSession = useCallback(async (
    sessionId: string,
    title?: string,
  ): Promise<BridgeSessionInfo | undefined> => {
    const response = await sendRequest("session.fork", {
      sessionId,
      ...(title ? { title } : {}),
    }, { wait: true, timeoutMs: 30_000 });
    if (!response?.ok) throw new Error(response?.error?.message ?? "Fork 分支创建失败");
    const result = response.result as { session?: BridgeSessionInfo };
    if (result.session) {
      const created = result.session;
      setState((current) => current.snapshot ? {
        ...current,
        snapshot: {
          ...current.snapshot,
          sessions: [
            created,
            ...current.snapshot.sessions.filter((candidate) => candidate.sessionId !== created.sessionId),
          ],
        },
      } : current);
    }
    return result.session;
  }, [sendRequest]);

  const returnToDesktop = useCallback(async (_sessionId: string): Promise<void> => {
    throw new Error("Claude 已由 Desktop 原生执行，无需交还。");
  }, []);

  const takeoverDesktop = useCallback(async (_sessionId: string, _commandId?: string): Promise<void> => {
    throw new Error("Claude 已由 Desktop 原生执行，不再支持 Bridge 接管。");
  }, []);

  const loadSessionCommands = useCallback(async (sessionId: string): Promise<BridgeSlashCommandCatalog> => {
    const response = await sendRequest("session.commands", { sessionId }, { allowOffline: false, wait: true });
    if (!response?.ok) throw new Error(response?.error?.message ?? "自定义命令读取失败");
    return (response.result as { catalog: BridgeSlashCommandCatalog }).catalog;
  }, [sendRequest]);

  const runSessionCommand = useCallback(async (sessionId: string, text: string): Promise<BridgeSessionCommandResult> => {
    const crypto = cryptoRef.current;
    const socket = socketRef.current;
    const response = await sendRequest("session.command", { sessionId, text }, { allowOffline: false, wait: true });
    if (!response?.ok) throw new Error(response?.error?.message ?? "命令执行失败");
    const result = (response.result as { command: BridgeSessionCommandResult }).command;
    if (result.session && cryptoRef.current === crypto && socketRef.current === socket) {
      setState(current => ({ ...current, snapshot: applySessionToSnapshot(current.snapshot, result.session) }));
    }
    return result;
  }, [sendRequest]);

  const loadSessionPermissions = useCallback(async (sessionId: string): Promise<BridgeSessionPermissions> => {
    const response = await sendRequest("session.permissions", { sessionId }, { allowOffline: false, wait: true });
    if (!response?.ok) throw new Error(response?.error?.message ?? "SDK 权限读取失败");
    return (response.result as { permissions: BridgeSessionPermissions }).permissions;
  }, [sendRequest]);

  const saveSessionPermissions = useCallback(async (sessionId: string, mode: BridgeSDKPermissionMode, rules: BridgePermissionRules): Promise<BridgeSessionPermissions> => {
    const response = await sendRequest("session.permissions.configure", { sessionId, mode, rules }, { allowOffline: false, wait: true });
    if (!response?.ok) throw new Error(response?.error?.message ?? "SDK 权限保存失败");
    return (response.result as { permissions: BridgeSessionPermissions }).permissions;
  }, [sendRequest]);

  const loadSessionConfiguration = useCallback(async (sessionId: string): Promise<BridgeSessionConfiguration> => {
    const response = await sendRequest("session.configuration", { sessionId }, {
      wait: true,
      timeoutMs: 45_000,
    });
    if (!response?.ok) throw new Error(response?.error?.message ?? "会话配置读取失败");
    const result = response.result as { configuration?: BridgeSessionConfiguration; session?: BridgeSessionInfo };
    if (!result.configuration) throw new Error("电脑未返回会话配置");
    if (result.session) {
      setState((current) => ({ ...current, snapshot: applySessionToSnapshot(current.snapshot, result.session) }));
    }
    return result.configuration;
  }, [sendRequest]);

  const loadBackgroundTasks = useCallback(async (sessionId: string): Promise<BridgeBackgroundTask[]> => {
    const response = await sendRequest("session.configuration", { sessionId, includeBackgroundTasks: true }, { wait: true, timeoutMs: 45_000 });
    if (!response?.ok) throw new Error(response?.error?.message ?? "后台任务读取失败");
    return (response.result as { session?: BridgeSessionInfo }).session?.backgroundTasks ?? [];
  }, [sendRequest]);

  const previewRewind = useCallback(async (sessionId: string, messageId: string): Promise<BridgeSessionRewindPreview> => {
    const response = await sendRequest("session.rewind.preview", { sessionId, messageId }, { wait: true, timeoutMs: 45_000 });
    if (!response?.ok) throw new Error(response?.error?.message ?? "回退预览读取失败");
    return (response.result as { rewind: BridgeSessionRewindPreview }).rewind;
  }, [sendRequest]);

  const rewindSession = useCallback(async (sessionId: string, messageId: string, scope: BridgeSessionRewindScope): Promise<BridgeSessionRewindResult> => {
    const response = await sendRequest("session.rewind", { sessionId, messageId, scope }, { wait: true, timeoutMs: 45_000 });
    if (!response?.ok) throw new Error(response?.error?.message ?? "回退失败");
    const result = response.result as { rewind: BridgeSessionRewindResult; session?: BridgeSessionInfo };
    setState(current => ({ ...current, snapshot: applySessionToSnapshot(current.snapshot, result.session) }));
    return result.rewind;
  }, [sendRequest]);

  const configureSession = useCallback(async (
    sessionId: string,
    change: {
      model?: string | null;
      provider?: string | null;
      effort?: string | null;
      reasoningEffort?: string | null;
      fast?: boolean | null;
      permissionMode?: BridgeSDKPermissionMode;
    },
  ): Promise<BridgeSessionConfiguration> => {
    const response = await sendRequest("session.configure", { sessionId, ...change }, {
      wait: true,
      timeoutMs: 45_000,
    });
    if (!response?.ok) throw new Error(response?.error?.message ?? "会话配置保存失败");
    const result = response.result as {
      configuration?: BridgeSessionConfiguration;
      session?: BridgeSessionInfo;
    };
    if (!result.configuration) throw new Error("电脑未返回会话配置");
    if (result.session) {
      setState((current) => ({ ...current, snapshot: applySessionToSnapshot(current.snapshot, result.session) }));
    }
    return result.configuration;
  }, [sendRequest]);

  const previewProviderSwitch = useCallback(async (_sessionId: string, _targetProviderProfileId: string, _model?: string): Promise<never> => {
    throw new Error("Claude 提供方由 Desktop 管理。");
  }, []);

  const commitProviderSwitch = useCallback(async (_handoffId: string, _targetNativeSessionId?: string, _model?: string): Promise<never> => {
    throw new Error("Claude 提供方由 Desktop 管理。");
  }, []);

  const cancelProviderSwitch = useCallback(async (_handoffId: string): Promise<void> => {
    throw new Error("Claude 提供方由 Desktop 管理。");
  }, []);

  const browseDirectory = useCallback(async (path?: string): Promise<BridgeDirectoryListing> => {
    const response = await sendRequest("directory.list", path ? { path } : {}, { wait: true, allowOffline: false });
    if (!response?.ok) throw new Error(response?.error?.message ?? "文件夹读取失败");
    return (response.result as { listing: BridgeDirectoryListing }).listing;
  }, [sendRequest]);

  const createDirectory = useCallback(async (parentPath: string, name: string): Promise<string> => {
    const response = await sendRequest("directory.mkdir", { parentPath, name }, { wait: true, allowOffline: false });
    if (!response?.ok) throw new Error(response?.error?.message ?? "新建文件夹失败");
    return (response.result as { path: string }).path;
  }, [sendRequest]);

  const redetectProviders = useCallback(async (): Promise<void> => {
    const crypto = cryptoRef.current;
    const socket = socketRef.current;
    const response = await sendRequest("runtime.refresh", {}, { wait: true, allowOffline: false, timeoutMs: 45_000 });
    if (cryptoRef.current !== crypto || socketRef.current !== socket) throw new Error("已切换电脑，请重新检测当前电脑");
    if (!response?.ok) throw new Error(response?.error?.message ?? "检测失败");
    const result = response.result as Pick<BridgeHostSnapshot, "runtime" | "runtimes" | "providers">;
    setState((current) => current.snapshot ? { ...current, snapshot: { ...current.snapshot, ...result } } : current);
  }, [sendRequest]);

  const refreshProviders = useCallback(async (): Promise<void> => {
    const response = await sendRequest("provider.refresh", {}, {
      wait: true,
      timeoutMs: 45_000,
    });
    if (!response?.ok) throw new Error(response?.error?.message ?? "提供方状态刷新失败");
    const result = response.result as { providers?: BridgeProviderProfile[] };
    const providers = result.providers;
    if (!providers) throw new Error("电脑未返回提供方状态");
    setState((current) => current.snapshot ? {
      ...current,
      snapshot: { ...current.snapshot, providers },
    } : current);
  }, [sendRequest]);

  const controlClaudeDesktop = useCallback(async (
    action: "status" | "launch" | "quit",
  ): Promise<ClaudeDesktopAppStatus> => {
    const crypto = cryptoRef.current;
    const socket = socketRef.current;
    const isCurrent = () => cryptoRef.current === crypto && socketRef.current === socket;
    const method: BridgeRequest["method"] = `claude.desktop.${action}`;
    const response = await sendRequest(method, {}, {
      wait: true,
      timeoutMs: action === "status" ? 20_000 : 45_000,
    });
    if (!response?.ok) {
      throw new Error(response?.error?.message ?? (
        action === "launch" ? "Claude Desktop 启动失败" : action === "quit" ? "Claude Desktop 退出失败" : "无法读取 Claude Desktop 状态"
      ));
    }
    const result = response.result as { claudeDesktop?: ClaudeDesktopAppStatus } | undefined;
    if (!result?.claudeDesktop) throw new Error("电脑未返回 Claude Desktop 状态");
    const claudeDesktop = result.claudeDesktop;
    setState((current) => isCurrent() ? {
      ...current,
      snapshot: snapshotWithClaudeDesktop(current.snapshot, claudeDesktop),
    } : current);
    return claudeDesktop;
  }, [sendRequest]);

  const launchClaudeDesktop = useCallback(
    () => controlClaudeDesktop("launch"),
    [controlClaudeDesktop],
  );

  const quitClaudeDesktop = useCallback(
    () => controlClaudeDesktop("quit"),
    [controlClaudeDesktop],
  );

  const controlDesktopApp = useCallback(async (
    runtimeId: BridgeDesktopRuntimeId,
    action: "status" | "launch" | "quit",
  ): Promise<BridgeDesktopAppStatus[]> => {
    const method: BridgeRequest["method"] = `desktop.app.${action}`;
    const response = await sendRequest(method, { runtimeId }, {
      wait: true,
      timeoutMs: action === "status" ? 20_000 : 45_000,
    });
    if (!response?.ok) {
      throw new Error(response?.error?.message ?? (
        action === "launch" ? "Desktop 应用启动失败" : action === "quit" ? "Desktop 应用退出失败" : "无法读取 Desktop 应用状态"
      ));
    }
    const result = response.result as { desktopApps?: BridgeDesktopAppStatus[] } | undefined;
    if (!result?.desktopApps) throw new Error("电脑未返回 Desktop 应用状态");
    const desktopApps = result.desktopApps;
    setState((current) => {
      if (!current.snapshot) return current;
      const claudeDesktop = desktopApps.find((app) => app.id === "claude-desktop");
      return {
        ...current,
        snapshot: {
          ...current.snapshot,
          desktopApps,
          ...(claudeDesktop ? { claudeDesktop } : {}),
        },
      };
    });
    return desktopApps;
  }, [sendRequest]);

  const refresh = useCallback(
    (sessionId?: string): Promise<boolean> => refreshBridgeHostState(
      transportRefs,
      { sendRequest, resumeEvents, refreshSnapshot, refreshSessionList, controlClaudeDesktop, openSession },
      sessionId,
    ),
    [controlClaudeDesktop, openSession, refreshSessionList, refreshSnapshot, resumeEvents, sendRequest],
  );

  const forgetHost = useCallback(
    (roomId: string) => forgetBridgeHost(transportRefs, sendRequest, roomId),
    [sendRequest],
  );

  const setRelayUrl = useCallback(
    (url: string) => setBridgeRelayUrl(transportRefs, start, url),
    [start],
  );

  const retryConnection = useCallback(async () => {
    const crypto = cryptoRef.current;
    if (crypto) await start(crypto);
  }, [start]);

  const archiveSession = useCallback(async (sessionId: string, archived: boolean) => {
    const response = await sendRequest("session.archive", {
      sessionId,
      archived,
    }, { wait: true, timeoutMs: 30_000 });
    if (!response?.ok) throw new Error(response?.error?.message ?? "归档设置失败");
  }, [sendRequest]);

  const uploadFile = useCallback<UploadFileHandler>((sessionId, file, onProgress, signal) => (
    uploadBridgeSessionFile(sendRequest, sessionId, file, onProgress, signal)
  ), [sendRequest]);

  const renameSession = useCallback(async (sessionId: string, title: string): Promise<void> => {
    const response = await sendRequest("session.rename", { sessionId, title }, { wait: true });
    if (!response?.ok) throw new Error(response?.error?.message ?? "重命名会话失败");
    const result = response.result as { session: BridgeSessionInfo };
    setState((current) => ({
      ...current,
      snapshot: current.snapshot && {
        ...current.snapshot,
        sessions: current.snapshot.sessions.map((session) => session.sessionId === result.session.sessionId
          ? { ...session, title: result.session.title }
          : session),
      },
    }));
  }, [sendRequest]);

  const deleteSession = useCallback(async (sessionId: string) => {
    const response = await sendRequest("session.delete", {
      sessionId,
    }, { wait: true, timeoutMs: 30_000 });
    if (!response?.ok) throw new Error(response?.error?.message ?? "删除会话失败");
  }, [sendRequest]);

  return {
    state,
    pair,
    selectHost,
    setRelayUrl,
    backToHosts,
    openSession,
    loadOlderHistory,
    loadOlderEvidence,
    loadEvidenceDetails,
    previewArtifact,
    requestMedia: sendRequest,
    browseDirectory,
    createDirectory,
    redetectProviders,
    uploadFile,
    downloadArtifact,
    downloadSessionFile,
    sendTurn,
    interruptTurn,
    steerQueuedTurn,
    cancelQueuedTurn,
    stopSubagent,
    resolveUncertainDelivery,
    resolvePermission,
    createSession,
    createSection,
    moveSessionSection,
    forkSession,
    returnToDesktop,
    takeoverDesktop,
    loadBackgroundTasks,
    loadSessionConfiguration,
    loadSessionCommands,
    runSessionCommand,
    loadSessionPermissions,
    saveSessionPermissions,
    previewRewind,
    rewindSession,
    configureSession,
    previewProviderSwitch,
    commitProviderSwitch,
    cancelProviderSwitch,
    archiveSession,
    renameSession,
    deleteSession,
    refreshProviders,
    launchClaudeDesktop,
    controlDesktopApp,
    quitClaudeDesktop,
    refresh,
    forgetHost,
    retryConnection,
  };
}
