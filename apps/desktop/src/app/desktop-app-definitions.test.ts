import { describe, expect, it } from "vitest";
import {
  CLAUDE_DESKTOP_APP,
  DESKTOP_APP_DEFINITIONS,
  desktopAppPathCandidates,
} from "./desktop-app-definitions.js";

describe("desktop app definitions", () => {
  it("discovers and controls Claude Desktop and Claude-3p bundles on macOS", () => {
    expect(DESKTOP_APP_DEFINITIONS).toEqual([CLAUDE_DESKTOP_APP]);
    expect(desktopAppPathCandidates(CLAUDE_DESKTOP_APP, {}, "/Users/test", "darwin"))
      .toEqual([
        "/Applications/Claude.app",
        "/Applications/Claude-3p.app",
        "/Users/test/Applications/Claude.app",
        "/Users/test/Applications/Claude-3p.app",
      ]);
  });

  it("retains the Claude Windows path override and includes Claude-3p and MSIX execution aliases", () => {
    const candidates = desktopAppPathCandidates(
      CLAUDE_DESKTOP_APP,
      {
        BRIDGE_CLAUDE_DESKTOP_PATH: "D:\\Tools\\Claude.exe",
        LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
      },
      "C:\\Users\\test",
      "win32",
    );
    expect(candidates[0]).toBe("D:\\Tools\\Claude.exe");
    expect(candidates).toContain("C:\\Users\\test\\AppData\\Local\\Programs\\Claude-3p\\Claude.exe");
    expect(candidates).toContain("C:\\Users\\test\\AppData\\Local\\Programs\\Claude-3p\\Claude-3p.exe");
    expect(candidates).toContain("C:\\Users\\test\\AppData\\Local\\Claude-3p\\Claude-3p.exe");
    expect(candidates).toContain("C:\\Users\\test\\AppData\\Local\\Microsoft\\WindowsApps\\claude-desktop.exe");
  });
});
