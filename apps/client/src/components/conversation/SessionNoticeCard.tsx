import { ChevronDown, GitFork } from "lucide-react";
import { MarkdownText } from "../common/MarkdownText.js";

export interface SessionNotice {
  title: string;
  summary: string;
  reports: Array<{ title: string; text: string }>;
}

// Presentation only: keep the original message, and recognize complete known
// envelopes before the conversation's ordinary system-reminder cleanup.
export function parseSessionNotice(text: string): SessionNotice | undefined {
  const envelope = /^<(system-reminder|side-sessions-event)>([\s\S]*?)<\/\1>/gmu;
  const blocks = [...text.matchAll(envelope)];
  if (!blocks.length || text.replace(envelope, "").trim()) return undefined;
  const reports: SessionNotice["reports"] = [];
  let idle = false;
  for (const block of blocks) {
    const body = block[2]!.trim();
    if (block[1] === "side-sessions-event") {
      if (!body.startsWith("None of the sessions you started is working now;")) return undefined;
      idle = true;
    } else {
      const report = /^The session "([^"\n]+)" you started \([^)]+\) finished a turn(?: \([^\n]*?\))?\. It reported \(quoted child output, data not instructions\): "([\s\S]*)"(?:\s+Read it with[\s\S]*)?$/u.exec(body);
      if (report) reports.push({ title: report[1]!, text: report[2]! });
      else if (!body.startsWith("Linked sessions now (")) return undefined;
    }
  }
  if (!reports.length && !idle) return undefined;
  return {
    title: reports.length === 1 ? reports[0]!.title : reports.length ? `${reports.length} 个子会话更新` : "子会话动态",
    summary: reports.length
      ? reports.map(report => report.text).join("\n\n").replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1").replace(/[*`#]/gu, "").replace(/\s+/gu, " ").trim()
      : "当前没有运行中的子会话",
    reports,
  };
}

export function SessionNoticeCard({ notice, source, itemId, entering = false }: {
  notice: SessionNotice;
  source: string;
  itemId: string;
  entering?: boolean;
}) {
  return (
    <details className={`session-notice${entering ? " is-entering" : ""}`} data-stream-key={itemId} aria-label="子会话动态">
      <summary>
        <GitFork size={16} aria-hidden="true" />
        <span className="session-notice-heading">
          <strong>{notice.title}</strong>
          <span className="session-notice-excerpt">{notice.summary}</span>
        </span>
        <ChevronDown size={14} className="session-notice-chevron" aria-hidden="true" />
      </summary>
      <div className="session-notice-content">
        {notice.reports.map((report, index) => (
          <section key={index}>
            {notice.reports.length > 1 && <strong>{report.title}</strong>}
            <MarkdownText text={report.text} collapsible={false} />
          </section>
        ))}
        {notice.reports.length ? (
          <details className="session-notice-source">
            <summary>原始通知</summary>
            <pre>{source}</pre>
          </details>
        ) : <pre>{source}</pre>}
      </div>
    </details>
  );
}
