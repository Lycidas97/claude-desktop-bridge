import type { BridgeHistoryItem, BridgeSentFile } from "@bridge/protocol";
import { ChevronRight, File } from "lucide-react";
import { useState } from "react";
import { ToolCallDetailSheet } from "./ToolCallDetailSheet.js";

export function SessionSentFiles({ item, toolUseId, hostId, onOpenFile, supportsToolDetail }: {
  item: BridgeHistoryItem & { sentFiles: BridgeSentFile[] };
  toolUseId: string;
  hostId: string;
  onOpenFile?: ((path: string) => void) | undefined;
  supportsToolDetail: boolean;
}) {
  const [detailOpen, setDetailOpen] = useState(false);
  return (
    <section className="session-sent-files" aria-label="会话文件" data-stream-key={item.id}>
      <ul>
        {item.sentFiles.map(({ name, path, blockedReason }, index) => (
          <li key={index}>
            {path && onOpenFile ? (
              <button type="button" onClick={() => onOpenFile(path)}>
                <File size={16} aria-hidden="true" />
                <span>{name}</span>
                <ChevronRight size={14} aria-hidden="true" />
              </button>
            ) : (
              <div>
                <File size={16} aria-hidden="true" />
                <span>{name}<small>{blockedReason ?? "无法从会话打开"}</small></span>
              </div>
            )}
          </li>
        ))}
      </ul>
      <button type="button" className="session-sent-files-detail" onClick={() => setDetailOpen(true)}>
        查看工具详情
      </button>
      {detailOpen && <ToolCallDetailSheet hostId={hostId} sessionId={item.sessionId} toolUseId={toolUseId}
        toolName="SendUserFile" fallbackText={item.text} supportsToolDetail={supportsToolDetail} onClose={() => setDetailOpen(false)} />}
    </section>
  );
}
