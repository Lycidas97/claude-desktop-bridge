import { isClaudeNativeRelay } from "../../hooks/useMobileBridge.js";
import { HISTORY_PAGE_SIZE, mergeHistoryPages } from "../../hooks/bridge/bridge-reducers.js";
import type {
  BridgeAttachment,
  BridgeArtifactManifest,
  BridgeArtifactPreview,
  BridgeBackgroundTask,
  BridgeEvidenceBundle,
  BridgeEvidenceDetailPage,
  BridgeEvidencePage,
  BridgeEvent,
  BridgeHistoryItem,
  BridgeHistoryPage,
  BridgeDesktopRuntimeId,
  BridgeNativePermissionMode,
  BridgePrAutoFixState,
  BridgePrAutoFixUpdate,
  BridgePullRequest,
  BridgeResponse,
  BridgeSessionCommandResult,
  BridgeSessionRewindPreview,
  BridgeSessionRewindResult,
  BridgeSessionPermissions,
  BridgeSessionConfiguration,
  BridgeSessionInfo,
  BridgeSlashCommandCatalog,
  DesktopControlSnapshot,
  LocalBridgeRequest,
} from "@bridge/protocol";
import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  ArrowDownUp,
  ChevronDown,
  ChevronRight,
  ChevronsDown,
  ChevronsUp,
  CircleStop,
  GitFork,
  GitPullRequest,
  Layers,
  LoaderCircle,
  MessageSquare,
  Plus,
  Send,
  Settings2,
  Trash2,
  X,
} from "lucide-react";
import { evidenceSummary } from "@bridge/protocol";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { SessionEvidenceState, SessionHistoryState } from "../../hooks/useMobileBridge.js";
import { downloadBridgeArtifact, downloadBridgeSessionFile } from "../../lib/artifact-download.js";
import { useStreamEntrance } from "../../lib/stream-entrance.js";
import {
  collapseProjects,
  expandAllProjects,
  expandProject,
  getSessionAncestorIds,
  groupProjectSessionFamilies,
  orderProjects,
  toggleCollapsedProject,
} from "../../lib/project-groups.js";
import { ConfirmationDialog } from "../common/ConfirmationDialog.js";
import { EvidenceInlineSummary, EvidencePanel } from "../evidence/EvidencePanel.js";
import { FileChangesCard } from "../evidence/FileChangesCard.js";
import { ComposerAttachmentMenu, FileAttachmentPicker, useFileAttachments } from "../evidence/FileAttachmentPicker.js";
import { appendUploadedFilePaths, uploadSessionFile } from "../../lib/file-upload.js";
import { MediaGallery } from "../evidence/MediaGallery.js";
import { useMediaPreview } from "../evidence/MediaPreviewProvider.js";
import { mediaArtifacts, mediaKind } from "../../lib/media-preview.js";
import { IconButton } from "../common/IconButton.js";
import {
  aggregateFileChanges,
  canConfigureSession,
  canSendSession,
  conversationItems,
  conversationTimeline,
  fileToAttachment,
  groupTimelineTools,
  ownershipLabel,
  stoppableBridgeTask,
  type ConversationItem,
} from "../../lib/conversation-timeline.js";
import { desktopRuntimeId, desktopRuntimeName } from "../../lib/runtime-labels.js";
import { EmptyState } from "../common/EmptyState.js";
import { ProjectOrderSheet } from "../mobile/ProjectOrderSheet.js";
import { ProjectGroupHeader } from "../session/ProjectGroupHeader.js";
import { SessionFamilyList } from "../session/SessionFamilyList.js";
import { SessionProfileSummary } from "../session/SessionProfileSummary.js";
import { BackgroundTaskMarker, BackgroundTasksSheet, findBackgroundTask } from "../conversation/BackgroundTasks.js";
import { ConversationMessageItem, type QueuedTurnActionState } from "../conversation/ConversationMessageItem.js";
import { ConversationToolGroup } from "../conversation/ConversationToolGroup.js";
import { ForkChainBar } from "../conversation/ForkChainBar.js";
import {
  InteractivePromptCard,
  matchingQuestionPermission,
  PermissionPrompt,
} from "../conversation/PermissionPrompts.js";
import { SubagentCard } from "../conversation/SubagentCard.js";
import { NativePromptCard } from "../conversation/NativePromptCard.js";
import { SessionPrActions, SessionPrBar } from "../conversation/SessionPrBar.js";
import { Sheet } from "../common/Sheet.js";
import { SessionActivityIndicator, SessionContextUsageBar } from "../conversation/SessionActivityIndicator.js";
import { SlashCommandInput } from "../conversation/SlashCommandInput.js";
import { sessionCommandName, useSessionCommands } from "../../hooks/useSessionCommands.js";
import { SessionCommandDialogs } from "../conversation/SessionCommandDialogs.js";
import { SessionRewindDialog } from "../conversation/SessionRewindDialog.js";
import { SessionNoticeCard } from "../conversation/SessionNoticeCard.js";
import { sessionActivity } from "../../lib/session-activity.js";
import {
  SessionConfigurationDialog,
  type SessionConfigurationChange,
} from "../session/SessionConfigurationDialog.js";
import { SessionCreateDialog } from "../session/SessionCreateDialog.js";
import { useAssistantMail } from "../assistant/AssistantMailProvider.js";
import { MailReference } from "../assistant/MailReference.js";
import { MailCard } from "../assistant/MailCard.js";

export function unwrap<T>(response: BridgeResponse): T {
  if (!response.ok) {
    throw Object.assign(
      new Error(response.error?.message ?? "Bridge 请求失败"),
      response.error?.code ? { code: response.error.code } : {},
    );
  }
  return response.result as T;
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

export function DesktopSessions({
  snapshot,
  events,
  apiRequest,
  onRefreshSnapshot,
  initialSessionId,
  fixedSessionId,
  onOpenOtherSession,
}: {
  initialSessionId?: string | undefined;
  fixedSessionId?: string | undefined;
  onOpenOtherSession?(sessionId: string): void;
  snapshot: DesktopControlSnapshot;
  events: BridgeEvent[];
  apiRequest(request: LocalBridgeRequest): Promise<BridgeResponse>;
  onRefreshSnapshot(): Promise<void>;
}) {
  const openMedia = useMediaPreview();
  const [pickedId, setPickedId] = useState(initialSessionId ?? snapshot.sessions[0]?.sessionId);
  const selectedId = fixedSessionId ?? pickedId;
  function setSelectedId(sessionId: string | undefined): void {
    if (fixedSessionId) {
      if (sessionId && sessionId !== fixedSessionId) onOpenOtherSession?.(sessionId);
    } else setPickedId(sessionId);
  }
  const [history, setHistory] = useState<Record<string, SessionHistoryState>>({});
  const historyRef = useRef(history);
  historyRef.current = history;
  const loadingHistoryRef = useRef(new Set<string>());
  const [promptReplies, setPromptReplies] = useState<Record<string, Record<string, string | null>>>({});
  const [promptErrors, setPromptErrors] = useState<Record<string, string>>({});
  const [queuedSteers, setQueuedSteers] = useState<Record<string, QueuedTurnActionState>>({});
  const [evidence, setEvidence] = useState<Record<string, SessionEvidenceState>>({});
  const [artifactPreviews, setArtifactPreviews] = useState<Record<string, BridgeArtifactPreview>>({});
  const [artifactTransfers, setArtifactTransfers] = useState<Record<string, number>>({});
  const [sessionView, setSessionView] = useState<"conversation" | "evidence">("conversation");
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<BridgeAttachment[]>([]);
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
  const [projectOrderOpen, setProjectOrderOpen] = useState(false);
  const [prActionsOpen, setPrActionsOpen] = useState(false);
  const [backgroundTasksOpen, setBackgroundTasksOpen] = useState<{ focus?: BridgeHistoryItem }>();
  const [backgroundTaskDetails, setBackgroundTaskDetails] = useState<{ key: string; tasks: BridgeBackgroundTask[] | undefined; error?: string }>();
  const [stopSubagentTarget, setStopSubagentTarget] = useState<{ sessionId: string; agentId: string; description: string; scope: "task" | "process" }>();
  const [subagentStopBusy, setSubagentStopBusy] = useState(false);
  const [pendingFileDownload, setPendingFileDownload] = useState<string>();
  const [fileDownloadBusy, setFileDownloadBusy] = useState(false);
  const [fileDownloadError, setFileDownloadError] = useState<string>();
  const projectOrderKey = `bridge-project-order:${snapshot.host.hostId}`;
  const [placedProjects, setPlacedProjects] = useState<string[]>(() => (
    JSON.parse(localStorage.getItem(projectOrderKey) ?? "[]") as string[]
  ));
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<Set<string>>(() => new Set());
  const [expandedForkParents, setExpandedForkParents] = useState<Set<string>>(() => new Set());
  const handledCommandEvents = useRef(new Set<string>());
  useEffect(() => {
    for (const event of events) {
      if ((event.type !== "session.reset" && event.type !== "session.compacted" && event.type !== "session.rewound") || handledCommandEvents.current.has(event.eventId)) continue;
      handledCommandEvents.current.add(event.eventId);
      if (!fixedSessionId && event.type === "session.reset" && event.data.previousSessionId === selectedId && typeof event.data.sessionId === "string") {
        const sessionId = event.data.sessionId;
        setHistory(current => ({ ...current, [sessionId]: { status: "ready", items: [], hasMore: false } }));
        setText(""); setAttachments([]); setConfigurationOpen(false); setSelectedId(sessionId);
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
  function openSessionFile(filePath: string): void {
    const kind = mediaKind(filePath);
    if (kind && selected) {
      openMedia({ name: filePath.split(/[\\/]/u).at(-1) || filePath, kind, sessionId: selected.sessionId, path: filePath });
      return;
    }
    setFileDownloadError(undefined);
    setPendingFileDownload(filePath);
  }
  const otherNativePromptSession = snapshot.sessions.find(session => session.sessionId !== selectedId && snapshot.prompts?.some(prompt => prompt.sessionId === session.sessionId));
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
    setBackgroundTasksOpen(undefined);
    setStopSubagentTarget(undefined);
    setPendingFileDownload(undefined);
    setFileDownloadError(undefined);
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
  const nativeOnline = snapshot.runtime.desktopIntegration.state !== "disconnected";
  const selectedHistory = selectedId ? history[selectedId] : undefined;
  const taskHistoryReady = selectedHistory?.status === "ready" || Boolean(selectedHistory?.items.length);
  const canLoadBackgroundTasks = snapshot.host.capabilities.includes("claude.native-relay.v1");
  useEffect(() => {
    if (
      !canLoadBackgroundTasks
      || sessionView !== "conversation"
      || snapshot.runtime.desktopIntegration.state !== "ready"
      || !selected
      || selectedRuntime !== "claude-desktop"
      || !taskHistoryReady
    ) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const result = unwrap<{ session?: BridgeSessionInfo }>(await apiRequest({
          method: "session.configuration",
          params: { sessionId: selected.sessionId, includeBackgroundTasks: true },
        }));
        if (active) setBackgroundTaskDetails({ key: composerKey, tasks: result.session?.backgroundTasks ?? [] });
      } catch (error) {
        if (active) setBackgroundTaskDetails((current) => ({
          key: composerKey,
          tasks: current?.key === composerKey ? current.tasks : undefined,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
      if (active) timer = setTimeout(() => void refresh(), 2_000);
    };
    void refresh();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [canLoadBackgroundTasks, composerKey, selected?.sessionId, selectedRuntime, sessionView, snapshot.runtime.desktopIntegration.state, taskHistoryReady]);
  const assistantMail = useAssistantMail();
  const selectedEvidence = selectedId ? evidence[selectedId] : undefined;
  const stopTarget = stoppableBridgeTask(snapshot.sessions, selected?.sessionId);
  const canStop = Boolean(stopTarget);
  const stopping = stopTarget?.sessionId === stoppingSessionId;
  const stoppingBlocker = Boolean(stopTarget && stopTarget.sessionId !== selected?.sessionId);
  const items = useMemo(() => (
    selectedId ? conversationItems(selectedId, selectedHistory, events, [], true, promptReplies[selectedId]) : []
  ), [events, promptReplies, selectedHistory, selectedId]);
  const fileChangesSummary = useMemo(() => aggregateFileChanges(items), [items]);
  const timeline = useMemo(
    () => conversationTimeline(items, selectedEvidence?.items ?? [], selectedId ? assistantMail?.cache.cards.filter(card => (card.nativeDelivery.nativeSessionId ?? snapshot.assistantMail?.binding?.nativeSessionId) === selectedId) ?? [] : []),
    [items, selectedEvidence?.items, assistantMail?.cache.cards, snapshot.assistantMail?.binding?.nativeSessionId, selectedId],
  );
  const displayNodes = useMemo(() => groupTimelineTools(timeline), [timeline]);
  const toolGroupKeysRef = useRef<{ sessionId?: string | undefined; byToolId: Map<string, string> }>({ byToolId: new Map() });
  const toolGroupKeys = useMemo(() => {
    if (toolGroupKeysRef.current.sessionId !== selectedId || displayNodes.length === 0) {
      toolGroupKeysRef.current = { sessionId: selectedId, byToolId: new Map() };
    }
    const { byToolId } = toolGroupKeysRef.current;
    const keys = new Map<string, string>();
    for (const node of displayNodes) {
      if (node.kind !== "tool-group") continue;
      const stableKey = node.tools.map((tool) => byToolId.get(tool.id)).find(Boolean) ?? node.id;
      for (const tool of node.tools) byToolId.set(tool.id, stableKey);
      keys.set(node.id, stableKey);
    }
    return keys;
  }, [displayNodes, selectedId]);
  const timelineStreamKeys = useMemo(() => timeline.map((entry) => (
    entry.kind === "evidence" ? `evidence:${entry.evidence.id}` : entry.kind === "mail" ? `mail:${entry.card.mailRefId}` : entry.item.id
  )), [timeline]);
  const streamEntering = useStreamEntrance(selectedId, timelineStreamKeys);
  const selectedTaskDetails = backgroundTaskDetails?.key === composerKey ? backgroundTaskDetails : undefined;
  const activityTasks = selectedTaskDetails?.tasks ?? selected?.backgroundTasks;
  const activity = useMemo(() => sessionActivity(
    selected,
    selectedTaskDetails?.error ? items.map((item) => {
      const subagent = item.subagent;
      if (subagent?.state !== "running") return item;
      const task = findBackgroundTask(activityTasks, subagent);
      return task && task.state !== "running"
        && (!subagent.workflowRunId || task.workflow?.agents.some((agent) => agent.agentId === subagent.agentId))
        ? { ...item, subagent: { ...subagent, state: task.state } }
        : item;
    }) : items,
    selectedTaskDetails?.error ? undefined : activityTasks,
  ), [selected, items, activityTasks, selectedTaskDetails?.error]);
  const projectsByActivity = useMemo(() => {
    const latest = new Map<string, number>();
    for (const session of snapshot.sessions) {
      if (!session.archivedAt) latest.set(session.projectId, Math.max(latest.get(session.projectId) ?? 0, session.lastActivityAt));
    }
    return [...latest.keys()].sort((left, right) => latest.get(right)! - latest.get(left)!);
  }, [snapshot.sessions]);
  const projectOrder = useMemo(() => orderProjects(projectsByActivity, placedProjects), [placedProjects, projectsByActivity]);
  useEffect(() => {
    const unplaced = projectOrder.filter(projectId => !placedProjects.includes(projectId));
    if (unplaced.length) placeProjects([...unplaced, ...placedProjects]);
  }, [placedProjects, projectOrder]);
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
    return projectOrder.filter(projectId => map.has(projectId)).map(projectId => [projectId, map.get(projectId)!] as const);
  }, [projectOrder, snapshot.sessions]);
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
  const orphanUncertainDeliveries = useMemo(() => uncertainDeliveries.filter((event) => (
    !items.some((item) => item.delivery === "uncertain" && item.commandId && item.commandId === event.data.commandId)
  )), [items, uncertainDeliveries]);
  const sessionPermissions = useMemo(() => (
    selected && isClaudeNativeRelay(snapshot) && selected.transport === "claude-desktop-native"
      ? snapshot.permissions.filter((permission) => permission.sessionId === selected.sessionId)
      : []
  ), [selected, snapshot]);
  const sessionNativePrompts = useMemo(() => (
    selected ? snapshot.prompts?.filter((prompt) => prompt.sessionId === selected.sessionId) ?? [] : []
  ), [selected, snapshot.prompts]);
  const streamKeys = useMemo(() => [
    ...timelineStreamKeys,
    ...sessionPermissions.map((permission) => `permission:${permission.requestId}`),
    ...sessionNativePrompts.map((prompt) => `prompt:${prompt.promptId}`),
    ...orphanUncertainDeliveries.map((event) => `uncertain:${event.eventId}`),
  ], [orphanUncertainDeliveries, sessionNativePrompts, sessionPermissions, timelineStreamKeys]);

  useEffect(() => {
    if (!selectedId) return;
    setSessionView("conversation");
    setConfigurationOpen(false);
    setPrActionsOpen(false);
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
    if (fixedSessionId || (selectedId && snapshot.sessions.some((session) => session.sessionId === selectedId))) return;
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

  const firstHistoryKey = selectedHistory?.items[0]?.id;
  const historyCount = selectedHistory?.items.length ?? 0;
  const streamScrollState = useRef<{
    sessionId?: string | undefined;
    firstKey?: string | undefined;
    firstHistoryKey?: string | undefined;
    historyCount: number;
    lastKey?: string | undefined;
    anchorKey?: string | undefined;
    anchorOffset: number;
    scrollTop?: number | undefined;
    pinnedToBottom: boolean;
  }>({ historyCount: 0, anchorOffset: 0, pinnedToBottom: true });

  function rememberStreamPosition(updateFollow = false): void {
    const stream = streamRef.current;
    if (!stream) return;
    const top = stream.getBoundingClientRect().top;
    const anchor = [...stream.querySelectorAll<HTMLElement>(":scope > [data-stream-key]")]
      .find((element) => element.getBoundingClientRect().bottom > top);
    streamScrollState.current = {
      ...streamScrollState.current,
      anchorKey: anchor?.dataset.streamKey,
      anchorOffset: anchor ? anchor.getBoundingClientRect().top - top : 0,
      scrollTop: stream.scrollTop,
      pinnedToBottom: updateFollow
        ? stream.scrollHeight - stream.scrollTop - stream.clientHeight <= 4
        : streamScrollState.current.pinnedToBottom,
    };
  }

  useLayoutEffect(() => {
    const stream = streamRef.current;
    if (!stream || !selectedId) {
      streamScrollState.current = { historyCount: 0, anchorOffset: 0, pinnedToBottom: true };
      return;
    }
    const previous = streamScrollState.current;
    const firstKey = timelineStreamKeys[0];
    const lastKey = streamKeys.at(-1);
    const entering = previous.sessionId !== selectedId || !previous.lastKey;
    const historyPrepended = (
      firstHistoryKey !== undefined
      && previous.firstHistoryKey !== undefined
      && firstHistoryKey !== previous.firstHistoryKey
      && historyCount > previous.historyCount
    );
    if (entering) {
      stream.scrollTop = stream.scrollHeight;
    } else if ((firstKey !== previous.firstKey || historyPrepended) && previous.anchorKey) {
      const anchor = [...stream.querySelectorAll<HTMLElement>(":scope > [data-stream-key]")]
        .find((element) => element.dataset.streamKey === previous.anchorKey);
      if (anchor) {
        stream.scrollTop += anchor.getBoundingClientRect().top - stream.getBoundingClientRect().top - previous.anchorOffset;
      } else if (previous.pinnedToBottom) {
        stream.scrollTop = stream.scrollHeight;
      }
    } else if (previous.pinnedToBottom) {
      stream.scrollTop = stream.scrollHeight;
    }
    streamScrollState.current = {
      ...previous,
      sessionId: selectedId,
      firstKey,
      firstHistoryKey,
      historyCount,
      lastKey,
      pinnedToBottom: entering || previous.pinnedToBottom,
    };
    rememberStreamPosition();
  }, [firstHistoryKey, historyCount, streamKeys, timelineStreamKeys, selectedId, sessionView]);

  function loadOlderNearTop(): void {
    const stream = streamRef.current;
    if (!stream || !selectedId || !selectedHistory?.hasMore || !selectedHistory.nextCursor || selectedHistory.status !== "ready" || selectedHistory.error) return;
    if (stream.scrollTop < 200) void loadOlderHistory(selectedId);
  }

  useEffect(() => {
    if (sessionView === "conversation") loadOlderNearTop();
  }, [firstHistoryKey, timelineStreamKeys[0], selectedHistory?.nextCursor, selectedId, sessionView]);

  async function openSession(sessionId: string): Promise<void> {
    loadingHistoryRef.current.delete(sessionId);
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
          params: { sessionId, limit: HISTORY_PAGE_SIZE },
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
    } catch (failure) {
      setHistory((current) => ({
        ...current,
        [sessionId]: {
          status: "error",
          items: current[sessionId]?.items ?? [],
          hasMore: false,
          error: failure instanceof Error ? failure.message : "会话读取失败",
        },
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

  async function loadOlderHistory(sessionId: string): Promise<void> {
    const current = historyRef.current[sessionId];
    if (!current?.hasMore || !current.nextCursor || current.status === "loading" || loadingHistoryRef.current.has(sessionId)) return;
    const requestedCursor = current.nextCursor;
    loadingHistoryRef.current.add(sessionId);
    setHistory((value) => ({
      ...value,
      [sessionId]: { ...current, status: "loading" },
    }));
    try {
      const result = unwrap<{ history: BridgeHistoryPage }>(await apiRequest({
        method: "session.history",
        params: { sessionId, cursor: requestedCursor, limit: HISTORY_PAGE_SIZE },
      }));
      setHistory((value) => {
        const existingItems = value[sessionId]?.items ?? current.items;
        return {
          ...value,
          [sessionId]: {
            status: "ready",
            items: mergeHistoryPages(result.history.items, existingItems),
            hasMore: result.history.hasMore,
            ...(result.history.nextCursor ? { nextCursor: result.history.nextCursor } : {}),
          },
        };
      });
    } catch (failure) {
      setHistory((value) => ({
        ...value,
        [sessionId]: {
          ...(value[sessionId] ?? current),
          status: "ready",
          error: failure instanceof Error ? failure.message : "历史加载失败",
        },
      }));
    } finally {
      loadingHistoryRef.current.delete(sessionId);
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

  async function downloadSessionFile(sessionId: string, filePath: string): Promise<void> {
    const transferKey = `file:${filePath}`;
    setArtifactTransfers((current) => ({ ...current, [transferKey]: 0 }));
    try {
      await downloadBridgeSessionFile(
        sessionId,
        filePath,
        async (method, params) => apiRequest({ method, params }),
        (progress) => setArtifactTransfers((current) => ({
          ...current,
          [transferKey]: progress,
        })),
      );
    } finally {
      setArtifactTransfers((current) => {
        const next = { ...current };
        delete next[transferKey];
        return next;
      });
    }
  }

  async function steerQueuedTurn(sessionId: string, commandId: string): Promise<void> {
    const result = unwrap<{ state?: string }>(await apiRequest({
      method: "turn.queue.steer",
      params: { sessionId, commandId },
    }));
    if (result.state === "uncertain") {
      throw new Error("消息投递状态尚未确认，请同步状态后重试");
    }
  }

  async function cancelQueuedTurn(sessionId: string, commandId: string): Promise<void> {
    unwrap(await apiRequest({
      method: "turn.queue.cancel",
      params: { sessionId, commandId },
    }));
  }

  async function resolveUncertainDelivery(commandId: string, action: "confirm" | "retry"): Promise<void> {
    unwrap(await apiRequest({
      method: "message.delivery.resolve",
      params: { commandId, action },
    }));
  }

  async function stopSubagent(): Promise<void> {
    if (!stopSubagentTarget || subagentStopBusy) return;
    setSubagentStopBusy(true);
    setStopError(undefined);
    try {
      unwrap(await apiRequest({
        method: "subagent.stop",
        params: { sessionId: stopSubagentTarget.sessionId, agentId: stopSubagentTarget.agentId },
      }));
      setStopSubagentTarget(undefined);
    } catch (error) {
      setStopSubagentTarget(undefined);
      setStopError(error instanceof Error ? error.message : "子代理停止失败");
    } finally {
      setSubagentStopBusy(false);
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
      const mailRefId = assistantMail?.referenceFor(selected.sessionId);
      if (mailRefId && sessionCommandName(nextText)) throw new Error("请先清除邮件引用，再执行会话命令。");
      if (await commands.execute(nextText, attachments.length > 0 || nextFiles.length > 0)) return;
      unwrap(await apiRequest({
        method: "turn.start",
        params: {
          sessionId: selected.sessionId,
          text: appendUploadedFilePaths(nextText, nextFiles),
          attachments: nextAttachments,
          ...(mailRefId ? { mailRefId } : {}),
        },
        idempotencyKey: crypto.randomUUID(),
      }));
      fileUploads.clear(nextFiles);
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
    const promptKey = `${composerKey}:${promptId}`;
    setSending(true);
    setPromptErrors((current) => {
      if (!(promptKey in current)) return current;
      const next = { ...current };
      delete next[promptKey];
      return next;
    });
    try {
      const mailRefId = assistantMail?.referenceFor(selected.sessionId);
      if (mailRefId && sessionCommandName(promptText.trim())) throw new Error("请先清除邮件引用，再执行会话命令。");
      const response = await apiRequest({
        method: "turn.start",
        params: {
          sessionId: selected.sessionId,
          text: promptText.trim(),
          attachments: [],
          ...(mailRefId ? { mailRefId } : {}),
        },
        idempotencyKey: crypto.randomUUID(),
      });
      unwrap(response);
      setPromptReplies((current) => ({ ...current, [selected.sessionId]: { ...current[selected.sessionId], [promptId]: response.requestId } }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "发送失败";
      setPromptErrors((current) => ({ ...current, [promptKey]: message }));
      setCommandError(message);
    } finally {
      setSending(false);
    }
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

  async function createSession(cwd: string, title?: string, runtimeId?: BridgeDesktopRuntimeId, projectId?: string, trustWorkspace?: boolean): Promise<BridgeSessionInfo> {
    const canTrust = trustWorkspace === true && snapshot.host.capabilities.includes("workspace.trust.v1");
    const result = unwrap<{ session: BridgeSessionInfo }>(await apiRequest({
      method: "session.create",
      params: {
        cwd,
        ...(title ? { title } : {}),
        ...(runtimeId ? { runtimeId } : {}),
        ...(projectId ? { projectId } : {}),
        ...(canTrust ? { trustWorkspace: true } : {}),
      },
    }));
    await onRefreshSnapshot();
    return result.session;
  }

  function placeProjects(order: string[]): void {
    localStorage.setItem(projectOrderKey, JSON.stringify(order));
    setPlacedProjects(order);
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

  const prControls = {
    supported: snapshot.host.capabilities.includes("pr.autofix.v1"),
    online: snapshot.runtime.desktopIntegration.state === "ready",
    onRead: async (sessionId: string, pr?: BridgePullRequest, includeChecks?: boolean) => unwrap<BridgePrAutoFixState>(await apiRequest({
      method: "pr.autoFix.read",
      params: { sessionId, ...(pr ? { repo: pr.repo, prNumber: pr.prNumber, ...(pr.host ? { host: pr.host } : {}) } : {}), includeChecks },
    })),
    onSet: async (update: BridgePrAutoFixUpdate) => {
      const next = unwrap<BridgePrAutoFixState>(await apiRequest({ method: "pr.autoFix.set", params: update }));
      await onRefreshSnapshot();
      return next;
    },
  };

  return (
    <section className={`desktop-session-layout${fixedSessionId ? " is-fixed-session" : ""}`}>
      {!fixedSessionId && <aside className="desktop-session-sidebar">
        <div className="desktop-sidebar-heading">
          <div><span>Bridge 1.0</span><h1>会话</h1></div>
          <div className="desktop-sidebar-actions">
            {projectOrder.length > 1 && (
              <IconButton label="调整项目顺序" onClick={() => setProjectOrderOpen(true)}>
                <ArrowDownUp size={17} />
              </IconButton>
            )}
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
                <ProjectGroupHeader
                  title={snapshot.projects.find(project => project.projectId === groupProjectId)?.name ?? sessions[0]!.projectName}
                  count={families.length}
                  expanded={expanded}
                  controlsId={sessionsId}
                  onToggle={() => toggleProject(groupProjectId)}
                />
                {expanded && (
                  <div className="desktop-project-sessions" id={sessionsId}>
                    <SessionFamilyList
                      families={families}
                      projects={snapshot.projects}
                      permissions={snapshot.permissions}
                      expandedForkParents={expandedForkParents}
                      selectedId={selectedId}
                      includeArchivedInline
                      onSelectSession={setSelectedId}
                      onToggleForkGroup={toggleForkGroup}
                    />
                  </div>
                )}
              </section>
            );
          })}
          {grouped.length === 0 && (
            <EmptyState
              title={snapshot.runtime.desktopIntegration.state === "ready" ? "暂无活跃会话" : "未检测到 Claude Desktop"}
              action={(
                <button type="button" className="primary-button session-catalog-empty-action" onClick={() => setCreateOpen(true)}>
                  <Plus size={16} />
                  新建会话
                </button>
              )}
            />
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
                    <SessionFamilyList
                      families={archivedFamilies}
                      projects={snapshot.projects}
                      permissions={snapshot.permissions}
                      expandedForkParents={expandedForkParents}
                      selectedId={selectedId}
                      archivedList
                      onSelectSession={setSelectedId}
                      onToggleForkGroup={toggleForkGroup}
                    />
                  </div>
                )}
              </section>
            );
          })()}
        </div>
      </aside>}

      <section className="desktop-conversation">
        {selected ? (() => {
          const backgroundTasks = activityTasks ?? [];
          const runningBackgroundTasks = backgroundTasks.filter((task) => task.state === "running").length;
          const canSteerQueuedTurn = snapshot.host.capabilities.includes("turn.queue.steer.v1");
          const canCancelQueuedTurn = snapshot.host.capabilities.includes("turn.queue.cancel.v1");
          const canStopSubagent = snapshot.host.capabilities.includes("subagent.stop.v1");
          const parentSession = selected.parentSessionId
            ? snapshot.sessions.find((candidate) => candidate.sessionId === selected.parentSessionId)
            : undefined;
          const childForks = snapshot.sessions.filter((candidate) => (
            candidate.parentSessionId === selected.sessionId
            && (!candidate.archivedAt || Boolean(candidate.sidechat) || Boolean(selected.archivedAt))
          ));
          const renderSubagent = (item: ConversationItem) => (
            <SubagentCard
              item={item}
              key={item.id}
              entering={streamEntering(item.id)}
              collapsible={false}
              stopping={subagentStopBusy && stopSubagentTarget?.agentId === item.subagent!.agentId}
              {...(selected.subagentStopScope === "process" && selected.turnState === "running"
                ? { stopBlockedReason: "主对话运行中，需要先停止主对话" }
                : {})}
              {...(canStopSubagent && selected.subagentStopScope ? {
                onStop: () => setStopSubagentTarget({
                  sessionId: selected.sessionId,
                  agentId: item.subagent!.agentId,
                  description: item.subagent!.description,
                  scope: selected.subagentStopScope!,
                }),
              } : {})}
              onFileClick={openSessionFile}
            />
          );
          return (
          <>
            <header className="desktop-conversation-heading">
              <div>
                <h2>{selected.title}</h2>
                <span>{selectedRuntimeName} · {selected.projectName} · {sessionState(selected)} · {transportLabel(selected)}</span>
              </div>
              <div className="desktop-conversation-heading-actions">
                {backgroundTasks.length > 0 && (
                  <IconButton
                    label={runningBackgroundTasks > 0 ? `后台任务，${runningBackgroundTasks} 个运行中` : "后台任务"}
                    className="background-tasks-button"
                    onClick={() => setBackgroundTasksOpen({})}
                  >
                    <Layers size={17} />
                    {runningBackgroundTasks > 0 && <span className="background-tasks-count">{runningBackgroundTasks}</span>}
                  </IconButton>
                )}
                {!selected.prs?.length && prControls.supported && (
                  <IconButton label="PR Auto-fix" onClick={() => setPrActionsOpen(true)}>
                    <GitPullRequest size={18} />
                  </IconButton>
                )}
                {canConfigure ? (
                  <button
                    type="button"
                    className="session-profile-trigger"
                    aria-label="会话设置"
                    aria-describedby="desktop-session-profile-summary"
                    onClick={() => setConfigurationOpen(true)}
                  >
                    <Settings2 size={15} />
                    <SessionProfileSummary session={selected} id="desktop-session-profile-summary" />
                  </button>
                ) : <span className="session-profile-trigger is-static"><SessionProfileSummary session={selected} /></span>}

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
            {selected.prs?.length ? (
              <SessionPrBar
                key={selected.sessionId}
                session={selected}
                events={events}
                {...prControls}
              />
            ) : null}
            {selectedTaskDetails?.error && (
              <p className="desktop-channel-banner session-channel-warning" role="alert">后台任务：{selectedTaskDetails.error}</p>
            )}
            {otherNativePromptSession && (
              <div className="desktop-channel-banner">
                <AlertTriangle size={18} />
                <button type="button" className="relay-chain-link" onClick={() => setSelectedId(otherNativePromptSession.sessionId)}>另一会话待确认：{otherNativePromptSession.title}</button>
              </div>
            )}
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
            <ForkChainBar
              parentSession={parentSession}
              childForks={childForks}
              onSelectSession={setSelectedId}
              className="desktop-channel-banner"
            />
            {stopError && (
              <div className="desktop-channel-banner danger">
                <AlertTriangle size={18} />
                <span><strong>任务停止失败</strong>{stopError}</span>
              </div>
            )}
            {fileDownloadError && (
              <div className="desktop-channel-banner danger" role="alert">
                <AlertTriangle size={18} />
                <span><strong>文件下载失败</strong>{fileDownloadError}</span>
                <button type="button" className="secondary-button goal-action" onClick={() => setFileDownloadError(undefined)}>关闭</button>
              </div>
            )}
            {backgroundTasksOpen && (
              <BackgroundTasksSheet
                supportsToolDetail={snapshot.host.capabilities.includes("transcript.toolDetail.v1")}
                sessionId={selected.sessionId}
                tasks={backgroundTasks}
                items={items}
                {...(backgroundTasksOpen.focus ? { focus: backgroundTasksOpen.focus } : {})}
                renderSubagent={renderSubagent}
                onClose={() => setBackgroundTasksOpen(undefined)}
              />
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
            <div
              className="desktop-conversation-stream"
              aria-live="polite"
              ref={streamRef}
              onScroll={() => {
                rememberStreamPosition(true);
                loadOlderNearTop();
              }}
            >
              {selectedHistory?.hasMore && (
                <button
                  type="button"
                  className="load-older-button"
                  disabled={selectedHistory.status === "loading"}
                  onClick={() => void loadOlderHistory(selected.sessionId)}
                >
                  {selectedHistory.status === "loading" && <LoaderCircle className="is-spinning" size={15} />}
                  {selectedHistory.status === "loading" ? "正在分段加载更早消息…" : selectedHistory.error ? "重试加载更早消息" : "加载更早消息"}
                </button>
              )}
              {selectedHistory?.hasMore && selectedHistory.error && (
                <div className="conversation-error-detail" role="alert">{selectedHistory.error}</div>
              )}
              {selectedHistory?.status === "loading" && selectedHistory.items.length === 0 && (
                <div className="conversation-loading"><LoaderCircle className="is-spinning" size={20} />正在加载最新对话…</div>
              )}
              {selectedHistory?.status === "error" && selectedHistory.items.length === 0 && (
                <div className="conversation-empty">
                  <strong>会话暂时无法读取</strong>
                  {selectedHistory.error && <span className="conversation-error-detail">{selectedHistory.error}</span>}
                  <button type="button" className="secondary-button" onClick={() => void openSession(selected.sessionId)}>重试</button>
                </div>
              )}
              {displayNodes.length === 0
                && sessionPermissions.length === 0
                && sessionNativePrompts.length === 0
                && orphanUncertainDeliveries.length === 0
                && selectedHistory?.status === "ready" && (
                  <div className="conversation-empty">
                    <strong>这是一个空会话</strong>
                    <span>从下方发出第一条指令。</span>
                  </div>
                )}
              {displayNodes.map((node) => {
                if (node.kind === "mail") {
                  return (
                    <MailCard
                      key={`mail:${node.card.mailRefId}`}
                      card={node.card}
                      {...(node.nativeMessage ? { nativeMessage: node.nativeMessage } : {})}
                    />
                  );
                }
                if (node.kind === "evidence") {
                  return (
                    <EvidenceInlineSummary
                      evidence={node.evidence}
                      key={`evidence:${node.evidence.id}`}
                      entering={streamEntering(`evidence:${node.evidence.id}`)}
                      onOpen={() => setSessionView("evidence")}
                    />
                  );
                }
                if (node.kind === "tool-group") {
                  return (
                    <ConversationToolGroup
                      key={toolGroupKeys.get(node.id) ?? node.id}
                      hostId={snapshot.host.hostId}
                      sessionId={selected.sessionId}
                      tools={node.tools}
                      supportsToolDetail={snapshot.host.capabilities.includes("transcript.toolDetail.v1")}
                    />
                  );
                }
                if (node.kind === "background-task") {
                  const task = findBackgroundTask(backgroundTasks, node.item.subagent!);
                  return (
                    <BackgroundTaskMarker
                      key={`${selected.sessionId}:${node.id}`}
                      item={node.item}
                      {...(task ? { task } : {})}
                      entering={streamEntering(node.item.id)}
                      onOpen={() => setBackgroundTasksOpen({ focus: node.item })}
                    />
                  );
                }
                const item = node.item;
                if (item.sessionNotice) {
                  return (
                    <SessionNoticeCard
                      key={item.id}
                      itemId={item.id}
                      notice={item.sessionNotice}
                      source={item.text}
                      entering={streamEntering(item.id)}
                      onFileClick={openSessionFile}
                    />
                  );
                }
                const queueActionKey = JSON.stringify([snapshot.host.hostId, selected.sessionId, item.commandId]);
                const peerMessages = selected.transport === "claude-desktop-native"
                  || selected.transport === "claude-desktop-managed"
                  || selected.desktopHandoff?.state === "desktop-inbox";
                const pendingQuestion = item.interactivePrompt ? matchingQuestionPermission(
                  item.interactivePrompt,
                  sessionPermissions,
                  item.interactivePrompt.toolUseId ?? (peerMessages ? "" : undefined),
                ) : undefined;
                const unavailableReason = peerMessages && item.interactivePrompt
                  ? item.interactivePrompt.kind === "question" && !pendingQuestion ? "提问已不在待回答列表"
                    : item.interactivePrompt.kind === "wrap-up" && item.interactivePrompt.blocked ? "需在电脑端确认" : undefined
                  : undefined;
                const promptKey = `${composerKey}:${item.id}`;
                const interactivePrompt = item.interactivePrompt && (!pendingQuestion || item.interactivePrompt.answered) ? (
                  <InteractivePromptCard
                    prompt={item.interactivePrompt}
                    {...(item.replyDelivery ? { replyDelivery: item.replyDelivery } : {})}
                    {...(item.replyPending ? { replyPending: true } : {})}
                    canSend={canSendSession(selected, snapshot)}
                    busy={sending}
                    {...(unavailableReason ? { unavailableReason } : {})}
                    {...(promptErrors[promptKey] ? { error: promptErrors[promptKey] } : {})}
                    onSelectOption={async (replyText) => {
                      if (unavailableReason || sending) return;
                      await sendQuickReply(item.id, replyText);
                    }}
                  />
                ) : undefined;
                return (
                  <ConversationMessageItem
                    key={item.id}
                    item={item}
                    session={selected}
                    entering={streamEntering(item.id)}
                    online={nativeOnline}
                    canSend={canSendSession(selected, snapshot)}
                    queueAction={queuedSteers[queueActionKey]}
                    onSteerQueuedTurn={canSteerQueuedTurn ? steerQueuedTurn : undefined}
                    onCancelQueuedTurn={canCancelQueuedTurn ? cancelQueuedTurn : undefined}
                    onQueueActionChange={(next) => setQueuedSteers((current) => ({ ...current, [queueActionKey]: next }))}
                    rewindAvailable={rewindAvailable}
                    rewindDisabled={rewindDisabled}
                    onRewind={(messageId) => setRewindTarget({ sessionId: selected.sessionId, messageId })}
                    onResolveUncertain={resolveUncertainDelivery}
                    onFileClick={openSessionFile}
                    interactivePrompt={interactivePrompt}
                  />
                );
              })}
              {sessionPermissions.map((permission) => (
                <PermissionPrompt
                  key={permission.requestId}
                  streamKey={`permission:${permission.requestId}`}
                  permission={permission}
                  onResolve={resolvePermission}
                  {...(permission.canSetNativeFullAccess ? {
                    onEnableNativeFullAccess: (requestId: string) => resolvePermission(requestId, "allow-once", undefined, undefined, "bypassPermissions"),
                  } : {})}
                />
              ))}
              {sessionNativePrompts.map((prompt) => (
                <NativePromptCard
                  key={prompt.promptId}
                  streamKey={`prompt:${prompt.promptId}`}
                  prompt={prompt}
                  online={snapshot.runtime.desktopIntegration.state === "ready"}
                  {...(snapshot.host.capabilities.includes("prompt.native.v1") ? {
                    onResolve: async (sessionId: string, promptId: string, choice: string) => {
                      const response = await apiRequest({ method: "prompt.resolve", params: { sessionId, promptId, choice } });
                      if (response.ok || response.error?.code === "ALREADY_RESOLVED") await onRefreshSnapshot();
                      unwrap(response);
                    },
                  } : {})}
                />
              ))}
              {orphanUncertainDeliveries.map((event) => (
                <article
                  className="conversation-item system uncertain-delivery"
                  key={event.eventId}
                  data-stream-key={`uncertain:${event.eventId}`}
                >
                  <div className="conversation-item-meta"><strong>发送结果待确认</strong></div>
                  <div className="conversation-text">{typeof event.data.error === "string" ? event.data.error : "Desktop 在确认消息前断开。"}</div>
                  <div className="uncertain-delivery-actions">
                    <button type="button" className="secondary-button" onClick={() => void resolveUncertainDelivery(String(event.data.commandId), "confirm")}>确认已发送</button>
                    <button type="button" className="secondary-button" onClick={() => void resolveUncertainDelivery(String(event.data.commandId), "retry")}>检查后重发</button>
                  </div>
                </article>
              ))}
            </div>
            ) : (
              <div className="desktop-evidence-view">
                <MediaGallery artifacts={mediaArtifacts(selectedEvidence?.items ?? [])} online={nativeOnline} />
                {fileChangesSummary && (
                  <FileChangesCard
                    summary={fileChangesSummary}
                    onPreviewFile={openSessionFile}
                    transfers={artifactTransfers}
                    online={nativeOnline}
                    onDownloadFile={(filePath) => {
                      setFileDownloadError(undefined);
                      setPendingFileDownload(filePath);
                    }}
                  />
                )}
                <EvidencePanel
                  state={selectedEvidence}
                  previews={artifactPreviews}
                  transfers={artifactTransfers}
                  online={nativeOnline}
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
            <MailReference sessionId={selected.sessionId} />
            <div className="desktop-composer">
              {commandError && <div className="composer-error" role="alert">{commandError}</div>}
              <FileAttachmentPicker state={fileUploads} />
              {attachments.length > 0 && (
                <div className="composer-attachments">
                  {attachments.map((attachment) => <span key={attachment.id}>{attachment.name}<button type="button" onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))}><X size={12} /></button></span>)}
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
          );
        })() : (
          <div className="desktop-conversation-empty"><MessageSquare size={24} /><span>{fixedSessionId ? "绑定会话暂不可用，请在助理设置中核对绑定。" : "从左侧选择会话"}</span></div>
        )}
      </section>

      {prActionsOpen && selected && !selected.prs?.length && prControls.supported && (
        <Sheet title="PR Auto-fix" manageFocus busy={sessionActionBusy} onClose={() => setPrActionsOpen(false)}>
          <div className="m-group">
            <SessionPrActions key={selected.sessionId} session={selected} events={events} showHeading={false} onWriteBusyChange={setSessionActionBusy} {...prControls} />
          </div>
        </Sheet>
      )}
      {projectOrderOpen && (
        <ProjectOrderSheet
          manageFocus
          desktopName={snapshot.host.name}
          projectOrder={projectOrder}
          projectsByActivity={projectsByActivity}
          projects={snapshot.projects}
          sessions={snapshot.sessions}
          onPlaceProjects={placeProjects}
          onClose={() => setProjectOrderOpen(false)}
        />
      )}
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
          if (result.scope !== "files") { setText(result.prefill ?? ""); setAttachments([]); fileUploads.clear(fileUploads.files); }
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
        open={Boolean(stopSubagentTarget)}
        title={stopSubagentTarget?.scope === "process" ? "结束这个会话的 Claude 进程？" : "停止这个子代理？"}
        description={stopSubagentTarget?.scope === "process"
          ? `这台电脑没有开启 Claude Desktop 托管，无法单独停止「${stopSubagentTarget.description}」。确认后会结束这个会话在电脑上的 Claude 进程，这个会话的所有后台任务都会停止。对话记录会保留。`
          : `「${stopSubagentTarget?.description ?? ""}」会被停止，还没交回的结果不会再有。主对话不受影响。`}
        confirmLabel={stopSubagentTarget?.scope === "process" ? "结束进程" : "停止子代理"}
        danger
        busy={subagentStopBusy}
        onCancel={() => {
          if (!subagentStopBusy) setStopSubagentTarget(undefined);
        }}
        onConfirm={() => void stopSubagent()}
      />

      <ConfirmationDialog
        open={Boolean(pendingFileDownload && selected)}
        title="确认下载工作区文件？"
        description={pendingFileDownload
          ? `即将从工作区下载「${pendingFileDownload.split(/[\\/]/u).at(-1) || pendingFileDownload}」（${pendingFileDownload}），是否继续？`
          : ""}
        confirmLabel="确认下载"
        busy={fileDownloadBusy}
        onCancel={() => {
          if (!fileDownloadBusy) setPendingFileDownload(undefined);
        }}
        onConfirm={() => {
          if (!pendingFileDownload || !selected || fileDownloadBusy) return;
          const targetSessionId = selected.sessionId;
          const targetPath = pendingFileDownload;
          setFileDownloadBusy(true);
          setFileDownloadError(undefined);
          void downloadSessionFile(targetSessionId, targetPath)
            .then(() => {
              setPendingFileDownload(undefined);
            })
            .catch((downloadError) => {
              setPendingFileDownload(undefined);
              setFileDownloadError(downloadError instanceof Error ? downloadError.message : "文件下载失败");
            })
            .finally(() => {
              setFileDownloadBusy(false);
            });
        }}
      />

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

export { DesktopSessions as DesktopSessionsPane };
