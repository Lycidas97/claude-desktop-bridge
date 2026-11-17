import type {
  BridgeDesktopRuntimeId,
  BridgeEffort,
  BridgeHostSnapshot,
  BridgeProjectInfo,
  BridgeSDKPermissionMode,
  BridgeSessionConfiguration,
  BridgeSessionInfo,
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
} from "../mobile/MobileInspectorCallout.js";
import { MobilePageHeader } from "../mobile/MobilePageHeader.js";
import "./new-chat-canvas.css";
import {
  PERMISSION_MODE_OPTIONS,
  effortLabel,
  supportedEffort,
  type SessionConfigurationChange,
} from "./SessionConfigurationDialog.js";

export const NEW_CHAT_DRAFT_SESSION_ID = "__new__";
const DEFAULT_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

function formatDisplayDirectory(path: string | undefined): string {
  const trimmed = typeof path === "string" ? path.trim() : "";
  if (!trimmed) return "选择工作目录…";
  const macMatch = /^\/Users\/[^/]+(\/.*)$/u.exec(trimmed);
  if (macMatch) return `~${macMatch[1]}`;
  const linuxMatch = /^\/home\/[^/]+(\/.*)$/u.exec(trimmed);
  if (linuxMatch) return `~${linuxMatch[1]}`;
  return trimmed;
}

function asBridgeEffort(value: string | undefined): BridgeEffort | undefined {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max"
    ? value
    : undefined;
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
  onQuickStart?(cwd: string, prompt: string, projectId?: string, title?: string): Promise<void>;
  onActivateClaude?: (() => Promise<void>) | undefined;
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
  onLoadSessionConfiguration,
  onConfigureSession,
  onCreateSession,
  onSessionCreated,
  onQuickStart,
  onActivateClaude,
}: NewChatCanvasProps) {
  const runtimeId = "claude-desktop";
  const effectiveHostId = hostId ?? snapshot?.host.hostId;
  const fallbackDrafts = useConversationDrafts(effectiveHostId);
  const drafts = externalDrafts ?? fallbackDrafts;
  const newChatDraft = drafts.session(effectiveHostId, NEW_CHAT_DRAFT_SESSION_ID);
  const prompt = typeof newChatDraft.draft.text === "string" ? newChatDraft.draft.text : "";

  const projects: readonly BridgeProjectInfo[] = (snapshot?.projects ?? []).filter(
    (project) => (project.runtimeId ?? runtimeId) === runtimeId,
  );
  const manualGroups = projects.filter((project) => project.kind === "desktop-group");
  const activeClaudeSessions = [...(snapshot?.sessions ?? [])]
    .filter((candidate) => !candidate.archivedAt && (candidate.runtimeId ?? runtimeId) === runtimeId)
    .sort((left, right) => right.lastActivityAt - left.lastActivityAt);

  const defaultFolderProject = [...projects]
    .filter((project) => Boolean(project.cwd?.trim()))
    .sort((left, right) => right.lastActivityAt - left.lastActivityAt)[0];

  const explicitTargetProject = initialProjectId !== undefined
    ? projects.find((project) => project.projectId === initialProjectId)
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
      .filter((candidate) => (candidate.runtimeId ?? runtimeId) === runtimeId)
      .sort((left, right) => right.lastActivityAt - left.lastActivityAt)
      .find((candidate) => Boolean(
        candidate.model
        || candidate.modelDisplayName
        || candidate.effort
        || candidate.reasoningEffort
        || candidate.nativePermissionMode,
      )),
    [snapshot?.sessions],
  );

  const [configuration, setConfiguration] = useState<BridgeSessionConfiguration>();
  const [configLoading, setConfigLoading] = useState(false);
  const [provider, setProvider] = useState<string>(() => referenceSession?.provider ?? "");
  const [model, setModel] = useState<string>(() => referenceSession?.model ?? "");
  const [effort, setEffort] = useState<string>(
    () => referenceSession?.reasoningEffort ?? referenceSession?.effort ?? "high",
  );
  const [fast, setFast] = useState<boolean>(false);
  const [permissionMode, setPermissionMode] = useState<BridgeSDKPermissionMode>(
    () => referenceSession?.nativePermissionMode ?? "default",
  );
  const [pendingBypassConfirm, setPendingBypassConfirm] = useState(false);
  const [quotaRequested, setQuotaRequested] = useState(false);

  const userTouchedRef = useRef({
    cwd: false,
    section: initialProjectId !== undefined,
    model: false,
    effort: false,
    permission: false,
    provider: false,
    fast: false,
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

  const activeTrustMode = trustState?.mode === "confirm" && !canTrustWorkspace
    ? "manual"
    : trustState?.mode;

  useEffect(() => {
    if (!connected || !runtimeAvailable || !canConfigureRuntime || !onLoadSessionConfiguration) return;
    let active = true;
    setConfigLoading(true);
    const loadConfig = async (): Promise<BridgeSessionConfiguration | undefined> => {
      try {
        const primary = await Promise.resolve(onLoadSessionConfiguration("__default__"));
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
        if (!userTouchedRef.current.provider) {
          setProvider(next.provider ?? next.availableProviders?.[0]?.value ?? "");
        }
        if (!userTouchedRef.current.model) {
          setModel(next.model ?? next.availableModels[0]?.value ?? referenceSession?.model ?? "");
        }
        if (!userTouchedRef.current.effort) {
          setEffort(
            next.reasoningEffort
            ?? next.effort
            ?? next.availableReasoningEfforts?.[0]
            ?? next.availableEffortLevels[0]
            ?? referenceSession?.reasoningEffort
            ?? referenceSession?.effort
            ?? "high",
          );
        }
        if (!userTouchedRef.current.fast) {
          setFast(next.fast ?? false);
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
    if (all.length > 0) {
      if (!provider) return all;
      const scoped = all.filter((candidate) => !candidate.provider || candidate.provider === provider);
      return scoped.length > 0 ? scoped : all;
    }
    if (referenceSession?.model) {
      return [{
        value: referenceSession.model,
        displayName: referenceSession.modelDisplayName ?? referenceSession.model,
      }];
    }
    return [];
  }, [configuration?.availableModels, provider, referenceSession?.model, referenceSession?.modelDisplayName]);

  const selectedModel = useMemo(
    () => modelOptions.find((candidate) => candidate.value === model),
    [model, modelOptions],
  );

  const effortLevels = selectedModel?.supportedEffortLevels?.length
    ? selectedModel.supportedEffortLevels
    : configuration?.availableReasoningEfforts?.length
      ? configuration.availableReasoningEfforts
      : configuration?.availableEffortLevels?.length
        ? configuration.availableEffortLevels
        : DEFAULT_EFFORT_LEVELS;

  const shownEffort = supportedEffort(effort, effortLevels);
  const fastSupported = Boolean(configuration?.supportsFastMode && selectedModel?.supportsFast !== false);

  const groupUnavailable = Boolean(
    selectedProjectId && !manualGroups.some((project) => project.projectId === selectedProjectId),
  );
  const locked = busy || choosingDirectory;
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
  const showSectionSelect = manualGroups.length > 0 || groupUnavailable;

  function setPrompt(value: string): void {
    newChatDraft.setText(value);
  }

  function chooseModel(nextModelValue: string): void {
    userTouchedRef.current.model = true;
    setModel(nextModelValue);
    const nextOption = modelOptions.find((candidate) => candidate.value === nextModelValue);
    if (nextOption?.provider) {
      userTouchedRef.current.provider = true;
      setProvider(nextOption.provider);
    }
    if (nextOption?.supportsFast === false) setFast(false);
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
    const desiredEffort = selectedModel?.supportsEffort !== false && effortLevels.length > 0
      ? asBridgeEffort(shownEffort)
      : undefined;
    const createdEffort = created.effort ?? asBridgeEffort(created.reasoningEffort);
    const createdPermission = created.nativePermissionMode ?? "default";

    const needsModel = Boolean(
      model && (created.model ? model !== created.model : userTouchedRef.current.model),
    );
    const needsEffort = Boolean(
      desiredEffort && (createdEffort ? desiredEffort !== createdEffort : userTouchedRef.current.effort),
    );
    const needsPermission = Boolean(permissionMode && permissionMode !== createdPermission);
    const needsProvider = Boolean(
      configuration?.availableProviders?.length
      && provider
      && provider !== (created.provider ?? ""),
    );
    const needsFast = Boolean(configuration?.supportsFastMode && fastSupported && fast);

    if (!needsModel && !needsEffort && !needsPermission && !needsProvider && !needsFast) {
      return undefined;
    }

    return {
      ...(needsModel ? { model } : {}),
      ...(needsProvider ? { provider: provider || null } : {}),
      ...(needsEffort && desiredEffort ? { effort: desiredEffort } : {}),
      ...(needsFast ? { fast: true } : {}),
      ...(needsPermission ? { permissionMode } : {}),
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
      if (!onQuickStart || !withPrompt) {
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
        await onQuickStart(trimmedCwd, trimmedPrompt, selectedProjectId || undefined, trimmedTitle);
        setSessionTitle("");
        drafts.resetSession(effectiveHostId, NEW_CHAT_DRAFT_SESSION_ID);
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
              configurationError = "所选授权模式未生效，请检查会话设置后再发送。";
            }
          } catch (configReason) {
            configurationError = configReason instanceof Error ? configReason.message : "会话配置应用失败";
          }
        }
      }

      setSessionTitle("");
      if (withPrompt) {
        drafts.resetSession(effectiveHostId, NEW_CHAT_DRAFT_SESSION_ID);
      }
      await onSessionCreated?.(created, {
        ...(withPrompt && trimmedPrompt ? { initialPrompt: trimmedPrompt } : {}),
        ...(configurationError ? { configurationError } : {}),
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
        (project) => project.projectId === "claude-unsectioned" || project.kind !== "desktop-group",
      );
      if (unsectionedProject?.cwd?.trim()) return unsectionedProject.cwd.trim();
      return activeClaudeSessions.find(
        (candidate) => candidate.projectId === "claude-unsectioned" && Boolean(candidate.cwd?.trim()),
      )?.cwd.trim();
    }
    const matched = manualGroups.find((project) => project.projectId === nextGroupId);
    if (matched?.cwd?.trim()) return matched.cwd.trim();
    return activeClaudeSessions.find(
      (candidate) => candidate.projectId === nextGroupId && Boolean(candidate.cwd?.trim()),
    )?.cwd.trim();
  }

  const remoteActivation = resolveClaudeRemoteActivationStatus(snapshot);
  const showMobileInspectorCallout = Boolean(
    mobile && connected && snapshot && remoteActivation.nativeUnavailable && onActivateClaude,
  );

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
          {showMobileInspectorCallout && (
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
                    { value: "", label: "未分组" },
                    ...(groupUnavailable ? [{ value: selectedProjectId, label: "分组已不可用", disabled: true }] : []),
                    ...manualGroups.map((project) => ({ value: project.projectId, label: project.name })),
                  ]}
                  onChange={(nextGroupId) => {
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
                placeholder={configLoading ? "正在读取模型…" : "跟随 Claude Desktop 默认"}
                disabled={!connected || locked || modelOptions.length === 0}
                options={modelOptions.map((candidate) => ({
                  value: candidate.value,
                  label: sanitizeModelDisplayName(candidate.displayName, candidate.resolvedModel ?? candidate.value),
                  meta: quota?.snapshot ? (modelQuotaLabel(quota.snapshot, candidate) || undefined) : undefined,
                }))}
                onChange={chooseModel}
              />
            </div>

            {selectedModel?.supportsEffort !== false && effortLevels.length > 0 && (
              <div className="new-chat-config-row">
                <span className="new-chat-config-label">思考强度</span>
                <div className="effort-segments new-chat-effort-segments" role="group" aria-label="思考强度">
                  {effortLevels.map((level) => (
                    <button
                      type="button"
                      key={level}
                      className={shownEffort === level ? "active" : ""}
                      aria-pressed={shownEffort === level}
                      disabled={!connected || locked}
                      onClick={() => {
                        userTouchedRef.current.effort = true;
                        setEffort(level);
                      }}
                    >
                      {effortLabel(level)}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="new-chat-config-row">
              <span className="new-chat-config-label">授权模式</span>
              <SelectMenu<BridgeSDKPermissionMode>
                ariaLabel="授权模式"
                value={permissionMode}
                disabled={!connected || locked}
                options={PERMISSION_MODE_OPTIONS}
                onChange={choosePermissionMode}
              />
            </div>
          </div>

          {groupUnavailable && (
            <p className="session-create-error new-chat-inline-alert" role="alert">所选分组已不可用，请重新选择。</p>
          )}
          {connected && !runtimeAvailable && !showMobileInspectorCallout && (
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
