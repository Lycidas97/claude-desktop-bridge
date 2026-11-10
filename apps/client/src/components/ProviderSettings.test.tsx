import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { BridgeHostSnapshot } from "@bridge/protocol";
import { describe, expect, it, vi } from "vitest";
import { ProviderSettings } from "./ProviderSettings.js";

const snapshot = {
  host: { hostId: "fixture-host", name: "Studio Mac", capabilities: [] },
  runtime: { state: "ready", detail: "CLI ready", version: "2.1.309", detection: {
    cliPath: "/fixture/bin/claude",
    configSource: { type: "fixed-gateway", profile: "claude-3p", path: "/fixture/configLibrary/active.json" },
    gatewayState: "configured",
    modelDiscovery: { state: "error", count: 0, refreshedAt: 1000, error: "模型接口读取失败" },
    refreshedAt: 1000,
  } },
  providers: [
    { id: "third-party", kind: "claude-3p", name: "Claude-3p", status: "ready", configured: true, models: [] },
    { id: "api", kind: "anthropic-api", name: "Anthropic API", status: "needs-configuration", configured: false, models: [] },
  ],
  sessions: [], projects: [],
} as unknown as BridgeHostSnapshot;

function html(desktopLocal = false, connected = true) {
  return renderToStaticMarkup(createElement(ProviderSettings, {
    snapshot, desktopLocal, connected, onRefresh: vi.fn(),
    ...(desktopLocal ? { onSetApiKey: vi.fn(), onRemoveApiKey: vi.fn() } : {}),
  }));
}

describe("provider settings independent of sessions", () => {
  it("hides retired Claude Host lanes and independent Anthropic Key management", () => {
    for (const desktopLocal of [true, false]) {
      const markup = html(desktopLocal);
      expect(markup).not.toContain("Anthropic API");
      expect(markup).not.toContain("Claude-3p");
      expect(markup).not.toContain('type="password"');
      expect(markup).not.toContain("验证并保存");
    }
  });
  it("keeps quota discovery independent of retired provider profiles", () => {
    const markup = renderToStaticMarkup(createElement(ProviderSettings, {
      snapshot: { ...snapshot, providers: [], host: { ...snapshot.host, capabilities: ["plugin.magpie-quota.v1"] } }, onRefresh: vi.fn(),
    }));
    expect(markup).toContain("Magpie 额度");
  });
  it("disables refresh while the paired computer is offline", () => {
    expect(html(false, false)).toMatch(/disabled=""[^>]*>.*重新检测/s);
  });
  it("shows only saved Magpie connection facts on mobile", () => {
    const markup = renderToStaticMarkup(createElement(ProviderSettings, {
      snapshot: { ...snapshot, magpie: { mode: "manual", baseUrl: "https://magpie.example.com", authScheme: "x-api-key", keyConfigured: true } },
      onRefresh: vi.fn(), onTestMagpieConnection: vi.fn(), onSaveMagpieConnection: vi.fn(),
    }));
    expect(markup).toContain("手动配置 Magpie");
    expect(markup).toContain("https://magpie.example.com");
    expect(markup).toContain("x-api-key");
    expect(markup).toContain("已配置");
    expect(markup).toContain("请在这台电脑的 Bridge 设置中管理 Magpie 连接");
    expect(markup).not.toContain('type="password"');
    expect(markup).not.toContain("测试连接");
  });
  it("requires the new snapshot field and both local methods before offering Magpie editing", () => {
    const magpie = { mode: "auto", keyConfigured: false } as const;
    for (const props of [
      { snapshot, onTestMagpieConnection: vi.fn(), onSaveMagpieConnection: vi.fn() },
      { snapshot: { ...snapshot, magpie }, onTestMagpieConnection: vi.fn() },
      { snapshot: { ...snapshot, magpie }, onSaveMagpieConnection: vi.fn() },
    ]) {
      const markup = renderToStaticMarkup(createElement(ProviderSettings, { ...props, desktopLocal: true, onRefresh: vi.fn() }));
      expect(markup).not.toContain('id="magpie-mode"');
      expect(markup).not.toContain("保存 Magpie 配置");
    }
  });
});
