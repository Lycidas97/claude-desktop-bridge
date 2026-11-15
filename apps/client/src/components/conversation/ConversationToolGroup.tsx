import { ChevronDown, Wrench } from "lucide-react";
import type { ConversationItem } from "../../lib/conversation-timeline.js";
import { ToolCallGroupRows } from "./ToolCallDetailSheet.js";

export interface ConversationToolGroupProps {
  hostId?: string | undefined;
  sessionId: string;
  tools: ConversationItem[];
  supportsToolDetail: boolean;
}

export function ConversationToolGroup({
  hostId,
  sessionId,
  tools,
  supportsToolDetail,
}: ConversationToolGroupProps) {
  const uniqueNames = [...new Set(tools.map((tool) => tool.toolName || "工具"))].slice(0, 3);
  const anyRunning = tools.some((tool) => tool.state === "running");
  const singleTool = tools.length === 1 ? tools[0] : undefined;
  const summaryText = singleTool
    ? `${singleTool.toolName || "工具"}${singleTool.text && singleTool.text !== singleTool.toolName ? ` · ${singleTool.text}` : ""}`
    : `${anyRunning ? "正在执行" : "已调用"} ${tools.length} 个工具 (${uniqueNames.join("、")})`;
  const lastTool = tools.at(-1);
  return (
    <details
      className={`conversation-tool-group ${anyRunning ? "is-running" : ""}`}
      {...(lastTool ? { "data-stream-key": `tool-group:${lastTool.id}` } : {})}
    >
      <summary>
        <Wrench size={13} aria-hidden="true" />
        <span>{summaryText}</span>
        <ChevronDown size={13} className="tool-group-chevron" aria-hidden="true" />
      </summary>
      <ToolCallGroupRows
        {...(hostId ? { hostId } : {})}
        sessionId={sessionId}
        tools={tools}
        supportsToolDetail={supportsToolDetail}
      />
    </details>
  );
}
