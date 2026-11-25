import { ASSISTANT_MEMORY_PROPOSAL_CAPABILITY, ASSISTANT_PROPOSAL_CAPABILITY, ASSISTANT_SESSION_PROPOSAL_CAPABILITY, ASSISTANT_SESSION_CREATE_PROPOSAL_CAPABILITY, ASSISTANT_SMTP_CAPABILITY, type BridgeActionProposal, type BridgeHostSnapshot, type BridgeProposalSnapshot, type ProposalRevisionRef } from "@bridge/protocol";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { proposalAnchors } from "../../lib/conversation-timeline.js";
import { mailResult, useAssistantMail, type AssistantRequest } from "./AssistantMailProvider.js";

type ProposalContext = { summary: BridgeProposalSnapshot; online: boolean; supportsMail: boolean; supportsMemory: boolean; supportsSession: boolean; supportsSessionCreate: boolean; hostName: string; openSession(sessionId: string): void; request: AssistantRequest; refresh(): void; refreshKey: string };
const Context = createContext<ProposalContext | undefined>(undefined);

export function AssistantProposalProvider({ snapshot, online, request, openSession, children }: {
  snapshot: BridgeHostSnapshot | undefined; online: boolean; request: AssistantRequest; openSession(sessionId: string): void; children: ReactNode;
}) {
  const [refreshCount, setRefreshCount] = useState(0);
  const summary = snapshot?.host.capabilities.includes(ASSISTANT_PROPOSAL_CAPABILITY) ? snapshot.assistantProposals : undefined;
  const supportsMail = snapshot?.host.capabilities.includes(ASSISTANT_SMTP_CAPABILITY) ?? false;
  const supportsMemory = snapshot?.host.capabilities.includes(ASSISTANT_MEMORY_PROPOSAL_CAPABILITY) ?? false;
  const supportsSession = snapshot?.host.capabilities.includes(ASSISTANT_SESSION_PROPOSAL_CAPABILITY) ?? false;
  const supportsSessionCreate = snapshot?.host.capabilities.includes(ASSISTANT_SESSION_CREATE_PROPOSAL_CAPABILITY) ?? false;
  const hostName = snapshot?.host.name ?? "";
  const value = useMemo(() => summary && ({ summary, online, supportsMail, supportsMemory, supportsSession, supportsSessionCreate, hostName, openSession, request, refresh: () => setRefreshCount(count => count + 1),
    refreshKey: `${summary.changeToken}:${refreshCount}` }), [summary, online, supportsMail, supportsMemory, supportsSession, supportsSessionCreate, hostName, openSession, request, refreshCount]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export const useAssistantProposals = () => useContext(Context);
export function pendingProposalCount(proposals: ProposalContext | undefined): number {
  if (!proposals) return 0;
  const { pendingCount, pendingMailCount, pendingMemoryCount, pendingSessionCount, pendingSessionCreateCount } = proposals.summary;
  return pendingCount + (pendingMailCount ?? 0) + (proposals.supportsMemory ? pendingMemoryCount ?? 0 : 0) +
    (proposals.supportsSession ? pendingSessionCount ?? 0 : 0) + (proposals.supportsSessionCreate ? pendingSessionCreateCount ?? 0 : 0);
}

export function useAssistantEntry() {
  const mail = useAssistantMail();
  const pending = pendingProposalCount(useAssistantProposals());
  const unread = mail?.attention === undefined ? mail?.unreadCount ?? 0 : 0;
  const attention = mail?.attention !== undefined && (pending > 0 || mail.attention.length > 0);
  return { unread, attention, label: attention ? "助理，有事项待关注" : unread ? `助理，${unread} 条未读` : "助理" };
}

export function useInlineProposals(sessionId: string, anchors: ReturnType<typeof proposalAnchors>) {
  const { request, refreshKey, online, supportsMail, supportsMemory, supportsSession, supportsSessionCreate } = useAssistantProposals() ?? {};
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
        ...(supportsMail ? { includeMail: true } : {}), ...(supportsMemory ? { includeMemory: true } : {}), ...(supportsSession ? { includeSession: true } : {}),
        ...(supportsSessionCreate ? { includeSessionCreate: true } : {}) })
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
  }, [anchorKey, online, refreshKey, request, sessionId, supportsMail, supportsMemory, supportsSession, supportsSessionCreate]);
  return request && anchorKey !== "[]" && loaded?.sessionId === sessionId ? loaded.cards : undefined;
}

export function proposalRef({ proposalId, revision, payloadHash }: ProposalRevisionRef): ProposalRevisionRef {
  return { proposalId, revision, payloadHash };
}
