import type { BridgePendingPrompt, BridgePullRequest } from "@bridge/protocol";
import { NativeCallError } from "./claude-desktop-inspector.js";

export const NATIVE_PROMPTS = [
  { field: "pendingRefusalFallbackPrompt", kind: "refusal-fallback", method: "respondToRefusalFallbackPrompt", event: "refusal_fallback_prompt", title: "切换备用模型", choices: [{ value: "retry_fallback", label: "使用备用模型重试" }, { value: "edit_prompt", label: "修改提示" }] },
  { field: "pendingAutoModeServerFallbackPrompt", kind: "auto-mode-server-fallback", method: "respondToAutoModeServerFallbackPrompt", event: "auto_mode_server_fallback_prompt", title: "自动模式需要确认", choices: [{ value: "continue", label: "继续" }, { value: "interrupt", label: "停止" }] },
  { field: "pendingLanyardConsent", kind: "lanyard-consent", method: "respondToLanyardConsent", event: "lanyard_consent", title: "Desktop 访问确认" },
  { field: "pendingViolinBowPrompt", kind: "violin-bow", method: "respondToViolinBowPrompt", event: "violin_bow_prompt", title: "Desktop 操作确认" },
  { field: "pendingCwdTrustPrompt", kind: "cwd-trust", method: "answerPendingCwdTrust", title: "信任工作目录", choices: [{ value: "trust", label: "信任目录" }, { value: "cancel", label: "取消" }] },
] as const;

export interface NativePromptSession {
  sessionId: string;
  pendingRefusalFallbackPrompt?: unknown;
  pendingAutoModeServerFallbackPrompt?: unknown;
  pendingLanyardConsent?: unknown;
  pendingViolinBowPrompt?: unknown;
  pendingCwdTrustPrompt?: unknown;
}

/** The inspector payload is the ownership boundary for native dialog information. */
export async function nativePendingPrompts(session: NativePromptSession, inspector: {
  supports(method: string): boolean;
  promptChoices?(sessionId: string, promptId: string): Promise<string[] | undefined>;
}): Promise<BridgePendingPrompt[]> {
  const prompts: BridgePendingPrompt[] = [];
  for (const spec of NATIVE_PROMPTS) {
    const raw = session[spec.field];
    if (raw == null) continue;
    if (typeof raw !== "object" || Array.isArray(raw)) throw new NativeCallError(`Desktop returned an invalid ${spec.field}`);
    const info = raw as Record<string, unknown>;
    if (typeof info.promptId !== "string" || !info.promptId) throw new NativeCallError(`Desktop returned an invalid ${spec.field} ID`);
    const choices = "choices" in spec ? [...spec.choices] : (await inspector.promptChoices?.(session.sessionId, info.promptId))?.map(value => ({ value, label: value }));
    const message = spec.kind === "refusal-fallback" && typeof info.originalModel === "string" && typeof info.fallbackModel === "string"
      ? `${info.originalModel} → ${info.fallbackModel}${typeof info.apiRefusalCategory === "string" ? `\n${info.apiRefusalCategory}` : ""}`
      : Array.isArray(info.paragraphs) ? info.paragraphs.filter(value => typeof value === "string").join("\n\n")
        : [info.message, info.description, info.reason].find((value): value is string => typeof value === "string" && value.length > 0);
    const base = {
      promptId: info.promptId, sessionId: session.sessionId,
      title: typeof info.title === "string" && info.title ? info.title : spec.title,
      ...(message ? { message } : {}),
      choices: choices ?? [],
      canRespond: inspector.supports(spec.method) && choices !== undefined && choices.length > 0,
    };
    if (spec.kind === "cwd-trust") {
      if (typeof info.directory !== "string" || !Array.isArray(info.sources) || !info.sources.every(source => typeof source === "string")) throw new NativeCallError("Desktop returned an invalid pendingCwdTrustPrompt");
      prompts.push({ ...base, kind: spec.kind, directory: info.directory, sources: info.sources as string[] });
    } else {
      prompts.push({ ...base, kind: spec.kind });
    }
  }
  return prompts;
}

export function nativePullRequests(raw: unknown): BridgePullRequest[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new NativeCallError("Desktop returned an invalid PR list");
  return raw.map(value => {
    if (!value || typeof value !== "object" || typeof value.repo !== "string" || typeof value.prNumber !== "number" || !Number.isInteger(value.prNumber) || value.prNumber <= 0 || typeof value.url !== "string") throw new NativeCallError("Desktop returned an invalid PR binding");
    return {
      repo: value.repo, prNumber: value.prNumber, url: value.url,
      ...(typeof value.host === "string" ? { host: value.host } : {}),
      ...(typeof value.branch === "string" ? { branch: value.branch } : {}),
      ...(typeof value.state === "string" ? { state: value.state } : {}),
      ...(typeof value.autoFix === "boolean" ? { autoFix: value.autoFix } : {}),
    };
  });
}
