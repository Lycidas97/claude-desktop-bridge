import type {
  BridgeSystemUpdateParams,
  BridgeUpdateChannel,
  BridgeUpdaterSnapshot,
  DesktopApi,
  DesktopControlSnapshot,
} from "@bridge/protocol";
import { ExternalLink, LoaderCircle, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  GITHUB_RELEASES_PAGE_URL,
  type useClientUpdater,
} from "../../lib/client-updater.js";
import { registerMobileBackHandler } from "../../lib/mobile-back-navigation.js";
import "./updater.css";

function formatDesktopUpdaterPhase(updater: BridgeUpdaterSnapshot | undefined): string {
  if (!updater) return "未启用";
  switch (updater.phase) {
    case "checking":
      return "正在检查…";
    case "up-to-date":
      return "已是最新";
    case "available":
    case "ready":
      return updater.latestVersion ? `发现 v${updater.latestVersion}` : "发现新版本";
    case "error":
      return "检查失败";
    default:
      return "待检查";
  }
}

function safeReleaseHref(url: string | undefined): string {
  return url && /^https:\/\//iu.test(url) ? url : GITHUB_RELEASES_PAGE_URL;
}

export function DesktopUpdaterSection({
  snapshot,
  api,
  onSnapshot,
}: {
  snapshot: DesktopControlSnapshot;
  api: DesktopApi;
  onSnapshot(snapshot: DesktopControlSnapshot): void;
}) {
  const updater = snapshot.updater;
  const [busyAction, setBusyAction] = useState<BridgeSystemUpdateParams["action"]>();
  const [localError, setLocalError] = useState("");

  if (!updater) return null;

  async function invokeUpdate(params: BridgeSystemUpdateParams) {
    setBusyAction(params.action);
    setLocalError("");
    try {
      const response = await api.request({
        method: "system.update",
        params: { ...params } as Record<string, unknown>,
      });
      if (!response.ok) {
        throw new Error(response.error?.message ?? "更新操作失败");
      }
      onSnapshot(await api.getSnapshot());
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(undefined);
    }
  }

  const isWorking = Boolean(busyAction) || updater.phase === "checking";
  const hasAvailableUpdate = updater.phase === "available" || updater.phase === "ready";
  const releaseHref = safeReleaseHref(updater.releaseUrl);

  return (
    <section className="provider-settings-profile" aria-label="版本更新">
      <div className="settings-section-heading">
        <h3>版本更新</h3>
        <span className={hasAvailableUpdate ? "updater-badge-available" : undefined}>
          {formatDesktopUpdaterPhase(updater)}
        </span>
      </div>

      <label className="toggle-row">
        <span>
          <strong>自动检查更新</strong>
          <small>后台定期从 GitHub Releases 检查新版本</small>
        </span>
        <input
          type="checkbox"
          checked={updater.autoCheck}
          disabled={isWorking}
          onChange={(event) => void invokeUpdate({ action: "configure", autoCheck: event.target.checked })}
        />
        <i aria-hidden="true" />
      </label>

      <div className="mobile-settings-row">
        <span>更新通道</span>
        <div className="segmented" role="group" aria-label="桌面端更新通道">
          {(["stable", "prerelease"] as const).map((ch) => (
            <button
              type="button"
              key={ch}
              className={updater.channel === ch ? "active" : ""}
              aria-pressed={updater.channel === ch}
              disabled={isWorking}
              onClick={() => void invokeUpdate({ action: "configure", channel: ch })}
            >
              {ch === "stable" ? "稳定版" : "预发布"}
            </button>
          ))}
        </div>
      </div>

      {updater.statusDetail && updater.phase !== "error" && (
        <p role="status" className="settings-notice">{updater.statusDetail}</p>
      )}
      {updater.releaseNotes && hasAvailableUpdate && (
        <details className="settings-detection">
          <summary>v{updater.latestVersion} 更新说明</summary>
          <div className="updater-release-notes">{updater.releaseNotes}</div>
        </details>
      )}
      {(localError || updater.error) && (
        <p role="alert" className="inline-error">{localError || updater.error}</p>
      )}

      <div className="settings-inline-actions">
        <button
          type="button"
          className="secondary-button"
          disabled={isWorking}
          onClick={() => void invokeUpdate({ action: "check" })}
        >
          {updater.phase === "checking" || busyAction === "check" ? <LoaderCircle className="is-spinning" size={15} /> : <RefreshCw size={15} />}
          检查更新
        </button>

        {hasAvailableUpdate ? (
          <a
            className="primary-button"
            href={releaseHref}
            target="_blank"
            rel="noopener noreferrer"
          >
            <ExternalLink size={15} />
            前往下载{updater.latestVersion ? ` v${updater.latestVersion}` : ""}
          </a>
        ) : (
          <a
            className="secondary-button"
            href={releaseHref}
            target="_blank"
            rel="noopener noreferrer"
          >
            <ExternalLink size={15} />
            GitHub Releases
          </a>
        )}
      </div>
    </section>
  );
}

export interface RemoteDesktopUpdateControl {
  hostVersion: string;
  connected: boolean;
  supported: boolean;
  updater?: BridgeUpdaterSnapshot | undefined;
  onInvoke(params: BridgeSystemUpdateParams): Promise<BridgeUpdaterSnapshot>;
}

export function RemoteDesktopUpdaterSection({
  remote,
  heading = "远端桌面状态",
}: {
  remote: RemoteDesktopUpdateControl;
  heading?: string;
}) {
  const [busyAction, setBusyAction] = useState<BridgeSystemUpdateParams["action"]>();
  const [error, setError] = useState("");
  const headingId = "remote-desktop-updater-title";
  const updater = remote.updater;
  const isBusy = Boolean(busyAction) || updater?.phase === "checking";

  async function run(params: BridgeSystemUpdateParams) {
    if (!remote.connected || !remote.supported) return;
    setBusyAction(params.action);
    setError("");
    try {
      await remote.onInvoke(params);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(undefined);
    }
  }

  return (
    <section className="mobile-settings-group" aria-labelledby={headingId}>
      <h2 id={headingId}>{heading}</h2>
      <div className="mobile-settings-row">
        <span>桌面端版本</span>
        <span className="mobile-settings-value">v{remote.hostVersion}</span>
      </div>
      <div className="mobile-settings-row">
        <span>更新状态</span>
        <span className={`mobile-settings-value ${updater?.phase === "available" || updater?.phase === "ready" ? "updater-badge-available" : ""}`}>
          {!remote.supported
            ? "旧版桌面端不支持远程检查"
            : !remote.connected
              ? "离线"
              : formatDesktopUpdaterPhase(updater)}
        </span>
      </div>
      {remote.supported && updater && (
        <div className="mobile-settings-row">
          <span>更新通道</span>
          <div className="segmented" role="group" aria-label="远端桌面更新通道">
            {(["stable", "prerelease"] as const).map((ch) => (
              <button
                type="button"
                key={ch}
                className={updater.channel === ch ? "active" : ""}
                aria-pressed={updater.channel === ch}
                disabled={!remote.connected || isBusy}
                onClick={() => {
                  if (updater.channel === ch) return;
                  void run({ action: "check", channel: ch });
                }}
              >
                {ch === "stable" ? "稳定版" : "预发布"}
              </button>
            ))}
          </div>
        </div>
      )}
      {updater?.statusDetail && updater.phase !== "error" && (
        <p className="mobile-settings-row detail-text" role="status">{updater.statusDetail}</p>
      )}
      {(error || updater?.error) && (
        <p className="mobile-settings-row updater-error" role="alert">{error || updater?.error}</p>
      )}
      {remote.supported && (
        <div className="mobile-settings-row mobile-settings-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={!remote.connected || isBusy}
            onClick={() => void run({ action: "check" })}
          >
            {updater?.phase === "checking" || busyAction === "check" ? <LoaderCircle className="is-spinning" size={16} /> : <RefreshCw size={16} />}
            检查更新
          </button>
        </div>
      )}
    </section>
  );
}

export type ClientUpdaterHandle = ReturnType<typeof useClientUpdater>;

export function MobileClientUpdaterSection({ updater }: { updater: ClientUpdaterHandle }) {
  const { state } = updater;
  const titleId = "mobile-client-updater-title";
  const isBusy = state.phase === "checking";

  return (
    <section className="mobile-settings-group" aria-labelledby={titleId}>
      <h2 id={titleId}>版本与更新</h2>
      <div className="mobile-settings-row">
        <span>当前版本</span>
        <span className="mobile-settings-value">v{state.currentVersion}</span>
      </div>
      <div className="mobile-settings-row">
        <span>更新通道</span>
        <div className="segmented" role="group" aria-label="客户端更新通道">
          {(["stable", "prerelease"] as readonly BridgeUpdateChannel[]).map((ch) => (
            <button
              type="button"
              key={ch}
              className={state.channel === ch ? "active" : ""}
              aria-pressed={state.channel === ch}
              disabled={isBusy}
              onClick={() => updater.setChannel(ch)}
            >
              {ch === "stable" ? "稳定版" : "预发布"}
            </button>
          ))}
        </div>
      </div>

      {state.nativeSupported ? (
        <>
          <label className="mobile-settings-row toggle-row">
            <span><strong>启动时自动检查</strong></span>
            <input
              type="checkbox"
              checked={state.autoCheck}
              onChange={(event) => updater.setAutoCheck(event.target.checked)}
            />
            <i aria-hidden="true" />
          </label>
          {state.statusDetail && state.phase !== "error" && (
            <p className="mobile-settings-row detail-text" role="status">{state.statusDetail}</p>
          )}
          {state.error && <p className="mobile-settings-row updater-error" role="alert">{state.error}</p>}
          <div className="mobile-settings-row mobile-settings-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={isBusy}
              onClick={() => void updater.check(true)}
            >
              {state.phase === "checking" ? <LoaderCircle className="is-spinning" size={16} /> : <RefreshCw size={16} />}
              检查更新
            </button>
            {state.phase === "available" && state.latestVersion && (
              <button
                type="button"
                className="primary-button"
                disabled={isBusy}
                onClick={() => void updater.openReleasesPage()}
              >
                <ExternalLink size={16} />
                前往下载 v{state.latestVersion}
              </button>
            )}
          </div>
        </>
      ) : (
        <>
          <p className="mobile-settings-row detail-text">Web 访问端请前往 GitHub Releases 获取各平台最新安装包。</p>
          <div className="mobile-settings-row mobile-settings-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={() => void updater.openReleasesPage(GITHUB_RELEASES_PAGE_URL)}
            >
              <ExternalLink size={16} />
              查看 GitHub Releases
            </button>
          </div>
        </>
      )}
    </section>
  );
}

export function MobileClientUpdateDialog({ updater }: { updater: ClientUpdaterHandle }) {
  const { state } = updater;
  const titleId = "mobile-client-update-dialog-title";
  const open = state.nativeSupported && state.promptOpen && Boolean(state.latestVersion);

  useEffect(() => {
    if (!open) return;
    return registerMobileBackHandler(() => {
      updater.dismissPrompt();
      return true;
    }, 220);
  }, [open, updater]);

  if (!open) return null;

  return createPortal(
    <div
      className="confirm-backdrop"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) updater.dismissPrompt();
      }}
    >
      <section
        className="confirm-dialog updater-dialog-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <h2 id={titleId}>发现新版本 v{state.latestVersion}</h2>
        <p className="detail-text">当前版本 v{state.currentVersion}</p>
        {state.releaseNotes && (
          <div className="updater-release-notes">{state.releaseNotes}</div>
        )}
        {state.error && (
          <p className="inline-error" role="alert">{state.error}</p>
        )}
        <div className="confirm-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={() => updater.dismissPrompt()}
          >
            稍后
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={state.phase === "checking"}
            onClick={() => {
              const targetUrl = state.releaseUrl;
              updater.dismissPrompt();
              void updater.openReleasesPage(targetUrl);
            }}
          >
            <ExternalLink size={16} />
            前往发布页下载
          </button>
        </div>
      </section>
    </div>,
    document.body,
  );
}
