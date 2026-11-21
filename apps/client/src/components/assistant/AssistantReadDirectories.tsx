import type { BridgeDirectoryListing, BridgeHostSnapshot } from "@bridge/protocol";
import { useState } from "react";
import { SessionCreateDialog } from "../session/SessionCreateDialog.js";
import { mailResult, type AssistantRequest } from "./AssistantMailProvider.js";

export function AssistantReadDirectories({ directories, sessionId, snapshot, disabled, canAdd, request, browse }: {
  directories: readonly string[];
  sessionId: string;
  snapshot: BridgeHostSnapshot;
  disabled: boolean;
  canAdd: boolean;
  request: AssistantRequest;
  browse(path?: string): Promise<BridgeDirectoryListing>;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selected, setSelected] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function change(action: "add" | "remove", directory: string) {
    setBusy(true);
    setError("");
    try {
      const response = await request("plugin.assistant-mail.read-directory.change", { sessionId, action, directory });
      if (!response) throw new Error("无法连接电脑。");
      mailResult(response);
      if (action === "add") setSelected(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "可读目录更新失败。");
    } finally { setBusy(false); }
  }
  return <section className="assistant-read-directories" aria-label="可读目录">
    <div className="assistant-binding-current">
      <strong>可读目录</strong>
      <button type="button" className="assistant-session-link" disabled={disabled || !canAdd || busy || Boolean(selected)}
        onClick={() => { setError(""); setPickerOpen(true); }}>添加可读目录</button>
    </div>
    {directories.length ? <ul>
      {directories.map(directory => <li key={directory}>
        <span>{directory}</span>
        <button type="button" className="assistant-session-link" aria-label={`撤销读取 ${directory}`} disabled={disabled || busy}
          onClick={() => { void change("remove", directory); }}>撤销</button>
      </li>)}
    </ul> : <p>未授权工作区外的文件夹。</p>}
    {selected && <div className="assistant-workspace-confirm">
      <p>允许助理读取此文件夹及其子文件夹？</p>
      <code>{selected}</code>
      <div className="assistant-actions">
        <button type="button" className="secondary-button" disabled={busy} onClick={() => { setSelected(undefined); setError(""); }}>取消</button>
        <button type="button" className="primary-button" disabled={disabled || !canAdd || busy}
          onClick={() => { void change("add", selected); }}>授权读取</button>
      </div>
    </div>}
    {error && <p role="alert">{error}</p>}
    {pickerOpen && <SessionCreateDialog snapshot={snapshot} connected={!disabled}
      {...(snapshot.host.capabilities.includes("directory.browse.v1") ? { onBrowseDirectory: browse } : {})}
      onPickDirectory={setSelected} onClose={() => setPickerOpen(false)} onCreate={async () => undefined} onCreated={() => {}} />}
  </section>;
}
