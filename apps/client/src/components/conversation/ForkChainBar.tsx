import type { BridgeSessionInfo } from "@bridge/protocol";
import { CornerUpLeft, GitFork, X } from "lucide-react";

export interface ForkChainBarProps {
  parentSession?: BridgeSessionInfo | undefined;
  isSidechat?: boolean | undefined;
  onSelectSession: (sessionId: string) => void;
  onClose?: (() => void) | undefined;
  className?: string | undefined;
}

export function ForkChainBar({
  parentSession,
  isSidechat = false,
  onSelectSession,
  onClose,
  className,
}: ForkChainBarProps) {
  if (!parentSession) return null;
  return (
    <div className={`relay-chain-bar fork-chain-bar${className ? ` ${className}` : ""}`}>
      <button
        type="button"
        className="relay-chain-link"
        onClick={() => onSelectSession(parentSession.sessionId)}
      >
        {isSidechat
          ? <CornerUpLeft size={12.5} aria-hidden="true" />
          : <GitFork size={12.5} aria-hidden="true" />}
        {`主会话：${parentSession.title}`}
      </button>
      {onClose && (
        <button
          type="button"
          className="relay-chain-link relay-chain-dismiss"
          aria-label="收起分支"
          onClick={onClose}
        >
          <X size={13} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
