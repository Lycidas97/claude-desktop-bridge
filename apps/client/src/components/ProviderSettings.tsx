import type { BridgeHostSnapshot } from "@bridge/protocol";
import { Gauge, LoaderCircle, RefreshCw } from "lucide-react";
import { useState } from "react";
import { MagpieQuotaDashboard } from "../../../../plugins/magpie-quota/client.js";
import { ConfirmationDialog } from "./ConfirmationDialog.js";
import "./settings.css";

export function ProviderSettings({ snapshot, connected = true, desktopLocal = false, onRefresh, onSetApiKey, onRemoveApiKey }: {
  snapshot?: BridgeHostSnapshot;
  connected?: boolean;
  desktopLocal?: boolean;
  onRefresh(): Promise<void>;
  onSetApiKey?(value: string): Promise<void>;
  onRemoveApiKey?(): Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [removeOpen, setRemoveOpen] = useState(false);
  const [quotaOpen, setQuotaOpen] = useState(false);
  const detection = snapshot?.runtime.detection;
  const quotaDeclared = snapshot?.host.capabilities.includes("plugin.magpie-quota.v1");
  const sourceNames = { "host-credentials": "Host 凭据文件", "fixed-gateway": "固定网关配置", environment: "运行环境", none: "未找到配置" };
  const profileNames = { "claude-3p": "Claude-3p", claude: "Claude", unknown: "未识别" };

  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError("");
    try { await action(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "提供方设置失败"); }
    finally { setBusy(false); }
  }

  return <section className="provider-settings" aria-label="提供方设置" aria-busy={busy}>
    <header className="settings-section-heading">
      <div><h2>提供方</h2>{snapshot && <span>{snapshot.host.name}</span>}</div>
      <button type="button" className="secondary-button" disabled={!snapshot || !connected || busy} onClick={() => void run(onRefresh)}>
        {busy ? <LoaderCircle className="is-spinning" size={16} /> : <RefreshCw size={16} />}重新检测
      </button>
    </header>
    {!connected && <p className="settings-notice" role="status">电脑未连接，显示上次检测结果。</p>}
    {!snapshot ? <p>连接电脑后查看提供方配置。</p> : <>
      {(snapshot.providers ?? []).map((profile) => <section className="provider-settings-profile" key={profile.id} aria-label={profile.name}>
        <header><h3>{profile.name}</h3><span className="provider-status">{profile.status === "ready" ? "本地已就绪" : profile.configured ? "需要处理" : "未配置"}</span></header>
        {profile.kind === "claude-3p" ? <>
          <dl className="settings-facts">
            <div><dt>配置来源</dt><dd>{detection ? sourceNames[detection.configSource.type] : "等待电脑提供检测详情"}{detection && detection.configSource.profile !== "unknown" ? ` · ${profileNames[detection.configSource.profile]}` : ""}</dd></div>
            <div><dt>网关</dt><dd>{detection?.gatewayState === "configured" ? "已配置" : detection ? "未配置" : "尚未检测"}</dd></div>
            <div><dt>模型列表</dt><dd>{detection?.modelDiscovery.state === "ready" ? `${profile.models.length} 个模型` : detection?.modelDiscovery.state === "error" ? detection.modelDiscovery.error ?? "模型接口读取失败" : "尚未读取"}</dd></div>
          </dl>
          <details className="settings-detection"><summary>检测详情</summary><dl className="settings-facts">
            <div><dt>CLI</dt><dd>{snapshot.runtime.version ?? snapshot.runtime.detail}</dd></div>
            {detection?.cliPath && <div><dt>CLI 路径</dt><dd>{detection.cliPath}</dd></div>}
            {detection?.configSource.path && <div><dt>配置路径</dt><dd>{detection.configSource.path}</dd></div>}
            <div><dt>最近检测</dt><dd>{detection ? new Date(detection.refreshedAt).toLocaleString("zh-CN") : "电脑尚未提供"}</dd></div>
          </dl></details>
          {quotaDeclared && <>
            <button type="button" className="secondary-button provider-quota-toggle" aria-expanded={quotaOpen} onClick={() => setQuotaOpen(!quotaOpen)}><Gauge size={16} />Magpie 额度</button>
            {quotaOpen && <MagpieQuotaDashboard />}
          </>}
        </> : <p>{profile.detail || (profile.kind === "anthropic-api" ? "API Key 仅保存在这台电脑。" : "使用原生应用中的账号配置。")}</p>}
        {profile.kind === "anthropic-api" && (desktopLocal && onSetApiKey ? <div className="provider-key-settings">
          <label><span>{profile.configured ? "更换 API Key" : "API Key"}</span><input type="password" autoComplete="off" spellCheck={false} value={apiKey} disabled={busy} onChange={(event) => setApiKey(event.target.value)} /></label>
          <div className="settings-inline-actions">
            <button type="button" className="primary-button" disabled={busy || !apiKey.trim()} onClick={() => void run(async () => { await onSetApiKey(apiKey.trim()); setApiKey(""); })}>验证并保存</button>
            {profile.configured && onRemoveApiKey && <button type="button" className="secondary-button" disabled={busy} onClick={() => setRemoveOpen(true)}>移除 Key</button>}
          </div>
        </div> : <p className="settings-notice">请在电脑端 Bridge 设置中管理 API Key。</p>)}
        {profile.models.length > 0 && <details className="settings-model-list"><summary>查看模型</summary><ul>{profile.models.map((model) => <li key={model.id}>{model.displayName || model.id}</li>)}</ul></details>}
      </section>)}
      {!snapshot.providers?.length && <p>这台电脑尚未提供执行来源配置，请重新检测或更新电脑端 Bridge。</p>}
    </>}
    {error && <p role="alert" className="inline-error">{error}</p>}
    <ConfirmationDialog open={removeOpen} title="移除 Anthropic API Key？" description="使用这个 Key 的 Bridge 会话将需要重新配置才能继续。" confirmLabel="移除 Key" danger busy={busy} onCancel={() => setRemoveOpen(false)} onConfirm={() => void run(async () => { await onRemoveApiKey!(); setRemoveOpen(false); })} />
  </section>;
}
