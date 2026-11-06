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
  it("separates local readiness from failed model discovery and shows actual configuration source", () => {
    const markup = html();
    expect(markup).toContain("Claude-3p");
    expect(markup).toContain("模型接口读取失败");
    expect(markup).toContain("固定网关配置");
    expect(markup).toContain("/fixture/configLibrary/active.json");
    expect(markup).not.toContain("0 个可用模型");
  });
  it("offers Key management only in the local desktop settings even without any session", () => {
    expect(html(true)).toContain('type="password"');
    expect(html()).not.toContain('type="password"');
    expect(html()).toContain("请在电脑端 Bridge 设置");
  });
  it("keeps the last detection time and disables refresh while the computer is offline", () => {
    const markup = html(false, false);
    expect(markup).toContain("电脑未连接");
    expect(markup).toContain("最近检测");
    expect(markup).toMatch(/disabled=""[^>]*>.*重新检测/s);
  });
});
