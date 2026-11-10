import type { BridgeHostSnapshot, BridgeMagpieConnectionInput, BridgeMagpieConnectionTestResult, DesktopControlSnapshot } from "@bridge/protocol";
import { Gauge, LoaderCircle, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { MagpieQuotaDashboard } from "../../../../plugins/magpie-quota/client.js";
import "./settings.css";

export function ProviderSettings({ snapshot, connected = true, desktopLocal = false, onRefresh, onSetApiKey, onRemoveApiKey, onTestMagpieConnection, onSaveMagpieConnection }: {
  snapshot?: BridgeHostSnapshot;
  connected?: boolean;
  desktopLocal?: boolean;
  onRefresh(): Promise<void>;
  onSetApiKey?(value: string): Promise<void>;
  onRemoveApiKey?(): Promise<void>;
  onTestMagpieConnection?: ((input: BridgeMagpieConnectionInput) => Promise<BridgeMagpieConnectionTestResult>) | undefined;
  onSaveMagpieConnection?: ((input: BridgeMagpieConnectionInput) => Promise<DesktopControlSnapshot>) | undefined;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [quotaOpen, setQuotaOpen] = useState(false);
  const quotaDeclared = snapshot?.host.capabilities.includes("plugin.magpie-quota.v1");
  const magpie = snapshot?.magpie;
  const [magpieDraft, setMagpieDraft] = useState({
    mode: magpie?.mode ?? "auto",
    baseUrl: magpie?.baseUrl ?? "",
    authScheme: magpie?.authScheme ?? "bearer",
    apiKey: "",
  });
  const [magpieDirty, setMagpieDirty] = useState(false);
  const [magpieAction, setMagpieAction] = useState<"test" | "save">();
  const [magpieError, setMagpieError] = useState("");
  const [magpieSaved, setMagpieSaved] = useState(false);
  const [magpieTest, setMagpieTest] = useState<BridgeMagpieConnectionTestResult>();
  const canKeepMagpieKey = magpie?.mode === "manual" && magpie.keyConfigured
    && magpieDraft.authScheme === magpie.authScheme && URL.canParse(magpieDraft.baseUrl.trim())
    && new URL(magpieDraft.baseUrl.trim()).href.replace(/\/+$/u, "") === magpie.baseUrl;
  const magpieIncomplete = magpieDraft.mode === "manual"
    && (!magpieDraft.baseUrl.trim() || (!magpieDraft.apiKey.trim() && !canKeepMagpieKey));

  useEffect(() => {
    if (magpieDirty) return;
    setMagpieDraft({ mode: magpie?.mode ?? "auto", baseUrl: magpie?.baseUrl ?? "", authScheme: magpie?.authScheme ?? "bearer", apiKey: "" });
    setMagpieTest(undefined);
  }, [magpie?.mode, magpie?.baseUrl, magpie?.authScheme, magpie?.keyConfigured, magpieDirty]);

  function editMagpie(change: Partial<typeof magpieDraft>): void {
    setMagpieDraft({ ...magpieDraft, ...change });
    setMagpieDirty(true);
    setMagpieTest(undefined);
    setMagpieSaved(false);
    setMagpieError("");
  }

  async function runMagpie(action: "test" | "save"): Promise<void> {
    const input: BridgeMagpieConnectionInput = magpieDraft.mode === "auto" ? { mode: "auto" } : {
      mode: "manual", baseUrl: magpieDraft.baseUrl.trim(), authScheme: magpieDraft.authScheme,
      ...(magpieDraft.apiKey.trim() ? { apiKey: magpieDraft.apiKey.trim() } : {}),
    };
    setBusy(true);
    setMagpieAction(action);
    setMagpieError("");
    setMagpieSaved(false);
    setMagpieTest(undefined);
    try {
      if (action === "test") setMagpieTest(await onTestMagpieConnection!(input));
      else {
        const saved = (await onSaveMagpieConnection!(input)).magpie!;
        setMagpieDraft({ mode: saved.mode, baseUrl: saved.baseUrl ?? "", authScheme: saved.authScheme ?? "bearer", apiKey: "" });
        setMagpieDirty(false);
        setMagpieSaved(true);
      }
    } catch (reason) {
      setMagpieError(reason instanceof Error ? reason.message : action === "test" ? "Magpie 连接测试失败" : "Magpie 连接保存失败");
    } finally {
      setBusy(false);
      setMagpieAction(undefined);
    }
  }

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
      {magpie && <section className="provider-settings-profile" aria-label="Magpie 连接">
        <header><h3>Magpie 连接</h3></header>
        <dl className="settings-facts">
          <div><dt>当前来源</dt><dd>{magpie.mode === "manual" ? "手动配置 Magpie" : "沿用 Claude/Claude-3p 配置"}</dd></div>
          <div><dt>网关 URL</dt><dd>{magpie.baseUrl || "未配置"}</dd></div>
          <div><dt>认证方式</dt><dd>{magpie.authScheme === "bearer" ? "Bearer" : magpie.authScheme === "x-api-key" ? "x-api-key" : "未配置"}</dd></div>
          <div><dt>API Key</dt><dd>{magpie.keyConfigured ? "已配置" : "未配置"}</dd></div>
        </dl>
        {desktopLocal && onTestMagpieConnection && onSaveMagpieConnection ? <div className="provider-key-settings provider-magpie-settings">
          <label htmlFor="magpie-mode"><span>配置来源</span><select id="magpie-mode" value={magpieDraft.mode} disabled={busy} onChange={(event) => editMagpie({ mode: event.target.value as typeof magpieDraft.mode })}>
            <option value="auto">沿用 Claude/Claude-3p 配置</option><option value="manual">手动配置 Magpie</option>
          </select></label>
          {magpieDraft.mode === "manual" && <>
            <label htmlFor="magpie-base-url"><span>网关 URL</span><input id="magpie-base-url" type="url" autoComplete="off" spellCheck={false} placeholder="https://gateway.example.com" value={magpieDraft.baseUrl} disabled={busy} onChange={(event) => editMagpie({ baseUrl: event.target.value })} /></label>
            <label htmlFor="magpie-auth-scheme"><span>认证方式</span><select id="magpie-auth-scheme" value={magpieDraft.authScheme} disabled={busy} onChange={(event) => editMagpie({ authScheme: event.target.value as typeof magpieDraft.authScheme })}>
              <option value="bearer">Bearer</option><option value="x-api-key">x-api-key</option>
            </select></label>
            <label htmlFor="magpie-api-key"><span>Magpie API Key</span><input id="magpie-api-key" type="password" autoComplete="off" spellCheck={false} value={magpieDraft.apiKey} placeholder={canKeepMagpieKey ? "留空保留已保存的 Key" : "输入 API Key"} aria-describedby="magpie-key-notice" disabled={busy} onChange={(event) => editMagpie({ apiKey: event.target.value })} /></label>
            <p className="settings-notice" id="magpie-key-notice">{canKeepMagpieKey ? "已保存的 Key 不会回填；留空可继续使用。" : "首次配置或更换网关、认证方式时，请输入 API Key。"}</p>
          </>}
          <div className="settings-inline-actions">
            <button type="button" className="secondary-button" disabled={!connected || busy || magpieIncomplete} onClick={() => void runMagpie("test")}>{magpieAction === "test" && <LoaderCircle className="is-spinning" size={16} />}测试连接</button>
            <button type="button" className="primary-button" disabled={!connected || busy || magpieIncomplete || !magpieDirty} onClick={() => void runMagpie("save")}>{magpieAction === "save" && <LoaderCircle className="is-spinning" size={16} />}保存 Magpie 配置</button>
          </div>
          <p className="settings-notice">测试连接不会保存。保存后用于 Magpie 额度查询。</p>
          <div role="status" aria-live="polite" aria-atomic="true">
            {magpieAction && <p className="settings-notice">{magpieAction === "test" ? "正在测试 Magpie 连接…" : "正在保存 Magpie 配置…"}</p>}
            {magpieSaved && <p className="settings-notice">Magpie 配置已保存。</p>}
            {magpieTest && <dl className="settings-facts provider-magpie-test">
              <div><dt>模型列表</dt><dd>{magpieTest.models.state === "ready" ? `可用 · ${magpieTest.models.count} 个模型` : `读取失败 · ${magpieTest.models.error ?? "模型接口读取失败"}`}</dd></div>
              <div><dt>额度接口</dt><dd>{magpieTest.quota.state === "available" ? "可用" : magpieTest.quota.state === "unsupported" ? "不支持" : `读取失败 · ${magpieTest.quota.error ?? "额度接口读取失败"}`}</dd></div>
            </dl>}
          </div>
          {magpieError && <p role="alert" className="inline-error">{magpieError}</p>}
        </div> : <p className="settings-notice">{desktopLocal ? "这台电脑暂不支持编辑 Magpie 连接，请更新电脑端 Bridge。" : "请在这台电脑的 Bridge 设置中管理 Magpie 连接。"}</p>}
      </section>}
      {quotaDeclared && <section className="provider-settings-profile" aria-label="Magpie 额度">
        <button type="button" className="secondary-button provider-quota-toggle" aria-expanded={quotaOpen} onClick={() => setQuotaOpen(!quotaOpen)}><Gauge size={16} />Magpie 额度</button>
        {quotaOpen && <MagpieQuotaDashboard />}
      </section>}
      {(snapshot.providers ?? []).filter(profile => !["claude-3p", "anthropic-api", "claude-official"].includes(profile.kind)).map(profile => (
        <section className="provider-settings-profile" key={profile.id} aria-label={profile.name}>
          <header><h3>{profile.name}</h3><span className="provider-status">{profile.status === "ready" ? "本地已就绪" : profile.configured ? "需要处理" : "未配置"}</span></header>
          <p>{profile.detail || "使用原生应用中的账号配置。"}</p>
          {profile.models.length > 0 && <details className="settings-model-list"><summary>查看模型</summary><ul>{profile.models.map(model => <li key={model.id}>{model.displayName || model.id}</li>)}</ul></details>}
        </section>
      ))}
    </>}
    {error && <p role="alert" className="inline-error">{error}</p>}

  </section>;
}
