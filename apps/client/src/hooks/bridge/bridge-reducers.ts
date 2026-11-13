import {
  evidenceSummary,
  summarizeEvidenceEvent,
  type BridgeArtifactPreview,
  type BridgeConversationRoute,
  type BridgeDeliveryState,
  type BridgeEvent,
  type BridgeEvidenceBundle,
  type BridgeEvidencePage,
  type BridgeHistoryAttachment,
  type BridgeHistoryItem,
  type BridgeHistoryPage,
  type BridgeHostSnapshot,
  type BridgePayload,
  type BridgePendingPrompt,
  type BridgePermissionInfo,
  type BridgePrAutoFixState,
  type BridgeProviderProfile,
  type BridgeResponse,
  type BridgeRuntimeGoalInfo,
  type BridgeRuntimeHandoff,
  type BridgeSessionInfo,
  type BridgeTransportMetrics,
  type BridgeTransportPath,
  type ClaudeDesktopAppStatus,
  type PairingBundle,
  type SocketState,
} from "@bridge/protocol";
import { Capacitor } from "@capacitor/core";
import type { StoredBridgeHost } from "../../lib/vault.js";

export interface PairedHost {
  hostId: string;
  roomId: string;
  desktopName: string;
  relayUrl: string;
  needsRepair: boolean;
  status: "standby" | "running" | "attention" | "offline";
  lastSeenAt?: number;
  activeTurns: number;
  attentionSessionId?: string;
  path: BridgeTransportPath;
}

export interface MobileConnectionIssue {
  code: "unreachable" | "pairing-invalid" | "revoked" | "waiting-link";
  message: string;
}

/**
 * Send gate for the dual-relay topology. Public relays keep independent room
 * queues, so an envelope is only safe to hand to the current connection when:
 * - a direct WebRTC peer to the desktop is open (the desktop is right there);
 * - the desktop was observed on THIS connection (presence or fresh traffic);
 * - no desktop home relay is known yet (first contact, legacy behavior); or
 * - the current connection IS the desktop's home relay — storing there is
 *   safe even with the desktop offline, because it drains that queue on
 *   return.
 * Anything else would store the envelope on a relay the desktop may never
 * visit again: the old behavior showed "Relay 已接收" while the message
 * silently rotted (proxy apps pull the phone onto the overseas relay).
 */
export function relayLinkAllowsSend(link: {
  homeRelayUrl?: string | undefined;
  currentRelayUrl: string;
  desktopHere: boolean;
  directPeer: boolean;
}): boolean {
  if (link.directPeer) return true;
  if (link.desktopHere) return true;
  if (!link.homeRelayUrl) return true;
  return link.currentRelayUrl === link.homeRelayUrl;
}

/** A queued envelope this fresh can still prove where the desktop lives;
 *  older ones may come from a relay the desktop has long since left. */
export const HOME_LEARN_FRESHNESS_MS = 3 * 60_000;

export interface SessionHistoryState {
  status: "idle" | "loading" | "ready" | "error";
  items: BridgeHistoryPage["items"];
  nextCursor?: string;
  hasMore: boolean;
  error?: string;
}

export interface SessionEvidenceState {
  status: "idle" | "loading" | "ready" | "error";
  items: BridgeEvidenceBundle[];
  nextCursor?: string;
  hasMore: boolean;
}

export interface LocalTurn {
  requestId: string;
  idempotencyKey: string;
  sessionId: string;
  text: string;
  attachments: BridgeHistoryAttachment[];
  createdAt: number;
  delivery: BridgeDeliveryState;
  commandId?: string;
  turnId?: string;
  messageId?: string;
  lastEventSeq?: number;
  bridgeExecutionRequested?: boolean;
  error?: string;
}

export function isClaudeNativeRelay(snapshot: BridgeHostSnapshot | undefined): boolean {
  return snapshot?.host.capabilities.includes("claude.native-relay.v1") ?? false;
}

export type PairingSyncStage = "connecting" | "verifying" | "syncing" | "ready";

export interface PairingSyncState {
  roomId: string;
  desktopName: string;
  stage: PairingSyncStage;
  progress: number;
}

export interface PendingResponse {
  resolve(response: BridgeResponse): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export interface PairingConnectionPhase {
  provisional: boolean;
}

export interface MobileBridgeState {
  loading: boolean;
  hosts: PairedHost[];
  activeHostId: string | undefined;
  desktopName: string | undefined;
  connection: SocketState;
  desktopOnline: boolean;
  snapshot: BridgeHostSnapshot | undefined;
  snapshotSeq: number;
  permissions: BridgePermissionInfo[];
  focusSessionId: string | undefined;
  histories: Record<string, SessionHistoryState>;
  evidence: Record<string, SessionEvidenceState>;
  artifactPreviews: Record<string, BridgeArtifactPreview>;
  artifactTransfers: Record<string, number>;
  events: BridgeEvent[];
  localTurns: LocalTurn[];
  latestSeq: number;
  connectionIssue: MobileConnectionIssue | undefined;
  transportMetrics: BridgeTransportMetrics | undefined;
  pendingOutbound: number;
  pairingSync: PairingSyncState | undefined;
  error: string | undefined;
}

export const INITIAL_STATE: MobileBridgeState = {
  loading: true,
  hosts: [],
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
  transportMetrics: undefined,
  pendingOutbound: 0,
  pairingSync: undefined,
  error: undefined,
};

export const HISTORY_PAGE_SIZE = 50;
export const LOCAL_EVIDENCE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

export function isLoopbackRelay(value: string): boolean {
  try {
    const hostname = new URL(value).hostname;
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
  } catch {
    return false;
  }
}

export function relayIssue(code: string, fallback: string): MobileConnectionIssue {
  if (code === "DEVICE_REVOKED") {
    return { code: "revoked", message: "这台电脑已撤销当前手机的访问权限，请删除主机后重新扫码。" };
  }
  if (
    code === "AUTH_FAILED" ||
    code === "ROOM_NOT_FOUND" ||
    code === "PAIRING_EXPIRED" ||
    code === "PAIRING_ALREADY_USED" ||
    code === "UPGRADE_REQUIRED"
  ) {
    return {
      code: "pairing-invalid",
      message: "配对已过期或已绑定其他设备，请删除后在电脑端生成新二维码。",
    };
  }
  if (code === "INVALID_ENVELOPE") {
    return {
      code: "unreachable",
      message: "有一条待发送消息已过期或不属于当前配对，已跳过；连接仍可用，正在同步最新会话。",
    };
  }
  return { code: "unreachable", message: fallback };
}

export function advancePairingSync(
  current: MobileBridgeState,
  roomId: string,
  stage: PairingSyncStage,
  progress: number,
): MobileBridgeState {
  if (!current.pairingSync || current.pairingSync.roomId !== roomId) return current;
  return {
    ...current,
    pairingSync: {
      ...current.pairingSync,
      stage,
      progress,
    },
  };
}

export function confirmedPairingSnapshot(
  pairing: PairingBundle,
  response: BridgeResponse | undefined,
): BridgeHostSnapshot {
  if (!response?.ok) throw new Error(response?.error?.message ?? "电脑端拒绝了加密配对握手");
  const result = response.result as { snapshot?: BridgeHostSnapshot } | undefined;
  const snapshot = result?.snapshot;
  if (
    !snapshot ||
    snapshot.host.hostId !== pairing.hostId ||
    snapshot.host.pairingEpoch !== pairing.pairingEpoch
  ) {
    throw new Error("电脑端返回的身份与二维码不一致");
  }
  return snapshot;
}

export function hostStatus(
  snapshot: BridgeHostSnapshot | undefined,
  permissions: BridgePermissionInfo[] = snapshot?.permissions ?? [],
): PairedHost["status"] {
  if (permissions.length > 0 || snapshot?.prompts?.length) return "attention";
  if (!snapshot) return "offline";
  if (
    snapshot.runtime.activeTurns > 0 ||
    snapshot.sessions.some((session) => session.turnState === "running")
  ) return "running";
  return "standby";
}

export function hostSummary(
  host: StoredBridgeHost,
  snapshot?: BridgeHostSnapshot,
  permissions: BridgePermissionInfo[] = snapshot?.permissions ?? [],
): PairedHost {
  const activeEndpoint = host.relayEndpoints.find((endpoint) => endpoint.id === host.activeEndpoint)
    ?? host.relayEndpoints[0];
  return {
    hostId: host.hostId,
    roomId: host.roomId,
    desktopName: host.desktopName,
    relayUrl: host.relayUrl,
    needsRepair: host.needsRepair || (
      Capacitor.isNativePlatform() &&
      host.relayEndpoints.every((endpoint) => isLoopbackRelay(endpoint.url))
    ),
    status: hostStatus(snapshot, permissions),
    activeTurns: snapshot?.runtime.activeTurns ?? 0,
    path: activeEndpoint?.kind ?? "lan-relay",
    ...(snapshot ? { lastSeenAt: snapshot.host.lastSeenAt } : {}),
    ...((permissions[0] ?? snapshot?.prompts?.[0]) ? { attentionSessionId: (permissions[0] ?? snapshot?.prompts?.[0])!.sessionId } : {}),
  };
}

export function hostWithRuntimeState(
  host: PairedHost,
  snapshot: BridgeHostSnapshot | undefined,
  permissions: BridgePermissionInfo[],
): PairedHost {
  const { attentionSessionId: _attentionSessionId, ...base } = host;
  const visibleActiveTurns = snapshot
    ? Math.max(
        snapshot.runtime.activeTurns,
        snapshot.sessions.filter((session) => session.turnState === "running" || session.turnState === "waiting").length,
      )
    : host.activeTurns;
  return {
    ...base,
    status: hostStatus(snapshot, permissions),
    activeTurns: visibleActiveTurns,
    ...(snapshot ? { lastSeenAt: snapshot.host.lastSeenAt } : {}),
    ...((permissions[0] ?? snapshot?.prompts?.[0]) ? { attentionSessionId: (permissions[0] ?? snapshot?.prompts?.[0])!.sessionId } : {}),
  };
}

export function isBridgeResponse(value: BridgePayload): value is BridgeResponse {
  return value.kind === "response";
}

export function mergeAcceptedDelivery(
  current: BridgeDeliveryState | undefined,
  incoming: BridgeDeliveryState = "session-received",
): BridgeDeliveryState {
  if (current === "completed" || current === "failed" || current === "cancelled") return current;
  if (current === "running" && incoming !== "completed" && incoming !== "failed" && incoming !== "cancelled") return current;
  if (current === "session-received" && (incoming === "host-received" || incoming === "submitted")) return current;
  return current === "queued" && (incoming === "session-received" || incoming === "submitted") ? current : incoming;
}

export function applyEventToTurns(turns: LocalTurn[], event: BridgeEvent): LocalTurn[] {
  if (event.type === "session.rewound") return turns.filter(turn => turn.sessionId !== event.sessionId || (turn.lastEventSeq ?? -1) >= event.seq);
  const requestId = typeof event.data.requestId === "string" ? event.data.requestId : undefined;
  const commandId = typeof event.data.commandId === "string" ? event.data.commandId : undefined;
  const native = event.origin === "claude-desktop";
  const messageId = event.type === "user.message.accepted" ? event.itemId
    : typeof event.data.messageId === "string" ? event.data.messageId
    : event.type === "message.delivery" && event.data.delivery === "submitted" ? event.itemId
    : native && event.type.startsWith("turn.") ? event.turnId ?? event.itemId : undefined;
  return turns.map((turn) => {
    if (
      (event.sessionId && turn.sessionId !== event.sessionId) ||
      (requestId && turn.requestId !== requestId) ||
      (!requestId && commandId && turn.commandId !== commandId) ||
      (!requestId && !commandId && (native
        ? !((messageId && turn.messageId === messageId) || (event.turnId && turn.turnId === event.turnId))
        : (
          turn.sessionId !== event.sessionId ||
          (event.type !== "turn.completed" && event.type !== "turn.failed" && event.type !== "turn.interrupted") ||
          (turn.delivery !== "session-received" && turn.delivery !== "running") ||
          (turn.turnId && event.turnId && turn.turnId !== event.turnId)
        )
      ))
    ) return turn;
    if (event.seq <= (turn.lastEventSeq ?? -1)) {
      return !turn.messageId && messageId ? { ...turn, messageId } : turn;
    }
    if (event.type === "turn.queued") {
      return { ...turn, lastEventSeq: event.seq, delivery: native ? "queued" : "host-received", ...(commandId ? { commandId } : {}), ...(messageId ? { messageId } : {}), ...(event.turnId ? { turnId: event.turnId } : {}) };
    }
    if (event.type === "user.message.accepted") return {
      ...turn,
      lastEventSeq: event.seq,
      delivery: mergeAcceptedDelivery(turn.delivery, event.data.delivery as BridgeDeliveryState | undefined),
      ...(commandId ? { commandId } : {}),
      ...(event.turnId ? { turnId: event.turnId } : {}),
      ...(messageId ? { messageId } : {}),
    };
    if (event.type === "message.delivery" && typeof event.data.delivery === "string") {
      const delivery = event.data.delivery as BridgeDeliveryState;
      if (
        [
          "local-saved",
          "relay-received",
          "host-received",
          "submitted",
          "waiting-confirmation",
          "session-received",
          "queued",
          "running",
          "completed",
          "failed",
          "cancelled",
          "uncertain",
        ].includes(delivery)
      ) {
        return {
          ...turn,
          lastEventSeq: event.seq,
          delivery,
          ...(messageId ? { messageId } : {}),
          ...(typeof event.data.error === "string" ? { error: event.data.error } : {}),
          ...(commandId ? { commandId } : {}),
        };
      }
    }
    if (event.type === "turn.started") return {
      ...turn,
      lastEventSeq: event.seq,
      delivery: "running",
      ...(commandId ? { commandId } : {}),
      ...(event.turnId ? { turnId: event.turnId } : {}),
    };
    if (event.type === "turn.completed") return { ...turn, lastEventSeq: event.seq, delivery: "completed" };
    if (event.type === "turn.failed") {
      return {
        ...turn,
        lastEventSeq: event.seq,
        delivery: "failed",
        error: typeof event.data.error === "string" ? event.data.error : "Claude 处理失败",
      };
    }
    if (event.type === "turn.interrupted") return { ...turn, lastEventSeq: event.seq, delivery: "cancelled" };
    return turn;
  });
}

export function mergeBridgeEvents(current: BridgeEvent[], incoming: BridgeEvent[]): BridgeEvent[] {
  const merged = new Map<string, BridgeEvent>();
  for (const record of [...current, ...incoming]) {
    const event = summarizeEvidenceEvent(record);
    const bundle = evidenceFromEvent(event);
    const key = bundle ? `evidence:${bundle.sessionId}:${bundle.id}` : event.eventId;
    if ((merged.get(key)?.seq ?? -1) <= event.seq) merged.set(key, event);
  }
  return [...merged.values()]
    .sort((left, right) => left.seq - right.seq)
    .slice(-2_000);
}

export function evidenceFromEvent(event: BridgeEvent): BridgeEvidenceBundle | undefined {
  if (!event.type.startsWith("evidence.")) return undefined;
  const value = event.data.evidence;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const evidence = value as Partial<BridgeEvidenceBundle>;
  if (
    typeof evidence.id !== "string" ||
    typeof evidence.sessionId !== "string" ||
    !Array.isArray(evidence.tools) ||
    !Array.isArray(evidence.artifacts)
  ) return undefined;
  return evidenceSummary(evidence as BridgeEvidenceBundle);
}

export function previewFromResponse(response: BridgeResponse): BridgeArtifactPreview | undefined {
  if (!response.ok || !response.result || typeof response.result !== "object") return undefined;
  const preview = (response.result as { preview?: unknown }).preview;
  if (!preview || typeof preview !== "object" || Array.isArray(preview)) return undefined;
  const value = preview as Partial<BridgeArtifactPreview>;
  if (
    typeof value.artifactId !== "string" ||
    typeof value.mimeType !== "string" ||
    typeof value.data !== "string" ||
    (value.encoding !== "utf8" && value.encoding !== "base64")
  ) return undefined;
  return value as BridgeArtifactPreview;
}

export function evidencePageFromResponse(response: BridgeResponse): BridgeEvidencePage | undefined {
  if (!response.ok || !response.result || typeof response.result !== "object") return undefined;
  const evidence = (response.result as { evidence?: unknown }).evidence;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return undefined;
  const value = evidence as Partial<BridgeEvidencePage>;
  if (typeof value.sessionId !== "string" || !Array.isArray(value.items)) return undefined;
  return value as BridgeEvidencePage;
}

export function shouldExtendLocalEvidenceCache(payload: BridgePayload): boolean {
  if (payload.kind === "event") {
    return payload.event.type === "evidence.ready" || payload.event.type === "evidence.failed";
  }
  return payload.kind === "response" && Boolean(
    previewFromResponse(payload) || evidencePageFromResponse(payload),
  );
}

export function shouldPersistIncomingMessage(payload: BridgePayload, localTurns: LocalTurn[]): boolean {
  if (payload.kind === "snapshot") return true;
  if (payload.kind === "event") {
    return (
      payload.event.type !== "assistant.delta" &&
      payload.event.type !== "session.desktop-registration" &&
      payload.event.type !== "evidence.started" &&
      payload.event.type !== "evidence.updated"
    );
  }
  if (payload.kind === "response") {
    return shouldExtendLocalEvidenceCache(payload) ||
      localTurns.some((turn) => turn.requestId === payload.requestId);
  }
  return false;
}

export function mergeEvidence(
  current: BridgeEvidenceBundle[],
  incoming: BridgeEvidenceBundle[],
): BridgeEvidenceBundle[] {
  const merged = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) merged.set(item.id, evidenceSummary(item));
  return [...merged.values()].sort((left, right) => (
    right.startedAt - left.startedAt || right.id.localeCompare(left.id)
  ));
}

export function mergeHistoryPages(
  olderItems: BridgeHistoryItem[],
  existingItems: BridgeHistoryItem[],
): BridgeHistoryItem[] {
  const seen = new Set<string>();
  const mergedItems: BridgeHistoryItem[] = [];
  for (const item of [...olderItems, ...existingItems]) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    mergedItems.push(item);
  }
  return mergedItems;
}

export function permissionFromEvent(event: BridgeEvent): BridgePermissionInfo | undefined {
  if (event.type !== "permission.requested" && event.type !== "question.requested") return undefined;
  if (
    !event.sessionId ||
    typeof event.data.requestId !== "string" ||
    typeof event.data.toolUseId !== "string" ||
    typeof event.data.toolName !== "string" ||
    !event.data.input ||
    typeof event.data.input !== "object" ||
    Array.isArray(event.data.input)
  ) return undefined;
  return {
    requestId: event.data.requestId,
    sessionId: event.sessionId,
    toolUseId: event.data.toolUseId,
    toolName: event.data.toolName,
    input: event.data.input as Record<string, unknown>,
    createdAt: typeof event.data.createdAt === "number" ? event.data.createdAt : event.timestamp,
    canAllowAlways: event.data.canAllowAlways === true,
    ...(event.data.canSetNativeFullAccess === true ? { canSetNativeFullAccess: true } : {}),
    ...(typeof event.data.title === "string" && event.data.title ? { title: event.data.title } : {}),
    ...(typeof event.data.displayName === "string" && event.data.displayName
      ? { displayName: event.data.displayName }
      : {}),
    ...(typeof event.data.description === "string" && event.data.description
      ? { description: event.data.description }
      : {}),
  };
}

export function applyPermissionEvent(
  current: BridgePermissionInfo[],
  event: BridgeEvent,
): BridgePermissionInfo[] {
  const requested = permissionFromEvent(event);
  if (requested) {
    return [
      ...current.filter((permission) => permission.requestId !== requested.requestId),
      requested,
    ].sort((left, right) => left.createdAt - right.createdAt);
  }
  if (
    (event.type === "permission.resolved" || event.type === "question.resolved") &&
    typeof event.data.requestId === "string"
  ) {
    return current.filter((permission) => permission.requestId !== event.data.requestId);
  }
  return current;
}

export function applyPromptEvent(
  current: BridgePendingPrompt[] | undefined,
  event: BridgeEvent,
): BridgePendingPrompt[] | undefined {
  if (event.type === "prompt.requested") {
    const prompt = event.data as unknown as BridgePendingPrompt;
    return [...(current ?? []).filter(candidate => candidate.promptId !== prompt.promptId || candidate.sessionId !== prompt.sessionId), prompt];
  }
  if (event.type === "prompt.resolved") {
    return current?.filter(prompt => prompt.promptId !== event.data.promptId || prompt.sessionId !== event.sessionId);
  }
  if (event.type === "session.deleted") return current?.filter(prompt => prompt.sessionId !== event.sessionId);
  return current;
}

export function applyUnseenPermissionEvents(
  permissions: BridgePermissionInfo[],
  incoming: BridgeEvent[],
  seen: BridgeEvent[],
  snapshotSeq: number,
): BridgePermissionInfo[] {
  const seenIds = new Set(seen.map((event) => event.eventId));
  const latest = new Map<string, number>();
  for (const event of [...seen, ...incoming]) {
    if (/^(permission|question)\.(requested|resolved)$/u.test(event.type) && typeof event.data.requestId === "string") {
      latest.set(event.data.requestId, Math.max(latest.get(event.data.requestId) ?? 0, event.seq));
    }
  }
  for (const event of incoming) {
    if (event.seq > snapshotSeq && !seenIds.has(event.eventId) && latest.get(event.data.requestId as string) === event.seq) {
      permissions = applyPermissionEvent(permissions, event);
    }
  }
  return permissions;
}

export function snapshotWithPermissions(
  snapshot: BridgeHostSnapshot | undefined,
  permissions: BridgePermissionInfo[],
): BridgeHostSnapshot | undefined {
  if (!snapshot) return undefined;
  const waitingSessions = new Set(permissions.map((permission) => permission.sessionId));
  return {
    ...snapshot,
    permissions,
    sessions: snapshot.sessions.map((session) => {
      if (session.transport === "claude-desktop-native") return session;
      if (waitingSessions.has(session.sessionId)) return { ...session, turnState: "waiting" };
      if (session.turnState !== "waiting") return session;
      return {
        ...session,
        turnState: session.ownership === "BRIDGE_RUNNING" || session.ownership === "DESKTOP_MANAGED_RUNNING"
          ? "running"
          : session.pendingCount > 0
            ? "queued"
            : "idle",
      };
    }),
  };
}

export function rebaseSnapshot(
  snapshot: BridgeHostSnapshot,
  events: BridgeEvent[],
  currentPermissions?: BridgePermissionInfo[],
): {
  snapshot: BridgeHostSnapshot;
  permissions: BridgePermissionInfo[];
  latestSeq: number;
} {
  const replay = events
    .filter((event) => event.seq > snapshot.latestSeq)
    .sort((left, right) => left.seq - right.seq);
  const applied = applyEventsToSnapshot(snapshot, replay, snapshot.permissions);
  // A confirmed local answer removes the prompt before its resolved event can arrive.
  // Replaying an already seen request must preserve that removal.
  const permissions = currentPermissions ? applied.permissions.filter((permission) =>
    currentPermissions.some((current) => current.requestId === permission.requestId) ||
    !events.some((event) => (event.type === "permission.requested" || event.type === "question.requested") &&
      event.data.requestId === permission.requestId)) : applied.permissions;
  return {
    snapshot: snapshotWithPermissions(applied.snapshot ?? snapshot, permissions)!,
    permissions,
    latestSeq: Math.max(snapshot.latestSeq, ...events.map((event) => event.seq), 0),
  };
}

export function snapshotWithClaudeDesktop(
  snapshot: BridgeHostSnapshot | undefined,
  claudeDesktop: ClaudeDesktopAppStatus,
): BridgeHostSnapshot | undefined {
  return snapshot ? { ...snapshot, claudeDesktop } : undefined;
}

function sessionWithRoute(
  session: BridgeSessionInfo,
  route: BridgeConversationRoute,
): BridgeSessionInfo {
  const {
    pendingHandoff: _pendingHandoff,
    ...withoutPending
  } = session;
  return {
    ...withoutPending,
    activeLaneId: route.activeLaneId,
    activeProviderProfileId: route.activeProviderProfileId,
    routeState: route.state,
    allowedActions: route.allowedActions,
    ...(route.pendingHandoff ? { pendingHandoff: route.pendingHandoff } : {}),
  };
}

export function applySessionToSnapshot(
  snapshot: BridgeHostSnapshot | undefined,
  session: BridgeSessionInfo | undefined,
): BridgeHostSnapshot | undefined {
  if (!snapshot || !session) return snapshot;
  const exists = snapshot.sessions.some((candidate) => candidate.sessionId === session.sessionId);
  return {
    ...snapshot,
    sessions: exists
      ? snapshot.sessions.map((candidate) => candidate.sessionId === session.sessionId ? session : candidate)
      : [session, ...snapshot.sessions],
  };
}

export function applyPrAutoFixToSnapshot(
  snapshot: BridgeHostSnapshot | undefined,
  state: BridgePrAutoFixState,
): BridgeHostSnapshot | undefined {
  if (!snapshot) return snapshot;
  return {
    ...snapshot,
    sessions: snapshot.sessions.map(session => {
      if (session.sessionId !== state.sessionId) return session;
      const { prAutoFix: _previous, ...current } = session;
      return {
        ...current,
        prs: state.prs,
        ...(state.onlyOwnPrs !== undefined && state.nextOwnPrArmed !== undefined ? {
          prAutoFix: { onlyOwnPrs: state.onlyOwnPrs, nextOwnPrArmed: state.nextOwnPrArmed },
        } : {}),
      };
    }),
  };
}

export function applyEventToSnapshot(
  snapshot: BridgeHostSnapshot | undefined,
  event: BridgeEvent,
  permissions: BridgePermissionInfo[],
): BridgeHostSnapshot | undefined {
  if (!snapshot || event.seq <= snapshot.latestSeq) return snapshot;
  const prompts = applyPromptEvent(snapshot.prompts, event);
  const current = snapshotWithPermissions({ ...snapshot, latestSeq: event.seq, ...(prompts ? { prompts } : {}) }, permissions)!;
  if (event.type === "provider.updated") {
    const profile = event.data.profile as BridgeProviderProfile | undefined;
    if (!profile || typeof profile.id !== "string") return current;
    const providers = new Map((current.providers ?? []).map((candidate) => [candidate.id, candidate]));
    providers.set(profile.id, profile);
    return { ...current, providers: [...providers.values()] };
  }
  if (!event.sessionId) return current;
  const hasPendingPermission = permissions.some((permission) => permission.sessionId === event.sessionId)
    || current.prompts?.some(prompt => prompt.sessionId === event.sessionId) === true;
  if (event.type === "session.deleted") {
    return {
      ...current,
      sessions: current.sessions.filter((session) => session.sessionId !== event.sessionId),
    };
  }
  const index = current.sessions.findIndex((session) => session.sessionId === event.sessionId);
  if (index < 0) return current;
  const target = current.sessions[index]!;
  const updated = applyEventToSession(target, event, hasPendingPermission);
  if (updated === target) return current;
  const sessions = current.sessions.slice();
  sessions[index] = updated;
  return { ...current, sessions };
}

function applyEventToSession(
  session: BridgeSessionInfo,
  event: BridgeEvent,
  hasPendingPermission: boolean,
): BridgeSessionInfo {
  if (event.type === "runtime.updated") {
    const updated = event.data.session as Partial<BridgeSessionInfo> | undefined;
    if (updated?.sessionId === session.sessionId) {
      if (event.data.replaceSession === true) return updated as BridgeSessionInfo;
      const { allowedActions, ...fields } = updated;
      return {
        ...session,
        ...fields,
        ...(allowedActions ? { allowedActions } : {}),
      };
    }
  }
  if (event.type === "session.archived") {
    if (event.data.archived === true && typeof event.data.archivedAt === "number") {
      return { ...session, archivedAt: event.data.archivedAt };
    }
    if (event.data.archived === false) {
      const { archivedAt: _dropped, ...rest } = session;
      return rest;
    }
    return session;
  }
  if (event.type === "conversation.route.changed") {
    const route = event.data.route as BridgeConversationRoute | undefined;
    if (route?.conversationId === session.sessionId) return sessionWithRoute(session, route);
  }
  if (event.type === "session.configuration") {
    // Configuration events contain effective settings and omit unset fields.
    const next: BridgeSessionInfo = { ...session };
    if (typeof event.data.model === "string" && event.data.model) next.model = event.data.model;
    else delete next.model;
    if (typeof event.data.modelDisplayName === "string" && event.data.modelDisplayName) {
      next.modelDisplayName = event.data.modelDisplayName;
    } else {
      delete next.modelDisplayName;
    }
    if (typeof event.data.effort === "string" && event.data.effort) {
      next.effort = event.data.effort as NonNullable<BridgeSessionInfo["effort"]>;
    } else {
      delete next.effort;
    }
    if (typeof event.data.reasoningEffort === "string" && event.data.reasoningEffort) {
      next.reasoningEffort = event.data.reasoningEffort;
    } else {
      delete next.reasoningEffort;
    }
    if (typeof event.data.provider === "string" && event.data.provider) {
      next.provider = event.data.provider;
    } else {
      delete next.provider;
    }
    if (typeof event.data.fast === "boolean") {
      next.fast = event.data.fast;
    } else {
      delete next.fast;
    }
    if (event.data.appliesAfterTurn === true) next.configurationPending = true;
    else if (event.data.appliesAfterTurn === false) delete next.configurationPending;
    return next;
  }
  if (event.type === "message.delivery" && typeof event.data.commandId === "string") {
    const pendingCommandIds = new Set(session.pendingCommandIds ?? []);
    if (event.data.delivery === "queued") pendingCommandIds.add(event.data.commandId);
    else if (["running", "completed", "failed", "cancelled"].includes(String(event.data.delivery))) pendingCommandIds.delete(event.data.commandId);
    else return session;
    return { ...session, pendingCommandIds: [...pendingCommandIds], pendingCount: pendingCommandIds.size };
  }
  if (
    event.type === "turn.queued" || event.type === "turn.started" ||
    event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.interrupted"
  ) {
    const commandId = typeof event.data.commandId === "string" ? event.data.commandId : undefined;
    const pendingCommandIds = new Set(session.pendingCommandIds ?? []);
    const wasQueued = event.data.wasQueued === true || (
      commandId !== undefined && pendingCommandIds.has(commandId) &&
      (!event.turnId || event.turnId !== session.activeTurnId)
    );
    let pendingCount = session.pendingCount;
    if (event.type === "turn.queued") {
      if (commandId && !pendingCommandIds.has(commandId)) {
        pendingCommandIds.add(commandId);
        pendingCount += 1;
      } else if (!commandId) {
        pendingCount = Math.max(1, pendingCount);
      }
    } else if (event.type === "turn.started" || wasQueued) {
      // Older snapshots can count queued commands without naming them.
      if ((commandId && pendingCommandIds.has(commandId)) || pendingCount > pendingCommandIds.size) {
        pendingCount = Math.max(0, pendingCount - 1);
      }
      if (commandId) pendingCommandIds.delete(commandId);
    }
    const queued = {
      pendingCommandIds: Array.isArray(event.data.pendingCommandIds)
        ? event.data.pendingCommandIds as string[]
        : [...pendingCommandIds],
      pendingCount: typeof event.data.pendingCount === "number" ? event.data.pendingCount : pendingCount,
    };
    if (event.type === "turn.queued" || (wasQueued && event.type !== "turn.started")) {
      return {
        ...session,
        ...queued,
        turnState: hasPendingPermission || session.turnState === "waiting" ? "waiting"
          : session.turnState === "running" ? "running"
            : queued.pendingCount > 0 ? "queued" : "idle",
      };
    }
    if (event.type === "turn.started") {
      return {
        ...session,
        ...queued,
        ownership: session.transport === "claude-desktop-native" ? "DESKTOP_NATIVE_RUNNING" : session.transport === "claude-desktop-managed" ? "DESKTOP_MANAGED_RUNNING" : "BRIDGE_RUNNING",
        turnState: hasPendingPermission ? "waiting" : "running",
        executionStage: "running",
        ...(event.turnId ? { activeTurnId: event.turnId } : {}),
      };
    }
    if (event.turnId && session.activeTurnId && event.turnId !== session.activeTurnId) {
      return { ...session, ...queued };
    }
    const { activeTurnId: _activeTurnId, currentSummary: _currentSummary, executionStage: _executionStage, ...rest } = session;
    return {
      ...rest,
      ...queued,
      ownership: session.transport === "claude-desktop-native" ? "DESKTOP_NATIVE_IDLE" : session.transport === "claude-desktop-managed" ? "DESKTOP_MANAGED_IDLE" : "BRIDGE_IDLE",
      turnState: hasPendingPermission ? "waiting" : queued.pendingCount > 0 ? "queued" : "idle",
    };
  }
  if (hasPendingPermission) return { ...session, turnState: "waiting" };
  if (event.type === "session.ownership" && typeof event.data.ownership === "string") {
    return {
      ...session,
      ownership: event.data.ownership as BridgeSessionInfo["ownership"],
    };
  }
  if (event.type === "session.transport" && typeof event.data.transport === "string") {
    return {
      ...session,
      transport: event.data.transport as BridgeSessionInfo["transport"],
    };
  }
  if (event.type === "session.ownership-conflict") {
    return {
      ...session,
      ownership: "OWNERSHIP_CONFLICT",
      turnState: "waiting",
    };
  }
  if (event.type === "session.rewound") {
    const { contextUsage: _dropped, ...rest } = session;
    return rest;
  }
  if (event.type === "session.compacted") {
    const postTokens = typeof event.data.postTokens === "number" && Number.isFinite(event.data.postTokens) && event.data.postTokens > 0
      ? Math.round(event.data.postTokens)
      : undefined;
    if (!postTokens) {
      const { contextUsage: _dropped, ...rest } = session;
      return rest;
    }
    const maxTokens = session.contextUsage?.maxTokens;
    return {
      ...session,
      contextUsage: {
        totalTokens: postTokens,
        ...(typeof maxTokens === "number" && maxTokens > 0 ? {
          maxTokens,
          percentage: Math.min(100, Math.max(0, Math.round((postTokens / maxTokens) * 1000) / 10)),
        } : {}),
        ...(session.contextUsage?.model ? { model: session.contextUsage.model } : {}),
        estimated: true,
      },
    };
  }
  if (event.type === "runtime.goal.updated") {
    const goal = event.data.goal as BridgeRuntimeGoalInfo | undefined;
    if (goal && typeof goal.objective === "string") return { ...session, goal };
    return session;
  }
  if (
    event.type === "runtime.handoff.started" ||
    event.type === "runtime.handoff.plan-ready" ||
    event.type === "runtime.handoff.failed" ||
    event.type === "runtime.handoff.cancelled"
  ) {
    // The plan gate lives on the source session; follow it live on
    // mobile so confirmation never requires the desktop.
    const handoff = event.data.handoff as BridgeRuntimeHandoff | undefined;
    if (!handoff || handoff.sourceSessionId !== session.sessionId) return session;
    return { ...session, pendingRuntimeHandoff: handoff };
  }
  if (event.type === "runtime.handoff.applied") {
    const handoff = event.data.handoff as BridgeRuntimeHandoff | undefined;
    if (!handoff || handoff.sourceSessionId !== session.sessionId) return session;
    const { pendingRuntimeHandoff: _pending, ...rest } = session;
    return rest;
  }
  return session;
}

/**
 * Batch variant for catch-up replay: one session-index build and one final
 * wrap for the whole event run instead of a full sessions map per event.
 * A busy away window can queue thousands of events; per-event mapping made
 * every reconnect O(events x sessions) and froze the phone for seconds.
 */
export function applyEventsToSnapshot(
  snapshot: BridgeHostSnapshot | undefined,
  events: BridgeEvent[],
  permissions: BridgePermissionInfo[],
): { snapshot: BridgeHostSnapshot | undefined; permissions: BridgePermissionInfo[] } {
  let current = snapshotWithPermissions(snapshot, permissions);
  let currentPermissions = permissions;
  if (!current || events.length === 0) return { snapshot: current, permissions: currentPermissions };
  const byId = new Map(current.sessions.map((session) => [session.sessionId, session]));
  let providers = current.providers ?? [];
  let prompts = current.prompts;
  let providersDirty = false;
  let sessionsDirty = false;
  let latestSeq = current.latestSeq;
  for (const event of events) {
    if (event.seq <= latestSeq) continue;
    latestSeq = event.seq;
    currentPermissions = applyPermissionEvent(currentPermissions, event);
    prompts = applyPromptEvent(prompts, event);
    if (event.type === "provider.updated") {
      const profile = event.data.profile as BridgeProviderProfile | undefined;
      if (profile && typeof profile.id === "string") {
        const index = providers.findIndex((candidate) => candidate.id === profile.id);
        if (index < 0) providers = [...providers, profile];
        else {
          if (!providersDirty) providers = providers.slice();
          providers[index] = profile;
        }
        providersDirty = true;
      }
      continue;
    }
    if (!event.sessionId) continue;
    if (event.type === "session.deleted") {
      if (byId.delete(event.sessionId)) sessionsDirty = true;
      continue;
    }
    const existing = byId.get(event.sessionId);
    if (!existing) continue;
    const hasPendingPermission = currentPermissions.some(
      (permission) => permission.sessionId === event.sessionId,
    ) || prompts?.some(prompt => prompt.sessionId === event.sessionId) === true;
    const updated = applyEventToSession(existing, event, hasPendingPermission);
    if (updated !== existing) {
      byId.set(event.sessionId, updated);
      sessionsDirty = true;
    }
  }
  current = {
    ...current,
    latestSeq,
    ...(sessionsDirty ? { sessions: [...byId.values()] } : {}),
    ...(providersDirty ? { providers } : {}),
    ...(prompts ? { prompts } : {}),
  };
  return {
    snapshot: snapshotWithPermissions(current, currentPermissions),
    permissions: currentPermissions,
  };
}
