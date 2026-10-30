import type {
  BridgeDesktopRuntimeId,
  BridgeHostSnapshot,
  BridgePermissionMode,
  BridgeSessionConfiguration,
} from "@bridge/protocol";
import { LoaderCircle, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { registerMobileBackHandler } from "../lib/mobile-back-navigation.js";
import { desktopRuntimeName } from "../lib/runtime-labels.js";
import { ConfirmationDialog } from "./ConfirmationDialog.js";

export function PermissionModeControls({
  scope,
  value,
  disabled = false,
  onChange,
  onInherit,
}: {
  scope: "host" | "session";
  value: BridgePermissionMode | "inherit";
  disabled?: boolean;
  onChange(mode: BridgePermissionMode): void;
  onInherit?(): void;
}) {
  return (
    <div className={`permission-mode-segments ${scope}`} role="group" aria-label="授权等级">
      {scope === "session" && (
        <button
          type="button"
          className={value === "inherit" ? "active" : ""}
          aria-pressed={value === "inherit"}
          disabled={disabled}
          onClick={onInherit}
        >跟随电脑</button>
      )}
      <button
        type="button"
        className={value === "standard" ? "active" : ""}
        aria-pressed={value === "standard"}
        disabled={disabled}
        onClick={() => onChange("standard")}
      >标准授权</button>
      <button
        type="button"
        className={value === "full-access" ? "active" : ""}
        aria-pressed={value === "full-access"}
        disabled={disabled}
        onClick={() => onChange("full-access")}
      >完全授权</button>
    </div>
  );
}

const RUNTIME_IDS: BridgeDesktopRuntimeId[] = [
  "claude-desktop", "codex-desktop", "hermes-desktop", "dsh-desktop",
];

export function HostPermissionSettings({
  snapshot,
  onLoadSessionConfiguration,
  onConfigureHostPermission,
}: {
  snapshot?: BridgeHostSnapshot;
  onLoadSessionConfiguration(sessionId: string): Promise<BridgeSessionConfiguration>;
  onConfigureHostPermission(
    runtimeId: BridgeDesktopRuntimeId,
    mode: BridgePermissionMode,
    sessionId?: string,
  ): Promise<void>;
}) {
  const [runtimeId, setRuntimeId] = useState<BridgeDesktopRuntimeId>("claude-desktop");
  const [mode, setMode] = useState<BridgePermissionMode>("standard");
  const [savedMode, setSavedMode] = useState<BridgePermissionMode>();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmFullAccess, setConfirmFullAccess] = useState(false);
  const [error, setError] = useState<string>();
  const runtimeName = desktopRuntimeName(runtimeId);
  const supported = snapshot?.host.capabilities.includes("permission.policy.v1") ?? false;
  const sessionId = snapshot?.sessions
    .filter((session) => session.runtimeId === runtimeId && session.sessionId.startsWith(`${runtimeId}:`))
    .sort((left, right) => right.lastActivityAt - left.lastActivityAt)[0]?.sessionId;
  const hostId = snapshot?.host.hostId;
  const claudeMode = snapshot?.host.defaultPermissionMode ?? "standard";

  useEffect(() => {
    setError(undefined);
    setConfirmFullAccess(false);
    setSavedMode(undefined);
    setLoading(false);
    if (!supported) return;
    if (runtimeId === "claude-desktop") {
      setMode(claudeMode);
      setSavedMode(claudeMode);
      return;
    }
    if (!sessionId) return;
    let active = true;
    setLoading(true);
    void onLoadSessionConfiguration(sessionId)
      .then((configuration) => {
        if (!active) return;
        if (!configuration.permissionPolicy) throw new Error("电脑未返回授权配置");
        setMode(configuration.permissionPolicy.hostMode);
        setSavedMode(configuration.permissionPolicy.hostMode);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : "默认授权读取失败");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [hostId, runtimeId, sessionId, claudeMode, supported, onLoadSessionConfiguration]);

  useEffect(() => {
    if (!confirmFullAccess) return;
    return registerMobileBackHandler(() => {
      if (!saving) setConfirmFullAccess(false);
      return true;
    }, 150);
  }, [confirmFullAccess, saving]);

  async function save(): Promise<void> {
    if (saving || savedMode === undefined) return;
    setSaving(true);
    setError(undefined);
    try {
      await onConfigureHostPermission(runtimeId, mode, runtimeId === "claude-desktop" ? undefined : sessionId);
      if (runtimeId === "claude-desktop") {
        setSavedMode(mode);
      } else {
        const configuration = await onLoadSessionConfiguration(sessionId!);
        if (!configuration.permissionPolicy) throw new Error("电脑未返回授权配置");
        setMode(configuration.permissionPolicy.hostMode);
        setSavedMode(configuration.permissionPolicy.hostMode);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "默认授权保存失败");
    } finally {
      setSaving(false);
      setConfirmFullAccess(false);
    }
  }

  return (
    <section className="mobile-settings-group host-permission-settings" aria-label="电脑默认授权">
      <header className="mobile-settings-row">
        <h3><ShieldCheck size={16} />电脑默认授权</h3>
      </header>
      <p className="mobile-settings-row">每个应用单独设置默认授权。会话内的授权设置会覆盖所属应用的默认值。</p>
      {!snapshot ? (
        <p className="mobile-settings-row">连接电脑后可设置默认授权。</p>
      ) : !supported ? (
        <p className="mobile-settings-row">这台电脑暂不支持默认授权设置，请更新电脑端 Bridge。</p>
      ) : (
        <>
          <div className="mobile-settings-row permission-scope-segments" role="group" aria-label="默认授权所属应用">
            {RUNTIME_IDS.filter((id) => id === "claude-desktop" || snapshot.runtimes?.some((runtime) => runtime.id === id)
              || snapshot.desktopApps?.some((app) => app.id === id)
              || snapshot.sessions.some((session) => session.runtimeId === id)).map((id) => (
              <button
                key={id}
                type="button"
                className={runtimeId === id ? "active" : ""}
                aria-pressed={runtimeId === id}
                disabled={saving}
                onClick={() => setRuntimeId(id)}
              >{desktopRuntimeName(id)}</button>
            ))}
          </div>
          <div className="mobile-settings-row"><strong>{runtimeName} 默认授权</strong></div>
          {runtimeId !== "claude-desktop" && !sessionId ? (
            <p className="mobile-settings-row">需要先在这台电脑上创建或同步一个 {runtimeName} 会话，才能读取和修改该应用的默认授权。</p>
          ) : loading ? (
            <p className="mobile-settings-row" role="status"><LoaderCircle className="is-spinning" size={15} />正在读取 {runtimeName} 默认授权</p>
          ) : (
            <div className="mobile-settings-row">
              <PermissionModeControls scope="host" value={mode} disabled={saving || savedMode === undefined} onChange={setMode} />
            </div>
          )}
          <p className="mobile-settings-row">仅影响这台电脑上的 {runtimeName} 会话，其他应用的默认授权保持各自设置。</p>
          {savedMode !== undefined && (
            <div className="mobile-settings-row">
              <button
                type="button"
                className="secondary-button"
                disabled={loading || saving || mode === savedMode}
                onClick={() => {
                  if (mode === "full-access" && savedMode !== "full-access") setConfirmFullAccess(true);
                  else void save();
                }}
              >
                {saving && <LoaderCircle className="is-spinning" size={15} />}
                保存 {runtimeName} 默认授权
              </button>
            </div>
          )}
          {error && <p className="mobile-settings-row session-configuration-error" role="alert">{error}</p>}
        </>
      )}
      <ConfirmationDialog
        open={confirmFullAccess}
        title={`为 ${runtimeName} 启用完全授权`}
        description={`这台电脑上的 ${runtimeName} 会话默认会自动批准命令和文件修改；已有会话的单独授权设置继续生效，${runtimeName} 的提问仍需你回答。`}
        confirmLabel="启用完全授权"
        busy={saving}
        onCancel={() => setConfirmFullAccess(false)}
        onConfirm={() => void save()}
      />
    </section>
  );
}
