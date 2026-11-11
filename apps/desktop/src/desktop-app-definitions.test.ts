import { describe, expect, it } from "vitest";
import {
  CLAUDE_DESKTOP_APP,
  DESKTOP_APP_DEFINITIONS,
  desktopAppPathCandidates,
} from "./desktop-app-definitions.js";

describe("desktop app definitions", () => {
  it("discovers and controls only Claude Desktop", () => {
    expect(DESKTOP_APP_DEFINITIONS).toEqual([CLAUDE_DESKTOP_APP]);
    expect(desktopAppPathCandidates(CLAUDE_DESKTOP_APP, {}, "/Users/test", "darwin"))
      .toEqual(["/Applications/Claude.app"]);
  });

  it("retains the Claude Windows path override and includes the MSIX execution alias", () => {
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
    expect(candidates).toContain("C:\\Users\\test\\AppData\\Local\\Microsoft\\WindowsApps\\claude-desktop.exe");
  });
});
