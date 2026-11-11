import type {
  BridgeHistoryItem, BridgeSessionRewindPreview, BridgeSessionRewindResult, BridgeSessionRewindScope,
} from "@bridge/protocol";
import { LoaderCircle, X } from "lucide-react";
import { useEffect, useState } from "react";
import { registerMobileBackHandler } from "../../lib/mobile-back-navigation.js";
import { IconButton } from "../common/IconButton.js";

export function SessionRewindDialog({ messages, initialMessageId, disabled, onPreview, onRewind, onComplete, onClose }: {
  messages: BridgeHistoryItem[];
  initialMessageId?: string;
  disabled: boolean;
  onPreview(messageId: string): Promise<BridgeSessionRewindPreview>;
  onRewind(messageId: string, scope: BridgeSessionRewindScope): Promise<BridgeSessionRewindResult>;
  onComplete(result: BridgeSessionRewindResult): void;
  onClose(): void;
}) {
  const targets = messages.filter(message => message.role === "user" && !message.id.startsWith("local:") && !message.id.startsWith("queued:"));
  const [messageId, setMessageId] = useState(initialMessageId ?? targets.at(-1)?.id ?? "");
  const [scope, setScope] = useState<BridgeSessionRewindScope>("conversation");
  const [preview, setPreview] = useState<BridgeSessionRewindPreview>();
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!messageId || disabled) return;
    let active = true;
    setLoading(true);
    setPreview(undefined);
    setError(undefined);
    void onPreview(messageId).then(result => {
      if (!active) return;
      setPreview(result);
      setScope(result.canRewindConversation ? "conversation" : "files");
    }).catch(reason => {
      if (active) setError(reason instanceof Error ? reason.message : "回退预览读取失败");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [messageId, disabled]);

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) { event.stopPropagation(); onClose(); }
    };
    document.addEventListener("keydown", escape);
    const unregister = registerMobileBackHandler(() => { if (!busy) onClose(); return true; }, 150);
    return () => { document.removeEventListener("keydown", escape); unregister(); };
  }, [busy, onClose]);

  const allowed = Boolean(preview && (scope === "conversation" ? preview.canRewindConversation
    : scope === "files" ? preview.canRewindFiles : preview.canRewindConversation && preview.canRewindFiles));
  async function rewind(): Promise<void> {
    if (!allowed || busy || loading || disabled) return;
    setBusy(true);
    setError(undefined);
    try { onComplete(await onRewind(messageId, scope)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "回退失败"); }
    finally { setBusy(false); }
  }

  return <div className="modal-backdrop session-configuration-backdrop" role="presentation" onMouseDown={event => {
    if (event.target === event.currentTarget && !busy) onClose();
  }}>
    <section className="session-configuration-dialog session-rewind-dialog" role="dialog" aria-modal="true" aria-label="回退会话">
      <header><h2>回退会话</h2><IconButton label="关闭" disabled={busy} onClick={onClose}><X size={19} /></IconButton></header>
      <label className="session-model-field"><span>回退到哪条消息之前</span>
        <select aria-label="回退目标消息" value={messageId} disabled={busy || disabled} onChange={event => { setMessageId(event.target.value); setPreview(undefined); }}>
          {[...targets].reverse().map(message => <option value={message.id} key={message.id}>{message.text.replace(/\s+/gu, " ").slice(0, 100) || "图片或附件消息"}</option>)}
        </select>
      </label>
      {!targets.length && <p className="session-configuration-notice">当前没有可选择的已发送消息。</p>}
      {disabled && <p className="session-configuration-notice">连接电脑后可预览回退。</p>}
      {loading && <div className="session-configuration-loading"><LoaderCircle className="is-spinning" size={18} />正在读取回退预览</div>}
      {preview && <>
        <label className="session-model-field"><span>回退范围</span>
          <select aria-label="回退范围" value={scope} disabled={busy || disabled} onChange={event => setScope(event.target.value as BridgeSessionRewindScope)}>
            <option value="conversation" disabled={!preview.canRewindConversation}>仅对话</option>
            <option value="files" disabled={!preview.canRewindFiles}>仅文件</option>
            <option value="both" disabled={!preview.canRewindConversation || !preview.canRewindFiles}>对话和文件</option>
          </select>
        </label>
        {!preview.canRewindConversation && <p className="session-configuration-notice">Desktop 无法回退到这条消息之前的对话。</p>}
        {preview.fileError && <p className="session-configuration-notice">{preview.fileError}</p>}
        {preview.filesInFlight && <p className="session-configuration-notice">Desktop 正在恢复文件，请稍后重新预览。</p>}
        {scope !== "conversation" && <div className="session-rewind-files">
          <strong>将恢复 {preview.filesChanged.length} 个文件</strong>
          {preview.filesChanged.length > 0 && <ul>{preview.filesChanged.map(path => <li key={path}>{path}</li>)}</ul>}
        </div>}
        <p className="session-configuration-notice">{scope === "files"
          ? "将覆盖上述文件的当前内容，对话保留。"
          : scope === "both" ? "将恢复上述文件，并停止当前任务、移除所选消息及之后的对话。原消息文字将放回输入框，附件需重新添加。"
            : "将停止当前任务、移除所选消息及之后的对话，文件保持当前内容。原消息文字将放回输入框，附件需重新添加。"}</p>
      </>}
      {error && <div className="session-configuration-error" role="alert">{error}</div>}
      <footer><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button>
        <button type="button" className="danger-button" disabled={!allowed || busy || loading || disabled} onClick={() => void rewind()}>
          {busy && <LoaderCircle className="is-spinning" size={16} />}{busy ? "正在回退" : "确认回退"}
        </button></footer>
    </section>
  </div>;
}
