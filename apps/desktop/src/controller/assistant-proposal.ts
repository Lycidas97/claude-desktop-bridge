import type { BridgeRequest } from "@bridge/protocol";
import { AssistantError } from "../../../../plugins/assistant-mail/assistant-error.js";
import { proposalRequests } from "../../../../plugins/assistant-mail/proposal-contract.js";
import type { ProposalExecutor } from "../../../../plugins/assistant-mail/proposal-executor.js";
import type { z } from "zod";
import { BridgeRequestError } from "./request-error.js";

export async function handleAssistantProposal(
  proposals: ProposalExecutor,
  method: BridgeRequest["method"],
  params: Record<string, unknown>,
  actor: string,
  replan: (sessionId: string, text: string, displayText: string) => Promise<unknown>,
) {
  function parse<T extends z.ZodType>(schema: T): z.output<T> {
    const input = schema.safeParse(params);
    if (!input.success) throw new BridgeRequestError("INVALID_PARAMS", "提案请求格式不正确。");
    return input.data;
  }
  try {
    switch (method) {
      case "assistant.proposal.list": return proposals.page(parse(proposalRequests[method]));
      case "assistant.proposal.resolve": {
        const { sessionId, refs, latestForReview, includeMail, includeMemory, includeSession, includeSessionCreate, includeMailAttachments } = parse(proposalRequests[method]);
        return { proposals: proposals.resolve(sessionId, refs, latestForReview, includeMail, includeMemory, includeSession, includeSessionCreate, includeMailAttachments) };
      }
      case "assistant.proposal.commit": return { proposal: await proposals.commit(parse(proposalRequests[method]), actor) };
      case "assistant.proposal.dismiss": return { proposal: proposals.dismiss(parse(proposalRequests[method]), actor) };
      case "assistant.proposal.revise": {
        const { action, ...ref } = parse(proposalRequests[method]);
        if (action.kind === "memory.rule_upsert" || action.kind === "session.create") throw new BridgeRequestError("UNSUPPORTED", "请让助理直接修订此提案。");
        return { proposal: await proposals.revise(ref, action) };
      }
      case "assistant.proposal.replan": {
        const { feedback, ...ref } = parse(proposalRequests[method]);
        const { sessionId, action } = proposals.pending(ref);
        if (action.kind === "memory.rule_upsert" || action.kind === "session.create" || "targetSessionId" in action) {
          throw new BridgeRequestError("UNSUPPORTED", "请让助理直接修订此提案。");
        }
        return await replan(sessionId, [
          `请重查相关议程和空档，按以下意见调整提案。只用 proposal.update_pending 修订此版本，不要提交执行：${JSON.stringify(ref)}`,
          feedback,
        ].join("\n\n"), feedback);
      }
      default: throw new BridgeRequestError("UNSUPPORTED", "不支持此提案操作。");
    }
  } catch (error) {
    if (error instanceof AssistantError) throw new BridgeRequestError(error.code, error.message);
    throw error;
  }
}
