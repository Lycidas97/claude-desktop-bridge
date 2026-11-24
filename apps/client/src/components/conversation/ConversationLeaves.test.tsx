import type { BridgeSessionInfo } from "@bridge/protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ConversationMessageItem } from "./ConversationMessageItem.js";
import { ConversationToolGroup } from "./ConversationToolGroup.js";
import { ForkChainBar } from "./ForkChainBar.js";

const baseSession: BridgeSessionInfo = {
  sessionId: "session-1",
  projectId: "project-1",
  projectName: "Project",
  cwd: "/tmp/project",
  title: "Primary session",
  source: "desktop",
  ownership: "DESKTOP_NATIVE_IDLE",
  transport: "claude-desktop-native",
  turnState: "idle",
  lastActivityAt: 1,
  pendingCount: 0,
  allowedActions: {
    canSend: true,
    canSteer: true,
    canInterrupt: true,
    canConfigure: true,
    canSwitchProvider: false,
    canContinueOfficial: false,
  },
};

describe("shared hookless conversation leaf components", () => {
  it("renders ConversationToolGroup with stream anchor key and single or grouped summaries", () => {
    const singleHtml = renderToStaticMarkup(createElement(ConversationToolGroup, {
      sessionId: "session-1",
      supportsToolDetail: true,
      tools: [{
        id: "tool-1",
        sessionId: "session-1",
        role: "tool",
        toolName: "Bash",
        text: "npm test",
        createdAt: 1,
        origin: "claude-desktop",
      }],
    }));
    expect(singleHtml).toContain('data-stream-key="tool-group:tool-1"');
    expect(singleHtml).toContain("Bash · npm test");
    expect(singleHtml).not.toContain("is-running");

    const multiRunningHtml = renderToStaticMarkup(createElement(ConversationToolGroup, {
      sessionId: "session-1",
      supportsToolDetail: false,
      tools: [
        { id: "tool-1", sessionId: "session-1", role: "tool", toolName: "Read", text: "a.ts", createdAt: 1, origin: "claude-desktop" },
        { id: "tool-2", sessionId: "session-1", role: "tool", toolName: "Edit", text: "b.ts", state: "running", createdAt: 2, origin: "claude-desktop" },
      ],
    }));
    expect(multiRunningHtml).toContain('data-stream-key="tool-group:tool-2"');
    expect(multiRunningHtml).toContain("is-running");
    expect(multiRunningHtml).toContain("正在执行 2 个工具 (Read、Edit)");
  });

  it("renders ForkChainBar only when parentSession exists with semantic icon and optional close button", () => {
    expect(renderToStaticMarkup(createElement(ForkChainBar, {
      onSelectSession: vi.fn(),
    }))).toBe("");

    const sidechatHtml = renderToStaticMarkup(createElement(ForkChainBar, {
      parentSession: baseSession,
      isSidechat: true,
      onSelectSession: vi.fn(),
    }));
    expect(sidechatHtml).toContain("主会话：Primary session");
    expect(sidechatHtml).toContain("lucide-corner-up-left");
    expect(sidechatHtml).not.toContain('aria-label="收起分支"');

    const forkWithCloseHtml = renderToStaticMarkup(createElement(ForkChainBar, {
      parentSession: baseSession,
      onSelectSession: vi.fn(),
      onClose: vi.fn(),
    }));
    expect(forkWithCloseHtml).toContain("主会话：Primary session");
    expect(forkWithCloseHtml).toContain("lucide-git-fork");
    expect(forkWithCloseHtml).toContain('aria-label="收起分支"');
    expect(forkWithCloseHtml).toContain("relay-chain-dismiss");
  });

  it("keeps ordinary assistant output continuous but timestamps a reply on its existing Assistant chat row", () => {
    const createdAt = +new Date(2025, 1, 3, 23, 58);
    const item = { id: "reply", sessionId: baseSession.sessionId, role: "assistant", text: "完整的助理回复。",
      createdAt, origin: "claude-desktop" } as const;
    const ordinary = renderToStaticMarkup(createElement(ConversationMessageItem, { session: baseSession, item }));
    expect(ordinary).not.toContain("<time");
    expect(ordinary).not.toContain("assistant-reply");
    const assistant = renderToStaticMarkup(createElement(ConversationMessageItem, { session: baseSession, item, replyTimestamp: createdAt }));
    expect(assistant).toContain('data-stream-key="reply"');
    expect(assistant).toContain(`<time dateTime="${new Date(createdAt).toISOString()}">2025/2/3 23:58</time>`);
    expect(assistant).toContain(item.text);
  });

  it("renders ConversationMessageItem user bubble, stream key, and uncertain delivery actions", () => {
    const html = renderToStaticMarkup(createElement(ConversationMessageItem, {
      session: baseSession,
      item: {
        id: "msg-user-1",
        sessionId: "session-1",
        role: "user",
        text: "Check status",
        createdAt: 1,
        origin: "mobile",
        delivery: "uncertain",
        commandId: "cmd-1",
      },
      onResolveUncertain: vi.fn(),
    }));
    expect(html).toContain('data-stream-key="msg-user-1"');
    expect(html).toContain('class="conversation-bubble"');
    expect(html).toContain("发送结果待确认");
    expect(html).toContain("确认已发送");
    expect(html).toContain("检查后重发");
  });
});
