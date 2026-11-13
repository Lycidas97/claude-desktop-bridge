import type { BridgeEvent, BridgePrAutoFixState, BridgePrAutoFixUpdate, BridgePullRequest, BridgeSessionInfo } from "@bridge/protocol";
import { ChevronDown, GitPullRequest, LoaderCircle, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import "./session-pr-bar.css";

export function SessionPrBar({ session, events, supported, online, onRead, onSet }: {
  session: BridgeSessionInfo;
  events?: BridgeEvent[];
  supported: boolean;
  online: boolean;
  onRead?(sessionId: string, pr?: BridgePullRequest, includeChecks?: boolean): Promise<BridgePrAutoFixState>;
  onSet?(update: BridgePrAutoFixUpdate): Promise<BridgePrAutoFixState>;
}) {
  const [state, setState] = useState<BridgePrAutoFixState>();
  const [details, setDetails] = useState<Record<string, BridgePrAutoFixState>>({});
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const available = supported && online && Boolean(onRead && onSet);
  const prs = state?.prs ?? session.prs ?? [];
  const prUpdate = events?.filter(event => event.sessionId === session.sessionId && event.type === "pr.autoFix.updated").at(-1);
  useEffect(() => {
    if (!prUpdate) return;
    if (prUpdate.data.state) setState(prUpdate.data.state as BridgePrAutoFixState);
    setError(typeof prUpdate.data.error === "string" ? prUpdate.data.error : undefined);
  }, [prUpdate?.eventId]);
  useEffect(() => {
    setState(current => current ? { ...current, prs: session.prs ?? [], ...(session.prAutoFix ?? {}) } : current);
  }, [session.prs, session.prAutoFix]);

  async function read(pr?: BridgePullRequest): Promise<void> {
    setBusy(pr ? `${pr.host ?? ""}/${pr.repo}/${pr.prNumber}` : "read");
    setError(undefined);
    try {
      const next = await onRead!(session.sessionId, pr, Boolean(pr));
      setState(next);
      if (pr) setDetails(current => ({ ...current, [`${pr.host ?? ""}/${pr.repo}/${pr.prNumber}`]: next }));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "PR 状态读取失败");
    } finally {
      setBusy(undefined);
    }
  }

  async function update(change: BridgePrAutoFixUpdate): Promise<void> {
    setBusy("write");
    setError(undefined);
    try {
      setState(await onSet!(change));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Auto-fix 设置失败");
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <details className="session-pr-bar" onToggle={event => {
      if (event.target === event.currentTarget && event.currentTarget.open && !busy && available) void read();
    }}>
      <summary>
        <GitPullRequest size={15} aria-hidden="true" />
        <span>{prs.length ? `PR · ${prs.length}` : "PR Auto-fix"}</span>
        <ChevronDown size={14} className="session-pr-chevron" aria-hidden="true" />
      </summary>
      <div className="session-pr-body">
        {!supported ? <p>当前电脑端不支持 PR Auto-fix</p> : !online ? <p>电脑离线，连接后再操作</p> : null}
        {busy && <span className="session-pr-loading" role="status"><LoaderCircle size={14} className="is-spinning" />正在同步</span>}
        {error && <div className="permission-error" role="alert">{error}</div>}
        {state && (
          <div className="session-pr-preferences">
            <label>
              <input type="checkbox" checked={state.onlyOwnPrs === true}
                disabled={!available || Boolean(busy) || !state.capabilities.onlyOwnPrs || state.onlyOwnPrs === undefined}
                onChange={event => void update({ sessionId: session.sessionId, target: "own-prs", enabled: event.target.checked })} />
              <span>仅我的 PR</span>
            </label>
            <label>
              <input type="checkbox" checked={state.nextOwnPrArmed === true}
                disabled={!available || Boolean(busy) || !state.capabilities.nextPr || state.nextOwnPrArmed === undefined}
                onChange={event => void update({ sessionId: session.sessionId, target: "next-pr", enabled: event.target.checked })} />
              <span>下一个 PR 布防</span>
            </label>
          </div>
        )}
        {prs.map(pr => {
          const key = `${pr.host ?? ""}/${pr.repo}/${pr.prNumber}`;
          const detail = details[key];
          return (
            <details key={key} className="session-pr-entry" onToggle={event => {
              if (event.target === event.currentTarget && event.currentTarget.open && !detail && !busy && available && state?.capabilities.checks) void read(pr);
            }}>
              <summary><span>{pr.repo}#{pr.prNumber}</span><small>{pr.state}</small></summary>
              <div className="session-pr-entry-body">
                <a href={pr.url} target="_blank" rel="noreferrer">{detail?.overview?.title || `查看 PR #${pr.prNumber}`}</a>
                <label>
                  <input type="checkbox" aria-label={`${pr.repo}#${pr.prNumber} Auto-fix`} checked={pr.autoFix === true}
                    disabled={!available || Boolean(busy) || !state?.capabilities.bound}
                    onChange={event => void update({ sessionId: session.sessionId, target: "bound", repo: pr.repo, prNumber: pr.prNumber, ...(pr.host ? { host: pr.host } : {}), enabled: event.target.checked })} />
                  <span>Auto-fix</span>
                </label>
                {detail?.checks && (detail.checks.length ? (
                  <ul className="session-pr-checks" aria-label="PR 检查">
                    {detail.checks.map((check, index) => (
                      <li key={`${check.name}:${index}`} className={/^fail$|failure|failed|error|timed_out|action_required/iu.test(check.state) ? "is-failed" : ""}>
                        {check.url ? <a href={check.url} target="_blank" rel="noreferrer">{check.name}</a> : <span>{check.name}</span>}
                        <small>{check.state}</small>
                      </li>
                    ))}
                  </ul>
                ) : <span className="session-pr-empty">暂无检查</span>)}
                <button type="button" className="message-copy-button" disabled={!available || Boolean(busy) || !state?.capabilities.checks} onClick={() => void read(pr)}><RefreshCw size={13} />刷新检查</button>
              </div>
            </details>
          );
        })}
        <button type="button" className="message-copy-button" disabled={!available || Boolean(busy)} onClick={() => void read()}><RefreshCw size={13} />刷新 PR 状态</button>
      </div>
    </details>
  );
}
