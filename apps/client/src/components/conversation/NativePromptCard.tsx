import type { BridgePendingPrompt } from "@bridge/protocol";
import { LoaderCircle } from "lucide-react";
import { useState } from "react";

export function NativePromptCard({
  prompt,
  online = true,
  onResolve,
}: {
  prompt: BridgePendingPrompt;
  online?: boolean;
  onResolve?(sessionId: string, promptId: string, choice: string): Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function resolve(choice: string): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      await onResolve!(prompt.sessionId, prompt.promptId, choice);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "回答提交失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="permission-prompt native-prompt" aria-label={prompt.title}>
      <div className="permission-title"><strong>{prompt.title}</strong></div>
      {prompt.message && <p>{prompt.message}</p>}
      {prompt.kind === "cwd-trust" && (
        <dl className="permission-facts">
          <div><dt>目录</dt><dd className="is-code">{prompt.directory}</dd></div>
          {prompt.sources.length > 0 && <div><dt>来源</dt><dd>{prompt.sources.join("、")}</dd></div>}
        </dl>
      )}
      {error && <div className="permission-error" role="alert">{error}</div>}
      {(!prompt.canRespond || !onResolve) ? <span className="native-prompt-unavailable">请在电脑端处理</span>
        : !online ? <span className="native-prompt-unavailable">电脑离线，连接后再回答</span> : null}
      <div className="permission-actions">
        {prompt.choices.map((choice, index) => (
          <button
            type="button"
            key={choice.value}
            className={index === 0 ? "primary-button" : "secondary-button"}
            disabled={busy || !online || !prompt.canRespond || !onResolve}
            onClick={() => void resolve(choice.value)}
          >
            {busy && <LoaderCircle size={15} className="is-spinning" />}{choice.label}
          </button>
        ))}
      </div>
    </section>
  );
}
