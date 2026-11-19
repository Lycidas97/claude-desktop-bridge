import type { BridgeHostSnapshot, BridgeSessionInfo } from "@bridge/protocol";
import { LoaderCircle, MessageSquare, Monitor } from "lucide-react";
import { Fragment, useEffect, useState, type ReactNode, type RefObject } from "react";
import type { useMobileBridge } from "../../hooks/useMobileBridge.js";
import { canSendSession } from "../../lib/conversation-timeline.js";
import { discardIncomingFile, observeIncomingFiles, readIncomingFile } from "../../lib/incoming-file.js";
import { registerMobileBackHandler } from "../../lib/mobile-back-navigation.js";
import { groupProjectSessionFamilies, type SessionFamily } from "../../lib/project-groups.js";
import { Sheet, SheetAction } from "../common/Sheet.js";
import { useConversationDrafts } from "../conversation/ConversationDraftsProvider.js";
import "./IncomingFilePicker.css";

type ImportState = { id?: string; name?: string | undefined } & ({ error: string } | { file?: File });

export function IncomingFilePicker({ mobile, snapshot, dismissMediaPreview, onOpenSession }: {
  mobile: ReturnType<typeof useMobileBridge>;
  snapshot: BridgeHostSnapshot | undefined;
  dismissMediaPreview: RefObject<(() => void) | undefined>;
  onOpenSession(hostId: string, sessionId: string): void;
}) {
  const { activeHostId, hosts, loading, connection, desktopOnline } = mobile.state;
  const drafts = useConversationDrafts(activeHostId);
  const [incoming, setIncoming] = useState<ImportState>();
  const [choosingHost, setChoosingHost] = useState(false);
  const [switchingHost, setSwitchingHost] = useState(false);
  const [hostError, setHostError] = useState<string>();

  useEffect(() => observeIncomingFiles((shared) => {
    dismissMediaPreview.current?.();
    setChoosingHost(false);
    setHostError(undefined);
    if ("error" in shared) {
      setIncoming({ id: shared.id, name: shared.name, error: shared.error });
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
  }, () => setIncoming({ error: "无法接收文件，请在原应用中重新打开" })), [dismissMediaPreview]);

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
  const file = "file" in incoming ? incoming.file : undefined;
  const projects = new Map<string, BridgeSessionInfo[]>();
  if (file && activeHost && canUpload && !choosingHost) {
    for (const session of snapshot?.sessions ?? []) {
      if (session.archivedAt || !canSendSession(session, snapshot)) continue;
      const project = projects.get(session.projectId);
      if (project) project.push(session);
      else projects.set(session.projectId, [session]);
    }
  }
  return (
    <Sheet manageFocus title="上传到会话" closeLabel="取消导入" onClose={close}>
      <div className="incoming-file-picker">
        {incoming.name && <p className="incoming-file-name">{incoming.name}</p>}
        {"error" in incoming ? <p className="m-sheet-note is-error" role="alert">{incoming.error}</p> : !file ? (
          <p className="m-sheet-note" role="status"><LoaderCircle className="is-spinning" size={15} />正在读取文件…</p>
        ) : loading ? <p className="m-sheet-note" role="status">正在读取已配对电脑…</p> : hosts.length === 0 ? (
          <p className="m-sheet-note" role="status">请先配对一台电脑</p>
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
            ) : <p className="m-sheet-note">{activeHost.desktopName}</p>}
            {!canUpload ? (
              <p className="m-sheet-note" role="status">{switchingHost || connection === "connecting" || connection === "reconnecting" ? "正在连接电脑…" : "电脑未连接，连接后即可上传"}</p>
            ) : projects.size === 0 ? <p className="m-sheet-note" role="status">这台电脑没有可上传的会话</p> : (
              [...projects.entries()].map(([projectId, sessions]) => (
                <section key={projectId} aria-label={sessions[0]!.projectName}>
                  <h3 className="incoming-file-project">{sessions[0]!.projectName}</h3>
                  <div className="m-group">
                    {renderFamilies(groupProjectSessionFamilies(sessions), (sessionId) => {
                      void drafts.session(activeHost.roomId, sessionId, (sessionId, file, progress, signal) => (
                        mobile.uploadFile(sessionId, file, progress, signal, activeHost.roomId)
                      )).fileUploads.add([file]);
                      setIncoming(undefined);
                      onOpenSession(activeHost.roomId, sessionId);
                    })}
                  </div>
                </section>
              ))
            )}
          </>
        )}
        {hostError && <p className="m-sheet-note is-error" role="alert">{hostError}</p>}
      </div>
    </Sheet>
  );
}

function renderFamilies(families: SessionFamily<BridgeSessionInfo>[], onSelect: (sessionId: string) => void): ReactNode {
  return families.map(({ primary, forks }) => (
    <Fragment key={primary.sessionId}>
      <SheetAction icon={<MessageSquare size={18} />} label={primary.title} onClick={() => onSelect(primary.sessionId)} />
      {forks.length > 0 && (
        <details className="incoming-file-forks">
          <summary aria-label={`${primary.title}的分支会话`}>分支会话</summary>
          {renderFamilies(forks, onSelect)}
        </details>
      )}
    </Fragment>
  ));
}
