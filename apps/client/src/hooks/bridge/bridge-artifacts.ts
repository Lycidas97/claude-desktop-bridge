import type {
  BridgeArtifactManifest,
  BridgeArtifactPreview,
  BridgeCrypto,
  BridgeEvidenceBundle,
  BridgeEvidenceDetailPage,
  BridgeEvidencePage,
  BridgeHistoryPage,
  BridgeRequest,
  BridgeResponse,
  BridgeSessionInfo,
  BridgeTransport,
} from "@bridge/protocol";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import {
  downloadBridgeArtifact,
  downloadBridgeSessionFile,
} from "../../lib/artifact-download.js";
import { uploadSessionFile, type UploadFileHandler } from "../../lib/file-upload.js";
import {
  HISTORY_PAGE_SIZE,
  applySessionToSnapshot,
  mergeEvidence,
  mergeHistoryPages,
  type MobileBridgeState,
} from "./bridge-reducers.js";

export type BridgeSendRequest = (
  method: BridgeRequest["method"],
  params: Record<string, unknown>,
  options?: {
    wait?: boolean;
    allowOffline?: boolean;
    requestId?: string;
    idempotencyKey?: string;
    timeoutMs?: number;
  },
) => Promise<BridgeResponse | undefined>;

export interface BridgeArtifactsContext {
  setState: Dispatch<SetStateAction<MobileBridgeState>>;
  stateRef: MutableRefObject<MobileBridgeState>;
  cryptoRef: MutableRefObject<BridgeCrypto | undefined>;
  socketRef: MutableRefObject<BridgeTransport | undefined>;
  sendRequest: BridgeSendRequest;
}

export async function openBridgeSession(
  ctx: BridgeArtifactsContext & {
    openedSessionRef: MutableRefObject<string | undefined>;
    openingSessionsRef: MutableRefObject<Map<string, { socket: BridgeTransport | undefined; task: Promise<void> }>>;
  },
  sessionId: string,
): Promise<void> {
  const { setState, cryptoRef, socketRef, sendRequest, openedSessionRef, openingSessionsRef } = ctx;
  openedSessionRef.current = sessionId;
  const crypto = cryptoRef.current;
  const socket = socketRef.current;
  const isCurrent = () => cryptoRef.current === crypto && socketRef.current === socket;
  const key = `${crypto?.identity.roomId}:${sessionId}`;
  const inflight = openingSessionsRef.current.get(key);
  if (inflight && inflight.socket === socket) return inflight.task;
  const task = (async () => {
    setState((current) => ({
      ...current,
      histories: {
        ...current.histories,
        [sessionId]: {
          status: "loading",
          items: current.histories[sessionId]?.items ?? [],
          hasMore: current.histories[sessionId]?.hasMore ?? false,
          ...(current.histories[sessionId]?.nextCursor
            ? { nextCursor: current.histories[sessionId].nextCursor }
            : {}),
        },
      },
      evidence: {
        ...current.evidence,
        [sessionId]: {
          status: "loading",
          items: current.evidence[sessionId]?.items ?? [],
          hasMore: current.evidence[sessionId]?.hasMore ?? false,
          ...(current.evidence[sessionId]?.nextCursor
            ? { nextCursor: current.evidence[sessionId]!.nextCursor }
            : {}),
        },
      },
    }));
    try {
      const response = await sendRequest("session.open", { sessionId, limit: HISTORY_PAGE_SIZE }, {
        wait: true,
        timeoutMs: 25_000,
      });
      if (!isCurrent()) return;
      if (!response?.ok) throw new Error(response?.error?.message ?? "会话打开失败");
      const result = response.result as { history?: BridgeHistoryPage; session?: BridgeSessionInfo };
      if (!result.history) throw new Error("电脑未返回会话历史");
      setState((current) => isCurrent() ? {
        ...current,
        snapshot: applySessionToSnapshot(current.snapshot, result.session),
        histories: {
          ...current.histories,
          [sessionId]: {
            status: "ready",
            items: result.history!.items,
            hasMore: result.history!.hasMore,
            ...(result.history!.nextCursor ? { nextCursor: result.history!.nextCursor } : {}),
          },
        },
      } : current);
      void sendRequest("evidence.list", { sessionId, limit: 12 }, {
        wait: true,
        timeoutMs: 30_000,
      }).then((evidenceResponse) => {
        if (!isCurrent()) return;
        const evidenceResult = evidenceResponse?.ok
          ? evidenceResponse.result as { evidence?: BridgeEvidencePage }
          : undefined;
        setState((current) => isCurrent() ? {
          ...current,
          evidence: {
            ...current.evidence,
            [sessionId]: evidenceResult?.evidence ? {
              status: "ready",
              items: mergeEvidence(
                current.evidence[sessionId]?.items ?? [],
                evidenceResult.evidence.items,
              ),
              hasMore: evidenceResult.evidence.hasMore,
              ...(evidenceResult.evidence.nextCursor
                ? { nextCursor: evidenceResult.evidence.nextCursor }
                : {}),
            } : {
              status: current.evidence[sessionId]?.items.length ? "ready" : "error",
              items: current.evidence[sessionId]?.items ?? [],
              hasMore: false,
            },
          },
        } : current);
      }).catch(() => {
        setState((current) => isCurrent() ? {
          ...current,
          evidence: {
            ...current.evidence,
            [sessionId]: {
              status: current.evidence[sessionId]?.items.length ? "ready" : "error",
              items: current.evidence[sessionId]?.items ?? [],
              hasMore: current.evidence[sessionId]?.hasMore ?? false,
            },
          },
        } : current);
      });
    } catch (error) {
      setState((current) => isCurrent() ? {
        ...current,
        histories: {
          ...current.histories,
          [sessionId]: {
            status: "error",
            items: current.histories[sessionId]?.items ?? [],
            hasMore: current.histories[sessionId]?.hasMore ?? false,
            error: error instanceof Error ? error.message : "会话打开失败",
          },
        },
        evidence: {
          ...current.evidence,
          [sessionId]: {
            status: current.evidence[sessionId]?.items.length ? "ready" : "error",
            items: current.evidence[sessionId]?.items ?? [],
            hasMore: current.evidence[sessionId]?.hasMore ?? false,
          },
        },
        error: error instanceof Error ? error.message : "会话打开失败",
      } : current);
    }
  })().finally(() => {
    if (openingSessionsRef.current.get(key)?.task === task) openingSessionsRef.current.delete(key);
  });
  openingSessionsRef.current.set(key, { socket, task });
  return task;
}

export function syncSessionCommandEvents(params: {
  events: MobileBridgeState["events"];
  handledCommandEvents: MutableRefObject<Set<string>>;
  openedSessionRef: MutableRefObject<string | undefined>;
  setState: Dispatch<SetStateAction<MobileBridgeState>>;
  refreshSnapshot: () => Promise<boolean>;
  openSession: (sessionId: string) => Promise<void>;
}): void {
  const { events, handledCommandEvents, openedSessionRef, setState, refreshSnapshot, openSession } = params;
  for (const event of events) {
    if ((event.type !== "session.reset" && event.type !== "session.compacted" && event.type !== "session.rewound") || handledCommandEvents.current.has(event.eventId)) continue;
    handledCommandEvents.current.add(event.eventId);
    if (event.type === "session.reset" && event.data.previousSessionId === openedSessionRef.current && typeof event.data.sessionId === "string") {
      const sessionId = event.data.sessionId;
      setState(current => ({
        ...current,
        histories: { ...current.histories, [sessionId]: { status: "ready", items: [], hasMore: false } },
      }));
      void refreshSnapshot().then(() => openSession(sessionId)).catch(reason => setState(current => ({ ...current, error: reason instanceof Error ? reason.message : "新会话打开失败" })));
    } else if (event.type === "session.rewound" && event.sessionId) {
      const sessionId = event.sessionId;
      setState(current => ({ ...current, histories: { ...current.histories, [sessionId]: { status: "loading", items: [], hasMore: false } } }));
      if (sessionId === openedSessionRef.current) void openSession(sessionId);
    } else if (event.type === "session.compacted" && event.sessionId === openedSessionRef.current) {
      void openSession(event.sessionId!);
    }
  }
}

export async function loadOlderBridgeEvidence(
  ctx: Pick<BridgeArtifactsContext, "setState" | "stateRef" | "sendRequest">,
  sessionId: string,
): Promise<void> {
  const { setState, stateRef, sendRequest } = ctx;
  const current = stateRef.current.evidence[sessionId];
  if (!current?.nextCursor || current.status === "loading") return;
  setState((stateValue) => ({
    ...stateValue,
    evidence: {
      ...stateValue.evidence,
      [sessionId]: { ...current, status: "loading" },
    },
  }));
  try {
    const response = await sendRequest("evidence.list", {
      sessionId,
      cursor: current.nextCursor,
      limit: 30,
    }, { wait: true, timeoutMs: 45_000 });
    if (!response?.ok) throw new Error(response?.error?.message ?? "成果加载失败");
    const result = response.result as { evidence?: BridgeEvidencePage };
    if (!result.evidence) throw new Error("电脑未返回成果证据");
    const page = result.evidence;
    setState((stateValue) => ({
      ...stateValue,
      evidence: {
        ...stateValue.evidence,
        [sessionId]: {
          status: "ready",
          items: mergeEvidence(current.items, page.items),
          hasMore: page.hasMore,
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        },
      },
    }));
  } catch (error) {
    setState((stateValue) => ({
      ...stateValue,
      evidence: {
        ...stateValue.evidence,
        [sessionId]: { ...current, status: "error" },
      },
      error: error instanceof Error ? error.message : "成果加载失败",
    }));
  }
}

export async function loadBridgeEvidenceDetails(
  ctx: Pick<BridgeArtifactsContext, "stateRef" | "cryptoRef" | "sendRequest">,
  evidenceId: string,
  kind: "tools" | "artifacts",
  cursor?: string,
): Promise<BridgeEvidenceDetailPage> {
  const { stateRef, cryptoRef, sendRequest } = ctx;
  const crypto = cryptoRef.current;
  const paged = stateRef.current.snapshot?.host.capabilities?.includes("evidence.details.v1");
  const response = await sendRequest(paged ? "evidence.details" : "evidence.get", {
    evidenceId, ...(paged ? { kind, cursor, limit: 30 } : {}),
  }, { wait: true, timeoutMs: 30_000, allowOffline: false });
  if (cryptoRef.current !== crypto) throw new Error("连接已切换，请重新打开成果");
  if (!response?.ok) throw new Error(response?.error?.message ?? "读取成果详情失败");
  if (paged) return (response.result as { page: BridgeEvidenceDetailPage }).page;
  const bundle = (response.result as { evidence: BridgeEvidenceBundle }).evidence;
  const offset = cursor ? Number(cursor) : 0;
  const hasMore = offset + 30 < bundle[kind].length;
  const next = { evidenceId, hasMore, ...(hasMore ? { nextCursor: String(offset + 30) } : {}) };
  return kind === "tools"
    ? { ...next, kind, items: bundle.tools.slice(offset, offset + 30) }
    : { ...next, kind, items: bundle.artifacts.slice(offset, offset + 30) };
}

export async function previewBridgeArtifact(
  ctx: Pick<BridgeArtifactsContext, "setState" | "stateRef" | "sendRequest">,
  artifactId: string,
): Promise<BridgeArtifactPreview> {
  const { setState, stateRef, sendRequest } = ctx;
  const cached = stateRef.current.artifactPreviews[artifactId];
  if (cached) return cached;
  const response = await sendRequest("artifact.preview", { artifactId }, {
    wait: true,
    timeoutMs: 60_000,
  });
  if (!response?.ok) throw new Error(response?.error?.message ?? "成果预览失败");
  const result = response.result as { preview?: BridgeArtifactPreview };
  if (!result.preview) throw new Error("电脑未返回成果预览");
  setState((current) => ({
    ...current,
    artifactPreviews: {
      ...current.artifactPreviews,
      [artifactId]: result.preview!,
    },
  }));
  return result.preview;
}

export async function downloadBridgeSessionArtifact(
  ctx: Pick<BridgeArtifactsContext, "setState" | "sendRequest">,
  artifact: BridgeArtifactManifest,
): Promise<void> {
  const { setState, sendRequest } = ctx;
  setState((current) => ({
    ...current,
    artifactTransfers: { ...current.artifactTransfers, [artifact.id]: 0 },
  }));
  try {
    await downloadBridgeArtifact(
      artifact,
      (method, params, options) => sendRequest(method, params, options),
      (progress) => setState((current) => ({
        ...current,
        artifactTransfers: {
          ...current.artifactTransfers,
          [artifact.id]: progress,
        },
      })),
    );
  } finally {
    setState((current) => {
      const artifactTransfers = { ...current.artifactTransfers };
      delete artifactTransfers[artifact.id];
      return { ...current, artifactTransfers };
    });
  }
}

export async function downloadBridgeSessionPathFile(
  ctx: Pick<BridgeArtifactsContext, "setState" | "sendRequest">,
  sessionId: string,
  filePath: string,
): Promise<void> {
  const { setState, sendRequest } = ctx;
  const transferKey = `file:${filePath}`;
  setState((current) => ({
    ...current,
    artifactTransfers: { ...current.artifactTransfers, [transferKey]: 0 },
  }));
  try {
    await downloadBridgeSessionFile(
      sessionId,
      filePath,
      (method, params, options) => sendRequest(method, params, options),
      (progress) => setState((current) => ({
        ...current,
        artifactTransfers: {
          ...current.artifactTransfers,
          [transferKey]: progress,
        },
      })),
    );
  } finally {
    setState((current) => {
      const artifactTransfers = { ...current.artifactTransfers };
      delete artifactTransfers[transferKey];
      return { ...current, artifactTransfers };
    });
  }
}

export async function loadOlderBridgeHistory(
  ctx: BridgeArtifactsContext & {
    loadingHistoryRef: MutableRefObject<Map<string, BridgeTransport | undefined>>;
  },
  sessionId: string,
): Promise<void> {
  const { setState, stateRef, cryptoRef, socketRef, sendRequest, loadingHistoryRef } = ctx;
  const current = stateRef.current.histories[sessionId];
  if (!current?.hasMore || !current.nextCursor || current.status === "loading") return;
  const crypto = cryptoRef.current;
  const socket = socketRef.current;
  const isCurrent = () => cryptoRef.current === crypto && socketRef.current === socket;
  const key = `${crypto?.identity.roomId}:${sessionId}`;
  if (loadingHistoryRef.current.has(key) && loadingHistoryRef.current.get(key) === socket) return;
  loadingHistoryRef.current.set(key, socket);
  const requestedCursor = current.nextCursor;
  setState((stateValue) => ({
    ...stateValue,
    histories: {
      ...stateValue.histories,
      // Keep the error row until the prepend can compensate for its removal.
      [sessionId]: { ...current, status: "loading" },
    },
  }));
  try {
    const response = await sendRequest("session.history", {
      sessionId,
      cursor: requestedCursor,
      limit: HISTORY_PAGE_SIZE,
    }, { wait: true, timeoutMs: 25_000 });
    if (!isCurrent()) return;
    if (!response?.ok) throw new Error(response?.error?.message ?? "历史加载失败");
    const result = response.result as { history?: BridgeHistoryPage };
    if (!result.history) throw new Error("电脑未返回历史");
    const page = result.history;
    setState((stateValue) => {
      if (!isCurrent()) return stateValue;
      const existingItems = stateValue.histories[sessionId]?.items ?? current.items;
      return {
        ...stateValue,
        histories: {
          ...stateValue.histories,
          [sessionId]: {
            status: "ready",
            items: mergeHistoryPages(page.items, existingItems),
            hasMore: page.hasMore,
            ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
          },
        },
      };
    });
  } catch (error) {
    setState((stateValue) => isCurrent() ? {
      ...stateValue,
      histories: {
        ...stateValue.histories,
        [sessionId]: {
          ...(stateValue.histories[sessionId] ?? current),
          status: "ready",
          error: error instanceof Error ? error.message : "历史加载失败",
        },
      },
    } : stateValue);
  } finally {
    if (loadingHistoryRef.current.get(key) === socket) loadingHistoryRef.current.delete(key);
  }
}

export const uploadBridgeSessionFile = (
  sendRequest: BridgeSendRequest,
  ...args: Parameters<UploadFileHandler>
): ReturnType<UploadFileHandler> => uploadSessionFile(sendRequest, ...args);
