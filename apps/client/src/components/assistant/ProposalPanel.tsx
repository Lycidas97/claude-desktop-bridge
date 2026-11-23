import type { BridgeActionProposal, BridgeProposalPage } from "@bridge/protocol";
import { ArrowLeft, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { mailResult } from "./AssistantMailProvider.js";
import { proposalRef, useAssistantProposals } from "./AssistantProposalProvider.js";
import { ProposalCard, proposalKindLabel, proposalStatus, proposalTitle } from "./ProposalCard.js";

export function ProposalPanel({ mobile, selected, onSelect }: {
  mobile: boolean; selected: BridgeActionProposal | undefined; onSelect(proposal: BridgeActionProposal | undefined): void;
}) {
  const { request, online, refreshKey, supportsMail, supportsMemory, supportsSession } = useAssistantProposals()!;
  const [history, setHistory] = useState(false);
  const [pages, setPages] = useState<BridgeProposalPage>();
  const [live, setLive] = useState<BridgeActionProposal>();
  const [more, setMore] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!online) return;
    let current = true;
    void request("assistant.proposal.list", { history, ...(supportsMail ? { includeMail: true, limit: 8 } : {}), ...(supportsMemory ? { includeMemory: true } : {}), ...(supportsSession ? { includeSession: true } : {}) }).then(response => {
      if (current) { setPages(mailResult<BridgeProposalPage>(response)); setError(""); }
    }).catch(reason => { if (current) setError(reason instanceof Error ? reason.message : "无法读取提案。"); });
    return () => { current = false; };
  }, [history, online, refreshKey, request, supportsMail, supportsMemory, supportsSession]);
  useEffect(() => {
    if (!selected || !online) return;
    let current = true;
    void request("assistant.proposal.resolve", { sessionId: selected.sessionId, refs: [proposalRef(selected)], latestForReview: true, ...(supportsMail ? { includeMail: true } : {}), ...(supportsMemory ? { includeMemory: true } : {}), ...(supportsSession ? { includeSession: true } : {}) }).then(response => {
      if (current) setLive(mailResult<{ proposals: BridgeActionProposal[] }>(response).proposals[0]);
    }).catch(reason => { if (current) setError(reason instanceof Error ? reason.message : "无法核对提案。"); });
    return () => { current = false; };
  }, [online, refreshKey, request, selected, supportsMail, supportsMemory, supportsSession]);

  async function loadMore() {
    const cursor = pages?.nextCursor;
    if (!cursor) return;
    setMore(true);
    try {
      const page = mailResult<BridgeProposalPage>(await request("assistant.proposal.list", { history, cursor, ...(supportsMail ? { includeMail: true, limit: 8 } : {}), ...(supportsMemory ? { includeMemory: true } : {}), ...(supportsSession ? { includeSession: true } : {}) }));
      setPages(current => current?.nextCursor === cursor ? { ...page, proposals: [...current.proposals, ...page.proposals] } : current);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "无法读取更多提案。"); }
    finally { setMore(false); }
  }

  if (selected) {
    const latest = live?.proposalId === selected.proposalId ? live : undefined;
    return <section className="proposal-panel" aria-label="提案详情">
      {!mobile && <button type="button" className="assistant-session-link proposal-back" onClick={() => onSelect(undefined)}><ArrowLeft size={16} /> 返回列表</button>}
      {error && <p role="alert">{error}</p>}
      <ProposalCard key={selected.proposalId} proposal={latest?.revision === selected.revision ? latest : selected} mobile={mobile} review
        replaced={Boolean(latest && latest.revision > selected.revision)} onResult={proposal => { onSelect(proposal); setLive(proposal); }} />
    </section>;
  }

  return <section className="proposal-panel" aria-label="待确认提案">
    <nav className="assistant-view-switch" aria-label="提案状态">
      <button type="button" aria-pressed={!history} disabled={more} onClick={() => { if (history) { setHistory(false); setPages(undefined); } }}>待确认</button>
      <button type="button" aria-pressed={history} disabled={more} onClick={() => { if (!history) { setHistory(true); setPages(undefined); } }}>处理记录</button>
    </nav>
    {!online && <p role="status">连接电脑后可处理提案。</p>}
    {error && <p role="alert">{error}</p>}
    {online && !error && !pages && <p role="status">正在读取提案…</p>}
    {pages?.proposals.length === 0 && <p role="status">{history ? "暂无处理记录" : "暂无待确认提案"}</p>}
    {pages && pages.proposals.length > 0 && <ul className="proposal-list">
      {pages.proposals.map(proposal => <li key={proposal.proposalId}>
        <button type="button" onClick={() => onSelect(proposal)}>
          <span><strong>{proposalTitle(proposal)}</strong><small>{proposalKindLabel[proposal.action.kind]}
            {proposal.action.kind !== "memory.rule_upsert" && !("targetSessionId" in proposal.action) && ` · ${proposal.sourceLabel}`}
            {history && ` · ${proposalStatus(proposal)}`}</small></span>
          <ChevronRight size={16} aria-hidden="true" />
        </button>
      </li>)}
    </ul>}
    {pages?.nextCursor && <button type="button" className="secondary-button" disabled={!online || more} onClick={() => void loadMore()}>{more ? "正在读取…" : "加载更多"}</button>}
  </section>;
}
