import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AppearanceSettings, MobileSettings } from "./MobileSettings.js";
import type { FontSize } from "../../hooks/useTheme.js";

describe("shared appearance font size control", () => {
  it.each(["small", "standard", "large", "larger"] as const)("selects only %s and exposes every preset", fontSize => {
    const html = renderToStaticMarkup(createElement(AppearanceSettings, {
      themeControl: { theme: "dark", family: "apple", fontSize, setFontSize: vi.fn(), setTheme: vi.fn(), setFamily: vi.fn(), toggleTheme: vi.fn() },
    }));
    const group = html.slice(html.indexOf('aria-label="字号"'));
    expect(group.match(/aria-pressed="true"/g)).toHaveLength(1);
    for (const label of ["小", "标准", "大", "更大"]) expect(group).toContain(`>${label}</button>`);
    expect(group).toContain(`aria-pressed="true">${({ small: "小", standard: "标准", large: "大", larger: "更大" })[fontSize]}</button>`);
  });

  it("wires every button to the shared appearance setter", () => {
    const setFontSize = vi.fn<(size: FontSize) => void>();
    const tree = AppearanceSettings({ themeControl: { theme: "dark", family: "sunstone", fontSize: "standard", setFontSize, setTheme: vi.fn(), setFamily: vi.fn(), toggleTheme: vi.fn() } });
    const row = tree.props.children.find((child: any) => child.props.className?.includes("font-size-settings-row"));
    for (const button of row.props.children[1].props.children) button.props.onClick();
    expect(setFontSize.mock.calls).toEqual([["small"], ["standard"], ["large"], ["larger"]]);
  });
});

function render(quota?: { desktopName: string; onOpen(): void }) {
  return renderToStaticMarkup(createElement(MobileSettings, {
    themeControl: { theme: "light", family: "sunstone", setTheme: vi.fn(), setFamily: vi.fn(), toggleTheme: vi.fn() },
    ...(quota ? { quota } : {}),
  }));
}

describe("Magpie quota entry in settings", () => {
  it("leads settings with the dashboard entry for a computer that declares the plugin", () => {
    const html = render({ desktopName: "Studio Mac", onOpen: vi.fn() });
    expect(html).toContain("Magpie 额度");
    expect(html).toContain("当前电脑 · Studio Mac");
    expect(html).toContain("各账号剩余额度与重置时间");
    expect(html.indexOf("Magpie 额度")).toBeLessThan(html.indexOf("外观"));
  });

  it("is absent otherwise", () => {
    expect(render()).not.toContain("Magpie 额度");
  });
});
