import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { fixture } from "./claude-desktop-bridge-fixture.js";

describe("native application dialogs and PR Auto-fix", () => {
  it("marks native dialog wait from a snapshot and refreshes opened/resolved events without event.session", async () => {
    const f = await fixture();
    try {
      f.native.sessions[0]!.pendingRefusalFallbackPrompt = { promptId: "refusal", originalModel: "primary", fallbackModel: "fallback" };
      const opened = once(f.bridge, "changed");
      f.native.emit("event", { type: "refusal_fallback_prompt", sessionId: "local-native", refusalFallbackPrompt: f.native.sessions[0]!.pendingRefusalFallbackPrompt });
      await opened;
      expect(f.bridge.session("local-native")?.turnState).toBe("waiting");
      expect(f.bridge.promptsList()).toEqual([expect.objectContaining({ promptId: "refusal", kind: "refusal-fallback", message: "primary → fallback", canRespond: true, choices: [{ value: "retry_fallback", label: "使用备用模型重试" }, { value: "edit_prompt", label: "修改提示" }] })]);
      delete f.native.sessions[0]!.pendingRefusalFallbackPrompt;
      const closed = once(f.bridge, "changed");
      f.native.emit("event", { type: "refusal_fallback_prompt_resolved", sessionId: "local-native", refusalFallbackPrompt: { promptId: "refusal" } });
      await closed;
      expect(f.bridge.promptsList()).toEqual([]);
      expect(f.bridge.session("local-native")?.turnState).toBe("idle");
      expect(f.eventLog.replay(0, 100).filter(event => event.type.startsWith("prompt.")).map(event => event.type)).toEqual(["prompt.requested", "prompt.resolved"]);
    } finally { await f.close(); }
  });

  it("keeps a prompt opened by session_updated while an older getAll refresh is still in flight", async () => {
    const f = await fixture();
    try {
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      let markSnapshotCaptured!: () => void;
      const snapshotCaptured = new Promise<void>(resolve => { markSnapshotCaptured = resolve; });
      const call = f.native.call.bind(f.native);
      f.native.call = async (method, args) => {
        const result = await call(method, args);
        if (method === "getAll") { f.native.call = call; markSnapshotCaptured(); await gate; }
        return result;
      };
      const staleRefresh = f.bridge.refreshRuntime();
      await snapshotCaptured;
      f.native.sessions[0]!.pendingCwdTrustPrompt = { promptId: "c", directory: "/new-project", sources: ["settings"] };
      f.native.emit("event", { type: "session_updated", sessionId: "local-native", session: structuredClone(f.native.sessions[0]) });
      await new Promise(resolve => setTimeout(resolve, 50));
      release();
      await staleRefresh;
      await vi.waitFor(() => expect(f.bridge.promptsList().map(prompt => prompt.promptId)).toEqual(["c"]));
      expect(f.eventLog.replay(0, 100).filter(event => event.type.startsWith("prompt.")).map(event => event.type)).toEqual(["prompt.requested"]);
    } finally { await f.close(); }
  });

  it("projects all five prompt kinds using registered choices and native method capabilities", async () => {
    const f = await fixture();
    try {
      Object.assign(f.native.sessions[0]!, {
        pendingRefusalFallbackPrompt: { promptId: "r", originalModel: "primary", fallbackModel: "fallback" },
        pendingAutoModeServerFallbackPrompt: { promptId: "a", title: "Gateway confirmation", paragraphs: ["First paragraph", "Second paragraph"] },
        pendingLanyardConsent: { promptId: "l", targetKind: "channel", title: "Access request", channelId: "owned-channel", channelName: "owned-channel", workspace: "Owned workspace", permalink: "https://example.invalid/channel", bullets: ["Read messages"], postsIntro: "Post as", postsLabelled: "AI", pollIntervalSeconds: 60 },
        pendingViolinBowPrompt: { promptId: "v", title: "Confirm action", body: "Copy files", folder: "/owned", machineName: "Owned machine" },
        pendingCwdTrustPrompt: { promptId: "c", directory: "/new-project", sources: ["settings"] },
      });
      await f.bridge.refreshRuntime();
      expect(f.bridge.promptsList().map(prompt => [prompt.kind, prompt.canRespond])).toEqual([["refusal-fallback", true], ["auto-mode-server-fallback", true], ["lanyard-consent", false], ["violin-bow", false], ["cwd-trust", true]]);
      expect(f.bridge.promptsList().find(prompt => prompt.kind === "auto-mode-server-fallback")?.message).toBe("First paragraph\n\nSecond paragraph");
      f.native.promptChoiceValues = ["native-confirm", "native-decline"];
      f.native.unsupported.add("respondToViolinBowPrompt");
      await f.bridge.refreshRuntime();
      expect(f.bridge.promptsList().find(prompt => prompt.kind === "lanyard-consent")).toMatchObject({ canRespond: true, choices: [{ value: "native-confirm", label: "native-confirm" }, { value: "native-decline", label: "native-decline" }] });
      expect(f.bridge.promptsList().find(prompt => prompt.kind === "violin-bow")?.canRespond).toBe(false);
    } finally { await f.close(); }
  });

  it.each([
    ["pendingRefusalFallbackPrompt", "respondToRefusalFallbackPrompt", "retry_fallback", "retry_fallback"],
    ["pendingAutoModeServerFallbackPrompt", "respondToAutoModeServerFallbackPrompt", "continue", "continue"],
    ["pendingLanyardConsent", "respondToLanyardConsent", "native-confirm", "native-confirm"],
    ["pendingViolinBowPrompt", "respondToViolinBowPrompt", "native-decline", "native-decline"],
    ["pendingCwdTrustPrompt", "answerPendingCwdTrust", "trust", true],
    ["pendingCwdTrustPrompt", "answerPendingCwdTrust", "cancel", false],
  ] as const)("forwards %s choices to %s and records the answering device", async (field, method, choice, nativeChoice) => {
    const f = await fixture();
    try {
      f.native.sessions[0]![field] = field === "pendingLanyardConsent"
        ? { promptId: "pending", targetKind: "channel", title: "Read channel", channelId: "owned", channelName: "owned", workspace: "Owned workspace", permalink: "https://example.invalid/channel", bullets: ["Read messages"], postsIntro: "Post as", postsLabelled: "AI", pollIntervalSeconds: 60 }
        : field === "pendingViolinBowPrompt" ? { promptId: "pending", body: "Copy files", folder: "/owned", machineName: "Owned machine" }
          : { promptId: "pending", directory: "/project", sources: [] };
      f.native.promptChoiceValues = ["native-confirm", "native-decline"];
      await f.bridge.refreshRuntime();
      expect(await f.bridge.resolvePrompt("local-native", "pending", String(choice), { deviceId: "phone-2", name: "My phone" })).toBe(true);
      expect(f.native.calls.find(call => call.method === method)?.args).toEqual(["local-native", "pending", nativeChoice]);
      expect(f.bridge.promptsList()).toEqual([]);
      expect(f.eventLog.replay(0, 100).filter(event => event.type === "prompt.resolved").at(-1)?.data).toMatchObject({ promptId: "pending", choice, resolvedByDeviceId: "phone-2", resolvedByName: "My phone" });
    } finally { await f.close(); }
  });

  it("rejects invented choices and does not forward an expired or locally answered prompt", async () => {
    const f = await fixture();
    const resolver = { deviceId: "phone", name: "Phone" };
    try {
      f.native.sessions[0]!.pendingAutoModeServerFallbackPrompt = { promptId: "pending", title: "Continue?", paragraphs: [] };
      await f.bridge.refreshRuntime();
      await expect(f.bridge.resolvePrompt("local-native", "pending", "approve", resolver)).rejects.toThrow("Invalid native prompt choice");
      expect(f.native.calls.some(call => call.method === "respondToAutoModeServerFallbackPrompt")).toBe(false);
      delete f.native.sessions[0]!.pendingAutoModeServerFallbackPrompt;
      expect(await f.bridge.resolvePrompt("local-native", "pending", "continue", resolver)).toBe(false);
      expect(f.bridge.promptsList()).toEqual([]);
      expect(f.native.calls.some(call => call.method === "respondToAutoModeServerFallbackPrompt")).toBe(false);
    } finally { await f.close(); }
  });

  it("keeps a Native-rejected prompt pending instead of recording a successful answer", async () => {
    const f = await fixture();
    try {
      f.native.sessions[0]!.pendingRefusalFallbackPrompt = { promptId: "pending" };
      f.native.promptResult = false;
      await f.bridge.refreshRuntime();
      expect(await f.bridge.resolvePrompt("local-native", "pending", "edit_prompt", { deviceId: "phone", name: "Phone" })).toBe(false);
      expect(f.bridge.promptsList()).toHaveLength(1);
      expect(f.eventLog.replay(0, 100).filter(event => event.type === "prompt.resolved")).toEqual([]);
    } finally { await f.close(); }
  });

  it("preserves Native PR bindings and fetches check details only on an explicit read", async () => {
    const f = await fixture();
    try {
      f.native.sessions[0]!.prs = [{ repo: "owner/repo", prNumber: 42, host: "github.com", branch: "feature", state: "OPEN", url: "https://github.com/owner/repo/pull/42", autoFix: true }];
      f.native.sessions[0]!.autoArchiveOnPrClose = true;
      await f.bridge.refreshRuntime();
      expect(f.bridge.session("local-native")).toMatchObject({ prs: f.native.sessions[0]!.prs, autoArchiveOnPrClose: true });
      expect(await f.bridge.readPrAutoFix("local-native")).toMatchObject({ onlyOwnPrs: false, nextOwnPrArmed: false });
      expect(f.native.calls.some(call => call.method === "getPrChecks" || call.method === "getPrOverview")).toBe(false);
      const detail = await f.bridge.readPrAutoFix("local-native", { repo: "owner/repo", prNumber: 42, includeChecks: true });
      expect(detail.checks).toEqual([{ name: "ci/local-distributed", state: "fail", url: "https://github.com/owner/repo/actions/runs/1" }]);
      expect(f.native.calls.find(call => call.method === "getPrChecks")?.args).toEqual(["/project", 42, "owner/repo", "github.com"]);
      expect(f.native.calls.find(call => call.method === "getPrOverview")?.args).toEqual(["/project", 42, "owner/repo", "local-native", true]);
    } finally { await f.close(); }
  });

  it("review regression: keeps enterprise checks on the binding host without querying a github.com overview", async () => {
    const f = await fixture();
    try {
      f.native.sessions[0]!.prs = [{ repo: "owner/repo", prNumber: 42, host: "github.enterprise.invalid", url: "https://github.enterprise.invalid/owner/repo/pull/42" }];
      const detail = await f.bridge.readPrAutoFix("local-native", { repo: "owner/repo", prNumber: 42, host: "github.enterprise.invalid", includeChecks: true });
      expect(f.native.calls.filter(call => call.method === "getPrOverview")).toEqual([]);
      expect(f.native.calls.find(call => call.method === "getPrChecks")?.args).toEqual(["/project", 42, "owner/repo", "github.enterprise.invalid"]);
      expect(detail.checks?.[0]).toMatchObject({ name: "ci/local-distributed", state: "fail" });
      expect(detail).toMatchObject({ overviewUnavailable: expect.any(String) });
      expect(detail.overview).toBeUndefined();
    } finally { await f.close(); }
  });

  it("writes bound Auto-fix via the public person-actor wrapper and reads back Native preferences", async () => {
    const f = await fixture();
    const resolver = { deviceId: "phone", name: "Phone" };
    try {
      f.native.sessions[0]!.prs = [{ repo: "owner/repo", prNumber: 42, host: "github.com", url: "https://github.com/owner/repo/pull/42" }];
      const bound = await f.bridge.setPrAutoFix({ sessionId: "local-native", target: "bound", repo: "owner/repo", prNumber: 42, enabled: true }, resolver);
      expect(bound.prs[0]?.autoFix).toBe(true);
      expect(f.native.calls.find(call => call.method === "setBoundPrAutoFix")?.args).toEqual(["local-native", "owner/repo", 42, true, "github.com"]);
      expect((await f.bridge.setPrAutoFix({ sessionId: "local-native", target: "own-prs", enabled: true }, resolver)).onlyOwnPrs).toBe(true);
      f.native.sessions[0]!.harnessCwd = "/owned/worktree";
      await f.bridge.refreshRuntime();
      expect((await f.bridge.setPrAutoFix({ sessionId: "local-native", target: "next-pr", enabled: true }, resolver)).nextOwnPrArmed).toBe(true);
      expect(f.native.calls.filter(call => call.method === "armAutoFixOnNextPr").map(call => call.args)).toEqual([["local-native", "feature/owned"]]);
      expect(f.native.calls.filter(call => call.method === "getGitInfo").map(call => call.args)).toEqual([["/owned/worktree"]]);
      f.native.applyPrSettings = false;
      delete f.native.sessions[0]!.autoFixNextOwnPr;
      await expect(f.bridge.setPrAutoFix({ sessionId: "local-native", target: "next-pr", enabled: true }, resolver)).rejects.toThrow("Desktop 未应用");
      await expect(f.bridge.setPrAutoFix({ sessionId: "local-native", target: "own-prs", enabled: false }, resolver)).rejects.toThrow("Desktop 未应用");
      expect(f.eventLog.replay(0, 100).filter(event => event.type === "pr.autoFix.updated")).toHaveLength(3);
    } finally { await f.close(); }
  });

  it.each([
    { enabled: false, branch: "feature/owned", error: "取消布防" },
    { enabled: true, branch: null, error: "分支" },
  ])("does not arm the next PR when enabled=$enabled and branch=$branch", async ({ enabled, branch, error }) => {
    const f = await fixture();
    try {
      f.native.gitInfo = branch === null ? null : { branch };
      await expect(f.bridge.setPrAutoFix({ sessionId: "local-native", target: "next-pr", enabled }, { deviceId: "phone", name: "Phone" })).rejects.toThrow(error);
      expect(f.native.calls.filter(call => call.method === "armAutoFixOnNextPr")).toEqual([]);
    } finally { await f.close(); }
  });

  it("limits old Native capabilities and refreshes preference latch completion events", async () => {
    const f = await fixture();
    try {
      for (const method of ["setBoundPrAutoFix", "setAutoFixOwnPrsWanted", "armAutoFixOnNextPr", "getPrOverview", "getPrChecks", "respondToRefusalFallbackPrompt", "respondToAutoModeServerFallbackPrompt", "respondToLanyardConsent", "respondToViolinBowPrompt", "answerPendingCwdTrust"]) f.native.unsupported.add(method);
      expect(f.bridge.capabilities()).not.toContain("prompt.resolve");
      expect(f.bridge.capabilities()).not.toContain("pr.autofix");
      expect((await f.bridge.readPrAutoFix("local-native")).capabilities).toEqual({ bound: false, onlyOwnPrs: false, nextPr: false, checks: false });
      delete f.native.sessions[0]!.autoFixNextOwnPr;
      const changed = once(f.bridge, "changed");
      f.native.emit("event", { type: "bridge_pr_auto_fix_settled", sessionId: "local-native", enabled: true, result: "dropped" });
      await changed;
      await vi.waitFor(() => expect(f.eventLog.replay(0, 100).filter(event => event.type === "pr.autoFix.updated").at(-1)?.data).toMatchObject({ target: "next-pr", phase: "settled", result: "dropped" }));
    } finally { await f.close(); }
  });
});
