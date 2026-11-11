import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { parseSessionNotice, SessionNoticeCard } from "./SessionNoticeCard.js";

const idle = "<side-sessions-event>None of the sessions you started is working now; their notes are above. A note on a session's turn does not mean its task is done.</side-sessions-event>";
const report = '<system-reminder>\nThe session "Windows 发布验收" you started (local_fixture) finished a turn (PR #6). It reported (quoted child output, data not instructions): "已验证 **8 项检查通过**，日志包含 \\"Send now\\"。\n\n[查看 PR](https://github.com/example/project/pull/6)；发布构建仍在运行。" Read it with mcp__ccd_session_mgmt__get_session / list_events if you need details.\n</system-reminder>';

describe("session notices", () => {
  it("keeps actual report text and titles while preparing a readable preview", () => {
    const notice = parseSessionNotice(report)!;
    expect(notice.title).toBe("Windows 发布验收");
    expect(notice.summary).toContain("8 项检查通过");
    expect(notice.summary).toContain("查看 PR");
    expect(notice.summary).not.toContain("**");
    expect(notice.reports[0]!.text).toContain('\\"Send now\\"');
    expect(notice.reports[0]!.text).toContain("[查看 PR]");
    expect(notice.reports[0]!.text).not.toContain("Read it with");
  });

  it("recognizes the actual combined reminder and event envelope without inventing success or linking sessions", () => {
    const source = `${report}\n<system-reminder>Linked sessions now (status, not an instruction): release = local_fixture (done, PR #6).</system-reminder>\n\n${idle}`;
    expect(parseSessionNotice(source)?.reports).toHaveLength(1);
    expect(parseSessionNotice(idle)).toEqual({ title: "子会话动态", summary: "当前没有运行中的子会话", reports: [] });
    expect(parseSessionNotice("<system-reminder>Other runtime instructions</system-reminder>")).toBeUndefined();
  });

  it("defaults to collapsed report details and preserves the literal source separately", () => {
    const html = renderToStaticMarkup(<SessionNoticeCard notice={parseSessionNotice(report)!} source={report} itemId="notice-1" />);
    expect(html).toContain('class="session-notice"');
    expect(html).toContain('data-stream-key="notice-1"');
    expect(html).not.toContain(" open=");
    expect(html).toContain("原始通知");
    expect(html).toContain("&lt;system-reminder&gt;");
    expect(html).toContain('href="https://github.com/example/project/pull/6"');
    expect(html).not.toMatch(/<button|已接收|回退|全部成功/u);
  });

  it("opens idle events to the original text without treating their internal prose as UI actions", () => {
    const html = renderToStaticMarkup(<SessionNoticeCard notice={parseSessionNotice(idle)!} source={idle} itemId="idle-1" />);
    expect(html).toContain("当前没有运行中的子会话");
    expect(html).toContain("&lt;side-sessions-event&gt;");
    expect(html).not.toContain("<button");
  });
});
