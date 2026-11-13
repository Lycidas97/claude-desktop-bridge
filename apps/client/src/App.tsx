import type { BridgeSystemUpdateParams, BridgeUpdaterSnapshot } from "@bridge/protocol";
import { useCallback, useEffect, useMemo, useState } from "react";
import { claudeSnapshot } from "./lib/claude-snapshot.js";
import { useClientUpdater } from "./lib/client-updater.js";
import { useTheme } from "./hooks/useTheme.js";
import { useMobileBridge } from "./hooks/useMobileBridge.js";
import {
  installMobileBackNavigation,
  registerMobileBackHandler,
} from "./lib/mobile-back-navigation.js";
import { onSessionNotificationTap } from "./lib/session-notifications.js";
import { DesktopDashboard } from "./components/DesktopDashboard.js";
import { DiagnosticFloatingEntry } from "./components/common/DiagnosticLogDialog.js";
import { HostBrowser } from "./components/pairing/HostBrowser.js";
import { MobileWorkspace } from "./components/MobileWorkspace.js";
import { PairingScreen } from "./components/pairing/PairingScreen.js";
import { PairingSyncScreen } from "./components/pairing/PairingSyncScreen.js";
import { MediaPreviewProvider } from "./components/evidence/MediaPreviewProvider.js";
import { MobileAppShell, type MobileTab } from "./components/mobile/MobileAppShell.js";
import { MobileHostDetails } from "./components/pairing/MobileHostDetails.js";
import { MobilePageHeader } from "./components/mobile/MobilePageHeader.js";
import { MobileQuotaPage } from "./components/mobile/MobileQuotaPage.js";
import { MobileSettings } from "./components/mobile/MobileSettings.js";
import { ProviderSettings } from "./components/session/ProviderSettings.js";
import { MobileClientUpdateDialog, type RemoteDesktopUpdateControl } from "./components/updater/UpdaterSections.js";
import { MAGPIE_QUOTA_METHOD, type QuotaLoader, type QuotaSnapshot } from "../../../plugins/magpie-quota/contract.js";
import { MagpieQuotaProvider } from "../../../plugins/magpie-quota/client.js";

export function App() {
  const themeControl = useTheme();
  const mobile = useMobileBridge();
  const clientUpdater = useClientUpdater(!window.bridgeDesktop);
  const snapshot = useMemo(() => mobile.state.snapshot
    ? claudeSnapshot(mobile.state.snapshot)
    : undefined, [mobile.state.snapshot]);
  const [pairingOpen, setPairingOpen] = useState(false);
  const [tab, setTab] = useState<MobileTab>("sessions");
  const [computerDetailsHostId, setComputerDetailsHostId] = useState<string>();
  const [quotaOpen, setQuotaOpen] = useState(false);
  const [providersOpen, setProvidersOpen] = useState(false);
  const [focusRequest, setFocusRequest] = useState<{ sessionId: string; key: number }>();
  const [directoryRequest, setDirectoryRequest] = useState(0);
  const handleFocusHandled = useCallback(() => setFocusRequest(undefined), []);
  // requestMedia is the hook's plain request function; its identity never changes.
  const request = mobile.requestMedia;
  const loadMagpieQuota = useCallback<QuotaLoader>(async (options) => {
    // Manual refresh has a shared 60 s desktop budget; ordinary reads still use 15 s.
    const response = await request(MAGPIE_QUOTA_METHOD, { refresh: options?.refresh ?? false }, {
      wait: true, allowOffline: false, timeoutMs: options?.refresh ? 75_000 : 30_000,
    });
    if (!response?.ok) throw new Error(response?.error?.message ?? "Magpie 额度读取失败");
    return response.result as QuotaSnapshot;
  }, [request]);
  // A computer without the plugin answers its method with an error, so ask only one that declares it.
  const quotaDeclared = Boolean(mobile.state.snapshot?.host.capabilities.includes("plugin.magpie-quota.v1"));
  const quotaEnabled = mobile.state.connection === "connected" && mobile.state.desktopOnline && quotaDeclared;
  const closeQuota = useCallback(() => setQuotaOpen(false), []);
  const invokeRemoteUpdate = useCallback(async (params: BridgeSystemUpdateParams): Promise<BridgeUpdaterSnapshot> => {
    const response = await request("system.update", params as unknown as Record<string, unknown>, {
      wait: true,
      allowOffline: false,
      timeoutMs: 45_000,
    });
    if (!response?.ok) throw new Error(response?.error?.message ?? "远端桌面更新指令执行失败");
    return response.result as BridgeUpdaterSnapshot;
  }, [request]);
  const remoteDesktopUpdate = useMemo<RemoteDesktopUpdateControl | undefined>(() => {
    const rawHost = mobile.state.snapshot;
    if (!mobile.state.activeHostId || !rawHost) return undefined;
    return {
      hostVersion: rawHost.host.version,
      connected: mobile.state.connection === "connected" && mobile.state.desktopOnline,
      supported: rawHost.host.capabilities.includes("system.update.v1"),
      updater: rawHost.updater,
      onInvoke: invokeRemoteUpdate,
    };
  }, [
    invokeRemoteUpdate,
    mobile.state.activeHostId,
    mobile.state.connection,
    mobile.state.desktopOnline,
    mobile.state.snapshot,
  ]);

  async function openComputer(hostId: string, sessionId?: string): Promise<void> {
    if (hostId !== mobile.state.activeHostId) await mobile.selectHost(hostId);
    if (sessionId) setFocusRequest({ sessionId, key: Date.now() });
    else setDirectoryRequest(value => value + 1);
    setComputerDetailsHostId(undefined);
    setTab("sessions");
  }

  useEffect(() => installMobileBackNavigation(), []);

  // openComputer only reads activeHostId and the stable selectHost callback.
  useEffect(() => onSessionNotificationTap(({ hostId, sessionId }) => {
    void openComputer(hostId, sessionId);
  }), [mobile.state.activeHostId, mobile.selectHost]);

  useEffect(() => registerMobileBackHandler(() => {
    if (window.bridgeDesktop) return false;
    // The secure import must finish before a back gesture can change route.
    if (mobile.state.pairingSync) return true;
    if (pairingOpen && mobile.state.hosts.length > 0) {
      setPairingOpen(false);
      return true;
    }
    if (mobile.state.hosts.length === 0) return false;
    if (tab === "computers" && computerDetailsHostId) {
      setComputerDetailsHostId(undefined);
      return true;
    }
    if (providersOpen || quotaOpen) {
      setProvidersOpen(false);
      setQuotaOpen(false);
      return true;
    }
    if (tab !== "sessions") {
      setComputerDetailsHostId(undefined);
      setQuotaOpen(false);
      setDirectoryRequest(value => value + 1);
      setTab("sessions");
      return true;
    }
    return false;
  }, -100), [
    computerDetailsHostId,
    mobile.state.hosts.length,
    mobile.state.pairingSync,
    pairingOpen,
    providersOpen,
    quotaOpen,
    tab,
  ]);

  if (window.bridgeDesktop) return <DesktopDashboard themeControl={themeControl} />;
  if (mobile.state.pairingSync) {
    return (
      <>
        <PairingSyncScreen sync={mobile.state.pairingSync} />
        <MobileClientUpdateDialog updater={clientUpdater} />
        <DiagnosticFloatingEntry />
      </>
    );
  }
  if (mobile.state.loading && mobile.state.hosts.length === 0 && !pairingOpen) {
    return (
      <>
        <main className="mobile-loading"><span className="spinner" /><span>正在读取已配对电脑</span></main>
        <MobileClientUpdateDialog updater={clientUpdater} />
        <DiagnosticFloatingEntry />
      </>
    );
  }
  if (pairingOpen || mobile.state.hosts.length === 0) {
    return (
      <>
        <PairingScreen
          loading={mobile.state.loading}
          error={mobile.state.error}
          onPair={async (pairing) => {
            if (await mobile.pair(pairing)) {
              setPairingOpen(false);
              setTab("sessions");
            }
          }}
          {...(mobile.state.hosts.length > 0 ? { onCancel: () => setPairingOpen(false) } : {})}
        />
        <MobileClientUpdateDialog updater={clientUpdater} />
        <DiagnosticFloatingEntry />
      </>
    );
  }
  return (
    <MobileAppShell
      tab={tab}
      onTabChange={(next) => {
        setComputerDetailsHostId(undefined);
        setQuotaOpen(false);
        setProvidersOpen(false);
        if (next === "sessions") setDirectoryRequest(value => value + 1);
        setTab(next);
      }}
    >
      {/* One quota snapshot per computer, shared by the session form and the settings dashboard. */}
      <MagpieQuotaProvider key={mobile.state.activeHostId ?? ""} loader={loadMagpieQuota} enabled={quotaEnabled} sourceKey={snapshot?.runtime.detection?.refreshedAt ?? 0}>
      {mobile.state.activeHostId ? (
        <div className="mobile-tab-page" hidden={tab !== "sessions"}>
          <MediaPreviewProvider key={mobile.state.activeHostId} request={mobile.requestMedia} supportsFileStat={snapshot?.host.capabilities.includes("artifact.transfer.stat.v1") ?? false}>
            <MobileWorkspace
              visible={tab === "sessions"}
              {...(focusRequest ? { focusRequest } : {})}
              onFocusHandled={handleFocusHandled}
              directoryRequest={directoryRequest}
              key={mobile.state.activeHostId}
              activeHostId={mobile.state.activeHostId}
              desktopName={mobile.state.desktopName ?? "我的电脑"}
              connection={mobile.state.connection}
              desktopOnline={mobile.state.desktopOnline}
              snapshot={snapshot}
              permissions={mobile.state.permissions.filter((permission) => snapshot?.sessions.some((session) => session.sessionId === permission.sessionId))}
              focusSessionId={mobile.state.focusSessionId}
              histories={mobile.state.histories}
              evidence={mobile.state.evidence}
              artifactPreviews={mobile.state.artifactPreviews}
              artifactTransfers={mobile.state.artifactTransfers}
              events={mobile.state.events}
              localTurns={mobile.state.localTurns}
              connectionIssue={mobile.state.connectionIssue}
              onInspectConnection={() => {
                setComputerDetailsHostId(mobile.state.activeHostId);
                setTab("computers");
              }}
              transportMetrics={mobile.state.transportMetrics}
              pendingOutbound={mobile.state.pendingOutbound}
              themeControl={themeControl}
              onOpenSession={mobile.openSession}
              onLoadOlderHistory={mobile.loadOlderHistory}
              onLoadOlderEvidence={mobile.loadOlderEvidence}
              onLoadEvidenceDetails={mobile.loadEvidenceDetails}
              onPreviewArtifact={mobile.previewArtifact}
              onDownloadArtifact={mobile.downloadArtifact}
              onDownloadSessionFile={mobile.downloadSessionFile}
              onUploadFile={mobile.uploadFile}
              onSendTurn={mobile.sendTurn}
              onInterruptTurn={mobile.interruptTurn}
              {...(mobile.state.snapshot?.host.capabilities.includes("turn.queue.steer.v1")
                ? { onSteerQueuedTurn: mobile.steerQueuedTurn }
                : {})}
              {...(mobile.state.snapshot?.host.capabilities.includes("turn.queue.cancel.v1")
                ? { onCancelQueuedTurn: mobile.cancelQueuedTurn }
                : {})}
              {...(mobile.state.snapshot?.host.capabilities.includes("subagent.stop.v1")
                ? { onStopSubagent: mobile.stopSubagent }
                : {})}
              onResolveUncertain={mobile.resolveUncertainDelivery}
              onResolvePermission={mobile.resolvePermission}
              onCreateSession={mobile.createSession}
              {...(snapshot?.host.capabilities.includes("section.create.v1") ? { onCreateSection: mobile.createSection } : {})}
              {...(snapshot?.host.capabilities.includes("section.move.v1") ? { onMoveSessionSection: mobile.moveSessionSection } : {})}
              {...(snapshot?.host.capabilities.includes("section.rename.v1") ? { onRenameSection: mobile.renameSection } : {})}
              {...(snapshot?.host.capabilities.includes("section.delete.v1") ? { onDeleteSection: mobile.deleteSection } : {})}
              {...(snapshot?.host.capabilities.includes("directory.browse.v1") ? { onBrowseDirectory: mobile.browseDirectory } : {})}
              {...(snapshot?.host.capabilities.includes("directory.mkdir.v1") ? { onCreateDirectory: mobile.createDirectory } : {})}
              onForkSession={mobile.forkSession}
              {...(snapshot?.host.capabilities.includes("session.rename.v1")
                ? { onRenameSession: mobile.renameSession }
                : {})}
              onReturnToDesktop={mobile.returnToDesktop}
              onTakeoverDesktop={mobile.takeoverDesktop}
              onLoadSessionConfiguration={mobile.loadSessionConfiguration}
              {...(snapshot?.host.capabilities.includes("claude.native-relay.v1") ? { onLoadBackgroundTasks: mobile.loadBackgroundTasks } : {})}
              {...(snapshot?.host.capabilities.includes("session.commands.v1")
                ? { onLoadSessionCommands: mobile.loadSessionCommands }
                : {})}
              {...(snapshot?.host.capabilities.includes("session.command.v1") ? {
                onRunSessionCommand: mobile.runSessionCommand,
                onLoadSessionPermissions: mobile.loadSessionPermissions,
                onSaveSessionPermissions: mobile.saveSessionPermissions,
              } : {})}
              onConfigureSession={mobile.configureSession}
              onPreviewRewind={mobile.previewRewind}
              onRewindSession={mobile.rewindSession}
              onPreviewProviderSwitch={mobile.previewProviderSwitch}
              onCommitProviderSwitch={mobile.commitProviderSwitch}
              onCancelProviderSwitch={mobile.cancelProviderSwitch}
              {...(mobile.state.snapshot?.host.capabilities.includes("session.visibility.v1")
                ? {
                    onArchiveSession: mobile.archiveSession,
                    onDeleteSession: mobile.deleteSession,
                  }
                : {})}
              onRefreshProviders={mobile.refreshProviders}
              onDesktopAppAction={mobile.controlDesktopApp}
              onRefresh={mobile.refresh}
              onBackToHosts={() => {
                setComputerDetailsHostId(undefined);
                setTab("computers");
              }}
              onRetry={mobile.retryConnection}
            />
          </MediaPreviewProvider>
        </div>
      ) : tab === "sessions" ? (
        <main className="mobile-settings-page">
          <MobilePageHeader title="会话" />
          <section className="mobile-settings-content">
            <div className="mobile-empty-directory">
              <h2>选择一台电脑开始</h2>
              <p>连接已配对的电脑，查看项目与会话。</p>
              <button type="button" className="primary-button" onClick={() => setTab("computers")}>选择电脑</button>
            </div>
          </section>
        </main>
      ) : null}
      {tab === "computers" && (computerDetailsHostId && computerDetailsHostId === mobile.state.activeHostId ? (
        <MobileHostDetails
          activeHostId={mobile.state.activeHostId}
          desktopName={mobile.state.desktopName ?? "我的电脑"}
          connection={mobile.state.connection}
          desktopOnline={mobile.state.desktopOnline}
          snapshot={snapshot}
          transportMetrics={mobile.state.transportMetrics}
          pendingOutbound={mobile.state.pendingOutbound}
          connectionIssue={mobile.state.connectionIssue}
          relayUrl={mobile.state.hosts.find((host) => host.roomId === mobile.state.activeHostId)?.relayUrl ?? mobile.state.snapshot?.host.relayUrl ?? ""}
          onSetRelayUrl={mobile.setRelayUrl}
          onRetry={mobile.retryConnection}
          onRefresh={mobile.refresh}
          onDesktopAppAction={mobile.controlDesktopApp}
          remoteUpdate={remoteDesktopUpdate}
          onRemove={async () => {
            await mobile.forgetHost(mobile.state.activeHostId!);
            setComputerDetailsHostId(undefined);
          }}
          onBack={() => setComputerDetailsHostId(undefined)}
        />
      ) : (
        <HostBrowser
          hosts={mobile.state.hosts}
          activeHostId={mobile.state.activeHostId}
          error={mobile.state.error}
          onSelect={openComputer}
          onDetails={(hostId) => {
            setComputerDetailsHostId(hostId);
            if (hostId !== mobile.state.activeHostId) void mobile.selectHost(hostId);
          }}
          onRemove={mobile.forgetHost}
          onAdd={() => setPairingOpen(true)}
          onRepair={() => setPairingOpen(true)}
        />
      ))}
      {tab === "settings" && (providersOpen ? (
        <main className="mobile-workspace mobile-settings-page">
          <MobilePageHeader title="模型与网关" onBack={() => setProvidersOpen(false)} />
          <div className="mobile-settings-content"><section className="mobile-settings-group mobile-provider-settings"><ProviderSettings key={mobile.state.activeHostId} {...(snapshot ? { snapshot } : {})} connected={mobile.state.connection === "connected" && mobile.state.desktopOnline} onRefresh={mobile.redetectProviders} /></section></div>
        </main>
      ) : quotaOpen && quotaDeclared ? (
        <MobileQuotaPage desktopName={mobile.state.desktopName ?? "我的电脑"} onBack={closeQuota} />
      ) : (
        <MobileSettings
          themeControl={themeControl}
          remoteDesktop={remoteDesktopUpdate}
          clientUpdater={clientUpdater}
          {...(mobile.state.activeHostId ? { providers: { desktopName: mobile.state.desktopName ?? "我的电脑", onOpen: () => setProvidersOpen(true) } } : {})}
          {...(quotaDeclared ? { quota: { desktopName: mobile.state.desktopName ?? "我的电脑", onOpen: () => setQuotaOpen(true) } } : {})}
        />
      ))}
      </MagpieQuotaProvider>
      <MobileClientUpdateDialog updater={clientUpdater} />
      <DiagnosticFloatingEntry />
    </MobileAppShell>
  );
}
