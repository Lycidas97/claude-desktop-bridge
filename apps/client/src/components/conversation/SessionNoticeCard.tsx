import { ChevronDown, GitFork, MessagesSquare, Monitor } from "lucide-react";
import type { SessionNotice } from "../../lib/session-notice.js";
import { MarkdownText } from "../common/MarkdownText.js";

export function SessionNoticeCard({ notice, source, itemId, entering = false, onFileClick }: {
  notice: SessionNotice;
  source: string;
  itemId: string;
  entering?: boolean;
  onFileClick?: (filePath: string) => void;
}) {
  return (
    <details className={`session-notice${entering ? " is-entering" : ""}`} data-stream-key={itemId}
      open={notice.kind === "cross-session"} aria-label={notice.kind === "ci-monitor" ? "CI 监控事件" : notice.kind === "cross-session" ? "跨会话消息" : "子会话动态"}>
      <summary>
        {notice.kind === "ci-monitor" ? <Monitor size={16} aria-hidden="true" /> : notice.kind === "cross-session" ? <MessagesSquare size={16} aria-hidden="true" /> : <GitFork size={16} aria-hidden="true" />}
        <span className="session-notice-heading">
          <strong>{notice.title}</strong>
          <span className="session-notice-excerpt">{notice.summary}</span>
        </span>
        <ChevronDown size={14} className="session-notice-chevron" aria-hidden="true" />
      </summary>
      <div className="session-notice-content">
        {notice.reports.map((report, index) => (
          <section key={index}>
            {notice.reports.length > 1 && !notice.commonSender && <strong>{report.title}</strong>}
            <MarkdownText text={report.text} collapsible={false} {...(onFileClick ? { onFileClick } : {})} />
          </section>
        ))}
        {!notice.kind && (notice.reports.length ? (
          <details className="session-notice-source">
            <summary>原始通知</summary>
            <pre>{source}</pre>
          </details>
        ) : <pre>{source}</pre>)}
      </div>
    </details>
  );
}
