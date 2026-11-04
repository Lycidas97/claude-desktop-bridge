import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { QuotaSnapshot } from "./contract.js";
import { MagpieQuotaBoard, MagpieQuotaDashboard, MagpieQuotaProvider } from "./client.js";

const resetsAt = new Date(Date.now() + 3 * 3_600_000 + 10 * 60_000).toISOString();
const snapshot: QuotaSnapshot = {
  status: "available", fetchedAt: 1_000,
  accounts: [{
    provider: "claude", user: "full.email@example.test", name: "Claude Code", plan: "pro",
    readAt: "2026-10-31T17:00:00Z",
    windows: [{ name: "5 hours", remaining: 75, resetsAt }],
  }],
};

function render(overrides = {}) {
  return renderToStaticMarkup(createElement(MagpieQuotaBoard, {
    snapshot, loading: false, error: undefined, enabled: true, refresh: vi.fn(), ...overrides,
  }));
}

describe("quota UI provided by the plugin", () => {
  it("shows the full email, a bar per share, time to reset and both sampling times", () => {
    const html = render();
    expect(html).toContain("full.email@example.test");
    expect(html).toContain("剩余 75%");
    expect(html).toContain('style="width:75%"');
    expect(html).toContain("5 hours");
    expect(html).toMatch(/3 小时 (9|10) 分钟后重置/u);
    expect(html).toContain(`dateTime="${resetsAt}"`);
    expect(html).toContain("上游采样：");
    expect(html).toContain("dateTime=\"2026-10-31T17:00:00Z\"");
    expect(html).toContain("读取于 ");
    expect(html).toMatch(/<button[^>]*>刷新<\/button>/u);
    expect(html).not.toContain("***");
  });

  it("colors exhausted, low and past-reset windows apart from healthy ones", () => {
    const html = render({ snapshot: { ...snapshot, accounts: [{ provider: "codex", windows: [
      { name: "a", remaining: 0 },
      { name: "b", remaining: 9 },
      { name: "c", remaining: 50 },
      { name: "d", remaining: 50, resetsAt: "2020-01-01T00:00:00Z" },
    ] }] } });
    expect([...html.matchAll(/data-level="(\w+)"/gu)].map((match) => match[1])).toEqual(["empty", "low", "ok", "stale"]);
    expect(html).toContain("已到重置时间，等待 Magpie 更新");
  });

  it("collapses tiers with one reading into a row and keeps wallets without a bar", () => {
    const reset = "2099-01-01T00:00:00Z";
    const html = render({ snapshot: { ...snapshot, accounts: [{ provider: "antigravity", windows: [
      { name: "Claude Opus 5.5 (High)", remaining: 0, resetsAt: reset },
      { name: "Claude Opus 5.5 (Low)", remaining: 0, resetsAt: reset },
      { name: "Gemini · 7 days", pool: "Gemini", remaining: 40, resetsAt: reset },
      { name: "Wallet", balance: 18.2, unit: "CNY", remaining: 100 },
    ] }] } });
    expect(html).toContain("Claude Opus 5.5 · High / Low");
    expect(html.match(/<li/gu)).toHaveLength(3);
    expect(html.match(/magpie-quota-bar/gu)).toHaveLength(2);
    expect(html).toContain("余额 18.2 CNY");
  });

  it("offers provider shortcuts only when there is more than one provider", () => {
    expect(render()).not.toContain("magpie-quota-jump");
    const html = render({ snapshot: { ...snapshot, accounts: [
      ...snapshot.accounts, { provider: "deepseek", balance: "¥46.15", windows: [] },
    ] } });
    expect(html).toContain('aria-label="跳到渠道"');
    expect(html).toContain('id="magpie-quota-provider-1"');
    expect(html).toContain("2 个账号");
  });

  it("says what is happening before the first reading", () => {
    expect(render({ snapshot: undefined, loading: true })).toContain("正在读取额度…");
    expect(render({ snapshot: undefined, enabled: false })).toContain("电脑连接后读取额度");
    const failed = render({ snapshot: undefined, error: "无法连接 Magpie 网关" });
    expect(failed).toContain("尚未读取");
    expect(failed).toContain('role="alert">无法连接 Magpie 网关<');
  });

  it("explains gateways without quota support and still allows a retry", () => {
    const html = render({ snapshot: { ...snapshot, status: "unsupported", accounts: [] } });
    expect(html).toContain("Magpie 没有提供额度接口");
    expect(html).toMatch(/<button type="button">刷新<\/button>/u);
  });

  it("marks old data clearly after a refresh failure", () => {
    const html = render({ error: "连接失败" });
    expect(html).toContain('role="alert"');
    expect(html).toContain("连接失败；以下为上次读取结果");
    expect(html).toContain("full.email@example.test");
  });

  it("escapes account data and renders unknown values without a false percentage", () => {
    const html = render({ snapshot: { ...snapshot, accounts: [{
      provider: "test", user: "<script>alert(1)</script>", windows: [{ name: "Unknown window" }],
    }] } });
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("余量未知");
    expect(html).not.toContain("100%");
  });

  it("requests nothing while rendering, before a mounted consumer's effect asks for data", () => {
    const loader = vi.fn(async () => snapshot);
    for (const enabled of [true, false]) {
      renderToStaticMarkup(createElement(MagpieQuotaProvider, { loader, enabled, children: createElement(MagpieQuotaDashboard) }));
    }
    expect(loader).not.toHaveBeenCalled();
  });

  it("keeps the last data offline but cannot refresh it", () => {
    const html = render({ enabled: false });
    expect(html).toContain("full.email@example.test");
    expect(html).toContain("电脑未连接，以下为上次读取结果");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>刷新<\/button>/u);
  });

  it("marks readings Magpie kept instead of reading now, with their time", () => {
    const html = render({ snapshot: { ...snapshot, accounts: [
      { ...snapshot.accounts[0]!, asOf: "2026-11-01T04:00:00Z", readDeferred: true },
      { provider: "codex", user: "failed.read@example.test", asOf: "2026-11-01T03:00:00Z", windows: [{ name: "7 days", remaining: 10 }] },
    ] } });
    expect(html).toMatch(/Magpie 本次未重新读取，显示 \d+月\d+日 \d\d:00 保留的读数/u);
    expect(html).toMatch(/本次读取失败，显示 \d+月\d+日 \d\d:00 保留的读数/u);
    expect(html).toContain("2 个账号 · 2 个为保留读数");
  });

  it("puts status and notes ahead of the accounts", () => {
    const html = render({ error: "连接失败" });
    expect(html.indexOf('class="magpie-quota-status"')).toBeLessThan(html.indexOf('role="alert"'));
    expect(html.indexOf('role="alert"')).toBeLessThan(html.indexOf('class="magpie-quota-accounts"'));
  });
});
