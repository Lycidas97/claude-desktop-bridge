import type { BridgeHostSnapshot } from "@bridge/protocol";
import { MessageSquare, Monitor } from "lucide-react";
import { useEffect, useState } from "react";
import type { useMobileBridge } from "../../hooks/useMobileBridge.js";
import { canSendSession } from "../../lib/conversation-timeline.js";
import { discardIncomingFile, observeIncomingFiles, readIncomingFile } from "../../lib/incoming-file.js";
import { registerMobileBackHandler } from "../../lib/mobile-back-navigation.js";
import { Sheet, SheetAction } from "../common/Sheet.js";
import { useConversationDrafts } from "../conversation/ConversationDraftsProvider.js";
import "./IncomingFilePicker.css";

type ImportState = { id?: string; name?: string } & ({ error: string } | { file?: File });

export function IncomingFilePicker({ mobile, snapshot, onOpenSession }: {
  mobile: ReturnType<typeof useMobileBridge>;
  snapshot: BridgeHostSnapshot | undefined;
  onOpenSession(hostId: string, sessionId: string): void;
}) {
  const { activeHostId, hosts, loading, connection, desktopOnline } = mobile.state;
  const drafts = useConversationDrafts(activeHostId);
  const [incoming, setIncoming] = useState<ImportState>();
  const [choosingHost, setChoosingHost] = useState(false);
  const [switchingHost, setSwitchingHost] = useState(false);
  const [hostError, setHostError] = useState<string>();

  useEffect(() => observeIncomingFiles((shared) => {
    setChoosingHost(false);
    setHostError(undefined);
    if ("error" in shared) {
      setIncoming({ id: shared.id, error: shared.error });
      return;
    }
    setIncoming({ id: shared.id, name: shared.name });
    void readIncomingFile(shared).then((file) => {
      setIncoming((current) => current?.id === shared.id ? { id: shared.id, name: shared.name, file } : current);
    }, (error: unknown) => {
      setIncoming((current) => current?.id === shared.id ? {
        id: shared.id,
        name: shared.name,
        error: error instanceof Error ? error.message : "无法读取文件，请在原应用中重新打开",
      } : current);
    });
  }, () => setIncoming({ error: "无法接收文件，请在原应用中重新打开" })), []);

  function close() {
    setIncoming(undefined);
    if (incoming?.id) void discardIncomingFile(incoming.id);
  }

  useEffect(() => {
    if (!incoming) return;
    return registerMobileBackHandler(() => {
      if (choosingHost && activeHostId) setChoosingHost(false);
      else close();
      return true;
    }, 320);
  }, [incoming, choosingHost, activeHostId]);

  if (!incoming) return null;
  const activeHost = hosts.find((host) => host.roomId === activeHostId);
  const ready = connection === "connected" && desktopOnline;
  const canUpload = ready && !switchingHost;
  const sessions = snapshot?.sessions.filter((session) => canSendSession(session, snapshot)) ?? [];
  return (
    <Sheet manageFocus title="上传到会话" eyebrow={incoming.name} closeLabel="取消导入" onClose={close}>
      <div className="incoming-file-picker">
        {"error" in incoming ? <p role="alert">{incoming.error}</p> : !incoming.file ? (
          <p role="status">正在读取文件…</p>
        ) : loading ? <p role="status">正在读取已配对电脑…</p> : hosts.length === 0 ? (
          <p role="status">请先配对一台电脑</p>
        ) : choosingHost || !activeHost ? (
          <div className="m-group" role="group" aria-label="选择电脑">
            {hosts.map((host) => (
              <SheetAction key={host.roomId} icon={<Monitor size={18} />} label={host.desktopName}
                detail={host.needsRepair ? "需要重新配对" : undefined} disabled={switchingHost || host.needsRepair}
                onClick={async () => {
                  setHostError(undefined);
                  setSwitchingHost(true);
                  try {
                    if (activeHostId !== host.roomId) await mobile.selectHost(host.roomId);
                    setChoosingHost(false);
                  } catch (error) {
                    setHostError(error instanceof Error ? error.message : "无法连接这台电脑");
                  } finally {
                    setSwitchingHost(false);
                  }
                }} />
            ))}
          </div>
        ) : (
          <>
            {hosts.length > 1 ? (
              <div className="m-group">
                <SheetAction icon={<Monitor size={18} />} label={activeHost.desktopName} detail="切换电脑"
                  disabled={switchingHost} onClick={() => setChoosingHost(true)} />
              </div>
            ) : <p>{activeHost.desktopName}</p>}
            {!canUpload ? (
              <p role="status">{switchingHost || connection === "connecting" || connection === "reconnecting" ? "正在连接电脑…" : "电脑未连接，连接后即可上传"}</p>
            ) : sessions.length === 0 ? <p role="status">这台电脑没有可上传的会话</p> : (
              <div className="m-group" role="group" aria-label="选择会话">
                {sessions.map((session) => (
                  <SheetAction key={session.sessionId} icon={<MessageSquare size={18} />} label={session.title}
                    detail={session.projectName} onClick={() => {
                      void drafts.session(activeHost.roomId, session.sessionId, (sessionId, file, progress, signal) => (
                        mobile.uploadFile(sessionId, file, progress, signal, activeHost.roomId)
                      )).fileUploads.add([incoming.file!]);
                      setIncoming(undefined);
                      onOpenSession(activeHost.roomId, session.sessionId);
                    }} />
                ))}
              </div>
            )}
          </>
        )}
        {hostError && <p role="alert">{hostError}</p>}
      </div>
    </Sheet>
  );
}
