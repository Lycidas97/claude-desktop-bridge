import { useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";
import "./relay-settings.css";

export function RelaySettings({ relayUrl, onSave }: { relayUrl: string; onSave(url: string): Promise<void> }) {
  const [value, setValue] = useState(relayUrl);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => { setValue(relayUrl); }, [relayUrl]);
  return (
    <form className="relay-settings" onSubmit={(event) => {
      event.preventDefault();
      setSaving(true);
      setError("");
      setNotice("");
      void onSave(value).then(() => setNotice("地址已保存，正在重新连接。"))
        .catch((failure: unknown) => setError(failure instanceof Error ? failure.message : "中继地址保存失败"))
        .finally(() => setSaving(false));
    }}>
      <label><strong>中继服务器地址</strong>
        <input aria-label="中继服务器地址" type="url" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={value} onChange={(event) => setValue(event.target.value)} placeholder="wss://relay.example/ws" disabled={saving} required />
      </label>
      <p className="detail-text">电脑和手机需使用相同的中继地址。保存只修改当前设备；切换服务器时请分别修改两端。支持 ws:// 和 wss://，包括端口与路径。</p>
      <button type="submit" className="secondary-button" disabled={saving || !value.trim()}>{saving && <LoaderCircle className="is-spinning" size={15} />}{saving ? "保存中" : "保存并重连"}</button>
      {error && <p className="inline-error" role="alert">{error}</p>}
      {notice && <p className="detail-text" role="status">{notice}</p>}
    </form>
  );
}
