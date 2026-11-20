import {
  BRIDGE_EFFORT_LEVELS,
  CLAUDE_UNSECTIONED_PROJECT_ID,
  CLAUDE_UNSECTIONED_PROJECT_NAME,
  DEFAULT_CONFIGURATION_SESSION_ID,
  isBridgeEffort,
  type BridgeDesktopRuntimeId,
  type BridgeEffort,
  type BridgeHostSnapshot,
  type BridgeProjectInfo,
  type BridgeSDKPermissionMode,
  type BridgeSessionConfiguration,
  type BridgeSessionInfo,
} from "@bridge/protocol";
import { ArrowUp, ChevronDown, Folder, LoaderCircle, Plus } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useOptionalMagpieQuota } from "../../../../../plugins/magpie-quota/client.js";
import { modelQuotaLabel } from "../../../../../plugins/magpie-quota/presentation.js";
import { sanitizeModelDisplayName } from "../../lib/conversation-timeline.js";
import { registerMobileBackHandler } from "../../lib/mobile-back-navigation.js";
import { desktopRuntimeName } from "../../lib/runtime-labels.js";
import { ConfirmationDialog } from "../common/ConfirmationDialog.js";
import { IconButton } from "../common/IconButton.js";
import { SelectMenu } from "../common/SelectMenu.js";
import {
  useConversationDrafts,
  type ConversationDraftsController,
} from "../conversation/ConversationDraftsProvider.js";
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
  onSessionCreated,
  onActivateClaude,
}: NewChatCanvasProps) {
  const runtimeId = "claude-desktop";
  const effectiveHostId = hostId ?? snapshot?.host.hostId;
  const fallbackDrafts = useConversationDrafts(effectiveHostId);
  const drafts = externalDrafts ?? fallbackDrafts;
  const newChatDraft = drafts.session(effectiveHostId, NEW_CHAT_DRAFT_SESSION_ID);
  const prompt = typeof newChatDraft.draft.text === "string" ? newChatDraft.draft.text : "";

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
  const selectedCwd = typeof rawSelectedCwd === "string" ? rawSelectedCwd : resolvedDefaultCwd;
  const selectedProjectId = typeof rawSelectedProjectId === "string" ? rawSelectedProjectId : resolvedDefaultProjectId;

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
  const [model, setModel] = useState<string>(() => referenceSession?.model ?? "");
  const [effortDraft, setEffortDraft] = useState<BridgeEffort>();
  const [permissionMode, setPermissionMode] = useState<BridgeSDKPermissionMode>(
    () => referenceSession?.nativePermissionMode ?? "default",
  );
  const [outputStyle, setOutputStyle] = useState("");
  const [pendingBypassConfirm, setPendingBypassConfirm] = useState(false);
  const [quotaRequested, setQuotaRequested] = useState(false);

  const userTouchedRef = useRef({
    cwd: false,
    section: initialProjectId !== undefined,
    model: false,
    permission: false,
  });

  const [busy, setBusy] = useState(false);
  const [choosingDirectory, setChoosingDirectory] = useState(false);
  const [error, setError] = useState<string>();
  const [trustState, setTrustState] = useState<{ mode: "confirm" | "manual"; withPrompt: boolean }>();
  const promptComposingRef = useRef(false);

  const quota = useOptionalMagpieQuota(
    quotaRequested
      && connected
      && Boolean(snapshot?.host.capabilities.includes("plugin.magpie-quota.v1")),
  );

  const runtime = snapshot?.runtimes?.find((candidate) => candidate.id === runtimeId);
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
        if (!userTouchedRef.current.model) {
          setModel(next.model ?? next.availableModels[0]?.value ?? referenceSession?.model ?? "");
        }
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
  }, [connected, effectiveHostId, onLoadSessionConfiguration, referenceSession?.sessionId, runtimeAvailable]);

  useEffect(() => {
    if (!sectionCreate) return;
    return registerMobileBackHandler(() => {
      if (!sectionCreate.busy) setSectionCreate(undefined);
      return true;
    }, 160);
  }, [sectionCreate]);

  useEffect(() => {
    if (!pendingBypassConfirm) return;
    return registerMobileBackHandler(() => {
      if (pendingBypassConfirm) {
        setPendingBypassConfirm(false);
        return true;
      }
      return false;
    }, 155);
  }, [pendingBypassConfirm]);

  const modelOptions = useMemo(() => {
    const all = configuration?.availableModels ?? [];
    if (all.length > 0) return all;
    if (referenceSession?.model) {
      return [{
        value: referenceSession.model,
        displayName: referenceSession.modelDisplayName ?? referenceSession.model,
      }];
    }
    return [];
  }, [configuration?.availableModels, referenceSession?.model, referenceSession?.modelDisplayName]);

  const selectedModel = useMemo(
    () => modelOptions.find((candidate) => candidate.value === model),
    [model, modelOptions],
  );

  const reasoningEfforts = configuration?.availableReasoningEfforts;
  const effortLevels = modelEffortLevels(selectedModel,
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
  const canSubmitBase = connected && runtimeAvailable && !groupUnavailable && !locked;

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

  function chooseModel(nextModelValue: string): void {
    userTouchedRef.current.model = true;
    setModel(nextModelValue);
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
    userTouchedRef.current.permission = true;
    setPermissionMode(nextMode);
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
    if (!connected || locked) return;
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

    // The created session can display a catalog fallback before Desktop applies a model.
    const needsModel = Boolean(
      model && (userTouchedRef.current.model || (created.model && model !== created.model)),
    );
    const needsEffort = pickedEffort !== undefined && pickedEffort !== createdEffort;
    const needsPermission = Boolean(permissionMode && permissionMode !== createdPermission);
    const needsOutputStyle = outputStyle && outputStyle !== created.outputStyle;

    if (!needsModel && !needsEffort && !needsPermission && !needsOutputStyle) {
      return undefined;
    }

    return {
      ...(needsModel ? { model } : {}),
      ...(needsEffort ? { effort: pickedEffort } : {}),
      ...(needsPermission ? { permissionMode } : {}),
      ...(needsOutputStyle ? { outputStyle } : {}),
    };
  }

  async function executeCreate(withPrompt: boolean, trustWorkspace = false): Promise<void> {
    const trimmedPrompt = prompt.trim();
    const trimmedTitle = sessionTitle.trim() || undefined;
    if (!canSubmitBase) return;
    if (withPrompt && !trimmedPrompt) return;
    const trimmedCwd = selectedCwd.trim();
    if (!trimmedCwd) {
      onOpenDirectoryPicker({
        initialProjectId: selectedProjectId || undefined,
        ...(withPrompt && trimmedPrompt ? { pendingPrompt: trimmedPrompt } : {}),
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
    try {
      const selectedGroup = selectedProjectId || undefined;
      const created = trustWorkspace
        ? await onCreateSession(trimmedCwd, trimmedTitle, runtimeId, selectedGroup, true)
        : await onCreateSession(trimmedCwd, trimmedTitle, runtimeId, selectedGroup);
      if (!created) {
        setTrustState(undefined);
        setError("会话未创建，请重试。");
        return;
      }
      setTrustState(undefined);

      let configurationError: string | undefined;
      if (onConfigureSession && canConfigureRuntime) {
        const change = buildPostCreateConfiguration(created);
        if (change) {
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
        }
      }

      setSessionTitle("");
      if (withPrompt) {
        drafts.resetSession(effectiveHostId, NEW_CHAT_DRAFT_SESSION_ID);
      }
      await onSessionCreated?.(created, {
        ...(withPrompt && trimmedPrompt ? { initialPrompt: trimmedPrompt } : {}),
        ...(configurationError ? {
          configurationError: withPrompt ? `首条消息未发送。${configurationError}` : configurationError,
        } : {}),
      });
    } catch (reason) {
      const { isTrust, code } = isWorkspaceTrustError(reason);
      if (isTrust) {
        setTrustState({
          mode: code === "WORKSPACE_TRUST_REQUIRED" && canTrustWorkspace ? "confirm" : "manual",
          withPrompt,
        });
      } else {
        setTrustState(undefined);
        setError(reason instanceof Error ? reason.message : "会话创建失败");
      }
    } finally {
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
                disabled={!connected || locked}
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
                        disabled={!connected || locked}
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
                  disabled={!connected || locked}
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
                value={sessionTitle}
                disabled={!connected || locked}
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
                value={model}
                placeholder={configLoading ? "正在读取模型…" : "默认"}
                disabled={!connected || locked || modelOptions.length === 0}
                options={modelOptions.map((candidate) => ({
                  value: candidate.value,
                  label: sanitizeModelDisplayName(candidate.displayName, candidate.resolvedModel ?? candidate.value),
                  meta: quota?.snapshot ? (modelQuotaLabel(quota.snapshot, candidate) || undefined) : undefined,
                }))}
                onChange={chooseModel}
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
                      disabled={!connected || locked || configLoading}
                      onClick={() => setEffortDraft(level)}
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
                disabled={!connected || locked}
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
                  disabled={!connected || locked}
                  options={[
                    { value: "", label: "默认" },
                    ...outputStyles.filter((style) => style !== "default").map((style) => ({ value: style, label: style })),
                  ]}
                  onChange={setOutputStyle}
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
        {error && <div className="composer-error" role="alert">{error}</div>}
        <form
          className="composer-form"
          onSubmit={(event) => {
            event.preventDefault();
            void executeCreate(true, false);
          }}
        >
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
              <IconButton
                label="选择工作目录"
                className="composer-attach-trigger"
                disabled={!connected || locked}
                onClick={() => void handleChooseDirectory()}
              >
                <Plus size={16} />
              </IconButton>
            </div>
            <div className="composer-bar-right">
              <button
                type="button"
                className="secondary-button new-chat-empty-create-btn"
                disabled={!canSubmitBase}
                onClick={() => void executeCreate(false, false)}
              >
                创建空会话
              </button>
              <button
                type="submit"
                className="primary-button send-button"
                aria-label="发送"
                disabled={!canSubmitBase || !prompt.trim()}
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
        open={pendingBypassConfirm}
        title="启用完全授权"
        description="新创建的 Claude Desktop 会话将跳过工具授权确认。此设置由 Desktop 管理。"
        confirmLabel="启用完全授权"
        onCancel={() => setPendingBypassConfirm(false)}
        onConfirm={() => {
          setPendingBypassConfirm(false);
          userTouchedRef.current.permission = true;
          setPermissionMode("bypassPermissions");
        }}
      />
    </section>
  );
}
