import type { BridgeHostSnapshot, BridgeSessionInfo } from "@bridge/protocol";
import { ChevronRight, LoaderCircle, MessageSquare, Monitor } from "lucide-react";
import { Fragment, useEffect, useState, type ReactNode, type RefObject } from "react";
import type { useMobileBridge } from "../../hooks/useMobileBridge.js";
import { canSendSession, forkGroupToggleLabel, relativeTime } from "../../lib/conversation-timeline.js";
import { discardIncomingFile, observeIncomingFiles, readIncomingFile } from "../../lib/incoming-file.js";
import { registerMobileBackHandler } from "../../lib/mobile-back-navigation.js";
import { groupProjectSessionFamilies, orderProjects, readStoredProjectOrder, type SessionFamily } from "../../lib/project-groups.js";
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
  const archived = new Map<string, BridgeSessionInfo[]>();
  if (file && activeHost && canUpload && !choosingHost) {
    for (const session of snapshot?.sessions ?? []) {
      if (!canSendSession(session, snapshot)) continue;
      const groups = session.archivedAt ? archived : projects;
      const project = groups.get(session.projectId);
      if (project) project.push(session);
      else groups.set(session.projectId, [session]);
    }
  }
  const projectOrder = readStoredProjectOrder(`bridge-project-order:${activeHostId}`);
  const managedProjectId = snapshot?.projects.find(project => project.managedAssistant)?.projectId;

  function selectSession(roomId: string, file: File, sessionId: string) {
    void drafts.session(roomId, sessionId, (target, file, progress, signal) => (
      mobile.uploadFile(target, file, progress, signal, roomId)
    )).fileUploads.add([file]);
    setIncoming(undefined);
    onOpenSession(roomId, sessionId);
  }

  function renderProjects(groups: Map<string, BridgeSessionInfo[]>, onSelect: (sessionId: string) => void) {
    return orderProjects([...groups.keys()], projectOrder, managedProjectId).map((projectId) => {
      const sessions = groups.get(projectId)!;
      return (
        <section key={projectId} aria-label={sessions[0]!.projectName}>
          <h3 className="incoming-file-project">{sessions[0]!.projectName}</h3>
          <div className="m-group">{renderFamilies(groupProjectSessionFamilies(sessions), sessions, onSelect)}</div>
        </section>
      );
    });
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
            ) : projects.size === 0 && archived.size === 0 ? <p className="m-sheet-note" role="status">这台电脑没有可上传的会话</p> : (
              <>
                {renderProjects(projects, selectSession.bind(null, activeHost.roomId, file))}
                {archived.size > 0 && (
                  <details className="incoming-file-archived" key={activeHost.roomId}>
                    <summary><ChevronRight size={16} aria-hidden="true" />已归档会话</summary>
                    {renderProjects(archived, selectSession.bind(null, activeHost.roomId, file))}
                  </details>
                )}
              </>
            )}
          </>
        )}
        {hostError && <p className="m-sheet-note is-error" role="alert">{hostError}</p>}
      </div>
    </Sheet>
  );
}

function renderFamilies(
  families: SessionFamily<BridgeSessionInfo>[], projectSessions: BridgeSessionInfo[], onSelect: (sessionId: string) => void,
): ReactNode {
  return families.map(({ primary, forks }) => (
    <Fragment key={primary.sessionId}>
      <SheetAction icon={<MessageSquare size={18} />} label={primary.title}
        detail={projectSessions.some((session) => session !== primary && session.title === primary.title)
          ? [primary.currentSummary, primary.cwd.split(/[\\/]/u).filter(Boolean).at(-1), relativeTime(primary.lastActivityAt)].filter(Boolean).join(" · ")
          : undefined}
        onClick={() => onSelect(primary.sessionId)} />
      {forks.length > 0 && (
        <details className="incoming-file-forks">
          <summary><ChevronRight size={16} aria-hidden="true" />{forkGroupToggleLabel(forks)}</summary>
          {renderFamilies(forks, projectSessions, onSelect)}
        </details>
      )}
    </Fragment>
  ));
}
