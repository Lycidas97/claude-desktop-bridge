import type { BridgeSessionInfo } from "@bridge/protocol";
import { GitFork, X } from "lucide-react";

export interface ForkChainBarProps {
  parentSession?: BridgeSessionInfo | undefined;
  childForks: readonly BridgeSessionInfo[];
  onSelectSession: (sessionId: string) => void;
  onClose?: (() => void) | undefined;
  className?: string | undefined;
}

export function ForkChainBar({
  parentSession,
  childForks,
  onSelectSession,
  onClose,
  className,
}: ForkChainBarProps) {
  if (!parentSession && childForks.length === 0) return null;
  return (
    <div className={`relay-chain-bar fork-chain-bar${className ? ` ${className}` : ""}`}>
      {parentSession && (
        <button
          type="button"
          className="relay-chain-link"
          onClick={() => onSelectSession(parentSession.sessionId)}
        >
          <GitFork size={14} />
          {`主会话：${parentSession.title}`}
        </button>
      )}
      {childForks.map((fork) => (
        <button
          type="button"
          className="relay-chain-link outbound"
          key={fork.sessionId}
          onClick={() => onSelectSession(fork.sessionId)}
        >
          <GitFork size={14} />
          {`${fork.sidechat ? "/btw" : (fork.forkLabel || "fork")} · ${fork.title}`}
        </button>
      ))}
      {onClose && (
        <button type="button" className="relay-chain-link" aria-label="收起分支" onClick={onClose}>
          <X size={14} />
        </button>
      )}
    </div>
  );
}
