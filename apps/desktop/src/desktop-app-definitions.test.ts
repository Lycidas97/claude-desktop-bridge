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

  it("retains the Claude Windows path override", () => {
    expect(desktopAppPathCandidates(
      CLAUDE_DESKTOP_APP,
      { BRIDGE_CLAUDE_DESKTOP_PATH: "D:\\Tools\\Claude.exe" },
      "C:\\Users\\test",
      "win32",
    )[0]).toBe("D:\\Tools\\Claude.exe");
  });
});
