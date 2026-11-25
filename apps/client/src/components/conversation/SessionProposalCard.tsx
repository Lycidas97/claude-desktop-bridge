import { useState } from "react";
import { Braces, ChevronDown, GitFork } from "lucide-react";
import type { BridgeHistoryItem } from "@bridge/protocol";
import { MessageCopyButton } from "../common/MessageCopyButton.js";
import { ToolCallDetailSheet } from "./ToolCallDetailSheet.js";

export function SessionProposalCard({ proposal, itemId, hostId, sessionId, toolUseId, toolName, summary, supportsToolDetail }: {
  proposal: NonNullable<BridgeHistoryItem["sessionProposal"]>;
  itemId: string;
  hostId?: string;
  sessionId: string;
  toolUseId: string;
  toolName: string;
  summary: string;
  supportsToolDetail: boolean;
}) {
  const [detailOpen, setDetailOpen] = useState(false);
  return (
    <section className="session-proposal-card" aria-label="会话提案" data-stream-key={itemId}>
      <GitFork size={17} className="session-proposal-icon" aria-hidden="true" />
      <div className="session-proposal-heading">
        <span>会话提案</span>
        <strong>{proposal.title}</strong>
      </div>
      <button type="button" className="session-proposal-detail" aria-label="查看工具详情" title="查看工具详情"
        onClick={() => setDetailOpen(true)}>
        <Braces size={16} aria-hidden="true" />
      </button>
      {proposal.background && (
        <details className="session-proposal-background">
          <summary>
            <span>{proposal.background}</span>
            <ChevronDown size={14} aria-hidden="true" />
          </summary>
        </details>
      )}
      <div className="session-proposal-actions">
        <span>只能在 Claude Desktop 里确认</span>
        <MessageCopyButton text={proposal.title} label="复制标题" buttonText="复制标题" />
      </div>
      {detailOpen && <ToolCallDetailSheet
        {...(hostId ? { hostId } : {})}
        sessionId={sessionId}
        toolUseId={toolUseId}
        toolName={toolName}
        fallbackText={summary}
        supportsToolDetail={supportsToolDetail}
        onClose={() => setDetailOpen(false)}
      />}
    </section>
  );
}
