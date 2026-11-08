import type { BridgeSessionInfo } from "@bridge/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DesktopHandoffNotice } from "./DesktopHandoffNotice.js";

const session: BridgeSessionInfo = {
  sessionId: "expired-desktop", title: "Desktop session", projectId: "project", projectName: "Project", cwd: "/tmp/project",
  source: "desktop", ownership: "DESKTOP_MANAGED_IDLE", transport: "claude-desktop-managed", turnState: "idle", lastActivityAt: 1, pendingCount: 1,
};

describe("requested Bridge execution", () => {
  it("shows a failed handoff and offers an explicit retry for the same queued command", () => {
    const html = renderToStaticMarkup(<DesktopHandoffNotice
      session={{ ...session, pendingCommandIds: ["original-command"], desktopHandoff: {
        state: "close-desktop", reason: "bridge-execution-requested", canReturn: false, error: "目标 Desktop 执行器尚未退出",
      } }} online className="desktop-channel-banner" onTakeover={vi.fn()}
    />);
    expect(html).toContain("目标 Desktop 执行器尚未退出");
    expect(html).not.toContain("当前工作结束后自动继续");
    expect(html).toMatch(/<button\b[^>]*>重试交接<\/button>/);
  });

  it("shows the confirmed wait without offering another takeover", () => {
    const html = renderToStaticMarkup(<DesktopHandoffNotice
      session={{ ...session, desktopHandoff: { state: "close-desktop", reason: "bridge-execution-requested", canReturn: false } }}
      online className="desktop-channel-banner" onTakeover={vi.fn()}
    />);
    expect(html).toContain("等待交接给 Bridge");
    expect(html).toContain("无需到电脑允许接收");
    expect(html).not.toContain("等待关闭");
    expect(html).not.toContain(">接管此会话</button>");
  });
});

describe("expired Desktop inbox confirmation", () => {
  it.each([0, 1])("explains that takeover is unavailable with %i queued messages without guessing why", pendingCount => {
    const onTakeover = vi.fn(async () => {});
    const html = renderToStaticMarkup(<DesktopHandoffNotice
      session={{ ...session, pendingCount, desktopHandoff: { state: "close-desktop", reason: "inbox-confirmation-expired", canReturn: false, canTakeover: false } }}
      online className="desktop-channel-banner" onTakeover={onTakeover}
    />);

    expect(html).toContain("消息仍保留在电脑队列中，不会再次投递到同一收件箱。");
    expect(html).toContain("当前不可接管此会话。");
    expect(html).not.toContain("可确认接管此会话");
    expect(html).not.toMatch(/主任务|后台任务|子代理/);
    expect(html).toMatch(/<button\b[^>]*\bdisabled=""[^>]*>接管此会话<\/button>/);
    expect(html).not.toContain('role="alertdialog"');
    expect(onTakeover).not.toHaveBeenCalled();
  });

  it.each([0, 1])("keeps explicit takeover guidance when takeover is available with %i queued messages", pendingCount => {
    const onTakeover = vi.fn(async () => {});
    const html = renderToStaticMarkup(<DesktopHandoffNotice
      session={{ ...session, pendingCount, desktopHandoff: { state: "close-desktop", reason: "inbox-confirmation-expired", canReturn: false, canTakeover: true } }}
      online className="desktop-channel-banner" onTakeover={onTakeover}
    />);

    expect(html).toContain("消息仍保留在电脑队列中，不会再次投递到同一收件箱。可确认接管此会话，由 Bridge 继续处理；仅等待空闲不会交接。");
    expect(html).not.toContain("当前不可接管此会话");
    expect(html.match(/<button\b[^>]*>接管此会话<\/button>/)?.[0]).not.toContain("disabled");
    expect(html).not.toContain('role="alertdialog"');
    expect(onTakeover).not.toHaveBeenCalled();
  });

  it.each([false, true])("keeps the last synced state unconfirmed while offline when canTakeover is %s", canTakeover => {
    const onTakeover = vi.fn(async () => {});
    const html = renderToStaticMarkup(<DesktopHandoffNotice
      session={{ ...session, pendingCount: 2, desktopHandoff: { state: "close-desktop", reason: "inbox-confirmation-expired", canReturn: false, canTakeover } }}
      online={false} className="desktop-channel-banner" onTakeover={onTakeover}
    />);

    expect(html).toContain("连接已断开，等待同步状态");
    expect(html).toContain("上次同步时有 2 条消息排队，当前进度尚未确认。");
    expect(html).not.toContain("可确认接管此会话");
    expect(html).not.toContain("当前不可接管此会话");
    expect(html).toMatch(/<button\b[^>]*\bdisabled=""[^>]*>接管此会话<\/button>/);
    expect(html).not.toContain('role="alertdialog"');
    expect(onTakeover).not.toHaveBeenCalled();
  });
});
