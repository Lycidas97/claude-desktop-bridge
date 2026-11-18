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
  BridgeProjectInfo,
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
import {
  EVIDENCE_PAGE_SIZE,
  HISTORY_PAGE_SIZE,
  REWOUND_HISTORY,
  applyEvidenceEventToPages,
  applyEvidencePageResult,
  projectHistoryPage,
  projectLegacyEvidenceDetails,
} from "../../hooks/bridge/bridge-reducers.js";
import type { SessionEvidenceState, SessionHistoryState } from "../../hooks/useMobileBridge.js";
import { downloadBridgeArtifact, downloadBridgeSessionFile } from "../../lib/artifact-download.js";
import {
  estimateArtifactPreviewBytes,
  registerDiagnosticsStateProvider,
} from "../../lib/diagnostics.js";
import { uploadSessionFile, type UploadFileHandler } from "../../lib/file-upload.js";
import { desktopRuntimeId } from "../../lib/runtime-labels.js";
import { useAssistantMail } from "../assistant/AssistantMailProvider.js";
import { MailReference } from "../assistant/MailReference.js";
import {
  conversationDraftKey,
  useConversationDrafts,
  type ConversationDraftsController,
} from "../conversation/ConversationDraftsProvider.js";
import { EvidencePanel } from "../evidence/EvidencePanel.js";
import { ConversationView } from "../conversation/ConversationView.js";
import type { SessionConfigurationChange } from "../session/SessionConfigurationDialog.js";

const EMPTY_PREVIEWS: Record<string, BridgeArtifactPreview> = {};
const EMPTY_TRANSFERS: Record<string, number> = {};
const EMPTY_HOST_EVENTS: BridgeEvent[] = [];

type DesktopEvidenceState = SessionEvidenceState & { openedIds?: ReadonlySet<string> };

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
  eventsByHost?: Record<string, BridgeEvent[]> | undefined;
  apiRequest(request: LocalBridgeRequest): Promise<BridgeResponse>;
  onRefreshSnapshot(): Promise<void>;
}

export interface DesktopConversationController {
  hostId: string;
  filterEvents(events: BridgeEvent[], hostId?: string): BridgeEvent[];
  selectedSessionFor(hostId: string): string | undefined;
  selectSession(hostId: string, sessionId: string | undefined): void;
  historyFor(sessionId: string, hostId?: string): SessionHistoryState | undefined;
  evidenceFor(sessionId: string, hostId?: string): DesktopEvidenceState | undefined;
  artifactPreviews: Record<string, BridgeArtifactPreview>;
  artifactTransfers: Record<string, number>;
  mountSession(sessionId: string, hostId?: string): () => void;
  resetSessionHistory(sessionId: string, hostId?: string): void;
  openSession(sessionId: string, hostId?: string): Promise<void>;
  refreshSession(sessionId: string, hostId?: string): Promise<boolean>;
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
  renameSession(sessionId: string, title: string): Promise<void>;
  moveSessionSection(
    sessionId: string,
    sectionId: string | null,
  ): Promise<{ session?: BridgeSessionInfo; projects?: BridgeProjectInfo[] }>;
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
  const [evidence, setEvidence] = useState<Record<string, DesktopEvidenceState>>({});
  const [artifactPreviewsByHost, setArtifactPreviewsByHost] = useState<Record<string, Record<string, BridgeArtifactPreview>>>({});
  const [artifactTransfersByHost, setArtifactTransfersByHost] = useState<Record<string, Record<string, number>>>({});

  const historiesRef = useRef(histories);
  historiesRef.current = histories;
  const evidenceRef = useRef(evidence);
  evidenceRef.current = evidence;
  const previewsRef = useRef(artifactPreviewsByHost);
  previewsRef.current = artifactPreviewsByHost;
  const transfersRef = useRef(artifactTransfersByHost);
  transfersRef.current = artifactTransfersByHost;
  const selectedByHostRef = useRef(selectedByHost);
  selectedByHostRef.current = selectedByHost;
  const activeUploadsRef = useRef(0);

  const loadingHistoryRef = useRef(new Set<string>());
  const loadingEvidenceRef = useRef(new Set<string>());
  const openSeqRef = useRef(new Map<string, number>());
  const mountedCountsRef = useRef(new Map<string, number>());
  const handledEventsRef = useRef(new Set<string>());
  // Retained objects keep their identity across buffer updates. A replacement is a new publication.
  const consumedEvidenceRef = useRef(new WeakSet<BridgeEvent>());
  const deletedSessionKeysRef = useRef(new Set<string>());
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
    change: (current: Record<string, DesktopEvidenceState>) => Record<string, DesktopEvidenceState>,
  ): void {
    setEvidence((current) => {
      const next = change(current);
      evidenceRef.current = next;
      return next;
    });
  }

  async function runOpenSession(
    sessionId: string,
    targetHostId = latestRef.current.snapshot.host.hostId,
    propagateError = false,
  ): Promise<boolean> {
    const key = conversationDraftKey(targetHostId, sessionId);
    const seq = (openSeqRef.current.get(key) ?? 0) + 1;
    openSeqRef.current.set(key, seq);
    loadingHistoryRef.current.delete(key);
    loadingEvidenceRef.current.delete(key);
    const itemsAtRequestStart = new Set(evidenceRef.current[key]?.items);

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

    const request = latestRef.current.apiRequest;
    const [historyOpened] = await Promise.all([
      request({
        method: "session.open",
        params: { sessionId, limit: HISTORY_PAGE_SIZE },
      }).then((response) => unwrap<{ history: BridgeHistoryPage }>(response)).then(({ history }) => {
        if (openSeqRef.current.get(key) !== seq) return false;
        updateHistories((current) => ({ ...current, [key]: projectHistoryPage(history) }));
        return true;
      }, (failure) => {
        if (openSeqRef.current.get(key) !== seq) return false;
        const errorMessage = failure instanceof Error ? failure.message : "会话读取失败";
        updateHistories((current) => ({
          ...current,
          [key]: {
            status: "error",
            items: current[key]?.items ?? [],
            hasMore: false,
            error: errorMessage,
          },
        }));
        if (propagateError) throw new Error(errorMessage);
        return false;
      }),
      request({
        method: "evidence.list",
        params: { sessionId, limit: EVIDENCE_PAGE_SIZE },
      }).then((response) => (
        response.ok ? response.result as { evidence: BridgeEvidencePage } : undefined
      ), () => undefined).then((result) => {
        if (openSeqRef.current.get(key) !== seq) return;
        updateEvidence((current) => {
          const next = applyEvidencePageResult(current, key, result?.evidence, { hasMoreOnError: false, itemsAtRequestStart });
          const opened = next[key]!;
          // The reducer keeps post-request live summaries by reference.
          const previousItems = new Set(current[key]?.items);
          const openedIds = new Set(opened.items.filter((item) => item.state !== "collecting" && !previousItems.has(item)).map((item) => item.id));
          return openedIds.size ? { ...next, [key]: { ...opened, openedIds } } : next;
        });
      }),
    ]);
    return historyOpened && openSeqRef.current.get(key) === seq;
  }

  async function openSession(
    sessionId: string,
    targetHostId = latestRef.current.snapshot.host.hostId,
  ): Promise<void> {
    await runOpenSession(sessionId, targetHostId, false);
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

  function evictSessionState(
    sessionId: string,
    targetHostId = latestRef.current.snapshot.host.hostId,
  ): void {
    const key = conversationDraftKey(targetHostId, sessionId);
    openSeqRef.current.delete(key);
    loadingHistoryRef.current.delete(key);
    loadingEvidenceRef.current.delete(key);
    updateHistories((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
    updateEvidence((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
    setSelectedByHost((current) => (
      current[targetHostId] === sessionId ? { ...current, [targetHostId]: undefined } : current
    ));
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
    const keyForSession = (sessionId: string) => conversationDraftKey(hostId, sessionId);
    for (const event of hostEvents) {
      if (event.type.startsWith("evidence.")) {
        if (!consumedEvidenceRef.current.has(event)) {
          consumedEvidenceRef.current.add(event);
          if (event.sessionId && deletedSessionKeysRef.current.has(keyForSession(event.sessionId))) continue;
          updateEvidence((current) => applyEvidenceEventToPages(current, event, keyForSession));
        }
        continue;
      }
      if (event.type !== "session.rewound" && event.type !== "session.compacted" && event.type !== "session.deleted") continue;
      const eventKey = `${hostId}:${event.eventId}`;
      if (handledEventsRef.current.has(eventKey)) continue;
      handledEventsRef.current.add(eventKey);
      if (!event.sessionId) continue;
      if (event.type === "session.deleted") {
        deletedSessionKeysRef.current.add(keyForSession(event.sessionId));
        evictSessionState(event.sessionId, hostId);
        continue;
      }
      const key = conversationDraftKey(hostId, event.sessionId);
      if (event.type === "session.rewound") {
        openSeqRef.current.set(key, (openSeqRef.current.get(key) ?? 0) + 1);
        loadingHistoryRef.current.delete(key);
        updateHistories((current) => ({
          ...current,
          [key]: REWOUND_HISTORY,
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
      if (!loadingHistoryRef.current.has(key) || (openSeqRef.current.get(key) ?? 0) !== startSeq) return;
      updateHistories((value) => ({
        ...value,
        [key]: projectHistoryPage(result.history, value[key]?.items ?? current.items),
      }));
    } catch (failure) {
      if (!loadingHistoryRef.current.has(key) || (openSeqRef.current.get(key) ?? 0) !== startSeq) return;
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
        params: { sessionId, cursor: requestedCursor, limit: EVIDENCE_PAGE_SIZE },
      }));
      if (!loadingEvidenceRef.current.has(key) || (openSeqRef.current.get(key) ?? 0) !== startSeq) return;
      updateEvidence((value) => applyEvidencePageResult(value, key, result.evidence));
    } catch {
      if (!loadingEvidenceRef.current.has(key) || (openSeqRef.current.get(key) ?? 0) !== startSeq) return;
      updateEvidence((value) => applyEvidencePageResult(value, key, undefined, {
        forceErrorStatus: true,
        preserveCursorOnError: true,
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
        params: { evidenceId, kind, ...(cursor ? { cursor } : {}), limit: EVIDENCE_PAGE_SIZE },
      })).page;
    }
    const bundle = unwrap<{ evidence: BridgeEvidenceBundle }>(await apiRequest({
      method: "evidence.get",
      params: { evidenceId },
    })).evidence;
    return projectLegacyEvidenceDetails(evidenceId, bundle, kind, cursor);
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

  const uploadFile: UploadFileHandler = async (sessionId, file, onProgress, signal) => {
    const startingHostId = latestRef.current.snapshot.host.hostId;
    const startingRequest = latestRef.current.apiRequest;
    activeUploadsRef.current += 1;
    try {
      return await uploadSessionFile(
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
    } finally {
      activeUploadsRef.current = Math.max(0, activeUploadsRef.current - 1);
    }
  };

  useEffect(() => {
    if (!enabled) return;
    return registerDiagnosticsStateProvider("desktopConversations", () => {
      const currentInput = latestRef.current;
      const bufferedByHost = currentInput.eventsByHost ?? {
        [currentInput.snapshot.host.hostId]: currentInput.events,
      };
      const trackedHostIds = new Set<string>([currentInput.snapshot.host.hostId]);
      let totalBufferedEvents = 0;
      let maxEventsPerHost = 0;
      for (const [hostId, hostEvents] of Object.entries(bufferedByHost)) {
        trackedHostIds.add(hostId);
        totalBufferedEvents += hostEvents.length;
        maxEventsPerHost = Math.max(maxEventsPerHost, hostEvents.length);
      }
      for (const hostId of Object.keys(selectedByHostRef.current)) trackedHostIds.add(hostId);
      for (const hostId of Object.keys(previewsRef.current)) trackedHostIds.add(hostId);
      for (const hostId of Object.keys(transfersRef.current)) trackedHostIds.add(hostId);

      const historyEntries = Object.entries(historiesRef.current);
      let historyItemsTotal = 0;
      for (const [key, state] of historyEntries) {
        historyItemsTotal += state.items.length;
        try {
          const [hostId] = JSON.parse(key) as [string | undefined, string | undefined];
          if (hostId) trackedHostIds.add(hostId);
        } catch {
          // Ignore malformed key.
        }
      }

      let evidenceCached = 0;
      for (const [key, state] of Object.entries(evidenceRef.current)) {
        evidenceCached += state.items.length;
        try {
          const [hostId] = JSON.parse(key) as [string | undefined, string | undefined];
          if (hostId) trackedHostIds.add(hostId);
        } catch {
          // Ignore malformed key.
        }
      }

      let artifactPreviewsCached = 0;
      let artifactPreviewBytes = 0;
      for (const hostPreviews of Object.values(previewsRef.current)) {
        const values = Object.values(hostPreviews);
        artifactPreviewsCached += values.length;
        for (const preview of values) {
          artifactPreviewBytes += estimateArtifactPreviewBytes(preview);
        }
      }

      let artifactTransfersCount = 0;
      for (const hostTransfers of Object.values(transfersRef.current)) {
        artifactTransfersCount += Object.keys(hostTransfers).length;
      }

      return {
        trackedHosts: trackedHostIds.size,
        totalBufferedEvents,
        maxEventsPerHost,
        historiesCached: historyEntries.length,
        historyItemsTotal,
        evidenceCached,
        artifactPreviewsCached,
        artifactPreviewBytes,
        artifactTransfersCount,
        activeUploads: activeUploadsRef.current,
      };
    });
  }, [enabled]);

  const currentHostId = input.snapshot.host.hostId;
  const stableActions = useRef<Pick<
    DesktopConversationController,
    | "sendTurn"
    | "interruptTurn"
    | "steerQueuedTurn"
    | "cancelQueuedTurn"
    | "stopSubagent"
    | "resolveUncertainDelivery"
    | "resolvePermission"
    | "resolvePrompt"
    | "readPrAutoFix"
    | "setPrAutoFix"
    | "loadBackgroundTasks"
    | "loadSessionConfiguration"
    | "configureSession"
    | "loadSessionCommands"
    | "runSessionCommand"
    | "renameSessionByCommand"
    | "renameSession"
    | "moveSessionSection"
    | "loadSessionPermissions"
    | "saveSessionPermissions"
    | "previewRewind"
    | "rewindSession"
    | "forkSession"
    | "archiveSession"
    | "onRefreshSnapshot"
  >>({
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
    async renameSession(sessionId, title) {
      const trimmed = title.trim();
      const currentSnapshot = latestRef.current.snapshot;
      const target = currentSnapshot.sessions.find((candidate) => candidate.sessionId === sessionId);
      const targetRuntimeId = target ? desktopRuntimeId(target) : "claude-desktop";
      if (
        currentSnapshot.host.capabilities.includes("session.command.v1")
        && targetRuntimeId === "claude-desktop"
      ) {
        unwrap(await latestRef.current.apiRequest({
          method: "session.command",
          params: { sessionId, text: `/rename ${trimmed}` },
        }));
        await latestRef.current.onRefreshSnapshot();
        return;
      }
      unwrap(await latestRef.current.apiRequest({
        method: "session.rename",
        params: { sessionId, title: trimmed },
      }));
      await latestRef.current.onRefreshSnapshot();
    },
    async moveSessionSection(sessionId, sectionId) {
      const moved = unwrap<{ session?: BridgeSessionInfo; projects?: BridgeProjectInfo[] }>(
        await latestRef.current.apiRequest({
          method: "section.move",
          params: { sessionId, sectionId },
        }),
      );
      await latestRef.current.onRefreshSnapshot();
      return moved;
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
    onRefreshSnapshot: () => latestRef.current.onRefreshSnapshot(),
  }).current;

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
    async refreshSession(
      sessionId,
      targetHostId = latestRef.current.snapshot.host.hostId,
    ) {
      await latestRef.current.onRefreshSnapshot();
      return runOpenSession(sessionId, targetHostId, true);
    },
    loadOlderHistory,
    loadOlderEvidence,
    loadEvidenceDetails,
    previewArtifact,
    downloadArtifact,
    downloadSessionFile,
    uploadFile,
    ...stableActions,
    async deleteSession(sessionId) {
      const targetHostId = latestRef.current.snapshot.host.hostId;
      unwrap(await latestRef.current.apiRequest({
        method: "session.delete",
        params: { sessionId },
      }));
      evictSessionState(sessionId, targetHostId);
      await latestRef.current.onRefreshSnapshot();
    },
  }), [
    artifactPreviewsByHost,
    artifactTransfersByHost,
    currentHostId,
    evidence,
    histories,
    selectedByHost,
    stableActions,
  ]);
}

export function DesktopConversationProvider({
  snapshot,
  events,
  eventsByHost,
  apiRequest,
  onRefreshSnapshot,
  children,
}: DesktopConversationInput & { children: ReactNode }) {
  const controller = useDesktopConversationController(
    { snapshot, events, eventsByHost, apiRequest, onRefreshSnapshot },
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
  headerLeading,
  conversationTabLabel,
  controller: externalController,
  conversationDrafts: externalDrafts,
  externalActionError,
}: DesktopConversationInput & {
  session: BridgeSessionInfo;
  onSelectSession(sessionId: string): void | Promise<void>;
  onForkCreated?(parentSessionId: string, created: BridgeSessionInfo): void;
  headerLeading?: ReactNode | undefined;
  conversationTabLabel?: string | undefined;
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

  const hostId = snapshot.host.hostId;
  const evidence = controller.evidenceFor(session.sessionId, hostId);

  useEffect(() => controller.mountSession(session.sessionId, hostId), [hostId, session.sessionId]);

  const mailCards = useMemo(
    () => assistantMail?.cache.cards.filter((card) => (
      (card.nativeDelivery.nativeSessionId ?? snapshot.assistantMail?.binding?.nativeSessionId) === session.sessionId
    )) ?? [],
    [assistantMail?.cache.cards, session.sessionId, snapshot.assistantMail?.binding?.nativeSessionId],
  );
  const canCommand = snapshot.host.capabilities.includes("session.command.v1");
  const canRename = snapshot.host.capabilities.includes("session.rename.v1");

  return (
    <ConversationView
      variant="desktop"
      conversationTabLabel={conversationTabLabel}
      hostId={hostId}
      session={session}
      {...(headerLeading ? { headerLeading } : {})}
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
      evidence={evidence}
      openedEvidenceIds={evidence?.openedIds}
      renderEvidence={(panel) => (
        <EvidencePanel
          {...panel}
          previews={controller.artifactPreviews}
          transfers={controller.artifactTransfers}
          onLoadMore={() => controller.loadOlderEvidence(session.sessionId, hostId)}
          onLoadDetails={controller.loadEvidenceDetails}
          onPreview={(artifactId) => controller.previewArtifact(artifactId, hostId)}
          onDownload={(artifact) => controller.downloadArtifact(artifact, hostId)}
        />
      )}
      permissions={snapshot.permissions}
      events={controller.filterEvents(events, hostId)}
      mailCards={mailCards}
      composerBanner={<MailReference sessionId={session.sessionId} />}
      resolveMailRefId={() => assistantMail?.referenceFor(session.sessionId)}
      onOpenSession={(targetSessionId) => controller.openSession(targetSessionId, hostId)}
      onRefresh={(targetSessionId = session.sessionId) => controller.refreshSession(targetSessionId, hostId)}
      onLoadOlderHistory={(targetSessionId) => controller.loadOlderHistory(targetSessionId, hostId)}
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
      onLoadSessionPermissions={controller.loadSessionPermissions}
      onSaveSessionPermissions={controller.saveSessionPermissions}
      onPreviewRewind={controller.previewRewind}
      onRewindSession={controller.rewindSession}
      sessionMenu={{
        rename: ((canCommand && desktopRuntimeId(session) === "claude-desktop") || canRename) ? controller.renameSession : undefined,
        move: snapshot.host.capabilities.includes("section.move.v1") ? controller.moveSessionSection : undefined,
        async fork(targetSessionId) {
          const created = await controller.forkSession(targetSessionId);
          onForkCreated?.(targetSessionId, created);
          await controller.onRefreshSnapshot();
          return created;
        },
        archive: controller.archiveSession,
        delete: controller.deleteSession,
        error: externalActionError,
      }}
    />
  );
}
