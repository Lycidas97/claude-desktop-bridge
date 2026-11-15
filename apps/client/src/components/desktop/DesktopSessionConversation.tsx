import { evidenceSummary } from "@bridge/protocol";
import type {
  BridgeArtifactManifest,
  BridgeArtifactPreview,
  BridgeAttachment,
  BridgeBackgroundTask,
  BridgeEvidenceBundle,
  BridgeEvidenceDetailPage,
  BridgeEvidencePage,
  BridgeEvent,
  BridgeHistoryPage,
  BridgeNativePermissionMode,
  BridgePermissionRules,
  BridgePrAutoFixState,
  BridgePrAutoFixUpdate,
  BridgePullRequest,
  BridgeResponse,
  BridgeSDKPermissionMode,
  BridgeSessionCommandResult,
  BridgeSessionConfiguration,
  BridgeSessionInfo,
  BridgeSessionPermissions,
  BridgeSessionRewindPreview,
  BridgeSessionRewindResult,
  BridgeSessionRewindScope,
  BridgeSlashCommandCatalog,
  DesktopControlSnapshot,
  LocalBridgeRequest,
} from "@bridge/protocol";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { HISTORY_PAGE_SIZE, mergeHistoryPages } from "../../hooks/bridge/bridge-reducers.js";
import type { SessionEvidenceState, SessionHistoryState } from "../../hooks/useMobileBridge.js";
import { downloadBridgeArtifact, downloadBridgeSessionFile } from "../../lib/artifact-download.js";
import { uploadSessionFile, type UploadFileHandler } from "../../lib/file-upload.js";
import { useAssistantMail } from "../assistant/AssistantMailProvider.js";
import { MailReference } from "../assistant/MailReference.js";
import {
  conversationDraftKey,
  useConversationDrafts,
  type ConversationDraftsController,
} from "../conversation/ConversationDraftsProvider.js";
import { ConversationView } from "../conversation/ConversationView.js";
import type { SessionConfigurationChange } from "../session/SessionConfigurationDialog.js";

const EMPTY_PREVIEWS: Record<string, BridgeArtifactPreview> = {};
const EMPTY_TRANSFERS: Record<string, number> = {};
const EMPTY_HOST_EVENTS: BridgeEvent[] = [];

export function unwrap<T>(response: BridgeResponse): T {
  if (!response.ok) {
    throw Object.assign(
      new Error(response.error?.message ?? "Bridge 请求失败"),
      response.error?.code ? { code: response.error.code } : {},
    );
  }
  return response.result as T;
}

export interface DesktopConversationInput {
  snapshot: DesktopControlSnapshot;
  events: BridgeEvent[];
  apiRequest(request: LocalBridgeRequest): Promise<BridgeResponse>;
  onRefreshSnapshot(): Promise<void>;
}

export interface DesktopConversationController {
  hostId: string;
  filterEvents(events: BridgeEvent[], hostId?: string): BridgeEvent[];
  selectedSessionFor(hostId: string): string | undefined;
  selectSession(hostId: string, sessionId: string | undefined): void;
  historyFor(sessionId: string, hostId?: string): SessionHistoryState | undefined;
  evidenceFor(sessionId: string, hostId?: string): SessionEvidenceState | undefined;
  artifactPreviews: Record<string, BridgeArtifactPreview>;
  artifactTransfers: Record<string, number>;
  mountSession(sessionId: string, hostId?: string): () => void;
  resetSessionHistory(sessionId: string, hostId?: string): void;
  openSession(sessionId: string, hostId?: string): Promise<void>;
  loadOlderHistory(sessionId: string, hostId?: string): Promise<void>;
  loadOlderEvidence(sessionId: string, hostId?: string): Promise<void>;
  loadEvidenceDetails(evidenceId: string, kind: "tools" | "artifacts", cursor?: string): Promise<BridgeEvidenceDetailPage>;
  previewArtifact(artifactId: string, hostId?: string): Promise<BridgeArtifactPreview>;
  downloadArtifact(artifact: BridgeArtifactManifest, hostId?: string): Promise<void>;
  downloadSessionFile(sessionId: string, filePath: string, hostId?: string): Promise<void>;
  uploadFile: UploadFileHandler;
  sendTurn(
    sessionId: string,
    text: string,
    attachments: BridgeAttachment[],
    mailRefId?: string,
  ): Promise<{ requestId: string }>;
  interruptTurn(sessionId: string): Promise<void>;
  steerQueuedTurn(sessionId: string, commandId: string): Promise<void>;
  cancelQueuedTurn(sessionId: string, commandId: string): Promise<void>;
  stopSubagent(sessionId: string, agentId: string): Promise<void>;
  resolveUncertainDelivery(commandId: string, action: "confirm" | "retry"): Promise<void>;
  resolvePermission(
    requestId: string,
    decision: "allow-once" | "allow-always" | "deny",
    message?: string,
    updatedInput?: Record<string, unknown>,
    mode?: BridgeNativePermissionMode,
  ): Promise<void>;
  resolvePrompt(sessionId: string, promptId: string, choice: string): Promise<void>;
  readPrAutoFix(sessionId: string, pr?: BridgePullRequest, includeChecks?: boolean): Promise<BridgePrAutoFixState>;
  setPrAutoFix(update: BridgePrAutoFixUpdate): Promise<BridgePrAutoFixState>;
  loadBackgroundTasks(sessionId: string): Promise<BridgeBackgroundTask[]>;
  loadSessionConfiguration(sessionId: string): Promise<BridgeSessionConfiguration>;
  configureSession(sessionId: string, change: SessionConfigurationChange): Promise<BridgeSessionConfiguration>;
  loadSessionCommands(sessionId: string): Promise<BridgeSlashCommandCatalog>;
  runSessionCommand(sessionId: string, text: string): Promise<BridgeSessionCommandResult>;
  renameSessionByCommand(sessionId: string, title: string): Promise<void>;
  loadSessionPermissions(sessionId: string): Promise<BridgeSessionPermissions>;
  saveSessionPermissions(
    sessionId: string,
    mode: BridgeSDKPermissionMode,
    rules: BridgePermissionRules,
  ): Promise<BridgeSessionPermissions>;
  previewRewind(sessionId: string, messageId: string): Promise<BridgeSessionRewindPreview>;
  rewindSession(
    sessionId: string,
    messageId: string,
    scope: BridgeSessionRewindScope,
  ): Promise<BridgeSessionRewindResult>;
  forkSession(sessionId: string): Promise<BridgeSessionInfo>;
  archiveSession(sessionId: string, archived: boolean): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  onRefreshSnapshot(): Promise<void>;
}

const DesktopConversationContext = createContext<DesktopConversationController | undefined>(undefined);

function useDesktopConversationController(
  input: DesktopConversationInput,
  enabled: boolean,
): DesktopConversationController {
  const latestRef = useRef(input);
  latestRef.current = input;

  const [selectedByHost, setSelectedByHost] = useState<Record<string, string | undefined>>({});
  const [histories, setHistories] = useState<Record<string, SessionHistoryState>>({});
  const [evidence, setEvidence] = useState<Record<string, SessionEvidenceState>>({});
  const [artifactPreviewsByHost, setArtifactPreviewsByHost] = useState<Record<string, Record<string, BridgeArtifactPreview>>>({});
  const [artifactTransfersByHost, setArtifactTransfersByHost] = useState<Record<string, Record<string, number>>>({});

  const historiesRef = useRef(histories);
  historiesRef.current = histories;
  const evidenceRef = useRef(evidence);
  evidenceRef.current = evidence;
  const previewsRef = useRef(artifactPreviewsByHost);
  previewsRef.current = artifactPreviewsByHost;

  const loadingHistoryRef = useRef(new Set<string>());
  const loadingEvidenceRef = useRef(new Set<string>());
  const openSeqRef = useRef(new Map<string, number>());
  const mountedCountsRef = useRef(new Map<string, number>());
  const handledEventsRef = useRef(new Set<string>());
  const eventHostByEventIdRef = useRef(new Map<string, string>());

  function filterEvents(
    events: BridgeEvent[],
    targetHostId = latestRef.current.snapshot.host.hostId,
  ): BridgeEvent[] {
    if (events.length === 0) return events;
    let allMatch = true;
    const matched: BridgeEvent[] = [];
    for (const event of events) {
      let owner = eventHostByEventIdRef.current.get(event.eventId);
      if (owner === undefined) {
        owner = targetHostId;
        eventHostByEventIdRef.current.set(event.eventId, owner);
        if (eventHostByEventIdRef.current.size > 4_000) {
          const oldest = eventHostByEventIdRef.current.keys().next().value;
          if (oldest !== undefined) eventHostByEventIdRef.current.delete(oldest);
        }
      }
      if (owner === targetHostId) matched.push(event);
      else allMatch = false;
    }
    if (allMatch) return events;
    return matched.length === 0 ? EMPTY_HOST_EVENTS : matched;
  }

  function updateHistories(
    change: (current: Record<string, SessionHistoryState>) => Record<string, SessionHistoryState>,
  ): void {
    setHistories((current) => {
      const next = change(current);
      historiesRef.current = next;
      return next;
    });
  }

  function updateEvidence(
    change: (current: Record<string, SessionEvidenceState>) => Record<string, SessionEvidenceState>,
  ): void {
    setEvidence((current) => {
      const next = change(current);
      evidenceRef.current = next;
      return next;
    });
  }

  async function openSession(
    sessionId: string,
    targetHostId = latestRef.current.snapshot.host.hostId,
  ): Promise<void> {
    const key = conversationDraftKey(targetHostId, sessionId);
    const seq = (openSeqRef.current.get(key) ?? 0) + 1;
    openSeqRef.current.set(key, seq);
    loadingHistoryRef.current.delete(key);
    loadingEvidenceRef.current.delete(key);

    updateHistories((current) => ({
      ...current,
      [key]: {
        status: "loading",
        items: current[key]?.items ?? [],
        hasMore: current[key]?.hasMore ?? false,
        ...(current[key]?.nextCursor ? { nextCursor: current[key]!.nextCursor } : {}),
      },
    }));
    updateEvidence((current) => ({
      ...current,
      [key]: {
        status: "loading",
        items: current[key]?.items ?? [],
        hasMore: current[key]?.hasMore ?? false,
        ...(current[key]?.nextCursor ? { nextCursor: current[key]!.nextCursor } : {}),
      },
    }));

    try {
      const request = latestRef.current.apiRequest;
      const [result, evidenceResult] = await Promise.all([
        request({
          method: "session.open",
          params: { sessionId, limit: HISTORY_PAGE_SIZE },
        }).then((response) => unwrap<{ history: BridgeHistoryPage }>(response)),
        request({
          method: "evidence.list",
          params: { sessionId, limit: 30 },
        }).then((response) => (
          response.ok ? response.result as { evidence: BridgeEvidencePage } : undefined
        )).catch(() => undefined),
      ]);
      if (openSeqRef.current.get(key) !== seq) return;
      updateHistories((current) => ({
        ...current,
        [key]: {
          status: "ready",
          items: result.history.items,
          hasMore: result.history.hasMore,
          ...(result.history.nextCursor ? { nextCursor: result.history.nextCursor } : {}),
        },
      }));
      updateEvidence((current) => {
        const merged = new Map(
          (current[key]?.items ?? []).map((item) => [item.id, item]),
        );
        for (const item of evidenceResult?.evidence.items ?? []) {
          merged.set(item.id, evidenceSummary(item));
        }
        return {
          ...current,
          [key]: {
            status: evidenceResult ? "ready" : merged.size > 0 ? "ready" : "error",
            items: [...merged.values()].sort((left, right) => right.startedAt - left.startedAt),
            hasMore: evidenceResult?.evidence.hasMore ?? false,
            ...(evidenceResult?.evidence.nextCursor
              ? { nextCursor: evidenceResult.evidence.nextCursor }
              : {}),
          },
        };
      });
    } catch (failure) {
      if (openSeqRef.current.get(key) !== seq) return;
      updateHistories((current) => ({
        ...current,
        [key]: {
          status: "error",
          items: current[key]?.items ?? [],
          hasMore: false,
          error: failure instanceof Error ? failure.message : "会话读取失败",
        },
      }));
      updateEvidence((current) => ({
        ...current,
        [key]: {
          status: current[key]?.items.length ? "ready" : "error",
          items: current[key]?.items ?? [],
          hasMore: current[key]?.hasMore ?? false,
        },
      }));
    }
  }

  function resetSessionHistory(
    sessionId: string,
    targetHostId = latestRef.current.snapshot.host.hostId,
  ): void {
    const key = conversationDraftKey(targetHostId, sessionId);
    openSeqRef.current.set(key, (openSeqRef.current.get(key) ?? 0) + 1);
    loadingHistoryRef.current.delete(key);
    updateHistories((current) => ({
      ...current,
      [key]: { status: "ready", items: [], hasMore: false },
    }));
  }

  function mountSession(
    sessionId: string,
    targetHostId = latestRef.current.snapshot.host.hostId,
  ): () => void {
    const key = conversationDraftKey(targetHostId, sessionId);
    mountedCountsRef.current.set(key, (mountedCountsRef.current.get(key) ?? 0) + 1);
    void openSession(sessionId, targetHostId);
    return () => {
      const nextCount = (mountedCountsRef.current.get(key) ?? 1) - 1;
      if (nextCount <= 0) mountedCountsRef.current.delete(key);
      else mountedCountsRef.current.set(key, nextCount);
    };
  }

  useEffect(() => {
    if (!enabled) return;
    const hostId = input.snapshot.host.hostId;
    const hostEvents = filterEvents(input.events, hostId);
    const incoming = hostEvents.flatMap((event): BridgeEvidenceBundle[] => {
      if (!event.type.startsWith("evidence.")) return [];
      const item = event.data.evidence as Partial<BridgeEvidenceBundle> | undefined;
      if (
        !item
        || typeof item.id !== "string"
        || typeof item.sessionId !== "string"
        || !Array.isArray(item.tools)
        || !Array.isArray(item.artifacts)
      ) return [];
      return [evidenceSummary(item as BridgeEvidenceBundle)];
    });
    if (incoming.length === 0) return;
    updateEvidence((current) => {
      const next = { ...current };
      for (const item of incoming) {
        const key = conversationDraftKey(hostId, item.sessionId);
        const previous = next[key] ?? { status: "ready", items: [], hasMore: false };
        const merged = new Map(previous.items.map((candidate) => [candidate.id, candidate]));
        merged.set(item.id, item);
        next[key] = {
          ...previous,
          status: "ready",
          items: [...merged.values()].sort((left, right) => right.startedAt - left.startedAt),
        };
      }
      return next;
    });
  }, [enabled, input.events, input.snapshot.host.hostId]);

  useEffect(() => {
    if (!enabled) return;
    const hostId = input.snapshot.host.hostId;
    const hostEvents = filterEvents(input.events, hostId);
    for (const event of hostEvents) {
      if (event.type !== "session.rewound" && event.type !== "session.compacted") continue;
      const eventKey = `${hostId}:${event.eventId}`;
      if (handledEventsRef.current.has(eventKey)) continue;
      handledEventsRef.current.add(eventKey);
      if (!event.sessionId) continue;
      const key = conversationDraftKey(hostId, event.sessionId);
      if (event.type === "session.rewound") {
        openSeqRef.current.set(key, (openSeqRef.current.get(key) ?? 0) + 1);
        loadingHistoryRef.current.delete(key);
        updateHistories((current) => ({
          ...current,
          [key]: { status: "loading", items: [], hasMore: false },
        }));
        if ((mountedCountsRef.current.get(key) ?? 0) > 0) {
          void openSession(event.sessionId, hostId);
        }
      } else if ((mountedCountsRef.current.get(key) ?? 0) > 0) {
        void openSession(event.sessionId, hostId);
      } else {
        openSeqRef.current.set(key, (openSeqRef.current.get(key) ?? 0) + 1);
        loadingHistoryRef.current.delete(key);
        updateHistories((current) => {
          if (!(key in current)) return current;
          const next = { ...current };
          delete next[key];
          return next;
        });
      }
    }
  }, [enabled, input.events, input.snapshot.host.hostId]);

  async function loadOlderHistory(
    sessionId: string,
    targetHostId = latestRef.current.snapshot.host.hostId,
  ): Promise<void> {
    const key = conversationDraftKey(targetHostId, sessionId);
    const current = historiesRef.current[key];
    if (!current?.hasMore || !current.nextCursor || current.status === "loading" || loadingHistoryRef.current.has(key)) {
      return;
    }
    const requestedCursor = current.nextCursor;
    const startSeq = openSeqRef.current.get(key) ?? 0;
    loadingHistoryRef.current.add(key);
    updateHistories((value) => ({
      ...value,
      [key]: { ...current, status: "loading" },
    }));
    try {
      const result = unwrap<{ history: BridgeHistoryPage }>(await latestRef.current.apiRequest({
        method: "session.history",
        params: { sessionId, cursor: requestedCursor, limit: HISTORY_PAGE_SIZE },
      }));
      if ((openSeqRef.current.get(key) ?? 0) !== startSeq) return;
      updateHistories((value) => {
        const existingItems = value[key]?.items ?? current.items;
        return {
          ...value,
          [key]: {
            status: "ready",
            items: mergeHistoryPages(result.history.items, existingItems),
            hasMore: result.history.hasMore,
            ...(result.history.nextCursor ? { nextCursor: result.history.nextCursor } : {}),
          },
        };
      });
    } catch (failure) {
      if ((openSeqRef.current.get(key) ?? 0) !== startSeq) return;
      updateHistories((value) => ({
        ...value,
        [key]: {
          ...(value[key] ?? current),
          status: "ready",
          error: failure instanceof Error ? failure.message : "历史加载失败",
        },
      }));
    } finally {
      if ((openSeqRef.current.get(key) ?? 0) === startSeq) {
        loadingHistoryRef.current.delete(key);
      }
    }
  }

  async function loadOlderEvidence(
    sessionId: string,
    targetHostId = latestRef.current.snapshot.host.hostId,
  ): Promise<void> {
    const key = conversationDraftKey(targetHostId, sessionId);
    const current = evidenceRef.current[key];
    if (!current?.nextCursor || current.status === "loading" || loadingEvidenceRef.current.has(key)) return;
    const requestedCursor = current.nextCursor;
    const startSeq = openSeqRef.current.get(key) ?? 0;
    loadingEvidenceRef.current.add(key);
    updateEvidence((value) => ({
      ...value,
      [key]: { ...current, status: "loading" },
    }));
    try {
      const result = unwrap<{ evidence: BridgeEvidencePage }>(await latestRef.current.apiRequest({
        method: "evidence.list",
        params: { sessionId, cursor: requestedCursor, limit: 30 },
      }));
      if ((openSeqRef.current.get(key) ?? 0) !== startSeq) return;
      updateEvidence((value) => {
        const existing = value[key]?.items ?? current.items;
        const merged = new Map(existing.map((item) => [item.id, item]));
        for (const item of result.evidence.items) merged.set(item.id, evidenceSummary(item));
        return {
          ...value,
          [key]: {
            status: "ready",
            items: [...merged.values()].sort((left, right) => right.startedAt - left.startedAt),
            hasMore: result.evidence.hasMore,
            ...(result.evidence.nextCursor ? { nextCursor: result.evidence.nextCursor } : {}),
          },
        };
      });
    } catch {
      if ((openSeqRef.current.get(key) ?? 0) !== startSeq) return;
      updateEvidence((value) => ({
        ...value,
        [key]: { ...(value[key] ?? current), status: "error" },
      }));
    } finally {
      if ((openSeqRef.current.get(key) ?? 0) === startSeq) {
        loadingEvidenceRef.current.delete(key);
      }
    }
  }

  async function loadEvidenceDetails(
    evidenceId: string,
    kind: "tools" | "artifacts",
    cursor?: string,
  ): Promise<BridgeEvidenceDetailPage> {
    const { snapshot, apiRequest } = latestRef.current;
    if (snapshot.host.capabilities.includes("evidence.details.v1")) {
      return unwrap<{ page: BridgeEvidenceDetailPage }>(await apiRequest({
        method: "evidence.details",
        params: { evidenceId, kind, ...(cursor ? { cursor } : {}), limit: 30 },
      })).page;
    }
    const bundle = unwrap<{ evidence: BridgeEvidenceBundle }>(await apiRequest({
      method: "evidence.get",
      params: { evidenceId },
    })).evidence;
    const offset = cursor ? Number(cursor) : 0;
    const hasMore = offset + 30 < bundle[kind].length;
    const next = { evidenceId, hasMore, ...(hasMore ? { nextCursor: String(offset + 30) } : {}) };
    return kind === "tools"
      ? { ...next, kind, items: bundle.tools.slice(offset, offset + 30) }
      : { ...next, kind, items: bundle.artifacts.slice(offset, offset + 30) };
  }

  async function previewArtifact(
    artifactId: string,
    targetHostId = latestRef.current.snapshot.host.hostId,
  ): Promise<BridgeArtifactPreview> {
    const cached = previewsRef.current[targetHostId]?.[artifactId];
    if (cached) return cached;
    const startingRequest = latestRef.current.apiRequest;
    if (latestRef.current.snapshot.host.hostId !== targetHostId) {
      throw new Error("主机已切换，成果预览已取消");
    }
    const response = await startingRequest({
      method: "artifact.preview",
      params: { artifactId },
    });
    if (latestRef.current.snapshot.host.hostId !== targetHostId) {
      throw new Error("主机已切换，成果预览已取消");
    }
    const preview = unwrap<{ preview: BridgeArtifactPreview }>(response).preview;
    setArtifactPreviewsByHost((current) => {
      const next = {
        ...current,
        [targetHostId]: { ...current[targetHostId], [artifactId]: preview },
      };
      previewsRef.current = next;
      return next;
    });
    return preview;
  }

  function setHostTransfer(hostId: string, transferKey: string, progress: number | undefined): void {
    setArtifactTransfersByHost((current) => {
      const hostTransfers = current[hostId] ?? {};
      if (progress === undefined) {
        if (!(transferKey in hostTransfers)) return current;
        const nextHost = { ...hostTransfers };
        delete nextHost[transferKey];
        return { ...current, [hostId]: nextHost };
      }
      return {
        ...current,
        [hostId]: { ...hostTransfers, [transferKey]: progress },
      };
    });
  }

  function createHostBoundTransferRequest(startingHostId: string) {
    const startingRequest = latestRef.current.apiRequest;
    return async (method: LocalBridgeRequest["method"], params: Record<string, unknown>): Promise<BridgeResponse> => {
      if (latestRef.current.snapshot.host.hostId !== startingHostId) {
        throw new Error("主机已切换，文件传输已取消");
      }
      const response = await startingRequest({ method, params });
      if (latestRef.current.snapshot.host.hostId !== startingHostId) {
        throw new Error("主机已切换，文件传输已取消");
      }
      return response;
    };
  }

  async function downloadArtifact(
    artifact: BridgeArtifactManifest,
    targetHostId = latestRef.current.snapshot.host.hostId,
  ): Promise<void> {
    const transferRequest = createHostBoundTransferRequest(targetHostId);
    setHostTransfer(targetHostId, artifact.id, 0);
    try {
      await downloadBridgeArtifact(
        artifact,
        transferRequest,
        (progress) => {
          if (latestRef.current.snapshot.host.hostId === targetHostId) {
            setHostTransfer(targetHostId, artifact.id, progress);
          }
        },
      );
    } finally {
      setHostTransfer(targetHostId, artifact.id, undefined);
    }
  }

  async function downloadSessionFile(
    sessionId: string,
    filePath: string,
    targetHostId = latestRef.current.snapshot.host.hostId,
  ): Promise<void> {
    const transferKey = `file:${filePath}`;
    const transferRequest = createHostBoundTransferRequest(targetHostId);
    setHostTransfer(targetHostId, transferKey, 0);
    try {
      await downloadBridgeSessionFile(
        sessionId,
        filePath,
        transferRequest,
        (progress) => {
          if (latestRef.current.snapshot.host.hostId === targetHostId) {
            setHostTransfer(targetHostId, transferKey, progress);
          }
        },
      );
    } finally {
      setHostTransfer(targetHostId, transferKey, undefined);
    }
  }

  const uploadFile: UploadFileHandler = (sessionId, file, onProgress, signal) => {
    const startingHostId = latestRef.current.snapshot.host.hostId;
    const startingRequest = latestRef.current.apiRequest;
    return uploadSessionFile(
      async (method, params) => {
        if (latestRef.current.snapshot.host.hostId !== startingHostId) {
          throw new Error("主机已切换，文件上传已取消");
        }
        const response = await startingRequest({ method, params });
        if (latestRef.current.snapshot.host.hostId !== startingHostId) {
          throw new Error("主机已切换，文件上传已取消");
        }
        return response;
      },
      sessionId,
      file,
      onProgress,
      signal,
    );
  };

  const currentHostId = input.snapshot.host.hostId;

  return useMemo<DesktopConversationController>(() => ({
    hostId: currentHostId,
    filterEvents,
    selectedSessionFor: (hostId) => selectedByHost[hostId],
    selectSession: (hostId, sessionId) => {
      setSelectedByHost((current) => (
        Object.is(current[hostId], sessionId) ? current : { ...current, [hostId]: sessionId }
      ));
    },
    historyFor: (sessionId, hostId = latestRef.current.snapshot.host.hostId) => (
      histories[conversationDraftKey(hostId, sessionId)]
    ),
    evidenceFor: (sessionId, hostId = latestRef.current.snapshot.host.hostId) => (
      evidence[conversationDraftKey(hostId, sessionId)]
    ),
    artifactPreviews: artifactPreviewsByHost[currentHostId] ?? EMPTY_PREVIEWS,
    artifactTransfers: artifactTransfersByHost[currentHostId] ?? EMPTY_TRANSFERS,
    mountSession,
    resetSessionHistory,
    openSession,
    loadOlderHistory,
    loadOlderEvidence,
    loadEvidenceDetails,
    previewArtifact,
    downloadArtifact,
    downloadSessionFile,
    uploadFile,
    async sendTurn(sessionId, text, attachments, mailRefId) {
      const response = await latestRef.current.apiRequest({
        method: "turn.start",
        params: {
          sessionId,
          text,
          attachments,
          ...(mailRefId ? { mailRefId } : {}),
        },
        idempotencyKey: crypto.randomUUID(),
      });
      unwrap(response);
      return { requestId: response.requestId };
    },
    async interruptTurn(sessionId) {
      const result = unwrap<{ interrupted: boolean }>(await latestRef.current.apiRequest({
        method: "turn.interrupt",
        params: { sessionId, force: true },
      }));
      if (!result.interrupted) throw new Error("当前没有可停止的 Bridge 任务");
    },
    async steerQueuedTurn(sessionId, commandId) {
      const result = unwrap<{ state?: string }>(await latestRef.current.apiRequest({
        method: "turn.queue.steer",
        params: { sessionId, commandId },
      }));
      if (result.state === "uncertain") {
        throw new Error("消息投递状态尚未确认，请同步状态后重试");
      }
    },
    async cancelQueuedTurn(sessionId, commandId) {
      unwrap(await latestRef.current.apiRequest({
        method: "turn.queue.cancel",
        params: { sessionId, commandId },
      }));
    },
    async stopSubagent(sessionId, agentId) {
      unwrap(await latestRef.current.apiRequest({
        method: "subagent.stop",
        params: { sessionId, agentId },
      }));
    },
    async resolveUncertainDelivery(commandId, action) {
      unwrap(await latestRef.current.apiRequest({
        method: "message.delivery.resolve",
        params: { commandId, action },
      }));
    },
    async resolvePermission(requestId, decision, message, updatedInput, mode) {
      unwrap(await latestRef.current.apiRequest({
        method: "permission.resolve",
        params: {
          requestId,
          decision,
          ...(message ? { message } : {}),
          ...(updatedInput ? { updatedInput } : {}),
          ...(mode ? { mode } : {}),
        },
      }));
    },
    async resolvePrompt(sessionId, promptId, choice) {
      const response = await latestRef.current.apiRequest({
        method: "prompt.resolve",
        params: { sessionId, promptId, choice },
      });
      if (response.ok || response.error?.code === "ALREADY_RESOLVED") {
        await latestRef.current.onRefreshSnapshot();
      }
      unwrap(response);
    },
    async readPrAutoFix(sessionId, pr, includeChecks) {
      return unwrap<BridgePrAutoFixState>(await latestRef.current.apiRequest({
        method: "pr.autoFix.read",
        params: {
          sessionId,
          ...(pr ? { repo: pr.repo, prNumber: pr.prNumber, ...(pr.host ? { host: pr.host } : {}) } : {}),
          includeChecks,
        },
      }));
    },
    async setPrAutoFix(update) {
      const next = unwrap<BridgePrAutoFixState>(await latestRef.current.apiRequest({
        method: "pr.autoFix.set",
        params: update,
      }));
      await latestRef.current.onRefreshSnapshot();
      return next;
    },
    async loadBackgroundTasks(sessionId) {
      const result = unwrap<{ session?: BridgeSessionInfo }>(await latestRef.current.apiRequest({
        method: "session.configuration",
        params: { sessionId, includeBackgroundTasks: true },
      }));
      return result.session?.backgroundTasks ?? [];
    },
    async loadSessionConfiguration(sessionId) {
      return unwrap<{ configuration: BridgeSessionConfiguration }>(await latestRef.current.apiRequest({
        method: "session.configuration",
        params: { sessionId },
      })).configuration;
    },
    async configureSession(sessionId, change) {
      return unwrap<{ configuration: BridgeSessionConfiguration }>(await latestRef.current.apiRequest({
        method: "session.configure",
        params: { sessionId, ...change },
      })).configuration;
    },
    async loadSessionCommands(sessionId) {
      return unwrap<{ catalog: BridgeSlashCommandCatalog }>(await latestRef.current.apiRequest({
        method: "session.commands",
        params: { sessionId },
      })).catalog;
    },
    async runSessionCommand(sessionId, text) {
      const result = unwrap<{ command: BridgeSessionCommandResult }>(await latestRef.current.apiRequest({
        method: "session.command",
        params: { sessionId, text },
      })).command;
      if (result.session) await latestRef.current.onRefreshSnapshot();
      return result;
    },
    async renameSessionByCommand(sessionId, title) {
      unwrap(await latestRef.current.apiRequest({
        method: "session.command",
        params: { sessionId, text: `/rename ${title}` },
      }));
      await latestRef.current.onRefreshSnapshot();
    },
    async loadSessionPermissions(sessionId) {
      return unwrap<{ permissions: BridgeSessionPermissions }>(await latestRef.current.apiRequest({
        method: "session.permissions",
        params: { sessionId },
      })).permissions;
    },
    async saveSessionPermissions(sessionId, mode, rules) {
      return unwrap<{ permissions: BridgeSessionPermissions }>(await latestRef.current.apiRequest({
        method: "session.permissions.configure",
        params: { sessionId, mode, rules },
      })).permissions;
    },
    async previewRewind(sessionId, messageId) {
      return unwrap<{ rewind: BridgeSessionRewindPreview }>(await latestRef.current.apiRequest({
        method: "session.rewind.preview",
        params: { sessionId, messageId },
      })).rewind;
    },
    async rewindSession(sessionId, messageId, scope) {
      return unwrap<{ rewind: BridgeSessionRewindResult }>(await latestRef.current.apiRequest({
        method: "session.rewind",
        params: { sessionId, messageId, scope },
      })).rewind;
    },
    async forkSession(sessionId) {
      return unwrap<{ session: BridgeSessionInfo }>(await latestRef.current.apiRequest({
        method: "session.fork",
        params: { sessionId },
      })).session;
    },
    async archiveSession(sessionId, archived) {
      unwrap(await latestRef.current.apiRequest({
        method: "session.archive",
        params: { sessionId, archived },
      }));
      await latestRef.current.onRefreshSnapshot();
    },
    async deleteSession(sessionId) {
      unwrap(await latestRef.current.apiRequest({
        method: "session.delete",
        params: { sessionId },
      }));
      await latestRef.current.onRefreshSnapshot();
    },
    onRefreshSnapshot: () => latestRef.current.onRefreshSnapshot(),
  }), [
    artifactPreviewsByHost,
    artifactTransfersByHost,
    currentHostId,
    evidence,
    histories,
    selectedByHost,
  ]);
}

export function DesktopConversationProvider({
  snapshot,
  events,
  apiRequest,
  onRefreshSnapshot,
  children,
}: DesktopConversationInput & { children: ReactNode }) {
  const controller = useDesktopConversationController(
    { snapshot, events, apiRequest, onRefreshSnapshot },
    true,
  );
  return (
    <DesktopConversationContext.Provider value={controller}>
      {children}
    </DesktopConversationContext.Provider>
  );
}

export function useDesktopConversation(
  input: DesktopConversationInput,
  externalController?: DesktopConversationController,
): DesktopConversationController {
  const context = useContext(DesktopConversationContext);
  const fallback = useDesktopConversationController(input, context === undefined && !externalController);
  return externalController ?? context ?? fallback;
}

export function DesktopSessionConversation({
  session,
  snapshot,
  events,
  apiRequest,
  onRefreshSnapshot,
  onSelectSession,
  onForkCreated,
  controller: externalController,
  conversationDrafts: externalDrafts,
  externalActionError,
}: DesktopConversationInput & {
  session: BridgeSessionInfo;
  onSelectSession(sessionId: string): void | Promise<void>;
  onForkCreated?(parentSessionId: string, created: BridgeSessionInfo): void;
  controller?: DesktopConversationController | undefined;
  conversationDrafts?: ConversationDraftsController | undefined;
  externalActionError?: string | undefined;
}) {
  const controller = useDesktopConversation(
    { snapshot, events, apiRequest, onRefreshSnapshot },
    externalController,
  );
  const fallbackDrafts = useConversationDrafts(snapshot.host.hostId);
  const conversationDrafts = externalDrafts ?? fallbackDrafts;
  const assistantMail = useAssistantMail();

  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const hostId = snapshot.host.hostId;
  const sessionKey = conversationDraftKey(hostId, session.sessionId);
  const previousKeyRef = useRef(sessionKey);

  useEffect(() => {
    if (previousKeyRef.current === sessionKey) return;
    previousKeyRef.current = sessionKey;
    setActionError(undefined);
  }, [sessionKey]);

  useEffect(() => controller.mountSession(session.sessionId, hostId), [hostId, session.sessionId]);

  const mailCards = useMemo(
    () => assistantMail?.cache.cards.filter((card) => (
      (card.nativeDelivery.nativeSessionId ?? snapshot.assistantMail?.binding?.nativeSessionId) === session.sessionId
    )) ?? [],
    [assistantMail?.cache.cards, session.sessionId, snapshot.assistantMail?.binding?.nativeSessionId],
  );

  async function handleForkSession(targetSessionId: string): Promise<BridgeSessionInfo | undefined> {
    if (actionBusy) return undefined;
    setActionBusy(true);
    setActionError(undefined);
    try {
      const created = await controller.forkSession(targetSessionId);
      onForkCreated?.(targetSessionId, created);
      await controller.onRefreshSnapshot();
      await onSelectSession(created.sessionId);
      return created;
    } catch (failure) {
      setActionError(failure instanceof Error ? failure.message : String(failure));
      return undefined;
    } finally {
      setActionBusy(false);
    }
  }

  async function handleArchiveSession(targetSessionId: string, archived: boolean): Promise<void> {
    if (actionBusy) return;
    setActionBusy(true);
    setActionError(undefined);
    try {
      await controller.archiveSession(targetSessionId, archived);
    } catch (failure) {
      setActionError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setActionBusy(false);
    }
  }

  async function handleDeleteSession(targetSessionId: string): Promise<void> {
    if (actionBusy) return;
    setActionBusy(true);
    setActionError(undefined);
    try {
      await controller.deleteSession(targetSessionId);
    } catch (failure) {
      setActionError(failure instanceof Error ? failure.message : String(failure));
      throw failure;
    } finally {
      setActionBusy(false);
    }
  }

  const effectiveError = actionError ?? externalActionError;

  return (
    <ConversationView
      variant="desktop"
      hostId={hostId}
      session={session}
      sessions={snapshot.sessions}
      snapshot={snapshot}
      connection={snapshot.connection}
      desktopOnline={snapshot.runtime.desktopIntegration.state !== "disconnected"}
      nativeReady={snapshot.runtime.desktopIntegration.state === "ready"}
      onSelectSession={async (nextSessionId) => {
        await onSelectSession(nextSessionId);
        if (nextSessionId === session.sessionId) {
          await controller.openSession(nextSessionId, hostId);
        }
      }}
      conversationDrafts={conversationDrafts}
      history={controller.historyFor(session.sessionId, hostId)}
      evidence={controller.evidenceFor(session.sessionId, hostId)}
      artifactPreviews={controller.artifactPreviews}
      artifactTransfers={controller.artifactTransfers}
      permissions={snapshot.permissions}
      events={controller.filterEvents(events, hostId)}
      mailCards={mailCards}
      composerBanner={<MailReference sessionId={session.sessionId} />}
      resolveMailRefId={() => assistantMail?.referenceFor(session.sessionId)}
      onOpenSession={(targetSessionId) => controller.openSession(targetSessionId, hostId)}
      onLoadOlderHistory={(targetSessionId) => controller.loadOlderHistory(targetSessionId, hostId)}
      onLoadOlderEvidence={(targetSessionId) => controller.loadOlderEvidence(targetSessionId, hostId)}
      onLoadEvidenceDetails={controller.loadEvidenceDetails}
      onPreviewArtifact={(artifactId) => controller.previewArtifact(artifactId, hostId)}
      onDownloadArtifact={(artifact) => controller.downloadArtifact(artifact, hostId)}
      onDownloadSessionFile={(targetSessionId, filePath) => controller.downloadSessionFile(targetSessionId, filePath, hostId)}
      onUploadFile={controller.uploadFile}
      onSendTurn={controller.sendTurn}
      onInterruptTurn={(targetSessionId) => controller.interruptTurn(targetSessionId)}
      onSteerQueuedTurn={snapshot.host.capabilities.includes("turn.queue.steer.v1") ? controller.steerQueuedTurn : undefined}
      onCancelQueuedTurn={snapshot.host.capabilities.includes("turn.queue.cancel.v1") ? controller.cancelQueuedTurn : undefined}
      onStopSubagent={snapshot.host.capabilities.includes("subagent.stop.v1") ? controller.stopSubagent : undefined}
      onResolveUncertain={controller.resolveUncertainDelivery}
      onResolvePermission={controller.resolvePermission}
      onResolvePrompt={snapshot.host.capabilities.includes("prompt.native.v1") ? controller.resolvePrompt : undefined}
      onReadPrAutoFix={controller.readPrAutoFix}
      onSetPrAutoFix={controller.setPrAutoFix}
      onLoadBackgroundTasks={snapshot.host.capabilities.includes("claude.native-relay.v1") ? controller.loadBackgroundTasks : undefined}
      onLoadSessionConfiguration={controller.loadSessionConfiguration}
      onConfigureSession={controller.configureSession}
      onLoadSessionCommands={controller.loadSessionCommands}
      onRunSessionCommand={controller.runSessionCommand}
      onRenameSession={controller.renameSessionByCommand}
      onLoadSessionPermissions={controller.loadSessionPermissions}
      onSaveSessionPermissions={controller.saveSessionPermissions}
      onPreviewRewind={controller.previewRewind}
      onRewindSession={controller.rewindSession}
      onForkSession={handleForkSession}
      onArchiveSession={handleArchiveSession}
      onDeleteSession={handleDeleteSession}
      sessionActionBusy={actionBusy}
      {...(effectiveError ? { sessionActionError: effectiveError } : {})}
      onSessionActionBusyChange={setActionBusy}
    />
  );
}
