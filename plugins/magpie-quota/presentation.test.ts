import { describe, expect, it } from "vitest";
import type { QuotaAccount, QuotaSnapshot } from "./contract.js";
import { formatQuotaTime, formatQuotaWindow, formatReset, modelQuotaLabel, quotaRows, quotasForModel } from "./presentation.js";

function snapshot(accounts: QuotaAccount[]): QuotaSnapshot {
  return { status: "available", fetchedAt: 1_000, accounts };
}

describe("model quota presentation", () => {
  it("takes the limiting window per account rather than adding account percentages", () => {
    const quota = snapshot([
      { provider: "claude", windows: [{ name: "5 hours", remaining: 90 }, { name: "7 days", remaining: 12 }] },
      { provider: "claude", windows: [{ name: "5 hours", remaining: 53 }, { name: "7 days", remaining: 93 }] },
      { provider: "claude", windows: [{ name: "5 hours", remaining: 0 }] },
    ]);
    expect(modelQuotaLabel(quota, { value: "claude/claude-opus-5-5" })).toBe("单账号最高可用 53%");
  });

  it("matches nested remote providers before their parent and supports resolved IDs", () => {
    const quota = snapshot([
      { provider: "remote-magpie", windows: [{ name: "5 hours", remaining: 1 }] },
      { provider: "remote-magpie/minimax-cn", windows: [{ name: "5 hours", remaining: 80 }] },
      { provider: "remote-magpie/~keys", windows: [{ name: "Spend", remaining: 10 }] },
    ]);
    expect(modelQuotaLabel(quota, { value: "synthetic-model", resolvedModel: "remote-magpie/minimax-cn/MiniMax-M3.1-Flash[1m]" })).toBe("单账号最高可用 80%");
  });

  it("keeps Gemini windows separate from Claude/GPT pools", () => {
    const quota = snapshot([{ provider: "antigravity", windows: [
      { name: "Gemini · 7 days", pool: "Gemini", remaining: 90 },
      { name: "Gemini · 5 hours", pool: "Gemini", remaining: 80 },
      { name: "Claude & GPT · 7 days", pool: "Claude & GPT", remaining: 0 },
      { name: "Claude Opus 5.5 (High)", remaining: 0 },
    ] }]);
    expect(modelQuotaLabel(quota, { value: "antigravity/gemini-4-argon" })).toBe("单账号最高可用 80%");
    expect(modelQuotaLabel(quota, { value: "antigravity/claude-opus-5-5" })).toBe("单账号最高可用 0%");
    expect(quotasForModel(quota, { value: "antigravity/gpt-6" }).accounts[0]?.windows).toEqual([
      { name: "Claude & GPT · 7 days", pool: "Claude & GPT", remaining: 0 },
    ]);
  });

  it("counts a model's own window, never another model's window in the same pool", () => {
    const quota = snapshot([{ provider: "antigravity", windows: [
      { name: "Gemini 4 Argon (High)", remaining: 0 },
      { name: "Gemini 3.8 Flash (High)", remaining: 80 },
      { name: "Gemini 3.8 Flash (Low)", remaining: 85 },
      { name: "Gemini · 7 days", pool: "Gemini", remaining: 90 },
    ] }]);
    expect(modelQuotaLabel(quota, { value: "antigravity/gemini-3.8-flash[1m]" })).toBe("单账号最高可用 80%");
    expect(modelQuotaLabel(quota, { value: "antigravity/gemini-4-argon" })).toBe("单账号最高可用 0%");
    // A model without its own window is limited by the pool alone.
    expect(modelQuotaLabel(quota, { value: "antigravity/gemini-5-pro" })).toBe("单账号最高可用 90%");
    expect(quotasForModel(quota, { value: "antigravity/gemini-4" }).accounts[0]?.windows.map((w) => w.name))
      .toEqual(["Gemini · 7 days"]);
  });

  it("shows a wallet balance window as its figure, never as a full share", () => {
    const wallet = { name: "Points", used: 0, remaining: 100, balance: 1234.5, unit: "points" };
    expect(formatQuotaWindow(wallet)).toBe("余额 1234.5 points");
    expect(modelQuotaLabel(snapshot([{ provider: "supermagic", windows: [wallet] }]), { value: "supermagic/model" }))
      .toBe("余额 1234.5 points");
    // Informational rows do not hide the account's real share windows.
    expect(modelQuotaLabel(snapshot([{ provider: "supermagic", windows: [
      wallet, { name: "签到", text: true, display: "已签到" }, { name: "5 hours", remaining: 60 },
    ] }]), { value: "supermagic/model" })).toBe("单账号最高可用 60%");
  });

  it("clamps out-of-range readings", () => {
    expect(formatQuotaWindow({ name: "w", remaining: 140 })).toBe("剩余 100%");
    expect(formatQuotaWindow({ name: "w", remaining: -3 })).toBe("剩余 0%");
    expect(formatQuotaWindow({ name: "w", used: 130 })).toBe("剩余 0%");
  });

  it("does not attribute an auto route to a single provider", () => {
    expect(modelQuotaLabel(snapshot([]), { value: "auto/claude-opus-5-5" })).toBe("自动路由 · 查看各渠道额度");
  });

  it("does not guess an unknown or synthetic model's provider", () => {
    const quota = snapshot([{ provider: "claude", windows: [{ name: "5 hours", remaining: 80 }] }]);
    expect(modelQuotaLabel(quota, { value: "mythos-magpie-1234567890[1m]" })).toBeUndefined();
    expect(modelQuotaLabel(quota, { value: "other/model" })).toBeUndefined();
    expect(modelQuotaLabel({ ...quota, status: "unsupported" }, { value: "claude/model" })).toBeUndefined();
  });

  it("does not reinterpret an expired window as full capacity", () => {
    const quota = snapshot([{ provider: "claude", windows: [
      { name: "5 hours", remaining: 0, resetsAt: "2026-10-31T10:00:00Z" },
      { name: "7 days", remaining: 90 },
    ] }]);
    expect(modelQuotaLabel(quota, { value: "claude/model" }, Date.parse("2026-10-31T11:00:00Z"))).toBe("额度待更新");
  });

  it("does not use failed accounts or unknown windows as available quota", () => {
    const quota = snapshot([
      { provider: "claude", error: "auth required", windows: [{ name: "5 hours", remaining: 100 }] },
      { provider: "claude", windows: [{ name: "5 hours", remaining: 20 }, { name: "7 days" }] },
    ]);
    expect(modelQuotaLabel(quota, { value: "claude/model" })).toBe("额度待更新");
  });

  it("shows literal balances, textual and unlimited windows", () => {
    expect(modelQuotaLabel(snapshot([{ provider: "deepseek", balance: "CNY 18.20", windows: [] }]), { value: "deepseek/deepseek-flash" })).toBe("余额 CNY 18.20");
    expect(formatQuotaWindow({ name: "calls", text: true, display: "120 requests" })).toBe("120 requests");
    expect(formatQuotaWindow({ name: "calls", unlimited: true })).toBe("无限制");
    expect(formatQuotaWindow({ name: "5 hours", used: 25.25 })).toBe("剩余 74.8%");
    expect(formatQuotaWindow({ name: "unknown" })).toBe("余量未知");
  });

  it("collapses tiers only when their reading and reset match", () => {
    const reset = "2026-11-02T00:00:00Z";
    const rows = quotaRows([
      { name: "Claude Opus 5.5 (High)", remaining: 0, resetsAt: reset },
      { name: "Claude Opus 5.5 (Low)", remaining: 0, resetsAt: reset },
      { name: "Gemini 3.8 Flash (High)", remaining: 0, resetsAt: reset },
      { name: "Gemini 3.8 Flash (Low)", remaining: 40, resetsAt: reset },
      { name: "Gemini 4 Argon (High)", remaining: 0, resetsAt: reset },
      { name: "Gemini 4 Argon (Low)", remaining: 0, resetsAt: "2026-11-03T00:00:00Z" },
      { name: "5 hours", remaining: 100 },
      { name: "5 hours", remaining: 100 },
    ]);
    expect(rows.map((row) => [row.label, row.variants])).toEqual([
      ["Claude Opus 5.5", ["High", "Low"]],
      ["Gemini 3.8 Flash", ["High"]],
      ["Gemini 3.8 Flash", ["Low"]],
      ["Gemini 4 Argon", ["High"]],
      ["Gemini 4 Argon", ["Low"]],
      ["5 hours", []],
      ["5 hours", []],
    ]);
  });

  it("counts down to a reset in days, hours or minutes", () => {
    const now = Date.parse("2026-11-01T00:00:00Z");
    expect(formatReset("2026-11-01T00:00:30Z", now)).toBe("1 分钟后重置");
    expect(formatReset("2026-11-01T00:45:00Z", now)).toBe("45 分钟后重置");
    expect(formatReset("2026-11-01T03:10:00Z", now)).toBe("3 小时 10 分钟后重置");
    expect(formatReset("2026-11-06T09:42:00Z", now)).toBe("5 天 9 小时后重置");
    expect(formatReset("2026-11-01T03:00:00Z", now)).toBe("3 小时后重置");
    expect(formatReset("2026-11-03T00:20:00Z", now)).toBe("2 天后重置");
    expect(formatReset("2026-11-01T00:00:00Z", now)).toBe("已到重置时间，等待 Magpie 更新");
  });

  it("writes times the way the phone's Chinese UI does", () => {
    expect(formatQuotaTime("2026-11-01T04:05:00Z")).toMatch(/^\d+月\d+日 \d\d:05$/u);
  });
});
