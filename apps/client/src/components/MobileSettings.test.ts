import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MobileSettings } from "./MobileSettings.js";

function render(quota?: { desktopName: string; onOpen(): void }) {
  return renderToStaticMarkup(createElement(MobileSettings, {
    themeControl: { theme: "light", family: "sunstone", setTheme: vi.fn(), setFamily: vi.fn(), toggleTheme: vi.fn() },
    agentVisibility: { enabled: ["claude-desktop"], setEnabled: vi.fn() },
    ...(quota ? { quota } : {}),
  }));
}

describe("Magpie quota entry in settings", () => {
  it("leads settings with the dashboard entry for a computer that declares the plugin", () => {
    const html = render({ desktopName: "Studio Mac", onOpen: vi.fn() });
    expect(html).toContain("Magpie 额度");
    expect(html).toContain("Studio Mac · 各账号剩余额度与重置时间");
    expect(html.indexOf("Magpie 额度")).toBeLessThan(html.indexOf("外观"));
  });

  it("is absent otherwise", () => {
    expect(render()).not.toContain("Magpie 额度");
  });
});
