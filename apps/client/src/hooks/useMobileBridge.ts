import {
  BridgeCrypto,
  randomId,
  type BridgeArtifactManifest,
  type BridgeArtifactPreview,
  type BridgeAttachment,
  type BridgeBackgroundTask,
  type BridgeDesktopAppLaunchResult,
  type BridgeDesktopRuntimeId,
  type BridgeDirectoryListing,
  type BridgeEvent,
  type BridgeEvidenceDetailPage,
  type BridgeHostSnapshot,
  type BridgeMailCache,
  type BridgeNativePermissionMode,
  type BridgePayload,
  type BridgePermissionRules,
  type BridgeProjectInfo,
  type BridgePrAutoFixState,
  type BridgePrAutoFixUpdate,
  type BridgePullRequest,
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
  type ClaudeDesktopAppStatus,
  type EncryptedEnvelope,
  type PairingBundle,
} from "@bridge/protocol";
import { useCallback, useEffect } from "react";
import { getActiveArtifactDownloadGauges } from "../lib/artifact-download.js";
import {
  diagLog,
  estimateArtifactPreviewBytes,
  registerDiagnosticsStateProvider,
} from "../lib/diagnostics.js";
import type { UploadFileHandler } from "../lib/file-upload.js";
import { getActiveMediaTransferGauges } from "../lib/media-preview.js";
import { onNativePushWake } from "../lib/push-wake.js";
import { bridgeVault } from "../lib/vault.js";
import {
  downloadBridgeSessionArtifact,
  downloadBridgeSessionPathFile,
  loadBridgeEvidenceDetails,
  loadOlderBridgeEvidence,
  loadOlderBridgeHistory,
  openBridgeSession,
  previewBridgeArtifact,
  refreshLatestBridgeHistory,
  syncSessionCommandEvents,
  uploadBridgeSessionFile,
} from "./bridge/bridge-artifacts.js";
import {
  applyPrAutoFixToSnapshot,
  applyProjectCatalogPatchToState,
  applySessionResultToState,
  dismissResolvedPermissionInState,
  isClaudeNativeRelay,
  snapshotWithClaudeDesktop,
  syncActiveHostRuntimeSummary,
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
  type NotifyCompletedTurnsOptions,
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
  type StoredHostState,
} from "./bridge/bridge-transport.js";
import { useMobileBridgeStore } from "./bridge/useMobileBridgeStore.js";

export {
  EMPTY_ACTIVE_HOST_STATE,
  INITIAL_STATE,
  applyEvidenceEventToPages,
  applyEvidencePageResult,
  applyEventsToSnapshot,
  applyEventToSnapshot,
  applyEventToTurns,
  applyIncomingEventsToState,
  applyPermissionEvent,
  applyProjectCatalogPatchToState,
  applyResponseToTurns,
  applySessionResultToState,
  applySessionToSnapshot,
  beginHostSessionState,
  clearActiveHostState,
  confirmedPairingSnapshot,
  dismissResolvedPermissionInState,
  freshActiveHostState,
  hydrateStoredHostState,
  isClaudeNativeRelay,
  mergeAcceptedDelivery,
  mergeBridgeEvents,
  rebaseSnapshot,
  relayLinkAllowsSend,
  replaceActiveHostSnapshot,
  syncActiveHostRuntimeSummary,
  type ActiveHostState,
  type ApplyEvidencePageOptions,
  type ApplyIncomingEventsOptions,
  type ApplySessionResultOptions,
  type BeginHostSessionOptions,
  type ClearActiveHostOverrides,
  type HydrateStoredHostOptions,
  type LocalTurn,
  type MobileBridgeState,
  type MobileConnectionIssue,
  type PairedHost,
  type PairingSyncStage,
  type PairingSyncState,
  type ProjectCatalogPatch,
  type QuickReconnectState,
  type ReplaceActiveHostSnapshotOptions,
  type SessionEvidenceState,
  type SessionHistoryState,
  type StoredHostSnapshotInput,
} from "./bridge/bridge-reducers.js";

export function useMobileBridge() {
  const { state, store: transportRefs } = useMobileBridgeStore();
  const {
    setState,
    stateRef,
    cryptoRef,
    socketRef,
    pendingResponsesRef,
    openedSessionRef,
    handledCommandEvents,
    openingSessionsRef,
    loadingHistoryRef,
    transferGaugesRef,
  } = transportRefs;

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
    (events: BridgeEvent[], crypto: BridgeCrypto, options?: NotifyCompletedTurnsOptions) =>
      notifyBridgeCompletedTurns(transportRefs, events, crypto, options),
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
    quickReconnectAttempt?: symbol,
  ) => startBridgeConnection(
    transportRefs,
    { handlePayload, notifyCompletedTurns, refreshSessionList, refreshSnapshot, resumeEvents },
    crypto,
    bootstrap,
    focusSessionId,
    provisionalPairing,
    pairingPhase,
    restored,
    quickReconnectAttempt,
  ), [handlePayload, notifyCompletedTurns, refreshSessionList, refreshSnapshot, resumeEvents]);

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

  const onForeground = useCallback((networkChanged = false) => {
    if (!networkChanged && socketRef.current?.state === "connected") {
      setState((current) => ({ ...current, foregroundRevision: (current.foregroundRevision ?? 0) + 1 }));
    }
    reconnectAndResume(networkChanged);
  }, [reconnectAndResume]);
  useEffect(() => subscribeNetworkAndVisibilityWake(onForeground), [onForeground]);
  useEffect(() => subscribeCapacitorAppWake(onForeground), [onForeground]);

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

  const artifactCtx = { setState, stateRef, cryptoRef, socketRef, sendRequest, historyReadSequenceRef: transportRefs.historyReadSequenceRef };

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
    async (artifact: BridgeArtifactManifest) => {
      transferGaugesRef.current.activeDownloads += 1;
      try {
        await downloadBridgeSessionArtifact(artifactCtx, artifact);
      } finally {
        transferGaugesRef.current.activeDownloads = Math.max(0, transferGaugesRef.current.activeDownloads - 1);
      }
    },
    [sendRequest],
  );

  const downloadSessionFile = useCallback(
    async (sessionId: string, filePath: string, resolveRelativeLink?: true, save?: true) => {
      transferGaugesRef.current.activeDownloads += 1;
      try {
        await downloadBridgeSessionPathFile(artifactCtx, sessionId, filePath, resolveRelativeLink, save);
      } finally {
        transferGaugesRef.current.activeDownloads = Math.max(0, transferGaugesRef.current.activeDownloads - 1);
      }
    },
    [sendRequest],
  );

  const refreshLatestHistory = useCallback(
    (sessionId: string, readCompletedTurnId: string | undefined) => refreshLatestBridgeHistory(artifactCtx, sessionId, readCompletedTurnId),
    [sendRequest],
  );

  const loadOlderHistory = useCallback(
    (sessionId: string) => loadOlderBridgeHistory({ ...artifactCtx, loadingHistoryRef }, sessionId),
    [sendRequest],
  );

  useEffect(() => registerDiagnosticsStateProvider("bridgeState", () => {
    const current = stateRef.current;
    const historyStates = Object.values(current.histories);
    let historyTotalItems = 0;
    let historyLoadingSessions = 0;
    for (const history of historyStates) {
      historyTotalItems += history.items.length;
      if (history.status === "loading") historyLoadingSessions += 1;
    }
    let evidenceBundlesCached = 0;
    let evidenceTotalArtifacts = 0;
    for (const sessionEvidence of Object.values(current.evidence)) {
      evidenceBundlesCached += sessionEvidence.items.length;
      for (const bundle of sessionEvidence.items) {
        evidenceTotalArtifacts += Math.max(bundle.artifactCount ?? 0, bundle.artifacts.length);
      }
    }
    const previews = Object.values(current.artifactPreviews);
    let estimatedDataUrlBytes = 0;
    for (const preview of previews) {
      estimatedDataUrlBytes += estimateArtifactPreviewBytes(preview);
    }
    const stateTransfers = Object.values(current.artifactTransfers);
    const downloadGauges = getActiveArtifactDownloadGauges();
    const mediaGauges = getActiveMediaTransferGauges();
    const now = Date.now();
    let oldestPendingRpcMs = 0;
    for (const pending of pendingResponsesRef.current.values()) {
      if (typeof pending.startedAt === "number") {
        oldestPendingRpcMs = Math.max(oldestPendingRpcMs, Math.max(0, now - pending.startedAt));
      }
    }
    return {
      hostsCount: current.hosts.length,
      hasActiveHost: Boolean(current.activeHostId),
      connection: current.connection,
      desktopOnline: current.desktopOnline,
      latestSeq: current.latestSeq,
      pendingOutbound: current.pendingOutbound,
      sessionsCount: current.snapshot?.sessions.length ?? 0,
      projectsCount: current.snapshot?.projects.length ?? 0,
      permissionsCount: current.permissions.length,
      promptsCount: current.snapshot?.prompts?.length ?? 0,
      histories: {
        sessionsCached: historyStates.length,
        totalItems: historyTotalItems,
        loadingSessions: historyLoadingSessions,
      },
      eventsCount: current.events.length,
      localTurnsCount: current.localTurns.length,
      evidence: {
        bundlesCached: evidenceBundlesCached,
        totalArtifacts: evidenceTotalArtifacts,
      },
      artifactPreviews: {
        cachedCount: previews.length,
        estimatedDataUrlBytes,
      },
      artifactTransfers: {
        count: Math.max(stateTransfers.length, downloadGauges.activeCount) + mediaGauges.activeCount,
        activeCount: stateTransfers.filter((progress) => progress < 1).length + mediaGauges.activeCount,
        totalCachedBytes: downloadGauges.cachedBytes + mediaGauges.cachedBytes,
      },
      pendingRpcCount: pendingResponsesRef.current.size,
      oldestPendingRpcMs,
      activeUploads: transferGaugesRef.current.activeUploads,
      activeDownloads: Math.max(transferGaugesRef.current.activeDownloads, downloadGauges.activeCount),
    };
  }), []);

  const sendTurn = useCallback(async (
    sessionId: string,
    text: string,
    attachments: BridgeAttachment[] = [],
    mailRefId?: string,
    firstTurn?: { hostId: string | undefined; session: BridgeSessionInfo },
  ) => {
    if (firstTurn && (!firstTurn.hostId || cryptoRef.current?.identity.roomId !== firstTurn.hostId)) {
      throw new Error("已切换电脑，首条消息未发送。");
    }
    // A Native creation response can arrive before React commits the updated catalog.
    const session = stateRef.current.snapshot?.sessions.find(candidate => candidate.sessionId === sessionId)
      ?? (firstTurn?.session.sessionId === sessionId ? firstTurn.session : undefined);
    if ((!session?.runtimeId || session.runtimeId === "claude-desktop") &&
        (!isClaudeNativeRelay(stateRef.current.snapshot) || session?.transport !== "claude-desktop-native" || session.allowedActions?.canSend !== true)) {
      throw new Error("请先连接支持原生中转的 Claude Desktop 会话。");
    }
    const requestId = randomId();
    await sendRequest("turn.start", { sessionId, text, attachments, ...(mailRefId ? { mailRefId } : {}) },
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
        setState((current) => dismissResolvedPermissionInState(current, requestId));
        await resumeEvents();
      }
      throw new Error(response?.error?.message ?? "授权处理失败");
    }
    setState((current) => dismissResolvedPermissionInState(current, requestId));
  }, [resumeEvents, sendRequest]);

  const resolvePrompt = useCallback(async (sessionId: string, promptId: string, choice: string): Promise<void> => {
    const response = await sendRequest("prompt.resolve", { sessionId, promptId, choice }, { allowOffline: false, wait: true });
    if (!response?.ok && response?.error?.code !== "ALREADY_RESOLVED") throw new Error(response?.error?.message ?? "回答提交失败");
    await refreshSnapshot();
    await resumeEvents();
    if (!response?.ok) throw new Error(response?.error?.message ?? "这项提示已由其他设备处理。");
  }, [refreshSnapshot, resumeEvents, sendRequest]);

  const readPrAutoFix = useCallback(async (sessionId: string, pr?: BridgePullRequest, includeChecks = false): Promise<BridgePrAutoFixState> => {
    const response = await sendRequest("pr.autoFix.read", { sessionId, ...(pr ? { repo: pr.repo, prNumber: pr.prNumber, ...(pr.host ? { host: pr.host } : {}) } : {}), includeChecks }, { allowOffline: false, wait: true, timeoutMs: 30_000 });
    if (!response?.ok) throw new Error(response?.error?.message ?? "PR 状态读取失败");
    const result = response.result as BridgePrAutoFixState;
    setState(current => ({ ...current, snapshot: applyPrAutoFixToSnapshot(current.snapshot, result) }));
    return result;
  }, [sendRequest]);

  const setPrAutoFix = useCallback(async (update: BridgePrAutoFixUpdate): Promise<BridgePrAutoFixState> => {
    const response = await sendRequest("pr.autoFix.set", update, { allowOffline: false, wait: true });
    if (!response?.ok) throw new Error(response?.error?.message ?? "Auto-fix 设置失败");
    const result = response.result as BridgePrAutoFixState;
    setState(current => ({ ...current, snapshot: applyPrAutoFixToSnapshot(current.snapshot, result) }));
    await resumeEvents();
    return result;
  }, [resumeEvents, sendRequest]);

  const createSection = useCallback(async (name: string): Promise<BridgeProjectInfo | undefined> => {
    const response = await sendRequest("section.create", { name }, { allowOffline: false, wait: true });
    if (!response?.ok) throw new Error(response?.error?.message ?? "分组创建失败");
    const { project } = response.result as { project?: BridgeProjectInfo };
    if (project) setState((current) => applyProjectCatalogPatchToState(current, { upsertProject: project }));
    return project;
  }, [sendRequest]);

  const moveSessionSection = useCallback(async (
    sessionId: string,
    sectionId: string | null,
  ): Promise<{ session?: BridgeSessionInfo; projects?: BridgeProjectInfo[] }> => {
    const response = await sendRequest("section.move", { sessionId, sectionId }, { allowOffline: false, wait: true });
    if (!response?.ok) throw new Error(response?.error?.message ?? "移动分组失败");
    const result = response.result as { session?: BridgeSessionInfo; projects?: BridgeProjectInfo[] };
    setState((current) => applyProjectCatalogPatchToState(current, result));
    return result;
  }, [sendRequest]);

  const renameSection = useCallback(async (
    sectionId: string,
    name: string,
  ): Promise<{ project?: BridgeProjectInfo; projects?: BridgeProjectInfo[]; sessions?: BridgeSessionInfo[] }> => {
    const response = await sendRequest("section.rename", { sectionId, name }, { allowOffline: false, wait: true });
    if (!response?.ok) throw new Error(response?.error?.message ?? "重命名分组失败");
    const result = response.result as { project?: BridgeProjectInfo; projects?: BridgeProjectInfo[]; sessions?: BridgeSessionInfo[] };
    setState((current) => applyProjectCatalogPatchToState(current, result));
    return result;
  }, [sendRequest]);

  const deleteSection = useCallback(async (
    sectionId: string,
  ): Promise<{ projects?: BridgeProjectInfo[]; sessions?: BridgeSessionInfo[] }> => {
    const response = await sendRequest("section.delete", { sectionId }, { allowOffline: false, wait: true });
    if (!response?.ok) throw new Error(response?.error?.message ?? "删除分组失败");
    const result = response.result as { projects?: BridgeProjectInfo[]; sessions?: BridgeSessionInfo[] };
    setState((current) => applyProjectCatalogPatchToState(current, {
      ...result,
      deletedProjectId: sectionId,
    }));
    return result;
  }, [sendRequest]);

  const createSession = useCallback(async (
    cwd: string,
    title?: string,
    runtimeId?: BridgeDesktopRuntimeId,
    projectId?: string,
    trustWorkspace?: boolean,
  ): Promise<BridgeSessionInfo | undefined> => {
    const canTrust = trustWorkspace === true
      && stateRef.current.snapshot?.host.capabilities.includes("workspace.trust.v1") === true;
    const response = await sendRequest("session.create", {
      cwd,
      ...(title ? { title } : {}),
      ...(runtimeId ? { runtimeId } : {}),
      ...(projectId !== undefined ? { projectId } : {}),
      ...(canTrust ? { trustWorkspace: true } : {}),
    }, { wait: true });
    if (!response?.ok) {
      throw Object.assign(
        new Error(response?.error?.message ?? "新建会话失败"),
        response?.error?.code ? { code: response.error.code } : {},
      );
    }
    const result = response.result as { session?: BridgeSessionInfo };
    if (result.session) {
      setState((current) => applySessionResultToState(current, result.session));
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
      setState((current) => applySessionResultToState(current, result.session, { prepend: true }));
    }
    return result.session;
  }, [sendRequest]);

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
      setState((current) => applySessionResultToState(current, result.session));
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
      setState((current) => applySessionResultToState(current, result.session));
    }
    return result.configuration;
  }, [sendRequest]);

  const loadBackgroundTasks = useCallback(async (sessionId: string): Promise<BridgeBackgroundTask[]> => {
    const response = await sendRequest("session.configuration", { sessionId, includeBackgroundTasks: true }, { wait: true, timeoutMs: 45_000 });
    if (!response?.ok) throw new Error(response?.error?.message ?? "后台任务读取失败");
    const session = (response.result as { session?: BridgeSessionInfo }).session;
    if (!session) return [];
    const { backgroundTasks = [], ...sessionInfo } = session;
    setState((current) => applySessionResultToState(current, sessionInfo));
    return backgroundTasks;
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
    setState((current) => applySessionResultToState(current, result.session));
    return result.rewind;
  }, [sendRequest]);

  const configureSession = useCallback(async (
    sessionId: string,
    change: {
      model?: string | null;
      provider?: string | null;
      effort?: string | null;
      fast?: boolean | null;
      permissionMode?: BridgeSDKPermissionMode;
      outputStyle?: string;
    },
  ): Promise<BridgeSessionConfiguration> => {
    if (change.outputStyle !== undefined && !stateRef.current.snapshot?.host.capabilities.includes("session.output-style.v1")) {
      throw new Error("当前电脑不支持设置输出风格。");
    }
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
      setState((current) => applySessionResultToState(current, result.session));
    }
    return result.configuration;
  }, [sendRequest]);

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
    setState((current) => current.snapshot
      ? syncActiveHostRuntimeSummary({ ...current, snapshot: { ...current.snapshot, ...result } })
      : current);
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

  const requestDesktopAppAction = useCallback(async (
    runtimeId: BridgeDesktopRuntimeId,
    action: "status" | "launch" | "quit",
  ): Promise<BridgeDesktopAppLaunchResult> => {
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
    const result = response.result as BridgeDesktopAppLaunchResult | undefined;
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
    return result;
  }, [sendRequest]);

  const controlDesktopApp = useCallback(
    async (runtimeId: BridgeDesktopRuntimeId, action: "status" | "launch" | "quit") => (
      (await requestDesktopAppAction(runtimeId, action)).desktopApps
    ),
    [requestDesktopAppAction],
  );

  const refresh = useCallback(
    (sessionId?: string): Promise<boolean> => refreshBridgeHostState(
      transportRefs,
      { sendRequest, resumeEvents, refreshSnapshot, refreshSessionList, controlClaudeDesktop, openSession },
      sessionId,
    ),
    [controlClaudeDesktop, openSession, refreshSessionList, refreshSnapshot, resumeEvents, sendRequest],
  );

  const activateClaudeRemote = useCallback(async () => {
    const { claudeActivation } = await requestDesktopAppAction("claude-desktop", "launch");
    void refresh();
    return claudeActivation;
  }, [requestDesktopAppAction, refresh]);

  const forgetHost = useCallback(
    (roomId: string) => forgetBridgeHost(transportRefs, sendRequest, roomId),
    [sendRequest],
  );

  const setRelayUrl = useCallback(
    (url: string) => setBridgeRelayUrl(transportRefs, start, url),
    [start],
  );

  const retryConnection = useCallback(async (fromQuickSwitch = false) => {
    const crypto = cryptoRef.current;
    if (!fromQuickSwitch) {
      if (crypto) await start(crypto);
      return;
    }
    if (!crypto) {
      setState((current) => ({
        ...current,
        quickReconnect: { status: "failed", message: "找不到这台电脑的配对密钥，请重新配对。" },
      }));
      return;
    }
    const attempt = Symbol();
    try {
      await start(crypto, false, undefined, undefined, undefined, undefined, attempt);
    } catch (error) {
      if (transportRefs.connectionAttemptRef.current !== attempt) return;
      setState((current) => ({
        ...current,
        quickReconnect: { status: "failed", message: error instanceof Error ? error.message : String(error) },
      }));
    }
  }, [start]);

  const archiveSession = useCallback(async (sessionId: string, archived: boolean) => {
    const response = await sendRequest("session.archive", {
      sessionId,
      archived,
    }, { wait: true, timeoutMs: 30_000 });
    if (!response?.ok) throw new Error(response?.error?.message ?? "归档设置失败");
  }, [sendRequest]);

  const uploadFile = useCallback<(...args: [...Parameters<UploadFileHandler>, expectedRoomId?: string]) => ReturnType<UploadFileHandler>>(async (sessionId, file, onProgress, signal, expectedRoomId) => {
    if (expectedRoomId !== undefined && cryptoRef.current?.identity.roomId !== expectedRoomId) {
      throw new Error("已切换电脑，上传已中断");
    }
    transferGaugesRef.current.activeUploads += 1;
    try {
      return await uploadBridgeSessionFile(cryptoRef, sendRequest, sessionId, file, onProgress, signal);
    } finally {
      transferGaugesRef.current.activeUploads = Math.max(0, transferGaugesRef.current.activeUploads - 1);
    }
  }, [sendRequest]);

  const renameSession = useCallback(async (sessionId: string, title: string): Promise<void> => {
    const response = await sendRequest("session.rename", { sessionId, title }, { wait: true });
    if (!response?.ok) throw new Error(response?.error?.message ?? "重命名会话失败");
    const result = response.result as { session: BridgeSessionInfo };
    setState((current) => applySessionResultToState(current, result.session, { titleOnly: true }));
  }, [sendRequest]);

  const deleteSession = useCallback(async (sessionId: string) => {
    const response = await sendRequest("session.delete", {
      sessionId,
    }, { wait: true, timeoutMs: 30_000 });
    if (!response?.ok) throw new Error(response?.error?.message ?? "删除会话失败");
  }, [sendRequest]);

  const loadMailCache = useCallback(async (): Promise<BridgeMailCache | undefined> => {
    const crypto = cryptoRef.current;
    if (crypto) return bridgeVault.loadMailCache(crypto);
  }, []);

  const saveMailCache = useCallback(async (cache: BridgeMailCache): Promise<void> => {
    const crypto = cryptoRef.current;
    if (crypto) await bridgeVault.saveMailCache(crypto, cache);
  }, []);

  return {
    state,
    pair,
    selectHost,
    setRelayUrl,
    backToHosts,
    openSession,
    refreshLatestHistory,
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
    resolvePrompt,
    readPrAutoFix,
    setPrAutoFix,
    createSession,
    createSection,
    moveSessionSection,
    renameSection,
    deleteSection,
    forkSession,
    loadBackgroundTasks,
    loadSessionConfiguration,
    loadSessionCommands,
    runSessionCommand,
    loadSessionPermissions,
    saveSessionPermissions,
    previewRewind,
    rewindSession,
    configureSession,
    archiveSession,
    renameSession,
    deleteSession,
    launchClaudeDesktop,
    controlDesktopApp,
    activateClaudeRemote,
    quitClaudeDesktop,
    refresh,
    forgetHost,
    retryConnection,
    loadMailCache,
    saveMailCache,
  };
}
