import { useCallback, useEffect, useState } from "react";
import { useTheme } from "./hooks/useTheme.js";
import { useMobileBridge } from "./hooks/useMobileBridge.js";
import {
  installMobileBackNavigation,
  registerMobileBackHandler,
} from "./lib/mobile-back-navigation.js";
import { DesktopDashboard } from "./components/DesktopDashboard.js";
import { DiagnosticFloatingEntry } from "./components/DiagnosticLogDialog.js";
import { HostBrowser } from "./components/HostBrowser.js";
import { MobileWorkspace } from "./components/MobileWorkspace.js";
import { PairingScreen } from "./components/PairingScreen.js";
import { PairingSyncScreen } from "./components/PairingSyncScreen.js";
import { MediaPreviewProvider } from "./components/MediaPreviewProvider.js";
import { MobileAppShell, type MobileTab } from "./components/MobileAppShell.js";
import { MobileHostDetails } from "./components/MobileHostDetails.js";
import { MobileSettings } from "./components/MobileSettings.js";
import { HostPermissionSettings } from "./components/HostPermissionSettings.js";

export function App() {
  const themeControl = useTheme();
  const mobile = useMobileBridge();
  const [pairingOpen, setPairingOpen] = useState(false);
  const [tab, setTab] = useState<MobileTab>("sessions");
  const [computerDetailsOpen, setComputerDetailsOpen] = useState(false);
  const [conversation, setConversation] = useState<{ hostId: string | undefined; open: boolean }>({ hostId: undefined, open: false });
  const [focusRequest, setFocusRequest] = useState<{ sessionId: string; key: number }>();
  const [directoryRequest, setDirectoryRequest] = useState(0);
  const handleConversationChange = useCallback((open: boolean) => {
    setConversation({ hostId: mobile.state.activeHostId, open });
  }, [mobile.state.activeHostId]);
  const handleFocusHandled = useCallback(() => setFocusRequest(undefined), []);

  async function openComputer(hostId: string, sessionId?: string): Promise<void> {
    if (hostId !== mobile.state.activeHostId) await mobile.selectHost(hostId);
    if (sessionId) setFocusRequest({ sessionId, key: Date.now() });
    else setDirectoryRequest(Date.now());
    setComputerDetailsOpen(false);
    setTab("sessions");
  }

  useEffect(() => {
    setComputerDetailsOpen(false);
  }, [mobile.state.activeHostId]);

  useEffect(() => installMobileBackNavigation(), []);

  useEffect(() => registerMobileBackHandler(() => {
    if (window.bridgeDesktop) return false;
    // The secure import must finish before a back gesture can change route.
    if (mobile.state.pairingSync) return true;
    if (pairingOpen && mobile.state.hosts.length > 0) {
      setPairingOpen(false);
      return true;
    }
    if (tab !== "sessions") {
      setComputerDetailsOpen(false);
      setTab("sessions");
      return true;
    }
    return true;
  }, -100), [
    mobile.state.hosts.length,
    mobile.state.pairingSync,
    pairingOpen,
    tab,
  ]);

  if (window.bridgeDesktop) return (
    <MediaPreviewProvider request={(method, params) => window.bridgeDesktop!.request({ method, params })}>
      <DesktopDashboard themeControl={themeControl} />
    </MediaPreviewProvider>
  );
  if (mobile.state.pairingSync) {
    return (
      <>
        <PairingSyncScreen sync={mobile.state.pairingSync} />
        <DiagnosticFloatingEntry />
      </>
    );
  }
  if (mobile.state.loading && mobile.state.hosts.length === 0 && !pairingOpen) {
    return (
      <>
        <main className="mobile-loading"><span className="spinner" /><span>正在读取已配对电脑</span></main>
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
        <DiagnosticFloatingEntry />
      </>
    );
  }
  return (
    <MobileAppShell
      tab={tab}
      fullscreen={tab === "sessions" && conversation.hostId === mobile.state.activeHostId && conversation.open}
      onTabChange={(next) => {
        setComputerDetailsOpen(false);
        setTab(next);
      }}
    >
      {mobile.state.activeHostId ? (
        <div className="mobile-tab-page" hidden={tab !== "sessions"}>
          <MediaPreviewProvider key={mobile.state.activeHostId} request={mobile.requestMedia}>
            <MobileWorkspace
              visible={tab === "sessions"}
              onConversationChange={handleConversationChange}
              {...(focusRequest ? { focusRequest } : {})}
              onFocusHandled={handleFocusHandled}
              directoryRequest={directoryRequest}
              key={mobile.state.activeHostId}
              activeHostId={mobile.state.activeHostId}
              desktopName={mobile.state.desktopName ?? "我的电脑"}
              connection={mobile.state.connection}
              desktopOnline={mobile.state.desktopOnline}
              snapshot={mobile.state.snapshot}
              permissions={mobile.state.permissions}
              focusSessionId={mobile.state.focusSessionId}
              histories={mobile.state.histories}
              evidence={mobile.state.evidence}
              artifactPreviews={mobile.state.artifactPreviews}
              artifactTransfers={mobile.state.artifactTransfers}
              events={mobile.state.events}
              localTurns={mobile.state.localTurns}
              connectionIssue={mobile.state.connectionIssue}
              transportMetrics={mobile.state.transportMetrics}
              pendingOutbound={mobile.state.pendingOutbound}
              themeControl={themeControl}
              onOpenSession={mobile.openSession}
              onLoadOlderHistory={mobile.loadOlderHistory}
              onLoadOlderEvidence={mobile.loadOlderEvidence}
              onPreviewArtifact={mobile.previewArtifact}
              onDownloadArtifact={mobile.downloadArtifact}
              onDownloadSessionFile={mobile.downloadSessionFile}
              onUploadFile={mobile.uploadFile}
              onSendTurn={mobile.sendTurn}
              onInterruptTurn={mobile.interruptTurn}
              onResolveUncertain={mobile.resolveUncertainDelivery}
              onResolvePermission={mobile.resolvePermission}
              onCreateSession={mobile.createSession}
              onForkSession={mobile.forkSession}
              onLoadSessionConfiguration={mobile.loadSessionConfiguration}
              onConfigureSession={mobile.configureSession}
              {...(mobile.state.snapshot?.host.capabilities.includes("permission.policy.v1")
                ? { onConfigurePermissionPolicy: mobile.configurePermissionPolicy }
                : {})}
              onPreviewProviderSwitch={mobile.previewProviderSwitch}
              onCommitProviderSwitch={mobile.commitProviderSwitch}
              onCancelProviderSwitch={mobile.cancelProviderSwitch}
              onPreviewRuntimeHandoff={mobile.previewRuntimeHandoff}
              onCommitRuntimeHandoff={mobile.commitRuntimeHandoff}
              onConfirmRuntimeHandoff={mobile.confirmRuntimeHandoff}
              onCancelRuntimeHandoff={mobile.cancelRuntimeHandoff}
              onGetRuntimeHandoff={mobile.getRuntimeHandoff}
              onPauseRuntimeGoal={mobile.pauseRuntimeGoal}
              onResumeRuntimeGoal={mobile.resumeRuntimeGoal}
              {...(mobile.state.snapshot?.host.capabilities.includes("session.visibility.v1")
                ? {
                    onArchiveSession: mobile.archiveSession,
                    onDeleteSession: mobile.deleteSession,
                    onOpenRuntimeFile: mobile.openRuntimeFile,
                  }
                : {})}
              onRefreshProviders={mobile.refreshProviders}
              onDesktopAppAction={mobile.controlDesktopApp}
              onRefresh={mobile.refresh}
              onBackToHosts={() => {
                setComputerDetailsOpen(false);
                setTab("computers");
              }}
              onRetry={mobile.retryConnection}
            />
          </MediaPreviewProvider>
        </div>
      ) : tab === "sessions" ? (
        <main className="mobile-settings-page">
          <header className="mobile-page-header"><h1>会话</h1></header>
          <section className="mobile-settings-content">
            <div className="mobile-empty-directory">
              <h2>选择一台电脑开始</h2>
              <p>连接已配对的电脑，查看项目与会话。</p>
              <button type="button" className="primary-button" onClick={() => setTab("computers")}>选择电脑</button>
            </div>
          </section>
        </main>
      ) : null}
      {tab === "computers" && (computerDetailsOpen && mobile.state.activeHostId ? (
        <MobileHostDetails
          activeHostId={mobile.state.activeHostId}
          desktopName={mobile.state.desktopName ?? "我的电脑"}
          connection={mobile.state.connection}
          desktopOnline={mobile.state.desktopOnline}
          snapshot={mobile.state.snapshot}
          transportMetrics={mobile.state.transportMetrics}
          pendingOutbound={mobile.state.pendingOutbound}
          connectionIssue={mobile.state.connectionIssue}
          relayUrl={mobile.state.hosts.find((host) => host.roomId === mobile.state.activeHostId)?.relayUrl ?? mobile.state.snapshot?.host.relayUrl ?? ""}
          onSetRelayUrl={mobile.setRelayUrl}
          onRetry={mobile.retryConnection}
          onRefresh={mobile.refresh}
          onDesktopAppAction={mobile.controlDesktopApp}
          onRemove={async () => {
            await mobile.forgetHost(mobile.state.activeHostId!);
            setComputerDetailsOpen(false);
          }}
          onBack={() => setComputerDetailsOpen(false)}
          permissionSettings={mobile.state.snapshot?.host.capabilities.includes("permission.policy.v1") ? (
            <HostPermissionSettings
              snapshot={mobile.state.snapshot}
              onLoadSessionConfiguration={mobile.loadSessionConfiguration}
              onConfigureHostPermission={mobile.configureHostPermission}
            />
          ) : undefined}
        />
      ) : (
        <HostBrowser
          hosts={mobile.state.hosts}
          activeHostId={mobile.state.activeHostId}
          error={mobile.state.error}
          onSelect={openComputer}
          onDetails={(hostId) => {
            if (hostId === mobile.state.activeHostId) setComputerDetailsOpen(true);
          }}
          onRemove={mobile.forgetHost}
          onAdd={() => setPairingOpen(true)}
          onRepair={() => setPairingOpen(true)}
        />
      ))}
      {tab === "settings" && <MobileSettings themeControl={themeControl} />}
      <DiagnosticFloatingEntry />
    </MobileAppShell>
  );
}
