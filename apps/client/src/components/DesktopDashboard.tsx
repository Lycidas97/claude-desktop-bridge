import { isClaudeNativeRelay } from "../hooks/useMobileBridge.js";
import type {
  BridgeAttachment,
  BridgeArtifactManifest,
  BridgeArtifactPreview,
  BridgeEvidenceBundle,
  BridgeEvidenceDetailPage,
  BridgeEvidencePage,
  BridgeEvent,
  BridgeHistoryPage,
  BridgeDesktopRuntimeId,
  BridgeNativePermissionMode,
  BridgeProviderProfile,
  BridgeResponse,
  BridgeSessionCommandResult,
  BridgeSessionRewindPreview,
  BridgeSessionRewindResult,
  BridgeSessionPermissions,
  BridgeSessionConfiguration,
  BridgeSessionInfo,
  BridgeSlashCommandCatalog,
  DesktopControlSnapshot,
} from "@bridge/protocol";
import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  Clipboard,
  ChevronDown,
  ChevronRight,
  ChevronsDown,
  ChevronsUp,
  CircleStop,
  Forward,
  GitFork,
  Laptop,
  LoaderCircle,
  MessageSquare,
  Plus,
  QrCode,
  RefreshCw,
  Send,
  Settings2,
  Smartphone,
  Trash2,
  X,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { evidenceSummary, summarizeEvidenceEvent } from "@bridge/protocol";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { ThemeControl } from "../hooks/useTheme.js";
import type { SessionEvidenceState, SessionHistoryState } from "../hooks/useMobileBridge.js";
import { downloadBridgeArtifact } from "../lib/artifact-download.js";
import { useStreamEntrance } from "../lib/stream-entrance.js";
import {
  collapseProjects,
  expandAllProjects,
  expandProject,
  getSessionAncestorIds,
  groupProjectSessionFamilies,
  toggleCollapsedProject,
  type SessionFamily,
} from "../lib/project-groups.js";
import type { LocalBridgeRequest } from "../runtime/desktop.js";
import { BrandMark } from "./BrandMark.js";
import { ConfirmationDialog } from "./ConfirmationDialog.js";
import { EvidenceInlineSummary, EvidencePanel } from "./EvidencePanel.js";
import { FileChangesCard } from "./FileChangesCard.js";
import { ComposerAttachmentMenu, FileAttachmentPicker, useFileAttachments } from "./FileAttachmentPicker.js";
import { appendUploadedFilePaths, uploadSessionFile } from "../lib/file-upload.js";
import { MediaGallery } from "./MediaGallery.js";
import { MediaPreviewProvider, useMediaPreview } from "./MediaPreviewProvider.js";
import { mediaArtifacts, mediaKind } from "../lib/media-preview.js";
import { IconButton } from "./IconButton.js";
import { MarkdownText } from "./MarkdownText.js";
import { ThemeMenu } from "./ThemeMenu.js";
import { DiagnosticFloatingEntry } from "./DiagnosticLogDialog.js";
import {
  aggregateFileChanges,
  conversationItems,
  conversationTimeline,
  desktopRuntimeId,
  desktopRuntimeName,
  fileToAttachment,
  InteractivePromptCard,
  matchingQuestionPermission,
  ownershipLabel,
  canSendSession,
  canConfigureSession,
  PermissionPrompt,
  sessionProfile,
  stoppableBridgeTask,
  SubagentCard,
} from "./MobileWorkspace.js";
import { SessionActivityIndicator, SessionContextUsageBar } from "./SessionActivityIndicator.js";
import { SlashCommandInput } from "./SlashCommandInput.js";
import { useSessionCommands } from "../hooks/useSessionCommands.js";
import { SessionCommandDialogs } from "./SessionCommandDialogs.js";
import { SessionRewindDialog } from "./SessionRewindDialog.js";
import { SessionNoticeCard } from "./SessionNoticeCard.js";
import { sessionActivity } from "../lib/session-activity.js";
import {
  SessionConfigurationDialog,
  type SessionConfigurationChange,
} from "./SessionConfigurationDialog.js";

import { claudeSnapshot } from "../lib/claude-snapshot.js";
import { DesktopSettings } from "./DesktopSettings.js";
import { SessionCreateDialog } from "./SessionCreateDialog.js";
import { MAGPIE_QUOTA_METHOD, type QuotaSnapshot } from "../../../../plugins/magpie-quota/contract.js";
import { MagpieQuotaProvider } from "../../../../plugins/magpie-quota/client.js";

type DesktopTab = "sessions" | "devices" | "settings";

function unwrap<T>(response: BridgeResponse): T {
  if (!response.ok) throw new Error(response.error?.message ?? "Bridge 请求失败");
  return response.result as T;
}

function formatLastSeen(value: number | undefined, online: boolean): string {
  if (online) return "当前在线";
  if (!value) return "尚未上线";
  const elapsed = Math.max(0, Date.now() - value);
  if (elapsed < 60_000) return "刚刚在线";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前在线`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前在线`;
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(value);
}

function connectionLabel(snapshot: DesktopControlSnapshot): string {
  if (snapshot.host.version.startsWith("0.2.")) return "需要升级";
  if (snapshot.connection === "connecting" || snapshot.connection === "reconnecting") return "正在重连";
  if (snapshot.connection !== "connected") return "主机离线";
  if (snapshot.transport?.path === "direct") return "直连";
  if (snapshot.transport?.path === "public-relay") return "安全中继";
  return "局域网连接";
}

function sessionState(session: BridgeSessionInfo): string {
  if (session.transport === "claude-desktop-native") return ownershipLabel(session);
  if (session.desktopHandoff) return ownershipLabel(session);
  const bridgeCreated = session.source === "bridge";
  if (session.ownership === "OWNERSHIP_CONFLICT") return "写入冲突";
  if (session.ownership === "FALLBACK_CONFIRMATION_REQUIRED") return "等待接管";
  if (session.turnState === "running" && session.executionStage === "starting") return "正在启动";
  if (session.turnState === "running" && session.executionStage === "submitted") return "已提交，等待执行";
  if (session.ownership === "DESKTOP_OBSERVED" && session.turnState === "running") {
    return "桌面运行中";
  }
  if (session.turnState === "running") return bridgeCreated ? "Bridge 运行中" : "运行中";
  if (session.turnState === "queued") return bridgeCreated ? "Bridge 排队中" : "排队中";
  if (bridgeCreated) return "Bridge 待机";
  if (session.transport === "claude-desktop-managed") return "Claude Desktop 同步";
  if (session.ownership === "DESKTOP_OBSERVED") return "桌面待机";
  return "待机";
}

function transportLabel(session: BridgeSessionInfo): string {
  if (session.transport === "claude-desktop-native") return "Claude Desktop 原生会话";
  if (!session.runtimeId || session.runtimeId === "claude-desktop") return "Claude Desktop";
  if (session.desktopHandoff) return "手动交接";
  if (session.transport === "claude-desktop-managed") return "Claude Desktop 同步";
  if (session.source === "bridge") {
    if (session.desktopRegistration?.state === "registered") return "Claude Desktop 已登记";
    if (session.desktopRegistration?.state === "restart-required") return "等待 Desktop 重启";
    return "仅在 Bridge";
  }
  return "桌面会话接管";
}

function DesktopSessions({
  snapshot,
  events,
  apiRequest,
  onRefreshSnapshot,
}: {
  snapshot: DesktopControlSnapshot;
  events: BridgeEvent[];
  apiRequest(request: LocalBridgeRequest): Promise<BridgeResponse>;
  onRefreshSnapshot(): Promise<void>;
  onReturnToDesktop?(sessionId: string): Promise<void>;
  onTakeoverDesktop?(sessionId: string, commandId?: string): Promise<void>;
}) {
  const openMedia = useMediaPreview();
  const [selectedId, setSelectedId] = useState(snapshot.sessions[0]?.sessionId);
  const [history, setHistory] = useState<Record<string, SessionHistoryState>>({});
  const [promptReplies, setPromptReplies] = useState<Record<string, Record<string, string | null>>>({});
  const [evidence, setEvidence] = useState<Record<string, SessionEvidenceState>>({});
  const [artifactPreviews, setArtifactPreviews] = useState<Record<string, BridgeArtifactPreview>>({});
  const [artifactTransfers, setArtifactTransfers] = useState<Record<string, number>>({});
  const [sessionView, setSessionView] = useState<"conversation" | "evidence">("conversation");
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<BridgeAttachment[]>([]);
  const [steer, setSteer] = useState(false);
  const [sending, setSending] = useState(false);
  const [stoppingSessionId, setStoppingSessionId] = useState<string>();
  const [stopError, setStopError] = useState<string>();
  const [createOpen, setCreateOpen] = useState(false);
  const [configurationOpen, setConfigurationOpen] = useState(false);
  const [rewindTarget, setRewindTarget] = useState<{ sessionId: string; messageId?: string }>();
  const [archivedExpanded, setArchivedExpanded] = useState(false);
  const [deleteSessionOpen, setDeleteSessionOpen] = useState(false);
  const [sessionActionBusy, setSessionActionBusy] = useState(false);
  const [sessionActionError, setSessionActionError] = useState<string>();
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<Set<string>>(() => new Set());
  const [expandedForkParents, setExpandedForkParents] = useState<Set<string>>(() => new Set());
  const handledCommandEvents = useRef(new Set<string>());
  useEffect(() => {
    for (const event of events) {
      if ((event.type !== "session.reset" && event.type !== "session.compacted" && event.type !== "session.rewound") || handledCommandEvents.current.has(event.eventId)) continue;
      handledCommandEvents.current.add(event.eventId);
      if (event.type === "session.reset" && event.data.previousSessionId === selectedId && typeof event.data.sessionId === "string") {
        const sessionId = event.data.sessionId;
        setHistory(current => ({ ...current, [sessionId]: { status: "ready", items: [], hasMore: false } }));
        setText(""); setAttachments([]); setSteer(false); setConfigurationOpen(false); setSelectedId(sessionId);
        void onRefreshSnapshot().then(() => openSession(sessionId)).catch(reason => setStopError(reason instanceof Error ? reason.message : "新会话打开失败"));
      } else if (event.type === "session.rewound" && event.sessionId) {
        const sessionId = event.sessionId;
        setHistory(current => ({ ...current, [sessionId]: { status: "loading", items: [], hasMore: false } }));
        if (sessionId === selectedId) void openSession(sessionId);
      } else if (event.type === "session.compacted" && event.sessionId === selectedId) {
        void openSession(selectedId!);
      }
    }
  }, [events]);
  const fileRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<HTMLDivElement>(null);
  const selected = snapshot.sessions.find((session) => session.sessionId === selectedId);
  const fileUploads = useFileAttachments(selected?.sessionId, (sessionId, file, onProgress, signal) =>
    uploadSessionFile(async (method, params) => apiRequest({ method, params }), sessionId, file, onProgress, signal));
  const selectedRuntime = selected ? desktopRuntimeId(selected) : "claude-desktop";
  const selectedRuntimeName = desktopRuntimeName(selectedRuntime);
  const [commandError, setCommandError] = useState<string>();
  const composerKey = JSON.stringify([snapshot.host.hostId, selectedId]);
  const composerKeyRef = useRef(composerKey);
  composerKeyRef.current = composerKey;
  useEffect(() => {
    setSending(false);
    setCommandError(undefined);
  }, [composerKey]);
  const commands = useSessionCommands({
    sessionId: selected?.sessionId,
    sessionKey: composerKey,
    enabled: selectedRuntime === "claude-desktop",
    supported: snapshot.host.capabilities.includes("session.command.v1"),
    onLoad: selected && selectedRuntime === "claude-desktop" && snapshot.host.capabilities.includes("session.commands.v1")
      ? async () => unwrap<{ catalog: BridgeSlashCommandCatalog }>(await apiRequest({ method: "session.commands", params: { sessionId: selected.sessionId } })).catalog
      : undefined,
    onRun: async value => {
      const result = unwrap<{ command: BridgeSessionCommandResult }>(await apiRequest({ method: "session.command", params: { sessionId: selected!.sessionId, text: value } })).command;
      if (result.session) await onRefreshSnapshot();
      return result;
    },
    onModel: () => setConfigurationOpen(true),
    onRewind: () => setRewindTarget({ sessionId: selected!.sessionId }),
    onSession: async sessionId => { setSelectedId(sessionId); await openSession(sessionId); },
  });
  const commandDraft = commands.recognizes(text.trim());
  const canAttachImages = selected
    ? snapshot.runtimes?.find((runtime) => runtime.id === selectedRuntime)?.capabilities.includes("attachment.image")
      ?? selectedRuntime === "claude-desktop"
    : false;
  const canConfigure = Boolean(selected && canConfigureSession(selected, snapshot));
  const rewindAvailable = selected?.transport === "claude-desktop-native" && snapshot.host.capabilities.includes("session.rewind.v1");
  const rewindDisabled = selected?.turnState === "running" || selected?.turnState === "waiting" || Boolean(selected?.pendingCount);
  const selectedEvidence = selectedId ? evidence[selectedId] : undefined;
  const bridgeRunning = selected?.turnState === "running" && (
    selected.ownership === "BRIDGE_RUNNING" ||
    selected.ownership === "DESKTOP_MANAGED_RUNNING" ||
    selected.ownership === "DESKTOP_NATIVE_RUNNING"
  );
  const stopTarget = stoppableBridgeTask(snapshot.sessions, selected?.sessionId);
  const canStop = Boolean(stopTarget);
  const stopping = stopTarget?.sessionId === stoppingSessionId;
  const stoppingBlocker = Boolean(stopTarget && stopTarget.sessionId !== selected?.sessionId);
  const items = useMemo(() => (
    selectedId ? conversationItems(selectedId, history[selectedId], events, [], false, promptReplies[selectedId]) : []
  ), [events, history, promptReplies, selectedId]);
  const fileChangesSummary = useMemo(() => aggregateFileChanges(items), [items]);
  const timeline = useMemo(
    () => conversationTimeline(items, selectedEvidence?.items ?? []),
    [items, selectedEvidence?.items],
  );
  const streamKeys = useMemo(() => timeline.map((entry) => (
    entry.kind === "evidence" ? `evidence:${entry.evidence.id}` : entry.item.id
  )), [timeline]);
  const streamEntering = useStreamEntrance(selectedId, streamKeys);
  const activity = useMemo(() => sessionActivity(selected, items), [selected, items]);
  const grouped = useMemo(() => {
    const activeParentProjects = new Map(
      snapshot.sessions.filter((candidate) => !candidate.archivedAt).map((candidate) => [candidate.sessionId, candidate.projectId]),
    );
    const map = new Map<string, BridgeSessionInfo[]>();
    for (const session of snapshot.sessions.filter((candidate) => (
      (!candidate.archivedAt || Boolean(candidate.sidechat && candidate.parentSessionId && activeParentProjects.get(candidate.parentSessionId) === candidate.projectId))

    ))) {
      const list = map.get(session.projectId) ?? [];
      list.push(session);
      map.set(session.projectId, list);
    }
    return [...map.entries()];
  }, [snapshot.sessions]);
  const visibilityAvailable = snapshot.host.capabilities.includes("session.visibility.v1");
  const archivedSessions = useMemo(() => snapshot.sessions.filter((candidate) => (
    Boolean(candidate.archivedAt)
  )), [snapshot.sessions]);
  const selectedBusy = Boolean(selected && (
    selected.turnState === "running" || selected.turnState === "queued" || selected.turnState === "waiting"
  ));
  const groupedProjectIds = useMemo(
    () => grouped.map(([groupProjectId]) => groupProjectId),
    [grouped],
  );
  const allProjectsCollapsed = groupedProjectIds.length > 0
    && groupedProjectIds.every((groupProjectId) => collapsedProjectIds.has(groupProjectId));
  const allProjectsExpanded = groupedProjectIds.length > 0
    && groupedProjectIds.every((groupProjectId) => !collapsedProjectIds.has(groupProjectId));
  const uncertainDeliveries = useMemo(() => {
    if (!selectedId) return [];
    const latest = new Map<string, BridgeEvent>();
    for (const event of events) {
      if (
        event.sessionId !== selectedId ||
        event.type !== "message.delivery" ||
        typeof event.data.commandId !== "string"
      ) continue;
      const previous = latest.get(event.data.commandId);
      if (!previous || event.seq > previous.seq) latest.set(event.data.commandId, event);
    }
    return [...latest.values()].filter((event) => event.data.delivery === "uncertain");
  }, [events, selectedId]);

  useEffect(() => {
    if (!selectedId) return;
    setSteer(false);
    setSessionView("conversation");
    setConfigurationOpen(false);
    setStopError(undefined);
    void openSession(selectedId);
  }, [selectedId]);

  useEffect(() => {
    const incoming = events.flatMap((event): BridgeEvidenceBundle[] => {
      if (!event.type.startsWith("evidence.")) return [];
      const item = event.data.evidence as Partial<BridgeEvidenceBundle> | undefined;
      if (
        !item ||
        typeof item.id !== "string" ||
        typeof item.sessionId !== "string" ||
        !Array.isArray(item.tools) ||
        !Array.isArray(item.artifacts)
      ) return [];
      return [evidenceSummary(item as BridgeEvidenceBundle)];
    });
    if (incoming.length === 0) return;
    setEvidence((current) => {
      const next = { ...current };
      for (const item of incoming) {
        const previous = next[item.sessionId] ?? { status: "ready", items: [], hasMore: false };
        const merged = new Map(previous.items.map((candidate) => [candidate.id, candidate]));
        merged.set(item.id, item);
        next[item.sessionId] = {
          ...previous,
          status: "ready",
          items: [...merged.values()].sort((left, right) => right.startedAt - left.startedAt),
        };
      }
      return next;
    });
  }, [events]);

  useEffect(() => {
    if (selectedId && snapshot.sessions.some((session) => session.sessionId === selectedId)) return;
    setSelectedId(snapshot.sessions[0]?.sessionId);
  }, [selectedId, snapshot.sessions]);

  const autoExpandedForkKeysRef = useRef(new Set<string>());
  useEffect(() => {
    const parentsToExpand: string[] = [];
    for (const session of snapshot.sessions) {
      if (!session.parentSessionId) continue;
      const isSelected = session.sessionId === selectedId;
      const isActive = session.turnState === "running" || session.turnState === "waiting" || session.turnState === "queued";
      const selectedKey = `selected:${session.sessionId}`;
      if (isSelected) {
        if (!autoExpandedForkKeysRef.current.has(selectedKey)) {
          autoExpandedForkKeysRef.current.add(selectedKey);
          parentsToExpand.push(...getSessionAncestorIds(snapshot.sessions, session.sessionId));
        }
      } else {
        autoExpandedForkKeysRef.current.delete(selectedKey);
      }
      const activeKey = `active:${session.sessionId}`;
      if (isActive) {
        if (!autoExpandedForkKeysRef.current.has(activeKey)) {
          autoExpandedForkKeysRef.current.add(activeKey);
          parentsToExpand.push(...getSessionAncestorIds(snapshot.sessions, session.sessionId));
        }
      } else {
        autoExpandedForkKeysRef.current.delete(activeKey);
      }
    }
    if (parentsToExpand.length > 0) {
      setExpandedForkParents((current) => {
        const next = new Set(current);
        for (const parentId of parentsToExpand) next.add(parentId);
        return next.size === current.size ? current : next;
      });
    }
  }, [selectedId, snapshot.sessions]);

  const streamScrollState = useRef<{ sessionId: string | undefined; count: number }>({
    sessionId: undefined,
    count: 0,
  });
  useEffect(() => {
    const stream = streamRef.current;
    if (!stream) return;
    const previous = streamScrollState.current;
    streamScrollState.current = { sessionId: selectedId, count: streamKeys.length };
    const jump = () => stream.scrollTo({ top: stream.scrollHeight });
    // Session switch or a bulk (re)load lands at the bottom instantly.
    if (previous.sessionId !== selectedId || streamKeys.length - previous.count > 6) {
      jump();
      return;
    }
    // Live appends and streaming text growth follow smoothly only while the
    // user is pinned to the bottom; scrolling up to read must never yank
    // the view back down.
    const pinnedToBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 120;
    if (!pinnedToBottom) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    stream.scrollTo({ top: stream.scrollHeight, behavior: reduced ? "auto" : "smooth" });
  }, [streamKeys, selectedId]);

  async function openSession(sessionId: string): Promise<void> {
    setHistory((current) => ({
      ...current,
      [sessionId]: {
        status: "loading",
        items: current[sessionId]?.items ?? [],
        hasMore: current[sessionId]?.hasMore ?? false,
      },
    }));
    setEvidence((current) => ({
      ...current,
      [sessionId]: {
        status: "loading",
        items: current[sessionId]?.items ?? [],
        hasMore: current[sessionId]?.hasMore ?? false,
      },
    }));
    try {
      const [result, evidenceResult] = await Promise.all([
        apiRequest({
          method: "session.open",
          params: { sessionId },
        }).then((response) => unwrap<{ history: BridgeHistoryPage }>(response)),
        apiRequest({
          method: "evidence.list",
          params: { sessionId, limit: 30 },
        }).then((response) => response.ok
          ? response.result as { evidence: BridgeEvidencePage }
          : undefined)
          .catch(() => undefined),
      ]);
      setHistory((current) => ({
        ...current,
        [sessionId]: {
          status: "ready",
          items: result.history.items,
          hasMore: result.history.hasMore,
          ...(result.history.nextCursor ? { nextCursor: result.history.nextCursor } : {}),
        },
      }));
      setEvidence((current) => {
        const merged = new Map(
          (current[sessionId]?.items ?? []).map((item) => [item.id, item]),
        );
        for (const item of evidenceResult?.evidence.items ?? []) merged.set(item.id, evidenceSummary(item));
        return {
          ...current,
          [sessionId]: {
            status: evidenceResult ? "ready" : merged.size > 0 ? "ready" : "error",
            items: [...merged.values()].sort((left, right) => right.startedAt - left.startedAt),
            hasMore: evidenceResult?.evidence.hasMore ?? false,
            ...(evidenceResult?.evidence.nextCursor
              ? { nextCursor: evidenceResult.evidence.nextCursor }
              : {}),
          },
        };
      });
    } catch {
      setHistory((current) => ({
        ...current,
        [sessionId]: { status: "error", items: current[sessionId]?.items ?? [], hasMore: false },
      }));
      setEvidence((current) => ({
        ...current,
        [sessionId]: {
          status: current[sessionId]?.items.length ? "ready" : "error",
          items: current[sessionId]?.items ?? [],
          hasMore: current[sessionId]?.hasMore ?? false,
        },
      }));
    }
  }

  async function loadOlderEvidence(): Promise<void> {
    if (!selectedId) return;
    const current = evidence[selectedId];
    if (!current?.nextCursor || current.status === "loading") return;
    setEvidence((value) => ({
      ...value,
      [selectedId]: { ...current, status: "loading" },
    }));
    try {
      const result = unwrap<{ evidence: BridgeEvidencePage }>(await apiRequest({
        method: "evidence.list",
        params: { sessionId: selectedId, cursor: current.nextCursor, limit: 30 },
      }));
      const merged = new Map(current.items.map((item) => [item.id, item]));
      for (const item of result.evidence.items) merged.set(item.id, evidenceSummary(item));
      setEvidence((value) => ({
        ...value,
        [selectedId]: {
          status: "ready",
          items: [...merged.values()].sort((left, right) => right.startedAt - left.startedAt),
          hasMore: result.evidence.hasMore,
          ...(result.evidence.nextCursor ? { nextCursor: result.evidence.nextCursor } : {}),
        },
      }));
    } catch {
      setEvidence((value) => ({
        ...value,
        [selectedId]: { ...current, status: "error" },
      }));
    }
  }

  async function loadEvidenceDetails(
    evidenceId: string, kind: "tools" | "artifacts", cursor?: string,
  ): Promise<BridgeEvidenceDetailPage> {
    if (snapshot.host.capabilities.includes("evidence.details.v1")) {
      return unwrap<{ page: BridgeEvidenceDetailPage }>(await apiRequest({
        method: "evidence.details",
        params: { evidenceId, kind, ...(cursor ? { cursor } : {}), limit: 30 },
      })).page;
    }
    const bundle = unwrap<{ evidence: BridgeEvidenceBundle }>(await apiRequest({
      method: "evidence.get", params: { evidenceId },
    })).evidence;
    const offset = cursor ? Number(cursor) : 0;
    const hasMore = offset + 30 < bundle[kind].length;
    const next = { evidenceId, hasMore, ...(hasMore ? { nextCursor: String(offset + 30) } : {}) };
    return kind === "tools"
      ? { ...next, kind, items: bundle.tools.slice(offset, offset + 30) }
      : { ...next, kind, items: bundle.artifacts.slice(offset, offset + 30) };
  }

  async function previewArtifact(artifactId: string): Promise<BridgeArtifactPreview> {
    const cached = artifactPreviews[artifactId];
    if (cached) return cached;
    const preview = unwrap<{ preview: BridgeArtifactPreview }>(await apiRequest({
      method: "artifact.preview",
      params: { artifactId },
    })).preview;
    setArtifactPreviews((current) => ({ ...current, [artifactId]: preview }));
    return preview;
  }

  async function downloadArtifact(artifact: BridgeArtifactManifest): Promise<void> {
    setArtifactTransfers((current) => ({ ...current, [artifact.id]: 0 }));
    try {
      await downloadBridgeArtifact(
        artifact,
        async (method, params) => apiRequest({ method, params }),
        (progress) => setArtifactTransfers((current) => ({
          ...current,
          [artifact.id]: progress,
        })),
      );
    } finally {
      setArtifactTransfers((current) => {
        const next = { ...current };
        delete next[artifact.id];
        return next;
      });
    }
  }

  async function send(): Promise<void> {
    if (!selected || !canSendSession(selected, snapshot) || sending || fileUploads.uploading
      || (!text.trim() && (!canAttachImages || attachments.length === 0) && fileUploads.files.length === 0)) return;
    const nextText = text.trim();
    const nextAttachments = canAttachImages ? attachments : [];
    const nextFiles = fileUploads.files;
    setText("");
    setAttachments([]);
    setSending(true);
    setCommandError(undefined);
    try {
      if (await commands.execute(nextText, attachments.length > 0 || nextFiles.length > 0)) {
        if (composerKeyRef.current === composerKey) setSteer(false);
        return;
      }
      unwrap(await apiRequest({
        method: steer ? "turn.steer" : "turn.start",
        params: {
          sessionId: selected.sessionId,
          text: appendUploadedFilePaths(nextText, nextFiles),
          attachments: nextAttachments,
        },
        idempotencyKey: crypto.randomUUID(),
      }));
      fileUploads.clear(nextFiles);
      if (composerKeyRef.current === composerKey) setSteer(false);
    } catch (error) {
      if (composerKeyRef.current !== composerKey) return;
      setCommandError(error instanceof Error ? error.message : "发送失败");
      setText(current => [nextText, current].filter(Boolean).join("\n"));
      setAttachments(current => [...nextAttachments, ...current]);
    } finally {
      if (composerKeyRef.current === composerKey) setSending(false);
    }
  }

  async function sendQuickReply(promptId: string, promptText: string): Promise<void> {
    if (!selected || !canSendSession(selected, snapshot) || sending || !promptText.trim()) return;
    setSending(true);
    try {
      const response = await apiRequest({
        method: steer ? "turn.steer" : "turn.start",
        params: {
          sessionId: selected.sessionId,
          text: promptText.trim(),
          attachments: [],
        },
        idempotencyKey: crypto.randomUUID(),
      });
      unwrap(response);
      setPromptReplies((current) => ({ ...current, [selected.sessionId]: { ...current[selected.sessionId], [promptId]: response.requestId } }));
      setSteer(false);
    } finally {
      setSending(false);
    }
  }

  async function refreshProviders(): Promise<void> {
    unwrap<{ providers: BridgeProviderProfile[] }>(await apiRequest({
      method: "provider.refresh",
      params: {},
    }));
    await onRefreshSnapshot();
  }

  async function stopCurrentTask(): Promise<void> {
    if (!stopTarget || stoppingSessionId) return;
    setStoppingSessionId(stopTarget.sessionId);
    setStopError(undefined);
    try {
      const result = unwrap<{ interrupted: boolean }>(await apiRequest({
        method: "turn.interrupt",
        params: { sessionId: stopTarget.sessionId, force: true },
      }));
      if (!result.interrupted) throw new Error("当前没有可停止的 Bridge 任务");
    } catch (error) {
      setStopError(error instanceof Error ? error.message : "任务停止失败");
    } finally {
      setStoppingSessionId(undefined);
    }
  }

  async function createSession(cwd: string, title?: string, runtimeId?: BridgeDesktopRuntimeId, projectId?: string): Promise<BridgeSessionInfo> {
    const result = unwrap<{ session: BridgeSessionInfo }>(await apiRequest({
      method: "session.create", params: { cwd, ...(title ? { title } : {}), ...(runtimeId ? { runtimeId } : {}), ...(projectId ? { projectId } : {}) },
    }));
    await onRefreshSnapshot();
    return result.session;
  }

  function toggleProject(projectId: string): void {
    setCollapsedProjectIds((current) => toggleCollapsedProject(current, projectId));
  }

  async function addImages(files: FileList | null): Promise<void> {
    if (!files?.length) return;
    const candidates = [...files].filter((file) => file.size <= 4 * 1024 * 1024);
    const next = await Promise.all(candidates.map(fileToAttachment));
    setAttachments((current) => [...current, ...next].slice(0, 4));
    if (fileRef.current) fileRef.current.value = "";
  }

  async function resolvePermission(
    requestId: string,
    decision: "allow-once" | "allow-always" | "deny",
    message?: string,
    updatedInput?: Record<string, unknown>,
    mode?: BridgeNativePermissionMode,
  ): Promise<void> {
    unwrap(await apiRequest({
      method: "permission.resolve",
      params: { requestId, decision, ...(message ? { message } : {}), ...(updatedInput ? { updatedInput } : {}), ...(mode ? { mode } : {}) },
    }));
  }

  async function loadConfiguration(): Promise<BridgeSessionConfiguration> {
    if (!selected) throw new Error("Session not found");
    return unwrap<{ configuration: BridgeSessionConfiguration }>(await apiRequest({
      method: "session.configuration",
      params: { sessionId: selected.sessionId },
    })).configuration;
  }

  async function saveConfiguration(change: SessionConfigurationChange): Promise<BridgeSessionConfiguration> {
    if (!selected) throw new Error("Session not found");
    return unwrap<{ configuration: BridgeSessionConfiguration }>(await apiRequest({
      method: "session.configure",
      params: { sessionId: selected.sessionId, ...change },
    })).configuration;
  }

  async function archiveSelected(archived: boolean): Promise<void> {
    if (!selected || sessionActionBusy) return;
    setSessionActionBusy(true);
    setSessionActionError(undefined);
    try {
      await apiRequest({
        method: "session.archive",
        params: { sessionId: selected.sessionId, archived },
      }).then(unwrap);
    } catch (failure) {
      setSessionActionError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSessionActionBusy(false);
    }
  }

  async function forkSelected(): Promise<void> {
    if (!selected || sessionActionBusy) return;
    setSessionActionBusy(true);
    setSessionActionError(undefined);
    try {
      const result = unwrap<{ session: BridgeSessionInfo }>(await apiRequest({
        method: "session.fork",
        params: { sessionId: selected.sessionId },
      }));
      setExpandedForkParents((current) => new Set([
        ...current,
        ...getSessionAncestorIds(snapshot.sessions, selected.sessionId),
        selected.sessionId,
      ]));
      await onRefreshSnapshot();
      setSelectedId(result.session.sessionId);
    } catch (failure) {
      setSessionActionError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSessionActionBusy(false);
    }
  }

  function toggleForkGroup(parentSessionId: string): void {
    setExpandedForkParents((current) => toggleCollapsedProject(current, parentSessionId));
  }

  async function deleteSelected(): Promise<void> {
    if (!selected || sessionActionBusy) return;
    setSessionActionBusy(true);
    setSessionActionError(undefined);
    try {
      await apiRequest({
        method: "session.delete",
        params: { sessionId: selected.sessionId },
      }).then(unwrap);
      setDeleteSessionOpen(false);
    } catch (failure) {
      setSessionActionError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSessionActionBusy(false);
    }
  }

  function renderDesktopSessionFamily(
    { primary: session, forks }: SessionFamily<BridgeSessionInfo>,
    isForkChild = false,
  ): ReactNode {
    const forksExpanded = expandedForkParents.has(session.sessionId);
    const badgeLabel = session.sidechat ? "/btw" : (session.forkLabel || "fork");
    const badgeClassName = `session-fork-badge${session.sidechat ? " is-sidechat" : ""}`;
    return (
      <div className="desktop-session-family" key={session.sessionId}>
        <button
          type="button"
          className={`desktop-session-row ${isForkChild ? "is-fork-child" : ""} ${session.sessionId === selectedId ? "active" : ""}`}
          onClick={() => setSelectedId(session.sessionId)}
        >
          <span className={`session-state-dot ${session.turnState}`} />
          <span>
            <strong>
              {isForkChild && <em className={badgeClassName}>{badgeLabel}</em>}
              {session.title}
              {!isForkChild && session.parentSessionId && (
                <em className={badgeClassName}>{badgeLabel}</em>
              )}
            </strong>
            <small>
              {!isForkChild && `${desktopRuntimeName(desktopRuntimeId(session))} · `}
              {session.archivedAt ? "已归档" : sessionState(session)}
            </small>
          </span>
          {session.pendingCount > 0 && <b>{session.pendingCount}</b>}
        </button>
        {forks.length > 0 && (
          <div className={`desktop-fork-group ${forksExpanded ? "expanded" : "collapsed"}`}>
            <button
              type="button"
              className="desktop-fork-toggle"
              aria-expanded={forksExpanded}
              onClick={() => toggleForkGroup(session.sessionId)}
            >
              <GitFork size={12} />
              <span>
                {forks.every((fork) => fork.primary.sidechat)
                  ? `${forks.length} 个 /btw 侧聊`
                  : forks.some((fork) => fork.primary.sidechat)
                    ? `${forks.length} 个分支与侧聊`
                    : `${forks.length} 个 Fork 分支`}
              </span>
              {forksExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>
            {forksExpanded && (
              <div className="desktop-fork-children">
                {forks.map((fork) => renderDesktopSessionFamily(fork, true))}
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <section className="desktop-session-layout">
      <aside className="desktop-session-sidebar">
        <div className="desktop-sidebar-heading">
          <div><span>Bridge 1.0</span><h1>会话</h1></div>
          <div className="desktop-sidebar-actions">
            <IconButton
              label="全部折叠"
              disabled={groupedProjectIds.length === 0 || allProjectsCollapsed}
              onClick={() => setCollapsedProjectIds(collapseProjects(groupedProjectIds))}
            >
              <ChevronsUp size={17} />
            </IconButton>
            <IconButton
              label="全部展开"
              disabled={groupedProjectIds.length === 0 || allProjectsExpanded}
              onClick={() => setCollapsedProjectIds(expandAllProjects())}
            >
              <ChevronsDown size={17} />
            </IconButton>
            <IconButton
              label="新建会话"
              onClick={() => {
                setCreateOpen(true);
              }}
            ><Plus size={18} /></IconButton>
          </div>
        </div>

        <div className="desktop-project-list">
          {grouped.map(([groupProjectId, sessions]) => {
            const expanded = !collapsedProjectIds.has(groupProjectId);
            const sessionsId = `desktop-project-${encodeURIComponent(groupProjectId)}`;
            const families = groupProjectSessionFamilies(sessions);
            return (
              <section className={expanded ? "expanded" : "collapsed"} key={groupProjectId}>
                <button
                  type="button"
                  className="desktop-project-toggle"
                  aria-expanded={expanded}
                  aria-controls={sessionsId}
                  onClick={() => toggleProject(groupProjectId)}
                >
                  {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  <strong>{snapshot.projects.find((project) => project.projectId === groupProjectId)?.name ?? sessions[0]!.projectName}</strong>
                  <span>{families.length}</span>
                </button>
                {expanded && (
                  <div className="desktop-project-sessions" id={sessionsId}>
                    {families.map((family) => renderDesktopSessionFamily(family))}
                  </div>
                )}
              </section>
            );
          })}
          {grouped.length === 0 && (
            <div className="desktop-sidebar-empty">等待发现 Desktop 会话</div>
          )}
          {visibilityAvailable && archivedSessions.length > 0 && (() => {
            const archivedFamilies = groupProjectSessionFamilies(archivedSessions);
            return (
              <section className={archivedExpanded ? "expanded" : "collapsed"}>
                <button
                  type="button"
                  className="desktop-project-toggle"
                  aria-expanded={archivedExpanded}
                  aria-controls="desktop-archived-sessions"
                  onClick={() => setArchivedExpanded((current) => !current)}
                >
                  {archivedExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  <strong>已归档</strong>
                  <span>{archivedFamilies.length}</span>
                </button>
                {archivedExpanded && (
                  <div className="desktop-project-sessions" id="desktop-archived-sessions">
                    {archivedFamilies.map((family) => renderDesktopSessionFamily(family))}
                  </div>
                )}
              </section>
            );
          })()}
        </div>
      </aside>

      <section className="desktop-conversation">
        {selected ? (
          <>
            <header className="desktop-conversation-heading">
              <div>
                <h2>{selected.title}</h2>
                <span>{selectedRuntimeName} · {selected.projectName} · {sessionState(selected)} · {transportLabel(selected)}</span>
              </div>
              <div className="desktop-conversation-heading-actions">

                {canConfigure && (
                  <button
                    type="button"
                    className="session-profile-trigger"
                    aria-label="会话设置"
                    onClick={() => setConfigurationOpen(true)}
                  >
                    <Settings2 size={15} />
                    <span>{sessionProfile(selected)}</span>
                  </button>
                )}

                {canStop && (
                  <IconButton
                    label={stopping ? "正在停止 Bridge 任务" : stoppingBlocker ? "停止阻塞的 Bridge 任务" : "停止当前 Bridge 任务"}
                    className="session-stop-button"
                    disabled={stopping}
                    onClick={() => void stopCurrentTask()}
                  >
                    {stopping ? <LoaderCircle className="is-spinning" size={17} /> : <CircleStop size={17} />}
                  </IconButton>
                )}
                {selectedRuntime === "claude-desktop" && (
                  <IconButton
                    label="Fork 分支会话"
                    disabled={sessionActionBusy}
                    onClick={() => void forkSelected()}
                  >
                    <GitFork size={16} />
                  </IconButton>
                )}
                {visibilityAvailable && (
                  <>
                    {selected.archivedAt ? (
                      <IconButton label="取消归档" disabled={sessionActionBusy} onClick={() => void archiveSelected(false)}>
                        <ArchiveRestore size={16} />
                      </IconButton>
                    ) : (
                      <IconButton label="归档会话" disabled={sessionActionBusy} onClick={() => void archiveSelected(true)}>
                        <Archive size={16} />
                      </IconButton>
                    )}
                    <IconButton
                      label={selectedBusy ? "任务进行中，先停止再删除" : "删除会话"}
                      disabled={sessionActionBusy || selectedBusy}
                      onClick={() => setDeleteSessionOpen(true)}
                    >
                      <Trash2 size={16} />
                    </IconButton>
                  </>
                )}
              </div>
            </header>
            {selected.archivedAt && (
              <div className="desktop-channel-banner">
                <Archive size={18} />
                <span><strong>此会话已归档</strong>会话保留全部历史，取消归档后回到会话列表。</span>
              </div>
            )}
            {sessionActionError && (
              <div className="desktop-channel-banner danger">
                <AlertTriangle size={18} />
                <span><strong>会话操作失败</strong>{sessionActionError}</span>
              </div>
            )}



            {(() => {
              const parentSession = selected.parentSessionId
                ? snapshot.sessions.find((candidate) => candidate.sessionId === selected.parentSessionId)
                : undefined;
              const childForks = snapshot.sessions.filter((candidate) => (
                candidate.parentSessionId === selected.sessionId && (!candidate.archivedAt || Boolean(candidate.sidechat))
              ));
              if (!parentSession && childForks.length === 0) return null;
              return (
                <div className="desktop-channel-banner relay-chain-bar fork-chain-bar">
                  {parentSession && (
                    <button
                      type="button"
                      className="relay-chain-link"
                      onClick={() => setSelectedId(parentSession.sessionId)}
                    >
                      <GitFork size={14} />
                      {`主会话：${parentSession.title}`}
                    </button>
                  )}
                  {childForks.map((fork) => (
                    <button
                      type="button"
                      className="relay-chain-link outbound"
                      key={fork.sessionId}
                      onClick={() => setSelectedId(fork.sessionId)}
                    >
                      <GitFork size={14} />
                      {`${fork.sidechat ? "/btw" : (fork.forkLabel || "fork")} · ${fork.title}`}
                    </button>
                  ))}
                </div>
              );
            })()}
            {stopError && (
              <div className="desktop-channel-banner danger">
                <AlertTriangle size={18} />
                <span><strong>任务停止失败</strong>{stopError}</span>
              </div>
            )}
            <nav className="session-view-switch desktop-session-view-switch" aria-label="会话视图">
              <button
                type="button"
                className={sessionView === "conversation" ? "active" : ""}
                onClick={() => setSessionView("conversation")}
              >
                对话
              </button>
              <button
                type="button"
                className={sessionView === "evidence" ? "active" : ""}
                onClick={() => setSessionView("evidence")}
              >
                成果
                {(selectedEvidence?.items.length ?? 0) > 0 && <b>{selectedEvidence!.items.length}</b>}
              </button>
            </nav>
            {sessionView === "conversation" ? (
            <div className="desktop-conversation-stream" ref={streamRef}>
              {history[selected.sessionId]?.status === "loading" && items.length === 0 && <div className="desktop-conversation-empty">正在读取会话</div>}
              {timeline.map((entry) => entry.kind === "evidence" ? (
                <EvidenceInlineSummary
                  evidence={entry.evidence}
                  key={`evidence:${entry.evidence.id}`}
                  entering={streamEntering(`evidence:${entry.evidence.id}`)}
                  onOpen={() => setSessionView("evidence")}
                />
              ) : entry.item.sessionNotice ? (
                <SessionNoticeCard
                  key={entry.item.id}
                  itemId={entry.item.id}
                  notice={entry.item.sessionNotice}
                  source={entry.item.text}
                  entering={streamEntering(entry.item.id)}
                />
              ) : entry.item.subagent ? (
                <SubagentCard
                  item={entry.item}
                  key={entry.item.id}
                  entering={streamEntering(entry.item.id)}
                />
              ) : (
                <article
                  className={`conversation-item ${entry.item.role}${streamEntering(entry.item.id) ? " is-entering" : ""}`}
                  key={entry.item.id}
                >
                  <div className="conversation-item-meta"><strong>{entry.item.role === "user" ? "你" : entry.item.role === "assistant" ? selectedRuntimeName : entry.item.toolName ?? "Bridge"}</strong></div>
                  {entry.item.text && (
                    entry.item.role === "assistant" || entry.item.role === "user" ? (
                      <MarkdownText text={entry.item.text} collapsible={!entry.item.live} onFileClick={(filePath) => {
                        const kind = mediaKind(filePath);
                        if (kind) openMedia({ name: filePath.split(/[\\/]/u).at(-1) || filePath, kind, sessionId: selected.sessionId, path: filePath });
                      }} />
                    ) : (
                      <div className="conversation-text">{entry.item.text}</div>
                    )
                  )}
                  {entry.item.interactivePrompt && (
                    <InteractivePromptCard
                      prompt={entry.item.interactivePrompt}
                      {...(entry.item.replyDelivery ? { replyDelivery: entry.item.replyDelivery } : {})}
                      {...(entry.item.replyPending ? { replyPending: true } : {})}
                      canSend={canSendSession(selected, snapshot)}
                      busy={sending}
                      onSelectOption={(replyText) => {
                        if (entry.item.interactivePrompt?.kind === "question") {
                          const pendingQuestion = matchingQuestionPermission(
                            entry.item.interactivePrompt,
                            snapshot.permissions.filter((permission) => permission.sessionId === selected.sessionId),
                          );
                          if (pendingQuestion) {
                            const questions = entry.item.interactivePrompt.questions ?? [];
                            if (questions.length === 1 && !questions[0]?.multiSelect) {
                              void resolvePermission(
                                pendingQuestion.requestId,
                                "allow-once",
                                undefined,
                                { ...pendingQuestion.input, answers: { [questions[0]!.question]: replyText } },
                              );
                            }
                            return;
                          }
                        }
                        void sendQuickReply(entry.item.id, replyText);
                      }}
                    />
                  )}
                  {entry.item.attachments?.length ? (
                    <div className="conversation-attachments">
                      {entry.item.attachments.map((attachment) => attachment.data ? (
                        <button type="button" className="conversation-image-preview" key={attachment.id} aria-label={`查看 ${attachment.name}`} onClick={() => openMedia({ name: attachment.name, kind: "image", dataUrl: `data:${attachment.mimeType};base64,${attachment.data}` })}><img src={`data:${attachment.mimeType};base64,${attachment.data}`} alt={attachment.name} loading="lazy" /></button>
                      ) : (
                        <span className="attachment-chip" key={attachment.id}>{attachment.name}</span>
                      ))}
                    </div>
                  ) : null}
                  {rewindAvailable && entry.item.role === "user" && !entry.item.id.startsWith("local:") && <div className="conversation-message-actions">
                    <button type="button" className="message-copy-button" aria-label="回退到这条消息之前" disabled={rewindDisabled}
                      onClick={() => setRewindTarget({ sessionId: selected.sessionId, messageId: entry.item.id })}>回退</button>
                  </div>}
                </article>
              ))}
              {snapshot.permissions
                .filter((permission) => permission.sessionId === selected.sessionId && (isClaudeNativeRelay(snapshot) && selected.transport === "claude-desktop-native"))
                .map((permission) => (
                  <PermissionPrompt
                    key={permission.requestId}
                    permission={permission}
                    onResolve={resolvePermission}
                    {...(permission.canSetNativeFullAccess ? {
                      onEnableNativeFullAccess: (requestId: string) => resolvePermission(requestId, "allow-once", undefined, undefined, "bypassPermissions"),
                    } : {})}
                  />
                ))}
              {uncertainDeliveries.map((event) => (
                <article className="conversation-item system uncertain-delivery" key={event.eventId}>
                  <div className="conversation-item-meta"><strong>发送结果待确认</strong></div>
                  <div className="conversation-text">{typeof event.data.error === "string" ? event.data.error : "Desktop 在确认消息前断开。"}</div>
                  <div className="uncertain-delivery-actions">
                    <button type="button" className="secondary-button" onClick={() => void apiRequest({
                      method: "message.delivery.resolve",
                      params: { commandId: event.data.commandId, action: "confirm" },
                    })}>确认已发送</button>
                    <button type="button" className="secondary-button" onClick={() => void apiRequest({
                      method: "message.delivery.resolve",
                      params: { commandId: event.data.commandId, action: "retry" },
                    })}>检查后重发</button>
                  </div>
                </article>
              ))}
            </div>
            ) : (
              <div className="desktop-evidence-view">
                <MediaGallery artifacts={mediaArtifacts(selectedEvidence?.items ?? [])} />
                {fileChangesSummary && (
                  <FileChangesCard
                    summary={fileChangesSummary}
                    onPreviewFile={(filePath) => {
                      const kind = mediaKind(filePath);
                      if (kind) openMedia({ name: filePath.split(/[\\/]/u).at(-1) || filePath, kind, sessionId: selected.sessionId, path: filePath });
                    }}
                  />
                )}
                <EvidencePanel
                  state={selectedEvidence}
                  previews={artifactPreviews}
                  transfers={artifactTransfers}
                  online
                  suppressEmpty={Boolean(fileChangesSummary)}
                  onLoadMore={loadOlderEvidence}
                  onLoadDetails={loadEvidenceDetails}
                  onPreview={previewArtifact}
                  onDownload={downloadArtifact}
                />
              </div>
            )}
            {sessionView === "conversation" && (
            <>
            <SessionActivityIndicator activity={activity} />
            <SessionContextUsageBar usage={selected.contextUsage} />
            <div className="desktop-composer">
              {commandError && <div className="composer-error" role="alert">{commandError}</div>}
              <FileAttachmentPicker state={fileUploads} />
              {attachments.length > 0 && (
                <div className="composer-attachments">
                  {attachments.map((attachment) => <span key={attachment.id}>{attachment.name}<button type="button" onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))}><X size={12} /></button></span>)}
                </div>
              )}
              {bridgeRunning && !commandDraft && canSendSession(selected, snapshot) && (selectedRuntime === "claude-desktop" ? selected.allowedActions?.canSteer === true : selected.allowedActions?.canSteer !== false) && (
                <div className="composer-mode">
                  <button type="button" className={!steer ? "active" : ""} onClick={() => setSteer(false)}>排到下一轮</button>
                  <button type="button" className={steer ? "active" : ""} onClick={() => setSteer(true)}>立即调整</button>
                </div>
              )}
              <form
                className="composer-form composer-form--with-attachment"
                onSubmit={(event) => { event.preventDefault(); void send(); }}
              >
                <input ref={fileRef} type="file" hidden multiple accept="image/jpeg,image/png,image/gif,image/webp" onChange={(event) => void addImages(event.target.files)} />
                <ComposerAttachmentMenu
                  canAttachImages={canAttachImages}
                  imageDisabled={commandDraft || !canSendSession(selected, snapshot)}
                  onPickImages={() => fileRef.current?.click()}
                  fileUploads={fileUploads}
                  fileDisabled={commandDraft || !canSendSession(selected, snapshot) || sending || snapshot.connection !== "connected"}
                />
                <SlashCommandInput
                  key={JSON.stringify([snapshot.host.hostId, selected.sessionId])}
                  {...(selectedRuntime === "claude-desktop" && snapshot.host.capabilities.includes("session.commands.v1") ? {
                    onLoad: commands.load!,
                  } : {})}
                  value={text}
                  onChange={setText}
                  disabled={!canSendSession(selected, snapshot)}
                  placeholder={selected.allowedActions?.reason ?? (
                    selected.source === "bridge"
                      ? "在这个 Bridge 会话中继续"
                      : `在这个 ${selectedRuntimeName} 会话中继续`
                  )}
                />
                <button type="submit" className="send-button" aria-label="发送" disabled={!canSendSession(selected, snapshot) || sending || fileUploads.uploading || (!text.trim() && (!canAttachImages || attachments.length === 0) && fileUploads.files.length === 0)}><Send size={18} /></button>
              </form>
            </div>
            </>
            )}
          </>
        ) : (
          <div className="desktop-conversation-empty"><MessageSquare size={24} /><span>从左侧选择会话</span></div>
        )}
      </section>

      {createOpen && (
        <SessionCreateDialog
          key={snapshot.host.hostId}
          snapshot={snapshot}
          connected
          {...(window.bridgeDesktop?.chooseDirectory ? { onChooseDirectory: (path?: string) => window.bridgeDesktop!.chooseDirectory!(path) } : {})}
          onCreate={createSession}
          onCreated={(created) => {
            setCollapsedProjectIds((current) => expandProject(current, created.projectId));
            setSelectedId(created.sessionId);
          }}
          onClose={() => setCreateOpen(false)}
        />
      )}
      {rewindAvailable && selected && rewindTarget?.sessionId === selected.sessionId && <SessionRewindDialog
        key={`${composerKey}:${rewindTarget.messageId ?? "latest"}`}
        messages={items}
        {...(rewindTarget.messageId ? { initialMessageId: rewindTarget.messageId } : {})}
        disabled={rewindDisabled}
        onPreview={async messageId => unwrap<{ rewind: BridgeSessionRewindPreview }>(await apiRequest({ method: "session.rewind.preview", params: { sessionId: selected.sessionId, messageId } })).rewind}
        onRewind={async (messageId, scope) => {
          const result = unwrap<{ rewind: BridgeSessionRewindResult }>(await apiRequest({ method: "session.rewind", params: { sessionId: selected.sessionId, messageId, scope } }));
          return result.rewind;
        }}
        onComplete={result => {
          if (result.scope !== "files") { setText(result.prefill ?? ""); setAttachments([]); setSteer(false); fileUploads.clear(fileUploads.files); }
          setRewindTarget(undefined);
        }}
        onClose={() => setRewindTarget(undefined)}
      />}
      {selected && <SessionCommandDialogs
        key={selected.sessionId}
        result={commands.dialog}
        session={selected}
        onClose={commands.close}
        onOpenSession={async sessionId => { setSelectedId(sessionId); await openSession(sessionId); }}
        onRename={async title => {
          unwrap(await apiRequest({ method: "session.command", params: { sessionId: selected.sessionId, text: `/rename ${title}` } }));
          await onRefreshSnapshot();
        }}
        onLoadPermissions={async () => unwrap<{ permissions: BridgeSessionPermissions }>(await apiRequest({ method: "session.permissions", params: { sessionId: selected.sessionId } })).permissions}
        onSavePermissions={async (mode, rules) => unwrap<{ permissions: BridgeSessionPermissions }>(await apiRequest({ method: "session.permissions.configure", params: { sessionId: selected.sessionId, mode, rules } })).permissions}
      />}
      {configurationOpen && selected && canConfigure && (
        <SessionConfigurationDialog
          session={selected}
          revision={events.filter((event) => ((event.type === "session.configuration" || event.type === "session.compacted") && event.sessionId === selected.sessionId) || (event.type === "permission.policy.changed" && (!event.sessionId || event.sessionId === selected.sessionId))).at(-1)?.seq ?? 0}
          onLoad={loadConfiguration}
          onSave={saveConfiguration}
          onClose={() => setConfigurationOpen(false)}
        />
      )}

      <ConfirmationDialog
        open={deleteSessionOpen && Boolean(selected)}
        title="删除会话"
        description={selected?.transport === "claude-desktop-native"
          ? `从 Claude Desktop 中删除「${selected.title}」会话及其对话记录？此操作不可恢复。`
          : `从 Bridge 列表中删除「${selected?.title ?? ""}」？对应 Desktop 应用中的原生会话与文件不受影响；Bridge 中的会话配置、排队与授权记录会被清除，此操作不可恢复。`}
        confirmLabel="删除会话"
        danger
        busy={sessionActionBusy}
        onCancel={() => setDeleteSessionOpen(false)}
        onConfirm={() => void deleteSelected()}
      />
    </section>
  );
}

function DesktopDevices({
  snapshot,
  onCreatePairing,
  onRevoke,
}: {
  snapshot: DesktopControlSnapshot;
  onCreatePairing(): Promise<void>;
  onRevoke(deviceId: string): Promise<void>;
}) {
  const [revokeCandidate, setRevokeCandidate] = useState<string>();
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");

  async function copyPairingLink(): Promise<void> {
    if (!snapshot.pairingUrl) return;
    try {
      await navigator.clipboard.writeText(snapshot.pairingUrl);
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 2_000);
    } catch {
      setCopyState("error");
    }
  }

  return (
    <section className="desktop-page">
      <header className="desktop-page-heading">
        <div><span>访问控制</span><h1>设备</h1></div>
        <button type="button" className="primary-button" onClick={() => void onCreatePairing()}><QrCode size={17} />添加手机</button>
      </header>
      {snapshot.pairingUrl && snapshot.pairingExpiresAt && (
        <section className="device-pairing-band">
          <div className="qr-wrap"><QRCodeSVG value={snapshot.pairingUrl} size={320} level="M" marginSize={4} title="手机配对二维码" /></div>
          <div>
            <span>一次性配对</span>
            <h2>使用手机 Bridge 扫描</h2>
            <p>二维码十分钟内有效，首次扫描后绑定到该手机安装。也可以复制配对链接，在手机端粘贴完成配对。</p>
            <div className="device-pairing-actions">
              <button type="button" className="secondary-button" onClick={() => void copyPairingLink()}>
                <Clipboard size={16} />
                {copyState === "copied" ? "已复制配对链接" : copyState === "error" ? "复制失败，请扫码" : "复制配对链接"}
              </button>
            </div>
            <small>{Math.max(0, Math.ceil((snapshot.pairingExpiresAt - Date.now()) / 60_000))} 分钟后过期</small>
          </div>
        </section>
      )}
      <div className="desktop-device-list">
        {snapshot.devices.filter((device) => !device.revokedAt).map((device) => (
          <article className="desktop-device-row" key={device.deviceId}>
            <span className="device-icon"><Smartphone size={20} /></span>
            <div><strong>{device.name}</strong><span>{device.platform.toUpperCase()} · {formatLastSeen(device.lastSeenAt, device.online)}</span></div>
            <span className={`device-online-state ${device.online ? "online" : ""}`}><i />{device.online ? "在线" : "已授权"}</span>
            <IconButton label={`撤销 ${device.name}`} onClick={() => setRevokeCandidate(device.deviceId)}><Trash2 size={17} /></IconButton>
          </article>
        ))}
        {snapshot.devices.filter((device) => !device.revokedAt).length === 0 && (
          <div className="desktop-page-empty"><Smartphone size={24} /><strong>还没有配对手机</strong><span>点击右上角生成十分钟有效的二维码。</span></div>
        )}
      </div>
      <ConfirmationDialog
        open={Boolean(revokeCandidate)}
        title="撤销这台手机？"
        description="撤销后旧密钥会立即失效，手机需要重新扫码才能连接。"
        confirmLabel="撤销权限"
        danger
        onCancel={() => setRevokeCandidate(undefined)}
        onConfirm={() => {
          if (!revokeCandidate) return;
          void onRevoke(revokeCandidate).finally(() => setRevokeCandidate(undefined));
        }}
      />
    </section>
  );
}

export function DesktopDashboard({ themeControl }: { themeControl: ThemeControl }) {
  const api = window.bridgeDesktop;
  const [snapshot, setSnapshot] = useState<DesktopControlSnapshot>();
  const [events, setEvents] = useState<BridgeEvent[]>([]);
  const [tab, setTab] = useState<DesktopTab>("sessions");
  const visibleSnapshot = useMemo(() => snapshot ? claudeSnapshot(snapshot) : undefined, [snapshot]);

  useEffect(() => {
    if (!api) return;
    void api.getSnapshot().then(setSnapshot);
    const stopSnapshots = api.onSnapshot(setSnapshot);
    const stopEvents = api.onEvent((event) => {
      setEvents((current) => [...current.filter((candidate) => candidate.eventId !== event.eventId), summarizeEvidenceEvent(event)]
        .sort((left, right) => left.seq - right.seq)
        .slice(-2_000));
    });
    return () => {
      stopSnapshots();
      stopEvents();
    };
  }, [api]);

  const loadMagpieQuota = useMemo(() => async (options?: { refresh?: boolean }): Promise<QuotaSnapshot> => {
    return unwrap<QuotaSnapshot>(await api!.request({ method: MAGPIE_QUOTA_METHOD, params: { refresh: options?.refresh ?? false } }));
  }, [api]);

  if (!api || !snapshot) return <div className="desktop-loading"><BrandMark /><span>正在准备会话主机</span></div>;

  async function request(input: LocalBridgeRequest): Promise<BridgeResponse> {
    return api!.request(input);
  }

  return (
    <MediaPreviewProvider request={(method, params) => request({ method, params })} supportsFileStat={snapshot.host.capabilities.includes("artifact.transfer.stat.v1")}>
    <MagpieQuotaProvider loader={loadMagpieQuota} enabled={snapshot.host.capabilities.includes("plugin.magpie-quota.v1")} sourceKey={snapshot.runtime.detection?.refreshedAt ?? 0}>
    <main className="desktop-shell-v2">
      <aside className="desktop-nav-v2">
        <BrandMark compact />
        <nav aria-label="Bridge 主导航">
          <button className={tab === "sessions" ? "active" : ""} type="button" onClick={() => setTab("sessions")}><MessageSquare size={19} /><span>会话</span></button>
          <button className={tab === "devices" ? "active" : ""} type="button" onClick={() => setTab("devices")}><Smartphone size={19} /><span>设备</span></button>
          <button className={tab === "settings" ? "active" : ""} type="button" onClick={() => setTab("settings")}><Settings2 size={19} /><span>设置</span></button>
        </nav>
        <div className="desktop-host-chip">
          <Laptop size={17} />
          <span><strong>{snapshot.host.name}</strong><small>{connectionLabel(snapshot)}</small></span>
        </div>
        <ThemeMenu control={themeControl} side="right" iconSize={18} />
      </aside>
      <section className="desktop-content-v2">
        {snapshot.claudeInspector?.state === "error" && <div role="alert" className="inspector-warning"><AlertTriangle size={18} /><span>Claude 调试连接监测不可用：{snapshot.claudeInspector.error}</span></div>}
        {snapshot.claudeInspector?.clients.some((client) => !client.approved) && <div role="alert" className="inspector-warning">
          <AlertTriangle size={18} /><div><strong>Claude 调试接口存在未认可的进程连接</strong>{snapshot.claudeInspector.clients.filter((client) => !client.approved).map((client) => <p key={client.pid}>PID {client.pid} · {client.name} · {client.executablePath ?? client.pathError ?? "路径未知"}</p>)}</div>
        </div>}
        {tab === "sessions" && (
          <DesktopSessions
            snapshot={visibleSnapshot!}
            events={events}
            apiRequest={request}
            onRefreshSnapshot={async () => {
              setSnapshot(await api.getSnapshot());
            }}

          />
        )}
        {tab === "devices" && (
          <DesktopDevices
            snapshot={snapshot}
            onCreatePairing={async () => setSnapshot(await api.createPairing())}
            onRevoke={async (deviceId) => setSnapshot(await api.revokeDevice(deviceId))}
          />
        )}
        {tab === "settings" && (
          <DesktopSettings snapshot={snapshot} api={api} onSnapshot={setSnapshot} themeControl={themeControl} />
        )}
      </section>
      <DiagnosticFloatingEntry desktopSnapshot={snapshot} />
    </main>
    </MagpieQuotaProvider>
    </MediaPreviewProvider>
  );
}
