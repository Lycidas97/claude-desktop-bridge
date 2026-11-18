import type {
  BridgeEvent,
  BridgeResponse,
  DesktopControlSnapshot,
  LocalBridgeRequest,
} from "@bridge/protocol";
import { summarizeEvidenceEvent } from "@bridge/protocol";
import { AlertTriangle, MessageSquare } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { MAGPIE_QUOTA_METHOD, type QuotaSnapshot } from "../../../../plugins/magpie-quota/contract.js";
import { MagpieQuotaProvider } from "../../../../plugins/magpie-quota/client.js";
import type { ThemeControl } from "../hooks/useTheme.js";
import { claudeSnapshot } from "../lib/claude-snapshot.js";
import { AssistantMailProvider } from "./assistant/AssistantMailProvider.js";
import { AssistantPage } from "./assistant/AssistantPage.js";
import { BrandMark } from "./common/BrandMark.js";
import { DiagnosticFloatingEntry } from "./common/DiagnosticLogDialog.js";
import { ConversationDraftsProvider } from "./conversation/ConversationDraftsProvider.js";
import {
  DesktopConversationProvider,
  DesktopSessionConversation,
} from "./desktop/DesktopSessionConversation.js";
import { DesktopSessions, unwrap, type DesktopWorkspaceTab } from "./desktop/DesktopSessionsPane.js";
import { DesktopDevices, DesktopSettings } from "./desktop/DesktopSettings.js";
import { MediaPreviewProvider } from "./evidence/MediaPreviewProvider.js";

export { DesktopDevices };

const EMPTY_EVENTS: BridgeEvent[] = [];

export function DesktopDashboard({ themeControl }: { themeControl: ThemeControl }) {
  const api = window.bridgeDesktop;
  const [snapshot, setSnapshot] = useState<DesktopControlSnapshot>();
  const [eventsByHost, setEventsByHost] = useState<Record<string, BridgeEvent[]>>({});
  const [tab, setTab] = useState<DesktopWorkspaceTab>("sessions");
  const [focusRequest, setFocusRequest] = useState<{ sessionId: string; key: number }>();
  const focusKeyRef = useRef(0);
  const activeHostIdRef = useRef<string | undefined>(undefined);
  if (snapshot) activeHostIdRef.current = snapshot.host.hostId;
  const requestByMethod = useMemo(() => (method: LocalBridgeRequest["method"], params: Record<string, unknown>) =>
    api!.request({ method, params }), [api]);
  const visibleSnapshot = useMemo(() => (snapshot ? claudeSnapshot(snapshot) : undefined), [snapshot]);

  function applySnapshot(nextSnapshot: DesktopControlSnapshot): void {
    activeHostIdRef.current = nextSnapshot.host.hostId;
    setSnapshot(nextSnapshot);
  }

  useEffect(() => {
    if (!api) return;
    void api.getSnapshot().then(applySnapshot);
    const stopSnapshots = api.onSnapshot(applySnapshot);
    const stopEvents = api.onEvent((event) => {
      const currentHostId = activeHostIdRef.current;
      if (!currentHostId) return;
      setEventsByHost((current) => {
        const hostEvents = current[currentHostId] ?? EMPTY_EVENTS;
        const nextHostEvents = [
          ...hostEvents.filter((candidate) => candidate.eventId !== event.eventId),
          summarizeEvidenceEvent(event),
        ]
          .sort((left, right) => left.seq - right.seq)
          .slice(-2_000);
        return { ...current, [currentHostId]: nextHostEvents };
      });
    });
    return () => {
      stopSnapshots();
      stopEvents();
    };
  }, [api]);

  const loadMagpieQuota = useMemo(() => async (options?: { refresh?: boolean }): Promise<QuotaSnapshot> => {
    return unwrap<QuotaSnapshot>(await api!.request({ method: MAGPIE_QUOTA_METHOD, params: { refresh: options?.refresh ?? false } }));
  }, [api]);

  if (!api || !snapshot) {
    return (
      <div className="desktop-loading">
        <BrandMark />
        <span>正在准备会话主机</span>
      </div>
    );
  }

  const events = eventsByHost[snapshot.host.hostId] ?? EMPTY_EVENTS;
  const quotaSourceKey = `${snapshot.magpie?.mode ?? ""}|${snapshot.magpie?.baseUrl ?? ""}|${snapshot.magpie?.authScheme ?? ""}|${snapshot.magpie?.keyConfigured ? 1 : 0}`;

  async function request(input: LocalBridgeRequest): Promise<BridgeResponse> {
    return api!.request(input);
  }

  async function refreshSnapshot(): Promise<void> {
    applySnapshot(await api!.getSnapshot());
  }

  function openDesktopSession(sessionId: string): void {
    focusKeyRef.current += 1;
    setFocusRequest({ sessionId, key: focusKeyRef.current });
    setTab("sessions");
  }

  return (
    <ConversationDraftsProvider activeHostId={snapshot.host.hostId}>
      <DesktopConversationProvider snapshot={visibleSnapshot!} events={events} eventsByHost={eventsByHost} apiRequest={request} onRefreshSnapshot={refreshSnapshot}>
        <MediaPreviewProvider request={requestByMethod} supportsFileStat={snapshot.host.capabilities.includes("artifact.transfer.stat.v1")}>
          <MagpieQuotaProvider loader={loadMagpieQuota} enabled={snapshot.host.capabilities.includes("plugin.magpie-quota.v1")} sourceKey={quotaSourceKey}>
            <AssistantMailProvider key={snapshot.host.hostId} snapshot={snapshot} online request={requestByMethod} onDiscuss={() => setTab("assistant")}>
              <main className="desktop-shell-v2">
                <section className="desktop-content-v2">
                  {snapshot.claudeInspector?.state === "error" && (
                    <div role="alert" className="inspector-warning">
                      <AlertTriangle size={18} />
                      <span>Claude 调试连接监测不可用：{snapshot.claudeInspector.error}</span>
                    </div>
                  )}
                  {snapshot.claudeInspector?.clients.some((client) => !client.approved) && (
                    <div role="alert" className="inspector-warning">
                      <AlertTriangle size={18} />
                      <div>
                        <strong>Claude 调试接口存在未认可的进程连接</strong>
                        {snapshot.claudeInspector.clients.filter((client) => !client.approved).map((client) => (
                          <p key={client.pid}>PID {client.pid} · {client.name} · {client.executablePath ?? client.pathError ?? "路径未知"}</p>
                        ))}
                      </div>
                    </div>
                  )}
                  <DesktopSessions
                    snapshot={visibleSnapshot!}
                    initialSessionId={focusRequest?.sessionId}
                    focusRequest={focusRequest}
                    events={events}
                    apiRequest={request}
                    onRefreshSnapshot={refreshSnapshot}
                    activeTab={tab}
                    onSelectTab={setTab}
                    themeControl={themeControl}
                    renderRightCanvas={(headerLeading) => (
                      tab === "assistant" ? (
                        <AssistantPage
                          snapshot={visibleSnapshot!}
                          headerLeading={headerLeading}
                          onOpenSession={openDesktopSession}
                          renderConversation={(sessionId) => {
                            const boundSession = visibleSnapshot!.sessions.find((candidate) => candidate.sessionId === sessionId);
                            return boundSession ? (
                              <section className="desktop-conversation">
                                <DesktopSessionConversation
                                  session={boundSession}
                                  conversationTabLabel="消息"
                                  snapshot={visibleSnapshot!}
                                  events={events}
                                  apiRequest={request}
                                  onRefreshSnapshot={refreshSnapshot}
                                  onSelectSession={(nextSessionId) => {
                                    if (nextSessionId !== sessionId) openDesktopSession(nextSessionId);
                                  }}
                                />
                              </section>
                            ) : (
                              <section className="desktop-conversation">
                                <div className="desktop-conversation-empty">
                                  <MessageSquare size={24} />
                                  <span>绑定会话暂不可用，请在助理设置中核对绑定。</span>
                                </div>
                              </section>
                            );
                          }}
                        />
                      ) : (
                        <DesktopSettings
                          snapshot={snapshot}
                          api={api}
                          onSnapshot={applySnapshot}
                          themeControl={themeControl}
                          headerLeading={headerLeading}
                        />
                      )
                    )}
                  />
                </section>
                <DiagnosticFloatingEntry desktopSnapshot={snapshot} />
              </main>
            </AssistantMailProvider>
          </MagpieQuotaProvider>
        </MediaPreviewProvider>
      </DesktopConversationProvider>
    </ConversationDraftsProvider>
  );
}
