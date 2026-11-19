import { ASSISTANT_MEMORY_PROPOSAL_CAPABILITY, ASSISTANT_PROPOSAL_CAPABILITY, ASSISTANT_SMTP_CAPABILITY, type BridgeActionProposal, type BridgeHostSnapshot, type BridgeProposalSnapshot, type ProposalRevisionRef } from "@bridge/protocol";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { proposalAnchors } from "../../lib/conversation-timeline.js";
import { mailResult, type AssistantRequest } from "./AssistantMailProvider.js";

type ProposalContext = { summary: BridgeProposalSnapshot; online: boolean; supportsMail: boolean; supportsMemory: boolean; request: AssistantRequest; refresh(): void; refreshKey: string };
const Context = createContext<ProposalContext | undefined>(undefined);

export function AssistantProposalProvider({ snapshot, online, request, children }: {
  snapshot: BridgeHostSnapshot | undefined; online: boolean; request: AssistantRequest; children: ReactNode;
}) {
  const [refreshCount, setRefreshCount] = useState(0);
  const summary = snapshot?.host.capabilities.includes(ASSISTANT_PROPOSAL_CAPABILITY) ? snapshot.assistantProposals : undefined;
  const supportsMail = snapshot?.host.capabilities.includes(ASSISTANT_SMTP_CAPABILITY) ?? false;
  const supportsMemory = snapshot?.host.capabilities.includes(ASSISTANT_MEMORY_PROPOSAL_CAPABILITY) ?? false;
  const value = useMemo(() => summary && ({ summary, online, supportsMail, supportsMemory, request, refresh: () => setRefreshCount(count => count + 1),
    refreshKey: `${summary.changeToken}:${refreshCount}` }), [summary, online, supportsMail, supportsMemory, request, refreshCount]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export const useAssistantProposals = () => useContext(Context);

export function useInlineProposals(sessionId: string, anchors: ReturnType<typeof proposalAnchors>) {
  const { request, refreshKey, online, supportsMail, supportsMemory } = useAssistantProposals() ?? {};
  const anchorKey = JSON.stringify(anchors);
  const [loaded, setLoaded] = useState<{ sessionId: string; cards: Map<string, BridgeActionProposal> }>();
  useEffect(() => {
    if (!request || !online || anchorKey === "[]") return;
    const anchors: ReturnType<typeof proposalAnchors> = JSON.parse(anchorKey);
    let current = true;
    const tasks = [];
    const limit = supportsMail ? 8 : 100;
    for (let index = 0; index < anchors.length; index += limit) {
      tasks.push(request("assistant.proposal.resolve", { sessionId, refs: anchors.slice(index, index + limit).map(anchor => anchor.ref),
        ...(supportsMail ? { includeMail: true } : {}), ...(supportsMemory ? { includeMemory: true } : {}) })
        .then(response => mailResult<{ proposals: BridgeActionProposal[] }>(response).proposals));
    }
    void Promise.all(tasks).then(pages => {
      if (!current) return;
      const byId = new Map(pages.flat().map(proposal => [proposal.proposalId, proposal]));
      setLoaded({ sessionId, cards: new Map(anchors.flatMap(({ ref, itemId }) => {
        const proposal = byId.get(ref.proposalId);
        return proposal ? [[itemId, proposal]] : [];
      })) });
    }, () => { /* Keep the last resolved cards if a refresh fails. */ });
    return () => { current = false; };
  }, [anchorKey, online, refreshKey, request, sessionId, supportsMail, supportsMemory]);
  return request && anchorKey !== "[]" && loaded?.sessionId === sessionId ? loaded.cards : undefined;
}

export function proposalRef({ proposalId, revision, payloadHash }: ProposalRevisionRef): ProposalRevisionRef {
  return { proposalId, revision, payloadHash };
}
