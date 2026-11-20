import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AppearanceSettings } from "../common/AppearanceSettings.js";
import { RemoteDesktopUpdaterSection } from "../updater/UpdaterSections.js";
import { MobileSettings } from "./MobileSettings.js";
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

function render(options: { quota?: boolean } = {}) {
  return renderToStaticMarkup(createElement(MobileSettings, {
    themeControl: { theme: "light", family: "sunstone", setTheme: vi.fn(), setFamily: vi.fn(), toggleTheme: vi.fn() },
    computer: { desktopName: "Studio Mac", onOpen: vi.fn() },
    providers: { onOpen: vi.fn() },
    ...(options.quota ? { quota: { onOpen: vi.fn() } } : {}),
  }));
}

describe("current computer group in settings", () => {
  it("links to the computer's own pages before local settings", () => {
    const html = render({ quota: true });
    expect(html).toContain("当前电脑 · Studio Mac");
    const order = ["连接与电脑设置", "模型与网关", "Magpie 额度", "外观", "通知", "版本与更新", "诊断与支持"].map(label => html.indexOf(label));
    expect(order.every(index => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("leaves remote version, update channel and debug port to the computer's connection settings", () => {
    const html = render({ quota: true });
    expect(html).not.toContain("调试端口");
    expect(html).not.toContain("电脑端版本");
    expect(html).not.toContain('aria-label="电脑端更新通道"');
    expect(html.match(/>更新通道</g)).toHaveLength(1);
    expect(html).toContain("查看 GitHub Releases");
  });

  it("omits the quota entry for a computer without the plugin", () => {
    expect(render()).not.toContain("Magpie 额度");
  });
});

describe("remote desktop updater section", () => {
  it("shows the computer's version and check controls without remote download or restart", () => {
    const html = renderToStaticMarkup(createElement(RemoteDesktopUpdaterSection, {
      remote: {
        hostVersion: "1.3.2",
        connected: true,
        supported: true,
        updater: {
          platform: "win32",
          arch: "x64",
          currentVersion: "1.3.2",
          channel: "stable",
          autoCheck: true,
          applyMode: "prompt",
          canAutoRestart: true,
          phase: "available",
          latestVersion: "1.3.3",
          assetName: "Bridge-1.3.3-windows-installer-ci.zip",
        },
        onInvoke: vi.fn(),
      },
    }));
    expect(html).toContain("版本与更新");
    expect(html).toContain("电脑端版本");
    expect(html).toContain("v1.3.2");
    expect(html).toContain("发现 v1.3.3");
    expect(html).toContain('aria-label="电脑端更新通道"');
    expect(html).toContain("检查更新");
    expect(html).not.toContain("检查并升级");
    expect(html).not.toContain("检查并下载");
  });
});
