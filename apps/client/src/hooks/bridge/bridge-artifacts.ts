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
  EVIDENCE_PAGE_SIZE,
  HISTORY_PAGE_SIZE,
  REWOUND_HISTORY,
  applyEvidencePageResult,
  applyInitialEvidencePageResult,
  applySessionResultToState,
  projectHistoryPage,
  projectLegacyEvidenceDetails,
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

type LatestHistoryReadContext = BridgeArtifactsContext & { historyReadSequenceRef: MutableRefObject<number> };

export async function openBridgeSession(
  ctx: LatestHistoryReadContext & {
    openedSessionRef: MutableRefObject<string | undefined>;
    openingSessionsRef: MutableRefObject<Map<string, { socket: BridgeTransport | undefined; task: Promise<void> }>>;
  },
  sessionId: string,
): Promise<void> {
  const { setState, stateRef, cryptoRef, socketRef, sendRequest, openedSessionRef, openingSessionsRef } = ctx;
  openedSessionRef.current = sessionId;
  const crypto = cryptoRef.current;
  const socket = socketRef.current;
  const isCurrent = () => cryptoRef.current === crypto && socketRef.current === socket;
  const key = `${crypto?.identity.roomId}:${sessionId}`;
  const inflight = openingSessionsRef.current.get(key);
  if (inflight && inflight.socket === socket) return inflight.task;
  const sequence = ++ctx.historyReadSequenceRef.current;
  const readCompletedTurnId = stateRef.current.snapshot?.sessions.find((session) => session.sessionId === sessionId)?.lastCompletedTurnId;
  const task = (async () => {
    setState((current) => ({
      ...current,
      histories: {
        ...current.histories,
        [sessionId]: {
          status: "loading",
          items: current.histories[sessionId]?.items ?? [],
          hasMore: current.histories[sessionId]?.hasMore ?? false,
          ...(current.histories[sessionId]?.latestRead ? { latestRead: current.histories[sessionId]!.latestRead } : {}),
          ...(current.histories[sessionId]?.sessionProposalResults ? { sessionProposalResults: current.histories[sessionId]!.sessionProposalResults } : {}),
          ...(current.histories[sessionId]?.sessionFileReceipts ? { sessionFileReceipts: current.histories[sessionId]!.sessionFileReceipts } : {}),
          assistantReplyBatches: current.histories[sessionId]?.assistantReplyBatches,
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
      setState((current) => {
        if (!isCurrent() || (current.histories[sessionId]?.latestRead?.sequence ?? 0) > sequence) return current;
        const liveCompletion = current.snapshot?.sessions.find((session) => session.sessionId === sessionId)?.lastCompletedTurnId;
        // The open response can contain a session captured before a newer native completion arrived.
        const session = result.session && liveCompletion && liveCompletion !== readCompletedTurnId
          ? { ...result.session, lastCompletedTurnId: liveCompletion }
          : result.session;
        return applySessionResultToState(current, session, { history: {
          sessionId, page: result.history!, latestRead: { sequence, completedTurnId: readCompletedTurnId },
        } });
      });
      const eventsAtRequestStart = stateRef.current.events;
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
          evidence: applyInitialEvidencePageResult(current, sessionId, evidenceResult?.evidence, eventsAtRequestStart),
        } : current);
      }).catch(() => {
        setState((current) => isCurrent() ? {
          ...current,
          evidence: applyEvidencePageResult(current.evidence, sessionId, undefined, {
            error: true,
          }),
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
            ...(current.histories[sessionId]?.latestRead ? { latestRead: current.histories[sessionId]!.latestRead } : {}),
          ...(current.histories[sessionId]?.sessionProposalResults ? { sessionProposalResults: current.histories[sessionId]!.sessionProposalResults } : {}),
          ...(current.histories[sessionId]?.sessionFileReceipts ? { sessionFileReceipts: current.histories[sessionId]!.sessionFileReceipts } : {}),
            ...(current.histories[sessionId]?.nextCursor ? { nextCursor: current.histories[sessionId]!.nextCursor } : {}),
            assistantReplyBatches: current.histories[sessionId]?.assistantReplyBatches,
            error: error instanceof Error ? error.message : "会话打开失败",
          },
        },
        evidence: applyEvidencePageResult(current.evidence, sessionId, undefined, {
          error: true,
        }),
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
      setState(current => ({ ...current, histories: { ...current.histories, [sessionId]: REWOUND_HISTORY } }));
      if (sessionId === openedSessionRef.current) void openSession(sessionId);
    } else if (event.type === "session.compacted" && event.sessionId === openedSessionRef.current) {
      void openSession(event.sessionId!);
    }
  }
}

export async function loadOlderBridgeEvidence(
  ctx: BridgeArtifactsContext,
  sessionId: string,
): Promise<void> {
  const { setState, stateRef, cryptoRef, socketRef, sendRequest } = ctx;
  const current = stateRef.current.evidence[sessionId];
  if (!current?.nextCursor || current.status === "loading") return;
  const crypto = cryptoRef.current;
  const socket = socketRef.current;
  const isCurrent = () => cryptoRef.current === crypto && socketRef.current === socket;
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
      limit: EVIDENCE_PAGE_SIZE,
    }, { wait: true, timeoutMs: 45_000 });
    if (!response?.ok) throw new Error(response?.error?.message ?? "成果加载失败");
    const result = response.result as { evidence?: BridgeEvidencePage };
    if (!result.evidence) throw new Error("电脑未返回成果证据");
    const page = result.evidence;
    setState((stateValue) => isCurrent() ? {
      ...stateValue,
      evidence: applyEvidencePageResult(stateValue.evidence, sessionId, page),
    } : stateValue);
  } catch (error) {
    setState((stateValue) => isCurrent() ? {
      ...stateValue,
      evidence: applyEvidencePageResult(stateValue.evidence, sessionId, undefined, {
        error: true,
        forceErrorStatus: true,
        preserveCursorOnError: true,
      }),
      error: error instanceof Error ? error.message : "成果加载失败",
    } : stateValue);
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
    evidenceId, ...(paged ? { kind, cursor, limit: EVIDENCE_PAGE_SIZE } : {}),
  }, { wait: true, timeoutMs: 30_000, allowOffline: false });
  if (cryptoRef.current !== crypto) throw new Error("连接已切换，请重新打开成果");
  if (!response?.ok) throw new Error(response?.error?.message ?? "读取成果详情失败");
  if (paged) return (response.result as { page: BridgeEvidenceDetailPage }).page;
  const bundle = (response.result as { evidence: BridgeEvidenceBundle }).evidence;
  return projectLegacyEvidenceDetails(evidenceId, bundle, kind, cursor);
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
  resolveRelativeLink?: true,
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
      resolveRelativeLink,
    );
  } finally {
    setState((current) => {
      const artifactTransfers = { ...current.artifactTransfers };
      delete artifactTransfers[transferKey];
      return { ...current, artifactTransfers };
    });
  }
}

async function requestBridgeHistoryPage(sendRequest: BridgeSendRequest, sessionId: string, cursor?: string): Promise<BridgeHistoryPage> {
  const response = await sendRequest("session.history", {
    sessionId, limit: HISTORY_PAGE_SIZE, ...(cursor ? { cursor } : {}),
  }, { wait: true, timeoutMs: 25_000 });
  if (!response?.ok) throw new Error(response?.error?.message ?? "历史加载失败");
  const result = response.result as { history?: BridgeHistoryPage };
  if (!result.history) throw new Error("电脑未返回历史");
  return result.history;
}

function isTranscriptMessage(item: BridgeHistoryPage["items"][number]): boolean {
  // Projected plans and tool summaries can reuse IDs across disjoint Native pages.
  return (item.role === "user" || item.role === "assistant") && !item.taskPlan;
}

export async function refreshLatestBridgeHistory(
  { setState, stateRef, cryptoRef, socketRef, sendRequest, historyReadSequenceRef }: LatestHistoryReadContext,
  sessionId: string,
  readCompletedTurnId: string | undefined,
): Promise<void> {
  const crypto = cryptoRef.current;
  const socket = socketRef.current;
  const isCurrent = () => cryptoRef.current === crypto && socketRef.current === socket;
  const sequence = ++historyReadSequenceRef.current;
  const existingIds = new Set(stateRef.current.histories[sessionId]?.items.filter(isTranscriptMessage).map(item => item.id));
  const pages: BridgeHistoryPage[] = [];
  let cursor: string | undefined;
  let page: BridgeHistoryPage;
  do {
    page = await requestBridgeHistoryPage(sendRequest, sessionId, cursor);
    if (!isCurrent()) return;
    pages.push(page);
    cursor = page.nextCursor;
    // Read through a gap rather than showing non-adjacent pages as one timeline.
  } while (cursor && existingIds.size > 0 && !page.items.some(item => isTranscriptMessage(item) && existingIds.has(item.id)));
  const newestById = new Map(pages.reverse().flatMap(({ items }) => items.map(item => [item.id, item] as const)));
  const refreshedProposalResults = pages.flatMap(page => page.sessionProposalResults ?? []);
  const refreshedFileReceipts = Object.fromEntries(pages.flatMap(page => Object.entries(page.sessionFileReceipts ?? {})));
  const refreshedReplyBatches = Object.fromEntries(pages.flatMap(page => Object.entries(page.assistantReplyBatches ?? {})));
  const oldest = page.items.find(isTranscriptMessage)?.id;
  setState((current) => {
    if (!isCurrent()) return current;
    const existing = current.histories[sessionId];
    // Discard this response only if a later-started read has already committed.
    if (existing?.latestRead && existing.latestRead.sequence > sequence) return current;
    const overlap = page.hasMore ? existing?.items.findIndex(item => item.id === oldest) ?? -1 : -1;
    const prefix = overlap >= 0 ? existing!.items.slice(0, overlap).filter(item => !newestById.has(item.id)) : [];
    const history = overlap >= 0 ? { ...existing! } : projectHistoryPage(page);
    if (refreshedProposalResults.length) {
      history.sessionProposalResults = [...new Set([...(history.sessionProposalResults ?? []), ...refreshedProposalResults])];
    }
    if (Object.keys(refreshedFileReceipts).length) {
      history.sessionFileReceipts = { ...history.sessionFileReceipts, ...refreshedFileReceipts };
    }
    if (Object.keys(refreshedReplyBatches).length) {
      history.assistantReplyBatches = { ...history.assistantReplyBatches, ...refreshedReplyBatches };
    }
    if (history.status === "error") {
      history.status = "ready";
      delete history.error;
    }
    return {
      ...current,
      histories: {
        ...current.histories,
        [sessionId]: {
          ...history,
          // A newer projection can change a repeated item's timestamp, not its Map position.
          items: [...prefix, ...newestById.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)),
          latestRead: { sequence, completedTurnId: readCompletedTurnId },
        },
      },
    };
  });
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
    const page = await requestBridgeHistoryPage(sendRequest, sessionId, requestedCursor);
    setState((stateValue) => {
      if (!isCurrent()) return stateValue;
      const existing = stateValue.histories[sessionId] ?? current;
      return {
        ...stateValue,
        histories: {
          ...stateValue.histories,
          [sessionId]: {
            ...projectHistoryPage(page, existing),
            ...(existing.latestRead ? { latestRead: existing.latestRead } : {}),
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

export const uploadBridgeSessionFile = async (
  cryptoRef: MutableRefObject<BridgeCrypto | undefined>,
  sendRequest: BridgeSendRequest,
  ...args: Parameters<UploadFileHandler>
): ReturnType<UploadFileHandler> => {
  const startingCrypto = cryptoRef.current;
  const ensureSameHost = () => {
    if (!startingCrypto || cryptoRef.current !== startingCrypto) {
      throw new Error("已切换电脑，上传已中断");
    }
  };
  try {
    const uploaded = await uploadSessionFile(async (method, params, options) => {
      ensureSameHost();
      const response = await sendRequest(method, params, options);
      ensureSameHost();
      return response;
    }, ...args);
    ensureSameHost();
    return uploaded;
  } catch (error) {
    ensureSameHost();
    throw error;
  }
};
