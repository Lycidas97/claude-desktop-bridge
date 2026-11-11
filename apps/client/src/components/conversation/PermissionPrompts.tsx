import type {
  BridgeDeliveryState,
  BridgeInteractivePrompt,
  BridgeNativePermissionMode,
  BridgePermissionInfo,
} from "@bridge/protocol";
import { AlertTriangle, Check, FilePenLine, LoaderCircle, ShieldCheck, Terminal, Wrench } from "lucide-react";
import { useEffect, useState } from "react";
import { deliveryLabel } from "../../lib/conversation-timeline.js";
import { registerMobileBackHandler } from "../../lib/mobile-back-navigation.js";
import { ConfirmationDialog } from "../common/ConfirmationDialog.js";
import { MarkdownText } from "../common/MarkdownText.js";

export function matchingQuestionPermission(
  prompt: BridgeInteractivePrompt,
  permissions: BridgePermissionInfo[],
  toolUseId?: string,
): BridgePermissionInfo | undefined {
  const questions = prompt.questions;
  if (prompt.kind !== "question" || !questions?.length) return undefined;
  return permissions.find((permission) => permission.toolName === "AskUserQuestion"
    && (toolUseId === undefined || permission.toolUseId === toolUseId)
    && Array.isArray(permission.input.questions)
    && permission.input.questions.length === questions.length
    && permission.input.questions.every((question, index) => question.question === questions[index]!.question));
}

export function InteractivePromptCard({
  prompt,
  replyDelivery,
  replyPending = false,
  canSend = true,
  busy = false,
  unavailableReason,
  error,
  onSelectOption,
}: {
  prompt: BridgeInteractivePrompt;
  replyDelivery?: BridgeDeliveryState;
  replyPending?: boolean;
  canSend?: boolean;
  busy?: boolean;
  unavailableReason?: string;
  error?: string;
  onSelectOption?: (message: string) => void;
}) {
  const isWrapUp = prompt.kind === "wrap-up";
  const actions = prompt.actions ?? [];
  const questions = prompt.questions ?? [];
  const answered = Boolean(prompt.answered);
  const selectedAction = actions.find((action) => action.selected);
  const interactive = !answered && !unavailableReason && canSend && !busy && Boolean(onSelectOption);

  const badgeLabel = isWrapUp
    ? actions.length === 1
      ? "待确认操作"
      : actions.length > 1
        ? "下一步选项"
        : "待回答问题"
    : "提问与选择";

  return (
    <section
      className={`interactive-prompt-card ${answered ? "is-answered" : "is-pending"}`}
      aria-label={badgeLabel}
    >
      <div className="interactive-prompt-header">
        <span className={`interactive-prompt-badge ${answered ? "answered" : "pending"}`}>
          {answered ? <Check size={12} /> : null}
          <span>{badgeLabel}</span>
        </span>
        <span className="interactive-prompt-status">
          {answered
            ? replyPending
              ? "已提交，等待处理"
              : replyDelivery && !["session-received", "running", "completed"].includes(replyDelivery)
                ? replyDelivery === "host-received" || replyDelivery === "submitted" ? "回复已排队" : `回复${deliveryLabel(replyDelivery)}`
                : selectedAction ? `已选：${selectedAction.label}` : "已回复"
            : unavailableReason ?? (prompt.blocked
              ? "等待确认后继续"
              : "点击选项直接发送")}
        </span>
      </div>

      {error && <div className="permission-error" role="alert">{error}</div>}
      {prompt.recap && (
        <div className="interactive-prompt-recap">{prompt.recap}</div>
      )}

      {isWrapUp && prompt.ask && (
        <div className="interactive-prompt-ask">{prompt.ask}</div>
      )}

      {isWrapUp && actions.length > 0 && (
        <div className="interactive-prompt-options">
          {actions.map((action, idx) => {
            const isPrimary = idx === 0 && !answered;
            const showDetail = Boolean(action.message && action.message !== action.label);
            return (
              <button
                type="button"
                key={`${idx}:${action.label}`}
                className={`interactive-option-button ${isPrimary ? "is-primary" : ""}${action.selected ? " is-selected" : ""}`}
                disabled={!interactive}
                onClick={() => {
                  if (interactive && onSelectOption) {
                    onSelectOption(action.message || action.label);
                  }
                }}
              >
                <div className="interactive-option-top">
                  <strong className="interactive-option-label">{action.label}</strong>
                  {action.selected ? (
                    <span className="interactive-option-tag is-selected">
                      <Check size={11} /> 已选
                    </span>
                  ) : !answered && idx === 0 ? (
                    <span className="interactive-option-tag is-recommended">
                      {actions.length === 1 ? "确认" : "推荐"}
                    </span>
                  ) : null}
                </div>
                {showDetail && (
                  <small className="interactive-option-detail">{action.message}</small>
                )}
              </button>
            );
          })}
        </div>
      )}

      {!isWrapUp && questions.map((question, qIdx) => (
        <div className="interactive-question-block" key={`${qIdx}:${question.question}`}>
          <div className="interactive-prompt-ask">
            {question.header && (
              <span className="interactive-question-chip">{question.header}</span>
            )}
            <span>{question.question}</span>
          </div>
          <div className="interactive-prompt-options">
            {question.options.map((opt, optIdx) => (
              <button
                type="button"
                key={`${optIdx}:${opt.label}`}
                className={`interactive-option-button ${optIdx === 0 && !answered ? "is-primary" : ""}${opt.selected ? " is-selected" : ""}`}
                disabled={!interactive}
                onClick={() => {
                  if (interactive && onSelectOption) {
                    onSelectOption(opt.label);
                  }
                }}
              >
                <div className="interactive-option-top">
                  <strong className="interactive-option-label">{opt.label}</strong>
                  {opt.selected && (
                    <span className="interactive-option-tag is-selected">
                      <Check size={11} /> 已选
                    </span>
                  )}
                </div>
                {opt.description && (
                  <small className="interactive-option-detail">{opt.description}</small>
                )}
              </button>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

interface PermissionFact {
  label: string;
  value: string;
  code?: boolean;
}

export interface PermissionPresentation {
  summary: string;
  facts: PermissionFact[];
  preview?: {
    label: string;
    value: string;
  };
  raw: string;
  mutating: boolean;
}

function inputText(input: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n… 已省略 ${value.length - max} 个字符`;
}

export function permissionPresentation(permission: BridgePermissionInfo): PermissionPresentation {
  const tool = permission.toolName.toLocaleLowerCase();
  const mutating = /(write|edit|bash|delete|remove|move|notebook)/u.test(tool);
  const facts: PermissionFact[] = [];
  const path = inputText(permission.input, "file_path", "path", "notebook_path");
  const command = inputText(permission.input, "command");
  const cwd = inputText(permission.input, "cwd", "working_directory");
  const url = inputText(permission.input, "url");
  const query = inputText(permission.input, "query", "pattern");
  if (path) facts.push({ label: "目标", value: path, code: true });
  if (command) facts.push({ label: "命令", value: truncate(command, 600), code: true });
  if (cwd) facts.push({ label: "目录", value: cwd, code: true });
  if (url) facts.push({ label: "地址", value: url, code: true });
  if (query) facts.push({ label: "查询", value: truncate(query, 300) });

  const ignored = new Set([
    "file_path",
    "path",
    "notebook_path",
    "command",
    "cwd",
    "working_directory",
    "url",
    "query",
    "pattern",
    "content",
    "old_string",
    "new_string",
  ]);
  for (const [key, value] of Object.entries(permission.input)) {
    if (facts.length >= 5 || ignored.has(key)) continue;
    if (typeof value === "string" && value.trim()) {
      facts.push({ label: key, value: truncate(value.trim(), 240) });
    } else if (typeof value === "number" || typeof value === "boolean") {
      facts.push({ label: key, value: String(value) });
    }
  }

  const content = inputText(permission.input, "content", "new_string");
  const oldContent = inputText(permission.input, "old_string");
  const preview = content
    ? { label: oldContent ? "变更后预览" : "内容预览", value: truncate(content, 1_200) }
    : oldContent
      ? { label: "待替换内容", value: truncate(oldContent, 1_200) }
      : undefined;
  const serialized = JSON.stringify(permission.input, null, 2);
  return {
    summary: permission.description
      || permission.displayName
      || (mutating ? "这项操作会修改电脑上的项目内容" : "当前任务需要确认后才能继续"),
    facts,
    ...(preview ? { preview } : {}),
    raw: serialized,
    mutating,
  };
}

export function QuestionPrompt({
  permission,
  onResolve,
}: {
  permission: BridgePermissionInfo;
  onResolve(
    requestId: string,
    decision: "allow-once" | "allow-always" | "deny",
    message?: string,
    updatedInput?: Record<string, unknown>,
  ): Promise<void>;
}) {
  const questions = Array.isArray(permission.input.questions)
    ? permission.input.questions.filter((question): question is Record<string, unknown> => (
        Boolean(question) && typeof question === "object"
      ))
    : [];
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [customAnswers, setCustomAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const complete = questions.every((question) => (
    typeof question.question === "string" && Boolean(answers[question.question]?.length || customAnswers[question.question]?.trim())
  ));
  async function resolveQuestion(
    decision: "allow-once" | "deny",
    updatedInput?: Record<string, unknown>,
  ): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await onResolve(permission.requestId, decision, undefined, updatedInput);
    } catch (resolveError) {
      setError(resolveError instanceof Error ? resolveError.message : "回答提交失败");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="permission-prompt question-prompt">
      <div className="permission-title">
        <strong>{permission.title || "当前任务需要你的选择"}</strong>
        <span>任一已授权设备的首次回答生效</span>
      </div>
      {error && <div className="permission-error" role="alert">{error}</div>}
      {questions.map((question, index) => {
        const prompt = typeof question.question === "string" ? question.question : `问题 ${index + 1}`;
        const options = Array.isArray(question.options)
          ? question.options.filter((option): option is Record<string, unknown> => Boolean(option) && typeof option === "object")
          : [];
        return (
          <fieldset key={prompt}>
            <legend>{prompt}</legend>
            {options.map((option) => {
              const label = typeof option.label === "string" ? option.label : "";
              return (
                <label key={label} className="question-option">
                  <input
                    type={question.multiSelect === true ? "checkbox" : "radio"}
                    name={`${permission.requestId}:${index}`}
                    checked={question.multiSelect === true ? answers[prompt]?.includes(label) ?? false : answers[prompt] === label}
                    onChange={() => {
                      if (question.multiSelect !== true) setCustomAnswers(current => ({ ...current, [prompt]: "" }));
                      setAnswers((current) => {
                        if (question.multiSelect !== true) return { ...current, [prompt]: label };
                        const selected = Array.isArray(current[prompt]) ? current[prompt] : [];
                        return { ...current, [prompt]: selected.includes(label) ? selected.filter((value) => value !== label) : [...selected, label] };
                      });
                    }}
                  />
                  <span><strong>{label}</strong>{typeof option.description === "string" && <small>{option.description}</small>}</span>
                </label>
              );
            })}
            <label className="question-freeform">
              <span>{options.length ? "其他回答" : "你的回答"}</span>
              <input
                type="text"
                aria-label={`${prompt}：${options.length ? "其他回答" : "你的回答"}`}
                value={customAnswers[prompt] ?? ""}
                disabled={busy}
                onChange={event => {
                  setCustomAnswers(current => ({ ...current, [prompt]: event.target.value }));
                  if (question.multiSelect !== true) setAnswers(current => ({ ...current, [prompt]: "" }));
                }}
              />
            </label>
          </fieldset>
        );
      })}
      <div className="permission-actions">
        <button type="button" className="secondary-button" disabled={busy} onClick={() => void resolveQuestion("deny")}>取消</button>
        <button
          type="button"
          className="primary-button"
          disabled={!complete || busy}
          onClick={() => void resolveQuestion(
            "allow-once",
            { ...permission.input, answers: Object.fromEntries(questions.map(question => [question.question, [answers[question.question as string], customAnswers[question.question as string]?.trim()].flat().filter(Boolean).join(", ")])) },
          )}
        >
          {busy && <LoaderCircle className="is-spinning" size={15} />}提交回答
        </button>
      </div>
    </section>
  );
}

export const NATIVE_MODE_LABELS: Record<BridgeNativePermissionMode, string> = {
  default: "逐个确认",
  acceptEdits: "自动接受编辑",
  bypassPermissions: "完全授权",
};

export function ToolPermissionPrompt({
  permission,
  onResolve,
  onEnableNativeFullAccess,
}: {
  permission: BridgePermissionInfo;
  onResolve(
    requestId: string,
    decision: "allow-once" | "allow-always" | "deny",
    message?: string,
    updatedInput?: Record<string, unknown>,
    mode?: BridgeNativePermissionMode,
  ): Promise<void>;
  onEnableNativeFullAccess?(requestId: string): Promise<void>;
}) {
  const presentation = permissionPresentation(permission);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [confirmFullAccess, setConfirmFullAccess] = useState(false);
  // Defined while the deny-with-feedback composer is open.
  const [feedback, setFeedback] = useState<string>();
  const composing = feedback !== undefined;
  const plan = permission.toolName === "ExitPlanMode" ? inputText(permission.input, "plan") ?? "" : undefined;

  useEffect(() => {
    if (!confirmFullAccess && !composing) return;
    return registerMobileBackHandler(() => {
      if (busy) return true;
      if (confirmFullAccess) setConfirmFullAccess(false);
      else setFeedback(undefined);
      return true;
    }, 150);
  }, [confirmFullAccess, composing, busy]);

  async function decide(
    decision: "allow-once" | "allow-always" | "deny",
    mode?: BridgeNativePermissionMode,
    message?: string,
  ): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await onResolve(permission.requestId, decision, message, undefined, mode);
    } catch (resolveError) {
      setError(resolveError instanceof Error ? resolveError.message : "授权处理失败");
    } finally {
      setBusy(false);
    }
  }

  async function enableFullAccess(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await onEnableNativeFullAccess?.(permission.requestId);
    } catch (resolveError) {
      setError(resolveError instanceof Error ? resolveError.message : "完全授权设置失败");
    } finally {
      setBusy(false);
      setConfirmFullAccess(false);
    }
  }

  const spinner = busy && <LoaderCircle className="is-spinning" size={15} />;
  return (
    <>
    <section className="permission-prompt">
      <div className="permission-title">
        <strong>{permission.title || (plan !== undefined ? "计划待确认" : `${permission.toolName} 请求权限`)}</strong>
        {plan === undefined && <span>{presentation.summary}</span>}
      </div>
      {plan !== undefined ? (
        <div className="permission-plan">
          <MarkdownText text={plan} collapsible={false} />
        </div>
      ) : (
        <>
          <div className={`permission-risk ${presentation.mutating ? "mutating" : ""}`}>
            {presentation.mutating ? <AlertTriangle size={16} /> : <Wrench size={16} />}
            <span>{presentation.mutating ? "操作前请核对目标与内容" : "当前任务正在等待你的确认"}</span>
          </div>
          {presentation.facts.length > 0 && (
            <dl className="permission-facts">
              {presentation.facts.map((fact) => (
                <div key={`${fact.label}:${fact.value}`}>
                  <dt>{fact.label}</dt>
                  <dd className={fact.code ? "is-code" : ""}>{fact.value}</dd>
                </div>
              ))}
            </dl>
          )}
          {presentation.preview && (
            <details className="permission-details">
              <summary><FilePenLine size={15} />{presentation.preview.label}</summary>
              <pre>{presentation.preview.value}</pre>
            </details>
          )}
          <details className="permission-details raw-details">
            <summary><Terminal size={15} />查看完整参数</summary>
            <pre>{presentation.raw}</pre>
          </details>
        </>
      )}
      {error && <div className="permission-error" role="alert">{error}</div>}
      {composing ? (
        <div className="permission-feedback">
          <textarea
            aria-label={plan !== undefined ? "计划修改意见" : "拒绝原因"}
            placeholder={plan !== undefined ? "需要调整的地方（可选）" : "告诉 Claude 应该怎么做（可选）"}
            rows={3}
            value={feedback}
            disabled={busy}
            onChange={(event) => setFeedback(event.target.value)}
          />
          <div className="permission-actions">
            <button type="button" className="secondary-button" disabled={busy} onClick={() => setFeedback(undefined)}>返回</button>
            <button type="button" className="primary-button" disabled={busy} onClick={() => void decide("deny", undefined, feedback.trim() || undefined)}>
              {spinner}{plan !== undefined ? "继续规划" : "拒绝"}
            </button>
          </div>
        </div>
      ) : plan !== undefined ? (
        <div className="permission-actions">
          {permission.canSetNativeFullAccess ? (
            <>
              <button type="button" className="primary-button" disabled={busy} onClick={() => void decide("allow-once", "acceptEdits")}>
                {spinner}是，自动接受编辑
              </button>
              <button type="button" className="secondary-button" disabled={busy} onClick={() => void decide("allow-once", "default")}>是，逐个确认</button>
            </>
          ) : (
            <button type="button" className="primary-button" disabled={busy} onClick={() => void decide("allow-once")}>
              {spinner}批准计划
            </button>
          )}
          {permission.canSetNativeFullAccess && onEnableNativeFullAccess && (
            <button type="button" className="secondary-button" disabled={busy} onClick={() => setConfirmFullAccess(true)}>
              <ShieldCheck size={15} />是，完全授权
            </button>
          )}
          <button type="button" className="secondary-button" disabled={busy} onClick={() => setFeedback("")}>否，继续规划</button>
        </div>
      ) : (
        <div className="permission-actions">
          <button type="button" className="secondary-button danger-text" disabled={busy} onClick={() => setFeedback("")}>拒绝</button>
          <button type="button" className="primary-button" disabled={busy} onClick={() => void decide("allow-once")}>
            {spinner}允许一次
          </button>
          {permission.canAllowAlways && (
            <button type="button" className="secondary-button" disabled={busy} onClick={() => void decide("allow-always")}>始终允许</button>
          )}
          {permission.canSetNativeFullAccess && onEnableNativeFullAccess && (
            <button type="button" className="secondary-button" disabled={busy} onClick={() => setConfirmFullAccess(true)}>
              <ShieldCheck size={15} />此 Desktop 会话完全授权
            </button>
          )}

        </div>
      )}
    </section>
    <ConfirmationDialog
      open={Boolean(confirmFullAccess)}
      title="此 Desktop 会话完全授权"
      description="这会允许当前工具，并请求将当前 Desktop 会话切换为完全授权，需等待 Desktop 确认；提问和强制确认仍需响应。收件箱接收许可仍需在电脑端确认。"
      confirmLabel="确认完全授权"
      busy={busy}
      onCancel={() => setConfirmFullAccess(false)}
      onConfirm={() => void enableFullAccess()}
    />
    </>
  );
}

export function PermissionPrompt({
  permission,
  onResolve,
  onEnableNativeFullAccess,
}: {
  permission: BridgePermissionInfo;
  onResolve(
    requestId: string,
    decision: "allow-once" | "allow-always" | "deny",
    message?: string,
    updatedInput?: Record<string, unknown>,
    mode?: BridgeNativePermissionMode,
  ): Promise<void>;
  onEnableNativeFullAccess?(requestId: string): Promise<void>;
}) {
  return permission.toolName === "AskUserQuestion"
    ? <QuestionPrompt permission={permission} onResolve={onResolve} />
    : (
      <ToolPermissionPrompt
        permission={permission}
        onResolve={onResolve}
        {...(onEnableNativeFullAccess ? { onEnableNativeFullAccess } : {})}
      />
    );
}
