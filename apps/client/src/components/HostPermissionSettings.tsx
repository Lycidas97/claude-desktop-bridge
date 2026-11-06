import type {
  BridgeDesktopRuntimeId,
  BridgeHostSnapshot,
  BridgePermissionMode,
  BridgeSessionConfiguration,
} from "@bridge/protocol";
import { LoaderCircle } from "lucide-react";
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
  connected = true,
  onLoadSessionConfiguration,
  onConfigureHostPermission,
}: {
  snapshot?: BridgeHostSnapshot;
  connected?: boolean;
  onLoadSessionConfiguration(sessionId: string): Promise<BridgeSessionConfiguration>;
  onConfigureHostPermission(
    runtimeId: BridgeDesktopRuntimeId,
    mode: BridgePermissionMode,
    sessionId?: string,
  ): Promise<BridgePermissionMode | void>;
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
  const runtimeDefaults = snapshot?.host.capabilities.includes("permission.runtime-defaults.v1") ?? false;
  const runtimeMode = snapshot?.runtimes?.find((runtime) => runtime.id === runtimeId)?.defaultPermissionMode;

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
    if (runtimeDefaults) {
      if (runtimeMode !== undefined) {
        setMode(runtimeMode);
        setSavedMode(runtimeMode);
      }
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
  }, [hostId, runtimeId, sessionId, claudeMode, runtimeMode, runtimeDefaults, supported, onLoadSessionConfiguration]);

  useEffect(() => {
    if (!confirmFullAccess) return;
    return registerMobileBackHandler(() => {
      if (!saving) setConfirmFullAccess(false);
      return true;
    }, 150);
  }, [confirmFullAccess, saving]);

  async function save(): Promise<void> {
    if (!connected || saving || savedMode === undefined) return;
    setSaving(true);
    setError(undefined);
    try {
      const confirmed = await onConfigureHostPermission(runtimeId, mode, runtimeDefaults || runtimeId === "claude-desktop" ? undefined : sessionId);
      if (runtimeDefaults || runtimeId === "claude-desktop") {
        setMode(confirmed ?? mode);
        setSavedMode(confirmed ?? mode);
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

  const runtimeIds = snapshot ? RUNTIME_IDS.filter((id) => id === "claude-desktop"
    || snapshot.runtimes?.some((runtime) => runtime.id === id)
    || snapshot.desktopApps?.some((app) => app.id === id)
    || snapshot.sessions.some((session) => session.runtimeId === id)) : [];

  return (
    <section className="mobile-settings-group host-permission-settings" aria-labelledby="host-permission-title">
      <h2 id="host-permission-title">电脑默认授权</h2>
      {!snapshot ? (
        <p className="mobile-settings-row">连接电脑后可设置默认授权。</p>
      ) : !supported ? (
        <p className="mobile-settings-row">这台电脑暂不支持默认授权设置，请更新电脑端 Bridge。</p>
      ) : (
        <>
          {runtimeIds.length > 1 && (
            <div className="mobile-settings-row">
              <div className="permission-scope-segments" role="group" aria-label="默认授权所属应用">
                {runtimeIds.map((id) => (
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
            </div>
          )}
          <div className="mobile-settings-row">
            <span>
              <strong>{runtimeName} 默认授权</strong>
              <small>仅影响这台电脑上的 {runtimeName} 会话，其他应用的默认授权保持各自设置。</small>
            </span>
          </div>
          {!connected && <p className="mobile-settings-row" role="status">电脑未连接，显示上次确认的默认授权。</p>}
          {runtimeId !== "claude-desktop" && !runtimeDefaults && !sessionId ? (
            <p className="mobile-settings-row">需要先在这台电脑上创建或同步一个 {runtimeName} 会话，才能读取和修改该应用的默认授权。更新电脑端 Bridge 后可直接设置。</p>
          ) : loading ? (
            <p className="mobile-settings-row" role="status"><LoaderCircle className="is-spinning" size={15} />正在读取 {runtimeName} 默认授权</p>
          ) : (
            <div className="mobile-settings-row">
              <PermissionModeControls scope="host" value={mode} disabled={!connected || saving || savedMode === undefined} onChange={setMode} />
            </div>
          )}
          {savedMode !== undefined && (
            <div className="mobile-settings-row mobile-settings-actions">
              <button
                type="button"
                className="secondary-button"
                disabled={!connected || loading || saving || mode === savedMode}
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
        </>
      )}
      <p>每个应用单独设置默认授权。会话内的授权设置会覆盖所属应用的默认值。</p>
      {error && <p className="inline-error" role="alert">{error}</p>}
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
