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
  type BridgePermissionInfo,
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
import { ensureSessionNotificationPermission, showSessionNotification } from "../../lib/session-notifications.js";
import { bridgeVault } from "../../lib/vault.js";
import type { BridgeSendRequest } from "./bridge-artifacts.js";
import {
  HOME_LEARN_FRESHNESS_MS,
  LOCAL_EVIDENCE_CACHE_TTL_MS,
  advancePairingSync,
  applyEventToSnapshot,
  applyEventToTurns,
  applyEventsToSnapshot,
  applyPermissionEvent,
  applyUnseenPermissionEvents,
  confirmedPairingSnapshot,
  evidenceFromEvent,
  evidencePageFromResponse,
  hostSummary,
  hostWithRuntimeState,
  isBridgeResponse,
  isClaudeNativeRelay,
  isLoopbackRelay,
  mergeAcceptedDelivery,
  mergeBridgeEvents,
  mergeEvidence,
  permissionFromEvent,
  previewFromResponse,
  rebaseSnapshot,
  relayIssue,
  relayLinkAllowsSend,
  shouldExtendLocalEvidenceCache,
  shouldPersistIncomingMessage,
  snapshotWithPermissions,
  type LocalTurn,
  type MobileBridgeState,
  type PairingConnectionPhase,
  type PendingResponse,
  type SessionEvidenceState,
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

export interface StoredHostState {
  snapshot?: BridgeHostSnapshot;
  snapshotSeq: number;
  permissions: BridgePermissionInfo[];
  events: BridgeEvent[];
  evidence: Record<string, SessionEvidenceState>;
  artifactPreviews: Record<string, BridgeArtifactPreview>;
  localTurns: LocalTurn[];
  latestSeq: number;
}

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
    const response = message.payload;
    const turnIndex = appliedTurns.findIndex((turn) => turn.requestId === response.requestId);
    if (turnIndex < 0) continue;
    const turn = appliedTurns[turnIndex]!;
    if (response.ok) {
      const result = response.result as { commandId?: unknown; state?: unknown } | undefined;
      const terminalDelivery: BridgeDeliveryState | undefined = result?.state === "completed"
        ? "completed"
        : result?.state === "failed"
          ? "failed"
          : result?.state === "cancelled"
            ? "cancelled"
            : undefined;
      appliedTurns[turnIndex] = {
        ...turn,
        delivery: terminalDelivery ?? (result?.state === "submitted" ? mergeAcceptedDelivery(turn.delivery, "submitted")
          : turn.delivery === "local-saved" ? "host-received" : turn.delivery),
        ...(typeof result?.commandId === "string" ? { commandId: result.commandId } : {}),
      };
    } else {
      appliedTurns[turnIndex] = {
        ...turn,
        delivery: "failed",
        error: response.error?.message ?? "请求失败",
      };
    }
  }
  const storedSnapshot = snapshotWithPermissions(replayedSnapshot, permissions);
  const evidence = events.reduce<Record<string, SessionEvidenceState>>((result, event) => {
    const item = evidenceFromEvent(event);
    if (!item) return result;
    const current = result[item.sessionId] ?? {
      status: "ready" as const,
      items: [],
      hasMore: false,
    };
    result[item.sessionId] = {
      ...current,
      items: mergeEvidence(current.items, [item]),
    };
    return result;
  }, {});
  const artifactPreviews: Record<string, BridgeArtifactPreview> = {};
  for (const message of messages) {
    if (!isBridgeResponse(message.payload)) continue;
    const preview = previewFromResponse(message.payload);
    if (preview) artifactPreviews[preview.artifactId] = preview;
    const page = evidencePageFromResponse(message.payload);
    if (!page) continue;
    const current = evidence[page.sessionId] ?? {
      status: "ready" as const,
      items: [],
      hasMore: page.hasMore,
    };
    evidence[page.sessionId] = {
      status: "ready",
      items: mergeEvidence(current.items, page.items),
      hasMore: current.hasMore || page.hasMore,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
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

export function updateBridgeHostCache(
  setState: Dispatch<SetStateAction<MobileBridgeState>>,
  roomId: string,
  snapshot: BridgeHostSnapshot,
  permissions: BridgePermissionInfo[] = snapshot.permissions,
): void {
  setState((current) => ({
    ...current,
    hosts: current.hosts.map((host) => host.roomId === roomId
      ? hostWithRuntimeState(host, snapshot, permissions)
      : host),
  }));
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
    setState((current) => {
      if (payload.snapshot.latestSeq < current.snapshotSeq) return current;
      const rebased = rebaseSnapshot(payload.snapshot, current.events, current.permissions);
      return {
        ...current,
        snapshot: rebased.snapshot,
        snapshotSeq: payload.snapshot.latestSeq,
        permissions: rebased.permissions,
        desktopName: rebased.snapshot.host.name,
        latestSeq: rebased.latestSeq,
        hosts: current.hosts.map((host) => host.roomId === crypto.identity.roomId
          ? hostWithRuntimeState(host, rebased.snapshot, rebased.permissions)
          : host),
      };
    });
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
    setState((current) => {
      const permissions = applyUnseenPermissionEvents(current.permissions, [event], current.events, current.snapshotSeq);
      const snapshot = snapshotWithPermissions(applyEventToSnapshot(current.snapshot, event, permissions), permissions);
      const evidenceItem = evidenceFromEvent(payload.event);
      const evidence = evidenceItem ? {
        ...current.evidence,
        [evidenceItem.sessionId]: {
          status: "ready" as const,
          items: mergeEvidence(
            current.evidence[evidenceItem.sessionId]?.items ?? [],
            [evidenceItem],
          ),
          hasMore: current.evidence[evidenceItem.sessionId]?.hasMore ?? false,
          ...(current.evidence[evidenceItem.sessionId]?.nextCursor
            ? { nextCursor: current.evidence[evidenceItem.sessionId]!.nextCursor }
            : {}),
        },
      } : current.evidence;
      return {
        ...current,
        snapshot,
        permissions,
        events: mergeBridgeEvents(current.events, [payload.event]),
        evidence,
        localTurns: applyEventToTurns(current.localTurns, payload.event),
        latestSeq: Math.max(current.latestSeq, payload.event.seq),
        hosts: current.hosts.map((host) => host.roomId === crypto.identity.roomId
          ? hostWithRuntimeState(host, snapshot, permissions)
          : host),
      };
    });
    return;
  }
  if (payload.kind !== "response") return;
  setState((current) => {
    const index = current.localTurns.findIndex((turn) => turn.requestId === payload.requestId);
    if (index < 0) return current;
    const localTurns = [...current.localTurns];
    const turn = localTurns[index]!;
    if (payload.ok) {
      const result = payload.result as { commandId?: unknown; state?: unknown } | undefined;
      const terminalDelivery: BridgeDeliveryState | undefined = result?.state === "completed"
        ? "completed"
        : result?.state === "failed"
          ? "failed"
          : result?.state === "cancelled"
            ? "cancelled"
            : undefined;
      localTurns[index] = {
        ...turn,
        delivery: terminalDelivery ?? (result?.state === "submitted" ? mergeAcceptedDelivery(turn.delivery, "submitted")
          : turn.delivery === "local-saved" || turn.delivery === "relay-received" ? "host-received" : turn.delivery),
        ...(typeof result?.commandId === "string" ? { commandId: result.commandId } : {}),
      };
    } else {
      localTurns[index] = {
        ...turn,
        delivery: "failed",
        error: payload.error?.message ?? "请求失败",
      };
    }
    return { ...current, localTurns };
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
    pendingResponsesRef.current.set(request.requestId, { resolve, reject, timer });
  }) : undefined;
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

export function notifyBridgeCompletedTurns(
  refs: Pick<BridgeTransportRefs, "stateRef" | "pendingCompletionNotificationsRef">,
  events: BridgeEvent[],
  crypto: BridgeCrypto,
): void {
  const completed = events.filter((event) => event.type === "turn.completed" || event.type === "turn.failed");
  if (completed.length === 0) return;
  const seen = new Set(refs.stateRef.current.events.map((event) => event.eventId));
  const pending = refs.pendingCompletionNotificationsRef.current;
  // The state event list owns committed IDs. Keep only IDs awaiting a React
  // commit so queued delivery and resume cannot notify twice in the same batch.
  for (const id of pending) if (seen.has(id)) pending.delete(id);
  for (const event of completed) {
    if (seen.has(event.eventId) || pending.has(event.eventId)) continue;
    pending.add(event.eventId);
    if (document.visibilityState === "visible") continue;
    const title = refs.stateRef.current.snapshot?.sessions.find((session) => session.sessionId === event.sessionId)?.title
      ?? crypto.identity.desktopName;
    const body = event.type === "turn.completed" ? "任务已完成" : "任务失败";
    if (Capacitor.isNativePlatform()) {
      void showSessionNotification(
        { hostId: crypto.identity.roomId, ...(event.sessionId ? { sessionId: event.sessionId } : {}) },
        title,
        body,
      );
    } else if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      new Notification(title, { body, icon: "/icon-192.png", tag: event.eventId });
    }
  }
}

export async function resumeBridgeEvents(
  refs: Pick<BridgeTransportRefs, "setState" | "stateRef" | "cryptoRef" | "socketRef">,
  sendRequest: BridgeSendRequest,
  notifyCompletedTurns: (events: BridgeEvent[], crypto: BridgeCrypto) => void,
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
    if (crypto) notifyCompletedTurns(events, crypto);
    setState((current) => {
      if (!isCurrent()) return current;
      let turns = current.localTurns;
      let evidence = current.evidence;
      for (const event of events) {
        turns = applyEventToTurns(turns, event);
        const item = evidenceFromEvent(event);
        if (item) {
          evidence = {
            ...evidence,
            [item.sessionId]: {
              status: "ready",
              items: mergeEvidence(evidence[item.sessionId]?.items ?? [], [item]),
              hasMore: evidence[item.sessionId]?.hasMore ?? false,
              ...(evidence[item.sessionId]?.nextCursor
                ? { nextCursor: evidence[item.sessionId]!.nextCursor }
                : {}),
            },
          };
        }
      }
      const applied = applyEventsToSnapshot(current.snapshot, events, current.permissions);
      const permissions = applyUnseenPermissionEvents(current.permissions, events, current.events, current.snapshotSeq);
      const snapshot = snapshotWithPermissions(applied.snapshot, permissions);
      return {
        ...current,
        snapshot,
        permissions,
        events: mergeBridgeEvents(current.events, events),
        evidence,
        localTurns: turns,
        latestSeq: Math.max(current.latestSeq, cursor),
        hosts: current.hosts.map((host) => host.roomId === current.activeHostId
          ? hostWithRuntimeState(host, snapshot, permissions)
          : host),
      };
    });
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
  setState((current) => isCurrent() && current.snapshot ? {
    ...current,
    snapshot: { ...current.snapshot, sessions: result.sessions! },
  } : current);
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
  setState((current) => {
    if (!isCurrent() || verifiedSnapshot!.latestSeq < current.snapshotSeq) return current;
    const rebased = rebaseSnapshot(verifiedSnapshot!, current.events, current.permissions);
    return {
      ...current,
      snapshot: rebased.snapshot,
      snapshotSeq: verifiedSnapshot!.latestSeq,
      permissions: rebased.permissions,
      desktopName: rebased.snapshot.host.name,
      // The answer itself shows the desktop online; its host.online can be stale (see handlePayload).
      latestSeq: rebased.latestSeq,
      error: undefined,
      hosts: current.hosts.map((host) => host.roomId === roomId
        ? hostWithRuntimeState(host, rebased.snapshot, rebased.permissions)
        : host),
    };
  });
  return true;
}

export interface StartBridgeCallbacks {
  handlePayload: (payload: BridgePayload, encrypted: EncryptedEnvelope, crypto: BridgeCrypto) => void;
  notifyCompletedTurns: (events: BridgeEvent[], crypto: BridgeCrypto) => void;
  refreshSessionList: () => Promise<boolean>;
  refreshSnapshot: (verifiedSnapshot?: BridgeHostSnapshot) => Promise<boolean>;
  resumeEvents: (bootstrap?: boolean, fromSeq?: number) => Promise<void>;
  updateHostCache: (roomId: string, snapshot: BridgeHostSnapshot, permissions?: BridgePermissionInfo[]) => void;
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
): Promise<void> {
  const {
    setState,
    stateRef,
    cryptoRef,
    cryptoByRoomRef,
    socketRef,
    connectionTimerRef,
    pendingResponsesRef,
    envelopeRequestsRef,
    desktopHomeRef,
    linkGateRef,
    sendAttemptedAtRef,
    nativeRelayCapabilityRef,
    payloadDeflateRef,
    pendingCompletionNotificationsRef,
  } = refs;
  const {
    handlePayload,
    notifyCompletedTurns,
    refreshSessionList,
    refreshSnapshot,
    resumeEvents,
    updateHostCache,
  } = callbacks;

  if (connectionTimerRef.current) clearTimeout(connectionTimerRef.current);
  socketRef.current?.close();
  socketRef.current = undefined;
  cryptoRef.current = crypto;
  pendingCompletionNotificationsRef.current.clear();
  linkGateRef.current = () => true;
  desktopHomeRef.current = undefined;
  sendAttemptedAtRef.current = undefined;
  const roomId = crypto.identity.roomId;
  if (!provisionalPairing) writeLastActiveHost(roomId);
  const storedHost = await bridgeVault.getHost(roomId);
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
  setState((current) => ({
    ...current,
    loading: false,
    activeHostId: roomId,
    desktopName: crypto.identity.desktopName,
    connection: "connecting",
    desktopOnline: false,
    snapshot: undefined,
    snapshotSeq: 0,
    permissions: [],
    focusSessionId,
    histories: {},
    evidence: {},
    artifactPreviews: {},
    artifactTransfers: {},
    events: [],
    localTurns: [],
    latestSeq: 0,
    connectionIssue: undefined,
    transportMetrics: undefined,
    pendingOutbound: 0,
    error: undefined,
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
  if (cryptoRef.current !== crypto) return;
  setState((current) => ({
    ...current,
    snapshot: stored.snapshot,
    snapshotSeq: stored.snapshotSeq,
    permissions: stored.permissions,
    events: stored.events,
    evidence: stored.evidence,
    artifactPreviews: stored.artifactPreviews,
    localTurns: stored.localTurns.map((turn) => (
      rejectedRequestIds.has(turn.requestId) &&
      (turn.delivery === "local-saved" || turn.delivery === "relay-received")
        ? {
            ...turn,
            delivery: "uncertain",
            error: "这条消息未能送达当前连接，请确认后重试。",
          }
        : turn
    )),
    latestSeq: stored.latestSeq,
    pendingOutbound,
  }));
  if (stored.snapshot) updateHostCache(roomId, stored.snapshot, stored.permissions);

  if (
    Capacitor.isNativePlatform() &&
    relayEndpoints.every((endpoint) => isLoopbackRelay(endpoint.url))
  ) {
    setState((current) => ({
      ...current,
      connection: "closed",
      connectionIssue: {
        code: "pairing-invalid",
        message: "这条配对没有手机可访问的网络地址，请更新电脑端 Bridge 后重试。",
      },
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
      if (authenticationTimer) clearTimeout(authenticationTimer);
      if (isProvisionalPairing()) {
        setState((current) => advancePairingSync(current, roomId, "verifying", 38));
      }
      authenticationTimer = setTimeout(() => {
        if (!isCurrent() || authenticatedDesktop) return;
        const home = desktopHomeRef.current;
        if (!isProvisionalPairing() && home && relay.endpoint !== home) {
          // Known desktop, wrong relay namespace: say we're hunting instead
          // of claiming the pairing broke.
          setState((current) => ({
            ...current,
            desktopOnline: false,
            connectionIssue: {
              code: "waiting-link",
              message: "当前网络未连到电脑所在的中继（可能被代理带偏），正在自动重连；消息会保存在手机。",
            },
          }));
          return;
        }
        setState((current) => ({
          ...current,
          desktopOnline: false,
          connectionIssue: {
            code: "pairing-invalid",
            message: "Relay 已连接，但电脑未通过加密握手，请在电脑端重新生成二维码。",
          },
        }));
      }, 25_000);
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
    } else if (authenticationTimer) {
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
        setState((current) => ({ ...current, desktopOnline: true, error: undefined }));
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
        setState((current) => ({ ...current, desktopOnline: true, error: undefined }));
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
        for (const pending of pendingResponsesRef.current.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error(issue.message));
        }
        pendingResponsesRef.current.clear();
        if (socketRef.current === socket) {
          socketRef.current = undefined;
          cryptoRef.current = undefined;
        }
        if (!isProvisionalPairing()) writeLastActiveHost();
        socket.close();
        setState((current) => ({
          ...current,
          activeHostId: undefined,
          desktopName: undefined,
          connection: "closed",
          desktopOnline: false,
          snapshot: undefined,
          snapshotSeq: 0,
          permissions: [],
          focusSessionId: undefined,
          histories: {},
          evidence: {},
          artifactPreviews: {},
          artifactTransfers: {},
          events: [],
          localTurns: [],
          latestSeq: 0,
          connectionIssue: undefined,
          transportMetrics: undefined,
          pendingOutbound: 0,
          pairingSync: undefined,
          error: issue.message,
          hosts: isProvisionalPairing()
            ? current.hosts
            : current.hosts.map((host) => host.roomId === roomId
                ? { ...host, needsRepair: true, status: "offline" }
                : host),
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
    authenticatedDesktop = true;
    if (authenticationTimer) {
      clearTimeout(authenticationTimer);
      authenticationTimer = undefined;
    }
    // Authentic desktop traffic on this link proves where the desktop lives
    // right now. Queued replays can be old, so only fresh envelopes teach
    // the home relay; presence frames handle the silent-but-online case.
    linkHasDesktop = true;
    if (Date.now() - message.header.sentAt < HOME_LEARN_FRESHNESS_MS) {
      learnHome(relay.endpoint);
    }
    setState((current) => ({ ...current, desktopOnline: true, connectionIssue: undefined }));
    socket.ack([encrypted.id]);
    const event = message.payload.kind === "event" ? message.payload.event : undefined;
    const incomingSnapshot = message.payload.kind === "snapshot" ? message.payload.snapshot
      : message.payload.kind === "response" && message.payload.ok
        ? (message.payload.result as { snapshot?: BridgeHostSnapshot } | undefined)?.snapshot
        : undefined;
    const requestedPermission = event ? permissionFromEvent(event) : undefined;
    const newPermissions = (incomingSnapshot?.permissions ?? (requestedPermission ? [requestedPermission] : []))
      .filter((permission) => !stateRef.current.permissions.some((current) => current.requestId === permission.requestId));
    const isNewPermission = newPermissions.length > 0;
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
    if (event) notifyCompletedTurns([event], crypto);
    handlePayload(message.payload, encrypted, crypto);
    if (isNewPermission && document.visibilityState === "visible") {
      navigator.vibrate?.([120, 60, 120]);
    }
    if (Capacitor.isNativePlatform()) {
      if (document.visibilityState !== "visible") {
        for (const permission of newPermissions) {
          void showSessionNotification(
            { hostId: roomId, sessionId: permission.sessionId },
            (incomingSnapshot ?? stateRef.current.snapshot)?.sessions.find((session) => session.sessionId === permission.sessionId)?.title
              ?? crypto.identity.desktopName,
            "Claude 正在等待你处理",
          );
        }
      }
    } else if (
      document.visibilityState !== "visible" &&
      typeof Notification !== "undefined" &&
      Notification.permission === "granted" &&
      event && (event.type === "permission.requested" || event.type === "question.requested")
    ) {
      new Notification(crypto.identity.desktopName, {
        body: "Claude 正在等待你处理",
        icon: "/icon-192.png",
        tag: encrypted.id,
      });
    }
    // Avoid flooding IndexedDB with stale catch-up events during a queued
    // replay burst; refreshSnapshot() + resumeEvents() persists the rebased
    // state right after reconnect.
    const isStaleReplayEvent = (
      message.payload.kind === "event" &&
      Date.now() - message.header.sentAt > 60_000 &&
      message.payload.event.type !== "permission.requested" &&
      message.payload.event.type !== "question.requested"
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
    setState((current) => ({
      ...current,
      connectionIssue: {
        code: "unreachable",
        message: "无法连接这台电脑，请确认电脑 Bridge 在线并检查网络。",
      },
    }));
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
  refs: Pick<
    BridgeTransportRefs,
    | "setState"
    | "cryptoByRoomRef"
    | "socketRef"
    | "connectionTimerRef"
    | "pairingSyncTimerRef"
    | "pendingResponsesRef"
  >,
  start: StartBridgeFn,
): () => void {
  const {
    setState,
    cryptoByRoomRef,
    socketRef,
    connectionTimerRef,
    pairingSyncTimerRef,
    pendingResponsesRef,
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
    if (connectionTimerRef.current) clearTimeout(connectionTimerRef.current);
    if (pairingSyncTimerRef.current) clearTimeout(pairingSyncTimerRef.current);
    socketRef.current?.close();
    for (const pending of pendingResponsesRef.current.values()) clearTimeout(pending.timer);
    pendingResponsesRef.current.clear();
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
  refs: Pick<
    BridgeTransportRefs,
    | "setState"
    | "stateRef"
    | "cryptoRef"
    | "cryptoByRoomRef"
    | "socketRef"
    | "pairingSyncTimerRef"
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
    setState((current) => advancePairingSync(current, crypto.identity.roomId, "syncing", 56));
    await bridgeVault.importPairing(pairing, crypto);
    clearPendingPairingInstanceId(pairing.roomId, pairing.deviceId);
    cryptoByRoomRef.current.set(crypto.identity.roomId, crypto);
    pairingPhase.provisional = false;
    const verifiedState = rebaseSnapshot(verifiedSnapshot, stateRef.current.events, stateRef.current.permissions);
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
    }, verifiedState.snapshot, verifiedState.permissions);
    setState((current) => ({
      ...current,
      loading: false,
      hosts: [
        hostWithRuntimeState(nextHost, verifiedState.snapshot, verifiedState.permissions),
        ...current.hosts.filter((host) => host.hostId !== nextHost.hostId),
      ],
      snapshot: verifiedState.snapshot,
      snapshotSeq: verifiedSnapshot.latestSeq,
      permissions: verifiedState.permissions,
      desktopName: verifiedState.snapshot.host.name,
      desktopOnline: true,
      latestSeq: verifiedState.latestSeq,
      pairingSync: current.pairingSync?.roomId === crypto.identity.roomId
        ? { ...current.pairingSync, stage: "syncing", progress: 66 }
        : current.pairingSync,
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
    if (preparedCrypto && cryptoRef.current === preparedCrypto) {
      socketRef.current?.close();
      socketRef.current = undefined;
      cryptoRef.current = undefined;
    }
    if (preparedCrypto) {
      await bridgeVault.removeDeviceArtifacts(
        preparedCrypto.identity.roomId,
        preparedCrypto.identity.deviceId,
      ).catch(() => undefined);
    }
    writeLastActiveHost(previousLastActiveHost);
    const message = error instanceof Error ? error.message : "";
    setState((current) => ({
      ...current,
      loading: false,
      pairingSync: undefined,
      activeHostId: undefined,
      desktopName: undefined,
      connection: "closed",
      desktopOnline: false,
      snapshot: undefined,
      snapshotSeq: 0,
      permissions: [],
      connectionIssue: undefined,
      transportMetrics: undefined,
      error: /expired/iu.test(message)
        ? "二维码已超过十分钟，请在电脑端重新生成"
        : /prepared pairing|identity|身份/iu.test(message)
          ? "二维码身份校验失败，请在电脑端重新生成"
          : "未能与电脑完成加密配对，请在电脑端重新生成二维码后重试。",
    }));
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
  refs: Pick<BridgeTransportRefs, "setState" | "cryptoRef" | "socketRef" | "connectionTimerRef">,
): void {
  const { setState, cryptoRef, socketRef, connectionTimerRef } = refs;
  if (connectionTimerRef.current) clearTimeout(connectionTimerRef.current);
  socketRef.current?.close();
  socketRef.current = undefined;
  cryptoRef.current = undefined;
  writeLastActiveHost();
  setState((current) => ({
    ...current,
    activeHostId: undefined,
    desktopName: undefined,
    connection: "idle",
    desktopOnline: false,
    snapshot: undefined,
    snapshotSeq: 0,
    permissions: [],
    focusSessionId: undefined,
    histories: {},
    evidence: {},
    artifactPreviews: {},
    artifactTransfers: {},
    events: [],
    localTurns: [],
    latestSeq: 0,
    connectionIssue: undefined,
    pairingSync: undefined,
    error: undefined,
  }));
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
  refs: Pick<BridgeTransportRefs, "setState" | "cryptoRef" | "cryptoByRoomRef" | "socketRef">,
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
    socketRef.current?.close();
    socketRef.current = undefined;
    cryptoRef.current = undefined;
  }
  if (readLastActiveHost() === roomId) writeLastActiveHost();
  await bridgeVault.removeHost(roomId);
  cryptoByRoomRef.current.delete(roomId);
  setState((current) => ({
    ...current,
    hosts: current.hosts.filter((host) => host.roomId !== roomId),
    ...(active ? {
      activeHostId: undefined,
      desktopName: undefined,
      connection: "idle" as const,
      desktopOnline: false,
      snapshot: undefined,
      snapshotSeq: 0,
      permissions: [],
      focusSessionId: undefined,
      histories: {},
      evidence: {},
      artifactPreviews: {},
      artifactTransfers: {},
      events: [],
      localTurns: [],
      latestSeq: 0,
      connectionIssue: undefined,
      transportMetrics: undefined,
      pendingOutbound: 0,
      pairingSync: undefined,
    } : {}),
  }));
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
