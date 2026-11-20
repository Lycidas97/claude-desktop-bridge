import type { BridgeHistoryItem } from "@bridge/protocol";
import { Braces, File, ChevronRight } from "lucide-react";
import { useState } from "react";
import { IconButton } from "../common/IconButton.js";
import { ToolCallDetailSheet } from "./ToolCallDetailSheet.js";

export function SessionSentFiles({ item, toolUseId, hostId, onOpenFile, supportsToolDetail }: {
  item: BridgeHistoryItem & { sentFiles: NonNullable<BridgeHistoryItem["sentFiles"]> };
  toolUseId: string;
  hostId: string;
  onOpenFile?: ((path: string) => void) | undefined;
  supportsToolDetail: boolean;
}) {
  const [detailOpen, setDetailOpen] = useState(false);
  return (
    <section className="session-sent-files" aria-label="会话文件" data-stream-key={item.id}>
      <ul>
        {item.sentFiles.map(({ name, path }, index) => (
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
                <span>{name}<small>请在电脑端打开</small></span>
              </div>
            )}
          </li>
        ))}
      </ul>
      <IconButton className="session-sent-files-detail" label="查看工具详情" onClick={() => setDetailOpen(true)}>
        <Braces size={16} aria-hidden="true" />
      </IconButton>
      {detailOpen && <ToolCallDetailSheet hostId={hostId} sessionId={item.sessionId} toolUseId={toolUseId}
        toolName="SendUserFile" fallbackText={item.text} supportsToolDetail={supportsToolDetail} onClose={() => setDetailOpen(false)} />}
    </section>
  );
}
