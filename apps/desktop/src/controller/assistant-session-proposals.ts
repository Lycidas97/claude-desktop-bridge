import { CLAUDE_UNSECTIONED_PROJECT_NAME } from "@bridge/protocol";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { AssistantError } from "../../../../plugins/assistant-mail/assistant-error.js";
import type { SessionProposalBackend } from "../../../../plugins/assistant-mail/proposal-executor.js";
import { WorkspaceTrustRequiredError, type ClaudeDesktopBridge } from "../claude/claude-desktop-bridge.js";
import { InspectorDisconnectedError, InspectorNotDispatchedError, NativeCallError } from "../claude/claude-desktop-inspector.js";
import type { ConversationStateStore } from "./conversation-state-store.js";

export function assistantSessionProposalBackend(
  broker: ClaudeDesktopBridge,
  receipts: ConversationStateStore,
  ownsDraft: SessionProposalBackend["ownsDraft"],
  isAssistantWorkspace: (cwd: string) => boolean,
  insideAssistantWorkspace: (cwd: string) => Promise<boolean>,
): SessionProposalBackend {
  const sections = () => broker.listProjects().filter(project => project.kind === "desktop-group" && !project.managedAssistant);
  const modelOptions = async () => (await broker.defaultConfiguration()).availableModels.map(({ value, displayName }) => ({ value, label: displayName }));
  async function usableDirectory(cwd: string): Promise<boolean> {
    try {
      return (await stat(cwd)).isDirectory() && !(await insideAssistantWorkspace(cwd));
    } catch (error) {
      if (["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
      throw error;
    }
  }
  return {
    ownsDraft,
    creation: {
      async options(query) {
        if (query.field === "model") return modelOptions();
        if (query.field === "project") return [
          { value: null, label: CLAUDE_UNSECTIONED_PROJECT_NAME },
          ...(broker.capabilities().includes("section.move") ? sections().map(({ projectId, name }) => ({ value: projectId, label: name })) : []),
        ];
        const name = query.name?.toLowerCase();
        const normalized = name?.trim();
        const exact = [];
        const alternatives = [];
        for (const value of new Set(broker.listSessions().filter(session => !session.archivedAt && !session.sidechat)
          .map(session => session.cwd).filter(cwd => isAbsolute(cwd)))) {
          const label = basename(value) || value;
          const folded = label.toLowerCase();
          if (name === undefined || folded === name) exact.push({ value, label });
          else if (folded.trim() === normalized) alternatives.push({ value, label });
        }
        const options = [];
        for (const option of [...exact, ...alternatives]) {
          if (!(await usableDirectory(option.value))) continue;
          options.push(option);
          if (options.length === 12) break;
        }
        return options;
      },
      async prepare(action) {
        const capabilities = broker.capabilities();
        if (!capabilities.includes("session.create") || !capabilities.includes("session.configure") ||
          (action.text !== undefined && !capabilities.includes("turn.start"))) {
          throw new AssistantError("UNSUPPORTED", "当前 Claude Desktop 无法完成这项新建会话操作。");
        }
        if (!isAbsolute(action.cwd)) throw new AssistantError("INVALID_PARAMS", "请提供绝对工作目录路径。");
        if (!(await usableDirectory(action.cwd))) {
          throw new AssistantError("INVALID_PARAMS", "请选择可用的工作目录，不能使用助理托管工作区。");
        }
        const section = action.projectId === null ? undefined : sections().find(project => project.projectId === action.projectId);
        if (action.projectId !== null && (!section || !capabilities.includes("section.move"))) {
          throw new AssistantError("INVALID_PARAMS", "所选 Desktop 分组不可用，请重新选择。");
        }
        const model = (await modelOptions()).find(option => option.value === action.model);
        if (!model) throw new AssistantError("INVALID_PARAMS", "所选模型不在当前 Desktop 模型目录中，请重新选择。");
        return { projectName: section?.name ?? CLAUDE_UNSECTIONED_PROJECT_NAME, modelName: model.label };
      },
      async create(action, onCreated) {
        let sessionId: string;
        try {
          ({ sessionId } = await broker.createSession(action.cwd, action.title, action.projectId ?? undefined, undefined, onCreated));
        } catch (error) {
          if (error instanceof WorkspaceTrustRequiredError) return { failure: "trust-required" };
          if (error instanceof InspectorDisconnectedError && !(error instanceof InspectorNotDispatchedError)) return { uncertain: true };
          if (error instanceof NativeCallError || error instanceof InspectorNotDispatchedError) return { failure: "create" };
          throw error;
        }
        try {
          await broker.configureSession({ sessionId, model: action.model });
        } catch (error) {
          if (!(error instanceof NativeCallError || error instanceof InspectorDisconnectedError)) throw error;
          return { failure: "model" };
        }
        return { sessionId };
      },
    },
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
