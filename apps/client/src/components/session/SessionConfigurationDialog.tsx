import {
  type BridgeEffort,
  type BridgeModelInfo,
  type BridgeSDKPermissionMode,
  type BridgeSessionConfiguration,
  type BridgeSessionInfo,
} from "@bridge/protocol";
import { LoaderCircle, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { MagpieModelQuota, useOptionalMagpieQuota } from "../../../../../plugins/magpie-quota/client.js";
import { modelQuotaLabel } from "../../../../../plugins/magpie-quota/presentation.js";
import { sanitizeModelDisplayName } from "../../lib/conversation-timeline.js";
import { registerMobileBackHandler } from "../../lib/mobile-back-navigation.js";
import { ConfirmationDialog } from "../common/ConfirmationDialog.js";
import { IconButton } from "../common/IconButton.js";
import { SelectMenu } from "../common/SelectMenu.js";
import { formatContextPercentage, formatContextTokens } from "../conversation/SessionActivityIndicator.js";
import { trapModalTabKey } from "./SectionCreateDialog.js";
import { PERMISSION_MODE_OPTIONS, effortLabel } from "./session-labels.js";

export function modelEffortLevels(model: BridgeModelInfo | undefined, fallback: readonly BridgeEffort[]): readonly BridgeEffort[] {
  return model?.supportsEffort === false ? []
    : model?.declaredEffortLevels ? model.supportedEffortLevels ?? []
    : model?.supportedEffortLevels?.length ? model.supportedEffortLevels : fallback;
}

export interface SessionConfigurationChange {
  model?: string | null;
  effort?: BridgeEffort | null;
  permissionMode?: BridgeSDKPermissionMode;
  outputStyle?: string;
}

export function SessionConfigurationDialog({
  session,
  revision,
  modelAndEffortOnly = false,
  manageFocus = false,
  onLoad,
  onSave,
  onClose,
}: {
  session: BridgeSessionInfo;
  revision?: string | number;
  modelAndEffortOnly?: boolean;
  /** Keyboard-opened desktop overlays take focus, trap Tab and close on Escape. */
  manageFocus?: boolean;
  onLoad(): Promise<BridgeSessionConfiguration>;
  onSave(change: SessionConfigurationChange): Promise<BridgeSessionConfiguration>;
  onClose(): void;
}) {
  const [configuration, setConfiguration] = useState<BridgeSessionConfiguration>();
  const [model, setModel] = useState("");
  // undefined keeps the loaded effort; null picks 默认 and clears it.
  const [effortDraft, setEffortDraft] = useState<BridgeEffort | null>();
  const [nativePermissionMode, setNativePermissionMode] = useState<BridgeSDKPermissionMode>();
  const [outputStyle, setOutputStyle] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [confirmFullAccess, setConfirmFullAccess] = useState(false);
  const [error, setError] = useState<string>();
  const dialogRef = useRef<HTMLElement>(null);
  const claudeSession = !session.runtimeId || session.runtimeId === "claude-desktop";
  // Quota lookup is independent of Claude Desktop's native execution channel.
  const quotaState = useOptionalMagpieQuota(claudeSession);
  const quota = claudeSession ? quotaState : undefined;

  useEffect(() => {
    let active = true;
    setLoading(true);
    setConfirmFullAccess(false);
    void onLoad()
      .then((next) => {
        if (!active) return;
        setConfiguration(next);
        setModel(next.model ?? next.availableModels[0]?.value ?? "");
        setEffortDraft(undefined);
        setNativePermissionMode(next.nativePermissionMode);
        setOutputStyle(next.outputStyle);
        setError(undefined);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : "会话配置读取失败");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [session.sessionId, revision]);

  useEffect(() => {
    if (!manageFocus) return;
    const dialog = dialogRef.current;
    const opener = document.activeElement as HTMLElement | null;
    dialog?.focus();
    return () => {
      const active = document.activeElement;
      if (opener?.isConnected && (!active || active === document.body || Boolean(dialog?.contains(active)))) opener.focus();
    };
  }, [manageFocus]);

  useEffect(() => {
    if (!confirmFullAccess) return;
    return registerMobileBackHandler(() => {
      if (!saving) setConfirmFullAccess(false);
      return true;
    }, 150);
  }, [confirmFullAccess, saving]);

  const modelOptions = configuration?.availableModels ?? [];
  const configurablePermission = !modelAndEffortOnly && claudeSession ? configuration?.nativePermissionMode : undefined;
  const outputStyles = modelAndEffortOnly ? [] : configuration?.availableOutputStyles ?? [];
  const loadReadyStyles = !modelAndEffortOnly && !loading && configuration && outputStyles.length === 0 && session.outputStyleCatalogReady === true;
  useEffect(() => {
    if (!loadReadyStyles) return;
    let active = true;
    void onLoad()
      .then(({ availableOutputStyles, outputStyle }) => {
        if (!active || !availableOutputStyles?.length) return;
        setConfiguration((current) => {
          if (!current) return current;
          const { outputStyle: _previous, ...settings } = current;
          return { ...settings, availableOutputStyles, ...(outputStyle ? { outputStyle } : {}) };
        });
        setOutputStyle(outputStyle);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : "输出风格读取失败");
      });
    return () => { active = false; };
  }, [session.sessionId, loadReadyStyles]);

  const selectedModel = useMemo(
    () => modelOptions.find((candidate) => candidate.value === model),
    [model, modelOptions],
  );
  const effortLevels = modelEffortLevels(selectedModel, configuration?.availableEffortLevels ?? []);
  const modelChanged = modelOptions.length > 0 && model !== (configuration?.model ?? modelOptions[0]?.value);
  const configuredEffort = modelChanged ? undefined : configuration?.effort;
  const pickedEffort = effortDraft && effortLevels.includes(effortDraft) ? effortDraft : undefined;
  const shownEffort = effortDraft === null ? undefined : pickedEffort ?? configuredEffort;

  async function save(change: SessionConfigurationChange): Promise<void> {
    if (saving) return;
    setSaving(true);
    setError(undefined);
    try {
      const next = await onSave(change);
      setConfiguration(next);
      setModel(next.model ?? next.availableModels[0]?.value ?? "");
      setEffortDraft(undefined);
      setNativePermissionMode(next.nativePermissionMode);
      setOutputStyle(next.outputStyle);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "会话配置保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function saveSelectedConfiguration(): Promise<void> {
    const change: SessionConfigurationChange = {
      ...(modelChanged ? { model } : {}),
      ...(!modelAndEffortOnly && outputStyle && outputStyle !== configuration?.outputStyle ? { outputStyle } : {}),
      ...(pickedEffort && pickedEffort !== configuredEffort ? { effort: pickedEffort } : {}),
      // An explicit 默认 resets the session's own effort, even when a model change hides it.
      ...(effortDraft === null && configuration?.effort ? { effort: null } : {}),
      ...(configurablePermission && nativePermissionMode && nativePermissionMode !== configurablePermission
        ? { permissionMode: nativePermissionMode } : {}),
    };
    if (Object.keys(change).length) await save(change);
    else onClose();
  }

  const appliesAfterTurn = session.turnState === "running" || configuration?.appliesAfterTurn;
  return (
    <div
      className="modal-backdrop session-configuration-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="session-configuration-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-configuration-title"
        tabIndex={manageFocus ? -1 : undefined}
        onKeyDown={manageFocus ? (event) => {
          // The full-access confirmation handles its own keys.
          if (confirmFullAccess) return;
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            if (!saving) onClose();
          } else trapModalTabKey(event, event.currentTarget);
        } : undefined}
      >
        <header>
          <h2 id="session-configuration-title">{session.title}</h2>
          <IconButton label="关闭" onClick={onClose}><X size={19} /></IconButton>
        </header>

        {loading ? (
          <div className="session-configuration-loading">
            <LoaderCircle className="is-spinning" size={19} />
            正在读取 Claude Desktop 配置
          </div>
        ) : (
          <>
            {modelOptions.length > 0 && (
              <div className="session-model-field">
                <span>模型</span>
                <SelectMenu
                  ariaLabel="模型"
                  value={model}
                  disabled={!modelOptions.length}
                  options={modelOptions.map((candidate) => ({
                    value: candidate.value,
                    label: sanitizeModelDisplayName(candidate.displayName, candidate.resolvedModel ?? candidate.value),
                    meta: quota?.snapshot ? (modelQuotaLabel(quota.snapshot, candidate) || undefined) : undefined,
                  }))}
                  onChange={setModel}
                />
                {(selectedModel?.description || !configuration?.modelsComplete) && (
                  <small>{selectedModel?.description || "仅显示当前电脑已发现的模型"}</small>
                )}
              </div>
            )}
            {quota && selectedModel && <MagpieModelQuota model={selectedModel} />}

            {effortLevels.length > 0 && (
              <fieldset className="session-effort-field">
                <legend>
                  思考强度{shownEffort && !effortLevels.includes(shownEffort) ? ` · ${effortLabel(shownEffort)}` : ""}
                </legend>
                <div className="effort-segments">
                  {[null, ...effortLevels].map((level) => (
                    <button
                      type="button"
                      className={(shownEffort ?? null) === level ? "active" : ""}
                      aria-pressed={(shownEffort ?? null) === level}
                      onClick={() => setEffortDraft(level)}
                      key={level ?? "default"}
                    >
                      {level ? effortLabel(level) : "默认"}
                    </button>
                  ))}
                </div>
              </fieldset>
            )}

            {configurablePermission && (
              <div className="session-model-field">
                <span>权限模式</span>
                <SelectMenu<BridgeSDKPermissionMode>
                  ariaLabel="权限模式"
                  value={nativePermissionMode ?? configurablePermission}
                  options={PERMISSION_MODE_OPTIONS}
                  onChange={(nextMode) => setNativePermissionMode(nextMode)}
                />
              </div>
            )}

            {!modelAndEffortOnly && (outputStyles.length > 0 || outputStyle) && (
              <div className="session-model-field">
                <span>输出风格</span>
                <SelectMenu
                  ariaLabel="输出风格"
                  value={outputStyle ?? ""}
                  placeholder={outputStyle && outputStyle !== "default" ? outputStyle : "默认"}
                  options={outputStyles.map((style) => ({ value: style, label: style === "default" ? "默认" : style }))}
                  disabled={saving || !outputStyles.length}
                  onChange={setOutputStyle}
                />
              </div>
            )}

            {configuration?.context && configuration.context.totalTokens > 0 && (() => {
              const context = configuration.context;
              const hasCapacity = typeof context.maxTokens === "number" && context.maxTokens > 0
                && typeof context.percentage === "number" && Number.isFinite(context.percentage);
              return (
                <div className="session-context-usage">
                  <div>
                    <span>上下文</span>
                    <strong>
                      {formatContextTokens(context.totalTokens)}
                      {hasCapacity && (
                        <small> / {formatContextTokens(context.maxTokens!)} · {formatContextPercentage(context.percentage!)}</small>
                      )}
                    </strong>
                  </div>
                  {hasCapacity && (
                    <div
                      className="session-context-track"
                      role="progressbar"
                      aria-label="上下文使用量"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.round(context.percentage!)}
                    >
                      <i style={{ width: `${Math.min(100, Math.max(0, context.percentage!))}%` }} />
                    </div>
                  )}
                </div>
              );
            })()}

            {appliesAfterTurn && <div className="session-configuration-notice">当前任务不会中断，修改从下一轮生效。</div>}
            {error && <div className="session-configuration-error" role="alert">{error}</div>}

            <footer>
              <button
                type="button"
                className="primary-button"
                disabled={saving || (!modelOptions.length && !effortLevels.length && !configurablePermission && !outputStyles.length)}
                onClick={() => {
                  if (configurablePermission && nativePermissionMode === "bypassPermissions" && configurablePermission !== "bypassPermissions") setConfirmFullAccess(true);
                  else void saveSelectedConfiguration();
                }}
              >
                {saving && <LoaderCircle className="is-spinning" size={16} />}
                {appliesAfterTurn ? "应用到下一轮" : "保存配置"}
              </button>
            </footer>
          </>
        )}
      </section>
      <ConfirmationDialog
        open={confirmFullAccess}
        title="启用完全授权"
        description="当前 Claude Desktop 会话将跳过工具授权确认。此设置由 Desktop 管理。"
        confirmLabel="启用完全授权"
        busy={saving}
        onCancel={() => setConfirmFullAccess(false)}
        onConfirm={() => {
          setConfirmFullAccess(false);
          void saveSelectedConfiguration();
        }}
      />
    </div>
  );
}
