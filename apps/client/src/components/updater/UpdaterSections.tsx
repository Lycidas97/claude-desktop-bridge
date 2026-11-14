import type {
  BridgeSystemUpdateParams,
  BridgeUpdateChannel,
  BridgeUpdaterSnapshot,
  DesktopApi,
  DesktopControlSnapshot,
} from "@bridge/protocol";
import { Download, ExternalLink, LoaderCircle, RefreshCw, RotateCw } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  GITHUB_RELEASES_PAGE_URL,
  type useClientUpdater,
} from "../../lib/client-updater.js";
import { registerMobileBackHandler } from "../../lib/mobile-back-navigation.js";
import { formatBytes } from "../../lib/media-preview.js";
import "./updater.css";

function progressPercent(downloaded?: number, total?: number): number | undefined {
  if (downloaded === undefined || !total || total <= 0) return undefined;
  return Math.min(100, Math.round((downloaded / total) * 100));
}

function osInstallBoundaryHint(updater: BridgeUpdaterSnapshot): string | undefined {
  if (updater.canAutoRestart) return undefined;
  if (updater.platform === "darwin") {
    return "macOS 未公证/DMG 包不支持后台静默覆盖系统目录，下载完成后需在电脑上打开 DMG 替换应用。";
  }
  if (updater.platform === "linux") {
    return "Linux 系统安装包需本机包管理权限，下载完成后请在电脑上完成安装。";
  }
  return "当前安装目录需要本机管理员权限确认，不支持免交互静默升级。";
}

function formatDesktopUpdaterPhase(updater: BridgeUpdaterSnapshot | undefined): string {
  if (!updater) return "未启用";
  switch (updater.phase) {
    case "checking":
      return "正在检查…";
    case "up-to-date":
      return "已是最新";
    case "available":
      return updater.latestVersion ? `发现 v${updater.latestVersion}` : "发现新版本";
    case "downloading": {
      const pct = progressPercent(updater.downloadedBytes, updater.totalBytes);
      return pct !== undefined ? `正在下载 ${pct}%` : "正在下载…";
    }
    case "ready":
      if (updater.waitingForIdle) return `等待空闲重启 (v${updater.latestVersion ?? ""})`;
      return updater.latestVersion ? `已就绪 v${updater.latestVersion}` : "安装包已就绪";
    case "applying":
      return "正在重启升级…";
    case "error":
      return "检查或下载失败";
    default:
      return "待检查";
  }
}

function ProgressBar({ downloadedBytes, totalBytes }: { downloadedBytes?: number | undefined; totalBytes?: number | undefined }) {
  const pct = progressPercent(downloadedBytes, totalBytes);
  return (
    <div className="updater-progress-wrap" role="status" aria-live="polite">
      <div className="updater-progress-track">
        <div
          className="updater-progress-fill"
          style={{ width: `${pct ?? 25}%` }}
        />
      </div>
      <div className="updater-progress-meta">
        <span>{formatBytes(downloadedBytes ?? 0)}{totalBytes ? ` / ${formatBytes(totalBytes)}` : ""}</span>
        {pct !== undefined && <span>{pct}%</span>}
      </div>
    </div>
  );
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

  const isWorking = Boolean(busyAction) || updater.phase === "checking" || updater.phase === "downloading" || updater.phase === "applying";
  const applyButtonLabel = updater.canAutoRestart
    ? `重启并升级${updater.latestVersion ? ` v${updater.latestVersion}` : ""}`
    : updater.platform === "darwin"
      ? `打开安装包${updater.latestVersion ? ` (v${updater.latestVersion})` : ""}`
      : "在文件夹中显示安装包";

  return (
    <section className="provider-settings-profile" aria-label="版本更新">
      <div className="settings-section-heading">
        <h3>版本更新</h3>
        <span className={updater.phase === "available" || updater.phase === "ready" ? "updater-badge-available" : undefined}>
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

      <div className="mobile-settings-row">
        <span>下载完成后</span>
        <div className="segmented" role="group" aria-label="下载完成后更新方式">
          <button
            type="button"
            className={updater.applyMode === "prompt" || !updater.canAutoRestart ? "active" : ""}
            aria-pressed={updater.applyMode === "prompt" || !updater.canAutoRestart}
            disabled={isWorking}
            onClick={() => void invokeUpdate({ action: "configure", applyMode: "prompt" })}
          >
            提示更新
          </button>
          <button
            type="button"
            className={updater.canAutoRestart && updater.applyMode === "silent-idle" ? "active" : ""}
            aria-pressed={updater.canAutoRestart && updater.applyMode === "silent-idle"}
            disabled={isWorking || !updater.canAutoRestart}
            title={osInstallBoundaryHint(updater)}
            onClick={() => void invokeUpdate({ action: "configure", applyMode: "silent-idle" })}
          >
            空闲静默重启
          </button>
        </div>
      </div>

      {!updater.canAutoRestart && (
        <p className="settings-notice">{osInstallBoundaryHint(updater)}</p>
      )}
      {updater.statusDetail && updater.phase !== "error" && (
        <p role="status" className="settings-notice">{updater.statusDetail}</p>
      )}
      {updater.phase === "downloading" && (
        <ProgressBar downloadedBytes={updater.downloadedBytes} totalBytes={updater.totalBytes} />
      )}
      {updater.releaseNotes && (updater.phase === "available" || updater.phase === "ready") && (
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

        {updater.phase === "available" && updater.assetName && (
          <button
            type="button"
            className="primary-button"
            disabled={isWorking}
            onClick={() => void invokeUpdate({ action: "download" })}
          >
            <Download size={15} />
            下载 v{updater.latestVersion}
          </button>
        )}

        {updater.phase === "ready" && (
          <button
            type="button"
            className="primary-button"
            disabled={isWorking}
            onClick={() => void invokeUpdate({ action: "apply" })}
          >
            <RotateCw size={15} />
            {applyButtonLabel}
          </button>
        )}

        <a
          className="secondary-button"
          href={updater.releaseUrl ?? GITHUB_RELEASES_PAGE_URL}
          target="_blank"
          rel="noopener noreferrer"
        >
          <ExternalLink size={15} />
          GitHub Releases
        </a>
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
  const isBusy = Boolean(busyAction) || updater?.phase === "checking" || updater?.phase === "downloading" || updater?.phase === "applying";

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
            ? "旧版桌面端不支持远程升级"
            : !remote.connected
              ? "离线"
              : formatDesktopUpdaterPhase(updater)}
        </span>
      </div>
      {updater?.statusDetail && updater.phase !== "error" && (
        <p className="mobile-settings-row detail-text" role="status">{updater.statusDetail}</p>
      )}
      {updater && !updater.canAutoRestart && (updater.phase === "available" || updater.phase === "ready") && (
        <p className="mobile-settings-row detail-text">{osInstallBoundaryHint(updater)}</p>
      )}
      {updater?.phase === "downloading" && (
        <div className="mobile-settings-row">
          <ProgressBar downloadedBytes={updater.downloadedBytes} totalBytes={updater.totalBytes} />
        </div>
      )}
      {(error || updater?.error) && (
        <p className="mobile-settings-row inline-error" role="alert">{error || updater?.error}</p>
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
          {updater?.phase === "ready" && updater.canAutoRestart ? (
            <button
              type="button"
              className="primary-button"
              disabled={!remote.connected || isBusy}
              onClick={() => void run({ action: "apply" })}
            >
              <RotateCw size={16} />
              重启升级桌面端
            </button>
          ) : updater?.phase === "available" && updater.assetName && !updater.canAutoRestart ? (
            <button
              type="button"
              className="primary-button"
              disabled={!remote.connected || isBusy}
              onClick={() => void run({ action: "download" })}
            >
              <Download size={16} />
              下载至远端电脑
            </button>
          ) : (
            <button
              type="button"
              className="primary-button"
              disabled={!remote.connected || isBusy || (updater !== undefined && !updater.canAutoRestart && updater.phase === "ready")}
              onClick={() => void run({ action: updater?.canAutoRestart === false ? "download" : "apply" })}
            >
              <RotateCw size={16} />
              {updater?.canAutoRestart === false ? "检查并下载" : "检查并升级桌面端"}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

export type ClientUpdaterHandle = ReturnType<typeof useClientUpdater>;

export function MobileClientUpdaterSection({ updater }: { updater: ClientUpdaterHandle }) {
  const { state } = updater;
  const titleId = "mobile-client-updater-title";
  const isBusy = state.phase === "checking" || state.phase === "downloading";

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
          {state.phase === "downloading" && (
            <div className="mobile-settings-row">
              <ProgressBar downloadedBytes={state.downloadedBytes} totalBytes={state.totalBytes} />
            </div>
          )}
          {state.error && <p className="mobile-settings-row inline-error" role="alert">{state.error}</p>}
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
            {(state.phase === "available" || state.phase === "ready" || state.phase === "awaiting-permission") && (
              <button
                type="button"
                className="primary-button"
                disabled={isBusy}
                onClick={() => updater.openPrompt()}
              >
                <Download size={16} />
                {state.phase === "awaiting-permission"
                  ? "授权并继续安装"
                  : state.phase === "ready"
                    ? "立即安装"
                    : `更新 v${state.latestVersion}`}
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
  const isDownloading = state.phase === "downloading";

  useEffect(() => {
    if (!open) return;
    return registerMobileBackHandler(() => {
      if (!isDownloading) updater.dismissPrompt();
      return true;
    }, 220);
  }, [open, isDownloading, updater]);

  if (!open) return null;

  return createPortal(
    <div
      className="confirm-backdrop"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target && !isDownloading) updater.dismissPrompt();
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
        {state.phase === "downloading" && (
          <ProgressBar downloadedBytes={state.downloadedBytes} totalBytes={state.totalBytes} />
        )}
        {state.phase === "awaiting-permission" && state.statusDetail && (
          <p className="detail-text" role="status">{state.statusDetail}</p>
        )}
        {state.error && (
          <p className="inline-error" role="alert">{state.error}</p>
        )}
        <div className="confirm-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={isDownloading}
            onClick={() => updater.dismissPrompt()}
          >
            稍后
          </button>
          {state.assetName ? (
            <button
              type="button"
              className="primary-button"
              disabled={isDownloading || state.phase === "checking"}
              onClick={() => void updater.downloadAndInstall()}
            >
              {isDownloading
                ? "正在下载…"
                : state.phase === "awaiting-permission"
                  ? "前往授权安装"
                  : state.phase === "ready"
                    ? "立即安装"
                    : "下载并安装"}
            </button>
          ) : (
            <button
              type="button"
              className="primary-button"
              onClick={() => void updater.openReleasesPage()}
            >
              前往 GitHub 下载
            </button>
          )}
        </div>
      </section>
    </div>,
    document.body,
  );
}
