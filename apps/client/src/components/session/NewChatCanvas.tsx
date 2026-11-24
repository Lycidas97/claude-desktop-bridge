import {
  BRIDGE_EFFORT_LEVELS,
  CLAUDE_UNSECTIONED_PROJECT_ID,
  CLAUDE_UNSECTIONED_PROJECT_NAME,
  DEFAULT_CONFIGURATION_SESSION_ID,
  isBridgeEffort,
  type BridgeAttachment,
  type BridgeDesktopRuntimeId,
  type BridgeEffort,
  type BridgeHostSnapshot,
  type BridgeProjectInfo,
  type BridgeSDKPermissionMode,
  type BridgeSessionConfiguration,
  type BridgeSessionInfo,
} from "@bridge/protocol";
import { ArrowUp, ChevronDown, Folder, LoaderCircle, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useOptionalMagpieQuota } from "../../../../../plugins/magpie-quota/client.js";
import { modelQuotaLabel } from "../../../../../plugins/magpie-quota/presentation.js";
import { isClaudeNativeRelay } from "../../hooks/bridge/bridge-reducers.js";
import { canSendSession, sanitizeModelDisplayName } from "../../lib/conversation-timeline.js";
import { appendUploadedFilePaths, MAX_FILE_UPLOAD_BYTES, type UploadFileHandler } from "../../lib/file-upload.js";
import { registerMobileBackHandler } from "../../lib/mobile-back-navigation.js";
import { desktopRuntimeName } from "../../lib/runtime-labels.js";
import { ConfirmationDialog } from "../common/ConfirmationDialog.js";
import { IconButton } from "../common/IconButton.js";
import { SelectMenu } from "../common/SelectMenu.js";
import {
  useConversationDrafts,
  type ConversationDraftsController,
} from "../conversation/ConversationDraftsProvider.js";
import { ComposerAttachmentMenu, FileAttachmentPicker } from "../evidence/FileAttachmentPicker.js";
import {
  MobileInspectorCallout,
  resolveClaudeRemoteActivationStatus,
  type MobileInspectorCalloutProps,
} from "../mobile/MobileInspectorCallout.js";
import { MobilePageHeader } from "../mobile/MobilePageHeader.js";
import "./new-chat-canvas.css";
import { SectionCreateDialog, type SectionCreateState } from "./SectionCreateDialog.js";
import { modelEffortLevels, type SessionConfigurationChange } from "./SessionConfigurationDialog.js";
import { PERMISSION_MODE_OPTIONS, effortLabel } from "./session-labels.js";

export const NEW_CHAT_DRAFT_SESSION_ID = "__new__";
const CREATE_SECTION_OPTION_VALUE = "__create_section__";

function formatDisplayDirectory(path: string | undefined): string {
  const trimmed = typeof path === "string" ? path.trim() : "";
  if (!trimmed) return "选择工作目录…";
  const macMatch = /^\/Users\/[^/]+(\/.*)$/u.exec(trimmed);
  if (macMatch) return `~${macMatch[1]}`;
  const linuxMatch = /^\/home\/[^/]+(\/.*)$/u.exec(trimmed);
  if (linuxMatch) return `~${linuxMatch[1]}`;
  return trimmed;
}

function isWorkspaceTrustError(reason: unknown): { isTrust: boolean; code: string } {
  const code = reason && typeof reason === "object" && "code" in reason
    ? String((reason as { code?: unknown }).code ?? "")
    : "";
  const message = reason instanceof Error ? reason.message : "";
  const isTrust = code === "WORKSPACE_TRUST_REQUIRED"
    || code === "WORKSPACE_TRUST_MANUAL_REQUIRED"
    || /\bWorkspaceTrustError\b|\[ccdErrorCategory:trust_required\]/u.test(message);
  return { isTrust, code };
}

export interface NewChatDirectoryPickerRequest {
  initialProjectId?: string | undefined;
  initialCwd?: string | undefined;
  pendingPrompt?: string | undefined;
  onPickDirectory?: ((cwd: string) => void) | undefined;
}

export interface NewChatCanvasProps {
  hostId?: string | undefined;
  snapshot: BridgeHostSnapshot | undefined;
  connected: boolean;
  mobile?: boolean | undefined;
  headerLeading?: ReactNode | undefined;
  onBack?: (() => void) | undefined;
  backLabel?: string | undefined;
  onCancel?: (() => void) | undefined;
  runtimeName?: string | undefined;
  initialProjectId?: string | undefined;
  initialCwd?: string | undefined;
  conversationDrafts?: ConversationDraftsController | undefined;
  onChooseDirectory?(initialPath?: string): Promise<string | undefined>;
  onOpenDirectoryPicker(request?: NewChatDirectoryPickerRequest): void;
  onCreateSection?: ((name: string) => Promise<BridgeProjectInfo | undefined>) | undefined;
  onLoadSessionConfiguration?(sessionId: string): Promise<BridgeSessionConfiguration>;
  onConfigureSession?(sessionId: string, change: SessionConfigurationChange): Promise<BridgeSessionConfiguration>;
  onCreateSession?(
    cwd: string,
    title?: string,
    runtimeId?: BridgeDesktopRuntimeId,
    projectId?: string,
    trustWorkspace?: boolean,
  ): Promise<BridgeSessionInfo | undefined>;
  onUploadFile?: UploadFileHandler | undefined;
  onSendFirstTurn?(session: BridgeSessionInfo, text: string, attachments: BridgeAttachment[]): Promise<unknown>;
  onSessionCreated?(
    created: BridgeSessionInfo,
    options?: { initialPrompt?: string | undefined; configurationError?: string | undefined },
  ): Promise<void> | void;
  onActivateClaude?: MobileInspectorCalloutProps["onActivate"];
}

export function NewChatCanvas({
  hostId,
  snapshot,
  connected,
  mobile = false,
  headerLeading,
  onBack,
  backLabel = "返回会话列表",
  onCancel,
  runtimeName = "Claude",
  initialProjectId,
  initialCwd,
  conversationDrafts: externalDrafts,
  onChooseDirectory,
  onOpenDirectoryPicker,
  onCreateSection,
  onLoadSessionConfiguration,
  onConfigureSession,
  onCreateSession,
  onUploadFile,
  onSendFirstTurn,
  onSessionCreated,
  onActivateClaude,
}: NewChatCanvasProps) {
  const runtimeId = "claude-desktop";
  const effectiveHostId = hostId ?? snapshot?.host.hostId;
  const fallbackDrafts = useConversationDrafts(effectiveHostId);
  const drafts = externalDrafts ?? fallbackDrafts;
  const newChatDraft = drafts.session(effectiveHostId, NEW_CHAT_DRAFT_SESSION_ID);
  const { text: prompt, attachments, newChatFiles = [], firstTurnSession, imageError } = newChatDraft.draft;
  const hasAttachments = attachments.length > 0 || newChatFiles.length > 0;
  const pendingConfiguration = firstTurnSession?.pendingConfiguration;

  const [createdGroups, setCreatedGroups] = useState<BridgeProjectInfo[]>([]);
  const syncedCreatedGroupIdsRef = useRef(new Set<string>());
  const [sectionCreate, setSectionCreate] = useState<SectionCreateState>();

  const managedProjectId = snapshot?.projects.find(project => project.managedAssistant)?.projectId;
  const projects: readonly BridgeProjectInfo[] = (snapshot?.projects ?? []).filter(
    (project) => !project.managedAssistant && (project.runtimeId ?? runtimeId) === runtimeId,
  );
  const manualGroups = useMemo(() => {
    const base = projects.filter((project) => project.kind === "desktop-group");
    if (createdGroups.length === 0) return base;
    const seenInSnapshot = new Set(base.map((project) => project.projectId));
    for (const candidate of createdGroups) {
      if (seenInSnapshot.has(candidate.projectId)) {
        syncedCreatedGroupIdsRef.current.add(candidate.projectId);
      }
    }
    const extras = createdGroups.filter(
      (project) => !seenInSnapshot.has(project.projectId) && !syncedCreatedGroupIdsRef.current.has(project.projectId),
    );
    return extras.length > 0 ? [...extras, ...base] : base;
  }, [createdGroups, projects]);

  useEffect(() => {
    if (createdGroups.length === 0) return;
    const baseIds = new Set(
      projects.filter((project) => project.kind === "desktop-group").map((project) => project.projectId),
    );
    if (createdGroups.some((candidate) => baseIds.has(candidate.projectId))) {
      for (const candidate of createdGroups) {
        if (baseIds.has(candidate.projectId)) syncedCreatedGroupIdsRef.current.add(candidate.projectId);
      }
      setCreatedGroups((current) => current.filter((candidate) => !baseIds.has(candidate.projectId)));
    }
  }, [createdGroups, projects]);
  const activeClaudeSessions = [...(snapshot?.sessions ?? [])]
    .filter((candidate) => !candidate.archivedAt && candidate.projectId !== managedProjectId && (candidate.runtimeId ?? runtimeId) === runtimeId)
    .sort((left, right) => right.lastActivityAt - left.lastActivityAt);

  const defaultFolderProject = [...projects]
    .filter((project) => Boolean(project.cwd?.trim()))
    .sort((left, right) => right.lastActivityAt - left.lastActivityAt)[0];

  const explicitTargetProject = initialProjectId !== undefined
    ? (projects.find((project) => project.projectId === initialProjectId)
      ?? manualGroups.find((project) => project.projectId === initialProjectId))
    : undefined;
  const explicitGroupSession = initialProjectId !== undefined
    ? activeClaudeSessions.find((candidate) => candidate.projectId === initialProjectId && Boolean(candidate.cwd?.trim()))
    : undefined;

  const resolvedDefaultCwd = initialCwd !== undefined
    ? initialCwd
    : initialProjectId !== undefined
      ? (explicitTargetProject?.cwd ?? explicitGroupSession?.cwd ?? "")
      : (defaultFolderProject?.cwd ?? activeClaudeSessions[0]?.cwd ?? "");

  const resolvedDefaultProjectId = initialProjectId !== undefined
    ? (explicitTargetProject?.kind === "desktop-group" ? explicitTargetProject.projectId : "")
    : (defaultFolderProject?.kind === "desktop-group" ? defaultFolderProject.projectId : "");

  const [rawSelectedCwd, setSelectedCwd] = useState<string>(resolvedDefaultCwd);
  const [rawSelectedProjectId, setSelectedProjectId] = useState<string>(resolvedDefaultProjectId);
  const [sessionTitle, setSessionTitle] = useState<string>("");
  const selectedCwd = firstTurnSession?.session.cwd ?? rawSelectedCwd;
  const selectedProjectId = firstTurnSession
    ? manualGroups.find((group) => group.projectId === firstTurnSession.session.projectId)?.projectId ?? ""
    : rawSelectedProjectId;

  useEffect(() => {
    if (initialProjectId !== undefined || initialCwd !== undefined) return;
    if (!selectedCwd && defaultFolderProject?.cwd) {
      setSelectedCwd(defaultFolderProject.cwd);
      if (defaultFolderProject.kind === "desktop-group") {
        setSelectedProjectId(defaultFolderProject.projectId);
      }
    }
  }, [defaultFolderProject?.cwd, defaultFolderProject?.kind, defaultFolderProject?.projectId, initialCwd, initialProjectId, selectedCwd]);

  const referenceSession = useMemo(
    () => [...(snapshot?.sessions ?? [])]
      .filter((candidate) => candidate.projectId !== managedProjectId && (candidate.runtimeId ?? runtimeId) === runtimeId)
      .sort((left, right) => right.lastActivityAt - left.lastActivityAt)
      .find((candidate) => Boolean(
        candidate.model
        || candidate.modelDisplayName
        || candidate.effort
        || candidate.reasoningEffort
        || candidate.nativePermissionMode,
      )),
    [managedProjectId, snapshot?.sessions],
  );

  const [configuration, setConfiguration] = useState<BridgeSessionConfiguration>();
  const [configLoading, setConfigLoading] = useState(false);
  const [effortDraft, setEffortDraft] = useState<BridgeEffort | undefined>(pendingConfiguration?.effort ?? undefined);
  const [permissionMode, setPermissionMode] = useState<BridgeSDKPermissionMode>(
    () => pendingConfiguration?.permissionMode ?? referenceSession?.nativePermissionMode ?? "default",
  );
  const [outputStyle, setOutputStyle] = useState(pendingConfiguration?.outputStyle ?? "");
  const [pendingBypassConfirm, setPendingBypassConfirm] = useState(false);
  const [pendingDiscardConfirm, setPendingDiscardConfirm] = useState(false);
  const [quotaRequested, setQuotaRequested] = useState(false);

  const userTouchedRef = useRef({
    cwd: false,
    section: initialProjectId !== undefined,
    permission: Boolean(pendingConfiguration?.permissionMode),
  });

  const [busy, setBusy] = useState(false);
  const [choosingDirectory, setChoosingDirectory] = useState(false);
  const [error, setError] = useState<string>();
  const [trustState, setTrustState] = useState<{ mode: "confirm" | "manual"; withPrompt: boolean }>();
  const promptComposingRef = useRef(false);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const [readingImages, setReadingImages] = useState(false);
  const [activeUpload, setActiveUpload] = useState<{ id: string; progress: number }>();
  const firstTurnController = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => firstTurnController.current?.abort(), []);

  const quota = useOptionalMagpieQuota(
    quotaRequested
      && connected
      && Boolean(snapshot?.host.capabilities.includes("plugin.magpie-quota.v1")),
  );

  const runtime = snapshot?.runtimes?.find((candidate) => candidate.id === runtimeId);
  const canPrepareAttachments = onCreateSession && onSendFirstTurn && isClaudeNativeRelay(snapshot)
    && (!snapshot?.runtimes || runtime?.capabilities.includes("turn.start"));
  const canAttachImages = Boolean(canPrepareAttachments && (!snapshot?.runtimes || runtime?.capabilities.includes("attachment.image")));
  const uploadFile = canPrepareAttachments && snapshot?.host.capabilities.includes("workspace.upload.v1") ? onUploadFile : undefined;
  const canTrustWorkspace = Boolean(
    snapshot?.host.capabilities.includes("workspace.trust.v1")
    && (snapshot.runtimes ? runtime?.capabilities.includes("workspace.trust") : true),
  );
  const runtimeAvailable = snapshot
    ? (snapshot.runtimes
        ? runtime?.state === "ready" && runtime.capabilities.includes("session.create")
        : snapshot.runtime.state === "ready" || snapshot.runtime.state === "working")
    : connected;
  const canConfigureRuntime = snapshot
    ? (snapshot.runtimes
        ? Boolean(runtime?.capabilities.includes("session.configure"))
        : snapshot.host.capabilities.includes("claude.native-relay.v1"))
    : true;
  const canCreateSection = Boolean(
    onCreateSection && snapshot?.host.capabilities.includes("section.create.v1"),
  );

  const activeTrustMode = trustState?.mode === "confirm" && !canTrustWorkspace
    ? "manual"
    : trustState?.mode;

  useEffect(() => {
    if (!connected || !runtimeAvailable || !canConfigureRuntime || !onLoadSessionConfiguration) return;
    let active = true;
    setConfigLoading(true);
    const loadConfig = async (): Promise<BridgeSessionConfiguration | undefined> => {
      try {
        const primary = await Promise.resolve(onLoadSessionConfiguration(DEFAULT_CONFIGURATION_SESSION_ID));
        if (primary && typeof primary === "object" && Array.isArray(primary.availableModels)) {
          return primary;
        }
      } catch {
        // Fall back to an existing Claude Desktop session when connected to a pre-__default__ host.
      }
      if (referenceSession?.sessionId) {
        try {
          const fallback = await Promise.resolve(onLoadSessionConfiguration(referenceSession.sessionId));
          if (fallback && typeof fallback === "object" && Array.isArray(fallback.availableModels)) {
            return fallback;
          }
        } catch {
          return undefined;
        }
      }
      return undefined;
    };
    void loadConfig()
      .then((next) => {
        if (!active || !next) return;
        setConfiguration(next);
        if (!userTouchedRef.current.permission && next.nativePermissionMode) {
          setPermissionMode(next.nativePermissionMode);
        }
      })
      .finally(() => {
        if (active) setConfigLoading(false);
      });
    return () => {
      active = false;
    };
  // Recent activity only supplies an existing-session fallback for older hosts.
  }, [connected, effectiveHostId, onLoadSessionConfiguration, canConfigureRuntime, runtimeAvailable]);

  useEffect(() => {
    if (!sectionCreate) return;
    return registerMobileBackHandler(() => {
      if (!sectionCreate.busy) setSectionCreate(undefined);
      return true;
    }, 160);
  }, [sectionCreate]);

  useEffect(() => {
    if (!pendingBypassConfirm && !pendingDiscardConfirm) return;
    return registerMobileBackHandler(() => {
      setPendingBypassConfirm(false);
      setPendingDiscardConfirm(false);
      return true;
    }, 155);
  }, [pendingBypassConfirm, pendingDiscardConfirm]);

  const modelOptions = configuration?.availableModels ?? [];
  const draftModel = newChatDraft.draft.newChatModel;
  const effortModelId = draftModel?.value
    ?? (configuration?.sessionId === DEFAULT_CONFIGURATION_SESSION_ID ? configuration.model : undefined);
  const effortModel = modelOptions.find(candidate => candidate.value === effortModelId) ?? draftModel;
  const reasoningEfforts = configuration?.availableReasoningEfforts;
  const effortLevels = modelEffortLevels(effortModel,
    reasoningEfforts?.length ? reasoningEfforts.filter(isBridgeEffort)
      : configuration?.availableEffortLevels.length ? configuration.availableEffortLevels : BRIDGE_EFFORT_LEVELS,
  );

  const pickedEffort = !configLoading && effortDraft && effortLevels.includes(effortDraft) ? effortDraft : undefined;
  const outputStyles = onConfigureSession && canConfigureRuntime
    && snapshot?.host.capabilities.includes("session.output-style.v1")
    && configuration?.sessionId === DEFAULT_CONFIGURATION_SESSION_ID
    ? configuration.availableOutputStyles ?? [] : [];

  const groupUnavailable = Boolean(
    selectedProjectId && !manualGroups.some((project) => project.projectId === selectedProjectId),
  );
  const locked = busy || choosingDirectory || Boolean(sectionCreate?.busy);
  const destinationLocked = locked || Boolean(firstTurnSession);
  const configurationLocked = locked || (Boolean(firstTurnSession) && !pendingConfiguration);
  const canSubmitBase = connected && !locked && (Boolean(firstTurnSession) || (runtimeAvailable && !groupUnavailable));
  const canSendFirstPrompt = canSubmitBase && !readingImages && Boolean(prompt.trim() || hasAttachments);
  const canCreateEmpty = canSubmitBase && !firstTurnSession && !readingImages && !hasAttachments;

  const quickDirectoryProjects = useMemo(() => {
    const seen = new Set<string>();
    const items: BridgeProjectInfo[] = [];
    for (const project of [...projects].sort((left, right) => right.lastActivityAt - left.lastActivityAt)) {
      const trimmed = project.cwd?.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      items.push(project);
      if (items.length >= 4) break;
    }
    return items;
  }, [projects]);

  const initialHostPermissionMode = configuration?.nativePermissionMode
    ?? referenceSession?.nativePermissionMode
    ?? "default";
  const showSectionSelect = manualGroups.length > 0 || canCreateSection || groupUnavailable;
  const sectionCanCreate = Boolean(
    canCreateSection
    && connected
    && sectionCreate?.name.trim()
    && !sectionCreate.busy,
  );

  function setPrompt(value: string): void {
    newChatDraft.setText(value);
  }

  function editPendingConfiguration<Key extends keyof SessionConfigurationChange>(key: Key, value: SessionConfigurationChange[Key]): void {
    if (!firstTurnSession || !pendingConfiguration) return;
    const next = { ...pendingConfiguration };
    if (value === undefined) delete next[key];
    else next[key] = value;
    newChatDraft.updateDraft((current) => ({
      ...current, firstTurnSession: { ...firstTurnSession, pendingConfiguration: next },
    }));
  }

  function applyPermissionMode(nextMode: BridgeSDKPermissionMode): void {
    userTouchedRef.current.permission = true;
    setPermissionMode(nextMode);
    editPendingConfiguration("permissionMode", nextMode);
  }

  function choosePermissionMode(nextMode: BridgeSDKPermissionMode): void {
    if (
      nextMode === "bypassPermissions"
      && permissionMode !== "bypassPermissions"
      && initialHostPermissionMode !== "bypassPermissions"
    ) {
      setPendingBypassConfirm(true);
      return;
    }
    applyPermissionMode(nextMode);
  }

  async function submitCreateSection(): Promise<void> {
    if (!sectionCanCreate || !sectionCreate || !onCreateSection) return;
    setSectionCreate({ ...sectionCreate, busy: true, error: "" });
    try {
      const created = await onCreateSection(sectionCreate.name.trim());
      if (!created) throw new Error("分组未创建，请重试。");
      setCreatedGroups((current) => [
        created,
        ...current.filter((candidate) => candidate.projectId !== created.projectId),
      ]);
      userTouchedRef.current.section = true;
      setSelectedProjectId(created.projectId);
      setError(undefined);
      setSectionCreate(undefined);
    } catch (reason) {
      setSectionCreate({
        ...sectionCreate,
        busy: false,
        error: reason instanceof Error ? reason.message : "分组创建失败",
      });
    }
  }

  function applyChosenDirectory(rawPath: string, overrideProjectId?: string): void {
    const nextCwd = rawPath.trim();
    if (!nextCwd) return;
    userTouchedRef.current.cwd = true;
    setSelectedCwd(nextCwd);
    setTrustState(undefined);
    setError(undefined);
    if (overrideProjectId !== undefined) {
      userTouchedRef.current.section = true;
      setSelectedProjectId(overrideProjectId);
    }
  }

  async function handleChooseDirectory(targetProjectId?: string): Promise<void> {
    if (!connected || destinationLocked) return;
    const effectiveProjectId = targetProjectId ?? (selectedProjectId || undefined);
    if (onChooseDirectory) {
      setChoosingDirectory(true);
      setError(undefined);
      try {
        const chosen = await onChooseDirectory(selectedCwd.trim() || undefined);
        if (chosen?.trim()) {
          applyChosenDirectory(chosen, targetProjectId);
        }
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "文件夹选择失败");
      } finally {
        setChoosingDirectory(false);
      }
      return;
    }
    onOpenDirectoryPicker({
      initialProjectId: effectiveProjectId,
      initialCwd: selectedCwd.trim() || undefined,
      onPickDirectory: (pickedCwd) => applyChosenDirectory(pickedCwd, targetProjectId),
    });
  }

  function buildPostCreateConfiguration(created: BridgeSessionInfo): SessionConfigurationChange | undefined {
    const createdEffort = created.effort ?? (isBridgeEffort(created.reasoningEffort) ? created.reasoningEffort : undefined);
    const createdPermission = created.nativePermissionMode ?? "default";

    const needsEffort = pickedEffort !== undefined && pickedEffort !== createdEffort;
    const needsPermission = Boolean(permissionMode && permissionMode !== createdPermission);
    const needsOutputStyle = outputStyle && outputStyle !== created.outputStyle;

    if (!draftModel && !needsEffort && !needsPermission && !needsOutputStyle) {
      return undefined;
    }

    return {
      // A projected created.model does not prove that Desktop applied the selection.
      ...(draftModel ? { model: draftModel.value } : {}),
      ...(needsEffort ? { effort: pickedEffort } : {}),
      ...(needsPermission ? { permissionMode } : {}),
      ...(needsOutputStyle ? { outputStyle } : {}),
    };
  }

  async function executeCreate(withPrompt: boolean, trustWorkspace = false): Promise<void> {
    const trimmedPrompt = prompt.trim();
    const trimmedTitle = sessionTitle.trim() || undefined;
    if (withPrompt ? !canSendFirstPrompt : !canCreateEmpty) return;
    const attachedSend = withPrompt && (hasAttachments || firstTurnSession);
    if (attachedSend && (!onSendFirstTurn || (attachments.length > 0 && !canAttachImages) || (newChatFiles.length > 0 && !uploadFile))) {
      setError("当前电脑不支持发送已选附件。");
      return;
    }
    const trimmedCwd = selectedCwd.trim();
    if (!trimmedCwd && !firstTurnSession) {
      onOpenDirectoryPicker({
        initialProjectId: selectedProjectId || undefined,
        ...(!attachedSend && withPrompt && trimmedPrompt ? { pendingPrompt: trimmedPrompt } : {}),
        onPickDirectory: (pickedCwd) => applyChosenDirectory(pickedCwd),
      });
      return;
    }

    if (!onCreateSession) {
      onOpenDirectoryPicker({
        initialProjectId: selectedProjectId || undefined,
        initialCwd: trimmedCwd,
        ...(withPrompt && trimmedPrompt ? { pendingPrompt: trimmedPrompt } : {}),
      });
      return;
    }

    setBusy(true);
    setError(undefined);
    const controller = attachedSend ? new AbortController() : undefined;
    firstTurnController.current = controller;
    try {
      const selectedGroup = selectedProjectId || undefined;
      const created = firstTurnSession?.session ?? (trustWorkspace
        ? await onCreateSession(trimmedCwd, trimmedTitle, runtimeId, selectedGroup, true)
        : await onCreateSession(trimmedCwd, trimmedTitle, runtimeId, selectedGroup));
      if (!created) {
        setTrustState(undefined);
        setError("会话未创建，请重试。");
        return;
      }
      setTrustState(undefined);

      const change = firstTurnSession
        ? pendingConfiguration
        : onConfigureSession && canConfigureRuntime ? buildPostCreateConfiguration(created) : undefined;
      controller?.signal.throwIfAborted();
      if (attachedSend && !firstTurnSession) {
        newChatDraft.updateDraft((current) => ({ ...current, firstTurnSession: { session: created, pendingConfiguration: change } }));
      }
      let configurationError: string | undefined;
      const hasChanges = change && Object.keys(change).length > 0;
      if (hasChanges && onConfigureSession && canConfigureRuntime) {
        try {
          const applied = await onConfigureSession(created.sessionId, change);
          if (
            change.permissionMode
            && applied?.nativePermissionMode !== undefined
            && applied.nativePermissionMode !== change.permissionMode
          ) {
            configurationError = "所选权限模式未生效，请检查会话设置后再发送。";
          }
        } catch (configReason) {
          configurationError = (configReason instanceof Error && configReason.message) || "会话配置应用失败。";
        }
      } else if (hasChanges) {
        configurationError = "会话配置暂不可用。";
      }

      if (controller && onSendFirstTurn) {
        controller.signal.throwIfAborted();
        if (configurationError) {
          setError(`首条消息未发送。${configurationError}`);
          return;
        }
        if (change) {
          newChatDraft.updateDraft((current) => ({ ...current, firstTurnSession: { session: created } }));
        }
        if (!canSendSession(snapshot?.sessions.find((session) => session.sessionId === created.sessionId) ?? created, snapshot)) {
          throw new Error("当前会话不允许发送消息。");
        }
        const uploaded = [];
        if (uploadFile) {
          for (const { id, file, result } of newChatFiles) {
            if (!result) setActiveUpload({ id, progress: 0 });
            const receipt = result ?? await uploadFile(created.sessionId, file, (progress) => setActiveUpload({ id, progress }), controller.signal);
            controller.signal.throwIfAborted();
            if (!result) newChatDraft.updateDraft((current) => ({
              ...current,
              newChatFiles: (current.newChatFiles ?? []).map((entry) => entry.id === id ? { ...entry, result: receipt } : entry),
            }));
            uploaded.push(receipt);
          }
        }
        await onSendFirstTurn(created, appendUploadedFilePaths(trimmedPrompt, uploaded), attachments);
        drafts.resetSession(effectiveHostId, NEW_CHAT_DRAFT_SESSION_ID);
        await onSessionCreated?.(created);
        return;
      }

      setSessionTitle("");
      if (withPrompt) {
        drafts.resetSession(effectiveHostId, NEW_CHAT_DRAFT_SESSION_ID);
      } else if (draftModel) {
        newChatDraft.updateDraft(current => ({ ...current, newChatModel: undefined }));
      }
      await onSessionCreated?.(created, {
        ...(withPrompt && trimmedPrompt ? { initialPrompt: trimmedPrompt } : {}),
        ...(configurationError ? {
          configurationError: withPrompt ? `首条消息未发送。${configurationError}` : configurationError,
        } : {}),
      });
    } catch (reason) {
      if (controller?.signal.aborted) return;
      const { isTrust, code } = isWorkspaceTrustError(reason);
      if (isTrust && !firstTurnSession) {
        setTrustState({
          mode: code === "WORKSPACE_TRUST_REQUIRED" && canTrustWorkspace ? "confirm" : "manual",
          withPrompt,
        });
      } else {
        setTrustState(undefined);
        setError(reason instanceof Error ? reason.message : "会话创建失败");
      }
    } finally {
      firstTurnController.current = undefined;
      setActiveUpload(undefined);
      setBusy(false);
    }
  }

  function resolveDefaultCwdForGroup(nextGroupId: string): string | undefined {
    if (!nextGroupId) {
      const unsectionedProject = projects.find(
        (project) => project.projectId === CLAUDE_UNSECTIONED_PROJECT_ID || project.kind !== "desktop-group",
      );
      if (unsectionedProject?.cwd?.trim()) return unsectionedProject.cwd.trim();
      return activeClaudeSessions.find(
        (candidate) => candidate.projectId === CLAUDE_UNSECTIONED_PROJECT_ID && Boolean(candidate.cwd?.trim()),
      )?.cwd.trim();
    }
    const matched = manualGroups.find((project) => project.projectId === nextGroupId);
    if (matched?.cwd?.trim()) return matched.cwd.trim();
    return activeClaudeSessions.find(
      (candidate) => candidate.projectId === nextGroupId && Boolean(candidate.cwd?.trim()),
    )?.cwd.trim();
  }

  return (
    <section className={`new-chat-canvas${mobile ? " is-mobile" : " is-desktop"}`}>
      <MobilePageHeader
        navigation={mobile}
        title="新建会话"
        {...(headerLeading ? { leading: headerLeading } : {})}
        {...(onBack ? { onBack, backLabel } : {})}
        {...(onCancel ? {
          actions: (
            <button
              type="button"
              className="secondary-button new-chat-cancel-btn"
              disabled={locked}
              onClick={onCancel}
            >
              返回会话
            </button>
          ),
        } : {})}
      />

      <div className="new-chat-canvas-body">
        <div className="new-chat-canvas-hero">
          {mobile && onActivateClaude && (
            <MobileInspectorCallout
              snapshot={snapshot}
              connected={connected}
              onActivate={onActivateClaude}
            />
          )}
          <div className="new-chat-config-card" role="group" aria-label="新建会话配置">
            <div className="new-chat-config-row">
              <span className="new-chat-config-label">工作目录</span>
              <button
                type="button"
                className={`new-chat-dir-pill${selectedCwd ? " has-folder" : ""}`}
                aria-label="选择文件夹"
                disabled={!connected || destinationLocked}
                onClick={() => void handleChooseDirectory()}
              >
                {choosingDirectory ? (
                  <LoaderCircle size={15} className="new-chat-dir-icon is-spinning" aria-hidden="true" />
                ) : (
                  <Folder size={15} className="new-chat-dir-icon" aria-hidden="true" />
                )}
                <code className="new-chat-dir-path">{formatDisplayDirectory(selectedCwd)}</code>
                <ChevronDown size={14} aria-hidden="true" />
              </button>
              {!showSectionSelect && quickDirectoryProjects.length > 1 && (
                <div className="new-chat-quick-sections" aria-label="最近目录">
                  {quickDirectoryProjects.map((project) => {
                    const isSelected = Boolean(project.cwd) && project.cwd === selectedCwd;
                    return (
                      <button
                        type="button"
                        key={project.projectId}
                        className={`new-chat-chip${isSelected ? " active" : ""}`}
                        disabled={!connected || destinationLocked}
                        onClick={() => {
                          if (!project.cwd) return;
                          userTouchedRef.current.cwd = true;
                          setSelectedCwd(project.cwd);
                          setTrustState(undefined);
                          setError(undefined);
                        }}
                      >
                        {project.name}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {showSectionSelect && (
              <div className="new-chat-config-row">
                <span className="new-chat-config-label">所属分组</span>
                <SelectMenu
                  ariaLabel="所属分组"
                  value={selectedProjectId}
                  disabled={!connected || destinationLocked}
                  options={[
                    { value: "", label: CLAUDE_UNSECTIONED_PROJECT_NAME },
                    ...(groupUnavailable ? [{ value: selectedProjectId, label: "分组已不可用", disabled: true }] : []),
                    ...manualGroups.map((project) => ({ value: project.projectId, label: project.name })),
                    ...(canCreateSection ? [{ value: CREATE_SECTION_OPTION_VALUE, label: "+ 新建分组…" }] : []),
                  ]}
                  onChange={(nextGroupId) => {
                    if (nextGroupId === CREATE_SECTION_OPTION_VALUE) {
                      setError(undefined);
                      setSectionCreate({ name: "", busy: false, error: "" });
                      return;
                    }
                    userTouchedRef.current.section = true;
                    setSelectedProjectId(nextGroupId);
                    setError(undefined);
                    if (!userTouchedRef.current.cwd) {
                      const nextCwd = resolveDefaultCwdForGroup(nextGroupId);
                      if (nextCwd && nextCwd !== selectedCwd) {
                        setSelectedCwd(nextCwd);
                        setTrustState(undefined);
                      }
                    }
                  }}
                />
              </div>
            )}

            <div className="new-chat-config-row">
              <span className="new-chat-config-label">会话标题</span>
              <input
                type="text"
                className="new-chat-title-input"
                aria-label="会话标题"
                placeholder="留空自动生成"
                maxLength={200}
                value={firstTurnSession?.session.title ?? sessionTitle}
                disabled={!connected || destinationLocked}
                onChange={(event) => {
                  setSessionTitle(event.target.value);
                  if (error) setError(undefined);
                }}
              />
            </div>

            <div
              className="new-chat-config-row"
              onPointerDown={() => setQuotaRequested(true)}
              onFocus={() => setQuotaRequested(true)}
              onKeyDown={() => setQuotaRequested(true)}
            >
              <span className="new-chat-config-label">模型</span>
              <SelectMenu
                ariaLabel="模型"
                value={draftModel?.value ?? ""}
                placeholder={draftModel ? sanitizeModelDisplayName(draftModel.displayName, draftModel.resolvedModel ?? draftModel.value) : undefined}
                disabled={!connected || configurationLocked || (!modelOptions.length && !draftModel)}
                options={[
                  { value: "", label: configLoading && !modelOptions.length && !draftModel ? "正在读取模型…" : "默认" },
                  ...modelOptions.map((candidate) => ({
                    value: candidate.value,
                    label: sanitizeModelDisplayName(candidate.displayName, candidate.resolvedModel ?? candidate.value),
                    meta: quota?.snapshot ? (modelQuotaLabel(quota.snapshot, candidate) || undefined) : undefined,
                  })),
                ]}
                onChange={(value) => {
                  newChatDraft.updateDraft(current => ({
                    ...current, newChatModel: modelOptions.find(candidate => candidate.value === value),
                  }));
                  editPendingConfiguration("model", value || null);
                }}
              />
            </div>

            {effortLevels.length > 0 && (
              <div className="new-chat-config-row">
                <span className="new-chat-config-label">思考强度</span>
                <div className="effort-segments new-chat-effort-segments" role="group" aria-label="思考强度">
                  {[undefined, ...effortLevels].map((level) => (
                    <button
                      type="button"
                      key={level ?? "default"}
                      className={pickedEffort === level ? "active" : ""}
                      aria-pressed={pickedEffort === level}
                      disabled={!connected || configurationLocked || configLoading}
                      onClick={() => {
                        setEffortDraft(level);
                        editPendingConfiguration("effort", level ?? null);
                      }}
                    >
                      {level ? effortLabel(level) : "默认"}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="new-chat-config-row">
              <span className="new-chat-config-label">权限模式</span>
              <SelectMenu<BridgeSDKPermissionMode>
                ariaLabel="权限模式"
                value={permissionMode}
                disabled={!connected || configurationLocked}
                options={PERMISSION_MODE_OPTIONS}
                onChange={choosePermissionMode}
              />
            </div>

            {outputStyles.length > 0 && (
              <div className="new-chat-config-row">
                <span className="new-chat-config-label">输出风格</span>
                <SelectMenu
                  ariaLabel="输出风格"
                  value={outputStyle}
                  disabled={!connected || configurationLocked}
                  options={[
                    { value: "", label: "默认" },
                    ...outputStyles.filter((style) => style !== "default").map((style) => ({ value: style, label: style })),
                  ]}
                  onChange={(style) => {
                    setOutputStyle(style);
                    editPendingConfiguration("outputStyle", style || undefined);
                  }}
                />
              </div>
            )}
          </div>

          {groupUnavailable && (
            <p className="session-create-error new-chat-inline-alert" role="alert">所选分组已不可用，请重新选择。</p>
          )}
          {connected && !runtimeAvailable && !(mobile && onActivateClaude && resolveClaudeRemoteActivationStatus(snapshot).nativeUnavailable) && (
            <p className="session-create-error new-chat-inline-alert" role="alert">
              {desktopRuntimeName(runtimeId)} 当前无法创建会话。
            </p>
          )}
          {!connected && (
            <p className="session-create-status new-chat-inline-alert" role="status">电脑已离线，连接后可创建会话。</p>
          )}
          {activeTrustMode === "confirm" && (
            <div className="new-chat-trust-box">
              <p className="session-create-trust" role="alert">
                该文件夹首次使用，是否信任并允许 Claude 访问「{selectedCwd.trim()}」？
              </p>
              <button
                type="button"
                className="primary-button new-chat-trust-btn"
                disabled={!canSubmitBase}
                onClick={() => void executeCreate(Boolean(trustState?.withPrompt), true)}
              >
                {busy && <LoaderCircle className="is-spinning" size={15} />}
                信任并创建
              </button>
            </div>
          )}
          {activeTrustMode === "manual" && (
            <div className="new-chat-trust-box">
              <p className="session-create-trust is-manual" role="alert">
                请在电脑端 Claude 窗口打开并信任「{selectedCwd.trim()}」后重试。
              </p>
              <button
                type="button"
                className="primary-button new-chat-trust-btn"
                disabled={!canSubmitBase}
                onClick={() => void executeCreate(Boolean(trustState?.withPrompt), false)}
              >
                {busy && <LoaderCircle className="is-spinning" size={15} />}
                重试创建
              </button>
            </div>
          )}
        </div>
      </div>

      <footer className="mobile-composer">
        <FileAttachmentPicker disabled={locked} state={{
          entries: newChatFiles.map(({ id, file, result }) => ({
            id, name: file.name, size: file.size,
            progress: result ? 1 : activeUpload?.id === id ? activeUpload.progress : 0,
            staged: activeUpload?.id !== id,
            ...(result ? { result } : {}),
          })),
          remove: (id) => newChatDraft.updateDraft((current) => ({
            ...current, newChatFiles: (current.newChatFiles ?? []).filter((entry) => entry.id !== id),
          })),
        }} />
        {attachments.length > 0 && (
          <div className="composer-attachments">
            {attachments.map((attachment) => (
              <span key={attachment.id}>
                <img className="new-chat-attachment-thumb" src={`data:${attachment.mimeType};base64,${attachment.data}`} alt="" />
                <span title={attachment.name}>{attachment.name}</span>
                <button
                  type="button"
                  aria-label={`移除 ${attachment.name}`}
                  disabled={locked}
                  onClick={() => newChatDraft.updateDraft((current) => ({
                    ...current, attachments: current.attachments.filter((item) => item.id !== attachment.id),
                  }))}
                ><X size={13} /></button>
              </span>
            ))}
          </div>
        )}
        {(error || imageError) && <div className="composer-error" role="alert">{error || imageError}</div>}
        <form
          className="composer-form"
          onSubmit={(event) => {
            event.preventDefault();
            void executeCreate(true, false);
          }}
        >
          {canAttachImages && <input
            ref={imageInputRef}
            type="file"
            accept="image/jpeg,image/png,image/gif,image/webp"
            multiple
            hidden
            disabled={!connected || locked || readingImages}
            onChange={async ({ currentTarget }) => {
              setReadingImages(true);
              try {
                await newChatDraft.addImages(currentTarget.files, currentTarget);
              } finally {
                setReadingImages(false);
              }
            }}
          />}
          <textarea
            rows={mobile ? 2 : 1}
            aria-label={`给 ${runtimeName} 发指令`}
            placeholder="输入首条指令发送，或直接创建空会话…"
            value={prompt}
            disabled={!connected || locked}
            onCompositionStart={() => {
              promptComposingRef.current = true;
            }}
            onCompositionEnd={() => {
              promptComposingRef.current = false;
            }}
            onChange={(event) => {
              setPrompt(event.target.value);
              if (error) setError(undefined);
            }}
            onKeyDown={(event) => {
              if (
                !mobile
                && event.key === "Enter"
                && !event.shiftKey
                && !promptComposingRef.current
                && !event.nativeEvent.isComposing
                && event.nativeEvent.keyCode !== 229
              ) {
                event.preventDefault();
                void executeCreate(true, false);
              }
            }}
          />
          <div className="composer-bar">
            <div className="composer-bar-left">
              <ComposerAttachmentMenu
                canAttachImages={canAttachImages}
                imageDisabled={!connected || locked || readingImages}
                onPickImages={() => imageInputRef.current?.click()}
                fileDisabled={!connected || locked}
                {...(uploadFile ? { fileUploads: {
                  uploading: false,
                  async add(files: ArrayLike<File> | null) {
                    if (!files?.length) return;
                    const selected = Array.from(files);
                    const accepted = selected.filter((file) => file.size <= MAX_FILE_UPLOAD_BYTES);
                    setError(accepted.length === selected.length ? undefined : "单个文件不能超过 20 MiB");
                    const entries = accepted.map((file) => ({ id: crypto.randomUUID(), file }));
                    newChatDraft.updateDraft((current) => ({ ...current, newChatFiles: [...(current.newChatFiles ?? []), ...entries] }));
                  },
                } } : {})}
              />
            </div>
            <div className="composer-bar-right">
              <button
                type="button"
                className="secondary-button new-chat-empty-create-btn"
                disabled={firstTurnSession ? locked || readingImages : !canCreateEmpty}
                onClick={() => {
                  if (firstTurnSession) setPendingDiscardConfirm(true);
                  else void executeCreate(false, false);
                }}
              >
                {firstTurnSession ? "放弃草稿" : "创建空会话"}
              </button>
              <button
                type="submit"
                className="primary-button send-button"
                aria-label="发送"
                disabled={!canSendFirstPrompt}
              >
                {busy ? <LoaderCircle className="is-spinning" size={15} /> : <ArrowUp size={16} strokeWidth={2.4} />}
              </button>
            </div>
          </div>
        </form>
      </footer>

      <SectionCreateDialog
        state={sectionCreate}
        online={connected}
        canSubmit={sectionCanCreate}
        onChangeName={(name) => sectionCreate && setSectionCreate({ ...sectionCreate, name, error: "" })}
        onSubmit={submitCreateSection}
        onClose={() => {
          if (!sectionCreate?.busy) setSectionCreate(undefined);
        }}
      />

      <ConfirmationDialog
        open={pendingDiscardConfirm}
        title="放弃首发草稿？"
        description="正文和待发附件将清除。已创建的会话和已上传文件会保留。"
        confirmLabel="放弃草稿"
        danger
        onCancel={() => setPendingDiscardConfirm(false)}
        onConfirm={() => {
          drafts.resetSession(effectiveHostId, NEW_CHAT_DRAFT_SESSION_ID);
          setPendingDiscardConfirm(false);
          setSessionTitle("");
          setError(undefined);
        }}
      />

      <ConfirmationDialog
        open={pendingBypassConfirm}
        title="启用完全授权"
        description="新创建的 Claude Desktop 会话将跳过工具授权确认。此设置由 Desktop 管理。"
        confirmLabel="启用完全授权"
        onCancel={() => setPendingBypassConfirm(false)}
        onConfirm={() => {
          setPendingBypassConfirm(false);
          applyPermissionMode("bypassPermissions");
        }}
      />
    </section>
  );
}
