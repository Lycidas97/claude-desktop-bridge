import { describe, expect, it, vi } from "vitest";
import type { App } from "electron";
import { join } from "node:path";
import {
  claudeRuntimePaths,
  connectorPaths,
  firstNonEmpty,
  isLaunchAtLoginEnabled,
  setLaunchAtLogin,
  supportsClaudeDesktop,
} from "./platform.js";

describe("desktop URL configuration", () => {
  it("ignores empty runtime and embedded values before using the safe fallback", () => {
    expect(firstNonEmpty(["", "   ", "ws://127.0.0.1:8788/ws"])).toBe(
      "ws://127.0.0.1:8788/ws",
    );
  });

  it("trims and preserves the first configured value", () => {
    expect(firstNonEmpty(["  wss://relay.example/ws  ", "ws://fallback/ws"])).toBe(
      "wss://relay.example/ws",
    );
  });
});

describe("launch at login", () => {
  it.each([true, false])("registers the macOS app with enabled=%s without deprecated hidden flags", async (enabled) => {
    const setLoginItemSettings = vi.fn();
    await setLaunchAtLogin({ setLoginItemSettings } as unknown as App, enabled, "darwin");
    expect(setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: enabled });
  });

  it("uses the same executable and hidden argument for Windows registration and lookup", async () => {
    const setLoginItemSettings = vi.fn();
    const getLoginItemSettings = vi.fn(() => ({ openAtLogin: true }));
    const app = { setLoginItemSettings, getLoginItemSettings } as unknown as App;
    await setLaunchAtLogin(app, true, "win32");
    expect(setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true, path: process.execPath, args: ["--hidden"] });
    await expect(isLaunchAtLoginEnabled(app, "win32")).resolves.toBe(true);
    expect(getLoginItemSettings).toHaveBeenCalledWith({ path: process.execPath, args: ["--hidden"] });
  });
});

describe("Windows Claude paths", () => {
  it("treats Windows and macOS as Claude Desktop hosts", () => {
    expect(supportsClaudeDesktop("darwin")).toBe(true);
    expect(supportsClaudeDesktop("win32")).toBe(true);
    expect(supportsClaudeDesktop("linux")).toBe(false);
  });

  it("uses roaming AppData for connector configuration", () => {
    const home = "/tmp/bridge-windows-home";
    const appData = "/tmp/bridge-windows-appdata";
    expect(connectorPaths("win32", { APPDATA: appData }, home)).toEqual({
      claudeDesktop: [
        join(appData, "Claude", "claude_desktop_config.json"),
        join(appData, "Claude-3p", "claude_desktop_config.json"),
      ],
      claudeCode: join(home, ".claude.json"),
      claudeSettings: join(home, ".claude", "settings.json"),
    });
  });

  it("keeps Claude Code state in the user profile and Desktop sessions in AppData", () => {
    const home = "/tmp/bridge-windows-home";
    const appData = "/tmp/bridge-windows-appdata";
    expect(claudeRuntimePaths("win32", { APPDATA: appData }, home)).toEqual({
      sessions: join(home, ".claude", "sessions"),
      tasks: join(home, ".claude", "tasks"),
      projects: join(home, ".claude", "projects"),
      desktopSessions: [
        join(appData, "Claude", "claude-code-sessions"),
        join(appData, "Claude-3p", "claude-code-sessions"),
      ],
    });
  });
});
