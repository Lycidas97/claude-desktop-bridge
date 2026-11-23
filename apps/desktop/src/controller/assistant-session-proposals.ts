import { randomUUID } from "node:crypto";
import type { SessionProposalBackend } from "../../../../plugins/assistant-mail/proposal-executor.js";
import type { ClaudeDesktopBridge } from "../claude/claude-desktop-bridge.js";
import { InspectorDisconnectedError, NativeCallError } from "../claude/claude-desktop-inspector.js";
import type { ConversationStateStore } from "./conversation-state-store.js";

export function assistantSessionProposalBackend(
  broker: ClaudeDesktopBridge,
  receipts: ConversationStateStore,
  ownsDraft: SessionProposalBackend["ownsDraft"],
  isAssistantWorkspace: (cwd: string) => boolean,
): SessionProposalBackend {
  return {
    ownsDraft,
    async target(action) {
      const { targetSessionId } = action;
      const session = broker.session(targetSessionId);
      if (session?.transport !== "claude-desktop-native" || isAssistantWorkspace(session.cwd) || session.sidechat) return;
      if (action.kind === "session.send" && !broker.capabilities().includes("turn.start")) return;
      try {
        const identity = await broker.readNativeSessionIdentity(targetSessionId);
        if (identity && !identity.archived && !isAssistantWorkspace(identity.cwd)) return identity;
      } catch (error) {
        if (!(error instanceof NativeCallError || error instanceof InspectorDisconnectedError)) throw error;
      }
    },
    async send(action, key, turnRunning) {
      try {
        await broker.startTurn({ sessionId: action.targetSessionId, text: action.text, requestId: randomUUID(), idempotencyKey: key,
          origin: "system", source: "assistant-proposal", nativeTurnRunning: turnRunning });
      } catch (error) {
        // A Native rejection is recorded by the broker; a disappeared target can fail even before a receipt exists.
        if (!(error instanceof NativeCallError || error instanceof InspectorDisconnectedError)) throw error;
      }
    },
    delivery: key => receipts.nativeDesktopReceipt(key)?.state,
  };
}
