import { describe, expect, it, vi } from "vitest";
import { ClaudeDesktopBridge } from "./claude-desktop-bridge.js";

function fixture(branch: string | null = "feature/owned") {
  let latch: unknown;
  const arm = vi.fn(async (_sessionId: string, nativeBranch: unknown) => { latch = nativeBranch; });
  const call = vi.fn(async () => branch === null ? null : { branch });
  const bridge = Object.create(ClaudeDesktopBridge.prototype) as ClaudeDesktopBridge;
  Object.assign(bridge, {
    inspector: { call, startAutoFixOnNextPr: arm },
    desktopId: (sessionId: string) => sessionId,
    executionCwd: () => "/owned/worktree",
    readPrAutoFix: async () => ({
      sessionId: "owned-session", prs: [], onlyOwnPrs: false,
      nextOwnPrArmed: typeof latch === "string" && latch.length > 0,
      capabilities: { bound: true, onlyOwnPrs: true, nextPr: true, checks: true },
    }),
    record: vi.fn(async () => {}),
  });
  return { bridge, arm, call };
}

const resolver = { deviceId: "owned-phone", name: "Owned phone" };

describe("next PR branch review regression", () => {
  it("arms the actual Native execution branch rather than a boolean", async () => {
    const f = fixture();
    await expect(f.bridge.setPrAutoFix({ sessionId: "owned-session", target: "next-pr", enabled: true }, resolver)).resolves.toMatchObject({ nextOwnPrArmed: true });
    expect(f.call).toHaveBeenCalledExactlyOnceWith("getGitInfo", ["/owned/worktree"]);
    expect(f.arm).toHaveBeenCalledExactlyOnceWith("owned-session", "feature/owned");
  });

  it("does not invent a Native cancel call for a false wire request", async () => {
    const f = fixture();
    await expect(f.bridge.setPrAutoFix({ sessionId: "owned-session", target: "next-pr", enabled: false }, resolver)).rejects.toThrow("取消布防");
    expect(f.arm).not.toHaveBeenCalled();
  });

  it("does not arm when Native has no current branch", async () => {
    const f = fixture(null);
    await expect(f.bridge.setPrAutoFix({ sessionId: "owned-session", target: "next-pr", enabled: true }, resolver)).rejects.toThrow("分支");
    expect(f.arm).not.toHaveBeenCalled();
  });
});
