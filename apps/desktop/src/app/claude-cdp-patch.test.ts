import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { applyClaudeCdpPatch } from "./claude-cdp-patch.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, readFile: vi.fn(fs.readFile) };
});

const configPath = "/Users/me/Library/Application Support/Bridge/claude-cdp-patch-v1.json";
const target = "/Applications/Claude.app";

describe("Claude CDP patch preparation", () => {
  it("runs the configured script against the resolved bundle", async () => {
    vi.mocked(readFile).mockResolvedValue(JSON.stringify({ script: "/Users/me/patch_claude_desktop.py" }));
    const run = vi.fn(async () => ({ stdout: "patched at offset 1", stderr: "" }));

    await expect(applyClaudeCdpPatch({ configPath, target, run })).resolves.toBeUndefined();

    expect(run).toHaveBeenCalledExactlyOnceWith(
      "/usr/bin/python3",
      ["-I", "/Users/me/patch_claude_desktop.py", "--app", target],
      expect.objectContaining({ timeout: 30_000 }),
    );
  });

  it("does nothing without a configuration file", async () => {
    vi.mocked(readFile).mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    const run = vi.fn(async () => ({ stdout: "", stderr: "" }));

    await expect(applyClaudeCdpPatch({ configPath, target, run })).resolves.toBeUndefined();

    expect(run).not.toHaveBeenCalled();
  });

  it("reports the first stderr line instead of throwing when the script fails", async () => {
    vi.mocked(readFile).mockResolvedValue(JSON.stringify({ script: "/Users/me/patch.py" }));
    const run = vi.fn(async () => {
      throw Object.assign(new Error("Command failed"), {
        stderr: "claude-cdp-patch: dRs anchor not found (anchor=0 marker=0); build changed\n",
      });
    });

    await expect(applyClaudeCdpPatch({ configPath, target, run }))
      .resolves.toBe("调试补丁未应用：claude-cdp-patch: dRs anchor not found (anchor=0 marker=0); build changed");
  });

  it("rejects a configuration without an absolute script path", async () => {
    vi.mocked(readFile).mockResolvedValue(JSON.stringify({ script: "patch.py" }));
    const run = vi.fn(async () => ({ stdout: "", stderr: "" }));

    await expect(applyClaudeCdpPatch({ configPath, target, run })).rejects.toThrow("绝对路径");
    expect(run).not.toHaveBeenCalled();
  });
});
