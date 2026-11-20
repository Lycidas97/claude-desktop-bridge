import {
  BridgeCrypto,
  PAYLOAD_DEFLATE_CAPABILITY,
  PAYLOAD_DEFLATE_SUPPORTED,
  RelayTransport,
  TransportRouter,
  WebRtcTransport,
  bridgeEndpoint,
  bridgeIceServers,
  cryptoWithRelayEndpoint,
  evidenceSummary,
  normalizeBridgeEndpoints,
  preferredBridgeIceServers,
  randomId,
  summarizeEvidenceEvent,
  type BridgeArtifactPreview,
  type BridgeAttachment,
  type BridgeDeliveryState,
  type BridgeEndpoint,
  type BridgeEvent,
  type BridgeHostSnapshot,
  type BridgePayload,
  type BridgePendingPrompt,
  type BridgeRequest,
  type BridgeResponse,
  type BridgeSessionInfo,
  type BridgeTransport,
  type BridgeTransportCandidate,
  type ClaudeDesktopAppStatus,
  type DecryptedEnvelope,
  type EncryptedEnvelope,
  type PairingBundle,
} from "@bridge/protocol";
import { App as CapacitorApp } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { diagLog, setDiagBridgeStateSummary } from "../../lib/diagnostics.js";
import { isReplayableMobileEnvelope } from "../../lib/outbox.js";
import { nativePushRegistration } from "../../lib/push-wake.js";
import {
  ensureSessionNotificationPermission,
  isActivelyViewingSession,
  isSessionNotificationsEnabled,
  showBrowserDesktopOrWebNotification,
  showSessionNotification,
} from "../../lib/session-notifications.js";
import { bridgeVault } from "../../lib/vault.js";
import type { BridgeSendRequest } from "./bridge-artifacts.js";
import {
  HOME_LEARN_FRESHNESS_MS,
  LOCAL_EVIDENCE_CACHE_TTL_MS,
  advancePairingSync,
  applyEvidenceEventToPages,
  applyEvidencePageResult,
  applyEventToSnapshot,
  applyEventToTurns,
  applyIncomingEventsToState,
  applyPermissionEvent,
  applyResponseToTurns,
  applySessionResultToState,
  beginHostSessionState,
  clearActiveHostState,
  confirmedPairingSnapshot,
  evidencePageFromResponse,
  hostSummary,
  hydrateStoredHostState,
  isBridgeResponse,
  isClaudeNativeRelay,
  isLoopbackRelay,
  mergeBridgeEvents,
  permissionFromEvent,
  previewFromResponse,
  relayIssue,
  relayLinkAllowsSend,
  replaceActiveHostSnapshot,
  shouldExtendLocalEvidenceCache,
  shouldPersistIncomingMessage,
  snapshotWithPermissions,
  type LocalTurn,
  type MobileBridgeState,
  type MobileConnectionIssue,
  type PairingConnectionPhase,
  type PendingResponse,
  type SessionEvidenceState,
  type StoredHostSnapshotInput,
} from "./bridge-reducers.js";

const LAST_ACTIVE_HOST_KEY = "bridge.mobile.last-active-host.v1";
const PENDING_PAIRING_INSTANCE_PREFIX = "bridge.mobile.pending-pairing-instance.v1.";

export function readLastActiveHost(): string | undefined {
  try {
    return localStorage.getItem(LAST_ACTIVE_HOST_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function writeLastActiveHost(roomId?: string): void {
  try {
    if (roomId) localStorage.setItem(LAST_ACTIVE_HOST_KEY, roomId);
    else localStorage.removeItem(LAST_ACTIVE_HOST_KEY);
  } catch {
    // The vault still retains pairing state when browser storage is unavailable.
  }
}

/**
 * Pairing claims are single-use on the relay: the first hello binds the
 * device to an installation instanceId, and every later hello must present
 * the same value. A transient handshake failure (e.g. the desktop is
 * momentarily offline and `snapshot.get` times out) used to burn the QR
 * because `fromPairing` minted a fresh random instanceId on each retry.
 * Persist the provisional instanceId per room/device so re-scanning the same
 * QR reclaims the same slot instead of failing with PAIRING_ALREADY_USED.
 */
function pendingPairingInstanceId(roomId: string, deviceId: string): string {
  const key = `${PENDING_PAIRING_INSTANCE_PREFIX}${roomId}:${deviceId}`;
  try {
    const existing = localStorage.getItem(key);
    if (existing) return existing;
    const value = randomId(12);
    localStorage.setItem(key, value);
    return value;
  } catch {
    return randomId(12);
  }
}

function clearPendingPairingInstanceId(roomId: string, deviceId: string): void {
  try {
    localStorage.removeItem(`${PENDING_PAIRING_INSTANCE_PREFIX}${roomId}:${deviceId}`);
  } catch {
    // Non-fatal; a stale key is harmless because the installed identity
    // carries the same instanceId after importPairing.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type StoredHostState = StoredHostSnapshotInput;

export async function readStoredHostState(
  crypto: BridgeCrypto,
  storedEnvelopes?: EncryptedEnvelope[],
): Promise<StoredHostState> {
  const t0 = Date.now();
  const allEnvelopes = storedEnvelopes ?? await bridgeVault.listMessages(crypto.identity.roomId, 120).catch((err) => {
    diagLog("error", "vault", "listMessages 异常", String(err));
    return [];
  });
  const envelopes = allEnvelopes.length > 120 ? allEnvelopes.slice(-120) : allEnvelopes;
  const results = await Promise.allSettled(envelopes.map((envelope) => crypto.decrypt(envelope)));
  const messages = results
    .filter((result): result is PromiseFulfilledResult<DecryptedEnvelope> => result.status === "fulfilled")
    .map((result) => result.value);
  diagLog("info", "vault", `readStoredHostState(${crypto.identity.roomId}) 完成 (${Date.now() - t0}ms)`, {
    totalEnvelopes: allEnvelopes.length,
    slicedEnvelopes: envelopes.length,
    decryptedMessages: messages.length,
  });
  const snapshot = messages.reduce<Extract<BridgePayload, { kind: "snapshot" }> | undefined>((latest, message) =>
    message.payload.kind === "snapshot" && (!latest || message.payload.snapshot.latestSeq >= latest.snapshot.latestSeq)
      ? message.payload : latest, undefined);
  const events = mergeBridgeEvents(
    [],
    messages.flatMap((message) => message.payload.kind === "event" ? [message.payload.event] : []),
  );
  let permissions = snapshot?.kind === "snapshot" ? snapshot.snapshot.permissions : [];
  const snapshotSeq = snapshot?.kind === "snapshot" ? snapshot.snapshot.latestSeq : 0;
  let replayedSnapshot = snapshot?.kind === "snapshot" ? snapshot.snapshot : undefined;
  for (const event of events.filter((candidate) => candidate.seq > snapshotSeq)) {
    permissions = applyPermissionEvent(permissions, event);
    replayedSnapshot = applyEventToSnapshot(replayedSnapshot, event, permissions);
  }
  const localTurns: LocalTurn[] = messages.flatMap((message) => {
    if (
      message.header.from !== "mobile" ||
      message.payload.kind !== "request" ||
      (message.payload.method !== "turn.start" && message.payload.method !== "turn.steer")
    ) return [];
    const params = message.payload.params;
    if (typeof params.sessionId !== "string") return [];
    return [{
      requestId: message.payload.requestId,
      idempotencyKey: message.payload.idempotencyKey,
      sessionId: params.sessionId,
      ...(params.bridgeExecutionRequested === true ? { bridgeExecutionRequested: true } : {}),
      text: typeof params.text === "string" ? params.text : "",
      attachments: Array.isArray(params.attachments)
        ? params.attachments.flatMap((attachment) => {
            if (!attachment || typeof attachment !== "object") return [];
            const { data: _data, ...metadata } = attachment as BridgeAttachment;
            return [metadata];
          })
        : [],
      createdAt: message.header.sentAt,
      delivery: "local-saved" as const,
    }];
  });
  let appliedTurns = localTurns;
  for (const event of events) appliedTurns = applyEventToTurns(appliedTurns, event);
  for (const message of messages) {
    if (!isBridgeResponse(message.payload)) continue;
    appliedTurns = applyResponseToTurns(appliedTurns, message.payload);
  }
  const storedSnapshot = snapshotWithPermissions(replayedSnapshot, permissions);
  let evidence: Record<string, SessionEvidenceState> = {};
  for (const event of events) evidence = applyEvidenceEventToPages(evidence, event);
  const artifactPreviews: Record<string, BridgeArtifactPreview> = {};
  for (const message of messages) {
    if (!isBridgeResponse(message.payload)) continue;
    const preview = previewFromResponse(message.payload);
    if (preview) artifactPreviews[preview.artifactId] = preview;
    const page = evidencePageFromResponse(message.payload);
    if (!page) continue;
    evidence = applyEvidencePageResult(evidence, page.sessionId, page, { mergeHasMore: true });
  }
  return {
    ...(storedSnapshot ? { snapshot: storedSnapshot } : {}),
    snapshotSeq,
    permissions,
    events,
    evidence,
    artifactPreviews,
    localTurns: appliedTurns,
    latestSeq: Math.max(snapshotSeq, ...events.map((event) => event.seq), 0),
  };
}

export function clientMetadata(): Record<string, string | string[]> {
  const platform = Capacitor.getPlatform();
  return {
    platform: platform === "android" ? "android" : "web",
    name: platform === "android" ? "Android 手机" : "Web 客户端",
    capabilities: PAYLOAD_DEFLATE_SUPPORTED ? [PAYLOAD_DEFLATE_CAPABILITY] : [],
  };
}

export async function revokeRemoteDevice(crypto: BridgeCrypto): Promise<void> {
  const socket = new RelayTransport({ crypto, role: "mobile", reconnect: false });
  await new Promise<void>((resolve) => {
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      socket.close();
      resolve();
    };
    const timeout = setTimeout(done, 4_000);
    socket.onState((connection) => {
      if (connection !== "connected") return;
      const request: BridgeRequest = {
        kind: "request",
        requestId: randomId(),
        idempotencyKey: randomId(),
        method: "device.revoke",
        params: { deviceId: crypto.identity.deviceId, client: clientMetadata() },
      };
      void socket.send(request, "desktop").catch(done);
    });
    socket.onMessage((message, encrypted) => {
      socket.ack([encrypted.id]);
      if (message.payload.kind !== "response") return;
      clearTimeout(timeout);
      done();
    });
    socket.onFrame((frame) => {
      if (frame.type === "error") {
        clearTimeout(timeout);
        done();
      }
    });
    socket.connect();
  });
}

export interface BridgeTransportRefs {
  setState: Dispatch<SetStateAction<MobileBridgeState>>;
  stateRef: MutableRefObject<MobileBridgeState>;
  cryptoRef: MutableRefObject<BridgeCrypto | undefined>;
  cryptoByRoomRef: MutableRefObject<Map<string, BridgeCrypto>>;
  socketRef: MutableRefObject<BridgeTransport | undefined>;
  connectionAttemptRef: MutableRefObject<symbol | undefined>;
  connectionTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | undefined>;
  pairingSyncTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | undefined>;
  pendingResponsesRef: MutableRefObject<Map<string, PendingResponse>>;
  envelopeRequestsRef: MutableRefObject<Map<string, string>>;
  desktopHomeRef: MutableRefObject<string | undefined>;
  linkGateRef: MutableRefObject<() => boolean>;
  sendAttemptedAtRef: MutableRefObject<number | undefined>;
  nativeRelayCapabilityRef: MutableRefObject<boolean | undefined>;
  payloadDeflateRef: MutableRefObject<boolean>;
  pendingCompletionNotificationsRef: MutableRefObject<Set<string>>;
}

export type ActiveTransportTeardownRefs = Pick<
  BridgeTransportRefs,
  | "cryptoRef"
  | "socketRef"
  | "connectionAttemptRef"
  | "connectionTimerRef"
  | "pairingSyncTimerRef"
  | "pendingResponsesRef"
  | "envelopeRequestsRef"
  | "desktopHomeRef"
  | "linkGateRef"
  | "sendAttemptedAtRef"
  | "nativeRelayCapabilityRef"
  | "payloadDeflateRef"
  | "pendingCompletionNotificationsRef"
>;

export interface ActiveTransportTeardownOptions {
  /** Reject pending RPC waiters with this message instead of leaving callers blocked until timeout. */
  rejectPendingReason?: string;
  /** Only clear active transport refs when `socketRef.current` still points to this socket instance. */
  onlyIfSocket?: BridgeTransport;
  /** Also clear the pairing sync dismissal timer (omit when transitioning to a new provisional pairing). */
  clearPairingSyncTimer?: boolean;
  /** Install the replacement crypto identity atomically after closing the old transport. */
  nextCrypto?: BridgeCrypto;
  /** Leave `cryptoRef.current` intact (used on hook unmount cleanup). */
  preserveCrypto?: boolean;
}

/** Close the active transport socket, cancel timers, and reset ephemeral link refs in one place. */
export function teardownActiveTransport(
  refs: ActiveTransportTeardownRefs,
  options: ActiveTransportTeardownOptions = {},
): void {
  const {
    cryptoRef,
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
  } = refs;
  const activeSocket = socketRef.current;
  if (options.onlyIfSocket && activeSocket !== options.onlyIfSocket) {
    options.onlyIfSocket.close();
    return;
  }
  refs.connectionAttemptRef.current = undefined;
  if (connectionTimerRef.current) {
    clearTimeout(connectionTimerRef.current);
    connectionTimerRef.current = undefined;
  }
  if (options.clearPairingSyncTimer && pairingSyncTimerRef.current) {
    clearTimeout(pairingSyncTimerRef.current);
    pairingSyncTimerRef.current = undefined;
  }
  const rejectionError = options.rejectPendingReason
    ? new Error(options.rejectPendingReason)
    : undefined;
  for (const pending of pendingResponsesRef.current.values()) {
    clearTimeout(pending.timer);
    if (rejectionError) pending.reject(rejectionError);
  }
  pendingResponsesRef.current.clear();
  envelopeRequestsRef.current.clear();
  pendingCompletionNotificationsRef.current.clear();
  desktopHomeRef.current = undefined;
  sendAttemptedAtRef.current = undefined;
  nativeRelayCapabilityRef.current = undefined;
  payloadDeflateRef.current = false;
  linkGateRef.current = () => true;
  activeSocket?.close();
  socketRef.current = undefined;
  if (options.nextCrypto !== undefined) {
    cryptoRef.current = options.nextCrypto;
  } else if (!options.preserveCrypto) {
    cryptoRef.current = undefined;
  }
}

export function applyBridgeLanRelayAdvertisement(roomId: string, snapshot: BridgeHostSnapshot): void {
  const url = snapshot.host.lanRelayUrl;
  if (!url) return;
  // The healed endpoint is read from the vault on the next (re)connect.
  void bridgeVault.updateLanRelay(roomId, url).catch(() => undefined);
}

export function handleBridgePayload(
  refs: Pick<BridgeTransportRefs, "setState" | "stateRef" | "pendingResponsesRef">,
  applyLanRelayAdvertisement: (roomId: string, snapshot: BridgeHostSnapshot) => void,
  payload: BridgePayload,
  encrypted: EncryptedEnvelope,
  crypto: BridgeCrypto,
): void {
  const { setState, stateRef, pendingResponsesRef } = refs;
  if (payload.kind === "snapshot") {
    if (payload.snapshot.latestSeq < stateRef.current.snapshotSeq) return;
    diagLog("info", "permission", `snapshot latestSeq=${payload.snapshot.latestSeq} permissions=${payload.snapshot.permissions.length}`, payload.snapshot.permissions.map((permission) => ({
      requestId: permission.requestId,
      sessionId: permission.sessionId,
      toolName: permission.toolName,
    })));
    // Receiving it already marked the desktop online. Its host.online can be stale: a restarting
    // desktop builds the snapshot before its relay state reads "connected" and sends it after.
    setState((current) => replaceActiveHostSnapshot(current, crypto.identity.roomId, payload.snapshot));
    applyLanRelayAdvertisement(crypto.identity.roomId, payload.snapshot);
    return;
  }
  if (payload.kind === "event") {
    const { event } = payload;
    if (/^(permission|question)\.(requested|resolved)$/u.test(event.type)) {
      const snapshotSeq = stateRef.current.snapshotSeq;
      const dropped = event.seq <= snapshotSeq;
      diagLog(dropped ? "warn" : "info", "permission", `${event.type} seq=${event.seq} snapshotSeq=${snapshotSeq}${dropped ? " 已忽略" : ""}`, {
        requestId: event.data.requestId,
        sessionId: event.sessionId,
      }, dropped);
    }
    setState((current) => applyIncomingEventsToState(current, [payload.event], {
      roomId: crypto.identity.roomId,
    }));
    return;
  }
  if (payload.kind !== "response") return;
  setState((current) => {
    const localTurns = applyResponseToTurns(current.localTurns, payload);
    return localTurns === current.localTurns ? current : { ...current, localTurns };
  });
  const pending = pendingResponsesRef.current.get(payload.requestId);
  if (pending) {
    clearTimeout(pending.timer);
    pendingResponsesRef.current.delete(payload.requestId);
    pending.resolve(payload);
  }
  void encrypted;
}

export async function sendBridgeRequest(
  refs: Pick<
    BridgeTransportRefs,
    | "setState"
    | "stateRef"
    | "cryptoRef"
    | "socketRef"
    | "pendingResponsesRef"
    | "envelopeRequestsRef"
    | "linkGateRef"
    | "sendAttemptedAtRef"
    | "nativeRelayCapabilityRef"
    | "payloadDeflateRef"
  >,
  method: BridgeRequest["method"],
  params: Record<string, unknown>,
  options: { wait?: boolean; allowOffline?: boolean; requestId?: string; idempotencyKey?: string; timeoutMs?: number } = {},
): Promise<BridgeResponse | undefined> {
  const {
    setState,
    stateRef,
    cryptoRef,
    socketRef,
    pendingResponsesRef,
    envelopeRequestsRef,
    linkGateRef,
    sendAttemptedAtRef,
    nativeRelayCapabilityRef,
    payloadDeflateRef,
  } = refs;
  const crypto = cryptoRef.current;
  if (!crypto) throw new Error("No host selected");
  const socket = socketRef.current;
  if ((!socket || socket.state !== "connected") && !options.allowOffline) {
    throw new Error("电脑当前离线");
  }
  const request: BridgeRequest = {
    kind: "request",
    requestId: options.requestId ?? randomId(),
    idempotencyKey: options.idempotencyKey ?? randomId(),
    method,
    params: { ...params, client: clientMetadata() },
  };
  const persistOutbox = Boolean(
    options.allowOffline || method === "turn.start" || method === "turn.steer",
  );
  const envelope = await crypto.encrypt(
    request,
    "mobile",
    "desktop",
    Date.now(),
    undefined,
    undefined,
    persistOutbox ? undefined : true,
    method !== "snapshot.get" && payloadDeflateRef.current,
  );
  envelopeRequestsRef.current.set(envelope.id, request.requestId);
  if (persistOutbox) {
    await Promise.all([bridgeVault.saveMessage(envelope), bridgeVault.addOutbox(envelope)]);
    setState((current) => ({ ...current, pendingOutbound: current.pendingOutbound + 1 }));
  }
  if (method === "turn.start" || method === "turn.steer") {
    // Keep the outgoing preview in memory; replay still restores metadata only.
    const attachments = Array.isArray(params.attachments) ? params.attachments as BridgeAttachment[] : [];
    setState((current) => ({
      ...current,
      localTurns: [
        ...current.localTurns.filter((turn) => turn.requestId !== request.requestId),
        {
          requestId: request.requestId,
          idempotencyKey: request.idempotencyKey,
          sessionId: String(params.sessionId ?? ""),
          text: typeof params.text === "string" ? params.text : "",
          attachments,
          ...(params.bridgeExecutionRequested === true ? { bridgeExecutionRequested: true } : {}),
          createdAt: envelope.sentAt,
          lastEventSeq: current.latestSeq,
          delivery: "local-saved",
        },
      ],
    }));
  }
  if (method === "turn.start" || method === "turn.steer") {
    const session = stateRef.current.snapshot?.sessions.find(candidate => candidate.sessionId === params.sessionId);
    if ((!session?.runtimeId || session.runtimeId === "claude-desktop") && nativeRelayCapabilityRef.current !== true) return undefined;
  }
  if (cryptoRef.current !== crypto || socketRef.current !== socket) {
    if (options.wait) throw new Error("连接已重置");
    return undefined;
  }
  if (!socket || socket.state !== "connected") {
    return undefined;
  }
  if (!linkGateRef.current()) {
    // The current connection landed on a relay the desktop isn't using
    // (e.g. a proxy app pulled the phone onto the overseas relay). Keep the
    // envelope in the outbox instead of letting it rot in the wrong
    // namespace, and say so instead of faking progress.
    setState((current) => ({
      ...current,
      connectionIssue: {
        code: "waiting-link",
        message: "当前网络未连到电脑所在的中继（可能被代理带偏），消息已保存在手机，链路恢复后自动重发。",
      },
    }));
    if (options.wait) {
      throw new Error("当前网络未连到电脑所在的中继（可能被代理带偏），请检查代理或 VPN 设置后重试。");
    }
    return undefined;
  }
  const responsePromise = options.wait ? new Promise<BridgeResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingResponsesRef.current.delete(request.requestId);
      reject(new Error("电脑响应超时"));
    }, options.timeoutMs ?? 20_000);
    pendingResponsesRef.current.set(request.requestId, { resolve, reject, timer, startedAt: Date.now() });
  }) : undefined;
  // Prevent Node/Vitest unhandledRejection if teardown rejects while `sendEnvelope` is still yielding.
  responsePromise?.catch(() => undefined);
  try {
    sendAttemptedAtRef.current = Date.now();
    await socket.sendEnvelope(envelope);
  } catch (error) {
    const pending = pendingResponsesRef.current.get(request.requestId);
    if (pending) clearTimeout(pending.timer);
    pendingResponsesRef.current.delete(request.requestId);
    if (persistOutbox && !options.wait) {
      diagLog("warn", "bridge", "发送失败，消息保留在待发箱等待重试", String(error));
      return undefined;
    }
    throw error;
  }
  return responsePromise;
}

export interface NotifyCompletedTurnsOptions {
  fromResume?: boolean | undefined;
  bootstrap?: boolean | undefined;
}

const NOTIFICATION_MAX_AGE_MS = 30 * 60_000;
const EPOCH_MS_FLOOR = 1_000_000_000_000;

function singleLineNotificationPreview(raw: unknown, maxChars = 60): string {
  if (typeof raw !== "string") return "";
  const compact = raw.replace(/\s+/gu, " ").trim();
  if (!compact) return "";
  const chars = Array.from(compact);
  return chars.length > maxChars ? `${chars.slice(0, maxChars).join("")}…` : compact;
}

function isEventNotificationStale(event: BridgeEvent): boolean {
  const rawEventTime = typeof event.data?.createdAt === "number" ? event.data.createdAt : event.timestamp;
  return (
    typeof rawEventTime === "number"
    && rawEventTime >= EPOCH_MS_FLOOR
    && Date.now() - rawEventTime > NOTIFICATION_MAX_AGE_MS
  );
}

function extractCompletedTurnAssistantPreview(
  event: BridgeEvent,
  batchEvents: readonly BridgeEvent[],
  stateEvents: readonly BridgeEvent[],
): string {
  const direct = singleLineNotificationPreview(event.data?.text, 60);
  if (direct) return direct;
  if (!event.sessionId) return "";
  const combined = [...(stateEvents ?? []), ...batchEvents]
    .filter((candidate) => candidate.sessionId === event.sessionId && candidate.seq <= event.seq)
    .sort((left, right) => left.seq - right.seq);
  for (let i = combined.length - 1; i >= 0; i -= 1) {
    const candidate = combined[i]!;
    if (candidate.eventId === event.eventId) continue;
    if (
      candidate.type === "turn.completed"
      || candidate.type === "turn.failed"
      || candidate.type === "turn.interrupted"
    ) {
      break;
    }
    if (event.turnId && candidate.turnId && candidate.turnId !== event.turnId) {
      continue;
    }
    if (candidate.type === "assistant.completed") {
      const preview = singleLineNotificationPreview(candidate.data?.text, 60);
      if (preview) return preview;
    }
  }
  return "";
}

function formatCompletedTurnBody(
  event: BridgeEvent,
  batchEvents: readonly BridgeEvent[],
  stateEvents: readonly BridgeEvent[],
): string {
  if (event.type === "turn.completed") {
    const preview = extractCompletedTurnAssistantPreview(event, batchEvents, stateEvents);
    return preview || "任务已完成，点击查看结果";
  }
  const errorPreview = singleLineNotificationPreview(event.data?.error ?? event.data?.message, 60);
  return errorPreview ? `任务失败：${errorPreview}` : "任务执行失败，点击查看详情";
}

export function notifyBridgeCompletedTurns(
  refs: Pick<BridgeTransportRefs, "stateRef" | "pendingCompletionNotificationsRef">,
  events: BridgeEvent[],
  crypto: BridgeCrypto,
  options: NotifyCompletedTurnsOptions = {},
): void {
  if (typeof window !== "undefined" && window.bridgeDesktop) return;
  const completed = events.filter((event) => event.type === "turn.completed" || event.type === "turn.failed");
  if (completed.length === 0) return;
  const stateEvents = refs.stateRef.current.events ?? [];
  const seen = new Set(stateEvents.map((event) => event.eventId));
  const pending = refs.pendingCompletionNotificationsRef.current;
  // The state event list owns committed IDs. Keep only IDs awaiting a React
  // commit so queued delivery and resume cannot notify twice in the same batch.
  for (const id of pending) if (seen.has(id)) pending.delete(id);
  const notificationsEnabled = isSessionNotificationsEnabled();
  const isVisible = typeof document !== "undefined" && document.visibilityState === "visible";
  for (const event of completed) {
    if (seen.has(event.eventId) || pending.has(event.eventId)) continue;
    pending.add(event.eventId);
    if (options.bootstrap || !notificationsEnabled) continue;
    if (isEventNotificationStale(event)) continue;
    if (isVisible && isActivelyViewingSession(crypto.identity.roomId, event.sessionId)) continue;
    const title = refs.stateRef.current.snapshot?.sessions.find((session) => session.sessionId === event.sessionId)?.title
      ?? crypto.identity.desktopName;
    const body = formatCompletedTurnBody(event, events, stateEvents);
    if (Capacitor.isNativePlatform()) {
      void showSessionNotification(
        { hostId: crypto.identity.roomId, ...(event.sessionId ? { sessionId: event.sessionId } : {}) },
        title,
        body,
      );
    } else {
      showBrowserDesktopOrWebNotification(title, body, event.eventId);
    }
  }
}

export async function resumeBridgeEvents(
  refs: Pick<BridgeTransportRefs, "setState" | "stateRef" | "cryptoRef" | "socketRef">,
  sendRequest: BridgeSendRequest,
  notifyCompletedTurns: (events: BridgeEvent[], crypto: BridgeCrypto, options?: NotifyCompletedTurnsOptions) => void,
  bootstrap = false,
  fromSeq?: number,
): Promise<void> {
  const { setState, stateRef, cryptoRef, socketRef } = refs;
  const crypto = cryptoRef.current;
  const socket = socketRef.current;
  const isCurrent = () => cryptoRef.current === crypto && socketRef.current === socket;
  try {
    const events: BridgeEvent[] = [];
    let cursor = fromSeq ?? stateRef.current.latestSeq;
    for (;;) {
      const response = await sendRequest("events.resume", {
        afterSeq: cursor,
        limit: 250,
        ...(bootstrap && cursor === 0 ? { bootstrap: true } : {}),
      }, { wait: true, timeoutMs: 8_000 });
      if (!isCurrent()) return;
      if (!response?.ok) break;
      const result = response.result as {
        events?: unknown;
        latestSeq?: unknown;
        nextSeq?: unknown;
        hasMore?: unknown;
      } | undefined;
      if (!Array.isArray(result?.events)) break;
      const pageEvents = result.events as BridgeEvent[];
      events.push(...pageEvents);
      const nextSeq = typeof result.nextSeq === "number"
        ? result.nextSeq
        : Math.max(cursor, ...pageEvents.map((event) => event.seq));
      if (nextSeq <= cursor) break;
      cursor = nextSeq;
      const latestSeq = typeof result.latestSeq === "number" ? result.latestSeq : cursor;
      if (result.hasMore !== true || cursor >= latestSeq) break;
    }
    if (crypto) notifyCompletedTurns(events, crypto, { fromResume: true, bootstrap });
    setState((current) => isCurrent()
      ? applyIncomingEventsToState(current, events, { cursor })
      : current);
  } catch {
    // The next reconnect retries from the same cursor.
  }
}

export async function refreshBridgeSessionList(
  refs: Pick<BridgeTransportRefs, "setState" | "cryptoRef" | "socketRef">,
  sendRequest: BridgeSendRequest,
): Promise<boolean> {
  const { setState, cryptoRef, socketRef } = refs;
  const crypto = cryptoRef.current;
  const socket = socketRef.current;
  const isCurrent = () => cryptoRef.current === crypto && socketRef.current === socket;
  const response = await sendRequest("session.list", {}, {
    wait: true,
    timeoutMs: 20_000,
  });
  if (!isCurrent() || !response?.ok) return false;
  const result = response.result as { sessions?: BridgeSessionInfo[] };
  if (!result.sessions) return false;
  setState((current) => isCurrent()
    ? applySessionResultToState(current, undefined, { sessions: result.sessions })
    : current);
  return true;
}

export async function refreshBridgeSnapshot(
  refs: Pick<BridgeTransportRefs, "setState" | "stateRef" | "cryptoRef" | "socketRef">,
  sendRequest: BridgeSendRequest,
  applyLanRelayAdvertisement: (roomId: string, snapshot: BridgeHostSnapshot) => void,
  verifiedSnapshot?: BridgeHostSnapshot,
): Promise<boolean> {
  const { setState, stateRef, cryptoRef, socketRef } = refs;
  const crypto = cryptoRef.current;
  const socket = socketRef.current;
  if (!crypto) throw new Error("电脑当前离线");
  const isCurrent = () => cryptoRef.current === crypto && socketRef.current === socket;
  if (!verifiedSnapshot) {
    const response = await sendRequest("snapshot.get", {}, {
      wait: true,
      timeoutMs: 20_000,
    });
    if (!isCurrent()) return false;
    if (!response?.ok) throw new Error(response?.error?.message ?? "电脑端快照刷新失败");
    const result = response.result as { snapshot?: BridgeHostSnapshot } | undefined;
    if (!result?.snapshot) throw new Error("电脑端未返回最新会话快照");
    verifiedSnapshot = result.snapshot;
  }
  const roomId = crypto.identity.roomId;
  if (verifiedSnapshot.latestSeq < stateRef.current.snapshotSeq) return true;
  const cacheCrypto = crypto.withSenderDevice(crypto.identity.hostId ?? crypto.identity.deviceId);
  const cachedEnvelope = await cacheCrypto.encrypt(
    { kind: "snapshot", snapshot: verifiedSnapshot },
    "desktop",
    "mobile",
    Date.now(),
    LOCAL_EVIDENCE_CACHE_TTL_MS,
    crypto.identity.deviceId,
  );
  if (!isCurrent()) return false;
  await bridgeVault.saveMessage(cachedEnvelope);
  if (!isCurrent()) return false;
  applyLanRelayAdvertisement(roomId, verifiedSnapshot);
  setState((current) => (
    isCurrent()
      // The answer itself shows the desktop online; its host.online can be stale (see handlePayload).
      ? replaceActiveHostSnapshot(current, roomId, verifiedSnapshot!, { clearError: true })
      : current
  ));
  return true;
}

export interface StartBridgeCallbacks {
  handlePayload: (payload: BridgePayload, encrypted: EncryptedEnvelope, crypto: BridgeCrypto) => void;
  notifyCompletedTurns: (events: BridgeEvent[], crypto: BridgeCrypto, options?: NotifyCompletedTurnsOptions) => void;
  refreshSessionList: () => Promise<boolean>;
  refreshSnapshot: (verifiedSnapshot?: BridgeHostSnapshot) => Promise<boolean>;
  resumeEvents: (bootstrap?: boolean, fromSeq?: number) => Promise<void>;
}

export async function startBridgeConnection(
  refs: BridgeTransportRefs,
  callbacks: StartBridgeCallbacks,
  crypto: BridgeCrypto,
  bootstrap = false,
  focusSessionId?: string,
  provisionalPairing?: PairingBundle,
  pairingPhase?: PairingConnectionPhase,
  restored?: StoredHostState,
  quickReconnectAttempt?: symbol,
): Promise<void> {
  const {
    setState,
    stateRef,
    cryptoByRoomRef,
    socketRef,
    connectionAttemptRef,
    connectionTimerRef,
    pendingResponsesRef,
    envelopeRequestsRef,
    desktopHomeRef,
    linkGateRef,
    sendAttemptedAtRef,
    nativeRelayCapabilityRef,
    payloadDeflateRef,
  } = refs;
  const {
    handlePayload,
    notifyCompletedTurns,
    refreshSessionList,
    refreshSnapshot,
    resumeEvents,
  } = callbacks;

  teardownActiveTransport(refs, {
    nextCrypto: crypto,
    rejectPendingReason: "连接已重置",
  });
  const attempt = quickReconnectAttempt ?? Symbol();
  connectionAttemptRef.current = attempt;
  let awaitingQuickReconnect = quickReconnectAttempt !== undefined;
  setState((current) => current.quickReconnect || quickReconnectAttempt
    ? { ...current, quickReconnect: quickReconnectAttempt ? { status: "pending" } : undefined }
    : current);
  const roomId = crypto.identity.roomId;
  if (!provisionalPairing) writeLastActiveHost(roomId);
  const storedHost = await bridgeVault.getHost(roomId);
  if (connectionAttemptRef.current !== attempt) return;
  const relayEndpoints = normalizeBridgeEndpoints(
    provisionalPairing?.relayEndpoints ??
      storedHost?.relayEndpoints ??
      [bridgeEndpoint(crypto.identity.relayUrl, 100, "legacy")],
  ).filter((endpoint): endpoint is BridgeEndpoint & {
    kind: "public-relay" | "lan-relay";
  } => endpoint.kind !== "direct");
  diagLog("info", "bridge", `start(roomId=${roomId}, bootstrap=${bootstrap})`, {
    identityRelayUrl: crypto.identity.relayUrl,
    storedDesktopRelayUrl: storedHost?.desktopRelayUrl,
    relayEndpoints,
  });
  setState((current) => beginHostSessionState(current, roomId, crypto.identity.desktopName, {
    focusSessionId,
    preserveCurrentHost: !provisionalPairing,
    loading: false,
  }));

  const stored = restored ?? await readStoredHostState(crypto, provisionalPairing ? [] : undefined);
  const queuedOutbox = provisionalPairing ? [] : await bridgeVault.listOutbox(roomId);
  const replayableOutbox = queuedOutbox.filter((envelope) => isReplayableMobileEnvelope(
    envelope,
    { roomId, deviceId: crypto.identity.deviceId },
  ));
  const replayableIds = new Set(replayableOutbox.map((envelope) => envelope.id));
  const rejectedOutbox = queuedOutbox.filter((envelope) => !replayableIds.has(envelope.id));
  const rejectedRequestIds = new Set<string>();
  await Promise.all(rejectedOutbox.map(async (envelope) => {
    try {
      const decrypted = await crypto.decrypt(envelope);
      if (decrypted.payload.kind === "request") rejectedRequestIds.add(decrypted.payload.requestId);
    } catch {
      // Expired or foreign ciphertext has no safe request identity to restore.
    }
  }));
  if (rejectedOutbox.length > 0) await bridgeVault.removeOutbox(rejectedOutbox.map((envelope) => envelope.id));
  const pendingOutbound = replayableOutbox.length;
  if (connectionAttemptRef.current !== attempt) return;
  setState((current) => hydrateStoredHostState(current, roomId, stored, {
    rejectedRequestIds,
    pendingOutbound,
  }));

  if (
    Capacitor.isNativePlatform() &&
    relayEndpoints.every((endpoint) => isLoopbackRelay(endpoint.url))
  ) {
    const message = "这条配对没有手机可访问的网络地址，请更新电脑端 Bridge 后重试。";
    setState((current) => ({
      ...current,
      connection: "closed",
      connectionIssue: { code: "pairing-invalid", message },
      quickReconnect: quickReconnectAttempt ? { status: "failed", message } : undefined,
    }));
    return;
  }

  const candidates: BridgeTransportCandidate[] = relayEndpoints.map((endpoint) => ({
    id: endpoint.id,
    path: endpoint.kind,
    endpoint: endpoint.url,
    priority: endpoint.priority,
    create: () => new RelayTransport({
      crypto: cryptoWithRelayEndpoint(crypto, endpoint.url),
      role: "mobile",
      reconnect: false,
      path: endpoint.kind,
      heartbeatIntervalMs: 10_000,
      heartbeatTimeoutMs: 25_000,
      connectProbeTimeoutMs: 5_000,
    }),
  }));
  const relay = new TransportRouter(candidates);
  const socket: BridgeTransport = typeof globalThis.RTCPeerConnection === "function"
    ? new WebRtcTransport({
        relay,
        crypto,
        role: "mobile",
        RTCPeerConnectionImpl: globalThis.RTCPeerConnection,
        iceServers: bridgeIceServers(preferredBridgeIceServers(
          provisionalPairing?.iceServers ?? storedHost?.iceServers,
        )),
      })
    : relay;
  socketRef.current = socket;
  nativeRelayCapabilityRef.current = undefined;
  payloadDeflateRef.current = false;
  let bootstrapPending = bootstrap;
  let authenticatedDesktop = false;
  let authenticationTimer: ReturnType<typeof setTimeout> | undefined;
  const isCurrent = () => socketRef.current === socket;
  const isProvisionalPairing = () => pairingPhase?.provisional ?? Boolean(provisionalPairing);
  // Desktop home relay for this room: the relay where the desktop was last
  // seen. Learned from presence frames and fresh authentic traffic, restored
  // from the vault across restarts. See relayLinkAllowsSend for why sends
  // are pinned to it.
  desktopHomeRef.current = provisionalPairing ? undefined : storedHost?.desktopRelayUrl;
  sendAttemptedAtRef.current = undefined;
  let linkHasDesktop = false;
  const learnHome = (url: string) => {
    if (!url.startsWith("ws://") && !url.startsWith("wss://")) return;
    if (desktopHomeRef.current === url) return;
    desktopHomeRef.current = url;
    if (!isProvisionalPairing()) {
      void bridgeVault.setDesktopRelay(roomId, url).catch(() => undefined);
    }
  };
  const linkAllowsSend = () => relayLinkAllowsSend({
    homeRelayUrl: desktopHomeRef.current,
    currentRelayUrl: relay.endpoint,
    desktopHere: linkHasDesktop,
    directPeer: socket.path === "direct",
  });
  linkGateRef.current = linkAllowsSend;
  let outboxFlush: Promise<void> | undefined;
  const flushOutbox = (): Promise<void> => {
    if (outboxFlush) return outboxFlush;
    outboxFlush = (async () => {
      const queued = await bridgeVault.listOutbox(roomId).catch(() => []);
      for (const envelope of queued) {
        if (!isCurrent() || socket.state !== "connected" || !linkAllowsSend()) break;
        if (!isReplayableMobileEnvelope(envelope, { roomId, deviceId: crypto.identity.deviceId })) {
          continue;
        }
        try {
          const decrypted = await crypto.decrypt(envelope);
          if (decrypted.payload.kind === "request") {
            envelopeRequestsRef.current.set(envelope.id, decrypted.payload.requestId);
            // Retired execution requests are never sent or converted to native input.
            if (decrypted.payload.params.bridgeExecutionRequested === true) continue;
          }
          if (decrypted.payload.kind === "request" && (decrypted.payload.method === "turn.start" || decrypted.payload.method === "turn.steer")) {
            const sessionId = decrypted.payload.params.sessionId;
            const session = stateRef.current.snapshot?.sessions.find(candidate => candidate.sessionId === sessionId);
            if ((!session?.runtimeId || session.runtimeId === "claude-desktop") && nativeRelayCapabilityRef.current !== true) continue;
          }
          sendAttemptedAtRef.current = Date.now();
          await socket.sendEnvelope(envelope);
        } catch {
          break;
        }
      }
    })().finally(() => {
      outboxFlush = undefined;
    });
    return outboxFlush;
  };
  // 0.9.5 uplink watchdog: a socket can be half-dead — presence and snapshots
  // flow in, but pings/envelopes never get out (broken middlebox, dead proxy).
  // Heartbeat only sees pong loss after 45s and retries the same path; here we
  // watch the app-level delivery confirmations ("stored"/"acknowledged") and
  // force the router onto the next endpoint when the uplink is provably dead.
  let lastDeliveryConfirmAt = Date.now();
  let lastHuntAt = 0;
  const uplinkWatchdog = setInterval(() => {
    if (!isCurrent()) {
      clearInterval(uplinkWatchdog);
      return;
    }
    void bridgeVault.listOutbox(roomId).then((outbox) => {
      if (!isCurrent()) return;
      const now = Date.now();
      // Home hunting: if this connection is camping on a relay the desktop
      // isn't using, cycle the router so it re-probes the desktop's home
      // relay even when the outbox is empty.
      const home = desktopHomeRef.current;
      if (
        home &&
        relay.endpoint !== home &&
        !linkHasDesktop &&
        now - lastHuntAt > 20_000
      ) {
        lastHuntAt = now;
        relay.cycle();
        return;
      }
      if (outbox.length === 0) return;
      const attemptedAt = sendAttemptedAtRef.current;
      // Half-dead uplink: envelopes were actually written to this link and
      // nothing was confirmed for 25s. Gated sends never attempt, so they
      // cannot trip this.
      if (
        attemptedAt !== undefined &&
        now - lastDeliveryConfirmAt > 25_000 &&
        now - attemptedAt > 25_000
      ) {
        relay.cycle();
        return;
      }
    }).catch(() => undefined);
  }, 10_000);
  const synchronizeDesktop = async () => {
    const bootstrapResume = bootstrapPending;
    bootstrapPending = false;
    const previousSeq = stateRef.current.latestSeq;
    const snapshotSynced = await refreshSnapshot().catch(() => false);
    if (!isCurrent() || socket.state !== "connected") return;
    if (previousSeq > 0) {
      await resumeEvents(false, previousSeq);
    } else if (bootstrapResume || !snapshotSynced) {
      await resumeEvents(true);
    }
    if (!isCurrent() || socket.state !== "connected") return;
    const sessionListSynced = snapshotSynced || await refreshSessionList().catch(() => false);
    if (sessionListSynced && rejectedOutbox.length > 0 && isCurrent()) {
      setState((current) => ({ ...current, connectionIssue: undefined }));
    }
    void flushOutbox();
    void ensureSessionNotificationPermission();
    const push = await nativePushRegistration();
    if (push && isCurrent() && socket.state === "connected") {
      socket.registerPushToken(push.platform, push.token);
    }
  };
  const reportConnectionTimeout = (fallback: MobileConnectionIssue) => {
    setState((current) => {
      const issue = current.connectionIssue?.code === "pairing-invalid" ? current.connectionIssue : fallback;
      return {
        ...current,
        desktopOnline: false,
        connectionIssue: issue,
        quickReconnect: current.quickReconnect?.status === "pending"
          ? { status: "failed", message: issue.message }
          : current.quickReconnect,
      };
    });
  };
  const unreachable: MobileConnectionIssue = {
    code: "unreachable",
    message: "无法连接这台电脑，请确认电脑 Bridge 在线并检查网络。",
  };
  socket.onState((connection) => {
    if (!isCurrent()) return;
    diagLog("info", "bridge", `socket.onState -> ${connection}`, {
      endpoint: socket.endpoint,
      path: socket.path,
      home: desktopHomeRef.current,
      linkHasDesktop,
    });
    if (connection !== "connected") {
      linkHasDesktop = false;
      nativeRelayCapabilityRef.current = undefined;
      payloadDeflateRef.current = false;
    }
    setState((current) => ({
      ...current,
      connection,
      ...(connection === "connected" ? {} : { desktopOnline: false }),
    }));
    if (connection === "connected") {
      if (connectionTimerRef.current) clearTimeout(connectionTimerRef.current);
      if (isProvisionalPairing()) {
        setState((current) => advancePairingSync(current, roomId, "verifying", 38));
      }
      // A manual attempt keeps its handshake deadline even if the Relay drops.
      if (!awaitingQuickReconnect || !authenticationTimer) {
        if (authenticationTimer) clearTimeout(authenticationTimer);
        authenticationTimer = setTimeout(() => {
          authenticationTimer = undefined;
          if (!isCurrent() || authenticatedDesktop) return;
          if (socket.state !== "connected") {
            reportConnectionTimeout(unreachable);
          } else if (!isProvisionalPairing() && desktopHomeRef.current && relay.endpoint !== desktopHomeRef.current) {
            reportConnectionTimeout({
              code: "waiting-link",
              message: "当前网络未连到电脑所在的中继（可能被代理带偏），正在自动重连；消息会保存在手机。",
            });
          } else if (!isProvisionalPairing()) {
            reportConnectionTimeout({
              code: "unreachable",
              message: linkHasDesktop
                ? "未收到电脑的加密回复，请检查电脑端 Bridge 后重试。"
                : "中继未发现电脑，请确认电脑端 Bridge 已启动。",
            });
          } else {
            reportConnectionTimeout({
              code: "pairing-invalid",
              message: "Relay 已连接，但电脑未通过加密握手，请在电脑端重新生成二维码。",
            });
          }
        }, 25_000);
      }
      setState((current) => ({
        ...current,
        connectionIssue: rejectedOutbox.length > 0
          ? relayIssue("INVALID_ENVELOPE", "")
          : undefined,
      }));
      const active = relayEndpoints.find((endpoint) => endpoint.url === socket.endpoint);
      if (active && !isProvisionalPairing()) {
        void bridgeVault.setActiveEndpoint(roomId, active.id).then((host) => {
          if (!host) return;
          cryptoByRoomRef.current.set(roomId, host.crypto);
          setState((current) => ({
            ...current,
            hosts: current.hosts.map((candidate) => candidate.roomId === roomId
              ? { ...candidate, relayUrl: host.relayUrl, needsRepair: false }
              : candidate),
          }));
        }).catch(() => undefined);
      }
      if (!isProvisionalPairing() && linkHasDesktop) void synchronizeDesktop();
    } else if (authenticationTimer && !awaitingQuickReconnect) {
      clearTimeout(authenticationTimer);
      authenticationTimer = undefined;
    }
  });
  socket.onMetrics((metrics) => {
    if (!isCurrent()) return;
    setState((current) => ({
      ...current,
      transportMetrics: metrics,
      hosts: current.hosts.map((host) => host.roomId === roomId
        ? { ...host, path: metrics.path }
        : host),
    }));
  });
  socket.onFrame((frame) => {
    if (!isCurrent()) return;
    if (frame.type === "ready") {
      const desktopHere = frame.onlineDevices.some((device) => device.role === "desktop");
      linkHasDesktop = desktopHere;
      if (desktopHere) {
        learnHome(relay.endpoint);
        if (!awaitingQuickReconnect) {
          setState((current) => ({ ...current, desktopOnline: true, error: undefined }));
        }
        void flushOutbox();
      }
      if (!desktopHere) {
        setState((current) => ({ ...current, desktopOnline: false }));
      }
    }
    if (frame.type === "presence" && frame.role === "desktop") {
      const wasOnline = linkHasDesktop;
      linkHasDesktop = frame.online;
      if (frame.online) {
        learnHome(relay.endpoint);
        if (!awaitingQuickReconnect) {
          setState((current) => ({ ...current, desktopOnline: true, error: undefined }));
        }
        void flushOutbox();
        if (!wasOnline && !isProvisionalPairing() && socket.state === "connected") void synchronizeDesktop();
      }
      if (!frame.online) setState((current) => ({ ...current, desktopOnline: false }));
    }
    if (frame.type === "stored" || frame.type === "acknowledged") {
      const delivery: BridgeDeliveryState = frame.type === "stored" ? "relay-received" : "host-received";
      lastDeliveryConfirmAt = Date.now();
      void bridgeVault.removeOutbox(frame.ids)
        .then(() => bridgeVault.listOutbox(roomId))
        .then((outbox) => {
          if (!isCurrent()) return;
          setState((current) => ({ ...current, pendingOutbound: outbox.length }));
        })
        .catch(() => undefined);
      const requestIds = frame.ids
        .map((id) => envelopeRequestsRef.current.get(id))
        .filter((value): value is string => Boolean(value));
      for (const id of frame.ids) envelopeRequestsRef.current.delete(id);
      setState((current) => ({
        ...current,
        connectionIssue: current.connectionIssue?.code === "waiting-link"
          ? undefined
          : current.connectionIssue,
        localTurns: current.localTurns.map((turn) => (
          requestIds.includes(turn.requestId) &&
          (turn.delivery === "local-saved" || turn.delivery === "relay-received")
            ? { ...turn, delivery }
            : turn
        )),
      }));
    }
    if (frame.type === "error") {
      const issue = relayIssue(frame.code, frame.message);
      if (frame.code === "INVALID_ENVELOPE") {
        const envelopeId = frame.envelopeId;
        const requestId = envelopeId ? envelopeRequestsRef.current.get(envelopeId) : undefined;
        if (envelopeId) {
          envelopeRequestsRef.current.delete(envelopeId);
          void bridgeVault.removeOutbox(envelopeId)
            .then(() => bridgeVault.listOutbox(roomId))
            .then((outbox) => {
              if (!isCurrent()) return;
              setState((current) => ({ ...current, pendingOutbound: outbox.length }));
            })
            .catch(() => undefined);
        }
        if (requestId) {
          const pending = pendingResponsesRef.current.get(requestId);
          if (pending) {
            clearTimeout(pending.timer);
            pendingResponsesRef.current.delete(requestId);
            pending.reject(new Error(issue.message));
          }
        }
        setState((current) => ({
          ...current,
          connectionIssue: issue,
          localTurns: current.localTurns.map((turn) => (
            requestId && turn.requestId === requestId
              ? { ...turn, delivery: "uncertain", error: issue.message }
              : turn
          )),
        }));
        return;
      }
      if (issue.code === "pairing-invalid" && relayEndpoints.length > 1) {
        // A migrated pairing may fail on the new public relay while its
        // legacy endpoint is still serving the same room. Let the transport
        // router try every candidate before marking the host for repair.
        setState((current) => ({ ...current, connectionIssue: issue }));
        return;
      }
      if (issue.code === "pairing-invalid" || issue.code === "revoked") {
        teardownActiveTransport(refs, {
          onlyIfSocket: socket,
          rejectPendingReason: issue.message,
          clearPairingSyncTimer: true,
        });
        if (!isProvisionalPairing()) writeLastActiveHost();
        const keepQuickSwitch = awaitingQuickReconnect;
        setState((current) => ({
          ...clearActiveHostState(current, {
            connection: "closed",
            pairingSync: undefined,
            error: issue.message,
            hosts: isProvisionalPairing()
              ? current.hosts
              : current.hosts.map((host) => host.roomId === roomId
                  ? { ...host, needsRepair: true, status: "offline" }
                  : host),
          }),
          // Keep only the host identity so the open switcher can report why it stopped.
          ...(keepQuickSwitch ? {
            activeHostId: roomId,
            desktopName: current.desktopName,
            quickReconnect: { status: "failed", message: issue.message } as const,
          } : {}),
        }));
        return;
      }
      setState((current) => ({
        ...current,
        connectionIssue: issue,
      }));
    }
  });
  socket.onMessage((message, encrypted) => {
    if (!isCurrent()) return;
    // Relay can replay old ciphertext even when the desktop is offline. A
    // reply to a request sent on this attempt proves it is reachable now.
    const verifiedQuickReconnect = awaitingQuickReconnect && message.payload.kind === "response"
      && pendingResponsesRef.current.has(message.payload.requestId);
    if (verifiedQuickReconnect) awaitingQuickReconnect = false;
    if (!awaitingQuickReconnect) {
      authenticatedDesktop = true;
      if (authenticationTimer) {
        clearTimeout(authenticationTimer);
        authenticationTimer = undefined;
      }
      linkHasDesktop = true;
      // Old queued messages must not teach us a new home relay.
      if (Date.now() - message.header.sentAt < HOME_LEARN_FRESHNESS_MS) {
        learnHome(relay.endpoint);
      }
      setState((current) => ({
        ...current,
        desktopOnline: true,
        connectionIssue: undefined,
        ...(verifiedQuickReconnect ? { quickReconnect: undefined } : {}),
      }));
    }
    socket.ack([encrypted.id]);
    const event = message.payload.kind === "event" ? message.payload.event : undefined;
    const incomingSnapshot = message.payload.kind === "snapshot" ? message.payload.snapshot
      : message.payload.kind === "response" && message.payload.ok
        ? (message.payload.result as { snapshot?: BridgeHostSnapshot } | undefined)?.snapshot
        : undefined;
    const currentState = stateRef.current;
    const currentEvents = currentState.events ?? [];
    const isFreshActionableEvent = Boolean(
      event
      && !isEventNotificationStale(event)
      && event.seq > (currentState.snapshotSeq ?? 0)
      && !currentEvents.some((seenEvent) => seenEvent.eventId === event.eventId),
    );
    const candidatePermission = isFreshActionableEvent && event ? permissionFromEvent(event) : undefined;
    const requestedPermission = candidatePermission && !currentEvents.some((seenEvent) => (
      (seenEvent.type === "permission.resolved" || seenEvent.type === "question.resolved")
      && seenEvent.data.requestId === candidatePermission.requestId
    ))
      ? candidatePermission
      : undefined;
    const newPermissions = (incomingSnapshot?.permissions ?? (requestedPermission ? [requestedPermission] : []))
      .filter((permission) => !(currentState.permissions ?? []).some((current) => current.requestId === permission.requestId));
    const candidatePrompt = isFreshActionableEvent && event?.type === "prompt.requested" && typeof event.data.promptId === "string"
      ? (event.data as unknown as BridgePendingPrompt)
      : undefined;
    const requestedPrompt = candidatePrompt && !currentEvents.some((seenEvent) => (
      seenEvent.type === "prompt.resolved"
      && seenEvent.sessionId === candidatePrompt.sessionId
      && seenEvent.data.promptId === candidatePrompt.promptId
    ))
      ? candidatePrompt
      : undefined;
    const existingPrompts = currentState.snapshot?.prompts ?? [];
    const newPrompts = (incomingSnapshot?.prompts ?? (requestedPrompt ? [requestedPrompt] : []))
      .filter((prompt) => !existingPrompts.some(
        (current) => current.promptId === prompt.promptId && current.sessionId === prompt.sessionId,
      ));
    const isNewPermission = newPermissions.length > 0;
    const isNewPrompt = newPrompts.length > 0;
    // Drop stale queued RPC responses (>60s old with no active waiter) before
    // they trigger redundant state Churn on reconnect.
    if (message.payload.kind === "response" && Date.now() - message.header.sentAt > 60_000) {
      const responseRequestId = message.payload.requestId;
      if (
        !pendingResponsesRef.current.has(responseRequestId) &&
        !stateRef.current.localTurns.some((turn) => turn.requestId === responseRequestId)
      ) {
        return;
      }
    }
    if (message.payload.kind === "response" && message.payload.ok && pendingResponsesRef.current.has(message.payload.requestId)) {
      const snapshot = (message.payload.result as { snapshot?: BridgeHostSnapshot } | undefined)?.snapshot;
      if (snapshot) {
        nativeRelayCapabilityRef.current = isClaudeNativeRelay(snapshot);
        payloadDeflateRef.current = snapshot.host.capabilities.includes(PAYLOAD_DEFLATE_CAPABILITY);
        void flushOutbox();
      }
    }
    if (message.payload.kind === "snapshot") {
      nativeRelayCapabilityRef.current = isClaudeNativeRelay(message.payload.snapshot);
      payloadDeflateRef.current = message.payload.snapshot.host.capabilities.includes(PAYLOAD_DEFLATE_CAPABILITY);
      void flushOutbox();
    }
    if (event) notifyCompletedTurns([event], crypto, { bootstrap: isProvisionalPairing() });
    handlePayload(message.payload, encrypted, crypto);
    const isVisible = typeof document !== "undefined" && document.visibilityState === "visible";
    if ((isNewPermission || isNewPrompt) && isVisible) {
      navigator.vibrate?.([120, 60, 120]);
    }
    const isDesktopApp = typeof window !== "undefined" && Boolean(window.bridgeDesktop);
    if (!isDesktopApp && !isProvisionalPairing() && isSessionNotificationsEnabled()) {
      const sourceSessions = (incomingSnapshot ?? stateRef.current.snapshot)?.sessions;
      if (Capacitor.isNativePlatform()) {
        for (const permission of newPermissions) {
          if (isVisible && isActivelyViewingSession(roomId, permission.sessionId)) continue;
          void showSessionNotification(
            { hostId: roomId, sessionId: permission.sessionId },
            sourceSessions?.find((session) => session.sessionId === permission.sessionId)?.title
              ?? crypto.identity.desktopName,
            "Claude 正在等待你处理",
          );
        }
        for (const prompt of newPrompts) {
          if (isVisible && isActivelyViewingSession(roomId, prompt.sessionId)) continue;
          void showSessionNotification(
            { hostId: roomId, sessionId: prompt.sessionId },
            sourceSessions?.find((session) => session.sessionId === prompt.sessionId)?.title
              ?? crypto.identity.desktopName,
            "Claude 正在等待你确认",
          );
        }
      } else {
        for (const permission of newPermissions) {
          if (isVisible && isActivelyViewingSession(roomId, permission.sessionId)) continue;
          showBrowserDesktopOrWebNotification(
            sourceSessions?.find((session) => session.sessionId === permission.sessionId)?.title
              ?? crypto.identity.desktopName,
            "Claude 正在等待你处理",
            `perm:${permission.requestId}`,
          );
        }
        for (const prompt of newPrompts) {
          if (isVisible && isActivelyViewingSession(roomId, prompt.sessionId)) continue;
          showBrowserDesktopOrWebNotification(
            sourceSessions?.find((session) => session.sessionId === prompt.sessionId)?.title
              ?? crypto.identity.desktopName,
            "Claude 正在等待你确认",
            `prompt:${prompt.promptId}`,
          );
        }
      }
    }
    // Avoid flooding IndexedDB with stale catch-up events during a queued
    // replay burst; refreshSnapshot() + resumeEvents() persists the rebased
    // state right after reconnect.
    const isStaleReplayEvent = (
      message.payload.kind === "event" &&
      Date.now() - message.header.sentAt > 60_000 &&
      message.payload.event.type !== "permission.requested" &&
      message.payload.event.type !== "question.requested" &&
      message.payload.event.type !== "prompt.requested"
    );
    if (
      !isStaleReplayEvent &&
      shouldPersistIncomingMessage(message.payload, stateRef.current.localTurns)
    ) {
      void (async () => {
        const cachedEnvelope = shouldExtendLocalEvidenceCache(message.payload)
          ? await crypto.encrypt(
              message.payload.kind === "event"
                ? { ...message.payload, event: summarizeEvidenceEvent(message.payload.event) }
                : message.payload.kind === "response" && evidencePageFromResponse(message.payload)
                  ? { ...message.payload, result: { ...(message.payload.result as Record<string, unknown>), evidence: {
                      ...evidencePageFromResponse(message.payload)!,
                      items: evidencePageFromResponse(message.payload)!.items.map(evidenceSummary),
                    } } }
                  : message.payload,
              message.header.from,
              message.header.to,
              Date.now(),
              LOCAL_EVIDENCE_CACHE_TTL_MS,
              message.header.to === "mobile" ? crypto.identity.deviceId : undefined,
            )
          : encrypted;
        // Keep the latest progress per task/session without evicting the offline catalog.
        await bridgeVault.saveMessage(cachedEnvelope,
          event?.itemId && (event.type === "tool.progress" ||
            (event.type === "runtime.updated" && event.itemId === "session:subagent-activity"))
            ? { key: JSON.stringify(["progress", cachedEnvelope.roomId, event.sessionId, event.type, event.itemId]), seq: event.seq }
            : undefined,
        );
      })().catch(() => undefined);
    }
  });
  diagLog("info", "bridge", `调用 socket.connect() -> ${relay.endpoint}`);
  socket.connect();
  connectionTimerRef.current = setTimeout(() => {
    if (!isCurrent() || socket.state === "connected") return;
    diagLog("error", "bridge", `connectionTimer 超时: state=${socket.state} endpoint=${socket.endpoint}`);
    reportConnectionTimeout(unreachable);
  }, Math.max(12_000, relayEndpoints.length * 8_000 + 2_000));
}

export function syncBridgeDiagnostics(state: MobileBridgeState): void {
  setDiagBridgeStateSummary({
    loading: state.loading,
    activeHostId: state.activeHostId,
    desktopName: state.desktopName,
    connection: state.connection,
    desktopOnline: state.desktopOnline,
    latestSeq: state.latestSeq,
    pendingOutbound: state.pendingOutbound,
    connectionIssue: state.connectionIssue,
    transportMetrics: state.transportMetrics,
    error: state.error,
    hostsCount: state.hosts.length,
    hosts: state.hosts.map((h) => ({
      roomId: h.roomId,
      desktopName: h.desktopName,
      relayUrl: h.relayUrl,
      needsRepair: h.needsRepair,
      status: h.status,
      path: h.path,
    })),
  });
}

export type StartBridgeFn = (
  crypto: BridgeCrypto,
  bootstrap?: boolean,
  focusSessionId?: string,
  provisionalPairing?: PairingBundle,
  pairingPhase?: PairingConnectionPhase,
  restored?: StoredHostState,
) => Promise<void>;

export function bootstrapStoredBridgeHosts(
  refs: ActiveTransportTeardownRefs & Pick<BridgeTransportRefs, "setState" | "cryptoByRoomRef">,
  start: StartBridgeFn,
): () => void {
  const {
    setState,
    cryptoByRoomRef,
  } = refs;
  let active = true;
  void (async () => {
    diagLog("info", "bridge", "读取本机已配对主机列表 (bridgeVault.listHosts)...");
    const hosts = await bridgeVault.listHosts();
    diagLog("info", "bridge", `bridgeVault.listHosts 返回 ${hosts.length} 台主机`, hosts.map((h) => ({
      roomId: h.roomId,
      relayUrl: h.relayUrl,
      desktopRelayUrl: h.desktopRelayUrl,
      needsRepair: h.needsRepair,
    })));
    if (!active) return;
    cryptoByRoomRef.current = new Map(hosts.map((host) => [host.roomId, host.crypto]));
    const restored = await Promise.all(hosts.map(host => readStoredHostState(host.crypto)));
    const summaries = hosts.map((host, index) => hostSummary(host, restored[index]!.snapshot, restored[index]!.permissions));
    if (!active) return;
    setState((current) => ({ ...current, loading: false, hosts: summaries }));
    const lastRoomId = readLastActiveHost();
    const lastHost = (lastRoomId ? hosts.find((host) => host.roomId === lastRoomId) : undefined)
      ?? (hosts.length === 1 ? hosts[0] : undefined);
    if (lastRoomId && (!lastHost || lastHost.needsRepair)) writeLastActiveHost();
    if (lastHost && !lastHost.needsRepair) {
      writeLastActiveHost(lastHost.roomId);
      await start(lastHost.crypto, false, undefined, undefined, undefined, restored[hosts.indexOf(lastHost)]);
    } else {
      diagLog("warn", "bridge", "未自动启动连接", {
        lastRoomId,
        hostsCount: hosts.length,
        needsRepair: lastHost?.needsRepair,
      });
    }
  })().catch((err) => {
    diagLog("error", "bridge", "读取本机配对信息异常", err instanceof Error ? err.message : String(err));
    setState((current) => ({
      ...current,
      loading: false,
      error: "无法读取本机配对信息",
    }));
  });
  return () => {
    active = false;
    teardownActiveTransport(refs, {
      clearPairingSyncTimer: true,
      preserveCrypto: true,
    });
  };
}

export function reconnectAndResumeBridge(
  socketRef: MutableRefObject<BridgeTransport | undefined>,
  refreshSnapshot: () => Promise<boolean>,
  resumeEvents: () => Promise<void>,
  networkChanged = false,
): void {
  const socket = socketRef.current;
  if (!socket) return;
  if (networkChanged) socket.close();
  socket.connect();
  if (!networkChanged && socket.state === "connected") {
    void refreshSnapshot().catch(() => undefined);
    void resumeEvents();
  }
}

export function subscribeNetworkAndVisibilityWake(
  reconnectAndResume: (networkChanged?: boolean) => void,
): () => void {
  const network = (navigator as Navigator & { connection?: EventTarget & { type?: string } }).connection;
  let networkType = network?.type;
  const online = () => {
    networkType = network?.type;
    // Android can report online just before changing its interface from none.
    if (networkType !== "none") reconnectAndResume(true);
  };
  const networkChanged = () => {
    if (network?.type === networkType) return;
    networkType = network?.type;
    if (navigator.onLine) reconnectAndResume(true);
  };
  const visibilityChanged = () => {
    if (document.visibilityState === "visible") reconnectAndResume();
  };
  window.addEventListener("online", online);
  network?.addEventListener("change", networkChanged);
  document.addEventListener("visibilitychange", visibilityChanged);
  return () => {
    window.removeEventListener("online", online);
    network?.removeEventListener("change", networkChanged);
    document.removeEventListener("visibilitychange", visibilityChanged);
  };
}

export function subscribeCapacitorAppWake(
  reconnectAndResume: (networkChanged?: boolean) => void,
): (() => void) | undefined {
  if (!Capacitor.isNativePlatform()) return undefined;
  let active = true;
  let remove: (() => Promise<void>) | undefined;
  void CapacitorApp.addListener("appStateChange", ({ isActive }) => {
    if (isActive) reconnectAndResume();
  }).then((handle) => {
    if (!active) void handle.remove();
    else remove = () => handle.remove();
  }).catch(() => undefined);
  return () => {
    active = false;
    void remove?.();
  };
}

export async function pairBridgeHost(
  refs: ActiveTransportTeardownRefs & Pick<
    BridgeTransportRefs,
    "setState" | "stateRef" | "cryptoByRoomRef"
  >,
  actions: {
    start: StartBridgeFn;
    sendRequest: BridgeSendRequest;
    refreshSnapshot: (verifiedSnapshot?: BridgeHostSnapshot) => Promise<boolean>;
    resumeEvents: (bootstrap?: boolean, fromSeq?: number) => Promise<void>;
  },
  pairing: PairingBundle,
): Promise<boolean> {
  const { setState, stateRef, cryptoRef, cryptoByRoomRef, socketRef, pairingSyncTimerRef } = refs;
  const { start, sendRequest, refreshSnapshot, resumeEvents } = actions;

  if (pairingSyncTimerRef.current) clearTimeout(pairingSyncTimerRef.current);
  setState((current) => ({
    ...current,
    loading: true,
    error: undefined,
    pairingSync: {
      roomId: pairing.roomId,
      desktopName: pairing.desktopName,
      stage: "connecting",
      progress: 14,
    },
  }));
  if (
    Capacitor.isNativePlatform() &&
    pairing.relayEndpoints.every((endpoint) => isLoopbackRelay(endpoint.url))
  ) {
    setState((current) => ({
      ...current,
      loading: false,
      pairingSync: undefined,
      error: "电脑端二维码来自旧版本，请先更新电脑端 Bridge。",
    }));
    return false;
  }
  const previousLastActiveHost = readLastActiveHost();
  let preparedCrypto: BridgeCrypto | undefined;
  const pairingPhase: PairingConnectionPhase = { provisional: true };
  try {
    const crypto = await BridgeCrypto.fromPairing(pairing, {
      instanceId: pendingPairingInstanceId(pairing.roomId, pairing.deviceId),
    });
    preparedCrypto = crypto;
    await start(crypto, true, undefined, pairing, pairingPhase);
    const connectDeadline = Date.now() + 20_000;
    while (socketRef.current?.state !== "connected") {
      if (cryptoRef.current !== crypto) {
        throw new Error(stateRef.current.error ?? "电脑端已拒绝这次配对");
      }
      if (Date.now() >= connectDeadline) throw new Error("连接电脑超时");
      await delay(100);
    }
    const response = await sendRequest("snapshot.get", {}, {
      wait: true,
      timeoutMs: 20_000,
    });
    const verifiedSnapshot = confirmedPairingSnapshot(pairing, response);
    crypto.identity.desktopName = verifiedSnapshot.host.name;
    setState((current) => advancePairingSync(current, crypto.identity.roomId, "syncing", 56, verifiedSnapshot.host.name));
    await bridgeVault.importPairing(pairing, crypto);
    clearPendingPairingInstanceId(pairing.roomId, pairing.deviceId);
    cryptoByRoomRef.current.set(crypto.identity.roomId, crypto);
    pairingPhase.provisional = false;
    const nextHost = hostSummary({
      hostId: pairing.hostId,
      pairingEpoch: pairing.pairingEpoch,
      roomId: crypto.identity.roomId,
      desktopName: crypto.identity.desktopName,
      relayUrl: crypto.identity.relayUrl,
      serviceOrigin: pairing.serviceOrigin,
      relayEndpoints: pairing.relayEndpoints,
      activeEndpoint: pairing.activeEndpoint,
      iceServers: preferredBridgeIceServers(pairing.iceServers),
      updatedAt: Date.now(),
      needsRepair: false,
      crypto,
    }, verifiedSnapshot, verifiedSnapshot.permissions);
    setState((current) => replaceActiveHostSnapshot(current, crypto.identity.roomId, verifiedSnapshot, {
      loading: false,
      desktopOnline: true,
      hosts: [
        nextHost,
        ...current.hosts.filter((host) => host.hostId !== nextHost.hostId),
      ],
      ...(current.pairingSync?.roomId === crypto.identity.roomId
        ? { pairingSync: { ...current.pairingSync, stage: "syncing", progress: 66 } }
        : {}),
    }));
    writeLastActiveHost(crypto.identity.roomId);
    setState((current) => advancePairingSync(current, crypto.identity.roomId, "syncing", 72));
    await refreshSnapshot(verifiedSnapshot);
    await resumeEvents(true);
    setState((current) => advancePairingSync(current, crypto.identity.roomId, "syncing", 80));
    setState((current) => advancePairingSync(current, crypto.identity.roomId, "ready", 100));
    void ensureSessionNotificationPermission();
    void nativePushRegistration().then((push) => {
      if (push && cryptoRef.current === crypto && socketRef.current?.state === "connected") {
        socketRef.current.registerPushToken(push.platform, push.token);
      }
    }).catch(() => undefined);
    pairingSyncTimerRef.current = setTimeout(() => {
      setState((current) => (
        current.pairingSync?.roomId === crypto.identity.roomId && current.pairingSync.stage === "ready"
          ? { ...current, pairingSync: undefined }
          : current
      ));
    }, 650);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const userError = /expired/iu.test(message)
      ? "二维码已超过十分钟，请在电脑端重新生成"
      : /prepared pairing|identity|身份/iu.test(message)
        ? "二维码身份校验失败，请在电脑端重新生成"
        : "未能与电脑完成加密配对，请在电脑端重新生成二维码后重试。";
    const stillOwnsActiveTransport = !preparedCrypto || !cryptoRef.current || cryptoRef.current === preparedCrypto;
    if (stillOwnsActiveTransport) {
      teardownActiveTransport(refs, {
        rejectPendingReason: message || "配对失败",
        clearPairingSyncTimer: true,
      });
      writeLastActiveHost(previousLastActiveHost);
    }
    if (preparedCrypto) {
      await bridgeVault.removeDeviceArtifacts(
        preparedCrypto.identity.roomId,
        preparedCrypto.identity.deviceId,
      ).catch(() => undefined);
    }
    setState((current) => (
      stillOwnsActiveTransport || (preparedCrypto && current.activeHostId === preparedCrypto.identity.roomId)
        ? clearActiveHostState(current, {
            loading: false,
            connection: "closed",
            pairingSync: undefined,
            error: userError,
          })
        : {
            ...current,
            loading: false,
            ...(current.pairingSync?.roomId === pairing.roomId ? { pairingSync: undefined } : {}),
            error: userError,
          }
    ));
    return false;
  }
}

export async function selectBridgeHost(
  refs: Pick<BridgeTransportRefs, "setState" | "cryptoByRoomRef">,
  start: StartBridgeFn,
  roomId: string,
  focusSessionId?: string,
): Promise<void> {
  const { setState, cryptoByRoomRef } = refs;
  let crypto = cryptoByRoomRef.current.get(roomId);
  if (!crypto) {
    const hosts = await bridgeVault.listHosts();
    cryptoByRoomRef.current = new Map(hosts.map((host) => [host.roomId, host.crypto]));
    crypto = cryptoByRoomRef.current.get(roomId);
  }
  if (!crypto) throw new Error("Paired host not found");
  const storedHost = await bridgeVault.getHost(roomId);
  if (storedHost?.needsRepair) {
    setState((current) => ({
      ...current,
      error: "V0.4.0 已轮换安全密钥，请在电脑端重新生成二维码。",
    }));
    return;
  }
  await bridgeVault.touchHost(crypto).catch(() => undefined);
  await start(crypto, false, focusSessionId);
}

export function backToBridgeHosts(
  refs: ActiveTransportTeardownRefs & Pick<BridgeTransportRefs, "setState">,
): void {
  const { setState } = refs;
  teardownActiveTransport(refs, {
    rejectPendingReason: "已返回主机列表",
    clearPairingSyncTimer: true,
  });
  writeLastActiveHost();
  setState((current) => clearActiveHostState(current));
}

export async function refreshBridgeHostState(
  refs: Pick<BridgeTransportRefs, "setState" | "cryptoRef" | "socketRef">,
  actions: {
    sendRequest: BridgeSendRequest;
    resumeEvents: () => Promise<void>;
    refreshSnapshot: () => Promise<boolean>;
    refreshSessionList: () => Promise<boolean>;
    controlClaudeDesktop: (action: "status" | "launch" | "quit") => Promise<ClaudeDesktopAppStatus>;
    openSession: (sessionId: string) => Promise<void>;
  },
  sessionId?: string,
): Promise<boolean> {
  const { setState, cryptoRef, socketRef } = refs;
  const { sendRequest, resumeEvents, refreshSnapshot, refreshSessionList, controlClaudeDesktop, openSession } = actions;
  const crypto = cryptoRef.current;
  const socket = socketRef.current;
  const isCurrent = () => cryptoRef.current === crypto && socketRef.current === socket;
  try {
    // Ask the desktop to re-discover native sessions first; otherwise a
    // manual sync can only echo the desktop's cached snapshot and sessions
    // created on the computer never reach the phone. Tolerate failure so
    // older desktops still serve their cached state below.
    await sendRequest("runtime.refresh", {}, { wait: true, timeoutMs: 45_000 }).catch(() => undefined);
    if (!isCurrent()) return false;
    await resumeEvents();
    if (!isCurrent()) return false;
    let snapshotSynced = false;
    let snapshotError: unknown;
    try {
      snapshotSynced = await refreshSnapshot();
    } catch (error) {
      snapshotError = error;
    }
    if (!isCurrent()) return false;
    if (!snapshotSynced) {
      const sessionListSynced = await refreshSessionList().catch(() => false);
      if (!isCurrent()) return false;
      await controlClaudeDesktop("status").catch(() => undefined);
      if (!isCurrent()) return false;
      if (!sessionListSynced) {
        throw snapshotError instanceof Error ? snapshotError : new Error("电脑端同步失败");
      }
    }
    if (sessionId) await openSession(sessionId);
    return isCurrent();
  } catch (error) {
    setState((current) => isCurrent() ? {
      ...current,
      error: error instanceof Error ? error.message : "电脑端同步失败",
    } : current);
    return false;
  }
}

export async function forgetBridgeHost(
  refs: ActiveTransportTeardownRefs & Pick<BridgeTransportRefs, "setState" | "cryptoByRoomRef">,
  sendRequest: BridgeSendRequest,
  roomId: string,
): Promise<void> {
  const { setState, cryptoRef, cryptoByRoomRef, socketRef } = refs;
  const crypto = cryptoByRoomRef.current.get(roomId);
  const active = cryptoRef.current?.identity.roomId === roomId;
  if (active && crypto && socketRef.current?.state === "connected") {
    await sendRequest("device.revoke", { deviceId: crypto.identity.deviceId }, { wait: true }).catch(() => undefined);
  } else if (!active && crypto) {
    await revokeRemoteDevice(crypto).catch(() => undefined);
  }
  if (active) {
    teardownActiveTransport(refs, {
      rejectPendingReason: "已移除该电脑配对",
      clearPairingSyncTimer: true,
    });
  }
  if (readLastActiveHost() === roomId) writeLastActiveHost();
  await bridgeVault.removeHost(roomId);
  cryptoByRoomRef.current.delete(roomId);
  setState((current) => {
    const hosts = current.hosts.filter((host) => host.roomId !== roomId);
    return current.activeHostId === roomId
      ? clearActiveHostState(current, { hosts })
      : { ...current, hosts };
  });
}

export async function setBridgeRelayUrl(
  refs: Pick<BridgeTransportRefs, "setState" | "stateRef" | "cryptoByRoomRef">,
  start: StartBridgeFn,
  url: string,
): Promise<void> {
  const { setState, stateRef, cryptoByRoomRef } = refs;
  const roomId = stateRef.current.activeHostId;
  if (!roomId) throw new Error("请先选择电脑");
  const host = await bridgeVault.setRelayUrl(roomId, url);
  if (!host) throw new Error("未找到已配对电脑");
  cryptoByRoomRef.current.set(roomId, host.crypto);
  setState((current) => ({ ...current, hosts: current.hosts.map((item) => item.roomId === roomId ? { ...item, relayUrl: host.relayUrl } : item) }));
  await start(host.crypto);
}
