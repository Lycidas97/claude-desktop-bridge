import type { BridgeHistoryItem, BridgeMailCard } from "@bridge/protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MailCard } from "./MailCard.js";

function card(fields: Partial<BridgeMailCard> = {}): BridgeMailCard {
  return {
    seq: 1, mailRefId: "mail-1", accountKey: "account", mailbox: "INBOX",
    subject: "Mail subject", from: [{ address: "sender@example.invalid" }],
    receivedAt: "2026-11-14T00:00:00.000Z", recordedAt: 1, preview: "Mail preview",
    processingStatus: "pending", nativeDelivery: { state: "not-submitted" }, ...fields,
  };
}

describe("MailCard plain text rendering", () => {
  it("shows the subject, sender and received time without opening a compact inbox row", () => {
    const receivedAt = "2026-11-13T02:14:00.000Z";
    const html = renderToStaticMarkup(createElement(MailCard, { card: card({
      receivedAt, recordedAt: Date.parse("2026-11-14T10:45:00.000Z"), previewError: "Preview error",
    }), compact: true }));

    expect(html).toMatch(/<summary>.*Mail subject.*sender@example\.invalid.*<\/summary>/u);
    expect(html).toContain(`<time dateTime="${receivedAt}">${new Date(receivedAt).toLocaleString("zh-CN", {
      month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
    })}</time>`);
    expect(html).not.toMatch(/Mail preview|Preview error|状态|原文/u);
  });

  it("keeps a failed assistant task visible on a collapsed inbox row", () => {
    const html = renderToStaticMarkup(createElement(MailCard, { compact: true, card: card({
      processingStatus: "processing", nativeDelivery: { state: "failed", batchId: "batch-1" },
    }) }));

    expect(html).toMatch(/<summary>.*data-tone="failed">助理任务失败<.*<\/summary>/u);
    expect(html).not.toContain("处理中");
  });

  it("shows the received time when catch-up records a mail much later", () => {
    const receivedAt = "2026-11-13T02:14:00.000Z";
    const html = renderToStaticMarkup(createElement(MailCard, { card: card({
      receivedAt, recordedAt: Date.parse("2026-11-14T10:45:00.000Z"),
    }) }));

    expect(html).toContain('data-stream-key="mail:mail-1"');
    expect(html).toContain(`<time dateTime="${receivedAt}">${new Date(receivedAt).toLocaleString("zh-CN", {
      month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
    })}</time>`);
  });

  it("escapes subject, sender, and preview instead of rendering HTML, Markdown, or remote resources", () => {
    const html = renderToStaticMarkup(createElement(MailCard, { card: card({
      subject: '<script>alert("subject")</script>',
      from: [{ name: '<img src="https://mail.example.invalid/pixel">', address: "sender<address>@example.invalid" }],
      preview: '<iframe src="https://mail.example.invalid/frame"></iframe> **bold** [remote](https://mail.example.invalid)',
    }) }));

    expect(html).toContain('<h3>&lt;script&gt;alert(&quot;subject&quot;)&lt;/script&gt;</h3>');
    expect(html).toContain('&lt;img src=&quot;https://mail.example.invalid/pixel&quot;&gt; sender&lt;address&gt;@example.invalid');
    expect(html).toContain('&lt;iframe src=&quot;https://mail.example.invalid/frame&quot;&gt;&lt;/iframe&gt; **bold** [remote](https://mail.example.invalid)');
    expect(html).not.toMatch(/<(?:script|img|iframe|a|strong)\b/u);
    expect(html).toContain("连接电脑后可查看原文");
  });

  it("escapes analysis summary, suggestions, and questions as plain text", () => {
    const html = renderToStaticMarkup(createElement(MailCard, { card: card({
      processingStatus: "processed",
      analysis: {
        summary: '<style>body{background:url("https://mail.example.invalid/bg")}</style>',
        suggestions: ['<object data="https://mail.example.invalid/file"></object>', "[reply](https://mail.example.invalid/reply)"],
        questions: ['<video src="https://mail.example.invalid/movie"></video>'],
      },
    }) }));

    expect(html).toContain('&lt;style&gt;body{background:url(&quot;https://mail.example.invalid/bg&quot;)}&lt;/style&gt;');
    expect(html).toContain('&lt;object data=&quot;https://mail.example.invalid/file&quot;&gt;&lt;/object&gt;');
    expect(html).toContain("[reply](https://mail.example.invalid/reply)");
    expect(html).toContain('&lt;video src=&quot;https://mail.example.invalid/movie&quot;&gt;&lt;/video&gt;');
    expect(html).not.toMatch(/<(?:style|object|video|a|img|iframe|script)\b/u);
    expect(html).toContain("<h4>建议</h4><ul><li>&lt;object");
    expect(html).toContain("<h4>问题</h4><ul><li>&lt;video");
  });

  it("shows complete status in its own disclosure, not in the preview or original", () => {
    const html = renderToStaticMarkup(createElement(MailCard, { card: card({ processingStatus: "processed" }) }));
    const [collapsed, status] = html.split("<summary>状态</summary>");

    expect(collapsed).not.toMatch(/已处理|未自动发给助理/u);
    expect(status?.split("</details>")[0]).toContain("已处理");
    expect(status?.split("</details>")[0]).toContain("未自动发给助理");
    expect(html.split("<summary>原文</summary>")[1]).not.toMatch(/已处理|未自动发给助理/u);
    expect(html).not.toMatch(/已记录|原生投递|业务处理|未提交/u);
  });

  it.each<[BridgeMailCard["nativeDelivery"]["state"], string | undefined]>([
    ["not-submitted", undefined], ["pending", "等待助理"], ["paused", undefined],
    ["submitting", "等待助理"], ["submitted", "等待助理"], ["queued", "等待助理"],
    ["observed", undefined], ["uncertain", undefined], ["failed", "助理任务失败"], ["cancelled", undefined],
  ])("shows only the relevant collapsed hint for delivery state %s", (state, hint) => {
    const html = renderToStaticMarkup(createElement(MailCard, { card: card({ nativeDelivery: { state } }) }));
    const [collapsed] = html.split("<summary>状态</summary>");

    expect(collapsed?.match(/等待助理|处理中|助理任务失败/gu) ?? []).toEqual(hint ? [hint] : []);
  });

  it("leaves shared delivery information to the batch header but keeps each mail's processing status", () => {
    const html = renderToStaticMarkup(createElement(MailCard, {
      card: card({ nativeDelivery: { state: "queued", batchId: "batch-1" } }), showBatchDelivery: false,
    }));

    expect(html).toContain("待处理");
    expect(html).not.toMatch(/自动发送|等待助理|已排队等助理/u);
  });

  it("shows active processing once even when delivery also has a hint", () => {
    const html = renderToStaticMarkup(createElement(MailCard, { card: card({
      processingStatus: "processing", nativeDelivery: { state: "queued" },
    }) }));
    const [collapsed] = html.split("<summary>状态</summary>");

    expect(collapsed?.match(/等待助理|处理中|助理任务失败/gu)).toEqual(["处理中"]);
  });

  it("shows a failed automatic task ahead of stale processing without claiming it was never sent", () => {
    const html = renderToStaticMarkup(createElement(MailCard, { card: card({
      processingStatus: "processing", nativeDelivery: { state: "failed", batchId: "batch-1", messageId: "native-message" },
    }) }));

    expect(html).toContain("助理任务失败");
    expect(html).not.toContain("没能发给助理");
    expect(html).not.toMatch(/assistant-mail-hint[^>]*>处理中/u);
  });

  it("does not describe a cancelled task as an unsent mail", () => {
    const html = renderToStaticMarkup(createElement(MailCard, { card: card({
      nativeDelivery: { state: "cancelled", batchId: "batch-1", messageId: "native-message" },
    }) }));

    expect(html).toContain("任务已取消");
    expect(html).not.toContain("已撤回自动发送");
  });

  it("keeps the correlated native message ID and text escaped in its own disclosure", () => {
    const nativeMessage: BridgeHistoryItem = {
      id: "native<message>", sessionId: "native-session", role: "user", createdAt: 1, origin: "claude-desktop",
      text: '<img src="https://mail.example.invalid/native-pixel" onerror="alert(1)"> **native**',
    };
    const html = renderToStaticMarkup(createElement(MailCard, { card: card(), nativeMessage }));

    expect(html).toContain('<details class="assistant-mail-native"><summary>关联原生消息</summary>');
    expect(html).toContain("<code>native&lt;message&gt;</code>");
    expect(html).toContain('&lt;img src=&quot;https://mail.example.invalid/native-pixel&quot; onerror=&quot;alert(1)&quot;&gt; **native**');
    expect(html).not.toMatch(/<(?:img|a|strong|script|iframe)\b/u);
  });
});
