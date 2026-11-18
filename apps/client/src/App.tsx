import type { BridgeHostSnapshot, BridgeSessionInfo, BridgeSystemUpdateParams, BridgeUpdaterSnapshot } from "@bridge/protocol";
import { useCallback, useEffect, useMemo, useState } from "react";
import { claudeSnapshot } from "./lib/claude-snapshot.js";
import { useClientUpdater } from "./lib/client-updater.js";
import { useTheme } from "./hooks/useTheme.js";
import { useMobileBridge } from "./hooks/useMobileBridge.js";
import {
  installMobileBackNavigation,
  registerMobileBackHandler,
} from "./lib/mobile-back-navigation.js";
import { onSessionNotificationTap, setActiveViewedSession } from "./lib/session-notifications.js";
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
import {
  clearInitialRefreshedQuotaHost,
  MobileQuotaPage,
  shouldFallbackAutoQuotaRefresh,
} from "./components/mobile/MobileQuotaPage.js";
import { MobileSettings } from "./components/mobile/MobileSettings.js";
import { ProviderSettings } from "./components/session/ProviderSettings.js";
import { MobileClientUpdateDialog, type RemoteDesktopUpdateControl } from "./components/updater/UpdaterSections.js";
import { MAGPIE_QUOTA_METHOD, type QuotaLoader, type QuotaSnapshot } from "../../../plugins/magpie-quota/contract.js";
import { MagpieQuotaProvider } from "../../../plugins/magpie-quota/client.js";
import { AssistantMailProvider, useAssistantMail, type AssistantRequest } from "./components/assistant/AssistantMailProvider.js";
import { AssistantPage } from "./components/assistant/AssistantPage.js";
import { MailReference } from "./components/assistant/MailReference.js";
import { ConversationDraftsProvider, type ConversationDraftsHandle } from "./components/conversation/ConversationDraftsProvider.js";
import { EvidencePanel } from "./components/evidence/EvidencePanel.js";
import { ConversationView } from "./components/conversation/ConversationView.js";
import { desktopRuntimeId } from "./lib/runtime-labels.js";

function MobileAssistantConversation({
  activeHostId,
  session,
  snapshot,
  visible,
  mobile,
  onNavigateToSession,
}: {
  activeHostId: string;
  session: BridgeSessionInfo;
  snapshot: BridgeHostSnapshot | undefined;
  visible: boolean;
  mobile: ReturnType<typeof useMobileBridge>;
  onNavigateToSession(sessionId: string): void;
}) {
  const assistantMail = useAssistantMail();
  const sessions = snapshot?.sessions ?? [];
  const mailCards = useMemo(() => (
    assistantMail?.cache.cards.filter((card) => (
      (card.nativeDelivery.nativeSessionId ?? snapshot?.assistantMail?.binding?.nativeSessionId) === session.sessionId
    )) ?? []
  ), [assistantMail?.cache.cards, session.sessionId, snapshot?.assistantMail?.binding?.nativeSessionId]);
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    if (!visible) return;
    return setActiveViewedSession({ hostId: activeHostId, sessionId: session.sessionId });
  }, [activeHostId, session.sessionId, visible]);
  async function handleRefresh(targetSessionId?: string): Promise<boolean> {
    if (refreshing) return false;
    setRefreshing(true);
    try {
      return await mobile.refresh(targetSessionId);
    } finally {
      setRefreshing(false);
    }
  }
  const canCommand = Boolean(snapshot?.host.capabilities.includes("session.command.v1"));
  const canRename = Boolean(snapshot?.host.capabilities.includes("session.rename.v1"));
  return (
    <ConversationView
      variant="mobile"
      hostId={activeHostId}
      session={session}
      sessions={sessions}
      snapshot={snapshot}
      connection={mobile.state.connection}
      desktopOnline={mobile.state.desktopOnline}
      visible={visible}
      navigation={false}
      onSelectSession={(nextSessionId) => {
        if (nextSessionId !== session.sessionId) onNavigateToSession(nextSessionId);
      }}
      refreshing={refreshing}
      onRefresh={handleRefresh}
      onRetry={mobile.retryConnection}
      history={mobile.state.histories[session.sessionId]}
      evidence={mobile.state.evidence[session.sessionId]}
      renderEvidence={(panel) => (
        <EvidencePanel
          {...panel}
          previews={mobile.state.artifactPreviews}
          transfers={mobile.state.artifactTransfers}
          onLoadMore={() => mobile.loadOlderEvidence(session.sessionId)}
          onLoadDetails={mobile.loadEvidenceDetails}
          onPreview={mobile.previewArtifact}
          onDownload={mobile.downloadArtifact}
        />
      )}
      permissions={mobile.state.permissions.filter((permission) => sessions.some((candidate) => candidate.sessionId === permission.sessionId))}
      events={mobile.state.events}
      localTurns={mobile.state.localTurns}
      connectionIssue={mobile.state.connectionIssue}
      mailCards={mailCards}
      composerBanner={<MailReference sessionId={session.sessionId} />}
      resolveMailRefId={() => assistantMail?.referenceFor(session.sessionId)}
      onOpenSession={mobile.openSession}
      onLoadOlderHistory={mobile.loadOlderHistory}
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
      onResolvePrompt={mobile.resolvePrompt}
      onReadPrAutoFix={mobile.readPrAutoFix}
      onSetPrAutoFix={mobile.setPrAutoFix}
      {...(snapshot?.host.capabilities.includes("claude.native-relay.v1") ? { onLoadBackgroundTasks: mobile.loadBackgroundTasks } : {})}
      onLoadSessionConfiguration={mobile.loadSessionConfiguration}
      onConfigureSession={mobile.configureSession}
      {...(snapshot?.host.capabilities.includes("session.commands.v1")
        ? { onLoadSessionCommands: mobile.loadSessionCommands }
        : {})}
      {...(canCommand ? {
        onRunSessionCommand: mobile.runSessionCommand,
        onLoadSessionPermissions: mobile.loadSessionPermissions,
        onSaveSessionPermissions: mobile.saveSessionPermissions,
      } : {})}
      onPreviewRewind={mobile.previewRewind}
      onRewindSession={mobile.rewindSession}
      sessionMenu={{
        rename: canCommand || canRename ? async (targetSessionId, title) => {
          if (canCommand && desktopRuntimeId(session) === "claude-desktop") {
            await mobile.runSessionCommand(targetSessionId, `/rename ${title.trim()}`);
          } else if (canRename) {
            await mobile.renameSession(targetSessionId, title.trim());
          }
        } : undefined,
        fork: mobile.forkSession,
        move: snapshot?.host.capabilities.includes("section.move.v1") ? mobile.moveSessionSection : undefined,
        ...(snapshot?.host.capabilities.includes("session.visibility.v1") ? {
          archive: mobile.archiveSession,
          delete: mobile.deleteSession,
        } : {}),
      }}
    />
  );
}

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
  const [draftsHandle] = useState<ConversationDraftsHandle>(() => ({}));
  const [autoQuotaRefreshPending] = useState(() => ({ current: false }));
  const markAutoQuotaRefresh = useCallback(() => {
    autoQuotaRefreshPending.current = true;
  }, [autoQuotaRefreshPending]);
  const handleFocusHandled = useCallback(() => setFocusRequest(undefined), []);
  const forgetHost = useCallback(async (roomId: string) => {
    await mobile.forgetHost(roomId);
    draftsHandle.clearHost?.(roomId);
    clearInitialRefreshedQuotaHost(roomId);
  }, [draftsHandle, mobile.forgetHost]);
  // requestMedia is the hook's plain request function; its identity never changes.
  const request = mobile.requestMedia;
  const mailRequest = useCallback<AssistantRequest>((method, params) => request(method, params, { wait: true, allowOffline: false }), [request]);
  const loadMagpieQuota = useCallback<QuotaLoader>(async (options) => {
    const requestedRefresh = options?.refresh ?? false;
    const isAutoRefresh = requestedRefresh && autoQuotaRefreshPending.current;
    if (requestedRefresh) autoQuotaRefreshPending.current = false;
    // Manual refresh has a shared 60 s desktop budget; ordinary reads still use 15 s.
    const response = await request(MAGPIE_QUOTA_METHOD, { refresh: requestedRefresh }, {
      wait: true, allowOffline: false, timeoutMs: requestedRefresh ? 75_000 : 30_000,
    });
    if (!response?.ok) {
      const message = response?.error?.message ?? "Magpie 额度读取失败";
      if (isAutoRefresh && shouldFallbackAutoQuotaRefresh(message)) {
        const fallback = await request(MAGPIE_QUOTA_METHOD, { refresh: false }, {
          wait: true, allowOffline: false, timeoutMs: 30_000,
        });
        if (fallback?.ok) return fallback.result as QuotaSnapshot;
      }
      throw new Error(message);
    }
    return response.result as QuotaSnapshot;
  }, [request]);
  // A computer without the plugin answers its method with an error, so ask only one that declares it.
  const quotaDeclared = Boolean(mobile.state.snapshot?.host.capabilities.includes("plugin.magpie-quota.v1"));
  const quotaEnabled = mobile.state.connection === "connected" && mobile.state.desktopOnline && quotaDeclared;
  const quotaSourceKey = `${snapshot?.magpie?.mode ?? ""}|${snapshot?.magpie?.baseUrl ?? ""}|${snapshot?.magpie?.authScheme ?? ""}|${snapshot?.magpie?.keyConfigured ? 1 : 0}`;
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
    else setDirectoryRequest((value) => value + 1);
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
      setDirectoryRequest((value) => value + 1);
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
  return (
    <ConversationDraftsProvider activeHostId={mobile.state.activeHostId} controllerRef={draftsHandle}>
      {mobile.state.pairingSync ? (
        <>
          <PairingSyncScreen sync={mobile.state.pairingSync} />
          <MobileClientUpdateDialog updater={clientUpdater} />
          <DiagnosticFloatingEntry />
        </>
      ) : mobile.state.loading && mobile.state.hosts.length === 0 && !pairingOpen ? (
        <>
          <main className="mobile-loading"><span className="spinner" /><span>正在读取已配对电脑</span></main>
          <MobileClientUpdateDialog updater={clientUpdater} />
          <DiagnosticFloatingEntry />
        </>
      ) : pairingOpen || mobile.state.hosts.length === 0 ? (
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
      ) : (
    <AssistantMailProvider key={mobile.state.activeHostId ?? ""} snapshot={snapshot} online={mobile.state.connection === "connected" && mobile.state.desktopOnline} request={mailRequest} loadCache={mobile.loadMailCache} saveCache={mobile.saveMailCache} onDiscuss={() => setTab("assistant")}>
    <MobileAppShell
      tab={tab}
      onTabChange={(next) => {
        setComputerDetailsHostId(undefined);
        setQuotaOpen(false);
        setProvidersOpen(false);
        if (next === "sessions") setDirectoryRequest((value) => value + 1);
        setTab(next);
      }}
    >
      {/* One quota snapshot per computer, shared by the session form and the settings dashboard. */}
      <MagpieQuotaProvider key={mobile.state.activeHostId ?? ""} loader={loadMagpieQuota} enabled={quotaEnabled} sourceKey={quotaSourceKey}>
      {mobile.state.activeHostId ? (
        <MediaPreviewProvider key={mobile.state.activeHostId} request={mobile.requestMedia} supportsFileStat={snapshot?.host.capabilities.includes("artifact.transfer.stat.v1") ?? false}>
          <div className="mobile-tab-page" hidden={tab !== "sessions"}>
            <MobileWorkspace
              visible={tab === "sessions"}
              {...(focusRequest ? { focusRequest } : {})}
              onFocusHandled={handleFocusHandled}
              directoryRequest={directoryRequest}
              key={mobile.state.activeHostId}
              activeHostId={mobile.state.activeHostId}
              hosts={mobile.state.hosts}
              onSelectHost={(hostId) => openComputer(hostId)}
              onAddHost={() => setPairingOpen(true)}
              activeTab={tab}
              onSelectTab={(nextTab) => {
                setComputerDetailsHostId(undefined);
                setQuotaOpen(false);
                setProvidersOpen(false);
                setTab(nextTab);
              }}
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
              onResolvePrompt={mobile.resolvePrompt}
              onReadPrAutoFix={mobile.readPrAutoFix}
              onSetPrAutoFix={mobile.setPrAutoFix}
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
              {...(mobile.state.snapshot?.host.capabilities.includes("session.visibility.v1")
                ? {
                    onArchiveSession: mobile.archiveSession,
                    onDeleteSession: mobile.deleteSession,
                  }
                : {})}
              onActivateClaude={mobile.activateClaudeRemote}
              onRefresh={mobile.refresh}
              onBackToHosts={() => {
                setComputerDetailsHostId(undefined);
                setTab("computers");
              }}
              onRetry={mobile.retryConnection}
            />
          </div>
          <div className="mobile-tab-page" hidden={tab !== "assistant"}>
            <AssistantPage
              snapshot={snapshot}
              mobile
              active={tab === "assistant"}
              onOpenSession={(sessionId) => {
                setFocusRequest({ sessionId, key: Date.now() });
                setTab("sessions");
              }}
              renderConversation={(sessionId) => {
                const boundSession = snapshot?.sessions.find((candidate) => candidate.sessionId === sessionId);
                return boundSession ? (
                  <MobileAssistantConversation
                    activeHostId={mobile.state.activeHostId!}
                    session={boundSession}
                    snapshot={snapshot}
                    visible={tab === "assistant"}
                    mobile={mobile}
                    onNavigateToSession={(otherSessionId) => {
                      setFocusRequest({ sessionId: otherSessionId, key: Date.now() });
                      setTab("sessions");
                    }}
                  />
                ) : (
                  <main className="mobile-workspace"><p role="status">绑定会话暂不可用，请在助理设置中核对绑定。</p></main>
                );
              }}
            />
          </div>
        </MediaPreviewProvider>
      ) : tab === "sessions" ? (
        <main className="mobile-settings-page">
          <MobilePageHeader title="会话" />
          <section className="mobile-settings-content">
            <div className="mobile-empty-directory">
              <h2>选择一台电脑开始</h2>
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
            await forgetHost(mobile.state.activeHostId!);
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
          onRemove={forgetHost}
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
        <MobileQuotaPage
          hostId={mobile.state.activeHostId}
          desktopName={mobile.state.desktopName ?? "我的电脑"}
          onBeforeAutoRefresh={markAutoQuotaRefresh}
          onBack={closeQuota}
        />
      ) : (
        <MobileSettings
          themeControl={themeControl}
          remoteDesktop={remoteDesktopUpdate}
          clientUpdater={clientUpdater}
          {...(mobile.state.activeHostId ? {
            providers: { desktopName: mobile.state.desktopName ?? "我的电脑", onOpen: () => setProvidersOpen(true) },
            claudeRuntime: {
              desktopName: mobile.state.desktopName ?? "我的电脑",
              snapshot,
              connected: mobile.state.connection === "connected" && mobile.state.desktopOnline,
              onActivate: mobile.activateClaudeRemote,
            },
          } : {})}
          {...(quotaDeclared ? { quota: { desktopName: mobile.state.desktopName ?? "我的电脑", onOpen: () => setQuotaOpen(true) } } : {})}
        />
      ))}
      </MagpieQuotaProvider>
      <MobileClientUpdateDialog updater={clientUpdater} />
      <DiagnosticFloatingEntry />
    </MobileAppShell>
    </AssistantMailProvider>
      )}
    </ConversationDraftsProvider>
  );
}
