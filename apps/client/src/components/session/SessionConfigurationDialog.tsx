import type {
  BridgeEffort,
  BridgeModelInfo,
  BridgeSDKPermissionMode,
  BridgeSessionConfiguration,
  BridgeSessionInfo,
} from "@bridge/protocol";
import { LoaderCircle, Settings2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { MagpieModelQuota, useOptionalMagpieQuota } from "../../../../../plugins/magpie-quota/client.js";
import { modelQuotaLabel } from "../../../../../plugins/magpie-quota/presentation.js";
import { sanitizeModelDisplayName } from "../../lib/conversation-timeline.js";
import { registerMobileBackHandler } from "../../lib/mobile-back-navigation.js";
import { ConfirmationDialog } from "../common/ConfirmationDialog.js";
import { IconButton } from "../common/IconButton.js";
import { SelectMenu } from "../common/SelectMenu.js";
import { formatContextPercentage, formatContextTokens } from "../conversation/SessionActivityIndicator.js";

const EFFORT_LABELS: Record<string, string> = {
  none: "关闭",
  minimal: "最小",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最大",
  ultra: "超高",
};

export function effortLabel(value: string): string {
  return Object.hasOwn(EFFORT_LABELS, value) ? EFFORT_LABELS[value]! : value;
}

export function modelEffortOptions(model: BridgeModelInfo | undefined, fallback: readonly BridgeEffort[]) {
  const declared = model?.declaredEffortLevels;
  const levels = model?.supportsEffort === false ? []
    : declared ? model.supportedEffortLevels ?? []
    : model?.supportedEffortLevels?.length ? model.supportedEffortLevels : fallback;
  const unavailable = declared?.filter(level => !levels.some(option => option === level)).map(effortLabel).join("、");
  return { levels, unavailable: unavailable ? `当前模型不可用：${unavailable}` : undefined };
}

export const PERMISSION_MODE_OPTIONS: ReadonlyArray<{ value: BridgeSDKPermissionMode; label: string }> = [
  { value: "default", label: "默认" },
  { value: "acceptEdits", label: "允许文件修改" },
  { value: "plan", label: "计划模式" },
  { value: "auto", label: "自动模式" },
  { value: "dontAsk", label: "不询问" },
  { value: "bypassPermissions", label: "完全授权" },
];

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
  onLoad,
  onSave,
  onClose,
}: {
  session: BridgeSessionInfo;
  revision?: string | number;
  modelAndEffortOnly?: boolean;
  onLoad(): Promise<BridgeSessionConfiguration>;
  onSave(change: SessionConfigurationChange): Promise<BridgeSessionConfiguration>;
  onClose(): void;
}) {
  const [configuration, setConfiguration] = useState<BridgeSessionConfiguration>();
  const [model, setModel] = useState("");
  const [effortDraft, setEffortDraft] = useState<BridgeEffort>();
  const [nativePermissionMode, setNativePermissionMode] = useState<BridgeSDKPermissionMode>();
  const [outputStyle, setOutputStyle] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [confirmFullAccess, setConfirmFullAccess] = useState(false);
  const [error, setError] = useState<string>();
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
  const { levels: effortLevels, unavailable: unavailableEffort } = modelEffortOptions(selectedModel, configuration?.availableEffortLevels ?? []);
  const modelChanged = modelOptions.length > 0 && model !== (configuration?.model ?? modelOptions[0]?.value);
  const configuredEffort = modelChanged ? undefined : configuration?.effort;
  const pickedEffort = effortDraft && effortLevels.includes(effortDraft) ? effortDraft : undefined;
  const shownEffort = pickedEffort ?? configuredEffort;

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
      <section className="session-configuration-dialog" role="dialog" aria-modal="true" aria-labelledby="session-configuration-title">
        <header>
          <div>
            <span><Settings2 size={15} />会话设置</span>
            <h2 id="session-configuration-title">{session.title}</h2>
          </div>
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
                <small>
                  {selectedModel?.description
                    || (!configuration?.modelsComplete
                      ? "仅显示当前主机已发现的模型"
                      : sanitizeModelDisplayName(model, selectedModel?.resolvedModel))}
                </small>
                {configuration && (
                  <small>
                    配置来源：{{ bridge: "当前会话", "claude-desktop": "Claude Desktop", project: "项目配置", default: "电脑默认" }[configuration.modelSource]}
                  </small>
                )}
              </div>
            )}
            {quota && selectedModel && <MagpieModelQuota model={selectedModel} />}

            {(effortLevels.length > 0 || unavailableEffort) && (
              <fieldset className="session-effort-field">
                <legend>
                  思考强度{(shownEffort || effortLevels.length > 0) && !effortLevels.some(level => level === shownEffort)
                    ? ` · ${shownEffort ? effortLabel(shownEffort) : "默认"}` : ""}
                </legend>
                {effortLevels.length > 0 && (
                  <div className="effort-segments">
                    {effortLevels.map((level) => (
                      <button
                        type="button"
                        className={shownEffort === level ? "active" : ""}
                        aria-pressed={shownEffort === level}
                        onClick={() => setEffortDraft(level)}
                        key={level}
                      >
                        {effortLabel(level)}
                      </button>
                    ))}
                  </div>
                )}
                {unavailableEffort && <small className="effort-unavailable">{unavailableEffort}</small>}
              </fieldset>
            )}

            {configurablePermission && (
              <div className="session-model-field">
                <span>Desktop 授权模式</span>
                <SelectMenu<BridgeSDKPermissionMode>
                  ariaLabel="Desktop 授权模式"
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
