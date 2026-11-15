import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";

export function MessageCopyButton({ text, label }: { text: string; label: string }) {
  const [status, setStatus] = useState<"idle" | "copied" | "error">("idle");
  useEffect(() => setStatus("idle"), [text]);

  async function copy(button: HTMLButtonElement): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setStatus("copied");
      return;
    } catch {
      // Android WebViews may not grant the asynchronous clipboard API.
    }
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.readOnly = true;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    // A modal dialog makes elements outside it inert, including selection targets.
    (button.closest("dialog") ?? document.body).appendChild(textarea);
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    try {
      setStatus(document.execCommand("copy") ? "copied" : "error");
    } catch {
      setStatus("error");
    } finally {
      textarea.remove();
    }
  }

  return (
    <button
      type="button"
      className="message-copy-button"
      aria-label={status === "copied" ? "已复制" : label}
      onClick={(event) => void copy(event.currentTarget)}
    >
      {status === "copied" ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
      <span aria-live="polite">{status === "copied" ? "已复制" : status === "error" ? "复制失败，点击重试" : "复制"}</span>
    </button>
  );
}
